import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {lockSource,writeDurable} from './history-prune-records.js'

type Row=Record<string,any>
const branchCandidates=[11,13,17,19,22,24,27,28,30,32,33,34,36,37,39,43,46,147]
const sourceCandidates=new Set([11,13,22,24,30,32,33,34,37,147])
const terminal=new Set(['succeeded','failed','canceled','stale'])
const json=(value:string)=>JSON.parse(value || '{}')
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

function hasRow(db:Database.Database,table:string,column:string,id:number) {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return false
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`).get(id)
}
function containsMedia(directory:string):boolean {
  if(!fs.existsSync(directory))return false
  if(fs.lstatSync(directory).isSymbolicLink())return true
  return fs.readdirSync(directory,{withFileTypes:true}).some(entry=>{
    if(entry.isSymbolicLink())return true
    if(entry.isDirectory())return containsMedia(path.join(directory,entry.name))
    return !entry.name.endsWith('.json') || /narration|audio|render|delivery/i.test(entry.name)
  })
}
function mediaReference(value:any):boolean {
  if(!value || typeof value!=='object')return false
  return Object.entries(value).some(([key,item])=>
    /^(audioPath|imagePath|sourcePath|outputPath|videoUrl|previewUrl)$/.test(key) && !!item
      || typeof item==='object' && mediaReference(item))
}

export function planUnstartedPrune(db:Database.Database,root:string) {
  const branchSourceIds:number[]=[],jobIds:number[]=[],sourceIds:number[]=[],episodeIds:number[]=[],motionJobIds:string[]=[],motionSourceIds:number[]=[]
  const skipped:Array<{sourceId:number;reason:string}>=[]
  const tasks=db.prepare("SELECT * FROM creation_tasks WHERE type IN ('history.source','history.production.continue')").all() as Row[]
  if(tasks.some(task=>task.type==='history.source' && !terminal.has(task.status)))throw Error('An active history collection task prevents cleanup')
  for(const id of branchCandidates) {
    const source=db.prepare('SELECT * FROM history_script_sources WHERE id=? AND deleted_at IS NULL').get(id) as Row|undefined
    if(!source)continue
    const jobs=db.prepare('SELECT * FROM history_huasheng_jobs WHERE source_id=?').all(id) as Row[]
    const eligible=jobs.filter(job=>{
      const dual=db.prepare('SELECT * FROM history_dual_production WHERE source_id=? AND script_sha256=?').get(id,job.script_sha256) as Row|undefined
      return job.status==='needs_attention' && job.production_status==='not_started' && !job.owner
        && !job.project_url && !job.video_url && !job.cancel_requested
        && ![job.stage,job.checkpoint].includes('create_pending')
        && json(source.review_json)?.huashengQueue?.status!=='pending'
        && dual?.huasheng_job_id===job.id && dual.huasheng_state==='failed'
        && !hasRow(db,'history_huasheng_export_jobs','source_id',id)
        && !db.prepare("SELECT 1 FROM history_video_deliveries WHERE script_id=? AND producer<>'motion'").get(id)
        && !db.prepare("SELECT 1 FROM history_social_upload_jobs WHERE source_id=? AND COALESCE(video_producer,'')<>'motion'").get(id)
    })
    if(!eligible.length){skipped.push({sourceId:id,reason:'Huasheng branch is active, externally associated, archived or unresolved'});continue}
    branchSourceIds.push(id);jobIds.push(...eligible.map(job=>job.id))
    if(!sourceCandidates.has(id))continue
    const motions=db.prepare('SELECT * FROM history_motion_productions WHERE script_id=?').all(id) as Row[]
    let removable=motions.length>0 && eligible.length===jobs.length
      && !['downloading','transcribing','rewriting','processing'].includes(source.status)
      && !tasks.some(task=>!terminal.has(task.status) && Number(json(task.payload_json)?.sourceId || task.scope_id)===id)
    for(const [table,column] of [
      ['history_huasheng_export_jobs','source_id'],['history_video_deliveries','script_id'],
      ['history_video_publication_intents','source_id'],['history_social_upload_jobs','source_id'],
      ['history_script_article_queue','source_id'],
      ['history_production_reservations','source_id'],['history_motion_jobs','script_id'],
    ])if(hasRow(db,table!,column!,id))removable=false
    const linkedEpisodes:number[]=[]
    for(const motion of motions) {
      const snapshot=json(motion.snapshot),link=snapshot.factory
      const projection=db.prepare('SELECT * FROM history_dual_production WHERE source_id=? AND motion_job_id=?').get(id,motion.id) as Row|undefined
      if(motion.status!=='failed' || snapshot.status!=='failed' || snapshot.outputPath
        || Object.keys(snapshot.plan?.visuals || {}).length || mediaReference(snapshot.plan)
        || containsMedia(path.join(root,'data/storage/history-motion',motion.id)) || !link
        || projection?.motion_state!=='failed' || projection.huasheng_state!=='failed'
        || projection.episode_id!==link.episodeId) {removable=false;continue}
      const episode=db.prepare('SELECT * FROM episodes WHERE id=?').get(link.episodeId) as Row|undefined
      const meta=episode?json(episode.metadata).historyFactory:undefined
      if(!episode || meta?.jobId!==motion.id || meta?.sourceId!==id
        || ['pre_tts_audio_url','video_url','thumbnail','bgm_audio_url','secondary_bgm_audio_url',
          'cover_image_4x3_url','cover_image_3x4_url','recap_video_url','intro_video_url'].some(key=>!!episode[key])
        || hasRow(db,'remotion_renders','project_id',link.projectId)
        || hasRow(db,'remotion_assets','project_id',link.projectId)) {removable=false;continue}
      linkedEpisodes.push(episode.id)
    }
    if(removable){
      motionSourceIds.push(id);motionJobIds.push(...motions.map(job=>job.id));episodeIds.push(...linkedEpisodes)
      if(!hasRow(db,'history_script_deliveries','script_id',id))sourceIds.push(id)
    }
    else skipped.push({sourceId:id,reason:'Retained source: production, media, delivery, upload or workflow evidence'})
  }
  return {branchSourceIds,jobIds,sourceIds,motionJobIds,motionSourceIds,episodeIds:[...new Set(episodeIds)],skipped}
}

function protectedDigest(db:Database.Database,sourceIds:number[],motionJobIds:string[]) {
  const selected=new Set(sourceIds)
  const rows:Record<string,unknown>={}
  for(const table of ['history_script_deliveries','history_video_deliveries','history_social_upload_jobs','history_video_publication_intents']) {
    rows[table]=db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  }
  rows.motions=(db.prepare('SELECT * FROM history_motion_productions ORDER BY id').all() as Row[]).filter(row=>!motionJobIds.includes(row.id))
  rows.sources=(db.prepare('SELECT * FROM history_script_sources ORDER BY id').all() as Row[]).filter(row=>!selected.has(row.id))
  return digest(rows)
}

export function pruneUnstartedRecords(db:Database.Database,root:string,apply=false) {
  root=fs.realpathSync(root)
  const report={status:apply?'prepared':'planned',startedAt:new Date().toISOString(),...planUnstartedPrune(db,root),
    deletedSources:0,archivedBranches:0,deletedMotionTasks:0,deletedEpisodeProjections:0,protectedRowsVerified:false,
    reportPath:null as string|null,finishedAt:null as string|null}
  if(!apply)return report
  const directory=path.join(root,'data/reports')
  fs.mkdirSync(directory,{recursive:true})
  report.reportPath=path.join(directory,`history-unstarted-cleanup-${report.startedAt.replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.json`)
  const releases:Array<()=>void>=[]
  try {
    db.transaction(()=>{
      Object.assign(report,planUnstartedPrune(db,root))
      const reclaimed:Row[]=[]
      for(const id of report.motionSourceIds)releases.push(lockSource(root,id,reclaimed))
      const protectedBefore=protectedDigest(db,report.sourceIds,report.motionJobIds)
      // Persist only identifiers and results; the user declined recoverable backups.
      writeDurable(report.reportPath!,Buffer.from(JSON.stringify(report,null,2)))
      for(const id of report.jobIds) {
        report.archivedBranches+=db.prepare(`UPDATE history_huasheng_jobs SET status='canceled',stage='record_cleanup',
          cancel_requested=1,manual_requested=0,message='未开始分支已清理，精细化制作保留',updated_at=? WHERE id=?`)
          .run(report.startedAt,id).changes
        db.prepare(`UPDATE history_dual_production SET production_mode='motion_backfill',updated_at=? WHERE huasheng_job_id=?`)
          .run(report.startedAt,id)
      }
      for(const id of report.sourceIds)report.deletedSources+=db.prepare('UPDATE history_script_sources SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL')
        .run(report.startedAt,report.startedAt,id).changes
      for(const id of report.episodeIds) {
        const episode=db.prepare('SELECT metadata FROM episodes WHERE id=?').get(id) as Row
        const meta=json(episode.metadata)
        if(meta.historyFactory.deletedAt)continue
        meta.historyFactory.deletedAt=report.startedAt
        report.deletedEpisodeProjections+=db.prepare('UPDATE episodes SET metadata=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(meta),report.startedAt,id).changes
      }
      for(const id of report.motionJobIds) {
        db.prepare(`UPDATE history_dual_production SET motion_job_id=NULL,episode_id=NULL,updated_at=?
          WHERE motion_job_id=? AND motion_state='failed'`).run(report.startedAt,id)
        report.deletedMotionTasks+=db.prepare("DELETE FROM history_motion_productions WHERE id=? AND status='failed'").run(id).changes
      }
      if(protectedDigest(db,report.sourceIds,report.motionJobIds)!==protectedBefore)throw Error('Protected production or upload records changed; rolling back')
      report.protectedRowsVerified=true
    }).immediate()
    report.status='completed';report.finishedAt=new Date().toISOString()
  } catch(error) {report.status='failed';throw error}
  finally {
    const errors:unknown[]=[]
    for(const release of releases.reverse())try{release()}catch(error){errors.push(error)}
    const temporary=`${report.reportPath}.tmp`
    writeDurable(temporary,Buffer.from(JSON.stringify(report,null,2)));fs.renameSync(temporary,report.reportPath!)
    if(errors.length)throw new AggregateError(errors,'Could not release source processing locks')
  }
  return report
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('../../',import.meta.url))
  const db=new Database(path.join(root,'data/huobao_drama.db'),{fileMustExist:true,timeout:30_000})
  db.pragma('synchronous = FULL')
  try{console.log(JSON.stringify(pruneUnstartedRecords(db,root,process.argv.includes('--apply')),null,2))}
  finally{db.close()}
}
