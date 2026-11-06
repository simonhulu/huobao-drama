import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import sharp from 'sharp'
import { z } from 'zod'
import type { HistoryArticleResult } from './history-script-article.js'
import type { SocialTarget, SocialUploadPayload, SocialUploadResult, SocialUploadRuntime, SocialUploadProgress, SocialUploadProgressOptions, SocialUploadCheckpoint } from './social-auto-upload.js'
import { LEGACY_HISTORY_SOCIAL_TARGETS } from './history-social-targets.js'
import { currentHistoryVideoDeliveries, legacyHistoryVideoPublication, type HistoryVideoProducer } from './history-video-deliveries.js'
import { getHistoryVideoPackagingRow } from './history-video-packaging.js'
import { getHistoryProductionState, getHistoryProductionStates, getHistoryPublicationRevision, isHistorySubmissionReceipt, type HistoryProductionSource } from './history-production-state.js'

export type { SocialTarget, SocialUploadPayload, SocialUploadResult } from './social-auto-upload.js'
export { HISTORY_SOCIAL_TARGETS } from './history-social-targets.js'
export type HistorySocialMode = 'stage' | 'draft' | 'publish'
export const historySocialUploadInputSchema = z.object({
  sourceIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(100),
  targets: z.array(z.enum(LEGACY_HISTORY_SOCIAL_TARGETS)).min(1).max(3),
  mode: z.enum(['stage', 'draft', 'publish']).default('publish'),
  videoIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(200).optional(),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
}).strict().refine(value => value.mode !== 'publish' || value.targets.every(target => target === 'baijiahao-video'),
  { message: '历史视频发表仅支持百家号视频', path: ['targets'] })
export type HistorySocialUploadInput = z.input<typeof historySocialUploadInputSchema>
export const historySocialMarkUploadedSchema = z.object({
  sourceIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(100),
  targets: z.array(z.enum(LEGACY_HISTORY_SOCIAL_TARGETS)).min(1).max(3),
}).strict()
export interface HistorySocialUploaded { status: 'saved' | 'submitted' | 'published'; confirmedAt: string; confirmation: 'platform' | 'manual' }
export type HistorySocialUploads = Partial<Record<SocialTarget, HistorySocialUploaded>>
export type HistorySocialUploadStatus = 'blocked' | 'queued' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'uncertain' | 'canceled'
export interface HistorySocialBlocker { code: string; field: string; message: string }
export interface HistorySocialSource {
  id: number; title: string; rewrittenScript: string | null; artifactState: 'current' | 'stale' | 'missing'; deletedAt?: string | null
  delivery: {
    title: string; baijiahaoTitle: string; description: string; videoUrl: string | null
    scriptSha256: string | null; coverScriptSha256: string | null; coverStatus: string; covers: Record<string, string>
    scriptChanged?: boolean; coversChanged?: boolean
  } | null
}
export interface HistorySocialRuntime {
  inspectSocialUploadRuntime(refresh?: boolean): Promise<SocialUploadRuntime>
  inspectHistorySocialUploadRuntime?(refresh?: boolean): Promise<SocialUploadRuntime>
  syncHistorySocialUploadLogin?(platform: 'baijiahao' | 'tencent'): Promise<{ synced: true; platform: 'baijiahao' | 'tencent'; message: string }>
  runSocialUpload(payload: SocialUploadPayload, options: SocialUploadProgressOptions & { saveDraft: boolean }): Promise<SocialUploadResult>
  confirmSocialUpload(payload: SocialUploadPayload, result: SocialUploadResult, options?: SocialUploadProgressOptions): Promise<SocialUploadResult>
  inspectSocialUploadCheckpoint?(payload: SocialUploadPayload): Promise<SocialUploadCheckpoint>
  resumeSocialUpload?(payload: SocialUploadPayload, options?: SocialUploadProgressOptions): Promise<SocialUploadResult>
  reconcileSocialUpload?(payload: SocialUploadPayload, result: SocialUploadResult, options?: SocialUploadProgressOptions): Promise<SocialUploadResult>
  refreshSocialPublication?(payload: SocialUploadPayload, result: SocialUploadResult): Promise<SocialUploadResult>
  closeFailedSocialUpload?(payload: SocialUploadPayload): Promise<{ result?: SocialUploadResult }>
  resetSocialUploadAttempt?(payload: SocialUploadPayload): Promise<{ result?: SocialUploadResult }>
  openSocialUploadLogin?(platform: 'baijiahao' | 'tencent'): Promise<{ opened: true; message?: string }>
  focusSocialUpload?(payload: SocialUploadPayload, result: SocialUploadResult): Promise<{ opened: true }>
}
export interface HistorySocialPreflightItem {
  sourceId: number; sourceTitle: string; target: SocialTarget; mode: HistorySocialMode; engine: string
  videoId?: number | null; videoProducer?: HistoryVideoProducer | 'legacy'
  ready: boolean; blockers: HistorySocialBlocker[]; warnings?: string[]; fingerprint: string; uploaded?: HistorySocialUploaded
}
export interface HistorySocialUploadJob {
  id: string; sourceId: number; sourceTitle: string; target: SocialTarget; mode: HistorySocialMode
  videoId: number | null; videoProducer: HistoryVideoProducer | 'legacy'
  status: HistorySocialUploadStatus; message: string; error: string | null; blockers: HistorySocialBlocker[]
  fingerprint: string; engine: string; result: SocialUploadResult | null; createdAt: string; updatedAt: string; reused?: boolean
  operation: string | null; progress: SocialUploadProgress | null
  publicationAttempted?: boolean
  recovery: { attempts: number; maxAttempts: number; nextAttemptAt: string | null; action: string | null }
}
export interface HistorySocialUploadOptions {
  databasePath?: string; database?: Database.Database; root?: string; runtime?: HistorySocialRuntime
  loadSource?: (id: number) => HistorySocialSource | null | Promise<HistorySocialSource | null>
  ensurePackaging?: typeof import('./history-delivery-automation.js').ensureHistoryDeliveryAutomation
  getArticle?: (id: number) => Pick<HistoryArticleResult, 'status' | 'stale' | 'article'> | Promise<Pick<HistoryArticleResult, 'status' | 'stale' | 'article'>>
  /** Single-task moderation tools must not recover unrelated jobs at construction. */
  recoverOnStartup?: boolean
  now?: () => number; pollMs?: number; heartbeatMs?: number; leaseMs?: number; onError?: (error: unknown) => void
}
interface StoredJob {
  id: number; source_id: number; source_title: string; target: SocialTarget; mode: 'stage' | 'draft'
  status: HistorySocialUploadStatus; message: string; error: string | null; blockers_json: string; fingerprint: string
  engine: string; payload_json: string | null; result_json: string | null; created_at: string; updated_at: string
  owner: string | null; host: string | null; pid: number | null; lease_until: number | null; operation: string | null
  recovery_attempts: number; next_attempt_at: number | null; recovery_action: string | null; progress_json: string | null
  save_authorized: number; upload_dispatched: number
  publication_mode: 'draft' | 'publish'; video_id: number | null; video_producer: HistoryVideoProducer | 'legacy' | null
}
interface Asset { url: string; path: string; stamp: unknown }
interface Prepared { item: HistorySocialPreflightItem; payload: SocialUploadPayload }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textHash = (value: string) => createHash('sha256').update(value).digest('hex')
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000)
const articleCoverManifestSchema = z.object({
  version: z.literal(1),
  images: z.array(z.object({ url: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).length(2),
})

async function articleImagesPrepared(html: string, images: Array<{ url: string; path: string }>, imageHashes: Map<string, string>, mainHash?: string) {
  if (!images.length || !mainHash) return false
  try {
    const directory = path.dirname(images[0]!.path)
    if (images.some(image => path.dirname(image.path) !== directory)) return false
    const filename = path.join(directory, 'body-cover-selection.json')
    if ((await fs.promises.lstat(filename)).isSymbolicLink()) return false
    const manifest = articleCoverManifestSchema.parse(JSON.parse(await fs.promises.readFile(filename, 'utf8')))
    // Article generation chooses the images. Upload only checks that its saved
    // selection still refers to the same files actually embedded in the body.
    const body = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    const bodyUrls = new Set(Array.from(body.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi),
      match => match[1] ?? match[2] ?? match[3]))
    return new Set(manifest.images.map(image => image.url)).size === 2
      && new Set(manifest.images.map(image => image.sha256)).size === 2
      && manifest.images.every(image => bodyUrls.has(image.url) && imageHashes.get(image.url) === image.sha256 && image.sha256 !== mainHash)
  } catch { return false }
}

const defaultRoot = process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url))
export class HistorySocialUploadError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 500 | 503 = 409) { super(message) }
}

export function ensureHistorySocialUploadSchema(database: Database.Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS history_social_upload_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL, source_title TEXT NOT NULL,
    target TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('stage','draft')),
    status TEXT NOT NULL CHECK(status IN ('blocked','queued','running','awaiting_confirmation','completed','failed','uncertain','canceled')),
    message TEXT NOT NULL, error TEXT, blockers_json TEXT NOT NULL, fingerprint TEXT NOT NULL, engine TEXT NOT NULL,
    payload_json TEXT, result_json TEXT, owner TEXT, host TEXT, pid INTEGER, lease_until INTEGER, operation TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS history_social_upload_one_running ON history_social_upload_jobs((1)) WHERE status='running';
  CREATE UNIQUE INDEX IF NOT EXISTS history_social_upload_snapshot ON history_social_upload_jobs(source_id,target,fingerprint) WHERE status<>'canceled';
  CREATE INDEX IF NOT EXISTS history_social_upload_status ON history_social_upload_jobs(status,id);
  CREATE TABLE IF NOT EXISTS history_social_upload_requests (
    request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, preflight_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history_social_upload_request_jobs (
    request_id TEXT NOT NULL, job_id INTEGER NOT NULL, reused INTEGER NOT NULL, PRIMARY KEY(request_id,job_id)
  );
  CREATE TABLE IF NOT EXISTS history_social_upload_confirmations (
    source_id INTEGER NOT NULL, target TEXT NOT NULL, confirmed_at TEXT NOT NULL,
    PRIMARY KEY(source_id,target)
  );
  CREATE TABLE IF NOT EXISTS history_social_publication_checks (
    job_id INTEGER PRIMARY KEY, next_check_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT, last_error TEXT, owner TEXT, lease_until INTEGER
  );`)
  const columns = new Set((database.pragma('table_info(history_social_upload_jobs)') as Array<{ name: string }>).map(column => column.name))
  for (const [column, definition] of Object.entries({ recovery_attempts: 'INTEGER NOT NULL DEFAULT 0', next_attempt_at: 'INTEGER', recovery_action: 'TEXT', progress_json: 'TEXT', save_authorized: 'INTEGER NOT NULL DEFAULT 0', upload_dispatched: 'INTEGER NOT NULL DEFAULT 0',
    publication_mode: "TEXT NOT NULL DEFAULT 'draft'", video_id: 'INTEGER', video_producer: 'TEXT' })) {
    if (!columns.has(column)) database.exec(`ALTER TABLE history_social_upload_jobs ADD COLUMN ${column} ${definition}`)
  }
  if (!columns.has('upload_dispatched')) database.prepare(`UPDATE history_social_upload_jobs SET upload_dispatched=1
    WHERE operation IS NOT NULL AND status IN ('running','uncertain','awaiting_confirmation','completed')`).run()
}

function effectiveMode(row: StoredJob): HistorySocialMode { return row.publication_mode === 'publish' ? 'publish' : row.mode }
function publicationAttempted(row: StoredJob) {
  return row.publication_mode==='publish' && !!(row.upload_dispatched || row.result_json || row.operation==='recover'
    || ['uncertain','completed'].includes(row.status))
}
function publicationReceipt(row: StoredJob) {
  try {return isHistorySubmissionReceipt(JSON.parse(row.result_json || 'null'))}
  catch {return false}
}
function publicJob(row: StoredJob): HistorySocialUploadJob {
  return { id: String(row.id), sourceId: row.source_id, sourceTitle: row.source_title, target: row.target, mode: effectiveMode(row),
    videoId: row.video_id ?? null, videoProducer: row.video_producer || 'legacy',
    status: row.status, message: row.message, error: row.error, blockers: JSON.parse(row.blockers_json), fingerprint: row.fingerprint,
    engine: row.engine, result: row.result_json ? JSON.parse(row.result_json) : null, createdAt: row.created_at, updatedAt: row.updated_at,
    operation: row.operation, progress: row.progress_json ? JSON.parse(row.progress_json) : null,
    publicationAttempted: publicationAttempted(row),
    // Retain the response shape for older clients; automatic recovery is disabled.
    recovery: { attempts: 0, maxAttempts: 0, nextAttemptAt: null, action: null } }
}

export class HistorySocialUploadService {
  private readonly database: Database.Database
  private readonly owner = randomUUID()
  private readonly root: string
  private timer?: ReturnType<typeof setInterval>
  private draining: Promise<void> | null = null
  private publicationChecks: Promise<void> | null = null
  private readonly activePublicationRefreshes = new Set<Promise<HistorySocialUploadJob>>()
  private nextPublicationCheckAt = 0
  private stopping = false
  private runtimeCache?: { at: number; value: SocialUploadRuntime }
  private runtimePending?: Promise<SocialUploadRuntime>
  private syncPending?: Promise<{ synced: true; platform: 'baijiahao' | 'tencent'; message: string }>

  constructor(private readonly options: HistorySocialUploadOptions = {}) {
    const filename = options.databasePath || process.env.DB_PATH || fileURLToPath(new URL('../../../data/huobao_drama.db', import.meta.url))
    if (!options.database && filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
    this.database = options.database ?? new Database(filename, { timeout: 5000 })
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('synchronous = FULL')
    this.root = path.resolve(options.root || defaultRoot)
    ensureHistorySocialUploadSchema(this.database)
    if (options.recoverOnStartup !== false) this.recoverInterrupted()
  }
  private now() { return (this.options.now ?? Date.now)() }
  private timestamp() { return new Date(this.now()).toISOString() }
  private async runtime(): Promise<HistorySocialRuntime> { return this.options.runtime ?? await import('./social-auto-upload.js') }

  async inspectRuntime(refresh = false): Promise<SocialUploadRuntime> {
    if (this.syncPending) await this.syncPending.catch(() => {})
    if (!refresh && this.runtimeCache && this.now() - this.runtimeCache.at < 15_000) return this.runtimeCache.value
    this.runtimePending ??= (async () => {
      try {
        const runtime = await this.runtime()
        const value = await (runtime.inspectHistorySocialUploadRuntime ?? runtime.inspectSocialUploadRuntime)(refresh)
        if (typeof value?.installed !== 'boolean' || !value.platforms?.baijiahao || !value.platforms?.tencent) throw new Error('上传运行环境响应不完整')
        return value
      } catch (error) {
        const message = errorText(error)
        return { installed: false, message, version: null, platforms: { baijiahao: { ready: false, message }, tencent: { ready: false, message } } }
      }
    })().then(value => { this.runtimeCache = { at: this.now(), value }; return value }).finally(() => { this.runtimePending = undefined })
    return this.runtimePending
  }
  async openLogin(platform: 'baijiahao' | 'tencent') {
    const runtime = await this.runtime()
    if (!runtime.openSocialUploadLogin) throw new HistorySocialUploadError('当前上传运行环境不支持打开登录窗口', 503)
    this.runtimeCache = undefined
    try { return await runtime.openSocialUploadLogin(platform) }
    catch (error) { throw new HistorySocialUploadError(errorText(error), 503) }
  }
  syncLogin(platform: 'baijiahao' | 'tencent') {
    if (this.syncPending) throw new HistorySocialUploadError('正在同步登录，请等待本次完成')
    if (this.database.prepare("SELECT 1 FROM history_social_upload_jobs WHERE status='running' LIMIT 1").get()
      || this.database.prepare('SELECT 1 FROM history_social_publication_checks WHERE owner IS NOT NULL AND lease_until>? LIMIT 1').get(this.now())) {
      throw new HistorySocialUploadError('上传正在执行，完成后再同步登录；当前上传会继续')
    }
    this.syncPending = (async () => {
      const runtime = await this.runtime()
      if (!runtime.syncHistorySocialUploadLogin) throw new HistorySocialUploadError('当前上传运行环境尚不支持后台登录同步', 503)
      await this.runtimePending
      try { return await runtime.syncHistorySocialUploadLogin(platform) }
      catch (error) { throw new HistorySocialUploadError(errorText(error), 503) }
    })().finally(() => { this.runtimeCache = undefined; this.syncPending = undefined; this.wake() })
    return this.syncPending
  }
  private async runtimeForJob(job: StoredJob, refresh = false) {
    const payload = job.payload_json ? JSON.parse(job.payload_json) as SocialUploadPayload : undefined
    if ((job.mode === 'stage' || job.upload_dispatched || job.result_json) && !payload?.accountName) {
      return (await this.runtime()).inspectSocialUploadRuntime(true)
    }
    return this.inspectRuntime(refresh)
  }
  private async runtimeForMode(mode: HistorySocialMode, refresh = false) {
    // An explicitly requested visual preview keeps its visible editor. Normal
    // draft production uses the persistent background account session.
    return mode === 'stage' ? (await this.runtime()).inspectSocialUploadRuntime(refresh) : this.inspectRuntime(refresh)
  }
  async productionState(sourceId: number) {
    const source = await this.source(sourceId)
    if (!source || source.deletedAt) throw new HistorySocialUploadError('稿件不存在或已删除', 404)
    return getHistoryProductionState(this.database, source, { root: this.root })
  }
  candidates(sourceIds?: number[]) {
    if (sourceIds !== undefined && (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 100
      || sourceIds.some(id => !Number.isSafeInteger(id) || id < 1))) {
      throw new HistorySocialUploadError('请提供1至100个有效稿件编号', 400)
    }
    const selectedIds = sourceIds === undefined ? undefined : [...new Set(sourceIds)]
    const tables = new Set((this.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row => row.name))
    if (!tables.has('history_script_sources')) return []
    const associations = [
      ['history_dual_production', 'source_id', ''],
      ['history_video_deliveries', 'script_id', ''],
      ['history_huasheng_jobs', 'source_id', ''],
      ['history_motion_productions', 'script_id', ''],
      ['history_script_deliveries', 'script_id', "AND length(trim(a.video_path))>0"],
    ].filter(([table]) => tables.has(table!))
      .map(([table, owner, condition]) => `EXISTS (SELECT 1 FROM ${table} a WHERE a.${owner}=s.id ${condition})`)
    if (!associations.length) return []
    const columns = new Set((this.database.pragma('table_info(history_script_sources)') as Array<{name:string}>).map(column => column.name))
    const selectedColumns = ['id', 'title', 'rewritten_script', 'deleted_at', 'platform', 'source_video_id', 'source_url',
      'raw_transcript', 'corrected_transcript', 'media_json', 'asr_json', 'review_json'].filter(column => columns.has(column))
    const rows = this.database.prepare(`SELECT ${selectedColumns.map(column => `s.${column}`).join(',')} FROM history_script_sources s
      WHERE ${columns.has('deleted_at') ? 's.deleted_at IS NULL AND' : ''}
      ${selectedIds ? `s.id IN (${selectedIds.map(() => '?').join(',')}) AND` : ''}
      (${associations.join(' OR ')}) ORDER BY s.id DESC`).all(...(selectedIds ?? [])) as Array<Record<string, any>>
    const sources: HistoryProductionSource[] = rows.map(row => ({id: row.id, title: row.title, rewrittenScript: row.rewritten_script || null,
      deletedAt: row.deleted_at,
      ...(columns.has('media_json') && columns.has('review_json') ? {provenance: {
        platform: row.platform, sourceVideoId: row.source_video_id, sourceUrl: row.source_url,
        rawTranscript: row.raw_transcript, correctedTranscript: row.corrected_transcript, rewrittenScript: row.rewritten_script,
        mediaJson: row.media_json, asrJson: row.asr_json, reviewJson: row.review_json,
      }} : {}),
    }))
    const states = getHistoryProductionStates(this.database, sources, {root: this.root})
    return states.filter(state => state.versions.length > 0).map(state => {
      const uploads: HistorySocialUploads = {}
      if (state.complete) uploads['baijiahao-video'] = {
        status: state.versions.every(version => version.state === 'published') ? 'published' : 'submitted',
        confirmedAt: state.versions.map(version => version.confirmedAt!).sort().at(-1)!, confirmation: 'platform',
      }
      return {scriptId: state.scriptId, title: sources.find(source => source.id === state.scriptId)!.title, uploads, versions: state.versions}
    })
  }
  uploads(sourceId: number): HistorySocialUploads {
    const uploads: HistorySocialUploads = {}
    const manual = this.database.prepare('SELECT target,confirmed_at FROM history_social_upload_confirmations WHERE source_id=?').all(sourceId) as Array<{ target: SocialTarget; confirmed_at: string }>
    for (const row of manual) uploads[row.target] = { status: 'saved', confirmedAt: row.confirmed_at, confirmation: 'manual' }
    const saved = this.database.prepare(`SELECT target,updated_at,publication_mode,result_json FROM history_social_upload_jobs
      WHERE source_id=? AND status='completed' AND (json_extract(result_json,'$.saved')=1 OR json_extract(result_json,'$.submitted')=1) ORDER BY id`).all(sourceId) as Array<{ target: SocialTarget; updated_at: string; publication_mode: string; result_json: string }>
    for (const row of saved) {
      const result = JSON.parse(row.result_json) as SocialUploadResult
      uploads[row.target] = { status: result.published ? 'published' : result.submitted ? 'submitted' : 'saved', confirmedAt: row.updated_at, confirmation: 'platform' }
    }
    return uploads
  }
  async markUploaded(input: z.input<typeof historySocialMarkUploadedSchema>) {
    const parsed = historySocialMarkUploadedSchema.parse(input)
    const sources = await Promise.all([...new Set(parsed.sourceIds)].map(id => this.source(id)))
    if (sources.some(source => !source || source.deletedAt)) throw new HistorySocialUploadError('项目不存在或已删除', 404)
    const targets = [...new Set(parsed.targets)]
    const marked = this.database.transaction(() => {
      // Keep an in-flight platform save intact. This transaction also prevents
      // the worker from claiming a queued job while its marker is being saved.
      for (const source of sources) for (const target of targets) {
        if (this.database.prepare("SELECT 1 FROM history_social_upload_jobs WHERE source_id=? AND target=? AND status='running'").get(source!.id, target)) {
          throw new HistorySocialUploadError(`稿件 #${source!.id} 正在上传，请任务结束后再标记`)
        }
      }
      let count = 0
      for (const source of sources) for (const target of targets) {
        if (!this.uploads(source!.id)[target]) count += this.database.prepare('INSERT OR IGNORE INTO history_social_upload_confirmations VALUES(?,?,?)').run(source!.id, target, this.timestamp()).changes
        // Preserve original receipts/checkpoints, but stop obsolete retries.
        this.database.prepare(`UPDATE history_social_upload_jobs SET status='canceled',message='用户已确认该平台已上传，无需重复上传',
          error=NULL,blockers_json='[]',recovery_action=NULL,next_attempt_at=NULL,updated_at=?
          WHERE source_id=? AND target=? AND publication_mode='draft' AND video_id IS NULL
          AND status NOT IN ('completed','canceled','running')`).run(this.timestamp(), source!.id, target)
      }
      return count
    }).immediate()
    return { marked, items: sources.map(source => ({ scriptId: source!.id, title: source!.title, uploads: this.uploads(source!.id) })), message: '已标记为人工确认已上传，后续上传会自动跳过' }
  }
  private async source(id: number): Promise<HistorySocialSource | null> {
    if (this.options.loadSource) return this.options.loadSource(id)
    const { getHistorySource, getHistorySourceArtifactState } = await import('./history-script-library.js')
    const source = getHistorySource(id)
    if (!source) return null
    const delivery = this.database.prepare('SELECT * FROM history_script_deliveries WHERE script_id=?').get(id) as Record<string, any> | undefined
    const stale = getHistorySourceArtifactState(source).rewritten !== 'current'
    const scriptHash = textHash(source.rewrittenScript || '')
    return { id: source.id, title: source.title, rewrittenScript: source.rewrittenScript,
      artifactState: getHistorySourceArtifactState(source).rewritten, deletedAt: source.deletedAt,
      delivery: delivery ? { title: delivery.title, baijiahaoTitle: delivery.baijiahao_title, description: delivery.description,
        videoUrl: delivery.video_path, scriptSha256: delivery.script_sha256, coverScriptSha256: delivery.cover_script_sha256,
        coverStatus: delivery.cover_status, covers: JSON.parse(delivery.covers_json),
        scriptChanged: Boolean(delivery.script_sha256 && (stale || delivery.script_sha256 !== scriptHash)),
        coversChanged: Boolean(delivery.cover_script_sha256 && (stale || delivery.cover_script_sha256 !== scriptHash || delivery.cover_status === 'idle')) } : null }
  }
  private async asset(value: unknown, field: string, image: boolean, blockers: HistorySocialBlocker[], directory: string): Promise<Asset | null> {
    const labels: Record<string, string> = { video: '关联成片', 'covers.16:9': '16:9 横版封面', 'covers.4:3': '4:3 横版封面', 'covers.3:4': '3:4 竖版封面' }
    const label = labels[field] ?? (field.startsWith('article.screenshots.') ? `文章配图 ${Number(field.split('.').at(-1)) + 1}` : field)
    const fail = (code: string, message: string) => { blockers.push({ code, field, message: `${label}：${message}` }); return null }
    if (typeof value !== 'string' || !value) return fail('asset_missing', '缺少本地素材')
    if (!/^\/?static\//.test(value) || /[\\%?#\0]/.test(value)) return fail('asset_unsafe', '仅允许 static 目录内的本地素材')
    const relative = value.replace(/^\/?static\//, '')
    if (relative.split('/').some(part => !part || part === '.' || part === '..')) return fail('asset_unsafe', '素材路径不安全')
    if (!relative.startsWith(`${directory}/`)) return fail('asset_ownership', '素材不属于当前项目')
    try {
      const root = fs.realpathSync(this.root)
      const filename = fs.realpathSync(path.resolve(this.root, relative))
      const confined = path.relative(root, filename)
      if (!confined || confined.startsWith(`..${path.sep}`) || confined === '..' || path.isAbsolute(confined)
        || filename !== path.join(root, relative)) return fail('asset_unsafe', '素材超出当前项目目录或通过符号链接引用')
      fs.accessSync(filename, fs.constants.R_OK)
      const stat = fs.statSync(filename)
      if (!stat.isFile() || stat.size <= 0) return fail('asset_invalid', '文件不存在、为空或不可读取')
      if (image) {
        const metadata = await sharp(filename).metadata()
        if (!metadata.width || !metadata.height) return fail('asset_invalid', '不是可读取的图片')
      }
      return { url: `/static/${relative}`, path: filename, stamp: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs] }
    } catch { return fail('asset_unreadable', image ? '图片不存在、损坏或不可读取' : '文件不存在或不可读取') }
  }
  private async prepare(sourceId: number, target: SocialTarget, mode: HistorySocialMode, runtime?: SocialUploadRuntime, forQueue = false, videoId: number | null = null): Promise<Prepared> {
    const blockers: HistorySocialBlocker[] = []
    const warnings: string[] = []
    const add = (code: string, field: string, message: string) => blockers.push({ code, field, message })
    if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_artifacts'").get()) {
      try {
        const {restoreArchivedArtifacts}=await import('./storage-archive.js')
        const restored=await restoreArchivedArtifacts(this.database,'history-source',String(sourceId),{dataRoot:path.dirname(this.root)})
        if (restored.errors.length) add('archive_unavailable','video','归档素材恢复失败，请在磁盘管理中检查备份后重试')
      } catch {add('archive_unavailable','video','归档素材恢复失败，请在磁盘管理中检查备份后重试')}
    }
    let source: HistorySocialSource | null = null
    try { source = await this.source(sourceId) } catch { add('source_unreadable', 'source', '项目资料无法读取') }
    if (!source || source.deletedAt) add('source_missing', 'source', '历史项目不存在或已删除')
    const script = source?.rewrittenScript || ''
    const selectedVideo = videoId === null ? null : currentHistoryVideoDeliveries(this.database, sourceId, textHash(script)).find(video => video.id === videoId)
    if (mode === 'publish' && selectedVideo) {
      const legacy = legacyHistoryVideoPublication(this.database, selectedVideo, this.root)
      const previous = (this.database.prepare(`SELECT * FROM history_social_upload_jobs
        WHERE source_id=? AND video_id=? AND target='baijiahao-video' AND publication_mode='publish'
        AND status='completed' ORDER BY id DESC`).all(sourceId, selectedVideo.id) as StoredJob[])
        .find(publicationReceipt) ?? (legacy ? this.stored(legacy.id) : undefined)
      if (previous?.status === 'completed' && publicationReceipt(previous)) {
        const result = JSON.parse(previous.result_json!) as SocialUploadResult
        return { item: { sourceId, sourceTitle: source!.title, target, mode, videoId: selectedVideo.id,
          videoProducer: selectedVideo.producer, engine: previous.engine, fingerprint: previous.fingerprint, ready: false, blockers: [],
          uploaded: { status: result.published ? 'published' : 'submitted', confirmedAt: previous.updated_at, confirmation: 'platform' } },
          payload: { jobId: '', scriptId: sourceId, target, title: '', description: '', fingerprint: previous.fingerprint } }
      }
      if (legacy) add('existing_publication_unresolved', 'video', `本片已有原发表任务 #${legacy.id}，请先核对原任务`)
      const revision = getHistoryPublicationRevision(this.database, sourceId, selectedVideo.id, { root: this.root })
      if (revision?.blocked) add('original_publication_unresolved', 'video', `原成片发表任务 #${revision.jobId} 尚未结束或结果待核对，请先处理原任务`)
      else if (revision) warnings.push(`本次为修订成片，原成片已有提交回执 #${revision.jobId}；确认后将再次发表`)
    }
    let delivery = videoId === null ? source?.delivery : null
    if (selectedVideo) {
      const packaging = getHistoryVideoPackagingRow(this.database, sourceId, selectedVideo.id)
      if (!packaging) add('video_packaging_missing', 'delivery', '本版成片的标题和封面尚未准备完成')
      else if (packaging.script_sha256 !== selectedVideo.scriptSha256) add('video_packaging_stale', 'delivery', '本版成片的标题和封面不属于当前稿件版本')
      else delivery = { title: packaging.title, baijiahaoTitle: packaging.baijiahao_title, description: packaging.description,
        videoUrl: selectedVideo.videoUrl, scriptSha256: packaging.script_sha256, coverScriptSha256: packaging.cover_script_sha256,
        coverStatus: packaging.cover_status, covers: JSON.parse(packaging.covers_json),
        coversChanged: packaging.cover_status !== 'completed' }
    }
    if (videoId !== null && !selectedVideo) add('video_not_current', 'video', '指定成片不属于当前稿件版本或已被新版本替代')
    if (source && (!script.trim() || source.artifactState !== 'current')) add('script_stale', 'script', '请先保存版本有效的当前二创稿')
    if (!delivery) add('delivery_missing', 'delivery', '项目尚未准备成片与封面')
    if (delivery && !selectedVideo && (delivery.scriptChanged || delivery.scriptSha256 !== textHash(script))) add('video_stale', 'video', '关联成片与当前脚本版本不一致，请重新关联')
    if (delivery && ((!selectedVideo && delivery.scriptChanged) || delivery.coverScriptSha256 !== textHash(script) ||
      !(videoId === null ? ['completed', 'idle'] : ['completed']).includes(delivery.coverStatus) || (delivery.coversChanged && delivery.coverStatus !== 'idle'))) {
      add('covers_stale', 'covers', '封面尚未生成完成或与当前脚本版本不一致')
    } else if (delivery?.coverStatus === 'idle') {
      warnings.push('封面方案已修改，本次沿用已有封面图片；如需采用新方案，请先重新生成封面')
    }
    const assets: Asset[] = []
    const take = async (value: unknown, field: string, image = false) => {
      const asset = await this.asset(value, field, image, blockers, `${field.startsWith('article.screenshots.') ? 'history-articles' : 'history-deliveries'}/${sourceId}`)
      if (asset) assets.push(asset)
      return asset
    }
    const video = await take(selectedVideo?.videoUrl ?? delivery?.videoUrl, 'video')
    const ratio = target === 'baijiahao-video' ? '16:9' : '4:3'
    const landscape = await take(delivery?.covers[ratio], `covers.${ratio}`, true)
    const portrait = target === 'baijiahao-article' ? null : await take(delivery?.covers['3:4'], 'covers.3:4', true)
    let title = target === 'tencent-video' ? delivery?.title || '' : delivery?.baijiahaoTitle || ''
    let description = target === 'tencent-video' ? delivery?.description || '' : title
    let article: HistoryArticleResult['article'] = null
    const images: Array<{ url: string; path: string }> = []
    if (target === 'baijiahao-article' && source && !source.deletedAt) {
      try {
        const state = this.options.getArticle ? await this.options.getArticle(sourceId)
          : (await import('./history-script-article.js')).getHistoryArticle(sourceId, { root: this.root })
        article = state.article
        if (state.status !== 'completed' || state.stale || !article) add('article_not_current', 'article', '文章尚未生成完成或已过期，请先生成当前版本文章')
        if (article) {
          title = article.title; description = ''
          if (!article.html?.trim() || !Array.isArray(article.sections) || !article.sections.length) add('article_empty', 'article', '文章缺少已保存的 HTML 或正文段落')
          for (const [index, image] of (article.screenshots || []).entries()) {
            const asset = await take(image.url, `article.screenshots.${index}`, true)
            if (asset) images.push({ url: image.url, path: asset.path })
          }
          const imageHashes = new Map<string, string>()
          for (const image of images) imageHashes.set(image.url, createHash('sha256').update(await fs.promises.readFile(image.path)).digest('hex'))
          const mainHash = landscape ? createHash('sha256').update(await fs.promises.readFile(landscape.path)).digest('hex') : undefined
          const distinctImages = new Set(imageHashes.values())
          if (mainHash) distinctImages.delete(mainHash)
          if (distinctImages.size < 2) add('article_cover_images_missing', 'article.screenshots',
            `图文三图封面至少需要 2 张不同的正文配图；当前可用 ${distinctImages.size} 张，还缺 ${2 - distinctImages.size} 张（已排除与主封面相同或内容重复的图片）`)
          if (!await articleImagesPrepared(article.html, images, imageHashes, mainHash)) add('article_images_not_prepared', 'article.screenshots',
            '文章配图尚未准备完成，请先在文章生成阶段补齐；尚未开始上传')
        }
      } catch { add('article_unreadable', 'article', '当前文章无法读取') }
    }
    const length = Array.from(title.trim()).length
    if (!title.trim()) add('title_missing', 'title', target === 'tencent-video' ? '缺少视频号短标题' : target === 'baijiahao-article' ? '缺少文章标题' : '缺少百家号标题')
    else if (target === 'tencent-video' && (length < 6 || length > 16)) add('title_length', 'title', '视频号安全上传扩展要求标题为 6 至 16 字')
    else if (target === 'baijiahao-video' && (length < 2 || length > 50)) add('title_length', 'title',
      `百家号视频发布标题共${length}字，需为2至50字；完整原标题已保留，请在成片与封面中精简发布标题后继续`)
    else if (target === 'baijiahao-article' && (length < 2 || length > 64)) add('title_length', 'title', '百家号编辑器要求标题为 2 至 64 字')
    if (target === 'tencent-video' && !description.trim()) add('description_missing', 'description', '缺少视频号作品描述，请在成片交付中补全')
    if (target === 'tencent-video' && Array.from(description).length > 200) add('description_length', 'description', '视频号当前安全上传扩展要求描述不超过 200 字')
    const platform = target === 'tencent-video' ? 'tencent' : 'baijiahao'
    if (runtime && !runtime.installed) add('runtime_missing', 'runtime', runtime.message || '上传运行环境尚未安装')
    else if (runtime && !runtime.platforms[platform].ready) {
      const state = runtime.platforms[platform]
      const transient = mode !== 'stage' && state.sessionMode === 'background' && state.accountName === `history_${platform}`
        && (state.issue === 'connection_failed' || state.issue === 'check_failed')
      const message = state.message || '平台未登录或暂不可用'
      // Queue eligibility is not permission to write. Workers use strict checks.
      if (transient && forQueue) warnings.push(`后台检查暂未完成，排队后将重新检查，通过后才上传：${message}`)
      else add(transient ? 'runtime_check_pending' : 'platform_not_ready', 'runtime', message)
    }
    const fingerprint = hash({ sourceId, target, sourceTitle: source?.title, script, artifactState: source?.artifactState,
      title, description, scriptSha256: delivery?.scriptSha256, coverScriptSha256: delivery?.coverScriptSha256,
      coverStatus: delivery?.coverStatus, assets, article: target === 'baijiahao-article' ? article : null,
      ...(mode === 'publish' || videoId !== null ? { publicationMode: mode === 'publish' ? 'publish' : 'draft',
        videoId, videoProducer: selectedVideo?.producer || 'legacy', videoSha256: selectedVideo?.sha256 } : {}) })
    return { item: { sourceId, sourceTitle: source?.title || `历史项目 #${sourceId}`, target, mode,
      videoId, videoProducer: selectedVideo?.producer || 'legacy',
      engine: target === 'baijiahao-article' ? 'project-extension' : 'social-auto-upload', ready: blockers.length === 0, blockers, warnings, fingerprint },
      payload: { jobId: '', scriptId: sourceId, target, title, description, fingerprint,
        ...(target === 'baijiahao-video' ? { tags: ['#热爆趣创赛'] } : {}),
        ...(mode === 'publish' ? { publicationMode: 'publish' as const } : {}),
        ...(mode !== 'stage' && runtime?.platforms[platform].sessionMode === 'background' ? { accountName: runtime.platforms[platform].accountName } : {}),
        ...(video && target !== 'baijiahao-article' ? { videoPath: video.path } : {}),
        ...(landscape ? { landscapePath: landscape.path } : {}), ...(portrait ? { portraitPath: portrait.path } : {}),
        ...(article ? { articleHtml: article.html, images } : {}) } }
  }
  async preflight(input: HistorySocialUploadInput, refreshRuntime = false) {
    const parsed = historySocialUploadInputSchema.parse(input)
    const { runtime, prepared } = await this.prepareInput(parsed, refreshRuntime)
    return { mode: parsed.mode, runtime, items: prepared.map(item => item.item) }
  }
  private async prepareInput(parsed: z.output<typeof historySocialUploadInputSchema>, refreshRuntime: boolean) {
    const ids = [...new Set(parsed.sourceIds)]
    const targets = [...new Set(parsed.targets)]
    const statuses = new Map(ids.map(id => [id, this.uploads(id)]))
    const pending = parsed.mode === 'publish' || !!parsed.videoIds || ids.some(id => targets.some(target => !statuses.get(id)![target]))
    const runtime = pending ? await this.runtimeForMode(parsed.mode, refreshRuntime) : undefined
    const prepared: Prepared[] = []
    const selectedIds = new Set(parsed.videoIds)
    const matchedIds = new Set<number>()
    for (const id of ids) {
      const source = await this.source(id)
      const versions = parsed.mode === 'publish' || parsed.videoIds
        ? currentHistoryVideoDeliveries(this.database, id, textHash(source?.rewrittenScript || '')) : []
      const videoIds: Array<number | null> = parsed.videoIds
        ? versions.filter(video => selectedIds.has(video.id)).map(video => video.id)
        : versions.length ? versions.map(video => video.id) : [null]
      for (const videoId of videoIds) for (const target of targets) {
      if (videoId !== null) matchedIds.add(videoId)
      const uploaded = parsed.mode === 'publish' || videoId !== null ? undefined : statuses.get(id)![target]
      if (uploaded) {
        const source = await this.source(id)
        const fingerprint = hash({ id, target, uploaded: true })
        prepared.push({ item: { sourceId: id, sourceTitle: source?.title || `历史项目 #${id}`, target, mode: parsed.mode,
          engine: target === 'baijiahao-article' ? 'project-extension' : 'social-auto-upload', ready: false, blockers: [], fingerprint, uploaded },
          payload: { jobId: '', scriptId: id, target, title: '', description: '', fingerprint } })
      } else prepared.push(await this.prepare(id, target, parsed.mode, runtime, true, videoId))
      }
    }
    if (parsed.videoIds && selectedIds.size !== matchedIds.size) throw new HistorySocialUploadError('指定成片不属于所选稿件的当前版本', 400)
    return { runtime, prepared }
  }
  private stored(id: string | number) { return this.database.prepare('SELECT * FROM history_social_upload_jobs WHERE id=?').get(id) as StoredJob | undefined }
  getJob(id: string | number) {
    const row = this.stored(id)
    if (!row) throw new HistorySocialUploadError('上传任务不存在', 404)
    return publicJob(row)
  }
  listJobs(sourceId?: number, limit = 100) {
    return (this.database.prepare(`SELECT * FROM history_social_upload_jobs ${sourceId === undefined ? '' : 'WHERE source_id=?'} ORDER BY id DESC LIMIT ?`)
      .all(...(sourceId === undefined ? [] : [sourceId]), Math.min(100, Math.max(1, limit))) as StoredJob[]).map(publicJob)
  }
  queueState() {
    const running = this.database.prepare("SELECT id FROM history_social_upload_jobs WHERE status='running' LIMIT 1").get() as { id: number } | undefined
    const attention = this.database.prepare("SELECT count(*) AS count FROM history_social_upload_jobs WHERE status IN ('blocked','awaiting_confirmation','uncertain','failed')").get() as { count: number }
    return { paused: false, reason: null, jobId: null, runningJobId: running ? String(running.id) : null,
      attentionCount: attention.count, recoveringCount: 0 }
  }
  receipt(requestId: string) {
    const receipt = this.database.prepare('SELECT preflight_json FROM history_social_upload_requests WHERE request_id=?').get(requestId) as { preflight_json: string } | undefined
    if (!receipt) throw new HistorySocialUploadError('上传请求回执不存在', 404)
    const rows = this.database.prepare(`SELECT j.*,r.reused FROM history_social_upload_jobs j JOIN history_social_upload_request_jobs r ON r.job_id=j.id WHERE r.request_id=? ORDER BY j.id`)
      .all(requestId) as Array<StoredJob & { reused: number }>
    const preflight = JSON.parse(receipt.preflight_json) as { mode: HistorySocialMode; runtime: SocialUploadRuntime; items: HistorySocialPreflightItem[] }
    return { requestId, ...preflight, jobs: rows.map(row => ({ ...publicJob(row), reused: !!row.reused })), queue: this.queueState() }
  }
  async enqueue(input: HistorySocialUploadInput, options: { automatic?: boolean } = {}) {
    const parsed = historySocialUploadInputSchema.parse(input)
    const requestId = parsed.requestId || randomUUID()
    const inputHash = hash({ sourceIds: [...new Set(parsed.sourceIds)], targets: [...new Set(parsed.targets)], mode: parsed.mode,
      ...(parsed.videoIds ? { videoIds: [...new Set(parsed.videoIds)].sort((a, b) => a - b) } : {}) })
    const existing = this.database.prepare('SELECT input_hash FROM history_social_upload_requests WHERE request_id=?').get(requestId) as { input_hash: string } | undefined
    if (existing) {
      if (existing.input_hash !== inputHash) throw new HistorySocialUploadError('requestId 已用于另一组上传参数')
      return this.receipt(requestId)
    }
    const { runtime, prepared } = await this.prepareInput(parsed, true)
    const preflight = { mode: parsed.mode, runtime, items: prepared.map(item => item.item) }
    this.database.transaction(() => {
      const concurrent = this.database.prepare('SELECT input_hash FROM history_social_upload_requests WHERE request_id=?').get(requestId) as { input_hash: string } | undefined
      if (concurrent) {
        if (concurrent.input_hash !== inputHash) throw new HistorySocialUploadError('requestId 已用于另一组上传参数')
        return
      }
      this.database.prepare('INSERT INTO history_social_upload_requests VALUES(?,?,?,?)').run(requestId, inputHash, JSON.stringify(preflight), this.timestamp())
      for (const { item, payload } of prepared) {
        // Recheck after async preparation: a concurrent completion/manual mark
        // must win over creating a new task, even when the material changed.
        const uploaded = parsed.mode === 'publish' || item.videoId != null ? undefined : this.uploads(item.sourceId)[item.target]
        if (uploaded) {
          item.uploaded = uploaded; item.ready = false; item.blockers = []
          const saved = this.database.prepare("SELECT id FROM history_social_upload_jobs WHERE source_id=? AND target=? AND status='completed' AND json_extract(result_json,'$.saved')=1 ORDER BY id DESC LIMIT 1").get(item.sourceId, item.target) as { id: number } | undefined
          if (saved) this.database.prepare('INSERT INTO history_social_upload_request_jobs VALUES(?,?,1)').run(requestId, saved.id)
          continue
        }
        const publicationMode = parsed.mode === 'publish' ? 'publish' : 'draft'
        const storedMode = parsed.mode === 'publish' ? 'draft' : parsed.mode
        let row = this.database.prepare(`SELECT * FROM history_social_upload_jobs WHERE source_id=? AND target=?
          AND video_id IS ? AND publication_mode=? AND (status IN ('queued','running','awaiting_confirmation','uncertain')
          OR (? IS NOT NULL AND publication_mode='publish' AND status<>'canceled')
          OR (publication_mode='publish' AND (upload_dispatched=1 OR result_json IS NOT NULL OR operation='recover'))) ORDER BY id DESC LIMIT 1`)
          .get(item.sourceId, item.target, item.videoId ?? null, publicationMode, item.videoId ?? null) as StoredJob | undefined
        row ??= this.database.prepare("SELECT * FROM history_social_upload_jobs WHERE source_id=? AND target=? AND fingerprint=? AND status<>'canceled'")
          .get(item.sourceId, item.target, item.fingerprint) as StoredJob | undefined
        if (!row && parsed.mode === 'publish' && item.videoId != null) {
          const video = this.database.prepare('SELECT script_id AS scriptId,video_path AS videoUrl FROM history_video_deliveries WHERE id=? AND script_id=?')
            .get(item.videoId, item.sourceId) as { scriptId: number; videoUrl: string } | undefined
          const legacy = video && legacyHistoryVideoPublication(this.database, video, this.root)
          if (legacy) row = this.stored(legacy.id)
        }
        const reused = !!row
        const requeue = row && ['blocked', 'failed'].includes(row.status) && !row.upload_dispatched && !row.result_json && row.operation !== 'close-failed' && item.ready
        if (!row || requeue) {
          const revision = parsed.mode === 'publish' && item.videoId != null
            ? getHistoryPublicationRevision(this.database, item.sourceId, item.videoId, { root: this.root }) : null
          if (revision?.blocked) throw new HistorySocialUploadError(`原成片发表任务 #${revision.jobId} 尚未结束或结果待核对，请先处理原任务`)
          if (options.automatic && revision) throw new HistorySocialUploadError('本次成片为已提交作品的修订版，请在发表工作台明确选择再次发表')
        }
        if (row && requeue) {
          this.database.prepare(`UPDATE history_social_upload_jobs SET status='queued',mode=?,publication_mode=?,message='等待上传',error=NULL,
            blockers_json='[]',payload_json=?,recovery_action=NULL,recovery_attempts=0,next_attempt_at=NULL,updated_at=? WHERE id=?`)
            .run(storedMode, publicationMode, JSON.stringify({ ...payload, jobId: String(row.id) }), this.timestamp(), row.id)
        } else if (!row) {
          const inserted = this.database.prepare(`INSERT INTO history_social_upload_jobs
            (source_id,source_title,target,mode,status,message,error,blockers_json,fingerprint,engine,created_at,updated_at,publication_mode,video_id,video_producer)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.sourceId, item.sourceTitle, item.target, storedMode, item.ready ? 'queued' : 'failed',
              item.ready ? '等待上传' : item.blockers.map(issue => issue.message).join('；'), null, JSON.stringify(item.blockers), item.fingerprint, item.engine, this.timestamp(), this.timestamp(),
              publicationMode, item.videoId ?? null, item.videoProducer || 'legacy')
          row = this.stored(Number(inserted.lastInsertRowid))!
          this.database.prepare('UPDATE history_social_upload_jobs SET payload_json=? WHERE id=?').run(JSON.stringify({ ...payload, jobId: String(row.id) }), row.id)
        }
        this.database.prepare('INSERT INTO history_social_upload_request_jobs VALUES(?,?,?)').run(requestId, row.id, Number(reused))
      }
      this.database.prepare('UPDATE history_social_upload_requests SET preflight_json=? WHERE request_id=?').run(JSON.stringify(preflight), requestId)
    }).immediate()
    this.wake()
    return this.receipt(requestId)
  }
  cancel(id: string | number) {
    const changed = this.database.prepare(`UPDATE history_social_upload_jobs SET status='canceled',message='已取消待上传任务',updated_at=?
      WHERE id=? AND status='queued' AND recovery_action IS NULL
      AND NOT (publication_mode='publish' AND (upload_dispatched=1 OR result_json IS NOT NULL OR COALESCE(operation,'')='recover'))`)
      .run(this.timestamp(), id)
    if (!changed.changes) { this.getJob(id); throw new HistorySocialUploadError('只能取消尚未执行的 queued 任务') }
    return this.getJob(id)
  }
  retry(id: string | number) {
    const job = this.database.transaction(() => {
      const previous = this.stored(id)
      if (!previous) throw new HistorySocialUploadError('上传任务不存在', 404)
      // A repeated request cannot create another upload or replay a save.
      const legacyRecovery=previous.publication_mode==='publish' && (previous.status==='canceled' && publicationAttempted(previous)
        || previous.status==='completed' && !publicationReceipt(previous))
      if (['queued', 'running', 'completed'].includes(previous.status) && !legacyRecovery) return publicJob(previous)
      if (!['blocked', 'failed', 'uncertain'].includes(previous.status) && !legacyRecovery) throw new HistorySocialUploadError('只有失败的任务可以重试')
      const attempted = previous.upload_dispatched || previous.result_json || previous.status === 'uncertain' || publicationAttempted(previous)
      if (attempted && !previous.payload_json) {
        throw new HistorySocialUploadError('原上传记录缺失，无法安全清理旧尝试并重新上传')
      }
      const recover = previous.publication_mode === 'publish' && attempted
      this.database.prepare(`UPDATE history_social_upload_jobs SET status='queued',operation=?,recovery_action=NULL,
        upload_dispatched=CASE WHEN ? THEN 1 ELSE upload_dispatched END,
        recovery_attempts=0,next_attempt_at=NULL,owner=NULL,host=NULL,pid=NULL,lease_until=NULL,progress_json=NULL,
        message=?,error=NULL,blockers_json='[]',updated_at=? WHERE id=?`)
        .run(recover ? 'recover' : 'retry',Number(recover), recover ? '等待核对原发表检查点，不会重复发表' : '等待从头重新上传，将使用当前素材', this.timestamp(), previous.id)
      return this.getJob(previous.id)
    }).immediate()
    this.wake()
    return job
  }
  retryMany(ids: Array<string | number>) {
    const jobs: HistorySocialUploadJob[] = []
    const skipped: Array<{ id: string; message: string }> = []
    for (const id of new Set(ids.map(String))) {
      try {
        const current = this.getJob(id)
        const legacyRecovery=current.mode==='publish' && (current.status==='canceled' && current.publicationAttempted
          || current.status==='completed' && !isHistorySubmissionReceipt(current.result))
        if (!['blocked', 'failed', 'uncertain'].includes(current.status) && !legacyRecovery) {
          skipped.push({ id, message: current.status === 'completed' ? '草稿已保存，无需重试' : '任务已在执行或无需重试' })
          continue
        }
        jobs.push(this.retry(id))
      } catch (error) { skipped.push({ id, message: errorText(error) }) }
    }
    return { jobs, skipped, queue: this.queueState() }
  }
  recoverInterrupted() {
    // Synchronous migration makes legacy outcomes coherent immediately. The worker
    // later closes failed pages / reads local saved receipts, never resumes writes.
    this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT * FROM history_social_upload_jobs WHERE status='running'
        OR status IN ('blocked','uncertain') OR (mode='draft' AND status='awaiting_confirmation')
        OR (status IN ('queued','failed') AND recovery_action IS NOT NULL)
        OR (status='failed' AND operation IN ('upload','confirm','resume','reconcile','recover'))
        OR (publication_mode='publish' AND status='failed' AND result_json IS NOT NULL)
        OR (status='queued' AND (upload_dispatched=1 OR result_json IS NOT NULL) AND COALESCE(operation,'')<>'retry')`).all() as StoredJob[]
      for (const job of rows) {
        if (job.status === 'running') {
          let dead = false
          if (job.host === hostname() && job.pid) {
            try { process.kill(job.pid, 0); continue } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' }
          }
          // An expired lease cannot take execution away from a live local writer.
          if (!dead && job.lease_until && job.lease_until > this.now()) continue
        }
        if (job.publication_mode === 'publish') {
          const completed = this.localSavedResult(job)
          if (completed) {
            this.database.prepare(`UPDATE history_social_upload_jobs SET status='completed',operation=NULL,message=?,error=NULL,
              blockers_json='[]',owner=NULL,host=NULL,pid=NULL,lease_until=NULL,recovery_action=NULL,next_attempt_at=NULL,
              progress_json=?,updated_at=? WHERE id=?`)
              .run(this.completedMessage(job, completed), JSON.stringify({step:completed.publicationStatus,message:this.completedMessage(job,completed)}), this.timestamp(), job.id)
            continue
          }
          if (job.status === 'running' && job.operation === 'packaging' && !job.upload_dispatched && !job.result_json) {
            this.database.prepare(`UPDATE history_social_upload_jobs SET status='queued',message='执行中断，继续等待本版标题与封面',
              owner=NULL,host=NULL,pid=NULL,lease_until=NULL,recovery_action=NULL,next_attempt_at=?,updated_at=? WHERE id=?`)
              .run(this.now() + 5_000, this.timestamp(), job.id)
            continue
          }
          // Existing publication attempts retain their original identity. Only
          // an interrupted active worker is automatically checkpoint-recovered;
          // an uncertain outcome waits for an explicit retry, never reuploads.
          if (['failed', 'uncertain'].includes(job.status)) continue
          if (job.status === 'queued' && ['recover', 'retry'].includes(job.operation || '')) continue
          this.database.prepare(`UPDATE history_social_upload_jobs SET status='queued',operation='recover',message='执行中断，继续原发表检查点',
            owner=NULL,host=NULL,pid=NULL,lease_until=NULL,recovery_action=NULL,updated_at=? WHERE id=?`)
            .run(this.timestamp(), job.id)
          continue
        }
        // A user-requested material preparation that never dispatched is still
        // ordinary queued work. Keep it, but discard all old recovery state.
        if (job.status === 'queued' && job.recovery_action === 'prepare' && !job.upload_dispatched && !job.result_json) {
          this.database.prepare(`UPDATE history_social_upload_jobs SET operation='retry',recovery_action=NULL,
            recovery_attempts=0,next_attempt_at=NULL,owner=NULL,host=NULL,pid=NULL,lease_until=NULL,
            error=NULL,progress_json=NULL,message='等待使用当前素材从头上传',updated_at=? WHERE id=?`)
            .run(this.timestamp(), job.id)
          continue
        }
        const saved = this.localSavedResult(job)
        const attempted = !!job.upload_dispatched || !!job.result_json
          || ['uncertain', 'running', 'awaiting_confirmation'].includes(job.status)
        const needsCleanup = !!job.payload_json && attempted
        const reason = job.error || job.message || '上传执行中断'
        this.database.prepare(`UPDATE history_social_upload_jobs SET status=?,message=?,error=?,operation=?,
          upload_dispatched=CASE WHEN ? THEN 1 ELSE upload_dispatched END,
          blockers_json=CASE WHEN ? THEN '[]' ELSE blockers_json END,
          recovery_action=NULL,recovery_attempts=0,next_attempt_at=NULL,owner=NULL,host=NULL,pid=NULL,lease_until=NULL,
          progress_json=NULL,updated_at=? WHERE id=? AND status=?`)
          .run(saved ? 'completed' : 'failed', saved ? '已上传到草稿箱，未发布' : `上传失败，请点击“重新上传”从头上传：${reason}`,
            saved ? null : reason, !saved && needsCleanup ? 'close-failed' : null,
            Number(attempted), Number(!!saved), this.timestamp(), job.id, job.status)
      }
    }).immediate()
  }
  private claim() {
    return this.database.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM history_social_upload_jobs WHERE status='running' LIMIT 1").get()) return undefined
      if (this.database.prepare('SELECT 1 FROM history_social_publication_checks WHERE owner IS NOT NULL AND lease_until>? LIMIT 1').get(this.now())) return undefined
      const job = this.database.prepare(`SELECT * FROM history_social_upload_jobs
        WHERE (status='queued' AND (COALESCE(operation,'')<>'packaging' OR next_attempt_at IS NULL OR next_attempt_at<=?))
          OR (status='failed' AND operation='close-failed')
        ORDER BY CASE WHEN status='failed' THEN 0 ELSE 1 END,id LIMIT 1`).get(this.now()) as StoredJob | undefined
      if (!job) return undefined
      const operation = job.operation === 'close-failed' ? 'close-failed' : job.operation === 'retry' ? 'retry'
        : job.operation === 'recover' ? 'recover' : job.operation === 'packaging' ? 'packaging' : 'upload'
      this.database.prepare(`UPDATE history_social_upload_jobs SET status='running',operation=?,message=?,next_attempt_at=NULL,
        owner=?,host=?,pid=?,lease_until=?,updated_at=? WHERE id=?`)
        .run(operation, operation === 'close-failed' ? '正在关闭失败上传页面' : operation === 'retry'
          ? '正在清理旧尝试，准备从头上传' : '正在检查上传素材和登录状态',
          this.owner, hostname(), process.pid, this.now() + (this.options.leaseMs ?? 90_000), this.timestamp(), job.id)
      return this.stored(job.id)!
    }).immediate()
  }
  private heartbeat(job: StoredJob) {
    const started = this.now()
    let progress = job.operation === 'confirm' ? '正在保存已绑定的草稿页'
      : job.operation === 'close-failed' ? '正在关闭失败上传页面'
      : job.operation === 'retry' ? '正在清理旧尝试，准备从头上传' : '正在检查上传素材和登录状态'
    const update = () => this.database.prepare("UPDATE history_social_upload_jobs SET message=?,lease_until=?,updated_at=? WHERE id=? AND owner=? AND status='running'")
      .run(`${progress}（已用时 ${Math.max(0, Math.floor((this.now() - started) / 1000))} 秒）`, this.now() + (this.options.leaseMs ?? 90_000), this.timestamp(), job.id, this.owner)
    const timer = setInterval(() => { try { update() } catch (error) { this.options.onError?.(error) } }, this.options.heartbeatMs ?? 30_000)
    timer.unref()
    return { stop: () => clearInterval(timer), onProgress: (message: string, detail?: SocialUploadProgress) => {
      if (typeof message !== 'string' || !message.trim()) return
      progress = message.slice(0, 1500)
      if (detail?.step) this.database.prepare("UPDATE history_social_upload_jobs SET progress_json=? WHERE id=? AND owner=? AND status='running'")
        .run(JSON.stringify({ step: detail.step.slice(0, 100), message: progress }), job.id, this.owner)
      update()
    } }
  }
  private validateResult(result: SocialUploadResult, target: SocialTarget, previous?: SocialUploadResult, publishing = false) {
    const expected = target === 'tencent-video' ? 'channels.weixin.qq.com' : 'baijiahao.baidu.com'
    let url: URL
    try { url = new URL(result.editorUrl) } catch { throw new Error('未获得可信的上传结果') }
    if (result.staged !== true || typeof result.published !== 'boolean' || typeof result.saved !== 'boolean' || !result.targetId?.trim()
      || url.protocol !== 'https:' || url.hostname !== expected || url.username || url.password
      || (previous && (previous.targetId !== result.targetId || !(publishing ? result.submitted : result.saved)))) {
      throw new Error('未获得原绑定页的可信草稿保存结果')
    }
    if (!publishing && (result.published || result.submitted)) throw new Error('草稿任务返回了发表结果，需核对原任务')
    if (publishing) {
      if (target !== 'baijiahao-video' || result.saved) throw new Error('发表任务不能以保存草稿完成')
      if (result.submitted === true) {
        let publishedUrl: URL
        try { publishedUrl = new URL(result.publishedUrl || '') } catch { throw new Error('发表回执缺少作品地址') }
        if (!/^\d+$/.test(result.articleId || '') || !['submitted', 'published'].includes(result.publicationStatus || '')
          || result.published !== (result.publicationStatus === 'published') || publishedUrl.protocol !== 'https:'
          || publishedUrl.hostname !== 'baijiahao.baidu.com' || publishedUrl.username || publishedUrl.password
          || publishedUrl.port || publishedUrl.hash || !['/s', '/builder/preview/s'].includes(publishedUrl.pathname)
          || publishedUrl.searchParams.getAll('id').length !== 1 || publishedUrl.searchParams.get('id') !== result.articleId) throw new Error('发表回执的作品身份或状态无法核对')
      } else if (result.published || result.publicationStatus || result.articleId) throw new Error('发表结果状态不完整')
    }
  }
  private completedMessage(job: StoredJob, result: SocialUploadResult) {
    return job.publication_mode === 'publish' ? (result.published ? '已发表到百家号' : '已提交百家号，等待审核') : '已上传到草稿箱，未发布'
  }
  private fail(job: StoredJob, error: unknown, blockers: HistorySocialBlocker[] = []) {
    const reason = errorText(error)
    this.database.prepare(`UPDATE history_social_upload_jobs SET status='failed',error=?,message=?,blockers_json=?,
      operation=NULL,recovery_action=NULL,recovery_attempts=0,next_attempt_at=NULL,owner=NULL,host=NULL,pid=NULL,
      lease_until=NULL,progress_json=?,updated_at=? WHERE id=? AND owner=? AND status='running'`)
      .run(reason, `上传失败，请点击“重新上传”从头上传：${reason}`, JSON.stringify(blockers),
        JSON.stringify({ step: 'failed', message: reason }), this.timestamp(), job.id, this.owner)
  }
  private complete(job: StoredJob, result: SocialUploadResult, confirmed = false) {
    this.assertOwned(job)
    this.validateResult(result, job.target, undefined, job.publication_mode === 'publish')
    this.validateJobAccount(job, result)
    const previous = this.stored(job.id)?.result_json
    if (previous && JSON.parse(previous).targetId !== result.targetId) throw new Error('完成回执不是原绑定编辑页')
    const publishing = job.publication_mode === 'publish'
    if (publishing && !(result.submitted === true && result.saved === false && ['submitted', 'published'].includes(result.publicationStatus || '')
      && typeof result.articleId === 'string' && /^\d+$/.test(result.articleId))) throw new Error('未获得百家号发表回执')
    if (!publishing && job.mode === 'draft' && !result.saved) throw new Error('未获得草稿保存成功的凭证')
    const done = publishing ? result.submitted === true : result.saved && (confirmed || job.mode === 'draft')
    this.database.prepare(`UPDATE history_social_upload_jobs SET status=?,message=?,result_json=?,error=NULL,blockers_json='[]',
      owner=NULL,host=NULL,pid=NULL,lease_until=NULL,operation=NULL,recovery_attempts=0,
      next_attempt_at=NULL,recovery_action=NULL,progress_json=?,updated_at=? WHERE id=? AND owner=? AND status='running'`)
      .run(done ? 'completed' : 'awaiting_confirmation', done ? this.completedMessage(job, result) : '预览已就绪，可保存草稿；其他上传任务继续执行',
        JSON.stringify(result), JSON.stringify({ step: done ? publishing ? result.publicationStatus : 'saved' : 'staged', message: done ? this.completedMessage(job, result) : '预览已就绪' }), this.timestamp(), job.id, this.owner)
  }
  private localSavedResult(job: StoredJob): SocialUploadResult | undefined {
    try {
      const result = job.result_json ? JSON.parse(job.result_json) as SocialUploadResult : undefined
      if (!job.payload_json || !result || (job.publication_mode !== 'publish' && !result.saved)) return
      this.validateResult(result, job.target, undefined, job.publication_mode === 'publish')
      this.validateJobAccount(job, result)
      if (job.publication_mode === 'publish' && !(result.submitted === true && result.saved === false && !!result.articleId)) return
      return result
    } catch { return undefined }
  }
  private assertOwned(job: StoredJob) {
    const current = this.stored(job.id)
    if (current?.status !== 'running' || current.owner !== this.owner) throw new Error('任务执行权已转移，原进程停止后续操作')
  }
  private validateJobAccount(job: StoredJob, result: SocialUploadResult) {
    const payload: SocialUploadPayload | null = job.payload_json ? JSON.parse(job.payload_json) : null
    if (result.accountName !== payload?.accountName) throw new Error('上传回执账号与原任务不一致')
  }
  private recordResult(job: StoredJob, result: SocialUploadResult) {
    this.assertOwned(job)
    this.validateResult(result, job.target, undefined, job.publication_mode === 'publish')
    this.validateJobAccount(job, result)
    const previous = this.stored(job.id)!.result_json
    if (previous && JSON.parse(previous).targetId !== result.targetId) throw new Error('上传回执不是原绑定编辑页')
    this.database.prepare("UPDATE history_social_upload_jobs SET upload_dispatched=1,result_json=?,updated_at=? WHERE id=? AND owner=? AND status='running'")
      .run(JSON.stringify(result), this.timestamp(), job.id, this.owner)
  }
  private async handleFailure(job: StoredJob, error: unknown, runtime: HistorySocialRuntime) {
    const current = this.stored(job.id)
    if (!current || current.owner !== this.owner || current.status !== 'running') return
    const saved = this.localSavedResult(current)
    if (saved) { this.complete(job, saved, true); return }
    if (current.publication_mode === 'publish') {
      // Never dispose or reset an editor that may have submitted. Its durable
      // runtime checkpoint decides whether a later retry reconciles or resumes.
      try {
        if (current.payload_json && runtime.inspectSocialUploadCheckpoint) {
          const checkpoint = await runtime.inspectSocialUploadCheckpoint(JSON.parse(current.payload_json))
          if (checkpoint.result) this.recordResult(job, checkpoint.result)
          if (checkpoint.action === 'complete' && checkpoint.result) { this.complete(job, checkpoint.result, true); return }
        }
      } catch (checkpointError) { error = `${errorText(error)}；检查点：${errorText(checkpointError)}` }
      this.database.prepare(`UPDATE history_social_upload_jobs SET status='uncertain',message=?,error=?,operation=NULL,
        owner=NULL,host=NULL,pid=NULL,lease_until=NULL,recovery_action=NULL,updated_at=? WHERE id=? AND owner=? AND status='running'`)
        .run(`原发表任务需要继续核对：${errorText(error)}`, errorText(error), this.timestamp(), job.id, this.owner)
      return
    }
    try {
      if (current.payload_json && runtime.closeFailedSocialUpload) {
        const receipt = await runtime.closeFailedSocialUpload(JSON.parse(current.payload_json))
        this.assertOwned(job)
        if (receipt.result?.saved) {
          this.recordResult(job, receipt.result)
          this.complete(job, receipt.result, true)
          return
        }
      }
    } catch (closeError) {
      error = `${errorText(error)}；关闭失败页面时：${errorText(closeError)}`
    }
    this.fail(job, error)
  }
  private async readyForWrite(job: StoredJob) {
    const prepared = await this.prepare(job.source_id, job.target, effectiveMode(job), await this.runtimeForJob(job, true), false, job.video_id ?? null)
    this.assertOwned(job)
    if (prepared.item.ready && prepared.item.fingerprint === job.fingerprint) {
      if (job.upload_dispatched || job.result_json) throw new Error('旧上传尝试尚未清理，请点击“重新上传”从头上传')
      job.payload_json = JSON.stringify({ ...prepared.payload, jobId: String(job.id) })
      this.database.prepare("UPDATE history_social_upload_jobs SET payload_json=? WHERE id=? AND owner=?")
        .run(job.payload_json, job.id, this.owner)
      return true
    }
    const blockers = prepared.item.blockers.length ? prepared.item.blockers : [{ code: 'snapshot_changed', field: 'snapshot', message: '稿件、文案或素材已变化，请重试使用当前素材上传' }]
    this.fail(job, blockers.map(issue => issue.message).join('；'), blockers)
    return false
  }
  private async waitForPackaging(job: StoredJob) {
    if (job.publication_mode !== 'publish' || job.video_id == null || job.upload_dispatched || job.result_json || job.operation === 'recover') return false
    const source = await this.source(job.source_id)
    if (!source || source.deletedAt || source.artifactState !== 'current' || !source.rewrittenScript?.trim()) return false
    const scriptHash = textHash(source.rewrittenScript)
    const video = currentHistoryVideoDeliveries(this.database, job.source_id, scriptHash).find(item => item.id === job.video_id)
    if (!video) return false
    const packaging = getHistoryVideoPackagingRow(this.database, job.source_id, video.id)
    if (packaging?.script_sha256 === scriptHash && packaging.baijiahao_title.trim()
      && packaging.cover_status === 'completed' && packaging.cover_script_sha256 === scriptHash) return false
    const ensure = this.options.ensurePackaging ?? (await import('./history-delivery-automation.js')).ensureHistoryDeliveryAutomation
    const result = await ensure(job.source_id, { videoId: video.id, expectedScriptSha256: scriptHash })
    this.assertOwned(job)
    const branches = [result.design, result.covers]
    if (branches.every(branch => branch.status === 'completed')) {
      // The old snapshot has never entered the platform. Refresh it only after
      // its own replacement package is complete, using the existing retry path.
      job.operation = 'packaging'
      this.database.prepare("UPDATE history_social_upload_jobs SET operation='packaging' WHERE id=? AND owner=? AND status='running'")
        .run(job.id, this.owner)
      return false
    }
    const failure = branches.filter(branch => ['failed', 'needs_attention'].includes(branch.status))
    if (failure.length) {
      this.fail(job, failure.map(branch => branch.message).join('；'))
      return true
    }
    this.database.prepare(`UPDATE history_social_upload_jobs SET status='queued',operation='packaging',message=?,error=NULL,
      blockers_json='[]',owner=NULL,host=NULL,pid=NULL,lease_until=NULL,next_attempt_at=?,updated_at=?
      WHERE id=? AND owner=? AND status='running'`)
      .run(`等待本版标题与封面：${branches.map(branch => branch.message).join('；')}`, this.now() + 5_000, this.timestamp(), job.id, this.owner)
    return true
  }
  private async saveStaged(job: StoredJob, result: SocialUploadResult, runtime: HistorySocialRuntime, progress: SocialUploadProgressOptions) {
    this.recordResult(job, result)
    this.database.prepare("UPDATE history_social_upload_jobs SET operation='confirm',save_authorized=1,error=NULL,updated_at=? WHERE id=? AND owner=? AND status='running'")
      .run(this.timestamp(), job.id, this.owner)
    progress.onProgress?.('素材和封面已就绪，正在保存草稿', { step: 'saving', message: '正在保存草稿' })
    const saved = await runtime.confirmSocialUpload(JSON.parse(job.payload_json!), result, progress)
    this.validateResult(saved, job.target, result)
    this.complete(job, saved, true)
  }
  private markDispatched(job: StoredJob) {
    this.assertOwned(job)
    this.database.prepare("UPDATE history_social_upload_jobs SET upload_dispatched=1 WHERE id=? AND owner=? AND status='running'").run(job.id, this.owner)
  }
  private async prepareRetry(job: StoredJob, runtime: HistorySocialRuntime) {
    if (job.publication_mode !== 'publish' && job.video_id == null && this.uploads(job.source_id)[job.target]) {
      const saved = this.database.prepare("SELECT id FROM history_social_upload_jobs WHERE source_id=? AND target=? AND status='completed' ORDER BY id DESC LIMIT 1").get(job.source_id, job.target) as { id: number } | undefined
      this.database.prepare(`UPDATE history_social_upload_jobs SET status='canceled',message=?,error=NULL,
        recovery_action=NULL,operation=NULL,owner=NULL,host=NULL,pid=NULL,lease_until=NULL,updated_at=? WHERE id=? AND owner=? AND status='running'`)
        .run(`该平台已上传${saved ? `，请查看任务 #${saved.id}` : ''}；已跳过重复上传`, this.timestamp(), job.id, this.owner)
      return null
    }
    const saved = this.localSavedResult(job)
    if (saved) { this.complete(job, saved, true); return null }
    // Reset with the OLD account/digest before changing the material snapshot.
    // A missing reset implementation must never fall back to checkpoint resume.
    if (job.upload_dispatched || job.result_json) {
      if (!job.payload_json || !runtime.resetSocialUploadAttempt) throw new Error('上传运行环境不支持清理旧尝试，无法从头重新上传')
      const receipt = await runtime.resetSocialUploadAttempt(JSON.parse(job.payload_json))
      this.assertOwned(job)
      if (receipt.result) {
        if (!receipt.result.saved) throw new Error('清理旧尝试返回了无效的保存凭证，未重新上传')
        this.recordResult(job, receipt.result)
        this.complete(job, receipt.result, true)
        return null
      }
      this.database.prepare(`UPDATE history_social_upload_jobs SET upload_dispatched=0,result_json=NULL,
        save_authorized=0,progress_json=NULL WHERE id=? AND owner=? AND status='running'`).run(job.id, this.owner)
      job.upload_dispatched = 0
      job.result_json = null
    }
    // Missing local materials should report immediately without opening a browser.
    let prepared = await this.prepare(job.source_id, job.target, effectiveMode(job), undefined, false, job.video_id ?? null)
    if (prepared.item.ready) prepared = await this.prepare(job.source_id, job.target, effectiveMode(job), await this.runtimeForMode(effectiveMode(job), true), false, job.video_id ?? null)
    this.assertOwned(job)
    if (!prepared.item.ready) {
      this.fail(job, prepared.item.blockers.map(issue => issue.message).join('；'), prepared.item.blockers)
      return null
    }
    return this.database.transaction(() => {
      this.assertOwned(job)
      const duplicate = this.database.prepare(`SELECT id FROM history_social_upload_jobs WHERE id<>? AND source_id=? AND target=?
        AND video_id IS ? AND publication_mode=?
        AND (status IN ('queued','running','awaiting_confirmation','uncertain') OR (fingerprint=? AND status<>'canceled')) ORDER BY id DESC LIMIT 1`)
        .get(job.id, job.source_id, job.target, job.video_id ?? null, job.publication_mode, prepared.item.fingerprint) as { id: number } | undefined
      if (duplicate) {
        this.database.prepare(`UPDATE history_social_upload_jobs SET status='canceled',message=?,error=NULL,recovery_action=NULL,
          operation=NULL,owner=NULL,host=NULL,pid=NULL,lease_until=NULL,updated_at=? WHERE id=? AND owner=? AND status='running'`)
          .run(`当前素材已有上传任务 #${duplicate.id}，请查看该任务；已跳过重复上传`, this.timestamp(), job.id, this.owner)
        return null
      }
      this.database.prepare(`UPDATE history_social_upload_jobs SET source_title=?,fingerprint=?,payload_json=?,engine=?,
        recovery_action=NULL,recovery_attempts=0,operation='upload',error=NULL,blockers_json='[]',message='素材已齐备，正在上传',updated_at=? WHERE id=? AND owner=? AND status='running'`)
        .run(prepared.item.sourceTitle, prepared.item.fingerprint, JSON.stringify({ ...prepared.payload, jobId: String(job.id) }),
          prepared.item.engine, this.timestamp(), job.id, this.owner)
      return this.stored(job.id)!
    }).immediate()
  }
  private async run(job: StoredJob) {
    const heartbeat = this.heartbeat(job)
    let runtime: HistorySocialRuntime | undefined
    let writing = false
    try {
      runtime = await this.runtime()
      if (job.publication_mode === 'publish' && (job.operation === 'recover' || job.upload_dispatched || job.result_json)) {
        writing = true
        await this.recoverPublication(job, runtime, heartbeat)
        return
      }
      if (job.operation === 'close-failed') {
        await this.handleFailure(job, job.error || '上传执行中断', runtime)
        return
      }
      if (await this.waitForPackaging(job)) return
      if (job.operation === 'retry' || job.operation === 'packaging') {
        const prepared = await this.prepareRetry(job, runtime)
        if (!prepared) return
        job = prepared
      } else if (!await this.readyForWrite(job)) return
      this.assertOwned(job)
      writing = true
      this.markDispatched(job)
      const payload = JSON.parse(job.payload_json!) as SocialUploadPayload
      const result = await runtime.runSocialUpload(payload, { saveDraft: effectiveMode(job) === 'draft', onProgress: heartbeat.onProgress })
      this.validateResult(result, job.target, undefined, job.publication_mode === 'publish')
      if (job.publication_mode === 'publish') {
        this.recordResult(job, result)
        this.database.prepare("UPDATE history_social_upload_jobs SET operation='publish',message='正在发表已核验的视频',updated_at=? WHERE id=? AND owner=? AND status='running'")
          .run(this.timestamp(), job.id, this.owner)
        const published = await runtime.confirmSocialUpload(payload, result, heartbeat)
        this.complete(job, published, true)
      } else {
        if (job.mode === 'draft' && !result.saved) throw new Error('未获得草稿保存成功的凭证')
        this.complete(job, result)
      }
    } catch (error) {
      if (writing && runtime) await this.handleFailure(job, error, runtime)
      else this.fail(job, error)
    } finally { heartbeat.stop() }
  }
  private async recoverPublication(job: StoredJob, runtime: HistorySocialRuntime, progress: SocialUploadProgressOptions) {
    if (!job.payload_json || !runtime.inspectSocialUploadCheckpoint) throw new Error('发表任务缺少可恢复的原检查点')
    const payload = JSON.parse(job.payload_json) as SocialUploadPayload
    const checkpoint = await runtime.inspectSocialUploadCheckpoint(payload)
    this.assertOwned(job)
    if (checkpoint.result) this.recordResult(job, checkpoint.result)
    if (checkpoint.action === 'complete' && checkpoint.result) { this.complete(job, checkpoint.result, true); return }
    if (checkpoint.action === 'reconcile' && checkpoint.result && runtime.reconcileSocialUpload) {
      const result = await runtime.reconcileSocialUpload(payload, checkpoint.result, progress)
      this.complete(job, result, true)
      return
    }
    let staged: SocialUploadResult
    if (checkpoint.action === 'save' && checkpoint.result) staged = checkpoint.result
    else if (checkpoint.action === 'resume' && runtime.resumeSocialUpload) staged = await runtime.resumeSocialUpload(payload, progress)
    else if (checkpoint.action === 'upload') {
      // A missing bridge file is not proof that a dispatched upload never ran.
      if (job.upload_dispatched || job.result_json || job.operation === 'recover') throw new Error('原发表任务检查点缺失，不能重新上传或发表')
      const prepared = await this.prepare(job.source_id, job.target, 'publish', await this.runtimeForJob(job, true), false, job.video_id ?? null)
      this.assertOwned(job)
      if (!prepared.item.ready || prepared.item.fingerprint !== job.fingerprint) throw new Error('原稿件或素材已变化，不能继续原发表任务')
      this.markDispatched(job)
      staged = await runtime.runSocialUpload(payload, { saveDraft: false, ...progress })
    } else throw new Error(checkpoint.message)
    this.recordResult(job, staged)
    const published = await runtime.confirmSocialUpload(payload, staged, progress)
    this.complete(job, published, true)
  }
  runPending(): Promise<void> {
    if (this.draining) return this.draining
    if (this.stopping || this.syncPending) return Promise.resolve()
    this.draining = (async () => {
      this.recoverInterrupted()
      while (!this.stopping && !this.syncPending) { const job = this.claim(); if (!job) break; await this.run(job) }
      if (!this.stopping && !this.syncPending) await this.runPublicationChecks()
    })().finally(() => { this.draining = null })
    return this.draining
  }
  async confirm(id: string | number) {
    const previous = this.stored(id)
    if (!previous) throw new HistorySocialUploadError('上传任务不存在', 404)
    if (previous.status === 'completed') return publicJob(previous)
    if (previous.mode !== 'stage' || previous.status !== 'awaiting_confirmation' || !previous.result_json || !previous.payload_json) throw new HistorySocialUploadError('只有已绑定编辑页的 awaiting_confirmation 任务可以确认保存')
    const runtime = await this.runtime()
    const prepared = await this.prepare(previous.source_id, previous.target, previous.mode, await this.runtimeForJob(previous, true), false, previous.video_id ?? null)
    if (!prepared.item.ready || prepared.item.fingerprint !== previous.fingerprint) throw new HistorySocialUploadError('原项目、素材或平台就绪状态已变化；请人工核对已上传编辑页，草稿及证据仍保留')
    const job = this.database.transaction(() => {
      if (this.syncPending) throw new HistorySocialUploadError('正在同步后台登录，请稍后重试原任务')
      if (this.database.prepare("SELECT 1 FROM history_social_upload_jobs WHERE id<>? AND status='running' LIMIT 1").get(previous.id)) throw new HistorySocialUploadError('其他上传任务正在执行，请稍后操作')
      const changed = this.database.prepare(`UPDATE history_social_upload_jobs SET status='running',operation='confirm',save_authorized=1,recovery_attempts=0,recovery_action=NULL,message='正在保存原绑定草稿页',owner=?,host=?,pid=?,lease_until=?,updated_at=? WHERE id=? AND status='awaiting_confirmation'`)
        .run(this.owner, hostname(), process.pid, this.now() + (this.options.leaseMs ?? 90_000), this.timestamp(), previous.id)
      if (!changed.changes) throw new HistorySocialUploadError('任务正在保存或状态已变化，不会重复保存')
      return this.stored(previous.id)!
    }).immediate()
    const heartbeat = this.heartbeat(job)
    try {
      await this.saveStaged(job, JSON.parse(previous.result_json), runtime, heartbeat)
    } catch (error) { await this.handleFailure(job, error, runtime) }
    finally { heartbeat.stop() }
    this.wake()
    return this.getJob(id)
  }
  async resume(id: string | number): Promise<HistorySocialUploadJob> {
    const job = this.getJob(id)
    if (job.mode === 'publish') return this.retry(id)
    throw new HistorySocialUploadError('已取消断点续传，请点击“重新上传”从头上传')
  }
  async reconcile(id: string | number): Promise<HistorySocialUploadJob> {
    const previous = this.stored(id)
    if (!previous) throw new HistorySocialUploadError('上传任务不存在', 404)
    if (previous.publication_mode !== 'publish') throw new HistorySocialUploadError('已取消结果待确认流程，请点击“重新上传”从头上传')
    if (previous.status === 'completed' && publicationReceipt(previous)) return this.refreshPublicationReceipt(previous)
    const legacyRecovery=previous.status==='completed' || previous.status==='canceled' && publicationAttempted(previous)
    if (!previous.payload_json || !['failed', 'uncertain'].includes(previous.status) && !legacyRecovery) {
      throw new HistorySocialUploadError('只有已有发表尝试记录的任务可以核对')
    }
    const runtime = await this.runtime()
    if (!runtime.inspectSocialUploadCheckpoint || !runtime.reconcileSocialUpload) throw new HistorySocialUploadError('当前运行环境不支持发表结果核对', 503)
    const job = this.database.transaction(() => {
      if (this.syncPending || this.database.prepare("SELECT 1 FROM history_social_upload_jobs WHERE status='running'").get()) throw new HistorySocialUploadError('其他上传操作正在执行，请稍后核对')
      const changed = this.database.prepare(`UPDATE history_social_upload_jobs SET status='running',operation='reconcile',owner=?,host=?,pid=?,lease_until=?,updated_at=? WHERE id=? AND status=?`)
        .run(this.owner, hostname(), process.pid, this.now() + (this.options.leaseMs ?? 90_000), this.timestamp(), previous.id,previous.status)
      if (!changed.changes) throw new HistorySocialUploadError('任务状态已变化，请读取原任务')
      return this.stored(previous.id)!
    }).immediate()
    const heartbeat = this.heartbeat(job)
    try {
      const payload = JSON.parse(job.payload_json!) as SocialUploadPayload
      const checkpoint = await runtime.inspectSocialUploadCheckpoint(payload)
      if (checkpoint.action === 'complete' && checkpoint.result) this.complete(job, checkpoint.result, true)
      else if (checkpoint.action === 'reconcile' && checkpoint.result) this.complete(job,
        await runtime.reconcileSocialUpload(payload, checkpoint.result, heartbeat), true)
      else throw new Error(checkpoint.message)
    } catch (error) { await this.handleFailure(job, error, runtime) }
    finally { heartbeat.stop() }
    return this.getJob(id)
  }
  /** Observe moderation on the original article; a failed read cannot undo submission. */
  private refreshPublicationReceipt(previous: StoredJob, automatic = false): Promise<HistorySocialUploadJob> {
    const pending = this.readPublicationReceipt(previous, automatic).finally(() => this.activePublicationRefreshes.delete(pending))
    this.activePublicationRefreshes.add(pending)
    return pending
  }
  private async readPublicationReceipt(previous: StoredJob, automatic: boolean): Promise<HistorySocialUploadJob> {
    const receipt = this.localSavedResult(previous)
    if (!receipt?.submitted || receipt.published || !previous.payload_json) return publicJob(previous)
    const claimed = this.database.transaction(() => {
      if (this.stopping || this.syncPending || this.database.prepare("SELECT 1 FROM history_social_upload_jobs WHERE status='running' LIMIT 1").get()
        || this.database.prepare('SELECT 1 FROM history_social_publication_checks WHERE owner IS NOT NULL AND lease_until>? LIMIT 1').get(this.now())) return false
      this.database.prepare('INSERT OR IGNORE INTO history_social_publication_checks(job_id,next_check_at) VALUES(?,?)').run(previous.id, this.now())
      const current = this.stored(previous.id)
      if (current?.status !== 'completed' || current.payload_json !== previous.payload_json || current.result_json !== previous.result_json) return false
      return this.database.prepare(`UPDATE history_social_publication_checks SET owner=?,lease_until=?
        WHERE job_id=? AND (owner IS NULL OR lease_until<=?) AND (?=0 OR next_check_at<=?)`)
        .run(this.owner, this.now() + 5 * 60_000, previous.id, this.now(), Number(automatic), this.now()).changes > 0
    }).immediate()
    if (!claimed) return this.getJob(previous.id)
    let failure: string | null = null
    try {
      const payload = JSON.parse(previous.payload_json) as SocialUploadPayload
      if (payload.jobId !== String(previous.id) || payload.scriptId !== previous.source_id || payload.fingerprint !== previous.fingerprint
        || payload.target !== previous.target || payload.publicationMode !== 'publish' || !payload.accountName) throw Error('原提交任务身份不完整，已保留提交回执')
      const runtime = await this.runtime()
      if (!runtime.refreshSocialPublication) throw Error('当前运行环境不支持只读刷新审核状态')
      const result = await runtime.refreshSocialPublication(payload, receipt)
      this.validateResult(result, previous.target, receipt, true)
      this.validateJobAccount(previous, result)
      if (result.articleId !== receipt.articleId || result.targetId !== receipt.targetId) throw Error('审核状态回执不是原作品，已保留提交回执')
      // Preserve every identity/material field and the original submission timestamp.
      // Compare-and-swap prevents a late read from overwriting another observation.
      if (result.published) this.database.prepare(`UPDATE history_social_upload_jobs SET result_json=?,message=?,progress_json=?
        WHERE id=? AND status='completed' AND payload_json=? AND result_json=?`)
        .run(JSON.stringify({...receipt, published:true, publicationStatus:'published', publishedUrl:result.publishedUrl}),
          '已发表到百家号', JSON.stringify({step:'published',message:'已发表到百家号'}), previous.id, previous.payload_json, previous.result_json)
    } catch (error) { failure = errorText(error) }
    finally {
      const check = this.database.prepare('SELECT attempts FROM history_social_publication_checks WHERE job_id=?').get(previous.id) as {attempts:number}
      const attempts = failure ? check.attempts + 1 : 0
      const delay = failure ? Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.min(attempts, 7)) : 15 * 60_000
      this.database.prepare(`UPDATE history_social_publication_checks SET checked_at=?,last_error=?,attempts=?,next_check_at=?,owner=NULL,lease_until=NULL
        WHERE job_id=? AND owner=?`).run(this.timestamp(), failure, attempts, this.now() + delay, previous.id, this.owner)
    }
    return this.getJob(previous.id)
  }
  /** At most two reads per minute, only after queued uploads have drained. */
  runPublicationChecks(): Promise<void> {
    if (this.publicationChecks) return this.publicationChecks
    if (this.stopping || this.syncPending || this.now() < this.nextPublicationCheckAt) return Promise.resolve()
    this.nextPublicationCheckAt = this.now() + 60_000
    this.publicationChecks = (async () => {
      this.database.prepare(`INSERT OR IGNORE INTO history_social_publication_checks(job_id,next_check_at)
        SELECT id,CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER)+300000 FROM history_social_upload_jobs
        WHERE publication_mode='publish' AND status='completed' AND json_extract(result_json,'$.publicationStatus')='submitted'`).run()
      const due = `SELECT j.* FROM history_social_upload_jobs j JOIN history_social_publication_checks c ON c.job_id=j.id
        WHERE j.publication_mode='publish' AND j.status='completed' AND json_extract(j.result_json,'$.publicationStatus')='submitted'
          AND c.next_check_at<=? AND (c.owner IS NULL OR c.lease_until<=?)`
      // Keep fresh submissions moving while reserving half the reads for the oldest backlog.
      const fresh = this.database.prepare(`${due} ORDER BY (c.checked_at IS NULL) DESC,j.updated_at DESC,j.id DESC LIMIT 1`)
        .get(this.now(),this.now()) as StoredJob | undefined
      const oldest = fresh ? this.database.prepare(`${due} AND j.id<>? ORDER BY c.next_check_at,j.id LIMIT 1`)
        .get(this.now(),this.now(),fresh.id) as StoredJob | undefined : undefined
      const jobs = [fresh,oldest].filter((job):job is StoredJob=>!!job)
      for (const job of jobs) {
        if (this.stopping || this.syncPending || this.database.prepare("SELECT 1 FROM history_social_upload_jobs WHERE status IN ('queued','running') LIMIT 1").get()) break
        if (!publicationReceipt(job) || !this.localSavedResult(job)) {
          this.database.prepare('UPDATE history_social_publication_checks SET next_check_at=?,last_error=? WHERE job_id=? AND owner IS NULL')
            .run(this.now() + 6 * 60 * 60_000, '原提交回执身份不完整，未连接平台', job.id)
          continue
        }
        await this.refreshPublicationReceipt(job, true)
      }
    })().finally(() => { this.publicationChecks = null })
    return this.publicationChecks
  }
  async open(id: string | number) {
    const job = this.stored(id)
    if (!job) throw new HistorySocialUploadError('上传任务不存在', 404)
    if (!job.payload_json || !job.result_json) throw new HistorySocialUploadError('尚无可聚焦的绑定编辑页')
    const runtime = await this.runtime()
    if (!runtime.focusSocialUpload) throw new HistorySocialUploadError('当前运行环境尚不支持聚焦原编辑页', 503)
    return runtime.focusSocialUpload(JSON.parse(job.payload_json), JSON.parse(job.result_json))
  }
  private wake() { if (this.timer && !this.stopping) void this.runPending().catch(error => this.options.onError?.(error)) }
  start() {
    if (this.timer) return
    this.stopping = false
    this.timer = setInterval(() => this.wake(), this.options.pollMs ?? 1000)
    this.timer.unref(); this.wake()
  }
  async stop() {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.draining
    await this.publicationChecks
    await Promise.allSettled(this.activePublicationRefreshes)
  }
  async close() { await this.stop(); if (!this.options.database) this.database.close() }
}

let service: HistorySocialUploadService | undefined
export function getHistorySocialUploadService() { return service ??= new HistorySocialUploadService({ onError: error => console.error('[history-social-upload]', errorText(error)) }) }
export function startHistorySocialUploadWorker(): { stop(): Promise<void> } {
  if (process.env.HISTORY_SOCIAL_UPLOAD_WORKER_DISABLED === '1' || process.env.TASK_WORKER_DISABLED === '1') return { stop: async () => {} }
  const worker = getHistorySocialUploadService(); worker.start(); return worker
}
