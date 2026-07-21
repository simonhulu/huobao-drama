/**
 * 视频号发布 · 共享库（DRY 核心）
 *
 * 四个阶段脚本（prepare / open / operate / verify）都 import 这里的函数，
 * 脆弱的 DOM 逻辑只有一份。page 改版只改这个文件。
 *
 * 运行方式：用 tsx 或 node 跑阶段脚本，这些脚本 import 本模块。
 * 浏览器不在本进程里 —— 它是 CDP 上的真实 Chrome（默认 127.0.0.1:9222），
 * 页面状态（已传视频、已填字段）跨脚本进程保留，这正是"分阶段、不轮询"的根基。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(__dirname, '../../..')
export const CDP_URL = process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222'
export const CREATE_URL = 'https://channels.weixin.qq.com/platform/post/create'
export const DEBUG_DIR = path.join(PROJECT_ROOT, 'data/wechat-channels-profile/debug')

export const COVER_TARGETS = {
  '4:3': { width: 1200, height: 900 },
  '3:4': { width: 900, height: 1200 },
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 输出一行 JSON 结果到 stdout（阶段脚本的机器可读契约）。 */
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** 失败退出：stderr 打印原因，指定退出码。 */
export function fail(message, code = 1) {
  process.stderr.write(`[wechat] ${message}\n`)
  process.exit(code)
}

export function smartTruncateChinese(text, maxLen) {
  if (!text) return ''
  if (text.length <= maxLen) return text
  const badEndChars = new Set(['的', '了', '与', '和', '或', '在', '从', '到', '为', '被', '把', '将', '向', '对', '于', '以', '及', '而', '但', '因', '所', '之', '着', '过', '吗', '呢', '吧', '啊'])
  const punctuation = new Set(['，', '。', '；', '：', '！', '？', '、', '”', '"', '」', '』', ')', '）', ']', '】'])
  let cut = maxLen
  for (let i = maxLen; i >= Math.max(0, maxLen - 8); i--) {
    if (punctuation.has(text[i - 1])) { cut = i; break }
  }
  while (cut > 1 && badEndChars.has(text[cut - 1])) cut--
  if (cut < 8) cut = maxLen
  return text.slice(0, cut)
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

// --- 浏览器端注入 ---------------------------------------------------------
// 视频号是 wujie 微前端 + shadow DOM，普通 querySelectorAll 穿不透。
// 把 collectAllElements 注入到 window，之后所有 page.evaluate 统一走 window.__collectAll()。
// 注意：用字符串注入而非命名箭头函数，规避 esbuild/tsx keepNames 注入 __name 导致的
// "ReferenceError: __name is not defined"。
const COLLECTOR_CODE = `
  if (!window.__collectAll) {
    window.__collectAll = function (root) {
      var base = root || document;
      var out = [];
      var nodes = base.querySelectorAll('*');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        out.push(el);
        if (el.shadowRoot) {
          var inner = window.__collectAll(el.shadowRoot);
          for (var j = 0; j < inner.length; j++) out.push(inner[j]);
        }
      }
      return out;
    };
  }
`

export async function injectCollector(page) {
  // eslint-disable-next-line no-new-func
  await page.evaluate(new Function(COLLECTOR_CODE))
}

// --- CDP 连接 / 页面获取 --------------------------------------------------

export async function connectBrowser() {
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  // 全局兜底：给所有现存 + 未来新建的 page 自动挂 beforeunload 处理器。
  // 任何脚本一连上就覆盖，不再依赖各处手动 attach —— 这是"Leave site?"原生弹窗
  // 卡住导航/保存的根治办法。
  try {
    for (const p of await browser.pages()) attachDialogHandler(p)
    browser.on('targetcreated', async (target) => {
      try {
        const p = await target.page()
        if (p) attachDialogHandler(p)
      } catch { /* 非 page target 忽略 */ }
    })
  } catch { /* 老版本 puppeteer 无 targetcreated 时忽略 */ }
  return browser
}

/**
 * 注册 Chrome 原生对话框监听。保存草稿触发页面跳转时，浏览器会弹
 * "Leave site? Changes you made may not be saved."(beforeunload) 原生框，
 * 无人值守时必须自动 accept，否则导航卡住、草稿保存流程走不完。
 * 用标志防止在同一 page 上重复注册。
 */
export function attachDialogHandler(page) {
  if (page.__dialogHandlerAttached) return
  page.__dialogHandlerAttached = true
  page.on('dialog', async (dialog) => {
    try {
      if (dialog.type() === 'beforeunload') await dialog.accept()
      else await dialog.dismiss()
    } catch { /* dialog 可能已被处理 */ }
  })
}

/** 找到（或新建并跳转到）视频号发布页。返回 page。 */
export async function getPublishPage(browser, { goto = true } = {}) {
  const pages = await browser.pages()
  let page = pages.find((p) => p.url().includes('channels.weixin.qq.com'))
  if (!page) page = await browser.newPage()
  attachDialogHandler(page)
  if (goto && !page.url().includes('/platform/post/create')) {
    await page.goto(CREATE_URL, { waitUntil: 'networkidle2', timeout: 60_000 })
  }
  await page.setViewport({ width: 1400, height: 860 })
  await page.setJavaScriptEnabled(true)
  await injectCollector(page)
  page.setDefaultTimeout(60_000)
  page.setDefaultNavigationTimeout(60_000)
  return page
}

export function isLoginUrl(url) {
  return /\/login|\/auth/.test(url) || url === 'https://channels.weixin.qq.com/'
}

/** 判断是否已登录：登录页 URL 或页面出现"扫码/登录"字样即视为未登录。 */
export async function isLoggedIn(page) {
  if (isLoginUrl(page.url())) return false
  await injectCollector(page)
  const needLogin = await page.evaluate(() => {
    const els = window.__collectAll()
    return els.some((el) => {
      const t = (el.textContent || '').trim()
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && (t === '扫码登录' || t === '账号登录' || t.includes('请使用微信扫码'))
    })
  })
  return !needLogin
}

/** 发布页是否已就绪（出现上传区或已上传视频）。 */
export async function waitForCreateReady(page, timeoutMs = 120_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await injectCollector(page)
    const ready = await page.evaluate(() => {
      const els = window.__collectAll()
      const hasUploadArea = els.some((el) => {
        const t = (el.textContent || '').trim()
        return (t.includes('上传视频') || t.includes('拖拽视频到此') || (el.tagName === 'INPUT' && el.type === 'file'))
      })
      const hasVideo = els.some((el) => el.tagName === 'VIDEO' && el.getBoundingClientRect().width > 100)
      return hasUploadArea || hasVideo
    })
    if (ready) return true
    await sleep(1500)
  }
  return false
}

// --- 视频上传 -------------------------------------------------------------

/**
 * 视频是否已上传完成。
 * 权威信号：上传进行时页面有「取消上传」按钮和「NN%」进度文字；两者都消失才算完成。
 * 不能用「封面预览」文字——它在上传中途就出现了，会导致误判提前。
 * 还要求确实存在可见的 video 预览元素（排除刚进页面什么都没有的情况）。
 */
export async function isVideoUploaded(page) {
  await injectCollector(page)
  return page.evaluate(() => {
    const els = window.__collectAll()
    let uploading = false
    let hasVisibleVideo = false
    for (const el of els) {
      const r = el.getBoundingClientRect()
      if (el.tagName === 'VIDEO' && r.width > 100 && r.height > 100) hasVisibleVideo = true
      if (r.width > 0 && el.children.length === 0) {
        const t = (el.textContent || '').trim()
        if (t === '取消上传' || /^\d{1,3}%$/.test(t)) uploading = true
      }
    }
    return hasVisibleVideo && !uploading
  })
}

async function findFileInput(page, { imageOnly = false } = {}, timeoutMs = 15_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await injectCollector(page)
    const handle = await page.evaluateHandle((imgOnly) => {
      const els = window.__collectAll()
      for (const el of els) {
        if (el.tagName === 'INPUT' && el.type === 'file') {
          if (imgOnly && !(el.accept || '').includes('image')) continue
          return el
        }
      }
      return null
    }, imageOnly)
    const input = handle.asElement()
    if (input) return input
    await sleep(500)
  }
  return null
}

export async function uploadVideo(page, videoPath, { timeoutMs = 600_000 } = {}) {
  if (await isVideoUploaded(page)) return { skipped: true }
  const input = await findFileInput(page, {}, 10_000)
  if (!input) throw new Error('未找到视频文件 input')
  await input.uploadFile(videoPath)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isVideoUploaded(page)) {
      await sleep(1500)
      return { skipped: false }
    }
    await sleep(5000)
  }
  throw new Error('视频上传超时')
}

// --- 标题 / 描述 ----------------------------------------------------------

export async function fillShortTitle(page, title) {
  const text = smartTruncateChinese(title, 16)
  await injectCollector(page)
  const ok = await page.evaluate((t) => {
    const els = window.__collectAll()
    const input = els.find((el) => el.tagName === 'INPUT' && (el.placeholder || '').includes('短标题'))
    if (!input) return false
    input.focus()
    input.value = t
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.blur()
    return true
  }, text)
  await sleep(500)
  return ok
}

export async function fillDescription(page, description) {
  const text = (description || '').slice(0, 200)
  await injectCollector(page)
  // 1) 定位描述编辑器并聚焦、清空。用真实键盘输入而非 innerText 赋值——
  //    直接赋值会绕过 Vue 数据绑定，视觉有字但框架 state 为空，保存后描述丢失。
  const found = await page.evaluate(() => {
    const els = window.__collectAll()
    const editor = els.find(
      (el) => el.tagName === 'DIV' && el.className && String(el.className).includes('input-editor') && el.getAttribute('contenteditable') !== null,
    )
    if (!editor) return null
    editor.scrollIntoView({ block: 'center' })
    editor.focus()
    // 清空已有内容
    editor.innerHTML = ''
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    const r = editor.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (!found) return false
  // 2) 点击editor确保光标在里面，再真实键入
  await page.mouse.click(found.x, found.y)
  await sleep(300)
  await page.keyboard.type(text, { delay: 8 })
  await sleep(500)
  // 3) 校验框架真的收到了文字
  await injectCollector(page)
  const filledLen = await page.evaluate(() => {
    const els = window.__collectAll()
    const editor = els.find(
      (el) => el.tagName === 'DIV' && el.className && String(el.className).includes('input-editor') && el.getAttribute('contenteditable') !== null,
    )
    return editor ? (editor.innerText || '').trim().length : 0
  })
  return filledLen > 0
}

// --- 封面上传（两张卡片：3:4 个人主页 / 4:3 分享）-------------------------

/**
 * 关掉"使用此素材作为封面？"推荐浮层（ant-popover，无关闭按钮）。
 * 它在视频上传后/封面上传后出现，会盖住另一张卡片的「编辑」按钮。
 * ant-popover 点击外部即消失：按 Esc + 点页面左上空白区。
 */
async function dismissCoverSuggestPopover(page) {
  await injectCollector(page)
  const hasPopover = await page.evaluate(() => {
    const els = window.__collectAll()
    return els.some((el) => (el.textContent || '').trim() === '使用此素材作为封面？' && el.getBoundingClientRect().width > 0)
  })
  if (!hasPopover) return false
  // 只点页面外部空白关闭 ant-popover —— 绝不能按 Esc，Esc 会触发
  // 视频号"将此次编辑保留？"离开确认弹窗，盖住整个页面。
  await page.mouse.click(200, 120).catch(() => {})
  await sleep(500)
  return true
}

/**
 * 保存草稿点击后视频号会弹「将此次编辑保留?」确认弹窗，必须点「保存」才真正落地草稿。
 * 注意：标题用的是【半角问号 ?】，不是全角？——两者都要兼容，这是之前草稿丢失的根因。
 * 返回是否处理过。
 */
async function keepEditIfPrompted(page) {
  await injectCollector(page)
  const clicked = await page.evaluate(() => {
    const els = window.__collectAll()
    // 兼容全角/半角问号 + 去掉所有问号做包含匹配
    const title = els.find((el) => {
      const t = (el.textContent || '').trim()
      return (t === '将此次编辑保留?' || t === '将此次编辑保留？' || t.replace(/[?？]/g, '') === '将此次编辑保留') && el.getBoundingClientRect().width > 0
    })
    if (!title) return false
    // 点「保存」primary button（排除 wrp 包装 div / popover span）
    const btn = els.find((el) => {
      const t = (el.textContent || '').trim()
      return el.tagName === 'BUTTON' && t === '保存' && String(el.className || '').includes('primary') && el.getBoundingClientRect().width > 0
    })
    if (btn) { btn.click(); return true }
    return false
  })
  if (clicked) await sleep(2000)
  return clicked
}

/**
 * 读取当前打开的封面弹窗标题。
 * 权威判断：可见的 weui-desktop-dialog__title 元素文字，而不是页面里任意"卡片"文字
 * （卡片区的 cover-tips 标签、隐藏弹窗模板都含"卡片"，会误判）。
 * 返回 '编辑个人主页卡片' | '编辑分享卡片' | null。
 */
async function getOpenCoverDialogTitle(page) {
  await injectCollector(page)
  return page.evaluate(() => {
    const els = window.__collectAll()
    const titleEl = els.find((el) => {
      const cls = String(el.className || '')
      const t = (el.textContent || '').trim()
      return cls.includes('weui-desktop-dialog__title') && t.includes('卡片') && el.getBoundingClientRect().width > 0
    })
    return titleEl ? titleEl.textContent.trim() : null
  })
}

/** 打开指定封面卡片的编辑弹窗。side: 'vertical'(3:4) | 'horizon'(4:3)。 */
async function openCoverDialog(page, side, timeoutMs = 20_000) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(800)
  const expectedTitle = side === 'vertical' ? '编辑个人主页卡片' : '编辑分享卡片'
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const current = await getOpenCoverDialogTitle(page)
    if (current === expectedTitle) return true
    // 若开着的是另一张卡片的弹窗，先关掉
    if (current && current !== expectedTitle) {
      await closeAnyCoverDialog(page)
      await sleep(600)
    }

    // 优先走浮层：3:4 上传后系统给卡片弹"使用此素材作为封面?"浮层，
    // 点它的「直接编辑」是进入该卡片编辑弹窗最可靠的入口（比点卡片「编辑」稳）。
    if (await hasCoverSuggestPopover(page)) {
      const de = await clickPopoverUseMaterial(page)
      if (de) {
        await sleep(1500)
        const title = await getOpenCoverDialogTitle(page)
        if (title === expectedTitle) return true
        // 进错了卡片弹窗，关掉重来
        if (title && title !== expectedTitle) { await closeAnyCoverDialog(page); await sleep(600) }
      }
    }

    // 无浮层：点卡片「编辑」。按 x 坐标区分左右，只认 class 含 edit-btn 的「编辑」。
    const clicked = await page.evaluate((wantVertical) => {
      const els = window.__collectAll()
      const editBtns = els.filter((el) => {
        const t = (el.textContent || '').trim()
        const r = el.getBoundingClientRect()
        const cls = String(el.className || '')
        return t === '编辑' && cls.includes('edit-btn') && r.width > 0 && r.height > 0
      })
      if (editBtns.length < 2) return { ok: false, count: editBtns.length }
      editBtns.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
      const target = wantVertical ? editBtns[0] : editBtns[editBtns.length - 1]
      target.scrollIntoView({ block: 'center' })
      target.click()
      return { ok: true, count: editBtns.length }
    }, side === 'vertical')

    if (clicked.ok) {
      await sleep(1500)
      let title = await getOpenCoverDialogTitle(page)
      if (title === expectedTitle) return true

      // 点编辑后没开弹窗、反而弹出浮层 —— 点浮层「直接编辑」
      if (await hasCoverSuggestPopover(page)) {
        const de = await clickPopoverUseMaterial(page)
        if (de) {
          await sleep(1500)
          title = await getOpenCoverDialogTitle(page)
          if (title === expectedTitle) return true
        }
      }
      if (title && title !== expectedTitle) {
        await closeAnyCoverDialog(page)
        await sleep(600)
      }
    }
    await sleep(500)
  }
  return false
}

/** 页面上是否有"使用此素材作为封面?"推荐浮层。 */
async function hasCoverSuggestPopover(page) {
  await injectCollector(page)
  return page.evaluate(() => {
    const els = window.__collectAll()
    return els.some((el) => {
      const t = (el.textContent || '').trim()
      return (t === '使用此素材作为封面？' || t === '使用此素材作为封面?') && el.getBoundingClientRect().width > 0
    })
  })
}

/**
 * 点击"使用此素材作为封面?"浮层里的「使用素材」按钮，进入封面编辑弹窗。
 * 关键：必须点「使用素材」而不是「直接编辑」——「直接编辑」进的是编辑视频帧素材的模式，
 * 后续上传的图不会真正替换视频帧（4:3 之前一直存成视频截图的根因）。
 * 「使用素材」进的编辑弹窗才有「上传封面」入口，能真正换成我们的图。
 */
async function clickPopoverUseMaterial(page) {
  await injectCollector(page)
  return page.evaluate(() => {
    const els = window.__collectAll()
    const hasPopover = els.some((el) => {
      const t = (el.textContent || '').trim()
      return (t === '使用此素材作为封面？' || t === '使用此素材作为封面?') && el.getBoundingClientRect().width > 0
    })
    if (!hasPopover) return false
    const btn = els.find((el) => {
      const t = (el.textContent || '').trim()
      return el.tagName === 'BUTTON' && t === '使用素材' && el.getBoundingClientRect().width > 0
    })
    if (btn) { btn.click(); return true }
    return false
  })
}

/** 关掉任何打开的封面弹窗（点关闭 X）。 */
async function closeAnyCoverDialog(page) {
  await injectCollector(page)
  await page.evaluate(() => {
    const els = window.__collectAll()
    const closeBtn = els.find((el) => {
      const cls = String(el.className || '')
      return /weui-desktop-dialog__close|icon-close/.test(cls) && el.getBoundingClientRect().width > 0
    })
    if (closeBtn) closeBtn.click()
  })
}

/** 读弹窗内主预览图的 src（用于判断上传的图是否真的替换了视频帧）。 */
async function getDialogMainImageSrc(page) {
  await injectCollector(page)
  return page.evaluate(() => {
    const els = window.__collectAll()
    // 弹窗内最大的那张 img 就是主预览
    let best = null
    let bestArea = 0
    for (const el of els) {
      if (el.tagName !== 'IMG') continue
      const r = el.getBoundingClientRect()
      const area = r.width * r.height
      // 主预览通常宽>150、在弹窗上半部
      if (r.width > 150 && area > bestArea) { best = el; bestArea = area }
    }
    return best ? (best.src || best.currentSrc || '') : null
  })
}

/**
 * 在已打开的封面弹窗里上传图片并确认。
 * 关键修复：
 *  1) 「上传封面」按钮是宽约 48px 的小方块，绝不能用 width>60 过滤（之前漏点它，
 *     导致保留视频帧、封面时对时错的根因）。
 *  2) 传图后校验主预览图 src 真的变了，才认为图已应用；否则重试点上传。
 */
async function uploadCoverInDialog(page, coverPath, timeoutMs = 120_000) {
  const beforeSrc = await getDialogMainImageSrc(page)

  // 点「上传封面」小方块（不限宽度；取叶子或近叶子、文字恰为"上传封面"的元素）
  await injectCollector(page)
  const uploadClicked = await page.evaluate(() => {
    const els = window.__collectAll()
    const box = els.find((el) => {
      const t = (el.textContent || '').trim()
      return t === '上传封面' && el.getBoundingClientRect().width > 0
    })
    if (box) { box.scrollIntoView({ block: 'center' }); box.click(); return true }
    return false
  })
  if (!uploadClicked) return false
  await sleep(1000)

  const input = await findFileInput(page, { imageOnly: true }, 10_000)
  if (!input) return false
  await input.uploadFile(coverPath)

  // 等主预览图刷新（图被应用）。仅作参考日志：blob/CDN URL 上传前后可能不变，
  // 实测两张封面都正确却报未变化，故不能用它否决成功，只记录以便排查。
  let imgChanged = false
  const applyDeadline = Date.now() + 8_000
  while (Date.now() < applyDeadline) {
    await sleep(1000)
    const now = await getDialogMainImageSrc(page)
    if (now && now !== beforeSrc) { imgChanged = true; break }
  }
  if (!imgChanged) {
    console.warn('[wechat] 主预览图 src 未变化（仅提示，不影响判定；URL 可能被复用）')
  }
  // 给裁剪/渲染一点时间再点确认
  await sleep(1500)

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await injectCollector(page)
    // 确认按钮：真正的 <button> primary，用真实鼠标点中心坐标
    const coord = await page.evaluate((texts) => {
      const els = window.__collectAll()
      const candidates = els.filter((el) => {
        const t = (el.textContent || '').trim()
        const r = el.getBoundingClientRect()
        return texts.includes(t) && el.tagName === 'BUTTON' && r.width > 0 && r.height > 0
      })
      if (!candidates.length) return null
      candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
      const r = candidates[0].getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, ['确定', '完成', '确认', '使用'])
    if (coord) {
      await page.mouse.click(coord.x, coord.y)
      await sleep(1000)
      // 等弹窗关闭
      const waitStart = Date.now()
      while (Date.now() - waitStart < 10_000) {
        const title = await getOpenCoverDialogTitle(page)
        if (!title) return true // 确认后弹窗关闭 = 该卡片封面已应用
        await sleep(500)
      }
      return true
    }
    await sleep(1000)
  }
  return false
}

/** 上传两张封面。返回 { cover3x4, cover4x3 } 布尔结果。 */
export async function uploadCovers(page, cover3x4Path, cover4x3Path) {
  const result = { cover3x4: false, cover4x3: false }
  if (await openCoverDialog(page, 'vertical')) {
    await screenshot(page, 'dialog_3x4_opened')
    result.cover3x4 = await uploadCoverInDialog(page, cover3x4Path)
    await sleep(1500)
  }
  if (await openCoverDialog(page, 'horizon')) {
    await screenshot(page, 'dialog_4x3_opened')
    result.cover4x3 = await uploadCoverInDialog(page, cover4x3Path)
    await sleep(1500)
  }
  return result
}

// --- 保存草稿 / 验证 ------------------------------------------------------

export async function saveDraft(page, timeoutMs = 120_000) {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(1000)
  }
  await injectCollector(page)
  const found = await page.evaluate((texts) => {
    const els = window.__collectAll()
    const candidates = els.filter((el) => {
      const t = (el.textContent || '').trim()
      const r = el.getBoundingClientRect()
      return texts.some((x) => t === x) && r.width > 60 && r.height > 30
    })
    candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
    if (!candidates.length) return { clicked: false }
    const el = candidates[0]
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { clicked: true, x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, ['保存草稿'])
  if (!found.clicked) return false
  await page.mouse.click(found.x, found.y)
  await sleep(1500)

  // 点保存后视频号常弹「将此次编辑保留？」离开确认弹窗——必须点「保存」才真正落地草稿。
  // 不处理它，草稿不会进草稿箱（这是之前草稿丢失的根因）。
  await keepEditIfPrompted(page)

  const successTexts = ['保存成功', '已保存', '保存草稿成功']
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (page.url().includes('/draftListManager') || page.url().includes('/draft')) return true
    // 弹窗可能延迟出现，循环里持续兜底处理
    await keepEditIfPrompted(page)
    await injectCollector(page)
    const success = await page.evaluate((ts) => {
      const els = window.__collectAll()
      const texts = els.map((el) => (el.textContent || '').trim())
      return texts.some((t) => ts.some((s) => t.includes(s)))
    }, successTexts)
    if (success) return true
    await sleep(2000)
  }
  // 点了但没看到 toast —— 交给 verify 阶段用草稿箱计数做权威判断
  return true
}

/** 读取草稿箱 tab 上的计数徽标文字，例如 "草稿箱 (2)"。需等 hydration。 */
export async function readDraftTabText(page, hydrateTimeoutMs = 20_000) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < hydrateTimeoutMs) {
    await injectCollector(page)
    const text = await page.evaluate(() => {
      const els = window.__collectAll()
      const tab = els.find((el) => {
        const t = (el.textContent || '').trim()
        return /^草稿箱\s*(\(|（)?\d*/.test(t) && el.getBoundingClientRect().width > 0
      })
      return tab ? tab.textContent.trim() : null
    })
    // 有括号数字才算 hydration 完成
    if (text && /\d/.test(text)) return text
    last = text
    await sleep(1000)
  }
  return last
}

export function parseDraftCount(tabText) {
  if (!tabText) return null
  const m = tabText.match(/(\d+)/)
  return m ? Number(m[1]) : null
}
