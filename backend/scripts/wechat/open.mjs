#!/usr/bin/env node
/**
 * 阶段 2 · 页面打开 + 登录验证
 *
 *   node scripts/wechat/open.mjs
 *
 * 职责：连 CDP → 找/建视频号发布页 → 跳转 → 注入 collector → 判断登录状态。
 * 页面状态留在真实 Chrome 里，后续 operate/verify 阶段用同一个 CDP 复用它。
 *
 * 退出码：
 *   0  已登录且发布页就绪，输出 {ok:true, logged_in:true, page_ready:true}
 *   2  未登录，需人工扫码，输出 {ok:false, logged_in:false}，stderr 提示
 *   1  其它错误
 */
import {
  connectBrowser,
  getPublishPage,
  isLoggedIn,
  waitForCreateReady,
  injectCollector,
  screenshot,
  emit,
  fail,
} from './lib.mjs'

async function main() {
  const browser = await connectBrowser()
  try {
    const page = await getPublishPage(browser, { goto: true })
    await screenshot(page, 'open_01_page')

    const loggedIn = await isLoggedIn(page)
    if (!loggedIn) {
      await screenshot(page, 'open_02_need_login')
      emit({ ok: false, logged_in: false, url: page.url() })
      fail('未登录视频号助手，请在弹出的 Chrome 里用微信扫码登录后重试。', 2)
      return
    }

    const ready = await waitForCreateReady(page, 120_000)
    await injectCollector(page)
    await screenshot(page, 'open_03_ready')
    emit({ ok: ready, logged_in: true, page_ready: ready, url: page.url() })
    if (!ready) fail('发布页未在超时内就绪（未出现上传区）。', 1)
  } finally {
    browser.disconnect()
  }
}

main().catch((err) => fail(err.message, 1))
