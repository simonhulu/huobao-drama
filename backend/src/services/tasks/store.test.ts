import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-task-store-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const {
  acquireNextQueuedTask,
  addTaskDependency,
  appendTaskEvent,
  createTask,
  getTask,
  listTaskEvents,
  listTasks,
  markTaskAttemptStarted,
  requestCancel,
  scheduleTaskRetry,
  transitionTask,
} = await import('./store.js')

test('createTask reuses an active task with the same type and idempotency key', () => {
  const first = createTask({
    type: 'agent.run',
    dramaId: 1,
    episodeId: 2,
    scopeType: 'episode',
    scopeId: 2,
    idempotencyKey: 'agent:storyboard_breaker:episode:2:abc',
    payload: { message: 'break down storyboards' },
  })

  const second = createTask({
    type: 'agent.run',
    dramaId: 1,
    episodeId: 2,
    scopeType: 'episode',
    scopeId: 2,
    idempotencyKey: 'agent:storyboard_breaker:episode:2:abc',
    payload: { message: 'duplicate click' },
  })

  assert.equal(second.id, first.id)
  assert.equal(second.payload.message, 'break down storyboards')
})

test('transitionTask and appendTaskEvent persist task state and event history', () => {
  const task = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 2,
    scopeType: 'storyboard',
    scopeId: 10,
    idempotencyKey: 'image:storyboard:10:first_frame',
    payload: { prompt: 'opening frame' },
  })

  transitionTask(task.id, 'running', {
    progressCurrent: 1,
    progressTotal: 3,
    progressMessage: 'building provider request',
  })
  appendTaskEvent(task.id, 'provider.request', { provider: 'minimax' })

  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'running')
  assert.equal(loaded?.progressCurrent, 1)
  assert.equal(loaded?.progressTotal, 3)
  assert.equal(loaded?.progressMessage, 'building provider request')

  const events = listTaskEvents(task.id)
  assert.equal(events.length, 3)
  assert.equal(events[0].eventType, 'created')
  assert.equal(events[1].eventType, 'status.changed')
  assert.equal(events[2].eventType, 'provider.request')
  assert.deepEqual(events[2].data, { provider: 'minimax' })
})

test('listTasks filters by episode and status, and requestCancel marks the task', () => {
  const task = createTask({
    type: 'video.generate',
    dramaId: 1,
    episodeId: 3,
    scopeType: 'storyboard',
    scopeId: 11,
    idempotencyKey: 'video:storyboard:11',
    payload: { prompt: 'motion' },
  })

  requestCancel(task.id)

  const listed = listTasks({ episodeId: 3, status: 'queued' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, task.id)
  assert.equal(listed[0].cancelRequested, true)
})

test('acquireNextQueuedTask orders by priority desc, scheduled_at asc, id asc', () => {
  const low = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 4,
    scopeType: 'storyboard',
    scopeId: 100,
    idempotencyKey: 'image:storyboard:100',
    priority: 1,
    payload: { prompt: 'low' },
  })
  const high = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 4,
    scopeType: 'character',
    scopeId: 101,
    idempotencyKey: 'image:character:101',
    priority: 10,
    payload: { prompt: 'high' },
  })
  const medium = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 4,
    scopeType: 'scene',
    scopeId: 102,
    idempotencyKey: 'image:scene:102',
    priority: 5,
    payload: { prompt: 'medium' },
  })

  const acquired = acquireNextQueuedTask({ workerId: 'worker-test', leaseMs: 1000 })
  assert.ok(acquired)
  assert.equal(acquired.id, high.id)

  transitionTask(acquired.id, 'succeeded')

  const next = acquireNextQueuedTask({ workerId: 'worker-test', leaseMs: 1000 })
  assert.ok(next)
  assert.equal(next.id, medium.id)

  transitionTask(next.id, 'succeeded')

  const last = acquireNextQueuedTask({ workerId: 'worker-test', leaseMs: 1000 })
  assert.ok(last)
  assert.equal(last.id, low.id)
})

test('scheduleTaskRetry delays task by scheduled_at and excludes it from immediate acquisition', () => {
  const task = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 5,
    scopeType: 'storyboard',
    scopeId: 200,
    idempotencyKey: 'image:storyboard:200',
    priority: 10,
    payload: { prompt: 'retry' },
  })

  transitionTask(task.id, 'running')
  markTaskAttemptStarted(task.id)
  const scheduledAt = new Date(Date.now() + 60_000).toISOString()
  scheduleTaskRetry(task.id, new Error('timeout'), 'provider_timeout', scheduledAt)

  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'queued')
  assert.equal(loaded?.retryReason, 'provider_timeout')
  assert.equal(loaded?.scheduledAt, scheduledAt)
  assert.equal(loaded?.attempts, 1)

  const acquired = acquireNextQueuedTask({ workerId: 'worker-test', leaseMs: 1000 })
  assert.ok(!acquired || acquired.id !== task.id, 'retried task should not be immediately acquirable due to scheduled_at')
})

test('acquireNextQueuedTask skips tasks whose dependencies are not yet succeeded', () => {
  const child = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 6,
    scopeType: 'storyboard',
    scopeId: 300,
    idempotencyKey: 'image:storyboard:300',
    priority: 10,
    payload: { prompt: 'child' },
  })
  const parent = createTask({
    type: 'image.episode',
    dramaId: 1,
    episodeId: 6,
    scopeType: 'episode',
    scopeId: 6,
    idempotencyKey: 'image:episode:6',
    priority: 10,
    payload: { episode_id: 6 },
  })
  addTaskDependency(parent.id, child.id)

  // parent has higher priority but is blocked by child
  const first = acquireNextQueuedTask({ workerId: 'worker-test', leaseMs: 1000 })
  assert.ok(first)
  assert.equal(first.id, child.id)

  transitionTask(first.id, 'succeeded')

  const second = acquireNextQueuedTask({ workerId: 'worker-test', leaseMs: 1000 })
  assert.ok(second)
  assert.equal(second.id, parent.id)
})

test('acquireNextQueuedTask marks dependent task failed when a dependency fails', () => {
  const dep = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 7,
    scopeType: 'storyboard',
    scopeId: 400,
    idempotencyKey: 'image:storyboard:400',
    priority: 1,
    payload: { prompt: 'dep' },
  })
  const dependent = createTask({
    type: 'compose.storyboard',
    dramaId: 1,
    episodeId: 7,
    scopeType: 'storyboard',
    scopeId: 401,
    idempotencyKey: 'compose:storyboard:401',
    priority: 10,
    payload: { storyboard_id: 401 },
  })
  addTaskDependency(dependent.id, dep.id)

  // pick and fail the dependency
  const acquired = acquireNextQueuedTask({ workerId: 'worker-test', leaseMs: 1000 })
  assert.ok(acquired)
  assert.equal(acquired.id, dep.id)
  transitionTask(dep.id, 'failed', { errorMessage: 'provider error' })

  // next acquisition attempt should mark dependent failed and not lease it
  const next = acquireNextQueuedTask({ workerId: 'worker-test', leaseMs: 1000 })
  assert.ok(!next || next.id !== dependent.id, 'dependent task should not be leased')

  const loaded = getTask(dependent.id)
  assert.equal(loaded?.status, 'failed')
  assert.match(loaded?.errorMessage || '', /provider error/)
})
