#!/usr/bin/env node
/**
 * 阶段 3 · 页面操作（上传视频 / 填标题描述 / 上传双封面）
 *
 *   node scripts/wechat/operate.mjs --manifest data/publish-manifests/wechat-436.json [--step all]
 *
 * --step 可选 video | meta | cover | all（默认 all）。all 会依次做完三步但【不保存】。
 * 不保存草稿是刻意的：这里停下就是天然的人工确认点，保存交给 verify 阶段。
 *
 * 读 manifest 拿数据，用同一个 CDP 会话找到发布页操作它。
 * 退出码：0 成功；1 失败（stderr 说明卡在哪步）。
 */
import fs from 'node:fs'
import {
  connectBrowser,
  getPublishPage,
  isLoggedIn,
  uploadVideo,
  fillShortTitle,
  fillDescription,
  uploadCovers,
  injectCollector,
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
  if (!args.manifest) fail('需要 --manifest <path>（先跑 prepare 阶段生成）', 2)
  if (!fs.existsSync(args.manifest)) fail(`manifest 不存在: ${args.manifest}`, 2)
  const m = JSON.parse(fs.readFileSync(args.manifest, 'utf8'))

  // 再次确认文件仍在（prepare 之后可能被清理）
  for (const [label, p] of [['视频', m.video_path], ['3:4封面', m.cover_3x4_path], ['4:3封面', m.cover_4x3_path]]) {
    if (!fs.existsSync(p)) fail(`${label}文件丢失: ${p}`, 2)
  }

  const doVideo = args.step === 'all' || args.step === 'video'
  const doMeta = args.step === 'all' || args.step === 'meta'
  const doCover = args.step === 'all' || args.step === 'cover'

  const browser = await connectBrowser()
  const result = { ok: true, session: m.session, steps: {} }
  try {
    const page = await getPublishPage(browser, { goto: false })
    if (!(await isLoggedIn(page))) fail('未登录，请先跑 open 阶段并扫码。', 2)
    await injectCollector(page)

    if (doVideo) {
      const r = await uploadVideo(page, m.video_path)
      result.steps.video = r.skipped ? 'already_uploaded' : 'uploaded'
      await screenshot(page, 'operate_video')
    }

    if (doMeta) {
      const titleOk = await fillShortTitle(page, m.title)
      const descOk = await fillDescription(page, m.description)
      result.steps.meta = { title: titleOk, description: descOk }
      await screenshot(page, 'operate_meta')
      if (!titleOk) fail('未找到短标题输入框', 1)
      if (!descOk) fail('未找到作品描述编辑器', 1)
    }

    if (doCover) {
      const cov = await uploadCovers(page, m.cover_3x4_path, m.cover_4x3_path)
      result.steps.cover = cov
      // 封面弹窗可能重置短标题，补填一次
      await fillShortTitle(page, m.title)
      await screenshot(page, 'operate_cover')
      if (!cov.cover3x4 || !cov.cover4x3) {
        emit(result)
        fail(`封面上传未完成: 3:4=${cov.cover3x4} 4:3=${cov.cover4x3}`, 1)
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
