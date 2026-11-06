import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { NbaVideoService } from './nba-video.js'

interface WorkerMessage {
  type: 'before-lock' | 'started' | 'completed' | 'closed' | 'rejected' | 'fatal'
  runId?: string
  collects?: number
  status?: number
  message?: string
}

const workerSource = String.raw`
const fs = require('node:fs')
const { parentPort, workerData } = require('node:worker_threads')

;(async () => {
  const { tsImport } = await import('tsx/esm/api')
  const { NbaVideoService, nbaStartSchema } = await tsImport(workerData.moduleUrl, workerData.moduleUrl)
  let collects = 0
  const service = new NbaVideoService({
    root: workerData.root,
    scheduling: false,
    collect: async input => {
      collects++
      if (workerData.pending) {
        await new Promise((resolve, reject) => {
          if (input.signal.aborted) reject(input.signal.reason)
          else input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
        })
      }
      return { articles: [], sources: [{ id: 'fixture', label: 'Local fixture', status: 'ok', count: 0 }], excluded: [] }
    },
    produce: async () => { throw new Error('Race tests must not produce videos') },
  })

  if (workerData.pause) {
    const originalLink = fs.linkSync
    // Suspend after the initial state read, immediately before publishing the lock.
    fs.linkSync = function(source, target, ...args) {
      if (String(target) === workerData.lockFile) {
        parentPort.postMessage({ type: 'before-lock' })
        Atomics.wait(new Int32Array(workerData.gate), 0, 0)
      }
      return originalLink.call(fs, source, target, ...args)
    }
  }

  try {
    const run = service.start(nbaStartSchema.parse({ requestId: workerData.requestId, autoProduce: false, collectionMode: 'manual' }))
    if (workerData.pending) {
      await Promise.resolve()
      parentPort.on('message', async command => {
        if (command !== 'close') return
        try {
          await service.close()
          parentPort.postMessage({ type: 'closed', runId: run.id, collects })
        } catch (error) {
          parentPort.postMessage({ type: 'fatal', message: String(error) })
        } finally { parentPort.close() }
      })
      parentPort.postMessage({ type: 'started', runId: run.id, collects })
      return
    }
    await service.waitForIdle()
    parentPort.postMessage({ type: 'completed', runId: run.id, collects })
  } catch (error) {
    parentPort.postMessage({ type: 'rejected', status: error.status, message: error.message, collects })
  } finally {
    if (!workerData.pending) { await service.close(); parentPort.close() }
  }
})().catch(error => {
  parentPort.postMessage({ type: 'fatal', message: String(error) })
  parentPort.close()
})
`

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nba-service-race-')))
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const workers: Worker[] = []
  const readers: NbaVideoService[] = []
  const release = () => { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0) }
  t.after(async () => {
    release()
    await Promise.all(workers.map(worker => worker.terminate()))
    await Promise.all(readers.map(reader => reader.close()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    release,
    spawn(requestId: string, options: { pause?: boolean; pending?: boolean } = {}) {
      const worker = new Worker(workerSource, {
        eval: true,
        execArgv: [],
        workerData: { root, gate, lockFile: path.join(root, '.collection.lock'), moduleUrl: new URL('./nba-video.ts', import.meta.url).href, requestId, ...options },
      })
      workers.push(worker)
      return worker
    },
    reader() { const reader = new NbaVideoService({ root, scheduling: false }); readers.push(reader); return reader },
  }
}

async function message(t: TestContext, worker: Worker) {
  const [result] = await once(worker, 'message', { signal: t.signal }) as [WorkerMessage]
  assert.notEqual(result.type, 'fatal', result.message)
  return result
}

test('a contender paused before locking cannot overwrite another active worker', { timeout: 15_000 }, async t => {
  const h = fixture(t)
  const contender = h.spawn('race-contender-001', { pause: true })
  assert.equal((await message(t, contender)).type, 'before-lock')

  const owner = h.spawn('race-owner-001', { pending: true })
  const started = await message(t, owner)
  assert.equal(started.type, 'started')
  assert.equal(started.collects, 1)

  const rejection = message(t, contender)
  h.release()
  const rejected = await rejection
  assert.equal(rejected.type, 'rejected')
  assert.equal(rejected.status, 409)
  assert.equal(rejected.collects, 0)

  const overview = h.reader().overview()
  assert.equal(overview.activeRun?.id, started.runId)
  assert.equal(overview.activeRun?.status, 'running')
  assert.deepEqual(overview.runs.map(run => run.id), [started.runId])
  const persisted = JSON.parse(fs.readFileSync(path.join(h.root, '.console.json'), 'utf8'))
  assert.equal(persisted.requests['race-owner-001'].runId, started.runId)
  assert.equal(persisted.requests['race-contender-001'], undefined)
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, '.collection.lock'), 'utf8')).runId, started.runId)

  const closed = message(t, owner)
  owner.postMessage('close')
  assert.equal((await closed).type, 'closed')
})

test('a retry paused before locking reuses the run completed by another worker with the same request', { timeout: 15_000 }, async t => {
  const h = fixture(t)
  const requestId = 'race-same-request-001'
  const retry = h.spawn(requestId, { pause: true })
  assert.equal((await message(t, retry)).type, 'before-lock')

  const first = h.spawn(requestId)
  const completed = await message(t, first)
  assert.equal(completed.type, 'completed')
  assert.equal(completed.collects, 1)

  const retryResult = message(t, retry)
  h.release()
  const reused = await retryResult
  assert.equal(reused.type, 'completed')
  assert.equal(reused.runId, completed.runId)
  assert.equal(reused.collects, 0, 'The acknowledged request must not collect again')

  const overview = h.reader().overview()
  assert.equal(overview.activeRun, null)
  assert.equal(overview.runs.length, 1)
  assert.equal(overview.runs[0].id, completed.runId)
  assert.equal(overview.runs[0].requestId, requestId)
  assert.equal(overview.runs[0].status, 'completed')
  assert.equal(fs.existsSync(path.join(h.root, '.collection.lock')), false)
})
