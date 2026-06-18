import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-compose-task-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../../db/index.js')
const { now } = await import('../../../utils/response.js')
const {
  addTaskDependency,
  createTask,
  getTask,
  listTaskDependencies,
} = await import('../store.js')
const {
  createComposeStoryboardHandler,
} = await import('./compose-storyboard.js')
const {
  createComposeEpisodeHandler,
} = await import('./compose-episode.js')

function makeCtx(task: any) {
  const progressCalls: any[] = []
  const events: any[] = []
  return {
    ctx: {
      taskId: task.id,
      payload: task.payload,
      signal: new AbortController().signal,
      progress(message: string, current?: number, total?: number) {
        progressCalls.push({ message, current, total })
      },
      event(type: string, data?: unknown) {
        events.push({ type, data })
      },
      isCancelRequested() {
        return false
      },
    },
    progressCalls,
    events,
  }
}

test('compose.storyboard handler delegates to composeStoryboard and returns composed url', async () => {
  const calls: any[] = []
  const handler = createComposeStoryboardHandler({
    composeStoryboard: async (storyboardId: number, options: any) => {
      calls.push({ storyboardId, options })
      return 'static/composed/shot-1.mp4'
    },
  })
  const task = createTask({
    type: 'compose.storyboard',
    payload: { storyboard_id: 7, force: true },
  })
  const { ctx, progressCalls, events } = makeCtx(task)

  const result = await handler.run(ctx)

  assert.deepEqual(result, { storyboard_id: 7, composed_video_url: 'static/composed/shot-1.mp4' })
  assert.deepEqual(calls, [{ storyboardId: 7, options: { force: true } }])
  assert.equal(progressCalls.at(-1)?.message, 'Storyboard compose completed')
  assert.ok(events.some(event => event.type === 'compose.storyboard.completed'))
})

test('compose.episode handler reports child dependency progress without waiting for children', async () => {
  const ts = now()
  const parent = createTask({
    type: 'compose.episode',
    episodeId: 2,
    payload: { episode_id: 2 },
  })
  const childA = createTask({
    type: 'compose.storyboard',
    episodeId: 2,
    parentTaskId: parent.id,
    payload: { storyboard_id: 11 },
  })
  const childB = createTask({
    type: 'compose.storyboard',
    episodeId: 2,
    parentTaskId: parent.id,
    payload: { storyboard_id: 12 },
  })
  addTaskDependency(parent.id, childA.id)
  addTaskDependency(parent.id, childB.id)
  db.update(schema.creationTasks)
    .set({ status: 'succeeded', completedAt: ts, updatedAt: ts })
    .where(eq(schema.creationTasks.id, childA.id))
    .run()

  const handler = createComposeEpisodeHandler()
  const { ctx, progressCalls } = makeCtx(parent)
  const result = await handler.run(ctx)

  assert.deepEqual(result, {
    episode_id: 2,
    child_task_ids: [childA.id, childB.id],
    completed: 1,
    total: 2,
  })
  assert.equal(progressCalls.at(-1)?.current, 1)
  assert.equal(progressCalls.at(-1)?.total, 2)
  assert.deepEqual(listTaskDependencies(parent.id).map(dep => dep.dependsOnTaskId), [childA.id, childB.id])
  assert.equal(getTask(parent.id)?.type, 'compose.episode')
})
