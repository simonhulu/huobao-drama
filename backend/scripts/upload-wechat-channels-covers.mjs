#!/usr/bin/env node
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const CDP_URL = process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222'
const WINDOW_WIDTH = Number(process.env.WECHAT_CHANNELS_WINDOW_WIDTH || 1400)
const WINDOW_HEIGHT = Number(process.env.WECHAT_CHANNELS_WINDOW_HEIGHT || 860)

const COVER_3x4_PATH = process.argv[2] || path.join(PROJECT_ROOT, 'data/temp/wechat-covers/cover-3x4.png')
const COVER_4x3_PATH = process.argv[3] || path.join(PROJECT_ROOT, 'data/temp/wechat-covers/cover-4x3.png')
const SHORT_TITLE = process.argv[4] || ''

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
  console.log(`[covers] screenshot: ${file}`)
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
    console.warn('[covers] failed to resize browser window:', err.message)
  }
}

async function waitForCoverDialogClosed(page, timeoutMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const open = await page.evaluate(() => {
      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)
      return allElements.some(el => /编辑个人主页卡片|编辑分享卡片/.test((el.textContent || '').trim()))
    })
    if (!open) return true
    await sleep(500)
  }
  return false
}

async function clickDirectEditIfPopover(page, timeoutMs = 8_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(() => {
      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)

      const hasPopover = allElements.some(el => /使用此素材作为封面/.test((el.textContent || '').trim()))
      if (!hasPopover) return 'no-popover'

      for (const el of allElements) {
        const text = (el.textContent || '').trim()
        if (text !== '直接编辑') continue
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }
      return 'popover-without-direct-edit'
    })

    if (result && typeof result === 'object' && 'x' in result) {
      await page.mouse.click(result.x, result.y)
      console.log('[covers] clicked 直接编辑 in share-card popover')
      await sleep(1200)
      return true
    }
    if (result === 'no-popover') return false
    await sleep(500)
  }
  return false
}

async function getCoverCardSrc(page, cardLabelText) {
  return page.evaluate((labelText) => {
    const allElements = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        allElements.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const label = allElements.find(el => visible(el) && (el.textContent || '').trim() === labelText)
    if (!label) return null
    const lr = label.getBoundingClientRect()
    const imgs = allElements
      .filter(el => visible(el) && el.tagName === 'IMG')
      .map(el => {
        const r = el.getBoundingClientRect()
        return { src: el.src, left: r.left, right: r.right, top: r.top, width: r.width, height: r.height }
      })
      .filter(img => img.width > 40 && img.height > 40 && img.left < lr.right && img.right > lr.left && img.top < lr.top)
      .sort((a, b) => b.width * b.height - a.width * a.height)
    return imgs[0]?.src || null
  }, cardLabelText)
}

async function waitForCoverCardSrcChange(page, cardLabelText, previousSrc, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const current = await getCoverCardSrc(page, cardLabelText)
    if (current && current !== previousSrc) return current
    await sleep(1000)
  }
  return null
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
    return all.map(el => ({
      tag: el.tagName,
      text: (el.textContent || '').trim(),
      className: el.className || '',
      rect: el.getBoundingClientRect(),
      role: el.getAttribute('role') || '',
    }))
  })
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
  // 点击「上传封面」
  const uploadClicked = await clickByText(page, '上传封面', true, 10_000)
  if (!uploadClicked) {
    console.warn('[covers] upload cover button not found in dialog')
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
    console.warn('[covers] cover file input not found')
    return false
  }
  await input.uploadFile(coverPath)
  console.log('[covers] uploaded cover file:', coverPath)

  // 等待并点击「确认」。视频号这里的按钮经常是多层 div，JS click 容易点到文字层；
  // 用 mouse click 点中心，并持续到弹窗真正关闭。
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const point = await page.evaluate((texts) => {
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
      if (candidates.length === 0) return null
      candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
      const el = candidates[0]
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: el.textContent.trim() }
      }
      return null
    }, ['确定', '完成', '确认', '使用'])
    if (point) {
      await page.mouse.click(point.x, point.y)
      console.log('[covers] clicked cover confirm:', point.text)
      const closed = await waitForCoverDialogClosed(page)
      if (closed) {
        console.log('[covers] cover dialog closed after confirm')
        return true
      }
      console.warn('[covers] cover dialog did not close after confirm, retrying')
    }
    await sleep(1000)
  }
  console.warn('[covers] confirm button not found')
  return false
}

async function updateShortTitle(page, title) {
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
  if (!ok) console.warn('[covers] short title input not found')
  else console.log('[covers] updated short title:', smartTruncateChinese(title, 16))
  await sleep(500)
}

async function openCoverDialog(page, cardLabelText, timeoutMs = 20_000) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await sleep(800)

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const clicked = await page.evaluate((labelText) => {
      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)

      const cardLabel = allElements.find(el => (el.textContent || '').includes(labelText))
      if (!cardLabel) return false
      cardLabel.scrollIntoView({ block: 'center' })
      const rect = cardLabel.getBoundingClientRect()
      const edit = allElements.find(el => {
        const text = (el.textContent || '').trim()
        const r = el.getBoundingClientRect()
        return text === '编辑' && r.y < rect.bottom && r.y > rect.top - 10 && r.x > rect.left - 20 && r.x < rect.right + 200
      })
      if (edit) {
        edit.scrollIntoView({ block: 'center' })
        edit.click()
        return true
      }
      return false
    }, cardLabelText)
    if (clicked) {
      await sleep(1500)
      return true
    }
    await sleep(500)
  }
  return false
}

async function dismissCoverDialog(page) {
  // 如果已经有弹窗打开，先点取消或关闭
  await page.evaluate(() => {
    const allElements = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        allElements.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    const close = allElements.find(el => {
      const text = (el.textContent || '').trim()
      return text === '取消' || text === '关闭' || el.getAttribute('aria-label') === '关闭'
    })
    if (close) close.click()
  })
  await sleep(1000)
}

async function saveDraft(page, timeoutMs = 120_000) {
  // 多次滚动到底部，确保保存按钮出现
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(1000)
  }

  // 调试：先打印底部元素
  await page.evaluate(() => {
    const allElements = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        allElements.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    const bottom = allElements
      .filter(el => {
        const rect = el.getBoundingClientRect()
        return rect.y > window.innerHeight * 0.7 && rect.width > 30 && rect.height > 30
      })
      .map(el => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 40),
        class: (el.className || '').slice(0, 60),
        y: el.getBoundingClientRect().y,
      }))
      .sort((a, b) => b.y - a.y)
    console.log('[covers] bottom elements:', JSON.stringify(bottom.slice(0, 20)))
  })

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
    // 优先找按钮/可点击元素
    const candidates = allElements.filter(el => {
      const text = (el.textContent || '').trim()
      if (!texts.includes(text)) return false
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      const visible = rect.width > 60 && rect.height > 30 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none'
      if (!visible) return false
      const tag = el.tagName.toLowerCase()
      const role = el.getAttribute('role')
      return tag === 'button' || role === 'button' || style.cursor === 'pointer'
    })
    // 按 y 坐标从下到上排序，优先点最下面的（通常是主按钮）
    candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
    if (candidates.length > 0) {
      const el = candidates[0]
      el.scrollIntoView({ block: 'center' })
      const rect = el.getBoundingClientRect()
      return { clicked: true, text: el.textContent.trim().slice(0, 30), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    return { clicked: false }
  }, ['保存草稿', '存草稿'])
  console.log('[covers] save button click result:', JSON.stringify(clicked))
  if (!clicked.clicked) return false
  await page.mouse.click(clicked.x, clicked.y)

  // 等待保存成功提示，或页面跳转，或草稿箱数量变化
  const successTexts = ['保存成功', '已保存', '保存草稿成功', '保存成功']
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
      const visibleTexts = allElements.filter(el => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }).map(el => (el.textContent || '').trim())
      const success = visibleTexts.some(t => ts.some(s => t.includes(s)))
      const error = visibleTexts.some(t => es.some(e => t.includes(e)))
      const url = window.location.href
      return { success, error, url, sample: visibleTexts.filter(t => t.length > 0).slice(0, 5) }
    }, successTexts, errorTexts)
    console.log('[covers] save state check:', JSON.stringify(state))
    if (state.success) {
      console.log('[covers] draft saved successfully')
      return true
    }
    if (state.error) {
      console.warn('[covers] save draft error detected')
      return false
    }
    await sleep(2000)
  }
  console.warn('[covers] save draft success toast not found, but button was clicked')
  return true
}

async function main() {
  if (!fs.existsSync(COVER_3x4_PATH)) throw new Error(`Cover 3:4 not found: ${COVER_3x4_PATH}`)
  if (!fs.existsSync(COVER_4x3_PATH)) throw new Error(`Cover 4:3 not found: ${COVER_4x3_PATH}`)

  console.log('[covers] connecting to', CDP_URL)
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  let pages = await browser.pages()
  let page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
  if (!page) {
    page = await browser.newPage()
    await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'networkidle2', timeout: 60_000 })
  }
  console.log('[covers] using page:', page.url())

  await setStableWindow(page)
  await page.setJavaScriptEnabled(true)

  await screenshot(page, 'covers_start')

  // 如果已经有封面弹窗打开，判断是个人主页还是分享卡片
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
    const titleEl = allElements.find(el => (el.textContent || '').includes('编辑个人主页卡片') || (el.textContent || '').includes('编辑分享卡片'))
    return titleEl ? titleEl.textContent.trim() : null
  })

  if (dialogTitle?.includes('个人主页卡片')) {
    console.log('[covers] personal card dialog already open, uploading 3:4 cover')
    await uploadCoverInDialog(page, COVER_3x4_PATH)
    await sleep(1500)
  } else if (dialogTitle?.includes('分享卡片')) {
    console.log('[covers] share card dialog already open, uploading 4:3 cover')
    await clickDirectEditIfPopover(page)
    await uploadCoverInDialog(page, COVER_4x3_PATH)
    await sleep(1500)
  }

  // 上传个人主页卡片 3:4
  console.log('[covers] opening personal card dialog for 3:4 cover')
  if (await openCoverDialog(page, '个人主页卡片')) {
    const beforeSrc = await getCoverCardSrc(page, '个人主页卡片')
    await screenshot(page, 'personal_dialog_opened')
    await uploadCoverInDialog(page, COVER_3x4_PATH)
    const afterSrc = await waitForCoverCardSrcChange(page, '个人主页卡片', beforeSrc)
    if (!afterSrc) console.warn('[covers] personal card image src did not change after upload')
    else console.log('[covers] personal card image changed after upload')
    await sleep(1500)
  } else {
    console.warn('[covers] could not open personal card dialog')
  }

  // 上传分享卡片 4:3
  console.log('[covers] opening share card dialog for 4:3 cover')
  if (await openCoverDialog(page, '分享卡片')) {
    const beforeSrc = await getCoverCardSrc(page, '分享卡片')
    await clickDirectEditIfPopover(page)
    await screenshot(page, 'share_dialog_opened')
    await uploadCoverInDialog(page, COVER_4x3_PATH)
    const afterSrc = await waitForCoverCardSrcChange(page, '分享卡片', beforeSrc)
    if (!afterSrc) console.warn('[covers] share card image src did not change after upload')
    else console.log('[covers] share card image changed after upload')
    await sleep(1500)
  } else {
    console.warn('[covers] could not open share card dialog')
  }

  await screenshot(page, 'after_covers')

  // 更新短标题为 16 字
  const title = SHORT_TITLE || '李自成的道路：从驿卒到起义领袖的制度悲剧'
  await updateShortTitle(page, title)

  // 保存草稿
  console.log('[covers] saving draft...')
  await saveDraft(page)
  await screenshot(page, 'draft_saved')

  console.log('[covers] done.')
  await browser.disconnect()
}

main().catch(err => {
  console.error('[covers] failed:', err.message)
  process.exit(1)
})
