import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'history-control-')), 'test.db')
const { createTask, claimQueuedTask, getTask } = await import('./tasks/store.js')

test('API-only mode exposes monitoring without claiming queued jobs or recovering another worker task', { timeout: 30_000 }, async () => {
  const payload = { targetCount: 1, categories: ['history_trivia'] }
  const queued = createTask({ type: 'history.source', payload })
  const waiting = createTask({ type: 'history.source', payload })
  claimQueuedTask(waiting.id, { workerId: 'original-worker', leaseMs: 60_000, nowMs: Date.parse('2000-01-01T00:00:00.000Z') })
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/history-sources/run.ts', 'serve', String(port), '--api-only'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: process.env, stdio: 'ignore',
  })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try {
    let healthy = false
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
        const body = await response.json()
        assert.equal(body.workerEnabled, false)
        healthy = true
        break
      } catch { await delay(100) }
    }
    assert.ok(healthy, 'API-only service must start without an execution worker')
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/history-scripts/jobs`)
    assert.equal(response.status, 200)
    assert.equal(getTask(queued.id)!.status, 'queued')
    assert.equal(getTask(waiting.id)!.status, 'running')
    assert.equal(getTask(waiting.id)!.leaseOwner, 'original-worker')
  } finally {
    child.kill('SIGTERM')
    await Promise.race([exited, delay(2000).then(() => { child.kill('SIGKILL') })])
    await exited
  }
})
