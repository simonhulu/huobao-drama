#!/usr/bin/env node
/**
 * 诊断脚本：验证能否正常打开微信视频号发布页。
 * 会启动/连接 Chrome，导航到发布页，等待页面初始化完成并截图。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const PROFILE_DIR = process.env.WECHAT_CHANNELS_PROFILE_DIR || path.join(PROJECT_ROOT, 'data', 'wechat-channels-profile')
const DEBUG_DIR = path.join(PROFILE_DIR, 'debug')
const WINDOW_WIDTH = Number(process.env.WECHAT_CHANNELS_WINDOW_WIDTH || 1400)
const WINDOW_HEIGHT = Number(process.env.WECHAT_CHANNELS_WINDOW_HEIGHT || 860)

function getChromeExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH
  const systemMac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (fs.existsSync(systemMac)) return systemMac
  const systemMacCanary = '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
  if (fs.existsSync(systemMacCanary)) return systemMacCanary
  const remotionMac = path.resolve(PROJECT_ROOT, '.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell')
  if (fs.existsSync(remotionMac)) return remotionMac
  const remotionLinux = path.resolve(PROJECT_ROOT, '.remotion-chrome/chrome-headless-shell-linux-arm64/chrome-headless-shell')
  if (fs.existsSync(remotionLinux)) return remotionLinux
  return systemMac
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function screenshot(page, name) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true })
  const file = path.join(DEBUG_DIR, `${Date.now()}_${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`[diagnose] screenshot saved: ${file}`)
}

async function applyStealth(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
    const originalQuery = window.navigator.permissions?.query
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters?.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
    }
    window.chrome = { runtime: {} }
  })
}

async function waitForPageReady(page, timeoutMs = 120_000) {
  const start = Date.now()
  let lastLog = 0
  while (Date.now() - start < timeoutMs) {
    const url = page.url()
    const bodyText = await page.evaluate(() => document.body?.textContent?.slice(0, 200) || '').catch(() => '')
    const initializing = await page.evaluate(() =>
      document.body?.textContent?.includes('页面初始化中') ||
      document.body?.textContent?.includes('加载中')
    ).catch(() => false)
    const hasUploadTrigger = await page.evaluate(() => {
      const hasInput = document.querySelector('input[type="file"]') !== null
      const hasBtn = Array.from(document.querySelectorAll('button, div, span, a')).some((el) =>
        /上传视频|选择视频|发布视频/.test(el.textContent || '')
      )
      return hasInput || hasBtn
    }).catch(() => false)
    const needsLogin = await page.evaluate(() =>
      document.body?.textContent?.includes('微信扫码登录') ||
      document.body?.textContent?.includes('请使用微信扫一扫登录') ||
      document.querySelector('img[src*="qr"], .qr_code, [class*="qrcode"]') !== null
    ).catch(() => false)

    if (Date.now() - lastLog > 3000) {
      console.log(`[diagnose] url=${url} | initializing=${initializing} | uploadTrigger=${hasUploadTrigger} | needsLogin=${needsLogin}`)
      lastLog = Date.now()
    }

    if (needsLogin) {
      console.log('[diagnose] 检测到登录二维码，请使用微信扫码登录')
      await screenshot(page, 'diagnose_login_qr')
    }

    if (!initializing && hasUploadTrigger) return true
    await sleep(1000)
  }
  return false
}

async function main() {
  const executablePath = getChromeExecutablePath()
  console.log(`[diagnose] Chrome path: ${executablePath}`)
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Chrome 不存在: ${executablePath}`)
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  console.log(`[diagnose] profile dir: ${PROFILE_DIR}`)

  const cdpUrl = process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222'
  let browser
  try {
    browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null })
    console.log(`[diagnose] connected to CDP: ${cdpUrl}`)
  } catch (err) {
    console.log(`[diagnose] CDP connect failed, launching Chrome: ${err.message}`)
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      // 用临时干净 profile 排除旧配置干扰
      userDataDir: path.join(PROFILE_DIR, 'diagnose-fresh-' + Date.now()),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        `--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
      ],
      defaultViewport: null,
    })
    console.log('[diagnose] Chrome launched')
  }

  try {
    const pages = await browser.pages()
    const page = pages[0] || (await browser.newPage())
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    )
    await page.setViewport({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
    await page.setJavaScriptEnabled(true)
    await applyStealth(page)

    console.log('[diagnose] navigating to https://channels.weixin.qq.com/platform/post/create')
    try {
      await page.goto('https://channels.weixin.qq.com/platform/post/create', {
        waitUntil: 'networkidle2',
        timeout: 60_000,
      })
    } catch {
      console.log('[diagnose] networkidle2 timed out, falling back to domcontentloaded')
      await page.goto('https://channels.weixin.qq.com/platform/post/create', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
    }
    await screenshot(page, 'diagnose_opened')

    console.log('[diagnose] waiting for page ready...')
    const ready = await waitForPageReady(page, 120_000)
    await screenshot(page, 'diagnose_ready')

    if (ready) {
      console.log('[diagnose] ✅ 发布页初始化完成')
    } else {
      console.log('[diagnose] ❌ 发布页初始化超时')
      process.exitCode = 1
    }
  } catch (err) {
    console.error('[diagnose] ❌ error:', err.message)
    process.exitCode = 1
  }

  console.log('[diagnose] closing browser')
  await browser.close().catch(() => {})
}

main().catch((err) => {
  console.error('[diagnose] fatal:', err)
  process.exit(1)
})
