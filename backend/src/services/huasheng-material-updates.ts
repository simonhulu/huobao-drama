import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, runImmediateTransaction, schema } from '../db/index.js'
import { HuashengMaterialLibrary } from './huasheng-material-library.mjs'
import { getHeartbeatTimeoutMs, listWorkerHeartbeats } from './tasks/heartbeat.js'
import { registerTaskHandler } from './tasks/registry.js'
import { createTaskInTransaction, getActiveTaskByIdempotency, getTask, listTasks, requestCancel, transitionTask, transitionTaskWithExpiredLease } from './tasks/store.js'
import type { CreationTask, TaskHandler } from './tasks/types.js'

export const HUASHENG_MATERIAL_UPDATE_TASK = 'huasheng.materials.update'
const UPDATE_KEY = 'huasheng-materials:all'
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const OUTPUT_ROOT = path.join(ROOT, 'data/huasheng-recommendations')
const emptyCommand = z.object({}).strict()
const count = z.number().int().nonnegative()
const summarySchema = z.object({
  projects: count, clips: count, downloaded: count, reused: count,
  unavailableClips: count, metadataWarnings: count,
  failedProjects: count, failedClips: count, failedDownloads: count,
  metadataReadClips: count.default(0), metadataSkippedClips: count.default(0), repairedDownloads: count.default(0),
})

export class HuashengMaterialUpdateError extends Error {
  constructor(message: string, public statusCode: 400 | 404 | 409 | 503) {
    super(message)
    this.name = 'HuashengMaterialUpdateError'
  }
}

interface CollectionProgress {
  stage: string
  completedProjects: number
  totalProjects: number
  title?: string
  projectId?: string
  clipIndex?: number
  totalClips?: number
}
interface ProjectReport {
  status: string
  error?: string
  totalClips: number
  downloaded: number
  reused: number
  unavailableClips: number
  metadataWarnings: number
  failedClips: number
  failedDownloads: number
  metadataReadClips?: number
  metadataSkippedClips?: number
  repairedDownloads?: number
}
interface CollectorModule {
  readSession(): Promise<unknown>
  createClient(options: { session: unknown; signal: AbortSignal }): unknown
  collectAll(options: {
    allProjects: boolean; database: string; output: string
    projectConcurrency: number; metadataOnly: boolean; limit: number
  }, dependencies: {
    client: unknown; signal: AbortSignal; log: (message: string) => void
    onProgress: (progress: CollectionProgress) => void
  }): Promise<{ projects: ProjectReport[] }>
}
interface HandlerDependencies {
  loadCollector?: () => Promise<CollectorModule>
  outputRoot?: string
  now?: () => number
}

export function safeMaterialUpdateMessage(value: unknown) {
  return (value instanceof Error ? value.message : String(value))
    .replace(/花生接口错误\s+-101\b/g, '花生登录已过期，请打开花生浏览器重新登录')
    .replace(/(?:Cookie|SESSDATA|Authorization)\s*[:=]\s*[^\r\n]+/gi, '[登录凭据已省略]')
    .replace(/Bearer\s+\S+/gi, '[登录凭据已省略]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[网址省略]')
    .replace(/\/(?:Users|home|private|tmp|var|Volumes)\/[^\s"'<>]+/g, '[本地路径省略]')
    .slice(0, 1000)
}

function processAlive(pid: number | null) {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

function hasUpdateWorker() {
  return listWorkerHeartbeats().some(worker => worker.worker_id.startsWith('worker-general-')
    && worker.healthy && processAlive(worker.pid))
}

function settleInterruptedUpdates() {
  const workers = listWorkerHeartbeats()
  for (const task of listTasks({ type: HUASHENG_MATERIAL_UPDATE_TASK, status: 'running' })) {
    const owner = workers.find(worker => worker.worker_id === task.leaseOwner)
    const ownerPid = owner?.pid ?? Number(/^worker-general-([1-9]\d*)(?:-\d+)?$/.exec(task.leaseOwner || '')?.[1])
    const ownerExited = Boolean(ownerPid && !processAlive(ownerPid))
    // A confirmed exited process cannot renew its lease. The exact lease snapshot
    // still fences this transition against a newly claimed replacement worker.
    const expiredBefore = ownerExited && task.leaseExpiresAt ? Math.max(Date.now(), Date.parse(task.leaseExpiresAt)) : Date.now()
    transitionTaskWithExpiredLease(task, 'stale', {
      errorCode: 'huasheng_material_worker_interrupted',
      errorMessage: '素材更新服务中断，已保存的标注和视频保留，可重新开始更新',
    }, expiredBefore)
  }
  if (!hasUpdateWorker()) runImmediateTransaction(() => {
    if (hasUpdateWorker()) return
    for (const task of listTasks({ type: HUASHENG_MATERIAL_UPDATE_TASK, status: 'queued' })) {
      if (Date.now() - Date.parse(task.createdAt) < getHeartbeatTimeoutMs()) continue
      transitionTask(task.id, 'failed', {
        errorCode: 'huasheng_material_worker_unavailable',
        errorMessage: '素材更新执行器未运行，请恢复后端服务后重新开始更新',
      })
    }
  })
}

function readStats() {
  const library = new HuashengMaterialLibrary({ databasePath: db.$client.name })
  try {
    const { projects, clips, files, downloadedAssets } = library.stats()
    return { projects, clips, files, downloadedAssets }
  } finally { library.close() }
}

function describeUpdate(task: CreationTask | null) {
  if (!task) return null
  let summary = summarySchema.safeParse(task.result)
  if (!summary.success) {
    const event = db.select().from(schema.creationTaskEvents).where(and(
      eq(schema.creationTaskEvents.taskId, task.id),
      eq(schema.creationTaskEvents.eventType, 'huasheng.materials.summary'),
    )).orderBy(desc(schema.creationTaskEvents.id)).limit(1).get()
    try { summary = summarySchema.safeParse(JSON.parse(event?.dataJson || 'null')) } catch { /* Ignore invalid old events. */ }
  }
  const terminalMessage = task.status === 'canceled' ? '更新已中断，已保存的标注和视频保留'
    : task.status === 'stale' ? '更新服务中断，已保存的标注和视频保留'
    : task.status === 'failed' ? '本次更新未全部完成，已保存的标注和视频保留' : null
  return {
    id: task.id, status: task.status, cancelRequested: task.cancelRequested,
    createdAt: task.createdAt, startedAt: task.startedAt, completedAt: task.completedAt,
    progressCurrent: task.progressCurrent, progressTotal: task.progressTotal,
    progressMessage: terminalMessage ?? (task.progressMessage ? safeMaterialUpdateMessage(task.progressMessage)
      : task.status === 'queued' ? '等待开始更新全部项目' : null),
    errorMessage: task.errorMessage ? safeMaterialUpdateMessage(task.errorMessage) : null,
    result: summary.success ? summary.data : null,
  }
}

export function getHuashengMaterialOverview() {
  settleInterruptedUpdates()
  const rows = listTasks({ type: HUASHENG_MATERIAL_UPDATE_TASK })
  const task = rows.find(task => ['queued', 'running'].includes(task.status)) ?? rows[0] ?? null
  return { stats: readStats(), task: describeUpdate(task) }
}

export function startHuashengMaterialUpdate(input: unknown) {
  if (!emptyCommand.safeParse(input).success) throw new HuashengMaterialUpdateError('更新全部素材仅接受空 JSON 对象', 400)
  settleInterruptedUpdates()
  const { task, created } = runImmediateTransaction(() => {
    const active = getActiveTaskByIdempotency(HUASHENG_MATERIAL_UPDATE_TASK, UPDATE_KEY)
    if (active) return { task: active, created: false }
    if (!hasUpdateWorker()) throw new HuashengMaterialUpdateError('素材更新执行器未运行，请恢复后端服务后重试', 503)
    return createTaskInTransaction(db, {
      type: HUASHENG_MATERIAL_UPDATE_TASK, idempotencyKey: UPDATE_KEY,
      scopeType: 'huasheng-materials', payload: {}, maxAttempts: 1,
    })
  })
  return { stats: readStats(), task: describeUpdate(task), created }
}

export function stopHuashengMaterialUpdate(id: number) {
  const task = runImmediateTransaction(() => {
    if (getTask(id)?.type !== HUASHENG_MATERIAL_UPDATE_TASK) throw new HuashengMaterialUpdateError('素材更新任务不存在', 404)
    const result = requestCancel(id, { reason: '用户中断素材库更新', source: 'huasheng-materials', actor: 'local-user' })
    if (result.task?.status === 'queued' && result.task.cancelRequested) {
      return transitionTask(id, 'canceled', { progressMessage: '更新已中断，已保存的标注和视频保留' })
    }
    return result.task
  })
  return { stats: readStats(), task: describeUpdate(task) }
}

function summarize(projects: ProjectReport[]) {
  const sum = (key: keyof Omit<ProjectReport, 'status' | 'error'>) => projects.reduce((total, project) => total + (project[key] || 0), 0)
  return summarySchema.parse({
    projects: projects.length, clips: sum('totalClips'),
    downloaded: sum('downloaded') - sum('reused'), reused: sum('reused'),
    unavailableClips: sum('unavailableClips'), metadataWarnings: sum('metadataWarnings'),
    failedProjects: projects.filter(project => project.status === 'failed' || project.failedClips > 0 || project.failedDownloads > 0).length,
    failedClips: sum('failedClips'), failedDownloads: sum('failedDownloads'),
    metadataReadClips: sum('metadataReadClips'), metadataSkippedClips: sum('metadataSkippedClips'), repairedDownloads: sum('repairedDownloads'),
  })
}

export function createHuashengMaterialUpdateHandler(dependencies: HandlerDependencies = {}): TaskHandler {
  const loadCollector = dependencies.loadCollector ?? (async () => import(
    pathToFileURL(path.join(ROOT, 'backend/scripts/huasheng/collect-recommendations.mjs')).href
  ) as Promise<CollectorModule>)
  const now = dependencies.now ?? Date.now
  return {
    resumable: false, maxAttempts: 1, concurrencyKey: () => UPDATE_KEY,
    async run(ctx) {
      try {
        if (!emptyCommand.safeParse(ctx.payload).success) throw new Error('素材库更新不接受单个项目或自定义路径参数')
        ctx.signal.throwIfAborted()
        ctx.progress('正在读取花生登录状态', 0, 0)
        const collector = await loadCollector()
        ctx.signal.throwIfAborted()
        const session = await collector.readSession()
        ctx.signal.throwIfAborted()
        let lastProgressAt = 0
        let completed = 0
        const report = await collector.collectAll({
          allProjects: true, output: dependencies.outputRoot ?? OUTPUT_ROOT, database: db.$client.name,
          projectConcurrency: 8, metadataOnly: false, limit: Infinity,
        }, {
          client: collector.createClient({ session, signal: ctx.signal }), signal: ctx.signal, log: () => {},
          onProgress(progress) {
            ctx.signal.throwIfAborted()
            const current = Math.max(completed, progress.completedProjects)
            const timestamp = now()
            if (current === completed && timestamp - lastProgressAt < 750
              && ['clip_start', 'clip_complete', 'project_start', 'project_loaded'].includes(progress.stage)) return
            completed = current
            lastProgressAt = timestamp
            const project = progress.title || progress.projectId || ''
            const clip = progress.clipIndex ? `，分镜 ${progress.clipIndex}/${progress.totalClips ?? '?'}` : ''
            const message = progress.stage === 'project_list' ? '正在读取全部项目列表'
              : progress.stage === 'completed' ? '全部项目已检查，正在汇总更新结果'
              : progress.stage === 'project_complete' ? `已检查 ${current}/${progress.totalProjects} 个项目`
              : `正在更新 ${safeMaterialUpdateMessage(project)}${clip}`
            ctx.progress(message, current, progress.totalProjects)
          },
        })
        ctx.signal.throwIfAborted()
        const result = summarize(report.projects)
        // The event retains a useful partial summary when the worker records a failed task.
        ctx.event('huasheng.materials.summary', result)
        if (result.failedProjects) {
          const detail = report.projects.find(project => project.error)?.error
          throw new Error(`更新结束，${result.failedProjects} 个项目存在请求或下载失败（${result.failedClips} 个分镜、${result.failedDownloads} 个视频）；已保存的内容保留，可重新更新补齐${detail ? `。${safeMaterialUpdateMessage(detail)}` : ''}`)
        }
        ctx.progress(`更新完成：${result.projects} 个项目、${result.clips} 个分镜，读取推荐 ${result.metadataReadClips} 个、跳过 ${result.metadataSkippedClips} 个，下载 ${result.downloaded} 个视频、复用 ${result.reused} 个、补齐 ${result.repairedDownloads} 个文件`, result.projects, result.projects)
        return result
      } catch (error) {
        if (ctx.signal.aborted) throw new Error('素材库更新已中断，已保存的标注和视频保留')
        throw new Error(safeMaterialUpdateMessage(error))
      }
    },
  }
}

export function registerHuashengMaterialUpdateHandler() {
  registerTaskHandler(HUASHENG_MATERIAL_UPDATE_TASK, createHuashengMaterialUpdateHandler())
}
