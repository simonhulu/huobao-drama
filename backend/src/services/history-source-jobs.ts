import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, runImmediateTransaction, schema } from '../db/index.js'
import { getActiveConfig } from './ai.js'
import { resolveHistoryASRConfig } from './history-asr-config.js'
import { HISTORY_SOURCE_CATEGORIES, getHistorySource, getHistorySourceArtifactState, storeHistoryArticleSource, storeHistorySource, type StoreHistorySourceInput } from './history-script-library.js'
import { hasRecentHistoryYoutubeProduction, prepareHistoryYoutubeRecollection } from './history-youtube-recollection.js'
import { HistorySourceRateLimitError, acquireHistorySourceLock, unlockHistorySource, isHistorySourceRateLimitError, processHistorySource, readHistoryDownloaderConnection } from './history-source-pipeline.js'
import { registerTaskHandler } from './tasks/registry.js'
import { createTaskInTransaction, getTask, listTasks, normalizeTask, requestCancel, transitionTask, transitionTaskWithExpiredLease } from './tasks/store.js'
import type { CreationTask, TaskHandler } from './tasks/types.js'
import type { browseHistoryCandidates, HistoryBrowserEvent } from './history-source-browser.js'
import { getHeartbeatTimeoutMs } from './tasks/heartbeat.js'
import { redactHistoryJobMessage } from './history-job-message.js'
import { historySourceKeywordsSchema, historyYoutubeSourceUrlSchema, historyYoutubeSourceUrlsSchema, readHistorySourceSettings } from './history-source-settings.js'
import type { collectCzgtsArticles } from './history-source-czgts.js'
import { HistoryYoutubeLoginRequiredError, isHistoryYoutubeLoginError, refreshHistoryYoutubeSession, historyYoutubeBinary, parseHistoryYoutubeUrl, storeHistoryYoutubeSource, type collectHistoryYoutubeVideos, type HistoryYoutubeCandidate } from './history-source-youtube.js'

export const HISTORY_SOURCING_TASK_TYPE = 'history.source'
const workerUnavailableMessage = '采集执行器未运行，任务无法开始。请恢复采集服务后重新启动采集；已保存稿件保留。'
export class HistorySourceWorkerUnavailableError extends Error {
  constructor() { super(workerUnavailableMessage); this.name = 'HistorySourceWorkerUnavailableError' }
}

export class HistorySourceResumeConflictError extends Error {}

export function hasHistorySourceWorker(nowMs = Date.now()) {
  const cutoff = new Date(nowMs - getHeartbeatTimeoutMs()).toISOString()
  return db.select().from(schema.workerHeartbeats).where(gte(schema.workerHeartbeats.lastSeenAt, cutoff)).all().some(worker => {
    // These are the two pools configured to consume history.source; image/render workers cannot help.
    if (!/^(?:worker-general-|history-sourcing-)/.test(worker.workerId) || !worker.pid) return false
    try { process.kill(worker.pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  })
}

function settleUnservedHistoryQueue(nowMs = Date.now()) {
  if (hasHistorySourceWorker(nowMs)) return
  runImmediateTransaction(() => {
    if (hasHistorySourceWorker(nowMs)) return
    for (const task of listTasks({ type: HISTORY_SOURCING_TASK_TYPE, status: 'queued' })) {
      const queuedSince = Math.max(Date.parse(task.createdAt), task.scheduledAt ? Date.parse(task.scheduledAt) : 0)
      if (nowMs - queuedSince < getHeartbeatTimeoutMs()) continue
      // The write lock prevents a worker claiming this queued row between inspection and failure.
      transitionTask(task.id, 'failed', { errorCode: 'history_worker_unavailable',
        errorMessage: workerUnavailableMessage, progressMessage: workerUnavailableMessage })
    }
  })
}

const shanghaiDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).refine(value => {
  const date = new Date(`${value.replace(' ', 'T')}+08:00`)
  return Number.isFinite(date.getTime()) && new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') === value
}, 'Invalid Shanghai local datetime')
export const historySourceJobConfigSchema = z.object({
  source: z.enum(['douyin', 'czgts', 'youtube']).default('douyin'),
  youtube: z.union([
    z.object({ urls: historyYoutubeSourceUrlsSchema }).strict(),
    z.object({ url: historyYoutubeSourceUrlSchema }).strict().transform(value => ({ urls: [value.url] })),
  ]).optional(),
  czgts: z.object({ startTime: shanghaiDateTimeSchema, endTime: shanghaiDateTimeSchema }).strict()
    .refine(value => value.startTime < value.endTime, 'End time must follow start time').optional(),
  keywords: historySourceKeywordsSchema.default(['历史']),
  targetCount: z.number().int().min(1).max(9999).nullable().default(1),
  existingSources: z.literal('skip').optional(),
  categories: z.array(z.enum(HISTORY_SOURCE_CATEGORIES)).min(1).max(5)
    .refine(values => new Set(values).size === values.length, 'Categories must be unique')
    .default([...HISTORY_SOURCE_CATEGORIES]),
}).strict().superRefine((value, ctx) => {
  if (value.source === 'czgts' && !value.czgts) ctx.addIssue({ code: 'custom', path: ['czgts'], message: 'Article collection requires a date range' })
  if (value.source !== 'czgts' && value.czgts) ctx.addIssue({ code: 'custom', path: ['czgts'], message: 'Article dates apply only to CZGTS' })
  if (value.source === 'youtube' && !value.youtube) ctx.addIssue({ code: 'custom', path: ['youtube'], message: 'YouTube collection requires a channel or video URL' })
  if (value.source !== 'youtube' && value.youtube) ctx.addIssue({ code: 'custom', path: ['youtube'], message: 'YouTube URL applies only to YouTube' })
})
export type HistorySourceJobConfig = z.infer<typeof historySourceJobConfigSchema>

const countsSchema = z.object({
  scanned: z.number().int().nonnegative(), selected: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
})
const candidateSchema = z.object({
  outcome: z.enum(['inspecting', 'selected', 'skipped']), videoId: z.string().regex(/^(?:\d{1,30}|[A-Za-z0-9_-]{11})$/),
  screeningStage: z.enum(['search', 'detail']).optional(),
  title: z.string().optional(), reason: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(), likeCount: z.number().int().nonnegative().optional(),
  commentCount: z.number().int().nonnegative().optional(),
  titleEvidence: z.string().optional(), curiosityAngle: z.string().optional(),
  comments: z.array(z.object({ text: z.string(), likes: z.number().int().nonnegative().optional() })).optional(),
})
export type HistoryJobCandidate = z.infer<typeof candidateSchema>
const snapshotSchema = z.object({
  stage: z.string().max(100), message: z.string().max(2000),
  counts: countsSchema,
  currentSourceId: z.number().int().positive().nullable(),
  currentTitle: z.string().nullable(),
  sourceIds: z.array(z.number().int().positive()).max(100),
  browserUrl: z.string().nullable(),
  level: z.enum(['info', 'warning', 'error']),
  candidate: candidateSchema.optional().catch(undefined),
})
type Snapshot = z.infer<typeof snapshotSchema>

export interface HistoryJobEvent extends Pick<Snapshot, 'stage' | 'message' | 'level' | 'counts' | 'browserUrl' | 'currentSourceId' | 'currentTitle' | 'candidate'> {
  id: number
  createdAt: string
}

export interface HistoryJob extends Omit<Snapshot, 'message' | 'level'> {
  id: number
  status: 'queued' | 'running' | 'stopping' | 'stopped' | 'completed' | 'failed' | 'interrupted'
  progressMessage: string | null
  targetCount: number | null
  config: HistorySourceJobConfig
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
  workerHealth: 'alive' | 'stale' | 'inactive'
  heartbeatAt: string | null
  leaseExpiresAt: string | null
  progressAt: string | null
  errorMessage: string | null
  errorCode: string | null
  events: HistoryJobEvent[]
}

type HistoryJobRedactor = (value: unknown) => string

function createHistoryJobRedactor(): HistoryJobRedactor {
  const keys=db.select({apiKey:schema.aiServiceConfigs.apiKey}).from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.isActive,true)).all().map(config=>config.apiKey)
  return value => redactHistoryJobMessage(value,keys)
}

export function safeHistoryJobMessage(value: unknown) {
  return createHistoryJobRedactor()(value)
}

function initialSnapshot(): Snapshot {
  return { stage: 'queued', message: '等待采集', counts: { scanned: 0, selected: 0, completed: 0, failed: 0 }, currentSourceId: null, currentTitle: null, sourceIds: [], browserUrl: null, level: 'info' }
}

function safeBrowserUrl(value: string | null) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(url.hostname)) return parseHistoryYoutubeUrl(value).url
    if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.port || url.username || url.password) return null
    url.search = ''; url.hash = ''
    return url.href
  } catch { return null }
}

function safeCandidate(candidate: HistoryJobCandidate | undefined, redact: HistoryJobRedactor = safeHistoryJobMessage): HistoryJobCandidate | undefined {
  if (!candidate) return undefined
  const safeText = (value: string | undefined) => value === undefined ? undefined : redact(value)
  return {
    outcome: candidate.outcome, videoId: candidate.videoId,
    screeningStage: candidate.screeningStage,
    title: safeText(candidate.title), reason: safeText(candidate.reason),
    durationSeconds: candidate.durationSeconds, likeCount: candidate.likeCount, commentCount: candidate.commentCount,
    titleEvidence: safeText(candidate.titleEvidence), curiosityAngle: safeText(candidate.curiosityAngle),
    comments: candidate.comments?.slice(0, 20).map(comment => ({ text: redact(comment.text), likes: comment.likes })),
  }
}

function parseProgressRows(rows: Array<typeof schema.creationTaskEvents.$inferSelect>) {
  return rows.flatMap(row => {
    try {
      const result = snapshotSchema.safeParse(JSON.parse(row.dataJson ?? 'null'))
      return result.success ? [{ row, value: result.data }] : []
    } catch { return [] }
  })
}

function describeEvent({ row, value }: ReturnType<typeof parseProgressRows>[number], redact: HistoryJobRedactor): HistoryJobEvent {
  return {
    id: row.id, createdAt: row.createdAt, stage: redact(value.stage), message: redact(value.message), level: value.level,
    counts: value.counts, browserUrl: safeBrowserUrl(value.browserUrl), currentSourceId: value.currentSourceId,
    currentTitle: value.currentTitle === null ? null : redact(value.currentTitle),
    ...(value.candidate ? { candidate: safeCandidate(value.candidate,redact) } : {}),
  }
}

export function describeHistorySourceJob(task: CreationTask, eventLimit = 100, redact: HistoryJobRedactor = createHistoryJobRedactor()): HistoryJob {
  if (task.type !== HISTORY_SOURCING_TASK_TYPE) throw new Error('Not a history sourcing task')
  const config = historySourceJobConfigSchema.parse(task.payload)
  const rows = db.select().from(schema.creationTaskEvents).where(and(
    eq(schema.creationTaskEvents.taskId, task.id), eq(schema.creationTaskEvents.eventType, 'history.progress'),
  )).orderBy(desc(schema.creationTaskEvents.id)).limit(eventLimit).all().reverse()
  const snapshots = parseProgressRows(rows)
  const state = snapshots.at(-1)?.value ?? initialSnapshot()
  const status = task.status === 'canceled' ? 'stopped' : task.status === 'succeeded' ? 'completed'
    : task.status === 'stale' ? 'interrupted' : task.cancelRequested && ['queued', 'running'].includes(task.status) ? 'stopping' : task.status
  const terminal = ['stopped', 'completed', 'failed', 'interrupted'].includes(status)
  const heartbeat = db.select().from(schema.creationTaskEvents).where(and(
    eq(schema.creationTaskEvents.taskId, task.id), eq(schema.creationTaskEvents.eventType, 'heartbeat'),
  )).orderBy(desc(schema.creationTaskEvents.id)).limit(1).get()
  let heartbeatAt: string | null = null
  try {
    const value = JSON.parse(heartbeat?.dataJson || 'null')
    if (heartbeat && task.leaseToken && task.leaseOwner && value?.lease_token === task.leaseToken
      && value.workerId === task.leaseOwner) heartbeatAt = heartbeat.createdAt
  } catch { /* Malformed or previous-lease events cannot prove current worker liveness. */ }
  const leaseValid = Boolean(task.leaseOwner && task.leaseToken && task.leaseExpiresAt
    && Date.parse(task.leaseExpiresAt) > Date.now())
  const worker = task.leaseOwner ? db.select({ lastSeenAt: schema.workerHeartbeats.lastSeenAt }).from(schema.workerHeartbeats)
    .where(eq(schema.workerHeartbeats.workerId, task.leaseOwner)).get() : null
  const workerIsRecent = Boolean(worker && Date.parse(worker.lastSeenAt) >= Date.now() - getHeartbeatTimeoutMs())
  return {
    id: task.id, status, stage: status === 'failed' && task.errorCode === 'history_source_rate_limited' ? 'waiting_rate_limit'
      : status === 'failed' && (task.errorCode === 'youtube_login_required' || isHistoryYoutubeLoginError(task.errorMessage))
        ? 'waiting_login' : terminal ? status : redact(state.stage),
    progressMessage: terminal && !['stopped', 'completed', 'failed', 'interrupted'].includes(state.stage)
      ? (status === 'stopped' ? '任务已停止，已保存内容保留' : status === 'interrupted' ? '服务中断，已完成阶段保留；未自动重试' : redact(task.errorMessage ?? task.progressMessage ?? state.message))
      : redact(state.message),
    counts: state.counts, currentSourceId: state.currentSourceId, currentTitle: state.currentTitle === null ? null : redact(state.currentTitle),
    sourceIds: state.sourceIds, browserUrl: safeBrowserUrl(state.browserUrl),
    ...(state.candidate ? { candidate: safeCandidate(state.candidate,redact) } : {}),
    targetCount: config.targetCount, config,
    startedAt: task.startedAt, completedAt: task.completedAt, updatedAt: task.updatedAt,
    workerHealth: task.status === 'running' ? leaseValid && workerIsRecent ? 'alive' : 'stale' : 'inactive',
    heartbeatAt, leaseExpiresAt: task.leaseExpiresAt, progressAt: snapshots.at(-1)?.row.createdAt ?? null,
    errorMessage: task.errorMessage ? redact(task.errorMessage) : null,
    errorCode: task.errorCode,
    events: snapshots.map(event => describeEvent(event,redact)),
  }
}

interface HistoryPageOptions { limit?: number; beforeId?: number }

function historyPageOptions(options: HistoryPageOptions, defaultLimit: number, maxLimit: number) {
  return z.object({ limit: z.number().int().min(1).max(maxLimit).default(defaultLimit), beforeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).parse(options)
}

export function listHistorySourceJobs(options: HistoryPageOptions = {}) {
  const { limit, beforeId } = historyPageOptions(options, 20, 50)
  settleUnservedHistoryQueue()
  const belongsToHistory = eq(schema.creationTasks.type, HISTORY_SOURCING_TASK_TYPE)
  const rows = db.select().from(schema.creationTasks).where(and(belongsToHistory,
    beforeId === undefined ? undefined : lt(schema.creationTasks.id, beforeId),
  )).orderBy(desc(schema.creationTasks.id)).limit(limit + 1).all()
  const current = db.select().from(schema.creationTasks).where(and(belongsToHistory,
    inArray(schema.creationTasks.status, ['queued', 'running']),
  )).orderBy(desc(schema.creationTasks.id)).limit(1).get()
    ?? db.select().from(schema.creationTasks).where(belongsToHistory).orderBy(desc(schema.creationTasks.id)).limit(1).get()
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const redact = createHistoryJobRedactor()
  return {
    job: current ? describeHistorySourceJob(normalizeTask(current),100,redact) : null,
    recent: page.map(row => describeHistorySourceJob(normalizeTask(row),1,redact)),
    total: db.select({ value: count() }).from(schema.creationTasks).where(belongsToHistory).get()!.value,
    hasMore, nextCursor: hasMore ? page.at(-1)!.id : null,
  }
}

export function listHistorySourceJobEvents(id: number, options: HistoryPageOptions = {}) {
  const { limit, beforeId } = historyPageOptions(options, 100, 200)
  if (getTask(id)?.type !== HISTORY_SOURCING_TASK_TYPE) return null
  const belongsToJob = and(eq(schema.creationTaskEvents.taskId, id), eq(schema.creationTaskEvents.eventType, 'history.progress'))
  const rows = db.select().from(schema.creationTaskEvents).where(and(belongsToJob,
    beforeId === undefined ? undefined : lt(schema.creationTaskEvents.id, beforeId),
  )).orderBy(desc(schema.creationTaskEvents.id)).limit(limit + 1).all()
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const redact = createHistoryJobRedactor()
  return {
    items: parseProgressRows([...page].reverse()).map(event => describeEvent(event,redact)),
    total: db.select({ value: count() }).from(schema.creationTaskEvents).where(belongsToJob).get()!.value,
    hasMore, nextCursor: hasMore ? page.at(-1)!.id : null,
  }
}

export function recoverHistorySourceJobs(nowMs = Date.now()) {
  let interrupted = 0
  for (const task of listTasks({ type: HISTORY_SOURCING_TASK_TYPE, status: 'running' })) {
    const expiresAt = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : NaN
    if (Number.isFinite(expiresAt) && expiresAt > nowMs) continue
    if (transitionTaskWithExpiredLease(task, 'stale', {
      errorCode: 'history_worker_interrupted',
      errorMessage: '采集服务中断，已保存稿件和检查点保留；未自动重试付费请求',
    }, nowMs)) interrupted++
  }
  return interrupted
}

export function startHistorySourceJob(input: unknown) {
  // Omitted YouTube configuration means the saved channel list. Explicit payloads and
  // old task snapshots never read newer settings while retrying.
  const config = historySourceJobConfigSchema.parse(typeof input === 'object' && input !== null && !Array.isArray(input)
    && 'source' in input && input.source === 'youtube' && (!('youtube' in input) || input.youtube === undefined)
      ? { ...input, youtube: { urls: readHistorySourceSettings().youtubeChannels } } : input)
  // Capture settings once: edits made while a job runs apply to the next job.
  if (config.source === 'douyin' && typeof input === 'object' && input !== null && !('keywords' in input && input.keywords !== undefined)) {
    config.keywords = readHistorySourceSettings().keywords
  }
  const { task, created } = runImmediateTransaction(() => {
    if (!hasHistorySourceWorker()) throw new HistorySourceWorkerUnavailableError()
    return createTaskInTransaction(db, {
      type: HISTORY_SOURCING_TASK_TYPE, idempotencyKey: 'history-sourcing', scopeType: 'history-scripts',
      payload: config, maxAttempts: 1,
    })
  })
  return { job: describeHistorySourceJob(task), created }
}

export function getHistorySourceJob(id: number) {
  settleUnservedHistoryQueue()
  const task = getTask(id)
  return task?.type === HISTORY_SOURCING_TASK_TYPE ? describeHistorySourceJob(task) : null
}

export function stopHistorySourceJob(id: number) {
  const task = runImmediateTransaction(() => {
    if (getTask(id)?.type !== HISTORY_SOURCING_TASK_TYPE) return null
    const result = requestCancel(id, { reason: '用户从历史脚本页面停止采集', source: 'history-scripts', actor: 'local-user' })
    // No execution needs to acknowledge an unclaimed job; fence out claims while canceling it.
    if (result.task?.status === 'queued' && result.task.cancelRequested) {
      return transitionTask(id, 'canceled', { progressMessage: '任务已停止，已保存内容保留' })
    }
    return result.task
  })
  return task ? describeHistorySourceJob(task) : null
}

function savedYoutubeSources(taskId: number) {
  // Every saved source has a currentSourceId event, including those older than the 100-item UI snapshot.
  const sourceIds = db.select({ id: sql<number>`json_extract(${schema.creationTaskEvents.dataJson}, '$.currentSourceId')` })
    .from(schema.creationTaskEvents).where(and(eq(schema.creationTaskEvents.taskId, taskId),
      eq(schema.creationTaskEvents.eventType, 'history.progress'), sql`json_valid(${schema.creationTaskEvents.dataJson})`))
  return db.select().from(schema.historyScriptSources).where(and(inArray(schema.historyScriptSources.id, sourceIds),
    eq(schema.historyScriptSources.platform, 'youtube'), isNull(schema.historyScriptSources.deletedAt)))
    .orderBy(asc(schema.historyScriptSources.id)).all()
}

export function resumeHistorySourceJob(id: number) {
  const task = runImmediateTransaction(() => {
    const previous = getTask(id)
    if (previous?.type !== HISTORY_SOURCING_TASK_TYPE) return null
    if (historySourceJobConfigSchema.parse(previous.payload).source !== 'youtube') {
      throw new HistorySourceResumeConflictError('此恢复入口仅用于 YouTube 采集')
    }
    if (['queued', 'running'].includes(previous.status)) return previous
    if (previous.status === 'succeeded') throw new HistorySourceResumeConflictError('采集已经完成，无需继续')
    if (listTasks({ type: HISTORY_SOURCING_TASK_TYPE, activeOnly: true }).length) {
      throw new HistorySourceResumeConflictError('请先停止当前采集任务，再继续此任务')
    }
    if (!hasHistorySourceWorker()) throw new HistorySourceWorkerUnavailableError()
    return transitionTask(id, 'queued', { errorCode: null, errorMessage: null, progressMessage: '等待继续原 YouTube 采集任务',
      sync(tx) {
        tx.update(schema.creationTasks).set({ cancelRequested: false, completedAt: null, scheduledAt: null })
          .where(eq(schema.creationTasks.id, id)).run()
      },
    })
  })
  return task ? describeHistorySourceJob(getTask(task.id)!) : null
}

export async function refreshHistorySourceYoutubeSession(id: number) {
  const task = getTask(id)
  if (task?.type !== HISTORY_SOURCING_TASK_TYPE) return null
  const config = historySourceJobConfigSchema.parse(task.payload)
  if (config.source !== 'youtube') throw new HistorySourceResumeConflictError('此登录刷新入口仅用于 YouTube 采集')
  if (['queued', 'running'].includes(task.status)) throw new HistorySourceResumeConflictError('请先停止采集，再刷新 YouTube 登录')
  const sources = savedYoutubeSources(id)
  const sourceUrl = sources.find(source => getHistorySourceArtifactState(source).rewritten !== 'current')?.sourceUrl
    ?? sources[0]?.sourceUrl ?? config.youtube!.urls.find(url => parseHistoryYoutubeUrl(url).kind === 'video')
  if (!sourceUrl) throw new HistorySourceResumeConflictError('尚无已保存的视频可检测；请先启动采集，遇到验证暂停后再刷新登录')
  return refreshHistoryYoutubeSession(sourceUrl)
}

interface ReadinessDependencies {
  getConfig: (type: 'audio' | 'text', provider?: string) => { provider: string; apiKey: string; baseUrl?: string } | null
  checkTool: (tool: string, signal: AbortSignal) => Promise<void>
  readDownloaderConnection: typeof readHistoryDownloaderConnection
  fetch: typeof fetch
}

export async function checkHistorySourceReadiness(signal: AbortSignal, overrides: Partial<ReadinessDependencies> = {}, platform: 'douyin' | 'youtube' = 'douyin') {
  const deps: ReadinessDependencies = {
    getConfig: getActiveConfig,
    checkTool: async (tool, signal) => { await promisify(execFile)(tool, [tool === historyYoutubeBinary() ? '--version' : '-version'], { signal, timeout: 5000 }) },
    readDownloaderConnection: readHistoryDownloaderConnection,
    fetch,
    ...overrides,
  }
  signal.throwIfAborted()
  await resolveHistoryASRConfig({getConfig:deps.getConfig})
  signal.throwIfAborted()
  if (!deps.getConfig('text')?.apiKey) throw new Error('请配置用于筛选、校对和二创的文本模型')
  for (const tool of ['ffmpeg', 'ffprobe']) await deps.checkTool(tool, signal)
  if (platform === 'youtube') {
    try { await deps.checkTool(historyYoutubeBinary(), signal) }
    catch (error) {
      signal.throwIfAborted()
      throw new Error('YouTube 下载器不可用，请安装 yt-dlp 或检查 HISTORY_YOUTUBE_YTDLP_BIN')
    }
    return
  }
  const connection = await deps.readDownloaderConnection()
  const response = await deps.fetch(`${connection.baseUrl}/api/v1/auth/me`, {
    headers: { 'X-API-Key': connection.apiKey }, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  })
  if (!response.ok) throw new Error('下载器不可用或认证失败，请检查本地下载服务')
}

export async function checkHistoryTextReadiness(signal: AbortSignal, overrides: Partial<Pick<ReadinessDependencies, 'getConfig'>> = {}) {
  signal.throwIfAborted()
  const getConfig = overrides.getConfig ?? getActiveConfig
  if (!getConfig('text')?.apiKey) throw new Error('请配置用于文章校对和二创的文本模型')
}

interface JobDependencies {
  checkReadiness: (signal: AbortSignal) => Promise<void>
  checkYoutubeReadiness: (signal: AbortSignal) => Promise<void>
  checkTextReadiness: (signal: AbortSignal) => Promise<void>
  browse: typeof browseHistoryCandidates
  process: typeof processHistorySource
  collectArticles: typeof collectCzgtsArticles
  collectYoutube: typeof collectHistoryYoutubeVideos
  continueProduction?: (sourceId: number) => unknown | Promise<unknown>
  storageRoot?: string
}

export function createHistorySourceJobHandler(overrides: Partial<JobDependencies> = {}): TaskHandler<HistorySourceJobConfig> {
  const deps: JobDependencies = {
    checkReadiness: checkHistorySourceReadiness,
    checkYoutubeReadiness: signal => checkHistorySourceReadiness(signal, {}, 'youtube'),
    checkTextReadiness: checkHistoryTextReadiness,
    browse: async options => (await import('./history-source-browser.js')).browseHistoryCandidates(options),
    process: processHistorySource,
    collectArticles: async options => (await import('./history-source-czgts.js')).collectCzgtsArticles(options),
    collectYoutube: async options => (await import('./history-source-youtube.js')).collectHistoryYoutubeVideos(options),
    continueProduction: overrides.process ? undefined : async sourceId => {
      const queue = (await import('./history-huasheng.js')).getHistoryHuashengService()
      if (queue.enabled) return (await import('./history-production-continuation.js')).startHistoryProductionContinuation(sourceId)
    },
    ...overrides,
  }
  return {
    resumable: false, maxAttempts: 1, concurrencyKey: () => 'history-sourcing',
    async run(ctx) {
      const config = historySourceJobConfigSchema.parse(ctx.payload)
      const previous = config.source === 'youtube' ? db.select().from(schema.creationTaskEvents).where(and(
        eq(schema.creationTaskEvents.taskId, ctx.taskId), eq(schema.creationTaskEvents.eventType, 'history.progress'),
      )).orderBy(desc(schema.creationTaskEvents.id)).limit(1).all() : []
      const state = parseProgressRows(previous).at(-1)?.value ?? initialSnapshot()
      let articleReadFailures = 0, articleProcessFailures = 0
      const failureSummary = () => config.source === 'czgts'
        ? (articleReadFailures ? `；${articleReadFailures} 篇文章正文读取失败，未入库，可重新采集` : '')
          + (articleProcessFailures ? `；${articleProcessFailures} 篇文章校对或二创失败，原文和已完成检查点保留，可单独重试` : '')
        : state.counts.failed ? `；失败 ${state.counts.failed} 条，已有内容和检查点保留，可单独重试` : ''
      const stopController = new AbortController()
      const signal = AbortSignal.any([ctx.signal, stopController.signal])
      const check = () => {
        if (ctx.isCancelRequested()) stopController.abort(new Error('采集停止请求'))
        signal.throwIfAborted()
      }
      const report = (stage: string, message: string, level: Snapshot['level'] = 'info', candidate?: HistoryJobCandidate) => {
        state.stage = stage; state.message = safeHistoryJobMessage(message); state.level = level
        // Evidence belongs to this specific browser decision, never to later model/processing stages.
        state.candidate = safeCandidate(candidate)
        ctx.progress(state.message, state.counts.completed, config.targetCount ?? undefined)
        ctx.event('history.progress', { ...state, counts: { ...state.counts }, sourceIds: [...state.sourceIds] })
      }
      try {
        check()
        if (config.source === 'czgts') {
          report('checking', '检查文章校对与二创的文本模型，准备通过 CZGTS 采集百家号历史文章')
          await deps.checkTextReadiness(signal)
          check()
          const isKnownArticle = (id: string) => Boolean(db.select({ id: schema.historyScriptSources.id }).from(schema.historyScriptSources)
            .where(and(eq(schema.historyScriptSources.platform, 'baijiahao'), eq(schema.historyScriptSources.sourceVideoId, id))).get())
          let searchExhausted = false
          await deps.collectArticles({
            ...config.czgts!, signal, targetCount: config.targetCount, isKnownArticle,
            report(event) {
              check()
              if (event.stage === 'exhausted') searchExhausted = true
              if (event.stage === 'article_failed') { articleReadFailures++; state.counts.failed++ }
              if (event.scanned !== undefined) state.counts.scanned = Math.max(state.counts.scanned, event.scanned)
              report(event.stage, event.message, event.stage === 'article_failed' ? 'warning' : 'info')
            },
            async onArticle(article) {
              check()
              if ((config.targetCount !== null && state.counts.completed >= config.targetCount) || isKnownArticle(article.articleId)) return false
              const source = storeHistoryArticleSource(article)
              if (source.deletedAt) return false
              state.sourceIds = [...state.sourceIds, source.id].slice(-100)
              state.currentSourceId = source.id; state.currentTitle = source.title
              state.counts.selected++
              report('storing', `已保存第 ${state.counts.selected} 篇文章原文，开始校对与二创`)
              let completed = false
              try {
                if (getHistorySourceArtifactState(source).transcript !== 'current') throw new Error('文章原文校验未通过')
                const result = await deps.process(source.id, {
                  through: 'recreate', signal,
                  onProgress: event => { check(); report(event.stage, event.message) },
                })
                check()
                if (result.status !== 'needs_review' || getHistorySourceArtifactState(result).rewritten !== 'current') {
                  throw new Error('文章处理未生成具有完整检查点的二创待审稿')
                }
                state.counts.completed++
                completed = true
                report('storing', `已完成 ${state.counts.completed} 篇文章二创待审稿；原文已保留`)
              } catch (error) {
                check()
                if (isHistorySourceRateLimitError(error)) throw error
                articleProcessFailures++; state.counts.failed++
                report('source_failed', `文章 #${source.id} 校对或二创失败：${safeHistoryJobMessage(error)}；原文和已完成检查点保留，继续采集下一篇`, 'warning')
              }
              state.currentSourceId = null; state.currentTitle = null
              // The collector counts only successful current drafts, not every saved original.
              return completed
            },
          })
          check()
          if (!searchExhausted && (config.targetCount === null || state.counts.completed < config.targetCount)) {
            throw new Error(`文章采集提前结束；已保存 ${state.counts.selected} 篇原文，完成 ${state.counts.completed} 篇二创待审稿，尚未完成采集范围或目标`)
          }
          report('completed', `${searchExhausted ? '指定时间范围已检索完毕' : '采集完成'}；已保存 ${state.counts.selected} 篇文章原文，完成 ${state.counts.completed} 篇二创待审稿${config.targetCount !== null && state.counts.completed < config.targetCount ? `，少于目标 ${config.targetCount} 篇` : ''}` + failureSummary(), state.counts.failed ? 'warning' : 'info')
          return { sourceIds: state.sourceIds, counts: state.counts }
        }
        report('checking', '检查下载、语音转写、文本校对与二创模型和音视频工具配置')
        const isYoutube = config.source === 'youtube'
        await (isYoutube ? deps.checkYoutubeReadiness : deps.checkReadiness)(signal)
        check()
        const excluded = isYoutube ? [] : db.select({ id: schema.historyScriptSources.sourceVideoId }).from(schema.historyScriptSources)
          .where(eq(schema.historyScriptSources.platform, config.source)).all().map(row => row.id)
        const encounteredVideos = new Set<string>()
        const existingYoutubeSource = (id: string) => db.select({ id: schema.historyScriptSources.id }).from(schema.historyScriptSources)
          .where(and(eq(schema.historyScriptSources.platform, 'youtube'), eq(schema.historyScriptSources.sourceVideoId, id))).get()
        const isKnownVideo = (id: string) => isYoutube
          ? encounteredVideos.has(id) || (config.existingSources === 'skip'
            ? Boolean(existingYoutubeSource(id)) : hasRecentHistoryYoutubeProduction(db.$client, id))
          : Boolean(db.select({ id: schema.historyScriptSources.id }).from(schema.historyScriptSources)
            .where(and(eq(schema.historyScriptSources.platform, config.source), eq(schema.historyScriptSources.sourceVideoId, id))).get())
        const failedSourceIds = new Set<number>()
        let searchExhausted = false
        const countLabel = () => config.targetCount === null ? `${state.counts.completed} 条` : `${state.counts.completed}/${config.targetCount} 条`
        const isTargetReached = () => config.targetCount !== null && state.counts.completed >= config.targetCount
        const processSavedSource = async (source: ReturnType<typeof storeHistorySource>, recollection?: {busy: string | null}, continueExisting = false) => {
          if (isYoutube) encounteredVideos.add(source.sourceVideoId)
          state.currentSourceId = source.id; state.currentTitle = source.title
          report('selecting', `已入选 ${state.counts.selected} 条来源，保存${isYoutube ? '原标题与频道信息' : '点赞与评论数'}；已保存待审稿 ${countLabel()}`)
          try {
            if (recollection?.busy && getHistorySourceArtifactState(source).rewritten !== 'current') {
              throw new Error(`${recollection.busy}；保留原检查点，待原任务确认后继续，未新建制作`)
            }
            const result = recollection?.busy ? source : await deps.process(source.id, {
              through: 'recreate',
              signal,
              storageRoot: deps.storageRoot,
              onProgress: event => { check(); report(event.stage, event.message) },
            })
            // A completed source is a current draft, not merely a downloaded video.
            if ((!recollection?.busy && result.status !== 'needs_review') || getHistorySourceArtifactState(result).rewritten !== 'current') {
              throw new Error('来源处理未生成具有完整检查点的待审稿')
            }
            state.counts.completed++
            failedSourceIds.delete(source.id)
            state.counts.failed = failedSourceIds.size
            report('storing', `已保存待审稿 ${countLabel()}`)
            if (isYoutube && config.existingSources !== 'skip' && continueExisting && deps.continueProduction) {
              try { await deps.continueProduction(source.id) }
              catch (error) { report('production_pending', `稿件已保存，原生产任务待继续：${safeHistoryJobMessage(error)}`, 'warning') }
            }
            check()
            state.currentSourceId = null; state.currentTitle = null
          } catch (error) {
            check()
            if (isHistorySourceRateLimitError(error)) {
              failedSourceIds.delete(source.id);state.counts.failed=failedSourceIds.size
              throw error
            }
            if (isYoutube && isHistoryYoutubeLoginError(error)) throw error
            failedSourceIds.add(source.id)
            state.counts.failed = failedSourceIds.size
            report('source_failed', `来源 #${source.id} 处理失败：${safeHistoryJobMessage(error)}；已有内容和检查点保留，继续采集下一条`, 'warning')
            state.currentSourceId = null; state.currentTitle = null
          }
        }
        const consumeCandidate = async (candidate: StoreHistorySourceInput | HistoryYoutubeCandidate) => {
          check()
          if (isTargetReached() || isKnownVideo('videoId' in candidate ? candidate.videoId : candidate.sourceVideoId)) return
          const existingYoutube = 'videoId' in candidate && existingYoutubeSource(candidate.videoId)
          let source = 'videoId' in candidate ? config.existingSources === 'skip'
            // A concurrent collector can insert after the optimistic exclusion check.
            ? runImmediateTransaction(() => existingYoutubeSource(candidate.videoId) ? null : storeHistoryYoutubeSource(candidate))
            : storeHistoryYoutubeSource(candidate) : storeHistorySource(candidate)
          if (!source) return
          let recollection: ReturnType<typeof prepareHistoryYoutubeRecollection> | undefined
          if (isYoutube) {
            try { await unlockHistorySource(source.id, deps.storageRoot) }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            const release = await acquireHistorySourceLock(source.id, deps.storageRoot)
            try { check(); recollection = prepareHistoryYoutubeRecollection(db.$client, source.id, ctx.taskId) }
            finally { await release() }
          }
          if (recollection?.recent) return
          if (recollection) source = getHistorySource(source.id)!
          if (source.deletedAt) return
          state.sourceIds = [...state.sourceIds, source.id].slice(-100)
          state.counts.selected++
          if (recollection?.renewed) report('recollecting', '上次成片已超过 15 天，旧稿与交付记录已保留，开始新一轮二创')
          await processSavedSource(source, recollection, Boolean(existingYoutube))
        }
        const reportVideo = (event: HistoryBrowserEvent) => {
          check()
          if (event.stage === 'exhausted') searchExhausted = true
          if (event.scanned !== undefined) state.counts.scanned = Math.max(state.counts.scanned, event.scanned)
          if (event.browserUrl !== undefined) state.browserUrl = safeBrowserUrl(event.browserUrl)
          report(event.stage, event.message, 'info', event.candidate)
        }
        let candidates: StoreHistorySourceInput[] = []
        if (isYoutube) {
          const saved = savedYoutubeSources(ctx.taskId)
          if (saved.length) {
            for (const source of saved) encounteredVideos.add(source.sourceVideoId)
            const pending = saved.filter(source => getHistorySourceArtifactState(source).rewritten !== 'current')
            const currentIndex = pending.findIndex(source => source.id === state.currentSourceId)
            if (currentIndex > 0) {
              const [current] = pending.splice(currentIndex, 1)
              pending.unshift(current!)
            }
            state.sourceIds = saved.slice(-100).map(source => source.id)
            state.counts.selected = saved.length
            state.counts.completed = saved.length - pending.length
            for (const source of pending) if (source.status === 'failed') failedSourceIds.add(source.id)
            state.counts.failed = failedSourceIds.size
            report('resuming', `继续原任务，优先恢复 ${pending.length} 条未完成来源；已完成 ${state.counts.completed} 条稿件保留`)
            for (const source of pending) {
              check()
              if (isTargetReached()) break
              await processSavedSource(source, undefined, true)
            }
          }
          const urls = config.youtube!.urls
          for (let index = 0; index < urls.length; index++) {
            check()
            if (isTargetReached()) break
            const url = urls[index]!, prefix = `YouTube 来源 ${index + 1}/${urls.length}`
            state.browserUrl = url
            report('browsing', `${prefix}：开始读取`)
            const scannedBefore = state.counts.scanned
            let sourceExhausted = false
            await deps.collectYoutube({ url, signal, targetCount: config.targetCount,
              isKnownVideo, isTargetReached, onCandidate: consumeCandidate,
              knownVideoReason: id => encounteredVideos.has(id) ? '本轮已处理，沿用本轮任务，避免重复执行'
                : config.existingSources === 'skip' ? '该 YouTube 来源已入库，当前任务只采集新来源'
                  : '最近 15 天已有成功交付的成片，跳过重复生产',
              report(event) {
                check()
                if (event.stage === 'exhausted') sourceExhausted = true
                reportVideo({ ...event, stage: event.stage === 'exhausted' ? 'channel_exhausted' : event.stage,
                  message: `${prefix}：${event.message}`,
                  ...(event.scanned !== undefined ? { scanned: scannedBefore + event.scanned } : {}),
                })
              },
            })
            check()
            if (isTargetReached()) break
            if (!sourceExhausted) throw new Error(`${prefix} 读取提前结束，尚未确认结果末尾；已有来源保留`)
            if (index === urls.length - 1) searchExhausted = true
          }
        } else {
          candidates = await deps.browse({ ...config, signal, excludeVideoIds: excluded, isKnownVideo, isTargetReached,
            onCandidate: consumeCandidate, report: reportVideo })
        }
        check()
        // Array-returning adapters remain compatible; streamed candidates are already in the database.
        for (const candidate of candidates) {
          await consumeCandidate(candidate)
          if (isTargetReached()) break
        }
        state.currentSourceId = null; state.currentTitle = null
        check()
        if (!searchExhausted && (config.targetCount === null || state.counts.completed < config.targetCount)) {
          throw new Error(`浏览已结束或没有更多符合要求的新视频，${config.targetCount === null ? '持续采集已停止' : '尚未达到采集目标'}；已保存 ${countLabel()}待审稿`)
        }
        const message = searchExhausted
          ? `搜索结果已到底，采集结束；已保存 ${state.counts.completed} 条待审稿${config.targetCount !== null && state.counts.completed < config.targetCount ? `；尚未达到目标 ${config.targetCount} 条` : ''}`
          : `采集完成：${countLabel()}待审稿`
        report('completed', message + failureSummary(), state.counts.failed ? 'warning' : 'info')
        return { sourceIds: state.sourceIds, counts: state.counts }
      } catch (error) {
        const message = safeHistoryJobMessage(error) + failureSummary()
        if (signal.aborted || ctx.isCancelRequested()) {
          report(ctx.isCancelRequested() ? 'stopped' : 'interrupted', (config.source === 'czgts' ? '任务已停止，已保存文章原文、校对稿和二创检查点保留' : '任务已停止，已完成内容和检查点保留；已发出的供应商请求仍可能完成或计费') + failureSummary(), 'warning')
        } else if (isHistorySourceRateLimitError(error)) {
          const paused=`服务限流（HTTP 429），采集已暂停；当前来源和已完成检查点保留，待服务恢复后继续：${message}`
          const delay=(error as {retryAfterMs?:number})?.retryAfterMs
          const retryAfterMs=typeof delay==='number' && Number.isFinite(delay) && delay>=0 ? delay : undefined
          ctx.event('history.rate_limit',{retryAfterMs})
          report('waiting_rate_limit',paused,'warning')
          throw new HistorySourceRateLimitError(paused,retryAfterMs)
        } else if (config.source === 'youtube' && isHistoryYoutubeLoginError(error)) {
          report('waiting_login', message, 'warning')
          throw new HistoryYoutubeLoginRequiredError(message)
        } else report('failed', message, 'error')
        throw new Error(message)
      }
    },
  }
}

export function registerHistorySourceJobHandler() {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler())
}
