import './load-env.js'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createNbaVideoRoute } from './routes/nba-video.js'
import { NbaVideoService } from './services/nba-video.js'

const service = new NbaVideoService()
const app = new Hono()
app.use('*', cors({ origin: ['http://localhost:3013', 'http://127.0.0.1:3013'] }))
app.get('/api/v1/health', c => c.json({ status: 'ok', service: 'nba-video' }))
app.route('/api/v1/nba-video', createNbaVideoRoute({ service }))
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.NBA_PORT || 5684) }, info => {
  console.log(`NBA workspace API: http://127.0.0.1:${info.port}/api/v1/nba-video`)
})
async function close() { await service.close(); server.close(() => process.exit(0)) }
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
