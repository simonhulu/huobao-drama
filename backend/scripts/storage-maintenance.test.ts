import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createStorageMaintenanceScheduler } from '../src/services/storage-management.js'

function clock(start=10_000) {
  let now=start
  const timers:Array<{at:number;callback:()=>void;canceled:boolean}>=[]
  return {now:()=>now,advance:(ms:number)=>{now+=ms},schedule:(callback:()=>void,delay:number)=>{
    const timer={at:now+delay,callback,canceled:false};timers.push(timer);return()=>{timer.canceled=true}
  },timers}
}

test('independent maintenance catches up once on startup and reports the next due time',async()=>{
  const time=clock(10_000),runs:string[]=[]
  const worker=createStorageMaintenanceScheduler({run:async mode=>{runs.push(mode)},autoCleanup:()=>true,
    lastCleanupAt:new Date(1000).toISOString(),intervalMs:1000,checkEveryMs:100,now:time.now,schedule:time.schedule})
  await worker.tick()
  assert.deepEqual(runs,['cleanup'])
  assert.equal(worker.status().missedIntervals,8)
  assert.equal(worker.status().nextCleanupAt,new Date(11_000).toISOString())
  await worker.tick();assert.deepEqual(runs,['cleanup'])
  time.advance(6000);await worker.tick()
  assert.deepEqual(runs,['cleanup','cleanup'])
  await worker.stop()
})

test('startup scans when cleanup is disabled or the last successful cleanup is still recent',async()=>{
  for(const enabled of [false,true]) {
    const time=clock(),runs:string[]=[]
    const worker=createStorageMaintenanceScheduler({run:async mode=>{runs.push(mode)},autoCleanup:()=>enabled,
      lastCleanupAt:new Date(9500).toISOString(),intervalMs:1000,now:time.now,schedule:time.schedule})
    await worker.tick();assert.deepEqual(runs,['scan'])
    time.advance(500);await worker.tick()
    assert.deepEqual(runs,enabled ? ['scan','cleanup'] : ['scan'])
    await worker.stop()
  }
})

test('failed maintenance retries after a short delay and stop drains an in-flight run',async()=>{
  const time=clock(),runs:string[]=[]
  let release:()=>void=()=>{},attempt=0
  const worker=createStorageMaintenanceScheduler({run:async mode=>{
    runs.push(mode)
    if(++attempt===1)throw Error('maintenance lock busy')
    await new Promise<void>(resolve=>{release=resolve})
  },autoCleanup:()=>true,intervalMs:1000,retryMs:100,now:time.now,schedule:time.schedule})
  await worker.tick()
  assert.equal(worker.status().state,'retrying');assert.match(worker.status().lastError!,/lock busy/)
  await worker.tick();assert.equal(runs.length,1)
  time.advance(100)
  const running=worker.tick()
  await Promise.resolve()
  const overlapping=worker.tick()
  assert.equal(runs.length,2)
  let stopped=false
  const stopping=worker.stop().then(()=>{stopped=true})
  await Promise.resolve();assert.equal(stopped,false)
  release();await Promise.all([running,overlapping,stopping])
  assert.equal(worker.status().state,'stopped')
  time.advance(5000);await worker.tick();assert.equal(runs.length,2)
})

test('the isolated maintenance service starts with a scan and exposes worker health without deleting media',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'storage-service-'))
  await mkdir(path.join(root,'data/static'),{recursive:true})
  const movie=path.join(root,'data/static/retained.mp4')
  await writeFile(movie,'retained test media')
  const dbPath=path.join(root,'data/test.db'),database=new Database(dbPath)
  database.exec(`CREATE TABLE storage_policy(id INTEGER PRIMARY KEY,value_json TEXT);
    INSERT INTO storage_policy VALUES(1,'{"autoCleanup":false,"retentionDays":0}');
    CREATE TABLE huasheng_material_recommendations(project_id TEXT,file_path TEXT,large_report TEXT);
    CREATE TABLE huasheng_material_files(project_id TEXT,file_path TEXT,large_report TEXT)`)
  database.close()
  const reservation=createServer().listen(0,'127.0.0.1')
  await once(reservation,'listening')
  const port=(reservation.address() as {port:number}).port
  await new Promise<void>((resolve,reject)=>reservation.close(error=>error ? reject(error) : resolve()))
  const child=spawn(process.execPath,['--import','tsx','scripts/storage-maintenance.ts','serve'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,DB_PATH:dbPath,STORAGE_PROJECT_ROOT:root,STORAGE_PORT:String(port)},stdio:['ignore','pipe','pipe'],
  })
  let output='';child.stdout.on('data',chunk=>{output+=String(chunk)});child.stderr.on('data',chunk=>{output+=String(chunk)})
  t.after(async()=>{
    if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited}
    await rm(root,{recursive:true,force:true})
  })
  let status:any
  for(let attempt=0;attempt<100;attempt++){
    if(child.exitCode!==null || child.signalCode!==null)assert.fail(output)
    try{status=await (await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)})).json()}catch{}
    if(status?.scheduler?.lastSuccessAt)break
    await new Promise(resolve=>setTimeout(resolve,25))
  }
  assert.equal(status?.status,'ok',output)
  assert.equal(status?.scheduler?.state,'waiting',output)
  assert.equal(status?.activity?.operation,'scan')
  assert.equal(status?.activity?.phase,'completed')
  assert.ok(Array.isArray(status?.slowStages))
  const worker:any=await (await fetch(`http://127.0.0.1:${port}/api/v1/storage/worker`)).json()
  assert.equal(worker.pid,child.pid);assert.equal(worker.scheduler.runCount,1)
  assert.equal(await readFile(movie,'utf8'),'retained test media')
  const inspection=new Database(dbPath,{readonly:true,fileMustExist:true})
  try {
    for(const table of ['huasheng_material_recommendations','huasheng_material_files']) {
      const plan=inspection.prepare(`EXPLAIN QUERY PLAN SELECT project_id,file_path,_rowid_ FROM ${table} WHERE instr(file_path,?)>0 OR instr(file_path,'%')>0`).all('retained.mp4') as Array<{detail:string}>
      assert.match(plan.map(row=>row.detail).join('\n'),/USING COVERING INDEX/,'reference scans must avoid wide table rows')
    }
  }finally{inspection.close()}
  const exited=once(child,'exit');child.kill('SIGTERM');await exited
  assert.equal(child.exitCode,0,output)
})
