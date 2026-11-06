import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { Browser, ConnectOptions, CookieData } from 'puppeteer-core'
import { createLightpandaCommandRunner as createRunner, type LightpandaCommandRunnerOptions } from './history-source-lightpanda.js'

const createLightpandaCommandRunner = (options: LightpandaCommandRunnerOptions = {}) => createRunner({
  loadSession: async () => ({ revision: null, cookies: [] }), ...options,
})

test('refuses non-local or credential-bearing CDP endpoints without exposing credentials', () => {
  for (const endpoint of ['ws://example.com:9240', 'https://127.0.0.1:9240', 'ws://secret:private@127.0.0.1:9240']) {
    assert.throws(() => createLightpandaCommandRunner({ endpoint }), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /loopback/)
      assert.doesNotMatch(error.message, /secret|private|example.com/)
      return true
    })
  }
})

function transportFixture(options: { hangEvaluation?: boolean; hangClose?: boolean } = {}) {
  const contexts: Array<{ closed: boolean; pages: Array<{ closed: boolean; url: string }>; cookies: CookieData[] }> = []
  const connections: ConnectOptions[] = []
  let disconnected = 0
  const connect = async (connectionOptions: ConnectOptions) => {
    connections.push(connectionOptions)
    return {
      createBrowserContext: async () => {
        const context = { closed: false, pages: [] as Array<{ closed: boolean; url: string }>, cookies: [] as CookieData[] }
        contexts.push(context)
        return {
          newPage: async () => {
            const page = { closed: false, url: '' }
            let value = ''
            let modifier = false
            let selected = false
            let submitted = false
            let clicked = ''
            context.pages.push(page)
            return {
              goto: async (url: string) => { page.url = url },
              evaluate: async (source: string) => options.hangEvaluation ? new Promise(() => {})
                : source === 'location.href' ? page.url : source === 'formState' ? { value, submitted, clicked } : { ok: true },
              focus: async (_selector: string) => {},
              type: async (_selector: string, text: string) => { value += text },
              click: async (selector: string) => { clicked = selector },
              keyboard: {
                down: async (_key: string) => { modifier = true },
                up: async (_key: string) => { modifier = false },
                press: async (key: string) => {
                  if (key === 'a' && modifier) selected = true
                  if (key === 'Backspace') { value = selected ? '' : value.slice(0, -1); selected = false }
                  if (key === 'Enter') submitted = true
                },
              },
              close: async () => { page.closed = true },
            }
          },
          close: async () => { context.closed = true; if (options.hangClose) await new Promise(() => {}) },
          cookies: async () => context.cookies,
          setCookie: async (...cookies: CookieData[]) => { context.cookies.push(...cookies) },
          deleteCookie: async (...cookies: CookieData[]) => { context.cookies = context.cookies.filter(cookie => !cookies.includes(cookie)) },
        }
      },
      disconnect: async () => { disconnected++ },
      close: async () => { throw new Error('Must not close the shared browser') },
    } as unknown as Browser
  }
  return { connect, contexts, connections, disconnected: () => disconnected }
}

test('each task owns an isolated context and closing it leaves other task pages intact', async () => {
  const transport = transportFixture()
  const run = createLightpandaCommandRunner({ connect: transport.connect })
  const first = JSON.parse(await run(['browser', 'first', 'open', 'https://www.douyin.com/']))
  const second = JSON.parse(await run(['browser', 'second', 'open', 'https://www.douyin.com/video/123']))
  assert.notEqual(first.page, second.page)
  assert.equal(await run(['browser', 'first', 'eval', 'location.href']), '"https://www.douyin.com/"')
  await run(['browser', 'first', 'close'])
  assert.equal(transport.contexts[0]!.closed, true)
  assert.equal(transport.contexts[1]!.closed, false)
  assert.equal(await run(['browser', 'second', 'eval', 'location.href']), '"https://www.douyin.com/video/123"')
  await run(['browser', 'second', 'close'])
  assert.equal(transport.disconnected(), 2)
})

test('saved sessions import only Douyin cookies and refresh removes stale authentication before importing a new revision', async () => {
  const transport = transportFixture()
  let saved = { revision: 'first', cookies: [
    { name: 'sessionid', value: 'synthetic-first', domain: '.douyin.com' },
    { name: 'unrelated', value: 'never-import', domain: 'example.com' },
  ] }
  const run = createLightpandaCommandRunner({ connect: transport.connect, loadSession: async () => saved })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  assert.deepEqual(JSON.parse(await run(['browser', 'task', 'auth', 'status'])), { revision: 'first' })
  assert.deepEqual(transport.contexts[0]!.cookies.map(cookie => cookie.value), ['synthetic-first'])
  saved = { revision: 'second', cookies: [{ name: 'sessionid_ss', value: 'synthetic-second', domain: '.douyin.com' }] }
  assert.deepEqual(JSON.parse(await run(['browser', 'task', 'auth', 'refresh'])), { revision: 'second' })
  assert.deepEqual(transport.contexts[0]!.cookies.map(cookie => cookie.value), ['synthetic-second'])
  await run(['browser', 'task', 'close'])
})

test('auth refresh without a saved session fails explicitly and stop during session loading releases the context', async () => {
  const transport = transportFixture()
  const empty = createLightpandaCommandRunner({ connect: transport.connect })
  await empty(['browser', 'empty', 'open', 'https://www.douyin.com/'])
  assert.deepEqual(JSON.parse(await empty(['browser', 'empty', 'auth', 'status'])), { revision: null })
  await assert.rejects(empty(['browser', 'empty', 'auth', 'refresh']), /尚未保存有效抖音登录会话/)
  let finishLoading!: (session: { revision: string | null; cookies: CookieData[] }) => void
  const run = createLightpandaCommandRunner({ connect: transport.connect, loadSession: () => new Promise(resolve => { finishLoading = resolve }) })
  const controller = new AbortController()
  const pending = run(['browser', 'loading', 'open', 'https://www.douyin.com/'], controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await rejected
  finishLoading({ revision: 'late', cookies: [{ name: 'sessionid', value: 'synthetic-late', domain: '.douyin.com' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transport.contexts[1]!.closed, true)
  assert.deepEqual(transport.contexts[1]!.cookies, [])
})

test('search controls support focusing, replacing text, submitting and clicking the video filter', async () => {
  const transport = transportFixture()
  const run = createLightpandaCommandRunner({ connect: transport.connect })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  await run(['browser', 'task', 'type', '#q', 'old query'])
  await run(['browser', 'task', 'focus', '#q'])
  await run(['browser', 'task', 'keys', 'Meta+a'])
  await run(['browser', 'task', 'keys', 'Backspace'])
  await run(['browser', 'task', 'type', '#q', '历史冷知识'])
  await run(['browser', 'task', 'keys', 'Enter'])
  await run(['browser', 'task', 'click', 'span[data-key="video"]'])
  assert.deepEqual(JSON.parse(await run(['browser', 'task', 'eval', 'formState'])), {
    value: '历史冷知识', submitted: true, clicked: 'span[data-key="video"]',
  })
  await run(['browser', 'task', 'close'])
})

test('stop interrupts a hung CDP evaluation and disconnects even when context cleanup hangs', async () => {
  const transport = transportFixture({ hangEvaluation: true, hangClose: true })
  const run = createLightpandaCommandRunner({ connect: transport.connect, cleanupTimeoutMs: 20 })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  const controller = new AbortController()
  const pending = run(['browser', 'task', 'eval', 'longRunning()'], controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await rejected
  assert.equal(transport.contexts[0]!.closed, true)
  assert.equal(transport.disconnected(), 1)
})

test('stopping while connecting disconnects a late connection without creating any task context', async () => {
  const transport = transportFixture()
  let finishConnection!: (browser: Browser) => void
  const run = createLightpandaCommandRunner({ connect: () => new Promise(resolve => { finishConnection = resolve }) })
  const controller = new AbortController()
  const pending = run(['browser', 'task', 'open', 'https://www.douyin.com/'], controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  await rejected
  finishConnection(await transport.connect({}))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(transport.contexts.length, 0)
  assert.equal(transport.disconnected(), 1)
})

test('bounded operation timeout releases its context and masks errors from the CDP transport', async () => {
  const transport = transportFixture({ hangEvaluation: true })
  const run = createLightpandaCommandRunner({ connect: transport.connect, operationTimeoutMs: 20 })
  await run(['browser', 'task', 'open', 'https://www.douyin.com/'])
  await assert.rejects(run(['browser', 'task', 'eval', 'longRunning()']), /timed out/)
  assert.equal(transport.contexts[0]!.closed, true)
  assert.equal(transport.disconnected(), 1)
  const failing = createLightpandaCommandRunner({ connect: async () => { throw new Error('ws://secret:password@127.0.0.1:9240') } })
  await assert.rejects(failing(['browser', 'task', 'open', 'https://www.douyin.com/']), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /local CDP/)
    assert.doesNotMatch(error.message, /secret|password/)
    return true
  })
})

test('detail tabs do not replace the preserved search page and only owned tabs can be selected', async () => {
  const transport = transportFixture()
  const run = createLightpandaCommandRunner({ connect: transport.connect })
  const search = JSON.parse(await run(['browser', 'task', 'open', 'https://www.douyin.com/jingxuan/search/history']))
  const detail = JSON.parse(await run(['browser', 'task', 'tab', 'new', 'https://www.douyin.com/video/123']))
  assert.notEqual(search.page, detail.page)
  await run(['browser', 'task', 'tab', 'select', search.page])
  assert.equal(await run(['browser', 'task', 'eval', 'location.href']), '"https://www.douyin.com/jingxuan/search/history"')
  await run(['browser', 'task', 'tab', 'close', detail.page])
  assert.equal(transport.contexts[0]!.pages[1]!.closed, true)
  await assert.rejects(run(['browser', 'task', 'tab', 'select', 'user-owned-tab']), /owned task page/)
  await run(['browser', 'task', 'close'])
})

test('real Lightpanda edits a form and scrolls nested result containers before the window', {
  skip: process.env.HISTORY_LIGHTPANDA_INTEGRATION !== '1',
}, async () => {
  const items = Array.from({ length: 120 }, (_, index) => `<li>result ${index}</li>`).join('')
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><body style="height:4000px">
      <form onsubmit="event.preventDefault();window.submitted=true"><input id="q" value="old query"></form>
      <button id="video" onclick="window.clicked=true">Video</button>
      ${request.url === '/nested' ? '<div id="viewport" style="height:200px;overflow-y:auto">' : ''}
      <ul data-e2e="scroll-list" style="height:2000px">${items}</ul>${request.url === '/nested' ? '</div>' : ''}
    </body>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  let saved = { revision: 'synthetic-first', cookies: [{ name: 'history_probe', value: 'synthetic-only', domain: '.douyin.com' }] }
  const run = createLightpandaCommandRunner({ loadSession: async () => saved })
  const command = (...args: string[]) => run(['browser', 'integration', ...args])
  try {
    await command('open', `http://127.0.0.1:${address.port}/nested`)
    assert.deepEqual(JSON.parse(await command('auth', 'status')), { revision: 'synthetic-first' })
    await command('focus', '#q')
    await command('keys', 'Control+a')
    await command('keys', 'Backspace')
    await command('type', '#q', 'replacement')
    await command('keys', 'Meta+a')
    await command('keys', 'Backspace')
    await command('type', '#q', 'history')
    await command('keys', 'Enter')
    await command('click', '#video')
    assert.deepEqual(JSON.parse(await command('eval', '({value:document.querySelector("#q").value,submitted:window.submitted,clicked:window.clicked})')),
      { value: 'history', submitted: true, clicked: true })
    const dimensions = JSON.parse(await command('eval', '({client:document.querySelector("#viewport").clientHeight,scroll:document.querySelector("#viewport").scrollHeight,overflow:getComputedStyle(document.querySelector("#viewport")).overflowY})'))
    const scroll = JSON.parse(await command('scroll', 'down', '--amount', '700'))
    const nested = JSON.parse(await command('eval', '({window:scrollY,nested:document.querySelector("#viewport").scrollTop})'))
    assert.ok(nested.nested > 0, JSON.stringify({ scroll, nested, dimensions }))
    assert.equal(nested.window, 0)
    await command('open', `http://127.0.0.1:${address.port}/window`)
    await command('scroll', 'down', '--amount', '700')
    assert.equal(JSON.parse(await command('eval', 'scrollY')), 700)
    saved = { revision: 'synthetic-second', cookies: [{ name: 'history_probe', value: 'synthetic-replaced', domain: '.douyin.com' }] }
    assert.deepEqual(JSON.parse(await command('auth', 'refresh')), { revision: 'synthetic-second' })
  } finally {
    await command('close')
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
