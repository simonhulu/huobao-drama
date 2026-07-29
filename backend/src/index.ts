import './load-env.js'
import { installGlobalJsonRepair } from './utils/json-repair.js'
installGlobalJsonRepair()

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'path'
import { fileURLToPath } from 'url'

import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import images from './routes/images.js'
import videos from './routes/videos.js'
import upload from './routes/upload.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import agentConfigs from './routes/agentConfigs.js'
import agent from './routes/agent.js'
import compose from './routes/compose.js'
import merge from './routes/merge.js'
import grid from './routes/grid.js'
import skills from './routes/skills.js'
import scripts from './routes/scripts.js'
import tasks from './routes/tasks.js'
import taskAudit from './routes/taskAudit.js'
import health from './routes/health.js'
import webhooks from './routes/webhooks.js'
import aiVoices from './routes/aiVoices.js'
import library from './routes/library.js'
import introTemplates from './routes/introTemplates.js'
import remotion from './routes/remotion.js'
import mediaAccounts from './routes/mediaAccounts.js'
import dharma from './routes/dharma.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { startTaskWorkerLoop } from './services/tasks/worker.js'
import { listRegisteredTaskTypes } from './services/tasks/registry.js'
import { registerAgentRunHandler } from './services/tasks/handlers/agent-run.js'
import { registerImageGenerateHandler } from './services/tasks/handlers/image-generate.js'
import { registerVideoGenerateHandler } from './services/tasks/handlers/video-generate.js'
import { registerTTSGenerateHandlers } from './services/tasks/handlers/tts-generate.js'
import { registerTTSPreGenerateHandler } from './services/tasks/handlers/tts-pre-generate.js'
import { registerGridHandlers } from './services/tasks/handlers/grid-generate.js'
import { registerComposeStoryboardHandler } from './services/tasks/handlers/compose-storyboard.js'
import { registerComposeEpisodeHandler } from './services/tasks/handlers/compose-episode.js'
import { registerMergeEpisodeHandler } from './services/tasks/handlers/merge-episode.js'
import { registerMediaEpisodeHandlers } from './services/tasks/handlers/media-episode.js'
import { registerDramaPreProductionHandler } from './services/tasks/handlers/drama-pre-production.js'
import { registerHookDesignHandler } from './services/tasks/handlers/hook-design.js'
import { registerIntroComposeHandler } from './services/tasks/handlers/intro-compose.js'
import { registerRecapComposeHandler } from './services/tasks/handlers/recap-compose.js'
import { registerCoverGenerateHandler } from './services/tasks/handlers/cover-generate.js'
import { registerPublishWeChatChannelsHandler } from './services/tasks/handlers/publish-wechat-channels.js'
import { registerPublishDouyinHandler } from './services/tasks/handlers/publish-douyin.js'
import { registerDharmaEpisodeHandlers } from './services/tasks/handlers/dharma-episode.js'
import { registerDharmaFootageGenerateHandler } from './services/tasks/handlers/dharma-footage-generate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

const app = new Hono()

// Middleware
app.use('*', cors({
  origin: ['http://localhost:3013', 'http://localhost:3000', 'http://localhost:5679'],
  credentials: true,
  allowHeaders: ['Content-Type', 'X-Task-Control-Token'],
}))
app.use('*', requestLogger)
app.use('*', errorHandler)

// Health check
app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// API routes
const api = new Hono()
api.route('/dramas', dramas)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/images', images)
api.route('/videos', videos)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/agent-configs', agentConfigs)
api.route('/agent', agent)
api.route('/compose', compose)
api.route('/merge', merge)
api.route('/grid', grid)
api.route('/skills', skills)
api.route('/scripts', scripts)
api.route('/tasks', tasks)
api.route('/task-audit', taskAudit)
api.route('/health', health)
api.route('/ai-voices', aiVoices)
api.route('/library', library)
api.route('/intro-templates', introTemplates)
api.route('/remotion', remotion)
api.route('/media-accounts', mediaAccounts)
api.route('/dharma', dharma)

app.route('/api/v1', api)

registerAgentRunHandler()
registerImageGenerateHandler()
registerVideoGenerateHandler()
registerTTSGenerateHandlers()
registerTTSPreGenerateHandler()
registerGridHandlers()
registerComposeStoryboardHandler()
registerComposeEpisodeHandler()
registerMergeEpisodeHandler()
registerMediaEpisodeHandlers()
registerDramaPreProductionHandler()
registerHookDesignHandler()
registerIntroComposeHandler()
registerRecapComposeHandler()
registerCoverGenerateHandler()
registerPublishWeChatChannelsHandler()
registerPublishDouyinHandler()
registerDharmaEpisodeHandlers()
registerDharmaFootageGenerateHandler()

const workers: ReturnType<typeof startTaskWorkerLoop>[] = []
if (process.env.TASK_WORKER_DISABLED !== '1') {
  const imageWorkerConcurrency = Math.max(1, Number(process.env.IMAGE_TASK_WORKER_CONCURRENCY || 4))
  const generalWorkerConcurrency = Math.max(1, Number(process.env.GENERAL_TASK_WORKER_CONCURRENCY || process.env.TASK_WORKER_CONCURRENCY || 12))

  // Image generation gets its own pool so TTS/compose/merge tasks cannot starve it.
  // Maintenance is disabled here because the general pool already runs global recovery.
  workers.push(startTaskWorkerLoop({
    workerId: `worker-image-${process.pid}`,
    concurrency: imageWorkerConcurrency,
    types: ['image.generate', 'image.episode'],
    runMaintenance: false,
  }))

  // Long-running render / compose tasks get their own pool with an extended lease.
  const longRunningTypes = new Set([
    'grid.episode_render',
    'dharma.episode_render',
    'compose',
    'merge',
    'recap-compose',
    'intro-compose',
  ])
  const longRunningConcurrency = Math.max(1, Number(process.env.LONG_RUNNING_TASK_WORKER_CONCURRENCY || 2))
  const longRunningLeaseMs = Number(process.env.LONG_RUNNING_TASK_WORKER_LEASE_MS) || 1_800_000
  const allTypes = listRegisteredTaskTypes()
  const longRunning = allTypes.filter(type => longRunningTypes.has(type))
  if (longRunning.length > 0) {
    workers.push(startTaskWorkerLoop({
      workerId: `worker-long-${process.pid}`,
      concurrency: longRunningConcurrency,
      types: longRunning,
      leaseMs: longRunningLeaseMs,
      runMaintenance: false,
    }))
  }

  // Dharma footage generation persists and polls remote image jobs for up to
  // 20 minutes. Keep it on a long lease, but separate it from scarce render
  // slots so pcore's verified four-job lifecycle capacity can be used.
  if (allTypes.includes('dharma.footage_generate')) {
    const dharmaFootageConcurrency = Math.max(1, Number(
      process.env.DHARMA_FOOTAGE_WORKER_CONCURRENCY || process.env.PCORE_IMAGE_CONCURRENCY || 4,
    ))
    workers.push(startTaskWorkerLoop({
      workerId: `worker-dharma-footage-${process.pid}`,
      concurrency: dharmaFootageConcurrency,
      types: ['dharma.footage_generate'],
      leaseMs: longRunningLeaseMs,
      runMaintenance: false,
    }))
  }

  // Everything else shares the general pool.
  const imageTypes = new Set(['image.generate', 'image.episode'])
  const generalTypes = allTypes.filter(type => (
    !imageTypes.has(type)
    && !longRunningTypes.has(type)
    && type !== 'dharma.footage_generate'
  ))
  if (generalTypes.length > 0) {
    workers.push(startTaskWorkerLoop({
      workerId: `worker-general-${process.pid}`,
      concurrency: generalWorkerConcurrency,
      types: generalTypes,
      // Render / mix / compose tasks can run for several minutes; give them a longer lease.
      leaseMs: Number(process.env.GENERAL_TASK_WORKER_LEASE_MS) || 600_000,
    }))
  }
}

async function shutdown(signal: string) {
  console.log(`[shutdown] received ${signal}, waiting for ${workers.length} worker pool(s) to finish...`)
  try {
    const timeoutMs = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS) || 120_000
    await Promise.all(workers.map(worker => worker.stop(timeoutMs)))
  } catch (error) {
    console.error('[shutdown] worker stop error:', error)
  }
  console.log('[shutdown] exiting')
  process.exit(0)
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

// Webhook callbacks (Vidu, etc.) - outside /api/v1
app.route('/webhooks', webhooks)

// Serve static files (storage)
// Hono's built-in MIME table does not include .m4a, so it serves generated TTS
// audio as application/octet-stream and browsers refuse to play it. Patch the
// Content-Type after serveStatic returns for any .m4a request.
app.use('/static/*', async (c, next) => {
  await next()
  if (c.req.path.toLowerCase().endsWith('.m4a')) {
    const ct = c.res.headers.get('Content-Type')
    if (!ct || ct === 'application/octet-stream') {
      c.res.headers.set('Content-Type', 'audio/mp4')
    }
  }
})
app.use('/static/*', serveStatic({ root: path.join(projectRoot, 'data') }))
app.use('/sfx/*', serveStatic({ root: path.join(projectRoot, 'data') }))

// Serve frontend (production build)
const distPath = path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))

const port = Number(process.env.PORT || 5679)
const hostname = process.env.HOST || '127.0.0.1'
console.log(`Huobao Drama TS server on http://${hostname}:${port}`)
serve({ fetch: app.fetch, port, hostname })
