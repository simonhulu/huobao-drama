import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { v4 as uuid } from 'uuid'
import {
  getAbsolutePath,
  mimeTypeToExtension,
  parseDataUrl,
  readImageAsCompressedBuffer,
} from '../utils/storage.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')
const DEFAULT_EGAKI_BIN = path.join(repoRoot, 'backend/node_modules/.bin/egaki')
const DEFAULT_PROXY_BOOTSTRAP = path.join(repoRoot, 'backend/scripts/egaki-undici-proxy.mjs')
const DEFAULT_TIMEOUT_MS = Math.max(60_000, Number(process.env.EGAKI_IMAGE_TIMEOUT_MS || 600_000))
const DEFAULT_JOB_POLL_MS = Math.max(50, Number(process.env.EGAKI_LOCAL_JOB_POLL_MS || 500))
const DEFAULT_JOB_RETENTION_MS = Math.max(60_000, Number(process.env.EGAKI_LOCAL_JOB_RETENTION_MS || 600_000))
const DEFAULT_MODEL = 'gpt-image-2'

export interface EgakiImageRecord {
  id: number
  prompt?: string | null
  model?: string | null
  size?: string | null
  seed?: number | null
  referenceImages?: string | null
}

export interface RunEgakiChatGptImageOptions {
  egakiBin?: string
  env?: NodeJS.ProcessEnv
  proxyBootstrapPath?: string | null
  signal?: AbortSignal
  timeoutMs?: number
  tempRoot?: string
}

export type EgakiLocalImageJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'

export interface EgakiLocalImageJobSnapshot {
  id: string
  status: EgakiLocalImageJobStatus
  localPath?: string
  error?: string
  startedAt: number
  completedAt?: number
}

interface EgakiLocalImageJobState extends EgakiLocalImageJobSnapshot {
  controller: AbortController
  promise: Promise<void>
}

export interface WaitEgakiChatGptImageJobOptions {
  signal?: AbortSignal
  timeoutMs?: number
  pollMs?: number
}

const egakiLocalJobs = new Map<string, EgakiLocalImageJobState>()

export function mapSizeToEgakiAspectRatio(size: string | null | undefined): '1:1' | '3:2' | '2:3' {
  const ratio = parseRatio(size)
  if (!ratio) return '1:1'

  const supported = [
    { value: '1:1' as const, ratio: 1 },
    { value: '3:2' as const, ratio: 3 / 2 },
    { value: '2:3' as const, ratio: 2 / 3 },
  ]
  return supported
    .map((item) => ({ ...item, distance: Math.abs(Math.log(ratio / item.ratio)) }))
    .sort((a, b) => a.distance - b.distance)[0].value
}

export function buildEgakiChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  proxyBootstrapPath: string | null = DEFAULT_PROXY_BOOTSTRAP,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  delete env.OPENAI_API_KEY

  if (proxyBootstrapPath && hasProxyEnv(env) && fs.existsSync(proxyBootstrapPath)) {
    const importFlag = `--import=${pathToFileURL(proxyBootstrapPath).href}`
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${importFlag}` : importFlag
  }

  return env
}

export async function materializeEgakiReferenceImages(
  refs: string[],
  tempDir: string,
): Promise<string[]> {
  fs.mkdirSync(tempDir, { recursive: true })
  const materialized: string[] = []

  for (const ref of refs.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 9)) {
    if (ref.startsWith('data:image/')) {
      const parsed = parseDataUrl(ref)
      if (!parsed) continue
      const buffer = Buffer.from(parsed.data, 'base64')
      materialized.push(writeTempImage(tempDir, buffer, parsed.mimeType))
      continue
    }

    if (ref.startsWith('static/') || ref.startsWith('/static/')) {
      const localPath = ref.startsWith('/static/') ? ref.slice(1) : ref
      const image = await readImageAsCompressedBuffer(localPath, {
        maxWidth: 1024,
        maxHeight: 1024,
        quality: 90,
        format: 'preserve',
      })
      materialized.push(writeTempImage(tempDir, image.buffer, image.mimeType))
      continue
    }

    if (ref.startsWith('http://') || ref.startsWith('https://')) {
      const image = await downloadReferenceImage(ref)
      materialized.push(writeTempImage(tempDir, image.buffer, image.mimeType))
    }
  }

  return materialized
}

export async function runEgakiChatGptImage(
  record: EgakiImageRecord,
  options: RunEgakiChatGptImageOptions = {},
): Promise<string> {
  const jobId = submitEgakiChatGptImageJob(record, options)
  return waitForEgakiChatGptImageJob(jobId, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_JOB_POLL_MS,
  })
}

export function submitEgakiChatGptImageJob(
  record: EgakiImageRecord,
  options: RunEgakiChatGptImageOptions = {},
): string {
  const jobId = `egaki-local-${record.id}-${uuid()}`
  const controller = new AbortController()
  const parentAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) parentAbort()
  else options.signal?.addEventListener('abort', parentAbort, { once: true })

  const job: EgakiLocalImageJobState = {
    id: jobId,
    status: 'queued',
    startedAt: Date.now(),
    controller,
    promise: Promise.resolve(),
  }
  egakiLocalJobs.set(jobId, job)

  job.promise = (async () => {
    try {
      if (controller.signal.aborted) throw new Error('egaki-chatgpt generation canceled')
      job.status = 'running'
      job.localPath = await runEgakiChatGptImageDirect(record, {
        ...options,
        signal: controller.signal,
      })
      job.status = 'completed'
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      job.error = error.message
      job.status = controller.signal.aborted || error.message.toLowerCase().includes('canceled')
        ? 'canceled'
        : 'failed'
    } finally {
      job.completedAt = Date.now()
      options.signal?.removeEventListener('abort', parentAbort)
      scheduleEgakiLocalJobCleanup(jobId)
    }
  })()

  job.promise.catch(() => undefined)
  return jobId
}

export function getEgakiChatGptImageJob(jobId: string): EgakiLocalImageJobSnapshot | null {
  const job = egakiLocalJobs.get(jobId)
  if (!job) return null
  return {
    id: job.id,
    status: job.status,
    localPath: job.localPath,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  }
}

export function cancelEgakiChatGptImageJob(jobId: string): boolean {
  const job = egakiLocalJobs.get(jobId)
  if (!job || job.status === 'completed' || job.status === 'failed' || job.status === 'canceled') {
    return false
  }
  job.controller.abort()
  return true
}

export async function waitForEgakiChatGptImageJob(
  jobId: string,
  options: WaitEgakiChatGptImageJobOptions = {},
): Promise<string> {
  const startedAt = Date.now()
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_JOB_POLL_MS)
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  while (true) {
    if (options.signal?.aborted) {
      cancelEgakiChatGptImageJob(jobId)
      throw new Error('egaki-chatgpt generation canceled')
    }

    const job = getEgakiChatGptImageJob(jobId)
    if (!job) throw new Error(`egaki-chatgpt local job not found: ${jobId}`)
    if (job.status === 'completed' && job.localPath) return job.localPath
    if (job.status === 'failed') throw new Error(job.error || 'egaki-chatgpt local job failed')
    if (job.status === 'canceled') throw new Error(job.error || 'egaki-chatgpt generation canceled')

    if (Date.now() - startedAt >= timeoutMs) {
      cancelEgakiChatGptImageJob(jobId)
      throw new Error(`egaki-chatgpt local job timed out: ${jobId}`)
    }

    await delay(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - startedAt))), options.signal)
  }
}

async function runEgakiChatGptImageDirect(
  record: EgakiImageRecord,
  options: RunEgakiChatGptImageOptions = {},
): Promise<string> {
  const prompt = String(record.prompt || '').trim()
  if (!prompt) throw new Error('egaki-chatgpt image generation requires a prompt')

  const tempDir = fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(), `huobao-egaki-image-${record.id}-`))
  const outputPath = path.join(tempDir, 'output.png')

  try {
    const refs = await materializeEgakiReferenceImages(parseReferenceImages(record.referenceImages), path.join(tempDir, 'refs'))
    const args = [
      'image',
      prompt,
      '-m', record.model || DEFAULT_MODEL,
      '--aspect-ratio', mapSizeToEgakiAspectRatio(record.size),
      '-o', outputPath,
      ...refs.flatMap((ref) => ['--input', ref]),
    ]

    await runEgakiProcess(options.egakiBin || process.env.EGAKI_BIN || DEFAULT_EGAKI_BIN, args, {
      env: buildEgakiChildEnv(
        options.env || process.env,
        options.proxyBootstrapPath ?? process.env.EGAKI_PROXY_BOOTSTRAP ?? DEFAULT_PROXY_BOOTSTRAP,
      ),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })

    const stat = fs.statSync(outputPath)
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error('egaki-chatgpt did not write a valid output image')
    }

    return persistGeneratedImage(outputPath)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function scheduleEgakiLocalJobCleanup(jobId: string): void {
  const timer = setTimeout(() => {
    egakiLocalJobs.delete(jobId)
  }, DEFAULT_JOB_RETENTION_MS)
  timer.unref?.()
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new Error('egaki-chatgpt generation canceled'))
    }
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    timer = setTimeout(done, ms)
    if (signal?.aborted) {
      abort()
    } else {
      signal?.addEventListener('abort', abort, { once: true })
    }
  })
}

function parseReferenceImages(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function parseRatio(size: string | null | undefined): number | null {
  if (!size) return null
  const match = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(size.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return width / height
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.IMAGE_HTTPS_PROXY ||
    env.IMAGE_HTTP_PROXY ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy,
  )
}

function writeTempImage(tempDir: string, buffer: Buffer, mimeType: string): string {
  const filePath = path.join(tempDir, `${uuid()}${mimeTypeToExtension(mimeType)}`)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

async function downloadReferenceImage(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const proxy = resolveProxy(url)
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined
  const resp = dispatcher
    ? await undiciFetch(url, { dispatcher, signal: AbortSignal.timeout(120_000) })
    : await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!resp.ok) throw new Error(`egaki-chatgpt reference download failed: ${resp.status}`)
  const mimeType = resp.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
  return { buffer: Buffer.from(await resp.arrayBuffer()), mimeType }
}

function resolveProxy(url: string): string | undefined {
  if (url.startsWith('https:')) {
    return process.env.IMAGE_HTTPS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.IMAGE_HTTP_PROXY || process.env.HTTP_PROXY || process.env.http_proxy
  }
  return process.env.IMAGE_HTTP_PROXY || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
}

async function runEgakiProcess(
  egakiBin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(egakiBin, args, { env: options.env, timeout: options.timeoutMs })
    let tail = ''
    let settled = false
    const cleanup = () => {
      settled = true
      options.signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      if (settled) return
      cleanup()
      child.kill('SIGTERM')
      reject(new Error('egaki-chatgpt generation canceled'))
    }
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })

    child.stdout.on('data', (d) => {
      tail = (tail + String(d)).slice(-2000)
    })
    child.stderr.on('data', (d) => {
      tail = (tail + String(d)).slice(-2000)
    })
    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      cleanup()
      if (code === 0) resolve()
      else reject(new Error(`egaki-chatgpt exit ${code ?? signal}: ${tail}`))
    })
  })
}

function persistGeneratedImage(outputPath: string): string {
  const filename = `${uuid()}${path.extname(outputPath) || '.png'}`
  const relativePath = `static/images/${filename}`
  const targetPath = getAbsolutePath(relativePath)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.copyFileSync(outputPath, targetPath)
  return relativePath
}
