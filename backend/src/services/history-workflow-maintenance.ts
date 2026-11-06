import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

interface Options {
  database: Database.Database
  now?: () => number
  hasSourceWorker: () => boolean
  resumeCollection: (id: number) => unknown
  onError?: (error: unknown) => void
  pollMs?: number
}
type Row = Record<string, any>
const retryDelays = [30_000, 60_000, 120_000]
const maxFailureAge = 24 * 60 * 60_000

export function createHistoryWorkflowMaintenance(options: Options) {
  const sql = options.database, now = options.now || Date.now
  sql.exec(`CREATE TABLE IF NOT EXISTS history_source_recovery (
    task_id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER, state TEXT NOT NULL, failure_key TEXT NOT NULL,
    updated_at TEXT NOT NULL, last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS history_workflow_activity (
    source_id INTEGER NOT NULL, producer TEXT NOT NULL, script_sha256 TEXT NOT NULL,
    state TEXT NOT NULL, stage TEXT NOT NULL, message TEXT NOT NULL, fingerprint TEXT NOT NULL,
    progress_at TEXT NOT NULL, observed_at TEXT NOT NULL, stall_after_ms INTEGER NOT NULL,
    PRIMARY KEY(source_id,producer,script_sha256)
  );`)

  function recoverCollection() {
    // Claim the retry and queue the original task together, including across processes.
    sql.transaction(() => {
      const timestamp = now(), iso = new Date(timestamp).toISOString()
      const task = sql.prepare("SELECT * FROM creation_tasks WHERE type='history.source' ORDER BY id DESC LIMIT 1").get() as Row | undefined
      sql.prepare(`UPDATE history_source_recovery SET state='superseded',next_attempt_at=NULL,updated_at=?
        WHERE state='scheduled' AND task_id<>?`).run(iso, task?.id ?? 0)
      if (!task) return
      const previous = sql.prepare('SELECT * FROM history_source_recovery WHERE task_id=?').get(task.id) as Row | undefined
      const failedAt = Date.parse(task.completed_at || task.updated_at)
      const eligible = task.status === 'failed' && task.error_code === 'history_source_rate_limited'
        && !task.cancel_requested && Number.isFinite(failedAt) && timestamp - failedAt <= maxFailureAge
        && timestamp >= failedAt
        && (() => { try { return JSON.parse(task.payload_json).source === 'youtube' } catch { return false } })()
      if (!eligible) {
        if (previous?.state === 'scheduled') sql.prepare(`UPDATE history_source_recovery
          SET state='stopped',next_attempt_at=NULL,updated_at=? WHERE task_id=?`).run(iso, task.id)
        return
      }
      const failureKey = String(task.completed_at || task.updated_at)
      const attempts = previous?.attempts ?? 0
      if (attempts >= retryDelays.length) {
        if (previous?.state !== 'exhausted') sql.prepare(`UPDATE history_source_recovery
          SET state='exhausted',next_attempt_at=NULL,updated_at=? WHERE task_id=?`).run(iso, task.id)
        return
      }
      if (previous?.state !== 'scheduled' || previous.failure_key !== failureKey) {
        const event = sql.prepare(`SELECT data_json FROM creation_task_events
          WHERE task_id=? AND event_type='history.rate_limit' ORDER BY id DESC LIMIT 1`).get(task.id) as Row | undefined
        let retryAfter = 0
        try {
          const value = JSON.parse(event?.data_json || '{}').retryAfterMs
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) retryAfter = value
        } catch { /* Older tasks have no structured retry delay. */ }
        sql.prepare(`INSERT INTO history_source_recovery
          (task_id,attempts,next_attempt_at,state,failure_key,updated_at) VALUES(?,?,?,'scheduled',?,?)
          ON CONFLICT(task_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,state=excluded.state,
            failure_key=excluded.failure_key,updated_at=excluded.updated_at,last_error=NULL`)
          .run(task.id, attempts, timestamp + Math.max(retryDelays[attempts]!, retryAfter), failureKey, iso)
        return
      }
      if (timestamp < previous.next_attempt_at || !options.hasSourceWorker()) return
      if (sql.prepare("SELECT 1 FROM creation_tasks WHERE type='history.source' AND status IN ('queued','running') LIMIT 1").get()) return
      options.resumeCollection(task.id)
      const resumed = sql.prepare('SELECT status FROM creation_tasks WHERE id=?').get(task.id) as Row | undefined
      if (!resumed || !['queued', 'running'].includes(resumed.status)) throw Error('Collection recovery did not queue the original task')
      sql.prepare(`UPDATE history_source_recovery SET attempts=attempts+1,state='resumed',
        next_attempt_at=NULL,updated_at=?,last_error=NULL WHERE task_id=?`).run(iso, task.id)
    }).immediate()
  }

  function observeProgress() {
    const tables = new Set((sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]).map(row => row.name))
    if (!tables.has('history_dual_production')) return
    const rows = sql.prepare(`SELECT source_id,script_sha256,huasheng_job_id,motion_job_id,huasheng_state,motion_state
      FROM history_dual_production d WHERE huasheng_state<>'completed' OR motion_state<>'completed'
        OR EXISTS(SELECT 1 FROM history_workflow_activity a WHERE a.source_id=d.source_id
          AND a.script_sha256=d.script_sha256 AND a.producer IN ('huasheng','motion') AND a.state<>'completed')`).all() as Row[]
    const observations: Row[] = []
    for (const row of rows) {
      for (const producer of ['huasheng', 'motion'] as const) {
        let state = row[`${producer}_state`], stage = state, message = ''
        if (state === 'completed' && !sql.prepare(`SELECT 1 FROM history_workflow_activity
          WHERE source_id=? AND producer=? AND script_sha256=?`).get(row.source_id,producer,row.script_sha256)) continue
        if (state !== 'completed' && producer === 'motion' && row.motion_job_id && tables.has('history_motion_productions')) {
          // Project only useful progress; the full snapshot contains large image inputs.
          const job = sql.prepare(`SELECT status,CASE WHEN json_valid(snapshot)
            THEN json_extract(snapshot,'$.stage','$.message') END AS progress
            FROM history_motion_productions WHERE id=? AND script_id=?`).get(row.motion_job_id, row.source_id) as Row | undefined
          if (job) {
            state = job.status
            const progress = JSON.parse(job.progress || '[null,null]')
            stage = progress[0] || state; message = progress[1] || ''
          }
        } else if (state !== 'completed' && producer === 'huasheng' && row.huasheng_job_id && tables.has('history_huasheng_jobs')) {
          const job = sql.prepare(`SELECT status,stage,message FROM history_huasheng_jobs
            WHERE id=? AND source_id=? AND script_sha256=?`).get(row.huasheng_job_id, row.source_id, row.script_sha256) as Row | undefined
          if (job) { state = job.status; stage = job.stage; message = job.message }
        }
        observations.push({sourceId: row.source_id, producer, scriptHash: row.script_sha256, state, stage, message})
      }
    }
    if (tables.has('history_social_upload_jobs') && tables.has('history_video_deliveries')) {
      const uploads = sql.prepare(`SELECT j.source_id,j.video_producer AS producer,d.script_sha256,j.status,
          CASE WHEN json_valid(j.result_json) THEN json_extract(j.result_json,'$.publicationStatus') END AS publication_status,
          CASE WHEN json_valid(j.progress_json) THEN json_extract(j.progress_json,'$.step') END AS stage,j.message
        FROM history_social_upload_jobs j JOIN history_dual_production d ON d.source_id=j.source_id
        JOIN history_video_deliveries v ON v.id=j.video_id AND v.script_id=j.source_id
          AND v.script_sha256=d.script_sha256 AND v.producer=j.video_producer
        WHERE j.publication_mode='publish'
          AND v.id=(SELECT MAX(current.id) FROM history_video_deliveries current WHERE current.script_id=v.script_id
            AND current.script_sha256=v.script_sha256 AND current.producer=v.producer)
          AND j.id=(SELECT MAX(newer.id) FROM history_social_upload_jobs newer WHERE newer.video_id=j.video_id)
          AND (j.status IN ('queued','running','uncertain','failed','awaiting_confirmation') OR EXISTS(
            SELECT 1 FROM history_workflow_activity a WHERE a.source_id=d.source_id AND a.script_sha256=d.script_sha256
              AND a.producer=j.video_producer||'_upload' AND a.state NOT IN ('completed','canceled')))
        ORDER BY j.id`).all() as Row[]
      for (const job of uploads) observations.push({sourceId: job.source_id, producer: `${job.producer}_upload`,
        scriptHash: job.script_sha256, state: job.status, stage: job.stage || 'upload', message: job.message})
    }
    if (!observations.length) return
    const iso = new Date(now()).toISOString()
    const record = sql.prepare(`INSERT INTO history_workflow_activity
      (source_id,producer,script_sha256,state,stage,message,fingerprint,progress_at,observed_at,stall_after_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,producer,script_sha256) DO UPDATE SET
        state=excluded.state,stage=excluded.stage,message=excluded.message,fingerprint=excluded.fingerprint,
        progress_at=CASE WHEN history_workflow_activity.fingerprint<>excluded.fingerprint
          THEN excluded.progress_at ELSE history_workflow_activity.progress_at END,
        observed_at=excluded.observed_at,stall_after_ms=excluded.stall_after_ms`)
    sql.transaction(() => {
      for (const observation of observations) {
        const {sourceId,producer,scriptHash,state} = observation
        const stage = String(observation.stage).slice(0,200), message = String(observation.message).slice(0,2000)
        const fingerprint = createHash('sha256').update(JSON.stringify([state,stage,message])).digest('hex')
        const stallAfter = /render|image|generat|creating|planning/.test(stage) ? 30 * 60_000 : 60 * 60_000
        record.run(sourceId,producer,scriptHash,state,stage,message,fingerprint,iso,iso,stallAfter)
      }
    }).immediate()
  }

  let timer: ReturnType<typeof setInterval> | undefined
  function tick() { recoverCollection(); observeProgress() }
  function start() {
    if (timer) return
    const pass = () => { try { tick() } catch (error) { options.onError?.(error) } }
    timer = setInterval(pass, options.pollMs ?? 30_000)
    timer.unref()
    pass()
  }
  function stop() { if (timer) clearInterval(timer); timer = undefined }
  return {tick, start, stop}
}
