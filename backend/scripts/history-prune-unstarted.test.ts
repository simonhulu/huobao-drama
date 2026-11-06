import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {planUnstartedPrune, pruneUnstartedRecords} from './history-prune-unstarted.js'

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-unstarted-')))
  const db = new Database(':memory:')
  t.after(() => { db.close(); fs.rmSync(root, {recursive: true, force: true}) })
  db.exec(`
    CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,review_json TEXT,deleted_at TEXT,updated_at TEXT);
    CREATE TABLE history_huasheng_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,status TEXT,stage TEXT,
      checkpoint TEXT,owner TEXT,project_url TEXT,video_url TEXT,production_status TEXT,cancel_requested INTEGER,
      manual_requested INTEGER,message TEXT,updated_at TEXT);
    CREATE TABLE history_dual_production(source_id INTEGER,script_sha256 TEXT,huasheng_job_id INTEGER,
      motion_job_id TEXT,episode_id INTEGER,huasheng_state TEXT,motion_state TEXT,production_mode TEXT,updated_at TEXT);
    CREATE TABLE history_motion_productions(id TEXT PRIMARY KEY,script_id INTEGER,status TEXT,snapshot TEXT);
    CREATE TABLE episodes(id INTEGER PRIMARY KEY,metadata TEXT,pre_tts_audio_url TEXT,video_url TEXT,updated_at TEXT);
    CREATE TABLE history_huasheng_export_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,huasheng_job_id INTEGER);
    CREATE TABLE history_video_deliveries(id INTEGER PRIMARY KEY,script_id INTEGER,producer TEXT,producer_job_id TEXT);
    CREATE TABLE history_video_publication_intents(id INTEGER PRIMARY KEY,source_id INTEGER);
    CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,video_producer TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY,video_path TEXT);
    CREATE TABLE history_production_reservations(source_id INTEGER);
    CREATE TABLE creation_tasks(id INTEGER PRIMARY KEY,type TEXT,status TEXT,scope_id INTEGER,payload_json TEXT);
    CREATE TABLE remotion_renders(id INTEGER PRIMARY KEY,project_id INTEGER);
    CREATE TABLE remotion_assets(id INTEGER PRIMARY KEY,project_id INTEGER);
  `)
  for (const [id, hid, status] of [[11,132,'failed'],[17,147,'completed'],[19,158,'queued']] as const) {
    const factory = {sourceId:id,episodeId:1000+id,projectId:2000+id,jobId:`motion-${id}`}
    db.prepare('INSERT INTO history_script_sources VALUES(?,?,?,NULL,?)').run(id,`source ${id}`,'{}','original')
    db.prepare(`INSERT INTO history_huasheng_jobs VALUES(?,?,?,'needs_attention','needs_attention',NULL,NULL,NULL,NULL,
      'not_started',0,1,'original','original')`).run(hid,id,`hash-${id}`)
    db.prepare('INSERT INTO history_dual_production VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,`hash-${id}`,hid,`motion-${id}`,factory.episodeId,'failed',status==='failed'?'failed':status==='completed'?'completed':'started','dual','original')
    db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?)')
      .run(`motion-${id}`,id,status,JSON.stringify({id:`motion-${id}`,scriptId:id,status,factory,plan:{visuals:{}},outputPath:null}))
    db.prepare('INSERT INTO episodes VALUES(?,?,NULL,NULL,?)').run(factory.episodeId,JSON.stringify({historyFactory:factory}),'original')
  }
  db.prepare('INSERT INTO history_social_upload_jobs VALUES(?,?,?)').run(1,17,'motion')
  return {root,db}
}

test('removes unused sources and archives only the unused branch of ongoing or completed refined work', t => {
  const {root,db} = fixture(t)
  const motions=db.prepare('SELECT * FROM history_motion_productions').all()
  const uploads=db.prepare('SELECT * FROM history_social_upload_jobs').all()
  const result=pruneUnstartedRecords(db,root,true)
  assert.equal(result.deletedSources,1)
  assert.equal(result.archivedBranches,3)
  assert.ok((db.prepare('SELECT deleted_at FROM history_script_sources WHERE id=11').get() as any).deleted_at)
  assert.equal((db.prepare('SELECT deleted_at FROM history_script_sources WHERE id=19').get() as any).deleted_at,null)
  assert.equal(result.deletedMotionTasks,1)
  assert.deepEqual(db.prepare('SELECT * FROM history_motion_productions').all(),motions.filter((row:any)=>row.script_id!==11))
  assert.deepEqual(db.prepare('SELECT * FROM history_social_upload_jobs').all(),uploads)
  assert.deepEqual(db.prepare('SELECT status,stage,cancel_requested FROM history_huasheng_jobs WHERE id=158').get(),
    {status:'canceled',stage:'record_cleanup',cancel_requested:1})
  assert.equal((db.prepare('SELECT production_mode FROM history_dual_production WHERE source_id=19').get() as any).production_mode,'motion_backfill')
  assert.equal('backupPath' in result,false)
  const report=JSON.parse(fs.readFileSync(result.reportPath!,'utf8'))
  assert.deepEqual(report.sourceIds,[11])
  assert.equal('sources' in report,false)
  assert.equal(fs.readdirSync(path.join(root,'data/reports')).some(file=>file.endsWith('.gz')),false)
  assert.equal(pruneUnstartedRecords(db,root,true).deletedSources,0)
})

test('preserves unknown external creation, pending outbox, external projects, and Huasheng uploads', t => {
  const {root,db}=fixture(t)
  db.exec(`UPDATE history_huasheng_jobs SET checkpoint='create_pending' WHERE source_id=11;
    UPDATE history_script_sources SET review_json='{"huashengQueue":{"status":"pending"}}' WHERE id=17;
    UPDATE history_huasheng_jobs SET project_url='https://example.test/project' WHERE source_id=19;`)
  assert.deepEqual(planUnstartedPrune(db,root).branchSourceIds,[])
  assert.deepEqual(planUnstartedPrune(db,root).sourceIds,[])
  db.exec(`UPDATE history_huasheng_jobs SET checkpoint=NULL WHERE source_id=11;
    INSERT INTO history_social_upload_jobs VALUES(2,11,'huasheng');`)
  assert.equal(planUnstartedPrune(db,root).branchSourceIds.includes(11),false)
})

test('retains sources with actual work, media caches, or an upload record', t => {
  const {root,db}=fixture(t)
  db.prepare('INSERT INTO history_social_upload_jobs VALUES(?,?,?)').run(2,11,'motion')
  assert.deepEqual(planUnstartedPrune(db,root).sourceIds,[])
  db.exec('DELETE FROM history_social_upload_jobs WHERE source_id=11')
  db.exec("UPDATE history_motion_productions SET status='queued' WHERE script_id=11")
  assert.deepEqual(planUnstartedPrune(db,root).sourceIds,[])
  db.exec("UPDATE history_motion_productions SET status='failed' WHERE script_id=11")
  const dir=path.join(root,'data/storage/history-motion/motion-11')
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'narration.wav'),'saved media')
  assert.deepEqual(planUnstartedPrune(db,root).sourceIds,[])
})

test('keeps prior episode deletion timestamps and refuses an active source lock', t => {
  const {root,db}=fixture(t)
  const e=db.prepare('SELECT metadata FROM episodes WHERE id=1011').get() as any
  const metadata=JSON.parse(e.metadata);metadata.historyFactory.deletedAt='previous'
  db.prepare('UPDATE episodes SET metadata=? WHERE id=1011').run(JSON.stringify(metadata))
  const dir=path.join(root,'data/storage/history-scripts/11')
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'process.lock'),JSON.stringify({pid:process.pid}))
  assert.throws(()=>pruneUnstartedRecords(db,root,true),/active.*source/i)
  assert.equal((db.prepare('SELECT status FROM history_huasheng_jobs WHERE id=132').get() as any).status,'needs_attention')
  fs.unlinkSync(path.join(dir,'process.lock'))
  pruneUnstartedRecords(db,root,true)
  assert.equal(JSON.parse((db.prepare('SELECT metadata FROM episodes WHERE id=1011').get() as any).metadata).historyFactory.deletedAt,'previous')
})

test('deletes unused replacement production while retaining legacy delivery, source and upload entry', t => {
  const {root,db}=fixture(t)
  db.prepare('INSERT INTO history_script_deliveries VALUES(?,?)').run(11,'static/history-deliveries/11/old.mp4')
  const source=db.prepare('SELECT * FROM history_script_sources WHERE id=11').get()
  const delivery=db.prepare('SELECT * FROM history_script_deliveries').all()
  const result=pruneUnstartedRecords(db,root,true)
  assert.equal(result.deletedSources,0)
  assert.equal(result.deletedMotionTasks,1)
  assert.deepEqual(db.prepare('SELECT * FROM history_script_sources WHERE id=11').get(),source)
  assert.deepEqual(db.prepare('SELECT * FROM history_script_deliveries').all(),delivery)
  assert.deepEqual(db.prepare('SELECT motion_job_id,episode_id,motion_state FROM history_dual_production WHERE source_id=11').get(),
    {motion_job_id:null,episode_id:null,motion_state:'failed'})
})
