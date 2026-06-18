import { executeImageGeneration } from '../../image-generation.js'
import { registerTaskHandler } from '../registry.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface ImageGeneratePayload {
  image_generation_id?: number
  imageGenerationId?: number
  config_id?: number
  configId?: number
}

interface ImageGenerateDeps {
  executeImageGeneration?: typeof executeImageGeneration
}

function readPayload(payload: ImageGeneratePayload) {
  const generationId = Number(payload.image_generation_id ?? payload.imageGenerationId)
  const configId = payload.config_id ?? payload.configId
  if (!generationId) throw new Error('image_generation_id is required')
  return { generationId, configId: configId == null ? undefined : Number(configId) }
}

export function createImageGenerateHandler(deps: ImageGenerateDeps = {}): TaskHandler<ImageGeneratePayload> {
  const execute = deps.executeImageGeneration ?? executeImageGeneration
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<ImageGeneratePayload>) {
      const { generationId, configId } = readPayload(ctx.payload)
      ctx.progress('Starting image generation', 0, 3)
      ctx.event('image.generation', { generationId })
      const result = await execute(generationId, { configId, taskContext: ctx })
      ctx.progress('Image generation completed', 3, 3)
      ctx.event('image.completed', result)
      return result
    },
  }
}

export function registerImageGenerateHandler() {
  registerTaskHandler('image.generate', createImageGenerateHandler())
}
