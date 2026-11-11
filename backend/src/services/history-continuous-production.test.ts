import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import Database from 'better-sqlite3'
import {createHistoryContinuousProduction, type HistoryContinuousOptions, type HistoryContinuousPrepared,
  type HistoryContinuousProgress, type HistoryContinuousScope} from './history-continuous-production.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const url = 'https://www.youtube.com/@HistorySupply/videos'
function fixture(t: test.TestContext, maxPendingMotion = 2) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-continuous-')), filename = path.join(directory, 'state.db')
  const db = new Database(filename), connections = [db]
  db.pragma('journal_mode=WAL')
  db.exec(`CREATE TABLE creation_tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT,status TEXT,payload_json TEXT,result_json TEXT,scope_id INTEGER,
      error_code TEXT,cancel_requested INTEGER DEFAULT 0,completed_at TEXT,updated_at TEXT);
    INSERT INTO creation_tasks(id,type,status) VALUES(40400,'preserved','failed');
    CREATE TABLE creation_task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER,event_type TEXT,data_json TEXT);
    CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,platform TEXT,deleted INTEGER,revision TEXT,script_hash TEXT);
    INSERT INTO history_script_sources VALUES(100,'youtube',0,'original',NULL);`)
  t.after(() => { for (const connection of connections) connection.close(); fs.rmSync(directory, {recursive: true, force: true}) })
  let time = 100000
  const calls = {collect: [] as unknown[], prepare: [] as number[], continuation: [] as HistoryContinuousPrepared[],
    observe: [] as number[][], advance: [] as number[][], recover: [] as number[]}
  const progress = new Map<number, Partial<HistoryContinuousProgress>>()
  let prepareHook: ((input: Parameters<HistoryContinuousOptions['prepare']>[0], connection: Database.Database) => Promise<HistoryContinuousPrepared>) | undefined
  let advanceHook: ((scope: HistoryContinuousScope) => Promise<void>) | undefined
  let recoverHook: ((id: number, connection: Database.Database) => unknown) | undefined
  function task(connection: Database.Database, type: string, payload: unknown, scopeId: number | null = null, status = 'queued') {
    return Number(connection.prepare('INSERT INTO creation_tasks(type,status,payload_json,scope_id) VALUES(?,?,?,?)')
      .run(type, status, JSON.stringify(payload), scopeId).lastInsertRowid)
  }
  function source(connection: Database.Database, id: number) {
    const row = connection.prepare('SELECT * FROM history_script_sources WHERE id=?').get(id) as any
    return row ? {id: row.id, platform: row.platform, deleted: !!row.deleted, revision: row.revision, scriptHash: row.script_hash} : null
  }
  function options(connection = db): HistoryContinuousOptions {
    return {database: connection, now: () => time, ownerAlive: () => true,
      queueCollection(input) {
        assert.equal(connection.inTransaction, true)
        calls.collect.push(structuredClone(input))
        return {taskId: task(connection, 'history.source', {keywords: ['history'], ...input, categories: ['regional_history']})}
      },
      recoverCollection(id) {
        assert.equal(connection.inTransaction, true, 'Original task recovery and its budget must share one transaction')
        calls.recover.push(id)
        if (recoverHook) return recoverHook(id, connection)
        connection.prepare("UPDATE creation_tasks SET status='queued',error_code=NULL,completed_at=NULL WHERE id=?").run(id)
        return {taskId: id}
      },
      source: id => source(connection, id),
      async prepare(input) {
        assert.equal(connection.inTransaction, false, 'Never await preparation under a writer reservation')
        input.assertCurrent(); calls.prepare.push(input.sourceId)
        if (prepareHook) return prepareHook(input, connection)
        const prepared = {sourceId: input.sourceId, revision: `prepared-${input.sourceId}`, scriptHash: digest(`prepared script ${input.sourceId}`)}
        connection.prepare('UPDATE history_script_sources SET revision=?,script_hash=? WHERE id=?').run(prepared.revision, prepared.scriptHash, input.sourceId)
        return prepared
      },
      queueContinuation(input) {
        assert.equal(connection.inTransaction, true)
        calls.continuation.push(structuredClone(input))
        return {taskId: task(connection, 'history.production.continue', {sourceId: input.sourceId, sourceRevision: input.revision, scriptSha256: input.scriptHash}, input.sourceId)}
      },
      observe(scope) {
        scope.assertCurrent(); calls.observe.push([...scope.sourceIds])
        return scope.members.map(member => ({sourceId: member.sourceId, scriptHash: member.scriptHash, fingerprint: 'unchanged',
          motion: {state: 'pending'}, huashengState: 'pending', ...structuredClone(progress.get(member.sourceId) || {})}))
      },
      async advance(scope) {
        assert.equal(connection.inTransaction, false); scope.assertCurrent(); calls.advance.push([...scope.sourceIds])
        if (advanceHook) await advanceHook(scope)
      }}
  }
  const config = {requestId: 'original-supply', settings: {youtubeUrls: [url], maxPendingMotion}, sourceBaseline: 100, taskBaseline: 40400}
  const initialOptions = options(), controller = createHistoryContinuousProduction(initialOptions), run = controller.start(config)
  function complete(sourceIds: number[], collectionTaskId = controller.detail(run.id).collection!.taskId, proofIds = sourceIds) {
    for (const id of sourceIds) if (!source(db, id)) db.prepare('INSERT INTO history_script_sources VALUES(?,?,?,?,?)').run(id, 'youtube', 0, `source-${id}`, digest(`collected script ${id}`))
    db.prepare("UPDATE creation_tasks SET status='succeeded',result_json=? WHERE id=?").run(JSON.stringify({sourceIds}), collectionTaskId)
    for (const id of proofIds) db.prepare("INSERT INTO creation_task_events(task_id,event_type,data_json) VALUES(?,'history.progress',?)")
      .run(collectionTaskId, JSON.stringify({currentSourceId: id}))
  }
  return {db, calls, controller, run, config, options: initialOptions, progress, task, complete,
    rateLimit(id = controller.detail(run.id).collection!.taskId, retryAfterMs?: number) {
      db.prepare("UPDATE creation_tasks SET status='failed',error_code='history_source_rate_limited',completed_at=?,updated_at=? WHERE id=?")
        .run(new Date(time).toISOString(), new Date(time).toISOString(), id)
      if (retryAfterMs !== undefined) db.prepare("INSERT INTO creation_task_events(task_id,event_type,data_json) VALUES(?,'history.rate_limit',?)")
        .run(id, JSON.stringify({retryAfterMs}))
    },
    async admit(id: number) {
      if (!controller.detail(run.id).collection) await controller.tick(run.id)
      complete([id]); return controller.tick(run.id)
    },
    advanceTime(ms = 30000) { time += ms },
    prepareWith(hook: typeof prepareHook) { prepareHook = hook }, advanceWith(hook: typeof advanceHook) { advanceHook = hook },
    recoverWith(hook: typeof recoverHook) { recoverHook = hook },
    second(overrides: Partial<HistoryContinuousOptions> = {}) {
      const connection = new Database(filename); connections.push(connection)
      return {connection, controller: createHistoryContinuousProduction({...options(connection), ...overrides})}
    },
    taskCount(type: string) { return (db.prepare('SELECT COUNT(*) AS count FROM creation_tasks WHERE type=?').get(type) as any).count as number },
  }
}

test('start snapshots settings and baselines; duplicate start and restart never create tasks', t => {
  const f = fixture(t), second = f.second()
  assert.deepEqual(second.controller.start(structuredClone(f.config)), f.run)
  assert.equal(f.taskCount('history.source'), 0)
  assert.throws(() => second.controller.start({...f.config, sourceBaseline: 99}), /different settings or baselines/)
  assert.throws(() => second.controller.start({...f.config, requestId: 'different'}), /original continuous history run/)
  f.config.settings.youtubeUrls.push('https://www.youtube.com/@Changed/videos')
  assert.deepEqual(f.controller.detail(f.run.id).settings.youtubeUrls, [url])
})

test('two real SQLite instances atomically queue exactly one collection and preserve its pointer', async t => {
  const f = fixture(t), second = f.second()
  await Promise.all([f.controller.tick(f.run.id), second.controller.tick(f.run.id)])
  const detail = f.controller.detail(f.run.id)
  assert.equal(f.taskCount('history.source'), 1); assert.ok(detail.collection!.taskId > 40400)
  assert.deepEqual(f.calls.collect, [{source: 'youtube', youtube: {urls: [url]}, targetCount: 1, existingSources: 'skip'}])
  await second.controller.tick(f.run.id)
  assert.equal(f.taskCount('history.source'), 1); assert.equal(second.controller.detail(f.run.id).collection!.taskId, detail.collection!.taskId)
})

test('collection task and pointer roll back together, then honor a durable backoff', async t => {
  const f = fixture(t)
  f.db.exec(`CREATE TRIGGER fail_pointer BEFORE INSERT ON history_continuous_collections BEGIN SELECT RAISE(ABORT,'pointer unavailable'); END;`)
  const failed = await f.controller.tick(f.run.id)
  assert.equal(f.taskCount('history.source'), 0); assert.equal(failed.collection, null); assert.match(failed.attention!, /pointer unavailable/)
  const second = f.second(); f.db.exec('DROP TRIGGER fail_pointer')
  await second.controller.tick(f.run.id); assert.equal(f.taskCount('history.source'), 0)
  f.advanceTime(); await second.controller.tick(f.run.id); assert.equal(f.taskCount('history.source'), 1)
})

test('nonterminal collections are only observed, even if their progress already contains a source', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  f.complete([101], original); f.db.prepare("UPDATE creation_tasks SET status='running' WHERE id=?").run(original)
  for (let count = 0; count < 3; count++) { f.advanceTime(); await f.controller.tick(f.run.id) }
  assert.equal(f.taskCount('history.source'), 1); assert.deepEqual(f.calls.prepare, []); assert.equal(f.controller.detail(f.run.id).members.length, 0)
})

test('only exact-task proven fresh sources are admitted and final prepared hash is queued atomically', async t => {
  const f = fixture(t), saved = await f.admit(101), member = saved.members[0]!
  assert.equal(member.phase, 'admitted'); assert.equal(member.scriptHash, digest('prepared script 101'))
  assert.equal(member.revision, 'prepared-101'); assert.ok(member.prepareIntentId); assert.ok(member.continuationTaskId! > 40400)
  assert.deepEqual(f.calls.prepare, [101]); assert.equal(f.calls.continuation[0]!.scriptHash, member.scriptHash)
  assert.deepEqual(f.calls.advance, [[101]])
  assert.equal(saved.collection!.state, 'observing'); assert.equal(f.taskCount('history.source'), 2)
})

test('unrelated progress cannot prove collection membership', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id)
  const original = f.controller.detail(f.run.id).collection!.taskId
  f.complete([101], original, [])
  f.db.prepare("INSERT INTO creation_task_events(task_id,event_type,data_json) VALUES(99999,'history.progress',?)").run(JSON.stringify({currentSourceId: 101}))
  const result = await f.controller.tick(f.run.id)
  assert.equal(result.collection!.taskId, original); assert.equal(result.collection!.state, 'attention')
  assert.equal(result.members.length, 0); assert.deepEqual(f.calls.prepare, [])
  f.advanceTime(3600000); await f.second().controller.tick(f.run.id); assert.equal(f.taskCount('history.source'), 1)
})

test('a failed saved source followed by one valid current script admits only the successful source', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const collectionTaskId = f.controller.detail(f.run.id).collection!.taskId
  f.complete([101, 102]); f.db.prepare('UPDATE history_script_sources SET script_hash=NULL WHERE id=101').run()
  const failed = f.db.prepare('SELECT * FROM history_script_sources WHERE id=101').get()
  const saved = await f.controller.tick(f.run.id)
  assert.deepEqual(saved.members.map(member => member.sourceId), [102]); assert.equal(saved.members[0]!.phase, 'admitted')
  assert.deepEqual(f.calls.prepare, [102]); assert.deepEqual(f.calls.continuation.map(input => input.sourceId), [102])
  assert.equal(f.taskCount('history.production.continue'), 1)
  assert.deepEqual(f.db.prepare('SELECT * FROM history_script_sources WHERE id=101').get(), failed)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM creation_task_events WHERE task_id=?').get(collectionTaskId) as any).count, 2)
  assert.deepEqual(JSON.parse((f.db.prepare('SELECT result_json FROM creation_tasks WHERE id=?').get(collectionTaskId) as any).result_json).sourceIds, [101, 102])
})

test('all failed saved sources leave successful inventory empty and persist a restart-safe cooldown', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  f.complete([101, 102]); f.db.prepare('UPDATE history_script_sources SET script_hash=NULL WHERE id IN (101,102)').run()
  const saved = await f.controller.tick(f.run.id)
  assert.equal(saved.collection!.state, 'settled'); assert.equal(saved.members.length, 0)
  assert.match(saved.collection!.message!, /without a valid new script/)
  assert.ok(saved.nextCollectAt > saved.updatedAt); assert.deepEqual(f.calls.prepare, []); assert.equal(f.taskCount('history.production.continue'), 0)
  await f.second().controller.tick(f.run.id)
  assert.equal(f.taskCount('history.source'), 1); assert.equal(f.controller.detail(f.run.id).collection!.taskId, original)
  f.advanceTime(); await f.controller.tick(f.run.id); assert.equal(f.taskCount('history.source'), 2)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM history_script_sources WHERE id IN (101,102)').get() as any).count, 2)
})

test('more than one valid current script retains the original collection for attention', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  f.complete([101, 102]); const saved = await f.controller.tick(f.run.id)
  assert.equal(saved.collection!.state, 'attention'); assert.equal(saved.collection!.taskId, original)
  assert.match(saved.collection!.message!, /more than one valid new script/)
  assert.equal(saved.members.length, 0); assert.deepEqual(f.calls.prepare, []); assert.equal(f.taskCount('history.production.continue'), 0)
  f.advanceTime(3600000); await f.second().controller.tick(f.run.id); assert.equal(f.taskCount('history.source'), 1)
})

test('failed saved candidates also require the exact original collection progress evidence', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id)
  f.complete([101, 102], undefined, [102]); f.db.prepare('UPDATE history_script_sources SET script_hash=NULL WHERE id=101').run()
  const saved = await f.controller.tick(f.run.id)
  assert.equal(saved.collection!.state, 'attention'); assert.equal(saved.members.length, 0); assert.deepEqual(f.calls.prepare, [])
})

test('a proven collection rate limit resumes only its original task after a restart-safe delay', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  f.rateLimit(); const scheduled = await f.controller.tick(f.run.id)
  assert.equal(scheduled.nextCollectAt - scheduled.updatedAt, 30000); assert.deepEqual(f.calls.recover, [])
  const second = f.second()
  f.advanceTime(29999); await second.controller.tick(f.run.id); assert.deepEqual(f.calls.recover, [])
  f.advanceTime(1); await Promise.all([f.controller.tick(f.run.id), second.controller.tick(f.run.id)])
  assert.deepEqual(f.calls.recover, [original]); assert.equal(f.taskCount('history.source'), 1)
  assert.equal(f.controller.detail(f.run.id).collection!.taskId, original)
  assert.equal(f.controller.detail(f.run.id).collection!.state, 'observing')
  assert.equal((f.db.prepare('SELECT status FROM creation_tasks WHERE id=?').get(original) as any).status, 'queued')
  assert.equal((f.db.prepare('SELECT attempts FROM history_source_recovery WHERE task_id=?').get(original) as any).attempts, 1)
  f.complete([101]); const completed = await second.controller.tick(f.run.id)
  assert.equal(completed.members[0]!.sourceId, 101); assert.equal(completed.members[0]!.phase, 'admitted')
})

test('three original collection recoveries consume a durable 30/60/120 second budget', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  for (const delay of [30000, 60000, 120000]) {
    f.rateLimit(); const scheduled = await f.second().controller.tick(f.run.id)
    assert.equal(scheduled.nextCollectAt - scheduled.updatedAt, delay)
    const before = f.calls.recover.length
    f.advanceTime(delay - 1); await f.second().controller.tick(f.run.id); assert.equal(f.calls.recover.length, before)
    f.advanceTime(1); await f.second().controller.tick(f.run.id); assert.equal(f.calls.recover.length, before + 1)
  }
  f.rateLimit(); const exhausted = await f.second().controller.tick(f.run.id)
  assert.equal(exhausted.collection!.taskId, original); assert.equal(exhausted.collection!.state, 'attention')
  assert.match(exhausted.collection!.message!, /recovery budget exhausted/)
  f.advanceTime(3600000); await f.second().controller.tick(f.run.id)
  assert.deepEqual(f.calls.recover, [original, original, original]); assert.equal(f.taskCount('history.source'), 1)
  const state = f.db.prepare('SELECT * FROM history_source_recovery WHERE task_id=?').get(original) as any
  assert.equal(state.attempts, 3); assert.equal(state.state, 'exhausted')
})

test('the original task Retry-After delays recovery and unrelated failed tasks remain untouched', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  const unrelated = f.task(f.db, 'history.source', {source: 'youtube'}, null, 'failed')
  f.rateLimit(unrelated, 1); f.rateLimit(original, 600000)
  const saved = await f.controller.tick(f.run.id)
  assert.equal(saved.nextCollectAt - saved.updatedAt, 600000)
  f.advanceTime(599999); await f.second().controller.tick(f.run.id); assert.deepEqual(f.calls.recover, [])
  f.advanceTime(1); await f.second().controller.tick(f.run.id)
  assert.deepEqual(f.calls.recover, [original]); assert.equal(f.taskCount('history.source'), 2)
  assert.equal((f.db.prepare('SELECT status FROM creation_tasks WHERE id=?').get(unrelated) as any).status, 'failed')
  assert.equal(f.db.prepare('SELECT 1 FROM history_source_recovery WHERE task_id=?').get(unrelated), undefined)
})

for (const update of ["cancel_requested=1", "status='canceled',cancel_requested=1", "error_code='unknown_remote_result'"]) {
  test(`a scheduled collection recovery respects ${update}`, async t => {
    const f = fixture(t)
    await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
    f.rateLimit(); await f.controller.tick(f.run.id)
    f.db.prepare(`UPDATE creation_tasks SET ${update} WHERE id=?`).run(original)
    f.advanceTime(3600000); const saved = await f.second().controller.tick(f.run.id)
    assert.equal(saved.collection!.taskId, original); assert.equal(saved.collection!.state, 'attention')
    assert.deepEqual(f.calls.recover, []); assert.equal(f.taskCount('history.source'), 1)
  })
}

test('a persisted stop fences a due collection recovery until explicit resume', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  f.rateLimit(); await f.controller.tick(f.run.id); f.controller.stop(f.run.id)
  f.advanceTime(120000); const second = f.second()
  await second.controller.tick(f.run.id); assert.deepEqual(f.calls.recover, [])
  second.controller.start(f.config); await second.controller.tick(f.run.id); assert.deepEqual(f.calls.recover, [])
  second.controller.resume(f.run.id); await second.controller.tick(f.run.id)
  assert.deepEqual(f.calls.recover, [original]); assert.equal(f.taskCount('history.source'), 1)
})

test('collection recovery side effects and budget roll back together if checkpoint persistence fails', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  f.rateLimit(); await f.controller.tick(f.run.id)
  f.db.exec(`CREATE TRIGGER fail_recovery_budget BEFORE UPDATE ON history_source_recovery
    WHEN NEW.state='resumed' BEGIN SELECT RAISE(ABORT,'recovery checkpoint unavailable'); END;`)
  f.advanceTime(); const failed = await f.controller.tick(f.run.id)
  assert.equal(failed.collection!.state, 'attention'); assert.match(failed.collection!.message!, /recovery checkpoint unavailable/)
  assert.equal((f.db.prepare('SELECT status FROM creation_tasks WHERE id=?').get(original) as any).status, 'failed')
  assert.equal((f.db.prepare('SELECT attempts FROM history_source_recovery WHERE task_id=?').get(original) as any).attempts, 0)
  f.db.exec('DROP TRIGGER fail_recovery_budget'); f.advanceTime(); await f.second().controller.tick(f.run.id)
  assert.equal((f.db.prepare('SELECT status FROM creation_tasks WHERE id=?').get(original) as any).status, 'queued')
  assert.equal((f.db.prepare('SELECT attempts FROM history_source_recovery WHERE task_id=?').get(original) as any).attempts, 1)
  assert.equal((f.db.prepare('SELECT state FROM history_continuous_collections WHERE task_id=?').get(original) as any).state, 'observing')
  assert.equal(f.taskCount('history.source'), 1)
})

test('a recovery that queues a replacement instead of the original task is rolled back', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  f.rateLimit(); await f.controller.tick(f.run.id)
  f.recoverWith((_id, connection) => ({taskId: f.task(connection, 'history.source', {source: 'youtube'})}))
  f.advanceTime(); const saved = await f.controller.tick(f.run.id)
  assert.equal(saved.collection!.taskId, original); assert.equal(saved.collection!.state, 'attention')
  assert.match(saved.collection!.message!, /did not queue the original task/)
  assert.equal(f.taskCount('history.source'), 1)
  assert.equal((f.db.prepare('SELECT attempts FROM history_source_recovery WHERE task_id=?').get(original) as any).attempts, 0)
})

test('recovery requires the original collection payload and durable run membership', async t => {
  for (const change of ['payload', 'membership']) {
    const f = fixture(t)
    await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
    f.rateLimit(); await f.controller.tick(f.run.id)
    if (change === 'payload') f.db.prepare('UPDATE creation_tasks SET payload_json=? WHERE id=?')
      .run(JSON.stringify({source: 'youtube', youtube: {urls: [url]}, targetCount: 3, existingSources: 'skip'}), original)
    else f.db.prepare('UPDATE history_continuous_collections SET run_id=? WHERE task_id=?').run('another-run', original)
    f.advanceTime(); const saved = await f.second().controller.tick(f.run.id)
    assert.equal(saved.collection!.state, 'attention'); assert.deepEqual(f.calls.recover, []); assert.equal(f.taskCount('history.source'), 1)
  }
})

test('an absent recovery dependency leaves a rate-limited original task for attention', async t => {
  const f = fixture(t), second = f.second({recoverCollection: undefined})
  await second.controller.tick(f.run.id); const original = second.controller.detail(f.run.id).collection!.taskId
  f.rateLimit(); const saved = await second.controller.tick(f.run.id)
  assert.equal(saved.collection!.state, 'attention'); assert.equal(saved.collection!.taskId, original)
  f.advanceTime(3600000); await second.controller.tick(f.run.id)
  assert.deepEqual(f.calls.recover, []); assert.equal(f.taskCount('history.source'), 1)
})

for (const status of ['running', 'stale', 'failed', 'unknown', 'succeeded']) test(`an original ${status} task with no result is never replaced`, async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); const original = f.controller.detail(f.run.id).collection!.taskId
  f.db.prepare('UPDATE creation_tasks SET status=? WHERE id=?').run(status, original)
  for (let count = 0; count < 4; count++) { f.advanceTime(3600000); await f.second().controller.tick(f.run.id) }
  assert.equal(f.taskCount('history.source'), 1); assert.equal(f.controller.detail(f.run.id).collection!.taskId, original)
  assert.deepEqual(f.calls.prepare, [])
})

test('empty terminal collections use persistent exponential cooldown instead of a tight replacement loop', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); f.complete([])
  let detail = await f.controller.tick(f.run.id)
  assert.equal(f.taskCount('history.source'), 1); const firstWait = detail.nextCollectAt - detail.updatedAt
  await f.second().controller.tick(f.run.id); assert.equal(f.taskCount('history.source'), 1)
  f.advanceTime(); await f.controller.tick(f.run.id); assert.equal(f.taskCount('history.source'), 2)
  f.complete([]); detail = await f.controller.tick(f.run.id)
  assert.equal(detail.nextCollectAt - detail.updatedAt, 2 * firstWait)
  f.advanceTime(); await f.controller.tick(f.run.id); assert.equal(f.taskCount('history.source'), 2)
})

test('sources at or below the explicit baseline are never admitted', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); f.complete([100]); const result = await f.controller.tick(f.run.id)
  assert.equal(result.members.length, 0); assert.equal(f.taskCount('history.source'), 1); assert.deepEqual(f.calls.prepare, [])
})

test('unsubmitted Motion outputs cap inventory at two even when Huasheng completes', async t => {
  const f = fixture(t)
  await f.admit(101); await f.admit(102)
  for (const id of [101, 102]) f.progress.set(id, {motion: {state: 'ready'}, huashengState: 'completed'})
  for (let count = 0; count < 5; count++) { f.advanceTime(); await f.controller.tick(f.run.id) }
  assert.equal(f.taskCount('history.source'), 2); assert.equal(f.controller.detail(f.run.id).members.filter(m => m.motionReceiptId === null).length, 2)
})

test('a verified Motion receipt releases inventory despite independent Huasheng attention', async t => {
  const f = fixture(t)
  await f.admit(101); await f.admit(102)
  f.progress.set(101, {motion: {state: 'submitted', receiptId: 'original-motion-receipt'}, huashengState: 'attention'})
  f.advanceTime(); const saved = await f.controller.tick(f.run.id)
  assert.equal(f.taskCount('history.source'), 3); assert.equal(saved.members[0]!.motionReceiptId, 'original-motion-receipt')
  assert.deepEqual(f.calls.advance.at(-1), [102], 'Independent Huasheng attention does not block new Motion work')
})

test('a submitted flag without its validated receipt does not release inventory', async t => {
  const f = fixture(t)
  await f.admit(101); await f.admit(102)
  f.progress.set(101, {motion: {state: 'submitted'}})
  await assert.rejects(f.controller.tick(f.run.id), /Validated original Motion submission receipt/)
  assert.equal(f.taskCount('history.source'), 2); assert.equal(f.controller.detail(f.run.id).members[0]!.motionReceiptId, null)
})

test('same-fingerprint idempotent passes poll again after 30 seconds, including across restart', async t => {
  const f = fixture(t)
  await f.admit(101); assert.equal(f.calls.advance.length, 1)
  await f.second().controller.tick(f.run.id); assert.equal(f.calls.advance.length, 1)
  f.advanceTime(); await f.second().controller.tick(f.run.id); assert.equal(f.calls.advance.length, 2)
  assert.deepEqual(f.calls.advance[0], f.calls.advance[1])
})

test('failed advance reconciles the original tasks before a bounded retry, without new continuation tasks', async t => {
  const f = fixture(t)
  f.advanceWith(async () => { throw Error('Original platform request outcome is unknown') })
  await f.admit(101); const originalContinuations = f.taskCount('history.production.continue')
  assert.equal(f.calls.advance.length, 1)
  await f.second().controller.tick(f.run.id); assert.equal(f.calls.advance.length, 1)
  f.advanceTime(); await f.second().controller.tick(f.run.id)
  assert.equal(f.calls.advance.length, 2); assert.equal(f.taskCount('history.production.continue'), originalContinuations)
  assert.ok(f.calls.observe.length >= 3)
  f.advanceTime(); await f.controller.tick(f.run.id); assert.equal(f.calls.advance.length, 2, 'Second failure doubles the persisted wait')
})

test('admitted bookkeeping revision changes continue, but actual script hash drift stops that source', async t => {
  const f = fixture(t)
  await f.admit(101)
  f.db.prepare('UPDATE history_script_sources SET revision=? WHERE id=101').run('delivery bookkeeping changed')
  f.advanceTime(); await f.controller.tick(f.run.id)
  assert.equal(f.controller.detail(f.run.id).members[0]!.phase, 'admitted'); assert.equal(f.calls.advance.length, 2)
  f.db.prepare('UPDATE history_script_sources SET script_hash=? WHERE id=101').run(digest('a different manuscript'))
  f.advanceTime(); const saved = await f.controller.tick(f.run.id)
  assert.equal(saved.members[0]!.phase, 'attention'); assert.equal(f.calls.advance.length, 2)
  assert.equal(f.taskCount('history.production.continue'), 1)
})

test('deleted admitted source is fenced out without adopting another manuscript', async t => {
  const f = fixture(t)
  await f.admit(101); f.db.prepare('UPDATE history_script_sources SET deleted=1 WHERE id=101').run()
  f.advanceTime(); const saved = await f.controller.tick(f.run.id)
  assert.equal(saved.members[0]!.phase, 'attention'); assert.equal(f.calls.advance.length, 1)
})

test('prepared revision/hash drift before admission cannot queue a continuation', async t => {
  const f = fixture(t)
  f.prepareWith(async input => ({sourceId: input.sourceId, revision: 'not the current source', scriptHash: digest('unrelated')}))
  const saved = await f.admit(101)
  assert.equal(saved.members[0]!.phase, 'attention'); assert.equal(f.taskCount('history.production.continue'), 0)
})

test('continuation queue and final hash binding roll back atomically', async t => {
  const f = fixture(t)
  f.db.exec(`CREATE TRIGGER reject_admission BEFORE UPDATE ON history_continuous_members
    WHEN json_extract(NEW.snapshot,'$.phase')='admitted' BEGIN SELECT RAISE(ABORT,'binding unavailable'); END;`)
  const saved = await f.admit(101)
  assert.equal(f.taskCount('history.production.continue'), 0); assert.equal(saved.members[0]!.continuationTaskId, null)
  assert.equal(saved.members[0]!.phase, 'attention'); assert.match(saved.members[0]!.message!, /binding unavailable/)
  await f.second().controller.tick(f.run.id); assert.deepEqual(f.calls.prepare, [101])
})

test('an active continuation with a different hash is refused, while same-hash older metadata is reusable', async t => {
  for (const correct of [false, true]) {
    const f = fixture(t)
    f.options.queueContinuation = input => ({taskId: f.task(f.db, 'history.production.continue',
      {sourceId: input.sourceId, sourceRevision: 'older bookkeeping', scriptSha256: correct ? input.scriptHash : digest('stale manuscript')}, input.sourceId, 'running')})
    const saved = await f.admit(101)
    assert.equal(saved.members[0]!.phase, correct ? 'admitted' : 'attention')
    assert.equal(f.taskCount('history.production.continue'), correct ? 1 : 0)
  }
})

test('live owners remain fenced despite arbitrarily old clocks and an unresponsive liveness probe', async t => {
  const f = fixture(t)
  let resolve!: (value: HistoryContinuousPrepared) => void, started!: () => void
  const entered = new Promise<void>(done => { started = done })
  f.prepareWith(input => { started(); return new Promise(done => { resolve = done }) })
  await f.controller.tick(f.run.id); f.complete([101])
  const active = f.controller.tick(f.run.id); await entered
  const second = f.second({ownerAlive: () => { throw Error('liveness scan timed out') }})
  f.advanceTime(365 * 24 * 3600000)
  const busy = await second.controller.tick(f.run.id)
  assert.equal(busy.busy, true); assert.deepEqual(f.calls.prepare, [101]); assert.equal(f.taskCount('history.production.continue'), 0)
  f.controller.stop(f.run.id)
  resolve({sourceId: 101, revision: 'source-101', scriptHash: digest('unused')}); await active
})

test('stop persists across restart and fences admission when preparation is already in flight', async t => {
  const f = fixture(t)
  let resolve!: (value: HistoryContinuousPrepared) => void, started!: () => void
  const entered = new Promise<void>(done => { started = done })
  f.prepareWith(() => { started(); return new Promise(done => { resolve = done }) })
  await f.controller.tick(f.run.id); f.complete([101]); const active = f.controller.tick(f.run.id); await entered
  const second = f.second(); second.controller.stop(f.run.id)
  assert.equal(second.controller.start(f.config).status, 'paused')
  resolve({sourceId: 101, revision: 'source-101', scriptHash: digest('unused')}); await active
  await second.controller.tick(f.run.id)
  assert.equal(f.taskCount('history.source'), 1); assert.equal(f.taskCount('history.production.continue'), 0)
  assert.equal(f.controller.detail(f.run.id).status, 'paused')
})

test('dead-owner preparation outcomes remain attached to the original intent without paid resubmission', async t => {
  const f = fixture(t)
  await f.controller.tick(f.run.id); f.complete([101])
  f.prepareWith(async () => { throw Error('original preparation result is unknown') })
  const original = await f.controller.tick(f.run.id), member = original.members[0]!
  member.phase = 'preparing'; member.message = null
  f.db.prepare('UPDATE history_continuous_members SET snapshot=? WHERE source_id=101').run(JSON.stringify(member))
  f.db.prepare('UPDATE history_continuous_production SET owner_pid=99999999,owner_token=? WHERE id=?').run('dead-owner', f.run.id)
  const result = await f.second({ownerAlive: () => false}).controller.tick(f.run.id)
  assert.equal(result.members[0]!.phase, 'attention'); assert.equal(result.members[0]!.prepareIntentId, member.prepareIntentId)
  assert.deepEqual(f.calls.prepare, [101]); assert.equal(f.taskCount('history.production.continue'), 0)
})

test('advance receives only recorded source/hash scope and its fence detects a concurrent stop', async t => {
  const f = fixture(t)
  f.advanceWith(async scope => {
    assert.deepEqual(scope.sourceIds, [101]); assert.deepEqual(Object.keys(scope.scriptHashes), ['101'])
    f.controller.stop(f.run.id); assert.throws(scope.assertCurrent, /owner or stop fence/)
  })
  const saved = await f.admit(101)
  assert.equal(saved.status, 'paused'); assert.equal(f.taskCount('history.source'), 1)
})

test('inventory cap is configurable through eight, never beyond it', t => {
  const f = fixture(t, 8); assert.equal(f.run.settings.maxPendingMotion, 8)
  assert.throws(() => f.controller.start({...f.config, settings: {...f.config.settings, maxPendingMotion: 9}}), /between 1 and 8/)
})

test('configured inventory eight admits one source per tick and stops at the bounded cap', async t => {
  const f = fixture(t, 8)
  for (let id = 101; id <= 108; id++) await f.admit(id)
  assert.equal(f.taskCount('history.source'), 8); assert.equal(f.calls.prepare.length, 8)
  f.advanceTime(); await f.controller.tick(f.run.id)
  assert.equal(f.taskCount('history.source'), 8); assert.ok(f.calls.advance.every(scope => scope.length <= 8))
})

test('successive verified Motion deliveries keep refilling without resetting the original run', async t => {
  const f = fixture(t)
  await f.admit(101); await f.admit(102)
  for (const id of [101, 102, 103]) {
    f.progress.set(id, {motion: {state: 'published', receiptId: `original-receipt-${id}`}, huashengState: 'attention'})
    f.advanceTime(); await f.second().controller.tick(f.run.id)
    await f.admit(id + 2)
  }
  const saved = f.controller.detail(f.run.id)
  assert.equal(saved.id, f.run.id); assert.equal(saved.members.length, 5)
  assert.equal(saved.members.filter(member => member.motionReceiptId === null).length, 2)
  assert.equal(f.taskCount('history.source'), 5); assert.equal(new Set(f.calls.prepare).size, 5)
})

test('a crashed advance first observes its original scoped jobs and resumes only after its persisted poll time', async t => {
  const f = fixture(t)
  await f.admit(101)
  const snapshot = f.controller.detail(f.run.id)
  const stored = JSON.parse((f.db.prepare('SELECT snapshot FROM history_continuous_production WHERE id=?').get(f.run.id) as any).snapshot)
  stored.advanceInFlight = true
  f.db.prepare('UPDATE history_continuous_production SET snapshot=?,owner_pid=99999999,owner_token=? WHERE id=?')
    .run(JSON.stringify(stored), 'crashed-pass', f.run.id)
  const second = f.second({ownerAlive: () => false}), observes = f.calls.observe.length
  await second.controller.tick(f.run.id)
  assert.equal(f.calls.observe.length, observes + 1); assert.equal(f.calls.advance.length, 1)
  f.advanceTime(); await second.controller.tick(f.run.id)
  assert.equal(f.calls.advance.length, 2); assert.equal(f.taskCount('history.production.continue'), 1)
  assert.equal(second.controller.detail(f.run.id).members[0]!.continuationTaskId, snapshot.members[0]!.continuationTaskId)
})
