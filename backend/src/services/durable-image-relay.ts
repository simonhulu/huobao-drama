import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { GptImage2Adapter } from './adapters/gpt-image2.js'
import type { AIConfig, ImageGenerationRecord } from './adapters/types.js'

export const DURABLE_IMAGE_RELAY_ORIGIN = 'http://127.0.0.1:18080'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const adapter = new GptImage2Adapter()
const pending = (message: string, cause?: unknown) => Object.assign(new Error(message, { cause }), {
  code: 'image_relay_pending', retryable: true, status: 503,
})
const terminal = (message: string) => Object.assign(new Error(message), { code: 'image_relay_terminal', retryable: false })

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export interface DurableRelayImage extends ImageGenerationRecord {
  provider: string | null
  imageType: string | null
  createdAt: string
}

interface RelayCheckpoint {
  version: 1
  generationId: number
  configId: number
  configFingerprint: string
  inputFingerprint: string
  authHash: string
  payloadHash: string
  taskId: string
  body: string
  admitted: boolean
}

export function isDurableImageRelayConfig(config: Pick<AIConfig, 'provider' | 'baseUrl'>): boolean {
  return ['gpt-image2', 'gpt-image-2', 'pcore'].includes(config.provider.toLowerCase())
    && config.baseUrl.replace(/\/+$/, '') === DURABLE_IMAGE_RELAY_ORIGIN
}

export function durableImageRelayCheckpointPath(database: string, generationId: number): string {
  if (!path.isAbsolute(database) || !Number.isSafeInteger(generationId) || generationId < 1) throw new Error('Invalid durable image relay identity')
  return path.join(path.dirname(database), '.image-relay', path.basename(database), `${generationId}.json`)
}

function binding(record: DurableRelayImage, configId: number, config: AIConfig): RelayCheckpoint {
  if (!Number.isSafeInteger(configId) || configId < 1 || !isDurableImageRelayConfig(config)
    || record.provider !== config.provider || !config.apiKey.trim()
    || record.referenceImages && record.referenceImages !== '[]') {
    throw new Error('Durable image relay requires an explicitly bound loopback config and immutable text-only input')
  }
  const request = adapter.buildGenerateRequest(config, record)
  if (request.url !== `${DURABLE_IMAGE_RELAY_ORIGIN}/v1/images/generations` || request.method !== 'POST' || request.body.n !== 1) {
    throw new Error('Invalid durable image relay request')
  }
  const body = canonical(request.body)
  const authHash = hash(request.headers.Authorization)
  const payloadHash = hash(body)
  return {
    version: 1, generationId: record.id, configId, authHash, payloadHash, body, admitted: false,
    taskId: hash(`${authHash}:${payloadHash}`),
    configFingerprint: hash(canonical({ configId, provider: config.provider, baseUrl: config.baseUrl,
      model: config.model, settings: config.settings ?? null, authHash })),
    inputFingerprint: hash(canonical({ id: record.id, provider: record.provider, model: record.model ?? null,
      prompt: record.prompt ?? null, size: record.size ?? null, frameType: record.frameType ?? null,
      seed: record.seed ?? null, referenceImages: record.referenceImages ?? null,
      imageType: record.imageType, createdAt: record.createdAt })),
  }
}

function save(filename: string, value: RelayCheckpoint, exclusive = false) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  const handle = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeFileSync(handle, JSON.stringify(value)); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
  try {
    if (exclusive) fs.linkSync(temporary, filename)
    else fs.renameSync(temporary, filename)
  } finally { fs.rmSync(temporary, { force: true }) }
  const parent = fs.openSync(path.dirname(filename), 'r')
  try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
}

/** Called only while creating a new DB record, before any provider submission. */
export function createDurableImageRelayCheckpoint(filename: string, record: DurableRelayImage, configId: number, config: AIConfig): string {
  const checkpoint = binding(record, configId, config)
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  save(filename, checkpoint, true)
  return checkpoint.taskId
}

export function readDurableImageRelayCheckpoint(filename: string, record: DurableRelayImage, configId: number, config: AIConfig): RelayCheckpoint {
  const expected = binding(record, configId, config)
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8')) as RelayCheckpoint
  if (typeof saved.admitted !== 'boolean' || Object.keys(expected).some(key => key !== 'admitted'
    && saved[key as keyof RelayCheckpoint] !== expected[key as keyof RelayCheckpoint])) {
    throw new Error('Durable image relay checkpoint does not match the original config and input')
  }
  return saved
}

export interface RecoverDurableImageRelayOptions {
  filename: string
  record: DurableRelayImage
  configId: number
  config: AIConfig
  deadlineAt: number
  signal?: AbortSignal
  responseTimeoutMs?: number
  pollIntervalMs?: number
  fetch?: typeof globalThis.fetch
}

async function boundedRequest<T>(url: string, init: RequestInit, options: Pick<RecoverDurableImageRelayOptions,
  'signal' | 'responseTimeoutMs' | 'fetch'>, read: (response: Response) => Promise<T>): Promise<T> {
  options.signal?.throwIfAborted()
  const controller = new AbortController()
  const timeoutMs = Math.max(1, Math.min(options.responseTimeoutMs ?? 60_000, 60_000))
  const timeout = setTimeout(() => controller.abort(new Error('Durable image relay response timed out')), timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let onAbort: () => void = () => {}
  try {
    return await Promise.race([
      (options.fetch || globalThis.fetch)(url, { ...init, signal, redirect: 'error' }).then(read),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
  } catch (error) {
    options.signal?.throwIfAborted()
    if ((error as { retryable?: boolean }).retryable === false) throw error
    if (error instanceof SyntaxError) throw terminal('Durable image relay returned invalid JSON; original task preserved')
    throw pending('Durable image relay connection unavailable; original task identity preserved', error)
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', onAbort) }
}

/** Cached loopback assets must bypass the external image HTTP proxy. */
export function downloadDurableImageRelayResult(url: string, options: Pick<RecoverDurableImageRelayOptions,
  'signal' | 'responseTimeoutMs' | 'fetch'>): Promise<{ data: string; mimeType: string }> {
  const match = /^http:\/\/127\.0\.0\.1:18080\/assets\/[a-f0-9]{64}\/([a-f0-9]{64})\.(png|jpg|webp)$/.exec(url)
  if (!match) throw terminal('Invalid durable image relay cache URL')
  return boundedRequest(url, { method: 'GET' }, options, async response => {
    if (!response.ok) throw pending(`Durable image relay cached image returned HTTP ${response.status}`)
    const chunks: Buffer[] = []
    let size = 0
    const reader = response.body?.getReader()
    if (!reader) throw terminal('Durable image relay cached image is empty')
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 64 * 1024 * 1024) {
        void reader.cancel().catch(() => {})
        throw terminal('Durable image relay cached image exceeds its byte limit')
      }
      chunks.push(Buffer.from(value))
    }
    const bytes = Buffer.concat(chunks)
    if (!size || createHash('sha256').update(bytes).digest('hex') !== match[1]) throw terminal('Durable image relay cached image integrity check failed')
    return { data: bytes.toString('base64'), mimeType: match[2] === 'jpg' ? 'image/jpeg' : `image/${match[2]}` }
  })
}

/** Resume the deterministic relay task; only an unacknowledged admission can replay its exact POST. */
export async function recoverDurableImageRelay(options: RecoverDurableImageRelayOptions): Promise<string> {
  const { filename, record, configId, config, signal } = options
  const saved = readDurableImageRelayCheckpoint(filename, record, configId, config)
  const pollUrl = `${DURABLE_IMAGE_RELAY_ORIGIN}/v1/images/generations/${saved.taskId}`
  const acknowledge = () => {
    if (!saved.admitted) { saved.admitted = true; save(filename, saved) }
  }
  const request = (method: 'GET' | 'POST') => boundedRequest(method === 'GET' ? pollUrl : `${DURABLE_IMAGE_RELAY_ORIGIN}/v1/images/generations`, {
    method, headers: { Authorization: `Bearer ${config.apiKey}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: saved.body } : {}),
  }, options, async response => {
    if (response.status !== 200 && response.status !== 202) {
      void response.body?.cancel().catch(() => {})
      return { status: response.status, value: null }
    }
    return { status: response.status, value: await response.json() }
  })
  const inspect = (response: { status: number; value: any }): { status: 'missing' | 'processing' | 'completed'; url?: string } => {
    if (response.status === 404) return { status: 'missing' }
    if (response.status !== 200) {
      const message = `Durable image relay query returned HTTP ${response.status}; original task preserved`
      throw response.status >= 500 || response.status === 408 ? pending(message) : terminal(message)
    }
    const value = response.value
    if (value?.id !== saved.taskId) throw terminal('Durable image relay returned a different task identity')
    acknowledge()
    if (value.status === 'failed') {
      throw terminal(`Durable image relay task is ${value.outcome === 'rejected' ? 'rejected' : 'uncertain'}; original task preserved; do not resubmit`)
    }
    if (value.status === 'completed') {
      const url = value.data?.url
      const expectedPrefix = `${DURABLE_IMAGE_RELAY_ORIGIN}/assets/${saved.taskId}/`
      if (typeof url !== 'string' || !url.startsWith(expectedPrefix) || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(url.slice(expectedPrefix.length))) {
        throw terminal('Durable image relay returned an invalid cached image URL')
      }
      return { status: 'completed', url }
    }
    if (value.status !== 'processing') throw terminal('Durable image relay returned an invalid task status')
    return { status: 'processing' }
  }

  let state = inspect(await request('GET'))
  if (state.status === 'completed') return state.url!
  if (Date.now() >= options.deadlineAt) throw terminal('Durable image relay generation deadline exceeded; cached terminal result not available')
  if (state.status === 'missing') {
    if (saved.admitted) throw terminal('Acknowledged durable image relay task is missing; do not resubmit')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const accepted = await request('POST')
        if (accepted.status === 202) {
          if (accepted.value?.id !== saved.taskId || accepted.value?.task_id !== saved.taskId) throw terminal('Durable image relay admission returned a different task identity')
          acknowledge()
        } else if (accepted.status >= 400 && accepted.status < 500 && accepted.status !== 408) {
          throw terminal(`Durable image relay admission rejected with HTTP ${accepted.status}`)
        } else if (accepted.status < 400) {
          throw terminal('Durable image relay did not return its asynchronous admission contract')
        }
      } catch (error) {
        signal?.throwIfAborted()
        if ((error as { retryable?: boolean }).retryable === false) throw error
      }
      // A lost 202 never changes the request identity or authorizes a new upstream job.
      state = inspect(await request('GET'))
      if (state.status !== 'missing') break
      if (saved.admitted) throw terminal('Acknowledged durable image relay task is missing; do not resubmit')
      if (Date.now() >= options.deadlineAt) break
    }
    if (state.status === 'missing') throw pending('Durable image relay admission unavailable; original task identity preserved')
  }
  while (state.status !== 'completed' && Date.now() < options.deadlineAt) {
    await delay(Math.min(options.pollIntervalMs ?? 5_000, Math.max(1, options.deadlineAt - Date.now())), undefined, { signal })
    state = inspect(await request('GET'))
    if (state.status === 'missing') throw terminal('Acknowledged durable image relay task is missing; do not resubmit')
  }
  if (state.status !== 'completed') throw terminal('Durable image relay generation deadline exceeded; original task preserved')
  return state.url!
}
