import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { mkdtempSync, realpathSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import puppeteer, { type Browser, type ConnectOptions, type Cookie, type LaunchOptions } from 'puppeteer-core'
import { ChromeLauncher } from 'puppeteer-core/internal/node/ChromeLauncher.js'
import type { PuppeteerNode } from 'puppeteer-core/internal/node/PuppeteerNode.js'

process.env.HISTORY_SOURCE_AUTH_DIR = join(mkdtempSync(join(realpathSync(tmpdir()), 'history-auth-default-isolated-')), 'auth')
process.env.HISTORY_LOGIN_CDP_URL = 'http://127.0.0.1:1'
process.env.HISTORY_LIGHTPANDA_CDP_URL = 'ws://127.0.0.1:1'
const { createHistoryBrowserAuth, HistoryBrowserAuthError } = await import('./history-source-auth.js')

async function authFixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'huobao-history-auth-test-'))
  const profileDirectory = join(directory, 'login-profile')
  const storageDirectory = join(directory, 'session')
  const cookies: Cookie[] = []
  const launches: LaunchOptions[] = []
  const pages: Array<{ url: string; focused: boolean; closed?: boolean }> = []
  let commandLine = [`--user-data-dir=${profileDirectory}`]
  let reads = 0
  let pageLists = 0
  let running = true
  let generation = 0
  let closes = 0
  const clients: EventEmitter[] = []
  const makeBrowser = () => {
    const clientGeneration = generation
    let connected = true
    const events = new EventEmitter()
    clients.push(events)
    return {
    get connected() { return connected && running && clientGeneration === generation },
    once: events.once.bind(events),
    target: () => ({ createCDPSession: async () => ({ send: async () => ({ arguments: commandLine }), detach: async () => {} }) }),
    defaultBrowserContext: () => ({
      cookies: async () => { reads++; return [...cookies] },
      pages: async () => {
        pageLists++
        return pages.filter(page => !page.closed).map(page => ({ url: () => page.url, bringToFront: async () => { page.focused = true } }))
      },
      newPage: async () => {
        const page: typeof pages[number] = { url: '', focused: false }
        pages.push(page)
        return { goto: async (url: string) => { page.url = url }, bringToFront: async () => { page.focused = true }, isClosed: () => !!page.closed }
      },
    }),
    disconnect: async () => { connected = false; events.emit('disconnected') },
    close: async () => { closes++; running = false; clients.forEach(client => client.emit('disconnected')) },
  } as unknown as Browser
  }
  const dependencies = {
    storageDirectory, profileDirectory, endpoint: 'http://127.0.0.1:9241',
    connect: async () => { if (!running) throw new Error('not running'); return makeBrowser() },
    launch: async (options: LaunchOptions) => {
      launches.push(options); running = true; generation++
      commandLine = [`--user-data-dir=${profileDirectory}`, ...(options.headless ? ['--headless=new'] : [])]
      return makeBrowser()
    },
    pollMs: 5,
    shutdownTimeoutMs: 50,
  }
  return {
    directory, storageDirectory, profileDirectory, dependencies, cookies, launches, pages,
    reads: () => reads,
    pageLists: () => pageLists,
    closes: () => closes,
    crash: () => { running = false; clients.forEach(client => client.emit('disconnected')) },
    setCommandLine: (arguments_: string[]) => { commandLine = arguments_ },
  }
}

test('fresh session is login_required and never touches a Chrome profile just to show status', async () => {
  const fixture = await authFixture()
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  assert.deepEqual(await auth.getHistoryBrowserSessionStatus(), {
    status: 'login_required', message: '专用 Chromium 登录状态尚未检测', updatedAt: null,
    checkedAt: null, canCollect: false, checks: [], engine: 'chromium',
  })
  assert.deepEqual(await auth.loadHistoryBrowserSession(), { revision: null, cookies: [] })
  assert.equal(fixture.reads(), 0)
  assert.equal(fixture.launches.length, 0)
})

test('collection gets independent verified CDP clients without borrowing the login connection', async () => {
  const f = await authFixture()
  let connections = 0
  const clients: Browser[] = []
  const auth = createHistoryBrowserAuth({ ...f.dependencies, connect: async () => {
    connections++
    const browser = await f.dependencies.connect()
    const client = { ...browser, connected: true } as Browser
    clients.push(client)
    return client
  } })
  assert.equal(typeof auth.connectHistoryChromiumBrowser, 'function')
  await auth.openHistoryLoginBrowser()
  const first = await auth.connectHistoryChromiumBrowser()
  const second = await auth.connectHistoryChromiumBrowser()
  assert.equal(connections, 5, 'Shutdown probes plus two independent collector clients are expected')
  assert.notEqual(first, second)
  assert.notEqual(first, clients[0])
  assert.equal(f.reads(), 0)
  assert.equal(f.launches.length, 1)
  assert.equal(f.launches[0]!.headless, true)
  f.setCommandLine(['--user-data-dir=/someone/normal-profile'])
  await assert.rejects(auth.connectHistoryChromiumBrowser(), HistoryBrowserAuthError)
})

test('the independently verified collector client allows a 20-second CDP command budget for first navigation', async () => {
  const f = await authFixture()
  let connection: ConnectOptions | undefined
  const auth = createHistoryBrowserAuth({ ...f.dependencies, connect: async options => {
    connection = options
    return f.dependencies.connect()
  } })
  await auth.connectHistoryChromiumBrowser()
  assert.equal(connection?.protocolTimeout, 20_000)
  assert.equal(connection?.browserURL, 'http://127.0.0.1:9241')
  assert.equal(f.launches.length, 1)
  assert.equal(f.launches[0]!.headless, true)
  assert.equal(f.reads(), 0)
})

test('Chromium readiness publishes a cookie-free engine-specific revision and legacy Lightpanda proof cannot grant readiness', async () => {
  const f = await authFixture()
  const auth = createHistoryBrowserAuth(f.dependencies)
  assert.equal(typeof auth.publishHistoryChromiumSession, 'function')
  assert.equal(typeof auth.loadHistoryChromiumSession, 'function')
  assert.deepEqual(await auth.loadHistoryChromiumSession(), { revision: null })
  f.cookies.push(cookie())
  await auth.confirmHistoryBrowserLogin()
  assert.ok((await auth.loadHistoryBrowserSession()).revision)
  const result = await auth.publishHistoryChromiumSession({ message: '同一 Chromium 搜索通过', checks: [] })
  assert.ok(result.revision)
  assert.deepEqual(await auth.loadHistoryChromiumSession(), { revision: result.revision })
  const saved = JSON.parse(await readFile(join(f.storageDirectory, 'session.json'), 'utf8'))
  assert.deepEqual(saved.cookies, [])
  assert.deepEqual(await auth.loadHistoryBrowserSession(), { revision: null, cookies: [] })
  assert.equal(saved.engine, 'chromium')
  const status = await auth.getHistoryBrowserSessionStatus()
  assert.equal(status.engine, 'chromium')
  assert.equal(status.canCollect, true)
  await auth.updateHistoryBrowserReadiness({ status: 'ready', message: '旧 Lightpanda 证明',
    updatedAt: status.updatedAt!, checkedAt: status.checkedAt, revision: result.revision, checks: [] })
  assert.equal((await auth.getHistoryBrowserSessionStatus()).canCollect, false)
  assert.deepEqual(await auth.loadHistoryChromiumSession(), { revision: null })
})

test('readiness preparation reads only dedicated cookies without publishing a revision or launching Chrome', async () => {
  const fixture = await authFixture()
  fixture.cookies.push(cookie())
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  const prepared = await auth.prepareHistoryBrowserSession()
  assert.equal(prepared.source, 'browser')
  assert.equal(prepared.cookies[0]?.name, 'sessionid')
  assert.deepEqual(await auth.loadHistoryBrowserSession(), { revision: null, cookies: [] })
  assert.equal(fixture.launches.length, 0)
  const disconnected = createHistoryBrowserAuth({ ...fixture.dependencies, connect: async () => { throw new Error('not running') } })
  await assert.rejects(disconnected.prepareHistoryBrowserSession(), error => error instanceof HistoryBrowserAuthError && error.code === 'browser')
  assert.equal(fixture.launches.length, 0)
})

test('open focuses only a verified dedicated profile and persists waiting_login without collecting cookies', async () => {
  const fixture = await authFixture()
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  assert.equal((await auth.openHistoryLoginBrowser()).status, 'waiting_login')
  assert.deepEqual(fixture.pages, [{ url: 'https://www.douyin.com/', focused: true }])
  assert.equal(fixture.reads(), 0)
  assert.equal((await createHistoryBrowserAuth(fixture.dependencies).getHistoryBrowserSessionStatus()).status, 'waiting_login')
  const mode = (await stat(join(fixture.storageDirectory, 'session.json'))).mode & 0o777
  assert.equal(mode, 0o600)
  assert.equal((await stat(fixture.storageDirectory)).mode & 0o777, 0o700)
})

test('opening human login creates its own tab instead of adopting an existing task Douyin page', async () => {
  const f = await authFixture()
  f.pages.push({ url: 'https://www.douyin.com/search/task-owned', focused: false })
  const auth = createHistoryBrowserAuth(f.dependencies)
  await auth.openHistoryLoginBrowser()
  assert.equal(f.pages.length, 2)
  assert.equal(f.pages[0]?.focused, false)
  assert.equal(f.pages[1]?.url, 'https://www.douyin.com/')
  assert.equal(f.pages[1]?.focused, true)
  assert.equal(f.pageLists(), 0, 'Human login must not enumerate and borrow task-owned pages')
})

test('repeated human-login opens reuse only the still-open tab owned by this auth instance', async () => {
  const f = await authFixture()
  const auth = createHistoryBrowserAuth(f.dependencies)
  await auth.openHistoryLoginBrowser()
  const loginPage = f.pages[0]!
  loginPage.focused = false
  await auth.openHistoryLoginBrowser()
  assert.equal(f.pages.length, 1)
  assert.equal(loginPage.focused, true)
  assert.equal(f.pageLists(), 0)
})

test('a closed human-login tab is replaced with a new owned tab without borrowing an available task tab', async () => {
  const f = await authFixture()
  const auth = createHistoryBrowserAuth(f.dependencies)
  await auth.openHistoryLoginBrowser()
  f.pages[0]!.closed = true
  f.pages.push({ url: 'https://www.douyin.com/search/task-owned', focused: false })
  await auth.openHistoryLoginBrowser()
  assert.equal(f.pages.length, 3)
  assert.equal(f.pages[1]?.focused, false)
  assert.equal(f.pages[2]?.url, 'https://www.douyin.com/')
  assert.equal(f.pages[2]?.focused, true)
  assert.equal(f.pageLists(), 0)
})

test('unknown profiles at the configured port are rejected before opening pages or reading cookies', async () => {
  const fixture = await authFixture()
  fixture.setCommandLine(['--user-data-dir=/someones/personal/chrome-profile'])
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  await assert.rejects(auth.openHistoryLoginBrowser(), error => {
    assert.ok(error instanceof HistoryBrowserAuthError)
    assert.doesNotMatch(error.message, /someones|personal|chrome-profile/)
    return true
  })
  assert.equal(fixture.reads(), 0)
  assert.equal(fixture.pages.length, 0)
})

function cookie(overrides: Partial<Cookie> = {}): Cookie {
  return { name: 'sessionid', value: 'synthetic-private-session', domain: '.douyin.com', path: '/',
    expires: Date.now() / 1000 + 3600, size: 40, secure: true, httpOnly: true, session: false, ...overrides }
}

test('confirm persists only active unpartitioned Douyin cookies and exposes no cookie values in status', async () => {
  const fixture = await authFixture()
  fixture.cookies.push(cookie(), cookie({ name: 'other', domain: 'evil-douyin.com' }),
    cookie({ name: 'expired', expires: 1 }), cookie({ name: 'partitioned', partitionKey: { sourceOrigin: 'https://douyin.com' } }),
    cookie({ name: 'opaque', partitionKeyOpaque: true }), cookie({ name: 'sessionid_ss', domain: 'www.douyin.com', expires: -1 }))
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  const status = await auth.confirmHistoryBrowserLogin()
  assert.equal(status.status, 'session_saved')
  assert.doesNotMatch(JSON.stringify(status), /synthetic-private-session|sessionid|cookies/)
  const saved = await auth.loadHistoryBrowserSession()
  assert.ok(saved.revision)
  assert.deepEqual(saved.cookies.map(value => value.name), ['sessionid', 'sessionid_ss'])
  assert.deepEqual(await createHistoryBrowserAuth(fixture.dependencies).loadHistoryBrowserSession(), saved)
  assert.equal((await stat(join(fixture.storageDirectory, 'session.json'))).mode & 0o777, 0o600)
})

test('anonymous cookies and expired authentication cannot be confirmed as logged in', async () => {
  const fixture = await authFixture()
  fixture.cookies.push(cookie({ name: 'ttwid' }), cookie({ expires: 1 }))
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  await assert.rejects(auth.confirmHistoryBrowserLogin(), error => error instanceof HistoryBrowserAuthError && /尚未检测/.test(error.message))
  assert.deepEqual(await auth.loadHistoryBrowserSession(), { revision: null, cookies: [] })
})

test('Chromium waiting ignores legacy cookie revisions and requires a fresh same-engine verified revision', async () => {
  const fixture = await authFixture()
  fixture.cookies.push(cookie())
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  await auth.publishHistoryChromiumSession({ message: '初次检测通过', checks: [] })
  const previous = await auth.loadHistoryChromiumSession()
  const controller = new AbortController()
  let completed = false
  const waiting = auth.waitForHistoryBrowserLogin({ afterRevision: previous.revision,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), reason: '登录失效' })
    .then(result => { completed = true; return result })
  void waiting.catch(() => {})
  try {
    const deadline = Date.now() + 4000
    while ((await auth.getHistoryBrowserSessionStatus()).status !== 'waiting_login') {
      if (Date.now() >= deadline) assert.fail('Login wait did not become observable')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(completed, false)
    await auth.confirmHistoryBrowserLogin()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(completed, false, 'Legacy Cookie confirmation must not release a Chromium worker')
    await auth.publishHistoryChromiumSession({ message: '新检测通过', checks: [] })
    const confirmed = await waiting
    assert.notEqual(confirmed.revision, previous.revision)
    await auth.markHistoryBrowserSessionReady(previous.revision!)
    assert.equal((await auth.getHistoryBrowserSessionStatus()).status, 'ready')
    await auth.markHistoryBrowserSessionReady(confirmed.revision)
    const status = await createHistoryBrowserAuth(fixture.dependencies).getHistoryBrowserSessionStatus()
    assert.equal(status.status, 'ready')
    assert.equal(status.canCollect, true)
    assert.equal(JSON.parse(await readFile(join(fixture.storageDirectory, 'session.json'), 'utf8')).status, 'ready')
  } finally {
    controller.abort()
    await waiting.catch(() => {})
  }
})

test('stop immediately cancels login waiting without opening or reading a browser', async () => {
  const fixture = await authFixture()
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  const controller = new AbortController()
  const pending = auth.waitForHistoryBrowserLogin({ afterRevision: null, signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await new Promise(resolve => setTimeout(resolve, 20))
  controller.abort()
  await rejected
  assert.equal(fixture.reads(), 0)
  assert.equal(fixture.launches.length, 0)
})

test('session files and directories cannot redirect secret writes through symlinks', async () => {
  const fixture = await authFixture()
  fixture.cookies.push(cookie())
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  await auth.confirmHistoryBrowserLogin()
  const target = join(fixture.directory, 'untouched.txt')
  await writeFile(target, 'untouched')
  await unlink(join(fixture.storageDirectory, 'session.json'))
  await symlink(target, join(fixture.storageDirectory, 'session.json'))
  await assert.rejects(auth.loadHistoryBrowserSession(), HistoryBrowserAuthError)
  await assert.rejects(auth.confirmHistoryBrowserLogin(), HistoryBrowserAuthError)
  assert.equal(await readFile(target, 'utf8'), 'untouched')
  const second = await authFixture()
  const actual = join(second.directory, 'actual')
  await mkdir(actual)
  await symlink(actual, second.storageDirectory)
  await assert.rejects(createHistoryBrowserAuth(second.dependencies).getHistoryBrowserSessionStatus(), HistoryBrowserAuthError)
})

test('readiness metadata must be safely persisted before publishing a session revision', async () => {
  const fixture = await authFixture()
  fixture.cookies.push(cookie())
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  await auth.confirmHistoryBrowserLogin()
  const previous = await auth.loadHistoryBrowserSession()
  const target = join(fixture.directory, 'untouched-metadata.txt')
  await writeFile(target, 'untouched')
  await symlink(target, join(fixture.storageDirectory, 'readiness.json'))
  await assert.rejects(auth.publishHistoryBrowserSession(fixture.cookies, { message: '检测通过', checks: [] }), HistoryBrowserAuthError)
  assert.deepEqual(await auth.loadHistoryBrowserSession(), previous)
  assert.equal(await readFile(target, 'utf8'), 'untouched')
})

test('dedicated browser launch has a private persistent profile and no stealth or caller-provided arguments', async () => {
  const fixture = await authFixture()
  const auth = createHistoryBrowserAuth({ ...fixture.dependencies, connect: async () => { throw new Error('not running') } })
  assert.equal((await auth.openHistoryLoginBrowser()).status, 'waiting_login')
  assert.equal(fixture.launches.length, 1)
  const launched = fixture.launches[0]!
  assert.equal(launched.userDataDir, fixture.profileDirectory)
  assert.equal(launched.headless, false)
  assert.equal(launched.debuggingPort, 9241)
  assert.equal(launched.ignoreDefaultArgs, undefined)
  const launcher = new ChromeLauncher(puppeteer as unknown as PuppeteerNode)
  const computed = await launcher.computeLaunchArguments(launched as unknown as Parameters<typeof launcher.computeLaunchArguments>[0])
  assert.ok(computed.args.includes('--remote-debugging-port=9241'), 'Real Puppeteer launcher must expose the dedicated CDP port')
  assert.ok(computed.args.includes('--remote-debugging-address=127.0.0.1'))
  assert.ok(computed.args.includes(`--user-data-dir=${fixture.profileDirectory}`))
  assert.ok(!computed.args.some(argument => argument.includes('AutomationControlled') || argument === '--remote-debugging-pipe'))
  assert.equal((await stat(fixture.profileDirectory)).mode & 0o777, 0o700)
})

test('confirm never launches a login window and endpoint errors cannot reveal supplied secrets', async () => {
  const fixture = await authFixture()
  const auth = createHistoryBrowserAuth({ ...fixture.dependencies, connect: async () => { throw new Error('synthetic-secret') } })
  await assert.rejects(auth.confirmHistoryBrowserLogin(), error => error instanceof HistoryBrowserAuthError && !error.message.includes('synthetic-secret'))
  assert.equal(fixture.launches.length, 0)
  for (const endpoint of ['http://example.com:9241', 'http://secret:password@127.0.0.1:9241', 'http://127.0.0.1:9241/?url=https://example.com']) {
    assert.throws(() => createHistoryBrowserAuth({ ...fixture.dependencies, endpoint }), error => error instanceof HistoryBrowserAuthError
      && !/secret|password|example.com/.test(error.message))
  }
})

test('a symlink at the dedicated Chrome profile cannot expose another profile cookies', async () => {
  const fixture = await authFixture()
  const target = join(fixture.directory, 'another-profile')
  await mkdir(target)
  await symlink(target, fixture.profileDirectory)
  const auth = createHistoryBrowserAuth(fixture.dependencies)
  await assert.rejects(auth.confirmHistoryBrowserLogin(), HistoryBrowserAuthError)
  assert.equal(fixture.reads(), 0)
})

test('collection switches only the dedicated browser to silent headless mode and explicit login restores its profile', async () => {
  const f = await authFixture()
  const auth = createHistoryBrowserAuth(f.dependencies)
  await auth.publishHistoryChromiumSession({ message: 'old proof', checks: [] })
  const collector = await auth.connectHistoryChromiumBrowser()
  assert.equal(f.closes(), 1)
  assert.equal(f.launches.length, 1)
  assert.equal(f.launches[0]!.headless, true)
  assert.equal(f.launches[0]!.userDataDir, f.profileDirectory)
  assert.ok(f.launches[0]!.args?.includes('--mute-audio'))
  assert.ok(f.launches[0]!.args?.includes('--window-size=1440,1000'))
  assert.equal(f.pages.length, 0)
  assert.equal((await auth.getHistoryBrowserSessionStatus()).canCollect, false)
  await collector.disconnect()
  await auth.openHistoryLoginBrowser()
  assert.equal(f.closes(), 2)
  assert.equal(f.launches[1]!.headless, false)
  assert.equal(f.launches[1]!.userDataDir, f.profileDirectory)
  assert.equal(f.pages[0]!.focused, true)
})

test('concurrent collector connections share one transition and all client leases protect the browser', async () => {
  const f = await authFixture()
  const auth = createHistoryBrowserAuth(f.dependencies)
  const [first, second] = await Promise.all([auth.connectHistoryChromiumBrowser(), auth.connectHistoryChromiumBrowser()])
  assert.notEqual(first, second)
  assert.equal(f.launches.length, 1)
  await auth.publishHistoryChromiumSession({ message: 'new proof', checks: [] })
  await assert.rejects(auth.openHistoryLoginBrowser(), error => error instanceof HistoryBrowserAuthError && error.code === 'busy')
  assert.equal((await auth.getHistoryBrowserSessionStatus()).canCollect, true, 'Rejected login cannot revoke an active collection proof')
  await first.disconnect()
  await first.disconnect()
  await assert.rejects(auth.openHistoryLoginBrowser(), error => error instanceof HistoryBrowserAuthError && error.code === 'busy')
  assert.equal(f.closes(), 1)
  await second.disconnect()
  await auth.openHistoryLoginBrowser()
  assert.equal(f.closes(), 2)
})

test('browser disconnection releases abandoned leases and the next collection never falls back to visible mode', async () => {
  const f = await authFixture()
  const auth = createHistoryBrowserAuth(f.dependencies)
  await auth.connectHistoryChromiumBrowser()
  f.crash()
  const next = await auth.connectHistoryChromiumBrowser()
  assert.equal(f.launches.length, 2)
  assert.ok(f.launches.every(options => options.headless === true))
  await next.disconnect()
  await auth.openHistoryLoginBrowser()
  assert.equal(f.launches.at(-1)!.headless, false)
})

test('a mismatched endpoint is never closed or replaced even when a headless collector is requested', async () => {
  const f = await authFixture()
  f.setCommandLine(['--user-data-dir=/someones/personal/chrome-profile'])
  const auth = createHistoryBrowserAuth(f.dependencies)
  await assert.rejects(auth.connectHistoryChromiumBrowser(), error => error instanceof HistoryBrowserAuthError && error.code === 'profile')
  assert.equal(f.closes(), 0)
  assert.equal(f.launches.length, 0)
})

test('a browser that keeps its endpoint alive after close cannot cause a duplicate launch', async () => {
  const f = await authFixture()
  const auth = createHistoryBrowserAuth({ ...f.dependencies, shutdownTimeoutMs: 25, connect: async () => {
    const client = await f.dependencies.connect()
    client.close = async () => {}
    return client
  } })
  await assert.rejects(auth.connectHistoryChromiumBrowser(), HistoryBrowserAuthError)
  assert.equal(f.launches.length, 0)
})

test('shutdown waits for both the endpoint and SingletonLock before reusing the profile', async () => {
  const f = await authFixture()
  await mkdir(f.profileDirectory)
  const lock = join(f.profileDirectory, 'SingletonLock')
  await symlink('synthetic-process-1234', lock)
  let lockReleased = false
  const auth = createHistoryBrowserAuth({ ...f.dependencies, shutdownTimeoutMs: 250, connect: async () => {
    const client = await f.dependencies.connect()
    const close = client.close.bind(client)
    client.close = async () => {
      await close()
      setTimeout(() => { void unlink(lock).then(() => { lockReleased = true }) }, 25)
    }
    return client
  }, launch: async options => {
    assert.equal(lockReleased, true)
    return f.dependencies.launch(options)
  } })
  const client = await auth.connectHistoryChromiumBrowser()
  await client.disconnect()
  assert.equal(f.launches.length, 1)
})

test('a lingering profile lock blocks launch even when the CDP endpoint has disappeared', async () => {
  const f = await authFixture()
  await mkdir(f.profileDirectory)
  await symlink('synthetic-process-1234', join(f.profileDirectory, 'SingletonLock'))
  const auth = createHistoryBrowserAuth({ ...f.dependencies, shutdownTimeoutMs: 20 })
  await assert.rejects(auth.connectHistoryChromiumBrowser(), HistoryBrowserAuthError)
  assert.equal(f.launches.length, 0)
})

test('a local dead process lock lets Chromium recover its own profile after a crash', async () => {
  const f = await authFixture()
  f.crash()
  await mkdir(f.profileDirectory, { recursive: true })
  const exited = spawnSync(process.execPath, ['-e', ''])
  assert.equal(exited.status, 0)
  await symlink(`${hostname()}-${exited.pid}`, join(f.profileDirectory, 'SingletonLock'))
  const auth = createHistoryBrowserAuth(f.dependencies)
  const client = await auth.connectHistoryChromiumBrowser()
  assert.equal(f.launches.length, 1)
  assert.equal(f.launches[0]!.headless, true)
  assert.equal((await stat(f.profileDirectory)).isDirectory(), true)
  await client.disconnect()
})

test('a live process or foreign-host profile lock cannot authorize a launch', async () => {
  for (const owner of [`${hostname()}-${process.pid}`, `another-host-${process.pid}`]) {
    const f = await authFixture()
    f.crash()
    await mkdir(f.profileDirectory, { recursive: true })
    await symlink(owner, join(f.profileDirectory, 'SingletonLock'))
    const auth = createHistoryBrowserAuth({ ...f.dependencies, shutdownTimeoutMs: 20 })
    await assert.rejects(auth.connectHistoryChromiumBrowser(), HistoryBrowserAuthError)
    assert.equal(f.launches.length, 0)
  }
})

test('login racing a pending collector connection cannot close the browser before its lease is registered', async () => {
  const f = await authFixture()
  let release: (() => void) | undefined
  const auth = createHistoryBrowserAuth({ ...f.dependencies, connect: async options => {
    const client = await f.dependencies.connect()
    if (options.protocolTimeout === 20_000) await new Promise<void>(resolve => { release = resolve })
    return client
  } })
  const connecting = auth.connectHistoryChromiumBrowser()
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  const opening = auth.openHistoryLoginBrowser()
  release()
  const client = await connecting
  await assert.rejects(opening, error => error instanceof HistoryBrowserAuthError && error.code === 'busy')
  assert.equal(f.closes(), 1)
  assert.equal(f.pages.length, 0)
  await client.disconnect()
})

test('an explicit login open revokes ready proof even when the browser was already visible', async () => {
  const f = await authFixture()
  const auth = createHistoryBrowserAuth(f.dependencies)
  await auth.publishHistoryChromiumSession({ message: 'prior proof', checks: [] })
  assert.equal((await auth.getHistoryBrowserSessionStatus()).canCollect, true)
  assert.equal((await auth.openHistoryLoginBrowser()).canCollect, false)
  assert.deepEqual(await auth.loadHistoryChromiumSession(), { revision: null })
  assert.equal(f.closes(), 0)
})

test('shutdown failure revokes prior proof without launching a replacement or falling back to visible Chrome', async () => {
  const f = await authFixture()
  const auth = createHistoryBrowserAuth({ ...f.dependencies, shutdownTimeoutMs: 20, connect: async () => {
    const client = await f.dependencies.connect()
    client.close = async () => new Promise(() => {})
    return client
  } })
  await auth.publishHistoryChromiumSession({ message: 'prior proof', checks: [] })
  await assert.rejects(auth.connectHistoryChromiumBrowser(), HistoryBrowserAuthError)
  assert.equal((await auth.getHistoryBrowserSessionStatus()).canCollect, false)
  assert.equal(f.launches.length, 0)
})

test('a failed background launch never retries as visible Chrome', async () => {
  const f = await authFixture()
  f.crash()
  const launches: LaunchOptions[] = []
  const auth = createHistoryBrowserAuth({ ...f.dependencies, launch: async options => {
    launches.push(options)
    throw new Error('synthetic launch failure')
  } })
  await assert.rejects(auth.connectHistoryChromiumBrowser(), HistoryBrowserAuthError)
  assert.equal(launches.length, 1)
  assert.equal(launches[0]!.headless, true)
})

test('profile identity is rechecked immediately before close after readiness invalidation', async () => {
  const f = await authFixture()
  let verifications = 0
  const auth = createHistoryBrowserAuth({ ...f.dependencies, connect: async () => {
    const client = await f.dependencies.connect()
    const target = client.target.bind(client)
    client.target = () => {
      verifications++
      if (verifications > 1) f.setCommandLine(['--user-data-dir=/someone/personal'])
      return target()
    }
    return client
  } })
  await assert.rejects(auth.connectHistoryChromiumBrowser(), error => error instanceof HistoryBrowserAuthError && error.code === 'profile')
  assert.equal(f.closes(), 0)
  assert.equal(f.launches.length, 0)
})

test('a shutdown probe that times out cannot authorize launch and its late client is disconnected', async () => {
  const f = await authFixture()
  let release: ((client: Browser) => void) | undefined
  const auth = createHistoryBrowserAuth({ ...f.dependencies, shutdownTimeoutMs: 20, connect: async options => {
    if (options.protocolTimeout !== undefined && options.protocolTimeout < 1000) return new Promise<Browser>(resolve => { release = resolve })
    return f.dependencies.connect()
  } })
  await assert.rejects(auth.connectHistoryChromiumBrowser(), HistoryBrowserAuthError)
  assert.equal(f.launches.length, 0)
  assert.ok(release)
  let disconnected = false
  release({ disconnect: async () => { disconnected = true } } as unknown as Browser)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disconnected, true)
})
