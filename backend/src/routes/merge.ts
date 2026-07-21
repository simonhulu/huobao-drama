import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound } from '../utils/response.js'
import { createTask } from '../services/tasks/store.js'
import { toSnakeCase } from '../utils/transform.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Readable } from 'stream'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// merge.ts is at backend/src/routes/ or backend/dist/routes/; go up 3 levels to project root.
const projectRoot = path.resolve(__dirname, '../../..')

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(projectRoot, 'data', relativePath)
  return path.join(projectRoot, 'data', 'static', relativePath)
}

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

// GET /episodes/:id/download-video — 直接下载成片，带 attachment header，不经过前端 proxy
app.get('/episodes/:id/download-video', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const merges = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .orderBy(desc(schema.videoMerges.id))
    .all()
  const latest = merges.find(m => m.status === 'completed' && m.mergedUrl)
  if (!latest?.mergedUrl) return notFound(c, 'Episode video not ready')

  const filePath = toAbsPath(latest.mergedUrl)
  if (!fs.existsSync(filePath)) return notFound(c, 'Episode video file not found')

  const stat = fs.statSync(filePath)
  const range = c.req.header('range')

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
    if (Number.isNaN(start) || Number.isNaN(end) || start >= stat.size || end >= stat.size || start > end) {
      return c.newResponse('Range Not Satisfiable', 416, {
        'Content-Range': `bytes */${stat.size}`,
      })
    }
    const chunkSize = end - start + 1
    const stream = fs.createReadStream(filePath, { start, end })
    return c.newResponse(Readable.toWeb(stream) as ReadableStream, 206, {
      'Content-Disposition': `attachment; filename="episode-${episodeId}.mp4"`,
      'Content-Type': 'video/mp4',
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
    })
  }

  const stream = fs.createReadStream(filePath)
  return c.newResponse(Readable.toWeb(stream) as ReadableStream, 200, {
    'Content-Disposition': `attachment; filename="episode-${episodeId}.mp4"`,
    'Content-Type': 'video/mp4',
    'Content-Length': String(stat.size),
    'Accept-Ranges': 'bytes',
  })
})

export default app
