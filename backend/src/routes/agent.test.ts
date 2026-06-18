import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-agent-route-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { default: agentRoute } = await import('./agent.js')
const { getTask } = await import('../services/tasks/store.js')

test('POST /:type/chat creates an agent.run task and returns immediately', async () => {
  const response = await agentRoute.request('/storyboard_breaker/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: '请拆解分镜',
      drama_id: 1,
      episode_id: 2,
    }),
  })

  assert.equal(response.status, 200)
  const json = await response.json()
  assert.equal(json.code, 200)
  assert.equal(json.data.status, 'queued')
  assert.equal(typeof json.data.task_id, 'number')

  const task = getTask(json.data.task_id)
  assert.equal(task?.type, 'agent.run')
  assert.equal(task?.dramaId, 1)
  assert.equal(task?.episodeId, 2)
  assert.equal(task?.scopeType, 'episode')
  assert.equal(task?.scopeId, 2)
  assert.equal(task?.payload.agent_type, 'storyboard_breaker')
  assert.equal(task?.payload.message, '请拆解分镜')
})

test('POST /:type/chat reuses active task for duplicate agent request', async () => {
  const body = JSON.stringify({
    message: '请拆解分镜',
    drama_id: 1,
    episode_id: 2,
  })

  const first = await agentRoute.request('/storyboard_breaker/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const second = await agentRoute.request('/storyboard_breaker/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  const firstJson = await first.json()
  const secondJson = await second.json()
  assert.equal(secondJson.data.task_id, firstJson.data.task_id)
})
