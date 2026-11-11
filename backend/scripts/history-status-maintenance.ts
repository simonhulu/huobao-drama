import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ensureHistoryStatusSchema, ensureHistoryStatusReadIndexes, getHistoryStatusCoverage, repairHistoryStatusBatch } from '../src/services/history-status-storage.js'

export function parseHistoryStatusMaintenanceOptions(args: string[]) {
  const { values } = parseArgs({ args, options: {
    db: { type: 'string' }, apply: { type: 'boolean', default: false },
    backup: { type: 'string' }, watch: { type: 'boolean', default: false },
    'batch-size': { type: 'string', default: '8' },
    'interval-ms': { type: 'string', default: '1000' },
    'max-batches': { type: 'string' },
  } })
  if (!values.db) throw new Error('--db must name an existing database')
  const batchSize = Number(values['batch-size']), intervalMs = Number(values['interval-ms'])
  const maxBatches = values['max-batches'] === undefined ? undefined : Number(values['max-batches'])
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500
    || !Number.isSafeInteger(intervalMs) || intervalMs < 50
    || maxBatches !== undefined && (!Number.isSafeInteger(maxBatches) || maxBatches < 1)) {
    throw new Error('Invalid batch size, interval, or batch limit')
  }
  if (!values.apply && (values.watch || values.backup)) throw new Error('--watch and --backup require --apply')
  return { databasePath: path.resolve(values.db), apply: values.apply,
    backupPath: values.backup ? path.resolve(values.backup) : undefined,
    watch: values.watch, batchSize, intervalMs, maxBatches }
}

export async function runHistoryStatusMaintenance(options: ReturnType<typeof parseHistoryStatusMaintenanceOptions>,
  report: (value: unknown) => void = value => console.log(JSON.stringify(value)), signal?: AbortSignal) {
  const database = new Database(options.databasePath, { readonly: !options.apply, fileMustExist: true, timeout: 1000 })
  try {
    if (!options.apply) {
      const coverage = getHistoryStatusCoverage(database)
      report({ type: 'coverage', coverage })
      return coverage
    }
    if (options.backupPath) {
      if (options.backupPath === options.databasePath || fs.existsSync(options.backupPath)) throw new Error('Backup must be a new file')
      fs.mkdirSync(path.dirname(options.backupPath), { recursive: true })
      await database.backup(options.backupPath)
      report({ type: 'backup', path: options.backupPath })
    }
    ensureHistoryStatusSchema(database)
    report({ type: 'indexes', ...ensureHistoryStatusReadIndexes(database) })
    report({ type: 'coverage', coverage: getHistoryStatusCoverage(database) })
    let batches = 0
    do {
      if (signal?.aborted) break
      const start = performance.now()
      const result = repairHistoryStatusBatch(database, { limit: options.batchSize })
      batches++
      if (result.motion || result.sources || batches === 1) {
        report({ type: 'batch', batches, elapsedMs: Math.round(performance.now() - start), ...result })
      }
      const pending = result.remaining.motion + result.remaining.sources
      if (!options.watch && !pending || options.maxBatches !== undefined && batches >= options.maxBatches) break
      if (!options.watch && pending && !result.motion && !result.sources) throw new Error('Pending summaries made no progress; rerun after concurrent writes settle')
      await delay(options.watch ? options.intervalMs : 10, undefined, { signal }).catch(error => {
        if (error.name !== 'AbortError') throw error
      })
    } while (!signal?.aborted)
    const coverage = getHistoryStatusCoverage(database)
    report({ type: 'complete', batches, coverage })
    return coverage
  } finally { database.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  try { await runHistoryStatusMaintenance(parseHistoryStatusMaintenanceOptions(process.argv.slice(2)), undefined, controller.signal) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
