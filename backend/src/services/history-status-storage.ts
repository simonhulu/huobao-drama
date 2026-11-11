import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { getHistorySourceArtifactState } from './history-script-artifacts.js'

export const HISTORY_STATUS_SCHEMA_VERSION = 1
export const historyStatusReadsEnabled = () => process.env.HISTORY_STATUS_READS === '1'
type Row = Record<string, any>
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const sourceInputs = ['platform','source_video_id','source_url','raw_transcript','corrected_transcript',
  'rewritten_script','media_json','asr_json','review_json','deleted_at']
const columns = (db: Database.Database, table: string) => new Set((db.pragma(`table_info(${table})`) as {name:string}[]).map(row => row.name))

export function ensureHistoryStatusSchema(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS history_motion_status (
      job_id TEXT PRIMARY KEY, script_id INTEGER, status TEXT, stage TEXT, message TEXT, error TEXT, updated_at TEXT,
      script_type TEXT NOT NULL DEFAULT 'missing', script_text_sha256 TEXT,
      factory_hash_type TEXT NOT NULL DEFAULT 'missing', factory_script_hash TEXT,
      video_url TEXT, shot_count INTEGER, ready_shot_count INTEGER NOT NULL DEFAULT 0,
      input_revision INTEGER NOT NULL DEFAULT 1, projected_revision INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS history_motion_status_source ON history_motion_status(script_id,updated_at,job_id);
      CREATE TABLE IF NOT EXISTS history_source_status (
      source_id INTEGER PRIMARY KEY, script_sha256 TEXT, script_text_sha256 TEXT, script_type TEXT NOT NULL DEFAULT 'null',
      transcript_state TEXT NOT NULL DEFAULT 'missing', corrected_state TEXT NOT NULL DEFAULT 'missing',
      rewritten_state TEXT NOT NULL DEFAULT 'missing', has_provenance INTEGER NOT NULL DEFAULT 0, artifact_input_hash TEXT, updated_at TEXT,
      input_revision INTEGER NOT NULL DEFAULT 1, projected_revision INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);`)
    if (!columns(db,'history_source_status').has('artifact_input_hash')) db.exec('ALTER TABLE history_source_status ADD COLUMN artifact_input_hash TEXT')
    for (const [table, summary, key, inputs] of [
      ['history_motion_productions','history_motion_status','job_id',['script_id','status','updated_at','snapshot']],
      ['history_script_sources','history_source_status','source_id',sourceInputs],
    ] as const) {
      const available = columns(db,table)
      if (!available.has('id')) continue
      const changed = ['id',...inputs.filter(column => available.has(column))]
      const invalidate = (id: string, deleted: number) => `INSERT INTO ${summary}(${key},deleted) VALUES(${id},${deleted})
        ON CONFLICT(${key}) DO UPDATE SET input_revision=input_revision+1,deleted=${deleted};`
      const condition=table==='history_motion_productions'?'':`WHEN ${changed.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}`
      // Tombstones retain the revision across delete/reinsert, fencing out older repairs.
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${summary}_insert AFTER INSERT ON ${table} BEGIN
        ${invalidate('NEW.id',0)} END;
        CREATE TRIGGER IF NOT EXISTS ${summary}_delete AFTER DELETE ON ${table} BEGIN
        ${invalidate('OLD.id',1)} END;
        DROP TRIGGER IF EXISTS ${summary}_update;
        CREATE TRIGGER IF NOT EXISTS ${summary}_update_v1 AFTER UPDATE OF ${changed.join(',')} ON ${table}
        ${condition} BEGIN
        ${invalidate('NEW.id',0)}
        UPDATE ${summary} SET input_revision=input_revision+1,deleted=1 WHERE ${key}=OLD.id AND OLD.id IS NOT NEW.id;
        END;`)
    }
  })()
}

/** Explicit maintenance only: index construction may scan wide historical records. */
export function ensureHistoryStatusReadIndexes(db: Database.Database) {
  const indexes=[
    {table:'history_script_sources',name:'history_script_sources_status_cover',fields:['deleted_at','id','title'],descending:['id']},
    {table:'history_script_sources',name:'history_script_sources_list_order',fields:['deleted_at','updated_at','id'],descending:['updated_at','id']},
    {table:'history_motion_productions',name:'history_motion_productions_status_cover',fields:['script_id','updated_at','id','status']},
    {table:'history_huasheng_jobs',name:'history_huasheng_jobs_status_cover',fields:['source_id','id','script_sha256','status',
      'production_status','production_message','message','error','updated_at']},
    {table:'history_script_deliveries',name:'history_script_deliveries_status_cover',fields:['script_id','video_path','updated_at']},
  ]
  const created:string[]=[],existing:string[]=[],skipped:string[]=[]
  for(const index of indexes) {
    const available=columns(db,index.table)
    if(index.fields.some(field=>!available.has(field))) {skipped.push(index.name);continue}
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index.name)) {existing.push(index.name);continue}
    const fields=index.fields.map(field=>index.descending?.includes(field)?`${field} DESC`:field).join(',')
    db.exec(`CREATE INDEX IF NOT EXISTS ${index.name} ON ${index.table}(${fields})`)
    created.push(index.name)
  }
  return {created,existing,skipped}
}

function statusInputTable(db: Database.Database, table: string, alias: string) {
  const index=`${table}_status_cover`
  const covering=db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=? AND tbl_name=?").get(index,table)
  return `${table} ${alias}${covering?` INDEXED BY ${index}`:''}`
}

function trackedRevision(db: Database.Database, table: string, summary: string, key: string, id: string | number) {
  db.prepare(`INSERT INTO ${summary}(${key}) SELECT id FROM ${table} WHERE id=? ON CONFLICT(${key}) DO NOTHING`).run(id)
  return db.prepare(`SELECT input_revision,projected_revision,schema_version FROM ${summary} WHERE ${key}=?`).get(id) as Row | undefined
}
function parseSnapshot(snapshot: string): Row {
  try { const value=JSON.parse(snapshot); return value && typeof value==='object' ? value : {} } catch { return {} }
}
function valueType(value: unknown) {
  return value === undefined ? 'missing' : value === null ? 'null' : typeof value === 'string' ? 'text' : 'other'
}
const displayText = (value: unknown): string | null => value == null ? null : typeof value==='string' ? value : JSON.stringify(value)
function commitProjection(db: Database.Database, summary: string, key: string, id: string | number, revision: number, values: Row) {
  return db.prepare(`UPDATE ${summary} SET ${Object.keys(values).map(column => `${column}=@${column}`).join(',')},
    projected_revision=@revision,schema_version=@version WHERE ${key}=@id AND input_revision=@revision`)
    .run({...values,id,revision,version:HISTORY_STATUS_SCHEMA_VERSION}).changes === 1
}

/** Supplied inputs must come from the enclosing writer transaction or carry their observed revision. */
export function projectHistoryMotionStatus(db: Database.Database, id: string, job?: Row, expectedRevision?: number) {
  const revision=trackedRevision(db,'history_motion_productions','history_motion_status','job_id',id)
  if (!revision || expectedRevision !== undefined && revision.input_revision !== expectedRevision) return false
  if (revision.projected_revision===revision.input_revision && revision.schema_version===HISTORY_STATUS_SCHEMA_VERSION) return true
  const available=columns(db,'history_motion_productions')
  const selected=['id','script_id','status','updated_at',...(!job?['snapshot']:[])].filter(column=>available.has(column))
  const row=db.prepare(`SELECT ${selected.join(',')} FROM history_motion_productions WHERE id=?`).get(id) as Row | undefined
  if (!row) return false
  const value=job || parseSnapshot(row.snapshot)
  const visuals=value.plan?.visuals
  const values={script_id:row.script_id ?? value.scriptId ?? null,status:row.status ?? value.status ?? null,
    stage:displayText(value.stage),message:displayText(value.message),error:displayText(value.error),updated_at:row.updated_at ?? value.updatedAt ?? null,
    script_type:valueType(value.script),script_text_sha256:typeof value.script==='string'?hash(value.script):null,
    factory_hash_type:valueType(value.factory?.scriptHash),factory_script_hash:typeof value.factory?.scriptHash==='string'?value.factory.scriptHash:null,
    video_url:displayText(value.plan?.deliveryAssociation?.videoUrl),
    shot_count:value.requested?.shots===undefined?null:Array.isArray(value.requested.shots)?value.requested.shots.length:0,
    ready_shot_count:visuals && typeof visuals==='object'?Object.keys(visuals).length:0,deleted:0}
  return commitProjection(db,'history_motion_status','job_id',id,revision.input_revision,values)
}

export function projectHistorySourceStatus(db: Database.Database, id: number, source?: Row, expectedRevision?: number) {
  const revision=trackedRevision(db,'history_script_sources','history_source_status','source_id',id)
  if (!revision || expectedRevision !== undefined && revision.input_revision !== expectedRevision) return false
  if (revision.projected_revision===revision.input_revision && revision.schema_version===HISTORY_STATUS_SCHEMA_VERSION) return true
  const row=source || db.prepare('SELECT * FROM history_script_sources WHERE id=?').get(id) as Row | undefined
  if (!row) return false
  const field=(camel:string,snake:string) => Object.hasOwn(row,camel)?row[camel]:row[snake]
  const rewritten=field('rewrittenScript','rewritten_script') || null
  const available=columns(db,'history_script_sources')
  const hasProvenance=available.has('media_json') && available.has('review_json')
  const inputs={platform:row.platform,sourceVideoId:field('sourceVideoId','source_video_id'),
    sourceUrl:field('sourceUrl','source_url'),rawTranscript:field('rawTranscript','raw_transcript'),
    correctedTranscript:field('correctedTranscript','corrected_transcript'),rewrittenScript:rewritten,
    mediaJson:field('mediaJson','media_json'),asrJson:field('asrJson','asr_json'),reviewJson:field('reviewJson','review_json')}
  let reviewInputs: unknown
  try {
    const review=JSON.parse(inputs.reviewJson ?? 'null')
    reviewInputs=[true,review?.factCheckStatus,review?.rawTranscriptSha256,review?.correctedTranscriptSha256,review?.rewriteInputSha256]
  } catch { reviewInputs=[false] }
  const fingerprint=createHash('sha256')
  for (const value of [...Object.entries(inputs).filter(([key])=>key!=='reviewJson').map(([,value])=>value),JSON.stringify(reviewInputs),hasProvenance]) {
    const text=typeof value==='string'?value:JSON.stringify(value) ?? 'undefined'
    fingerprint.update(`${typeof value}:${text.length}:`).update(text)
  }
  const artifactInputHash=fingerprint.digest('hex')
  const previous=db.prepare('SELECT artifact_input_hash,transcript_state,corrected_state,rewritten_state FROM history_source_status WHERE source_id=?').get(id) as Row
  const states=previous.artifact_input_hash===artifactInputHash
    ? {transcript:previous.transcript_state,corrected:previous.corrected_state,rewritten:previous.rewritten_state}
    : getHistorySourceArtifactState(inputs)
  return commitProjection(db,'history_source_status','source_id',id,revision.input_revision,{
    script_sha256:typeof rewritten==='string' && rewritten.trim()?hash(rewritten):null,
    script_text_sha256:typeof rewritten==='string'?hash(rewritten):null,script_type:valueType(rewritten),
    transcript_state:states.transcript,corrected_state:states.corrected,rewritten_state:hasProvenance?states.rewritten:'current',
    has_provenance:Number(hasProvenance),artifact_input_hash:artifactInputHash,
    deleted:Number(!!field('deletedAt','deleted_at')),updated_at:field('updatedAt','updated_at') ?? null,
  })
}

export function getHistoryStatusCoverage(db: Database.Database) {
  const coverage=(table:string,summary:string,key:string) => {
    if (!columns(db,table).has('id')) return {total:0,current:0,pending:0}
    const original=statusInputTable(db,table,'p')
    const total=(db.prepare(`SELECT COUNT(*) AS count FROM ${original}`).get() as {count:number}).count
    const current=columns(db,summary).has(key) ? (db.prepare(`SELECT COUNT(*) AS count FROM ${original} JOIN ${summary} s ON s.${key}=p.id
      WHERE s.input_revision=s.projected_revision AND s.schema_version=?`).get(HISTORY_STATUS_SCHEMA_VERSION) as {count:number}).count : 0
    return {total,current,pending:total-current}
  }
  return db.transaction(() => ({motion:coverage('history_motion_productions','history_motion_status','job_id'),
    sources:coverage('history_script_sources','history_source_status','source_id')}))()
}

/** Durable revision differences are the resume cursor; payload computation holds no write lock. */
export function repairHistoryStatusBatch(db: Database.Database, options: {limit?:number} = {}) {
  const limit=Math.max(1,Math.min(500,Math.trunc(options.limit || 25)))
  const repair=(table:string,summary:string,key:string,project:(db:Database.Database,id:any,value:Row,revision:number)=>boolean,isMotion:boolean) => {
    if (!columns(db,table).has('id')) return 0
    const original=statusInputTable(db,table,'p')
    db.prepare(`INSERT INTO ${summary}(${key}) SELECT p.id FROM ${original} WHERE NOT EXISTS
      (SELECT 1 FROM ${summary} s WHERE s.${key}=p.id) ORDER BY p.id LIMIT ?`).run(limit)
    const rows=db.prepare(`SELECT s.${key} AS id,s.input_revision AS observed_revision FROM ${summary} s JOIN ${original} ON p.id=s.${key}
      WHERE s.input_revision<>s.projected_revision OR s.schema_version<>? ORDER BY s.${key} LIMIT ?`)
      .all(HISTORY_STATUS_SCHEMA_VERSION,limit) as Row[]
    let repaired=0
    const load=db.prepare(`SELECT * FROM ${table} WHERE id=?`)
    for (const row of rows) {
      const input=load.get(row.id) as Row | undefined
      if (input && project(db,row.id,isMotion?parseSnapshot(input.snapshot):input,row.observed_revision)) repaired++
    }
    return repaired
  }
  const motion=repair('history_motion_productions','history_motion_status','job_id',projectHistoryMotionStatus,true)
  const sources=repair('history_script_sources','history_source_status','source_id',projectHistorySourceStatus,false)
  const coverage=getHistoryStatusCoverage(db)
  return {motion,sources,remaining:{motion:coverage.motion.pending,sources:coverage.sources.pending}}
}
