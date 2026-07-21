import type { AudioProfile, EmotionBucket } from '../audio-profile.js'

export interface BgmCuePlanShot {
  videoDuration: number
  bgmPath?: string | null
}

export interface BgmCuePlanOptions {
  minCueDuration?: number
  maxCueDuration?: number
  minFinalCueDuration?: number
  openingCueDuration?: number
}

export interface BgmCue {
  start: number
  end: number
  duration: number
  shotStartIndex: number
  shotEndIndex: number
  bgmPath: string
}

export interface EpisodeBgmTrack {
  path: string
  emotionBucket: EmotionBucket
  role: 'primary' | 'secondary'
}

export interface EpisodeBgmCue extends BgmCue {
  emotionBucket: EmotionBucket
}

export interface EpisodeBgmPlanShot {
  id: number
  videoDuration: number
}

export interface EpisodeBgmPlanOptions {
  /** 情绪幕布最短时长，短于此值的片段会被合并到相邻幕中 */
  minActDuration?: number
}

const DEFAULT_MIN_ACT_DURATION = 25

const DEFAULT_MIN_CUE_DURATION = 35
const DEFAULT_MAX_CUE_DURATION = 75
const DEFAULT_MIN_FINAL_CUE_DURATION = 20
const DEFAULT_OPENING_CUE_DURATION = 30

function normalizeDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function normalizePath(value?: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function roundTimelineSeconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

function pickBestPath(totals: Map<string, { duration: number; firstIndex: number }>): string | null {
  let bestPath: string | null = null
  let bestDuration = -1
  let bestFirstIndex = Number.POSITIVE_INFINITY

  for (const [bgmPath, value] of totals.entries()) {
    if (
      value.duration > bestDuration ||
      (value.duration === bestDuration && value.firstIndex < bestFirstIndex)
    ) {
      bestPath = bgmPath
      bestDuration = value.duration
      bestFirstIndex = value.firstIndex
    }
  }

  return bestPath
}

function pickDominantBgmPath(shots: BgmCuePlanShot[], startIndex: number, endIndex: number): string | null {
  const totals = new Map<string, { duration: number; firstIndex: number }>()

  for (let i = startIndex; i <= endIndex; i++) {
    const bgmPath = normalizePath(shots[i]?.bgmPath)
    if (!bgmPath) continue

    const current = totals.get(bgmPath)
    const duration = normalizeDuration(shots[i].videoDuration)
    if (current) {
      current.duration += duration
    } else {
      totals.set(bgmPath, { duration, firstIndex: i })
    }
  }

  return pickBestPath(totals)
}

function pickDominantBgmPathInWindow(
  shots: BgmCuePlanShot[],
  startIndex: number,
  endIndex: number,
  windowStart: number,
  windowEnd: number,
): string | null {
  if (windowEnd <= windowStart) return null

  const totals = new Map<string, { duration: number; firstIndex: number }>()
  let currentTime = 0

  for (let i = 0; i < shots.length; i++) {
    const duration = normalizeDuration(shots[i].videoDuration)
    const shotStart = currentTime
    const shotEnd = shotStart + duration
    currentTime = shotEnd

    if (i < startIndex || i > endIndex) continue

    const bgmPath = normalizePath(shots[i].bgmPath)
    if (!bgmPath) continue

    const overlap = Math.max(0, Math.min(shotEnd, windowEnd) - Math.max(shotStart, windowStart))
    if (overlap <= 0) continue

    const current = totals.get(bgmPath)
    if (current) {
      current.duration += overlap
    } else {
      totals.set(bgmPath, { duration: overlap, firstIndex: i })
    }
  }

  return pickBestPath(totals)
}

export function planBgmCues(shots: BgmCuePlanShot[], options: BgmCuePlanOptions = {}): BgmCue[] {
  const minCueDuration = options.minCueDuration ?? DEFAULT_MIN_CUE_DURATION
  const maxCueDuration = Math.max(options.maxCueDuration ?? DEFAULT_MAX_CUE_DURATION, minCueDuration)
  const minFinalCueDuration = options.minFinalCueDuration ?? DEFAULT_MIN_FINAL_CUE_DURATION
  const openingCueDuration = Math.max(0, options.openingCueDuration ?? DEFAULT_OPENING_CUE_DURATION)
  const totalDuration = shots.reduce((sum, shot) => sum + normalizeDuration(shot.videoDuration), 0)
  const cues: BgmCue[] = []

  let cueStartIndex = 0
  let cueStartTime = 0
  let cueDuration = 0

  const closeCue = (shotEndIndex: number) => {
    const openingWindowEnd = Math.min(openingCueDuration, totalDuration)
    const openingPath = cueStartIndex === 0 && openingWindowEnd > 0
      ? pickDominantBgmPathInWindow(shots, cueStartIndex, shotEndIndex, 0, openingWindowEnd)
      : null
    const bgmPath = openingPath || pickDominantBgmPath(shots, cueStartIndex, shotEndIndex)
    if (bgmPath && cueDuration > 0) {
      const start = roundTimelineSeconds(cueStartTime)
      const duration = roundTimelineSeconds(cueDuration)
      cues.push({
        start,
        end: roundTimelineSeconds(start + duration),
        duration,
        shotStartIndex: cueStartIndex,
        shotEndIndex,
        bgmPath,
      })
    }

    cueStartIndex = shotEndIndex + 1
    cueStartTime += cueDuration
    cueDuration = 0
  }

  for (let i = 0; i < shots.length; i++) {
    cueDuration += normalizeDuration(shots[i].videoDuration)

    if (i === shots.length - 1) {
      closeCue(i)
      continue
    }

    const elapsedThroughCurrent = cueStartTime + cueDuration
    const remainingDuration = totalDuration - elapsedThroughCurrent
    const canLeaveUsableNextCue = remainingDuration >= minFinalCueDuration
    if (!canLeaveUsableNextCue) continue
    if (cueStartIndex === 0 && elapsedThroughCurrent < openingCueDuration) continue

    const dominantPath = pickDominantBgmPath(shots, cueStartIndex, i)
    const nextPath = normalizePath(shots[i + 1]?.bgmPath)
    const reachedMaxCueDuration = cueDuration >= maxCueDuration
    const reachedMusicalChange = (
      cueDuration >= minCueDuration &&
      dominantPath !== null &&
      nextPath !== null &&
      nextPath !== dominantPath
    )

    if (reachedMaxCueDuration || reachedMusicalChange) {
      closeCue(i)
    }
  }

  return cues
}

function getBucketForShot(shot: EpisodeBgmPlanShot, profiles: Map<number, AudioProfile>): EmotionBucket {
  return profiles.get(shot.id)?.emotionBucket ?? 'neutral'
}

function getTrackForBucket(
  bucket: EmotionBucket,
  tracks: EpisodeBgmTrack[],
): EpisodeBgmTrack | undefined {
  const exact = tracks.find(t => t.emotionBucket === bucket)
  if (exact) return exact
  const primary = tracks.find(t => t.role === 'primary')
  return primary ?? tracks[0]
}

function contiguousBucketDuration(
  shots: EpisodeBgmPlanShot[],
  profiles: Map<number, AudioProfile>,
  startIndex: number,
): { bucket: EmotionBucket; duration: number; endIndex: number } {
  const bucket = getBucketForShot(shots[startIndex], profiles)
  let duration = 0
  let i = startIndex
  while (i < shots.length && getBucketForShot(shots[i], profiles) === bucket) {
    duration += normalizeDuration(shots[i].videoDuration)
    i++
  }
  return { bucket, duration, endIndex: i }
}

/**
 * 按“情绪幕布”规划集级别 BGM cue。
 *
 * 规则：
 * 1. 相邻且情绪桶相同的镜头合并成一幕。
 * 2. 当前幕只在遇到“有足够连续时长的、且有对应音乐轨”的新情绪时才切换。
 * 3. 零散的情绪波动（时长短、没有独立音乐轨）会被吸收进当前幕，避免音乐频繁切分。
 * 4. 每个 cue 只使用已选定的 1–3 条 BGM 之一，不会在集内引入新的音乐文件。
 */
export function planEpisodeBgmCues(
  shots: EpisodeBgmPlanShot[],
  profiles: Map<number, AudioProfile>,
  tracks: EpisodeBgmTrack[],
  options: EpisodeBgmPlanOptions = {},
): EpisodeBgmCue[] {
  if (shots.length === 0 || tracks.length === 0) return []

  const minActDuration = options.minActDuration ?? DEFAULT_MIN_ACT_DURATION
  const totalDuration = shots.reduce((sum, shot) => sum + normalizeDuration(shot.videoDuration), 0)
  const cues: EpisodeBgmCue[] = []

  let i = 0
  let currentTime = 0

  while (i < shots.length) {
    const bucket = getBucketForShot(shots[i], profiles)
    const track = getTrackForBucket(bucket, tracks)
    if (!track) break

    let actDuration = 0
    let j = i

    while (j < shots.length) {
      const nextBucket = getBucketForShot(shots[j], profiles)
      if (nextBucket === bucket) {
        actDuration += normalizeDuration(shots[j].videoDuration)
        j++
        continue
      }

      const nextTrack = getTrackForBucket(nextBucket, tracks)
      if (!nextTrack || nextTrack.path === track.path) {
        // 新情绪没有独立音乐轨，直接并入当前幕
        actDuration += normalizeDuration(shots[j].videoDuration)
        j++
        continue
      }

      // 新情绪有独立音乐轨：看它是否能形成足够长的独立幕
      const nextRun = contiguousBucketDuration(shots, profiles, j)
      const remainingAfterCurrent = totalDuration - (currentTime + actDuration)
      if (
        nextRun.duration >= minActDuration &&
        remainingAfterCurrent >= minActDuration
      ) {
        break
      }

      // 否则还是并入当前幕，保持音乐连续性
      actDuration += normalizeDuration(shots[j].videoDuration)
      j++
    }

    const start = roundTimelineSeconds(currentTime)
    const duration = roundTimelineSeconds(actDuration)
    cues.push({
      start,
      end: roundTimelineSeconds(start + duration),
      duration,
      shotStartIndex: i,
      shotEndIndex: Math.max(i, j - 1),
      bgmPath: track.path,
      emotionBucket: bucket,
    })

    i = j
    currentTime += actDuration
  }

  return cues
}
