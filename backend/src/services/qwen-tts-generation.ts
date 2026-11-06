import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AIConfig } from './adapters/types.js'
import { QwenTTSAdapter, QWEN_TTS_DEFAULT_VOICE, type QwenTTSParams } from './adapters/qwen-tts.js'
import { queryQwenVoice } from './qwen-tts-voices.js'
import { logTaskProgress } from '../utils/task-logger.js'

const exec = promisify(execFile)
const storage = process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url))
const pending = new Map<string, Promise<string>>()
const pendingBySignal = new WeakMap<AbortSignal, Map<string, Promise<string>>>()
const adapter = new QwenTTSAdapter()

export function splitQwenTTSText(text: string): string[] {
  const characters = Array.from(text), chunks: string[] = []
  for (let start = 0; start < characters.length;) {
    let end = Math.min(start + 1000, characters.length)
    if (end < characters.length) {
      for (let index = end - 1; index >= start + 500; index--) {
        if (/[。！？!?；;\n]/.test(characters[index]!)) { end = index + 1; break }
      }
    }
    chunks.push(characters.slice(start, end).join(''))
    start = end
  }
  return chunks
}

async function audioDuration(filename: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filename], { signal, timeout: 30_000 })
  const duration = Number(stdout.trim())
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Qwen TTS returned invalid audio duration')
  return duration
}

interface GenerationOptions {
  signal?: AbortSignal
  runRequest?: <T>(request: () => Promise<T>) => Promise<T>
}

export async function synthesizeQwenTTS(config: AIConfig, params: QwenTTSParams, options: GenerationOptions = {}) {
  options.signal?.throwIfAborted()
  // Share in-flight work only when callers also share cancellation ownership.
  const pendingScope = options.signal
    ? pendingBySignal.get(options.signal) ?? new Map<string, Promise<string>>() : pending
  if (options.signal) pendingBySignal.set(options.signal, pendingScope)
  const request = adapter.buildGenerateRequest(config, params)
  // A clone belongs to an account, region and target model, not just a voice name.
  if (params.voice !== QWEN_TTS_DEFAULT_VOICE) {
    const voice = await queryQwenVoice(config, params.voice, { signal: options.signal })
    if (voice.status !== 'OK' || voice.target_model !== request.body.model) throw new Error('Qwen TTS voice is unavailable or belongs to a different target model')
  }
  const chunks = splitQwenTTSText(params.text)
  if (!chunks.length) throw new Error('Qwen TTS text is empty')
  const cacheRoot = path.join(storage, 'audio/qwen-tts-chunks')
  await fs.mkdir(cacheRoot, { recursive: true })
  const files: string[] = []
  for (const [index, text] of chunks.entries()) {
    options.signal?.throwIfAborted()
    const chunkRequest = adapter.buildGenerateRequest(config, { ...params, text })
    const key = createHash('sha256').update(JSON.stringify(['qwen-tts-v1', config.baseUrl, config.apiKey, chunkRequest.body])).digest('hex')
    const filename = path.join(cacheRoot, `${key}.wav`)
    let cached = false
    try { await audioDuration(filename, options.signal); cached = true }
    catch { options.signal?.throwIfAborted() }
    if (!cached) {
      let run = pendingScope.get(key)
      if (!run) {
        run = (async () => {
          const deadline = AbortSignal.timeout(240_000)
          const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
          const generate = async () => {
            signal.throwIfAborted()
            const response = await fetch(chunkRequest.url, { method: chunkRequest.method, headers: chunkRequest.headers,
              body: JSON.stringify(chunkRequest.body), signal })
            const result = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(`Qwen TTS ${response.status}: ${result.message || result.code || 'synthesis failed'}`)
            return adapter.parseResponse(result, config, { signal })
          }
          const parsed = options.runRequest ? await options.runRequest(generate) : await generate()
          const temporary = `${filename}.${randomUUID()}.tmp.wav`
          try {
            await fs.writeFile(temporary, Buffer.from(parsed.audioHex, 'hex'))
            await audioDuration(temporary, options.signal)
            await fs.rename(temporary, filename)
          } finally { await fs.rm(temporary, { force: true }) }
          return filename
        })()
        pendingScope.set(key, run)
      }
      try { await run } finally { if (pendingScope.get(key) === run) pendingScope.delete(key) }
    }
    options.signal?.throwIfAborted()
    files.push(filename)
    logTaskProgress('AudioTask', cached ? 'qwen-tts-chunk-reused' : 'qwen-tts-chunk-saved', { chunk: index + 1, total: chunks.length, voice: params.voice })
  }
  const temporaryRoot = await fs.mkdtemp(path.join(cacheRoot, 'joined-'))
  try {
    const output = path.join(temporaryRoot, 'narration.wav')
    if (files.length === 1) await fs.copyFile(files[0]!, output)
    else await exec('ffmpeg', ['-nostdin', '-v', 'error', ...files.flatMap(file => ['-i', file]), '-filter_complex',
      `${files.map((_file, index) => `[${index}:a]`).join('')}concat=n=${files.length}:v=0:a=1[audio]`,
      '-map', '[audio]', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output], { signal: options.signal, timeout: 120_000 })
    const duration = await audioDuration(output, options.signal)
    const buffer = await fs.readFile(output)
    options.signal?.throwIfAborted()
    return { audioHex: buffer.toString('hex'), audioLength: Math.round(duration * 1000), sampleRate: 24000,
      bitrate: 0, format: 'wav', channel: 1, titles: [],
      extra: { audio_length: Math.round(duration * 1000), provider: config.provider, model: request.body.model,
        voice_id: params.voice, chunk_count: chunks.length, timing_source: 'none' } }
  } finally { await fs.rm(temporaryRoot, { recursive: true, force: true }) }
}
