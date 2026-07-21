/**
 * 抖音发布 · 共享库（DRY 核心）
 *
 * 四个阶段脚本（prepare / open / operate / verify）都 import 这里的函数，
 * 脆弱的 DOM 逻辑只有一份。页面改版只改这个文件。
 *
 * 浏览器是 CDP 上的真实 Chrome（默认 127.0.0.1:9224，profile=data/douyin-profile），
 * 页面状态跨脚本进程保留 —— 这是"分阶段、不轮询"的根基。
 *
 * 抖音与视频号的关键差异：
 *  - 普通 DOM（不是 wujie/shadow DOM），大部分用标准 querySelector 即可；
 *    只有「暂存离开」按钮可能在 shadow 里，用 TreeWalker 穿透。
 *  - 封面：一个 modal 里用「设置横封面」/「设置竖封面」两个 tab 切换，先传横(4:3)再切竖(3:4)，
 *    最后点一次「完成」。
 *  - 保存草稿按钮文字是「暂存离开」，不是「保存草稿」。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(__dirname, '../../..')
export const CDP_URL = process.env.DOUYIN_CDP_URL || 'http://127.0.0.1:9224'
export const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'
export const DEBUG_DIR = path.join(PROJECT_ROOT, 'data/douyin-profile/debug')

export const COVER_TARGETS = {
  '4:3': { width: 1200, height: 900 },
  '3:4': { width: 900, height: 1200 },
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

export function fail(message, code = 1) {
  process.stderr.write(`[douyin] ${message}\n`)
  process.exit(code)
}

export async function screenshot(page, name) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true })
    const file = path.join(DEBUG_DIR, `${Date.now()}_${name}.png`)
    await page.screenshot({ path: file, fullPage: false })
    return file
  } catch {
    return null
  }
}

// --- CDP 连接 / 页面 ------------------------------------------------------

/** beforeunload 原生弹窗自动 accept，其余 dismiss。防重复注册。 */
export function attachDialogHandler(page) {
  if (page.__dialogHandlerAttached) return
  page.__dialogHandlerAttached = true
  page.on('dialog', async (dialog) => {
    try {
      if (dialog.type() === 'beforeunload') await dialog.accept()
      else await dialog.dismiss()
    } catch { /* ignore */ }
  })
}

export async function connectBrowser() {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  // 全局给所有现存 + 未来 page 挂 beforeunload 处理，根治 "Leave site?" 卡导航。
  try {
    for (const p of await browser.pages()) attachDialogHandler(p)
    browser.on('targetcreated', async (target) => {
      try {
        const p = await target.page()
        if (p) attachDialogHandler(p)
      } catch { /* 非 page target */ }
    })
  } catch { /* 老版本无 targetcreated */ }
  return browser
}

/** 找到（或新建并跳转到）抖音上传页。返回 page。 */
export async function getUploadPage(browser, { goto = true } = {}) {
  const pages = await browser.pages()
  let page = pages.find((p) => p.url().includes('creator.douyin.com'))
  if (!page) page = await browser.newPage()
  attachDialogHandler(page)
  if (goto && !page.url().includes('/content/upload') && !page.url().includes('/content/post')) {
    await page.goto(UPLOAD_URL, { waitUntil: 'networkidle2', timeout: 60_000 })
  }
  await page.setViewport({ width: 1440, height: 900 })
  page.setDefaultTimeout(60_000)
  page.setDefaultNavigationTimeout(60_000)
  return page
}

// --- 登录检测 -------------------------------------------------------------

/** 返回 'logged_in' | 'qrcode' | 'sms' | 'unknown'。 */
export async function detectLoginPhase(page) {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText || ''
    // 已登录检查优先：URL 在 creator.douyin.com 且有创作页元素
    const loggedInEl = document.querySelector(
      'div[class*="drag-upload"], input[type="file"], button[class*="douyin-creator-master-button"], #douyin-creator-master-side-upload-wrap, div[class*="tab-item"], div[class*="creator-master"]',
    )
    if (location.href.includes('creator.douyin.com') && loggedInEl) return 'logged_in'
    // 二维码登录（仅在非已登录页面判断，避免误判）
    const hasQr = !!document.querySelector('img[aria-label="二维码"], img[src*="qr"], .qr_code, [class*="qrcode"]')
      || /扫码登录|请使用抖音扫一扫|打开「抖音APP」/.test(bodyText)
    if (hasQr) return 'qrcode'
    // 短信验证
    if (document.querySelector('div[class*="uc_verification_component"]') && /接收短信验证码|请输入验证码/.test(bodyText)) return 'sms'
    return 'unknown'
  })
}

// --- 通用点击 -------------------------------------------------------------

/** 按可见文字点击（button/a/div[role=button]/span/label/div/li）。 */
export async function clickByText(page, texts, { timeout = 8_000, exact = false } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate((wanted, exactMatch) => {
      const tags = ['button', 'a', 'div[role="button"]', 'span', 'label', 'div', 'li']
      const els = document.querySelectorAll(tags.join(','))
      for (const el of els) {
        const t = (el.textContent || '').trim()
        const ok = exactMatch ? wanted.includes(t) : wanted.some((w) => t.includes(w))
        if (ok) {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) { el.scrollIntoView({ block: 'center' }); el.click(); return true }
        }
      }
      return false
    }, texts, exact)
    if (clicked) return true
    await sleep(400)
  }
  return false
}

export async function waitForCondition(page, fn, { timeout = 15_000, interval = 500 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await page.evaluate(fn)) return true } catch { /* ignore */ }
    await sleep(interval)
  }
  return false
}

// --- 视频上传 -------------------------------------------------------------

export async function isVideoUploaded(page) {
  return page.evaluate(() => {
    const failed = /上传失败/.test(document.body?.innerText || '')
    if (failed) return false
    const done = document.querySelector('video, [class*="video-preview"], [class*="recommendTitle"], [class*="recommendCoverContainer"]')
    const uploading = document.querySelector('[class*="uploading-container"]')
    return !!done && !uploading
  })
}

export async function uploadVideo(page, videoPath, { timeoutMs = 600_000 } = {}) {
  if (await isVideoUploaded(page)) return { skipped: true }

  // 如果页面有「重新上传」按钮（上传失败态），点它触发 file chooser
  let accepted = false
  const hasRetry = await page.evaluate(() => /重新上传/.test(document.body?.innerText || ''))
  if (hasRetry) {
    try {
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 8_000 }),
        clickByText(page, ['重新上传'], { timeout: 8_000 }),
      ])
      await chooser.accept([videoPath])
      accepted = true
    } catch { /* 回退 */ }
  }

  // 正常上传：file chooser + 点「上传视频」
  if (!accepted) {
    try {
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 8_000 }),
        clickByText(page, ['上传视频'], { timeout: 8_000 }),
      ])
      await chooser.accept([videoPath])
      accepted = true
    } catch { /* 回退直接 input */ }
  }

  if (!accepted) {
    const input = await page.$('div[class*="drag-upload"] input[type="file"], input[type="file"]')
    if (!input) throw new Error('未找到视频 file input')
    await input.uploadFile(videoPath)
  }

  const ok = await waitForCondition(page, () => {
    const done = document.querySelector('video, [class*="video-preview"], [class*="recommendTitle"], [class*="recommendCoverContainer"]')
    const uploading = document.querySelector('[class*="uploading-container"]')
    return !!done && !uploading
  }, { timeout: timeoutMs, interval: 3_000 })
  if (!ok) throw new Error('视频上传超时')
  await sleep(1500)
  return { skipped: false }
}

// --- 标题 / 描述 ----------------------------------------------------------

export async function fillTitle(page, title) {
  const input = await page.$('input[placeholder*="作品标题"], input.semi-input-default[placeholder*="标题"], input[placeholder*="标题"]')
  if (!input) return false
  await input.click({ count: 3 })
  await input.type(title.slice(0, 55), { delay: 15 })
  await sleep(400)
  return true
}

export async function fillDescription(page, description) {
  const editor = await page.$('div[data-placeholder*="作品简介"][contenteditable="true"], div.editor-kit-container[contenteditable="true"], div[contenteditable="true"][data-slate-editor="true"], div[contenteditable="true"][data-placeholder*="简介"]')
  if (!editor) return false
  await editor.click()
  const selectAll = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(selectAll)
  await page.keyboard.press('a')
  await page.keyboard.up(selectAll)
  await page.keyboard.press('Delete')
  await page.keyboard.type(description.slice(0, 500), { delay: 5 })
  await sleep(400)
  // 校验框架收到文字
  const len = await page.evaluate((sel) => {
    const e = document.querySelector(sel)
    return e ? (e.innerText || '').trim().length : 0
  }, 'div[data-placeholder*="作品简介"][contenteditable="true"], div.editor-kit-container[contenteditable="true"], div[contenteditable="true"][data-slate-editor="true"], div[contenteditable="true"][data-placeholder*="简介"]')
  return len > 0
}

// --- 封面（横 4:3 + 竖 3:4，一个 modal 内 tab 切换）------------------------

/** 打开封面 modal。判据：出现「设置横封面」+「设置竖封面」大容器。 */
async function openCoverModal(page, timeoutMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const open = await page.evaluate(() => Array.from(document.querySelectorAll('*')).some((e) => {
      const t = e.textContent || ''
      return /设置横封面/.test(t) && /设置竖封面/.test(t) && e.getBoundingClientRect().width > 400
    }))
    if (open) return true
    // 滚到「设置封面」并点「选择封面」
    await page.evaluate(() => {
      const label = Array.from(document.querySelectorAll('*')).find((e) => (e.textContent || '').trim() === '设置封面')
      if (label) label.scrollIntoView({ block: 'center' })
      const slot = Array.from(document.querySelectorAll('*')).find((e) => (e.textContent || '').trim() === '选择封面' && e.getBoundingClientRect().width > 0)
      if (slot) slot.click()
    })
    await sleep(1000)
  }
  return false
}

/** 在 modal 内上传一张封面图（当前激活的 tab）。 */
async function uploadCoverToModal(page, coverPath) {
  // 标记「上传封面」附近的 file input
  const marked = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('*')).filter((e) => {
      const t = (e.textContent || '').trim()
      const w = e.getBoundingClientRect().width
      return t === '上传封面' && w > 0 && w < 220
    })
    for (const label of labels) {
      let node = label
      for (let i = 0; i < 5 && node; i++) {
        const input = node.querySelector && node.querySelector('input[type="file"]')
        if (input) { input.setAttribute('data-dy-cover-upload', '1'); return true }
        node = node.parentElement
      }
    }
    // 兜底：modal 内任意 image input
    const any = Array.from(document.querySelectorAll('input[type="file"]')).find((i) => (i.accept || '').includes('image'))
    if (any) { any.setAttribute('data-dy-cover-upload', '1'); return true }
    return false
  })
  if (!marked) return false
  const input = await page.$('input[data-dy-cover-upload="1"]')
  if (!input) return false
  await input.uploadFile(coverPath)
  // 上传完成信号：出现「重新上传」
  await waitForCondition(page, () => /重新上传/.test(document.body.innerText || ''), { timeout: 15_000, interval: 500 })
  await sleep(1500)
  await page.evaluate(() => document.querySelector('input[data-dy-cover-upload="1"]')?.removeAttribute('data-dy-cover-upload'))
  return true
}

/** 切到竖封面 tab，验证激活态（红色 rgb(254,44,85)）。 */
async function switchToVerticalCover(page, timeoutMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('*')).filter((e) => (e.textContent || '').trim() === '设置竖封面' && e.getBoundingClientRect().width > 0)
      const tab = btns.find((e) => { const r = e.getBoundingClientRect(); return r.y < 200 && r.width < 160 })
      const target = tab || btns.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]
      if (target) target.click()
    })
    await sleep(800)
    const active = await page.evaluate(() => Array.from(document.querySelectorAll('*')).some((e) => (e.textContent || '').trim() === '设置竖封面' && getComputedStyle(e).color === 'rgb(254, 44, 85)'))
    if (active) return true
  }
  return false
}

/** 点 modal 内「完成」（小按钮，宽<130）。 */
async function clickCoverDone(page) {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('*')).filter((e) => {
      const t = (e.textContent || '').trim()
      const w = e.getBoundingClientRect().width
      return t === '完成' && w > 0 && w < 130
    }).sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)
    if (btns[0]) { btns[0].click(); return true }
    return false
  })
}

/** 完整双封面流程。返回 { cover4x3, cover3x4, done }。 */
export async function uploadCovers(page, cover4x3Path, cover3x4Path) {
  const result = { cover4x3: false, cover3x4: false, done: false }
  if (!(await openCoverModal(page))) return result
  await screenshot(page, 'cover_modal_opened')

  // 横封面 4:3（默认 tab）
  result.cover4x3 = await uploadCoverToModal(page, cover4x3Path)
  await screenshot(page, 'cover_4x3_uploaded')

  // 切竖封面 tab —— 中间不点「完成」
  await switchToVerticalCover(page)
  result.cover3x4 = await uploadCoverToModal(page, cover3x4Path)
  await screenshot(page, 'cover_3x4_uploaded')

  // 点一次「完成」关闭 modal
  await clickCoverDone(page)
  await sleep(2500)
  // 验证 modal 关闭：modal 容器（宽>400 且同时含两个 tab 文字）不再可见
  result.done = await page.evaluate(() => {
    const modalOpen = Array.from(document.querySelectorAll('*')).some((e) => {
      const t = e.textContent || ''
      return /设置横封面/.test(t) && /设置竖封面/.test(t) && e.getBoundingClientRect().width > 400
    })
    const missing = /横\/竖双封面缺失|封面缺失/.test(document.body.innerText || '')
    return !modalOpen && !missing
  })
  await screenshot(page, 'cover_done')
  return result
}

// --- 弹窗 -----------------------------------------------------------------

export async function dismissPopups(page) {
  await clickByText(page, ['我知道了', '同意', '暂不', '好的'], { timeout: 1_500 }).catch(() => {})
}

// --- 保存草稿（暂存离开）--------------------------------------------------

export async function saveDraft(page, timeoutMs = 120_000) {
  await dismissPopups(page)
  // 深度遍历（含 shadow DOM）找「暂存离开」
  const coord = await page.evaluate(() => {
    const draftTexts = ['暂存离开', '保存草稿', '存草稿']
    const deepAll = []
    const stack = [document]
    while (stack.length) {
      const root = stack.pop()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
      let node = walker.nextNode()
      while (node) {
        deepAll.push(node)
        if (node.shadowRoot) stack.push(node.shadowRoot)
        node = walker.nextNode()
      }
    }
    // 精确匹配优先
    let found = deepAll.find((e) => draftTexts.includes((e.textContent || '').trim()) && e.getBoundingClientRect().width > 0)
    if (!found) found = deepAll.find((e) => /暂存离开|保存草稿|存草稿/.test((e.textContent || '').trim()) && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 200)
    if (!found) return null
    found.scrollIntoView({ block: 'center' })
    const r = found.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  if (!coord) return false
  await page.mouse.click(coord.x, coord.y)

  // 成功信号：toast / 离开上传路由 / 出现「继续编辑」
  const ok = await waitForCondition(page, () => {
    const toast = Array.from(document.querySelectorAll('span[class*="semi-toast-content-text"]')).some((e) => /保存成功|已保存|草稿/.test(e.textContent || ''))
    const leftUpload = !location.href.includes('/content/upload') && !location.href.includes('/content/post/video')
    const resumeBtn = Array.from(document.querySelectorAll('*')).some((e) => (e.textContent || '').trim() === '继续编辑' && e.getBoundingClientRect().width > 0)
    return toast || leftUpload || resumeBtn
  }, { timeout: timeoutMs, interval: 1_500 })
  return ok
}
