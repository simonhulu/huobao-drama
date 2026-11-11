import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ScienceCollectionService, type ScienceCollectionOptions } from './science-collection.js'
import { ScienceWorkflowError, type ScienceJob } from './science-workflow.js'
import type { HistoryYoutubeCandidate, HistoryYoutubeCollectionOptions } from './history-source-youtube.js'

const channels = ['https://www.youtube.com/@IndependentOne/videos', 'https://www.youtube.com/@IndependentTwo/videos']
function source(number: number): HistoryYoutubeCandidate {
  const videoId = `split${String(number).padStart(6, '0')}`
  return { videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, title: `Source ${number}`,
    authorName: 'Source', observedAt: '2026-11-05T00:00:00Z', collectionUrl: channels[0]! }
}
async function stream(options: HistoryYoutubeCollectionOptions, entries: HistoryYoutubeCandidate[]) {
  let scanned = 0
  for (const candidate of entries) {
    options.signal.throwIfAborted()
    if (options.isTargetReached()) return
    const known = options.isKnownVideo(candidate.videoId)
    options.report({ stage: known ? 'skipping' : 'selecting', message: known ? 'Known source' : 'New source', scanned: ++scanned,
      candidate: { videoId: candidate.videoId, outcome: known ? 'skipped' : 'selected' } })
    if (!known) await options.onCandidate(candidate)
  }
  options.report({ stage: 'exhausted', message: 'Channel exhausted', scanned })
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { release, async wait(signal: AbortSignal) {
    signal.throwIfAborted()
    let abort!: () => void
    try {
      await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })])
      signal.throwIfAborted()
    } finally { signal.removeEventListener('abort', abort) }
  } }
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await delay(5)
  }
  assert.fail('Independent collection/processing state did not settle')
}
function fixture(t: test.TestContext, config: {
  collect?: ScienceCollectionOptions['collect']
  process?: (job: ScienceJob, signal: AbortSignal) => Promise<void>
  validateAccounts?: NonNullable<ScienceCollectionOptions['workflow']>['validateBatchAccounts']
  lists?: Record<string, HistoryYoutubeCandidate[]>
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-independent-'))
  const jobs = new Map<string, ScienceJob>()
  const calls: string[] = [], visited: string[] = [], canceled: string[] = []
  const signals = new Map<string, AbortSignal>()
  let active = 0, maximumActive = 0
  const workflow: NonNullable<ScienceCollectionOptions['workflow']> = {
    create(input, options = {}) {
      const existing = [...jobs.values()].find(job => job.sourceUrl === input.sourceUrl)
      if (existing) return structuredClone(existing)
      assert.equal(options.defer, true)
      const timestamp = new Date().toISOString()
      const job: ScienceJob = { id: `science-${randomUUID()}`, title: input.title || 'Source', sourceUrl: input.sourceUrl,
        createdAt: timestamp, updatedAt: timestamp, status: 'draft', stage: 'download', message: 'Queued',
        transcript: '', script: '', factChecks: [], sources: [input.sourceUrl], projectUrl: null, checkpoint: null,
        sourceVideoUrl: null, videoUrl: null, landscapeCoverUrl: null, portraitCoverUrl: null,
        huashengAccountName: input.huashengAccountName || null, baijiahaoAccountName: input.baijiahaoAccountName || null,
        logs: [], upload: null, hasUploadAttempt: false, collectionId: options.collectionId, sourceChannel: options.sourceChannel }
      jobs.set(job.id, job)
      return structuredClone(job)
    },
    knownYoutubeIds: () => new Set([...jobs.values()].map(job => new URL(job.sourceUrl).searchParams.get('v')!)),
    jobsForCollection: id => structuredClone([...jobs.values()].filter(job => job.collectionId === id)),
    jobsForCollections: ids => new Map([...ids].map(id => [id, workflow.jobsForCollection(id)])),
    jobForCollection(collectionId, id) { const job = jobs.get(id); return job?.collectionId === collectionId ? structuredClone(job) : undefined },
    validateBatchAccounts: config.validateAccounts || ((_mode, hs, bj) => ({ huashengAccountName: hs ?? 'hs-one', baijiahaoAccountName: bj ?? 'bj-one' })),
    cancel(id) {
      canceled.push(id)
      const job = jobs.get(id)!
      Object.assign(job, { status: 'paused', executionActive: false, automaticRetry: undefined, uploadRetry: undefined })
      return structuredClone(job)
    },
    async runBatchJob(id, mode, signal) {
      const job = jobs.get(id)!
      calls.push(id); signals.set(id, signal)
      active++; maximumActive = Math.max(maximumActive, active)
      Object.assign(job, { status: 'running', executionActive: true })
      try {
        await config.process?.(job, signal)
        signal.throwIfAborted()
        Object.assign(job, { transcript: 'Source narration', script: 'Paraphrased narration', status: 'ready', stage: 'export',
          videoUrl: `/assets/${id}.mp4`, message: 'Completed' })
        if (mode === 'drafts') Object.assign(job, { status: 'draft', stage: 'produce', videoUrl: null })
        return structuredClone({ ...job, executionActive: false })
      } catch (error) {
        Object.assign(job, { status: signal.aborted ? 'paused' : 'needs_attention', message: String(error instanceof Error ? error.message : error) })
        throw error
      } finally { active--; job.executionActive = false }
    },
  }
  const options: ScienceCollectionOptions = { stateRoot: root, workflow, collect: async input => {
    visited.push(input.url)
    if (config.collect) return config.collect(input)
    await stream(input, config.lists?.[input.url] || [])
  } }
  const service = new ScienceCollectionService(options)
  service.saveSettings({ youtubeChannels: channels, targetCount: 3, mode: 'videos', huashengAccountName: 'hs-one', baijiahaoAccountName: 'bj-one' })
  const services = [service]
  t.after(async () => {
    for (const current of services) await current.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const current = (id: string) => service.overview().runs.find(run => run.id === id)! as any
  return { root, service, jobs, calls, visited, canceled, signals, current, maximumActive: () => maximumActive,
    restart() { const restarted = new ScienceCollectionService(options); services.push(restarted); return restarted } }
}

test('production login failure pauses only processing after the source target has been stored', async t => {
  let blocked = true
  const h = fixture(t, { lists: { [channels[0]!]: [source(1), source(2)], [channels[1]!]: [source(3), source(4)] },
    process: async () => { if (blocked) throw new ScienceWorkflowError('花生账号未登录，无法读取接口会话') } })
  const run = h.service.start({ requestId: 'login-does-not-stop-collection' })
  await h.service.waitForIdle()
  const result = h.current(run.id)
  assert.equal(result.collection.status, 'completed')
  assert.equal(result.processing.status, 'needs_attention')
  assert.equal(result.counts.selected, 3)
  assert.equal(h.jobs.size, 3)
  assert.deepEqual(h.visited, channels)
  assert.equal(h.calls.length, 1)
  const visits = [...h.visited]
  blocked = false
  ;(h.service as any).resumeProcessing(run.id)
  await h.service.waitForIdle()
  assert.equal(h.current(run.id).processing.status, 'completed')
  assert.equal(h.current(run.id).counts.completed, 3)
  assert.equal(h.jobs.size, 3)
  assert.deepEqual(h.visited, visits)
})

test('completed collection releases its lock while a single processing queue handles later batches', async t => {
  const held = gate()
  const h = fixture(t, { lists: { [channels[0]!]: [source(1), source(2)] }, process: async (job, signal) => {
    if (job.sourceUrl === source(1).sourceUrl) await held.wait(signal)
  } })
  const first = h.service.start({ requestId: 'first-source-only', targetCount: 1 })
  await until(() => h.calls.length === 1 && h.current(first.id).collection?.status === 'completed')
  assert.equal((h.service.overview() as any).activeCollection, null)
  const secondService = h.restart()
  const second = secondService.start({ requestId: 'second-source-only', targetCount: 1 })
  await until(() => h.current(second.id).collection?.status === 'completed')
  assert.equal(h.current(second.id).counts.selected, 1)
  assert.equal(h.jobs.size, 2)
  assert.equal(h.calls.length, 1, 'later processing waits without blocking source collection')
  held.release()
  await h.service.waitForIdle()
  assert.equal(h.maximumActive(), 1)
  assert.equal(h.calls.length, 2)
  assert.equal(h.current(first.id).counts.completed, 1)
  assert.equal(h.current(second.id).counts.completed, 1)
})

test('stopping source collection does not cancel an independent active production', async t => {
  const production = gate(), collection = gate()
  let collectorHeld = false
  const h = fixture(t, { collect: async options => {
    if (!options.isKnownVideo(source(1).videoId)) return stream(options, [source(1)])
    await stream({ ...options, report: event => { if (event.stage !== 'exhausted') options.report(event) } }, [source(2)])
    collectorHeld = true
    await collection.wait(options.signal)
    options.report({ stage: 'exhausted', message: 'Channel exhausted', scanned: 1 })
  }, process: async (job, signal) => { if (job.sourceUrl === source(1).sourceUrl) await production.wait(signal) } })
  const first = h.service.start({ requestId: 'production-independent', targetCount: 1 })
  await until(() => h.calls.length === 1)
  const activeId = h.calls[0]!
  const second = h.service.start({ requestId: 'collector-stop-independent', targetCount: 2 })
  await until(() => collectorHeld)
  ;(h.service as any).stopCollection(second.id)
  await until(() => h.current(second.id).collection.status === 'stopped')
  assert.equal(h.signals.get(activeId)?.aborted, false)
  assert.equal(h.current(first.id).collection.status, 'completed')
  assert.equal(h.current(first.id).processing.status, 'running')
  production.release()
  await h.service.waitForIdle()
  assert.equal(h.current(first.id).counts.completed, 1)
})

test('stopping processing leaves the completed collection and unconsumed sources intact', async t => {
  const production = gate()
  let heldOnce = false
  const h = fixture(t, { lists: { [channels[0]!]: [source(1), source(2), source(3)] }, process: async (_job, signal) => {
    if (!heldOnce) { heldOnce = true; await production.wait(signal) }
  } })
  const run = h.service.start({ requestId: 'stop-processing-only' })
  await until(() => h.calls.length === 1)
  ;(h.service as any).stopProcessing(run.id)
  await h.service.waitForIdle()
  const result = h.current(run.id)
  assert.equal(result.collection.status, 'completed')
  assert.equal(result.processing.status, 'stopped')
  assert.equal(result.counts.selected, 3)
  assert.equal(h.calls.length, 1)
  assert.equal(h.jobs.size, 3)
  const visits = [...h.visited]
  ;(h.service as any).resumeProcessing(run.id)
  await h.service.waitForIdle()
  assert.equal(h.current(run.id).counts.completed, 3)
  assert.deepEqual(h.visited, visits)
})

test('processing recovery never rescans a completed collection or duplicates stored sources', async t => {
  const production = gate()
  let heldOnce = false
  const h = fixture(t, { lists: { [channels[0]!]: [source(1), source(2), source(3)] }, process: async (_job, signal) => {
    if (!heldOnce) { heldOnce = true; await production.wait(signal) }
  } })
  const run = h.service.start({ requestId: 'processing-restart' })
  await until(() => h.calls.length === 1)
  const visits = [...h.visited]
  await h.service.stop()
  assert.equal(h.current(run.id).collection.status, 'completed')
  assert.equal(h.current(run.id).processing.status, 'interrupted')
  const restarted = h.restart()
  assert.ok(restarted.runAutomaticRecovery().includes(run.id))
  await restarted.waitForIdle()
  assert.equal(h.current(run.id).processing.status, 'completed')
  assert.equal(h.current(run.id).counts.completed, 3)
  assert.equal(h.jobs.size, 3)
  assert.deepEqual(h.visited, visits)
})

test('interrupted source collection resumes its own input scope without duplicating the saved source', async t => {
  const collection = gate()
  let heldOnce = false, entered = false
  const h = fixture(t, { collect: async options => {
    if (!heldOnce) {
      heldOnce = true
      await stream({ ...options, report: event => { if (event.stage !== 'exhausted') options.report(event) } }, [source(1)])
      entered = true
      await collection.wait(options.signal)
    }
    await stream(options, [source(1), source(2)])
  } })
  const run = h.service.start({ requestId: 'source-restart', targetCount: 2 })
  await until(() => entered)
  await h.service.stop()
  assert.equal(h.current(run.id).collection.status, 'interrupted')
  const restarted = h.restart()
  assert.ok(restarted.runAutomaticRecovery().includes(run.id))
  await restarted.waitForIdle()
  assert.equal(h.current(run.id).collection.status, 'completed')
  assert.equal(h.current(run.id).counts.selected, 2)
  assert.equal(h.jobs.size, 2)
})

test('recovery finishes interrupted collection before starting its queued production exactly once', async t => {
  const originalCollection = gate(), recoveredCollection = gate()
  let starts = 0, originalEntered = false, recoveryEntered = false
  const h = fixture(t, { collect: async options => {
    starts++
    await stream({ ...options, report: event => { if (event.stage !== 'exhausted') options.report(event) } }, [source(1)])
    if (starts === 1) {
      originalEntered = true
      await originalCollection.wait(options.signal)
    } else {
      recoveryEntered = true
      await recoveredCollection.wait(options.signal)
    }
    await stream(options, [source(2)])
  } })
  const run = h.service.start({ requestId: 'recover-collection-before-production', targetCount: 2 })
  await until(() => originalEntered)
  assert.equal(h.current(run.id).processing.status, 'queued')
  await h.service.stop()
  assert.equal(h.current(run.id).collection.status, 'interrupted')
  assert.equal(h.current(run.id).processing.status, 'queued')
  assert.equal(h.jobs.size, 1)
  const restarted = h.restart()
  assert.ok(restarted.runAutomaticRecovery().includes(run.id))
  await until(() => recoveryEntered)
  restarted.runAutomaticRecovery()
  assert.equal(starts, 2, 'repeated recovery must not dispatch a second collector')
  assert.equal(h.current(run.id).collection.status, 'running')
  assert.equal(h.current(run.id).processing.status, 'queued')
  assert.equal(h.calls.length, 0, 'production waits for the original collection scope to finish')
  recoveredCollection.release()
  await restarted.waitForIdle()
  assert.equal(h.current(run.id).collection.status, 'completed')
  assert.equal(h.current(run.id).processing.status, 'completed')
  assert.equal(h.current(run.id).counts.selected, 2)
  assert.equal(h.jobs.size, 2)
  assert.equal(h.calls.length, 2)
  assert.equal(new Set(h.calls).size, 2)
  assert.equal(h.maximumActive(), 1)
})

test('missing or deleted production accounts do not prevent collecting the complete source target', async t => {
  for (const message of ['请先选择花生账号', '原花生账号已删除']) {
    await t.test(message, async t => {
      const h = fixture(t, { lists: { [channels[0]!]: [source(1), source(2)], [channels[1]!]: [source(3)] },
        validateAccounts: (mode, hs, bj) => {
          if (mode === 'videos') throw new ScienceWorkflowError(message)
          return { huashengAccountName: hs ?? null, baijiahaoAccountName: bj ?? null }
        } })
      const run = h.service.start({ requestId: 'account-blocks-production-only' })
      await h.service.waitForIdle()
      const result = h.current(run.id)
      assert.equal(result.collection.status, 'completed')
      assert.equal(result.counts.selected, 3)
      assert.equal(h.jobs.size, 3)
      assert.deepEqual(h.visited, channels)
      assert.equal(result.processing.status, 'needs_attention')
      assert.ok(result.processing.message.includes(message))
      assert.equal(h.calls.length, 0)
    })
  }
})

test('resuming paused production queues behind another service and starts automatically when its lock releases', async t => {
  const secondProduction = gate()
  let firstBlocked = true
  const h = fixture(t, { lists: { [channels[0]!]: [source(1), source(2)] }, process: async (job, signal) => {
    if (job.sourceUrl === source(1).sourceUrl && firstBlocked) throw new ScienceWorkflowError('花生账号未登录，无法读取接口会话')
    if (job.sourceUrl === source(2).sourceUrl) await secondProduction.wait(signal)
  } })
  const first = h.service.start({ requestId: 'paused-production-queue', targetCount: 1 })
  await h.service.waitForIdle()
  assert.equal(h.current(first.id).processing.status, 'needs_attention')
  firstBlocked = false
  const secondService = h.restart()
  const second = secondService.start({ requestId: 'other-service-production', targetCount: 1 })
  await until(() => h.calls.length === 2 && h.current(second.id).processing.status === 'running')
  const visits = [...h.visited]
  h.service.resumeProcessing(first.id)
  assert.equal(h.current(first.id).processing.status, 'queued')
  assert.equal(h.calls.length, 2)
  secondProduction.release()
  await secondService.waitForIdle()
  assert.equal(h.current(first.id).processing.status, 'completed')
  assert.equal(h.current(second.id).processing.status, 'completed')
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[0], h.calls[2], 'the original paused job is consumed from the persisted queue')
  assert.equal(h.maximumActive(), 1)
  assert.deepEqual(h.visited, visits)
})

test('resuming an already completed collection never resumes its blocked production', async t => {
  let blocked = true
  const h = fixture(t, { lists: { [channels[0]!]: [source(1), source(2), source(3)] },
    process: async () => { if (blocked) throw new ScienceWorkflowError('花生账号未登录，无法读取接口会话') } })
  const run = h.service.start({ requestId: 'collection-resume-is-not-processing-resume' })
  await h.service.waitForIdle()
  assert.equal(h.current(run.id).collection.status, 'completed')
  assert.equal(h.current(run.id).processing.status, 'needs_attention')
  const visits = [...h.visited], calls = [...h.calls]
  blocked = false
  h.service.resumeCollection(run.id)
  await h.service.waitForIdle()
  assert.equal(h.current(run.id).processing.status, 'needs_attention')
  assert.deepEqual(h.visited, visits)
  assert.deepEqual(h.calls, calls)
  h.service.resumeProcessing(run.id)
  await h.service.waitForIdle()
  assert.equal(h.current(run.id).processing.status, 'completed')
  assert.equal(h.current(run.id).counts.completed, 3)
  assert.deepEqual(h.visited, visits)
})

test('an active legacy integrated worker blocks a new collector until the legacy worker releases its scope', async t => {
  const h = fixture(t, { lists: { [channels[0]!]: [source(1), source(2)] } })
  const original = h.service.start({ requestId: 'prepare-legacy-worker', targetCount: 1 })
  await h.service.waitForIdle()
  const file = path.join(h.root, 'runs', `${original.id}.json`)
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete legacy.collection; delete legacy.processing
  Object.assign(legacy, { status: 'running', ownerPid: process.ppid, targetCount: 3 })
  fs.writeFileSync(file, JSON.stringify(legacy))
  fs.writeFileSync(path.join(h.root, 'worker.lock'), JSON.stringify({ pid: process.ppid, id: original.id, token: randomUUID() }))
  const visits = [...h.visited]
  assert.throws(() => h.service.start({ requestId: 'do-not-overlap-legacy-collector', targetCount: 1 }), ScienceWorkflowError)
  assert.deepEqual(h.visited, visits)
  assert.equal(h.jobs.size, 1)
})

test('automatic recovery migrates an interrupted legacy batch and collects its remaining source target', async t => {
  const lists = { [channels[0]!]: [source(1)] }
  const h = fixture(t, { lists })
  const original = h.service.start({ requestId: 'prepare-interrupted-legacy', targetCount: 2 })
  await h.service.waitForIdle()
  assert.equal(h.jobs.size, 1)
  const file = path.join(h.root, 'runs', `${original.id}.json`)
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete legacy.collection; delete legacy.processing; delete legacy.ownerPid
  Object.assign(legacy, { status: 'interrupted', stopRequested: false })
  fs.writeFileSync(file, JSON.stringify(legacy))
  lists[channels[0]!].push(source(2))
  const visits = h.visited.length
  const restarted = h.restart()
  assert.ok(restarted.runAutomaticRecovery().includes(original.id))
  await restarted.waitForIdle()
  const result = h.current(original.id)
  assert.equal(result.counts.selected, 2)
  assert.equal(result.counts.completed, 2)
  assert.equal(result.collection.status, 'completed')
  assert.equal(result.processing.status, 'completed')
  assert.equal(h.jobs.size, 2)
  assert.equal(h.calls.length, 2, 'already completed legacy output is not produced again')
  assert.ok(h.visited.length > visits, 'legacy recovery resumes collection before completing the batch')
})

test('sources appended after resuming collection are processed after the active production snapshot', async t => {
  const collection = gate(), production = gate()
  let collectingFirstScope = true, collectionEntered = false
  const h = fixture(t, { collect: async options => {
    if (collectingFirstScope) {
      collectingFirstScope = false
      await stream({ ...options, report: event => { if (event.stage !== 'exhausted') options.report(event) } }, [source(1)])
      collectionEntered = true
      await collection.wait(options.signal)
    }
    await stream(options, [source(1), source(2), source(3)])
  }, process: async (job, signal) => { if (job.sourceUrl === source(1).sourceUrl) await production.wait(signal) } })
  const run = h.service.start({ requestId: 'resumed-collection-appends-to-production' })
  await until(() => collectionEntered)
  h.service.stopCollection(run.id)
  await until(() => h.calls.length === 1 && h.current(run.id).processing.status === 'running')
  assert.equal(h.current(run.id).collection.status, 'stopped')
  h.service.resumeCollection(run.id)
  await until(() => h.current(run.id).collection.status === 'completed')
  assert.equal(h.jobs.size, 3)
  assert.equal(h.calls.length, 1)
  production.release()
  await h.service.waitForIdle()
  const result = h.current(run.id)
  assert.equal(result.processing.status, 'completed')
  assert.equal(result.counts.completed, 3)
  assert.equal(h.calls.length, 3)
  assert.equal(new Set(h.calls).size, 3)
  assert.equal(h.maximumActive(), 1)
})

test('sources arriving after the previous producer finishes reenter the production queue automatically', async t => {
  const originalCollection = gate(), resumedCollection = gate(), production = gate()
  let originalEntered = false, resumedEntered = false, firstCollection = true
  const h = fixture(t, { collect: async options => {
    if (firstCollection) {
      firstCollection = false
      await stream({ ...options, report: event => { if (event.stage !== 'exhausted') options.report(event) } }, [source(1)])
      originalEntered = true
      await originalCollection.wait(options.signal)
    } else {
      resumedEntered = true
      await resumedCollection.wait(options.signal)
    }
    await stream(options, [source(1), source(2), source(3)])
  }, process: async (job, signal) => { if (job.sourceUrl === source(1).sourceUrl) await production.wait(signal) } })
  const run = h.service.start({ requestId: 'producer-finishes-before-new-sources' })
  await until(() => originalEntered)
  h.service.stopCollection(run.id)
  await until(() => h.calls.length === 1 && h.current(run.id).processing.status === 'running')
  h.service.resumeCollection(run.id)
  await until(() => resumedEntered)
  production.release()
  await until(() => h.current(run.id).processing.status === 'completed')
  assert.equal(h.current(run.id).collection.status, 'running')
  assert.equal(h.current(run.id).counts.completed, 1)
  assert.equal(h.jobs.size, 1)
  resumedCollection.release()
  await h.service.waitForIdle()
  const result = h.current(run.id)
  assert.equal(result.collection.status, 'completed')
  assert.equal(result.processing.status, 'completed')
  assert.equal(result.counts.selected, 3)
  assert.equal(result.counts.completed, 3)
  assert.equal(h.calls.length, 3)
  assert.equal(new Set(h.calls).size, 3)
  assert.equal(h.maximumActive(), 1)
})
