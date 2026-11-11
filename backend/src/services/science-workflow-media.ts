import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { EmptyAsrTranscriptionError, planHistoryAudioChunks, transcribeHistoryAudio } from './history-script-processing.js'
import type { AudioChunk, SourceMedia } from './history-source-pipeline.js'
import type { collectHistoryYoutubeVideos, downloadHistoryYoutubeVideo, HistoryYoutubeCandidate } from './history-source-youtube.js'
import { releaseSourceMediaFiles } from './storage-source-manifest.js'

const exec = promisify(execFile)
const hashPattern = /^[a-f0-9]{64}$/i
async function readJson(file: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}
async function writeJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

interface DownloadOptions {
  signal: AbortSignal
  onMedia: (patch: Partial<SourceMedia>) => void
  report: (message: string) => void
  dependencies?: { collect?: typeof collectHistoryYoutubeVideos; download?: typeof downloadHistoryYoutubeVideo }
}
export async function downloadScienceSource(input: { sourceUrl: string; directory: string; media: SourceMedia }, options: DownloadOptions)
  : Promise<{ title: string; author: string; media: SourceMedia }> {
  options.signal.throwIfAborted()
  const youtube = await import('./history-source-youtube.js')
  const source = youtube.parseHistoryYoutubeUrl(input.sourceUrl)
  if (source.kind !== 'video' || !source.videoId) throw new Error('科普任务需要单条 YouTube 视频链接')
  await fs.mkdir(input.directory, { recursive: true })
  const metadataFile = path.join(input.directory, 'source-metadata.json')
  const saved = await readJson(metadataFile)
  let metadata: HistoryYoutubeCandidate | undefined = saved?.version === 1 && saved.candidate?.sourceUrl === source.url
    && saved.candidate.videoId === source.videoId && typeof saved.candidate.title === 'string' && saved.candidate.title.trim()
    && (saved.candidate.authorName === null || typeof saved.candidate.authorName === 'string') ? saved.candidate : undefined
  if (!metadata) {
    await (options.dependencies?.collect ?? youtube.collectHistoryYoutubeVideos)({
      url: source.url, signal: options.signal, targetCount: 1, isKnownVideo: () => false, isTargetReached: () => Boolean(metadata),
      report: event => options.report(event.message),
      onCandidate: async candidate => {
        if (candidate.sourceUrl !== source.url || candidate.videoId !== source.videoId || !candidate.title.trim()) throw new Error('YouTube 返回的视频与当前任务不一致')
        metadata = candidate
        await writeJson(metadataFile, { version: 1, candidate })
      },
    })
  }
  if (!metadata) throw new Error('未获取到 YouTube 视频信息，尚未开始下载')
  options.signal.throwIfAborted()
  options.report('正在下载 YouTube 来源音频，失败后可继续原下载')
  const targetPath = path.join(input.directory, 'source.mp4')
  const media = await (options.dependencies?.download ?? youtube.downloadHistoryYoutubeVideo)({
    platform: 'youtube', sourceVideoId: source.videoId, sourceUrl: source.url,
  }, targetPath, input.media.sourceUrl && input.media.sourceUrl !== source.url ? {} : input.media, options.onMedia, { signal: options.signal })
  options.signal.throwIfAborted()
  const completed = { ...media, sourceUrl: source.url }
  options.onMedia(completed)
  options.report('YouTube 来源音频下载完成')
  return { title: metadata.title, author: metadata.authorName || '', media: completed }
}

export interface ScienceTranscriptCheckpoint {
  version: 1
  sourceUrl: string
  sourceVideoSha256: string
  transcriptSha256: string
}

export function hasScienceTranscriptCheckpoint(input: {
  sourceUrl: string; media: SourceMedia; transcript: string; transcriptCheckpoint?: ScienceTranscriptCheckpoint
}) {
  const checkpoint = input.transcriptCheckpoint
  return Boolean(input.transcript.trim() && checkpoint?.version === 1 && checkpoint.sourceUrl === input.sourceUrl
    && hashPattern.test(checkpoint.sourceVideoSha256) && checkpoint.sourceVideoSha256 === input.media.videoSha256
    && checkpoint.transcriptSha256 === createHash('sha256').update(input.transcript).digest('hex'))
}

/** The caller saves the text and checkpoint atomically before reclaiming media. */
export async function releaseScienceSourceMedia(input: {
  directory: string; ownerId: string; sourceUrl: string; media: SourceMedia; transcript: string; checkpoint: ScienceTranscriptCheckpoint
}, options: { referenceTimeoutMs?: number } = {}): Promise<SourceMedia> {
  if (!hasScienceTranscriptCheckpoint({ ...input, transcriptCheckpoint: input.checkpoint })) throw new Error('来源媒体尚无完整转录检查点，不能清理')
  const cleanup = { ...input.media.cleanup }
  let freed = 0
  try {
    const directory = path.resolve(input.directory)
    const result = await releaseSourceMediaFiles({ directory, ownerType: 'science-job', ownerId: input.ownerId,
      sourceSha256: input.media.videoSha256!, transcriptSha256: input.checkpoint.transcriptSha256,
      fileHashes: { 'source.mp4': input.media.videoSha256! },
      referenceOptions: { isolated: true, timeoutMs: options.referenceTimeoutMs },
      matchesFile: name => /^source\.mp4(?:\.part)?$/.test(name) || /^asr-[a-f0-9]{16}-\d+\.wav(?:\.part)?$/.test(name)
        || /^source\.youtube\.[A-Za-z0-9_-]{11}(?:\.f\d+)?\.(?:mp4|m4a|webm|opus)(?:\.part(?:-Frag\d+)?)?$/.test(name),
    })
    freed = result.releasedBytes
    cleanup.manifestPath = path.join(directory, 'storage-release.json')
    if (result.error) throw Object.assign(new Error(result.error), { code: result.error })
    cleanup.localReleasedAt = result.releasedAt
    delete cleanup.error
  } catch (error) { cleanup.error = `来源媒体清理待重试：${(error as NodeJS.ErrnoException).code || '目录不可用'}` }
  cleanup.releasedBytes = (cleanup.releasedBytes || 0) + freed
  return { ...input.media, cleanup }
}

interface TranscriptionCache {
  version: 1
  model: string
  language: ''
  videoSha256: string
  chunks: Array<AudioChunk & { text: string; provider?: 'qwen' | 'minimax'; model?: string }>
}
interface TranscriptionOptions {
  signal: AbortSignal
  report: (message: string) => void
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  dependencies?: {
    probe?: typeof import('./history-source-pipeline.js').probeHistoryVideo
    extract?: typeof import('./history-source-pipeline.js').extractHistoryAudio
    transcribe?: typeof transcribeHistoryAudio
  }
}

export async function transcribeScienceSource(input: { videoPath: string; videoSha256: string; directory: string }, options: TranscriptionOptions): Promise<string> {
  options.signal.throwIfAborted()
  if (!hashPattern.test(input.videoSha256)) throw new Error('源视频校验信息无效，请重新下载')
  const pipeline = await import('./history-source-pipeline.js')
  if (await pipeline.sha256File(input.videoPath, options.signal) !== input.videoSha256) throw new Error('源视频已改变，请重新下载后转写')
  const probe = await (options.dependencies?.probe ?? pipeline.probeHistoryVideo)(input.videoPath, { signal: options.signal })
  const chunks = planHistoryAudioChunks(probe.duration)
  // A short isolated outro can have no recognizable speech. Keep its audio
  // with the preceding narration while staying inside MiniMax's 500s limit.
  const tail = chunks.at(-1), previous = chunks.at(-2)
  if (previous && tail && tail.duration <= 20 && previous.duration + tail.duration <= 500) {
    previous.duration += tail.duration
    chunks.pop()
    options.report('末段音频较短，已合并到前一段完整转写')
  }
  await fs.mkdir(input.directory, { recursive: true })
  const cacheFile = path.join(input.directory, 'transcription.json')
  const saved = await readJson(cacheFile)
  const cache: TranscriptionCache = saved?.version === 1 && typeof saved.model === 'string' && saved.model.trim() && saved.language === ''
    && saved.videoSha256 === input.videoSha256 && Array.isArray(saved.chunks)
    ? { ...saved, chunks: saved.chunks.filter((item: any) => item && Number.isFinite(item.start) && Number.isFinite(item.duration)
      && typeof item.text === 'string' && item.text.trim()) }
    : { version: 1, model: 'minimax-asr-1.0', language: '', videoSha256: input.videoSha256, chunks: [] }
  const texts: string[] = []
  for (const [index, chunk] of chunks.entries()) {
    options.signal.throwIfAborted()
    const cached = cache.chunks.find(item => item.start === chunk.start && item.duration === chunk.duration)
    if (cached) {
      options.report(`已恢复第 ${index + 1}/${chunks.length} 段原稿`)
      texts.push(cached.text)
      continue
    }
    options.report(`正在转写第 ${index + 1}/${chunks.length} 段原稿`)
    const audioPath = path.join(input.directory, `asr-${input.videoSha256.slice(0, 16)}-${index}.wav`)
    await (options.dependencies?.extract ?? pipeline.extractHistoryAudio)(input.videoPath, chunk, audioPath, { signal: options.signal })
    const transcribe = options.dependencies?.transcribe ?? transcribeHistoryAudio
    const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }))
    let result: Awaited<ReturnType<typeof transcribe>> | undefined
    for (let attempt = 1; ; attempt++) {
      options.signal.throwIfAborted()
      try {
        result = await transcribe(audioPath, chunk.duration, { signal: options.signal, language: '' })
        if (typeof result.text === 'string' && !result.text.trim()) throw new EmptyAsrTranscriptionError()
        if (typeof result.text !== 'string') throw new Error(`第 ${index + 1} 段转写缺少文本，已完成段落已保存，可继续重试`)
        if (!Number.isFinite(result.duration) || Math.abs(result.duration - chunk.duration) > Math.max(2, chunk.duration * 0.02))
          throw new Error(`第 ${index + 1} 段转写不完整，已完成段落已保存，可继续重试`)
        break
      } catch (error) {
        options.signal.throwIfAborted()
        if (!(error instanceof EmptyAsrTranscriptionError)) throw error
        if (attempt >= 3) throw new Error(`第 ${index + 1}/${chunks.length} 段转写连续 3 次返回空文本，已保留该段音频和已完成原稿，可继续重试`, { cause: error })
        const waitMs = 1500 * 2 ** (attempt - 1)
        options.report(`第 ${index + 1}/${chunks.length} 段转写返回空结果，${Math.ceil(waitMs / 1000)} 秒后自动重试（${attempt + 1}/3）`)
        await sleep(waitMs, options.signal)
      }
    }
    if (!result) throw new Error(`第 ${index + 1} 段转写未返回结果`)
    const text = result.text.trim()
    cache.chunks.push({ ...chunk, text, ...(result.provider ? { provider: result.provider } : {}), ...(result.model ? { model: result.model } : {}) })
    const models = new Set(cache.chunks.map(item => item.model === 'asr-1.0' ? 'minimax-asr-1.0' : item.model || 'minimax-asr-1.0'))
    cache.model = models.size === 1 ? [...models][0]! : 'mixed'
    // Preserve a successfully paid result even if cancellation arrives just after the response.
    await writeJson(cacheFile, cache)
    await fs.rm(audioPath, { force: true })
    options.signal.throwIfAborted()
    texts.push(text)
  }
  options.signal.throwIfAborted()
  if (texts.length !== chunks.length || texts.some(text => !text.trim())) throw new Error('原稿尚未全部转写完成')
  options.report('全部原稿转写完成')
  return texts.join('\n\n')
}

export interface UploadAssets {
  videoSha256: string
  landscapePath: string
  portraitPath: string
  landscapeSha256: string
  portraitSha256: string
}
async function validCover(file: string, width: number, height: number, expectedHash: string, signal: AbortSignal) {
  if (!hashPattern.test(expectedHash || '')) return false
  try {
    signal.throwIfAborted()
    const info = await sharp(file).metadata()
    if (info.format !== 'jpeg' || info.width !== width || info.height !== height) return false
    const { sha256File } = await import('./history-source-pipeline.js')
    return await sha256File(file, signal) === expectedHash
  } catch (error) { signal.throwIfAborted(); return false }
}
/** Inspect files bound to an existing upload without repairing or replacing them. */
export async function inspectScienceUploadAssets(input: { videoPath: string; landscapePath: string; portraitPath: string }, options: { signal: AbortSignal }): Promise<UploadAssets> {
  options.signal.throwIfAborted()
  const video = await fs.stat(input.videoPath)
  if (!video.isFile() || video.size <= 0) throw new Error('原上传成片为空或不存在，请核对原上传任务')
  const { sha256File } = await import('./history-source-pipeline.js')
  const [videoSha256, landscapeSha256, portraitSha256] = await Promise.all(
    [input.videoPath, input.landscapePath, input.portraitPath].map(file => sha256File(file, options.signal)),
  )
  if (!await validCover(input.landscapePath, 1280, 720, landscapeSha256, options.signal)
    || !await validCover(input.portraitPath, 810, 1080, portraitSha256, options.signal)) {
    throw new Error('原上传封面无效，请核对原上传任务；已保留原素材')
  }
  options.signal.throwIfAborted()
  return { videoSha256, landscapePath: input.landscapePath, portraitPath: input.portraitPath, landscapeSha256, portraitSha256 }
}
export interface SciencePosterAssetsInput {
  videoPath: string; directory: string; title: string; script: string
  sourceTitle?: string; instruction?: string; revision: number; presenterPath?: string
}
export async function prepareScienceUploadAssets(input: SciencePosterAssetsInput, options: {
  signal: AbortSignal
  report?: (message: string) => void
  generatePosters?: typeof import('./science-cover-poster.js').generateScienceCoverPosters
  coverStyle?: string
}): Promise<UploadAssets> {
  options.signal.throwIfAborted()
  const video = await fs.stat(input.videoPath)
  if (!video.isFile() || video.size <= 0) throw new Error('成片文件为空或不存在')
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input.videoPath], {
    signal: options.signal, timeout: 60_000, maxBuffer: 1024 * 1024,
  })
  const probe = JSON.parse(stdout)
  const videoStream = probe.streams?.find((stream: any) => stream.codec_type === 'video' && stream.width > 0 && stream.height > 0)
  const audioStream = probe.streams?.find((stream: any) => stream.codec_type === 'audio' && stream.channels > 0)
  const duration = Number(probe.format?.duration ?? videoStream?.duration)
  if (!videoStream || !audioStream || !Number.isFinite(duration) || duration <= 0) throw new Error('成片必须包含完整的视频画面和音轨')
  if (!input.title?.trim() || !input.script?.trim()) throw new Error('请先保存标题和文稿，再设计封面海报')
  const { sha256File } = await import('./history-source-pipeline.js')
  const videoSha256 = await sha256File(input.videoPath, options.signal)
  await fs.mkdir(input.directory, { recursive: true })
  const manifest = path.join(input.directory, 'upload-assets.json')
  const legacyInputs = [videoSha256, input.title, input.script,
    input.sourceTitle || '', input.instruction || '', input.revision, ...(options.coverStyle ? [options.coverStyle] : [])]
  const legacyInputDigest = createHash('sha256').update(JSON.stringify(legacyInputs)).digest('hex')
  const sciencePoster = !options.coverStyle || options.coverStyle === 'science-title-poster-v1'
  const { SCIENCE_COVER_COMPOSITION_VERSION, resolveScienceCoverPresenter } = await import('./science-cover-poster.js')
  // Custom generators own their assets unless an explicit presenter is supplied.
  const presenter = sciencePoster && (!options.generatePosters || input.presenterPath)
    ? await resolveScienceCoverPresenter(input.presenterPath) : undefined
  const compositionVersion = sciencePoster ? SCIENCE_COVER_COMPOSITION_VERSION : undefined
  const inputDigest = sciencePoster ? createHash('sha256').update(JSON.stringify([
    ...legacyInputs, compositionVersion, presenter?.sha256 || 'custom-generator',
  ])).digest('hex') : legacyInputDigest
  const saved = await readJson(manifest)
  if (saved?.version === 2 && saved.inputDigest === inputDigest
    && await validCover(saved.landscapePath, 1280, 720, saved.landscapeSha256, options.signal)
    && await validCover(saved.portraitPath, 810, 1080, saved.portraitSha256, options.signal)) {
    return { videoSha256, landscapePath: saved.landscapePath, portraitPath: saved.portraitPath,
      landscapeSha256: saved.landscapeSha256, portraitSha256: saved.portraitSha256 }
  }
  const legacyComposition = sciencePoster && saved?.version === 2 && saved.compositionVersion === undefined
    && saved.inputDigest === legacyInputDigest
  if (saved?.version === 2 && saved.inputDigest !== inputDigest && !legacyComposition) throw new Error('封面版本与当前文稿或指令不符，请重新生成新版本')
  const generate = options.generatePosters || (await import('./science-cover-poster.js')).generateScienceCoverPosters
  const posters = await generate(presenter ? { ...input, presenterPath: presenter.path } : input, { signal: options.signal, report: options.report })
  options.signal.throwIfAborted()
  const assets = await inspectScienceUploadAssets({ videoPath: input.videoPath, ...posters }, options)
  await writeJson(manifest, { version: 2, style: options.coverStyle || 'science-title-poster-v1', inputDigest,
    ...(sciencePoster ? { compositionVersion, presenterSha256: presenter?.sha256 } : {}), ...assets })
  return assets
}
