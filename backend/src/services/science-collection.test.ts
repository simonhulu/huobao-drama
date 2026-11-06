import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { ScienceCollectionService, scienceCollectionSettingsSchema, type ScienceCollectionMode, type ScienceCollectionOptions } from './science-collection.js'
import { ScienceWorkflowError, type ScienceJob } from './science-workflow.js'
import type { HistoryYoutubeCandidate, HistoryYoutubeCollectionOptions } from './history-source-youtube.js'

const channels = ['https://www.youtube.com/@ScienceOne/videos', 'https://www.youtube.com/@ScienceTwo/videos']
const videoId = (number: number) => `video${String(number).padStart(6, '0')}`
function candidate(number: number, channel = channels[0]!): HistoryYoutubeCandidate {
  return { videoId: videoId(number), sourceUrl: `https://www.youtube.com/watch?v=${videoId(number)}`, title: `科学问题 ${number}`,
    authorName: 'Source', observedAt: '2026-10-28T00:00:00Z', collectionUrl: channel }
}
function baseJob(source: HistoryYoutubeCandidate, fields: Partial<ScienceJob> = {}): ScienceJob {
  return { id: `science-${randomUUID()}`, title: source.title, sourceUrl: source.sourceUrl, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z',
    status: 'draft', stage: 'download', message: 'queued', transcript: '', script: '', factChecks: [], sources: [source.sourceUrl],
    huashengAccountName: 'hs-one', baijiahaoAccountName: 'bj-one', projectUrl: null, sourceVideoUrl: null, videoUrl: null,
    landscapeCoverUrl: null, portraitCoverUrl: null, checkpoint: null,
    logs: [], upload: null, hasUploadAttempt: false, ...fields }
}
async function stream(options: HistoryYoutubeCollectionOptions, candidates: HistoryYoutubeCandidate[]) {
  let scanned = 0
  for (const source of candidates) {
    options.signal.throwIfAborted()
    if (options.isTargetReached()) return
    scanned++
    const known = options.isKnownVideo(source.videoId)
    options.report({ stage: known ? 'skipping' : 'selecting', message: known ? '已保存，跳过' : '发现视频', scanned,
      candidate: { outcome: known ? 'skipped' : 'selected', videoId: source.videoId } })
    if (!known) await options.onCandidate(source)
  }
  options.report({ stage: 'exhausted', message: '频道已读完', scanned })
}
function fixture(t: any, config: {
  lists?: Record<string, HistoryYoutubeCandidate[]>
  run?: (job: ScienceJob, mode: ScienceCollectionMode, signal: AbortSignal) => Promise<void>
  collect?: ScienceCollectionOptions['collect']
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-collection-'))
  const jobs = new Map<string, ScienceJob>()
  const calls: Array<{ id: string; mode: ScienceCollectionMode; hs: string | null; bj: string | null }> = []
  const canceled: string[] = []
  const visited: string[] = []
  const defaultAccounts = { hs: 'hs-one', bj: 'bj-one' }
  let creates = 0
  const workflow: NonNullable<ScienceCollectionOptions['workflow']> = {
    create(input, options = {}) {
      const previous = [...jobs.values()].find(job => job.sourceUrl === input.sourceUrl)
      if (previous) return structuredClone(previous)
      assert.equal(options.defer, true)
      const job = baseJob({ ...candidate(0), sourceUrl: input.sourceUrl, title: input.title || 'untitled' }, {
        huashengAccountName: input.huashengAccountName ?? null, baijiahaoAccountName: input.baijiahaoAccountName ?? null,
        collectionId: options.collectionId, sourceChannel: options.sourceChannel,
      })
      jobs.set(job.id, job); creates++; return structuredClone(job)
    },
    knownYoutubeIds() { return new Set([...jobs.values()].map(job => new URL(job.sourceUrl).searchParams.get('v')!)) },
    jobsForCollection(id) { return structuredClone([...jobs.values()].filter(job => job.collectionId === id)) },
    cancel(id) {
      canceled.push(id)
      const job = jobs.get(id)!
      job.status = 'paused'; job.automaticRetry = undefined; job.uploadRetry = undefined
      return structuredClone(job)
    },
    validateBatchAccounts(mode, hs, bj) {
      hs = hs === undefined ? defaultAccounts.hs : hs; bj = bj === undefined ? defaultAccounts.bj : bj
      if (mode !== 'drafts' && !hs) throw new ScienceWorkflowError('请选择华生账号')
      if (mode === 'upload' && !bj) throw new ScienceWorkflowError('请选择百家号账号')
      return { huashengAccountName: hs || null, baijiahaoAccountName: bj || null }
    },
    async runBatchJob(id, mode, signal) {
      signal.throwIfAborted()
      const job = jobs.get(id)!
      calls.push({ id, mode, hs: job.huashengAccountName, bj: job.baijiahaoAccountName })
      await config.run?.(job, mode, signal)
      signal.throwIfAborted()
      job.transcript = '完整原稿'; job.script = '完整中文科普二创稿'; job.status = 'draft'; job.stage = 'produce'; job.message = 'done'
      if (mode !== 'drafts') { job.videoUrl = `/assets/${job.id}.mp4`; job.status = 'ready'; job.stage = 'export' }
      if (mode === 'upload') { job.status = 'completed'; job.stage = 'completed'; job.upload = { accountName: job.baijiahaoAccountName!, staged: true, saved: false,
        submitted: true, publicationStatus: 'submitted', articleId: '123', publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=123', published: false,
        editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', targetId: 'abc123', engine: 'test' } }
      return structuredClone(job)
    },
  }
  const options: ScienceCollectionOptions = { stateRoot: root, workflow,
    collect: async options => { visited.push(options.url); if (config.collect) return config.collect(options); await stream(options, config.lists?.[options.url] || []) },
  }
  const service = new ScienceCollectionService(options)
  service.saveSettings({ youtubeChannels: channels, targetCount: 2, mode: 'videos' })
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, service, workflow, options, jobs, calls, canceled, visited, defaultAccounts, creates: () => creates,
    state: (id: string) => path.join(root, 'runs', `${id}.json`) }
}
const done = async (h: ReturnType<typeof fixture>, request: Record<string, unknown> = {}) => {
  const initial = h.service.start({ requestId: randomUUID(), ...request }); await h.service.waitForIdle()
  return h.service.overview().runs.find(run => run.id === initial.id)!
}

test('channel settings normalize, persist and reject video URLs, duplicate handles and arbitrary URLs', t => {
  const h = fixture(t)
  const saved = h.service.saveSettings({ youtubeChannels: ['https://m.youtube.com/@ScienceOne/?tracking=1'], targetCount: null, mode: 'drafts' })
  assert.deepEqual(saved.youtubeChannels, [channels[0]])
  assert.deepEqual(new ScienceCollectionService(h.options).overview().settings, saved)
  for (const youtubeChannels of [[candidate(1).sourceUrl], ['https://evil.example/@Science'], ['https://youtube.com/@SCIENCE', 'https://www.youtube.com/@science/videos']])
    assert.equal(scienceCollectionSettingsSchema.safeParse({ ...saved, youtubeChannels }).success, false)
  assert.throws(() => h.service.saveSettings({ targetCount: 0 }))
  assert.throws(() => h.service.saveSettings({ unexpected: true }))
  h.service.saveSettings({ youtubeChannels: [] })
  assert.throws(() => h.service.start({ requestId: 'empty' }), /至少一个/)
})

test('deleted tasks leave batch retry scope and never get produced or counted as completed', async t => {
  let fail = true
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)] }, run: async () => { if (fail) throw new Error('temporary failure') } })
  const run = await done(h, { targetCount: null })
  assert.equal(run.counts.failed, 2)
  const deleted = h.jobs.get(run.items[0]!.jobId)!
  deleted.deletedAt = new Date().toISOString()
  const overview = h.service.overview().runs.find(item => item.id === run.id)!
  assert.equal(overview.items[0]!.status, 'deleted')
  assert.equal(overview.counts.failed, 1)
  fail = false; h.calls.length = 0
  const retry = h.service.retry(run.id, {})
  assert.deepEqual(retry.retry?.jobIds, [run.items[1]!.jobId])
  await h.service.waitForIdle()
  const result = h.service.overview().runs.find(item => item.id === run.id)!
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.completed, 1)
  assert.equal(result.items[0]!.status, 'deleted')
  assert.deepEqual(h.calls.map(call => call.id), [run.items[1]!.jobId])
  assert.equal(h.creates(), 2)
})

test('a task removed after retry was queued is skipped when that batch resumes', async t => {
  let fail = true
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { if (fail) throw new Error('temporary failure') } })
  const run = await done(h, { targetCount: null })
  h.calls.length = 0; fail = false
  h.service.retry(run.id, {})
  h.jobs.get(run.items[0]!.jobId)!.deletedAt = new Date().toISOString()
  await h.service.waitForIdle()
  const result = h.service.overview().runs.find(item => item.id === run.id)!
  assert.equal(result.status, 'completed')
  assert.equal(result.items[0]!.status, 'deleted')
  assert.equal(result.counts.completed, 0)
  assert.equal(result.counts.failed, 0)
  assert.equal(h.calls.length, 0)
})

test('removing a finished task preserves the batch delivery count and cannot trigger replacement work', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] } })
  const run = await done(h, { targetCount: 1 })
  h.jobs.get(run.items[0]!.jobId)!.deletedAt = new Date().toISOString()
  const result = h.service.overview().runs.find(item => item.id === run.id)!
  assert.equal(result.items[0]!.status, 'deleted')
  assert.equal(result.counts.completed, 1)
  assert.equal(h.service.retry(run.id, {}).retry, undefined)
  assert.equal(h.calls.length, 1)
  assert.equal(h.creates(), 1)
})

test('deleting a task already waiting inside the workflow advances the batch without a failure', async t => {
  let entered!: () => void, release!: () => void
  const pending = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)] }, run: async job => {
    if (job.sourceUrl !== candidate(1).sourceUrl) return
    entered(); await held
    if (job.deletedAt) throw new ScienceWorkflowError('科普任务已删除', 404)
  } })
  const run = h.service.start({ requestId: randomUUID(), targetCount: 2 })
  await pending
  h.jobs.get(h.calls[0]!.id)!.deletedAt = new Date().toISOString()
  release(); await h.service.waitForIdle()
  const result = h.service.overview().runs.find(item => item.id === run.id)!
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.failed, 0)
  assert.equal(result.counts.completed, 1)
  assert.equal(result.items[0]!.status, 'deleted')
  assert.equal(result.items[1]!.status, 'completed')
})

test('multiple saved channels skip old and cross-channel videos, then produce the successful target automatically', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)], [channels[1]!]: [candidate(2), candidate(3), candidate(4)] } })
  const known = baseJob(candidate(1)); h.jobs.set(known.id, known)
  const run = await done(h)
  assert.equal(run.status, 'completed'); assert.equal(run.counts.completed, 2); assert.equal(run.counts.selected, 2)
  assert.equal(run.counts.skipped, 2); assert.deepEqual(h.visited, channels)
  assert.deepEqual(run.items.map(item => item.videoId), [videoId(2), videoId(3)])
  assert.equal(h.calls.length, 2); assert.ok(h.calls.every(call => call.mode === 'videos'))
  assert.equal(h.creates(), 2); assert.equal('ownerPid' in run, false)
  const another = await done(h, { targetCount: 1 })
  assert.deepEqual(another.items.map(item => item.videoId), [videoId(4)])
  assert.equal(h.calls.length, 3)
})

test('all three output modes are forwarded and wait for their actual outputs', async t => {
  for (const mode of ['drafts', 'videos', 'upload'] as const) {
    const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] } })
    const run = await done(h, { mode, targetCount: 1 })
    assert.equal(run.counts.completed, 1); assert.equal(h.calls[0]!.mode, mode)
    const result = h.jobs.get(run.items[0]!.jobId)!
    assert.equal(Boolean(result.script), true)
    assert.equal(Boolean(result.videoUrl), mode !== 'drafts')
    assert.equal(Boolean(result.upload?.submitted), mode === 'upload')
  }
})

test('failed production keeps the collected source target and a bad channel does not prevent the next channel', async t => {
  const h = fixture(t, {
    collect: async options => { if (options.url === channels[0]) throw new Error('channel unavailable'); await stream(options, [candidate(1), candidate(2), candidate(3)]) },
    run: async job => { if (job.sourceUrl === candidate(1).sourceUrl) throw new Error('video failed token=SECRET') },
  })
  const run = await done(h, { targetCount: 3 })
  assert.equal(run.counts.completed, 2); assert.equal(run.counts.failed, 1); assert.equal(run.counts.selected, 3)
  assert.equal(run.channelErrors.length, 1); assert.equal(h.calls.length, 3); assert.equal(run.status, 'needs_attention')
  assert.equal(run.collection?.status, 'needs_attention'); assert.equal(run.processing?.status, 'needs_attention')
  assert.doesNotMatch(JSON.stringify(run), /SECRET/)
  const shortage = await done(h, { targetCount: 5 })
  assert.equal(shortage.status, 'needs_attention'); assert.match(shortage.collection!.message, /已入库 0\/5/)
})

test('request id is idempotent across settings changes and snapshots never inherit newer accounts', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] } })
  const run = h.service.start({ requestId: 'same', targetCount: 1 })
  h.service.saveSettings({ youtubeChannels: [channels[1]!], mode: 'upload', huashengAccountName: 'hs-two', baijiahaoAccountName: 'bj-two' })
  h.defaultAccounts.hs = 'hs-three'; h.defaultAccounts.bj = 'bj-three'
  assert.equal(h.service.start({ requestId: 'same', targetCount: 1 }).id, run.id)
  assert.throws(() => h.service.start({ requestId: 'same', targetCount: 2 }), /不同设置/)
  await h.service.waitForIdle()
  const result = h.service.overview().runs[0]!
  assert.deepEqual(result.youtubeChannels, channels); assert.equal(result.mode, 'videos')
  assert.equal(result.huashengAccountName, 'hs-one'); assert.equal(result.baijiahaoAccountName, 'bj-one')
  assert.equal(h.calls[0]!.hs, 'hs-one'); assert.equal(h.calls[0]!.bj, 'bj-one')
  assert.equal(h.service.start({ requestId: 'same', targetCount: 1 }).id, run.id); assert.equal(h.calls.length, 1)
})

test('stop remains stopping until the active handle ends; resume skips completed items and keeps original accounts', async t => {
  let started!: () => void, release!: () => void, stopped = false, secondAttempts = 0
  const waiting = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)] }, run: async (job, _mode, signal) => {
    if (job.sourceUrl !== candidate(2).sourceUrl || secondAttempts++) return
    signal.addEventListener('abort', () => { stopped = true }, { once: true }); started(); await held; signal.throwIfAborted()
  } })
  const run = h.service.start({ requestId: 'stop-test' }); await waiting
  const secondService = new ScienceCollectionService(h.options)
  assert.equal(secondService.overview().activeRun?.id, run.id)
  assert.equal(secondService.overview().activeCollection, null)
  assert.equal(secondService.stopRun(run.id).status, 'stopping'); assert.equal(stopped, true)
  assert.equal(h.service.overview().activeRun?.status, 'stopping')
  release(); await h.service.waitForIdle()
  assert.equal(h.service.overview().runs[0]!.status, 'stopped'); assert.equal(h.service.overview().runs[0]!.counts.completed, 1)
  h.defaultAccounts.hs = 'new-default'; h.service.saveSettings({ youtubeChannels: [channels[1]!] })
  secondService.resume(run.id); await secondService.waitForIdle()
  const result = secondService.overview().runs[0]!
  assert.equal(result.status, 'completed'); assert.equal(result.counts.completed, 2)
  assert.equal(h.calls.filter(call => call.id === result.items[0]!.jobId).length, 1)
  assert.ok(h.calls.every(call => call.hs === 'hs-one')); assert.equal(h.creates(), 2)
})

test('restart restores a task created before its batch item checkpoint without duplicating an already finished output', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { throw new Error('initial failure') } })
  const run = await done(h, { targetCount: 1 })
  const job = h.jobs.get(run.items[0]!.jobId)!
  job.script = '已完成的文稿'; job.videoUrl = '/saved-output.mp4'; job.status = 'ready'
  const file = h.state(run.id), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(stored, { status: 'running', processing: { status: 'running', message: '正在恢复制作' }, ownerPid: 99999999, items: [], currentJobId: job.id })
  fs.writeFileSync(file, JSON.stringify(stored)); fs.writeFileSync(path.join(h.root, 'worker.lock'), JSON.stringify({ pid: 99999999, token: 'stale' }))
  const restarted = new ScienceCollectionService(h.options)
  assert.equal(restarted.overview().runs[0]!.status, 'interrupted')
  assert.equal(h.calls.length, 1, 'reading an interrupted run must not restart production')
  restarted.resume(run.id); await restarted.waitForIdle()
  assert.equal(restarted.overview().runs[0]!.counts.completed, 1); assert.equal(restarted.overview().runs[0]!.items[0]!.jobId, job.id)
  assert.equal(h.calls.length, 1); assert.equal(h.creates(), 1)
})

test('service shutdown preserves automatic batch recovery and resumes the original unfinished task', async t => {
  let entered!: () => void, held = false
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)] }, run: async (job, _mode, signal) => {
    if (job.sourceUrl !== candidate(2).sourceUrl || held) return
    held = true; entered()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const run = h.service.start({ requestId: 'shutdown-recovery' }); await waiting
  await h.service.stop()
  const interrupted = h.service.overview().runs[0]!
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.counts.completed, 1)
  assert.equal(JSON.parse(fs.readFileSync(h.state(run.id), 'utf8')).stopRequested, false)
  const calls = h.calls.length, visits = [...h.visited]
  h.service.saveSettings({ youtubeChannels: [channels[1]!], mode: 'upload', huashengAccountName: 'new-hs', baijiahaoAccountName: 'new-bj' })
  const restarted = new ScienceCollectionService(h.options)
  assert.deepEqual(restarted.runAutomaticRecovery(), [run.id])
  assert.deepEqual(restarted.runAutomaticRecovery(), [])
  await restarted.waitForIdle()
  const recovered = restarted.overview().runs[0]!
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.counts.completed, 2)
  assert.deepEqual(h.calls.slice(calls).map(call => call.id), [interrupted.items[1]!.jobId])
  assert.ok(h.calls.every(call => call.hs === 'hs-one' && call.bj === 'bj-one'))
  assert.deepEqual(h.visited, visits); assert.equal(h.creates(), 2)
})

test('automatic recovery restores crash-orphaned tasks without retrying earlier failures', async t => {
  let recover = false
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)] }, run: async () => {
    if (!recover) throw new Error('original task failed')
  } })
  const run = await done(h, { targetCount: 2 }), file = h.state(run.id)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')), interruptedId = run.items[1]!.jobId
  const job = h.jobs.get(interruptedId)!
  job.status = 'paused'; job.message = '本机执行中断'
  Object.assign(stored, { status: 'running', processing: { status: 'running', message: '正在处理原任务' }, ownerPid: 99999999, currentJobId: interruptedId })
  stored.items[1].status = 'running'
  fs.writeFileSync(file, JSON.stringify(stored)); fs.writeFileSync(path.join(h.root, 'worker.lock'), JSON.stringify({ pid: 99999999, token: 'stale' }))
  recover = true
  const calls = h.calls.length, visits = [...h.visited], restarted = new ScienceCollectionService(h.options)
  assert.deepEqual(restarted.runAutomaticRecovery(), [run.id]); await restarted.waitForIdle()
  const result = restarted.overview().runs[0]!
  assert.deepEqual(h.calls.slice(calls).map(call => call.id), [interruptedId])
  assert.equal(result.items[0]!.status, 'failed'); assert.equal(result.counts.completed, 1)
  assert.equal(h.creates(), 2); assert.deepEqual(h.visited, visits)
})

test('startup batch recovery observes workflow recovery already running without dispatching the same task again', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { throw new Error('initial failure') } })
  const run = await done(h, { targetCount: 1 }), file = h.state(run.id), job = h.jobs.get(run.items[0]!.jobId)!
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(stored, { status: 'running', processing: { status: 'running', message: '正在恢复制作' }, ownerPid: 99999999 }); stored.items[0].status = 'running'
  fs.writeFileSync(file, JSON.stringify(stored))
  Object.assign(job, { status: 'running', executionActive: true, message: '已有工作流正在恢复原任务' })
  const calls = h.calls.length, restarted = new ScienceCollectionService(h.options)
  assert.deepEqual(restarted.runAutomaticRecovery(), [run.id]); await nextTurn()
  assert.equal(h.calls.length, calls, 'the existing workflow must keep exclusive ownership')
  assert.equal(restarted.overview().runs[0]!.counts.failed, 0)
  Object.assign(job, { status: 'ready', executionActive: false, videoUrl: '/original-finished-video.mp4', message: '原成片已就绪' })
  await restarted.waitForIdle()
  const result = restarted.overview().runs[0]!
  assert.equal(result.status, 'completed'); assert.equal(result.counts.completed, 1); assert.equal(result.counts.failed, 0)
  assert.equal(h.calls.length, calls); assert.equal(h.creates(), 1)
})

test('stopping a batch waiting on another execution never cancels or adopts that execution', async t => {
  let externalStarted = false, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async (_job, _mode, signal) => {
    if (!externalStarted) throw new Error('initial failure')
    await held; signal.throwIfAborted()
  } })
  const run = await done(h, { targetCount: 1 }), file = h.state(run.id), job = h.jobs.get(run.items[0]!.jobId)!
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')), external = new AbortController()
  Object.assign(stored, { status: 'interrupted', processing: { status: 'interrupted', message: '制作已中断' } }); stored.items[0].status = 'queued'
  fs.writeFileSync(file, JSON.stringify(stored))
  Object.assign(job, { status: 'running', executionActive: true })
  externalStarted = true
  const externalWork = h.workflow.runBatchJob(job.id, 'videos', external.signal)
  t.after(release)
  const calls = h.calls.length
  h.service.runAutomaticRecovery(); await nextTurn()
  assert.equal(h.service.stopRun(run.id).status, 'stopping'); await h.service.waitForIdle()
  assert.equal(h.service.overview().runs[0]!.status, 'stopped')
  assert.equal(h.calls.length, calls); assert.equal(job.status, 'running'); assert.equal(job.executionActive, true)
  assert.deepEqual(h.canceled, [])
  assert.equal(external.signal.aborted, false)
  release(); await externalWork
  assert.equal(job.status, 'ready'); assert.equal(job.videoUrl, `/assets/${job.id}.mp4`)
})

test('a failure from an observed external execution stops the batch at that task without retrying it', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)] }, run: async () => { throw new Error('initial failure') } })
  const run = await done(h, { targetCount: 2 }), file = h.state(run.id), job = h.jobs.get(run.items[0]!.jobId)!
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(stored, { status: 'interrupted', processing: { status: 'interrupted', message: '制作已中断' } }); stored.items[0].status = 'queued'
  fs.writeFileSync(file, JSON.stringify(stored))
  Object.assign(job, { status: 'running', executionActive: true })
  const calls = h.calls.length
  h.service.runAutomaticRecovery(); await nextTurn()
  Object.assign(job, { status: 'needs_attention', executionActive: false, message: '封面生成失败，需核对原请求' })
  await h.service.waitForIdle()
  const result = h.service.overview().runs[0]!
  assert.equal(result.status, 'needs_attention'); assert.match(result.message, /封面生成失败/)
  assert.equal(h.calls.length, calls); assert.equal(h.creates(), 2)
})

test('a batch waits through a scheduled workflow retry and its background execution until the original output completes', async t => {
  let scheduled!: () => void
  const waiting = new Promise<void>(resolve => { scheduled = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async job => {
    Object.assign(job, { status: 'retry_wait', executionActive: false, failureKind: 'temporary', message: '稍后自动继续原制作任务',
      automaticRetry: { attempt: 1, maxAttempts: 3, nextRetryAt: new Date(Date.now() + 15_000).toISOString() } })
    scheduled()
    throw new ScienceWorkflowError(job.message, 503, true)
  } })
  const run = h.service.start({ requestId: 'wait-for-scheduled-retry', targetCount: 1 }); await waiting; await nextTurn()
  const job = [...h.jobs.values()][0]!
  assert.equal(h.service.overview().activeRun?.id, run.id)
  assert.equal(h.service.overview().runs[0]!.counts.failed, 0); assert.equal(h.calls.length, 1)
  Object.assign(job, { status: 'running', executionActive: true, automaticRetry: undefined, message: '正在自动继续原制作任务' })
  await delay(300)
  assert.equal(h.service.overview().activeRun?.id, run.id); assert.equal(h.calls.length, 1)
  Object.assign(job, { status: 'ready', executionActive: false, videoUrl: '/original-recovered-video.mp4', message: '原任务已完成' })
  await h.service.waitForIdle()
  const result = h.service.overview().runs[0]!
  assert.equal(result.status, 'completed'); assert.equal(result.counts.completed, 1); assert.equal(result.counts.failed, 0)
  assert.equal(h.calls.length, 1); assert.equal(h.creates(), 1)
})

test('a batch keeps observing an upload retry and accepts only the final bound publication receipt', async t => {
  let scheduled!: () => void
  const waiting = new Promise<void>(resolve => { scheduled = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async job => {
    Object.assign(job, { status: 'retry_wait', stage: 'upload', executionActive: false, videoUrl: '/original-video.mp4',
      uploadRetry: { attempt: 17, nextRetryAt: new Date(Date.now() + 30_000).toISOString() }, message: '上传结果不明，稍后自动重新上传' })
    scheduled(); throw new ScienceWorkflowError(job.message, 503, true)
  } })
  const run = h.service.start({ requestId: 'wait-for-upload-retry', targetCount: 1, mode: 'upload' }); await waiting; await nextTurn()
  const job = [...h.jobs.values()][0]!
  assert.equal(h.service.overview().activeRun?.id, run.id)
  assert.equal(h.service.overview().runs[0]!.counts.failed, 0); assert.equal(h.calls.length, 1)
  Object.assign(job, { status: 'running', executionActive: true, uploadRetry: undefined, message: '正在重新上传' })
  await delay(300)
  assert.equal(h.service.overview().activeRun?.id, run.id); assert.equal(h.calls.length, 1)
  Object.assign(job, { status: 'completed', stage: 'completed', executionActive: false, message: '平台已确认提交',
    upload: { staged:true,saved:false,submitted:true,published:false,publicationStatus:'submitted',articleId:'123',
      accountName:job.baijiahaoAccountName!,publishedUrl:'https://baijiahao.baidu.com/builder/preview/s?id=123',
      editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',targetId:'abc123',engine:'fixture' } })
  await h.service.waitForIdle()
  const result = h.service.overview().runs[0]!
  assert.equal(result.status, 'completed'); assert.equal(result.counts.completed, 1); assert.equal(result.counts.failed, 0)
  assert.equal(h.calls.length, 1); assert.equal(h.creates(), 1)
})

test('stopping an upload retry cancels only the pending plan started by this batch', async t => {
  for (const owned of [true, false]) {
    let scheduled!: () => void
    const waiting = new Promise<void>(resolve => { scheduled = resolve })
    const retry = { attempt: 4, nextRetryAt: new Date(Date.now() + 30_000).toISOString() }
    const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async job => {
      if (owned) {
        Object.assign(job, { status:'retry_wait',stage:'upload',executionActive:false,uploadRetry:retry,message:'等待自动重新上传' })
        scheduled(); throw new ScienceWorkflowError(job.message, 503, true)
      }
      throw new Error('initial failure')
    } })
    const run = owned ? h.service.start({ requestId:'stop-owned-upload-retry',targetCount:1,mode:'upload' })
      : await done(h, {targetCount:1,mode:'upload'})
    if (owned) await waiting
    const job = [...h.jobs.values()][0]!
    if (!owned) {
      const file = h.state(run.id)
      fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')),status:'interrupted',processing:{status:'interrupted',message:'制作已中断'}}))
      Object.assign(job, {status:'retry_wait',stage:'upload',executionActive:false,uploadRetry:retry,message:'外部已安排重新上传'})
      h.service.runAutomaticRecovery()
    }
    await nextTurn()
    assert.equal(h.service.overview().activeRun?.id, run.id)
    const calls = h.calls.length
    assert.equal(h.service.stopRun(run.id).status, 'stopping'); await h.service.waitForIdle()
    assert.equal(h.service.overview().runs[0]!.status, 'stopped'); assert.equal(h.calls.length, calls)
    assert.deepEqual(h.canceled, owned ? [job.id] : [])
    assert.equal(job.status, owned ? 'paused' : 'retry_wait')
    assert.deepEqual(job.uploadRetry, owned ? undefined : retry)
    assert.deepEqual(h.service.runAutomaticRecovery(), [])
  }
})

test('stopping after this batch upload retry starts cancels the active attempt and prevents later retries', async t => {
  let scheduled!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { scheduled = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async job => {
    Object.assign(job, { status:'retry_wait',stage:'upload',executionActive:false,
      uploadRetry:{attempt:1,nextRetryAt:new Date().toISOString()},message:'等待自动重新上传' })
    scheduled(); throw new ScienceWorkflowError(job.message, 503, true)
  } })
  const run = h.service.start({requestId:'stop-active-owned-upload-retry',targetCount:1,mode:'upload'})
  await waiting; await nextTurn()
  const job = [...h.jobs.values()][0]!, controller = new AbortController()
  t.after(() => controller.abort())
  Object.assign(job, {status:'running',executionActive:true,uploadRetry:undefined,message:'后台正在重新上传'})
  let continued = 0
  const active = (async () => {
    await Promise.race([held, new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), {once:true}))])
    if (!controller.signal.aborted) {
      continued++
      Object.assign(job, {status:'retry_wait',uploadRetry:{attempt:2,nextRetryAt:new Date().toISOString()}})
    }
    job.executionActive = false
  })()
  const cancel = h.workflow.cancel.bind(h.workflow)
  h.workflow.cancel = id => { if (id === job.id) controller.abort(); return cancel(id) }
  await delay(300)
  assert.equal(h.service.overview().activeRun?.id, run.id); assert.equal(h.calls.length, 1)
  assert.equal(h.service.stopRun(run.id).status, 'stopping'); await h.service.waitForIdle()
  assert.deepEqual(h.canceled, [job.id]); assert.equal(controller.signal.aborted, true)
  release(); await active
  assert.equal(continued, 0); assert.equal(job.status, 'paused'); assert.equal(job.uploadRetry, undefined)
  assert.equal(job.upload, null); assert.equal(h.service.overview().runs[0]!.status, 'stopped')
  assert.deepEqual(h.service.runAutomaticRecovery(), [])
})

test('an interrupted batch observes a pending automatic retry and blocks only when that retry is exhausted', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { throw new Error('initial failure') } })
  const run = await done(h, { targetCount: 1 }), file = h.state(run.id), job = h.jobs.get(run.items[0]!.jobId)!
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'interrupted', processing: { status: 'interrupted', message: '制作已中断' } }))
  Object.assign(job, { status: 'retry_wait', executionActive: false, failureKind: 'temporary', message: '最后一次自动重试已排队',
    automaticRetry: { attempt: 3, maxAttempts: 3, nextRetryAt: new Date().toISOString() } })
  const calls = h.calls.length
  assert.deepEqual(h.service.runAutomaticRecovery(), [run.id]); await nextTurn()
  assert.equal(h.service.overview().activeRun?.id, run.id); assert.equal(h.service.overview().runs[0]!.counts.failed, 0)
  assert.equal(h.calls.length, calls)
  Object.assign(job, { status: 'needs_attention', automaticRetry: undefined, message: '原任务自动重试已达到上限，请检查花生账号' })
  await h.service.waitForIdle()
  const result = h.service.overview().runs[0]!
  assert.equal(result.status, 'needs_attention'); assert.match(result.message, /自动重试已达到上限/)
  assert.equal(h.calls.length, calls); assert.equal(h.creates(), 1)
})

test('stopping a batch observing an external scheduled retry leaves that workflow intent untouched', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { throw new Error('initial failure') } })
  const run = await done(h, { targetCount: 1 }), file = h.state(run.id), job = h.jobs.get(run.items[0]!.jobId)!
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'interrupted', processing: { status: 'interrupted', message: '制作已中断' } }))
  const retry = { attempt: 2, maxAttempts: 3, nextRetryAt: new Date(Date.now() + 30_000).toISOString() }
  Object.assign(job, { status: 'retry_wait', executionActive: false, automaticRetry: retry, message: '等待后台继续原任务' })
  const calls = h.calls.length
  h.service.runAutomaticRecovery(); await nextTurn()
  assert.equal(h.service.stopRun(run.id).status, 'stopping'); await h.service.waitForIdle()
  assert.equal(h.service.overview().runs[0]!.status, 'stopped')
  assert.equal(job.status, 'retry_wait'); assert.deepEqual(job.automaticRetry, retry); assert.equal(h.calls.length, calls)
  assert.deepEqual(h.canceled, [])
  assert.deepEqual(h.service.runAutomaticRecovery(), [])
})

test('stopping a batch cancels its own scheduled retry before it can resume production or publication', async t => {
  let scheduled!: () => void
  const waiting = new Promise<void>(resolve => { scheduled = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async (job, mode) => {
    Object.assign(job, { status: 'retry_wait', executionActive: false, autoUpload: mode === 'upload', message: '等待自动继续制作并发表',
      automaticRetry: { attempt: 1, maxAttempts: 3, nextRetryAt: new Date(Date.now() + 15_000).toISOString() } })
    scheduled(); throw new ScienceWorkflowError(job.message, 503, true)
  } })
  const run = h.service.start({ requestId: 'stop-owned-retry', targetCount: 1, mode: 'upload' }); await waiting; await nextTurn()
  const job = [...h.jobs.values()][0]!
  assert.equal(job.status, 'retry_wait'); assert.equal(h.service.overview().activeRun?.id, run.id)
  assert.equal(h.service.stopRun(run.id).status, 'stopping'); await h.service.waitForIdle()
  assert.equal(h.service.overview().runs[0]!.status, 'stopped')
  assert.deepEqual(h.canceled, [job.id]); assert.equal(job.status, 'paused'); assert.equal(job.automaticRetry, undefined)
  const due = h.workflow.jobsForCollection(run.id).filter(value => value.status === 'retry_wait' && value.automaticRetry)
  for (const value of due) await h.workflow.runBatchJob(value.id, 'upload', new AbortController().signal)
  assert.equal(h.calls.length, 1); assert.equal(job.upload, null)
  assert.deepEqual(h.service.runAutomaticRecovery(), [])
})

test('service shutdown preserves an owned scheduled retry so the original batch can resume after restart', async t => {
  let scheduled!: () => void
  const waiting = new Promise<void>(resolve => { scheduled = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async job => {
    Object.assign(job, { status: 'retry_wait', executionActive: false, message: '等待自动继续原任务',
      automaticRetry: { attempt: 1, maxAttempts: 3, nextRetryAt: new Date(Date.now() + 15_000).toISOString() } })
    scheduled(); throw new ScienceWorkflowError(job.message, 503, true)
  } })
  h.service.start({ requestId: 'shutdown-owned-retry', targetCount: 1 }); await waiting; await nextTurn()
  const job = [...h.jobs.values()][0]!, retry = structuredClone(job.automaticRetry)
  await h.service.stop()
  assert.equal(h.service.overview().runs[0]!.status, 'interrupted')
  assert.deepEqual(h.canceled, []); assert.equal(job.status, 'retry_wait'); assert.deepEqual(job.automaticRetry, retry)
})

test('automatic recovery respects manual stops, attention states, completed batches and live foreign owners', async t => {
  for (const patch of [
    { status: 'stopped', stopRequested: true }, { status: 'needs_attention' }, { status: 'completed' },
    { status: 'interrupted', stopRequested: true }, { status: 'running', ownerPid: process.ppid },
    { status: 'stopping', stopRequested: true, ownerPid: 99999999 },
  ]) {
    const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { throw new Error('original failure') } })
    const run = await done(h), file = h.state(run.id)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch, processing: { status: patch.status, message: '模拟原制作阶段状态' } }))
    const calls = h.calls.length, restarted = new ScienceCollectionService(h.options)
    assert.deepEqual(restarted.runAutomaticRecovery(), []); await restarted.waitForIdle()
    assert.equal(h.calls.length, calls); assert.equal(h.creates(), 1)
  }
})

test('automatic recovery cannot take a live cross-process lock and starts at most one original batch per scan', async t => {
  const h = fixture(t), original = await done(h), file = h.state(original.id)
  const stored = { ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'interrupted', ownerPid: 99999999, processing: { status: 'interrupted', message: '制作已中断' } }
  fs.writeFileSync(file, JSON.stringify(stored))
  const secondId = `science-batch-${randomUUID()}`
  fs.writeFileSync(h.state(secondId), JSON.stringify({ ...stored, id: secondId, requestId: 'second' }))
  const lock = path.join(h.root, 'worker.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, id: 'another-process', token: 'owned' }))
  assert.deepEqual(h.service.runAutomaticRecovery(), [])
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'owned')
  fs.rmSync(lock)
  const started = h.service.runAutomaticRecovery()
  assert.equal(started.length, 1); await h.service.waitForIdle()
  assert.equal(h.service.overview().runs.filter(run => run.status === 'interrupted').length, 1)
  const next = h.service.runAutomaticRecovery()
  assert.equal(next.length, 1); assert.notEqual(next[0], started[0]); await h.service.waitForIdle()
})

test('automatic recovery reports unavailable original accounts once instead of retrying them on every scan', async t => {
  const h = fixture(t), run = await done(h), file = h.state(run.id)
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'interrupted', ownerPid: 99999999, processing: { status: 'interrupted', message: '制作已中断' } }))
  let checks = 0
  h.workflow.validateBatchAccounts = () => { checks++; throw new ScienceWorkflowError('原花生账号已删除') }
  assert.deepEqual(h.service.runAutomaticRecovery(), [])
  assert.equal(h.service.overview().runs[0]!.status, 'needs_attention')
  assert.match(h.service.overview().runs[0]!.message, /原花生账号已删除/)
  assert.deepEqual(h.service.runAutomaticRecovery(), []); assert.equal(checks, 1)
})

test('the automatic recovery timer starts once and service shutdown disables later scans', async t => {
  const h = fixture(t)
  t.mock.timers.enable({ apis: ['setInterval'] })
  let scans = 0
  const recover = h.service.runAutomaticRecovery.bind(h.service)
  h.service.runAutomaticRecovery = () => { scans++; return recover() }
  h.service.startAutomaticRecovery(); h.service.startAutomaticRecovery()
  assert.equal(scans, 1)
  t.mock.timers.tick(15_000); assert.equal(scans, 2)
  await h.service.stop()
  t.mock.timers.tick(60_000); assert.equal(scans, 2)
})

test('shutdown during an authorized retry retains only its original pending scope for automatic recovery', async t => {
  let recover = false, entered!: () => void, held = false
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2), candidate(3)] }, run: async (job, _mode, signal) => {
    if (!recover && job.sourceUrl !== candidate(3).sourceUrl) throw new Error('original failure')
    if (recover && job.sourceUrl === candidate(2).sourceUrl && !held) {
      held = true; entered()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
  } })
  const run = await done(h, { targetCount: 3 }), ids = run.items.slice(0, 2).map(item => item.jobId)
  recover = true; h.service.retry(run.id, { jobIds: ids }); await waiting; await h.service.stop()
  const calls = h.calls.length, visits = [...h.visited], restarted = new ScienceCollectionService(h.options)
  assert.deepEqual(restarted.runAutomaticRecovery(), [run.id]); await restarted.waitForIdle()
  const result = restarted.overview().runs[0]!
  assert.deepEqual(h.calls.slice(calls).map(call => call.id), [ids[1]])
  assert.deepEqual(result.retry?.jobIds, ids); assert.equal(result.retry?.completed, 2)
  assert.deepEqual(h.visited, visits); assert.equal(h.creates(), 3)
})

test('automatic recovery does not replay an already failed attempt inside an interrupted retry scope', async t => {
  let retrying = false, entered!: () => void, held = false
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2), candidate(3)] }, run: async (job, _mode, signal) => {
    if (job.sourceUrl === candidate(1).sourceUrl || !retrying && job.sourceUrl === candidate(2).sourceUrl) throw new Error('task failure')
    if (retrying && job.sourceUrl === candidate(2).sourceUrl && !held) {
      held = true; entered()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
  } })
  const run = await done(h, { targetCount: 3 }), ids = run.items.slice(0, 2).map(item => item.jobId)
  retrying = true; h.service.retry(run.id, { jobIds: ids }); await waiting; await h.service.stop()
  const calls = h.calls.length, restarted = new ScienceCollectionService(h.options)
  assert.deepEqual(restarted.runAutomaticRecovery(), [run.id]); await restarted.waitForIdle()
  const result = restarted.overview().runs[0]!
  assert.deepEqual(h.calls.slice(calls).map(call => call.id), [ids[1]])
  assert.equal(result.status, 'needs_attention'); assert.equal(result.retry?.completed, 1); assert.equal(result.retry?.failed, 1)
})

test('resume refuses an account edited after interruption instead of switching it back', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { throw new Error('failed') } })
  const run = await done(h, { targetCount: 1 }), job = h.jobs.get(run.items[0]!.jobId)!
  job.huashengAccountName = 'manually-changed'
  h.service.resume(run.id); await h.service.waitForIdle()
  const result = h.service.overview().runs[0]!
  assert.equal(result.counts.completed, 0); assert.match(result.items[0]!.message, /账号.*不一致/)
  assert.equal(job.huashengAccountName, 'manually-changed'); assert.equal(h.calls.length, 1)
})

test('an unverified collector end is a visible channel error, not a completed empty success', async t => {
  const h = fixture(t, { collect: async () => {} })
  const run = await done(h)
  assert.equal(run.status, 'needs_attention'); assert.equal(run.channelErrors.length, 2)
  assert.match(run.channelErrors[0]!.message, /提前结束/)
})

test('a live collector process prevents a second collection even before the first batch file is committed', t => {
  const h = fixture(t)
  fs.writeFileSync(path.join(h.root, 'collector.lock'), JSON.stringify({ pid: process.ppid, id: 'another-process', token: 'owned' }))
  assert.throws(() => h.service.start({ requestId: 'competing' }), /另一个进程/)
  assert.equal(h.service.overview().runs.length, 0); assert.equal(h.calls.length, 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, 'collector.lock'), 'utf8')).token, 'owned')
})

test('login, quota, throttling and missing model or voice configuration pause production after source collection completes', async t => {
  const errors = ['花生登录已失效，请在专用窗口登录后恢复任务', '标准模式每日额度已用完', 'Text model request failed: 429 Too Many Requests',
    'An active MiniMax audio configuration is required for ASR', 'No active text AI config',
    '绑定账号中未找到可用的指定克隆音色 1595661，未使用默认音色代替', '指定的花生音色编号或类型无效，未提交制作']
  for (const message of errors) {
    let blocked = true
    const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)], [channels[1]!]: [candidate(3)] },
      run: async () => { if (blocked) throw new Error(message) } })
    const run = await done(h)
    assert.equal(run.status, 'needs_attention'); assert.equal(run.counts.failed, 1); assert.equal(run.counts.completed, 0)
    assert.equal(h.calls.length, 1); assert.equal(h.creates(), 2); assert.deepEqual(h.visited, [channels[0]])
    assert.equal(run.collection?.status, 'completed'); assert.equal(run.counts.selected, 2)
    assert.match(run.processing!.message, /已暂停后续制作/)
    blocked = false
    h.service.resume(run.id); await h.service.waitForIdle()
    const recovered = h.service.overview().runs[0]!
    assert.equal(recovered.counts.completed, 2); assert.equal(h.calls[1]!.id, run.items[0]!.jobId)
    assert.equal(h.creates(), 2)
  }
})

test('a missing global downloader stops before scanning every configured channel', async t => {
  const h = fixture(t, { collect: async () => { throw new Error('未找到 yt-dlp，请安装 yt-dlp') } })
  const run = await done(h)
  assert.equal(run.status, 'needs_attention'); assert.equal(run.channelErrors.length, 1)
  assert.deepEqual(h.visited, [channels[0]]); assert.equal(h.creates(), 0)
})

test('running output and an old saved upload receipt do not satisfy a recovered batch', async t => {
  for (const mode of ['drafts', 'upload'] as const) {
    const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { throw new Error('current output not verified') } })
    const run = await done(h, { mode, targetCount: 1 }), job = h.jobs.get(run.items[0]!.jobId)!
    job.script = '已存在的稿'; job.videoUrl = '/saved-video.mp4'
    job.status = mode === 'drafts' ? 'running' : 'needs_attention'
    job.upload = { staged: true, saved: true, published: false, accountName: run.baijiahaoAccountName!, editorUrl: 'https://baijiahao.baidu.com/', targetId: 'abc123', engine: 'fixture' }
    h.service.resume(run.id); await h.service.waitForIdle()
    assert.equal(h.calls.length, 2, 'recovery must validate the current task, not accept retained artifacts')
    assert.equal(h.service.overview().runs[0]!.counts.completed, 0)
  }
})

test('known video identities are read once per channel, not once for every candidate', async t => {
  const sources = Array.from({ length: 30 }, (_, index) => candidate(index + 1))
  const h = fixture(t, { lists: { [channels[0]!]: sources, [channels[1]!]: sources } })
  for (const source of sources) { const job = baseJob(source); h.jobs.set(job.id, job) }
  const read = h.workflow.knownYoutubeIds
  let reads = 0
  h.workflow.knownYoutubeIds = () => { reads++; return read() }
  const run = await done(h, { targetCount: null })
  assert.equal(run.counts.skipped, 60); assert.equal(reads, 2); assert.equal(h.creates(), 0)
})

test('a single-video 404 with the shared proxy-help suffix still continues to the next video', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)] }, run: async job => {
    if (job.sourceUrl === candidate(1).sourceUrl)
      throw new Error('YouTube 读取或下载失败：ERROR: Video unavailable. HTTP Error 404: Not Found；网络不可达时请配置 HISTORY_YOUTUBE_PROXY；解析失效时请更新 yt-dlp')
  } })
  const run = await done(h, { targetCount: 2 })
  assert.equal(run.status, 'needs_attention'); assert.equal(run.collection?.status, 'completed'); assert.equal(run.counts.completed, 1); assert.equal(run.counts.failed, 1)
  assert.equal(h.calls.length, 2); assert.equal(run.items[1]!.videoId, videoId(2))
})

test('retry selects only original unfinished jobs after the target was reached, without collecting more videos', async t => {
  let recover = false
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2), candidate(3), candidate(4)] }, run: async job => {
    if (!recover && job.sourceUrl !== candidate(3).sourceUrl) throw new Error('original task failed')
  } })
  const run = await done(h, { targetCount: 3 })
  assert.equal(run.status, 'needs_attention'); assert.equal(run.collection?.status, 'completed'); assert.equal(run.counts.completed, 1); assert.equal(run.counts.failed, 2)
  const originalCalls = h.calls.length, originalVisits = [...h.visited]
  const firstId = run.items[0]!.jobId, secondId = run.items[1]!.jobId
  recover = true
  h.service.saveSettings({ youtubeChannels: [channels[1]!], huashengAccountName: 'new-hs', baijiahaoAccountName: 'new-bj' })
  const retry = h.service.retry(run.id, { jobIds: [firstId] })
  assert.deepEqual(retry.retry?.jobIds, [firstId]); assert.equal(retry.targetCount, 3)
  assert.equal(h.service.retry(run.id, { jobIds: [firstId] }).id, run.id)
  assert.throws(() => h.service.retry(run.id, { jobIds: [secondId] }), /范围|执行/)
  await h.service.waitForIdle()
  const recovered = h.service.overview().runs[0]!
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.counts.completed, 2)
  assert.equal(recovered.retry?.completed, 1); assert.equal(recovered.retry?.failed, 0); assert.ok(recovered.retry?.finishedAt)
  assert.match(recovered.message, /已恢复 1\/1/)
  assert.deepEqual(h.calls.slice(originalCalls).map(call => call.id), [firstId])
  assert.equal(h.calls.at(-1)!.hs, 'hs-one'); assert.equal(h.calls.at(-1)!.bj, 'bj-one')
  assert.deepEqual(h.visited, originalVisits); assert.equal(h.creates(), 3)
  h.service.retry(run.id, {}); await h.service.waitForIdle()
  const remaining = h.service.overview().runs[0]!
  assert.deepEqual(remaining.retry?.jobIds, [secondId]); assert.equal(remaining.counts.completed, 3)
  const callsAfterRetry = h.calls.length
  h.service.resume(run.id); await h.service.waitForIdle()
  h.service.retry(run.id, {}); await h.service.waitForIdle()
  assert.equal(h.calls.length, callsAfterRetry); assert.deepEqual(h.visited, originalVisits)
})

test('retry stop and process restart preserve the selected scope and skip its completed outputs', async t => {
  let recover = false, heldOnce = false, started!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2), candidate(3), candidate(4)] }, run: async (job, _mode, signal) => {
    if (!recover && job.sourceUrl !== candidate(4).sourceUrl) throw new Error('original task failed')
    if (recover && job.sourceUrl === candidate(2).sourceUrl && !heldOnce) { heldOnce = true; started(); await held; signal.throwIfAborted() }
  } })
  const run = await done(h, { targetCount: 4 }), ids = run.items.slice(0, 2).map(item => item.jobId)
  recover = true
  h.service.retry(run.id, { jobIds: [...ids].reverse() }); await waiting
  assert.equal(h.service.stopRun(run.id).status, 'stopping')
  release(); await h.service.waitForIdle()
  const file = h.state(run.id), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(stored.retry.jobIds, ids, 'scope follows original batch order')
  assert.equal(stored.retry.completed, 1)
  Object.assign(stored, { status: 'running', processing: { status: 'running', message: '继续原重试范围' }, ownerPid: 99999999, stopRequested: false })
  fs.writeFileSync(file, JSON.stringify(stored))
  const restarted = new ScienceCollectionService(h.options)
  assert.equal(restarted.overview().runs[0]!.status, 'interrupted')
  const visits = [...h.visited], calls = h.calls.length
  restarted.resume(run.id); await restarted.waitForIdle()
  const result = restarted.overview().runs[0]!
  assert.equal(result.retry?.completed, 2); assert.deepEqual(result.retry?.jobIds, ids)
  assert.deepEqual(h.calls.slice(calls).map(call => call.id), [ids[1]])
  assert.equal(result.items[2]!.status, 'failed'); assert.equal(result.counts.completed, 3)
  assert.deepEqual(h.visited, visits); assert.equal(h.creates(), 4)
})

test('overview reconciles real outputs and paused jobs without writing state or starting work', async t => {
  for (const mode of ['drafts', 'videos', 'upload'] as const) {
    const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)] }, run: async () => { throw new Error('original task failed') } })
    const run = await done(h, { mode, targetCount: 2 })
    const completed = h.jobs.get(run.items[0]!.jobId)!, paused = h.jobs.get(run.items[1]!.jobId)!
    completed.script = 'finished'; completed.videoUrl = '/saved-output.mp4'; completed.status = mode === 'upload' ? 'completed' : 'ready'
    completed.upload = { staged: true, saved: false, submitted: true, publicationStatus: 'submitted', published: false, accountName: run.baijiahaoAccountName!,
      articleId: 'saved', publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=saved', editorUrl: 'https://baijiahao.baidu.com/', targetId: 'saved', engine: 'test' }
    paused.status = 'paused' as ScienceJob['status']; paused.message = '等待继续'
    const persisted = fs.readFileSync(h.state(run.id), 'utf8'), calls = h.calls.length
    const overview = h.service.overview().runs[0]!
    assert.equal(overview.items[0]!.status, 'completed'); assert.equal(overview.items[1]!.status, 'paused')
    assert.equal(overview.counts.completed, 1); assert.equal(overview.counts.failed, 0)
    assert.equal(fs.readFileSync(h.state(run.id), 'utf8'), persisted)
    assert.equal(h.calls.length, calls)
    for (const status of ['waiting_remote', 'awaiting_export'] as const) {
      paused.status = status; paused.message = '花生状态已同步，可继续原任务'
      const synced = h.service.overview().runs[0]!
      assert.equal(synced.items[1]!.status, 'paused'); assert.equal(synced.items[1]!.message, paused.message)
      assert.equal(synced.counts.failed, 0); assert.equal(h.calls.length, calls)
      assert.equal(fs.readFileSync(h.state(run.id), 'utf8'), persisted)
    }
  }
})

test('overview replaces stale preparation errors once an idle original job is queued for production', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { throw new Error('YouTube download timed out') } })
  const run = await done(h, { mode: 'upload', targetCount: 1 }), job = h.jobs.get(run.items[0]!.jobId)!
  Object.assign(job, { status: 'queued', stage: 'produce', transcript: '完整原稿', script: '已就绪的二创稿',
    executionActive: false, message: '二创文稿已就绪；自动生产批次将继续花生制作' })
  const persisted = fs.readFileSync(h.state(run.id), 'utf8'), calls = h.calls.length
  const overview = h.service.overview().runs[0]!
  assert.equal(overview.items[0]!.status, 'queued')
  assert.equal(overview.items[0]!.message, '二创文稿已就绪；自动生产批次将继续花生制作')
  assert.equal(overview.counts.failed, 0)
  assert.equal(overview.status, 'needs_attention', 'the batch still needs an explicit resume')
  assert.equal(fs.readFileSync(h.state(run.id), 'utf8'), persisted)
  assert.equal(h.calls.length, calls)
})

test('resuming an original upload retry keeps its accounts and scope including paused jobs', async t => {
  let recover = false
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)] },
    run: async () => { if (!recover) throw new Error('old download failure') } })
  const run = await done(h, { mode: 'upload', targetCount: 5 }), ids = run.items.map(item => item.jobId)
  const queued = h.jobs.get(ids[0]!)!, completed = h.jobs.get(ids[1]!)!, deleted = h.jobs.get(ids[2]!)!, paused = h.jobs.get(ids[3]!)!
  Object.assign(queued, { status: 'queued', stage: 'produce', transcript: '完整原稿', script: '已就绪的二创稿', message: '等待原批次继续制作' })
  Object.assign(completed, { status: 'completed', stage: 'completed', videoUrl: '/saved-video.mp4', message: '已提交审核',
    upload: { accountName: 'bj-one', staged: true, saved: false, submitted: true, published: false,
      editorUrl: 'https://baijiahao.baidu.com/', targetId: 'saved', engine: 'test' } })
  deleted.deletedAt = new Date().toISOString()
  Object.assign(paused, { status: 'paused', stage: 'produce', transcript: '完整原稿', script: '暂停的二创稿', message: '已手动暂停此任务' })
  const stored = JSON.parse(fs.readFileSync(h.state(run.id), 'utf8'))
  stored.retry = { jobIds: ids.slice(0, 4), startedAt: new Date().toISOString(), finishedAt: null, completed: 0, failed: 4 }
  fs.writeFileSync(h.state(run.id), JSON.stringify(stored))
  h.defaultAccounts.hs = 'new-hs'; h.defaultAccounts.bj = 'new-bj'
  h.service.saveSettings({ mode: 'videos', huashengAccountName: 'new-hs', baijiahaoAccountName: 'new-bj' })
  const calls = h.calls.length, visits = [...h.visited]
  assert.deepEqual(h.service.runAutomaticRecovery(), [])
  recover = true
  h.service.resume(run.id); await h.service.waitForIdle()
  const resumed = h.service.overview().runs[0]!
  assert.deepEqual(h.calls.slice(calls), [
    { id: queued.id, mode: 'upload', hs: 'hs-one', bj: 'bj-one' },
    { id: paused.id, mode: 'upload', hs: 'hs-one', bj: 'bj-one' },
  ])
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.items[1]!.status, 'completed'); assert.equal(resumed.items[2]!.status, 'deleted')
  assert.equal(resumed.items[3]!.status, 'completed')
  assert.deepEqual(resumed.retry?.jobIds, ids.slice(0, 4)); assert.equal(resumed.retry?.completed, 3)
  assert.equal(paused.status, 'completed'); assert.deepEqual(h.canceled, [])
  assert.deepEqual(h.visited, visits); assert.equal(h.creates(), 5)
})

test('explicit resume continues the same retry after a batch stop pauses the task it started', async t => {
  let phase: 'initial' | 'retry' | 'resume' = 'initial', entered!: () => void, cancelWork!: (id: string) => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2), candidate(3)] }, run: async (job, _mode, signal) => {
    if (phase === 'initial' && job.sourceUrl !== candidate(3).sourceUrl) throw new Error('old download failure')
    if (phase === 'retry') await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { cancelWork(job.id); reject(signal.reason) }, { once: true })
      entered()
    })
  } })
  cancelWork = id => { h.workflow.cancel(id) }
  const run = await done(h, { mode: 'upload', targetCount: 3 }), ids = run.items.slice(0, 2).map(item => item.jobId)
  phase = 'retry'
  h.service.retry(run.id, { jobIds: ids }); await waiting
  assert.equal(h.service.stopRun(run.id).status, 'stopping'); await h.service.waitForIdle()
  const paused = h.jobs.get(ids[0]!)!, stopped = h.service.overview().runs[0]!
  assert.equal(stopped.status, 'stopped'); assert.equal(paused.status, 'paused')
  assert.deepEqual(h.canceled, [paused.id]); assert.deepEqual(stopped.retry?.jobIds, ids)
  assert.deepEqual(h.service.runAutomaticRecovery(), [])
  const calls = h.calls.length, visits = [...h.visited]
  h.service.saveSettings({ mode: 'videos', huashengAccountName: 'new-hs', baijiahaoAccountName: 'new-bj' })
  phase = 'resume'
  h.service.resume(run.id); await h.service.waitForIdle()
  const resumed = h.service.overview().runs[0]!
  assert.deepEqual(h.calls.slice(calls), ids.map(id => ({ id, mode: 'upload', hs: 'hs-one', bj: 'bj-one' })))
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.retry?.completed, 2)
  assert.deepEqual(resumed.retry?.jobIds, ids); assert.equal(paused.status, 'completed')
  assert.deepEqual(h.visited, visits); assert.equal(h.creates(), 3)
})

test('resume saves the current queued retry scope before a shutdown can interrupt dispatch', async t => {
  let recover = false
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1)] }, run: async () => { if (!recover) throw new Error('old failure') } })
  const run = await done(h, { mode: 'upload', targetCount: 1 }), job = h.jobs.get(run.items[0]!.jobId)!
  Object.assign(job, { status: 'queued', stage: 'produce', transcript: '完整原稿', script: '已就绪的二创稿', message: '等待原批次继续制作' })
  const stored = JSON.parse(fs.readFileSync(h.state(run.id), 'utf8'))
  stored.items[0].status = 'completed'
  stored.retry = { jobIds: [job.id], startedAt: new Date().toISOString(), finishedAt: null, completed: 1, failed: 0 }
  fs.writeFileSync(h.state(run.id), JSON.stringify(stored))
  const calls = h.calls.length, visits = [...h.visited]
  recover = true
  h.service.resume(run.id); await h.service.stop()
  assert.equal(h.service.overview().runs[0]!.status, 'interrupted')
  assert.equal(h.calls.length, calls, 'shutdown arrived before the first task was dispatched')
  const restarted = new ScienceCollectionService(h.options)
  assert.deepEqual(restarted.runAutomaticRecovery(), [run.id]); await restarted.waitForIdle()
  const resumed = restarted.overview().runs[0]!
  assert.deepEqual(h.calls.slice(calls), [{ id: job.id, mode: 'upload', hs: 'hs-one', bj: 'bj-one' }])
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.retry?.completed, 1)
  assert.deepEqual(h.visited, visits); assert.equal(h.creates(), 1)
})

test('retryable workflow errors pause a retry scope before later tasks and resume that same scope', async t => {
  let recover = false, transient = false
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2), candidate(3)] }, run: async job => {
    if (!recover && job.sourceUrl !== candidate(3).sourceUrl) throw new Error('original task failed')
    if (transient) {
      job.status = 'needs_attention'; job.failureKind = 'temporary'; job.message = '暂时不可用'
      throw Object.assign(new ScienceWorkflowError(job.message), { retryable: true })
    }
  } })
  const run = await done(h, { targetCount: 3 }), ids = run.items.slice(0, 2).map(item => item.jobId)
  recover = true; transient = true
  const calls = h.calls.length, visits = [...h.visited]
  h.service.retry(run.id, {}); await h.service.waitForIdle()
  const blocked = h.service.overview().runs[0]!
  assert.equal(blocked.status, 'needs_attention'); assert.deepEqual(blocked.retry?.jobIds, ids)
  assert.equal(blocked.items[0]!.status, 'paused'); assert.equal(blocked.retry?.completed, 0)
  assert.equal(blocked.counts.failed, 1, 'only the untouched original failure counts as failed')
  assert.equal(blocked.retry?.finishedAt, null); assert.deepEqual(h.calls.slice(calls).map(call => call.id), [ids[0]])
  transient = false
  h.service.resume(run.id); await h.service.waitForIdle()
  assert.equal(h.service.overview().runs[0]!.retry?.completed, 2)
  assert.deepEqual(h.calls.slice(calls).map(call => call.id), [ids[0], ...ids]); assert.deepEqual(h.visited, visits)
})

test('collection retry route rejects foreign jobs and invalid bodies, and accepts a completed original batch', async t => {
  const { createScienceWorkflowRoute } = await import('../routes/science-workflow.js')
  let recover = false
  const h = fixture(t, { lists: { [channels[0]!]: [candidate(1), candidate(2)] }, run: async job => {
    if (!recover && job.sourceUrl === candidate(1).sourceUrl) throw new Error('original task failed')
  } })
  const run = await done(h, { targetCount: 2 }), route = createScienceWorkflowRoute({ collection: h.service })
  const request = (input: unknown) => route.request(`/collection/runs/${run.id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  for (const body of [{ jobIds: [`science-${randomUUID()}`] }, { jobIds: [] }, { jobIds: [run.items[0]!.jobId, run.items[0]!.jobId] }, { mode: 'upload' }]) {
    assert.equal((await request(body)).status, 400)
  }
  assert.equal(h.calls.length, 2)
  recover = true
  const response = await request({ jobIds: [run.items[0]!.jobId] })
  assert.equal(response.status, 202); assert.equal((await response.json()).data.id, run.id)
  await h.service.waitForIdle(); assert.equal(h.service.overview().runs[0]!.retry?.completed, 1)
})
