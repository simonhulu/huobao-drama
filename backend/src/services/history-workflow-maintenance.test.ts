import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHistoryWorkflowMaintenance } from './history-workflow-maintenance.js'

function fixture(t: TestContext) {
  const database=new Database(':memory:')
  database.exec(`CREATE TABLE creation_tasks(id INTEGER PRIMARY KEY,type TEXT,status TEXT,error_code TEXT,
    cancel_requested INTEGER DEFAULT 0,payload_json TEXT,completed_at TEXT,updated_at TEXT);
    CREATE TABLE creation_task_events(id INTEGER PRIMARY KEY,task_id INTEGER,event_type TEXT,data_json TEXT,created_at TEXT);
    CREATE TABLE history_dual_production(source_id INTEGER,script_sha256 TEXT,huasheng_job_id INTEGER,motion_job_id TEXT,
      huasheng_state TEXT,motion_state TEXT,updated_at TEXT);
    CREATE TABLE history_motion_productions(id TEXT,script_id INTEGER,status TEXT,snapshot TEXT,updated_at TEXT);`)
  let now=Date.parse('2026-11-02T00:00:00Z'),available=true
  const calls:number[]=[]
  const seed=(id=1,error='history_source_rate_limited')=>database.prepare(`INSERT INTO creation_tasks
    (id,type,status,error_code,payload_json,completed_at,updated_at) VALUES(?,'history.source','failed',?,? ,?,?)`)
    .run(id,error,JSON.stringify({source:'youtube'}),new Date(now).toISOString(),new Date(now).toISOString())
  const options={database,now:()=>now,hasSourceWorker:()=>available,resumeCollection:(id:number)=>{
    calls.push(id);database.prepare("UPDATE creation_tasks SET status='queued',error_code=NULL WHERE id=?").run(id)
  }}
  const service=createHistoryWorkflowMaintenance(options)
  t.after(()=>{service.stop();database.close()})
  const row=(query:string)=>database.prepare<[],Record<string,any>>(query).get()!
  return {database,service,seed,calls,options,row,advance:(ms:number)=>{now+=ms},unavailable:()=>{available=false},now:()=>now}
}

test('explicit rate limits resume the original collection once after durable backoff',t=>{
  const h=fixture(t);h.seed()
  h.service.tick();assert.deepEqual(h.calls,[])
  h.advance(30000)
  const restarted=createHistoryWorkflowMaintenance(h.options)
  restarted.tick();h.service.tick()
  assert.deepEqual(h.calls,[1]);restarted.stop()
  assert.equal(h.row('SELECT attempts FROM history_source_recovery WHERE task_id=1').attempts,1)
})

test('three automatic recoveries exhaust a persistent budget across failures and restarts',t=>{
  const h=fixture(t);h.seed()
  for(let attempt=0;attempt<3;attempt++) {
    h.service.tick();h.advance(120000)
    h.service.tick()
    h.database.prepare("UPDATE creation_tasks SET status='failed',error_code='history_source_rate_limited',completed_at=? WHERE id=1")
      .run(new Date(h.now()).toISOString())
  }
  h.service.tick();h.advance(3600000);h.service.tick()
  assert.deepEqual(h.calls,[1,1,1])
  assert.equal(h.row('SELECT state FROM history_source_recovery WHERE task_id=1').state,'exhausted')
})

test('user cancellation, a newer collection, unknown failures, and absent workers never trigger work',t=>{
  const h=fixture(t);h.seed(1,'unknown_remote_result');h.seed(2)
  h.database.prepare('UPDATE creation_tasks SET cancel_requested=1 WHERE id=2').run()
  h.service.tick();h.advance(120000);h.service.tick();assert.deepEqual(h.calls,[])
  h.database.prepare('UPDATE creation_tasks SET cancel_requested=0 WHERE id=2').run();h.seed(3)
  h.unavailable();h.service.tick();h.advance(120000);h.service.tick();assert.deepEqual(h.calls,[])
})

test('Retry-After from the refused request is preserved and stopped tasks are never revived',t=>{
  const h=fixture(t);h.seed()
  h.database.prepare("INSERT INTO creation_task_events VALUES(1,1,'history.rate_limit',?,'now')").run(JSON.stringify({retryAfterMs:600000}))
  h.service.tick();h.advance(590000);h.service.tick();assert.deepEqual(h.calls,[])
  h.database.prepare("UPDATE creation_tasks SET status='canceled',cancel_requested=1 WHERE id=1").run()
  h.advance(20000);h.service.tick();assert.deepEqual(h.calls,[])
})

test('newer successful collections supersede waiting recovery and old failures expire',t=>{
  const h=fixture(t);h.seed(1);h.service.tick()
  h.seed(2,'unknown_remote_result')
  h.database.prepare("UPDATE creation_tasks SET status='succeeded' WHERE id=2").run()
  h.advance(120000);h.service.tick()
  assert.deepEqual(h.calls,[])
  assert.equal(h.row('SELECT state FROM history_source_recovery WHERE task_id=1').state,'superseded')
  h.seed(3);h.advance(25*3600000);h.service.tick()
  assert.equal(h.database.prepare('SELECT 1 FROM history_source_recovery WHERE task_id=3').get(),undefined)
})

test('a synchronous resume failure rolls back the retry budget and original task',t=>{
  const h=fixture(t);h.seed();h.service.tick();h.advance(30000)
  const failing=createHistoryWorkflowMaintenance({...h.options,resumeCollection:(id:number)=>{
    h.database.prepare("UPDATE creation_tasks SET status='queued' WHERE id=?").run(id)
    throw Error('worker disappeared')
  }})
  assert.throws(()=>failing.tick(),/worker disappeared/)
  assert.equal(h.row('SELECT status FROM creation_tasks WHERE id=1').status,'failed')
  assert.equal(h.row('SELECT attempts FROM history_source_recovery WHERE task_id=1').attempts,0)
  h.service.tick();assert.deepEqual(h.calls,[1]);failing.stop()
})

test('heartbeat timestamps do not reset stagnation but actual progress does',t=>{
  const h=fixture(t)
  h.database.prepare("INSERT INTO history_dual_production VALUES(900,'hash',NULL,'motion-900','completed','started','before')").run()
  const snapshot={stage:'rendering',message:'正在渲染 10%',updatedAt:'heartbeat-1'}
  h.database.prepare('INSERT INTO history_motion_productions VALUES(?,?,?, ?,?)').run('motion-900',900,'running',JSON.stringify(snapshot),'before')
  h.service.tick()
  const initial=h.row("SELECT * FROM history_workflow_activity WHERE source_id=900 AND producer='motion'")
  h.advance(120000);snapshot.updatedAt='heartbeat-2'
  h.database.prepare('UPDATE history_motion_productions SET snapshot=?,updated_at=?').run(JSON.stringify(snapshot),'later')
  h.service.tick()
  assert.equal(h.row("SELECT progress_at FROM history_workflow_activity WHERE source_id=900 AND producer='motion'").progress_at,initial.progress_at)
  snapshot.message='正在渲染 20%'
  h.database.prepare('UPDATE history_motion_productions SET snapshot=?').run(JSON.stringify(snapshot))
  h.service.tick()
  assert.notEqual(h.row("SELECT progress_at FROM history_workflow_activity WHERE source_id=900 AND producer='motion'").progress_at,initial.progress_at)
  assert.deepEqual(h.calls,[])
})

test('an observation of a long remote wait never calls a creation or cancellation operation',t=>{
  const h=fixture(t)
  h.database.prepare("INSERT INTO history_dual_production VALUES(900,'hash',NULL,'original-motion','completed','started','before')").run()
  h.service.tick();h.advance(8*3600000);h.service.tick()
  assert.deepEqual(h.calls,[])
  const observation=h.row('SELECT * FROM history_workflow_activity WHERE source_id=900')
  assert.equal(observation.producer,'motion')
  assert.ok(h.now()-Date.parse(observation.progress_at)>observation.stall_after_ms)
})

test('completed production clears a previous stagnation observation',t=>{
  const h=fixture(t)
  h.database.prepare("INSERT INTO history_dual_production VALUES(900,'hash',NULL,'original-motion','completed','started','before')").run()
  h.service.tick();h.advance(8*3600000)
  h.database.prepare("UPDATE history_dual_production SET motion_state='completed'").run()
  h.service.tick()
  const observation=h.row("SELECT * FROM history_workflow_activity WHERE source_id=900 AND producer='motion'")
  assert.equal(observation.state,'completed')
  assert.deepEqual(h.calls,[])
})

test('a published replacement clears old upload failures without alternating progress',t=>{
  const h=fixture(t)
  h.database.exec(`CREATE TABLE history_video_deliveries(id INTEGER PRIMARY KEY,script_id INTEGER,script_sha256 TEXT,producer TEXT);
    CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,video_id INTEGER,video_producer TEXT,
      status TEXT,publication_mode TEXT,result_json TEXT,progress_json TEXT,message TEXT);
    INSERT INTO history_dual_production VALUES(900,'hash',1,'motion','completed','completed','before');
    INSERT INTO history_video_deliveries VALUES(1,900,'hash','motion');
    INSERT INTO history_social_upload_jobs VALUES(1,900,1,'motion','failed','publish',NULL,NULL,'old upload failed');`)
  h.service.tick()
  assert.equal(h.row("SELECT state FROM history_workflow_activity WHERE producer='motion_upload'").state,'failed')
  h.database.exec(`INSERT INTO history_video_deliveries VALUES(2,900,'hash','motion');
    INSERT INTO history_social_upload_jobs VALUES(2,900,2,'motion','completed','publish','{"publicationStatus":"published"}',NULL,'published');`)
  h.advance(60000);h.service.tick()
  const completed=h.row("SELECT * FROM history_workflow_activity WHERE producer='motion_upload'")
  assert.equal(completed.state,'completed')
  h.advance(60000);h.service.tick();h.advance(60000);h.service.tick()
  assert.deepEqual(h.row("SELECT * FROM history_workflow_activity WHERE producer='motion_upload'"),completed)
  assert.deepEqual(h.calls,[])
})
