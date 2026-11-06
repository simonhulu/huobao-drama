// Optional workspace rollout while the main backend is executing other jobs.
import './load-env.js'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createScienceWorkflowRoute } from './routes/science-workflow.js'
import { getScienceWorkflowService } from './services/science-workflow.js'
import { getScienceCollectionService } from './services/science-collection.js'

const app = new Hono()
app.get('/health', c => c.json({ status: 'ok', workspace: 'science-pop' }))
app.route('/api/v1/science-pop/workflow', createScienceWorkflowRoute())
const port = Number(process.env.SCIENCE_PORT || 5683)
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  if (process.env.TASK_WORKER_DISABLED !== '1') {
    getScienceWorkflowService().startAutomaticExports()
    getScienceCollectionService().startAutomaticRecovery()
  }
  console.log(`Science workspace listening on http://127.0.0.1:${port}`)
})
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  server.close()
  await Promise.all([getScienceWorkflowService().stop(), getScienceCollectionService().stop()])
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
