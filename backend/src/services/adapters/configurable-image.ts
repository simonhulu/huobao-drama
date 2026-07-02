/**
 * 可配置图片生成 Adapter
 * 通过 settings.adapter 模板定义请求/响应/轮询逻辑
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
import { sizeToMiniMaxAspectRatio } from './minimax-aspect-ratio.js'
import { normalizeReferenceImages } from './reference-images'
import { normalizePrompt } from './prompt-utils.js'

/** Adapter 配置结构 */
export interface ImageAdapterConfig {
  request: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: any
  }
  response: {
    async?: boolean
    asyncWhenPath?: string
    taskIdPath?: string
    imageUrlPath?: string
    base64Path?: string
    mimeTypePath?: string
    errorPath?: string
  }
  poll?: {
    request: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: any
    }
    response: {
      statusPath: string
      completedValues: string[]
      failedValues?: string[]
      imageUrlPath?: string
      base64Path?: string
      errorPath?: string
    }
  }
  size?: {
    strategy: 'passthrough' | 'aspectRatio' | 'widthHeight' | 'map'
    map?: Record<string, string>
    default?: string
  }
}

function getPath(obj: any, path: string): any {
  if (!path) return undefined
  const parts = path.split('.')
  let current = obj
  for (const part of parts) {
    if (current == null) return undefined
    if (part === '*') {
      if (Array.isArray(current) && current.length > 0) {
        current = current[0]
      } else {
        return undefined
      }
    } else {
      current = current[part]
    }
  }
  return current
}

function substituteVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

function substituteVarsInBody(body: any, vars: Record<string, string>): any {
  if (typeof body === 'string') return substituteVars(body, vars)
  if (Array.isArray(body)) return body.map(item => substituteVarsInBody(item, vars))
  if (body && typeof body === 'object') {
    const result: any = {}
    for (const key of Object.keys(body)) {
      result[key] = substituteVarsInBody(body[key], vars)
    }
    return result
  }
  return body
}

function tryParseInjectedJson(value: string): any {
  const trimmed = value.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
}

function parseBodyTemplate(value: string): any {
  const trimmed = value.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
}

function expandInjectedJsonValues(body: any): any {
  if (typeof body === 'string') return tryParseInjectedJson(body)
  if (Array.isArray(body)) return body.map(item => expandInjectedJsonValues(item))
  if (body && typeof body === 'object') {
    const result: any = {}
    for (const key of Object.keys(body)) {
      result[key] = expandInjectedJsonValues(body[key])
    }
    return result
  }
  return body
}

function resolveSize(size: string | null | undefined, config: ImageAdapterConfig): string {
  const strategy = config.size?.strategy ?? 'passthrough'
  const defaultSize = config.size?.default ?? size ?? '1024x1024'

  if (strategy === 'passthrough') {
    return size || defaultSize
  }

  if (strategy === 'aspectRatio') {
    return sizeToMiniMaxAspectRatio(size)
  }

  if (strategy === 'widthHeight') {
    return size || defaultSize
  }

  if (strategy === 'map') {
    const map = config.size?.map
    if (map && size && map[size]) return map[size]
    if (map && map[defaultSize]) return map[defaultSize]
    return size || defaultSize
  }

  return size || defaultSize
}

function isValidAdapterConfig(adapter: unknown): adapter is ImageAdapterConfig {
  if (!adapter || typeof adapter !== 'object') return false
  const a = adapter as Record<string, unknown>
  if (!a.request || typeof a.request !== 'object') return false
  const req = a.request as Record<string, unknown>
  return typeof req.url === 'string' && req.url.trim().length > 0
}

function buildSubjectReferenceJson(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    const refs = JSON.parse(raw)
    if (!Array.isArray(refs) || refs.length === 0) return ''
    return JSON.stringify(
      refs.slice(0, 1).map((imageFile: string) => ({
        type: 'character',
        image_file: imageFile,
      })),
    )
  } catch {
    return ''
  }
}

function stripEmptySubjectReference(body: any): any {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const out: any = {}
    for (const [key, value] of Object.entries(body)) {
      if (key === 'subject_reference' && (value === '' || value == null)) continue
      out[key] = value
    }
    return out
  }
  return body
}

function getAdapterConfig(config: AIConfig): ImageAdapterConfig | null {
  if (!config.settings) return null
  const settings = typeof config.settings === 'string' ? JSON.parse(config.settings) : config.settings
  const adapter = settings?.adapter
  return isValidAdapterConfig(adapter) ? adapter : null
}

export class ConfigurableImageAdapter implements ImageProviderAdapter {
  provider = 'configurable'
  private adapter: ImageAdapterConfig

  constructor(adapter: ImageAdapterConfig) {
    this.adapter = adapter
  }

  static fromConfig(config: AIConfig): ConfigurableImageAdapter | null {
    const adapter = getAdapterConfig(config)
    return adapter ? new ConfigurableImageAdapter(adapter) : null
  }

  private buildVars(config: AIConfig, record: Partial<ImageGenerationRecord>, extra: Record<string, string> = {}): Record<string, string> {
    const size = resolveSize(record.size ?? null, this.adapter)
    const [width, height] = size.split('x')

    return {
      baseUrl: config.baseUrl || '',
      apiKey: config.apiKey || '',
      model: record.model || config.model || '',
      prompt: normalizePrompt(record.prompt, this.provider),
      size,
      aspectRatio: sizeToMiniMaxAspectRatio(size),
      width: width || '',
      height: height || '',
      n: '1',
      seed: record.seed != null ? String(record.seed) : '',
      referenceImages: record.referenceImages || '',
      subjectReference: buildSubjectReferenceJson(record.referenceImages),
      ...extra,
    }
  }

  private renderHeaders(headersConfig: Record<string, string> | undefined, vars: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {}
    if (headersConfig) {
      for (const [key, value] of Object.entries(headersConfig)) {
        headers[key] = substituteVars(value, vars)
      }
    }
    return headers
  }

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const adapter = this.adapter
    if (!adapter.request) throw new Error('ConfigurableImageAdapter requires settings.adapter.request')

    const vars = this.buildVars(config, record)
    const rawUrl = substituteVars(adapter.request.url, vars)
    const url = rawUrl.startsWith('http') ? rawUrl : joinProviderUrl(config.baseUrl, '', rawUrl)

    const headers = this.renderHeaders(adapter.request.headers, vars)
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json'
    }
    if (config.apiKey && !headers['Authorization'] && !headers['authorization']) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    let body = substituteVarsInBody(adapter.request.body, vars)
    if (typeof body === 'string') {
      body = parseBodyTemplate(body)
    }
    body = expandInjectedJsonValues(body)
    body = stripEmptySubjectReference(body)

    return {
      url,
      method: adapter.request.method || 'POST',
      headers,
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const adapter = this.adapter

    if (adapter.response.errorPath) {
      const error = getPath(result, adapter.response.errorPath)
      if (error) throw new Error(String(error))
    }

    const isAsync = adapter.response.asyncWhenPath
      ? Boolean(getPath(result, adapter.response.asyncWhenPath))
      : adapter.response.async === true

    if (isAsync) {
      const taskId = adapter.response.taskIdPath ? getPath(result, adapter.response.taskIdPath) : undefined
      if (!taskId) throw new Error('Async response configured but no taskId found')
      return { isAsync: true, taskId: String(taskId) }
    }

    const imageUrl = this.extractImageUrl(result)
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }

    const b64 = this.extractImageBase64(result)
    if (b64) {
      return { isAsync: false, imageUrl: undefined }
    }

    throw new Error('No image URL or base64 data in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const adapter = this.adapter
    if (!adapter.poll) throw new Error('ConfigurableImageAdapter poll not configured')

    const vars = this.buildVars(config, {}, { taskId })
    const rawUrl = substituteVars(adapter.poll.request.url, vars)
    const url = rawUrl.startsWith('http') ? rawUrl : joinProviderUrl(config.baseUrl, '', rawUrl)

    const headers = this.renderHeaders(adapter.poll.request.headers, vars)
    if (!headers['Authorization'] && !headers['authorization'] && config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    const body = adapter.poll.request.body ? substituteVarsInBody(adapter.poll.request.body, vars) : undefined

    return {
      url,
      method: adapter.poll.request.method || 'GET',
      headers,
      body,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const adapter = this.adapter
    if (!adapter.poll) {
      return { status: 'processing' }
    }

    const status = getPath(result, adapter.poll.response.statusPath)
    const statusStr = status != null ? String(status) : ''
    const completedValues = adapter.poll.response.completedValues
    const failedValues = adapter.poll.response.failedValues || []

    if (completedValues.includes(statusStr)) {
      const imageUrl = adapter.poll.response.imageUrlPath
        ? getPath(result, adapter.poll.response.imageUrlPath)
        : null
      return { status: 'completed', imageUrl: imageUrl ? String(imageUrl) : undefined }
    }

    if (failedValues.includes(statusStr)) {
      const error = adapter.poll.response.errorPath
        ? getPath(result, adapter.poll.response.errorPath)
        : 'Generation failed'
      return { status: 'failed', error: error ? String(error) : 'Generation failed' }
    }

    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    const path = this.adapter.response.imageUrlPath
    if (!path) return null
    const val = getPath(result, path)
    return val != null ? String(val) : null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const path = this.adapter.response.base64Path
    if (!path) return null
    const val = getPath(result, path)
    if (val == null) return null
    const mimeTypePath = this.adapter.response.mimeTypePath
    const mimeType = mimeTypePath ? getPath(result, mimeTypePath) : 'image/png'
    return { data: String(val), mimeType: mimeType ? String(mimeType) : 'image/png' }
  }
}
