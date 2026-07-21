import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = pages[0]

const logs = []
page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }))
page.on('pageerror', err => logs.push({ type: 'pageerror', text: err.message }))
page.on('requestfailed', req => logs.push({ type: 'requestfailed', text: req.url() + ' ' + req.failure().errorText }))

await new Promise(r => setTimeout(r, 3000))

// Try clicking save and capture what happens
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await new Promise(r => setTimeout(r, 1000))
await page.evaluate(() => {
  const all = []
  const collect = (root) => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      all.push(el)
      if (el.shadowRoot) collect(el.shadowRoot)
    }
  }
  collect(document)
  const candidates = all.filter(el => (el.textContent || '').trim() === '保存草稿')
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
    candidates[0].click()
  }
})
await new Promise(r => setTimeout(r, 3000))

console.log('logs:', JSON.stringify(logs.slice(0, 50), null, 2))

// Check for visible errors
const visibleErrors = await page.evaluate(() => {
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
    .filter(el => {
      const text = (el.textContent || '').trim()
      return text && (text.includes('失败') || text.includes('错误') || text.includes('无法') || text.includes('请填写') || text.includes('不能为空') || text.includes('超过'))
    })
    .map(el => ({
      text: el.textContent.trim().slice(0, 100),
      visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
      rect: el.getBoundingClientRect(),
    }))
    .slice(0, 20)
})
console.log('visible errors:', JSON.stringify(visibleErrors, null, 2))

const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/console_check.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)
await browser.disconnect()
