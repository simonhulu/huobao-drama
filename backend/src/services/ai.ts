/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'
import { getAIProviderAdmission, getTextAdmissionOptions } from './ai-provider-admission.js'

export type ServiceType = 'text' | 'image' | 'video' | 'audio' | 'music'

export interface AIConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  settings?: string | Record<string, any> | null
}

export function parseAIConfigModels(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function getTextProviderBaseUrl(config: AIConfig) {
  const provider = config.provider.toLowerCase()

  if (provider === 'openai' || provider === 'openrouter' || provider === 'chatfire') {
    return joinProviderUrl(config.baseUrl, '/v1', '')
  }

  if (provider === 'volcengine') {
    return joinProviderUrl(config.baseUrl, '/api/v3', '')
  }

  if (provider === 'ali') {
    return joinProviderUrl(config.baseUrl, '/api/v1', '')
  }

  return config.baseUrl
}

export function getActiveConfig(serviceType: ServiceType, provider?: string): AIConfig | null {
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, serviceType))
    .all()
    .filter(r => r.isActive && (!provider || r.provider?.trim().toLowerCase() === provider.trim().toLowerCase() && Boolean(r.apiKey?.trim())))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)) // 高优先级优先

  const active = rows[0]
  if (!active) {
    logTaskWarn('AIConfig', 'active-config-missing', { serviceType })
    return null
  }

  const models = parseAIConfigModels(active.model)
  logTaskProgress('AIConfig', 'active-config-selected', {
    serviceType,
    configId: active.id,
    provider: active.provider,
    model: models[0] || '',
    priority: active.priority,
  })
  return {
    provider: active.provider || '',
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: models[0] || '',
    settings: active.settings ?? undefined,
  }
}

export function getTextConfig(): AIConfig {
  const config = getActiveConfig('text')
  if (!config) throw new Error('No active text AI config')
  return config
}

export function getAudioConfig(): AIConfig {
  const config = getActiveConfig('audio')
  if (!config) throw new Error('No active audio AI config — 请在设置中添加音频服务')
  return config
}

export function getMusicConfig(): AIConfig {
  const config = getActiveConfig('music')
  if (config) return config

  // 未配置 music 服务时，如果已配置 MiniMax 音频服务，则回退并默认使用 music-2.6 模型
  const audioConfig = getActiveConfig('audio')
  if (audioConfig && audioConfig.provider.toLowerCase() === 'minimax') {
    return {
      ...audioConfig,
      model: 'music-2.6',
    }
  }

  throw new Error('No active music AI config — 请在设置中添加音乐服务，或配置 MiniMax 音频服务')
}

export function getAudioConfigById(id?: number | null): AIConfig {
  if (id) {
    const config = getConfigById(id)
    if (config) return config
  }
  return getAudioConfig()
}

export function getConfigById(id: number): AIConfig | null {
  const [row] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!row || !row.isActive) {
    logTaskWarn('AIConfig', 'config-by-id-missing', { configId: id })
    return null
  }
  const models = parseAIConfigModels(row.model)
  logTaskProgress('AIConfig', 'config-by-id-selected', {
    configId: id,
    provider: row.provider,
    model: models[0] || '',
    serviceType: row.serviceType,
  })
  return {
    provider: row.provider || '',
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model: models[0] || '',
    settings: row.settings ?? undefined,
  }
}

function parseConfigSettings(settings?: string | Record<string, any> | null): Record<string, any> | null {
  if (!settings) return null
  if (typeof settings === 'string') {
    try {
      return JSON.parse(settings)
    } catch {
      return null
    }
  }
  return settings
}

/** Extra text request settings used by the opening storyboard service. */
export function getTextRequestExtras(config: AIConfig): Record<string, any> {
  const settings = parseConfigSettings(config.settings)
  if (!settings) return {}
  const effort = settings.reasoning_effort ?? settings.reasoningEffort
  return typeof effort === 'string' && effort.trim() ? { reasoning_effort: effort.trim() } : {}
}

export interface AIConfigWithId extends AIConfig {
  id: number
  settings?: Record<string, any> | null
}

/**
 * 获取旁白（解说）专用音频配置。
 * 查找 active audio 配置中 settings.useForNarration === true 的配置。
 */
export function getNarrationAudioConfig(): AIConfigWithId | null {
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'audio'))
    .all()
    .filter(r => r.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))

  for (const row of rows) {
    const settings = parseConfigSettings(row.settings)
    if (settings?.useForNarration) {
      const models = row.model ? JSON.parse(row.model) : []
      return {
        id: row.id,
        provider: row.provider || '',
        baseUrl: row.baseUrl,
        apiKey: row.apiKey,
        model: models[0] || '',
        settings,
      }
    }
  }

  return null
}

export class TextModelHttpError extends Error {
  constructor(readonly status: number, body: string, readonly retryAfterMs?: number) {
    super(`Text model request failed: ${status} ${body}`)
    this.name = 'TextModelHttpError'
  }
}

export interface TextModelTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, any>
    strict?: boolean
  }
}

export type TextModelToolChoice = 'auto' | 'none' | 'required' | {
  type: 'function'
  function: { name: string }
}

export async function callTextModel(
  messages: Array<{ role: string; content: string }>,
  options?: { temperature?: number; maxTokens?: number; responseFormat?: { type: string }; tools?: TextModelTool[]; toolChoice?: TextModelToolChoice; extraBody?: Record<string, any>; signal?: AbortSignal; requireComplete?: boolean },
): Promise<string> {
  const config = getTextConfig()
  const baseUrl = getTextProviderBaseUrl(config)
  const body: Record<string, any> = {
    model: config.model,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens,
    messages,
    ...options?.extraBody,
  }
  if (options?.responseFormat) {
    body.response_format = options.responseFormat
  }
  if (options?.tools?.length) {
    body.tools = options.tools
    body.tool_choice = options.toolChoice ?? 'required'
    body.parallel_tool_calls = false
    delete body.response_format
  }
  const endpoint = `${baseUrl}/chat/completions`
  return getAIProviderAdmission().run({ endpoint, apiKey: config.apiKey }, async lease => {
    options?.signal?.throwIfAborted()
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after')?.trim()
      const seconds = retryAfter ? Number(retryAfter) : NaN
      const retryAfterMs = Number.isFinite(seconds) ? seconds >= 0 ? seconds * 1000 : NaN
        : retryAfter ? Math.max(0, Date.parse(retryAfter) - Date.now()) : NaN
      if (res.status === 429) {
        try { await lease.defer(Number.isFinite(retryAfterMs) ? retryAfterMs : undefined) }
        catch { console.warn('[ai-admission] provider cooldown could not be persisted') }
      }
      const text = await res.text()
      throw new TextModelHttpError(res.status, text, Number.isFinite(retryAfterMs) ? retryAfterMs : undefined)
    }
    const data = await res.json()
    const choice = data.choices?.[0]
    const finishReason = choice?.finish_reason
    if (options?.tools?.length ? finishReason !== 'tool_calls' : options?.requireComplete && finishReason !== 'stop') {
      throw new Error('Text model response did not complete normally; refusing a truncated or incomplete draft')
    }
    if (options?.tools?.length) {
      const toolCalls = choice?.message?.tool_calls
      const expectedName = options.toolChoice && typeof options.toolChoice === 'object'
        ? options.toolChoice.function.name : options.tools[0]?.function.name
      if (!Array.isArray(toolCalls) || toolCalls.length !== 1 || toolCalls[0]?.type !== 'function'
        || toolCalls[0]?.function?.name !== expectedName || typeof toolCalls[0]?.function?.arguments !== 'string'
        || !toolCalls[0].function.arguments.trim()) {
        throw new Error(`模型未返回指定工具 ${expectedName || 'function'} 的完整调用，已拒绝使用普通文本代替`)
      }
      return toolCalls[0].function.arguments.trim()
    }
    const content = choice?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Text model returned no content')
    }
    return content.trim()
  }, { ...getTextAdmissionOptions(config.settings), signal: options?.signal })
}
