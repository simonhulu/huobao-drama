import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-continue-api-'))
process.env.DB_PATH = path.join(root, 'test.db')
process.env.STORAGE_PATH = root
process.env.TASK_WORKER_DISABLED = '1'
const { db, schema } = await import('../db/index.js')
const { storeHistorySource, deleteHistorySource } = await import('../services/history-script-library.js')
const { historyProductionSourceRevision } = await import('../services/history-production-continuation.js')
const { createHistoryProductionContinuationRoute } = await import('./history-production-continuation.js')
const route = createHistoryProductionContinuationRoute()
let serial = 0
beforeEach(() => { db.delete(schema.creationTasks).run(); db.delete(schema.historyScriptSources).run() })
after(() => { db.$client.close(); fs.rmSync(root, { recursive: true, force: true }) })
function seed() {
  return storeHistorySource({ sourceVideoId: String(++serial), title: '秦朝为何灭亡', category: 'historical_commentary',
    selection: { reason: 'test', observedAt: new Date().toISOString(), comments: [] } })
}
function command(url: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return route.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

test('local continue admission returns a durable task, coalesces repeated clicks and exposes only the selected source', async () => {
  const source = seed(), other = seed()
  const first = await command(`/${source.id}/continue`, { expectedRevision: historyProductionSourceRevision(source) }, { Origin: 'http://localhost:3013' })
  assert.equal(first.status, 202)
  assert.equal(first.headers.get('Cache-Control'), 'no-store')
  const admitted = (await first.json()).data
  assert.equal(admitted.created, true)
  assert.equal(admitted.task.status, 'queued')
  const second = (await (await command(`/${source.id}/continue`)).json()).data
  assert.equal(second.created, false)
  assert.equal(second.task.id, admitted.task.id)
  const status = await route.request(`/${source.id}/continuation`)
  assert.equal(status.headers.get('Cache-Control'), 'no-store')
  assert.equal((await status.json()).data.task.id, admitted.task.id)
  assert.equal((await (await route.request(`/${other.id}/continuation`)).json()).data.task, null)
})

test('malformed IDs, body, content type and remote commands do not enqueue paid work', async () => {
  const source = seed()
  for (const id of ['0', '-1', 'bad', '1.2', '99999999999999999999']) {
    assert.equal((await command(`/${id}/continue`)).status, 400)
    assert.equal((await route.request(`/${id}/continuation`)).status, 400)
  }
  for (const body of [null, [], { expectedRevision: 42 }, { expectedRevision: 'invalid' }, { retry: true }]) {
    assert.equal((await command(`/${source.id}/continue`, body)).status, 400)
  }
  assert.equal((await command(`/${source.id}/continue?all=true`)).status, 400)
  assert.equal((await route.request(`/${source.id}/continue`, { method: 'POST' })).status, 400)
  assert.equal((await route.request(`/${source.id}/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  for (const origin of ['https://attacker.example', 'http://localhost:9999', 'malformed']) {
    assert.equal((await command(`/${source.id}/continue`, {}, { Origin: origin })).status, 403)
  }
  assert.equal((await command(`/${source.id}/continue`, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM creation_tasks').get() as { n: number }).n, 0)
})

test('stale source revisions conflict and deleted or absent sources return 404 without enqueueing', async () => {
  const source = seed()
  const conflict = await command(`/${source.id}/continue`, { expectedRevision: '0'.repeat(64) })
  assert.equal(conflict.status, 409)
  assert.match((await conflict.json()).message, /已更新/)
  deleteHistorySource(source.id)
  assert.equal((await command(`/${source.id}/continue`)).status, 404)
  assert.equal((await route.request(`/${source.id}/continuation`)).status, 404)
  assert.equal((await command('/999999/continue')).status, 404)
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM creation_tasks').get() as { n: number }).n, 0)
})
