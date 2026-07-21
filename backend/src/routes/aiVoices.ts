/**
 * AI 音色管理
 * GET  /api/v1/ai-voices          - 获取音色列表
 * POST /api/v1/ai-voices/sync     - 从 MiniMax 同步音色
 * POST /api/v1/ai-voices/design   - 使用 MiniMax Voice Design 生成音色
 */
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { joinProviderUrl } from '../services/adapters/url.js'

type MiniMaxVoiceType = 'system' | 'voice_generation' | 'voice_cloning'

const app = new Hono()

// GET /ai-voices?provider=minimax
app.get('/', async (c) => {
  const provider = c.req.query('provider') || 'minimax'
  const rows = db.select().from(schema.aiVoices)
    .where(eq(schema.aiVoices.provider, provider))
    .all()

  const parsed = rows.map(r => ({
    voice_id: r.voiceId,
    voice_name: r.voiceName,
    description: parseDescription(r.description),
    language: r.language,
    provider: r.provider,
    voice_type: r.voiceType || 'system',
    created_at: r.createdAt,
  }))

  return success(c, parsed)
})

// POST /ai-voices/design
app.post('/design', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const prompt = String(body.prompt || '').trim()
  const previewText = String(body.preview_text || '').trim()

  if (!prompt) return badRequest(c, 'prompt is required')
  if (!previewText) return badRequest(c, 'preview_text is required')
  if (previewText.length > 500) return badRequest(c, 'preview_text must be 500 characters or fewer')

  const configId = body.config_id == null ? undefined : Number(body.config_id)
  if (configId !== undefined && !Number.isInteger(configId)) {
    return badRequest(c, 'config_id must be an integer')
  }

  const config = findMiniMaxConfig(configId)
  if (!config) return badRequest(c, configId !== undefined ? 'MiniMax 音频配置不存在或未启用' : 'No active minimax audio config found')
  if (!config.apiKey) return badRequest(c, 'MiniMax API key not configured')

  const requestedVoiceId = String(body.voice_id || '').trim()
  const voiceName = String(body.voice_name || '历史纪实男声').trim().slice(0, 80) || '历史纪实男声'
  const requestBody: Record<string, unknown> = {
    prompt,
    preview_text: previewText,
    aigc_watermark: body.aigc_watermark === true,
  }
  if (requestedVoiceId) requestBody.voice_id = requestedVoiceId

  let result: any
  try {
    const resp = await fetch(joinProviderUrl(config.baseUrl, '/v1', '/voice_design'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(120_000),
    })

    result = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return badRequest(c, result.base_resp?.status_msg || `MiniMax API error: ${resp.status}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return badRequest(c, `MiniMax Voice Design 请求失败: ${message}`)
  }

  if (result.base_resp?.status_code !== 0) {
    return badRequest(c, result.base_resp?.status_msg || 'MiniMax Voice Design failed')
  }

  const voiceId = String(result.voice_id || '').trim()
  if (!voiceId) return badRequest(c, 'MiniMax Voice Design response missing voice_id')

  const ts = now()
  db.insert(schema.aiVoices).values({
    voiceId,
    voiceName,
    description: JSON.stringify([prompt]),
    language: '中文',
    provider: 'minimax',
    voiceType: 'voice_generation',
    createdAt: ts,
  }).onConflictDoUpdate({
    target: schema.aiVoices.voiceId,
    set: {
      voiceName,
      description: JSON.stringify([prompt]),
      language: '中文',
      provider: 'minimax',
      voiceType: 'voice_generation',
    },
  }).run()

  return success(c, {
    voice_id: voiceId,
    voice_name: voiceName,
    voice_type: 'voice_generation',
    language: '中文',
    preview_text: previewText,
    trial_audio_url: hexAudioToDataUrl(result.trial_audio),
  })
})

// POST /ai-voices/sync
app.post('/sync', async (c) => {
  // 从数据库获取 minimax 的音频配置
  const config = findMiniMaxConfig()
  if (!config) return badRequest(c, 'No active minimax audio config found')
  if (!config.apiKey) return badRequest(c, 'MiniMax API key not configured')

  let result: any
  try {
    const resp = await fetch(joinProviderUrl(config.baseUrl, '/v1', '/get_voice'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ voice_type: 'all' }),
      signal: AbortSignal.timeout(60_000),
    })

    result = await resp.json().catch(() => ({}))
    if (!resp.ok) return badRequest(c, `MiniMax API error: ${resp.status}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return badRequest(c, `MiniMax 音色同步请求失败: ${message}`)
  }

  if (result.base_resp?.status_code !== 0) {
    return badRequest(c, result.base_resp?.status_msg || 'Failed to fetch voices')
  }

  const incoming: Array<{ voice: any; voiceType: MiniMaxVoiceType }> = [
    ...(asArray(result.system_voice).filter((voice: any) => shouldKeepVoice(voice)).map((voice: any) => ({ voice, voiceType: 'system' as const }))),
    ...(asArray(result.voice_generation).map((voice: any) => ({ voice, voiceType: 'voice_generation' as const }))),
    ...(asArray(result.voice_cloning).map((voice: any) => ({ voice, voiceType: 'voice_cloning' as const }))),
  ]
  const existingRows = db.select().from(schema.aiVoices)
    .where(eq(schema.aiVoices.provider, 'minimax'))
    .all()
  const existingById = new Map(existingRows.map(row => [row.voiceId, row]))

  // 系统音色是远端完整列表，允许刷新；生成/复刻音色保留本地记录，避免 API 暂时不返回时丢失可用音色。
  db.delete(schema.aiVoices).where(and(
    eq(schema.aiVoices.provider, 'minimax'),
    eq(schema.aiVoices.voiceType, 'system'),
  )).run()

  const ts = now()
  let count = 0
  const counts: Record<MiniMaxVoiceType, number> = {
    system: 0,
    voice_generation: 0,
    voice_cloning: 0,
  }

  for (const item of incoming) {
    const voiceId = String(item.voice?.voice_id || '').trim()
    if (!voiceId) continue

    const existing = existingById.get(voiceId)
    const voiceName = item.voiceType === 'system'
      ? String(item.voice?.voice_name || existing?.voiceName || voiceId)
      : (existing?.voiceName || `${item.voiceType === 'voice_generation' ? '生成' : '复刻'}音色 ${voiceId.slice(-8)}`)
    const description = parseDescription(item.voice?.description)
    const language = item.voiceType === 'system'
      ? extractLanguage(voiceId, voiceName)
      : '中文'

    db.insert(schema.aiVoices).values({
      voiceId,
      voiceName,
      description: JSON.stringify(description),
      language,
      provider: 'minimax',
      voiceType: item.voiceType,
      createdAt: existing?.createdAt || ts,
    }).onConflictDoUpdate({
      target: schema.aiVoices.voiceId,
      set: {
        voiceName,
        description: JSON.stringify(description),
        language,
        provider: 'minimax',
        voiceType: item.voiceType,
      },
    }).run()
    count++
    counts[item.voiceType]++
  }

  return success(c, {
    count,
    counts,
    message: `Synced ${count} voices`,
  })
})

function findMiniMaxConfig(configId?: number): typeof schema.aiServiceConfigs.$inferSelect | null {
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'audio'))
    .all()
    .filter(row => row.provider?.toLowerCase() === 'minimax')

  if (configId !== undefined) {
    return rows.find(row => row.id === configId && row.isActive) || null
  }

  return rows
    .filter(row => row.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0] || null
}

function parseDescription(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string') as string[]
  if (typeof value === 'string') {
    try {
      return parseDescription(JSON.parse(value))
    } catch {
      return value ? [value] : []
    }
  }
  return []
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

/** 将 MiniMax 的 hex 试听音频转成浏览器可直接播放的 data URL。 */
function hexAudioToDataUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim()
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null
  return `data:audio/mpeg;base64,${Buffer.from(hex, 'hex').toString('base64')}`
}

function containsChinese(text: string) {
  return /[\u4e00-\u9fa5]/.test(text)
}

function shouldKeepVoice(voice: { voice_id?: string; voice_name?: string }) {
  const voiceId = String(voice.voice_id || '')
  const voiceName = String(voice.voice_name || '')
  const language = extractLanguage(voiceId, voiceName)
  if (language !== '中文' && language !== '粤语' && !containsChinese(voiceName)) return false

  const text = `${voiceId} ${voiceName}`.toLowerCase()
  const excludedPatterns = [
    'jingpin',
    '-beta',
    'cartoon_pig',
    'cute_boy',
    'lovely_girl',
    'clever_boy',
    'robot_armor',
    'news_anchor',
    'male_announcer',
    'radio_host',
    'hk_flight_attendant',
  ]

  return !excludedPatterns.some(pattern => text.includes(pattern))
}

/**
 * 从 voice_id 或 voice_name 推断语言。
 */
function extractLanguage(voiceId: string, voiceName: string): string {
  const text = `${voiceId} ${voiceName}`.toLowerCase()
  if (text.includes('cantonese') || text.includes('粤')) return '粤语'
  if (text.includes('english') || text.includes('aussie')) return '英语'
  if (text.includes('japanese') || text.includes('日语')) return '日语'
  if (text.includes('korean') || text.includes('韩')) return '韩语'
  if (text.includes('spanish')) return '西班牙语'
  if (text.includes('portuguese')) return '葡萄牙语'
  if (text.includes('french')) return '法语'
  if (text.includes('indonesian')) return '印尼语'
  if (text.includes('german')) return '德语'
  if (text.includes('russian')) return '俄语'
  if (text.includes('italian')) return '意大利语'
  if (text.includes('arabic')) return '阿拉伯语'
  if (text.includes('turkish')) return '土耳其语'
  if (text.includes('ukrainian')) return '乌克兰语'
  if (text.includes('dutch')) return '荷兰语'
  if (text.includes('vietnamese')) return '越南语'
  if (text.includes('chinese') || text.includes('mandarin') || text.includes('中文')) return '中文'
  return '其他'
}

export default app
