import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {writeDurable} from './history-prune-records.js'

type Row=Record<string,any>
const archived=(job:Row)=>job.status==='canceled' && job.stage==='record_cleanup'
function plan(db:Database.Database) {
  const unstarted=db.prepare(`SELECT h.* FROM history_huasheng_jobs h
    JOIN history_script_sources s ON s.id=h.source_id
    WHERE h.production_status='not_started' AND s.deleted_at IS NULL ORDER BY h.id`).all() as Row[]
  const jobs=unstarted.filter(job=>!archived(job))
  if(jobs.some(job=>job.owner || job.status==='running'))throw Error('An active Huasheng operation prevents cleanup')
  const emptyExports:Row[]=[]
  for(const job of jobs) {
    const exports=db.prepare('SELECT * FROM history_huasheng_export_jobs WHERE huasheng_job_id=?').all(job.id) as Row[]
    emptyExports.push(...exports.filter(item=>item.status==='queued' && item.stage==='waiting_production'
      && !['owner','host','pid','dispatched','export_progress','downloaded_bytes','total_bytes','video_url',
        'task_id','project_hash','download_url','filename','file_path','design_status','cover_status','article_status'].some(key=>!!item[key])))
  }
  return {jobs,emptyExports,previouslyArchived:unstarted.filter(archived).length}
}
function protectedDigest(db:Database.Database) {
  const hash=createHash('sha256')
  for(const table of ['history_motion_productions','history_video_deliveries','history_video_publication_intents',
    'history_social_upload_jobs','history_social_upload_confirmations','history_script_deliveries']) {
    hash.update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))
  }
  return hash.digest('hex')
}

export function clearUnstartedHuasheng(db:Database.Database,root:string,apply=false) {
  const initial=plan(db)
  const report={status:apply?'prepared':'planned',startedAt:new Date().toISOString(),
    previouslyArchived:initial.previouslyArchived,jobIds:initial.jobs.map(job=>job.id as number),
    sourceIds:initial.jobs.map(job=>job.source_id as number),exportIds:initial.emptyExports.map(job=>job.id as number),
    archivedBranches:0,deletedEmptyExports:0,removedPendingMarkers:0,protectedRowsVerified:false,
    reportPath:null as string|null,finishedAt:null as string|null}
  if(!apply)return report
  root=fs.realpathSync(root)
  fs.mkdirSync(path.join(root,'data/reports'),{recursive:true})
  report.reportPath=path.join(root,'data/reports',`history-clear-unstarted-${report.startedAt.replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.json`)
  try {
    db.transaction(()=>{
      const current=plan(db)
      report.previouslyArchived=current.previouslyArchived
      report.jobIds=current.jobs.map(job=>job.id)
      report.sourceIds=current.jobs.map(job=>job.source_id)
      report.exportIds=current.emptyExports.map(job=>job.id)
      const before=protectedDigest(db)
      // This audit contains only IDs and counts, never restorable job or script copies.
      writeDurable(report.reportPath!,Buffer.from(JSON.stringify(report,null,2)))
      for(const job of current.jobs) {
        report.archivedBranches+=db.prepare(`UPDATE history_huasheng_jobs SET status='canceled',stage='record_cleanup',
          cancel_requested=1,manual_requested=0,message='未开始任务已按要求删除',updated_at=? WHERE id=?`)
          .run(report.startedAt,job.id).changes
        db.prepare(`UPDATE history_dual_production SET production_mode='motion_backfill',
          huasheng_state=CASE WHEN huasheng_state IN ('pending','started') THEN 'failed' ELSE huasheng_state END,
          updated_at=? WHERE huasheng_job_id=?`).run(report.startedAt,job.id)
        const source=db.prepare('SELECT review_json FROM history_script_sources WHERE id=?').get(job.source_id) as Row
        const review=JSON.parse(source.review_json || '{}')
        if(review.huashengQueue?.status==='pending' && review.huashengQueue.scriptSha256===job.script_sha256) {
          delete review.huashengQueue
          report.removedPendingMarkers+=db.prepare('UPDATE history_script_sources SET review_json=? WHERE id=?')
            .run(JSON.stringify(review),job.source_id).changes
        }
      }
      for(const job of current.emptyExports)report.deletedEmptyExports+=db.prepare('DELETE FROM history_huasheng_export_jobs WHERE id=?').run(job.id).changes
      if(protectedDigest(db)!==before)throw Error('Protected production or upload records changed; rolling back')
      if(plan(db).jobs.length)throw Error('Unstarted Huasheng tasks remain; rolling back')
      report.protectedRowsVerified=true
    }).immediate()
    report.status='completed';report.finishedAt=new Date().toISOString()
  } catch(error){report.status='failed';throw error}
  finally {
    const temporary=`${report.reportPath}.tmp`
    writeDurable(temporary,Buffer.from(JSON.stringify(report,null,2)))
    fs.renameSync(temporary,report.reportPath!)
  }
  return report
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('../../',import.meta.url))
  const db=new Database(path.join(root,'data/huobao_drama.db'),{fileMustExist:true,timeout:30_000})
  db.pragma('synchronous = FULL')
  try{console.log(JSON.stringify(clearUnstartedHuasheng(db,root,process.argv.includes('--apply')),null,2))}
  finally{db.close()}
}
