import { executeVideoGeneration } from '../../video-generation.js'
import { registerTaskHandler } from '../registry.js'
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
      return result
    },
  }
}

export function registerVideoGenerateHandler() {
  registerTaskHandler('video.generate', createVideoGenerateHandler())
}
