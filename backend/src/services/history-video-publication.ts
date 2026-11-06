import { db } from '../db/index.js'
import { createHash } from 'node:crypto'
import { currentHistoryVideoDeliveries, ensureHistoryVideoPublicationSchema, recordHistoryVideoPublication, allowsHistoryVideoPublication, legacyHistoryVideoPublication, type HistoryVideoProducer } from './history-video-deliveries.js'
import { ensureHistoryDeliveryAutomation, isHistoryPackagingRejection } from './history-delivery-automation.js'
import type { HistorySocialUploadJob, HistorySocialUploadService } from './history-social-upload.js'
import { getHistorySource, requireCurrentHistoryScript } from './history-script-library.js'
import { getHistoryProductionState, getHistoryPublicationRevision, isHistorySubmissionReceipt } from './history-production-state.js'

type IntentStatus = 'pending' | 'queued' | 'completed' | 'failed' | 'needs_attention'
interface Intent { id:number; source_id:number; script_sha256:string; video_id:number; producer:HistoryVideoProducer; status:IntentStatus; attempts:number; next_attempt_at:number; error:string|null }
const sql = db.$client
const MAX_PACKAGING_RETRIES = 3

export function requestHistoryVideoPublication(sourceId:number, scriptSha256:string, videoId:number, producer:HistoryVideoProducer) {
  if(!allowsHistoryVideoPublication(sql,sourceId,scriptSha256,producer))return null
  if(getHistoryPublicationRevision(sql,sourceId,videoId))return null
  return recordHistoryVideoPublication(sql,sourceId,scriptSha256,videoId,producer)
}

interface PublicationDependencies { social?: Pick<HistorySocialUploadService,'listJobs'|'enqueue'>; packaging?: typeof ensureHistoryDeliveryAutomation }
interface PublicationRecoveryDependencies {
  social?: Pick<HistorySocialUploadService,'listJobs'|'retry'>
  packaging?: typeof ensureHistoryDeliveryAutomation
  exporter?: Pick<import('./history-huasheng-export.js').HistoryHuashengExportService,'resume'>
}
export class HistoryVideoPublicationError extends Error {
  constructor(message:string,readonly status:400|404|409=409) {super(message)}
}
function hasSubmissionReceipt(job:HistorySocialUploadJob|undefined) {
  // The social service validates identity and account before persisting a receipt.
  // Legacy completed/draft flags alone must not complete a publication intent.
  return job?.status==='completed' && isHistorySubmissionReceipt(job.result)
}
function existingPublication(social:Pick<HistorySocialUploadService,'listJobs'>,intent:Intent) {
  const jobs=social.listJobs(intent.source_id).filter(job=>job.mode==='publish' && job.target==='baijiahao-video'
    && (job.status!=='canceled' || job.publicationAttempted || job.result || job.operation==='recover'))
  const direct=jobs.find(job=>job.videoId===intent.video_id)
  if(direct)return direct
  const video=currentHistoryVideoDeliveries(sql,intent.source_id,intent.script_sha256).find(item=>item.id===intent.video_id)
  const legacy=video && legacyHistoryVideoPublication(sql,video)
  return legacy ? jobs.find(job=>String(job.id)===String(legacy.id)) : undefined
}

/** Continue one accepted edition without replacing its video or external task. */
export async function continueHistoryVideoPublication(sourceId:number,videoId:number,expectedScriptSha256:string,dependencies:PublicationRecoveryDependencies={}) {
  const assertCurrent=()=>{
    const source=getHistorySource(sourceId)
    if(!source)throw new HistoryVideoPublicationError('稿件不存在或已删除',404)
    let script:string
    try {script=requireCurrentHistoryScript(source)}
    catch {throw new HistoryVideoPublicationError('当前稿件版本已失效，请刷新后核对正文')}
    if(createHash('sha256').update(script).digest('hex')!==expectedScriptSha256)throw new HistoryVideoPublicationError('稿件版本已更新，请刷新后继续')
    const video=currentHistoryVideoDeliveries(sql,sourceId,expectedScriptSha256).find(item=>item.id===videoId)
    if(!video)throw new HistoryVideoPublicationError('指定成片不属于当前稿件版本')
    return video
  }
  const video=assertCurrent()
  const social=dependencies.social || (await import('./history-social-upload.js')).getHistorySocialUploadService()
  assertCurrent()
  const existing=existingPublication(social,{source_id:sourceId,script_sha256:expectedScriptSha256,video_id:videoId} as Intent)
  if(existing) {
    if(hasSubmissionReceipt(existing))return {reused:true,message:'本版已取得发表提交回执',job:existing,status:'completed'}
    if(['queued','running','awaiting_confirmation'].includes(existing.status))return {reused:true,message:'已复用原发表任务，请查看原任务进度',job:existing,status:'queued'}
    if(!['failed','blocked','uncertain','canceled','completed'].includes(existing.status))throw new HistoryVideoPublicationError('原发表记录缺少有效提交回执，请先核对原任务')
    const job=social.retry(existing.id)
    return {reused:true,message:job.message || '已继续原发表任务',job,status:job.status}
  }
  const source=getHistorySource(sourceId)!
  const version=getHistoryProductionState(sql,{id:source.id,title:source.title,rewrittenScript:source.rewrittenScript})
    .versions.find(item=>item.videoId===videoId)
  if(!version?.videoAvailable)throw new HistoryVideoPublicationError('当前成片文件不存在或不可读取，请先恢复原成片')
  const revision=getHistoryPublicationRevision(sql,sourceId,videoId)
  if(revision?.blocked)throw new HistoryVideoPublicationError(`原成片发表任务 #${revision.jobId} 尚未结束或结果待核对，请先处理原任务`)
  const automatic=!revision && allowsHistoryVideoPublication(sql,sourceId,expectedScriptSha256,video.producer)
  if(video.producer==='huasheng' && sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_huasheng_export_jobs'").get()) {
    const exportJob=sql.prepare(`SELECT id,status,design_status,cover_status FROM history_huasheng_export_jobs
      WHERE source_id=? AND script_sha256=? AND CAST(huasheng_job_id AS TEXT)=? ORDER BY id DESC LIMIT 1`)
      .get(sourceId,expectedScriptSha256,video.producerJobId) as {id:number;status:string;design_status:string|null;cover_status:string|null}|undefined
    if(exportJob && (['failed','needs_attention'].includes(exportJob.status)
      || exportJob.status==='completed' && [exportJob.design_status,exportJob.cover_status].some(value=>value!=='completed'))) {
      const exporter=dependencies.exporter || (await import('./history-huasheng-export.js')).getHistoryHuashengExportService()
      assertCurrent()
      const result=exporter.resume(exportJob.id)
      return {reused:true,message:'已继续原花生发布准备任务，复用当前成片',exportJob:result.job,status:result.job.status}
    }
  }
  const packaging=await (dependencies.packaging || ensureHistoryDeliveryAutomation)(sourceId,{expectedScriptSha256,videoId,retryFailed:true})
  assertCurrent()
  const branches=[packaging.design,packaging.covers]
  const blocked=branches.filter(branch=>['failed','needs_attention'].includes(branch.status))
  if(!automatic) {
    const ready=branches.every(branch=>branch.status==='completed')
    return {reused:true,status:blocked.length?'needs_attention':ready?'ready':'packaging',message:blocked.length
      ? blocked.map(branch=>branch.message).join('；') : ready?'本版发布材料已准备完成，可在可发表列表明确提交':'正在准备本版发布材料，完成后可明确提交当前成片'}
  }
  recordHistoryVideoPublication(sql,sourceId,expectedScriptSha256,videoId,video.producer)
  const status=blocked.length?'needs_attention':'pending'
  const message=blocked.length ? blocked.map(branch=>branch.message).join('；') : '已继续本版标题和封面准备，材料齐备后自动提交百家号'
  sql.prepare(`UPDATE history_video_publication_intents SET status=?,attempts=0,next_attempt_at=0,error=?,updated_at=?
    WHERE source_id=? AND script_sha256=? AND video_id=? AND status<>'completed'`)
    .run(status,blocked.length?message:null,new Date().toISOString(),sourceId,expectedScriptSha256,videoId)
  return {reused:true,message,status}
}

async function processIntent(intent:Intent, dependencies:PublicationDependencies) {
  if(intent.status==='failed') {
    // Recovery belongs to the original upload job. Only observe its outcome here;
    // missing or canceled attempts must never cause another upload or publish.
    const social=dependencies.social || (await import('./history-social-upload.js')).getHistorySocialUploadService()
    const existing=existingPublication(social,intent)
    return hasSubmissionReceipt(existing) ? {status:'completed'}
      : {status:'failed',error:existing?.error || existing?.message || intent.error}
  }
  const source = getHistorySource(intent.source_id)
  if (!source) throw new Error('稿件已删除')
  const script = requireCurrentHistoryScript(source)
  if (script === '' || createHash('sha256').update(script).digest('hex') !== intent.script_sha256) throw new Error('稿件已更新，保留旧发布任务')
  const videos = currentHistoryVideoDeliveries(sql,intent.source_id,intent.script_sha256)
  const video = videos.find(item => item.id === intent.video_id)
  if (!video) throw new Error('成片不再属于当前稿件版本')
  const { getHistorySocialUploadService } = await import('./history-social-upload.js')
  const social = dependencies.social || getHistorySocialUploadService()
  const existing = existingPublication(social,intent)
  if (existing) {
    if(['failed','blocked','uncertain','canceled'].includes(existing.status))return {status:'failed',error:existing.error || existing.message}
    if(existing.status==='completed')return hasSubmissionReceipt(existing) ? {status:'completed'} : {status:'failed',error:'原上传任务缺少百家号发表回执，保留原任务核对'}
    return {status:'queued'}
  }
  const revision=getHistoryPublicationRevision(sql,intent.source_id,intent.video_id)
  if(revision)return {status:'needs_attention',error:revision.blocked
    ? `原成片发表任务 #${revision.jobId} 尚未结束或结果待核对，请先处理原任务`
    : '本次成片为已提交作品的修订版，请在发表工作台明确选择再次发表'}
  const packaging = await (dependencies.packaging || ensureHistoryDeliveryAutomation)(intent.source_id,{
    expectedScriptSha256:intent.script_sha256,videoId:intent.video_id,
    ...(intent.status==='pending' && intent.attempts>0 && intent.error ? {retryRejected:true} : {}),
  })
  if (packaging.design.status !== 'completed' || packaging.covers.status !== 'completed') {
    const failures=[packaging.design,packaging.covers].filter(branch=>['failed','needs_attention'].includes(branch.status))
    const error=failures[0]?.message || null
    if(failures.length && failures.every(branch=>branch.status==='failed' && branch.retryableRejection)
      && intent.attempts<MAX_PACKAGING_RETRIES) {
      return {status:'pending',error,attempts:intent.attempts+1,retryDelay:30000*2**intent.attempts}
    }
    return {status:failures.length?'needs_attention':'pending',error}
  }
  await social.enqueue({sourceIds:[intent.source_id],targets:['baijiahao-video'],mode:'publish',videoIds:[intent.video_id],requestId:`history-video-${intent.id}`},{automatic:true})
  return {status:'queued'}
}

async function publicationPass(dependencies:PublicationDependencies) {
  ensureHistoryVideoPublicationSchema(sql)
  // A manually repaired material set can resume without another generation call.
  if(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_video_packaging'").get()) {
    sql.prepare(`UPDATE history_video_publication_intents SET status='pending',error=NULL,next_attempt_at=0,updated_at=?
      WHERE status='needs_attention' AND EXISTS (SELECT 1 FROM history_video_packaging p
        WHERE p.video_id=history_video_publication_intents.video_id AND p.script_id=history_video_publication_intents.source_id
          AND p.script_sha256=history_video_publication_intents.script_sha256
          AND p.cover_script_sha256=history_video_publication_intents.script_sha256
          AND p.design_status='completed' AND p.cover_status='completed' AND length(trim(p.baijiahao_title))>0
          AND julianday(p.updated_at)>julianday(history_video_publication_intents.updated_at))`)
      .run(new Date().toISOString())
  }
  // Adopt old explicitly refused packaging attempts once. This only schedules
  // inspection; the packaging service rechecks the current checkpoint before
  // it authorizes any generation, and existing upload jobs always win.
  const refused = sql.prepare(`SELECT * FROM history_video_publication_intents
    WHERE status='needs_attention' AND attempts<? AND next_attempt_at>=0 AND next_attempt_at<=?
      AND (error LIKE 'API error 429:%' OR error LIKE 'API error 503:%'
        OR error LIKE 'Text model request failed: 429 %' OR error LIKE 'Text model request failed: 503 %')
    ORDER BY next_attempt_at,id LIMIT 20`).all(MAX_PACKAGING_RETRIES,Date.now()) as Intent[]
  for(const intent of refused) {
    const retryable=isHistoryPackagingRejection(intent.error || '')
    sql.prepare(`UPDATE history_video_publication_intents SET status=?,next_attempt_at=?,updated_at=?
      WHERE id=? AND status='needs_attention' AND error=?`).run(
      retryable?'pending':'needs_attention',retryable?0:-1,new Date().toISOString(),intent.id,intent.error)
  }
  const rows = sql.prepare(`SELECT * FROM history_video_publication_intents WHERE status IN ('pending','queued','failed') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 20`).all(Date.now()) as Intent[]
  for (const row of rows) {
    try {
      const result = await processIntent(row,dependencies)
      const {status} = result
      const now = new Date().toISOString()
      if ('retryDelay' in result && typeof result.retryDelay==='number') sql.prepare("UPDATE history_video_publication_intents SET status='pending',attempts=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?")
        .run(result.attempts,result.error,Date.now()+result.retryDelay,now,row.id)
      else if (status === 'completed') sql.prepare("UPDATE history_video_publication_intents SET status='completed',error=NULL,updated_at=? WHERE id=?").run(now,row.id)
      else if (status === 'queued') sql.prepare("UPDATE history_video_publication_intents SET status='queued',error=NULL,next_attempt_at=?,updated_at=? WHERE id=?").run(Date.now()+30000,now,row.id)
      // -1 records a reviewed terminal material failure; legacy attention rows
      // with 0 can still be inspected once after upgrading this worker.
      else sql.prepare("UPDATE history_video_publication_intents SET status=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?").run(status,result.error || null,status==='needs_attention'?-1:Date.now()+(status==='failed'?30000:5000),now,row.id)
    } catch (error) {
      const attempts = row.attempts + 1, now = new Date().toISOString()
      const message=String(error instanceof Error ? error.message : error).slice(0,1000)
      const status=row.status==='failed'?'failed':attempts>=3 || /稿件已删除|稿件已更新|成片不再属于/.test(message)?'needs_attention':'pending'
      sql.prepare("UPDATE history_video_publication_intents SET status=?,attempts=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?")
        .run(status,attempts,message,Date.now()+Math.min(120000,5000*2**Math.min(attempts,5)),now,row.id)
    }
  }
}

let running:Promise<void>|undefined
export function runHistoryVideoPublicationPass(dependencies:PublicationDependencies={}) {
  return running ||= publicationPass(dependencies).finally(()=>{running=undefined})
}
let timer:ReturnType<typeof setInterval>|undefined
export function startHistoryVideoPublicationWorker() {
  if (timer || process.env.TASK_WORKER_DISABLED === '1') return { stop: async()=>{} }
  ensureHistoryVideoPublicationSchema(sql)
  const tick=()=>void runHistoryVideoPublicationPass().catch(error=>console.error('[history-video-publication]',error instanceof Error ? error.message : String(error)))
  timer=setInterval(tick,5000); timer.unref(); tick()
  return { stop: async()=>{if(timer)clearInterval(timer);timer=undefined;await running} }
}
