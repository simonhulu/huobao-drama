// Restored from the 2026-08-11 Codex session 019feece-cdd5-7b42-b6c9-1f1ffccca924,
// call_TIt8u7t600STkfPC3IM3B1vk: original TypeScript readback (before source loss).
/**
 * Qwen3-TTS VoiceDesign 音色解析。
 *
 * Qwen3-TTS 的"音色"不是 voice id，而是一段中文描述（instruct）。
 * 映射规则：
 *   1. ai_voices 表里 provider='qwen3-tts' 且 voice_id 匹配的行，description 即 instruct
 *   2. 音频配置 settings.instruct（该配置的默认音色描述）
 *   3. 内置兜底 QWEN3_DEFAULT_INSTRUCT
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import * as schema from '../db/schema.js'
import type { AIConfig } from './adapters/types.js'
import { isQwen3TTSProvider } from './adapters/qwen3-tts.js'
import { DEFAULT_NARRATION_VOICE_ID } from './narration-defaults.js'
import { getNarrationAudioConfig } from './ai.js'
import { isQwenTTSProvider, isLegacyNarrationVoice, qwenTTSSettings, QWEN_TTS_DEFAULT_VOICE } from './adapters/qwen-tts.js'

export const QWEN3_DEFAULT_VOICE_ID = 'qwen3-north-tense-narrator'
export const QWEN3_DEFAULT_VOICE_NAME = '北方紧弦说书男声·快叙（本地）'

/** 兜底音色描述；正式音色以 ai_voices 表 qwen3-tts 行的 description 为准。 */
export const QWEN3_DEFAULT_INSTRUCT = (
  '一位40岁以上的北方男性短视频说书人，成熟、有阅历，讲述历史、悬疑和人物往事；'
  + '中低音厚实，带少量自然颗粒感，咬字清楚，不带播音腔；'
  + '语速明显偏快，起句快、推进快、短停顿，句与句之间有追赶感；'
  + '从第一句起就非常紧绷，像危险正在逼近，关键人物、数字和转折落重音；'
  + '紧、快、抓人、可信，不尖叫、不浮夸、不油腻、不像新闻播报员。'
)

function parseInstructFromSettings(settings: unknown): string | null {
  if (!settings) return null
  let obj: any = settings
  if (typeof settings === 'string') {
    try { obj = JSON.parse(settings) } catch { return null }
  }
  const instruct = obj?.instruct
  return typeof instruct === 'string' && instruct.trim() ? instruct.trim() : null
}

/**
 * ai_voices.description 的惯例是 JSON 数组字符串（MiniMax Voice Design 沿用下来的格式），
 * 兼容纯文本。
 */
function parseDescription(raw: string | null | undefined): string | null {
  const text = (raw || '').trim()
  if (!text) return null
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text)
      if (Array.isArray(arr)) {
        const joined = arr.map((s) => String(s).trim()).filter(Boolean).join('\n')
        return joined || null
      }
    } catch {
      // 落回纯文本
    }
  }
  return text
}

/**
 * 把调用方传入的 voice（可能是 MiniMax voice id、qwen3 voice id 或空）
 * 解析成 VoiceDesign 的 instruct 文本。
 */
export function resolveQwen3Instruct(voice: string | undefined | null, config: AIConfig): string {
  const voiceId = (voice || '').trim()
  if (voiceId) {
    try {
      const [row] = db.select().from(schema.aiVoices)
        .where(and(
          eq(schema.aiVoices.voiceId, voiceId),
          eq(schema.aiVoices.provider, 'qwen3-tts'),
        )).all()
      const desc = parseDescription(row?.description)
      if (desc) return desc
    } catch {
      // 查表失败走 settings/兜底
    }
  }
  return parseInstructFromSettings(config.settings) || QWEN3_DEFAULT_INSTRUCT
}

/** 按当前激活的旁白/音频配置，返回该 provider 体系下的默认旁白 voice id。 */
export function resolveDefaultNarrationVoiceId(provider?: string | null): string {
  if (isQwen3TTSProvider(provider)) return QWEN3_DEFAULT_VOICE_ID
  const config = getNarrationAudioConfig()
  const configuredVoice = config?.settings?.narrationVoiceId
  if (config && (!provider || config.provider.toLowerCase() === provider.toLowerCase())
    && typeof configuredVoice === 'string' && configuredVoice.trim()) return configuredVoice.trim()
  if (isQwenTTSProvider(provider)) return QWEN_TTS_DEFAULT_VOICE
  return DEFAULT_NARRATION_VOICE_ID
}

export function resolveNarrationVoiceForConfig(config: AIConfig, voice?: string | null): string {
  if (!isQwenTTSProvider(config.provider)) return voice?.trim() || resolveDefaultNarrationVoiceId(config.provider)
  const configured = qwenTTSSettings(config).narrationVoiceId
  const defaultVoice = typeof configured === 'string' && configured.trim() ? configured.trim() : QWEN_TTS_DEFAULT_VOICE
  const requested = voice?.trim()
  if (!requested || isLegacyNarrationVoice(requested)) return defaultVoice
  const saved = db.select().from(schema.aiVoices).where(eq(schema.aiVoices.voiceId, requested)).get()
  return saved && !isQwenTTSProvider(saved.provider) ? defaultVoice : requested
}
