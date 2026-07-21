import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const PROFILE_DIR = process.env.WECHAT_CHANNELS_PROFILE_DIR || path.resolve(PROJECT_ROOT, 'data/wechat-channels-profile')
const DEBUG_DIR = path.join(PROFILE_DIR, 'debug')
const WINDOW_WIDTH = Number(process.env.WECHAT_CHANNELS_WINDOW_WIDTH || 1400)
const WINDOW_HEIGHT = Number(process.env.WECHAT_CHANNELS_WINDOW_HEIGHT || 860)

export interface PublishWeChatChannelsPayload {
  episode_id?: number
  episodeId?: number
  require_confirm?: boolean
  short_title?: string
  stop_after_cover_upload?: boolean
}

interface PublishWeChatChannelsDeps {
  cdpUrl?: string
  headless?: boolean
}

export interface WeChatVideoUiState {
  hasCoverPreview: boolean
  hasVisibleVideo: boolean
  generating: boolean
  uploading: boolean
  personalCoverSrc: string | null
  shareCoverSrc: string | null
}

export type WeChatPublishPhase =
  | 'pending'
  | 'video_ready'
  | 'cover_3x4_done'
  | 'cover_4x3_done'
  | 'metadata_ready'
  | 'save_requested'
  | 'draft_verified'

export interface WeChatPublishCheckpoint {
  version: 1
  phase: WeChatPublishPhase
  updatedAt: string
  personalCoverSrc?: string
  shareCoverSrc?: string
  uploadedPersonalCoverSrc?: string
  uploadedShareCoverSrc?: string
  draftCountBefore?: number | null
  draftCountAfter?: number | null
  [key: string]: unknown
}

export interface WeChatDraftListState {
  draftCount: number | null
  hasExpectedTitle: boolean
}

export interface WeChatAvailableScreen {
  availLeft: number
  availTop: number
  availWidth: number
  availHeight: number
}

export interface WeChatWindowSize {
  width: number
  height: number
}

export function calculateWeChatWindowBounds(
  screen: WeChatAvailableScreen,
  desired: WeChatWindowSize,
) {
  const width = Math.max(1, Math.min(desired.width, screen.availWidth))
  const height = Math.max(1, Math.min(desired.height, screen.availHeight))

  return {
    left: screen.availLeft + Math.max(0, Math.floor((screen.availWidth - width) / 2)),
    top: screen.availTop,
    width,
    height,
  }
}

export function isWeChatVideoReady(state: WeChatVideoUiState): boolean {
  // 封面缩略图会在视频文件仍在上传时就出现，但此时微信会显示「文件上传中，请等待
  // 完成后再编辑」并禁止编辑封面。必须等上传横幅消失（uploading=false）才算就绪。
  return !state.generating && !state.uploading && Boolean(state.personalCoverSrc) && Boolean(state.shareCoverSrc)
}

export function shouldStartWeChatVideoUpload(state: WeChatVideoUiState): boolean {
  return !state.hasCoverPreview && !state.hasVisibleVideo && !state.personalCoverSrc && !state.shareCoverSrc
}

export function getWeChatPublishSessionKey(episodeId: number): string {
  return `huobao-wechat-publish-episode-${episodeId}`
}

export function mergeWeChatPublishCheckpoint(
  current: WeChatPublishCheckpoint | null,
  phase: WeChatPublishPhase,
  patch: Record<string, unknown> = {},
): WeChatPublishCheckpoint {
  return {
    ...(current ?? {}),
    ...patch,
    version: 1,
    phase,
    updatedAt: now(),
  } as WeChatPublishCheckpoint
}

export function shouldSkipWeChatCoverUpload(
  cardName: string,
  currentSrc: string | undefined,
  checkpoint: WeChatPublishCheckpoint | null,
): boolean {
  if (!currentSrc || !checkpoint) return false
  const checkpointSrc = cardName.includes('3:4')
    ? checkpoint.uploadedPersonalCoverSrc
    : checkpoint.uploadedShareCoverSrc
  return Boolean(checkpointSrc && checkpointSrc === currentSrc)
}

export function isWeChatDraftPersistenceVerified(
  before: WeChatDraftListState,
  after: WeChatDraftListState,
): boolean {
  if (after.draftCount === null || after.draftCount <= 0) return false
  if (after.hasExpectedTitle && !before.hasExpectedTitle) return true
  return before.draftCount !== null && after.draftCount > before.draftCount
}

export function findPublishRecordForPlatform<T extends { platform: string }>(records: T[], platform: string): T | undefined {
  return records.find(record => record.platform === platform)
}

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(PROJECT_ROOT, 'data', relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

async function resolveMediaPath(mediaUrlOrPath: string): Promise<string> {
  if (mediaUrlOrPath.startsWith('http://') || mediaUrlOrPath.startsWith('https://')) {
    const tempDir = path.join(PROJECT_ROOT, 'data', 'temp', 'wechat-covers')
    fs.mkdirSync(tempDir, { recursive: true })
    const urlHash = Buffer.from(mediaUrlOrPath).toString('base64url').slice(0, 24)
    const ext = path.extname(new URL(mediaUrlOrPath).pathname) || '.png'
    const tempFile = path.join(tempDir, `${urlHash}${ext}`)
    if (fs.existsSync(tempFile)) return tempFile

    const res = await fetch(mediaUrlOrPath)
    if (!res.ok) throw new Error(`Failed to download ${mediaUrlOrPath}: ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(tempFile, buffer)
    return tempFile
  }
  return toAbsPath(mediaUrlOrPath)
}

type WeChatCoverRatio = '4:3' | '3:4'

const WECHAT_COVER_TARGETS: Record<WeChatCoverRatio, WeChatWindowSize> = {
  '4:3': { width: 1200, height: 900 },
  '3:4': { width: 900, height: 1200 },
}

export function isWeChatCoverAspectRatioCompatible(
  width: number,
  height: number,
  ratio: WeChatCoverRatio,
) {
  if (width <= 0 || height <= 0) return false
  const target = WECHAT_COVER_TARGETS[ratio]
  const actualRatio = width / height
  const targetRatio = target.width / target.height
  return Math.abs(actualRatio - targetRatio) / targetRatio <= 0.01
}

export async function ensureWeChatCoverAspectRatio(
  sourcePath: string,
  ratio: WeChatCoverRatio,
  outputDir = path.join(PROJECT_ROOT, 'data', 'temp', 'wechat-covers', 'normalized'),
) {
  const metadata = await sharp(sourcePath).metadata()
  if (!metadata.width || !metadata.height) {
    throw new Error(`Cannot read cover dimensions: ${sourcePath}`)
  }
  if (isWeChatCoverAspectRatioCompatible(metadata.width, metadata.height, ratio)) {
    return sourcePath
  }

  fs.mkdirSync(outputDir, { recursive: true })
  const stat = fs.statSync(sourcePath)
  const fingerprint = createHash('sha256')
    .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}:${ratio}`)
    .digest('hex')
    .slice(0, 16)
  const outputPath = path.join(outputDir, `${fingerprint}-${ratio.replace(':', 'x')}.png`)
  if (!fs.existsSync(outputPath)) {
    const target = WECHAT_COVER_TARGETS[ratio]
    await sharp(sourcePath)
      .rotate()
      .resize(target.width, target.height, { fit: 'cover', position: 'attention' })
      .png({ compressionLevel: 9 })
      .toFile(outputPath)
  }
  console.log(
    `[publish-wechat-channels] normalized ${ratio} cover from ${metadata.width}x${metadata.height} to ${WECHAT_COVER_TARGETS[ratio].width}x${WECHAT_COVER_TARGETS[ratio].height}`,
  )
  return outputPath
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

function smartTruncateChinese(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const badEndChars = new Set(['的', '了', '与', '和', '或', '在', '从', '到', '为', '被', '把', '将', '向', '对', '于', '以', '及', '而', '但', '因', '所', '之', '着', '过', '吗', '呢', '吧', '啊'])
  const punctuation = new Set(['，', '。', '；', '：', '！', '？', '、', '”', '"', '」', '』', ')', '）', ']', '】'])

  let cut = maxLen
  for (let i = maxLen; i >= Math.max(0, maxLen - 8); i--) {
    if (punctuation.has(text[i - 1])) {
      cut = i
      break
    }
  }

  while (cut > 1 && badEndChars.has(text[cut - 1])) {
    cut--
  }

  if (cut < 8) cut = maxLen

  return text.slice(0, cut)
}

// 视频号简介：源文案是带 markdown 和「起承转合」结构标记的长文，需要清洗成
// 干净的 100~200 字观众向简介。去掉 markdown 符号、【起】等分段标记和纯标签行，
// 压缩空白，再优先在句末标点（。！？…）断句截断到 maxLen。
export function sanitizeDescriptionForWeChat(raw: string, maxLen = 200, minLen = 100): string {
  if (!raw) return ''
  let text = raw
    .replace(/\*+/g, '')          // **加粗**
    .replace(/[#`>~_]/g, '')      // 其它 markdown 符号（# 还会触发话题联想，必须去掉）
    .replace(/【[^】]*】/g, '')    // 【起】【承】【转】【合】分段标记
  text = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^.{0,14}[:：]$/.test(line)) // 丢掉「叙事脉络（起承转合）：」这类纯标签行
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= maxLen) return text
  const enders = new Set(['。', '！', '？', '…'])
  for (let i = Math.min(maxLen, text.length) - 1; i >= minLen; i--) {
    if (enders.has(text[i])) return text.slice(0, i + 1)
  }
  return smartTruncateChinese(text, maxLen)
}

// 视频号助手使用 wujie 微前端，内容在 shadow DOM 中，需要遍历。
function collectAllElements(root?: Document | ShadowRoot): HTMLElement[] {
  const base = root ?? (globalThis as unknown as { document: Document }).document
  const result: HTMLElement[] = []
  const nodes = base.querySelectorAll('*')
  for (const el of nodes) {
    result.push(el as HTMLElement)
    if (el.shadowRoot) {
      result.push(...collectAllElements(el.shadowRoot))
    }
  }
  return result
}

async function ensureCollector(page: Page) {
  const collectorCode = `
    if (window.collectAllElements) return;
    function collectAllElements(root) {
      const base = root ?? document;
      const result = [];
      const nodes = base.querySelectorAll('*');
      for (const el of nodes) {
        result.push(el);
        if (el.shadowRoot) result.push(...collectAllElements(el.shadowRoot));
      }
      return result;
    }
    window.collectAllElements = collectAllElements;
  `
  await page.evaluate(new Function(collectorCode) as unknown as () => void)
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

function parseWeChatPublishCheckpoint(value: string | null | undefined): WeChatPublishCheckpoint | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as WeChatPublishCheckpoint
    return parsed?.version === 1 ? parsed : null
  } catch {
    return null
  }
}

async function writeCheckpoint(
  recordId: number,
  phase: WeChatPublishPhase,
  patch: Record<string, unknown> = {},
) {
  const [record] = db.select().from(schema.episodePublishRecords)
    .where(eq(schema.episodePublishRecords.id, recordId))
    .all()
  const checkpoint = mergeWeChatPublishCheckpoint(
    parseWeChatPublishCheckpoint(record?.checkpointJson),
    phase,
    patch,
  )
  await updateRecord(recordId, { checkpointJson: JSON.stringify(checkpoint) })
  return checkpoint
}

async function ensureDebugDir() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
}

async function screenshot(page: Page, name: string) {
  try {
    await ensureDebugDir()
    const file = path.join(DEBUG_DIR, `${Date.now()}_${name}.png`)
    await page.screenshot({ path: file, fullPage: false })
    console.log(`[publish-wechat-channels] screenshot saved: ${file}`)
  } catch (err: any) {
    console.warn('[publish-wechat-channels] screenshot failed:', err.message)
  }
}

async function setStableWindow(page: Page) {
  try {
    const availableScreen = await page.evaluate(() => {
      const browserScreen = window.screen as Screen & { availLeft?: number; availTop?: number }
      return {
        availLeft: browserScreen.availLeft ?? 0,
        availTop: browserScreen.availTop ?? 0,
        availWidth: browserScreen.availWidth,
        availHeight: browserScreen.availHeight,
      }
    })
    const bounds = calculateWeChatWindowBounds(availableScreen, {
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
    })
    const client = await page.createCDPSession()
    const { windowId } = await client.send('Browser.getWindowForTarget')
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { ...bounds, windowState: 'normal' },
    })
    await page.bringToFront()
    if (process.platform === 'darwin') {
      await new Promise<void>((resolve) => {
        execFile('open', ['-a', 'Google Chrome'], () => resolve())
      })
    }
  } catch (err: any) {
    console.warn('[publish-wechat-channels] failed to resize browser window:', err.message)
  }
}

async function getOrLaunchBrowser(deps: PublishWeChatChannelsDeps): Promise<Browser> {
  const cdpUrl = deps.cdpUrl ?? process.env.WECHAT_CHANNELS_CDP_URL ?? 'http://127.0.0.1:9222'
  try {
    const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null })
    console.log('[publish-wechat-channels] connected to CDP', cdpUrl)
    return browser
  } catch (err: any) {
    console.log('[publish-wechat-channels] CDP connect failed, launching Chrome:', err.message)
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
      '--remote-debugging-port=9222',
      '--window-position=20,40',
      `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
    ],
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  })
}

async function applyStealth(page: Page) {
  // 用字符串构建函数，避免 tsx/esbuild 的 keepNames 注入 __name 导致序列化到浏览器后缺失。
  const stealthCode = `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters?.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
    window.chrome = { runtime: {} };
  `
  await page.evaluateOnNewDocument(new Function(stealthCode) as unknown as () => void)
}

async function clickByText(page: Page, texts: string[], options?: { timeout?: number; retries?: number }) {
  const timeout = options?.timeout ?? 10_000
  const retries = options?.retries ?? 5
  const start = Date.now()
  for (let i = 0; i < retries; i++) {
    if (Date.now() - start > timeout) break
    const clicked = await page.evaluate((ts) => {
      const selectors = ['button', 'a', 'div[role="button"]', 'span', 'label', 'div']
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
      const selectors = ['button', 'a', 'div[role="button"]', 'span', 'label', 'div']
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

async function waitForLogin(
  page: Page,
  recordId: number | null,
  shouldStop: () => boolean,
  onProgress?: (msg: string, current?: number, total?: number) => void,
  onEvent?: (type: string, data?: unknown) => void,
  timeoutMs = 300_000,
) {
  await ensureCollector(page)
  const start = Date.now()
  let loginStateReported = false
  let noQrStreak = 0
  let lastScreenshot = 0
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')
    const url = page.url()

    // 已经登录且发布页就绪：出现上传区
    if (url.includes('channels.weixin.qq.com/platform/post/create')) {
      const hasUploadArea = await page.evaluate(() => {
        const all = ((window as any).collectAllElements() as HTMLElement[])
        return all.some(el => /上传时长|大小不超过|分辨率720p|MP4\/H\.264/.test(el.textContent || ''))
      }).catch(() => false)
      if (hasUploadArea) {
        if (loginStateReported && recordId) {
          await updateRecord(recordId, { status: 'running' })
        }
        onProgress?.('登录成功，继续发布流程', 2, 5)
        onEvent?.('login.success', { url: page.url() })
        return true
      }
    }

    const hasQr = await page.evaluate(() => {
      const all = ((window as any).collectAllElements() as HTMLElement[])
      return all.some(el =>
        /qr|qrcode|qr-code|微信扫码登录|请使用微信扫一扫登录|请重新登录/.test((el as HTMLElement).className || '') ||
        /微信扫码登录|请使用微信扫一扫登录/.test(el.textContent || '')
      )
    }).catch(() => false)

    if (hasQr && !loginStateReported) {
      loginStateReported = true
      if (recordId) await updateRecord(recordId, { status: 'awaiting_login' })
      onProgress?.('请在弹出的浏览器窗口中用微信扫码登录', 2, 5)
      onEvent?.('login.required', { url: page.url() })
      console.log('[publish-wechat-channels] waiting for QR scan...')
      await screenshot(page, '02_awaiting_login')
      lastScreenshot = Date.now()
      noQrStreak = 0
    }

    // 登录成功兜底：在发布页且连续 4 秒没有二维码，也视为已登录
    if (!hasQr && url.includes('channels.weixin.qq.com/platform/post/create')) {
      noQrStreak++
      if (noQrStreak >= 2) {
        if (loginStateReported && recordId) {
          await updateRecord(recordId, { status: 'running' })
        }
        onProgress?.('登录成功，继续发布流程', 2, 5)
        onEvent?.('login.success', { url: page.url() })
        return true
      }
    } else {
      noQrStreak = 0
    }

    // 每 10 秒截一张图，方便排查登录态
    if (Date.now() - lastScreenshot > 10_000) {
      await screenshot(page, '02_awaiting_login')
      lastScreenshot = Date.now()
    }

    await sleep(2000)
  }
  throw new Error('等待视频号登录超时，请先扫码登录后再试')
}

async function waitForPageReady(
  page: Page,
  recordId: number,
  ctx: TaskContext<PublishWeChatChannelsPayload>,
  shouldStop: () => boolean,
  timeoutMs = 300_000,
) {
  await ensureCollector(page)
  // 等页面初始化完成：URL 是发布页，且上传区可见
  const start = Date.now()
  let lastLog = 0
  let reloaded = false
  let uploadTriggerStreak = 0
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')

    const url = page.url()
    const state = await page.evaluate(() => {
      const all = ((window as any).collectAllElements() as HTMLElement[])

      // 上传触发器：要求元素可见（width > 0）
      const uploadInput = all.find((el: HTMLElement) =>
        el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file' && /video/.test((el as HTMLInputElement).accept || '')
      )
      const uploadArea = all.find((el: HTMLElement) =>
        /上传时长|大小不超过|分辨率720p|MP4\/H\.264/.test(el.textContent || '') && el.getBoundingClientRect().width > 0
      )

      // 初始化中：只看可见的 loading 元素或明确的初始化文字
      const initText = all.find((el: HTMLElement) =>
        /页面初始化中/.test(el.textContent || '') && el.getBoundingClientRect().width > 0
      )

      return {
        hasUploadTrigger: !!(uploadInput || uploadArea),
        initializing: !!initText,
        bodyText: document.body?.textContent?.slice(0, 200) || '',
      }
    }).catch(() => ({ hasUploadTrigger: false, initializing: false, bodyText: '' }))

    if (Date.now() - lastLog > 5000) {
      console.log(`[publish-wechat-channels] page ready check | url=${url} | initializing=${state.initializing} | uploadTrigger=${state.hasUploadTrigger} | bodyText=${state.bodyText}`)
      lastLog = Date.now()
    }

    // 只有 URL 确实不是发布页时才去等登录；不再通过 DOM 文本猜测登录态
    if (isLoginPageUrl(url)) {
      console.log('[publish-wechat-channels] redirected to login or session expired during ready wait')
      await waitForLogin(
        page,
        recordId,
        shouldStop,
        (msg, c, t) => ctx.progress(msg, c, t),
        (type, data) => ctx.event(type, data),
        300_000,
      )
      uploadTriggerStreak = 0
      continue
    }

    if (state.hasUploadTrigger) {
      uploadTriggerStreak++
      // 上传区连续 2 秒可见且不在初始化中，认为页面就绪
      if (uploadTriggerStreak >= 2 && !state.initializing) {
        return
      }
    } else {
      uploadTriggerStreak = 0
    }

    // 如果卡初始化超过 30 秒，刷新一次
    if (state.initializing && !reloaded && Date.now() - start > 30_000) {
      console.log('[publish-wechat-channels] page stuck initializing, reloading once')
      await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
      await ensureCollector(page)
      reloaded = true
      uploadTriggerStreak = 0
      await sleep(2000)
      continue
    }

    await sleep(1000)
  }
  throw new Error('视频号发布页初始化超时')
}

function isLoginPageUrl(url: string) {
  return /\/login|qr|session|auth/.test(url) || (!url.includes('/platform/post/create') && !url.includes('/platform/post/draft'))
}

async function findVideoFileInput(page: Page, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const handle = await page.evaluateHandle(() => {
      const all = ((window as any).collectAllElements() as HTMLElement[])
      for (const el of all) {
        if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file' && /video/.test((el as HTMLInputElement).accept || '')) {
          return el
        }
      }
      return null
    })
    const input = handle.asElement()
    if (input) return input as import('puppeteer-core').ElementHandle<HTMLInputElement>
    await sleep(500)
  }
  return null
}

async function clickUploadArea(page: Page, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const clicked = await page.evaluate(() => {
      const all = ((window as any).collectAllElements() as HTMLElement[])
      const keywords = ['上传时长', '大小不超过', '分辨率720p', '码率10Mbps', 'MP4/H.264']

      // 精确上传区：含文字、面积适中
      const candidates = all
        .filter(el => {
          const text = el.textContent || ''
          if (!keywords.some(k => text.includes(k))) return false
          const style = window.getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          const isDashed = style.borderStyle === 'dashed' || style.borderStyle === 'dotted'
          return (isDashed || rect.width < 300) && rect.width > 80 && rect.height > 80
        })
        .sort((a, b) => {
          const ra = a.getBoundingClientRect()
          const rb = b.getBoundingClientRect()
          return (ra.width * ra.height) - (rb.width * rb.height)
        })

      if (candidates.length > 0) {
        ;(candidates[0] as HTMLElement).click()
        return true
      }

      // 兜底：找页面中央附近最大的可点击 div
      const central = all.filter(el => {
        const rect = el.getBoundingClientRect()
        return rect.width > 150 && rect.height > 150 && rect.left > window.innerWidth * 0.2 && rect.right < window.innerWidth * 0.6
      })
      if (central.length > 0) {
        central.sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height))
        ;(central[0] as HTMLElement).click()
        return true
      }
      return false
    })
    if (clicked) return true
    await sleep(500)
  }
  return false
}

async function readWeChatVideoUiState(page: Page): Promise<WeChatVideoUiState> {
  return page.evaluate(() => {
    const all = ((window as any).collectAllElements() as HTMLElement[])
    const visible = all.filter(el => {
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    })
    const labels = ['个人主页卡片', '分享卡片']
    const coverSources = labels.map(labelText => {
      const label = visible.find(el => (el.textContent || '').trim() === labelText)
      if (!label) return null
      const labelRect = label.getBoundingClientRect()
      const images = visible
        .filter(el => el.tagName === 'IMG')
        .map(el => {
          const rect = el.getBoundingClientRect()
          return {
            src: (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || '',
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }
        })
        .filter(image => image.width > 40 && image.height > 40 && image.left < labelRect.right && image.right > labelRect.left && image.top < labelRect.top)
        .sort((a, b) => b.width * b.height - a.width * a.height)
      return images[0]?.src || null
    })

    // 上传未完成时页面顶部横幅为「文件上传中，请等待完成后再编辑」，此时不能编辑封面。
    const uploading = visible.some(el => {
      const t = (el.textContent || '').trim()
      return t.includes('文件上传中') || t === '上传中' || /^正在上传/.test(t)
    })

    return {
      hasCoverPreview: visible.some(el => (el.textContent || '').includes('封面预览')),
      hasVisibleVideo: visible.some(el => el.tagName === 'VIDEO'),
      generating: visible.some(el => (el.textContent || '').trim() === '生成中'),
      uploading,
      personalCoverSrc: coverSources[0],
      shareCoverSrc: coverSources[1],
    }
  }).catch(() => ({
    hasCoverPreview: false,
    hasVisibleVideo: false,
    generating: false,
    uploading: false,
    personalCoverSrc: null,
    shareCoverSrc: null,
  }))
}

async function uploadVideo(
  page: Page,
  videoAbsPath: string,
  shouldStop: () => boolean,
  onProgress?: (msg: string, current: number, total: number) => void,
  timeoutMs = 600_000,
): Promise<WeChatVideoUiState> {
  onProgress?.('上传视频中...', 1, 3)

  let state = await readWeChatVideoUiState(page)
  if (isWeChatVideoReady(state)) {
    onProgress?.('视频上传完成', 3, 3)
    return state
  }

  if (shouldStartWeChatVideoUpload(state)) {
    let fileInput = await findVideoFileInput(page, 30_000)

    // 视频号发布页需要先点击中间虚线框上传区，才会出现 file input
    if (!fileInput) {
      const clicked = await clickUploadArea(page, 30_000)
      if (clicked) {
        await sleep(1000)
        fileInput = await findVideoFileInput(page, 20_000)
      }
    }

    if (!fileInput) {
      throw new Error('未找到视频上传 input，请确认已打开视频号发布页')
    }
    await fileInput.uploadFile(videoAbsPath)
  } else {
    console.log('[publish-wechat-channels] existing video upload/process state detected, resuming without selecting the file again')
  }

  // 视频预览会在真正上传完成前出现。只有两张平台封面都生成完毕，
  // 才能进入自定义封面阶段。
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')

    state = await readWeChatVideoUiState(page)

    if (isWeChatVideoReady(state)) {
      await sleep(1500)
      onProgress?.('视频上传完成', 3, 3)
      return state
    }
    const msg = state.uploading
      ? '视频上传中...'
      : (state.hasCoverPreview || state.hasVisibleVideo ? '视频处理中，等待封面生成...' : '视频上传中...')
    onProgress?.(msg, 2, 3)
    await sleep(3000)
  }
  throw new Error('视频上传或封面生成超时，浏览器页面已保留以便检查')
}

async function fillShortTitle(page: Page, title: string) {
  const ok = await page.evaluate((text) => {
    const all = ((window as any).collectAllElements() as HTMLElement[])
    const input = all.find(el => el.tagName === 'INPUT' && ((el as HTMLInputElement).placeholder || '').includes('短标题')) as HTMLInputElement | undefined
    if (!input) return false
    input.focus()
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.blur()
    return true
  }, smartTruncateChinese(title, 16))
  if (!ok) {
    console.warn('[publish-wechat-channels] short title input not found, skipping')
  }
  await sleep(500)
}

async function fillDescription(page: Page, description: string) {
  const text = sanitizeDescriptionForWeChat(description)
  if (!text) return

  // 微信富文本编辑器（contenteditable div）不认 innerText= 直接赋值——DOM 会显示但框架
  // 内部 model 不更新，保存后简介为空。必须真键盘输入触发框架监听的 input 事件。
  const box = await page.evaluate(() => {
    const all = ((window as any).collectAllElements() as HTMLElement[])
    const editor = all.find(el => el.tagName === 'DIV' && (el.className || '').toString().includes('input-editor') && el.getAttribute('contenteditable') !== null) as HTMLElement | undefined
    if (!editor) return null
    editor.scrollIntoView({ block: 'center' })
    const r = editor.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (!box) {
    console.warn('[publish-wechat-channels] description editor not found, skipping')
    return
  }

  await page.mouse.click(box.x, box.y)
  await sleep(300)
  // 全选清空已有内容
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(mod)
  await page.keyboard.press('KeyA')
  await page.keyboard.up(mod)
  await page.keyboard.press('Backspace')
  await sleep(200)
  await page.keyboard.type(text, { delay: 12 })
  await sleep(300)

  const filledLen = await page.evaluate(() => {
    const all = ((window as any).collectAllElements() as HTMLElement[])
    const editor = all.find(el => el.tagName === 'DIV' && (el.className || '').toString().includes('input-editor')) as HTMLElement | undefined
    return editor ? (editor.innerText || '').trim().length : 0
  })
  console.log(`[publish-wechat-channels] description typed, target=${text.length} actual=${filledLen}`)
  await sleep(500)
}

async function clickByTextInShadow(page: Page, text: string, exact = false, timeoutMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const clicked = await page.evaluate((t, exactMatch) => {
      const all = ((window as any).collectAllElements() as HTMLElement[])
      for (const el of all) {
        const elText = (el.textContent || '').trim()
        const match = exactMatch ? elText === t : elText.includes(t)
        if (match) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            ;(el as HTMLElement).click()
            return true
          }
        }
      }
      return false
    }, text, exact)
    if (clicked) return true
    await sleep(500)
  }
  return false
}

async function isButtonDisabled(el: HTMLElement): Promise<boolean> {
  return await new Promise((resolve) => {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      resolve(true)
      return
    }
    const style = window.getComputedStyle(el)
    const visuallyDisabled = style.opacity === '0.5' ||
      style.pointerEvents === 'none' ||
      style.cursor === 'not-allowed' ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('weui-desktop-btn_disabled') ||
      el.classList.contains('disabled')
    resolve(visuallyDisabled)
  })
}

interface CoverCardImage {
  cardName: string
  src?: string
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

const WECHAT_COVER_CARD_GEOMETRY = {
  minWidth: 48,
  minHeight: 64,
  portraitAspect: 4 / 3,
  landscapeAspect: 3 / 4,
  aspectTolerance: 0.16,
} as const

export function classifyWeChatCoverCardGeometry(width: number, height: number): string | null {
  if (width < WECHAT_COVER_CARD_GEOMETRY.minWidth || height < WECHAT_COVER_CARD_GEOMETRY.minHeight) {
    return null
  }
  const aspect = height / width
  if (Math.abs(aspect - WECHAT_COVER_CARD_GEOMETRY.portraitAspect) <= WECHAT_COVER_CARD_GEOMETRY.aspectTolerance) {
    return '个人主页卡片(3:4)'
  }
  if (Math.abs(aspect - WECHAT_COVER_CARD_GEOMETRY.landscapeAspect) <= WECHAT_COVER_CARD_GEOMETRY.aspectTolerance) {
    return '分享卡片(4:3)'
  }
  return null
}

export interface WeChatCoverEditorUiState {
  dialogTitle: string | null
  popoverVisible: boolean
}

export function isWeChatCoverEditorReady(
  cardName: string,
  state: WeChatCoverEditorUiState,
) {
  const expectedTitle = cardName.includes('3:4')
    ? '编辑个人主页卡片'
    : '编辑分享卡片'
  return state.dialogTitle === expectedTitle
}

async function readCoverEditorUiState(page: Page): Promise<WeChatCoverEditorUiState> {
  // 字符串构建 + new Function，避免 tsx/esbuild keepNames 给命名 const 箭头函数注入 __name，
  // 序列化到浏览器后 __name 未定义会抛错。真正的编辑弹窗里一定有可见「上传封面」按钮，
  // 主表单没有；以此为闸避免「编辑」+「个人主页卡片」拼出的幽灵标题被误判为弹窗已开。
  const code = `
    var all = window.collectAllElements();
    var vis = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    var hasUploadBtn = all.some(function (el) { return (el.textContent || '').trim() === '上传封面' && vis(el); });
    var titleEl = all.find(function (el) {
      var t = (el.textContent || '').trim();
      return (t === '编辑个人主页卡片' || t === '编辑分享卡片') && vis(el);
    });
    var dialogTitle = (hasUploadBtn && titleEl) ? (titleEl.textContent || '').trim() : null;
    var popoverVisible = all.some(function (el) { return /使用此素材作为封面/.test((el.textContent || '').trim()) && vis(el); });
    return { dialogTitle: dialogTitle, popoverVisible: popoverVisible };
  `
  return page.evaluate(new Function(code) as unknown as () => WeChatCoverEditorUiState)
}

async function isCardEditOpen(page: Page, cardName: string) {
  const state = await readCoverEditorUiState(page)
  return isWeChatCoverEditorReady(cardName, state) || state.popoverVisible
}

// 文字锚定方案：视频号封面预览区两张卡片各带固定文字标签「个人主页卡片」「分享卡片」
// 和一个「编辑」按钮，比按缩略图宽高比分类可靠得多（预览缩略图并不按 3:4/4:3 渲染）。
async function findCoverCardImagesByVisual(page: Page, timeoutMs = 30_000): Promise<CoverCardImage[]> {
  // 字符串构建，避免 tsx/esbuild keepNames 注入 __name 破坏浏览器端序列化。
  const code = `
    var all = window.collectAllElements();
    var area = function (el) { var r = el.getBoundingClientRect(); return r.width * r.height; };
    var leaf = function (kw) {
      return all.filter(function (el) { return (el.textContent || '').replace(/\\s/g, '').includes(kw) && el.getBoundingClientRect().width > 0; })
        .sort(function (a, b) { return area(a) - area(b); })[0] || null;
    };
    var defs = [ { cardName: '个人主页卡片(3:4)', kw: '个人主页卡片' }, { cardName: '分享卡片(4:3)', kw: '分享卡片' } ];
    var out = [];
    for (var i = 0; i < defs.length; i++) {
      var def = defs[i];
      var label = leaf(def.kw);
      if (!label) continue;
      var lr = label.getBoundingClientRect();
      var lcx = lr.left + lr.width / 2;
      var near = (function (lr) { return function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < lr.top && lr.top - r.bottom < 240; }; })(lr);
      var cx = function (el) { var r = el.getBoundingClientRect(); return r.left + r.width / 2; };
      var byX = function (a, b) { return Math.abs(cx(a) - lcx) - Math.abs(cx(b) - lcx); };
      var edit = all.filter(function (el) { return (el.textContent || '').trim() === '编辑' && near(el); }).sort(byX)[0];
      if (!edit) continue;
      var img = all.filter(function (el) { return el.tagName === 'IMG' && near(el); }).sort(byX)[0];
      var r = edit.getBoundingClientRect();
      out.push({ cardName: def.cardName, src: img ? (img.currentSrc || img.src || '') : '', left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    }
    return out.length >= 2 ? out : null;
  `
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const cards = await page.evaluate(new Function(code) as unknown as () => CoverCardImage[] | null)
    if (cards && cards.length >= 2) return cards as CoverCardImage[]
    await sleep(800)
  }
  throw new Error('未找到封面预览区域的两张封面图')
}

async function clickCardEditByVisual(
  page: Page,
  cardName: string,
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs
  // rect 现在就是「编辑」按钮本身，直接点它的中心。
  const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.mouse.click(point.x, point.y)
    await sleep(700)
    if (await isCardEditOpen(page, cardName)) {
      console.log(`[publish-wechat-channels] cover edit opened for ${cardName} (center click)`)
      return true
    }
  }

  // fallback：用文字标签锚定该卡片的「编辑」按钮，点击其可点击祖先（字符串构建避免 __name）
  const kw = cardName.includes('3:4') ? '个人主页卡片' : '分享卡片'
  const fbCode = `
    var keyword = ${JSON.stringify(kw)};
    var all = window.collectAllElements();
    var area = function (el) { var r = el.getBoundingClientRect(); return r.width * r.height; };
    var label = all.filter(function (el) { return (el.textContent || '').replace(/\\s/g, '').includes(keyword) && el.getBoundingClientRect().width > 0; })
      .sort(function (a, b) { return area(a) - area(b); })[0];
    if (!label) return false;
    var lr = label.getBoundingClientRect();
    var lcx = lr.left + lr.width / 2;
    var cx = function (el) { var r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    var edit = all.filter(function (el) {
      var r = el.getBoundingClientRect();
      return (el.textContent || '').trim() === '编辑' && r.width > 0 && r.top < lr.top && lr.top - r.bottom < 240;
    }).sort(function (a, b) { return Math.abs(cx(a) - lcx) - Math.abs(cx(b) - lcx); })[0];
    if (!edit) return false;
    var node = edit;
    while (node) {
      var tag = node.tagName.toLowerCase();
      var role = node.getAttribute('role');
      var style = window.getComputedStyle(node);
      if (tag === 'button' || tag === 'a' || role === 'button' || style.cursor === 'pointer') { node.click(); return true; }
      node = node.parentElement;
    }
    edit.click();
    return true;
  `
  const jsClicked = await page.evaluate(new Function(fbCode) as unknown as () => boolean)

  if (jsClicked) {
    while (Date.now() < deadline) {
      await sleep(500)
      if (await isCardEditOpen(page, cardName)) return true
    }
  }
  return false
}

async function getCoverCardSrcByName(page: Page, cardName: string): Promise<string | null> {
  const kw = cardName.includes('3:4') ? '个人主页卡片' : '分享卡片'
  const code = `
    var keyword = ${JSON.stringify(kw)};
    var all = window.collectAllElements();
    var area = function (el) { var r = el.getBoundingClientRect(); return r.width * r.height; };
    var label = all.filter(function (el) { return (el.textContent || '').replace(/\\s/g, '').includes(keyword) && el.getBoundingClientRect().width > 0; })
      .sort(function (a, b) { return area(a) - area(b); })[0];
    if (!label) return null;
    var lr = label.getBoundingClientRect();
    var lcx = lr.left + lr.width / 2;
    var cx = function (el) { var r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    var img = all.filter(function (el) {
      var r = el.getBoundingClientRect();
      return el.tagName === 'IMG' && r.width > 0 && r.top < lr.top && lr.top - r.bottom < 240;
    }).sort(function (a, b) { return Math.abs(cx(a) - lcx) - Math.abs(cx(b) - lcx); })[0];
    if (!img) return null;
    return img.currentSrc || img.src || null;
  `
  return page.evaluate(new Function(code) as unknown as () => string | null)
}

async function waitForCoverCardSrcChange(page: Page, cardName: string, previousSrc: string | undefined, timeoutMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const currentSrc = await getCoverCardSrcByName(page, cardName)
    if (currentSrc && currentSrc !== previousSrc) {
      console.log(`[publish-wechat-channels] cover card src changed for ${cardName}`)
      return currentSrc
    }
    await sleep(800)
  }
  return null
}

async function closeCoverDialog(page: Page, shouldStop: () => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (shouldStop()) throw new Error('已取消')

    // 字符串构建 + new Function，避免 tsx/esbuild keepNames 给命名 const 箭头函数注入 __name。
    // 微信确认按钮结构为 div.weui-desktop-btn_wrp > button.weui-desktop-btn_primary，
    // 「确认」文字同时出现在包裹 div 和真正的 <button> 上，按文档顺序会先命中不可点击的包裹 div；
    // 这里优先解析到真正的 <button>（自身/后代/祖先）并要求可用，先派发 DOM click 再返回坐标兜底。
    const code = `
      var texts = ${JSON.stringify(['确认', '确定', '完成', '使用'])};
      var all = window.collectAllElements();
      var title = all.find(function (el) {
        var t = (el.textContent || '').trim();
        if (t !== '编辑个人主页卡片' && t !== '编辑分享卡片') return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!title) return { open: false };
      var tRect = title.getBoundingClientRect();
      var isEnabled = function (node) {
        var s = window.getComputedStyle(node);
        return !(s.opacity === '0.5' || s.pointerEvents === 'none' || s.cursor === 'not-allowed' || node.getAttribute('aria-disabled') === 'true' || node.disabled === true);
      };
      var resolveButton = function (el) {
        if (el.tagName === 'BUTTON') return el;
        var desc = el.querySelector('button');
        if (desc && (desc.textContent || '').trim() === (el.textContent || '').trim()) return desc;
        var node = el;
        while (node) {
          var tag = node.tagName.toLowerCase();
          var role = node.getAttribute('role');
          if (tag === 'button' || tag === 'a' || role === 'button' || window.getComputedStyle(node).cursor === 'pointer') return node;
          node = node.parentElement;
        }
        return null;
      };
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var text = (el.textContent || '').trim();
        if (texts.indexOf(text) === -1) continue;
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.top < tRect.top) continue;
        var btn = resolveButton(el) || el;
        if (!isEnabled(btn)) return { open: true, text: null };
        var br = btn.getBoundingClientRect();
        btn.click();
        return { open: true, text: text, x: br.left + br.width / 2, y: br.top + br.height / 2 };
      }
      return { open: true, text: null };
    `
    const result = await page.evaluate(new Function(code) as unknown as () => { open: boolean; text?: string | null; x?: number; y?: number })

    if (!result.open) return true
    if (result.text && typeof result.x === 'number' && typeof result.y === 'number') {
      await page.mouse.click(result.x, result.y)
      console.log(`[publish-wechat-channels] cover confirm clicked (dom+mouse): ${result.text}`)
      await sleep(1500)
      continue
    }

    console.log('[publish-wechat-channels] waiting for cover confirm button to be enabled')
    await sleep(800)
  }
  return false
}

// 处理完第一张卡片后页面滚动位置会变，之前一次性抓取的第二张卡片 rect 就失效了，
// 视觉点击落空导致「未进入真正的封面编辑弹窗」。每次点编辑前重新按名字定位「编辑」
// 按钮、滚动到视口中间、返回最新 rect，消除滚动竞态。
type EditRect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
async function refreshCardEditRect(page: Page, cardName: string): Promise<EditRect | null> {
  const kw = cardName.includes('3:4') ? '个人主页卡片' : '分享卡片'
  const code = `
    var keyword = ${JSON.stringify(kw)};
    var all = window.collectAllElements();
    var area = function (el) { var r = el.getBoundingClientRect(); return r.width * r.height; };
    var label = all.filter(function (el) { return (el.textContent || '').replace(/\\s/g, '').includes(keyword) && el.getBoundingClientRect().width > 0; })
      .sort(function (a, b) { return area(a) - area(b); })[0];
    if (!label) return null;
    var lr = label.getBoundingClientRect();
    var lcx = lr.left + lr.width / 2;
    var cx = function (el) { var r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    var edit = all.filter(function (el) {
      var r = el.getBoundingClientRect();
      return (el.textContent || '').trim() === '编辑' && r.width > 0 && r.top < lr.top && lr.top - r.bottom < 240;
    }).sort(function (a, b) { return Math.abs(cx(a) - lcx) - Math.abs(cx(b) - lcx); })[0];
    if (!edit) return null;
    edit.scrollIntoView({ block: 'center', inline: 'center' });
    var r = edit.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  `
  const rect = await page.evaluate(new Function(code) as unknown as () => EditRect | null).catch(() => null)
  if (!rect) return null
  await sleep(400)
  // 滚动后坐标会变，再读一次拿到稳定的视口坐标
  const rect2 = await page.evaluate(new Function(code) as unknown as () => EditRect | null).catch(() => null)
  return rect2 || rect
}

async function uploadCoverForCardAt(
  page: Page,
  cardImage: CoverCardImage,
  coverPath: string,
  shouldStop: () => boolean,
  timeoutMs = 120_000,
): Promise<string> {
  const { cardName } = cardImage
  const deadline = Date.now() + timeoutMs
  console.log(`[publish-wechat-channels] start cover upload for ${cardName}: ${coverPath}`)
  // 点击前重新定位并滚动到该卡片的「编辑」按钮，用最新 rect 覆盖可能已失效的旧坐标。
  const freshRect = await refreshCardEditRect(page, cardName)
  if (freshRect) {
    cardImage = { ...cardImage, ...freshRect }
  }
  await screenshot(page, `cover_${cardName}_00_start`)

  // 1) 点击编辑按钮，失败会重试
  let editOpened = false
  for (let attempt = 0; attempt < 3; attempt++) {
    if (shouldStop()) throw new Error('已取消')
    editOpened = await clickCardEditByVisual(page, cardName, cardImage, 8_000)
    if (editOpened) break
    console.warn(`[publish-wechat-channels] cover edit click attempt ${attempt + 1} failed for ${cardName}, retrying...`)
    await sleep(800)
  }
  if (!editOpened) {
    console.warn(`[publish-wechat-channels] failed to open cover edit dialog for ${cardName}`)
    await screenshot(page, `cover_${cardName}_01_edit_not_opened`)
    throw new Error(`未能打开${cardName}封面编辑弹窗`)
  }
  console.log(`[publish-wechat-channels] cover edit dialog opened for ${cardName}`)
  await screenshot(page, `cover_${cardName}_01_after_edit_click`)

  // 1.5) 4:3 分享卡片会弹出一个 popover，需要点「直接编辑」才能进入真正的编辑弹窗
  const editorDeadline = Date.now() + 15_000
  let editorState = await readCoverEditorUiState(page)
  while (!isWeChatCoverEditorReady(cardName, editorState) && Date.now() < editorDeadline) {
    if (shouldStop()) throw new Error('已取消')
    const directEditPoint = await page.evaluate(() => {
      const all = ((window as any).collectAllElements() as HTMLElement[])
      const hasPopover = all.some(el => /使用此素材作为封面/.test((el.textContent || '').trim()))
      if (!hasPopover) return null

      for (const el of all) {
        const text = (el.textContent || '').trim()
        if (text !== '直接编辑') continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      return null
    })
    if (directEditPoint) {
      await page.mouse.click(directEditPoint.x, directEditPoint.y)
      console.log('[publish-wechat-channels] 直接编辑 mouse-clicked in popover')
    }
    await sleep(800)
    editorState = await readCoverEditorUiState(page)
  }
  if (!isWeChatCoverEditorReady(cardName, editorState)) {
    await screenshot(page, `cover_${cardName}_01_5_editor_not_ready`)
    throw new Error(`${cardName} 未进入真正的封面编辑弹窗`)
  }
  if (cardName.includes('4:3')) {
    await screenshot(page, `cover_${cardName}_01_5_direct_edit`)
  }

  // 2) 点击弹窗里的「上传封面」
  const uploadClicked = await clickByTextInShadow(page, '上传封面', true, 10_000)
  if (!uploadClicked) {
    console.warn('[publish-wechat-channels] 上传封面 button not found')
    await screenshot(page, `cover_${cardName}_02_upload_btn_not_found`)
    throw new Error(`${cardName} 未找到上传封面按钮`)
  }
  console.log('[publish-wechat-channels] 上传封面 clicked')
  await sleep(800)
  await screenshot(page, `cover_${cardName}_02_file_input_ready`)

  // 3) 找封面 file input 并上传
  const inputHandle = await page.evaluateHandle(() => {
    const all = ((window as any).collectAllElements() as HTMLElement[])
    for (const el of all) {
      if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file' && /image/.test((el as HTMLInputElement).accept || '')) {
        return el
      }
    }
    return null
  })
  const fileInput = inputHandle.asElement() as import('puppeteer-core').ElementHandle<HTMLInputElement> | null
  if (!fileInput) {
    console.warn('[publish-wechat-channels] cover file input not found')
    throw new Error(`${cardName} 未找到图片上传 input`)
  }
  await fileInput.uploadFile(coverPath)
  console.log(`[publish-wechat-channels] cover file uploaded: ${path.basename(coverPath)}`)
  await sleep(2000)
  await screenshot(page, `cover_${cardName}_03_file_selected`)

  // 4) 关闭弹窗（超时不立即报错，以卡片 src 变化为权威成功信号）
  const closed = await closeCoverDialog(page, shouldStop, 30_000)
  await screenshot(page, `cover_${cardName}_04_dialog_closed`)
  if (!closed) {
    console.warn(`[publish-wechat-channels] closeCoverDialog timed out for ${cardName}, checking card src anyway`)
  }

  const changedSrc = await waitForCoverCardSrcChange(page, cardName, cardImage.src)
  if (!changedSrc) {
    await screenshot(page, `cover_${cardName}_05_src_not_changed`)
    throw new Error(`${cardName} 封面上传后卡片图片未变化`)
  }
  await sleep(500)
  return changedSrc
}

async function uploadCover(
  page: Page,
  cover3x4Path: string,
  cover4x3Path: string,
  shouldStop: () => boolean,
  checkpoint: WeChatPublishCheckpoint | null,
  onUploaded: (cardName: string, src: string) => Promise<void>,
  timeoutMs = 120_000,
) {
  // 等待所有封面生成完成
  const genDeadline = Date.now() + timeoutMs
  while (Date.now() < genDeadline) {
    if (shouldStop()) throw new Error('已取消')
    const generating = await page.evaluate(() => {
      const all = ((window as any).collectAllElements() as HTMLElement[])
      return all.some(el => (el.textContent || '').includes('生成中'))
    })
    if (!generating) break
    await sleep(800)
  }

  // 视觉方案：根据封面图的宽高比和位置定位两张卡片
  const cards = await findCoverCardImagesByVisual(page, timeoutMs)
  console.log(`[publish-wechat-channels] found cover cards by visual: ${cards.map(c => c.cardName).join(', ')}`)

  for (const card of cards) {
    if (shouldSkipWeChatCoverUpload(card.cardName, card.src, checkpoint)) {
      console.log(`[publish-wechat-channels] checkpoint matches ${card.cardName}, skipping duplicate cover upload`)
      continue
    }
    const coverPath = card.cardName.includes('3:4') ? cover3x4Path : cover4x3Path
    const uploadedSrc = await uploadCoverForCardAt(page, card, coverPath, shouldStop, timeoutMs)
    await onUploaded(card.cardName, uploadedSrc)
  }
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
) {
  const markerPath = getConfirmMarkerPath(taskId)
  // 清理旧 marker
  try { fs.unlinkSync(markerPath) } catch { /* ignore */ }

  await updateRecord(recordId, { status: 'awaiting_confirm' })
  onProgress?.('信息已填好，等待你确认保存草稿', 4, 5)

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

async function saveDraft(page: Page, shouldStop: () => boolean, timeoutMs = 60_000) {
  // 滚动到底部确保保存草稿按钮可见
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await sleep(800)

  const clicked = await page.evaluate((texts) => {
    const all = ((window as any).collectAllElements() as HTMLElement[])
    const candidates = all.filter(el => {
      const text = (el.textContent || '').trim()
      const style = window.getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      const visible = rect.width > 60 && rect.height > 30 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none'
      if (!visible || !texts.includes(text)) return false
      const tag = el.tagName.toLowerCase()
      const role = el.getAttribute('role')
      return tag === 'button' || role === 'button' || style.cursor === 'pointer'
    })
    if (candidates.length === 0) return false
    candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
    const el = candidates[0]
    el.scrollIntoView({ block: 'center' })
    const rect = el.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, ['保存草稿', '存草稿'])

  if (!clicked) {
    throw new Error('未找到「保存草稿」按钮')
  }
  await page.mouse.click(clicked.x, clicked.y)

  // 等待保存成功：出现 toast、成功文案
  const successTexts = ['保存成功', '已保存', '保存草稿成功']
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')
    const ok = await page.evaluate((ts) => {
      const all = ((window as any).collectAllElements() as HTMLElement[])
      for (const el of all) {
        if (ts.some(t => (el.textContent || '').includes(t))) return true
      }
      return false
    }, successTexts)
    if (ok) return
    await sleep(1000)
  }
  // 即使没有明确的成功提示，只要按钮还在就认为可能成功
  console.warn('[publish-wechat-channels] save-draft success toast not found, continuing')
}

async function readDraftListStateOnce(page: Page, expectedTitle: string) {
  await ensureCollector(page)
  return page.evaluate((title) => {
    const all = ((window as any).collectAllElements() as HTMLElement[])
    const visibleTexts = all
      .filter(el => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      })
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)

    const draftTabText = visibleTexts
      .filter(text => /草稿箱\s*\(\d+\)/.test(text))
      .sort((a, b) => a.length - b.length)[0] || ''
    const match = draftTabText.match(/草稿箱\s*\((\d+)\)/)
    const draftCount = match ? Number(match[1]) : null
    const hasExpectedTitle = title ? visibleTexts.some(text => text.includes(title)) : false
    return { draftTabText, draftCount, hasExpectedTitle, sample: visibleTexts.slice(0, 20) }
  }, expectedTitle)
}

// draftListManager 使用 wujie 微前端，reload 后需要数秒才能水合出「草稿箱 (N)」计数。
// 过早读取会拿到未渲染的空壳（draftCount=null），因此先轮询等待计数出现再采集。
async function readDraftListState(page: Page, expectedTitle: string, hydrateTimeoutMs = 20_000) {
  const deadline = Date.now() + hydrateTimeoutMs
  let state = await readDraftListStateOnce(page, expectedTitle)
  while (state.draftCount === null && Date.now() < deadline) {
    await sleep(1000)
    state = await readDraftListStateOnce(page, expectedTitle)
  }
  return state
}

async function verifyDraftPersisted(
  page: Page,
  expectedTitle: string,
  before: WeChatDraftListState,
  shouldStop: () => boolean,
  timeoutMs = 90_000,
) {
  const start = Date.now()
  let lastState: Awaited<ReturnType<typeof readDraftListState>> | null = null
  while (Date.now() - start < timeoutMs) {
    if (shouldStop()) throw new Error('已取消')

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
    await sleep(1500)
    lastState = await readDraftListState(page, expectedTitle)
    if (isWeChatDraftPersistenceVerified(before, lastState)) {
      console.log('[publish-wechat-channels] draft list verified:', JSON.stringify({ before, after: lastState }))
      return lastState
    }

    await sleep(3000)
  }

  throw new Error(`保存草稿后未验证到新增草稿或目标标题: ${JSON.stringify({ before, after: lastState })}`)
}

function isLoginPage(page: Page) {
  return isLoginPageUrl(page.url())
}

async function setPageSessionKey(page: Page, sessionKey: string) {
  await page.evaluate((key) => { window.name = key }, sessionKey).catch(() => {})
}

async function findPageBySessionKey(browser: Browser, sessionKey: string): Promise<Page | null> {
  for (const page of await browser.pages()) {
    if (page.isClosed()) continue
    const currentKey = await page.evaluate(() => window.name).catch(() => '')
    if (currentKey === sessionKey) return page
  }
  return null
}

async function robustGoto(
  browser: Browser,
  url: string,
  maxRetries = 3,
  initialPage?: Page,
  sessionKey?: string,
) {
  let page = initialPage ?? (await browser.pages())[0] ?? (await browser.newPage())
  if (sessionKey) await setPageSessionKey(page, sessionKey)
  const waitUntilOptions = ['networkidle2', 'domcontentloaded', 'load'] as const
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const waitUntil of waitUntilOptions) {
      try {
        console.log(`[publish-wechat-channels] navigating to ${url} (attempt ${attempt + 1}, waitUntil=${waitUntil})`)
        await page.goto(url, { waitUntil, timeout: 60_000 })
        return page
      } catch (err: any) {
        console.warn(`[publish-wechat-channels] navigation failed: ${err.message}`)
        if (err.message?.includes('ERR_EMPTY_RESPONSE') || err.message?.includes('net::')) {
          // 空响应或网络错误：关闭当前页，换新页面试试
          await page.close().catch(() => {})
          page = await browser.newPage()
          if (sessionKey) await setPageSessionKey(page, sessionKey)
          await page.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
          )
          await page.setJavaScriptEnabled(true)
          await applyStealth(page)
          await sleep(3000)
        }
      }
    }
  }
  throw new Error(`无法打开 ${url}，已重试 ${maxRetries} 次`)
}

async function getOrCreatePublishPage(browser: Browser, sessionKey: string) {
  const sessionPage = await findPageBySessionKey(browser, sessionKey)
  if (sessionPage) return sessionPage

  const pages = await browser.pages()
  const unclaimedCreatePages: Page[] = []
  for (const page of pages) {
    if (!page.url().includes('channels.weixin.qq.com/platform/post/create')) continue
    const currentKey = await page.evaluate(() => window.name).catch(() => '')
    if (!currentKey) unclaimedCreatePages.push(page)
  }

  const page = unclaimedCreatePages.length === 1 ? unclaimedCreatePages[0] : await browser.newPage()
  await setPageSessionKey(page, sessionKey)
  return page
}

async function getOrCreateDraftVerifierPage(browser: Browser, sessionKey: string) {
  const verifierKey = `${sessionKey}-draft-verifier`
  let page = await findPageBySessionKey(browser, verifierKey)
  if (!page) {
    page = await browser.newPage()
    await setPageSessionKey(page, verifierKey)
  }
  if (!page.url().includes('channels.weixin.qq.com/platform/post/draftListManager')) {
    page = await robustGoto(
      browser,
      'https://channels.weixin.qq.com/platform/post/draftListManager',
      3,
      page,
      verifierKey,
    )
  }
  await setStableWindow(page)
  await ensureCollector(page)
  return page
}

export function createPublishWeChatChannelsHandler(
  deps: PublishWeChatChannelsDeps = {},
): TaskHandler<PublishWeChatChannelsPayload> {
  return {
    resumable: false,
    maxAttempts: 1,
    async run(ctx: TaskContext<PublishWeChatChannelsPayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!episode) throw new Error(`Episode ${episodeId} not found`)
      if (!episode.videoUrl) throw new Error('Episode video is not ready')
      if (!episode.coverImage3x4Url) throw new Error('Episode 3:4 cover is not ready')
      if (!episode.coverImage4x3Url) throw new Error('Episode 4:3 cover is not ready')

      const videoAbsPath = toAbsPath(episode.videoUrl)
      const cover3x4SourcePath = await resolveMediaPath(episode.coverImage3x4Url)
      const cover4x3SourcePath = await resolveMediaPath(episode.coverImage4x3Url)
      if (!fs.existsSync(videoAbsPath)) throw new Error(`Video file not found: ${videoAbsPath}`)
      if (!fs.existsSync(cover3x4SourcePath)) throw new Error(`Cover file not found: ${cover3x4SourcePath}`)
      if (!fs.existsSync(cover4x3SourcePath)) throw new Error(`Cover file not found: ${cover4x3SourcePath}`)
      const cover3x4AbsPath = await ensureWeChatCoverAspectRatio(cover3x4SourcePath, '3:4')
      const cover4x3AbsPath = await ensureWeChatCoverAspectRatio(cover4x3SourcePath, '4:3')

      const sessionKey = getWeChatPublishSessionKey(episodeId)
      let record = findPublishRecordForPlatform(db.select().from(schema.episodePublishRecords)
        .where(eq(schema.episodePublishRecords.episodeId, episodeId))
        .all(), 'wechat_channels')
      if (!record) {
        const ts = now()
        const inserted = db.insert(schema.episodePublishRecords).values({
          episodeId,
          platform: 'wechat_channels',
          status: 'pending',
          taskId: ctx.taskId,
          sessionKey,
          checkpointJson: JSON.stringify(mergeWeChatPublishCheckpoint(null, 'pending')),
          createdAt: ts,
          updatedAt: ts,
        }).run()
        const [created] = db.select().from(schema.episodePublishRecords)
          .where(eq(schema.episodePublishRecords.id, Number(inserted.lastInsertRowid)))
          .all()
        record = created
      }
      if (!record) throw new Error('Failed to create WeChat Channels publish record')
      const recordId = record.id
      await updateRecord(recordId, {
        status: 'running',
        taskId: ctx.taskId,
        sessionKey,
        errorMessage: null,
      })
      let checkpoint = parseWeChatPublishCheckpoint(record.checkpointJson)

      const requireConfirm = ctx.payload.require_confirm !== false
      const shouldStop = () => ctx.isCancelRequested()
      let browser: Browser | null = null
      try {
        ctx.progress('连接浏览器', 0, 5)
        browser = await getOrLaunchBrowser(deps)

        ctx.progress('打开视频号发布页', 1, 5)
        let page = await getOrCreatePublishPage(browser, sessionKey)
        if (!page.url().includes('channels.weixin.qq.com/platform/post/create')) {
          page = await robustGoto(
            browser,
            'https://channels.weixin.qq.com/platform/post/create',
            3,
            page,
            sessionKey,
          )
        }
        await setPageSessionKey(page, sessionKey)
        await setStableWindow(page)
        await page.setUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        )
        await page.setJavaScriptEnabled(true)
        await applyStealth(page)

        // 把 collectAllElements 注入页面，后续 page.evaluate 中通过 window 调用。
        // 不能依赖模块级函数，因为 puppeteer 序列化 page.evaluate 回调时不会带上外层函数。
        const collectorCode = `
          if (window.collectAllElements) return;
          function collectAllElements(root) {
            const base = root ?? document;
            const result = [];
            const nodes = base.querySelectorAll('*');
            for (const el of nodes) {
              result.push(el);
              if (el.shadowRoot) result.push(...collectAllElements(el.shadowRoot));
            }
            return result;
          }
          window.collectAllElements = collectAllElements;
        `
        await page.evaluate(new Function(collectorCode) as unknown as () => void)

        page.setDefaultTimeout(60_000)
        page.setDefaultNavigationTimeout(60_000)

        page.on('dialog', async (dialog) => {
          if (dialog.type() === 'beforeunload') await dialog.accept().catch(() => {})
          else await dialog.dismiss().catch(() => {})
        })

        await screenshot(page, '01_opened')

        if (isLoginPage(page)) {
          ctx.progress('等待扫码登录', 2, 5)
          await waitForLogin(page, recordId!, shouldStop, (msg, c, t) => ctx.progress(msg, c, t), (type, data) => ctx.event(type, data), 300_000)
          await screenshot(page, '02_logged_in')
        }

        ctx.progress('等待发布页初始化', 2, 5)
        await waitForPageReady(page, recordId!, ctx, shouldStop, 120_000)
        await screenshot(page, '02_page_ready')

        ctx.progress('上传视频', 2, 5)
        const videoState = await uploadVideo(page, videoAbsPath, shouldStop, (msg, c, t) => ctx.progress(msg, c, t))
        checkpoint = await writeCheckpoint(recordId, 'video_ready', {
          personalCoverSrc: videoState.personalCoverSrc,
          shareCoverSrc: videoState.shareCoverSrc,
        })
        await screenshot(page, '03_video_uploaded')

        ctx.progress('填写信息', 3, 5)
        const title = ctx.payload.short_title || episode.videoTitle || episode.title || `第${episode.episodeNumber}集`
        await fillShortTitle(page, title)
        // 作品描述 = 开头钩子 + 结尾悬念 组合，不做任何 AI 创作
        const desc = [episode.openingHook, episode.cliffhanger]
          .map((s) => (s || '').trim())
          .filter(Boolean)
          .join('\n\n')
        await fillDescription(page, desc)
        await uploadCover(
          page,
          cover3x4AbsPath,
          cover4x3AbsPath,
          shouldStop,
          checkpoint,
          async (cardName, src) => {
            const isPersonal = cardName.includes('3:4')
            checkpoint = await writeCheckpoint(
              recordId,
              isPersonal ? 'cover_3x4_done' : 'cover_4x3_done',
              isPersonal ? { uploadedPersonalCoverSrc: src } : { uploadedShareCoverSrc: src },
            )
          },
        )
        checkpoint = await writeCheckpoint(recordId, 'metadata_ready')
        if (ctx.payload.stop_after_cover_upload) {
          await screenshot(page, '04_cover_upload_done')
          ctx.progress('封面上传完成，等待人工检查', 4, 5)
          return { episode_id: episodeId, platform: 'wechat_channels', status: 'cover_uploaded', stopped: true }
        }
        await screenshot(page, '04_meta_filled')

        ctx.progress('保存草稿', 4, 5)
        if (requireConfirm) {
          await waitForHumanConfirm(ctx.taskId, recordId!, shouldStop, (msg, c, t) => ctx.progress(msg, c, t))
        }
        const verifierPage = await getOrCreateDraftVerifierPage(browser, sessionKey)
        const draftBefore = await readDraftListState(verifierPage, title)
        checkpoint = await writeCheckpoint(recordId, 'metadata_ready', {
          draftCountBefore: draftBefore.draftCount,
        })
        await saveDraft(page, shouldStop)
        checkpoint = await writeCheckpoint(recordId, 'save_requested')
        await screenshot(page, '05_draft_saved')
        const draftCheck = await verifyDraftPersisted(verifierPage, title, draftBefore, shouldStop)
        checkpoint = await writeCheckpoint(recordId, 'draft_verified', {
          draftCountAfter: draftCheck.draftCount,
        })
        await screenshot(verifierPage, '06_draft_list_verified')

        const draftUrl = verifierPage.url()
        if (recordId) {
          await updateRecord(recordId, {
            status: 'success',
            draftUrl,
            errorMessage: null,
          })
        }

        ctx.progress('发布完成', 5, 5)
        return {
          episode_id: episodeId,
          platform: 'wechat_channels',
          draft_url: draftUrl,
          draft_check: draftCheck,
        }
      } catch (err: any) {
        if (recordId) {
          const status = ctx.isCancelRequested() ? 'canceled' : 'failed'
          await updateRecord(recordId, { status, errorMessage: err.message })
        }
        throw err
      } finally {
        browser?.disconnect()
      }
    },
  }
}

export function registerPublishWeChatChannelsHandler() {
  registerTaskHandler('publish.wechat_channels', createPublishWeChatChannelsHandler())
}

export function confirmPublishWeChatChannels(taskId: number) {
  const markerPath = getConfirmMarkerPath(taskId)
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  fs.writeFileSync(markerPath, JSON.stringify({ confirmedAt: now(), taskId }))
}
