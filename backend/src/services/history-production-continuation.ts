import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { db, runImmediateTransaction } from '../db/index.js'
import { getHistorySource, getHistorySourceArtifactState, requireCurrentHistoryScript, type HistorySource } from './history-script-library.js'
import { registerTaskHandler } from './tasks/registry.js'
import { createTaskInTransaction, getActiveTaskByIdempotency, getTask } from './tasks/store.js'
import type { TaskContext, TaskHandler } from './tasks/types.js'
import { NonRetryableTaskError } from './tasks/types.js'
import type { processHistorySource } from './history-source-pipeline.js'
import { getHistoryProductionState } from './history-production-state.js'
import type { continueHistoryVideoPublication } from './history-video-publication.js'

export const HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE = 'history.production.continue'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export const historyProductionSourceRevision = (source: HistorySource) => digest(JSON.stringify(source))
const taskKey = (sourceId: number) => `history-production-continue:${sourceId}`

export class HistoryProductionContinuationError extends NonRetryableTaskError {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 = 409) { super(message, 'history_continuation_invalid') }
}

interface ContinuationPayload {
  sourceId: number
  sourceRevision: string
  scriptSha256: string | null
}
interface ContinuationJob {
  id: number
  scriptSha256: string
  status: string
  productionStatus: string
  projectUrl?: string | null
  checkpoint?: string | null
  stage?: string
  error?: string | null
  productionCheckError?: string | null
}
interface ContinuationQueue {
  syncProduction(sourceId: number): Promise<{ jobs: ContinuationJob[] }>
  resume(id: number): Promise<unknown>
}
interface ContinuationDependencies {
  process: typeof processHistorySource
  queue: () => Promise<ContinuationQueue>
  startProduction: (sourceId: number, options: { retry: true; huashengBlockedReason?: string }) => Promise<unknown>
  continueVideo: typeof continueHistoryVideoPublication
  continueExport: (id:number)=>unknown|Promise<unknown>
  startBackfill: (sourceIds:number[])=>unknown|Promise<unknown>
  storageRoot?: string
}

function sourceOrThrow(sourceId: number) {
  if (!Number.isSafeInteger(sourceId) || sourceId < 1) throw new HistoryProductionContinuationError('稿件编号无效', 400)
  const source = getHistorySource(sourceId)
  if (!source) throw new HistoryProductionContinuationError('稿件不存在或已删除', 404)
  return source
}

function scriptHash(source: HistorySource) {
  return getHistorySourceArtifactState(source).rewritten === 'current' ? digest(requireCurrentHistoryScript(source)) : null
}

function productionState(source:HistorySource) {
  return getHistoryProductionState(db.$client,{id:source.id,title:source.title,rewrittenScript:source.rewrittenScript,
    artifactState:getHistorySourceArtifactState(source).rewritten})
}
function productionComplete(source: HistorySource) {
  return productionState(source).complete
}

export function getHistoryProductionContinuation(sourceId: number) {
  const source = sourceOrThrow(sourceId)
  const latest = db.$client.prepare('SELECT id FROM creation_tasks WHERE type=? AND scope_id=? ORDER BY id DESC LIMIT 1')
    .get(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, sourceId) as { id: number } | undefined
  return { task: latest ? getTask(latest.id) : null, complete: productionComplete(source) }
}

export function startHistoryProductionContinuation(sourceId: number, options: { expectedRevision?: string } = {}) {
  return runImmediateTransaction(() => {
    const source = sourceOrThrow(sourceId)
    const active = getActiveTaskByIdempotency(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, taskKey(sourceId))
    if (active) return { task: active, created: false, complete: false, message: '已复用正在执行的生产任务' }
    if (options.expectedRevision && options.expectedRevision !== historyProductionSourceRevision(source)) {
      throw new HistoryProductionContinuationError('稿件已更新，请刷新后继续生产')
    }
    if (productionComplete(source)) return { task: null, created: false, complete: true, message: '当前稿件的必需版本均已提交百家号，可查看审核与发表结果' }
    const result = createTaskInTransaction(db, {
      type: HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, scopeType: 'history-scripts', scopeId: sourceId,
      idempotencyKey: taskKey(sourceId), maxAttempts: 3,
      payload: { sourceId, sourceRevision: historyProductionSourceRevision(source), scriptSha256: scriptHash(source) } satisfies ContinuationPayload,
    })
    return { ...result, complete: false, message: result.created ? '已加入继续生产队列，将复用稿件与已完成产物' : '已复用正在执行的生产任务' }
  })
}

/** A live collection keeps its source lock; only the existing dead-owner check can release it. */
export async function waitForHistorySourceContinuation(sourceId: number, signal: AbortSignal, storageRoot?: string, onWait?: () => void) {
  const { unlockHistorySource } = await import('./history-source-pipeline.js')
  let reported = false
  for (;;) {
    signal.throwIfAborted()
    sourceOrThrow(sourceId)
    try { await unlockHistorySource(sourceId, storageRoot); return }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (!/Source is still owned by running process/.test(error instanceof Error ? error.message : String(error))) throw error
      if (!reported) { reported = true; onWait?.() }
      await delay(1000, undefined, { signal })
    }
  }
}

export function createHistoryProductionContinuationHandler(overrides: Partial<ContinuationDependencies> = {}): TaskHandler<ContinuationPayload> {
  const dependencies: ContinuationDependencies = {
    process: async (...args) => (await import('./history-source-pipeline.js')).processHistorySource(...args),
    queue: async () => (await import('./history-huasheng.js')).getHistoryHuashengService(),
    startProduction: async (...args) => (await import('./history-video-workflow.js')).startHistoryDualProduction(...args),
    continueVideo: async (...args) => (await import('./history-video-publication.js')).continueHistoryVideoPublication(...args),
    continueExport: async id => (await import('./history-huasheng-export.js')).getHistoryHuashengExportService().resume(id),
    startBackfill: async sourceIds => {
      const workflow=await import('./history-video-workflow.js')
      const result=workflow.queueHistoryRefinedBackfill(sourceIds)
      if(process.env.HISTORY_HUASHENG_WORKER_DISABLED==='1')await workflow.runHistoryDualProductionPass({sourceIds})
      return result
    },
    ...overrides,
  }
  return {
    resumable: true, maxAttempts: 3, concurrencyKey: payload => `history-source:${payload.sourceId}`,
    async run(ctx: TaskContext<ContinuationPayload>) {
      const check = () => {
        ctx.signal.throwIfAborted()
        if (ctx.isCancelRequested()) throw new Error('继续生产已停止，已完成内容保留')
      }
      check()
      let source = sourceOrThrow(ctx.payload.sourceId)
      if (ctx.payload.scriptSha256 && scriptHash(source) !== ctx.payload.scriptSha256) {
        throw new HistoryProductionContinuationError('稿件已更新，请刷新后继续生产')
      }
      if (productionComplete(source)) return { sourceId: source.id, stage: 'completed', message: '必需视频版本均已提交百家号，已有发表回执保留' }
      if (getHistorySourceArtifactState(source).rewritten !== 'current') {
        await waitForHistorySourceContinuation(source.id, ctx.signal, dependencies.storageRoot,
          () => ctx.progress('原采集任务仍在处理此稿，等待原任务释放后继续；不会重复转录', 0, 3))
        check()
        source = sourceOrThrow(source.id)
        if (getHistorySourceArtifactState(source).rewritten !== 'current') {
          ctx.progress('继续生成二创稿，复用已下载视频与文字检查点', 0, 3)
          source = await dependencies.process(source.id, { through: 'recreate', signal: ctx.signal, storageRoot: dependencies.storageRoot,
            onProgress: progress => { check(); ctx.progress(progress.message, 0, 3) } })
        }
      }
      const currentHash = digest(requireCurrentHistoryScript(source))
      const assertCurrent = () => {
        check()
        const current = sourceOrThrow(source.id)
        if (scriptHash(current) !== currentHash) throw new HistoryProductionContinuationError('稿件已更新，已有任务保留，请刷新后继续生产')
      }
      assertCurrent()
      // Downstream retries must keep the draft first accepted by this task.
      if (!ctx.payload.scriptSha256) {
        const payload = { ...ctx.payload, scriptSha256: currentHash }
        const updatedAt = new Date().toISOString()
        const locked = db.$client.prepare(`UPDATE creation_tasks SET payload_json=?,updated_at=?
          WHERE id=? AND status='running' AND lease_owner=? AND lease_token=? AND cancel_requested=0
            AND julianday(lease_expires_at)>julianday(?)`)
          .run(JSON.stringify(payload), updatedAt, ctx.taskId, ctx.workerId ?? null, ctx.leaseToken ?? null, updatedAt)
        if (locked.changes !== 1) throw new Error('stale_worker: 正文检查点未能保存，已停止后续制作')
        ctx.payload.scriptSha256 = currentHash
      }
      const state=productionState(source)
      const publicationIssues:string[]=[]
      for(const version of state.versions) {
        if(!version.automatic || !version.videoAvailable || version.videoId===null
          || !['retry_packaging','retry_upload','reconcile','publish'].includes(version.action))continue
        assertCurrent()
        try {
          const result=await dependencies.continueVideo(source.id,version.videoId,currentHash)
          assertCurrent()
          if(result.status==='needs_attention')publicationIssues.push(result.message)
        } catch(error) {
          assertCurrent()
          const message=(error instanceof Error?error.message:String(error)).slice(0,1500)
          publicationIssues.push(message)
          ctx.event('history.publication.needs_attention',{sourceId:source.id,videoId:version.videoId,message})
        }
      }
      if(state.productionMode && state.productionComplete) {
        const message=publicationIssues.length ? `成片已保留，发布准备待处理：${publicationIssues.join('；')}`
          : '当前成片已保留，已继续未完成的发布准备与原发表任务'
        ctx.progress(message,3,3)
        return {sourceId:source.id,stage:publicationIssues.length?'needs_attention':'publication',message}
      }
      if(state.productionMode==='motion_backfill') {
        assertCurrent()
        const production=await dependencies.startBackfill([source.id])
        check()
        const message='已继续原精细化补做任务，保留已有成片与发表回执'
        ctx.progress(message,3,3)
        return {sourceId:source.id,stage:'production',message,production}
      }
      ctx.progress('同步花生状态，核对原项目后继续未完成版本', 1, 3)
      let huashengBlockedReason: string | undefined
      let huashengJobId: number | undefined
      const huashengVersion=state.versions.find(version=>version.producer==='huasheng')
      try {
        if(huashengVersion?.stage==='export' && huashengVersion.state==='attention' && huashengVersion.exportJobId!==null) {
          if(huashengVersion.action==='retry_export') {
            assertCurrent()
            await dependencies.continueExport(huashengVersion.exportJobId)
            assertCurrent()
          } else huashengBlockedReason=huashengVersion.error || huashengVersion.message
        } else if(!huashengVersion?.videoAvailable) {
          const queue = await dependencies.queue()
          const synced = await queue.syncProduction(source.id)
          assertCurrent()
          const existing = synced.jobs.filter(job => job.scriptSha256 === currentHash).sort((a, b) => b.id - a.id)[0]
          huashengJobId = existing?.id
          if (existing?.productionCheckError) huashengBlockedReason = existing.productionCheckError
          else if (existing && !existing.projectUrl && [existing.stage, existing.checkpoint].includes('create_pending')) {
            huashengBlockedReason = existing.error || '花生创建结果尚未唯一确认，请同步状态后核对原项目'
          } else if (existing && existing.productionStatus === 'not_started' && ['waiting_login', 'needs_attention', 'failed', 'canceled'].includes(existing.status)) {
            await queue.resume(existing.id)
            assertCurrent()
          }
        }
      } catch (error) {
        assertCurrent()
        huashengBlockedReason = (error instanceof Error ? error.message : String(error)).slice(0, 1500)
      }
      if (huashengBlockedReason) ctx.event('history.huasheng.needs_attention', { sourceId: source.id, jobId: huashengJobId, message: huashengBlockedReason })
      assertCurrent()
      ctx.progress(huashengBlockedReason ? '花生等待核对，继续精细化版制作' : '继续未完成的视频版本，复用已有任务与成片', 2, 3)
      const production = await dependencies.startProduction(source.id, { retry: true, ...(huashengBlockedReason ? { huashengBlockedReason } : {}) })
      check()
      const message = huashengBlockedReason ? `精细化版已继续；花生待核对：${huashengBlockedReason}`
        : publicationIssues.length?`视频制作已继续；发表待处理：${publicationIssues.join('；')}`:'已继续未完成的视频版本和发表准备，可查看各版进度'
      ctx.progress(message, 3, 3)
      return { sourceId: source.id, stage: huashengBlockedReason ? 'needs_attention' : 'production', message, huashengJobId, production }
    },
  }
}

export function registerHistoryProductionContinuationHandler() {
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, createHistoryProductionContinuationHandler())
}
