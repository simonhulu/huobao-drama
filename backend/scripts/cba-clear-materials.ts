import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {createStorageRegistry} from '../src/services/storage-artifacts.js'
import {archiveVerifiedFile} from '../src/services/storage-archive.js'
import {assertMediaDiskSpace} from '../src/services/storage-space.js'

const active=new Set(['queued','running','stopping','uploading','processing','rendering','downloading'])
const media=/\.(?:mp4|mov|mkv|webm|m4v|m4a|mp3|wav|aac|opus|flac|ogg|png|jpe?g|webp|gif|zip)(?:\.part)?$/i
const inside=(root:string,file:string)=>file.startsWith(root+path.sep)
async function hash(filename:string) {const h=createHash('sha256');for await(const chunk of createReadStream(filename))h.update(chunk);return h.digest('hex')}
async function walk(directory:string):Promise<string[]> {
  const result:string[]=[]
  for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
    const filename=path.join(directory,entry.name)
    if(entry.isSymbolicLink()) continue
    if(entry.isDirectory()) result.push(...await walk(filename))
    else if(entry.isFile()) result.push(filename)
  }
  return result
}
function paths(value:unknown,result=new Set<string>()) {
  if(typeof value==='string'&&path.isAbsolute(value))result.add(path.resolve(value))
  else if(Array.isArray(value))for(const item of value)paths(item,result)
  else if(value&&typeof value==='object')for(const item of Object.values(value))paths(item,result)
  return result
}
async function state(root:string) {
  const current=JSON.parse(await fs.readFile(path.join(root,'.console.json'),'utf8'))
  if(!Array.isArray(current.runs)||!Array.isArray(current.uploads))throw Error('CBA state is incomplete')
  if(current.runs.some((run:any)=>active.has(run.status))||current.uploads.some((upload:any)=>upload.status==='running'))throw Error('CBA production or upload is active')
  return current
}
async function idle(directory:string) {
  for(const name of ['.lock','.production.lock']) {
    let content:string
    try{content=await fs.readFile(path.join(directory,name),'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}
    let value:any
    try{value=JSON.parse(content)}catch{throw Error(`Unrecognized producer lock: ${directory}/${name}`)}
    const pid=typeof value==='number'?value:value.pid
    if(!Number.isSafeInteger(pid)||pid<=0)throw Error(`Unrecognized producer PID: ${directory}`)
    try{process.kill(pid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')continue;throw error}
    throw Error(`CBA producer ${pid} is still alive`)
  }
}
function identity(info:Awaited<ReturnType<typeof fs.lstat>>) {return {dev:info.dev,ino:info.ino,bytes:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs}}
async function save(filename:string,value:unknown) {
  await fs.mkdir(path.dirname(filename),{recursive:true})
  const file=await fs.open(filename,'w',0o600)
  try{await file.writeFile(JSON.stringify(value,null,2));await file.sync()}finally{await file.close()}
}

export async function clearCbaMaterials(projectRoot:string,db:Database.Database,apply=false) {
  projectRoot=await fs.realpath(projectRoot)
  const root=path.join(projectRoot,'data/cba-video'),registry=createStorageRegistry(db)
  if(await fs.realpath(root)!==root)throw Error('Redirected CBA directory')
  const reportPath=path.join(projectRoot,'data/reports/workspace-cleanup-20261101-cba.json')
  const locks:Array<{filename:string;handle:Awaited<ReturnType<typeof fs.open>>}>=[]
  try {
    if(apply)for(const filename of [path.join(projectRoot,'data/storage/maintenance.lock'),path.join(root,'.console.json.lock')]) {
      await fs.mkdir(path.dirname(filename),{recursive:true})
      const handle=await fs.open(filename,'wx',0o600);locks.push({filename,handle})
      await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),operation:'explicit-cba-material-reset'}));await handle.sync()
    }
    const current=await state(root)
    const pending=new Set<string>(current.uploads.filter((upload:any)=>!['saved','completed','canceled','cancelled'].includes(upload.status)).map((upload:any)=>upload.jobId))
    const jobs:Array<{id:string;directory:string;job:any}>=[]
    const needed=new Set<string>(),outputs=new Set<string>(),preserved:Array<{path:string;identity:ReturnType<typeof identity>;sha256?:string}>=[]
    for(const entry of await fs.readdir(root,{withFileTypes:true})) {
      if(!entry.isDirectory()||entry.isSymbolicLink())continue
      const directory=path.join(root,entry.name),jobFile=path.join(directory,'job.json')
      let job:any
      try{job=JSON.parse(await fs.readFile(jobFile,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error}
      await idle(directory);jobs.push({id:entry.name,directory,job})
      paths(job.outputs,outputs)
      if(pending.has(entry.name))paths(job,needed)
    }
    const files:any[]=[],retained:any[]=[]
    for(const {id,directory} of jobs)for(const filename of await walk(directory)) {
      const relative=path.relative(directory,filename),first=relative.split(path.sep)[0],info=await fs.lstat(filename)
      const keep=first==='renders'||first==='uploads'||outputs.has(filename)||/\.(?:json|jsonl|md|txt|srt|vtt|html)$/i.test(filename)&&first!=='downloads'
      if(keep) {preserved.push({path:filename,identity:identity(info),...(/(?:job\.json|production\.json|delivery\.json)$/.test(filename)?{sha256:await hash(filename)}:{})});continue}
      if(first!=='downloads'&&!media.test(filename)&&first!=='manual-template')continue
      if(await fs.realpath(filename)!==filename)throw Error('Redirected material file')
      const record=registry.byPath(filename),owners=record?registry.owners(record.id):[]
      if(record?.role==='final'||owners.some(owner=>owner.ownerType!=='cba'&&owner.ownerType!=='unassigned')) {retained.push({path:filename,reason:'Other workflow or final delivery consumer'});continue}
      files.push({path:filename,jobId:id,identity:identity(info),allocatedBytes:info.nlink===1?info.blocks*512:0,
        archive:pending.has(id)||needed.has(filename)||owners.some(owner=>pending.has(owner.ownerId))||!!record?.pinned,status:'planned'})
    }
    const report:any={startedAt:new Date().toISOString(),apply,root,pendingUploadJobs:[...pending],files,retained,
      preservedFiles:preserved.length,plannedFiles:files.length,plannedLogicalBytes:files.reduce((sum,file)=>sum+file.identity.bytes,0),
      backupLogicalBytes:files.filter(file=>file.archive).reduce((sum,file)=>sum+file.identity.bytes,0),removedFiles:0,archivedFiles:0,errors:[]}
    await save(reportPath,report)
    if(!apply)return report
    const backupRoot=path.join(projectRoot,'outputs/cba-upload-recovery-20261101')
    await fs.mkdir(backupRoot,{recursive:true});await assertMediaDiskSpace(backupRoot,report.backupLogicalBytes)
    for(const file of files) {
      await state(root)
      const before=await fs.lstat(file.path)
      if(!before.isFile()||await fs.realpath(file.path)!==file.path||JSON.stringify(identity(before))!==JSON.stringify(file.identity))throw Error(`Material changed: ${file.path}`)
      if(file.archive) {
        const backup=path.join(backupRoot,path.relative(root,file.path))
        await fs.mkdir(path.dirname(backup),{recursive:true});await fs.copyFile(file.path,backup,fs.constants.COPYFILE_EXCL)
        const handle=await fs.open(backup,'r+');try{await handle.sync()}finally{await handle.close()}
        const sha256=await hash(backup)
        registry.track([{path:file.path,role:registry.byPath(file.path)?.role||'source',bytes:before.size,sha256,
          owners:[...registry.owners(registry.byPath(file.path)?.id||0),{ownerType:'cba',ownerId:file.jobId,state:'needs_review',purpose:'source'}]}])
        const result=await archiveVerifiedFile(db,registry.byPath(file.path)!.id,sha256,backup,{dataRoot:path.join(projectRoot,'data'),
          review:{reason:'Explicit CBA restart; preserve unresolved-upload recovery inputs'},assertCanRelease:async()=>{await state(root)}})
        file.backupPath=result.backupPath;file.sha256=sha256;file.status='archived';report.archivedFiles++
      } else {
        await fs.unlink(file.path);registry.release(file.path,{reason:'User requested a fresh CBA download and production start',at:new Date().toISOString()})
        file.status='removed';report.removedFiles++
      }
      if((report.removedFiles+report.archivedFiles)%25===0)await save(reportPath,report)
    }
    for(const file of preserved) {
      if(JSON.stringify(identity(await fs.lstat(file.path)))!==JSON.stringify(file.identity)||file.sha256&&await hash(file.path)!==file.sha256)throw Error(`Preserved output or metadata changed: ${file.path}`)
    }
    report.finishedAt=new Date().toISOString();report.preservedFilesVerified=true;await save(reportPath,report)
    return report
  } finally {
    for(const lock of locks.reverse()){await lock.handle.close();await fs.unlink(lock.filename)}
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const projectRoot=fileURLToPath(new URL('../../',import.meta.url)),db=new Database(path.join(projectRoot,'data/huobao_drama.db'),{fileMustExist:true,timeout:30_000})
  db.pragma('synchronous = FULL')
  try {const report=await clearCbaMaterials(projectRoot,db,process.argv.includes('--apply'));console.log(JSON.stringify({...report,files:report.files.slice(0,3),retained:report.retained.slice(0,3)},null,2))}finally{db.close()}
}
