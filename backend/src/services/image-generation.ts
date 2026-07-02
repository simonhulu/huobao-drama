import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { getActiveConfig, getConfigById, type AIConfig as ImportedAIConfig } from './ai.js'

interface ResolvedImageConfig {
  config: ImportedAIConfig
  fallback: boolean
}

function resolveImageConfig(configId?: number | null): ResolvedImageConfig | null {
  if (configId != null) {
    const explicit = getConfigById(configId)
    if (explicit) return { config: explicit, fallback: false }
    logTaskWarn('ImageTask', 'bound-config-inactive-fallback', {
      configId,
      fallback: 'active image config',
    })
  }
  const active = getActiveConfig('image')
  if (!active) return null
  return { config: active, fallback: configId != null }
}
import { now } from '../utils/response.js'
import { AiProviderError, classifyImageError } from '../utils/error-taxonomy.js'
import { syncRelatedImageTables } from './image-generation-sync.js'
import { aiFetch } from './ai-client.js'
import { downloadFile, readImageAsCompressedDataUrl, saveBase64Image } from '../utils/storage.js'
import { getImageAdapter } from './adapters/registry.js'
import { normalizeReferenceImages } from './adapters/reference-images.js'
import { uploadAPIMartImage } from './adapters/apimart-upload.js'
import type { AIConfig } from './adapters/types'
import type { TaskContext } from './tasks/types.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
  seed?: number
  style?: string
}

export class ImageGenerationLimiter {
  private concurrency: number
  private intervalMs: number
  private intervalCap: number
  private running = 0
  private pending: Array<() => void> = []
  private timestamps: number[] = []

  constructor(concurrency: number, intervalMs: number, intervalCap: number) {
    this.concurrency = concurrency
    this.intervalMs = intervalMs
    this.intervalCap = intervalCap
  }

  private tryNext(): void {
    while (this.pending.length > 0) {
      if (this.running >= this.concurrency) {
        return
      }
      const now = Date.now()
      this.timestamps = this.timestamps.filter((ts) => now - ts < this.intervalMs)
      if (this.timestamps.length >= this.intervalCap) {
        const oldest = this.timestamps[0]
        if (oldest) {
          const wait = this.intervalMs - (now - oldest) + 1
          setTimeout(() => this.tryNext(), wait)
        }
        return
      }
      const next = this.pending.shift()
      if (!next) continue
      this.running++
      this.timestamps.push(Date.now())
      next()
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.pending.push(resolve)
      this.tryNext()
    })
    try {
      return await fn()
    } finally {
      this.running--
      this.tryNext()
    }
  }
}

const IMAGE_GENERATION_CONCURRENCY = Math.max(1, Number(process.env.IMAGE_GENERATION_CONCURRENCY || 8))
const IMAGE_GENERATION_INTERVAL_MS = Math.max(1, Number(process.env.IMAGE_GENERATION_INTERVAL_MS || 1000))
const IMAGE_GENERATION_INTERVAL_CAP = Math.max(1, Number(process.env.IMAGE_GENERATION_INTERVAL_CAP || 8))

const imageGenerationLimiter = new ImageGenerationLimiter(
  IMAGE_GENERATION_CONCURRENCY,
  IMAGE_GENERATION_INTERVAL_MS,
  IMAGE_GENERATION_INTERVAL_CAP,
)

class TerminalImagePollError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalImagePollError'
  }
}

export function createImageGenerationRecord(params: GenerateImageParams): number {
  const ts = now()
  const resolved = resolveImageConfig(params.configId)
  if (!resolved) throw new Error('No active image AI config')
  const { config } = resolved

  const res = db.insert(schema.imageGenerations).values({
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    prompt: params.prompt,
    model: params.model || config.model,
    provider: config.provider,
    size: params.size || '1920x1080',
    frameType: params.frameType,
    seed: params.seed,
    style: params.style,
    referenceImages: params.referenceImages ? JSON.stringify(params.referenceImages) : null,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const lastId = Number(res.lastInsertRowid)
  logTaskStart('ImageTask', 'enqueue', {
    id: lastId,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id: lastId,
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })
  return lastId
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  const resolved = resolveImageConfig(params.configId)
  if (!resolved) throw new Error('No active image AI config')

  const lastId = createImageGenerationRecord(params)
  processImageGeneration(lastId, resolved.config)
  return lastId
}

export interface ExecuteImageGenerationOptions {
  configId?: number
  taskContext?: TaskContext<any>
}

export interface ExecuteImageGenerationResult {
  image_generation_id: number
  local_path: string
  image_url?: string | null
}

export async function executeImageGeneration(
  generationId: number,
  options: ExecuteImageGenerationOptions = {},
): Promise<ExecuteImageGenerationResult> {
  const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, generationId)).all()
  const record = rows[0]
  if (!record) throw new Error(`Image generation ${generationId} not found`)

  const resolved = resolveImageConfig(options.configId)
  if (!resolved) throw new Error('No active image AI config')
  const { config, fallback } = resolved

  if (fallback && record.provider !== config.provider) {
    logTaskWarn('ImageTask', 'updating-record-provider-model-on-fallback', {
      generationId,
      fromProvider: record.provider,
      toProvider: config.provider,
      toModel: config.model,
    })
    db.update(schema.imageGenerations)
      .set({ provider: config.provider, model: config.model, taskId: null, updatedAt: now() })
      .where(eq(schema.imageGenerations.id, generationId))
      .run()
  }

  options.taskContext?.progress('Starting image generation', 0, 2)
  await runImageGeneration(generationId, config, options.taskContext)
  options.taskContext?.progress('Image generation finished', 2, 2)

  const [updated] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, generationId)).all()
  if (!updated || updated.status !== 'completed') {
    throw new Error(`Image generation ${generationId} did not complete: ${updated?.status || 'missing'}`)
  }
  return {
    image_generation_id: generationId,
    local_path: updated.localPath || '',
    image_url: updated.imageUrl || null,
  }
}

async function runImageGeneration(id: number, config: AIConfig, taskContext?: TaskContext<any>): Promise<void> {
  const adapter = getImageAdapter(config)

  try {
    const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
    const record = rows[0]
    if (!record) return
    if (record.status === 'completed' && record.localPath) return

    if (record.taskId && record.status === 'processing') {
      logTaskProgress('ImageTask', 'poll-resume', {
        id,
        taskId: record.taskId,
        provider: config.provider,
      })
      await pollImageTask(id, config, record.taskId)
      return
    }

    taskContext?.progress('Building image generation request', 0, 2)
    logTaskProgress('ImageTask', 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
      frameType: record.frameType,
    })

    // 使用 Adapter 构建请求
    const resolvedReferenceImages = await normalizeReferenceImages(record.referenceImages, {
      maxWidth: 1024,
      maxHeight: 1024,
      quality: 90,
      format: 'preserve',
      maxCount: 9,
      output: config.provider === 'apimart' ? 'remoteUrl' : 'dataUrl',
      uploadImage: config.provider === 'apimart'
        ? (input) => uploadAPIMartImage(config, {
            buffer: input.buffer,
            mimeType: input.mimeType,
            filename: input.filename,
          })
        : undefined,
    })
    const { url, method, headers, body } = adapter.buildGenerateRequest(config, {
      id: record.id,
      model: record.model,
      prompt: record.prompt,
      size: record.size,
      frameType: record.frameType,
      seed: record.seed,
      referenceImages: resolvedReferenceImages.length > 0 ? JSON.stringify(resolvedReferenceImages) : null,
    })
    logTaskProgress('ImageTask', 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })
    logTaskPayload('ImageTask', 'request payload', {
      id,
      method,
      url,
      headers,
      body,
    })

    const resp = await imageGenerationLimiter.run(() =>
      aiFetch(config.provider, url, {
        method,
        headers,
        body: JSON.stringify(body),
      }, { timeoutMs: 600_000 }),
    )

    if (!resp.ok) {
      const retryAfter = resp.headers.get('retry-after')
      const responseText = await resp.text()
      logTaskError('ImageTask', 'api-error', {
        id,
        provider: config.provider,
        status: resp.status,
        statusText: resp.statusText,
        responseBody: responseText.slice(0, 2000),
      })
      throw new AiProviderError(`API error ${resp.status}: ${responseText}`, resp.status, {
        retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined,
        provider: config.provider,
      })
    }
    const result = await resp.json() as any
    logTaskPayload('ImageTask', 'response payload', {
      id,
      provider: config.provider,
      result,
    })

    const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

    if (!isAsync && imageUrl) {
      logTaskProgress('ImageTask', 'sync-complete', { id, imageUrl })
      // 同步模式：直接下载图片
      await handleImageComplete(id, config.provider, imageUrl)
      return
    }

    if (!isAsync && !imageUrl) {
      // 同步模式但无 URL（Gemini 等返回 base64）
      const b64 = adapter.extractImageBase64(result)
      if (b64) {
        logTaskProgress('ImageTask', 'sync-base64-complete', { id, mimeType: b64.mimeType })
        await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
        return
      }
      throw new Error('No image URL or base64 data in response')
    }

    // 异步模式：更新 taskId，开始轮询
    db.update(schema.imageGenerations)
      .set({ taskId, status: 'processing', updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
    logTaskProgress('ImageTask', 'poll-start', { id, taskId, provider: config.provider })
    await pollImageTask(id, config, taskId!)
  } catch (err: any) {
    const error = err instanceof Error ? err : new Error(String(err))
    const classification = classifyImageError(error)
    logTaskError('ImageTask', 'process', {
      id,
      provider: config.provider,
      error: err.message,
      errorCode: classification.code,
      retryable: classification.retryable,
    })
    logTaskPayload('ImageTask', 'error detail', {
      id,
      provider: config.provider,
      errorCode: classification.code,
      errorMessage: err.message,
    })
    db.update(schema.imageGenerations)
      .set({ status: 'failed', errorMsg: err.message, lastErrorCode: classification.code, lastErrorDetail: err.message, updatedAt: now() })
      .where(eq(schema.imageGenerations.id, id))
      .run()
    throw err
  }
}

function processImageGeneration(id: number, config: AIConfig): void {
  runImageGeneration(id, config).catch(err => {
    logTaskError('ImageTask', 'process', { id, error: err.message })
    console.error(`Image generation ${id} failed:`, err)
  })
}

async function pollImageTask(id: number, config: AIConfig, taskId: string) {
  const adapter = getImageAdapter(config)
  const startedAt = Date.now()
  const maxDurationMs = 600_000

  for (let i = 0; i < 120; i++) {
    const settled = getSettledImageGeneration(id)
    if (settled === 'completed') return
    if (settled === 'failed') throw new TerminalImagePollError(`Image generation ${id} failed during provider wait`)

    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: 'Polling exceeded 10 minutes' })
      db.update(schema.imageGenerations)
        .set({ status: 'failed', errorMsg: 'Timeout: Polling exceeded 10 minutes', updatedAt: now() })
        .where(eq(schema.imageGenerations.id, id))
        .run()
      return
    }
    await new Promise(r => setTimeout(r, 5000))
    if (Date.now() - startedAt >= maxDurationMs) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: 'Polling exceeded 10 minutes' })
      db.update(schema.imageGenerations)
        .set({ status: 'failed', errorMsg: 'Timeout: Polling exceeded 10 minutes', updatedAt: now() })
        .where(eq(schema.imageGenerations.id, id))
        .run()
      return
    }
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress('ImageTask', 'poll-request', {
        id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = Math.max(1_000, maxDurationMs - (Date.now() - startedAt))
      const resp = await aiFetch(config.provider, url, {
        method,
        headers,
      }, { timeoutMs: remainingMs, maxAttempts: 1 })
      if (!resp.ok) continue
      const result = await resp.json() as any

      const pollResp = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.imageUrl) {
        logTaskSuccess('ImageTask', 'poll-complete', { id, taskId, imageUrl: pollResp.imageUrl })
        await handleImageComplete(id, config.provider, pollResp.imageUrl)
        return
      }
      if (pollResp.status === 'completed' && !pollResp.imageUrl) {
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskSuccess('ImageTask', 'poll-base64-complete', { id, taskId, mimeType: b64.mimeType })
          await handleImageCompleteBase64(id, config.provider, b64.data, b64.mimeType)
          return
        }
      }
      if (pollResp.status === 'failed') {
        const message = pollResp.error || 'Generation failed'
        logTaskError('ImageTask', 'poll-failed', { id, taskId, error: message })
        throw new TerminalImagePollError(message)
      }
    } catch (err: any) {
      const error = err instanceof Error ? err : new Error(String(err))
      const classification = classifyImageError(error)
      if (err instanceof TerminalImagePollError || !classification.retryable) {
        logTaskError('ImageTask', 'poll-terminal-error', {
          id,
          taskId,
          error: error.message,
          errorCode: classification.code,
        })
        throw error
      }
      if (i === 119 || Date.now() - startedAt >= maxDurationMs) {
        logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: error.message })
        db.update(schema.imageGenerations)
          .set({ status: 'failed', errorMsg: `Timeout: ${error.message}`, updatedAt: now() })
          .where(eq(schema.imageGenerations.id, id))
          .run()
        return
      }
      logTaskWarn('ImageTask', 'poll-retry', { id, taskId, attempt: i + 1, error: error.message })
    }
  }
}

function getSettledImageGeneration(id: number): 'completed' | 'failed' | null {
  const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  if (record?.status === 'completed' && record.localPath) return 'completed'
  if (record?.status === 'failed') return 'failed'
  return null
}

export async function completeImageGenerationFromUrl(id: number, provider: string, imageUrl: string) {
  if (getSettledImageGeneration(id) === 'completed') return
  await handleImageComplete(id, provider, imageUrl)
}

export function failImageGenerationFromProvider(id: number, errorMessage: string, errorCode?: string | null) {
  db.update(schema.imageGenerations)
    .set({
      status: 'failed',
      errorMsg: errorMessage,
      lastErrorCode: errorCode ?? null,
      lastErrorDetail: errorMessage,
      updatedAt: now(),
    })
    .where(eq(schema.imageGenerations.id, id))
    .run()
}

async function handleImageComplete(id: number, provider: string, imageUrl: string) {
  const localPath = await downloadFile(imageUrl, 'images')
  db.transaction((tx) => syncRelatedImageTables(tx, id, localPath, imageUrl))
  logTaskSuccess('ImageTask', 'downloaded', { id, provider, localPath })
}

async function handleImageCompleteBase64(id: number, provider: string, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  db.transaction((tx) => syncRelatedImageTables(tx, id, localPath, null))
  logTaskSuccess('ImageTask', 'saved-base64', { id, provider, mimeType, localPath })
}
