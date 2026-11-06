import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { NbaVideoService, nbaStartSchema } from './nba-video.js'
import type { NbaArticle, NbaJob, NbaProductionInput } from './nba-types.js'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const account = () => ({ accountName: 'cba_0123456789abcdef0123456789abcdef', label: 'Sports', status: 'ready', message: 'Ready' })
const article = (id: string): NbaArticle => ({ id, url: `https://example.test/news/${id}`, title: `Report ${id}`,
  language: 'en', publisher: 'Example', body: `Independent full report ${id}. `.repeat(110), bodyHash: hash(id),
  wordCount: 440, characterCount: 0, collectedAt: '2026-11-05T00:00:00Z' })
const input = (requestId: string, autoProduce = true, autoUpload = false) => nbaStartSchema.parse({ requestId, collectionMode: 'manual', autoProduce, autoUpload })
function gate() {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { release, async wait(signal: AbortSignal) {
    signal.throwIfAborted()
    let abort!: () => void
    try {
      await Promise.race([ready, new Promise<never>((_resolve, reject) => {
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
  assert.fail('Independent NBA queues did not reach the expected state')
}
async function delivery(input: NbaProductionInput): Promise<Partial<NbaJob>> {
  const file = path.join(input.jobDir, 'independent-video.mp4'), bytes = Buffer.from(`video-${input.job.id}`)
  fs.writeFileSync(file, bytes)
  return { delivery: { videoPath: file, duration: 1, bytes: bytes.length, sha256: hash(bytes), verification: { fixture: true } } }
}
function fixture(t: TestContext, options: {
  collect?: (round: number, signal: AbortSignal) => Promise<NbaArticle[]>
  produce?: (input: NbaProductionInput) => Promise<void>
  upload?: NonNullable<ConstructorParameters<typeof NbaVideoService>[0]>['upload']
  uploadAccount?: () => ReturnType<typeof account>
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nba-independent-')))
  const produced: string[] = [], signals = new Map<string, AbortSignal>(), services: NbaVideoService[] = []
  let rounds = 0, producing = 0, maximumProducing = 0
  const configuration = {
    root, scheduling: false, uploadAccount: options.uploadAccount || account,
    collect: async (request: { signal?: AbortSignal }) => {
      rounds++
      return { articles: options.collect ? await options.collect(rounds, request.signal!) : [article(`round-${rounds}`)], sources: [], excluded: [] }
    },
    produce: async (request: NbaProductionInput) => {
      produced.push(request.job.article.id); signals.set(request.job.article.id, request.signal)
      producing++; maximumProducing = Math.max(maximumProducing, producing)
      try { await options.produce?.(request); request.signal.throwIfAborted(); return await delivery(request) }
      finally { producing-- }
    },
    ...(options.upload ? { upload: options.upload } : {}),
  }
  const open = () => { const service = new NbaVideoService(configuration); services.push(service); return service }
  const service = open()
  t.after(async () => { for (const current of services) await current.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const overview = (current = service): any => current.overview()
  const run = (id: string, current = service): any => overview(current).runs.find((candidate: { id: string }) => candidate.id === id)
  return { root, service, open, overview, run, produced, signals, rounds: () => rounds, maximumProducing: () => maximumProducing }
}

test('completed collection releases its queue while saved production batches run serially', async t => {
  const production = gate()
  const h = fixture(t, { produce: async request => { if (request.job.article.id === 'round-1') await production.wait(request.signal) } })
  const first = h.service.start(input('independent-first'))
  await until(() => h.produced.length === 1)
  assert.equal(h.run(first.id).status, 'completed')
  assert.equal(h.overview().activeCollection, null)
  assert.equal(h.overview().activeProcessing.kind, 'produce')
  const second = h.service.start(input('independent-second'))
  await until(() => h.run(second.id)?.status === 'completed')
  const third = h.service.start(input('independent-third'))
  await until(() => h.run(third.id)?.status === 'completed')
  assert.deepEqual(h.produced, ['round-1'])
  assert.equal(h.overview().queuedProcessing.length, 2)
  for (const collection of [first, second, third]) {
    const saved = h.run(collection.id), consumer = h.run(saved.productionRunId)
    assert.equal(consumer.collectionRunId, collection.id)
    assert.deepEqual(consumer.jobIds, saved.jobIds)
  }
  production.release()
  await h.service.waitForIdle()
  assert.deepEqual(h.produced, ['round-1', 'round-2', 'round-3'])
  assert.equal(h.maximumProducing(), 1)
  assert.equal(h.overview().activeProcessing, null)
  assert.deepEqual(h.overview().queuedProcessing, [])
})

test('production and upload failures leave their completed collection successful', async t => {
  await t.test('production failure', async t => {
    const h = fixture(t, { produce: async () => { throw new Error('fixture production failure') } })
    const collection = h.service.start(input('production-failure-isolated'))
    await h.service.waitForIdle()
    const saved = h.run(collection.id), processing = h.run(saved.productionRunId)
    assert.equal(saved.status, 'completed')
    assert.equal(saved.jobIds.length, 1)
    assert.equal(processing.status, 'attention')
    assert.equal(h.service.overview().jobs[0]!.status, 'failed')
  })
  await t.test('upload failure', async t => {
    const h = fixture(t, { upload: async () => { throw new Error('fixture upload login failure') } })
    const collection = h.service.start(input('upload-failure-isolated', true, true))
    await h.service.waitForIdle()
    const saved = h.run(collection.id), processing = h.run(saved.productionRunId)
    assert.equal(saved.status, 'completed')
    assert.equal(processing.status, 'failed')
    assert.match(processing.message, /upload login failure/)
    assert.equal(h.service.overview().jobs[0]!.status, 'completed')
  })
})

test('stopping a collector does not cancel the independent running production', async t => {
  const production = gate(), collection = gate()
  let collecting = false
  const h = fixture(t, { collect: async (round, signal) => {
    if (round === 2) { collecting = true; await collection.wait(signal) }
    return [article(`round-${round}`)]
  }, produce: async request => { if (request.job.article.id === 'round-1') await production.wait(request.signal) } })
  const first = h.service.start(input('collector-stop-first'))
  await until(() => h.produced.length === 1)
  const second = h.service.start(input('collector-stop-second'))
  await until(() => collecting)
  h.service.stop(second.id)
  await until(() => h.run(second.id)?.status === 'stopped')
  assert.equal(h.signals.get('round-1')!.aborted, false)
  assert.equal(h.run(h.run(first.id).productionRunId).status, 'running')
  production.release()
  await h.service.waitForIdle()
  assert.deepEqual(h.produced, ['round-1'])
})

test('stopping a production does not cancel its independently running collector', async t => {
  const production = gate(), collection = gate()
  let collecting = false, collectionSignal: AbortSignal | undefined
  const h = fixture(t, { collect: async (round, signal) => {
    if (round === 2) { collecting = true; collectionSignal = signal; await collection.wait(signal) }
    return [article(`round-${round}`)]
  }, produce: async request => { if (request.job.article.id === 'round-1') await production.wait(request.signal) } })
  const first = h.service.start(input('production-stop-first'))
  await until(() => h.produced.length === 1)
  const second = h.service.start(input('production-stop-second'))
  await until(() => collecting)
  const producerId = h.run(first.id).productionRunId
  h.service.stop(producerId)
  await until(() => h.run(producerId)?.status === 'stopped')
  assert.equal(collectionSignal!.aborted, false)
  assert.equal(h.run(second.id).status, 'running')
  collection.release()
  await h.service.waitForIdle()
  assert.equal(h.run(second.id).status, 'completed')
  assert.equal(h.run(h.run(second.id).productionRunId).status, 'completed')
})

test('collection without automatic production finishes after storing its sources', async t => {
  const h = fixture(t)
  const collection = h.service.start(input('collection-only-completed', false))
  await h.service.waitForIdle()
  assert.equal(h.run(collection.id).status, 'completed')
  assert.equal(h.run(collection.id).productionRunId, undefined)
  assert.equal(h.overview().runs.length, 1)
  assert.deepEqual(h.produced, [])
  assert.equal(h.service.overview().jobs[0]!.status, 'queued')
})

test('the collection queue still rejects a second collector while the first is active', async t => {
  const collection = gate()
  let entered = false
  const h = fixture(t, { collect: async (_round, signal) => { entered = true; await collection.wait(signal); return [article('single-source')] } })
  h.service.start(input('collector-mutual-exclusion-first', false))
  await until(() => entered)
  assert.throws(() => h.service.start(input('collector-mutual-exclusion-second', false)), /采集|NBA.*运行/)
  assert.equal(h.rounds(), 1)
  collection.release()
  await h.service.waitForIdle()
  assert.equal(h.service.overview().jobs.length, 1)
})

test('stopping a queued production preserves other batches and never runs the stopped scope', async t => {
  const production = gate()
  const h = fixture(t, { produce: async request => { if (request.job.article.id === 'round-1') await production.wait(request.signal) } })
  const first = h.service.start(input('queued-stop-first'))
  await until(() => h.produced.length === 1)
  const second = h.service.start(input('queued-stop-second'))
  await until(() => h.run(second.id)?.status === 'completed')
  const queuedId = h.run(second.id).productionRunId
  assert.equal(h.run(queuedId).status, 'queued')
  h.service.stop(queuedId)
  assert.equal(h.run(queuedId).status, 'stopped')
  assert.equal(h.run(first.id).status, 'completed')
  assert.equal(h.signals.get('round-1')!.aborted, false)
  production.release()
  await h.service.waitForIdle()
  assert.deepEqual(h.produced, ['round-1'])
  assert.equal(h.run(second.id).status, 'completed')
  assert.equal(h.run(queuedId).status, 'stopped')
})

test('repeating the collection request creates exactly one linked production run', async t => {
  const h = fixture(t)
  const request = input('collection-production-idempotent')
  const first = h.service.start(request)
  assert.equal(h.service.start(request).id, first.id)
  await h.service.waitForIdle()
  assert.equal(h.service.start(request).id, first.id)
  await h.service.waitForIdle()
  assert.equal(h.rounds(), 1)
  assert.deepEqual(h.produced, ['round-1'])
  assert.equal(h.overview().runs.filter((run: any) => run.collectionRunId === first.id).length, 1)
})

test('queued production survives service restart without restarting an explicitly stopped run', async t => {
  const production = gate()
  const h = fixture(t, { produce: async request => { if (request.job.article.id === 'round-1') await production.wait(request.signal) } })
  const first = h.service.start(input('restart-first-production'))
  await until(() => h.produced.length === 1)
  const second = h.service.start(input('restart-queued-production'))
  await until(() => h.run(second.id)?.status === 'completed')
  const stopped = h.run(first.id).productionRunId, queued = h.run(second.id).productionRunId
  assert.equal(h.run(queued).status, 'queued')
  h.service.stop(stopped)
  await h.service.close()
  const restarted = h.open()
  await restarted.waitForIdle()
  assert.equal(h.run(stopped, restarted).status, 'stopped')
  assert.equal(h.run(queued, restarted).status, 'completed')
  assert.deepEqual(h.produced, ['round-1', 'round-2'])
})

test('a different service can collect while the original consumer later drains its durable queue', async t => {
  const production = gate()
  const h = fixture(t, { produce: async request => { if (request.job.article.id === 'round-1') await production.wait(request.signal) } })
  const first = h.service.start(input('cross-service-first'))
  await until(() => h.produced.length === 1)
  const other = h.open()
  const second = other.start(input('cross-service-second'))
  await until(() => h.run(second.id, other)?.status === 'completed')
  assert.equal(h.run(h.run(second.id, other).productionRunId, other).status, 'queued')
  assert.equal(h.run(first.id, other).status, 'completed')
  production.release()
  await h.service.waitForIdle()
  await other.waitForIdle()
  assert.deepEqual(h.produced, ['round-1', 'round-2'])
  assert.equal(h.maximumProducing(), 1)
  assert.equal(h.run(h.run(second.id).productionRunId).status, 'completed')
})

test('a live legacy integrated collector still excludes new source collection', async t => {
  const h = fixture(t)
  const original = h.service.start(input('legacy-source-base', false))
  await h.service.waitForIdle()
  const stateFile = path.join(h.root, '.console.json'), lockFile = path.join(h.root, '.production.lock')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const legacy = state.runs.find((run: any) => run.id === original.id)
  delete legacy.queueVersion
  Object.assign(legacy, { status: 'running', message: 'Legacy integrated collection is still active' })
  fs.writeFileSync(stateFile, JSON.stringify(state))
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, runId: original.id }))
  t.after(() => fs.rmSync(lockFile, { force: true }))
  const other = h.open()
  assert.throws(() => other.start(input('legacy-source-contender', false)), /采集|NBA.*运行/)
  assert.equal(h.rounds(), 1)
  assert.equal(h.overview(other).runs.length, 1)
})

test('queued production remains executable when completed collection history is pruned', async t => {
  const production = gate()
  const h = fixture(t, { collect: async round => round <= 2 ? [article(`round-${round}`)] : [],
    produce: async request => { if (request.job.article.id === 'round-1') await production.wait(request.signal) } })
  h.service.start(input('history-pruning-first'))
  await until(() => h.produced.length === 1)
  const second = h.service.start(input('history-pruning-second'))
  await until(() => h.run(second.id)?.status === 'completed')
  const queuedId = h.run(second.id).productionRunId
  const file = path.join(h.root, '.console.json'), state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const previous = h.run(second.id)
  for (let index = 0; index < 200; index++) state.runs.unshift({ ...previous, id: `nba-history-${index}`,
    requestId: `history-${index}`, productionRunId: undefined, jobIds: [] })
  fs.writeFileSync(file, JSON.stringify(state))
  const trimming = h.service.start(input('history-triggers-trimming', false))
  await until(() => h.run(trimming.id)?.status === 'completed')
  production.release()
  await h.service.waitForIdle()
  assert.equal(h.run(queuedId).status, 'completed')
  assert.deepEqual(h.produced, ['round-1', 'round-2'])
})

test('production enters the durable queue only after its upload configuration is ready', async t => {
  let armed = false, uploads = 0, peer: NbaVideoService | undefined, peerWork: Promise<void> | undefined
  const h = fixture(t, { uploadAccount: () => {
    if (armed) { armed = false; peerWork = peer!.waitForIdle() }
    return account()
  }, upload: async request => {
    uploads++
    assert.equal(request.accountName, account().accountName)
    return { saved: false, message: 'Fixture upload observed' }
  } })
  h.service.settings({ ...h.overview().settings, autoUpload: true })
  const collection = h.service.start(input('configure-queue-source', false))
  await h.service.waitForIdle()
  peer = h.open()
  armed = true
  const resumed = h.service.resume({ requestId: 'configure-queue-produce', jobIds: h.run(collection.id).jobIds })
  await h.service.waitForIdle()
  await peerWork
  assert.equal(uploads, 1, 'the consumer must observe the saved automatic-upload account selection')
  const saved = h.run(resumed.id)
  assert.equal(saved.autoUpload, true)
  assert.equal(saved.baijiahaoAccountName, account().accountName)
})

test('resuming the original production scope preserves its settings and account without collecting again', async t => {
  const production = gate(), uploads: string[] = []
  let selectedAccount = account()
  const h = fixture(t, { uploadAccount: () => selectedAccount, produce: async request => {
    if (request.job.article.id === 'round-1') await production.wait(request.signal)
  }, upload: async request => {
    uploads.push(request.accountName)
    const id = `upload-${request.job.id}`, fingerprint = hash(id), timestamp = '2026-11-05T00:00:00Z'
    request.persist({ id, target: 'baijiahao-video', accountName: request.accountName, accountLabel: request.accountLabel,
      fingerprint, inputDigest: request.job.delivery!.sha256, status: 'saved', dispatched: true, message: 'Submitted',
      createdAt: timestamp, updatedAt: timestamp,
      payload: { jobId: id, scriptId: 1, target: 'baijiahao-video', publicationMode: 'publish', accountName: request.accountName,
        fingerprint, title: request.job.title, description: 'Test news #NBA#', tags: ['#NBA#'], topicPolicy: 'required-exact', videoPath: request.job.delivery!.videoPath },
      result: { staged: true, saved: false, submitted: true, published: false, publicationStatus: 'submitted', articleId: '123456',
        accountName: request.accountName, targetId: 'a123', engine: 'fixture', editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2' },
    })
    return { saved: true, message: 'Submitted' }
  } })
  h.service.start(input('original-scope-blocking-production'))
  await until(() => h.produced.length === 1)
  const collected = h.service.start(input('original-scope-collected', true, true))
  await until(() => h.run(collected.id)?.status === 'completed')
  const original = structuredClone(h.run(h.run(collected.id).productionRunId))
  h.service.stop(original.id)
  const conflicting = h.service.resume({ requestId: 'original-scope-conflicting-resume', jobIds: original.jobIds })
  assert.throws(() => h.service.resumeRun(original.id), (error: any) => error.status === 409)
  h.service.stop(conflicting.id)
  production.release()
  await h.service.waitForIdle()
  selectedAccount = { ...account(), accountName: 'cba_abcdef0123456789abcdef0123456789', label: 'New default' }
  h.service.settings({ ...h.overview().settings, autoUpload: false, speed: 1.25, voice: 'different_voice' })
  const snapshot = (run: any) => ({ id: run.id, jobIds: run.jobIds, autoUpload: run.autoUpload,
    baijiahaoAccountName: run.baijiahaoAccountName, baijiahaoAccountLabel: run.baijiahaoAccountLabel, productionSettings: run.productionSettings })
  assert.deepEqual(snapshot(h.service.resumeRun(original.id)), snapshot(original))
  await h.service.waitForIdle()
  assert.equal(h.run(original.id).status, 'completed')
  assert.deepEqual(snapshot(h.run(original.id)), snapshot(original))
  assert.deepEqual(uploads, [account().accountName])
  assert.equal(h.rounds(), 2)
  assert.equal(h.service.resumeRun(original.id).id, original.id)
  await h.service.waitForIdle()
  assert.deepEqual(h.produced, ['round-1', 'round-2'])
  assert.deepEqual(uploads, [account().accountName])
  assert.equal(h.rounds(), 2)
})
