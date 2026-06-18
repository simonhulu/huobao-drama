import { Hono } from 'hono'
import { badRequest, created, success } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import {
  createTask,
  getTask,
  listTaskEvents,
  listTasks,
  requestCancel,
} from '../services/tasks/store.js'

const app = new Hono()

function taskToResponse(task: any) {
  return toSnakeCase(task)
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
  })

  return created(c, taskToResponse(task))
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

  return success(c, toSnakeCaseArray(tasks))
})

app.get('/:id', (c) => {
  const id = Number(c.req.param('id'))
  const task = getTask(id)
  return success(c, task ? taskToResponse(task) : null)
})

app.get('/:id/events', (c) => {
  const id = Number(c.req.param('id'))
  return success(c, toSnakeCaseArray(listTaskEvents(id)))
})

app.post('/:id/cancel', (c) => {
  const id = Number(c.req.param('id'))
  const task = requestCancel(id)
  return success(c, taskToResponse(task))
})

export default app
