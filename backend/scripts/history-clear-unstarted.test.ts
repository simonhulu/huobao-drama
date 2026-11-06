import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {clearUnstartedHuasheng} from './history-clear-unstarted.js'

function fixture(t:TestContext) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'history-clear-')))
  const db=new Database(':memory:')
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})})
  db.exec(`
    CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,deleted_at TEXT,review_json TEXT);
    CREATE TABLE history_huasheng_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,status TEXT,
      stage TEXT,production_status TEXT,checkpoint TEXT,project_url TEXT,owner TEXT,cancel_requested INTEGER,
      manual_requested INTEGER,message TEXT,updated_at TEXT);
    CREATE TABLE history_dual_production(source_id INTEGER,script_sha256 TEXT,huasheng_job_id INTEGER,
      production_mode TEXT,huasheng_state TEXT,huasheng_error TEXT,motion_state TEXT,motion_job_id TEXT,updated_at TEXT);
    CREATE TABLE history_huasheng_export_jobs(id INTEGER PRIMARY KEY,huasheng_job_id INTEGER,status TEXT,
      stage TEXT,owner TEXT,host TEXT,pid INTEGER,dispatched INTEGER,export_progress INTEGER,
      downloaded_bytes INTEGER,total_bytes INTEGER,video_url TEXT,task_id TEXT,project_hash TEXT,
      download_url TEXT,filename TEXT,file_path TEXT,design_status TEXT,cover_status TEXT,article_status TEXT);
    CREATE TABLE history_motion_productions(id TEXT PRIMARY KEY,status TEXT,snapshot TEXT);
    CREATE TABLE history_video_deliveries(id INTEGER PRIMARY KEY,video_path TEXT);
    CREATE TABLE history_video_publication_intents(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,status TEXT,upload_dispatched INTEGER);
    CREATE TABLE history_social_upload_confirmations(source_id INTEGER,target TEXT,confirmed_at TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER,video_path TEXT);
  `)
  for(let id=1;id<=4;id++) {
    db.prepare('INSERT INTO history_script_sources VALUES(?,NULL,?)').run(id,JSON.stringify({note:'keep',...(id===1?{huashengQueue:{status:'pending',scriptSha256:'hash-1'}}:{})}))
    db.prepare(`INSERT INTO history_huasheng_jobs VALUES(?,?,?,?,'needs_attention',?,?,?,NULL,0,1,'original','original')`)
      .run(id,id,`hash-${id}`,id===3?'canceled':id===4?'submitted':'needs_attention',id===4?'completed':'not_started',id===1?'create_pending':'quota_waiting',id===2?'https://example.test/project':null)
    db.prepare('INSERT INTO history_dual_production VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,`hash-${id}`,id,id===3?'motion_backfill':'dual','failed',null,id===1?'started':'completed',`motion-${id}`,'original')
    db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?)').run(`motion-${id}`,id===1?'rendering':'completed',`saved progress ${id}`)
  }
  db.exec(`UPDATE history_huasheng_jobs SET stage='record_cleanup',cancel_requested=1 WHERE id=3;
    INSERT INTO history_huasheng_export_jobs VALUES(10,2,'queued','waiting_production',NULL,NULL,NULL,0,0,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO history_huasheng_export_jobs VALUES(11,1,'completed','completed',NULL,NULL,NULL,1,100,100,100,'saved.mp4','remote-task',NULL,NULL,NULL,NULL,'completed','completed','completed');
    INSERT INTO history_video_deliveries VALUES(1,'saved.mp4');
    INSERT INTO history_video_publication_intents VALUES(1,'pending');
    INSERT INTO history_social_upload_jobs VALUES(1,'uncertain',1);
    INSERT INTO history_social_upload_confirmations VALUES(2,'baijiahao-video','confirmed');
    INSERT INTO history_script_deliveries VALUES(2,'old.mp4');`)
  return {root,db}
}

test('clears all unstarted local branches while preserving remote checkpoints, motion and upload evidence',t=>{
  const {root,db}=fixture(t)
  const motions=db.prepare('SELECT * FROM history_motion_productions').all()
  const uploads=db.prepare('SELECT * FROM history_social_upload_jobs').all()
  const complete=db.prepare('SELECT * FROM history_huasheng_jobs WHERE id=4').get()
  const result=clearUnstartedHuasheng(db,root,true)
  assert.deepEqual(result.jobIds,[1,2])
  assert.equal(result.previouslyArchived,1)
  assert.equal(result.archivedBranches,2)
  assert.equal(result.deletedEmptyExports,1)
  assert.deepEqual(db.prepare('SELECT status,stage,checkpoint,project_url FROM history_huasheng_jobs WHERE id=1').get(),
    {status:'canceled',stage:'record_cleanup',checkpoint:'create_pending',project_url:null})
  assert.equal((db.prepare('SELECT project_url FROM history_huasheng_jobs WHERE id=2').get() as any).project_url,'https://example.test/project')
  assert.deepEqual(db.prepare('SELECT * FROM history_motion_productions').all(),motions)
  assert.deepEqual(db.prepare('SELECT * FROM history_social_upload_jobs').all(),uploads)
  assert.deepEqual(db.prepare('SELECT * FROM history_huasheng_jobs WHERE id=4').get(),complete)
  assert.equal((db.prepare('SELECT count(*) AS n FROM history_huasheng_export_jobs WHERE id=11').get() as any).n,1)
  assert.deepEqual(JSON.parse((db.prepare('SELECT review_json FROM history_script_sources WHERE id=1').get() as any).review_json),{note:'keep'})
  assert.equal((db.prepare("SELECT production_mode FROM history_dual_production WHERE huasheng_job_id=1").get() as any).production_mode,'motion_backfill')
  assert.equal(clearUnstartedHuasheng(db,root,true).archivedBranches,0)
  assert.equal(fs.readdirSync(path.join(root,'data/reports')).some(file=>file.includes('before')||file.endsWith('.gz')),false)
})

test('refuses to overwrite an actively owned Huasheng operation',t=>{
  const {root,db}=fixture(t)
  db.exec("UPDATE history_huasheng_jobs SET owner='active',status='running' WHERE id=2")
  assert.throws(()=>clearUnstartedHuasheng(db,root,true),/active.*Huasheng/i)
  assert.equal((db.prepare('SELECT status FROM history_huasheng_jobs WHERE id=1').get() as any).status,'needs_attention')
  assert.equal((db.prepare('SELECT count(*) AS n FROM history_huasheng_export_jobs').get() as any).n,2)
})

test('preserves any export with an owner, dispatch, progress or generated output',t=>{
  const {root,db}=fixture(t)
  db.exec("UPDATE history_huasheng_export_jobs SET downloaded_bytes=10 WHERE id=10")
  const before=db.prepare('SELECT * FROM history_huasheng_export_jobs').all()
  const result=clearUnstartedHuasheng(db,root,true)
  assert.equal(result.deletedEmptyExports,0)
  assert.deepEqual(db.prepare('SELECT * FROM history_huasheng_export_jobs').all(),before)
})
