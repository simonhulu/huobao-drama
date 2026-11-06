/**
 * AI 音色管理
 * GET  /api/v1/ai-voices          - 获取音色列表
 * POST /api/v1/ai-voices/sync     - 从 MiniMax 同步音色
 * POST /api/v1/ai-voices/design   - 使用 MiniMax Voice Design 生成音色
 */
import { Hono } from 'hono'
import { and, eq, notInArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { generateVoicePreview } from '../services/voice-preview.js'
import { getAudioConfigById, getNarrationAudioConfig } from '../services/ai.js'
import { DEFAULT_NARRATION_VOICE_ID } from '../services/narration-defaults.js'
import { QWEN_TTS_DEFAULT_VOICE, QWEN_TTS_MODEL, QWEN_TTS_PROVIDER } from '../services/adapters/qwen-tts.js'
import { listQwenVoices } from '../services/qwen-tts-voices.js'

type MiniMaxVoiceType = 'system' | 'voice_generation' | 'voice_cloning'

const bundledSystemVoices = [
  {
    voiceId: 'Chinese_deep_voiced_male_nv1',
    voiceName: '深沉男声（Deep-voiced Male）',
    description: ['低沉、厚重、成熟', '适合历史旁白、纪实讲述和稳重男性角色'],
  },
  {
    voiceId: 'Chinese_gravelly_storyteller_nv1',
    voiceName: '沙哑故事讲述者（Gravelly Storyteller）',
    description: ['沙哑、沧桑、讲述感强', '适合历史故事、悬疑叙事和粗粝男性角色'],
  },
] as const

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

// Query the selected account directly. Local saved voices can belong to a
// different account or be expired, and the legacy sync filters system voices.
app.get('/available', async (c) => {
  const configId = Number(c.req.query('config_id'))
  if (!Number.isSafeInteger(configId) || configId <= 0) return badRequest(c, '请选择音频配置')
  const config = findVoiceConfig(configId)
  if (!config) return badRequest(c, '音频配置不存在、未启用或不支持云端音色查询')
  try {
    const { voices, counts } = await fetchAvailableVoices(config)
    const narration = getNarrationAudioConfig()
    const configuredVoice = narration?.settings?.narrationVoiceId
    const defaultVoice = config.provider?.toLowerCase() === QWEN_TTS_PROVIDER
      ? voices.some(voice => voice.voice_id === configuredVoice) ? configuredVoice : QWEN_TTS_DEFAULT_VOICE
      : configuredVoice || DEFAULT_NARRATION_VOICE_ID
    return success(c, {
      voices, counts, config_id: config.id, fetched_at: now(),
      default_restart_required: process.env.VOICE_DEFAULT_RESTART_REQUIRED === '1',
      default_voice_id: narration?.id === config.id ? defaultVoice : null,
    })
  } catch (error) {
    return badRequest(c, safeVoiceError(error, config.apiKey))
  }
})

// This changes future narration only; existing masters and episodes stay put.
app.post('/default', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const configId = Number(body.config_id), voiceId = String(body.voice_id || '').trim()
  if (!Number.isSafeInteger(configId) || configId <= 0 || !voiceId) return badRequest(c, '请选择音频配置和音色')
  const config = findVoiceConfig(configId)
  if (!config) return badRequest(c, '音频配置不存在、未启用或不支持云端音色查询')
  try {
    const { voices } = await fetchAvailableVoices(config)
    if (!voices.some(voice => voice.voice_id === voiceId)) return badRequest(c, '该音色不在当前账号可用列表中，请刷新后重试')
    db.transaction(tx => {
      // Read fresh settings after the network call so unrelated edits survive.
      const rows = tx.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, 'audio')).all()
      const current = rows.find(row => row.id === config.id)
      if (!current?.isActive || current.apiKey !== config.apiKey || current.baseUrl !== config.baseUrl
        || current.provider?.toLowerCase() !== config.provider?.toLowerCase()
        || current.model !== config.model) throw Error('音频配置已变化，请刷新音色库后重试')
      for (const row of rows) {
        const settings = row.settings ? JSON.parse(row.settings) : {}
        if (row.id !== config.id && !settings.useForNarration) continue
        tx.update(schema.aiServiceConfigs).set({
          settings: JSON.stringify({ ...settings, useForNarration: row.id === config.id,
            ...(row.id === config.id ? { narrationVoiceId: voiceId } : {}) }),
          updatedAt: now(),
        }).where(eq(schema.aiServiceConfigs.id, row.id)).run()
      }
    }, { behavior: 'immediate' })
    return success(c, { voice_id: voiceId, config_id: config.id,
      default_restart_required: process.env.VOICE_DEFAULT_RESTART_REQUIRED === '1' })
  } catch (error) {
    return badRequest(c, safeVoiceError(error, config.apiKey))
  }
})

// POST /ai-voices/preview - 生成一段短试听音频
app.post('/preview', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const voiceId = String(body.voice_id || '').trim()
  if (!voiceId) return badRequest(c, 'voice_id is required')

  const text = String(body.text || '这是一段音色试听。声音清晰，节奏自然，适合历史故事与人物讲述。').trim().slice(0, 200)
  if (!text) return badRequest(c, 'text is required')
  const configId = body.config_id == null ? undefined : Number(body.config_id)
  if (configId !== undefined && (!Number.isSafeInteger(configId) || configId <= 0
      || !db.select().from(schema.aiServiceConfigs).where(and(eq(schema.aiServiceConfigs.id, configId),
        eq(schema.aiServiceConfigs.serviceType, 'audio'), eq(schema.aiServiceConfigs.isActive, true))).get())) {
    return badRequest(c, '所选音频配置不存在或未启用，请重新选择音频配置')
  }

  let apiKey = ''
  try {
    apiKey = getAudioConfigById(configId).apiKey
    const result = await generateVoicePreview({
      text,
      voice: voiceId,
      configId,
    })
    return success(c, { audio_url: result, voice_id: voiceId })
  } catch (error) {
    return badRequest(c, safeVoiceError(error, apiKey) || '音色试听生成失败')
  }
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
    notInArray(schema.aiVoices.voiceId, bundledSystemVoices.map(voice => voice.voiceId)),
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

function findVoiceConfig(configId: number) {
  const row = db.select().from(schema.aiServiceConfigs).where(and(
    eq(schema.aiServiceConfigs.id, configId), eq(schema.aiServiceConfigs.serviceType, 'audio'),
    eq(schema.aiServiceConfigs.isActive, true),
  )).get()
  return row && ['minimax', QWEN_TTS_PROVIDER].includes(row.provider?.toLowerCase() || '') ? row : null
}

function safeVoiceError(error: unknown, apiKey: string) {
  const message = error instanceof Error ? error.message : String(error)
  return apiKey ? message.split(apiKey).join('***') : message
}

async function fetchAvailableVoices(config: typeof schema.aiServiceConfigs.$inferSelect) {
  if (config.provider?.toLowerCase() === QWEN_TTS_PROVIDER) return fetchAvailableQwenVoices(config)
  if (!config.apiKey) throw Error('MiniMax API key 未配置')
  // Keep custom gateways intact; these two hosts are official aliases.
  const base = /^https:\/\/api\.(?:minimaxi\.com|minimax\.cn)\/?$/.test(config.baseUrl)
    ? 'https://api.minimax.cn' : config.baseUrl
  const response = await fetch(joinProviderUrl(base, '/v1', '/get_voice'), {
    method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_type: 'all' }), signal: AbortSignal.timeout(60_000),
  })
  const result = await response.json().catch(() => ({})) as any
  if (!response.ok || result.base_resp?.status_code !== 0) {
    throw Error(`MiniMax 音色查询失败（${result.base_resp?.status_code ?? response.status}）：${result.base_resp?.status_msg || '请稍后重试'}`)
  }
  const saved = db.select().from(schema.aiVoices).where(eq(schema.aiVoices.provider, 'minimax')).all()
  const local = new Map(saved.map(row => [row.voiceId, row]))
  const counts: Record<MiniMaxVoiceType, number> = { system: 0, voice_generation: 0, voice_cloning: 0 }
  const seen = new Set<string>()
  const voices = (['system', 'voice_generation', 'voice_cloning'] as const).flatMap(type =>
    asArray(result[type === 'system' ? 'system_voice' : type]).flatMap((voice: any) => {
      const id = String(voice?.voice_id || '').trim()
      if (!id || seen.has(id)) return []
      seen.add(id); counts[type]++
      const previous = local.get(id)
      const name = String(voice.voice_name || previous?.voiceName || id)
      const description = parseDescription(voice.description)
      const language = extractLanguage(id, name)
      return [{ voice_id: id, voice_name: name,
        description: description.length ? description : parseDescription(previous?.description),
        language: language === '其他' && (/^(male-qn-|female-)/.test(id) || previous?.language === '中文'
          || description.some(text => /普通话|中文|北方口音|南方口音/.test(text))) ? '中文' : language,
        provider: 'minimax', voice_type: type,
      }]
    }))
  return { voices, counts }
}

async function fetchAvailableQwenVoices(config: typeof schema.aiServiceConfigs.$inferSelect) {
  const models = JSON.parse(config.model || '[]')
  const custom = await listQwenVoices({ provider: QWEN_TTS_PROVIDER, baseUrl: config.baseUrl,
    apiKey: config.apiKey, model: (Array.isArray(models) ? models[0] : models) || QWEN_TTS_MODEL })
  const saved = db.select().from(schema.aiVoices).where(eq(schema.aiVoices.provider, QWEN_TTS_PROVIDER)).all()
  const local = new Map(saved.map(row => [row.voiceId, row]))
  const voices = [{ voice_id: QWEN_TTS_DEFAULT_VOICE, voice_name: QWEN_TTS_DEFAULT_VOICE,
    description: [] as string[], language: '中文', provider: QWEN_TTS_PROVIDER, voice_type: 'system' as MiniMaxVoiceType },
  ...custom.map(voice => {
    const previous = local.get(voice.voice_id)
    return { voice_id: voice.voice_id, voice_name: previous?.voiceName || `复刻音色 ${voice.voice_id.slice(-8)}`,
      description: parseDescription(previous?.description), language: previous?.language || '中文', provider: QWEN_TTS_PROVIDER,
      voice_type: previous?.voiceType === 'voice_generation' ? 'voice_generation' as const : 'voice_cloning' as const }
  })]
  const counts: Record<MiniMaxVoiceType, number> = { system: 1, voice_generation: 0, voice_cloning: 0 }
  for (const voice of voices.slice(1)) counts[voice.voice_type]++
  return { voices, counts }
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
