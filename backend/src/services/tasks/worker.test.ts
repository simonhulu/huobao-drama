import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq, sql } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-task-worker-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const {
  claimQueuedTask,
  createTask,
  getTask,
  listTaskEvents,
  requestCancel,
  transitionTask,
} = await import('./store.js')
const { clearTaskHandlers, registerTaskHandler } = await import('./registry.js')
const { runWorkerOnce, startTaskWorkerLoop } = await import('./worker.js')
const { db, schema } = await import('../../db/index.js')

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

test('runWorkerOnce succeeds after an irreversible publish even when cancellation races afterward', async () => {
  clearTaskHandlers()
  registerTaskHandler('test.publish.commit', {
    resumable: false,
    maxAttempts: 1,
    run: async (ctx) => {
      ctx.markCommitPoint?.()
      requestCancel(ctx.taskId)
      return { published: true }
    },
  })
  const task = createTask({ type: 'test.publish.commit', idempotencyKey: 'worker-publish-commit' })

  assert.equal(await runWorkerOnce({ workerId: 'worker-a' }), true)
  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'succeeded')
  assert.equal(loaded?.cancelRequested, false)
  assert.deepEqual(loaded?.result, { published: true })
})

test('runWorkerOnce abandons a tokenless claim instead of unconditionally failing it', async () => {
  clearTaskHandlers()
  let executed = false
  registerTaskHandler('test.lease.token.missing', {
    resumable: true,
    maxAttempts: 1,
    run: async () => {
      executed = true
    },
  })
  db.run(sql.raw(`
    CREATE TRIGGER clear_test_lease_token
    AFTER UPDATE OF lease_token ON creation_tasks
    WHEN NEW.status = 'running' AND NEW.lease_token IS NOT NULL
    BEGIN
      UPDATE creation_tasks SET lease_token = NULL WHERE id = NEW.id;
    END;
  `))

  try {
    const task = createTask({
      type: 'test.lease.token.missing',
      idempotencyKey: 'worker-lease-token-missing',
    })

    assert.equal(await runWorkerOnce({ workerId: 'worker-a' }), true)
    assert.equal(executed, false)
    const loaded = getTask(task.id)
    assert.equal(loaded?.status, 'running')
    assert.equal(loaded?.leaseOwner, 'worker-a')
    assert.equal(loaded?.leaseToken, null)
    assert.equal(loaded?.attempts, 0)
  } finally {
    db.run(sql.raw('DROP TRIGGER IF EXISTS clear_test_lease_token'))
  }
})

test('a worker that lost its lease cannot overwrite the new owner terminal state', async () => {
  clearTaskHandlers()
  let releaseHandler: () => void = () => {
    throw new Error('Handler release callback was not initialized')
  }
  let markStarted: (() => void) | null = null
  const handlerStarted = new Promise<void>((resolve) => { markStarted = resolve })
  const handlerRelease = new Promise<void>((resolve) => { releaseHandler = resolve })
  registerTaskHandler('test.lease.loss', {
    resumable: true,
    maxAttempts: 1,
    run: async (ctx) => {
      markStarted?.()
      await handlerRelease
      ctx.event('old.worker.event', { source: 'worker-a' })
      return { from: 'worker-a' }
    },
  })
  const task = createTask({ type: 'test.lease.loss', idempotencyKey: 'worker-lease-loss' })
  const workerRun = runWorkerOnce({
    workerId: 'worker-a',
    leaseMs: 60_000,
    heartbeatMs: 60_000,
  })
  await handlerStarted

  transitionTask(task.id, 'queued', { progressMessage: 'Lease recovered by another worker' })
  const replacement = claimQueuedTask(task.id, { workerId: 'worker-b', leaseMs: 60_000 })
  assert.equal(replacement?.leaseOwner, 'worker-b')
  releaseHandler()
  await workerRun

  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'running')
  assert.equal(loaded?.leaseOwner, 'worker-b')
  assert.equal(loaded?.result, null)
  assert.equal(listTaskEvents(task.id).some((event) => event.eventType === 'old.worker.event'), false)
})

test('lease loss from an asynchronous telemetry callback is diagnosed and marks a non-resumable task stale', async () => {
  clearTaskHandlers()
  let telemetryCallbackReturned = false
  registerTaskHandler('test.lease.loss.async-telemetry', {
    resumable: false,
    maxAttempts: 1,
    run: async (ctx) => new Promise((resolve) => {
      setTimeout(() => {
        ctx.event('late.async.telemetry')
        telemetryCallbackReturned = true
        resolve({ late: true })
      }, 20)
    }),
  })
  const task = createTask({
    type: 'test.lease.loss.async-telemetry',
    idempotencyKey: 'worker-lease-loss-async-telemetry',
  })
  const workerRun = runWorkerOnce({
    workerId: 'worker-a',
    leaseMs: 60_000,
    heartbeatMs: 60_000,
  })
  await waitFor(() => getTask(task.id)?.status === 'running')
  db.update(schema.creationTasks)
    .set({ leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() })
    .where(eq(schema.creationTasks.id, task.id))
    .run()

  await workerRun

  assert.equal(telemetryCallbackReturned, true)
  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'stale')
  assert.equal(loaded?.errorCode, 'task_lease_lost')
  assert.match(loaded?.errorMessage || '', /lease/i)
  assert.equal(listTaskEvents(task.id).some(event => event.eventType === 'late.async.telemetry'), false)
  const leaseLoss = listTaskEvents(task.id).find(event => event.eventType === 'task.lease_lost')
  assert.equal(leaseLoss?.data.source, 'event')
  assert.equal(leaseLoss?.data.worker_id, 'worker-a')
  assert.deepEqual(leaseLoss?.data.observed, {
    status: 'running',
    owner_matches: true,
    token_matches: true,
    lease_expires_at: leaseLoss?.data.observed.lease_expires_at,
    lease_expired: true,
    commit_claimed: false,
  })
  assert.equal(typeof leaseLoss?.data.observed.lease_expires_at, 'string')
  assert.equal(leaseLoss?.data.resolution, 'marked_stale')
})

test('an asynchronous task event persistence failure does not escape the handler callback', async () => {
  clearTaskHandlers()
  let callbackThrew = false
  registerTaskHandler('test.async.telemetry.persistence.failure', {
    resumable: true,
    maxAttempts: 1,
    run: async (ctx) => new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          ctx.event('test.async.telemetry.persistence.failure')
          resolve({ completed: true })
        } catch (error) {
          callbackThrew = true
          reject(error)
        }
      }, 20)
    }),
  })
  db.run(sql.raw(`
    CREATE TRIGGER reject_async_task_event
    BEFORE INSERT ON creation_task_events
    WHEN NEW.event_type = 'test.async.telemetry.persistence.failure'
    BEGIN
      SELECT RAISE(ABORT, 'simulated task event persistence failure');
    END;
  `))

  try {
    const task = createTask({
      type: 'test.async.telemetry.persistence.failure',
      idempotencyKey: 'worker-async-telemetry-persistence-failure',
    })

    assert.equal(await runWorkerOnce({ workerId: 'worker-a' }), true)
    assert.equal(callbackThrew, false)
    assert.equal(getTask(task.id)?.status, 'succeeded')
  } finally {
    db.run(sql.raw('DROP TRIGGER IF EXISTS reject_async_task_event'))
  }
})

test('a heartbeat persistence failure aborts the handler without escaping its timer callback', async () => {
  clearTaskHandlers()
  let observedAbort = false
  let uncaughtError: Error | null = null
  const externalAbort = new AbortController()
  registerTaskHandler('test.heartbeat.persistence.failure', {
    resumable: true,
    maxAttempts: 1,
    run: async (ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        observedAbort = true
        resolve({ aborted: true })
      }, { once: true })
    }),
  })
  const task = createTask({
    type: 'test.heartbeat.persistence.failure',
    idempotencyKey: 'worker-heartbeat-persistence-failure',
  })
  const workerRun = runWorkerOnce({
    workerId: 'worker-a',
    leaseMs: 60_000,
    heartbeatMs: 10,
    cancelPollMs: 60_000,
    signal: externalAbort.signal,
  })
  await waitFor(() => getTask(task.id)?.status === 'running')

  const originalTransaction = db.transaction
  const failure = new Error('simulated heartbeat persistence failure')
  Object.defineProperty(db, 'transaction', {
    configurable: true,
    writable: true,
    value: () => { throw failure },
  })
  const onUncaughtException = (error: Error) => {
    uncaughtError = error
    Object.defineProperty(db, 'transaction', {
      configurable: true,
      writable: true,
      value: originalTransaction,
    })
    externalAbort.abort()
  }
  process.once('uncaughtException', onUncaughtException)

  try {
    const outcome = await Promise.race([
      workerRun,
      sleep(500).then(() => 'timeout'),
    ])

    assert.notEqual(outcome, 'timeout')
    assert.equal(uncaughtError, null)
    assert.equal(observedAbort, true)
    assert.equal(getTask(task.id)?.status, 'running')
  } finally {
    process.off('uncaughtException', onUncaughtException)
    Object.defineProperty(db, 'transaction', {
      configurable: true,
      writable: true,
      value: originalTransaction,
    })
    externalAbort.abort()
    await workerRun
  }
})

test('a cancel-poll read failure aborts the handler without escaping its timer callback', async () => {
  clearTaskHandlers()
  let observedAbort = false
  let uncaughtError: Error | null = null
  const externalAbort = new AbortController()
  registerTaskHandler('test.cancel-poll.read.failure', {
    resumable: true,
    maxAttempts: 1,
    run: async (ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        observedAbort = true
        resolve({ aborted: true })
      }, { once: true })
    }),
  })
  const task = createTask({
    type: 'test.cancel-poll.read.failure',
    idempotencyKey: 'worker-cancel-poll-read-failure',
  })
  const workerRun = runWorkerOnce({
    workerId: 'worker-a',
    leaseMs: 60_000,
    heartbeatMs: 60_000,
    cancelPollMs: 10,
    signal: externalAbort.signal,
  })
  await waitFor(() => getTask(task.id)?.status === 'running')

  const originalSelect = db.select
  const failure = new Error('simulated cancel-poll read failure')
  Object.defineProperty(db, 'select', {
    configurable: true,
    writable: true,
    value: () => { throw failure },
  })
  const onUncaughtException = (error: Error) => {
    uncaughtError = error
    Object.defineProperty(db, 'select', {
      configurable: true,
      writable: true,
      value: originalSelect,
    })
    externalAbort.abort()
  }
  process.once('uncaughtException', onUncaughtException)

  try {
    const outcome = await Promise.race([
      workerRun,
      sleep(500).then(() => 'timeout'),
    ])

    Object.defineProperty(db, 'select', {
      configurable: true,
      writable: true,
      value: originalSelect,
    })
    assert.notEqual(outcome, 'timeout')
    assert.equal(uncaughtError, null)
    assert.equal(observedAbort, true)
    assert.equal(getTask(task.id)?.status, 'running')
  } finally {
    process.off('uncaughtException', onUncaughtException)
    Object.defineProperty(db, 'select', {
      configurable: true,
      writable: true,
      value: originalSelect,
    })
    externalAbort.abort()
    await workerRun
  }
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
  const afterFirst = getTask(task.id)
  assert.equal(afterFirst?.status, 'queued')
  const retryNowMs = afterFirst?.scheduledAt
    ? new Date(afterFirst.scheduledAt).getTime() + 1000
    : Date.now()
  assert.equal(await runWorkerOnce({ workerId: 'worker-a', nowMs: retryNowMs }), true)

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
  const afterFirst = getTask(task.id)
  assert.equal(afterFirst?.status, 'queued')
  const retryNowMs = afterFirst?.scheduledAt
    ? new Date(afterFirst.scheduledAt).getTime() + 1000
    : Date.now()
  assert.equal(await runWorkerOnce({ workerId: 'worker-a', nowMs: retryNowMs }), true)

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
    await loop.stop()
  }

  assert.deepEqual(getTask(task.id)?.result, { loop: true })
})

test('startTaskWorkerLoop can execute tasks concurrently', async () => {
  clearTaskHandlers()
  let running = 0
  let maxRunning = 0
  registerTaskHandler('test.loop.concurrent', {
    resumable: true,
    maxAttempts: 1,
    run: async () => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await sleep(80)
      running -= 1
      return { ok: true }
    },
  })
  const tasks = Array.from({ length: 4 }, (_value, index) =>
    createTask({
      type: 'test.loop.concurrent',
      idempotencyKey: `worker-loop-concurrent-${index}`,
    }),
  )

  const loop = startTaskWorkerLoop({
    workerId: 'worker-loop-concurrent',
    intervalMs: 5,
    leaseMs: 500,
    recoverOnStart: false,
    concurrency: 4,
  })
  try {
    await waitFor(() => tasks.every(task => getTask(task.id)?.status === 'succeeded'), 1000)
  } finally {
    await loop.stop()
  }

  assert.equal(running, 0)
  assert.equal(maxRunning, 4)
})

test('runWorkerOnce respects types filter and skips non-matching tasks', async () => {
  clearTaskHandlers()
  registerTaskHandler('test.allowed', {
    resumable: true,
    maxAttempts: 1,
    run: async () => ({ allowed: true }),
  })
  registerTaskHandler('test.blocked', {
    resumable: true,
    maxAttempts: 1,
    run: async () => ({ blocked: true }),
  })
  const allowedTask = createTask({
    type: 'test.allowed',
    idempotencyKey: 'worker-types-allowed',
  })
  const blockedTask = createTask({
    type: 'test.blocked',
    idempotencyKey: 'worker-types-blocked',
  })

  const ran = await runWorkerOnce({ workerId: 'worker-types', types: ['test.allowed'] })

  assert.equal(ran, true)
  assert.equal(getTask(allowedTask.id)?.status, 'succeeded')
  assert.equal(getTask(blockedTask.id)?.status, 'queued')
  assert.equal(getTask(blockedTask.id)?.leaseOwner, null)
})
