import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-image-task-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { appendTaskEvent, createTask, listTaskEvents, updateTaskProgress } = await import('../store.js')
const { createImageGenerateHandler } = await import('./image-generate.js')

test('image.generate handler executes an existing image generation record', async () => {
  const executed: any[] = []
  const handler = createImageGenerateHandler({
    executeImageGeneration: async (generationId: number, options: any) => {
      executed.push({ generationId, options })
      options.taskContext.event('image.provider_task', { generationId, providerTaskId: 'provider-image-1' })
      return { image_generation_id: generationId, local_path: 'static/images/a.png' }
    },
  })
  const task = createTask({
    type: 'image.generate',
    payload: { image_generation_id: 7, config_id: 3 },
  })

  const result = await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    attempts: 1,
    progress(message: string, current?: number, total?: number) {
      updateTaskProgress(task.id, { progressMessage: message, progressCurrent: current, progressTotal: total })
    },
    event(type: string, data?: unknown) {
      appendTaskEvent(task.id, type, data)
    },
    isCancelRequested() {
      return false
    },
  })

  assert.deepEqual(result, { image_generation_id: 7, local_path: 'static/images/a.png' })
  assert.equal(executed[0].generationId, 7)
  assert.equal(executed[0].options.configId, 3)
  const events = listTaskEvents(task.id).map(event => event.eventType)
  assert.ok(events.includes('image.provider_task'))
})

test('image.generate handler repairs storyboard prompt once after content policy failure and retries same generation', async () => {
  const calls: number[] = []
  const repaired: any[] = []
  const handler = createImageGenerateHandler({
    executeImageGeneration: async (generationId: number) => {
      calls.push(generationId)
      if (calls.length === 1) throw new Error('Your request was rejected by the safety system.')
      return { image_generation_id: generationId, local_path: 'static/images/repaired.png' }
    },
    repairStoryboardImagePromptForGeneration: async (generationId: number, errorMessage: string) => {
      repaired.push({ generationId, errorMessage })
      return { repairedPrompt: '安全的完整镜头图片 prompt', model: 'deepseek-v4-flash' }
    },
  })
  const task = createTask({
    type: 'image.generate',
    payload: { image_generation_id: 9, config_id: 3 },
  })

  const result = await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    attempts: 1,
    progress(message: string, current?: number, total?: number) {
      updateTaskProgress(task.id, { progressMessage: message, progressCurrent: current, progressTotal: total })
    },
    event(type: string, data?: unknown) {
      appendTaskEvent(task.id, type, data)
    },
    isCancelRequested() {
      return false
    },
  })

  assert.deepEqual(calls, [9, 9])
  assert.equal(repaired.length, 1)
  assert.match(repaired[0].errorMessage, /safety system/)
  assert.deepEqual(result, { image_generation_id: 9, local_path: 'static/images/repaired.png' })
  const events = listTaskEvents(task.id)
  assert.ok(events.some(event => event.eventType === 'image.prompt_repaired'))
})

test('image.generate handler does not repair content policy failure twice for the same task', async () => {
  let repaired = 0
  const handler = createImageGenerateHandler({
    executeImageGeneration: async () => {
      throw new Error('Your request was rejected by the safety system.')
    },
    repairStoryboardImagePromptForGeneration: async () => {
      repaired += 1
      return { repairedPrompt: '安全的完整镜头图片 prompt', model: 'deepseek-v4-flash' }
    },
  })
  const task = createTask({
    type: 'image.generate',
    payload: { image_generation_id: 10 },
  })
  appendTaskEvent(task.id, 'image.prompt_repaired', { generationId: 10 })

  await assert.rejects(
    () => handler.run({
      taskId: task.id,
      payload: task.payload,
      signal: new AbortController().signal,
      attempts: 1,
      progress(message: string, current?: number, total?: number) {
        updateTaskProgress(task.id, { progressMessage: message, progressCurrent: current, progressTotal: total })
      },
      event(type: string, data?: unknown) {
        appendTaskEvent(task.id, type, data)
      },
      isCancelRequested() {
        return false
      },
    }),
    /safety system/,
  )

  assert.equal(repaired, 0)
})
