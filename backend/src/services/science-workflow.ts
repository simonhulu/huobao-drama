import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { parseHistoryYoutubeUrl } from './history-source-youtube.js'
import { sha256File, type SourceMedia } from './history-source-pipeline.js'
import { getScienceBaijiahaoAccountsService, getScienceHuashengAccountsService } from './science-accounts.js'
import type { SocialUploadAccount } from './social-upload-accounts.js'
import { SocialUploadAccountError } from './social-upload-accounts.js'
import * as huasheng from './history-huasheng-browser.js'
import { runHuashengJob } from './history-huasheng-api.js'
import * as exporter from './history-huasheng-export-api.js'
import { recoverCbaUpload, checkCbaUploadResult, rebindCbaUploadCovers, validateCbaUploadReceipt, type CbaUploadRecoveryCurrent, type CbaUploadRecoveryOptions } from './cba-upload-recovery.js'
import { recreateScienceScript, stripScienceNarrationIntroduction, type SciencePlan, type ScienceWritingCheckpoint } from './science-script.js'
import type { SocialUploadProgress, SocialUploadResult, SocialUploadReviewInput } from './social-auto-upload.js'
import type { ScienceVideoIntroProgress } from './science-video-intro.js'
import type * as mediaTools from './science-workflow-media.js'
import { hasScienceTranscriptCheckpoint, releaseScienceSourceMedia } from './science-workflow-media.js'
import { SCIENCE_COVER_COMPOSITION_VERSION } from './science-cover-poster.js'

export const SCIENCE_BAIJIAHAO_TAG = '#热爆趣创赛#'
export const SCIENCE_CREATION_DECLARATION = '个人观点，仅供参考'
export const SCIENCE_WATERMARK = '添加水印'
export const SCIENCE_COVER_STYLE = 'science-title-poster-v1'
export const SCIENCE_HUASHENG_VOICE = { id: 1595608, type: 1, name: '音色小鹭' } as const
export const scienceCoversSchema = z.object({ regenerate: z.boolean().optional(), newVersion: z.boolean().optional(), instruction: z.string().trim().max(1000).optional() }).strict()

const reviewTarget = z.string().regex(/^[a-fA-F0-9]{1,128}$/), reviewCoordinate = z.number().finite().min(0).max(10000)
export const scienceUploadReviewSchema = z.object({ view: z.enum(['original', 'content']).optional() }).strict()
export const scienceUploadReviewInputSchema = z.discriminatedUnion('action', [
  z.object({ targetId: reviewTarget, action: z.literal('click'), x: reviewCoordinate, y: reviewCoordinate }).strict(),
  z.object({ targetId: reviewTarget, action: z.literal('drag'), x: reviewCoordinate, y: reviewCoordinate, toX: reviewCoordinate, toY: reviewCoordinate }).strict(),
  z.object({ targetId: reviewTarget, action: z.literal('type'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ targetId: reviewTarget, action: z.literal('key'), key: z.enum(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'ControlOrMeta+A', 'Shift+Tab']) }).strict(),
  z.object({ targetId: reviewTarget, action: z.literal('scroll'), deltaY: z.number().finite().min(-2000).max(2000) }).strict(),
  z.object({ targetId: reviewTarget, action: z.literal('refresh') }).strict(),
])

const root = fileURLToPath(new URL('../../../data/science-pop/jobs/', import.meta.url))
const accountName = z.string().trim().min(1).max(100).nullable().optional()
export const scienceCreateSchema = z.object({ sourceUrl: z.string().trim().min(1).max(2048), title: z.string().trim().max(60).optional(),
  huashengAccountName: accountName, baijiahaoAccountName: accountName, mode: z.enum(['videos', 'upload']).default('videos') }).strict()
export const sciencePatchSchema = z.object({ title: z.string().trim().min(1).max(60).optional(), transcript: z.string().trim().max(120_000).optional(),
  script: z.string().trim().max(80_000).optional(), huashengAccountName: accountName, baijiahaoAccountName: accountName }).strict()
export const scienceRecoverySchema = z.object({ projectUrl: z.string().trim().max(2048).optional(),
  exportTask: z.object({ taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/), projectHash: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().optional(),
}).strict().refine(value => value.projectUrl || value.exportTask, '请提供原项目或原导出任务')
export type ScienceStage = 'download' | 'transcribe' | 'rewrite' | 'produce' | 'export' | 'covers' | 'upload' | 'completed'
export type ScienceUploadStatus = 'not_ready' | 'pending' | 'queued' | 'uploading' | 'uploaded' | 'submitted' | 'published' | 'blocked' | 'uncertain' | 'paused'
export interface ScienceJob {
  id: string; title: string; sourceUrl: string; createdAt: string; updatedAt: string
  deletedAt?: string
  status: 'draft' | 'queued' | 'running' | 'paused' | 'needs_attention' | 'retry_wait' | 'waiting_remote' | 'awaiting_export' | 'ready' | 'completed'
  stage: ScienceStage; message: string; transcript: string; script: string
  exportStep?: 'platform' | 'download' | 'presenter' | 'compose'
  compositionProgress?: ScienceVideoIntroProgress & { updatedAt: string }
  uploadProgress?: SocialUploadProgress & { updatedAt: string }
  uploadWarnings?: string[]
  factChecks: Array<{ claim: string; note: string }>; sources: string[]
  huashengAccountName: string | null; baijiahaoAccountName: string | null
  projectUrl: string | null; sourceVideoUrl: string | null; videoUrl: string | null
  videoCompositionPending?: boolean
  landscapeCoverUrl: string | null; portraitCoverUrl: string | null
  checkpoint: string | null; logs: Array<{ at: string; message: string }>; upload: SocialUploadResult | null
  hasUploadAttempt: boolean
  executionActive?: boolean
  autoUpload?: boolean; uploadStatus?: ScienceUploadStatus
  coverStyle?: string; coverInstruction?: string; coverRevision?: number; coverGenerationPending?: boolean
  plan?: SciencePlan | null
  collectionId?: string; sourceChannel?: string
  failureKind?: 'temporary' | 'action_required'
  retry?: { operation: string; attempt: number; maxAttempts: number; nextRetryAt: string }
  automaticRetry?: { attempt: number; maxAttempts: number; nextRetryAt: string }
  presenterWait?: { requestedAt: string; nextCheckAt: string }
  uploadRetry?: { attempt: number; nextRetryAt: string }
  huashengSync?: { checkedAt: string; status: huasheng.HuashengProductionObservation['status'] | 'error'; message: string; exportProgress?: number; error?: string }
  huashengCheck?: { checkedAt: string; status: huasheng.HuashengProductionObservation['status'] | 'error'; message: string; error?: string }
  uploadCheck?: { checkedAt: string; status: 'complete' | 'pending' | 'needs_attention' | 'error'; message: string }
}
export type ScienceBatchMode = 'drafts' | 'videos' | 'upload'
interface StoredJob extends Omit<ScienceJob, 'sourceVideoUrl' | 'videoUrl' | 'landscapeCoverUrl' | 'portraitCoverUrl' | 'hasUploadAttempt'> {
  version: 1; media: SourceMedia; sourceTitle: string; sourceAuthor: string; plan?: SciencePlan
  transcriptCheckpoint?: mediaTools.ScienceTranscriptCheckpoint
  writingCheckpoint?: ScienceWritingCheckpoint
  productionCompleted?: boolean; productionScriptHash?: string; productionAccountName?: string
  separateIntro?: boolean
  exportDispatched?: boolean; exportTask?: { taskId: string; projectHash: string }; videoPath?: string
  exportRecovery?: { taskId: string; projectHash: string; deadlineAt?: string; zeroSince?: string; retryDispatchedAt?: string;
    lastProgress?: number; lastProgressAt?: string }
  mainVideoPath?: string; presenterPath?: string
  uploadAttempt?: CbaUploadRecoveryCurrent; autoUpload?: boolean; automaticDelivery?: boolean; ownerPid?: number
  uploadRestartPending?: boolean; uploadRetryCount?: number
  uploadHistory?: Array<{ attempt: CbaUploadRecoveryCurrent; archivedAt: string }>
  automaticProduction?: boolean
  coverAssets?: mediaTools.UploadAssets
  coverSourceDigest?: string; coverSequence?: number
  coverRequest?: { revision: number; inputDigest: string; instruction: string }
  coverUploadRevision?: { revision: number }
}
type AccountStore = { list(): { accounts: SocialUploadAccount[]; defaultAccountName: string | null }; get(name: string): SocialUploadAccount }
export interface ScienceWorkflowOptions {
  root?: string
  huashengAccounts?: AccountStore & { browserConfig(name: string): huasheng.HuashengBrowserConfig; readyBrowserConfig?(name: string, options?: { open?: boolean; signal?: AbortSignal }): Promise<huasheng.HuashengBrowserConfig> }
  baijiahaoAccounts?: AccountStore
  download?: typeof mediaTools.downloadScienceSource
  transcribe?: typeof mediaTools.transcribeScienceSource
  prepareAssets?: typeof mediaTools.prepareScienceUploadAssets
  prepareVideo?: typeof import('./science-video-intro.js').prepareScienceVideoWithIntro
  prepareIntroVideo?: typeof import('./science-video-intro.js').prepareScienceVideoWithIntroOnly
  presenterMode?: 'none' | 'sync' | 'musetalk'
  prepareIntroPreview?: typeof import('./science-video-intro.js').prepareScienceVideoIntroPreview
  preparePresenter?: typeof import('./science-presenter-video.js').prepareSciencePresenterVideo
  prepareMusetalkPresenter?: typeof import('./science-musetalk-video.js').prepareScienceMusetalkVideo
  checkMusetalkAvailability?: typeof import('./science-musetalk-video.js').checkScienceMusetalkAvailability
  reviseUploadCovers?: typeof import('./social-auto-upload.js').updateSocialUploadVideoCovers
  rewrite?: typeof recreateScienceScript
  browser?: Pick<typeof huasheng, 'runHuashengBrowserJob'>
  exportApi?: Pick<typeof exporter, 'inspectHuashengProduction' | 'createHuashengExport' | 'inspectHuashengExport' | 'downloadHuashengExport'>
  uploadRuntime?: CbaUploadRecoveryOptions['runtime']
  reviewUpload?: typeof import('./social-auto-upload.js').reviewSocialUpload
  pollMs?: number
  exportStallMs?: number
  retryDelayMs?: number
}
export class ScienceWorkflowError extends Error {
  constructor(message: string, readonly status = 409, readonly retryable = false) { super(message) }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function unsubmittedProduction(job: StoredJob) {
  return !job.projectUrl && !job.productionCompleted && !job.exportDispatched && !job.exportTask && !job.videoPath
    && !job.uploadAttempt && !job.upload && (!job.checkpoint || job.checkpoint === 'opening')
}
const sha256Pattern = /^[a-f0-9]{64}$/i
const liveRuns = new Set<string>()
const heldLockTokens = new Set<string>()
const safeMessage = (error: unknown) => String(error instanceof Error ? error.message : error)
  .replace(/\bBearer\s+\S+|\bsk-[\w.-]+/gi, '[已隐藏]')
  .replace(/(?:api[_-]?key|authorization|token|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, '[会话信息已隐藏]')
  .replace(/https?:\/\/[^\s"'<>]+/g, '[链接]').replace(/\/(?:Users|home|private|tmp|var)\/[^\s"']+/g, '[本地路径]').slice(0, 1200)
function processAlive(pid: number | undefined) {
  if (!Number.isInteger(pid) || !pid || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
function uploadConnectionFailure(message: string) {
  return /连接失败|响应超时|连接中断|连接超时|账号后台连接或检查失败|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|network|socket|timed.out|timeout/i.test(message)
    && !/要求.*验证|请.*登录|请.*登陆|验证码|人机验证|captcha|原编辑页.*变化|版本已变化|指纹不一致/i.test(message)
}
function uploadRequiresAction(message: string) {
  return /登录|登陆|验证码|安全验证|人机验证|验证身份|账号.*(?:不一致|不匹配|变化|无.*权限)|凭据.*(?:变化|不一致)|素材.*(?:变化|不一致|不存在|不可读)|指纹不一致|版本已变化|封面更新尚未完成|找不到水印|额度|配额|余额|点数|次数.*(?:上限|限制|用完)|已达.*上限|无.*(?:上传|发表|发布)权限|平台.*(?:拒绝|禁止|不允许)|违规|captcha|authentication|unauthorized|forbidden|quota|limit.exceed/i.test(message)
}

/** Only explicit actions start work. Persist identities before remote writes so retries resume the same work. */
export class ScienceWorkflowService {
  readonly root: string
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private syncQueues = new Map<string, Promise<void>>()
  private reviewingJobs = new Set<string>()
  private checkingHuasheng = new Map<string, Promise<ScienceJob>>()
  private automaticTimer?: ReturnType<typeof setInterval>
  private executionDb?: Database.Database
  constructor(private readonly options: ScienceWorkflowOptions = {}) { this.root = path.resolve(options.root || root) }
  private get hs() { return this.options.huashengAccounts || getScienceHuashengAccountsService() }
  private get bjh() { return this.options.baijiahaoAccounts || getScienceBaijiahaoAccountsService() }
  private async huashengConfig(name: string, options?: { open?: boolean; signal?: AbortSignal }) {
    return this.hs.readyBrowserConfig ? this.hs.readyBrowserConfig(name, options) : this.hs.browserConfig(name)
  }
  private directory(id: string) {
    if (!/^science-[a-f0-9-]{36}$/.test(id)) throw new ScienceWorkflowError('科普任务编号无效', 400)
    return path.join(this.root, id)
  }
  private filename(id: string) { return path.join(this.directory(id), 'job.json') }
  private write(job: StoredJob) {
    const file = this.filename(job.id)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    job.updatedAt = new Date().toISOString()
    const temporary = `${file}.${randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(job, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file)
  }
  private read(id: string, includeDeleted = false): StoredJob {
    const file = this.filename(id)
    if (!fs.existsSync(file)) throw new ScienceWorkflowError('科普任务不存在', 404)
    const job: StoredJob = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (job.version !== 1 || job.id !== id) throw new ScienceWorkflowError('科普任务记录无法读取', 503)
    if (job.deletedAt && !includeDeleted) throw new ScienceWorkflowError('科普任务已删除', 404)
    if (unsubmittedProduction(job)) {
      const script = stripScienceNarrationIntroduction(job.script)
      if (script !== job.script) {
        const previousHash = digest(job.script)
        job.script = script
        if (job.productionScriptHash === previousHash) job.productionScriptHash = digest(script)
        this.write(job)
      }
    }
    if ((job.status as string) === 'review' || (job.stage as string) === 'review') {
      if ((job.status as string) === 'review') { job.status = 'queued'; job.message = '等待自动制作' }
      if ((job.stage as string) === 'review') job.stage = 'produce'
      this.write(job)
    }
    if (['running', 'queued', 'waiting_remote', 'awaiting_export'].includes(job.status) && (job.status === 'running' || job.ownerPid) && !liveRuns.has(file) && (job.ownerPid === process.pid || !processAlive(job.ownerPid))) {
      job.status = 'paused'; job.message = '本机执行已中断，已保留素材和检查点，可继续原任务'; delete job.ownerPid; delete job.retry; delete job.failureKind
      this.write(job)
    }
    return job
  }
  private modify(id: string, patch: Partial<StoredJob>) { const job = { ...this.read(id), ...patch }; this.write(job); return job }
  private report(id: string, message: string, stage?: ScienceStage) {
    const job = this.read(id)
    job.message = message; if (stage) job.stage = stage
    if (job.logs.at(-1)?.message !== message) job.logs = [...job.logs, { at: new Date().toISOString(), message }].slice(-150)
    this.write(job)
  }
  private reportUploadProgress(id: string, message: string, progress?: SocialUploadProgress) {
    const job = this.read(id), text = safeMessage(message)
    const step = /^[a-z_]{1,40}$/.test(progress?.step || '') ? progress!.step : 'working'
    if (job.uploadProgress?.step !== step || job.uploadProgress.message !== text)
      job.uploadProgress = { step, message: text, updatedAt: new Date().toISOString() }
    if (progress?.step === 'topic_skipped') job.uploadWarnings = [...new Set([...(job.uploadWarnings || []), text])]
    job.message = text
    if (job.logs.at(-1)?.message !== text) job.logs = [...job.logs, { at: job.uploadProgress!.updatedAt, message: text }].slice(-150)
    this.write(job)
  }
  private recordCompositionProgress(id: string, progress: ScienceVideoIntroProgress, signal: AbortSignal) {
    signal.throwIfAborted()
    this.modify(id, { compositionProgress: { ...progress, updatedAt: new Date().toISOString() } })
  }
  private trustedSubmission(job: StoredJob, receipt: SocialUploadResult | null | undefined = job.upload) {
    const attempt = job.uploadAttempt, payload = attempt?.payload
    if (!receipt?.submitted || receipt.saved !== false || !payload || payload.publicationMode !== 'publish'
      || attempt?.accountName !== job.baijiahaoAccountName || payload.accountName !== job.baijiahaoAccountName
      || payload.jobId !== attempt.id || payload.fingerprint !== attempt.fingerprint) return null
    try { return validateCbaUploadReceipt(payload, receipt, false) } catch { return null }
  }
  private publicJob(job: StoredJob): ScienceJob {
    const { version: _version, media, sourceTitle: _title, sourceAuthor: _author, plan, productionCompleted: _complete,
      productionScriptHash: _hash, productionAccountName: _account, separateIntro: _intro, exportDispatched: _dispatch, exportTask: _task,
      exportRecovery: _exportRecovery,
      videoPath, mainVideoPath: _mainVideoPath, presenterPath: _presenterPath, transcriptCheckpoint: _transcriptCheckpoint, writingCheckpoint: _writingCheckpoint, coverAssets, coverSourceDigest: _coverDigest, coverSequence: _coverSequence, coverRequest, coverUploadRevision: _coverUploadRevision, uploadAttempt, uploadHistory: _uploadHistory, uploadRestartPending: _uploadRestartPending, uploadRetryCount: _uploadRetryCount, autoUpload: _auto, automaticDelivery: _delivery, automaticProduction: _production, ownerPid: _pid, ...result } = job
    const asset = (kind: string) => `/api/v1/science-pop/workflow/jobs/${job.id}/assets/${kind}`
    const receipt = result.upload?.submitted ? this.trustedSubmission(job) : result.upload
    const stage = result.upload?.submitted && !receipt ? 'upload' : result.stage
    const status = result.upload?.submitted && !receipt ? 'needs_attention' : result.status === 'needs_attention' && /^(?:已停止本机执行，素材和平台检查点已保留，可继续原任务|本机执行已中断，已保留素材和检查点，可继续原任务|任务已停止，保留原上传检查点)$/.test(result.message)
      ? 'paused' : result.status
    const videoAvailable = Boolean(videoPath && fs.existsSync(videoPath))
    const landscapeAvailable = Boolean(coverAssets?.landscapePath && fs.existsSync(coverAssets.landscapePath))
    const portraitAvailable = Boolean(coverAssets?.portraitPath && fs.existsSync(coverAssets.portraitPath))
    const postersReady = !job.videoCompositionPending && job.coverStyle === SCIENCE_COVER_STYLE && !coverRequest && landscapeAvailable && portraitAvailable
    const uploadStatus: ScienceUploadStatus = receipt?.published ? 'published' : receipt?.submitted ? 'submitted'
      : stage === 'upload' && ['queued', 'running', 'retry_wait'].includes(status) ? status === 'running' ? 'uploading' : 'queued'
      : receipt?.saved ? 'uploaded'
      : !videoAvailable ? 'not_ready' : status === 'paused' ? 'paused'
      : stage === 'upload' ? status === 'queued' ? 'queued' : status === 'running' ? 'uploading'
        : status === 'retry_wait' || uploadAttempt?.status === 'uncertain' && result.failureKind !== 'action_required' ? 'queued' : 'blocked'
      : postersReady ? 'pending' : 'not_ready'
    return { ...result, stage, plan: plan || null, status, upload: receipt ? { staged: receipt.staged, saved: receipt.saved, published: receipt.published,
      submitted: receipt.submitted, publicationStatus: receipt.publicationStatus, articleId: receipt.articleId,
      publishedUrl: receipt.publishedUrl, accountName: receipt.accountName, editorUrl: receipt.editorUrl,
      draftUrl: receipt.draftUrl, targetId: receipt.targetId, engine: receipt.engine } : null,
      sourceVideoUrl: media.videoPath && fs.existsSync(media.videoPath) ? asset('source') : null,
      videoUrl: videoAvailable ? `${asset('video')}?v=${digest(videoPath!).slice(0, 16)}` : null,
      landscapeCoverUrl: landscapeAvailable ? asset('landscape-cover') : null,
      portraitCoverUrl: portraitAvailable ? asset('portrait-cover') : null,
      hasUploadAttempt: Boolean(uploadAttempt), executionActive: this.isExecuting(job) || this.reviewingJobs.has(job.id),
      coverGenerationPending: Boolean(coverRequest), autoUpload: job.autoUpload === true, uploadStatus }
  }
  detail(id: string) { return this.publicJob(this.read(id)) }
  remove(id: string) {
    const job = this.read(id, true)
    if (job.deletedAt) return { id, deleted: true as const }
    if (this.isExecuting(job) || ['running', 'queued', 'retry_wait', 'waiting_remote', 'awaiting_export'].includes(job.status))
      throw new ScienceWorkflowError('任务正在执行或等待自动处理，请先停止任务再删除')
    job.deletedAt = new Date().toISOString()
    job.automaticDelivery = false
    job.automaticProduction = false
    this.write(job)
    return { id, deleted: true as const }
  }
  private all(includeDeleted = false) {
    if (!fs.existsSync(this.root)) return []
    return fs.readdirSync(this.root).filter(name => /^science-[a-f0-9-]{36}$/.test(name) && fs.existsSync(this.filename(name)))
      .map(id => this.read(id, true)).filter(job => includeDeleted || !job.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  overview() { return { jobs: this.all().map(job => this.publicJob(job)), accounts: { huasheng: this.hs.list(), baijiahao: this.bjh.list() } } }
  knownYoutubeIds(): Set<string> {
    return new Set(this.all(true).map(job => parseHistoryYoutubeUrl(job.sourceUrl).videoId).filter((id): id is string => Boolean(id)))
  }
  jobsForCollection(collectionId: string) { return this.all(true).filter(job => job.collectionId === collectionId).map(job => this.publicJob(job)) }
  validateBatchAccounts(mode: ScienceBatchMode, huashengAccountName?: string | null, baijiahaoAccountName?: string | null) {
    const huashengAccount = this.selectedAccount(this.hs, huashengAccountName, true)
    const baijiahaoAccount = this.selectedAccount(this.bjh, baijiahaoAccountName, true)
    if (mode !== 'drafts' && !huashengAccount) throw new ScienceWorkflowError('批量制作需要选择华生账号')
    if (mode === 'upload' && !baijiahaoAccount) throw new ScienceWorkflowError('批量上传需要选择百家号账号')
    return { huashengAccountName: huashengAccount, baijiahaoAccountName: baijiahaoAccount }
  }
  private selectedAccount(store: AccountStore, name: string | null | undefined, useDefault = false) {
    const selected = name === undefined && useDefault ? store.list().defaultAccountName : name
    if (selected) store.get(selected)
    return selected || null
  }
  create(input: z.input<typeof scienceCreateSchema>, options: { defer?: boolean; collectionId?: string; sourceChannel?: string; collectionOnly?: boolean } = {}) {
    const value = scienceCreateSchema.parse(input)
    let source: ReturnType<typeof parseHistoryYoutubeUrl>
    try { source = parseHistoryYoutubeUrl(value.sourceUrl) } catch (error) { throw new ScienceWorkflowError(safeMessage(error), 400) }
    if (source.kind !== 'video') throw new ScienceWorkflowError('请粘贴一条 YouTube 视频链接，每条视频建立一个科普任务', 400)
    if (options.collectionId && !/^science-batch-[a-f0-9-]{36}$/.test(options.collectionId)) throw new ScienceWorkflowError('采集批次编号无效', 400)
    if (options.sourceChannel && parseHistoryYoutubeUrl(options.sourceChannel).kind !== 'channel') throw new ScienceWorkflowError('采集来源必须是 YouTube 频道', 400)
    const existing = this.all(true).find(job => job.sourceUrl === source.url)
    if (existing?.deletedAt) throw new ScienceWorkflowError('该视频任务已删除，来源去重记录保留，不能重复创建')
    if (existing) return this.publicJob(existing)
    const accounts = options.collectionOnly && options.defer && options.collectionId
      ? { huashengAccountName: value.huashengAccountName ?? null, baijiahaoAccountName: value.baijiahaoAccountName ?? null }
      : this.validateBatchAccounts(options.defer ? 'drafts' : value.mode, value.huashengAccountName, value.baijiahaoAccountName)
    const timestamp = new Date().toISOString()
    const job: StoredJob = { version: 1, id: `science-${randomUUID()}`, title: value.title || '新的冷知识科普', sourceUrl: source.url,
      createdAt: timestamp, updatedAt: timestamp, status: 'draft', stage: 'download', message: '已建立科普任务', transcript: '', script: '',
      factChecks: [], sources: [source.url], projectUrl: null, checkpoint: null, upload: null, logs: [], media: {}, sourceTitle: '', sourceAuthor: '',
      ...accounts,
      ...(options.collectionId ? { collectionId: options.collectionId } : {}), ...(options.sourceChannel ? { sourceChannel: parseHistoryYoutubeUrl(options.sourceChannel).url } : {}) }
    this.write(job)
    return options.defer ? this.publicJob(job) : this.produce(job.id, value.mode === 'upload')
  }
  patch(id: string, input: z.infer<typeof sciencePatchSchema>) {
    const patch = sciencePatchSchema.parse(input), job = this.read(id)
    if (['running', 'queued'].includes(job.status)) throw new ScienceWorkflowError('任务正在执行或排队，请等待完成或停止后再编辑')
    const productionLocked = Boolean(job.productionScriptHash || job.checkpoint || job.projectUrl)
    if (!productionLocked && patch.script !== undefined) patch.script = stripScienceNarrationIntroduction(patch.script)
    for (const key of ['script', 'title', 'transcript', 'huashengAccountName'] as const) {
      if (patch[key] !== undefined && patch[key] !== job[key] && productionLocked) throw new ScienceWorkflowError('此文稿和华生账号已绑定制作项目，请继续原项目')
    }
    if (patch.baijiahaoAccountName !== undefined && patch.baijiahaoAccountName !== job.baijiahaoAccountName && job.uploadAttempt)
      throw new ScienceWorkflowError('上传任务已绑定百家号账号，请先核对原账号的草稿')
    if (patch.script !== undefined && patch.script !== job.script) job.writingCheckpoint = undefined
    if (patch.huashengAccountName !== undefined) this.selectedAccount(this.hs, patch.huashengAccountName)
    if (patch.baijiahaoAccountName !== undefined) this.selectedAccount(this.bjh, patch.baijiahaoAccountName)
    if (patch.transcript !== undefined && patch.transcript !== job.transcript) {
      job.plan = undefined; job.factChecks = []; job.script = ''; job.writingCheckpoint = undefined
      job.transcriptCheckpoint = hasScienceTranscriptCheckpoint(job) && patch.transcript.trim()
        ? { ...job.transcriptCheckpoint!, transcriptSha256: digest(patch.transcript) } : undefined
    }
    Object.assign(job, patch)
    if (!productionLocked) { job.stage = job.script ? 'produce' : job.transcript ? 'rewrite' : job.media.videoPath ? 'transcribe' : 'download'; job.status = 'draft' }
    this.write(job)
    return this.publicJob(job)
  }
  private launch(id: string, work: (signal: AbortSignal) => Promise<void>) {
    const job = this.read(id)
    if (this.isExecuting(job)) return this.publicJob(job)
    const release = this.tryExecutionLock(`job:${id}`, id)
    if (!release) return this.publicJob(this.read(id))
    const controller = new AbortController()
    liveRuns.add(this.filename(id))
    try { this.modify(id, { status: 'running', ownerPid: process.pid, failureKind: undefined, retry: undefined }) }
    catch (error) { liveRuns.delete(this.filename(id)); release(); throw error }
    const done = Promise.resolve().then(async () => {
      if (this.root===path.resolve(root)) {
        const {restoreTaskArchivedMedia}=await import('./storage-archive.js')
        await restoreTaskArchivedMedia('science',id)
        controller.signal.throwIfAborted()
      }
      return work(controller.signal)
    }).then(() => { this.modify(id, { automaticRetry: undefined }) }).catch(error => {
      const current = this.read(id), temporary = error?.retryable === true
        || error instanceof exporter.HuashengExportApiError && error.code === 'retryable'
      const qualityRevision = error?.code === 'science_script_revision_pending' && current.stage === 'rewrite'
      const resumableWriting = current.stage === 'rewrite' && (qualityRevision || error?.code === 'science_model_retry_exhausted')
      const attempt = current.automaticRetry?.attempt || 0
      const resumableProject = current.projectUrl && current.checkpoint === 'submitted'
        || !current.projectUrl && (!current.checkpoint || current.checkpoint === 'opening')
      const canResume = !controller.signal.aborted && temporary && resumableProject
        && (current.automaticProduction || current.automaticDelivery) && current.automaticDelivery !== false
        && (resumableWriting || ['produce', 'export'].includes(current.stage)) && !(current.exportDispatched && !current.exportTask)
      if (!controller.signal.aborted && temporary && current.stage === 'upload' && current.automaticDelivery !== false) {
        this.scheduleUploadRetry(id, safeMessage(error))
      } else if (canResume && attempt < 3) {
        const automaticRetry = { attempt: attempt + 1, maxAttempts: 3, nextRetryAt: new Date(Date.now() + (qualityRevision ? 5000 : Math.min(300_000, 30_000 * 2 ** attempt))).toISOString() }
        this.modify(id, { status: 'retry_wait', retry: undefined, automaticRetry, failureKind: 'temporary' })
        this.report(id, qualityRevision ? `当前稿件和修改意见已保存，稍后自动接着修订（${automaticRetry.attempt}/${automaticRetry.maxAttempts}）`
          : resumableWriting ? `写作或核验服务暂时不可用，已保存分析和当前稿件；将自动继续（${automaticRetry.attempt}/${automaticRetry.maxAttempts}）：${safeMessage(error)}`
          : `平台暂时不可用，已保留原项目；将自动继续（${automaticRetry.attempt}/${automaticRetry.maxAttempts}）：${safeMessage(error)}`)
      } else {
        this.modify(id, { status: controller.signal.aborted ? 'paused' : 'needs_attention', retry: undefined, automaticRetry: undefined, uploadRetry: undefined,
          failureKind: controller.signal.aborted ? undefined : temporary ? 'temporary' : 'action_required' })
        this.report(id, controller.signal.aborted ? '已停止本机执行，素材和平台检查点已保留，可继续原任务' : safeMessage(error))
      }
    }).finally(() => {
      try {
        const latest = this.read(id)
        if (['running', 'queued'].includes(latest.status)) latest.status = 'needs_attention'
        delete latest.ownerPid; this.write(latest)
      } finally { liveRuns.delete(this.filename(id)); this.running.delete(id); release() }
    })
    this.running.set(id, { controller, done })
    return this.detail(id)
  }
  private isExecuting(job: StoredJob) {
    return this.running.has(job.id) || liveRuns.has(this.filename(job.id)) || processAlive(job.ownerPid)
  }
  private tryExecutionLock(key: string, id: string): (() => void) | null {
    if (!this.executionDb) {
      const directory = path.join(this.root, '.locks')
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const db = new Database(path.join(directory, 'execution.sqlite'))
      db.pragma('busy_timeout = 1000')
      db.exec('CREATE TABLE IF NOT EXISTS execution_locks (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL, job_id TEXT NOT NULL)')
      this.executionDb = db
    }
    const db = this.executionDb, token = randomUUID()
    // Reclaim and acquisition share one write transaction, including after a process crash.
    const acquired = db.transaction(() => {
      const owner = db.prepare('SELECT pid, token FROM execution_locks WHERE key = ?').get(key) as { pid: number; token: string } | undefined
      if (owner && processAlive(owner.pid) && (owner.pid !== process.pid || heldLockTokens.has(owner.token))) return false
      db.prepare('INSERT OR REPLACE INTO execution_locks (key, pid, token, job_id) VALUES (?, ?, ?, ?)').run(key, process.pid, token, id)
      return true
    }).immediate()
    if (!acquired) return null
    heldLockTokens.add(token)
    return () => {
      try { db.prepare('DELETE FROM execution_locks WHERE key = ? AND token = ?').run(key, token) }
      finally { heldLockTokens.delete(token) }
    }
  }
  /** Serialize mutations for one Huasheng account. The default mutation driver is HTTP;
   * the dedicated browser only supplies the authenticated session and remains the fallback. */
  private async withHuashengAccount<T>(id: string, signal: AbortSignal, driver: 'api' | 'browser', work: () => Promise<T>): Promise<T> {
    const job = this.read(id), key = `browser:${job.huashengAccountName}`
    this.modify(id, { status: 'queued', stage: 'produce' })
    this.report(id, driver === 'api'
      ? '等待花生账号执行锁，准备通过接口创建或确认项目'
      : '等待花生账号执行锁，准备通过浏览器创建或确认项目')
    let release: (() => void) | null = null
    try {
      while (!release) {
        signal.throwIfAborted()
        release = this.tryExecutionLock(key, id)
        if (!release) await delay(100, undefined, { signal })
      }
      signal.throwIfAborted()
      this.modify(id, { status: 'running' })
      this.report(id, driver === 'api' ? '正在通过花生接口创建或确认项目' : '正在通过花生浏览器创建或确认项目')
      return await work()
    } finally { release?.() }
  }
  /** Retry only platform reads or recovery guarded by the original durable checkpoint. */
  private async retryPlatform<T>(id: string, operation: string, signal: AbortSignal, work: () => Promise<T>,
    safe = (error: unknown) => error instanceof exporter.HuashengExportApiError && error.code === 'retryable'
      || (error as { retryable?: boolean })?.retryable === true): Promise<T> {
    const maxAttempts = 4
    try {
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted()
        try { return await work() }
        catch (error) {
          signal.throwIfAborted()
          if (!safe(error)) throw error
          if (attempt >= maxAttempts) throw new ScienceWorkflowError(`${operation}重试 ${maxAttempts} 次仍暂不可用，已保留原任务：${safeMessage(error)}`, 503, true)
          const waitMs = Math.min(30_000, (this.options.retryDelayMs ?? 5000) * 2 ** (attempt - 1))
          this.modify(id, { retry: { operation, attempt: attempt + 1, maxAttempts, nextRetryAt: new Date(Date.now() + waitMs).toISOString() } })
          this.report(id, `${operation}暂时失败，${Math.ceil(waitMs / 1000)} 秒后自动重试（${attempt + 1}/${maxAttempts}）：${safeMessage(error)}`)
          await delay(waitMs, undefined, { signal })
        }
      }
    } finally { this.modify(id, { retry: undefined }) }
  }
  prepare(id: string) {
    const job = this.read(id)
    if (job.productionScriptHash || job.projectUrl || job.checkpoint) throw new ScienceWorkflowError('已开始华生制作，不能重新二创此任务')
    return this.launch(id, async signal => {
      await this.prepareScript(id, signal)
      this.modify(id, { status: 'draft' })
    })
  }
  private async prepareScript(id: string, signal: AbortSignal) {
      let current = this.read(id)
      // Text with a saved provenance checkpoint survives intentional media
      // reclamation. An existing changed file still invalidates its old hash.
      let sourceMediaValid = false
      let sourceMediaChanged = false
      const sourceVideoPath = current.media.videoPath
      const sourceVideoHash = current.media.videoSha256
      if (sourceVideoPath && sourceVideoHash && sha256Pattern.test(sourceVideoHash)) {
        try {
          const info = fs.statSync(sourceVideoPath)
          sourceMediaValid = info.isFile() && info.size > 0
            && await sha256File(sourceVideoPath, signal) === sourceVideoHash
          sourceMediaChanged = !sourceMediaValid
        } catch (error) {
          signal.throwIfAborted()
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          sourceMediaValid = false
        }
      }
      const savedTranscript = hasScienceTranscriptCheckpoint(current) && !sourceMediaChanged
      if ((!sourceMediaValid && !savedTranscript) || !current.transcript) {
        if (!sourceMediaValid && !savedTranscript && (current.transcript || current.script || current.plan || current.factChecks.length)) {
          current = this.modify(id, { transcript: '', script: '', plan: undefined, factChecks: [], transcriptCheckpoint: undefined, writingCheckpoint: undefined })
          this.report(id, '源视频缓存校验失败，已清除旧转写和二创稿，准备重新下载')
        }
        this.report(id, '正在读取 YouTube 视频并下载素材', 'download')
        const download = this.options.download || (await import('./science-workflow-media.js')).downloadScienceSource
        const result = await download({ sourceUrl: current.sourceUrl, directory: this.directory(id), media: current.media }, {
          signal, report: message => this.report(id, message), onMedia: patch => this.modify(id, { media: { ...this.read(id).media, ...patch } }),
        })
        signal.throwIfAborted()
        current = this.modify(id, { media: result.media, sourceTitle: result.title, sourceAuthor: result.author,
          title: current.title === '新的冷知识科普' ? result.title.slice(0, 60) : current.title })
      }
      if (!current.transcript) {
        this.report(id, '正在提取原稿，自动识别视频语言', 'transcribe')
        const transcribe = this.options.transcribe || (await import('./science-workflow-media.js')).transcribeScienceSource
        const transcript = await transcribe({ videoPath: current.media.videoPath!, videoSha256: current.media.videoSha256!, directory: this.directory(id) }, { signal, report: message => this.report(id, message) })
        signal.throwIfAborted()
        if (!transcript.trim() || transcript.length > 120_000) throw new ScienceWorkflowError('原稿为空或过长，请选择较短的视频')
        current = this.modify(id, { transcript, transcriptCheckpoint: this.transcriptCheckpoint(current, transcript) })
      }
      if (!hasScienceTranscriptCheckpoint(current)) current = this.modify(id, { transcriptCheckpoint: this.transcriptCheckpoint(current, current.transcript) })
      current = await this.releaseSourceMedia(current)
      this.report(id, '正在基于原稿调整表达并适度缩写', 'rewrite')
      const result = await (this.options.rewrite || recreateScienceScript)({ transcript: current.transcript, title: current.sourceTitle || current.title,
        sourceUrl: current.sourceUrl, plan: current.plan?.writingOutline ? current.plan : undefined }, { signal, onPlan: plan => this.modify(id, { plan, factChecks: plan.factChecks }),
        checkpoint: current.writingCheckpoint, onCheckpoint: writingCheckpoint => this.modify(id, { writingCheckpoint }),
        onProgress: message => this.report(id, message, 'rewrite'),
        onRetry: retry => this.report(id, `${retry.phase === 'analysis' ? '文稿分析' : retry.phase === 'review' ? '文稿核验' : '二创写作'}服务暂时不可用，${Math.ceil(retry.delayMs / 1000)} 秒后自动重试（${retry.nextAttempt}/${retry.maxAttempts}）：${safeMessage(retry.reason)}`) })
      signal.throwIfAborted()
      this.modify(id, { title: result.title, script: stripScienceNarrationIntroduction(result.script), plan: result.plan, factChecks: result.plan.factChecks })
      this.report(id, '二创完成，继续自动制作', 'produce')
  }
  private transcriptCheckpoint(job: StoredJob, transcript: string): mediaTools.ScienceTranscriptCheckpoint {
    if (!transcript.trim() || !sha256Pattern.test(job.media.videoSha256 || '')) throw new ScienceWorkflowError('来源媒体尚无完整转录检查点')
    return { version: 1, sourceUrl: job.sourceUrl, sourceVideoSha256: job.media.videoSha256!, transcriptSha256: digest(transcript) }
  }
  private async releaseSourceMedia(job: StoredJob) {
    const media = await releaseScienceSourceMedia({ directory: this.directory(job.id), ownerId: job.id, sourceUrl: job.sourceUrl,
      media: job.media, transcript: job.transcript, checkpoint: job.transcriptCheckpoint! })
    return this.modify(job.id, { media })
  }
  async cleanupSourceMedia(id: string) {
    let job = this.read(id)
    if (liveRuns.has(this.filename(id)) || ['running', 'queued'].includes(job.status)) throw new ScienceWorkflowError('任务执行中，暂不清理来源媒体')
    if (!hasScienceTranscriptCheckpoint(job)) {
      if (!job.transcript.trim() || !job.media.videoPath || !sha256Pattern.test(job.media.videoSha256 || '')
        || await sha256File(job.media.videoPath) !== job.media.videoSha256) throw new ScienceWorkflowError('来源媒体尚无完整转录检查点')
      const latest = this.read(id)
      if (liveRuns.has(this.filename(id)) || ['running', 'queued'].includes(latest.status)
        || latest.updatedAt !== job.updatedAt) throw new ScienceWorkflowError('任务已更新，暂不清理来源媒体')
      job = this.modify(id, { transcriptCheckpoint: this.transcriptCheckpoint(job, job.transcript) })
    }
    job = await this.releaseSourceMedia(job)
    return { ...job.media.cleanup }
  }
  produce(id: string, upload?: boolean, options: { automatic?: boolean; waitForPresenter?: boolean } = {}) {
    const job = this.read(id)
    upload ??= job.autoUpload === true
    if (this.isExecuting(job)) return this.publicJob(job)
    const waitForPresenter = options.waitForPresenter === true || Boolean(job.presenterWait)
    if (waitForPresenter) {
      const presenterMode = this.options.presenterMode ?? (process.env.SCIENCE_PRESENTER_MODE?.trim() || 'musetalk')
      if (presenterMode !== 'musetalk' || !job.separateIntro || job.videoCompositionPending === false || !job.videoPath
        || job.uploadAttempt || job.upload) throw new ScienceWorkflowError('只有已下载正片、尚待主播合成且未绑定上传的 MuseTalk 任务可以等待 GPU')
      this.localFile(id, job.videoPath)
      this.localFile(id, job.mainVideoPath || job.videoPath)
    }
    if (job.script.length > 10_000) throw new ScienceWorkflowError('华生文稿最多 10000 字符，请先缩短文稿后再制作')
    if (!job.huashengAccountName) throw new ScienceWorkflowError('请先选择此任务的华生账号')
    this.hs.get(job.huashengAccountName)
    if (upload && !job.baijiahaoAccountName) throw new ScienceWorkflowError('请先选择此任务的百家号账号')
    if (job.baijiahaoAccountName) this.bjh.get(job.baijiahaoAccountName)
    const hash = digest(job.script)
    if (job.productionScriptHash && (job.productionScriptHash !== hash || job.productionAccountName !== job.huashengAccountName)) throw new ScienceWorkflowError('制作文稿或账号与原检查点不一致')
    this.modify(id, { autoUpload: upload, automaticProduction: !job.collectionId, automaticDelivery: true,
      ...(waitForPresenter ? { status: 'waiting_remote' as const, stage: 'export' as const, exportStep: 'presenter' as const,
        presenterWait: job.presenterWait || { requestedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 60_000).toISOString() } } : {}),
      ...(!options.automatic ? { automaticRetry: undefined } : {}) })
    return this.launch(id, async signal => {
      signal.throwIfAborted()
      if (waitForPresenter) {
        this.modify(id, { stage: 'export', exportStep: 'presenter', automaticRetry: undefined })
        try {
          const check = this.options.checkMusetalkAvailability || (await import('./science-musetalk-video.js')).checkScienceMusetalkAvailability
          const availability = await check({ signal })
          signal.throwIfAborted()
          if (!availability.ready) {
            this.modify(id, { status: 'waiting_remote', presenterWait: { ...this.read(id).presenterWait!, nextCheckAt: new Date(Date.now() + 60_000).toISOString() },
              retry: undefined, automaticRetry: undefined, failureKind: undefined })
            this.report(id, `等待远程主播 GPU 就绪，约 60 秒后自动检查：${safeMessage(availability.message)}`, 'export')
            return
          }
          this.modify(id, { presenterWait: undefined })
        } catch (error) {
          if (!signal.aborted) this.modify(id, { presenterWait: undefined })
          throw error
        }
      }
      if (!this.read(id).script.trim()) await this.prepareScript(id, signal)
      signal.throwIfAborted()
      let current = this.read(id)
      if (!current.script.trim() || current.script.length > 10_000) throw new ScienceWorkflowError('华生文稿需为 1 至 10000 字符')
      signal.throwIfAborted()
      current = this.read(id)
      if (!current.huashengAccountName) throw new ScienceWorkflowError('请先选择此任务的华生账号')
      this.modify(id, { status: 'running', productionScriptHash: digest(current.script), productionAccountName: current.huashengAccountName,
        separateIntro: current.separateIntro || unsubmittedProduction(current),
        stage: current.videoPath ? 'covers' : 'produce', checkpoint: current.checkpoint || 'opening' })
      if (!current.videoPath) { this.modify(id, { status: 'queued' }); this.report(id, '正在核验花生账号，随后继续原制作流程') }
      await this.produceVideo(id, signal)
      signal.throwIfAborted()
      if (upload) { this.modify(id, { status: 'running' }); await this.uploadVideo(id, signal) }
      this.modify(id, { automaticProduction: false, automaticDelivery: false })
    })
  }
  private async produceVideo(id: string, signal: AbortSignal, inspection?: {
    browserConfig: huasheng.HuashengBrowserConfig; state: huasheng.HuashengProductionObservation
  }) {
    let job = this.read(id)
    const driver = this.options.browser ? 'browser' : 'api'
    const browser = this.options.browser || { runHuashengBrowserJob: runHuashengJob }, api = this.options.exportApi || exporter
    let browserConfig = inspection?.browserConfig
    let initialObservation = inspection?.state ?? null
    if (job.projectUrl && !initialObservation) {
      browserConfig = await this.retryPlatform(id, '花生账号身份核验', signal,
        () => this.huashengConfig(job.huashengAccountName!, { open: true, signal }))
      initialObservation = await this.retryPlatform(id, '花生原项目音色核验', signal, () => api.inspectHuashengProduction({
        projectUrl: job.projectUrl!, checkpoint: job.checkpoint, script: job.script, browserConfig, signal, expectedVoice: SCIENCE_HUASHENG_VOICE,
      }))
    }
    if (job.videoPath && fs.existsSync(job.videoPath)) {
      await this.prepareCovers(id, signal)
      this.modify(id, { status: 'ready' })
      this.report(id, '成片和横竖封面已就绪，可预览或上传到所选百家号', 'covers')
      return
    }
    browserConfig ??= await this.retryPlatform(id, '花生账号身份核验', signal,
      () => this.huashengConfig(job.huashengAccountName!, { open: true, signal }))
    this.modify(id, { status: 'running' })
    const wait = () => delay(this.options.pollMs ?? 15_000, undefined, { signal })
    if (!job.productionCompleted) {
      this.report(id, '正在使用所选华生账号制作科普视频', 'produce')
      // Existing projects are inspected before any further mutation.
      const inspect = () => this.retryPlatform(id, '华生制作状态查询', signal, () => api.inspectHuashengProduction({ projectUrl: job.projectUrl!, checkpoint: job.checkpoint, script: job.script, browserConfig, signal,
        expectedVoice: SCIENCE_HUASHENG_VOICE }))
      let observation = initialObservation
      if (!observation || observation.status === 'not_started' && job.checkpoint !== 'submitted') {
        try {
          const result = await this.withHuashengAccount(id, signal, driver, () => browser.runHuashengBrowserJob({ jobId: id, script: job.script,
            voiceId: SCIENCE_HUASHENG_VOICE.id, voiceType: SCIENCE_HUASHENG_VOICE.type,
            projectUrl: job.projectUrl, checkpoint: job.checkpoint, browserConfig, signal,
            onCheckpoint: async patch => { this.modify(id, { checkpoint: patch.checkpoint, ...(patch.projectUrl ? { projectUrl: patch.projectUrl } : {}) }); this.report(id, patch.message) },
          }))
          this.modify(id, { projectUrl: result.projectUrl })
          observation = null
        } catch (error) {
          signal.throwIfAborted()
          job = this.read(id)
          if (!(error instanceof huasheng.HuashengBrowserError)
            || !['browser_unavailable', 'timeout'].includes(error.code)
            || !job.projectUrl || !['confirm_pending', 'submitted'].includes(job.checkpoint || '')) throw error
          // The confirmation can succeed before the editor disconnects. Reconcile
          // its saved project and full script through the API, never replay the click.
          this.report(id, '确认后的页面连接中断，正在通过接口核对原项目制作状态')
          observation = await inspect()
          if (observation.status === 'not_started') {
            if (job.checkpoint !== 'submitted') throw error
          } else {
            job = this.modify(id, { checkpoint: 'submitted' })
            this.report(id, '接口已确认原项目进入制作，继续查询原任务')
          }
        }
      }
      const until = Date.now() + 3 * 60 * 60_000
      for (;;) {
        signal.throwIfAborted(); job = this.read(id)
        const state = observation ?? await inspect()
        this.modify(id, { huashengSync: { checkedAt: new Date().toISOString(), status: state.status, message: safeMessage(state.message) } })
        if (state.status === 'completed') { job = this.modify(id, { productionCompleted: true }); break }
        if (state.status === 'not_started' && job.checkpoint !== 'submitted') throw new ScienceWorkflowError('华生尚未开始制作，请打开原项目检查后继续')
        // Accepted submissions can remain at stage zero while the platform
        // schedules work. Keep observing that project instead of reconfirming.
        this.modify(id, { status: 'running' })
        this.report(id, state.status === 'not_started' ? '原项目已提交，等待华生制作状态同步，继续查询原任务' : state.message)
        if (Date.now() > until) throw new ScienceWorkflowError('华生仍在制作或同步，项目已保留，可稍后继续查询', 503, true)
        await wait()
        observation = null
      }
    }
    this.modify(id, { status: 'running' })
    this.modify(id, { exportStep: 'platform' })
    this.report(id, '华生制作完成，正在导出成片', 'export')
    job = this.read(id)
    if (!job.exportTask) {
      if (job.exportDispatched) throw new ScienceWorkflowError('上次导出已发送但未收到任务编号，请在原华生项目核对导出记录')
      try {
        const exportTask = await this.retryPlatform(id, '华生导出准备', signal, () => api.createHuashengExport({ projectUrl: job.projectUrl!, browserConfig, signal,
          onDispatched: () => { this.modify(id, { exportDispatched: true }) } }),
        error => error instanceof exporter.HuashengExportApiError && error.code === 'retryable' && !this.read(id).exportDispatched)
        job = this.modify(id, { exportTask })
      } catch (error) {
        if (error instanceof exporter.HuashengExportApiError && error.requestRejected) this.modify(id, { exportDispatched: false })
        throw error
      }
    }
    const task = job.exportTask!
    const priorRecovery = this.read(id).exportRecovery
    const boundRecovery = priorRecovery?.taskId === task.taskId && priorRecovery.projectHash === task.projectHash ? priorRecovery : { ...task }
    const savedDeadline = Date.parse(boundRecovery.deadlineAt || '')
    const until = Number.isFinite(savedDeadline) ? savedDeadline : Date.now() + 90 * 60_000
    if (!Number.isFinite(savedDeadline)) this.modify(id, { exportRecovery: { ...boundRecovery, deadlineAt: new Date(until).toISOString() } })
    for (;;) {
      signal.throwIfAborted()
      const { info, result } = await this.retryPlatform(id, '华生导出查询与下载', signal, async () => {
        this.modify(id, { exportStep: 'platform' })
        const info = await api.inspectHuashengExport({ projectUrl: job.projectUrl!, ...job.exportTask!, browserConfig, signal })
        this.modify(id, { huashengSync: { checkedAt: new Date().toISOString(), status: 'completed',
          message: info.progress === 100 && info.url ? '花生原导出已完成，正在下载成片' : `花生正在导出：${Math.round(info.progress)}%`, exportProgress: info.progress } })
        if (info.progress !== 100 || !info.url) return { info, result: null }
        this.modify(id, { status: 'running' })
        this.modify(id, { exportStep: 'download' })
        this.report(id, '正在下载华生成片', 'export')
        // Requery on every retry so an expired URL is replaced while the saved
        // task, project hash and partial download continue to be reused.
        const result = await api.downloadHuashengExport({ projectUrl: job.projectUrl!, projectHash: job.exportTask!.projectHash, url: info.url,
          filename: info.filename, browserConfig, signal }, { root: path.join(this.directory(id), 'exports') })
        return { info, result }
      })
      if (result) {
        signal.throwIfAborted()
        this.modify(id, { videoPath: result.filePath, ...(job.separateIntro ? { mainVideoPath: result.filePath } : {}) })
        await this.prepareCovers(id, signal)
        this.modify(id, { status: 'ready' })
        this.report(id, '成片和横竖封面已就绪，可预览或上传到所选百家号', 'covers')
        return
      }
      if (Date.now() >= until) throw new ScienceWorkflowError('原导出等待已超过 90 分钟，任务编号已保留，可稍后继续核对原任务')
      const saved = this.read(id).exportRecovery
      let recovery = saved?.taskId === task.taskId && saved.projectHash === task.projectHash ? saved : { ...task }
      const now = Date.now(), stallMs = this.options.exportStallMs ?? 5 * 60_000
      const changed = recovery.lastProgress !== info.progress
      if (changed || !Number.isFinite(Date.parse(recovery.lastProgressAt || ''))) {
        recovery = { ...recovery, lastProgress: info.progress,
          lastProgressAt: info.progress === 0 && recovery.zeroSince || new Date(now).toISOString() }
      }
      if (info.progress === 0 && !recovery.zeroSince) recovery = { ...recovery, zeroSince: new Date(now).toISOString() }
      else if (info.progress > 0 && recovery.zeroSince) recovery = { ...recovery, zeroSince: undefined }
      this.modify(id, { exportRecovery: recovery })
      const stalledSince = info.progress === 0 ? recovery.retryDispatchedAt || recovery.zeroSince : recovery.lastProgressAt
      if ((!changed || info.progress === 0) && now - Date.parse(stalledSince!) >= stallMs) {
        if (recovery.retryDispatchedAt) {
          const message = `原导出已自动重试一次，当前仍为 ${Math.round(info.progress)}%，将在原 90 分钟期限内继续查询，完成后自动下载`
          this.modify(id, { status: 'running' })
          if (this.read(id).message !== message) this.report(id, message, 'export')
          await wait()
          continue
        } else {
          const state = await this.retryPlatform(id, '花生原导出恢复核验', signal, () => api.inspectHuashengProduction({
            projectUrl: job.projectUrl!, checkpoint: job.checkpoint, script: job.script, browserConfig, signal, expectedVoice: SCIENCE_HUASHENG_VOICE,
          }))
          if (state.status !== 'completed') throw new ScienceWorkflowError('花生原项目制作状态已变化，未重试导出，请检查原项目')
          const latest = await this.retryPlatform(id, '花生原导出恢复查询', signal, () => api.inspectHuashengExport({
            projectUrl: job.projectUrl!, ...task, browserConfig, signal,
          }))
          if (latest.progress !== info.progress || latest.progress === 100 && latest.url) continue
          this.report(id, `原导出持续停在 ${Math.round(info.progress)}%，已核对原稿和音色，正在自动重试一次原项目导出`, 'export')
          // Persist before POST: a lost response or process restart must not replay it.
          let retried: typeof task
          try {
            retried = await api.createHuashengExport({ projectUrl: job.projectUrl!, browserConfig, signal,
              onDispatched: () => {
                const dispatchedAt = new Date().toISOString()
                this.modify(id, { exportRecovery: { ...recovery, retryDispatchedAt: dispatchedAt,
                  lastProgress: info.progress, lastProgressAt: dispatchedAt } })
              },
            })
          } catch (error) {
            if (error instanceof exporter.HuashengExportApiError && error.requestRejected)
              this.modify(id, { exportRecovery: recovery })
            throw error
          }
          if (retried.taskId !== task.taskId || retried.projectHash !== task.projectHash)
            throw new ScienceWorkflowError('重试返回的导出任务或版本与原记录不一致，已保留原导出，未替换成片')
          this.report(id, '原项目导出已重新触发，任务编号和版本保持一致，继续查询并自动下载', 'export')
          continue
        }
      }
      this.modify(id, { status: 'running' })
      this.report(id, `花生正在导出：${Math.round(info.progress)}%，完成后自动下载`)
      await wait()
    }
  }
  previewIntro(id: string) {
    const job = this.read(id)
    if (this.isExecuting(job)) return this.publicJob(job)
    if (!job.separateIntro || job.uploadAttempt || job.upload) throw new ScienceWorkflowError('当前任务不支持单独补片头预览，已保留原制作和上传记录')
    if (job.videoCompositionPending === false) return this.publicJob(job)
    return this.launch(id, async signal => {
      await this.prepareIntroPreview(id, signal)
      this.modify(id, { status: 'needs_attention', failureKind: 'action_required' })
      this.report(id, '固定片头已拼接；视频合成尚未完成，请继续原制作任务', 'export')
    })
  }
  covers(id: string, input: z.infer<typeof scienceCoversSchema> = {}, options: { automatic?: boolean } = {}) {
    const request = scienceCoversSchema.parse(input), job = this.read(id)
    if (job.status === 'running') return this.publicJob(job)
    if (job.videoCompositionPending) throw new ScienceWorkflowError('请先继续制作，完成视频合成后再生成封面')
    if (!job.videoPath || !fs.existsSync(job.videoPath)) throw new ScienceWorkflowError('请先完成成片下载，再生成横竖封面')
    const regenerate = request.newVersion === true || request.regenerate === true || request.instruction !== undefined && request.instruction !== (job.coverInstruction || '')
    if (regenerate && (job.upload?.submitted || job.upload?.published || job.uploadAttempt?.result?.submitted))
      throw new ScienceWorkflowError('作品已提交或已发表，不能重新生成并替换封面')
    if (job.coverUploadRevision) throw new ScienceWorkflowError('原编辑页封面更换尚未完成，请先继续原上传任务，再生成下一版')
    return this.launch(id, async signal => {
      // A standalone cover preview requires a new explicit delivery action.
      if (!options.automatic) this.modify(id, { automaticDelivery: false, automaticProduction: false, automaticRetry: undefined, uploadRetry: undefined })
      await this.prepareCovers(id, signal, { ...request, regenerate })
      if (job.uploadAttempt && !regenerate && !job.coverRequest) {
        this.modify(id, { status: job.status, stage: job.stage, message: job.message, failureKind: job.failureKind })
      } else {
        this.modify(id, { status: 'ready' })
        this.report(id, '独立横竖标题海报已就绪，可预览、重新生成或上传；本次未修改平台作品', 'covers')
      }
    })
  }
  private coverContentDigest(job: StoredJob, instruction = job.coverInstruction || '') {
    return digest(JSON.stringify([job.title, job.script, job.sourceTitle, instruction, SCIENCE_COVER_COMPOSITION_VERSION]))
  }
  private async inspectPreparedCovers(id: string, signal: AbortSignal) {
    const job = this.read(id), assets = job.coverAssets
    if (job.coverRequest || job.coverStyle !== SCIENCE_COVER_STYLE || !assets
      || job.coverSourceDigest !== this.coverContentDigest(job))
      throw new ScienceWorkflowError('请先生成并完成独立标题封面，再上传发表')
    const { inspectScienceUploadAssets } = await import('./science-workflow-media.js')
    const inspected = await inspectScienceUploadAssets({ videoPath: this.localFile(id, job.videoPath),
      landscapePath: this.localFile(id, assets.landscapePath), portraitPath: this.localFile(id, assets.portraitPath) }, { signal })
    if (inspected.videoSha256 !== assets.videoSha256 || inspected.landscapeSha256 !== assets.landscapeSha256 || inspected.portraitSha256 !== assets.portraitSha256)
      throw new ScienceWorkflowError('制作版本已变化（封面或成片文件不一致），请先重新生成封面，再上传发表')
    return inspected
  }
  private async prepareIntroPreview(id: string, signal: AbortSignal) {
    const job = this.read(id), intro = await import('./science-video-intro.js')
    this.modify(id, { exportStep: 'compose', compositionProgress: undefined })
    const directory = path.join(this.directory(id), 'intro')
    const main = await intro.resolveScienceVideoIntroSource({ videoPath: this.localFile(id, job.mainVideoPath || job.videoPath), directory }, { signal })
    this.modify(id, { mainVideoPath: main.videoPath })
    this.report(id, '正在拼接固定片头预览，随后继续视频合成', 'export')
    const prepare = this.options.prepareIntroPreview || intro.prepareScienceVideoIntroPreview
    const preview = await prepare({ videoPath: main.videoPath, directory }, { signal, report: message => this.report(id, message, 'export'),
      onProgress: progress => this.recordCompositionProgress(id, progress, signal) })
    signal.throwIfAborted()
    if (preview.sourceSha256 !== main.sourceSha256) throw new ScienceWorkflowError('片头预览与原正片版本不一致，已保留原任务')
    this.modify(id, { videoPath: preview.videoPath, videoCompositionPending: true,
      ...(preview.videoPath !== job.videoPath ? { coverAssets: undefined, coverSourceDigest: undefined, coverRequest: undefined } : {}) })
  }
  private async prepareCovers(id: string, signal: AbortSignal, input: z.infer<typeof scienceCoversSchema> = {}): Promise<mediaTools.UploadAssets> {
    let job = this.read(id)
    if (job.separateIntro && job.videoCompositionPending !== false && !job.uploadAttempt && !job.upload) {
      this.modify(id, { exportStep: 'compose', compositionProgress: undefined })
      const intro = await import('./science-video-intro.js')
      const directory = path.join(this.directory(id), 'intro')
      const onProgress = (progress: ScienceVideoIntroProgress) => this.recordCompositionProgress(id, progress, signal)
      const main = await intro.resolveScienceVideoIntroSource({ videoPath: this.localFile(id, job.mainVideoPath || job.videoPath), directory }, { signal })
      job = this.modify(id, { mainVideoPath: main.videoPath })
      let video: Awaited<ReturnType<typeof intro.prepareScienceVideoWithIntro>>
      const presenterMode = this.options.presenterMode ?? (process.env.SCIENCE_PRESENTER_MODE?.trim() || 'musetalk')
      if (!['none', 'sync', 'musetalk'].includes(presenterMode)) throw new ScienceWorkflowError('SCIENCE_PRESENTER_MODE 必须为 musetalk 或 none')
      if (presenterMode === 'musetalk') {
        let presenter: { presenterPath: string; sourceSha256: string }
        try {
          this.modify(id, { exportStep: 'presenter' })
          this.report(id, '正在使用远程 MuseTalk 生成正文同步口型，复用缓存主播素材', 'export')
          const generate = this.options.prepareMusetalkPresenter || (await import('./science-musetalk-video.js')).prepareScienceMusetalkVideo
          presenter = await generate({ videoPath: main.videoPath, directory: path.join(this.directory(id), 'presenter-musetalk') },
            { signal, report: message => this.report(id, message, 'export') })
          signal.throwIfAborted()
          if (presenter.sourceSha256 !== main.sourceSha256) throw new ScienceWorkflowError('MuseTalk 主播与正片版本不一致')
        } catch (error) {
          signal.throwIfAborted()
          const message = safeMessage(error)
          const failure = error as { status?: number; code?: string; cause?: { code?: string } }
          const connection = `${message} ${failure?.cause?.code || failure?.code || ''}`
          const retryable = !/不一致|不匹配|校验失败|缺失|改变|发生变化|不符合要求|mismatch/i.test(message)
            && (uploadConnectionFailure(connection) || /fetch failed|terminated|ENOTFOUND|UND_ERR_|处理时限|尚未就绪/i.test(connection)
              || failure?.status === 408 || failure?.status === 429 || failure?.status && failure.status >= 500 && failure.status <= 599)
          throw new ScienceWorkflowError(`MuseTalk 主播尚未完成，已保留原正片和任务检查点，暂停合成及上传：${message}`, retryable ? 503 : 409, Boolean(retryable))
        }
        this.modify(id, { exportStep: 'compose' })
        const prepare = this.options.prepareVideo || intro.prepareScienceVideoWithIntro
        video = await prepare({ videoPath: main.videoPath, directory },
          { signal, presenterPath: presenter.presenterPath, presenterFraming: 'half-body', report: message => this.report(id, message, 'export'), onProgress })
        signal.throwIfAborted()
        if (video.sourceSha256 !== main.sourceSha256) throw new ScienceWorkflowError('视频合成与原正片版本不一致，已保留原任务')
        this.modify(id, { presenterPath: presenter.presenterPath })
      } else if (presenterMode === 'sync') {
        if (!job.presenterPath || job.videoCompositionPending) {
          await this.prepareIntroPreview(id, signal)
          job = this.read(id)
        }
        this.modify(id, { exportStep: 'presenter' })
        this.report(id, '正在根据正片旁白生成同步口型的主播视频', 'export')
        const generate = this.options.preparePresenter || (await import('./science-presenter-video.js')).prepareSciencePresenterVideo
        const presenter = await generate({ videoPath: main.videoPath, directory: path.join(this.directory(id), 'presenter') },
          { signal, report: message => this.report(id, message, 'export') })
        signal.throwIfAborted()
        if (presenter.sourceSha256 !== main.sourceSha256) throw new ScienceWorkflowError('主播口播与正片版本不一致，请继续原任务重新核对')
        this.modify(id, { presenterPath: presenter.presenterPath, exportStep: 'compose', compositionProgress: undefined })
        const prepare = this.options.prepareVideo || intro.prepareScienceVideoWithIntro
        video = await prepare({ videoPath: main.videoPath, directory },
          { signal, presenterPath: presenter.presenterPath, report: message => this.report(id, message, 'export'), onProgress })
      } else {
        this.report(id, '正在本地拼接固定片头与正文，正文不叠加主播圆窗', 'export')
        const prepare = this.options.prepareIntroVideo || intro.prepareScienceVideoWithIntroOnly
        video = await prepare({ videoPath: main.videoPath, directory },
          { signal, report: message => this.report(id, message, 'export'), onProgress })
        signal.throwIfAborted()
        if (video.sourceSha256 !== main.sourceSha256) throw new ScienceWorkflowError('视频合成与原正片版本不一致，已保留原任务')
        this.modify(id, { presenterPath: undefined })
      }
      signal.throwIfAborted()
      job = this.modify(id, { videoPath: video.videoPath, videoCompositionPending: false,
        ...(video.videoPath !== job.videoPath ? { coverAssets: undefined, coverSourceDigest: undefined, coverRequest: undefined } : {}) })
    }
    if (job.exportStep) job = this.modify(id, { exportStep: undefined })
    if (job.uploadAttempt && !input.regenerate && !job.coverRequest && job.coverStyle === SCIENCE_COVER_STYLE && job.coverAssets
      && job.coverAssets.landscapePath !== job.uploadAttempt.payload?.landscapePath) return this.inspectPreparedCovers(id, signal)
    // An ordinary inspection must never rewrite files bound to a dispatched upload.
    if (job.uploadAttempt && !input.regenerate && !job.coverRequest) {
      this.report(id, '正在核验原上传任务的横竖封面', 'covers')
      const payload = job.uploadAttempt.payload
      if (!payload?.videoPath || !payload.landscapePath || !payload.portraitPath) throw new ScienceWorkflowError('原上传任务缺少素材记录，请先核对原草稿')
      const { inspectScienceUploadAssets } = await import('./science-workflow-media.js')
      const assets = await inspectScienceUploadAssets({ videoPath: this.localFile(id, payload.videoPath),
        landscapePath: this.localFile(id, payload.landscapePath), portraitPath: this.localFile(id, payload.portraitPath) }, { signal })
      const fingerprint = digest(JSON.stringify([job.baijiahaoAccountName, job.title, job.script, assets.videoSha256, assets.landscapeSha256, assets.portraitSha256]))
      if (fingerprint !== job.uploadAttempt.inputDigest || fingerprint !== job.uploadAttempt.fingerprint)
        throw new ScienceWorkflowError('原上传素材已变化，请先核对原草稿；已保留原素材和上传检查点')
      this.modify(id, { coverAssets: assets })
      return assets
    }
    const instruction = input.instruction ?? job.coverInstruction ?? ''
    const inputDigest = this.coverContentDigest(job, instruction)
    if (!input.regenerate && !job.coverRequest && job.coverStyle === SCIENCE_COVER_STYLE && job.coverSourceDigest === inputDigest) {
      try { return await this.inspectPreparedCovers(id, signal) } catch { signal.throwIfAborted() }
    }
    if (input.newVersion || !job.coverRequest || job.coverRequest.inputDigest !== inputDigest) {
      const revision = Math.max(job.coverSequence || 0, job.coverRevision || 0, job.coverRequest?.revision || 0) + 1
      job = this.modify(id, { coverInstruction: instruction, coverSequence: revision, coverRequest: { revision, inputDigest, instruction } })
    }
    const request = job.coverRequest!
    this.report(id, `正在设计并生成第 ${request.revision} 版横竖标题海报`, 'covers')
    const prepare = this.options.prepareAssets || (await import('./science-workflow-media.js')).prepareScienceUploadAssets
    const directory = path.join(this.directory(id), 'covers', `poster-${request.revision}-${request.inputDigest.slice(0, 16)}`)
    fs.mkdirSync(directory, { recursive: true })
    const assets = await prepare({ videoPath: this.localFile(id, job.videoPath), directory,
      title: job.title, script: job.script, sourceTitle: job.sourceTitle, instruction, revision: request.revision },
      { signal, report: message => this.report(id, message, 'covers') })
    signal.throwIfAborted()
    this.modify(id, { coverAssets: assets, coverStyle: SCIENCE_COVER_STYLE, coverSourceDigest: inputDigest,
      coverRevision: request.revision, coverInstruction: instruction, coverRequest: undefined })
    signal.throwIfAborted()
    return assets
  }
  private async syncPreparedUploadCovers(id: string, signal: AbortSignal, assets: mediaTools.UploadAssets) {
    const job = this.read(id)
    if (!job.uploadAttempt) return
    const desired = digest(JSON.stringify([job.baijiahaoAccountName, job.title, job.script, assets.videoSha256, assets.landscapeSha256, assets.portraitSha256]))
    if (desired === job.uploadAttempt.inputDigest && assets.landscapePath === job.uploadAttempt.payload?.landscapePath
      && assets.portraitPath === job.uploadAttempt.payload?.portraitPath && !job.coverUploadRevision) return
    let revisedAttempt = job.uploadAttempt, revisedResult = job.upload
    if (job.uploadAttempt) {
      const previous = job.uploadAttempt.payload
      if (!previous?.videoPath || !previous.landscapePath || !previous.portraitPath) throw new ScienceWorkflowError('原上传素材记录缺失，不能替换封面')
      if (job.uploadAttempt.result?.submitted || job.upload?.submitted || job.upload?.saved || job.uploadAttempt.result?.saved)
        throw new ScienceWorkflowError('原作品已提交或保存，不能在未发表编辑页替换封面')
      const { inspectScienceUploadAssets } = await import('./science-workflow-media.js')
      const original = await inspectScienceUploadAssets({ videoPath: this.localFile(id, previous.videoPath),
        landscapePath: this.localFile(id, previous.landscapePath), portraitPath: this.localFile(id, previous.portraitPath) }, { signal })
      const previousDigest = digest(JSON.stringify([job.baijiahaoAccountName, job.title, job.script, original.videoSha256, original.landscapeSha256, original.portraitSha256]))
      if (previousDigest !== job.uploadAttempt.inputDigest || previousDigest !== job.uploadAttempt.fingerprint || original.videoSha256 !== assets.videoSha256)
        throw new ScienceWorkflowError('原上传视频或素材绑定已变化，不能替换封面')
      const fingerprint = digest(JSON.stringify([job.baijiahaoAccountName, job.title, job.script, assets.videoSha256, assets.landscapeSha256, assets.portraitSha256]))
      const payload = { ...previous, landscapePath: assets.landscapePath, portraitPath: assets.portraitPath, fingerprint }
      if (job.uploadAttempt.dispatched) {
        this.modify(id, { coverUploadRevision: { revision: job.coverRevision! } })
        this.report(id, '正在原百家号编辑页上传已生成的横竖海报，保留原视频', 'upload')
        const revise = this.options.reviseUploadCovers || (await import('./social-auto-upload.js')).updateSocialUploadVideoCovers
        const receipt = await revise(payload, previous, { onProgress: message => this.report(id, message, 'upload') })
        if (receipt.videoSha256 !== assets.videoSha256 || receipt.landscapeSha256 !== assets.landscapeSha256 || receipt.portraitSha256 !== assets.portraitSha256)
          throw new ScienceWorkflowError('平台封面回执与新海报不匹配，请继续原封面修订任务')
        rebindCbaUploadCovers(previous, payload, receipt.result)
        revisedResult = receipt.result
        revisedAttempt = { ...job.uploadAttempt, payload, fingerprint, inputDigest: fingerprint, result: receipt.result, status: 'queued' }
      } else {
        const runtime = this.options.uploadRuntime || await import('./social-auto-upload.js')
        const checkpoint = await runtime.inspectSocialUploadCheckpoint(previous)
        if (checkpoint.action !== 'upload') throw new ScienceWorkflowError('原上传已产生平台检查点，请先核对原编辑页，不能直接替换素材绑定')
        revisedAttempt = { ...job.uploadAttempt, payload, fingerprint, inputDigest: fingerprint, status: 'queued' }
      }
    }
    // Commit an acknowledged platform revision before honoring a late cancellation.
    this.modify(id, { uploadAttempt: revisedAttempt, upload: revisedResult, coverUploadRevision: undefined })
    signal.throwIfAborted()
  }
  upload(id: string) {
    const job = this.read(id)
    if (job.status === 'running') return this.publicJob(job)
    // A submitted publication is a durable terminal checkpoint. Re-clicking
    // upload must only normalize the task state, never enter the bridge again.
    if (job.upload?.submitted === true && job.upload.saved === false) {
      if (!this.trustedSubmission(job)) {
        this.modify(id, { status: 'needs_attention', stage: 'upload', failureKind: 'action_required', uploadRetry: undefined })
        this.report(id, '原上传回执与绑定账号或发表信息不一致，请检查原账号后重试')
        throw new ScienceWorkflowError('原上传回执与绑定账号或发表信息不一致，不能认定已提交')
      }
      if (job.status !== 'completed' || job.stage !== 'completed') {
        this.modify(id, { status: 'completed', stage: 'completed', failureKind: undefined, retry: undefined, uploadRetry: undefined, uploadRestartPending: undefined })
        this.report(id, job.upload.published ? '已发表并核验所选百家号账号的作品' : '已提交百家号，等待平台审核', 'completed')
      }
      return this.detail(id)
    }
    if (!job.videoPath || !fs.existsSync(job.videoPath)) throw new ScienceWorkflowError('请先完成华生制作和成片下载')
    if (job.videoCompositionPending) throw new ScienceWorkflowError('当前为带片头的预览，请先继续制作，完成视频合成后再发表')
    if (!job.baijiahaoAccountName) throw new ScienceWorkflowError('请先选择百家号账号')
    this.bjh.get(job.baijiahaoAccountName)
    this.modify(id, { autoUpload: true, automaticDelivery: true })
    return this.launch(id, signal => this.uploadVideo(id, signal))
  }
  private scheduleUploadRetry(id: string, message: string) {
    const job = this.read(id), attempt = (job.uploadRetryCount || 0) + 1
    const waitMs = Math.min(300_000, 30_000 * 2 ** Math.min(attempt - 1, 4))
    this.modify(id, { status: 'retry_wait', stage: 'upload', autoUpload: true, automaticDelivery: true,
      automaticRetry: undefined, uploadRetry: { attempt, nextRetryAt: new Date(Date.now() + waitMs).toISOString() },
      uploadRetryCount: attempt, uploadRestartPending: undefined, failureKind: 'temporary' })
    const reason = message.replace(/；(?:已保留原检查点，不重复上传或保存|.*不重复上传).*$/, '')
    this.report(id, `未取得明确的上传结果，${Math.ceil(waitMs / 1000)} 秒后自动重试上传（第 ${attempt} 次）：${reason}`)
  }
  private uploadAttemptForReview(id: string) {
    const job = this.read(id), attempt = job.uploadAttempt
    if (!attempt?.payload) throw new ScienceWorkflowError('此任务尚无上传记录，请先完成封面后再发表')
    const originalId = `${id}-baijiahao`, retryPrefix = `${originalId}-retry-`
    const belongsToJob = attempt.id === originalId || attempt.id.startsWith(retryPrefix)
      && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(attempt.id.slice(retryPrefix.length))
    if (!job.baijiahaoAccountName || attempt.accountName !== job.baijiahaoAccountName
      || attempt.payload.accountName !== job.baijiahaoAccountName || attempt.payload.jobId !== attempt.id
      || !belongsToJob || attempt.payload.target !== 'baijiahao-video'
      || attempt.payload.fingerprint !== attempt.fingerprint)
      throw new ScienceWorkflowError('上传记录与原账号或任务不一致，请核对原记录')
    this.bjh.get(job.baijiahaoAccountName)
    if (this.publicJob(job).executionActive || this.all().some(other => other.id !== id
      && other.baijiahaoAccountName === job.baijiahaoAccountName && other.stage === 'upload' && this.publicJob(other).executionActive))
      throw new ScienceWorkflowError('原账号正在执行任务，请等待完成或停止后再核对')
    return { job, attempt }
  }
  checkUpload(id: string) {
    const { job, attempt } = this.uploadAttemptForReview(id)
    return this.launch(id, async signal => {
      this.report(id, '正在只读核对百家号上传结果')
      try {
        const runtime = this.options.uploadRuntime || await import('./social-auto-upload.js')
        const check = await checkCbaUploadResult(attempt.payload!, attempt, runtime)
        signal.throwIfAborted()
        const uploadCheck = { checkedAt: new Date().toISOString(), status: check.status, message: safeMessage(check.message) }
        if (check.result) {
          const completed = check.result.submitted === true && check.result.saved === false
          this.modify(id, { upload: check.result, uploadAttempt: { ...this.read(id).uploadAttempt!, result: check.result, status: 'saved' },
            status: completed ? 'completed' : 'needs_attention', stage: completed ? 'completed' : 'upload', uploadCheck })
          this.report(id, check.message)
        } else this.modify(id, { status: job.status, stage: job.stage, message: job.message, uploadCheck })
      } catch (error) {
        signal.throwIfAborted()
        this.modify(id, { status: job.status, stage: job.stage, message: job.message,
          uploadCheck: { checkedAt: new Date().toISOString(), status: 'error', message: safeMessage(error) } })
      }
    })
  }
  async reviewUpload(id: string, input: { view?: 'original' | 'content'; input?: SocialUploadReviewInput } = {}) {
    const { attempt } = this.uploadAttemptForReview(id)
    this.reviewingJobs.add(id)
    try {
      const review = this.options.reviewUpload || (await import('./social-auto-upload.js')).reviewSocialUpload
      return { ...await review(attempt.payload!, input), jobId: id }
    } catch (error) { throw new ScienceWorkflowError(safeMessage(error), 503) }
    finally { this.reviewingJobs.delete(id) }
  }
  private async uploadVideo(id: string, signal: AbortSignal) {
    const job = this.read(id)
    if (!job.baijiahaoAccountName) throw new ScienceWorkflowError('请先选择百家号账号')
    this.bjh.get(job.baijiahaoAccountName)
    this.modify(id, { status: 'queued', stage: 'upload', uploadProgress: undefined })
    this.report(id, '等待所选百家号账号，正在排队上传', 'upload')
    let release: (() => void) | null = null
    try {
      while (!release) {
        signal.throwIfAborted()
        release = this.tryExecutionLock(`upload:${job.baijiahaoAccountName}`, id)
        if (!release) await delay(250, undefined, { signal })
      }
      signal.throwIfAborted()
      await this.uploadVideoForAccount(id, signal)
    } finally { release?.() }
  }
  private async uploadVideoForAccount(id: string, signal: AbortSignal) {
    let job = this.read(id)
    // Older workers may have scheduled a replacement after an ambiguous publication.
    if (job.uploadRestartPending) {
      this.modify(id, { status: 'needs_attention', stage: 'upload', failureKind: 'action_required',
        automaticRetry: undefined, uploadRetry: undefined, uploadRestartPending: undefined })
      this.report(id, '原发表结果尚未确认，已停止自动重传；请先只读核对原账号的发表记录，保留原上传检查点')
      return
    }
    this.modify(id, { status: 'running' })
    this.report(id, '正在核对原账号的百家号发表任务', 'upload')
    const assets = await this.inspectPreparedCovers(id, signal)
    if (job.uploadAttempt) {
      await this.syncPreparedUploadCovers(id, signal, assets)
      job = this.read(id)
    }
    if (!job.uploadAttempt) {
      if (!job.title.trim() || [...job.title].length > 50) throw new ScienceWorkflowError('百家号作品描述使用已保存标题，标题必须为 1 至 50 字符')
      signal.throwIfAborted()
      const fingerprint = digest(JSON.stringify([job.baijiahaoAccountName, job.title, job.script, assets.videoSha256, assets.landscapeSha256, assets.portraitSha256]))
      const payload = { jobId: `${id}-baijiahao`, scriptId: 0, target: 'baijiahao-video' as const, publicationMode: 'publish' as const,
        accountName: job.baijiahaoAccountName!, title: job.title, description: `${job.title} ${SCIENCE_BAIJIAHAO_TAG}`,
        tags: [SCIENCE_BAIJIAHAO_TAG], creationDeclaration: SCIENCE_CREATION_DECLARATION, watermark: SCIENCE_WATERMARK,
        videoPath: job.videoPath,
        landscapePath: assets.landscapePath, portraitPath: assets.portraitPath, fingerprint }
      const uploadAttempt: CbaUploadRecoveryCurrent = { id: payload.jobId, target: payload.target, accountName: payload.accountName,
        fingerprint, inputDigest: fingerprint, status: 'queued', dispatched: false, payload }
      job = this.modify(id, { uploadAttempt })
    }
    this.report(id, '正在核对原账号的百家号发表任务', 'upload')
    const attempt = job.uploadAttempt!
    if (attempt.accountName !== job.baijiahaoAccountName) throw new ScienceWorkflowError('上传账号与原草稿不一致，不能继续')
    const { sha256File } = await import('./history-source-pipeline.js')
    let currentInputDigest = 'assets-unavailable'
    try {
      const hashes = await Promise.all([attempt.payload!.videoPath!, attempt.payload!.landscapePath!, attempt.payload!.portraitPath!].map(file => sha256File(file, signal)))
      currentInputDigest = digest(JSON.stringify([job.baijiahaoAccountName, job.title, job.script, ...hashes]))
    } catch { signal.throwIfAborted() /* Missing files still permit read-only reconciliation of an earlier platform draft. */ }
    const runtime = this.options.uploadRuntime || await import('./social-auto-upload.js')
    const activeAttempt = this.read(id).uploadAttempt!, attemptPayload = activeAttempt.payload!
    let result: CbaUploadRecoveryCurrent['result'] | undefined
    let recoveryMessage: string | undefined
    if (attemptPayload.publicationMode === 'draft' && activeAttempt.result?.saved === true) {
      const publishPayload = { ...attemptPayload, publicationMode: 'publish' as const,
        description: `${job.title} ${SCIENCE_BAIJIAHAO_TAG}`, tags: [SCIENCE_BAIJIAHAO_TAG],
        creationDeclaration: SCIENCE_CREATION_DECLARATION, watermark: SCIENCE_WATERMARK }
      if (!runtime.publishSavedSocialUpload) throw new ScienceWorkflowError('当前上传运行时不支持原草稿转发表，请先更新服务')
      try { result = await runtime.publishSavedSocialUpload(publishPayload, attemptPayload, activeAttempt.result,
        { onProgress: (message, progress) => this.reportUploadProgress(id, message, progress) }) }
      catch (error) {
        const message = safeMessage(error)
        if (uploadConnectionFailure(message) && !uploadRequiresAction(message)) throw new ScienceWorkflowError(message, 503, true)
        throw error
      }
      this.modify(id, { uploadAttempt: { ...this.read(id).uploadAttempt!, payload: publishPayload, result, status: 'saved' }, upload: result })
    } else {
      const recovered = await this.retryPlatform(id, '百家号连接', signal, async () => {
        // Each retry consults the original durable checkpoint before any platform write.
        const current = this.read(id).uploadAttempt!
        const recovered = await recoverCbaUpload(current.payload!, current, {
          runtime, isCancelled: () => signal.aborted,
          persist: patch => {
            const latest = this.read(id)
            const receipt = patch.result && (!patch.result.submitted || patch.status === 'saved' && this.trustedSubmission(latest, patch.result))
              ? patch.result : undefined
            this.modify(id, { uploadAttempt: { ...latest.uploadAttempt!, ...patch }, ...(receipt ? { upload: receipt } : {}) })
          },
          onProgress: (message, progress) => this.reportUploadProgress(id, message, progress), currentInputDigest,
        })
        if (['blocked', 'failed'].includes(recovered.decision) && uploadConnectionFailure(recovered.message))
          throw new ScienceWorkflowError(recovered.message, 503, true)
        return recovered
      }, error => error instanceof ScienceWorkflowError && error.retryable)
      result = recovered.decision === 'saved' ? recovered.result : undefined
      recoveryMessage = recovered.message
      signal.throwIfAborted()
      if (!(result?.submitted && result.saved === false)) {
        if (recovered.decision !== 'uncertain'
          && (recovered.decision === 'busy' || uploadConnectionFailure(recovered.message) && !uploadRequiresAction(recovered.message))) {
          this.scheduleUploadRetry(id, recovered.message); return
        }
        if (recovered.decision === 'uncertain') {
          recoveryMessage = `${recovered.message}；请先只读核对原账号的发表记录，保留原上传检查点，不自动重传`
        } else this.modify(id, { uploadAttempt: { ...this.read(id).uploadAttempt!, status: 'blocked' } })
      }
    }
    signal.throwIfAborted()
    const completed = Boolean(result?.submitted) && result?.saved === false
    this.modify(id, { status: completed ? 'completed' : 'needs_attention', uploadRetry: undefined, uploadRestartPending: undefined,
      failureKind: completed ? undefined : 'action_required', ...(result ? { upload: result } : {}) })
    this.report(id, completed
      ? (result?.published ? '已发表并核验所选百家号账号的作品' : '已提交百家号，等待平台审核')
      : recoveryMessage || '当前无法上传，请根据具体错误处理后重试', completed ? 'completed' : 'upload')
  }
  async checkHuasheng(id: string): Promise<ScienceJob> {
    const pending = this.checkingHuasheng.get(id)
    if (pending) return pending
    const job = this.read(id)
    if (!job.projectUrl || !job.huashengAccountName || !job.script.trim())
      throw new ScienceWorkflowError('请先绑定原花生项目、制作账号和文稿后再查询')
    const work = (async () => {
      try {
        const signal = AbortSignal.timeout(75_000)
        const browserConfig = await this.huashengConfig(job.huashengAccountName!, { signal })
        const state = await (this.options.exportApi || exporter).inspectHuashengProduction({
          projectUrl: job.projectUrl!, checkpoint: job.checkpoint, script: job.script, browserConfig, signal,
        })
        const current = this.read(id)
        if (current.projectUrl !== job.projectUrl || current.huashengAccountName !== job.huashengAccountName)
          throw new ScienceWorkflowError('原项目或账号已变化，请刷新任务后重新查询')
        this.modify(id, { huashengCheck: { checkedAt: new Date().toISOString(), status: state.status, message: safeMessage(state.message) } })
      } catch (error) {
        this.modify(id, { huashengCheck: { checkedAt: new Date().toISOString(), status: 'error', message: safeMessage(error), error: safeMessage(error) } })
      }
      return this.detail(id)
    })().finally(() => this.checkingHuasheng.delete(id))
    this.checkingHuasheng.set(id, work)
    return work
  }
  /** Reconcile the original project and automatically deliver a confirmed finished production. */
  sync(id: string, options: { automatic?: boolean } = {}) {
    const job = this.read(id)
    if (job.presenterWait) throw new ScienceWorkflowError('任务正在等待远程主播 GPU，就绪后会自动继续，无需同步花生状态')
    if (this.isExecuting(job)) throw new ScienceWorkflowError('此任务已有操作正在执行，正在自动处理原项目，可只查询制作进度')
    if (!job.projectUrl) throw new ScienceWorkflowError('此任务尚未绑定花生项目，请先继续整理素材或开始制作')
    if (!job.huashengAccountName) throw new ScienceWorkflowError('请先绑定此任务的花生账号')
    if (!job.script.trim()) throw new ScienceWorkflowError('缺少原制作文稿，无法核对花生项目')
    const account = job.huashengAccountName
    this.hs.get(account)
    const previous = this.syncQueues.get(account) || Promise.resolve()
    let releaseInspection!: () => void
    const inspected = new Promise<void>(resolve => { releaseInspection = resolve })
    const preserve = Boolean(job.videoPath || job.uploadAttempt || job.upload || ['covers', 'upload', 'completed'].includes(job.stage)
      || ['ready', 'completed'].includes(job.status))
    const resumeDelivery = job.status === 'paused' && job.automaticDelivery === true
    const original = { status: job.status, stage: job.stage, message: job.message, failureKind: job.failureKind }
    if (!preserve || resumeDelivery) this.modify(id, { automaticDelivery: true, ...(!options.automatic ? { automaticRetry: undefined } : {}) })
    this.report(id, this.syncQueues.has(account) ? '等待同账号的花生状态查询完成' : '正在同步花生制作状态')
    this.launch(id, async signal => {
      let onAbort: () => void = () => {}
      let delivering = false
      try {
        // A canceled queued query releases its local task immediately, without overtaking its predecessor.
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
        try { await Promise.race([previous, aborted]) }
        finally { signal.removeEventListener('abort', onAbort) }
        signal.throwIfAborted()
        const browserConfig = await this.retryPlatform(id, '花生账号身份核验', signal, () => this.huashengConfig(account, { signal }))
        this.report(id, '正在同步花生制作状态')
        const api = this.options.exportApi || exporter
        const state = await this.retryPlatform(id, '花生状态同步', signal, () => api.inspectHuashengProduction({
          projectUrl: job.projectUrl!, checkpoint: job.checkpoint, script: job.script, browserConfig, signal, expectedVoice: SCIENCE_HUASHENG_VOICE,
        }))
        const snapshot: NonNullable<ScienceJob['huashengSync']> = { checkedAt: new Date().toISOString(), status: state.status, message: safeMessage(state.message) }
        let patch: Partial<StoredJob> = { status: 'waiting_remote', stage: 'produce', failureKind: undefined, productionCompleted: state.status === 'completed' }
        let message = state.message
        if (job.exportTask) {
          const info = await this.retryPlatform(id, '花生导出状态同步', signal, () => api.inspectHuashengExport({
            projectUrl: job.projectUrl!, ...job.exportTask!, browserConfig, signal,
          }))
          snapshot.exportProgress = info.progress
          patch = { ...patch, productionCompleted: job.productionCompleted || state.status === 'completed',
            stage: 'export', status: info.progress === 100 && info.url ? 'awaiting_export' : 'waiting_remote' }
          message = info.progress === 100 && info.url ? '原花生导出已完成，自动下载成片' : `花生正在导出：${Math.round(info.progress)}%，自动继续查询原导出任务`
        } else if (state.status === 'completed') {
          patch = { ...patch, status: job.exportDispatched ? 'needs_attention' : 'awaiting_export', stage: 'export', checkpoint: 'submitted',
            failureKind: job.exportDispatched ? 'action_required' : undefined }
          message = job.exportDispatched ? '花生制作已完成，但原导出请求缺少任务编号，请在原项目核对导出记录后恢复'
            : '花生制作已完成，自动导出下载成片'
        } else if (state.status === 'not_started') {
          if (job.checkpoint === 'submitted') message = '原项目已提交，花生尚未进入视频制作阶段，可稍后同步或继续查询原任务'
          else {
            patch.status = 'needs_attention'; patch.failureKind = 'action_required'
            message = '花生尚未开始制作，请打开原项目完成方案或点数确认后继续制作'
          }
        } else patch.checkpoint = 'submitted'
        signal.throwIfAborted()
        snapshot.checkedAt = new Date().toISOString(); snapshot.message = safeMessage(message)
        this.modify(id, { ...(preserve ? original : patch), huashengSync: snapshot })
        this.report(id, `花生状态同步：${snapshot.message}`)
        if (preserve) this.modify(id, original)
        // Serialize the short initial inspection, not the remote render/download lifetime.
        releaseInspection()
        if ((!preserve || resumeDelivery) && (resumeDelivery || patch.productionCompleted)
          && !(job.exportDispatched && !job.exportTask)) {
          delivering = true
          if (job.productionScriptHash && (job.productionScriptHash !== digest(job.script) || job.productionAccountName !== account))
            throw new ScienceWorkflowError('制作文稿或账号与原检查点不一致')
          this.modify(id, { status: 'running', automaticDelivery: true })
          await this.produceVideo(id, signal, { browserConfig, state })
          if (job.autoUpload === true) await this.uploadVideo(id, signal)
          this.modify(id, { automaticDelivery: false })
        }
      } catch (error) {
        // Delivery failures belong to their actual export/cover/upload stage.
        // Keep the confirmed production snapshot and original export identity.
        if (delivering) throw error
        if (signal.aborted) {
          this.report(id, '已取消花生状态同步，保留原任务状态')
          this.modify(id, { ...original, ...(!preserve && ['waiting_remote', 'awaiting_export', 'retry_wait'].includes(original.status)
            ? { status: 'paused', message: '自动导出下载已暂停，原项目和导出检查点保留' } : {}) })
          return
        }
        const message = `花生状态同步失败：${safeMessage(error)}`
        this.modify(id, { huashengSync: { checkedAt: new Date().toISOString(), status: 'error', message, error: safeMessage(error) },
          ...(preserve ? original : { status: 'needs_attention', failureKind: (error as { retryable?: boolean })?.retryable ? 'temporary' : 'action_required' }) })
        this.report(id, message)
        if (preserve) this.modify(id, original)
        if (!preserve && (error as { retryable?: boolean })?.retryable) throw error
      }
    })
    const done = this.running.get(id)?.done
    if (!done) { releaseInspection(); return this.detail(id) }
    const tail = Promise.all([previous, inspected]).then(() => {})
    this.syncQueues.set(account, tail)
    void done.then(releaseInspection, releaseInspection)
    void tail.then(() => { if (this.syncQueues.get(account) === tail) this.syncQueues.delete(account) })
    return this.detail(id)
  }
  syncPending() {
    const started: string[] = [], skipped: string[] = []
    for (const job of this.all()) {
      if (this.isExecuting(job) || job.presenterWait || !job.projectUrl || !['needs_attention', 'paused', 'waiting_remote', 'awaiting_export'].includes(job.status)
        || job.videoPath || job.uploadAttempt || job.upload || ['covers', 'upload', 'completed'].includes(job.stage)) { skipped.push(job.id); continue }
      try { this.sync(job.id); started.push(job.id) }
      catch (error) { if (!(error instanceof ScienceWorkflowError || error instanceof SocialUploadAccountError)) throw error; skipped.push(job.id) }
    }
    return { started, skipped }
  }
  /** Recover only queued/observed productions and our interrupted deliveries; never retry every failed task. */
  runAutomaticExports() {
    const started: string[] = []
    for (const job of this.all()) {
      if (this.isExecuting(job)) continue
      if (job.presenterWait) {
        if (job.automaticDelivery !== true || !['waiting_remote', 'paused'].includes(job.status)
          || !(Date.parse(job.presenterWait.nextCheckAt) <= Date.now())) continue
        try { this.produce(job.id, job.autoUpload === true, { automatic: true, waitForPresenter: true }); started.push(job.id) }
        catch (error) {
          if (!(error instanceof ScienceWorkflowError || error instanceof SocialUploadAccountError)) throw error
          this.modify(job.id, { presenterWait: undefined, status: 'needs_attention', failureKind: 'action_required',
            automaticDelivery: false, automaticProduction: false, automaticRetry: undefined })
          this.report(job.id, safeMessage(error), 'export')
        }
        continue
      }
      if (job.automaticRetry && Date.parse(job.automaticRetry.nextRetryAt) > Date.now()) continue
      if (job.stage === 'upload' && job.automaticDelivery !== false
        && (job.uploadRetry || job.uploadAttempt?.status === 'uncertain' && job.failureKind !== 'action_required')) {
        if (job.uploadRetry && Date.parse(job.uploadRetry.nextRetryAt) > Date.now()) continue
        try { this.upload(job.id); started.push(job.id) }
        catch (error) { if (!(error instanceof ScienceWorkflowError || error instanceof SocialUploadAccountError)) throw error }
        continue
      }
      if (job.status === 'retry_wait') {
        if (!job.automaticRetry || job.automaticDelivery === false) continue
        try {
          if (job.videoPath) this.produce(job.id, job.autoUpload === true, { automatic: true })
          else if (job.projectUrl) this.sync(job.id, { automatic: true })
          else if (!job.checkpoint || job.checkpoint === 'opening') this.produce(job.id, job.autoUpload === true, { automatic: true })
          else continue
          started.push(job.id)
        }
        catch (error) { if (!(error instanceof ScienceWorkflowError || error instanceof SocialUploadAccountError)) throw error }
        continue
      }
      if ((job.status === 'ready' || job.status === 'paused' && job.stage === 'upload')
        && job.autoUpload === true && job.automaticDelivery !== false) {
        try { this.upload(job.id); started.push(job.id) }
        catch (error) { if (!(error instanceof ScienceWorkflowError || error instanceof SocialUploadAccountError)) throw error }
        continue
      }
      if (!job.collectionId && job.automaticProduction && (['queued', 'paused'].includes(job.status) || job.status === 'ready' && job.autoUpload === true)) {
        try { this.produce(job.id, job.autoUpload === true, { automatic: true }); started.push(job.id) }
        catch (error) { if (!(error instanceof ScienceWorkflowError || error instanceof SocialUploadAccountError)) throw error }
        continue
      }
      if (job.status === 'paused' && job.automaticDelivery === true && !job.projectUrl && !job.videoPath
        && ['download', 'transcribe', 'rewrite', 'produce'].includes(job.stage)) {
        try { this.produce(job.id, job.autoUpload === true, { automatic: true }); started.push(job.id) }
        catch (error) { if (!(error instanceof ScienceWorkflowError || error instanceof SocialUploadAccountError)) throw error }
        continue
      }
      if (!job.projectUrl || job.automaticDelivery === false || !(['awaiting_export', 'waiting_remote'].includes(job.status)
        || job.status === 'paused' && job.automaticDelivery === true)) continue
      try { this.sync(job.id, { automatic: true }); started.push(job.id) }
      catch (error) { if (!(error instanceof ScienceWorkflowError || error instanceof SocialUploadAccountError)) throw error }
    }
    return started
  }
  startAutomaticExports() {
    if (this.automaticTimer) return
    const tick = () => { try { this.runAutomaticExports() } catch (error) { console.error('[science-export]', safeMessage(error)) } }
    this.automaticTimer = setInterval(tick, 15_000)
    this.automaticTimer.unref()
    tick()
  }
  async recover(id: string, input: z.infer<typeof scienceRecoverySchema>) {
    const patch = scienceRecoverySchema.parse(input), job = this.read(id)
    if (job.status === 'running') throw new ScienceWorkflowError('任务仍在执行，请等待或停止后再恢复')
    if (patch.projectUrl) {
      const projectUrl = huasheng.huashengProjectUrl(patch.projectUrl)
      if (!projectUrl) throw new ScienceWorkflowError('请填写原华生项目的有效链接', 400)
      if (job.projectUrl && job.projectUrl !== projectUrl) throw new ScienceWorkflowError('不能替换已绑定的华生项目')
      if (!job.projectUrl && job.checkpoint !== 'create_pending') throw new ScienceWorkflowError('此任务尚无待恢复的华生创建请求')
      job.projectUrl = projectUrl
    }
    if (patch.exportTask) {
      if (!job.projectUrl || !job.productionCompleted || !job.exportDispatched) throw new ScienceWorkflowError('此任务没有待恢复的导出请求')
      if (job.exportTask && JSON.stringify(job.exportTask) !== JSON.stringify(patch.exportTask)) throw new ScienceWorkflowError('不能替换已绑定的导出任务')
      job.exportTask = patch.exportTask
    }
    if (!job.huashengAccountName) throw new ScienceWorkflowError('请先绑定华生账号')
    const browserConfig = await this.huashengConfig(job.huashengAccountName)
    let failure: unknown
    this.launch(id, async signal => {
      try {
        this.report(id, '正在核对原任务的文稿、账号和导出版本')
        if (patch.projectUrl) await (this.options.exportApi || exporter).inspectHuashengProduction({
          projectUrl: job.projectUrl!, checkpoint: job.checkpoint, script: job.script, browserConfig, signal,
        })
        if (patch.exportTask) await (this.options.exportApi || exporter).inspectHuashengExport({
          projectUrl: job.projectUrl!, ...patch.exportTask, browserConfig, signal,
        })
        signal.throwIfAborted()
        this.modify(id, { projectUrl: job.projectUrl, ...(patch.exportTask ? { exportTask: patch.exportTask } : {}), status: 'needs_attention' })
        this.report(id, '已核对并保存原任务记录，可以继续原项目')
      } catch (error) { failure = error; throw error }
    })
    await this.running.get(id)!.done
    if (failure) throw new ScienceWorkflowError(safeMessage(failure))
    return this.detail(id)
  }
  cancel(id: string) {
    const active = this.running.get(id)
    if (active) { this.modify(id, { automaticDelivery: false, automaticProduction: false, automaticRetry: undefined, uploadRetry: undefined, presenterWait: undefined }); active.controller.abort(); this.report(id, '正在停止本机执行；平台已提交的制作和上传会保留检查点') }
    else if (this.isExecuting(this.read(id))) throw new ScienceWorkflowError('任务由另一进程执行，请在原工作台停止')
    else if (['queued', 'retry_wait', 'waiting_remote', 'awaiting_export'].includes(this.read(id).status)) {
      this.modify(id, { automaticDelivery: false, automaticProduction: false, automaticRetry: undefined, uploadRetry: undefined, presenterWait: undefined, status: 'paused' })
      this.report(id, '自动制作已暂停，素材、原项目和导出检查点保留')
    }
    else this.modify(id, { automaticDelivery: false, automaticProduction: false, automaticRetry: undefined, uploadRetry: undefined, presenterWait: undefined })
    return this.detail(id)
  }
  async waitForIdle() { await Promise.all([...this.running.values()].map(value => value.done)) }
  /** Batch processing waits for this job's concrete handle, never an unrelated job or timer. */
  async runBatchJob(id: string, mode: ScienceBatchMode, signal: AbortSignal): Promise<ScienceJob> {
    signal.throwIfAborted()
    const run = async (start: () => ScienceJob) => {
      signal.throwIfAborted()
      const existing = this.read(id)
      if (this.running.has(id) || liveRuns.has(this.filename(id)) || existing.status === 'running'
        || existing.status === 'queued' && processAlive(existing.ownerPid)) throw new ScienceWorkflowError('此任务已有执行进程，请等待原操作完成后继续批次')
      start()
      const handle = this.running.get(id)
      if (!handle) throw new ScienceWorkflowError('任务未能启动，请检查现有任务状态')
      // A batch stop only cancels work it started. It must not stop a manual or other batch operation.
      const cancel = () => { if (this.running.get(id) === handle) this.cancel(id) }
      signal.addEventListener('abort', cancel, { once: true })
      try { if (signal.aborted) cancel(); await handle.done; signal.throwIfAborted() }
      finally { signal.removeEventListener('abort', cancel) }
      const result = this.detail(id)
      if (result.presenterWait) throw new ScienceWorkflowError(result.message, 409, true)
      if (['needs_attention', 'paused', 'retry_wait'].includes(result.status)) throw new ScienceWorkflowError(result.message, 409, result.failureKind === 'temporary')
      return result
    }
    let job = this.detail(id)
    if (this.running.has(id) || liveRuns.has(this.filename(id)) || job.status === 'running'
      || job.status === 'queued' && processAlive(this.read(id).ownerPid)) throw new ScienceWorkflowError('此任务已有执行进程，请等待原操作完成后继续批次')
    if (mode === 'drafts') {
      if (!job.script.trim()) job = await run(() => this.prepare(id))
      if (!job.script.trim()) throw new ScienceWorkflowError('任务未生成完整科普文稿')
      return job
    }
    if (job.presenterWait) throw new ScienceWorkflowError(job.message, 409, true)
    if (!job.videoUrl || job.videoCompositionPending) job = await run(() => this.produce(id, mode === 'upload'))
    if (!job.videoUrl) throw new ScienceWorkflowError('华生成片尚未下载完成')
    if ((!job.landscapeCoverUrl || !job.portraitCoverUrl) && (mode === 'videos' || !job.hasUploadAttempt))
      job = await run(() => this.covers(id, {}, { automatic: mode === 'upload' }))
    if (mode === 'upload' && !(job.status === 'completed' && job.upload?.submitted === true && job.upload.saved === false)) job = await run(() => this.upload(id))
    if (mode === 'upload' && !(job.status === 'completed' && job.upload?.submitted === true && job.upload.saved === false
      && job.upload.accountName === job.baijiahaoAccountName))
      throw new ScienceWorkflowError('百家号尚未返回所选账号的发表回执')
    return job
  }
  async stop() {
    if (this.automaticTimer) clearInterval(this.automaticTimer)
    this.automaticTimer = undefined
    for (const active of this.running.values()) active.controller.abort()
    await this.waitForIdle()
    this.executionDb?.close()
    this.executionDb = undefined
  }
  asset(id: string, kind: string) {
    const job = this.read(id)
    const file = kind === 'source' ? job.media.videoPath : kind === 'video' ? job.videoPath
      : kind === 'landscape-cover' ? job.coverAssets?.landscapePath : kind === 'portrait-cover' ? job.coverAssets?.portraitPath : null
    return this.localFile(id, file)
  }
  private localFile(id: string, file: string | null | undefined) {
    if (!file || !fs.existsSync(file)) throw new ScienceWorkflowError('素材文件尚未生成或已缺失', 404)
    const directory = fs.realpathSync(this.directory(id)), resolved = fs.realpathSync(file)
    if (!resolved.startsWith(directory + path.sep) || !fs.statSync(resolved).isFile()) throw new ScienceWorkflowError('素材文件路径无效', 400)
    return resolved
  }
}

let instance: ScienceWorkflowService | undefined
export function getScienceWorkflowService() { return instance ??= new ScienceWorkflowService() }
export { SocialUploadAccountError }
