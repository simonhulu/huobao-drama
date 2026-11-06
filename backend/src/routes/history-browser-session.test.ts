import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HistoryBrowserSessionRouteDependencies } from './history-browser-session.js'

const isolatedDirectory = mkdtempSync(join(tmpdir(), 'history-browser-session-route-'))
process.env.DB_PATH = join(isolatedDirectory, 'test.db')
process.env.HISTORY_SOURCE_AUTH_DIR = join(isolatedDirectory, 'never-live-auth')
process.env.HISTORY_LOGIN_CDP_URL = 'http://127.0.0.1:1'
process.env.HISTORY_LIGHTPANDA_CDP_URL = 'ws://127.0.0.1:1'
process.env.PUPPETEER_EXECUTABLE_PATH = join(isolatedDirectory, 'browser-launch-forbidden')
const { createHistoryBrowserSessionRoute } = await import('./history-browser-session.js')
const { createHistoryScriptsRoute } = await import('./history-scripts.js')
const { HistoryBrowserAuthError } = await import('../services/history-source-auth.js')

const session = { status: 'login_required' as const, message: '尚未保存抖音登录会话', updatedAt: null,
  checkedAt: null, canCollect: false, checks: [] }

function fixture() {
  const calls = { status: 0, open: 0, check: 0 }
  const dependencies = {
    getStatus: async () => { calls.status++; return session },
    openLogin: async () => { calls.open++; return { ...session, status: 'waiting_login' as const } },
    checkLogin: async () => { calls.check++; return { ...session, status: 'blocked' as const, message: '安全验证' } },
  } satisfies HistoryBrowserSessionRouteDependencies
  return { calls, dependencies, route: createHistoryBrowserSessionRoute(dependencies) }
}

function write(route: ReturnType<typeof createHistoryBrowserSessionRoute>, action: string, body: unknown = {}, origin = 'http://localhost:3013') {
  return route.request(`/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
}

test('session status is readable without opening a browser or confirming login', async () => {
  const { route, calls } = fixture()
  for (let index = 0; index < 2; index++) {
    const response = await route.request('/')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { code: 200, message: 'success', data: { session } })
  }
  assert.deepEqual(calls, { status: 2, open: 0, check: 0 })
  assert.equal((await route.request('/open')).status, 404)
  assert.equal((await route.request('/confirm')).status, 404)
  assert.equal((await route.request('/check')).status, 404)
})

test('fixed login commands accept only empty JSON objects and return public session status', async () => {
  const { route, calls } = fixture()
  assert.equal((await write(route, 'open')).status, 200)
  const confirmed = await write(route, 'confirm')
  assert.equal(confirmed.status, 200)
  assert.equal((await confirmed.json()).data.session.status, 'blocked')
  const checked = await write(route, 'check')
  assert.equal(checked.status, 200)
  assert.equal((await checked.json()).data.session.status, 'blocked')
  for (const action of ['open', 'confirm', 'check']) {
    for (const body of [null, [], '', 1, true, { url: 'https://evil.com' }, { cookies: [] }, { profile: '/Users/private' }, { arbitrary: true }]) {
      assert.equal((await write(route, action, body)).status, 400)
    }
    for (const contentType of ['', 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonx']) {
      assert.equal((await route.request(`/${action}`, {
        method: 'POST', headers: contentType ? { 'Content-Type': contentType } : {}, body: '{}',
      })).status, 400)
    }
    assert.equal((await route.request(`/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  }
  assert.deepEqual(calls, { status: 0, open: 1, check: 2 })
})

test('login commands enforce local origins using the same allowed ports as sourcing jobs', async () => {
  const { route, calls } = fixture()
  for (const origin of ['https://example.com', 'null', 'http://localhost:3000', 'http://localhost.evil.com:3013',
    'http://127.0.0.1:4444', 'http://user:secret@localhost:3013', 'http://localhost:3013/path']) {
    for (const action of ['open', 'confirm', 'check']) assert.equal((await write(route, action, {}, origin)).status, 403)
  }
  assert.deepEqual(calls, { status: 0, open: 0, check: 0 })
  for (const origin of ['http://localhost:3013', 'http://127.0.0.1:9130', 'http://127.0.0.1:9131', 'http://[::1]:5679']) {
    assert.equal((await write(route, 'open', {}, origin)).status, 200)
  }
  assert.equal((await route.request('/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{}',
  })).status, 200)
  assert.deepEqual(calls, { status: 0, open: 4, check: 1 })
})

test('login targets and credentials cannot be supplied through URL query parameters', async () => {
  const { route, calls } = fixture()
  for (const action of ['open', 'confirm', 'check']) {
    for (const query of ['url=https%3A%2F%2Fevil.com', 'cookies=secret', 'profile=%2FUsers%2Fprivate']) {
      assert.equal((await route.request(`/${action}?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })).status, 400)
    }
  }
  assert.deepEqual(calls, { status: 0, open: 0, check: 0 })
})

test('only known authentication errors are public and transport details never leave the route', async () => {
  for (const action of ['status', 'open', 'confirm', 'check']) {
    for (const known of [false, true]) {
      const dependencies = fixture().dependencies
      const error = known ? new HistoryBrowserAuthError('missing_auth') : new Error('Cookie secret=token /Users/private/profile ws://user:password@127.0.0.1:9241')
      const fail = async () => { throw error }
      if (action === 'status') dependencies.getStatus = fail
      else if (action === 'open') dependencies.openLogin = fail
      else dependencies.checkLogin = fail
      const route = createHistoryBrowserSessionRoute(dependencies)
      const response = action === 'status' ? await route.request('/') : await write(route, action)
      assert.equal(response.status, 503)
      const result = await response.json()
      assert.equal(result.code, 503)
      assert.equal(result.message, known ? error.message : '抖音登录服务暂不可用，请稍后重试')
      assert.doesNotMatch(JSON.stringify(result), /secret|token|private|password|9241/)
    }
  }
})

test('browser-session routes match before source identifiers when mounted in the script library', async () => {
  const { dependencies, calls } = fixture()
  const route = createHistoryScriptsRoute({ browserSessionDependencies: dependencies })
  const response = await route.request('/browser-session')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data.session, session)
  assert.equal((await route.request('/browser-session/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200)
  assert.equal((await route.request('/browser-session/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200)
  assert.equal((await route.request('/browser-session/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200)
  assert.deepEqual(calls, { status: 1, open: 1, check: 2 })
  assert.equal((await route.request('/not-a-source')).status, 400)
})

test('opening login while the collector owns its browser returns a recoverable conflict', async () => {
  const dependencies = fixture().dependencies
  dependencies.openLogin = async () => { throw new HistoryBrowserAuthError('busy') }
  const response = await write(createHistoryBrowserSessionRoute(dependencies), 'open')
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 409)
})
