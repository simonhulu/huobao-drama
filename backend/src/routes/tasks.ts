import { Hono } from 'hono'
import type { Context } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import { badRequest, created, notFound, success } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { taskEventBus } from '../services/tasks/events.js'
import type { TaskStreamEvent } from '../services/tasks/events.js'
import {
  TASK_CANCEL_ACTOR_MAX_LENGTH,
  TASK_CANCEL_REASON_MAX_LENGTH,
  TASK_EVENT_LIST_MAX_LIMIT,
} from '../services/tasks/types.js'
import {
  createTask,
  getTask,
  isFormalDharmaRender,
  listTaskEvents,
  listTasks,
  requestCancel,
} from '../services/tasks/store.js'

const app = new Hono()

function enrichTaskResponse(task: any, queuePositionMap: Map<number, number>) {
  return {
    ...toSnakeCase(task),
    queue_position: queuePositionMap.get(task.id) ?? null,
  }
}

function buildQueuePositionMap(tasks: any[]) {
  const queued = tasks
    .filter(t => t.status === 'queued')
    .sort((a, b) => {
      const pa = a.priority ?? 0
      const pb = b.priority ?? 0
      if (pa !== pb) return pb - pa
      const sa = a.scheduledAt ?? ''
      const sb = b.scheduledAt ?? ''
      if (sa !== sb) return sa.localeCompare(sb)
      return a.id - b.id
    })
  const map = new Map<number, number>()
  queued.forEach((task, index) => map.set(task.id, index + 1))
  return map
}

function parseOptionalText(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  trim = true,
) {
  const raw = body[field]
  if (raw === undefined || raw === null) return { value: null as string | null }
  if (typeof raw !== 'string') return { value: null as string | null, error: `${field} must be a string` }
  const value = trim ? raw.trim() : raw
  if (value.length > maxLength) return { value: null as string | null, error: `${field} must not exceed ${maxLength} characters` }
  return { value: value || null as string | null }
}

function requestHeader(c: Context, name: string, maxLength: number) {
  const value = c.req.header(name)?.trim()
  return value ? value.slice(0, maxLength) : null
}

function hasValidTaskControlToken(c: Context) {
  const configured = process.env.TASK_CONTROL_TOKEN
  const supplied = c.req.header('x-task-control-token')
  if (!configured || !supplied) return false

  // Compare fixed-length digests so different token lengths do not bypass the
  // constant-time comparison required for this control-plane credential.
  const configuredDigest = createHash('sha256').update(configured).digest()
  const suppliedDigest = createHash('sha256').update(supplied).digest()
  return timingSafeEqual(configuredDigest, suppliedDigest)
}

function taskControlForbidden(c: Context) {
  return c.json({
    code: 403,
    message: 'Task control token is required to cancel a formal Dharma render',
  }, 403)
}

function cancellationBadRequest(c: Context, outcome: string, taskId: number) {
  if (outcome === 'reason_required') return badRequest(c, 'reason is required to cancel a running Dharma render')
  if (outcome === 'reason_too_long') return badRequest(c, `reason must not exceed ${TASK_CANCEL_REASON_MAX_LENGTH} characters`)
  if (outcome === 'confirmation_required') return badRequest(c, `confirmation must exactly equal CANCEL ${taskId}`)
  if (outcome === 'actor_required') return badRequest(c, 'actor is required to cancel a running Dharma render')
  if (outcome === 'actor_too_long') return badRequest(c, `actor must not exceed ${TASK_CANCEL_ACTOR_MAX_LENGTH} characters`)
  return badRequest(c, 'invalid cancellation request')
}

function redactTaskEventForPublicResponse(event: ReturnType<typeof listTaskEvents>[number]) {
  if (event.eventType !== 'cancel.requested' || !event.data || typeof event.data !== 'object') return event
  const { source, user_agent: userAgent, forwarded_for: forwardedFor, real_ip: realIp, ...safeData } = event.data as Record<string, unknown>
  void source
  void userAgent
  void forwardedFor
  void realIp
  return { ...event, data: safeData }
}

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(c, 'task body must be an object')
  if (typeof body.type !== 'string' || !body.type.trim()) return badRequest(c, 'type is required')
  if (body.type === 'dharma.episode_render') {
    return badRequest(c, 'Dharma renders must be created through /dharma/episode/:id/render')
  }

  const task = createTask({
    type: body.type,
    dramaId: body.drama_id,
    episodeId: body.episode_id,
    scopeType: body.scope_type,
    scopeId: body.scope_id,
    idempotencyKey: body.idempotency_key,
    parentTaskId: body.parent_task_id,
    payload: body.payload,
    maxAttempts: body.max_attempts,
    priority: body.priority,
    scheduledAt: body.scheduled_at,
    provider: body.provider,
  })

  return created(c, toSnakeCase(task))
})

app.get('/', (c) => {
  const dramaId = c.req.query('drama_id')
  const episodeId = c.req.query('episode_id')
  const status = c.req.query('status')
  const type = c.req.query('type')
  const activeOnly = c.req.query('active_only') === 'true'

  const tasks = listTasks({
    dramaId: dramaId ? Number(dramaId) : undefined,
    episodeId: episodeId ? Number(episodeId) : undefined,
    status,
    type,
    activeOnly,
  })

  const queuePositionMap = buildQueuePositionMap(tasks)
  return success(c, tasks.map(task => enrichTaskResponse(task, queuePositionMap)))
})

app.get('/stream', (c) => {
  const dramaId = c.req.query('drama_id')
  const episodeId = c.req.query('episode_id')
  const dramaIdNum = dramaId ? Number(dramaId) : undefined
  const episodeIdNum = episodeId ? Number(episodeId) : undefined

  const encoder = new TextEncoder()
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null
  let cleanupStream: (() => void) | null = null

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'))

      const listener = (event: TaskStreamEvent) => {
        if (event.type === 'task.event_added') {
          const task = getTask(event.taskId)
          if (!task) return
          if (dramaIdNum != null && task.dramaId !== dramaIdNum) return
          if (episodeIdNum != null && task.episodeId !== episodeIdNum) return
          const payload = JSON.stringify({
            task_id: event.taskId,
            event: toSnakeCase(redactTaskEventForPublicResponse(event.event)),
          })
          controller.enqueue(encoder.encode(`event: task-event\ndata: ${payload}\n\n`))
          return
        }

        const task = event.task
        if (dramaIdNum != null && task.dramaId !== dramaIdNum) return
        if (episodeIdNum != null && task.episodeId !== episodeIdNum) return

        const payload = JSON.stringify({
          task: toSnakeCase(task),
          reason: event.reason,
        })
        controller.enqueue(encoder.encode(`event: task\ndata: ${payload}\n\n`))
      }

      let cleaned = false
      const abortListener = () => cleanupStream?.()
      cleanupStream = () => {
        if (cleaned) return
        cleaned = true
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer)
          keepAliveTimer = null
        }
        taskEventBus.off('task', listener)
        c.req.raw.signal.removeEventListener('abort', abortListener)
        try { controller.close() } catch {}
      }

      taskEventBus.on('task', listener)

      keepAliveTimer = setInterval(() => {
        controller.enqueue(encoder.encode(':keep-alive\n\n'))
      }, 15_000)

      c.req.raw.signal.addEventListener('abort', abortListener, { once: true })
      if (c.req.raw.signal.aborted) cleanupStream()
    },
    cancel() {
      cleanupStream?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})

app.get('/:id', (c) => {
  const id = Number(c.req.param('id'))
  const task = getTask(id)
  if (!task) return success(c, null)
  const all = listTasks({
    dramaId: task.dramaId ?? undefined,
    episodeId: task.episodeId ?? undefined,
  })
  const queuePositionMap = buildQueuePositionMap(all)
  return success(c, enrichTaskResponse(task, queuePositionMap))
})

app.get('/:id/events', (c) => {
  const id = Number(c.req.param('id'))
  const rawAfterId = c.req.query('after_id')
  let afterId: number | null = null
  if (rawAfterId !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(rawAfterId)) return badRequest(c, 'after_id must be a non-negative integer')
    afterId = Number(rawAfterId)
    if (!Number.isSafeInteger(afterId)) return badRequest(c, 'after_id must be a non-negative integer')
  }

  const events = listTaskEvents(id, {
    afterId: afterId ?? undefined,
    // The task center advances a durable event cursor. A cap protects an
    // initial reconnect from loading an unbounded task timeline at once.
    limit: TASK_EVENT_LIST_MAX_LIMIT,
  })
    .map(redactTaskEventForPublicResponse)
  return success(c, toSnakeCaseArray(events))
})

app.post('/:id/cancel', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return badRequest(c, 'invalid task id')

  const targetTask = getTask(id)
  if (
    targetTask
    && ['queued', 'running'].includes(targetTask.status)
    && isFormalDharmaRender(targetTask)
    && !hasValidTaskControlToken(c)
  ) {
    return taskControlForbidden(c)
  }

  const rawBody = await c.req.text()
  let body: unknown = {}
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody)
    } catch {
      return badRequest(c, 'cancel body must be valid JSON')
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, 'cancel body must be an object')
  }
  const cancelBody = body as Record<string, unknown>
  const reason = parseOptionalText(cancelBody, 'reason', TASK_CANCEL_REASON_MAX_LENGTH)
  if (reason.error) return badRequest(c, reason.error)
  const actor = parseOptionalText(cancelBody, 'actor', TASK_CANCEL_ACTOR_MAX_LENGTH)
  if (actor.error) return badRequest(c, actor.error)
  const confirmation = parseOptionalText(cancelBody, 'confirmation', 128, false)
  if (confirmation.error) return badRequest(c, confirmation.error)

  const task = requestCancel(id, {
    reason: reason.value,
    confirmation: confirmation.value,
    actor: actor.value,
    source: requestHeader(c, 'origin', 512) ?? requestHeader(c, 'referer', 512),
    userAgent: requestHeader(c, 'user-agent', 512),
    forwardedFor: requestHeader(c, 'x-forwarded-for', 512),
    realIp: requestHeader(c, 'x-real-ip', 128),
  })

  if (task.outcome === 'not_found') return notFound(c, 'Task not found')
  if (task.outcome === 'not_active') return c.json({ code: 409, message: 'Task is not active' }, 409)
  if (task.outcome === 'commit_claimed') {
    return c.json({ code: 409, message: 'Task has crossed its delivery commit point and can no longer be canceled' }, 409)
  }
  if (task.outcome !== 'requested' && task.outcome !== 'already_requested') {
    return cancellationBadRequest(c, task.outcome, id)
  }
  if (!task.task) return c.json({ code: 500, message: 'Task cancellation failed' }, 500)
  return success(c, toSnakeCase(task.task))
})

export default app
