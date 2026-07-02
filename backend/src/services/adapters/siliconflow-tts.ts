/**
 * SiliconFlow TTS Adapter
 * OpenAI-compatible /v1/audio/speech endpoint
 * Supports FunAudioLLM/CosyVoice2-0.5B and custom cloned voices
 */
import type { TTSProviderAdapter, AIConfig, ProviderRequest } from './types.js'
import { joinProviderUrl } from './url.js'

export interface SiliconFlowTTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  responseFormat?: 'mp3' | 'wav' | 'ogg' | 'aac' | 'flac' | 'pcm'
}

/**
 * SiliconFlow CosyVoice2 对某些中文标点（省略号、直角引号）偶发 500，
 * 作为 workaround 替换为模型更稳定的半角/弯角标点。
 */
function sanitizeTtsInput(text: string): string {
  return text
    .replace(/……/g, '，')
    .replace(/「/g, '“')
    .replace(/」/g, '”')
}

export class SiliconFlowTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'siliconflow'

  buildGenerateRequest(config: AIConfig, params: SiliconFlowTTSParams): ProviderRequest {
    const url = joinProviderUrl(config.baseUrl, '/v1', '/audio/speech')

    const body: Record<string, any> = {
      model: params.model || config.model || 'FunAudioLLM/CosyVoice2-0.5B',
      input: sanitizeTtsInput(params.text),
      voice: params.voice,
      response_format: params.responseFormat || 'mp3',
      stream: false,
    }

    if (params.speed !== undefined && params.speed >= 0.25 && params.speed <= 4.0) {
      body.speed = params.speed
    }

    return {
      url,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    }
  }

  async parseResponse(result: { audioBuffer: Buffer }, _config: AIConfig): Promise<{
    audioHex: string
    audioLength: number
    sampleRate: number
    bitrate: number
    format: string
    channel: number
    titles?: any[]
    extra?: Record<string, any>
  }> {
    const buffer = result.audioBuffer
    return {
      audioHex: buffer.toString('hex'),
      audioLength: 0,
      sampleRate: 24000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
      titles: [],
      extra: {},
    }
  }
}
