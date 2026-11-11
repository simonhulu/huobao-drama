import test,{after,beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-dual-video-'))
process.env.DB_PATH=path.join(root,'test.db')
process.env.STORAGE_PATH=root
process.env.TASK_WORKER_DISABLED='1'
const {db}=await import('../db/index.js')
const {storeHistorySource,updateHistorySource}=await import('./history-script-library.js')
const {ensureHistoryDualProductionSchema,ensureHistoryVideoPublicationSchema,recordHistoryDualProduction,recordHistoryVideoDelivery,recordHistoryVideoPublication}=await import('./history-video-deliveries.js')
const {runHistoryDualProductionPass,historyDualProduction,queueHistoryRefinedBackfill}=await import('./history-video-workflow.js')
const {runHistoryVideoPublicationPass,requestHistoryVideoPublication}=await import('./history-video-publication.js')
const {HistoryHuashengService}=await import('./history-huasheng.js')
const {HistoryHuashengExportService}=await import('./history-huasheng-export.js')
const {ensureHistorySocialUploadSchema}=await import('./history-social-upload.js')
const huashengSchema=new HistoryHuashengService({databasePath:process.env.DB_PATH,loadSource:()=>assert.fail('schema initialization must not read a source'),
  driver:{getHuashengBrowserStatus:async()=>assert.fail('no browser'),openHuashengBrowser:async()=>assert.fail('no browser'),runHuashengBrowserJob:async()=>assert.fail('no browser')}})
const exportSchema=new HistoryHuashengExportService({database:db.$client,root})
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const receipt=()=>({staged:true,submitted:true,saved:false,published:false,publicationStatus:'submitted',
  articleId:'1880000000000000001',publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=1880000000000000001',
  targetId:'original-editor',editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2'})
const script='秦朝统一天下后，六国旧地仍有反抗势力。'
let serial=0
ensureHistoryDualProductionSchema(db.$client);ensureHistoryVideoPublicationSchema(db.$client)
ensureHistorySocialUploadSchema(db.$client)
beforeEach(()=>{db.$client.exec('DELETE FROM history_dual_production; DELETE FROM history_video_publication_intents; DELETE FROM history_huasheng_jobs; DELETE FROM history_huasheng_export_jobs')})
after(async()=>{await huashengSchema.close();await exportSchema.close();db.$client.close();fs.rmSync(root,{recursive:true,force:true})})
function source() {
  const value=storeHistorySource({sourceVideoId:String(++serial),title:'秦朝为何灭亡',category:'regional_history',metrics:{},selection:{reason:'test',observedAt:new Date().toISOString(),comments:[]}})
  return updateHistorySource(value.id,{rawTranscript:script,correctedTranscript:script,rewrittenScript:script,
    mediaJson:JSON.stringify({videoSha256:'1'.repeat(64),chunks:[{start:0,duration:2,sha256:'2'.repeat(64)}]}),
    asrJson:JSON.stringify({complete:true,text:script,sourceVideoSha256:'1'.repeat(64),chunks:[{index:0,start:0,duration:2,audioSha256:'2'.repeat(64)}]}),
    reviewJson:JSON.stringify({factCheckStatus:'needs_sources',rawTranscriptSha256:hash(script),correctedTranscriptSha256:hash(script),rewriteInputSha256:hash(script)})})!
}
function fixture(id:number,failHuasheng=false) {
  let huashengCalls=0,motionCalls=0
  const job={id:1,sourceId:id,productionStatus:'not_started',status:'queued',projectUrl:null}
  const deps={queue:{produce:async()=>{huashengCalls++;if(failHuasheng)throw Error('花生暂不可用');return {results:[{status:'queued'}]}},getJob:()=>job,checkProduction:async()=>{}},
    factory:{production:{list:()=>[],find:()=>({status:'planning'})},startFromSource:async(value:any)=>{
      motionCalls++;assert.equal(value.rewrittenScript,script);return {job:{id:`motion-${id}`},episode:{id:500+id}}
    }}}
  return {deps:deps as any,counts:()=>({huashengCalls,motionCalls})}
}
function completedHuasheng(sourceId:number,options:{scriptHash?:string;status?:string;productionStatus?:string;cancelRequested?:number}={}) {
  return Number(db.$client.prepare(`INSERT INTO history_huasheng_jobs
    (source_id,title,script,script_sha256,status,stage,message,production_status,cancel_requested,created_at,updated_at)
    VALUES(?, '旧花生作品', ?, ?, ?, 'submitted','已完成', ?, ?, 'before','before')`)
    .run(sourceId,script,options.scriptHash || hash(script),options.status || 'submitted',options.productionStatus || 'completed',options.cancelRequested || 0).lastInsertRowid)
}
function persistedExport(sourceId:number,jobId:number,status='queued') {
  return Number(db.$client.prepare(`INSERT INTO history_huasheng_export_jobs
    (huasheng_job_id,source_id,script_sha256,project_url,status,stage,message,created_at,updated_at)
    VALUES(?,?,?,'https://www.huasheng.cn/video/123',?,'waiting_production','已接纳原项目导出','before','before')`)
    .run(jobId,sourceId,hash(script),status).lastInsertRowid)
}
function refuseHuasheng(deps:any) {
  deps.queue={produce:async()=>assert.fail('backfill must not create Huasheng work'),getJob:()=>assert.fail('backfill must not inspect Huasheng'),checkProduction:async()=>assert.fail('backfill must not check Huasheng')}
  deps.exporter={enqueue:async()=>assert.fail('backfill must not export old Huasheng output')}
}
function submittedDelivery(sourceId:number,producer:'huasheng'|'motion',producerJobId:string) {
  const video=recordHistoryVideoDelivery(db.$client,{scriptId:sourceId,scriptSha256:hash(script),producer,producerJobId,
    videoUrl:`/static/history-deliveries/${sourceId}/${producer}-released.mp4`,videoName:'released.mp4',duration:2,sha256:hash(`${sourceId}:${producer}`)})
  db.$client.prepare(`INSERT INTO history_social_upload_jobs
    (source_id,source_title,video_id,target,mode,publication_mode,status,message,blockers_json,fingerprint,engine,result_json,created_at,updated_at)
    VALUES(?, '已完成并释放的成片', ?, 'baijiahao-video', 'draft', 'publish', 'completed', '已提交', '[]', ?, 'test', ?, 'before', 'before')`)
    .run(sourceId,video.id,hash(`${sourceId}:${producer}:upload`),JSON.stringify(receipt()))
  return video
}

for(const previousState of ['pending','started','completed','failed']) {
  test(`submitted current editions remain completed after cleanup from a ${previousState} projection without redoing work`,async()=>{
    const value=source(),f=fixture(value.id),motionJobId=`released-motion-${value.id}`
    recordHistoryDualProduction(db.$client,value.id,hash(script),1)
    db.$client.prepare(`UPDATE history_dual_production SET huasheng_state=?,motion_state=?,motion_job_id=?
      WHERE source_id=?`).run(previousState,previousState,motionJobId,value.id)
    submittedDelivery(value.id,'huasheng','1');submittedDelivery(value.id,'motion',motionJobId)
    f.deps.queue={produce:async()=>assert.fail('submitted edition must not recreate Huasheng work'),
      getJob:()=>assert.fail('receipt completes production without another platform lookup'),
      checkProduction:async()=>assert.fail('submitted edition must not inspect platform production')}
    f.deps.exporter={enqueue:async()=>assert.fail('released submitted output must not be exported again')}
    f.deps.factory.production.find=()=>assert.fail('released submitted output must not be recovered from its render')
    f.deps.factory.startFromSource=async()=>assert.fail('released submitted output must not render again')
    f.deps.deliverCompletedMotion=async()=>assert.fail('released submitted output must not be re-associated')
    await runHistoryDualProductionPass(f.deps)
    db.$client.prepare('UPDATE history_dual_production SET next_check_at=0 WHERE source_id=?').run(value.id)
    await runHistoryDualProductionPass(f.deps)
    const row=historyDualProduction(value.id)[0]!
    assert.equal(row.huasheng_state,'completed');assert.equal(row.motion_state,'completed')
    assert.equal(row.motion_job_id,motionJobId)
    assert.deepEqual(f.counts(),{huashengCalls:0,motionCalls:0})
  })
}

test('a submitted older producer task cannot complete a different active task for the same manuscript',async()=>{
  const value=source(),f=fixture(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),2)
  db.$client.prepare(`UPDATE history_dual_production SET huasheng_state='started',motion_state='started',
    motion_job_id='replacement-motion',export_requested=1 WHERE source_id=?`).run(value.id)
  submittedDelivery(value.id,'huasheng','1');submittedDelivery(value.id,'motion','old-motion')
  persistedExport(value.id,2)
  f.deps.queue.getJob=()=>({id:2,sourceId:value.id,status:'submitted',productionStatus:'completed',projectUrl:'https://www.huasheng.cn/video/2'})
  f.deps.factory.production.find=()=>({status:'planning'})
  await runHistoryDualProductionPass(f.deps)
  const row=historyDualProduction(value.id)[0]!
  assert.equal(row.huasheng_state,'started');assert.equal(row.motion_state,'started')
})
test('one accepted manuscript starts both producers once and retries reuse the durable intent',async()=>{
  const value=source(),f=fixture(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  await Promise.all([runHistoryDualProductionPass(f.deps),runHistoryDualProductionPass(f.deps)])
  await runHistoryDualProductionPass(f.deps)
  assert.deepEqual(f.counts(),{huashengCalls:1,motionCalls:1})
  const state=historyDualProduction(value.id)[0]!
  assert.equal(state.huasheng_state,'started');assert.equal(state.motion_state,'started')
  assert.equal(state.episode_id,500+value.id)
})

for(const huashengState of ['pending','started','failed','completed']) {
  test(`motion-only recovery proceeds with Huasheng ${huashengState}, preserving its branch and excluded sources`,async()=>{
    const old=process.env.HISTORY_HUASHENG_WORKER_DISABLED
    process.env.HISTORY_HUASHENG_WORKER_DISABLED='1'
    try {
      const value=source(),outside=source(),f=fixture(value.id)
      recordHistoryDualProduction(db.$client,value.id,hash(script),1)
      recordHistoryDualProduction(db.$client,outside.id,hash(script),2)
      db.$client.prepare("UPDATE history_dual_production SET huasheng_state=?,huasheng_error='原花生额度或登录错误' WHERE source_id=?").run(huashengState,value.id)
      const excluded=historyDualProduction(outside.id)[0]
      const dependencies={...f.deps,sourceIds:[value.id],motionOnly:true}
      Object.defineProperty(dependencies,'queue',{get:()=>assert.fail('motion-only must not load the Huasheng service')})
      Object.defineProperty(dependencies,'exporter',{get:()=>assert.fail('motion-only must not load the export service')})
      await runHistoryDualProductionPass(dependencies)
      await runHistoryDualProductionPass(dependencies)
      const row=historyDualProduction(value.id)[0]!
      assert.equal(row.motion_state,'started')
      assert.equal(row.production_mode,'dual')
      assert.equal(row.huasheng_state,huashengState)
      assert.equal(row.huasheng_error,'原花生额度或登录错误')
      assert.equal(row.export_requested,0)
      assert.deepEqual(historyDualProduction(outside.id)[0],excluded)
      assert.deepEqual(f.counts(),{huashengCalls:0,motionCalls:1})
    } finally {
      if(old===undefined)delete process.env.HISTORY_HUASHENG_WORKER_DISABLED
      else process.env.HISTORY_HUASHENG_WORKER_DISABLED=old
    }
  })
}

test('motion-only reconciliation follows its original completed job even while the Huasheng branch is pending',async()=>{
  const value=source(),f=fixture(value.id),job={id:`motion-${value.id}`,status:'completed',scriptId:value.id,
    script,profile:'16:9',factory:{episodeId:500+value.id}}
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  db.$client.prepare("UPDATE history_dual_production SET motion_state='failed',motion_job_id=?,episode_id=? WHERE source_id=?")
    .run(job.id,job.factory.episodeId,value.id)
  f.deps.factory.production.find=(id:string)=>{assert.equal(id,job.id);return job}
  let delivered=0
  f.deps.deliverCompletedMotion=async(existing:unknown)=>{assert.equal(existing,job);delivered++}
  const dependencies={...f.deps,motionOnly:true}
  Object.defineProperty(dependencies,'queue',{get:()=>assert.fail('no Huasheng access')})
  await runHistoryDualProductionPass(dependencies)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'completed')
  assert.equal(historyDualProduction(value.id)[0]!.huasheng_state,'pending')
  assert.equal(delivered,1)
  assert.deepEqual(f.counts(),{huashengCalls:0,motionCalls:0})
})

for (const status of ['needs_attention', 'waiting_login', 'failed', 'canceled']) {
  test(`dual reconciliation does not poll a ${status} cloud project`, async()=>{
    const value=source(),f=fixture(value.id),jobId=completedHuasheng(value.id,{status,productionStatus:'creating'})
    recordHistoryDualProduction(db.$client,value.id,hash(script),jobId)
    db.$client.prepare("UPDATE history_dual_production SET huasheng_state='started',motion_state='completed',export_requested=1 WHERE source_id=?").run(value.id)
    persistedExport(value.id,jobId)
    f.deps.queue.getJob=()=>({id:jobId,sourceId:value.id,status,productionStatus:'creating',projectUrl:'https://www.huasheng.cn/video/123'})
    let checks=0
    f.deps.queue.checkProduction=()=>{checks++;return {checking:true}}
    await runHistoryDualProductionPass(f.deps)
    assert.equal(checks,0,'blocked or stopped work must wait for an explicit user action')
    assert.equal(f.counts().huashengCalls,0)
    assert.equal(huashengSchema.getJob(jobId).status,status)
    assert.equal(huashengSchema.getJob(jobId).productionCheckedAt,null)
  })
}

for (const productionStatus of ['not_started', 'queued', 'creating', 'completed']) {
  test(`dual delivery only polls accepted unfinished cloud work: ${productionStatus}`, async()=>{
    const value=source(),f=fixture(value.id),jobId=completedHuasheng(value.id,{productionStatus})
    recordHistoryDualProduction(db.$client,value.id,hash(script),jobId)
    db.$client.prepare("UPDATE history_dual_production SET huasheng_state='started',motion_state='completed',export_requested=1 WHERE source_id=?").run(value.id)
    persistedExport(value.id,jobId)
    f.deps.queue.getJob=()=>({id:jobId,sourceId:value.id,status:'submitted',productionStatus,projectUrl:'https://www.huasheng.cn/video/123'})
    const checks:unknown[]=[]
    f.deps.queue.checkProduction=(sourceId:number,options:unknown)=>{checks.push({sourceId,options});return {checking:true}}
    assert.equal(huashengSchema.monitoring.enabled,false)
    await runHistoryDualProductionPass(f.deps)
    const expected=['queued','creating'].includes(productionStatus)
      ? [{sourceId:value.id,options:{automatic:true,jobIds:[jobId]}}] : []
    assert.deepEqual(checks,expected,'delivery checks are automatic and scoped to the accepted original job')
    await runHistoryDualProductionPass(f.deps)
    assert.deepEqual(checks,expected,'the same task waits for its next due time')
    assert.equal(huashengSchema.monitoring.enabled,false,'delivery must not turn on general monitoring')
    assert.equal(f.counts().huashengCalls,0)
  })
}

for(const mode of ['new','failed-retry','backfill'] as const) {
  test(`an oversized ${mode} intent preserves its locked manuscript until the source starts a prepared new version`,async()=>{
    const oversized='历史主线与关键事实。'.repeat(600)
    const value=updateHistorySource(source().id,{rewrittenScript:oversized})!,f=fixture(value.id)
    const previous={id:'old-oversized-motion',scriptId:value.id,script:oversized,profile:'16:9',status:'failed',
      factory:{episodeId:1229},outputPath:null}
    if(mode==='backfill') {
      const huashengId=completedHuasheng(value.id,{scriptHash:hash(oversized)})
      db.$client.prepare('UPDATE history_huasheng_jobs SET script=? WHERE id=?').run(oversized,huashengId)
      assert.equal(queueHistoryRefinedBackfill([value.id]).results[0]!.status,'queued')
      refuseHuasheng(f.deps)
    } else {
      recordHistoryDualProduction(db.$client,value.id,hash(oversized),1)
      db.$client.prepare("UPDATE history_dual_production SET huasheng_state='completed' WHERE source_id=?").run(value.id)
    }
    if(mode==='failed-retry')db.$client.prepare('UPDATE history_dual_production SET motion_job_id=?,episode_id=? WHERE source_id=?')
      .run(previous.id,1229,value.id)
    let starts=0
    f.deps.factory.production.find=()=>mode==='failed-retry'?previous:null
    const start=async()=>{
      starts++
      updateHistorySource(value.id,{rewrittenScript:'缩写后的新版本。'})
      return {job:{id:'new-version-motion'},episode:{id:1230}}
    }
    f.deps.factory.startEpisode=start
    f.deps.factory.startFromSource=start
    const before=db.$client.prepare('SELECT review_json,rewritten_script FROM history_script_sources WHERE id=?').get(value.id)
    await runHistoryDualProductionPass(f.deps)
    assert.equal(starts,0,'An old intent must not start a factory call that can condense its locked source')
    assert.deepEqual(db.$client.prepare('SELECT review_json,rewritten_script FROM history_script_sources WHERE id=?').get(value.id),before)
    const row=historyDualProduction(value.id)[0]!
    assert.equal(row.script_sha256,hash(oversized))
    assert.equal(row.motion_state,'failed')
    assert.match(row.motion_error!,/原稿.*缩写.*新/)
    assert.equal(row.motion_job_id,mode==='failed-retry'?previous.id:null)
  })
}

for(const state of ['queued','planning','selecting','rendering','validating','completed','failed-output'] as const) {
  test(`an oversized existing ${state} task continues without rewriting its source`,async()=>{
    const oversized='历史主线与关键事实。'.repeat(600)
    const value=updateHistorySource(source().id,{rewrittenScript:oversized})!,f=fixture(value.id)
    recordHistoryDualProduction(db.$client,value.id,hash(oversized),1)
    const job={id:`retained-${state}`,scriptId:value.id,script:oversized,profile:'16:9',
      status:state==='failed-output'?'failed':state,outputPath:state==='completed'||state==='failed-output'?'/static/old-render.mp4':null,factory:{episodeId:1229}}
    db.$client.prepare("UPDATE history_dual_production SET huasheng_state='completed',motion_job_id=?,episode_id=1229 WHERE source_id=?")
      .run(job.id,value.id)
    f.deps.factory.production.find=()=>job
    f.deps.factory.startFromSource=async()=>assert.fail('An existing locked task must be retained')
    let resumed=0,delivered=0
    f.deps.factory.startEpisode=async()=>{resumed++;if(state==='failed-output')job.status='completed';return {job,episode:{id:1229}}}
    f.deps.deliverCompletedMotion=async()=>{delivered++}
    await runHistoryDualProductionPass(f.deps)
    assert.equal(resumed,state==='failed-output'?1:0)
    assert.equal(delivered,state==='completed'||state==='failed-output'?1:0)
    const row=historyDualProduction(value.id)[0]!
    assert.equal(row.motion_state,state==='completed'||state==='failed-output'?'completed':'started')
    assert.equal(row.motion_job_id,job.id)
    assert.equal(row.script_sha256,hash(oversized))
    const saved=db.$client.prepare('SELECT rewritten_script FROM history_script_sources WHERE id=?').get(value.id) as {rewritten_script:string}
    assert.equal(saved.rewritten_script,oversized)
  })
}

test('an already condensed slightly oversized intent may start its locked manuscript',async()=>{
  const preparedScript='史'.repeat(4600)
  const value=source()
  const review=JSON.parse(value.reviewJson!)
  updateHistorySource(value.id,{rewrittenScript:preparedScript,
    reviewJson:JSON.stringify({...review,scriptCondensation:{scriptSha256:hash(preparedScript)}})})
  recordHistoryDualProduction(db.$client,value.id,hash(preparedScript),1)
  const f=fixture(value.id)
  let starts=0
  f.deps.factory.startFromSource=async(value:any)=>{starts++;assert.equal(value.rewrittenScript,preparedScript);return {job:{id:'prepared-motion'},episode:{id:1231}}}
  await runHistoryDualProductionPass(f.deps)
  assert.equal(starts,1)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'started')
})

test('a Huasheng failure does not prevent the refined version from starting',async()=>{
  const value=source(),f=fixture(value.id,true)
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  await runHistoryDualProductionPass(f.deps)
  const state=historyDualProduction(value.id)[0]!
  assert.equal(state.huasheng_state,'failed');assert.equal(state.motion_state,'started')
  assert.equal(f.counts().motionCalls,1)
})
test('an unresolved Huasheng synchronization blocks only that branch while refined production starts',async()=>{
  const value=source(),f=fixture(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  db.$client.prepare("UPDATE history_dual_production SET huasheng_state='failed',huasheng_error='原创建结果待核对' WHERE source_id=?").run(value.id)
  f.deps.queue.produce=async()=>assert.fail('An unresolved project must not be submitted again')
  await runHistoryDualProductionPass(f.deps)
  const state=historyDualProduction(value.id)[0]!
  assert.equal(state.huasheng_state,'failed')
  assert.equal(state.huasheng_error,'原创建结果待核对')
  assert.equal(state.motion_state,'started')
  assert.equal(f.counts().motionCalls,1)
})
test('Huasheng quota waiting still registers refined work while both local execution slots are occupied',async()=>{
  const value=source(),f=fixture(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  const occupied=[{id:'local-render',status:'rendering'},{id:'local-images',status:'selecting'}]
  f.deps.queue.produce=async()=>({results:[{status:'blocked',message:'标准额度不足，保留花生原项目'}]})
  f.deps.queue.getJob=()=>({id:1,sourceId:value.id,status:'needs_attention',productionStatus:'not_started',
    projectUrl:null,error:'标准额度不足',checkpoint:'quota_waiting'})
  f.deps.factory.production.list=()=>occupied
  await runHistoryDualProductionPass(f.deps)
  const row=historyDualProduction(value.id)[0]!
  assert.equal(row.huasheng_state,'failed')
  assert.match(row.huasheng_error!,/额度不足/)
  assert.equal(row.motion_state,'started','accepted refined work must have a visible task while waiting for execution')
  assert.equal(row.motion_job_id,`motion-${value.id}`)
  assert.equal(row.episode_id,500+value.id)
  await runHistoryDualProductionPass(f.deps)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(f.counts().motionCalls,1,'quota waiting must not duplicate or prevent the refined job')
  assert.equal(historyDualProduction(value.id)[0]!.huasheng_state,'failed')
})
test('a changed manuscript cannot dispatch either accepted old production branch',async()=>{
  const value=source(),f=fixture(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  updateHistorySource(value.id,{rewrittenScript:'用户保存了新稿'})
  await runHistoryDualProductionPass(f.deps)
  assert.deepEqual(f.counts(),{huashengCalls:0,motionCalls:0})
})
test('Huasheng export admission remains unfinished until a current local video is delivered',async()=>{
  const value=source(), f=fixture(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  db.$client.prepare("UPDATE history_dual_production SET huasheng_state='started',motion_state='completed' WHERE source_id=?").run(value.id)
  f.deps.queue!.getJob=()=>({id:1,sourceId:value.id,status:'submitted',productionStatus:'completed',projectUrl:'https://www.huasheng.ai/project/test'} as any)
  let exportCalls=0
  f.deps.exporter={enqueue:async()=>{exportCalls++;if(exportCalls===1)throw Error('导出服务暂不可用');persistedExport(value.id,1);return {jobs:[]} as any}}
  await runHistoryDualProductionPass(f.deps)
  let state=historyDualProduction(value.id)[0]!
  assert.equal(state.huasheng_state,'started')
  assert.equal(state.huasheng_error,'导出服务暂不可用')
  assert.equal(state.export_requested,0)
  await runHistoryDualProductionPass(f.deps)
  state=historyDualProduction(value.id)[0]!
  assert.equal(exportCalls,2)
  assert.equal(state.huasheng_state,'started','accepting an export is not proof of a delivered local video')
  assert.equal(state.huasheng_error,null)
  assert.equal(state.export_requested,1)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(exportCalls,2)
  const directory=path.join(root,'history-deliveries',String(value.id))
  fs.mkdirSync(directory,{recursive:true})
  fs.writeFileSync(path.join(directory,'huasheng.mp4'),'delivered Huasheng output')
  recordHistoryVideoDelivery(db.$client,{scriptId:value.id,scriptSha256:hash(script),producer:'huasheng',producerJobId:'1',
    videoUrl:`/static/history-deliveries/${value.id}/huasheng.mp4`,videoName:'huasheng.mp4',duration:2,sha256:hash('delivered Huasheng output')})
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.huasheng_state,'completed')
})
test('an export requested marker with no durable task reconnects the original project once',async()=>{
  const value=source(),f=fixture(value.id),jobId=completedHuasheng(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),jobId)
  db.$client.prepare("UPDATE history_dual_production SET huasheng_state='started',motion_state='completed',export_requested=1 WHERE source_id=?").run(value.id)
  f.deps.queue.getJob=()=>({id:jobId,sourceId:value.id,status:'submitted',productionStatus:'completed',projectUrl:'https://www.huasheng.cn/video/123'})
  f.deps.queue.produce=async()=>assert.fail('missing export must not recreate platform production')
  let exports=0
  f.deps.exporter={enqueue:async(ids:number[])=>{
    assert.deepEqual(ids,[value.id]);exports++
    return {jobs:[{id:persistedExport(value.id,jobId)}]}
  }}
  await runHistoryDualProductionPass(f.deps)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(exports,1)
  assert.deepEqual(db.$client.prepare('SELECT huasheng_job_id,source_id,script_sha256 FROM history_huasheng_export_jobs').all(),[
    {huasheng_job_id:jobId,source_id:value.id,script_sha256:hash(script)},
  ])
  assert.equal(historyDualProduction(value.id)[0]!.huasheng_state,'started')
})
test('a failed missing-export handoff retains its error and retries the same accepted intent',async()=>{
  const value=source(),f=fixture(value.id),jobId=completedHuasheng(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),jobId)
  db.$client.prepare("UPDATE history_dual_production SET huasheng_state='started',motion_state='completed',export_requested=1 WHERE source_id=?").run(value.id)
  f.deps.queue.getJob=()=>({id:jobId,sourceId:value.id,status:'submitted',productionStatus:'completed',projectUrl:'https://www.huasheng.cn/video/123'})
  let exports=0
  f.deps.exporter={enqueue:async()=>{
    if(++exports===1)throw Error('导出服务暂不可用')
    return {jobs:[{id:persistedExport(value.id,jobId)}]}
  }}
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.huasheng_error,'导出服务暂不可用')
  await runHistoryDualProductionPass(f.deps)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(exports,2)
  assert.equal(historyDualProduction(value.id)[0]!.huasheng_error,null)
})
for(const status of ['queued','failed','needs_attention','completed']) {
  test(`an existing ${status} export is retained when the request marker is set`,async()=>{
    const value=source(),f=fixture(value.id),jobId=completedHuasheng(value.id)
    recordHistoryDualProduction(db.$client,value.id,hash(script),jobId)
    db.$client.prepare("UPDATE history_dual_production SET huasheng_state='started',motion_state='completed',export_requested=1 WHERE source_id=?").run(value.id)
    const exportId=persistedExport(value.id,jobId,status)
    f.deps.queue.getJob=()=>({id:jobId,sourceId:value.id,status:'submitted',productionStatus:'completed',projectUrl:'https://www.huasheng.cn/video/123'})
    let exports=0
    f.deps.exporter={enqueue:async()=>{exports++;return {jobs:[]}}}
    await runHistoryDualProductionPass(f.deps)
    assert.equal(exports,0,'an original export record must not be replaced or implicitly retried')
    assert.equal(exportSchema.listJobs(value.id)[0]!.id,exportId)
    assert.equal(exportSchema.listJobs(value.id)[0]!.status,status)
  })
}
for(const stopped of ['canceled','cancel_requested','deleted'] as const) {
  test(`a missing export is not recreated for a ${stopped} production`,async()=>{
    const value=source(),f=fixture(value.id),jobId=completedHuasheng(value.id)
    recordHistoryDualProduction(db.$client,value.id,hash(script),jobId)
    db.$client.prepare("UPDATE history_dual_production SET huasheng_state='started',motion_state='completed',export_requested=1 WHERE source_id=?").run(value.id)
    if(stopped==='deleted')db.$client.prepare('UPDATE history_script_sources SET deleted_at=? WHERE id=?').run(new Date().toISOString(),value.id)
    f.deps.queue.getJob=()=>({id:jobId,sourceId:value.id,status:stopped==='canceled'?'canceled':'submitted',cancelRequested:stopped==='cancel_requested',productionStatus:'completed',projectUrl:'https://www.huasheng.cn/video/123'})
    let exports=0
    f.deps.exporter={enqueue:async()=>{exports++;return {jobs:[]}}}
    await runHistoryDualProductionPass(f.deps)
    assert.equal(exports,0,'canceled or deleted work must not regain an export task')
    assert.equal(exportSchema.listJobs(value.id).length,0)
  })
}
test('old completed Huasheng projections follow a failed and resumed original export without recreating production',async()=>{
  const value=source(),f=fixture(value.id),jobId=completedHuasheng(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),jobId)
  db.$client.prepare("UPDATE history_dual_production SET huasheng_state='completed',motion_state='completed',export_requested=1 WHERE source_id=?").run(value.id)
  const exportId=Number(db.$client.prepare(`INSERT INTO history_huasheng_export_jobs
    (huasheng_job_id,source_id,script_sha256,project_url,status,stage,message,error,created_at,updated_at)
    VALUES(?,?,?,'https://www.huasheng.cn/video/123','failed','exporting','原导出失败','原导出失败','before','before')`)
    .run(jobId,value.id,hash(script)).lastInsertRowid)
  f.deps.queue.getJob=()=>({id:jobId,sourceId:value.id,status:'submitted',productionStatus:'completed',projectUrl:'https://www.huasheng.cn/video/123'})
  f.deps.queue.produce=async()=>assert.fail('accepted export must not recreate platform production')
  f.deps.factory.startFromSource=async()=>assert.fail('completed refined branch must remain untouched')
  f.deps.exporter={enqueue:async()=>assert.fail('original export must not be replaced')}
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.huasheng_state,'failed')
  assert.match(historyDualProduction(value.id)[0]!.huasheng_error!,/原导出失败/)
  db.$client.prepare("UPDATE history_huasheng_export_jobs SET status='queued',error=NULL WHERE id=?").run(exportId)
  db.$client.prepare('UPDATE history_dual_production SET next_check_at=0 WHERE source_id=?').run(value.id)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.huasheng_state,'started')
  assert.equal(exportSchema.listJobs(value.id)[0]!.id,exportId)
})
test('a broken Huasheng status read cannot prevent another accepted manuscript from starting',async()=>{
  const first=source(), second=source(), f=fixture(first.id)
  recordHistoryDualProduction(db.$client,first.id,hash(script),1)
  recordHistoryDualProduction(db.$client,second.id,hash(script),2)
  f.deps.queue!.getJob=(id:number)=>{
    if(id===1)throw Error('花生任务不存在')
    return {id,sourceId:second.id,status:'queued',productionStatus:'not_started',projectUrl:null} as any
  }
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(first.id)[0]!.huasheng_state,'failed')
  assert.equal(historyDualProduction(first.id)[0]!.motion_state,'started')
  assert.equal(historyDualProduction(second.id)[0]!.huasheng_state,'started')
  assert.equal(historyDualProduction(second.id)[0]!.motion_state,'started')
  assert.equal(f.counts().motionCalls,2)
})
test('each completed version publishes immediately without waiting for the other version or replaying the first',async()=>{
  const value=source(),requests:any[]=[],jobs:any[]=[]
  const video=(producer:'huasheng'|'motion')=>recordHistoryVideoDelivery(db.$client,{scriptId:value.id,scriptSha256:hash(script),producer,
    producerJobId:producer,videoUrl:`/static/history-deliveries/${value.id}/${producer}.mp4`,videoName:`${producer}.mp4`,duration:2,sha256:hash(producer)})
  const dependencies={packaging:async()=>({design:{status:'completed'},covers:{status:'completed'}}),social:{listJobs:()=>jobs,enqueue:async(input:any)=>{
    requests.push(input);jobs.push({videoId:input.videoIds[0],target:'baijiahao-video',mode:'publish',status:'completed',result:receipt()});return {jobs}
  }}} as any
  const first=video('huasheng')
  recordHistoryVideoPublication(db.$client,value.id,hash(script),first.id,'huasheng')
  await runHistoryVideoPublicationPass(dependencies)
  assert.equal(requests.length,1);assert.deepEqual(requests[0].videoIds,[first.id]);assert.equal(requests[0].mode,'publish')
  const second=video('motion')
  recordHistoryVideoPublication(db.$client,value.id,hash(script),second.id,'motion')
  db.$client.prepare('UPDATE history_video_publication_intents SET next_attempt_at=0').run()
  await runHistoryVideoPublicationPass(dependencies)
  assert.equal(requests.length,2);assert.deepEqual(requests[1].videoIds,[second.id])
  await runHistoryVideoPublicationPass(dependencies)
  assert.equal(requests.length,2)
})
test('startup does not publish pre-existing outputs without an accepted delivery intent',async()=>{
  const value=source()
  recordHistoryVideoDelivery(db.$client,{scriptId:value.id,scriptSha256:hash(script),producer:'motion',producerJobId:'old',videoUrl:'/old.mp4',videoName:'old.mp4',duration:2,sha256:hash('old')})
  await runHistoryVideoPublicationPass({packaging:async()=>{assert.fail('old library must not be backfilled')}})
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM history_video_publication_intents').get() as {n:number}).n,0)
})

test('refined backfill admits only selected current completed Huasheng manuscripts and isolates blocked items',()=>{
  const ready=source(),unfinished=source(),stale=source(),canceled=source(),cancelRequested=source()
  const jobId=completedHuasheng(ready.id)
  completedHuasheng(unfinished.id,{productionStatus:'creating'})
  completedHuasheng(stale.id,{scriptHash:hash('旧正文')})
  completedHuasheng(canceled.id,{status:'canceled'})
  completedHuasheng(cancelRequested.id,{cancelRequested:1})
  const result=queueHistoryRefinedBackfill([ready.id,unfinished.id,stale.id,canceled.id,cancelRequested.id,999999,ready.id])
  assert.equal(result.results.length,6)
  assert.equal(result.results[0]!.status,'queued')
  assert.equal(result.results[0]!.huashengJobId,jobId)
  assert.ok(result.results.slice(1).every(item=>item.status==='blocked'))
  const row=historyDualProduction(ready.id)[0]!
  assert.equal(row.production_mode,'motion_backfill')
  assert.equal(row.huasheng_state,'completed')
  assert.equal(row.export_requested,1)
  assert.equal(row.motion_state,'pending')
  assert.equal(historyDualProduction(stale.id).length,0)
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM history_huasheng_jobs').get() as {n:number}).n,5)
  for(const ids of [[],[0],[1.1],[Number.MAX_SAFE_INTEGER+1],Array(101).fill(ready.id)])assert.throws(()=>queueHistoryRefinedBackfill(ids),/有效文稿编号/)
})

test('repeated backfill admission preserves started and completed jobs while explicit failure retry reuses identity',()=>{
  const value=source(),jobId=completedHuasheng(value.id)
  queueHistoryRefinedBackfill([value.id])
  db.$client.prepare("UPDATE history_dual_production SET motion_state='started',motion_job_id='existing',episode_id=1063 WHERE source_id=?").run(value.id)
  assert.equal(queueHistoryRefinedBackfill([value.id]).results[0]!.status,'reused')
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'started')
  db.$client.prepare("UPDATE history_dual_production SET motion_state='completed' WHERE source_id=?").run(value.id)
  queueHistoryRefinedBackfill([value.id])
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'completed')
  db.$client.prepare("UPDATE history_dual_production SET motion_state='failed',motion_error='关联失败' WHERE source_id=?").run(value.id)
  queueHistoryRefinedBackfill([value.id],{retry:false})
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'failed')
  assert.equal(queueHistoryRefinedBackfill([value.id]).results[0]!.status,'queued')
  const row=historyDualProduction(value.id)[0]!
  assert.equal(row.motion_state,'pending');assert.equal(row.motion_error,null)
  assert.equal(row.motion_job_id,'existing');assert.equal(row.episode_id,1063);assert.equal(row.huasheng_job_id,jobId)
  const dual=source(),dualJob=completedHuasheng(dual.id)
  recordHistoryDualProduction(db.$client,dual.id,hash(script),dualJob)
  queueHistoryRefinedBackfill([dual.id])
  assert.equal(historyDualProduction(dual.id)[0]!.production_mode,'dual')
})

test('backfill registers only the motion branch even while both execution slots are occupied',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  f.deps.factory.production.list=()=>[{status:'planning'},{status:'rendering'}]
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'started')
  assert.equal(historyDualProduction(value.id)[0]!.episode_id,500+value.id)
  assert.equal(f.counts().motionCalls,1)
  await runHistoryDualProductionPass(f.deps)
  await runHistoryDualProductionPass(f.deps)
  assert.deepEqual(f.counts(),{huashengCalls:0,motionCalls:1})
  assert.equal(historyDualProduction(value.id)[0]!.huasheng_state,'completed')
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'started')
})

test('completed same-script factory output is re-associated before completion without starting or rendering again',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  const completed={id:'existing-factory',status:'completed',scriptId:value.id,script,profile:'16:9',scriptRevision:'old-metadata-revision',factory:{episodeId:1063}}
  f.deps.factory.production.list=()=>[completed,{status:'planning'},{status:'rendering'}]
  f.deps.factory.production.find=(id:string)=>{assert.equal(id,completed.id);return completed}
  f.deps.factory.startFromSource=async()=>assert.fail('existing completed factory output must not be started again')
  let associations=0
  f.deps.deliverCompletedMotion=async(job:any,_factory:any,assertCurrent:()=>void)=>{
    assert.equal(job,completed);assertCurrent();associations++
    assert.equal(historyDualProduction(value.id)[0]!.motion_state,'started','association must finish before completion')
    const video=recordHistoryVideoDelivery(db.$client,{scriptId:value.id,scriptSha256:hash(script),producer:'motion',producerJobId:job.id,
      videoUrl:'/static/verified.mp4',videoName:'精细化.mp4',duration:2,sha256:hash('verified')})
    requestHistoryVideoPublication(value.id,hash(script),video.id,'motion')
    await Promise.resolve()
  }
  await runHistoryDualProductionPass(f.deps)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(associations,1)
  const row=historyDualProduction(value.id)[0]!
  assert.equal(row.motion_state,'completed');assert.equal(row.motion_job_id,completed.id);assert.equal(row.episode_id,1063)
  assert.equal(requestHistoryVideoPublication(value.id,hash(script),99,'huasheng'),null)
  assert.deepEqual(db.$client.prepare('SELECT producer,status FROM history_video_publication_intents').all(),[{producer:'motion',status:'pending'}])
})

test('a failed completed-output handoff is retryable and never claims completion or restarts rendering',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  const completed={id:'existing-factory',status:'completed',scriptId:value.id,script,profile:'16:9',factory:{episodeId:1062}}
  f.deps.factory.production.list=()=>[completed]
  f.deps.factory.production.find=()=>completed
  f.deps.factory.startFromSource=async()=>assert.fail('handoff retry must not start rendering')
  let calls=0
  f.deps.deliverCompletedMotion=async()=>{if(++calls===1)throw Error('成片文件指纹不匹配')}
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'failed')
  assert.match(historyDualProduction(value.id)[0]!.motion_error!,/指纹不匹配/)
  queueHistoryRefinedBackfill([value.id])
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'completed')
  assert.equal(calls,2)
})

test('completed output handoff rejects changed manuscript before claiming the queued production is complete',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  const completed={id:'existing-factory',status:'completed',scriptId:value.id,script,profile:'16:9',factory:{episodeId:1063}}
  f.deps.factory.production.list=()=>[completed]
  f.deps.factory.production.find=()=>completed
  f.deps.deliverCompletedMotion=async(_job:any,_factory:any,assertCurrent:()=>void)=>{
    assertCurrent()
    updateHistorySource(value.id,{rewrittenScript:'关联期间用户保存了新稿'})
    await Promise.resolve()
    assertCurrent()
  }
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'failed')
  assert.match(historyDualProduction(value.id)[0]!.motion_error!,/正文已更新/)
})

test('default completed-output handoff checks the actual output instead of trusting completed job status',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  const completed={id:'missing-file',status:'completed',scriptId:value.id,script,profile:'16:9',factory:{episodeId:1063},
    stage:'rendered',outputPath:path.join(root,'missing-file','output.mp4'),plan:{delivery:{sha256:hash('not-on-disk'),qa:{technical:'passed'}}}}
  f.deps.factory.production.root=root
  f.deps.factory.production.list=()=>[completed]
  f.deps.factory.production.find=()=>completed
  f.deps.factory.production.write=()=>assert.fail('missing output must not be associated')
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'failed')
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM history_video_publication_intents').get() as {n:number}).n,0)
})

test('a dual completed projection recovers delivery from its original motion job without starting another render',async()=>{
  const value=source(),f=fixture(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  const completed={id:'original-dual-output',status:'completed',scriptId:value.id,script,profile:'16:9',factory:{episodeId:1266}}
  db.$client.prepare(`UPDATE history_dual_production SET huasheng_state='completed',motion_state='completed',
    motion_job_id=?,episode_id=1266 WHERE source_id=?`).run(completed.id,value.id)
  f.deps.factory.production.find=()=>completed
  f.deps.factory.startFromSource=async()=>assert.fail('existing output must not create another task')
  f.deps.factory.startEpisode=async()=>assert.fail('delivery recovery must not render again')
  let delivered=0
  f.deps.deliverCompletedMotion=async()=>{
    delivered++
    const directory=path.join(root,'history-deliveries',String(value.id));fs.mkdirSync(directory,{recursive:true})
    fs.writeFileSync(path.join(directory,'motion.mp4'),'original motion output')
    const video=recordHistoryVideoDelivery(db.$client,{scriptId:value.id,scriptSha256:hash(script),producer:'motion',producerJobId:completed.id,
      videoUrl:`/static/history-deliveries/${value.id}/motion.mp4`,videoName:'motion.mp4',duration:2,sha256:hash('original motion output')})
    requestHistoryVideoPublication(value.id,hash(script),video.id,'motion')
  }
  await runHistoryDualProductionPass(f.deps)
  assert.equal(delivered,1)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'completed')
  assert.equal(historyDualProduction(value.id)[0]!.motion_job_id,completed.id)
  assert.equal((db.$client.prepare('SELECT count(*) n FROM history_video_publication_intents WHERE source_id=?').get(value.id) as {n:number}).n,1)
  db.$client.prepare('UPDATE history_dual_production SET next_check_at=0 WHERE source_id=?').run(value.id)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(delivered,1,'the current real delivery is reused')
})

test('a dual completed job with a missing original file is attention rather than a completed delivery',async()=>{
  const value=source(),f=fixture(value.id)
  recordHistoryDualProduction(db.$client,value.id,hash(script),1)
  const completed={id:'missing-dual-output',status:'completed',scriptId:value.id,script,profile:'16:9',factory:{episodeId:1267},
    stage:'rendered',outputPath:path.join(root,'missing-dual-output','output.mp4'),plan:{delivery:{sha256:hash('missing'),qa:{technical:'passed'}}}}
  db.$client.prepare(`UPDATE history_dual_production SET huasheng_state='completed',motion_state='completed',
    motion_job_id=?,episode_id=1267 WHERE source_id=?`).run(completed.id,value.id)
  f.deps.factory.production.root=root
  f.deps.factory.production.find=()=>completed
  f.deps.factory.startFromSource=async()=>assert.fail('missing delivery cannot create another task')
  f.deps.factory.production.write=()=>assert.fail('missing output cannot be delivered')
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'failed')
  assert.equal((db.$client.prepare('SELECT count(*) n FROM history_video_publication_intents WHERE source_id=?').get(value.id) as {n:number}).n,0)
})

test('failed publication intents follow an existing job recovery to completion without packaging or re-enqueueing',async()=>{
  const value=source()
  const video=recordHistoryVideoDelivery(db.$client,{scriptId:value.id,scriptSha256:hash(script),producer:'motion',producerJobId:'refined',
    videoUrl:'/static/refined.mp4',videoName:'精细化.mp4',duration:2,sha256:hash('refined')})
  recordHistoryVideoPublication(db.$client,value.id,hash(script),video.id,'motion')
  const job={id:'168',videoId:video.id,target:'baijiahao-video',mode:'publish',status:'uncertain',error:'发表结果未知',message:'等待核对',result:{...receipt(),submitted:false}}
  const dependencies={packaging:async()=>assert.fail('existing publication recovery must not package again'),social:{
    listJobs:()=>[job],enqueue:async()=>assert.fail('existing publication recovery must not submit again'),
  }} as any
  await runHistoryVideoPublicationPass(dependencies)
  const state=()=>db.$client.prepare('SELECT status,error FROM history_video_publication_intents WHERE video_id=?').get(video.id)
  assert.deepEqual(state(),{status:'failed',error:'发表结果未知'})
  job.status='running';job.error='';job.message='正在核对已有发表'
  db.$client.prepare('UPDATE history_video_publication_intents SET next_attempt_at=0').run()
  await runHistoryVideoPublicationPass(dependencies)
  assert.equal((state() as {status:string}).status,'failed','a recovering job does not authorize a fresh submission')
  job.status='completed';job.message='已提交百家号';job.result.submitted=true
  db.$client.prepare('UPDATE history_video_publication_intents SET next_attempt_at=0').run()
  await runHistoryVideoPublicationPass(dependencies)
  assert.deepEqual(state(),{status:'completed',error:null})
})

test('failed publication reconciliation remains read-only for absent, canceled, unrelated or broken social job lookups',async()=>{
  const value=source()
  recordHistoryVideoPublication(db.$client,value.id,hash(script),999,'motion')
  db.$client.prepare("UPDATE history_video_publication_intents SET status='failed',error='原失败',next_attempt_at=0").run()
  const read=()=>db.$client.prepare('SELECT status,next_attempt_at FROM history_video_publication_intents WHERE video_id=999').get() as {status:string;next_attempt_at:number}
  const matching={id:'169',videoId:999,target:'baijiahao-video',mode:'publish',status:'completed'}
  const lookups=[()=>[],()=>[matching],()=>[{...matching,result:{submitted:false,saved:true}}],
    ()=>[{...matching,status:'canceled'}],()=>[{...matching,videoId:998}],()=>[{...matching,mode:'draft'}],
    ()=>[{...matching,target:'wechat-channels'}],()=>{throw Error('状态读取暂不可用')}]
  for(const listJobs of lookups) {
    db.$client.prepare('UPDATE history_video_publication_intents SET next_attempt_at=0').run()
    await runHistoryVideoPublicationPass({packaging:async()=>assert.fail('failed reconciliation must not package'),
      social:{listJobs,enqueue:async()=>assert.fail('failed reconciliation must not enqueue')}} as any)
    assert.equal(read().status,'failed')
    assert.ok(read().next_attempt_at>Date.now(),'failed reconciliation must be delayed instead of starving new submissions')
  }
})

test('a completed job without a submission receipt cannot complete or re-enqueue its publication intent',async()=>{
  const value=source()
  const video=recordHistoryVideoDelivery(db.$client,{scriptId:value.id,scriptSha256:hash(script),producer:'motion',producerJobId:'receipt-required',
    videoUrl:'/static/refined.mp4',videoName:'精细化.mp4',duration:2,sha256:hash('refined')})
  recordHistoryVideoPublication(db.$client,value.id,hash(script),video.id,'motion')
  const job={id:'171',videoId:video.id,target:'baijiahao-video',mode:'publish',status:'completed',result:{submitted:false,saved:true}}
  const dependencies={packaging:async()=>assert.fail('existing job must not repackage'),social:{
    listJobs:()=>[job],enqueue:async()=>assert.fail('existing job must not re-enqueue'),
  }} as any
  const state=()=>db.$client.prepare('SELECT status,error FROM history_video_publication_intents WHERE video_id=?').get(video.id) as {status:string;error:string|null}
  await runHistoryVideoPublicationPass(dependencies)
  assert.equal(state().status,'failed')
  assert.match(state().error!,/发表回执/)
  job.result=receipt()
  db.$client.prepare('UPDATE history_video_publication_intents SET next_attempt_at=0').run()
  await runHistoryVideoPublicationPass(dependencies)
  assert.deepEqual(state(),{status:'completed',error:null})
})

test('restart recovery resumes the durable motion job after metadata changes without creating a replacement',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  const interrupted={id:'original-interrupted',status:'failed',scriptId:value.id,script,profile:'16:9',scriptRevision:'old-metadata-revision',
    factory:{episodeId:1088},error:'服务重启中断制作，配音和已完成画面已保留'}
  db.$client.prepare("UPDATE history_dual_production SET motion_state='started',motion_job_id=?,episode_id=1088 WHERE source_id=?").run(interrupted.id,value.id)
  updateHistorySource(value.id,{title:'只更新标题，正文和原配音保持不变'})
  f.deps.factory.production.list=()=>[interrupted]
  f.deps.factory.production.find=(id:string)=>id===interrupted.id?interrupted:null
  f.deps.factory.startFromSource=async()=>assert.fail('recovery must use the durable job and episode')
  let resumed=0
  f.deps.factory.startEpisode=async(id:number,input:any)=>{
    assert.equal(id,1088);assert.equal(input.retry,true);resumed++;interrupted.status='planning'
    return {job:interrupted,episode:{id}}
  }
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'pending')
  await runHistoryDualProductionPass(f.deps)
  assert.equal(resumed,1)
  const row=historyDualProduction(value.id)[0]!
  assert.equal(row.motion_state,'started');assert.equal(row.motion_job_id,interrupted.id);assert.equal(row.episode_id,1088)
})

test('failed workflow resumes tracking its original manually retried job and records completion once',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  const job={id:'manually-retried',status:'queued',scriptId:value.id,script,profile:'16:9',factory:{episodeId:1109}}
  db.$client.prepare("UPDATE history_dual_production SET motion_state='failed',motion_error='旧的图片服务故障',motion_job_id=?,episode_id=1109 WHERE source_id=?").run(job.id,value.id)
  f.deps.factory.production.find=(id:string)=>id===job.id?job:null
  f.deps.factory.startEpisode=async()=>assert.fail('reconciliation must not restart a job')
  f.deps.factory.startFromSource=async()=>assert.fail('reconciliation must not create a replacement')
  let deliveries=0
  f.deps.deliverCompletedMotion=async()=>{deliveries++}
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'started')
  assert.equal(historyDualProduction(value.id)[0]!.motion_error,null)
  job.status='completed'
  await runHistoryDualProductionPass(f.deps)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'completed')
  assert.equal(historyDualProduction(value.id)[0]!.motion_job_id,job.id)
  assert.equal(deliveries,1)
})

test('failed workflow reconciles an already completed original job without retrying production',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  const job={id:'completed-outside-workflow',status:'completed',scriptId:value.id,script,profile:'16:9',factory:{episodeId:1110}}
  db.$client.prepare("UPDATE history_dual_production SET motion_state='failed',motion_job_id=?,episode_id=1110 WHERE source_id=?").run(job.id,value.id)
  f.deps.factory.production.find=()=>job
  let deliveries=0
  f.deps.deliverCompletedMotion=async()=>{deliveries++}
  f.deps.factory.startFromSource=async()=>assert.fail('completed original must not be replaced')
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'completed')
  assert.equal(deliveries,1)
})

test('a broken motion lookup cannot prevent the next accepted manuscript from starting',async()=>{
  const first=source(),second=source(),f=fixture(first.id)
  for(const value of [first,second])completedHuasheng(value.id)
  queueHistoryRefinedBackfill([first.id,second.id]);refuseHuasheng(f.deps)
  db.$client.prepare("UPDATE history_dual_production SET motion_state='started',motion_job_id='broken-motion' WHERE source_id=?").run(first.id)
  f.deps.factory.production.find=(id:string)=>{if(id==='broken-motion')throw Error('制作快照暂时不可读取');return {status:'planning'}}
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(first.id)[0]!.motion_state,'failed')
  assert.equal(historyDualProduction(second.id)[0]!.motion_state,'started')
  assert.equal(f.counts().motionCalls,1)
})

test('failed reconciliation is delayed and cannot consume the admission limit for new manuscripts',async()=>{
  const failed=Array.from({length:51},()=>source()),waiting=source(),f=fixture(waiting.id)
  for(const value of [...failed,waiting])completedHuasheng(value.id)
  queueHistoryRefinedBackfill([...failed.map(value=>value.id),waiting.id]);refuseHuasheng(f.deps)
  for(const value of failed)db.$client.prepare("UPDATE history_dual_production SET motion_state='failed',motion_job_id=?,motion_error='保留失败',created_at='before' WHERE source_id=?").run(`failed-${value.id}`,value.id)
  let failedReads=0
  f.deps.factory.production.find=(id:string)=>{if(id.startsWith('failed-')){failedReads++;return {status:'failed'}}return {status:'planning'}}
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(waiting.id)[0]!.motion_state,'started')
  assert.equal(f.counts().motionCalls,1)
  assert.equal(failedReads,50)
  assert.ok(historyDualProduction(failed[0]!.id)[0]!.next_check_at>Date.now())
  await runHistoryDualProductionPass(f.deps)
  assert.equal(failedReads,51,'already inspected failures wait while the remaining failure is checked')
})

test('failed reconciliation refuses an original job whose manuscript has changed',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  db.$client.prepare("UPDATE history_dual_production SET motion_state='failed',motion_job_id='wrong-manuscript' WHERE source_id=?").run(value.id)
  f.deps.factory.production.find=()=>({id:'wrong-manuscript',status:'completed',scriptId:value.id,script:'另外一篇稿件',profile:'16:9'})
  f.deps.deliverCompletedMotion=async()=>assert.fail('mismatched manuscript must not be delivered')
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'failed')
  assert.match(historyDualProduction(value.id)[0]!.motion_error!,/锁定稿件不匹配/)
})

test('more than fifty long-running projections cannot permanently hide waiting manuscripts',async()=>{
  const active=Array.from({length:51},()=>source()),waiting=source(),f=fixture(waiting.id)
  for(const value of [...active,waiting])completedHuasheng(value.id)
  queueHistoryRefinedBackfill([...active.map(value=>value.id),waiting.id]);refuseHuasheng(f.deps)
  for(const value of active)db.$client.prepare("UPDATE history_dual_production SET motion_state='started',motion_job_id=?,created_at='2000-01-01T00:00:00.000Z',updated_at='2000-01-01T00:00:00.000Z' WHERE source_id=?").run(`active-${value.id}`,value.id)
  f.deps.factory.production.find=()=>({status:'planning'})
  await runHistoryDualProductionPass(f.deps)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(waiting.id)[0]!.motion_state,'started')
  assert.equal(f.counts().motionCalls,1)
})

test('a production pass registers every accepted manuscript and reuses queued identities on later passes',async()=>{
  const values=Array.from({length:8},()=>source()),f=fixture(values[0]!.id)
  for(const value of values)completedHuasheng(value.id)
  queueHistoryRefinedBackfill(values.map(value=>value.id));refuseHuasheng(f.deps)
  const jobs:any[]=[]
  let lists=0,starts=0
  f.deps.factory.production.list=()=>{lists++;return jobs.map(job=>({...job}))}
  f.deps.factory.production.find=(id:string)=>jobs.find(job=>job.id===id)
  f.deps.factory.startFromSource=async(value:any)=>{
    starts++
    const job={id:`bounded-${value.id}`,scriptId:value.id,script,profile:'16:9',status:'queued'}
    jobs.push(job)
    return {job,episode:{id:2000+value.id}}
  }
  await runHistoryDualProductionPass(f.deps)
  assert.equal(starts,8)
  assert.equal(lists,1,'completed-output lookup is shared across the registration pass')
  for(const value of values) {
    const row=historyDualProduction(value.id)[0]!
    assert.equal(row.motion_state,'started')
    assert.equal(row.motion_job_id,`bounded-${value.id}`)
    assert.equal(row.episode_id,2000+value.id)
  }
  lists=0
  await runHistoryDualProductionPass(f.deps)
  assert.equal(starts,8)
  assert.equal(lists,0,'registered queued work is followed by identity without serializing all jobs again')
})

test('an admitted retry queues its original failed job even while both execution slots are occupied',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  const failed={id:'retry-audio-alignment',scriptId:value.id,script,profile:'16:9',status:'failed',
    error:'音频对齐失败',factory:{episodeId:1275}}
  db.$client.prepare("UPDATE history_dual_production SET motion_state='failed',motion_job_id=?,episode_id=1275,motion_error=? WHERE source_id=?")
    .run(failed.id,failed.error,value.id)
  queueHistoryRefinedBackfill([value.id])
  const occupied=[{id:'active-one',status:'rendering'},{id:'active-two',status:'planning'}]
  f.deps.factory.production.list=()=>[failed,...occupied]
  f.deps.factory.production.find=(id:string)=>id===failed.id?failed:null
  f.deps.factory.startFromSource=async()=>assert.fail('retry must retain the original job')
  let retries=0
  f.deps.factory.startEpisode=async(id:number,input:any)=>{
    assert.equal(id,1275);assert.equal(input.retry,true);retries++;failed.status='queued'
    return {job:failed,episode:{id}}
  }
  await runHistoryDualProductionPass(f.deps)
  await runHistoryDualProductionPass(f.deps)
  assert.equal(retries,1)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'started')
  assert.equal(historyDualProduction(value.id)[0]!.motion_error,null)
  occupied.pop()
  await runHistoryDualProductionPass(f.deps)
  assert.equal(retries,1)
  const row=historyDualProduction(value.id)[0]!
  assert.equal(row.motion_state,'started');assert.equal(row.motion_job_id,failed.id);assert.equal(row.episode_id,1275)
})

test('delayed retries remain unchanged while another accepted manuscript is registered',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  const delayed=[1,2].map(id=>({id:`delayed-${id}`,status:'queued',retry:{attempts:1,
    nextAttemptAt:new Date(Date.now()+60000).toISOString(),lastError:'临时服务故障'}}))
  f.deps.factory.production.list=()=>delayed
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'started')
  assert.equal(f.counts().motionCalls,1)
  assert.ok(delayed.every(job=>job.status==='queued'),'admission must not restart delayed work')
})

test('due retries do not prevent another accepted manuscript from having a queued task',async()=>{
  const value=source(),f=fixture(value.id)
  completedHuasheng(value.id);queueHistoryRefinedBackfill([value.id]);refuseHuasheng(f.deps)
  f.deps.factory.production.list=()=>[
    {id:'due-retry',status:'queued',retry:{attempts:1,nextAttemptAt:new Date(Date.now()-1000).toISOString(),lastError:'临时服务故障'}},
    {id:'preparing',status:'planning'},
  ]
  await runHistoryDualProductionPass(f.deps)
  assert.equal(historyDualProduction(value.id)[0]!.motion_state,'started')
  assert.equal(f.counts().motionCalls,1)
})
