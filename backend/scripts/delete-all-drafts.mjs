import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = await browser.newPage()
await page.goto('https://channels.weixin.qq.com/platform/post/draftListManager', { waitUntil: 'networkidle2', timeout: 60_000 })
await page.setViewport({ width: 1400, height: 860 })
await new Promise(r => setTimeout(r, 3000))

let deleted = 0
for (let attempt = 0; attempt < 20; attempt++) {
  const result = await page.evaluate(async () => {
    const all = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        all.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    // Find delete buttons
    const deleteBtns = all.filter(el => {
      const text = (el.textContent || '').trim()
      return text === '删除' && el.getBoundingClientRect().width > 0
    })
    if (deleteBtns.length === 0) return { found: false }
    // Click the first delete button
    const btn = deleteBtns[0]
    btn.scrollIntoView({ block: 'center' })
    btn.click()
    return { found: true, count: deleteBtns.length }
  })
  if (!result.found) break
  console.log(`clicked delete, remaining approx ${result.count - 1}`)
  await new Promise(r => setTimeout(r, 2000))
  // Confirm delete if dialog appears
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
    const confirm = all.find(el => {
      const text = (el.textContent || '').trim()
      return (text === '确定' || text === '确认') && el.getBoundingClientRect().width > 30
    })
    if (confirm) confirm.click()
  })
  await new Promise(r => setTimeout(r, 3000))
  deleted++
}

console.log(`deleted ${deleted} drafts`)
const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/after_delete_drafts.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)
await browser.disconnect()
