import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {historyAutomationSourceIds} from './history-video-publication-scope.js'

const workers=[
  {file:'history-factory.ts',name:'startHistoryFactoryWorker',flag:'HISTORY_MOTION_AUTOMATION_ENABLED',call:'recover'},
  {file:'history-video-workflow.ts',name:'startHistoryDualProductionWorker',flag:'HISTORY_MOTION_AUTOMATION_ENABLED',call:'produce'},
  {file:'history-video-publication.ts',name:'startHistoryVideoPublicationWorker',flag:'HISTORY_PUBLICATION_AUTOMATION_ENABLED',call:'publish'},
  {file:'history-social-upload.ts',name:'startHistorySocialUploadWorker',flag:'HISTORY_SOCIAL_UPLOAD_AUTOMATION_ENABLED',call:'upload'},
] as const

function start(worker:typeof workers[number],env:NodeJS.ProcessEnv) {
  const source=readFileSync(new URL(worker.file,import.meta.url),'utf8')
  const parsed=ts.createSourceFile(worker.file,source,ts.ScriptTarget.ES2022,true)
  const declaration=parsed.statements.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node) && node.name?.text===worker.name)
  assert.ok(declaration)
  const calls:Array<{name:string;input?:unknown}>=[]
  const ticks:Array<()=>void>=[]
  const context={exports:{},process:{env},console,
    historyAutomationSourceIds:()=>historyAutomationSourceIds(env),
    timer:undefined,running:undefined,
    setInterval:(tick:()=>void)=>{ticks.push(tick);return {unref(){}}},clearInterval(){},
    getHistoryFactory:()=>({recoverPending:(ids:unknown)=>calls.push({name:'recover',input:ids}),runner:{stop:async()=>{}}}),
    runHistoryDualProductionPass:async(input:unknown)=>{calls.push({name:'produce',input})},
    runHistoryVideoPublicationPass:async(input:unknown)=>{calls.push({name:'publish',input})},
    ensureHistoryVideoPublicationSchema(){},sql:{},errorText:String,
    service:undefined,
    HistorySocialUploadService:class {
      constructor(private options:{scope:unknown}){}
      start(){calls.push({name:'upload',input:this.options.scope})}
      async stop(){}
    },
  }
  const service=worker.call==='upload' ? parsed.statements.find((node):node is ts.FunctionDeclaration=>
    ts.isFunctionDeclaration(node) && node.name?.text==='getHistorySocialUploadService')?.getText(parsed) : ''
  const program=ts.transpileModule((service || '')+'\n'+declaration.getText(parsed)+`\nexports.worker=${worker.name}()`,{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText
  runInNewContext(program,context)
  return {calls,ticks,context,worker:(context.exports as {worker:{stop():Promise<void>}}).worker}
}

for(const worker of workers) {
  test(`${worker.name} remains disabled without its own explicit opt-in`,async()=>{
    for(const value of [undefined,'0']) {
      const result=start(worker,{TASK_WORKER_DISABLED:'1',[worker.flag]:value})
      assert.equal(result.calls.length,0);assert.equal(result.ticks.length,0)
      await result.worker.stop()
    }
  })

  test(`${worker.name} independently starts its existing recovery loop and preserves source scope`,async()=>{
    const result=start(worker,{TASK_WORKER_DISABLED:'1',HISTORY_HUASHENG_WORKER_DISABLED:'1',
      [worker.flag]:'1',HISTORY_AUTOMATION_SOURCE_IDS:'[433,132,433]'})
    assert.equal(result.ticks.length,worker.call==='upload'?0:1)
    const input=worker.call==='recover' ? [132,433]
      : worker.call==='produce' ? {sourceIds:[132,433],motionOnly:true}
        : worker.call==='upload' ? {sourceIds:[132,433]} : {scope:{sourceIds:[132,433]}}
    assert.deepEqual(JSON.parse(JSON.stringify(result.calls)),[{name:worker.call,input}])
    await result.worker.stop()
  })

  test(`${worker.name} rejects an invalid opt-in scope before starting a timer`,()=>{
    assert.throws(()=>start(worker,{TASK_WORKER_DISABLED:'1',[worker.flag]:'1',HISTORY_AUTOMATION_SOURCE_IDS:'[0]'}))
  })
}

test('a slow scoped production pass cannot accumulate a new queued pass on every timer tick',async()=>{
  const worker=workers[1],result=start(worker,{TASK_WORKER_DISABLED:'1',HISTORY_HUASHENG_WORKER_DISABLED:'1',
    HISTORY_MOTION_AUTOMATION_ENABLED:'1',HISTORY_AUTOMATION_SOURCE_IDS:'[373]'})
  result.context.running=Promise.resolve() as any
  for(let i=0;i<20;i++)result.ticks[0]!()
  assert.equal(result.calls.length,1)
  result.context.running=undefined
  result.ticks[0]!()
  assert.equal(result.calls.length,2)
  await result.worker.stop()
})
