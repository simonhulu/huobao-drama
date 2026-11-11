import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork, type ChildProcess } from 'node:child_process'

export interface SourceReferenceInput {
  directory: string
  files: string[]
  ownerType: 'history-source' | 'science-job' | 'history-motion'
  ownerId: string
}
export interface SourceReferenceOptions {
  database?: Database.Database
  projectRoot?: string
  databasePath?: string
  isolated?: boolean
  timeoutMs?: number
}
export interface SourceMediaReference {
  path: string
  ownerType: string
  ownerId: string
  reason: 'pinned' | 'shared-reference'
}
type Row = Record<string, any>
interface ReferenceScanCache {
  entries: Map<string,{raw:string|Buffer;matches:string[]}>
}
const defaultProjectRoot = fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'')
const referenceWorkers = new Set<ChildProcess>()

function isolatedReferences(input: SourceReferenceInput, projectRoot: string, databasePath: string, budget?: number): Promise<SourceMediaReference[]> {
  if (referenceWorkers.size) return Promise.reject(Error('A source reference scan is still finishing; retain source media'))
  const timeoutMs = Number.isFinite(budget) && budget! > 0 ? Math.min(30_000, Math.max(100, budget!)) : 5000
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./storage-source-reference-worker.mjs', import.meta.url), [],
      { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    referenceWorkers.add(child)
    let settled = false, result: any
    const kill = () => { child.kill('SIGKILL') }
    const finish = (error?: Error, references?: SourceMediaReference[]) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(error)
      else resolve(references!)
    }
    const fail = (error: Error) => {
      kill()
      // Native disk reads can delay process exit even after SIGKILL. Keep the
      // slot occupied, but let narration proceed with all source bytes retained.
      child.unref(); child.channel?.unref()
      finish(error)
    }
    const timer = setTimeout(() => fail(Object.assign(Error(`Source reference scan exceeded its ${timeoutMs} ms read budget`),
      { code: 'SOURCE_REFERENCE_TIMEOUT' })), timeoutMs)
    process.once('exit', kill)
    child.on('message', message => { if (!settled) result = message })
    child.once('error', fail)
    child.once('close', (code, signal) => {
      referenceWorkers.delete(child); process.removeListener('exit', kill)
      if (settled) return
      const files = new Set(input.files.map(filename => path.resolve(filename)))
      const references = result?.references
      if (code !== 0 || signal || result?.ok !== true || !Array.isArray(references)
        || references.some(ref => !ref || !files.has(ref.path) || typeof ref.ownerType !== 'string'
          || typeof ref.ownerId !== 'string' || !['pinned', 'shared-reference'].includes(ref.reason))) {
        finish(Error(result?.error || 'Source reference worker did not complete a valid scan'))
      } else finish(undefined, references)
    })
    try { child.send({ input, projectRoot, databasePath }, error => { if (error) fail(error) }) }
    catch (error) { fail(error as Error) }
  })
}
function json(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw Error('Stored reference JSON is invalid')
  return JSON.parse(value)
}
function localPath(value: unknown, root: string): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value)
    if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) return null
    value = decodeURIComponent(url.pathname)
  }
  if (typeof value !== 'string') return null
  if (/^\/?static\//.test(value)) return path.resolve(root,'data',value.replace(/^\//,''))
  if (/^data\//.test(value)) return path.resolve(root,value)
  return path.isAbsolute(value) ? path.resolve(value) : null
}

function inspectReferences(database: Database.Database, input: SourceReferenceInput, projectRoot: string, cache?: ReferenceScanCache): SourceMediaReference[] {
  const root = path.resolve(projectRoot), files = new Set(input.files.map(filename => path.resolve(filename)))
  if (!files.size) return []
  const references = new Map<string,SourceMediaReference>()
  const definitions = new Map((database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all() as Array<{name:string;sql:string}>)
    .map(row => [row.name,row.sql]))
  const tables = new Set(definitions.keys())
  const schemas = new Map<string,Set<string>>()
  const columns = (table: string) => {
    if (!schemas.has(table)) schemas.set(table,new Set((database.pragma(`table_info(${table})`) as Array<{name:string}>).map(row => row.name)))
    return schemas.get(table)!
  }
  const rows = (table: string, fields: readonly string[], jsonFields: readonly string[] = []): Row[] => {
    if (!tables.has(table)) return []
    const available = fields.filter(field => columns(table).has(field))
    if (!available.length) return []
    // Reading unchanged large snapshots as bytes avoids repeatedly decoding all
    // narration and prompt text. Only exact changed values are parsed again.
    const binary = !!cache && !/WITHOUT\s+ROWID/i.test(definitions.get(table) || '') && !columns(table).has('_rowid_')
    const jsonColumns = available.filter(field => jsonFields.includes(field))
    const select = available.map(field => binary && jsonColumns.includes(field) ? `CAST(${field} AS BLOB) AS ${field}` : field)
    if (binary) select.push('_rowid_ AS __referenceRowId',...jsonColumns.map(field => `typeof(${field}) AS __type_${field}`))
    const result = database.prepare(`SELECT ${select.join(',')} FROM ${table}`).all() as Row[]
    if (binary) for (const row of result) for (const field of jsonColumns) {
      if (!['text','null'].includes(row[`__type_${field}`])) throw Error('Stored reference JSON is invalid')
    }
    return result
  }
  for (const [table,required] of [['storage_artifacts',['id','path','pinned']],['storage_artifact_refs',['artifact_id','owner_type','owner_id']]] as const) {
    if (!tables.has(table)) continue
    if (required.some(column => !columns(table).has(column))) throw Error('Storage ownership schema is incomplete')
  }
  const add = (filename: string, ownerType: string, ownerId: unknown, reason: SourceMediaReference['reason'] = 'shared-reference') => {
    const ref = {path:filename,ownerType,ownerId:String(ownerId),reason}
    references.set(JSON.stringify(ref),ref)
  }
  const collect = (value: unknown, matches: Set<string>): void => {
    if (typeof value === 'string') {
      const filename = localPath(value,root)
      if (filename && files.has(filename)) matches.add(filename)
    } else if (Array.isArray(value)) for (const item of value) collect(item,matches)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item,matches)
  }
  const inspect = (value: unknown, ownerType: string, ownerId: unknown) => {
    const matches = new Set<string>()
    collect(value,matches)
    for (const filename of matches) add(filename,ownerType,ownerId)
  }
  const nextCache = cache && new Map<string,{raw:string|Buffer;matches:string[]}>()
  const inspectJson = (raw: unknown, ownerType: string, ownerId: unknown, key: string, ownMotion = false) => {
    if (raw === null || raw === undefined || raw === '') return
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) throw Error('Stored reference JSON is invalid')
    if (!raw.length) return
    const cacheKey = `${key}:${Number(ownMotion)}`
    const previous = cache?.entries.get(cacheKey)
    const unchanged = previous && (typeof raw === 'string' ? raw === previous.raw
      : Buffer.isBuffer(previous.raw) && raw.equals(previous.raw))
    let matches = unchanged ? previous.matches : undefined
    if (!matches) {
      let value = json(typeof raw === 'string' ? raw : raw.toString('utf8'))
      if (ownMotion && value && typeof value === 'object' && !Array.isArray(value)) {
        // Delivery inventories describe generated copies, not production inputs.
        value = {...value,outputPath:undefined,...(value.plan ? {plan:{...value.plan,delivery:undefined,deliveryAssociation:undefined}} : {})}
      }
      const found = new Set<string>()
      collect(value,found)
      matches = [...found]
    }
    nextCache?.set(cacheKey,{raw:unchanged ? previous.raw : raw,matches})
    for (const filename of matches) add(filename,ownerType,ownerId)
  }
  const jsonKey = (table: string, row: Row, field: string) => !cache ? '' : row.__referenceRowId === undefined
    ? `${table}:${field}:${String(row[field])}` : `${table}:${row.__referenceRowId}:${field}`
  const tasks = rows('creation_tasks',['id','payload_json'],['payload_json']).map(task => ({id:task.id,raw:task.payload_json,
    key:jsonKey('creation_tasks',task,'payload_json'),
    payload:input.ownerType === 'history-source' ? json(Buffer.isBuffer(task.payload_json) ? task.payload_json.toString('utf8') : task.payload_json) : undefined}))
  const ownTask = (task: Row) => {
    if (input.ownerType !== 'history-source') return false
    const payload = task.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
    const ids = [payload.sourceId,payload.source_id].filter(value => value !== undefined)
    return ids.length > 0 && ids.every(value => String(value) === input.ownerId)
  }
  const ownTasks = new Set(tasks.filter(ownTask).map(task => String(task.id)))
  const motionSources = input.ownerType === 'history-motion' ? new Set(
    ['history_motion_productions','history_motion_jobs'].flatMap(table => rows(table,['id','script_id']))
      .filter(row => String(row.id) === input.ownerId && row.script_id != null).map(row => String(row.script_id))) : new Set<string>()
  const allowedOwner = (ownerType: unknown, ownerId: unknown, purpose?: unknown) => {
    if (input.ownerType === 'history-motion') {
      // Own cache bookkeeping is not an input dependency. Even the same task's
      // explicit source/shared references remain protected.
      return (purpose === 'intermediate' || purpose === 'project') && (ownerType === 'history-motion' && String(ownerId) === input.ownerId
        || ownerType === 'history-source' && motionSources.has(String(ownerId)))
    }
    if (String(ownerId) === input.ownerId && (ownerType === input.ownerType
      || input.ownerType === 'science-job' && ownerType === 'science')) return true
    return ownerType === 'creation-task' && ownTasks.has(String(ownerId))
  }
  if (tables.has('storage_artifacts') !== tables.has('storage_artifact_refs')) throw Error('Storage ownership registry is incomplete')
  if (tables.has('storage_artifacts')) {
    if (input.ownerType === 'history-motion' && !columns('storage_artifact_refs').has('purpose')) throw Error('Storage cache ownership schema is incomplete')
    const paths = [...files]
    for (let start = 0; start < paths.length; start += 512) {
      const group = paths.slice(start,start+512)
      const records = database.prepare(`SELECT a.id,a.path,a.pinned,r.owner_type,r.owner_id${input.ownerType === 'history-motion' ? ',r.purpose' : ''} FROM storage_artifacts a
        LEFT JOIN storage_artifact_refs r ON r.artifact_id=a.id WHERE a.path IN (${group.map(() => '?').join(',')})`).all(...group) as Row[]
      for (const row of records) {
        if (row.pinned) add(row.path,'storage-artifact',row.id,'pinned')
        if (row.owner_type !== null && !allowedOwner(row.owner_type,row.owner_id,row.purpose)) add(row.path,String(row.owner_type),row.owner_id)
      }
    }
  }
  for (const task of tasks) if (!ownTasks.has(String(task.id))) inspectJson(task.raw,'creation-task',task.id,task.key)
  for (const source of rows('history_script_sources',['id','media_json','asr_json'],['media_json','asr_json'])) {
    if (input.ownerType === 'history-source' && String(source.id) === input.ownerId) continue
    for (const field of ['media_json','asr_json']) inspectJson(source[field],'history-source',source.id,jsonKey('history_script_sources',source,field))
  }
  const inputs = [
    ['episodes','episode','id',
      ['source_video_url','pre_tts_audio_url','bgm_audio_url','secondary_bgm_audio_url','recap_video_url','intro_video_url'],['metadata','pre_tts_titles_json']],
    ['storyboards','episode','episode_id',
      ['video_url','tts_audio_url','narration_audio_url','bgm_audio_url','sfx_audio_url','ambient_audio_url','composed_video_url','composed_image','first_frame_image','last_frame_image','grid_sheet_image'],['grid_cells']],
    ['remotion_assets','remotion','project_id',['local_path','source_url','thumbnail_path'],['metadata_json','prompt_json']],
    ['remotion_renders','remotion','project_id',[],['props_json']],
    ['remotion_projects','remotion','id',[],['source_snapshot_json','metadata_json']],
    ['remotion_shots','remotion','project_id',[],['visual_plan_json','source_evidence_json']],
    ['remotion_stage_runs','remotion','project_id',[],['input_json','output_json']],
    ['history_motion_productions','history-motion','id',[],['snapshot']],
    ['history_motion_jobs','history-motion','id',[],['plan_json']],
  ] as const
  for (const [table,owner,ownerField,fields,jsonFields] of inputs) for (const row of rows(table,[ownerField,...fields,...jsonFields],jsonFields)) {
    for (const field of fields) inspect(row[field],owner,row[ownerField])
    for (const field of jsonFields) inspectJson(row[field],owner,row[ownerField],jsonKey(table,row,field),
      input.ownerType === 'history-motion' && owner === 'history-motion' && String(row[ownerField]) === input.ownerId)
  }
  // Keep only values present in this scan, not every historical progress snapshot.
  if (cache && nextCache) cache.entries = nextCache
  return [...references.values()]
}

/** Read current workflow tables as well as the last inventory; no migrations or file changes. */
export function inspectSourceMediaReferences(database: Database.Database, input: SourceReferenceInput, projectRoot: string): SourceMediaReference[] {
  return inspectReferences(database,input,projectRoot)
}

/** Cache parsing only for exact unchanged JSON; fresh rows, pins, schemas and owners are always read. */
export function createSourceMediaReferenceInspector(database: Database.Database, input: SourceReferenceInput, projectRoot: string): () => SourceMediaReference[] {
  const fixedInput = {...input,files:[...input.files]}
  const cache: ReferenceScanCache = {entries:new Map()}
  return () => inspectReferences(database,fixedInput,projectRoot,cache)
}

function projectForDirectory(input: SourceReferenceInput) {
  const suffix = input.ownerType === 'history-source' ? path.join('data/storage/history-scripts',input.ownerId)
    : input.ownerType === 'history-motion' ? path.join('data/storage/history-motion',input.ownerId) : path.join('data/science-pop/jobs',input.ownerId)
  const directory = path.resolve(input.directory)
  if (!directory.endsWith(path.sep+suffix)) return null
  return directory.slice(0,-suffix.length-1)
}

/** Noncanonical isolated task directories never fall back to the running application's database. */
export async function checkSourceMediaReferences(input: SourceReferenceInput, options: SourceReferenceOptions = {}): Promise<SourceMediaReference[]> {
  const root = options.projectRoot ? path.resolve(options.projectRoot) : projectForDirectory(input)
  if (!root) {
    if (options.database || options.databasePath) throw Error('An explicit reference database requires its project root')
    return []
  }
  if (options.database) return inspectSourceMediaReferences(options.database,input,root)
  const filename = path.resolve(options.databasePath || (root === defaultProjectRoot && process.env.DB_PATH) || path.join(root,'data/huobao_drama.db'))
  let info
  try { info = await fs.lstat(filename) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || await fs.realpath(filename) !== filename) throw Error('Reference database must be an existing ordinary file')
  if (options.isolated) return isolatedReferences(input, root, filename, options.timeoutMs)
  const database = new Database(filename,{readonly:true,fileMustExist:true})
  try { return inspectSourceMediaReferences(database,input,root) } finally { database.close() }
}
