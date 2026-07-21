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
  const buttons = all
    .filter(el => {
      const text = (el.textContent || '').trim()
      return text === '确认'
    })
    .map(el => {
      const r = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      const tag = el.tagName
      const classText = typeof el.className === 'string' ? el.className : String(el.className || '')
      return {
        tag,
        class: classText,
        role: el.getAttribute('role'),
        ariaDisabled: el.getAttribute('aria-disabled'),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        style: {
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          cursor: style.cursor,
          display: style.display,
          visibility: style.visibility,
          backgroundColor: style.backgroundColor,
        },
        disabled: el.disabled,
      }
    })
  return { confirmCount: buttons.length, buttons }
})
console.log(JSON.stringify(result, null, 2))
await browser.disconnect()
