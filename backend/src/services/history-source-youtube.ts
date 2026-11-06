import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import type { HistorySource } from './history-script-library.js'
import type { SourceMedia } from './history-source-pipeline.js'
import { parseHistoryYoutubeUrl } from './history-source-youtube-url.js'
import { NonRetryableTaskError } from './tasks/types.js'
import { assertMediaDiskSpace } from './storage-space.js'
import { historyYoutubeBinary, historyYoutubeNetworkArgs as youtubeNetworkArgs } from './history-source-youtube-options.js'
export { historyYoutubeBinary } from './history-source-youtube-options.js'
export { DEFAULT_HISTORY_YOUTUBE_URL, parseHistoryYoutubeUrl } from './history-source-youtube-url.js'

const videoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/)

export class HistoryYoutubeLoginRequiredError extends NonRetryableTaskError {
  constructor(message = 'YouTube 要求登录或人机验证，采集已暂停；请在 Chrome 中完成验证，刷新 YouTube 登录后继续采集，已保存来源和下载进度保留') {
    super(message, 'youtube_login_required')
    this.name = 'HistoryYoutubeLoginRequiredError'
  }
}

export function isHistoryYoutubeLoginError(error: unknown) {
  // The source pipeline sanitizes provider errors into a new Error; recognize its preserved message too.
  return error instanceof HistoryYoutubeLoginRequiredError
    || /YouTube 要求登录|Sign in to confirm you.?re not a bot/i.test(error instanceof Error ? error.message : String(error))
}

export interface HistoryYoutubeCandidate {
  videoId: string
  sourceUrl: string
  title: string
  authorName: string | null
  channelId?: string
  channelUrl?: string
  durationSeconds?: number
  viewCount?: number
  publishedAt?: string
  observedAt: string
  collectionUrl: string
}

type YoutubeInfo = Record<string, unknown>
const nonemptyText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

export function historyYoutubeCandidate(info: YoutubeInfo, parent: YoutubeInfo, collectionUrl: string): HistoryYoutubeCandidate | null {
  const videoId = videoIdSchema.safeParse(info.id)
  const title = nonemptyText(info.title)
  if (!videoId.success || !title || /^\[(?:private|deleted) video\]$/i.test(title)
    || ['is_live', 'is_upcoming', 'post_live'].includes(String(info.live_status))
    || ['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(String(info.availability))) return null
  const channelId = nonemptyText(info.channel_id) ?? nonemptyText(parent.channel_id)
  return {
    videoId: videoId.data, sourceUrl: `https://www.youtube.com/watch?v=${videoId.data}`, title,
    authorName: nonemptyText(info.channel) ?? nonemptyText(info.uploader) ?? nonemptyText(parent.channel) ?? nonemptyText(parent.uploader) ?? null,
    channelId,
    channelUrl: channelId && /^UC[A-Za-z0-9_-]{22}$/.test(channelId) ? `https://www.youtube.com/channel/${channelId}` : undefined,
    durationSeconds: nonnegative(info.duration), viewCount: nonnegative(info.view_count),
    publishedAt: typeof info.upload_date === 'string' && /^\d{8}$/.test(info.upload_date) ? info.upload_date : undefined,
    observedAt: new Date().toISOString(), collectionUrl,
  }
}

export function storeHistoryYoutubeSource(input: HistoryYoutubeCandidate): HistorySource {
  const videoId = videoIdSchema.parse(input.videoId)
  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`
  if (input.sourceUrl !== sourceUrl || !input.title.trim()) throw new Error('YouTube 来源标题或链接与视频 ID 不一致')
  const ts = new Date().toISOString()
  // Existing originals, deleted identities and paid-work checkpoints must never be reset by collection.
  const inserted = db.insert(schema.historyScriptSources).values({
    platform: 'youtube', sourceVideoId: videoId, sourceUrl, title: input.title.trim(), authorName: input.authorName,
    category: 'unclassified', metricsJson: JSON.stringify({ reads: input.viewCount }),
    selectionJson: JSON.stringify({ collector: 'yt-dlp', reason: '用户指定的 YouTube 频道或视频', ...input }),
    createdAt: ts, updatedAt: ts,
  }).onConflictDoNothing({ target: [schema.historyScriptSources.platform, schema.historyScriptSources.sourceVideoId] }).returning().get()
  return inserted ?? db.select().from(schema.historyScriptSources).where(and(
    eq(schema.historyScriptSources.platform, 'youtube'), eq(schema.historyScriptSources.sourceVideoId, videoId),
  )).get()!
}

export type HistoryYoutubeRunner = (args: string[], options: { signal?: AbortSignal; timeoutMs: number }) => Promise<{ stdout: string }>

function youtubeCommandError(error: unknown) {
  const failure = error as { message?: string; stderr?: string; code?: string }
  if (failure.code === 'ENOENT') return new Error('未找到 yt-dlp，请安装 yt-dlp 或设置 HISTORY_YOUTUBE_YTDLP_BIN')
  if (/sign in to confirm|not a bot|login required|use --cookies-from-browser or --cookies/i.test(String(failure.stderr || failure.message || error))) {
    return new HistoryYoutubeLoginRequiredError()
  }
  const message = String(failure.stderr || failure.message || error)
    .replace(/(?:https?|socks5h?):\/\/[^\s"']+/g, '[网址省略]')
    .replace(/\/(?:Users|home|private|tmp|var)\/[^\s"']+/g, '[本地路径省略]').slice(-1500)
  return new Error(`YouTube 读取或下载失败：${message}；网络不可达时请配置 HISTORY_YOUTUBE_PROXY；解析失效时请更新 yt-dlp`)
}

export const runYoutube: HistoryYoutubeRunner = async (args, options) => {
  const startedAt = Date.now()
  const execute = (commandArgs: string[], timeoutMs: number) => promisify(execFile)(historyYoutubeBinary(), commandArgs, {
    signal: options.signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
  })
  try {
    let result
    try { result = await execute(args, options.timeoutMs) }
    catch (error) {
      options.signal?.throwIfAborted()
      const failure = error as { stderr?: string }
      const cookieIndex = args.indexOf('--cookies-from-browser')
      const remainingMs = options.timeoutMs - (Date.now() - startedAt)
      // Browser profile access can fail in background services even when public content needs no login.
      if (cookieIndex < 0 || remainingMs <= 0 || !/could not find .+ cookies database/i.test(failure.stderr || '')) throw error
      const anonymousArgs = [...args.slice(0, cookieIndex), ...args.slice(cookieIndex + 2)]
      result = await execute(anonymousArgs, remainingMs)
    }
    const { stdout } = result
    return { stdout }
  } catch (error) {
    options.signal?.throwIfAborted()
    throw youtubeCommandError(error)
  }
}

export async function refreshHistoryYoutubeSession(sourceUrl: string, options: {
  signal?: AbortSignal
  runner?: HistoryYoutubeRunner
  exportCookies?: (output: string, browser: string, signal?: AbortSignal) => Promise<void>
} = {}) {
  const source = parseHistoryYoutubeUrl(sourceUrl)
  if (source.kind !== 'video') throw new Error('请先选择一条已保存的 YouTube 视频检测下载权限')
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
  const output = process.env.HISTORY_YOUTUBE_COOKIES_FILE?.trim() || path.join(projectRoot, 'data/secrets/history-youtube/cookies.txt')
  const browser = process.env.HISTORY_YOUTUBE_COOKIES_BROWSER?.trim() || 'chrome'
  const exportCookies = options.exportCookies ?? (async (output: string, browser: string, signal?: AbortSignal) => {
    const localPython = path.join(homedir(), '.agent-reach/tools/history-youtube/bin/python3')
    const python = process.env.HISTORY_YOUTUBE_PYTHON_BIN?.trim() || (existsSync(localPython) ? localPython : 'python3')
    const [browserName, ...profile] = browser.split(':')
    try {
      await promisify(execFile)(python, [path.join(projectRoot, 'backend/scripts/history-sources/export-youtube-cookies.py'), output,
        '--browser', browserName!, ...(profile.length ? ['--profile', profile.join(':')] : [])],
      { signal, timeout: 45_000, maxBuffer: 1024 * 1024, encoding: 'utf8' })
    } catch {
      signal?.throwIfAborted()
      throw new Error('无法读取浏览器的 YouTube 登录。请在 Chrome 中打开该视频并完成登录或人机验证，再刷新 YouTube 登录；已保存来源保留')
    }
  })
  let exported = true
  try { await exportCookies(output, browser, options.signal) }
  catch (error) {
    options.signal?.throwIfAborted()
    const saved = await stat(output).catch(() => null)
    if (!saved?.isFile() || !saved.size) throw error
    // macOS can deny background Chrome access while the dedicated exported session remains valid.
    exported = false
  }
  process.env.HISTORY_YOUTUBE_COOKIES_FILE = output
  try {
    await (options.runner ?? runYoutube)([...youtubeNetworkArgs(), '--simulate', '--no-playlist', '--print', 'id', '--', source.url],
      { signal: options.signal, timeoutMs: 90_000 })
  } catch (error) {
    options.signal?.throwIfAborted()
    if (!exported) throw new Error('后台无法读取 Chrome 登录，且已保存的 YouTube 会话未通过下载检测；请在 Chrome 完成验证，并通过终端导出登录后重试。操作见 docs/history-youtube-collection-recovery.md')
    throw error
  }
  return { message: exported ? 'YouTube 登录已刷新，视频下载权限检测通过，可以继续采集'
    : '已保存的 YouTube 登录通过视频下载权限检测，可以继续采集；当前后台无法直接读取 Chrome 登录' }
}

export interface HistoryYoutubeCollectionOptions {
  url: string
  signal: AbortSignal
  targetCount: number | null
  isKnownVideo: (id: string) => boolean
  knownVideoReason?: (id: string) => string
  isTargetReached: () => boolean
  onCandidate: (candidate: HistoryYoutubeCandidate) => Promise<void>
  report: (event: { stage: string; message: string; scanned?: number; browserUrl?: string;
    candidate?: { outcome: 'selected' | 'skipped'; videoId: string; title?: string; reason?: string; durationSeconds?: number } }) => void
}

/** Read only a small channel page at a time; persist/process each new video before requesting more. */
export async function collectHistoryYoutubeVideos(options: HistoryYoutubeCollectionOptions, runner: HistoryYoutubeRunner = runYoutube) {
  const source = parseHistoryYoutubeUrl(options.url)
  const seen = new Set<string>()
  const pageSize = 30
  let scanned = 0
  for (let start = 1; ; start += pageSize) {
    options.signal.throwIfAborted()
    if (options.isTargetReached()) return
    options.report({ stage: 'browsing', message: source.kind === 'channel' ? `正在读取 YouTube 频道视频（第 ${start} 条起）` : '正在读取 YouTube 视频信息', browserUrl: source.url, scanned })
    // Channel listings otherwise use YouTube's English localization for translated titles.
    const args = [...youtubeNetworkArgs(), '--extractor-args', 'youtube:lang=zh-CN', '--dump-single-json', '--skip-download',
      ...(source.kind === 'channel' ? ['--flat-playlist', '--playlist-items', `${start}:${start + pageSize - 1}`] : ['--no-playlist']), '--', source.url]
    const { stdout } = await runner(args, { signal: options.signal, timeoutMs: 180_000 })
    let info: YoutubeInfo
    try { info = JSON.parse(stdout) } catch { throw new Error('YouTube 返回的元数据无效，请更新 yt-dlp 后重试') }
    if (!info || typeof info !== 'object') throw new Error('YouTube 未返回有效视频信息')
    const entries = source.kind === 'video' ? [info] : info.entries
    if (!Array.isArray(entries)) throw new Error('YouTube 频道未返回视频列表，请检查频道链接')
    let freshIds = 0
    for (const raw of entries) {
      options.signal.throwIfAborted()
      if (options.isTargetReached()) return
      scanned++
      const rawId = raw && typeof raw === 'object' ? videoIdSchema.safeParse(raw.id) : null
      if (rawId?.success && seen.has(rawId.data)) continue
      if (rawId?.success) { seen.add(rawId.data); freshIds++ }
      const candidate = raw && typeof raw === 'object' ? historyYoutubeCandidate(raw, info, source.url) : null
      if (!candidate) {
        if (source.kind === 'video') throw new Error('该 YouTube 视频当前不可用，可能已删除、设为私密或仍在直播')
        continue
      }
      if (source.kind === 'video' && candidate.videoId !== source.videoId) throw new Error('YouTube 返回的视频 ID 与输入链接不一致')
      const known = options.isKnownVideo(candidate.videoId)
      const reason = known ? options.knownVideoReason?.(candidate.videoId) ?? '来源已保存，避免重复制作；失败记录可单独重试' : '用户指定频道或视频'
      options.report({ stage: known ? 'skipping' : 'selecting', message: known ? `跳过 YouTube 来源：${reason}` : `发现新视频：${candidate.title}`, scanned,
        candidate: { outcome: known ? 'skipped' : 'selected', videoId: candidate.videoId, title: candidate.title,
          durationSeconds: candidate.durationSeconds, reason } })
      if (!known) await options.onCandidate(candidate)
    }
    if (source.kind === 'video' || entries.length < pageSize) {
      options.report({ stage: 'exhausted', message: 'YouTube 来源已检索完毕', scanned })
      return
    }
    if (!freshIds) throw new Error('YouTube 分页未返回新视频，已停止采集，避免重复循环；已有来源保留')
  }
}

export async function downloadHistoryYoutubeVideo(source: Pick<HistorySource, 'sourceUrl' | 'sourceVideoId' | 'platform'>, targetPath: string, media: SourceMedia,
  checkpoint: (patch: Partial<SourceMedia>) => void,
  options: { signal?: AbortSignal; timeoutMs?: number; runner?: HistoryYoutubeRunner; mode?: 'audio' | 'video';
    inspectVideo?: typeof inspectYoutubeVideo } = {}): Promise<SourceMedia> {
  const parsed = parseHistoryYoutubeUrl(source.sourceUrl)
  if (source.platform !== 'youtube' || parsed.kind !== 'video' || parsed.videoId !== source.sourceVideoId) throw new Error('YouTube 下载来源身份不一致')
  const mode = options.mode ?? 'audio'
  if (mode !== 'audio' && mode !== 'video') throw new Error('YouTube 下载模式无效')
  const maximumBytes = mode === 'video' ? 4 * 1024 ** 3 : 256 * 1024 ** 2
  const downloadId = `youtube:${parsed.videoId}${mode === 'video' ? ':video' : ''}`
  options.signal?.throwIfAborted()
  const { sha256File } = await import('./history-source-pipeline.js')
  if (media.videoPath === targetPath && media.videoSha256 && (media.downloadKind ?? 'audio') === mode
    && (!media.downloadId || media.downloadId === downloadId)) {
    const info = await stat(targetPath).catch(() => null)
    if (info?.isFile() && info.size && await sha256File(targetPath, options.signal) === media.videoSha256) {
      if (mode === 'video') await (options.inspectVideo ?? inspectYoutubeVideo)(targetPath, options.signal)
      return media
    }
  }
  await mkdir(path.dirname(targetPath), { recursive: true })
  await assertMediaDiskSpace(path.dirname(targetPath), maximumBytes)
  // Keep the legacy target name for checkpoint compatibility; its container is
  // audio-only M4A, which ffprobe/ffmpeg identify by content.
  const stagingBase = path.join(path.dirname(targetPath), `source.youtube.${parsed.videoId}${mode === 'video' ? '.video' : ''}`)
  const outputTemplate = `${stagingBase.replace(/%/g, '%%')}.%(ext)s`
  checkpoint({ downloadId, downloadKind: mode, downloadState: 'running' })
  try {
    await (options.runner ?? runYoutube)([...youtubeNetworkArgs(), '--no-playlist', '--no-progress',
      ...(mode === 'video' ? ['--format', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4][vcodec!=none][acodec!=none]',
        '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--max-filesize', '4G']
        : ['--format', 'bestaudio[ext=m4a]/bestaudio/worst[height<=360][acodec!=none]',
          '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '64K', '--max-filesize', '256M']), '--output', outputTemplate,
      '--', parsed.url], { signal: options.signal, timeoutMs: options.timeoutMs ?? 30 * 60_000 })
    options.signal?.throwIfAborted()
    const stagedPath = `${stagingBase}.${mode === 'video' ? 'mp4' : 'm4a'}`
    const info = await stat(stagedPath).catch(() => null)
    if (!info?.isFile() || !info.size) throw new Error(`YouTube 下载未生成完整的${mode === 'video' ? '视频' : '音频'}文件，可能超过大小限制或没有可下载格式`)
    if (info.size > maximumBytes) throw new Error(`YouTube 来源${mode === 'video' ? '视频超过 4 GiB' : '音频超过 256 MiB'}，请调整下载模式或选择较短视频`)
    if (mode === 'video') await (options.inspectVideo ?? inspectYoutubeVideo)(stagedPath, options.signal)
    const videoSha256 = await sha256File(stagedPath, options.signal)
    await rename(stagedPath, targetPath)
    return { downloadId, downloadState: 'done', downloadKind: mode, videoPath: targetPath, videoSha256, videoBytes: info.size }
  } catch (error) {
    checkpoint({ downloadState: options.signal?.aborted ? 'cancelled' : 'failed' })
    throw error
  }
}

/** Full-video mode is complete only when the actual file has picture and sound. */
async function inspectYoutubeVideo(file: string, signal?: AbortSignal): Promise<void> {
  const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { signal, timeout: 60_000, maxBuffer: 1024 * 1024 })
  const probe = JSON.parse(stdout)
  const video = probe.streams?.find((stream: any) => stream.codec_type === 'video' && stream.width > 0 && stream.height > 0 && !stream.disposition?.attached_pic)
  const audio = probe.streams?.find((stream: any) => stream.codec_type === 'audio' && stream.channels > 0)
  const duration = Number(probe.format?.duration ?? video?.duration)
  if (!video || !audio || !Number.isFinite(duration) || duration <= 0 || !String(probe.format?.format_name || '').split(',').includes('mp4'))
    throw new Error('YouTube 完整视频必须是包含画面和音轨的有效 MP4；已保留下载文件，请继续当前下载')
}
