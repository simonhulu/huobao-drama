/**
 * MiniMax Music BGM 生成服务
 *
 * 为单个分镜生成/复用一段纯器乐 BGM，并保存到本地 static/music。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { getMusicConfig } from './ai.js'
import { getMusicAdapter } from './adapters/registry.js'
import { inferEpisodeAudioProfiles, inferStoryboardAudioProfile, type EmotionBucket } from './audio-profile.js'
import { resolveLocalBgmForEmotion, resolveLocalBgmForProfile } from './local-bgm-library.js'
import {
  planEpisodeBgmCues,
  type EpisodeBgmCue,
  type EpisodeBgmTrack,
} from './composition/bgm-cue-planner.js'
import { recordGeneratedMusic } from './music-library.js'
import { getAudioDuration } from './ffmpeg-compose.js'
import {
  logTaskError,
  logTaskPayload,
  logTaskProgress,
  logTaskStart,
  logTaskSuccess,
  redactUrl,
} from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) {
    return path.join(STORAGE_ROOT, relativePath.slice('static/'.length))
  }
  return path.join(STORAGE_ROOT, relativePath)
}

function toRelativePath(absPath: string): string {
  const relStorage = path.relative(STORAGE_ROOT, absPath)
  if (!relStorage.startsWith('..')) {
    return `static/${relStorage.replace(/\\/g, '/')}`
  }
  return `static/music/${path.basename(absPath)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Fetch timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetch(url, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

class MusicGenerationLimiter {
  private running = 0
  private pending: Array<() => void> = []

  constructor(private readonly concurrency: number) {}

  private tryNext(): void {
    while (this.pending.length > 0) {
      if (this.running >= this.concurrency) return
      const next = this.pending.shift()
      if (!next) continue
      this.running++
      next()
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.pending.push(resolve)
      this.tryNext()
    })
    try {
      return await fn()
    } finally {
      this.running--
      this.tryNext()
    }
  }
}

const MUSIC_GENERATION_CONCURRENCY = Math.max(1, Number(process.env.MUSIC_GENERATION_CONCURRENCY || 1))
const musicGenerationLimiter = new MusicGenerationLimiter(MUSIC_GENERATION_CONCURRENCY)

const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_POLL_TIMEOUT_MS = 300_000

interface GenerateBGMOptions {
  model?: string
  pollIntervalMs?: number
  pollTimeoutMs?: number
}

async function downloadAudio(url: string, outputPath: string): Promise<void> {
  const res = await fetchWithTimeout(url, { timeoutMs: 300_000 })
  if (!res.ok) {
    throw new Error(`Failed to download music from ${redactUrl(url)}: ${res.status} ${res.statusText}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(outputPath, buffer)
}

export async function generateBGM(prompt: string, options: GenerateBGMOptions = {}): Promise<string> {
  return musicGenerationLimiter.run(async () => {
    const config = getMusicConfig()
    const adapter = getMusicAdapter(config.provider)

    logTaskStart('MusicTask', 'bgm-generate', {
      provider: config.provider,
      model: options.model || config.model,
      promptPreview: prompt.slice(0, 80),
    })

    const record = {
      id: 0,
      prompt,
      duration: null,
      model: options.model || config.model,
    }

    const { url, method, headers, body } = adapter.buildGenerateRequest(config, record)
    logTaskProgress('MusicTask', 'request', { provider: config.provider, method, url: redactUrl(url) })
    logTaskPayload('MusicTask', 'request payload', { method, url, headers, body })

    const submitRes = await fetchWithTimeout(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: 300_000,
    })
    const submitJson = await submitRes.json().catch(() => ({}))
    logTaskPayload('MusicTask', 'submit response', submitJson)

    if (!submitRes.ok && !submitJson?.task_id && !submitJson?.audio_url) {
      throw new Error(`MiniMax Music submit failed: ${submitRes.status} ${JSON.stringify(submitJson)}`)
    }

    const genResult = adapter.parseGenerateResponse(submitJson)
    if (genResult.error) {
      throw new Error(genResult.error)
    }

    let audioUrl = genResult.audioUrl

    if (genResult.isAsync && genResult.taskId) {
      const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
      const pollTimeout = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
      const startedAt = Date.now()
      let finalStatus: { audioUrl?: string; fileId?: string } | null = null

      while (Date.now() - startedAt < pollTimeout) {
        await sleep(pollInterval)
        const pollReq = adapter.buildPollRequest(config, genResult.taskId)
        const pollRes = await fetchWithTimeout(pollReq.url, {
          method: pollReq.method,
          headers: pollReq.headers,
          timeoutMs: 300_000,
        })
        const pollJson = await pollRes.json().catch(() => ({}))
        logTaskPayload('MusicTask', 'poll response', { taskId: genResult.taskId, ...pollJson })

        const pollResult = adapter.parsePollResponse(pollJson)
        if (pollResult.status === 'completed') {
          finalStatus = { audioUrl: pollResult.audioUrl, fileId: pollResult.fileId }
          break
        }
        if (pollResult.status === 'failed') {
          throw new Error(pollResult.error || 'MiniMax Music generation failed')
        }
      }

      if (!finalStatus) {
        throw new Error('MiniMax Music generation timed out')
      }

      audioUrl = finalStatus.audioUrl

      if (!audioUrl && finalStatus.fileId) {
        const fileReq = adapter.buildFileRetrieveRequest(config, finalStatus.fileId)
        const fileRes = await fetchWithTimeout(fileReq.url, { method: fileReq.method, headers: fileReq.headers, timeoutMs: 300_000 })
        const fileJson = await fileRes.json().catch(() => ({}))
        logTaskPayload('MusicTask', 'file retrieve response', { fileId: finalStatus.fileId, ...fileJson })

        const fileResult = adapter.parseFileRetrieveResponse(fileJson)
        if (fileResult.error || !fileResult.audioUrl) {
          throw new Error(fileResult.error || 'MiniMax file retrieve returned no download URL')
        }
        audioUrl = fileResult.audioUrl
      }
    }

    if (!audioUrl) {
      throw new Error('No audio URL available after MiniMax Music generation')
    }

    const outputDir = path.join(STORAGE_ROOT, 'music')
    fs.mkdirSync(outputDir, { recursive: true })
    const outputFilename = `${uuid()}.mp3`
    const outputPath = path.join(outputDir, outputFilename)

    logTaskProgress('MusicTask', 'download', { url: redactUrl(audioUrl), outputPath })
    await downloadAudio(audioUrl, outputPath)

    const relativePath = toRelativePath(outputPath)
    logTaskSuccess('MusicTask', 'bgm-generate', {
      provider: config.provider,
      output: relativePath,
      bytes: fs.statSync(outputPath).size,
    })
    return relativePath
  })
}

function findExistingBgmForPrompt(episodeId: number, prompt: string): string | null {
  if (!prompt) return null
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
  for (const row of rows) {
    if (row.bgmPrompt?.trim() === prompt && row.bgmAudioUrl) {
      const abs = toAbsPath(row.bgmAudioUrl)
      if (fs.existsSync(abs)) return row.bgmAudioUrl
    }
  }
  return null
}

function assignLocalEmotionBgm(storyboardId: number): string | null {
  const profile = inferStoryboardAudioProfile(storyboardId)
  const local = resolveLocalBgmForEmotion(profile.emotionBucket)
  if (!local) return null

  db.update(schema.storyboards)
    .set({ bgmAudioUrl: local, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()
  logTaskProgress('MusicTask', 'local-emotion-bgm', {
    storyboardId,
    emotionBucket: profile.emotionBucket,
    bgmAudioUrl: local,
  })
  return local
}

function assignLibraryBgm(
  storyboardId: number,
  bgmAudioUrl: string,
  reason: string,
  context: Record<string, unknown> = {},
): string {
  db.update(schema.storyboards)
    .set({ bgmAudioUrl, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()
  logTaskProgress('MusicTask', reason, {
    storyboardId,
    bgmAudioUrl,
    ...context,
  })
  return bgmAudioUrl
}

export async function ensureStoryboardBGM(
  storyboardId: number,
  options?: { force?: boolean },
): Promise<string | null> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)

  const prompt = sb.bgmPrompt?.trim() || ''
  if (!prompt) return null

  const profile = inferStoryboardAudioProfile(storyboardId)

  const existingPath = sb.bgmAudioUrl ? toAbsPath(sb.bgmAudioUrl) : null
  if (!options?.force && existingPath && fs.existsSync(existingPath)) {
    logTaskProgress('MusicTask', 'reuse-storyboard-bgm', { storyboardId, bgmAudioUrl: sb.bgmAudioUrl })
    return sb.bgmAudioUrl
  }

  const libraryBgm = resolveLocalBgmForProfile(profile.emotionBucket, {
    prompt,
    intensity: profile.bgmIntensity,
    seed: `${sb.episodeId}:${sb.storyboardNumber}:${prompt}`,
  })
  if (libraryBgm) {
    return assignLibraryBgm(storyboardId, libraryBgm, 'reuse-library-bgm', {
      emotionBucket: profile.emotionBucket,
      intensity: profile.bgmIntensity,
      force: Boolean(options?.force),
    })
  }

  // 同一集里相同 bgm_prompt 复用已生成文件
  const reused = !options?.force ? findExistingBgmForPrompt(sb.episodeId, prompt) : null
  if (reused) {
    db.update(schema.storyboards)
      .set({ bgmAudioUrl: reused, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
    logTaskProgress('MusicTask', 'reuse-episode-bgm', { storyboardId, bgmAudioUrl: reused })
    return reused
  }

  try {
    const bgmAudioUrl = await generateBGM(prompt)
    let duration = 0
    if (bgmAudioUrl) {
      try {
        duration = await getAudioDuration(toAbsPath(bgmAudioUrl))
      } catch (durErr: any) {
        logTaskProgress('MusicTask', 'duration-read-failed', { storyboardId, error: durErr.message || String(durErr) })
      }
    }
    recordGeneratedMusic(bgmAudioUrl, {
      prompt,
      emotionBucket: profile.emotionBucket,
      intensity: profile.bgmIntensity,
      episodeId: sb.episodeId,
      duration,
    })
    db.update(schema.storyboards)
      .set({ bgmAudioUrl, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
    return bgmAudioUrl
  } catch (err: any) {
    // 生成失败（额度耗尽、网络错误等）时，从本地素材库按情绪桶兜底
    logTaskProgress('MusicTask', 'generation-failed-fallback', {
      storyboardId,
      error: err.message || String(err),
    })
    return assignLocalEmotionBgm(storyboardId)
  }
}

export interface EpisodeBgmPlan {
  tracks: EpisodeBgmTrack[]
  cues: EpisodeBgmCue[]
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const EPISODE_BGM_SECONDARY_MIN_SECONDS = readNumberEnv('EPISODE_BGM_SECONDARY_MIN_SECONDS', 30)
const EPISODE_BGM_SECONDARY_MIN_RATIO = readNumberEnv('EPISODE_BGM_SECONDARY_MIN_RATIO', 0.15)

/**
 * 为整集生成/匹配 1–3 条 BGM，并按情绪幕布生成 cue 计划。
 *
 * 设计原则（参考电影配乐）：
 * - 一部 5 分钟短片通常只有 1–4 个音乐 cue，而不是每个镜头都换音乐。
 * - 同一情绪幕布内使用同一段音乐 bed 循环或延续。
 * - 只在真正的情绪/叙事转折点切换音乐。
 */
export async function ensureEpisodeBgmPlan(
  episodeId: number,
  options?: { force?: boolean },
): Promise<EpisodeBgmPlan | null> {
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  if (sbs.length === 0) return null

  logTaskStart('MusicTask', 'episode-bgm-plan', { episodeId, shots: sbs.length })

  const totalDuration = sbs.reduce((sum, sb) => sum + (sb.duration || 8), 0)
  const profiles = inferEpisodeAudioProfiles(episodeId)

  // 统计各情绪桶的累计时长
  const bucketDurations = new Map<EmotionBucket, number>()
  for (const sb of sbs) {
    const profile = profiles.get(sb.id)
    const bucket = profile?.emotionBucket ?? 'neutral'
    const duration = sb.duration || 8
    bucketDurations.set(bucket, (bucketDurations.get(bucket) || 0) + duration)
  }

  const sortedBuckets = Array.from(bucketDurations.entries())
    .filter(([_, duration]) => duration > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([bucket]) => bucket)

  if (sortedBuckets.length === 0) {
    logTaskSuccess('MusicTask', 'episode-bgm-plan', { episodeId, reason: 'no-emotion-detected' })
    return null
  }

  // 主导情绪桶 + 可选的副情绪桶
  const primaryBucket = sortedBuckets[0]
  const secondaryThreshold = Math.max(
    EPISODE_BGM_SECONDARY_MIN_SECONDS,
    totalDuration * EPISODE_BGM_SECONDARY_MIN_RATIO,
  )
  // 最多再选一条副情绪音乐，避免引入过多轨道导致音乐碎片化
  const secondaryBuckets = sortedBuckets
    .slice(1)
    .filter(bucket => (bucketDurations.get(bucket) || 0) >= secondaryThreshold)
    .slice(0, 1)

  const selectedBuckets = [primaryBucket, ...secondaryBuckets]

  async function resolveTrackForBucket(bucket: EmotionBucket): Promise<EpisodeBgmTrack | null> {
    const repSb = sbs.find(sb => (profiles.get(sb.id)?.emotionBucket ?? 'neutral') === bucket)
    const profile = repSb ? profiles.get(repSb.id) : undefined
    const prompt = repSb?.bgmPrompt?.trim() || profile?.bgmPrompt || ''
    const intensity = profile?.bgmIntensity ?? 'medium'

    // 1. 复用本集已保存的对应轨道（非强制模式下）
    if (!options?.force && episode) {
      const existingPrimary = episode.bgmAudioUrl
      const existingSecondary = episode.secondaryBgmAudioUrl
      if (bucket === primaryBucket && existingPrimary) {
        const abs = toAbsPath(existingPrimary)
        if (fs.existsSync(abs)) {
          logTaskProgress('MusicTask', 'reuse-primary-track', { episodeId, bucket, bgmAudioUrl: existingPrimary })
          return { path: existingPrimary, emotionBucket: bucket, role: 'primary' }
        }
      }
      if (secondaryBuckets.includes(bucket) && existingSecondary) {
        const abs = toAbsPath(existingSecondary)
        if (fs.existsSync(abs)) {
          logTaskProgress('MusicTask', 'reuse-secondary-track', { episodeId, bucket, bgmAudioUrl: existingSecondary })
          return { path: existingSecondary, emotionBucket: bucket, role: 'secondary' }
        }
      }
    }

    // 2. 从本地素材库匹配
    const localBgm = resolveLocalBgmForProfile(bucket, {
      prompt,
      intensity,
      seed: `${episodeId}:${bucket}`,
    })
    if (localBgm) {
      logTaskProgress('MusicTask', 'episode-local-bgm', { episodeId, bucket, bgmAudioUrl: localBgm })
      return { path: localBgm, emotionBucket: bucket, role: bucket === primaryBucket ? 'primary' : 'secondary' }
    }

    // 3. 生成新 BGM（失败时回退本地兜底）
    if (!prompt) return null
    try {
      const generated = await generateBGM(prompt)
      let duration = 0
      if (generated) {
        try { duration = await getAudioDuration(toAbsPath(generated)) } catch {}
      }
      recordGeneratedMusic(generated, {
        prompt,
        emotionBucket: bucket,
        intensity,
        episodeId,
        duration,
      })
      logTaskProgress('MusicTask', 'episode-generated-bgm', { episodeId, bucket, bgmAudioUrl: generated })
      return { path: generated, emotionBucket: bucket, role: bucket === primaryBucket ? 'primary' : 'secondary' }
    } catch (err: any) {
      logTaskProgress('MusicTask', 'episode-generation-fallback', { episodeId, bucket, error: err.message || String(err) })
      const fallback = resolveLocalBgmForEmotion(bucket)
      if (fallback) {
        return { path: fallback, emotionBucket: bucket, role: bucket === primaryBucket ? 'primary' : 'secondary' }
      }
      return null
    }
  }

  const tracks: EpisodeBgmTrack[] = []
  for (const bucket of selectedBuckets) {
    const track = await resolveTrackForBucket(bucket)
    if (track) tracks.push(track)
  }

  if (tracks.length === 0) {
    logTaskSuccess('MusicTask', 'episode-bgm-plan', { episodeId, reason: 'no-tracks-resolved' })
    return null
  }

  // 如果只有一个情绪桶，全部轨道都设为主情绪
  if (tracks.length === 1) {
    tracks[0].role = 'primary'
    tracks[0].emotionBucket = primaryBucket
  }

  const cues = planEpisodeBgmCues(
    sbs.map(sb => ({ id: sb.id, videoDuration: sb.duration || 8 })),
    profiles,
    tracks,
    { minActDuration: readNumberEnv('EPISODE_BGM_MIN_ACT_SECONDS', 25) },
  )

  const primaryTrack = tracks.find(t => t.role === 'primary')
  const secondaryTrack = tracks.find(t => t.role === 'secondary')

  const plan: EpisodeBgmPlan = { tracks, cues }
  db.update(schema.episodes)
    .set({
      bgmAudioUrl: primaryTrack?.path ?? tracks[0].path,
      secondaryBgmAudioUrl: secondaryTrack?.path ?? null,
      bgmPlanJson: JSON.stringify(plan),
      updatedAt: now(),
    })
    .where(eq(schema.episodes.id, episodeId))
    .run()

  logTaskSuccess('MusicTask', 'episode-bgm-plan', {
    episodeId,
    tracks: tracks.length,
    cues: cues.length,
    primaryBucket,
    secondaryBuckets,
  })
  return plan
}
