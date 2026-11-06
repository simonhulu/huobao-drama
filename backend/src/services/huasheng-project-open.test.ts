import test from 'node:test'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'
import { createHuashengProjectOpener } from './huasheng-project-open.js'
import { HuashengBrowserError } from './history-huasheng-browser.js'
import { SocialUploadAccountError } from './social-upload-accounts.js'
import type { HuashengAccount, HuashengAccountsService } from './huasheng-accounts.js'

const name = 'science_huasheng_11111111111111111111111111111111'
const projectUrl = 'https://www.huasheng.cn/video/123'
const config = { endpoint: 'http://127.0.0.1:9257', profile: '/tmp/huasheng-original-project-profile' }
function fixture() {
  const selected: string[] = []
  const account = { accountName: name, label: '原账号', identity: { uid: '1001', displayName: '原用户' }, identityStatus: 'verified' } as HuashengAccount
  const accounts: Pick<HuashengAccountsService, 'get' | 'browserConfig'> = {
    get: selectedName => { assert.equal(selectedName, name); return account },
    browserConfig: selectedName => { selected.push(selectedName); assert.equal(selectedName, name); return { ...config, expectedUid: account.identity?.uid } },
  }
  const calls = { disconnected: 0, front: 0, newPage: 0, goto: [] as string[], closed: 0, stale: 0 }
  const page = { bringToFront: async () => { calls.front++ }, goto: async (url: string) => { calls.goto.push(url) } }
  const targets = [
    { type: () => 'page', url: () => 'https://www.huasheng.cn/video/999', page: async () => { calls.stale++; throw new Error('unrelated stale tab') } },
    { type: () => 'page', url: () => `${projectUrl}?from=my-projects`, page: async () => page },
  ]
  const browser = { targets: () => targets, disconnect: async () => { calls.disconnected++ },
    pages: async () => assert.fail('must not initialize unrelated retained tabs') }
  const dependencies = {
    connect: async (resolved: unknown) => { assert.deepEqual(resolved, config); return browser as any },
    openBrowser: async () => assert.fail('a connected profile must not be opened again'),
    createPage: async () => { calls.newPage++; return page as any },
    closePage: async () => { calls.closed++; return true },
  }
  return { accounts, account, selected, calls, page, browser, targets, dependencies }
}

test('opens the saved account profile and reuses its exact project tab without navigation or default-account lookup', async () => {
  const f = fixture(), open = createHuashengProjectOpener(f.dependencies)
  const result = await open(f.accounts, { accountName: name, projectUrl })
  assert.equal(result.accountName, name)
  assert.equal(result.projectUrl, projectUrl)
  assert.equal(result.reused, true)
  assert.deepEqual(f.selected, [name])
  assert.equal(f.calls.front, 1)
  assert.equal(f.calls.newPage, 0)
  assert.equal(f.calls.stale, 0)
  assert.deepEqual(f.calls.goto, [])
  assert.equal(f.calls.disconnected, 1)
  assert.equal(f.account.identity?.uid, '1001')
  assert.equal(JSON.stringify(result).includes(config.profile), false)
})

test('a missing project tab is opened once in the original profile and brought to front', async () => {
  const f = fixture(); f.targets.pop()
  const result = await createHuashengProjectOpener(f.dependencies)(f.accounts, { accountName: name, projectUrl: `${projectUrl}/?from=task` })
  assert.equal(result.reused, false)
  assert.deepEqual(f.calls.goto, [projectUrl])
  assert.equal(f.calls.newPage, 1)
  assert.equal(f.calls.front, 1)
  assert.equal(f.calls.stale, 0)
  assert.equal(f.calls.closed, 0)
})

test('concurrent clicks share one opening operation without any production lock', async () => {
  const f = fixture()
  let release!: (browser: any) => void, connections = 0
  const pending = new Promise<any>(resolve => { release = resolve })
  const open = createHuashengProjectOpener({ ...f.dependencies, connect: async () => { connections++; return pending } })
  const first = open(f.accounts, { accountName: name, projectUrl })
  const second = open(f.accounts, { accountName: name, projectUrl })
  assert.equal(connections, 1)
  release(f.browser)
  assert.deepEqual(await first, await second)
  assert.equal(f.calls.front, 1)
  assert.equal(f.calls.disconnected, 1)
  await open(f.accounts, { accountName: name, projectUrl })
  assert.equal(connections, 2, 'the in-flight entry is cleared after opening')
})

test('missing saved binding and invalid URL never choose another account', async () => {
  const f = fixture()
  const open = createHuashengProjectOpener({ ...f.dependencies, connect: async () => assert.fail('must reject before connecting') })
  for (const binding of [{ accountName: null, projectUrl }, { accountName: name, projectUrl: 'https://example.com/video/123' }]) {
    await assert.rejects(open(f.accounts, binding), error => error instanceof SocialUploadAccountError && error.status === 409)
  }
  assert.equal(f.calls.newPage, 0)
})

for (const identityStatus of ['unverified', 'unavailable', 'conflict', 'mismatch'] as const) {
  test(`manual viewing remains available when identity is ${identityStatus}, without pinning or changing UID`, async () => {
    const f = fixture(); f.account.identityStatus = identityStatus
    if (identityStatus === 'unverified') f.account.identity = null
    const uid = f.account.identity?.uid
    assert.equal((await createHuashengProjectOpener(f.dependencies)(f.accounts, { accountName: name, projectUrl })).reused, true)
    assert.equal(f.account.identity?.uid, uid)
    assert.equal(f.calls.front, 1)
  })
}

test('a disconnected managed profile is launched even when login is required', async () => {
  const f = fixture(); let connects = 0, opened = 0
  const failure = new HuashengBrowserError('browser_unavailable', '浏览器未连接'); failure.cause = new Error('ECONNREFUSED')
  const open = createHuashengProjectOpener({ ...f.dependencies,
    connect: async config => { if (++connects === 1) throw failure; return f.dependencies.connect(config) },
    openBrowser: async resolved => { opened++; assert.deepEqual(resolved, config); return { status: 'login_required', message: '请登录' } },
  })
  assert.equal((await open(f.accounts, { accountName: name, projectUrl })).reused, true)
  assert.equal(connects, 2)
  assert.equal(opened, 1)
})

test('history project-home recovery reuses the saved account homepage', async () => {
  const f = fixture(); f.targets[1]!.url = () => 'https://www.huasheng.cn/'
  const result = await createHuashengProjectOpener(f.dependencies)(f.accounts, { accountName: name, projectUrl: null, home: true })
  assert.equal(result.projectUrl, 'https://www.huasheng.cn/')
  assert.equal(result.reused, true)
  assert.match(result.message, /原账号.*主页/)
  assert.deepEqual(f.calls.goto, [])
})

test('a new-tab failure closes only that new tab and preserves existing tabs', async () => {
  const f = fixture(); f.targets.pop()
  f.page.goto = async () => { throw new Error('Page.navigate timed out.') }
  await assert.rejects(createHuashengProjectOpener(f.dependencies)(f.accounts, { accountName: name, projectUrl }), error => error instanceof SocialUploadAccountError && error.status === 503)
  assert.equal(f.calls.closed, 1)
  assert.equal(f.calls.front, 0)
  assert.equal(f.calls.disconnected, 1)
  assert.equal(f.calls.stale, 0)
})

test('a stale existing project tab does not cause a duplicate tab', async () => {
  const f = fixture(); f.targets[1]!.page = async () => { throw new Error('Performance.enable timed out.') }
  await assert.rejects(createHuashengProjectOpener(f.dependencies)(f.accounts, { accountName: name, projectUrl }), /原任务已保留/)
  assert.equal(f.calls.newPage, 0)
  assert.equal(f.calls.closed, 0)
  assert.equal(f.calls.disconnected, 1)
})

test('actual browser connection rejects a different profile before any tab is opened', async t => {
  const f = fixture()
  const session = { send: async () => ({ arguments: ['--user-data-dir=/tmp/other-profile'] }), detach: async () => {} }
  const browser = { ...f.browser, target: () => ({ createCDPSession: async () => session }),
    defaultBrowserContext: () => ({ cookies: async () => [{ domain: '.huasheng.cn', name: 'SESSDATA', value: 'fixture-only' }] }),
    userAgent: async () => 'fixture-agent' }
  t.mock.method(puppeteer, 'connect', async () => browser as any)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('manual viewing must not query the identity API'))
  const open = createHuashengProjectOpener({ ...f.dependencies, connect: undefined })
  await assert.rejects(open(f.accounts, { accountName: name, projectUrl }), error => error instanceof SocialUploadAccountError && /专用浏览器/.test(error.message))
  assert.equal(f.calls.front, 0)
  assert.equal(f.calls.newPage, 0)
  assert.equal(f.calls.disconnected, 1)
  assert.equal(f.account.identity?.uid, '1001')
})

test('actual browser connection opens the original profile without depending on a failing identity API', async t => {
  const f = fixture(); f.account.identity = null; f.account.identityStatus = 'unavailable'
  const session = { send: async () => ({ arguments: [`--user-data-dir=${config.profile}`] }), detach: async () => {} }
  const browser = { ...f.browser, target: () => ({ createCDPSession: async () => session }) }
  t.mock.method(puppeteer, 'connect', async () => browser as any)
  const api = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('identity API unavailable') })
  const result = await createHuashengProjectOpener({ ...f.dependencies, connect: undefined })(f.accounts, { accountName: name, projectUrl })
  assert.equal(result.reused, true)
  assert.equal(f.calls.front, 1)
  assert.equal(api.mock.callCount(), 0)
  assert.equal(f.account.identity, null)
})
