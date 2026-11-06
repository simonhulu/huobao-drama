import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { getHistorySource, getHistorySourceArtifactState, updateHistorySource, type HistorySource } from './history-script-library.js'
import { db } from '../db/index.js'
import { hasProducedHistoryYoutubeScript } from './history-youtube-recollection.js'
import { estimateHistoryScriptTiming, historyTranscriptReviewSchema } from './history-script-processing.js'
import type { HistoryRecreationPlan, HistoryRecreationResult } from './history-script-recreation.js'
import { getScienceWritingModel } from './science-writing-model.js'
import type { HistoryNoteMedia, collectHistoryNote } from './history-source-note.js'
import { assertMediaDiskSpace } from './storage-space.js'
import { releaseSourceMediaFiles } from './storage-source-manifest.js'
import { NonRetryableTaskError } from './tasks/types.js'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const HISTORY_SCRIPT_STORAGE_ROOT = path.join(projectRoot, 'data/storage/history-scripts')
export const HISTORY_DOWNLOADER_CONNECTION = path.join(projectRoot, 'data/storage/history-source-downloader/connection.json')

/** The provider explicitly refused this request; a collection must pause, not skip its source. */
export class HistorySourceRateLimitError extends NonRetryableTaskError {
  readonly status=429
  constructor(message:string,readonly retryAfterMs?:number) {
    super(message,'history_source_rate_limited');this.name='HistorySourceRateLimitError'
  }
}

export function isHistorySourceRateLimitError(error:unknown) {
  if (error instanceof HistorySourceRateLimitError) return true
  if (error && typeof error==='object') {
    const detail=error as {status?:unknown;httpStatus?:unknown;statusCode?:unknown}
    const status=detail.status ?? detail.httpStatus ?? detail.statusCode
    if (status!==undefined) return status===429
  }
  // Older adapters preserve an HTTP status only in the leading error message.
  // An arbitrary mention of 429, a network failure or a timeout is not a refusal.
  const message=error instanceof Error ? error.message : String(error)
  return /^(?:Text model request failed:\s*|(?:Downloader\s+)?HTTP(?:\s+(?:error|status))?\s*:?\s*|API error\s+)429\b/i.test(message)
}

export interface DownloaderConnection { baseUrl: string; apiKey: string }
export interface AudioChunk { start: number; duration: number }
export interface AudioResult {
  text: string
  duration: number
  provider?: 'qwen' | 'minimax'
  model?: string
  segments?: Array<{ start: number; end: number; text: string; speaker?: string }>
  trace_id?: string
}
export interface TranscriptReview {
  correctedTranscript: string
  corrections: Array<{ before: string; after: string; reason: string }>
  factualConcerns: Array<{ claim: string; reason: string; searchQuery: string }>
  factCheckStatus: 'needs_sources'
}
export interface MediaProbe { duration: number; audioStreamIndex: number; formatName?: string }
export interface SourceMedia extends Partial<HistoryNoteMedia> {
  downloadId?: string
  taskId?: string | null
  downloadState?: string
  downloadKind?: 'audio' | 'video'
  videoPath?: string
  videoSha256?: string
  videoBytes?: number
  probe?: MediaProbe
  chunks?: Array<AudioChunk & { path?: string; sha256: string }>
  cleanup?: { localReleasedAt?: string; downloaderReleasedAt?: string; releasedBytes?: number; downloaderFreedBytes?: number; manifestPath?: string; error?: string }
}
interface AsrCache {
  model: string
  complete: boolean
  sourceVideoSha256?: string
  chunks: Array<AudioChunk & { index: number; audioSha256: string; result: AudioResult }>
  text?: string
  duration?: number
  segments?: AudioResult['segments']
}

export async function readHistoryDownloaderConnection(filePath = HISTORY_DOWNLOADER_CONNECTION): Promise<DownloaderConnection> {
  const connection = z.object({ baseUrl: z.url(), apiKey: z.string().min(1) }).parse(JSON.parse(await readFile(filePath, 'utf8')))
  const url = new URL(connection.baseUrl)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('History downloader connection must use a local service without URL credentials')
  }
  return { ...connection, baseUrl: connection.baseUrl.replace(/\/$/, '') }
}

function safeError(error: unknown, secret?: string) {
  let message = error instanceof Error ? error.message : String(error)
  if (secret) message = message.replaceAll(secret, '[redacted]')
  return message.replace(/https?:\/\/[^\s"']+/g, '[url omitted]').slice(0, 4000)
}

export async function sha256File(filePath: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(filePath)) { signal?.throwIfAborted(); hash.update(bytes) }
  return hash.digest('hex')
}

async function nonemptyFile(filePath: string) {
  try { const info = await stat(filePath); return info.isFile() && info.size > 0 } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function downloadHistoryVideo(
  source: HistorySource,
  targetPath: string,
  media: SourceMedia,
  checkpoint: (patch: Partial<SourceMedia>) => void,
  options: { connection?: DownloaderConnection; fetchFn?: typeof fetch; pollMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SourceMedia> {
  options.signal?.throwIfAborted()
  if (source.platform === 'youtube') {
    return (await import('./history-source-youtube.js')).downloadHistoryYoutubeVideo(source, targetPath, media, checkpoint, options)
  }
  if (media.videoPath === targetPath && media.videoSha256 && await nonemptyFile(targetPath)
    && await sha256File(targetPath, options.signal) === media.videoSha256) return media
  await assertMediaDiskSpace(path.dirname(targetPath), 1024 ** 3)
  const connection = options.connection ?? await readHistoryDownloaderConnection()
  const fetchFn = options.fetchFn ?? fetch
  const requestSignal = (timeout: number) => options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
  let ownedDownloadId: string | undefined
  const request = async (route: string, body?: unknown) => {
    const response = await fetchFn(`${connection.baseUrl}${route}`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: { 'X-API-Key': connection.apiKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: requestSignal(30_000),
    })
    const envelope = await response.json() as { success?: boolean; data?: Record<string, unknown>; error?: unknown }
    if (!response.ok || envelope.success !== true || !envelope.data) {
      throw Object.assign(new Error(`Downloader HTTP ${response.status}: ${safeError(JSON.stringify(envelope.error ?? envelope), connection.apiKey)}`), { httpStatus: response.status })
    }
    return envelope.data
  }
  try {
    let downloadId = media.downloadId
    if (!downloadId || ['failed', 'cancelled', 'expired'].includes(media.downloadState ?? '')) {
      const submitted = await request('/api/v1/downloads', { url: source.sourceUrl, skip_existing: media.downloadState !== 'expired' })
      if (typeof submitted.download_id !== 'string' || !submitted.download_id) throw new Error('Downloader did not return a download_id')
      downloadId = submitted.download_id
      if (!submitted.reused) ownedDownloadId = downloadId
      checkpoint({ downloadId, taskId: typeof submitted.task_id === 'string' ? submitted.task_id : null, downloadState: String(submitted.state ?? 'queued') })
    }
    const deadline = Date.now() + (options.timeoutMs ?? 600_000)
    let completed: Record<string, unknown> | undefined
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted()
      let record: Record<string, unknown>
      try {
        record = await request(`/api/v1/downloads/${encodeURIComponent(downloadId)}`)
      } catch (error) {
        if ((error as { httpStatus?: number }).httpStatus === 404) {
          checkpoint({ downloadId: undefined, taskId: null, downloadState: 'expired' })
        }
        throw error
      }
      const state = String(record.state)
      checkpoint({ downloadState: state })
      if (state === 'done' || state === 'partial') {
        if (record.on_disk === false) {
          checkpoint({ downloadId: undefined, taskId: null, downloadState: 'expired' })
          throw new Error('Downloader cache was evicted; retry submits a fresh source download')
        }
        const files = Array.isArray(record.files) ? record.files : []
        completed = files.find(file => file && typeof file === 'object' && file.kind === 'video' && file.state === 'done')
        if (!completed) {
          checkpoint({ downloadId: undefined, taskId: null, downloadState: 'expired' })
          throw new Error(`Downloader ${state} without a completed video: ${safeError(JSON.stringify(record.error ?? files), connection.apiKey)}`)
        }
        break
      }
      if (state === 'failed' || state === 'cancelled') throw new Error(`Downloader ${state}: ${safeError(JSON.stringify(record.error), connection.apiKey)}`)
      if (!['queued', 'running'].includes(state)) throw new Error(`Unexpected downloader state: ${state}`)
      await delay(options.pollMs ?? 2000, undefined, { signal: options.signal })
    }
    if (!completed) throw new Error('Timed out waiting for the source video download; retry resumes its download_id')
    const name = z.string().min(1).parse(completed.name)
    const expectedBytes = completed.bytes === undefined ? undefined : z.number().positive().parse(completed.bytes)
    const expectedSha = completed.sha256 == null ? undefined : z.string().regex(/^[a-fA-F0-9]{64}$/).parse(completed.sha256).toLowerCase()
    const response = await fetchFn(`${connection.baseUrl}/api/v1/downloads/${encodeURIComponent(downloadId)}/files/${encodeURIComponent(name)}`, {
      headers: { 'X-API-Key': connection.apiKey }, signal: requestSignal(180_000),
    })
    if (!response.ok || !response.body) {
      if (response.status === 404) checkpoint({ downloadId: undefined, taskId: null, downloadState: 'expired' })
      throw new Error(`Video file transfer failed: HTTP ${response.status}`)
    }
    const partialPath = `${targetPath}.part`
    let bytes = 0
    const hash = createHash('sha256')
    try {
      const measure = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length
        hash.update(chunk)
        done(bytes > 1024 * 1024 * 1024 ? new Error('Video exceeds the 1 GiB local download limit') : null, chunk)
      } })
      await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), measure, createWriteStream(partialPath, { mode: 0o600 }), { signal: options.signal })
      options.signal?.throwIfAborted()
      const sha256 = hash.digest('hex')
      if (!bytes || (expectedBytes !== undefined && bytes !== expectedBytes)) throw new Error('Downloaded video size does not match its completed record')
      if (expectedSha && sha256 !== expectedSha) throw new Error('Downloaded video SHA256 does not match its completed record')
      await rename(partialPath, targetPath)
      return { downloadId, videoPath: targetPath, videoSha256: sha256, videoBytes: bytes }
    } catch (error) {
      await unlink(partialPath).catch(() => {})
      throw error
    }
  } catch (error) {
    // Only cancel a download created by this invocation, never a shared cached job.
    if (options.signal?.aborted && ownedDownloadId) {
      try {
        const response = await fetchFn(`${connection.baseUrl}/api/v1/downloads/${encodeURIComponent(ownedDownloadId)}`, {
          method: 'DELETE', headers: { 'X-API-Key': connection.apiKey }, signal: AbortSignal.timeout(5000),
        })
        if (response.ok) checkpoint({ downloadState: 'cancelled' })
      } catch { /* A disconnected downloader cannot acknowledge cancellation. */ }
    }
    throw new Error(safeError(error, connection.apiKey))
  }
}

export async function probeHistoryVideo(filePath: string, options: { signal?: AbortSignal } = {}): Promise<MediaProbe> {
  options.signal?.throwIfAborted()
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], { timeout: 60_000, maxBuffer: 1024 * 1024, signal: options.signal })
  const probe = JSON.parse(stdout)
  const audio = probe.streams?.find((stream: { codec_type?: string }) => stream.codec_type === 'audio')
  if (!audio) throw new Error('Source video has no audio stream')
  const duration = Number(probe.format?.duration ?? audio.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Source video has an invalid duration')
  return { duration, audioStreamIndex: audio.index, formatName: probe.format?.format_name }
}

export async function extractHistoryAudio(videoPath: string, chunk: AudioChunk, audioPath: string, options: { signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted()
  const partialPath = `${audioPath}.part`
  try {
    await execFileAsync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
      '-ss', String(chunk.start), '-t', String(chunk.duration), '-map', '0:a:0',
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', partialPath,
    ], { timeout: 300_000, maxBuffer: 1024 * 1024, signal: options.signal })
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', partialPath], { timeout: 60_000, signal: options.signal })
    const probe = JSON.parse(stdout)
    const stream = probe.streams?.[0]
    if (stream?.codec_name !== 'pcm_s16le' || Number(stream?.sample_rate) !== 16000 || stream?.channels !== 1) {
      throw new Error('Extracted audio must be mono 16 kHz PCM WAV')
    }
    const duration = Number(probe.format?.duration)
    if (!Number.isFinite(duration) || Math.abs(duration - chunk.duration) > 2) throw new Error('Extracted audio is shorter than the planned chunk')
    await rename(partialPath, audioPath)
  } catch (error) { await unlink(partialPath).catch(() => {}); throw error }
}

export interface HistoryPipelineDependencies {
  downloadVideo: typeof downloadHistoryVideo
  probeVideo: typeof probeHistoryVideo
  extractAudio: typeof extractHistoryAudio
  planChunks: (duration: number) => Promise<AudioChunk[]> | AudioChunk[]
  transcribeAudio: (filePath: string, duration: number, signal?: AbortSignal) => Promise<AudioResult>
  correctTranscript: (text: string, signal?: AbortSignal) => Promise<TranscriptReview>
  recreateScript: (text: string, review: TranscriptReview, signal?: AbortSignal, sourceTitle?: string, sourceAuthor?: string,
    planning?: {plan?: HistoryRecreationPlan; onPlan?: (plan: HistoryRecreationPlan) => void | Promise<void>}) => Promise<HistoryRecreationResult>
  collectNote?: typeof collectHistoryNote
  releaseDownload?: typeof releaseHistoryDownloaderMedia
  enqueueHuasheng?: (sourceId: number) => Promise<unknown>
  huashengEnabled?: () => boolean | Promise<boolean>
}

export interface HistoryPipelineProgress {
  stage: 'downloading' | 'extracting' | 'transcribing' | 'correcting' | 'rewriting' | 'storing'
  message: string
}

const defaultDependencies: HistoryPipelineDependencies = {
  downloadVideo: downloadHistoryVideo,
  probeVideo: probeHistoryVideo,
  extractAudio: extractHistoryAudio,
  planChunks: async duration => (await import('./history-script-processing.js')).planHistoryAudioChunks(duration),
  transcribeAudio: async (filePath, duration, signal) => (await import('./history-script-processing.js')).transcribeHistoryAudio(filePath, duration, { signal }),
  correctTranscript: async (text, signal) => (await import('./history-script-processing.js')).correctHistoryTranscript(text, undefined, { signal }),
  recreateScript: async (text, review, signal, sourceTitle, sourceAuthor, planning) => (await import('./history-script-recreation.js')).recreateHistoryScript(text, review, { ...planning, signal, sourceTitle, sourceAuthor }),
  collectNote: async (...args) => (await import('./history-source-note.js')).collectHistoryNote(...args),
  releaseDownload: releaseHistoryDownloaderMedia,
  enqueueHuasheng: async sourceId => (await import('./history-huasheng.js')).enqueueHistoryHuashengSource(sourceId),
  huashengEnabled: async () => (await import('./history-huasheng.js')).getHistoryHuashengService().enabled,
}

function sourceDirectory(id: number, storageRoot: string) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid history source id')
  return path.join(storageRoot, String(id))
}

export async function acquireHistorySourceLock(id: number, storageRoot = HISTORY_SCRIPT_STORAGE_ROOT) {
  const directory = sourceDirectory(id, storageRoot)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lockPath = path.join(directory, 'process.lock')
  const token = createHash('sha256').update(`${hostname()}:${process.pid}:${Date.now()}:${Math.random()}`).digest('hex')
  let handle
  try { handle = await open(lockPath, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`History source ${id} is locked. After its process stops, run history-sources/run.ts unlock ${id}.`)
    throw error
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), token }))
  await handle.close()
  return async () => {
    const record = JSON.parse(await readFile(lockPath, 'utf8'))
    if (record.token !== token) throw new Error('History source lock ownership changed')
    await unlink(lockPath)
  }
}

export async function unlockHistorySource(id: number, storageRoot = HISTORY_SCRIPT_STORAGE_ROOT) {
  const lockPath = path.join(sourceDirectory(id, storageRoot), 'process.lock')
  const owner = z.object({ pid: z.number().int().positive(), hostname: z.string() }).parse(JSON.parse(await readFile(lockPath, 'utf8')))
  if (owner.hostname !== hostname()) throw new Error('Lock belongs to another host; confirm that host is stopped before manually removing it')
  try { process.kill(owner.pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(lockPath); return }
    throw error
  }
  throw new Error(`Source is still owned by running process ${owner.pid}; its lock was kept`)
}

export async function releaseHistoryDownloaderMedia(source: HistorySource, options: {
  connection?: DownloaderConnection; fetchFn?: typeof fetch; signal?: AbortSignal
} = {}) {
  if (source.platform !== 'douyin' || getHistorySourceArtifactState(source).transcript !== 'current') {
    throw new Error('Only source media with a complete saved transcript can be released')
  }
  const connection = options.connection ?? await readHistoryDownloaderConnection()
  try {
    // DELETE /downloads/:id only cancels transfers. This endpoint actually frees
    // files for this one source in the dedicated downloader service.
    const response = await (options.fetchFn ?? fetch)(`${connection.baseUrl}/api/v1/archive/delete`, {
      method: 'POST', headers: { 'X-API-Key': connection.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ platform: 'douyin', content_id: source.sourceVideoId }], media: true }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    })
    const result = await response.json() as { success?: boolean; data?: { freed_bytes?: number }; error?: unknown }
    if (!response.ok || result.success !== true || !result.data) throw new Error(`Downloader cleanup HTTP ${response.status}`)
    return { freedBytes: typeof result.data.freed_bytes === 'number' ? Math.max(0, result.data.freed_bytes) : 0 }
  } catch (error) { throw new Error(safeError(error, connection.apiKey)) }
}

// Callers hold the source lock. The saved transcript and hashes remain the
// checkpoint even if a crash happens between deleting files and saving cleanup.
async function releaseSourceMedia(source: HistorySource, storageRoot: string,
  releaseDownload?: typeof releaseHistoryDownloaderMedia, signal?: AbortSignal): Promise<HistorySource> {
  if (!['douyin', 'youtube'].includes(source.platform) || getHistorySourceArtifactState(source).transcript !== 'current') return source
  const media = JSON.parse(source.mediaJson) as SourceMedia
  const cleanup = { ...media.cleanup }
  const errors: string[] = []
  if (media.kind !== 'note' && !cleanup.localReleasedAt) {
    let freed = 0
    try {
      const root = await realpath(storageRoot)
      const directory = sourceDirectory(source.id, root)
      const result = await releaseSourceMediaFiles({ directory, ownerType: 'history-source', ownerId: String(source.id),
        sourceSha256: media.videoSha256!, transcriptSha256: textHash(source.rawTranscript!),
        fileHashes: Object.fromEntries([['source.mp4', media.videoSha256!],
          ...(media.chunks || []).map((chunk, index) => [`audio-${String(index).padStart(3, '0')}.wav`, chunk.sha256])]),
        matchesFile: name => /^(?:source\.mp4|audio-\d+\.wav)(?:\.part)?$/.test(name)
          || /^source\.youtube\.[A-Za-z0-9_-]{11}(?:\.f\d+)?\.(?:mp4|m4a|webm|opus)(?:\.part(?:-Frag\d+)?)?$/.test(name),
      })
      freed = result.releasedBytes
      cleanup.manifestPath = path.join(directory, 'storage-release.json')
      if (result.error) throw Object.assign(new Error(result.error), { code: result.error })
      cleanup.localReleasedAt = result.releasedAt
      delete media.videoPath
      media.chunks = media.chunks?.map(({ path: _path, ...chunk }) => chunk)
    } catch (error) {
      errors.push(`本地临时素材清理失败（${(error as NodeJS.ErrnoException).code || '目录不可用'}），可稍后重试`)
    }
    cleanup.releasedBytes = (cleanup.releasedBytes || 0) + freed
  }
  if (source.platform === 'douyin' && releaseDownload && media.downloadId && !cleanup.downloaderReleasedAt) {
    try {
      const result = await releaseDownload(source, { signal })
      cleanup.downloaderReleasedAt = new Date().toISOString()
      cleanup.downloaderFreedBytes = (cleanup.downloaderFreedBytes || 0) + result.freedBytes
    } catch (error) { errors.push(`下载器缓存清理待重试：${safeError(error)}`) }
  }
  cleanup.error = errors.length ? errors.join('；') : undefined
  media.cleanup = cleanup
  const mediaJson = JSON.stringify(media)
  if (mediaJson === source.mediaJson) return source
  const updated = updateHistorySource(source.id, { mediaJson })
  if (!updated) throw new Error('History source was removed during media cleanup')
  return updated
}

export async function cleanupHistorySourceMedia(id: number, options: {
  storageRoot?: string; releaseDownload?: typeof releaseHistoryDownloaderMedia
} = {}) {
  const storageRoot = options.storageRoot ?? HISTORY_SCRIPT_STORAGE_ROOT
  const release = await acquireHistorySourceLock(id, storageRoot)
  try {
    const source = getHistorySource(id)
    if (!source) throw new Error(`History source ${id} not found`)
    return await releaseSourceMedia(source, storageRoot, options.releaseDownload ?? releaseHistoryDownloaderMedia)
  } finally { await release() }
}

function textHash(text: string) { return createHash('sha256').update(text).digest('hex') }

function completedHistoryStage(source: HistorySource, fallback: string) {
  const artifacts = getHistorySourceArtifactState(source)
  if (artifacts.rewritten === 'current') return 'needs_review'
  if (artifacts.corrected === 'current') return 'corrected'
  if (artifacts.transcript === 'current') return 'transcribed'
  return fallback
}

function validateAudioResult(result: AudioResult, expectedDuration: number) {
  if (!result.text?.trim() || !Number.isFinite(result.duration) || result.duration <= 0 || Math.abs(result.duration - expectedDuration) > Math.max(2, expectedDuration * 0.02)) {
    throw new Error('ASR returned an empty or incomplete transcript for the audio chunk')
  }
  for (const segment of result.segments ?? []) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start || segment.end > result.duration + 2 || typeof segment.text !== 'string') {
      throw new Error('ASR returned invalid segment timestamps')
    }
  }
}

function transcriptionModel(chunks: AsrCache['chunks']): string {
  const models = new Set(chunks.map(chunk => chunk.result.model || 'asr-1.0'))
  return models.size === 1 ? [...models][0]! : 'mixed'
}

export async function processHistorySource(id: number, options: {
  through?: 'download' | 'asr' | 'correct' | 'recreate'
  storageRoot?: string
  dependencies?: Partial<HistoryPipelineDependencies>
  signal?: AbortSignal
  onProgress?: (progress: HistoryPipelineProgress) => void
} = {}): Promise<HistorySource> {
  options.signal?.throwIfAborted()
  const through = z.enum(['download', 'asr', 'correct', 'recreate']).parse(options.through ?? 'recreate')
  if (!getHistorySource(id)) throw new Error(`History source ${id} not found`)
  const storageRoot = options.storageRoot ?? HISTORY_SCRIPT_STORAGE_ROOT
  const release = await acquireHistorySourceLock(id, storageRoot)
  const deps = {
    ...defaultDependencies, ...options.dependencies,
    // Injected model/media fixtures must opt in to the new external integration.
    enqueueHuasheng: options.dependencies ? options.dependencies.enqueueHuasheng : defaultDependencies.enqueueHuasheng,
    huashengEnabled: options.dependencies ? options.dependencies.huashengEnabled : defaultDependencies.huashengEnabled,
    releaseDownload: options.dependencies ? options.dependencies.releaseDownload : defaultDependencies.releaseDownload,
  }
  const check = () => options.signal?.throwIfAborted()
  const progress = (stage: HistoryPipelineProgress['stage'], message: string) => { check(); options.onProgress?.({ stage, message }); check() }
  const save = (patch: Parameters<typeof updateHistorySource>[1]) => {
    const updated = updateHistorySource(id, patch)
    if (!updated) throw new Error('History source was removed during processing')
    return updated
  }
  try {
    if (path.resolve(storageRoot)===path.resolve(HISTORY_SCRIPT_STORAGE_ROOT)) {
      const {restoreTaskArchivedMedia}=await import('./storage-archive.js')
      await restoreTaskArchivedMedia('history-source',String(id),projectRoot)
      check()
    }
    let source = getHistorySource(id)
    if (!source) throw new Error(`History source ${id} not found`)
    if (source.platform === 'baijiahao') {
      if (getHistorySourceArtifactState(source).transcript !== 'current') throw new Error('文章原文校验未通过，不能进行二创')
      if (through === 'download' || through === 'asr') return source
    } else if (getHistorySourceArtifactState(source).transcript === 'current') {
      source = await releaseSourceMedia(source, storageRoot, deps.releaseDownload, options.signal)
      if (through === 'download' || through === 'asr') return save({ status: completedHistoryStage(source, 'transcribed'), lastError: null })
    } else if ((JSON.parse(source.mediaJson) as SourceMedia).kind === 'note') {
      let media = JSON.parse(source.mediaJson) as HistoryNoteMedia
      save({ status: 'downloading', lastError: null })
      progress('downloading', '正在下载抖音图文并提取图片文字')
      const result = await deps.collectNote!(source, sourceDirectory(id, storageRoot), media, patch => {
        media = { ...media, ...patch }
        save({ mediaJson: JSON.stringify(media) })
      }, { signal: options.signal })
      check()
      const rawTranscript = result.text.trim()
      if (!rawTranscript) throw new Error('抖音图文没有可读取的正文，已保留图片供重试')
      source = save({ status: 'transcribed', rawTranscript, asrJson: null,
        mediaJson: JSON.stringify({ ...result.media, kind: 'note', noteId: source.sourceVideoId,
          sourceUrl: source.sourceUrl, textSha256: textHash(rawTranscript) }), lastError: null })
      if (getHistorySourceArtifactState(source).transcript !== 'current') throw new Error('图文正文尚未完整保存，已保留下载检查点')
      source = await releaseSourceMedia(source, storageRoot, deps.releaseDownload, options.signal)
      progress('storing', '图文及正文已保存，保留来源图片与原链接')
      if (through === 'download' || through === 'asr') return source
    } else {
      let media = JSON.parse(source.mediaJson) as SourceMedia
      const checkpoint = (patch: Partial<SourceMedia>) => { media = { ...media, ...patch }; save({ mediaJson: JSON.stringify(media) }) }
      const directory = sourceDirectory(id, storageRoot)
      const videoPath = path.join(directory, 'source.mp4')
      let existingVideo = media.videoPath === videoPath && await nonemptyFile(videoPath)
      if (existingVideo && media.videoSha256) existingVideo = await sha256File(videoPath, options.signal) === media.videoSha256
      check()
      if (!existingVideo) {
        save({ status: 'downloading', lastError: null })
        progress('downloading', source.platform === 'youtube' ? '正在下载来源音频' : '正在下载来源视频')
        const downloaded = await deps.downloadVideo(source, videoPath, media, checkpoint, { signal: options.signal })
        check()
        if (!await nonemptyFile(videoPath)) throw new Error('Downloader did not produce a nonempty local video')
        checkpoint({ ...downloaded, videoPath, videoSha256: await sha256File(videoPath, options.signal), probe: undefined, chunks: undefined, cleanup: undefined })
      }
      check()
      const probe = media.probe ?? await deps.probeVideo(videoPath, { signal: options.signal })
      check()
      if (!Number.isFinite(probe.duration) || probe.duration <= 0 || !Number.isInteger(probe.audioStreamIndex) || probe.audioStreamIndex < 0) {
        throw new Error('Source video has no usable audio stream or duration')
      }
      checkpoint({ probe })
      source = save({ status: completedHistoryStage(getHistorySource(id)!, 'downloaded'), lastError: null })
      if (through === 'download') return source

      const plan = await deps.planChunks(probe.duration)
      check()
      if (!plan.length || plan.some(chunk => !Number.isFinite(chunk.start) || !Number.isFinite(chunk.duration) || chunk.start < 0 || chunk.duration <= 0 || chunk.duration > 480)) {
        throw new Error('Invalid audio chunk plan')
      }
      let plannedEnd = 0
      for (const chunk of plan) {
        if (Math.abs(chunk.start - plannedEnd) > 0.001) throw new Error('Audio chunk plan contains a gap or overlap')
        plannedEnd = chunk.start + chunk.duration
      }
      if (Math.abs(plannedEnd - probe.duration) > 0.001) throw new Error('Audio chunk plan does not cover the full source')
      const priorChunks = media.chunks ?? []
      const cache = source.asrJson ? JSON.parse(source.asrJson) as AsrCache : { model: 'asr-1.0', complete: false, chunks: [] }
      if (!Array.isArray(cache.chunks)) throw new Error('Stored ASR checkpoint has no chunks array')
      const results: AsrCache['chunks'] = []
      const chunks: NonNullable<SourceMedia['chunks']> = []
      save({ status: 'transcribing', lastError: null })
      for (const [index, chunk] of plan.entries()) {
        check()
        const audioPath = path.join(directory, `audio-${String(index).padStart(3, '0')}.wav`)
        const previous = priorChunks[index]
        let reusableAudio = previous?.path === audioPath && previous.start === chunk.start && previous.duration === chunk.duration && await nonemptyFile(audioPath)
        if (reusableAudio) reusableAudio = await sha256File(audioPath, options.signal) === previous.sha256
        if (!reusableAudio) {
          progress('extracting', `正在提取音频 ${index + 1}/${plan.length}`)
          await deps.extractAudio(videoPath, chunk, audioPath, { signal: options.signal })
        }
        check()
        const audioSize = (await stat(audioPath)).size
        if (audioSize <= 44 || audioSize > 20 * 1024 * 1024) throw new Error('Extracted audio is empty or exceeds the 20 MiB ASR chunk limit')
        const audioSha256 = await sha256File(audioPath, options.signal)
        chunks.push({ ...chunk, path: audioPath, sha256: audioSha256 })
        checkpoint({ chunks: [...chunks] })
        const reused = cache.chunks.find(entry => entry.index === index && entry.start === chunk.start && entry.duration === chunk.duration && entry.audioSha256 === audioSha256)
        progress('transcribing', reused ? `复用已完成转写 ${index + 1}/${plan.length}` : `正在转写 ${index + 1}/${plan.length}`)
        const result = reused?.result ?? await deps.transcribeAudio(audioPath, chunk.duration, options.signal)
        validateAudioResult(result, chunk.duration)
        results.push({ ...chunk, index, audioSha256, result })
        save({ asrJson: JSON.stringify({ model: transcriptionModel(results), sourceVideoSha256: media.videoSha256, complete: false, chunks: results }) })
        check()
      }
      const rawTranscript = results.map(chunk => chunk.result.text.trim()).join('\n\n')
      const segments = results.flatMap(chunk => (chunk.result.segments ?? []).map(segment => ({ ...segment, start: segment.start + chunk.start, end: segment.end + chunk.start })))
      source = save({ status: 'transcribed', rawTranscript, asrJson: JSON.stringify({ model: transcriptionModel(results), sourceVideoSha256: media.videoSha256, complete: true, chunks: results, text: rawTranscript, duration: probe.duration, segments }), lastError: null })
      source = await releaseSourceMedia(source, storageRoot, deps.releaseDownload, options.signal)
      const cleanup = (JSON.parse(source.mediaJson) as SourceMedia).cleanup
      progress('storing', cleanup?.error ? `转录已保存；${cleanup.error}`
        : '转录已保存，已清理来源媒体和分段音频，保留原链接与文字检查点')
      if (through === 'asr') return save({ status: completedHistoryStage(source, 'transcribed') })
    }

    const rawTranscript = source.rawTranscript!
    let review = source.reviewJson ? JSON.parse(source.reviewJson) as TranscriptReview & { rawTranscriptSha256?: string; correctedTranscriptSha256?: string; rewriteInputSha256?: string; recreationPlan?: HistoryRecreationPlan; scriptCondensation?: Record<string, unknown>;
      youtubeRecollection?: {taskId: number; previousScriptSha256: string; startedAt: string} } : undefined
    const rawTranscriptSha256 = textHash(rawTranscript)
    check()
    if (!source.correctedTranscript?.trim() || review?.rawTranscriptSha256 !== rawTranscriptSha256 || review.correctedTranscriptSha256 !== textHash(source.correctedTranscript) || !historyTranscriptReviewSchema.safeParse(review).success) {
      save({ status: 'correcting', lastError: null })
      progress('correcting', '正在校对转写并标记史料疑点')
      const corrected = historyTranscriptReviewSchema.parse(await deps.correctTranscript(rawTranscript, options.signal))
      review = { ...corrected, rawTranscriptSha256, correctedTranscriptSha256: textHash(corrected.correctedTranscript),
        ...(review?.youtubeRecollection ? {youtubeRecollection: review.youtubeRecollection} : {}) }
      source = save({ status: 'corrected', correctedTranscript: corrected.correctedTranscript, reviewJson: JSON.stringify(review), lastError: null })
    }
    check()
    if (through === 'correct') return save({ status: completedHistoryStage(source, 'corrected') })
    const rewriteInputSha256 = textHash(source.correctedTranscript!)
    if (!source.rewrittenScript?.trim() || review?.rewriteInputSha256 !== rewriteInputSha256) {
      save({ status: 'rewriting', lastError: null })
      const { historyScriptCharacters, HISTORY_SCRIPT_TARGET_CHARACTERS } = await import('./history-script-recreation.js')
      progress('rewriting', historyScriptCharacters(source.correctedTranscript!) > HISTORY_SCRIPT_TARGET_CHARACTERS
        ? `正在使用 ${getScienceWritingModel()} 保留主线与关键事实，缩写至约15分钟口播稿`
        : `正在使用 ${getScienceWritingModel()} 保持原意，调整全文表达与句间衔接`)
      const { script, plan, title, coverText, skillName, skillRevision, skillSha256, provider, model,
        analysisProvider, analysisModel, analysis, angles, selectedAngleId, selectionReason, writingOutline } = await deps.recreateScript(source.correctedTranscript!, review!, options.signal, source.title, source.authorName ?? undefined, {
        plan: review?.recreationPlan,
        onPlan(plan) {
          check()
          review = { ...review!, recreationPlan: plan }
          source = save({ reviewJson: JSON.stringify(review) })
          progress('rewriting', '原稿拆解、材料与新稿大纲已保存，正在使用远程写作模型按大纲写正文并压缩重复表达')
        },
      })
      check()
      if (!script?.trim()) throw new Error('二创模型未返回有效稿件')
      if (review?.youtubeRecollection && (review.youtubeRecollection.previousScriptSha256 === textHash(script)
        || hasProducedHistoryYoutubeScript(db.$client, id, textHash(script)))) {
        throw new Error('本轮二创与已过期成片的旧稿完全相同，已保留旧稿和检查点；请调整二创方向后继续，未重复提交旧版制作')
      }
      const recreation = { title, coverText, skillName, skillRevision, skillSha256, provider, model,
        analysisProvider, analysisModel, analysis, angles, selectedAngleId, selectionReason, writingOutline }
      const draftOrigin = recreation.skillName === 'history-source-paraphrase' ? 'source_paraphrase'
        : recreation.skillName === 'history-perspective-recreation' ? 'perspective_recreation'
        : recreation.skillName === 'water-koubo' ? 'water_koubo' : 'light_edit'
      if (draftOrigin === 'source_paraphrase') delete review!.recreationPlan
      if (skillRevision === 'history-source-condensed-v1') {
        const { historyScriptCondensationRecord } = await import('./history-script-preparation.js')
        review!.scriptCondensation = historyScriptCondensationRecord(source.correctedTranscript!, { script, title, coverText, skillName, skillRevision, skillSha256, provider, model })
      }
      progress('storing', '二创已完成，正在保存稿件')
      source = save({ rewrittenScript: script,
        reviewJson: JSON.stringify({ ...review, ...(plan ? { recreationPlan: plan } : {}), rewriteInputSha256, draftOrigin, recreation }) })
    }
    let queueAutomatically = Boolean(deps.enqueueHuasheng)
    let checkEnabledOnRecovery = false
    if (queueAutomatically && deps.huashengEnabled) {
      try { queueAutomatically = await deps.huashengEnabled() }
      catch (error) {
        checkEnabledOnRecovery = true
        console.warn(`[history-huasheng] admission settings need rechecking before submission: ${safeError(error)}`)
      }
    }
    check()
    const completed = save({ status: 'needs_review', reviewJson: JSON.stringify({
      ...JSON.parse(source.reviewJson!), scriptTiming: estimateHistoryScriptTiming(source.rewrittenScript!),
      ...(queueAutomatically ? { huashengQueue: { status: 'pending', productionMode: 'dual', scriptSha256: textHash(source.rewrittenScript!), requestedAt: new Date().toISOString(),
        ...(checkEnabledOnRecovery ? { checkEnabled: true } : {}),
      } } : {}),
    }), lastError: null })
    // Save the successful draft first. Browser/queue outages must never mark recreation failed.
    if (queueAutomatically && deps.enqueueHuasheng) {
      try { await deps.enqueueHuasheng(id) }
      catch (error) { console.warn(`[history-huasheng] source ${id} was saved but could not be queued: ${safeError(error)}`) }
    }
    return completed
  } catch (error) {
    // A delete may finish after the initial lookup but before this process acquires its lock.
    if (!getHistorySource(id)) throw error
    if (options.signal?.aborted) {
      const source = getHistorySource(id)!
      const media = JSON.parse(source.mediaJson) as SourceMedia
      const fallback = media.videoSha256 && await nonemptyFile(path.join(sourceDirectory(id, storageRoot), 'source.mp4')) ? 'downloaded' : 'selected'
      save({ status: completedHistoryStage(source, fallback), lastError: '采集已停止，已完成阶段和检查点保留' })
      throw error
    }
    const message = safeError(error)
    if (isHistorySourceRateLimitError(error)) {
      const source=getHistorySource(id)!,media=JSON.parse(source.mediaJson) as SourceMedia
      const fallback=media.videoSha256 && await nonemptyFile(path.join(sourceDirectory(id,storageRoot),'source.mp4')) ? 'downloaded' : 'selected'
      save({status:completedHistoryStage(source,fallback),lastError:message})
      const retryAfterMs=(error as {retryAfterMs?:number})?.retryAfterMs
      throw new HistorySourceRateLimitError(message,Number.isFinite(retryAfterMs) && retryAfterMs!>=0 ? retryAfterMs : undefined)
    }
    save({ status: 'failed', lastError: message })
    throw new Error(message)
  } finally { await release() }
}
