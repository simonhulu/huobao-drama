import puppeteer from 'puppeteer-core'
async function main() {
  const browser = await puppeteer.connect({ browserURL: process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222', defaultViewport: null })
  const pages = await browser.pages()
  const page = pages[0]
  if (!page) {
    console.log('NO_PAGE')
    await browser.disconnect()
    return
  }
  const url = page.url()
  const bodyText = await page.evaluate(() => document.body?.textContent?.slice(0, 300) || '').catch(() => '')
  const hasQr = await page.evaluate(() =>
    document.body?.textContent?.includes('微信扫码登录') ||
    document.querySelector('img[src*="qr"], .qr_code, [class*="qrcode"]') !== null
  ).catch(() => false)
  const hasLogin = url.includes('login') || hasQr
  const hasPublish = url.includes('/platform/post/create') && !hasLogin
  console.log(JSON.stringify({ url, hasLogin, hasQr, hasPublish, bodyText }, null, 2))
  await browser.disconnect()
}
main().catch(e => { console.error('ERROR', e.message); process.exit(1) })
