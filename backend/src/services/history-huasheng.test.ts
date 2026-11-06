import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HistoryHuashengService, HuashengQueueError, type HistoryHuashengOptions, type HuashengBrowserDriver, type HuashengSourceSnapshot } from './history-huasheng.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(t: TestContext, overrides: Partial<HuashengBrowserDriver> = {}, settings: Pick<HistoryHuashengOptions, 'productionTimeoutMs' | 'pollMs'> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'history-huasheng-test-'))
  const databasePath = join(directory, 'queue.db')
  const sources = new Map<number, HuashengSourceSnapshot>([
    [1, { id: 1, title: '历史故事一', script: '第一篇二创文稿\n保留原样。' }],
    [2, { id: 2, title: '历史故事二', script: '第二篇二创文稿。' }],
  ])
  const calls = { load: 0, status: 0, open: 0, run: 0 }
  const driver: HuashengBrowserDriver = {
    getHuashengBrowserStatus: async () => { calls.status++; return { status: 'ready', message: '已登录' } },
    openHuashengBrowser: async () => { calls.open++; return { status: 'login_required', message: '请登录' } },
    runHuashengBrowserJob: async input => { calls.run++; return { projectUrl: `https://www.huasheng.cn/project/${input.jobId}` } },
    ...overrides,
  }
  const options = {
    databasePath, driver, heartbeatMs: 10, ...settings,
    loadSource: (id: number) => {
      calls.load++
      const source = sources.get(id)
      if (!source) throw new HuashengQueueError('历史文稿不存在', 404)
      return source
    },
  }
  const queue = new HistoryHuashengService(options)
  t.after(() => queue.close())
  return { directory, databasePath, sources, calls, driver, options, queue }
}

test('deleted sources leave production lists, counts and checks without removing historical jobs', async t => {
  const inspected: string[] = []
  const f = fixture(t, { inspectHuashengProject: async input => {
    inspected.push(input.projectUrl)
    return { status: 'completed', message: '可导出' }
  } })
  f.sources.set(3, { id: 3, title: '已删除的新稿', script: '第三篇二创文稿。' })
  const oldest = (await f.queue.enqueue(1))!
  const visible = (await f.queue.enqueue(2))!
  const newest = (await f.queue.enqueue(3))!
  const db = new Database(f.databasePath)
  t.after(() => db.close())
  db.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY, deleted_at TEXT);
    INSERT INTO history_script_sources(id) VALUES(1),(2),(3);
    UPDATE history_huasheng_jobs SET status='canceled', project_url='https://www.huasheng.cn/video/' || id;`)
  assert.equal(f.queue.listJobs().length, 3)
  db.exec("UPDATE history_script_sources SET deleted_at='2026-10-27T07:13:13.382Z' WHERE id IN (1,3)")

  const overview = await f.queue.overview({ limit: 1 })
  assert.deepEqual(overview.jobs.map(job => job.id), [visible.id], 'filter before pagination and retain canceled jobs for live sources')
  assert.deepEqual(overview.counts, { canceled: 1 })
  assert.equal(overview.nextBeforeId, visible.id)
  assert.deepEqual(f.queue.listJobs(undefined, { beforeId: visible.id }), [])
  assert.deepEqual(f.queue.listJobs(1), [])
  assert.deepEqual(f.queue.listJobs(3), [])
  assert.equal(f.queue.getJob(newest.id).sourceId, 3, 'historical records remain readable by job id')
  assert.equal(f.queue.getJob(oldest.id).sourceId, 1)

  f.queue.checkProduction(undefined, { jobIds: [oldest.id, visible.id, newest.id] })
  await productionFinished(f.queue)
  assert.deepEqual(inspected, [`https://www.huasheng.cn/video/${visible.id}`])
  assert.equal(f.queue.getJob(oldest.id).productionCheckedAt, null)
  assert.equal(f.queue.getJob(newest.id).productionCheckedAt, null)
  assert.equal(f.calls.run, 0)
  assert.equal(f.calls.open, 0)
})

test('production defaults to not started and a durable submission records creating without claiming completion', async t => {
  const f = fixture(t, { runHuashengBrowserJob: async input => {
    await input.onCheckpoint({ checkpoint: 'submitted', projectUrl: 'https://www.huasheng.cn/video/123', message: '平台已接收，等待成片' })
    assert.equal(f.queue.getJob(Number(input.jobId)).productionStatus, 'creating')
    throw new Error('acknowledgement already saved')
  } })
  const job = (await f.queue.enqueue(1))!
  assert.equal(job.productionStatus, 'not_started')
  assert.equal(job.productionCheckedAt, null)
  assert.equal(job.productionMessage, '')
  assert.equal(job.productionCheckError, null)
  await f.queue.runPending()
  const other = new HistoryHuashengService(f.options)
  t.after(() => other.close())
  const stored = other.getJob(job.id)
  assert.equal(stored.productionStatus, 'creating')
  assert.equal(stored.productionCheckedAt, null, 'submission is not an observer check')
  assert.equal(stored.message, '平台已接收，等待成片')
  assert.equal(stored.status, 'submitted')
})

async function productionFinished(queue: HistoryHuashengService) {
  const deadline = Date.now() + 3000
  while (queue.productionChecking) {
    if (Date.now() > deadline) throw new Error('production check did not finish')
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

test('state sync discovers an unbound create_pending project and inspects it without resubmitting', async t => {
  let discoveries = 0
  const f = fixture(t, {
    discoverHuashengProject: async input => {
      discoveries++
      assert.equal(input.script, f.sources.get(1)!.script)
      return { projectUrl: 'https://www.huasheng.cn/video/123', message: '已按完整原稿找回项目' }
    },
    inspectHuashengProject: async input => {
      assert.equal(input.projectUrl, 'https://www.huasheng.cn/video/123')
      return { status: 'completed', message: '视频已完成' }
    },
  })
  const job = (await f.queue.enqueue(1))!
  const sql = new Database(f.databasePath); t.after(() => sql.close())
  sql.prepare("UPDATE history_huasheng_jobs SET status='needs_attention',stage='needs_attention',checkpoint='create_pending',error='创建结果不明' WHERE id=?").run(job.id)
  const result = await f.queue.syncProduction(1)
  assert.equal(discoveries, 1)
  assert.equal(result.jobs[0]!.id, job.id)
  assert.equal(result.jobs[0]!.projectUrl, 'https://www.huasheng.cn/video/123')
  assert.equal(result.jobs[0]!.productionStatus, 'completed')
  assert.equal(result.jobs[0]!.status, 'submitted')
  assert.equal(f.calls.run, 0)
})

test('unresolved project discovery preserves the original checkpoint and returns its cause', async t => {
  const f = fixture(t, { discoverHuashengProject: async () => ({ projectUrl: null, message: '发现多个一致项目，请核对原项目' }) })
  const job = (await f.queue.enqueue(1))!
  const sql = new Database(f.databasePath); t.after(() => sql.close())
  sql.prepare("UPDATE history_huasheng_jobs SET status='needs_attention',stage='needs_attention',checkpoint='create_pending' WHERE id=?").run(job.id)
  await f.queue.syncProduction(1)
  const current = f.queue.getJob(job.id)
  assert.equal(current.projectUrl, null)
  assert.equal(current.checkpoint, 'create_pending')
  assert.equal(current.status, 'needs_attention')
  assert.match(current.productionCheckError!, /多个/)
  assert.equal(f.calls.run, 0)
})

test('discovery cannot overwrite a project associated while its read was in flight', async t => {
  const entered = deferred(), release = deferred()
  const f = fixture(t, {
    discoverHuashengProject: async () => {
      entered.resolve(); await release.promise
      return { projectUrl: 'https://www.huasheng.cn/video/123', message: '找到旧检查中的项目' }
    },
    inspectHuashengProject: async () => assert.fail('a stale discovery must not inspect or alter a newly associated project'),
  })
  const job = (await f.queue.enqueue(1))!
  const sql = new Database(f.databasePath); t.after(() => sql.close())
  sql.prepare("UPDATE history_huasheng_jobs SET status='needs_attention',checkpoint='create_pending' WHERE id=?").run(job.id)
  const synced = f.queue.syncProduction(1)
  await entered.promise
  sql.prepare("UPDATE history_huasheng_jobs SET project_url='https://www.huasheng.cn/video/456',status='running',owner='another-worker' WHERE id=?").run(job.id)
  release.resolve(); await synced
  const current = f.queue.getJob(job.id)
  assert.equal(current.projectUrl, 'https://www.huasheng.cn/video/456')
  assert.equal(current.status, 'running')
  assert.equal(f.calls.run, 0)
})

test('production checks persist all four platform states, skip unbound jobs and never submit work', async t => {
  const states = ['not_started', 'queued', 'creating', 'completed'] as const
  const inspected: string[] = []
  const f = fixture(t, { inspectHuashengProject: async input => {
    inspected.push(input.projectUrl)
    const status = states[Number(input.projectUrl.split('/').at(-1)) - 1]!
    return { status, message: `平台状态 ${status}` }
  } })
  for (let id = 1; id <= 5; id++) {
    f.sources.set(id, { id, title: `文稿${id}`, script: `正文${id}` })
    await f.queue.enqueue(id)
  }
  // Restore associated projects without running any browser/create path.
  const db = new Database(f.databasePath)
  db.prepare("UPDATE history_huasheng_jobs SET project_url = 'https://www.huasheng.cn/video/' || id WHERE id <= 4").run()
  db.close()
  assert.deepEqual(f.queue.checkProduction(), { checking: true })
  await productionFinished(f.queue)
  assert.equal(inspected.length, 4)
  const other = new HistoryHuashengService(f.options)
  t.after(() => other.close())
  for (let id = 1; id <= 4; id++) {
    const stored = other.getJob(id)
    assert.equal(stored.productionStatus, states[id - 1])
    assert.ok(stored.productionCheckedAt)
    assert.equal(stored.productionMessage, `平台状态 ${states[id - 1]}`)
    assert.equal(stored.productionCheckError, null)
    assert.equal(stored.status, states[id - 1] === 'not_started' ? 'queued' : 'submitted')
  }
  assert.equal(other.getJob(5).productionStatus, 'not_started')
  assert.equal(other.getJob(5).productionCheckedAt, null)
  assert.equal(f.calls.run, 0)
  assert.equal(f.calls.open, 0)
})

test('verified platform progress settles obsolete creation blockers and resume cannot resubmit accepted work', async t => {
  for (const status of ['queued', 'creating', 'completed'] as const) {
    const f = fixture(t, { inspectHuashengProject: async () => ({ status, message: `最新平台状态：${status}` }) })
    const job = (await f.queue.enqueue(1))!
    const unselected = (await f.queue.enqueue(2))!
    const db = new Database(f.databasePath)
    db.exec(`UPDATE history_huasheng_jobs SET status='needs_attention', stage='needs_attention', checkpoint='quota_waiting',
      project_url='https://www.huasheng.cn/video/' || id, message='花生今日标准模式额度已用完', error='花生今日标准模式额度已用完'`)
    f.queue.checkProduction(undefined, { jobIds: [job.id] })
    await productionFinished(f.queue)
    const stored = f.queue.getJob(job.id)
    assert.equal(stored.productionStatus, status)
    assert.equal(stored.status, 'submitted')
    assert.equal(stored.stage, 'submitted')
    assert.equal(stored.checkpoint, 'submitted')
    assert.equal(stored.error, null)
    assert.equal(stored.message, stored.productionMessage)
    assert.equal(f.queue.getJob(unselected.id).status, 'needs_attention')
    assert.equal((await f.queue.overview()).counts.needs_attention, 1)
    assert.equal((db.prepare('SELECT error FROM history_huasheng_jobs WHERE id=?').get(job.id) as { error: string | null }).error, null)
    db.close()
    assert.deepEqual(await f.queue.resume(job.id), stored)
    assert.equal(f.calls.run, 0)
    assert.equal(f.calls.open, 0)
    assert.equal(f.queue.monitoring.enabled, false)
  }
})

test('opening the store repairs verified stale blockers without browser work or overwriting newer failures and user intent', async t => {
  const f = fixture(t)
  const checkedAt = '2026-10-23T15:28:30.613Z'
  const db = new Database(f.databasePath)
  const cases = [
    { expected: 'submitted' },
    { status: 'canceled', expected: 'canceled' },
    { status: 'running', expected: 'running' },
    { updatedAt: '2026-10-23T15:29:00.000Z', expected: 'needs_attention' },
    { checkError: '最新检查登录失效', expected: 'needs_attention' },
    { productionStatus: 'not_started', expected: 'needs_attention' },
    { projectUrl: '', expected: 'needs_attention' },
    { cancelRequested: 1, expected: 'needs_attention' },
    { checkedAt: null, expected: 'needs_attention' },
  ]
  for (const [index, scenario] of cases.entries()) {
    const id = index + 1
    f.sources.set(id, { id, title: `文稿${id}`, script: `正文${id}` })
    const job = (await f.queue.enqueue(id))!
    db.prepare(`UPDATE history_huasheng_jobs SET status=?, stage='needs_attention', checkpoint='quota_waiting',
      project_url=?, production_status=?, production_message='花生已允许下载成片', production_checked_at=?,
      production_check_error=?, message='标准模式额度已用完', error='标准模式额度已用完', updated_at=?, cancel_requested=? WHERE id=?`)
      .run(scenario.status ?? 'needs_attention', scenario.projectUrl ?? `https://www.huasheng.cn/video/${id}`,
        scenario.productionStatus ?? 'completed', 'checkedAt' in scenario ? scenario.checkedAt : checkedAt,
        scenario.checkError ?? null, scenario.updatedAt ?? checkedAt, scenario.cancelRequested ?? 0, job.id)
  }
  db.close()
  const reopened = new HistoryHuashengService(f.options)
  t.after(() => reopened.close())
  for (const [index, scenario] of cases.entries()) {
    const job = reopened.getJob(index + 1)
    assert.equal(job.status, scenario.expected, `case ${index}`)
    assert.equal(job.error, index === 0 ? null : '标准模式额度已用完')
    assert.equal(job.updatedAt, scenario.updatedAt ?? checkedAt)
  }
  const repaired = reopened.listJobs().find(job => job.id === 1)!
  assert.equal(repaired.message, '花生已允许下载成片')
  assert.equal(repaired.checkpoint, 'submitted')
  assert.deepEqual(f.calls, { load: cases.length, status: 0, open: 0, run: 0 })
  assert.equal(reopened.monitoring.enabled, false)
})

test('selected inspection does not expand to other projects or versions of the same source', async t => {
  const inspected: string[] = []
  const f = fixture(t, { inspectHuashengProject: async input => {
    inspected.push(input.projectUrl)
    return { status: 'queued', message: '排队中' }
  } })
  const older = (await f.queue.enqueue(1))!
  f.sources.get(1)!.script = '同稿的另一个版本'
  const selected = (await f.queue.enqueue(1))!
  const other = (await f.queue.enqueue(2))!
  const db = new Database(f.databasePath)
  db.prepare("UPDATE history_huasheng_jobs SET project_url='https://www.huasheng.cn/video/' || id").run()
  db.close()
  f.queue.checkProduction(undefined, { jobIds: [selected.id, selected.id] })
  await productionFinished(f.queue)
  assert.deepEqual(inspected, [`https://www.huasheng.cn/video/${selected.id}`])
  assert.equal(f.queue.getJob(selected.id).productionStatus, 'queued')
  assert.equal(f.queue.getJob(older.id).productionCheckedAt, null)
  assert.equal(f.queue.getJob(other.id).productionCheckedAt, null)
  assert.equal(f.calls.run, 0)
  assert.equal(f.calls.open, 0)
  assert.equal(f.queue.monitoring.enabled, false)
  assert.throws(() => f.queue.checkProduction(undefined, { jobIds: [] }), /至少选择/)
  assert.throws(() => f.queue.checkProduction(undefined, { jobIds: [0] }), /编号无效/)
  assert.equal(inspected.length, 1)
})

test('manual status check reconnects a closed dedicated browser once and completes the original check without submitting', async t => {
  let connected = false
  let opened = 0
  const inspected: string[] = []
  const f = fixture(t, {
    inspectHuashengProject: async input => {
      inspected.push(input.projectUrl)
      if (!connected) throw Object.assign(new Error('花生专用浏览器未连接，请打开登录窗口'), { code: 'browser_unavailable' })
      return { status: 'completed', message: '花生成片可下载' }
    },
    openHuashengBrowser: async () => { opened++; connected = true; return { status: 'ready', message: '已复用登录' } },
  })
  const selected = (await f.queue.enqueue(1))!
  const unselected = (await f.queue.enqueue(2))!
  const db = new Database(f.databasePath)
  db.exec("UPDATE history_huasheng_jobs SET project_url='https://www.huasheng.cn/video/' || id, checkpoint='scheme_pending'")
  db.close()
  f.queue.checkProduction(1)
  await productionFinished(f.queue)
  assert.equal(opened, 1)
  assert.deepEqual(inspected, [`https://www.huasheng.cn/video/${selected.id}`, `https://www.huasheng.cn/video/${selected.id}`])
  assert.equal(f.queue.getJob(selected.id).productionStatus, 'completed')
  assert.equal(f.queue.getJob(selected.id).productionCheckError, null)
  assert.equal(f.queue.getJob(selected.id).status, 'submitted')
  assert.equal(f.queue.getJob(unselected.id).productionCheckedAt, null)
  assert.equal(f.calls.run, 0)
  assert.equal(f.queue.monitoring.enabled, false)
})

test('automatic checks never relaunch a closed browser, while a manual batch opens at most one login window', async t => {
  let opened = 0
  const f = fixture(t, {
    inspectHuashengProject: async () => { throw Object.assign(new Error('花生专用浏览器未连接'), { code: 'browser_unavailable' }) },
    openHuashengBrowser: async () => { opened++; return { status: 'login_required', message: '请扫码登录花生' } },
  })
  await f.queue.enqueue(1)
  await f.queue.enqueue(2)
  const db = new Database(f.databasePath)
  db.exec("UPDATE history_huasheng_jobs SET project_url='https://www.huasheng.cn/video/' || id, production_status='creating', production_message='上次在创作中'")
  db.close()
  f.queue.checkProduction(undefined, { automatic: true })
  await productionFinished(f.queue)
  assert.equal(opened, 0)
  f.queue.checkProduction()
  await productionFinished(f.queue)
  assert.equal(opened, 1)
  assert.match(f.queue.getJob(2).productionCheckError!, /扫码登录/)
  for (const job of f.queue.listJobs()) {
    assert.equal(job.productionStatus, 'creating')
    assert.equal(job.productionCheckedAt, null)
  }
  assert.equal(f.calls.run, 0)
  assert.equal(f.queue.monitoring.enabled, false)
})

test('manual connection recovery stops on abort and never hides a browser profile conflict', async t => {
  const f = fixture(t, {
    inspectHuashengProject: async () => { throw Object.assign(new Error('该端口不是花生专用浏览器'), { code: 'browser_unavailable' }) },
    openHuashengBrowser: async () => { throw new Error('该端口不是花生专用浏览器，请检查配置') },
  })
  const job = (await f.queue.enqueue(1))!
  const db = new Database(f.databasePath)
  db.exec("UPDATE history_huasheng_jobs SET project_url='https://www.huasheng.cn/video/' || id")
  db.close()
  f.queue.checkProduction(1)
  await productionFinished(f.queue)
  assert.match(f.queue.getJob(job.id).productionCheckError!, /该端口不是花生专用浏览器，请检查配置/)
  assert.equal(f.queue.getJob(job.id).productionCheckedAt, null)
  const entered = deferred()
  const release = deferred()
  f.driver.openHuashengBrowser = async () => { entered.resolve(); await release.promise; return { status: 'ready', message: '已登录' } }
  f.queue.checkProduction(1)
  await entered.promise
  const stopping = f.queue.stop()
  release.resolve()
  await stopping
  assert.match(f.queue.getJob(job.id).productionCheckError!, /已取消/)
  assert.equal(f.calls.run, 0)
})

test('production filtering covers more than 50 jobs, prioritizes current versions and deduplicates URLs using the furthest checkpoint', async t => {
  const inspected: Array<{ projectUrl: string; checkpoint?: string | null }> = []
  let active = 0
  let peak = 0
  const f = fixture(t, { inspectHuashengProject: async input => {
    active++; peak = Math.max(peak, active)
    inspected.push(input)
    await new Promise<void>(resolve => setImmediate(resolve))
    active--
    return { status: 'completed', message: '可导出' }
  } })
  for (let version = 0; version < 52; version++) {
    f.sources.get(1)!.script = `稿件版本${version}`
    await f.queue.enqueue(1)
  }
  const otherSource = (await f.queue.enqueue(2))!
  f.sources.get(1)!.script = '稿件版本0'
  const db = new Database(f.databasePath)
  db.exec("UPDATE history_huasheng_jobs SET project_url = 'https://www.huasheng.cn/video/' || id, checkpoint = 'scheme_pending'")
  db.exec("UPDATE history_huasheng_jobs SET project_url = 'https://www.huasheng.cn/video/1', checkpoint = 'submitted' WHERE id = 2")
  db.close()
  f.queue.checkProduction(1)
  f.queue.checkProduction(1)
  await productionFinished(f.queue)
  assert.equal(inspected.length, 51)
  assert.equal(new Set(inspected.map(input => input.projectUrl)).size, 51)
  assert.equal(peak, 1)
  assert.equal(inspected[0]!.projectUrl, 'https://www.huasheng.cn/video/1', 'current saved version takes priority over more recent stale jobs')
  assert.equal(inspected[0]!.checkpoint, 'submitted')
  assert.equal(f.queue.getJob(1).productionStatus, 'completed')
  assert.equal(f.queue.getJob(2).productionStatus, 'completed')
  assert.equal(f.queue.getJob(otherSource.id).productionCheckedAt, null)
  assert.equal(f.calls.run, 0)
})

test('production check failures preserve the last good status, message and timestamp and clear on a later successful check', async t => {
  let fail = false
  const f = fixture(t, { inspectHuashengProject: async () => {
    if (fail) throw new Error('登录失效，无法读取项目')
    return { status: 'queued', message: '平台排队中' }
  } })
  const job = (await f.queue.enqueue(1))!
  await f.queue.runPending()
  f.queue.checkProduction()
  await productionFinished(f.queue)
  const checked = f.queue.getJob(job.id)
  fail = true
  f.queue.checkProduction()
  await productionFinished(f.queue)
  const failed = f.queue.getJob(job.id)
  assert.equal(failed.productionStatus, 'queued')
  assert.equal(failed.productionMessage, checked.productionMessage)
  assert.equal(failed.productionCheckedAt, checked.productionCheckedAt)
  assert.match(failed.productionCheckError!, /登录失效/)
  assert.equal(failed.status, 'submitted')
  fail = false
  f.queue.checkProduction()
  await productionFinished(f.queue)
  assert.equal(f.queue.getJob(job.id).productionCheckError, null)
})

test('a missing optional observer records an error without opening a browser or running queued work', async t => {
  const f = fixture(t)
  const job = (await f.queue.enqueue(1))!
  const db = new Database(f.databasePath)
  db.prepare("UPDATE history_huasheng_jobs SET project_url = 'https://www.huasheng.cn/video/1' WHERE id = ?").run(job.id)
  db.close()
  f.queue.checkProduction()
  await productionFinished(f.queue)
  assert.equal(f.queue.getJob(job.id).productionStatus, 'not_started')
  assert.equal(f.queue.getJob(job.id).productionCheckedAt, null)
  assert.match(f.queue.getJob(job.id).productionCheckError!, /不支持/)
  assert.equal(f.calls.open, 0)
  assert.equal(f.calls.run, 0)
})

test('running projects are skipped across duplicate jobs while the rest of the production batch completes', async t => {
  const entered = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  const inspected: string[] = []
  const f = fixture(t, {
    runHuashengBrowserJob: async input => {
      await input.onCheckpoint({ checkpoint: 'created', projectUrl: 'https://www.huasheng.cn/video/1', message: '已创建' })
      entered.resolve()
      await release.promise
      return { projectUrl: 'https://www.huasheng.cn/video/1' }
    },
    inspectHuashengProject: async input => { inspected.push(input.projectUrl); return { status: 'completed', message: '可导出' } },
  })
  const job = (await f.queue.enqueue(1))!
  const second = (await f.queue.enqueue(2))!
  const db = new Database(f.databasePath)
  db.prepare("UPDATE history_huasheng_jobs SET project_url = 'https://www.huasheng.cn/video/2', status = 'submitted' WHERE id = ?").run(second.id)
  db.close()
  const execution = f.queue.runPending()
  await entered.promise
  f.sources.get(1)!.script = 'another snapshot'
  const duplicate = (await f.queue.enqueue(1))!
  const restore = new Database(f.databasePath)
  restore.prepare("UPDATE history_huasheng_jobs SET project_url = 'https://www.huasheng.cn/video/1', status = 'failed' WHERE id = ?").run(duplicate.id)
  restore.close()
  f.queue.checkProduction()
  await productionFinished(f.queue)
  assert.deepEqual(inspected, ['https://www.huasheng.cn/video/2'])
  for (const id of [job.id, duplicate.id]) {
    assert.equal(f.queue.getJob(id).productionStatus, 'not_started')
    assert.equal(f.queue.getJob(id).productionCheckedAt, null)
    assert.match(f.queue.getJob(id).productionCheckError!, /自动化推进中/)
  }
  release.resolve()
  await execution
})

test('an inspection holds the project against another worker while unrelated jobs may run; overlapping requests coalesce', async t => {
  const entered = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  const inspected: string[] = []
  const f = fixture(t, { inspectHuashengProject: async input => {
    inspected.push(input.projectUrl)
    if (inspected.length === 1) { entered.resolve(); await release.promise }
    return { status: 'creating', message: '尚不可导出' }
  } })
  const first = (await f.queue.enqueue(1))!
  const second = (await f.queue.enqueue(2))!
  const db = new Database(f.databasePath)
  db.prepare("UPDATE history_huasheng_jobs SET project_url = 'https://www.huasheng.cn/video/1' WHERE id = ?").run(first.id)
  db.close()
  f.queue.checkProduction(1)
  await entered.promise
  const other = new HistoryHuashengService(f.options)
  t.after(() => other.close())
  await other.runPending()
  assert.equal(f.queue.getJob(first.id).status, 'queued')
  assert.equal(f.queue.getJob(second.id).status, 'submitted')
  assert.equal(f.calls.run, 1)
  f.queue.checkProduction()
  f.queue.checkProduction(1)
  release.resolve()
  await productionFinished(f.queue)
  assert.equal(inspected.length, 2)
  assert.equal(new Set(inspected).size, 2)
  await other.runPending()
  assert.equal(f.queue.getJob(first.id).status, 'submitted')
})

test('a project deadline aborts the observer and waits for page cleanup before checking the next project', async t => {
  const aborted = deferred()
  const cleaned = deferred()
  t.after(() => cleaned.resolve())
  let calls = 0
  const f = fixture(t, { inspectHuashengProject: async input => {
    calls++
    if (calls === 1) {
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
      await cleaned.promise
      input.signal.throwIfAborted()
    }
    return { status: 'completed', message: '可导出' }
  } }, { productionTimeoutMs: 10 })
  await f.queue.enqueue(1)
  await f.queue.enqueue(2)
  await f.queue.runPending()
  f.queue.checkProduction()
  await aborted.promise
  assert.equal(calls, 1)
  assert.equal(f.queue.productionChecking, true)
  cleaned.resolve()
  await productionFinished(f.queue)
  assert.equal(calls, 2)
  const jobs = f.queue.listJobs()
  assert.match(jobs[0]!.productionCheckError!, /超时/)
  assert.equal(jobs[0]!.productionCheckedAt, null)
  assert.equal(jobs[0]!.productionStatus, 'creating')
  assert.equal(jobs[1]!.productionStatus, 'completed')
})

test('stop aborts production inspection, waits for page cleanup and does not inspect remaining projects', async t => {
  const entered = deferred()
  const aborted = deferred()
  const cleanup = deferred()
  t.after(() => cleanup.resolve())
  let calls = 0
  const f = fixture(t, { inspectHuashengProject: async input => {
    calls++; entered.resolve()
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
    await cleanup.promise
    input.signal.throwIfAborted()
    return { status: 'completed', message: 'late response must be ignored' }
  } })
  await f.queue.enqueue(1)
  await f.queue.enqueue(2)
  await f.queue.runPending()
  f.queue.checkProduction()
  await entered.promise
  let stopped = false
  const stopping = f.queue.stop().then(() => { stopped = true })
  await aborted.promise
  assert.equal(stopped, false)
  cleanup.resolve()
  await stopping
  assert.equal(f.queue.productionChecking, false)
  assert.equal(calls, 1)
  assert.ok(f.queue.listJobs().every(job => job.productionStatus === 'creating' && job.productionCheckedAt === null))
  assert.throws(() => f.queue.checkProduction(), /正在停止/)
})

test('old databases migrate production fields lazily without opening projects or scheduling old work', async t => {
  const f = fixture(t)
  const job = (await f.queue.enqueue(1))!
  const db = new Database(f.databasePath)
  for (const column of ['production_status', 'production_checked_at', 'production_message', 'production_check_error']) {
    db.exec(`ALTER TABLE history_huasheng_jobs DROP COLUMN ${column}`)
  }
  db.close()
  const migrated = new HistoryHuashengService(f.options)
  t.after(() => migrated.close())
  assert.equal(migrated.getJob(job.id).productionStatus, 'not_started')
  assert.equal(migrated.getJob(job.id).productionCheckedAt, null)
  assert.equal(migrated.getJob(job.id).productionMessage, '')
  assert.equal(migrated.getJob(job.id).productionCheckError, null)
  assert.equal(f.calls.run, 0)
  assert.equal(f.calls.open, 0)
})

for (const observed of ['queued', 'creating'] as const) {
  test(`submitted checkpoint persists explicit platform ${observed} while a previously completed project never regresses`, async t => {
    const f = fixture(t, { runHuashengBrowserJob: async input => {
      await input.onCheckpoint({ checkpoint: 'submitted', projectUrl: `https://www.huasheng.cn/video/${input.jobId}`,
        message: '保留平台事实', productionStatus: observed })
      return { projectUrl: `https://www.huasheng.cn/video/${input.jobId}` }
    } })
    const first = (await f.queue.enqueue(1))!
    const completed = (await f.queue.enqueue(2))!
    const db = new Database(f.databasePath)
    db.prepare("UPDATE history_huasheng_jobs SET production_status = 'completed', production_checked_at = '2026-10-22T00:00:00.000Z', production_message = '已可导出' WHERE id = ?").run(completed.id)
    db.close()
    await f.queue.runPending()
    assert.equal(f.queue.getJob(first.id).productionStatus, observed)
    assert.equal(f.queue.getJob(first.id).message, '保留平台事实')
    assert.equal(f.queue.getJob(completed.id).productionStatus, 'completed')
    assert.equal(f.queue.getJob(completed.id).productionMessage, '已可导出')
    assert.equal(f.queue.getJob(completed.id).productionCheckedAt, '2026-10-22T00:00:00.000Z')
  })
}

test('default enabled, no import/construction/backfill effects; concurrent same-hash enqueue is idempotent', async t => {
  const f = fixture(t)
  assert.equal(f.queue.enabled, true)
  await f.queue.runPending()
  assert.deepEqual(f.calls, { load: 0, status: 0, open: 0, run: 0 })
  const jobs = await Promise.all(Array.from({ length: 8 }, () => f.queue.enqueue(1)))
  assert.ok(jobs.every(job => job!.id === jobs[0]!.id))
  assert.equal(f.queue.listJobs().length, 1)
  assert.equal(f.calls.run, 0, 'enqueue only persists; starting a worker is explicit')
  assert.equal('script' in jobs[0]!, false)
  assert.equal('owner' in jobs[0]!, false)
  await f.queue.runPending()
  assert.equal(f.queue.getJob(jobs[0]!.id).status, 'submitted')
  assert.equal(f.calls.run, 1)
  assert.equal((await f.queue.enqueue(1))!.status, 'submitted')
  await f.queue.runPending()
  assert.equal(f.calls.run, 1)
})

async function selectedFinished(queue: HistoryHuashengService) {
  const deadline = Date.now() + 3000
  while (queue.producing) {
    if (Date.now() > deadline) throw new Error('selected production did not finish')
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

test('manual production runs only selected unbound queued jobs with the worker disabled and never scans the outbox', async t => {
  const previous = process.env.TASK_WORKER_DISABLED
  process.env.TASK_WORKER_DISABLED = '1'
  t.after(() => { if (previous === undefined) delete process.env.TASK_WORKER_DISABLED; else process.env.TASK_WORKER_DISABLED = previous })
  const runs: number[] = []
  const f = fixture(t, { runHuashengBrowserJob: async input => {
    runs.push(Number(input.jobId))
    assert.equal(input.projectUrl, null)
    await input.onCheckpoint({ checkpoint: 'create_pending', message: '准备创建' })
    await input.onCheckpoint({ checkpoint: 'created', projectUrl: `https://www.huasheng.cn/video/${input.jobId}`, message: '已创建' })
    await input.onCheckpoint({ checkpoint: 'submitted', productionStatus: 'queued', message: '花生已排队' })
    return { projectUrl: `https://www.huasheng.cn/video/${input.jobId}` }
  } })
  f.sources.set(3, { id: 3, title: '文稿三', script: '正文三' })
  const unselected = (await f.queue.enqueue(1, { automatic: true }))!
  const first = (await f.queue.enqueue(2, { automatic: true }))!
  const second = (await f.queue.enqueue(3, { automatic: true }))!
  const db = new Database(f.databasePath)
  t.after(() => db.close())
  db.exec('CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY, review_json TEXT, rewritten_script TEXT, deleted_at TEXT)')
  const marker = JSON.stringify({ huashengQueue: { status: 'pending', scriptSha256: 'a'.repeat(64) } })
  db.prepare('INSERT INTO history_script_sources(id, review_json, rewritten_script) VALUES(99, ?, ?)').run(marker, '未选中的旧稿')
  const loaded: number[] = []
  const load = f.options.loadSource
  f.options.loadSource = id => { loaded.push(id); return load(id) }
  const result = await f.queue.produce([first.id, second.id, first.id])
  assert.deepEqual(result.results.map(item => [item.jobId, item.sourceId, item.status]), [[first.id, 2, 'queued'], [second.id, 3, 'queued']])
  assert.equal(result.running, true)
  await selectedFinished(f.queue)
  assert.deepEqual(runs, [first.id, second.id])
  for (const id of [first.id, second.id]) {
    assert.equal(f.queue.getJob(id).status, 'submitted')
    assert.equal(f.queue.getJob(id).productionStatus, 'queued')
    assert.equal(f.queue.getJob(id).attempts, 1)
  }
  assert.equal(f.queue.getJob(unselected.id).status, 'queued')
  assert.equal(f.queue.getJob(unselected.id).attempts, 0)
  assert.equal(f.queue.listJobs().length, 3)
  assert.ok(loaded.every(id => id === 2 || id === 3))
  assert.equal((db.prepare('SELECT review_json AS marker FROM history_script_sources WHERE id=99').get() as { marker: string }).marker, marker)
  assert.equal(f.queue.monitoring.enabled, false)
  assert.equal(f.calls.open, 0)
  assert.equal(f.calls.status, 0)
})

test('overlapping manual batches merge, serialize and skip duplicate queued, running and submitted work', async t => {
  const entered = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  const runs: number[] = []
  let active = 0
  let peak = 0
  const f = fixture(t, { runHuashengBrowserJob: async input => {
    runs.push(Number(input.jobId))
    active++; peak = Math.max(peak, active)
    try {
      if (runs.length === 1) { entered.resolve(); await release.promise }
      return { projectUrl: `https://www.huasheng.cn/video/${input.jobId}` }
    } finally { active-- }
  } }, { pollMs: 5 })
  const first = (await f.queue.enqueue(1))!
  const second = (await f.queue.enqueue(2))!
  await f.queue.produce([first.id])
  await entered.promise
  const overlap = await f.queue.produce([first.id, second.id, second.id])
  assert.deepEqual(overlap.results.map(item => item.status), ['skipped', 'queued'])
  const duplicates = await Promise.all([f.queue.produce([second.id]), f.queue.produce([second.id])])
  assert.ok(duplicates.every(result => result.results[0].status === 'skipped'))
  release.resolve()
  await selectedFinished(f.queue)
  assert.deepEqual(runs, [first.id, second.id])
  assert.equal(peak, 1)
  assert.ok((await f.queue.produce([first.id, second.id])).results.every(item => item.status === 'skipped'))
  await selectedFinished(f.queue)
  assert.equal(runs.length, 2)
})

test('cancel during manual snapshot validation stays canceled and blocks only that batch item', async t => {
  const validating = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  const f = fixture(t)
  const canceledJob = (await f.queue.enqueue(1))!
  const validJob = (await f.queue.enqueue(2))!
  const db = new Database(f.databasePath)
  db.prepare("UPDATE history_huasheng_jobs SET checkpoint='plan_opened', project_url='https://www.huasheng.cn/video/123' WHERE id=?").run(canceledJob.id)
  db.close()
  const queue = new HistoryHuashengService({ ...f.options, loadSource: async id => {
    if (id === canceledJob.sourceId) { validating.resolve(); await release.promise }
    return f.options.loadSource(id)
  } })
  t.after(() => queue.close())
  const pending = queue.produce([canceledJob.id, validJob.id])
  await validating.promise
  const canceled = f.queue.cancel(canceledJob.id)
  assert.equal(canceled.status, 'canceled')
  release.resolve()
  const response = await pending
  assert.deepEqual(response.results.map(item => item.status), ['blocked', 'queued'])
  assert.match(response.results[0].message, /校验.*取消|取消.*校验/)
  await selectedFinished(queue)
  const stored = queue.getJob(canceledJob.id)
  assert.equal(stored.status, 'canceled')
  assert.equal(stored.cancelRequested, true)
  assert.equal(stored.updatedAt, canceled.updatedAt)
  assert.equal(stored.checkpoint, 'plan_opened')
  assert.equal(stored.projectUrl, 'https://www.huasheng.cn/video/123')
  assert.equal(stored.attempts, 0)
  assert.equal(queue.getJob(validJob.id).status, 'submitted')
  assert.equal(f.calls.run, 1)
})

test('canceling a selected waiting job allows explicit re-selection while another selected job is running', async t => {
  const entered = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  const runs: number[] = []
  const f = fixture(t, { runHuashengBrowserJob: async input => {
    runs.push(Number(input.jobId))
    if (runs.length === 1) { entered.resolve(); await release.promise }
    else {
      assert.equal(input.projectUrl, 'https://www.huasheng.cn/video/123')
      assert.equal(input.checkpoint, 'confirm_pending')
    }
    return { projectUrl: input.projectUrl ?? `https://www.huasheng.cn/video/${input.jobId}` }
  } })
  const first = (await f.queue.enqueue(1))!
  const waiting = (await f.queue.enqueue(2))!
  const db = new Database(f.databasePath)
  db.prepare("UPDATE history_huasheng_jobs SET checkpoint='confirm_pending', project_url='https://www.huasheng.cn/video/123' WHERE id=?").run(waiting.id)
  db.close()
  await f.queue.produce([first.id, waiting.id])
  await entered.promise
  assert.equal(f.queue.cancel(waiting.id).status, 'canceled')
  assert.equal(f.queue.getJob(waiting.id).checkpoint, 'confirm_pending')
  const retry = await f.queue.produce([waiting.id])
  assert.equal(retry.results[0].status, 'queued')
  assert.equal(f.queue.getJob(waiting.id).status, 'queued')
  assert.equal(f.queue.getJob(waiting.id).cancelRequested, false)
  release.resolve()
  await selectedFinished(f.queue)
  assert.deepEqual(runs, [first.id, waiting.id])
  assert.equal(f.queue.getJob(waiting.id).status, 'submitted')
  assert.equal(f.queue.getJob(waiting.id).attempts, 1)
  assert.equal(f.queue.monitoring.enabled, false)
})

test('manual production reports per-item blockers and skips every accepted remote state without sacrificing valid jobs', async t => {
  const f = fixture(t)
  for (let id = 3; id <= 8; id++) f.sources.set(id, { id, title: `文稿${id}`, script: `正文${id}` })
  const jobs = []
  for (let id = 1; id <= 8; id++) jobs.push((await f.queue.enqueue(id))!)
  f.sources.get(1)!.script = '新版本不能使用旧任务快照'
  f.sources.delete(2)
  const db = new Database(f.databasePath)
  db.prepare("UPDATE history_huasheng_jobs SET status='needs_attention', stage='create_pending', checkpoint=NULL, message='旧记录创建响应丢失' WHERE id=?").run(jobs[3].id)
  for (const [index, status] of ['queued', 'creating', 'completed'].entries()) {
    db.prepare("UPDATE history_huasheng_jobs SET production_status=?, project_url='https://www.huasheng.cn/video/' || id WHERE id=?").run(status, jobs[index + 4].id)
  }
  db.prepare("UPDATE history_huasheng_jobs SET status='submitted', project_url='https://www.huasheng.cn/video/' || id WHERE id=?").run(jobs[7].id)
  db.close()
  const result = await f.queue.produce([...jobs.map(job => job.id), 999])
  assert.deepEqual(result.results.map(item => item.status), ['blocked', 'blocked', 'queued', 'blocked', 'skipped', 'skipped', 'skipped', 'skipped', 'blocked'])
  assert.match(result.results[0].message, /文稿已变更/)
  assert.match(result.results[1].message, /不存在/)
  assert.match(result.results[3].message, /绑定.*项目|项目.*绑定/)
  assert.equal(result.results[8].sourceId, null)
  await selectedFinished(f.queue)
  assert.equal(f.calls.run, 1)
  assert.equal(f.queue.getJob(jobs[2].id).status, 'submitted')
  assert.equal(f.queue.getJob(jobs[3].id).stage, 'create_pending')
  assert.equal(f.queue.getJob(jobs[3].id).checkpoint, null)
  assert.equal(f.queue.getJob(jobs[3].id).projectUrl, null)
})

test('manual production resumes recoverable jobs at their original project and checkpoint including standard quota waiting', async t => {
  const runs: Array<{ id: number; projectUrl: string | null; checkpoint: string | null }> = []
  const f = fixture(t, { runHuashengBrowserJob: async input => {
    runs.push({ id: Number(input.jobId), projectUrl: input.projectUrl, checkpoint: input.checkpoint })
    assert.ok(input.projectUrl, 'Recovery must never create a replacement project')
    return { projectUrl: input.projectUrl! }
  } })
  const scenarios = [
    { status: 'failed', checkpoint: 'created' },
    { status: 'waiting_login', checkpoint: 'plan_opened' },
    { status: 'canceled', checkpoint: 'confirm_pending' },
    { status: 'needs_attention', checkpoint: 'quota_waiting' },
    { status: 'needs_attention', checkpoint: 'create_pending' },
  ]
  const db = new Database(f.databasePath)
  const ids: number[] = []
  for (const [index, scenario] of scenarios.entries()) {
    const id = index + 1
    f.sources.set(id, { id, title: `文稿${id}`, script: `正文${id}` })
    const job = (await f.queue.enqueue(id))!
    ids.push(job.id)
    db.prepare(`UPDATE history_huasheng_jobs SET status=?, checkpoint=?, project_url=?,
      cancel_requested=?, error='原来的阻塞', message='标准模式等待恢复' WHERE id=?`)
      .run(scenario.status, scenario.checkpoint, `https://www.huasheng.cn/video/${100 + id}`, Number(scenario.status === 'canceled'), job.id)
  }
  db.close()
  const result = await f.queue.produce(ids)
  assert.ok(result.results.every(item => item.status === 'queued'))
  assert.match(result.results[3].message, /标准模式/)
  await selectedFinished(f.queue)
  assert.deepEqual(runs, ids.map((id, index) => ({ id, projectUrl: `https://www.huasheng.cn/video/${101 + index}`, checkpoint: scenarios[index].checkpoint })))
  for (const id of ids) {
    const job = f.queue.getJob(id)
    assert.equal(job.status, 'submitted')
    assert.equal(job.cancelRequested, false)
    assert.equal(job.error, null)
    assert.equal(job.attempts, 1)
  }
  assert.equal(f.queue.monitoring.enabled, false)
})

test('a lost create response blocks a repeated manual batch until its existing project is bound', async t => {
  let calls = 0
  const f = fixture(t, { runHuashengBrowserJob: async input => {
    calls++
    if (calls === 1) {
      await input.onCheckpoint({ checkpoint: 'create_pending', message: '已记录创建意图' })
      throw new Error('创建已发出但响应丢失')
    }
    assert.equal(input.checkpoint, 'create_pending')
    assert.equal(input.projectUrl, 'https://www.huasheng.cn/video/123')
    return { projectUrl: input.projectUrl! }
  } })
  const job = (await f.queue.enqueue(1))!
  await f.queue.produce([job.id])
  await selectedFinished(f.queue)
  assert.equal(f.queue.getJob(job.id).status, 'failed')
  const repeated = await f.queue.produce([job.id])
  assert.equal(repeated.results[0].status, 'blocked')
  assert.match(repeated.results[0].message, /绑定/)
  assert.equal(calls, 1)
  await f.queue.resume(job.id, { projectUrl: 'https://www.huasheng.cn/video/123' })
  await f.queue.produce([job.id])
  await selectedFinished(f.queue)
  assert.equal(calls, 2)
  assert.equal(f.queue.getJob(job.id).status, 'submitted')
})

test('legacy stage-only create intentions block production and binding preserves that original checkpoint', async t => {
  const f = fixture(t, { runHuashengBrowserJob: async input => {
    assert.equal(input.projectUrl, 'https://www.huasheng.cn/video/123')
    assert.equal(input.checkpoint, 'create_pending')
    return { projectUrl: input.projectUrl! }
  } })
  const job = (await f.queue.enqueue(1))!
  const db = new Database(f.databasePath)
  db.prepare("UPDATE history_huasheng_jobs SET stage='create_pending', checkpoint=NULL WHERE id=?").run(job.id)
  db.close()
  assert.equal((await f.queue.produce([job.id])).results[0].status, 'blocked')
  const bound = await f.queue.resume(job.id, { projectUrl: 'https://www.huasheng.cn/video/123' })
  assert.equal(bound.checkpoint, 'create_pending')
  assert.equal(bound.projectUrl, 'https://www.huasheng.cn/video/123')
  await f.queue.produce([job.id])
  await selectedFinished(f.queue)
  assert.equal(f.queue.getJob(job.id).status, 'submitted')
})

test('selected batches share the global lease across stores and leave unselected queued work alone', async t => {
  const entered = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  let active = 0
  let peak = 0
  const runs: number[] = []
  const f = fixture(t, { runHuashengBrowserJob: async input => {
    active++; peak = Math.max(peak, active)
    runs.push(Number(input.jobId))
    try {
      if (runs.length === 1) { entered.resolve(); await release.promise }
      return { projectUrl: `https://www.huasheng.cn/video/${input.jobId}` }
    } finally { active-- }
  } }, { pollMs: 5 })
  f.sources.set(3, { id: 3, title: '未选文稿', script: '保持排队' })
  const first = (await f.queue.enqueue(1))!
  const second = (await f.queue.enqueue(2))!
  const unselected = (await f.queue.enqueue(3))!
  const other = new HistoryHuashengService(f.options)
  t.after(() => other.close())
  await f.queue.produce([first.id])
  await entered.promise
  const db = new Database(f.databasePath)
  db.exec('UPDATE history_huasheng_lease SET expires_at=0')
  db.close()
  const result = await other.produce([second.id])
  assert.equal(result.results[0].status, 'queued')
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  assert.deepEqual(runs, [first.id])
  assert.equal(other.getJob(first.id).status, 'running')
  release.resolve()
  await Promise.all([selectedFinished(f.queue), selectedFinished(other)])
  assert.deepEqual(runs, [first.id, second.id])
  assert.equal(peak, 1)
  assert.equal(other.getJob(unselected.id).status, 'queued')
  assert.equal(other.getJob(unselected.id).attempts, 0)
})

test('settings persist; disabled automatic enqueue is skipped while manual and already queued work still run', async t => {
  const f = fixture(t)
  const acceptedAutomatic = (await f.queue.enqueue(2, { automatic: true }))!
  f.queue.setEnabled(false)
  assert.equal(await f.queue.enqueue(1, { automatic: true }), null)
  assert.equal(f.calls.load, 1)
  const job = (await f.queue.enqueue(1))!
  const other = new HistoryHuashengService(f.options)
  t.after(() => other.close())
  assert.equal(other.enabled, false)
  await other.runPending()
  assert.equal(f.calls.run, 2)
  assert.equal(f.queue.getJob(acceptedAutomatic.id).status, 'submitted')
  other.setEnabled(true)
  await other.runPending()
  assert.equal(f.queue.getJob(job.id).status, 'submitted')
  assert.equal(f.queue.listJobs().length, 2)
  assert.equal(f.calls.run, 2)
})

test('serial execution holds an expired lease until driver cleanup finishes, including remote cancellation', { timeout: 5000 }, async t => {
  const entered = deferred()
  const aborted = deferred()
  const cleanup = deferred()
  let first = true
  let active = 0
  let peak = 0
  const f = fixture(t, {
    runHuashengBrowserJob: async input => {
      active++; peak = Math.max(peak, active)
      try {
        if (first) {
          first = false
          entered.resolve()
          await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
          await cleanup.promise
          await assert.rejects(input.onCheckpoint({ checkpoint: 'confirm_pending', message: 'must not happen' }))
          input.signal.throwIfAborted()
        }
        return { projectUrl: `https://www.huasheng.cn/project/${input.jobId}` }
      } finally { active-- }
    },
  })
  const other = new HistoryHuashengService(f.options)
  t.after(() => other.close())
  const one = (await f.queue.enqueue(1))!
  const two = (await f.queue.enqueue(2))!
  const execution = f.queue.runPending()
  assert.equal(f.queue.runPending(), execution)
  await entered.promise
  const connection = new Database(f.databasePath)
  connection.prepare('UPDATE history_huasheng_lease SET expires_at = 0').run()
  connection.close()
  await other.runPending()
  assert.equal(other.getJob(two.id).status, 'queued')
  const canceled = other.cancel(one.id)
  assert.equal(canceled.status, 'running')
  assert.equal(canceled.cancelRequested, true)
  assert.equal(canceled.stage, 'canceling')
  await aborted.promise
  await assert.rejects(other.resume(one.id), /运行|停止/)
  await other.runPending()
  assert.equal(other.getJob(two.id).status, 'queued', 'cancel does not release the active browser lease')
  cleanup.resolve()
  await execution
  assert.equal(peak, 1)
  assert.equal(other.getJob(one.id).status, 'canceled')
  assert.equal(other.getJob(two.id).status, 'submitted')
})

test('an accepted confirmation wins over a simultaneous cancel request', async t => {
  const entered = deferred()
  const accepted = deferred()
  const f = fixture(t, {
    runHuashengBrowserJob: async () => { entered.resolve(); await accepted.promise; return { projectUrl: 'https://www.huasheng.cn/project/accepted' } },
  })
  const job = (await f.queue.enqueue(1))!
  const run = f.queue.runPending()
  await entered.promise
  f.queue.cancel(job.id)
  accepted.resolve()
  await run
  assert.equal(f.queue.getJob(job.id).status, 'submitted')
})

test('changed, deleted or noncurrent drafts never reach driver; submitted snapshots remain immutable', async t => {
  const f = fixture(t)
  const first = (await f.queue.enqueue(1))!
  f.sources.get(1)!.script = '当前新稿'
  const current = (await f.queue.enqueue(1))!
  const missing = (await f.queue.enqueue(2))!
  f.sources.delete(2)
  await f.queue.runPending()
  assert.equal(f.queue.getJob(first.id).status, 'needs_attention')
  assert.equal(f.queue.getJob(missing.id).status, 'needs_attention')
  assert.equal(f.queue.getJob(current.id).status, 'submitted')
  assert.equal(f.calls.run, 1)
  await assert.rejects(f.queue.resume(first.id), /文稿已变更/)
  const submitted = f.queue.getJob(current.id)
  f.sources.delete(1)
  assert.deepEqual(await f.queue.resume(current.id), submitted)
  assert.deepEqual(f.queue.cancel(current.id), submitted)
  const db = new Database(f.databasePath)
  const snapshots = db.prepare('SELECT script FROM history_huasheng_jobs WHERE source_id = 1 ORDER BY id').all()
  db.close()
  assert.deepEqual(snapshots, [{ script: '第一篇二创文稿\n保留原样。' }, { script: '当前新稿' }])
})

for (const change of ['edit', 'delete'] as const) {
  test(`${change} during a browser run aborts before the next effect and preserves the last durable checkpoint`, async t => {
    let signal: AbortSignal | undefined
    const f = fixture(t, { runHuashengBrowserJob: async input => {
      signal = input.signal
      await input.onCheckpoint({ checkpoint: 'created', projectUrl: 'https://www.huasheng.cn/video/1', message: '已创建' })
      if (change === 'edit') f.sources.get(1)!.script = '刚编辑的新稿'
      else f.sources.delete(1)
      await input.onCheckpoint({ checkpoint: 'confirm_pending', message: 'must not be saved' })
      throw new Error('must not reach a later browser effect')
    } })
    const job = (await f.queue.enqueue(1))!
    await f.queue.runPending()
    assert.equal(signal?.aborted, true)
    assert.equal(f.queue.getJob(job.id).status, 'needs_attention')
    assert.equal(f.queue.getJob(job.id).checkpoint, 'created')
  })
}

for (const observed of ['created', 'submitted'] as const) {
  test(`${observed} observations survive source changes and preserve authoritative project facts`, async t => {
    const f = fixture(t, { runHuashengBrowserJob: async input => {
      await input.onCheckpoint({ checkpoint: observed === 'created' ? 'create_pending' : 'confirm_pending', message: 'before effect' })
      f.sources.get(1)!.script = '文稿在平台执行期间被修改'
      await input.onCheckpoint({ checkpoint: observed, projectUrl: 'https://www.huasheng.cn/video/99', message: 'observed fact' })
      if (observed === 'created') await input.onCheckpoint({ checkpoint: 'scheme_pending', message: 'must be rejected' })
      throw new Error('connection lost after recording the platform result')
    } })
    const job = (await f.queue.enqueue(1))!
    await f.queue.runPending()
    assert.equal(f.queue.getJob(job.id).projectUrl, 'https://www.huasheng.cn/video/99')
    assert.equal(f.queue.getJob(job.id).checkpoint, observed)
    assert.equal(f.queue.getJob(job.id).status, observed === 'submitted' ? 'submitted' : 'needs_attention')
  })
}

test('restart finalizes a durable submitted observation without reopening a changed or deleted source', async t => {
  const f = fixture(t)
  const job = (await f.queue.enqueue(1))!
  const connection = new Database(f.databasePath)
  connection.prepare(`UPDATE history_huasheng_jobs SET status = 'running', checkpoint = 'submitted', project_url = 'https://www.huasheng.cn/video/9' WHERE id = ?`).run(job.id)
  connection.close()
  f.sources.delete(1)
  const previousLoads = f.calls.load
  await f.queue.runPending()
  assert.equal(f.calls.load, previousLoads)
  assert.equal(f.calls.run, 0)
  assert.equal(f.queue.getJob(job.id).status, 'submitted')
})

for (const invalidation of ['missing', 'changed'] as const) {
  test(`a ${invalidation} outbox source is retired once and never polled or reported indefinitely`, async t => {
    const f = fixture(t)
    const db = new Database(f.databasePath)
    t.after(() => db.close())
    db.exec('CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY, review_json TEXT, rewritten_script TEXT, deleted_at TEXT)')
    const script = f.sources.get(1)!.script
    const marker = { status: 'pending', scriptSha256: createHash('sha256').update(script).digest('hex') }
    db.prepare('INSERT INTO history_script_sources(id, review_json, rewritten_script) VALUES(1, ?, ?)').run(JSON.stringify({ huashengQueue: marker }), script)
    if (invalidation === 'missing') f.sources.delete(1)
    else {
      f.sources.get(1)!.script = 'new script'
      db.prepare('UPDATE history_script_sources SET rewritten_script = ? WHERE id = 1').run('new script')
    }
    await f.queue.runPending()
    assert.equal(f.calls.load, 1)
    await f.queue.runPending()
    assert.equal(f.calls.load, 1)
    assert.equal(f.queue.listJobs().length, 0)
    assert.equal(f.calls.run, 0)
    const stored = db.prepare('SELECT review_json FROM history_script_sources WHERE id = 1').get() as { review_json: string }
    assert.notEqual(JSON.parse(stored.review_json).huashengQueue?.status, 'pending')
  })
}

for (const [code, status] of [
  ['login_required', 'waiting_login'], ['manual_review', 'needs_attention'], ['browser_unavailable', 'needs_attention'],
  ['timeout', 'needs_attention'], ['unknown', 'failed'],
] as const) {
  test(`${code} is recoverable as ${status}, preserves opaque checkpoint and never retries itself`, async t => {
    let attempt = 0
    const checkpoint = '{"stage":"confirm_pending","opaque":"原样保存"}'
    const f = fixture(t, {
      runHuashengBrowserJob: async input => {
        attempt++
        if (attempt === 1) {
          await input.onCheckpoint({ checkpoint, projectUrl: 'https://www.huasheng.cn/project/retained', message: 'before confirming' })
          const reader = new Database(f.databasePath, { readonly: true })
          assert.equal((reader.prepare('SELECT checkpoint FROM history_huasheng_jobs WHERE id = ?').get(input.jobId) as { checkpoint: string }).checkpoint, checkpoint)
          reader.close()
          throw Object.assign(new Error(`test ${code}`), { code })
        }
        assert.equal(input.checkpoint, checkpoint)
        assert.equal(input.projectUrl, 'https://www.huasheng.cn/project/retained')
        return { projectUrl: input.projectUrl!, videoUrl: 'https://www.huasheng.cn/video/result' }
      },
    })
    const job = (await f.queue.enqueue(1))!
    await f.queue.runPending()
    assert.equal(f.queue.getJob(job.id).status, status)
    assert.equal(f.queue.getJob(job.id).checkpoint, checkpoint)
    await f.queue.runPending()
    assert.equal(attempt, 1)
    await f.queue.resume(job.id)
    assert.equal(f.queue.getJob(job.id).checkpoint, checkpoint)
    await f.queue.runPending()
    assert.equal(f.queue.getJob(job.id).status, 'submitted')
    assert.equal(f.queue.getJob(job.id).attempts, 2)
    assert.equal(f.queue.getJob(job.id).videoUrl, 'https://www.huasheng.cn/video/result')
  })
}

test('waiting login blocks other automatic jobs until the user resumes or cancels it', async t => {
  let calls = 0
  const f = fixture(t, { runHuashengBrowserJob: async () => { calls++; throw Object.assign(new Error('请登录'), { code: 'login_required' }) } })
  const first = (await f.queue.enqueue(1, { automatic: true }))!
  const second = (await f.queue.enqueue(2, { automatic: true }))!
  await f.queue.runPending()
  await f.queue.runPending()
  assert.equal(calls, 1)
  assert.equal(f.queue.getJob(second.id).status, 'queued')
  f.queue.cancel(first.id)
  await f.queue.runPending()
  assert.equal(calls, 2)
})

test('shutdown aborts the active driver and a new service resumes the persisted checkpoint without creating a new project', async t => {
  const entered = deferred()
  const f = fixture(t, {
    runHuashengBrowserJob: async input => {
      await input.onCheckpoint({ checkpoint: 'plan_opened', projectUrl: 'https://www.huasheng.cn/project/restart', message: '规划书已打开' })
      entered.resolve()
      await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
      throw new Error('unreachable')
    },
  })
  const job = (await f.queue.enqueue(1))!
  const execution = f.queue.runPending()
  await entered.promise
  await f.queue.stop()
  await execution
  assert.equal(f.queue.getJob(job.id).status, 'queued')
  const other = new HistoryHuashengService({ ...f.options, driver: { ...f.driver, runHuashengBrowserJob: async input => {
    assert.equal(input.checkpoint, 'plan_opened')
    assert.equal(input.projectUrl, 'https://www.huasheng.cn/project/restart')
    return { projectUrl: input.projectUrl! }
  } } })
  t.after(() => other.close())
  await other.runPending()
  assert.equal(other.getJob(job.id).status, 'submitted')
  assert.equal(other.listJobs().length, 1)
})

test('a real second process cannot steal a live lease and recovers create_pending unchanged after owner death', { timeout: 10_000 }, async t => {
  let receivedCheckpoint: string | null = null
  const f = fixture(t, { runHuashengBrowserJob: async input => {
    receivedCheckpoint = input.checkpoint
    assert.equal(input.projectUrl, null)
    throw Object.assign(new Error('创建结果不确定，人工核验'), { code: 'manual_review' })
  } })
  const job = (await f.queue.enqueue(1))!
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { HistoryHuashengService } from ${JSON.stringify(new URL('./history-huasheng.ts', import.meta.url).href)};
    const queue = new HistoryHuashengService({
      databasePath: ${JSON.stringify(f.databasePath)},
      loadSource: () => ({id:1, title:'历史故事一', script:'第一篇二创文稿\\n保留原样。'}),
      driver: {
        getHuashengBrowserStatus: async () => { throw new Error('must not read browser'); },
        openHuashengBrowser: async () => { throw new Error('must not open browser'); },
        runHuashengBrowserJob: async input => {
          await input.onCheckpoint({checkpoint:'create_pending', message:'durable before create'});
          process.send({ready:true});
          await new Promise(() => {});
        }
      }
    });
    setInterval(() => {}, 1000);
    await queue.runPending();
  `], { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += chunk })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(() => { throw new Error(`child exited early: ${stderr}`) }),
  ])
  const db = new Database(f.databasePath)
  db.prepare('UPDATE history_huasheng_lease SET expires_at = 0').run()
  db.close()
  await f.queue.runPending()
  assert.equal(f.queue.getJob(job.id).status, 'running')
  assert.equal(receivedCheckpoint, null)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  await f.queue.runPending()
  assert.equal(receivedCheckpoint, 'create_pending')
  assert.equal(f.queue.getJob(job.id).checkpoint, 'create_pending')
  assert.equal(f.queue.getJob(job.id).status, 'needs_attention')
  assert.equal(f.queue.listJobs().length, 1)
})

test('overview only reads cached status while live checks coalesce and explicit check bypasses TTL', async t => {
  const f = fixture(t)
  await Promise.all([f.queue.overview(), f.queue.overview(), f.queue.overview()])
  assert.equal(f.calls.status, 0)
  await Promise.all([f.queue.browserStatus(), f.queue.browserStatus(), f.queue.browserStatus()])
  assert.equal(f.calls.status, 1)
  await f.queue.overview()
  assert.equal(f.calls.status, 1)
  await f.queue.browserStatus(true)
  assert.equal(f.calls.status, 2)
  assert.deepEqual(await f.queue.openBrowser(), { status: 'login_required', message: '请登录' })
  assert.equal((await f.queue.overview()).browser.status, 'login_required')
})

// Import the existing pipeline only after fixing its DB to a dedicated temporary directory.
const pipelineDirectory = mkdtempSync(join(tmpdir(), 'history-huasheng-pipeline-test-'))
process.env.DB_PATH = join(pipelineDirectory, 'sources.db')
const library = await import('./history-script-library.js')
const { processHistorySource } = await import('./history-source-pipeline.js')

for (const platform of ['baijiahao', 'douyin'] as const) {
  test(`${platform} successful recreation enqueues only after saving the current draft; queue failures cannot lose it`, async t => {
    const source = platform === 'baijiahao' ? library.storeHistoryArticleSource({
      articleId: '123456789012345', sourceUrl: 'https://baijiahao.baidu.com/s?id=123456789012345',
      title: '文章', authorName: '作者', text: '完整文章原文', fetchedAt: new Date().toISOString(),
      metadata: { gid: '12345', platform: '百家号', category: '历史', publishTime: '', keywords: [] },
    }) : library.storeHistorySource({ sourceVideoId: '123456789012346', title: '视频', category: 'regional_history',
      selection: { reason: 'test', observedAt: new Date().toISOString(), comments: [] } })
    let queued = 0
    let mediaCalls = 0
    let recreations = 0
    const dependencies: import('./history-source-pipeline.js').HistoryPipelineDependencies = {
      downloadVideo: async (_source, target) => { mediaCalls++; writeFileSync(target, Buffer.alloc(128, 1)); return { videoPath: target } },
      probeVideo: async () => ({ duration: 12, audioStreamIndex: 0 }),
      extractAudio: async (_video, _chunk, target) => { writeFileSync(target, Buffer.alloc(128, 2)) },
      planChunks: () => [{ start: 0, duration: 12 }],
      transcribeAudio: async () => ({ text: '完整视频转写', duration: 12 }),
      correctTranscript: async text => ({ correctedTranscript: `${text}校对`, corrections: [], factualConcerns: [], factCheckStatus: 'needs_sources' }),
      recreateScript: async text => { recreations++; return { script: `${text}二创`, title: '二创标题', coverText: '封面',
        skillName: 'water-koubo', skillRevision: 'test', skillSha256: 'a'.repeat(64), provider: 'test', model: 'test' } },
      enqueueHuasheng: async id => {
        queued++
        const stored = library.getHistorySource(id)!
        assert.equal(stored.status, 'needs_review')
        assert.equal(library.getHistorySourceArtifactState(stored).rewritten, 'current')
        assert.match(library.requireCurrentHistoryScript(stored), /二创$/)
        throw new Error('模拟花生队列暂不可用')
      },
    }
    const storageRoot = join(pipelineDirectory, platform)
    const result = await processHistorySource(source.id, { dependencies, storageRoot })
    assert.equal(result.status, 'needs_review')
    assert.equal(result.lastError, null)
    assert.equal(JSON.parse(result.reviewJson!).huashengQueue.status, 'pending')
    assert.equal(queued, 1)
    assert.equal(mediaCalls, platform === 'baijiahao' ? 0 : 1)
    assert.equal(recreations, 1)
    // Existing dependency fixtures omit the optional integration; they must not initialize it.
    delete dependencies.enqueueHuasheng
    await processHistorySource(source.id, { dependencies, storageRoot })
    assert.equal(queued, 1)
    assert.equal(recreations, 1)
    const connection = new Database(process.env.DB_PATH!)
    assert.equal(connection.prepare("SELECT name FROM sqlite_master WHERE name = 'history_huasheng_jobs'").get(), undefined)
    connection.close()
  })
}

test('transactional source markers recover missed enqueue after restart without backfilling unmarked current drafts', async t => {
  const pending = library.getHistorySource(2)!
  const legacy = library.storeHistorySource({ sourceVideoId: '123456789012347', title: '已有旧稿不能回填', category: 'regional_history',
    selection: { reason: 'test', observedAt: new Date().toISOString(), comments: [] } })
  const review = JSON.parse(pending.reviewJson!)
  delete review.huashengQueue
  library.updateHistorySource(legacy.id, { status: 'needs_review', rawTranscript: pending.rawTranscript,
    correctedTranscript: pending.correctedTranscript, rewrittenScript: pending.rewrittenScript,
    mediaJson: pending.mediaJson, asrJson: pending.asrJson, reviewJson: JSON.stringify(review) })
  const calls: number[] = []
  const queue = new HistoryHuashengService({
    databasePath: process.env.DB_PATH!,
    loadSource: id => {
      const source = library.getHistorySource(id)!
      return { id, title: source.title, script: library.requireCurrentHistoryScript(source) }
    },
    driver: {
      getHuashengBrowserStatus: async () => { throw new Error('no browser in tests') },
      openHuashengBrowser: async () => { throw new Error('no browser in tests') },
      runHuashengBrowserJob: async input => { calls.push(Number(input.jobId)); return { projectUrl: `https://www.huasheng.cn/video/${input.jobId}` } },
    },
  })
  t.after(() => queue.close())
  queue.setEnabled(false)
  await queue.runPending()
  assert.equal(queue.listJobs().length, 2)
  assert.ok(queue.listJobs().every(job => job.status === 'submitted'))
  assert.equal(queue.listJobs(legacy.id).length, 0)
  assert.equal(JSON.parse(library.getHistorySource(1)!.reviewJson!).huashengQueue, undefined)
  assert.equal(JSON.parse(library.getHistorySource(2)!.reviewJson!).huashengQueue, undefined)
  await queue.runPending()
  assert.equal(calls.length, 2)

  // Emulate a crash/write failure between inserting the job and acknowledging its source marker.
  const marker = { status: 'pending', scriptSha256: queue.listJobs(2)[0]!.scriptSha256, requestedAt: new Date().toISOString() }
  library.updateHistorySource(legacy.id, { reviewJson: JSON.stringify({ ...review, huashengQueue: marker }) })
  const db = new Database(process.env.DB_PATH!)
  t.after(() => db.close())
  db.exec(`CREATE TRIGGER huasheng_test_ack_failure BEFORE UPDATE OF review_json ON history_script_sources
    WHEN OLD.id = ${legacy.id} BEGIN SELECT RAISE(ABORT, 'simulated source acknowledgement failure'); END`)
  await assert.rejects(queue.enqueueMarkedSource(legacy.id), /simulated source acknowledgement failure/)
  assert.equal(queue.listJobs(legacy.id).length, 0, 'job insertion rolls back with marker acknowledgement')
  assert.equal(JSON.parse(library.getHistorySource(legacy.id)!.reviewJson!).huashengQueue.status, 'pending')
  db.exec('DROP TRIGGER huasheng_test_ack_failure')
  await queue.runPending()
  assert.equal(queue.listJobs(legacy.id).length, 1)
  assert.equal(queue.listJobs(legacy.id)[0]!.status, 'submitted')
  assert.equal(JSON.parse(library.getHistorySource(legacy.id)!.reviewJson!).huashengQueue, undefined)
})

test('failed enabled reads persist an uncertainty marker; recovery respects a saved disabled setting', async t => {
  const source = library.updateHistorySource(1, { rewrittenScript: '新版本二创稿，设置读取失败' })!
  let runs = 0
  const queue = new HistoryHuashengService({
    databasePath: process.env.DB_PATH!,
    loadSource: id => {
      const current = library.getHistorySource(id)!
      return { id, title: current.title, script: library.requireCurrentHistoryScript(current) }
    },
    driver: {
      getHuashengBrowserStatus: async () => { throw new Error('unexpected browser access') },
      openHuashengBrowser: async () => { throw new Error('unexpected browser access') },
      runHuashengBrowserJob: async () => { runs++; throw new Error('disabled automation must not run') },
    },
  })
  t.after(() => queue.close())
  queue.setEnabled(false)
  const before = queue.listJobs().length
  const completed = await processHistorySource(source.id, {
    storageRoot: join(pipelineDirectory, 'settings-failure'),
    dependencies: {
      correctTranscript: async () => { throw new Error('current correction must be reused') },
      recreateScript: async () => { throw new Error('current rewrite must be reused') },
      huashengEnabled: () => { throw new Error('simulated settings read failure') },
      enqueueHuasheng: async () => { throw new Error('simulated enqueue outage') },
    },
  })
  assert.equal(completed.status, 'needs_review')
  assert.equal(JSON.parse(library.getHistorySource(source.id)!.reviewJson!).huashengQueue.checkEnabled, true)
  await queue.runPending()
  assert.equal(queue.listJobs().length, before)
  assert.equal(runs, 0)
  assert.equal(JSON.parse(library.getHistorySource(source.id)!.reviewJson!).huashengQueue, undefined)
  queue.setEnabled(true)
  await queue.runPending()
  assert.equal(queue.listJobs().length, before, 'enabling later must not backfill an unaccepted draft')
})
