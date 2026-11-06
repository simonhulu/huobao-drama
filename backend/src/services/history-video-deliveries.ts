import type Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isHistorySubmissionReceipt } from './history-production-state.js'

export type HistoryVideoProducer = 'huasheng' | 'motion' | 'manual'
export type HistoryProductionMode = 'dual' | 'motion_backfill'
export interface HistoryVideoDelivery {
  id: number
  scriptId: number
  scriptSha256: string
  producer: HistoryVideoProducer
  producerJobId: string | null
  videoUrl: string
  videoName: string
  duration: number
  sha256: string
  createdAt: string
}
export function ensureHistoryVideoDeliveriesSchema(sql: Database.Database) {
  sql.exec(`CREATE TABLE IF NOT EXISTS history_video_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id INTEGER NOT NULL, script_sha256 TEXT NOT NULL,
    producer TEXT NOT NULL CHECK(producer IN ('huasheng','motion','manual')),
    producer_job_id TEXT, video_path TEXT NOT NULL, video_name TEXT NOT NULL,
    duration REAL NOT NULL, video_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(script_id,script_sha256,producer,video_sha256)
  );
  CREATE INDEX IF NOT EXISTS history_video_deliveries_source ON history_video_deliveries(script_id,script_sha256,id);`)
}
const columns = `id,script_id AS scriptId,script_sha256 AS scriptSha256,producer,producer_job_id AS producerJobId,
  video_path AS videoUrl,video_name AS videoName,duration,video_sha256 AS sha256,created_at AS createdAt`
export function recordHistoryVideoDelivery(sql: Database.Database, value: Omit<HistoryVideoDelivery, 'id' | 'createdAt'>) {
  ensureHistoryVideoDeliveriesSchema(sql)
  sql.prepare(`INSERT OR IGNORE INTO history_video_deliveries
    (script_id,script_sha256,producer,producer_job_id,video_path,video_name,duration,video_sha256,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(value.scriptId,value.scriptSha256,value.producer,value.producerJobId,
      value.videoUrl,value.videoName,value.duration,value.sha256,new Date().toISOString())
  return sql.prepare(`SELECT ${columns} FROM history_video_deliveries
    WHERE script_id=? AND script_sha256=? AND producer=? AND video_sha256=?`)
    .get(value.scriptId,value.scriptSha256,value.producer,value.sha256) as HistoryVideoDelivery
}
export function listHistoryVideoDeliveries(sql: Database.Database, scriptId: number, scriptSha256?: string) {
  ensureHistoryVideoDeliveriesSchema(sql)
  return sql.prepare(`SELECT ${columns} FROM history_video_deliveries WHERE script_id=?
    ${scriptSha256 ? 'AND script_sha256=?' : ''} ORDER BY id DESC`)
    .all(scriptId,...(scriptSha256 ? [scriptSha256] : [])) as HistoryVideoDelivery[]
}
export function currentHistoryVideoDeliveries(sql: Database.Database, scriptId: number, scriptSha256: string) {
  const seen = new Set<HistoryVideoProducer>()
  return listHistoryVideoDeliveries(sql,scriptId,scriptSha256).filter(video => {
    if(seen.has(video.producer)) return false
    seen.add(video.producer);return true
  })
}

export function ensureHistoryDualProductionSchema(sql: Database.Database) {
  sql.exec(`CREATE TABLE IF NOT EXISTS history_dual_production (
    source_id INTEGER NOT NULL, script_sha256 TEXT NOT NULL, huasheng_job_id INTEGER NOT NULL,
    motion_job_id TEXT, episode_id INTEGER, huasheng_state TEXT NOT NULL DEFAULT 'pending',
    motion_state TEXT NOT NULL DEFAULT 'pending', huasheng_error TEXT, motion_error TEXT,
    export_requested INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0,
    production_mode TEXT NOT NULL DEFAULT 'dual',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(source_id,script_sha256)
  )`)
  if (!(sql.pragma('table_info(history_dual_production)') as Array<{name:string}>).some(column=>column.name==='production_mode')) {
    sql.exec("ALTER TABLE history_dual_production ADD COLUMN production_mode TEXT NOT NULL DEFAULT 'dual'")
  }
}
/** Written in the same transaction that accepts the source creation marker. */
export function recordHistoryDualProduction(sql: Database.Database, sourceId: number, scriptHash: string, huashengJobId: number) {
  ensureHistoryDualProductionSchema(sql)
  const ts = new Date().toISOString()
  sql.prepare(`INSERT INTO history_dual_production
    (source_id,script_sha256,huasheng_job_id,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(source_id,script_sha256) DO UPDATE SET production_mode='dual',updated_at=excluded.updated_at
      WHERE history_dual_production.production_mode='motion_backfill'`).run(sourceId,scriptHash,huashengJobId,ts,ts)
}

/** Explicitly admitted historical work: the old Huasheng branch is already finished. */
export function recordHistoryRefinedBackfill(sql: Database.Database, sourceId: number, scriptHash: string, huashengJobId: number) {
  ensureHistoryDualProductionSchema(sql)
  const ts = new Date().toISOString()
  sql.prepare(`INSERT OR IGNORE INTO history_dual_production
    (source_id,script_sha256,huasheng_job_id,production_mode,huasheng_state,export_requested,created_at,updated_at)
    VALUES(?,?,?,'motion_backfill','completed',1,?,?)`).run(sourceId,scriptHash,huashengJobId,ts,ts)
}

export function ensureHistoryVideoPublicationSchema(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS history_video_publication_intents (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, script_sha256 TEXT NOT NULL,
    video_id INTEGER NOT NULL, producer TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(source_id,script_sha256,video_id)
  ); CREATE INDEX IF NOT EXISTS history_video_publication_due ON history_video_publication_intents(status,next_attempt_at);`)
}

export function legacyHistoryVideoPublication(sql: Database.Database, video: Pick<HistoryVideoDelivery,'scriptId'|'videoUrl'>,
  root = process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url))) {
  if (!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_social_upload_jobs'").get()) return undefined
  const columns = new Set((sql.pragma('table_info(history_social_upload_jobs)') as Array<{name:string}>).map(column=>column.name))
  if (!['video_id','publication_mode','payload_json','result_json','error','message'].every(column=>columns.has(column))) return undefined
  const filename = path.resolve(root,video.videoUrl.replace(/^\/?static\//,''))
  const attempted = ['result_json IS NOT NULL',columns.has('upload_dispatched')?'upload_dispatched=1':'',
    columns.has('operation')?"operation='recover'":''].filter(Boolean).join(' OR ')
  const rows = sql.prepare(`SELECT id,status,error,message,payload_json,result_json FROM history_social_upload_jobs
    WHERE source_id=? AND target='baijiahao-video' AND publication_mode='publish' AND video_id IS NULL
      AND (status<>'canceled' OR ${attempted}) ORDER BY id DESC`).all(video.scriptId) as Array<{
        id:number;status:string;error:string|null;message:string;payload_json:string|null;result_json:string|null
      }>
  const matches = rows.filter(row=>{
    try {
      const payload = JSON.parse(row.payload_json || '{}')
      return typeof payload.videoPath==='string' && path.resolve(payload.videoPath)===filename
    } catch { return false }
  })
  return matches.find(row => {
    try { return row.status === 'completed' && isHistorySubmissionReceipt(JSON.parse(row.result_json || 'null')) }
    catch { return false }
  }) ?? matches[0]
}

/** Record only an accepted output, preserving a legacy attempt for the same file. */
export function recordHistoryVideoPublication(sql: Database.Database, sourceId:number, scriptSha256:string, videoId:number, producer:HistoryVideoProducer) {
  ensureHistoryVideoPublicationSchema(sql)
  const now = new Date().toISOString()
  const video = listHistoryVideoDeliveries(sql,sourceId,scriptSha256).find(item=>item.id===videoId)
  const legacy = video && legacyHistoryVideoPublication(sql,video)
  let submitted = false
  try {
    const result = JSON.parse(legacy?.result_json || '{}')
    submitted = legacy?.status==='completed' && isHistorySubmissionReceipt(result)
  } catch { /* A missing receipt cannot authorize a second publication. */ }
  const status = legacy ? submitted ? 'completed' : 'failed' : 'pending'
  const error = legacy && !submitted ? `复用原百家号发表任务 #${legacy.id}：${legacy.error || legacy.message || '等待原任务核对结果'}` : null
  sql.prepare(`INSERT OR IGNORE INTO history_video_publication_intents
    (source_id,script_sha256,video_id,producer,status,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(sourceId,scriptSha256,videoId,producer,status,error,now,now)
  return sql.prepare('SELECT * FROM history_video_publication_intents WHERE source_id=? AND script_sha256=? AND video_id=?')
    .get(sourceId,scriptSha256,videoId)
}


export function hasHistoryDualProduction(sql: Database.Database, sourceId:number, scriptHash:string) {
  ensureHistoryDualProductionSchema(sql)
  return !!sql.prepare('SELECT 1 FROM history_dual_production WHERE source_id=? AND script_sha256=?').get(sourceId,scriptHash)
}

export function allowsHistoryVideoPublication(sql: Database.Database, sourceId:number, scriptHash:string, producer:HistoryVideoProducer) {
  ensureHistoryDualProductionSchema(sql)
  const row=sql.prepare('SELECT production_mode FROM history_dual_production WHERE source_id=? AND script_sha256=?')
    .get(sourceId,scriptHash) as {production_mode:HistoryProductionMode}|undefined
  return row?.production_mode==='dual' || (row?.production_mode==='motion_backfill' && producer==='motion')
}
