import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import { connectHuashengBrowser, createHuashengTemporaryPage, getHuashengBrowserStatus, HuashengBrowserError, runHuashengBrowserJob } from './history-huasheng-browser.js'

const config = { endpoint: 'http://127.0.0.1:9250', profile: '/tmp/huasheng-connection-fixture' }
function fixture() {
  const calls = { disconnected: 0, allPages: 0, stalePage: 0, homepage: 0 }
  const session = { send: async () => ({ arguments: [`--user-data-dir=${config.profile}`] }), detach: async () => {} }
  const page = { url: () => 'https://www.huasheng.cn/', evaluate: async () => ({ loggedIn: true, loginRequired: false }) }
  const browser = {
    target: () => ({ createCDPSession: async () => session }),
    disconnect: async () => { calls.disconnected++ },
    pages: async () => { calls.allPages++; throw new Error('Performance.enable timed out.') },
    targets: () => [
      { type: () => 'page', url: () => 'https://www.huasheng.cn/video/123', page: async () => { calls.stalePage++; throw new Error('Performance.enable timed out.') } },
      { type: () => 'page', url: page.url, page: async () => { calls.homepage++; return page } },
    ],
  }
  return { browser, calls }
}

test('login inspection does not initialize every retained project tab', async t => {
  const f = fixture()
  t.mock.method(puppeteer, 'connect', async () => f.browser as any)
  assert.equal((await getHuashengBrowserStatus(config)).status, 'ready')
  assert.equal(f.calls.allPages, 0)
  assert.equal(f.calls.stalePage, 0)
  assert.equal(f.calls.homepage, 1)
  assert.equal(f.calls.disconnected, 1)
})

test('a transient CDP connection failure retries once and still verifies the dedicated profile', async t => {
  const f = fixture()
  let connects = 0
  t.mock.method(puppeteer, 'connect', async () => {
    if (++connects === 1) throw new Error('Target.setAutoAttach timed out.')
    return f.browser as any
  })
  const browser = await connectHuashengBrowser(config)
  assert.equal(browser, f.browser)
  assert.equal(connects, 2)
  await browser.disconnect()
})

test('exhausted connection failures are bounded, friendly and safe to retry', async t => {
  let connects = 0
  t.mock.method(puppeteer, 'connect', async () => { connects++; throw new Error('Target.setAutoAttach timed out.') })
  await assert.rejects(connectHuashengBrowser(config), (error: unknown) => {
    assert.ok(error instanceof HuashengBrowserError)
    assert.equal(error.retryable, true)
    assert.match(error.message, /尚未开始本次页面操作/)
    assert.doesNotMatch(error.message, /Target\.|protocolTimeout/)
    return true
  })
  assert.equal(connects, 2)
})

test('a wrong dedicated profile is never retried or reported as a transient failure', async t => {
  const f = fixture()
  let connects = 0
  t.mock.method(puppeteer, 'connect', async () => { connects++; return f.browser as any })
  await assert.rejects(connectHuashengBrowser({ ...config, profile: '/tmp/different-account' }), (error: unknown) => {
    assert.ok(error instanceof HuashengBrowserError)
    assert.equal(error.retryable, undefined)
    assert.match(error.message, /专用浏览器/)
    return true
  })
  assert.equal(connects, 1)
  assert.equal(f.calls.disconnected, 1)
})

test('cancellation interrupts connecting and detaches a browser that arrives late', async t => {
  const f = fixture(), controller = new AbortController()
  let complete!: (browser: any) => void
  let connects = 0
  t.mock.method(puppeteer, 'connect', () => { connects++; return new Promise(resolve => { complete = resolve }) as any })
  const pending = connectHuashengBrowser(config, controller.signal)
  controller.abort()
  await assert.rejects(pending, error => (error as Error).name === 'AbortError')
  complete(f.browser)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(connects, 1)
  assert.equal(f.calls.disconnected, 1)
})

test('a transient selected-page initialization failure reconnects without touching unrelated tabs', async t => {
  const f = fixture()
  let connects = 0
  const targets = f.browser.targets()
  const good = targets[1]!.page
  targets[1]!.page = async () => {
    if (connects === 1) throw new Error('Performance.enable timed out.')
    return good()
  }
  f.browser.targets = () => targets
  t.mock.method(puppeteer, 'connect', async () => { connects++; return f.browser as any })
  assert.equal((await getHuashengBrowserStatus(config)).status, 'ready')
  assert.equal(connects, 2)
  assert.equal(f.calls.disconnected, 2)
  assert.equal(f.calls.allPages, 0)
  assert.equal(f.calls.stalePage, 0)
})

function failedPageFixture() {
  const closed: string[] = []
  let detached = 0
  const session = {
    send: async (method: string, params: { targetId?: string }) => {
      if (method === 'Target.createTarget') return { targetId: 'this-attempt-only' }
      assert.equal(method, 'Target.closeTarget'); closed.push(params.targetId!); return { success: true }
    },
    detach: async () => { detached++ },
  }
  const target = { page: async (): Promise<any> => { throw new Error('Performance.enable timed out.') } }
  const browser = {
    target: () => ({ createCDPSession: async () => session }),
    waitForTarget: async () => target,
    close: async () => assert.fail('must not close the browser'),
    pages: async () => assert.fail('must not enumerate/close user pages'),
  }
  return { browser, target, closed, detached: () => detached }
}

test('failed new-page initialization closes only its acknowledged temporary target', async () => {
  const f = failedPageFixture()
  await assert.rejects(createHuashengTemporaryPage(f.browser as any), /Performance.enable/)
  assert.deepEqual(f.closed, ['this-attempt-only'])
  assert.equal(f.detached(), 1)
})

test('a create timeout recovers only its exact marked target without initializing any page', async () => {
  let marker = ''
  const closed: string[] = []
  const session = { send: async (method: string, params: { url?: string; targetId?: string }) => {
    if (method === 'Target.createTarget') { marker = params.url!; throw new Error('Target.createTarget timed out.') }
    if (method === 'Target.getTargets') return { targetInfos: [
      { type: 'page', url: 'about:blank', targetId: 'user-blank' },
      { type: 'page', url: 'about:blank#huobao-huasheng-another-operation', targetId: 'concurrent' },
      { type: 'page', url: 'https://www.huasheng.cn/video/123', targetId: 'project' },
      { type: 'page', url: marker, targetId: 'unacknowledged' },
    ] }
    assert.equal(method, 'Target.closeTarget'); closed.push(params.targetId!); return { success: true }
  }, detach: async () => {} }
  const browser = { target: () => ({ createCDPSession: async () => session }),
    waitForTarget: async () => assert.fail('cannot initialize a page after a rejected creation') }
  await assert.rejects(createHuashengTemporaryPage(browser as any), /Target.createTarget timed out/)
  assert.deepEqual(closed, ['unacknowledged'])
})

test('a delayed target from a timed-out create is discovered on the next cleanup session', async () => {
  let marker = '', reads = 0
  const closed: string[] = []
  const session = { send: async (method: string, params: { url?: string; targetId?: string }) => {
    if (method === 'Target.createTarget') { marker = params.url!; throw new Error('Target.createTarget timed out.') }
    if (method === 'Target.getTargets') return { targetInfos: ++reads < 3 ? [] : [{ type: 'page', targetId: 'delayed-only', url: marker }] }
    assert.equal(method, 'Target.closeTarget'); closed.push(params.targetId!); return { success: true }
  }, detach: async () => {} }
  const browser = { target: () => ({ createCDPSession: async () => session }) }
  await assert.rejects(createHuashengTemporaryPage(browser as any), /Target.createTarget timed out/)
  assert.deepEqual(closed, ['delayed-only'])
})

test('unavailable target metadata cannot be reported as successful cleanup', async t => {
  let warnings = 0
  t.mock.method(console, 'warn', () => { warnings++ })
  const session = { send: async (method: string) => { throw new Error(`${method} timed out.`) }, detach: async () => {} }
  const browser = { target: () => ({ createCDPSession: async () => session }) }
  await assert.rejects(createHuashengTemporaryPage(browser as any), /Target.createTarget timed out/)
  assert.equal(warnings, 1, 'a failed metadata request is not evidence that the tab was closed')
})

for (const closeFailure of ['throws', 'false']) test(`failed cleanup ${closeFailure} retries its owned target through a fresh session`, async () => {
  const closed: string[] = [], detached: number[] = []
  let sessions = 0
  const browser = { target: () => ({ createCDPSession: async () => {
    const index = ++sessions
    return { send: async (method: string, params: { targetId?: string }) => {
      if (method === 'Target.createTarget') return { targetId: 'owned-only' }
      assert.equal(method, 'Target.closeTarget'); assert.equal(params.targetId, 'owned-only')
      if (index === 1) {
        if (closeFailure === 'throws') throw new Error('Session closed')
        return { success: false }
      }
      closed.push(params.targetId!); return { success: true }
    }, detach: async () => { detached.push(index) } }
  } }), waitForTarget: async () => ({ page: async () => { throw new Error('Page.enable timed out.') } }) }
  await assert.rejects(createHuashengTemporaryPage(browser as any), /Page.enable timed out/)
  assert.deepEqual(closed, ['owned-only'])
  assert.deepEqual(detached.sort(), [1, 2])
})

test('a successfully initialized temporary page can be closed by its owned target even when Page.close stalls', async () => {
  const closed: string[] = []
  const page = { close: async () => assert.fail('cleanup must not depend on the broken renderer') }
  const session = { send: async (method: string, params: { targetId?: string; background?: boolean }) => {
    if (method === 'Target.createTarget') { assert.equal(params.background, true); return { targetId: 'owned-success' } }
    assert.equal(method, 'Target.closeTarget'); closed.push(params.targetId!); return { success: true }
  }, detach: async () => {} }
  const browser = { target: () => ({ createCDPSession: async () => session }), waitForTarget: async () => ({ page: async () => page }) }
  const created = await createHuashengTemporaryPage(browser as any)
  const { closeHuashengTemporaryPage } = await import('./history-huasheng-browser.js')
  assert.equal(await closeHuashengTemporaryPage(browser as any, created), true)
  assert.deepEqual(closed, ['owned-success'])
  assert.equal(await closeHuashengTemporaryPage(browser as any, created), true)
  assert.deepEqual(closed, ['owned-success'], 'abort and finally share one successful cleanup')
})

test('export navigation failure closes its temporary target and retains the real initialization cause', async t => {
  const { readHuashengExportSession } = await import('./history-huasheng-export-api.js')
  const closed: string[] = []
  let disconnected = 0
  const session = { send: async (method: string, params: { targetId?: string }) => {
    if (method === 'Browser.getBrowserCommandLine') return { arguments: [`--user-data-dir=${config.profile}`] }
    if (method === 'Target.createTarget') return { targetId: 'export-owned-only' }
    assert.equal(method, 'Target.closeTarget'); closed.push(params.targetId!); return { success: true }
  }, detach: async () => {} }
  const page = { on: () => {}, goto: async () => { throw new Error('Page.navigate timed out.') }, close: async () => assert.fail('renderer cleanup cannot be required') }
  const browser = { target: () => ({ createCDPSession: async () => session }), waitForTarget: async () => ({ page: async () => page }),
    disconnect: async () => { disconnected++ } }
  t.mock.method(puppeteer, 'connect', async () => browser as any)
  await assert.rejects(readHuashengExportSession({ projectUrl: 'https://www.huasheng.cn/video/123', browserConfig: config, signal: new AbortController().signal }), error => {
    assert.equal((error as { code: string }).code, 'retryable')
    assert.match(String((error as Error).cause), /Page.navigate timed out/)
    return true
  })
  assert.deepEqual(closed, ['export-owned-only'])
  assert.equal(disconnected, 1)
})

test('canceling new-page initialization cleans the owned target without waiting for the stalled page', async () => {
  const f = failedPageFixture(), controller = new AbortController()
  f.target.page = async () => { controller.abort(); return new Promise(() => {}) }
  await assert.rejects(createHuashengTemporaryPage(f.browser as any, controller.signal), error => (error as Error).name === 'AbortError')
  assert.deepEqual(f.closed, ['this-attempt-only'])
  assert.equal(f.detached(), 1)
})

test('canceling a create-target request waits for its late ID and cleans only that target', async () => {
  const controller = new AbortController(), closed: string[] = []
  let finish!: (value: { targetId: string }) => void
  let detached = false
  const session = {
    send: async (method: string, params: { targetId?: string }) => {
      if (method === 'Target.createTarget') {
        controller.abort()
        return new Promise(resolve => { finish = resolve })
      }
      assert.equal(method, 'Target.closeTarget')
      assert.equal(detached, false, 'cleanup must happen before detaching the only owned session')
      closed.push(params.targetId!)
      return { success: true }
    },
    detach: async () => { detached = true },
  }
  const browser = { target: () => ({ createCDPSession: async () => session }), waitForTarget: async () => assert.fail('cancelled work must not initialize a page') }
  const work = createHuashengTemporaryPage(browser as any, controller.signal)
  const rejected = assert.rejects(work, error => (error as Error).name === 'AbortError')
  await new Promise(resolve => setImmediate(resolve))
  finish({ targetId: 'late-owned-target' })
  await rejected
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(closed, ['late-owned-target'])
  assert.equal(detached, true)
})

const executablePath = process.env.HUASHENG_TEST_CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome')
test('local Chromium creates owned temporary pages and never retries after the creation action begins',
  { skip: !fs.existsSync(executablePath), timeout: 20_000 }, async t => {
    const profile = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'huasheng-preparation-')))
    const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, args: ['--remote-debugging-port=0'] })
    const controller = new AbortController()
    const watchdog = setTimeout(() => controller.abort(new Error('fixture deadline exceeded')), 12_000)
    try {
      const page = (await browser.pages())[0]!
      const temporary = await createHuashengTemporaryPage(browser, controller.signal)
      assert.match(temporary.url(), /^about:blank#huobao-huasheng-/)
      await temporary.close()
      assert.equal(page.isClosed(), false)
      await page.setRequestInterception(true)
      page.on('request', request => { void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body:
        '<header>我的会员</header><textarea></textarea><button>创建</button><script>window.created=0;document.querySelector("button").onclick=()=>{window.created++;window.creationStarted()}</script>' }) })
      await page.exposeFunction('creationStarted', () => controller.abort())
      await page.goto('https://www.huasheng.cn/')
      await page.evaluate('window.name="huobao-huasheng:connection-replay-fixture"')
      let connects = 0
      const connect = puppeteer.connect.bind(puppeteer)
      t.mock.method(puppeteer, 'connect', async (options: Parameters<typeof puppeteer.connect>[0]) => { connects++; return connect(options) })
      const checkpoints: string[] = []
      await assert.rejects(runHuashengBrowserJob({
        browserConfig: { endpoint: `http://127.0.0.1:${new URL(browser.wsEndpoint()).port}`, profile },
        jobId: 'connection-replay-fixture', script: '这是用于本地连接恢复测试的完整科普文稿。', projectUrl: null, checkpoint: 'opening',
        signal: controller.signal, onCheckpoint: async update => { checkpoints.push(update.checkpoint) },
      }), error => (error as Error).name === 'AbortError')
      assert.equal(await page.evaluate('window.created'), 1)
      assert.equal(connects, 2, 'only login inspection and pre-action preparation connect; drive failures never replay')
      assert.deepEqual(checkpoints, ['create_pending'])
      assert.equal(page.isClosed(), false, 'preserve the task page after its first action')
    } finally {
      clearTimeout(watchdog)
      await browser.close()
      fs.rmSync(profile, { recursive: true, force: true })
    }
  })
