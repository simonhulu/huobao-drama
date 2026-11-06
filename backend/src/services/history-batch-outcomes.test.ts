import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureHistoryDualProductionSchema, ensureHistoryVideoDeliveriesSchema, recordHistoryVideoDelivery } from './history-video-deliveries.js'
import { getHistoryBatchOutcomes } from './history-batch-outcomes.js'
import { createHistoryBatchOutcomesRoute } from '../routes/history-batch-outcomes.js'
import { redactHistoryJobMessage } from './history-job-message.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture(t: TestContext) {
  const database = new Database(':memory:')
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-batch-outcomes-')))
  database.exec(`CREATE TABLE creation_tasks(id INTEGER PRIMARY KEY,type TEXT);
    CREATE TABLE creation_task_events(id INTEGER PRIMARY KEY,task_id INTEGER,event_type TEXT,data_json TEXT,created_at TEXT);
    CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,status TEXT,platform TEXT,source_video_id TEXT,
      source_url TEXT,raw_transcript TEXT,corrected_transcript TEXT,rewritten_script TEXT,media_json TEXT,asr_json TEXT,
      review_json TEXT,last_error TEXT,deleted_at TEXT,updated_at TEXT);
    CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,video_id INTEGER,target TEXT,
      publication_mode TEXT,status TEXT,result_json TEXT,payload_json TEXT,updated_at TEXT);
    CREATE TABLE storage_artifacts(path TEXT PRIMARY KEY,state TEXT,sha256 TEXT,review_json TEXT);
    INSERT INTO creation_tasks VALUES(40332,'history.source');`)
  ensureHistoryDualProductionSchema(database)
  ensureHistoryVideoDeliveriesSchema(database)
  const event = (id: number, stage: string, completed = 0, message = stage) => database.prepare(`INSERT INTO creation_task_events
    (task_id,event_type,data_json,created_at) VALUES(40332,'history.progress',?,'2026-11-02T00:10:00Z')`)
    .run(JSON.stringify({currentSourceId:id,stage,message,currentTitle:`Source ${id}`,counts:{completed},sourceIds:[id]}))
  const source = (id: number, complete = true) => {
    const raw = `Original ${id}`, corrected = `Corrected ${id}`, script = complete ? `Narration ${id}` : null
    database.prepare('INSERT INTO history_script_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,`Source ${id}`,'needs_review',
      'baijiahao',String(id),`https://baijiahao.baidu.com/s?id=${id}`,raw,corrected,script,
      JSON.stringify({kind:'article',articleId:String(id),sourceUrl:`https://baijiahao.baidu.com/s?id=${id}`,textSha256:hash(raw)}),null,
      JSON.stringify({factCheckStatus:'needs_sources',rawTranscriptSha256:hash(raw),correctedTranscriptSha256:hash(corrected),rewriteInputSha256:hash(corrected)}),null,null,'2026-11-02T00:00:00Z')
    return script
  }
  const published = (id: number, producer: 'huasheng' | 'motion', submitted = false) => {
    const script = `Narration ${id}`, scriptHash = hash(script)
    database.prepare(`INSERT OR IGNORE INTO history_dual_production(source_id,script_sha256,huasheng_job_id,created_at,updated_at)
      VALUES(?,?,1,'before','before')`).run(id,scriptHash)
    const relative = `history-deliveries/${id}/${producer}.mp4`, filename = path.join(root,relative)
    fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,'fixture')
    const video = recordHistoryVideoDelivery(database,{scriptId:id,scriptSha256:scriptHash,producer,producerJobId:`${producer}-${id}`,
      videoUrl:`/static/${relative}`,videoName:`${producer}.mp4`,duration:10,sha256:hash('fixture')})
    const result = {staged:true,saved:false,submitted:true,published:!submitted,publicationStatus:submitted?'submitted':'published',
      targetId:`target-${video.id}`,editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',articleId:String(1880000+video.id),
      publishedUrl:`https://baijiahao.baidu.com/builder/preview/s?id=${1880000+video.id}`}
    database.prepare(`INSERT INTO history_social_upload_jobs(source_id,video_id,target,publication_mode,status,result_json,updated_at)
      VALUES(?,?,'baijiahao-video','publish','completed',?,'2026-11-02T01:00:00Z')`).run(id,video.id,JSON.stringify(result))
    return {video,filename}
  }
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true})})
  return {database,root,event,source,published,read:(options = {})=>getHistoryBatchOutcomes(database,40332,{root,...options})!}
}

test('batch outcomes distinguish historical completion and recovered sources without changing collection history', t=>{
  const h = fixture(t)
  for (const id of [898,899,900,901]) h.source(id)
  h.event(898,'source_failed',0,'Invalid quotation');h.event(899,'source_failed',0,'HTTP 429')
  h.event(900,'storing',1);h.event(901,'storing',2)
  for (const id of [898,899,900,901]) {h.published(id,'huasheng');h.published(id,'motion')}
  const before = h.database.prepare('SELECT total_changes() AS value').get()
  const result = h.read()
  assert.equal(result.total,4)
  assert.deepEqual(result.items.filter(item=>item.collectedInBatch).map(item=>item.sourceId),[900,901])
  assert.deepEqual(result.items.filter(item=>item.recovered).map(item=>item.sourceId),[898,899])
  assert.equal(result.summary.publishedVideos,8)
  assert.equal(result.summary.draftsReady,4)
  assert.ok(result.items.every(item=>item.reviewStatus==='needs_review' && item.productionComplete))
  assert.deepEqual(h.database.prepare('SELECT total_changes() AS value').get(),before)
})

test('outcomes retain sources older than the latest 100 snapshot entries and paginate deterministically', t=>{
  const h = fixture(t)
  for (let id=1;id<=108;id++) {h.source(id);h.event(id,'selecting')}
  const first = h.read({limit:100}), last = h.read({offset:100,limit:100})
  assert.equal(first.total,108);assert.equal(first.items.length,100)
  assert.equal(last.items[0]!.sourceId,101);assert.equal(last.items.length,8)
  assert.throws(()=>h.read({limit:1000}),/pagination/i)
  assert.equal(getHistoryBatchOutcomes(h.database,999),null)
})

test('a submitted receipt is distinct from publication and old-script outputs do not complete a revision', t=>{
  const h=fixture(t);h.source(900);h.event(900,'storing',1)
  h.published(900,'huasheng',true);h.published(900,'motion')
  assert.equal(h.read().summary.submittedVideos,2)
  assert.equal(h.read().summary.publishedVideos,1)
  h.database.prepare("UPDATE history_script_sources SET rewritten_script='Revised narration' WHERE id=900").run()
  assert.equal(h.read().summary.publishedVideos,0)
})

test('released local media stays produced and requires matching release evidence to display reclaimed', t=>{
  const h=fixture(t);h.source(900);h.event(900,'storing',1)
  const {video,filename}=h.published(900,'motion')
  fs.unlinkSync(filename)
  const evidence = {status:'released',evidence:{videoId:video.id,scriptSha256:video.scriptSha256,producer:'motion'}}
  h.database.prepare('INSERT INTO storage_artifacts VALUES(?,?,?,?)').run(filename,'released',video.sha256,JSON.stringify(evidence))
  let version=h.read().items[0]!.versions.find(item=>item.producer==='motion')!
  assert.equal(version.state,'published');assert.equal(version.localMedia,'released')
  evidence.evidence.videoId++
  h.database.prepare('UPDATE storage_artifacts SET review_json=?').run(JSON.stringify(evidence))
  version=h.read().items[0]!.versions.find(item=>item.producer==='motion')!
  assert.equal(version.localMedia,'missing')
})

test('deleted or missing sources remain visible without reporting their previous publications as current', t=>{
  const h=fixture(t);h.source(900);h.event(900,'selecting');h.event(901,'selecting');h.published(900,'motion')
  h.database.prepare("UPDATE history_script_sources SET deleted_at='after' WHERE id=900").run()
  const result=h.read()
  assert.equal(result.items.length,2)
  assert.ok(result.items.every(item=>item.deleted))
  assert.equal(result.summary.publishedVideos,0)
})

test('the independent outcome route exposes only reads and redacts history errors',async t=>{
  const h=fixture(t);h.source(900);h.event(900,'source_failed',0,'private-api-key at https://example.test/private')
  h.database.prepare('UPDATE history_script_sources SET last_error=?').run('Bearer private-api-key /Users/private/location')
  const route=createHistoryBatchOutcomesRoute(h.database,value=>redactHistoryJobMessage(value,['private-api-key']))
  const before=h.database.prepare('SELECT total_changes() AS value').get()
  const response=await route.request('/40332/outcomes')
  assert.equal(response.status,200)
  assert.equal(response.headers.get('Cache-Control'),'no-store')
  assert.doesNotMatch(await response.text(),/private-api-key|example.test|\/Users\/private/)
  for(const pathname of ['/40332/resume','/40332/stop','/40332/outcomes']) {
    assert.equal((await route.request(pathname,{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}})).status,404)
  }
  assert.equal((await route.request('/40332/outcomes?limit=9007199254740992')).status,400)
  assert.deepEqual(h.database.prepare('SELECT total_changes() AS value').get(),before)
})
