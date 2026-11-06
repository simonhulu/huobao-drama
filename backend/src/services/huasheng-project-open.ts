import type { Browser, Page } from 'puppeteer-core'
import { connectHuashengBrowser, openHuashengBrowser, createHuashengTemporaryPage, closeHuashengTemporaryPage,
  huashengProjectUrl, HuashengBrowserError } from './history-huasheng-browser.js'
import type { HuashengAccountsService } from './huasheng-accounts.js'
import { SocialUploadAccountError } from './social-upload-accounts.js'

const HOME = 'https://www.huasheng.cn/'
export interface HuashengProjectBinding {
  accountName: string | null | undefined
  projectUrl: string | null | undefined
  home?: boolean
}
export interface HuashengProjectOpenResult {
  accountName: string
  projectUrl: string
  reused: boolean
  message: string
}
export type HuashengProjectOpener = (binding: HuashengProjectBinding) => Promise<HuashengProjectOpenResult>
type Accounts = Pick<HuashengAccountsService, 'browserConfig'>
interface Dependencies {
  connect?: typeof connectHuashengBrowser
  openBrowser?: typeof openHuashengBrowser
  createPage?: typeof createHuashengTemporaryPage
  closePage?: typeof closeHuashengTemporaryPage
}

async function step<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}

function sameDestination(value: string, destination: string) {
  if (destination !== HOME) {
    const candidate = huashengProjectUrl(value)
    return Boolean(candidate && new URL(candidate).pathname === new URL(destination).pathname)
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ['www.huasheng.cn', 'huasheng.cn'].includes(url.hostname)
      && !url.username && !url.password && !url.port && url.pathname === '/'
  } catch { return false }
}

/** Only browser navigation: no production lease, project mutation or account rebinding. */
export function createHuashengProjectOpener(dependencies: Dependencies = {}) {
  const pending = new Map<string, Promise<HuashengProjectOpenResult>>()
  return async (accounts: Accounts, binding: HuashengProjectBinding): Promise<HuashengProjectOpenResult> => {
    const accountName = binding.accountName
    if (!accountName) throw new SocialUploadAccountError('此任务缺少原花生账号绑定，请核对原账号；尚未打开其他账号', 409)
    const projectUrl = binding.home ? HOME : huashengProjectUrl(binding.projectUrl)
    if (!projectUrl) throw new SocialUploadAccountError('此任务尚未关联有效的花生项目，请先核对原项目链接', 409)
    const saved = accounts.browserConfig(accountName)
    // Manual viewing must remain available to repair login/identity failures.
    // The connector still verifies user-data-dir; production verifies the UID.
    const config = { endpoint: saved.endpoint, profile: saved.profile }
    const key = JSON.stringify([config.endpoint, config.profile, new URL(projectUrl).pathname])
    const existing = pending.get(key)
    if (existing) return existing
    const work = (async () => {
      const signal = AbortSignal.timeout(60_000)
      const connect = dependencies.connect ?? connectHuashengBrowser
      let browser: Browser | undefined
      let created: Page | undefined
      try {
        try { browser = await connect(config, signal) }
        catch (error) {
          // Only a connection failure may need to launch the saved profile.
          // Occupied/wrong profiles must remain explicit.
          if (!(error instanceof HuashengBrowserError) || error.code !== 'browser_unavailable' || !error.cause) throw error
          await (dependencies.openBrowser ?? openHuashengBrowser)(config, signal)
          browser = await connect(config, signal)
        }
        const target = browser.targets().find(target => target.type() === 'page' && sameDestination(target.url(), projectUrl))
        const page = target ? await step(target.page(), signal) : (created = await (dependencies.createPage ?? createHuashengTemporaryPage)(browser, signal))
        if (!page) throw new Error('Huasheng project target closed')
        if (!target) await step(page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }), signal)
        await step(page.bringToFront(), signal)
        return { accountName, projectUrl, reused: Boolean(target), message: projectUrl === HOME
          ? '已打开此任务原账号的花生主页'
          : target ? '已切换到此任务原账号的花生项目页' : '已在此任务原账号的专用浏览器打开花生项目页' }
      } catch (error) {
        if (created && browser) await (dependencies.closePage ?? closeHuashengTemporaryPage)(browser, created).catch(() => {})
        if (error instanceof SocialUploadAccountError) throw error
        if (error instanceof HuashengBrowserError) throw new SocialUploadAccountError(error.message, error.code === 'browser_unavailable' || error.code === 'timeout' ? 503 : 409)
        throw new SocialUploadAccountError('花生项目页暂时无法打开，请检查原账号专用浏览器后重试；原任务已保留', 503)
      } finally { await browser?.disconnect().catch(() => {}) }
    })().finally(() => { if (pending.get(key) === work) pending.delete(key) })
    pending.set(key, work)
    return work
  }
}

export const openHuashengProject = createHuashengProjectOpener()
