#!/usr/bin/env node
/**
 * 阶段 4 · 保存草稿 + 验证
 *
 *   node scripts/wechat/verify.mjs --manifest data/publish-manifests/wechat-436.json
 *
 * 职责：在 operate 阶段已就绪的发布页上点「保存草稿」，并以"已保存"提示 HUD
 * （点草稿箱时页面会闪的那个）作为权威成功信号。
 * 这是全流程唯一会真正落地草稿的一步 —— 只有你确认后才该跑它。
 *
 * 输出 {ok, saved, title}。退出码：0 成功；1 失败。
 */
import fs from 'node:fs'
import {
  connectBrowser,
  attachDialogHandler,
  isLoggedIn,
  saveDraft,
  injectCollector,
  screenshot,
  emit,
  fail,
} from './lib.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--manifest') args.manifest = argv[++i]
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  let title = null
  if (args.manifest && fs.existsSync(args.manifest)) {
    title = JSON.parse(fs.readFileSync(args.manifest, 'utf8')).title
  }

  const browser = await connectBrowser()
  try {
    // 回到发布页点保存
    const pages = await browser.pages()
    let page = pages.find((p) => p.url().includes('/platform/post/create'))
    if (!page) {
      fail('找不到正在编辑的发布页，operate 阶段的内容可能已丢失，请从 operate 重跑。', 1)
      return
    }
    attachDialogHandler(page) // 处理保存跳转时的 Chrome 原生 beforeunload 弹窗
    if (!(await isLoggedIn(page))) fail('未登录。', 2)
    await injectCollector(page)

    // saveDraft 内部：点保存草稿 → 处理"将此次编辑保留?"弹窗 → 等"已保存"HUD/跳转。
    // 权威成功信号就是这个"已保存"HUD（点草稿箱时页面会闪的那个），saveDraft 已在检测它。
    const saved = await saveDraft(page)
    await screenshot(page, 'verify_after_save')

    const result = { ok: saved, saved, title }
    emit(result)
    if (!saved) fail('保存草稿失败（未检测到"已保存"提示，也未跳转到草稿列表）。', 1)
  } finally {
    browser.disconnect()
  }
}

main().catch((err) => fail(err.message, 1))
