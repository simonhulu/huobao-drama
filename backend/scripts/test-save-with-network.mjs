#!/usr/bin/env node
import puppeteer from 'puppeteer-core'

const CDP_URL = process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = pages[0]

await page.setViewport({ width: 1400, height: 860 })

const requests = []
const responses = []
page.on('request', req => {
  if (req.url().includes('channels.weixin.qq.com')) {
    requests.push({ url: req.url(), method: req.method(), postData: req.postData() })
  }
})
page.on('response', async res => {
  if (res.url().includes('channels.weixin.qq.com')) {
    let text = ''
    try { text = await res.text().catch(() => '') } catch {}
    responses.push({ url: res.url(), status: res.status(), text: text.slice(0, 500) })
  }
})

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Check current form state
const beforeState = await page.evaluate(() => {
  const all = []
  const collect = (root) => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      all.push(el)
      if (el.shadowRoot) collect(el.shadowRoot)
    }
  }
  collect(document)
  const video = all.find(el => el.tagName === 'VIDEO')
  const titleInput = all.find(el => el.tagName === 'INPUT' && (el.placeholder || '').includes('短标题'))
  const saveBtn = all.find(el => el.tagName === 'BUTTON' && (el.textContent || '').trim() === '保存草稿')
  return {
    url: window.location.href,
    hasVideo: !!video,
    videoVisible: video ? video.getBoundingClientRect().width > 100 : false,
    titleValue: titleInput ? titleInput.value : null,
    saveBtnDisabled: saveBtn ? saveBtn.disabled : null,
    saveBtnClasses: saveBtn ? saveBtn.className : null,
    saveBtnRect: saveBtn ? saveBtn.getBoundingClientRect() : null,
  }
})
console.log('before state:', JSON.stringify(beforeState, null, 2))

// Scroll to save button
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await sleep(1000)
}

// Click the actual BUTTON element
const clickResult = await page.evaluate(() => {
  const all = []
  const collect = (root) => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      all.push(el)
      if (el.shadowRoot) collect(el.shadowRoot)
    }
  }
  collect(document)
  const saveBtn = all.find(el => el.tagName === 'BUTTON' && (el.textContent || '').trim() === '保存草稿')
  if (!saveBtn) return { found: false }
  saveBtn.scrollIntoView({ block: 'center' })
  const rect = saveBtn.getBoundingClientRect()
  saveBtn.click()
  return {
    found: true,
    disabled: saveBtn.disabled,
    classes: saveBtn.className,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  }
})
console.log('click result:', JSON.stringify(clickResult, null, 2))

if (clickResult.found) {
  await sleep(1000)
  // Also do a mouse click at the same coordinates
  await page.mouse.click(clickResult.x, clickResult.y)
  console.log('also clicked via mouse at', clickResult.x, clickResult.y)
}

// Wait and check what happens
await sleep(8000)

const afterState = await page.evaluate(() => {
  const all = []
  const collect = (root) => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      all.push(el)
      if (el.shadowRoot) collect(el.shadowRoot)
    }
  }
  collect(document)
  const video = all.find(el => el.tagName === 'VIDEO')
  const titleInput = all.find(el => el.tagName === 'INPUT' && (el.placeholder || '').includes('短标题'))
  return {
    url: window.location.href,
    hasVideo: !!video,
    videoVisible: video ? video.getBoundingClientRect().width > 100 : false,
    titleValue: titleInput ? titleInput.value : null,
    visibleDialogs: all
      .filter(el => {
        const text = (el.textContent || '').trim()
        return (text.includes('保存') || text.includes('确认') || text.includes('取消')) && el.getBoundingClientRect().width > 100
      })
      .map(el => ({ text: el.textContent.trim().slice(0, 100), tag: el.tagName, visible: el.getBoundingClientRect().width > 0 }))
      .slice(0, 10),
  }
})
console.log('after state:', JSON.stringify(afterState, null, 2))

console.log('requests:', JSON.stringify(requests.slice(0, 20), null, 2))
console.log('responses:', JSON.stringify(responses.slice(0, 20), null, 2))

const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/test_save_network.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)

await browser.disconnect()
