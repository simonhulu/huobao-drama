import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = await browser.newPage()
await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'networkidle2', timeout: 60_000 })
await page.setViewport({ width: 1400, height: 860 })
await new Promise(r => setTimeout(r, 2000))

// Click "保存" on the confirmation dialog if present
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
  // Find buttons in the dialog
  const saveBtn = all.find(el => {
    const text = (el.textContent || '').trim()
    return (text === '保存' || text === '确认') && el.getBoundingClientRect().width > 30
  })
  if (saveBtn) {
    saveBtn.click()
    return true
  }
  return false
})
console.log('clicked save on dialog:', clicked)
await new Promise(r => setTimeout(r, 2000))
const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/after_dismiss_dialog.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)
await browser.disconnect()
