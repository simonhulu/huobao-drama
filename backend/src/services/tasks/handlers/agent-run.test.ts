import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-agent-run-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { appendTaskEvent, createTask, getTask, listTaskEvents, transitionTask, updateTaskProgress } = await import('../store.js')
const { clearTaskHandlers } = await import('../registry.js')
const { recoverExpiredRunningTasks } = await import('../recovery.js')
const { createAgentRunHandler, registerAgentRunHandler } = await import('./agent-run.js')

test('agent.run handler executes agent and records normalized tool events', async () => {
  const handler = createAgentRunHandler({
    createAgent: (type: string, episodeId: number, dramaId: number) => ({
      generate: async (messages: any[], options: any) => {
        assert.equal(type, 'storyboard_breaker')
        assert.equal(episodeId, 2)
        assert.equal(dramaId, 1)
        assert.deepEqual(messages, [{ role: 'user', content: '拆解分镜' }])
        assert.equal(options.maxSteps, 20)
        return {
          text: '已完成',
          toolCalls: [
            { toolName: 'save_storyboards', args: { count: 2 } },
          ],
          toolResults: [
            { toolName: 'save_storyboards', result: { saved: 2 } },
          ],
        }
      },
    }),
  })

  const task = createTask({
    type: 'agent.run',
    dramaId: 1,
    episodeId: 2,
    payload: {
      agent_type: 'storyboard_breaker',
      message: '拆解分镜',
      drama_id: 1,
      episode_id: 2,
    },
  })

  const result = await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    progress(message: string, current?: number, total?: number) {
      updateTaskProgress(task.id, {
        progressMessage: message,
        progressCurrent: current,
        progressTotal: total,
      })
    },
    event(type: string, data?: unknown) {
      appendTaskEvent(task.id, type, data)
    },
    isCancelRequested() {
      return false
    },
  })

  assert.equal(result.type, 'done')
  assert.equal(result.text, '已完成')
  assert.deepEqual(result.toolCalls, [
    { toolName: 'save_storyboards', args: { count: 2 } },
  ])
  assert.deepEqual(result.toolResults, [
    { toolName: 'save_storyboards', result: JSON.stringify({ saved: 2 }) },
  ])

  const events = listTaskEvents(task.id)
  assert.ok(events.some(event => event.eventType === 'agent.tool_call' && event.data.toolName === 'save_storyboards'))
  assert.ok(events.some(event => event.eventType === 'agent.tool_result' && event.data.toolName === 'save_storyboards'))
})

test('agent.run handler is non-resumable because agent tool side effects are not idempotent', () => {
  const handler = createAgentRunHandler({
    createAgent: () => null,
  })

  assert.equal(handler.resumable, false)
  assert.equal(handler.maxAttempts, 1)
})

test('expired running agent.run task is marked stale on recovery', () => {
  clearTaskHandlers()
  registerAgentRunHandler()
  const task = createTask({
    type: 'agent.run',
    dramaId: 1,
    episodeId: 2,
    payload: {
      agent_type: 'storyboard_breaker',
      message: '拆解分镜',
      drama_id: 1,
      episode_id: 2,
    },
  })
  transitionTask(task.id, 'running')

  const recovered = recoverExpiredRunningTasks({
    nowMs: Date.parse('2026-06-17T12:00:00.000Z'),
    expiredBeforeMs: Date.parse('2026-06-17T12:00:00.000Z'),
  })

  assert.equal(recovered.markedStale, 1)
  assert.equal(getTask(task.id)?.status, 'stale')
  assert.equal(getTask(task.id)?.errorCode, 'task_not_resumable')
})
