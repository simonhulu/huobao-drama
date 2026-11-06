import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { HistoryHuashengExportService, type HistoryHuashengExportOptions, type HuashengExportApi, type HuashengExportAutomation, type HuashengExportDelivery } from './history-huasheng-export.js'
import { recordHistoryDualProduction, listHistoryVideoDeliveries } from './history-video-deliveries.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const completed = (): HuashengExportAutomation => ({ design: { status: 'completed', message: '方案完成' }, covers: { status: 'completed', message: '三种尺寸图片完成' }, article: { status: 'completed', message: '文章完成' } })
function fixture(t: TestContext) {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE history_huasheng_jobs (id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,project_url TEXT,production_status TEXT,status TEXT)`)
  const sources = new Map<number, string>()
  const deliveries = new Map<number, HuashengExportDelivery>()
  const calls = { create: [] as string[], inspect: [] as string[], download: [] as string[], attach: [] as number[], ensure: [] as Array<{ id: number; retry: boolean }>, monitor: 0, check: [] as number[] }
  let now = 100_000
  const api: HuashengExportApi = {
    createHuashengExport: async input => { calls.create.push(input.projectUrl); await input.onDispatched?.(); return { taskId: `task-${input.projectUrl.split('/').at(-1)}`, projectHash: 'project-version' } },
    inspectHuashengExport: async input => { calls.inspect.push(input.taskId); return { progress: 100, url: 'https://cdn.example/video.mp4?secret=private', filename: '成片.mp4' } },
    downloadHuashengExport: async input => { calls.download.push(input.url); input.onProgress?.({ bytes: 40, totalBytes: 100 }); return { filePath: '/isolated-fixture/video.mp4', filename: '成片.mp4', bytes: 100 } },
  }
  const options: HistoryHuashengExportOptions = {
    database: db, api, now: () => now, stepDelayMs: 1, maxRetries: 2,
    loadSource: id => { const script = sources.get(id); if (!script) throw new Error('source missing'); return { script } },
    loadDelivery: id => { const delivery = deliveries.get(id); return delivery ? { ...delivery, videoId: id } : { videoUrl: null, scriptSha256: null, available: false } },
    attachVideo: async (id, _file, _name, input) => {
      calls.attach.push(id); assert.equal(input.onlyIfMissing, true); assert.equal(input.expectedScriptSha256, hash(sources.get(id)!))
      deliveries.set(id, { videoUrl: `/static/history-deliveries/${id}/kept.mp4`, scriptSha256: input.expectedScriptSha256, available: true })
    },
    ensureAutomation: async (id, input) => { calls.ensure.push({ id, retry: !!input.retryFailed }); return completed() },
    hasCoverFiles: () => true,
    enableMonitoring: () => { calls.monitor++ }, checkProduction: id => { calls.check.push(id) },
    isProcessAlive: pid => pid === process.pid,
  }
  const services: HistoryHuashengExportService[] = []
  const open = (overrides: Partial<HistoryHuashengExportOptions> = {}) => {
    const service = new HistoryHuashengExportService({ ...options, ...overrides }); services.push(service); return service
  }
  const service = open()
  const add = (id: number, production = 'completed') => {
    sources.set(id, `当前稿件 ${id}`)
    db.prepare('INSERT INTO history_huasheng_jobs VALUES(?,?,?,?,?,?)').run(id, id, hash(sources.get(id)!), `https://www.huasheng.cn/video/${id}`, production, 'submitted')
  }
  const persist = (id: number, patch: Record<string, string | number | null> = {}) => {
    const linked = db.prepare('SELECT * FROM history_huasheng_jobs WHERE id=?').get(id) as { script_sha256: string; project_url: string }
    const inserted = db.prepare(`INSERT INTO history_huasheng_export_jobs
      (huasheng_job_id,source_id,script_sha256,project_url,status,stage,message,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,'queued','waiting_production','原任务等待导出',0,?,?)`)
      .run(id, id, linked.script_sha256, linked.project_url, new Date(now).toISOString(), new Date(now).toISOString())
    const jobId = Number(inserted.lastInsertRowid)
    if (Object.keys(patch).length) db.prepare(`UPDATE history_huasheng_export_jobs SET ${Object.keys(patch).map(key => `${key}=?`).join(',')} WHERE id=?`).run(...Object.values(patch), jobId)
    return service.getJob(jobId)
  }
  const tick = async (worker = service, ms = 60_001) => { now += ms; await worker.runPending() }
  const finish = async (worker = service) => { for (let i = 0; i < 6; i++) await tick(worker) }
  t.after(async () => { for (const worker of services) await worker.close(); db.close() })
  return { db, service, options, api, sources, deliveries, calls, add, persist, open, tick, finish }
}

async function eventually(check: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
}

function oldCompleted(f: ReturnType<typeof fixture>, id: number) {
  f.add(id)
  const videoUrl = `/static/history-deliveries/${id}/kept.mp4`
  f.deliveries.set(id, { videoUrl, scriptSha256: hash(f.sources.get(id)!), available: true })
  return f.persist(id, { status: 'completed', stage: 'completed', design_status: 'completed', article_status: 'completed', video_url: videoUrl,
    task_id: `original-${id}`, project_hash: 'kept-version', dispatched: 1, file_path: `/kept/${id}.mp4`, download_url: 'https://fixture.example/kept.mp4', downloaded_bytes: 100, total_bytes: 100 })
}

test('legacy export account migration retains the original receipt and managed export uses its saved account', async t => {
  const f = fixture(t)
  f.add(1)
  const original = f.persist(1, { task_id: 'original-task', project_hash: 'original-hash', dispatched: 1 })
  f.db.exec('ALTER TABLE history_huasheng_export_jobs DROP COLUMN huasheng_account_name')
  const configs: string[] = []
  const config = { endpoint: 'http://127.0.0.1:9243', profile: '/original-history-profile', expectedUid: '1001' }
  const worker = f.open({ accountConfig: async name => { configs.push(name); return config }, api: { ...f.api,
    inspectHuashengExport: async input => {
      assert.deepEqual(input.browserConfig, config)
      assert.equal(input.taskId, 'original-task'); assert.equal(input.projectHash, 'original-hash')
      return { progress: 50, url: null, filename: null }
    },
  } })
  assert.equal(worker.getJob(original.id).huashengAccountName, 'history_huasheng_legacy')
  await f.tick(worker)
  assert.deepEqual(configs, ['history_huasheng_legacy'])
  assert.deepEqual(f.calls.create, [])
  assert.equal(worker.getJob(original.id).exportProgress, 50)
})

test('export blocks a changed task account before remote access and retains its original export identity', async t => {
  const f = fixture(t)
  f.add(1)
  const job = f.persist(1, { task_id: 'original-task', project_hash: 'original-hash', dispatched: 1 })
  f.db.exec("ALTER TABLE history_huasheng_jobs ADD COLUMN huasheng_account_name TEXT NOT NULL DEFAULT 'history_huasheng_legacy'; UPDATE history_huasheng_jobs SET huasheng_account_name='science_huasheng_wrong'")
  await f.tick()
  assert.equal(f.service.getJob(job.id).status, 'needs_attention')
  assert.match(f.service.getJob(job.id).error!, /账号已变化/)
  assert.deepEqual(f.calls.inspect, [])
  const saved = f.db.prepare('SELECT task_id,project_hash,dispatched FROM history_huasheng_export_jobs WHERE id=?').get(job.id)
  assert.deepEqual(saved, { task_id: 'original-task', project_hash: 'original-hash', dispatched: 1 })
})

test('cover-status migration is additive and idempotent without admitting work on construction', async t => {
  const f = fixture(t)
  const job = oldCompleted(f, 1)
  f.db.exec('ALTER TABLE history_huasheng_export_jobs DROP COLUMN cover_status')
  const reopened = f.open()
  assert.equal(reopened.getJob(job.id).coverStatus, null)
  assert.equal(reopened.getJob(job.id).status, 'completed')
  assert.equal(f.open().getJob(job.id).coverStatus, null)
  assert.deepEqual(f.calls.ensure, [])
  assert.deepEqual(f.calls.create, [])
  assert.equal((f.db.prepare('SELECT task_id FROM history_huasheng_export_jobs WHERE id=?').get(job.id) as any).task_id, 'original-1')
})

function legacyVideo(f: ReturnType<typeof fixture>, t: TestContext, id = 1) {
  const job = oldCompleted(f, id)
  const root = fs.mkdtempSync(path.join(tmpdir(), 'legacy-video-publication-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'history-deliveries', String(id))
  fs.mkdirSync(directory, { recursive: true })
  const filename = path.join(directory, 'kept.mp4')
  fs.writeFileSync(filename, 'original validated video')
  f.db.exec(`CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY,video_path TEXT,video_name TEXT,duration REAL,script_sha256 TEXT)`)
  f.db.prepare('INSERT INTO history_script_deliveries VALUES(?,?,?,?,?)')
    .run(id, `static/history-deliveries/${id}/kept.mp4`, '原成片.mp4', 71, hash(f.sources.get(id)!))
  return { job, root, filename }
}

test('explicit repair registers a completed legacy video and its own publication without copying or waiting for motion', async t => {
  const f = fixture(t)
  const { job, root, filename } = legacyVideo(f, t)
  recordHistoryDualProduction(f.db, 1, job.scriptSha256, 1)
  const worker = f.open({ root })
  await worker.repairCompletedCovers([1])
  const videos = listHistoryVideoDeliveries(f.db, 1, job.scriptSha256)
  assert.equal(videos.length, 1)
  assert.equal(videos[0]!.producer, 'huasheng')
  assert.equal(videos[0]!.producerJobId, '1')
  assert.equal(videos[0]!.videoUrl, job.videoUrl)
  assert.equal(videos[0]!.sha256, hash('original validated video'))
  assert.equal(videos[0]!.duration, 71)
  assert.equal(fs.readFileSync(filename, 'utf8'), 'original validated video')
  const intents = f.db.prepare('SELECT video_id,producer,status FROM history_video_publication_intents').all()
  assert.deepEqual(intents, [{ video_id: videos[0]!.id, producer: 'huasheng', status: 'pending' }])
  assert.equal((f.db.prepare('SELECT motion_state FROM history_dual_production').get() as any).motion_state, 'pending')
  await worker.repairCompletedCovers([1])
  assert.equal(listHistoryVideoDeliveries(f.db, 1).length, 1)
  assert.equal((f.db.prepare('SELECT COUNT(*) n FROM history_video_publication_intents').get() as {n:number}).n, 1)
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.download, [])
  assert.deepEqual(f.calls.attach, [])
})

test('a landed Huasheng video registers its own ID before creating version-specific packaging', async t => {
  const f = fixture(t)
  const { job, root } = legacyVideo(f, t)
  f.db.prepare("UPDATE history_huasheng_export_jobs SET status='processing',stage='processing' WHERE id=?").run(job.id)
  const ids: number[] = []
  const worker = f.open({ root, loadDelivery: undefined, ensureAutomation: async (sourceId, input) => {
    const own = listHistoryVideoDeliveries(f.db, sourceId).find(video => video.producer === 'huasheng')!
    assert.ok(own)
    assert.equal(input.videoId, own.id)
    ids.push(input.videoId)
    return completed()
  } })
  await f.tick(worker)
  assert.equal(ids.length, 1)
  assert.equal(worker.getJob(job.id).status, 'completed')
  await f.tick(worker)
  assert.equal(ids.length, 1, 'a completed export cannot regenerate its packaging')
})

test('automatic export pass reconciles completed admitted legacy outputs but does not publish unadmitted history', async t => {
  const f = fixture(t)
  const { job, root } = legacyVideo(f, t)
  const worker = f.open({ root })
  f.db.prepare("UPDATE history_huasheng_export_jobs SET cover_status='completed' WHERE id=?").run(job.id)
  await f.tick(worker)
  assert.equal(listHistoryVideoDeliveries(f.db, 1).length, 0)
  recordHistoryDualProduction(f.db, 1, job.scriptSha256, 1)
  await f.tick(worker)
  assert.equal(listHistoryVideoDeliveries(f.db, 1).length, 1)
  assert.equal((f.db.prepare('SELECT COUNT(*) n FROM history_video_publication_intents').get() as any).n, 1)
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.download, [])
})

test('legacy local repair preserves IDs and receipts, records existing files and excludes any confirmed upload', async t => {
  const f = fixture(t)
  for (const id of [1, 2, 3, 4, 5]) oldCompleted(f, id)
  f.db.exec(`CREATE TABLE history_social_upload_confirmations(source_id INTEGER,target TEXT,confirmed_at TEXT);
    CREATE TABLE history_social_upload_jobs(source_id INTEGER,status TEXT,result_json TEXT);
    INSERT INTO history_social_upload_confirmations VALUES(2,'baijiahao-video','today');
    INSERT INTO history_social_upload_jobs VALUES(3,'completed','{"saved":true}'),(4,'completed','{"saved":false}')`)
  const before = f.db.prepare('SELECT id,task_id,project_hash,download_url,file_path,dispatched,video_url,design_status,article_status FROM history_huasheng_export_jobs ORDER BY id').all()
  const inspected: number[] = []
  const worker = f.open({ hasCoverFiles: id => { inspected.push(id); return id === 5 } })
  assert.deepEqual(await worker.repairCompletedCovers(), { checked: 3, repaired: 2 })
  assert.deepEqual(inspected, [1, 4, 5])
  assert.equal(worker.getJob(1).status, 'processing')
  assert.equal(worker.getJob(1).coverStatus, 'queued')
  assert.equal(worker.getJob(2).coverStatus, null)
  assert.equal(worker.getJob(3).coverStatus, null)
  assert.equal(worker.getJob(5).coverStatus, 'completed')
  assert.equal(worker.getJob(5).status, 'completed')
  assert.deepEqual(f.db.prepare('SELECT id,task_id,project_hash,download_url,file_path,dispatched,video_url,design_status,article_status FROM history_huasheng_export_jobs ORDER BY id').all(), before)
  assert.deepEqual(await worker.repairCompletedCovers(), { checked: 0, repaired: 0 }, 'Persisted covers status makes the migration pass one-time per eligible row')
  assert.equal(f.calls.ensure.length, 0, 'Migration itself never generates or contacts a platform')
  assert.equal(f.calls.create.length, 0)
})

test('legacy repair is bounded to 100 local records per pass and does not require upload tables', async t => {
  const f = fixture(t)
  for (let id = 1; id <= 103; id++) oldCompleted(f, id)
  const inspected: number[] = []
  const worker = f.open({ hasCoverFiles: id => { inspected.push(id); return true } })
  assert.deepEqual(await worker.repairCompletedCovers(), { checked: 100, repaired: 0 })
  assert.equal(inspected.length, 100)
  assert.equal(worker.getJob(101).coverStatus, null)
  assert.deepEqual(await worker.repairCompletedCovers(), { checked: 3, repaired: 0 })
  assert.equal(f.calls.ensure.length, 0)
})

test('automatic repair rechecks uploaded confirmations before admitting a locally inspected row', async t => {
  const f = fixture(t)
  const job = oldCompleted(f, 1)
  f.db.exec('CREATE TABLE history_social_upload_confirmations(source_id INTEGER,target TEXT)')
  const worker = f.open({ hasCoverFiles: () => {
    f.db.prepare('INSERT INTO history_social_upload_confirmations VALUES(?,?)').run(1, 'tencent-video')
    return false
  } })
  assert.deepEqual(await worker.repairCompletedCovers(), { checked: 1, repaired: 0 })
  assert.equal(worker.getJob(job.id).status, 'completed')
  assert.equal(worker.getJob(job.id).coverStatus, null)
  assert.equal(f.calls.ensure.length, 0)
})

test('worker startup readmits only missing legacy covers while constructor and enabled settings stay read-only', async t => {
  const f = fixture(t)
  const job = oldCompleted(f, 1)
  const worker = f.open({ now: Date.now, stepDelayMs: 1, pollMs: 2, hasCoverFiles: () => false })
  assert.equal(worker.getJob(job.id).coverStatus, null)
  assert.equal(worker.enabled, false)
  worker.start()
  await eventually(() => worker.getJob(job.id).coverStatus === 'completed', 'Worker startup did not repair the legacy cover branch')
  await worker.stop()
  assert.equal(worker.getJob(job.id).status, 'completed')
  assert.equal(worker.getJob(job.id).id, job.id)
  assert.equal(f.calls.create.length, 0)
  assert.equal(f.calls.download.length, 0)
  assert.equal(f.calls.attach.length, 0)
})

test('repair rejects stale or unavailable original video without returning to export or download', async t => {
  for (const reason of ['missing video', 'script changed', 'video changed']) await t.test(reason, async t => {
    const f = fixture(t)
    const job = oldCompleted(f, 1)
    if (reason === 'missing video') f.deliveries.delete(1)
    if (reason === 'script changed') f.sources.set(1, 'new script')
    if (reason === 'video changed') f.deliveries.get(1)!.videoUrl = '/static/history-deliveries/1/other.mp4'
    const worker = f.open({ hasCoverFiles: () => false })
    await worker.repairCompletedCovers()
    assert.equal(worker.getJob(job.id).status, 'needs_attention')
    assert.equal(worker.getJob(job.id).coverStatus, 'needs_attention')
    worker.resume(job.id)
    await f.tick(worker)
    assert.equal(worker.getJob(job.id).status, 'needs_attention')
    assert.equal(f.calls.create.length, 0)
    assert.equal(f.calls.inspect.length, 0)
    assert.equal(f.calls.download.length, 0)
    assert.equal(f.calls.attach.length, 0)
    assert.equal(f.calls.ensure.length, 0)
  })
})

test('selected legacy repair reuses the job and changes only missing products with no remote export work', async t => {
  const f = fixture(t)
  const job = oldCompleted(f, 1)
  oldCompleted(f, 2)
  const worker = f.open({ hasCoverFiles: () => false, now: Date.now, pollMs: 2, stepDelayMs: 1 })
  const result = await worker.enqueue([1])
  assert.equal(result.jobs[0]!.id, job.id)
  await eventually(() => worker.getJob(job.id).status === 'completed', 'Explicit repair did not settle')
  assert.equal(worker.getJob(job.id).coverStatus, 'completed')
  assert.equal(worker.getJob(2).coverStatus, null)
  assert.equal(worker.listJobs().length, 2)
  assert.deepEqual(f.calls.ensure, [{ id: 1, retry: false }])
  assert.equal(f.calls.create.length, 0)
  assert.equal(f.calls.inspect.length, 0)
  assert.equal(f.calls.download.length, 0)
  assert.equal(f.calls.attach.length, 0)
  assert.equal((f.db.prepare('SELECT task_id FROM history_huasheng_export_jobs WHERE id=?').get(job.id) as any).task_id, 'original-1')
})

test('explicit resume supports completed legacy missing-cover jobs and preserves successful branches', async t => {
  const f = fixture(t)
  const job = oldCompleted(f, 1)
  f.service.resume(job.id)
  await f.tick()
  assert.equal(f.service.getJob(job.id).coverStatus, 'completed')
  assert.equal(f.service.getJob(job.id).status, 'completed')
  assert.deepEqual(f.calls.ensure, [{ id: 1, retry: true }])
  assert.equal(f.calls.create.length, 0)
  assert.equal(f.calls.download.length, 0)
})

test('cover generation keeps repaired projects processing and holds the global two-project gate across workers', async t => {
  const f = fixture(t)
  for (let id = 1; id <= 4; id++) oldCompleted(f, id)
  const started = new Set<number>(), finished = new Set<number>()
  const ensure: HistoryHuashengExportOptions['ensureAutomation'] = async id => {
    started.add(id)
    return { ...completed(), covers: finished.has(id) ? completed().covers : { status: 'generating', message: '正在生成真实封面图片' } }
  }
  const first = f.open({ hasCoverFiles: () => false, ensureAutomation: ensure })
  const second = f.open({ hasCoverFiles: () => false, ensureAutomation: ensure })
  await first.repairCompletedCovers()
  await Promise.all([f.tick(first), f.tick(second)])
  assert.equal(started.size, 2)
  assert.equal(first.getJob(1).status, 'processing')
  assert.equal(first.getJob(1).designStatus, 'completed')
  assert.equal(first.getJob(1).articleStatus, null)
  assert.equal(first.getJob(1).coverStatus, 'generating')
  assert.match(first.getJob(1).message, /真实封面图片/)
  assert.equal(first.overview().production.activeProjects, 2)
  await first.stop()
  await f.tick(second)
  assert.equal(started.size, 2)
  finished.add(1)
  await f.tick(second)
  assert.equal(started.size, 3)
  assert.equal(second.getJob(1).status, 'completed')
  assert.equal(f.calls.create.length, 0)
})

test('failed cover branch settles honestly and retries once on the original task', async t => {
  const f = fixture(t)
  const job = oldCompleted(f, 1)
  let retried = false
  const worker = f.open({ hasCoverFiles: () => false, ensureAutomation: async (id, options) => {
    f.calls.ensure.push({ id, retry: !!options.retryFailed })
    if (options.retryFailed) retried = true
    return { ...completed(), covers: retried ? completed().covers : { status: 'failed', message: '封面图片生成失败' } }
  } })
  await worker.repairCompletedCovers()
  await f.tick(worker)
  assert.equal(worker.getJob(job.id).status, 'failed')
  assert.equal(worker.getJob(job.id).coverStatus, 'failed')
  assert.match(worker.getJob(job.id).error!, /封面图片生成失败/)
  worker.resume(job.id)
  await f.tick(worker)
  assert.equal(worker.getJob(job.id).status, 'completed')
  assert.equal(f.calls.ensure.filter(call => call.retry).length, 1)
})

test('project slots cover asynchronous production across workers, not just short polling steps', async t => {
  const f = fixture(t)
  for (let id = 1; id <= 5; id++) {
    f.add(id); f.persist(id)
    f.deliveries.set(id, { videoUrl: `/static/history-deliveries/${id}/kept.mp4`, scriptSha256: hash(f.sources.get(id)!), available: true })
  }
  const started = new Set<number>()
  const finished = new Set<number>()
  const ensure: HistoryHuashengExportOptions['ensureAutomation'] = async id => {
    started.add(id)
    return finished.has(id) ? completed() : { design: { status: 'generating', message: '真实方案仍在生成' }, covers: { status: 'queued', message: '图片待生成' }, article: { status: 'queued', message: '文章待生成' } }
  }
  const first = f.open({ ensureAutomation: ensure })
  const second = f.open({ ensureAutomation: ensure })
  await Promise.all([f.tick(first), f.tick(second)])
  assert.equal(started.size, 2, 'Returning from a processing tick must not free its project slot')
  await f.tick(second)
  assert.equal(started.size, 2, 'Another process must share the same production limit')
  assert.equal(first.getJob(3).stage, 'waiting_capacity')
  assert.match(first.getJob(3).message, /等待生产名额/)
  assert.deepEqual(first.overview().production, { limit: 2, activeProjects: 2, waitingProjects: 3 })
  await first.stop()
  await f.tick(second)
  assert.equal(started.size, 2, 'Worker replacement must retain unfinished project reservations')
  finished.add(1)
  await f.tick(second)
  assert.equal(started.size, 3)
  assert.equal(second.getJob(1).status, 'completed')
  assert.equal(second.overview().production.activeProjects, 2)
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.check, [])
})

test('manual enqueue advances only the selected existing queued export through all steps without a worker', async t => {
  const f = fixture(t)
  f.add(1); f.add(2)
  const unselected = f.persist(1)
  const selected = f.persist(2)
  await f.service.setEnabled(true)
  f.add(3)
  const worker = f.open({ now: Date.now, stepDelayMs: 1, pollMs: 2 })
  const response = await worker.enqueue([2, 2])
  assert.deepEqual(response.jobs.map(job => job.id), [selected.id])
  await eventually(() => worker.getJob(selected.id).status === 'completed', 'selected export did not run without a worker')
  assert.equal(worker.getJob(unselected.id).status, 'queued')
  assert.equal(worker.listJobs().length, 2, 'The selected run must not admit a different completed source')
  assert.deepEqual(f.calls.create, ['https://www.huasheng.cn/video/2'])
  assert.deepEqual(f.calls.attach, [2])
  assert.deepEqual(f.calls.ensure, [{ id: 2, retry: false }])
  assert.equal((await worker.enqueue([2])).jobs[0]!.id, selected.id)
  assert.equal(f.calls.create.length, 1)
})

test('selected export resumes an existing receipt, merges overlapping calls and never retries terminal jobs', async t => {
  const f = fixture(t)
  for (let id = 1; id <= 4; id++) f.add(id)
  const selected = f.persist(1, { status: 'exporting', stage: 'export_wait', dispatched: 1, task_id: 'original-task', project_hash: 'original-hash' })
  const failed = f.persist(2, { status: 'failed', error: '手工恢复后才能继续' })
  const uncertain = f.persist(3, { status: 'needs_attention', stage: 'export_uncertain', dispatched: 1 })
  const completedJob = f.persist(4, { status: 'completed', stage: 'completed', design_status: 'completed', cover_status: 'completed', article_status: 'completed' })
  f.deliveries.set(4, { videoUrl: '/static/history-deliveries/4/kept.mp4', scriptSha256: hash(f.sources.get(4)!), available: true })
  const worker = f.open({ now: Date.now, stepDelayMs: 1, pollMs: 2 })
  const requests = await Promise.all([worker.enqueue([1, 2, 3, 4]), worker.enqueue([1])])
  assert.equal(requests[0].jobs.length, 4)
  assert.equal(requests[1].jobs[0]!.id, selected.id)
  await eventually(() => worker.getJob(selected.id).status === 'completed', 'saved receipt did not continue')
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.inspect, ['original-task'])
  assert.equal(f.calls.download.length, 1)
  assert.equal(worker.getJob(failed.id).status, 'failed')
  assert.equal(worker.getJob(uncertain.id).status, 'needs_attention')
  assert.equal(worker.getJob(completedJob.id).status, 'completed')
  assert.equal(worker.listJobs().length, 4)
})

test('scoped runPending neither admits nor executes unrelated export jobs', async t => {
  const f = fixture(t); f.add(1); f.add(2)
  const first = f.persist(1)
  const selected = f.persist(2)
  await f.service.setEnabled(true); f.add(3)
  await f.service.runPending([selected.id])
  assert.equal(f.service.getJob(first.id).status, 'queued')
  assert.equal(f.service.getJob(selected.id).stage, 'export_wait')
  assert.equal(f.service.listJobs().length, 2)
  assert.deepEqual(f.calls.create, ['https://www.huasheng.cn/video/2'])
})

test('selected runner retains its scope and receipt after a temporary claim error', async t => {
  const f = fixture(t); f.add(1); f.add(2)
  const selected = f.persist(1, { status: 'exporting', stage: 'export_wait', dispatched: 1, task_id: 'original-task', project_hash: 'original-hash' })
  const unselected = f.persist(2)
  f.db.exec(`CREATE TRIGGER fail_selected_claim BEFORE UPDATE OF owner ON history_huasheng_export_jobs
    WHEN NEW.id=${selected.id} AND NEW.owner IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'temporary claim failure'); END`)
  const errors: unknown[] = []
  const worker = f.open({ now: Date.now, pollMs: 2, onError: error => {
    errors.push(error); f.db.exec('DROP TRIGGER fail_selected_claim')
  } })
  await worker.enqueue([1])
  await eventually(() => errors.length === 1, 'The temporary claim error was not reported')
  await eventually(() => worker.getJob(selected.id).status === 'completed', 'The selected runner discarded its job after a temporary claim error', 1000)
  assert.equal(worker.getJob(unselected.id).status, 'queued')
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.inspect, ['original-task'])
  assert.equal(f.calls.download.length, 1)
})

test('runPending waits for every in-flight step before rejecting a concurrent claim error', async t => {
  const f = fixture(t); f.add(1); f.add(2)
  const broken = f.persist(1)
  const polling = f.persist(2, { status: 'exporting', stage: 'export_wait', dispatched: 1, task_id: 'original-task', project_hash: 'original-hash' })
  f.db.exec(`CREATE TRIGGER fail_first_claim BEFORE UPDATE OF owner ON history_huasheng_export_jobs
    WHEN NEW.id=${broken.id} AND NEW.owner IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'concurrent claim failure'); END`)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const inspect = f.api.inspectHuashengExport
  f.api.inspectHuashengExport = async input => { entered(); await gate; return inspect(input) }
  let settled = false
  const running = f.service.runPending([broken.id, polling.id])
  const checked = assert.rejects(running, /concurrent claim failure/).finally(() => { settled = true })
  await started
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'The drain released while its other step was still running')
    assert.equal(f.service.runPending([polling.id]), running, 'An overlapping request must join the in-flight drain')
  } finally { release(); await checked }
  assert.equal((f.db.prepare('SELECT owner FROM history_huasheng_export_jobs WHERE id=?').get(polling.id) as { owner: string | null }).owner, null)
  assert.deepEqual(f.calls.inspect, ['original-task'])
})

test('selected runner recovers its own released step when claim cleanup temporarily fails', async t => {
  const f = fixture(t); f.add(1); f.add(2)
  const selected = f.persist(1, { status: 'exporting', stage: 'export_wait', dispatched: 1, task_id: 'original-task', project_hash: 'original-hash' })
  const unselected = f.persist(2)
  f.db.exec(`CREATE TRIGGER fail_claim_cleanup BEFORE UPDATE OF owner ON history_huasheng_export_jobs
    WHEN NEW.id=${selected.id} AND OLD.owner IS NOT NULL AND NEW.owner IS NULL
    BEGIN SELECT RAISE(ABORT,'temporary claim cleanup failure'); END`)
  const errors: unknown[] = []
  const worker = f.open({ now: Date.now, pollMs: 2, onError: error => {
    errors.push(error); f.db.exec('DROP TRIGGER fail_claim_cleanup')
  } })
  await worker.enqueue([1])
  await eventually(() => errors.length === 1, 'The claim cleanup error was not reported')
  await eventually(() => worker.getJob(selected.id).status === 'completed', 'The live process kept its own inactive claim and stalled', 1000)
  assert.equal(worker.getJob(unselected.id).status, 'queued')
  assert.equal((f.db.prepare('SELECT owner FROM history_huasheng_export_jobs WHERE id=?').get(selected.id) as { owner: string | null }).owner, null)
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.inspect, ['original-task'])
  assert.equal(f.calls.download.length, 1)
  assert.deepEqual(f.calls.attach, [1])
})

test('persistent selected drain errors become visible and require explicit resume of the saved receipt', async t => {
  const f = fixture(t); f.add(1); f.add(2)
  const selected = f.persist(1, { status: 'exporting', stage: 'export_wait', dispatched: 1, task_id: 'original-task', project_hash: 'original-hash' })
  const unselected = f.persist(2)
  f.db.exec(`CREATE TRIGGER fail_selected_claim BEFORE UPDATE OF owner ON history_huasheng_export_jobs
    WHEN NEW.id=${selected.id} AND NEW.owner IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'persistent claim failure'); END`)
  const errors: unknown[] = []
  const worker = f.open({ now: Date.now, pollMs: 2, maxRetries: 1, onError: error => { errors.push(error) } })
  await worker.enqueue([1])
  await eventually(() => worker.getJob(selected.id).status === 'needs_attention', 'The failed selected drain left an active task stranded', 1000)
  assert.match(worker.getJob(selected.id).message, /执行异常.*重试/)
  assert.equal(worker.getJob(selected.id).stage, 'export_wait')
  assert.equal(errors.length, 2)
  await worker.enqueue([1])
  await worker.runPending([selected.id])
  assert.equal(errors.length, 2, 'Terminal failures must not be retried by enqueue or polling')
  assert.equal(worker.getJob(unselected.id).status, 'queued')
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.inspect, [])
  f.db.exec('DROP TRIGGER fail_selected_claim')
  worker.resume(selected.id)
  await eventually(() => worker.getJob(selected.id).status === 'completed', 'Explicit resume did not recover the saved export', 1000)
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.inspect, ['original-task'])
})

test('worker status reflects durable live heartbeats, not enabled configuration', async t => {
  const f = fixture(t)
  await f.service.setEnabled(true)
  assert.equal(f.service.overview().worker.status, 'stopped')
  const reader = f.open()
  f.service.start()
  assert.equal(reader.overview().worker.status, 'running')
  await f.service.stop()
  assert.equal(reader.overview().worker.status, 'stopped')
  f.db.prepare(`INSERT INTO history_huasheng_export_workers(owner,host,pid,heartbeat_at,mode) VALUES('dead',?,?,?,'automatic')`)
    .run(hostname(), 987654321, Date.now())
  assert.equal(reader.overview().worker.status, 'stopped')
})

test('a transient initial heartbeat write cannot throw out of the polling loop', async t => {
  const f = fixture(t)
  const errors: unknown[] = []
  const worker = f.open({ onError: error => { errors.push(error) } })
  f.db.exec(`CREATE TRIGGER fail_heartbeat BEFORE INSERT ON history_huasheng_export_workers
    BEGIN SELECT RAISE(ABORT,'temporary heartbeat failure'); END`)
  let pending!: Promise<void>
  assert.doesNotThrow(() => { pending = worker.runPending() })
  await pending
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]), /temporary heartbeat failure/)
  f.db.exec('DROP TRIGGER fail_heartbeat')
  await worker.runPending()
  assert.equal(errors.length, 1)
  assert.deepEqual(f.calls.create, [])
})

test('manual pipeline is durable, deduplicated and associates once before independent processing', async t => {
  const f = fixture(t); f.add(60)
  assert.equal(f.service.enabled, false)
  const job = (await f.service.enqueue([60, 60])).jobs[0]!
  assert.equal((await f.service.enqueue([60])).jobs[0]!.id, job.id)
  await f.service.runPending()
  assert.equal(f.service.getJob(job.id).stage, 'export_wait')
  const reopened = f.open(); await f.service.close()
  await f.finish(reopened)
  const result = reopened.getJob(job.id)
  assert.equal(result.status, 'completed')
  assert.equal(result.videoUrl, '/static/history-deliveries/60/kept.mp4')
  assert.equal(result.downloadedBytes, 100)
  assert.equal(result.totalBytes, 100)
  assert.equal(result.designStatus, 'completed'); assert.equal(result.coverStatus, 'completed'); assert.equal(result.articleStatus, null)
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.download.length, 1)
  assert.deepEqual(f.calls.attach, [60]); assert.deepEqual(f.calls.ensure, [{ id: 60, retry: false }])
  const json = JSON.stringify(reopened.overview())
  assert.doesNotMatch(json, /cdn\.example|secret|task_id|project_hash|file_path|isolated-fixture|owner|dispatched/)
  await reopened.runPending(); assert.equal(f.calls.create.length, 1)
})

test('auto is opt-in, watermark is set once, reenable keeps it and only future completed jobs are admitted', async t => {
  const f = fixture(t); f.add(1); f.add(2, 'creating')
  await f.service.runPending(); assert.equal(f.service.listJobs().length, 0)
  await f.service.setEnabled(true)
  assert.equal(f.calls.monitor, 0)
  await f.service.runPending(); assert.equal(f.service.listJobs().length, 0)
  f.add(3, 'creating'); f.add(4)
  await f.service.runPending()
  assert.deepEqual(f.service.listJobs().map(job => job.sourceId), [4])
  await f.service.setEnabled(false); assert.equal(f.calls.monitor, 0)
  f.db.prepare("UPDATE history_huasheng_jobs SET production_status='completed' WHERE id=3").run()
  await f.tick(); assert.equal(f.service.listJobs().length, 1)
  await f.service.setEnabled(true); await f.tick()
  assert.deepEqual(f.service.listJobs().map(job => job.sourceId).sort(), [3, 4])
  const settings = f.db.prepare('SELECT admission_watermark FROM history_huasheng_export_settings').get() as { admission_watermark: number }
  assert.equal(settings.admission_watermark, 2)
})

test('selected creating projects wait without blocking a completed project or buying fast mode', async t => {
  const f = fixture(t); f.add(1, 'creating'); f.add(2)
  const { jobs } = await f.service.enqueue([1, 2]); await f.finish()
  assert.equal(f.service.getJob(jobs[0]!.id).stage, 'waiting_production')
  assert.equal(f.service.getJob(jobs[1]!.id).status, 'completed')
  assert.deepEqual(f.calls.create, ['https://www.huasheng.cn/video/2'])
  assert.deepEqual(f.calls.check, [], 'Export continuation reads the saved state without opening production checks')
  f.db.prepare("UPDATE history_huasheng_jobs SET production_status='completed' WHERE id=1").run()
  await f.finish(); assert.equal(f.service.getJob(jobs[0]!.id).status, 'completed')
})

test('current existing video skips all remote operations and preserves its path', async t => {
  const f = fixture(t); f.add(61)
  const video = { videoUrl: '/static/history-deliveries/61/manual.mp4', scriptSha256: hash(f.sources.get(61)!), available: true }
  f.deliveries.set(61, video)
  const job = (await f.service.enqueue([61])).jobs[0]!
  await f.service.runPending()
  assert.equal(f.service.getJob(job.id).status, 'completed')
  assert.equal(f.service.getJob(job.id).videoUrl, video.videoUrl)
  assert.equal(f.calls.create.length, 0); assert.equal(f.calls.download.length, 0); assert.equal(f.calls.attach.length, 0)
})

test('stale source or mismatched existing video stops before export or replacement', async t => {
  for (const change of ['script', 'video'] as const) await t.test(change, async child => {
    const f = fixture(child); f.add(1)
    const job = f.persist(1)
    if (change === 'script') f.sources.set(1, 'later script')
    else f.deliveries.set(1, { videoUrl: '/existing.mp4', scriptSha256: 'old', available: true })
    await f.service.runPending()
    assert.equal(f.service.getJob(job.id).status, 'needs_attention')
    assert.equal(f.calls.create.length, 0); assert.equal(f.calls.attach.length, 0)
  })
})

test('lost create response persists uncertain intent, is never reposted and cannot use failed-resume', async t => {
  const f = fixture(t); f.add(1)
  f.api.createHuashengExport = async input => { f.calls.create.push(input.projectUrl); await input.onDispatched?.(); throw Object.assign(new Error('lost reply https://cdn.example/private?token=secret'), { code: 'result_uncertain' }) }
  const job = (await f.service.enqueue([1])).jobs[0]!
  await f.service.runPending(); await f.finish(f.open())
  const stored = f.service.getJob(job.id)
  assert.equal(stored.status, 'needs_attention'); assert.equal(stored.stage, 'export_uncertain')
  assert.doesNotMatch(stored.error!, /cdn|secret/)
  assert.equal(f.calls.create.length, 1)
  assert.throws(() => f.service.resume(job.id), /须核验并绑定/)
})

test('dead-process recovery preserves post marker and accepts an already committed attachment', async t => {
  const f = fixture(t); f.add(1); f.add(2)
  const { jobs } = await f.service.enqueue([1, 2])
  f.db.prepare("UPDATE history_huasheng_export_jobs SET owner='dead',host=?,pid=987654321,dispatched=1,status='exporting',stage='export_request' WHERE id=?").run(hostname(), jobs[0]!.id)
  f.db.prepare("UPDATE history_huasheng_export_jobs SET owner='dead',host=?,pid=987654321,status='downloading',stage='attach',file_path='/kept.mp4' WHERE id=?").run(hostname(), jobs[1]!.id)
  f.deliveries.set(2, { videoUrl: '/static/history-deliveries/2/kept.mp4', scriptSha256: hash(f.sources.get(2)!), available: true })
  await f.open().runPending()
  assert.equal(f.service.getJob(jobs[0]!.id).status, 'needs_attention')
  assert.equal(f.service.getJob(jobs[1]!.id).status, 'completed')
  assert.equal(f.calls.create.length, 0); assert.equal(f.calls.attach.length, 0)
})

test('a live local owner cannot be reclaimed based on old timestamps', async t => {
  const f = fixture(t); f.add(1)
  const job = (await f.service.enqueue([1])).jobs[0]!
  f.db.prepare("UPDATE history_huasheng_export_jobs SET owner='live',host=?,pid=?,updated_at='2000-01-01' WHERE id=?").run(hostname(), process.pid, job.id)
  await f.open().runPending()
  assert.equal(f.calls.create.length, 0)
})

test('login wait is automatic and does not stop other projects', async t => {
  const f = fixture(t); f.add(1); f.add(2)
  const create = f.api.createHuashengExport
  let loggedIn = false
  f.api.createHuashengExport = async input => {
    if (input.projectUrl.endsWith('/1') && !loggedIn) throw Object.assign(new Error('请登录花生'), { code: 'login_required' })
    return create(input)
  }
  const { jobs } = await f.service.enqueue([1, 2]); await f.finish()
  assert.equal(f.service.getJob(jobs[0]!.id).status, 'waiting_login')
  assert.equal(f.service.getJob(jobs[1]!.id).status, 'completed')
  loggedIn = true; await f.finish()
  assert.equal(f.service.getJob(jobs[0]!.id).status, 'completed')
  assert.equal(f.calls.create.length, 2)
})

test('safe polling retries are bounded across restart and resume reuses the same export ID', async t => {
  const f = fixture(t); f.add(1)
  const inspect = f.api.inspectHuashengExport
  let polls = 0
  f.api.inspectHuashengExport = async () => { polls++; throw Object.assign(new Error('network down'), { code: 'retryable' }) }
  const job = (await f.service.enqueue([1])).jobs[0]!
  await f.service.runPending(); await f.tick()
  const reopened = f.open(); await f.service.close(); await f.finish(reopened)
  assert.equal(reopened.getJob(job.id).status, 'failed'); assert.equal(polls, 3)
  f.api.inspectHuashengExport = inspect
  reopened.resume(job.id); await f.finish(reopened)
  assert.equal(reopened.getJob(job.id).status, 'completed'); assert.equal(f.calls.create.length, 1)
})

test('intermediate export URL cannot start download until progress is exactly 100', async t => {
  const f = fixture(t); f.add(1)
  let progress = 45
  f.api.inspectHuashengExport = async () => ({ progress, url: 'https://cdn.example/intermediate.mp4', filename: 'preview.mp4' })
  const job = (await f.service.enqueue([1])).jobs[0]!
  await f.service.runPending(); await f.tick(); await f.tick()
  assert.equal(f.service.getJob(job.id).status, 'exporting')
  assert.equal(f.service.getJob(job.id).exportProgress, 45)
  assert.equal(f.calls.download.length, 0)
  progress = 100; await f.finish()
  assert.equal(f.service.getJob(job.id).status, 'completed')
  assert.equal(f.calls.download.length, 1)
})

test('authoritative POST login rejection clears dispatch intent and waits for a valid session', async t => {
  const f = fixture(t); f.add(1)
  let posts = 0, loggedIn = false
  f.api.createHuashengExport = async input => {
    if (posts && !loggedIn) throw Object.assign(new Error('session still expired before POST'), { code: 'login_required' })
    await input.onDispatched?.(); posts++
    if (!loggedIn) throw Object.assign(new Error('server explicitly rejected login'), { code: 'login_required', requestRejected: true })
    return { taskId: 'accepted-task', projectHash: 'accepted-hash' }
  }
  const job = (await f.service.enqueue([1])).jobs[0]!
  await f.service.runPending()
  assert.equal(f.service.getJob(job.id).status, 'waiting_login')
  assert.equal((f.db.prepare('SELECT dispatched FROM history_huasheng_export_jobs WHERE id=?').get(job.id) as { dispatched: number }).dispatched, 0)
  await f.tick(); assert.equal(posts, 1)
  loggedIn = true; await f.finish()
  assert.equal(f.service.getJob(job.id).status, 'completed'); assert.equal(posts, 2)
})

test('manual uncertain recovery with a saved receipt inspects that receipt without another create', async t => {
  const f = fixture(t); f.add(1)
  const job = (await f.service.enqueue([1])).jobs[0]!
  await f.service.runPending()
  f.db.prepare("UPDATE history_huasheng_export_jobs SET status='needs_attention',stage='export_uncertain' WHERE id=?").run(job.id)
  f.service.resume(job.id); await f.finish()
  assert.equal(f.service.getJob(job.id).status, 'completed')
  assert.deepEqual(f.calls.inspect, ['task-1']); assert.equal(f.calls.create.length, 1)
})

test('manual content repaired after needs_attention can resume while preserving media and export receipt', async t => {
  const f = fixture(t); f.add(1)
  f.deliveries.set(1, { videoUrl: '/static/history-deliveries/1/manual.mp4', scriptSha256: hash(f.sources.get(1)!), available: true })
  let repaired = false
  const worker = f.open({ ensureAutomation: async () => repaired ? completed() : {
    design: { status: 'needs_attention', message: '请补齐手工封面方案' }, covers: { status: 'needs_attention', message: '先补齐方案再生成图片' }, article: { status: 'completed', message: '文章完成' },
  } })
  const job = (await worker.enqueue([1])).jobs[0]!
  await worker.runPending(); assert.equal(worker.getJob(job.id).status, 'needs_attention')
  repaired = true; worker.resume(job.id); await f.tick(worker)
  assert.equal(worker.getJob(job.id).status, 'completed')
  assert.equal(worker.getJob(job.id).videoUrl, '/static/history-deliveries/1/manual.mp4')
  assert.equal(f.calls.create.length, 0); assert.equal(f.calls.attach.length, 0)
})

test('expired download URL refreshes original export and keeps bounded download retry count', async t => {
  const f = fixture(t); f.add(1)
  let downloads = 0
  f.api.downloadHuashengExport = async () => { downloads++; throw Object.assign(new Error('signed URL expired'), { code: 'retryable' }) }
  const job = (await f.service.enqueue([1])).jobs[0]!
  for (let i = 0; i < 12; i++) await f.tick()
  assert.equal(f.service.getJob(job.id).status, 'failed')
  assert.equal(downloads, 3); assert.equal(f.calls.create.length, 1)
  assert.equal(f.calls.inspect.length, 3)
})

test('failed design does not wait for retired article work; explicit retry requests failed branches once', async t => {
  const f = fixture(t); f.add(1); f.add(2)
  f.deliveries.set(1, { videoUrl: '/static/history-deliveries/1/kept.mp4', scriptSha256: hash(f.sources.get(1)!), available: true })
  let articleDone = false, retried = false
  f.options.ensureAutomation = async (id, input) => {
    f.calls.ensure.push({ id, retry: !!input.retryFailed })
    if (id !== 1) return completed()
    if (input.retryFailed) retried = true
    return { design: { status: retried ? 'completed' : 'failed', message: 'design result' }, covers: completed().covers, article: { status: articleDone ? 'completed' : 'generating', message: 'article result' } }
  }
  const worker = f.open()
  const { jobs } = await worker.enqueue([1, 2]); await f.finish(worker)
  assert.equal(worker.getJob(jobs[0]!.id).status, 'failed')
  assert.equal(worker.getJob(jobs[1]!.id).status, 'completed')
  articleDone = true; await f.tick(worker)
  assert.equal(worker.getJob(jobs[0]!.id).status, 'failed')
  worker.resume(jobs[0]!.id); await f.finish(worker)
  assert.equal(worker.getJob(jobs[0]!.id).status, 'completed')
  assert.equal(f.calls.ensure.filter(call => call.id === 1 && call.retry).length, 1)
  assert.deepEqual(f.calls.attach, [2])
})

test('an old processing failure resumes with video-only packaging and retains the downloaded video', async t => {
  const f = fixture(t); f.add(1)
  const videoUrl = '/static/history-deliveries/1/kept.mp4'
  f.deliveries.set(1, { videoUrl, scriptSha256: hash(f.sources.get(1)!), available: true })
  const job = f.persist(1, { status: 'failed', stage: 'processing', video_url: videoUrl,
    task_id: 'original-export', project_hash: 'original-version', file_path: '/kept/video.mp4',
    downloaded_bytes: 100, total_bytes: 100, error: "Cannot read properties of undefined (reading 'status')" })
  const worker = f.open({ ensureAutomation: async () => ({ design: completed().design, covers: completed().covers }) })
  worker.resume(job.id)
  await f.tick(worker)
  const result = worker.getJob(job.id)
  assert.equal(result.status, 'completed')
  assert.equal(result.error, null)
  assert.equal(result.articleStatus, null)
  assert.equal(result.videoUrl, videoUrl)
  assert.equal(result.downloadedBytes, 100)
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.inspect, [])
  assert.deepEqual(f.calls.download, [])
  assert.deepEqual(f.calls.attach, [])
})

test('incomplete packaging status retries the original processing step without a TypeError or false completion', async t => {
  const f = fixture(t); f.add(1)
  const videoUrl = '/static/history-deliveries/1/kept.mp4'
  f.deliveries.set(1, { videoUrl, scriptSha256: hash(f.sources.get(1)!), available: true })
  let complete = false
  const worker = f.open({ ensureAutomation: async () => complete ? completed() : { design: completed().design } as HuashengExportAutomation })
  const job = f.persist(1, { status: 'processing', stage: 'processing', video_url: videoUrl })
  await f.tick(worker)
  const waiting = worker.getJob(job.id)
  assert.equal(waiting.status, 'processing')
  assert.match(waiting.error!, /状态不完整.*视频封面/)
  assert.doesNotMatch(waiting.error!, /Cannot read properties/)
  assert.equal(waiting.coverStatus, null)
  complete = true
  await f.tick(worker)
  assert.equal(worker.getJob(job.id).status, 'completed')
  assert.equal(worker.getJob(job.id).error, null)
  assert.deepEqual(f.calls.create, [])
  assert.deepEqual(f.calls.download, [])
})

test('graceful shutdown aborts safe poll, preserves task identity and releases claim', async t => {
  const f = fixture(t); f.add(1)
  const job = (await f.service.enqueue([1])).jobs[0]!
  await f.service.runPending()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const inspect = f.api.inspectHuashengExport
  f.api.inspectHuashengExport = async input => new Promise((_resolve, reject) => {
    entered(); input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
  })
  const running = f.tick(); await started; await f.service.stop(); await running
  assert.equal(f.service.getJob(job.id).status, 'exporting')
  const row = f.db.prepare('SELECT owner,task_id FROM history_huasheng_export_jobs WHERE id=?').get(job.id) as { owner: string | null; task_id: string }
  assert.equal(row.owner, null); assert.ok(row.task_id)
  f.api.inspectHuashengExport = inspect
  await f.finish(f.open()); assert.equal(f.service.getJob(job.id).status, 'completed')
  assert.equal(f.calls.create.length, 1)
})

test('two workers cannot post the same job while the first holds its claim', async t => {
  const f = fixture(t); f.add(1)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.api.createHuashengExport = async input => { f.calls.create.push(input.projectUrl); await input.onDispatched?.(); entered(); await gate; return { taskId: 'task-1', projectHash: 'hash-1' } }
  await f.service.enqueue([1])
  const first = f.service.runPending(); await started
  try { await f.open().runPending(); assert.equal(f.calls.create.length, 1) }
  finally { release(); await first }
})

test('manual export with default automation publishes an intent and never starts article work', { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'history-export-default-automation-'))
  const environment = Object.fromEntries(['DB_PATH', 'STORAGE_PATH', 'TASK_WORKER_DISABLED'].map(key => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  process.env.DB_PATH = path.join(root, 'test.db')
  process.env.STORAGE_PATH = root
  process.env.TASK_WORKER_DISABLED = '1'
  const { db, schema } = await import('../db/index.js')
  const library = await import('./history-script-library.js')
  const delivery = await import('./history-script-delivery.js')
  const { getHistoryArticle } = await import('./history-script-article.js')
  const { getHistoryArticleQueueService } = await import('./history-script-article-queue.js')
  const articles = getHistoryArticleQueueService()
  const failures: unknown[] = []
  const service = new HistoryHuashengExportService({ database: db.$client, pollMs: 2, stepDelayMs: 1, onError: error => failures.push(error),
    attachVideo: async (id, filePath, name, options) => {
      const result = await delivery.attachHistoryVideoFile(id, filePath, name, options)
      const own = delivery.getHistoryDelivery(id).videos.find(video => video.producer === 'huasheng' && video.producerJobId === options.producerJobId)!
      delivery.saveHistoryDelivery(id, { title: '明朝冬季买菜为什么贵？', description: '冬季菜市里的供应与运费',
        coverDesign: { main_title: '明朝冬季买菜为什么贵？', sub_title: '', kicker: '', ai_prompt: 'Ming vegetable trader weighing produce in a winter market' } }, own.id)
      const ownDirectory = `history-deliveries/${id}/video-${own.id}`
      fs.mkdirSync(path.join(root, ownDirectory), { recursive: true })
      const ownCovers = Object.fromEntries(['16:9', '4:3', '3:4'].map(ratio => [ratio, `static/${ownDirectory}/${ratio.replace(':', 'x')}.png`]))
      for (const filename of Object.values(ownCovers)) fs.writeFileSync(path.join(root, filename.replace(/^static\//, '')), png)
      db.$client.prepare("UPDATE history_video_packaging SET covers_json=?,cover_script_sha256=?,cover_status='completed' WHERE video_id=?")
        .run(JSON.stringify(ownCovers), hash(script), own.id)
      return result
    },
    api: {
      createHuashengExport: async input => { await input.onDispatched?.(); return { taskId: 'integration-export', projectHash: 'integration-version' } },
      inspectHuashengExport: async () => ({ progress: 100, url: 'https://fixture.example/video.mp4', filename: 'finished.mp4' }),
      downloadHuashengExport: async () => ({ filePath: video, filename: 'finished.mp4', bytes: fs.statSync(video).size }),
    },
  })
  t.after(async () => {
    await service.close(); await articles.close(); db.$client.close()
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const text = '明朝冬季的蔬菜供应有限。运输困难，城里的鲜菜价格可能更高。'
  const script = '当前明朝菜价二创口播稿。'
  const source = library.storeHistorySource({ sourceVideoId: '7395681234567890123', title: '明朝冬季菜价', category: 'regional_history',
    metrics: {}, selection: { reason: 'isolated export integration fixture', observedAt: new Date().toISOString(), comments: [] } })
  library.updateHistorySource(source.id, { status: 'needs_review', rawTranscript: text, correctedTranscript: text, rewrittenScript: script,
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 3, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text, sourceVideoSha256: '1'.repeat(64), chunks: [{ index: 0, start: 0, duration: 3, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ correctedTranscript: text, corrections: [], factualConcerns: [], factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(text), correctedTranscriptSha256: hash(text), rewriteInputSha256: hash(text) }),
  })
  // Legacy packaging must not satisfy the exported video's independent package.
  delivery.saveHistoryDelivery(source.id, { title: '明朝冬天的菜为何贵？', baijiahaoTitle: '明朝冬天的菜为何贵？', description: '从供应和运输看菜价',
    coverDesign: { main_title: '明朝冬天的菜为何贵？', sub_title: '', kicker: '', ai_prompt: 'Ming dynasty winter market' } })
  const covers = Object.fromEntries(['16:9', '4:3', '3:4'].map(ratio => [ratio, `static/history-deliveries/${source.id}/${ratio.replace(':', 'x')}.png`]))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  fs.mkdirSync(path.join(root, 'history-deliveries', String(source.id)), { recursive: true })
  for (const filename of Object.values(covers)) fs.writeFileSync(path.join(root, filename.replace(/^static\//, '')), png)
  db.$client.prepare("UPDATE history_script_deliveries SET covers_json=?,cover_script_sha256=?,cover_status='completed' WHERE script_id=?")
    .run(JSON.stringify(covers), hash(script), source.id)
  db.$client.exec(`CREATE TABLE history_huasheng_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,project_url TEXT,production_status TEXT,status TEXT)`)
  db.$client.prepare('INSERT INTO history_huasheng_jobs VALUES(1,?,?,?,?,?)').run(source.id, hash(script), 'https://www.huasheng.cn/video/123', 'completed', 'submitted')
  db.$client.prepare(`INSERT INTO history_script_article_queue(source_id,script_sha256,video_url,video_fingerprint,provenance_json,status,message,created_at,updated_at)
    VALUES(999,?,'/old.mp4','old','{}','failed','旧失败不得重试',?,?)`).run(hash('old'), new Date().toISOString(), new Date().toISOString())
  db.insert(schema.aiServiceConfigs).values({ name: 'Isolated article model', serviceType: 'text', provider: 'openai', baseUrl: 'https://text-fixture.example',
    apiKey: 'fixture-only', model: JSON.stringify(['fixture-model']), isActive: true, priority: 10, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
  let modelCalls = 0
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://text-fixture.example/v1/chat/completions')
    assert.equal(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).correctedTranscript, text)
    modelCalls++
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '明朝冬季菜价', sections: [{ heading: '供应和运输', paragraphs: [{ text }] }] }) } }] })
  }
  const video = path.join(root, 'fixture.mp4')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video], { timeout: 15_000 })
  const {recordHistoryDualProduction}=await import('./history-video-deliveries.js')
  recordHistoryDualProduction(db.$client,source.id,hash(script),1)
  const job = (await service.enqueue([source.id])).jobs[0]!
  await eventually(() => {
    const current = service.getJob(job.id)
    assert.ok(!['failed', 'needs_attention'].includes(current.status), JSON.stringify(current))
    return current.status === 'completed'
  }, 'Default manual export did not finish video packaging', 20_000)
  assert.equal(service.getJob(job.id).articleStatus, null)
  assert.equal(service.getJob(job.id).designStatus, 'completed')
  assert.equal(service.getJob(job.id).coverStatus, 'completed')
  const own = delivery.getHistoryDelivery(source.id).videoPackagings[0]!
  assert.equal(own.title, '明朝冬季买菜为什么贵？')
  assert.equal(delivery.getHistoryDelivery(source.id).title, '明朝冬天的菜为何贵？')
  assert.ok(Object.values(own.covers).every(filename => filename?.includes(`/video-${own.videoId}/`)))
  assert.notEqual(getHistoryArticle(source.id).status, 'completed')
  assert.equal(articles.listJobs(source.id).length,0)
  assert.equal((db.$client.prepare('SELECT COUNT(*) AS n FROM history_video_publication_intents WHERE source_id=?').get(source.id) as {n:number}).n,1)
  assert.equal(articles.listJobs(999)[0]!.status, 'failed')
  assert.equal(modelCalls, 0)
  assert.deepEqual(failures, [])
})
