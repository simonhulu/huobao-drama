import test, {after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import Database from 'better-sqlite3'
import {createHistoryMotionProduction, materialSearchSchema, motionMapPlanSchema, motionPlanSchema, motionSelectionSchema, hashText, textContent,
  runMotionMaterialSearchWorker, resolveMotionSearchTimeoutMs,
  type MotionShot, type MotionSelection} from './history-motion-production.js'
import {alignMotionShots, canReuseMotionAudio, createMotionRunner, hasExactMotionShotTiming, measureMotionShotEnds, splitMotionNarration, retimeMotionMap} from './history-motion-pipeline.js'
import {getMotionMapPack} from './history-motion-maps.js'
import {HuashengMaterialLibrary} from './huasheng-material-library.mjs'

const testDbRoot=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-pipeline-db-'))
process.env.DB_PATH=path.join(testDbRoot,'db.sqlite')
process.env.STORAGE_PATH=path.join(testDbRoot,'static')
process.env.TASK_WORKER_DISABLED='1'
after(async()=>{const {db}=await import('../db/index.js');db.$client.close();fs.rmSync(testDbRoot,{recursive:true,force:true})})

test('a Qin or Zhao mention alone does not authorize the Changping map',()=>{
  for(const script of ['秦始皇统一六国。','赵匡胤发动陈桥兵变。','上党地区的近代工业发展。'])
    assert.throws(()=>getMotionMapPack('changping-context',script),/不匹配/)
})

function fixture(t: TestContext, options: {searchWorkerPath?:URL}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-service-'))
  const materialRoot=path.join(root,'materials')
  fs.mkdirSync(materialRoot)
  const calls: any[]=[]
  let rows: any[]=[]
  const library={search(input: any){calls.push(input);return rows}}
  const service=createHistoryMotionProduction({databasePath:path.join(root,'jobs.db'),materialRoot,root:path.join(root,'outputs'),library,...options})
  function row(id: string, patch: Record<string,unknown>={}) {
    const localPath=path.join(materialRoot,`${id}.mp4`)
    fs.writeFileSync(localPath,`clip-${id}`)
    return {assetId:id,rank:1,status:'done',sourceCaption:'红军在瑞金行进的远景',text:'红军出发',query:'红军 瑞金',
      duration:8,width:1920,height:1080,fps:30,localPath,sha256:hashText(`clip-${id}`),projectId:'p',clipId:'c',
      databaseSecret:'MUST_NOT_REACH_MODEL',...patch}
  }
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})})
  return {root,materialRoot,calls,service,row,library,setRows(value: any[]){rows=value}}
}
const search=materialSearchSchema.parse({query:'红军 瑞金'})
const shot=(patch: Partial<MotionShot>={}): MotionShot=>({shotId:'s1',narration:'红军行进。',duration:2,search,titles:[],...patch})
const selection=(patch: Partial<MotionSelection>={}): MotionSelection=>({assetId:'a',inPoint:0,outPoint:2,crop:'contain',confidence:.95,reason:'人物时代及远景标注匹配',shortfallPolicy:'reject',...patch})

test('scoped recovery filters snapshots in SQL before parsing unrelated jobs',t=>{
  const f=fixture(t)
  const selected=f.service.createPlan(1,{scriptRevision:hashText('selected'),profile:'16:9',shots:[shot()]},'红军行进。','selected')
  const outside=f.service.createPlan(2,{scriptRevision:hashText('outside'),profile:'16:9',shots:[shot()]},'红军行进。','outside')
  selected.status='queued';f.service.write(selected)
  outside.status='queued';f.service.write(outside)
  const database=new Database(path.join(f.root,'jobs.db'))
  try {
    database.prepare('UPDATE history_motion_productions SET snapshot=? WHERE id=?').run('invalid-outside-snapshot',outside.id)
    assert.deepEqual(f.service.listRecoverable([1]).map(job=>job.id),[selected.id])
    assert.deepEqual(f.service.listRecoverable([]),[])
    assert.throws(()=>f.service.listRecoverable(),SyntaxError)
    assert.throws(()=>f.service.listRecoverable([0]))
  } finally {database.close()}
})

function slowSearchWorker(directory:string) {
  const filename=path.join(directory,'slow-search.mjs'),require=createRequire(import.meta.url)
  fs.writeFileSync(filename,`import Database from ${JSON.stringify(pathToFileURL(require.resolve('better-sqlite3')).href)};
    process.once('message',({databasePath})=>{const db=new Database(databasePath,{readonly:true,fileMustExist:true});
    process.send({type:'started'});db.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT SUM(x) FROM n').get();db.close();});`)
  return pathToFileURL(filename)
}

test('material search budget defaults to five seconds and accepts only finite bounded overrides',()=>{
  assert.equal(resolveMotionSearchTimeoutMs({}),5000)
  for(const value of ['0','-1','NaN','Infinity','bad',''])assert.equal(resolveMotionSearchTimeoutMs({HISTORY_MOTION_SEARCH_TIMEOUT_MS:value}),5000)
  assert.equal(resolveMotionSearchTimeoutMs({HISTORY_MOTION_SEARCH_TIMEOUT_MS:'1'}),100)
  assert.equal(resolveMotionSearchTimeoutMs({HISTORY_MOTION_SEARCH_TIMEOUT_MS:'2000'}),2000)
  assert.equal(resolveMotionSearchTimeoutMs({HISTORY_MOTION_SEARCH_TIMEOUT_MS:'999999'}),30000)
})

test('a real read-only SQL worker is killed on deadline while the main-thread heartbeat continues',async t=>{
  const f=fixture(t),workerPath=slowSearchWorker(f.root)
  let heartbeats=0
  const interval=setInterval(()=>heartbeats++,10)
  t.after(()=>clearInterval(interval))
  const started=Date.now()
  await assert.rejects(runMotionMaterialSearchWorker({databasePath:path.join(f.root,'jobs.db'),queries:[]},{timeoutMs:1000,workerPath}),error=>{
    const failure=error as any
    assert.equal(failure.code,'MATERIAL_SEARCH_TIMEOUT');assert.equal(failure.workerStarted,true)
    assert.throws(()=>process.kill(failure.workerPid,0),/ESRCH/,'Deadline waits until the native SQL subprocess is dead')
    return true
  })
  assert.ok(heartbeats>=10,`Expected a responsive event loop, observed ${heartbeats} heartbeats`)
  assert.ok(Date.now()-started<4000,'Native SQL must not outlive the hard deadline')
})

test('worker read errors are isolated and never create a missing database',async t=>{
  const f=fixture(t),missing=path.join(f.root,'missing','library.db')
  await assert.rejects(runMotionMaterialSearchWorker({databasePath:missing,queries:[]},{timeoutMs:3000}),/open|exist|directory|database/i)
  assert.equal(fs.existsSync(path.dirname(missing)),false)
  assert.equal(f.service.create(1,'原稿','title',hashText('still responsive'),'16:9').status,'queued')
})

test('a crashed worker and explicit cancellation cannot leave a read process running',async t=>{
  const f=fixture(t),crash=path.join(f.root,'crashed-worker.mjs')
  fs.writeFileSync(crash,'process.exit(17)')
  await assert.rejects(runMotionMaterialSearchWorker({databasePath:path.join(f.root,'jobs.db'),queries:[]},{timeoutMs:1000,workerPath:pathToFileURL(crash)}),/exited \(17\)/)
  const controller=new AbortController()
  const pending=runMotionMaterialSearchWorker({databasePath:path.join(f.root,'jobs.db'),queries:[]},{timeoutMs:5000,workerPath:slowSearchWorker(f.root),signal:controller.signal})
  controller.abort()
  await assert.rejects(pending,error=>{
    const failure=error as any
    assert.equal(failure.code,'MATERIAL_SEARCH_CANCELLED')
    assert.throws(()=>process.kill(failure.workerPid,0),/ESRCH/)
    return true
  })
})

test('closing the production service cancels and reaps its in-flight material search',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'motion-search-close-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const f=fixture(t,{searchWorkerPath:slowSearchWorker(directory)})
  const pending=f.service.searchAsync(search)
  f.service.close()
  await assert.rejects(pending,error=>{
    const failure=error as any
    assert.equal(failure.code,'MATERIAL_SEARCH_CANCELLED')
    assert.throws(()=>process.kill(failure.workerPid,0),/ESRCH/)
    return true
  })
})

test('job summaries reflect other instances, local writes, missing jobs and rolled-back transactions',t=>{
  const f=fixture(t),database=new Database(path.join(f.root,'jobs.db'))
  const other=createHistoryMotionProduction({database,root:path.join(f.root,'outputs'),materialRoot:f.materialRoot,library:{search:()=>[]},now:()=> '2026-11-11T00:00:00.000Z'})
  t.after(()=>{other.close();database.close()})
  assert.equal(f.service.findSummary('new-job'),null)
  const job=other.create(1,'红军行进。','标题',hashText('summary'),'16:9')
  job.id='new-job';job.status='rendering';job.stage='render';job.message='正在渲染'
  job.requested.shots=[shot()];job.plan={visuals:{s1:{}},deliveryAssociation:{videoUrl:'/static/first.mp4'}}
  other.write(job)
  const expected={id:'new-job',status:'rendering',stage:'render',message:'正在渲染',updatedAt:'2026-11-11T00:00:00.000Z',videoUrl:'/static/first.mp4',shotCount:1,readyShotCount:1}
  assert.deepEqual(f.service.findSummary(job.id),expected)
  const returned=f.service.findSummary(job.id)!
  returned.status='completed';returned.videoUrl='/static/polluted.mp4'
  assert.deepEqual(f.service.findSummary(job.id),expected,'Callers cannot mutate subsequent summaries')
  job.status='failed';job.message='等待重试';job.plan=null;other.write(job)
  assert.equal(f.service.findSummary(job.id)?.status,'failed','Another connection can update within the same timestamp')
  assert.equal(f.service.findSummary(job.id)?.readyShotCount,0)
  assert.equal(other.findSummary(job.id)?.status,'failed')
  job.status='queued';other.write(job)
  assert.equal(other.findSummary(job.id)?.status,'queued','Writes on the same connection invalidate summaries')
  assert.throws(()=>database.transaction(()=>{
    job.status='completed';other.write(job)
    assert.equal(other.findSummary(job.id)?.status,'completed','A transaction sees its own write')
    throw Error('rollback summary')
  })(),/rollback summary/)
  assert.equal(other.findSummary(job.id)?.status,'queued','Rolled-back state must not escape the transaction')
  assert.equal(f.service.findSummary(job.id)?.status,'queued')
  database.prepare('DELETE FROM history_motion_productions WHERE id=?').run(job.id)
  assert.equal(other.findSummary(job.id),null)
  assert.equal(f.service.findSummary(job.id),null,'Deleted rows invalidate cached summaries in other connections')
  job.status='completed';other.write(job)
  assert.equal(f.service.findSummary(job.id)?.status,'completed','A cached missing row becomes visible after insertion')
  assert.equal(other.findSummary(job.id)?.status,'completed')
})

test('persistent summary polling skips snapshots and marks cross-connection raw writes pending repair',t=>{
  const f=fixture(t),statements:string[]=[],database=new Database(path.join(f.root,'jobs.db'),{verbose:sql=>statements.push(String(sql))})
  const service=createHistoryMotionProduction({database,root:path.join(f.root,'outputs'),materialRoot:f.materialRoot,library:{search:()=>[]}})
  const previous=process.env.HISTORY_STATUS_READS
  process.env.HISTORY_STATUS_READS='1'
  t.after(()=>{if(previous===undefined)delete process.env.HISTORY_STATUS_READS;else process.env.HISTORY_STATUS_READS=previous;service.close();database.close()})
  const job=service.create(1,'Current script','Title',hashText('current'),'16:9')
  job.plan={unused:'x'.repeat(1024*1024)};service.write(job)
  statements.length=0
  assert.equal(service.findSummary(job.id)?.statusFresh,true)
  assert.ok(statements.length>0)
  assert.ok(statements.every(sql=>!sql.includes('snapshot')&&!sql.includes('json_extract')))
  const raw=new Database(path.join(f.root,'jobs.db'));t.after(()=>raw.close())
  raw.prepare('UPDATE history_motion_productions SET snapshot=? WHERE id=?').run(JSON.stringify({...job,message:'External change'}),job.id)
  assert.equal(service.findSummary(job.id)?.statusFresh,false)
  assert.equal(service.findSummary(job.id)?.stage,'status_sync')
  assert.equal(service.findSummary(job.id)?.videoUrl,null)
  raw.prepare('DELETE FROM history_motion_status WHERE job_id=?').run(job.id)
  assert.equal(service.findSummary(job.id)?.id,job.id,'A missing summary does not turn the original job into a missing job')
  assert.equal(service.findSummary(job.id)?.statusFresh,false)
})

test('search performs bounded keyword queries and returns only downloaded top-three local candidates',t=>{
  const f=fixture(t)
  const a=f.row('a'), b=f.row('b',{rank:3}), fourth=f.row('fourth',{rank:4}),pending=f.row('pending',{status:'pending'})
  const missing=f.row('missing');fs.unlinkSync(missing.localPath as string)
  const outside=path.join(f.root,'outside.mp4');fs.writeFileSync(outside,'outside')
  const escaped=f.row('escaped');fs.unlinkSync(escaped.localPath as string);fs.symlinkSync(outside,escaped.localPath as string)
  f.setRows([a,b,fourth,pending,missing,escaped,{...a,assetId:'outside',localPath:outside}])
  const results=f.service.search(materialSearchSchema.parse({query:'红军 瑞金 行进 中国 年代 远景 extra',limit:2}))
  assert.deepEqual(results.map(r=>r.assetId),['a','b'])
  assert.equal(f.calls.length,5)
  assert.ok(f.calls.every(call=>call.downloadedOnly===true&&call.topOnly===true&&call.limit<=80))
  assert.ok(results.every(r=>!('databaseSecret' in r)&&!('db' in r)))
  assert.equal(new Set(results.map(r=>r.assetId)).size,results.length)
})

test('search uses measured local duration/dimensions and semantic shot size rather than aspect ratio',t=>{
  const f=fixture(t)
  f.setRows([
    f.row('wide',{width:1080,height:1920,duration:100,media:{duration:5,width:1080,height:1920}}),
    f.row('close',{sourceCaption:'红军战士面部特写',width:1920,height:1080}),
    f.row('unknown',{sourceCaption:'红军战士',query:'红军',width:3840,height:1080}),
  ])
  const results=f.service.search(materialSearchSchema.parse({query:'红军',shotSize:'wide',durationMax:6}))
  assert.deepEqual(results.map(r=>r.assetId),['wide'])
  assert.equal(results[0].duration,5)
  assert.deepEqual([results[0].width,results[0].height],[1080,1920])
  assert.equal(f.service.search(materialSearchSchema.parse({query:'红军',shotSize:'close'}))[0].assetId,'close')
})

test('search rejects empty queries, SQL-shaped extra fields and unbounded limits',t=>{
  const f=fixture(t)
  for(const input of [{query:''},{query:'红军',limit:10000},{query:'红军',sql:'select * from all_tables'},{query:'红军',downloadedOnly:false}])
    assert.throws(()=>f.service.search(input as any))
  assert.equal(f.calls.length,0)
})

test('missing visual descriptions stay empty while query annotations remain searchable',t=>{
  const f=fixture(t)
  f.setRows([f.row('a',{sourceCaption:'',text:'秦国统一六国。',query:'战国军队在平原列阵的远景'})])
  const [candidate]=f.service.search(materialSearchSchema.parse({query:'战国',shotSize:'wide'}))
  assert.equal(candidate.description,'')
  assert.equal(candidate.shotText,'秦国统一六国。')
  assert.equal(candidate.query,'战国军队在平原列阵的远景')
  assert.equal(candidate.shotSize,'wide')
})

test('search excludes already used IDs and file fingerprints before choosing its bounded candidates',t=>{
  const f=fixture(t),first=f.row('used'),sameFile=f.row('same-file'),fresh=f.row('fresh')
  f.setRows([first,sameFile,fresh])
  const usedAssets=new Set([`video-id:${first.assetId}`,`media:${sameFile.sha256}`])
  const result=f.service.search(materialSearchSchema.parse({query:'红军',limit:1}),{usedAssets})
  assert.deepEqual(result.map(item=>item.assetId),['fresh'])
  assert.equal(f.calls[0].distinctAssets,true)
  assert.deepEqual(f.calls[0].excludeAssetIds,['used'])
  assert.deepEqual(f.calls[0].excludeSha256,[sameFile.sha256])
})

test('missing shot-size annotations may fill a gap without using a known conflicting shot size',t=>{
  const f=fixture(t)
  f.setRows([f.row('known-close',{sourceCaption:'红军战士面部特写',query:'红军'}),
    f.row('unannotated',{sourceCaption:'红军战士在村口集合',query:'红军'})])
  const results=f.service.search(materialSearchSchema.parse({query:'红军',shotSize:'wide'}))
  assert.deepEqual(results.map(item=>item.assetId),['unannotated'])
  assert.equal(results[0].shotSize,'unknown')
  assert.equal(results[0].searchFallback,'shot-size-unknown')
})

test('an exact-size asset remains preferred over unannotated footage and identical files appear once',t=>{
  const f=fixture(t),wide=f.row('wide'),copy=f.row('copy',{sha256:wide.sha256})
  f.setRows([f.row('unannotated',{sourceCaption:'红军战士集合',query:'红军'}),wide,copy])
  const results=f.service.search(materialSearchSchema.parse({query:'红军',shotSize:'wide'}))
  assert.deepEqual(results.map(item=>item.assetId),['wide'])
  assert.equal(results[0].searchFallback,undefined)
})

function duplicateFileFixture(t:TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-duplicate-files-')),materialRoot=path.join(root,'materials')
  fs.mkdirSync(materialRoot)
  const library=new HuashengMaterialLibrary({databasePath:path.join(root,'library.sqlite')})
  const service=createHistoryMotionProduction({databasePath:path.join(root,'jobs.sqlite'),materialRoot,library})
  const pid='260077122691088',assetId='shared-asset'
  library.saveProject({projectId:pid,title:'城墙守军',projectUrl:`https://www.huasheng.cn/video/${pid}`,totalClips:3,top:3})
  const register=(order:number,filename:string,media={duration:8,width:1920,height:1080})=>{
    fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,`copy-${order}`)
    const sha256=hashText(`copy-${order}`)
    library.saveClip(pid,{projectId:pid,clipId:String(100000+order),order,text:'城墙守军',query:'城墙',
      selectedAssetId:assetId,selectedCaption:'城墙守军的远景',total:1,status:'done',metadata:{},
      candidates:[{id:assetId,rank:1,duration:100,width:800,height:600,download:{status:'done',
        localPath:path.relative(materialRoot,filename),bytes:fs.statSync(filename).size,sha256,media}}]},materialRoot)
    return {filename,sha256,media}
  }
  t.after(()=>{service.close();library.close();fs.rmSync(root,{recursive:true,force:true})})
  return {root,materialRoot,library,service,register,assetId}
}

for(const invalid of ['missing','empty'] as const)test(`search recovers another registered copy when the first file is ${invalid}`,t=>{
  const f=duplicateFileFixture(t),first=f.register(1,path.join(f.materialRoot,'a.mp4'))
  const second=f.register(2,path.join(f.materialRoot,'b.mp4'),{duration:4,width:1280,height:720})
  if(invalid==='missing')fs.unlinkSync(first.filename);else fs.truncateSync(first.filename)
  const lookup={query:'城墙',distinctAssets:true,limit:80}
  const rows=f.library.search(lookup)
  assert.equal(rows.length,1);assert.equal(rows[0].localPath,first.filename)
  const results=f.service.search(materialSearchSchema.parse({query:'城墙',shotSize:'wide',durationMax:5}))
  assert.equal(results.length,1)
  assert.equal(results[0].assetId,f.assetId)
  assert.equal(results[0].localPath,fs.realpathSync(second.filename))
  assert.equal(results[0].sha256,second.sha256)
  assert.deepEqual([results[0].duration,results[0].width,results[0].height],[4,1280,720])
})

test('registered fallback copies cannot escape the material root or reuse an already used file or asset',t=>{
  const f=duplicateFileFixture(t),first=f.register(1,path.join(f.materialRoot,'a.mp4'))
  f.register(2,path.join(f.root,'outside.mp4'))
  const used=f.register(3,path.join(f.materialRoot,'used.mp4'))
  fs.unlinkSync(first.filename)
  assert.deepEqual(f.service.search(materialSearchSchema.parse({query:'城墙'}),{
    usedAssets:new Set([`media:${used.sha256}`]),
  }),[])
  assert.deepEqual(f.service.search(materialSearchSchema.parse({query:'城墙'}),{
    usedAssets:new Set([`video-id:${f.assetId}`]),
  }),[])
})

test('real asynchronous material search matches sync ranking, registered copies and exclusions without database writes',async t=>{
  const f=duplicateFileFixture(t),first=f.register(1,path.join(f.materialRoot,'missing.mp4'))
  f.register(2,path.join(f.materialRoot,'readable.mp4'),{duration:4,width:1280,height:720})
  fs.unlinkSync(first.filename)
  const databasePath=path.join(f.root,'library.sqlite')
  const service=createHistoryMotionProduction({databasePath,materialRoot:f.materialRoot,root:path.join(f.root,'async-outputs')})
  t.after(()=>service.close())
  const parsed=materialSearchSchema.parse({query:'城墙 守军',shotSize:'wide',durationMax:5})
  const expected=service.search(parsed)
  assert.equal(expected.length,1)
  const before=[databasePath,databasePath+'-wal'].map(filename=>fs.existsSync(filename)?hashText(fs.readFileSync(filename).toString('base64')):null)
  assert.deepEqual(await service.searchAsync(parsed),expected)
  assert.deepEqual(await service.searchAsync(parsed,{usedAssets:new Set([`video-id:${f.assetId}`])}),[])
  assert.deepEqual([databasePath,databasePath+'-wal'].map(filename=>fs.existsSync(filename)?hashText(fs.readFileSync(filename).toString('base64')):null),before)
})

test('selection requires a returned candidate and valid whole frames without a confidence gate',t=>{
  const f=fixture(t);f.setRows([f.row('a')]);const candidates=f.service.search(search)
  assert.throws(()=>f.service.validateSelection(shot(),candidates,selection({assetId:'invented'})),/候选/)
  assert.throws(()=>f.service.validateSelection(shot(),candidates,selection({outPoint:9})),/时长/)
  assert.throws(()=>f.service.validateSelection(shot(),candidates,selection({outPoint:1.98})),/时长不足/)
  assert.equal(f.service.validateSelection(shot(),candidates,selection({confidence:.5})).selected.confidence,.5)
  const {confidence,...withoutConfidence}=selection()
  assert.equal(f.service.validateSelection(shot(),candidates,withoutConfidence as any).selected.confidence,0)
  assert.equal(f.service.validateSelection(shot(),candidates,selection()).selected.outPoint,2)
  assert.equal(f.service.validateSelection(shot(),candidates,selection({outPoint:1,shortfallPolicy:'freeze'}),true).selected.shortfallPolicy,'freeze')
})

test('invalid explicit plans leave no queued task and valid plans preserve the full narration',t=>{
  const f=fixture(t);f.setRows([f.row('a')])
  const input={scriptRevision:'a'.repeat(64),profile:'16:9' as const,shots:[shot({selection:selection({assetId:'missing'})})]}
  assert.throws(()=>f.service.createPlan(1,input,'红军行进。','title'),/候选/)
  assert.equal(f.service.list().length,0)
  assert.throws(()=>f.service.createPlan(1,{...input,shots:[shot()]},'红军行进。不可遗漏。','title'),/完整覆盖/)
  assert.equal(f.service.list().length,0)
  const job=f.service.createPlan(1,{...input,shots:[shot()]},'红军行进。','title')
  assert.equal(job.status,'needs_review')
  assert.equal(job.candidates.s1[0].assetId,'a')
})

test('queued creation is idempotent per script revision and profile and persists across reopen',t=>{
  const f=fixture(t), first=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  assert.equal(f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9').id,first.id)
  assert.notEqual(f.service.create(1,'红军行进。','title','a'.repeat(64),'9:16').id,first.id)
  assert.notEqual(f.service.create(1,'新稿','title','b'.repeat(64),'16:9').id,first.id)
  const reopened=createHistoryMotionProduction({databasePath:path.join(f.root,'jobs.db'),materialRoot:f.materialRoot,library:f.library})
  try {assert.equal(reopened.find(first.id)?.script,'红军行进。')}finally{reopened.close()}
  for(const profile of ['1:1','16/9',''])assert.throws(()=>motionPlanSchema.parse({scriptRevision:'a'.repeat(64),profile,shots:[shot()]}))
})

test('audio alignment tiles exactly and labels interpolation instead of claiming word-level timestamps',()=>{
  const shots=[shot({narration:'红军。'}),shot({shotId:'s2',narration:'瑞金出发。'})]
  const aligned=alignMotionShots(shots,{duration:3.17,titles:[{text:'红军。',time_begin:0,time_end:1000},{text:'瑞金出发。',time_begin:1100,time_end:3170}]})
  assert.deepEqual(aligned.shots.map(s=>[s.startFrame,s.frames]),[[0,30],[30,65]])
  assert.equal(aligned.durationInFrames,95)
  assert.match(aligned.timingEvidence,/句级/)
  const estimated=alignMotionShots(shots,{duration:3.17,titles:[{text:'不匹配',time_begin:0,time_end:3170}]})
  assert.match(estimated.timingEvidence,/估算/)
  assert.equal(estimated.shots.reduce((sum,s)=>sum+s.frames,0),95)
  const script='红军从瑞金出发，队伍经过村庄。这个更长的句子用于验证原文不会在模型拆分时被重写或丢掉关键事实。'
  assert.equal(textContent(splitMotionNarration(script).join('')),textContent(script))
})

test('a cut never rounds down before a measured narration end',()=>{
  const aligned=alignMotionShots([shot({narration:'红军。'}),shot({shotId:'s2',narration:'出发。'})],{
    duration:3,titles:[{text:'红军。',time_begin:0,time_end:1010},{text:'出发。',time_begin:1100,time_end:3000}],
  })
  assert.equal(aligned.shots[1].startFrame,31)
})

test('fine-grained valid provider timing skips ASR while coarse or invalid timing cannot',()=>{
  const shots=[shot({narration:'红军。'}),shot({shotId:'s2',narration:'出发。'})]
  const exact=[{text:'红军。',time_begin:0,time_end:1000},{text:'出发。',time_begin:1100,time_end:2000}]
  assert.equal(hasExactMotionShotTiming(shots,exact,2),true)
  assert.equal(hasExactMotionShotTiming(shots,[{text:'红军。出发。',time_begin:0,time_end:2000}],2),false)
  assert.equal(hasExactMotionShotTiming(shots,[{...exact[0],time_end:-1},exact[1]],2),false)
  assert.equal(hasExactMotionShotTiming(shots,exact,1),false)
})

test('actual audio boundaries take precedence over character-proportional provider chunks',()=>{
  const aligned=alignMotionShots([shot({narration:'红军。'}),shot({shotId:'s2',narration:'出发。'})],{
    duration:6,titles:[{text:'红军。出发。',time_begin:0,time_end:6000}],
    shotEndTimes:[{shotId:'s1',endMs:4200,method:'asr-segment-end'}],
  } as Parameters<typeof alignMotionShots>[1])
  assert.equal(aligned.shots[1].startFrame,126)
  assert.equal(aligned.durationInFrames,180)
  assert.equal(aligned.shots.map(s=>s.narration).join(''),'红军。出发。')
})

test('explicit replacement cannot reuse an Episode-seeded or differently voiced master',t=>{
  const f=fixture(t),file=path.join(f.root,'original.m4a');fs.writeFileSync(file,'original')
  const cached={script:'正文',audioPath:file,reusedFromEpisode:1063}
  assert.equal(canReuseMotionAudio(cached,'正文'),true)
  assert.equal(canReuseMotionAudio(cached,'正文','new-voice'),false)
  assert.equal(canReuseMotionAudio({...cached,audioSettings:{voiceId:'old-voice'}},'正文','new-voice'),false)
  assert.equal(canReuseMotionAudio({...cached,audioSettings:{voiceId:'new-voice'}},'正文','new-voice'),true)
  assert.equal(canReuseMotionAudio(cached,'另一篇正文'),false)
})

test('retiming scales map actions but preserves positions and framing',()=>{
  const map={camera:{keyframes:[{t:0,focusX:.5,focusY:.5,zoom:1},{t:4,focusX:.4,focusY:.5,zoom:1.1}]},
    stages:[{start:0,end:5,label:'行军'}],routes:[{start:1,end:4,points:[[.1,.2],[.5,.6]]}],
    forces:[{id:'yan',city:'南京',action:'occupy',start:1,end:4}],
    cities:[{name:'南京',x:.5,y:.6,highlightStart:2,highlightDuration:1}]}
  retimeMotionMap(map,5,10)
  assert.equal(map.camera.keyframes[1].t,8)
  assert.equal(map.stages[0].end,10)
  assert.deepEqual(map.routes[0].points,[[.1,.2],[.5,.6]])
  assert.equal(map.cities[0].highlightDuration,2)
  assert.deepEqual([map.forces[0].start,map.forces[0].end],[2,8])
})

function fixtureMap(root:string) {const file=path.join(root,'map.png');fs.writeFileSync(file,'terrain');return file}

function pipeline(f: ReturnType<typeof fixture>, options:Record<string,any>={}) {
  let audioCalls=0,renderCalls=0,modelCalls=0,imageCalls=0,deliverCalls=0
  const modelInputs: any[]=[],plans:any[]=[]
  const runner=createMotionRunner(f.service,{
    model:async(_system,value:any)=>{
      modelCalls++;modelInputs.push(value)
      if(options.modelError)throw Error('模型暂时限流')
      return {shots:value.shots.map((s:any)=>({shotId:s.shotId,search,titles:[],...options.design}))}
    },
    audio:async(_script,directory)=>{audioCalls++;if(options.audio)return options.audio(_script,directory);const audioPath=path.join(directory,'voice.m4a');fs.writeFileSync(audioPath,'audio');return {audioPath,duration:2}},
    ...(options.measureAudio?{measureAudio:options.measureAudio}:{}),
    probeVideo:options.probe || (async()=>({duration:8,width:1920,height:1080})),
    generateImage:async input=>{imageCalls++;if(options.generateImage)return options.generateImage(input);if(options.imageError)throw Error('图片服务超时');const filename=path.join(input.directory,'image.png');fs.writeFileSync(filename,'image');return {path:filename,sha256:hashText('image')}},
    prepareMap:options.prepareMap || (async()=>{throw Error('地图数据不可用')}),
    prepareSound:async()=>{throw Error('未匹配音效')},
    deliver:async()=>{deliverCalls++;if(options.deliveryFails && deliverCalls===1)throw Error('交付暂时失败');return {status:'attached',message:'成片已关联',videoUrl:'/static/movie.mp4'}},
    render:async(plan,directory)=>{renderCalls++;plans.push(plan);assert.equal(plan.durationInFrames,60);assert.equal(plan.shots[0].frames,options.firstShotFrames || 60);if(options.renderFails && renderCalls===1)throw Error('渲染暂时失败');const outputPath=path.join(directory,'movie.mp4');fs.writeFileSync(outputPath,'movie');return {outputPath,report:{sha256:hashText('movie'),qa:{technical:'passed'}}}},
  })
  return {runner,modelInputs,plans,counts:()=>({audioCalls,renderCalls,modelCalls,imageCalls,deliverCalls})}
}

test('pipeline awaits the isolated search budget and records fallback before preparing an image',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'motion-search-budget-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const f=fixture(t,{searchWorkerPath:slowSearchWorker(directory)}),previous=process.env.HISTORY_MOTION_SEARCH_TIMEOUT_MS
  process.env.HISTORY_MOTION_SEARCH_TIMEOUT_MS='1000'
  t.after(()=>{if(previous===undefined)delete process.env.HISTORY_MOTION_SEARCH_TIMEOUT_MS;else process.env.HISTORY_MOTION_SEARCH_TIMEOUT_MS=previous})
  f.service.search=()=>assert.fail('The runner must never call synchronous material search')
  const p=pipeline(f),job=f.service.create(1,'红军行进。','title',hashText('async fallback'),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  const saved=f.service.find(job.id)!
  assert.equal(saved.status,'completed',saved.error||'')
  assert.deepEqual(saved.candidates[Object.keys(saved.candidates)[0]!],[])
  assert.ok(saved.plan?.fallbacks.some((entry:any)=>entry.stage==='search'&&/1000 ms read budget/.test(entry.reason)))
  assert.equal(p.counts().imageCalls,1);assert.equal(p.counts().renderCalls,1)
})

test('the first candidate renders and associates automatically without a selection model or human approval',async t=>{
  const f=fixture(t);f.setRows([f.row('a'),f.row('b')]);const p=pipeline(f)
  const job=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);p.runner.schedule(job.id);await p.runner.idle()
  const completed=f.service.find(job.id)!
  assert.equal(completed.status,'completed');assert.equal(completed.plan?.shots[0].assetId,'a')
  assert.equal(completed.plan?.humanReview,undefined)
  assert.deepEqual(p.counts(),{audioCalls:1,renderCalls:1,modelCalls:1,imageCalls:0,deliverCalls:1})
  assert.ok(!JSON.stringify(p.modelInputs).includes('MUST_NOT_REACH_MODEL'))
  assert.equal(f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9').id,job.id)
})

test('failed audio alignment stays retryable and cannot be marked complete using character estimates',async t=>{
  const f=fixture(t);f.setRows([f.row('a'),f.row('b')]);let attempts=0
  const p=pipeline(f,{firstShotFrames:30,measureAudio:async()=>++attempts===1?undefined:{
    shotEndTimes:[{shotId:'s1',endMs:1000,method:'whisper-offset-end',confidence:1,matchedText:'红军行进'}],
    captions:[{text:'红军行进。',startFrame:0,endFrame:30},{text:'队伍出发。',startFrame:30,endFrame:60}],
  }})
  const job=f.service.createPlan(1,{scriptRevision:'a'.repeat(64),profile:'16:9',shots:[shot(),shot({shotId:'s2',narration:'队伍出发。'})]},'红军行进。队伍出发。','title')
  p.runner.schedule(job.id);await p.runner.idle()
  const failed=f.service.find(job.id)!
  assert.equal(failed.status,'failed')
  assert.match(failed.error || '',/声画对齐尚未完成/)
  assert.notEqual(failed.plan?.audioTimingVersion,2)
  assert.equal(p.counts().renderCalls,0)
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(f.service.find(job.id)!.status,'completed')
  assert.equal(attempts,2)
  assert.equal(p.counts().renderCalls,1)
})

test('a pending image automatically resumes the failed shot without repeating completed assets or narration',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const f=fixture(t),calls:string[]=[]
  const p=pipeline(f,{firstShotFrames:30,generateImage:async(input:any)=>{
    calls.push(input.shotId)
    if(calls.length===2)throw Object.assign(Error('图片仍在上游生成'),{code:'image_generation_pending',generationId:123,taskId:'remote-123'})
    const filename=path.join(input.directory,`${input.shotId}.png`)
    fs.writeFileSync(filename,input.shotId)
    return {path:filename,sha256:hashText(input.shotId)}
  }})
  const shots=[shot({visualType:'image'}),shot({shotId:'s2',narration:'队伍出发。',visualType:'image'})]
  const job=f.service.createPlan(1,{scriptRevision:'a'.repeat(64),profile:'16:9',shots},shots.map(s=>s.narration).join(''),'title')
  p.runner.schedule(job.id);await p.runner.idle()
  const waiting=f.service.find(job.id)!
  assert.equal(waiting.status,'queued')
  assert.equal(waiting.error,null)
  assert.ok(waiting.plan?.visuals.s1.imagePath)
  assert.equal(p.counts().renderCalls,0)
  t.mock.timers.tick(5000)
  await p.runner.idle()
  assert.equal(f.service.find(job.id)?.status,'completed')
  assert.deepEqual(calls,['s1','s2','s2'])
  assert.equal(p.counts().audioCalls,1)
  assert.equal(p.counts().renderCalls,1)
})

test('a temporary upstream failure retries from its checkpoint and does not stop the next job',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const f=fixture(t),calls:string[]=[]
  let failedOnce=false
  const p=pipeline(f,{generateImage:async(input:any)=>{
    calls.push(input.shotId)
    if(input.shotId==='first' && !failedOnce){failedOnce=true;throw Error('API error 502: Upstream service temporarily unavailable')}
    const filename=path.join(input.directory,'image.png');fs.writeFileSync(filename,input.shotId)
    return {path:filename,sha256:hashText(input.shotId)}
  }})
  const create=(id:number,shotId:string)=>f.service.createPlan(id,{scriptRevision:hashText(shotId),profile:'16:9',shots:[shot({shotId,visualType:'image'})]},'红军行进。','title')
  const first=create(1,'first'),second=create(2,'second')
  p.runner.schedule(first.id);p.runner.schedule(second.id);await p.runner.idle()
  assert.equal(f.service.find(first.id)?.status,'queued')
  assert.ok(f.service.find(first.id)?.retry?.nextAttemptAt)
  assert.equal(f.service.find(second.id)?.status,'completed')
  t.mock.timers.tick(30000);await p.runner.idle()
  assert.equal(f.service.find(first.id)?.status,'completed')
  assert.deepEqual(calls,['first','second','first'])
  assert.equal(p.counts().audioCalls,2,'retry reuses the already aligned voice')
})

test('a native narration timeout backs off on the same job while another job completes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const f=fixture(t);f.setRows([f.row('a')])
  const create=(id:number)=>f.service.createPlan(id,{scriptRevision:hashText(String(id)),profile:'16:9',shots:[shot()]},'红军行进。','title')
  const first=create(1),second=create(2)
  let timedOut=false
  const p=pipeline(f,{audio:async(_script:string,directory:string)=>{
    if(path.basename(directory)===first.id && !timedOut){timedOut=true;throw new DOMException('The operation was aborted due to timeout','TimeoutError')}
    const audioPath=path.join(directory,'voice.m4a');fs.writeFileSync(audioPath,'audio')
    return {audioPath,duration:2}
  }})
  p.runner.schedule(first.id);p.runner.schedule(second.id);await p.runner.idle()
  const waiting=f.service.find(first.id)!
  assert.equal(waiting.status,'queued')
  assert.equal(waiting.error,null)
  assert.match(waiting.retry!.lastError,/aborted due to timeout/)
  assert.equal(f.service.find(second.id)?.status,'completed')
  t.mock.timers.tick(30000);await p.runner.idle()
  assert.equal(f.service.find(first.id)?.status,'completed')
  assert.equal(f.service.list(1).length,1,'backoff must retain the original job')
  assert.equal(p.counts().modelCalls,0,'the submitted shot plan must be reused')
  assert.equal(p.counts().renderCalls,2)
})

test('one slow job does not prevent the next job from preparing and completing',async t=>{
  const f=fixture(t)
  let release!:()=>void,entered!:()=>void,secondDone!:()=>void
  const firstEntered=new Promise<void>(resolve=>entered=resolve)
  const gate=new Promise<void>(resolve=>release=resolve)
  const completedSecond=new Promise<void>(resolve=>secondDone=resolve)
  const p=pipeline(f,{generateImage:async(input:any)=>{
    if(input.shotId==='slow'){entered();await gate}else secondDone()
    const filename=path.join(input.directory,'image.png');fs.writeFileSync(filename,input.shotId)
    return {path:filename,sha256:hashText(input.shotId)}
  }})
  const create=(id:number,shotId:string)=>f.service.createPlan(id,{scriptRevision:hashText(shotId),profile:'16:9',shots:[shot({shotId,visualType:'image'})]},'红军行进。','title')
  const first=create(1,'slow'),second=create(2,'fast')
  p.runner.schedule(first.id);await firstEntered;p.runner.schedule(second.id)
  try {
    await Promise.race([completedSecond,new Promise((_,reject)=>setTimeout(()=>reject(Error('second job blocked behind first')),500))])
  }finally {release();await p.runner.idle()}
  assert.equal(f.service.find(first.id)?.status,'completed')
  assert.equal(f.service.find(second.id)?.status,'completed')
})

test('cached recognition reports the unmatched shot and reuses measured evidence without rerunning Whisper',async t=>{
  const f=fixture(t),audioPath=path.join(f.root,'retained.m4a'),audio='retained-master'
  const prefix=path.join(f.root,`whisper-${hashText(audio).slice(0,16)}`),recognitionFile=`${prefix}.json`
  const cli=process.env.WHISPER_CLI,model=process.env.WHISPER_MODEL
  process.env.WHISPER_CLI=path.join(f.root,'missing-cli');process.env.WHISPER_MODEL=path.join(f.root,'missing-model')
  t.after(()=>{
    if(cli===undefined)delete process.env.WHISPER_CLI;else process.env.WHISPER_CLI=cli
    if(model===undefined)delete process.env.WHISPER_MODEL;else process.env.WHISPER_MODEL=model
  })
  fs.writeFileSync(audioPath,audio)
  const shots=[shot(),shot({shotId:'s2',narration:'队伍出发。'})]
  const coarse=JSON.stringify({transcription:[{text:'红军行进队伍出发',offsets:{from:0,to:2000}}]})
  fs.writeFileSync(recognitionFile,coarse)
  await assert.rejects(measureMotionShotEnds(audioPath,shots,f.root,2),/语音识别已完成.*1 个镜尾.*s1/)
  assert.equal(fs.readFileSync(audioPath,'utf8'),audio)
  assert.equal(fs.readFileSync(recognitionFile,'utf8'),coarse)
  fs.writeFileSync(recognitionFile,JSON.stringify({transcription:[
    {text:'红军行进',offsets:{from:0,to:1000}},
    {text:'队伍出发',offsets:{from:1000,to:2000}},
  ]}))
  const measured=await measureMotionShotEnds(audioPath,shots,f.root,2)
  assert.equal(measured?.shotEndTimes.length,1)
  assert.equal(measured?.shotEndTimes[0].endMs,1000)
  assert.equal(measured?.captions.map(caption=>caption.text).join(''),shots.map(shot=>shot.narration).join(''))
  assert.equal(fs.readFileSync(audioPath,'utf8'),audio)
})

test('short footage freezes automatically and a broken first file advances to the next candidate',async t=>{
  const f=fixture(t);f.setRows([f.row('a'),f.row('b')]);const p=pipeline(f,{probe:async(filename:string)=>{if(filename.endsWith('a.mp4'))throw Error('无法解码');return {duration:1,width:1920,height:1080}}})
  const job=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  const completed=f.service.find(job.id)!
  assert.equal(completed.status,'completed');assert.equal(completed.plan?.shots[0].assetId,'b')
  assert.equal(completed.plan?.shots[0].shortfallPolicy,'freeze')
})

test('an image design still prefers local video and retries retain native clip motion',async t=>{
  const f=fixture(t);f.setRows([f.row('a')])
  const p=pipeline(f,{renderFails:true,design:{visualType:'image',motion:{kind:'kenburns',durationScale:1,keyframes:[{t:0,focusX:.5,focusY:.5,zoom:1},{t:1,focusX:.5,focusY:.5,zoom:1.06}]}}})
  const job=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle();p.runner.schedule(job.id);await p.runner.idle()
  const completed=f.service.find(job.id)!
  assert.equal(completed.plan?.shots[0].visualType,'video')
  assert.equal(completed.plan?.shots[0].motion,null)
  assert.equal(completed.plan?.shots[0].sourceEvidence.originalAudio,'muted')
  assert.equal(completed.plan?.shots[0].sourceEvidence.burnedCaptions,'not_reviewed')
  assert.equal(p.counts().imageCalls,0)
})

test('a single-place locator cannot claim to show encirclement',async t=>{
  const f=fixture(t);let mapInput:any
  const p=pipeline(f,{design:{visualType:'map',mapPlan:{title:'包围圈合拢',places:['瑞金']}},prepareMap:async(input:any)=>{mapInput=input;return {enabled:true,backgroundSrc:fixtureMap(f.root)}}})
  const job=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(mapInput.title,'瑞金 · 地理位置')
})

test('symbolic forces reach executable map preparation and keep a single-city action title',async t=>{
  const f=fixture(t);let mapInput:any
  const force={id:'garrison',faction:'朝廷军',flagText:'明',color:'#365b7b',city:'真定',action:'hold',start:.2,end:1.2}
  const p=pipeline(f,{design:{visualType:'map',mapPlan:{title:'朝廷军屯兵真定',places:['真定'],forces:[force]}},
    prepareMap:async(input:any)=>{mapInput=input;return {enabled:true,backgroundSrc:fixtureMap(f.root),forces:input.forces}}})
  const job=f.service.create(1,'朝廷军屯兵真定。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(f.service.find(job.id)?.status,'completed')
  assert.equal(mapInput.title,'朝廷军屯兵真定')
  assert.deepEqual(mapInput.forces,[force])
  assert.equal(p.plans[0].shots[0].map.forces[0].city,'真定')
  assert.equal(p.counts().imageCalls,0)
})

test('map plans accept named actions but reject model-generated geometry and unknown targets',()=>{
  const plan={places:['瑞金'],presentation:{kind:'encirclement',target:'瑞金',label:'计划外围部署',compress:true}}
  assert.deepEqual(motionMapPlanSchema.parse(plan),plan)
  for(const invalid of [
    {...plan,coordinates:[116,26]},
    {...plan,presentation:{...plan.presentation,center:[.5,.5]}},
    {...plan,presentation:{...plan.presentation,target:'南京'}},
    {...plan,presentation:{kind:'route'}},
    {...plan,routes:[{from:'瑞金',to:'遵义',points:[[0,0],[1,1]]}]},
  ])assert.equal(motionMapPlanSchema.safeParse(invalid).success,false)
})

test('map forces accept symbolic commanders and require named destinations, valid routes and shot-local timing',()=>{
  const force={id:'yan',commander:'朱棣',faction:'燕军',flagText:'燕',color:'#a54232',city:'德州',routeIndex:0,action:'occupy',troopKind:'cavalry',start:.4,end:1.6}
  const plan={places:['济南','德州'],routes:[{from:'济南',to:'德州'}],forces:[force]}
  assert.deepEqual(motionMapPlanSchema.parse(plan),plan)
  assert.equal(motionPlanSchema.safeParse({scriptRevision:'a'.repeat(64),profile:'16:9',shots:[shot({mapPlan:plan as any})]}).success,true)
  for(const patch of [
    {city:'南京'}, {routeIndex:1}, {city:'济南'}, {action:'hold'},
    {start:2,end:1}, {end:0}, {start:-1}, {color:'url(https://example.org)'},
    {portraitSrc:'/private/avatar.png'}, {x:.5,y:.5},
  ])assert.equal(motionMapPlanSchema.safeParse({...plan,forces:[{...force,...patch}]}).success,false)
  assert.equal(motionMapPlanSchema.safeParse({...plan,forces:[force,force]}).success,false)
  assert.equal(motionMapPlanSchema.safeParse({...plan,forces:[force,{...force,id:'other',start:.5}]}).success,false)
  assert.equal(motionPlanSchema.safeParse({scriptRevision:'a'.repeat(64),shots:[shot({mapPlan:{...plan,forces:[{...force,end:3}]} as any})]}).success,false)
})

test('stationary occupation and holding need no route while attack needs a route or explicit encirclement',()=>{
  const force={id:'ming',faction:'朝廷军',flagText:'明',color:'#365b7b',city:'济南',start:0,end:1}
  const plan={places:['济南']}
  for(const action of ['hold','occupy'])assert.equal(motionMapPlanSchema.safeParse({...plan,forces:[{...force,action}]}).success,true)
  for(const action of ['march','retreat','attack'])assert.equal(motionMapPlanSchema.safeParse({...plan,forces:[{...force,action}]}).success,false)
  assert.equal(motionMapPlanSchema.safeParse({...plan,presentation:{kind:'encirclement'},forces:[{...force,action:'attack'}]}).success,true)
})

test('narrated encirclement reaches map preparation and keeps its action title for a single place',async t=>{
  const f=fixture(t);let mapInput:any
  const presentation={kind:'encirclement',target:'瑞金',label:'计划外围部署',compress:true}
  const p=pipeline(f,{design:{visualType:'map',mapPackId:'changping-context',mapPlan:{title:'瑞金外围部署示意',places:['瑞金'],presentation}},
    prepareMap:async(input:any)=>{mapInput=input;return {enabled:true,backgroundSrc:fixtureMap(f.root),encirclement:{label:input.presentation.label}}}})
  const job=f.service.create(1,'计划围绕瑞金构筑包围圈，逐步压缩活动空间。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(f.service.find(job.id)?.status,'completed')
  assert.equal(mapInput.title,'瑞金外围部署示意')
  assert.deepEqual(mapInput.presentation,presentation)
  assert.equal(p.plans[0].shots[0].map.encirclement.label,'计划外围部署')
  assert.equal(p.counts().imageCalls,0)
})

test('unsupported compression is removed while the narrated surrounding deployment remains',async t=>{
  const f=fixture(t);let mapInput:any
  const p=pipeline(f,{design:{visualType:'map',mapPlan:{title:'瑞金外围部署示意',places:['瑞金'],presentation:{kind:'encirclement',compress:true}}},
    prepareMap:async(input:any)=>{mapInput=input;return {enabled:true,backgroundSrc:fixtureMap(f.root)}}})
  const job=f.service.create(1,'计划以瑞金为中心构筑包围圈。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(mapInput.presentation.compress,false)
  assert.equal(f.service.find(job.id)?.status,'completed')
  assert.ok(f.service.find(job.id)?.plan?.fallbacks.some((item:any)=>item.stage==='map-animation'))
})

test('an invented encirclement falls back to a scene without calling map preparation',async t=>{
  const f=fixture(t);let mapCalls=0
  const p=pipeline(f,{design:{visualType:'map',mapPlan:{places:['瑞金'],presentation:{kind:'encirclement'}}},
    prepareMap:async()=>{mapCalls++;throw Error('should not prepare an invented action')}})
  const job=f.service.create(1,'瑞金街头人来人往。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(mapCalls,0)
  assert.equal(f.service.find(job.id)?.status,'completed')
  assert.equal(p.plans[0].shots[0].visualType,'image')
  assert.match(f.service.find(job.id)?.plan?.fallbacks[0].reason,/没有包围或封锁依据/)
})

test('missing footage generates an image and a render retry reuses voice, image and design',async t=>{
  const f=fixture(t),p=pipeline(f,{renderFails:true}),job=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(f.service.find(job.id)?.status,'queued')
  assert.match(f.service.find(job.id)?.retry?.lastError || '',/渲染暂时失败/)
  p.runner.schedule(job.id);await p.runner.idle()
  const completed=f.service.find(job.id)!
  assert.equal(completed.status,'completed');assert.ok(completed.plan?.shots[0].imagePath)
  assert.equal(completed.plan?.shots[0].motion.kind,'kenburns')
  assert.deepEqual(p.counts(),{audioCalls:1,renderCalls:2,modelCalls:1,imageCalls:1,deliverCalls:1})
})

test('map preparation uses named places and routes before attempting footage or images',async t=>{
  const f=fixture(t);f.setRows([f.row('a')]);let mapInput:any
  const p=pipeline(f,{design:{visualType:'map',mapPlan:{places:['瑞金','遵义'],routes:[{from:'瑞金',to:'遵义'}]}},prepareMap:async(input:any)=>{mapInput=input;return {enabled:true,backgroundSrc:fixtureMap(f.root)}}})
  const job=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(f.service.find(job.id)?.status,'completed')
  assert.deepEqual(mapInput.places,['瑞金','遵义']);assert.equal(mapInput.duration,2)
  assert.ok(p.plans[0].shots[0].map.enabled);assert.equal(p.counts().imageCalls,0)
})

test('map and image failures remain retryable instead of creating a pure graphic shot',async t=>{
  const f=fixture(t),p=pipeline(f,{imageError:true,design:{visualType:'map',mapPlan:{places:['瑞金']}}})
  const job=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  const completed=f.service.find(job.id)!
  assert.equal(completed.status,'queued');assert.match(completed.retry!.lastError,/底层素材/);assert.equal(p.counts().renderCalls,0)
  assert.deepEqual(completed.plan?.fallbacks.map((f:any)=>f.stage),['map','video','image'])
})

test('missing base footage stops unstarted images after a failure and preserves manuscript for retry',async t=>{
  const f=fixture(t)
  const lines=['红军出发。','队伍行进。','越过山地。','继续前进。']
  const script=lines.join('')
  const job=f.service.createPlan(1,motionPlanSchema.parse({scriptRevision:hashText(script),profile:'16:9',shots:lines.map((narration,index)=>shot({
    shotId:`s${index+1}`,narration,visualType:'image',imagePrompt:`独立场景 ${index+1}`,
  }))}),script,'红军行进')
  const imageCalls:string[]=[];let rendered=false
  const runner=createMotionRunner(f.service,{
    audio:async(_script,directory)=>{const audioPath=path.join(directory,'voice.m4a');fs.writeFileSync(audioPath,'audio');return {audioPath,duration:8}},
    generateImage:async input=>{imageCalls.push(input.shotId);throw Error('图片服务暂不可用')},
    render:async(plan,directory)=>{
      assert.equal(plan.shots.length,4)
      assert.ok(plan.shots.every((s:any)=>s.visualType==='graphic' && s.graphic))
      assert.equal(plan.shots.map((s:any)=>s.narration).join(''),script)
      assert.equal(plan.durationInFrames,240)
      const outputPath=path.join(directory,'movie.mp4');fs.writeFileSync(outputPath,'movie');rendered=true
      return {outputPath,report:{sha256:hashText('movie'),qa:{technical:'passed'}}}
    },
    deliver:async()=>({status:'attached',message:'成片已关联'}),
  })
  runner.schedule(job.id);await runner.idle()
  assert.deepEqual(imageCalls,['s1','s2']);assert.equal(rendered,false)
  assert.equal(f.service.find(job.id)?.status,'failed')
  assert.equal(f.service.find(job.id)?.script,script)
  assert.match(f.service.find(job.id)?.error || '',/底层素材/)
})

test('temporary design outages preserve the original job without starting downstream work',async t=>{
  const f=fixture(t);f.setRows([f.row('a')]);const p=pipeline(f,{modelError:true})
  const job=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  const paused=f.service.find(job.id)!
  assert.equal(paused.status,'queued')
  assert.equal(paused.script,'红军行进。')
  assert.ok(paused.retry?.nextAttemptAt)
  assert.ok(p.counts().modelCalls>=1 && p.counts().modelCalls<=2)
  assert.equal(p.counts().audioCalls,0)
  assert.equal(p.counts().imageCalls,0)
  assert.equal(p.counts().renderCalls,0)
  assert.equal(p.counts().deliverCalls,0)
  await p.runner.stop()
})

test('association retry only attaches the existing movie and never rerenders or invents human approval',async t=>{
  const f=fixture(t);f.setRows([f.row('a')]);const p=pipeline(f,{deliveryFails:true})
  const job=f.service.create(1,'红军行进。','title','a'.repeat(64),'16:9')
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(f.service.find(job.id)?.status,'queued');assert.equal(f.service.find(job.id)?.stage,'rendered')
  p.runner.schedule(job.id);await p.runner.idle()
  assert.equal(f.service.find(job.id)?.status,'completed')
  assert.deepEqual(p.counts(),{audioCalls:1,renderCalls:1,modelCalls:1,imageCalls:0,deliverCalls:2})
  assert.equal(f.service.find(job.id)?.plan?.humanReview,undefined)
})
