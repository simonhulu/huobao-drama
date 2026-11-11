import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const disabledWorkers = ['TASK_WORKER_DISABLED', 'HISTORY_HUASHENG_WORKER_DISABLED',
  'HISTORY_SOCIAL_UPLOAD_WORKER_DISABLED', 'HISTORY_HUASHENG_EXPORT_WORKER_DISABLED', 'HISTORY_ARTICLE_WORKER_DISABLED']
const commands = ['start', 'tick', 'run', 'stop', 'resume', 'status'] as const
type Command = typeof commands[number]
interface Pointer { version: 1; id: string; requestId: string; taskBaseline: number; sourceBaseline: number; createdAt: string }
interface Baseline { database: string; project: string; maxTaskId: number }
interface MaintenanceRuntime { controller: {tick: (id: string) => Promise<unknown>}; close: () => Promise<void> }

export function parseHistoryContinuousOptions(args: string[]) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
    db: {type: 'string'}, guard: {type: 'string'}, state: {type: 'string'}, settings: {type: 'string'},
    'request-id': {type: 'string'}, 'max-pending-motion': {type: 'string', default: '2'},
    'interval-ms': {type: 'string', default: '15000'},
  }})
  const command = positionals[0] as Command
  if (positionals.length !== 1 || !commands.includes(command) || !values.db || !values.guard) {
    throw Error('Use start|tick|run|stop|resume|status --db <existing-db> --guard <new-only-production.mjs>')
  }
  const maxPendingMotion = Number(values['max-pending-motion']), intervalMs = Number(values['interval-ms'])
  if (!Number.isSafeInteger(maxPendingMotion) || maxPendingMotion < 1 || maxPendingMotion > 8
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 300000) throw Error('Invalid inventory or polling limit')
  if (command === 'start' && (!values['request-id'] || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(values['request-id']))) {
    throw Error('start requires a stable --request-id')
  }
  const databasePath = path.resolve(values.db)
  return {command, databasePath, guardPath: path.resolve(values.guard),
    statePath: path.resolve(values.state || databasePath + '.history-continuous-production.json'),
    settingsPath: values.settings ? path.resolve(values.settings) : undefined,
    requestId: values['request-id'], maxPendingMotion, intervalMs}
}

function assertOrdinaryFile(filename: string) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Expected an ordinary file: ' + filename)
}

function ordinaryFile(filename: string) {
  assertOrdinaryFile(filename)
  return fs.readFileSync(filename, 'utf8')
}

export function readHistoryContinuousPointer(filename: string): Pointer | undefined {
  let value: unknown
  try { value = JSON.parse(ordinaryFile(filename)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const pointer = value as Pointer
  if (!pointer || pointer.version !== 1 || typeof pointer.id !== 'string' || !pointer.id.trim()
    || typeof pointer.requestId !== 'string' || !pointer.requestId.trim()
    || !Number.isSafeInteger(pointer.taskBaseline) || pointer.taskBaseline < 0
    || !Number.isSafeInteger(pointer.sourceBaseline) || pointer.sourceBaseline < 0
    || !Number.isFinite(Date.parse(pointer.createdAt))) throw Error('Invalid historical production pointer')
  return pointer
}

function assertDisabledWorkers() {
  if (disabledWorkers.some(name => process.env[name] !== '1')) throw Error('All existing global worker-disable flags must remain enabled')
}

/** Runs alongside the existing new-only task worker; it never creates another task executor. */
export async function startHistoryContinuousMaintenance(options: {
  baseline: Baseline; statePath?: string; intervalMs?: number; onError?: (error: unknown) => void
  createRuntime?: (options: {signal: AbortSignal; taskBaseline: number}) => MaintenanceRuntime
}) {
  assertDisabledWorkers()
  const pointer = readHistoryContinuousPointer(options.statePath || options.baseline.database + '.history-continuous-production.json')
  if (!pointer) return {stop: async () => {}, enabled: false}
  if (pointer.taskBaseline !== options.baseline.maxTaskId) throw Error('Historical supply baseline differs from the existing worker')
  const controller = new AbortController()
  const createRuntime = options.createRuntime || (await import('../src/services/history-continuous-runtime.js')).createHistoryContinuousRuntime
  const runtime = createRuntime({signal: controller.signal, taskBaseline: pointer.taskBaseline})
  let pending: Promise<unknown> | undefined
  const tick = () => {
    if (pending || controller.signal.aborted) return
    pending = runtime.controller.tick(pointer.id).catch(error => options.onError?.(error))
      .finally(() => { pending = undefined })
  }
  const intervalMs = options.intervalMs ?? 15000
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 300000) {
    await runtime.close(); throw Error('Invalid historical supply polling interval')
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  tick()
  let stopping: Promise<void> | undefined
  return {enabled: true, stop: () => stopping ||= (async () => {
    clearInterval(timer)
    controller.abort()
    // Services own additional abort controllers; close must run before waiting for their work.
    const results = await Promise.allSettled([Promise.resolve().then(() => runtime.close()), pending])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Historical maintenance did not stop cleanly')
  })()}
}

export async function runHistoryContinuousCommand(options: ReturnType<typeof parseHistoryContinuousOptions>, signal?: AbortSignal) {
  assertOrdinaryFile(options.databasePath)
  assertOrdinaryFile(options.guardPath)
  const project = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
  const guard = await import(pathToFileURL(options.guardPath).href)
  const baseline = guard.readBaseline({project, data: path.dirname(options.databasePath)}) as Baseline
  if (baseline.database !== options.databasePath || baseline.project !== project) throw Error('Existing production baseline names another project or database')
  const {default: Database} = await import('better-sqlite3')
  const readonly = new Database(options.databasePath, {readonly: true, fileMustExist: true, timeout: 1000})
  try { guard.assertStartupSafe(readonly, baseline) } finally { readonly.close() }
  guard.disableBackgroundWorkers()
  process.env.DB_PATH = options.databasePath
  await import('../src/load-env.js')
  guard.disableBackgroundWorkers()
  process.env.DB_PATH = options.databasePath
  assertDisabledWorkers()
  const {db} = await import('../src/db/index.js')
  guard.assertOldTasksUnchanged(db.$client, baseline)
  guard.protectOldTasks(db.$client, baseline.maxTaskId)
  const {createHistoryContinuousRuntime} = await import('../src/services/history-continuous-runtime.js')
  const runtime = createHistoryContinuousRuntime({signal, taskBaseline: baseline.maxTaskId})
  try {
    let pointer = readHistoryContinuousPointer(options.statePath)
    if (options.command === 'start') {
      if (pointer && pointer.requestId !== options.requestId) throw Error('An existing historical batch pointer must not be replaced')
      if (!pointer) {
        const {readHistorySourceSettings} = await import('../src/services/history-source-settings.js')
        const settings = readHistorySourceSettings(options.settingsPath)
        const saved = db.$client.prepare('SELECT snapshot FROM history_continuous_production WHERE request_id=?')
          .get(options.requestId!) as {snapshot: string} | undefined
        const sourceBaseline = saved ? (JSON.parse(saved.snapshot) as {sourceBaseline: number}).sourceBaseline
          : (db.$client.prepare('SELECT COALESCE(MAX(id),0) AS id FROM history_script_sources').get() as {id: number}).id
        const run = runtime.controller.start({requestId: options.requestId!,
          settings: {youtubeUrls: settings.youtubeChannels, maxPendingMotion: options.maxPendingMotion},
          sourceBaseline, taskBaseline: baseline.maxTaskId})
        pointer = {version: 1, id: run.id, requestId: options.requestId!, sourceBaseline,
          taskBaseline: baseline.maxTaskId, createdAt: new Date().toISOString()}
        fs.mkdirSync(path.dirname(options.statePath), {recursive: true})
        fs.writeFileSync(options.statePath, JSON.stringify(pointer, null, 2) + '\n', {flag: 'wx', mode: 0o600})
      }
    }
    if (!pointer || pointer.taskBaseline !== baseline.maxTaskId) throw Error('A matching persisted historical batch pointer is required')
    if (options.command === 'stop') runtime.controller.stop(pointer.id)
    else if (options.command === 'resume') runtime.controller.resume(pointer.id)
    else if (options.command === 'tick') await runtime.controller.tick(pointer.id)
    else if (options.command === 'run') {
      while (!signal?.aborted) {
        await runtime.controller.tick(pointer.id)
        await delay(options.intervalMs, undefined, {signal}).catch(error => { if (error.name !== 'AbortError') throw error })
      }
    }
    guard.assertOldTasksUnchanged(db.$client, baseline)
    return runtime.controller.detail(pointer.id)
  } finally {
    await runtime.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  try { console.log(JSON.stringify(await runHistoryContinuousCommand(parseHistoryContinuousOptions(process.argv.slice(2)), controller.signal))) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
