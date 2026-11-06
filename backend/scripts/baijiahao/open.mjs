#!/usr/bin/env node
import { connectBrowser, getEditorPage, waitForPage, classifyPage, screenshot, emit, fail, parseArgs } from './lib.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--inspect'])
  const browser = await connectBrowser()
  try {
    const page = await getEditorPage(browser, { open: true })
    await page.bringToFront()
    const snapshot = await waitForPage(page)
    const phase = classifyPage(snapshot)
    const result = { ok: phase === 'ready', phase, logged_in: phase === 'ready', page_ready: phase === 'ready',
      url: page.url(), screenshot: await screenshot(page, `open-${phase}`) }
    if (args.inspect) result.inspection = snapshot
    emit(result)
    if (phase === 'login_required' || phase === 'verification_required') {
      process.exitCode = 2
      process.stderr.write('[baijiahao] 请在 Chrome 中人工完成登录/验证后重试；不会读取密码或绕过验证。\n')
    } else if (phase !== 'ready') throw new Error('无法确认视频编辑页就绪，请检查截图与 --inspect 输出')
  } finally { browser.disconnect() }
}
main().catch(fail)
