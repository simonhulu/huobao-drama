import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createPublishedMediaInputCache, createPublishedMediaInputInspector, discoverPublishedMedia, ensurePublishedMediaInputIndexes } from './storage-published-media.js'
import { discoverImmutableCopies } from './storage-immutable-copies.js'

const root = '/workspace/huobao-drama'
const now = Date.parse('2026-11-01T00:00:00Z')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const publishedAt = '2026-10-01T00:00:00Z'

function fixture(t: TestContext) {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY, rewritten_script TEXT, deleted_at TEXT, status TEXT);
    CREATE TABLE history_video_deliveries(id INTEGER PRIMARY KEY,script_id INTEGER,script_sha256 TEXT,producer TEXT,video_path TEXT,video_sha256 TEXT);
    CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,video_id INTEGER,target TEXT,publication_mode TEXT,
      status TEXT,payload_json TEXT,result_json TEXT,fingerprint TEXT,updated_at TEXT,video_producer TEXT);`)
  const filename = path.join(root, 'data/static/history-deliveries/17/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4')
  database.prepare('INSERT INTO history_script_sources VALUES(17,?,NULL,?)').run('current script', 'recreated')
  database.prepare('INSERT INTO history_video_deliveries VALUES(5,17,?,?,?,?)')
    .run(hash('current script'), 'motion', '/static/history-deliveries/17/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4', hash('movie'))
  const payload = {jobId:'1',scriptId:17,target:'baijiahao-video',publicationMode:'publish',videoPath:filename,fingerprint:hash('upload'),accountName:'history_baijiahao'}
  const receipt = {staged:true,targetId:'original-editor',editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',submitted:true,
    saved:false,published:true,publicationStatus:'published',articleId:'1880027026933416669',
    publishedUrl:'https://baijiahao.baidu.com/s?id=1880027026933416669',accountName:'history_baijiahao'}
  database.prepare('INSERT INTO history_social_upload_jobs VALUES(1,17,5,?,?,?,?,?,?,?,?)')
    .run('baijiahao-video','publish','completed',JSON.stringify(payload),JSON.stringify(receipt),hash('upload'),publishedAt,'motion')
  t.after(() => database.close())
  return {database,filename,payload,receipt,read: (retentionDays?: number) => discoverPublishedMedia(database,root,now,retentionDays)}
}

test('only the exact current history movie with an aged publication receipt can be reclaimed', t => {
  const f = fixture(t)
  const candidates = f.read()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]!.path, f.filename)
  assert.equal(candidates[0]!.sha256, hash('movie'))
  assert.equal(candidates[0]!.sourceId, 17)
  assert.equal(candidates[0]!.ownerType, 'history-source')
  assert.equal(candidates[0]!.ownerId, '17')
  assert.equal(candidates[0]!.role, 'final')
  assert.equal(candidates[0]!.evidence.receipts[0].articleId, f.receipt.articleId)
})

test('submitted videos, cloud drafts, completed flags, and manual upload marks retain the movie', t => {
  const f = fixture(t)
  for (const result of [
    {...f.receipt,published:false,publicationStatus:'submitted'},
    {...f.receipt,saved:true,published:false,submitted:false,publicationStatus:undefined},
    {saved:true},
    null,
  ]) {
    f.database.prepare('UPDATE history_social_upload_jobs SET result_json=?').run(JSON.stringify(result))
    assert.deepEqual(f.read(), [])
  }
  f.database.exec(`DELETE FROM history_social_upload_jobs;
    CREATE TABLE history_social_upload_confirmations(source_id INTEGER,target TEXT,confirmed_at TEXT);
    INSERT INTO history_social_upload_confirmations VALUES(17,'baijiahao-video','2026-10-01');`)
  assert.deepEqual(f.read(), [])
})

test('the newest request and every observed video target must be settled', t => {
  const f = fixture(t)
  f.database.exec('INSERT INTO history_social_upload_jobs SELECT 2,source_id,video_id,target,publication_mode,\'queued\',payload_json,NULL,fingerprint,updated_at,video_producer FROM history_social_upload_jobs')
  assert.deepEqual(f.read(), [])
  f.database.exec('DELETE FROM history_social_upload_jobs WHERE id=2')
  f.database.prepare('INSERT INTO history_social_upload_jobs SELECT 2,source_id,video_id,\'tencent-video\',\'draft\',\'completed\',?, ?,fingerprint,updated_at,video_producer FROM history_social_upload_jobs')
    .run(JSON.stringify({...f.payload,jobId:'2',target:'tencent-video',publicationMode:'draft'}),JSON.stringify({staged:true,saved:true,published:false}))
  assert.deepEqual(f.read(), [])
})

test('uncertain, active, failed, and canceled publication attempts cannot be reclaimed', t => {
  const f = fixture(t)
  for (const status of ['queued','running','awaiting_confirmation','uncertain','failed','blocked','canceled']) {
    f.database.prepare('UPDATE history_social_upload_jobs SET status=?').run(status)
    assert.deepEqual(f.read(), [])
  }
})

test('source revisions and replacement deliveries retain old files while tombstones preserve published ownership', t => {
  const f = fixture(t)
  f.database.prepare('UPDATE history_script_sources SET rewritten_script=?').run('new script')
  assert.deepEqual(f.read(), [])
  f.database.prepare('UPDATE history_script_sources SET rewritten_script=?,deleted_at=?').run('current script',publishedAt)
  assert.equal(f.read().length,1)
  f.database.exec('UPDATE history_script_sources SET deleted_at=NULL')
  f.database.exec('INSERT INTO history_video_deliveries SELECT 6,script_id,script_sha256,producer,video_path,video_sha256 FROM history_video_deliveries')
  assert.deepEqual(f.read(), [])
})

test('paths, upload identities, and SHA evidence must match the exact generated file', t => {
  const f = fixture(t)
  for (const payload of [
    {...f.payload,videoPath:path.join(root,'data/static/remotion/project-4/input.mp4')},
    {...f.payload,scriptId:18},
    {...f.payload,fingerprint:hash('different upload')},
    {...f.payload,accountName:'other_account'},
    {...f.payload,jobId:'other-job'},
  ]) {
    f.database.prepare('UPDATE history_social_upload_jobs SET payload_json=?').run(JSON.stringify(payload))
    assert.deepEqual(f.read(), [])
  }
  f.database.prepare('UPDATE history_social_upload_jobs SET payload_json=?').run(JSON.stringify(f.payload))
  for (const url of ['/static/history-deliveries/17/../18/original.mp4','/static/history-deliveries/17/source.mp4','/static/history-deliveries/17/file.mp4?query=1']) {
    f.database.prepare('UPDATE history_video_deliveries SET video_path=?').run(url)
    assert.deepEqual(f.read(), [])
  }
})

test('retention uses each receipt time and refuses invalid or future timestamps', t => {
  const f = fixture(t)
  assert.deepEqual(f.read(60), [])
  for (const timestamp of ['invalid', '2026-10-31T00:00:00Z', '2026-11-02T00:00:00Z']) {
    f.database.prepare('UPDATE history_social_upload_jobs SET updated_at=?').run(timestamp)
    assert.deepEqual(f.read(7), [])
  }
  assert.deepEqual(f.read(-1), [])
})

test('zero retention releases a freshly published movie but keeps submissions and future receipts', t => {
  const f = fixture(t)
  f.database.prepare('UPDATE history_social_upload_jobs SET updated_at=?').run(new Date(now).toISOString())
  assert.equal(f.read().length,1)
  assert.equal(f.read(0).length,1)
  assert.deepEqual(f.read(1),[])
  f.database.prepare('UPDATE history_social_upload_jobs SET result_json=?')
    .run(JSON.stringify({...f.receipt,published:false,publicationStatus:'submitted'}))
  assert.deepEqual(f.read(0),[])
  f.database.prepare('UPDATE history_social_upload_jobs SET result_json=?,updated_at=?')
    .run(JSON.stringify(f.receipt),new Date(now+1).toISOString())
  assert.deepEqual(f.read(0),[])
})

test('a publication authorizes only the exact motion job output with the same movie hash', t => {
  const f = fixture(t),jobId='11111111-1111-1111-1111-111111111111',otherId='22222222-2222-2222-2222-222222222222'
  f.database.exec(`ALTER TABLE history_video_deliveries ADD COLUMN producer_job_id TEXT;
    CREATE TABLE history_motion_productions(id TEXT,script_id INTEGER,status TEXT,snapshot TEXT);`)
  f.database.prepare('UPDATE history_video_deliveries SET producer_job_id=?').run(jobId)
  const output=(id:string)=>path.join(root,'data/storage/history-motion',id,'render-123/movie.mp4')
  const snapshot=(id:string,sha=hash('movie'))=>({id,scriptId:17,status:'completed',stage:'rendered',outputPath:output(id),plan:{delivery:{sha256:sha,qa:{technical:'passed'}}}})
  for(const id of [jobId,otherId]) f.database.prepare('INSERT INTO history_motion_productions VALUES(?,17,?,?)')
    .run(id,'completed',JSON.stringify(snapshot(id)))
  assert.deepEqual(f.read().map(item=>item.path).sort(),[f.filename,output(jobId)].sort())
  assert.equal(f.read().find(item=>item.path===output(jobId))!.evidence.videoId,5)
  f.database.prepare('UPDATE history_motion_productions SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot(jobId,hash('replacement'))),jobId)
  assert.deepEqual(f.read().map(item=>item.path),[f.filename])
  f.database.prepare('UPDATE history_motion_productions SET script_id=18,snapshot=? WHERE id=?')
    .run(JSON.stringify({...snapshot(jobId),scriptId:18}),jobId)
  assert.deepEqual(f.read().map(item=>item.path),[f.filename])
})

function factoryPublicationFixture(t:TestContext) {
  const f=fixture(t),jobId='11111111-1111-1111-1111-111111111111',sha=hash('movie'),scriptSha=hash('current script')
  const original=path.join(root,'data/storage/history-motion',jobId,'render-123/movie.mp4')
  const rendered=path.join(root,'data/static/remotion',`history-${jobId}-${sha.slice(0,12)}.mp4`)
  const factory={sourceId:17,episodeId:23,projectId:29,scriptHash:scriptSha}
  const snapshot={id:jobId,scriptId:17,script:'current script',status:'completed',stage:'rendered',outputPath:original,
    factory,plan:{delivery:{sha256:sha,qa:{technical:'passed'}}}}
  f.database.exec(`ALTER TABLE history_video_deliveries ADD COLUMN producer_job_id TEXT;
    CREATE TABLE history_motion_productions(id TEXT,script_id INTEGER,status TEXT,snapshot TEXT);
    CREATE TABLE remotion_renders(project_id INTEGER,render_kind TEXT,status TEXT,input_hash TEXT,output_path TEXT,props_json TEXT);
    CREATE TABLE remotion_projects(id INTEGER,source_type TEXT,source_episode_id INTEGER,metadata_json TEXT);
    CREATE TABLE episodes(id INTEGER,metadata TEXT);`)
  f.database.prepare('UPDATE history_video_deliveries SET producer_job_id=?').run(jobId)
  f.database.prepare("INSERT INTO history_motion_productions VALUES(?,17,'completed',?)").run(jobId,JSON.stringify(snapshot))
  f.database.prepare("INSERT INTO remotion_renders VALUES(29,'episode','succeeded',?,?,?)").run(sha,rendered,JSON.stringify({jobId}))
  f.database.prepare("INSERT INTO remotion_projects VALUES(29,'episode',23,?)")
    .run(JSON.stringify({factory:'remotion-history-factory',jobId,scriptHash:scriptSha}))
  f.database.prepare('INSERT INTO episodes VALUES(23,?)').run(JSON.stringify({historyFactory:{...factory,jobId}}))
  return {...f,jobId,original,rendered,snapshot,sha,scriptSha,factory}
}

test('a published motion movie includes the factory copy only with matching render, project and episode bindings',t=>{
  const f=factoryPublicationFixture(t)
  assert.ok(discoverImmutableCopies(f.database,root).some(copy=>copy.path===f.rendered), 'immutable discovery must identify the remotion copy')
  assert.deepEqual(f.read().map(item=>item.path).sort(),[f.filename,f.original,f.rendered].sort())
  assert.equal(f.read().find(item=>item.path===f.rendered)!.evidence.videoId,5)
  assert.equal(f.read().find(item=>item.path===f.rendered)!.sha256,hash('movie'))
})

test('a remotion copy stays protected when its project, episode, render kind, or SHA binding changes',t=>{
  const f=factoryPublicationFixture(t)
  const expected=[f.filename,f.original].sort()
  for(const mutate of [
    ()=>f.database.prepare('UPDATE remotion_projects SET metadata_json=?').run(JSON.stringify({factory:'remotion-history-factory',jobId:f.jobId,scriptHash:hash('other script')})),
    ()=>f.database.prepare('UPDATE remotion_projects SET source_episode_id=24').run(),
    ()=>f.database.prepare('UPDATE episodes SET metadata=?').run(JSON.stringify({historyFactory:{...f.factory,jobId:f.jobId,sourceId:18}})),
    ()=>f.database.prepare('UPDATE episodes SET metadata=?').run(JSON.stringify({historyFactory:{...f.factory,jobId:f.jobId,projectId:30}})),
    ()=>f.database.prepare('UPDATE remotion_renders SET project_id=30').run(),
    ()=>f.database.prepare("UPDATE remotion_renders SET render_kind='preview'").run(),
    ()=>f.database.prepare('UPDATE remotion_renders SET input_hash=?').run(hash('other movie')),
  ]) {
    assert.equal(f.read().length,3)
    mutate();assert.deepEqual(f.read().map(item=>item.path).sort(),expected)
    f.database.prepare('UPDATE remotion_projects SET source_episode_id=23,metadata_json=?').run(JSON.stringify({factory:'remotion-history-factory',jobId:f.jobId,scriptHash:f.scriptSha}))
    f.database.prepare('UPDATE episodes SET metadata=?').run(JSON.stringify({historyFactory:{...f.factory,jobId:f.jobId}}))
    f.database.prepare("UPDATE remotion_renders SET project_id=29,render_kind='episode',input_hash=?").run(f.sha)
  }
})

test('the factory copy requires the exact render job, canonical filename and snapshot script',t=>{
  const f=factoryPublicationFixture(t),expected=[f.filename,f.original].sort()
  for (const mutate of [
    ()=>f.database.prepare('UPDATE remotion_renders SET props_json=?').run(JSON.stringify({jobId:'22222222-2222-2222-2222-222222222222'})),
    ()=>f.database.prepare('UPDATE remotion_renders SET output_path=?').run(f.rendered.replace(f.jobId,'22222222-2222-2222-2222-222222222222')),
    ()=>f.database.prepare('UPDATE history_motion_productions SET snapshot=?').run(JSON.stringify({...f.snapshot,script:'other script'})),
  ]) {
    assert.equal(f.read().length,3)
    mutate();assert.deepEqual(f.read().map(item=>item.path).sort(),expected)
    f.database.prepare('UPDATE remotion_renders SET props_json=?,output_path=?').run(JSON.stringify({jobId:f.jobId}),f.rendered)
    f.database.prepare('UPDATE history_motion_productions SET snapshot=?').run(JSON.stringify(f.snapshot))
  }
})

test('an older factory schema retains the third copy without suppressing verified delivery and original',t=>{
  const f=factoryPublicationFixture(t)
  f.database.exec('ALTER TABLE remotion_renders DROP COLUMN props_json')
  assert.deepEqual(f.read().map(item=>item.path).sort(),[f.filename,f.original].sort())
})

test('publication discovery does not load unrelated producer snapshots or unneeded large columns',t=>{
  const f=factoryPublicationFixture(t),queries:string[]=[]
  f.database.exec('ALTER TABLE history_script_sources ADD COLUMN asr_json TEXT')
  f.database.prepare('UPDATE history_script_sources SET asr_json=?').run(JSON.stringify({unused:'x'.repeat(8*1024*1024)}))
  f.database.prepare("INSERT INTO history_motion_productions VALUES('unrelated',99,'completed',?)")
    .run(JSON.stringify({unused:'x'.repeat(16*1024*1024)}))
  const prepare=f.database.prepare.bind(f.database)
  f.database.prepare=((sql:string)=>{queries.push(sql);return prepare(sql)}) as typeof f.database.prepare
  assert.deepEqual(f.read().map(item=>item.path).sort(),[f.filename,f.original,f.rendered].sort())
  assert.equal(queries.some(sql=>/SELECT\s+\*\s+FROM\s+(history_motion_productions|history_script_sources)/i.test(sql)),false)
  assert.equal(queries.some(sql=>/SELECT[^;]*\bsnapshot\b[^;]*FROM history_motion_productions(?![^;]*WHERE)/i.test(sql)),false)
})

test('cached input verification ignores unrelated heartbeats but detects same-length changed JSON and new rows',t=>{
  const f=fixture(t)
  f.database.exec("CREATE TABLE creation_tasks(id TEXT,payload_json TEXT,heartbeat INTEGER); INSERT INTO creation_tasks VALUES('task','{\"video\":\"none\"}',0)")
  const inspect=createPublishedMediaInputInspector(f.database,root,f.read()[0]!)
  assert.deepEqual(inspect(),[])
  f.database.exec('UPDATE creation_tasks SET heartbeat=heartbeat+1')
  assert.deepEqual(inspect(false),[])
  f.database.exec("UPDATE creation_tasks SET payload_json='{\"video\":\"next\"}'")
  assert.match(inspect(false).join(','),/creation_tasks.*输入记录已变化/)
  assert.deepEqual(inspect(),[])
  f.database.prepare('INSERT INTO creation_tasks VALUES(?,?,0)').run('new',JSON.stringify({video:f.filename}))
  assert.match(inspect(false).join(','),/creation_tasks.*输入记录已变化/)
  assert.deepEqual(inspect(),['creation-task:new'])
})

for(const indexed of [false,true])test(`plain-path filtering protects percent-escaped references and new consumers (indexed: ${indexed})`,t=>{
  const f=fixture(t)
  f.database.exec('CREATE TABLE huasheng_material_recommendations(project_id INTEGER,file_path TEXT)')
  if(indexed){assert.equal(ensurePublishedMediaInputIndexes(f.database).length,1);assert.deepEqual(ensurePublishedMediaInputIndexes(f.database),[])}
  const encoded=f.filename.replace(path.join(root,'data'),'http://127.0.0.1:5678').replace('aaaaaaaa','%61aaaaaaa')
  const inspect=createPublishedMediaInputInspector(f.database,root,f.read()[0]!)
  assert.deepEqual(inspect(),[])
  f.database.prepare('INSERT INTO huasheng_material_recommendations VALUES(42,?)').run(encoded)
  assert.match(inspect(false).join(','),/huasheng_material_recommendations.*输入记录已变化/)
  assert.deepEqual(inspect(),['huasheng-project:42']);assert.deepEqual(inspect(false),['huasheng-project:42'])
})

test('input verification detects replacement row identities even when row count stays unchanged',t=>{
  const f=fixture(t)
  f.database.exec("CREATE TABLE creation_tasks(id TEXT,payload_json TEXT); INSERT INTO creation_tasks(rowid,id,payload_json) VALUES(1,'old','{}')")
  const inspect=createPublishedMediaInputInspector(f.database,root,f.read()[0]!)
  assert.deepEqual(inspect(),[])
  f.database.exec('DELETE FROM creation_tasks')
  f.database.prepare('INSERT INTO creation_tasks(rowid,id,payload_json) VALUES(99,?,?)').run('new',JSON.stringify({video:f.filename}))
  assert.match(inspect(false).join(','),/creation_tasks.*输入记录已变化/)
  assert.deepEqual(inspect(),['creation-task:new'])
})

test('shared parse caches keep copy-specific references and refresh changed JSON bytes',t=>{
  const f=factoryPublicationFixture(t),candidates=f.read(),cache=createPublishedMediaInputCache()
  f.database.exec('CREATE TABLE creation_tasks(id TEXT,payload_json TEXT)')
  f.database.prepare('INSERT INTO creation_tasks VALUES(?,?)').run('consumer',JSON.stringify({video:f.original}))
  const delivery=createPublishedMediaInputInspector(f.database,root,candidates.find(row=>row.path===f.filename)!,cache)
  const original=createPublishedMediaInputInspector(f.database,root,candidates.find(row=>row.path===f.original)!,cache)
  assert.deepEqual(delivery(),[])
  assert.deepEqual(original(),['creation-task:consumer'])
  f.database.prepare('UPDATE creation_tasks SET payload_json=?').run(JSON.stringify({video:f.rendered}))
  const rendered=createPublishedMediaInputInspector(f.database,root,candidates.find(row=>row.path===f.rendered)!,cache)
  assert.deepEqual(rendered(),['creation-task:consumer'])
  assert.deepEqual(original(),[])
  assert.deepEqual(delivery(),[])
  assert.deepEqual(rendered(false),['creation-task:consumer'])
})

test('a publication includes only its exact Huasheng export and keeps unrelated project media', t => {
  const f = fixture(t),projectHash=hash('huasheng project')
  f.database.exec(`ALTER TABLE history_video_deliveries ADD COLUMN producer_job_id TEXT;
    UPDATE history_video_deliveries SET producer='huasheng',producer_job_id='71';
    UPDATE history_social_upload_jobs SET video_producer='huasheng';
    CREATE TABLE history_huasheng_export_jobs(id INTEGER,huasheng_job_id INTEGER,source_id INTEGER,script_sha256 TEXT,status TEXT,project_url TEXT,project_hash TEXT,file_path TEXT);`)
  const output=(id:number)=>path.join(root,'data/huasheng-exports',String(id),`video_${projectHash}.mp4`)
  for(const [id,jobId,projectId] of [[1,71,900],[2,72,901]]) f.database.prepare('INSERT INTO history_huasheng_export_jobs VALUES(?,?,17,?,?,?,?,?)')
    .run(id,jobId,hash('current script'),'completed',`https://www.huasheng.cn/video/${projectId}`,projectHash,output(projectId))
  assert.deepEqual(f.read().map(item=>item.path).sort(),[f.filename,output(900)].sort())
  f.database.prepare('UPDATE history_huasheng_export_jobs SET script_sha256=? WHERE id=1').run(hash('old script'))
  assert.deepEqual(f.read().map(item=>item.path),[f.filename])
  f.database.prepare('UPDATE history_huasheng_export_jobs SET script_sha256=?,file_path=? WHERE id=1')
    .run(hash('current script'),path.join(root,'data/huasheng-exports/900/source.mp4'))
  assert.deepEqual(f.read().map(item=>item.path),[f.filename])
})

test('running production or an article request keeps the current movie', t => {
  const f = fixture(t)
  f.database.exec(`CREATE TABLE history_motion_productions(script_id INTEGER,status TEXT);
    INSERT INTO history_motion_productions VALUES(17,'rendering');`)
  assert.deepEqual(f.read(), [])
  f.database.exec('DELETE FROM history_motion_productions')
  f.database.exec('INSERT INTO history_social_upload_jobs SELECT 2,source_id,NULL,\'baijiahao-article\',\'draft\',\'queued\',NULL,NULL,fingerprint,updated_at,video_producer FROM history_social_upload_jobs')
  assert.deepEqual(f.read(), [])
})

test('legacy upload schemas and unrelated Remotion draft success records authorize no deletion', t => {
  const database = new Database(':memory:')
  t.after(() => database.close())
  database.exec(`CREATE TABLE episode_publish_records(episode_id INTEGER,status TEXT,draft_url TEXT);
    INSERT INTO episode_publish_records VALUES(17,'success','https://channels.weixin.qq.com/platform/post/list');`)
  assert.deepEqual(discoverPublishedMedia(database,root,now), [])
})
