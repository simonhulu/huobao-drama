import type Database from 'better-sqlite3'

type ActiveDharmaRenderRow = {
  id: number
  status: 'queued' | 'running'
  episodeId: number
  leaseExpiresAt: string | null
  commitClaimedAt: string | null
  updatedAt: string
}

export interface DharmaRenderStartupReconciliationResult {
  expiredCommitClaimsMarkedStale: number
  duplicateActiveRendersMarkedStale: number
  reconciledEpisodeIds: number[]
}

function isLiveLease(leaseExpiresAt: string | null, nowMs: number): boolean {
  if (!leaseExpiresAt) return false
  const expiresAtMs = Date.parse(leaseExpiresAt)
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs
}

function activeRenderPriority(row: ActiveDharmaRenderRow, nowMs: number): number {
  const liveLease = isLiveLease(row.leaseExpiresAt, nowMs)
  if (liveLease && row.commitClaimedAt) return 40
  if (liveLease && row.status === 'running') return 30
  if (row.status === 'queued') return 20
  return 10
}

function markTaskStale(
  sqlite: Database.Database,
  taskId: number,
  now: string,
  errorCode: string,
  errorMessage: string,
  eventData: Record<string, unknown>,
): boolean {
  const updated = sqlite.prepare(`
    UPDATE creation_tasks
    SET status = 'stale',
        lease_owner = NULL,
        lease_expires_at = NULL,
        error_code = ?,
        error_message = ?,
        updated_at = ?,
        completed_at = COALESCE(completed_at, ?)
    WHERE id = ?
      AND type = 'dharma.episode_render'
      AND status IN ('queued', 'running')
  `).run(errorCode, errorMessage, now, now, taskId)
  if (updated.changes !== 1) return false

  sqlite.prepare(`
    INSERT INTO creation_task_events (task_id, event_type, data_json, created_at)
    VALUES (?, 'startup.reconciled', ?, ?)
  `).run(taskId, JSON.stringify(eventData), now)
  return true
}

/**
 * Reconcile pre-index historical rows before adding the one-active-render
 * constraint. Startup cannot leave a claimed publish eligible for automatic
 * retry, and must not fail entirely just because old versions created two
 * active rows for one episode.
 *
 * The caller owns the surrounding immediate transaction so no concurrent task
 * insertion can race the reconciliation and partial unique-index creation.
 */
export function reconcileDharmaActiveRenderStartupState(
  sqlite: Database.Database,
  now = new Date().toISOString(),
): DharmaRenderStartupReconciliationResult {
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw new Error(`Invalid reconciliation timestamp: ${now}`)

  const activeRows = () => sqlite.prepare(`
    SELECT
      id,
      status,
      episode_id AS episodeId,
      lease_expires_at AS leaseExpiresAt,
      commit_claimed_at AS commitClaimedAt,
      updated_at AS updatedAt
    FROM creation_tasks
    WHERE type = 'dharma.episode_render'
      AND status IN ('queued', 'running')
      AND episode_id IS NOT NULL
  `).all() as ActiveDharmaRenderRow[]

  const reconciledEpisodeIds = new Set<number>()
  let expiredCommitClaimsMarkedStale = 0
  let duplicateActiveRendersMarkedStale = 0

  // A durable commit claim is intentionally never resumed after its lease
  // dies. It may already have crossed a filesystem boundary, so it needs an
  // explicit reconciliation instead of a second render or publish attempt.
  for (const row of activeRows()) {
    if (!row.commitClaimedAt || isLiveLease(row.leaseExpiresAt, nowMs)) continue
    if (markTaskStale(
      sqlite,
      row.id,
      now,
      'task_commit_claimed_reconciliation_required',
      'Startup found an expired Dharma render after its commit point was claimed; automatic retry is forbidden and delivery reconciliation is required.',
      { reason: 'expired_commit_claim', episode_id: row.episodeId, commit_claimed_at: row.commitClaimedAt },
    )) {
      expiredCommitClaimsMarkedStale += 1
      reconciledEpisodeIds.add(row.episodeId)
    }
  }

  const byEpisode = new Map<number, ActiveDharmaRenderRow[]>()
  for (const row of activeRows()) {
    const rows = byEpisode.get(row.episodeId) ?? []
    rows.push(row)
    byEpisode.set(row.episodeId, rows)
  }

  for (const [episodeId, rows] of byEpisode) {
    if (rows.length < 2) continue
    const winner = [...rows].sort((left, right) => {
      const priority = activeRenderPriority(right, nowMs) - activeRenderPriority(left, nowMs)
      if (priority !== 0) return priority
      const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      if (Number.isFinite(updated) && updated !== 0) return updated
      return right.id - left.id
    })[0]

    for (const row of rows) {
      if (row.id === winner.id) continue
      if (markTaskStale(
        sqlite,
        row.id,
        now,
        'duplicate_active_dharma_render',
        `Startup reconciled duplicate active Dharma renders for episode ${episodeId}; task ${winner.id} remains authoritative.`,
        { reason: 'duplicate_active_dharma_render', episode_id: episodeId, authoritative_task_id: winner.id },
      )) {
        duplicateActiveRendersMarkedStale += 1
        reconciledEpisodeIds.add(episodeId)
      }
    }
  }

  return {
    expiredCommitClaimsMarkedStale,
    duplicateActiveRendersMarkedStale,
    reconciledEpisodeIds: [...reconciledEpisodeIds].sort((left, right) => left - right),
  }
}
