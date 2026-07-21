import puppeteer from 'puppeteer-core'
const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser/4da5180b-35a4-410a-88b0-fba3ed770af0', defaultViewport: null })
const pages = await browser.pages()
const page = pages[0]
if (page) {
  await page.keyboard.press('Escape')
  await new Promise(r => setTimeout(r, 500))
  await page.screenshot({ path: '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/after_escape.png', fullPage: true })
}
process.exit(0)
