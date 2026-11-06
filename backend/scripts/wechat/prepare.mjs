#!/usr/bin/env node
/**
 * 阶段 1 · 数据准备
 *
 *   node scripts/wechat/prepare.mjs 436
 *   node scripts/wechat/prepare.mjs "http://localhost:3013/drama/93/episode/3"
 *   （或用 tsx / node，见 SKILL.md）
 *
 * 职责：拿到"要上传什么"，产出一个已校验的 manifest JSON，供后面的 operate 阶段消费。
 * 数据来源通过 --provider 切换（可插拔，默认 db）。目前实现 db provider；
 * 以后加 file / api provider 只需实现同一个 load() 契约，后续阶段完全不用改。
 *
 * 输出文件：data/publish-manifests/wechat-<episode>.json
 * 同时把 manifest 打到 stdout（一行 JSON）。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { VIDEO_TITLE_SYMBOL_RULE, normalizeVideoTitle, hasSupportedVideoTitleSymbols } from '../../src/services/video-title-format.js'
import {
  PROJECT_ROOT, COVER_TARGETS, emit, fail,
  resolveManifestPath, validateHistoryManifest, historyManifestFingerprint,
} from './lib.mjs'

// --- 参数解析 -------------------------------------------------------------
function parseArgs(argv) {
  const args = { provider: 'db' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--provider') args.provider = argv[++i]
    else if (a === '--episode') args.episodeReference = argv[++i]
    else if (a === '--title') args.title = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--package') args.package = argv[++i]
    else if (!a.startsWith('--') && !args.reference) args.reference = a
  }
  return args
}

// --- 工具 -----------------------------------------------------------------
function toAbsPath(relativeOrAbs) {
  if (!relativeOrAbs) return relativeOrAbs
  if (path.isAbsolute(relativeOrAbs)) return relativeOrAbs
  // DB 里存的是 static/... 相对 data/ 目录
  const cleaned = relativeOrAbs.replace(/^\/+/, '')
  if (cleaned.startsWith('data/')) return path.join(PROJECT_ROOT, cleaned)
  return path.join(PROJECT_ROOT, 'data', cleaned)
}

async function ensureAspectRatio(sourcePath, ratio, preserve = false) {
  const target = COVER_TARGETS[ratio]
  const meta = await sharp(sourcePath).metadata()
  if (!meta.width || !meta.height) throw new Error(`无法读取封面尺寸: ${sourcePath}`)
  const actual = meta.width / meta.height
  const wanted = target.width / target.height
  if (Math.abs(actual - wanted) / wanted <= 0.01) return sourcePath // 已符合
  if (preserve) throw new Error(`历史脚本封面比例不正确，请回脚本页面重新生成 ${ratio}，不会自动裁切: ${sourcePath}`)

  const outDir = path.join(PROJECT_ROOT, 'data/temp/wechat-covers/normalized')
  fs.mkdirSync(outDir, { recursive: true })
  const base = path.basename(sourcePath).replace(/\.[^.]+$/, '')
  const outPath = path.join(outDir, `${base}-${ratio.replace(':', 'x')}.png`)
  await sharp(sourcePath)
    .rotate()
    .resize(target.width, target.height, { fit: 'cover', position: 'attention' })
    .png({ compressionLevel: 9 })
    .toFile(outPath)
  return outPath
}

// --- Provider 契约 --------------------------------------------------------
// 每个 provider 实现 async load(args) -> rawManifest
//   { episode_id, title, description, video_path, cover_3x4_src, cover_4x3_src }
// 路径可以是相对（相对 data/）或绝对。

const providers = {
  async db(args) {
    const reference = args.episodeReference || args.reference
    if (!reference) fail('db provider 需要 episode id/URL（例如 833 或 /dharma/episode/833）', 2)
    const { loadEpisodeFromDb } = await import('../publish-episode-reference.mjs')
    return loadEpisodeFromDb(reference, {
      dbPath: process.env.DB_PATH || path.join(PROJECT_ROOT, 'data/huobao_drama.db'),
      projectRoot: PROJECT_ROOT,
      title: args.title,
    })
  },
}

// --- 主流程 ---------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv)
  if (args.package) {
    const source = resolveManifestPath(args.package)
    const manifest = JSON.parse(fs.readFileSync(source, 'utf8'))
    await validateHistoryManifest(manifest)
    const outPath = path.resolve(args.out || path.join(PROJECT_ROOT, 'data/publish-manifests',
      `wechat-history-${manifest.history_source_id}-${historyManifestFingerprint(manifest).slice(0, 16)}.json`))
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2))
    emit({ ok: true, manifest_path: outPath, session: manifest.session, title: manifest.title,
      description_len: manifest.description.length, source_type: manifest.source_type })
    return
  }
  const provider = providers[args.provider]
  if (!provider) fail(`未知 provider: ${args.provider}（可用: ${Object.keys(providers).join(', ')}）`, 2)

  const raw = await provider(args)

  // 校验必填
  if (!raw.video_path) fail('缺少视频，无法发布', 2)
  if (!raw.cover_3x4_src) fail(`缺少 3:4 封面。请先生成封面：curl -X POST http://localhost:3013/api/v1/episodes/${raw.episode_id}/generate-covers -H "Content-Type: application/json" -d '{}'`, 2)
  if (!raw.cover_4x3_src) fail(`缺少 4:3 封面。请先生成封面：curl -X POST http://localhost:3013/api/v1/episodes/${raw.episode_id}/generate-covers -H "Content-Type: application/json" -d '{"frame_type":"4:3"}'`, 2)
  const historyDelivery = raw.source_type === 'history_script'
  const title = historyDelivery ? normalizeVideoTitle(raw.title || '') : raw.title
  if (!historyDelivery && !raw.opening_hook) fail('数据库缺少 opening_hook，无法生成社交平台描述', 2)
  if (!historyDelivery && !raw.cliffhanger) fail('数据库缺少 cliffhanger，无法生成社交平台描述', 2)
  if (historyDelivery && !raw.description) fail('脚本素材缺少发布简介，请在脚本页面填写', 2)
  if (historyDelivery && (!title || title.length > 16)) fail('视频号标题须为 1 至 16 字，请在脚本页面修改发布标题或使用 --title；不会自动截断', 2)
  if (historyDelivery && !hasSupportedVideoTitleSymbols(title)) fail(VIDEO_TITLE_SYMBOL_RULE, 2)

  // 解析绝对路径 + 校验文件存在
  const videoPath = toAbsPath(raw.video_path)
  if (!fs.existsSync(videoPath)) fail(`视频文件不存在: ${videoPath}`, 2)
  const cover3x4Src = toAbsPath(raw.cover_3x4_src)
  const cover4x3Src = toAbsPath(raw.cover_4x3_src)
  if (!fs.existsSync(cover3x4Src)) fail(`3:4 封面不存在: ${cover3x4Src}`, 2)
  if (!fs.existsSync(cover4x3Src)) fail(`4:3 封面不存在: ${cover4x3Src}`, 2)

  // 校正封面比例（视频号要求严格 3:4 / 4:3）
  const cover3x4Path = await ensureAspectRatio(cover3x4Src, '3:4', historyDelivery)
  const cover4x3Path = await ensureAspectRatio(cover4x3Src, '4:3', historyDelivery)

  const sourceKey = historyDelivery ? `history-${raw.history_source_id}` : raw.episode_id
  const manifest = {
    platform: 'wechat_channels',
    provider: args.provider,
    ...(historyDelivery ? { source_type: 'history_delivery', history_source_id: raw.history_source_id, script_sha256: raw.script_sha256 } : { episode_id: raw.episode_id }),
    session: `wechat-${sourceKey}`,
    title,
    opening_hook: raw.opening_hook,
    cliffhanger: raw.cliffhanger,
    description: raw.description,
    video_path: videoPath,
    cover_3x4_path: cover3x4Path,
    cover_4x3_path: cover4x3Path,
    prepared_at: new Date().toISOString(),
  }

  const outDir = path.join(PROJECT_ROOT, 'data/publish-manifests')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = args.out || path.join(outDir, `wechat-${sourceKey}.json`)
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2))

  emit({ ok: true, manifest_path: outPath, session: manifest.session, title: manifest.title, description_len: manifest.description.length })
}

main().catch((err) => fail(err.message, err.exitCode || 1))
