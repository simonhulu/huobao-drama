import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = await browser.newPage()
await page.goto('https://channels.weixin.qq.com/platform/post/draftListManager', { waitUntil: 'networkidle2', timeout: 60_000 })
await page.setViewport({ width: 1400, height: 860 })
await new Promise(r => setTimeout(r, 3000))

const screenshot1 = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/draft_list_open.png'
await page.screenshot({ path: screenshot1 })
console.log('draft list screenshot:', screenshot1)

// Click the draft item (the first clickable item in the list)
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
  // Find draft items - usually they have a date or title area
  const draftItems = all.filter(el => {
    const rect = el.getBoundingClientRect()
    return rect.width > 200 && rect.height > 60 && rect.y > 100 && rect.x > 200
  })
  // Sort by y and click the first one
  draftItems.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
  if (draftItems.length > 0) {
    const el = draftItems[0]
    el.click()
    return { clicked: true, text: (el.textContent || '').trim().slice(0, 50), rect: el.getBoundingClientRect() }
  }
  return { clicked: false }
})
console.log('clicked draft item:', JSON.stringify(clicked))

await new Promise(r => setTimeout(r, 5000))
const screenshot2 = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/draft_edit_page.png'
await page.screenshot({ path: screenshot2 })
console.log('draft edit screenshot:', screenshot2)
console.log('current url:', page.url())

await browser.disconnect()
