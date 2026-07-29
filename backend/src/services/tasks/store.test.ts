import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-task-store-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const {
  acquireNextQueuedTask,
  addTaskDependency,
  appendTaskEvent,
  appendTaskEventWithLease,
  claimQueuedTask,
  claimTaskCommitPoint,
  createTask,
  extendTaskLease,
  getTask,
  listTaskEvents,
  listTasks,
  markTaskAttemptStarted,
  markTaskAttemptStartedWithLease,
  mutateClaimedTaskCommit,
  recordTaskLeaseLoss,
  requestCancel,
  scheduleTaskRetry,
  scheduleTaskRetryWithLease,
  transitionTask,
  transitionTaskWithExpiredLease,
  transitionTaskWithLease,
  updateTaskProgressWithLease,
} = await import('./store.js')
const { db, schema } = await import('../../db/index.js')
const { taskEventBus } = await import('./events.js')

function expireTaskLease(taskId: number) {
  db.update(schema.creationTasks)
    .set({ leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() })
    .where(eq(schema.creationTasks.id, taskId))
    .run()
}

function taskLeaseToken(taskId: number): string {
  const leaseToken = getTask(taskId)?.leaseToken
  if (!leaseToken) throw new Error(`Task ${taskId} is missing its lease token`)
  return leaseToken
}

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

test('a throwing task event listener cannot fail a committed task transition', () => {
  const task = createTask({
    type: 'test.event-listener-isolation',
    idempotencyKey: 'event-listener-isolation',
  })
  const received: string[] = []
  const diagnostics: unknown[][] = []
  const originalConsoleError = console.error
  const throwingListener = () => {
    throw new Error('disconnected SSE consumer')
  }
  const healthyListener = (event: { type: string }) => {
    received.push(event.type)
  }

  taskEventBus.on('task', throwingListener)
  taskEventBus.on('task', healthyListener)
  console.error = (...args) => { diagnostics.push(args) }
  try {
    const transitioned = transitionTask(task.id, 'succeeded')
    assert.equal(transitioned.status, 'succeeded')
    assert.equal(getTask(task.id)?.status, 'succeeded')
    assert.deepEqual(received, ['task.changed'])
    assert.equal(diagnostics.length, 1)
  } finally {
    console.error = originalConsoleError
    taskEventBus.off('task', throwingListener)
    taskEventBus.off('task', healthyListener)
  }
})

test('database permits only one active Dharma render per episode', () => {
  const first = createTask({
    type: 'dharma.episode_render',
    episodeId: 900_001,
    idempotencyKey: 'dharma.episode_render:900001',
  })
  assert.throws(() => {
    db.insert(schema.creationTasks).values({
      type: 'dharma.episode_render',
      status: 'queued',
      episodeId: 900_001,
      idempotencyKey: 'dharma.episode_render:900001:race',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()
  }, /UNIQUE constraint failed/)
  transitionTask(first.id, 'succeeded')
  const retry = createTask({
    type: 'dharma.episode_render',
    episodeId: 900_001,
    idempotencyKey: 'dharma.episode_render:900001:retry',
  })
  assert.notEqual(retry.id, first.id)
})

test('a queued task is conditionally leased once even when another worker claims the same candidate', () => {
  const task = createTask({
    type: 'test.atomic-lease',
    idempotencyKey: 'test-atomic-lease',
  })

  const first = claimQueuedTask(task.id, {
    workerId: 'worker-a',
    leaseMs: 1_000,
    nowMs: 1_000,
  })
  const second = claimQueuedTask(task.id, {
    workerId: 'worker-b',
    leaseMs: 1_000,
    nowMs: 1_000,
  })

  assert.equal(first?.id, task.id)
  assert.equal(first?.leaseOwner, 'worker-a')
  assert.equal(second, null)
  assert.equal(getTask(task.id)?.leaseOwner, 'worker-a')
  assert.equal(listTaskEvents(task.id).filter(event => event.eventType === 'leased').length, 1)
})

test('a cancel request and publish claim have a durable winner', () => {
  const claimedFirst = createTask({
    type: 'test.atomic-commit',
    idempotencyKey: 'test-atomic-commit-claimed-first',
  })
  claimQueuedTask(claimedFirst.id, { workerId: 'worker-a', leaseMs: 1_000 })

  const claim = claimTaskCommitPoint(claimedFirst.id, {
    workerId: 'worker-a',
    leaseToken: taskLeaseToken(claimedFirst.id),
  })
  assert.equal(claim.outcome, 'claimed')
  assert.equal(requestCancel(claimedFirst.id).outcome, 'commit_claimed')

  const canceledFirst = createTask({
    type: 'test.atomic-commit',
    idempotencyKey: 'test-atomic-commit-canceled-first',
  })
  claimQueuedTask(canceledFirst.id, { workerId: 'worker-b', leaseMs: 1_000 })
  assert.equal(requestCancel(canceledFirst.id).outcome, 'requested')
  assert.equal(claimTaskCommitPoint(canceledFirst.id, {
    workerId: 'worker-b',
    leaseToken: taskLeaseToken(canceledFirst.id),
  }).outcome, 'cancel_requested')
})

test('formal Dharma renders require cancellation confirmation before they are leased', () => {
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId: 900_007,
    idempotencyKey: 'dharma.cancel.queued-confirmation',
  })

  assert.equal(requestCancel(task.id).outcome, 'reason_required')
  assert.equal(requestCancel(task.id, {
    reason: 'Pause before the full render starts',
    confirmation: `CANCEL ${task.id}`,
    actor: 'task-center',
  }).outcome, 'requested')
})

test('Dharma pilots and scoped previews can be canceled without the formal-render confirmation', () => {
  const pilot = createTask({
    type: 'dharma.episode_render',
    episodeId: 900_008,
    idempotencyKey: 'dharma.cancel.pilot',
    payload: { max_duration_sec: 60 },
  })
  transitionTask(pilot.id, 'running')
  assert.equal(requestCancel(pilot.id).outcome, 'requested')
  assert.deepEqual(listTaskEvents(pilot.id).at(-1)?.data?.confirmation, {
    required: false,
    confirmed: false,
  })

  const preview = createTask({
    type: 'dharma.episode_render',
    episodeId: 900_009,
    idempotencyKey: 'dharma.cancel.preview',
    payload: { only_storyboard_ids: [1, 2] },
  })
  transitionTask(preview.id, 'running')
  assert.equal(requestCancel(preview.id).outcome, 'requested')
  assert.deepEqual(listTaskEvents(preview.id).at(-1)?.data?.confirmation, {
    required: false,
    confirmed: false,
  })
})

test('legacy camelCase preview controls fail closed as a formal Dharma render for cancellation', () => {
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId: 900_016,
    idempotencyKey: 'dharma.cancel.legacy-camelcase',
    payload: { episodeId: 900_016, maxDurationSec: 60 },
  })

  assert.equal(requestCancel(task.id).outcome, 'reason_required')
})

test('a Dharma commit claim freezes episode render inputs until the task becomes terminal', () => {
  const timestamp = new Date().toISOString()
  const episode = db.insert(schema.episodes).values({
    dramaId: 900_010,
    episodeNumber: 1,
    title: 'Frozen Dharma inputs',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run()
  const episodeId = Number(episode.lastInsertRowid)
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId,
    idempotencyKey: `dharma.commit.freeze.episode:${episodeId}`,
  })
  claimQueuedTask(task.id, { workerId: 'worker-freeze', leaseMs: 60_000 })
  assert.equal(claimTaskCommitPoint(task.id, {
    workerId: 'worker-freeze',
    leaseToken: taskLeaseToken(task.id),
  }).outcome, 'claimed')

  assert.throws(() => {
    db.update(schema.episodes)
      .set({ title: 'Changed after delivery claim', updatedAt: new Date().toISOString() })
      .where(eq(schema.episodes.id, episodeId))
      .run()
  }, /Dharma.*commit|commit.*Dharma/i)

  transitionTask(task.id, 'failed')
  assert.doesNotThrow(() => {
    db.update(schema.episodes)
      .set({ title: 'Changed after terminal task', updatedAt: new Date().toISOString() })
      .where(eq(schema.episodes.id, episodeId))
      .run()
  })
})

test('a Dharma commit claim freezes storyboard render inputs until the task becomes terminal', () => {
  const timestamp = new Date().toISOString()
  const episode = db.insert(schema.episodes).values({
    dramaId: 900_011,
    episodeNumber: 1,
    title: 'Frozen Dharma storyboard',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run()
  const episodeId = Number(episode.lastInsertRowid)
  const storyboard = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    narration: 'Before claim',
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run()
  const storyboardId = Number(storyboard.lastInsertRowid)
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId,
    idempotencyKey: `dharma.commit.freeze.storyboard:${episodeId}`,
  })
  claimQueuedTask(task.id, { workerId: 'worker-freeze', leaseMs: 60_000 })
  assert.equal(claimTaskCommitPoint(task.id, {
    workerId: 'worker-freeze',
    leaseToken: taskLeaseToken(task.id),
  }).outcome, 'claimed')

  assert.throws(() => {
    db.update(schema.storyboards)
      .set({ narration: 'Changed after delivery claim', updatedAt: new Date().toISOString() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
  }, /Dharma.*commit|commit.*Dharma/i)
})

test('a worker that lost a claimed Dharma delivery lease cannot replace the episode output pointer', () => {
  const timestamp = new Date().toISOString()
  const episode = db.insert(schema.episodes).values({
    dramaId: 900_012,
    episodeNumber: 1,
    title: 'Claimed Dharma delivery',
    videoUrl: 'static/remotion/previous-delivery.mp4',
    metadata: JSON.stringify({ dharmaRender: { output: 'static/remotion/previous-delivery.mp4' } }),
    createdAt: timestamp,
    updatedAt: timestamp,
  }).run()
  const episodeId = Number(episode.lastInsertRowid)
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId,
    idempotencyKey: `dharma.commit.pointer.lease:${episodeId}`,
  })
  claimQueuedTask(task.id, { workerId: 'worker-a', leaseMs: 60_000 })
  const token = taskLeaseToken(task.id)
  assert.equal(claimTaskCommitPoint(task.id, { workerId: 'worker-a', leaseToken: token }).outcome, 'claimed')

  const committed = mutateClaimedTaskCommit(task.id, 'worker-a', token, (tx) => {
    const update = tx.update(schema.episodes)
      .set({ videoUrl: 'static/remotion/dharma-ep900012-task-a.mp4', updatedAt: new Date().toISOString() })
      .where(eq(schema.episodes.id, episodeId))
      .run()
    assert.equal(update.changes, 1)
  })
  assert.equal(committed?.id, task.id)
  assert.equal(getTask(task.id)?.commitClaimedAt !== null, true)

  // Recovery has taken the task away from worker-a and a later delivery is now
  // the episode's visible output. The old process must not restore its pointer.
  transitionTask(task.id, 'stale')
  db.update(schema.episodes)
    .set({ videoUrl: 'static/remotion/dharma-ep900012-task-b.mp4', updatedAt: new Date().toISOString() })
    .where(eq(schema.episodes.id, episodeId))
    .run()
  const staleMutation = mutateClaimedTaskCommit(task.id, 'worker-a', token, (tx) => {
    tx.update(schema.episodes)
      .set({ videoUrl: 'static/remotion/dharma-ep900012-task-a.mp4', updatedAt: new Date().toISOString() })
      .where(eq(schema.episodes.id, episodeId))
      .run()
  })

  assert.equal(staleMutation, null)
  const [loadedEpisode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  assert.equal(loadedEpisode?.videoUrl, 'static/remotion/dharma-ep900012-task-b.mp4')
})

test('an expired worker lease cannot revive execution state or append telemetry', () => {
  const task = createTask({
    type: 'test.expired-worker-mutations',
    idempotencyKey: 'expired-worker-mutations',
  })
  assert.ok(claimQueuedTask(task.id, { workerId: 'worker-expired', leaseMs: 60_000 }))
  const token = taskLeaseToken(task.id)
  expireTaskLease(task.id)
  const eventCount = listTaskEvents(task.id).length

  assert.equal(extendTaskLease(task.id, 'worker-expired', token, 60_000), null)
  assert.equal(updateTaskProgressWithLease(task.id, 'worker-expired', token, {
    progressMessage: 'late progress',
    progressCurrent: 1,
  }), null)
  assert.equal(appendTaskEventWithLease(task.id, 'worker-expired', token, 'late.event'), null)
  assert.equal(markTaskAttemptStartedWithLease(task.id, 'worker-expired', token), null)
  assert.equal(scheduleTaskRetryWithLease(
    task.id,
    'worker-expired',
    token,
    new Error('late retry'),
    'late_retry',
  ), null)
  assert.equal(transitionTaskWithLease(task.id, 'worker-expired', token, 'succeeded', {
    result: { late: true },
  }), null)

  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'running')
  assert.equal(loaded?.leaseOwner, 'worker-expired')
  assert.equal(loaded?.result, null)
  assert.equal(listTaskEvents(task.id).length, eventCount)
})

test('a stale lease token cannot mutate a successor lease owned by the same worker id', () => {
  const task = createTask({
    type: 'test.lease-token-reuse',
    idempotencyKey: 'lease-token-reuse',
  })
  const firstLease = claimQueuedTask(task.id, { workerId: 'worker-reused', leaseMs: 60_000 })
  assert.ok(firstLease?.leaseToken)

  expireTaskLease(task.id)
  transitionTask(task.id, 'queued', { progressMessage: 'Recovered expired lease' })
  const successorLease = claimQueuedTask(task.id, { workerId: 'worker-reused', leaseMs: 60_000 })
  assert.ok(successorLease?.leaseToken)
  assert.notEqual(successorLease.leaseToken, firstLease.leaseToken)

  assert.equal(updateTaskProgressWithLease(task.id, 'worker-reused', firstLease.leaseToken, {
    progressMessage: 'stale progress',
  }), null)
  assert.equal(appendTaskEventWithLease(task.id, 'worker-reused', firstLease.leaseToken, 'stale.event'), null)
  assert.equal(transitionTaskWithLease(task.id, 'worker-reused', firstLease.leaseToken, 'succeeded'), null)
  assert.equal(claimTaskCommitPoint(task.id, {
    workerId: 'worker-reused',
    leaseToken: firstLease.leaseToken,
  }).outcome, 'lease_lost')

  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'running')
  assert.equal(loaded?.leaseOwner, 'worker-reused')
  assert.equal(loaded?.leaseToken, successorLease.leaseToken)
  assert.equal(loaded?.progressMessage, 'Recovered expired lease')
})

test('lease-loss diagnostics cannot stale a successor lease', () => {
  const task = createTask({
    type: 'test.lease-loss-successor',
    idempotencyKey: 'lease-loss-successor',
  })
  const firstLease = claimQueuedTask(task.id, { workerId: 'worker-a', leaseMs: 60_000 })
  assert.ok(firstLease?.leaseToken)

  expireTaskLease(task.id)
  transitionTask(task.id, 'queued', { progressMessage: 'Recovered by another worker' })
  const successorLease = claimQueuedTask(task.id, { workerId: 'worker-b', leaseMs: 60_000 })
  assert.ok(successorLease?.leaseToken)

  const recorded = recordTaskLeaseLoss({
    taskId: task.id,
    workerId: 'worker-a',
    leaseToken: firstLease.leaseToken,
    source: 'progress',
    nonResumable: true,
  })

  assert.equal(recorded?.status, 'running')
  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'running')
  assert.equal(loaded?.leaseOwner, 'worker-b')
  assert.equal(loaded?.leaseToken, successorLease.leaseToken)
  assert.equal(loaded?.errorCode, null)
  const diagnostic = listTaskEvents(task.id).at(-1)
  assert.equal(diagnostic?.eventType, 'task.lease_lost')
  assert.equal(diagnostic?.data.resolution, 'diagnostic_only')
  assert.equal(diagnostic?.data.observed.token_matches, false)
})

test('an expired worker lease cannot claim or publish a Dharma delivery', () => {
  const claimTask = createTask({
    type: 'test.expired-commit-claim',
    idempotencyKey: 'expired-commit-claim',
  })
  assert.ok(claimQueuedTask(claimTask.id, { workerId: 'worker-expired', leaseMs: 60_000 }))
  const claimToken = taskLeaseToken(claimTask.id)
  expireTaskLease(claimTask.id)
  assert.equal(claimTaskCommitPoint(claimTask.id, {
    workerId: 'worker-expired',
    leaseToken: claimToken,
  }).outcome, 'lease_lost')
  assert.equal(getTask(claimTask.id)?.commitClaimedAt, null)

  const publishTask = createTask({
    type: 'test.expired-publish',
    idempotencyKey: 'expired-publish',
  })
  assert.ok(claimQueuedTask(publishTask.id, { workerId: 'worker-publisher', leaseMs: 60_000 }))
  const publishToken = taskLeaseToken(publishTask.id)
  assert.equal(claimTaskCommitPoint(publishTask.id, {
    workerId: 'worker-publisher',
    leaseToken: publishToken,
  }).outcome, 'claimed')
  expireTaskLease(publishTask.id)
  let published = false
  assert.equal(mutateClaimedTaskCommit(publishTask.id, 'worker-publisher', publishToken, () => {
    published = true
  }), null)
  assert.equal(published, false)
})

test('recovery CAS cannot overwrite a successor lease even when the worker id is reused', () => {
  const task = createTask({
    type: 'test.recovery-lease-race',
    idempotencyKey: 'recovery-lease-race',
  })
  assert.ok(claimQueuedTask(task.id, { workerId: 'worker-a', leaseMs: 60_000 }))
  expireTaskLease(task.id)
  const observedExpiredTask = getTask(task.id)
  assert.ok(observedExpiredTask)

  transitionTask(task.id, 'queued', { progressMessage: 'Recovered by a newer worker' })
  const successorLease = claimQueuedTask(task.id, { workerId: 'worker-a', leaseMs: 60_000 })
  assert.ok(successorLease?.leaseToken)

  assert.equal(transitionTaskWithExpiredLease(observedExpiredTask, 'stale', {
    errorCode: 'should_not_win',
  }), null)
  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'running')
  assert.equal(loaded?.leaseOwner, 'worker-a')
  assert.equal(loaded?.leaseToken, successorLease.leaseToken)
  assert.equal(loaded?.errorCode, null)
})

test('recovery CAS cannot overwrite a commit claim made after its snapshot', () => {
  const task = createTask({
    type: 'test.recovery-commit-race',
    idempotencyKey: 'recovery-commit-race',
  })
  assert.ok(claimQueuedTask(task.id, { workerId: 'worker-a', leaseMs: 60_000 }))
  const observedTask = getTask(task.id)
  assert.ok(observedTask)
  assert.equal(claimTaskCommitPoint(task.id, {
    workerId: 'worker-a',
    leaseToken: taskLeaseToken(task.id),
  }).outcome, 'claimed')

  // A recovery loop may use an explicit cutoff. Even if the lease crossed
  // that cutoff, its earlier snapshot must not erase a later commit claim.
  assert.equal(transitionTaskWithExpiredLease(
    observedTask,
    'stale',
    { errorCode: 'should_not_overwrite_commit' },
    Date.now() + 120_000,
  ), null)
  assert.ok(getTask(task.id)?.commitClaimedAt)
  assert.equal(getTask(task.id)?.status, 'running')
})

test('recovery CAS cannot overwrite cancellation requested after its snapshot', () => {
  const task = createTask({
    type: 'test.recovery-cancel-race',
    idempotencyKey: 'recovery-cancel-race',
  })
  assert.ok(claimQueuedTask(task.id, { workerId: 'worker-a', leaseMs: 60_000 }))
  expireTaskLease(task.id)
  const observedTask = getTask(task.id)
  assert.ok(observedTask)

  assert.equal(requestCancel(task.id).outcome, 'requested')
  assert.equal(transitionTaskWithExpiredLease(observedTask, 'queued', {
    progressMessage: 'Recovered expired running task for retry.',
  }), null)

  const loaded = getTask(task.id)
  assert.equal(loaded?.status, 'running')
  assert.equal(loaded?.cancelRequested, true)
})

test('listTaskEvents applies cursor and limit in the store query', () => {
  const task = createTask({
    type: 'test.events.cursor',
    idempotencyKey: 'events-cursor',
  })
  appendTaskEvent(task.id, 'event.one')
  appendTaskEvent(task.id, 'event.two')
  appendTaskEvent(task.id, 'event.three')
  const events = listTaskEvents(task.id)

  const page = listTaskEvents(task.id, { afterId: events[1].id, limit: 2 })
  assert.deepEqual(page.map(event => event.eventType), ['event.two', 'event.three'])
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

test('listTasks activeOnly returns only queued and running tasks', () => {
  const queued = createTask({
    type: 'test.active.queued',
    idempotencyKey: 'active-queued',
  })
  const running = createTask({
    type: 'test.active.running',
    idempotencyKey: 'active-running',
  })
  transitionTask(running.id, 'running')
  const succeeded = createTask({
    type: 'test.active.succeeded',
    idempotencyKey: 'active-succeeded',
  })
  transitionTask(succeeded.id, 'succeeded')

  const activeIds = new Set(listTasks({ activeOnly: true }).map(task => task.id))
  assert.equal(activeIds.has(queued.id), true)
  assert.equal(activeIds.has(running.id), true)
  assert.equal(activeIds.has(succeeded.id), false)
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
