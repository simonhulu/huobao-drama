import test from 'node:test'
import assert from 'node:assert/strict'
import { createHistorySocialUploadRoute } from './history-social-upload.js'

const scriptSha256 = 'a'.repeat(64)

function request(route: ReturnType<typeof createHistorySocialUploadRoute>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return route.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

test('version continuation accepts only a locked manuscript and exact video identity', async () => {
  const calls: unknown[] = []
  const route = createHistorySocialUploadRoute({ continueVideo: async (...args: unknown[]) => {
    calls.push(args)
    return { reused: true, message: '已继续原发布任务', job: { id: '54', sourceId: 12, status: 'queued', mode: 'publish' } }
  } })
  const response = await request(route, '/versions/71/continue', { sourceId: 12, expectedScriptSha256: scriptSha256 })
  assert.equal(response.status, 202)
  assert.deepEqual(calls, [[12, 71, scriptSha256]])
  const { data } = await response.json()
  assert.equal(data.reused, true)
  assert.equal(data.job.id, '54')
  assert.equal(data.job.scriptId, 12)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

test('invalid version continuations cannot reach packaging or publication', async () => {
  let calls = 0
  const route = createHistorySocialUploadRoute({ continueVideo: async () => { calls++; return {} } })
  for (const id of ['0', '-1', '1.5', '1e3', 'bad', '9999999999999999999']) {
    assert.equal((await request(route, `/versions/${id}/continue`, { sourceId: 12, expectedScriptSha256: scriptSha256 })).status, 400)
  }
  for (const body of [null, {}, { sourceId: 12 }, { sourceId: 0, expectedScriptSha256: scriptSha256 },
    { sourceId: 12, expectedScriptSha256: 'old-revision' }, { sourceId: 12, expectedScriptSha256: scriptSha256, forcePublish: true }]) {
    assert.equal((await request(route, '/versions/71/continue', body)).status, 400)
  }
  assert.equal((await request(route, '/versions/71/continue?force=true', { sourceId: 12, expectedScriptSha256: scriptSha256 })).status, 400)
  assert.equal((await request(route, '/versions/71/continue', { sourceId: 12, expectedScriptSha256: scriptSha256 }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal(calls, 0)
})

test('version conflicts expose a recoverable conflict without creating another task', async () => {
  const route = createHistorySocialUploadRoute({ continueVideo: async () => {
    throw Object.assign(new Error('稿件已更新，请刷新后继续原任务'), { status: 409 })
  } })
  const response = await request(route, '/versions/71/continue', { sourceId: 12, expectedScriptSha256: scriptSha256 })
  assert.equal(response.status, 409)
  assert.match((await response.json()).message, /稿件已更新/)
})
