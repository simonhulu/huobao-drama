import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {recordHistoryDualProduction} from './history-video-deliveries.js'
import type { HuashengDiscoveryInput, HuashengDiscoveryResult } from './history-huasheng-discovery.js'
import { getHistoryHuashengAccountsService, HISTORY_HUASHENG_ACCOUNT, type HuashengAccountsService } from './huasheng-accounts.js'

export type HuashengJobStatus = 'queued' | 'running' | 'waiting_login' | 'needs_attention' | 'submitted' | 'failed' | 'canceled'
export type HuashengProductionStatus = 'not_started' | 'queued' | 'creating' | 'completed'
export interface HuashengBrowserStatus { status: 'ready' | 'login_required' | 'unavailable'; message: string; checkedAt?: string | null }
export interface HuashengCheckpoint {
  checkpoint: string; projectUrl?: string; message: string; videoUrl?: string
  productionStatus?: 'queued' | 'creating'
}
export interface HuashengBrowserDriver {
  getHuashengBrowserSnapshot?(): HuashengBrowserStatus
  discoverHuashengProject?(input: HuashengDiscoveryInput): Promise<HuashengDiscoveryResult>
  inspectHuashengProject?(input: {
    projectUrl: string; checkpoint?: string | null; signal: AbortSignal; huashengAccountName?: string
  }): Promise<{ status: HuashengProductionStatus; message: string }>
  getHuashengBrowserStatus(): Promise<HuashengBrowserStatus>
  openHuashengBrowser(): Promise<HuashengBrowserStatus>
  runHuashengBrowserJob(input: {
    jobId: string | number; script: string; projectUrl: string | null; checkpoint: string | null; huashengAccountName?: string
    signal: AbortSignal; onCheckpoint: (update: HuashengCheckpoint) => Promise<void>
  }): Promise<{ projectUrl: string; videoUrl?: string }>
}
export interface HuashengJob {
  id: number; sourceId: number; title: string; status: HuashengJobStatus; stage: string
  message: string; projectUrl: string | null; videoUrl: string | null; error: string | null
  createdAt: string; updatedAt: string; scriptSha256: string; checkpoint: string | null
  cancelRequested: boolean; attempts: number; huashengAccountName: string
  productionStatus: HuashengProductionStatus; productionCheckedAt: string | null
  productionMessage: string; productionCheckError: string | null
}
export interface HuashengProduceResult {
  jobId: number; sourceId: number | null; status: 'queued' | 'skipped' | 'blocked'; message: string
}
interface StoredJob extends Omit<HuashengJob, 'cancelRequested'> { script: string; owner: string | null; cancelRequested: number }
interface Lease { owner: string | null; host: string | null; pid: number | null; expiresAt: number }
interface InspectionLease extends Lease { projectUrl: string | null }
export interface HuashengSourceSnapshot { id: number; title: string; script: string }
export interface HistoryHuashengOptions {
  databasePath: string
  loadSource: (id: number) => HuashengSourceSnapshot | Promise<HuashengSourceSnapshot>
  driver: HuashengBrowserDriver
  pollMs?: number
  heartbeatMs?: number
  leaseMs?: number
  productionTimeoutMs?: number
  monitorNow?: () => number
  onError?: (error: unknown) => void
}

export class HuashengQueueError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 = 409) { super(message); this.name = 'HuashengQueueError' }
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const timestamp = () => new Date().toISOString()
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000)
const jobColumns = `id, source_id AS sourceId, title, script, script_sha256 AS scriptSha256,
  status, stage, message, project_url AS projectUrl, video_url AS videoUrl, error, checkpoint,
  created_at AS createdAt, updated_at AS updatedAt, cancel_requested AS cancelRequested, attempts, owner,
  production_status AS productionStatus, production_checked_at AS productionCheckedAt,
  production_message AS productionMessage, production_check_error AS productionCheckError, huasheng_account_name AS huashengAccountName`

function publicJob(job: StoredJob): HuashengJob {
  const { script: _script, owner: _owner, ...result } = job
  return { ...result, cancelRequested: Boolean(job.cancelRequested) }
}

/** No worker, browser or source-library import is started by constructing the store. */
export class HistoryHuashengService {
  private readonly db: Database.Database
  private readonly owner = randomUUID()
  private timer?: ReturnType<typeof setInterval>
  private draining: Promise<void> | null = null
  private readonly selectedPending = new Set<number>()
  private selectedDrain: Promise<void> | null = null
  private selectedController?: AbortController
  private stopping = false
  private browserCache?: { value: HuashengBrowserStatus; at: number }
  private browserCheck?: Promise<HuashengBrowserStatus>
  private productionCheck: Promise<void> | null = null
  private productionController?: AbortController
  private readonly productionPending = new Map<string, StoredJob[]>()
  private readonly productionSeen = new Set<string>()
  private readonly productionManual = new Set<string>()
  private readonly productionUnboundPending = new Map<number, { job: StoredJob; manual: boolean }>()
  private readonly productionUnboundSeen = new Set<number>()
  private productionHadErrors = false
  private active?: { id: number; controller: AbortController; reason?: 'cancel' | 'shutdown' | 'lease_lost' | 'source_changed' }

  constructor(private readonly options: HistoryHuashengOptions) {
    if (options.databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(options.databasePath)), { recursive: true })
    this.db = new Database(options.databasePath, { timeout: 5000 })
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.transaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_huasheng_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1))
      );
      INSERT OR IGNORE INTO history_huasheng_settings(id, enabled) VALUES(1, 1);
      CREATE TABLE IF NOT EXISTS history_huasheng_monitor (
        id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        next_check_at INTEGER, last_checked_at TEXT, failures INTEGER NOT NULL DEFAULT 0,
        owner TEXT, host TEXT, pid INTEGER
      );
      INSERT OR IGNORE INTO history_huasheng_monitor(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS history_huasheng_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, title TEXT NOT NULL,
        script TEXT NOT NULL, script_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_login','needs_attention','submitted','failed','canceled')),
        stage TEXT NOT NULL, message TEXT NOT NULL, project_url TEXT, video_url TEXT, error TEXT, checkpoint TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, owner TEXT, manual_requested INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source_id, script_sha256)
      );
      CREATE INDEX IF NOT EXISTS history_huasheng_jobs_status ON history_huasheng_jobs(status, id);
      CREATE TABLE IF NOT EXISTS history_huasheng_lease (
        id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT, host TEXT, pid INTEGER, expires_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO history_huasheng_lease(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS history_huasheng_inspection_lease (
        id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT, host TEXT, pid INTEGER,
        expires_at INTEGER NOT NULL DEFAULT 0, project_url TEXT
      );
      INSERT OR IGNORE INTO history_huasheng_inspection_lease(id) VALUES(1);
    `)
    if (!(this.db.pragma('table_info(history_huasheng_jobs)') as Array<{ name: string }>).some(column => column.name === 'manual_requested')) {
      this.db.exec('ALTER TABLE history_huasheng_jobs ADD COLUMN manual_requested INTEGER NOT NULL DEFAULT 0')
    }
    const columns = new Set((this.db.pragma('table_info(history_huasheng_jobs)') as Array<{ name: string }>).map(column => column.name))
    for (const [name, definition] of Object.entries({
      production_status: "TEXT NOT NULL DEFAULT 'not_started' CHECK(production_status IN ('not_started','queued','creating','completed'))",
      production_checked_at: 'TEXT', production_message: "TEXT NOT NULL DEFAULT ''", production_check_error: 'TEXT',
      huasheng_account_name: `TEXT NOT NULL DEFAULT '${HISTORY_HUASHENG_ACCOUNT}'`,
    })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE history_huasheng_jobs ADD COLUMN ${name} ${definition}`)
    }
    this.reconcileVerifiedProduction()
    }).immediate()
  }

  /** A verified remote queue/editor/result proves creation handoff succeeded.
   * Repair old observations too, but never supersede a newer failure, active worker or cancellation.
   * This only settles local records; it neither resumes creation nor opens a browser. */
  private reconcileVerifiedProduction(projectUrl?: string) {
    this.db.prepare(`UPDATE history_huasheng_jobs SET status='submitted', stage='submitted', checkpoint='submitted',
      message=production_message, error=NULL, manual_requested=0
      WHERE production_status IN ('queued','creating','completed')
        AND production_checked_at IS NOT NULL AND production_checked_at >= updated_at
        AND production_check_error IS NULL AND project_url IS NOT NULL AND project_url <> ''
        AND status IN ('queued','waiting_login','needs_attention','failed','submitted')
        AND owner IS NULL AND cancel_requested=0
        AND (status <> 'submitted' OR stage <> 'submitted' OR checkpoint IS NOT 'submitted'
          OR error IS NOT NULL OR message <> production_message)
        ${projectUrl === undefined ? '' : 'AND project_url = ?'}`)
      .run(...(projectUrl === undefined ? [] : [projectUrl]))
  }

  get enabled(): boolean {
    return Boolean((this.db.prepare('SELECT enabled FROM history_huasheng_settings WHERE id = 1').get() as { enabled: number }).enabled)
  }

  setEnabled(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new HuashengQueueError('enabled 必须是布尔值', 400)
    this.db.prepare('UPDATE history_huasheng_settings SET enabled = ? WHERE id = 1').run(Number(enabled))
    // This switch controls automatic admission only. Accepted queue work and manual requests continue.
    this.wake()
    return { enabled }
  }

  get monitoring() {
    const row = this.db.prepare('SELECT enabled, next_check_at AS nextCheckAt, last_checked_at AS lastCheckedAt FROM history_huasheng_monitor WHERE id=1')
      .get() as { enabled: number; nextCheckAt: number | null; lastCheckedAt: string | null }
    return { enabled: Boolean(row.enabled), intervalMs: 60_000, lastCheckedAt: row.lastCheckedAt,
      nextCheckAt: row.enabled && row.nextCheckAt !== null ? new Date(row.nextCheckAt).toISOString() : null }
  }

  setMonitoring(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new HuashengQueueError('enabled 必须是布尔值', 400)
    this.db.prepare(`UPDATE history_huasheng_monitor SET enabled=?, next_check_at=?, failures=0 WHERE id=1 AND enabled<>?`)
      .run(Number(enabled), enabled ? (this.options.monitorNow ?? Date.now)() : null, Number(enabled))
    this.wake()
    return this.monitoring
  }

  /** Read-only recurring checks have their own durable schedule, independent of open UI tabs. */
  runMonitoring(): boolean {
    if (this.stopping || this.productionCheck) return false
    const now = (this.options.monitorNow ?? Date.now)()
    const claimed = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT enabled, next_check_at AS nextCheckAt, owner, host, pid, 0 AS expiresAt
        FROM history_huasheng_monitor WHERE id=1`).get() as Lease & { enabled: number; nextCheckAt: number | null }
      if (!row.enabled || (row.nextCheckAt !== null && row.nextCheckAt > now) || this.leaseAlive(row)) return false
      this.db.prepare('UPDATE history_huasheng_monitor SET owner=?, host=?, pid=? WHERE id=1')
        .run(this.owner, hostname(), process.pid)
      return true
    }).immediate()
    if (!claimed) return false
    this.checkProduction(undefined, { automatic: true })
    void this.productionCheck!.then(() => {
      const finishedAt = (this.options.monitorNow ?? Date.now)()
      this.db.transaction(() => {
        const row = this.db.prepare('SELECT failures FROM history_huasheng_monitor WHERE id=1 AND owner=?')
          .get(this.owner) as { failures: number } | undefined
        if (!row) return
        const failures = this.productionHadErrors ? Math.min(4, row.failures + 1) : 0
        this.db.prepare(`UPDATE history_huasheng_monitor SET last_checked_at=?,
          next_check_at=CASE WHEN enabled=1 THEN ? ELSE NULL END, failures=?, owner=NULL, host=NULL, pid=NULL WHERE id=1 AND owner=?`)
          .run(new Date(finishedAt).toISOString(), finishedAt + Math.min(600_000, 60_000 * 2 ** failures), failures, this.owner)
      }).immediate()
    }).catch(error => this.options.onError?.(error))
    return true
  }

  private visibleSourceFilter(): string {
    const activeRecord = "NOT (status='canceled' AND stage='record_cleanup')"
    // Standalone stores may use an injected source loader without a local library table.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_script_sources'").get()) return activeRecord
    return `${activeRecord} AND NOT EXISTS (SELECT 1 FROM history_script_sources source
      WHERE source.id=history_huasheng_jobs.source_id AND source.deleted_at IS NOT NULL)`
  }

  listJobs(sourceId?: number, options: { limit?: number; beforeId?: number } = {}): HuashengJob[] {
    const filters: string[] = [this.visibleSourceFilter()]
    const values: number[] = []
    if (sourceId !== undefined) { filters.push('source_id = ?'); values.push(sourceId) }
    if (options.beforeId !== undefined) { filters.push('id < ?'); values.push(options.beforeId) }
    const limit = Math.min(100, Math.max(1, options.limit ?? 50))
    return (this.db.prepare(`SELECT ${jobColumns} FROM history_huasheng_jobs
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...values, limit) as StoredJob[]).map(publicJob)
  }

  getJob(id: number): HuashengJob {
    const job = this.storedJob(id)
    if (!job) throw new HuashengQueueError('花生任务不存在', 404)
    return publicJob(job)
  }

  private storedJob(id: number): StoredJob | undefined {
    return this.db.prepare(`SELECT ${jobColumns} FROM history_huasheng_jobs WHERE id = ?`).get(id) as StoredJob | undefined
  }

  async enqueue(sourceId: number, options: { automatic?: boolean; dual?: boolean } = {}): Promise<HuashengJob | null> {
    if (options.automatic && !this.enabled) return null
    const source = await this.currentSource(sourceId)
    const result = this.db.transaction(() => {
      if (options.automatic && !this.enabled) return null
      const job=this.insertSnapshot(source, !options.automatic)
      if(options.dual)recordHistoryDualProduction(this.db,source.id,job.scriptSha256,job.id)
      return job
    }).immediate()
    this.wake()
    return result
  }

  private insertSnapshot(source: HuashengSourceSnapshot, manual: boolean) {
    const hash = sha256(source.script)
    const ts = timestamp()
    this.db.prepare(`INSERT OR IGNORE INTO history_huasheng_jobs
      (source_id, title, script, script_sha256, status, stage, message, created_at, updated_at, manual_requested)
      VALUES(?, ?, ?, ?, 'queued', 'queued', '等待提交花生制作', ?, ?, ?)`).run(source.id, source.title, source.script, hash, ts, ts, Number(manual))
    return publicJob(this.db.prepare(`SELECT ${jobColumns} FROM history_huasheng_jobs WHERE source_id = ? AND script_sha256 = ?`).get(source.id, hash) as StoredJob)
  }

  /** The marker is written atomically with the successful source draft (a small transactional outbox).
   * It represents already accepted automatic work, so disabling new admission cannot discard it.
   * This method never schedules a source without the explicit marker. */
  async enqueueMarkedSource(sourceId: number): Promise<HuashengJob | null> {
    const pending = this.db.prepare(`SELECT review_json AS reviewJson FROM history_script_sources WHERE id = ? AND deleted_at IS NULL`).get(sourceId) as { reviewJson: string } | undefined
    if (!pending) return null
    let marker: { status?: string; scriptSha256?: string; checkEnabled?: boolean; productionMode?: string }
    try { marker = JSON.parse(pending.reviewJson)?.huashengQueue ?? {} } catch { return null }
    if (marker.status !== 'pending' || !marker.scriptSha256) return null
    let source: HuashengSourceSnapshot
    try { source = await this.currentSource(sourceId) }
    catch (error) {
      if (error instanceof HuashengQueueError && [404, 409].includes(error.statusCode)) {
        this.db.prepare(`UPDATE history_script_sources SET review_json = json_set(review_json,
          '$.huashengQueue.status', 'needs_attention', '$.huashengQueue.error', ?)
          WHERE id = ? AND json_extract(review_json, '$.huashengQueue.status') = 'pending'
          AND json_extract(review_json, '$.huashengQueue.scriptSha256') = ?`).run(error.message, sourceId, marker.scriptSha256)
        return null
      }
      throw error
    }
    const job = this.db.transaction(() => {
      const current = this.db.prepare(`SELECT review_json AS reviewJson, rewritten_script AS script FROM history_script_sources WHERE id = ? AND deleted_at IS NULL`).get(sourceId) as { reviewJson: string; script: string } | undefined
      if (!current) return null
      const currentMarker = JSON.parse(current.reviewJson)?.huashengQueue
      if (currentMarker?.status !== 'pending' || currentMarker.scriptSha256 !== marker.scriptSha256) return null
      // Editing a source never authorizes the old pending marker to schedule a different draft.
      const matches = sha256(current.script ?? '') === marker.scriptSha256 && sha256(source.script) === marker.scriptSha256
      // Failed settings reads never imply enabled. Resolve that uncertainty in this transaction.
      const admitted = !currentMarker.checkEnabled || this.enabled
      const result = matches && admitted ? this.insertSnapshot(source, false) : null
      if (result && currentMarker.productionMode === 'dual') recordHistoryDualProduction(this.db,sourceId,marker.scriptSha256!,result.id)
      // Job insertion and marker acknowledgement commit together on the same SQLite connection.
      this.db.prepare(`UPDATE history_script_sources SET review_json = json_remove(review_json, '$.huashengQueue') WHERE id = ?`).run(sourceId)
      return result
    }).immediate()
    this.wake()
    return job
  }

  private async recoverMarkedSources() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'history_script_sources'").get()) return
    const rows = this.db.prepare(`SELECT id FROM history_script_sources
      WHERE deleted_at IS NULL AND json_valid(review_json)
      AND json_extract(review_json, '$.huashengQueue.status') = 'pending' ORDER BY id LIMIT 100`).all() as Array<{ id: number }>
    for (const row of rows) {
      if (this.stopping) break
      try { await this.enqueueMarkedSource(row.id) }
      catch (error) { this.options.onError?.(error) }
    }
  }

  async resume(id: number, options: { projectUrl?: string } = {}): Promise<HuashengJob> {
    const job = this.getJob(id)
    let projectUrl: string | null = null
    const requireUnboundCreate = (current: HuashengJob) => {
      if (['running', 'submitted'].includes(current.status)
        || (current.checkpoint !== 'create_pending' && current.stage !== 'create_pending') || current.projectUrl) {
        throw new HuashengQueueError('仅创建结果待核验且尚无项目链接的任务允许绑定；已有项目不能改绑')
      }
    }
    if (options.projectUrl !== undefined) {
      const { huashengProjectUrl } = await import('./history-huasheng-browser.js')
      projectUrl = typeof options.projectUrl === 'string' ? huashengProjectUrl(options.projectUrl) : null
      if (!projectUrl) throw new HuashengQueueError('请输入有效的花生项目链接（https://www.huasheng.cn/video/项目编号）', 400)
      requireUnboundCreate(job)
    }
    if (job.status === 'submitted') return job
    if (job.status === 'running') throw new HuashengQueueError('任务仍在运行或停止中，请等待浏览器操作退出')
    await this.validateSnapshot(job)
    this.db.transaction(() => {
      const current = this.getJob(id)
      if (projectUrl) requireUnboundCreate(current)
      if (current.status === 'running') throw new HuashengQueueError('任务已开始运行')
      if (current.status === 'submitted') return
      this.db.prepare(`UPDATE history_huasheng_jobs SET status = 'queued',
        checkpoint = CASE WHEN checkpoint IS NULL AND stage='create_pending' THEN 'create_pending' ELSE checkpoint END, stage = 'queued',
        message = '已恢复排队，将从保存的检查点核验并继续', error = NULL, cancel_requested = 0,
        project_url = COALESCE(?, project_url), manual_requested = 1, updated_at = ? WHERE id = ?`).run(projectUrl, timestamp(), id)
    }).immediate()
    this.wake()
    return this.getJob(id)
  }

  get producing(): boolean { return this.selectedDrain !== null }

  /** Admission results, not final outcomes. Selection lives until shutdown; a restart requires re-selection.
   * Do not wake the global worker or recover source outbox markers. */
  async produce(jobIds: number[], options: {dual?: boolean} = {}): Promise<{ results: HuashengProduceResult[]; running: boolean }> {
    if (!Array.isArray(jobIds) || !jobIds.length || jobIds.length > 100
      || jobIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
      throw new HuashengQueueError('请明确选择 1 至 100 个有效的花生任务编号', 400)
    }
    if (this.stopping) throw new HuashengQueueError('花生服务正在停止，请稍后重试')
    const skipMessage = (job: HuashengJob): string | null => {
      if (job.status === 'running') return '任务正在执行或停止中，本次不重复启动'
      if (job.status === 'submitted' || job.productionStatus !== 'not_started'
        || (job.checkpoint === 'submitted' && job.projectUrl)) return '花生已接受制作、排队或完成，本次跳过'
      if (job.status === 'queued' && this.selectedPending.has(job.id)) return '任务已在所选生产队列中，本次不重复启动'
      return null
    }
    const requireBoundProject = (job: HuashengJob) => {
      if ((job.checkpoint === 'create_pending' || job.stage === 'create_pending') && !job.projectUrl) {
        throw new HuashengQueueError('创建结果尚未确认，请先核对并绑定原花生项目链接再恢复，避免重复创建')
      }
    }
    const results: HuashengProduceResult[] = []
    for (const id of new Set(jobIds)) {
      let job: HuashengJob | undefined
      try {
        job = this.getJob(id)
        if(options.dual) {
          await this.validateSnapshot(job)
          recordHistoryDualProduction(this.db,job.sourceId,job.scriptSha256,job.id)
        }
        const skipped = skipMessage(job)
        if (skipped) {
          results.push({ jobId: id, sourceId: job.sourceId, status: 'skipped', message: skipped })
          continue
        }
        requireBoundProject(job)
        const observed = job
        await this.validateSnapshot(job)
        const result = this.db.transaction((): HuashengProduceResult => {
          if (this.stopping) throw new HuashengQueueError('花生服务正在停止，请稍后重试')
          const current = this.getJob(id)
          const skipped = skipMessage(current)
          if (skipped) return { jobId: id, sourceId: current.sourceId, status: 'skipped', message: skipped }
          // Source validation awaits external code; do not overwrite a newer cancel or resume.
          if (current.status !== observed.status || current.cancelRequested !== observed.cancelRequested || current.updatedAt !== observed.updatedAt) {
            throw new HuashengQueueError(current.cancelRequested || current.status === 'canceled'
              ? '文稿校验期间任务已取消，本次未恢复；如需继续，请重新勾选启动'
              : '文稿校验期间任务状态已变化，本次未覆盖；请刷新后重新选择')
          }
          requireBoundProject(current)
          const message = current.checkpoint === 'quota_waiting'
            ? '已按标准模式恢复原项目，额度仍不足时保留等待，不切换快速模式'
            : current.status === 'queued' ? '已加入所选生产队列' : '已恢复，将从原项目和保存的检查点继续'
          this.db.prepare(`UPDATE history_huasheng_jobs SET status='queued', stage='queued', message=?,
            error=NULL, cancel_requested=0, manual_requested=1, updated_at=? WHERE id=?`).run(message, timestamp(), id)
          return { jobId: id, sourceId: current.sourceId, status: 'queued', message }
        }).immediate()
        if (result.status === 'queued') this.selectedPending.add(id)
        results.push(result)
      } catch (error) {
        results.push({ jobId: id, sourceId: job?.sourceId ?? null, status: 'blocked', message: errorMessage(error) })
      }
    }
    this.runSelected()
    return { results, running: this.producing || this.draining !== null }
  }

  private runSelected() {
    if (this.stopping || this.selectedDrain || !this.selectedPending.size) return
    const controller = new AbortController()
    this.selectedController = controller
    this.selectedDrain = Promise.resolve().then(async () => {
      while (!this.stopping && this.selectedPending.size) {
        for (const id of this.selectedPending) {
          if (this.storedJob(id)?.status !== 'queued') this.selectedPending.delete(id)
        }
        if (!this.selectedPending.size) return
        await this.runPending([...this.selectedPending])
        if (this.selectedPending.size && !this.stopping) {
          // Another process or an inspection may hold the existing lease. Wait only for this finite selection.
          await delay(this.options.pollMs ?? 1000, undefined, { signal: controller.signal })
        }
      }
    }).catch(error => {
      this.selectedPending.clear()
      if (!controller.signal.aborted) this.options.onError?.(error)
    }).finally(() => {
      this.selectedDrain = null
      this.selectedController = undefined
      if (!this.stopping && this.selectedPending.size) this.runSelected()
    })
  }

  cancel(id: number): HuashengJob {
    const job = this.db.transaction(() => {
      const current = this.getJob(id)
      if (current.status === 'submitted' || current.status === 'canceled') return current
      const running = current.status === 'running'
      this.db.prepare(`UPDATE history_huasheng_jobs SET status = ?, stage = ?, message = ?,
        cancel_requested = 1, updated_at = ? WHERE id = ?`).run(running ? 'running' : 'canceled',
        running ? 'canceling' : 'canceled', running ? '正在停止浏览器操作，退出后释放执行权' : '任务已取消，文稿和检查点已保留', timestamp(), id)
      return this.getJob(id)
    }).immediate()
    this.selectedPending.delete(id)
    if (this.active?.id === id && job.status === 'running') this.abortActive('cancel')
    return job
  }

  async browserStatus(refresh = false): Promise<HuashengBrowserStatus> {
    if (!refresh && this.browserCache && Date.now() - this.browserCache.at < 10_000) return this.browserCache.value
    this.browserCheck ??= (async () => {
      let value: HuashengBrowserStatus
      try { value = await this.options.driver.getHuashengBrowserStatus() }
      catch (error) { value = { status: 'unavailable', message: errorMessage(error) } }
      this.browserCache = { value, at: Date.now() }
      return value
    })().finally(() => { this.browserCheck = undefined })
    const result = await this.browserCheck
    if (refresh && result.status === 'ready') {
      const waiting = this.db.prepare("SELECT id FROM history_huasheng_jobs WHERE status = 'waiting_login'").all() as Array<{ id: number }>
      for (const row of waiting) {
        try { await this.resume(row.id) }
        catch (error) {
          // A stale or deleted draft cannot be silently sent after a later successful login.
          this.db.prepare(`UPDATE history_huasheng_jobs SET status = 'needs_attention', stage = 'needs_attention',
            message = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'waiting_login'`)
            .run(errorMessage(error), errorMessage(error), timestamp(), row.id)
        }
      }
      this.wake()
    }
    return result
  }

  async openBrowser(): Promise<HuashengBrowserStatus> {
    try {
      const value = await this.options.driver.openHuashengBrowser()
      this.browserCache = { value, at: Date.now() }
      return value
    }
    catch (error) { return { status: 'unavailable', message: errorMessage(error) } }
  }

  async overview(options: { limit?: number; beforeId?: number } = {}) {
    // Inventory reads must not wait for CDP or the official identity API.
    let browser: HuashengBrowserStatus = this.browserCache?.value
      ?? { status: 'unavailable', message: '尚未检查花生账号，请检查专用账号的登录与身份' }
    try { browser = this.options.driver.getHuashengBrowserSnapshot?.() ?? browser }
    catch (error) { browser = { status: 'unavailable', message: errorMessage(error) } }
    const jobs = this.listJobs(undefined, options)
    const counts = Object.fromEntries((this.db.prepare(`SELECT status, COUNT(*) AS count FROM history_huasheng_jobs
      WHERE ${this.visibleSourceFilter()} GROUP BY status`).all() as Array<{ status: string; count: number }>).map(row => [row.status, row.count]))
    const productionCounts: Record<HuashengProductionStatus, number> = { not_started: 0, queued: 0, creating: 0, completed: 0 }
    for (const row of this.db.prepare(`SELECT production_status AS status, COUNT(*) AS count FROM history_huasheng_jobs
      WHERE ${this.visibleSourceFilter()} GROUP BY production_status`).all() as Array<{ status: HuashengProductionStatus; count: number }>) {
      productionCounts[row.status] = row.count
    }
    return { enabled: this.enabled, monitoring: this.monitoring, browser, jobs, counts, productionCounts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0), productionChecking: this.productionChecking,
      nextBeforeId: jobs.length === (options.limit ?? 50) ? jobs.at(-1)!.id : null }
  }

  get productionChecking(): boolean { return this.productionCheck !== null }

  /** Explicit read-only batch. An optional selection scopes exact job IDs;
   * otherwise snapshot linked and unresolved-create jobs, independently of UI pagination.
   * Requests during a batch merge by URL; no source is enqueued or resumed here. */
  checkProduction(sourceId?: number, options: { automatic?: boolean; jobIds?: number[] } = {}): { checking: boolean } {
    if (this.stopping) throw new HuashengQueueError('花生服务正在停止，请稍后重试')
    if (sourceId !== undefined && (!Number.isSafeInteger(sourceId) || sourceId < 1)) throw new HuashengQueueError('历史文稿编号无效', 400)
    if (options.jobIds !== undefined) {
      if (!Array.isArray(options.jobIds) || !options.jobIds.length || options.jobIds.length > 100) throw new HuashengQueueError('请至少选择一个项目，每次最多检查 100 项', 400)
      if (options.jobIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new HuashengQueueError('花生任务编号无效', 400)
    }
    const selectedIds = options.jobIds === undefined ? undefined : [...new Set(options.jobIds)]
    const jobs = this.db.prepare(`SELECT ${jobColumns} FROM history_huasheng_jobs
      WHERE ${this.visibleSourceFilter()} AND ((project_url IS NOT NULL AND project_url <> '')
        OR ((project_url IS NULL OR project_url = '') AND (checkpoint='create_pending' OR stage='create_pending')
          AND status IN ('needs_attention','failed','waiting_login','canceled'))) ${sourceId === undefined ? '' : 'AND source_id = ?'}
      ${selectedIds ? `AND id IN (${selectedIds.map(() => '?').join(',')})` : ''}
      ${options.automatic ? "AND production_status <> 'completed' AND status <> 'canceled'" : ''}
      ORDER BY id DESC`).all(...(sourceId === undefined ? [] : [sourceId]), ...(selectedIds ?? [])) as StoredJob[]
    if (selectedIds && !jobs.length) return { checking: this.productionChecking }
    for (const job of jobs) {
      if (!job.projectUrl) {
        if (!this.productionUnboundSeen.has(job.id)) this.productionUnboundPending.set(job.id, { job, manual: !options.automatic })
        continue
      }
      if (this.productionSeen.has(job.projectUrl!)) continue
      if (!options.automatic) this.productionManual.add(job.projectUrl!)
      const pending = this.productionPending.get(job.projectUrl!) ?? []
      if (!pending.some(existing => existing.id === job.id)) pending.push(job)
      this.productionPending.set(job.projectUrl!, pending)
    }
    if (!this.productionCheck) {
      this.productionHadErrors = false
      const controller = new AbortController()
      this.productionController = controller
      this.productionCheck = Promise.resolve().then(() => this.inspectPendingProjects(controller.signal))
        .catch(error => this.options.onError?.(error))
        .finally(() => {
          this.productionPending.clear()
          this.productionSeen.clear()
          this.productionManual.clear()
          this.productionUnboundPending.clear()
          this.productionUnboundSeen.clear()
          this.productionController = undefined
          this.productionCheck = null
        })
    }
    return { checking: true }
  }

  async syncProduction(sourceId: number, options: { jobIds?: number[] } = {}): Promise<{ jobs: HuashengJob[] }> {
    this.checkProduction(sourceId, options)
    await this.productionCheck
    return { jobs: this.listJobs(sourceId) }
  }

  private inspectionLease(): InspectionLease {
    return this.db.prepare(`SELECT owner, host, pid, expires_at AS expiresAt, project_url AS projectUrl
      FROM history_huasheng_inspection_lease WHERE id = 1`).get() as InspectionLease
  }

  private leaseAlive(lease: Lease): boolean {
    if (!lease.owner) return false
    // Like the submission lease, a timeout cannot prove a browser page has closed.
    if (lease.host !== hostname() || !lease.pid) return true
    try { process.kill(lease.pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }

  private productionError(projectUrl: string, error: unknown) {
    this.productionHadErrors = true
    this.db.prepare(`UPDATE history_huasheng_jobs SET production_check_error = ?, updated_at = ? WHERE project_url = ?`)
      .run(errorMessage(error), timestamp(), projectUrl)
  }

  private async discoverPendingProjects(signal: AbortSignal) {
    for (const [id, { job, manual }] of this.productionUnboundPending) {
      signal.throwIfAborted()
      this.productionUnboundPending.delete(id)
      this.productionUnboundSeen.add(id)
      const acquired = this.db.transaction(() => {
        const current = this.storedJob(id)
        if (!current || current.projectUrl || current.owner || current.status === 'running') return false
        if (this.leaseAlive(this.inspectionLease())) return false
        this.db.prepare(`UPDATE history_huasheng_inspection_lease SET owner=?,host=?,pid=?,project_url=? WHERE id=1`)
          .run(this.owner, hostname(), process.pid, `discovery:${id}`)
        return true
      }).immediate()
      if (!acquired) {
        this.productionHadErrors = true
        this.db.prepare('UPDATE history_huasheng_jobs SET production_check_error=? WHERE id=? AND project_url IS NULL')
          .run('其他项目状态检查进行中，请稍后重新同步', id)
        continue
      }
      const controller = new AbortController()
      const abort = () => controller.abort(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const timeout = setTimeout(() => controller.abort(new Error('花生项目查找超时，请稍后重新同步')),
        this.options.productionTimeoutMs ?? (manual ? 90_000 : 45_000))
      try {
        if (!manual && sha256((await this.currentSource(job.sourceId)).script) !== job.scriptSha256) continue
        const discover = this.options.driver.discoverHuashengProject
        if (!discover) throw new Error('当前花生驱动暂不支持找回项目，请核对并绑定原项目')
        const result = await discover.call(this.options.driver, {
          jobId: id, title: job.title, script: job.script, createdAt: job.createdAt, updatedAt: job.updatedAt, signal: controller.signal,
          huashengAccountName: job.huashengAccountName,
        })
        controller.signal.throwIfAborted()
        if (!result.projectUrl) throw new Error(result.message)
        const { huashengProjectUrl } = await import('./history-huasheng-browser.js')
        const projectUrl = huashengProjectUrl(result.projectUrl)
        if (!projectUrl) throw new Error('花生项目查找返回无效链接，尚未关联')
        const linked = this.db.transaction(() => {
          const current = this.storedJob(id)
          if (!current || current.projectUrl || current.owner || current.status === 'running'
            || current.scriptSha256 !== job.scriptSha256 || ![current.checkpoint, current.stage].includes('create_pending')) return undefined
          this.db.prepare(`UPDATE history_huasheng_jobs SET project_url=?,production_check_error=NULL,
            production_message=?,updated_at=? WHERE id=?`).run(projectUrl, result.message, timestamp(), id)
          return this.storedJob(id)
        }).immediate()
        if (linked) {
          if (manual) this.productionManual.add(projectUrl)
          const pending = this.productionPending.get(projectUrl) ?? []
          if (!pending.some(item => item.id === id)) pending.push(linked)
          this.productionPending.set(projectUrl, pending)
        }
      } catch (error) {
        this.productionHadErrors = true
        this.db.prepare('UPDATE history_huasheng_jobs SET production_check_error=?,updated_at=? WHERE id=? AND project_url IS NULL')
          .run(errorMessage(controller.signal.aborted ? controller.signal.reason : error), timestamp(), id)
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        this.db.prepare(`UPDATE history_huasheng_inspection_lease SET owner=NULL,host=NULL,pid=NULL,project_url=NULL WHERE id=1 AND owner=?`).run(this.owner)
      }
    }
  }

  private async inspectPendingProjects(signal: AbortSignal) {
    let browserRecoveryAttempted = false
    while ((this.productionPending.size || this.productionUnboundPending.size) && !signal.aborted) {
      await this.discoverPendingProjects(signal)
      // Prioritize current saved versions; failed/deleted sources still have inspectable historical projects.
      const hashes = new Map<number, string | null>()
      const candidates = [...this.productionPending]
      for (const [, jobs] of candidates) for (const job of jobs) {
        if (signal.aborted) return
        if (hashes.has(job.sourceId)) continue
        try { hashes.set(job.sourceId, sha256((await this.options.loadSource(job.sourceId)).script)) }
        catch { hashes.set(job.sourceId, null) }
      }
      candidates.sort((a, b) => Number(b[1].some(job => hashes.get(job.sourceId) === job.scriptSha256))
        - Number(a[1].some(job => hashes.get(job.sourceId) === job.scriptSha256)))
      for (const [projectUrl, jobs] of candidates) {
        if (signal.aborted) return
        this.productionPending.delete(projectUrl)
        this.productionSeen.add(projectUrl)
        if (!this.productionManual.has(projectUrl) && !jobs.some(job => hashes.get(job.sourceId) === job.scriptSha256)) continue
        const acquired = this.db.transaction(() => {
          if (this.db.prepare("SELECT 1 FROM history_huasheng_jobs WHERE project_url = ? AND status = 'running' LIMIT 1").get(projectUrl)) {
            this.productionError(projectUrl, '自动化推进中，稍后再检查')
            return false
          }
          if (this.leaseAlive(this.inspectionLease())) {
            this.productionError(projectUrl, '其他项目状态检查进行中，稍后再检查')
            return false
          }
          this.db.prepare(`UPDATE history_huasheng_inspection_lease SET owner = ?, host = ?, pid = ?, project_url = ? WHERE id = 1`)
            .run(this.owner, hostname(), process.pid, projectUrl)
          return true
        }).immediate()
        if (!acquired) continue
        const controller = new AbortController()
        const abort = () => controller.abort(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        const manual = this.productionManual.has(projectUrl)
        const timeout = setTimeout(() => controller.abort(new Error('花生项目状态检查超时，请稍后重试')),
          this.options.productionTimeoutMs ?? (manual ? 90_000 : 45_000))
        try {
          controller.signal.throwIfAborted()
          const inspect = this.options.driver.inspectHuashengProject
          if (!inspect) throw new Error('当前浏览器驱动暂不支持制作状态检查')
          const stages = ['opening', 'create_pending', 'created', 'scheme_pending', 'requirements_pending', 'plan_opened', 'confirm_pending', 'submitted']
          const checkpoints = this.db.prepare('SELECT checkpoint FROM history_huasheng_jobs WHERE project_url = ?')
            .all(projectUrl) as Array<{ checkpoint: string | null }>
          const checkpoint = checkpoints.sort((a, b) => stages.indexOf(b.checkpoint ?? '') - stages.indexOf(a.checkpoint ?? ''))[0]?.checkpoint ?? null
          // The observer must close its own page on abort before settling. Retain the lease until then.
          const input = { projectUrl, checkpoint, signal: controller.signal, huashengAccountName: jobs[0]?.huashengAccountName }
          let result: Awaited<ReturnType<NonNullable<HuashengBrowserDriver['inspectHuashengProject']>>>
          try { result = await inspect.call(this.options.driver, input) }
          catch (error) {
            // A manual check authorizes one connection recovery, not a creation retry.
            // Recurring checks never reopen a browser the user has closed.
            if (!manual || browserRecoveryAttempted || (error as { code?: string } | null)?.code !== 'browser_unavailable') throw error
            controller.signal.throwIfAborted()
            browserRecoveryAttempted = true
            const connection = await this.openBrowser()
            controller.signal.throwIfAborted()
            if (connection.status !== 'ready') throw new Error(connection.message)
            result = await inspect.call(this.options.driver, input)
          }
          controller.signal.throwIfAborted()
          if (!['not_started', 'queued', 'creating', 'completed'].includes(result.status) || typeof result.message !== 'string') {
            throw new Error('花生返回了无效的制作状态')
          }
          const ts = timestamp()
          this.db.transaction(() => {
            this.db.prepare(`UPDATE history_huasheng_jobs SET production_status = ?, production_checked_at = ?,
              production_message = ?, production_check_error = NULL, updated_at = ? WHERE project_url = ?`)
              .run(result.status, ts, result.message, ts, projectUrl)
            this.reconcileVerifiedProduction(projectUrl)
          }).immediate()
        } catch (error) { this.productionError(projectUrl, controller.signal.aborted ? controller.signal.reason : error) }
        finally {
          clearTimeout(timeout)
          signal.removeEventListener('abort', abort)
          this.db.prepare(`UPDATE history_huasheng_inspection_lease SET owner = NULL, host = NULL, pid = NULL,
            project_url = NULL WHERE id = 1 AND owner = ?`).run(this.owner)
          this.wake()
        }
      }
    }
  }

  start() {
    if (this.timer) return
    this.stopping = false
    this.timer = setInterval(() => this.wake(), this.options.pollMs ?? 1000)
    this.timer.unref()
    this.wake()
  }

  private wake() {
    if (!this.timer || this.stopping) return
    void this.runPending().catch(error => this.options.onError?.(error))
    try { this.runMonitoring() } catch (error) { this.options.onError?.(error) }
  }

  /** Explicit worker entry point, also used by isolated tests. Never scans old sources. */
  runPending(jobIds?: number[]): Promise<void> {
    if (this.draining) return this.draining
    if (this.stopping) return Promise.resolve()
    if (jobIds !== undefined && !jobIds.length) return Promise.resolve()
    this.draining = this.drain(jobIds).finally(() => { this.draining = null })
    return this.draining
  }

  private claim(jobIds?: number[]): StoredJob | null {
    const scope = jobIds === undefined ? '' : `AND id IN (${jobIds.map(() => '?').join(',')})`
    return this.db.transaction(() => {
      const lease = this.db.prepare('SELECT owner, host, pid, expires_at AS expiresAt FROM history_huasheng_lease WHERE id = 1').get() as Lease
      if (lease.owner && lease.owner !== this.owner) {
        // Expiry alone cannot prove a browser driver stopped. A live local PID (even with
        // an expired lease), or a foreign host, is never preempted. This DB is host-local.
        if (lease.host !== hostname() || !lease.pid) return null
        try { process.kill(lease.pid, 0); return null } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return null
        }
      }
      this.db.prepare(`UPDATE history_huasheng_jobs SET status = CASE
          WHEN checkpoint = 'submitted' AND project_url IS NOT NULL THEN 'submitted'
          WHEN cancel_requested = 1 THEN 'canceled' ELSE 'queued' END,
        stage = CASE WHEN checkpoint = 'submitted' AND project_url IS NOT NULL THEN 'submitted'
          WHEN cancel_requested = 1 THEN 'canceled' ELSE 'recovering' END,
        message = CASE WHEN checkpoint = 'submitted' AND project_url IS NOT NULL THEN message
          ELSE '上次执行进程已退出，保留检查点等待核验' END,
        owner = NULL, updated_at = ? WHERE status = 'running' ${scope}`).run(timestamp(), ...(jobIds ?? []))
      this.db.prepare('UPDATE history_huasheng_lease SET owner = NULL, host = NULL, pid = NULL, expires_at = 0 WHERE id = 1').run()
      // A missing login is account-wide. Avoid opening every queued script at the login page.
      // Explicit manual submissions/resumes may retry login even while automatic jobs are waiting.
      const waitingLogin = Boolean(this.db.prepare("SELECT id FROM history_huasheng_jobs WHERE status = 'waiting_login' LIMIT 1").get())
      const inspection = this.inspectionLease()
      const inspectedUrl = this.leaseAlive(inspection) ? inspection.projectUrl : null
      const job = this.db.prepare(`SELECT ${jobColumns} FROM history_huasheng_jobs WHERE status = 'queued'
        AND (? IS NULL OR project_url IS NULL OR project_url <> ?)
        ${waitingLogin ? 'AND manual_requested = 1' : ''} ${scope} ORDER BY id LIMIT 1`).get(inspectedUrl, inspectedUrl, ...(jobIds ?? [])) as StoredJob | undefined
      if (!job) return null
      this.db.prepare(`UPDATE history_huasheng_lease SET owner = ?, host = ?, pid = ?, expires_at = ? WHERE id = 1`)
        .run(this.owner, hostname(), process.pid, Date.now() + (this.options.leaseMs ?? 15_000))
      this.db.prepare(`UPDATE history_huasheng_jobs SET status = 'running', stage = 'starting', owner = ?,
        attempts = attempts + 1, error = NULL, message = '正在核验文稿并连接花生', updated_at = ? WHERE id = ?`).run(this.owner, timestamp(), job.id)
      return this.storedJob(job.id)!
    }).immediate()
  }

  private abortActive(reason: NonNullable<HistoryHuashengService['active']>['reason']) {
    if (!this.active || this.active.controller.signal.aborted) return
    this.active.reason = reason
    this.active.controller.abort(new Error(reason === 'cancel' ? '花生任务已请求取消' : '花生执行已停止'))
  }

  private guard(id: number, observation = false) {
    const lease = this.db.prepare('SELECT owner FROM history_huasheng_lease WHERE id = 1').get() as Lease
    const job = this.storedJob(id)
    if (lease.owner !== this.owner || job?.owner !== this.owner || job.status !== 'running' || this.active?.id !== id) {
      this.abortActive('lease_lost')
      throw new Error('花生任务执行权已失效')
    }
    if (job.cancelRequested) this.abortActive('cancel')
    if (!observation) this.active.controller.signal.throwIfAborted()
  }

  private async currentSource(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new HuashengQueueError('历史文稿编号无效', 400)
    const source = await this.options.loadSource(id)
    if (source.id !== id || !source.script.trim()) throw new HuashengQueueError('当前二创稿不可用')
    return source
  }

  private async validateSnapshot(job: HuashengJob) {
    const source = await this.currentSource(job.sourceId)
    if (sha256(source.script) !== job.scriptSha256) throw new HuashengQueueError('文稿已变更，请为当前稿创建新任务；原任务快照和检查点保留')
  }

  private async drain(jobIds?: number[]) {
    if (jobIds === undefined) await this.recoverMarkedSources()
    while (!this.stopping) {
      const job = this.claim(jobIds)
      if (!job) return
      this.selectedPending.delete(job.id)
      const active = { id: job.id, controller: new AbortController(), reason: undefined as NonNullable<HistoryHuashengService['active']>['reason'] }
      this.active = active
      const heartbeat = setInterval(() => {
        try {
          this.guard(job.id)
          this.db.prepare('UPDATE history_huasheng_lease SET expires_at = ? WHERE id = 1 AND owner = ?')
            .run(Date.now() + (this.options.leaseMs ?? 15_000), this.owner)
        } catch { this.abortActive('lease_lost') }
      }, this.options.heartbeatMs ?? 250)
      try {
        await this.validateSnapshot(publicJob(job))
        this.guard(job.id)
        const result = await this.options.driver.runHuashengBrowserJob({
          jobId: job.id, script: job.script, projectUrl: job.projectUrl, checkpoint: job.checkpoint, signal: active.controller.signal,
          huashengAccountName: job.huashengAccountName,
          onCheckpoint: async update => {
            // This await must stay outside the SQLite transaction. Validate every upcoming effect,
            // not just job startup: a source can be deleted or edited while the website is thinking.
            const observation = update.checkpoint === 'created' || update.checkpoint === 'submitted'
            if (!observation) {
              try { await this.validateSnapshot(publicJob(job)) }
              catch (error) { this.abortActive('source_changed'); throw error }
            }
            this.db.transaction(() => {
              this.guard(job.id, observation)
              if (!observation) {
                const inspection = this.inspectionLease()
                if (this.leaseAlive(inspection) && inspection.projectUrl === (update.projectUrl ?? this.storedJob(job.id)?.projectUrl)) {
                  throw new HuashengQueueError('花生项目正在检查制作状态，请稍后恢复')
                }
              }
              // Resolve this promise only after the durable write; the driver awaits it before effects.
              this.db.prepare(`UPDATE history_huasheng_jobs SET checkpoint = ?, stage = ?, message = ?,
                project_url = COALESCE(?, project_url), video_url = COALESCE(?, video_url), updated_at = ? WHERE id = ? AND owner = ?`)
                .run(update.checkpoint, update.checkpoint, update.message, update.projectUrl ?? null, update.videoUrl ?? null, timestamp(), job.id, this.owner)
              if (update.checkpoint === 'submitted') this.markProductionSubmitted(job.id, update.productionStatus)
            }).immediate()
          },
        })
        if (!result.projectUrl) throw new Error('花生未返回已接受制作的项目链接，请人工核验')
        // A concrete acknowledgement wins over a late cancel request: do not label accepted work canceled.
        this.db.prepare(`UPDATE history_huasheng_jobs SET status = 'submitted', stage = 'submitted',
          message = CASE WHEN checkpoint = 'submitted' THEN message ELSE '花生已进入视频编辑页或制作排队' END,
          project_url = ?, video_url = COALESCE(?, video_url),
          error = NULL, updated_at = ? WHERE id = ? AND owner = ?`).run(result.projectUrl, result.videoUrl ?? null, timestamp(), job.id, this.owner)
        this.markProductionSubmitted(job.id)
      } catch (error) {
        const code = (error as { code?: string } | null)?.code
        const stored = this.storedJob(job.id)
        const acknowledged = stored?.checkpoint === 'submitted' && Boolean(stored.projectUrl)
        const canceled = Boolean(stored?.cancelRequested)
        const status: HuashengJobStatus = acknowledged ? 'submitted' : canceled ? 'canceled' : active.reason === 'shutdown' ? 'queued'
          : code === 'login_required' ? 'waiting_login'
            : error instanceof HuashengQueueError || ['manual_review', 'browser_unavailable', 'timeout'].includes(code ?? '') || active.reason === 'lease_lost' || active.reason === 'source_changed'
              ? 'needs_attention' : 'failed'
        const message = acknowledged ? stored!.message : canceled ? '浏览器操作已停止，文稿和检查点保留'
          : active.reason === 'shutdown' ? '服务正在关闭，重启后核验检查点继续' : errorMessage(error)
        this.db.prepare(`UPDATE history_huasheng_jobs SET status = ?, stage = ?, message = ?, error = ?, updated_at = ? WHERE id = ? AND owner = ?`)
          .run(status, status, message, acknowledged || canceled || active.reason === 'shutdown' ? null : errorMessage(error), timestamp(), job.id, this.owner)
      } finally {
        clearInterval(heartbeat)
        this.active = undefined
        this.db.transaction(() => {
          this.db.prepare('UPDATE history_huasheng_jobs SET owner = NULL WHERE id = ? AND owner = ?').run(job.id, this.owner)
          this.db.prepare('UPDATE history_huasheng_lease SET owner = NULL, host = NULL, pid = NULL, expires_at = 0 WHERE id = 1 AND owner = ?').run(this.owner)
        }).immediate()
      }
    }
  }

  private markProductionSubmitted(id: number, observed?: 'queued' | 'creating') {
    this.db.prepare(`UPDATE history_huasheng_jobs SET production_status = ?, production_message = ?, production_check_error = NULL
      WHERE id = ? AND production_status <> 'completed'
      AND (? = 1 OR (production_checked_at IS NULL AND production_status = 'not_started'))`)
      .run(observed ?? 'creating', observed === 'queued' ? '花生正在排队制作' : '花生已接受制作，等待检查成片状态', id, Number(observed !== undefined))
  }

  async stop(timeoutMs = 10_000) {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.selectedController?.abort(new Error('服务正在停止，所选生产队列已暂停'))
    this.selectedPending.clear()
    this.abortActive('shutdown')
    this.productionController?.abort(new Error('服务正在停止，制作状态检查已取消'))
    if (!this.draining && !this.productionCheck && !this.selectedDrain) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.all([this.draining, this.productionCheck, this.selectedDrain]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('花生浏览器尚未退出；执行锁保留至进程退出')), timeoutMs)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }

  async close() { await this.stop(); this.db.close() }
}

export function createHistoryHuashengDriver(accounts: HuashengAccountsService = getHistoryHuashengAccountsService(),
  dependencies: { runBrowserJob?: typeof import('./history-huasheng-browser.js').runHuashengBrowserJob } = {}): HuashengBrowserDriver {
  const config = (name?: string, options?: { open?: boolean; signal?: AbortSignal }) => accounts.readyBrowserConfig(name || HISTORY_HUASHENG_ACCOUNT, options)
  const status = (account: ReturnType<HuashengAccountsService['get']>): HuashengBrowserStatus => ({
    status: account.status === 'ready' ? 'ready' : ['login_required', 'expired'].includes(account.status) ? 'login_required' : 'unavailable', message: account.message,
  })
  return {
    discoverHuashengProject: async input => (await import('./history-huasheng-discovery.js')).discoverHuashengProject({ ...input, browserConfig: await config(input.huashengAccountName, { signal: input.signal }) }),
    getHuashengBrowserSnapshot: () => {
      const account = accounts.get(HISTORY_HUASHENG_ACCOUNT)
      return { ...status(account), checkedAt: account.checkedAt }
    },
    getHuashengBrowserStatus: async () => status(await accounts.check(HISTORY_HUASHENG_ACCOUNT)),
    openHuashengBrowser: async () => status(await accounts.openLogin(HISTORY_HUASHENG_ACCOUNT)),
    runHuashengBrowserJob: async input => {
      input.signal.throwIfAborted()
      let browserConfig: Awaited<ReturnType<typeof config>>
      try { browserConfig = await config(input.huashengAccountName, { open: true, signal: input.signal }) }
      catch (error) {
        input.signal.throwIfAborted()
        const failure = error as {code?: string; retryable?: boolean} | null
        // Retry only definite transient account preparation before creation.
        // No page operation or dispatched checkpoint is inside this retry boundary.
        if (input.projectUrl || input.checkpoint && input.checkpoint !== 'opening'
          || failure?.code !== 'browser_unavailable' || failure.retryable !== true) throw error
        await delay(1000, undefined, { signal: input.signal })
        input.signal.throwIfAborted()
        browserConfig = await config(input.huashengAccountName, { open: true, signal: input.signal })
      }
      input.signal.throwIfAborted()
      const run = dependencies.runBrowserJob ?? (await import('./history-huasheng-api.js')).runHuashengJob
      input.signal.throwIfAborted()
      return run({ ...input, browserConfig })
    },
    inspectHuashengProject: async input => (await import('./history-huasheng-export-api.js')).inspectHuashengProduction({ ...input, browserConfig: await config(input.huashengAccountName, { signal: input.signal }) }),
  }
}

let service: HistoryHuashengService | undefined
export function getHistoryHuashengService() {
  if (!service) {
    const databasePath = process.env.DB_PATH || fileURLToPath(new URL('../../../data/huobao_drama.db', import.meta.url))
    service = new HistoryHuashengService({
      databasePath,
      loadSource: async id => {
        const library = await import('./history-script-library.js')
        const source = library.getHistorySource(id)
        if (!source) throw new HuashengQueueError('历史文稿不存在或已删除', 404)
        try { return { id, title: source.title, script: library.requireCurrentHistoryScript(source) } }
        catch { throw new HuashengQueueError('请先完成当前稿的校对与二创，过期稿不能提交花生') }
      },
      driver: createHistoryHuashengDriver(),
      onError: error => console.error('[history-huasheng] queue:', errorMessage(error)),
    })
  }
  return service
}

export async function enqueueHistoryHuashengSource(sourceId: number) {
  return getHistoryHuashengService().enqueueMarkedSource(sourceId)
}

export function startHistoryHuashengWorker() {
  if (process.env.TASK_WORKER_DISABLED === '1' || process.env.HISTORY_HUASHENG_WORKER_DISABLED === '1') return null
  const queue = getHistoryHuashengService()
  queue.start()
  return queue
}
