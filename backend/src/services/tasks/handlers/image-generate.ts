import { executeImageGeneration } from '../../image-generation.js'
import { repairStoryboardImagePromptForGeneration } from '../../storyboard-prompt-repair.js'
import { getEpisodeVisualStyle } from '../../episode-mode.js'
import { registerTaskHandler } from '../registry.js'
import { scheduleComposeForEpisode } from '../auto-pipeline.js'
import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import { classifyImageError } from '../../../utils/error-taxonomy.js'
import { listTaskEvents } from '../store.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface ImageGeneratePayload {
  image_generation_id?: number
  imageGenerationId?: number
  config_id?: number
  configId?: number
}

interface ImageGenerateDeps {
  executeImageGeneration?: typeof executeImageGeneration
  repairStoryboardImagePromptForGeneration?: typeof repairStoryboardImagePromptForGeneration
}

function readPayload(payload: ImageGeneratePayload) {
  const generationId = Number(payload.image_generation_id ?? payload.imageGenerationId)
  const configId = payload.config_id ?? payload.configId
  if (!generationId) throw new Error('image_generation_id is required')
  return { generationId, configId: configId == null ? undefined : Number(configId) }
}

export function createImageGenerateHandler(deps: ImageGenerateDeps = {}): TaskHandler<ImageGeneratePayload> {
  const execute = deps.executeImageGeneration ?? executeImageGeneration
  const repairPrompt = deps.repairStoryboardImagePromptForGeneration ?? repairStoryboardImagePromptForGeneration
  return {
    resumable: true,
    maxAttempts: 3,
    async run(ctx: TaskContext<ImageGeneratePayload>) {
      const { generationId, configId } = readPayload(ctx.payload)
      ctx.progress('Starting image generation', 0, 3)
      ctx.event('image.generation', { generationId })
      let result
      try {
        result = await execute(generationId, { configId, taskContext: ctx })
      } catch (err: any) {
        const error = err instanceof Error ? err : new Error(String(err))
        const classification = classifyImageError(error)
        const alreadyRepaired = listTaskEvents(ctx.taskId)
          .some(event => event.eventType === 'image.prompt_repaired')

        if (classification.code !== 'content_policy_violation' || alreadyRepaired) {
          throw error
        }

        ctx.progress('Repairing image prompt after safety rejection', 1, 3)
        try {
          const repaired = await repairPrompt(generationId, error.message)
          ctx.event('image.prompt_repaired', {
            generationId,
            model: repaired.model,
            repairedPrompt: repaired.repairedPrompt,
          })
        } catch (repairErr: any) {
          ctx.event('image.prompt_repair_failed', {
            generationId,
            error: repairErr instanceof Error ? repairErr.message : String(repairErr),
          })
          throw error
        }

        ctx.progress('Retrying image generation with repaired prompt', 2, 3)
        result = await execute(generationId, { configId, taskContext: ctx })
      }
      ctx.progress('Image generation completed', 3, 3)
      ctx.event('image.completed', result)

      // 自动流水线：单张图片完成后，尝试为本集所有已就绪分镜调度合成
      scheduleComposeIfStoryboardReady(result.image_generation_id)

      return result
    },
  }
}

export function registerImageGenerateHandler() {
  registerTaskHandler('image.generate', createImageGenerateHandler())
}

function scheduleComposeIfStoryboardReady(imageGenerationId: number) {
  const [record] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, imageGenerationId)).all()
  if (!record?.storyboardId) return

  const storyboardId = record.storyboardId
  const [sb] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb?.episodeId) return

  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, sb.episodeId)).all()
  if (!ep || !ep.autoMode) return

  const visualStyle = getEpisodeVisualStyle(sb.episodeId)
  const hasMedia = visualStyle === 'ai_video' ? !!sb.videoUrl : !!sb.firstFrameImage
  if (!hasMedia) return

  scheduleComposeForEpisode(ep.dramaId, ep.id, [storyboardId])
}
