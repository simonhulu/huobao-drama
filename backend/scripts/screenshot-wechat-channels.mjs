import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const DEBUG_DIR = path.join(PROJECT_ROOT, 'data/wechat-channels-profile/debug')
async function main() {
  const browser = await puppeteer.connect({ browserURL: process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222', defaultViewport: null })
  const pages = await browser.pages()
  const page = pages[0]
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
  const file = path.join(DEBUG_DIR, `${Date.now()}_current_state.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(file)
  await browser.disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
