/**
 * MiniMax 语音合成（TTS）Adapter — 异步长文本版本
 * API: POST /v1/t2a_async_v2
 *      GET  /v1/query/t2a_async_query_v2?task_id=...
 *      GET  /v1/files/retrieve?file_id=...
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { TTSProviderAdapter, AIConfig, ProviderRequest } from './types.js'
import { joinProviderUrl } from './url.js'

const execFileAsync = promisify(execFile)

export interface TTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
  subtitleEnable?: boolean
  subtitleType?: 'sentence' | 'word' | 'word_streaming'
}

export interface TTSResult {
  audioHex: string
  audioLength: number
  sampleRate: number
  bitrate: number
  format: string
  channel: number
  titles?: any[]
  extra?: Record<string, any>
}

export interface AsyncTTSResult {
  audioBuffer: Buffer
  titles: any[]
  extra: Record<string, any>
}

const POLL_INITIAL_MS = 2000
const POLL_MAX_MS = 8000
const POLL_MAX_TOTAL_MS = 10 * 60 * 1000 // 最多轮询 10 分钟

export class MiniMaxTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'minimax'

  buildGenerateRequest(config: AIConfig, params: TTSParams): ProviderRequest {
    const url = joinProviderUrl(config.baseUrl, '/v1', '/t2a_async_v2')

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    }

    const body: any = {
      model: params.model || config.model || 'speech-2.8-turbo',
      text: params.text,
      language_boost: 'auto',
      voice_setting: {
        voice_id: params.voice,
        speed: params.speed ?? 1,
        vol: 1,
        pitch: 0,
        emotion: params.emotion || 'happy',
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
      subtitle_enable: params.subtitleEnable ?? false,
    }

    if (body.subtitle_enable) {
      body.subtitle_type = params.subtitleType || 'sentence'
    }

    return { url, method: 'POST', headers, body }
  }

  async parseResponse(result: any, config: AIConfig): Promise<TTSResult> {
    if (result.base_resp?.status_code !== 0) {
      throw new Error(result.base_resp?.status_msg || 'TTS async creation failed')
    }

    const taskId = result.task_id
    const fileId = result.file_id
    if (!taskId || !fileId) {
      throw new Error('TTS async creation response missing task_id or file_id')
    }

    const { audioBuffer, titles, extra } = await retrieveAsyncResult(config, taskId, fileId)

    return {
      audioHex: audioBuffer.toString('hex'),
      audioLength: Number(extra?.audio_length) || 0,
      sampleRate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
      titles,
      extra,
    }
  }
}

export async function retrieveAsyncResult(
  config: AIConfig,
  taskId: string | number,
  fileId: string | number,
): Promise<AsyncTTSResult> {
  await pollUntilDone(config, taskId)
  const downloadUrl = await retrieveDownloadUrl(config, fileId)
  const archiveBuffer = await downloadArchive(downloadUrl)
  return extractArchive(archiveBuffer)
}

async function pollUntilDone(config: AIConfig, taskId: string | number): Promise<void> {
  const url = joinProviderUrl(config.baseUrl, '/v1', '/query/t2a_async_query_v2')
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }

  const start = Date.now()
  let delay = POLL_INITIAL_MS

  while (true) {
    await sleep(delay)

    const resp = await fetch(`${url}?task_id=${encodeURIComponent(String(taskId))}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`TTS async poll error ${resp.status}: ${text}`)
    }

    const data = await resp.json()
    if (data.base_resp?.status_code !== 0) {
      throw new Error(data.base_resp?.status_msg || 'TTS async poll failed')
    }

    const status = data.status
    if (status === 'Success') return
    if (status === 'Failed' || status === 'Expired') {
      throw new Error(`TTS async task ${taskId} ended with status: ${status}`)
    }

    if (Date.now() - start > POLL_MAX_TOTAL_MS) {
      throw new Error(`TTS async task ${taskId} polling timed out`)
    }

    delay = Math.min(delay * 1.5, POLL_MAX_MS)
  }
}

async function retrieveDownloadUrl(config: AIConfig, fileId: string | number): Promise<string> {
  const url = joinProviderUrl(config.baseUrl, '/v1', '/files/retrieve')
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }

  const resp = await fetch(`${url}?file_id=${encodeURIComponent(String(fileId))}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`TTS file retrieve error ${resp.status}: ${text}`)
  }

  const data = await resp.json()
  if (data.base_resp?.status_code !== 0) {
    throw new Error(data.base_resp?.status_msg || 'TTS file retrieve failed')
  }

  const downloadUrl = data.file?.download_url
  if (!downloadUrl) {
    throw new Error('TTS file retrieve response missing download_url')
  }

  return downloadUrl
}

async function downloadArchive(url: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`TTS audio download error ${resp.status}: ${text}`)
  }
  const arrayBuffer = await resp.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export async function extractArchive(archiveBuffer: Buffer): Promise<AsyncTTSResult> {
  const isGzip = archiveBuffer.length >= 2 && archiveBuffer[0] === 0x1f && archiveBuffer[1] === 0x8b
  const isTar = isUstarTar(archiveBuffer)

  if (!isGzip && !isTar) {
    // 直接返回音频，没有字幕
    return { audioBuffer: archiveBuffer, titles: [], extra: {} }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-tts-'))
  try {
    const archivePath = path.join(tmpDir, `audio.${isGzip ? 'tar.gz' : 'tar'}`)
    fs.writeFileSync(archivePath, archiveBuffer)

    const args = isGzip ? ['-xzf', archivePath, '-C', tmpDir] : ['-xf', archivePath, '-C', tmpDir]
    await execFileAsync('tar', args)

    const mp3File = findFirstFile(tmpDir, '.mp3')
    if (!mp3File) {
      throw new Error('Downloaded TTS archive does not contain an mp3 file')
    }

    const titlesFile = findFirstFile(tmpDir, '.titles')
    const extraFile = findFirstFile(tmpDir, '.extra')

    const audioBuffer = fs.readFileSync(mp3File)
    const titles = titlesFile ? parseJsonFile(titlesFile) : []
    const extra = extraFile ? parseJsonFile(extraFile) : {}

    return { audioBuffer, titles, extra }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

function parseJsonFile(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

function isUstarTar(buf: Buffer): boolean {
  // POSIX tar magic is at byte offset 257: 'ustar\0' or 'ustar ' (GNU)
  if (buf.length < 264) return false
  const magic = buf.toString('ascii', 257, 263)
  return magic === 'ustar\0' || magic === 'ustar '
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findFirstFile(dir: string, ext: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFirstFile(fullPath, ext)
      if (found) return found
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
      return fullPath
    }
  }
  return null
}
