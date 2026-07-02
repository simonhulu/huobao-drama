import { Hono } from 'hono'
import { badRequest, created, success } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { taskEventBus } from '../services/tasks/events.js'
import type { TaskChangedEvent } from '../services/tasks/events.js'
import {
  createTask,
  getTask,
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

app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.type) return badRequest(c, 'type is required')

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

  const tasks = listTasks({
    dramaId: dramaId ? Number(dramaId) : undefined,
    episodeId: episodeId ? Number(episodeId) : undefined,
    status,
    type,
  })

  const queuePositionMap = buildQueuePositionMap(tasks)
  return success(c, tasks.map(task => enrichTaskResponse(task, queuePositionMap)))
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
  return success(c, toSnakeCaseArray(listTaskEvents(id)))
})

app.get('/stream', (c) => {
  const dramaId = c.req.query('drama_id')
  const episodeId = c.req.query('episode_id')
  const dramaIdNum = dramaId ? Number(dramaId) : undefined
  const episodeIdNum = episodeId ? Number(episodeId) : undefined

  const encoder = new TextEncoder()
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'))

      const listener = (event: TaskChangedEvent) => {
        if (event.type !== 'task.changed') return
        const task = event.task
        if (dramaIdNum != null && task.dramaId !== dramaIdNum) return
        if (episodeIdNum != null && task.episodeId !== episodeIdNum) return

        const payload = JSON.stringify({
          task: toSnakeCase(task),
          reason: event.reason,
        })
        controller.enqueue(encoder.encode(`event: task\ndata: ${payload}\n\n`))
      }

      taskEventBus.on('task', listener)

      keepAliveTimer = setInterval(() => {
        controller.enqueue(encoder.encode(':keep-alive\n\n'))
      }, 15_000)

      c.req.raw.signal.addEventListener('abort', () => {
        if (keepAliveTimer) clearInterval(keepAliveTimer)
        taskEventBus.off('task', listener)
        try { controller.close() } catch {}
      })
    },
    cancel() {
      if (keepAliveTimer) clearInterval(keepAliveTimer)
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

app.post('/:id/cancel', (c) => {
  const id = Number(c.req.param('id'))
  const task = requestCancel(id)
  return success(c, toSnakeCase(task))
})

export default app
