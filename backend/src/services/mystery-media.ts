import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SourceMedia } from './history-source-pipeline.js'
import type { HistoryYoutubeCandidate, collectHistoryYoutubeVideos, downloadHistoryYoutubeVideo } from './history-source-youtube.js'
import { transcribeScienceSource } from './science-workflow-media.js'
import { planHistoryAudioChunks } from './history-script-processing.js'

interface MysteryDownloadOptions {
  signal: AbortSignal
  onMedia: (patch: Partial<SourceMedia>) => void
  report: (message: string) => void
  dependencies?: { collect?: typeof collectHistoryYoutubeVideos; download?: typeof downloadHistoryYoutubeVideo }
}
async function readJson(file: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}
async function writeJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await fs.rename(temporary, file) }
  finally { await fs.rm(temporary, { force: true }) }
}

/** Source files remain available for original-story and timing review after ASR. */
export async function downloadMysterySource(input: {
  sourceUrl: string; directory: string; media: SourceMedia; mode: 'video' | 'audio'
}, options: MysteryDownloadOptions): Promise<{ title: string; author: string; media: SourceMedia }> {
  options.signal.throwIfAborted()
  const youtube = await import('./history-source-youtube.js')
  const source = youtube.parseHistoryYoutubeUrl(input.sourceUrl)
  if (source.kind !== 'video' || !source.videoId) throw new Error('奇闻故事需要单条 YouTube 视频链接')
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
        if (candidate.sourceUrl !== source.url || candidate.videoId !== source.videoId || !candidate.title.trim()) throw new Error('YouTube 返回的视频与当前故事不一致')
        metadata = candidate
        await writeJson(metadataFile, { version: 1, candidate })
      },
    })
  }
  if (!metadata) throw new Error('未获取到 YouTube 视频信息，尚未开始下载')
  options.signal.throwIfAborted()
  const label = input.mode === 'video' ? '完整视频' : '音频'
  options.report(`正在下载 YouTube 来源${label}，失败后可继续原下载`)
  const media = await (options.dependencies?.download ?? youtube.downloadHistoryYoutubeVideo)({
    platform: 'youtube', sourceVideoId: source.videoId, sourceUrl: source.url,
  }, path.join(input.directory, input.mode === 'video' ? 'source.mp4' : 'source.m4a'),
  input.media.sourceUrl && input.media.sourceUrl !== source.url ? {} : input.media,
  patch => options.onMedia({ ...patch, sourceUrl: source.url }), { signal: options.signal, mode: input.mode })
  options.signal.throwIfAborted()
  if (media.downloadKind !== input.mode || !media.videoPath || !media.videoSha256 || media.downloadState !== 'done')
    throw new Error('来源下载未完成，或下载模式与请求不一致，不能开始转写')
  const completed = { ...media, sourceUrl: source.url }
  options.onMedia(completed)
  options.report(`YouTube 来源${label}下载完成，将保留供原稿核对`)
  return { title: metadata.title, author: metadata.authorName || '', media: completed }
}

export interface MysteryTranscriptChunk { start: number; duration: number; text: string }
export async function transcribeMysterySource(
  input: Parameters<typeof transcribeScienceSource>[0], options: Parameters<typeof transcribeScienceSource>[1],
): Promise<{ text: string; chunks: MysteryTranscriptChunk[] }> {
  const text = await transcribeScienceSource(input, options)
  options.signal.throwIfAborted()
  const saved = await readJson(path.join(input.directory, 'transcription.json'))
  if (saved?.version !== 1 || saved.videoSha256 !== input.videoSha256 || !Array.isArray(saved.chunks))
    throw new Error('转写的原始时间块缺失，已保留原媒体，请继续原任务')
  // Select the same complete chunk plan used by the shared transcriber. Cached
  // obsolete chunk sizes must never be exposed as duplicate/misaligned text.
  const pipeline = await import('./history-source-pipeline.js')
  const probe = await (options.dependencies?.probe ?? pipeline.probeHistoryVideo)(input.videoPath, { signal: options.signal })
  const expected = planHistoryAudioChunks(probe.duration)
  const tail = expected.at(-1), previous = expected.at(-2)
  if (previous && tail && tail.duration <= 20 && previous.duration + tail.duration <= 500) {
    previous.duration += tail.duration
    expected.pop()
  }
  const chunks = expected.map(chunk => {
    const cached = saved.chunks.find((item: any) => item?.start === chunk.start && item.duration === chunk.duration && typeof item.text === 'string' && item.text.trim())
    if (!cached) throw new Error('原稿未覆盖全部时间块，已完成部分保留，可继续转写')
    return { ...chunk, text: cached.text as string }
  })
  if (chunks.map(chunk => chunk.text).join('\n\n') !== text) throw new Error('原稿与时间块不一致，请核对转写检查点')
  return { text, chunks }
}
