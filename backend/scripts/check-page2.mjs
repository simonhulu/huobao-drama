import puppeteer from 'puppeteer-core'
const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser/20bd1c97-d709-4ddc-b299-ccf0fa1e219b', defaultViewport: null })
const pages = await browser.pages()
const page = pages[0]
if (page) {
  console.log('url:', page.url())
  await page.screenshot({ path: '/Users/zhangshijie/Documents/workspace/huobao-drama/data/wechat-channels-profile/debug/page_check2.png', fullPage: true })
}
process.exit(0)
