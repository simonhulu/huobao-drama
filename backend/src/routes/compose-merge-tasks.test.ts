import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-compose-merge-routes-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const {
  getTask,
  listTaskDependencies,
  listTasks,
} = await import('../services/tasks/store.js')
const { default: composeRoute } = await import('./compose.js')
const { default: mergeRoute } = await import('./merge.js')

function insertEpisode(renderMode: string = 'ai_video') {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    renderMode,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  return { dramaId, episodeId, ts }
}

function insertStoryboard(episodeId: number, storyboardNumber: number, fields: Record<string, any> = {}) {
  const ts = now()
  return Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber,
    title: `Shot ${storyboardNumber}`,
    createdAt: ts,
    updatedAt: ts,
    ...fields,
  }).run().lastInsertRowid)
}

test('POST /storyboards/:id/compose creates compose.storyboard task and preserves compose status compatibility', async () => {
  const { episodeId } = insertEpisode()
  const storyboardId = insertStoryboard(episodeId, 1, { videoUrl: 'static/videos/shot.mp4' })

  const response = await composeRoute.request(`/storyboards/${storyboardId}/compose`, {
    method: 'POST',
  })

  assert.equal(response.status, 200)
  const json = await response.json()
  assert.equal(typeof json.data.task_id, 'number')
  assert.equal(json.data.status, 'queued')
  assert.equal(getTask(json.data.task_id)?.type, 'compose.storyboard')
  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  assert.equal(storyboard.status, 'compose_processing')
})

test('POST /episodes/:id/compose-all creates parent and child compose tasks with dependencies', async () => {
  const { episodeId } = insertEpisode()
  insertStoryboard(episodeId, 1, { videoUrl: 'static/videos/a.mp4' })
  insertStoryboard(episodeId, 2, { videoUrl: 'static/videos/b.mp4' })

  const response = await composeRoute.request(`/episodes/${episodeId}/compose-all`, {
    method: 'POST',
  })

  assert.equal(response.status, 200)
  const json = await response.json()
  assert.equal(typeof json.data.task_id, 'number')
  assert.equal(json.data.total, 2)
  const parent = getTask(json.data.task_id)
  assert.equal(parent?.type, 'compose.episode')
  const childTasks = listTasks({ episodeId, type: 'compose.storyboard' })
  assert.equal(childTasks.length, 2)
  assert.deepEqual(
    listTaskDependencies(parent!.id).map(dep => dep.dependsOnTaskId).sort((a, b) => a - b),
    childTasks.map(task => task.id).sort((a, b) => a - b),
  )
})

test('GET /episodes/:id/compose-status derives progress from compose child tasks', async () => {
  const { episodeId } = insertEpisode()
  const storyboardA = insertStoryboard(episodeId, 1, { videoUrl: 'static/videos/a.mp4' })
  insertStoryboard(episodeId, 2, { videoUrl: 'static/videos/b.mp4' })

  const startResponse = await composeRoute.request(`/episodes/${episodeId}/compose-all`, {
    method: 'POST',
  })
  const started = await startResponse.json()
  const childId = started.data.child_task_ids[0]
  db.update(schema.creationTasks)
    .set({ status: 'succeeded', completedAt: now(), updatedAt: now() })
    .where(eq(schema.creationTasks.id, childId))
    .run()
  db.update(schema.storyboards)
    .set({ status: 'compose_completed', composedVideoUrl: 'static/composed/a.mp4', updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardA))
    .run()

  const statusResponse = await composeRoute.request(`/episodes/${episodeId}/compose-status`)
  const json = await statusResponse.json()

  assert.equal(json.data.task_id, started.data.task_id)
  assert.equal(json.data.total, 2)
  assert.equal(json.data.completed, 1)
  assert.equal(json.data.processing, 1)
  assert.equal(json.data.progress_current, 1)
  assert.equal(json.data.progress_total, 2)
})

test('POST /episodes/:id/merge creates merge.episode task and pending merge record', async () => {
  const { episodeId } = insertEpisode()
  insertStoryboard(episodeId, 1, { composedVideoUrl: 'static/composed/a.mp4', status: 'compose_completed' })

  const response = await mergeRoute.request(`/episodes/${episodeId}/merge`, {
    method: 'POST',
  })

  assert.equal(response.status, 200)
  const json = await response.json()
  assert.equal(typeof json.data.task_id, 'number')
  assert.equal(typeof json.data.merge_id, 'number')
  assert.equal(json.data.status, 'queued')
  const task = getTask(json.data.task_id)
  assert.equal(task?.type, 'merge.episode')
  const [merge] = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, json.data.merge_id)).all()
  assert.equal(merge.status, 'pending')
  assert.equal(merge.taskId, String(json.data.task_id))
})
