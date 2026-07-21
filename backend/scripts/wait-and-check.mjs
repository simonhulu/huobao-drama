import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = (await browser.pages())[0]
await page.setViewport({ width: 1400, height: 860 })

console.log('url:', page.url())
for (let i = 0; i < 6; i++) {
  await new Promise(r => setTimeout(r, 3000))
  const hasVideo = await page.evaluate(() => {
    const all = []
    const collect = (root) => {
      const nodes = root.querySelectorAll('*')
      for (const el of nodes) {
        all.push(el)
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    return all.some(el => el.tagName === 'VIDEO' || (el.textContent || '').includes('封面预览'))
  })
  console.log(`check ${i + 1}: hasVideo/coverPreview =`, hasVideo)
  if (hasVideo) break
}

const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/draft_loaded_check.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)
await browser.disconnect()
