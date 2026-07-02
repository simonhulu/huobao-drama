/**
 * TTS 语音合成服务
 * 支持 MiniMax TTS (hex 音频响应) 和 OpenAI 兼容 /audio/speech
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { getAudioConfigById } from './ai.js'
import { getTTSAdapter } from './adapters/registry.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, redactUrl } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')

interface TTSParams {
  text: string
  voice: string
  model?: string
  speed?: number
  emotion?: string
  configId?: number | null
  subtitleEnable?: boolean
  subtitleType?: 'sentence' | 'word' | 'word_streaming'
}

export interface TTSResult {
  audioUrl: string
  titles?: any[]
  extra?: Record<string, any>
}

export class TTSGenerationLimiter {
  private running = 0
  private pending: Array<() => void> = []
  private timestamps: number[] = []

  constructor(
    private readonly concurrency: number,
    private readonly intervalMs: number,
    private readonly intervalCap: number,
  ) {}

  private tryNext(): void {
    while (this.pending.length > 0) {
      if (this.running >= this.concurrency) return

      const nowMs = Date.now()
      this.timestamps = this.timestamps.filter((ts) => nowMs - ts < this.intervalMs)
      if (this.timestamps.length >= this.intervalCap) {
        const oldest = this.timestamps[0]
        if (oldest !== undefined) {
          const waitMs = this.intervalMs - (nowMs - oldest) + 1
          setTimeout(() => this.tryNext(), waitMs)
        }
        return
      }

      const next = this.pending.shift()
      if (!next) continue
      this.running++
      this.timestamps.push(Date.now())
      next()
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.pending.push(resolve)
      this.tryNext()
    })
    try {
      return await fn()
    } finally {
      this.running--
      this.tryNext()
    }
  }
}

const TTS_GENERATION_CONCURRENCY = Math.max(1, Number(process.env.TTS_GENERATION_CONCURRENCY || 1))
const TTS_GENERATION_INTERVAL_MS = Math.max(1, Number(process.env.TTS_GENERATION_INTERVAL_MS || 60_000))
const TTS_GENERATION_INTERVAL_CAP = Math.max(1, Number(process.env.TTS_GENERATION_INTERVAL_CAP || 5))

const ttsGenerationLimiter = new TTSGenerationLimiter(
  TTS_GENERATION_CONCURRENCY,
  TTS_GENERATION_INTERVAL_MS,
  TTS_GENERATION_INTERVAL_CAP,
)

/**
 * 生成 TTS 音频，返回本地文件路径
 */
export async function generateTTS(params: TTSParams): Promise<string> {
  const result = await generateTTSWithMetadata(params)
  return result.audioUrl
}

/**
 * 生成 TTS 音频，同时返回音频路径和字幕时间码（若厂商支持）
 */
export async function generateTTSWithMetadata(params: TTSParams): Promise<TTSResult> {
  const config = getAudioConfigById(params.configId)
  const adapter = getTTSAdapter(config.provider)

  logTaskStart('AudioTask', 'tts-generate', {
    provider: config.provider,
    voice: params.voice,
    model: params.model || config.model,
    textPreview: params.text.slice(0, 50),
    textLength: params.text.length,
  })
  logTaskPayload('AudioTask', 'tts params', {
    config: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
    params,
  })

  const { url, method, headers, body } = adapter.buildGenerateRequest(config, params)
  logTaskProgress('AudioTask', 'request', {
    provider: config.provider,
    voice: params.voice,
    method,
    url: redactUrl(url),
    model: params.model || config.model,
  })
  logTaskPayload('AudioTask', 'request payload', {
    method,
    url,
    headers,
    body,
  })

  const resp = await ttsGenerationLimiter.run(() => fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  }))

  if (!resp.ok) {
    const errText = await resp.text()
    logTaskError('AudioTask', 'tts-generate', { provider: config.provider, voice: params.voice, status: resp.status, error: errText })
    throw new Error(`TTS API error ${resp.status}: ${errText}`)
  }

  let parsed: any
  if (config.provider.toLowerCase() === 'siliconflow') {
    const arrayBuffer = await resp.arrayBuffer()
    parsed = await adapter.parseResponse({ audioBuffer: Buffer.from(arrayBuffer) }, config)
  } else {
    const result = await resp.json()
    parsed = await adapter.parseResponse(result, config)
  }

  // 将 hex 解码为二进制
  const buffer = Buffer.from(parsed.audioHex, 'hex')

  // 保存到本地
  const audioDir = path.join(STORAGE_ROOT, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const rawFilename = `${uuid()}.${parsed.format || 'mp3'}`
  const rawPath = path.join(audioDir, rawFilename)
  fs.writeFileSync(rawPath, buffer)

  // 对 TTS 音频做响度标准化，解决部分提供商（如 MiniMax）输出音量过小的问题
  const normalizedFilename = `${uuid()}.m4a`
  const normalizedPath = path.join(audioDir, normalizedFilename)
  await normalizeAudio(rawPath, normalizedPath)

  // 删除原始未标准化文件
  try { fs.unlinkSync(rawPath) } catch {}

  const relativePath = `static/audio/${normalizedFilename}`

  // 若厂商返回字幕时间码，持久化到同目录 .titles.json，便于后续字幕生成直接对轴
  if (parsed.titles && parsed.titles.length > 0) {
    const titlesPath = path.join(audioDir, `${normalizedFilename}.titles.json`)
    fs.writeFileSync(titlesPath, JSON.stringify({
      text: params.text,
      titles: parsed.titles,
      extra: parsed.extra || {},
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf-8')
  }

  logTaskSuccess('AudioTask', 'tts-saved', {
    provider: config.provider,
    voice: params.voice,
    path: relativePath,
    bytes: buffer.length,
    audioMs: parsed.audioLength,
    titleCount: parsed.titles?.length || 0,
  })
  return { audioUrl: relativePath, titles: parsed.titles, extra: parsed.extra }
}

/**
 * 使用 FFmpeg 对音频做响度标准化（EBU R128），统一不同 TTS 提供商的音量
 */
function normalizeAudio(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11')
      .audioCodec('aac')
      .audioBitrate('192k')
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

/**
 * 为角色生成试听音频
 */
export async function generateVoiceSample(characterName: string, voiceId: string, configId?: number | null): Promise<string> {
  const sampleText = `你好，我是${characterName}。很高兴认识你，这是我的声音试听。`
  return generateTTS({ text: sampleText, voice: voiceId, configId })
}
