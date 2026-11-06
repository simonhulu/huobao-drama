import { setTimeout as delay } from 'node:timers/promises'
import type { AIConfig } from './adapters/types.js'
import { QWEN_TTS_MODEL, qwenTTSBaseUrl } from './adapters/qwen-tts.js'

export interface QwenVoiceOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

export interface CreateQwenVoiceParams {
  audio: string
  prefix: string
  languageHints?: string[]
  maxPromptAudioLength?: number
  enablePreprocess?: boolean
  enableVolumeNormalization?: boolean
}

export interface QwenVoiceDetails {
  status: string
  target_model: string
  resource_link?: string
  gmt_create?: string
  gmt_modified?: string
}

export interface QwenCustomVoice extends QwenVoiceDetails {
  voice_id: string
}

function targetModel(config: AIConfig) {
  return config.model?.trim() || QWEN_TTS_MODEL
}

async function customization(config: AIConfig, input: Record<string, unknown>, options: QwenVoiceOptions) {
  try {
    options.signal?.throwIfAborted()
    if (!config.apiKey) throw Error('Qwen API key 未配置')
    const timeout = AbortSignal.timeout(60_000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const response = await (options.fetchFn || fetch)(`${qwenTTSBaseUrl(config)}/services/audio/tts/customization`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'voice-enrollment', input }), signal,
    })
    const result = await response.json().catch(() => ({})) as Record<string, any>
    if (!response.ok || result.code) {
      throw Error(`Qwen 音色请求失败（${result.code || response.status}）：${result.message || '请稍后重试'}`)
    }
    if (!result.output || typeof result.output !== 'object') throw Error('Qwen 音色响应缺少 output')
    return result.output as Record<string, any>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw Error(config.apiKey ? message.split(config.apiKey).join('***') : message)
  }
}

export async function createQwenVoice(config: AIConfig, params: CreateQwenVoiceParams, options: QwenVoiceOptions = {}): Promise<string> {
  if (!/^[A-Za-z0-9]{1,10}$/.test(params.prefix)) throw Error('Qwen 音色 prefix 必须为 1 至 10 位字母或数字')
  if (!params.audio.trim()) throw Error('Qwen 音色 audio 不能为空')
  if (params.maxPromptAudioLength !== undefined && (!Number.isFinite(params.maxPromptAudioLength)
    || params.maxPromptAudioLength < 3 || params.maxPromptAudioLength > 30)) throw Error('Qwen maxPromptAudioLength 必须在 3 至 30 秒之间')
  const input: Record<string, unknown> = { action: 'create_voice', target_model: targetModel(config), prefix: params.prefix, audio: params.audio }
  if (params.languageHints) input.language_hints = params.languageHints
  if (params.maxPromptAudioLength !== undefined) input.max_prompt_audio_length = params.maxPromptAudioLength
  if (params.enablePreprocess !== undefined) input.enable_preprocess = params.enablePreprocess
  if (params.enableVolumeNormalization !== undefined) input.enable_volume_normalization = String(params.enableVolumeNormalization)
  // Enrollment is intentionally submitted once: retrying can create a second voice.
  const output = await customization(config, input, options)
  const voiceId = typeof output.voice_id === 'string' ? output.voice_id.trim() : ''
  if (!voiceId.startsWith(`${targetModel(config)}-`)) throw Error('Qwen 音色响应缺少当前模型的 voice_id')
  return voiceId
}

export async function queryQwenVoice(config: AIConfig, voiceId: string, options: QwenVoiceOptions = {}): Promise<QwenVoiceDetails> {
  if (!voiceId.trim()) throw Error('Qwen voice_id 不能为空')
  const output = await customization(config, { action: 'query_voice', voice_id: voiceId }, options)
  if (typeof output.status !== 'string' || typeof output.target_model !== 'string') throw Error('Qwen 音色响应缺少 status 或 target_model')
  return output as QwenVoiceDetails
}

export async function listQwenVoices(config: AIConfig, options: QwenVoiceOptions = {}): Promise<QwenCustomVoice[]> {
  const pageSize = 100
  const candidates = new Set<string>()
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const output = await customization(config, { action: 'list_voice', page_size: pageSize, page_index: pageIndex }, options)
    if (!Array.isArray(output.voice_list)) throw Error('Qwen 音色响应缺少 voice_list')
    for (const voice of output.voice_list) {
      if (typeof voice?.voice_id === 'string' && voice.voice_id.startsWith(`${targetModel(config)}-`)
        && (!voice.status || voice.status === 'OK')) candidates.add(voice.voice_id)
    }
    if (output.voice_list.length < pageSize) break
  }
  const voices: QwenCustomVoice[] = []
  for (const voiceId of candidates) {
    const details = await queryQwenVoice(config, voiceId, options)
    if (details.status === 'OK' && details.target_model === targetModel(config)) voices.push({ ...details, voice_id: voiceId })
  }
  return voices
}

export async function waitForQwenVoice(config: AIConfig, voiceId: string,
  options: QwenVoiceOptions & { pollMs?: number; timeoutMs?: number } = {}): Promise<QwenVoiceDetails> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
    while (true) {
      signal.throwIfAborted()
      const voice = await queryQwenVoice(config, voiceId, { ...options, signal })
      if (voice.target_model !== targetModel(config)) throw Error('Qwen 复刻音色与当前语音模型不匹配')
      if (voice.status === 'OK') return voice
      if (voice.status !== 'DEPLOYING') throw Error(`Qwen 复刻音色不可用：${voice.status}`)
      await delay(options.pollMs ?? 2_000, undefined, { signal })
    }
  } catch (error) {
    if (timeout.aborted && !options.signal?.aborted) throw Error('Qwen 复刻音色部署等待超时')
    throw error
  }
}
