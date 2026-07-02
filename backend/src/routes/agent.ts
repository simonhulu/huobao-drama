import { Hono } from 'hono'
import { validAgentTypes } from '../agents/index.js'
import { success, badRequest } from '../utils/response.js'
import { createTask } from '../services/tasks/store.js'
import { logTaskError, logTaskPayload, logTaskStart } from '../utils/task-logger.js'

const app = new Hono()

app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `Invalid agent type: ${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, 'drama_id and episode_id are required')
  }

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  const task = createTask({
    type: 'agent.run',
    dramaId: Number(drama_id),
    episodeId: Number(episode_id),
    scopeType: 'episode',
    scopeId: Number(episode_id),
    idempotencyKey: `${agentType}:${drama_id}:${episode_id}:${message}`,
    payload: {
      agent_type: agentType,
      message,
      drama_id,
      episode_id,
    },
  })

  return success(c, {
    task_id: task.id,
    status: task.status,
  })
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, 'Invalid agent type')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
