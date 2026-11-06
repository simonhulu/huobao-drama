import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer, { type Browser, type CDPSession, type Page, type Target } from 'puppeteer-core'
import { readHuashengIdentity, HuashengIdentityError } from './huasheng-identity.js'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const HOME_URL = 'https://www.huasheng.cn/'
const SCHEME = 'A - 素材剪辑成片'
export type HuashengErrorCode = 'login_required' | 'manual_review' | 'browser_unavailable' | 'timeout'
export class HuashengBrowserError extends Error {
  retryable?: true
  constructor(public code: HuashengErrorCode, message: string, readonly actionNotStarted = false) { super(message); this.name = 'HuashengBrowserError' }
}
export interface HuashengBrowserStatus { status: 'ready' | 'login_required' | 'unavailable'; message: string }
/** Supplied by a server-managed account, never by a request body. */
export interface HuashengBrowserConfig { endpoint: string; profile: string; expectedUid?: string }
export type HuashengProductionStatus = 'not_started' | 'queued' | 'creating' | 'completed'
export interface HuashengProductionObservation { status: HuashengProductionStatus; message: string }
export interface HuashengCheckpoint { checkpoint: string; projectUrl?: string; message: string; videoUrl?: string; productionStatus?: 'queued' | 'creating' }
export interface HuashengBrowserInput {
  browserConfig?: HuashengBrowserConfig
  jobId: number | string
  script: string
  voiceId?: number
  voiceType?: number
  projectUrl: string | null
  checkpoint: string | null
  signal: AbortSignal
  onCheckpoint: (update: HuashengCheckpoint) => Promise<void>
}
export interface HuashengPageState {
  url: string
  loggedIn: boolean
  loginRequired: boolean
  buttons: string[]
  requirementsReady: boolean
  planReady: boolean
  productionStarted: boolean
  productionFinished: boolean
  cost: number | null
  error: string | null
  scriptPresent: boolean
  hasCreateButton?: boolean
  conversationStale?: boolean
  editorReady?: boolean
  productionQueued?: boolean
  queueVisible?: boolean
  conversationReady?: boolean
  exportDialogOpen?: boolean
  exportReady?: boolean
  schemeChoicePending?: boolean
  schemeReplyPresent?: boolean
  requirementsChoicePending?: boolean
  requirementsReplyPresent?: boolean
  standardQuotaExhausted?: boolean
}
export interface HuashengPagePort {
  read(): Promise<HuashengPageState>
  prepareAction?(): Promise<void>
  reload?(): Promise<void>
  fillScript(script: string): Promise<void>
  click(label: string): Promise<void | HuashengClickResult>
}
export interface HuashengClickResult { code: number; message: string; projectUrl?: string; requestRejected?: boolean }

export function huashengProjectUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['www.huasheng.cn', 'huasheng.cn'].includes(url.hostname)
      || url.username || url.password || url.port || !/^\/video\/\d+\/?$/.test(url.pathname)) return null
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  } catch { return null }
}

export function resolveHuashengBrowserConfig(account?: HuashengBrowserConfig) {
  const endpoint = new URL(account?.endpoint ?? (process.env.HUASHENG_CDP_URL || 'http://127.0.0.1:9243'))
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !endpoint.port) {
    throw new HuashengBrowserError('browser_unavailable', '花生浏览器地址必须是本机 HTTP 调试端口')
  }
  return {
    endpoint: endpoint.origin,
    port: endpoint.port,
    profile: path.resolve(account?.profile ?? (process.env.HUASHENG_PROFILE_DIR || path.join(ROOT, 'data/huasheng-browser-profile'))),
    chrome: process.env.HUASHENG_CHROME_PATH || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
  }
}

function retryablePreparation(error: unknown): boolean {
  if (error instanceof HuashengBrowserError) return error.cause !== undefined && retryablePreparation(error.cause)
  return /timed?\s*out|timeout|connection.*closed|target.*closed|session.*closed|websocket|ECONNRESET|ECONNREFUSED|fetch failed|net::ERR_/i.test(String(error))
}

// Puppeteer's protocolTimeout does not bound browserURL discovery or cancellation.
// A browser that finishes connecting after cancellation is detached immediately.
async function preparationStep<T>(work: Promise<T>, signal?: AbortSignal, timeout = 25_000,
  disposeLate?: (value: T) => Promise<unknown>): Promise<T> {
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let aborted: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error) } }
      aborted = () => fail(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      timer = setTimeout(() => fail(new Error('Huasheng browser preparation timed out')), timeout)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
      work.then(value => {
        if (settled) { void disposeLate?.(value).catch(() => {}); return }
        settled = true; resolve(value)
      }, fail)
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (aborted) signal?.removeEventListener('abort', aborted)
  }
}

function connectionFailure(error: unknown, signal?: AbortSignal): HuashengBrowserError {
  signal?.throwIfAborted()
  if (error instanceof HuashengBrowserError) return error
  const failure = new HuashengBrowserError('browser_unavailable', retryablePreparation(error)
    ? '花生浏览器连接或页面初始化暂时无响应，尚未开始本次页面操作；请稍后继续原任务'
    : '花生专用浏览器未连接，请打开登录窗口')
  failure.cause = error
  if (retryablePreparation(error)) failure.retryable = true
  return failure
}

async function connectBrowser(account?: HuashengBrowserConfig, signal?: AbortSignal, attempts = 2): Promise<Browser> {
  const settings = resolveHuashengBrowserConfig(account)
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted()
    let browser: Browser | undefined
    try {
      browser = await preparationStep(puppeteer.connect({ browserURL: settings.endpoint, defaultViewport: null, protocolTimeout: 20_000 }),
        signal, 25_000, browser => browser.disconnect())
      // Never take over a personal/publishing profile that happens to occupy this port.
      const session = await preparationStep(browser.target().createCDPSession(), signal, 5000, session => session.detach())
      try {
        const result = await preparationStep(session.send('Browser.getBrowserCommandLine', undefined, { timeout: 5000 }), signal, 5500)
        const argument = result.arguments.find(value => value.startsWith('--user-data-dir='))
        if (!argument || path.resolve(argument.slice('--user-data-dir='.length)) !== settings.profile) {
          throw new HuashengBrowserError('browser_unavailable', '该端口不是花生专用浏览器，请检查 HUASHENG_CDP_URL 和 HUASHENG_PROFILE_DIR')
        }
      } finally { await session.detach().catch(() => {}) }
      if (account?.expectedUid) {
        try {
          const identity = await readHuashengIdentity(browser, signal)
          if (identity.uid !== account.expectedUid) throw new HuashengIdentityError('mismatch', '当前登录用户与任务绑定的花生账号不一致，请登录原账号')
        } catch (error) {
          signal?.throwIfAborted()
          if (error instanceof HuashengIdentityError) {
            const failure = new HuashengBrowserError(error.code === 'login_required' ? 'login_required'
              : error.code === 'mismatch' ? 'manual_review' : 'browser_unavailable', error.message, true)
            if (error.code === 'unavailable' && error.retryable) failure.retryable = true
            throw failure
          }
          throw error
        }
      }
      signal?.throwIfAborted()
      return browser
    } catch (error) {
      await browser?.disconnect().catch(() => {})
      signal?.throwIfAborted()
      if (attempt + 1 < attempts && retryablePreparation(error)) { await delay(250, undefined, { signal }); continue }
      throw connectionFailure(error, signal)
    }
  }
  throw new HuashengBrowserError('browser_unavailable', '花生浏览器连接失败，请稍后继续原任务')
}

// API exports share the same dedicated-profile check as the UI automation.
export { connectBrowser as connectHuashengBrowser }

const isHuashengPage = (target: Target) => target.type() === 'page' && /^https:\/\/(www\.)?huasheng\.cn\//.test(target.url())
const isHomepage = (target: Target) => isHuashengPage(target) && new URL(target.url()).pathname === '/'

// browser.pages() initializes every retained tab (including Performance.enable).
// Inspect target metadata first and initialize only the page this operation needs.
async function namedTarget(browser: Browser, marker: string, signal: AbortSignal): Promise<Target | undefined> {
  const candidates = browser.targets().filter(isHuashengPage)
  const matches = await Promise.all(candidates.map(async target => {
    let session
    try {
      session = await preparationStep(target.createCDPSession(), signal, 2000, value => value.detach())
      const result = await preparationStep(session.send('Runtime.evaluate', {
        expression: 'window.name', returnByValue: true, timeout: 1000,
      }, { timeout: 1500 }), signal, 2000)
      return result.result.value === marker ? target : undefined
    } catch { signal.throwIfAborted(); return undefined }
    finally { await session?.detach().catch(() => {}) }
  }))
  const owned = matches.filter((target): target is Target => Boolean(target))
  if (owned.length > 1) throw new HuashengBrowserError('manual_review', '发现多个本任务窗口，请保留原项目窗口后继续，尚未执行页面操作')
  return owned[0]
}

interface TemporaryTarget { targetId?: string; url: string; closing?: Promise<boolean> }
const temporaryTargets = new WeakMap<Page, TemporaryTarget>()

async function closeTemporaryTarget(browser: Browser, owned: TemporaryTarget, original?: CDPSession): Promise<boolean> {
  let inspected = false
  const close = async (session: CDPSession) => {
    try {
      if (!owned.targetId) {
        inspected = false
        const { targetInfos } = await session.send('Target.getTargets', undefined, { timeout: 1500 })
        inspected = true
        owned.targetId = targetInfos.find(target => target.type === 'page' && target.url === owned.url)?.targetId
      }
      return owned.targetId ? (await session.send('Target.closeTarget', { targetId: owned.targetId }, { timeout: 1500 })).success : false
    } catch { return false }
  }
  if (original && await close(original)) return true
  let fresh: CDPSession | undefined
  try {
    fresh = await preparationStep(browser.target().createCDPSession(), undefined, 2500, session => session.detach())
    // A timed-out create can become visible shortly after its rejected command.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await close(fresh)) return true
      if (owned.targetId) break
      if (attempt < 4) await delay(250)
    }
    if (owned.targetId) {
      const { targetInfos } = await fresh.send('Target.getTargets', undefined, { timeout: 1500 })
      if (!targetInfos.some(target => target.targetId === owned.targetId)) return true
    } else if (inspected) return true
  } catch { /* Preserve the original operation failure or cancellation. */ }
  finally { if (fresh) await preparationStep(fresh.detach(), undefined, 1500).catch(() => {}) }
  console.warn('[huasheng-browser] temporary target cleanup failed', owned.targetId || owned.url)
  return false
}

export async function closeHuashengTemporaryPage(browser: Browser, page: Page): Promise<boolean> {
  const owned = temporaryTargets.get(page)
  if (!owned) return preparationStep(page.close(), undefined, 2500).then(() => true, () => false)
  const closing = owned.closing ??= closeTemporaryTarget(browser, owned)
  const closed = await closing
  if (!closed && owned.closing === closing) owned.closing = undefined
  return closed
}

// Ownership is recorded before creation: CDP can time out after Chrome creates the tab.
export async function createHuashengTemporaryPage(browser: Browser, signal?: AbortSignal): Promise<Page> {
  signal?.throwIfAborted()
  const session = await preparationStep(browser.target().createCDPSession(), signal, 5000, value => value.detach())
  const owned: TemporaryTarget = { url: `about:blank#huobao-huasheng-${randomUUID()}` }
  let creation: Promise<{ targetId: string }> | undefined
  try {
    signal?.throwIfAborted()
    creation = session.send('Target.createTarget', { url: owned.url, background: true }, { timeout: 5000 })
    const created = await preparationStep(creation, signal, 5500)
    owned.targetId = created.targetId
    const target = await preparationStep(browser.waitForTarget(target => target.type() === 'page' && target.url() === owned.url, { timeout: 5000 }), signal, 5500)
    const page = await preparationStep(target.page(), signal)
    if (!page) throw new Error('Huasheng page target closed during initialization')
    signal?.throwIfAborted()
    temporaryTargets.set(page, owned)
    return page
  } catch (error) {
    // Cancellation can arrive after Chrome creates the tab but before its ID
    // reaches us. Settle this bounded command before the caller disconnects.
    owned.targetId ??= (await creation?.catch(() => undefined))?.targetId
    if (creation) await closeTemporaryTarget(browser, owned, session)
    throw error
  } finally { await preparationStep(session.detach(), undefined, 1500).catch(() => {}) }
}

async function prepareBrowser<T>(account: HuashengBrowserConfig | undefined, signal: AbortSignal | undefined,
  prepare: (browser: Browser, newPage: () => Promise<Page>) => Promise<T>, initial?: Browser): Promise<{ browser: Browser; result: T }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let browser = attempt === 0 ? initial : undefined
    const owned: Page[] = []
    try {
      signal?.throwIfAborted()
      browser ??= await connectBrowser(account, signal, 1)
      const active = browser
      const result = await prepare(active, async () => {
        const page = await createHuashengTemporaryPage(active, signal)
        owned.push(page)
        return page
      })
      signal?.throwIfAborted()
      return { browser, result }
    } catch (error) {
      await Promise.allSettled(owned.map(page => closeHuashengTemporaryPage(browser!, page)))
      await browser?.disconnect().catch(() => {})
      signal?.throwIfAborted()
      if (attempt === 0 && retryablePreparation(error)) { await delay(250, undefined, { signal }); continue }
      throw connectionFailure(error, signal)
    }
  }
  throw new HuashengBrowserError('browser_unavailable', '花生页面准备失败，请稍后继续原任务')
}

const opening = new Map<string, Promise<HuashengBrowserStatus>>()
export async function openHuashengBrowser(account?: HuashengBrowserConfig, signal?: AbortSignal): Promise<HuashengBrowserStatus> {
  const settings = resolveHuashengBrowserConfig(account)
  const key = JSON.stringify([settings.endpoint, settings.profile])
  const existing = signal ? undefined : opening.get(key)
  if (existing) return existing
  const work = (async () => {
    let browser: Browser | undefined
    try { browser = await connectBrowser(account, signal) } catch (error) {
      signal?.throwIfAborted()
      // An occupied port must not be silently replaced with another browser.
      let occupied = false
      try { occupied = (await fetch(`${settings.endpoint}/json/version`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) })).ok } catch {}
      signal?.throwIfAborted()
      if (occupied) throw error
      if (!fs.existsSync(settings.chrome)) throw new HuashengBrowserError('browser_unavailable', '未找到 Chrome，请配置 HUASHENG_CHROME_PATH')
      fs.mkdirSync(settings.profile, { recursive: true, mode: 0o700 })
      fs.chmodSync(settings.profile, 0o700)
      const log = fs.openSync(path.join(settings.profile, 'chrome.log'), 'a', 0o600)
      const child = spawn(settings.chrome, [`--remote-debugging-port=${settings.port}`, '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${settings.profile}`, '--enable-automation', '--no-first-run', '--no-default-browser-check',
        '--window-size=1440,1000', 'about:blank'], { detached: true, stdio: ['ignore', log, log] })
      let launchError: Error | undefined
      child.on('error', error => { launchError = error })
      child.unref()
      fs.closeSync(log)
      const until = Date.now() + 15_000
      while (!browser && Date.now() < until) {
        if (launchError) throw new HuashengBrowserError('browser_unavailable', '花生专用浏览器启动失败')
        await delay(500, undefined, { signal })
        try { browser = await connectBrowser(account, signal, 1) } catch { signal?.throwIfAborted() }
      }
      if (!browser) throw new HuashengBrowserError('browser_unavailable', '花生专用浏览器启动超时，请检查专用窗口')
    }
    const prepared = await prepareBrowser(account, signal, async (active, newPage) => {
      const targets = active.targets()
      const target = targets.find(isHomepage) ?? targets.find(candidate => candidate.type() === 'page' && candidate.url() === 'about:blank')
      const page = target ? await preparationStep(target.page(), signal) : await newPage()
      if (!page) throw new Error('Huasheng page target closed')
      if (!isHomepage(page.target())) await preparationStep(page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }), signal, 46_000)
      await preparationStep(page.bringToFront(), signal)
      return await readBrowserStatus(page, signal)
    }, browser)
    try { return prepared.result } finally { await prepared.browser.disconnect().catch(() => {}) }
  })().finally(() => { if (!signal) opening.delete(key) })
  if (!signal) opening.set(key, work)
  return work
}

async function readBrowserStatus(page: Page, signal?: AbortSignal): Promise<HuashengBrowserStatus> {
  const until = Date.now() + 15_000
  const port = createHuashengPagePort(page)
  let loginSince: number | undefined
  while (Date.now() < until) {
    signal?.throwIfAborted()
    const state = await preparationStep(port.read(), signal, 5000)
    if (state.loggedIn && !state.loginRequired) return { status: 'ready', message: '花生专用浏览器已登录，制作队列可运行' }
    // The homepage renders Create (and sometimes Login) before restoring its saved session.
    // Only a stable login prompt is evidence that user authentication is needed.
    if (state.loginRequired) {
      loginSince ??= Date.now()
      if (Date.now() - loginSince >= 1500) return { status: 'login_required', message: '请在花生专用浏览器完成登录；登录保留在本机专用目录' }
    } else loginSince = undefined
    await delay(250, undefined, { signal })
  }
  return { status: 'unavailable', message: '花生登录状态尚未加载完成，请稍后重试检查' }
}
export async function getHuashengBrowserStatus(account?: HuashengBrowserConfig): Promise<HuashengBrowserStatus> {
  let browser: Browser | undefined
  try {
    const prepared = await prepareBrowser(account, undefined, async active => {
      const targets = active.targets()
      const target = targets.find(isHomepage) ?? targets.find(isHuashengPage)
      if (!target) return { status: 'login_required', message: '请打开花生登录窗口并完成登录' } as HuashengBrowserStatus
      const page = await preparationStep(target.page())
      if (!page) throw new Error('Huasheng page target closed')
      return await readBrowserStatus(page)
    })
    browser = prepared.browser
    return prepared.result
  } catch (error) {
    return { status: 'unavailable', message: error instanceof HuashengBrowserError ? error.message : '花生浏览器检测失败，请重新打开登录窗口' }
  } finally { await browser?.disconnect().catch(() => {}) }
}

// Only rendered, enabled controls are actionable. Historical choices remain in
// the chat as disabled buttons and must never cause an earlier step to replay.
const DOM_READ = `(() => {
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[aria-hidden="true"]'));
  const normalize = text => (text || '').replace(/\\s+/g, ' ').trim();
  const controls = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const controlLabels = controls.map(el => normalize(el.innerText || el.getAttribute('aria-label')));
  const buttons = controls.filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true').map(el => normalize(el.innerText || el.getAttribute('aria-label')));
  const body = document.body?.innerText || '';
  // Read the reply belonging to this choice card, not a matching phrase in the
  // script or the assistant's recommendation. A click alone is not acceptance.
  const schemeControl = controls.filter(el => normalize(el.innerText) === 'A - 素材剪辑成片').at(-1);
  const schemeCard = schemeControl?.parentElement?.parentElement;
  const schemeReplyPresent = !!schemeCard && [...schemeCard.querySelectorAll('.self-end')]
    .some(el => visible(el) && normalize(el.innerText) === 'A - 素材剪辑成片');
  const schemeChoicePending = !!schemeCard && !schemeReplyPresent
    && /请选择制作方案/.test(schemeCard.innerText)
    && ['A - 素材剪辑成片', 'B - 素材混合MG动画'].every(label =>
      [...schemeCard.querySelectorAll('button')].some(el => visible(el) && !el.disabled
        && el.getAttribute('aria-disabled') !== 'true' && normalize(el.innerText) === label));
  const requirementsControl = controls.filter(el => normalize(el.innerText) === '确认'
    && /确认是否满足你的创作需求/.test(el.parentElement?.parentElement?.innerText || '')).at(-1);
  const requirementsCard = requirementsControl?.parentElement?.parentElement;
  const requirementsReplyPresent = !!requirementsCard && [...requirementsCard.querySelectorAll('.self-end')]
    .some(el => visible(el) && normalize(el.innerText) === '确认');
  const requirementsChoicePending = !!requirementsCard && !requirementsReplyPresent
    && ['确认', '需要修改'].every(label => [...requirementsCard.querySelectorAll('button')]
      .some(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
        && normalize(el.innerText) === label));
  const alerts = [...document.querySelectorAll('[role="alert"],.ant-message-error,.ant-notification-notice-error')].filter(visible).map(el => normalize(el.innerText)).filter(Boolean);
  const dialogs = [...document.querySelectorAll('[role="dialog"],.ant-modal')].filter(visible);
  const loginRequired = dialogs.some(el => /扫码登录|验证码登录|登录后|登录注册/.test(el.innerText)) || buttons.some(text => /^(登录|立即登录|登录 \\/ 注册|登录\\/注册)$/.test(text));
  const texts = [...document.querySelectorAll('span,div,p')].filter(el => visible(el) && normalize(el.innerText) === '总预估消耗');
  const progress = [...document.querySelectorAll('span,div,p')].filter(visible).map(el => normalize(el.innerText));
  const standardQuotaExhausted = progress.includes('今日标准模式额度已用完')
    && controlLabels.some(text => /^(?:快速模式继续|使用快速模式加速)(?:\\s|$)/.test(text));
  // A chat acknowledgement or preparation progress is not entry to production.
  // Require the real editor's transport, editing controls and storyboard surface.
  const editorTransport = ['上一分镜', '下一分镜'].every(label => controlLabels.includes(label))
    || (controlLabels.some(label => /^(播放|暂停)$/.test(label))
      && progress.some(text => /^分镜总数\\s*\\d+$/.test(text))
      && progress.some(text => /^总时长\\s*\\d{2}:\\d{2}:\\d{2}$/.test(text)));
  const editorReady = ['撤销', '重做', '导出'].every(label => controlLabels.includes(label))
    && editorTransport && progress.some(text => /^分镜\\d+$/.test(text));
  // Scope to Huasheng's rendered scheduling card, not matching words in a script/chat quote.
  const queueVisible = [...document.querySelectorAll('div.mx-auto.mt-3.rounded-xl.flex.flex-col.items-center span')]
    .some(el => visible(el) && /^(?:算力引擎调度中，请稍等\\.{3}|专属\\s*快速模式\\s*通道加速中)$/.test(normalize(el.innerText)));
  const productionQueued = editorReady && queueVisible;
  const productionStarted = editorReady;
  const exportDialog = dialogs.find(el => /导出发布/.test(el.innerText));
  const exportReady = !!exportDialog && [...exportDialog.querySelectorAll('button,[role="button"]')].some(el =>
    visible(el) && !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true'
    && normalize(el.innerText || el.getAttribute('aria-label')) === '下载成片');
  let cost = null;
  for (const label of texts) {
    let parent = label.parentElement;
    for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      const text = normalize(parent.innerText);
      const match = /^总预估消耗\\s*([\\d,.]+)$/.exec(text);
      if (match) { cost = Number(match[1].replace(/,/g,'')); break; }
    }
    if (cost !== null) break;
  }
  return { url: location.href, loggedIn: /我的会员/.test(body) && !loginRequired, loginRequired, buttons,
    hasCreateButton: controls.some(el => normalize(el.innerText) === '创建'),
    conversationStale: /当前对话有正在进行的任务[，,]\\s*本地内容可能不是最新的/.test(body),
    requirementsReady: /成片需求已完成|确认是否满足你的创作需求/.test(body) && /视频成片需求/.test(body),
    planReady: /创作规划书/.test(body) && /分镜方案.*已生成|分镜方案已经生成|生成完成/.test(body),
    productionStarted, editorReady, productionQueued, queueVisible, schemeChoicePending, schemeReplyPresent,
    requirementsChoicePending, requirementsReplyPresent, standardQuotaExhausted,
    conversationReady: controlLabels.includes('打开导航菜单') && /输入你的任何想法/.test(body),
    exportDialogOpen: !!exportDialog, exportReady,
    productionFinished: productionStarted && progress.some(text => /^视频已经制作完成(?:\\s*🎉)?$/.test(text)), cost, error: alerts.join('；') || null,
    scriptPresent: false };
})()`

export function createHuashengPagePort(page: Page, script = '', beforeAction?: () => Promise<void>): HuashengPagePort {
  return {
    prepareAction: beforeAction,
    async reload() {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    },
    async read() {
      const state = await page.evaluate(DOM_READ) as HuashengPageState
      if (script) {
        // Shared openings are not project identity: require the complete saved
        // narration after the conversation loads, never just its first 80 chars.
        const narration = script.trim().replace(/\s/g, '')
        state.scriptPresent = Boolean(await page.evaluate(`(document.body?.innerText || '').replace(/\\s/g,'').includes(${JSON.stringify(narration)})`))
      }
      return state
    },
    async fillScript(value) {
      const timeout = Math.min(page.getDefaultTimeout() || 20_000, 20_000)
      const usable = `(el) => {
        const bounds = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (!el.isConnected || bounds.width <= 0 || bounds.height <= 0 || parseFloat(style.height) === 0
          || el.matches(':disabled') || el.hasAttribute('disabled')
          || el.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]')) return false;
        for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
          const appearance = getComputedStyle(ancestor);
          if (appearance.visibility !== 'visible' || appearance.display === 'none' || Number(appearance.opacity) === 0) return false;
        }
        return true;
      }`
      const editors = `[...document.querySelectorAll('textarea,[contenteditable="true"],[contenteditable="plaintext-only"]')]
        .filter(${usable}).filter(el => !el.readOnly && !el.hasAttribute('readonly')
          && !el.closest('[aria-readonly="true"]') && (el.tagName === 'TEXTAREA' || el.isContentEditable))`
      // Login and Create can render before the controlled editor has hydrated.
      const ready = await page.waitForFunction(`(() => {
        const candidates = ${editors};
        return candidates.length === 1 ? candidates[0] : false;
      })()`, { polling: 100, timeout }).catch(() => null)
      const editor = ready?.asElement()
      if (!editor) throw new HuashengBrowserError('manual_review', '花生文稿输入框不唯一或尚未加载，未提交稿件')
      try {
        await editor.focus()
        await editor.evaluate(el => {
          if (el instanceof HTMLTextAreaElement) el.select()
          else {
            const range = document.createRange()
            range.selectNodeContents(el)
            const selection = window.getSelection()
            selection?.removeAllRanges()
            selection?.addRange(range)
          }
        })
        if (await editor.evaluate(el => el.nodeName === 'TEXTAREA')) {
          await page.keyboard.sendCharacter(value)
        } else {
          // Chromium inserts extra visual newlines for blank contenteditable blocks.
          const lines = value.replace(/\r\n/g, '\n').split('\n')
          for (let index = 0; index < lines.length; index++) {
            if (index) {
              await page.keyboard.down('Shift')
              try { await page.keyboard.press('Enter') } finally { await page.keyboard.up('Shift') }
            }
            if (lines[index]) await page.keyboard.sendCharacter(lines[index]!)
          }
        }
      } finally {
        await ready?.dispose()
      }
      const expected = value.replace(/\r\n/g, '\n').trim()
      const deadline = Date.now() + timeout
      let stableSince: number | undefined
      while (Date.now() < deadline) {
        const state = await page.evaluate(`(() => {
          const candidates = ${editors};
          const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(${usable})
            .filter(el => (el.innerText || '').replace(/\\s+/g, ' ').trim() === '创建');
          const counter = candidates.length === 1
            ? candidates[0].closest('.ant-input-textarea-show-count')?.querySelector('.ant-input-data-count') : null;
          const count = counter ? /^\\s*(\\d+)\\s*\\/\\s*10000\\s*$/.exec(counter.innerText || '') : null;
          return { actual: candidates.length === 1 ? (candidates[0].value ?? candidates[0].innerText) : null,
            canCreate: buttons.length === 1, count: counter ? (count ? Number(count[1]) : -1) : null };
        })()`) as { actual: string | null; canCreate: boolean; count: number | null }
        if (state.actual === null || state.actual.replace(/\r\n/g, '\n').trim() !== expected) {
          throw new HuashengBrowserError('manual_review', '花生输入框中的文稿与保存稿不一致，未点击创建')
        }
        // The homepage's Create button can look disabled without a disabled attribute.
        // Its associated Ant Design counter proves React has accepted the full value.
        if (state.canCreate && (state.count === null || state.count === value.replace(/\r\n/g, '\n').length)) {
          stableSince ??= Date.now()
          if (Date.now() - stableSince >= 300) return
        } else stableSince = undefined
        await delay(100)
      }
      throw new HuashengBrowserError('manual_review', '文稿已填写，但创建按钮仍不可用；请检查花生页面提示后恢复，尚未提交创建')
    },
    async click(label) {
      const controls = await page.$$('button,[role="button"]')
      const matches = []
      for (const control of controls) {
        if (!await control.isVisible()) continue
        const matched = await control.evaluate((el, text) => {
          const button = el as HTMLButtonElement
          return !button.disabled && el.getAttribute('aria-disabled') !== 'true'
            && (button.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() === text
        }, label)
        if (matched) matches.push(control)
      }
      if (matches.length !== 1) throw new HuashengBrowserError('manual_review', `花生“${label}”按钮不唯一或不可用，尚未点击`, true)
      // HTTP 200 can still be a rejected production request (e.g. code 10008).
      // Observe only the response caused by this project's confirmation, never
      // replay the endpoint directly or persist credentials/request metadata.
      const receiptAbort = new AbortController()
      const currentProject = huashengProjectUrl(page.url())
      const creating = label === '创建' && Boolean(script.trim()) && page.url().startsWith(HOME_URL)
      const receipt = creating || /^(?:[\d,.]+ )?确认并继续$/.test(label) && currentProject
        ? page.waitForResponse(response => {
          try {
            const url = new URL(response.url())
            const request = response.request()
            if (url.origin !== new URL(currentProject || HOME_URL).origin || request.method() !== 'POST') return false
            const body = JSON.parse(request.postData() || '{}')
            return creating
              ? url.pathname === '/api/huasheng/project/create' && typeof body.script === 'string'
                && body.script.replace(/\r\n/g, '\n').trim() === script.replace(/\r\n/g, '\n').trim()
              : url.pathname === '/api/huasheng/project_plan/confirm'
                && String(body.pid) === new URL(currentProject!).pathname.split('/').at(-1)
          } catch { return false }
        }, { timeout: 5000, signal: receiptAbort.signal }).then(async response => {
          const body = await response.json() as { code?: unknown; message?: unknown; data?: { pid?: unknown } }
          if (typeof body.code !== 'number') return undefined
          const pid = String(body.data?.pid ?? '')
          const createdProject = creating && response.ok() && body.code === 0 && /^\d+$/.test(pid)
            ? huashengProjectUrl(`${new URL(HOME_URL).origin}/video/${pid}`) : null
          return { code: response.ok() ? body.code : response.status(),
            message: typeof body.message === 'string' ? body.message.slice(0, 350) : '',
            ...(createdProject ? { projectUrl: createdProject } : {}),
            ...(creating && response.ok() && body.code !== 0 ? { requestRejected: true } : {}) }
        }).catch(() => undefined)
        : undefined
      try {
        await matches[0]!.click()
        return await receipt
      } finally { receiptAbort.abort() }
    },
  }
}

/** Observe the platform without creating, confirming, downloading or publishing.
 * The export launcher only opens its availability dialog; its final buttons are never clicked. */
export async function inspectHuashengPage(port: HuashengPagePort, input: {
  projectUrl: string; checkpoint?: string | null; script?: string; signal: AbortSignal
}, options: { now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; timeoutMs?: number; pollMs?: number } = {}): Promise<HuashengProductionObservation> {
  const projectUrl = huashengProjectUrl(input.projectUrl)
  if (!projectUrl) throw new HuashengBrowserError('manual_review', '花生项目链接无效，无法检查创作状态')
  const now = options.now || Date.now
  const wait = options.sleep || ((ms, signal) => delay(ms, undefined, { signal }))
  const until = now() + (options.timeoutMs ?? 30_000)
  let exportOpenedAt: number | undefined
  let exportOpenAttempts = 0
  let notStartedAt: number | undefined
  let refreshed = false
  let readRetries = 0
  while (now() < until) {
    input.signal.throwIfAborted()
    let state: HuashengPageState
    try { state = await port.read(); readRetries = 0 }
    catch (error) {
      if (readRetries++ < 3 && /execution context was destroyed|cannot find context|detached frame/i.test(String(error))) {
        await wait(300, input.signal); continue
      }
      throw error
    }
    input.signal.throwIfAborted()
    if (state.loginRequired) throw new HuashengBrowserError('login_required', '花生登录已失效，创作状态未更新')
    if (state.error) throw new HuashengBrowserError('manual_review', `花生检查失败：${state.error.slice(0, 350)}`)
    if (huashengProjectUrl(state.url) !== projectUrl) throw new HuashengBrowserError('manual_review', '未打开对应花生项目，创作状态未更新')
    // Recovery can attach a manually identified project. Verify the saved script
    // after hydration before treating another project's ready video as our output.
    if (input.script && !state.scriptPresent) { await wait(options.pollMs ?? 500, input.signal); continue }
    const finalConfirmation = input.checkpoint === 'confirm_pending' || input.checkpoint === 'submitted'
    if (state.queueVisible && (state.editorReady || finalConfirmation)) {
      return { status: 'queued', message: '花生显示算力调度排队，等待制作' }
    }
    if (state.conversationStale) {
      if (!refreshed && state.buttons.includes('刷新对话')) {
        input.signal.throwIfAborted()
        await port.click('刷新对话')
        refreshed = true
      }
    } else if (state.editorReady) {
      if (state.exportDialogOpen) return state.exportReady
        ? { status: 'completed', message: '花生导出发布窗口已允许下载成片' }
        : { status: 'creating', message: '已进入视频编辑页，成片暂不可导出' }
      if (!state.buttons.includes('导出')) return { status: 'creating', message: '已进入视频编辑页，导出尚不可用' }
      if (exportOpenedAt === undefined || (exportOpenAttempts < 2 && now() - exportOpenedAt >= 5000)) {
        input.signal.throwIfAborted()
        await port.click('导出')
        exportOpenAttempts++
        exportOpenedAt = now()
      } else if (exportOpenAttempts >= 2 && now() - exportOpenedAt >= 5000) {
        // The editor can expose an enabled launcher before generation or
        // hydration makes it responsive. Keep polling the accepted production;
        // only an available download in its export dialog proves completion.
        return { status: 'creating', message: '已进入视频编辑页，正在等待导出开放' }
      }
    } else if (state.standardQuotaExhausted) {
      return { status: 'not_started', message: '花生今日标准模式额度已用完，项目尚未进入制作' }
    } else if (state.conversationReady || state.requirementsReady || state.planReady || state.buttons.includes(SCHEME)) {
      // Wait through initial hydration before reporting a pre-production conversation.
      notStartedAt ??= now()
      // A durable local intent cannot overrule a freshly loaded unanswered plan.
      // Quota rejection notices may only exist in the original tab, so inspection
      // also recognizes the server-rendered choice after allowing hydration.
      const unansweredPlan = state.planReady && state.buttons.includes('确认，开始制作') && state.buttons.includes('需要调整')
      if ((!finalConfirmation && now() - notStartedAt >= 1000)
        || (unansweredPlan && now() - notStartedAt >= 10_000)) {
        return { status: 'not_started', message: '花生项目仍在方案或需求阶段，尚未进入视频编辑页或制作队列' }
      }
    }
    await wait(options.pollMs ?? 500, input.signal)
  }
  throw new HuashengBrowserError('timeout', '花生项目状态尚未加载完成，保留上次检查结果')
}

export async function inspectHuashengProject(input: {
  projectUrl: string; checkpoint?: string | null; script?: string; signal: AbortSignal; browserConfig?: HuashengBrowserConfig
}): Promise<HuashengProductionObservation> {
  const projectUrl = huashengProjectUrl(input.projectUrl)
  if (!projectUrl) throw new HuashengBrowserError('manual_review', '花生项目链接无效，无法检查创作状态')
  input.signal.throwIfAborted()
  const prepared = await prepareBrowser(input.browserConfig, input.signal, async (_browser, newPage) => {
    const page = await newPage()
    page.setDefaultTimeout(10_000)
    await preparationStep(page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }), input.signal, 31_000)
    return page
  })
  const { browser, result: page } = prepared
  const aborted = () => { void closeHuashengTemporaryPage(browser, page) }
  input.signal.addEventListener('abort', aborted, { once: true })
  try {
    input.signal.throwIfAborted()
    return await inspectHuashengPage(createHuashengPagePort(page, input.script), { ...input, projectUrl })
  } finally {
    input.signal.removeEventListener('abort', aborted)
    // Close only this temporary inspection tab, preserving all task and user tabs.
    await closeHuashengTemporaryPage(browser, page)
    await browser.disconnect().catch(() => {})
  }
}

/** Checkpoint before each mutation. Recovery observes the existing project;
 * uncertain creates/confirmations are never blindly sent a second time. */
export async function driveHuashengPage(port: HuashengPagePort, input: HuashengBrowserInput,
  options: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
  const now = options.now || Date.now
  const until = now() + (options.timeoutMs ?? 30 * 60_000)
  const wait = options.sleep || ((ms, signal) => delay(ms, undefined, { signal }))
  let checkpoint = input.checkpoint || 'opening'
  let projectUrl = huashengProjectUrl(input.projectUrl)
  let lastState: HuashengPageState | undefined
  const clicked = new Set<string>()
  let readRetries = 0
  let checkpointAt = now()
  let conversationRefreshes = 0
  let lastConversationRefreshAt = -Infinity
  let schemeAttempts = 0
  let schemeReplyObservedAt: number | undefined
  let schemeReplyReported = false
  let requirementsAttempts = 0
  let requirementsReplyObservedAt: number | undefined
  let requirementsReplyReported = false
  let choiceReloads = 0
  let lastChoiceReloadAt = -Infinity
  const save = async (next: string, message: string, productionStatus?: 'queued' | 'creating') => {
    input.signal.throwIfAborted()
    await input.onCheckpoint({ checkpoint: next, ...(projectUrl ? { projectUrl } : {}), message, ...(productionStatus ? { productionStatus } : {}) })
    input.signal.throwIfAborted()
    checkpoint = next
    checkpointAt = now()
  }
  const click = async (next: string, label: string, message: string) => {
    const previous = checkpoint
    await port.prepareAction?.()
    await save(next, message)
    input.signal.throwIfAborted()
    let result: void | HuashengClickResult
    try { result = await port.click(label) }
    catch (error) {
      // Only definite pre-action failures may undo the pending intention.
      // Unknown click/network outcomes keep their checkpoint to prevent replay.
      if (error instanceof HuashengBrowserError && error.actionNotStarted) {
        await save(next === 'create_pending' ? 'opening' : previous,
          next === 'create_pending' ? '尚未提交创建，已保留文稿；处理提示后可继续原任务' : '尚未执行本次操作，已恢复原步骤；处理提示后可继续原任务')
      }
      throw error
    }
    clicked.add(label)
    if (next === 'create_pending' && result) {
      if (result.requestRejected) {
        const message = `花生拒绝创建：${result.message || result.code}；未创建项目，可以处理后继续`
        await save('opening', message)
        throw new HuashengBrowserError('manual_review', message)
      }
      const createdProject = result.code === 0 && huashengProjectUrl(result.projectUrl)
      if (createdProject) {
        projectUrl = createdProject
        await save('created', '花生已接收完整文稿并返回项目，等待制作方案')
      }
    }
    if (next === 'confirm_pending' && result?.code === 10008) {
      const message = '花生返回 10008：标准模式每日额度已用完，尚未进入制作；保留标准模式，待额度恢复后从原项目继续'
      await save('quota_waiting', message)
      throw new HuashengBrowserError('manual_review', message)
    }
    if (next === 'confirm_pending' && result && result.code !== 0) {
      throw new HuashengBrowserError('manual_review', `花生拒绝确认制作（${result.code}）：${result.message || '请检查原项目'}`)
    }
  }
  if (!input.script.trim() || input.script.length > 10_000) {
    throw new HuashengBrowserError('manual_review', '花生首页文稿需为 1–10000 字符；请调整已保存的二创稿')
  }
  while (now() < until) {
    input.signal.throwIfAborted()
    let state: HuashengPageState
    try { state = await port.read(); readRetries = 0 }
    catch (error) {
      // Navigation can destroy a read context; retry reads only, never clicks.
      if (readRetries++ < 3 && /execution context was destroyed|cannot find context|detached frame/i.test(String(error))) {
        await wait(300, input.signal)
        continue
      }
      throw error
    }
    lastState = state
    input.signal.throwIfAborted()
    if (state.loginRequired) throw new HuashengBrowserError('login_required', '花生登录已失效，请在专用窗口登录后恢复任务')
    if (state.error) throw new HuashengBrowserError('manual_review', `花生页面提示：${state.error.slice(0, 350)}`)
    const observedProject = huashengProjectUrl(state.url)
    if (observedProject && projectUrl && new URL(observedProject).pathname !== new URL(projectUrl).pathname) {
      throw new HuashengBrowserError('manual_review', '花生页面已切换到其他项目，请打开本任务的项目后恢复')
    }
    if (observedProject && !projectUrl) {
      if (!state.scriptPresent) {
        await wait(options.pollMs ?? 2000, input.signal)
        continue
      }
      projectUrl = observedProject
      await save('created', '花生项目已创建，等待制作方案')
    }
    if (projectUrl && observedProject) {
      if (!state.scriptPresent) {
        // SPA hydration can precede its chat; allow loading, but never click yet.
        await wait(options.pollMs ?? 2000, input.signal)
        continue
      }
      const productionQueued = state.productionQueued || (state.queueVisible && checkpoint === 'confirm_pending')
      if (state.productionStarted || state.productionFinished || productionQueued) {
        await save('submitted', state.productionFinished ? '花生页面显示视频已制作完成'
          : productionQueued ? '花生已显示制作排队，创作任务已被平台接受' : '花生已进入视频编辑页，开始创作', productionQueued ? 'queued' : 'creating')
        return { projectUrl, ...(state.productionFinished ? { videoUrl: projectUrl } : {}) }
      }
      if (checkpoint === 'scheme_pending') {
        if (state.schemeReplyPresent) {
          schemeReplyObservedAt ??= now()
          if (!schemeReplyReported && now() - schemeReplyObservedAt >= 5000) {
            schemeReplyReported = true
            await save('scheme_pending', '花生页面显示 A 方案回复，继续等待成片需求确认')
          }
        } else if (state.schemeChoicePending && schemeReplyObservedAt !== undefined) {
          // Huasheng can optimistically render a reply and then roll it back.
          // The latest question state wins; never latch that temporary bubble.
          schemeReplyObservedAt = undefined
          schemeReplyReported = false
          await input.onCheckpoint({ checkpoint, projectUrl, message: '花生页面未保留方案回复，正在重新核验选择状态' })
        }
      }
      if (checkpoint === 'requirements_pending') {
        if (state.requirementsReplyPresent) {
          requirementsReplyObservedAt ??= now()
          if (!requirementsReplyReported && now() - requirementsReplyObservedAt >= 5000) {
            requirementsReplyReported = true
            await save('requirements_pending', '花生页面显示成片需求确认回复，继续等待创作规划书')
          }
        } else if (state.requirementsChoicePending && requirementsReplyObservedAt !== undefined) {
          requirementsReplyObservedAt = undefined
          requirementsReplyReported = false
          await input.onCheckpoint({ checkpoint, projectUrl, message: '花生页面未保留成片需求确认回复，正在重新核验选择状态' })
        }
      }
      const confirmationButton = state.buttons.find(label => /^(?:[\d,.]+ )?确认并继续$/.test(label))
      const planButton = state.buttons.includes('确认，开始制作') && state.planReady
      // The standard quota notice can coexist with the free “确认并继续”
      // planning action. Let that action enter Huasheng's waiting queue; the
      // optional paid fast-mode button is never clicked automatically.
      if (state.standardQuotaExhausted && (checkpoint === 'confirm_pending' || (!confirmationButton && !planButton))) {
        const message = '花生今日标准模式额度已用完；保留标准模式，待额度恢复后从原项目继续，未使用快速模式'
        await save('quota_waiting', message)
        throw new HuashengBrowserError('manual_review', message)
      }
      // A bubble can remain optimistically rendered even when no reply was saved.
      // Re-read the same server-backed conversation before treating it as stuck.
      // Never reload/replay the final production confirmation here.
      const awaitingChoiceProgress = (checkpoint === 'scheme_pending' && !state.requirementsReady)
        || (checkpoint === 'requirements_pending' && !state.planReady)
      if (port.reload && awaitingChoiceProgress && !state.conversationStale && !confirmationButton
        && now() - checkpointAt >= 45_000 && now() - lastChoiceReloadAt >= 45_000 && choiceReloads < 2) {
        await input.onCheckpoint({ checkpoint, projectUrl, message: '对话暂未推进，正在重新载入原项目核验回复是否保存' })
        input.signal.throwIfAborted()
        await port.reload()
        choiceReloads++
        lastChoiceReloadAt = now()
        await wait(options.pollMs ?? 2000, input.signal)
        continue
      }
      if (state.conversationStale) {
        // Huasheng can stop streaming while its server continues the same task.
        // Synchronize the existing conversation; never replay its last command.
        if (state.buttons.includes('刷新对话') && now() - lastConversationRefreshAt >= 15_000) {
          if (conversationRefreshes >= 3) throw new HuashengBrowserError('manual_review', '花生对话连续刷新后仍未同步，已保留原项目，请检查平台任务状态后恢复')
          await input.onCheckpoint({ checkpoint, projectUrl, message: '花生对话未同步，正在刷新原项目并核验制作状态' })
          input.signal.throwIfAborted()
          await port.click('刷新对话')
          conversationRefreshes++
          lastConversationRefreshAt = now()
          // Keep checkpointAt: refreshing cannot extend an uncertain confirmation's deadline.
        }
      } else if (confirmationButton) {
        if (checkpoint === 'confirm_pending') {
          // A missing response is not permission to send final confirmation again.
        } else {
          if (!state.planReady) throw new HuashengBrowserError('manual_review', '确认窗口缺少已生成的创作规划书，请检查花生项目')
          if (state.cost !== 0) throw new HuashengBrowserError('manual_review', state.cost === null
            ? '无法读取总预估消耗，请在花生项目中核对后手动确认'
            : `本次预计消耗 ${state.cost} 点，已保留规划书，请在花生项目中核对后手动确认`)
          await click('confirm_pending', confirmationButton, '正在确认制作，等待平台返回制作进度')
        }
      } else if (planButton) {
        // If a previous execution recorded confirm_pending before the planning
        // dialog actually opened, the still-visible plan action is authoritative
        // evidence that it is safe to reopen the free planning confirmation.
        if (!clicked.has('确认，开始制作') && !clicked.has('确认并继续')) {
          // Opens the planning/cost dialog; it does not itself authorize spending.
          await click('plan_opened', '确认，开始制作', '打开创作规划书，核对制作消耗')
        }
      } else if (state.buttons.includes('确认') && state.requirementsReady) {
        const retryUnanswered = checkpoint === 'requirements_pending' && state.requirementsChoicePending
          && !state.requirementsReplyPresent && requirementsReplyObservedAt === undefined && now() - checkpointAt >= 15_000
        if ((!['requirements_pending', 'plan_opened', 'confirm_pending'].includes(checkpoint)
          && !state.requirementsReplyPresent) || retryUnanswered) {
          if (requirementsAttempts >= 3) throw new HuashengBrowserError('manual_review', '花生尚未确认收到成片需求回复，已保留原项目，请检查后恢复')
          await click('requirements_pending', '确认', requirementsAttempts || retryUnanswered
            ? '页面确认仍未回复，正在重试确认成片需求，等待花生对话确认'
            : '正在确认成片需求，等待花生对话确认')
          requirementsAttempts++
        }
      } else if (state.buttons.includes(SCHEME)) {
        const retryUnanswered = checkpoint === 'scheme_pending' && state.schemeChoicePending
          && !state.schemeReplyPresent && schemeReplyObservedAt === undefined && now() - checkpointAt >= 15_000
        if ((['created', 'opening', 'create_pending'].includes(checkpoint) && !state.schemeReplyPresent) || retryUnanswered) {
          if (schemeAttempts >= 3) throw new HuashengBrowserError('manual_review', '花生仍未确认收到制作方案，已保留原项目，请检查后恢复')
          await click('scheme_pending', SCHEME, schemeAttempts || retryUnanswered
            ? '页面确认仍未选择，正在重试选择 A，等待花生对话确认'
            : '正在选择 A - 素材剪辑成片，等待花生对话确认')
          schemeAttempts++
        }
      }
    } else if (!projectUrl && (state.hasCreateButton || state.buttons.includes('创建')) && state.loggedIn) {
      if (checkpoint === 'opening') {
        await port.fillScript(input.script)
        await click('create_pending', '创建', '已填写完整二创稿，正在创建花生项目')
      }
    }
    if (checkpoint === 'create_pending' && !projectUrl && now() - checkpointAt > 90_000) {
      throw new HuashengBrowserError('manual_review', '创建请求尚未返回项目链接，请核对花生“我的项目”，系统不会重复创建')
    }
    if (checkpoint === 'confirm_pending' && now() - checkpointAt > 120_000) {
      throw new HuashengBrowserError('manual_review', '确认请求已发送，尚未观察到制作进度；请检查原项目后恢复，系统不会重复确认')
    }
    if (checkpoint === 'scheme_pending' && now() - checkpointAt > 120_000) {
      throw new HuashengBrowserError('manual_review', schemeReplyObservedAt !== undefined
        ? '花生页面显示方案回复，但尚未生成成片需求；已保留原项目，请稍后恢复'
        : '花生尚未确认收到制作方案，已保留原项目，请检查后恢复')
    }
    if (checkpoint === 'requirements_pending' && now() - checkpointAt > 120_000) {
      throw new HuashengBrowserError('manual_review', requirementsReplyObservedAt !== undefined
        ? '花生页面显示成片需求确认回复，但尚未生成创作规划书；已保留原项目，请稍后恢复'
        : '花生尚未确认收到成片需求回复，已保留原项目，请检查后恢复')
    }
    await wait(options.pollMs ?? 2000, input.signal)
  }
  throw new HuashengBrowserError('timeout', checkpoint === 'confirm_pending'
    ? '确认请求已发送，但尚未观察到制作进度；请检查原项目后恢复，系统不会重复确认'
    : lastState && !lastState.loggedIn && !projectUrl ? '花生登录状态未就绪，请打开登录窗口检查'
      : '等待花生响应超时，已保存项目与步骤，可从原项目恢复')
}

export async function runHuashengBrowserJob(input: HuashengBrowserInput): Promise<{ projectUrl: string; videoUrl?: string }> {
  input.signal.throwIfAborted()
  const status = await openHuashengBrowser(input.browserConfig, input.signal)
  input.signal.throwIfAborted()
  if (status.status !== 'ready') throw new HuashengBrowserError(status.status === 'login_required' ? 'login_required' : 'browser_unavailable', status.message)
  const marker = `huobao-huasheng:${input.jobId}`
  const prepared = await prepareBrowser(input.browserConfig, input.signal, async (browser, newPage) => {
    let target = await namedTarget(browser, marker, input.signal)
    const marked = Boolean(target)
    const projectUrl = huashengProjectUrl(input.projectUrl)
    if (input.projectUrl && !projectUrl) throw new HuashengBrowserError('manual_review', '保存的花生项目链接无效，未打开外部页面')
    if (!target && input.checkpoint === 'create_pending' && !projectUrl) {
      throw new HuashengBrowserError('manual_review', '上次创建的窗口已关闭或暂未响应且尚未记录项目链接，请先在花生“我的项目”核对，避免重复创建')
    }
    target ??= browser.targets().find(candidate => isHuashengPage(candidate) && projectUrl && huashengProjectUrl(candidate.url()) === projectUrl)
    const page = target ? await preparationStep(target.page(), input.signal) : await newPage()
    if (!page) throw new Error('Huasheng page target closed')
    if (!target) await preparationStep(page.goto(projectUrl || HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }), input.signal, 46_000)
    if (!marked) await preparationStep(page.evaluate(`window.name = ${JSON.stringify(marker)}`), input.signal)
    // Login can redirect a marked tab to the homepage. Its durable project URL
    // takes precedence over that temporary location when resuming.
    if (projectUrl && !huashengProjectUrl(page.url())) {
      await preparationStep(page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }), input.signal, 46_000)
    } else if (input.checkpoint === 'quota_waiting') {
      await preparationStep(page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }), input.signal, 31_000)
    }
    await preparationStep(page.bringToFront(), input.signal)
    page.setDefaultTimeout(20_000)
    return page
  })
  const { browser, result: page } = prepared
  const interrupted = () => { void browser.disconnect().catch(() => {}) }
  input.signal.addEventListener('abort', interrupted, { once: true })
  try {
    const verifyIdentity = input.browserConfig?.expectedUid ? async () => {
      const identity = await readHuashengIdentity(browser, input.signal).catch(error => {
        if (error instanceof HuashengIdentityError) throw new HuashengBrowserError(error.code === 'login_required' ? 'login_required' : 'browser_unavailable', error.message, true)
        throw error
      })
      if (identity.uid !== input.browserConfig!.expectedUid) throw new HuashengBrowserError('manual_review', '当前登录用户与任务绑定的花生账号不一致，已停止操作，请登录原账号', true)
    } : undefined
    return await driveHuashengPage(createHuashengPagePort(page, input.script, verifyIdentity), input)
  } catch (error) {
    // The queue can abort this signal after rejecting a changed/deleted script.
    // Preserve that actionable rejection instead of replacing it with disconnect noise.
    if (error instanceof Error && error.name === 'HuashengQueueError') throw error
    input.signal.throwIfAborted()
    if (error instanceof HuashengBrowserError) throw error
    throw new HuashengBrowserError('browser_unavailable', '花生浏览器连接中断，已保留项目与步骤，请检查窗口后恢复')
  } finally {
    input.signal.removeEventListener('abort', interrupted)
    // Keep the page open: it is both the deliverable and the recovery surface.
    await browser.disconnect().catch(() => {})
  }
}
