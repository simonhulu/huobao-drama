import test from 'node:test'
import assert from 'node:assert/strict'
import puppeteer, { type Browser } from 'puppeteer-core'
import { readHuashengIdentity, HuashengIdentityError } from './huasheng-identity.js'
import { connectHuashengBrowser, createHuashengPagePort, HuashengBrowserError } from './history-huasheng-browser.js'
import { readHuashengProductionSession, readHuashengExportSession, HuashengExportApiError } from './history-huasheng-export-api.js'

const profile = '/tmp/huasheng-identity-fixture'
const browser = () => ({
  target: () => ({ createCDPSession: async () => ({ send: async () => ({ arguments: [`--user-data-dir=${profile}`] }), detach: async () => {} }) }),
  defaultBrowserContext: () => ({ cookies: async () => [{ name: 'SESSDATA', value: 'private-session', domain: '.huasheng.cn' }, { name: 'private', value: 'unrelated', domain: '.example.com' }] }),
  userAgent: async () => 'fixture-browser', disconnect: async () => {},
} as unknown as Browser)

test('identity is read only from the official authenticated response with unrelated cookies excluded', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.huasheng.cn/x/web-interface/nav')
    assert.equal(init?.method, 'GET')
    assert.equal(new Headers(init?.headers).get('Cookie'), 'SESSDATA=private-session')
    return new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 1001, uname: '13812345678', token: 'do-not-expose' } }))
  })
  assert.deepEqual(await readHuashengIdentity(browser()), { uid: '1001', displayName: '138****5678' })
})

test('expired, malformed and unsafe official identities fail without leaking upstream credentials', async t => {
  let payload: unknown
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)))
  for (const value of [
    { code: -101, message: 'cookie=SECRET' }, { code: 0, data: { isLogin: false, mid: 1001, uname: 'old user' } },
    { code: 0, data: { isLogin: true, mid: Number.MAX_SAFE_INTEGER + 1, uname: 'user' } },
    { code: 0, data: { isLogin: true, mid: 1001, uname: '' } }, { code: 500, message: 'token=SECRET' },
  ]) {
    payload = value
    await assert.rejects(readHuashengIdentity(browser()), error => { assert.doesNotMatch(String(error), /SECRET|cookie=|token=/); return true })
  }
})

test('temporary upstream identity responses retry before accepting the official pinned user', async t => {
  const statuses = [502, 429, 200]
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    assert.equal(init?.method, 'GET')
    const status = statuses[calls++]!
    return new Response(JSON.stringify(status === 200 ? { code: 0, data: { isLogin: true, mid: 1001, uname: 'user' } } : { token: 'SECRET' }), { status })
  })
  assert.deepEqual(await readHuashengIdentity(browser()), { uid: '1001', displayName: 'user' })
  assert.equal(calls, 3)
})

test('temporary identity connection errors retry but an exhausted outage is not reported as login expiry', async t => {
  let calls = 0, failing = false
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (failing || calls === 1) throw new TypeError('fetch failed: private-session')
    return new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 1001, uname: 'user' } }))
  })
  assert.equal((await readHuashengIdentity(browser())).uid, '1001')
  assert.equal(calls, 2)
  calls = 0; failing = true
  await assert.rejects(readHuashengIdentity(browser()), error => {
    assert.ok(error instanceof HuashengIdentityError)
    assert.equal(error.code, 'unavailable')
    assert.equal(error.retryable, true)
    assert.match(error.message, /尝试 3 次.*登录状态尚未确认/)
    assert.doesNotMatch(error.message, /private-session|已失效/)
    return true
  })
  assert.equal(calls, 3)
})

test('HTTP identity outages stop after three reads and expose only a safe status', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('token=SECRET', { status: 503 }) })
  await assert.rejects(readHuashengIdentity(browser()), error => {
    assert.ok(error instanceof HuashengIdentityError)
    assert.equal(error.code, 'unavailable')
    assert.equal(error.retryable, true)
    assert.match(error.message, /HTTP 503.*尝试 3 次/)
    assert.doesNotMatch(error.message, /SECRET|token=/)
    return true
  })
  assert.equal(calls, 3)
})

test('definite login failure and forbidden verification do not retry or conflate their causes', async t => {
  let calls = 0, status = 401
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('private credentials', { status }) })
  await assert.rejects(readHuashengIdentity(browser()), error => error instanceof HuashengIdentityError && error.code === 'login_required' && !error.retryable)
  assert.equal(calls, 1)
  status = 403
  await assert.rejects(readHuashengIdentity(browser()), error => error instanceof HuashengIdentityError && error.code === 'unavailable' && !error.retryable && /安全验证/.test(error.message))
  assert.equal(calls, 2)
})

test('identity retry backoff respects cancellation without another request', async t => {
  let calls = 0
  const controller = new AbortController(), reason = new Error('user canceled identity check')
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 408, headers: { 'Retry-After': '30' } }) })
  const result = readHuashengIdentity(browser(), controller.signal)
  const timer = setTimeout(() => controller.abort(reason), 10)
  t.after(() => clearTimeout(timer))
  await assert.rejects(result, error => error === reason)
  assert.equal(calls, 1)
})

test('temporary identity verification propagates retryability through browser and production/export session reads', async t => {
  const b = browser(), config = { endpoint: 'http://127.0.0.1:9243', profile, expectedUid: '1001' }
  t.mock.method(puppeteer, 'connect', async () => b)
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
  await assert.rejects(connectHuashengBrowser(config), error => {
    assert.ok(error instanceof HuashengBrowserError)
    assert.equal(error.code, 'browser_unavailable'); assert.equal(error.retryable, true)
    return true
  })
  for (const read of [readHuashengProductionSession, readHuashengExportSession]) {
    await assert.rejects(read({ projectUrl: 'https://www.huasheng.cn/video/123', browserConfig: config, signal: new AbortController().signal }), error => {
      assert.ok(error instanceof HuashengExportApiError)
      assert.equal(error.code, 'retryable')
      return true
    })
  }
})

test('expired, forbidden and switched users remain blocked through production and export reads', async t => {
  const b = browser(), config = { endpoint: 'http://127.0.0.1:9243', profile, expectedUid: '1001' }
  t.mock.method(puppeteer, 'connect', async () => b)
  let status = 401, uid = 1001
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: uid, uname: 'user' } }), { status }))
  for (const read of [readHuashengProductionSession, readHuashengExportSession]) {
    for (const [nextStatus, nextUid, expected] of [[401, 1001, 'login_required'], [403, 1001, 'browser_unavailable'], [200, 2002, 'invalid_response']] as const) {
      status = nextStatus; uid = nextUid
      await assert.rejects(read({ projectUrl: 'https://www.huasheng.cn/video/123', browserConfig: config, signal: new AbortController().signal }), error => {
        assert.ok(error instanceof HuashengExportApiError)
        assert.equal(error.code, expected)
        return true
      })
    }
  }
})

test('managed browser validates its pinned UID and never proceeds with a switched user', async t => {
  let uid = 1001, disconnected = 0
  const b = browser()
  t.mock.method(b, 'disconnect', async () => { disconnected++ })
  t.mock.method(puppeteer, 'connect', async () => b)
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: uid, uname: 'user' } })))
  const config = { endpoint: 'http://127.0.0.1:9243', profile, expectedUid: '1001' }
  await (await connectHuashengBrowser(config)).disconnect()
  uid = 2002
  await assert.rejects(connectHuashengBrowser(config), error => {
    assert.ok(error instanceof HuashengBrowserError)
    assert.equal(error.code, 'manual_review'); assert.equal(error.actionNotStarted, true)
    return true
  })
  assert.equal(disconnected, 2)
})

test('a failed identity check immediately before a browser action cannot inspect or click any control', async () => {
  const port = createHuashengPagePort({ $$: async () => assert.fail('no DOM action is allowed after identity changed') } as any,
    'saved script', async () => { throw new HuashengBrowserError('manual_review', '账号不匹配', true) })
  await assert.rejects(async () => { await port.prepareAction?.(); await port.click('确认并继续') }, /账号不匹配/)
})
