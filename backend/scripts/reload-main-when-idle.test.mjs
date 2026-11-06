import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { inspectMainWork, parseReloadOptions, reloadMainWhenIdle } from './reload-main-when-idle.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-main-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const databasePath = path.join(root, 'test.db'), stateFile = path.join(root, 'state.json')
  const db = new Database(databasePath)
  db.exec(`CREATE TABLE history_motion_productions(id TEXT,status TEXT);
    CREATE TABLE creation_tasks(id INTEGER,status TEXT,lease_owner TEXT);
    CREATE TABLE worker_heartbeats(worker_id TEXT,pid INTEGER);
    CREATE TABLE history_huasheng_jobs(status TEXT);
    CREATE TABLE history_huasheng_export_jobs(status TEXT);
    CREATE TABLE history_social_upload_jobs(status TEXT);
    CREATE TABLE history_huasheng_inspection_lease(pid INTEGER,expires_at INTEGER);`)
  t.after(() => db.close())
  let restarts = 0, pid = 17579
  const options = { expectedPid: pid, stateFile, databasePath, apply: true }
  const deps = { listenPid: () => pid, kickstart: () => { restarts++ } }
  return { db, options, deps, calls: () => restarts, setPid: value => { pid = value }, run: () => reloadMainWhenIdle(options, deps) }
}

for (const status of ['queued', 'planning', 'selecting', 'rendering', 'validating']) {
  test(`active motion ${status} never restarts and resets an earlier idle observation`, t => {
    const f = fixture(t)
    assert.equal(f.run().idleChecks, 1)
    f.db.prepare('INSERT INTO history_motion_productions VALUES(?,?)').run('expensive-render', status)
    for (let index = 0; index < 3; index++) {
      const result = f.run()
      assert.equal(result.reason, 'busy'); assert.equal(result.idleChecks, 0)
    }
    assert.equal(f.calls(), 0)
    f.db.exec('DELETE FROM history_motion_productions')
    assert.equal(f.run().idleChecks, 1)
    assert.equal(f.calls(), 0)
  })
}

test('a changed PID completes without inspecting work or invoking launchctl, including later checks', t => {
  const f = fixture(t)
  f.setPid(20000)
  f.deps.inspect = () => assert.fail('a replaced process must not be inspected')
  assert.equal(f.run().status, 'completed')
  assert.equal(f.run().reason, 'pid_changed')
  assert.equal(f.calls(), 0)
})

test('two idle apply observations request exactly one reload and wait for the replacement PID', t => {
  const f = fixture(t)
  assert.equal(f.run().idleChecks, 1); assert.equal(f.calls(), 0)
  assert.equal(f.run().reason, 'reload_requested'); assert.equal(f.calls(), 1)
  assert.equal(f.run().reason, 'reload_already_requested'); assert.equal(f.calls(), 1)
  f.setPid(20000)
  assert.equal(f.run().status, 'completed'); assert.equal(f.calls(), 1)
})

test('dry run is the default and its idle observations cannot authorize an apply reload', t => {
  const f = fixture(t)
  delete f.options.apply
  for (let index = 0; index < 3; index++) assert.equal(f.run().dryRun, true)
  assert.equal(f.calls(), 0)
  assert.equal(fs.existsSync(`${f.options.stateFile}.requested`), false)
  f.options.apply = true
  assert.equal(f.run().idleChecks, 1); assert.equal(f.calls(), 0)
})

test('running creation work matches the main PID by worker suffix or heartbeat; unknown queued does not block', t => {
  const f = fixture(t)
  f.db.exec("INSERT INTO creation_tasks VALUES(1,'queued','test.task'),(2,'running','nba-worker-20000')")
  assert.deepEqual(inspectMainWork(f.options.databasePath, 17579), [])
  f.db.exec("INSERT INTO creation_tasks VALUES(3,'running','worker-long-17579')")
  assert.equal(f.run().busy[0].kind, 'creation_tasks'); assert.equal(f.calls(), 0)
  f.db.exec("UPDATE creation_tasks SET lease_owner='custom-main' WHERE id=3; INSERT INTO worker_heartbeats VALUES('custom-main',17579)")
  assert.equal(inspectMainWork(f.options.databasePath, 17579)[0].count, 1)
})

for (const [table, state] of [['history_huasheng_jobs', 'running'], ['history_huasheng_export_jobs', 'downloading'], ['history_social_upload_jobs', 'running']]) {
  test(`active ${table} prevents a restart`, t => {
    const f = fixture(t)
    f.db.prepare(`INSERT INTO ${table} VALUES(?)`).run(state)
    assert.equal(f.run().reason, 'busy'); assert.equal(f.calls(), 0)
  })
}

test('only a live main-process inspection lease blocks, and all DB checks remain read-only', t => {
  const f = fixture(t), now = Date.now()
  f.db.prepare('INSERT INTO history_huasheng_inspection_lease VALUES(?,?)').run(17579, now + 60000)
  const before = f.db.pragma('data_version', { simple: true })
  assert.equal(inspectMainWork(f.options.databasePath, 17579, now)[0].kind, 'history_huasheng_inspection_lease')
  assert.deepEqual(inspectMainWork(f.options.databasePath, 17579, now + 60001), [])
  assert.equal(f.db.pragma('data_version', { simple: true }), before)
})

test('a launchctl failure records a redacted error and never retries the claimed restart', t => {
  const f = fixture(t)
  let attempts = 0
  f.deps.kickstart = () => { attempts++; throw Error('secret-token-must-not-be-written') }
  f.run()
  assert.equal(f.run().status, 'error')
  assert.equal(f.run().status, 'error')
  assert.equal(attempts, 1)
  assert.equal(fs.readFileSync(f.options.stateFile, 'utf8').includes('secret-token'), false)
})

test('another reload during the idle observation is detected before kickstart', t => {
  const f = fixture(t)
  f.run()
  let observations = 0
  f.deps.listenPid = () => ++observations === 1 ? 17579 : 20000
  assert.equal(f.run().status, 'completed'); assert.equal(f.calls(), 0)
  assert.equal(fs.existsSync(`${f.options.stateFile}.requested`), false)
})

test('reusing another expected PID state stays blocked without changing its ownership', t => {
  const f = fixture(t)
  f.run()
  f.options.expectedPid = 20000
  assert.equal(f.run().status, 'error')
  assert.equal(f.run().status, 'error')
  assert.equal(JSON.parse(fs.readFileSync(f.options.stateFile, 'utf8')).expectedPid, 17579)
  assert.equal(f.calls(), 0)
})

test('missing listener and unreadable database reset the idle streak without a restart', t => {
  const f = fixture(t)
  f.run(); f.setPid(null)
  assert.equal(f.run().reason, 'listener_missing')
  f.setPid(17579); f.options.databasePath = path.join(path.dirname(f.options.databasePath), 'missing.db')
  assert.equal(f.run().status, 'error'); assert.equal(f.calls(), 0)
  assert.equal(fs.existsSync(f.options.databasePath), false)
})

test('CLI requires an explicit expected PID and state file, and defaults to dry run', () => {
  assert.equal(parseReloadOptions(['--expected-pid', '17579', '--state', '/tmp/state.json']).apply, false)
  for (const args of [[], ['--expected-pid', '0', '--state', '/tmp/state'], ['--expected-pid', '17579'], ['--unknown']]) assert.throws(() => parseReloadOptions(args), /Usage:/)
})
