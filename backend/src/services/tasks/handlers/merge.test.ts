import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-merge-task-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../../db/index.js')
const { now } = await import('../../../utils/response.js')
const { createTask } = await import('../store.js')
const { createMergeEpisodeHandler } = await import('./merge-episode.js')
const { enqueueEpisodeMerge } = await import('../../ffmpeg-merge.js')

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

test('merge.episode handler validates and executes an existing merge record', async () => {
  const calls: any[] = []
  const handler = createMergeEpisodeHandler({
    executeEpisodeMerge: async (mergeId: number) => {
      calls.push({ mergeId })
      return { merge_id: mergeId, merged_url: 'static/merged/episode.mp4', duration: 42 }
    },
  })
  const task = createTask({
    type: 'merge.episode',
    payload: { merge_id: 9, episode_id: 2, drama_id: 1 },
  })
  const { ctx, progressCalls, events } = makeCtx(task)

  const result = await handler.run(ctx)

  assert.deepEqual(result, { merge_id: 9, merged_url: 'static/merged/episode.mp4', duration: 42 })
  assert.deepEqual(calls, [{ mergeId: 9 }])
  assert.equal(progressCalls.at(-1)?.message, 'Episode merge completed')
  assert.ok(events.some(event => event.type === 'merge.episode.completed'))
})

test('merge.episode handler fails before ffmpeg when storyboards are not composed', async () => {
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
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: 'Shot 1',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const mergeId = enqueueEpisodeMerge(episodeId, dramaId)
  const task = createTask({
    type: 'merge.episode',
    payload: { merge_id: mergeId, episode_id: episodeId, drama_id: dramaId },
  })
  const handler = createMergeEpisodeHandler()
  const { ctx } = makeCtx(task)

  await assert.rejects(
    () => handler.run(ctx),
    new RegExp(`missing composed_video_url.*${storyboardId}`),
  )

  const [merge] = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).all()
  assert.equal(merge.status, 'failed')
  assert.match(merge.errorMsg || '', new RegExp(String(storyboardId)))
})
