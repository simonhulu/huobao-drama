/**
 * RightCode async Images adapter.
 * Generation uses the /draw prefix; task polling is a site-level endpoint.
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

export class RightCodeImageAdapter implements ImageProviderAdapter {
  provider = 'rightcode'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const settings = parseSettings(config.settings)
    const body: Record<string, unknown> = {
      model: record.model || config.model || 'nano-banana-fast',
      prompt: normalizePrompt(record.prompt, this.provider),
      n: 1,
      size: normalizeAspectRatio(record.size || '1024x1024'),
      imageSize: normalizeImageSize(settings?.imageSize || settings?.image_size || settings?.resolution),
      async: true,
    }

    const referenceImages = parseReferenceImages(record.referenceImages)
    if (referenceImages.length > 0) body.image = referenceImages

    return {
      url: buildRightCodeGenerateUrl(config.baseUrl),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const imageUrl = extractRightCodeImageUrl(result)
    if (imageUrl) return { isAsync: false, imageUrl }

    const taskId = result?.task_id || result?.data?.task_id || result?.id
    if (taskId) return { isAsync: true, taskId: String(taskId) }

    const error = extractRightCodeError(result)
    if (error) throw new Error(`RightCode generation failed: ${error}`)
    throw new Error('No task_id in RightCode response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: buildRightCodeTaskUrl(config.baseUrl, taskId),
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const errorText = extractRightCodeError(result) || ''
    if (/no associated task found/i.test(errorText)) return { status: 'pending' }

    const imageUrl = extractRightCodeImageUrl(result)
    if (imageUrl) return { status: 'completed', imageUrl }
    const base64 = extractRightCodeBase64(result)
    if (base64) return { status: 'completed', imageBase64: base64.data, mimeType: base64.mimeType }

    const status = String(result?.status || result?.data?.status || '').toLowerCase()
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      return { status: 'failed', error: extractRightCodeError(result) || 'Generation failed' }
    }
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      return { status: 'failed', error: 'No image URL in RightCode task result' }
    }
    if (status === 'queued' || status === 'pending') return { status: 'pending' }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return extractRightCodeImageUrl(result)
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    return extractRightCodeBase64(result)
  }
}

export function buildRightCodeTaskUrl(baseUrl: string, taskId: string): string {
  try {
    const url = new URL(baseUrl)
    url.pathname = `/v1/tasks/${encodeURIComponent(taskId)}`
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    const siteBase = String(baseUrl || '').replace(/\/+$/, '').replace(/\/draw$/i, '')
    return `${siteBase}/v1/tasks/${encodeURIComponent(taskId)}`
  }
}

function buildRightCodeGenerateUrl(baseUrl: string): string {
  const normalized = String(baseUrl || '').replace(/\/+$/, '')
  return /\/draw$/i.test(normalized)
    ? joinProviderUrl(normalized, '/v1', '/images/generations')
    : joinProviderUrl(normalized, '/draw/v1', '/images/generations')
}

function parseSettings(settings: AIConfig['settings']): Record<string, any> | null {
  if (!settings) return null
  if (typeof settings === 'object') return settings
  try {
    return JSON.parse(settings)
  } catch {
    return null
  }
}

function parseReferenceImages(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(value => String(value || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function firstResultItem(result: any): any {
  const data = result?.data
  if (Array.isArray(data)) return data[0]
  if (Array.isArray(data?.data)) return data.data[0]
  return null
}

function extractRightCodeImageUrl(result: any): string | null {
  const item = firstResultItem(result)
  return item?.url || result?.image_url || result?.url || result?.data?.image_url || null
}

function extractRightCodeBase64(result: any): { data: string; mimeType: string } | null {
  const item = firstResultItem(result)
  const data = item?.b64_json || result?.b64_json || result?.data?.b64_json
  if (!data) return null
  return { data: String(data), mimeType: `image/${item?.output_format || 'png'}` }
}

function extractRightCodeError(result: any): string | null {
  const error = result?.error?.message || result?.error || result?.data?.error?.message
    || result?.data?.error || result?.error_message || result?.message || result?.data?.message
  return error ? String(error) : null
}

function normalizeImageSize(value: unknown): '1K' | '2K' | '4K' {
  const normalized = String(value || '1K').toUpperCase()
  return normalized === '2K' || normalized === '4K' ? normalized : '1K'
}

function normalizeAspectRatio(size: string): string {
  const match = /^(\d+)x(\d+)$/i.exec(size.trim())
  if (!match) return size
  const width = Number(match[1])
  const height = Number(match[2])
  if (width <= 0 || height <= 0) return size
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) [x, y] = [y, x % y]
  return x || 1
}
