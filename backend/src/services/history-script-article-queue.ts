import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { HistoryArticleProvenance } from './history-script-article.js'
import { getHistoryProductionGate } from './history-production-gate.js'

export type HistoryArticleQueueStatus = 'queued' | 'generating' | 'completed' | 'failed'
export interface HistoryArticleGeneration {
  status: HistoryArticleQueueStatus
  message: string
}
export interface HistoryArticleQueueJob extends HistoryArticleGeneration {
  id: number
  sourceId: number
  scriptSha256: string
  videoUrl: string
  videoFingerprint: string
  error: string | null
  createdAt: string
  updatedAt: string
}
interface StoredJob extends HistoryArticleQueueJob {
  provenanceJson: string
  generationRequested: number
  owner: string | null
  host: string | null
  pid: number | null
}
interface ArticleObservation {
  status: 'idle' | 'generating' | 'completed' | 'failed'
  stale: boolean
  error: string | null
  article: { provenance: HistoryArticleProvenance } | null
  activeProvenance?: HistoryArticleProvenance | null
}
export interface HistoryArticleQueueOptions {
  databasePath: string
  root?: string
  pollMs?: number
  articlePollMs?: number
  articleTimeoutMs?: number
  article?: {
    get(id: number): ArticleObservation | Promise<ArticleObservation>
    start(id: number, options: { onlyIfMissing: true; expectedProvenance: HistoryArticleProvenance; allowFailedForNewUpload: true }): ArticleObservation | Promise<ArticleObservation>
  }
  onError?: (error: unknown) => void
}
const columns = `id,source_id AS sourceId,script_sha256 AS scriptSha256,video_url AS videoUrl,
  video_fingerprint AS videoFingerprint,provenance_json AS provenanceJson,status,message,error,
  generation_requested AS generationRequested,owner,host,pid,created_at AS createdAt,updated_at AS updatedAt`

function hasQueue(database: Database.Database) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_script_article_queue'").get())
}

export function ensureHistoryArticleQueueSchema(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS history_script_article_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL, script_sha256 TEXT NOT NULL,
    video_url TEXT NOT NULL, video_fingerprint TEXT NOT NULL, provenance_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','generating','completed','failed')),
    message TEXT NOT NULL, error TEXT, generation_requested INTEGER NOT NULL DEFAULT 0,
    owner TEXT, host TEXT, pid INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(source_id, video_url, video_fingerprint)
  );
  CREATE INDEX IF NOT EXISTS history_script_article_queue_status ON history_script_article_queue(status,id);`)
}

export function historyArticleVideoFingerprint(filename: string) {
  const info = fs.statSync(filename)
  if (!info.isFile() || !info.size) throw new Error('关联成片不可读取')
  return createHash('sha256').update(JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])).digest('hex')
}

export function sameHistoryArticleProvenance(left: HistoryArticleProvenance, right: HistoryArticleProvenance) {
  return (['correctedSha256', 'sourceMetadataSha256', 'rewrittenSha256', 'videoUrl', 'videoFingerprint'] as const)
    .every(key => left[key] === right[key])
}

/** Call on the delivery connection inside its attachment transaction. */
export function enqueueHistoryArticle(database: Database.Database, sourceId: number, provenance: HistoryArticleProvenance) {
  ensureHistoryArticleQueueSchema(database)
  const now = new Date().toISOString()
  database.prepare(`INSERT OR IGNORE INTO history_script_article_queue
    (source_id,script_sha256,video_url,video_fingerprint,provenance_json,status,message,created_at,updated_at)
    VALUES(?,?,?,?,?,'queued','成片已关联，等待生成公众号文章',?,?)`)
    .run(sourceId, provenance.rewrittenSha256, provenance.videoUrl, provenance.videoFingerprint, JSON.stringify(provenance), now, now)
}

export function getHistoryArticleGeneration(database: Database.Database, sourceId: number, videoUrl: string | null): HistoryArticleGeneration | null {
  if (!videoUrl || !hasQueue(database)) return null
  return database.prepare(`SELECT status,message FROM history_script_article_queue
    WHERE source_id=? AND video_url=? ORDER BY id DESC LIMIT 1`).get(sourceId, videoUrl) as HistoryArticleGeneration | undefined ?? null
}

/** An explicit article POST may retry a failed outbox task; polling never does. */
export function markHistoryArticleQueueGenerating(database: Database.Database, sourceId: number, provenance: HistoryArticleProvenance) {
  if (!hasQueue(database)) return
  database.prepare(`UPDATE history_script_article_queue SET status='generating',generation_requested=1,
    message='正在生成公众号文章',error=NULL,updated_at=?
    WHERE source_id=? AND video_url=? AND video_fingerprint=? AND script_sha256=?`)
    .run(new Date().toISOString(), sourceId, provenance.videoUrl, provenance.videoFingerprint, provenance.rewrittenSha256)
}

/** Only durable attachment requests are consumed; existing deliveries are never backfilled. */
export class HistoryArticleQueueService {
  private readonly database: Database.Database
  private readonly owner = randomUUID()
  private readonly gate: ReturnType<typeof getHistoryProductionGate>
  private timer?: ReturnType<typeof setInterval>
  private draining: Promise<void> | null = null
  private stopping = false
  private controller?: AbortController
  private dependencies?: HistoryArticleQueueOptions['article']

  constructor(private readonly options: HistoryArticleQueueOptions) {
    if (options.databasePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(options.databasePath)), { recursive: true })
    this.database = new Database(options.databasePath, { timeout: 5000 })
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = FULL')
    ensureHistoryArticleQueueSchema(this.database)
    this.gate = getHistoryProductionGate(this.database)
  }

  listJobs(sourceId?: number): HistoryArticleQueueJob[] {
    const rows = this.database.prepare(`SELECT ${columns} FROM history_script_article_queue
      ${sourceId === undefined ? '' : 'WHERE source_id=?'} ORDER BY id DESC`).all(...(sourceId === undefined ? [] : [sourceId])) as StoredJob[]
    return rows.map(({ provenanceJson: _provenance, generationRequested: _requested, owner: _owner, host: _host, pid: _pid, ...job }) => job)
  }

  private alive(job: StoredJob) {
    if (!job.owner) return false
    if (job.host !== hostname() || !job.pid) return true
    try { process.kill(job.pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }

  private claim(): StoredJob | undefined {
    let key: string | undefined
    try {
      return this.database.transaction(() => {
        const jobs = this.database.prepare(`SELECT ${columns} FROM history_script_article_queue
          WHERE status IN ('queued','generating') ORDER BY id`).all() as StoredJob[]
        const candidates = jobs.filter(job => !this.alive(job))
          .map(job => ({ job, active: this.gate.isActive(job.sourceId) }))
          .sort((left, right) => Number(right.active) - Number(left.active) || left.job.id - right.job.id)
        for (const { job } of candidates) {
          key = `article-queue:${this.owner}:${job.id}`
          if (!this.gate.tryAcquire(job.sourceId, key)) {
            this.gate.release(key)
            key = undefined
            continue
          }
          this.database.prepare(`UPDATE history_script_article_queue SET owner=?,host=?,pid=?,status='generating',
            message='正在生成公众号文章',updated_at=? WHERE id=?`)
            .run(this.owner, hostname(), process.pid, new Date().toISOString(), job.id)
          return job
        }
        return undefined
      }).immediate()
    } catch (error) {
      if (key) this.gate.release(key)
      throw error
    }
  }

  private save(job: StoredJob, status: HistoryArticleQueueStatus, message: string, error: string | null = null) {
    const result = this.database.prepare(`UPDATE history_script_article_queue SET status=?,message=?,error=?,updated_at=? WHERE id=? AND owner=?`)
      .run(status, message, error, new Date().toISOString(), job.id, this.owner)
    if (!result.changes) throw new Error('文章待办执行权已失效')
  }

  private requested(job: StoredJob) {
    const result = this.database.prepare(`UPDATE history_script_article_queue SET generation_requested=1,updated_at=? WHERE id=? AND owner=?`)
      .run(new Date().toISOString(), job.id, this.owner)
    if (!result.changes) throw new Error('文章待办执行权已失效')
    job.generationRequested = 1
  }

  private async article() {
    if (!this.dependencies) {
      const { getHistoryArticle, startHistoryArticle } = await import('./history-script-article.js')
      this.dependencies = {
        get: id => getHistoryArticle(id, { root: this.options.root }),
        start: (id, options) => startHistoryArticle(id, {}, { root: this.options.root, ...options }),
      }
    }
    return this.dependencies
  }

  private async generate(job: StoredJob, signal: AbortSignal) {
    const article = this.options.article ?? await this.article()
    const provenance = JSON.parse(job.provenanceJson) as HistoryArticleProvenance
    signal.throwIfAborted()
    let state = await article.get(job.sourceId)
    signal.throwIfAborted()
    const until = Date.now() + (this.options.articleTimeoutMs ?? 12 * 60_000)
    const observeNext = async () => {
      signal.throwIfAborted()
      if (Date.now() >= until) throw new Error('等待文章生成超时，请核对结果后明确重试')
      await delay(this.options.articlePollMs ?? 1000, undefined, { signal })
      return article.get(job.sourceId)
    }
    // An unrelated (or legacy unknown) run must not consume this upload's authorization.
    while (state.status === 'generating' && (!state.activeProvenance || !sameHistoryArticleProvenance(state.activeProvenance, provenance))) {
      state = await observeNext()
    }
    signal.throwIfAborted()
    if (state.status !== 'generating' && (state.status !== 'failed' || job.generationRequested === 0) && !(state.status === 'completed' && !state.stale)) {
      // Persist intent before a potentially billable call. An interrupted start is never replayed.
      if (job.generationRequested) throw new Error('文章启动结果不确定，请在公众号文章中明确重试')
      this.requested(job)
      state = await article.start(job.sourceId, { onlyIfMissing: true, expectedProvenance: provenance, allowFailedForNewUpload: true })
    } else if (state.status === 'generating') this.requested(job)
    while (state.status === 'generating') {
      state = await observeNext()
    }
    signal.throwIfAborted()
    if (state.status === 'failed') throw new Error(state.error || '文章生成失败，请在公众号文章中重试')
    if (state.status !== 'completed' || state.stale || !state.article || !sameHistoryArticleProvenance(state.article.provenance, provenance)) {
      throw new Error('文章或成片版本已变化，未确认本次文章完成，请核对后明确重试')
    }
    this.save(job, 'completed', '公众号文章已生成')
  }

  runPending(): Promise<void> {
    if (this.draining) return this.draining
    if (this.stopping) return Promise.resolve()
    const controller = new AbortController()
    this.controller = controller
    this.draining = (async () => {
      while (!this.stopping) {
        const job = this.claim()
        if (!job) return
        try { await this.generate(job, controller.signal) }
        catch (error) {
          if (!controller.signal.aborted) {
            const message = error instanceof Error ? error.message.slice(0, 2000) : '文章生成失败，请明确重试'
            this.save(job, 'failed', message, message)
          }
        } finally {
          try { this.database.prepare('UPDATE history_script_article_queue SET owner=NULL,host=NULL,pid=NULL WHERE id=? AND owner=?').run(job.id, this.owner) }
          finally { this.gate.release(`article-queue:${this.owner}:${job.id}`) }
        }
      }
    })().finally(() => { this.draining = null; this.controller = undefined })
    return this.draining
  }

  start() {
    if (this.timer) return
    this.stopping = false
    const wake = () => { void this.runPending().catch(error => this.options.onError?.(error)) }
    this.timer = setInterval(wake, this.options.pollMs ?? 1000)
    this.timer.unref()
    wake()
  }

  async stop() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.controller?.abort(new Error('文章待办监测已停止'))
    await this.draining
  }

  async close() { await this.stop(); this.database.close() }
}

let service: HistoryArticleQueueService | undefined
export function getHistoryArticleQueueService() {
  service ??= new HistoryArticleQueueService({
    databasePath: process.env.DB_PATH || fileURLToPath(new URL('../../../data/huobao_drama.db', import.meta.url)),
    onError: error => console.error('[history-article-queue]', error instanceof Error ? error.message : 'worker failed'),
  })
  return service
}

export function startHistoryArticleWorker() {
  if (process.env.TASK_WORKER_DISABLED === '1' || process.env.HISTORY_ARTICLE_WORKER_DISABLED === '1') return null
  const worker = getHistoryArticleQueueService()
  worker.start()
  return worker
}

export async function stopHistoryArticleWorker() { await service?.stop() }
