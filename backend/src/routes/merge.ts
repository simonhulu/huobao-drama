import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { createTask } from '../services/tasks/store.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

app.post('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const videos = storyboards
    .map(sb => sb.composedVideoUrl)
    .filter(Boolean) as string[]

  if (videos.length === 0) return badRequest(c, 'No videos to merge')

  logTaskStart('MergeAPI', 'episode-merge', { episodeId, dramaId: ep.dramaId })

  const ts = new Date().toISOString()
  const mergeResult = db.insert(schema.videoMerges).values({
    episodeId,
    dramaId: ep.dramaId,
    title: `Episode ${episodeId} Merge`,
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'pending',
    scenes: JSON.stringify(videos),
    createdAt: ts,
  }).run()
  const mergeId = Number(mergeResult.lastInsertRowid)

  const task = createTask({
    type: 'merge.episode',
    dramaId: ep.dramaId,
    episodeId,
    idempotencyKey: `merge.episode:${episodeId}`,
    payload: {
      merge_id: mergeId,
      episode_id: episodeId,
      drama_id: ep.dramaId,
    },
  })

  db.update(schema.videoMerges)
    .set({ taskId: String(task.id) })
    .where(eq(schema.videoMerges.id, mergeId))
    .run()

  logTaskSuccess('MergeAPI', 'episode-merge', { episodeId, mergeId, taskId: task.id })
  return success(c, { task_id: task.id, merge_id: mergeId, status: 'queued' })
})

// GET /episodes/:id/merge — 查询拼接状态
app.get('/episodes/:id/merge', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .orderBy(desc(schema.videoMerges.id))
    .all()

  const latest = merges[0]
  if (!latest) return success(c, null)

  return success(c, toSnakeCase(latest))
})

export default app
