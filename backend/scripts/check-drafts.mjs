import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = await browser.newPage()
await page.goto('https://channels.weixin.qq.com/platform/post/draftListManager', { waitUntil: 'networkidle2', timeout: 60_000 })
await page.setViewport({ width: 1400, height: 860 })
await new Promise(r => setTimeout(r, 3000))
const text = await page.evaluate(() => {
  const all = []
  const collect = (root) => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      all.push(el)
      if (el.shadowRoot) collect(el.shadowRoot)
    }
  }
  collect(document)
  return all.map(el => (el.textContent || '').trim()).filter(t => t.length > 0 && (t.includes('草稿') || t.includes('李自') || t.includes('暂无') || /^\d+$/.test(t))).slice(0, 30)
})
console.log('draft texts:', JSON.stringify(text, null, 2))
const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/draft_list_check.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)
await browser.disconnect()
