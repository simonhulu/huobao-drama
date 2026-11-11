import {fork, type ChildProcess} from 'node:child_process'
import type {HistorySocialCandidates} from './history-social-candidates.js'

interface Options {
  databasePath:string; root:string; workerPath?:URL
  startupTimeoutMs?:number; queryTimeoutMs?:number; maxPending?:number
}
interface Pending {resolve:(rows:HistorySocialCandidates)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout>}
const failure=(code:string)=>Object.assign(Error(`History candidate reader: ${code}`),{code})

export class HistorySocialCandidateReader {
  private child?:ChildProcess
  private ready?:Promise<ChildProcess>
  private startupTimer?:ReturnType<typeof setTimeout>
  private rejectReady?:(error:Error)=>void
  private readonly pending=new Map<number,Pending>()
  private readonly inFlight=new Map<string,Promise<HistorySocialCandidates>>()
  private nextId=0
  private closed=false
  private exitHandler?:()=>void
  constructor(private readonly options:Options) {}

  read(sourceIds?:number[]):Promise<HistorySocialCandidates> {
    if(this.closed)return Promise.reject(failure('CLOSED'))
    if(sourceIds!==undefined && (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length>100
      || sourceIds.some(id=>!Number.isSafeInteger(id) || id<1))) return Promise.reject(failure('INVALID_IDS'))
    const ids=sourceIds===undefined?undefined:[...new Set(sourceIds)].sort((a,b)=>a-b)
    const key=ids?.join(',') ?? '*', existing=this.inFlight.get(key)
    if(existing)return existing
    if(this.inFlight.size >= (this.options.maxPending ?? 32))return Promise.reject(failure('BUSY'))
    const operation=this.request(ids)
    this.inFlight.set(key,operation)
    // Only overlapping requests share a read; completion never becomes a response cache.
    void operation.finally(()=>{if(this.inFlight.get(key)===operation)this.inFlight.delete(key)}).catch(()=>{})
    return operation
  }
  private async request(sourceIds?:number[]) {
    const child=await this.start()
    if(this.closed || this.child!==child)throw failure('UNAVAILABLE')
    return new Promise<HistorySocialCandidates>((resolve,reject)=>{
      const id=++this.nextId
      const timer=setTimeout(()=>this.fail(child,failure('QUERY_TIMEOUT')),this.options.queryTimeoutMs ?? 30000)
      this.pending.set(id,{resolve,reject,timer})
      try {child.send({type:'read',id,sourceIds},error=>{if(error)this.fail(child,failure('SEND_FAILED'))})}
      catch {this.fail(child,failure('SEND_FAILED'))}
    })
  }
  private start():Promise<ChildProcess> {
    if(this.ready)return this.ready
    if(this.closed)return Promise.reject(failure('CLOSED'))
    const child=fork(this.options.workerPath ?? new URL('./history-social-candidates-worker.mjs',import.meta.url),[],
      {execArgv:[],stdio:['ignore','ignore','ignore','ipc']})
    this.child=child
    this.ready=new Promise<ChildProcess>((resolve,reject)=>{
      this.rejectReady=reject
      this.startupTimer=setTimeout(()=>this.fail(child,failure('STARTUP_TIMEOUT')),this.options.startupTimeoutMs ?? 60000)
      child.on('message',(message:any)=>{
        if(this.child!==child)return
        if(message?.type==='ready') {
          clearTimeout(this.startupTimer); this.rejectReady=undefined; resolve(child)
        } else if(message?.type==='startup-error')this.fail(child,failure('STARTUP_FAILED'))
        else if(message?.type==='result') {
          const pending=this.pending.get(message.id)
          if(!pending)return
          clearTimeout(pending.timer);this.pending.delete(message.id)
          if(message.ok===true && Array.isArray(message.items))pending.resolve(message.items)
          else pending.reject(failure('QUERY_FAILED'))
        }
      })
      child.on('error',()=>this.fail(child,failure('PROCESS_ERROR')))
      child.once('exit',()=>this.fail(child,failure('PROCESS_EXITED')))
    })
    this.exitHandler=()=>child.kill('SIGKILL')
    process.once('exit',this.exitHandler)
    // An idle read process must not keep the HTTP process alive during shutdown.
    child.unref();child.channel?.unref()
    try {child.send({type:'initialize',databasePath:this.options.databasePath,root:this.options.root},error=>{
      if(error)this.fail(child,failure('SEND_FAILED'))
    })} catch {this.fail(child,failure('SEND_FAILED'))}
    return this.ready ?? Promise.reject(failure('STARTUP_FAILED'))
  }
  private fail(child:ChildProcess,error:Error) {
    if(this.child!==child)return
    this.child=undefined;this.ready=undefined
    clearTimeout(this.startupTimer);this.rejectReady?.(error);this.rejectReady=undefined
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error)}
    this.pending.clear()
    if(this.exitHandler)process.removeListener('exit',this.exitHandler)
    this.exitHandler=undefined
    child.kill('SIGKILL')
  }
  async close() {
    this.closed=true
    const child=this.child
    if(!child)return
    child.ref();child.channel?.ref()
    const stopped=new Promise<void>(resolve=>{
      const timer=setTimeout(resolve,1000)
      child.once('close',()=>{clearTimeout(timer);resolve()})
    })
    this.fail(child,failure('CLOSED'))
    await stopped
    child.unref();child.channel?.unref()
  }
}
