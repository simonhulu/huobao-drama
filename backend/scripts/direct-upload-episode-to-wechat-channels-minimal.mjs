#!/usr/bin/env node
/**
 * 最小化版本：只上传视频、填写标题/描述、保存草稿（不上传自定义封面）。
 * 用于内存紧张时先保住主内容。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const CDP_URL = process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222'
const WINDOW_WIDTH = Number(process.env.WECHAT_CHANNELS_WINDOW_WIDTH || 1400)
const WINDOW_HEIGHT = Number(process.env.WECHAT_CHANNELS_WINDOW_HEIGHT || 860)

const EPISODE_ID = Number(process.argv[2] || '436')
const VIDEO_PATH = process.argv[3] || path.join(PROJECT_ROOT, 'data/static/merged/c03a6677-5dee-4093-bbf1-b495c42efefd.mp4')
const SHORT_TITLE = process.argv[4] || ''
const SKIP_SAVE = process.env.WECHAT_CHANNELS_SKIP_SAVE === '1'

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function smartTruncateChinese(text, maxLen) {
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

async function screenshot(page, name) {
  const dir = path.join(PROJECT_ROOT, 'data/wechat-channels-profile/debug')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}_${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`[direct-upload-minimal] screenshot: ${file}`)
  return file
}

async function setStableWindow(page) {
  try {
    await page.setViewport({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
    const client = await page.createCDPSession()
    const { windowId } = await client.send('Browser.getWindowForTarget')
    await client.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 20, top: 40, width: WINDOW_WIDTH, height: WINDOW_HEIGHT, windowState: 'normal' },
    })
  } catch (err) {
    console.warn('[direct-upload-minimal] failed to resize browser window:', err.message)
  }
}

async function isVideoUploaded(page) {
  return page.evaluate(() => {
    const allElements = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        allElements.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    const hasCoverPreview = allElements.some(el => (el.textContent || '').includes('封面预览'))
    const hasVisibleVideo = allElements.some(el => {
      if (el.tagName !== 'VIDEO') return false
      const rect = el.getBoundingClientRect()
      return rect.width > 100 && rect.height > 100
    })
    return hasCoverPreview || hasVisibleVideo
  })
}

async function findFileInput(page, timeoutMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const handle = await page.evaluateHandle(() => {
      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)
      for (const el of allElements) {
        if (el.tagName === 'INPUT' && el.type === 'file') {
          return el
        }
      }
      return null
    })
    const input = handle.asElement()
    if (input) return input
    await sleep(500)
  }
  return null
}

async function uploadVideo(page, videoPath, timeoutMs = 600_000) {
  if (await isVideoUploaded(page)) {
    console.log('[direct-upload-minimal] video already uploaded, skipping')
    return
  }

  console.log('[direct-upload-minimal] looking for video file input...')
  const input = await findFileInput(page, 10_000)
  if (!input) throw new Error('未找到视频文件 input')

  console.log('[direct-upload-minimal] uploading file:', videoPath)
  await input.uploadFile(videoPath)

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isVideoUploaded(page)) {
      await sleep(1500)
      console.log('[direct-upload-minimal] video upload done')
      return
    }
    console.log('[direct-upload-minimal] waiting for upload...')
    await sleep(5000)
  }
  throw new Error('视频上传超时')
}

async function fillShortTitle(page, title) {
  const ok = await page.evaluate((text) => {
    const allElements = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        allElements.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    const input = allElements.find(el => el.tagName === 'INPUT' && (el.placeholder || '').includes('短标题'))
    if (!input) return false
    input.focus()
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.blur()
    return true
  }, smartTruncateChinese(title, 16))
  if (!ok) console.warn('[direct-upload-minimal] short title input not found')
  else console.log('[direct-upload-minimal] filled short title:', smartTruncateChinese(title, 16))
  await sleep(500)
}

async function fillDescription(page, description) {
  const ok = await page.evaluate((text) => {
    const allElements = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        allElements.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    const editor = allElements.find(el => el.tagName === 'DIV' && el.className && el.className.includes('input-editor') && el.getAttribute('contenteditable') !== null)
    if (!editor) return false
    editor.focus()
    editor.innerText = text
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    editor.blur()
    return true
  }, description.slice(0, 200))
  if (!ok) console.warn('[direct-upload-minimal] description editor not found')
  else console.log('[direct-upload-minimal] filled description')
  await sleep(500)
}

async function saveDraft(page, timeoutMs = 120_000) {
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(1000)
  }

  const clicked = await page.evaluate((texts) => {
    const allElements = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        allElements.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    const candidates = allElements.filter(el => {
      const text = (el.textContent || '').trim()
      return texts.some(t => text === t) && el.getBoundingClientRect().width > 60 && el.getBoundingClientRect().height > 30
    })
    candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
    if (candidates.length > 0) {
      const el = candidates[0]
      el.scrollIntoView({ block: 'center' })
      const rect = el.getBoundingClientRect()
      return { clicked: true, text: el.textContent.trim().slice(0, 30), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    return { clicked: false }
  }, ['保存草稿'])
  console.log('[direct-upload-minimal] save button found:', JSON.stringify(clicked))
  if (!clicked.clicked) return false

  // 用 mouse.click 点按钮中心，更可靠
  await page.mouse.click(clicked.x, clicked.y)
  console.log('[direct-upload-minimal] save button clicked at', clicked.x, clicked.y)

  const successTexts = ['保存成功', '已保存', '保存草稿成功']
  const errorTexts = ['请填写', '不能为空', '超过', '失败', '网络异常']
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate((ts, es) => {
      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)
      const texts = allElements.map(el => (el.textContent || '').trim())
      return {
        success: texts.some(t => ts.some(s => t.includes(s))),
        error: texts.some(t => es.some(e => t.includes(e))),
        url: window.location.href,
      }
    }, successTexts, errorTexts)
    console.log('[direct-upload-minimal] save state check:', JSON.stringify(state))
    if (state.success) {
      console.log('[direct-upload-minimal] draft saved successfully')
      return true
    }
    if (state.error) {
      console.warn('[direct-upload-minimal] save draft error detected')
      return false
    }
    await sleep(2000)
  }
  console.warn('[direct-upload-minimal] save draft success toast not found, but button was clicked')
  return true
}

async function main() {
  if (!fs.existsSync(VIDEO_PATH)) throw new Error(`Video not found: ${VIDEO_PATH}`)

  console.log('[direct-upload-minimal] connecting to', CDP_URL)
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  let pages = await browser.pages()
  let page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
  if (!page) {
    page = await browser.newPage()
    await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'networkidle2', timeout: 60_000 })
  }
  console.log('[direct-upload-minimal] using page:', page.url())

  if (!page.url().includes('/platform/post/create')) {
    await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'networkidle2', timeout: 60_000 })
  }

  await setStableWindow(page)
  await page.setJavaScriptEnabled(true)

  await screenshot(page, 'before_upload')
  await uploadVideo(page, VIDEO_PATH)
  await screenshot(page, 'after_video_upload')

  const title = SHORT_TITLE || '李自成的道路：从驿卒到起义领袖的制度悲剧'
  const description = '本集以一条鞭法与明朝覆灭为核心主题，深入分析张居正改革从救国良方演变为结构性灾难的完整逻辑链。'
  await fillShortTitle(page, title)
  await fillDescription(page, description)
  await screenshot(page, 'after_meta')

  if (SKIP_SAVE) {
    console.log('[direct-upload-minimal] WECHAT_CHANNELS_SKIP_SAVE=1, leaving publish page open after video/meta upload')
    await browser.disconnect()
    return
  }

  console.log('[direct-upload-minimal] saving draft...')
  const saved = await saveDraft(page)
  if (!saved) {
    console.log('[direct-upload-minimal] save draft button not found')
  }
  await screenshot(page, 'draft_saved')

  console.log('[direct-upload-minimal] done.')
  await browser.disconnect()
}

main().catch(err => {
  console.error('[direct-upload-minimal] failed:', err.message)
  process.exit(1)
})
