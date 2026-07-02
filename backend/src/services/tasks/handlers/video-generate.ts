import { executeVideoGeneration } from '../../video-generation.js'
import { getEpisodeVisualStyle } from '../../episode-mode.js'
import { registerTaskHandler } from '../registry.js'
import { scheduleComposeForEpisode } from '../auto-pipeline.js'
import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import type { TaskContext, TaskHandler } from '../types.js'

interface VideoGeneratePayload {
  video_generation_id?: number
  videoGenerationId?: number
  config_id?: number
  configId?: number
}

interface VideoGenerateDeps {
  executeVideoGeneration?: typeof executeVideoGeneration
}

function readPayload(payload: VideoGeneratePayload) {
  const generationId = Number(payload.video_generation_id ?? payload.videoGenerationId)
  const configId = payload.config_id ?? payload.configId
  if (!generationId) throw new Error('video_generation_id is required')
  return { generationId, configId: configId == null ? undefined : Number(configId) }
}

export function createVideoGenerateHandler(deps: VideoGenerateDeps = {}): TaskHandler<VideoGeneratePayload> {
  const execute = deps.executeVideoGeneration ?? executeVideoGeneration
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<VideoGeneratePayload>) {
      const { generationId, configId } = readPayload(ctx.payload)
      ctx.progress('Starting video generation', 0, 3)
      ctx.event('video.generation', { generationId })
      const result = await execute(generationId, { configId, taskContext: ctx })
      ctx.progress('Video generation completed', 3, 3)
      ctx.event('video.completed', result)

      // 自动流水线：单个视频完成后，尝试为本分镜调度合成
      scheduleComposeIfStoryboardReady(result.video_generation_id)

      return result
    },
  }
}

function scheduleComposeIfStoryboardReady(videoGenerationId: number) {
  const [record] = db.select().from(schema.videoGenerations)
    .where(eq(schema.videoGenerations.id, videoGenerationId)).all()
  if (!record?.storyboardId) return

  const storyboardId = record.storyboardId
  const [sb] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb?.episodeId) return

  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!ep || getEpisodeVisualStyle(sb.episodeId) !== 'ai_video' || !ep.autoMode) return

  if (!sb.videoUrl) return

  scheduleComposeForEpisode(ep.dramaId, ep.id, [storyboardId])
}

export function registerVideoGenerateHandler() {
  registerTaskHandler('video.generate', createVideoGenerateHandler())
}
