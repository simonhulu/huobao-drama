#!/usr/bin/env node
/**
 * 抖音 · 阶段 2 · 打开上传页 + 登录验证
 *   node scripts/douyin/open.mjs
 *
 * 退出码：0 已登录且就绪；2 未登录（需扫码/短信）；1 其它错误。
 */
import {
  connectBrowser,
  getUploadPage,
  detectLoginPhase,
  dismissPopups,
  screenshot,
  emit,
  fail,
  sleep,
} from './lib.mjs'

async function main() {
  const browser = await connectBrowser()
  try {
    const page = await getUploadPage(browser, { goto: true })
    await sleep(2000)
    await dismissPopups(page)
    await screenshot(page, 'open_01_page')

    const phase = await detectLoginPhase(page)
    if (phase !== 'logged_in') {
      await screenshot(page, 'open_02_need_login')
      emit({ ok: false, logged_in: false, phase, url: page.url() })
      const hint = phase === 'qrcode' ? '请在弹出的 Chrome 里用抖音 APP 扫码登录' : phase === 'sms' ? '需要短信验证码登录' : '未检测到登录态'
      fail(`未登录抖音创作者平台：${hint}。登录后重试。`, 2)
      return
    }
    await screenshot(page, 'open_03_ready')
    emit({ ok: true, logged_in: true, url: page.url() })
  } finally {
    browser.disconnect()
  }
}

main().catch((err) => fail(err.message, 1))
