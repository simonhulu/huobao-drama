import {
  DHARMA_REVIEW_PILOT_DURATION_SEC,
  isDharmaReviewPilotDuration,
} from './dharma-props.js'

export const DHARMA_CANARY_MIN_DURATION_SEC = 15
export const DHARMA_CANARY_MAX_DURATION_SEC = 30

/** The only payload shape that a newly admitted Dharma render may persist. */
export interface DharmaRenderPayload {
  episode_id: number
  only_storyboard_ids?: number[]
  max_duration_sec?: number
  review_kind?: 'canary'
}

export interface DharmaRenderPayloadPlan {
  payload: DharmaRenderPayload
  source: 'canonical' | 'legacy'
  isPreview: boolean
  isReviewPilot: boolean
  isReviewCanary: boolean
}

export interface DharmaRenderArtifact {
  fileStem: string
  isPreview: boolean
  isReviewPilot: boolean
  isReviewCanary?: true
}

type ParseMode = 'canonical' | 'historical'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function toPositiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function toPositiveFiniteNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function isDharmaCanaryDuration(value: number | undefined): value is number {
  return value !== undefined
    && value >= DHARMA_CANARY_MIN_DURATION_SEC
    && value <= DHARMA_CANARY_MAX_DURATION_SEC
}

function normalizeCanonicalStoryboardIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const ids = value.map(toPositiveSafeInteger)
  if (ids.some((id) => id === null)) return null
  const normalized = ids as number[]
  if (new Set(normalized).size !== normalized.length) return null
  return [...normalized].sort((left, right) => left - right)
}

/**
 * Parse a stored Dharma payload. `canonical` is used for live execution and
 * deliberately rejects camelCase fields. `historical` reproduces the old
 * handler semantics for an already-created task: it accepted `episodeId`, but
 * ignored camelCase preview fields, so those tasks rendered formal artifacts.
 */
export function parseDharmaRenderPayload(
  value: unknown,
  options: { mode?: ParseMode; expectedEpisodeId?: number } = {},
): DharmaRenderPayloadPlan | null {
  if (!isRecord(value)) return null
  const mode = options.mode ?? 'canonical'
  const hasLegacyField = hasOwn(value, 'episodeId')
    || hasOwn(value, 'onlyStoryboardIds')
    || hasOwn(value, 'maxDurationSec')
    || hasOwn(value, 'reviewKind')

  if (mode === 'canonical' && hasLegacyField) return null

  const episodeId = toPositiveSafeInteger(
    mode === 'historical'
      ? value.episode_id ?? value.episodeId ?? options.expectedEpisodeId
      : value.episode_id,
  )
  if (episodeId === null || (options.expectedEpisodeId !== undefined && episodeId !== options.expectedEpisodeId)) {
    return null
  }

  let onlyStoryboardIds: number[] | undefined
  let maxDurationSec: number | undefined
  let reviewKind: 'canary' | undefined
  if (mode === 'canonical') {
    if (hasOwn(value, 'only_storyboard_ids')) {
      const ids = normalizeCanonicalStoryboardIds(value.only_storyboard_ids)
      if (!ids?.length) return null
      onlyStoryboardIds = ids
    }
    if (hasOwn(value, 'max_duration_sec')) {
      const duration = toPositiveFiniteNumber(value.max_duration_sec)
      if (duration === null) return null
      maxDurationSec = duration
    }
    if (hasOwn(value, 'review_kind')) {
      if (value.review_kind !== 'canary') return null
      reviewKind = value.review_kind
    }
  } else {
    // This is intentionally not alias-aware. It mirrors the historical
    // handler, which read only snake_case preview controls.
    if (Array.isArray(value.only_storyboard_ids)) {
      const ids = value.only_storyboard_ids
        .map(Number)
        .filter((id) => Number.isFinite(id) && id > 0)
      if (ids.length) onlyStoryboardIds = ids
    }
    const duration = toPositiveFiniteNumber(value.max_duration_sec)
    if (duration !== null) maxDurationSec = duration
    if (hasOwn(value, 'review_kind')) {
      if (value.review_kind !== 'canary') return null
      reviewKind = value.review_kind
    }
  }

  if (reviewKind === 'canary' && (!onlyStoryboardIds?.length || !isDharmaCanaryDuration(maxDurationSec))) {
    return null
  }

  const payload: DharmaRenderPayload = {
    episode_id: episodeId,
    ...(onlyStoryboardIds?.length ? { only_storyboard_ids: onlyStoryboardIds } : {}),
    ...(maxDurationSec !== undefined ? { max_duration_sec: maxDurationSec } : {}),
    ...(reviewKind ? { review_kind: reviewKind } : {}),
  }
  const isPreview = Boolean(payload.only_storyboard_ids?.length || payload.max_duration_sec)
  const isReviewCanary = payload.review_kind === 'canary'
  return {
    payload,
    source: mode === 'historical' && hasLegacyField ? 'legacy' : 'canonical',
    isPreview,
    isReviewPilot: !payload.only_storyboard_ids?.length && isDharmaReviewPilotDuration(payload.max_duration_sec),
    isReviewCanary,
  }
}

/** Build the canonical storage shape after the route has validated request fields. */
export function createDharmaRenderPayload(
  episodeId: number,
  options: { onlyStoryboardIds?: number[]; maxDurationSec?: number; reviewKind?: 'canary' } = {},
): DharmaRenderPayload {
  const normalizedEpisodeId = toPositiveSafeInteger(episodeId)
  if (normalizedEpisodeId === null) throw new Error('episode_id must be a positive safe integer')
  if (options.reviewKind !== undefined && options.reviewKind !== 'canary') {
    throw new Error('review_kind must be canary')
  }
  const ids = options.onlyStoryboardIds?.length
    ? normalizeCanonicalStoryboardIds(options.onlyStoryboardIds)
    : undefined
  if (options.onlyStoryboardIds?.length && !ids?.length) throw new Error('only_storyboard_ids must be unique positive integers')
  const duration = options.maxDurationSec === undefined
    ? undefined
    : toPositiveFiniteNumber(options.maxDurationSec)
  if (options.maxDurationSec !== undefined && duration === null) throw new Error('max_duration_sec must be positive and finite')
  if (options.reviewKind === 'canary' && !ids?.length) {
    throw new Error('canary requires only_storyboard_ids')
  }
  if (options.reviewKind === 'canary' && !isDharmaCanaryDuration(duration ?? undefined)) {
    throw new Error(`canary requires max_duration_sec between ${DHARMA_CANARY_MIN_DURATION_SEC} and ${DHARMA_CANARY_MAX_DURATION_SEC}`)
  }
  return {
    episode_id: normalizedEpisodeId,
    ...(ids?.length ? { only_storyboard_ids: ids } : {}),
    ...(duration !== undefined && duration !== null ? { max_duration_sec: duration } : {}),
    ...(options.reviewKind ? { review_kind: options.reviewKind } : {}),
  }
}

/** A malformed or legacy task is formal for control-plane purposes until manually reconciled. */
export function isFormalDharmaRenderPayload(value: unknown, expectedEpisodeId?: number): boolean {
  const plan = parseDharmaRenderPayload(value, { mode: 'historical', expectedEpisodeId })
  return !plan || !plan.isPreview
}

/** New render submissions only compare with canonical active task payloads. */
export function sameCanonicalDharmaRenderPayload(left: unknown, right: DharmaRenderPayload): boolean {
  const plan = parseDharmaRenderPayload(left, { mode: 'canonical' })
  return Boolean(plan
    && plan.payload.episode_id === right.episode_id
    && plan.payload.review_kind === right.review_kind
    && plan.payload.max_duration_sec === right.max_duration_sec
    && JSON.stringify(plan.payload.only_storyboard_ids ?? []) === JSON.stringify(right.only_storyboard_ids ?? []))
}

export function resolveDharmaRenderArtifact(
  episodeId: number,
  taskId: number,
  plan: Pick<DharmaRenderPayloadPlan, 'payload' | 'isPreview' | 'isReviewPilot' | 'isReviewCanary'>,
): DharmaRenderArtifact {
  if (!plan.isPreview) {
    return { fileStem: `dharma-ep${episodeId}-task${taskId}`, isPreview: false, isReviewPilot: false }
  }
  if (plan.isReviewCanary) {
    return {
      fileStem: `dharma-ep${episodeId}-canary-${plan.payload.max_duration_sec}s-task${taskId}`,
      isPreview: true,
      isReviewPilot: false,
      isReviewCanary: true,
    }
  }
  if (plan.isReviewPilot) {
    return {
      fileStem: `dharma-ep${episodeId}-pilot-${DHARMA_REVIEW_PILOT_DURATION_SEC}s-task${taskId}`,
      isPreview: true,
      isReviewPilot: true,
    }
  }
  return { fileStem: `dharma-ep${episodeId}-preview-task${taskId}`, isPreview: true, isReviewPilot: false }
}

export function dharmaRenderArtifactOutput(artifact: DharmaRenderArtifact): string {
  return `static/remotion/${artifact.fileStem}.mp4`
}
