/**
 * Provider Adapter 注册表
 * 根据 provider 名称返回对应的 Adapter 实例
 */
import { MiniMaxImageAdapter } from './minimax-image.js'
import { MiniMaxVideoAdapter } from './minimax-video.js'
import { MiniMaxTTSAdapter } from './minimax-tts.js'
import { MiniMaxMusicAdapter } from './minimax-music.js'
import { SiliconFlowTTSAdapter } from './siliconflow-tts.js'
import { OpenAIImageAdapter } from './openai-image.js'
import { GeminiImageAdapter } from './gemini-image.js'
import { VolcEngineImageAdapter } from './volcengine-image.js'
import { VolcEngineVideoAdapter } from './volcengine-video.js'
import { ViduVideoAdapter } from './vidu-video.js'
import { AliImageAdapter } from './ali-image.js'
import { AliVideoAdapter } from './ali-video.js'
import { ConfigurableImageAdapter } from './configurable-image.js'
import { APIMartImageAdapter } from './apimart-image.js'
import type { ImageProviderAdapter, VideoProviderAdapter, TTSProviderAdapter, MusicProviderAdapter, AIConfig } from './types.js'

// 图片 Adapter 注册表
export const imageAdapters: Record<string, ImageProviderAdapter> = {
  minimax: new MiniMaxImageAdapter(),
  openai: new OpenAIImageAdapter(),
  gemini: new GeminiImageAdapter(),
  volcengine: new VolcEngineImageAdapter(),
  ali: new AliImageAdapter(),
  apimart: new APIMartImageAdapter(),
  // Chatfire - 待确认 API 格式，暂用 OpenAI
  chatfire: new OpenAIImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  minimax: new MiniMaxVideoAdapter(),
  volcengine: new VolcEngineVideoAdapter(),
  vidu: new ViduVideoAdapter(),
  ali: new AliVideoAdapter(),
  // Chatfire 视频 - 待确认 API 格式
}

// TTS Adapter 注册表
export const ttsAdapters: Record<string, TTSProviderAdapter> = {
  minimax: new MiniMaxTTSAdapter(),
  siliconflow: new SiliconFlowTTSAdapter(),
}

// 音乐/BGM Adapter 注册表
export const musicAdapters: Record<string, MusicProviderAdapter> = {
  minimax: new MiniMaxMusicAdapter(),
}

export function getTTSAdapter(provider: string): TTSProviderAdapter {
  return ttsAdapters[provider.toLowerCase()] || ttsAdapters['minimax']
}

/**
 * 获取图片 Adapter
 * @param configOrProvider AI 配置对象或厂商名称
 * @returns 对应的 Adapter，未知厂商返回 MiniMax 默认
 */
export function getImageAdapter(configOrProvider: AIConfig | string): ImageProviderAdapter {
  if (typeof configOrProvider === 'object') {
    const config = configOrProvider
    const provider = config.provider.toLowerCase()
    const builtIn = imageAdapters[provider]
    if (builtIn) return builtIn
    const configurable = ConfigurableImageAdapter.fromConfig(config)
    if (configurable) return configurable
    return imageAdapters['minimax']
  }
  return imageAdapters[configOrProvider.toLowerCase()] || imageAdapters['minimax']
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter，未知厂商返回 MiniMax 默认
 */
export function getVideoAdapter(provider: string): VideoProviderAdapter {
  return videoAdapters[provider.toLowerCase()] || videoAdapters['minimax']
}

/**
 * 获取音乐/BGM Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter，未知厂商返回 MiniMax 默认
 */
export function getMusicAdapter(provider: string): MusicProviderAdapter {
  return musicAdapters[provider.toLowerCase()] || musicAdapters['minimax']
}
