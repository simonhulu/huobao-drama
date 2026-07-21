#!/usr/bin/env node
/**
 * 完整版本：在一个会话里上传视频、填写标题/描述、上传 3:4 和 4:3 封面，然后保存草稿。
 * 避免分步脚本之间因页面跳转导致状态丢失。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const CDP_URL = process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222'

const EPISODE_ID = Number(process.argv[2] || '436')
const VIDEO_PATH = process.argv[3] || path.join(PROJECT_ROOT, 'data/static/merged/c03a6677-5dee-4093-bbf1-b495c42efefd.mp4')
const COVER_3x4_PATH = process.argv[4] || path.join(PROJECT_ROOT, 'data/temp/wechat-covers/cover-3x4.png')
const COVER_4x3_PATH = process.argv[5] || path.join(PROJECT_ROOT, 'data/temp/wechat-covers/cover-4x3.png')
const SHORT_TITLE = process.argv[6] || ''

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
  console.log(`[complete] screenshot: ${file}`)
  return file
}

async function collectAllElements(page) {
  return page.evaluate(() => {
    const all = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        all.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    return all
  })
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
    console.log('[complete] video already uploaded, skipping')
    return
  }

  console.log('[complete] looking for video file input...')
  const input = await findFileInput(page, 10_000)
  if (!input) throw new Error('未找到视频文件 input')

  console.log('[complete] uploading file:', videoPath)
  await input.uploadFile(videoPath)

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isVideoUploaded(page)) {
      await sleep(1500)
      console.log('[complete] video upload done')
      return
    }
    console.log('[complete] waiting for upload...')
    await sleep(5000)
  }
  throw new Error('视频上传超时')
}

async function fillShortTitle(page, title) {
  const text = smartTruncateChinese(title, 16)
  const ok = await page.evaluate((t) => {
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
    input.value = t
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.blur()
    return true
  }, text)
  if (!ok) console.warn('[complete] short title input not found')
  else console.log('[complete] filled short title:', text)
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
  if (!ok) console.warn('[complete] description editor not found')
  else console.log('[complete] filled description')
  await sleep(500)
}

async function clickByText(page, text, exact = false, timeoutMs = 10_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const clicked = await page.evaluate((t, exactMatch) => {
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
        const elText = (el.textContent || '').trim()
        const match = exactMatch ? elText === t : elText.includes(t)
        if (match) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            el.scrollIntoView({ block: 'center' })
            el.click()
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

async function uploadCoverInDialog(page, coverPath, timeoutMs = 120_000) {
  // 点击「上传封面」区域（+ 图标容器，比纯文字更稳）
  const uploadClicked = await page.evaluate(() => {
    const allElements = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        allElements.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    // 优先找带 + 号的可点击上传区
    const uploadBox = allElements.find(el => {
      const text = (el.textContent || '').trim()
      return text.includes('上传封面') && el.getBoundingClientRect().width > 60
    })
    if (uploadBox) {
      uploadBox.scrollIntoView({ block: 'center' })
      uploadBox.click()
      return true
    }
    return false
  })
  if (!uploadClicked) {
    console.warn('[complete] upload cover button not found in dialog')
    return false
  }
  await sleep(1000)

  // 找封面 file input
  const inputHandle = await page.evaluateHandle(() => {
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
      if (el.tagName === 'INPUT' && el.type === 'file' && (el.accept || '').includes('image')) {
        return el
      }
    }
    return null
  })
  const input = inputHandle.asElement()
  if (!input) {
    console.warn('[complete] cover file input not found')
    return false
  }
  await input.uploadFile(coverPath)
  console.log('[complete] uploaded cover file:', coverPath)

  // 等待并点击「确认」
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
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
        const style = window.getComputedStyle(el)
        return texts.includes(text) && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || style.backgroundColor.includes('250'))
      })
      if (candidates.length === 0) return false
      candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
      const el = candidates[0]
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        el.click()
        return true
      }
      return false
    }, ['确定', '完成', '确认', '使用'])
    if (clicked) {
      console.log('[complete] confirmed cover upload')
      await sleep(1000)
      // 等待弹窗关闭
      let waitStart = Date.now()
      while (Date.now() - waitStart < 10_000) {
        const stillOpen = await page.evaluate(() => {
          const allElements = []
          const collect = (root) => {
            const nodes = root.querySelectorAll('*')
            for (const el of nodes) {
              allElements.push(el)
              if (el.shadowRoot) collect(el.shadowRoot)
            }
          }
          collect(document)
          return allElements.some(el => (el.textContent || '').includes('编辑个人主页卡片') || (el.textContent || '').includes('编辑分享卡片'))
        })
        if (!stillOpen) return true
        await sleep(500)
      }
      console.warn('[complete] dialog did not close after confirm')
      return true
    }
    await sleep(1000)
  }
  console.warn('[complete] confirm button not found')
  return false
}

async function openCoverDialog(page, selector, timeoutMs = 20_000) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await sleep(800)

  const expectedTitle = selector.includes('vertical') ? '编辑个人主页卡片' : '编辑分享卡片'
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    // 如果已经是对应弹窗，直接返回
    const currentDialog = await page.evaluate(() => {
      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)
      const titleEl = allElements.find(el => {
        const text = (el.textContent || '').trim()
        return text.includes('编辑个人主页卡片') || text.includes('编辑分享卡片')
      })
      return titleEl ? titleEl.textContent.trim() : null
    })
    if (currentDialog && currentDialog.includes(expectedTitle)) {
      console.log(`[complete] ${selector} dialog already open`)
      return true
    }

    const clicked = await page.evaluate((sel) => {
      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)

      // 优先按「编辑」按钮的 x 坐标位置点击：左边是 3:4，右边是 4:3
      const editBtns = allElements.filter(el => {
        const text = (el.textContent || '').trim()
        const rect = el.getBoundingClientRect()
        return text === '编辑' && rect.width > 0 && rect.height > 0
      })
      if (editBtns.length >= 2) {
        editBtns.sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
        const target = sel.includes('vertical') ? editBtns[0] : editBtns[editBtns.length - 1]
        target.scrollIntoView({ block: 'center' })
        target.click()
        return { clicked: true, via: 'text' }
      }

      // 兜底：通过外层容器找编辑按钮
      const container = allElements.find(el => el.matches && el.matches(sel))
      if (container) {
        const edit = container.querySelector('.edit-btn') || allElements.find(el => {
          const text = (el.textContent || '').trim()
          return text === '编辑' && container.contains(el)
        })
        if (edit) {
          edit.scrollIntoView({ block: 'center' })
          edit.click()
          return { clicked: true, via: 'container' }
        }
      }

      return { clicked: false }
    }, selector)

    if (clicked.clicked) {
      console.log(`[complete] opened ${selector} dialog via ${clicked.via}`)
      await sleep(1500)
      // 验证弹窗标题正确
      const dialogTitle = await page.evaluate(() => {
        const allElements = []
        const collect = (root) => {
          const nodes = root.querySelectorAll('*')
          for (const el of nodes) {
            allElements.push(el)
            if (el.shadowRoot) collect(el.shadowRoot)
          }
        }
        collect(document)
        const titleEl = allElements.find(el => {
          const text = (el.textContent || '').trim()
          return text.includes('编辑个人主页卡片') || text.includes('编辑分享卡片')
        })
        return titleEl ? titleEl.textContent.trim() : null
      })
      if (dialogTitle && dialogTitle.includes(expectedTitle)) {
        return true
      }
      console.warn(`[complete] expected ${expectedTitle} but got ${dialogTitle}, retrying`)
      // 关闭当前弹窗再重试
      await page.evaluate(() => {
        const close = document.querySelector('.common-dialog .close, [aria-label="关闭"]')
        if (close) close.click()
      })
      await sleep(800)
    }
    await sleep(500)
  }
  return false
}

async function uploadCovers(page, cover3x4, cover4x3) {
  // 上传 3:4 个人主页卡片
  console.log('[complete] uploading 3:4 cover...')
  if (await openCoverDialog(page, '.vertical-cover-wrap')) {
    await screenshot(page, 'dialog_3x4_opened')
    await uploadCoverInDialog(page, cover3x4)
    await sleep(1500)
  } else {
    console.warn('[complete] could not open 3:4 cover dialog')
  }

  // 上传 4:3 分享卡片
  console.log('[complete] uploading 4:3 cover...')
  if (await openCoverDialog(page, '.horizon-cover-wrap')) {
    await screenshot(page, 'dialog_4x3_opened')
    await uploadCoverInDialog(page, cover4x3)
    await sleep(1500)
  } else {
    console.warn('[complete] could not open 4:3 cover dialog')
  }
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
  console.log('[complete] save button found:', JSON.stringify(clicked))
  if (!clicked.clicked) return false

  await page.mouse.click(clicked.x, clicked.y)
  console.log('[complete] save button clicked at', clicked.x, clicked.y)

  // 等待成功提示或页面变化；不再把「定时发表将无法保存草稿」提示当错误
  const successTexts = ['保存成功', '已保存', '保存草稿成功']
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const url = page.url()
    if (url.includes('/draftListManager')) {
      console.log('[complete] draft saved successfully (redirected to draft list)')
      return true
    }
    const state = await page.evaluate((ts) => {
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
      const success = texts.some(t => ts.some(s => t.includes(s)))
      return { success }
    }, successTexts)
    console.log('[complete] save state check:', JSON.stringify({ ...state, url }))
    if (state.success) {
      console.log('[complete] draft saved successfully')
      return true
    }
    await sleep(2000)
  }
  console.warn('[complete] save draft success toast not found, but button was clicked')
  return true
}

async function main() {
  if (!fs.existsSync(VIDEO_PATH)) throw new Error(`Video not found: ${VIDEO_PATH}`)
  if (!fs.existsSync(COVER_3x4_PATH)) throw new Error(`Cover 3:4 not found: ${COVER_3x4_PATH}`)
  if (!fs.existsSync(COVER_4x3_PATH)) throw new Error(`Cover 4:3 not found: ${COVER_4x3_PATH}`)

  console.log('[complete] connecting to', CDP_URL)
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  let pages = await browser.pages()
  let page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
  if (!page) {
    page = await browser.newPage()
  }
  await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'networkidle2', timeout: 60_000 })
  console.log('[complete] using page:', page.url())

  await page.setViewport({ width: 1400, height: 860 })
  await page.setJavaScriptEnabled(true)

  await screenshot(page, 'before_upload')
  await uploadVideo(page, VIDEO_PATH)
  await screenshot(page, 'after_video_upload')

  const title = SHORT_TITLE || '李自成的道路：从驿卒到起义领袖的制度悲剧'
  const description = '本集以一条鞭法与明朝覆灭为核心主题，深入分析张居正改革从救国良方演变为结构性灾难的完整逻辑链。'
  await fillShortTitle(page, title)
  await fillDescription(page, description)
  await screenshot(page, 'after_meta')

  await uploadCovers(page, COVER_3x4_PATH, COVER_4x3_PATH)
  await screenshot(page, 'after_covers')

  // 再次确认短标题（封面弹窗可能会重置它）
  await fillShortTitle(page, title)

  console.log('[complete] saving draft...')
  const saved = await saveDraft(page)
  if (!saved) {
    console.log('[complete] save draft button not found')
  }
  await screenshot(page, 'draft_saved')

  console.log('[complete] done.')
  await browser.disconnect()
}

main().catch(err => {
  console.error('[complete] failed:', err.message)
  process.exit(1)
})
