import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { createChromiumCommandRunner as createRunner } from './history-source-chromium.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}

function transportFixture(options: {
  hangEvaluation?: boolean
  hangClose?: boolean
  failNavigation?: boolean
  failEvaluation?: string
  evaluationFailures?: string[]
  navigationFailures?: string[]
  delayPage?: (page: Page) => Promise<Page>
  requireActive?: boolean
  nativeShortcuts?: boolean
  userAgent?: string
  failUserAgentSetup?: boolean
} = {}) {
  const pages: Array<{ closed: boolean; url: string; modifiers: string[]; nativeTexts: string[]; reads: number; navigations: number; userAgent?: string; navigationUserAgent?: string }> = [
    { closed: false, url: 'https://www.douyin.com/login', modifiers: [], nativeTexts: [], reads: 0, navigations: 0 },
  ]
  const clients: Array<{ disconnected: boolean }> = []
  let front = pages[0]!
  const forbidden = () => { throw new Error('Shared browser/context/cookies must not be changed') }
  const context = {
    close: forbidden,
    cookies: forbidden,
    setCookie: forbidden,
    deleteCookie: forbidden,
    newPage: async () => {
      const state: typeof pages[number] = { closed: false, url: '', modifiers: [], nativeTexts: [], reads: 0, navigations: 0 }
      pages.push(state)
      front = state
      let value = ''
      let modifier = false
      let selected = false
      let submitted = false
      let clicked = ''
      const page = {
        setUserAgent: async (agent: string) => {
          if (options.failUserAgentSetup) throw new Error('synthetic setup failure')
          state.userAgent = agent
        },
        goto: async (url: string) => {
          state.navigations++
          state.navigationUserAgent = state.userAgent
          const failure = options.navigationFailures?.shift()
          if (failure) throw new Error(failure)
          if (options.failNavigation) throw new Error('Navigation secret:private')
          state.url = url
        },
        evaluate: async (source: unknown, amount?: number) => {
          state.reads++
          const failure = options.evaluationFailures?.shift() || options.failEvaluation
          if (failure) throw new Error(failure)
          return options.hangEvaluation ? new Promise(() => {})
          : source === 'location.href' ? state.url
            : source === 'formState' ? { value, submitted, clicked }
              : typeof source === 'function' ? { target: 'element', before: 0, after: amount }
                : { ok: true }
        },
        bringToFront: async () => { front = state },
        focus: async (_selector: string) => {
          if (options.requireActive && front !== state) throw new Error('Cannot focus a background task tab')
        },
        type: async (_selector: string, text: string) => { value += text },
        click: async (selector: string) => { clicked = selector },
        keyboard: {
          sendCharacter: async (text: string) => { value += text; state.nativeTexts.push(text) },
          down: async (key: string) => { modifier = true; state.modifiers.push(key) },
          up: async (_key: string) => { modifier = false },
          press: async (key: string, pressOptions?: { commands?: string[] }) => {
            if (key === 'a' && modifier && (options.nativeShortcuts !== false || pressOptions?.commands?.includes('selectAll'))) selected = true
            if (key === 'Backspace') { value = selected ? '' : value.slice(0, -1); selected = false }
            if (key === 'Enter') submitted = true
          },
        },
        close: async () => { state.closed = true; if (options.hangClose) await new Promise(() => {}) },
      } as unknown as Page
      return options.delayPage ? options.delayPage(page) : page
    },
  }
  const connect = async () => {
    const state = { disconnected: false }
    clients.push(state)
    return {
      userAgent: async () => options.userAgent || 'Mozilla/5.0 TestPlatform HeadlessChrome/155.0.0.0 Safari/537.36',
      defaultBrowserContext: () => context,
      createBrowserContext: forbidden,
      pages: forbidden,
      close: forbidden,
      disconnect: async () => { state.disconnected = true },
    } as unknown as Browser
  }
  return { connect, pages, clients, front: () => front, activateUserTab: () => { front = pages[0]! } }
}

test('each owned page uses the installed Chrome user agent before its first request', async () => {
  const transport = transportFixture({ userAgent: 'Mozilla/5.0 ActualPlatform HeadlessChrome/156.0.0.0 Safari/537.36' })
  const run = createRunner({ connect: transport.connect })
  try {
    await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
    await run(['browser', 'task', 'tab', 'new', 'https://www.douyin.com/video/123'])
    for (const page of transport.pages.slice(1)) {
      assert.equal(page.navigationUserAgent, 'Mozilla/5.0 ActualPlatform Chrome/156.0.0.0 Safari/537.36')
    }
    assert.equal(transport.pages[0]!.userAgent, undefined, 'manual login pages are not modified')
  } finally { await run(['browser', 'task', 'close']) }
})

test('failed page configuration closes the owned tab without making a request', async () => {
  const transport = transportFixture({ failUserAgentSetup: true })
  const run = createRunner({ connect: transport.connect })
  await assert.rejects(run(['browser', 'task', 'open', 'https://www.douyin.com/']))
  assert.equal(transport.pages[1]!.navigations, 0)
  assert.equal(transport.pages[1]!.closed, true)
  assert.equal(transport.pages[0]!.closed, false)
  assert.equal(transport.clients[0]!.disconnected, true)
})

test('sessions share the persistent profile but closing one preserves user tabs and the other session', async () => {
  const transport = transportFixture()
  const run = createRunner({ connect: transport.connect, loadSession: async () => ({ revision: 'checked' }) })
  const first = JSON.parse(await run(['browser', 'first', 'open', 'https://www.douyin.com/']))
  const second = JSON.parse(await run(['browser', 'second', 'open', 'https://www.douyin.com/video/123']))
  assert.notEqual(first.page, second.page)
  await run(['browser', 'first', 'close'])
  assert.equal(transport.pages[0]!.closed, false, 'the user login tab survives')
  assert.equal(transport.pages[1]!.closed, true)
  assert.equal(transport.pages[2]!.closed, false)
  assert.equal(transport.clients[0]!.disconnected, true)
  assert.equal(transport.clients[1]!.disconnected, false)
  assert.equal(await run(['browser', 'second', 'eval', 'location.href']), '"https://www.douyin.com/video/123"')
  await run(['browser', 'second', 'close'])
  assert.equal(transport.pages[0]!.closed, false)
  assert.ok(transport.clients.every(client => client.disconnected))
})

test('auth commands read current published revisions without connecting or touching cookies', async () => {
  const transport = transportFixture()
  let revision: string | null = 'first'
  const run = createRunner({ connect: transport.connect, loadSession: async () => ({ revision }) })
  assert.deepEqual(JSON.parse(await run(['browser', 'task', 'auth', 'status'])), { revision: 'first' })
  revision = 'second'
  assert.deepEqual(JSON.parse(await run(['browser', 'task', 'auth', 'refresh'])), { revision: 'second' })
  revision = null
  assert.deepEqual(JSON.parse(await run(['browser', 'task', 'auth', 'status'])), { revision: null })
  await assert.rejects(run(['browser', 'task', 'auth', 'refresh']), /尚未检测通过/)
  assert.equal(transport.clients.length, 0)
})

test('search controls preserve Chromium platform modifiers while replacing text and submitting', async () => {
  const transport = transportFixture()
  const run = createRunner({ connect: transport.connect, loadSession: async () => ({ revision: null }) })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  await run(['browser', 'task', 'type', '#q', 'old query'])
  await run(['browser', 'task', 'focus', '#q'])
  await run(['browser', 'task', 'keys', 'Meta+a'])
  await run(['browser', 'task', 'keys', 'Backspace'])
  await run(['browser', 'task', 'type', '#q', '历史冷知识'])
  await run(['browser', 'task', 'keys', 'Control+a'])
  await run(['browser', 'task', 'keys', 'Backspace'])
  await run(['browser', 'task', 'type', '#q', '历史趣闻'])
  await run(['browser', 'task', 'keys', 'Enter'])
  await run(['browser', 'task', 'click', '[data-key="video"]'])
  assert.deepEqual(JSON.parse(await run(['browser', 'task', 'eval', 'formState'])), {
    value: '历史趣闻', submitted: true, clicked: '[data-key="video"]',
  })
  assert.deepEqual(transport.pages[1]!.modifiers, ['Meta', 'Control'])
  assert.deepEqual(JSON.parse(await run(['browser', 'task', 'scroll', 'down', '--amount', '700'])), {
    target: 'element', before: 0, after: 700,
  })
  await run(['browser', 'task', 'close'])
})

test('tab selection and input physically activate only the target session owned tab', async () => {
  const transport = transportFixture({ requireActive: true })
  const run = createRunner({ connect: transport.connect })
  const first = JSON.parse(await run(['browser', 'first', 'open', 'https://example.test/first']))
  await run(['browser', 'second', 'open', 'https://example.test/second'])
  await run(['browser', 'first', 'focus', '#q'])
  assert.equal(transport.front(), transport.pages[1])
  transport.activateUserTab()
  await run(['browser', 'first', 'type', '#q', 'query'])
  assert.equal(transport.front(), transport.pages[1])
  await run(['browser', 'first', 'tab', 'select', first.page])
  assert.equal(transport.front(), transport.pages[1])
  await run(['browser', 'first', 'close'])
  await run(['browser', 'second', 'close'])
  assert.equal(transport.pages[0]!.closed, false)
})

test('Chinese search input uses one native text insertion rather than per-character key events', async () => {
  const transport = transportFixture({ requireActive: true })
  const run = createRunner({ connect: transport.connect })
  try {
    await run(['browser', 'task', 'open', 'https://example.test/'])
    transport.activateUserTab()
    await run(['browser', 'task', 'type', '#q', '历史 冷知识 123'])
    assert.deepEqual(transport.pages[1]!.nativeTexts, ['历史 冷知识 123'])
    assert.equal(JSON.parse(await run(['browser', 'task', 'eval', 'formState'])).value, '历史 冷知识 123')
    assert.equal(transport.front(), transport.pages[1])
  } finally { await run(['browser', 'task', 'close']) }
})

test('select-all explicitly sends the Chromium editing command when native shortcuts are unavailable', async () => {
  const transport = transportFixture({ nativeShortcuts: false })
  const run = createRunner({ connect: transport.connect })
  await run(['browser', 'task', 'open', 'https://example.test/'])
  await run(['browser', 'task', 'type', '#q', 'previous'])
  await run(['browser', 'task', 'keys', 'Meta+a'])
  await run(['browser', 'task', 'keys', 'Backspace'])
  await run(['browser', 'task', 'type', '#q', 'history'])
  assert.equal(JSON.parse(await run(['browser', 'task', 'eval', 'formState'])).value, 'history')
  await run(['browser', 'task', 'close'])
})

test('detail tabs preserve the search tab and cannot select user-owned tabs', async () => {
  const transport = transportFixture()
  const run = createRunner({ connect: transport.connect })
  const search = JSON.parse(await run(['browser', 'task', 'open', 'https://www.douyin.com/search/history']))
  const detail = JSON.parse(await run(['browser', 'task', 'tab', 'new', 'https://www.douyin.com/video/123']))
  await run(['browser', 'task', 'tab', 'select', search.page])
  assert.equal(await run(['browser', 'task', 'eval', 'location.href']), '"https://www.douyin.com/search/history"')
  await run(['browser', 'task', 'tab', 'close', detail.page])
  assert.equal(transport.pages[2]!.closed, true)
  assert.equal(transport.pages[1]!.closed, false)
  await assert.rejects(run(['browser', 'task', 'tab', 'select', 'user-login-tab']), /owned task page/)
  assert.equal(transport.pages[0]!.closed, false)
})

test('abort interrupts hung evaluation and bounded cleanup only closes owned tabs', async () => {
  const transport = transportFixture({ hangEvaluation: true, hangClose: true })
  const run = createRunner({ connect: transport.connect, cleanupTimeoutMs: 15 })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  const controller = new AbortController()
  const pending = run(['browser', 'task', 'eval', 'longRunning()'], controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await rejected
  assert.equal(transport.pages[0]!.closed, false)
  assert.equal(transport.pages[1]!.closed, true)
  assert.equal(transport.clients[0]!.disconnected, true)
})

test('aborting a pending connection disconnects its late client without opening a tab', async () => {
  const transport = transportFixture()
  const connection = deferred<Browser>()
  const run = createRunner({ connect: () => connection.promise })
  const controller = new AbortController()
  const rejected = assert.rejects(run(['browser', 'task', 'open', 'https://www.douyin.com/'], controller.signal), { name: 'AbortError' })
  controller.abort()
  await rejected
  connection.resolve(await transport.connect())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transport.pages.length, 1)
  assert.equal(transport.clients[0]!.disconnected, true)
})

test('a tab created after abort is closed without navigating or touching the login tab', async () => {
  const creation = deferred<Page>()
  let latePage!: Page
  const transport = transportFixture({ delayPage: page => { latePage = page; return creation.promise } })
  const run = createRunner({ connect: transport.connect })
  const controller = new AbortController()
  const rejected = assert.rejects(run(['browser', 'task', 'open', 'https://www.douyin.com/'], controller.signal), { name: 'AbortError' })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await rejected
  creation.resolve(latePage)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transport.pages[0]!.closed, false)
  assert.equal(transport.pages[1]!.closed, true)
  assert.equal(transport.pages[1]!.url, '')
  assert.equal(transport.clients[0]!.disconnected, true)
})

test('closing at any page-creation microtask boundary leaves no unowned tab behind', async () => {
  for (let boundary = 0; boundary < 12; boundary++) {
    const creation = deferred<Page>()
    let latePage!: Page
    const transport = transportFixture({ delayPage: page => { latePage = page; return creation.promise } })
    const run = createRunner({ connect: transport.connect, cleanupTimeoutMs: 5 })
    const pending = run(['browser', 'task', 'open', 'https://www.douyin.com/']).catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    creation.resolve(latePage)
    for (let step = 0; step < boundary; step++) await Promise.resolve()
    await run(['browser', 'task', 'close'])
    await pending
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(transport.pages[1]!.closed, true, `tab leaked at microtask boundary ${boundary}`)
    assert.equal(transport.pages[0]!.closed, false)
    assert.equal(transport.clients[0]!.disconnected, true)
  }
})

test('operation timeout releases only its tab and redacts transport errors', async () => {
  const transport = transportFixture({ hangEvaluation: true })
  const run = createRunner({ connect: transport.connect, operationTimeoutMs: 20 })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  await assert.rejects(run(['browser', 'task', 'eval', 'longRunning()']), /timed out/)
  assert.equal(transport.pages[1]!.closed, true)
  assert.equal(transport.pages[0]!.closed, false)
  const failing = createRunner({ connect: async () => { throw new Error('ws://secret:private@127.0.0.1') } })
  await assert.rejects(failing(['browser', 'task', 'open', 'https://www.douyin.com/']), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /dedicated Chromium/)
    assert.doesNotMatch(error.message, /secret|private/)
    return true
  })
})

test('failed navigation cleans up its tab but leaves the persistent browser available', async () => {
  const transport = transportFixture({ failNavigation: true })
  const run = createRunner({ connect: transport.connect })
  await assert.rejects(run(['browser', 'task', 'open', 'https://www.douyin.com/']), /dedicated Chromium/)
  assert.equal(transport.pages[0]!.closed, false)
  assert.equal(transport.pages[1]!.closed, true)
  assert.equal(transport.clients[0]!.disconnected, true)
})

test('failed page reads report a safe operation and cause instead of hiding why browsing stopped', async () => {
  for (const [raw, expected] of [
    ['Execution context was destroyed during navigation https://secret.invalid/token', /读取页面失败：页面跳转导致读取环境失效/],
    ['Protocol error: Target closed ws://secret:private@127.0.0.1', /读取页面失败：任务标签页或浏览器连接已关闭/],
  ] as const) {
    const transport = transportFixture({ failEvaluation: raw })
    const run = createRunner({ connect: transport.connect })
    await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
    await assert.rejects(run(['browser', 'task', 'eval', 'location.href']), error => {
      assert.match((error as Error).message, expected)
      assert.doesNotMatch((error as Error).message, /secret|private|token/)
      return true
    })
    assert.equal(transport.pages[0]!.closed, false)
    assert.equal(transport.pages[1]!.closed, true)
  }
})

test('navigation-interrupted snapshot recovers on the same detail page and keeps the search page usable', async () => {
  const failures = ['Execution context was destroyed, most likely because of a navigation.']
  const transport = transportFixture({ evaluationFailures: failures })
  const run = createRunner({ connect: transport.connect })
  try {
    const search = JSON.parse(await run(['browser', 'repro', 'open', 'https://www.douyin.com/search/history']))
    const detail = JSON.parse(await run(['browser', 'repro', 'tab', 'new', 'https://www.douyin.com/video/7652347499231246451']))
    assert.equal(JSON.parse(await run(['browser', 'repro', 'eval', 'location.href', '--read-only'])),
      'https://www.douyin.com/video/7652347499231246451')
    assert.equal(transport.pages[2]!.reads, 2)
    assert.equal(transport.clients.length, 1, 'recovery must not replace the session and invalidate saved page IDs')
    assert.equal(transport.pages[1]!.closed, false)
    await run(['browser', 'repro', 'tab', 'close', detail.page])
    await run(['browser', 'repro', 'tab', 'select', search.page])
    assert.equal(JSON.parse(await run(['browser', 'repro', 'eval', 'location.href', '--read-only'])),
      'https://www.douyin.com/search/history')
  } finally { await run(['browser', 'repro', 'close']) }
  assert.equal(transport.pages[0]!.closed, false)
})

test('a redirected detail navigation retries its own page without losing the search tab', async () => {
  const failures: string[] = []
  const transport = transportFixture({ navigationFailures: failures })
  const run = createRunner({ connect: transport.connect })
  try {
    const search = JSON.parse(await run(['browser', 'repro', 'open', 'https://www.douyin.com/search/history']))
    failures.push('net::ERR_ABORTED at https://www.douyin.com/video/7652347499231246451')
    const detail = JSON.parse(await run(['browser', 'repro', 'tab', 'new', 'https://www.douyin.com/video/7652347499231246451']))
    assert.equal(transport.pages.length, 3, 'navigation recovery must reuse the detail page')
    assert.equal(transport.pages[2]!.navigations, 2)
    await run(['browser', 'repro', 'tab', 'close', detail.page])
    await run(['browser', 'repro', 'tab', 'select', search.page])
    assert.equal(transport.pages[1]!.closed, false)
  } finally { await run(['browser', 'repro', 'close']) }
})

test('snapshot navigation recovery is bounded and reports safe retry evidence', async () => {
  const transport = transportFixture({ failEvaluation: 'Execution context was destroyed token=private' })
  const retries: unknown[] = []
  const run = createRunner({ connect: transport.connect, onRetry: event => retries.push(event) })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  await assert.rejects(run(['browser', 'task', 'eval', 'location.href', '--read-only']), error => {
    assert.match((error as Error).message, /读取页面失败：页面跳转/)
    assert.doesNotMatch((error as Error).message, /Unknown owned|private|token/)
    return true
  })
  assert.equal(transport.pages[1]!.reads, 3)
  assert.deepEqual(retries, [
    { operation: '读取页面', attempt: 2, maxAttempts: 3 },
    { operation: '读取页面', attempt: 3, maxAttempts: 3 },
  ])
  assert.equal(transport.pages[1]!.closed, true)
  assert.equal(transport.pages[0]!.closed, false)
  assert.equal(transport.clients[0]!.disconnected, true)
})

test('connection loss and arbitrary evaluations are never automatically replayed', async () => {
  for (const [failure, flags] of [
    ['Protocol error: Target closed', ['--read-only']],
    ['Execution context was destroyed', []],
  ] as const) {
    const transport = transportFixture({ failEvaluation: failure })
    const run = createRunner({ connect: transport.connect, onRetry: () => assert.fail('unsafe operation retried') })
    await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
    await assert.rejects(run(['browser', 'task', 'eval', 'someOperation()', ...flags]))
    assert.equal(transport.pages[1]!.reads, 1)
    assert.equal(transport.pages[0]!.closed, false)
  }
})

test('stop during a snapshot retry delay releases pages without another read', async () => {
  const transport = transportFixture({ failEvaluation: 'Execution context was destroyed' })
  const controller = new AbortController()
  const run = createRunner({ connect: transport.connect, onRetry: () => controller.abort() })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  await assert.rejects(run(['browser', 'task', 'eval', 'location.href', '--read-only'], controller.signal), { name: 'AbortError' })
  assert.equal(transport.pages[1]!.reads, 1)
  assert.equal(transport.pages[1]!.closed, true)
  assert.equal(transport.pages[0]!.closed, false)
})

test('navigation retry delay stays within the original operation timeout', async () => {
  const transport = transportFixture({ failEvaluation: 'Execution context was destroyed' })
  const run = createRunner({ connect: transport.connect, operationTimeoutMs: 40 })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  await assert.rejects(run(['browser', 'task', 'eval', 'location.href', '--read-only']), /timed out/)
  assert.equal(transport.pages[1]!.closed, true)
  await new Promise(resolve => setTimeout(resolve, 550))
  assert.equal(transport.pages[1]!.reads, 1, 'timed out retry cannot operate on a released page')
  assert.equal(transport.clients.length, 1)
})

test('abort during revision loading never connects and ignores a late revision', async () => {
  const transport = transportFixture()
  const saved = deferred<{ revision: string | null }>()
  const run = createRunner({ connect: transport.connect, loadSession: () => saved.promise })
  const controller = new AbortController()
  const rejected = assert.rejects(run(['browser', 'task', 'auth', 'status'], controller.signal), { name: 'AbortError' })
  controller.abort()
  await rejected
  saved.resolve({ revision: 'late' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transport.clients.length, 0)
})

test('invalid scroll requests fail before evaluating page scripts', async () => {
  for (const parameters of [['up', '--amount', '100'], ['down', '--amount', '-1'], ['down', '--amount', '10001']]) {
    const transport = transportFixture()
    const run = createRunner({ connect: transport.connect })
    await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
    await assert.rejects(run(['browser', 'task', 'scroll', ...parameters]), /Invalid Chromium scroll/)
    assert.equal(transport.pages[0]!.closed, false)
  }
})

test('real temporary Chromium shares manual login storage and isolates owned tabs', {
  skip: process.env.HISTORY_CHROMIUM_INTEGRATION !== '1', timeout: 90_000,
}, async () => {
  const started = performance.now()
  const stage = async <T>(name: string, action: () => Promise<T>) => {
    const before = performance.now()
    process.stderr.write(`[chromium-smoke +${Math.round(before - started)}ms] ${name}: start\n`)
    try {
      const result = await action()
      process.stderr.write(`[chromium-smoke +${Math.round(performance.now() - started)}ms] ${name}: passed (${Math.round(performance.now() - before)}ms)\n`)
      return result
    } catch (error) {
      process.stderr.write(`[chromium-smoke +${Math.round(performance.now() - started)}ms] ${name}: failed (${Math.round(performance.now() - before)}ms)\n`)
      throw error
    }
  }
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><html><body style="height:4000px;margin:0">
      <form onsubmit="event.preventDefault();window.submitted=true"><input id="query" value="previous"
        oninput="window.inputValue=this.value;window.inputEvents=(window.inputEvents||0)+1"></form>
      <button id="video" onclick="window.clicked=true">Video</button>
      <div id="viewport" style="height:200px;overflow-y:auto">
        <ul data-e2e="scroll-list" style="height:2000px"><li>local synthetic result</li></ul>
      </div>
    </body></html>`)
  })
  let launched: Browser | undefined
  let run: ReturnType<typeof createRunner> | undefined
  try {
    await stage('listen local HTTP', () => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)))
    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}/nested`
    const profile = await stage('allocate temporary profile', () => mkdtemp(path.join(tmpdir(), 'history-chromium-smoke-')))
    launched = await stage('launch isolated headless Chrome', () => puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
      userDataDir: profile, headless: true, defaultViewport: null, timeout: 30_000, protocolTimeout: 8_000,
      args: ['--no-first-run', '--no-default-browser-check'],
    }))
    const browser = launched
    const initial = await stage('read initial tabs', () => browser.pages())
    const manual = await stage('create manual tab', () => browser.newPage())
    await stage('manual tab navigation', () => manual.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }))
    await stage('manual tab stores synthetic login', () => manual.evaluate(() => localStorage.setItem('synthetic-login', 'same-profile')))
    run = createRunner({
      connect: () => stage('connect own CDP client', () => puppeteer.connect({
        browserWSEndpoint: browser.wsEndpoint(), defaultViewport: null, protocolTimeout: 8_000,
      })),
      loadSession: async () => ({ revision: 'local-only' }),
    })
    const command = (session: string, ...args: string[]) => stage(`${session} ${args[0]}${args[0] === 'keys' ? ` ${args[1]}` : ''}`,
      () => run!(['browser', session, ...args]))
    await command('first', 'open', `${url}?session=first`)
    await command('second', 'open', `${url}?session=second`)
    assert.equal(JSON.parse(await command('first', 'eval', 'localStorage.getItem("synthetic-login")')), 'same-profile')
    assert.equal(JSON.parse(await command('second', 'eval', 'localStorage.getItem("synthetic-login")')), 'same-profile')
    await command('first', 'focus', '#query')
    await command('first', 'keys', process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await command('first', 'keys', 'Backspace')
    await command('first', 'type', '#query', '历史 冷知识 123')
    await command('first', 'keys', 'Enter')
    await command('first', 'click', '#video')
    assert.deepEqual(JSON.parse(await command('first', 'eval', '({value:document.querySelector("#query").value,inputValue:window.inputValue,inputEvents:window.inputEvents,submitted:window.submitted,clicked:window.clicked})')),
      { value: '历史 冷知识 123', inputValue: '历史 冷知识 123', inputEvents: 2, submitted: true, clicked: true })
    await command('first', 'scroll', 'down', '--amount', '700')
    const scroll = JSON.parse(await command('first', 'eval', '({window:scrollY,nested:document.querySelector("#viewport").scrollTop})'))
    assert.equal(scroll.window, 0)
    assert.equal(scroll.nested, 700)
    await command('first', 'close')
    assert.equal(manual.isClosed(), false)
    assert.equal(JSON.parse(await command('second', 'eval', 'localStorage.getItem("synthetic-login")')), 'same-profile')
    assert.equal((await stage('read tabs after first close', () => browser.pages())).length, initial.length + 2)
    await command('second', 'close')
    const remaining = await stage('read tabs after second close', () => browser.pages())
    assert.equal(remaining.length, initial.length + 1)
    assert.equal(manual.isClosed(), false)
    assert.ok(initial.every(page => !page.isClosed()))
  } finally {
    if (run) await stage('release owned sessions', () => Promise.allSettled([
      run!(['browser', 'first', 'close']), run!(['browser', 'second', 'close']),
    ]))
    if (launched) await stage('close only test-launched Chrome', () => launched!.close())
    await stage('close local HTTP', () => new Promise<void>(resolve => server.close(() => resolve())))
  }
})
