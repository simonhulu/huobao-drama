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
import path from 'node:path'
import {
  PROJECT_ROOT,
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
  isHistoryManifest,
  assertHistoryCanStage,
  readHistoryPublishState,
  writeHistoryPublishState,
  bindHistoryPage,
  isVideoUploaded,
  lockHistoryPublish,
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
  if (!['video', 'meta', 'cover', 'all'].includes(args.step)) fail('无效 --step，只支持 video|meta|cover|all', 2)
  // 相对路径按 CWD → PROJECT_ROOT/data 顺序解析，兼容从项目根或 backend/ 调用
  if (!path.isAbsolute(args.manifest) && !fs.existsSync(args.manifest)) {
    const alt = path.join(PROJECT_ROOT, args.manifest)
    if (fs.existsSync(alt)) args.manifest = alt
  }
  if (!fs.existsSync(args.manifest)) fail(`manifest 不存在: ${args.manifest}`, 2)
  const m = JSON.parse(fs.readFileSync(args.manifest, 'utf8'))
  const doVideo = args.step === 'all' || args.step === 'video'
  const doMeta = args.step === 'all' || args.step === 'meta'
  const doCover = args.step === 'all' || args.step === 'cover'
  const external = isHistoryManifest(m) || Boolean(m.publish_package_id)
  if (external) {
    assertHistoryCanStage(m)
  }

  // 再次确认本次操作所需文件仍在（prepare 之后可能被清理）。
  const requiredFiles = []
  if (doVideo) requiredFiles.push(['视频', m.video_path])
  if (doCover) requiredFiles.push(['3:4封面', m.cover_3x4_path], ['4:3封面', m.cover_4x3_path])
  for (const [label, file] of requiredFiles) {
    if (typeof file !== 'string' || !fs.existsSync(file)) fail(`${label}文件丢失: ${file}`, 2)
  }

  const completed = external ? { ...(readHistoryPublishState(m)?.steps || {}) } : {}
  const recordStep = (step) => {
    if (!external) return
    completed[step] = true
    writeHistoryPublishState(m, {
      status: completed.video && completed.meta && completed.cover ? 'staged' : 'staging',
      steps: completed,
    })
  }

  const release = external ? lockHistoryPublish(m) : null
  let browser
  const result = { ok: true, session: m.session, steps: {} }
  try {
    if (external) assertHistoryCanStage(m)
    browser = await connectBrowser()
    const page = await getPublishPage(browser, { goto: false })
    if (!(await isLoggedIn(page))) throw Object.assign(new Error('未登录，请先跑 open 阶段并扫码。'), { exitCode: 2 })
    await injectCollector(page)
    if (external) {
      const { newlyBound } = await bindHistoryPage(page, m, { allowNew: doVideo })
      if (newlyBound) {
        for (const step of Object.keys(completed)) delete completed[step]
        writeHistoryPublishState(m, { status: 'staging', steps: {} })
      }
    }
    if (!doVideo && !(await isVideoUploaded(page))) throw new Error('请先完成当前素材包的视频上传')

    if (doVideo) {
      const r = await uploadVideo(page, m.video_path)
      result.steps.video = r.skipped ? 'already_uploaded' : 'uploaded'
      await screenshot(page, 'operate_video')
      recordStep('video')
    }

    if (doMeta) {
      // Metadata is best-effort. Upload acceptance is based on the video and
      // cover states; a title or description issue must not block the upload.
      await fillShortTitle(page, m.title)
      await fillDescription(page, m.description)
      result.steps.meta = { status: 'attempted' }
      await screenshot(page, 'operate_meta')
      recordStep('meta')
    }

    if (doCover) {
      const cov = await uploadCovers(page, m.cover_3x4_path, m.cover_4x3_path)
      result.steps.cover = cov
      await screenshot(page, 'operate_cover')
      if (!cov.cover3x4 || !cov.cover4x3) {
        emit(result)
        throw new Error(`封面上传未完成: 3:4=${cov.cover3x4} 4:3=${cov.cover4x3}`)
      }
      recordStep('cover')
    }

    result.staged = external ? Boolean(completed.video && completed.meta && completed.cover) : true
    emit(result)
  } finally {
    browser?.disconnect()
    release?.()
  }
}

main().catch((err) => fail(err.message, err.exitCode || 1))
