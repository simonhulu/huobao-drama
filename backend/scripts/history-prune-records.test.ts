import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {gunzipSync} from 'node:zlib'
import {planHistoryPrune, pruneHistoryRecords} from './history-prune-records.js'

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-prune-')))
  const db = new Database(':memory:')
  t.after(() => { db.close(); fs.rmSync(root, {recursive: true, force: true}) })
  db.exec(`
    CREATE TABLE history_script_sources (id INTEGER PRIMARY KEY, title TEXT, status TEXT,
      rewritten_script TEXT, updated_at TEXT, deleted_at TEXT);
    CREATE TABLE history_motion_productions (id TEXT PRIMARY KEY, script_id INTEGER, status TEXT, snapshot TEXT);
    CREATE TABLE history_dual_production (source_id INTEGER, motion_state TEXT);
    CREATE TABLE history_video_deliveries (id INTEGER PRIMARY KEY, script_id INTEGER, producer TEXT, producer_job_id TEXT);
    CREATE TABLE history_video_publication_intents (id INTEGER PRIMARY KEY, source_id INTEGER, video_id INTEGER, producer TEXT, status TEXT);
    CREATE TABLE history_social_upload_jobs (id INTEGER PRIMARY KEY, source_id INTEGER, status TEXT, upload_dispatched INTEGER);
    CREATE TABLE creation_tasks (id INTEGER PRIMARY KEY, type TEXT, status TEXT, scope_type TEXT,
      scope_id INTEGER, payload_json TEXT, parent_task_id INTEGER);
    CREATE TABLE creation_task_events (id INTEGER PRIMARY KEY, task_id INTEGER, data_json TEXT);
    CREATE TABLE creation_task_dependencies (id INTEGER PRIMARY KEY, task_id INTEGER, depends_on_task_id INTEGER);
  `)
  for (let id = 1; id <= 9; id++) db.prepare('INSERT INTO history_script_sources VALUES(?,?,?,?,?,?)')
    .run(id, `source ${id}`, 'needs_review', `script ${id}`, 'original', id === 7 ? 'already-deleted' : null)
  for (const [id, status] of [[1, 'queued'], [2, 'failed'], [3, 'completed'], [4, 'completed'], [8, 'completed']] as const) {
    db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?)').run(`motion-${id}`, id, status, '{}')
  }
  for (const id of [3, 4]) {
    db.prepare('INSERT INTO history_video_deliveries VALUES(?,?,?,?)').run(id, id, 'motion', `motion-${id}`)
    db.prepare('INSERT INTO history_video_publication_intents VALUES(?,?,?,?,?)')
      .run(id, id, id, 'motion', id === 3 ? 'completed' : 'needs_attention')
  }
  db.prepare('INSERT INTO history_dual_production VALUES(?,?)').run(6, 'pending')
  db.exec(`
    INSERT INTO creation_tasks VALUES(100,'history.source','succeeded','history-scripts',NULL,'{}',NULL);
    INSERT INTO creation_tasks VALUES(101,'history.production.continue','succeeded','history-scripts',1,'{"sourceId":1}',NULL);
    INSERT INTO creation_tasks VALUES(102,'image.generate','succeeded','episode',1,'{}',NULL);
    INSERT INTO creation_task_events VALUES(1,100,'{"currentSourceId":1}');
    INSERT INTO creation_task_events VALUES(2,101,'protected continuation');
    INSERT INTO creation_task_events VALUES(3,102,'other workflow');
  `)
  return {root, db}
}

test('prunes only unprotected library and terminal collection records with a durable restorable backup', t => {
  const {root, db} = fixture(t)
  const before = db.prepare('SELECT * FROM history_script_sources').all() as {id: number}[]
  const plan = planHistoryPrune(db)
  assert.deepEqual(plan.sourceIds, [3, 5, 9])
  assert.deepEqual(plan.protectedSources.map(source => source.id), [1, 2, 4, 6, 8])
  const result = pruneHistoryRecords(db, root, true)
  assert.equal(result.deletedSources, 3)
  assert.equal(result.deletedTasks, 1)
  assert.equal(result.deletedEvents, 1)
  const backup = JSON.parse(gunzipSync(fs.readFileSync(result.backupPath!)).toString())
  assert.deepEqual(backup.sources, before.filter(row => plan.sourceIds.includes(row.id)))
  assert.equal(backup.tasks[0].id, 100)
  assert.equal(backup.events[0].id, 1)
  for (const id of [1, 2, 4, 6, 7, 8]) assert.deepEqual(db.prepare('SELECT * FROM history_script_sources WHERE id=?').get(id), before.find(row => row.id === id))
  assert.deepEqual(db.prepare('SELECT id FROM creation_tasks ORDER BY id').all(), [{id: 101}, {id: 102}])
  assert.deepEqual(db.prepare('SELECT id FROM creation_task_events ORDER BY id').all(), [{id: 2}, {id: 3}])
  assert.equal((db.prepare('SELECT count(*) AS n FROM history_motion_productions').get() as any).n, 5)
})

test('refuses active collection or source locks without changing any source', t => {
  const {root, db} = fixture(t)
  db.prepare('UPDATE creation_tasks SET status=? WHERE id=100').run('running')
  assert.throws(() => pruneHistoryRecords(db, root, true), /active.*collection/i)
  db.prepare('UPDATE creation_tasks SET status=? WHERE id=100').run('succeeded')
  const directory = path.join(root, 'data/storage/history-scripts/3')
  fs.mkdirSync(directory, {recursive: true})
  fs.writeFileSync(path.join(directory, 'process.lock'), JSON.stringify({pid: process.pid}))
  assert.throws(() => pruneHistoryRecords(db, root, true), /active.*source/i)
  assert.equal((db.prepare('SELECT count(*) AS n FROM history_script_sources WHERE deleted_at IS NULL').get() as any).n, 8)
})

test('protects work beyond the UI row limit and rejects externally referenced collection history', t => {
  const {root, db} = fixture(t)
  for (let id = 10; id <= 115; id++) {
    db.prepare('INSERT INTO history_script_sources VALUES(?,?,?,?,?,NULL)').run(id, `source ${id}`, 'needs_review', 'script', 'original')
    db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?)').run(`motion-${id}`, id, 'queued', '{}')
  }
  assert.ok(planHistoryPrune(db).protectedSources.some(source => source.id === 115))
  db.prepare('INSERT INTO creation_task_dependencies VALUES(?,?,?)').run(1, 102, 100)
  assert.throws(() => pruneHistoryRecords(db, root, true), /referenced/i)
  assert.equal((db.prepare('SELECT deleted_at FROM history_script_sources WHERE id=3').get() as any).deleted_at, null)
})

test('preserves in-flight uploads and dispatched attempts even when motion publication is completed', t => {
  const {root, db} = fixture(t)
  for (const [id, status, dispatched] of [[3, 'awaiting_confirmation', 0], [5, 'failed', 1], [9, 'running', 1]] as const) {
    db.prepare('INSERT INTO history_social_upload_jobs VALUES(?,?,?,?)').run(id, id, status, dispatched)
  }
  assert.deepEqual(planHistoryPrune(db).sourceIds, [])
  const result = pruneHistoryRecords(db, root, true)
  assert.equal(result.deletedSources, 0)
  assert.equal((db.prepare('SELECT count(*) AS n FROM history_social_upload_jobs').get() as any).n, 3)
})

test('reclaims a dead process lock and holds an exclusive replacement through cleanup', t => {
  const {root, db} = fixture(t)
  const directory = path.join(root, 'data/storage/history-scripts/3')
  fs.mkdirSync(directory, {recursive: true})
  const contents = JSON.stringify({pid: 2147483647, hostname: hostnameForFixture()})
  fs.writeFileSync(path.join(directory, 'process.lock'), contents)
  const result = pruneHistoryRecords(db, root, true)
  assert.equal(result.reclaimedLocks.length, 1)
  assert.equal(result.reclaimedLocks[0].previousContents, contents)
  assert.equal(fs.existsSync(path.join(directory, 'process.lock')), false)
  assert.ok((db.prepare('SELECT deleted_at FROM history_script_sources WHERE id=3').get() as any).deleted_at)
})

function hostnameForFixture() { return os.hostname() }
