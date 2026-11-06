import test, { after, beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-article-queue-test-'))
const databasePath = path.join(root, 'test.db')
process.env.DB_PATH = databasePath
process.env.STORAGE_PATH = root
process.env.TASK_WORKER_DISABLED = '1'
const { db, schema } = await import('../db/index.js')
const { storeHistorySource, updateHistorySource } = await import('./history-script-library.js')
const { attachHistoryVideo, getHistoryDelivery } = await import('./history-script-delivery.js')
const { getHistoryArticle, startHistoryArticle } = await import('./history-script-article.js')
const { createHistoryArticleRoute } = await import('../routes/history-script-article.js')
const { HistoryArticleQueueService, ensureHistoryArticleQueueSchema } = await import('./history-script-article-queue.js')
const { getHistoryProductionGate } = await import('./history-production-gate.js')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const text = '明朝冬季的蔬菜供应有限。运输困难，城里的鲜菜价格可能更高。'

ensureHistoryArticleQueueSchema(db.$client)
beforeEach(() => {
  db.$client.prepare('DELETE FROM history_script_article_queue').run()
  db.$client.prepare('DELETE FROM history_script_deliveries').run()
  db.delete(schema.historyScriptSources).run()
})
after(() => { db.$client.close(); fs.rmSync(root, { recursive: true, force: true }) })

function seed(sourceVideoId = '7395681234567890123') {
  const source = storeHistorySource({ sourceVideoId, title: '明朝冬季菜价', category: 'regional_history', metrics: {}, selection: { reason: 'test', observedAt: '2026-10-14T08:00:00Z', comments: [] } })
  updateHistorySource(source.id, {
    status: 'needs_review', rawTranscript: text, correctedTranscript: text, rewrittenScript: '当前二创口播稿。',
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 12, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text, sourceVideoSha256: '1'.repeat(64), chunks: [{ index: 0, start: 0, duration: 12, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ correctedTranscript: text, corrections: [], factualConcerns: [], factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(text), correctedTranscriptSha256: hash(text), rewriteInputSha256: hash(text) }),
  })
  return source.id
}

function articleOptions(onModel: () => void = () => {}) {
  return {
    root,
    diagnosticsRoot: path.join(root, 'private-diagnostics'),
    caller: async () => { onModel(); return JSON.stringify({ sections: [{ heading: '供给与菜价', paragraphs: [{ text }] }] }) },
    extract: async (_video: string, directory: string, baseUrl: string) => {
      fs.mkdirSync(directory)
      return [1, 2, 3].map(index => {
        fs.writeFileSync(path.join(directory, `frame-${index}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
        return { url: `${baseUrl}/frame-${index}.jpg`, timestamp: index, sectionIndex: 0 }
      })
    },
    // Queue tests use placeholder JPEG bytes; image preparation itself is
    // covered with real images in history-article-images.test.ts.
    prepareImages: async (directory: string, screenshots: Array<{ url: string }>) => {
      const manifest = { version: 1 as const, images: screenshots.slice(0, 2).map((image, index) => ({
        url: image.url, sha256: String(index + 1).repeat(64), quality: { score: 1 },
      })) }
      fs.writeFileSync(path.join(directory, 'body-cover-selection.json'), JSON.stringify(manifest))
      return manifest
    },
    author: { name: '测试作者', bio: '历史阅读' },
  }
}

function worker(t: TestContext, onModel: () => void = () => {}, caller = articleOptions(onModel).caller) {
  const queue = new HistoryArticleQueueService({
    databasePath, articlePollMs: 1,
    article: {
      get: id => getHistoryArticle(id, { root }),
      start: (id, options) => startHistoryArticle(id, {}, { ...articleOptions(), caller, ...options }),
    },
  })
  t.after(() => queue.close())
  return queue
}

async function upload(id: number, name = 'finished.mp4') {
  return attachHistoryVideo(id, new Blob(['local finished video fixture']).stream(), name, { root, probe: async () => 12 })
}

test('upload persists an article request which a restarted worker completes exactly once', async t => {
  const id = seed()
  const delivery = await upload(id)
  assert.equal(delivery.articleGeneration?.status, 'queued')
  assert.equal(getHistoryArticle(id, { root }).status, 'idle', 'upload never starts a model in the request handler')
  let calls = 0
  const queue = worker(t, () => { calls++ })
  assert.equal(queue.listJobs(id).length, 1)
  await queue.runPending()
  assert.equal(queue.listJobs(id)[0]!.status, 'completed')
  assert.equal(getHistoryDelivery(id).articleGeneration?.status, 'completed')
  assert.equal(getHistoryArticle(id, { root }).status, 'completed')
  const restarted = worker(t, () => { calls++ })
  await restarted.runPending()
  assert.equal(calls, 1)
})

test('article queue gives active projects priority over an older unreserved request', async t => {
  const older = seed(), active = seed('7395681234567890124')
  await upload(older); await upload(active)
  const gate = getHistoryProductionGate(db.$client)
  assert.equal(gate.tryAcquire(active, 'test:active-project'), true)
  t.after(() => gate.release('test:active-project'))
  const started: number[] = []
  const queue = new HistoryArticleQueueService({ databasePath, articlePollMs: 1, article: {
    get: id => getHistoryArticle(id, { root }),
    start: (id, startOptions) => {
      assert.equal(gate.isActive(id), true, 'The queue must hold the project reservation before starting')
      started.push(id)
      return startHistoryArticle(id, {}, { ...articleOptions(), ...startOptions })
    },
  } })
  t.after(() => queue.close())
  await queue.runPending()
  assert.deepEqual(started, [active, older])
  assert.ok(queue.listJobs().every(job => job.status === 'completed'))
  assert.equal(gate.isActive(older), false, 'The queue and generation reservations must both release')
})

test('a full project gate skips the unreserved head and completes an already active project', async t => {
  const older = seed(), active = seed('7395681234567890124')
  await upload(older); await upload(active)
  const gate = getHistoryProductionGate(db.$client)
  assert.equal(gate.tryAcquire(900001, 'test:other-project'), true)
  assert.equal(gate.tryAcquire(active, 'test:active-project'), true)
  t.after(() => { gate.release('test:other-project'); gate.release('test:active-project') })
  let calls = 0
  const queue = worker(t, () => { calls++ })
  await queue.runPending()
  assert.equal(queue.listJobs(older)[0]!.status, 'queued')
  assert.equal(queue.listJobs(active)[0]!.status, 'completed')
  assert.equal(calls, 1)
  gate.release('test:other-project'); gate.release('test:active-project')
  await queue.runPending()
  assert.equal(queue.listJobs(older)[0]!.status, 'completed')
  assert.equal(calls, 2)
  assert.deepEqual(gate.overview(), { limit: 2, activeProjects: 0, waitingProjects: 0 })
})

test('a failed queue claim releases its project reservation before propagating the database error', async t => {
  const id = seed(); await upload(id)
  const gate = getHistoryProductionGate(db.$client)
  const queue = worker(t)
  db.$client.exec(`CREATE TRIGGER reject_article_claim BEFORE UPDATE OF owner ON history_script_article_queue
    WHEN NEW.owner IS NOT NULL BEGIN SELECT RAISE(ABORT, 'mock article claim failed'); END`)
  try { await assert.rejects(queue.runPending(), /mock article claim failed/) }
  finally { db.$client.exec('DROP TRIGGER reject_article_claim') }
  assert.equal(queue.listJobs(id)[0]!.status, 'queued')
  assert.deepEqual(gate.overview(), { limit: 2, activeProjects: 0, waitingProjects: 0 })
  await queue.runPending()
  assert.equal(queue.listJobs(id)[0]!.status, 'completed')
  assert.equal(gate.isActive(id), false)
})

test('worker startup never backfills historical deliveries without an upload outbox entry', async t => {
  const id = seed()
  await upload(id)
  db.$client.prepare('DELETE FROM history_script_article_queue').run()
  let calls = 0
  const queue = worker(t, () => { calls++ })
  await queue.runPending()
  assert.deepEqual(queue.listJobs(), [])
  assert.equal(getHistoryDelivery(id).articleGeneration, null)
  assert.equal(getHistoryArticle(id, { root }).status, 'idle')
  assert.equal(calls, 0)
})

test('changed scripts and in-place replaced video bytes fail the upload snapshot before any model call', async t => {
  const id = seed()
  const first = await upload(id)
  updateHistorySource(id, { rewrittenScript: '已经修改的当前二创稿。' })
  let calls = 0
  const queue = worker(t, () => { calls++ })
  await queue.runPending()
  assert.equal(queue.listJobs(id)[0]!.status, 'failed')
  assert.equal(getHistoryDelivery(id).videoUrl, first.videoUrl)
  await upload(id, 'current.mp4')
  const videoUrl = getHistoryDelivery(id).videoUrl!
  fs.appendFileSync(path.join(root, videoUrl.slice('/static/'.length)), 'replaced bytes')
  await queue.runPending()
  assert.equal(queue.listJobs(id)[0]!.status, 'failed')
  assert.equal(calls, 0)
})

test('failed models stay failed across workers and the existing article POST explicitly retries', async t => {
  const id = seed()
  await upload(id)
  let calls = 0
  const queue = worker(t, () => {}, async () => { calls++; throw new Error('mock model unavailable') })
  await queue.runPending()
  assert.equal(queue.listJobs(id)[0]!.status, 'failed')
  assert.equal(getHistoryProductionGate(db.$client).isActive(id), false, 'Failed generation and observation must release both work keys')
  await queue.runPending()
  const restarted = worker(t, () => { calls++ })
  await restarted.runPending()
  assert.equal(calls, 1)
  const app = new Hono().route('/:id/article', createHistoryArticleRoute(articleOptions(() => { calls++ })))
  const response = await app.request(`/${id}/article`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(response.status, 200)
  assert.equal(getHistoryDelivery(id).articleGeneration?.status, 'generating')
  await restarted.runPending()
  assert.equal(getHistoryDelivery(id).articleGeneration?.status, 'completed')
  assert.equal(calls, 2)
})

test('a new upload authorizes one generation after an older article failed without retrying the failed job', async t => {
  const id = seed()
  const first = await upload(id)
  let calls = 0
  const queue = worker(t, () => {}, async () => { calls++; throw new Error('mock model unavailable') })
  await queue.runPending()
  const failedJob = queue.listJobs(id)[0]!
  assert.equal(failedJob.status, 'failed')
  assert.equal(getHistoryArticle(id, { root }).status, 'failed')
  await queue.runPending()
  const restarted = worker(t, () => { calls++ })
  await restarted.runPending()
  assert.equal(calls, 1, 'A failed upload request cannot automatically retry')

  const replacement = await upload(id, 'replacement.mp4')
  assert.notEqual(replacement.videoUrl, first.videoUrl)
  assert.equal(replacement.articleGeneration?.status, 'queued')
  const newJob = restarted.listJobs(id)[0]!
  assert.notEqual(newJob.id, failedJob.id)
  await restarted.runPending()
  const jobs = restarted.listJobs(id)
  assert.equal(jobs.find(job => job.id === failedJob.id)!.status, 'failed')
  assert.equal(jobs.find(job => job.id === newJob.id)!.status, 'completed')
  const article = getHistoryArticle(id, { root })
  assert.equal(article.status, 'completed')
  assert.equal(article.article?.provenance.videoUrl, replacement.videoUrl)
  assert.equal(calls, 2, 'The replacement upload authorizes exactly one additional model call')
  await restarted.runPending()
  await worker(t, () => { calls++ }).runPending()
  assert.equal(calls, 2)
})

test('an overlapping replacement upload keeps its authorization until the older active model fails', async t => {
  const id = seed()
  await upload(id)
  let rejectOld!: (error: Error) => void
  let entered!: () => void
  const oldResponse = new Promise<string>((_resolve, reject) => { rejectOld = reject })
  const oldStarted = new Promise<void>(resolve => { entered = resolve })
  t.after(() => rejectOld(new Error('mock old model stopped')))
  let oldCalls = 0
  const original = worker(t, () => {}, async () => { oldCalls++; entered(); return oldResponse })
  const oldExecution = original.runPending()
  await oldStarted

  const replacement = await upload(id, 'replacement.mp4')
  let observed!: () => void
  const observedOldRun = new Promise<void>(resolve => { observed = resolve })
  let newCalls = 0
  const options = articleOptions(() => { newCalls++ })
  const next = new HistoryArticleQueueService({
    databasePath, articlePollMs: 1, articleTimeoutMs: 2000,
    article: {
      get: sourceId => {
        const state = getHistoryArticle(sourceId, { root })
        if (state.status === 'generating') observed()
        return state
      },
      start: (sourceId, startOptions) => startHistoryArticle(sourceId, {}, { ...options, ...startOptions }),
    },
  })
  t.after(() => next.close())
  const newExecution = next.runPending()
  await observedOldRun
  assert.equal(newCalls, 0, 'A different active generation must finish before the replacement starts')
  rejectOld(new Error('mock old model failed'))
  await oldExecution
  await newExecution

  const jobs = next.listJobs(id)
  assert.equal(jobs.length, 2)
  assert.equal(jobs[1]!.status, 'failed')
  assert.equal(jobs[0]!.status, 'completed', jobs[0]!.message)
  const article = getHistoryArticle(id, { root })
  assert.equal(article.status, 'completed')
  assert.equal(article.article?.provenance.videoUrl, replacement.videoUrl)
  assert.equal(oldCalls, 1)
  assert.equal(newCalls, 1, 'The unused replacement authorization permits exactly one generation')
  await worker(t, () => { newCalls++ }).runPending()
  assert.equal(newCalls, 1)
})

test('article GET exposes upload queue metadata without replacing article state or triggering generation', async t => {
  const id = seed()
  await upload(id)
  let calls = 0
  const app = new Hono().route('/:id/article', createHistoryArticleRoute(articleOptions(() => { calls++ })))
  const read = async () => {
    const response = await app.request(`/${id}/article`)
    assert.equal(response.status, 200)
    return (await response.json()).data
  }
  const queued = await read()
  assert.equal(queued.status, 'idle')
  assert.deepEqual(queued.articleGeneration, getHistoryDelivery(id).articleGeneration)
  assert.equal(queued.articleGeneration.status, 'queued')
  assert.equal(calls, 0)

  const queue = worker(t, () => {}, async () => { calls++; throw new Error('mock model unavailable') })
  await queue.runPending()
  const failed = await read()
  assert.equal(failed.status, 'failed')
  assert.equal(failed.articleGeneration.status, 'failed')
  assert.equal(failed.articleGeneration.message, queue.listJobs(id)[0]!.message)
  assert.match(failed.articleGeneration.message, /生成失败/)

  await upload(id, 'replacement.mp4')
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = await read()
    assert.equal(pending.status, 'failed', 'The worker must still observe the previous article failure')
    assert.equal(pending.articleGeneration.status, 'queued')
  }
  assert.equal(calls, 1, 'Article GET must never start or retry a model')
})

test('a crash after persisting model-start intent cannot automatically issue another model call', async t => {
  const id = seed()
  await upload(id)
  db.$client.prepare("UPDATE history_script_article_queue SET status='generating',generation_requested=1").run()
  let calls = 0
  const queue = worker(t, () => { calls++ })
  await queue.runPending()
  assert.equal(queue.listJobs(id)[0]!.status, 'failed')
  assert.match(queue.listJobs(id)[0]!.message, /启动结果不确定/)
  await worker(t, () => { calls++ }).runPending()
  assert.equal(calls, 0)
})

test('a completed model result survives a crash before outbox acknowledgement without another charge', async t => {
  const id = seed()
  await upload(id)
  let calls = 0
  startHistoryArticle(id, {}, articleOptions(() => { calls++ }))
  for (let attempt = 0; getHistoryArticle(id, { root }).status === 'generating'; attempt++) {
    assert.ok(attempt < 100)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(getHistoryArticle(id, { root }).status, 'completed')
  const queue = worker(t, () => { calls++ })
  assert.equal(queue.listJobs(id)[0]!.status, 'generating')
  await queue.runPending()
  assert.equal(queue.listJobs(id)[0]!.status, 'completed')
  assert.equal(calls, 1)
})

test('a live worker cannot be stolen and stopping observation lets another worker join the same generation', async t => {
  const id = seed()
  await upload(id)
  let finish!: (value: string) => void
  let entered!: () => void
  const response = new Promise<string>(resolve => { finish = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  t.after(() => finish(JSON.stringify({ sections: [{ heading: '菜价', paragraphs: [{ text }] }] })))
  let calls = 0
  const first = worker(t, () => {}, async () => { calls++; entered(); return response })
  const execution = first.runPending()
  await started
  const other = worker(t, () => { calls++ })
  await other.runPending()
  assert.equal(calls, 1)
  assert.equal(other.listJobs(id)[0]!.status, 'generating')
  await first.stop()
  await execution
  assert.equal(getHistoryProductionGate(db.$client).isActive(id), true, 'Stopping queue observation must retain the actual generation reservation')
  const joined = other.runPending()
  finish(JSON.stringify({ sections: [{ heading: '菜价', paragraphs: [{ text }] }] }))
  await joined
  assert.equal(other.listJobs(id)[0]!.status, 'completed')
  assert.equal(calls, 1)
  assert.equal(getHistoryProductionGate(db.$client).isActive(id), false)
})

test('failure to persist the article outbox rolls back video association and cleans only the new upload', async () => {
  const id = seed()
  const previous = await upload(id)
  db.$client.exec(`CREATE TRIGGER reject_article_outbox BEFORE INSERT ON history_script_article_queue
    BEGIN SELECT RAISE(ABORT, 'mock outbox unavailable'); END`)
  try { await assert.rejects(upload(id, 'replacement.mp4'), /mock outbox unavailable/) }
  finally { db.$client.exec('DROP TRIGGER reject_article_outbox') }
  assert.equal(getHistoryDelivery(id).videoUrl, previous.videoUrl)
  assert.equal((await fs.promises.readdir(path.join(root, 'history-deliveries', String(id)))).length, 1)
  const row = db.$client.prepare('SELECT COUNT(*) AS count FROM history_script_article_queue').get() as { count: number }
  assert.equal(row.count, 1)
})
