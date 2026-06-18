import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-task-worker-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { createTask, getTask, listTaskEvents, requestCancel } = await import('./store.js')
const { clearTaskHandlers, registerTaskHandler } = await import('./registry.js')
const { runWorkerOnce, startTaskWorkerLoop } = await import('./worker.js')

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }
  assert.fail('Timed out waiting for condition')
}

test('runWorkerOnce does not lease tasks when no handlers are registered', async () => {
  clearTaskHandlers()
  const task = createTask({
    type: 'test.no_handler_yet',
    idempotencyKey: 'worker-no-handler-yet',
  })

  const ran = await runWorkerOnce({ workerId: 'worker-a' })

  assert.equal(ran, false)
  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'queued')
  assert.equal(loaded?.leaseOwner, null)
})

test('runWorkerOnce leases a queued task and marks it succeeded', async () => {
  clearTaskHandlers()
  registerTaskHandler('test.success', {
    resumable: true,
    maxAttempts: 1,
    run: async (ctx) => {
      ctx.progress('halfway', 1, 2)
      return { ok: true, payload: ctx.payload }
    },
  })
  const task = createTask({
    type: 'test.success',
    idempotencyKey: 'worker-success',
    payload: { input: 1 },
  })

  const ran = await runWorkerOnce({ workerId: 'worker-a', leaseMs: 30_000 })

  assert.equal(ran, true)
  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'succeeded')
  assert.equal(loaded?.result.ok, true)
  assert.equal(loaded?.leaseOwner, null)
  assert.equal(loaded?.progressMessage, 'halfway')
})

test('runWorkerOnce cancels queued task before executing handler', async () => {
  clearTaskHandlers()
  let executed = false
  registerTaskHandler('test.cancel', {
    resumable: true,
    maxAttempts: 1,
    run: async () => {
      executed = true
    },
  })
  const task = createTask({
    type: 'test.cancel',
    idempotencyKey: 'worker-cancel',
  })
  requestCancel(task.id)

  const ran = await runWorkerOnce({ workerId: 'worker-a' })

  assert.equal(ran, true)
  assert.equal(executed, false)
  assert.equal(getTask(task.id)?.status, 'canceled')
})

test('runWorkerOnce aborts a running handler when cancel is requested', async () => {
  clearTaskHandlers()
  let observedAbort = false
  registerTaskHandler('test.cancel.running', {
    resumable: true,
    maxAttempts: 1,
    run: async (ctx) => {
      ctx.progress('started', 0, 1)
      await new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          observedAbort = true
          reject(new Error('aborted by worker'))
        }, { once: true })
      })
    },
  })
  const task = createTask({
    type: 'test.cancel.running',
    idempotencyKey: 'worker-cancel-running',
  })

  const workerRun = runWorkerOnce({
    workerId: 'worker-a',
    leaseMs: 200,
    heartbeatMs: 10,
    cancelPollMs: 10,
  })
  await waitFor(() => getTask(task.id)?.status === 'running')
  requestCancel(task.id)

  const result = await Promise.race([
    workerRun,
    sleep(300).then(() => 'timeout'),
  ])

  assert.equal(result, true)
  assert.equal(observedAbort, true)
  assert.equal(getTask(task.id)?.status, 'canceled')
  assert.match(getTask(task.id)?.progressMessage || '', /canceled/i)
})

test('runWorkerOnce retries retryable failures until success', async () => {
  clearTaskHandlers()
  let attempts = 0
  registerTaskHandler('test.retry', {
    resumable: true,
    maxAttempts: 2,
    run: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary failure')
      return { attempts }
    },
  })
  const task = createTask({
    type: 'test.retry',
    idempotencyKey: 'worker-retry',
    maxAttempts: 2,
  })

  assert.equal(await runWorkerOnce({ workerId: 'worker-a' }), true)
  assert.equal(getTask(task.id)?.status, 'queued')
  assert.equal(await runWorkerOnce({ workerId: 'worker-a' }), true)

  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'succeeded')
  assert.equal(loaded?.result.attempts, 2)
  assert.equal(loaded?.attempts, 2)

  const events = listTaskEvents(task.id).map(event => event.eventType)
  assert.ok(events.includes('retry.scheduled'))
})

test('runWorkerOnce stops retrying after maxAttempts is reached', async () => {
  clearTaskHandlers()
  registerTaskHandler('test.retry.exhausted', {
    resumable: true,
    maxAttempts: 2,
    run: async () => {
      throw new Error('permanent failure')
    },
  })
  const task = createTask({
    type: 'test.retry.exhausted',
    idempotencyKey: 'worker-retry-exhausted',
    maxAttempts: 2,
  })

  assert.equal(await runWorkerOnce({ workerId: 'worker-a' }), true)
  assert.equal(getTask(task.id)?.status, 'queued')
  assert.equal(await runWorkerOnce({ workerId: 'worker-a' }), true)

  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'failed')
  assert.equal(loaded?.attempts, 2)
  assert.equal(loaded?.errorMessage, 'permanent failure')
})

test('runWorkerOnce heartbeats while a handler is running', async () => {
  clearTaskHandlers()
  registerTaskHandler('test.heartbeat', {
    resumable: true,
    maxAttempts: 1,
    run: async () => {
      await sleep(40)
      return { ok: true }
    },
  })
  const task = createTask({
    type: 'test.heartbeat',
    idempotencyKey: 'worker-heartbeat',
  })

  await runWorkerOnce({
    workerId: 'worker-a',
    leaseMs: 200,
    heartbeatMs: 10,
  })

  const events = listTaskEvents(task.id).map(event => event.eventType)
  assert.ok(events.includes('heartbeat'))
})

test('startTaskWorkerLoop polls queued tasks until stopped', async () => {
  clearTaskHandlers()
  registerTaskHandler('test.loop', {
    resumable: true,
    maxAttempts: 1,
    run: async () => ({ loop: true }),
  })
  const task = createTask({
    type: 'test.loop',
    idempotencyKey: 'worker-loop',
  })

  const loop = startTaskWorkerLoop({
    workerId: 'worker-loop',
    intervalMs: 10,
    leaseMs: 200,
    recoverOnStart: false,
  })
  try {
    await waitFor(() => getTask(task.id)?.status === 'succeeded')
  } finally {
    loop.stop()
  }

  assert.deepEqual(getTask(task.id)?.result, { loop: true })
})
