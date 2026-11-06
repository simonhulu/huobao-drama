import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

export const HISTORY_PRODUCTION_LIMIT = 2
type Kind = 'work' | 'pipeline'
interface Reservation { key: string; source_id: number; kind: Kind; state: 'waiting' | 'active'; owner: string; host: string; pid: number }

/** A slot covers a whole project, including all of its asynchronous branches.
 * Pipeline reservations survive process restarts; actual work also retains its
 * own reservation until it settles, including manual generation outside a pipeline.
 */
export class HistoryProductionGate {
  private readonly owner = randomUUID()
  private readonly localKeys = new Set<string>()
  constructor(private readonly database: Database.Database, private readonly options: {
    pollMs?: number; isProcessAlive?: (pid: number) => boolean
  } = {}) {
    database.exec(`CREATE TABLE IF NOT EXISTS history_production_reservations (
      key TEXT PRIMARY KEY, source_id INTEGER NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL, owner TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS history_production_reservations_source ON history_production_reservations(source_id,state);`)
  }
  private clean() {
    const rows = this.database.prepare('SELECT * FROM history_production_reservations').all() as Reservation[]
    const hasExports = !!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_huasheng_export_jobs'").get()
    for (const row of rows) {
      let stale = false
      if (row.kind === 'pipeline' && hasExports) {
        const job = this.database.prepare('SELECT status FROM history_huasheng_export_jobs WHERE id=? AND source_id=?')
          .get(Number(row.key.slice('export:'.length)), row.source_id) as { status: string } | undefined
        stale = !job || !['queued', 'exporting', 'downloading', 'processing'].includes(job.status)
      } else if (row.kind === 'work') {
        if (row.owner === this.owner) stale = !this.localKeys.has(row.key)
        else if (row.host === hostname()) {
          if (this.options.isProcessAlive) stale = !this.options.isProcessAlive(row.pid)
          else try { process.kill(row.pid, 0) } catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        }
      }
      if (stale) this.database.prepare('DELETE FROM history_production_reservations WHERE key=?').run(row.key)
    }
  }
  isActive(sourceId: number) {
    return this.database.transaction(() => {
      this.clean()
      return !!this.database.prepare("SELECT 1 FROM history_production_reservations WHERE source_id=? AND state='active'").get(sourceId)
    }).immediate()
  }
  tryAcquire(sourceId: number, key: string, kind: Kind = 'work'): boolean {
    if (!Number.isSafeInteger(sourceId) || sourceId < 1 || !key) throw new Error('生产项目编号或执行标识无效')
    if (kind === 'work') this.localKeys.add(key)
    return this.database.transaction(() => {
      this.clean()
      const existing = this.database.prepare('SELECT * FROM history_production_reservations WHERE key=?').get(key) as Reservation | undefined
      if (existing && (existing.source_id !== sourceId || existing.kind !== kind)) throw new Error('生产名额与原任务不匹配')
      if (existing?.state === 'active') return true
      this.database.prepare(`INSERT OR IGNORE INTO history_production_reservations
        (key,source_id,kind,state,owner,host,pid,created_at) VALUES(?,?,?,'waiting',?,?,?,?)`)
        .run(key, sourceId, kind, this.owner, hostname(), process.pid, Date.now())
      const active = this.database.prepare("SELECT DISTINCT source_id FROM history_production_reservations WHERE state='active'").all() as { source_id: number }[]
      if (!active.some(row => row.source_id === sourceId) && active.length >= HISTORY_PRODUCTION_LIMIT) return false
      this.database.prepare("UPDATE history_production_reservations SET state='active' WHERE key=?").run(key)
      return true
    }).immediate()
  }
  release(key: string) {
    this.localKeys.delete(key)
    this.database.prepare('DELETE FROM history_production_reservations WHERE key=?').run(key)
  }
  async run<T>(sourceId: number, key: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      signal?.throwIfAborted()
      while (!this.tryAcquire(sourceId, key)) {
        await delay(this.options.pollMs ?? 1000, undefined, { signal })
      }
      signal?.throwIfAborted()
      return await action()
    } finally { this.release(key) }
  }
  overview() {
    return this.database.transaction(() => {
      this.clean()
      const rows = this.database.prepare(`SELECT source_id,MAX(state='active') AS active
        FROM history_production_reservations GROUP BY source_id`).all() as { source_id: number; active: number }[]
      return { limit: HISTORY_PRODUCTION_LIMIT, activeProjects: rows.filter(row => row.active).length,
        waitingProjects: rows.filter(row => !row.active).length }
    }).immediate()
  }
}

const gates = new WeakMap<Database.Database, HistoryProductionGate>()
export function getHistoryProductionGate(database: Database.Database) {
  let gate = gates.get(database)
  if (!gate) { gate = new HistoryProductionGate(database); gates.set(database, gate) }
  return gate
}
