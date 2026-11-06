import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryHuashengRoute } from './history-huasheng.js'
import { HistoryHuashengService, HuashengQueueError, type HuashengBrowserDriver } from '../services/history-huasheng.js'

function fixture(t: TestContext, run?: HuashengBrowserDriver['runHuashengBrowserJob'], inspect?: HuashengBrowserDriver['inspectHuashengProject']) {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'history-huasheng-api-test-')), 'test.db')
  const calls = { status: 0, open: 0, run: 0 }
  const service = new HistoryHuashengService({
    databasePath,
    loadSource: id => {
      if (id === 404) throw new HuashengQueueError('文稿不存在', 404)
      if (id === 409) throw new HuashengQueueError('文稿已过期')
      return { id, title: `文稿 ${id}`, script: `二创正文 ${id}` }
    },
    driver: {
      getHuashengBrowserStatus: async () => { calls.status++; return { status: 'ready', message: '已登录' } },
      openHuashengBrowser: async () => { calls.open++; return { status: 'login_required', message: '请登录' } },
      runHuashengBrowserJob: run ?? (async input => { calls.run++; return { projectUrl: `https://www.huasheng.cn/video/${input.jobId}` } }),
      inspectHuashengProject: inspect,
    },
  })
  t.after(() => service.close())
  return { service, calls, route: createHistoryHuashengRoute({ service }) }
}

test('production checks return 202 immediately, coalesce, expose checking in both views and never create projects', async t => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  let inspections = 0
  const f = fixture(t, undefined, async () => { inspections++; await waiting; return { status: 'completed', message: '可以下载成片' } })
  await f.service.enqueue(1)
  await f.service.runPending()
  const runs = f.calls.run
  await f.service.enqueue(2)
  const response = await command(f.route, '/1/huasheng/check-production')
  assert.equal(response.status, 202)
  assert.deepEqual((await response.json()).data, { checking: true })
  assert.equal((await (await f.route.request('/1/huasheng')).json()).data.productionChecking, true)
  assert.equal((await (await f.route.request('/huasheng')).json()).data.productionChecking, true)
  assert.equal((await command(f.route, '/huasheng/check-production')).status, 202)
  release()
  while (f.service.productionChecking) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(inspections, 1)
  assert.equal(f.calls.run, runs)
  assert.equal(f.calls.open, 0)
  assert.equal(f.service.listJobs().length, 2)
  const detail = (await (await f.route.request('/1/huasheng')).json()).data
  assert.equal(detail.productionChecking, false)
  assert.equal(detail.jobs[0].productionStatus, 'completed')
  assert.ok(detail.jobs[0].productionCheckedAt)
  assert.equal(detail.jobs[0].productionMessage, '可以下载成片')
  assert.equal(detail.jobs[0].productionCheckError, null)
  assert.equal(f.service.listJobs(2)[0]!.productionStatus, 'not_started')
})

test('production command guards reject malformed, cross-origin and parameterized requests without inspection or submission', async t => {
  let inspections = 0
  const f = fixture(t, undefined, async () => { inspections++; return { status: 'completed', message: '可导出' } })
  await f.service.enqueue(1)
  await f.service.runPending()
  const runs = f.calls.run
  for (const path of ['/huasheng/check-production', '/1/huasheng/check-production']) {
    for (const body of [null, [], { projectUrl: 'https://attacker.example/' }, { create: true }]) {
      assert.equal((await command(f.route, path, body)).status, 400)
    }
    assert.equal((await command(f.route, path, {}, 'POST', { Origin: 'https://attacker.example' })).status, 403)
    assert.equal((await command(f.route, path, {}, 'POST', { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
    assert.equal((await command(f.route, `${path}?create=true`)).status, 400)
    assert.equal((await f.route.request(path, { method: 'POST' })).status, 400)
  }
  for (const id of ['0', '-1', 'bad', '1.5', '9999999999999999999']) {
    assert.equal((await command(f.route, `/${id}/huasheng/check-production`)).status, 400)
  }
  assert.equal(inspections, 0)
  assert.equal(f.calls.run, runs)
  assert.equal(f.calls.open, 0)
  assert.equal(f.service.productionChecking, false)
})

test('selected production check inspects exactly the selected jobs without enabling monitoring or checking other versions', async t => {
  const inspected: string[] = []
  const f = fixture(t, undefined, async input => {
    inspected.push(input.projectUrl)
    return { status: 'completed', message: '可导出' }
  })
  const first = (await f.service.enqueue(1))!
  const second = (await f.service.enqueue(2))!
  const third = (await f.service.enqueue(3))!
  await f.service.runPending()
  const calls = { ...f.calls }
  const response = await command(f.route, '/huasheng/check-production', { jobIds: [first.id, third.id, first.id] })
  assert.equal(response.status, 202)
  assert.deepEqual((await response.json()).data, { checking: true })
  while (f.service.productionChecking) await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(new Set(inspected), new Set([first.id, third.id].map(id => `https://www.huasheng.cn/video/${id}`)))
  assert.equal(inspected.length, 2)
  assert.equal(f.service.getJob(first.id).productionStatus, 'completed')
  assert.equal(f.service.getJob(second.id).productionCheckedAt, null)
  assert.equal(f.service.getJob(third.id).productionStatus, 'completed')
  assert.equal(f.service.monitoring.enabled, false)
  assert.deepEqual(f.calls, calls)
})

test('invalid and empty selected checks never fall back to checking all projects', async t => {
  let inspections = 0
  const f = fixture(t, undefined, async () => { inspections++; return { status: 'completed', message: '可导出' } })
  await f.service.enqueue(1)
  await f.service.runPending()
  for (const jobIds of [[], null, '1', [0], [-1], [1.5], ['1'], [Number.MAX_SAFE_INTEGER + 1], Array(101).fill(1)]) {
    assert.equal((await command(f.route, '/huasheng/check-production', { jobIds })).status, 400)
  }
  assert.equal((await command(f.route, '/1/huasheng/check-production', { jobIds: [1] })).status, 400)
  assert.equal((await command(f.route, '/huasheng/check-production', { jobIds: [1], all: true })).status, 400)
  assert.equal((await command(f.route, '/huasheng/check-production', { jobIds: [1] }, 'POST', { Origin: 'https://attacker.example' })).status, 403)
  const missing = await command(f.route, '/huasheng/check-production', { jobIds: [999] })
  assert.equal(missing.status, 202)
  assert.deepEqual((await missing.json()).data, { checking: false })
  assert.equal(inspections, 0)
  assert.equal(f.service.productionChecking, false)
})
function command(route: ReturnType<typeof createHistoryHuashengRoute>, path: string, body: unknown = {}, method = 'POST', headers: Record<string, string> = {}) {
  return route.request(path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

test('refined backfill returns per-source durable admission without running the Huasheng service',async t=>{
  const f=fixture(t),selections:number[][]=[]
  const expected={results:[{sourceId:141,status:'reused',episodeId:1063},{sourceId:62,status:'queued'},{sourceId:99,status:'blocked',message:'当前稿没有已完成花生作品'}]}
  const route=createHistoryHuashengRoute({service:f.service,refineCompleted:sourceIds=>{selections.push(sourceIds);return expected}})
  const response=await command(route,'/huasheng/refine-completed',{sourceIds:[141,62,99]})
  assert.equal(response.status,202)
  assert.equal(response.headers.get('Cache-Control'),'no-store')
  assert.deepEqual((await response.json()).data,expected)
  assert.deepEqual(selections,[[141,62,99]])
  assert.deepEqual(f.calls,{status:0,open:0,run:0})
})

test('refined backfill requires a bounded explicit source selection and rejects invalid or cross-origin commands before admission',async()=>{
  let calls=0
  const route=createHistoryHuashengRoute({refineCompleted:()=>{calls++;return {results:[]}}})
  for(const body of [{},null,[],{sourceIds:[]},{sourceIds:null},{sourceIds:'141'},{sourceIds:[0]},
    {sourceIds:[-1]},{sourceIds:[1.1]},{sourceIds:['141']},{sourceIds:[Number.MAX_SAFE_INTEGER+1]},
    {sourceIds:Array(101).fill(1)},{sourceIds:[141],all:true}]) {
    assert.equal((await command(route,'/huasheng/refine-completed',body)).status,400)
  }
  assert.equal((await command(route,'/huasheng/refine-completed',{sourceIds:[141]},'POST',{Origin:'https://attacker.example'})).status,403)
  assert.equal((await command(route,'/huasheng/refine-completed',{sourceIds:[141]},'POST',{'Sec-Fetch-Site':'cross-site'})).status,403)
  assert.equal((await command(route,'/huasheng/refine-completed?all=true',{sourceIds:[141]})).status,400)
  assert.equal(calls,0)
})

test('produce returns 202 per selected job, runs asynchronously without a global worker and exposes real status through GET', async t => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const runs: number[] = []
  const f = fixture(t, async input => {
    runs.push(Number(input.jobId))
    await waiting
    await input.onCheckpoint({ checkpoint: 'submitted', projectUrl: `https://www.huasheng.cn/video/${input.jobId}`, productionStatus: 'queued', message: '平台已排队' })
    return { projectUrl: `https://www.huasheng.cn/video/${input.jobId}` }
  })
  const first = (await f.service.enqueue(1, { automatic: true }))!
  const unselected = (await f.service.enqueue(2, { automatic: true }))!
  assert.equal(first.projectUrl, null)
  const response = await command(f.route, '/huasheng/produce', { jobIds: [first.id, 999, first.id] })
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const body = await response.json()
  assert.equal(body.code, 202)
  assert.deepEqual(body.data.results.map((item: { jobId: number; sourceId: number | null; status: string }) => [item.jobId, item.sourceId, item.status]), [[first.id, 1, 'queued'], [999, null, 'blocked']])
  assert.ok(body.data.results.every((item: { message: string }) => item.message.length > 0))
  assert.equal(body.data.running, true)
  assert.equal((await (await f.route.request('/1/huasheng')).json()).data.jobs[0].status, 'running')
  const duplicate = await command(f.route, '/huasheng/produce', { jobIds: [first.id] })
  assert.equal((await duplicate.json()).data.results[0].status, 'skipped')
  release()
  while (f.service.producing) await new Promise<void>(resolve => setImmediate(resolve))
  const refreshed = (await (await f.route.request('/1/huasheng')).json()).data.jobs[0]
  assert.equal(refreshed.status, 'submitted')
  assert.equal(refreshed.productionStatus, 'queued')
  assert.equal(refreshed.projectUrl, `https://www.huasheng.cn/video/${first.id}`)
  assert.deepEqual(runs, [first.id])
  assert.equal(f.service.getJob(unselected.id).status, 'queued')
  assert.equal(f.service.getJob(unselected.id).attempts, 0)
  assert.equal(f.service.monitoring.enabled, false)
})

test('produce requires an explicit bounded valid selection and rejects cross-origin requests without starting work', async t => {
  const f = fixture(t)
  const job = (await f.service.enqueue(1))!
  for (const body of [{}, null, [], { jobIds: null }, { jobIds: [] }, { jobIds: '1' }, { jobIds: [0] },
    { jobIds: [-1] }, { jobIds: [1.5] }, { jobIds: ['1'] }, { jobIds: [Number.MAX_SAFE_INTEGER + 1] },
    { jobIds: Array(101).fill(job.id) }, { jobIds: [job.id], all: true }]) {
    assert.equal((await command(f.route, '/huasheng/produce', body)).status, 400)
  }
  assert.equal((await command(f.route, '/huasheng/produce', { jobIds: [job.id] }, 'POST', { Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await command(f.route, '/huasheng/produce', { jobIds: [job.id] }, 'POST', { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await command(f.route, '/huasheng/produce?all=true', { jobIds: [job.id] })).status, 400)
  assert.equal((await f.route.request('/huasheng/produce', { method: 'POST' })).status, 400)
  assert.equal((await f.route.request('/huasheng/produce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  assert.deepEqual(f.calls, { status: 0, open: 0, run: 0 })
  assert.equal(f.service.getJob(job.id).attempts, 0)
  assert.equal(f.service.producing, false)
})

test('overview and source history expose the agreed envelope without private script snapshots', async t => {
  const f = fixture(t)
  const initial = await f.route.request('/huasheng')
  assert.equal(initial.status, 200)
  assert.equal(initial.headers.get('Cache-Control'), 'no-store')
  const data = (await initial.json()).data
  assert.equal(data.enabled, true)
  assert.equal(data.browser.status, 'unavailable')
  assert.equal(f.calls.status, 0, 'Read-only inventory must not check the live browser')
  assert.deepEqual(data.jobs, [])
  const submitted = await command(f.route, '/1/huasheng')
  assert.equal(submitted.status, 200)
  const first = (await submitted.json()).data.job
  const duplicate = (await (await command(f.route, '/1/huasheng')).json()).data.job
  assert.equal(first.id, duplicate.id)
  for (const field of ['id', 'sourceId', 'title', 'status', 'stage', 'message', 'projectUrl', 'videoUrl', 'error', 'createdAt', 'updatedAt', 'scriptSha256', 'checkpoint']) {
    assert.ok(field in first, `missing ${field}`)
  }
  assert.equal('script' in first, false)
  assert.equal('owner' in first, false)
  await command(f.route, '/2/huasheng')
  assert.equal((await (await f.route.request('/1/huasheng')).json()).data.jobs.length, 1)
  const page = (await (await f.route.request('/huasheng?limit=1')).json()).data
  assert.equal(page.jobs.length, 1)
  assert.equal(page.nextBeforeId, page.jobs[0].id)
  const next = (await (await f.route.request(`/huasheng?beforeId=${page.nextBeforeId}&limit=1`)).json()).data
  assert.equal(next.jobs[0].id, first.id)
  assert.equal(f.calls.run, 0, 'API imports/construction do not start the worker')
})

test('enabled controls auto admission only; manual submit and resume work while disabled', async t => {
  const f = fixture(t)
  const setting = await command(f.route, '/huasheng/settings', { enabled: false }, 'PUT')
  assert.deepEqual((await setting.json()).data, { enabled: false })
  assert.equal(await f.service.enqueue(2, { automatic: true }), null)
  const job = (await (await command(f.route, '/1/huasheng')).json()).data.job
  assert.equal((await (await command(f.route, `/huasheng/jobs/${job.id}/cancel`)).json()).data.job.status, 'canceled')
  assert.equal((await (await command(f.route, `/huasheng/jobs/${job.id}/resume`)).json()).data.job.status, 'queued')
  await f.service.runPending()
  assert.equal(f.service.getJob(job.id).status, 'submitted')
})

test('login commands use the browser wrapper and explicit checking bypasses cached overview', async t => {
  const f = fixture(t)
  assert.deepEqual((await (await command(f.route, '/huasheng/browser/open')).json()).data.browser, { status: 'login_required', message: '请登录' })
  assert.equal((await (await f.route.request('/huasheng')).json()).data.browser.status, 'login_required')
  assert.equal((await (await command(f.route, '/huasheng/browser/check')).json()).data.browser.status, 'ready')
  assert.deepEqual(f.calls, { status: 1, open: 1, run: 0 })
})

test('malformed commands, hostile origins and invalid IDs fail before state or browser effects', async t => {
  const f = fixture(t)
  for (const body of [{ enabled: 'true' }, { enabled: true, extra: 1 }, {}, null, []]) {
    assert.equal((await command(f.route, '/huasheng/settings', body, 'PUT')).status, 400)
  }
  assert.equal((await command(f.route, '/huasheng/browser/open', { extra: 1 })).status, 400)
  assert.equal((await command(f.route, '/huasheng/jobs/1/resume', { projectUrl: 1 })).status, 400)
  assert.equal((await f.route.request('/1/huasheng', { method: 'POST' })).status, 400)
  assert.equal((await f.route.request('/1/huasheng', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  const rejectedHeaders: Array<Record<string, string>> = [{ Origin: 'https://attacker.example' }, { Origin: 'http://localhost:9999' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]
  for (const headers of rejectedHeaders) {
    assert.equal((await command(f.route, '/huasheng/browser/open', {}, 'POST', headers)).status, 403)
  }
  for (const id of ['0', '-1', '1.5', '1e2', 'bad', '9999999999999999999']) {
    assert.equal((await command(f.route, `/${id}/huasheng`)).status, 400)
    assert.equal((await command(f.route, `/huasheng/jobs/${id}/resume`)).status, 400)
  }
  assert.equal((await f.route.request('/huasheng?limit=101')).status, 400)
  assert.equal((await f.route.request('/huasheng?beforeId=-1')).status, 400)
  assert.equal((await command(f.route, '/1/huasheng?enabled=true')).status, 400)
  assert.equal((await command(f.route, '/404/huasheng')).status, 404)
  assert.equal((await command(f.route, '/409/huasheng')).status, 409)
  assert.equal((await command(f.route, '/huasheng/jobs/123/cancel')).status, 404)
  assert.deepEqual(f.calls, { status: 0, open: 0, run: 0 })
  assert.equal(f.service.listJobs().length, 0)
})

test('resume can bind only an unbound create_pending exception and uses the driver URL validator without resetting checkpoints', async t => {
  let attempt = 0
  const f = fixture(t, async input => {
    attempt++
    if (attempt === 1) {
      await input.onCheckpoint({ checkpoint: 'create_pending', message: '创建结果未知' })
      throw Object.assign(new Error('请核验原项目'), { code: 'manual_review' })
    }
    assert.equal(input.checkpoint, 'create_pending')
    assert.equal(input.projectUrl, 'https://www.huasheng.cn/video/123')
    assert.equal(input.script, '二创正文 1')
    return { projectUrl: input.projectUrl! }
  })
  const job = (await f.service.enqueue(1))!
  await f.service.runPending()
  for (const projectUrl of ['https://evil.example/video/123', 'http://www.huasheng.cn/video/123', 'https://www.huasheng.cn:123/video/1',
    'https://name:pass@www.huasheng.cn/video/123', 'https://www.huasheng.cn/', 'https://www.huasheng.cn/video/nope']) {
    assert.equal((await command(f.route, `/huasheng/jobs/${job.id}/resume`, { projectUrl })).status, 400)
  }
  const response = await command(f.route, `/huasheng/jobs/${job.id}/resume`, { projectUrl: 'https://www.huasheng.cn/video/123/?from=history' })
  assert.equal(response.status, 200)
  const resumed = (await response.json()).data.job
  assert.equal(resumed.projectUrl, 'https://www.huasheng.cn/video/123')
  assert.equal(resumed.checkpoint, 'create_pending')
  assert.equal((await command(f.route, `/huasheng/jobs/${job.id}/resume`, { projectUrl: 'https://www.huasheng.cn/video/456' })).status, 409)
  await f.service.runPending()
  assert.equal((await command(f.route, `/huasheng/jobs/${job.id}/resume`, { projectUrl: 'https://www.huasheng.cn/video/123' })).status, 409)
  assert.equal(f.service.getJob(job.id).status, 'submitted')
})

test('successful login check automatically releases waiting-login jobs and preserves their checkpoints', async t => {
  let ready = false
  const f = fixture(t, async input => {
    if (!ready) {
      await input.onCheckpoint({ checkpoint: 'created', projectUrl: 'https://www.huasheng.cn/video/77', message: '需重新登录' })
      throw Object.assign(new Error('登录失效'), { code: 'login_required' })
    }
    if (input.jobId === 1) assert.equal(input.checkpoint, 'created')
    return { projectUrl: input.projectUrl ?? 'https://www.huasheng.cn/video/78' }
  })
  const first = (await f.service.enqueue(1, { automatic: true }))!
  const second = (await f.service.enqueue(2, { automatic: true }))!
  await f.service.runPending()
  assert.equal(f.service.getJob(first.id).status, 'waiting_login')
  assert.equal(f.service.getJob(second.id).status, 'queued')
  ready = true
  assert.equal((await command(f.route, '/huasheng/browser/check')).status, 200)
  assert.equal(f.service.getJob(first.id).status, 'queued')
  assert.equal(f.service.getJob(first.id).checkpoint, 'created')
  await f.service.runPending()
  assert.equal(f.service.getJob(first.id).status, 'submitted')
  assert.equal(f.service.getJob(second.id).status, 'submitted')
})

test('main history router mounts static huasheng routes before its source-id matcher', async t => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'history-huasheng-mount-test-')), 'library.db')
  const { createHistoryScriptsRoute } = await import('./history-scripts.js')
  const f = fixture(t)
  const app = createHistoryScriptsRoute({ huasheng: { service: f.service } })
  assert.equal((await app.request('/huasheng')).status, 200)
  assert.equal((await command(app, '/1/huasheng')).status, 200)
  assert.equal((await app.request('/1/huasheng')).status, 200)
  assert.equal((await app.request('/?limit=1')).status, 200)
  assert.equal(f.calls.run, 0)
})
