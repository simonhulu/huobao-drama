import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) {
  page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
  await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'networkidle2', timeout: 60_000 })
}
await page.setViewport({ width: 1400, height: 860 })
await new Promise(r => setTimeout(r, 2000))

// Scroll to top to see cover cards
await page.evaluate(() => window.scrollTo(0, 0))
await new Promise(r => setTimeout(r, 1000))

const coverInfo = await page.evaluate(() => {
  const all = []
  const collect = (root) => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      all.push(el)
      if (el.shadowRoot) collect(el.shadowRoot)
    }
  }
  collect(document)
  
  const keywords = ['个人主页卡片', '分享卡片', '编辑', '上传封面', '封面预览']
  const matches = all
    .filter(el => {
      const text = (el.textContent || '').trim()
      return keywords.some(k => text.includes(k)) && el.getBoundingClientRect().width > 0
    })
    .map(el => ({
      text: (el.textContent || '').trim().slice(0, 50),
      tag: el.tagName,
      class: (el.className || '').slice(0, 80),
      rect: el.getBoundingClientRect(),
    }))
    .sort((a, b) => a.rect.y - b.rect.y)
  
  return matches.slice(0, 30)
})

console.log('cover elements:', JSON.stringify(coverInfo, null, 2))
const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/create_page_inspect.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)
await browser.disconnect()
