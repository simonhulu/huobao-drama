import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, CookieData } from 'puppeteer-core'

process.env.HISTORY_SOURCE_AUTH_DIR = join(mkdtempSync(join(realpathSync(tmpdir()), 'history-readiness-default-isolated-')), 'auth')
process.env.HISTORY_LOGIN_CDP_URL = 'http://127.0.0.1:1'
process.env.HISTORY_LIGHTPANDA_CDP_URL = 'ws://127.0.0.1:1'
const { createHistoryBrowserAuth } = await import('./history-source-auth.js')
const { createHistoryBrowserReadiness } = await import('./history-source-readiness.js')

async function fixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'history-readiness-'))
  const profileDirectory = join(directory, 'profile')
  const cookies: CookieData[] = [{ name: 'sessionid', value: 'synthetic-private-token', domain: '.douyin.com' }]
  let chromeAvailable = true
  let chromeReads = 0
  let disconnects = 0
  let contexts = 0
  let closed = false
  let value = ''
  let submitted = false
  let submittedReads = 0
  let loadingReads = 0
  let noCards = false
  let endReached = false
  let gate = ''
  let bodyGate = ''
  let brokenRoute = false
  let brokenResultsRoute = false
  let oldQuery = false
  let cardHref = '/video/1234567890123456789'
  let releaseResults: (() => void) | undefined
  let holdResults = false
  let navigationTimeout: number | undefined
  let navigationFailure = false
  const clicks: string[] = []
  let holdFocus = false
  let releaseFocus: (() => void) | undefined
  const connect = async () => {
    if (!chromeAvailable) throw new Error('private transport details')
    return {
      connected: true,
      userAgent: async () => 'Mozilla/5.0 TestPlatform HeadlessChrome/155.0.0.0 Safari/537.36',
      target: () => ({ createCDPSession: async () => ({ send: async () => ({ arguments: [`--user-data-dir=${profileDirectory}`, '--headless=new'] }), detach: async () => {} }) }),
      createBrowserContext: async () => { assert.fail('Probe must use persistent default context') },
      defaultBrowserContext: () => ({
        cookies: async () => { chromeReads++; return cookies },
        setCookie: async () => { assert.fail('Probe must not copy cookies') },
        newPage: async () => {
          contexts++
          return {
          setUserAgent: async () => {},
          goto: async (_url: string, options: { timeout: number }) => {
            navigationTimeout = options.timeout
            if (navigationFailure) throw new Error('synthetic navigation transport failure')
          }, bringToFront: async () => {}, focus: async () => {
            if (holdFocus) await new Promise<void>(resolve => { releaseFocus = resolve })
          },
          click: async (selector: string) => {
            clicks.push(selector)
            assert.fail(`Unfiltered search must not click filters or tabs: ${selector}`)
          },
          keyboard: { down: async () => {}, up: async () => {}, sendCharacter: async (text: string) => { value += text }, press: async (key: string) => {
            if (key === 'Backspace') value = ''
            if (key === 'Enter') submitted = true
          } },
          evaluate: async () => {
            if (submitted && holdResults) await new Promise<void>(resolve => { releaseResults = resolve })
            if (submitted) submittedReads++
            const loading = submitted && loadingReads-- > 0
            return {
              url: submitted ? `https://www.douyin.com/jingxuan/search/${encodeURIComponent(oldQuery ? '历史 冷知识' : brokenRoute || (submittedReads > 1 && brokenResultsRoute) ? '错误关键词' : value)}?type=general` : 'https://www.douyin.com/',
              title: gate, bodyText: bodyGate,
              search: {
                inputVisible: true, inputValue: value,
                videoTabVisible: false, videoTabSelected: false, resultsLoading: loading, endReached,
                filters: {
                  menuVisible: false, triggerSelector: submitted ? '.search-filter-trigger' : null,
                  durationSelected: false, videoSelected: false,
                  durationOptionVisible: false, videoOptionVisible: false,
                },
              },
              cards: submitted && !noCards ? [{
                href: cardHref,
                title: '明朝皇帝为什么改年号', authorName: '历史讲解', durationText: '09:30', likesText: '2.8万', leafTexts: [],
              }] : [],
            }
          },
          close: async () => { closed = true },
        } },
        close: async () => { assert.fail('Probe cannot close the persistent context') },
      }),
      disconnect: async () => { disconnects++ },
    } as unknown as Browser
  }
  const auth = createHistoryBrowserAuth({
    storageDirectory: join(directory, 'auth'), profileDirectory, connect,
    launch: async () => { throw new Error('check must never launch Chrome') },
  })
  return {
    auth, directory, cookies, connect, contexts: () => contexts, closed: () => closed, chromeReads: () => chromeReads,
    disconnects: () => disconnects,
    navigationTimeout: () => navigationTimeout, failNavigation: () => { navigationFailure = true },
    clicks: () => clicks, loading: (count: number) => { loadingReads = count },
    hideCards: () => { noCards = true }, endResults: () => { noCards = true; endReached = true },
    holdFocus: () => { holdFocus = true }, focusPending: () => !!releaseFocus,
    releaseFocus: () => { holdFocus = false; releaseFocus?.() },
    hold: () => { holdResults = true }, release: () => { holdResults = false; releaseResults?.() },
    resultsPending: () => !!releaseResults, gate: (text: string) => { gate = text },
    bodyGate: (text: string) => { bodyGate = text },
    breakRoute: () => { brokenRoute = true }, breakResultsRoute: () => { brokenResultsRoute = true },
    useOldQuery: () => { oldQuery = true }, useNonVideoCards: () => { cardHref = '/note/1234567890123456789' },
    useInvalidCards: () => { cardHref = 'https://example.com/video/1234567890123456789' },
    disconnectChrome: () => { chromeAvailable = false },
  }
}

test('real same-profile search is required before publishing a Chromium revision and concurrent checks share one owned probe tab', async () => {
  const f = await fixture()
  f.hold()
  const readiness = createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect, pollMs: 2 })
  const first = readiness.checkHistoryBrowserSession()
  const second = readiness.checkHistoryBrowserSession()
  assert.equal(first, second)
  try {
    const deadline = Date.now() + 2000
    while (!f.resultsPending()) {
      if (Date.now() >= deadline) assert.fail('search results were never requested')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal((await f.auth.getHistoryBrowserSessionStatus()).status, 'checking')
    assert.deepEqual(await f.auth.loadHistoryBrowserSession(), { revision: null, cookies: [] })
  } finally { f.release() }
  const status = await first
  assert.equal(status.status, 'ready')
  assert.equal(status.canCollect, true)
  assert.ok(status.checkedAt)
  assert.equal(status.engine, 'chromium')
  assert.match(status.checks.find(check => check.stage === 'session')!.message, /无头 Chromium.*专用配置.*登录会话/)
  assert.ok((await f.auth.loadHistoryChromiumSession()).revision)
  assert.equal(f.contexts(), 1)
  assert.equal(f.closed(), true)
  assert.deepEqual(f.clicks(), [])
  assert.doesNotMatch(JSON.stringify(status), /synthetic-private-token|sessionid|cookies/)
  const reloaded = createHistoryBrowserAuth({ storageDirectory: join(f.directory, 'auth') })
  assert.deepEqual(await reloaded.getHistoryBrowserSessionStatus(), status)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'auth/session.json'), 'utf8')).status, 'ready')
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'auth/session.json'), 'utf8')).cookies, [])
})

test('readiness reserves thirty seconds for owned-tab creation and first-page navigation', async () => {
  const f = await fixture()
  const status = await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect }).checkHistoryBrowserSession()
  assert.equal(status.status, 'ready')
  assert.equal(f.navigationTimeout(), 30_000)
})

test('readiness waits for a displayed but still-loading search input before typing', async () => {
  const f = await fixture()
  let loadingReads = 3
  let ready = false
  const connect = async () => {
    const browser = await f.connect()
    const context = browser.defaultBrowserContext()
    const newPage = context.newPage.bind(context)
    context.newPage = async () => {
      const page = await newPage()
      const evaluate = page.evaluate.bind(page)
      const focus = page.focus.bind(page)
      page.evaluate = (async (...args: Parameters<typeof evaluate>) => {
        const state = await evaluate(...args) as { search: Record<string, unknown> }
        ready = loadingReads-- <= 0
        return { ...state, search: { ...state.search, inputReady: ready } }
      }) as typeof page.evaluate
      page.focus = async selector => { assert.equal(ready, true); await focus(selector) }
      return page
    }
    browser.defaultBrowserContext = () => context
    return browser
  }
  const status = await createHistoryBrowserReadiness({ auth: f.auth, connect, pollMs: 2 }).checkHistoryBrowserSession()
  assert.equal(status.status, 'ready')
  assert.ok(loadingReads < 0)
})

test('readiness waits for stable non-loading results without requiring filter controls or a video tab', async () => {
  const f = await fixture()
  f.loading(5)
  const status = await createHistoryBrowserReadiness({
    auth: f.auth, connect: f.connect, timeoutMs: 2000, pollMs: 2,
  }).checkHistoryBrowserSession()
  assert.equal(status.status, 'ready')
  assert.equal(status.canCollect, true)
  assert.deepEqual(f.clicks(), [])
  assert.match(status.checks.find(check => check.stage === 'video_results')!.message, /视频或图文.*稳定/)
  assert.doesNotMatch(JSON.stringify(status.checks), /5分钟以上|筛选|发布时间/)
  assert.ok((await f.auth.loadHistoryChromiumSession()).revision)
})

test('an endless loading state cannot publish readiness or trigger filter clicks', async () => {
  const f = await fixture()
  f.loading(Infinity)
  const status = await createHistoryBrowserReadiness({
    auth: f.auth, connect: f.connect, timeoutMs: 2000, pollMs: 2,
  }).checkHistoryBrowserSession()
  assert.equal(status.status, 'blocked')
  assert.equal(status.canCollect, false)
  assert.equal(status.checks.at(-1)?.stage, 'video_results')
  assert.deepEqual(f.clicks(), [])
  assert.match(status.message, /仍在加载搜索结果|未能在时限内稳定加载/)
  assert.equal((await f.auth.loadHistoryChromiumSession()).revision, null)
})

test('cards that drift to a different actual search keyword cannot publish readiness', async () => {
  const f = await fixture()
  f.breakResultsRoute()
  const status = await createHistoryBrowserReadiness({
    auth: f.auth, connect: f.connect, timeoutMs: 2000, pollMs: 2,
  }).checkHistoryBrowserSession()
  assert.equal(status.status, 'blocked')
  assert.equal(status.canCollect, false)
  assert.equal(status.checks.at(-1)?.stage, 'video_results')
  assert.deepEqual(f.clicks(), [])
  assert.match(status.message, /不是.*历史.*搜索结果/)
  assert.equal((await f.auth.loadHistoryChromiumSession()).revision, null)
})

test('the previous multi-keyword search cannot publish readiness for the fixed history query', async () => {
  const f = await fixture()
  f.useOldQuery()
  const status = await createHistoryBrowserReadiness({
    auth: f.auth, connect: f.connect, timeoutMs: 250, pollMs: 2,
  }).checkHistoryBrowserSession()
  assert.equal(status.status, 'blocked')
  assert.equal(status.canCollect, false)
  assert.equal(status.checks.at(-1)?.stage, 'search_submit')
  assert.deepEqual(f.clicks(), [])
  assert.equal((await f.auth.loadHistoryChromiumSession()).revision, null)
})

test('image-text results alone can publish collection readiness', async () => {
  const f = await fixture()
  f.useNonVideoCards()
  const status = await createHistoryBrowserReadiness({
    auth: f.auth, connect: f.connect, timeoutMs: 2000, pollMs: 2,
  }).checkHistoryBrowserSession()
  assert.equal(status.status, 'ready')
  assert.equal(status.canCollect, true)
  assert.deepEqual(f.clicks(), [])
  assert.ok((await f.auth.loadHistoryChromiumSession()).revision)
})

test('explicitly ended empty results prove the session without waiting for a video', async () => {
  const f = await fixture()
  f.endResults()
  const status = await createHistoryBrowserReadiness({
    auth: f.auth, connect: f.connect, timeoutMs: 2000, pollMs: 2,
  }).checkHistoryBrowserSession()
  assert.equal(status.status, 'ready')
  assert.equal(status.canCollect, true)
  assert.deepEqual(f.clicks(), [])
  assert.match(status.checks.find(check => check.stage === 'video_results')!.message, /结果已结束/)
  assert.equal(f.closed(), true)
})

test('missing cards without an end marker and foreign-domain cards cannot publish readiness', async () => {
  for (const invalidLinks of [false, true]) {
    const f = await fixture()
    if (invalidLinks) f.useInvalidCards()
    else f.hideCards()
    const status = await createHistoryBrowserReadiness({
      auth: f.auth, connect: f.connect, timeoutMs: 2000, pollMs: 2,
    }).checkHistoryBrowserSession()
    assert.equal(status.status, 'blocked')
    assert.equal(status.canCollect, false)
    assert.match(status.message, /未返回可读取的视频或图文结果/)
    assert.deepEqual(f.clicks(), [])
    assert.equal((await f.auth.loadHistoryChromiumSession()).revision, null)
    assert.equal(f.closed(), true)
  }
})

test('readiness uses a two-minute overall deadline and caps larger requested budgets', async t => {
  const original = AbortSignal.timeout
  const budgets: number[] = []
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    budgets.push(milliseconds)
    return original(milliseconds)
  })
  for (const timeoutMs of [undefined, 180_000]) {
    const f = await fixture()
    const status = await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect, timeoutMs }).checkHistoryBrowserSession()
    assert.equal(status.status, 'ready')
  }
  assert.deepEqual(budgets, [120_000, 120_000])
})

test('search input progress is visible while a browser focus operation is still pending', async () => {
  const f = await fixture()
  f.holdFocus()
  const checking = createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect }).checkHistoryBrowserSession()
  let during: Awaited<ReturnType<typeof f.auth.getHistoryBrowserSessionStatus>> | undefined
  try {
    const deadline = Date.now() + 2000
    while (!f.focusPending()) {
      if (Date.now() >= deadline) assert.fail('focus was never requested')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    during = await f.auth.getHistoryBrowserSessionStatus()
  } finally { f.releaseFocus() }
  const completed = await checking
  assert.equal(during?.status, 'checking')
  assert.equal(during?.checks.at(-1)?.stage, 'search_input')
  assert.equal(during?.checks.at(-1)?.outcome, 'pending')
  assert.equal(completed.status, 'ready')
  assert.equal(completed.checks.find(check => check.stage === 'search_input')?.outcome, 'passed')
})

test('a failed first navigation does not misreport an already connected browser as closed or logged out', async () => {
  const f = await fixture()
  f.failNavigation()
  const status = await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect }).checkHistoryBrowserSession()
  assert.equal(status.status, 'error')
  assert.equal(status.canCollect, false)
  assert.equal(status.checks[0]?.stage, 'session')
  assert.equal(status.checks[0]?.outcome, 'passed')
  assert.equal(status.checks.at(-1)?.stage, 'connect')
  assert.match(status.message, /页面加载超时|导航失败/)
  assert.doesNotMatch(status.message, /打开.*窗口|重新登录|未登录|synthetic/)
  assert.equal(f.closed(), true)
})

test('missing authenticated cookies means login_required while a disconnected dedicated browser means error', async () => {
  for (const missingBrowser of [false, true]) {
    const f = await fixture()
    if (missingBrowser) f.disconnectChrome()
    else f.cookies.splice(0)
    const status = await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect }).checkHistoryBrowserSession()
    assert.equal(status.status, missingBrowser ? 'error' : 'login_required')
    assert.equal(status.canCollect, false)
    assert.equal(f.contexts(), missingBrowser ? 0 : 1)
    assert.deepEqual(await f.auth.loadHistoryBrowserSession(), { revision: null, cookies: [] })
  }
})

test('a security gate takes precedence over missing cookie evidence instead of incorrectly demanding another login', async () => {
  const f = await fixture()
  f.cookies.splice(0)
  f.gate('验证码中间页')
  const status = await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect }).checkHistoryBrowserSession()
  assert.equal(status.status, 'blocked')
  assert.equal(status.canCollect, false)
  assert.doesNotMatch(status.message, /重新登录/)
})

test('verification pages cannot publish a Chromium revision or wake waiting workers', async () => {
  const f = await fixture()
  await f.auth.confirmHistoryBrowserLogin()
  const previous = await f.auth.loadHistoryBrowserSession()
  f.gate('验证码中间页')
  const status = await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect }).checkHistoryBrowserSession()
  assert.equal(status.status, 'blocked')
  assert.equal(status.canCollect, false)
  assert.match(status.message, /打开登录窗口.*专用窗口.*验证/)
  assert.doesNotMatch(status.message, /重新登录/)
  assert.deepEqual(await f.auth.loadHistoryBrowserSession(), previous)
  const legacy = JSON.parse(await readFile(join(f.directory, 'auth/session.json'), 'utf8'))
  assert.equal(legacy.status, 'session_saved')
  assert.equal(legacy.revision, previous.revision)
  assert.equal((await f.auth.getHistoryBrowserSessionStatus()).status, 'blocked')
  assert.equal(f.closed(), true)
})

test('saved cookies cannot make a disconnected persistent Chromium ready and a login prompt remains distinct from CAPTCHA', async () => {
  const f = await fixture()
  await f.auth.confirmHistoryBrowserLogin()
  f.disconnectChrome()
  const readiness = createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect })
  const status = await readiness.checkHistoryBrowserSession()
  assert.equal(status.status, 'error')
  assert.equal(status.canCollect, false)
  const connected = await fixture()
  const next = createHistoryBrowserReadiness({ auth: connected.auth, connect: connected.connect })
  connected.bodyGate('请先登录')
  const rejected = await next.checkHistoryBrowserSession()
  assert.equal(rejected.status, 'login_required')
  assert.equal(rejected.canCollect, false)
  assert.match(rejected.message, /打开登录窗口.*专用窗口.*登录/)
})

test('wrong actual search keywords never become ready and end at a bounded blocked result', async () => {
  const f = await fixture()
  f.breakRoute()
  const status = await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect, timeoutMs: 2000, pollMs: 2 }).checkHistoryBrowserSession()
  assert.equal(status.status, 'blocked')
  assert.equal(status.canCollect, false)
  assert.equal(status.checks.at(-1)?.stage, 'search_submit')
  assert.equal((await f.auth.loadHistoryBrowserSession()).revision, null)
  assert.equal(f.closed(), true)
})

test('transport failures return error without exposing paths, cookies or transport credentials', async () => {
  const f = await fixture()
  const status = await createHistoryBrowserReadiness({ auth: f.auth, connect: async () => {
    throw new Error('sessionid=synthetic-private-token /Users/private ws://user:password@127.0.0.1:9240')
  } }).checkHistoryBrowserSession()
  assert.equal(status.status, 'error')
  assert.equal(status.canCollect, false)
  assert.doesNotMatch(JSON.stringify(status), /synthetic-private-token|sessionid|Users|password|9240/)
  assert.doesNotMatch(status.message, /打开.*窗口|重新登录/)
  assert.equal((await f.auth.loadHistoryBrowserSession()).revision, null)
})

test('status GET only reads persisted checks and expires readiness after five minutes', async () => {
  const f = await fixture()
  await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect }).checkHistoryBrowserSession()
  const checked = await f.auth.getHistoryBrowserSessionStatus()
  const reads = f.chromeReads()
  const independent = createHistoryBrowserAuth({ storageDirectory: join(f.directory, 'auth'),
    now: () => Date.parse(checked.checkedAt!) + 5 * 60_000 + 1,
    connect: async () => { assert.fail('GET cannot connect to a browser') },
  })
  const expired = await independent.getHistoryBrowserSessionStatus()
  assert.equal(expired.status, 'session_saved')
  assert.equal(expired.canCollect, false)
  assert.equal(expired.checkedAt, checked.checkedAt)
  assert.equal(f.chromeReads(), reads)
})

test('a worker requesting fresh login immediately revokes a previously successful readiness result', async () => {
  const f = await fixture()
  await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect }).checkHistoryBrowserSession()
  const saved = await f.auth.loadHistoryChromiumSession()
  const controller = new AbortController()
  const waiting = f.auth.waitForHistoryBrowserLogin({ afterRevision: saved.revision, signal: controller.signal })
  void waiting.catch(() => {})
  try {
    const deadline = Date.now() + 2000
    while (JSON.parse(await readFile(join(f.directory, 'auth/session.json'), 'utf8')).status !== 'waiting_login') {
      if (Date.now() >= deadline) assert.fail('worker never entered waiting_login')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const status = await f.auth.getHistoryBrowserSessionStatus()
    assert.equal(status.status, 'waiting_login')
    assert.equal(status.canCollect, false)
  } finally { controller.abort(); await waiting.catch(() => {}) }
  await f.auth.markHistoryBrowserSessionReady(saved.revision!)
  assert.equal((await f.auth.getHistoryBrowserSessionStatus()).canCollect, false)
})

test('a legacy worker mark preserves an already verified ready revision without granting readiness on its own', async () => {
  const f = await fixture()
  await createHistoryBrowserReadiness({ auth: f.auth, connect: f.connect }).checkHistoryBrowserSession()
  const saved = await f.auth.loadHistoryChromiumSession()
  await new Promise(resolve => setTimeout(resolve, 10))
  await f.auth.markHistoryBrowserSessionReady(saved.revision!)
  assert.equal((await f.auth.getHistoryBrowserSessionStatus()).canCollect, true)
})

test('a live slower checking record remains active during the two-minute search budget', async () => {
  const f = await fixture()
  const at = new Date().toISOString()
  await f.auth.updateHistoryBrowserReadiness({ engine: 'chromium', status: 'checking', message: '正在输入搜索词', updatedAt: at,
    checkedAt: null, revision: null, checks: [{ at, stage: 'search_input', message: '正在输入搜索词', outcome: 'pending' }] })
  const later = createHistoryBrowserAuth({ storageDirectory: join(f.directory, 'auth'), now: () => Date.parse(at) + 100_001 })
  const status = await later.getHistoryBrowserSessionStatus()
  assert.equal(status.status, 'checking')
  assert.equal(status.checks.at(-1)?.stage, 'search_input')
  assert.equal(status.canCollect, false)
})

test('an abandoned checking record becomes a recoverable error after one hundred twenty-five seconds without browser side effects', async () => {
  const f = await fixture()
  const at = new Date().toISOString()
  await f.auth.updateHistoryBrowserReadiness({ engine: 'chromium', status: 'checking', message: '正在检测', updatedAt: at,
    checkedAt: null, revision: null, checks: [] })
  const later = createHistoryBrowserAuth({ storageDirectory: join(f.directory, 'auth'), now: () => Date.parse(at) + 125_001 })
  const status = await later.getHistoryBrowserSessionStatus()
  assert.equal(status.status, 'error')
  assert.equal(status.canCollect, false)
})

test('a stuck dedicated-browser connection is bounded and its eventual result cannot publish a revision', async () => {
  const f = await fixture()
  let release!: (browser: Browser) => void
  const auth = createHistoryBrowserAuth({ storageDirectory: join(f.directory, 'late-auth'),
    connect: () => new Promise(resolve => { release = resolve }),
  })
  const status = await createHistoryBrowserReadiness({ auth, timeoutMs: 60 }).checkHistoryBrowserSession()
  assert.equal(status.status, 'error')
  assert.equal(status.canCollect, false)
  release({ target: () => ({ createCDPSession: async () => { throw new Error('late-profile') } }), disconnect: async () => {} } as unknown as Browser)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await auth.loadHistoryBrowserSession()).revision, null)
  assert.equal(f.contexts(), 0)
})

test('abort before the adapter first command still disconnects the independently acquired Chromium client', async () => {
  const f = await fixture()
  const update = f.auth.updateHistoryBrowserReadiness
  const auth = { ...f.auth, updateHistoryBrowserReadiness: async (state: Parameters<typeof update>[0]) => {
    const result = await update(state)
    if (state.status === 'checking' && state.checks.some(check => check.stage === 'session')) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return result
  } }
  const status = await createHistoryBrowserReadiness({ auth, connect: f.connect, timeoutMs: 60 }).checkHistoryBrowserSession()
  assert.equal(status.status, 'error')
  assert.equal(f.contexts(), 0)
  assert.ok(f.disconnects() >= 1, 'Readiness must release its client even before the runner owns it')
  assert.deepEqual(await f.auth.loadHistoryChromiumSession(), { revision: null })
})

test('after handoff readiness lets the runner close a late owned tab before disconnecting its CDP client', async () => {
  const f = await fixture()
  const original = await f.connect()
  const context = original.defaultBrowserContext()
  const cleanup: string[] = []
  let releasePage!: (page: unknown) => void
  let disconnected = false
  const browser = {
    ...original,
    defaultBrowserContext: () => ({ ...context, newPage: () => new Promise(resolve => { releasePage = resolve }) }),
    disconnect: async () => { disconnected = true; cleanup.push('disconnect') },
  } as unknown as Browser
  const status = await createHistoryBrowserReadiness({ auth: f.auth, connect: async () => browser, timeoutMs: 1000 }).checkHistoryBrowserSession()
  assert.equal(status.status, 'error')
  try {
    assert.equal(disconnected, false, 'A pending owned newPage must retain its driver connection until cleanup')
  } finally {
    releasePage({ bringToFront: async () => {}, close: async () => { cleanup.push(disconnected ? 'orphaned-page' : 'page-close') } })
  }
  const deadline = Date.now() + 2000
  while (!disconnected) {
    if (Date.now() >= deadline) assert.fail('Driver did not disconnect after late-tab cleanup')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.deepEqual(cleanup, ['page-close', 'disconnect'])
})
