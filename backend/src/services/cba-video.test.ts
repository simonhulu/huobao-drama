import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { CbaVideoService, type CbaVideoOptions } from './cba-video.js'
import { buildCbaExecutorCommand } from './cba-production-executor.js'
import type { SocialUploadPayload, SocialUploadResult } from './social-auto-upload.js'

const jobId = '2026-10-18-nanjing-guangdong'
let fixtureVideo: Buffer | undefined
const fileHash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readyRuntime = { installed: true, version: 'test', message: 'ready', platforms: {
  tencent: { ready: true, message: 'ready' }, baijiahao: { ready: true, message: 'ready' },
} }
function receipt(payload: SocialUploadPayload, saved = false): SocialUploadResult {
  const targetId = createHash('sha256').update(payload.jobId).digest('hex').slice(0, 16)
  const articleId = BigInt(`0x${targetId}`).toString()
  return { staged: true, saved, published: false, engine: 'test', targetId, accountName: payload.accountName,
    editorUrl: payload.target === 'tencent-video' ? 'https://channels.weixin.qq.com/platform/post/create' : 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',
    ...(saved ? { draftUrl: payload.target === 'tencent-video' ? 'https://channels.weixin.qq.com/platform/post/draftListManager'
      : `https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=${articleId}` } : {}) }
}
function runtime(overrides: Partial<NonNullable<CbaVideoOptions['runtime']>> = {}): NonNullable<CbaVideoOptions['runtime']> {
  const saved = new Map<string, SocialUploadResult>()
  const implementation: NonNullable<CbaVideoOptions['runtime']> = {
    inspectSocialUploadRuntime: async () => readyRuntime,
    inspectSocialUploadAccountRuntime: async () => ({ ready: true, message: 'ready' }),
    openSocialUploadLogin: async () => ({ opened: true, message: 'opened' }),
    inspectSocialUploadCheckpoint: async payload => {
      const result = saved.get(payload.jobId)
      return result ? { action: result.saved ? 'complete' : 'save', phase: result.saved ? 'saved' : 'staged', message: 'checkpoint', result }
        : { action: 'upload', phase: 'new', message: 'new' }
    },
    runSocialUpload: async payload => receipt(payload),
    confirmSocialUpload: async payload => receipt(payload, true),
    resumeSocialUpload: async payload => receipt(payload, true),
    reconcileSocialUpload: async payload => receipt(payload, true),
    ...overrides,
  }
  return { ...implementation,
    runSocialUpload: async (...args) => {
      assert.equal(args[1].saveDraft, false, 'upload and draft save need separate checkpoints')
      const result = await implementation.runSocialUpload(...args); saved.set(args[0].jobId, result); return result
    },
    confirmSocialUpload: async (...args) => { const result = await implementation.confirmSocialUpload(...args); saved.set(args[0].jobId, result); return result },
    resumeSocialUpload: async (...args) => { const result = await implementation.resumeSocialUpload(...args); saved.set(args[0].jobId, result); return result },
    reconcileSocialUpload: async (...args) => { const result = await implementation.reconcileSocialUpload(...args); saved.set(args[0].jobId, result); return result },
  }
}
function accounts(defaultAccountName = 'cba_first'): NonNullable<CbaVideoOptions['accounts']> {
  return {
    list: () => ({ defaultAccountName }),
    get: accountName => ({ accountName, label: accountName === 'cba_first' ? '第一账号' : '第二账号', status: 'ready', message: 'ready' }),
  }
}
async function fixture(t: any, options: CbaVideoOptions = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cba-video-service-')))
  const directory = path.join(root, jobId); fs.mkdirSync(directory)
  const { createJob, editorialDigest } = await import(new URL('../../../scripts/cba-video/core.mjs', import.meta.url).href)
  const { renderInputDigest } = await import(new URL('../../../scripts/cba-video/cli.mjs', import.meta.url).href)
  const job = createJob({ id: jobId, league: 'CBA', date: '2026-10-18', home: '南京', away: '广东', verified: true, seedUrls: ['https://example.com/news'] })
  Object.assign(job.profile, { width: 160, height: 90, fps: 10 })
  job.sources = [{ id: 'report', title: '测试报道', url: 'https://example.com/news' }]
  job.facts = [{ id: 'score', text: '测试比分', sourceIds: ['report'], verified: true }]
  const source = path.join(directory, 'source.mp4')
  if (!fixtureVideo) {
    execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=blue:s=160x90:r=10:d=1.2','-f','lavfi','-i','sine=frequency=440:duration=1.2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',source])
    fixtureVideo = fs.readFileSync(source)
  } else fs.writeFileSync(source, fixtureVideo)
  const { probeMedia } = await import(new URL('../../../scripts/cba-video/media.mjs', import.meta.url).href)
  const probe = await probeMedia(source)
  job.media = [{ id: 'replay', kind: 'full_replay', path: source, matchId: jobId, matchConfirmed: true, probe, sha256: fileHash(source) }]
  job.clips = [{ id: 'play', mediaId: 'replay', start: 0, end: 1.2, factIds: ['score'], verified: true, verificationNote: '合成媒体仅用于流程测试' }]
  job.news = { title: '南京险胜广东', summary: '南京赢得首胜。', segments: [{ id: 'opening', text: '测试新闻', mode: 'original', factIds: ['score'], clipIds: ['play'] }] }
  job.highlights = { title: '南京广东关键回合', clipIds: ['play'] }
  const outputs: any = { inputDigest: await renderInputDigest(job), artifacts: [] }
  for (const kind of ['news', 'highlights']) {
    const video = path.join(directory, `${kind}.mp4`), cover = path.join(directory, `${kind}.jpg`)
    fs.writeFileSync(video, fixtureVideo)
    await sharp({ create: { width: 16, height: 9, channels: 3, background: '#203040' } }).jpeg().toFile(cover)
    outputs[kind] = { path: video, coverPath: cover, duration: probe.duration }
    outputs.artifacts.push(...[video, cover].map(file => ({ path: file, sha256: fileHash(file) })))
  }
  const subtitle = path.join(directory, 'news.srt'); fs.writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:01,200\n测试新闻\n')
  outputs.news.subtitlePath = subtitle; outputs.artifacts.push({ path: subtitle, sha256: fileHash(subtitle) })
  job.status = 'rendered'; job.review = { complete: true, digest: editorialDigest(job) }; job.approval = { digest: job.review.digest, note: '测试本轮自动制作授权' }; job.outputs = outputs
  const jobFile = path.join(directory, 'job.json')
  const writeJob = () => fs.writeFileSync(jobFile, JSON.stringify(job))
  writeJob()
  const service = new CbaVideoService({ root, autoRecover: false, modelRetryBaseDelayMs: 0, runtime: runtime(), accounts: accounts(),
    captureHomepage: async () => null,
    productionCheck: async () => ({ ready: true, message: 'ready' }),
    launch: () => { throw Error('Unexpected external discovery process in test') },
    pipeline: async (_jobDir, _runId, deps) => {
      const failure = await deps.verifyDelivery()
      return { ready: !failure, stage: 'rendering', message: failure?.message || 'ready' }
    }, ...options })
  t.after(async () => { await service.waitForIdle(); fs.rmSync(root, { recursive: true, force: true }) })
  const reapprove = async () => { job.review.digest = editorialDigest(job); job.approval.digest = job.review.digest; job.outputs.inputDigest = await renderInputDigest(job); writeJob() }
  return { service, root, job, jobFile, writeJob, reapprove }
}

test('production readiness shares an in-flight provider probe and refresh bypasses its cache', async t => {
  let resolve!: (value: { ready: boolean; message: string }) => void, calls = 0
  const { service } = await fixture(t, { productionCheck: () => { calls++; return new Promise(done => { resolve = done }) } })
  const first = service.productionStatus(), concurrent = service.productionStatus(true)
  assert.equal(calls, 1, 'Concurrent requests must not duplicate paid connectivity probes')
  resolve({ ready: true, message: 'provider connected' })
  assert.equal((await first).ready, true); await concurrent
  await service.productionStatus(); assert.equal(calls, 1)
  const refresh = service.productionStatus(true); assert.equal(calls, 2)
  resolve({ ready: false, message: 'provider unavailable' }); await refresh
  assert.equal((await service.productionStatus()).ready, false)
})

test('an active CBA project prevents connection checks from launching another executor, including from another service instance', async t => {
  let checks = 0, finish!: (code: number) => void, started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const done = new Promise<number>(resolve => { finish = resolve })
  const productionCheck = async () => { checks++; return { ready: true, message: 'ready' } }
  const { service, root } = await fixture(t, { productionCheck, launch: () => {
    started(); return { done, stop: () => finish(143) }
  } })
  await service.start({ requestId: 'active-project-check', autoUpload: false })
  await running
  try {
    const second = new CbaVideoService({ root, autoRecover: false, productionCheck })
    for (const instance of [service, second]) {
      const status = await instance.productionStatus(true)
      assert.equal(checks, 1, 'refreshing an active project must not send an extra model probe')
      assert.equal(status.ready, true)
      assert.match(status.message, /串行/)
    }
  } finally { service.stop(service.overview().activeRun!.id); await service.waitForIdle() }
})

test('simultaneous CBA starts admit one project and reuse the same request identity', async t => {
  let ready!: (value: { ready: boolean; message: string }) => void, finish!: (code: number) => void, launches = 0
  const done = new Promise<number>(resolve => { finish = resolve })
  const { service } = await fixture(t, {
    productionCheck: () => new Promise(resolve => { ready = resolve }),
    launch: () => { launches++; return { done, stop: () => finish(143) } },
  })
  const first = service.start({ requestId: 'same-project-click', autoUpload: false })
  const duplicate = service.start({ requestId: 'same-project-click', autoUpload: false })
  const different = service.start({ requestId: 'another-project-click', autoUpload: false })
  const results = Promise.allSettled([first, duplicate, different])
  await new Promise<void>(resolve => setImmediate(resolve))
  ready({ ready: true, message: 'ready' })
  try {
    const [one, two, three] = await results
    assert.equal(one!.status, 'fulfilled'); assert.equal(two!.status, 'fulfilled')
    if (one!.status === 'fulfilled' && two!.status === 'fulfilled') {
      assert.equal(one.value.run.id, two.value.run.id); assert.equal(two.value.reused, true)
    }
    assert.equal(three!.status, 'rejected')
    if (three!.status === 'rejected') assert.match(String(three.reason), /已有任务/)
    assert.equal(service.overview().runs.length, 1)
  } finally {
    finish(0); await service.waitForIdle()
  }
  assert.equal(launches, 1)
})

test('CBA finishes one news project before starting the next project', async t => {
  let root: string, finish!: () => void, started!: () => void
  const firstStarted = new Promise<void>(resolve => { started = resolve })
  const firstFinished = new Promise<void>(resolve => { finish = resolve })
  const secondId = `${jobId}-news-second`, produced: string[] = []
  const f = await fixture(t, {
    launch: prompt => {
      const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
      const directory = path.join(root, 'batches', runId); fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [
        { url: 'https://example.com/news', title: '第一条', status: 'researched', jobDir: path.join(root, jobId) },
        { url: 'https://example.com/second', title: '第二条', status: 'researched', jobDir: path.join(root, secondId) },
      ] }))
      return { done: Promise.resolve(0), stop() {} }
    },
    pipeline: async directory => {
      produced.push(path.basename(directory))
      if (produced.length === 1) { started(); await firstFinished }
      return { ready: false, stage: 'writing', message: '离线测试：本任务已结束' }
    },
  }); root = f.root
  const secondJob = structuredClone(f.job)
  secondJob.match.seedUrls = ['https://example.com/second']
  fs.mkdirSync(path.join(root, secondId))
  fs.writeFileSync(path.join(root, secondId, 'job.json'), JSON.stringify(secondJob))
  await f.service.start({ requestId: 'serial-news-projects', autoUpload: false })
  await firstStarted
  try {
    assert.deepEqual(produced, [jobId], 'the second project must wait for the first pipeline to finish')
    await assert.rejects(f.service.start({ requestId: 'parallel-batch', autoUpload: false }), /已有任务/)
  } finally { finish(); await f.service.waitForIdle() }
  assert.deepEqual(produced, [jobId, secondId])
})

test('resume queue freezes existing unfinished jobs, inherits each policy and continues after failure without a homepage scan', async t => {
  const produced: string[] = [], uploads: SocialUploadPayload[] = []
  const failedId = `${jobId}-news-broken`, localId = `${jobId}-news-local`
  const f = await fixture(t, {
    captureHomepage: async () => { assert.fail('existing queue must never scan the homepage') },
    productionCheck: async () => { assert.fail('queue admission must not launch a model probe') },
    pipeline: async (directory, _runId, deps) => {
      produced.push(path.basename(directory))
      if (path.basename(directory) === failedId) throw Error('模拟编辑失败')
      const failure = await deps.verifyDelivery()
      return { ready: !failure, stage: 'rendering', message: failure?.message || 'ready' }
    },
    runtime: runtime({ runSocialUpload: async payload => { uploads.push(payload); return receipt(payload) } }),
  })
  for (const [id, url] of [[failedId, 'https://example.com/broken'], [localId, 'https://example.com/local']]) {
    const copy = structuredClone(f.job); copy.match.seedUrls = [url]; copy.status = 'needs_edit'; copy.outputs = null
    fs.mkdirSync(path.join(f.root, id!)); fs.writeFileSync(path.join(f.root, id!, 'job.json'), JSON.stringify(copy))
  }
  const stateFile = path.join(f.root, '.console.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, settings: { autoUpload: true, targets: ['tencent-video'], baijiahaoAccountName: 'cba_second' }, uploads: [], runs: [
    { id: 'old-upload', kind: 'production', status: 'attention', jobIds: [jobId, failedId], autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first', baijiahaoAccountLabel: '第一账号', logs: [] },
    { id: 'old-local', kind: 'resume', status: 'attention', jobId: localId, jobIds: [localId], autoUpload: false, targets: ['tencent-video'], logs: [] },
  ] }))
  const preview = f.service.resumeQueuePreview()
  assert.equal(preview.total, 3)
  assert.equal(preview.items.find(item => item.id === jobId)?.action, 'upload')
  const queued = await f.service.startResumeQueue({ requestId: 'resume-existing-three', jobIds: [failedId, jobId, localId] })
  await f.service.waitForIdle()
  assert.deepEqual(produced, [failedId, localId], 'valid existing video only resumes upload')
  assert.equal(uploads.length, 2)
  assert.ok(uploads.every(payload => payload.accountName === 'cba_first' && payload.target === 'baijiahao-video'))
  const queue = f.service.overview().resumeQueue!
  assert.equal(queue.id, queued.queue.id); assert.equal(queue.total, 3); assert.equal(queue.processed, 3)
  assert.equal(queue.completed, 1); assert.equal(queue.failed, 2); assert.equal(queue.pending, 0)
  assert.equal(queue.status, 'attention')
  assert.match(queue.items[0]!.message, /模拟编辑失败/)
  assert.equal(f.service.detail(jobId).status, 'completed')
  assert.equal(f.service.detail(localId).autoUpload, false)
  assert.deepEqual(f.service.overview().settings, { autoUpload: true, targets: ['tencent-video'], baijiahaoAccountName: 'cba_second' })
  const repeated = await f.service.startResumeQueue({ requestId: 'resume-existing-three', jobIds: [failedId, jobId, localId] })
  assert.equal(repeated.reused, true); assert.equal(repeated.queue.id, queue.id)
  await assert.rejects(f.service.startResumeQueue({ requestId: 'resume-existing-three', jobIds: [localId] }), /请求编号/)
  assert.equal(f.service.resumeQueuePreview().items.some(item => item.id === jobId), false)
})

test('resume queue reflects recovered current-version receipts without changing failed history or accepting unrelated receipts', async t => {
  const f = await fixture(t, { runtime: runtime({ confirmSocialUpload: async () => { throw Error('save response timeout') } }) })
  const stateFile = path.join(f.root, '.console.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, settings: { autoUpload: true, targets: ['baijiahao-video'] }, uploads: [], runs: [
    { id: 'original-upload-policy', kind: 'production', status: 'attention', jobIds: [jobId], autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first', logs: [] },
  ] }))
  await f.service.startResumeQueue({ requestId: 'queue-upload-recovery', jobIds: [jobId] })
  await f.service.waitForIdle()
  assert.equal(f.service.overview().resumeQueue?.failed, 1)
  const restored = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(restored.runs.at(-1).status, 'attention')
  assert.equal(restored.uploads.length, 2)
  for (const upload of restored.uploads) { upload.status = 'saved'; upload.result = receipt(upload.payload, true) }
  fs.writeFileSync(stateFile, JSON.stringify(restored))
  const result = f.service.overview()
  assert.equal(result.jobs[0].status, 'completed')
  assert.equal(result.resumeCandidatesCount, 0)
  assert.equal(result.resumeQueue?.status, 'completed')
  assert.equal(result.resumeQueue?.completed, 1)
  assert.equal(result.resumeQueue?.failed, 0)
  assert.equal(result.resumeQueue?.items[0]?.outcome, 'completed')
  assert.equal(result.resumeQueue?.items[0]?.status, 'attention', 'the result does not rewrite the historical run status')
  assert.match(result.resumeQueue?.items[0]?.message || '', /恢复|核验/)
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).runs.at(-1).status, 'attention', 'historical run is preserved')
  for (const [name, alter] of Object.entries({
    'another account': (state: any) => { state.uploads[0].accountName = 'cba_second' },
    'old version': (state: any) => { state.uploads[0].inputDigest = 'old-version' },
    'another run': (state: any) => { state.uploads[0].ownerRunId = 'another-run' },
    'unconfirmed save': (state: any) => { state.uploads[0].result.saved = false },
    'published response': (state: any) => { state.uploads[0].result.published = true },
    'missing edition': (state: any) => { state.uploads.pop() },
    'invalid output': (state: any) => { state.validationFailures = { [jobId]: { stage: 'rendering', message: 'invalid output' } } },
    'stopped run': (state: any) => { state.runs.at(-1).status = 'stopped'; state.resumeQueues[0].stoppedAt = new Date().toISOString() },
  })) {
    const state = structuredClone(restored); alter(state); fs.writeFileSync(stateFile, JSON.stringify(state))
    assert.equal(f.service.overview().resumeQueue?.completed, 0, name)
  }
})

test('busy uploads are waiting results only for the original account, run and current delivery', async t => {
  const f = await fixture(t, { runtime: runtime({ inspectSocialUploadCheckpoint: async () => ({ action: 'busy', phase: 'busy', message: '另一项上传正在运行' }) }) })
  const stateFile = path.join(f.root, '.console.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, settings: { autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first' }, uploads: [], runs: [
    { id: 'original-policy', kind: 'production', status: 'attention', jobIds: [jobId], autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first', logs: [] },
  ] }))
  await f.service.startResumeQueue({ requestId: 'busy-result', jobIds: [jobId] })
  await f.service.waitForIdle()
  const original = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const queue = f.service.overview().resumeQueue!
  assert.equal(queue.processed, 1); assert.equal(queue.completed, 0); assert.equal(queue.waitingUpload, 1); assert.equal(queue.failed, 0)
  assert.equal(queue.status, 'waiting_upload'); assert.equal(queue.items[0]!.outcome, 'waiting_upload')
  assert.equal(queue.items[0]!.status, 'attention'); assert.equal(queue.items[0]!.stage, 'uploading')
  assert.deepEqual(queue.items[0]!.resolvedJobIds, [jobId])
  assert.match(queue.items[0]!.message, /成片.*等待上传/)
  for (const [name, alter] of Object.entries({
    'another account': (s: any) => { s.uploads[0].accountName = 'cba_second' },
    'another run': (s: any) => { s.uploads[0].ownerRunId = 'another-run' },
    'old version': (s: any) => { s.uploads[0].inputDigest = 'old' },
    'missing edition': (s: any) => { s.uploads.pop() },
    'blocked': (s: any) => { s.uploads[0].status = 'blocked' },
    'uncertain': (s: any) => { s.uploads[0].status = 'uncertain' },
    'failed': (s: any) => { s.uploads[0].status = 'failed' },
    'invalid delivery': (s: any) => { s.validationFailures = { [jobId]: { message: 'invalid delivery', stage: 'rendering' } } },
  })) {
    const state = structuredClone(original); alter(state); fs.writeFileSync(stateFile, JSON.stringify(state))
    assert.equal(f.service.overview().resumeQueue?.waitingUpload, 0, name)
    assert.equal(f.service.overview().resumeQueue?.failed, 1, name)
  }
})

test('a rendered queue item exposes its actual upload failure in the run and queue without claiming completion', async t => {
  const checkpoint = new Set<string>()
  const f = await fixture(t, { runtime: runtime({
    inspectSocialUploadCheckpoint: async payload => checkpoint.has(payload.jobId)
      ? { action: 'resume', phase: 'initializing', message: '尚未传入素材' }
      : { action: 'upload', phase: 'new', message: 'new' },
    runSocialUpload: async payload => { checkpoint.add(payload.jobId); throw Error('百家号视频上传控件未就绪，尚未传入素材') },
  }) })
  const stateFile = path.join(f.root, '.console.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, settings: { autoUpload: true, targets: ['baijiahao-video'] }, uploads: [], runs: [
    { id: 'original-policy', kind: 'production', status: 'attention', jobIds: [jobId], autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first', logs: [] },
  ] }))
  await f.service.startResumeQueue({ requestId: 'initialization-failure-detail', jobIds: [jobId] })
  await f.service.waitForIdle()
  const overview = f.service.overview(), row = overview.resumeQueue!.items[0]!
  assert.equal(overview.resumeQueue!.failed, 1); assert.equal(overview.resumeQueue!.completed, 0)
  assert.match(row.message, /成片已就绪.*百家号.*上传控件未就绪/)
  assert.match(overview.runs[0]!.message, /百家号.*上传控件未就绪/)
  assert.ok(f.service.detail(jobId).news, 'upload failure must retain the local video')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.runs.at(-1).message = '本轮已结束，部分任务需要处理；已完成结果已保留'
  for (const upload of state.uploads) {
    upload.status = 'uncertain'; upload.message = '上次写入结果尚未确认，已读取原检查点，不重复上传或保存'
  }
  fs.writeFileSync(stateFile, JSON.stringify(state))
  assert.match(f.service.overview().resumeQueue!.items[0]!.message, /成片已就绪.*上传控件未就绪/, 'old generic runs still use their recorded upload error')
})

test('pending uploads recover between serial queue projects and do not block the next project on busy', async t => {
  const events: string[] = [], checks = new Map<string, number>(), laterId = `${jobId}-later`
  let service: CbaVideoService
  const f = await fixture(t, { autoRecover: true,
    runtime: runtime({ inspectSocialUploadCheckpoint: async payload => {
      const count = (checks.get(payload.jobId) || 0) + 1; checks.set(payload.jobId, count)
      events.push(count === 1 ? 'initial-busy' : 'recovery')
      if (count === 1) return { action: 'busy', phase: 'busy', message: '另一项上传正在运行' }
      assert.equal(service.overview().activeRun, null, 'recovery must run outside the active production project')
      return { action: 'complete', phase: 'saved', message: '原草稿', result: receipt(payload, true) }
    } }),
    pipeline: async () => { events.push('next-project'); throw Error('后续独立项目失败') },
  })
  service = f.service
  t.after(() => { (service as any).options.autoRecover = false; clearTimeout((service as any).recoveryTimer) })
  const later = structuredClone(f.job); later.match.seedUrls = ['https://example.com/later']; later.status = 'needs_edit'; later.outputs = null
  fs.mkdirSync(path.join(f.root, laterId)); fs.writeFileSync(path.join(f.root, laterId, 'job.json'), JSON.stringify(later))
  fs.writeFileSync(path.join(f.root, '.console.json'), JSON.stringify({ version: 1, settings: { autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first' }, uploads: [], runs: [
    { id: 'original-policy', kind: 'production', status: 'attention', jobIds: [jobId], autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first', logs: [] },
  ] }))
  await service.startResumeQueue({ requestId: 'recover-at-boundary', jobIds: [jobId, laterId] })
  await service.waitForIdle()
  assert.deepEqual(events, ['initial-busy', 'initial-busy', 'recovery', 'next-project', 'recovery'], 'give one pending upload a turn before the next project')
  const queue = service.overview().resumeQueue!
  assert.equal(queue.completed, 1); assert.equal(queue.failed, 1); assert.equal(queue.waitingUpload, 0); assert.equal(queue.processed, 2)
})

test('shared upload lock defers without spending the recovery budget and a stopped queue cancels later recovery', async t => {
  let checks = 0, projects = 0
  const laterId = `${jobId}-busy-tail`
  const f = await fixture(t, { autoRecover: true,
    runtime: runtime({ inspectSocialUploadCheckpoint: async () => { checks++; return { action: 'busy', phase: 'busy', message: '另一项上传正在运行' } } }),
    pipeline: async () => { projects++; throw Error('本条失败但继续') },
  })
  t.after(() => { (f.service as any).options.autoRecover = false; clearTimeout((f.service as any).recoveryTimer) })
  const later = structuredClone(f.job); later.match.seedUrls = ['https://example.com/busy-tail']; later.status = 'needs_edit'; later.outputs = null
  fs.mkdirSync(path.join(f.root, laterId)); fs.writeFileSync(path.join(f.root, laterId, 'job.json'), JSON.stringify(later))
  const stateFile = path.join(f.root, '.console.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, settings: { autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first' }, uploads: [], runs: [
    { id: 'original-policy', kind: 'production', status: 'attention', jobIds: [jobId], autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first', logs: [] },
  ] }))
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const { queue } = await f.service.startResumeQueue({ requestId: 'busy-budget', jobIds: [jobId, laterId] })
  await f.service.waitForIdle()
  assert.equal(projects, 1, 'a busy upload must not stop the next queued project')
  for (let retry = 0; retry < 4; retry++) {
    const before = checks
    t.mock.timers.tick(60_000); await f.service.waitForIdle()
    assert.equal(checks, before + 1, 'one busy checkpoint defers the remaining uploads')
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.ok(state.uploads.every((upload: any) => !upload.recoveryCount && upload.status === 'queued' && !upload.dispatched))
  }
  f.service.stopResumeQueue(queue.id)
  const beforeStop = checks
  t.mock.timers.tick(60_000); await f.service.waitForIdle()
  assert.equal(checks, beforeStop, 'stopping a queue also stops recovery of its waiting uploads')
})

test('stopping while a recovery checkpoint is in flight prevents upload and leaves the next project stopped', async t => {
  let finishCheckpoint!: () => void, entered!: () => void, projects = 0
  const checkpointStarted = new Promise<void>(resolve => { entered = resolve })
  const checkpointWait = new Promise<void>(resolve => { finishCheckpoint = resolve })
  const checks = new Map<string, number>(), laterId = `${jobId}-stop-during-recovery`
  const f = await fixture(t, { autoRecover: true,
    runtime: runtime({
      inspectSocialUploadCheckpoint: async payload => {
        const count = (checks.get(payload.jobId) || 0) + 1; checks.set(payload.jobId, count)
        if (count === 1) return { action: 'busy', phase: 'busy', message: '另一项上传正在运行' }
        entered(); await checkpointWait
        return { action: 'upload', phase: 'new', message: '允许首次上传' }
      },
      runSocialUpload: async () => { assert.fail('stop during checkpoint must prevent dispatch') },
      confirmSocialUpload: async () => { assert.fail('stop during checkpoint must prevent save') },
    }),
    pipeline: async () => { projects++; throw Error('must not start the tail') },
  })
  t.after(() => { (f.service as any).options.autoRecover = false; clearTimeout((f.service as any).recoveryTimer) })
  const later = structuredClone(f.job); later.match.seedUrls = ['https://example.com/stop-recovery']; later.status = 'needs_edit'; later.outputs = null
  fs.mkdirSync(path.join(f.root, laterId)); fs.writeFileSync(path.join(f.root, laterId, 'job.json'), JSON.stringify(later))
  const stateFile = path.join(f.root, '.console.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, settings: { autoUpload: true, targets: ['baijiahao-video'] }, uploads: [], runs: [
    { id: 'original-policy', kind: 'production', status: 'attention', jobIds: [jobId], autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first', logs: [] },
  ] }))
  const { queue } = await f.service.startResumeQueue({ requestId: 'stop-during-recovery', jobIds: [jobId, laterId] })
  await checkpointStarted
  try { f.service.stopResumeQueue(queue.id) } finally { finishCheckpoint() }
  await f.service.waitForIdle()
  const result = f.service.overview().resumeQueue!
  assert.equal(projects, 0); assert.equal(result.status, 'stopped'); assert.equal(result.items[1]!.status, 'stopped')
  assert.match(result.items[0]!.message, /队列已停止/)
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.ok(state.uploads.every((upload: any) => !upload.dispatched && !upload.recoveryCount))
})

test('resume queue waits behind current production, survives page/service observers and marks only the current job running', async t => {
  let finish!: () => void, entered!: () => void
  const running = new Promise<void>(resolve => { entered = resolve })
  const done = new Promise<void>(resolve => { finish = resolve })
  const laterId = `${jobId}-news-queued`, produced: string[] = []
  const f = await fixture(t, { pipeline: async directory => {
    const id = path.basename(directory); produced.push(id)
    if (id === jobId) { entered(); await done }
    return { ready: false, stage: 'writing', message: '测试未完成' }
  } })
  f.job.status = 'needs_edit'; f.job.outputs = null; f.writeJob()
  const later = structuredClone(f.job); later.match.seedUrls = ['https://example.com/queued']
  fs.mkdirSync(path.join(f.root, laterId)); fs.writeFileSync(path.join(f.root, laterId, 'job.json'), JSON.stringify(later))
  const original = await f.service.resume(jobId, { requestId: 'existing-running' }); await running
  try {
    const queued = await f.service.startResumeQueue({ requestId: 'queue-behind-current', jobIds: [laterId] })
    assert.equal(queued.queue.status, 'queued')
    assert.equal(f.service.overview().activeRun?.id, original.run.id)
    assert.equal(f.service.detail(laterId).status, 'queued')
    assert.deepEqual(produced, [jobId])
    const observer = new CbaVideoService({ root: f.root, autoRecover: false })
    assert.equal(observer.overview().resumeQueue?.id, queued.queue.id)
    await assert.rejects(f.service.startResumeQueue({ requestId: 'second-queue', jobIds: [laterId] }), /续做队列/)
  } finally { finish(); await f.service.waitForIdle() }
  assert.deepEqual(produced, [jobId, laterId])
  assert.equal(f.service.overview().resumeQueue?.status, 'attention')
})

test('stopping a waiting resume queue preserves remaining tasks and does not stop unrelated current production', async t => {
  let finish!: () => void, entered!: () => void
  const running = new Promise<void>(resolve => { entered = resolve }), done = new Promise<void>(resolve => { finish = resolve })
  const laterId = `${jobId}-news-stopped`, produced: string[] = []
  const f = await fixture(t, { pipeline: async directory => {
    produced.push(path.basename(directory)); entered(); await done
    return { ready: false, stage: 'writing', message: '测试未完成' }
  } })
  f.job.status = 'needs_edit'; f.job.outputs = null; f.writeJob()
  const later = structuredClone(f.job); later.match.seedUrls = ['https://example.com/stopped']
  fs.mkdirSync(path.join(f.root, laterId)); fs.writeFileSync(path.join(f.root, laterId, 'job.json'), JSON.stringify(later))
  const original = await f.service.resume(jobId, { requestId: 'running-before-stop-queue' }); await running
  try {
    const queued = await f.service.startResumeQueue({ requestId: 'queue-to-stop', jobIds: [laterId] })
    f.service.stopResumeQueue(queued.queue.id)
    assert.equal(f.service.overview().resumeQueue?.status, 'stopped')
    assert.equal(f.service.overview().activeRun?.id, original.run.id)
    assert.equal(f.service.overview().activeRun?.status, 'running')
    assert.ok(f.service.resumeQueuePreview().items.some(item => item.id === laterId))
  } finally { finish(); await f.service.waitForIdle() }
  assert.deepEqual(produced, [jobId])
})

test('resume queue only researches selected historical intake URLs and deduplicates equal primary reports', async t => {
  const prompts: string[] = []
  const f = await fixture(t, {
    captureHomepage: async () => { assert.fail('no new homepage in resume queue') },
    launch: prompt => { prompts.push(prompt); return { done: Promise.resolve(0), stop() {} } },
  })
  const dir = path.join(f.root, 'batches', 'historical'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'intake.json'), JSON.stringify({ items: [
    { url: 'https://example.com/old-story', title: '中断旧新闻', status: 'needs_research' },
    { url: 'https://example.com/skip', title: '已跳过', status: 'skipped' },
  ] }))
  const initial = f.service.resumeQueuePreview()
  assert.equal(initial.total, 1, 'completed local-only videos and skipped rows are excluded')
  const queued = await f.service.startResumeQueue({ requestId: 'resume-old-intake', jobIds: [initial.items[0]!.id] })
  await f.service.waitForIdle()
  assert.equal(prompts.length, 1); assert.match(prompts[0]!, /https:\/\/example.com\/old-story/)
  assert.match(prompts[0]!, /仅处理所选新闻/)
  assert.equal(f.service.overview().resumeQueue?.id, queued.queue.id)
  assert.equal(f.service.overview().resumeQueue?.failed, 1)
  f.job.status = 'needs_edit'; f.job.outputs = null; f.writeJob()
  const duplicateId = `${jobId}-duplicate`; fs.mkdirSync(path.join(f.root, duplicateId))
  fs.writeFileSync(path.join(f.root, duplicateId, 'job.json'), JSON.stringify(f.job))
  assert.equal(f.service.resumeQueuePreview().items.filter(item => item.sourceUrl === 'https://example.com/news').length, 1)
  await assert.rejects(f.service.startResumeQueue({ requestId: 'unknown', jobIds: ['unknown-job'] }), /不可续做|不存在/)
})

test('stopping an active resume queue cancels its model and leaves unstarted items available for the next explicit queue', async t => {
  let finish!: (code: number) => void, entered!: () => void, modelCalls = 0
  const done = new Promise<number>(resolve => { finish = resolve }), running = new Promise<void>(resolve => { entered = resolve })
  const laterId = `${jobId}-news-stop-tail`, produced: string[] = []
  const f = await fixture(t, {
    launch: () => { modelCalls++; entered(); return { done, stop: () => finish(143) } },
    pipeline: async (directory, _runId, deps) => {
      produced.push(path.basename(directory)); await deps.edit('停止测试')
      return { ready: false, stage: 'writing', message: '未完成' }
    },
  })
  f.job.status = 'needs_edit'; f.job.outputs = null; f.writeJob()
  const later = structuredClone(f.job); later.match.seedUrls = ['https://example.com/stop-tail']
  fs.mkdirSync(path.join(f.root, laterId)); fs.writeFileSync(path.join(f.root, laterId, 'job.json'), JSON.stringify(later))
  const queued = await f.service.startResumeQueue({ requestId: 'active-queue-stop', jobIds: [jobId, laterId] })
  await running
  f.service.stop(f.service.overview().activeRun!.id)
  await f.service.waitForIdle()
  const queue = f.service.overview().resumeQueue!
  assert.equal(queue.id, queued.queue.id); assert.equal(queue.status, 'stopped')
  assert.equal(queue.stopped, 2); assert.equal(queue.processed, 0)
  assert.deepEqual(produced, [jobId]); assert.equal(modelCalls, 1)
  assert.equal(f.service.resumeQueuePreview().total, 2)
})

test('service restart preserves unfinished resume queue scope without automatically starting model or upload work', async t => {
  const f = await fixture(t)
  f.job.status = 'needs_edit'; f.job.outputs = null; f.writeJob()
  const queued = await f.service.startResumeQueue({ requestId: 'queue-before-crash', jobIds: [jobId] }); await f.service.waitForIdle()
  const stateFile = path.join(f.root, '.console.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.runs.at(-1).status = 'queued'; state.runs.at(-1).ownerPid = -1
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const restored = new CbaVideoService({ root: f.root, autoRecover: false, alive: () => false,
    launch: () => { assert.fail('restart must wait for the user to resume production') },
  })
  assert.equal(restored.overview().activeRun, null)
  assert.equal(restored.overview().resumeQueue?.id, queued.queue.id)
  assert.equal(restored.overview().resumeQueue?.status, 'queued')
  assert.equal(restored.overview().resumeQueue?.pending, 1)
  assert.equal(restored.overview().resumeQueue?.failed, 0)
  assert.deepEqual(restored.resumeQueuePreview().items.map(item => item.id), [jobId])
})

test('a coordinator restart does not count undispatched queue items as failures', async t => {
  const f = await fixture(t)
  f.job.status = 'needs_edit'; f.job.outputs = null; f.writeJob()
  const stateFile = path.join(f.root, '.console.json')
  const queued = await f.service.startResumeQueue({ requestId: 'orphaned-queue', jobIds: [jobId] })
  await f.service.waitForIdle()
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const run = state.runs.find((item: any) => item.id === queued.queue.items[0]!.runId)
  run.status = 'attention'; run.message = '服务曾中断，已保留成果；继续前将核对原任务和上传回执'; run.ownerPid = 900001
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const restored = new CbaVideoService({ root: f.root, autoRecover: false, alive: () => false, launch: () => { assert.fail('restart must not auto-launch') } })
  const summary = restored.overview().resumeQueue!
  assert.equal(summary.pending, 1)
  assert.equal(summary.failed, 0)
  assert.equal(summary.items[0]!.outcome, 'pending')
  assert.match(summary.items[0]!.message, /尚未启动|继续/)
})

test('a stopped queue stays stopped while interrupted items remain pending and resumable', async t => {
  const f = await fixture(t)
  f.job.status = 'needs_edit'; f.job.outputs = null; f.writeJob()
  const queued = await f.service.startResumeQueue({ requestId: 'stopped-interrupted-queue', jobIds: [jobId] })
  await f.service.waitForIdle()
  const stateFile = path.join(f.root, '.console.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const run = state.runs.find((item: any) => item.id === queued.queue.items[0]!.runId)
  run.status = 'attention'; run.ownerPid = -1
  state.resumeQueues[0].stoppedAt = new Date().toISOString()
  for (const message of ['服务曾中断，当前任务尚未启动；继续队列可恢复', '服务曾中断，已保留成果；继续前将核对原任务和上传回执']) {
    run.message = message
    fs.writeFileSync(stateFile, JSON.stringify(state))
    const restored = new CbaVideoService({ root: f.root, autoRecover: false, alive: () => false,
      launch: () => { assert.fail('reading a stopped queue must not launch production') },
    })
    const overview = restored.overview(), summary = overview.resumeQueue!
    assert.equal(overview.activeRun, null)
    assert.equal(summary.status, 'stopped')
    assert.equal(summary.pending, 1)
    assert.equal(summary.failed, 0)
    assert.equal(summary.items[0]!.outcome, 'pending')
    assert.deepEqual(restored.resumeQueuePreview().items.map(item => item.id), [jobId])
  }
})

test('CBA isolates a rejected project and continues the serial queue through the next draft upload', async t => {
  for (const failurePoint of ['production', 'validation', 'model-retries'] as const) await t.test(failurePoint, async sub => {
    let root: string, modelCalls = 0
    const failedId = `${jobId}-news-failed`, produced: string[] = [], uploaded: string[] = []
    const f = await fixture(sub, {
      launch: (prompt, _message, options) => {
        if (options?.phase === 'editing') {
          modelCalls++
          return { done: Promise.resolve(1), failureMessage: () => '模型服务请求频率受限', stop() {} }
        }
        const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
        const directory = path.join(root, 'batches', runId); fs.mkdirSync(directory, { recursive: true })
        fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [
          { url: 'https://example.com/failed', title: '失败新闻', status: 'researched', jobDir: path.join(root, failedId) },
          { url: 'https://example.com/news', title: '下一条新闻', status: 'researched', jobDir: path.join(root, jobId) },
        ] }))
        return { done: Promise.resolve(0), stop() {} }
      },
      pipeline: async (directory, _runId, deps) => {
        const id = path.basename(directory); produced.push(id)
        if (id === failedId) {
          deps.progress('writing', '正在编辑失败新闻')
          if (failurePoint === 'production') throw Error('本条编辑意外退出；token=private-value')
          if (failurePoint === 'model-retries') await deps.edit('本条编辑持续遭遇限流')
        }
        return { ready: true, stage: 'rendering', message: 'ready' }
      },
      runtime: runtime({ runSocialUpload: async payload => { uploaded.push(payload.title); return receipt(payload) } }),
    }); root = f.root
    const failedJob = structuredClone(f.job)
    failedJob.match.seedUrls = ['https://example.com/failed']; failedJob.news.title = '失败新闻'
    failedJob.status = 'needs_edit'; failedJob.outputs = null
    fs.mkdirSync(path.join(root, failedId)); fs.writeFileSync(path.join(root, failedId, 'job.json'), JSON.stringify(failedJob))
    if (failurePoint === 'validation') {
      const validate = (f.service as any).validateDelivery.bind(f.service)
      sub.mock.method(f.service as any, 'validateDelivery', async (id: string) => {
        if (id === failedId) throw Error('本条成片核验意外退出；token=private-value')
        return validate(id)
      })
    }
    await f.service.start({ requestId: `continue-after-${failurePoint}`, targets: ['baijiahao-video'] }); await f.service.waitForIdle()
    assert.deepEqual(produced, [failedId, jobId])
    assert.equal(uploaded.length, 2, 'both editions of the next project must reach draft upload')
    assert.equal(f.service.detail(jobId).status, 'completed')
    const failed = f.service.detail(failedId)
    assert.equal(failed.status, 'attention'); assert.equal(failed.canResume, true)
    assert.match(failed.message, failurePoint === 'production' ? /编辑意外退出/ : failurePoint === 'validation' ? /核验意外退出/ : /连续3次未完成/)
    assert.equal(failed.stage, failurePoint === 'validation' ? 'rendering' : 'writing')
    assert.doesNotMatch(failed.message, /private-value/)
    if (failurePoint === 'model-retries') assert.equal(modelCalls, 3)
    const run = f.service.overview().runs[0]
    assert.equal(run.status, 'attention')
    assert.match(run.logs.join('\n'), /继续队列/)
  })
})

test('CBA cancellation during a rejected project stops the queue before the next project', async t => {
  let root: string, started!: () => void, reject!: (error: Error) => void
  const running = new Promise<void>(resolve => { started = resolve })
  const failed = new Promise<never>((_resolve, fail) => { reject = fail })
  const produced: string[] = [], secondId = `${jobId}-news-after-stop`
  const f = await fixture(t, {
    launch: prompt => {
      const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
      const directory = path.join(root, 'batches', runId); fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [
        { url: 'https://example.com/news', status: 'researched', jobDir: path.join(root, jobId) },
        { url: 'https://example.com/after-stop', status: 'researched', jobDir: path.join(root, secondId) },
      ] }))
      return { done: Promise.resolve(0), stop() {} }
    },
    pipeline: async directory => { produced.push(path.basename(directory)); started(); return failed },
  }); root = f.root
  const second = structuredClone(f.job); second.match.seedUrls = ['https://example.com/after-stop']
  fs.mkdirSync(path.join(root, secondId)); fs.writeFileSync(path.join(root, secondId, 'job.json'), JSON.stringify(second))
  const { run } = await f.service.start({ requestId: 'stop-rejected-project', autoUpload: false })
  await running
  try { f.service.stop(run.id) }
  finally { reject(Error('已停止当前步骤')); await f.service.waitForIdle() }
  assert.deepEqual(produced, [jobId])
  assert.equal(f.service.overview().runs[0].status, 'stopped')
})

test('CBA continues later research groups after exhausted retries and produces all established projects', async t => {
  let root: string, launches = 0
  const secondId = `${jobId}-news-later-group`, assignedGroups: string[][] = [], produced: string[] = []
  const snapshot = { entryUrl: 'https://cba.hupu.com/', retrievedAt: new Date().toISOString(), scope: '首页', total: 8,
    items: Array.from({ length: 8 }, (_, index) => ({ url: `https://example.com/story-${index}`, title: `新闻${index}` })) }
  const f = await fixture(t, {
    captureHomepage: async () => snapshot,
    launch: prompt => {
      launches++
      const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
      const assigned = JSON.parse(/仅研究本组 \d+ 条：(.*?)。读取/.exec(prompt)![1]!)
      assignedGroups.push(assigned.map((item: any) => item.url))
      const later = assigned.some((item: any) => item.url === snapshot.items[4]!.url)
      const items = assigned.map((item: any) => item.url === snapshot.items[0]!.url
        ? { ...item, status: 'researched', jobDir: path.join(root, jobId) }
        : item.url === snapshot.items[4]!.url ? { ...item, status: 'researched', jobDir: path.join(root, secondId) }
          : { ...item, status: later ? 'skipped' : 'discovered', reason: later ? '测试：跳过' : '' })
      fs.writeFileSync(path.join(root, 'batches', runId, 'intake.json'), JSON.stringify({ items }))
      return { done: Promise.resolve(later ? 0 : 1), failureMessage: () => '模型服务请求频率受限', stop() {} }
    },
    pipeline: async directory => { produced.push(path.basename(directory)); return { ready: false, stage: 'writing', message: '离线测试：保留稿件' } },
  }); root = f.root
  f.job.match.seedUrls = [snapshot.items[0]!.url]; f.job.outputs = null; f.job.status = 'needs_edit'; f.writeJob()
  const second = structuredClone(f.job); second.match.seedUrls = [snapshot.items[4]!.url]
  fs.mkdirSync(path.join(root, secondId)); fs.writeFileSync(path.join(root, secondId, 'job.json'), JSON.stringify(second))
  const { run } = await f.service.start({ requestId: 'continue-after-research-failure', autoUpload: false }); await f.service.waitForIdle()
  assert.equal(launches, 4, 'three bounded attempts for the failed group, then one attempt for the next group')
  assert.deepEqual(assignedGroups.at(-1), snapshot.items.slice(4).map(item => item.url))
  assert.deepEqual(produced, [jobId, secondId])
  const batch = JSON.parse(fs.readFileSync(path.join(root, 'batches', run.id, 'intake.json'), 'utf8'))
  assert.equal(batch.items.length, 8)
  for (const row of batch.items.slice(1, 4)) {
    assert.equal(row.status, 'needs_research'); assert.match(row.reason, /请求频率受限/)
  }
  assert.equal(f.service.overview().runs[0].status, 'attention')
})

test('each research group reaches production and its authorized drafts before the next group with refreshed footage inventory', async t => {
  const items = [{ url: 'https://example.com/news', title: '首条新闻' }, ...Array.from({ length: 7 }, (_, i) => ({ url: `https://example.com/group-${i}`, title: `其他新闻${i}` }))]
  let f: Awaited<ReturnType<typeof fixture>>, launches = 0
  const events: string[] = [], available: boolean[] = []
  let original: any
  f = await fixture(t, {
    captureHomepage: async () => ({ total: items.length, items }),
    launch: prompt => {
      launches++; events.push(`research:${launches}`)
      const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!, folder = path.join(f.root, 'batches', runId)
      const inventory = JSON.parse(fs.readFileSync(path.join(folder, 'match-library.json'), 'utf8'))
      available.push(inventory.matches.some((match: any) => match.footage.files.some((file: any) => file.available)))
      const assigned = JSON.parse(/仅研究本组 \d+ 条：(.*?)。读取/.exec(prompt)![1]!)
      fs.writeFileSync(path.join(folder, 'intake.json'), JSON.stringify({ items: assigned.map((item: any) => ({ ...item,
        status: item.url === items[0]!.url ? 'researched' : 'skipped', jobDir: item.url === items[0]!.url ? path.join(f.root, jobId) : null,
      })) }))
      return { done: Promise.resolve(0), stop() {} }
    },
    pipeline: async () => {
      events.push('produce')
      Object.assign(f.job, original); f.writeJob()
      return { ready: true, stage: 'rendering', message: 'ready' }
    },
    runtime: runtime({ confirmSocialUpload: async payload => { events.push('draft'); return receipt(payload, true) } }),
  })
  original = structuredClone(f.job)
  f.job.outputs = null; f.job.media = []; f.job.clips = []; f.job.status = 'needs_edit'; f.writeJob()
  const { run } = await f.service.start({ requestId: 'research-produce-groups', targets: ['baijiahao-video'] }); await f.service.waitForIdle()
  assert.deepEqual(events, ['research:1', 'produce', 'draft', 'draft', 'research:2'])
  assert.deepEqual(available, [false, true], 'the next group sees newly acquired and verified footage')
  assert.equal(f.service.overview().runs[0].status, 'completed')
  assert.deepEqual(f.service.overview().runs[0].jobIds, [jobId])
  const intake = JSON.parse(fs.readFileSync(path.join(f.root, 'batches', run.id, 'intake.json'), 'utf8'))
  assert.equal(intake.items.length, 8)
  assert.equal(f.service.overview().intakeCoverage?.processed, 8)
})

test('stop or a shared model failure during group production prevents research of the next group', async t => {
  for (const interruption of ['stop', 'quota'] as const) await t.test(interruption, async sub => {
    const items = [{ url: 'https://example.com/news' }, ...Array.from({ length: 7 }, (_, i) => ({ url: `https://example.com/unstarted-${i}` }))]
    let f: Awaited<ReturnType<typeof fixture>>, researchCalls = 0, productions = 0
    f = await fixture(sub, {
      captureHomepage: async () => ({ total: items.length, items }),
      launch: (prompt, _message, options) => {
        if (options?.phase === 'editing') return { done: Promise.resolve(1), failureMessage: () => '模型服务额度不足', stop() {} }
        researchCalls++
        const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!, file = path.join(f.root, 'batches', runId, 'intake.json')
        const intake = JSON.parse(fs.readFileSync(file, 'utf8'))
        intake.items.slice(0, 4).forEach((item: any, index: number) => Object.assign(item, { status: index ? 'skipped' : 'researched', jobDir: index ? null : path.join(f.root, jobId) }))
        if (researchCalls > 1) intake.items.slice(4).forEach((item: any) => { item.status = 'skipped' })
        fs.writeFileSync(file, JSON.stringify(intake))
        return { done: Promise.resolve(0), stop() {} }
      },
      pipeline: async (_directory, runId, deps) => {
        productions++
        if (interruption === 'stop') f.service.stop(runId)
        else await deps.edit('测试额度耗尽')
        return { ready: false, stage: 'writing', message: '中断' }
      },
    })
    f.job.outputs = null; f.writeJob()
    const { run } = await f.service.start({ requestId: `group-${interruption}`, autoUpload: false }); await f.service.waitForIdle()
    assert.equal(researchCalls, 1); assert.equal(productions, 1)
    const result = f.service.overview().runs[0]
    assert.equal(result.status, interruption === 'stop' ? 'stopped' : 'attention')
    assert.equal(result.currentJobId, undefined)
    const intake = JSON.parse(fs.readFileSync(path.join(f.root, 'batches', run.id, 'intake.json'), 'utf8'))
    assert.equal(intake.items.length, 8)
    assert.ok(intake.items.slice(4).every((item: any) => interruption === 'stop' ? item.status === 'discovered' : item.status === 'pending' && /尚未研究/.test(item.reason)))
  })
})

test('different reports from later groups reuse the same match highlight without producing an earlier task twice', async t => {
  const secondId = `${jobId}-later-report`, items = Array.from({ length: 8 }, (_, index) => ({ url: `https://example.com/edition-${index}`, title: `新闻${index}` }))
  let f: Awaited<ReturnType<typeof fixture>>, outputs: any
  const produced: Array<{ id: string; editions: string[] }> = []
  f = await fixture(t, { captureHomepage: async () => ({ total: items.length, items }), launch: prompt => {
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!, file = path.join(f.root, 'batches', runId, 'intake.json')
    const assigned = JSON.parse(/仅研究本组 \d+ 条：(.*?)。读取/.exec(prompt)![1]!)
    fs.writeFileSync(file, JSON.stringify({ items: assigned.map((item: any) => ({ ...item,
      status: [items[0]!.url, items[4]!.url].includes(item.url) ? 'researched' : 'skipped',
      jobDir: item.url === items[0]!.url ? path.join(f.root, jobId) : item.url === items[4]!.url ? path.join(f.root, secondId) : null,
    })) }))
    return { done: Promise.resolve(0), stop() {} }
  }, pipeline: async directory => {
    const file = path.join(directory, 'job.json'), job = JSON.parse(fs.readFileSync(file, 'utf8'))
    produced.push({ id: path.basename(directory), editions: job.profile.editions })
    job.outputs = structuredClone(outputs); job.outputs.highlights.duration = 100; job.status = 'rendered'
    fs.writeFileSync(file, JSON.stringify(job))
    return { ready: true, stage: 'rendering', message: 'ready' }
  } })
  outputs = structuredClone(f.job.outputs)
  f.job.match.seedUrls = [items[0]!.url]; f.job.outputs = null; f.writeJob()
  const second = structuredClone(f.job); second.match.seedUrls = [items[4]!.url]
  fs.mkdirSync(path.join(f.root, secondId)); fs.writeFileSync(path.join(f.root, secondId, 'job.json'), JSON.stringify(second))
  // This test isolates orchestration; media and edition validity are covered by delivery tests.
  t.mock.method(f.service as any, 'validateDelivery', async () => null)
  await f.service.start({ requestId: 'cross-group-highlight', autoUpload: false, productionMode: 'both' }); await f.service.waitForIdle()
  assert.deepEqual(produced, [{ id: jobId, editions: ['news', 'highlights'] }, { id: secondId, editions: ['news'] }])
  assert.equal(f.service.overview().runs[0].status, 'completed')
  assert.deepEqual(f.service.overview().runs[0].jobIds, [jobId, secondId])
})

test('an unfinished highlight keeps its owner across groups and preserves that attempt while other news can proceed', async t => {
  for (const mode of ['both', 'highlights'] as const) await t.test(mode, async sub => {
    const secondId = `${jobId}-later-unfinished`, items = Array.from({ length: 8 }, (_, index) => ({ url: `https://example.com/pending-edition-${index}` }))
    let f: Awaited<ReturnType<typeof fixture>>
    const produced: Array<{ id: string; editions: string[] }> = []
    f = await fixture(sub, { captureHomepage: async () => ({ total: items.length, items }), launch: prompt => {
      const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!, file = path.join(f.root, 'batches', runId, 'intake.json')
      const assigned = JSON.parse(/仅研究本组 \d+ 条：(.*?)。读取/.exec(prompt)![1]!)
      fs.writeFileSync(file, JSON.stringify({ items: assigned.map((item: any) => ({ ...item,
        status: [items[0]!.url, items[4]!.url].includes(item.url) ? 'researched' : 'skipped',
        jobDir: item.url === items[0]!.url ? path.join(f.root, jobId) : item.url === items[4]!.url ? path.join(f.root, secondId) : null,
      })) }))
      return { done: Promise.resolve(0), stop() {} }
    }, pipeline: async directory => {
      const file = path.join(directory, 'job.json'), job = JSON.parse(fs.readFileSync(file, 'utf8'))
      produced.push({ id: path.basename(directory), editions: job.profile.editions })
      job.news.summary = '第一次制作已经保存的稿件'; fs.writeFileSync(file, JSON.stringify(job))
      return { ready: false, stage: 'writing', message: '测试保留未完成稿件' }
    } })
    f.job.match.seedUrls = [items[0]!.url]; f.job.outputs = null; f.writeJob()
    const second = structuredClone(f.job); second.match.seedUrls = [items[4]!.url]
    fs.mkdirSync(path.join(f.root, secondId)); fs.writeFileSync(path.join(f.root, secondId, 'job.json'), JSON.stringify(second))
    await f.service.start({ requestId: `pending-owner-${mode}`, autoUpload: false, productionMode: mode }); await f.service.waitForIdle()
    assert.deepEqual(produced, mode === 'both' ? [{ id: jobId, editions: ['news', 'highlights'] }, { id: secondId, editions: ['news'] }] : [{ id: jobId, editions: ['highlights'] }])
    assert.equal(JSON.parse(fs.readFileSync(f.jobFile, 'utf8')).news.summary, '第一次制作已经保存的稿件')
    assert.equal(f.service.overview().runs[0].status, 'attention')
  })
})

test('CBA saves both editions and reuses real receipts without another upload', async t => {
  const calls: SocialUploadPayload[] = []
  const { service } = await fixture(t, { runtime: runtime({ runSocialUpload: async (payload, options) => {
    assert.equal(options.saveDraft, false); calls.push(payload); return receipt(payload)
  } }) })
  await service.upload(jobId, { requestId: 'first-upload' }); await service.waitForIdle()
  assert.equal(calls.length, 4)
  assert.deepEqual(new Set(calls.map(item => item.target)), new Set(['tencent-video', 'baijiahao-video']))
  for (const payload of calls) {
    if (payload.target === 'baijiahao-video') {
      assert.deepEqual(payload.tags, ['#热爆趣创赛'])
      assert.equal(payload.description, payload.title, 'the bridge appends the selected topic to the original description')
    } else assert.equal(payload.tags, undefined)
  }
  assert.equal(service.overview().jobs[0].status, 'completed')
  assert.equal(service.overview().jobs[0].canResume, false)
  assert.equal(service.overview().jobs[0].canUpload, true)
  await service.upload(jobId, { requestId: 'second-upload' }); await service.waitForIdle()
  assert.equal(calls.length, 4)
  assert.equal(service.overview().runs[0].status, 'completed')
})

test('CBA preserves uncertain uploads and never blindly dispatches them again', async t => {
  let uploads = 0
  const { service } = await fixture(t, { runtime: runtime({ runSocialUpload: async () => { uploads++; throw Error('模拟上传响应丢失') } }) })
  await service.upload(jobId, { requestId: 'uncertain-first', targets: ['tencent-video'] }); await service.waitForIdle()
  assert.equal(uploads, 2)
  assert.equal(service.overview().jobs[0].uploads.every((item: any) => item.status === 'uncertain'), true)
  await service.upload(jobId, { requestId: 'uncertain-retry', targets: ['tencent-video'] }); await service.waitForIdle()
  assert.equal(uploads, 2)
  assert.equal(service.overview().runs[0].status, 'attention')
})

test('CBA can add another platform after completion while reusing the first platform receipts', async t => {
  const dispatched: string[] = []
  const { service } = await fixture(t, { runtime: runtime({ runSocialUpload: async payload => { dispatched.push(payload.target); return receipt(payload) } }) })
  await service.upload(jobId, { requestId: 'first-platform', targets: ['tencent-video'] }); await service.waitForIdle()
  assert.equal(service.overview().jobs[0].status, 'completed')
  assert.equal(service.overview().jobs[0].canUpload, true)
  await service.upload(jobId, { requestId: 'both-platforms', targets: ['tencent-video', 'baijiahao-video'] }); await service.waitForIdle()
  assert.deepEqual(dispatched, ['tencent-video', 'tencent-video', 'baijiahao-video', 'baijiahao-video'])
  assert.equal(service.overview().jobs[0].canResume, false)
})

test('CBA refuses missing or stale review and changed artifact bytes before upload', async t => {
  let uploads = 0
  const { service, job, writeJob } = await fixture(t, { runtime: runtime({ runSocialUpload: async payload => { uploads++; return receipt(payload) } }) })
  const review = job.review, approval = job.approval
  job.review = null; job.approval = null; writeJob()
  await service.upload(jobId, { requestId: 'missing-review' }); await service.waitForIdle()
  assert.equal(uploads, 0); assert.equal(service.overview().runs[0].status, 'attention')
  assert.equal(service.overview().jobs[0].status, 'attention')
  assert.equal(service.overview().jobs[0].canResume, true)
  assert.equal(service.overview().jobs[0].canUpload, false)
  assert.match(service.overview().jobs[0].message, /缺少当前有效核验/)
  job.review = review; job.approval = approval; job.news.summary = '已改写但尚未重新审核'; writeJob()
  await service.upload(jobId, { requestId: 'stale-review' }); await service.waitForIdle()
  assert.equal(uploads, 0)
  assert.match(service.overview().jobs[0].message, /原核验记录已失效/)
  job.news.summary = '南京赢得首胜。'; fs.appendFileSync(job.outputs.news.path, 'changed'); writeJob()
  await service.upload(jobId, { requestId: 'changed-artifact' }); await service.waitForIdle()
  assert.equal(uploads, 0)
  assert.match(service.overview().jobs[0].message, /新闻版视频与原文件校验记录不一致/)
  assert.equal(service.detail(jobId).timeline.find((item: any) => item.stage === 'rendering')?.status, 'attention')
})

test('CBA stop signals its active process and preserves the stopped run', async t => {
  let complete!: (code: number) => void, stopped = false, prompt = ''
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const done = new Promise<number>(resolve => { complete = resolve })
  const { service } = await fixture(t, { launch: input => {
    prompt = input; signalStarted(); return { done, stop: () => { stopped = true; complete(143) } }
  } })
  const { run } = await service.start({ requestId: 'start-stop', autoUpload: false, limit: 1 })
  await started
  service.stop(run.id); await service.waitForIdle()
  assert.equal(stopped, true); assert.equal(service.overview().runs[0].status, 'stopped')
  assert.match(prompt, /按新闻项目串行生产/)
  assert.match(prompt, /禁止派生子代理或另启 Codex/)
  assert.match(prompt, /禁止上传、保存平台草稿或公开发布/)
  assert.match(prompt, /不在预览处等待聊天确认/)
})

test('CBA duplicate news remains skipped rather than claiming uploaded completion', async t => {
  const { service, root } = await fixture(t)
  const directory = path.join(root, 'batches', 'test-batch'); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [{ url: 'https://example.com/another', title: '重复新闻', status: 'duplicate' }] }))
  const item = service.overview().jobs.find((job: any) => job.title === '重复新闻')
  assert.equal(item.status, 'skipped'); assert.equal(item.canResume, false)
})

test('CBA recovers interrupted production and marks upload results uncertain', async t => {
  const { service, root } = await fixture(t)
  await service.upload(jobId, { requestId: 'recovery-first', targets: ['tencent-video'] }); await service.waitForIdle()
  const stateFile = path.join(root, '.console.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.runs[0].status = 'running'; state.runs[0].ownerPid = -1; state.uploads[0].status = 'running'
  state.runs[0].modelAttempts = [{ id: 'interrupted-edit', phase: 'editing', attempt: 1, maxAttempts: 3, status: 'running', startedAt: new Date().toISOString() }]
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const restored = new CbaVideoService({ root, autoRecover: false, alive: () => false, runtime: runtime() })
  const result = restored.overview()
  assert.equal(result.activeRun, null); assert.equal(result.runs[0].status, 'attention')
  assert.equal(result.runs[0].modelAttempts?.[0]?.status, 'interrupted')
  assert.ok(result.runs[0].modelAttempts?.[0]?.finishedAt)
  assert.equal(result.jobs[0].uploads.some((item: any) => item.status === 'uncertain'), true)
})

test('CBA keeps a detached surviving executor active until it exits after a service restart', async t => {
  const { service, root } = await fixture(t, { launch: () => ({ done: Promise.resolve(0), stop() {} }) })
  const { run } = await service.start({ requestId: 'orphan-original', autoUpload: false }); await service.waitForIdle()
  const stateFile = path.join(root, '.console.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.runs[0].status = 'running'; state.runs[0].ownerPid = 900001; state.runs[0].childPid = 900002
  fs.writeFileSync(stateFile, JSON.stringify(state))
  let childRunning = true, launches = 0
  const restored = new CbaVideoService({ root, autoRecover: false, alive: pid => pid === process.pid || pid === 900002 && childRunning,
    captureHomepage: async () => null,
    productionCheck: async () => ({ ready: true, message: 'ready' }),
    launch: () => { launches++; return { done: Promise.resolve(0), stop() { assert.fail('must not signal persisted child PID') } } },
  })
  assert.equal(restored.overview().activeRun?.id, run.id)
  assert.match(restored.overview().activeRun?.message || '', /原执行器可能仍在工作/)
  await assert.rejects(restored.start({ requestId: 'orphan-new' }), /原执行器仍在执行/)
  assert.throws(() => restored.stop(run.id), /不能通过持久化进程编号停止/)
  assert.equal(launches, 0)
  childRunning = false
  assert.equal(restored.overview().activeRun, null)
  assert.equal(restored.overview().runs[0].status, 'attention')
  await restored.start({ requestId: 'orphan-new', autoUpload: false }); await restored.waitForIdle()
  assert.equal(launches, 1)
})

test('CBA resume inherits the job run policy without changing newer global preferences', async t => {
  let uploads = 0
  const { service, root, job, writeJob } = await fixture(t, { launch: () => ({ done: Promise.resolve(0), stop() {} }),
    runtime: runtime({ runSocialUpload: async payload => { uploads++; return receipt(payload) } }),
  })
  const { run: original } = await service.start({ requestId: 'original-production', autoUpload: false, targets: ['tencent-video'] }); await service.waitForIdle()
  const stateFile = path.join(root, '.console.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.runs[0].jobIds = [jobId]; fs.writeFileSync(stateFile, JSON.stringify(state))
  await service.start({ requestId: 'newer-production', autoUpload: true, targets: ['baijiahao-video'] }); await service.waitForIdle()
  job.status = 'waiting_for_media'; job.outputs = null; writeJob()
  const { run: resumed } = await service.resume(jobId, { requestId: 'resume-original' }); await service.waitForIdle()
  assert.equal(resumed.autoUpload, false)
  assert.deepEqual(resumed.targets, original.targets)
  assert.deepEqual(service.overview().settings, { autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first' })
  assert.equal(uploads, 0)
})

test('CBA resume of an intake item inherits its original batch upload policy', async t => {
  const { service, root } = await fixture(t, { launch: () => ({ done: Promise.resolve(0), stop() {} }) })
  const { run: original } = await service.start({ requestId: 'intake-original', autoUpload: false, targets: ['tencent-video'] }); await service.waitForIdle()
  const directory = path.join(root, 'batches', original.id); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [{ url: 'https://example.com/unmatched', title: '待匹配视频', status: 'waiting_for_media' }] }))
  await service.start({ requestId: 'intake-newer', autoUpload: true, targets: ['baijiahao-video'] }); await service.waitForIdle()
  const intake = service.overview().jobs.find((item: any) => item.title === '待匹配视频')
  assert.equal(intake.autoUpload, false)
  const { run } = await service.resume(intake.id, { requestId: 'resume-intake' }); await service.waitForIdle()
  assert.equal(run.autoUpload, false); assert.deepEqual(run.targets, ['tencent-video'])
})

test('unmatched single-game news has the same no-video message in list, detail and historical resume queue', async t => {
  const { service, root } = await fixture(t)
  const source = { url: 'https://bbs.hupu.com/643241097.html', title: '赵柏清社媒分享日常', status: 'needs_editorial_route', reason: '需要非单场新闻路线' }
  const originalDir = path.join(root, 'batches', 'original-social'); fs.mkdirSync(originalDir, { recursive: true })
  const originalFile = path.join(originalDir, 'intake.json'); fs.writeFileSync(originalFile, JSON.stringify({ items: [source] }))
  fs.utimesSync(originalFile, new Date('2026-10-24T12:00:00Z'), new Date('2026-10-24T12:00:00Z'))
  const original = service.overview().jobs.find(item => item.title === source.title)!
  assert.equal(original.message, '没有对应视频')
  assert.equal(original.noCorrespondingVideo, true)
  const laterDir = path.join(root, 'batches', 'social-resume'); fs.mkdirSync(laterDir, { recursive: true })
  fs.writeFileSync(path.join(laterDir, 'intake.json'), JSON.stringify({ items: [{ ...source, status: 'researched', reason: '该条是社媒日常，没有可核实的CBA单场比赛日期、双方或比分，无法关联具体比赛。' }] }))
  fs.writeFileSync(path.join(root, '.console.json'), JSON.stringify({ version: 1, settings: { autoUpload: false, targets: ['baijiahao-video'] }, uploads: [],
    runs: [{ id: 'social-resume', queueId: 'social-queue', jobId: original.id, jobIds: [], kind: 'resume', status: 'attention', autoUpload: false, targets: ['baijiahao-video'], message: '本轮已结束，部分任务需要处理；已完成结果已保留', logs: [] }],
    resumeQueues: [{ id: 'social-queue', items: [{ runId: 'social-resume', jobId: original.id, title: source.title }] }],
  }))
  const overview = service.overview(), row = overview.jobs.find(item => item.title === source.title)!
  assert.equal(row.message, '没有对应视频')
  assert.equal(service.detail(original.id).message, '没有对应视频')
  assert.equal(overview.resumeQueue?.items[0]?.message, '没有对应视频')
  assert.equal(overview.resumeQueue?.items[0]?.noCorrespondingVideo, true)
  assert.equal(overview.resumeQueue?.failed, 0)
  assert.equal(overview.resumeQueue?.noVideo, 1)
  assert.equal(overview.resumeQueue?.processed, 1)
  assert.equal(overview.resumeQueue?.items[0]?.outcome, 'no_video')
  assert.equal(overview.resumeQueue?.items[0]?.status, 'attention', 'history remains unchanged')
  fs.writeFileSync(path.join(laterDir, 'intake.json'), JSON.stringify({ items: [{ ...source, status: 'researched', matchId: null,
    videoCandidates: [{ url: 'https://example.com/training.mp4', kind: 'direct_social_video', verified: false }],
    reason: '正文未给出具体比赛日期、对手或比分；保留直接视频，后续需走非单场新闻编辑路线。' }] }))
  assert.equal(service.overview().resumeQueue?.items[0]?.outcome, 'no_video', 'a researched social video with an explicit null match is not a failed single-game production')
  for (const reason of ['咪咕赛事页访问受阻，暂时无法核实比赛身份', '模型服务请求频率受限', '本轮尚未取得素材']) {
    fs.writeFileSync(path.join(laterDir, 'intake.json'), JSON.stringify({ items: [{ ...source, status: 'waiting_for_media', reason }] }))
    assert.equal(service.overview().jobs.find(item => item.title === source.title)?.message, reason)
    assert.notEqual(service.overview().resumeQueue?.items[0]?.message, '没有对应视频')
  }
})

test('duplicate intake URLs share one current row while old IDs retain their original account policy', async t => {
  const prompts: string[] = []
  const { service, root } = await fixture(t, { launch: prompt => { prompts.push(prompt); return { done: Promise.resolve(0), stop() {} } } })
  const store = (runId: string, item: any, date: string) => {
    const directory = path.join(root, 'batches', runId); fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, 'intake.json'); fs.writeFileSync(file, JSON.stringify({ items: [item] }))
    fs.utimesSync(file, new Date(date), new Date(date)); return file
  }
  const { run: first } = await service.start({ requestId: 'dedupe-first', targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first' }); await service.waitForIdle()
  const firstFile = store(first.id, { url: 'http://bbs.hupu.com/643194086.html?utm_source=share#reply', title: '旧批次汇总新闻', status: 'needs_editorial_route', reason: '三轮战绩汇总，尚未确定视频创作方案。' }, '2026-10-23T10:00:00Z')
  const firstRow = service.overview().jobs.find((item: any) => item.id.startsWith('intake-'))
  const { run: second } = await service.start({ requestId: 'dedupe-second', targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_second' }); await service.waitForIdle()
  const secondFile = store(second.id, { sourceUrl: 'https://bbs.hupu.com/643194086.html/', title: '最新批次汇总新闻', status: 'needs_editorial_route', reason: '三轮战绩汇总，不对应单场比赛；需要先确定创作方案。' }, '2026-10-24T10:00:00Z')
  const before = [fs.readFileSync(firstFile, 'utf8'), fs.readFileSync(secondFile, 'utf8')]
  const rows = service.overview().jobs.filter((item: any) => item.id.startsWith('intake-'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, '最新批次汇总新闻')
  assert.equal(rows[0].sourceUrl, 'https://bbs.hupu.com/643194086.html')
  assert.equal(rows[0].baijiahaoAccountName, 'cba_second')
  assert.equal(rows[0].stage, 'writing'); assert.equal(rows[0].status, 'attention')
  assert.doesNotMatch(rows[0].message, /下载失败|未找到录像/)
  const oldDetail = service.detail(firstRow.id)
  assert.equal(oldDetail.id, rows[0].id)
  assert.equal(oldDetail.baijiahaoAccountName, 'cba_first', 'opening an old link cannot silently switch its account')
  const { run: resumed } = await service.resume(firstRow.id, { requestId: 'resume-old-alias' }); await service.waitForIdle()
  assert.equal(resumed.baijiahaoAccountName, 'cba_first')
  assert.match(prompts.at(-1)!, /仅处理所选新闻及其关联比赛/)
  assert.match(prompts.at(-1)!, /643194086\.html/)
  assert.equal(service.overview().runs[0].status, 'attention', 'deduplication must not claim unfinished work is completed')
  assert.deepEqual([fs.readFileSync(firstFile, 'utf8'), fs.readFileSync(secondFile, 'utf8')], before)
})

test('active intake wins over a newer duplicate and historical IDs remain readable', async t => {
  const { service, root } = await fixture(t, { launch: () => ({ done: Promise.resolve(0), stop() {} }) })
  const { run: first } = await service.start({ requestId: 'active-old-intake', autoUpload: false }); await service.waitForIdle()
  const firstDirectory = path.join(root, 'batches', first.id); fs.mkdirSync(firstDirectory, { recursive: true })
  fs.writeFileSync(path.join(firstDirectory, 'intake.json'), JSON.stringify({ items: [{ url: 'https://bbs.hupu.com/643194087.html', title: '正在处理的新闻', status: 'researching' }] }))
  const firstRow = service.overview().jobs.find((item: any) => item.id.startsWith('intake-'))
  const directory = path.join(root, 'batches', 'later-batch'); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [{ url: 'https://bbs.hupu.com/643194087.html?from=share', title: '后来的重复条目', status: 'duplicate' }] }))
  const stateFile = path.join(root, '.console.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.runs[0].status = 'running'; fs.writeFileSync(stateFile, JSON.stringify(state))
  const rows = service.overview().jobs.filter((item: any) => item.id.startsWith('intake-'))
  assert.equal(rows.length, 1); assert.equal(rows[0].id, firstRow.id); assert.equal(rows[0].status, 'running')
  const oldId = `intake-${createHash('sha256').update('later-batch:0:https://bbs.hupu.com/643194087.html?from=share').digest('hex').slice(0, 24)}`
  assert.equal(service.detail(oldId).id, firstRow.id)
})

test('an active discovery batch keeps decisions visible and only marks the assigned unfinished stories as running', async t => {
  const items = Array.from({ length: 7 }, (_, i) => ({ url: `https://example.com/progress-${i}`, title: `新闻${i}` }))
  let root: string, started!: () => void, finish!: (code: number) => void
  const running = new Promise<void>(resolve => { started = resolve })
  const done = new Promise<number>(resolve => { finish = resolve })
  const f = await fixture(t, { captureHomepage: async () => ({ entryUrl: 'test', total: items.length, items }), launch: prompt => {
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    const file = path.join(root, 'batches', runId, 'intake.json'), intake = JSON.parse(fs.readFileSync(file, 'utf8'))
    Object.assign(intake.items[0], { status: 'skipped', reason: '原文只有一句观赛消息，内容不足' })
    Object.assign(intake.items[1], { status: 'needs_editorial_route', reason: '转会消息不对应单场比赛' })
    fs.writeFileSync(file, JSON.stringify(intake)); started()
    return { done, stop: () => finish(143) }
  } }); root = f.root
  const { run } = await f.service.start({ requestId: 'live-intake-statuses', autoUpload: false, limit: 6 })
  await running
  try {
    const rows = items.map(item => f.service.overview().jobs.find((job: any) => job.sourceUrl === item.url))
    assert.deepEqual(rows.map(row => row.status), ['skipped', 'attention', 'running', 'running', 'queued', 'queued', 'pending'])
    assert.match(rows[0].message, /原文只有一句/)
    assert.match(rows[1].message, /没有对应视频|单场/)
    assert.ok(rows.every(row => row.canResume === false), 'the active batch still owns the pending scope')
    assert.equal(f.service.overview().intakeCoverage?.processed, 2)
  } finally { f.service.stop(run.id); await f.service.waitForIdle() }
})

test('batch production shows only the current job as running and keeps an earlier failure visible', async t => {
  const secondId = `${jobId}-second`, states: string[][] = []
  let f: Awaited<ReturnType<typeof fixture>>
  f = await fixture(t, {
    captureHomepage: async () => ({ total: 2, items: [{ url: 'https://example.com/news' }, { url: 'https://example.com/second' }] }),
    launch: prompt => {
      const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
      const file = path.join(f.root, 'batches', runId, 'intake.json'), intake = JSON.parse(fs.readFileSync(file, 'utf8'))
      intake.items.forEach((item: any, index: number) => Object.assign(item, { status: 'researched', jobDir: path.join(f.root, index ? secondId : jobId) }))
      fs.writeFileSync(file, JSON.stringify(intake))
      return { done: Promise.resolve(0), stop() {} }
    },
    pipeline: async () => {
      const overview = f.service.overview()
      states.push([jobId, secondId].map(id => overview.jobs.find((job: any) => job.id === id).status))
      return { ready: false, stage: 'finding_media', message: '测试素材获取失败' }
    },
  })
  f.job.outputs = null; f.job.status = 'waiting_for_media'; f.writeJob()
  const second = structuredClone(f.job); second.match.seedUrls = ['https://example.com/second']
  fs.mkdirSync(path.join(f.root, secondId)); fs.writeFileSync(path.join(f.root, secondId, 'job.json'), JSON.stringify(second))
  await f.service.start({ requestId: 'current-production-job', autoUpload: false }); await f.service.waitForIdle()
  assert.deepEqual(states, [['running', 'queued'], ['attention', 'running']])
})

test('a historical sourceUrl-only intake resolves to its existing job without rediscovery or account changes', async t => {
  let launches = 0; const produced: string[] = []
  const { service, root, job, writeJob } = await fixture(t, {
    launch: () => { launches++; return { done: Promise.resolve(0), stop() {} } },
    pipeline: async directory => { produced.push(directory); return { ready: false, stage: 'finding_media', message: '本轮尚未取得素材' } },
  })
  const { run } = await service.start({ requestId: 'sourceurl-original', targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first' }); await service.waitForIdle()
  const directory = path.join(root, 'batches', run.id); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [{ sourceUrl: 'https://example.com/news?utm_source=old#top', title: '旧入口', status: 'waiting_for_media' }] }))
  const oldId = `intake-${createHash('sha256').update(`${run.id}:0:undefined`).digest('hex').slice(0, 24)}`
  job.status = 'waiting_for_media'; job.outputs = null; job.media = []; writeJob()
  assert.equal(service.overview().jobs.length, 1)
  assert.equal(service.detail(oldId).id, jobId)
  const { run: resumed } = await service.resume(oldId, { requestId: 'resume-sourceurl-old' }); await service.waitForIdle()
  assert.equal(resumed.baijiahaoAccountName, 'cba_first')
  assert.equal(launches, 1, 'an existing linked job resumes the scoped pipeline directly')
  assert.deepEqual(produced, [path.join(root, jobId)])
})

test('the latest acquisition failure explains the media blocker without appending duplicate punctuation', async t => {
  const { service, root, job, writeJob } = await fixture(t)
  job.status = 'waiting_for_media'; job.outputs = null; job.media = []; delete job.mediaSearch
  job.mediaBlocker = '旧记录：未找到完整录像。'
  job.mediaAcquisition = { finishedAt: '2026-10-23T10:00:00Z', failure: { message: '旧下载失败。' } }; writeJob()
  const message = '已找到本场官方集锦，但旧任务要求完整回放，因此尚未下载。'
  fs.writeFileSync(path.join(root, jobId, 'media-acquisition.json'), JSON.stringify({ status: 'scope_mismatch', match: job.match, finishedAt: '2026-10-24T10:00:00Z', failure: { message } }))
  fs.writeFileSync(path.join(root, '.console.json'), JSON.stringify({ version: 1, settings: { autoUpload: false, targets: ['baijiahao-video'] }, runs: [], uploads: [], validationFailures: { [jobId]: { stage: 'rendering', message: '视频制作尚未完成', detectedAt: new Date().toISOString() } } }))
  const detail = service.detail(jobId)
  assert.equal(detail.stage, 'finding_media'); assert.equal(detail.status, 'attention')
  assert.equal(detail.message, message)
  assert.doesNotMatch(detail.message, /下载失败|尚未完成咪咕首页|。；|继续处理/)
})

test('CBA resume repairs a persisted validation failure through the scoped pipeline and keeps production-only policy', async t => {
  let fix: (() => void) | undefined, uploads = 0
  const produced: string[] = []
  const { service, root, job, writeJob } = await fixture(t, { launch: () => ({ done: Promise.resolve(0), stop() {} }),
    pipeline: async (directory, _runId, deps) => {
      produced.push(directory); fix?.()
      const failure = await deps.verifyDelivery()
      return { ready: !failure, stage: 'rendering', message: failure?.message || 'ready' }
    }, runtime: runtime({ runSocialUpload: async payload => { uploads++; return receipt(payload) } }) })
  const originalSummary = job.news.summary
  await service.start({ requestId: 'repair-original', autoUpload: false, targets: ['tencent-video'] }); await service.waitForIdle()
  const stateFile = path.join(root, '.console.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.runs[0].jobIds = [jobId]
  state.validationFailures = { [jobId]: { stage: 'writing', message: '文稿或镜头已变更，原核验记录已失效', detectedAt: new Date().toISOString() } }
  fs.writeFileSync(stateFile, JSON.stringify(state))
  job.news.summary = '旧文稿已被修改'; writeJob()
  fix = () => { job.news.summary = originalSummary; writeJob() }
  await service.resume(jobId, { requestId: 'repair-resume' }); await service.waitForIdle()
  assert.deepEqual(produced, [path.join(root, jobId)])
  assert.equal(service.overview().jobs[0].validationFailure, undefined)
  assert.equal(service.overview().jobs[0].status, 'ready')
  assert.equal(service.overview().jobs[0].canUpload, true)
  assert.equal(service.overview().jobs[0].canResume, false)
  assert.equal(uploads, 0)
})

test('CBA rejects old video when narration timing changes after rendering', async t => {
  let uploads = 0
  const { service, job, writeJob } = await fixture(t, { runtime: runtime({ runSocialUpload: async payload => { uploads++; return receipt(payload) } }) })
  const { editorialDigest } = await import(new URL('../../../scripts/cba-video/core.mjs', import.meta.url).href)
  const { renderInputDigest } = await import(new URL('../../../scripts/cba-video/cli.mjs', import.meta.url).href)
  job.news.segments = [{ id: 'opening', text: '新闻正文。', mode: 'narration', factIds: ['score'], clipIds: ['play'], audioDigest: { sha256: 'audio-v1', duration: 3, offsetSeconds: 0 } }]
  job.review.digest = editorialDigest(job); job.approval.digest = job.review.digest
  job.outputs.inputDigest = await renderInputDigest(job)
  job.news.segments[0].audioDigest.offsetSeconds = 2; writeJob()
  assert.equal(editorialDigest(job), job.approval.digest)
  await service.upload(jobId, { requestId: 'stale-audio-offset' }); await service.waitForIdle()
  assert.equal(uploads, 0)
  assert.equal(service.overview().jobs[0].canResume, true)
  assert.match(service.overview().jobs[0].message, /成片版本已过期/)
})

test('CBA leaves nonterminal intake work in attention even when executor exits successfully', async t => {
  let writeBatch: ((prompt: string) => void) | undefined
  const { service, root } = await fixture(t, { launch: prompt => { writeBatch?.(prompt); return { done: Promise.resolve(0), stop() {} } } })
  writeBatch = prompt => {
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    const directory = path.join(root, 'batches', runId); fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [{ url: 'https://example.com/researching', title: '研究尚未完成', status: 'researching' }] }))
  }
  await service.start({ requestId: 'unfinished-intake', autoUpload: false }); await service.waitForIdle()
  assert.equal(service.overview().runs[0].status, 'attention')
  assert.equal(service.overview().jobs.find((item: any) => item.title === '研究尚未完成').status, 'attention')
  assert.match(service.overview().runs[0].logs.join('\n'), /尚无可验证的完成结果/)
})

test('CBA only accepts rendered intake completion with a linked validated delivery', async t => {
  let writeBatch: ((prompt: string) => void) | undefined, validLink = false
  const { service, root } = await fixture(t, { launch: prompt => { writeBatch?.(prompt); return { done: Promise.resolve(0), stop() {} } } })
  writeBatch = prompt => {
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    const directory = path.join(root, 'batches', runId); fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [{ url: validLink ? 'https://example.com/news' : 'https://example.com/rendered', title: '声称成片', status: 'rendered', jobDir: path.join(root, validLink ? jobId : 'missing-job') }] }))
  }
  await service.start({ requestId: 'rendered-without-delivery', autoUpload: false }); await service.waitForIdle()
  assert.equal(service.overview().runs[0].status, 'attention')
  validLink = true
  await service.start({ requestId: 'rendered-linked-delivery', autoUpload: false }); await service.waitForIdle()
  assert.equal(service.overview().runs[0].status, 'completed')
  assert.deepEqual(service.overview().runs[0].jobIds, [jobId])
})

test('discovery cannot select an unrelated task merely because its job file changed', async t => {
  let discover: ((prompt: string) => void) | undefined
  const produced: string[] = []
  const { service, root, job } = await fixture(t, {
    launch: prompt => { discover?.(prompt); return { done: Promise.resolve(0), stop() {} } },
    pipeline: async directory => { produced.push(directory); return { ready: true, stage: 'rendering', message: 'ready' } },
  })
  const unrelatedId = '2026-10-19-another-game', unrelatedDirectory = path.join(root, unrelatedId)
  fs.mkdirSync(unrelatedDirectory)
  const unrelated = structuredClone(job)
  unrelated.match.id = unrelatedId; unrelated.match.seedUrls = ['https://example.com/unrelated']
  fs.writeFileSync(path.join(unrelatedDirectory, 'job.json'), JSON.stringify(unrelated))
  discover = prompt => {
    unrelated.news.summary = '与本轮无关的其他进程修改'
    fs.writeFileSync(path.join(unrelatedDirectory, 'job.json'), JSON.stringify(unrelated))
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    const batch = path.join(root, 'batches', runId); fs.mkdirSync(batch, { recursive: true })
    fs.writeFileSync(path.join(batch, 'intake.json'), JSON.stringify({ items: [
      { url: 'https://example.com/news', title: '本轮新闻', status: 'researched', jobDir: path.join(root, jobId) },
    ] }))
  }
  await service.start({ requestId: 'select-only-linked-intake', autoUpload: false }); await service.waitForIdle()
  assert.deepEqual(produced, [path.join(root, jobId)])
  assert.deepEqual(service.overview().runs[0].jobIds, [jobId])
  assert.equal(service.overview().runs[0].status, 'completed')
})

test('CBA completes a scan containing only deliberately skipped or duplicate news', async t => {
  let writeBatch: ((prompt: string) => void) | undefined
  const { service, root } = await fixture(t, { launch: prompt => { writeBatch?.(prompt); return { done: Promise.resolve(0), stop() {} } } })
  writeBatch = prompt => {
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    const directory = path.join(root, 'batches', runId); fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: ['skipped', 'duplicate', 'already_delivered'].map((status, index) => ({ url: `https://example.com/skip-${index}`, title: status, status })) }))
  }
  await service.start({ requestId: 'skipped-intake', autoUpload: false }); await service.waitForIdle()
  assert.equal(service.overview().runs[0].status, 'completed')
})

test('CBA requires a registered ready account before enqueueing a new Baijiahao upload', async t => {
  let selected: string | null = null, status = 'ready', calls = 0
  const { service } = await fixture(t, { accounts: {
    list: () => ({ defaultAccountName: selected }),
    get: accountName => {
      if (accountName !== 'cba_first') throw Error('missing')
      return { accountName, label: '体育新闻', status, message: status }
    },
  }, runtime: runtime({ runSocialUpload: async payload => { calls++; return receipt(payload) } }) })
  await assert.rejects(service.upload(jobId, { requestId: 'no-account', targets: ['baijiahao-video'] }), /添加并登录/)
  await assert.rejects(service.upload(jobId, { requestId: 'unknown-account', targets: ['baijiahao-video'], baijiahaoAccountName: 'missing' }), /账号不存在/)
  selected = 'cba_first'; status = 'expired'
  await assert.rejects(service.upload(jobId, { requestId: 'expired-account', targets: ['baijiahao-video'] }), /重新登录或检查登录状态/)
  assert.equal(service.overview().runs.length, 0)
  assert.equal(calls, 0)
})

test('CBA pins the default account at enqueue and uses its headless readiness instead of global CDP', async t => {
  let defaultAccountName = 'cba_first', finish!: (code: number) => void, prompt = ''
  let signalStarted!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const done = new Promise<number>(resolve => { finish = resolve })
  const uploaded: SocialUploadPayload[] = [], checked: string[] = []
  const { service, root } = await fixture(t, {
    accounts: { list: () => ({ defaultAccountName }), get: accounts().get },
    launch: value => { prompt = value; signalStarted(); return { done, stop() {} } },
    runtime: runtime({
      inspectSocialUploadRuntime: async () => { throw Error('named accounts must not require global CDP') },
      inspectSocialUploadAccountRuntime: async name => { checked.push(name); return { ready: true, message: 'ready' } },
      runSocialUpload: async payload => { uploaded.push(payload); return receipt(payload) },
    }),
  })
  const { run } = await service.start({ requestId: 'pinned-account', targets: ['baijiahao-video'] })
  await started
  assert.equal(run.baijiahaoAccountName, 'cba_first')
  defaultAccountName = 'cba_second'
  const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
  const directory = path.join(root, 'batches', runId); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [{ url: 'https://example.com/news', status: 'rendered', jobDir: path.join(root, jobId) }] }))
  finish(0); await service.waitForIdle()
  assert.deepEqual(checked, ['cba_first', 'cba_first'])
  assert.deepEqual(uploaded.map(item => item.accountName), ['cba_first', 'cba_first'])
  assert.equal(service.detail(jobId).baijiahaoAccountLabel, '第一账号')
  assert.equal(service.detail(jobId).status, 'completed')
})

test('CBA receipts and failures are isolated between Baijiahao accounts', async t => {
  const uploaded: SocialUploadPayload[] = []
  const { service } = await fixture(t, { runtime: runtime({ runSocialUpload: async payload => {
    uploaded.push(payload)
    if (payload.accountName === 'cba_second' && payload.videoPath?.endsWith('news.mp4')) throw Error('第二账号的新闻上传结果待核对')
    return receipt(payload)
  } }) })
  await service.upload(jobId, { requestId: 'account-a', targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first' }); await service.waitForIdle()
  assert.equal(service.detail(jobId).status, 'completed')
  await service.upload(jobId, { requestId: 'account-b', targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_second' }); await service.waitForIdle()
  assert.equal(service.detail(jobId).status, 'attention')
  assert.equal(service.detail(jobId).baijiahaoAccountName, 'cba_second')
  assert.equal(uploaded.length, 4)
  assert.notEqual(uploaded[0]!.fingerprint, uploaded[2]!.fingerprint)
  await service.upload(jobId, { requestId: 'account-a-again', targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_first' }); await service.waitForIdle()
  assert.equal(uploaded.length, 4)
  assert.equal(service.detail(jobId).status, 'completed')
  assert.equal(service.detail(jobId).uploads.length, 4)
})

test('versioned titles reach each platform intact and retries reuse the same account/version receipts', async t => {
  const uploaded: SocialUploadPayload[] = []
  const { service, job, reapprove } = await fixture(t, { runtime: runtime({ runSocialUpload: async payload => { uploaded.push(payload); return receipt(payload) } }) })
  job.profile.titlePolicy = 'source-date-cba-v1'
  job.news.title = '2026-10-18 CBA｜南京一分险胜广东'; job.news.shortTitle = 'CBA南京险胜广东'
  job.highlights.title = '2026-10-18 CBA｜南京广东关键回合集锦'; job.highlights.shortTitle = 'CBA南京广东关键回合'
  await reapprove()
  await service.upload(jobId, { requestId: 'titles-first', targets: ['baijiahao-video', 'tencent-video'], baijiahaoAccountName: 'cba_first' }); await service.waitForIdle()
  assert.equal(uploaded.length, 4)
  for (const payload of uploaded) {
    const kind = payload.videoPath?.endsWith('news.mp4') ? 'news' : 'highlights'
    assert.equal(payload.title, job[kind][payload.target === 'tencent-video' ? 'shortTitle' : 'title'])
    if (payload.target === 'baijiahao-video') assert.equal(payload.accountName, 'cba_first')
  }
  const before = service.detail(jobId).uploads.map((item: any) => ({ id: item.id, fingerprint: item.fingerprint, inputDigest: item.inputDigest }))
  await service.upload(jobId, { requestId: 'titles-retry', targets: ['baijiahao-video', 'tencent-video'], baijiahaoAccountName: 'cba_first' }); await service.waitForIdle()
  assert.equal(uploaded.length, 4)
  assert.deepEqual(service.detail(jobId).uploads.map((item: any) => ({ id: item.id, fingerprint: item.fingerprint, inputDigest: item.inputDigest })), before)
})

test('an additional news-only story is complete after its sole video is saved, with no highlights upload', async t => {
  const uploaded: SocialUploadPayload[] = []
  const { service, job, reapprove } = await fixture(t, { runtime: runtime({ runSocialUpload: async payload => { uploaded.push(payload); return receipt(payload) } }) })
  job.profile.editions = ['news']; delete job.outputs.highlights
  job.outputs.artifacts = job.outputs.artifacts.filter((item: any) => !path.basename(item.path).startsWith('highlights'))
  await reapprove()
  assert.deepEqual(service.detail(jobId).editions, ['news'])
  assert.equal(service.detail(jobId).canUpload, true)
  await service.upload(jobId, { requestId: 'news-only', targets: ['baijiahao-video'] }); await service.waitForIdle()
  assert.equal(uploaded.length, 1); assert.ok(uploaded[0]!.videoPath?.endsWith('news.mp4'))
  assert.equal(service.detail(jobId).status, 'completed')
  assert.equal(service.detail(jobId).canResume, false)
  await service.upload(jobId, { requestId: 'news-only-retry', targets: ['baijiahao-video'] }); await service.waitForIdle()
  assert.equal(uploaded.length, 1)
})

test('a shared match directory or secondary source cannot hide a distinct unfinished news story', async t => {
  const { service, root, job, writeJob } = await fixture(t)
  job.match.seedUrls.push('https://example.com/another-news'); writeJob()
  const directory = path.join(root, 'batches', 'older-grouped-batch'); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [{ url: 'https://example.com/another-news', title: '同场另一位球员采访', status: 'researched', jobDir: path.join(root, jobId) }] }))
  const rows = service.overview().jobs
  assert.equal(rows.length, 2)
  const separate = rows.find(item => item.sourceUrl === 'https://example.com/another-news')!
  assert.ok(separate.id.startsWith('intake-')); assert.equal(separate.canResume, true)
})

test('a frozen 24-story homepage is researched in full even if each subprocess rewrites only its assigned rows', async t => {
  const snapshot = { entryUrl: 'https://cba.hupu.com/', retrievedAt: '2026-10-24T15:30:00Z', scope: '完整首页', total: 24, items: Array.from({ length: 24 }, (_, i) => ({ url: `https://bbs.hupu.com/${640000000 + i}.html`, title: `同场不同新闻${i}`, publishedAt: null })) }
  const assignedUrls: string[] = []
  let root: string
  const f = await fixture(t, { captureHomepage: async () => snapshot, launch: prompt => {
    const assigned = JSON.parse(/仅研究本组 \d+ 条：(.*?)。读取/.exec(prompt)![1]!)
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    assignedUrls.push(...assigned.map((item: any) => item.url))
    fs.writeFileSync(path.join(root, 'batches', runId, 'intake.json'), JSON.stringify({ items: assigned.map((item: any) => ({ ...item, status: 'needs_editorial_route', reason: '离线测试：需非单场流程', jobDir: null })) }))
    return { done: Promise.resolve(0), stop() {} }
  } }); root = f.root
  const { run } = await f.service.start({ requestId: 'whole-homepage', autoUpload: false }); await f.service.waitForIdle()
  assert.deepEqual(assignedUrls, snapshot.items.map(item => item.url))
  const batch = JSON.parse(fs.readFileSync(path.join(root, 'batches', run.id, 'intake.json'), 'utf8'))
  assert.equal(batch.items.length, 24); assert.ok(batch.items.every((item: any) => item.status === 'needs_editorial_route'))
  assert.deepEqual(f.service.overview().intakeCoverage, { total: 24, retrievedAt: snapshot.retrievedAt, processed: 24, pending: 0 })
})

test('homepage reconciliation rejects mapping a different story to a finished match directory', async t => {
  const snapshot = { entryUrl: 'https://cba.hupu.com/', retrievedAt: '2026-10-24T15:30:00Z', scope: '首页', total: 2, items: [{ url: 'https://example.com/news', title: '原新闻' }, { url: 'https://example.com/distinct', title: '同场不同事件' }] }
  let root: string, calls = 0
  const f = await fixture(t, { captureHomepage: async () => snapshot, launch: prompt => {
    calls++
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    fs.writeFileSync(path.join(root, 'batches', runId, 'intake.json'), JSON.stringify({ items: snapshot.items.map(item => ({ ...item, status: 'researched', jobDir: path.join(root, jobId) })) }))
    return { done: Promise.resolve(0), stop() {} }
  } }); root = f.root
  const { run } = await f.service.start({ requestId: 'no-match-collapse', autoUpload: false }); await f.service.waitForIdle()
  const batch = JSON.parse(fs.readFileSync(path.join(root, 'batches', run.id, 'intake.json'), 'utf8'))
  assert.equal(calls, 2)
  assert.equal(batch.items[1].status, 'needs_research'); assert.equal(batch.items[1].jobDir, null)
  assert.equal(f.service.overview().runs[0].status, 'attention')
  assert.equal(f.service.overview().intakeCoverage?.pending, 1)
})

test('a justified duplicate keeps its decision even when research points at the original report task', async t => {
  for (const invalid of [undefined, 'missing-reason', 'self-reference', 'missing-original'] as const) await t.test(invalid || 'valid-duplicate', async sub => {
    let root: string, calls = 0
    const item = { url: 'https://bbs.hupu.com/643539345.html', title: '同一赛果的另一篇报道' }
    const f = await fixture(sub, {
      captureHomepage: async () => ({ total: 1, items: [item] }),
      launch: prompt => {
        calls++
        const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
        fs.writeFileSync(path.join(root, 'batches', runId, 'intake.json'), JSON.stringify({ items: [{ ...item,
          status: 'duplicate', jobDir: path.join(root, jobId),
          duplicateOf: invalid === 'self-reference' ? item.url : invalid === 'missing-original' ? undefined : 'https://example.com/news',
          reason: invalid === 'missing-reason' ? '' : '双方、日期、比分及报道事件均与原报道一致，原报道已包含这场赛果；并非同场不同采访或人物报道。',
        }] }))
        return { done: Promise.resolve(0), stop() {} }
      },
      pipeline: async () => { assert.fail('a duplicate must not produce the original report again') },
    }); root = f.root
    const { run } = await f.service.start({ requestId: `duplicate-${invalid || 'valid'}`, autoUpload: false }); await f.service.waitForIdle()
    const row = JSON.parse(fs.readFileSync(path.join(root, 'batches', run.id, 'intake.json'), 'utf8')).items[0]
    assert.equal(calls, invalid ? 2 : 1)
    assert.equal(row.status, invalid ? 'needs_research' : 'duplicate')
    assert.equal(row.jobDir, null)
    assert.equal(f.service.overview().runs[0].status, invalid ? 'attention' : 'completed')
    if (!invalid) { assert.equal(row.duplicateOf, 'https://example.com/news'); assert.match(row.reason, /报道事件均与原报道一致/) }
  })
})

test('in-scope pending news remains unfinished while an explicit limit leaves other rows for later', async t => {
  for (const limit of [undefined, 1]) {
    const snapshot = { entryUrl: 'https://cba.hupu.com/', retrievedAt: '2026-10-24T15:30:00Z', scope: '首页', total: 2, items: [{ url: 'https://example.com/news', title: '已完成主报道' }, { url: 'https://example.com/pending', title: '待研究新闻' }] }
    let root: string
    const f = await fixture(t, { captureHomepage: async () => snapshot, launch: prompt => {
      const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
      fs.writeFileSync(path.join(root, 'batches', runId, 'intake.json'), JSON.stringify({ items: snapshot.items.map((item, i) => ({ ...item, status: i ? 'pending' : 'already_delivered', jobDir: i ? null : path.join(root, jobId) })) }))
      return { done: Promise.resolve(0), stop() {} }
    } }); root = f.root
    await f.service.start({ requestId: `pending-${limit || 'all'}`, autoUpload: false, limit }); await f.service.waitForIdle()
    assert.equal(f.service.overview().runs[0].status, limit ? 'completed' : 'attention')
    assert.equal(f.service.overview().intakeCoverage?.pending, 1)
  }
})

test('already-delivered research claims cannot skip a stale video and duplicate primary records select only one job', async t => {
  let root: string
  const produced: string[] = []
  const snapshot = { entryUrl: 'https://cba.hupu.com/', retrievedAt: '2026-10-24T15:30:00Z', scope: '首页', total: 1, items: [{ url: 'https://example.com/news', title: '主报道' }] }
  const f = await fixture(t, { captureHomepage: async () => snapshot, launch: prompt => {
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    fs.writeFileSync(path.join(root, 'batches', runId, 'intake.json'), JSON.stringify({ items: [{ ...snapshot.items[0], status: 'already_delivered', jobDir: path.join(root, jobId) }] }))
    return { done: Promise.resolve(0), stop() {} }
  }, pipeline: async directory => { produced.push(path.basename(directory)); return { ready: false, stage: 'writing', message: '测试：旧稿需修订' } } }); root = f.root
  f.job.news.summary = '修改后尚未审核'; f.writeJob()
  const duplicate = path.join(root, `${jobId}-news-duplicate`); fs.mkdirSync(duplicate)
  fs.writeFileSync(path.join(duplicate, 'job.json'), JSON.stringify(f.job))
  const { run } = await f.service.start({ requestId: 'stale-not-delivered', autoUpload: false }); await f.service.waitForIdle()
  const batch = JSON.parse(fs.readFileSync(path.join(root, 'batches', run.id, 'intake.json'), 'utf8'))
  assert.equal(batch.items[0].status, 'researched')
  assert.deepEqual(produced, [jobId]); assert.equal(f.service.overview().runs[0].status, 'attention')
})

test('partial discovery continues production for researched rows instead of blocking the whole batch', async t => {
  let root: string, launchCount = 0
  const produced: string[] = []
  const snapshot = { entryUrl: 'https://cba.hupu.com/', retrievedAt: '2026-10-24T15:30:00Z', scope: '首页', total: 2, items: [{ url: 'https://example.com/news', title: '已建档新闻' }, { url: 'https://example.com/unread', title: '尚未建档新闻' }] }
  const f = await fixture(t, { captureHomepage: async () => snapshot, launch: prompt => {
    launchCount++
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    const assigned = JSON.parse(/仅研究本组 \d+ 条：(.*?)。读取/.exec(prompt)![1]!)
    fs.writeFileSync(path.join(root, 'batches', runId, 'intake.json'), JSON.stringify({ items: [{ ...assigned[0], status: 'researched', jobDir: path.join(root, jobId) }] }))
    return { done: Promise.resolve(launchCount === 1 ? 1 : 0), failureMessage: () => launchCount === 1 ? '模型服务并发已达上限' : undefined, stop() {} }
  }, pipeline: async directory => { produced.push(path.basename(directory)); return { ready: true, stage: 'rendering', message: 'ready' } } }); root = f.root
  f.job.status = 'waiting_for_media'; f.job.outputs = null; f.writeJob()
  const { run } = await f.service.start({ requestId: 'partial-discovery-production', autoUpload: false }); await f.service.waitForIdle()
  assert.deepEqual(produced, [jobId])
  assert.equal(f.service.overview().runs[0].status, 'attention')
  assert.match(f.service.overview().runs[0].message, /部分任务需要处理/)
})

test('CBA resume keeps its original account after the registry default changes', async t => {
  let defaultAccountName = 'cba_first'
  const { service, root, job, writeJob } = await fixture(t, {
    accounts: { list: () => ({ defaultAccountName }), get: accounts().get },
    launch: () => ({ done: Promise.resolve(0), stop() {} }),
  })
  const { run: original } = await service.start({ requestId: 'original-account', targets: ['baijiahao-video'] }); await service.waitForIdle()
  const stateFile = path.join(root, '.console.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.runs[0].jobIds = [jobId]; fs.writeFileSync(stateFile, JSON.stringify(state))
  defaultAccountName = 'cba_second'
  await service.start({ requestId: 'new-default-account', targets: ['baijiahao-video'] }); await service.waitForIdle()
  job.status = 'waiting_for_media'; job.outputs = null; writeJob()
  const { run } = await service.resume(jobId, { requestId: 'resume-pinned-account' }); await service.waitForIdle()
  assert.equal(run.baijiahaoAccountName, original.baijiahaoAccountName)
  assert.equal(run.baijiahaoAccountName, 'cba_first')
  assert.equal(service.overview().settings.baijiahaoAccountName, 'cba_second')
})

test('waiting_for_media is shown as the media blocker instead of a rendering failure', async t => {
  const { service, job, writeJob } = await fixture(t)
  job.status = 'waiting_for_media'; job.outputs = null
  job.media = []; job.mediaBlocker = '未取得可核验的完整对应比赛录像，不能开始剪辑。'
  job.mediaSearch = { provider: 'migu', status: 'not_found', completed: true, requests: [], candidates: [] }
  writeJob()
  const detail = service.detail(jobId)
  assert.equal(detail.stage, 'finding_media')
  assert.equal(detail.timeline.find((item: any) => item.stage === 'finding_media')?.status, 'attention')
  assert.match(detail.message, /完整对应比赛录像/)
})

test('discovery only establishes tasks while an existing-job resume invokes the pipeline directly', async t => {
  const prompts: string[] = [], phases: string[] = [], produced: string[] = []
  const { service, root, job, writeJob } = await fixture(t, {
    launch: (prompt, _message, options) => { prompts.push(prompt); phases.push(options!.phase); return { done: Promise.resolve(0), stop() {} } },
    pipeline: async directory => { produced.push(directory); return { ready: false, stage: 'finding_media', message: '测试素材仍待获取' } },
  })
  job.status = 'waiting_for_media'; job.outputs = null; job.media = []; writeJob()
  await service.start({ requestId: 'migu-start', autoUpload: false }); await service.waitForIdle()
  await service.resume(jobId, { requestId: 'migu-resume' }); await service.waitForIdle()
  assert.deepEqual(phases, ['discovery'])
  assert.equal(prompts.length, 1)
  assert.match(prompts[0]!, /只研究和建档/)
  assert.match(prompts[0]!, /不要下载、执行TTS或渲染/)
  assert.deepEqual(produced, [path.join(root, jobId)])
})

test('CBA reuses a validated delivery after an interrupted discovery instead of another model request', async t => {
  let launches = 0
  const snapshot = { entryUrl: 'https://cba.hupu.com/', retrievedAt: new Date().toISOString(), scope: 'current-homepage', total: 1,
    items: [{ url: 'https://example.com/news', title: '本轮新闻', publishedAt: '2026-10-18' }] }
  const { service, root } = await fixture(t, {
    captureHomepage: async () => snapshot,
    modelRetryBaseDelayMs: 0,
    launch: prompt => {
      launches++
      if (launches === 1) return { done: Promise.resolve(1), failureMessage: () => '模型服务请求频率受限，本步骤未完成；已有成果和尝试记录已保留', stop() {} }
      const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
      const directory = path.join(root, 'batches', runId); fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [{ ...snapshot.items[0], status: 'researched', jobDir: path.join(root, jobId) }] }))
      return { done: Promise.resolve(0), stop() {} }
    },
  })
  await service.start({ requestId: 'discovery-model-retry', autoUpload: false }); await service.waitForIdle()
  assert.equal(launches, 1)
  assert.equal(service.overview().runs[0].status, 'completed')
  assert.match(service.overview().runs[0].logs.join('\n'), /新闻研究模型中断前已保存可校验成果/)
})

test('CBA retries transient editing and independent-review model failures without rerunning deterministic work', async t => {
  let launches = 0
  const phases: string[] = []
  const { service, root, job, writeJob } = await fixture(t, {
    modelRetryBaseDelayMs: 0,
    launch: (_prompt, _message, options) => {
      launches++
      phases.push(options!.phase)
      if (launches === 1 || launches === 3) return { done: Promise.resolve(1), failureMessage: () => '模型服务请求频率受限，本步骤未完成；已有成果和尝试记录已保留', stop() {} }
      const outputPath = options?.outputPath
      if (outputPath) fs.writeFileSync(outputPath, JSON.stringify({ decision: 'pass' }))
      return { done: Promise.resolve(0), stop() {} }
    },
    pipeline: async (directory, _runId, deps) => {
      await deps.edit('retry editing')
      const { prepareEditorialAudit } = await import(new URL('../../../scripts/cba-video/editorial-gate.mjs', import.meta.url).href)
      const packet = await prepareEditorialAudit(JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8')), directory)
      await deps.review(packet, 'review-test')
      return { ready: false, stage: 'auditing', message: '测试流程在审核后停止' }
    },
  })
  job.status = 'needs_edit'; job.outputs = null
  job.profile.titlePolicy = 'source-date-cba-v1'
  job.news.title = '2026-10-18 CBA｜南京险胜广东'; job.news.shortTitle = 'CBA南京险胜广东'
  job.highlights.title = '2026-10-18 CBA｜南京广东关键回合'; job.highlights.shortTitle = 'CBA南京广东关键回合'
  job.automation = { producerRunId: 'producer-test' }
  writeJob()
  await service.resume(jobId, { requestId: 'editing-review-model-retry' }); await service.waitForIdle()
  assert.equal(launches, 4)
  assert.deepEqual(phases, ['editing', 'editing', 'audit', 'audit'])
  assert.equal(service.overview().runs[0].status, 'attention')
  assert.match(service.overview().runs[0].logs.join('\n'), /编辑模型暂时失败.*自动重试/)
  assert.match(service.overview().runs[0].logs.join('\n'), /独立审核模型暂时失败.*自动重试/)
})

test('CBA preserves completed discovery rows when a provider retry rewrites only the unfinished row', async t => {
  let root: string, launches = 0
  const snapshot = { entryUrl: 'https://cba.hupu.com/', retrievedAt: new Date().toISOString(), scope: '首页', total: 2,
    items: [{ url: 'https://example.com/news', title: '已建档新闻' }, { url: 'https://example.com/second', title: '尚未建档新闻' }] }
  const assignedGroups: string[][] = []
  const f = await fixture(t, { captureHomepage: async () => snapshot, modelRetryBaseDelayMs: 0, launch: prompt => {
    launches++
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    const assigned = JSON.parse(/仅研究本组 \d+ 条：(.*?)。读取/.exec(prompt)![1]!)
    assignedGroups.push(assigned.map((item: any) => item.url))
    const item = launches === 1 ? { ...snapshot.items[0], status: 'researched', jobDir: path.join(root, jobId) }
      : { ...snapshot.items[1], status: 'skipped', reason: '测试：无独立事件' }
    fs.writeFileSync(path.join(root, 'batches', runId, 'intake.json'), JSON.stringify({ items: [item] }))
    return { done: Promise.resolve(launches === 1 ? 1 : 0), failureMessage: () => '模型服务请求频率受限', stop() {} }
  } }); root = f.root
  const { run } = await f.service.start({ requestId: 'preserve-research-across-model-retry', autoUpload: false }); await f.service.waitForIdle()
  assert.deepEqual(assignedGroups, [snapshot.items.map(item => item.url), ['https://example.com/second']])
  const batch = JSON.parse(fs.readFileSync(path.join(root, 'batches', run.id, 'intake.json'), 'utf8'))
  assert.equal(batch.items.find((item: any) => item.url === snapshot.items[0]!.url).status, 'already_delivered')
  assert.equal(f.service.overview().runs[0].status, 'completed')
})

test('CBA stops immediately during model retry cooldown and rejects a concurrent producer', async t => {
  let launches = 0
  const { service } = await fixture(t, { modelRetryBaseDelayMs: 60_000, launch: () => {
    launches++
    return { done: Promise.resolve(1), failureMessage: () => '模型服务请求频率受限', stop() {} }
  } })
  const { run } = await service.start({ requestId: 'stop-model-cooldown', autoUpload: false })
  for (let i = 0; i < 100 && !service.overview().runs[0].logs.some((message: string) => message.includes('自动重试')); i++)
    await new Promise(resolve => setTimeout(resolve, 5))
  await assert.rejects(service.start({ requestId: 'concurrent-model-cooldown', autoUpload: false }), /已有任务/)
  service.stop(run.id)
  const idle = service.waitForIdle()
  let timer: ReturnType<typeof setTimeout>
  try {
    const stoppedQuickly = await Promise.race([idle.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 500) })])
    assert.equal(stoppedQuickly, true, 'stopping must cancel the retry timer immediately')
  } finally { clearTimeout(timer!) }
  assert.equal(launches, 1)
  assert.equal(service.overview().runs[0].status, 'stopped')
})

test('CBA bounds transient model attempts and never retries credential or quota failures', async t => {
  for (const [message, expected] of [['HTTP 503 Service Unavailable', 3], ['模型连接暂时中断', 3], ['HTTP 401 unauthorized', 1], ['HTTP 429 insufficient_quota: check billing', 1]] as const) {
    let launches = 0
    const { service } = await fixture(t, { modelRetryBaseDelayMs: 0, launch: () => {
      launches++
      return { done: Promise.resolve(1), failureMessage: () => message, stop() {} }
    } })
    await service.start({ requestId: `budget-${expected}`, autoUpload: false }); await service.waitForIdle()
    assert.equal(launches, expected, message)
    const run = service.overview().runs[0]
    assert.equal(run.status, 'attention')
    const attempts = run.modelAttempts
    assert.ok(attempts)
    assert.equal(attempts.length, expected)
    assert.ok(attempts.every((attempt: any) => attempt.status === 'failed' && attempt.finishedAt))
  }
})

test('a shared model authentication or quota failure stops later discovery groups without losing their scope', async t => {
  for (const message of ['HTTP 401 unauthorized', '模型服务额度不足，请检查服务额度或计费']) {
    const items = Array.from({ length: 9 }, (_, i) => ({ url: `https://example.com/budget-${i}`, title: `新闻${i}` }))
    let launches = 0
    const { service, root } = await fixture(t, { captureHomepage: async () => ({ total: items.length, items }), launch: () => {
      launches++; return { done: Promise.resolve(1), failureMessage: () => message, stop() {} }
    } })
    const { run } = await service.start({ requestId: `global-provider-failure-${message.length}`, autoUpload: false }); await service.waitForIdle()
    assert.equal(launches, 1, 'switching stories cannot fix a shared credential or quota failure')
    const intake = JSON.parse(fs.readFileSync(path.join(root, 'batches', run.id, 'intake.json'), 'utf8'))
    assert.equal(intake.items.length, 9)
    assert.ok(intake.items.slice(0, 4).every((item: any) => item.status === 'needs_research'))
    assert.ok(intake.items.slice(4).every((item: any) => item.status === 'pending' && item.outsideScope === false && /尚未研究/.test(item.reason)))
    assert.equal(service.overview().runs[0].status, 'attention')
    assert.equal(service.resumeQueuePreview().total, 9)
  }
})

test('a later model quota failure preserves the earlier group production attempt without repeating it', async t => {
  const items = [{ url: 'https://example.com/news' }, ...Array.from({ length: 4 }, (_, i) => ({ url: `https://example.com/quota-${i}` }))]
  let f: Awaited<ReturnType<typeof fixture>>, launches = 0, pipelines = 0
  f = await fixture(t, { captureHomepage: async () => ({ total: items.length, items }), launch: prompt => {
    launches++
    if (launches > 1) return { done: Promise.resolve(1), failureMessage: () => '模型服务额度不足', stop() {} }
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
    const file = path.join(f.root, 'batches', runId, 'intake.json'), intake = JSON.parse(fs.readFileSync(file, 'utf8'))
    intake.items.slice(0, 4).forEach((item: any, index: number) => Object.assign(item, { status: index ? 'skipped' : 'researched', jobDir: index ? null : path.join(f.root, jobId) }))
    fs.writeFileSync(file, JSON.stringify(intake))
    return { done: Promise.resolve(0), stop() {} }
  }, pipeline: async () => { pipelines++; return { ready: false, stage: 'writing', message: '模型不可用' } } })
  f.job.outputs = null; f.writeJob()
  const { run } = await f.service.start({ requestId: 'quota-before-production', autoUpload: false }); await f.service.waitForIdle()
  assert.equal(launches, 2)
  assert.equal(pipelines, 1, 'the earlier group is produced before the later outage and is not repeated afterward')
  const intake = JSON.parse(fs.readFileSync(path.join(f.root, 'batches', run.id, 'intake.json'), 'utf8'))
  assert.equal(intake.items[0].status, 'researched')
  assert.equal(intake.items[0].jobDir, path.join(f.root, jobId))
  assert.equal(f.service.overview().runs[0].status, 'attention')
})

test('a shared model failure during editing prevents later projects from requesting the same provider', async t => {
  let f: Awaited<ReturnType<typeof fixture>>, modelCalls = 0
  const produced: string[] = [], secondId = `${jobId}-provider-blocked`
  f = await fixture(t, { launch: (prompt, _message, options) => {
    if (options?.phase === 'editing') { modelCalls++; return { done: Promise.resolve(1), failureMessage: () => '模型服务额度不足', stop() {} } }
    const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!, directory = path.join(f.root, 'batches', runId)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [jobId, secondId].map((id, index) => ({
      url: index ? 'https://example.com/second' : 'https://example.com/news', status: 'researched', jobDir: path.join(f.root, id),
    })) }))
    return { done: Promise.resolve(0), stop() {} }
  }, pipeline: async (directory, _runId, deps) => {
    produced.push(path.basename(directory)); await deps.edit('测试共享额度故障')
    return { ready: true, stage: 'rendering', message: 'ready' }
  } })
  f.job.outputs = null; f.writeJob()
  const second = structuredClone(f.job); second.match.seedUrls = ['https://example.com/second']
  fs.mkdirSync(path.join(f.root, secondId)); fs.writeFileSync(path.join(f.root, secondId, 'job.json'), JSON.stringify(second))
  await f.service.start({ requestId: 'editing-provider-blocked', autoUpload: false }); await f.service.waitForIdle()
  assert.deepEqual(produced, [jobId]); assert.equal(modelCalls, 1)
  assert.equal(f.service.overview().runs[0].status, 'attention')
  assert.equal(f.service.detail(secondId).canResume, true)
})

test('a shared model authentication failure leaves later resume queue items pending without dispatching them', async t => {
  let calls = 0
  const { service, root } = await fixture(t, { launch: () => {
    calls++; return { done: Promise.resolve(1), failureMessage: () => 'HTTP 401 unauthorized', stop() {} }
  } })
  const directory = path.join(root, 'batches', 'original-intake'); fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'intake.json'), JSON.stringify({ items: [0, 1].map(index => ({
    url: `https://example.com/research-${index}`, title: `待研究${index}`, status: 'needs_research',
  })) }))
  const ids = service.resumeQueuePreview().items.map(item => item.id)
  assert.equal(ids.length, 2)
  await service.startResumeQueue({ requestId: 'queue-provider-blocked', jobIds: ids }); await service.waitForIdle()
  assert.equal(calls, 1)
  const queue = service.overview().resumeQueue!
  assert.equal(queue.status, 'attention'); assert.equal(queue.pending, 1); assert.equal(queue.failed, 1)
  assert.equal(queue.items[1]!.outcome, 'pending')
  assert.match(queue.items[1]!.message, /尚未启动/)
  assert.equal(service.overview().activeRun, null)
  assert.equal(service.resumeQueuePreview().total, 2)
})

test('CLI gate failures keep plain Chinese and approval diagnostics without exposing debug records', async t => {
  for (const detail of ['新闻段落 n1 含素材转述口吻“新浪”；来源保留在后台', 'Approval requires the current complete review preview and its digest.']) await t.test(detail, async sub => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-command-gate-'))
    sub.after(() => fs.rmSync(project, { recursive: true, force: true }))
    const script = path.join(project, 'scripts/cba-video/cli.mjs'); fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.writeFileSync(script, `console.error(${JSON.stringify(detail)}); process.exit(1)\n`)
    const f = await fixture(sub, { projectRoot: project, pipeline: async (_directory, _runId, deps) => {
      await deps.command(['approve'])
      assert.fail('failed approval must stop production')
    } })
    f.job.outputs = null; f.job.status = 'needs_edit'; f.writeJob()
    await f.service.resume(jobId, { requestId: 'plain-gate-diagnostic' }); await f.service.waitForIdle()
    const result = f.service.detail(jobId)
    assert.ok(result.message.includes(detail))
    assert.doesNotMatch(result.message, /未返回可用错误/)
  })
})

test('only explicit paid TTS quota or authentication failures pause later queue items without retrying', async t => {
  const cases = [
    { command: 'tts', error: 'MiniMax 2056: 已达到 Token Plan 用量上限：请升级套餐', blocked: true },
    { command: 'tts', error: '已达到 Token Plan 用量上限，请购买积分补充用量', blocked: true },
    { command: 'tts', error: 'HTTP 401: invalid API key', blocked: true },
    { command: 'tts', error: 'TTS API error 401: 请求未获授权', blocked: true },
    { command: 'tts', error: 'Qwen TTS 401: 请求未获授权', blocked: true },
    { command: 'tts', error: 'MiniMax 1004: 请求未获授权', blocked: true },
    { command: 'tts', error: 'MiniMax 2049: API凭证不可用', blocked: true },
    { command: 'tts', error: 'MiniMax 1008: 账户资源不可用', blocked: true },
    { command: 'tts', error: 'MiniMax 2053: 账户资源不可用', blocked: true },
    { command: 'tts', error: 'MiniMax 2067: 套餐额度用完', blocked: true },
    { command: 'tts', error: 'MiniMax 2042: 无权访问当前音色', blocked: false },
    { command: 'tts', error: 'HTTP 429: 请求频率受限，请稍后重试', blocked: false },
    { command: 'tts', error: 'MiniMax request timed out while reading Token Plan status', blocked: false },
    { command: 'acquire-media', error: 'MiniMax 2056: 已达到 Token Plan 用量上限', blocked: false },
  ]
  for (const [index, scenario] of cases.entries()) await t.test(`${scenario.command}: ${scenario.error}`, async sub => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-command-provider-'))
    sub.after(() => fs.rmSync(project, { recursive: true, force: true }))
    const script = path.join(project, 'scripts/cba-video/cli.mjs'); fs.mkdirSync(path.dirname(script), { recursive: true })
    // Run a real local child process, with no network or paid provider calls.
    fs.writeFileSync(script, `console.error(${JSON.stringify(`Error: ${scenario.error}`)}); process.exit(1)\n`)
    const secondId = `${jobId}-tts-later`, produced: string[] = []
    const f = await fixture(sub, { projectRoot: project, pipeline: async (directory, _runId, deps) => {
      const id = path.basename(directory); produced.push(id)
      if (id === jobId) await deps.command([scenario.command])
      return { ready: false, stage: 'rendering', message: '测试后续任务仍可处理' }
    } })
    f.job.outputs = null; f.job.status = 'needs_edit'; f.writeJob()
    const second = structuredClone(f.job); second.match.seedUrls = ['https://example.com/later-tts']
    fs.mkdirSync(path.join(f.root, secondId)); fs.writeFileSync(path.join(f.root, secondId, 'job.json'), JSON.stringify(second))
    await f.service.startResumeQueue({ requestId: `tts-provider-${index}`, jobIds: [jobId, secondId] }); await f.service.waitForIdle()
    assert.deepEqual(produced, scenario.blocked ? [jobId] : [jobId, secondId])
    const queue = f.service.overview().resumeQueue!
    assert.equal(queue.pending, scenario.blocked ? 1 : 0)
    assert.equal(queue.failed, scenario.blocked ? 1 : 2)
    if (scenario.blocked) { assert.equal(queue.items[1]!.outcome, 'pending'); assert.match(queue.items[1]!.message, /尚未启动/) }
    assert.equal(f.service.detail(secondId).canResume, true)
    const state = JSON.parse(fs.readFileSync(path.join(f.root, '.console.json'), 'utf8'))
    assert.equal(!!state.runs[0].modelFailure, scenario.blocked)
    assert.equal(state.runs[0].modelAttempts, undefined, 'CLI failure must not enter the Codex model retry loop')
    assert.match(state.runs[0].logs.join('\n'), new RegExp(scenario.command))
  })
})

test('CBA tries Qwen once after a confirmed TTS account failure and keeps later tasks pending until backup narration succeeds', async t => {
  for (const scenario of ['fresh-success', 'preflight-success', 'preflight-unavailable', 'fallback-timeout', 'fallback-auth', 'fallback-audit']) await t.test(scenario, async sub => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-qwen-coordinator-'))
    sub.after(() => fs.rmSync(project, { recursive: true, force: true }))
    const script = path.join(project, 'scripts/cba-video/cli.mjs'); fs.mkdirSync(path.dirname(script), { recursive: true })
    const quota = 'MiniMax 2056: 已达到 Token Plan 用量上限'
    const backupError = scenario === 'fallback-auth' ? 'TTS API error 401: Qwen 请求未获授权' : 'Qwen request timeout'
    fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path';
const job = JSON.parse(fs.readFileSync(path.join(process.argv[process.argv.indexOf('--job') + 1], 'job.json'), 'utf8'));
if (job.tts.configId === 21) { console.error(${JSON.stringify(quota)}); process.exit(1); }
if (${JSON.stringify(['fallback-timeout', 'fallback-auth'].includes(scenario))}) { console.error(${JSON.stringify(backupError)}); process.exit(1); }
console.log('fixture narration complete');
`)
    const model = 'qwen-audio-3.1-tts-flash', secondId = `${jobId}-after-qwen`, produced: string[] = []
    let voiceChecks = 0
    const f = await fixture(sub, { projectRoot: project, ttsFallback: {
      getSourceConfig: () => ({ provider: 'minimax', model: 'speech-2.8-hd', baseUrl: '', apiKey: 'fixture' }),
      getNarrationConfig: () => scenario === 'preflight-unavailable' ? null : ({ id: 73, provider: 'qwen-tts', model, baseUrl: '', apiKey: 'fixture',
        settings: { useForNarration: true, narrationVoiceId: `${model}-fixture-clone` } }),
      queryVoice: async () => { voiceChecks++; return { status: 'OK', target_model: model } },
    }, pipeline: async (directory, _runId, deps) => {
      const id = path.basename(directory), job = JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8'))
      produced.push(`${id}:${job.tts.configId}`)
      if (id === secondId) return { ready: false, stage: 'rendering', message: '后续任务已获得处理机会' }
      if (job.tts.configId === 73) {
        assert.equal(job.automation.audit, undefined); assert.equal(job.approval, null); assert.equal(job.review, null)
        assert.equal(job.automation.requireAudit, true)
        if (scenario === 'fallback-audit') return { ready: false, stage: 'auditing', failedStep: 'independent-review', message: '备用配置重新审核失败：来源需要核实' }
      }
      const lock = path.join(directory, '.production.lock'); fs.writeFileSync(lock, String(process.pid))
      try {
        await deps.command(['tts', '--job', directory])
        return { ready: false, stage: 'rendering', failedStep: 'render', message: '合成测试在配音完成后停止，不伪造成片' }
      } catch (error) { return { ready: false, stage: 'rendering', failedStep: 'tts', message: String(error) } }
      finally { fs.unlinkSync(lock) }
    } })
    f.job.tts.configId = 21; f.job.outputs = null; f.job.news.segments[0].mode = 'narration'
    f.job.automation = { requireAudit: true, producerRunId: 'original-producer', audit: { reviewer: { runId: 'original-reviewer' } } }
    f.writeJob()
    const second = structuredClone(f.job); second.match.seedUrls = ['https://example.com/after-qwen']
    fs.mkdirSync(path.join(f.root, secondId)); fs.writeFileSync(path.join(f.root, secondId, 'job.json'), JSON.stringify(second))
    if (scenario.startsWith('preflight')) {
      const { digest } = await import(new URL('../../../scripts/cba-video/core.mjs', import.meta.url).href)
      fs.writeFileSync(path.join(f.root, jobId, 'narration-error.json'), JSON.stringify({ segmentId: 'opening', configId: 21, failedAt: '2026-11-02T00:00:01.000Z',
        requestDigest: digest({ text: f.job.news.segments[0].text, tts: f.job.tts }), message: quota }))
      fs.writeFileSync(path.join(f.root, jobId, 'production.json'), JSON.stringify({ status: 'attention', attempts: [{ step: 'tts', status: 'failed', message: quota,
        startedAt: '2026-11-02T00:00:00.000Z', finishedAt: '2026-11-02T00:00:02.000Z' }] }))
    }
    await f.service.startResumeQueue({ requestId: scenario, jobIds: [jobId, secondId] }); await f.service.waitForIdle()
    const success = scenario.endsWith('success'), queue = f.service.overview().resumeQueue!
    assert.equal(queue.pending, success ? 0 : 1)
    assert.deepEqual(produced, scenario === 'preflight-unavailable' ? [] : [
      ...(scenario === 'preflight-success' ? [] : [`${jobId}:21`]), `${jobId}:73`, ...(success ? [`${secondId}:21`] : []),
    ])
    assert.equal(voiceChecks, scenario === 'preflight-unavailable' ? 0 : 1)
    const state = JSON.parse(fs.readFileSync(path.join(f.root, '.console.json'), 'utf8'))
    assert.equal(!!state.runs[0].modelFailure, !success)
    if (scenario === 'fallback-auth') assert.match(state.runs[0].modelFailure, /Qwen 请求未获授权/)
    if (scenario === 'fallback-timeout') assert.match(state.runs[0].modelFailure, /Qwen request timeout/)
    if (scenario === 'fallback-audit') assert.match(state.runs[0].modelFailure, /来源需要核实/)
    assert.equal(state.runs[0].modelAttempts, undefined)
  })
})

test('CBA never switches voice for a render failure, temporary timeout or cancellation', async t => {
  for (const scenario of ['render', 'timeout', 'cancel']) await t.test(scenario, async sub => {
    let calls = 0, lookups = 0
    const f = await fixture(sub, { ttsFallback: { getSourceConfig: () => { lookups++; throw Error('unexpected provider lookup') } },
      pipeline: async (_directory, runId) => {
        calls++
        if (scenario === 'cancel') f.service.stop(runId)
        return { ready: false, stage: 'rendering', failedStep: scenario === 'render' ? 'render' : 'tts',
          message: scenario === 'timeout' ? 'MiniMax request timeout' : 'MiniMax 2056: 已达到 Token Plan 用量上限' }
      } })
    f.job.outputs = null; f.job.tts.configId = 21; f.job.news.segments[0].mode = 'narration'; f.writeJob()
    await f.service.resume(jobId, { requestId: `no-fallback-${scenario}` }); await f.service.waitForIdle()
    assert.equal(calls, 1); assert.equal(lookups, 0)
    assert.equal(JSON.parse(fs.readFileSync(f.jobFile, 'utf8')).tts.configId, 21)
    if (scenario === 'cancel') assert.equal(f.service.overview().runs[0].status, 'stopped')
  })
})

test('resumed Qwen fallback protects unfinished narration while verified current audio releases unrelated failures', async t => {
  for (const scenario of ['pending-timeout', 'pending-auth', 'pending-success', 'pending-audit', 'completed-render', 'completed-media', 'completed-then-edit', 'damaged-audio', 'changed-config']) await t.test(scenario, async sub => {
    const secondId = `${jobId}-after-restored-fallback`, produced: string[] = []
    const error = scenario === 'pending-auth' ? 'Qwen TTS 401: 请求未获授权' : 'Qwen request timeout'
    let lookups = 0
    const f = await fixture(sub, { ttsFallback: { getSourceConfig: () => { lookups++; throw Error('A persisted fallback must never switch again') } },
      pipeline: async (directory, _runId, deps) => {
        const id = path.basename(directory); produced.push(id)
        if (id === secondId) return { ready: false, stage: 'rendering', message: '后续任务可继续' }
        if (scenario === 'completed-render') return { ready: false, stage: 'rendering', failedStep: 'render', message: '渲染字体缺失' }
        if (scenario === 'completed-media') return { ready: false, stage: 'finding_media', failedStep: 'acquire-media', message: '素材需重新获取' }
        if (scenario === 'pending-audit') return { ready: false, stage: 'auditing', failedStep: 'independent-review', message: '备用独立审核尚未完成' }
        if (scenario === 'completed-then-edit') {
          const file = path.join(directory, 'job.json'), job = JSON.parse(fs.readFileSync(file, 'utf8'))
          job.news.segments[0].text += '补充后的新口播'; fs.writeFileSync(file, JSON.stringify(job))
        }
        try { await deps.command(['tts', '--job', directory]); return { ready: false, stage: 'rendering', failedStep: 'render', message: '配音已成功，渲染待继续' } }
        catch (failure) { return { ready: false, stage: 'rendering', failedStep: 'tts', message: String(failure) } }
      } })
    sub.mock.method(f.service as any, 'command', async () => { if (scenario !== 'pending-success') throw Error(error) })
    f.job.outputs = null; f.job.news.segments[0].mode = 'narration'
    const oldTts = structuredClone(f.job.tts)
    f.job.tts = { configId: 73, model: 'qwen-audio-3.1-tts-flash', voice: 'qwen-audio-3.1-tts-flash-fixture', speed: 1.08 }
    f.job.automation = { ttsFallback: { version: 1, runId: 'prior-run', reason: 'MiniMax 2056: 已达到 Token Plan 用量上限',
      from: { provider: 'minimax', tts: oldTts }, to: { provider: 'qwen-tts', tts: structuredClone(f.job.tts) } } }
    if (scenario.startsWith('completed') || scenario === 'damaged-audio') {
      const { digest } = await import(new URL('../../../scripts/cba-video/core.mjs', import.meta.url).href)
      const segment = f.job.news.segments[0], audio = f.job.media[0].path
      segment.audioPath = audio; segment.audioDigest = { request: digest({ text: segment.text, tts: f.job.tts }),
        sha256: scenario === 'damaged-audio' ? 'corrupt-hash' : fileHash(audio), duration: 1.2 }
    }
    if (scenario === 'changed-config') f.job.tts.configId = 74
    f.writeJob()
    const second = structuredClone(f.job); second.match.seedUrls = ['https://example.com/after-restored-fallback']; second.news.segments[0].mode = 'original'
    fs.mkdirSync(path.join(f.root, secondId)); fs.writeFileSync(path.join(f.root, secondId, 'job.json'), JSON.stringify(second))
    await f.service.startResumeQueue({ requestId: `restored-${scenario}`, jobIds: [jobId, secondId] }); await f.service.waitForIdle()
    const blocked = ['pending-timeout', 'pending-auth', 'pending-audit', 'completed-then-edit', 'damaged-audio'].includes(scenario)
    assert.deepEqual(produced, blocked ? [jobId] : [jobId, secondId])
    assert.equal(f.service.overview().resumeQueue!.pending, blocked ? 1 : 0)
    const state = JSON.parse(fs.readFileSync(path.join(f.root, '.console.json'), 'utf8'))
    assert.equal(!!state.runs[0].modelFailure, blocked)
    if (blocked) assert.match(state.runs[0].modelFailure, scenario === 'pending-audit' ? /独立审核尚未完成/ : new RegExp(error))
    assert.equal(lookups, 0)
  })
})

test('CBA reuses a valid edit saved before disconnect or output truncation and still requires independent review', async t => {
  for (const failure of ['模型连接暂时中断', 'Incomplete response returned, reason: max_output_tokens', '模型输出达到上限']) await t.test(failure, async sub => {
    const phases: string[] = []
    const { service, job, writeJob } = await fixture(sub, {
      launch: (_prompt, _message, options) => {
        phases.push(options!.phase)
        if (options!.phase === 'editing') {
          job.news.summary = '编辑已保存的当前版本'; writeJob()
          return { done: Promise.resolve(1), failureMessage: () => failure, stop() {} }
        }
        fs.writeFileSync(options!.outputPath!, JSON.stringify({ decision: 'pass' }))
        return { done: Promise.resolve(0), stop() {} }
      },
      pipeline: async (directory, _runId, deps) => {
        await deps.edit('编辑当前新闻')
        const { prepareEditorialAudit } = await import(new URL('../../../scripts/cba-video/editorial-gate.mjs', import.meta.url).href)
        const packet = await prepareEditorialAudit(JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8')), directory)
        await deps.review(packet, 'review-saved-edit')
        return { ready: false, stage: 'auditing', message: '测试在独立审核后停止' }
      },
    })
    job.status = 'needs_edit'; job.outputs = null; job.automation = { producerRunId: 'producer-test' }
    writeJob()
    await service.resume(jobId, { requestId: 'recover-saved-edit' }); await service.waitForIdle()
    assert.deepEqual(phases, ['editing', 'audit'])
    assert.match(service.overview().runs[0].logs.join('\n'), /复用当前进度/)
    assert.equal(service.overview().runs[0].modelAttempts?.length, 2)
  })
})

test('output truncation without a newly saved valid edit cannot advance to review or rendering', async t => {
  for (const mode of ['unchanged', 'invalid-edit']) await t.test(mode, async sub => {
    let launches = 0, advanced = false
    const { service, job, writeJob } = await fixture(sub, {
      launch: () => {
        launches++
        if (mode === 'invalid-edit') { job.news.summary = '本次编辑'; job.facts[0].verified = false; writeJob() }
        return { done: Promise.resolve(1), failureMessage: () => 'Incomplete response returned, reason: max_output_tokens', stop() {} }
      },
      pipeline: async (_directory, _runId, deps) => { await deps.edit('编辑新闻'); advanced = true; return { ready: true, stage: 'rendering', message: 'unexpected' } },
    })
    job.status = 'needs_edit'; job.outputs = null; writeJob()
    await service.resume(jobId, { requestId: `truncated-${mode}` }); await service.waitForIdle()
    assert.equal(launches, 1, 'an output limit is not blindly retried')
    assert.equal(advanced, false)
    assert.equal(service.overview().runs[0].status, 'attention')
  })
})

test('CBA exhausts editor retries inside the real coordinator before any TTS or render command', async t => {
  let launches = 0
  const commands: string[] = []
  const { service, root, job, writeJob } = await fixture(t, {
    launch: () => {
      launches++
      return { done: Promise.resolve(1), failureMessage: () => '模型服务请求频率受限', stop() {} }
    },
    pipeline: async (directory, runId, deps) => {
      const { runCbaProductionPipeline } = await import('./cba-production-pipeline.js')
      return runCbaProductionPipeline(directory, runId, { ...deps,
        command: async args => { commands.push(args[0]!) },
        gates: {
          editorialDigest: current => current.news.summary,
          validateJob: () => ({ errors: ['测试：稿件尚未完成'] }),
          prepareEditorialAudit: async () => { assert.fail('failed editing must not reach audit') },
          validateEditorialAudit: () => ({ valid: false, errors: ['审核未完成'] }),
        },
      })
    },
  })
  job.status = 'needs_edit'; job.outputs = null; writeJob()
  const mediaHash = fileHash(job.media[0].path)
  await service.resume(jobId, { requestId: 'exhaust-editor-retries' }); await service.waitForIdle()
  assert.equal(launches, 3)
  assert.deepEqual(commands, ['acquire-media'])
  assert.equal(fileHash(job.media[0].path), mediaHash)
  const journal = JSON.parse(fs.readFileSync(path.join(root, jobId, 'production.json'), 'utf8'))
  assert.equal(journal.stage, 'writing')
  assert.match(journal.message, /连续3次未完成/)
  assert.equal(service.detail(jobId).status, 'attention')
  assert.equal(service.detail(jobId).canResume, true)
})

test('missing Migu search evidence overrides an old no-recording blocker and persisted failure', async t => {
  const { service, root, job, writeJob } = await fixture(t)
  job.status = 'waiting_for_media'; job.outputs = null; job.media = []
  delete job.mediaSearch
  job.mediaBlocker = '未取得完整比赛录像，请用户补充文件。'; writeJob()
  assert.match(service.detail(jobId).message, /尚未完成咪咕首页检索/)
  fs.writeFileSync(path.join(root, '.console.json'), JSON.stringify({ version: 1, settings: { autoUpload: false, targets: ['baijiahao-video'] }, runs: [], uploads: [], validationFailures: { [jobId]: { stage: 'rendering', message: '视频制作尚未完成', detectedAt: new Date().toISOString() } } }))
  const detail = service.detail(jobId)
  assert.equal(detail.stage, 'finding_media')
  assert.match(detail.message, /尚未完成咪咕首页检索/)
  assert.doesNotMatch(detail.message, /请用户补充|未取得完整比赛录像/)
})

test('partial Migu searches remain incomplete and expose only safe candidate page links', async t => {
  const { service, job, writeJob } = await fixture(t)
  job.status = 'waiting_for_media'; job.outputs = null; job.media = []
  job.mediaBlocker = '咪咕检索尚未完成，部分请求超时；已保留候选，请继续检索。'
  job.mediaSearch = { provider: 'migu', status: 'partial', completed: false, requests: [{ query: '南京 广东', page: 1, status: 'failed', resultCount: 0 }], candidates: [
    { title: '南京广东比赛回放', url: 'https://www.miguvideo.com/p/detail/123?token=private', verified: false },
    { title: '重复候选', url: 'https://www.miguvideo.com/p/detail/123', verified: false },
    { title: '媒体地址', url: 'https://www.miguvideo.com/video.m3u8?token=private', verified: false },
    { title: '外部地址', url: 'https://example.com/p/detail/123', verified: false },
    { title: '伪造主机', url: 'https://www.miguvideo.com.evil.example/p/detail/123', verified: false },
    { title: '凭据地址', url: 'https://name:secret@www.miguvideo.com/p/detail/124', verified: false },
  ] }
  writeJob()
  const detail = service.detail(jobId)
  assert.match(detail.message, /检索尚未完成/)
  assert.doesNotMatch(detail.message, /没有录像|未找到/)
  assert.deepEqual(detail.sources, [{ title: '测试报道', url: 'https://example.com/news' }, { title: '咪咕候选（待核验）：南京广东比赛回放', url: 'https://www.miguvideo.com/p/detail/123' }])
})

test('existing media and completed videos do not require a new search report', async t => {
  const { service, job, writeJob } = await fixture(t)
  delete job.mediaSearch; writeJob()
  assert.equal(service.detail(jobId).status, 'ready')
  assert.doesNotMatch(service.detail(jobId).message, /尚未完成咪咕/)
  job.status = 'needs_edit'; job.outputs = null; job.media = [{ id: 'replay', kind: 'full_replay' }]
  job.blockers = ['核实最后一节关键回合']; writeJob()
  assert.match(service.detail(jobId).message, /核实最后一节关键回合/)
  assert.doesNotMatch(service.detail(jobId).message, /尚未完成咪咕/)
})

test('production command grants network inside workspace sandbox and uses task-local temporary files', () => {
  const command = buildCbaExecutorCommand('/project', '/project/data/cba-video', '-', { PATH: '/tools', HOME: '/home/test' })
  assert.equal(command.file, 'codex')
  assert.ok(command.args.includes('workspace-write'))
  assert.ok(command.args.includes('approval_policy="never"'))
  assert.ok(command.args.includes('sandbox_workspace_write.network_access=true'))
  assert.ok(!command.args.includes('--approve-for-me'), 'Codex rejects --approve-for-me combined with --sandbox')
  assert.ok(!command.args.includes('danger-full-access'))
  assert.ok(!command.args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.equal(command.env.TMPDIR, '/project/data/cba-video/.tmp')
  assert.equal(command.env.HOME, '/home/test')
  assert.equal(command.env.PATH, '/tools')
})

test('resume scopes pipeline to the selected job and preserves explicit highlights policy without discovery', async t => {
  const produced: Array<{ directory: string; scope: string }> = []
  const { service, root, job, writeJob } = await fixture(t, {
    launch: () => { assert.fail('existing-job resume must not launch discovery') },
    pipeline: async directory => {
      produced.push({ directory, scope: JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8')).profile.sourceScope })
      return { ready: false, stage: 'finding_media', message: '测试素材仍待获取' }
    },
  })
  job.profile.sourceScope = 'highlights'
  job.status = 'waiting_for_media'; job.outputs = null; job.media = []; writeJob()
  await service.resume(jobId, { requestId: 'scoped-highlights' }); await service.waitForIdle()
  assert.deepEqual(produced, [{ directory: path.join(root, jobId), scope: 'highlights' }])
})

test('delivery refuses hash-matching invalid videos, silent videos, invalid covers and missing subtitles', async t => {
  for (const mode of ['invalid-video', 'silent-video', 'invalid-cover', 'missing-subtitles', 'wrong-duration']) {
    let calls = 0
    const { service, job, writeJob } = await fixture(t, { runtime: runtime({ runSocialUpload: async payload => { calls++; return receipt(payload) } }) })
    const video = job.outputs.news.path, cover = job.outputs.news.coverPath
    if (mode === 'invalid-video') fs.writeFileSync(video, 'not a video, but the matching hash must not make it valid')
    if (mode === 'silent-video') execFileSync('ffmpeg', ['-v','error','-y','-i',job.media[0].path,'-an','-c:v','copy',video])
    if (mode === 'invalid-cover') fs.writeFileSync(cover, 'not an image')
    if (mode === 'missing-subtitles') fs.unlinkSync(job.outputs.news.subtitlePath)
    if (mode === 'wrong-duration') job.outputs.news.duration = 99
    for (const artifact of job.outputs.artifacts) if (fs.existsSync(artifact.path)) artifact.sha256 = fileHash(artifact.path)
    writeJob()
    await service.upload(jobId, { requestId: `bad-delivery-${mode}`, targets: ['tencent-video'] }); await service.waitForIdle()
    assert.equal(calls, 0, `${mode} must not reach upload`)
    assert.equal(service.detail(jobId).status, 'attention')
    assert.equal(service.detail(jobId).canResume, true)
  }
})

test('matching approval digests cannot bypass factual verification or changed source media', async t => {
  for (const mode of ['unverified-fact', 'unconfirmed-media', 'changed-source']) {
    let calls = 0
    const { service, job, reapprove } = await fixture(t, { runtime: runtime({ runSocialUpload: async payload => { calls++; return receipt(payload) } }) })
    if (mode === 'unverified-fact') job.facts[0].verified = false
    if (mode === 'unconfirmed-media') job.media[0].matchConfirmed = false
    if (mode === 'changed-source') fs.appendFileSync(job.media[0].path, 'changed-source')
    await reapprove()
    await service.upload(jobId, { requestId: `bad-evidence-${mode}`, targets: ['tencent-video'] }); await service.waitForIdle()
    assert.equal(calls, 0, `${mode} must not reach upload`)
    assert.equal(service.detail(jobId).status, 'attention')
  }
})

test('explicit verified highlights pass delivery validation without pretending to be a full replay', async t => {
  let calls = 0
  const { service, job, reapprove } = await fixture(t, { runtime: runtime({ runSocialUpload: async payload => { calls++; return receipt(payload) } }) })
  job.profile.sourceScope = 'highlights'; job.media[0].kind = 'highlights'
  await reapprove()
  await service.upload(jobId, { requestId: 'verified-highlights-delivery', targets: ['tencent-video'] }); await service.waitForIdle()
  assert.equal(calls, 2)
  assert.equal(service.detail(jobId).status, 'completed')
  assert.equal(job.media[0].kind, 'highlights')
})

test('service restart reconciles original draft checkpoints without uploading or saving again', async t => {
  let initialUploads = 0
  const { service, root } = await fixture(t, { runtime: runtime({
    runSocialUpload: async payload => { initialUploads++; return receipt(payload) },
    confirmSocialUpload: async () => { throw Error('模拟保存成功但网络响应丢失') },
  }) })
  await service.upload(jobId, { requestId: 'lost-save-response', targets: ['baijiahao-video'] }); await service.waitForIdle()
  assert.equal(initialUploads, 2)
  const stateFile = path.join(root, '.console.json'), original = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.ok(original.uploads.every((item: any) => item.status === 'uncertain' && item.dispatched && item.result))
  const checkpoints = new Map<string, SocialUploadResult>(original.uploads.map((item: any) => [item.id, item.result]))
  const reads: string[] = [], reconciled: string[] = []
  const restoredOptions: CbaVideoOptions = { root, autoRecover: true, accounts: accounts(), runtime: runtime({
    inspectSocialUploadCheckpoint: async payload => {
      assert.deepEqual(payload, original.uploads.find((item: any) => item.id === payload.jobId).payload)
      reads.push(payload.jobId)
      const result = checkpoints.get(payload.jobId)!
      return { action: result.saved ? 'complete' : 'reconcile', phase: result.saved ? 'saved' : 'save_requested', message: '原任务检查点', result }
    },
    reconcileSocialUpload: async (payload, staged) => {
      assert.equal(staged.targetId, checkpoints.get(payload.jobId)!.targetId)
      assert.equal(payload.accountName, 'cba_first')
      assert.deepEqual(payload, original.uploads.find((item: any) => item.id === payload.jobId).payload)
      reconciled.push(payload.jobId)
      const result = receipt(payload, true); checkpoints.set(payload.jobId, result); return result
    },
    runSocialUpload: async () => { assert.fail('restart recovery must not upload') },
    confirmSocialUpload: async () => { assert.fail('restart recovery must not save a second draft') },
    resumeSocialUpload: async () => { assert.fail('a saved-draft checkpoint needs read-only reconciliation') },
  }) }
  const restored = new CbaVideoService(restoredOptions)
  try {
    await new Promise<void>(resolve => queueMicrotask(resolve)); await restored.waitForIdle()
    assert.deepEqual(new Set(reads), new Set(original.uploads.map((item: any) => item.id)))
    assert.equal(reconciled.length, 2)
    const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.ok(recovered.uploads.every((item: any) => item.status === 'saved' && item.recoveryCount === 1))
    assert.deepEqual(recovered.uploads.map((item: any) => item.id), original.uploads.map((item: any) => item.id))
    assert.equal(restored.detail(jobId).status, 'completed')
    await restored.upload(jobId, { requestId: 'already-reconciled', targets: ['baijiahao-video'] }); await restored.waitForIdle()
    assert.equal(reconciled.length, 2, 'complete checkpoints should reuse recovered receipts')
    assert.equal(restored.detail(jobId).status, 'completed')
  } finally { restoredOptions.autoRecover = false; await restored.waitForIdle() }
})

test('service refuses a saved receipt with wrong account or missing platform draft identity', async t => {
  for (const mode of ['account', 'draft']) {
    let uploads = 0
    const { service } = await fixture(t, { runtime: runtime({
      runSocialUpload: async payload => { uploads++; return receipt(payload) },
      confirmSocialUpload: async payload => ({ ...receipt(payload, true),
        ...(mode === 'account' ? { accountName: 'wrong_account' } : { draftUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2' }) }),
    }) })
    await service.upload(jobId, { requestId: `invalid-receipt-${mode}`, targets: ['baijiahao-video'] }); await service.waitForIdle()
    assert.equal(uploads, 2)
    assert.equal(service.detail(jobId).status, 'attention')
    assert.ok(service.detail(jobId).uploads.every((item: any) => item.status === 'uncertain'))
    await service.upload(jobId, { requestId: `invalid-receipt-repeat-${mode}`, targets: ['baijiahao-video'] }); await service.waitForIdle()
    assert.equal(uploads, 2, 'an invalid receipt must not authorize reuploading')
  }
})

test('restart recovery schedules a later check during cooldown or while the original child survives', async t => {
  for (const mode of ['cooldown', 'surviving-child']) await t.test(mode, async sub => {
    const { service, root } = await fixture(sub)
    await service.upload(jobId, { requestId: `before-timed-recovery-${mode}`, targets: ['baijiahao-video'] }); await service.waitForIdle()
    const stateFile = path.join(root, '.console.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    const now = Date.now()
    for (const upload of state.uploads) {
      upload.status = mode === 'cooldown' ? 'uncertain' : 'running'
      if (mode === 'cooldown') { upload.recoveryAt = new Date(now - 30_000).toISOString(); upload.recoveryCount = 1 }
    }
    if (mode === 'surviving-child') Object.assign(state.runs[0], { status: 'running', ownerPid: 900001, childPid: 900002 })
    fs.writeFileSync(stateFile, JSON.stringify(state))
    sub.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
    let checks = 0, childRunning = true
    const restoredOptions: CbaVideoOptions = { root, autoRecover: true,
      alive: pid => pid === process.pid || pid === 900002 && childRunning,
      runtime: runtime({
        inspectSocialUploadCheckpoint: async payload => {
          checks++
          return { action: 'complete', phase: 'saved', message: '原草稿已保存', result: state.uploads.find((item: any) => item.id === payload.jobId).result }
        },
        runSocialUpload: async () => { assert.fail('a timed recovery must not reupload') },
        confirmSocialUpload: async () => { assert.fail('a saved checkpoint must not save again') },
        resumeSocialUpload: async () => { assert.fail('a saved checkpoint must not resume a write') },
        reconcileSocialUpload: async () => { assert.fail('a complete checkpoint already proves the saved result') },
      }),
    }
    const restored = new CbaVideoService(restoredOptions)
    try {
      await new Promise<void>(resolve => queueMicrotask(resolve)); await restored.waitForIdle()
      assert.equal(checks, 0)
      if (mode === 'surviving-child') childRunning = false
      sub.mock.timers.tick(59_999); await restored.waitForIdle(); assert.equal(checks, 0)
      sub.mock.timers.tick(1); await restored.waitForIdle()
      assert.equal(checks, 2, 'a scheduled tick must recover the original two uploads without another request')
      const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      assert.ok(recovered.uploads.every((item: any) => item.status === 'saved' && item.recoveryCount === (mode === 'cooldown' ? 2 : 1)))
      if (mode === 'surviving-child') assert.equal(recovered.runs[0].status, 'attention', 'the tick must observe that the original child exited')
    } finally { restoredOptions.autoRecover = false; await restored.waitForIdle(); sub.mock.timers.reset() }
  })
})

test('same upload fingerprint gets a current-version record while preserving old receipts and reusing subsequent requests', async t => {
  const calls: SocialUploadPayload[] = []
  const { service, root, job, reapprove } = await fixture(t, { runtime: runtime({
    runSocialUpload: async payload => { calls.push(payload); return receipt(payload) },
  }) })
  await service.upload(jobId, { requestId: 'version-before-source-update', targets: ['baijiahao-video'] }); await service.waitForIdle()
  const stateFile = path.join(root, '.console.json'), oldRecords = JSON.parse(fs.readFileSync(stateFile, 'utf8')).uploads
  const previousDigest = job.outputs.inputDigest
  const mediaHashes = ['news', 'highlights'].map(kind => fileHash(job.outputs[kind].path))
  assert.equal(calls.length, 2)
  job.sources[0].title = '新增核实后的报道标题；成片内容与平台文案保持相同'
  await reapprove()
  const currentDigest = job.outputs.inputDigest
  assert.notEqual(currentDigest, previousDigest)
  assert.deepEqual(['news', 'highlights'].map(kind => fileHash(job.outputs[kind].path)), mediaHashes)
  await service.upload(jobId, { requestId: 'version-after-source-update', targets: ['baijiahao-video'] }); await service.waitForIdle()
  assert.equal(calls.length, 4)
  const current = JSON.parse(fs.readFileSync(stateFile, 'utf8')).uploads
  assert.equal(current.length, 4)
  for (const old of oldRecords) {
    assert.equal(current.find((item: any) => item.id === old.id).inputDigest, previousDigest)
    const next = current.find((item: any) => item.kind === old.kind && item.inputDigest === currentDigest)
    assert.ok(next)
    assert.equal(next.fingerprint, old.fingerprint)
    assert.notEqual(next.id, old.id)
    assert.equal(next.status, 'saved')
  }
  assert.equal(service.detail(jobId).status, 'completed')
  await service.upload(jobId, { requestId: 'same-new-version-again', targets: ['baijiahao-video'] }); await service.waitForIdle()
  assert.equal(calls.length, 4)
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).uploads.length, 4)
  assert.equal(service.detail(jobId).status, 'completed')
})

test('startup resumes queued undispatched uploads only while their current delivery still validates', async t => {
  for (const mode of ['valid-delivery', 'damaged-delivery']) await t.test(mode, async sub => {
    const { service, root, job, writeJob } = await fixture(sub, { runtime: runtime({
      inspectSocialUploadCheckpoint: async () => ({ action: 'busy', phase: 'locked', message: '模拟派发前服务中断' }),
      runSocialUpload: async () => { assert.fail('the queued fixture must never dispatch') },
    }) })
    await service.upload(jobId, { requestId: `queued-before-restart-${mode}`, targets: ['baijiahao-video'] }); await service.waitForIdle()
    const stateFile = path.join(root, '.console.json'), original = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(original.uploads.length, 2)
    assert.ok(original.uploads.every((item: any) => item.status === 'queued' && item.dispatched === false && !item.result))
    if (mode === 'damaged-delivery') {
      fs.writeFileSync(job.outputs.news.path, 'invalid media container despite a matching artifact hash')
      job.outputs.artifacts.find((item: any) => item.path === job.outputs.news.path).sha256 = fileHash(job.outputs.news.path)
      writeJob()
    }
    assert.equal(job.outputs.inputDigest, original.uploads[0].inputDigest)
    const uploaded: string[] = [], saved: string[] = [], checked: string[] = []
    const recoveringRuntime = runtime({
      runSocialUpload: async payload => { uploaded.push(payload.jobId); return receipt(payload) },
      confirmSocialUpload: async payload => { saved.push(payload.jobId); return receipt(payload, true) },
    })
    const checkpoint = recoveringRuntime.inspectSocialUploadCheckpoint
    recoveringRuntime.inspectSocialUploadCheckpoint = async payload => { checked.push(payload.jobId); return checkpoint(payload) }
    const restoredOptions: CbaVideoOptions = { root, autoRecover: true, accounts: accounts(), runtime: recoveringRuntime }
    const restored = new CbaVideoService(restoredOptions)
    try {
      await new Promise<void>(resolve => queueMicrotask(resolve)); await restored.waitForIdle()
      const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      assert.deepEqual(recovered.uploads.map((item: any) => item.id), original.uploads.map((item: any) => item.id))
      assert.deepEqual(new Set(checked), new Set(original.uploads.map((item: any) => item.id)))
      if (mode === 'valid-delivery') {
        assert.deepEqual(uploaded, original.uploads.map((item: any) => item.id))
        assert.deepEqual(saved, uploaded, 'each original queued upload is dispatched and saved exactly once')
        assert.ok(recovered.uploads.every((item: any) => item.status === 'saved' && item.dispatched))
      } else {
        assert.deepEqual(uploaded, [])
        assert.deepEqual(saved, [])
        assert.equal(checked.length, 2, 'damaged delivery still permits one read-only check for each original upload')
        assert.ok(recovered.uploads.every((item: any) => item.status === 'blocked' && !item.dispatched))
      }
    } finally { restoredOptions.autoRecover = false; await restored.waitForIdle() }
  })
})

test('a stopped queued upload remains stopped after restart until an explicit upload reuses its original identity', async t => {
  const { service, root } = await fixture(t, { runtime: runtime({
    inspectSocialUploadCheckpoint: async () => ({ action: 'busy', phase: 'locked', message: '模拟尚未派发' }),
    runSocialUpload: async () => { assert.fail('the queued fixture must not dispatch') },
  }) })
  const { run: originalRun } = await service.upload(jobId, { requestId: 'queued-before-user-stop', targets: ['baijiahao-video'] }); await service.waitForIdle()
  const stateFile = path.join(root, '.console.json'), original = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.ok(original.uploads.every((item: any) => item.status === 'queued' && !item.dispatched && item.ownerRunId === originalRun.id))
  original.runs.find((run: any) => run.id === originalRun.id).status = 'stopped'
  delete original.uploads[1].ownerRunId // Also preserve the stop policy for legacy upload records.
  fs.writeFileSync(stateFile, JSON.stringify(original))
  const uploaded: string[] = [], saved: string[] = [], checked: string[] = []
  const recoveringRuntime = runtime({
    runSocialUpload: async payload => { uploaded.push(payload.jobId); return receipt(payload) },
    confirmSocialUpload: async payload => { saved.push(payload.jobId); return receipt(payload, true) },
  })
  const checkpoint = recoveringRuntime.inspectSocialUploadCheckpoint
  recoveringRuntime.inspectSocialUploadCheckpoint = async payload => { checked.push(payload.jobId); return checkpoint(payload) }
  const restoredOptions: CbaVideoOptions = { root, autoRecover: true, accounts: accounts(), runtime: recoveringRuntime }
  const restored = new CbaVideoService(restoredOptions)
  try {
    await new Promise<void>(resolve => queueMicrotask(resolve)); await restored.waitForIdle()
    assert.deepEqual(checked, []); assert.deepEqual(uploaded, []); assert.deepEqual(saved, [])
    const { run: continuedRun } = await restored.upload(jobId, { requestId: 'explicit-user-continue-upload', targets: ['baijiahao-video'] }); await restored.waitForIdle()
    const continued = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.deepEqual(continued.uploads.map((item: any) => item.id), original.uploads.map((item: any) => item.id))
    assert.deepEqual(uploaded, original.uploads.map((item: any) => item.id)); assert.deepEqual(saved, uploaded)
    assert.ok(continued.uploads.every((item: any) => item.status === 'saved' && item.ownerRunId === continuedRun.id))
    assert.equal(continued.runs.find((run: any) => run.id === originalRun.id).status, 'stopped')
    assert.equal(restored.detail(jobId).status, 'completed')
  } finally { restoredOptions.autoRecover = false; await restored.waitForIdle() }
})

test('workbench connects news to a match inventory and reports physical source-file loss', async t => {
  const {service,job,writeJob} = await fixture(t)
  let overview: any = service.overview()
  assert.equal(overview.matches.length, 1)
  let detail: any = service.detail(jobId)
  assert.equal(detail.matchLink.status, 'confirmed')
  assert.equal(detail.footage.status, 'ready')
  assert.ok(detail.footage.files[0].previewUrl)
  assert.equal(service.sourceMedia(jobId, 'replay').path, job.media[0].path)
  fs.unlinkSync(job.media[0].path)
  detail = service.detail(jobId)
  assert.equal(detail.footage.status, 'missing')
  assert.ok(detail.news, 'Existing delivered video remains accessible when only source footage is missing')
  assert.throws(() => service.sourceMedia(jobId, 'replay'), /素材.*(?:缺失|不可用)/)
  assert.ok(detail.quality.warnings.some((warning: string) => /30/.test(warning)), 'Old short videos get a visible warning without rewriting delivery')
})

test('news-only, highlights-only and both are explicit production modes with idempotent requests', async t => {
  const {service} = await fixture(t, {launch: () => ({done: Promise.resolve(0), stop() {}})})
  const result: any = await service.start({requestId: 'mode-highlights', autoUpload: false, productionMode: 'highlights'})
  assert.equal(result.run.productionMode, 'highlights')
  await service.waitForIdle()
  const duplicate: any = await service.start({requestId: 'mode-highlights', autoUpload: false, productionMode: 'highlights'})
  assert.equal(duplicate.reused, true)
  await assert.rejects(service.start({requestId: 'mode-highlights', autoUpload: false, productionMode: 'news'}), /请求编号/)
})

test('explicit production mode controls the planned editions and one highlights job per match', async t => {
  for (const mode of ['news','highlights','both'] as const) {
    const planned: Array<{id:string; editions:string[]}> = []
    let root = ''
    const f = await fixture(t, {
      captureHomepage: async () => null,
      launch: prompt => {
        const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]
        const folder = path.join(root,'batches',runId); fs.mkdirSync(folder,{recursive:true})
        fs.writeFileSync(path.join(folder,'intake.json'), JSON.stringify({items:[0,1].map(index => ({url:`https://example.com/mode-${index}`,title:`新闻${index}`,status:'researched',jobDir:path.join(root,`${jobId}-mode-${index}`)}))}))
        return {done:Promise.resolve(0),stop(){}}
      },
      pipeline: async directory => {
        const job = JSON.parse(fs.readFileSync(path.join(directory,'job.json'),'utf8'))
        planned.push({id:path.basename(directory),editions:job.profile.editions})
        return {ready:false,stage:'writing',message:'测试只检查制作计划，不调用模型和配音'}
      },
    }); root = f.root
    for (let index=0;index<2;index++) {
      const job = structuredClone(f.job); job.outputs=null; job.approval=null; job.review=null; job.status='needs_edit'
      job.match.seedUrls=[`https://example.com/mode-${index}`]
      const dir=path.join(root,`${jobId}-mode-${index}`);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'job.json'),JSON.stringify(job))
    }
    await f.service.start({requestId:`mode-plan-${mode}`,autoUpload:false,productionMode:mode});await f.service.waitForIdle()
    assert.deepEqual(planned.map(item=>item.editions),mode==='news'?[['news'],['news']]:mode==='highlights'?[['highlights']]:[['news','highlights'],['news']])
  }
})

test('news mode reuses the requested delivery when the unselected highlights output is missing', async t => {
  let root='', checked=false
  const f=await fixture(t,{captureHomepage:async()=>null,launch:prompt=>{
    const runId=/batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1],folder=path.join(root,'batches',runId)
    fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'intake.json'),JSON.stringify({items:[{url:'https://example.com/news',title:'报道',status:'researched',jobDir:path.join(root,jobId)}]}))
    return {done:Promise.resolve(0),stop(){}}
  },pipeline:async (_directory,_runId,deps)=>{
    assert.deepEqual(deps.defaultEditions,['news'])
    assert.equal(await deps.verifyDelivery(),null,'Unselected highlights file must not trigger extra production')
    checked=true;return {ready:true,stage:'rendering',message:'reused'}
  }});root=f.root
  fs.unlinkSync(f.job.outputs.highlights.path)
  const before=fs.readFileSync(f.jobFile,'utf8')
  await f.service.start({requestId:'subset-news',autoUpload:false,productionMode:'news'});await f.service.waitForIdle()
  assert.equal(checked,true);assert.equal(f.service.overview().runs[0].status,'completed')
  assert.equal(fs.readFileSync(f.jobFile,'utf8'),before,'Reusing one edition does not rewrite original approval or profile')
})

test('highlights intake links distinct news to one explicitly confirmed match without requiring duplicate primary seeds', async t => {
  let root='', launches=0, produced=0
  const items=[{url:'https://example.com/news',title:'报道一'},{url:'https://example.com/another-news',title:'报道二'}]
  const f=await fixture(t,{
    captureHomepage:async()=>({version:2,entryUrl:'https://bbs.hupu.com/cba-hot',retrievedAt:'2026-11-01T00:00:00Z',scope:'test',total:2,items}),
    launch:prompt=>{
      launches++;const runId=/batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]
      const filename=path.join(root,'batches',runId,'intake.json'), intake=JSON.parse(fs.readFileSync(filename,'utf8'))
      intake.items=intake.items.map((row:any)=>({...row,status:'researched',matchId:jobId,matchEvidence:{status:'confirmed',reason:'原文日期和双方一致',sourceExcerpt:'南京对广东'},jobDir:path.join(root,jobId)}))
      fs.writeFileSync(filename,JSON.stringify(intake));return {done:Promise.resolve(0),stop(){}}
    },pipeline:async()=>{produced++;return {ready:false,stage:'writing',message:'仅验证计划'}}
  });root=f.root;f.job.outputs=null;f.job.approval=null;f.job.status='needs_edit';f.writeJob()
  const result=await f.service.start({requestId:'shared-intake',autoUpload:false,productionMode:'highlights'});await f.service.waitForIdle()
  const intake=JSON.parse(fs.readFileSync(path.join(root,'batches',result.run.id,'intake.json'),'utf8'))
  assert.equal(launches,1);assert.equal(produced,1)
  assert.deepEqual(intake.items.map((row:any)=>row.status),['researched','researched'])
})

test('related reports merge into one commentary only with confirmed match and cited source coverage', async t => {
  for (const scenario of ['valid', 'no-explicit-merge', 'different-match', 'missing-text', 'unused-source', 'unknown-segment'] as const) await t.test(scenario, async sub => {
    const primary = 'https://example.com/news', related = 'https://example.com/postgame-interview'
    const items = [{url: primary, title: '赛果'}, {url: related, title: '赛后采访'}]
    let f: Awaited<ReturnType<typeof fixture>>, productions = 0, ready = false
    f = await fixture(sub, {
      captureHomepage: async () => ({total: items.length, items}),
      launch: prompt => {
        const runId = /batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1]!
        const file = path.join(f.root, 'batches', runId, 'intake.json')
        const intake = JSON.parse(fs.readFileSync(file, 'utf8'))
        intake.items = intake.items.map((row: any, index: number) => ({...row,
          status: index ? 'merged' : 'researched', jobDir: path.join(f.root, jobId),
          ...(index ? {
            ...(scenario !== 'no-explicit-merge' ? {mergedInto: primary} : {}),
            reason: '同场赛后采访用于解释本期内线搭配，与赛果合成完整评论。',
            matchId: scenario === 'different-match' ? 'another-match' : jobId,
            matchEvidence: {status: 'confirmed', reason: '日期、双方与赛果一致', sourceExcerpt: '南京对广东'},
            segmentIds: [scenario === 'unknown-segment' ? 'missing' : 'interview'],
          } : {}),
        }))
        fs.writeFileSync(file, JSON.stringify(intake))
        return {done: Promise.resolve(0), stop() {}}
      },
      pipeline: async () => {productions++; ready = true; return {ready: true, stage: 'rendering', message: 'test production'}},
    })
    f.job.profile.editions = ['news']; f.job.profile.narrationPolicy = 'xiaolu-commentator-v1'
    f.job.outputs = null; f.job.approval = null; f.job.status = 'needs_edit'
    f.job.sources.push({id: 'interview-source', url: related, text: scenario === 'missing-text' ? '' : '球员赛后表示与内线搭档沟通顺畅。'})
    f.job.facts.push({id: 'interview-fact', text: '内线搭档沟通顺畅', sourceIds: ['interview-source'], verified: true})
    f.job.news.segments.push({id: 'interview', mode: 'narration', text: '球员赛后说，两人的沟通更顺畅。',
      factIds: [scenario === 'unused-source' ? 'score' : 'interview-fact'], clipIds: ['play']})
    f.writeJob()
    // This test covers news association; factual review and file validation have separate real-media tests.
    sub.mock.method(f.service as any, 'validateDelivery', async () => ready ? null : {stage: 'writing', message: 'not produced'})
    const {run} = await f.service.start({requestId: `commentary-merge-${scenario}`, autoUpload: false, productionMode: 'news'})
    await f.service.waitForIdle()
    const intake = JSON.parse(fs.readFileSync(path.join(f.root, 'batches', run.id, 'intake.json'), 'utf8'))
    assert.equal(productions, 1)
    assert.equal(intake.items[1].status, scenario === 'valid' ? 'merged' : 'needs_research')
    assert.deepEqual(f.service.overview().runs[0].jobIds, [jobId])
    assert.equal(f.service.overview().runs[0].status, scenario === 'valid' ? 'completed' : 'attention')
    assert.equal(f.service.overview().jobs.length, scenario === 'valid' ? 1 : 2)
  })
})

test('a highlights-only task can be deleted using its displayed highlights title', async t => {
  const f=await fixture(t);f.job.profile.editions=['highlights'];delete f.job.news;f.writeJob()
  const title=f.service.overview().jobs[0].title
  assert.equal(title,f.job.highlights.title)
  assert.equal(f.service.deleteTask(jobId,{confirm:true,expectedTitle:title}).deleted,true)
})

test('a damaged selected edition gets a separate v2 task while the old other edition and approval stay intact', async t => {
  let root='', producedId=''
  const f=await fixture(t,{captureHomepage:async()=>null,launch:prompt=>{
    const runId=/batches\/(run-[\w-]+)\/intake\.json/.exec(prompt)![1],folder=path.join(root,'batches',runId)
    fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'intake.json'),JSON.stringify({items:[{url:'https://example.com/news',title:'报道',status:'researched',jobDir:path.join(root,jobId)}]}))
    return {done:Promise.resolve(0),stop(){}}
  },pipeline:async directory=>{
    producedId=path.basename(directory)
    const job=JSON.parse(fs.readFileSync(path.join(directory,'job.json'),'utf8'))
    assert.deepEqual(job.profile.editions,['news']);assert.equal(job.outputs,null)
    return {ready:false,stage:'writing',message:'仅验证新版本隔离'}
  }});root=f.root
  fs.writeFileSync(f.job.outputs.news.path,'damaged-video')
  const before=fs.readFileSync(f.jobFile,'utf8'),highlightHash=fileHash(f.job.outputs.highlights.path)
  await f.service.start({requestId:'damaged-subset',autoUpload:false,productionMode:'news'});await f.service.waitForIdle()
  assert.equal(producedId,`${jobId}-v2-news`)
  assert.equal(fs.readFileSync(f.jobFile,'utf8'),before)
  assert.equal(fileHash(f.job.outputs.highlights.path),highlightHash)
})
