import {HuashengQueueError, type HistoryHuashengService} from './history-huasheng.js'
import type {getHistoryFactory} from './history-factory.js'
import type {HistoryHuashengExportService} from './history-huasheng-export.js'
import type {MotionJob} from './history-motion-production.js'
import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { getHistorySource, requireCurrentHistoryScript } from './history-script-library.js'
import { ensureHistoryDualProductionSchema, recordHistoryRefinedBackfill, type HistoryProductionMode } from './history-video-deliveries.js'
import { getHistoryProductionStates } from './history-production-state.js'
import { needsHistoryScriptCondensation } from './history-script-preparation.js'

interface ProductionRow {
  source_id:number; script_sha256:string; huasheng_job_id:number; motion_job_id:string|null; episode_id:number|null;
  production_mode:HistoryProductionMode;
  huasheng_state:string; motion_state:string; huasheng_error:string|null; motion_error:string|null; export_requested:number; next_check_at:number
}
const sql=db.$client
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
const errorText=(error:unknown)=>String(error instanceof Error ? error.message : error).slice(0,1500)

export function historyDualProduction(sourceId:number) {
  ensureHistoryDualProductionSchema(sql)
  return sql.prepare('SELECT * FROM history_dual_production WHERE source_id=? ORDER BY created_at DESC').all(sourceId) as ProductionRow[]
}

export interface HistoryRefinedBackfillResult {
  sourceId:number; status:'queued'|'reused'|'blocked'; message:string;
  scriptSha256?:string; huashengJobId?:number; motionJobId?:string|null; episodeId?:number|null;
  productionMode?:HistoryProductionMode; huashengState?:string; motionState?:string;
  huashengError?:string|null; motionError?:string|null;
}

/** Admission is durable and does not create, inspect or export any Huasheng project. */
export function queueHistoryRefinedBackfill(sourceIds:number[], options:{retry?:boolean}={}) {
  if(!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length>100 || sourceIds.some(id=>!Number.isSafeInteger(id)||id<1)) {
    throw new HuashengQueueError('精细化补做需要明确选择 1 至 100 个有效文稿编号 sourceIds',400)
  }
  ensureHistoryDualProductionSchema(sql)
  const hasHuashengJobs=!!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_huasheng_jobs'").get()
  const results:HistoryRefinedBackfillResult[]=[]
  for(const sourceId of new Set(sourceIds)) {
    try {
      results.push(sql.transaction(()=>{
        const source=getHistorySource(sourceId)
        if(!source)throw Error('稿件不存在')
        const scriptSha256=digest(requireCurrentHistoryScript(source))
        const huasheng=hasHuashengJobs ? sql.prepare(`SELECT id FROM history_huasheng_jobs
          WHERE source_id=? AND script_sha256=? AND production_status='completed'
            AND status<>'canceled' AND cancel_requested=0 ORDER BY id DESC LIMIT 1`).get(sourceId,scriptSha256) as {id:number}|undefined : undefined
        if(!huasheng)throw Error('当前二创稿没有已完成且未取消的花生作品，不能加入历史补做')
        const previous=historyDualProduction(sourceId).find(row=>row.script_sha256===scriptSha256)
        recordHistoryRefinedBackfill(sql,sourceId,scriptSha256,huasheng.id)
        const retry=options.retry!==false && previous?.motion_state==='failed'
        if(retry)sql.prepare(`UPDATE history_dual_production SET motion_state='pending',motion_error=NULL,updated_at=?
          WHERE source_id=? AND script_sha256=?`).run(new Date().toISOString(),sourceId,scriptSha256)
        const row=historyDualProduction(sourceId).find(item=>item.script_sha256===scriptSha256)!
        return {sourceId,scriptSha256,huashengJobId:row.huasheng_job_id,motionJobId:row.motion_job_id,episodeId:row.episode_id,
          productionMode:row.production_mode,huashengState:row.huasheng_state,motionState:row.motion_state,
          huashengError:row.huasheng_error,motionError:row.motion_error,
          status:previous&&!retry?'reused' as const:'queued' as const,
          message:previous&&!retry?'已复用该稿件的制作记录':'已加入精细化补做队列，完成后自动发表百家号'}
      }).immediate())
    }catch(error){results.push({sourceId,status:'blocked',message:errorText(error)})}
  }
  return {results}
}
export async function startHistoryDualProduction(sourceId:number, options:{retry?:boolean;huashengBlockedReason?:string}={}) {
  let source=getHistorySource(sourceId)
  if(!source)throw Error('稿件不存在')
  const {prepareHistorySourceScript}=await import('./history-script-preparation.js')
  source=await prepareHistorySourceScript(source)
  const {getHistoryHuashengService}=await import('./history-huasheng.js')
  const queue=getHistoryHuashengService()
  const job=await queue.enqueue(sourceId,{dual:true})
  if(!job)throw Error('花生任务未被接纳')
  if(options.retry)sql.prepare(`UPDATE history_dual_production SET
    huasheng_state=CASE WHEN huasheng_state='failed' THEN 'pending' ELSE huasheng_state END,
    motion_state=CASE WHEN motion_state='failed' THEN 'pending' ELSE motion_state END,
    huasheng_error=NULL,motion_error=NULL WHERE source_id=? AND script_sha256=?`).run(sourceId,job.scriptSha256)
  if(options.huashengBlockedReason)sql.prepare(`UPDATE history_dual_production SET huasheng_state='failed',huasheng_error=?
    WHERE source_id=? AND script_sha256=? AND huasheng_state<>'completed'`).run(options.huashengBlockedReason,sourceId,job.scriptSha256)
  void runHistoryDualProductionPass({sourceIds:[sourceId]}).catch(error=>console.error('[history-dual-production]',errorText(error)))
  return {job,production:historyDualProduction(sourceId).find(item=>item.script_sha256===job.scriptSha256)}
}
let running:Promise<void>|undefined
type ProductionFactory=Pick<ReturnType<typeof getHistoryFactory>,'production'|'startFromSource'|'startEpisode'>
interface ProductionDependencies {
  sourceIds?:number[];
  queue?:Pick<HistoryHuashengService,'produce'|'getJob'|'checkProduction'>;
  factory?:ProductionFactory; exporter?:Pick<HistoryHuashengExportService,'enqueue'>;
  deliverCompletedMotion?:(job:MotionJob,factory:ProductionFactory,assertCurrent:()=>void)=>Promise<void>;
}
async function deliverCompletedMotion(job:MotionJob,factory:ProductionFactory,assertCurrent:()=>void) {
  const {verifiedMotionOutput,associateMotionDelivery}=await import('./history-motion-delivery.js')
  assertCurrent()
  const output=await verifiedMotionOutput(job,factory.production.root)
  assertCurrent()
  const association=await associateMotionDelivery(job,output,{},assertCurrent)
  assertCurrent()
  const previous=job.plan!.deliveryAssociation
  job.plan!.deliveryAssociation=job.factory ? {
    ...previous,status:association.status,sourceDelivery:association,outputSha256:association.outputSha256,
    checkedAt:association.checkedAt,message:association.message,videoUrl:previous?.videoUrl || association.videoUrl,
  } : association
  factory.production.write(job)
}
export function runHistoryDualProductionPass(dependencies:ProductionDependencies={}):Promise<void> {
  const requested=dependencies.sourceIds
  if(requested!==undefined && (!Array.isArray(requested) || requested.length>100 || requested.some(id=>!Number.isSafeInteger(id)||id<1))) {
    return Promise.reject(new HuashengQueueError('制作需要明确选择至多 100 个有效文稿编号 sourceIds',400))
  }
  const sourceIds=requested===undefined ? undefined : [...new Set(requested)]
  if(sourceIds?.length===0 || sourceIds===undefined && process.env.HISTORY_HUASHENG_WORKER_DISABLED==='1')return Promise.resolve()
  if(running && sourceIds===undefined)return running
  const previous=running
  const scope=sourceIds ? `AND source_id IN (${sourceIds.map(()=>'?').join(',')})` : ''
  const limit=sourceIds ? '' : 'LIMIT 50'
  // Explicit requests must each get their own pass when the automatic loop is disabled.
  running=(async()=>{
    if(previous)await previous.catch(()=>{})
    ensureHistoryDualProductionSchema(sql)
    const hasExportJobs=!!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_huasheng_export_jobs'").get()
    const rows=sql.prepare(`SELECT * FROM history_dual_production WHERE (huasheng_state IN ('pending','started') OR motion_state IN ('pending','started')) ${scope} ORDER BY updated_at,created_at ${limit}`).all(...(sourceIds || [])) as ProductionRow[]
    // Reconcile failed projections separately so old failures cannot consume
    // the admission slots for accepted work. This only follows the original job.
    rows.push(...sql.prepare(`SELECT * FROM history_dual_production
      WHERE motion_state='failed' AND motion_job_id IS NOT NULL
        AND huasheng_state NOT IN ('pending','started') AND next_check_at<=?
        ${scope}
      ORDER BY next_check_at,created_at ${limit}`).all(Date.now(),...(sourceIds || [])) as ProductionRow[])
    // Older projections completed at export admission. Reconcile only their
    // original tasks so a missing delivery remains visible and recoverable.
    rows.push(...sql.prepare(`SELECT * FROM history_dual_production
      WHERE production_mode='dual' AND huasheng_state IN ('completed','failed')
        AND motion_state NOT IN ('pending','started') AND next_check_at<=?
        AND NOT (motion_state='failed' AND motion_job_id IS NOT NULL)
        ${scope}
      ORDER BY next_check_at,updated_at ${limit}`).all(Date.now(),...(sourceIds || [])) as ProductionRow[])
    if(!rows.length)return
    const sources=new Map(rows.map(row=>[row.source_id,getHistorySource(row.source_id)]))
    const currentStates=new Map(getHistoryProductionStates(sql,[...sources.values()].filter(source=>!!source)
      .map(source=>({id:source!.id,title:source!.title,rewrittenScript:source!.rewrittenScript,provenance:source!})))
      .map(state=>[state.scriptId,state]))
    const queue=rows.some(row=>row.production_mode!=='motion_backfill')
      ? dependencies.queue || (await import('./history-huasheng.js')).getHistoryHuashengService() : undefined
    const factory=dependencies.factory || (await import('./history-factory.js')).getHistoryFactory()
    let motionJobs:MotionJob[]|undefined
    for(const row of rows) {
      const key=[row.source_id,row.script_sha256] as const
      const set=(branch:'huasheng'|'motion',state:string,error:string|null=null)=>sql.prepare(`UPDATE history_dual_production SET ${branch}_state=?,${branch}_error=?,updated_at=? WHERE source_id=? AND script_sha256=?`).run(state,error,new Date().toISOString(),...key)
      if(!['pending','started'].includes(row.motion_state) && !['pending','started'].includes(row.huasheng_state)) {
        sql.prepare('UPDATE history_dual_production SET next_check_at=? WHERE source_id=? AND script_sha256=?').run(Date.now()+60000,...key)
      }
      try {
      const source=getHistorySource(row.source_id)
      const assertCurrent=()=>{
        const current=getHistorySource(row.source_id)
        if(!current || digest(requireCurrentHistoryScript(current))!==row.script_sha256)throw Error('正文已更新，原制作记录保留，请为新稿开始制作')
      }
      try {if(!source || digest(requireCurrentHistoryScript(source))!==row.script_sha256)throw Error('正文已更新，原制作记录保留，请为新稿开始制作')}
      catch(error){if(['pending','started'].includes(row.huasheng_state))set('huasheng','failed',errorText(error));if(['pending','started'].includes(row.motion_state))set('motion','failed',errorText(error));continue}
      const editionState=currentStates.get(row.source_id)
      const huashengEdition=editionState?.versions.find(version=>version.producer==='huasheng')
      const motionEdition=editionState?.versions.find(version=>version.producer==='motion')
      // A validated receipt belongs to a specific delivered version and producer task.
      // Releasing its local bytes must not re-export or recreate that finished task.
      const huashengSubmitted=huashengEdition && ['submitted','published'].includes(huashengEdition.state)
        && huashengEdition.producerJobId===String(row.huasheng_job_id)
      const motionSubmitted=motionEdition && ['submitted','published'].includes(motionEdition.state)
        && !!motionEdition.producerJobId && (!row.motion_job_id || motionEdition.producerJobId===row.motion_job_id)
      const huashengProduced=huashengEdition?.videoAvailable || huashengSubmitted
      const motionProduced=motionEdition?.videoAvailable || motionSubmitted
      if(huashengProduced && row.production_mode!=='motion_backfill') {
        set('huasheng','completed');row.huasheng_state='completed'
      }
      if(motionSubmitted || motionEdition?.videoAvailable && row.motion_state==='pending') {
        set('motion','completed');row.motion_state='completed'
      }
      if(row.production_mode==='dual' && row.motion_state==='completed' && row.motion_job_id && !motionProduced) {
        set('motion','started');row.motion_state='started'
      }
      if(row.production_mode!=='motion_backfill' && row.huasheng_state==='pending') {
        try {
          const result=await queue!.produce([row.huasheng_job_id])
          const state=result.results[0]
          if(state?.status==='blocked')throw Error(state.message)
          set('huasheng','started')
        } catch(error){set('huasheng','failed',errorText(error))}
      }
      let motionJobId=row.motion_job_id
      let motionState=row.motion_state
      if(motionState==='failed' && motionJobId) {
        const existing=factory.production.find(motionJobId)
        if(existing && ['queued','planning','selecting','rendering','validating','completed'].includes(existing.status)) {
          if(existing.scriptId!==row.source_id || existing.profile!=='16:9' || digest(existing.script)!==row.script_sha256
            || row.episode_id && existing.factory?.episodeId!==row.episode_id)throw Error('原精细化任务与锁定稿件不匹配，已保留原任务')
          motionState='started'
          set('motion','started')
        }
      }
      if(motionState==='pending') {
        // Register every accepted task; the factory runner owns execution and render concurrency.
        const reusable=row.production_mode==='motion_backfill' ? (motionJobs ||= factory.production.list()).find(job=>job.status==='completed' && job.factory
          && job.scriptId===row.source_id && job.profile==='16:9' && digest(job.script)===row.script_sha256) : undefined
        if(reusable) {
          motionJobId=reusable.id
          motionState='started'
          sql.prepare('UPDATE history_dual_production SET motion_job_id=?,episode_id=? WHERE source_id=? AND script_sha256=?')
            .run(reusable.id,reusable.factory!.episodeId,...key)
          set('motion','started')
        } else try {
          const previous=motionJobId ? factory.production.find(motionJobId) : null
          if(motionJobId && !previous)throw Error('原精细化任务不存在，已保留制作记录，请恢复原任务')
          if(previous && (previous.scriptId!==row.source_id || previous.profile!=='16:9' || digest(previous.script)!==row.script_sha256)) {
            throw Error('原精细化任务与锁定稿件不匹配，已保留原任务')
          }
          const needsCondensation=needsHistoryScriptCondensation(requireCurrentHistoryScript(source!),JSON.parse(source!.reviewJson || '{}'))
          if(needsCondensation && previous && ['queued','planning','selecting','rendering','validating','completed'].includes(previous.status)) {
            // The runner owns an accepted snapshot; starting it again may prepare a different manuscript.
            motionJobId=previous.id
          } else {
            if(needsCondensation && !previous?.outputPath)throw Error('原稿超过4500字且尚未缩写，请先缩写原稿后为新稿开始制作；原任务已保留')
            const result=previous?.factory
              ? await factory.startEpisode(previous.factory.episodeId,{profile:'16:9',retry:true})
              : await factory.startFromSource(source!,{profile:'16:9'})
            sql.prepare('UPDATE history_dual_production SET motion_job_id=?,episode_id=? WHERE source_id=? AND script_sha256=?')
              .run(result.job?.id || null,result.episode.id,...key)
            motionJobId=result.job?.id || null
          }
          motionState='started'
          set('motion','started')
        } catch(error){motionState='failed';set('motion','failed',errorText(error))}
      }
      if(row.production_mode!=='motion_backfill' && !huashengProduced) {
      let huasheng:ReturnType<HistoryHuashengService['getJob']>|undefined
      try { huasheng=queue!.getJob(row.huasheng_job_id) }
      catch(error) { set('huasheng','failed',errorText(error)) }
      if(huasheng && (['failed','needs_attention','canceled'].includes(huasheng.status) || huasheng.cancelRequested)) {
        set('huasheng','failed',huasheng.error || huasheng.message || '原花生任务已取消')
      }
      const activeHuasheng=huasheng && huasheng.status!=='canceled' && !huasheng.cancelRequested ? huasheng : undefined
      const exportRecorded=hasExportJobs && !!sql.prepare(`SELECT 1 FROM history_huasheng_export_jobs
        WHERE huasheng_job_id=? AND source_id=? AND script_sha256=?`).get(row.huasheng_job_id,...key)
      // The legacy request marker is not proof that an export task survived.
      let exportRequested = row.export_requested === 1 && exportRecorded
      if(activeHuasheng?.projectUrl && !exportRequested) {
        try {
          const {getHistoryHuashengExportService}=await import('./history-huasheng-export.js')
          assertCurrent()
          await (dependencies.exporter || getHistoryHuashengExportService()).enqueue([row.source_id])
          sql.prepare('UPDATE history_dual_production SET export_requested=1 WHERE source_id=? AND script_sha256=?').run(...key)
          exportRequested = true
        }catch(error){
          if(activeHuasheng.productionStatus==='completed')set('huasheng','started',errorText(error))
          else sql.prepare('UPDATE history_dual_production SET huasheng_error=? WHERE source_id=? AND script_sha256=?').run(errorText(error),...key)
        }
      }
      // Accepted work needs progress for delivery, scoped to its original cloud job.
      if(activeHuasheng?.status==='submitted' && ['queued','creating'].includes(activeHuasheng.productionStatus)
        && Date.now()>row.next_check_at) {
        try { await queue!.checkProduction(row.source_id,{automatic:true,jobIds:[row.huasheng_job_id]}) }
        catch(error) { sql.prepare('UPDATE history_dual_production SET huasheng_error=? WHERE source_id=? AND script_sha256=?').run(errorText(error),...key) }
        sql.prepare('UPDATE history_dual_production SET next_check_at=? WHERE source_id=? AND script_sha256=?').run(Date.now()+60000,...key)
      }
      if(huashengEdition?.videoAvailable)set('huasheng','completed')
      else if(huashengEdition?.state==='attention' && huashengEdition.stage==='export') {
        set('huasheng','failed',huashengEdition.error || huashengEdition.message)
      } else if(activeHuasheng?.productionStatus==='completed' && exportRequested)set('huasheng','started')
      }
      const motion=motionJobId && motionState==='started' ? factory.production.find(motionJobId) : null
      if(motion?.status==='completed') {
        try {
          assertCurrent()
          if(row.production_mode==='motion_backfill' || !motionProduced) {
            if(motion.scriptId!==row.source_id || motion.profile!=='16:9' || digest(motion.script)!==row.script_sha256
              || row.episode_id && motion.factory?.episodeId!==row.episode_id)throw Error('精细化成片与当前锁定稿件不匹配')
            await (dependencies.deliverCompletedMotion || deliverCompletedMotion)(motion,factory,assertCurrent)
            assertCurrent()
          }
          set('motion','completed')
        }catch(error){set('motion','failed',errorText(error))}
      }
      else if(motion?.status==='failed') {
        if(/服务重启中断制作/.test(motion.error || ''))set('motion','pending')
        else set('motion','failed',motion.error || motion.message)
      }
      } catch(error) {
        motionJobs=undefined
        if(row.motion_state!=='completed')set('motion','failed',errorText(error))
        console.error(`[history-dual-production] source ${row.source_id}: ${errorText(error)}`)
      } finally {
        // Rotate inspected active rows even when they are only waiting for a
        // slot, so a long-running first page cannot hide the rest of the queue.
        sql.prepare('UPDATE history_dual_production SET updated_at=? WHERE source_id=? AND script_sha256=?').run(new Date().toISOString(),...key)
      }
    }
  })().finally(()=>{if(running===pass)running=undefined})
  const pass=running
  return running
}
export function startHistoryDualProductionWorker() {
  if(process.env.TASK_WORKER_DISABLED==='1')return {stop:async()=>{}}
  const tick=()=>void runHistoryDualProductionPass().catch(error=>console.error('[history-dual-production]',errorText(error)))
  const timer=setInterval(tick,5000);timer.unref();tick()
  return {stop:async()=>{clearInterval(timer);await running}}
}
