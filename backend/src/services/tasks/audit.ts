import { db, schema } from '../../db/index.js'

export type StuckTable = 'image_generations' | 'video_generations' | 'storyboards' | 'video_merges'
export type RepairRecommendation = 'recoverable' | 'terminal_unknown' | 'needs_manual_review'

export interface StuckRowInput {
  table: StuckTable
  id: number
  status: string | null
  createdAt?: string | null
  updatedAt?: string | null
  taskId?: string | null
  errorMsg?: string | null
  localPath?: string | null
  imageUrl?: string | null
  videoUrl?: string | null
  composedImage?: string | null
  firstFrameImage?: string | null
  lastFrameImage?: string | null
  composedVideoUrl?: string | null
  scenes?: string | null
}

export interface StuckClassification {
  recommendation: RepairRecommendation
  action: string
  reason: string
  stale: boolean
  ageMs: number | null
}

export interface StuckAuditRow extends StuckClassification {
  table: StuckTable
  id: number
  status: string | null
  createdAt: string | null
  updatedAt: string | null
  taskId: string | null
  errorMsg: string | null
}

const STUCK_STATUSES = new Set(['pending', 'processing'])
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000

function parseTimeMs(value?: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function rowAgeMs(row: StuckRowInput, nowMs: number): number | null {
  const ts = parseTimeMs(row.updatedAt) ?? parseTimeMs(row.createdAt)
  return ts == null ? null : Math.max(0, nowMs - ts)
}

function hasStoryboardComposeInput(row: StuckRowInput): boolean {
  return Boolean(row.videoUrl || row.composedImage || row.firstFrameImage || row.lastFrameImage)
}

function hasMergeInput(row: StuckRowInput): boolean {
  if (!row.scenes) return false
  try {
    const scenes = JSON.parse(row.scenes)
    return Array.isArray(scenes) && scenes.some(Boolean)
  } catch {
    return false
  }
}

export function classifyStuckRow(
  row: StuckRowInput,
  opts: { nowMs?: number; staleAfterMs?: number } = {},
): StuckClassification {
  const nowMs = opts.nowMs ?? Date.now()
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const ageMs = rowAgeMs(row, nowMs)
  const stale = ageMs == null || ageMs >= staleAfterMs

  if (!stale) {
    return {
      recommendation: 'needs_manual_review',
      action: 'observe',
      reason: 'Row is not stale yet; it may still be actively processing.',
      stale,
      ageMs,
    }
  }

  if (row.table === 'image_generations' || row.table === 'video_generations') {
    if (row.taskId) {
      return {
        recommendation: 'recoverable',
        action: 'resume_provider_poll',
        reason: 'Provider task id exists, so a future worker can resume polling or reconcile provider state.',
        stale,
        ageMs,
      }
    }

    if (row.localPath || row.imageUrl || row.videoUrl) {
      return {
        recommendation: 'needs_manual_review',
        action: 'verify_output_and_mark_completed',
        reason: 'Output fields exist but the row is still pending or processing.',
        stale,
        ageMs,
      }
    }

    return {
      recommendation: 'terminal_unknown',
      action: 'mark_failed_or_retry_from_prompt',
      reason: 'No provider task id exists, so the external generation cannot be resumed safely.',
      stale,
      ageMs,
    }
  }

  if (row.table === 'storyboards') {
    if (hasStoryboardComposeInput(row)) {
      return {
        recommendation: 'recoverable',
        action: 'rerun_compose',
        reason: 'Storyboard has source media, so compose can be safely retried by a future task.',
        stale,
        ageMs,
      }
    }

    return {
      recommendation: 'terminal_unknown',
      action: 'clear_compose_status_after_review',
      reason: 'Storyboard is marked compose_processing but has no source media to compose.',
      stale,
      ageMs,
    }
  }

  if (row.table === 'video_merges') {
    if (hasMergeInput(row)) {
      return {
        recommendation: 'recoverable',
        action: 'rerun_merge',
        reason: 'Merge record still has its source scene list, so merge can be retried.',
        stale,
        ageMs,
      }
    }

    return {
      recommendation: 'terminal_unknown',
      action: 'mark_failed_after_review',
      reason: 'Merge record has no valid source scene list to retry.',
      stale,
      ageMs,
    }
  }

  return {
    recommendation: 'needs_manual_review',
    action: 'inspect_row',
    reason: 'Unknown stuck row type.',
    stale,
    ageMs,
  }
}

function isPendingOrProcessing(status: string | null | undefined) {
  return STUCK_STATUSES.has(String(status || ''))
}

function toAuditRow(row: StuckRowInput, nowMs: number): StuckAuditRow {
  return {
    table: row.table,
    id: row.id,
    status: row.status,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    taskId: row.taskId ?? null,
    errorMsg: row.errorMsg ?? null,
    ...classifyStuckRow(row, { nowMs }),
  }
}

export function getStuckTaskAudit(opts: { nowMs?: number } = {}) {
  const nowMs = opts.nowMs ?? Date.now()
  const rows: StuckAuditRow[] = []

  for (const row of db.select().from(schema.imageGenerations).all()) {
    if (!isPendingOrProcessing(row.status)) continue
    rows.push(toAuditRow({
      table: 'image_generations',
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      taskId: row.taskId,
      errorMsg: row.errorMsg,
      localPath: row.localPath,
      imageUrl: row.imageUrl,
    }, nowMs))
  }

  for (const row of db.select().from(schema.videoGenerations).all()) {
    if (!isPendingOrProcessing(row.status) || row.deletedAt) continue
    rows.push(toAuditRow({
      table: 'video_generations',
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      taskId: row.taskId,
      errorMsg: row.errorMsg,
      localPath: row.localPath,
      videoUrl: row.videoUrl,
    }, nowMs))
  }

  for (const row of db.select().from(schema.storyboards).all()) {
    if (row.status !== 'compose_processing' || row.deletedAt) continue
    rows.push(toAuditRow({
      table: 'storyboards',
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      videoUrl: row.videoUrl,
      composedImage: row.composedImage,
      firstFrameImage: row.firstFrameImage,
      lastFrameImage: row.lastFrameImage,
      composedVideoUrl: row.composedVideoUrl,
    }, nowMs))
  }

  for (const row of db.select().from(schema.videoMerges).all()) {
    if (!isPendingOrProcessing(row.status) || row.deletedAt) continue
    rows.push(toAuditRow({
      table: 'video_merges',
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      taskId: row.taskId,
      errorMsg: row.errorMsg,
      scenes: row.scenes,
    }, nowMs))
  }

  const byRecommendation = rows.reduce<Record<RepairRecommendation, number>>((acc, row) => {
    acc[row.recommendation] += 1
    return acc
  }, { recoverable: 0, terminal_unknown: 0, needs_manual_review: 0 })

  const byTable = rows.reduce<Record<StuckTable, number>>((acc, row) => {
    acc[row.table] += 1
    return acc
  }, { image_generations: 0, video_generations: 0, storyboards: 0, video_merges: 0 })

  return {
    generated_at: new Date(nowMs).toISOString(),
    stale_after_seconds: DEFAULT_STALE_AFTER_MS / 1000,
    counts: {
      total: rows.length,
      by_recommendation: byRecommendation,
      by_table: byTable,
    },
    rows: rows.map(row => ({
      table: row.table,
      id: row.id,
      status: row.status,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      task_id: row.taskId,
      error_msg: row.errorMsg,
      age_seconds: row.ageMs == null ? null : Math.round(row.ageMs / 1000),
      stale: row.stale,
      recommendation: row.recommendation,
      action: row.action,
      reason: row.reason,
    })),
  }
}
