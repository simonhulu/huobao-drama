import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/index.js'
import { now } from '../../../utils/response.js'
import { registerTaskHandler } from '../registry.js'
import type { TaskContext, TaskHandler } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../../../../..')
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(PROJECT_ROOT, 'data/static')
const PROFILE_DIR = process.env.DOUYIN_PROFILE_DIR || path.resolve(PROJECT_ROOT, 'data/douyin-profile')
const DEBUG_DIR = path.join(PROFILE_DIR, 'debug')

export interface PublishDouyinPayload {
  episode_id?: number
  episodeId?: number
  require_confirm?: boolean
  publish?: boolean
}

interface PublishDouyinDeps {
  cdpUrl?: string
  headless?: boolean
}

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(PROJECT_ROOT, 'data', relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

// 远程 url 下载到本地临时文件；本地路径原样解析。puppeteer uploadFile 只接受本地路径。
async function resolveMediaPath(mediaUrlOrPath: string): Promise<string> {
  if (mediaUrlOrPath.startsWith('http://') || mediaUrlOrPath.startsWith('https://')) {
    const tempDir = path.join(PROJECT_ROOT, 'data', 'temp', 'douyin-covers')
    fs.mkdirSync(tempDir, { recursive: true })
    const urlHash = Buffer.from(mediaUrlOrPath).toString('base64url').slice(0, 24)
    const ext = path.extname(new URL(mediaUrlOrPath).pathname) || '.png'
    const tempFile = path.join(tempDir, `${urlHash}${ext}`)
    if (fs.existsSync(tempFile)) return tempFile
    const res = await fetch(mediaUrlOrPath)
    if (!res.ok) throw new Error(`Failed to download ${mediaUrlOrPath}: ${res.status}`)
    fs.writeFileSync(tempFile, Buffer.from(await res.arrayBuffer()))
    return tempFile
  }
  return toAbsPath(mediaUrlOrPath)
}

type DouyinCoverRatio = '4:3' | '3:4'
const DOUYIN_COVER_TARGETS: Record<DouyinCoverRatio, { width: number; height: number }> = {
  '4:3': { width: 1200, height: 900 },
  '3:4': { width: 900, height: 1200 },
}

// 归一化到精确比例，使抖音封面裁剪框默认全选、无需手动裁剪。
async function normalizeCover(sourcePath: string, ratio: DouyinCoverRatio): Promise<string> {
  const target = DOUYIN_COVER_TARGETS[ratio]
  const outDir = path.join(PROJECT_ROOT, 'data', 'temp', 'douyin-covers', 'normalized')
  fs.mkdirSync(outDir, { recursive: true })
  const base = path.basename(sourcePath, path.extname(sourcePath))
  const outPath = path.join(outDir, `${base}_${ratio.replace(':', 'x')}.png`)
  await sharp(sourcePath)
    .resize(target.width, target.height, { fit: 'cover', position: 'centre' })
    .png()
    .toFile(outPath)
  return outPath
}

function getChromeExecutablePath(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH
  const systemMac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (fs.existsSync(systemMac)) return systemMac
  const systemMacCanary = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
  if (fs.existsSync(systemMacCanary)) return systemMacCanary
  const remotionMac = path.resolve(PROJECT_ROOT, '.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell')
  if (fs.existsSync(remotionMac)) return remotionMac
  const remotionLinux = path.resolve(PROJECT_ROOT, '.remotion-chrome/chrome-headless-shell-linux-arm64/chrome-headless-shell')
  if (fs.existsSync(remotionLinux)) return remotionLinux
  return systemMac
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function updateRecord(
  recordId: number,
  patch: Partial<typeof schema.episodePublishRecords.$inferInsert>,
) {
  await db.update(schema.episodePublishRecords)
    .set({ ...patch, updatedAt: now() })
    .where(eq(schema.episodePublishRecords.id, recordId))
    .run()
}

async function ensureDebugDir() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
}

async function screenshot(page: Page, name: string) {
  try {
    await ensureDebugDir()
    const file = path.join(DEBUG_DIR, `${Date.now()}_${name}.png`)
    await page.screenshot({ path: file, fullPage: false })
    console.log(`[publish-douyin] screenshot saved: ${file}`)
  } catch (err: any) {
    console.warn('[publish-douyin] screenshot failed:', err.message)
  }
}

async function getOrLaunchBrowser(deps: PublishDouyinDeps): Promise<Browser> {
  const cdpUrl = deps.cdpUrl ?? process.env.DOUYIN_CDP_URL ?? 'http://127.0.0.1:9224'
  try {
    const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null })
    console.log('[publish-douyin] connected to CDP', cdpUrl)
    return browser
  } catch (err: any) {
    console.log('[publish-douyin] CDP connect failed, launching Chrome:', err.message)
  }

  const executablePath = getChromeExecutablePath()
  if (!fs.existsSync(executablePath)) {
    throw new Error(`找不到 Chrome，请设置 PUPPETEER_EXECUTABLE_PATH: ${executablePath}`)
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true })

  return puppeteer.launch({
    executablePath,
    headless: deps.headless ?? false,
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      '--window-size=1280,800',
    ],
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  })
}

async function applyStealth(page: Page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    })
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en'],
    })
    const originalQuery = window.navigator.permissions?.query
    if (originalQuery) {
      window.navigator.permissions.query = (parameters: any) =>
        parameters?.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters)
    }
    // @ts-ignore
    window.chrome = { runtime: {} }
  })
}

async function waitForAnySelector(
  page: Page,
  selectors: string[],
  options?: { timeout?: number; visible?: boolean },
): Promise<boolean> {
  const timeout = options?.timeout ?? 30_000
  const start = Date.now()
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel)
        if (el) {
          if (!options?.visible) return true
          const visible = await el.evaluate((node) => {
            const rect = node.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          })
          if (visible) return true
        }
      } catch {
        // ignore
      }
    }
    await sleep(500)
  }
  return false
}

async function waitForCondition(
  page: Page,
  fn: () => boolean | Promise<boolean>,
  options?: { timeout?: number; interval?: number },
): Promise<boolean> {
  const timeout = options?.timeout ?? 30_000
  const interval = options?.interval ?? 500
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const result = await page.evaluate(fn)
      if (result) return true
    } catch {
      // ignore
    }
    await sleep(interval)
  }
  return false
}

async function clickByText(page: Page, texts: string[], options?: { timeout?: number; retries?: number }) {
  const timeout = options?.timeout ?? 10_000
  const retries = options?.retries ?? 5
  const start = Date.now()
  for (let i = 0; i < retries; i++) {
    if (Date.now() - start > timeout) break
    const clicked = await page.evaluate((ts) => {
      const selectors = ['button', 'a', 'div[role="button"]', 'span', 'label', 'div', 'li']
      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const text = el.textContent?.trim() || ''
          if (ts.some((t) => text.includes(t))) {
            ;(el as HTMLElement).click()
            return true
          }
        }
      }
      return false
    }, texts)
    if (clicked) return true
    await sleep(500)
  }
  return false
}

async function findElementByText(page: Page, texts: string[], options?: { timeout?: number }) {
  const timeout = options?.timeout ?? 5_000
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const found = await page.evaluate((ts) => {
      const selectors = ['button', 'a', 'div[role="button"]', 'span', 'label', 'div', 'li']
      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (ts.some((t) => el.textContent?.includes(t))) {
            return true
          }
        }
      }
      return false
    }, texts)
    if (found) return true
    await sleep(500)
  }
  return false
}

function isLoginPageUrl(url: string) {
  return url.includes('login') || url.includes('/account/') || !url.includes('creator.douyin.com')
}

async function detectLoginPhase(page: Page): Promise<'qrcode' | 'sms_verification' | 'sms_code_input' | 'logged_in'> {
  const url = page.url()

  // 检测登录页特征（二维码、登录文案）—— 即使 URL 仍在 creator.douyin.com 也优先判定为未登录
  const hasQr = await page.evaluate(() =>
    document.querySelector('img[aria-label="二维码"], img[src*="qr"], .qr_code, [class*="qrcode"], [class*="qr-code"]') !== null ||
    document.body?.textContent?.includes('扫码登录') ||
    document.body?.textContent?.includes('请使用抖音扫一扫') ||
    document.body?.textContent?.includes('打开「抖音APP」')
  ).catch(() => false)
  if (hasQr) return 'qrcode'

  // 短信验证选择界面
  const hasSmsVerification = await page.evaluate(() => {
    const els = document.querySelectorAll('div[class*="uc_verification_component"]')
    for (const el of els) {
      if (el.textContent?.includes('接收短信验证码')) return true
    }
    return false
  }).catch(() => false)
  if (hasSmsVerification) return 'sms_verification'

  // 验证码输入界面
  const hasSmsCodeInput = await page.evaluate(() =>
    document.querySelector('article[class*="uc_verification_component_layout"] #button-input[placeholder="请输入验证码"]') !== null ||
    document.body?.textContent?.includes('请输入验证码')
  ).catch(() => false)
  if (hasSmsCodeInput) return 'sms_code_input'

  // 已登录判定：在创作者域名且存在创作相关元素
  if (url.includes('creator.douyin.com')) {
    const hasCreatorElement = await waitForAnySelector(page, [
      'div[class*="drag-upload"]',
      'input[type="file"]',
      'button[class*="douyin-creator-master-button"]',
      '#douyin-creator-master-side-upload-wrap',
      'div[class*="tab-item"]',
      'div[class*="creator-master"]',
    ], { timeout: 3_000 })
    if (hasCreatorElement) return 'logged_in'
  }

  // 兜底：非 creator 域名认为未登录
  return 'qrcode'
}

async function waitForLogin(
  page: Page,
  recordId: number,
  shouldStop: () => boolean,
  onProgress?: (msg: string, current?: number, total?: number) => void,
  onEvent?: (type: string, data?: unknown) => void,
  timeoutMs = 300_000,
) {
  const start = Date.now()
  let loginStateReported = false

  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')

    const phase = await detectLoginPhase(page)

    if (phase === 'logged_in') {
      if (loginStateReported) {
        await updateRecord(recordId, { status: 'running' })
        onProgress?.('登录成功，继续发布流程', 2, 5)
        onEvent?.('login.success', { url: page.url() })
      }
      return true
    }

    if (!loginStateReported) {
      loginStateReported = true
      await updateRecord(recordId, { status: 'awaiting_login' })
      onProgress?.('请在弹出的浏览器窗口中完成抖音登录', 2, 5)
      onEvent?.('login.required', { url: page.url(), phase })
      console.log('[publish-douyin] waiting for login...')
      await screenshot(page, '02_awaiting_login')
    }

    await sleep(2000)
  }
  throw new Error('等待抖音登录超时')
}

async function waitForUploadPage(page: Page, shouldStop: () => boolean, timeoutMs = 120_000) {
  const start = Date.now()
  let reloaded = false
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')

    const url = page.url()
    const hasUploadContainer = await waitForAnySelector(page, [
      'div[class*="drag-upload"]',
      'input[type="file"]',
    ], { timeout: 2_000 })

    if (url.includes('creator.douyin.com/creator-micro/content/upload') && hasUploadContainer) {
      return
    }

    // 如果 30 秒还没进入上传页，尝试点击「高清发布」
    if (!reloaded && Date.now() - start > 30_000) {
      console.log('[publish-douyin] trying to click HD publish button')
      await clickByText(page, ['高清发布'], { timeout: 5_000, retries: 3 })
      reloaded = true
    }

    await sleep(1000)
  }
  throw new Error('抖音上传页初始化超时')
}

async function switchToVideoTab(page: Page, shouldStop: () => boolean, timeoutMs = 30_000) {
  type TabState = { found: true; isActive: boolean } | { found: false }
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')
    const active: TabState = await page.evaluate((): TabState => {
      const tabs = [...document.querySelectorAll('div[class*="tab-item"]')]
      const target = tabs.find(t => t.textContent?.includes('发布视频'))
      if (!target) return { found: false }
      const isActive = target.className.includes('active')
      return { found: true, isActive }
    })
    if (!active.found) {
      await sleep(500)
      continue
    }
    if (active.isActive) return
    await clickByText(page, ['发布视频'], { timeout: 5_000, retries: 3 })
    await sleep(500)
  }
}



async function dismissPopups(page: Page) {
  // 常见引导/公告弹窗：「我知道了」「同意」「关闭」「暂不」「取消」「好的」
  const popupButtons = ['我知道了', '同意', '关闭', '暂不', '取消', '好的']
  for (const text of popupButtons) {
    await clickByText(page, [text], { timeout: 1_000, retries: 2 })
  }
}

async function uploadVideo(
  page: Page,
  videoAbsPath: string,
  shouldStop: () => boolean,
  onProgress?: (msg: string, current: number, total: number) => void,
  timeoutMs = 600_000,
) {
  onProgress?.('上传视频中...', 1, 3)

  // 关闭可能遮挡上传按钮的弹窗
  await dismissPopups(page)

  // 优先通过「上传视频」按钮 + 拦截文件选择器上传
  let fileChooserTriggered = false
  try {
    const [fileChooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 8_000 }),
      clickByText(page, ['上传视频'], { timeout: 8_000, retries: 5 }),
    ])
    await fileChooser.accept([videoAbsPath])
    fileChooserTriggered = true
  } catch (err: any) {
    console.warn('[publish-douyin] file chooser approach failed:', err.message)
  }

  // 兜底：直接找 file input
  if (!fileChooserTriggered) {
    const fileInput = await page.$('div[class*="drag-upload"] input[type="file"], input[type="file"]') as import('puppeteer-core').ElementHandle<HTMLInputElement> | null
    if (!fileInput) {
      throw new Error('未找到视频上传入口')
    }
    await fileInput.uploadFile(videoAbsPath)
  }

  // 等待上传完成：检测到视频相关元素即认为成功
  const doneSelectors = [
    'video',
    '[class*="video-preview"]',
    '[class*="upload"] [class*="success"]',
    '[class*="recommendTitle"]', // AI 封面推荐标题出现说明已上传完成
    '[class*="recommendCoverContainer"]',
  ]
  const start = Date.now()
  let sawProgress = false
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')

    if (!sawProgress) {
      sawProgress = await waitForAnySelector(page, ['[class*="uploading-container"]'], { timeout: 2_000 })
        || await waitForAnySelector(page, doneSelectors, { timeout: 2_000 })
    }

    const uploading = await page.evaluate(() => !!document.querySelector('[class*="uploading-container"]')).catch(() => false)
    const done = await waitForAnySelector(page, doneSelectors, { timeout: 2_000 })

    if (!uploading && done) {
      await sleep(1500)
      onProgress?.('视频上传完成', 3, 3)
      return
    }

    onProgress?.(sawProgress ? '视频上传中...' : '等待上传响应...', 2, 3)
    await sleep(2000)
  }
  throw new Error('视频上传超时')
}

// 打开封面设置弹窗：滚动到"设置封面"区，点击封面槽位（"选择封面"），等弹窗出现。
async function openCoverModal(page: Page, shouldStop: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  await page.evaluate(() => {
    const label = Array.from(document.querySelectorAll('*')).find(e => (e.textContent || '').trim() === '设置封面')
    if (label) label.scrollIntoView({ block: 'center' })
  })
  await sleep(500)
  const isOpen = () => page.evaluate(() => Array.from(document.querySelectorAll('*')).some(e => {
    const t = e.textContent || ''
    return /设置横封面/.test(t) && /设置竖封面/.test(t) && e.getBoundingClientRect().width > 400
  }))
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')
    if (await isOpen()) return true
    await page.evaluate(() => {
      const slot = Array.from(document.querySelectorAll('*'))
        .find(e => (e.textContent || '').trim() === '选择封面' && e.getBoundingClientRect().width > 0)
      if (slot) (slot as HTMLElement).click()
    })
    await sleep(1500)
  }
  return false
}

// 弹窗内有多个 image input（AI封面/模板/贴纸各一个）。必须锁定"上传封面"按钮向上 5 层祖先内绑定的那个隐藏 input。
async function uploadCoverToModal(page: Page, coverPath: string): Promise<void> {
  const marked = await page.evaluate(() => {
    const upEl = Array.from(document.querySelectorAll('*'))
      .filter(e => (e.textContent || '').replace(/\s+/g, '').includes('上传封面')
        && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 220)
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]
    if (!upEl) return false
    let node: Element | null = upEl
    for (let d = 0; d < 5 && node; d++) {
      const inp = node.querySelector?.('input[type=file]')
      if (inp) { inp.setAttribute('data-dy-cover-upload', '1'); return true }
      node = node.parentElement
    }
    return false
  })
  if (!marked) throw new Error('未找到"上传封面"绑定的文件输入')
  const input = await page.$('input[data-dy-cover-upload="1"]')
  if (!input) throw new Error('封面上传 input 句柄获取失败')
  await input.uploadFile(coverPath)
  // 等图片进入裁剪区（"重新上传"出现即已加载）
  await waitForCondition(page, () => /重新上传/.test(document.body.innerText || ''), { timeout: 15_000, interval: 500 })
  await sleep(1500)
  // 清除标记，避免下一张复用到旧 input
  await page.evaluate(() => document.querySelector('input[data-dy-cover-upload="1"]')?.removeAttribute('data-dy-cover-upload'))
}

// 点弹窗底部的"完成"（排除同名大容器，取最小可点元素）。
async function clickCoverDone(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('*'))
      .filter(e => (e.textContent || '').trim() === '完成'
        && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 130)
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)
    if (!btns.length) return false
    ;(btns[0] as HTMLElement).click()
    return true
  })
}

// 切到"设置竖封面"tab。弹窗打开时顶部始终有"设置横封面/设置竖封面"两个 tab，
// 直接点竖封面 tab（不依赖"完成"后才出现的引导弹窗），modal 内已上传的横封面会保留。
async function switchToVerticalCover(page: Page, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const clicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'))
      const btns = all.filter(e => (e.textContent || '').trim() === '设置竖封面' && e.getBoundingClientRect().width > 0)
      if (!btns.length) return false
      // 顶部 tab：y<200 且宽度较小；退路取最小宽度的一个
      const tab = btns.find(e => { const r = e.getBoundingClientRect(); return r.y < 200 && r.width < 160 })
      const target = tab || btns.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]
      ;(target as HTMLElement).click()
      return true
    })
    if (clicked) {
      await sleep(1500)
      // 校验已切到竖封面 tab（激活态红色）
      const active = await page.evaluate(() => Array.from(document.querySelectorAll('*'))
        .some(e => (e.textContent || '').trim() === '设置竖封面'
          && getComputedStyle(e).color === 'rgb(254, 44, 85)'))
      if (active) return
    }
    await sleep(1000)
  }
  throw new Error('未能切换到"设置竖封面"tab')
}

// 完整双封面上传：横 4:3 + 竖 3:4，均为已 normalize 的精确比例图。
async function uploadCovers(
  page: Page,
  cover4x3Path: string,
  cover3x4Path: string,
  shouldStop: () => boolean,
  onProgress?: (msg: string, current: number, total: number) => void,
): Promise<boolean> {
  if (!(await openCoverModal(page, shouldStop))) {
    console.warn('[publish-douyin] cover modal did not open, skipping covers')
    return false
  }
  // 先传横封面，再经顶部 tab 切到竖封面传竖封面，最后只点一次"完成"关闭 modal。
  // 不在两张之间点"完成"——那会关闭 modal 或触发有延迟的引导弹窗，导致切换失败。
  onProgress?.('上传横封面 4:3', 3, 5)
  await uploadCoverToModal(page, cover4x3Path)

  onProgress?.('上传竖封面 3:4', 3, 5)
  await switchToVerticalCover(page)
  await uploadCoverToModal(page, cover3x4Path)

  if (!(await clickCoverDone(page))) throw new Error('封面"完成"按钮未找到')
  await sleep(2500)

  // 校验弹窗关闭且不再提示缺失
  const ok = await page.evaluate(() => {
    const t = document.body.innerText || ''
    const modalOpen = /设置横封面/.test(t) && /设置竖封面/.test(t)
    const missing = /横\/竖双封面缺失|封面缺失/.test(t)
    return !modalOpen && !missing
  })
  if (!ok) console.warn('[publish-douyin] cover modal state uncertain after upload')
  return ok
}

async function fillTitle(page: Page, title: string) {
  const selectors = [
    'input[placeholder*="作品标题"]',
    'input.semi-input-default[placeholder*="标题"]',
    'input[placeholder*="标题"]',
  ]
  let input = null
  for (const sel of selectors) {
    input = await page.$(sel)
    if (input) break
  }
  if (!input) {
    console.warn('[publish-douyin] title input not found, skipping')
    return
  }
  await input.click({ count: 3 })
  await input.type(title.slice(0, 55), { delay: 15 })
  await sleep(500)
}

async function fillDescription(page: Page, description: string) {
  if (!description) return
  const selectors = [
    'div[data-placeholder*="作品简介"][contenteditable="true"]',
    'div.editor-kit-container[contenteditable="true"]',
    'div[contenteditable="true"][data-slate-editor="true"]',
    'div[contenteditable="true"][data-placeholder*="简介"]',
  ]
  let editor = null
  for (const sel of selectors) {
    editor = await page.$(sel)
    if (editor) break
  }
  if (!editor) {
    console.warn('[publish-douyin] description editor not found, skipping')
    return
  }
  await editor.click()
  const selectAllKey = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(selectAllKey)
  await page.keyboard.down('a')
  await page.keyboard.up('a')
  await page.keyboard.up(selectAllKey)
  await page.keyboard.press('Delete')
  await page.keyboard.type(description.slice(0, 500), { delay: 5 })
  await sleep(500)
}

function getConfirmMarkerPath(taskId: number) {
  return path.join(PROFILE_DIR, `confirm-${taskId}.json`)
}

async function waitForHumanConfirm(
  taskId: number,
  recordId: number,
  shouldStop: () => boolean,
  onProgress?: (msg: string, current: number, total: number) => void,
  timeoutMs = 600_000,
  actionLabel = '发布',
) {
  const markerPath = getConfirmMarkerPath(taskId)
  try { fs.unlinkSync(markerPath) } catch { /* ignore */ }

  await updateRecord(recordId, { status: 'awaiting_confirm' })
  onProgress?.(`信息已填好，等待你确认${actionLabel}`, 4, 5)

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')
    if (fs.existsSync(markerPath)) {
      try { fs.unlinkSync(markerPath) } catch { /* ignore */ }
      return true
    }
    await sleep(2000)
  }
  throw new Error('等待人工确认超时')
}

async function clickPublish(page: Page, shouldStop: () => boolean, timeoutMs = 60_000) {
  // 滚动到发布按钮并点击
  await page.evaluate(() => {
    const container = document.querySelector('div[class*="card-container-creator-layout"]')
    const btn = container && [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === '发布')
    if (btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  await sleep(500)

  type PublishBtnLoc = { found: true; x: number; y: number } | { found: false }
  const loc: PublishBtnLoc = await page.evaluate((): PublishBtnLoc => {
    const container = document.querySelector('div[class*="card-container-creator-layout"]')
    if (!container) return { found: false }
    const btn = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === '发布')
    if (!btn) return { found: false }
    const rect = btn.getBoundingClientRect()
    return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })

  if (!loc.found) {
    throw new Error('未找到发布按钮')
  }

  await page.mouse.click(loc.x, loc.y)

  // 检测 toast
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')
    const toastText = await page.evaluate(() => {
      const el = document.querySelector('span[class*="semi-toast-content-text"]')
      return el ? el.textContent?.trim() : null
    })
    if (toastText) {
      if (toastText.includes('发布成功')) return { success: true, toast: toastText }
      if (toastText.includes('失败') || toastText.includes('错误')) return { success: false, toast: toastText }
    }
    await sleep(1000)
  }

  return { success: true, toast: null }
}

async function clickSaveDraft(page: Page, shouldStop: () => boolean, timeoutMs = 60_000) {
  // 抖音创作者平台的草稿按钮文案是「暂存离开」
  const draftTexts = ['暂存离开', '保存草稿', '存草稿', '草稿']

  // 滚动到底部，确保固定栏按钮在视口内
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await sleep(500)

  // 在 document + shadow root 中查找匹配文本的元素，并返回中心坐标
  // 注意：page.evaluate 的函数字符串会被送到浏览器执行，因此内部不能引用 tsx 编译产生的 __name helper。
  const findDraftButton = async (): Promise<{ x: number; y: number } | null> => {
    return page.evaluate((texts) => {
      const deepAll: Element[] = []
      const stack: (Document | ShadowRoot)[] = [document]
      while (stack.length) {
        const root = stack.pop()!
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
        let node = walker.nextNode()
        while (node) {
          deepAll.push(node as Element)
          const sr = (node as Element).shadowRoot
          if (sr) stack.push(sr)
          node = walker.nextNode()
        }
      }
      let found: Element | null = null
      for (const e of deepAll) {
        const txt = e.textContent?.trim()
        for (const t of texts) {
          if (txt === t) { found = e; break }
        }
        if (found) break
      }
      if (!found) return null
      const rect = found.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }, draftTexts)
  }

  let coords = await findDraftButton()
  if (!coords) {
    // 文案没精确匹配时，尝试正则兜底
    coords = await page.evaluate((texts) => {
      const re = new RegExp(texts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
      const deepAll: Element[] = []
      const stack: (Document | ShadowRoot)[] = [document]
      while (stack.length) {
        const root = stack.pop()!
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
        let node = walker.nextNode()
        while (node) {
          deepAll.push(node as Element)
          const sr = (node as Element).shadowRoot
          if (sr) stack.push(sr)
          node = walker.nextNode()
        }
      }
      let found: Element | null = null
      for (const e of deepAll) {
        if (re.test(e.textContent || '')) { found = e; break }
      }
      if (!found) return null
      const rect = found.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }, draftTexts)
  }
  if (!coords) {
    throw new Error('未找到保存草稿按钮')
  }

  console.log('[publish-douyin] clicking save draft button at', coords)
  await page.mouse.click(coords.x, coords.y)
  await sleep(1000)

  // 检测保存结果：toast、URL 离开 post/video，或出现「继续编辑」提示
  const initialUrl = page.url()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')

    const toastText = await page.evaluate(() => {
      const el = document.querySelector('span[class*="semi-toast-content-text"]')
      return el ? el.textContent?.trim() : null
    })
    if (toastText) {
      if (toastText.includes('保存成功') || toastText.includes('已保存') || toastText.includes('草稿')) {
        return { success: true, toast: toastText }
      }
      if (toastText.includes('失败') || toastText.includes('错误')) return { success: false, toast: toastText }
    }

    const url = page.url()
    if (!url.includes('/post/video') && url !== initialUrl) {
      return { success: true, toast: null }
    }

    // 上传页出现「继续编辑」提示也表示草稿已保存
    const hasContinue = await page.evaluate(() => {
      for (const e of document.querySelectorAll('button, span, div, a')) {
        if (e.textContent?.trim() === '继续编辑') return true
      }
      return false
    })
    if (hasContinue) {
      return { success: true, toast: null }
    }

    await sleep(1000)
  }

  throw new Error('保存草稿后未检测到页面变化，可能未点击成功')
}

async function robustGoto(browser: Browser, url: string, maxRetries = 3) {
  let page = (await browser.pages())[0] ?? (await browser.newPage())
  const waitUntilOptions = ['networkidle2', 'domcontentloaded', 'load'] as const
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const waitUntil of waitUntilOptions) {
      try {
        console.log(`[publish-douyin] navigating to ${url} (attempt ${attempt + 1}, waitUntil=${waitUntil})`)
        await page.goto(url, { waitUntil, timeout: 60_000 })
        return page
      } catch (err: any) {
        console.warn(`[publish-douyin] navigation failed: ${err.message}`)
        if (err.message?.includes('ERR_EMPTY_RESPONSE') || err.message?.includes('net::')) {
          await page.close().catch(() => {})
          page = await browser.newPage()
          await page.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
          )
          await page.setViewport({ width: 1280, height: 800 })
          await page.setJavaScriptEnabled(true)
          await applyStealth(page)
          await sleep(3000)
        }
      }
    }
  }
  throw new Error(`无法打开 ${url}，已重试 ${maxRetries} 次`)
}

export function createPublishDouyinHandler(
  deps: PublishDouyinDeps = {},
): TaskHandler<PublishDouyinPayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<PublishDouyinPayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!episode) throw new Error(`Episode ${episodeId} not found`)
      if (!episode.videoUrl) throw new Error('Episode video is not ready')
      if (!episode.coverImage4x3Url) throw new Error('Episode 4:3 cover is not ready')
      if (!episode.coverImage3x4Url) throw new Error('Episode 3:4 cover is not ready')

      const videoAbsPath = toAbsPath(episode.videoUrl)
      if (!fs.existsSync(videoAbsPath)) throw new Error(`Video file not found: ${videoAbsPath}`)

      // 封面可能是远程 url：下载到本地并归一化到精确比例（4:3=1200×900, 3:4=900×1200）
      const cover4x3Raw = await resolveMediaPath(episode.coverImage4x3Url)
      const cover3x4Raw = await resolveMediaPath(episode.coverImage3x4Url)
      const cover4x3Path = await normalizeCover(cover4x3Raw, '4:3')
      const cover3x4Path = await normalizeCover(cover3x4Raw, '3:4')

      const record = db.select().from(schema.episodePublishRecords)
        .where(eq(schema.episodePublishRecords.episodeId, episodeId))
        .all()
        .find(r => r.platform === 'douyin')

      const recordId = record?.id
      if (recordId) {
        await updateRecord(recordId, { status: 'running', errorMessage: null })
      }

      const requireConfirm = ctx.payload.require_confirm !== false
      const shouldStop = () => ctx.isCancelRequested()
      let browser: Browser | null = null

      try {
        ctx.progress('连接浏览器', 0, 5)
        browser = await getOrLaunchBrowser(deps)

        ctx.progress('打开抖音创作者平台', 1, 5)
        let page = await robustGoto(browser, 'https://creator.douyin.com/creator-micro/content/upload')
        await page.setUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        )
        await page.setViewport({ width: 1280, height: 800 })
        await page.setJavaScriptEnabled(true)
        await applyStealth(page)
        page.setDefaultTimeout(60_000)
        page.setDefaultNavigationTimeout(60_000)

        page.on('dialog', async (dialog) => {
          if (dialog.type() === 'beforeunload') await dialog.accept().catch(() => {})
          else await dialog.dismiss().catch(() => {})
        })

        await screenshot(page, '01_opened')

        const initialPhase = await detectLoginPhase(page)
        if (initialPhase !== 'logged_in') {
          ctx.progress('等待登录', 2, 5)
          await waitForLogin(page, recordId!, shouldStop, (msg, c, t) => ctx.progress(msg, c, t), (type, data) => ctx.event(type, data))
          await screenshot(page, '02_logged_in')

          // 登录后导航到上传页（复用当前 page，保留事件监听）
          ctx.progress('打开抖音上传页', 2, 5)
          await page.goto('https://creator.douyin.com/creator-micro/content/upload', { waitUntil: 'networkidle2', timeout: 60_000 })
        }

        ctx.progress('等待上传页初始化', 2, 5)
        await waitForUploadPage(page, shouldStop, 120_000)
        await dismissPopups(page)
        await screenshot(page, '02_page_ready')

        ctx.progress('切换到发布视频', 2, 5)
        await switchToVideoTab(page, shouldStop, 30_000)
        await dismissPopups(page)

        ctx.progress('上传视频', 2, 5)
        await uploadVideo(page, videoAbsPath, shouldStop, (msg, c, t) => ctx.progress(msg, c, t))
        await screenshot(page, '03_video_uploaded')

        ctx.progress('填写信息', 3, 5)
        const title = episode.videoTitle || episode.title || `第${episode.episodeNumber}集`
        await fillTitle(page, title.slice(0, 55))
        // 作品描述 = 开头钩子 + 结尾悬念 组合，不做任何 AI 创作
        const desc = [episode.openingHook, episode.cliffhanger]
          .map((s) => (s || '').trim())
          .filter(Boolean)
          .join('\n\n')
        await fillDescription(page, desc)
        await uploadCovers(page, cover4x3Path, cover3x4Path, shouldStop, (msg, c, t) => ctx.progress(msg, c, t))
        await screenshot(page, '04_meta_filled')

        // 关闭上传完成后可能出现的预览/引导弹窗，避免遮挡发布/草稿按钮
        await dismissPopups(page)

        const shouldPublish = ctx.payload.publish === true
        const actionLabel = shouldPublish ? '发布' : '保存草稿'
        ctx.progress(shouldPublish ? '发布作品' : '保存草稿', 4, 5)
        if (requireConfirm) {
          await waitForHumanConfirm(ctx.taskId, recordId!, shouldStop, (msg, c, t) => ctx.progress(msg, c, t), 600_000, actionLabel)
        }
        const result = shouldPublish ? await clickPublish(page, shouldStop) : await clickSaveDraft(page, shouldStop)
        await screenshot(page, '05_published')

        const draftUrl = page.url()
        if (recordId) {
          await updateRecord(recordId, {
            status: result.success ? 'success' : 'failed',
            draftUrl,
            errorMessage: result.success ? null : result.toast,
          })
        }

        if (!result.success) {
          throw new Error(`抖音${actionLabel}失败: ${result.toast || '未知错误'}`)
        }

        ctx.progress(shouldPublish ? '发布完成' : '草稿已保存', 5, 5)
        return {
          episode_id: episodeId,
          platform: 'douyin',
          draft_url: draftUrl,
        }
      } catch (err: any) {
        if (recordId) {
          const status = ctx.isCancelRequested() ? 'canceled' : 'failed'
          await updateRecord(recordId, { status, errorMessage: err.message })
        }
        throw err
      } finally {
        // CDP 复用模式：浏览器由外部脚本持有，只断开连接，绝不关闭。
        browser?.disconnect()
      }
    },
  }
}

export function registerPublishDouyinHandler() {
  registerTaskHandler('publish.douyin', createPublishDouyinHandler())
}

export function confirmPublishDouyin(taskId: number) {
  const markerPath = getConfirmMarkerPath(taskId)
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  fs.writeFileSync(markerPath, JSON.stringify({ confirmedAt: now(), taskId }))
}
