import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = pages[0]
await page.setViewport({ width: 1400, height: 860 })
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await new Promise(r => setTimeout(r, 1000))

const buttons = await page.evaluate(() => {
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
      return text === '保存草稿' || text === '发表' || text === '手机预览'
    })
    .map(el => ({
      text: (el.textContent || '').trim(),
      tag: el.tagName,
      class: el.className,
      type: el.type,
      disabled: el.disabled,
      rect: el.getBoundingClientRect(),
      parentText: el.parentElement ? (el.parentElement.textContent || '').trim().slice(0, 100) : '',
    }))
    .slice(0, 10)
})
console.log('buttons:', JSON.stringify(buttons, null, 2))
await browser.disconnect()
