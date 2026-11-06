import type Database from 'better-sqlite3'
import path from 'node:path'
import type { ArtifactRole } from './storage-artifacts.js'

export interface AdditionalArtifact {
  path: string
  role: ArtifactRole
  ownerType: string
  ownerId: string
  state: string
  purpose?: ArtifactRole
}
type Row = Record<string, any>
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const outputs = {
  'compose.storyboard': {field:'composed_video_url',directory:'composed',role:'intermediate'},
  'merge.episode': {field:'merged_url',directory:'merged',role:'final'},
  'intro.compose': {field:'intro_video_url',directory:'intros',role:'intermediate'},
  'recap.compose': {field:'recap_video_url',directory:'recaps',role:'intermediate'},
} as const
function object(value: unknown): Row | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

/** Recover saved producer outputs for review, independently of immutable-copy or cleanup eligibility. */
export function discoverAdditionalArtifacts(database: Database.Database, projectRoot: string): AdditionalArtifact[] {
  const root = path.resolve(projectRoot), artifacts = new Map<string,AdditionalArtifact>()
  const rows = (table: string, required: string[], optional: string[] = [], where = '', params: unknown[] = []): Row[] => {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return []
    const columns = new Set((database.pragma(`table_info(${table})`) as Array<{name:string}>).map(column => column.name))
    if (required.some(column => !columns.has(column))) return []
    const selected = [...required,...optional.filter(column => columns.has(column))]
    return database.prepare(`SELECT ${selected.join(',')} FROM ${table} ${where}`).all(...params) as Row[]
  }
  const add = (filename: string, role: ArtifactRole, ownerType: string, ownerId: number, state: string) => {
    const artifact: AdditionalArtifact = {path:filename,role,ownerType,ownerId:String(ownerId),state}
    artifacts.set(JSON.stringify([filename,ownerType,ownerId]),artifact)
  }
  const managedPath = (value: unknown, directory: string): string | null => {
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || value.split('/').some(part => part === '.' || part === '..')) return null
    let filename: string
    if (/^\/?static\//.test(value)) filename = path.resolve(root,'data',value.replace(/^\//,''))
    else if (value.startsWith('data/')) filename = path.resolve(root,value)
    else if (path.isAbsolute(value) && path.resolve(value) === value) filename = value
    else return null
    const expected = path.join(root,'data',directory)
    return filename.startsWith(expected+path.sep) && /\.(mp4|mov|m4v|webm)$/i.test(filename) ? filename : null
  }
  for (const row of rows('history_huasheng_export_jobs',['id','source_id','status','file_path'])) {
    const filename = managedPath(row.file_path,'huasheng-exports')
    if (!filename || !positiveId(row.id) || !positiveId(row.source_id) || typeof row.status !== 'string') continue
    add(filename,'final','history-source',row.source_id,row.status)
    add(filename,'final','history-huasheng-export',row.id,row.status)
  }
  const types = Object.keys(outputs)
  const tasks = rows('creation_tasks',['id','type','episode_id','status','result_json'],['scope_type','scope_id'],
    `WHERE type IN (${types.map(() => '?').join(',')}) AND result_json IS NOT NULL`,types)
  for (const row of tasks) {
    const result = object(row.result_json), output = outputs[row.type as keyof typeof outputs]
    if (!result || !output || !positiveId(row.id) || !positiveId(row.episode_id) || typeof row.status !== 'string') continue
    if (result.episode_id !== undefined && result.episode_id !== row.episode_id) continue
    if (row.scope_type === 'episode' && row.scope_id !== row.episode_id) continue
    if (row.type === 'compose.storyboard' && (!positiveId(result.storyboard_id)
      || row.scope_type === 'storyboard' && row.scope_id !== result.storyboard_id)) continue
    if (row.type === 'merge.episode' && !positiveId(result.merge_id)) continue
    const filename = managedPath(result[output.field],`static/${output.directory}`)
    if (!filename) continue
    add(filename,output.role,'episode',row.episode_id,row.status)
    add(filename,output.role,'creation-task',row.id,row.status)
  }
  return [...artifacts.values()]
}
