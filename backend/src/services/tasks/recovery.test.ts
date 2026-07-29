import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-task-recovery-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { acquireNextQueuedTask, claimTaskCommitPoint, createTask, getTask, transitionTask } = await import('./store.js')
const { clearTaskHandlers, registerTaskHandler } = await import('./registry.js')
const { recoverExpiredRunningTasks } = await import('./recovery.js')
const { db, schema } = await import('../../db/index.js')

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

test('recoverExpiredRunningTasks never retries an expired task that already claimed its commit point', () => {
  clearTaskHandlers()
  registerTaskHandler('test.commit_claimed_resumable', {
    resumable: true,
    maxAttempts: 3,
    run: async () => undefined,
  })
  const recoveryNow = Date.parse('2026-06-17T12:00:02.000Z')
  const task = createTask({
    type: 'test.commit_claimed_resumable',
    idempotencyKey: 'recovery-commit-claimed',
  })
  const leased = acquireNextQueuedTask({
    workerId: 'worker-commit',
    leaseMs: 60_000,
    types: ['test.commit_claimed_resumable'],
  })
  assert.equal(leased?.id, task.id)
  assert.ok(leased?.leaseToken)
  assert.equal(claimTaskCommitPoint(task.id, {
    workerId: 'worker-commit',
    leaseToken: leased.leaseToken,
  }).outcome, 'claimed')
  db.update(schema.creationTasks)
    .set({ leaseExpiresAt: new Date(recoveryNow - 1_000).toISOString() })
    .where(eq(schema.creationTasks.id, task.id))
    .run()

  const recovered = recoverExpiredRunningTasks({
    nowMs: recoveryNow,
    expiredBeforeMs: recoveryNow,
  })

  assert.equal(recovered.requeued, 0)
  assert.equal(recovered.markedStale, 1)
  const after = getTask(task.id)
  assert.equal(after?.status, 'stale')
  assert.equal(after?.errorCode, 'task_commit_claimed_reconciliation_required')
  assert.ok(after?.commitClaimedAt)
})

test('recoverExpiredRunningTasks treats malformed lease timestamps as expired', () => {
  clearTaskHandlers()
  registerTaskHandler('test.malformed_lease', {
    resumable: false,
    maxAttempts: 1,
    run: async () => undefined,
  })
  const task = createTask({
    type: 'test.malformed_lease',
    idempotencyKey: 'recovery-malformed-lease',
  })
  transitionTask(task.id, 'running')
  db.update(schema.creationTasks)
    .set({ leaseExpiresAt: 'not-a-timestamp' })
    .where(eq(schema.creationTasks.id, task.id))
    .run()

  const recovered = recoverExpiredRunningTasks({
    nowMs: Date.parse('2026-06-17T12:00:00.000Z'),
    expiredBeforeMs: Date.parse('2026-06-17T12:00:00.000Z'),
  })

  assert.equal(recovered.markedStale, 1)
  assert.equal(getTask(task.id)?.status, 'stale')
})

test('recoverExpiredRunningTasks does not exceed the resumable task attempt limit', () => {
  clearTaskHandlers()
  registerTaskHandler('test.attempt_limited', {
    resumable: true,
    maxAttempts: 2,
    run: async () => undefined,
  })
  const task = createTask({
    type: 'test.attempt_limited',
    idempotencyKey: 'recovery-attempt-limited',
    maxAttempts: 2,
  })
  transitionTask(task.id, 'running')
  db.update(schema.creationTasks)
    .set({
      attempts: 2,
      leaseExpiresAt: 'not-a-timestamp',
    })
    .where(eq(schema.creationTasks.id, task.id))
    .run()

  const recovered = recoverExpiredRunningTasks({
    nowMs: Date.parse('2026-06-17T12:00:00.000Z'),
    expiredBeforeMs: Date.parse('2026-06-17T12:00:00.000Z'),
  })

  assert.equal(recovered.requeued, 0)
  assert.equal(recovered.markedStale, 1)
  assert.equal(getTask(task.id)?.status, 'stale')
  assert.equal(getTask(task.id)?.errorCode, 'task_retry_limit_exceeded')
})
