/**
 * 整集统一 TTS 合成服务
 * 把一集所有分镜的旁白拼成一段长文本，调一次 MiniMax 异步 TTS，
 * 然后按返回的句级字幕时间戳切成每镜一段音频。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import ffmpeg from 'fluent-ffmpeg'
import { v4 as uuid } from 'uuid'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAudioConfigById, getNarrationAudioConfig } from './ai.js'
import { isIgnorableTTS } from './ffmpeg-compose.js'
import { resolveStoryboardNarrationTextForTTS } from './narration-generation.js'
import { MiniMaxTTSAdapter, retrieveAsyncResult, type TTSParams } from './adapters/minimax-tts.js'
import { logTaskStart, logTaskProgress, logTaskSuccess, logTaskError } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../../data/static')

interface Segment {
  id: number
  text: string
  startChar: number
  endChar: number
}

interface SegmentTiming {
  id: number
  startMs: number
  endMs: number
}

export interface GenerateEpisodeUnifiedTTSOptions {
  model?: string
  emotion?: string
}

/**
 * 生成整集统一旁白 TTS，并把切分后的音频写入每个分镜的 narration_audio_url
 */
export async function generateEpisodeUnifiedTTS(
  episodeId: number,
  options: GenerateEpisodeUnifiedTTSOptions = {},
): Promise<{ fullAudioPath: string; segmentCount: number; fallback: boolean }> {
  logTaskStart('EpisodeTTS', 'unified-tts-start', { episodeId })

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)

  const config = getNarrationAudioConfig() ?? getAudioConfigById(ep.audioConfigId ?? undefined)
  if (!config) throw new Error(`Episode ${episodeId} has no active audio config`)

  const voiceId = ep.narrationVoiceId || 'DaniangzhuVoice01'
  const speed = ep.narrationSpeed ?? 1.0

  const rawStoryboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const segments: Segment[] = []
  let fullText = ''
  for (const sb of rawStoryboards) {
    const clean = normalizeTtsText(resolveStoryboardNarrationTextForTTS(sb, ep))
    if (!clean || isIgnorableTTS(clean)) continue
    const startChar = fullText.length
    fullText += clean
    segments.push({ id: sb.id, text: clean, startChar, endChar: fullText.length })
  }

  if (segments.length === 0) {
    throw new Error(`Episode ${episodeId} has no narratable text`)
  }

  logTaskProgress('EpisodeTTS', 'unified-tts-text-built', {
    episodeId,
    segmentCount: segments.length,
    totalChars: fullText.length,
  })

  const adapter = new MiniMaxTTSAdapter()
  const params: TTSParams = {
    text: fullText,
    voice: voiceId,
    speed,
    model: options.model,
    emotion: options.emotion,
    subtitleEnable: true,
    subtitleType: 'word',
  }

  const { url, method, headers, body } = adapter.buildGenerateRequest(config, params)
  const createResp = await fetch(url, { method, headers, body: JSON.stringify(body) })
  if (!createResp.ok) {
    const errText = await createResp.text()
    throw new Error(`Unified TTS create error ${createResp.status}: ${errText}`)
  }

  const createResult = await createResp.json()
  if (createResult.base_resp?.status_code !== 0) {
    throw new Error(createResult.base_resp?.status_msg || 'Unified TTS create failed')
  }

  const taskId = createResult.task_id
  const fileId = createResult.file_id
  logTaskProgress('EpisodeTTS', 'unified-tts-created', { episodeId, taskId, fileId })

  const { audioBuffer, titles, extra } = await retrieveAsyncResult(config, taskId, fileId)
  logTaskProgress('EpisodeTTS', 'unified-tts-retrieved', {
    episodeId,
    audioBytes: audioBuffer.length,
    titleCount: Array.isArray(titles) ? titles.length : 0,
    extraAudioLength: extra?.audio_length,
  })

  // 保存整段音频（调试用，也可用于后续直接使用）
  const audioDir = path.join(STORAGE_ROOT, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const fullAudioFilename = `${uuid()}_episode${episodeId}.mp3`
  const fullAudioPathAbs = path.join(audioDir, fullAudioFilename)
  fs.writeFileSync(fullAudioPathAbs, audioBuffer)
  const fullAudioPath = `static/audio/${fullAudioFilename}`

  // 计算每个分镜的时间范围
  const totalAudioMs = Number(extra?.audio_length) || (titles.length ? titles[titles.length - 1].time_end : 0)
  const timings = computeSegmentTimings(segments, titles, totalAudioMs)

  // 切分音频
  let splitCount = 0
  const fallback = timings.some(t => t.startMs === 0 && t.endMs === 0)
  for (const seg of segments) {
    const timing = timings.find(t => t.id === seg.id)
    if (!timing || timing.endMs <= timing.startMs) {
      db.update(schema.storyboards)
        .set({ narrationAudioUrl: null, updatedAt: now() })
        .where(eq(schema.storyboards.id, seg.id))
        .run()
      continue
    }

    const startSec = timing.startMs / 1000
    const durationSec = (timing.endMs - timing.startMs) / 1000
    const segmentFilename = `${uuid()}.m4a`
    const segmentAbsPath = path.join(audioDir, segmentFilename)

    await splitAndNormalizeAudio(fullAudioPathAbs, startSec, durationSec, segmentAbsPath)

    // 把属于本分镜的 titles 切片并保存，供后续字幕生成直接对轴
    const segmentTitles = extractSegmentTitles(titles, seg.startChar, seg.endChar, timing.startMs)
    if (segmentTitles.length > 0) {
      const titlesPath = path.join(audioDir, `${segmentFilename}.titles.json`)
      fs.writeFileSync(titlesPath, JSON.stringify({
        text: seg.text,
        titles: segmentTitles,
        extra: { audio_length: timing.endMs - timing.startMs },
        createdAt: new Date().toISOString(),
      }, null, 2), 'utf-8')
    }

    db.update(schema.storyboards)
      .set({ narrationAudioUrl: `static/audio/${segmentFilename}`, updatedAt: now() })
      .where(eq(schema.storyboards.id, seg.id))
      .run()

    splitCount++
  }

  logTaskSuccess('EpisodeTTS', 'unified-tts-done', {
    episodeId,
    fullAudioPath,
    segmentCount: splitCount,
    fallback,
  })

  return { fullAudioPath, segmentCount: splitCount, fallback }
}

/**
 * 文本预处理：去掉 CJK 字符之间的空格，合并多余空白
 */
export function normalizeTtsText(text?: string | null): string {
  if (!text) return ''
  return text
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function computeSegmentTimings(
  segments: Segment[],
  titles: any[],
  totalAudioMs: number,
): SegmentTiming[] {
  if (!Array.isArray(titles) || titles.length === 0) {
    return fallbackProportionalTimings(segments, totalAudioMs)
  }

  const timings = new Map<number, { startMs: number; endMs: number }>()
  for (const seg of segments) {
    timings.set(seg.id, { startMs: Infinity, endMs: 0 })
  }

  for (const t of titles) {
    const textBegin = Number(t.text_begin)
    if (!Number.isFinite(textBegin)) continue

    const seg = segments.find(s => textBegin >= s.startChar && textBegin < s.endChar)
    if (!seg) continue

    const timing = timings.get(seg.id)!
    const timeBegin = Number(t.time_begin)
    const timeEnd = Number(t.time_end)
    if (Number.isFinite(timeBegin)) timing.startMs = Math.min(timing.startMs, timeBegin)
    if (Number.isFinite(timeEnd)) timing.endMs = Math.max(timing.endMs, timeEnd)
  }

  const result: SegmentTiming[] = []
  for (const seg of segments) {
    const timing = timings.get(seg.id)!
    if (Number.isFinite(timing.startMs) && timing.endMs > timing.startMs) {
      result.push({ id: seg.id, startMs: timing.startMs, endMs: timing.endMs })
    } else {
      result.push({ id: seg.id, startMs: 0, endMs: 0 })
    }
  }

  // 如果有分镜没有匹配到字幕，整体回退到按字数比例
  if (result.some(t => t.startMs === 0 && t.endMs === 0)) {
    return fallbackProportionalTimings(segments, totalAudioMs)
  }

  return result
}

function extractSegmentTitles(
  titles: any[],
  segmentStartChar: number,
  segmentEndChar: number,
  segmentStartMs: number,
): any[] {
  return titles
    .filter((t) => {
      const textBegin = Number(t.text_begin)
      return Number.isFinite(textBegin) && textBegin >= segmentStartChar && textBegin < segmentEndChar
    })
    .map((t) => ({
      ...t,
      text_begin: Number(t.text_begin) - segmentStartChar,
      time_begin: Math.max(0, Number(t.time_begin) - segmentStartMs),
      time_end: Math.max(0, Number(t.time_end) - segmentStartMs),
    }))
}

function fallbackProportionalTimings(segments: Segment[], totalAudioMs: number): SegmentTiming[] {
  const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0)
  const totalAudioSec = totalAudioMs / 1000
  let currentSec = 0
  const result: SegmentTiming[] = []

  for (const seg of segments) {
    const segDurationSec = totalAudioSec * (seg.text.length / totalChars)
    result.push({
      id: seg.id,
      startMs: currentSec * 1000,
      endMs: (currentSec + segDurationSec) * 1000,
    })
    currentSec += segDurationSec
  }

  return result
}

function splitAndNormalizeAudio(
  inputPath: string,
  startSec: number,
  durationSec: number,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .setDuration(durationSec)
      .audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11')
      .audioCodec('aac')
      .audioBitrate('192k')
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}
