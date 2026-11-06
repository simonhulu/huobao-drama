import path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface ExportWorkerService {
  start(): void | Promise<void>
  stop(): void | Promise<void>
  close?(): void | Promise<void>
}

export interface ExportWorkerServices {
  exports: ExportWorkerService
  articles: ExportWorkerService
}

export interface ExportWorkerStatus {
  worker: 'huasheng-export'
  status: 'started' | 'stopping' | 'stopped' | 'failed'
  phase?: 'startup' | 'shutdown'
  pid: number
  timestamp: string
}

export async function loadExportWorkerServices(): Promise<ExportWorkerServices> {
  const { getHistoryHuashengExportService } = await import('../../src/services/history-huasheng-export.js')
  const { getHistoryArticleQueueService } = await import('../../src/services/history-script-article-queue.js')
  const exports = getHistoryHuashengExportService()
  try {
    return { exports, articles: getHistoryArticleQueueService() }
  } catch (error) {
    await exports.close()
    throw error
  }
}

export async function runExportWorker(options: {
  signal: AbortSignal
  loadServices?: () => Promise<ExportWorkerServices>
  writeStatus?: (status: ExportWorkerStatus) => void
}): Promise<number> {
  if (options.signal.aborted) return 0
  const writeStatus = options.writeStatus ?? (status => console.log(JSON.stringify(status)))
  const report = (status: ExportWorkerStatus['status'], phase?: ExportWorkerStatus['phase']) => {
    writeStatus({ worker: 'huasheng-export', status, ...(phase ? { phase } : {}), pid: process.pid, timestamp: new Date().toISOString() })
  }
  let services: ExportWorkerServices | undefined
  let exitCode = 0
  // Both queue services unref their timers because the API normally owns process lifetime.
  const keepAlive = setInterval(() => {}, 60_000)
  try {
    services = await (options.loadServices ?? loadExportWorkerServices)()
    if (!options.signal.aborted) {
      await services.articles.start()
      if (!options.signal.aborted) await services.exports.start()
      if (!options.signal.aborted) report('started')
      await new Promise<void>(resolve => {
        if (options.signal.aborted) resolve()
        else options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  } catch {
    exitCode = 1
    report('failed', 'startup')
  } finally {
    if (services) {
      report('stopping')
      const workers = [services.exports, services.articles]
      const stopped = await Promise.allSettled(workers.map(async worker => { await worker.stop() }))
      const closed = await Promise.allSettled(workers.map(async worker => { await worker.close?.() }))
      if ([...stopped, ...closed].some(result => result.status === 'rejected')) {
        exitCode = 1
        report('failed', 'shutdown')
      }
      report('stopped')
    }
    clearInterval(keepAlive)
  }
  return exitCode
}

export async function exportWorkerMain(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: node run-tsx.mjs scripts/huasheng/export-worker.ts [serve]')
    return 0
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== 'serve')) {
    console.error('Usage: node run-tsx.mjs scripts/huasheng/export-worker.ts [serve]')
    return 1
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try { return await runExportWorker({ signal: controller.signal }) }
  finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void exportWorkerMain().then(code => process.exit(code), () => {
    console.error('[huasheng-export-worker] startup_failed')
    process.exit(1)
  })
}
