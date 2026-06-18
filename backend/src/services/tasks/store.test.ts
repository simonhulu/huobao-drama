import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-task-store-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const {
  appendTaskEvent,
  createTask,
  getTask,
  listTaskEvents,
  listTasks,
  requestCancel,
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
