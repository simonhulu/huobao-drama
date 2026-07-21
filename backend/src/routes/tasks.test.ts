import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-task-route-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { default: tasksRoute } = await import('./tasks.js')

test('GET /stream reaches the SSE route before the dynamic task id route', async () => {
  const response = await tasksRoute.request('/stream')

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/)

  const reader = response.body?.getReader()
  assert.ok(reader)
  const firstChunk = await reader.read()
  assert.equal(new TextDecoder().decode(firstChunk.value), 'event: connected\ndata: {}\n\n')
  await reader.cancel()
})
