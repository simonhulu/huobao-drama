import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-task-route-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { default: tasksRoute } = await import('./tasks.js')
const {
  claimQueuedTask,
  claimTaskCommitPoint,
  createTask,
  appendTaskEvent,
  getTask,
  listTaskEvents,
  transitionTask,
} = await import('../services/tasks/store.js')
const { taskEventBus } = await import('../services/tasks/events.js')

async function requestCancel(
  id: number | string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const requestHeaders = new Headers(headers)
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json')
  return tasksRoute.request(`/${id}/cancel`, {
    method: 'POST',
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function cancelEvents(taskId: number) {
  return listTaskEvents(taskId).filter(event => event.eventType === 'cancel.requested')
}

async function withTaskControlToken<T>(token: string | undefined, run: () => Promise<T>) {
  const previous = process.env.TASK_CONTROL_TOKEN
  if (token === undefined) delete process.env.TASK_CONTROL_TOKEN
  else process.env.TASK_CONTROL_TOKEN = token
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.TASK_CONTROL_TOKEN
    else process.env.TASK_CONTROL_TOKEN = previous
  }
}

test('normal active tasks retain no-body cancellation and record request audit metadata', async () => {
  const task = createTask({ type: 'video.generate', idempotencyKey: 'route-cancel-normal' })

  const response = await requestCancel(task.id, undefined, {
    origin: 'https://task-center.example',
    'user-agent': 'TaskCenter/1.0',
    'x-forwarded-for': '203.0.113.10, 198.51.100.2',
    'x-real-ip': '203.0.113.11',
  })

  assert.equal(response.status, 200)
  assert.equal(getTask(task.id)?.cancelRequested, true)
  assert.deepEqual(cancelEvents(task.id)[0]?.data, {
    reason: null,
    confirmation: { required: false, confirmed: false },
    declared_actor: null,
    source: 'https://task-center.example',
    user_agent: 'TaskCenter/1.0',
    forwarded_for: '203.0.113.10, 198.51.100.2',
    real_ip: '203.0.113.11',
  })
})

test('generic task creation refuses Dharma render payloads', async () => {
  const response = await tasksRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'dharma.episode_render',
      episode_id: 901_999,
      payload: { episode_id: 901_999 },
    }),
  })
  const payload = await response.json() as { message?: string }

  assert.equal(response.status, 400)
  assert.match(payload.message || '', /dharma\/episode/i)
})

test('Dharma pilots and scoped previews retain ordinary no-body cancellation without a control token', async () => {
  const tasks = [
    createTask({
      type: 'dharma.episode_render',
      episodeId: 901_000,
      payload: { episode_id: 901_000, max_duration_sec: 60 },
      idempotencyKey: 'route-cancel-dharma-pilot',
    }),
    createTask({
      type: 'dharma.episode_render',
      episodeId: 901_006,
      payload: { episode_id: 901_006, only_storyboard_ids: [71] },
      idempotencyKey: 'route-cancel-dharma-preview',
    }),
  ]

  await withTaskControlToken(undefined, async () => {
    for (const task of tasks) {
      const response = await requestCancel(task.id)
      assert.equal(response.status, 200)
      assert.equal(getTask(task.id)?.cancelRequested, true)
      assert.deepEqual(cancelEvents(task.id)[0]?.data?.confirmation, {
        required: false,
        confirmed: false,
      })
    }
  })
})

test('formal Dharma cancellation fails closed without a configured matching control token', async () => {
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId: 901_005,
    payload: { episode_id: 901_005 },
    idempotencyKey: 'route-cancel-dharma-control-token',
  })
  const body = {
    reason: 'Pause for a production review',
    confirmation: `CANCEL ${task.id}`,
    actor: 'task-center',
  }

  await withTaskControlToken(undefined, async () => {
    const response = await requestCancel(task.id, body)
    const payload = await response.json() as { message?: string }
    assert.equal(response.status, 403)
    assert.match(payload.message || '', /control token/i)
  })

  await withTaskControlToken('expected-control-token', async () => {
    const missing = await requestCancel(task.id, body)
    const wrong = await requestCancel(task.id, body, {
      'x-task-control-token': 'wrong-control-token',
    })
    assert.equal(missing.status, 403)
    assert.equal(wrong.status, 403)
    assert.equal(getTask(task.id)?.cancelRequested, false)
    assert.equal(cancelEvents(task.id).length, 0)

    const accepted = await requestCancel(task.id, body, {
      'x-task-control-token': 'expected-control-token',
    })
    const responseText = await accepted.text()
    assert.equal(accepted.status, 200)
    assert.equal(getTask(task.id)?.cancelRequested, true)
    assert.equal(JSON.stringify(cancelEvents(task.id)[0]?.data).includes('expected-control-token'), false)
    assert.equal(responseText.includes('expected-control-token'), false)
  })
})

test('running Dharma renders reject missing, oversized, or mismatched cancellation confirmation fields', async () => {
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId: 901_001,
    payload: { episode_id: 901_001 },
    idempotencyKey: 'route-cancel-dharma-validation',
  })
  transitionTask(task.id, 'running')

  const valid = {
    reason: 'Pause for visual review',
    confirmation: `CANCEL ${task.id}`,
    actor: 'task-center',
  }
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ ...valid, reason: '   ' }, /reason is required/i],
    [{ ...valid, reason: 'x'.repeat(501) }, /reason must not exceed 500/i],
    [{ ...valid, confirmation: `CANCEL ${task.id + 1}` }, /confirmation/i],
    [{ ...valid, actor: '   ' }, /actor is required/i],
    [{ ...valid, actor: 'x'.repeat(121) }, /actor must not exceed 120/i],
  ]

  await withTaskControlToken('validation-control-token', async () => {
    for (const [body, message] of cases) {
      const response = await requestCancel(task.id, body, {
        'x-task-control-token': 'validation-control-token',
      })
      const payload = await response.json() as { message?: string }
      assert.equal(response.status, 400)
      assert.match(payload.message || '', message)
      assert.equal(getTask(task.id)?.cancelRequested, false)
      assert.equal(cancelEvents(task.id).length, 0)
    }
  })
})

test('running Dharma render cancellation records sanitized audit data without storing confirmation text', async () => {
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId: 901_002,
    payload: { episode_id: 901_002 },
    idempotencyKey: 'route-cancel-dharma-audit',
  })
  transitionTask(task.id, 'running')

  await withTaskControlToken('audit-control-token', async () => {
    const response = await requestCancel(task.id, {
      reason: '  Pause for manual review  ',
      confirmation: `CANCEL ${task.id}`,
      actor: '  task-center  ',
    }, {
      origin: 'https://studio.example',
      'user-agent': 'TaskCenter/2.0',
      'x-forwarded-for': '203.0.113.20, 198.51.100.2',
      'x-real-ip': '203.0.113.21',
      'x-task-control-token': 'audit-control-token',
    })

    assert.equal(response.status, 200)
    assert.equal(getTask(task.id)?.cancelRequested, true)
    const event = cancelEvents(task.id)[0]
    assert.deepEqual(event?.data, {
      reason: 'Pause for manual review',
      confirmation: { required: true, confirmed: true },
      declared_actor: 'task-center',
      source: 'https://studio.example',
      user_agent: 'TaskCenter/2.0',
      forwarded_for: '203.0.113.20, 198.51.100.2',
      real_ip: '203.0.113.21',
    })
    assert.equal(JSON.stringify(event?.data).includes(`CANCEL ${task.id}`), false)
  })
})

test('cancellation validates identifiers, rejects inactive tasks, and makes duplicate active requests idempotent', async () => {
  const invalid = await requestCancel('not-a-task')
  assert.equal(invalid.status, 400)

  const unknown = await requestCancel(9_999_999)
  assert.equal(unknown.status, 404)

  const terminal = createTask({ type: 'video.generate', idempotencyKey: 'route-cancel-terminal' })
  transitionTask(terminal.id, 'succeeded')
  const terminalEventCount = listTaskEvents(terminal.id).length
  const terminalResponse = await requestCancel(terminal.id)
  assert.equal(terminalResponse.status, 409)
  assert.equal(getTask(terminal.id)?.cancelRequested, false)
  assert.equal(listTaskEvents(terminal.id).length, terminalEventCount)

  const active = createTask({ type: 'video.generate', idempotencyKey: 'route-cancel-idempotent' })
  const first = await requestCancel(active.id)
  const eventCount = cancelEvents(active.id).length
  const second = await requestCancel(active.id)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(cancelEvents(active.id).length, eventCount)
})

test('cancellation rejects a non-empty malformed JSON body instead of treating it as an empty body', async () => {
  const task = createTask({ type: 'video.generate', idempotencyKey: 'route-cancel-malformed-body' })
  const response = await tasksRoute.request(`/${task.id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  })

  const payload = await response.json() as { message?: string }
  assert.equal(response.status, 400)
  assert.match(payload.message || '', /valid JSON/i)
  assert.equal(getTask(task.id)?.cancelRequested, false)
})

test('cancellation returns conflict after a task has claimed its delivery commit point', async () => {
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId: 901_004,
    payload: { episode_id: 901_004 },
    idempotencyKey: 'route-cancel-after-commit',
  })
  const leased = claimQueuedTask(task.id, { workerId: 'route-commit-worker', leaseMs: 60_000 })
  assert.ok(leased?.leaseToken)
  assert.equal(claimTaskCommitPoint(task.id, {
    workerId: 'route-commit-worker',
    leaseToken: leased.leaseToken,
  }).outcome, 'claimed')

  await withTaskControlToken('commit-control-token', async () => {
    const response = await requestCancel(task.id, {
      reason: 'Too late to cancel',
      confirmation: `CANCEL ${task.id}`,
      actor: 'operator-1',
    }, {
      'x-task-control-token': 'commit-control-token',
    })

    assert.equal(response.status, 409)
    assert.equal(getTask(task.id)?.cancelRequested, false)
  })
})

test('public task events redact network cancellation audit fields', async () => {
  const task = createTask({ type: 'video.generate', idempotencyKey: 'route-cancel-public-redaction' })
  const cancel = await requestCancel(task.id, undefined, {
    origin: 'https://private-origin.example',
    'user-agent': 'PrivateAgent/1.0',
    'x-forwarded-for': '203.0.113.80',
    'x-real-ip': '203.0.113.81',
  })
  assert.equal(cancel.status, 200)

  const response = await tasksRoute.request(`/${task.id}/events`)
  const payload = await response.json() as { data?: Array<{ event_type?: string; data?: Record<string, unknown> }> }
  const event = payload.data?.find(item => item.event_type === 'cancel.requested')
  assert.ok(event)
  assert.equal(event?.data?.source, undefined)
  assert.equal(event?.data?.user_agent, undefined)
  assert.equal(event?.data?.forwarded_for, undefined)
  assert.equal(event?.data?.real_ip, undefined)
})

test('GET /:id/events returns only events after the supplied cursor', async () => {
  const task = createTask({ type: 'stream.cursor', idempotencyKey: 'route-events-after-id' })
  const [created] = listTaskEvents(task.id)
  assert.ok(created)
  const appended = appendTaskEvent(task.id, 'stream.cursor.appended', { step: 2 })

  const response = await tasksRoute.request(`/${task.id}/events?after_id=${created.id}`)
  const payload = await response.json() as { data?: Array<{ id?: number; event_type?: string }> }

  assert.equal(response.status, 200)
  assert.deepEqual(payload.data?.map(event => event.id), [appended.id])
  assert.deepEqual(payload.data?.map(event => event.event_type), ['stream.cursor.appended'])
})

test('GET /:id/events rejects an invalid event cursor', async () => {
  const task = createTask({ type: 'stream.cursor', idempotencyKey: 'route-events-invalid-after-id' })

  const response = await tasksRoute.request(`/${task.id}/events?after_id=not-a-number`)
  const payload = await response.json() as { message?: string }

  assert.equal(response.status, 400)
  assert.match(payload.message || '', /after_id/i)
})

test('GET /stream emits appended task events without exposing private cancellation audit fields', async () => {
  const task = createTask({ type: 'stream.event', idempotencyKey: 'route-stream-event-added' })
  const response = await tasksRoute.request('/stream')
  const reader = response.body?.getReader()
  assert.ok(reader)
  await reader.read()

  appendTaskEvent(task.id, 'cancel.requested', {
    reason: 'Review the pilot',
    source: 'https://private-origin.example',
    user_agent: 'PrivateAgent/1.0',
    forwarded_for: '203.0.113.80',
    real_ip: '203.0.113.81',
  })
  const next = await reader.read()
  const body = new TextDecoder().decode(next.value)

  assert.match(body, /^event: task-event/m)
  assert.match(body, /Review the pilot/)
  assert.doesNotMatch(body, /private-origin|PrivateAgent|203\.0\.113/)
  await reader.cancel()
})

test('GET /stream removes its listener when the reader is canceled', async () => {
  const task = createTask({ type: 'stream.cleanup', idempotencyKey: 'route-stream-cleanup' })
  const listenerCountBefore = taskEventBus.listenerCount('task')
  const response = await tasksRoute.request('/stream')

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/)

  const reader = response.body?.getReader()
  assert.ok(reader)
  const firstChunk = await reader.read()
  assert.equal(new TextDecoder().decode(firstChunk.value), 'event: connected\ndata: {}\n\n')
  await reader.cancel()

  let eventError: unknown = null
  try {
    transitionTask(task.id, 'running')
  } catch (error) {
    eventError = error
  }

  assert.equal(taskEventBus.listenerCount('task'), listenerCountBefore)
  assert.equal(eventError, null)
})

test('GET /stream removes its listener when the request is aborted', async () => {
  const task = createTask({ type: 'stream.abort', idempotencyKey: 'route-stream-abort' })
  const listenerCountBefore = taskEventBus.listenerCount('task')
  const abortController = new AbortController()
  const response = await tasksRoute.request(new Request('http://localhost/stream', {
    signal: abortController.signal,
  }))

  const reader = response.body?.getReader()
  assert.ok(reader)
  await reader.read()
  abortController.abort()

  let eventError: unknown = null
  try {
    transitionTask(task.id, 'running')
  } catch (error) {
    eventError = error
  }

  assert.equal(taskEventBus.listenerCount('task'), listenerCountBefore)
  assert.equal(eventError, null)
})
