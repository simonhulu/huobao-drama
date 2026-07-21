/**
 * Editorial rhythm shared by the Remotion planner and its stage gates.
 * These values describe a default documentary cadence, not a renderer limit.
 */
export const REMOTION_SHOT_RHYTHM = Object.freeze({
  targetShotDurationMs: 6000,
  minShotDurationMs: 2500,
  maxShotDurationMs: 9000,
  hardMaxShotDurationMs: 12000,
  maxNarrationChars: 42,
  charsPerSecond: 4.8,
})

export interface RemotionNarrationSegment {
  text: string
  durationMs: number
}

function effectiveLength(value: string) {
  return Array.from(value.replace(/\s+/g, '')).length
}

export function estimateNarrationDurationMs(text: string) {
  const chars = effectiveLength(text)
  return Math.max(1000, Math.round((chars / REMOTION_SHOT_RHYTHM.charsPerSecond) * 1000))
}

function splitByBoundary(text: string, boundary: RegExp) {
  return text
    .split(boundary)
    .map((part) => part.trim())
    .filter(Boolean)
}

function hardSplit(text: string, maxChars: number) {
  const chars = Array.from(text)
  const parts: string[] = []
  for (let start = 0; start < chars.length; start += maxChars) {
    parts.push(chars.slice(start, start + maxChars).join('').trim())
  }
  return parts.filter(Boolean)
}

/**
 * Break narration at semantic punctuation first, then at clauses, and only
 * use a hard character boundary as the last resort. The planner later groups
 * these units without changing their order or text.
 */
function atomicNarrationUnits(text: string, maxChars: number) {
  const sentences = splitByBoundary(text, /(?<=[。！？!?；;])|\n+/)
  const units: string[] = []

  for (const sentence of sentences) {
    if (effectiveLength(sentence) <= maxChars) {
      units.push(sentence)
      continue
    }

    const clauses = splitByBoundary(sentence, /(?<=[，,、：:])|(?<=——)|(?<=[-])/) 
    for (const clause of clauses) {
      if (effectiveLength(clause) <= maxChars) units.push(clause)
      else units.push(...hardSplit(clause, maxChars))
    }
  }

  return units.length ? units : hardSplit(text, maxChars)
}

function groupUnits(units: string[], maxChars: number) {
  const targetChars = Math.max(1, Math.round(
    REMOTION_SHOT_RHYTHM.targetShotDurationMs / 1000 * REMOTION_SHOT_RHYTHM.charsPerSecond,
  ))
  const groups: string[] = []
  let current: string[] = []
  let currentChars = 0

  const pushCurrent = () => {
    if (current.length) groups.push(current.join('').trim())
    current = []
    currentChars = 0
  }

  for (const unit of units) {
    const unitChars = effectiveLength(unit)
    const wouldExceed = current.length > 0 && currentChars + unitChars > maxChars
    const isAlreadyTargeted = current.length > 0 && currentChars >= targetChars
    if (wouldExceed || isAlreadyTargeted) pushCurrent()
    current.push(unit)
    currentChars += unitChars
  }
  pushCurrent()

  // Avoid a one-clause tail when it can be joined without violating the
  // rhythm cap. This keeps cuts from landing on an unnecessarily tiny unit.
  if (groups.length > 1) {
    const last = groups[groups.length - 1]
    const previous = groups[groups.length - 2]
    if (effectiveLength(last) < Math.round(targetChars / 2)
      && effectiveLength(previous) + effectiveLength(last) <= maxChars) {
      groups.splice(groups.length - 2, 2, `${previous}${last}`)
    }
  }

  return groups
}

function allocateDurations(groups: string[], sourceDurationMs: number) {
  const lengths = groups.map(effectiveLength)
  const totalLength = lengths.reduce((sum, length) => sum + length, 0)
  if (!totalLength) return groups.map(() => 1000)

  const durations = lengths.map((length) => Math.max(
    1,
    Math.round(sourceDurationMs * length / totalLength),
  ))
  const delta = sourceDurationMs - durations.reduce((sum, duration) => sum + duration, 0)
  if (durations.length) durations[durations.length - 1] = Math.max(1, durations[durations.length - 1] + delta)
  return durations
}

export function splitNarrationToSegments(
  text: string,
  sourceDurationMs?: number | null,
): RemotionNarrationSegment[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []

  const estimatedDurationMs = estimateNarrationDurationMs(normalized)
  const durationMs = Number.isFinite(sourceDurationMs) && Number(sourceDurationMs) > 0
    ? Math.round(Number(sourceDurationMs))
    : estimatedDurationMs

  // If the supplied audio duration is slower than the text estimate, lower
  // the per-unit character cap so no single shot inherits a long pause.
  const durationAwareCap = Math.floor(
    REMOTION_SHOT_RHYTHM.hardMaxShotDurationMs
      / durationMs
      * effectiveLength(normalized),
  )
  const maxChars = Math.max(1, Math.min(
    REMOTION_SHOT_RHYTHM.maxNarrationChars,
    durationAwareCap || REMOTION_SHOT_RHYTHM.maxNarrationChars,
  ))
  const units = atomicNarrationUnits(normalized, maxChars)
  const groups = groupUnits(units, maxChars)
  const durations = allocateDurations(groups, durationMs)

  return groups.map((group, index) => ({
    text: group,
    durationMs: durations[index] || estimateNarrationDurationMs(group),
  }))
}

export function isLongShotDuration(durationMs: number) {
  return durationMs > REMOTION_SHOT_RHYTHM.maxShotDurationMs
}

export function isHardMaxShotViolation(durationMs: number) {
  return durationMs > REMOTION_SHOT_RHYTHM.hardMaxShotDurationMs
}
