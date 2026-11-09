import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryHuashengService } from './history-huasheng.js'
import { createHistoryHuashengRoute } from '../routes/history-huasheng.js'

function fixture(t: TestContext) {
  let now = 1_000_000
  let inspections = 0
  let submissions = 0
  const databasePath = join(mkdtempSync(join(tmpdir(), 'huasheng-monitor-test-')), 'test.db')
  const options = {
    databasePath, monitorNow: () => now,
    loadSource: (id: number) => ({ id, title: `稿件 ${id}`, script: `已保存的二创正文 ${id}` }),
    driver: {
      getHuashengBrowserStatus: async () => ({ status: 'ready' as const, message: '已登录' }),
      openHuashengBrowser: async () => ({ status: 'ready' as const, message: '已登录' }),
      runHuashengBrowserJob: async () => { submissions++; return { projectUrl: 'https://www.huasheng.cn/video/999' } },
      inspectHuashengProject: async () => { inspections++; return { status: 'completed' as const, message: '可导出' } },
    },
  }
  const queue = new HistoryHuashengService(options)
  const sql = new Database(databasePath)
  t.after(async () => { sql.close(); await queue.close() })
  return { queue, sql, options, inspections: () => inspections, submissions: () => submissions, advance: (ms: number) => { now += ms } }
}

async function finish(queue: HistoryHuashengService) {
  while (queue.productionChecking) await new Promise<void>(resolve => setImmediate(resolve))
}

test('monitoring is opt-in, durable, interval-limited and never submits or downloads videos', async t => {
  const f = fixture(t)
  const job = (await f.queue.enqueue(1))!
  f.sql.prepare("UPDATE history_huasheng_jobs SET project_url=?, status='submitted', production_status='creating' WHERE id=?")
    .run('https://www.huasheng.cn/video/123', job.id)
  assert.equal(f.queue.monitoring.enabled, false)
  assert.equal(f.queue.runMonitoring(), false)
  f.queue.setMonitoring(true)
  assert.equal(f.queue.runMonitoring(), true)
  assert.equal(f.queue.runMonitoring(), false)
  await finish(f.queue)
  assert.equal(f.inspections(), 1)
  assert.equal(f.submissions(), 0)
  assert.equal(f.queue.getJob(job.id).productionStatus, 'completed')
  assert.ok(f.queue.monitoring.lastCheckedAt)
  assert.ok(f.queue.monitoring.nextCheckAt)
  assert.equal(f.queue.runMonitoring(), false)
  const settled = f.queue.monitoring
  f.advance(60_000)
  assert.equal(f.queue.runMonitoring(), false)
  await finish(f.queue)
  assert.equal(f.inspections(), 1, 'completed projects leave the recurring inspection set')
  assert.deepEqual(f.queue.monitoring, settled, 'idle monitoring does not acquire a lease or reschedule checks')
  const restarted = new HistoryHuashengService(f.options)
  t.after(() => restarted.close())
  assert.equal(restarted.monitoring.enabled, true)
  assert.equal(restarted.runMonitoring(), false, 'an idle restart does not schedule external work')
})

test('recurring checks exclude canceled and stale versions, while explicit batch checks retain their existing scope', async t => {
  const f = fixture(t)
  for (let id = 1; id <= 3; id++) await f.queue.enqueue(id)
  f.sql.prepare("UPDATE history_huasheng_jobs SET project_url='https://www.huasheng.cn/video/' || id, status='submitted', production_status='creating'").run()
  f.sql.prepare("UPDATE history_huasheng_jobs SET status='canceled' WHERE source_id=2").run()
  f.sql.prepare("UPDATE history_huasheng_jobs SET script_sha256='outdated' WHERE source_id=3").run()
  f.queue.setMonitoring(true)
  f.queue.runMonitoring()
  await finish(f.queue)
  assert.equal(f.inspections(), 1)
  f.queue.checkProduction()
  await finish(f.queue)
  assert.equal(f.inspections(), 4, 'manual inspection still inspects all linked historical projects')
})

test('multiple workers share the due-time claim and disabling monitoring stops future checks', async t => {
  const f = fixture(t)
  const job = (await f.queue.enqueue(1))!
  f.sql.prepare("UPDATE history_huasheng_jobs SET project_url=?, status='submitted', production_status='creating' WHERE id=?")
    .run('https://www.huasheng.cn/video/123', job.id)
  const other = new HistoryHuashengService(f.options)
  t.after(() => other.close())
  f.queue.setMonitoring(true)
  assert.equal(f.queue.runMonitoring(), true)
  assert.equal(other.runMonitoring(), false)
  await finish(f.queue)
  other.setMonitoring(false)
  f.advance(600_000)
  assert.equal(f.queue.runMonitoring(), false)
  assert.equal(f.queue.monitoring.enabled, false)
  assert.equal(f.inspections(), 1)
})

test('monitoring settings enforce local command guards without starting browser work', async t => {
  const f = fixture(t)
  const route = createHistoryHuashengRoute({ service: f.queue })
  const send = (body: unknown, headers: Record<string, string> = {}, path = '/huasheng/monitoring') => route.request(path, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const response = await send({ enabled: true })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.enabled, true)
  for (const body of [null, [], {}, { enabled: 'true' }, { enabled: true, intervalMs: 1 }]) assert.equal((await send(body)).status, 400)
  assert.equal((await send({ enabled: true }, { Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await send({ enabled: true }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await send({ enabled: true }, {}, '/huasheng/monitoring?run=1')).status, 400)
  assert.equal(f.inspections(), 0)
  assert.equal(f.submissions(), 0)
  assert.equal((await (await route.request('/huasheng')).json()).data.monitoring.enabled, true)
})

test('recurring checks only inspect accepted cloud work and leave blocked or unresolved tasks for the user', async t => {
  const f = fixture(t)
  const cases = [
    ['submitted', 'queued', 0], ['submitted', 'creating', 0], ['submitted', 'not_started', 0],
    ['queued', 'not_started', 0], ['running', 'creating', 0], ['failed', 'creating', 0],
    ['needs_attention', 'not_started', 0], ['waiting_login', 'creating', 0], ['submitted', 'completed', 0],
    ['submitted', 'creating', 1],
  ] as const
  const jobs = []
  for (const [index, [status, production, canceled]] of cases.entries()) {
    const job = (await f.queue.enqueue(index + 1))!
    jobs.push(job)
    f.sql.prepare("UPDATE history_huasheng_jobs SET project_url=?, status=?, production_status=?, cancel_requested=? WHERE id=?")
      .run(`https://www.huasheng.cn/video/${job.id}`, status, production, canceled, job.id)
  }
  const unresolved = (await f.queue.enqueue(cases.length + 1))!
  f.sql.prepare("UPDATE history_huasheng_jobs SET status='needs_attention',checkpoint='create_pending' WHERE id=?").run(unresolved.id)
  f.options.driver.openHuashengBrowser = async () => assert.fail('monitoring cannot open a browser')
  f.queue.setMonitoring(true)
  assert.equal(f.queue.runMonitoring(), true)
  await finish(f.queue)
  assert.equal(f.inspections(), 2)
  assert.ok(f.queue.getJob(jobs[0]!.id).productionCheckedAt)
  assert.ok(f.queue.getJob(jobs[1]!.id).productionCheckedAt)
  for (const job of [...jobs.slice(2), unresolved]) assert.equal(f.queue.getJob(job.id).productionCheckedAt, null)
  f.advance(600_000)
  assert.equal(f.queue.runMonitoring(), false)
  assert.equal(f.submissions(), 0)
})

test('failed inspections back off and retain the last observed state without retrying creation', async t => {
  const f = fixture(t)
  const job = (await f.queue.enqueue(1))!
  f.sql.prepare("UPDATE history_huasheng_jobs SET project_url=?, status='submitted', production_status='creating' WHERE id=?")
    .run('https://www.huasheng.cn/video/123', job.id)
  f.options.driver.inspectHuashengProject = async () => { throw new Error('暂时无法连接花生') }
  f.queue.setMonitoring(true)
  f.queue.runMonitoring()
  await finish(f.queue)
  assert.equal(f.queue.getJob(job.id).productionStatus, 'creating')
  assert.match(f.queue.getJob(job.id).productionCheckError!, /暂时无法连接/)
  f.advance(60_000)
  assert.equal(f.queue.runMonitoring(), false, 'the first failure increases the interval to two minutes')
  f.advance(60_000)
  assert.equal(f.queue.runMonitoring(), true)
  await finish(f.queue)
  assert.equal(f.submissions(), 0)
})
