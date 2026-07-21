import puppeteer from 'puppeteer-core'
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' })
const pages = await browser.pages()
const page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) {
  console.log('page not found')
  process.exit(1)
}
const result = await page.evaluate(() => {
  function collectAllElements(root) {
    const base = root ?? document
    const result = []
    const nodes = base.querySelectorAll('*')
    for (const el of nodes) {
      result.push(el)
      if (el.shadowRoot) result.push(...collectAllElements(el.shadowRoot))
    }
    return result
  }
  const all = collectAllElements()
  const titles = all
    .filter(el => /编辑个人主页卡片|编辑分享卡片/.test((el.textContent || '').trim()))
    .map(el => {
      const r = el.getBoundingClientRect()
      return {
        text: (el.textContent || '').trim(),
        tag: el.tagName,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom },
      }
    })
  if (titles.length === 0) return { error: 'no title' }
  const tRect = titles[0].rect
  // 找标题右上方所有可见元素
  const nearby = all
    .filter(el => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.width < 100 && r.height < 100 &&
        r.right > tRect.right - 150 && r.top < tRect.top + 100 && r.bottom > tRect.top - 20
    })
    .map(el => {
      const r = el.getBoundingClientRect()
      return {
        tag: el.tagName,
        class: typeof el.className === 'string' ? el.className : String(el.className || ''),
        text: (el.textContent || '').trim().slice(0, 50),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
      }
    })
  return { titles, nearbyCount: nearby.length, nearby }
})
console.log(JSON.stringify(result, null, 2))
await browser.disconnect()
