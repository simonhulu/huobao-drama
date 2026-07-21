import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = pages[0]
await page.setViewport({ width: 1400, height: 860 })

// Scroll to bottom multiple times
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await new Promise(r => setTimeout(r, 1000))
}

const screenshot1 = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/before_manual_save.png'
await page.screenshot({ path: screenshot1 })
console.log('before save screenshot:', screenshot1)

// Click save button
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
    return text === '保存草稿' && el.getBoundingClientRect().width > 60 && el.getBoundingClientRect().height > 30
  })
  candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
  if (candidates.length > 0) {
    const el = candidates[0]
    el.scrollIntoView({ block: 'center' })
    const rect = el.getBoundingClientRect()
    return { clicked: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }
  return { clicked: false }
})
console.log('save button:', JSON.stringify(clicked))

if (clicked.clicked) {
  await page.mouse.click(clicked.x, clicked.y)
  console.log('clicked save at', clicked.x, clicked.y)
}

// Wait for redirect or success
await new Promise(r => setTimeout(r, 5000))
const screenshot2 = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/after_manual_save.png'
await page.screenshot({ path: screenshot2 })
console.log('after save screenshot:', screenshot2)
console.log('current url:', page.url())

await browser.disconnect()
