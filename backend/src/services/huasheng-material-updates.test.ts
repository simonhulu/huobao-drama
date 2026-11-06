import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'

const directory = mkdtempSync(join(tmpdir(), 'huasheng-material-updates-'))
process.env.DB_PATH = join(directory, 'test.db')
const { db, schema } = await import('../db/index.js')
const { createHuashengMaterialsRoute } = await import('../routes/huasheng-materials.js')
const {
  HUASHENG_MATERIAL_UPDATE_TASK, createHuashengMaterialUpdateHandler,
  getHuashengMaterialOverview, startHuashengMaterialUpdate, stopHuashengMaterialUpdate,
  safeMaterialUpdateMessage,
} = await import('./huasheng-material-updates.js')
const { clearTaskHandlers, registerTaskHandler } = await import('./tasks/registry.js')
const { recordWorkerHeartbeat } = await import('./tasks/heartbeat.js')
const { runWorkerOnce } = await import('./tasks/worker.js')
const { claimQueuedTask, createTask, getTask, updateTaskProgress } = await import('./tasks/store.js')
const { recoverExpiredRunningTasks } = await import('./tasks/recovery.js')

beforeEach(() => {
  db.delete(schema.creationTaskEvents).run()
  db.delete(schema.creationTasks).run()
  db.delete(schema.workerHeartbeats).run()
  recordWorkerHeartbeat('worker-general-test')
  clearTaskHandlers()
})
after(() => { db.$client.close(); rmSync(directory, { recursive: true, force: true }) })

function project(overrides = {}) {
  return { status: 'done', totalClips: 4, downloaded: 12, reused: 9,
    failedClips: 0, failedDownloads: 0, unavailableClips: 0, metadataWarnings: 0, ...overrides }
}
type HandlerOptions = NonNullable<Parameters<typeof createHuashengMaterialUpdateHandler>[0]>
type Collector = Awaited<ReturnType<NonNullable<HandlerOptions['loadCollector']>>>
type Collect = Collector['collectAll']
function register(collectAll: Collect) {
  const seen: { options?: Parameters<Collect>[0]; session?: unknown; signal?: AbortSignal } = {}
  const handler = createHuashengMaterialUpdateHandler({
    outputRoot: join(directory, 'videos'),
    loadCollector: async () => ({
      readSession: async () => ({ cookie: 'SESSDATA=secret' }),
      createClient({ session, signal }) { seen.session = session; seen.signal = signal; return {} },
      async collectAll(options, deps) { seen.options = options; return collectAll(options, deps) },
    }),
  })
  registerTaskHandler(HUASHENG_MATERIAL_UPDATE_TASK, handler)
  return seen
}
function worker() {
  return runWorkerOnce({ workerId: 'worker-general-test', types: [HUASHENG_MATERIAL_UPDATE_TASK], cancelPollMs: 10 })
}
function post(route: ReturnType<typeof createHuashengMaterialsRoute>, path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return route.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

test('one global update is persisted, duplicate starts reuse it, and reload reads the same task', async () => {
  const route = createHuashengMaterialsRoute()
  const initial = await route.request('/')
  assert.equal(initial.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual((await initial.json()).data, { stats: { projects: 0, clips: 0, files: 0, downloadedAssets: 0 }, task: null })
  const first = await post(route, '/updates')
  assert.equal(first.status, 202)
  const started = (await first.json()).data
  assert.equal(started.created, true)
  assert.equal(started.task.status, 'queued')
  const duplicate = (await (await post(route, '/updates')).json()).data
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.task.id, started.task.id)
  const restored = (await (await createHuashengMaterialsRoute().request('/')).json()).data
  assert.equal(restored.task.id, started.task.id)
  assert.equal(db.select().from(schema.creationTasks).all().length, 1)
  for (const key of ['payload', 'leaseOwner', 'leaseToken', 'idempotencyKey']) assert.equal(key in restored.task, false)
})

test('global commands reject project/path options, invalid IDs and external origins without writes', async () => {
  const route = createHuashengMaterialsRoute()
  for (const body of [null, [], { projectId: '123' }, { output: '/tmp' }, { metadataOnly: true }]) {
    assert.equal((await post(route, '/updates', body)).status, 400)
  }
  assert.throws(() => startHuashengMaterialUpdate({ project: '123' }), /仅接受空/)
  assert.equal((await post(route, '/updates?project=123')).status, 400)
  assert.equal((await post(route, '/updates', {}, { Origin: 'https://example.com' })).status, 403)
  assert.equal((await post(route, '/updates', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await route.request('/updates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  assert.equal((await route.request('/updates', { method: 'POST' })).status, 400)
  for (const id of ['0', '-1', '1.1', '9007199254740992']) assert.equal((await post(route, `/updates/${id}/stop`)).status, 400)
  assert.equal((await post(route, '/updates/99999/stop')).status, 404)
  assert.equal(db.select().from(schema.creationTasks).all().length, 0)
})

test('missing eligible worker fails promptly and an unserved old queue becomes retryable', async () => {
  const queued = startHuashengMaterialUpdate({}).task!
  db.delete(schema.workerHeartbeats).run()
  recordWorkerHeartbeat('worker-image-test')
  assert.equal(startHuashengMaterialUpdate({}).task!.id, queued.id, 'an active task still deduplicates')
  db.update(schema.creationTasks).set({ createdAt: '2020-01-01T00:00:00.000Z' }).where(eq(schema.creationTasks.id, queued.id)).run()
  assert.equal(getHuashengMaterialOverview().task!.status, 'failed')
  const response = await post(createHuashengMaterialsRoute(), '/updates')
  assert.equal(response.status, 503)
  assert.match((await response.json()).message, /执行器未运行/)
  assert.equal(db.select().from(schema.creationTasks).all().length, 1)
  recordWorkerHeartbeat('worker-general-test')
  assert.equal(startHuashengMaterialUpdate({}).created, true)
})

test('all-project handler persists progress and completes despite unavailable candidates and metadata warnings', async () => {
  const seen = register(async (_options, deps) => {
    deps.onProgress({ stage: 'project_list', completedProjects: 0, totalProjects: 2 })
    deps.onProgress({ stage: 'clip_start', completedProjects: 0, totalProjects: 2, title: 'test', clipIndex: 1, totalClips: 4 })
    assert.equal(getHuashengMaterialOverview().task!.progressTotal, 2)
    deps.onProgress({ stage: 'project_complete', completedProjects: 1, totalProjects: 2 })
    return { projects: [project({ status: 'incomplete', unavailableClips: 1, metadataWarnings: 2, metadataReadClips: 1, metadataSkippedClips: 3, repairedDownloads: 2 }), project({ status: 'empty', totalClips: 0, downloaded: 0, reused: 0 })] }
  })
  const started = startHuashengMaterialUpdate({}).task!
  await worker()
  const task = getHuashengMaterialOverview().task!
  assert.equal(task.status, 'succeeded')
  assert.ok(task.startedAt && task.completedAt)
  assert.equal(task.progressCurrent, 2)
  assert.deepEqual(task.result, { projects: 2, clips: 4, downloaded: 3, reused: 9,
    unavailableClips: 1, metadataWarnings: 2, failedProjects: 0, failedClips: 0, failedDownloads: 0,
    metadataReadClips: 1, metadataSkippedClips: 3, repairedDownloads: 2 })
  assert.deepEqual(getTask(started.id)!.payload, {})
  assert.equal(seen.options?.allProjects, true)
  assert.equal(seen.options?.database, db.$client.name)
  assert.equal(seen.options?.projectConcurrency, 8)
  assert.equal(seen.options?.metadataOnly, false)
  assert.equal('pid' in seen.options!, false)
  assert.equal(JSON.stringify(task).includes('secret'), false)
})

test('partial transfer/request failure is failed with durable safe summary and permits a later global update', async () => {
  register(async () => ({ projects: [project({ failedClips: 1, failedDownloads: 2 }), project({ status: 'failed', error: 'failed https://example.com/signed?secret=value', totalClips: 0, downloaded: 0, reused: 0 })] }))
  startHuashengMaterialUpdate({})
  await worker()
  const task = getHuashengMaterialOverview().task!
  assert.equal(task.status, 'failed')
  assert.equal(task.result!.failedProjects, 2)
  assert.equal(task.result!.failedClips, 1)
  assert.match(task.errorMessage!, /2 个项目/)
  assert.equal(JSON.stringify(task).includes('secret=value'), false)
  assert.equal(startHuashengMaterialUpdate({}).created, true)
})

test('login/collector failure is sanitized and never reported as success', async () => {
  register(async () => { throw new Error('花生接口错误 -101 https://example.com/signed?secret=value\nCookie: SESSDATA=secret') })
  startHuashengMaterialUpdate({})
  await worker()
  const task = getHuashengMaterialOverview().task!
  assert.equal(task.status, 'failed')
  assert.match(task.errorMessage!, /重新登录/)
  assert.equal(task.errorMessage!.includes('secret'), false)
  assert.equal(task.result, null)
  assert.equal(safeMaterialUpdateMessage('Bearer abc /Users/private/file'), '[登录凭据已省略] [本地路径省略]')
})

test('queued stop finishes immediately and cannot cancel another task type', async () => {
  const task = startHuashengMaterialUpdate({}).task!
  const stopped = stopHuashengMaterialUpdate(task.id).task!
  assert.equal(stopped.status, 'canceled')
  assert.ok(stopped.completedAt)
  assert.equal(stopHuashengMaterialUpdate(task.id).task!.status, 'canceled')
  const unrelated = createTask({ type: 'other.test' })
  assert.throws(() => stopHuashengMaterialUpdate(unrelated.id), /不存在/)
  assert.equal(getTask(unrelated.id)!.cancelRequested, false)
  assert.equal(startHuashengMaterialUpdate({}).created, true)
})

test('running stop signals collector and keeps task stopping until cleanup has finished', async () => {
  let entered!: () => void
  const running = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve })
  register(async (_options, deps) => {
    entered()
    await new Promise<void>(resolve => deps.signal.addEventListener('abort', () => resolve(), { once: true }))
    await cleanup
    deps.signal.throwIfAborted()
    return { projects: [] }
  })
  const task = startHuashengMaterialUpdate({}).task!
  const execution = worker()
  await running
  const stopping = stopHuashengMaterialUpdate(task.id).task!
  assert.equal(stopping.status, 'running')
  assert.equal(stopping.cancelRequested, true)
  await delay(30)
  assert.equal(getTask(task.id)!.status, 'running')
  release()
  await execution
  const stopped = getHuashengMaterialOverview().task!
  assert.equal(stopped.status, 'canceled')
  assert.match(stopped.progressMessage!, /已保存/)
  assert.ok(stopped.completedAt)
  assert.equal(startHuashengMaterialUpdate({}).created, true)
})

test('expired service execution restores an interrupted state and does not automatically rerun', () => {
  register(async () => ({ projects: [] }))
  const task = startHuashengMaterialUpdate({}).task!
  claimQueuedTask(task.id, { workerId: 'worker-general-test', leaseMs: 1000, nowMs: Date.now() - 5000 })
  const overview = getHuashengMaterialOverview()
  assert.equal(overview.task!.id, task.id)
  assert.equal(overview.task!.status, 'stale')
  assert.match(overview.task!.progressMessage!, /中断/)
  assert.equal(recoverExpiredRunningTasks().requeued, 0)
  assert.equal(startHuashengMaterialUpdate({}).created, true)
})

test('overview excludes raw task results and sensitive progress messages', () => {
  const task = startHuashengMaterialUpdate({}).task!
  updateTaskProgress(task.id, { progressMessage: 'https://example.com?secret=value Cookie: SESSDATA=secret' })
  assert.equal(JSON.stringify(getHuashengMaterialOverview()).includes('secret'), false)
})

test('an exited owner is interrupted before its long lease expires while a live owner is retained', async () => {
  const { spawn } = await import('node:child_process')
  const task = startHuashengMaterialUpdate({}).task!
  claimQueuedTask(task.id, { workerId: 'worker-general-test', leaseMs: 600_000 })
  assert.equal(getHuashengMaterialOverview().task!.status, 'running')
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { exited.once('exit', () => resolve()); exited.once('error', reject) })
  db.update(schema.creationTasks).set({ leaseOwner: `worker-general-${exited.pid}-1` }).where(eq(schema.creationTasks.id, task.id)).run()
  db.delete(schema.workerHeartbeats).run()
  const restored = getHuashengMaterialOverview().task!
  assert.equal(restored.status, 'stale')
  assert.match(restored.errorMessage!, /服务中断/)
})
