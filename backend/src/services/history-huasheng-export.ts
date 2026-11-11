import Database from 'better-sqlite3'
import { listHistoryVideoDeliveries, recordHistoryVideoDelivery, recordHistoryVideoPublication, allowsHistoryVideoPublication, ensureHistoryVideoPublicationSchema, ensureHistoryVideoDeliveriesSchema } from './history-video-deliveries.js'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { getHistoryProductionGate, HISTORY_PRODUCTION_LIMIT } from './history-production-gate.js'
import type { HistoryDeliveryAutomationResult, HistoryDeliveryAutomationStatus } from './history-delivery-automation.js'
import { getHistoryHuashengAccountsService, HISTORY_HUASHENG_ACCOUNT } from './huasheng-accounts.js'
import type { HuashengBrowserConfig } from './history-huasheng-browser.js'

export type HuashengExportStatus = 'queued' | 'exporting' | 'downloading' | 'processing' | 'completed' | 'waiting_login' | 'failed' | 'needs_attention'
export type HuashengExportBranchStatus = HistoryDeliveryAutomationStatus
export interface HuashengExportAutomation extends HistoryDeliveryAutomationResult {
  article?: { status: HuashengExportBranchStatus; message: string }
}
export interface HuashengExportApi {
  createHuashengExport(input: { projectUrl: string; signal: AbortSignal; browserConfig?: HuashengBrowserConfig; onDispatched?: () => Promise<void> }): Promise<{ taskId: string; projectHash: string }>
  inspectHuashengExport(input: { projectUrl: string; taskId: string; projectHash: string; signal: AbortSignal; browserConfig?: HuashengBrowserConfig }): Promise<{ progress: number; url: string | null; filename: string | null }>
  downloadHuashengExport(input: { projectUrl: string; projectHash: string; url: string; filename?: string; signal: AbortSignal; browserConfig?: HuashengBrowserConfig; onProgress?: (p: { bytes: number; totalBytes: number | null }) => void }): Promise<{ filePath: string; filename: string; bytes: number }>
}
export interface HuashengExportJob {
  id: number; huashengJobId: number; sourceId: number; scriptSha256: string; projectUrl: string; huashengAccountName: string
  status: HuashengExportStatus; stage: string; message: string; error: string | null
  exportProgress: number; downloadedBytes: number; totalBytes: number | null; videoUrl: string | null
  designStatus: HuashengExportBranchStatus | null; coverStatus: HuashengExportBranchStatus | null; articleStatus: HuashengExportBranchStatus | null
  createdAt: string; updatedAt: string
}
interface LinkedJob { id: number; source_id: number; script_sha256: string; project_url: string; production_status: string; status: string; huasheng_account_name?: string }
interface StoredJob {
  id: number; huasheng_job_id: number; source_id: number; script_sha256: string; project_url: string; huasheng_account_name: string
  status: HuashengExportStatus; stage: string; message: string; error: string | null
  export_progress: number; downloaded_bytes: number; total_bytes: number | null; video_url: string | null
  design_status: HuashengExportBranchStatus | null; cover_status: HuashengExportBranchStatus | null; article_status: HuashengExportBranchStatus | null
  task_id: string | null; project_hash: string | null; download_url: string | null; filename: string | null; file_path: string | null
  dispatched: number; retries_json: string; retry_failed_branches: number; next_attempt_at: number
  owner: string | null; host: string | null; pid: number | null; created_at: string; updated_at: string
}
export interface HuashengExportDelivery { videoUrl: string | null; scriptSha256: string | null; available: boolean; videoId?: number }
export interface HuashengExportWorkerStatus { status: 'running' | 'stopped'; message: string }
export interface HistoryHuashengExportOptions {
  databasePath?: string; database?: Database.Database; root?: string; api?: HuashengExportApi
  accountConfig?: (accountName: string) => Promise<HuashengBrowserConfig>
  loadSource?: (id: number) => { script: string } | Promise<{ script: string }>
  loadDelivery?: (id: number) => HuashengExportDelivery | Promise<HuashengExportDelivery>
  attachVideo?: (id: number, filePath: string, name: string, options: { expectedScriptSha256: string; onlyIfMissing: true; producer?: 'huasheng'; producerJobId?: string }) => Promise<unknown>
  ensureAutomation?: (id: number, options: { expectedScriptSha256: string; videoId: number; retryFailed?: boolean }) => Promise<HuashengExportAutomation>
  hasCoverFiles?: (id: number, videoId?: number) => boolean | Promise<boolean>
  enableMonitoring?: () => unknown | Promise<unknown>
  checkProduction?: (id: number) => unknown | Promise<unknown>
  now?: () => number; pollMs?: number; stepDelayMs?: number; loginDelayMs?: number; maxRetries?: number; concurrency?: number
  isProcessAlive?: (pid: number) => boolean; onError?: (error: unknown) => void
}
export class HuashengExportError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 = 409) { super(message) }
}
const digest = (script: string) => createHash('sha256').update(script).digest('hex')
const redact = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/https?:\/\/[^\s"'<>]+/g, '[链接已隐藏]').slice(0, 1500)
const active = ['queued', 'exporting', 'downloading', 'processing', 'waiting_login']
const terminalBranch = (status: string) => ['completed', 'failed', 'needs_attention'].includes(status)
function validateAutomation(value: unknown): asserts value is HuashengExportAutomation {
  const labels = { design: '标题方案', covers: '视频封面' } as const
  const missing = (Object.keys(labels) as Array<keyof typeof labels>).filter(key => {
    const branch = (value as HuashengExportAutomation | null | undefined)?.[key]
    return !branch || !['queued', 'generating', 'completed', 'failed', 'needs_attention'].includes(branch.status)
      || typeof branch.message !== 'string'
  })
  if (missing.length) throw Object.assign(new Error(`发布准备服务返回的状态不完整（${missing.map(key => labels[key]).join('、')}）；已保留成片`), { code: 'retryable' })
}
function projectUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new HuashengExportError('花生项目链接无效') }
  if (url.protocol !== 'https:' || !['www.huasheng.cn', 'huasheng.cn'].includes(url.hostname) || url.port || url.username || url.password || !/^\/video\/\d+\/?$/.test(url.pathname)) throw new HuashengExportError('花生项目链接无效')
  return `https://www.huasheng.cn${url.pathname.replace(/\/$/, '')}`
}
function publicJob(row: StoredJob): HuashengExportJob {
  return { id: row.id, huashengJobId: row.huasheng_job_id, sourceId: row.source_id, scriptSha256: row.script_sha256,
    projectUrl: row.project_url, huashengAccountName: row.huasheng_account_name, status: row.status, stage: row.stage, message: row.message, error: row.error,
    exportProgress: row.export_progress, downloadedBytes: row.downloaded_bytes, totalBytes: row.total_bytes, videoUrl: row.video_url,
    designStatus: row.design_status, coverStatus: row.cover_status, articleStatus: row.article_status, createdAt: row.created_at, updatedAt: row.updated_at }
}

/** Imports and construction never contact Huasheng or start a worker. */
export class HistoryHuashengExportService {
  private readonly db: Database.Database
  private readonly owner = randomUUID()
  private timer?: ReturnType<typeof setInterval>
  private draining: Promise<void> | null = null
  private startupRepair: Promise<void> | null = null
  private readonly selected = new Set<number>()
  private selectedDrain: Promise<void> | null = null
  private selectedController?: AbortController
  private heartbeat?: ReturnType<typeof setInterval>
  private stopping = false
  private readonly controllers = new Map<number, AbortController>()
  constructor(private readonly options: HistoryHuashengExportOptions = {}) {
    const filename = options.databasePath || process.env.DB_PATH || fileURLToPath(new URL('../../../data/huobao_drama.db', import.meta.url))
    if (!options.database && filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
    this.db = options.database ?? new Database(filename, { timeout: 5000 })
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS history_huasheng_export_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, admission_watermark INTEGER
    );
    INSERT OR IGNORE INTO history_huasheng_export_settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS history_huasheng_export_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, huasheng_job_id INTEGER NOT NULL, source_id INTEGER NOT NULL,
      script_sha256 TEXT NOT NULL, project_url TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','exporting','downloading','processing','completed','waiting_login','failed','needs_attention')),
      stage TEXT NOT NULL, message TEXT NOT NULL, error TEXT,
      export_progress REAL NOT NULL DEFAULT 0, downloaded_bytes INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER, video_url TEXT,
      design_status TEXT, cover_status TEXT, article_status TEXT, task_id TEXT, project_hash TEXT, download_url TEXT, filename TEXT, file_path TEXT,
      dispatched INTEGER NOT NULL DEFAULT 0, retries_json TEXT NOT NULL DEFAULT '{}', retry_failed_branches INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0, owner TEXT, host TEXT, pid INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(huasheng_job_id,script_sha256)
    );
    CREATE INDEX IF NOT EXISTS history_huasheng_export_due ON history_huasheng_export_jobs(status,next_attempt_at,id);
    CREATE TABLE IF NOT EXISTS history_huasheng_export_workers (
      owner TEXT PRIMARY KEY, host TEXT NOT NULL, pid INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('automatic','selected'))
    );`)
    const columns = this.db.pragma('table_info(history_huasheng_export_jobs)') as Array<{ name: string }>
    if (!columns.some(column => column.name === 'cover_status')) this.db.exec('ALTER TABLE history_huasheng_export_jobs ADD COLUMN cover_status TEXT')
    if (!columns.some(column => column.name === 'huasheng_account_name')) this.db.exec(`ALTER TABLE history_huasheng_export_jobs ADD COLUMN huasheng_account_name TEXT NOT NULL DEFAULT '${HISTORY_HUASHENG_ACCOUNT}'`)
    getHistoryProductionGate(this.db)
  }
  private now() { return (this.options.now ?? Date.now)() }
  private timestamp() { return new Date(this.now()).toISOString() }
  private hasProjects() { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='history_huasheng_jobs' AND type='table'").get() }
  private stored(id: number) { return this.db.prepare('SELECT * FROM history_huasheng_export_jobs WHERE id=?').get(id) as StoredJob | undefined }
  get enabled() { return Boolean((this.db.prepare('SELECT enabled FROM history_huasheng_export_settings WHERE id=1').get() as { enabled: number }).enabled) }
  listJobs(sourceId?: number) {
    return (this.db.prepare(`SELECT * FROM history_huasheng_export_jobs ${sourceId === undefined ? '' : 'WHERE source_id=?'} ORDER BY id DESC LIMIT 500`)
      .all(...(sourceId === undefined ? [] : [sourceId])) as StoredJob[]).map(publicJob)
  }
  getJob(id: number) {
    const row = this.stored(id)
    if (!row) throw new HuashengExportError('导出任务不存在', 404)
    return publicJob(row)
  }
  get worker(): HuashengExportWorkerStatus {
    const rows = this.db.prepare('SELECT * FROM history_huasheng_export_workers WHERE heartbeat_at>?')
      .all(Date.now() - 15_000) as Array<{ owner: string; host: string; pid: number; mode: string }>
    const live = rows.filter(row => this.alive(row))
    return live.length ? { status: 'running', message: live.some(row => row.mode === 'automatic')
      ? '自动导出与产物生成进程在线，按已保存的创作状态接续'
      : '所选任务正在导出和生成产物，不处理未选中的任务' }
      : { status: 'stopped', message: '导出执行进程未运行；可选择项目启动，或启动独立导出进程' }
  }
  overview(sourceId?: number) { return { enabled: this.enabled, jobs: this.listJobs(sourceId), worker: this.worker,
    production: getHistoryProductionGate(this.db).overview() } }
  private recordHeartbeat() {
    this.db.prepare(`INSERT INTO history_huasheng_export_workers(owner,host,pid,heartbeat_at,mode) VALUES(?,?,?,?,?)
      ON CONFLICT(owner) DO UPDATE SET heartbeat_at=excluded.heartbeat_at, mode=excluded.mode`)
      .run(this.owner, hostname(), process.pid, Date.now(), this.timer ? 'automatic' : 'selected')
  }
  private keepHeartbeat() {
    if (this.heartbeat) return
    // The first write runs synchronously from start/runPending, outside their
    // promise handlers. Report contention just like later heartbeat ticks.
    try { this.recordHeartbeat() } catch (error) { this.options.onError?.(error) }
    this.heartbeat = setInterval(() => {
      try { this.recordHeartbeat() } catch (error) { this.options.onError?.(error) }
    }, 5000)
    this.heartbeat.unref()
  }
  private releaseHeartbeat() {
    if (this.timer || this.draining || this.selectedDrain) return
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.db.prepare('DELETE FROM history_huasheng_export_workers WHERE owner=?').run(this.owner)
  }
  async setEnabled(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new HuashengExportError('enabled 必须是布尔值', 400)
    this.db.transaction(() => {
      const max = this.hasProjects() ? (this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM history_huasheng_jobs').get() as { id: number }).id : 0
      this.db.prepare(`UPDATE history_huasheng_export_settings SET enabled=?,
        admission_watermark=CASE WHEN ?=1 THEN COALESCE(admission_watermark,?) ELSE admission_watermark END WHERE id=1`).run(Number(enabled), Number(enabled), max)
    }).immediate()
    this.wake()
    return { enabled }
  }
  private async source(id: number) {
    if (this.options.loadSource) return this.options.loadSource(id)
    const library = await import('./history-script-library.js')
    const source = library.getHistorySource(id)
    if (!source) throw new HuashengExportError('稿件不存在或已删除', 404)
    return { script: library.requireCurrentHistoryScript(source) }
  }
  private insert(link: LinkedJob) {
    const url = projectUrl(link.project_url)
    this.db.prepare(`INSERT OR IGNORE INTO history_huasheng_export_jobs
      (huasheng_job_id,source_id,script_sha256,project_url,huasheng_account_name,status,stage,message,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,?,'queued','waiting_production','等待花生成片可导出',?,?,?)`)
      .run(link.id, link.source_id, link.script_sha256, url, link.huasheng_account_name || HISTORY_HUASHENG_ACCOUNT, this.now(), this.timestamp(), this.timestamp())
    return publicJob(this.db.prepare('SELECT * FROM history_huasheng_export_jobs WHERE huasheng_job_id=? AND script_sha256=?').get(link.id, link.script_sha256) as StoredJob)
  }
  async enqueue(sourceIds: number[]) {
    if (this.stopping) throw new HuashengExportError('导出服务正在停止，请稍后重试')
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 100 || sourceIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new HuashengExportError('请选择 1–100 个有效稿件', 400)
    if (!this.hasProjects()) throw new HuashengExportError('尚无关联花生项目')
    const selected: LinkedJob[] = []
    for (const id of new Set(sourceIds)) {
      const sha = digest((await this.source(id)).script)
      const link = this.db.prepare(`SELECT * FROM history_huasheng_jobs WHERE source_id=? AND script_sha256=?
        AND project_url IS NOT NULL AND project_url<>'' AND status<>'canceled' ORDER BY id DESC LIMIT 1`).get(id, sha) as LinkedJob | undefined
      if (!link) throw new HuashengExportError(`稿件 #${id} 没有关联当前版本的花生项目`)
      projectUrl(link.project_url)
      selected.push(link)
    }
    const inserted = this.db.transaction(() => selected.map(link => this.insert(link))).immediate()
    await this.repairCompletedCovers(sourceIds)
    const jobs = inserted.map(job => this.getJob(job.id))
    this.runSelected(jobs.map(job => job.id))
    return { jobs }
  }
  /** One bounded local-file pass; automatic repair excludes any confirmed upload.
   * Explicit source IDs opt into repair without creating a new export receipt. */
  async repairCompletedCovers(sourceIds?: number[]) {
    if (this.stopping) return { checked: 0, repaired: 0 }
    if (sourceIds !== undefined && (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 100 || sourceIds.some(id => !Number.isSafeInteger(id) || id < 1))) throw new HuashengExportError('请选择 1–100 个有效稿件', 400)
    const tables = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('history_social_upload_confirmations','history_social_upload_jobs')").all() as Array<{ name: string }>).map(row => row.name))
    const exclusions = sourceIds ? '' : [
      tables.has('history_social_upload_confirmations') ? 'AND NOT EXISTS (SELECT 1 FROM history_social_upload_confirmations u WHERE u.source_id=e.source_id)' : '',
      tables.has('history_social_upload_jobs') ? "AND NOT EXISTS (SELECT 1 FROM history_social_upload_jobs u WHERE u.source_id=e.source_id AND u.status='completed' AND json_valid(u.result_json) AND json_extract(u.result_json,'$.saved')=1)" : '',
    ].join(' ')
    const rows = this.db.prepare(`SELECT e.* FROM history_huasheng_export_jobs e WHERE e.status='completed' AND e.owner IS NULL
      ${sourceIds ? `AND e.source_id IN (${sourceIds.map(() => '?').join(',')})` : 'AND e.cover_status IS NULL'} ${exclusions} ORDER BY e.id LIMIT 100`)
      .all(...(sourceIds ?? [])) as StoredJob[]
    let repaired = 0
    for (const row of rows) {
      if (this.stopping) break
      let covers: HuashengExportBranchStatus = 'queued'
      let status: HuashengExportStatus = 'processing'
      let message = '保留已下载视频，准备本版标题与封面'
      let videoUrl = row.video_url
      try {
        if (digest((await this.source(row.source_id)).script) !== row.script_sha256) throw new HuashengExportError('稿件版本已变化，请核对原产物后修复')
        const ownVideo = listHistoryVideoDeliveries(this.db, row.source_id, row.script_sha256)
          .find(video => video.producer === 'huasheng' && video.producerJobId === String(row.huasheng_job_id))
        const hasFiles = this.options.hasCoverFiles ?? (async (id: number, videoId?: number) => {
          if (videoId === undefined) return false
          const automation = await import('./history-delivery-automation.js')
          return automation.hasHistoryCoverFiles(id, this.options.root, videoId)
        })
        if (await hasFiles(row.source_id, ownVideo?.id)) {
          covers = 'completed'
          status = row.design_status === 'completed' ? 'completed' : 'processing'
          message = status === 'completed' ? '视频、标题和视频封面已完成' : '封面图片已核对，继续未完成产物'
        }
        const delivery = await this.delivery(row.source_id,row)
        if (!delivery.videoUrl || !delivery.available || delivery.scriptSha256 !== row.script_sha256 || (videoUrl && videoUrl !== delivery.videoUrl)) throw new HuashengExportError('原成片缺失或关联已变化，请人工核对；不会重新导出或下载')
        videoUrl = delivery.videoUrl
      } catch (error) {
        covers = 'needs_attention'; status = 'needs_attention'; message = redact(error)
      }
      if (this.stopping) break
      const changed = this.db.prepare(`UPDATE history_huasheng_export_jobs AS e SET cover_status=?,status=?,stage=?,message=?,error=?,
        video_url=?,next_attempt_at=?,updated_at=? WHERE id=? AND status='completed' AND owner IS NULL AND cover_status IS ? ${exclusions}`)
        .run(covers, status, status === 'completed' ? 'completed' : 'products_repair', message, status === 'needs_attention' ? message : null,
          videoUrl, this.now(), this.timestamp(), row.id, row.cover_status)
      if (changed.changes && status === 'processing') repaired++
      if (changed.changes && status !== 'needs_attention') {
        const video = await this.registerLegacyDelivery(row)
        if (video && status === 'completed' && allowsHistoryVideoPublication(this.db,row.source_id,row.script_sha256,'huasheng')) {
          recordHistoryVideoPublication(this.db,row.source_id,row.script_sha256,video.id,'huasheng')
        }
      }
    }
    return { checked: rows.length, repaired }
  }
  private async registerLegacyDelivery(job: StoredJob) {
    const existing = listHistoryVideoDeliveries(this.db,job.source_id,job.script_sha256)
      .find(video => video.producer === 'huasheng' && video.producerJobId === String(job.huasheng_job_id))
    if (existing) return existing
    if (!job.video_url || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_script_deliveries'").get()) return undefined
    const saved = this.db.prepare('SELECT video_path,video_name,duration,script_sha256 FROM history_script_deliveries WHERE script_id=?')
      .get(job.source_id) as { video_path:string|null; video_name:string; duration:number; script_sha256:string } | undefined
    if (!saved?.video_path || saved.script_sha256 !== job.script_sha256
      || `/${saved.video_path.replace(/^\/+/, '')}` !== `/${job.video_url.replace(/^\/+/, '')}`
      || !Number.isFinite(saved.duration) || saved.duration <= 0) return undefined
    const root = path.resolve(this.options.root || process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url)))
    const directory = fs.realpathSync(path.join(root,'history-deliveries',String(job.source_id))) + path.sep
    const filename = fs.realpathSync(path.resolve(root,saved.video_path.replace(/^\/?static\//,'')))
    if (!filename.startsWith(directory) || !fs.statSync(filename).isFile()) return undefined
    const content = createHash('sha256')
    let bytes = 0
    for await (const chunk of fs.createReadStream(filename)) { content.update(chunk); bytes += chunk.length }
    if (!bytes || digest((await this.source(job.source_id)).script) !== job.script_sha256) return undefined
    return recordHistoryVideoDelivery(this.db,{ scriptId:job.source_id, scriptSha256:job.script_sha256,
      producer:'huasheng',producerJobId:String(job.huasheng_job_id),videoUrl:`/${saved.video_path.replace(/^\/+/, '')}`,
      videoName:saved.video_name,duration:saved.duration,sha256:content.digest('hex') })
  }
  /** Reconcile only accepted dual work; never backfill publication for unrelated history. */
  private async repairCompletedPublications() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_dual_production'").get()) return
    ensureHistoryVideoPublicationSchema(this.db)
    ensureHistoryVideoDeliveriesSchema(this.db)
    const rows = this.db.prepare(`SELECT e.* FROM history_huasheng_export_jobs e
      JOIN history_dual_production p ON p.source_id=e.source_id AND p.script_sha256=e.script_sha256
        AND p.huasheng_job_id=e.huasheng_job_id AND p.production_mode='dual'
      WHERE e.status='completed' AND e.owner IS NULL AND e.design_status='completed' AND e.cover_status='completed'
        AND e.video_url IS NOT NULL AND NOT EXISTS (SELECT 1 FROM history_video_publication_intents i
          JOIN history_video_deliveries v ON v.id=i.video_id WHERE i.source_id=e.source_id
            AND i.script_sha256=e.script_sha256 AND v.producer='huasheng' AND v.producer_job_id=CAST(e.huasheng_job_id AS TEXT))
      ORDER BY e.id LIMIT 100`).all() as StoredJob[]
    for (const row of rows) {
      if (this.stopping) break
      try {
        if (digest((await this.source(row.source_id)).script) !== row.script_sha256) continue
        const video = await this.registerLegacyDelivery(row)
        if (video) recordHistoryVideoPublication(this.db,row.source_id,row.script_sha256,video.id,'huasheng')
      } catch (error) { this.options.onError?.(error) }
    }
  }
  private async admitAutomatic() {
    if (!this.enabled || !this.hasProjects()) return
    const { admission_watermark: watermark } = this.db.prepare('SELECT admission_watermark FROM history_huasheng_export_settings WHERE id=1').get() as { admission_watermark: number | null }
    if (watermark === null) return
    const candidates = this.db.prepare(`SELECT h.* FROM history_huasheng_jobs h WHERE h.id>? AND h.production_status='completed'
      AND h.status<>'canceled' AND h.project_url IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM history_huasheng_export_jobs e WHERE e.huasheng_job_id=h.id AND e.script_sha256=h.script_sha256) ORDER BY h.id`).all(watermark) as LinkedJob[]
    for (const link of candidates) {
      if (this.stopping || !this.enabled) return
      try { if (digest((await this.source(link.source_id)).script) === link.script_sha256) this.insert(link) }
      catch (error) { this.options.onError?.(error) }
    }
  }
  resume(id: number) {
    if (this.stopping) throw new HuashengExportError('导出服务正在停止，请稍后重试')
    const row = this.stored(id)
    if (!row) throw new HuashengExportError('导出任务不存在', 404)
    const repair = row.status === 'completed' && [row.design_status, row.cover_status].some(status => status !== 'completed')
    if (!repair && !['failed', 'needs_attention'].includes(row.status)) throw new HuashengExportError('仅可重试失败或产物未完成的任务')
    if ((row.dispatched && !row.task_id) || (row.stage === 'export_uncertain' && (!row.task_id || !row.project_hash))) {
      throw new HuashengExportError('导出提交结果不明确，须核验并绑定原导出任务，不能再次提交')
    }
    const changed = this.db.prepare(`UPDATE history_huasheng_export_jobs SET status='queued',error=NULL,message='已安排恢复原任务',
      stage=CASE WHEN ? THEN 'products_repair' ELSE stage END,
      retries_json='{}',retry_failed_branches=1,next_attempt_at=?,updated_at=? WHERE id=? AND status=? AND owner IS NULL`)
      .run(Number(repair), this.now(), this.timestamp(), id, row.status)
    if (!changed.changes) throw new HuashengExportError('任务仍在退出，请稍后重试')
    this.runSelected([id])
    return { job: this.getJob(id) }
  }
  private alive(job: Pick<StoredJob, 'owner' | 'host' | 'pid'>) {
    if (!job.owner) return false
    if (job.host !== hostname() || !job.pid) return true
    if (this.options.isProcessAlive) return this.options.isProcessAlive(job.pid)
    try { process.kill(job.pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }
  private claim(id: number) {
    return this.db.transaction(() => {
      const job = this.stored(id)
      // A completed local step can retain its claim if releasing it hit a database error.
      const inactiveLocalClaim = job?.owner === this.owner && !this.controllers.has(id)
      if (!job || !active.includes(job.status) || job.next_attempt_at > this.now() || (!inactiveLocalClaim && this.alive(job))) return undefined
      this.db.prepare('UPDATE history_huasheng_export_jobs SET owner=?,host=?,pid=?,updated_at=? WHERE id=?')
        .run(this.owner, hostname(), process.pid, this.timestamp(), id)
      return this.stored(id)!
    }).immediate()
  }
  private save(job: StoredJob, patch: Partial<StoredJob>) {
    const fields = { ...patch, updated_at: this.timestamp() }
    const updated = this.db.prepare(`UPDATE history_huasheng_export_jobs SET ${Object.keys(fields).map(key => `${key}=?`).join(',')} WHERE id=? AND owner=?`)
      .run(...Object.values(fields), job.id, this.owner)
    if (!updated.changes) throw new Error('导出任务执行权已变化')
    Object.assign(job, fields)
  }
  private defer(job: StoredJob, patch: Partial<StoredJob>, delay = this.options.stepDelayMs ?? 3000) {
    this.save(job, { ...patch, next_attempt_at: this.now() + Math.max(1, delay) })
  }
  private async delivery(id: number, job?: Pick<StoredJob, 'huasheng_job_id' | 'script_sha256' | 'video_url'>): Promise<HuashengExportDelivery> {
    if (this.options.loadDelivery) return this.options.loadDelivery(id)
    const own = listHistoryVideoDeliveries(this.db,id,job?.script_sha256).find(video => video.producer === 'huasheng' && (!job || video.producerJobId === String(job.huasheng_job_id)))
    // Old export receipts may predate separate producer records. Only reuse their own saved URL.
    const row = own ? { video_path: own.videoUrl, script_sha256: own.scriptSha256 }
      : job?.video_url ? { video_path: job.video_url, script_sha256: job.script_sha256 } : undefined
    if (!row?.video_path) return { videoUrl: null, scriptSha256: null, available: false }
    const root = path.resolve(this.options.root || process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url)))
    const relative = row.video_path.replace(/^\/?static\//, '')
    const filename = path.resolve(root, relative)
    const directory = path.join(root, 'history-deliveries', String(id)) + path.sep
    let available = false
    try { available = filename.startsWith(directory) && fs.statSync(filename).isFile() && fs.statSync(filename).size > 0 } catch { /* Preserve missing media association for manual repair. */ }
    return { videoUrl: `/${row.video_path.replace(/^\/+/, '')}`, scriptSha256: row.script_sha256, available, videoId: own?.id }
  }
  private async api(): Promise<HuashengExportApi> { return this.options.api ?? await import('./history-huasheng-export-api.js') }
  private async tick(job: StoredJob, signal: AbortSignal) {
    if (digest((await this.source(job.source_id)).script) !== job.script_sha256) throw new HuashengExportError('稿件版本已变化，保留已有成片和导出记录')
    const linked = this.db.prepare('SELECT * FROM history_huasheng_jobs WHERE id=?').get(job.huasheng_job_id) as LinkedJob | undefined
    if (!linked || linked.source_id !== job.source_id || linked.script_sha256 !== job.script_sha256 || projectUrl(linked.project_url) !== job.project_url || linked.status === 'canceled') throw new HuashengExportError('原花生项目关联已变化，已停止自动处理')
    if ((linked.huasheng_account_name || HISTORY_HUASHENG_ACCOUNT) !== job.huasheng_account_name) throw new HuashengExportError('原花生任务的制作账号已变化，保留原导出记录，不切换账号')
    const delivery = await this.delivery(job.source_id,job)
    signal.throwIfAborted()
    if (job.stage === 'products_repair' && !delivery.videoUrl) throw new HuashengExportError('修复产物需要原成片，请核对视频关联；不会重新导出或下载')
    const production = getHistoryProductionGate(this.db)
    const reservation = `export:${job.id}`
    if (!job.task_id && !delivery.videoUrl && linked.production_status !== 'completed') {
      production.release(reservation)
      this.defer(job, { status: 'queued', stage: 'waiting_production', message: '等待已保存的花生状态更新为完成；可手动检查创作状态', error: null }, 30_000)
      return
    }
    // A durable project slot remains occupied through export/download and all
    // asynchronous generation branches. Finishing this short tick does not free it.
    if (job.status === 'waiting_login') this.save(job, { status: 'queued' })
    if (!production.tryAcquire(job.source_id, reservation, 'pipeline')) {
      this.defer(job, { status: 'queued', stage: 'waiting_capacity',
        message: `等待生产名额（最多同时生产 ${HISTORY_PRODUCTION_LIMIT} 个项目）`, error: null })
      return
    }
    if (delivery.videoUrl) {
      if (!delivery.available || delivery.scriptSha256 !== job.script_sha256 || (job.video_url && job.video_url !== delivery.videoUrl)) throw new HuashengExportError('已有成片缺失、版本不匹配或关联已变化，未覆盖原视频')
      this.save(job, { status: 'processing', stage: 'processing', video_url: delivery.videoUrl, message: '成片已关联，正在生成标题和视频封面' })
      const videoId = delivery.videoId ?? (await this.registerLegacyDelivery(job))?.id
      if (videoId === undefined) throw new HuashengExportError('花生成片缺少可核对的独立交付记录，未生成标题与封面')
      const retryFailed = Boolean(job.retry_failed_branches)
      if (retryFailed) this.save(job, { retry_failed_branches: 0 })
      const ensure = this.options.ensureAutomation ?? (await import('./history-delivery-automation.js')).ensureHistoryDeliveryAutomation
      const result = await ensure(job.source_id, { expectedScriptSha256: job.script_sha256, videoId, retryFailed })
      validateAutomation(result)
      const values = [result.design, result.covers]
      const finished = values.every(value => value.status === 'completed')
      const settled = values.every(value => terminalBranch(value.status))
      const status = finished ? 'completed' : settled ? (values.some(value => value.status === 'needs_attention') ? 'needs_attention' : 'failed') : 'processing'
      const publish = finished && allowsHistoryVideoPublication(this.db,job.source_id,job.script_sha256,'huasheng')
      const video = publish ? await this.registerLegacyDelivery(job) : undefined
      if (publish && !video) throw new HuashengExportError('已有花生成片缺少可核对的交付记录；已保留原视频，请核对原任务后继续发布准备')
      this.db.transaction(()=>{
        if (video) recordHistoryVideoPublication(this.db,job.source_id,job.script_sha256,video.id,'huasheng')
        this.defer(job, { status, stage: finished ? 'completed' : 'processing', design_status: result.design.status, cover_status: result.covers.status, article_status: null,
          message: finished ? '视频、标题和视频封面已完成' : values.map(value => redact(value.message)).join('；'),
          error: settled && !finished ? values.filter(value => value.status !== 'completed').map(value => redact(value.message)).join('；') : null })
      }).immediate()

      return
    }
    if (job.video_url) throw new HuashengExportError('已关联视频被移除，未重复下载或覆盖')
    if (job.dispatched && !job.task_id) {
      this.save(job, { status: 'needs_attention', stage: 'export_uncertain', message: '导出请求已发出但结果未确认，请核对原导出任务', error: '不会自动重复提交导出' })
      return
    }
    if (job.file_path) {
      this.save(job, { status: 'downloading', stage: 'attach', message: '下载完成，正在关联原项目' })
      const attach = this.options.attachVideo ?? (await import('./history-script-delivery.js')).attachHistoryVideoFile
      await attach(job.source_id, job.file_path, job.filename || 'huasheng.mp4', { expectedScriptSha256: job.script_sha256, onlyIfMissing: true, producer: 'huasheng', producerJobId: String(job.huasheng_job_id) })
      const attached = await this.delivery(job.source_id,job)
      if (!attached.videoUrl || !attached.available || attached.scriptSha256 !== job.script_sha256) throw new HuashengExportError('成片关联结果尚未确认，请核对原任务')
      this.defer(job, { status: 'processing', stage: 'processing', video_url: attached.videoUrl, message: '成片已关联，等待标题和视频封面', error: null })
      return
    }
    const browserConfig = this.options.accountConfig ? await this.options.accountConfig(job.huasheng_account_name)
      : this.options.api ? undefined : await getHistoryHuashengAccountsService().readyBrowserConfig(job.huasheng_account_name)
    if (!job.task_id) {
      this.save(job, { status: 'exporting', stage: 'export_request', message: '正在提交花生标准导出', error: null })
      const result = await (await this.api()).createHuashengExport({ projectUrl: job.project_url, signal, browserConfig,
        onDispatched: async () => { signal.throwIfAborted(); this.save(job, { dispatched: 1, message: '导出请求已提交，等待任务编号' }) } })
      if (!result.taskId || !result.projectHash) throw Object.assign(new Error('花生未返回完整导出任务编号'), { code: 'result_uncertain' })
      this.defer(job, { task_id: result.taskId, project_hash: result.projectHash, status: 'exporting', stage: 'export_wait', message: '花生正在导出成片', retries_json: '{}' })
      return
    }
    if (!job.project_hash) throw new HuashengExportError('导出记录缺少项目版本，不能继续下载')
    if (!job.download_url) {
      this.save(job, { status: 'exporting', stage: 'export_wait', message: '正在查询原导出任务' })
      const result = await (await this.api()).inspectHuashengExport({ projectUrl: job.project_url, taskId: job.task_id, projectHash: job.project_hash, signal, browserConfig })
      if (!Number.isFinite(result.progress) || result.progress < 0 || result.progress > 100) throw Object.assign(new Error('花生导出进度无效'), { code: 'invalid_response' })
      const retries = JSON.parse(job.retries_json); delete retries.export_wait
      const downloadable = result.progress === 100 && !!result.url
      this.defer(job, { export_progress: result.progress, download_url: downloadable ? result.url : null, filename: result.filename || job.filename,
        status: downloadable ? 'downloading' : 'exporting', stage: downloadable ? 'download' : 'export_wait',
        message: downloadable ? '导出完成，等待下载' : `花生正在导出：${result.progress}%`, error: null, retries_json: JSON.stringify(retries) })
      return
    }
    this.save(job, { status: 'downloading', stage: 'download', message: '正在下载花生成片' })
    let lastProgressAt = -Infinity
    const downloaded = await (await this.api()).downloadHuashengExport({ projectUrl: job.project_url, projectHash: job.project_hash,
      url: job.download_url, filename: job.filename ?? undefined, signal, browserConfig, onProgress: progress => {
        // Stream chunks can arrive hundreds of times per second; persist UI
        // progress twice a second and always persist the completed file below.
        if (this.now() - lastProgressAt < 500 && progress.bytes !== progress.totalBytes) return
        lastProgressAt = this.now()
        this.save(job, { downloaded_bytes: progress.bytes, total_bytes: progress.totalBytes })
      } })
    this.defer(job, { file_path: downloaded.filePath, filename: downloaded.filename, downloaded_bytes: downloaded.bytes,
      total_bytes: downloaded.bytes, stage: 'attach', message: '成片已下载并校验，等待关联项目', retries_json: '{}', error: null })
  }
  private failure(job: StoredJob, error: unknown, signal: AbortSignal) {
    const code = (error as { code?: string })?.code
    const message = redact(error)
    if ((error as { requestRejected?: boolean })?.requestRejected === true && !job.task_id) this.save(job, { dispatched: 0 })
    if ((job.dispatched && !job.task_id) || code === 'result_uncertain') {
      this.save(job, { status: 'needs_attention', stage: 'export_uncertain', message: '导出提交结果未确认，已保留记录，不会自动重复导出', error: message })
    } else if (signal.aborted && this.stopping) {
      this.save(job, { next_attempt_at: this.now(), message: '服务停止，已保存进度，启动后继续' })
    } else if (error instanceof HuashengExportError || code === 'manual_review') {
      this.save(job, { status: 'needs_attention', message, error: message })
    } else if (code === 'login_required' || code === 'browser_unavailable') {
      this.defer(job, { status: 'waiting_login', message, error: message }, this.options.loginDelayMs ?? 60_000)
    } else if (code === 'retryable') {
      const retries = JSON.parse(job.retries_json) as Record<string, number>
      retries[job.stage] = (retries[job.stage] || 0) + 1
      const exhausted = retries[job.stage] > (this.options.maxRetries ?? 3)
      this.defer(job, { status: exhausted ? 'failed' : job.status, error: message,
        message: exhausted ? `安全重试次数已用完：${message}` : `暂时失败，将继续原任务：${message}`, retries_json: JSON.stringify(retries),
        ...(job.stage === 'download' ? { download_url: null } : {}) }, Math.min(60_000, 5000 * 2 ** (retries[job.stage] - 1)))
    } else this.save(job, { status: 'failed', message, error: message })
  }
  /** A finite manual selection keeps its saved receipts and never admits unrelated completed sources. */
  private runSelected(ids: number[]) {
    if (this.stopping) return
    for (const id of ids) {
      const job = this.stored(id)
      if (!job || !active.includes(job.status)) continue
      this.selected.add(id)
      this.db.prepare('UPDATE history_huasheng_export_jobs SET next_attempt_at=MIN(next_attempt_at,?) WHERE id=? AND owner IS NULL')
        .run(this.now(), id)
    }
    if (this.selectedDrain || !this.selected.size) return
    const controller = new AbortController()
    this.selectedController = controller
    this.selectedDrain = Promise.resolve().then(async () => {
      let failures = 0
      while (!this.stopping && this.selected.size) {
        for (const id of this.selected) {
          const job = this.stored(id)
          if (!job || !active.includes(job.status)) this.selected.delete(id)
        }
        if (!this.selected.size) break
        try {
          await this.runPending([...this.selected])
          failures = 0
        } catch (error) {
          if (controller.signal.aborted || ++failures > (this.options.maxRetries ?? 3)) throw error
          this.options.onError?.(error)
          await delay(Math.max(1, Math.min(30_000, (this.options.pollMs ?? 1000) * 2 ** (failures - 1))), undefined, { signal: controller.signal })
          continue
        }
        if (!this.stopping && this.selected.size) {
          const jobs = [...this.selected].map(id => this.stored(id)).filter((job): job is StoredJob => !!job && active.includes(job.status))
          if (!jobs.length) break
          const waitMs = Math.max(1, Math.min(this.options.pollMs ?? 1000, ...jobs.map(job => Math.max(1, job.next_attempt_at - this.now()))))
          await delay(waitMs, undefined, { signal: controller.signal })
        }
      }
    }).catch(error => {
      if (!controller.signal.aborted) {
        const message = `导出执行异常，已暂停所选任务，请重试：${redact(error)}`
        try {
          const pause = this.db.prepare(`UPDATE history_huasheng_export_jobs SET status='needs_attention',
            stage=CASE WHEN dispatched=1 AND task_id IS NULL THEN 'export_uncertain' ELSE stage END,
            message=?,error=?,owner=NULL,host=NULL,pid=NULL,updated_at=?
            WHERE id=? AND status IN (${active.map(() => '?').join(',')}) AND (owner IS NULL OR owner=?)`)
          this.db.transaction(() => {
            for (const id of this.selected) pause.run(message, message, this.timestamp(), id, ...active, this.owner)
          }).immediate()
        } catch (persistError) { this.options.onError?.(persistError) }
        this.options.onError?.(error)
      }
      this.selected.clear()
    }).finally(() => {
      for (const id of this.selected) {
        const job = this.stored(id)
        if (!job || !active.includes(job.status)) this.selected.delete(id)
      }
      this.selectedController = undefined
      this.selectedDrain = null
      this.releaseHeartbeat()
      if (!this.stopping && this.selected.size) this.runSelected([])
    })
    this.keepHeartbeat()
  }
  runPending(jobIds?: number[]): Promise<void> {
    if (jobIds !== undefined && (!Array.isArray(jobIds) || jobIds.some(id => !Number.isSafeInteger(id) || id < 1))) {
      return Promise.reject(new HuashengExportError('导出任务编号无效', 400))
    }
    if (jobIds !== undefined && !jobIds.length) return Promise.resolve()
    if (this.draining) return this.draining
    if (this.stopping) return Promise.resolve()
    const selectedIds = jobIds === undefined ? undefined : [...new Set(jobIds)]
    this.draining = (async () => {
      if (selectedIds === undefined) {
        await this.admitAutomatic()
        await this.repairCompletedPublications()
      }
      const due = this.db.prepare(`SELECT id FROM history_huasheng_export_jobs WHERE status IN (${active.map(() => '?').join(',')})
        AND next_attempt_at<=? ${selectedIds ? `AND id IN (${selectedIds.map(() => '?').join(',')})` : ''}
        ORDER BY EXISTS(SELECT 1 FROM history_production_reservations p
          WHERE p.source_id=history_huasheng_export_jobs.source_id AND p.state='active') DESC,next_attempt_at,id LIMIT 100`)
        .all(...active, this.now(), ...(selectedIds ?? [])) as Array<{ id: number }>
      const worker = async () => {
        while (!this.stopping && due.length) {
          const job = this.claim(due.shift()!.id)
          if (!job) continue
          const controller = new AbortController()
          this.controllers.set(job.id, controller)
          try { await this.tick(job, controller.signal) }
          catch (error) { this.failure(job, error, controller.signal) }
          finally {
            this.controllers.delete(job.id)
            if (!active.includes(this.stored(job.id)?.status ?? '') || this.stored(job.id)?.status === 'waiting_login') {
              getHistoryProductionGate(this.db).release(`export:${job.id}`)
            }
            this.db.prepare('UPDATE history_huasheng_export_jobs SET owner=NULL,host=NULL,pid=NULL WHERE id=? AND owner=?').run(job.id, this.owner)
          }
        }
      }
      const results = await Promise.allSettled(Array.from({ length: Math.min(2, Math.max(1, this.options.concurrency ?? 2)) }, worker))
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })().finally(() => { this.draining = null; this.releaseHeartbeat() })
    this.keepHeartbeat()
    return this.draining
  }
  private wake() { if (this.timer && !this.stopping) void this.runPending().catch(error => this.options.onError?.(error)) }
  start() {
    if (this.timer) return
    this.stopping = false
    this.timer = setInterval(() => this.wake(), this.options.pollMs ?? 1000)
    this.timer.unref(); this.keepHeartbeat()
    this.startupRepair = this.repairCompletedCovers().then(() => {}, error => { this.options.onError?.(error) }).finally(() => { this.startupRepair = null; this.wake() })
  }
  async stop() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.selectedController?.abort(new Error('导出服务停止'))
    this.selected.clear()
    for (const controller of this.controllers.values()) controller.abort(new Error('导出服务停止'))
    await Promise.all([this.draining, this.selectedDrain, this.startupRepair])
    this.releaseHeartbeat()
  }
  async close() { await this.stop(); if (!this.options.database) this.db.close() }
}

let service: HistoryHuashengExportService | undefined
export function getHistoryHuashengExportService() {
  return service ??= new HistoryHuashengExportService({ onError: error => console.error('[history-huasheng-export]', redact(error)) })
}
export function startHistoryHuashengExportWorker(options: { standalone?: boolean } = {}) {
  if (process.env.HISTORY_HUASHENG_EXPORT_WORKER_DISABLED === '1'
    || (process.env.TASK_WORKER_DISABLED === '1' && !options.standalone)) return null
  const worker = getHistoryHuashengExportService(); worker.start(); return worker
}
