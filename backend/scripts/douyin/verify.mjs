#!/usr/bin/env node
/**
 * 抖音 · 阶段 4 · 保存草稿（暂存离开）
 *   node scripts/douyin/verify.mjs --manifest data/publish-manifests/douyin-436.json
 *
 * 点「暂存离开」保存草稿，以 toast/离开上传路由/出现「继续编辑」为成功信号。
 * 全流程唯一真正落地草稿的一步 —— 只有你确认后才该跑它。
 */
import fs from 'node:fs'
import {
  connectBrowser,
  getUploadPage,
  detectLoginPhase,
  saveDraft,
  screenshot,
  emit,
  fail,
} from './lib.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--manifest') args.manifest = argv[++i]
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
    const page = await getUploadPage(browser, { goto: false })
    if ((await detectLoginPhase(page)) !== 'logged_in') fail('未登录。', 2)

    const saved = await saveDraft(page)
    await screenshot(page, 'verify_after_save')

    emit({ ok: saved, saved, title })
    if (!saved) fail('保存草稿失败（未检测到 toast/继续编辑/路由跳转）。', 1)
  } finally {
    browser.disconnect()
  }
}

main().catch((err) => fail(err.message, 1))
