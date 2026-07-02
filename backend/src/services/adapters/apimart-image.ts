/**
 * APIMart GPT-Image-2 Adapter
 * POST /v1/images/generations returns { task_id }; poll /v1/tasks/{task_id}.
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url.js'
import { normalizePrompt } from './prompt-utils.js'

export class APIMartImageAdapter implements ImageProviderAdapter {
  provider = 'apimart'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const size = normalizeAPIMartSize(record.size || '1024x1024')
    const settings = config.settings
      ? (typeof config.settings === 'string' ? JSON.parse(config.settings) : config.settings)
      : null

    const body: Record<string, unknown> = {
      model: record.model || config.model || 'gpt-image-2',
      prompt: normalizePrompt(record.prompt, this.provider),
      size,
      resolution: settings?.resolution || '1k',
      n: 1,
    }

    const imageUrls = parseReferenceImages(record.referenceImages)
    if (imageUrls.length > 0) {
      body.image_urls = imageUrls
    }

    if (record.seed != null) {
      body.seed = record.seed
    }

    // GPT-Image-2 supports quality: low | medium | high | auto
    if (settings?.quality) {
      body.quality = settings.quality
    }
    if (settings?.official_fallback != null) {
      body.official_fallback = Boolean(settings.official_fallback)
    }
    const webhookUrl = resolveAPIMartWebhookUrl(settings)
    if (webhookUrl) {
      body.webhook = webhookUrl
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const data = Array.isArray(result.data) ? result.data[0] : result.data
    const taskId = result.task_id || data?.task_id || data?.id || result.id
    if (!taskId) {
      const error = result.error?.message
        || result.error
        || result.message
        || data?.error?.message
        || data?.error
      if (error) throw new Error(`APIMart generation failed: ${String(error)}`)
      throw new Error('No task_id in APIMart response')
    }
    return { isAsync: true, taskId: String(taskId) }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/tasks/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const data = result.data ?? result
    const status = String(data.status || result.status || '').toLowerCase()

    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const imageUrl = extractAPIMartImageUrl(data)
      if (!imageUrl) return { status: 'failed', error: 'No image URL in APIMart task result' }
      return { status: 'completed', imageUrl }
    }

    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      return {
        status: 'failed',
        error: data.error?.message || data.error || data.error_message || result.error?.message || 'Generation failed',
      }
    }

    if (status === 'pending' || status === 'queued' || status === 'submitted') {
      return { status: 'pending' }
    }

    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return extractAPIMartImageUrl(result.data ?? result)
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json
    if (!b64) return null
    const fmt = result.data?.[0]?.output_format || 'png'
    return { data: b64, mimeType: `image/${fmt}` }
  }
}

function parseReferenceImages(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => String(item || '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

function extractAPIMartImageUrl(data: any): string | null {
  const firstImage = data?.result?.images?.[0]
  const url = firstImage?.url
  if (Array.isArray(url)) return url[0] || null
  if (typeof url === 'string') return url
  return data?.image_url || data?.url || data?.data?.[0]?.url || null
}

function normalizeAPIMartSize(size: string): string {
  const match = /^(\d+)x(\d+)$/i.exec(size.trim())
  if (!match) return size

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return size
  }

  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) {
    const next = x % y
    x = y
    y = next
  }
  return x || 1
}

function resolveAPIMartWebhookUrl(settings: any): string | null {
  const configured = settings?.webhook || settings?.webhook_url || settings?.webhookUrl || settings?.callback_url || settings?.callbackUrl
  if (configured) return normalizeWebhookBaseUrl(String(configured))
  const base = process.env.APIMART_WEBHOOK_BASE_URL || process.env.PUBLIC_BASE_URL
  if (!base) return null
  return `${String(base).replace(/\/+$/, '')}/webhooks/apimart/images`
}

function normalizeWebhookBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  return normalized.endsWith('/callback')
    ? normalized.slice(0, -'/callback'.length)
    : normalized
}
