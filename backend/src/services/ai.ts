/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'

export type ServiceType = 'text' | 'image' | 'video' | 'audio' | 'music'

export interface AIConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  settings?: string | Record<string, any> | null
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

export function getActiveConfig(serviceType: ServiceType): AIConfig | null {
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, serviceType))
    .all()
    .filter(r => r.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)) // 高优先级优先

  const active = rows[0]
  if (!active) {
    logTaskWarn('AIConfig', 'active-config-missing', { serviceType })
    return null
  }

  const models = active.model ? JSON.parse(active.model) : []
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
  const models = row.model ? JSON.parse(row.model) : []
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

export async function callTextModel(messages: Array<{ role: string; content: string }>, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
  const config = getTextConfig()
  const baseUrl = getTextProviderBaseUrl(config)
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
      messages,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Text model request failed: ${res.status} ${text}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('Text model returned no content')
  }
  return content.trim()
}
