import type { AIConfig, ProviderRequest, TTSProviderAdapter } from './types.js'

export const QWEN_TTS_PROVIDER = 'qwen-tts'
export const QWEN_TTS_MODEL = 'qwen-audio-3.1-tts-flash'
export const QWEN_TTS_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'
export const QWEN_TTS_DEFAULT_VOICE = 'longanhuan_v3.1'

export interface QwenTTSParams {
  text: string
  voice: string
  model?: string
  speed?: number
  emotion?: string
  instruction?: string
}

export function isQwenTTSProvider(provider?: string | null) {
  return provider?.toLowerCase() === QWEN_TTS_PROVIDER
}

export function qwenTTSBaseUrl(config: Pick<AIConfig, 'baseUrl'>) {
  return (config.baseUrl || process.env.QWEN_TTS_BASE_URL || QWEN_TTS_BASE_URL)
    .replace(/\/+$/, '').replace(/\/api\/v1$/, '') + '/api/v1'
}

export function qwenTTSSettings(config: AIConfig): Record<string, unknown> {
  if (typeof config.settings === 'string') {
    try { return JSON.parse(config.settings) || {} } catch { return {} }
  }
  return config.settings || {}
}

export function isLegacyNarrationVoice(voice: string) {
  return /^(?:ttv-|Chinese_|male-|female-|qwen3-)/i.test(voice)
}

export class QwenTTSAdapter implements TTSProviderAdapter {
  readonly provider = QWEN_TTS_PROVIDER

  buildGenerateRequest(config: AIConfig, params: QwenTTSParams): ProviderRequest {
    const model = params.model || config.model || QWEN_TTS_MODEL
    if (model !== QWEN_TTS_MODEL) throw new Error(`Qwen TTS model must be ${QWEN_TTS_MODEL}; cloned voices are model-specific`)
    if (!params.voice?.trim() || isLegacyNarrationVoice(params.voice)) throw new Error('Qwen TTS requires a compatible Aliyun voice; MiniMax/local voices cannot be reused')
    const rate = params.speed ?? 1
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Error('Qwen TTS rate must be between 0.5 and 2.0')
    const settings = qwenTTSSettings(config)
    const instruction = params.instruction || (typeof settings.instruction === 'string' ? settings.instruction : '')
    return {
      url: `${qwenTTSBaseUrl(config)}/services/audio/tts/SpeechSynthesizer`, method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey || process.env.QWEN_API_KEY || ''}`, 'Content-Type': 'application/json' },
      body: { model, input: {
        text: params.text, voice: params.voice, format: 'wav', sample_rate: 24000, rate,
        ...((instruction || params.emotion) ? { instruction: [instruction, params.emotion ? `情感：${params.emotion}` : ''].filter(Boolean).join('\n') } : {}),
      } },
    }
  }

  async parseResponse(result: any, _config: AIConfig, options: { signal?: AbortSignal } = {}) {
    if (result?.code) throw new Error(`Qwen TTS ${result.code}: ${result.message || 'synthesis failed'}`)
    if (result?.output?.finish_reason !== 'stop') throw new Error('Qwen TTS did not return a complete audio response')
    const url = result.output.audio?.url
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Qwen TTS response missing audio URL')
    const deadline = AbortSignal.timeout(120_000)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    signal.throwIfAborted()
    // The result URL is signed by OSS and must not receive the DashScope API key.
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`Qwen TTS audio download failed: ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    signal.throwIfAborted()
    if (!buffer.length) throw new Error('Qwen TTS returned empty audio')
    return { audioHex: buffer.toString('hex'), audioLength: 0, sampleRate: 24000, bitrate: 0,
      format: 'wav', channel: 1, titles: [], extra: { request_id: result.request_id, usage: result.usage } }
  }
}
