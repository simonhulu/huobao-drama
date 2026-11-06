import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { isHistorySubmissionReceipt } from './history-production-state.js'

export const HISTORY_YOUTUBE_PRODUCTION_WINDOW_MS = 15 * 24 * 60 * 60 * 1000
type Row = Record<string, any>
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const object = (value: unknown): Row => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}
const tableExists = (database: Database.Database, table: string) => Boolean(database.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
).get(table))

function deliveries(database: Database.Database, sourceId: number) {
  if (!tableExists(database, 'history_video_deliveries')) return []
  return database.prepare(`SELECT script_sha256,producer,producer_job_id,created_at FROM history_video_deliveries
    WHERE script_id=? AND duration>0 AND length(video_sha256)=64 AND length(script_sha256)=64 AND video_path<>''`)
    .all(sourceId) as Array<{script_sha256: string; producer: string; producer_job_id: string | null; created_at: string}>
}

/** Accepted deliveries survive media reclamation; observation and upload timestamps are not production dates. */
export function hasRecentHistoryYoutubeProduction(database: Database.Database, videoId: string, nowMs = Date.now()) {
  const source = database.prepare('SELECT id FROM history_script_sources WHERE platform=? AND source_video_id=?')
    .get('youtube', videoId) as {id: number} | undefined
  return Boolean(source && deliveries(database, source.id).some(video => {
    const completedAt = Date.parse(video.created_at)
    return completedAt >= nowMs - HISTORY_YOUTUBE_PRODUCTION_WINDOW_MS && completedAt <= nowMs
  }))
}

export function hasProducedHistoryYoutubeScript(database: Database.Database, sourceId: number, scriptHash: string) {
  return deliveries(database, sourceId).some(video => video.script_sha256 === scriptHash)
}

function productionActivity(database: Database.Database, sourceId: number, accepted: ReturnType<typeof deliveries>) {
  const rows = (table: string, owner: string) => tableExists(database, table)
    ? database.prepare(`SELECT * FROM ${table} WHERE ${owner}=?`).all(sourceId) as Row[] : []
  for (const row of rows('history_motion_productions', 'script_id')) {
    const status = object(row.snapshot).status ?? row.status
    if (!['completed', 'failed', 'deleted', 'canceled'].includes(status)) return '原精细化任务仍在制作'
  }
  for (const row of rows('history_huasheng_jobs', 'source_id')) {
    if (accepted.some(video => video.producer === 'huasheng' && video.producer_job_id === String(row.id))) continue
    if (['queued', 'running', 'submitted'].includes(row.status) || row.project_url
      || [row.stage, row.checkpoint].includes('create_pending')) return '原花生项目仍在执行或结果待核对'
  }
  for (const row of rows('history_huasheng_export_jobs', 'source_id')) {
    if (!['completed', 'failed', 'canceled'].includes(row.status)) return '原成片导出仍在执行或结果待核对'
  }
  for (const row of rows('history_social_upload_jobs', 'source_id')) {
    if (row.status === 'completed' && (isHistorySubmissionReceipt(object(row.result_json)) || object(row.result_json).saved === true)) continue
    if (['queued', 'running', 'uncertain', 'awaiting_confirmation'].includes(row.status)
      || row.upload_dispatched || row.result_json || row.operation === 'recover') return '原上传仍在执行或结果待核对'
  }
  for (const row of rows('history_video_packaging', 'script_id')) {
    if (row.design_status === 'generating' || row.cover_status === 'generating') return '原发布材料仍在生成'
  }
  if (tableExists(database, 'creation_tasks') && database.prepare(`SELECT 1 FROM creation_tasks
    WHERE type='history.production.continue' AND scope_id=? AND status IN ('queued','running') LIMIT 1`).get(sourceId)) {
    return '原继续生产任务仍在执行'
  }
  return null
}

/** Preserve canonical identity and paid-work checkpoints; only an expired, idle produced draft starts another writing cycle. */
export function prepareHistoryYoutubeRecollection(database: Database.Database, sourceId: number, taskId: number, nowMs = Date.now()) {
  return database.transaction(() => {
    const source = database.prepare("SELECT * FROM history_script_sources WHERE id=? AND platform='youtube'").get(sourceId) as Row | undefined
    if (!source) throw new Error('YouTube 来源不存在')
    const accepted = deliveries(database, sourceId)
    if (hasRecentHistoryYoutubeProduction(database, source.source_video_id, nowMs)) return {recent: true, renewed: false, busy: null}
    const busy = productionActivity(database, sourceId, accepted)
    const ts = new Date(nowMs).toISOString()
    const previousHash = typeof source.rewritten_script === 'string' && source.rewritten_script.trim() ? digest(source.rewritten_script) : null
    const producedDraft = previousHash && accepted.some(video => video.script_sha256 === previousHash)
    const alreadyRenewed = tableExists(database, 'history_youtube_collection_cycles') && database.prepare(
      'SELECT 1 FROM history_youtube_collection_cycles WHERE source_id=? AND task_id=?',
    ).get(sourceId, taskId)
    if (!busy && producedDraft && !alreadyRenewed) {
      database.exec(`CREATE TABLE IF NOT EXISTS history_youtube_collection_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, task_id INTEGER NOT NULL,
        previous_script_sha256 TEXT NOT NULL, source_snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(source_id,task_id)
      )`)
      database.prepare(`INSERT INTO history_youtube_collection_cycles
        (source_id,task_id,previous_script_sha256,source_snapshot_json,created_at) VALUES(?,?,?,?,?)`)
        .run(sourceId, taskId, previousHash, JSON.stringify(source), ts)
      const review = object(source.review_json)
      for (const key of ['recreation', 'recreationPlan', 'rewriteInputSha256', 'huashengQueue', 'scriptTiming']) delete review[key]
      review.youtubeRecollection = {taskId, previousScriptSha256: previousHash, startedAt: ts}
      database.prepare(`UPDATE history_script_sources SET deleted_at=NULL,rewritten_script=NULL,review_json=?,
        status=?,last_error=NULL,updated_at=? WHERE id=?`)
        .run(JSON.stringify(review), source.corrected_transcript ? 'corrected' : source.raw_transcript ? 'transcribed' : 'selected', ts, sourceId)
      return {recent: false, renewed: true, busy: null}
    }
    if (source.deleted_at) database.prepare('UPDATE history_script_sources SET deleted_at=NULL,updated_at=? WHERE id=?').run(ts, sourceId)
    return {recent: false, renewed: false, busy}
  }).immediate()
}
