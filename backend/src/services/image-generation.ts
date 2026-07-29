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
import { aiFetch, imageRequestTransport } from './ai-client.js'
import { downloadFile, saveBase64Image } from '../utils/storage.js'
import { getImageAdapter } from './adapters/registry.js'
import { normalizeReferenceImages } from './adapters/reference-images.js'
import { uploadAPIMartImage } from './adapters/apimart-upload.js'
import {
  getEgakiChatGptImageJob,
  submitEgakiChatGptImageJob,
  waitForEgakiChatGptImageJob,
} from './egaki-chatgpt-image.js'
import type { AIConfig } from './adapters/types'
import type { TaskContext } from './tasks/types.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'

interface GenerateImageParams {
  storyboardId?: number
  episodeId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  imageType?: string
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
const IMAGE_POLL_TIMEOUT_MS = Math.max(60_000, Number(process.env.IMAGE_POLL_TIMEOUT_MS || 1_200_000))
const IMAGE_POLL_RESPONSE_TIMEOUT_MS = Math.max(5_000, Number(process.env.IMAGE_POLL_RESPONSE_TIMEOUT_MS || 60_000))
const EGAKI_IMAGE_CONCURRENCY = Math.max(1, Number(process.env.EGAKI_IMAGE_CONCURRENCY || 2))
const EGAKI_IMAGE_INTERVAL_MS = Math.max(1, Number(process.env.EGAKI_IMAGE_INTERVAL_MS || 60_000))
const EGAKI_IMAGE_INTERVAL_CAP = Math.max(1, Number(process.env.EGAKI_IMAGE_INTERVAL_CAP || 4))
const PCORE_IMAGE_CONCURRENCY = Math.max(1, Number(process.env.PCORE_IMAGE_CONCURRENCY || 4))

const imageGenerationLimiter = new ImageGenerationLimiter(
  IMAGE_GENERATION_CONCURRENCY,
  IMAGE_GENERATION_INTERVAL_MS,
  IMAGE_GENERATION_INTERVAL_CAP,
)
const egakiImageGenerationLimiter = new ImageGenerationLimiter(
  EGAKI_IMAGE_CONCURRENCY,
  EGAKI_IMAGE_INTERVAL_MS,
  EGAKI_IMAGE_INTERVAL_CAP,
)
// pcore accepts asynchronous jobs, but each job remains active while it is
// polled and downloaded. Limiting only submission bursts still lets a large
// episode create dozens of live jobs, so bound the complete lifecycle.
const pcoreImageGenerationLimiter = new ImageGenerationLimiter(
  PCORE_IMAGE_CONCURRENCY,
  1,
  PCORE_IMAGE_CONCURRENCY,
)

function runWithProviderLifecycleLimit<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  return provider.toLowerCase() === 'pcore'
    ? pcoreImageGenerationLimiter.run(fn)
    : fn()
}

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
    episodeId: params.episodeId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    imageType: params.imageType,
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
  await runWithProviderLifecycleLimit(config.provider, () => runImageGeneration(generationId, config, options.taskContext))
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
  try {
    const rows = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
    const record = rows[0]
    if (!record) return
    if (record.status === 'completed' && record.localPath) return

    if (record.taskId && record.status === 'processing' && config.provider.toLowerCase() === 'egaki-chatgpt') {
      const existingJob = getEgakiChatGptImageJob(record.taskId)
      if (existingJob) {
        logTaskProgress('ImageTask', 'egaki-chatgpt-local-poll-resume', {
          id,
          taskId: record.taskId,
          provider: config.provider,
          status: existingJob.status,
        })
        const localPath = await waitForEgakiChatGptImageJob(record.taskId, {
          signal: taskContext?.signal,
          timeoutMs: IMAGE_POLL_TIMEOUT_MS,
        })
        db.transaction((tx) => syncRelatedImageTables(tx, id, localPath, null))
        logTaskSuccess('ImageTask', 'egaki-chatgpt-saved', { id, provider: config.provider, taskId: record.taskId, localPath })
        return
      }
      logTaskWarn('ImageTask', 'egaki-chatgpt-local-job-missing-resubmit', {
        id,
        taskId: record.taskId,
        provider: config.provider,
      })
      db.update(schema.imageGenerations)
        .set({ taskId: null, updatedAt: now() })
        .where(eq(schema.imageGenerations.id, id))
        .run()
    } else if (record.taskId && record.status === 'processing') {
      logTaskProgress('ImageTask', 'poll-resume', {
        id,
        taskId: record.taskId,
        provider: config.provider,
      })
      await pollImageTask(id, config, record.taskId, taskContext?.signal)
      return
    }

    if (config.provider.toLowerCase() === 'egaki-chatgpt') {
      taskContext?.progress('Generating image with egaki ChatGPT', 1, 2)
      logTaskProgress('ImageTask', 'egaki-chatgpt-start', {
        id,
        provider: config.provider,
        model: record.model || config.model,
        size: record.size,
        hasReferenceImages: Boolean(record.referenceImages),
        seedIgnored: record.seed != null,
      })
      const localPath = await egakiImageGenerationLimiter.run(async () => {
        const jobId = submitEgakiChatGptImageJob({
          id: record.id,
          model: record.model || config.model,
          prompt: record.prompt,
          size: record.size,
          seed: record.seed,
          referenceImages: record.referenceImages,
        }, {
          signal: taskContext?.signal,
        })
        db.update(schema.imageGenerations)
          .set({ taskId: jobId, status: 'processing', updatedAt: now() })
          .where(eq(schema.imageGenerations.id, id))
          .run()
        logTaskProgress('ImageTask', 'egaki-chatgpt-local-poll-start', {
          id,
          provider: config.provider,
          taskId: jobId,
        })
        return waitForEgakiChatGptImageJob(jobId, {
          signal: taskContext?.signal,
          timeoutMs: IMAGE_POLL_TIMEOUT_MS,
        })
      })
      db.transaction((tx) => syncRelatedImageTables(tx, id, localPath, null))
      logTaskSuccess('ImageTask', 'egaki-chatgpt-saved', { id, provider: config.provider, localPath })
      return
    }

    const adapter = getImageAdapter(config)

    // A parent workflow can retry while an async provider job is still queued.
    // Resume the provider task instead of submitting a duplicate billable job.
    if (record.taskId && record.status === 'processing') {
      taskContext?.progress('Resuming image generation', 0, 2)
      logTaskProgress('ImageTask', 'poll-resume', {
        id,
        provider: config.provider,
        taskId: record.taskId,
      })
      await pollImageTask(id, config, record.taskId, taskContext?.signal)
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
      transport: imageRequestTransport(config.provider, url),
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
    await pollImageTask(id, config, taskId!, taskContext?.signal)
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
  runWithProviderLifecycleLimit(config.provider, () => runImageGeneration(id, config)).catch(err => {
    logTaskError('ImageTask', 'process', { id, error: err.message })
    console.error(`Image generation ${id} failed:`, err)
  })
}

function abortReason(signal: AbortSignal | undefined, fallback: string): Error {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new Error(fallback)
}

function throwIfAborted(signal: AbortSignal | undefined, fallback: string): void {
  if (signal?.aborted) throw abortReason(signal, fallback)
}

function waitForPollInterval(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal, 'Image generation polling was canceled')
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const onAbort = () => done(abortReason(signal, 'Image generation polling was canceled'))

    function done(error?: Error) {
      if (timeout != null) clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(done, ms)
  })
}

/**
 * Fetch timeouts only cover connection and headers in some fetch implementations.
 * Race JSON decoding as well so a provider that never closes a response body cannot
 * keep an image worker alive indefinitely.
 */
export function readProviderJsonWithinDeadline(
  response: Response,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<any> {
  throwIfAborted(signal, 'Image generation polling was canceled')
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs))
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    const onAbort = () => finish(abortReason(signal, 'Image generation polling was canceled'))

    function finish(error?: Error, value?: any) {
      if (settled) return
      settled = true
      if (timeout != null) clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => finish(new Error(`Provider poll response timed out after ${boundedTimeoutMs}ms`)), boundedTimeoutMs)
    response.json().then(
      (value) => finish(undefined, value),
      (error) => finish(error instanceof Error ? error : new Error(String(error))),
    )
  })
}

/**
 * The provider deadline belongs to the persisted job, rather than one worker
 * attempt. Recovering a lease must resume a task, never restart its timeout.
 */
export function resolveImagePollDeadlineMs(
  createdAt: string | null | undefined,
  maxDurationMs: number,
  nowMs = Date.now(),
): number {
  const submittedAt = Date.parse(String(createdAt || ''))
  return Number.isFinite(submittedAt) && submittedAt <= nowMs
    ? submittedAt + maxDurationMs
    : nowMs + maxDurationMs
}

async function pollImageTask(id: number, config: AIConfig, taskId: string, signal?: AbortSignal) {
  const adapter = getImageAdapter(config)
  const maxDurationMs = IMAGE_POLL_TIMEOUT_MS
  const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  const deadlineAt = resolveImagePollDeadlineMs(record?.createdAt, maxDurationMs)

  let attempt = 0
  while (Date.now() < deadlineAt) {
    attempt++
    throwIfAborted(signal, 'Image generation polling was canceled')
    const settled = getSettledImageGeneration(id)
    if (settled === 'completed') return
    if (settled === 'failed') {
      const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
      const detail = record?.errorMsg || record?.lastErrorDetail || 'unknown'
      throw new TerminalImagePollError(`Image generation ${id} failed during provider wait: ${detail}`)
    }

    if (Date.now() >= deadlineAt) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: 'Polling exceeded provider deadline' })
      db.update(schema.imageGenerations)
        .set({ status: 'failed', errorMsg: 'Timeout: Polling exceeded provider deadline', updatedAt: now() })
        .where(eq(schema.imageGenerations.id, id))
        .run()
      return
    }
    await waitForPollInterval(5000, signal)
    if (Date.now() >= deadlineAt) {
      logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: 'Polling exceeded provider deadline' })
      db.update(schema.imageGenerations)
        .set({ status: 'failed', errorMsg: 'Timeout: Polling exceeded provider deadline', updatedAt: now() })
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
        attempt,
        transport: imageRequestTransport(config.provider, url),
      })
      const remainingMs = Math.max(1_000, deadlineAt - Date.now())
      const responseTimeoutMs = Math.min(remainingMs, IMAGE_POLL_RESPONSE_TIMEOUT_MS)
      const resp = await aiFetch(config.provider, url, {
        method,
        headers,
        signal,
      }, { timeoutMs: responseTimeoutMs, maxAttempts: 1 })
      if (!resp.ok) continue
      const result = await readProviderJsonWithinDeadline(resp, responseTimeoutMs, signal)

      const pollResp = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed' && pollResp.imageUrl) {
        logTaskSuccess('ImageTask', 'poll-complete', { id, taskId, imageUrl: pollResp.imageUrl })
        await handleImageComplete(id, config.provider, pollResp.imageUrl)
        return
      }
      if (pollResp.status === 'completed' && pollResp.imageBase64) {
        const mimeType = pollResp.mimeType || 'image/png'
        logTaskSuccess('ImageTask', 'poll-base64-complete', { id, taskId, mimeType })
        await handleImageCompleteBase64(id, config.provider, pollResp.imageBase64, mimeType)
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
        logTaskError('ImageTask', 'poll-failed', { id, taskId, error: message, rawResponse: result })
        db.update(schema.imageGenerations)
          .set({ status: 'failed', errorMsg: message, lastErrorCode: 'provider_failed', lastErrorDetail: JSON.stringify(result).slice(0, 2000), updatedAt: now() })
          .where(eq(schema.imageGenerations.id, id))
          .run()
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
      if (Date.now() >= deadlineAt) {
        logTaskError('ImageTask', 'poll-timeout', { id, taskId, error: error.message })
        db.update(schema.imageGenerations)
          .set({ status: 'failed', errorMsg: `Timeout: ${error.message}`, updatedAt: now() })
          .where(eq(schema.imageGenerations.id, id))
          .run()
        return
      }
      logTaskWarn('ImageTask', 'poll-retry', { id, taskId, attempt, error: error.message })
    }
  }

  db.update(schema.imageGenerations)
    .set({ status: 'failed', errorMsg: 'Timeout: Polling exceeded provider deadline', updatedAt: now() })
    .where(eq(schema.imageGenerations.id, id))
    .run()
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
