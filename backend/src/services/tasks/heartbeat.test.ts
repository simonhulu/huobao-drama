import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-worker-heartbeat-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const {
  recordWorkerHeartbeat,
  removeWorkerHeartbeat,
  listWorkerHeartbeats,
  getHealthyWorkerCount,
  pruneStaleWorkerHeartbeats,
  getHeartbeatTimeoutMs,
} = await import('./heartbeat.js')

test('recordWorkerHeartbeat inserts or updates a heartbeat row', () => {
  const worker = recordWorkerHeartbeat('worker-test-1')
  assert.equal(worker.workerId, 'worker-test-1')
  assert.equal(worker.pid, process.pid)
  assert.ok(worker.startedAt)
  assert.ok(worker.lastSeenAt)

  const heartbeats = listWorkerHeartbeats()
  assert.equal(heartbeats.length, 1)
  assert.equal(heartbeats[0].worker_id, 'worker-test-1')
  assert.equal(heartbeats[0].healthy, true)
})

test('recordWorkerHeartbeat updates an existing worker row', () => {
  const first = recordWorkerHeartbeat('worker-test-2')
  const second = recordWorkerHeartbeat('worker-test-2')
  assert.equal(second.workerId, first.workerId)
  assert.ok(second.lastSeenAt >= first.lastSeenAt)

  const heartbeats = listWorkerHeartbeats()
  assert.equal(heartbeats.filter(h => h.worker_id === 'worker-test-2').length, 1)
})

test('getHealthyWorkerCount reflects heartbeat timeout', async () => {
  recordWorkerHeartbeat('worker-count-test')
  const before = getHealthyWorkerCount()

  const timeoutMs = getHeartbeatTimeoutMs()
  const staleLastSeen = new Date(Date.now() - timeoutMs - 1).toISOString()

  const { db, schema } = await import('../../db/index.js')
  db.update(schema.workerHeartbeats)
    .set({ lastSeenAt: staleLastSeen })
    .where(eq(schema.workerHeartbeats.workerId, 'worker-count-test'))
    .run()

  const after = getHealthyWorkerCount()
  assert.ok(after < before, `expected healthy count to drop after stale mark: before=${before}, after=${after}`)
})

test('listWorkerHeartbeats marks stale workers unhealthy', async () => {
  const worker = recordWorkerHeartbeat('worker-stale')
  const timeoutMs = getHeartbeatTimeoutMs()
  const staleLastSeen = new Date(Date.now() - timeoutMs - 1).toISOString()

  const { db, schema } = await import('../../db/index.js')
  db.update(schema.workerHeartbeats)
    .set({ lastSeenAt: staleLastSeen })
    .where(eq(schema.workerHeartbeats.workerId, 'worker-stale'))
    .run()

  const heartbeats = listWorkerHeartbeats()
  const stale = heartbeats.find(h => h.worker_id === 'worker-stale')
  assert.ok(stale)
  assert.equal(stale.healthy, false)
})

test('pruneStaleWorkerHeartbeats removes very old heartbeats', async () => {
  recordWorkerHeartbeat('worker-old')
  const timeoutMs = getHeartbeatTimeoutMs()
  const oldLastSeen = new Date(Date.now() - timeoutMs * 3).toISOString()

  const { db, schema } = await import('../../db/index.js')
  db.update(schema.workerHeartbeats)
    .set({ lastSeenAt: oldLastSeen })
    .where(eq(schema.workerHeartbeats.workerId, 'worker-old'))
    .run()

  const removed = pruneStaleWorkerHeartbeats()
  assert.ok(removed >= 1)

  const heartbeats = listWorkerHeartbeats()
  assert.equal(heartbeats.some(h => h.worker_id === 'worker-old'), false)
})

test('removeWorkerHeartbeat deletes a worker row', () => {
  recordWorkerHeartbeat('worker-to-remove')
  removeWorkerHeartbeat('worker-to-remove')
  const heartbeats = listWorkerHeartbeats()
  assert.equal(heartbeats.some(h => h.worker_id === 'worker-to-remove'), false)
})
