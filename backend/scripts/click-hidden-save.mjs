import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = pages[0]
await page.setViewport({ width: 1400, height: 860 })

// Click "保存" inside the hidden confirmation dialog if present
const clickedHidden = await page.evaluate(() => {
  const all = []
  const collect = (root) => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      all.push(el)
      if (el.shadowRoot) collect(el.shadowRoot)
    }
  }
  collect(document)
  // Find dialog that contains the confirmation text
  const dialog = all.find(el => {
    const text = (el.textContent || '').trim()
    return text.includes('将此次编辑保留') && (el.className || '').includes('common-dialog')
  })
  if (!dialog) return { found: false }
  const saveBtn = all.find(el => {
    const text = (el.textContent || '').trim()
    return text === '保存' && (dialog.contains(el) || el.closest('.common-dialog'))
  })
  if (saveBtn) {
    saveBtn.click()
    return { found: true, clicked: true }
  }
  return { found: true, clicked: false }
})
console.log('hidden dialog save:', JSON.stringify(clickedHidden))

await new Promise(r => setTimeout(r, 3000))

// Now try clicking the visible save button
const clicked = await page.evaluate(() => {
  const all = []
  const collect = (root) => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      all.push(el)
      if (el.shadowRoot) collect(el.shadowRoot)
    }
  }
  collect(document)
  const candidates = all.filter(el => {
    const text = (el.textContent || '').trim()
    return text === '保存草稿' && el.getBoundingClientRect().width > 60
  })
  candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
  if (candidates.length > 0) {
    candidates[0].click()
    return true
  }
  return false
})
console.log('visible save clicked:', clicked)

await new Promise(r => setTimeout(r, 5000))
const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/after_hidden_save_click.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)
console.log('url:', page.url())

await browser.disconnect()
