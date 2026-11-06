import '../../src/load-env.js'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db, runImmediateTransaction, schema } from '../../src/db/index.js'
import { getHistorySource, getHistorySourceArtifactState, listHistorySources, requireCurrentHistoryScript, storeHistorySource, type StoreHistorySourceInput } from '../../src/services/history-script-library.js'
import { cleanupHistorySourceMedia, processHistorySource, readHistoryDownloaderConnection, unlockHistorySource, type SourceMedia } from '../../src/services/history-source-pipeline.js'
import historyScripts from '../../src/routes/history-scripts.js'
import { HISTORY_SOURCING_TASK_TYPE, recoverHistorySourceJobs, registerHistorySourceJobHandler } from '../../src/services/history-source-jobs.js'
import { HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, registerHistoryProductionContinuationHandler } from '../../src/services/history-production-continuation.js'
import { startTaskWorkerLoop } from '../../src/services/tasks/worker.js'

const execFileAsync = promisify(execFile)
const usage = `History script sourcing
  node --import tsx scripts/history-sources/run.ts doctor
  node --import tsx scripts/history-sources/run.ts import <candidates.json>
  node --import tsx scripts/history-sources/run.ts process <id> [--through download|asr|correct|recreate]
  node --import tsx scripts/history-sources/run.ts list
  node --import tsx scripts/history-sources/run.ts cleanup-media [id]
  node --import tsx scripts/history-sources/run.ts serve [port] [--api-only]
  node --import tsx scripts/history-sources/run.ts export <id> <output.md>
  node --import tsx scripts/history-sources/run.ts unlock <id>

Import expects one candidate or an array with sourceVideoId (digits string), title,
category, optional metrics, and selection {reason, observedAt, comments:[{text, likes?}]}.
Unlock removes a stale lock only after confirming its local owning process stopped.
Scripts remain drafts requiring historical-source and originality review.`

function sourceId(value: string | undefined) {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error('A positive integer source id is required')
  return Number(value)
}

async function doctor() {
  const tools = await Promise.all(['ffmpeg', 'ffprobe'].map(async binary => {
    try { const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 5000 }); return { binary, available: true, version: stdout.split('\n')[0] } }
    catch { return { binary, available: false } }
  }))
  let downloader: Record<string, unknown>
  try {
    const connection = await readHistoryDownloaderConnection()
    const response = await fetch(`${connection.baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
    const auth = await fetch(`${connection.baseUrl}/api/v1/auth/me`, { headers: { 'X-API-Key': connection.apiKey }, signal: AbortSignal.timeout(5000) })
    downloader = { configured: true, ready: response.ok, authenticated: auth.ok }
  } catch { downloader = { configured: false, ready: false } }
  const configs = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.isActive, true))
    .orderBy(desc(schema.aiServiceConfigs.isDefault), desc(schema.aiServiceConfigs.priority), desc(schema.aiServiceConfigs.id)).all()
  const audio = configs.find(config => config.serviceType === 'audio')
  const text = configs.find(config => config.serviceType === 'text')
  console.log(JSON.stringify({ tools, downloader, minimaxAudioConfigured: audio?.provider?.toLowerCase() === 'minimax' && Boolean(audio.apiKey), textReviewConfigured: Boolean(text?.apiKey) }, null, 2))
}

async function main() {
  const [command, value, ...args] = process.argv.slice(2)
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(usage); return }
  if (command === 'doctor') { await doctor(); return }
  if (command === 'serve') {
    const port = Number(value || 9130)
    const apiOnly = args.length === 1 && args[0] === '--api-only'
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || (args.length && !apiOnly)) throw new Error('Use a local port from 1024 to 65535 and optional --api-only')
    const app = new Hono()
    let recoveryTimer: ReturnType<typeof setInterval> | undefined
    let worker: ReturnType<typeof startTaskWorkerLoop> | undefined
    if (!apiOnly) {
      registerHistorySourceJobHandler()
      registerHistoryProductionContinuationHandler()
      recoverHistorySourceJobs()
      recoveryTimer = setInterval(() => recoverHistorySourceJobs(), 15_000)
      worker = startTaskWorkerLoop({
        workerId: `history-sourcing-${process.pid}`, types: [HISTORY_SOURCING_TASK_TYPE, HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE], concurrency: 1,
        runMaintenance: false, cancelPollMs: 250,
        onError: () => console.error('History sourcing worker error; inspect the persisted task status'),
      })
    }
    app.get('/health', c => c.json({ status: 'ok', workerEnabled: !apiOnly }))
    app.route('/api/v1/history-scripts', historyScripts)
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
      console.log(`History script API: http://127.0.0.1:${port}/api/v1/history-scripts`)
    })
    let shuttingDown = false
    const shutdown = async () => {
      if (shuttingDown) return
      shuttingDown = true
      clearInterval(recoveryTimer)
      server.close()
      await worker?.stop(1000)
    }
    process.once('SIGINT', () => void shutdown())
    process.once('SIGTERM', () => void shutdown())
    return
  }
  if (command === 'import') {
    if (!value) throw new Error('A candidate JSON file is required')
    const parsed = JSON.parse(await readFile(path.resolve(value), 'utf8'))
    const candidates = (Array.isArray(parsed) ? parsed : [parsed]) as StoreHistorySourceInput[]
    const sources = runImmediateTransaction(() => candidates.map(storeHistorySource))
    console.log(JSON.stringify(sources.map(source => ({ id: source.id, title: source.title, category: source.category, status: source.status })), null, 2))
    return
  }
  if (command === 'list') {
    const page = listHistorySources({ limit: 100 })
    console.log(JSON.stringify({ total: page.total, items: page.items.map(source => ({ id: source.id, title: source.title, category: source.category, status: source.status, updatedAt: source.updatedAt })) }, null, 2))
    return
  }
  if (command === 'cleanup-media') {
    const ids = value ? [sourceId(value)] : db.select({ id: schema.historyScriptSources.id }).from(schema.historyScriptSources)
      .where(eq(schema.historyScriptSources.platform, 'douyin')).all().map(row => row.id)
    const summary = { cleaned: 0, skipped: 0, freedBytes: 0, pending: [] as Array<{ id: number; reason: string }> }
    for (const id of ids) {
      const source = getHistorySource(id)
      if (!source || getHistorySourceArtifactState(source).transcript !== 'current') { summary.skipped++; continue }
      const previous = (JSON.parse(source.mediaJson) as SourceMedia).cleanup
      try {
        const updated = await cleanupHistorySourceMedia(id)
        const cleanup = (JSON.parse(updated.mediaJson) as SourceMedia).cleanup
        summary.freedBytes += (cleanup?.releasedBytes || 0) - (previous?.releasedBytes || 0)
          + (cleanup?.downloaderFreedBytes || 0) - (previous?.downloaderFreedBytes || 0)
        if (updated.mediaJson !== source.mediaJson) summary.cleaned++
        else summary.skipped++
        if (cleanup?.error) summary.pending.push({ id, reason: cleanup.error })
      } catch (error) {
        summary.pending.push({ id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  if (command === 'process') {
    if (args.length && (args.length !== 2 || args[0] !== '--through')) throw new Error('Use --through download, asr, correct or recreate')
    const through = args[1] ?? 'recreate'
    if (!['download', 'asr', 'correct', 'recreate'].includes(through)) throw new Error('Unknown processing stage')
    const source = await processHistorySource(sourceId(value), { through: through as 'download' | 'asr' | 'correct' | 'recreate' })
    console.log(JSON.stringify({ id: source.id, status: source.status, title: source.title, hasTranscript: Boolean(source.rawTranscript), hasRewrittenScript: Boolean(source.rewrittenScript) }, null, 2))
    return
  }
  if (command === 'export') {
    const source = getHistorySource(sourceId(value))
    if (!source) throw new Error('History source not found')
    const script = requireCurrentHistoryScript(source)
    if (args.length !== 1) throw new Error('An output Markdown path is required')
    const output = path.resolve(args[0])
    const markdown = ['---', `title: ${JSON.stringify(source.title)}`, `source_url: ${JSON.stringify(source.sourceUrl)}`, 'status: needs_review', '---', '', script, ''].join('\n')
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, markdown, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ id: source.id, output, status: 'needs_review' }))
    return
  }
  if (command === 'unlock') { await unlockHistorySource(sourceId(value)); console.log(JSON.stringify({ id: sourceId(value), unlocked: true })); return }
  throw new Error(`Unknown command: ${command}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
