import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, now } from '../utils/response.js'
import { createTask, addTaskDependency } from '../services/tasks/store.js'
import { ensureNarratorTaskForEpisode } from '../services/tasks/auto-pipeline.js'
import { getEpisodeVisualStyle } from '../services/episode-mode.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { toSnakeCase } from '../utils/transform.js'

const app = new Hono()

function hasComposeMedia(sb: typeof schema.storyboards.$inferSelect, visualStyle: 'image_story' | 'ai_video'): boolean {
  if (visualStyle === 'ai_video') return !!sb.videoUrl
  return !!sb.firstFrameImage
}

app.post('/storyboards/:id/compose', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const force = Boolean(body?.force)
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!sb) return badRequest(c, 'Storyboard not found')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  const visualStyle = getEpisodeVisualStyle(sb.episodeId)
  if (!hasComposeMedia(sb, visualStyle)) {
    return badRequest(c, visualStyle === 'ai_video'
      ? 'Storyboard has no AI video for ai_video mode'
      : 'Storyboard has no first frame image for image_story mode')
  }

  const narratorTask = ensureNarratorTaskForEpisode(ep.dramaId, sb.episodeId)

  db.update(schema.storyboards)
    .set({ status: 'compose_processing', composedVideoUrl: null, updatedAt: now() })
    .where(eq(schema.storyboards.id, id))
    .run()

  logTaskStart('ComposeAPI', 'single-compose', { storyboardId: id, visualStyle })

  const task = createTask({
    type: 'compose.storyboard',
    dramaId: ep.dramaId,
    episodeId: sb.episodeId,
    scopeType: 'storyboard',
    scopeId: id,
    idempotencyKey: `compose.storyboard:${id}`,
    payload: {
      storyboard_id: id,
      force,
    },
  })

  if (narratorTask) {
    addTaskDependency(task.id, narratorTask.id)
  }

  logTaskSuccess('ComposeAPI', 'single-compose', { storyboardId: id, taskId: task.id, visualStyle })
  return success(c, { task_id: task.id, status: 'queued' })
})

app.post('/episodes/:id/compose-all', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const force = Boolean(body?.force)
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  const visualStyle = getEpisodeVisualStyle(episodeId)
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  if (storyboards.length === 0) return badRequest(c, 'No storyboards found')

  const withMedia = storyboards.filter(sb => hasComposeMedia(sb, visualStyle))
  if (withMedia.length === 0) {
    return badRequest(c, visualStyle === 'ai_video'
      ? 'No storyboards have AI video yet'
      : 'No storyboards have first frame image yet')
  }

  // 如果还有分镜没旁白，先确保 narrator 任务存在；合成任务会依赖它，避免产出无旁白镜头
  const narratorTask = ensureNarratorTaskForEpisode(ep.dramaId, episodeId)

  db.update(schema.storyboards)
    .set({ status: 'compose_processing', composedVideoUrl: null, updatedAt: now() })
    .where(eq(schema.storyboards.episodeId, episodeId))
    .run()

  const childTasks = withMedia.map(sb =>
    createTask({
      type: 'compose.storyboard',
      dramaId: ep.dramaId,
      episodeId,
      scopeType: 'storyboard',
      scopeId: sb.id,
      idempotencyKey: `compose.storyboard:${sb.id}`,
      payload: {
        storyboard_id: sb.id,
        force,
      },
    })
  )

  const parentTask = createTask({
    type: 'compose.episode',
    dramaId: ep.dramaId,
    episodeId,
    idempotencyKey: `compose.episode:${episodeId}`,
    payload: {
      episode_id: episodeId,
    },
  })

  for (const child of childTasks) {
    addTaskDependency(parentTask.id, child.id)
  }

  if (narratorTask) {
    for (const child of childTasks) {
      addTaskDependency(child.id, narratorTask.id)
    }
  }

  logTaskSuccess('ComposeAPI', 'batch-compose', {
    episodeId,
    visualStyle,
    total: withMedia.length,
    parentTaskId: parentTask.id,
    childTaskIds: childTasks.map(t => t.id),
    narrator_task_id: narratorTask?.id,
  })

  return success(c, {
    task_id: parentTask.id,
    total: withMedia.length,
    child_task_ids: childTasks.map(t => t.id),
    status: 'queued',
  })
})

app.get('/episodes/:id/compose-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const visualStyle = getEpisodeVisualStyle(episodeId)
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const withMedia = storyboards.filter(sb => hasComposeMedia(sb, visualStyle))
  const completed = withMedia.filter(sb => sb.status === 'compose_completed' && !!sb.composedVideoUrl)
  const failed = withMedia.filter(sb => sb.status === 'compose_failed')
  const processing = withMedia.filter(sb => sb.status === 'compose_processing')

  const parentTask = db.select().from(schema.creationTasks)
    .where(and(
      eq(schema.creationTasks.type, 'compose.episode'),
      eq(schema.creationTasks.episodeId, episodeId),
    ))
    .orderBy(desc(schema.creationTasks.id))
    .all()[0]

  return success(c, {
    task_id: parentTask?.id || null,
    render_mode: visualStyle,
    total: withMedia.length,
    completed: completed.length,
    failed: failed.length,
    processing: processing.length,
    progress_current: completed.length,
    progress_total: withMedia.length,
    items: withMedia.map((sb) => toSnakeCase({
      id: sb.id,
      storyboardNumber: sb.storyboardNumber,
      status: sb.status || 'pending',
      composedVideoUrl: sb.composedVideoUrl,
      errorMsg: sb.status === 'compose_failed' ? '视频合成失败，请检查视频、配音或字幕素材' : '',
    })),
  })
})

// POST /episodes/:id/subtitles - 为本集所有镜头生成字幕文件
app.post('/episodes/:id/subtitles', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  const { generateSubtitlesForEpisode } = await import('../services/subtitle.js')
  const results = await generateSubtitlesForEpisode(episodeId)
  return success(c, {
    episode_id: episodeId,
    generated: results.filter(r => r.subtitleUrl).length,
    total: results.length,
    items: results.map(r => ({ storyboard_id: r.storyboardId, subtitle_url: r.subtitleUrl })),
  })
})

// POST /storyboards/:id/subtitle-preview - 生成带字幕的 3 秒预览
app.post('/storyboards/:id/subtitle-preview', async (c) => {
  const storyboardId = Number(c.req.param('id'))
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) return notFound(c, 'Storyboard not found')

  const { generateSubtitlePreview } = await import('../services/subtitle.js')
  const previewUrl = await generateSubtitlePreview(storyboardId)
  if (!previewUrl) return badRequest(c, '该镜头没有可用于生成字幕的文本或媒体')
  return success(c, { storyboard_id: storyboardId, preview_url: previewUrl })
})

export default app
