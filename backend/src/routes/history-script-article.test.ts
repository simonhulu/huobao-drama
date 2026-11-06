import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'history-article-route-test-'))
process.env.DB_PATH = join(root, 'test.db')
process.env.TASK_WORKER_DISABLED = '1'
const { db } = await import('../db/index.js')
const { storeHistorySource } = await import('../services/history-script-library.js')
const { createHistoryArticleRoute } = await import('./history-script-article.js')
const app = new Hono().route('/:id/article', createHistoryArticleRoute({ root }))
const source = storeHistorySource({ sourceVideoId: '12345', title: '历史话题', category: 'historical_commentary', selection: { reason: 'test', observedAt: '2026-10-14T08:00:00Z', comments: [] } })
after(() => { db.$client.close(); rmSync(root, { recursive: true, force: true }) })

test('GET reports empty state and an actionable preflight reason', async () => {
  const response = await app.request(`/${source.id}/article`)
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.status, 'idle')
  assert.equal(data.article, null)
  assert.equal(data.canGenerate, false)
  assert.match(data.unavailableReason, /纠错/)
})

test('article input rejects extra fields and malformed bodies', async () => {
  for (const input of [{ targetLength: '2000' }, { targetLength: 2000, prompt: 'injection' }, { targetLength: 2000, selectionMethod: 'manual-source-exact' }, { targetLength: 2000, reviewer: 'native-agent', approved: true }, null, []]) {
    const response = await app.request(`/${source.id}/article`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    assert.equal(response.status, 400)
  }
  for (const body of ['', '{bad', ' '.repeat(2049)]) assert.equal((await app.request(`/${source.id}/article`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 400)
  assert.equal((await app.request(`/${source.id}/article`, { method: 'POST', body: '{}' })).status, 400)
})

test('empty input and legacy numeric length preferences reach the source preflight', async () => {
  for (const input of [{}, { targetLength: 1000 }, { targetLength: 2000 }]) {
    const response = await app.request(`/${source.id}/article`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    assert.equal(response.status, 409)
    assert.match((await response.json()).message, /纠错/)
  }
})

test('origin and fetch metadata protect costly generation from unrelated sites', async () => {
  for (const Origin of ['https://evil.example', 'null', 'http://localhost.evil.example:3013', 'http://localhost:3013/not-an-origin', 'http://localhost:9999']) {
    const response = await app.request(`http://localhost:3013/${source.id}/article`, { method: 'POST', headers: { Origin, 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 403)
  }
  const forbidden = await app.request(`http://localhost:3013/${source.id}/article`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(forbidden.status, 403)
  assert.equal((await app.request(`https://evil.example/${source.id}/article`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
  for (const Origin of ['http://localhost:3013', 'http://127.0.0.1:3013']) {
    const allowed = await app.request(`http://localhost:3013/${source.id}/article`, { method: 'POST', headers: { Origin, 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(allowed.status, 409, 'Allowed origin reaches source preflight')
  }
})

test('article and export routes validate IDs, missing sources and formats', async () => {
  for (const id of ['abc', '0', '-1', '1e2', '1.5', '9007199254740992']) {
    assert.equal((await app.request(`/${id}/article`)).status, 400)
    assert.equal((await app.request(`/${id}/article/export`)).status, 400)
  }
  assert.equal((await app.request('/999999/article')).status, 404)
  assert.equal((await app.request(`/${source.id}/article/export?format=html`)).status, 409)
  assert.equal((await app.request(`/${source.id}/article/export?format=pdf`)).status, 400)
  assert.equal((await app.request(`/${source.id}/article/export?format=html&filename=evil`)).status, 400)
})
