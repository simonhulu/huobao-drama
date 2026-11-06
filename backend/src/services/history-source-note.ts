import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import sharp from 'sharp'
import type { HistorySource } from './history-script-library.js'
import type { DownloaderConnection } from './history-source-pipeline.js'

const execFileAsync = promisify(execFile)
const ocrScript = fileURLToPath(new URL('../../scripts/history-sources/read-note-images.swift', import.meta.url))
export const HISTORY_NOTE_LIMITS = Object.freeze({
  images: 64, imageBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024,
  pixels: 40_000_000, textCharacters: 200_000,
})

export interface HistoryNoteImage {
  path: string
  sha256: string
  bytes: number
  index?: number
  name?: string
  mimeType?: string
  width?: number
  height?: number
  sourceSha256?: string
  sourceBytes?: number
  downloadId?: string
  text?: string
  ocrSha256?: string
}

export interface HistoryNoteMedia {
  kind: 'note'
  noteId?: string
  sourceUrl?: string
  caption?: string
  images?: HistoryNoteImage[]
  imageCount?: number
  downloadId?: string
  taskId?: string | null
  downloadState?: string
  parseTaskId?: string
  parseState?: string
  parseError?: string
  textSha256?: string
}

export interface HistoryNoteOptions {
  connection?: DownloaderConnection
  fetchFn?: typeof fetch
  pollMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  readImageText?: (imagePath: string, options: { signal?: AbortSignal }) => Promise<string>
}

interface RemoteImage { name: string; index: number; bytes: number; sha256?: string }
const hashPattern = /^[a-f0-9]{64}$/i
const localImagePattern = /^note-\d{3}\.(jpg|png|webp)$/

function safeError(error: unknown, secret?: string) {
  let message = error instanceof Error ? error.message : String(error)
  if (secret) message = message.replaceAll(secret, '[redacted]')
  return message.replace(/https?:\/\/[^\s"']+/g, '[url omitted]').slice(0, 2000)
}

function normalizeText(text: string) { return text.replace(/\r\n?/g, '\n').trim() }

function parseFailure(error: unknown, secret?: string) {
  const detail = safeError(error instanceof Error ? error : JSON.stringify(error ?? {}), secret)
  const action = /transport_failure|upstream unreachable|ConnectionError/i.test(detail)
    ? '请检查下载器网络和代理配置后重试；浏览器已登录不代表下载器接口通道可用'
    : '请检查下载器登录会话、原帖访问权限和网络后重试'
  return `图文解析归档失败：${detail}；${action}；尚未启动图片下载`
}

async function fileDigest(filePath: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(filePath, { signal })) hash.update(bytes)
  signal.throwIfAborted()
  return hash.digest('hex')
}

async function runSwift(args: string[], signal?: AbortSignal) {
  if (process.platform !== 'darwin') throw new Error('图文 OCR 需要 macOS Vision；请在 Mac 上重试，或配置 readImageText 识别器')
  try {
    const { stdout } = await execFileAsync('/usr/bin/swift', [ocrScript, ...args], {
      timeout: 90_000, maxBuffer: 1024 * 1024, signal,
    })
    return JSON.parse(stdout) as { text?: unknown; width?: unknown; height?: unknown }
  } catch (error) {
    signal?.throwIfAborted()
    throw new Error(`本机图文识别失败；请确认 Xcode Command Line Tools 可用，然后重试（已下载图片会保留）：${safeError(error)}`)
  }
}

export async function readHistoryNoteImageText(imagePath: string, options: { signal?: AbortSignal } = {}): Promise<string> {
  options.signal?.throwIfAborted()
  const result = await runSwift([imagePath], options.signal)
  if (typeof result.text !== 'string') throw new Error('本机 OCR 未返回文字结果；请重试，已下载图片会保留')
  if (result.text.length > HISTORY_NOTE_LIMITS.textCharacters) throw new Error('图文 OCR 返回文字超过单篇安全上限，请检查原图后重试')
  return normalizeText(result.text)
}

async function imageType(filePath: string) {
  const handle = await open(filePath, 'r')
  const header = Buffer.alloc(48)
  try { await handle.read(header, 0, header.length, 0) } finally { await handle.close() }
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg'
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (/^GIF8[79]a/.test(header.toString('ascii', 0, 6))) return 'gif'
  if (header.toString('ascii', 4, 8) === 'ftyp' && /avif|avis|heic|heix|hevc|hevx|mif1/.test(header.toString('ascii', 8))) return 'heif'
  throw new Error('下载内容不是支持的图片，可能是登录提示或失效链接；请检查下载器登录后重试')
}

async function normalizeImage(input: string, base: string, signal: AbortSignal, remainingBytes: number) {
  const type = await imageType(input)
  signal.throwIfAborted()
  let metadata: { width?: number; height?: number }
  let converted = false
  let extension = type === 'jpeg' ? 'jpg' : type
  const convertedPath = `${base}.jpg.part`
  try {
    metadata = await sharp(input, { limitInputPixels: HISTORY_NOTE_LIMITS.pixels, sequentialRead: true }).metadata()
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > HISTORY_NOTE_LIMITS.pixels) throw new Error('图片尺寸超过安全上限或无法读取')
    if (!['jpeg', 'png', 'webp'].includes(type)) {
      await unlink(convertedPath).catch(() => {})
      await sharp(input, { limitInputPixels: HISTORY_NOTE_LIMITS.pixels, sequentialRead: true }).rotate().jpeg({ quality: 92 }).toFile(convertedPath)
      metadata = await sharp(convertedPath, { limitInputPixels: HISTORY_NOTE_LIMITS.pixels }).metadata()
      converted = true
      extension = 'jpg'
    }
  } catch (error) {
    signal.throwIfAborted()
    if (type !== 'heif') throw error
    // macOS ImageIO can decode HEIC even when the installed libvips lacks HEVC.
    await unlink(convertedPath).catch(() => {})
    const result = await runSwift(['--normalize', input, convertedPath], signal)
    metadata = { width: Number(result.width), height: Number(result.height) }
    converted = true
    extension = 'jpg'
  }
  signal.throwIfAborted()
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > HISTORY_NOTE_LIMITS.pixels) throw new Error('图片尺寸超过安全上限或无法读取')
  const readyPath = converted ? convertedPath : input
  const info = await lstat(readyPath)
  if (!info.isFile() || info.size <= 0 || info.size > HISTORY_NOTE_LIMITS.imageBytes) throw new Error('图片大小超过 32 MiB 或文件为空')
  if (info.size > remainingBytes) throw new Error('转换后的图文图片超过 256 MiB 安全上限')
  const sha256 = await fileDigest(readyPath, signal)
  const targetPath = `${base}.${extension}`
  await rename(readyPath, targetPath)
  return { path: targetPath, sha256, bytes: info.size, mimeType: `image/${extension === 'jpg' ? 'jpeg' : extension}`, width: metadata.width, height: metadata.height }
}

async function reusableImage(image: HistoryNoteImage | undefined, directory: string, index: number, signal: AbortSignal) {
  if (!image || image.index !== index || !hashPattern.test(image.sha256) || !Number.isSafeInteger(image.bytes)
    || image.bytes <= 0 || image.bytes > HISTORY_NOTE_LIMITS.imageBytes) return false
  const expectedBase = `note-${String(index).padStart(3, '0')}`
  const filename = path.basename(image.path)
  if (!localImagePattern.test(filename) || !filename.startsWith(`${expectedBase}.`)
    || image.path !== path.join(directory, filename)) return false
  try {
    const info = await lstat(image.path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== image.bytes) return false
    if (await fileDigest(image.path, signal) !== image.sha256) return false
    await imageType(image.path)
    return true
  } catch (error) {
    signal.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return false
  }
}

function orderedImages(record: Record<string, unknown>, count: number): RemoteImage[] {
  const files = Array.isArray(record.files) ? record.files : []
  const images = files.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && item.kind === 'image')
  const failed = images.filter(image => image.state !== 'done')
  if (failed.length || images.length !== count) throw new Error(`图文图片不完整：原帖 ${count} 张，下载器返回 ${images.length} 张，其中 ${failed.length} 张未完成；请重试以补齐图片`)
  const ordered = images.map(image => {
    const match = typeof image.name === 'string' && /^image-(\d+)\.(jpe?g|png|webp|gif|avif|heic)$/i.exec(image.name)
    if (!match || !Number.isSafeInteger(image.bytes) || Number(image.bytes) <= 0 || Number(image.bytes) > HISTORY_NOTE_LIMITS.imageBytes
      || (image.sha256 != null && (typeof image.sha256 !== 'string' || !hashPattern.test(image.sha256)))) {
      throw new Error('图文图片清单无效：文件名、大小或校验值不正确；请重试下载')
    }
    return { name: String(image.name), index: Number(match[1]) - 1, bytes: Number(image.bytes), sha256: typeof image.sha256 === 'string' ? image.sha256.toLowerCase() : undefined }
  }).sort((a, b) => a.index - b.index)
  if (ordered.some((image, index) => image.index !== index)) throw new Error('图文图片序号缺失或重复；请重试以获取完整原帖')
  if (ordered.reduce((sum, image) => sum + image.bytes, 0) > HISTORY_NOTE_LIMITS.totalBytes) throw new Error('单篇图文图片超过 256 MiB 安全上限，请减少图片后重试')
  return ordered
}

export async function collectHistoryNote(
  source: HistorySource,
  directory: string,
  media: HistoryNoteMedia,
  checkpoint: (patch: Partial<HistoryNoteMedia>) => void,
  options: HistoryNoteOptions = {},
): Promise<{ media: HistoryNoteMedia; text: string }> {
  options.signal?.throwIfAborted()
  if (source.platform !== 'douyin' || !/^\d+$/.test(source.sourceVideoId)
    || source.sourceUrl !== `https://www.douyin.com/note/${source.sourceVideoId}`
    || media.kind !== 'note' || (media.noteId && media.noteId !== source.sourceVideoId)
    || (media.sourceUrl && media.sourceUrl !== source.sourceUrl)) throw new Error('图文来源与原帖地址不匹配，请重新采集该图文')
  if (!Number.isFinite(options.timeoutMs ?? 600_000) || (options.timeoutMs ?? 600_000) <= 0
    || !Number.isFinite(options.pollMs ?? 2000) || (options.pollMs ?? 2000) < 0) throw new Error('图文下载超时或轮询间隔无效')
  const operationSignal = AbortSignal.timeout(options.timeoutMs ?? 600_000)
  const signal = options.signal ? AbortSignal.any([options.signal, operationSignal]) : operationSignal
  directory = path.resolve(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let current: HistoryNoteMedia = { ...media, kind: 'note', noteId: source.sourceVideoId, sourceUrl: source.sourceUrl, images: [...(media.images ?? [])] }
  const save = (patch: Partial<HistoryNoteMedia>) => { current = { ...current, ...patch }; checkpoint(patch) }
  let connection: DownloaderConnection | undefined
  let ownedDownloadId: string | undefined
  let parsing = false
  const fetchFn = options.fetchFn ?? fetch
  const requestSignal = (timeout: number) => AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  try {
    const local = current.images ?? []
    let completeLocal = Number.isSafeInteger(current.imageCount) && current.imageCount! > 0
      && current.imageCount! <= HISTORY_NOTE_LIMITS.images && local.length === current.imageCount
      && local.reduce((sum, image) => sum + image.bytes, 0) <= HISTORY_NOTE_LIMITS.totalBytes
    if (completeLocal) {
      for (let index = 0; index < local.length; index++) {
        if (!await reusableImage(local[index], directory, index, signal)) { completeLocal = false; break }
      }
    }
    if (!completeLocal) {
      // Resolve lazily: the pipeline also imports this module, and completed local notes need no downloader.
      connection = options.connection ?? await (await import('./history-source-pipeline.js')).readHistoryDownloaderConnection()
      const base = new URL(connection.baseUrl)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol)
        || base.username || base.password || !connection.apiKey || base.search || base.hash || base.pathname !== '/') throw new Error('图文下载器必须使用无 URL 凭据的本地专用连接')
      const baseUrl = connection.baseUrl.replace(/\/$/, '')
      const request = async (route: string, body?: unknown) => {
        signal.throwIfAborted()
        const response = await fetchFn(`${baseUrl}${route}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          headers: { 'X-API-Key': connection!.apiKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal(30_000),
        })
        const envelope = await response.json() as { success?: boolean; data?: Record<string, unknown>; error?: unknown }
        signal.throwIfAborted()
        if (!response.ok || envelope.success !== true || !envelope.data || typeof envelope.data !== 'object') {
          throw Object.assign(new Error(`图文下载器 HTTP ${response.status}：${safeError(JSON.stringify(envelope.error ?? envelope), connection!.apiKey)}`), { httpStatus: response.status })
        }
        return envelope.data
      }
      const archiveRoute = `/api/v1/archive/douyin/${encodeURIComponent(source.sourceVideoId)}`
      let archived: Record<string, unknown> | undefined
      try { archived = await request(archiveRoute) } catch (error) {
        if ((error as { httpStatus?: number }).httpStatus !== 404) throw error
      }
      if (!archived) {
        parsing = true
        try {
          let parseTaskId = current.parseTaskId
          if (!parseTaskId || ['failed', 'expired', 'done'].includes(current.parseState ?? '')) {
            let submitted: Record<string, unknown>
            try {
              // A cached shaped result does not run the archive writer. Request a fresh async parse.
              submitted = await request('/api/v1/parse?refresh=true&wait=0', { url: source.sourceUrl, include_raw: false })
            } catch (error) { throw new Error(parseFailure(error, connection.apiKey)) }
            if (typeof submitted.task_id !== 'string' || !submitted.task_id) throw new Error('图文解析未返回 task_id，请重试；尚未启动图片下载')
            parseTaskId = submitted.task_id
            save({ parseTaskId, parseState: String(submitted.state ?? 'queued'), parseError: undefined })
          }
          for (;;) {
            let task: Record<string, unknown>
            try { task = await request(`/api/v1/tasks/${encodeURIComponent(parseTaskId)}`) } catch (error) {
              if ((error as { httpStatus?: number }).httpStatus === 404) {
                save({ parseState: 'expired' })
                throw new Error(`图文解析任务 ${parseTaskId} 已过期，请重试以重新解析归档；尚未启动图片下载`)
              }
              signal.throwIfAborted()
              throw new Error(`图文解析任务 ${parseTaskId} 查询失败：${safeError(error, connection.apiKey)}；请重试，将继续查询原解析任务；尚未启动图片下载`)
            }
            const state = String(task.state)
            if (current.parseState !== state || current.parseError) save({ parseState: state, parseError: undefined })
            if (state === 'failed') throw new Error(parseFailure(task.error, connection.apiKey))
            if (state === 'done') break
            if (!['queued', 'running'].includes(state)) throw new Error(`图文解析任务 ${parseTaskId} 返回未知状态 ${safeError(state)}，请检查下载器后重试；尚未启动图片下载`)
            await delay(options.pollMs ?? 2000, undefined, { signal })
          }
          try { archived = await request(archiveRoute) } catch (error) {
            if ((error as { httpStatus?: number }).httpStatus === 404) {
              throw new Error('图文解析任务已完成，但未写入归档；请检查下载器 archive.enabled 和归档写入日志后重试；尚未启动图片下载')
            }
            throw error
          }
        } catch (error) {
          if (!signal.aborted) save({ parseError: safeError(error, connection.apiKey) })
          throw error
        }
        parsing = false
      }
      const manifest = archived.media as { images?: unknown[] } | undefined
      if (archived.kind !== 'image_album' || archived.content_id !== source.sourceVideoId || archived.platform !== 'douyin'
        || !Array.isArray(manifest?.images) || !manifest.images.length) throw new Error('原帖未返回有效的完整图文清单，请检查原帖是否可访问后重试')
      const count = manifest.images.length
      if (count > HISTORY_NOTE_LIMITS.images) throw new Error('单篇图文超过 64 张图片安全上限')
      const visibleCaption = normalizeText(current.caption ?? '')
      const description = typeof archived.description === 'string' ? normalizeText(archived.description) : ''
      save({ imageCount: count, caption: description.length > visibleCaption.length ? description : visibleCaption,
        ...(current.parseError ? { parseError: undefined } : {}) })
      let downloadId = current.downloadId
      if (!downloadId || ['failed', 'cancelled', 'expired'].includes(current.downloadState ?? '')) {
        const submitted = await request('/api/v1/downloads', { url: source.sourceUrl, skip_existing: !['failed', 'cancelled', 'expired'].includes(current.downloadState ?? '') })
        if (typeof submitted.download_id !== 'string' || !submitted.download_id) throw new Error('图文下载器未返回 download_id，请重试')
        downloadId = submitted.download_id
        if (!submitted.reused) ownedDownloadId = downloadId
        save({ downloadId, taskId: typeof submitted.task_id === 'string' ? submitted.task_id : null, downloadState: String(submitted.state ?? 'queued') })
      }
      let record: Record<string, unknown>
      for (;;) {
        try { record = await request(`/api/v1/downloads/${encodeURIComponent(downloadId)}`) } catch (error) {
          if ((error as { httpStatus?: number }).httpStatus === 404) save({ downloadId: undefined, taskId: null, downloadState: 'expired' })
          throw error
        }
        const state = String(record.state)
        save({ downloadState: state })
        if (state === 'done' || state === 'partial') {
          if (record.on_disk === false) {
            save({ downloadId: undefined, taskId: null, downloadState: 'expired' })
            throw new Error('图文下载器缓存已过期，已保留本地图片；请重试以补齐缺失图片')
          }
          break
        }
        if (state === 'failed' || state === 'cancelled') throw new Error(`图文下载失败（${state}），请检查下载器登录后重试：${safeError(JSON.stringify(record.error), connection.apiKey)}`)
        if (!['queued', 'running'].includes(state)) throw new Error(`图文下载器返回未知状态 ${safeError(state)}，请检查下载器后重试`)
        await delay(options.pollMs ?? 2000, undefined, { signal })
      }
      if ((record.platform !== undefined && record.platform !== 'douyin')
        || (record.content_id !== undefined && record.content_id !== source.sourceVideoId)) throw new Error('下载器返回了其他帖子的文件，已停止处理；请重新采集')
      let ordered: RemoteImage[]
      try { ordered = orderedImages(record, count) } catch (error) { save({ downloadState: 'failed' }); throw error }
      const images: HistoryNoteImage[] = []
      for (const remote of ordered) {
        signal.throwIfAborted()
        const cached = current.images?.find(image => image.index === remote.index && image.name === remote.name)
        const sameSource = cached && (remote.sha256 ? cached.sourceSha256 === remote.sha256 : cached.downloadId === downloadId && cached.sourceBytes === remote.bytes)
        if (sameSource && await reusableImage(cached, directory, remote.index, signal)) {
          images.push(cached)
          continue
        }
        const basePath = path.join(directory, `note-${String(remote.index).padStart(3, '0')}`)
        const partialPath = `${basePath}.download.part`
        let bytes = 0
        const hash = createHash('sha256')
        try {
          const response = await fetchFn(`${baseUrl}/api/v1/downloads/${encodeURIComponent(downloadId)}/files/${encodeURIComponent(remote.name)}`, {
            headers: { 'X-API-Key': connection.apiKey }, redirect: 'error', signal: requestSignal(120_000),
          })
          if (!response.ok || !response.body) {
            if (response.status === 404) save({ downloadId: undefined, taskId: null, downloadState: 'expired' })
            throw new Error(`第 ${remote.index + 1} 张图下载失败（HTTP ${response.status}），请重试；已下载图片会复用`)
          }
          const contentLength = response.headers.get('content-length')
          if (contentLength && Number(contentLength) !== remote.bytes) {
            await response.body.cancel()
            throw new Error(`第 ${remote.index + 1} 张图大小与下载记录不符，请重试`)
          }
          const mime = response.headers.get('content-type')?.split(';')[0]?.trim()
          if (mime && !mime.startsWith('image/') && mime !== 'application/octet-stream') {
            await response.body.cancel()
            throw new Error(`第 ${remote.index + 1} 张图返回了非图片内容，请检查下载器登录后重试`)
          }
          await unlink(partialPath).catch(() => {})
          const measure = new Transform({ transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length
            hash.update(chunk)
            done(bytes > HISTORY_NOTE_LIMITS.imageBytes || bytes > remote.bytes ? new Error(`第 ${remote.index + 1} 张图超出下载大小上限`) : null, chunk)
          } })
          await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), measure, createWriteStream(partialPath, { mode: 0o600, flags: 'wx' }), { signal })
          signal.throwIfAborted()
          const sourceSha256 = hash.digest('hex')
          if (bytes !== remote.bytes || (remote.sha256 && sourceSha256 !== remote.sha256)) throw new Error(`第 ${remote.index + 1} 张图大小或 SHA256 校验失败，请重试`)
          const normalized = await normalizeImage(partialPath, basePath, signal, HISTORY_NOTE_LIMITS.totalBytes - images.reduce((sum, image) => sum + image.bytes, 0))
          const image: HistoryNoteImage = { ...normalized, index: remote.index, name: remote.name, sourceSha256, sourceBytes: bytes, downloadId }
          images.push(image)
          // Keep later cached slides too: a failed transfer must not discard their checkpoints.
          save({ images: [...images, ...(current.images ?? []).filter(item => (item.index ?? -1) > remote.index)].sort((a, b) => (a.index ?? -1) - (b.index ?? -1)) })
        } finally {
          await unlink(partialPath).catch(() => {})
          await unlink(`${basePath}.jpg.part`).catch(() => {})
        }
      }
      if (images.reduce((sum, image) => sum + image.bytes, 0) > HISTORY_NOTE_LIMITS.totalBytes) throw new Error('转换后的图文图片超过 256 MiB 安全上限')
      save({ images, downloadState: 'done' })
    }
    const readImageText = options.readImageText ?? readHistoryNoteImageText
    const images = [...current.images!]
    for (let index = 0; index < images.length; index++) {
      signal.throwIfAborted()
      const image = images[index]!
      if (typeof image.text === 'string' && image.ocrSha256 === image.sha256) continue
      let text: string
      try { text = await readImageText(image.path, { signal }) } catch (error) {
        signal.throwIfAborted()
        throw new Error(`第 ${index + 1} 张图文字识别失败；请重试，将复用已下载图片及已识别文字：${safeError(error, connection?.apiKey ?? options.connection?.apiKey)}`)
      }
      signal.throwIfAborted()
      if (typeof text !== 'string' || text.length > HISTORY_NOTE_LIMITS.textCharacters) throw new Error(`第 ${index + 1} 张图 OCR 结果无效，请重试文字识别`)
      images[index] = { ...image, text: normalizeText(text), ocrSha256: image.sha256 }
      save({ images: [...images] })
    }
    const text = [normalizeText(current.caption ?? ''), ...images.map(image => image.text!)].filter(Boolean).join('\n\n')
    if (!text.trim()) throw new Error('图片未识别到文字，原帖也没有可用正文；请检查原图或补充原文后重试')
    if (text.length > HISTORY_NOTE_LIMITS.textCharacters) throw new Error('图文文字超过单篇安全上限，请检查原帖后重试')
    signal.throwIfAborted()
    return { media: current, text }
  } catch (error) {
    // Cancel only this invocation's newly created transfer, never a shared or resumed job.
    if (options.signal?.aborted && ownedDownloadId && connection) {
      try {
        const response = await fetchFn(`${connection.baseUrl.replace(/\/$/, '')}/api/v1/downloads/${encodeURIComponent(ownedDownloadId)}`, {
          method: 'DELETE', headers: { 'X-API-Key': connection.apiKey }, redirect: 'error', signal: AbortSignal.timeout(5000),
        })
        if (response.ok) save({ downloadState: 'cancelled' })
      } catch { /* The checkpoint still allows recovery after the downloader returns. */ }
    }
    const message = parsing && signal.aborted
      ? `图文解析${options.signal?.aborted ? '已取消' : '超时'}；${current.parseTaskId ? `解析任务 ${current.parseTaskId} 已保留，` : ''}请重试，将继续解析归档；尚未启动图片下载`
      : operationSignal.aborted && !options.signal?.aborted
      ? '图文采集超时；请重试，将复用原 download_id、已下载图片及已识别文字'
      : options.signal?.aborted ? '图文采集已取消；已下载图片及识别检查点会保留' : safeError(error, connection?.apiKey ?? options.connection?.apiKey)
    if (parsing && signal.aborted) save({ parseError: message })
    throw new Error(message)
  }
}
