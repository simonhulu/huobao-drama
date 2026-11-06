import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HuashengAccountsService, HISTORY_HUASHENG_ACCOUNT } from './huasheng-accounts.js'
import { HuashengIdentityError } from './huasheng-identity.js'
import { HuashengBrowserError } from './history-huasheng-browser.js'

function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huasheng-workspaces-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const historyRoot = path.join(root, 'history'), scienceRoot = path.join(root, 'science')
  let historyUid = '1001', scienceUid = '2002'
  const history = new HuashengAccountsService({ scope: 'history', stateRoot: historyRoot, peerStateRoot: scienceRoot,
    legacyConfig: { endpoint: 'http://127.0.0.1:9243', profile: path.join(root, 'original-history-profile') },
    driver: async () => ({ status: 'ready', message: 'ready', identity: { uid: historyUid, displayName: '历史用户' } }) })
  const science = new HuashengAccountsService({ scope: 'science', stateRoot: scienceRoot, peerStateRoot: historyRoot,
    driver: async () => ({ status: 'ready', message: 'ready', identity: { uid: scienceUid, displayName: '科普用户' } }) })
  const s = science.create({ label: '科普专用' })
  return { root, history, science, s, setHistoryUid: (uid: string) => { historyUid = uid }, setScienceUid: (uid: string) => { scienceUid = uid } }
}

test('history preserves its original session and each workspace rejects the other account namespace', async t => {
  const f = fixture(t)
  const h = f.history.list().accounts[0]!
  assert.equal(h.accountName, HISTORY_HUASHENG_ACCOUNT)
  assert.equal(h.scope, 'history')
  assert.equal(f.history.browserConfig(h.accountName).profile, path.join(f.root, 'original-history-profile'))
  assert.equal(f.science.browserConfig(f.s.accountName).endpoint, 'http://127.0.0.1:9250')
  assert.throws(() => f.history.get(f.s.accountName), /编号无效/)
  assert.throws(() => f.science.get(h.accountName), /编号无效/)
  assert.throws(() => f.history.create({ label: '另一个历史账号' }), /固定/)
  await f.history.check(h.accountName)
  await f.science.check(f.s.accountName)
  assert.equal((await f.history.readyBrowserConfig(h.accountName)).expectedUid, '1001')
  assert.equal((await f.science.readyBrowserConfig(f.s.accountName)).expectedUid, '2002')
  const restored = new HuashengAccountsService({ scope: 'history', stateRoot: path.join(f.root, 'history'),
    legacyConfig: { endpoint: 'http://127.0.0.1:9999', profile: '/different-profile' } })
  assert.equal(restored.browserConfig(h.accountName).endpoint, 'http://127.0.0.1:9243')
  assert.equal(restored.get(h.accountName).identity?.uid, '1001')
})

test('a switched login cannot overwrite the pinned identity or become a ready production account', async t => {
  const f = fixture(t)
  await f.science.check(f.s.accountName)
  f.setScienceUid('3003')
  const result = await f.science.check(f.s.accountName)
  assert.equal(result.identity?.uid, '2002')
  assert.equal(result.observedIdentity?.uid, '3003')
  assert.equal(result.identityStatus, 'mismatch')
  assert.notEqual(result.status, 'ready')
  await assert.rejects(f.science.readyBrowserConfig(f.s.accountName), /不一致/)
  f.setScienceUid('2002')
  assert.equal((await f.science.check(f.s.accountName)).identityStatus, 'verified')
})

test('the same official user cannot be used by history and science, even with different profiles', async t => {
  const f = fixture(t)
  await f.history.check(HISTORY_HUASHENG_ACCOUNT)
  f.setScienceUid('1001')
  const result = await f.science.check(f.s.accountName)
  assert.equal(result.identityStatus, 'conflict')
  assert.notEqual(result.status, 'ready')
  await assert.rejects(f.science.readyBrowserConfig(f.s.accountName), /历史/)
  await assert.rejects(f.history.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT), /科普/)
})

test('logged-in page without an official identity cannot be reported as a verified account', async t => {
  const f = fixture(t)
  const service = new HuashengAccountsService({ scope: 'science', stateRoot: path.join(f.root, 'no-identity'),
    driver: async () => ({ status: 'ready', message: 'cookie=SECRET' }) })
  const account = service.create({ label: '待检查' })
  const result = await service.check(account.accountName)
  assert.notEqual(result.status, 'ready')
  assert.equal(result.identityStatus, 'unavailable')
  assert.doesNotMatch(JSON.stringify(result), /SECRET|cookie=/)
})

test('explicit production can reopen its own browser while passive checks preserve connection recovery codes', async t => {
  const f = fixture(t), actions: string[] = [], controller = new AbortController()
  const service = new HuashengAccountsService({ scope: 'history', stateRoot: path.join(f.root, 'reopen'),
    legacyConfig: { endpoint: 'http://127.0.0.1:9243', profile: path.join(f.root, 'closed-profile') },
    driver: async (action, _config, signal) => {
      actions.push(action)
      if (action === 'check') throw new Error('browser closed')
      assert.equal(signal, controller.signal)
      return { status: 'ready', message: 'ready', identity: { uid: '1001', displayName: '历史用户' } }
    } })
  await assert.rejects(service.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT), (error: any) => error.code === 'browser_unavailable')
  assert.equal((await service.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT, { open: true, signal: controller.signal })).expectedUid, '1001')
  assert.deepEqual(actions, ['check', 'login'])
  controller.abort()
  await assert.rejects(service.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT, { open: true, signal: controller.signal }), (error: Error) => error.name === 'AbortError')
  assert.deepEqual(actions, ['check', 'login'])
})

test('ready browser configuration preserves only the current check temporary failure', async t => {
  const f = fixture(t)
  let failure: Error | undefined = Object.assign(new HuashengIdentityError('unavailable', '身份接口暂时不可用'), { retryable: true })
  const service = new HuashengAccountsService({ scope: 'history', stateRoot: path.join(f.root, 'temporary-check'),
    legacyConfig: { endpoint: 'http://127.0.0.1:9243', profile: path.join(f.root, 'temporary-profile') },
    driver: async () => {
      if (failure) throw failure
      return { status: 'ready', message: 'ready', identity: { uid: '1001', displayName: '原账号' } }
    } })
  await assert.rejects(service.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT), (error: any) => error.code === 'browser_unavailable' && error.retryable === true)
  for (const permanent of [new HuashengIdentityError('unavailable', '请检查安全验证'),
    new HuashengIdentityError('login_required', '登录过期'), new Error('unknown driver error')]) {
    failure = permanent
    await assert.rejects(service.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT), (error: any) => error.retryable !== true)
  }
  failure = Object.assign(new HuashengBrowserError('browser_unavailable', '连接超时'), { retryable: true as const })
  await assert.rejects(service.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT), (error: any) => error.code === 'browser_unavailable' && error.retryable === true)
  failure = undefined
  assert.equal((await service.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT)).expectedUid, '1001')
  assert.equal('retryable' in service.get(HISTORY_HUASHENG_ACCOUNT), false)
})

test('an explicit browser open follows an in-flight passive check and a canceled waiter cannot open later', async t => {
  const f = fixture(t), actions: string[] = []
  let release!: () => void
  const service = new HuashengAccountsService({ scope: 'history', stateRoot: path.join(f.root, 'concurrent'),
    legacyConfig: { endpoint: 'http://127.0.0.1:9243', profile: path.join(f.root, 'concurrent-profile') },
    driver: async action => {
      actions.push(action)
      if (action === 'check') {
        await new Promise<void>(resolve => { release = resolve })
        return { status: 'unavailable', message: 'closed' }
      }
      return { status: 'ready', message: 'ready', identity: { uid: '1001', displayName: '历史用户' } }
    } })
  const pending = service.check(HISTORY_HUASHENG_ACCOUNT)
  await new Promise(resolve => setImmediate(resolve))
  const production = service.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT, { open: true })
  release(); await pending
  assert.equal((await production).expectedUid, '1001')
  assert.deepEqual(actions, ['check', 'login'])
  const checking = service.check(HISTORY_HUASHENG_ACCOUNT)
  await new Promise(resolve => setImmediate(resolve))
  const controller = new AbortController()
  const canceled = service.readyBrowserConfig(HISTORY_HUASHENG_ACCOUNT, { open: true, signal: controller.signal })
  controller.abort()
  await assert.rejects(canceled, (error: Error) => error.name === 'AbortError')
  release(); await checking
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(actions, ['check', 'login', 'check'])
})
