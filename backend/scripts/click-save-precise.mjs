import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = pages[0]
await page.setViewport({ width: 1400, height: 860 })

for (let attempt = 0; attempt < 3; attempt++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await new Promise(r => setTimeout(r, 1000))
  
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
    if (candidates.length === 0) return false
    candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)
    const el = candidates[0]
    el.scrollIntoView({ block: 'center' })
    el.click()
    return true
  })
  console.log(`attempt ${attempt + 1} clicked:`, clicked)
  if (!clicked) break
  await new Promise(r => setTimeout(r, 3000))
  
  const url = page.url()
  console.log('current url:', url)
  if (url.includes('/draftListManager')) {
    console.log('save succeeded, redirected to draft list')
    break
  }
}

const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/after_precise_save.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)
console.log('final url:', page.url())
await browser.disconnect()
