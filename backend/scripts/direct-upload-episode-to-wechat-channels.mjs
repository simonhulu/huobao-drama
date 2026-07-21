import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const CDP_URL = process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222'

const EPISODE_ID = Number(process.argv[2] || '436')

const VIDEO_PATH = process.argv[3] || path.join(PROJECT_ROOT, 'data/static/merged/c03a6677-5dee-4093-bbf1-b495c42efefd.mp4')
const COVER_3x4_PATH = process.argv[4] || path.join(PROJECT_ROOT, 'data/static/covers/9c1546df-ab04-482b-b7cf-7bedfef5eeb8.png')
const COVER_4x3_PATH = process.argv[5] || path.join(PROJECT_ROOT, 'data/static/covers/67b738ce-bfad-436a-b806-da50e3bc7f2f.png')

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function smartTruncateChinese(text, maxLen) {
  if (text.length <= maxLen) return text
  const badEndChars = new Set(['的', '了', '与', '和', '或', '在', '从', '到', '为', '被', '把', '将', '向', '对', '于', '以', '及', '而', '但', '因', '所', '之', '着', '过', '吗', '呢', '吧', '啊'])
  const punctuation = new Set(['，', '。', '；', '：', '！', '？', '、', '”', '"', '」', '』', ')', '）', ']', '】'])

  // 优先在 maxLen 以内找最后一个标点断句
  let cut = maxLen
  for (let i = maxLen; i >= Math.max(0, maxLen - 8); i--) {
    if (punctuation.has(text[i - 1])) {
      cut = i
      break
    }
  }

  // 如果结尾是“的/了/与/和”等助词，往回缩到前一个合理位置
  while (cut > 1 && badEndChars.has(text[cut - 1])) {
    cut--
  }

  // 不要截到只剩半个短语，至少保留 8 个字
  if (cut < 8) cut = maxLen

  return text.slice(0, cut)
}

async function screenshot(page, name) {
  const dir = path.join(PROJECT_ROOT, 'data/wechat-channels-profile/debug')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}_${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`[direct-upload] screenshot: ${file}`)
  return file
}

async function waitForAnySelector(page, selectors, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      const el = await page.$(sel)
      if (el) {
        const visible = await el.evaluate(n => {
          const rect = n.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).catch(() => false)
        if (visible) return el
      }
    }
    await sleep(500)
  }
  return null
}

async function clickUploadArea(page, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(() => {
      const keywords = ['上传时长', '大小不超过', '分辨率720p', '码率10Mbps', 'MP4/H.264', '上传视频']

      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)

      // 策略1：找含上传提示文字、虚线框、面积适中的祖先元素
      const textEls = allElements.filter(el => keywords.some(k => (el.textContent || '').includes(k)))
      for (const textEl of textEls) {
        let el = textEl
        while (el && el !== document.body) {
          const style = window.getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          const isDashed = style.borderStyle === 'dashed' || style.borderStyle === 'dotted'
          if (isDashed && rect.width > 100 && rect.height > 100) {
            el.click()
            return { clicked: true, reason: 'dashed ancestor of upload text', width: rect.width, height: rect.height, x: rect.x, y: rect.y }
          }
          el = el.parentElement
        }
      }

      // 策略2：找整个页面中最大的虚线/点线框（上传区）
      const dashedBoxes = allElements
        .filter(el => {
          const style = window.getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          const isDashed = style.borderStyle === 'dashed' || style.borderStyle === 'dotted'
          return isDashed && rect.width > 150 && rect.height > 150 && rect.width < 600 && rect.height < 800
        })
        .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height))

      if (dashedBoxes.length > 0) {
        const el = dashedBoxes[0]
        const rect = el.getBoundingClientRect()
        el.click()
        return { clicked: true, reason: 'largest dashed box', width: rect.width, height: rect.height, x: rect.x, y: rect.y }
      }

      // 策略3：文字匹配且面积适中
      for (const el of textEls) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 80 && rect.height > 80 && rect.width < 400) {
          el.click()
          return { clicked: true, reason: 'text match', width: rect.width, height: rect.height, x: rect.x, y: rect.y }
        }
      }

      // 兜底1：找页面中央附近最大的可点击 div
      const central = allElements.filter(el => {
        const rect = el.getBoundingClientRect()
        return rect.width > 150 && rect.height > 150 && rect.left > window.innerWidth * 0.2 && rect.right < window.innerWidth * 0.6
      })
      if (central.length > 0) {
        central.sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height))
        const rect = central[0].getBoundingClientRect()
        central[0].click()
        return { clicked: true, reason: 'central largest', width: rect.width, height: rect.height, x: rect.x, y: rect.y }
      }

      // 兜底2：点击页面左侧中间区域（视频号上传区常见位置）
      const fallbackX = window.innerWidth * 0.34
      const fallbackY = window.innerHeight * 0.55
      const event = new MouseEvent('click', { bubbles: true, clientX: fallbackX, clientY: fallbackY })
      document.elementFromPoint(fallbackX, fallbackY)?.dispatchEvent(event)
      return { clicked: true, reason: 'coordinate fallback', x: fallbackX, y: fallbackY }
    })
    console.log('[direct-upload debug]', JSON.stringify(result))
    if (result.clicked) return true
    await sleep(500)
  }
  return false
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
    if (input) {
      const info = await page.evaluate(el => ({
        accept: el.accept,
        outerHTML: el.outerHTML.slice(0, 200),
      }), input)
      console.log('[direct-upload] file input found:', JSON.stringify(info))
      return input
    }
    await sleep(500)
  }
  return null
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

async function uploadVideo(page, videoPath, timeoutMs = 600_000) {
  if (await isVideoUploaded(page)) {
    console.log('[direct-upload] video already uploaded, skipping upload')
    return
  }

  // 先直接找视频 file input（可能已经存在但隐藏）
  console.log('[direct-upload] looking for video file input...')
  let input = await findFileInput(page, 5_000)
  if (!input) {
    console.log('[direct-upload] clicking upload area...')
    const clicked = await clickUploadArea(page, 30_000)
    if (!clicked) throw new Error('未找到视频上传区域')
    await sleep(1000)
    input = await findFileInput(page, 20_000)
  }
  if (!input) throw new Error('未找到视频文件 input')

  console.log('[direct-upload] uploading file:', videoPath)
  await input.uploadFile(videoPath)

  // 上传完成判断：出现封面预览、视频描述、短标题，或 video 元素
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isVideoUploaded(page)) {
      await sleep(1500)
      console.log('[direct-upload] video upload done')
      return
    }
    console.log('[direct-upload] waiting for upload...')
    await sleep(3000)
  }
  throw new Error('视频上传超时')
}

async function queryElementInShadow(page, predicateCode) {
  const handle = await page.evaluateHandle((fnText) => {
    const predicate = new Function('el', fnText)
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
      if (predicate(el)) return el
    }
    return null
  }, predicateCode)
  return handle.asElement()
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
  if (!ok) console.warn('[direct-upload] short title input not found')
  else console.log('[direct-upload] filled short title:', smartTruncateChinese(title, 16))
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
  if (!ok) console.warn('[direct-upload] description editor not found')
  else console.log('[direct-upload] filled description')
  await sleep(500)
}

async function clickByTextInShadow(page, text, exact = false, timeoutMs = 10_000) {
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
        const text = (el.textContent || '').trim()
        const match = exactMatch ? text === t : text.includes(t)
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

async function uploadCoverForCard(page, cardLabelText, coverPath, timeoutMs = 120_000) {
  // 封面卡片在页面下方，先滚动到底部
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await sleep(800)

  // 点击对应卡片封面的「编辑」
  const editClicked = await page.evaluate((labelText) => {
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

  if (!editClicked) {
    console.warn(`[direct-upload] cover edit button not found for ${cardLabelText}`)
    return
  }
  await sleep(1000)

  // 点击「上传封面」
  await clickByTextInShadow(page, '上传封面', true, 10_000)
  await sleep(800)

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
    console.warn('[direct-upload] cover file input not found')
    return
  }
  await input.uploadFile(coverPath)

  // 等待并点击橙色主按钮「确认」
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
    if (clicked) return
    await sleep(1000)
  }
}

async function uploadCover(page, cover3x4Path, cover4x3Path) {
  await uploadCoverForCard(page, '个人主页卡片', cover3x4Path)
  await uploadCoverForCard(page, '分享卡片', cover4x3Path)
}

async function openExistingDraft(page, title, timeoutMs = 60_000) {
  // 如果当前不在草稿相关页面，先导航到草稿列表
  if (!page.url().includes('draft')) {
    const draftUrls = [
      'https://channels.weixin.qq.com/platform/post/draftListManager',
      'https://channels.weixin.qq.com/platform/post/list?tab=draft',
      'https://channels.weixin.qq.com/platform/post/list?type=draft',
      'https://channels.weixin.qq.com/platform/post/draft',
    ]
    for (const url of draftUrls) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 })
        console.log('[direct-upload] navigated to drafts:', url)
        break
      } catch (err) {
        console.warn('[direct-upload] drafts navigation failed:', url, err.message)
      }
    }
  }

  // 等待草稿列表加载（出现目标标题或草稿列表字样）
  const titlePrefix = title.slice(0, 8)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate((t) => {
      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)
      const el = allElements.find(e => (e.textContent || '').includes(t))
      if (el) {
        // 点击标题本身或最近的卡片行
        let clickTarget = el
        while (clickTarget && clickTarget.tagName !== 'BODY' && clickTarget.getBoundingClientRect().width < 100) {
          clickTarget = clickTarget.parentElement
          // shadow DOM 边界：如果 parentElement 为 null 说明到了 shadow root，返回原元素
          if (!clickTarget) {
            clickTarget = el
            break
          }
        }
        const rect = clickTarget.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          clickTarget.click()
          return true
        }
      }
      return false
    }, titlePrefix)
    if (found) {
      await sleep(3000)
      console.log('[direct-upload] opened existing draft')
      return true
    }
    await sleep(1000)
  }
  console.warn('[direct-upload] draft with title not found in list')
  return false
}

async function dismissStaleDialog(page) {
  try {
    const clicked = await page.evaluate(() => {
      const allElements = []
      const collect = (root) => {
        const nodes = root.querySelectorAll('*')
        for (const el of nodes) {
          allElements.push(el)
          if (el.shadowRoot) collect(el.shadowRoot)
        }
      }
      collect(document)
      const hasDialog = allElements.some(el => (el.textContent || '').includes('将此次编辑保留'))
      if (!hasDialog) return false
      for (const el of allElements) {
        const text = (el.textContent || '').trim()
        if ((text === '不保存' || text === '取消') && ['BUTTON', 'A', 'DIV', 'SPAN'].includes(el.tagName)) {
          const rect = el.getBoundingClientRect()
          if (rect.width > 20 && rect.height > 20) {
            el.click()
            return true
          }
        }
      }
      return false
    })
    if (clicked) {
      console.log('[direct-upload] dismissed stale dialog')
      await sleep(1000)
    }
  } catch (err) {
    console.warn('[direct-upload] dismiss dialog failed:', err.message)
  }
}

async function main() {
  if (!fs.existsSync(VIDEO_PATH)) throw new Error(`Video not found: ${VIDEO_PATH}`)
  if (!fs.existsSync(COVER_3x4_PATH)) throw new Error(`Cover 3:4 not found: ${COVER_3x4_PATH}`)
  if (!fs.existsSync(COVER_4x3_PATH)) throw new Error(`Cover 4:3 not found: ${COVER_4x3_PATH}`)

  console.log('[direct-upload] connecting to', CDP_URL)
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  let pages = await browser.pages()
  let page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
  if (!page) {
    console.log('[direct-upload] no wechat channels page found, creating new page')
    page = await browser.newPage()
  }
  console.log('[direct-upload] using page:', page.url())

  await page.setViewport({ width: 1400, height: 860 })
  await page.setJavaScriptEnabled(true)

  await dismissStaleDialog(page)
  await screenshot(page, 'before_upload')

  // 如果当前在草稿列表页，先尝试打开已有草稿
  const url = page.url()
  if (url.includes('draft')) {
    console.log('[direct-upload] currently on drafts page, trying to open existing draft')
    const opened = await openExistingDraft(page, '李自成的道路')
    if (opened) {
      await screenshot(page, 'opened_draft')
    } else {
      console.log('[direct-upload] no existing draft found, navigating to create page')
      await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'networkidle2', timeout: 60_000 })
    }
  } else if (!url.includes('/platform/post/create')) {
    console.log('[direct-upload] navigating to publish page')
    await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'networkidle2', timeout: 60_000 })
  }

  await uploadVideo(page, VIDEO_PATH)
  await screenshot(page, 'after_video_upload')

  const title = '李自成的道路：从驿卒到起义领袖的制度悲剧'
  const description = '本集以一条鞭法与明朝覆灭为核心主题，深入分析张居正改革从救国良方演变为结构性灾难的完整逻辑链。'
  await fillShortTitle(page, title)
  await fillDescription(page, description)
  await uploadCover(page, COVER_3x4_PATH, COVER_4x3_PATH)
  await screenshot(page, 'after_meta')

  console.log('[direct-upload] saving draft...')
  const saved = await saveDraft(page)
  if (!saved) {
    console.log('[direct-upload] form filled but save draft button not found; please check browser.')
  }
  await screenshot(page, 'draft_saved')

  console.log('[direct-upload] done.')
  await browser.disconnect()
}

async function saveDraft(page, timeoutMs = 60_000) {
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
    for (const el of allElements) {
      if (texts.some(t => (el.textContent || '').trim() === t)) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          el.click()
          return true
        }
      }
    }
    return false
  }, ['保存草稿', '存草稿'])
  if (!clicked) return false

  const successTexts = ['保存成功', '已保存', '保存草稿成功']
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate((ts) => {
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
        if (ts.some(t => (el.textContent || '').includes(t))) return true
      }
      return false
    }, successTexts)
    if (ok) {
      console.log('[direct-upload] draft saved successfully')
      return true
    }
    await sleep(1000)
  }
  console.warn('[direct-upload] save draft success toast not found, but button was clicked')
  return true
}

main().catch(err => {
  console.error('[direct-upload] failed:', err.message)
  process.exit(1)
})
