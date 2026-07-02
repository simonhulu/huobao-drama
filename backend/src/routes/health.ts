import { Hono } from 'hono'
import { success } from '../utils/response.js'
import {
  getHealthyWorkerCount,
  getHeartbeatTimeoutMs,
  listWorkerHeartbeats,
  pruneStaleWorkerHeartbeats,
} from '../services/tasks/heartbeat.js'
import { db, schema } from '../db/index.js'
import { count, eq, sql } from 'drizzle-orm'

const app = new Hono()

// GET /health/workers — worker heartbeat status
app.get('/workers', (c) => {
  pruneStaleWorkerHeartbeats()
  const workers = listWorkerHeartbeats()
  return success(c, {
    healthy_count: getHealthyWorkerCount(),
    total_count: workers.length,
    timeout_ms: getHeartbeatTimeoutMs(),
    workers,
  })
})

// GET /metrics/image-generation — aggregated image generation metrics
app.get('/metrics/image-generation', (c) => {
  const total = db.select({ value: count() }).from(schema.imageGenerations).get()
  const pending = db
    .select({ value: count() })
    .from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.status, 'pending'))
    .get()
  const processing = db
    .select({ value: count() })
    .from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.status, 'processing'))
    .get()
  const completed = db
    .select({ value: count() })
    .from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.status, 'completed'))
    .get()
  const failed = db
    .select({ value: count() })
    .from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.status, 'failed'))
    .get()

  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const recentCompleted = db
    .select({ value: count() })
    .from(schema.imageGenerations)
    .where(
      sql`${schema.imageGenerations.status} = 'completed' AND ${schema.imageGenerations.completedAt} >= ${last24h}`,
    )
    .get()

  return success(c, {
    total: total?.value ?? 0,
    pending: pending?.value ?? 0,
    processing: processing?.value ?? 0,
    completed: completed?.value ?? 0,
    failed: failed?.value ?? 0,
    completed_last_24h: recentCompleted?.value ?? 0,
  })
})

export default app
