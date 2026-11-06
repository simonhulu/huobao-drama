import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createCzgtsSettingsRoute, createHistorySourceSettingsRoute } from './history-source-settings.js'
import { CzgtsSourceError } from '../services/history-source-czgts.js'
import { requestLogger } from '../middleware/logger.js'

const secret = 'sessionid=private-route-test-cookie'
const updatedAt = '2026-10-21T08:00:00.000Z'
function fixture() {
  const state = { configured: true, saves: [] as string[], checks: 0 }
  const route = createCzgtsSettingsRoute({
    credentials: {
      status: async () => ({ configured: state.configured, updatedAt, cookie: secret }),
      save: async cookie => {
        state.saves.push(String(cookie))
        return { configured: true, updatedAt, cookie: secret }
      },
    },
    check: async () => { state.checks++; return { configured: true, total: 12, message: secret } },
  })
  return { state, route }
}
function jsonRequest(route: Hono, path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return route.request(path, { method, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3013', ...headers }, body: JSON.stringify(body) })
}

test('CZGTS status and writes return only configured/updatedAt with no-store', async () => {
  const { state, route } = fixture()
  for (const response of [await route.request('/settings'), await jsonRequest(route, '/settings', 'PUT', { cookie: secret })]) {
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const text = await response.text()
    assert.doesNotMatch(text, /private-route-test-cookie|sessionid/)
    assert.deepEqual(JSON.parse(text).data, { configured: true, updatedAt })
  }
  assert.deepEqual(state.saves, [secret])
})

test('CZGTS PUT accepts only a strict cookie JSON object and enforces streamed 40KB limit', async () => {
  const { state, route } = fixture()
  for (const body of [{}, { cookie: 42 }, { cookie: '' }, { cookie: secret, extra: true }, [secret], null]) {
    assert.equal((await jsonRequest(route, '/settings', 'PUT', body)).status, 400)
  }
  for (const contentType of ['text/plain', 'application/jsonp', 'application/json-evil']) {
    assert.equal((await jsonRequest(route, '/settings', 'PUT', { cookie: secret }, { 'Content-Type': contentType })).status, 400)
  }
  assert.equal((await route.request('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  assert.equal((await jsonRequest(route, '/settings', 'PUT', { cookie: 'x'.repeat(41 * 1024) })).status, 413)
  assert.equal((await jsonRequest(route, '/settings', 'PUT', { cookie: secret }, { 'Content-Length': String(41 * 1024) })).status, 413)
  assert.deepEqual(state.saves, [])
})

test('both CZGTS mutations reject foreign origins, ports, fetch sites and all query parameters', async () => {
  const { state, route } = fixture()
  const deniedHeaders: Array<Record<string, string>> = [
    { Origin: 'https://example.com' }, { Origin: 'http://localhost:9999' }, { Origin: 'ftp://localhost:3013' },
    { Origin: 'http://evil@localhost:3013' }, { Origin: 'http://localhost:3013/untrusted' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'unknown' },
  ]
  for (const [path, method, body] of [['/settings', 'PUT', { cookie: secret }], ['/check', 'POST', {}]] as const) {
    for (const headers of deniedHeaders) {
      const response = await jsonRequest(route, path, method, body, headers)
      assert.equal(response.status, 403)
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
    }
    assert.equal((await jsonRequest(route, `${path}?cookie=${secret}`, method, body)).status, 400)
    assert.equal((await route.request(path, { method, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' }, body: JSON.stringify(body) })).status, 403)
  }
  assert.equal((await route.request(`/settings?cookie=${secret}`)).status, 400)
  assert.deepEqual(state.saves, [])
  assert.equal(state.checks, 0)
})

test('CZGTS check requires configured credentials and exactly empty application/json', async () => {
  const { state, route } = fixture()
  for (const body of [{ cookie: secret }, [], null, { unknown: 1 }]) {
    assert.equal((await jsonRequest(route, '/check', 'POST', body)).status, 400)
  }
  assert.equal((await route.request('/check', { method: 'POST' })).status, 400)
  state.configured = false
  assert.equal((await jsonRequest(route, '/check', 'POST', {})).status, 401)
  assert.equal(state.checks, 0)
  state.configured = true
  const response = await jsonRequest(route, '/check', 'POST', {}, { 'Sec-Fetch-Site': 'same-origin' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual((await response.json()).data, { configured: true, total: 12, message: '连接成功，最近 24 小时找到 12 篇历史文章' })
  assert.equal(state.checks, 1)
})

test('CZGTS known errors use fixed public messages and unknown errors never expose provider secrets', async () => {
  for (const action of ['status', 'save', 'check']) {
    for (const known of [false, true]) {
      const error = known ? new CzgtsSourceError('network') : new Error(`sensitive ${secret}`)
      error.message = `sensitive ${secret}`
      const route = createCzgtsSettingsRoute({
        credentials: {
          status: async () => { if (action === 'status') throw error; return { configured: true, updatedAt } },
          save: async () => { throw error },
        },
        check: async () => { throw error },
      })
      const response = action === 'status' ? await route.request('/settings')
        : await jsonRequest(route, action === 'save' ? '/settings' : '/check', action === 'save' ? 'PUT' : 'POST', action === 'save' ? { cookie: secret } : {})
      assert.equal(response.status, known ? 502 : 500)
      assert.equal(response.headers.get('Cache-Control'), 'no-store')
      const text = await response.text()
      assert.doesNotMatch(text, /sensitive|private-route-test-cookie|sessionid/)
      if (known) assert.match(text, /请求失败或超时/)
    }
  }
})

test('collection-settings does not accidentally expose nested CZGTS credential endpoints', async () => {
  const route = createHistorySourceSettingsRoute()
  for (const [path, method] of [['/czgts/settings', 'GET'], ['/czgts/settings', 'PUT'], ['/czgts/check', 'POST']]) {
    assert.equal((await route.request(path, { method })).status, 404)
  }
})

test('requestLogger does not print credential request bodies or rejected credential-bearing queries', async () => {
  const { route } = fixture()
  const app = new Hono()
  app.use('*', requestLogger)
  app.route('/api/v1/history-scripts/czgts', route)
  const lines: unknown[][] = []
  const previous = console.log
  console.log = (...args) => { lines.push(args) }
  try {
    assert.equal((await jsonRequest(app, '/api/v1/history-scripts/czgts/settings', 'PUT', { cookie: secret })).status, 200)
    assert.equal((await jsonRequest(app, '/api/v1/history-scripts/czgts/settings?cookie=another-secret', 'PUT', { cookie: secret })).status, 400)
    assert.equal((await jsonRequest(app, '/api/v1/history-scripts/czgts/check', 'POST', { cookie: secret })).status, 400)
  } finally { console.log = previous }
  assert.ok(lines.length >= 6)
  assert.doesNotMatch(JSON.stringify(lines), /private-route-test-cookie|sessionid|another-secret/)
})
