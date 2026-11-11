import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureHistoryVideoDeliveriesSchema, ensureHistoryDualProductionSchema, recordHistoryVideoDelivery } from './history-video-deliveries.js'
import { ensureHistoryVideoPackagingSchema } from './history-video-packaging.js'
import { getHistoryProductionState, getHistoryProductionStates, isHistorySubmissionReceipt } from './history-production-state.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture(t: TestContext, mode: 'dual' | 'motion_backfill' | null = 'dual') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-production-state-')))
  const database = new Database(':memory:')
  ensureHistoryVideoDeliveriesSchema(database)
  ensureHistoryDualProductionSchema(database)
  ensureHistoryVideoPackagingSchema(database)
  database.exec(`CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY, source_id INTEGER, video_id INTEGER,
    target TEXT,publication_mode TEXT,status TEXT,result_json TEXT,payload_json TEXT,message TEXT,error TEXT,updated_at TEXT,upload_dispatched INTEGER);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY,video_path TEXT,script_sha256 TEXT);
    CREATE TABLE history_huasheng_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,status TEXT,production_status TEXT,message TEXT);
    CREATE TABLE history_huasheng_export_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,status TEXT,message TEXT,error TEXT);`)
  const source = {id: 71, title: '秦朝为何灭亡', rewrittenScript: '秦朝统一后仍面对地方反抗。', artifactState: 'current' as const}
  const digest = hash(source.rewrittenScript)
  if (mode) database.prepare(`INSERT INTO history_dual_production(source_id,script_sha256,huasheng_job_id,production_mode,
    huasheng_state,motion_state,export_requested,created_at,updated_at) VALUES(?,?,1,?,'completed','completed',1,'before','before')`).run(source.id,digest,mode)
  const material = (filename: string) => {
    const relative = `history-deliveries/${source.id}/${filename}`
    fs.mkdirSync(path.dirname(path.join(root,relative)), {recursive:true})
    fs.writeFileSync(path.join(root,relative), filename)
    return `/static/${relative}`
  }
  const video = (producer: 'huasheng' | 'motion', revision = digest) => recordHistoryVideoDelivery(database, {
    scriptId: source.id,scriptSha256:revision,producer,producerJobId:producer,
    videoUrl:material(`${producer}-${revision.slice(0,8)}.mp4`),videoName:`${producer}.mp4`,duration:10,sha256:hash(producer+revision),
  })
  const packageVideo = (id: number) => {
    database.prepare(`INSERT OR REPLACE INTO history_video_packaging(video_id,script_id,script_sha256,cover_script_sha256,
      title,baijiahao_title,design_status,cover_status,covers_json,updated_at) VALUES(?,?,?,?,?,?,'completed','completed',?,'before')`)
      .run(id,source.id,digest,digest,'秦朝为何灭亡','秦朝统一后为何迅速灭亡',JSON.stringify({'16:9':material(`${id}-wide.png`),'3:4':material(`${id}-portrait.png`)}))
  }
  const submission = (id: number | null, options: {state?:string;legacyPath?:string;draft?:boolean;published?:boolean;result?:unknown} = {}) => {
    const result = options.result || {staged:true,targetId:'original-editor',editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',submitted:true,saved:false,published:!!options.published,
      publicationStatus:options.published?'published':'submitted',articleId:'1880027026933416669',
      publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=1880027026933416669'}
    return database.prepare(`INSERT INTO history_social_upload_jobs(source_id,video_id,target,publication_mode,status,result_json,
      payload_json,message,updated_at) VALUES(?,?,'baijiahao-video',?,?,?,?,'原任务待处理','after')`)
      .run(source.id,id,options.draft?'draft':'publish',options.state || 'completed',JSON.stringify(result),
        options.legacyPath?JSON.stringify({videoPath:options.legacyPath}):null).lastInsertRowid
  }
  const motion = (snapshot: unknown, options: {id?:string;status?:string;updatedAt?:string} = {}) => {
    database.exec(`CREATE TABLE IF NOT EXISTS history_motion_productions(
      id TEXT PRIMARY KEY,script_id INTEGER,status TEXT,updated_at TEXT,snapshot TEXT)`)
    database.prepare('INSERT OR REPLACE INTO history_motion_productions VALUES(?,?,?,?,?)')
      .run(options.id || 'motion-original', source.id, options.status || 'selecting', options.updatedAt || 'after', JSON.stringify(snapshot))
  }
  t.after(() => {database.close();fs.rmSync(root,{recursive:true,force:true})})
  return {database,root,source,digest,video,packageVideo,submission,material,motion,
    read:()=>getHistoryProductionState(database,source,{root})}
}

test('motion state keeps original script matching, newest-job order, stored status and fresh progress', t => {
  const h = fixture(t, null)
  h.motion({script:'legacy snapshot text',factory:{scriptHash:h.digest},message:'原任务失败',error:'原错误'},
    {status:'failed',updatedAt:'2026-11-01'})
  h.motion({script:'另一稿件',factory:{scriptHash:hash('另一稿件')},message:'不属于当前稿件'},
    {id:'newer-stale',updatedAt:'2026-11-03'})
  assert.equal(h.read().versions[0]!.state,'attention')
  assert.equal(h.read().versions[0]!.error,'原错误')
  h.motion({script:h.source.rewrittenScript,factory:{scriptHash:'legacy-hash'},status:'failed',message:'正在准备画面 45/87'},
    {id:'newer-current',updatedAt:'2026-11-02'})
  const version = h.read().versions[0]!
  assert.equal(version.state,'producing')
  assert.equal(version.message,'正在准备画面 45/87')
  h.motion({script:h.source.rewrittenScript,message:'准备画面已完成',error:'最新错误'},
    {id:'newer-current',status:'needs_review',updatedAt:'2026-11-04'})
  assert.equal(h.read().versions[0]!.state,'attention')
  assert.equal(h.read().versions[0]!.error,'最新错误')
})

test('motion metadata distinguishes missing fields, explicit null and non-object snapshots', t => {
  const h = fixture(t, null), source = {...h.source,rewrittenScript:null}
  const read = () => getHistoryProductionState(h.database,source,{root:h.root})
  for (const snapshot of [null,[],true,'text',{}, {factory:{}}, {script:'unrelated'}]) {
    h.motion(snapshot)
    assert.deepEqual(read().versions,[],JSON.stringify(snapshot))
  }
  h.database.prepare('UPDATE history_motion_productions SET snapshot=?').run('not valid JSON')
  assert.deepEqual(read().versions,[])
  for (const snapshot of [{script:null},{factory:{scriptHash:null}}]) {
    h.motion(snapshot)
    assert.equal(read().versions[0]!.state,'stale')
  }
  h.motion({script:{text:'not a manuscript string'}})
  assert.deepEqual(getHistoryProductionState(h.database,{...h.source,rewrittenScript:'{"text":"not a manuscript string"}'},{root:h.root}).versions,[])
})

test('published Huasheng identity survives a sibling motion snapshot and its progress changes', t => {
  const h = fixture(t), flower = h.video('huasheng')
  const upload = h.submission(flower.id,{published:true})
  const published = h.read().versions.find(version=>version.producer==='huasheng')!
  for (const message of ['正在准备画面 38/87','正在准备画面 45/87']) {
    h.motion({script:h.source.rewrittenScript,factory:{scriptHash:h.digest},message,
      candidates:{unused:'x'.repeat(128*1024)}})
    const state = h.read()
    assert.deepEqual(state.versions.find(version=>version.producer==='huasheng'),published)
    assert.equal(published.state,'published')
    assert.equal(published.jobId,String(upload))
    assert.equal(published.videoId,flower.id)
    assert.equal(published.canPublish,false)
    assert.equal(state.versions.find(version=>version.producer==='motion')!.message,message)
    assert.equal(state.complete,false)
  }
})

test('unknown legacy publication outcomes retain the original reconciliation identity beside motion metadata', t => {
  const h = fixture(t,'motion_backfill'), video = h.video('motion')
  h.packageVideo(video.id)
  const upload = h.submission(null,{state:'uncertain',legacyPath:path.join(h.root,video.videoUrl.replace('/static/','')),
    result:{saved:false,submitted:false}})
  const original = h.read()
  h.motion({script:h.source.rewrittenScript,message:'新画面进度',plan:{unused:'x'.repeat(128*1024)}})
  assert.deepEqual(h.read(),original)
  const version = original.versions[0]!
  assert.equal(version.state,'uncertain')
  assert.equal(version.jobId,String(upload))
  assert.equal(version.videoId,video.id)
  assert.equal(version.action,'reconcile')
  assert.equal(version.canPublish,false)
})

test('read-only production polling does not parse unused large motion plans in JavaScript', t => {
  const h = fixture(t,null)
  h.motion({script:h.source.rewrittenScript,factory:{scriptHash:h.digest},message:'正在准备画面',
    candidates:{unused:'x'.repeat(1024*1024)},plan:{unused:'y'.repeat(1024*1024)}})
  const parse = JSON.parse, sizes: number[] = []
  t.mock.method(JSON,'parse',(text:string,reviver?:Parameters<typeof JSON.parse>[1])=>{
    sizes.push(Buffer.byteLength(text));return parse(text,reviver)
  })
  h.database.pragma('query_only=ON')
  assert.equal(h.read().versions[0]!.message,'正在准备画面')
  assert.ok(sizes.length>0)
  assert.ok(Math.max(...sizes)<4096,`JavaScript parsed ${Math.max(...sizes)} bytes from a motion snapshot`)
})

test('summary polling retains production identity without reading original motion snapshots', async t => {
  const { ensureHistoryStatusSchema, projectHistoryMotionStatus } = await import('./history-status-storage.js')
  const h = fixture(t, null)
  h.motion({script:h.source.rewrittenScript,factory:{scriptHash:'legacy-hash'},message:'正在准备画面',
    candidates:{unused:'x'.repeat(1024*1024)}})
  const expected = h.read()
  ensureHistoryStatusSchema(h.database)
  projectHistoryMotionStatus(h.database, 'motion-original')
  const triggers = h.database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='history_motion_productions'").all() as Array<{name:string}>
  for (const trigger of triggers) h.database.exec(`DROP TRIGGER "${trigger.name}"`)
  h.database.exec('ALTER TABLE history_motion_productions DROP COLUMN snapshot')
  h.database.pragma('query_only=ON')
  const actual = getHistoryProductionState(h.database, {...h.source,rewrittenScript:null,statusSummary:{
    scriptSha256:h.digest,scriptTextSha256:h.digest,scriptType:'text',artifactState:'current',fresh:true,observedAt:'after',
  }}, {root:h.root,summary:true})
  assert.deepEqual(actual, expected)
})

test('outdated summary observations cannot authorize publication or hide trusted submitted receipts', async t => {
  const { ensureHistoryStatusSchema, projectHistoryMotionStatus } = await import('./history-status-storage.js')
  const h = fixture(t, 'motion_backfill'), video = h.video('motion')
  h.packageVideo(video.id)
  h.motion({script:h.source.rewrittenScript,message:'before'})
  ensureHistoryStatusSchema(h.database)
  projectHistoryMotionStatus(h.database, 'motion-original')
  h.database.prepare("UPDATE history_motion_productions SET snapshot=? WHERE id='motion-original'")
    .run(JSON.stringify({script:h.source.rewrittenScript,message:'after'}))
  const source = {...h.source,rewrittenScript:null,statusSummary:{
    scriptSha256:h.digest,scriptTextSha256:h.digest,scriptType:'text' as const,artifactState:'current' as const,
    fresh:true,observedAt:'before',
  }}
  const pending = getHistoryProductionState(h.database, source, {root:h.root,summary:true})
  assert.equal(pending.versions[0]!.canPublish, false)
  assert.equal(pending.versions[0]!.action, 'none')
  assert.match(pending.versions[0]!.message, /同步/)
  h.submission(video.id)
  assert.equal(getHistoryProductionState(h.database, source, {root:h.root,summary:true}).versions[0]!.state, 'submitted')
})

test('summary manuscript identity preserves missing, null, string and object distinctions', async t => {
  const {ensureHistoryStatusSchema,projectHistoryMotionStatus} = await import('./history-status-storage.js')
  const h = fixture(t, null), source = {...h.source,rewrittenScript:null}
  for (const snapshot of [null,[],true,'text',{}, {factory:{}}, {script:'unrelated'}, {script:null},
    {factory:{scriptHash:null}}, {script:{text:'not a manuscript string'}}]) {
    h.motion(snapshot)
    const expected = getHistoryProductionState(h.database, source, {root:h.root})
    ensureHistoryStatusSchema(h.database)
    projectHistoryMotionStatus(h.database, 'motion-original')
    const actual = getHistoryProductionState(h.database, {...source,statusSummary:{
      scriptSha256:null,scriptTextSha256:null,scriptType:'null',artifactState:'current',fresh:true,observedAt:'after',
    }}, {root:h.root,summary:true})
    assert.deepEqual(actual, expected, JSON.stringify(snapshot))
  }
})

test('summary reduction preserves version-specific packaging, uncertainty and released submission facts', async t => {
  const {ensureHistoryStatusSchema,projectHistoryMotionStatus} = await import('./history-status-storage.js')
  for (const scenario of ['sibling-failure','uncertain-legacy','submitted-cleanup','blocked-revision','ready-revision']) {
    await t.test(scenario, child => {
      const h = fixture(child), flower = h.video('huasheng'), motion = h.video('motion')
      h.packageVideo(flower.id); h.packageVideo(motion.id)
      h.motion({script:h.source.rewrittenScript,message:'latest progress'})
      if (scenario === 'sibling-failure') {
        h.submission(flower.id)
        h.database.prepare("UPDATE history_video_packaging SET cover_status='failed',error='封面失败' WHERE video_id=?").run(motion.id)
      } else if (scenario === 'uncertain-legacy') {
        h.submission(null,{state:'uncertain',legacyPath:path.join(h.root,motion.videoUrl.replace('/static/','')),result:{saved:false}})
      } else if (scenario === 'submitted-cleanup') {
        h.submission(motion.id)
        fs.unlinkSync(path.join(h.root,motion.videoUrl.replace('/static/','')))
      } else {
        h.submission(motion.id,{state:scenario === 'blocked-revision' ? 'uncertain' : 'completed'})
        const revision = recordHistoryVideoDelivery(h.database,{...motion,producerJobId:'revision',
          videoUrl:h.material('revision.mp4'),sha256:hash('revision')})
        h.packageVideo(revision.id)
      }
      const expected = h.read()
      ensureHistoryStatusSchema(h.database)
      projectHistoryMotionStatus(h.database,'motion-original')
      const actual = getHistoryProductionState(h.database,{...h.source,rewrittenScript:null,statusSummary:{
        scriptSha256:h.digest,scriptTextSha256:h.digest,scriptType:'text',artifactState:'current',fresh:true,observedAt:'after',
      }},{root:h.root,summary:true})
      assert.deepEqual(actual, expected)
    })
  }
})

test('coordinator flags and Huasheng assets do not establish local delivery or workflow completion', t => {
  const h = fixture(t)
  h.database.prepare("INSERT INTO history_huasheng_jobs VALUES(1,?,?,'submitted','completed','素材已就绪')").run(h.source.id,h.digest)
  h.database.prepare("INSERT INTO history_huasheng_export_jobs VALUES(1,?,?,'queued','导出已受理',NULL)").run(h.source.id,h.digest)
  const result = h.read()
  assert.equal(result.productionComplete,false)
  assert.equal(result.complete,false)
  assert.equal(result.versions.length,2)
  assert.equal(result.versions[0]!.state,'exporting')
  assert.equal(result.versions[0]!.videoAvailable,false)
})

test('one submitted edition remains submitted while its sibling material failure stays actionable', t => {
  const h = fixture(t), flower = h.video('huasheng'), motion = h.video('motion')
  h.packageVideo(flower.id);h.packageVideo(motion.id)
  h.submission(flower.id)
  h.database.prepare("UPDATE history_video_packaging SET cover_status='failed',error='封面生成失败' WHERE video_id=?").run(motion.id)
  const result = h.read()
  assert.equal(result.productionComplete,true)
  assert.equal(result.complete,false)
  assert.deepEqual(result.versions.map(version=>version.state),['submitted','attention'])
  assert.equal(result.versions[1]!.action,'retry_packaging')
  assert.ok(result.versions.every(version=>!version.canPublish))
  h.submission(motion.id,{published:true})
  assert.equal(h.read().complete,true)
  assert.deepEqual(h.read().versions.map(version=>version.state),['submitted','published'])
})

test('a rebuilt submitted edition stays explicitly publishable without inheriting its original receipt or automatic authorization', t => {
  const h = fixture(t), original = h.video('motion'), sibling = h.video('huasheng')
  h.packageVideo(original.id); h.packageVideo(sibling.id)
  const previousJob = h.submission(original.id)
  const revision = recordHistoryVideoDelivery(h.database, { ...original, producerJobId: 'motion-rebuild',
    videoUrl: h.material('motion-rebuilt.mp4'), sha256: hash('rebuilt motion bytes') })
  h.packageVideo(revision.id)
  const state = h.read(), current = state.versions.find(version => version.producer === 'motion')!
  assert.equal(current.videoId, revision.id)
  assert.equal(current.state, 'ready')
  assert.equal(current.automatic, false)
  assert.equal(current.canPublish, true)
  assert.equal(current.revisionOfVideoId, original.id)
  assert.equal(current.previousJobId, String(previousJob))
  assert.equal(current.confirmedAt, null)
  assert.match(current.message, /修订|再次发表/)
  assert.equal(state.versions.find(version => version.producer === 'huasheng')!.automatic, true)
  assert.equal(state.complete, false)
})

for (const status of ['queued', 'running', 'uncertain', 'failed', 'canceled']) {
  test(`a revision cannot start another publication while its original ${status} attempt is unresolved`, t => {
    const h = fixture(t, 'motion_backfill'), original = h.video('motion')
    const previousJob = h.submission(original.id, { state: status, result: { saved: false, submitted: false } })
    const revision = recordHistoryVideoDelivery(h.database, { ...original, producerJobId: 'motion-rebuild',
      videoUrl: h.material('motion-rebuilt.mp4'), sha256: hash('rebuilt motion bytes') })
    h.packageVideo(revision.id)
    const current = h.read().versions[0]!
    assert.equal(current.videoId, revision.id)
    assert.equal(current.state, 'attention')
    assert.equal(current.stage, 'publication')
    assert.equal(current.canPublish, false)
    assert.equal(current.automatic, false)
    assert.equal(current.previousJobId, String(previousJob))
    assert.equal(current.action, 'none')
    assert.match(current.message, /原成片|原发表/)
  })
}

test('a legacy submission bound to an older render also requires explicit publication of the rebuilt file', t => {
  const h = fixture(t, 'motion_backfill'), original = h.video('motion')
  const previousJob = h.submission(null, { legacyPath: path.join(h.root, original.videoUrl.replace('/static/', '')) })
  const revision = recordHistoryVideoDelivery(h.database, { ...original,
    videoUrl: h.material('motion-rebuilt.mp4'), sha256: hash('rebuilt motion bytes') })
  h.packageVideo(revision.id)
  const current = h.read().versions[0]!
  assert.equal(current.automatic, false)
  assert.equal(current.canPublish, true)
  assert.equal(current.previousJobId, String(previousJob))
})

test('an untouched cancellation and a different manuscript revision do not revoke automatic production', t => {
  const h = fixture(t, 'motion_backfill'), original = h.video('motion', hash('older manuscript'))
  h.submission(original.id)
  const current = h.video('motion')
  const canceled = h.submission(current.id, { state: 'canceled', result: {} })
  h.database.prepare('UPDATE history_social_upload_jobs SET result_json=NULL WHERE id=?').run(canceled)
  const revision = recordHistoryVideoDelivery(h.database, { ...current,
    videoUrl: h.material('motion-rebuilt.mp4'), sha256: hash('rebuilt motion bytes') })
  h.packageVideo(revision.id)
  assert.equal(h.read().versions[0]!.automatic, true)
  assert.equal(h.read().versions[0]!.canPublish, true)
})

test('readiness requires current per-edition titles and real required cover files', t => {
  const h = fixture(t,'motion_backfill'), motion = h.video('motion')
  h.packageVideo(motion.id)
  assert.equal(h.read().versions[0]!.state,'ready')
  assert.equal(h.read().versions[0]!.canPublish,true)
  fs.rmSync(path.join(h.root,`history-deliveries/71/${motion.id}-portrait.png`))
  assert.equal(h.read().versions[0]!.state,'attention')
  assert.equal(h.read().versions[0]!.materialsReady,false)
  h.packageVideo(motion.id)
  h.database.prepare('UPDATE history_video_packaging SET cover_script_sha256=? WHERE video_id=?').run(hash('旧稿'),motion.id)
  assert.equal(h.read().versions[0]!.canPublish,false)
})

test('legacy delivery paths and draft receipts cannot qualify current publication', t => {
  const h = fixture(t,null)
  h.database.prepare('INSERT INTO history_script_deliveries VALUES(?,?,?)').run(h.source.id,h.material('old.mp4'),h.digest)
  h.submission(null,{draft:true,result:{saved:true,published:false}})
  const result = h.read()
  assert.equal(result.versions[0]!.producer,'legacy')
  assert.equal(result.versions[0]!.state,'stale')
  assert.equal(result.versions[0]!.action,'review_legacy')
  assert.equal(result.complete,false)
  assert.equal(result.productionComplete,false)
})

test('legacy publication of the exact current file is reused and uncertain legacy attempts remain reconciliation-only', t => {
  const h = fixture(t,'motion_backfill'), motion = h.video('motion')
  h.packageVideo(motion.id)
  const legacyPath = path.join(h.root,motion.videoUrl.replace('/static/',''))
  const job = h.submission(null,{state:'uncertain',legacyPath,result:{saved:false,published:false}})
  assert.equal(h.read().versions[0]!.state,'uncertain')
  assert.equal(h.read().versions[0]!.action,'reconcile')
  assert.equal(h.read().versions[0]!.jobId,String(job))
  h.submission(null,{legacyPath})
  assert.equal(h.read().versions[0]!.state,'submitted')
  assert.equal(h.read().complete,true)
})

test('a canceled legacy recovery marker remains reconciliation-only even without dispatch or result flags',t=>{
  const h=fixture(t,'motion_backfill'),motion=h.video('motion')
  h.packageVideo(motion.id)
  h.database.exec('ALTER TABLE history_social_upload_jobs ADD COLUMN operation TEXT')
  const job=h.submission(motion.id,{state:'canceled',result:{saved:false}})
  h.database.prepare("UPDATE history_social_upload_jobs SET operation='recover',upload_dispatched=0,result_json=NULL WHERE id=?").run(job)
  assert.equal(h.read().versions[0]!.state,'uncertain')
  assert.equal(h.read().versions[0]!.action,'reconcile')
  assert.equal(h.read().versions[0]!.canPublish,false)
  h.database.prepare('UPDATE history_social_upload_jobs SET operation=NULL WHERE id=?').run(job)
  assert.equal(h.read().versions[0]!.state,'ready')
})

test('publication receipts cannot complete a replacement render or a changed manuscript', t => {
  const h = fixture(t,'motion_backfill'), old = h.video('motion',hash('旧稿'))
  h.submission(old.id)
  const motion = h.video('motion')
  h.packageVideo(motion.id)
  assert.equal(h.read().versions[0]!.state,'ready')
  assert.equal(h.read().complete,false)
  h.database.prepare('INSERT INTO history_video_deliveries(script_id,script_sha256,producer,video_path,video_name,duration,video_sha256,created_at) VALUES(?,?,?,?,?,10,?,?)')
    .run(h.source.id,h.digest,'motion',h.material('replacement.mp4'),'replacement.mp4',hash('replacement'),'later')
  h.submission(motion.id)
  assert.equal(h.read().complete,false,'an older same-producer output does not complete its replacement')
})

test('receipt identity must match a valid Baijiahao article URL and explicit submitted state', () => {
  const result = {staged:true,targetId:'original-editor',editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',submitted:true,saved:false,published:false,publicationStatus:'submitted',articleId:'1880027026933416669',
    publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=1880027026933416669'}
  assert.equal(isHistorySubmissionReceipt(result),true)
  for (const change of [{saved:true},{articleId:'other'},{published:true},{publicationStatus:'saved'}, {staged:false}, {targetId:''},
    {editorUrl:'https://evil.example/editor'},
    {publishedUrl:'https://evil.example/s?id=1880027026933416669'},
    {publishedUrl:'https://baijiahao.baidu.com/s?id=99'},
    {publishedUrl:'https://baijiahao.baidu.com/s?id=1880027026933416669&id=1880027026933416669'}]) {
    assert.equal(isHistorySubmissionReceipt({...result,...change}),false)
  }
})

test('valid submitted receipts survive local cleanup while production availability remains explicit', t => {
  const h = fixture(t,'motion_backfill'), motion = h.video('motion')
  h.submission(motion.id)
  fs.rmSync(path.join(h.root,motion.videoUrl.replace('/static/','')))
  const result = h.read()
  assert.equal(result.complete,true)
  assert.equal(result.productionComplete,true)
  assert.equal(result.versions[0]!.state,'submitted')
  assert.equal(result.versions[0]!.videoAvailable,false)
  assert.equal(result.versions[0]!.producerJobId,'motion')
})

test('missing current output cannot inherit production completion from a draft or a previous render receipt', t => {
  const h = fixture(t,'motion_backfill'), original = h.video('motion')
  h.submission(original.id)
  const replacement = recordHistoryVideoDelivery(h.database, { ...original, producerJobId: 'motion-rebuild',
    videoUrl: h.material('replacement-after-cleanup.mp4'), sha256: hash('replacement bytes') })
  fs.rmSync(path.join(h.root,replacement.videoUrl.replace('/static/','')))
  assert.equal(h.read().productionComplete,false)
  assert.equal(h.read().complete,false)
  h.submission(replacement.id,{draft:true,result:{saved:true,published:false}})
  assert.equal(h.read().productionComplete,false)
  assert.equal(h.read().versions[0]!.state,'attention')
})

test('the read model accepts a query-only connection and never creates missing tables', t => {
  const h = fixture(t,'motion_backfill')
  const motion = h.video('motion');h.packageVideo(motion.id)
  const before = h.database.prepare("SELECT name FROM sqlite_master ORDER BY name").all()
  h.database.pragma('query_only=ON')
  const states = getHistoryProductionStates(h.database,[h.source],{root:h.root})
  assert.equal(states[0]!.versions[0]!.state,'ready')
  assert.deepEqual(h.database.prepare("SELECT name FROM sqlite_master ORDER BY name").all(),before)
})

test('an explicitly blocked publication intent is actionable even after material files become ready', t => {
  const h = fixture(t,'motion_backfill'), motion = h.video('motion')
  h.packageVideo(motion.id)
  h.database.exec('CREATE TABLE history_video_publication_intents(id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,video_id INTEGER,status TEXT,error TEXT)')
  h.database.prepare("INSERT INTO history_video_publication_intents VALUES(1,?,?,?,'needs_attention','原发布准备需要明确继续')")
    .run(h.source.id,h.digest,motion.id)
  assert.equal(h.read().versions[0]!.state,'attention')
  assert.equal(h.read().versions[0]!.action,'retry_packaging')
  assert.equal(h.read().versions[0]!.canPublish,false)
})

test('a waiting-login export points to original login recovery rather than terminal export resume', t => {
  const h = fixture(t)
  h.database.prepare("INSERT INTO history_huasheng_export_jobs VALUES(1,?,?,'waiting_login','等待花生登录',NULL)").run(h.source.id,h.digest)
  const version = h.read().versions[0]!
  assert.equal(version.state,'attention')
  assert.equal(version.stage,'export')
  assert.equal(version.action,'continue_production')
})

test('completed exports without independent delivery or local files require production reconciliation', t => {
  const h = fixture(t)
  h.database.prepare("INSERT INTO history_huasheng_export_jobs VALUES(1,?,?,'completed','导出已完成',NULL)").run(h.source.id,h.digest)
  let version = h.read().versions[0]!
  assert.equal(version.state,'attention')
  assert.equal(version.action,'continue_production')
  assert.match(version.message,/独立交付/)
  const video = h.video('huasheng')
  h.database.exec('ALTER TABLE history_huasheng_export_jobs ADD COLUMN huasheng_job_id INTEGER')
  h.database.prepare("UPDATE history_video_deliveries SET producer_job_id='7' WHERE id=?").run(video.id)
  h.database.prepare('UPDATE history_huasheng_export_jobs SET huasheng_job_id=7').run()
  fs.rmSync(path.join(h.root,video.videoUrl.replace('/static/','')))
  version = h.read().versions[0]!
  assert.equal(version.videoAvailable,false)
  assert.equal(version.action,'continue_production')
  h.database.prepare("UPDATE history_huasheng_export_jobs SET status='failed'").run()
  assert.equal(h.read().versions[0]!.action,'retry_export')
})

test('legacy export material failures stay actionable before independent packaging exists', t => {
  const h = fixture(t), video = h.video('huasheng')
  h.database.exec(`ALTER TABLE history_huasheng_export_jobs ADD COLUMN huasheng_job_id INTEGER;
    ALTER TABLE history_huasheng_export_jobs ADD COLUMN design_status TEXT;
    ALTER TABLE history_huasheng_export_jobs ADD COLUMN cover_status TEXT`)
  h.database.prepare("UPDATE history_video_deliveries SET producer_job_id='163' WHERE id=?").run(video.id)
  h.database.prepare(`INSERT INTO history_huasheng_export_jobs(id,source_id,script_sha256,status,message,error,huasheng_job_id,design_status,cover_status)
    VALUES(1,?,?,'failed','原标题改写未完成','原标题改写未完成',163,'failed','idle')`).run(h.source.id,h.digest)
  const version = h.read().versions[0]!
  assert.equal(version.state,'attention')
  assert.equal(version.stage,'packaging')
  assert.equal(version.action,'retry_packaging')
  assert.equal(version.error,'原标题改写未完成')
  h.packageVideo(video.id)
  assert.equal(h.read().versions[0]!.state,'ready','a repaired independent package supersedes legacy material errors')
})

test('delivered editions without scheduled material work cannot remain non-actionable packaging', t => {
  const h = fixture(t,'motion_backfill'), video = h.video('motion')
  let version = h.read().versions[0]!
  assert.equal(version.state,'attention')
  assert.equal(version.action,'retry_packaging')
  h.database.exec('CREATE TABLE history_video_publication_intents(id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,video_id INTEGER,status TEXT,error TEXT)')
  h.database.prepare("INSERT INTO history_video_publication_intents VALUES(1,?,?,?,'pending',NULL)").run(h.source.id,h.digest,video.id)
  version = h.read().versions[0]!
  assert.equal(version.state,'packaging')
  assert.equal(version.action,'none')
})
