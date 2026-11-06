import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../db/index.js'
import { getHistorySource, requireCurrentHistoryScript } from './history-script-library.js'
import { DeliveryError, getHistoryDelivery, hasOtherHistoryDesignInProgress, startHistoryCovers, startHistoryCoverDesign,
  type CoverDesignGenerator } from './history-script-delivery.js'

export type HistoryDeliveryAutomationStatus = 'queued' | 'generating' | 'completed' | 'failed' | 'needs_attention'
export interface HistoryDeliveryAutomationBranch { status: HistoryDeliveryAutomationStatus; message: string; retryableRejection?: boolean }
export interface HistoryDeliveryAutomationResult {
  design: HistoryDeliveryAutomationBranch
  covers: HistoryDeliveryAutomationBranch
}
export interface HistoryDeliveryAutomationOptions { expectedScriptSha256: string; videoId?: number; retryFailed?: boolean; retryRejected?: boolean }
interface Dependencies { root?: string; generate?: CoverDesignGenerator; generateCovers?: Parameters<typeof startHistoryCovers>[2] }
interface Intent {
  phase: 'queued' | 'admitted' | 'dispatched' | 'completed' | 'failed' | 'needs_attention'
  run_id: string | null
  attempts: number
  retry_at: number | null
  message: string
}
const sql = db.$client
const branch = (status: HistoryDeliveryAutomationStatus, message: string): HistoryDeliveryAutomationBranch => ({ status, message })
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const MAX_ATTEMPTS = 3

/** Only a refused request qualifies; an HTTP 503 by itself proves nothing. */
export function isHistoryPackagingRejection(message: string) {
  const response = /^(?:API error |Text model request failed: )(429|503)[: ]\s*([\s\S]*)$/.exec(message)
  if (!response || /uncertain|timeout|timed out|结果不明|任务 ID|"(?:task_?id|job_?id|operation_?id|id)"\s*:/i.test(response[2])) return false
  if (response[1] === '429') return true
  try {
    const body = JSON.parse(response[2])
    return ['gateway_concurrency_limit', 'provider_overloaded', 'overloaded_error', 'rate_limit_error'].includes(body?.error?.code)
      && !body?.data && !body?.result
  } catch { return false }
}

function rejectedBranch(message: string): HistoryDeliveryAutomationBranch {
  return { ...branch('failed', message), retryableRejection: isHistoryPackagingRejection(message) }
}

function requireVersion(id: number, expected: string) {
  const source = getHistorySource(id)
  if (!source) throw new DeliveryError('脚本不存在', 404)
  if (hash(requireCurrentHistoryScript(source)) !== expected) throw new DeliveryError('导出时的脚本已修改，请核对当前成片与稿件', 409)
}
function ensureSchema() {
  sql.exec(`CREATE TABLE IF NOT EXISTS history_delivery_design_intents (
    script_id INTEGER NOT NULL, script_sha256 TEXT NOT NULL,
    phase TEXT NOT NULL, run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER, message TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(script_id,script_sha256)
  ); CREATE TABLE IF NOT EXISTS history_video_design_intents (
    video_id INTEGER PRIMARY KEY, script_id INTEGER NOT NULL, script_sha256 TEXT NOT NULL,
    phase TEXT NOT NULL, run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER, message TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
}
type Delivery = ReturnType<typeof getHistoryDelivery>
function hasContent(delivery: Delivery) {
  return [delivery.title, delivery.baijiahaoTitle, delivery.description,
    ...['main_title', 'sub_title', 'kicker', 'ai_prompt'].map(key => delivery.coverDesign[key])]
    .some(value => typeof value === 'string' && value.trim()) || Boolean(delivery.coverPlan)
}
function completeDesign(delivery: Delivery, expected: string) {
  return [delivery.baijiahaoTitle, delivery.coverDesign.main_title]
    .every(value => typeof value === 'string' && value.trim())
    && (!delivery.coverPlan || delivery.coverPlan.script_sha256 === expected)
}
// These failures prove the connection was not accepted. Timeouts, socket resets
// and unknown provider errors never qualify for automatic re-dispatch.
function retryableConnectionFailure(error: unknown) {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null
  return ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(String(value?.code ?? value?.cause?.code))
}

function ensureDesign(id: number, options: HistoryDeliveryAutomationOptions, dependencies: Dependencies): HistoryDeliveryAutomationBranch {
  return sql.transaction(() => admitDesign(id, options, dependencies)).immediate()
}
function admitDesign(id: number, options: HistoryDeliveryAutomationOptions, dependencies: Dependencies): HistoryDeliveryAutomationBranch {
  requireVersion(id, options.expectedScriptSha256)
  ensureSchema()
  const table = options.videoId === undefined ? 'history_delivery_design_intents' : 'history_video_design_intents'
  const where = `script_id=? AND script_sha256=?${options.videoId === undefined ? '' : ' AND video_id=?'}`
  const key = [id, options.expectedScriptSha256, ...(options.videoId === undefined ? [] : [options.videoId])]
  const read = () => sql.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...key) as Intent | undefined
  const update = (phase: Intent['phase'], message: string, retryAt: number | null = null) => {
    sql.prepare(`UPDATE ${table} SET phase=?,message=?,retry_at=?,updated_at=? WHERE ${where}`)
      .run(phase, message, retryAt, new Date().toISOString(), ...key)
  }
  const delivery = getHistoryDelivery(id, options.videoId)
  if (delivery.designStatus === 'generating') return branch('generating', '正在生成标题与封面方案')
  if (completeDesign(delivery, options.expectedScriptSha256)) {
    update('completed', '已复用当前标题与封面方案')
    return branch('completed', '已复用当前标题与封面方案')
  }
  if (hasContent(delivery)) return branch('needs_attention', '已有文案或封面方案尚不完整或属于旧稿，请人工补齐；不会自动覆盖')
  let intent = read()
  if (intent?.phase === 'dispatched') {
    update('needs_attention', '方案调用已发出但结果不明，请核对后手动处理；不会自动重复调用')
    return branch('needs_attention', read()!.message)
  }
  if (intent?.phase === 'needs_attention') return branch('needs_attention', intent.message)
  if (intent?.phase === 'completed' || delivery.designStatus === 'completed') {
    return branch('needs_attention', '方案曾已完成，但当前内容已被清空或不完整，请人工核对')
  }
  if (intent?.phase === 'admitted') {
    if (intent.attempts >= MAX_ATTEMPTS) {
      update('failed', '方案初始化多次中断，请明确重试')
    } else update('queued', '方案尚未调用模型，正在恢复初始化')
    intent = read()
  }
  if (intent?.phase === 'failed') {
    const retryableRejection = delivery.designStatus === 'failed' && isHistoryPackagingRejection(intent.message)
      && isHistoryPackagingRejection(delivery.designError || '')
    if (options.retryFailed || options.retryRejected && retryableRejection) {
      sql.prepare(`UPDATE ${table} SET phase='queued',attempts=0,retry_at=NULL,message='已明确重试方案',updated_at=?
        WHERE ${where} AND phase='failed'`).run(new Date().toISOString(), ...key)
    } else if (intent.retry_at !== null && intent.attempts < MAX_ATTEMPTS) {
      if (Date.now() < intent.retry_at) return branch('queued', intent.message)
      update('queued', '连接未建立，继续有限次数重试')
    } else return { ...rejectedBranch(delivery.designError || intent.message), retryableRejection }
  } else if (!intent && delivery.designStatus === 'failed' && !options.retryFailed) {
    if (!(options.retryRejected && isHistoryPackagingRejection(delivery.designError || ''))) {
      return rejectedBranch(delivery.designError || '方案生成失败，请明确重试')
    }
  }
  sql.prepare(`INSERT OR IGNORE INTO ${table}
    (script_id,script_sha256${options.videoId === undefined ? '' : ',video_id'},phase,message,updated_at)
    VALUES(${key.map(() => '?').join(',')},'queued','等待生成标题与封面方案',?)`)
    .run(...key, new Date().toISOString())
  // Save an accepted retry before waiting so the next tick can resume it without
  // receiving the caller's one-shot retry flag again.
  if (delivery.coverStatus === 'generating') return branch('queued', '等待当前封面任务结束，再准备文案方案')
  if (hasOtherHistoryDesignInProgress(id, options.videoId)) return branch('queued', '等待另一版标题方案完成后生成本版差异方案')
  try {
    startHistoryCoverDesign(id, dependencies.generate, {
      admitted(runId) {
        const claimed = sql.prepare(`UPDATE ${table} SET phase='admitted',run_id=?,attempts=attempts+1,
          retry_at=NULL,message='方案已接纳，尚未调用模型',updated_at=? WHERE ${where} AND phase='queued'`)
          .run(runId, new Date().toISOString(), ...key)
        if (!claimed.changes) throw new DeliveryError('方案已由其他任务接纳，请等待现有结果', 409)
      },
      beforeDispatch(runId) {
        requireVersion(id, options.expectedScriptSha256)
        const current = getHistoryDelivery(id, options.videoId)
        if (current.designRunId !== runId || current.designStatus !== 'generating' || hasContent(current)) {
          throw new DeliveryError('方案任务或手工文案已变化，未调用模型', 409)
        }
        const dispatched = sql.prepare(`UPDATE ${table} SET phase='dispatched',message='正在生成标题与封面方案',updated_at=?
          WHERE ${where} AND run_id=? AND phase='admitted'`).run(new Date().toISOString(), ...key, runId)
        if (!dispatched.changes) throw new DeliveryError('方案执行权已变化，未调用模型', 409)
      },
      completed(runId) {
        sql.prepare(`UPDATE ${table} SET phase='completed',message='标题与封面方案已生成',updated_at=?
          WHERE ${where} AND run_id=?`).run(new Date().toISOString(), ...key, runId)
      },
      failed(runId, error) {
        const active = read()
        if (active?.run_id !== runId) return
        const needsAttention = error instanceof DeliveryError && error.status === 409
        const retryAt = !needsAttention && retryableConnectionFailure(error) && active.attempts < MAX_ATTEMPTS
          ? Date.now() + 5000 * active.attempts : null
        const message = `${errorMessage(error)}${retryAt === null ? '' : '；连接未建立，稍后有限次数重试'}`
        sql.prepare(`UPDATE ${table} SET phase=?,message=?,retry_at=?,updated_at=?
          WHERE ${where} AND run_id=?`)
          .run(needsAttention ? 'needs_attention' : 'failed', message, retryAt, new Date().toISOString(), ...key, runId)
      },
    }, options.videoId)
    return branch('generating', '正在生成标题与封面方案')
  } catch (error) {
    if (getHistoryDelivery(id, options.videoId).designStatus === 'generating') return branch('generating', '等待现有方案生成结果')
    throw error
  }
}

export function hasHistoryCoverFiles(id: number, root?: string, videoId?: number) {
  const delivery = getHistoryDelivery(id, videoId)
  if (delivery.coverStatus !== 'completed' || delivery.coversChanged) return false
  const base = fs.realpathSync(path.resolve(root || process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url))))
  return ['16:9','4:3','3:4'].every(ratio => {
    const url = delivery.covers[ratio]
    if (typeof url !== 'string' || !url.startsWith(`/static/history-deliveries/${id}/`)) return false
    try {
      const filename = fs.realpathSync(path.resolve(base,url.slice('/static/'.length)))
      return filename.startsWith(base + path.sep) && fs.statSync(filename).isFile() && fs.statSync(filename).size > 0
    } catch { return false }
  })
}
function ensureCovers(id: number, options: HistoryDeliveryAutomationOptions, dependencies: Dependencies): HistoryDeliveryAutomationBranch {
  requireVersion(id, options.expectedScriptSha256)
  const delivery = getHistoryDelivery(id, options.videoId)
  if (delivery.coverStatus === 'generating') return branch('generating','正在生成百家号视频封面')
  if (hasHistoryCoverFiles(id, dependencies.root, options.videoId)) return branch('completed','视频封面已就绪')
  if (!completeDesign(delivery, options.expectedScriptSha256)) return branch('queued','等待标题和封面方案')
  if (delivery.coverStatus === 'failed' && !options.retryFailed) {
    const retryableRejection = canRetryRejectedCovers(id, options, delivery)
    if (!options.retryRejected || !retryableRejection) return {
      ...branch('failed',delivery.error || '封面生成失败，请重试'), retryableRejection,
    }
  }
  startHistoryCovers(id, {}, dependencies.generateCovers, options.videoId)
  return branch('generating','正在生成百家号视频封面')
}

function canRetryRejectedCovers(id: number, options: HistoryDeliveryAutomationOptions, delivery: Delivery) {
  if (!isHistoryPackagingRejection(delivery.error || '') || !delivery.coverPlan
    || !['approved','selected'].includes(delivery.coverPlanStatus)
    || delivery.coverPlan.script_sha256 !== options.expectedScriptSha256
    || !sql.prepare("SELECT 1 FROM sqlite_master WHERE name='history_cover_image_checkpoints'").get()) return false
  const digest = options.videoId === undefined ? delivery.coverPlan.design_sha256
    : hash(JSON.stringify([options.videoId, delivery.coverPlan.design_sha256]))
  const records = sql.prepare(`SELECT c.dispatch_state,g.status,g.task_id,g.last_error_code,g.error_msg
    FROM history_cover_image_checkpoints c LEFT JOIN image_generations g ON g.id=c.generation_id
    WHERE c.source_id=? AND c.script_sha256=? AND c.design_sha256=?`)
    .all(id,options.expectedScriptSha256,digest) as Array<{ dispatch_state:string; status:string|null; task_id:string|null; last_error_code:string|null; error_msg:string|null }>
  // Every existing orientation must be either durable or definitely refused.
  // No new run may turn an accepted/unknown remote request into a re-submission.
  return records.length > 0 && records.every(record => record.status === 'completed'
    || record.status === 'failed' && !record.task_id
      && ['rate_limited','provider_overloaded'].includes(record.last_error_code || '')
      && isHistoryPackagingRejection(record.error_msg || ''))
    && records.some(record => record.status === 'failed')
}

/** Called only for an accepted video production; retains valid packaging across retries. */
export async function ensureHistoryDeliveryAutomation(id: number, options: HistoryDeliveryAutomationOptions,
  dependencies: Dependencies = {}): Promise<HistoryDeliveryAutomationResult> {
  try {
    requireVersion(id, options.expectedScriptSha256)
    if (options.videoId !== undefined) {
      const delivery = getHistoryDelivery(id, options.videoId)
      const base = path.resolve(dependencies.root || process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url)))
      const filename = path.resolve(base, (delivery.videoUrl || '').replace(/^\/static\//, ''))
      if (!filename.startsWith(path.join(base, 'history-deliveries', String(id)) + path.sep)
        || !fs.existsSync(filename) || !fs.statSync(filename).isFile() || !fs.statSync(filename).size) {
        throw new DeliveryError('本版成片尚未落盘或文件缺失，未生成标题与封面', 409)
      }
    }
  }
  catch (error) {
    const result = branch('needs_attention', errorMessage(error))
    return { design: result, covers: { ...result } }
  }
  const attempt = (action: () => HistoryDeliveryAutomationBranch) => {
    try { return action() }
    catch (error) { return branch(error instanceof DeliveryError ? 'needs_attention' : 'failed', errorMessage(error)) }
  }
  const design = attempt(() => ensureDesign(id, options, dependencies))
  const covers = design.status === 'completed'
    ? attempt(() => ensureCovers(id, options, dependencies))
    : { ...branch(design.status === 'failed' || design.status === 'needs_attention' ? design.status : 'queued', '等待标题和封面方案'),
      ...(design.retryableRejection ? { retryableRejection: true } : {}) }
  return { design, covers }
}
