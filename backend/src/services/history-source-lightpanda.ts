import { randomUUID } from 'node:crypto'
import puppeteer, { type Browser, type BrowserContext, type ConnectOptions, type CookieData, type Page } from 'puppeteer-core'
import { filterHistoryBrowserSessionCookies, loadHistoryBrowserSession } from './history-source-auth.js'

export interface LightpandaCommandRunnerOptions {
  endpoint?: string
  connect?: (options: ConnectOptions) => Promise<Browser>
  operationTimeoutMs?: number
  cleanupTimeoutMs?: number
  loadSession?: () => Promise<{ revision: string | null; cookies: CookieData[] }>
}

interface Session {
  browser?: Browser
  context?: BrowserContext
  ready?: Promise<void>
  pages: Map<string, Page>
  activePage?: string
  closed: boolean
  cleanup?: Promise<void>
  revision: string | null
}

class CommandError extends Error {}

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
      timeout = setTimeout(() => { interrupt(); reject(new CommandError('Lightpanda browser operation timed out')) }, milliseconds)
    })])
  } finally {
    clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

export function createLightpandaCommandRunner(options: LightpandaCommandRunnerOptions = {}) {
  let endpoint: URL
  try {
    endpoint = new URL(options.endpoint || process.env.HISTORY_LIGHTPANDA_CDP_URL || 'ws://127.0.0.1:9240')
    if (!['ws:', 'wss:'].includes(endpoint.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error()
  } catch {
    throw new Error('Lightpanda CDP requires a credential-free loopback WebSocket endpoint')
  }
  const connect = options.connect || (connectionOptions => puppeteer.connect(connectionOptions))
  const loadSession = options.loadSession || loadHistoryBrowserSession
  const operationTimeout = options.operationTimeoutMs || 15_000
  const cleanupTimeout = options.cleanupTimeoutMs || 750
  const sessions = new Map<string, Session>()
  const close = (session: Session): Promise<void> => {
    session.closed = true
    return session.cleanup ??= (async () => {
      if (session.context) await settleWithin(Promise.resolve().then(() => session.context!.close()), cleanupTimeout)
      if (session.browser) await settleWithin(Promise.resolve().then(() => session.browser!.disconnect()), cleanupTimeout)
    })()
  }
  const importSession = async (session: Session, replace = false) => {
    const saved = await loadSession()
    if (session.closed) throw new CommandError('Lightpanda session closed')
    const cookies = filterHistoryBrowserSessionCookies(saved.cookies)
    if (replace && (!saved.revision || !cookies.length)) throw new CommandError('尚未保存有效抖音登录会话，请先确认登录')
    if (replace) {
      const previous = (await session.context!.cookies()).filter(cookie => {
        const domain = cookie.domain.toLowerCase().replace(/^\./, '')
        return domain === 'douyin.com' || domain.endsWith('.douyin.com')
      })
      if (previous.length) await session.context!.deleteCookie(...previous)
    }
    if (saved.revision && cookies.length) await session.context!.setCookie(...cookies)
    if (session.closed) throw new CommandError('Lightpanda session closed')
    session.revision = saved.revision && cookies.length ? saved.revision : null
  }
  const ready = (session: Session) => session.ready ??= (async () => {
    session.browser = await connect({ browserWSEndpoint: endpoint.href, protocolTimeout: 15_000 })
    if (session.closed) {
      await settleWithin(session.browser.disconnect(), cleanupTimeout)
      throw new CommandError('Lightpanda session closed')
    }
    const context = await session.browser.createBrowserContext()
    if (session.closed) {
      await settleWithin(context.close(), cleanupTimeout)
      await settleWithin(session.browser.disconnect(), cleanupTimeout)
      throw new CommandError('Lightpanda session closed')
    }
    session.context = context
    await importSession(session)
  })()
  const execute = async (session: Session, command: string, parameters: string[]): Promise<string> => {
    await ready(session)
    if (command === 'auth') {
      if (parameters[0] === 'refresh') await importSession(session, true)
      else if (parameters[0] !== 'status') throw new CommandError('Unsupported Lightpanda auth command')
      return JSON.stringify({ revision: session.revision })
    }
    if (command === 'open' || (command === 'tab' && parameters[0] === 'new')) {
      const newTab = command === 'tab'
      let page = !newTab && session.activePage ? session.pages.get(session.activePage) : undefined
      if (!page) {
        page = await session.context!.newPage()
        session.activePage = randomUUID()
        session.pages.set(session.activePage, page)
      }
      await page.goto(parameters[newTab ? 1 : 0]!, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      return JSON.stringify({ page: session.activePage })
    }
    if (command === 'tab') {
      const id = parameters[1]!
      const owned = session.pages.get(id)
      if (!owned) throw new CommandError('Unknown owned task page')
      if (parameters[0] === 'select') session.activePage = id
      else if (parameters[0] === 'close') {
        await owned.close()
        session.pages.delete(id)
        if (session.activePage === id) session.activePage = session.pages.keys().next().value
      } else throw new CommandError('Unsupported Lightpanda tab command')
      return '{}'
    }
    const page = session.activePage ? session.pages.get(session.activePage) : undefined
    if (!page) throw new CommandError('Lightpanda has no active task page')
    if (command === 'eval') return JSON.stringify(await page.evaluate(parameters[0]!)) ?? 'null'
    if (command === 'scroll') {
      const amount = Number(parameters[2])
      if (parameters[0] !== 'down' || parameters[1] !== '--amount' || !Number.isFinite(amount) || amount <= 0 || amount > 10_000) {
        throw new CommandError('Invalid Lightpanda scroll amount')
      }
      return JSON.stringify(await page.evaluate((distance: number) => {
        let element = document.querySelector<HTMLElement>('[data-e2e="scroll-list"]')
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
    if (command === 'focus') await page.focus(parameters[0]!)
    else if (command === 'type') await page.type(parameters[0]!, parameters[1]!)
    else if (command === 'click') await page.click(parameters[0]!)
    else if (command === 'keys') {
      const key = parameters[0]
      if (key === 'Meta+a' || key === 'Control+a') {
        // Lightpanda uses Control for select-all editing on macOS as well.
        const modifier = 'Control'
        await page.keyboard.down(modifier)
        try { await page.keyboard.press('a') }
        finally { await page.keyboard.up(modifier) }
      } else if (key === 'Backspace' || key === 'Enter') await page.keyboard.press(key)
      else throw new CommandError('Unsupported Lightpanda key')
    } else throw new CommandError('Unsupported Lightpanda browser command')
    return '{}'
  }
  return async (args: string[], signal?: AbortSignal): Promise<string> => {
    const [prefix, sessionId, command, ...parameters] = args
    if (prefix !== 'browser' || !sessionId || !command) throw new CommandError('Invalid Lightpanda browser command')
    let session = sessions.get(sessionId)
    if (command === 'close') {
      if (session) { sessions.delete(sessionId); await close(session) }
      return '{}'
    }
    signal?.throwIfAborted()
    if (!session) {
      session = { pages: new Map(), closed: false, revision: null }
      sessions.set(sessionId, session)
    }
    try {
      return await interruptible(execute(session, command, parameters), signal, operationTimeout, () => { void close(session!) })
    } catch (error) {
      if (sessions.get(sessionId) === session) sessions.delete(sessionId)
      await close(session)
      if (signal?.aborted) throw signal.reason || new DOMException('History sourcing stopped', 'AbortError')
      if (error instanceof CommandError) throw error
      throw new Error('Lightpanda browser command failed; check the local CDP service')
    }
  }
}
