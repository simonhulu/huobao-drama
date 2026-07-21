#!/usr/bin/env node
/**
 * 等待用户完成微信扫码登录，并检测登录成功。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const DEBUG_DIR = path.join(PROJECT_ROOT, 'data/wechat-channels-profile/debug')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function screenshot(page, name) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
  const file = path.join(DEBUG_DIR, `${Date.now()}_${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`[wait-login] screenshot saved: ${file}`)
}

async function main() {
  const cdpUrl = process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222'
  console.log(`[wait-login] connecting to ${cdpUrl}`)
  const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null })
  const pages = await browser.pages()
  const page = pages[0]
  if (!page) {
    console.log('[wait-login] NO_PAGE')
    await browser.disconnect()
    return
  }

  const loginDoneSelectors = [
    'input[type="file"][accept*="video"]',
    '.post-create-container',
    '.post-create-form',
    '.weui-desktop-layout__main',
    '[data-testid="publish-form"]',
  ]

  const start = Date.now()
  const timeoutMs = 10 * 60_000 // 10 分钟
  let lastLog = 0

  while (Date.now() - start < timeoutMs) {
    const url = page.url()
    const hasPublish = url.includes('/platform/post/create')
    let hasUploadTrigger = false
    if (hasPublish) {
      hasUploadTrigger = await page.evaluate((selectors) => {
        for (const sel of selectors) {
          if (document.querySelector(sel)) return true
        }
        const hasBtn = Array.from(document.querySelectorAll('button, div, span, a')).some((el) =>
          /上传视频|选择视频|发布视频/.test(el.textContent || '')
        )
        return hasBtn
      }, loginDoneSelectors).catch(() => false)
    }

    const needsLogin = url.includes('login') || await page.evaluate(() =>
      document.body?.textContent?.includes('微信扫码登录') ||
      document.querySelector('img[src*="qr"], .qr_code, [class*="qrcode"]') !== null
    ).catch(() => false)

    if (Date.now() - lastLog > 3000) {
      console.log(`[wait-login] url=${url} | needsLogin=${needsLogin} | hasPublish=${hasPublish} | hasUploadTrigger=${hasUploadTrigger}`)
      lastLog = Date.now()
    }

    if (hasPublish && hasUploadTrigger) {
      await screenshot(page, 'login_success')
      console.log('[wait-login] ✅ 登录成功，已进入发布页')
      await browser.disconnect()
      return
    }

    await sleep(1000)
  }

  console.log('[wait-login] ❌ 等待登录超时')
  await browser.disconnect()
  process.exitCode = 1
}

main().catch((err) => {
  console.error('[wait-login] fatal:', err)
  process.exit(1)
})
