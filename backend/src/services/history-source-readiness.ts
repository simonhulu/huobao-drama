import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Browser } from 'puppeteer-core'
import { z } from 'zod'
import {
  HistoryBrowserAuthError,
  getHistoryBrowserSessionStatus,
  connectHistoryChromiumBrowser,
  loadHistoryChromiumSession,
  publishHistoryChromiumSession,
  updateHistoryBrowserReadiness,
  type HistoryBrowserReadinessCheck,
  type HistoryBrowserSessionStatus,
} from './history-source-auth.js'
import { createChromiumCommandRunner } from './history-source-chromium.js'
import {
  HISTORY_SEARCH_DOM_JS,
  HISTORY_SEARCH_INPUT_SELECTOR,
  HISTORY_SEARCH_QUERY,
  HistorySearchFilterError,
  applyHistorySearchFilters as waitForHistorySearchResults,
  historySearchCardSchema,
  historySearchStateSchema,
} from './history-source-search.js'

const snapshotSchema = z.object({
  url: z.string(), title: z.string(), bodyText: z.string(),
  search: historySearchStateSchema,
  cards: z.array(historySearchCardSchema).max(120),
})
type Snapshot = z.infer<typeof snapshotSchema>

const SNAPSHOT = `(() => {
  const results = ${HISTORY_SEARCH_DOM_JS};
  return { url: location.href, title: document.title,
    bodyText: ((document.body?.innerText || '').match(/登录后.{0,12}(?:搜索|查看|浏览)|请先登录|扫码登录|验证码|拖动滑块|完成安全验证|请完成验证|安全校验|verify_check/g) || []).join(' '),
    search: results.search, cards: results.cards,
  };
})()`

const defaultAuth = {
  getHistoryBrowserSessionStatus, connectHistoryChromiumBrowser, loadHistoryChromiumSession,
  publishHistoryChromiumSession, updateHistoryBrowserReadiness,
}

export interface HistoryBrowserReadinessOptions {
  auth?: typeof defaultAuth
  connect?: () => Promise<Browser>
  now?: () => number
  timeoutMs?: number
  pollMs?: number
}

class ReadinessFailure extends Error {
  constructor(readonly status: 'blocked' | 'login_required', message: string) { super(message) }
}

function validRoute(url: string): boolean {
  try {
    const parsed = new URL(url)
    const match = parsed.pathname.match(/^\/(?:jingxuan\/)?search\/([^/]+)\/?$/)
    return parsed.origin === 'https://www.douyin.com' && !!match && decodeURIComponent(match[1]!) === HISTORY_SEARCH_QUERY
  } catch { return false }
}

function detectGate(snapshot: Snapshot) {
  const text = `${snapshot.title} ${snapshot.bodyText}`
  if (/验证码|拖动滑块|完成安全验证|请完成验证|安全校验|verify_check/.test(text)) {
    throw new ReadinessFailure('blocked', '抖音要求安全验证，请点击“打开登录窗口”，在专用窗口完成验证后重新检测后台采集')
  }
  if (/登录后.{0,12}(搜索|查看|浏览)|请先登录|扫码登录/.test(snapshot.bodyText)) {
    throw new ReadinessFailure('login_required', '抖音要求登录，请点击“打开登录窗口”，在专用窗口完成登录后重新检测后台采集')
  }
}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}

export function createHistoryBrowserReadiness(options: HistoryBrowserReadinessOptions = {}) {
  const auth = options.auth || defaultAuth
  const now = options.now || Date.now
  let pending: Promise<HistoryBrowserSessionStatus> | undefined
  const check = async (): Promise<HistoryBrowserSessionStatus> => {
    const signal = AbortSignal.timeout(Math.min(options.timeoutMs || 120_000, 120_000))
    const checks: HistoryBrowserReadinessCheck[] = []
    let revision: string | null = null
    let stage = 'session'
    let run: ReturnType<typeof createChromiumCommandRunner> | undefined
    let browser: Browser | undefined
    let driverOwnsClient = false
    let finished = false
    const session = `history-readiness-${randomUUID()}`
    const timestamp = () => new Date(now()).toISOString()
    const state = (status: HistoryBrowserSessionStatus['status'], message: string, checkedAt: string | null = null) =>
      auth.updateHistoryBrowserReadiness({ engine: 'chromium', status, message, updatedAt: timestamp(), checkedAt, revision, checks: checks.slice(-20) })
    const step = async (name: string, message: string, outcome: 'pending' | 'passed' = 'passed') => {
      stage = name
      const previous = checks.findIndex(check => check.stage === name)
      const entry = { at: timestamp(), stage, message, outcome }
      if (previous === -1) checks.push(entry)
      else checks[previous] = entry
      await state('checking', message)
    }
    try {
      await state('checking', '正在后台检测抖音登录与实际搜索能力；专用登录窗口会关闭并保存会话')
      const connecting = (options.connect || auth.connectHistoryChromiumBrowser)()
      void connecting.then(async connected => {
        if (finished || signal.aborted) await Promise.resolve().then(() => connected.disconnect()).catch(() => {})
      }, () => {}).catch(() => {})
      browser = await bounded(connecting, signal)
      const cookies = await bounded(browser.defaultBrowserContext().cookies(), signal)
      const authenticated = cookies.some(cookie => /^(sessionid|sessionid_ss)$/.test(cookie.name) && cookie.value.trim()
        && /(^|\.)douyin\.com$/.test(cookie.domain.replace(/^\./, ''))
        && (cookie.expires === -1 || cookie.expires === undefined || cookie.expires > now() / 1000))
      await step('session', '已连接无头 Chromium，复用专用配置中的登录会话')
      run = createChromiumCommandRunner({
        connect: async () => { driverOwnsClient = true; return browser! }, operationTimeoutMs: 30_000,
        loadSession: auth.loadHistoryChromiumSession,
      })
      const command = (...args: string[]) => run!(['browser', session, ...args], signal)
      const observe = async () => {
        const snapshot = snapshotSchema.parse(JSON.parse(await command('eval', SNAPSHOT, '--read-only')))
        detectGate(snapshot)
        return snapshot
      }
      const until = async (predicate: (snapshot: Snapshot) => boolean) => {
        while (true) {
          signal.throwIfAborted()
          const snapshot = await observe()
          if (predicate(snapshot)) return snapshot
          await delay(options.pollMs || 250, undefined, { signal })
        }
      }
      await step('connect', '正在同一持久化上下文打开独立检测标签页', 'pending')
      await command('open', 'https://www.douyin.com/')
      await step('connect', '已在同一持久化上下文打开独立检测标签页')
      await step('search_input', '正在等待搜索框并输入固定历史关键词', 'pending')
      await observe()
      if (!authenticated) throw new HistoryBrowserAuthError('missing_auth')
      await until(snapshot => snapshot.search.inputVisible && snapshot.search.inputReady !== false)
      await command('focus', HISTORY_SEARCH_INPUT_SELECTOR)
      await command('keys', process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
      await command('keys', 'Backspace')
      await command('type', HISTORY_SEARCH_INPUT_SELECTOR, HISTORY_SEARCH_QUERY)
      await until(snapshot => snapshot.search.inputValue === HISTORY_SEARCH_QUERY)
      await step('search_input', '已在搜索框输入“历史”并核对输入值')
      await step('search_submit', '正在提交搜索并等待实际搜索结果', 'pending')
      await command('keys', 'Enter')
      await until(snapshot => validRoute(snapshot.url) && snapshot.search.inputValue === HISTORY_SEARCH_QUERY)
      await step('search_submit', '已按回车，核对实际“历史”搜索地址和关键词')
      await step('video_results', '正在等待“历史”的视频或图文搜索结果稳定加载', 'pending')
      const results = await waitForHistorySearchResults({
        observe, command: args => command(...args), now, signal,
        pause: milliseconds => delay(options.pollMs || milliseconds, undefined, { signal }),
      })
      await step('video_results', results.cards.length ? '已核对“历史”关键词，视频或图文卡片已稳定加载'
        : '已核对“历史”关键词，搜索结果已结束，暂无视频或图文')
      signal.throwIfAborted()
      // Only a proven usable session may release workers waiting on a new revision.
      const published = await auth.publishHistoryChromiumSession({
        message: '后台 Chromium 登录与视频及图文搜索检测通过，可以开始采集，无需保持浏览器窗口', checks,
      })
      return published.session
    } catch (error) {
      const missing = error instanceof HistoryBrowserAuthError && error.code === 'missing_auth'
      const navigationFailed = stage === 'connect' && !!browser
      const searchTimeout = signal.aborted && ['search_input', 'search_submit', 'video_results'].includes(stage)
      const resultsFailure = error instanceof HistorySearchFilterError
      const status = missing ? 'login_required' : error instanceof ReadinessFailure ? error.status : searchTimeout || resultsFailure ? 'blocked' : 'error'
      const message = missing ? '未检测到有效抖音登录，请点击“打开登录窗口”，在专用窗口登录后重新检测'
        : error instanceof ReadinessFailure ? error.message
          : resultsFailure ? error.message
            : searchTimeout ? (stage === 'search_input' ? '抖音搜索框尚未就绪'
              : stage === 'search_submit' ? '未能确认已提交的“历史”搜索地址与关键词'
                : '抖音视频或图文搜索结果未能在时限内稳定加载') + '，请重新检测；若仍失败，打开登录窗口查看抖音提示'
              : navigationFailed ? '专用 Chromium 已连接，但抖音页面加载超时或导航失败，请稍后重新检测'
                : error instanceof HistoryBrowserAuthError ? error.message : '专用 Chromium 检测失败，请查看检测步骤后重试'
      if (checks.at(-1)?.stage === stage && checks.at(-1)?.outcome === 'pending') checks.pop()
      checks.push({ at: timestamp(), stage, message, outcome: 'failed' })
      return await state(status, message, timestamp())
    } finally {
      finished = true
      await run?.(['browser', session, 'close']).catch(() => {})
      if (browser && !driverOwnsClient) {
        await Promise.race([Promise.resolve().then(() => browser!.disconnect()).catch(() => {}), delay(750)])
      }
    }
  }
  return {
    checkHistoryBrowserSession: (): Promise<HistoryBrowserSessionStatus> => {
      if (!pending) pending = check().finally(() => { pending = undefined })
      return pending
    },
  }
}

let defaultReadiness: ReturnType<typeof createHistoryBrowserReadiness> | undefined
export const checkHistoryBrowserSession = (): Promise<HistoryBrowserSessionStatus> =>
  (defaultReadiness ??= createHistoryBrowserReadiness()).checkHistoryBrowserSession()
