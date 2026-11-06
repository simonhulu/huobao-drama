import type Database from 'better-sqlite3'
import path from 'node:path'

export interface ImmutableMediaCopy {
  path: string
  sha256: string
  ownerType: string
  ownerId: string
  role: 'final'
}

type Row = Record<string, any>
const sha256Pattern = /^[a-f0-9]{64}$/
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const uuidPattern = new RegExp(`^${uuid}$`)
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
function object(value: unknown): Row | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

/** Writer identity only. Callers must verify ordinary files, bytes, hashes and active consumers before linking. */
export function discoverImmutableCopies(database: Database.Database, projectRoot: string): ImmutableMediaCopy[] {
  const root = path.resolve(projectRoot), candidates = new Map<string, ImmutableMediaCopy>()
  const rows = (table: string, required: string[]): Row[] => {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return []
    const columns = new Set((database.pragma(`table_info(${table})`) as Array<{name: string}>).map(column => column.name))
    return required.every(column => columns.has(column)) ? database.prepare(`SELECT * FROM ${table}`).all() as Row[] : []
  }
  const add = (filename: string, sha256: string, ownerType: string, ownerId: string | number) => {
    if (!sha256Pattern.test(sha256)) return
    const candidate: ImmutableMediaCopy = {path:filename,sha256,ownerType,ownerId:String(ownerId),role:'final'}
    candidates.set(JSON.stringify([filename,sha256,ownerType,candidate.ownerId]),candidate)
  }
  const deliveries = rows('history_video_deliveries', ['script_id','script_sha256','video_path','video_sha256'])
    .filter(row => positiveId(row.script_id) && sha256Pattern.test(row.script_sha256) && sha256Pattern.test(row.video_sha256))
  const deliveryPath = (row: Row) => {
    const prefix = `static/history-deliveries/${row.script_id}/`
    if (typeof row.video_path !== 'string' || !new RegExp(`^/?${prefix}${uuid}\\.(mp4|mov|m4v|webm)$`).test(row.video_path)) return null
    return path.join(root,'data',row.video_path.replace(/^\//,''))
  }
  for (const row of deliveries) {
    const filename = deliveryPath(row)
    if (filename) add(filename,row.video_sha256,'history-source',row.script_id)
  }

  const motions = new Map<string, Row>()
  for (const row of rows('history_motion_productions', ['id','script_id','status','snapshot'])) {
    const job = object(row.snapshot)
    if (typeof row.id !== 'string' || !uuidPattern.test(row.id) || !job || job.id !== row.id
      || !Number.isSafeInteger(row.script_id) || row.script_id === 0 || job.scriptId !== row.script_id
      || row.status !== 'completed' || job.status !== 'completed' || job.stage !== 'rendered'
      || job.plan?.delivery?.qa?.technical !== 'passed' || !sha256Pattern.test(job.plan?.delivery?.sha256)
      || typeof job.outputPath !== 'string') continue
    const directory = path.join(root,'data/storage/history-motion',row.id)
    const relative = path.relative(directory,job.outputPath)
    if (!/^render-[0-9]+\/movie\.mp4$/.test(relative) || job.outputPath !== path.join(directory,relative)) continue
    const factory = object(job.factory)
    if (row.script_id < 0 && (!factory || factory.episodeId !== -row.script_id)) continue
    if (factory?.sourceId !== undefined && factory.sourceId !== row.script_id) continue
    motions.set(row.id,job)
    add(job.outputPath,job.plan.delivery.sha256,'history-motion',row.id)
    if (positiveId(row.script_id)) add(job.outputPath,job.plan.delivery.sha256,'history-source',row.script_id)
    for (const [field,owner] of [['episodeId','episode'],['projectId','remotion']] as const) {
      if (positiveId(factory?.[field])) add(job.outputPath,job.plan.delivery.sha256,owner,factory![field])
    }
  }

  for (const row of rows('remotion_renders', ['project_id','render_kind','status','input_hash','output_path'])) {
    if (!positiveId(row.project_id) || row.render_kind !== 'episode' || row.status !== 'succeeded'
      || !sha256Pattern.test(row.input_hash) || typeof row.output_path !== 'string') continue
    const match = new RegExp(`^history-(${uuid})-([a-f0-9]{12})\\.mp4$`).exec(path.basename(row.output_path))
    if (!match || match[2] !== row.input_hash.slice(0,12)
      || row.output_path !== path.join(root,'data/static/remotion',match[0])) continue
    add(row.output_path,row.input_hash,'remotion',row.project_id)
    add(row.output_path,row.input_hash,'history-motion',match[1]!)
    const job = motions.get(match[1]!)
    if (job?.factory?.projectId === row.project_id && job.plan.delivery.sha256 === row.input_hash) {
      if (positiveId(job.scriptId)) add(row.output_path,row.input_hash,'history-source',job.scriptId)
      if (positiveId(job.factory.episodeId)) add(row.output_path,row.input_hash,'episode',job.factory.episodeId)
    }
  }

  for (const row of rows('history_huasheng_export_jobs', ['id','huasheng_job_id','source_id','script_sha256','status','project_url','project_hash','file_path'])) {
    if (row.status !== 'completed' || !positiveId(row.id) || !positiveId(row.source_id) || !positiveId(row.huasheng_job_id)
      || !sha256Pattern.test(row.script_sha256) || !sha256Pattern.test(row.project_hash) || typeof row.project_url !== 'string') continue
    const project = /^https:\/\/(?:www\.)?huasheng\.cn\/video\/([1-9][0-9]*)$/.exec(row.project_url)
    if (!project || !Number.isSafeInteger(Number(project[1]))) continue
    const filename = path.join(root,'data/huasheng-exports',project[1]!,`video_${row.project_hash}.mp4`)
    if (row.file_path !== filename) continue
    const matching = deliveries.filter(delivery => delivery.producer === 'huasheng'
      && delivery.producer_job_id === String(row.huasheng_job_id) && delivery.script_id === row.source_id
      && delivery.script_sha256 === row.script_sha256 && deliveryPath(delivery))
    // A conflicting producer identity cannot prove which bytes the export contains.
    const hashes = new Set(matching.map(delivery => delivery.video_sha256))
    if (hashes.size !== 1) continue
    const sha256 = matching[0]!.video_sha256
    add(filename,sha256,'history-source',row.source_id)
    add(filename,sha256,'history-huasheng-export',row.id)
  }
  return [...candidates.values()]
}
