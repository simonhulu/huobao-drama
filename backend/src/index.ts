import './load-env.js'
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
import { requestLogger, errorHandler } from './middleware/logger.js'
import { startTaskWorkerLoop } from './services/tasks/worker.js'
import { registerAgentRunHandler } from './services/tasks/handlers/agent-run.js'
import { registerImageGenerateHandler } from './services/tasks/handlers/image-generate.js'
import { registerVideoGenerateHandler } from './services/tasks/handlers/video-generate.js'
import { registerTTSGenerateHandlers } from './services/tasks/handlers/tts-generate.js'
import { registerGridHandlers } from './services/tasks/handlers/grid-generate.js'
import { registerComposeStoryboardHandler } from './services/tasks/handlers/compose-storyboard.js'
import { registerComposeEpisodeHandler } from './services/tasks/handlers/compose-episode.js'
import { registerMergeEpisodeHandler } from './services/tasks/handlers/merge-episode.js'
import { registerMediaEpisodeHandlers } from './services/tasks/handlers/media-episode.js'
import { registerDramaPreProductionHandler } from './services/tasks/handlers/drama-pre-production.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

const app = new Hono()

// Middleware
app.use('*', cors({
  origin: ['http://localhost:3013', 'http://localhost:3000', 'http://localhost:5679'],
  credentials: true,
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

app.route('/api/v1', api)

registerAgentRunHandler()
registerImageGenerateHandler()
registerVideoGenerateHandler()
registerTTSGenerateHandlers()
registerGridHandlers()
registerComposeStoryboardHandler()
registerComposeEpisodeHandler()
registerMergeEpisodeHandler()
registerMediaEpisodeHandlers()
registerDramaPreProductionHandler()

let worker: ReturnType<typeof startTaskWorkerLoop> | undefined
if (process.env.TASK_WORKER_DISABLED !== '1') {
  const workerConcurrency = Math.max(1, Number(process.env.TASK_WORKER_CONCURRENCY || 8))
  worker = startTaskWorkerLoop({ workerId: `worker-${process.pid}`, concurrency: workerConcurrency })
}

async function shutdown(signal: string) {
  console.log(`[shutdown] received ${signal}, waiting for worker to finish...`)
  try {
    const timeoutMs = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS) || 120_000
    await worker?.stop(timeoutMs)
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
app.use('/static/*', serveStatic({ root: path.join(projectRoot, 'data') }))
app.use('/sfx/*', serveStatic({ root: path.join(projectRoot, 'data', 'sfx') }))

// Serve frontend (production build)
const distPath = path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))

const port = Number(process.env.PORT || 5679)
console.log(`🚀 Huobao Drama TS server on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
