// Restored from the 2026-08-11 Codex session 019feece-cdd5-7b42-b6c9-1f1ffccca924,
// call_jFNEXn3AGStpa1LIPzQqhdL3: original TypeScript readback (before source loss).
/**
 * Qwen3-TTS（本地 MLX）语音合成 Adapter
 *
 * 与 HTTP API 厂商不同，这个 provider 的本体是 backend/third-party/qwen3-tts/server.py
 * 起的本地常驻 Python 进程（模型只加载一次）。Adapter 只负责把请求转成对该进程的
 * HTTP 调用；server 返回音频文件路径 + 逐句时间码（titles），parseResponse 读取文件。
 *
 * server 不在运行时按需自动拉起（首次生成多等一个模型加载的时间），
 * 空闲超时后 server 自动退出释放内存。
 */
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { Agent, fetch as undiciFetch } from 'undici'
import type { TTSProviderAdapter, AIConfig, ProviderRequest } from './types.js'
import { logTaskProgress, logTaskWarn } from '../../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// backend/src/services/adapters -> backend root（dist 构建后层级一致）
const BACKEND_ROOT = path.resolve(__dirname, '../../..')
const DEFAULT_BASE_URL = 'http://127.0.0.1:5987'
const SERVER_SCRIPT = path.join(BACKEND_ROOT, 'third-party/qwen3-tts/server.py')
const SERVER_LOG = path.join(BACKEND_ROOT, '.tmp/qwen3-tts-server.log')
const PYTHON_BIN = process.env.QWEN3_TTS_PYTHON
  || path.join(BACKEND_ROOT, '.venv-qwen3-tts/bin/python')

export const QWEN3_TTS_PROVIDER = 'qwen3-tts'
export const DEFAULT_QWEN3_TTS_REQUEST_TIMEOUT_MS = 3 * 60 * 60_000

const requestAgents = new Map<number, Agent>()

export function resolveQwen3TTSRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.QWEN3_TTS_REQUEST_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_QWEN3_TTS_REQUEST_TIMEOUT_MS
}

function requestAgent(timeoutMs: number): Agent {
  const existing = requestAgents.get(timeoutMs)
  if (existing) return existing

  const agent = new Agent({
    connectTimeout: 30_000,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  })
  requestAgents.set(timeoutMs, agent)
  return agent
}

interface Qwen3TTSRequestInit {
  method: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export async function fetchQwen3TTS(url: string, init: Qwen3TTSRequestInit): Promise<Response> {
  const timeoutMs = resolveQwen3TTSRequestTimeoutMs()
  const response = await undiciFetch(url, {
    ...init,
    dispatcher: requestAgent(timeoutMs),
    signal: init.signal || AbortSignal.timeout(timeoutMs),
  })
  return response as unknown as Response
}

export function isQwen3TTSProvider(provider?: string | null): boolean {
  return String(provider || '').toLowerCase() === QWEN3_TTS_PROVIDER
}

function baseUrlOf(config: AIConfig): string {
  return (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function portOf(config: AIConfig): number {
  try {
    const url = new URL(baseUrlOf(config))
    return Number(url.port) || 5987
  } catch {
    return 5987
  }
}

async function healthOk(config: AIConfig, timeoutMs = 2000): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrlOf(config)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return resp.ok
  } catch {
    return false
  }
}

let spawnInFlight: Promise<void> | null = null

/**
 * 确保本地 server 已启动；未启动则拉起 Python 进程并等待就绪。
 * 并发调用共享同一个拉起 Promise，避免重复 spawn。
 */
export function ensureQwen3TTSServer(config: AIConfig): Promise<void> {
  if (!spawnInFlight) {
    spawnInFlight = doEnsureServer(config).finally(() => { spawnInFlight = null })
  }
  return spawnInFlight
}

async function doEnsureServer(config: AIConfig): Promise<void> {
  if (await healthOk(config)) return

  if (!fs.existsSync(PYTHON_BIN)) {
    throw new Error(`Qwen3-TTS python 不存在: ${PYTHON_BIN}（请先 uv venv .venv-qwen3-tts 并安装 mlx-audio）`)
  }
  if (!fs.existsSync(SERVER_SCRIPT)) {
    throw new Error(`Qwen3-TTS server 脚本不存在: ${SERVER_SCRIPT}`)
  }

  fs.mkdirSync(path.dirname(SERVER_LOG), { recursive: true })
  const logFd = fs.openSync(SERVER_LOG, 'a')
  const child = spawn(PYTHON_BIN, [SERVER_SCRIPT, '--port', String(portOf(config))], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  })
  child.unref()
  logTaskProgress('AudioTask', 'qwen3-tts-server-spawned', { pid: child.pid, port: portOf(config) })

  // 等服务就绪（不含模型加载：server 懒加载模型，/health 立即可用）
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    if (await healthOk(config)) return
    if (child.exitCode !== null) {
      throw new Error(`Qwen3-TTS server 启动失败（exit ${child.exitCode}），日志: ${SERVER_LOG}`)
    }
  }
  logTaskWarn('AudioTask', 'qwen3-tts-server-slow-start', { port: portOf(config) })
  throw new Error(`Qwen3-TTS server 30s 内未就绪，日志: ${SERVER_LOG}`)
}

export class Qwen3TTSAdapter implements TTSProviderAdapter {
  readonly provider = QWEN3_TTS_PROVIDER

  buildGenerateRequest(config: AIConfig, params: any): ProviderRequest {
    return {
      url: `${baseUrlOf(config)}/tts`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        text: params.text,
        // 调用层已把 voice id 解析成 VoiceDesign 的 instruct 文本
        instruct: params.voice,
        speed: params.speed ?? 1.0,
        language: 'Chinese',
      },
    }
  }

  async parseResponse(result: any, _config: AIConfig) {
    if (result?.error) {
      throw new Error(`Qwen3-TTS error: ${result.error}`)
    }
    const audioPath = result?.audio_path
    if (!audioPath || !fs.existsSync(audioPath)) {
      throw new Error(`Qwen3-TTS response missing audio file: ${audioPath}`)
    }
    const audioBuffer = fs.readFileSync(audioPath)
    // server 写入的是调用方指定的临时文件；读取后清掉，避免堆积
    try { fs.unlinkSync(audioPath) } catch {}

    const audioLength = Number(result?.audio_length) || 0
    return {
      audioHex: audioBuffer.toString('hex'),
      audioLength,
      sampleRate: Number(result?.sample_rate) || 24000,
      bitrate: 0,
      format: 'wav',
      channel: 1,
      titles: Array.isArray(result?.titles) ? result.titles : [],
      extra: { ...(result?.extra || {}), audio_length: audioLength },
    }
  }
}
