import puppeteer from 'puppeteer-core'
const CDP_URL = 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
let pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = pages[0]
await page.goto('https://channels.weixin.qq.com/platform/post/draftListManager', { waitUntil: 'networkidle0', timeout: 120_000 })
await page.setViewport({ width: 1400, height: 860 })
await new Promise(r => setTimeout(r, 3000))

// Hover over the draft item to reveal delete button, then click it
const result = await page.evaluate(() => {
  const all = []
  const collect = (root) => {
    const nodes = root.querySelectorAll('*')
    for (const el of nodes) {
      all.push(el)
      if (el.shadowRoot) collect(el.shadowRoot)
    }
  }
  collect(document)
  
  // Find the first draft row/card
  const draftItems = all.filter(el => {
    const rect = el.getBoundingClientRect()
    return rect.width > 300 && rect.height > 80 && rect.x > 200 && rect.y > 150
  }).sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
  
  if (draftItems.length === 0) return { found: false }
  
  // Hover over it
  const item = draftItems[0]
  const rect = item.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  
  // Dispatch mouseover/mouseenter events
  item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: centerX, clientY: centerY }))
  item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: centerX, clientY: centerY }))
  
  return { found: true, itemText: (item.textContent || '').trim().slice(0, 60) }
})
console.log('hover result:', JSON.stringify(result))

if (result.found) {
  await new Promise(r => setTimeout(r, 1500))
  
  // Now look for delete button
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
    const deleteBtn = all.find(el => {
      const text = (el.textContent || '').trim()
      return text === '删除' && el.getBoundingClientRect().width > 0
    })
    if (deleteBtn) {
      deleteBtn.click()
      return true
    }
    return false
  })
  console.log('clicked delete:', clicked)
  
  if (clicked) {
    await new Promise(r => setTimeout(r, 2000))
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
  }
}

const screenshot = '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/after_delete_first_draft.png'
await page.screenshot({ path: screenshot })
console.log('screenshot:', screenshot)
await browser.disconnect()
