import type Database from 'better-sqlite3'

export interface HistoryVideoPackagingRow {
  video_id: number
  script_id: number
  title: string
  baijiahao_title: string
  description: string
  video_path: string | null
  video_name: string | null
  duration: number | null
  script_sha256: string | null
  cover_script_sha256: string | null
  cover_design_json: string
  covers_json: string
  design_status: string
  design_run_id: string | null
  design_lease_until: string | null
  design_error: string | null
  cover_status: string
  cover_run_id: string | null
  cover_lease_until: string | null
  error: string | null
  updated_at: string
}

export function ensureHistoryVideoPackagingSchema(sql: Database.Database) {
  sql.exec(`CREATE TABLE IF NOT EXISTS history_video_packaging (
    video_id INTEGER PRIMARY KEY, script_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '', baijiahao_title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    video_path TEXT, video_name TEXT, duration REAL, script_sha256 TEXT, cover_script_sha256 TEXT,
    cover_design_json TEXT NOT NULL DEFAULT '{}', covers_json TEXT NOT NULL DEFAULT '{}',
    design_status TEXT NOT NULL DEFAULT 'idle', design_run_id TEXT, design_lease_until TEXT, design_error TEXT,
    cover_status TEXT NOT NULL DEFAULT 'idle', cover_run_id TEXT, cover_lease_until TEXT, error TEXT, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS history_video_packaging_source ON history_video_packaging(script_id,video_id);`)
}

/** A bound upload must never substitute the source's shared packaging. */
export function getHistoryVideoPackagingRow(sql: Database.Database, scriptId: number, videoId: number) {
  ensureHistoryVideoPackagingSchema(sql)
  return sql.prepare('SELECT * FROM history_video_packaging WHERE script_id=? AND video_id=?')
    .get(scriptId, videoId) as HistoryVideoPackagingRow | undefined
}

export function historyDeliveryStore(id: number, videoId?: number) {
  return videoId === undefined
    ? { table: 'history_script_deliveries', column: 'script_id', key: id }
    : { table: 'history_video_packaging', column: 'video_id', key: videoId }
}
