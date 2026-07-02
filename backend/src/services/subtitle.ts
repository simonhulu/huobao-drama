import fs from 'fs'
import path from 'path'
import ffmpeg from 'fluent-ffmpeg'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { resolveStoryboardNarrationTextForTTS } from './narration-generation.js'

const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i
const IGNORE_NARRATION_TEXT = /^(无|无旁白|无需配音|无需旁白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

export function parseDialogueForTTS(dialogue?: string | null) {
  const raw = dialogue?.trim() || ''
  if (!raw) return { speaker: '', pureText: '', ignorable: true }
  const speakerMatch = raw.match(/^(.+?)[:：]/)
  const speaker = speakerMatch ? speakerMatch[1].replace(/[（(].+?[)）]/g, '').trim() : ''
  const pureText = raw.replace(/^.+?[:：]\s*/, '').replace(/[（(].+?[)）]/g, '').trim()
  const ignorable = (!!speaker && IGNORE_TTS_SPEAKERS.test(speaker)) || !pureText || IGNORE_TTS_TEXT.test(pureText)
  return { speaker, pureText, ignorable }
}

function isIgnorableNarration(text?: string | null): boolean {
  return IGNORE_NARRATION_TEXT.test(text?.trim() || '')
}

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || ''

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

interface AlignSubtitleRequest {
  audio_path: string
  text: string
  font?: string
  size?: number
  color?: string
  position?: string
  margin?: number
  margin_v?: number
}

interface AlignSubtitleCue {
  text: string
  startMs: number
  endMs: number
}

interface AlignSubtitleResponse {
  success: boolean
  message?: string
  cueCount: number
  cues: AlignSubtitleCue[]
  ass: string
  recognizedText: string
  normalizedText: string
}

/**
 * 调用 python_service 的 /subtitle/align 接口，用 FunASR 把音频对齐到原文，
 * 返回 ASS 字幕内容。服务不可用时返回 null，调用方应回退到静态字幕。
 */
async function alignSubtitleWithService(
  audioPath: string,
  text: string,
  config: SubtitleConfig,
): Promise<string | null> {
  if (!PYTHON_SERVICE_URL) return null

  const body: AlignSubtitleRequest = {
    audio_path: audioPath,
    text,
    font: config.font,
    size: config.size,
    color: config.color,
    position: config.position,
    margin: config.marginL,
    margin_v: config.marginV,
  }

  try {
    const resp = await fetch(`${PYTHON_SERVICE_URL.replace(/\/$/, '')}/subtitle/align`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      console.error('[subtitle] align service HTTP error:', resp.status, await resp.text())
      return null
    }
    const data = await resp.json() as AlignSubtitleResponse
    if (!data.success) {
      console.error('[subtitle] align service failed:', data.message)
      return null
    }
    return data.ass
  } catch (err) {
    console.error('[subtitle] align service unreachable:', err)
    return null
  }
}

function getStoryboardAudioPath(
  sb: typeof schema.storyboards.$inferSelect,
  ep?: typeof schema.episodes.$inferSelect | null,
): string | null {
  const dialogue = parseDialogueForTTS(sb.dialogue)
  if (!dialogue.ignorable && dialogue.pureText && sb.ttsAudioUrl) {
    return toAbsPath(sb.ttsAudioUrl)
  }
  const narration = resolveStoryboardNarrationTextForTTS(sb, ep)
  if (narration && !isIgnorableNarration(narration) && sb.narrationAudioUrl) {
    return toAbsPath(sb.narrationAudioUrl)
  }
  return null
}

export interface SubtitleConfig {
  enabled: boolean
  font: string
  color: string
  size: number
  position: 'top' | 'middle' | 'bottom'
  marginL: number
  marginR: number
  marginV: number
  backgroundColor?: string | null
  strokeColor?: string | null
  strokeWidth?: number
}

function hexToAssColor(hex: string): string {
  const clean = hex.replace('#', '')
  if (clean.length === 6) {
    const r = clean.slice(0, 2)
    const g = clean.slice(2, 4)
    const b = clean.slice(4, 6)
    return `&H00${b}${g}${r}`
  }
  if (clean.length === 8) {
    const a = clean.slice(6, 8)
    const r = clean.slice(0, 2)
    const g = clean.slice(2, 4)
    const b = clean.slice(4, 6)
    return `&H${a}${b}${g}${r}`
  }
  return '&H00FFFFFF'
}

function positionToAssAlignment(position: SubtitleConfig['position']): number {
  switch (position) {
    case 'top': return 8
    case 'middle': return 5
    case 'bottom':
    default: return 2
  }
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N')
}

/**
 * 为 ASS 字幕做自动换行。
 * 原因：ASS 默认的 smart wrap 对没有空格的中文长句不会自动换行，
 * 导致一行字超出画面。这里按字体大小和画面宽度估算每行最大字数，
 * 在超出时手动插入换行符。
 */
function wrapAssText(
  text: string,
  fontSize: number,
  playResX = 1920,
  marginL = 60,
  marginR = 60,
): string {
  const charWidth = fontSize * 0.9
  const maxChars = Math.min(
    36,
    Math.max(12, Math.floor((playResX - marginL - marginR) / charWidth)),
  )

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (trimmed.length <= maxChars) return trimmed
      const chunks: string[] = []
      for (let i = 0; i < trimmed.length; i += maxChars) {
        chunks.push(trimmed.slice(i, i + maxChars))
      }
      return chunks.join('\n')
    })
    .join('\n')
}

function formatSrtTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = Math.floor(totalSeconds % 60)
  const ms = Math.round((totalSeconds % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function getSubtitleText(
  sb: typeof schema.storyboards.$inferSelect,
  ep?: typeof schema.episodes.$inferSelect | null,
): string | null {
  const dialogue = parseDialogueForTTS(sb.dialogue)
  if (!dialogue.ignorable && dialogue.pureText) return dialogue.pureText
  const narration = resolveStoryboardNarrationTextForTTS(sb, ep)
  if (narration && !isIgnorableNarration(narration)) return narration
  return null
}

export function generateSrt(text: string, duration: number): string {
  const start = 0.5
  const end = Math.max(start + 1, duration - 0.5)
  return `1\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}\n`
}

function buildAssStyle(config: SubtitleConfig): string {
  const alignment = positionToAssAlignment(config.position)
  const color = hexToAssColor(config.color)
  const font = config.font || 'PingFang SC'
  const size = config.size || 48
  const marginL = config.marginL ?? 60
  const marginR = config.marginR ?? 60
  const marginV = config.marginV ?? 40
  const strokeColor = config.strokeColor || '#000000'
  const strokeWidth = config.strokeWidth ?? 2
  const backgroundColor = config.backgroundColor || null

  // BorderStyle 3 在 libass/VSFilter 中表示绘制一个不透明的背景框，
  // 其颜色由 BackColour 控制。当需要背景色时启用；否则使用普通描边。
  const borderStyle = backgroundColor ? 3 : 1
  const outlineColour = backgroundColor ? hexToAssColor(backgroundColor) : hexToAssColor(strokeColor)
  const backColour = backgroundColor ? hexToAssColor(backgroundColor) : '&H00000000'
  const outline = backgroundColor ? 0 : strokeWidth

  return `Style: Default,${font},${size},${color},&H00FFFFFF,${outlineColour},${backColour},0,0,0,0,100,100,0,0,${borderStyle},${outline},0,${alignment},${marginL},${marginR},${marginV},1`
}

export function generateAss(text: string, duration: number, config: SubtitleConfig): string {
  const start = formatAssTime(0.5)
  const end = formatAssTime(Math.max(1, duration - 0.5))
  const wrappedText = wrapAssText(text, config.size || 48, 1920, config.marginL ?? 60, config.marginR ?? 60)
  const style = buildAssStyle(config)

  return `[Script Info]
Title: Huobao Subtitle
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${start},${end},Default,,0,0,0,,${escapeAssText(wrappedText)}
`
}

function formatAssTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = Math.floor(totalSeconds % 60)
  const cs = Math.round((totalSeconds % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

interface LoadedTitles {
  text: string
  titles: any[]
}

export function loadTitlesForAudio(audioPath: string): LoadedTitles | null {
  // TTS 生成时保存为 ${audioFilename}.titles.json（保留音频扩展名）
  const titlesPath = `${audioPath}.titles.json`
  if (!fs.existsSync(titlesPath)) return null
  try {
    const raw = fs.readFileSync(titlesPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed.titles) && parsed.titles.length > 0) {
      return { text: String(parsed.text || ''), titles: parsed.titles }
    }
  } catch (err) {
    console.error('[subtitle] failed to load titles:', titlesPath, err)
  }
  return null
}

/**
 * 把单条句级 title 按句末标点拆成多条 cue。
 * 原因：MiniMax 异步 TTS 目前只返回句级时间戳（甚至一整段一句），
 * 直接渲染会导致一大段字幕一次性出现。按句拆分后，字幕会跟随解说逐句显示。
 */
function splitTitleIntoCues(title: any): any[] {
  const text = String(title.text || '')
  if (!text) return [title]

  // 按句号、问号、感叹号、分号、换行拆分；保留标点
  const sentenceEnd = /([。！？；\n]+)/g
  const clauses: { text: string; startOffset: number; endOffset: number }[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = sentenceEnd.exec(text)) !== null) {
    const end = match.index + match[0].length
    clauses.push({ text: text.slice(lastIndex, end), startOffset: lastIndex, endOffset: end })
    lastIndex = end
  }
  if (lastIndex < text.length) {
    clauses.push({ text: text.slice(lastIndex), startOffset: lastIndex, endOffset: text.length })
  }
  if (clauses.length <= 1) return [title]

  const baseTime = Number(title.time_begin)
  const totalTime = Math.max(0, Number(title.time_end) - baseTime)
  const totalChars = Math.max(1, text.length)
  const baseTextBegin = Number(title.text_begin) || 0

  return clauses.map((c) => ({
    ...title,
    text: c.text,
    text_begin: baseTextBegin + c.startOffset,
    text_end: baseTextBegin + c.endOffset,
    time_begin: Math.round(baseTime + (c.startOffset / totalChars) * totalTime),
    time_end: Math.round(baseTime + (c.endOffset / totalChars) * totalTime),
  }))
}

export function generateAssFromTitles(
  titles: any[],
  originalText: string,
  duration: number,
  config: SubtitleConfig,
): string {
  const style = buildAssStyle(config)
  const size = config.size || 48
  const marginL = config.marginL ?? 60
  const marginR = config.marginR ?? 60
  const events: string[] = []

  const sorted = [...titles]
    .filter((t) => Number.isFinite(Number(t.time_begin)) && Number.isFinite(Number(t.time_end)))
    .sort((a, b) => Number(a.time_begin) - Number(b.time_begin))
    .flatMap(splitTitleIntoCues)

  for (const t of sorted) {
    const startSec = Math.max(0, Number(t.time_begin) / 1000)
    let endSec = Number(t.time_end) / 1000
    if (duration > 0) endSec = Math.min(endSec, duration)
    if (endSec <= startSec) continue

    let cueText = ''
    if (typeof t.text === 'string' && t.text.length > 0) {
      cueText = t.text
    } else if (originalText && Number.isFinite(Number(t.text_begin)) && Number.isFinite(Number(t.text_end))) {
      cueText = originalText.slice(Number(t.text_begin), Number(t.text_end))
    }
    cueText = cueText.trim()
    if (!cueText) continue

    const wrapped = wrapAssText(cueText, size, 1920, marginL, marginR)
    events.push(`Dialogue: 0,${formatAssTime(startSec)},${formatAssTime(endSec)},Default,,0,0,0,,${escapeAssText(wrapped)}`)
  }

  if (events.length === 0) {
    return generateAss(originalText, duration, config)
  }

  return `[Script Info]
Title: Huobao Subtitle
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`
}

export interface SubtitleFileResult {
  relativeUrl: string
  absolutePath: string
  format: 'srt' | 'ass'
}

export async function generateSubtitleFileForStoryboard(
  storyboardId: number,
  duration: number,
  config?: Partial<SubtitleConfig>,
): Promise<SubtitleFileResult | null> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) return null

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  const text = getSubtitleText(sb, ep)
  if (!text) return null

  const fullConfig: SubtitleConfig = {
    enabled: config?.enabled ?? true,
    font: config?.font ?? 'PingFang SC',
    color: config?.color ?? '#FFFFFF',
    size: config?.size ?? 48,
    position: config?.position ?? 'bottom',
    marginL: config?.marginL ?? 60,
    marginR: config?.marginR ?? 60,
    marginV: config?.marginV ?? 40,
    backgroundColor: config?.backgroundColor ?? null,
    strokeColor: config?.strokeColor ?? '#000000',
    strokeWidth: config?.strokeWidth ?? 2,
  }

  const srtDir = path.join(STORAGE_ROOT, 'subtitles')
  fs.mkdirSync(srtDir, { recursive: true })
  const filename = `${uuid()}.ass`
  const absolutePath = path.join(srtDir, filename)

  // 字幕时间码来源优先级：
  // 1. TTS 厂商返回并持久化的词级/句级 titles（最准，MiniMax 已支持）
  // 2. python_service 的 FunASR 音频-文本对齐（fallback）
  // 3. 按镜头时长静态铺满（保底）
  let content: string | null = null
  const audioPath = getStoryboardAudioPath(sb, ep)
  if (audioPath && fs.existsSync(audioPath)) {
    const loaded = loadTitlesForAudio(audioPath)
    if (loaded) {
      content = generateAssFromTitles(loaded.titles, loaded.text || text, duration, fullConfig)
    }
    if (!content) {
      content = await alignSubtitleWithService(audioPath, text, fullConfig)
    }
  }
  if (!content) {
    content = generateAss(text, duration, fullConfig)
  }

  fs.writeFileSync(absolutePath, content, 'utf-8')

  const relativeUrl = `static/subtitles/${filename}`
  db.update(schema.storyboards)
    .set({ subtitleUrl: relativeUrl, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()

  return { relativeUrl, absolutePath, format: 'ass' }
}

export function readEpisodeSubtitleConfig(ep: typeof schema.episodes.$inferSelect): SubtitleConfig {
  return {
    enabled: ep.subtitleEnabled ?? true,
    font: ep.subtitleFont || 'PingFang SC',
    color: ep.subtitleColor || '#FFFFFF',
    size: ep.subtitleSize ?? 48,
    position: castPosition(ep.subtitlePosition),
    marginL: ep.subtitleMargin ?? 60,
    marginR: ep.subtitleMargin ?? 60,
    marginV: ep.subtitleMarginV ?? 40,
    backgroundColor: ep.subtitleBackgroundColor ?? null,
    strokeColor: ep.subtitleStrokeColor ?? '#000000',
    strokeWidth: ep.subtitleStrokeWidth ?? 2,
  }
}

function castPosition(pos?: string | null): SubtitleConfig['position'] {
  return (['top', 'middle', 'bottom'].includes(pos || '') ? pos : 'bottom') as SubtitleConfig['position']
}

export async function generateSubtitlesForEpisode(
  episodeId: number,
): Promise<Array<{ storyboardId: number; subtitleUrl: string | null }>> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return []

  const config = readEpisodeSubtitleConfig(ep)
  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const results: Array<{ storyboardId: number; subtitleUrl: string | null }> = []
  for (const sb of sbs) {
    const duration = sb.duration || 8
    const result = await generateSubtitleFileForStoryboard(sb.id, duration, config)
    results.push({ storyboardId: sb.id, subtitleUrl: result?.relativeUrl || null })
  }
  return results
}

export function getSubtitlePath(relativeUrl: string): string {
  return toAbsPath(relativeUrl)
}

function resolveStoryboardMedia(sb: typeof schema.storyboards.$inferSelect): { source: string; isImage: boolean; isLavfi: boolean } | null {
  const candidates = [
    sb.firstFrameImage,
    sb.composedImage,
    sb.lastFrameImage,
  ].filter(Boolean) as string[]
  for (const rel of candidates) {
    const abs = toAbsPath(rel)
    if (fs.existsSync(abs)) return { source: abs, isImage: true, isLavfi: false }
  }
  if (sb.videoUrl) {
    const abs = toAbsPath(sb.videoUrl)
    if (fs.existsSync(abs)) return { source: abs, isImage: false, isLavfi: false }
  }
  return null
}

export async function generateSubtitlePreview(storyboardId: number): Promise<string | null> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) return null

  const text = getSubtitleText(sb)
  if (!text) return null

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  const config = ep ? readEpisodeSubtitleConfig(ep) : {
    enabled: true,
    font: 'PingFang SC',
    color: '#FFFFFF',
    size: 48,
    position: castPosition('bottom'),
    marginL: 60,
    marginR: 60,
    marginV: 40,
    backgroundColor: null,
    strokeColor: '#000000',
    strokeWidth: 2,
  }
  if (!config.enabled) return null

  const media = resolveStoryboardMedia(sb)
  const previewDuration = 3

  // 预览时优先使用真实音频的 titles 时间码，没有则用静态字幕
  const audioPath = getStoryboardAudioPath(sb)
  const loaded = audioPath ? loadTitlesForAudio(audioPath) : null
  const assContent = loaded
    ? generateAssFromTitles(loaded.titles, loaded.text || text, previewDuration, config)
    : generateAss(text, previewDuration, config)

  const previewDir = path.join(STORAGE_ROOT, 'subtitles', 'previews')
  fs.mkdirSync(previewDir, { recursive: true })
  const assFilename = `${uuid()}.ass`
  const assPath = path.join(previewDir, assFilename)
  fs.writeFileSync(assPath, assContent, 'utf-8')

  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(previewDir, outputFilename)
  const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:')

  await new Promise<void>((resolve, reject) => {
    let cmd: ffmpeg.FfmpegCommand
    let isImage = false
    if (media) {
      isImage = media.isImage
      cmd = ffmpeg(media.source)
      if (isImage) cmd = cmd.inputOptions(['-loop', '1'])
    } else {
      // 没有可用媒体时用黑色占位画面
      cmd = ffmpeg('color=c=black:s=1280x720:d=3').inputOptions(['-f', 'lavfi'])
      isImage = false
    }
    cmd
      .outputOptions([
        '-t', String(previewDuration),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-an',
      ])
      // 先缩放确保宽高为偶数（libx264 要求），再烧录字幕
      .videoFilter(`scale=trunc(iw/2)*2:trunc(ih/2)*2,subtitles=${escapedAssPath}`)
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })

  return `static/subtitles/previews/${outputFilename}`
}
