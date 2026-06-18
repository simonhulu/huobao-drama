import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-task-recovery-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { acquireNextQueuedTask, createTask, getTask, transitionTask } = await import('./store.js')
const { clearTaskHandlers, registerTaskHandler } = await import('./registry.js')
const { recoverExpiredRunningTasks } = await import('./recovery.js')

test('recoverExpiredRunningTasks requeues expired resumable running tasks', () => {
  clearTaskHandlers()
  registerTaskHandler('test.resumable', {
    resumable: true,
    maxAttempts: 3,
    run: async () => undefined,
  })
  const task = createTask({
    type: 'test.resumable',
    idempotencyKey: 'recovery-resumable',
  })
  transitionTask(task.id, 'running')

  const recovered = recoverExpiredRunningTasks({
    nowMs: Date.parse('2026-06-17T12:00:00.000Z'),
    expiredBeforeMs: Date.parse('2026-06-17T11:00:00.000Z'),
  })

  assert.equal(recovered.requeued, 1)
  assert.equal(getTask(task.id)?.status, 'queued')
})

test('recoverExpiredRunningTasks skips running tasks with an active lease', () => {
  clearTaskHandlers()
  registerTaskHandler('test.active_lease', {
    resumable: true,
    maxAttempts: 3,
    run: async () => undefined,
  })
  const task = createTask({
    type: 'test.active_lease',
    idempotencyKey: 'recovery-active-lease',
  })
  const leased = acquireNextQueuedTask({
    workerId: 'worker-a',
    leaseMs: 60_000,
    nowMs: Date.parse('2026-06-17T12:00:00.000Z'),
    types: ['test.active_lease'],
  })
  assert.equal(leased?.id, task.id)

  const recovered = recoverExpiredRunningTasks({
    nowMs: Date.parse('2026-06-17T12:00:30.000Z'),
    expiredBeforeMs: Date.parse('2026-06-17T12:00:30.000Z'),
  })

  assert.equal(recovered.skipped, 1)
  assert.equal(getTask(task.id)?.status, 'running')
})

test('recoverExpiredRunningTasks marks expired non-resumable running tasks stale', () => {
  clearTaskHandlers()
  registerTaskHandler('test.non_resumable', {
    resumable: false,
    maxAttempts: 1,
    run: async () => undefined,
  })
  const task = createTask({
    type: 'test.non_resumable',
    idempotencyKey: 'recovery-non-resumable',
  })
  transitionTask(task.id, 'running')

  const recovered = recoverExpiredRunningTasks({
    nowMs: Date.parse('2026-06-17T12:00:00.000Z'),
    expiredBeforeMs: Date.parse('2026-06-17T11:00:00.000Z'),
  })

  assert.equal(recovered.markedStale, 1)
  assert.equal(getTask(task.id)?.status, 'stale')
})
