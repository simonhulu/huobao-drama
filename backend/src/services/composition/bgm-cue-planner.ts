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
