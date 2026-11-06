import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Browser, BrowserContext, Page } from 'puppeteer-core'
import { connectHistoryChromiumBrowser, loadHistoryChromiumSession } from './history-source-auth.js'

export interface ChromiumCommandRunnerOptions {
  connect?: () => Promise<Browser>
  loadSession?: () => Promise<{ revision: string | null }>
  operationTimeoutMs?: number
  cleanupTimeoutMs?: number
  onRetry?: (event: { operation: '读取页面' | '打开页面'; attempt: number; maxAttempts: number }) => void
}

interface Session {
  browser?: Browser
  context?: BrowserContext
  userAgent?: string
  ready?: Promise<void>
  pages: Map<string, Page>
  creating: Set<Promise<Page>>
  closing: WeakMap<Page, Promise<void>>
  activePage?: string
  closed: boolean
  disconnected: boolean
  cleanup?: Promise<void>
}

class CommandError extends Error {}

const NAVIGATION_CONTEXT_ERROR = /execution context was destroyed|cannot find context with specified id|(?:attempted to use |execution context is not available in )?detached frame|navigating frame was detached/i
const NAVIGATION_ABORTED_ERROR = /net::ERR_ABORTED\b/i

async function settleWithin(promise: Promise<unknown>, milliseconds: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise.catch(() => {}), new Promise<void>(resolve => { timeout = setTimeout(resolve, milliseconds) })])
  } finally { clearTimeout(timeout) }
}

async function interruptible<T>(operation: Promise<T>, signal: AbortSignal | undefined, milliseconds: number, interrupt: () => void): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      onAbort = () => { interrupt(); reject(signal?.reason || new DOMException('History sourcing stopped', 'AbortError')) }
      if (signal?.aborted) { onAbort(); return }
      signal?.addEventListener('abort', onAbort, { once: true })
      timeout = setTimeout(() => { interrupt(); reject(new CommandError('Chromium browser operation timed out')) }, milliseconds)
    })])
  } finally {
    clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

export function createChromiumCommandRunner(options: ChromiumCommandRunnerOptions = {}) {
  const connect = options.connect || connectHistoryChromiumBrowser
  const loadSession = options.loadSession || loadHistoryChromiumSession
  const operationTimeout = options.operationTimeoutMs || 30_000
  const cleanupTimeout = options.cleanupTimeoutMs || 750
  const sessions = new Map<string, Session>()
  const closePage = (session: Session, page: Page) => {
    let closing = session.closing.get(page)
    if (!closing) {
      closing = settleWithin(Promise.resolve().then(() => page.close()), cleanupTimeout)
      session.closing.set(page, closing)
    }
    return closing
  }
  const disconnect = async (session: Session) => {
    if (!session.browser || session.disconnected) return
    session.disconnected = true
    await settleWithin(Promise.resolve().then(() => session.browser!.disconnect()), cleanupTimeout)
  }
  const close = (session: Session): Promise<void> => {
    session.closed = true
    if (session.cleanup) return session.cleanup
    const creating = [...session.creating]
    const cleanup = (async () => {
      await Promise.all([...session.pages.values()].map(page => closePage(session, page)))
      session.pages.clear()
      // Keep this client until any late newPage result can close its own tab.
      // The verified production connection also has a bounded CDP protocol timeout.
      await Promise.allSettled(creating)
      await disconnect(session)
    })()
    session.cleanup = creating.length ? settleWithin(cleanup, cleanupTimeout) : cleanup
    return session.cleanup
  }
  const ensureOpen = (session: Session) => {
    if (session.closed) throw new CommandError('Chromium session closed')
  }
  const retryNavigation = async <T>(session: Session, operation: '读取页面' | '打开页面', action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const maxAttempts = 3
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted()
      ensureOpen(session)
      try { return await action() }
      catch (error) {
        const message = error instanceof Error ? error.message : ''
        const transient = NAVIGATION_CONTEXT_ERROR.test(message)
          || (operation === '打开页面' && NAVIGATION_ABORTED_ERROR.test(message))
        if (!transient || attempt >= maxAttempts) throw error
        // Retry inside this session, before the outer failure handler releases its pages.
        // Never replay clicks, keyboard input, arbitrary eval, or paid processing.
        options.onRetry?.({ operation, attempt: attempt + 1, maxAttempts })
        await delay(500, undefined, { signal })
      }
    }
  }
  const ready = (session: Session) => session.ready ??= (async () => {
    session.browser = await connect()
    if (session.closed) {
      await disconnect(session)
      throw new CommandError('Chromium session closed')
    }
    session.context = session.browser.defaultBrowserContext()
    // Keep this installed Chrome's platform/version. Configure requests before
    // navigation, rather than changing a navigator getter after the request.
    session.userAgent = (await session.browser.userAgent()).replace(/\bHeadlessChrome\//g, 'Chrome/')
  })()
  const createPage = async (session: Session) => {
    const creating = (async () => {
      const page = await session.context!.newPage()
      if (session.closed) {
        await closePage(session, page)
        throw new CommandError('Chromium session closed')
      }
      session.activePage = randomUUID()
      session.pages.set(session.activePage, page)
      await page.setUserAgent(session.userAgent!)
      ensureOpen(session)
      return page
    })()
    session.creating.add(creating)
    try { return await creating }
    finally { session.creating.delete(creating) }
  }
  const execute = async (session: Session, command: string, parameters: string[], signal?: AbortSignal): Promise<string> => {
    if (command === 'auth') {
      if (parameters[0] !== 'status' && parameters[0] !== 'refresh') throw new CommandError('Unsupported Chromium auth command')
      const saved = await loadSession()
      ensureOpen(session)
      if (parameters[0] === 'refresh' && !saved.revision) throw new CommandError('尚未检测通过抖音采集会话，请先检测登录状态')
      return JSON.stringify({ revision: saved.revision })
    }
    await ready(session)
    ensureOpen(session)
    if (command === 'open' || (command === 'tab' && parameters[0] === 'new')) {
      const newTab = command === 'tab'
      let page = !newTab && session.activePage ? session.pages.get(session.activePage) : undefined
      if (!page) {
        page = await createPage(session)
        ensureOpen(session)
      }
      const targetPage = page
      await retryNavigation(session, '打开页面', () => targetPage.goto(parameters[newTab ? 1 : 0]!, {
        waitUntil: 'domcontentloaded', timeout: operationTimeout,
      }), signal)
      await page.bringToFront()
      ensureOpen(session)
      return JSON.stringify({ page: session.activePage })
    }
    if (command === 'tab') {
      const id = parameters[1]!
      const owned = session.pages.get(id)
      if (!owned) throw new CommandError('Unknown owned task page')
      if (parameters[0] === 'select') {
        await owned.bringToFront()
        session.activePage = id
      }
      else if (parameters[0] === 'close') {
        await closePage(session, owned)
        session.pages.delete(id)
        if (session.activePage === id) session.activePage = session.pages.keys().next().value
      } else throw new CommandError('Unsupported Chromium tab command')
      return '{}'
    }
    const page = session.activePage ? session.pages.get(session.activePage) : undefined
    if (!page) throw new CommandError('Chromium has no active task page')
    if (command === 'eval') {
      const evaluate = () => page.evaluate(parameters[0]!)
      const value = parameters[1] === '--read-only'
        ? await retryNavigation(session, '读取页面', evaluate, signal) : await evaluate()
      return JSON.stringify(value) ?? 'null'
    }
    if (command === 'scroll') {
      const amount = Number(parameters[2])
      if (parameters[0] !== 'down' || parameters[1] !== '--amount' || !Number.isFinite(amount) || amount <= 0 || amount > 10_000) {
        throw new CommandError('Invalid Chromium scroll amount')
      }
      return JSON.stringify(await page.evaluate((distance: number) => {
        let element = document.querySelector<HTMLElement>('[id^="waterfall_item_"]')
          || document.querySelector<HTMLElement>('[data-e2e="scroll-list"]')
        while (element && element !== document.body && element !== document.documentElement) {
          const style = getComputedStyle(element)
          if (/(auto|scroll)/.test(style.overflowY || style.overflow) && element.scrollHeight > element.clientHeight) {
            const before = element.scrollTop
            element.scrollBy(0, distance)
            return { target: 'element', before, after: element.scrollTop }
          }
          element = element.parentElement
        }
        const before = window.scrollY
        window.scrollBy(0, distance)
        return { target: 'window', before, after: window.scrollY }
      }, amount))
    }
    if (['focus', 'type', 'click', 'keys'].includes(command)) await page.bringToFront()
    if (command === 'focus') await page.focus(parameters[0]!)
    else if (command === 'type') {
      await page.focus(parameters[0]!)
      await page.keyboard.sendCharacter(parameters[1]!)
    }
    else if (command === 'click') await page.click(parameters[0]!)
    else if (command === 'keys') {
      const key = parameters[0]
      if (key === 'Meta+a' || key === 'Control+a') {
        const modifier = key === 'Meta+a' ? 'Meta' : 'Control'
        await page.keyboard.down(modifier)
        // Chromium headless on macOS does not consistently apply native shortcuts.
        try { await page.keyboard.press('a', { commands: ['selectAll'] }) }
        finally { await page.keyboard.up(modifier) }
      } else if (key === 'Backspace' || key === 'Enter') await page.keyboard.press(key)
      else throw new CommandError('Unsupported Chromium key')
    } else throw new CommandError('Unsupported Chromium browser command')
    return '{}'
  }
  return async (args: string[], signal?: AbortSignal): Promise<string> => {
    const [prefix, sessionId, command, ...parameters] = args
    if (prefix !== 'browser' || !sessionId || !command) throw new CommandError('Invalid Chromium browser command')
    let session = sessions.get(sessionId)
    if (command === 'close') {
      if (session) { sessions.delete(sessionId); await close(session) }
      return '{}'
    }
    signal?.throwIfAborted()
    if (!session) {
      session = { pages: new Map(), creating: new Set(), closing: new WeakMap(), closed: false, disconnected: false }
      sessions.set(sessionId, session)
    }
    try {
      return await interruptible(execute(session, command, parameters, signal), signal, operationTimeout, () => { void close(session!) })
    } catch (error) {
      if (sessions.get(sessionId) === session) sessions.delete(sessionId)
      await close(session)
      if (signal?.aborted) throw signal.reason || new DOMException('History sourcing stopped', 'AbortError')
      if (error instanceof CommandError) throw error
      const operation = { eval: '读取页面', open: '打开页面', scroll: '滚动页面', tab: '操作标签页', click: '点击页面', type: '输入搜索词', keys: '发送按键', focus: '聚焦搜索框' }[command] || '浏览器操作'
      const raw = error instanceof Error ? error.message : ''
      // Preserve a useful cause without exposing CDP endpoints, credentials or scripts.
      const reason = NAVIGATION_CONTEXT_ERROR.test(raw)
        ? '页面跳转导致读取环境失效'
        : NAVIGATION_ABORTED_ERROR.test(raw) ? '页面跳转被反复中断，自动重试后仍未恢复'
        : /target closed|session closed|connection closed|browser has disconnected/i.test(raw)
          ? '任务标签页或浏览器连接已关闭'
          : /timed out|timeout/i.test(raw) ? '浏览器响应超时'
            : '浏览器命令执行失败，请检查专用 Chromium 窗口（dedicated Chromium）'
      throw new Error(`${operation}失败：${reason}`)
    }
  }
}
