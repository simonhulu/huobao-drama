import test from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { createHistorySocialUploadRoute } from './history-social-upload.js'
import { HistorySocialUploadService, type HistorySocialSource, type HistorySocialRuntime } from '../services/history-social-upload.js'

async function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-social-route-')))
  const root = path.join(directory, 'static')
  const materials = path.join(root, 'history-deliveries', '71')
  fs.mkdirSync(materials, { recursive: true })
  fs.writeFileSync(path.join(materials, 'video.mp4'), 'already validated video')
  await sharp({ create: { width: 32, height: 24, channels: 3, background: '#ffffff' } }).png().toFile(path.join(materials, 'cover.png'))
  const script = '已经保存的当前二创稿件。'
  const digest = createHash('sha256').update(script).digest('hex')
  const source: HistorySocialSource = { id: 71, title: '历史项目', rewrittenScript: script, artifactState: 'current', delivery: {
    title: '明朝冬季的蔬菜供应', baijiahaoTitle: '明朝冬季蔬菜供应与运输', description: '蔬菜供应与运输。',
    videoUrl: '/static/history-deliveries/71/video.mp4', scriptSha256: digest, coverScriptSha256: digest, coverStatus: 'completed',
    covers: Object.fromEntries(['16:9', '3:4', '4:3'].map(ratio => [ratio, '/static/history-deliveries/71/cover.png'])),
  } }
  const calls = { inspect: 0, run: 0, save: 0, open: 0, login: 0, resume: 0, reconcile: 0 }
  const runtime: HistorySocialRuntime = {
    inspectSocialUploadRuntime: async () => { calls.inspect++; return { installed: true, message: 'ready', version: 'test',
      platforms: { baijiahao: { ready: true, message: 'ready' }, tencent: { ready: true, message: 'ready' } } } },
    runSocialUpload: async (payload, options) => { calls.run++; return { staged: true, saved: options.saveDraft, published: false,
      targetId: `target-${payload.jobId}`, editorUrl: payload.target === 'tencent-video' ? 'https://channels.weixin.qq.com/platform/post/create'
        : 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', engine: 'test' } },
    confirmSocialUpload: async (payload, result) => { calls.save++; return payload.publicationMode === 'publish'
      ? { ...result, saved: false, submitted: true, published: false, publicationStatus: 'submitted', articleId: '1880027026933416669',
        publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=1880027026933416669' }
      : { ...result, saved: true } },
    focusSocialUpload: async () => { calls.open++; return { opened: true } },
    openSocialUploadLogin: async () => { calls.login++; return { opened: true } },
  }
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,deleted_at TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY,video_path TEXT);
    INSERT INTO history_script_sources VALUES(71,'历史项目',NULL),(72,'没有成片',NULL),(73,'已删除','deleted');
    INSERT INTO history_script_deliveries VALUES(71,'static/history-deliveries/71/video.mp4'),(72,NULL),(73,'static/deleted.mp4');`)
  const service = new HistorySocialUploadService({ database, root, runtime,
    loadSource: id => id === 71 ? structuredClone(source) : null,
    getArticle: () => ({ status: 'idle', stale: false, article: null }),
  })
  t.after(async () => { await service.close(); database.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { service, route: createHistorySocialUploadRoute({ service }), calls, runtime, source, database }
}

function post(route: ReturnType<typeof createHistorySocialUploadRoute>, url: string, body: unknown, headers: Record<string, string> = {}) {
  return route.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

test('upload route validates source IDs before inspecting runtime or starting a job', async t => {
  let inspections = 0
  const service = new HistorySocialUploadService({ databasePath: ':memory:', runtime: {
    inspectSocialUploadRuntime: async () => { inspections++; throw new Error('must not inspect') },
    runSocialUpload: async () => { throw new Error('must not upload') },
    confirmSocialUpload: async () => { throw new Error('must not save') },
  } })
  t.after(() => service.close())
  const route = createHistorySocialUploadRoute({ service })
  const response = await route.request('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceIds: [0], targets: ['baijiahao-video'] }) })
  assert.equal(response.status, 400)
  assert.equal(inspections, 0)
  assert.deepEqual(service.listJobs(), [])
})

test('GET candidates and CSV preflight expose frontend aliases without creating jobs or uploading', async t => {
  const h = await fixture(t)
  const candidates = await h.route.request('/candidates')
  const items = (await candidates.json()).data.items
  assert.equal(items.length, 1)
  assert.equal(items[0].scriptId, 71)
  assert.equal(items[0].title, '历史项目')
  assert.deepEqual(items[0].uploads, {})
  assert.equal(items[0].versions[0].state, 'stale')
  assert.equal(items[0].versions[0].canPublish, false)
  const response = await h.route.request('/preflight?sourceIds=71&targets=baijiahao-video,baijiahao-article,tencent-video&mode=stage')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const { data } = await response.json()
  assert.equal(data.items.length, 3)
  assert.deepEqual(data.items.map((item: { ready: boolean }) => item.ready), [true, false, true])
  assert.equal(data.items[0].scriptId, 71)
  assert.equal(data.items[0].sourceId, 71)
  assert.equal(data.items[0].title, '历史项目')
  assert.equal(data.items[0].sourceTitle, '历史项目')
  assert.equal(data.items[1].engine, 'project-extension')
  assert.ok(data.items[1].blockers.some((issue: { field: string; message: string }) => issue.field === 'article' && issue.message))
  assert.equal(h.calls.run, 0)
  assert.equal(h.calls.save, 0)
  assert.deepEqual(h.service.listJobs(), [])
})

test('GET candidates optionally scopes source IDs while preserving the unfiltered inventory', async t => {
  const h = await fixture(t)
  h.database.prepare('UPDATE history_script_deliveries SET video_path=? WHERE script_id=72').run('static/history-deliveries/72/video.mp4')
  const read = async (query = '') => {
    const response = await h.route.request(`/candidates${query}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    return (await response.json()).data.items
  }
  assert.deepEqual((await read()).map((item: {scriptId: number}) => item.scriptId), [72, 71])
  assert.deepEqual((await read('?sourceIds=71')).map((item: {scriptId: number}) => item.scriptId), [71])
  assert.deepEqual((await read('?sourceIds=72,71,71,73')).map((item: {scriptId: number}) => item.scriptId), [72, 71])
  assert.deepEqual(await read('?sourceIds=73,999'), [])
  assert.deepEqual((await read(`?sourceIds=${Array.from({length: 100}, (_, index) => index + 1).join(',')}`))
    .map((item: {scriptId: number}) => item.scriptId), [72, 71])
  assert.deepEqual((await read()).map((item: {scriptId: number}) => item.scriptId), [72, 71])
  assert.equal(h.calls.inspect, 0)
  assert.equal(h.calls.run, 0)
  assert.deepEqual(h.service.listJobs(), [])
})

test('GET candidates rejects malformed, repeated or unsupported query parameters before reading candidates', async t => {
  const h = await fixture(t)
  let reads = 0
  const candidates = h.service.candidates.bind(h.service)
  h.service.candidates = (...args) => { reads++; return candidates(...args) }
  for (const query of ['sourceIds=', 'sourceIds=0', 'sourceIds=-1', 'sourceIds=1.5', 'sourceIds=1e2',
    'sourceIds=9007199254740992', 'sourceIds=71,', 'sourceIds=,71', 'sourceIds=71,%2072',
    'sourceIds=71&sourceIds=72', 'sourceIds=71&limit=50', 'q=71',
    `sourceIds=${Array.from({length: 101}, (_, index) => index + 1).join(',')}`]) {
    assert.equal((await h.route.request(`/candidates?${query}`)).status, 400, query)
  }
  assert.equal(reads, 0)
  assert.equal(h.calls.inspect, 0)
  assert.equal(h.calls.run, 0)
  assert.deepEqual(h.service.listJobs(), [])
})

test('the shared source production state is read-only and includes editions before an upload job exists', async t => {
  const h = await fixture(t)
  const response = await h.route.request('/sources/71/state')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const { data } = await response.json()
  assert.equal(data.production.scriptId, 71)
  assert.equal(data.production.versions[0].state, 'stale')
  assert.deepEqual(data.jobs, [])
  assert.equal(data.queue.runningJobId, null)
  assert.equal(h.calls.inspect, 0)
  assert.equal(h.calls.run, 0)
  assert.equal(h.calls.save, 0)
  assert.deepEqual(h.service.listJobs(), [])
  assert.equal((await h.route.request('/sources/0/state')).status, 400)
  assert.equal((await h.route.request('/sources/73/state')).status, 404)
  assert.equal((await h.route.request('/sources/71/state?refresh=true')).status, 400)
})

test('omitted HTTP mode defaults to Baijiahao publication and returns submitted distinctly from published', async t => {
  const h = await fixture(t)
  const query = '/preflight?sourceIds=71&targets=baijiahao-video'
  assert.equal((await (await h.route.request(query)).json()).data.mode, 'publish')
  assert.equal((await (await h.route.request(`${query}&mode=stage`)).json()).data.mode, 'stage')
  const response = await post(h.route, '/jobs', { sourceIds: [71], targets: ['baijiahao-video'], requestId: 'default-draft-receipt' })
  assert.equal(response.status, 202)
  const { data } = await response.json()
  assert.equal(data.mode, 'publish')
  assert.equal(data.jobs[0].mode, 'publish')
  await h.service.runPending()
  const receipt = (await (await h.route.request('/jobs?requestId=default-draft-receipt')).json()).data
  assert.equal(receipt.requestId, 'default-draft-receipt')
  assert.equal(receipt.mode, 'publish')
  assert.equal(receipt.jobs[0].status, 'submitted')
  assert.equal(receipt.jobs[0].result.saved, false)
  assert.equal(receipt.jobs[0].result.submitted, true)
  assert.equal(receipt.jobs[0].result.published, false)
  assert.equal(h.calls.run, 1)
  assert.equal(h.calls.save, 1)
})

test('completed publication jobs without valid submission receipts remain uncertain in HTTP responses', async t => {
  const h = await fixture(t)
  await post(h.route, '/jobs', { sourceIds: [71], targets: ['baijiahao-video'], requestId: 'invalid-legacy-receipt' })
  await h.service.runPending()
  const original = h.service.listJobs()[0]!
  let result: unknown = original.result
  t.mock.method(h.service, 'listJobs', () => [{ ...original, result }])
  for (result of [null, { ...original.result, articleId: 'invalid' }, { ...original.result, saved: true }]) {
    const response = await h.route.request('/jobs')
    const job = (await response.json()).data.jobs[0]
    assert.equal(job.status, 'uncertain')
    assert.match(job.message, /提交回执/)
    assert.equal(job.id, original.id)
  }
  assert.equal(h.calls.run, 1)
  assert.equal(h.calls.save, 1)
})

test('canceled publication attempts stay recoverable while unattempted cancellations remain canceled', async t => {
  const h = await fixture(t)
  await post(h.route, '/jobs', { sourceIds: [71], targets: ['baijiahao-video'], requestId: 'canceled-original-attempt' })
  const original = h.service.listJobs()[0]!
  let attempted = true
  t.mock.method(h.service, 'listJobs', () => [{ ...original, status: 'canceled', publicationAttempted: attempted }])
  const unresolved = (await (await h.route.request('/jobs')).json()).data.jobs[0]
  assert.equal(unresolved.status, 'uncertain')
  assert.equal(unresolved.id, original.id)
  assert.match(unresolved.message, /原发表结果/)
  attempted = false
  const canceled = (await (await h.route.request('/jobs')).json()).data.jobs[0]
  assert.equal(canceled.status, 'cancelled')
  assert.equal(h.calls.run, 0)
})

test('enqueue and lost-reply receipt keep requestId, job IDs and saved/cancelled HTTP states stable', async t => {
  const h = await fixture(t)
  const input = { sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft', requestId: 'receipt-71' }
  const response = await post(h.route, '/jobs', input)
  assert.equal(response.status, 202)
  const first = (await response.json()).data
  assert.equal(first.requestId, 'receipt-71')
  assert.equal(first.jobs[0].scriptId, 71)
  assert.equal(first.jobs[0].title, '历史项目')
  const recovered = (await (await h.route.request('/jobs?requestId=receipt-71')).json()).data
  assert.equal(recovered.requestId, 'receipt-71')
  assert.equal(recovered.jobs[0].id, first.jobs[0].id)
  const repeated = (await (await post(h.route, '/jobs', input)).json()).data
  assert.equal(repeated.jobs[0].id, first.jobs[0].id)
  assert.equal((await post(h.route, '/jobs', { ...input, mode: 'stage' })).status, 409)
  assert.equal((await h.route.request('/jobs?requestId=not-found')).status, 404)
  await h.service.runPending()
  const jobs = (await (await h.route.request('/jobs?sourceId=71')).json()).data.jobs
  assert.equal(jobs[0].status, 'saved')
  assert.ok(jobs[0].result.targetId)
  assert.equal((await (await h.route.request('/jobs?scriptId=71')).json()).data.jobs[0].status, 'saved')
  const queued = (await (await post(h.route, '/', { mode: 'draft', sourceIds: [71], targets: ['tencent-video'] })).json()).data.jobs[0]
  const cancelled = (await (await post(h.route, `/jobs/${queued.id}/cancel`, {})).json()).data
  assert.equal(cancelled.job.status, 'cancelled')
  assert.equal((await post(h.route, `/jobs/${first.jobs[0].id}/cancel`, {})).status, 409)
  assert.equal(h.calls.run, 1)
})

test('confirm saves only the existing job and open focuses its result rather than an editor URL', async t => {
  const h = await fixture(t)
  const enqueued = (await (await post(h.route, '/jobs', { sourceIds: [71], targets: ['baijiahao-video'], mode: 'stage' })).json()).data
  const id = enqueued.jobs[0].id
  assert.equal((await post(h.route, `/jobs/${id}/open`, {})).status, 409)
  await h.service.runPending()
  const detail = (await (await h.route.request(`/jobs/${id}`)).json()).data.job
  assert.equal(detail.status, 'awaiting_confirmation')
  assert.equal((await post(h.route, `/jobs/${id}/confirm`, { confirmSave: false })).status, 400)
  const opened = (await (await post(h.route, `/jobs/${id}/open`, {})).json()).data
  assert.equal(opened.opened, true)
  assert.equal(opened.job.result.targetId, detail.result.targetId)
  const confirmed = (await (await post(h.route, `/jobs/${id}/confirm`, { confirmSave: true })).json()).data
  assert.equal(confirmed.job.status, 'saved')
  assert.equal(confirmed.job.result.targetId, detail.result.targetId)
  assert.equal((await post(h.route, `/${id}/confirm`, {})).status, 200)
  assert.equal(h.calls.save, 1)
  assert.equal(h.calls.open, 1)
  assert.equal(h.calls.run, 1)
})

test('strict HTTP inputs reject episode IDs, empty targets, invalid IDs, unexpected modes and duplicate queries', async t => {
  const h = await fixture(t)
  const invalid = [
    { episodeIds: [71], targets: ['baijiahao-video'] },
    { scriptIds: [71], targets: ['baijiahao-video'] },
    { sourceIds: [71], targets: [] }, { sourceIds: [], targets: ['baijiahao-video'] },
    { sourceIds: [71], targets: ['unknown'] }, { sourceIds: [71], targets: ['tencent-video'], mode: 'publish' },
    { sourceIds: [71], targets: ['baijiahao-article'] }, { sourceIds: [71], targets: ['baijiahao-video'], mode: 'other' },
    { sourceIds: [-1], targets: ['baijiahao-video'] }, { sourceIds: ['71'], targets: ['baijiahao-video'] },
    { sourceIds: [Number.MAX_SAFE_INTEGER + 1], targets: ['baijiahao-video'] },
    { sourceIds: Array.from({ length: 101 }, (_, index) => index + 1), targets: ['baijiahao-video'] },
  ]
  for (const input of invalid) assert.equal((await post(h.route, '/jobs', input)).status, 400)
  for (const query of [
    'sourceIds=71&targets=tencent-video&mode=publish', 'sourceIds=71,&targets=baijiahao-video',
    'sourceIds=71&targets=', 'sourceIds=71&targets=all', 'sourceIds=1e2&targets=baijiahao-video',
    'sourceIds=71&sourceIds=72&targets=baijiahao-video', 'sourceIds=71&targets=baijiahao-video&refreshRuntime=1',
  ]) assert.equal((await h.route.request(`/preflight?${query}`)).status, 400)
  for (const query of ['sourceId=0', 'sourceId=1&scriptId=2', 'requestId=a&sourceId=71', 'limit=101', 'limit=-1', 'unexpected=true']) {
    assert.equal((await h.route.request(`/jobs?${query}`)).status, 400)
  }
  const nonJson = await h.route.request('/jobs', { method: 'POST', body: '{}' })
  assert.equal(nonJson.status, 400)
  assert.equal((await h.route.request('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  assert.equal(h.calls.inspect, 0)
  assert.equal(h.calls.run, 0)
})

test('upload, recovery and login reject cross-site writes before touching runtime', async t => {
  const h = await fixture(t)
  for (const Origin of ['https://evil.example', 'null', 'http://localhost:9999', 'http://user@localhost:3013', 'http://localhost:3013/not-an-origin']) {
    assert.equal((await post(h.route, '/jobs', { mode: 'draft', sourceIds: [71], targets: ['baijiahao-video'] }, { Origin })).status, 403)
  }
  for (const url of ['/jobs', '/jobs/1/confirm', '/jobs/1/resume', '/jobs/1/reconcile', '/jobs/1/open', '/jobs/1/cancel', '/runtime/login']) {
    assert.equal((await post(h.route, url, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  }
  assert.equal((await post(h.route, '/jobs', {}, { 'Sec-Fetch-Site': 'same-site' })).status, 403)
  assert.equal(h.calls.inspect, 0)
  assert.equal(h.calls.run, 0)
  assert.equal(h.calls.login, 0)
  assert.equal((await post(h.route, '/runtime/login', { platform: 'baijiahao' }, { Origin: 'http://localhost:3013' })).status, 200)
  assert.equal((await post(h.route, '/runtime/login', { platform: 'unknown' })).status, 400)
  assert.equal(h.calls.login, 1)
})

test('login recovery failure exposes the actionable browser reason without enqueueing', async t => {
  const h = await fixture(t)
  h.runtime.openSocialUploadLogin = async () => { throw new Error('专用浏览器仍有打开的页面，请关闭异常窗口后重试') }
  const response = await post(h.route, '/runtime/login', { platform: 'tencent' })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).message, '专用浏览器仍有打开的页面，请关闭异常窗口后重试')
  assert.equal(h.calls.run, 0)
  assert.equal(h.service.listJobs().length, 0)
})

test('single and batch retry accept existing jobs without blocking on browsers and expose current receipts', async t => {
  const h = await fixture(t)
  delete h.source.delivery!.covers['4:3']
  const receipt = (await (await post(h.route, '/jobs', { mode: 'draft', sourceIds: [71], targets: ['tencent-video', 'baijiahao-video'], requestId: 'retry-receipt' })).json()).data
  const [blocked, healthy] = receipt.jobs
  const inspections = h.calls.inspect
  const response = await post(h.route, '/jobs/retry', { jobIds: [blocked.id, healthy.id, '999'] })
  assert.equal(response.status, 202)
  const data = (await response.json()).data
  assert.equal(data.jobs[0].id, blocked.id)
  assert.equal(data.jobs[0].status, 'queued')
  assert.equal(data.jobs[0].scriptId, 71)
  assert.deepEqual(data.skipped.map((item: { id: string }) => item.id), [healthy.id, '999'])
  assert.equal(h.calls.inspect, inspections)
  assert.equal(h.calls.run, 0)
  const repeated = await post(h.route, `/jobs/${blocked.id}/retry`, {})
  assert.equal(repeated.status, 202)
  assert.equal((await repeated.json()).data.job.id, blocked.id)
  const current = (await (await h.route.request('/jobs?requestId=retry-receipt')).json()).data
  assert.equal(current.jobs[0].status, 'queued')
  await h.service.runPending()
  assert.equal(h.service.getJob(blocked.id).status, 'failed')
  assert.equal(h.service.getJob(healthy.id).status, 'completed')
  const saved = (await (await post(h.route, `/jobs/${healthy.id}/retry`, {})).json()).data.job
  assert.equal(saved.status, 'saved')
  assert.equal(h.calls.run, 1)
})

test('retry validates identifiers, request size, origin and bodies before any side effect', async t => {
  const h = await fixture(t)
  for (const body of [{ jobIds: [] }, { jobIds: ['0'] }, { jobIds: ['x'] }, { jobIds: [1], publish: true }, { jobIds: Array(101).fill(1) }]) {
    assert.equal((await post(h.route, '/jobs/retry', body)).status, 400)
  }
  assert.equal((await post(h.route, '/jobs/retry', { jobIds: ['1'] }, { Origin: 'https://example.com' })).status, 403)
  assert.equal((await post(h.route, '/jobs/1/retry', { force: true })).status, 400)
  assert.equal((await post(h.route, '/jobs/unknown/retry', {})).status, 400)
  assert.equal((await post(h.route, '/jobs/999/retry', {})).status, 404)
  assert.deepEqual(h.service.listJobs(), [])
  assert.equal(h.calls.inspect, 0)
  assert.equal(h.calls.run, 0)
})

test('background login synchronization validates the platform and origin without starting uploads', async t => {
  const h = await fixture(t)
  const synced: string[] = []
  h.runtime.syncHistorySocialUploadLogin = async platform => { synced.push(platform); return { synced: true, platform, message: '后台登录已同步' } }
  const response = await post(h.route, '/runtime/sync', { platform: 'tencent' })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, { synced: true, platform: 'tencent', message: '后台登录已同步' })
  assert.equal((await post(h.route, '/runtime/sync', { platform: 'unknown' })).status, 400)
  assert.equal((await post(h.route, '/runtime/sync', { platform: 'baijiahao' }, { Origin: 'https://example.com' })).status, 403)
  assert.deepEqual(synced, ['tencent'])
  assert.equal(h.calls.run, 0)
  assert.equal(h.calls.login, 0)
  assert.deepEqual(h.service.listJobs(), [])
})

test('login sync rejects replacing a session while an upload writer is running', async t => {
  const h = await fixture(t)
  let entered = false, finish!: () => void
  const upload = h.runtime.runSocialUpload
  h.runtime.runSocialUpload = async (payload, options) => {
    entered = true
    await new Promise<void>(resolve => { finish = resolve })
    return upload(payload, options)
  }
  h.runtime.syncHistorySocialUploadLogin = async () => { throw new Error('must not synchronize a running writer') }
  await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'] })
  const running = h.service.runPending()
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  try {
    const response = await post(h.route, '/runtime/sync', { platform: 'baijiahao' })
    assert.equal(response.status, 409)
    assert.match((await response.json()).message, /上传正在执行/)
  } finally { finish(); await running }
  assert.equal(h.calls.run, 1)
})

test('legacy manual uploaded markers remain stored without qualifying current publication candidates', async t => {
  const h = await fixture(t)
  const input = { sourceIds: [71], targets: ['baijiahao-video'] }
  assert.equal((await post(h.route, '/mark-uploaded', input, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await post(h.route, '/mark-uploaded', { ...input, targets: ['other'] })).status, 400)
  assert.equal((await post(h.route, '/mark-uploaded', { ...input, sourceIds: [72] })).status, 404)
  const response = await post(h.route, '/mark-uploaded', input)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.marked, 1)
  const candidates = (await (await h.route.request('/candidates')).json()).data.items
  assert.equal(candidates[0].uploads['baijiahao-video'], undefined)
  assert.equal(candidates[0].versions[0].state, 'stale')
  assert.equal(candidates[0].uploads['tencent-video'], undefined)
  const submitted = (await (await post(h.route, '/jobs', {...input,mode:'draft'})).json()).data
  assert.deepEqual(submitted.jobs, [])
  assert.equal(submitted.items[0].uploaded.status, 'saved')
  assert.equal(h.calls.run, 0)
  assert.equal(h.calls.save, 0)
})

test('fresh reupload routes reset dispatched failures before uploading current materials under the original ID', async t => {
  for (const endpoint of ['single', 'batch', 'short-alias', 'legacy-retry'] as const) await t.test(endpoint, async t => {
    const h = await fixture(t)
    const upload = h.runtime.runSocialUpload
    let first = true, resets = 0, oldTitle = ''
    h.runtime.runSocialUpload = async (payload, options) => {
      if (first) { first = false; h.calls.run++; oldTitle = payload.title; throw new Error('cover failed') }
      assert.equal(payload.title, '重新填写的蔬菜标题')
      return upload(payload, options)
    }
    h.runtime.closeFailedSocialUpload = async () => ({})
    h.runtime.resetSocialUploadAttempt = async payload => {
      resets++
      assert.equal(payload.title, oldTitle)
      return {}
    }
    const receipt = (await (await post(h.route, '/jobs', { mode: 'draft', sourceIds: [71], targets: ['tencent-video'], requestId: 'fresh-upload' })).json()).data
    const id = receipt.jobs[0].id
    await h.service.runPending()
    assert.equal(h.service.getJob(id).status, 'failed')
    h.source.delivery!.title = '重新填写的蔬菜标题'
    const url = endpoint === 'batch' ? '/jobs/reupload' : endpoint === 'short-alias' ? `/${id}/reupload`
      : endpoint === 'legacy-retry' ? `/jobs/${id}/retry` : `/jobs/${id}/reupload`
    const body = endpoint === 'batch' ? { jobIds: [id, id] } : {}
    const response = await post(h.route, url, body)
    assert.equal(response.status, 202)
    const data = (await response.json()).data
    const queued = data.job ?? data.jobs[0]
    assert.equal(queued.id, id)
    assert.equal(queued.status, 'queued')
    assert.equal(resets, 0, 'HTTP accepts immediately; reset runs in the serial worker')
    await h.service.runPending()
    const saved = (await (await h.route.request('/jobs?requestId=fresh-upload')).json()).data.jobs[0]
    assert.equal(saved.id, id)
    assert.equal(saved.status, 'saved')
    assert.equal(resets, 1)
    assert.equal(h.calls.run, 2)
    await post(h.route, url, body)
    await h.service.runPending()
    assert.equal(h.calls.run, 2, 'saved drafts are not reuploaded')
  })
})

test('reupload aliases validate identifiers, bodies and origin before changing queue state', async t => {
  const h = await fixture(t)
  for (const url of ['/jobs/1/reupload', '/1/reupload', '/jobs/reupload']) {
    assert.equal((await post(h.route, url, { force: true })).status, 400)
    assert.equal((await post(h.route, url, {}, { Origin: 'https://example.com' })).status, 403)
  }
  assert.equal((await post(h.route, '/jobs/reupload', { jobIds: [] })).status, 400)
  assert.equal((await post(h.route, '/jobs/reupload', { jobIds: ['0'] })).status, 400)
  assert.equal((await post(h.route, '/jobs/unknown/reupload', {})).status, 400)
  assert.equal((await post(h.route, '/jobs/999/reupload', {})).status, 404)
  assert.deepEqual(h.service.listJobs(), [])
  assert.equal(h.calls.run, 0)
})

test('legacy resume and reconcile endpoints reject further writes and point to fresh reupload', async t => {
  const h = await fixture(t)
  h.runtime.runSocialUpload = async () => { h.calls.run++; throw new Error('save failed') }
  const receipt = (await (await post(h.route, '/jobs', { mode: 'draft', sourceIds: [71], targets: ['tencent-video'] })).json()).data
  const id = receipt.jobs[0].id
  await h.service.runPending()
  for (const prefix of [`/jobs/${id}`, `/${id}`]) for (const action of ['resume', 'reconcile']) {
    const response = await post(h.route, `${prefix}/${action}`, {})
    assert.equal(response.status, 409)
    assert.match((await response.json()).message, /从头上传/)
  }
  assert.equal(h.service.getJob(id).status, 'failed')
  assert.equal(h.calls.run, 1)
  assert.equal(h.calls.save, 0)
})
