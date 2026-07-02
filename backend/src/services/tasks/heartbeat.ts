import { eq, gte, lte } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'

export interface WorkerHeartbeat {
  workerId: string
  pid: number
  startedAt: string
  lastSeenAt: string
}

export interface WorkerHealth {
  worker_id: string
  pid: number | null
  started_at: string
  last_seen_at: string
  healthy: boolean
}

const HEARTBEAT_INTERVAL_MS = 10_000
const HEARTBEAT_TIMEOUT_MS = 30_000

export function recordWorkerHeartbeat(workerId: string): WorkerHeartbeat {
  const ts = now()
  const pid = process.pid
  db.insert(schema.workerHeartbeats)
    .values({
      workerId,
      pid,
      startedAt: ts,
      lastSeenAt: ts,
    })
    .onConflictDoUpdate({
      target: schema.workerHeartbeats.workerId,
      set: { pid, lastSeenAt: ts },
    })
    .run()
  return { workerId, pid, startedAt: ts, lastSeenAt: ts }
}

export function removeWorkerHeartbeat(workerId: string): void {
  db.delete(schema.workerHeartbeats)
    .where(eq(schema.workerHeartbeats.workerId, workerId))
    .run()
}

export function listWorkerHeartbeats(): WorkerHealth[] {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString()
  const rows = db.select().from(schema.workerHeartbeats).all()
  return rows.map((row) => ({
    worker_id: row.workerId,
    pid: row.pid,
    started_at: row.startedAt,
    last_seen_at: row.lastSeenAt,
    healthy: row.lastSeenAt >= cutoff,
  }))
}

export function getHealthyWorkerCount(): number {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString()
  return db.select().from(schema.workerHeartbeats)
    .where(gte(schema.workerHeartbeats.lastSeenAt, cutoff))
    .all()
    .length
}

export function pruneStaleWorkerHeartbeats(): number {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS * 2).toISOString()
  const result = db.delete(schema.workerHeartbeats)
    .where(lte(schema.workerHeartbeats.lastSeenAt, cutoff))
    .run()
  return result.changes ?? 0
}

export function getHeartbeatIntervalMs(): number {
  return HEARTBEAT_INTERVAL_MS
}

export function getHeartbeatTimeoutMs(): number {
  return HEARTBEAT_TIMEOUT_MS
}
