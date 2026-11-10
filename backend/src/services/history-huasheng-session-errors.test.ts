import test from 'node:test'
import assert from 'node:assert/strict'
import puppeteer, { type Browser } from 'puppeteer-core'
import { HuashengBrowserError } from './history-huasheng-browser.js'
import { HuashengExportApiError, readHuashengExportSession, readHuashengProductionSession } from './history-huasheng-export-api.js'

const config = { endpoint: 'http://127.0.0.1:9250', profile: '/tmp/huasheng-session-error-fixture', expectedUid: '1001' }
const projectUrl = 'https://www.huasheng.cn/video/123'
function fixture(profile = config.profile) {
  const calls = { cookies: 0, disconnected: 0 }
  const context = { cookies: async () => {
    calls.cookies++
    return [{ name: 'SESSDATA', value: 'private-session', domain: '.huasheng.cn' }]
  } }
  const browser = {
    target: () => ({ createCDPSession: async () => ({
      send: async () => ({ arguments: [`--user-data-dir=${profile}`] }), detach: async () => {},
    }) }),
    defaultBrowserContext: () => context,
    userAgent: async () => 'fixture-agent',
    disconnect: async () => { calls.disconnected++ },
    newPage: async () => assert.fail('session failure must not open a page'),
  } as unknown as Browser
  return { calls, context, browser }
}

test('a production cookie read failure retains its exact cause after pinned identity verification', async t => {
  const f = fixture()
  const original = new Error('Protocol error (Storage.getCookies): Target closed. cookie=SECRET')
  let reads = 0
  t.mock.method(f.context, 'cookies', async () => {
    if (++reads === 2) throw original
    return [{ name: 'SESSDATA', value: 'private-session', domain: '.huasheng.cn' }]
  })
  t.mock.method(puppeteer, 'connect', async () => f.browser)
  const identity = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 1001, uname: 'user' } })))
  await assert.rejects(readHuashengProductionSession({ projectUrl, browserConfig: config, signal: new AbortController().signal }), error => {
    assert.ok(error instanceof HuashengExportApiError)
    assert.equal(error.code, 'retryable')
    assert.equal(error.cause, original)
    assert.doesNotMatch(error.message, /SECRET|cookie=|Storage\.getCookies/)
    return true
  })
  assert.equal(reads, 2)
  assert.equal(identity.mock.callCount(), 1)
  assert.equal(f.calls.disconnected, 1)
})

test('production and export connection wrappers preserve transient CDP causes and retryability', async t => {
  const original = new Error('Target.setAutoAttach timed out. token=SECRET')
  const connect = t.mock.method(puppeteer, 'connect', async () => { throw original })
  for (const read of [readHuashengProductionSession, readHuashengExportSession]) {
    await assert.rejects(read({ projectUrl, browserConfig: config, signal: new AbortController().signal }), error => {
      assert.ok(error instanceof HuashengExportApiError)
      assert.equal(error.code, 'retryable')
      assert.ok(error.cause instanceof HuashengBrowserError)
      assert.equal(error.cause.cause, original)
      assert.doesNotMatch(error.message, /SECRET|token=|Target\.setAutoAttach/)
      return true
    })
  }
  assert.equal(connect.mock.callCount(), 4)
})

test('unknown connection faults retain their causes without becoming retryable', async t => {
  const original = new Error('unexpected browser invariant token=SECRET')
  const connect = t.mock.method(puppeteer, 'connect', async () => { throw original })
  for (const read of [readHuashengProductionSession, readHuashengExportSession]) {
    await assert.rejects(read({ projectUrl, browserConfig: config, signal: new AbortController().signal }), error => {
      assert.ok(error instanceof HuashengExportApiError)
      assert.equal(error.code, 'browser_unavailable')
      assert.ok(error.cause instanceof HuashengBrowserError)
      assert.equal(error.cause.cause, original)
      assert.equal(error.cause.retryable, undefined)
      assert.doesNotMatch(error.message, /SECRET|token=|invariant/)
      return true
    })
  }
  assert.equal(connect.mock.callCount(), 2)
})

for (const scenario of [
  { label: 'expired login', status: 401, uid: 1001, code: 'login_required' },
  { label: 'forbidden identity verification', status: 403, uid: 1001, code: 'browser_unavailable' },
  { label: 'a switched identity', status: 200, uid: 2002, code: 'invalid_response' },
  { label: 'a different dedicated profile', status: 200, uid: 1001, code: 'browser_unavailable', profile: '/tmp/another-huasheng-account' },
] as const) {
  test(`session diagnostic causes do not weaken blocking for ${scenario.label}`, async t => {
    const f = fixture('profile' in scenario ? scenario.profile : config.profile)
    const connect = t.mock.method(puppeteer, 'connect', async () => f.browser)
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: scenario.uid, uname: 'user' } }), { status: scenario.status }))
    for (const read of [readHuashengProductionSession, readHuashengExportSession]) {
      await assert.rejects(read({ projectUrl, browserConfig: config, signal: new AbortController().signal }), error => {
        assert.ok(error instanceof HuashengExportApiError)
        assert.equal(error.code, scenario.code)
        assert.ok(error.cause instanceof HuashengBrowserError)
        assert.notEqual(error.cause.retryable, true)
        return true
      })
    }
    assert.equal(connect.mock.callCount(), 2)
    assert.equal(f.calls.disconnected, 2)
  })
}
