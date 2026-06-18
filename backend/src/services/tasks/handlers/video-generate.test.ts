import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-video-task-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { appendTaskEvent, createTask, listTaskEvents, updateTaskProgress } = await import('../store.js')
const { createVideoGenerateHandler } = await import('./video-generate.js')

test('video.generate handler executes an existing video generation record', async () => {
  const executed: any[] = []
  const handler = createVideoGenerateHandler({
    executeVideoGeneration: async (generationId: number, options: any) => {
      executed.push({ generationId, options })
      options.taskContext.event('video.provider_task', { generationId, providerTaskId: 'provider-video-1' })
      return { video_generation_id: generationId, local_path: 'static/videos/a.mp4' }
    },
  })
  const task = createTask({
    type: 'video.generate',
    payload: { video_generation_id: 9, config_id: 4 },
  })

  const result = await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
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

  assert.deepEqual(result, { video_generation_id: 9, local_path: 'static/videos/a.mp4' })
  assert.equal(executed[0].generationId, 9)
  assert.equal(executed[0].options.configId, 4)
  const events = listTaskEvents(task.id).map(event => event.eventType)
  assert.ok(events.includes('video.provider_task'))
})
