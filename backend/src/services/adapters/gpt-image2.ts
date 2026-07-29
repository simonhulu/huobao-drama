/**
 * pcore.ai GPT Image 2 async adapter.
 * Generation and polling use the same /images/generations resource.
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types.js'
import { joinProviderUrl } from './url.js'
import { normalizePrompt } from './prompt-utils.js'

export class GptImage2Adapter implements ImageProviderAdapter {
  provider = 'gpt-image2'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const settings = parseSettings(config.settings)
    const model = record.model || config.model || 'gpt-image-2'
    const body: Record<string, unknown> = {
      async: true,
      model,
      prompt: normalizePrompt(record.prompt, this.provider),
      n: normalizeCount(settings?.n),
      size: normalizeSize(record.size || settings?.size || 'auto', model),
    }

    if (settings?.quality) body.quality = settings.quality

    const referenceImages = parseReferenceImages(record.referenceImages)
    if (referenceImages.length > 0) {
      // pcore documents `images` as the JSON reference-image alias for 1K/2K/4K.
      body.images = referenceImages.slice(0, 9)
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const taskId = result?.id || result?.task_id || result?.data?.id
    if (taskId) return { isAsync: true, taskId: String(taskId) }

    // This adapter deliberately has no synchronous fallback. A direct image
    // response proves the provider did not honor the required `async: true`
    // contract; accepting it would make a long-running workflow block in the
    // request path and bypass its persisted provider-task recovery.
    if (extractImageUrl(result) || extractImageBase64(result)) {
      throw new Error('GPT Image 2 provider returned a synchronous image response; async task id is required')
    }

    const error = extractError(result)
    throw new Error(error ? `GPT Image 2 generation failed: ${error}` : 'No task id in GPT Image 2 response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/images/generations/${encodeURIComponent(taskId)}`),
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = String(result?.status || result?.data?.status || '').toLowerCase()
    const imageUrl = extractImageUrl(result)
    if (imageUrl || status === 'completed' || status === 'succeeded' || status === 'success') {
      return imageUrl
        ? { status: 'completed', imageUrl }
        : { status: 'failed', error: 'GPT Image 2 task completed without an image URL' }
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
      return { status: 'failed', error: extractError(result) || 'GPT Image 2 generation failed' }
    }
    if (status === 'queued' || status === 'pending' || status === 'submitted') return { status: 'pending' }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return extractImageUrl(result)
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    return extractImageBase64(result)
  }
}

function parseSettings(settings: AIConfig['settings']): Record<string, any> | null {
  if (!settings) return null
  if (typeof settings === 'object') return settings
  try { return JSON.parse(settings) } catch { return null }
}

function parseReferenceImages(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(value => String(value || '').trim()).filter(Boolean) : []
  } catch { return [] }
}

function normalizeCount(value: unknown): number {
  const count = Number(value)
  return Number.isInteger(count) && count >= 1 && count <= 10 ? count : 1
}

function normalizeSize(value: string, model: string): string {
  const size = String(value || 'auto').trim()
  if (size === 'auto' || /^\d+:\d+$/.test(size)) return size
  const match = /^(\d+)x(\d+)$/i.exec(size)
  if (!match) return size
  // The un-tiered web model documents aspect ratios, while tiered models accept exact dimensions.
  if (/-[124]k$/i.test(model)) return size
  const width = Number(match[1])
  const height = Number(match[2])
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

function extractImageUrl(result: any): string | null {
  const data = Array.isArray(result?.data) ? result.data[0] : result?.data
  return typeof data?.url === 'string' ? data.url : null
}

function extractImageBase64(result: any): { data: string; mimeType: string } | null {
  const data = Array.isArray(result?.data) ? result.data[0] : result?.data
  const encoded = data?.b64_json ?? data?.b64Json
  if (typeof encoded !== 'string' || !encoded.trim()) return null
  const outputFormat = String(result?.output_format || result?.outputFormat || 'png').toLowerCase()
  const mimeType = outputFormat === 'jpeg' || outputFormat === 'jpg' ? 'image/jpeg'
    : outputFormat === 'webp' ? 'image/webp'
      : 'image/png'
  return { data: encoded, mimeType }
}

function extractError(result: any): string | null {
  const error = result?.error?.message || result?.error || result?.message || result?.data?.error?.message || result?.data?.error
  return error ? String(error) : null
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) [x, y] = [y, x % y]
  return x || 1
}
