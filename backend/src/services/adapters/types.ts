/**
 * 图片生成 Provider Adapter 接口
 */
export interface ImageProviderAdapter {
  /** 厂商标识 */
  provider: string

  /**
   * 构建图片生成请求
   * @param config AI 配置 { baseUrl, apiKey, model }
   * @param record 图片生成记录
   */
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest

  /**
   * 解析生成响应，判断是同步还是异步
   */
  parseGenerateResponse(result: any): ImageGenResponse

  /**
   * 构建轮询请求
   * @param config AI 配置
   * @param taskId 任务 ID
   */
  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  /**
   * 解析轮询响应
   */
  parsePollResponse(result: any): ImagePollResponse

  /**
   * 从响应中提取图片 URL（用于直接下载）
   * 返回 null 表示图片数据是 base64 格式，需要用 extractImageBase64 处理
   */
  extractImageUrl(result: any): string | null

  /**
   * 从响应中提取 base64 图片数据
   * 仅用于 Gemini 等只返回 base64 的厂商
   */
  extractImageBase64(result: any): { data: string; mimeType: string } | null
}

/**
 * 视频生成 Provider Adapter 接口
 */
export interface VideoProviderAdapter {
  provider: string

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest

  parseGenerateResponse(result: any): VideoGenResponse

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  parsePollResponse(result: any): VideoPollResponse

  extractVideoUrl(result: any): string | null
}

// ============ 通用类型 ============

export interface ProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: any
}

export interface AIConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  settings?: string | Record<string, any> | null
}

export interface ImageGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  size?: string | null
  frameType?: string | null
  referenceImages?: string | null
  seed?: number | null
  // ... 其他字段
}

export interface VideoGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  referenceMode?: string | null
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  referenceImageUrls?: string | null
  duration?: number | null
  aspectRatio?: string | null
  // ... 其他字段
}

export interface ImageGenResponse {
  isAsync: boolean
  taskId?: string
  /** 同步模式下直接返回的图片 URL */
  imageUrl?: string
}

export interface ImagePollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  imageUrl?: string
  error?: string
}

export interface VideoGenResponse {
  isAsync: boolean
  taskId?: string
  videoUrl?: string
}

export interface VideoPollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  videoUrl?: string
  error?: string
}

/**
 * 音乐/BGM 生成 Provider Adapter
 */
export interface MusicProviderAdapter {
  provider: string

  buildGenerateRequest(config: AIConfig, record: MusicGenerationRecord): ProviderRequest

  parseGenerateResponse(result: any): MusicGenResponse

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  parsePollResponse(result: any): MusicPollResponse

  buildFileRetrieveRequest(config: AIConfig, fileId: string): ProviderRequest

  parseFileRetrieveResponse(result: any): { audioUrl: string | null; error?: string }
}

export interface MusicGenerationRecord {
  id: number
  prompt?: string | null
  duration?: number | null
  model?: string | null
}

export interface MusicGenResponse {
  isAsync: boolean
  taskId?: string
  audioUrl?: string
  error?: string
}

export interface MusicPollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  fileId?: string
  audioUrl?: string
  error?: string
}

/**
 * TTS 语音合成 Provider Adapter
 */
export interface TTSProviderAdapter {
  provider: string

  buildGenerateRequest(config: AIConfig, params: any): ProviderRequest

  parseResponse(result: any, config: AIConfig): Promise<{
    audioHex: string
    audioLength: number
    sampleRate: number
    bitrate: number
    format: string
    channel: number
    /** 部分厂商（如 MiniMax）会返回带时间码的字幕信息 */
    titles?: any[]
    /** 厂商额外信息，如 audio_length */
    extra?: Record<string, any>
  }>
}
