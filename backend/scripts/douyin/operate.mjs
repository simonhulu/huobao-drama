#!/usr/bin/env node
/**
 * 抖音 · 阶段 3 · 上传视频 / 标题描述 / 双封面（不保存）
 *   node scripts/douyin/operate.mjs --manifest data/publish-manifests/douyin-436.json [--step all]
 *
 * --step: video | meta | cover | all（默认 all）。跑完 cover 停下不保存——天然人工确认点。
 */
import fs from 'node:fs'
import {
  connectBrowser,
  getUploadPage,
  detectLoginPhase,
  uploadVideo,
  fillTitle,
  fillDescription,
  uploadCovers,
  dismissPopups,
  screenshot,
  emit,
  fail,
} from './lib.mjs'

function parseArgs(argv) {
  const args = { step: 'all' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--manifest') args.manifest = argv[++i]
    else if (a === '--step') args.step = argv[++i]
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.manifest) fail('需要 --manifest <path>（先跑 prepare）', 2)
  if (!fs.existsSync(args.manifest)) fail(`manifest 不存在: ${args.manifest}`, 2)
  const m = JSON.parse(fs.readFileSync(args.manifest, 'utf8'))
  for (const [label, p] of [['视频', m.video_path], ['3:4封面', m.cover_3x4_path], ['4:3封面', m.cover_4x3_path]]) {
    if (!fs.existsSync(p)) fail(`${label}文件丢失: ${p}`, 2)
  }

  const doVideo = args.step === 'all' || args.step === 'video'
  const doMeta = args.step === 'all' || args.step === 'meta'
  const doCover = args.step === 'all' || args.step === 'cover'

  const browser = await connectBrowser()
  const result = { ok: true, session: m.session, steps: {} }
  try {
    const page = await getUploadPage(browser, { goto: false })
    if ((await detectLoginPhase(page)) !== 'logged_in') fail('未登录，请先跑 open 阶段登录。', 2)
    await dismissPopups(page)

    if (doVideo) {
      const r = await uploadVideo(page, m.video_path)
      result.steps.video = r.skipped ? 'already_uploaded' : 'uploaded'
      await screenshot(page, 'operate_video')
    }

    if (doMeta) {
      await dismissPopups(page)
      const titleOk = await fillTitle(page, m.title)
      const descOk = await fillDescription(page, m.description)
      result.steps.meta = { title: titleOk, description: descOk }
      await screenshot(page, 'operate_meta')
      if (!titleOk) fail('未找到标题输入框', 1)
      if (!descOk) fail('未找到作品简介编辑器', 1)
    }

    if (doCover) {
      const cov = await uploadCovers(page, m.cover_4x3_path, m.cover_3x4_path)
      result.steps.cover = cov
      await screenshot(page, 'operate_cover')
      if (!cov.cover4x3 || !cov.cover3x4 || !cov.done) {
        emit(result)
        fail(`封面未完成: 4:3=${cov.cover4x3} 3:4=${cov.cover3x4} done=${cov.done}`, 1)
        return
      }
    }

    result.staged = true
    emit(result)
  } finally {
    browser.disconnect()
  }
}

main().catch((err) => fail(err.message, 1))
