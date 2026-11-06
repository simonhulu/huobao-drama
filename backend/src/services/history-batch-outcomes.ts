import type Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getHistorySourceArtifactState } from './history-script-artifacts.js'
import { getHistoryProductionStates, isHistorySubmissionReceipt } from './history-production-state.js'

type Row = Record<string, any>
interface Options { offset?: number; limit?: number; root?: string; now?: number }
const object = (raw: unknown): Row => {
  try { const value=JSON.parse(String(raw));return value && typeof value==='object' && !Array.isArray(value) ? value : {} }
  catch { return {} }
}

/** Historical collection evidence and current outcomes are deliberately separate. */
export function getHistoryBatchOutcomes(database: Database.Database, taskId: number, options: Options = {}) {
  const offset=options.offset ?? 0, limit=options.limit ?? 50
  if (!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>100) throw Error('Invalid batch outcome pagination')
  if (!Number.isSafeInteger(taskId) || taskId<1) return null
  const task=database.prepare('SELECT type FROM creation_tasks WHERE id=?').get(taskId) as Row|undefined
  if (task?.type!=='history.source') return null
  const tables=new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Row[]).map(row=>row.name))
  const links=database.prepare(`WITH progress AS (
    SELECT id,created_at,json_extract(data_json,'$.currentSourceId') AS source_id,
      json_extract(data_json,'$.currentTitle') AS title,json_extract(data_json,'$.stage') AS stage,
      json_extract(data_json,'$.message') AS message,
      COALESCE(json_extract(data_json,'$.counts.completed'),0) AS completed,
      LAG(COALESCE(json_extract(data_json,'$.counts.completed'),0),1,0) OVER (ORDER BY id) AS previous_completed
    FROM creation_task_events WHERE task_id=? AND event_type='history.progress' AND json_valid(data_json)
  ), linked AS (
    SELECT source_id,MIN(id) AS first_event,
      MAX(CASE WHEN stage='source_failed' THEN id END) AS failure_event,
      MAX(CASE WHEN stage='storing' AND completed>previous_completed THEN 1 ELSE 0 END) AS collected
    FROM progress WHERE typeof(source_id)='integer' AND source_id>0 GROUP BY source_id
  ) SELECT linked.*,failed.message AS failure_message,failed.created_at AS failed_at,first.title AS original_title
    FROM linked LEFT JOIN progress failed ON failed.id=linked.failure_event
    LEFT JOIN progress first ON first.id=linked.first_event ORDER BY linked.first_event`).all(taskId) as Row[]
  const page=links.slice(offset,offset+limit)
  const sourceRows=page.length ? database.prepare(`SELECT * FROM history_script_sources WHERE id IN (${page.map(()=>'?').join(',')})`)
    .all(...page.map(link=>link.source_id)) as Row[] : []
  const sources=sourceRows.map(row=>({id:row.id,title:row.title,rewrittenScript:row.rewritten_script,deletedAt:row.deleted_at,
    platform:row.platform,sourceVideoId:row.source_video_id,sourceUrl:row.source_url,rawTranscript:row.raw_transcript,
    correctedTranscript:row.corrected_transcript,mediaJson:row.media_json,asrJson:row.asr_json,reviewJson:row.review_json}))
  const states=getHistoryProductionStates(database,sources.filter(source=>!source.deletedAt)
    .map(source=>({...source,artifactState:getHistorySourceArtifactState(source).rewritten})),{root:options.root})
  const root=path.resolve(options.root || process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static',import.meta.url)))
  const items=page.map(link=>{
    const row=sourceRows.find(source=>source.id===link.source_id), source=sources.find(source=>source.id===link.source_id)
    const deleted=!row || !!row.deleted_at
    const artifact=source && !deleted ? getHistorySourceArtifactState(source) : null
    const production=states.find(state=>state.scriptId===link.source_id)
    const versions=(production?.versions || []).map(version=>{
      const video=version.videoId && tables.has('history_video_deliveries')
        ? database.prepare('SELECT * FROM history_video_deliveries WHERE id=? AND script_id=?').get(version.videoId,link.source_id) as Row|undefined : undefined
      const upload=version.jobId && tables.has('history_social_upload_jobs')
        ? database.prepare('SELECT source_id,video_id,result_json FROM history_social_upload_jobs WHERE id=?').get(version.jobId) as Row|undefined : undefined
      const receipt=object(upload?.result_json)
      const publicationUrl=upload && upload.source_id===link.source_id && upload.video_id===version.videoId
        && isHistorySubmissionReceipt(receipt) ? receipt.publishedUrl as string : null
      let released=false
      if (video && !version.videoAvailable && tables.has('storage_artifacts')
        && new RegExp(`^/?static/history-deliveries/${link.source_id}/[^/\\\\]+$`).test(video.video_path)) {
        const filename=path.resolve(root,video.video_path.replace(/^\/?static\//,''))
        const stored=database.prepare('SELECT state,sha256,review_json FROM storage_artifacts WHERE path=?').get(filename) as Row|undefined
        const review=object(stored?.review_json), evidence=review.evidence
        released=stored?.state==='released' && stored.sha256===video.video_sha256 && review.status==='released'
          && evidence?.videoId===video.id && evidence?.scriptSha256===production?.scriptSha256 && evidence?.producer===video.producer
      }
      return {...version,publicationUrl,localMedia:version.videoAvailable ? 'available' : released ? 'released' : 'missing'}
    })
    const health=tables.has('history_workflow_activity') && production?.scriptSha256
      ? (database.prepare('SELECT * FROM history_workflow_activity WHERE source_id=? AND script_sha256=?').all(link.source_id,production.scriptSha256) as Row[])
        .filter(activity=>!['completed','published','submitted','canceled','stopped'].includes(activity.state))
        .map(activity=>({producer:activity.producer,stage:activity.stage,message:activity.message,lastProgressAt:activity.progress_at,
          waitingMinutes:Math.max(0,Math.floor(((options.now ?? Date.now())-Date.parse(activity.progress_at))/60000)),
          stalled:(options.now ?? Date.now())-Date.parse(activity.progress_at)>activity.stall_after_ms})) : []
    const media=object(row?.media_json)
    return {sourceId:link.source_id as number,title:row?.title || link.original_title || `稿件 #${link.source_id}`,deleted,
      collectedInBatch:link.collected===1,hadCollectionFailure:link.failure_event!==null,
      historicalFailure:link.failure_event ? {message:link.failure_message,at:link.failed_at} : null,
      recovered:!deleted && link.failure_event!==null && artifact?.rewritten==='current',
      reviewStatus:row?.status || null,draftState:artifact?.rewritten || 'missing',lastError:row?.last_error || null,
      productionMode:production?.productionMode || null,productionComplete:production?.productionComplete || false,
      publicationComplete:!!versions.length && versions.every(version=>version.state==='published'),
      sourceMediaReleased:typeof media.cleanup?.localReleasedAt==='string',versions,health}
  })
  const recovery=tables.has('history_source_recovery')
    ? database.prepare('SELECT attempts,state,next_attempt_at FROM history_source_recovery WHERE task_id=?').get(taskId) as Row|undefined : undefined
  return {taskId,total:links.length,offset,limit,hasMore:offset+items.length<links.length,items,
    recovery:recovery ? {attempts:recovery.attempts,maxAttempts:3,state:recovery.state,
      nextAttemptAt:recovery.next_attempt_at ? new Date(recovery.next_attempt_at).toISOString() : null} : null,
    summary:{scope:'page' as const,draftsReady:items.filter(item=>item.draftState==='current').length,
      historicalFailures:items.filter(item=>item.hadCollectionFailure).length,recoveredSources:items.filter(item=>item.recovered).length,
      expectedVideos:items.reduce((sum,item)=>sum+item.versions.length,0),
      producedVideos:items.reduce((sum,item)=>sum+item.versions.filter(version=>version.videoAvailable || ['submitted','published'].includes(version.state)).length,0),
      submittedVideos:items.reduce((sum,item)=>sum+item.versions.filter(version=>['submitted','published'].includes(version.state)).length,0),
      publishedVideos:items.reduce((sum,item)=>sum+item.versions.filter(version=>version.state==='published').length,0),
      releasedVideos:items.reduce((sum,item)=>sum+item.versions.filter(version=>version.localMedia==='released').length,0),
      stalledSources:items.filter(item=>item.health.some(activity=>activity.stalled)).length}}
}
