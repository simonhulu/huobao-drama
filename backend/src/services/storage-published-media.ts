import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { HISTORY_SOCIAL_TARGETS } from './history-social-targets.js'
import { isHistorySubmissionReceipt } from './history-production-state.js'

export interface PublishedMediaCandidate {
  path: string
  sha256: string
  sourceId: number | string
  ownerType: 'history-source'
  ownerId: string
  role: 'final'
  reason: string
  evidence: {
    workflow: 'history'
    videoId: number
    producer: string
    scriptSha256: string
    deliveryPath: string
    receipts: Array<{jobId:number;target:string;articleId:string;publishedUrl:string;confirmedAt:string}>
  }
}

type Row = Record<string, any>
interface CachedInputJson { raw:Buffer; paths:Set<string> }
export function createPublishedMediaInputCache() { return new Map<string,CachedInputJson>() }
/** Only the independent maintenance service opts into this one-time DDL. */
export function ensurePublishedMediaInputIndexes(database:Database.Database) {
  const built:Array<{name:string;elapsedMs:number}>=[]
  for(const table of ['huasheng_material_recommendations','huasheng_material_files']) {
    const name=`${table}_storage_path`
    if(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name))continue
    const columns=new Set((database.pragma(`table_info(${table})`) as Array<{name:string}>).map(row=>row.name))
    if(!columns.has('file_path') || !columns.has('project_id'))continue
    const started=performance.now()
    // instr/percent matching still scans every path, but a covering index avoids
    // reading the much wider recommendation/report records under the write lock.
    database.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(file_path,project_id)`)
    built.push({name,elapsedMs:performance.now()-started})
  }
  return built
}
interface InputSnapshot {
  table:string; definition:string; fields:string[]; jsonFields:string[]; rows:Row[]
  where:string; params:string[]; rowid:boolean; count?:number
  countStatement?:Database.Statement; checks?:Database.Statement[]
}
const sha256Pattern = /^[a-f0-9]{64}$/
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const activeUploadStates = new Set(['queued','running','awaiting_confirmation','uncertain','blocked'])
function object(value: unknown): Row | null {
  if (typeof value !== 'string') return null
  try {
    const result = JSON.parse(value)
    return result && typeof result === 'object' && !Array.isArray(result) ? result : null
  } catch { return null }
}

/** Cache only exact JSON bytes; every check still reads current rows and owners. */
export function createPublishedMediaInputInspector(database:Database.Database,projectRoot:string,publication:PublishedMediaCandidate,cache=createPublishedMediaInputCache()) {
  const filename=publication.path,dataRoot=path.resolve(projectRoot,'data')
  let snapshots:InputSnapshot[]=[]
  let parsedConsumers:string[]=[]
  const localPath=(value:unknown):string|null=>{
    if (typeof value!=='string') return null
    if (/^https?:\/\//i.test(value)) {
      try {const url=new URL(value);if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return null;value=decodeURIComponent(url.pathname)} catch{return null}
    }
    if (typeof value!=='string') return null
    if (/^\/?static\//.test(value)) return path.resolve(dataRoot,value.replace(/^\//,''))
    if (value.startsWith('data/')) return path.resolve(projectRoot,value)
    return path.isAbsolute(value) ? path.resolve(value) : null
  }
  const inspect=(value:unknown):boolean=>typeof value==='string' ? localPath(value)===filename
    : Array.isArray(value) ? value.some(inspect) : !!value && typeof value==='object' && Object.values(value).some(inspect)
  const collectPaths=(value:unknown,paths:Set<string>):void=>{
    if (typeof value==='string') {const filename=localPath(value);if(filename?.startsWith(dataRoot+path.sep))paths.add(filename)}
    else if(Array.isArray(value))for(const item of value)collectPaths(item,paths)
    else if(value && typeof value==='object')for(const item of Object.values(value))collectPaths(item,paths)
  }
  return (allowParsing=true):string[]=>{
    const consumers=new Set<string>(allowParsing ? [] : parsedConsumers)
    const definitions=new Map((database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all() as Array<{name:string;sql:string}>).map(row=>[row.name,row.sql]))
    const registryConsumers=()=>{
      if (!definitions.has('storage_artifacts')) return
      const artifact=database.prepare('SELECT id FROM storage_artifacts WHERE path=?').get(filename) as Row|undefined
      if (artifact) for (const ref of database.prepare("SELECT owner_type,owner_id FROM storage_artifact_refs WHERE artifact_id=? AND purpose IN ('source','shared')").all(artifact.id) as Row[]) consumers.add(`${ref.owner_type}:${ref.owner_id}`)
    }
    if (!allowParsing) {
      // Compare inside SQLite rather than allocating/decoding another hundreds
      // of MB in JS under the lock. Exact values, row identities, counts and
      // schemas are checked; progress columns are absent from these projections.
      for (const snapshot of snapshots) {
        const changed=()=>consumers.add(`${snapshot.table} 输入记录已变化`)
        if (definitions.get(snapshot.table)!==snapshot.definition || !snapshot.rowid) {changed();continue}
        const count=snapshot.countStatement!.get() as {count:number}
        if (count.count!==snapshot.count) {changed();continue}
        for(const check of snapshot.checks!) if(check.get()){changed();break}
      }
      registryConsumers()
      return [...consumers]
    }
    const nextSnapshots:typeof snapshots=[]
    function *rows(table:string,fields:readonly string[],jsonFields:readonly string[]=[],pathFields:readonly string[]=[]):Generator<Row> {
      if (!definitions.has(table)) return
      const columns=new Set((database.pragma(`table_info(${table})`) as Array<{name:string}>).map(row=>row.name))
      const available=[...new Set(fields)].filter(field=>columns.has(field))
      if (!available.length) return
      const select=available.map(field=>jsonFields.includes(field) ? `CAST(${field} AS BLOB) AS ${field}` : field)
      for (const field of jsonFields.filter(field=>columns.has(field))) select.push(`typeof(${field}) AS __type_${field}`)
      const rowid=!/WITHOUT\s+ROWID/i.test(definitions.get(table) || '') && !columns.has('_rowid_')
      if (rowid) select.push('_rowid_ AS __rowid')
      // Plain path-only tables can be huge. Every path resolving to this file
      // contains its basename, or a percent escape that needs URL decoding.
      const direct=!jsonFields.length ? pathFields.filter(field=>columns.has(field)) : []
      const where=direct.length ? ` WHERE ${direct.map(field=>`(instr(${field},?)>0 OR instr(${field},'%')>0)`).join(' OR ')}` : ''
      let index=0
      const params=direct.map(()=>path.basename(filename))
      const data=database.prepare(`SELECT ${select.join(',')} FROM ${table}${where}`).all(...params) as Row[]
      nextSnapshots.push({table,definition:definitions.get(table)!,fields:available,jsonFields:jsonFields.filter(field=>columns.has(field)),rows:data,where,params,rowid})
      for (const value of data) {
        const row=value as Row
        if (!rowid) row.__rowid=index++
        yield row
      }
    }
    const delivery=[...rows('history_video_deliveries',['id','script_id','producer','producer_job_id'])]
      .find(row=>row.id===publication.evidence.videoId && String(row.script_id)===String(publication.sourceId))
    const fields=[
      ['history_script_sources','history-source','id',[],['media_json','asr_json']],
      ['episodes','episode','id',['source_video_url','pre_tts_audio_url','bgm_audio_url','secondary_bgm_audio_url','recap_video_url','intro_video_url','cover_image_4x3_url','cover_image_3x4_url'],['metadata','pre_tts_titles_json']],
      ['storyboards','episode','episode_id',['video_url','tts_audio_url','narration_audio_url','bgm_audio_url','sfx_audio_url','ambient_audio_url','composed_video_url','composed_image','first_frame_image','last_frame_image','grid_sheet_image'],['grid_cells']],
      ['remotion_assets','remotion','project_id',['local_path','source_url','thumbnail_path'],['metadata_json','prompt_json']],
      ['remotion_projects','remotion','id',[],['source_snapshot_json','metadata_json']],
      ['remotion_renders','remotion','project_id',[],['props_json']],
      ['remotion_shots','remotion','project_id',[],['visual_plan_json','source_evidence_json']],
      ['remotion_stage_runs','remotion','project_id',[],['input_json','output_json']],
      ['history_motion_productions','history-motion','id',[],['snapshot']],
      ['history_motion_jobs','history-motion','id',[],['plan_json']],
      ['creation_tasks','creation-task','id',[],['payload_json']],
      ['huasheng_material_files','huasheng-project','project_id',['file_path'],[]],
      ['huasheng_material_recommendations','huasheng-project','project_id',['file_path'],[]],
      ['history_social_upload_jobs','history-upload','id',[],['payload_json']],
    ] as const
    for (const [table,owner,id,paths,jsonFields] of fields) for (const row of rows(table,[id,...paths,...jsonFields,
      ...(table==='history_motion_productions' ? ['script_id'] : []),...(table==='history_social_upload_jobs' ? ['status'] : [])],jsonFields,paths)) {
      if (table==='history_social_upload_jobs' && ['completed','canceled'].includes(row.status)) continue
      const ownerLabel=`${owner}:${row[id]}`
      if (paths.some(field=>inspect(row[field]))) consumers.add(ownerLabel)
      const ownMotion=table==='history_motion_productions' && delivery?.producer==='motion' && row.id===delivery.producer_job_id && row.script_id===delivery.script_id
      for (const field of jsonFields) {
        const raw=row[field]
        if (raw==null) continue
        if (row[`__type_${field}`]!=='text' || !Buffer.isBuffer(raw)) throw Error('Stored reference JSON is invalid')
        if (!raw.length) continue
        const key=`${dataRoot}:${table}:${row.__rowid}:${field}:${Number(ownMotion)}`,previous=cache.get(key)
        let entry=previous && raw.equals(previous.raw) ? previous : undefined
        if (!entry) {
          let value=JSON.parse(raw.toString('utf8'))
          if (ownMotion && value && typeof value==='object' && !Array.isArray(value)) {
            value={...value,outputPath:undefined,...(value.plan ? {plan:{...value.plan,delivery:undefined,deliveryAssociation:undefined}} : {})}
          }
          const paths=new Set<string>();collectPaths(value,paths)
          entry={raw,paths}
        }
        cache.set(key,entry)
        if (entry.paths.has(filename)) consumers.add(ownerLabel)
      }
    }
    // Allocate parameter arrays and compile comparison statements before BEGIN
    // IMMEDIATE; every copy still executes the same exact live SQL comparisons.
    for(const snapshot of nextSnapshots) {
      snapshot.count=snapshot.rows.length
      snapshot.countStatement=database.prepare(`SELECT count(*) AS count FROM ${snapshot.table}${snapshot.where}`).bind(...snapshot.params)
      snapshot.checks=[]
      const names=['__rowid',...snapshot.fields,...snapshot.jsonFields.map(field=>`__type_${field}`)]
      const expressions=snapshot.fields.map(field=>snapshot.jsonFields.includes(field) ? `CAST(current.${field} AS BLOB)` : `current.${field} COLLATE BINARY`)
      expressions.push(...snapshot.jsonFields.map(field=>`typeof(current.${field})`))
      const conditions=expressions.map((expression,index)=>`${expression} IS NOT expected.v${index}`).join(' OR ')
      const batchSize=Math.max(1,Math.min(200,Math.floor(900/names.length)))
      for(let offset=0;offset<snapshot.rows.length;offset+=batchSize) {
        const batch=snapshot.rows.slice(offset,offset+batchSize),values=batch.flatMap(row=>names.map(name=>row[name] ?? null))
        const placeholders=batch.map(()=>`(${names.map(()=>'?').join(',')})`).join(',')
        const sql=`WITH expected(__rowid,${expressions.map((_,index)=>`v${index}`).join(',')}) AS (VALUES ${placeholders})
          SELECT 1 FROM expected LEFT JOIN ${snapshot.table} AS current ON current._rowid_=expected.__rowid
          WHERE current._rowid_ IS NULL OR ${conditions} LIMIT 1`
        // Permanent binding copies large expected BLOBs into SQLite here,
        // outside the write lock; verification executes without rebinding.
        snapshot.checks.push(database.prepare(sql).bind(...values))
      }
      snapshot.rows=[]
    }
    parsedConsumers=[...consumers]
    registryConsumers()
    snapshots=nextSnapshots
    return [...consumers]
  }
}

/** Discovery never deletes. The caller must recheck receipts and hash the bytes before unlinking. */
export function discoverPublishedMedia(database: Database.Database, projectRoot: string, now: number, retentionDays = 0): PublishedMediaCandidate[] {
  if (!Number.isFinite(now) || !Number.isFinite(retentionDays) || retentionDays < 0) return []
  try {
    return discoverHistoryMedia(database, projectRoot, now, retentionDays)
  } catch {
    // Missing/older schemas cannot provide evidence authorizing reclamation.
    return []
  }
}

function discoverHistoryMedia(database: Database.Database, projectRoot: string, now: number, retentionDays: number) {
  const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row => row.name))
  const schemaCache=new Map<string,Set<string>>()
  const rowCache=new Map<string,Row[]>()
  const rows = (table: string, required: string[], optional=false, extra:string[]=[], filter?:{sql:string;values:unknown[]}): Row[] => {
    if (!tableNames.has(table)) {
      if (optional) return []
      throw Error('Publication evidence table is missing')
    }
    let columns=schemaCache.get(table)
    if (!columns) {columns=new Set((database.pragma(`table_info(${table})`) as Array<{name:string}>).map(column=>column.name));schemaCache.set(table,columns)}
    if (required.some(column => !columns.has(column))) {
      if (optional) return []
      throw Error('Publication evidence schema is incomplete')
    }
    const fields=[...new Set([...required,...extra.filter(field=>columns.has(field))])]
    const sql=`SELECT ${fields.join(',')} FROM ${table}${filter ? ` WHERE ${filter.sql}` : ''}`
    const key=JSON.stringify([sql,filter?.values])
    let result=rowCache.get(key)
    if (!result) {result=database.prepare(sql).all(...(filter?.values || [])) as Row[];rowCache.set(key,result)}
    return result
  }
  const sources = rows('history_script_sources', ['id','rewritten_script','deleted_at','status'])
  const videos = rows('history_video_deliveries', ['id','script_id','script_sha256','producer','video_path','video_sha256'],false,['producer_job_id'])
    .sort((a,b) => b.id - a.id)
  const uploads = rows('history_social_upload_jobs', ['id','source_id','video_id','target','publication_mode','status','payload_json','result_json','fingerprint','updated_at'],false,['video_producer'])
    .sort((a,b) => b.id - a.id).map<Row>(row => ({...row,payload:object(row.payload_json),result:object(row.result_json)}))
  const busySources = new Set<number>()
  for (const upload of uploads) if (activeUploadStates.has(upload.status)) busySources.add(upload.source_id)
  const stages = [
    ['history_motion_productions','script_id','status'],
    ['history_huasheng_jobs','source_id','status'],
    ['history_huasheng_export_jobs','source_id','status'],
    ['history_script_article_queue','source_id','status'],
    ['history_video_publication_intents','source_id','status'],
  ] as const
  for (const [table,owner,status] of stages) if (tableNames.has(table)) {
    for (const row of rows(table,[owner,status],false,table==='history_huasheng_jobs' ? ['production_status'] : [])) {
      if (!['completed','submitted','canceled'].includes(row[status])
        || table === 'history_huasheng_jobs' && ['queued','creating'].includes(row.production_status)) busySources.add(row[owner])
    }
  }
  const candidates: PublishedMediaCandidate[] = []
  const seenVersions = new Set<string>()
  for (const video of videos) {
    const key = `${video.script_id}:${video.script_sha256}:${video.producer}`
    if (seenVersions.has(key)) continue
    seenVersions.add(key)
    const source = sources.find(row => row.id === video.script_id)
    if (!source || busySources.has(source.id) || typeof source.rewritten_script !== 'string'
      || !source.rewritten_script.trim() || /^(downloading|extracting|transcribing|correcting|rewriting|storing)$/.test(source.status)
      || createHash('sha256').update(source.rewritten_script).digest('hex') !== video.script_sha256
      || !sha256Pattern.test(video.video_sha256)) continue
    const urlPattern = new RegExp(`^/?static/history-deliveries/${source.id}/[a-f0-9-]+\\.(mp4|mov|m4v|webm)$`, 'i')
    if (typeof video.video_path !== 'string' || !urlPattern.test(video.video_path)) continue
    const filename = path.resolve(projectRoot, 'data', video.video_path.replace(/^\//,''))
    const matching = uploads.filter(job => job.source_id === source.id &&
      (job.video_id === video.id || job.payload?.videoPath === filename))
    const latestByTargetAndAccount = new Map<string, Row>()
    for (const job of matching) {
      const identity = `${job.target}:${job.payload?.accountName || ''}`
      if (!latestByTargetAndAccount.has(identity)) latestByTargetAndAccount.set(identity, job)
    }
    if (HISTORY_SOCIAL_TARGETS.some(target => !matching.some(job => job.target === target))) continue
    const receipts: PublishedMediaCandidate['evidence']['receipts'] = []
    let complete = true
    for (const job of latestByTargetAndAccount.values()) {
      const payload = job.payload, result = job.result
      const confirmedAt = Date.parse(job.updated_at)
      // Other platforms currently persist drafts without a published byte identity.
      // They, CBA drafts, and episode_publish_records success flags stay protected.
      if (job.target !== 'baijiahao-video' || job.status !== 'completed' || job.publication_mode !== 'publish'
        || job.video_id !== video.id || job.video_producer && job.video_producer !== video.producer
        || !sha256Pattern.test(job.fingerprint) || !payload || payload.fingerprint !== job.fingerprint
        || payload.jobId !== String(job.id) || payload.scriptId !== source.id || payload.target !== job.target
        || payload.publicationMode !== 'publish' || payload.videoPath !== filename
        || !isHistorySubmissionReceipt(result) || result.published !== true
        || payload.accountName !== result.accountName || !Number.isFinite(confirmedAt) || confirmedAt > now
        || now - confirmedAt < retentionDays * 86_400_000) {
        complete = false
        break
      }
      receipts.push({jobId:job.id,target:job.target,articleId:result.articleId,publishedUrl:result.publishedUrl,confirmedAt:job.updated_at})
    }
    if (!complete || !receipts.length) continue
    const candidate:PublishedMediaCandidate={path:filename,sha256:video.video_sha256,sourceId:source.id,ownerType:'history-source',ownerId:String(source.id),role:'final',
      reason:'当前成片已取得平台发表回执，且已到本地回收时间',
      evidence:{workflow:'history',videoId:video.id,producer:video.producer,scriptSha256:video.script_sha256,deliveryPath:filename,receipts}}
    candidates.push(candidate)
    if (video.producer==='motion' && video.producer_job_id && tableNames.has('history_motion_productions')) {
      const job=rows('history_motion_productions',['id','script_id','status','snapshot'],false,[],{sql:'id=? AND script_id=?',values:[video.producer_job_id,source.id]}).find(row=>row.status==='completed')
      const directory=path.resolve(projectRoot,'data/storage/history-motion',String(video.producer_job_id))
      const snapshot=job && object(job.snapshot)
      const original=snapshot?.outputPath
      const validOriginal=job && new RegExp(`^${uuid}$`).test(job.id) && snapshot && snapshot.id===job.id && snapshot.scriptId===source.id
        && Number.isSafeInteger(source.id) && source.id!==0 && (source.id>0 || snapshot.factory?.episodeId===-source.id)
        && snapshot.status==='completed' && snapshot.stage==='rendered' && snapshot.plan?.delivery?.qa?.technical==='passed'
        && snapshot.plan.delivery.sha256===video.video_sha256 && typeof original==='string'
        && /^render-\d+\/movie\.mp4$/.test(path.relative(directory,original)) && original===path.resolve(directory,path.relative(directory,original))
        && (snapshot.factory?.sourceId===undefined || snapshot.factory.sourceId===source.id)
      if (validOriginal) {
        candidates.push({...candidate,path:original})
      }
      const factory=snapshot?.factory,projectId=factory?.projectId,episodeId=factory?.episodeId
      if (job && validOriginal && snapshot && typeof snapshot.script==='string' && createHash('sha256').update(snapshot.script).digest('hex')===video.script_sha256
        && factory?.sourceId===source.id && factory.scriptHash===video.script_sha256
        && Number.isSafeInteger(projectId) && projectId>0 && Number.isSafeInteger(episodeId) && episodeId>0) {
        const filename=path.resolve(projectRoot,'data/static/remotion',`history-${job.id}-${video.video_sha256.slice(0,12)}.mp4`)
        const render=rows('remotion_renders',['project_id','render_kind','status','input_hash','output_path','props_json'],true)
          .find(row=>row.project_id===projectId && row.render_kind==='episode' && row.status==='succeeded'
            && row.input_hash===video.video_sha256 && row.output_path===filename && object(row.props_json)?.jobId===job.id)
        const project=rows('remotion_projects',['id','source_type','source_episode_id','metadata_json'],true)
          .find(row=>row.id===projectId && row.source_type==='episode' && row.source_episode_id===episodeId)
        const episode=rows('episodes',['id','metadata'],true).find(row=>row.id===episodeId)
        const projectMeta=object(project?.metadata_json),episodeMeta=object(episode?.metadata)?.historyFactory
        if (render && projectMeta?.factory==='remotion-history-factory' && projectMeta.jobId===job.id && projectMeta.scriptHash===video.script_sha256
          && episodeMeta?.jobId===job.id && episodeMeta.projectId===projectId && episodeMeta.sourceId===source.id && episodeMeta.scriptHash===video.script_sha256) {
          candidates.push({...candidate,path:filename})
        }
      }
    }
    if (video.producer==='huasheng' && video.producer_job_id && tableNames.has('history_huasheng_export_jobs')) {
      const exports=rows('history_huasheng_export_jobs',['id','huasheng_job_id','source_id','script_sha256','status','project_url','project_hash','file_path'],true)
        .filter(row=>String(row.huasheng_job_id)===video.producer_job_id && row.source_id===source.id && row.script_sha256===video.script_sha256)
      const hashes=new Set(videos.filter(row=>row.producer==='huasheng' && row.producer_job_id===video.producer_job_id
        && row.script_id===source.id && row.script_sha256===video.script_sha256 && sha256Pattern.test(row.video_sha256)
        && new RegExp(`^/?static/history-deliveries/${source.id}/${uuid}\\.(mp4|mov|m4v|webm)$`).test(row.video_path)).map(row=>row.video_sha256))
      for (const exported of exports) {
        const project=typeof exported.project_url==='string' && /^https:\/\/(?:www\.)?huasheng\.cn\/video\/([1-9][0-9]*)$/.exec(exported.project_url)
        if (hashes.size!==1 || !hashes.has(video.video_sha256) || exported.status!=='completed'
          || !Number.isSafeInteger(source.id) || source.id<=0
          || !Number.isSafeInteger(exported.id) || exported.id<=0 || !Number.isSafeInteger(exported.huasheng_job_id) || exported.huasheng_job_id<=0
          || !sha256Pattern.test(exported.project_hash) || !project || !Number.isSafeInteger(Number(project[1]))) continue
        const filename=path.resolve(projectRoot,'data/huasheng-exports',project[1]!,`video_${exported.project_hash}.mp4`)
        if (exported.file_path===filename) candidates.push({...candidate,path:filename})
      }
    }
  }
  return [...new Map(candidates.map(candidate=>[candidate.path,candidate])).values()]
}
