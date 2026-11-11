import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { HistorySocialRuntime, HistorySocialSource, SocialUploadPayload, SocialUploadResult } from './history-social-upload.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-publication-topics-')))
process.env.DB_PATH = path.join(root, 'test.db')
process.env.STORAGE_PATH = root
process.env.TASK_WORKER_DISABLED = '1'
const { db } = await import('../db/index.js')
const { storeHistorySource, updateHistorySource } = await import('./history-script-library.js')
const { recordHistoryVideoDelivery, recordHistoryDualProduction, recordHistoryVideoPublication, ensureHistoryVideoPublicationSchema } = await import('./history-video-deliveries.js')
const { ensureHistoryVideoPackagingSchema } = await import('./history-video-packaging.js')
const publication = await import('./history-video-publication.js')
const { requestHistoryVideoPublication, runHistoryVideoPublicationPass } = publication
const { HistorySocialUploadService, ensureHistorySocialUploadSchema } = await import('./history-social-upload.js')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
after(() => { db.$client.close(); fs.rmSync(root, { recursive: true, force: true }) })
ensureHistoryVideoPublicationSchema(db.$client)
beforeEach(()=>db.$client.exec('DELETE FROM history_video_publication_intents'))

let serial=0
function currentVideo(producer:'motion'|'huasheng'='motion') {
  const script='秦朝统一天下后，六国旧地仍有反抗势力。'
  const original=storeHistorySource({sourceVideoId:`2026103100${++serial}`,title:'秦朝为何灭亡',category:'regional_history',
    selection:{reason:'test',observedAt:new Date().toISOString(),comments:[]}})
  const source=updateHistorySource(original.id,{rawTranscript:script,correctedTranscript:script,rewrittenScript:script,
    mediaJson:JSON.stringify({videoSha256:'1'.repeat(64),chunks:[{start:0,duration:2,sha256:'2'.repeat(64)}]}),
    asrJson:JSON.stringify({complete:true,text:script,sourceVideoSha256:'1'.repeat(64),chunks:[{index:0,start:0,duration:2,audioSha256:'2'.repeat(64)}]}),
    reviewJson:JSON.stringify({factCheckStatus:'needs_sources',rawTranscriptSha256:hash(script),correctedTranscriptSha256:hash(script),rewriteInputSha256:hash(script)})})!
  const directory=path.join(root,'history-deliveries',String(source.id));fs.mkdirSync(directory,{recursive:true})
  fs.writeFileSync(path.join(directory,`${producer}.mp4`),'current edition video')
  const video=recordHistoryVideoDelivery(db.$client,{scriptId:source.id,scriptSha256:hash(script),producer,producerJobId:'existing-producer',
    videoUrl:`/static/history-deliveries/${source.id}/${producer}.mp4`,videoName:`${producer}.mp4`,duration:2,sha256:hash('current edition video')})
  recordHistoryDualProduction(db.$client,source.id,hash(script),1)
  requestHistoryVideoPublication(source.id,hash(script),video.id,producer)
  return {source,video}
}

function submittedOriginal(video: ReturnType<typeof currentVideo>['video'], status = 'completed') {
  ensureHistorySocialUploadSchema(db.$client)
  const result = { staged: true, saved: false, submitted: true, published: false,
    targetId: 'original-target', editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit',
    publicationStatus: 'submitted', articleId: '1880027026933416669',
    publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=1880027026933416669' }
  return String(db.$client.prepare(`INSERT INTO history_social_upload_jobs
    (source_id,source_title,target,mode,publication_mode,video_id,video_producer,status,message,
      blockers_json,fingerprint,engine,result_json,created_at,updated_at) VALUES(?,?,'baijiahao-video','draft','publish',?,?,?,
      '原任务','[]',?,'test',?,'before','before')`)
    .run(video.scriptId,'原成片',video.id,video.producer,status,`original-${video.id}`,JSON.stringify(status === 'completed' ? result : { saved: false })).lastInsertRowid)
}
function rebuiltVideo(video: ReturnType<typeof currentVideo>['video']) {
  const videoUrl = `/static/history-deliveries/${video.scriptId}/rebuilt.mp4`
  fs.writeFileSync(path.join(root, videoUrl.replace('/static/', '')), 'rebuilt edition video')
  return recordHistoryVideoDelivery(db.$client, { ...video, videoUrl, producerJobId: 'rebuilt-producer', sha256: hash('rebuilt edition video') })
}

test('an explicit publication allowlist leaves every other intent unchanged, including rejected packaging recovery', async () => {
  const allowed=currentVideo(), outside=currentVideo()
  db.$client.prepare("UPDATE history_video_publication_intents SET status='needs_attention',error='API error 503: rejected',next_attempt_at=0 WHERE video_id=?").run(outside.video.id)
  const before=db.$client.prepare('SELECT * FROM history_video_publication_intents WHERE video_id=?').get(outside.video.id)
  const enqueued:number[]=[]
  await runHistoryVideoPublicationPass({scope:{sourceIds:[allowed.source.id],videoIds:[allowed.video.id]},
    social:{listJobs:()=>[],enqueue:async input=>{enqueued.push(input.videoIds![0]!);return {} as any}},
    packaging:async id=>{assert.equal(id,allowed.source.id);return {design:{status:'completed',message:'ready'},covers:{status:'completed',message:'ready'}}},
  })
  assert.deepEqual(enqueued,[allowed.video.id])
  assert.deepEqual(db.$client.prepare('SELECT * FROM history_video_publication_intents WHERE video_id=?').get(outside.video.id),before)
  await runHistoryVideoPublicationPass({scope:{sourceIds:[]},social:{listJobs:()=>assert.fail('empty scope must do nothing'),enqueue:async()=>assert.fail('empty scope must do nothing')}})
  assert.deepEqual(db.$client.prepare('SELECT * FROM history_video_publication_intents WHERE video_id=?').get(outside.video.id),before)
})

test('registering another render after the original submission cannot authorize automatic publication of that revision', () => {
  const { source, video } = currentVideo()
  submittedOriginal(video)
  const revision = rebuiltVideo(video)
  assert.equal(requestHistoryVideoPublication(source.id, video.scriptSha256, revision.id, 'motion'), null)
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM history_video_publication_intents WHERE video_id=?').get(revision.id) as { n: number }).n, 0)
})

test('old pending revision intents cannot package or submit a second render after the original submission', async () => {
  const { source, video } = currentVideo()
  submittedOriginal(video)
  const revision = rebuiltVideo(video)
  recordHistoryVideoPublication(db.$client, source.id, video.scriptSha256, revision.id, 'motion')
  await runHistoryVideoPublicationPass({ social: { listJobs: () => [], enqueue: async () => assert.fail('revision requires explicit submission') },
    packaging: async () => assert.fail('a stale automatic intent must not start revision packaging') })
  const intent = db.$client.prepare('SELECT status,error FROM history_video_publication_intents WHERE video_id=?').get(revision.id) as { status: string; error: string }
  assert.equal(intent.status, 'needs_attention')
  assert.match(intent.error, /修订|再次发表/)
})

test('continuing a submitted edition revision prepares materials without granting another automatic publication', async () => {
  const { source, video } = currentVideo()
  submittedOriginal(video)
  const revision = rebuiltVideo(video)
  const result = await publication.continueHistoryVideoPublication(source.id, revision.id, revision.scriptSha256, {
    social: { listJobs: () => [], retry: () => assert.fail('must preserve the original submission') },
    packaging: async (_id, options) => {
      assert.equal(options?.videoId, revision.id)
      return { design: { status: 'completed', message: 'ready' }, covers: { status: 'completed', message: 'ready' } }
    },
  })
  assert.equal(result.status, 'ready')
  assert.match(result.message, /明确提交|可发表/)
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM history_video_publication_intents WHERE video_id=?').get(revision.id) as { n: number }).n, 0)
})

test('continuing a revision with an unresolved original attempt cannot prepare materials or retry another video', async () => {
  const { source, video } = currentVideo()
  const originalJob = submittedOriginal(video, 'uncertain')
  const revision = rebuiltVideo(video)
  await assert.rejects(publication.continueHistoryVideoPublication(source.id, revision.id, revision.scriptSha256, {
    social: { listJobs: () => [], retry: () => assert.fail('only the exact original task can be recovered') },
    packaging: async () => assert.fail('unresolved original publication must be handled first'),
  }), new RegExp(`原成片.*#${originalJob}`))
})

test('terminal packaging failures are needs-attention and are not polled as normal pending work',async()=>{
  const {source,video}=currentVideo()
  let calls=0
  const dependencies={social:{listJobs:()=>[],enqueue:async()=>assert.fail('failed materials cannot be submitted')},
    packaging:async()=>{calls++;return {design:{status:'failed' as const,message:'标题校验失败'},covers:{status:'needs_attention' as const,message:'封面需要修复'}}}}
  await runHistoryVideoPublicationPass(dependencies as any)
  const state=()=>db.$client.prepare('SELECT status,error FROM history_video_publication_intents WHERE video_id=?').get(video.id) as {status:string,error:string}
  assert.equal(state().status,'needs_attention')
  assert.match(state().error,/标题校验失败/)
  db.$client.prepare('UPDATE history_video_publication_intents SET next_attempt_at=0 WHERE source_id=?').run(source.id)
  await runHistoryVideoPublicationPass(dependencies as any)
  assert.equal(calls,1,'a terminal material failure needs explicit recovery or changed material evidence')
})

test('refused packaging retries the original edition at durable bounded backoff intervals', async t => {
  const {video}=currentVideo()
  t.mock.timers.enable({apis:['Date'],now:Date.now()})
  const requests:Array<{videoId?:number;retryRejected?:boolean;retryFailed?:boolean}>=[]
  const dependencies={social:{listJobs:()=>[],enqueue:async()=>assert.fail('failed materials cannot be submitted')},
    packaging:async(_id:number,options:any)=>{
      requests.push(options)
      return {design:{status:'completed' as const,message:'original design'},
        covers:{status:'failed' as const,message:'API error 429: {"error":{"code":"gateway_concurrency_limit"}}',retryableRejection:true}}
    }}
  const state=()=>db.$client.prepare('SELECT status,attempts,next_attempt_at FROM history_video_publication_intents WHERE video_id=?')
    .get(video.id) as {status:string;attempts:number;next_attempt_at:number}
  for(const [index,delay] of [30000,60000,120000].entries()) {
    await runHistoryVideoPublicationPass(dependencies as any)
    assert.equal(state().status,'pending')
    assert.equal(state().attempts,index+1)
    assert.equal(state().next_attempt_at,Date.now()+delay)
    await runHistoryVideoPublicationPass(dependencies as any)
    assert.equal(requests.length,index+1,'polling before retry deadline must not invoke packaging')
    t.mock.timers.tick(delay)
  }
  await runHistoryVideoPublicationPass(dependencies as any)
  assert.equal(state().status,'needs_attention')
  assert.equal(state().attempts,3)
  t.mock.timers.tick(3600000)
  await runHistoryVideoPublicationPass(dependencies as any)
  assert.equal(requests.length,4,'stop after three additional attempts')
  assert.deepEqual(requests.map(request=>request.videoId),Array(4).fill(video.id))
  assert.deepEqual(requests.map(request=>request.retryRejected),[undefined,true,true,true])
  assert.ok(requests.every(request=>request.retryFailed===undefined),'automatic recovery cannot grant an unrestricted explicit retry')
})

test('a legacy refused packaging intent observes an existing uncertain upload without submitting or regenerating',async()=>{
  const {source,video}=currentVideo()
  db.$client.prepare(`UPDATE history_video_publication_intents SET status='needs_attention',next_attempt_at=0,error=? WHERE video_id=?`)
    .run('API error 429: {"error":{"code":"gateway_concurrency_limit"}}',video.id)
  const job={id:'original-upload',sourceId:source.id,videoId:video.id,mode:'publish',target:'baijiahao-video',status:'uncertain',error:'waiting for receipt'}
  await runHistoryVideoPublicationPass({social:{listJobs:()=>[job] as any,enqueue:async()=>assert.fail('no repeated upload')},
    packaging:async()=>assert.fail('no generation after an external attempt')})
  assert.equal((db.$client.prepare('SELECT status FROM history_video_publication_intents WHERE video_id=?').get(video.id) as {status:string}).status,'failed')
})

test('successful packaging recovery submits once with the original intent request identity',async t=>{
  const {source,video}=currentVideo()
  t.mock.timers.enable({apis:['Date'],now:Date.now()})
  const intent=(db.$client.prepare('SELECT id FROM history_video_publication_intents WHERE video_id=?').get(video.id) as {id:number}).id
  let calls=0
  const enqueued:any[]=[]
  const social={listJobs:()=>enqueued.length?[{id:'original',sourceId:source.id,videoId:video.id,mode:'publish',target:'baijiahao-video',status:'queued'}] as any:[],
    enqueue:async(input:any)=>{enqueued.push(input);return [] as any}}
  const packaging=async(_id:number,options:any)=>{
    calls++
    if(calls===1)return {design:{status:'completed' as const,message:'ready'},covers:{status:'failed' as const,message:'API error 429: rejected',retryableRejection:true}}
    assert.equal(options.retryRejected,true)
    return {design:{status:'completed' as const,message:'reused'},covers:{status:'completed' as const,message:'ready'}}
  }
  await runHistoryVideoPublicationPass({social,packaging})
  t.mock.timers.tick(30000)
  await runHistoryVideoPublicationPass({social,packaging})
  t.mock.timers.tick(30000)
  await runHistoryVideoPublicationPass({social,packaging})
  assert.equal(calls,2)
  assert.equal(enqueued.length,1)
  assert.equal(enqueued[0].requestId,`history-video-${intent}`)
  assert.deepEqual(enqueued[0].videoIds,[video.id])
})

test('explicit edition recovery resumes the original uncertain publication without repackaging or enqueueing',async()=>{
  const {source,video}=currentVideo()
  const job={id:'existing-unknown',sourceId:source.id,videoId:video.id,mode:'publish',target:'baijiahao-video',status:'uncertain',error:'等待原回执',message:'待核对'}
  const retries:string[]=[]
  const result=await (publication as any).continueHistoryVideoPublication(source.id,video.id,video.scriptSha256,{
    social:{listJobs:()=>[job],retry:(id:string)=>{retries.push(id);return {...job,status:'queued'}},enqueue:async()=>assert.fail('must not create another publication')},
    packaging:async()=>assert.fail('the original external checkpoint owns this recovery'),
  })
  assert.deepEqual(retries,[job.id])
  assert.equal(result.job.id,job.id)
})

for(const status of ['canceled','completed'])test(`explicit edition recovery reconciles ${status} original publication evidence without new packaging`,async()=>{
  const {source,video}=currentVideo()
  const job={id:`existing-${status}`,sourceId:source.id,videoId:video.id,mode:'publish',target:'baijiahao-video',status,
    publicationAttempted:true,result:{submitted:false,saved:false},error:'原提交尚待核对',message:'待核对'}
  const retries:string[]=[]
  const result=await publication.continueHistoryVideoPublication(source.id,video.id,video.scriptSha256,{
    social:{listJobs:()=>[job] as any,retry:(id:string|number)=>{retries.push(String(id));return {...job,status:'queued'} as any}},
    packaging:async()=>assert.fail('the original publication checkpoint must be reused'),
  })
  assert.deepEqual(retries,[job.id])
  assert.equal(result.job!.id,job.id)
  await runHistoryVideoPublicationPass({social:{listJobs:()=>[job] as any,enqueue:async()=>assert.fail('a terminal original attempt must not submit again')},
    packaging:async()=>assert.fail('an original attempt must not prepare another publication')})
  const intent=db.$client.prepare('SELECT status FROM history_video_publication_intents WHERE video_id=?').get(video.id) as {status:string}
  assert.equal(intent.status,'failed')
})

test('explicit edition recovery rejects a changed manuscript before touching original publication',async()=>{
  const {source,video}=currentVideo()
  updateHistorySource(source.id,{rewrittenScript:'用户保存了另一版正文'})
  await assert.rejects((publication as any).continueHistoryVideoPublication(source.id,video.id,video.scriptSha256,{
    social:{listJobs:()=>assert.fail('changed revision cannot recover an upload'),retry:()=>assert.fail('no recovery'),enqueue:async()=>assert.fail('no publication')},
  }),/稿件|版本/)
})

test('explicit standalone material recovery does not grant automatic publication',async()=>{
  const {source,video}=currentVideo()
  db.$client.prepare('DELETE FROM history_dual_production WHERE source_id=?').run(source.id)
  db.$client.prepare('DELETE FROM history_video_publication_intents WHERE video_id=?').run(video.id)
  const calls:any[]=[]
  const result=await publication.continueHistoryVideoPublication(source.id,video.id,video.scriptSha256,{
    social:{listJobs:()=>[],retry:()=>assert.fail('there is no original upload')},
    packaging:async(id,options)=>{calls.push({id,options});return {design:{status:'completed',message:'ready'},covers:{status:'completed',message:'ready'}}},
  })
  assert.equal(calls.length,1)
  assert.equal(calls[0].options.videoId,video.id)
  assert.equal(calls[0].options.retryFailed,true)
  assert.match(result.message,/明确提交|可发表/)
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM history_video_publication_intents WHERE video_id=?').get(video.id) as {n:number}).n,0)
})

for(const failedBranch of ['design','cover'])test(`an admitted Huasheng ${failedBranch} failure resumes packaging and registers publication with its original video`,async t=>{
  const {source,video}=currentVideo('huasheng')
  db.$client.prepare('DELETE FROM history_video_publication_intents WHERE video_id=?').run(video.id)
  const jobId=9000+source.id
  db.$client.prepare('UPDATE history_video_deliveries SET producer_job_id=? WHERE id=?').run(String(jobId),video.id)
  db.$client.exec(`CREATE TABLE IF NOT EXISTS history_huasheng_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,
    script_sha256 TEXT,project_url TEXT,production_status TEXT,status TEXT)`)
  db.$client.prepare('INSERT INTO history_huasheng_jobs VALUES(?,?,?,?,?,?)')
    .run(jobId,source.id,video.scriptSha256,`https://www.huasheng.cn/video/${jobId}`,'completed','submitted')
  const {HistoryHuashengExportService}=await import('./history-huasheng-export.js')
  const requests:Array<{videoId?:number;retryFailed?:boolean}>=[]
  const exporter=new HistoryHuashengExportService({database:db.$client,root,stepDelayMs:1,pollMs:1,
    loadSource:()=>({script:source.rewrittenScript!}),
    ensureAutomation:async(_id,input)=>{requests.push(input);return {design:{status:'completed',message:'标题就绪'},covers:{status:'completed',message:'封面就绪'}}},
    api:{createHuashengExport:async()=>assert.fail('the original video must not be exported again'),
      inspectHuashengExport:async()=>assert.fail('no external status needed'),downloadHuashengExport:async()=>assert.fail('no repeated download')},
  })
  t.after(()=>exporter.close())
  const exportId=Number(db.$client.prepare(`INSERT INTO history_huasheng_export_jobs
    (huasheng_job_id,source_id,script_sha256,project_url,status,stage,message,video_url,design_status,cover_status,
      task_id,project_hash,dispatched,created_at,updated_at)
    VALUES(?,?,?,?,'failed','processing','原发布材料失败',?,?,?,'original-export','original-version',1,'before','before')`)
    .run(jobId,source.id,video.scriptSha256,`https://www.huasheng.cn/video/${jobId}`,video.videoUrl,
      failedBranch==='design'?'failed':'completed',failedBranch==='cover'?'failed':'completed').lastInsertRowid)
  const result=await publication.continueHistoryVideoPublication(source.id,video.id,video.scriptSha256,{
    social:{listJobs:()=>[],retry:()=>assert.fail('no prior upload exists')},exporter,
    packaging:async()=>assert.fail('the original export owns material recovery'),
  })
  assert.equal(result.exportJob!.id,exportId)
  await exporter.runPending([exportId])
  assert.equal(exporter.getJob(exportId).status,'completed')
  assert.deepEqual(requests.map(input=>({videoId:input.videoId,retryFailed:input.retryFailed})),[{videoId:video.id,retryFailed:true}])
  const intent=db.$client.prepare('SELECT video_id,status FROM history_video_publication_intents WHERE source_id=?').get(source.id)
  assert.deepEqual(intent,{video_id:video.id,status:'pending'})
  assert.equal(fs.readFileSync(path.join(root,video.videoUrl.replace('/static/','')),'utf8'),'current edition video')
})

test('Remotion publication sends its own video and optional topic through the shared upload service once', async t => {
  const script = '秦朝统一天下后，六国旧地仍有反抗势力。'
  const original = storeHistorySource({ sourceVideoId: '2026103001', title: '秦朝为何灭亡', category: 'regional_history',
    metrics: {}, selection: { reason: 'test', observedAt: new Date().toISOString(), comments: [] } })
  updateHistorySource(original.id, { rawTranscript: script, correctedTranscript: script, rewrittenScript: script,
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 2, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text: script, sourceVideoSha256: '1'.repeat(64),
      chunks: [{ index: 0, start: 0, duration: 2, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(script),
      correctedTranscriptSha256: hash(script), rewriteInputSha256: hash(script) }) })
  const directory = path.join(root, 'history-deliveries', String(original.id))
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'motion.mp4'), 'validated Remotion video')
  fs.writeFileSync(path.join(directory, 'huasheng.mp4'), 'different Huasheng video')
  for (const [name, width, height] of [['landscape', 32, 18], ['portrait', 24, 32]] as const) {
    await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toFile(path.join(directory, `${name}.png`))
  }
  const url = (name: string) => `/static/history-deliveries/${original.id}/${name}`
  const source: HistorySocialSource = { id: original.id, title: original.title, rewrittenScript: script, artifactState: 'current',
    delivery: { title: '秦朝为何灭亡', baijiahaoTitle: '秦朝为何灭亡', description: '当前文案', videoUrl: url('huasheng.mp4'),
      scriptSha256: hash(script), coverScriptSha256: hash(script), coverStatus: 'completed',
      covers: { '16:9': url('landscape.png'), '3:4': url('portrait.png') } } }
  const video = recordHistoryVideoDelivery(db.$client, { scriptId: original.id, scriptSha256: hash(script), producer: 'motion',
    producerJobId: 'motion-topic-fixture', videoUrl: url('motion.mp4'), videoName: '精细化版.mp4', duration: 2,
    sha256: hash('validated Remotion video') })
  ensureHistoryVideoPackagingSchema(db.$client)
  db.$client.prepare(`INSERT INTO history_video_packaging
    (video_id,script_id,title,baijiahao_title,description,video_path,video_name,duration,script_sha256,
    cover_script_sha256,covers_json,cover_status,design_status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(video.id,original.id,'秦朝精细化版发布标题','秦朝精细化版发布标题','本版文案',video.videoUrl,video.videoName,video.duration,
      video.scriptSha256,hash(script),JSON.stringify(source.delivery!.covers),'completed','completed',new Date().toISOString())
  recordHistoryDualProduction(db.$client, original.id, hash(script), 1)
  requestHistoryVideoPublication(original.id, hash(script), video.id, 'motion')
  const uploads: SocialUploadPayload[] = [], confirmations: SocialUploadPayload[] = []
  const staged = (payload: SocialUploadPayload): SocialUploadResult => ({ staged: true, saved: false, published: false,
    targetId: `editor-${payload.jobId}`, editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', engine: 'social-auto-upload' })
  const runtime: HistorySocialRuntime = {
    inspectSocialUploadRuntime: async () => ({ installed: true, version: 'fixture', message: 'ready',
      platforms: { baijiahao: { ready: true, message: 'ready' }, tencent: { ready: true, message: 'ready' } } }),
    inspectSocialUploadCheckpoint: async () => ({ action: 'upload', phase: 'new', message: 'not started' }),
    runSocialUpload: async (payload, options) => { assert.equal(options.saveDraft, false); uploads.push(structuredClone(payload)); return staged(payload) },
    confirmSocialUpload: async (payload, previous) => { confirmations.push(structuredClone(payload)); return { ...previous,
      submitted: true, published: true, publicationStatus: 'published', articleId: '1880000000000000001',
      publishedUrl: 'https://baijiahao.baidu.com/s?id=1880000000000000001' } },
  }
  const social = new HistorySocialUploadService({ database: db.$client, root, runtime,
    loadSource: async id => id === original.id ? structuredClone(source) : null })
  t.after(() => social.close())
  const packagingRequests: Array<{ sourceId: number; videoId?: number }> = []
  const dependencies = { social, packaging: async (sourceId: number, options: { videoId?: number }) => {
    packagingRequests.push({ sourceId, videoId: options.videoId })
    return { design: { status: 'completed' as const, message: 'ready' }, covers: { status: 'completed' as const, message: 'ready' } }
  } }
  await runHistoryVideoPublicationPass(dependencies)
  await social.runPending()
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0]!.videoPath, path.join(directory, 'motion.mp4'), 'the legacy delivery pointer must not select Huasheng video')
  assert.equal(uploads[0]!.publicationMode, 'publish')
  assert.equal(uploads[0]!.title, '秦朝精细化版发布标题')
  assert.equal(uploads[0]!.description, uploads[0]!.title)
  assert.deepEqual(packagingRequests, [{ sourceId: original.id, videoId: video.id }])
  assert.deepEqual(uploads[0]!.tags, ['#热爆趣创赛'])
  assert.deepEqual(confirmations, uploads, 'publication must reuse the same topic-bearing payload')
  assert.equal(social.listJobs(original.id)[0]!.status, 'completed')
  db.$client.prepare('UPDATE history_video_publication_intents SET next_attempt_at=0').run()
  await runHistoryVideoPublicationPass(dependencies)
  await social.runPending()
  assert.equal(uploads.length, 1)
  assert.equal(confirmations.length, 1)
  assert.equal((db.$client.prepare('SELECT status FROM history_video_publication_intents WHERE video_id=?').get(video.id) as { status: string }).status, 'completed')
  // Old upload receipts predate producer-specific video IDs, but still bind the same file.
  const uploadId = social.listJobs(original.id)[0]!.id
  db.$client.prepare("UPDATE history_social_upload_jobs SET video_id=NULL,video_producer='legacy' WHERE id=?").run(uploadId)
  db.$client.prepare("UPDATE history_video_publication_intents SET status='pending',next_attempt_at=0 WHERE video_id=?").run(video.id)
  await runHistoryVideoPublicationPass(dependencies)
  await social.runPending()
  assert.equal(uploads.length, 1, 'registering a producer ID must not publish an already submitted legacy file again')
  assert.equal((db.$client.prepare('SELECT status FROM history_video_publication_intents WHERE video_id=?').get(video.id) as { status: string }).status, 'completed')
  db.$client.prepare("UPDATE history_social_upload_jobs SET status='uncertain',error='等待平台回执' WHERE id=?").run(uploadId)
  db.$client.prepare("UPDATE history_video_publication_intents SET status='pending',next_attempt_at=0 WHERE video_id=?").run(video.id)
  await runHistoryVideoPublicationPass(dependencies)
  assert.equal(uploads.length, 1)
  assert.equal((db.$client.prepare('SELECT status FROM history_video_publication_intents WHERE video_id=?').get(video.id) as { status: string }).status, 'failed')
})
