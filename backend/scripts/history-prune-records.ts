import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import {hostname} from 'node:os'
import {createHash, randomUUID} from 'node:crypto'
import {gzipSync, gunzipSync} from 'node:zlib'
import {fileURLToPath} from 'node:url'

type Row = Record<string, any>
const terminal = new Set(['succeeded', 'failed', 'canceled', 'stale'])
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export function planHistoryPrune(db: Database.Database) {
  const sources = db.prepare('SELECT * FROM history_script_sources ORDER BY id').all() as Row[]
  const motions = db.prepare('SELECT * FROM history_motion_productions').all() as Row[]
  const deliveries = db.prepare('SELECT * FROM history_video_deliveries WHERE producer=?').all('motion') as Row[]
  const intents = db.prepare('SELECT * FROM history_video_publication_intents WHERE producer=?').all('motion') as Row[]
  const tasks = db.prepare('SELECT * FROM creation_tasks WHERE type IN (?,?) ORDER BY id')
    .all('history.source', 'history.production.continue') as Row[]
  const protectedIds = new Map<number, Set<string>>()
  const protect = (id: number, reason: string) => {
    if (!Number.isSafeInteger(id) || id < 1) return
    const reasons = protectedIds.get(id) || new Set<string>()
    reasons.add(reason)
    protectedIds.set(id, reasons)
  }
  // A rendered video is still needed until its exact delivery has completed publication.
  for (const job of motions) {
    if (job.status !== 'completed') protect(job.script_id, `motion:${job.status}`)
    else {
      const videos = deliveries.filter(video => video.producer_job_id === job.id && video.script_id === job.script_id)
      if (!videos.length || videos.some(video => !intents.some(intent => intent.video_id === video.id
        && intent.source_id === job.script_id && intent.status === 'completed'))) protect(job.script_id, 'motion:publication_unfinished')
    }
  }
  for (const intent of intents) if (intent.status !== 'completed') protect(intent.source_id, `publication:${intent.status}`)
  for (const upload of db.prepare('SELECT source_id,status,upload_dispatched FROM history_social_upload_jobs').all() as Row[]) {
    if (['queued', 'running', 'awaiting_confirmation', 'uncertain'].includes(upload.status)
      || upload.upload_dispatched && !['completed', 'canceled'].includes(upload.status)) {
      protect(upload.source_id, `upload:${upload.status}`)
    }
  }
  for (const row of db.prepare('SELECT source_id,motion_state FROM history_dual_production').all() as Row[]) {
    if (row.motion_state !== 'completed') protect(row.source_id, `dual:${row.motion_state}`)
  }
  for (const task of tasks) {
    if (task.type === 'history.source' && !terminal.has(task.status)) throw Error('An active history collection task prevents cleanup')
    if (task.type === 'history.production.continue' && !terminal.has(task.status)) {
      const id = Number(JSON.parse(task.payload_json || '{}').sourceId || task.scope_id)
      if (!Number.isSafeInteger(id) || id < 1) throw Error('Cannot identify an active production continuation')
      protect(id, 'production:continuation')
    }
  }
  const protectedSources = sources.filter(source => !source.deleted_at && protectedIds.has(source.id))
    .map(source => ({id: source.id as number, title: source.title as string, reasons: [...protectedIds.get(source.id)!]}))
  const candidates = sources.filter(source => !source.deleted_at && !protectedIds.has(source.id))
  const removableTasks = tasks.filter(task => task.type === 'history.source' || terminal.has(task.status)
    && !protectedIds.has(Number(JSON.parse(task.payload_json || '{}').sourceId || task.scope_id)))
  const taskIds = removableTasks.map(task => task.id as number)
  const removed = new Set(taskIds)
  const dependencies = db.prepare('SELECT * FROM creation_task_dependencies').all() as Row[]
  if (dependencies.some(row => removed.has(row.task_id) !== removed.has(row.depends_on_task_id))) {
    throw Error('Collection history is referenced by another workflow')
  }
  const parents = db.prepare('SELECT id,parent_task_id FROM creation_tasks WHERE parent_task_id IS NOT NULL').all() as Row[]
  if (parents.some(row => !removed.has(row.id) && removed.has(row.parent_task_id))) throw Error('Collection history is referenced by a child task')
  return {
    sourceIds: candidates.map(source => source.id as number), taskIds, protectedSources,
    alreadyDeletedProtectedIds: sources.filter(source => source.deleted_at && protectedIds.has(source.id)).map(source => source.id as number),
    visibleBefore: sources.filter(source => !source.deleted_at).length,
  }
}

export function writeDurable(filename: string, bytes: Buffer) {
  const fd = fs.openSync(filename, 'wx', 0o600)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  const directory = fs.openSync(path.dirname(filename), 'r')
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

export function lockSource(root: string, id: number, reclaimed: Row[]): () => void {
  const directory = path.join(root, 'data/storage/history-scripts', String(id))
  fs.mkdirSync(directory, {recursive: true})
  if (fs.realpathSync(directory) !== directory) throw Error(`Redirected source directory: ${id}`)
  const filename = path.join(directory, 'process.lock'), token = randomUUID()
  let fd: number
  try { fd = fs.openSync(filename, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const info = fs.lstatSync(filename, {bigint: true})
    if (!info.isFile() || info.isSymbolicLink()) throw Error(`Invalid source lock: ${id}`)
    const contents = fs.readFileSync(filename, 'utf8'), owner = JSON.parse(contents)
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error(`Unknown source lock: ${id}`)
    let absent = false
    try { process.kill(owner.pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      absent = true
    }
    if (!absent) throw Error(`An active source process prevents cleanup: ${id}`)
    const current = fs.lstatSync(filename, {bigint: true})
    if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size
      || current.mtimeNs !== info.mtimeNs || current.ctimeNs !== info.ctimeNs
      || fs.readFileSync(filename, 'utf8') !== contents) throw Error(`Source lock changed: ${id}`)
    fs.unlinkSync(filename)
    reclaimed.push({sourceId: id, path: filename, previousContents: contents, currentHostname: hostname(), deadLocalPid: owner.pid})
    // A competing producer may acquire the path first; wx then aborts the transaction.
    fd = fs.openSync(filename, 'wx', 0o600)
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), token}))
    fs.fsyncSync(fd)
  } catch (error) { fs.unlinkSync(filename); throw error } finally { fs.closeSync(fd) }
  return () => {
    if (JSON.parse(fs.readFileSync(filename, 'utf8')).token !== token) throw Error(`Source lock ownership changed: ${id}`)
    fs.unlinkSync(filename)
  }
}

function selected(db: Database.Database, table: string, column: string, ids: number[]): Row[] {
  return ids.length ? db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as Row[] : []
}

export function pruneHistoryRecords(db: Database.Database, projectRoot: string, apply = false) {
  const preview = planHistoryPrune(db)
  const report = {
    status: apply ? 'prepared' : 'planned', startedAt: new Date().toISOString(), ...preview,
    deletedSources: 0, deletedTasks: 0, deletedEvents: 0,
    backupPath: null as string | null, backupSha256: null as string | null, reportPath: null as string | null,
    protectedRowsVerified: false, finishedAt: null as string | null,
    reclaimedLocks: [] as Row[],
  }
  if (!apply) return report
  projectRoot = fs.realpathSync(projectRoot)
  const reportDirectory = path.join(projectRoot, 'data/reports')
  fs.mkdirSync(reportDirectory, {recursive: true})
  const prefix = path.join(reportDirectory, `history-record-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  report.reportPath = `${prefix}.json`
  const releases: Array<() => void> = []
  try {
    db.transaction(() => {
      const plan = planHistoryPrune(db)
      Object.assign(report, plan)
      for (const id of plan.sourceIds) releases.push(lockSource(projectRoot, id, report.reclaimedLocks))
      const kept = selected(db, 'history_script_sources', 'id', plan.protectedSources.map(source => source.id))
      const backup = {
        version: 1, createdAt: report.startedAt, reason: 'User requested history task and record cleanup, preserving refined production',
        sources: selected(db, 'history_script_sources', 'id', plan.sourceIds),
        tasks: selected(db, 'creation_tasks', 'id', plan.taskIds),
        events: selected(db, 'creation_task_events', 'task_id', plan.taskIds),
        dependencies: (db.prepare('SELECT * FROM creation_task_dependencies').all() as Row[])
          .filter(row => plan.taskIds.includes(row.task_id) || plan.taskIds.includes(row.depends_on_task_id)),
        plan,
        reclaimedLocks: report.reclaimedLocks,
      }
      const plain = Buffer.from(JSON.stringify(backup))
      const compressed = gzipSync(plain)
      report.backupPath = `${prefix}.before.json.gz`
      writeDurable(report.backupPath, compressed)
      const readback = fs.readFileSync(report.backupPath)
      if (sha256(gunzipSync(readback)) !== sha256(plain)) throw Error('History cleanup backup verification failed')
      report.backupSha256 = sha256(readback)
      writeDurable(report.reportPath!, Buffer.from(JSON.stringify(report, null, 2)))
      const removeSource = db.prepare('UPDATE history_script_sources SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL')
      for (const id of plan.sourceIds) report.deletedSources += removeSource.run(report.startedAt, report.startedAt, id).changes
      for (const id of plan.taskIds) {
        report.deletedEvents += db.prepare('DELETE FROM creation_task_events WHERE task_id=?').run(id).changes
        db.prepare('DELETE FROM creation_task_dependencies WHERE task_id=? OR depends_on_task_id=?').run(id, id)
        report.deletedTasks += db.prepare('DELETE FROM creation_tasks WHERE id=?').run(id).changes
      }
      if (JSON.stringify(selected(db, 'history_script_sources', 'id', plan.protectedSources.map(source => source.id))) !== JSON.stringify(kept)) {
        throw Error('Protected source records changed; rolling back cleanup')
      }
      report.protectedRowsVerified = true
    }).immediate()
    report.status = 'completed'
    report.finishedAt = new Date().toISOString()
    const temporary = `${report.reportPath}.tmp`
    writeDurable(temporary, Buffer.from(JSON.stringify(report, null, 2)))
    fs.renameSync(temporary, report.reportPath!)
    return report
  } finally {
    const errors: unknown[] = []
    for (const release of releases.reverse()) {
      try { release() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Source processing locks could not all be released')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const db = new Database(path.join(root, 'data/huobao_drama.db'), {fileMustExist: true, timeout: 30_000})
  db.pragma('synchronous = FULL')
  try {
    const report = pruneHistoryRecords(db, root, process.argv.includes('--apply'))
    console.log(JSON.stringify({...report, sourceIds: {count: report.sourceIds.length}, taskIds: {count: report.taskIds.length}}, null, 2))
  } finally { db.close() }
}
