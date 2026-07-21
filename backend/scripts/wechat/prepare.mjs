#!/usr/bin/env node
/**
 * 阶段 1 · 数据准备
 *
 *   node run-tsx.mjs scripts/wechat/prepare.mjs --provider db --episode 436
 *   （或用 tsx / node，见 SKILL.md）
 *
 * 职责：拿到"要上传什么"，产出一个已校验的 manifest JSON，供后面的 operate 阶段消费。
 * 数据来源通过 --provider 切换（可插拔）。目前实现 db provider；
 * 以后加 file / api provider 只需实现同一个 load() 契约，后续阶段完全不用改。
 *
 * 输出文件：data/publish-manifests/wechat-<episode>.json
 * 同时把 manifest 打到 stdout（一行 JSON）。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import Database from 'better-sqlite3'
import { PROJECT_ROOT, COVER_TARGETS, emit, fail } from './lib.mjs'

// --- 参数解析 -------------------------------------------------------------
function parseArgs(argv) {
  const args = { provider: 'db' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--provider') args.provider = argv[++i]
    else if (a === '--episode') args.episode = Number(argv[++i])
    else if (a === '--title') args.title = argv[++i]
    else if (a === '--out') args.out = argv[++i]
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

async function ensureAspectRatio(sourcePath, ratio) {
  const target = COVER_TARGETS[ratio]
  const meta = await sharp(sourcePath).metadata()
  if (!meta.width || !meta.height) throw new Error(`无法读取封面尺寸: ${sourcePath}`)
  const actual = meta.width / meta.height
  const wanted = target.width / target.height
  if (Math.abs(actual - wanted) / wanted <= 0.01) return sourcePath // 已符合

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
    if (!args.episode) fail('db provider 需要 --episode <id>', 2)
    const dbPath = process.env.DB_PATH || path.join(PROJECT_ROOT, 'data/huobao_drama.db')
    const db = new Database(dbPath, { readonly: true, timeout: 30000 })
    try {
      const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(args.episode)
      if (!ep) fail(`episode ${args.episode} 不存在`, 2)
      const title = args.title || ep.video_title || ep.title || `第${ep.episode_number}集`
      // 作品描述 = 开头钩子 + 结尾悬念，绝不做 AI 创作
      const description = [ep.opening_hook, ep.cliffhanger]
        .map((s) => (s || '').trim())
        .filter(Boolean)
        .join('\n\n')
      return {
        episode_id: ep.id,
        title,
        description,
        video_path: ep.video_url,
        cover_3x4_src: ep.cover_image_3x4_url,
        cover_4x3_src: ep.cover_image_4x3_url,
      }
    } finally {
      db.close()
    }
  },
}

// --- 主流程 ---------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv)
  const provider = providers[args.provider]
  if (!provider) fail(`未知 provider: ${args.provider}（可用: ${Object.keys(providers).join(', ')}）`, 2)

  const raw = await provider(args)

  // 校验必填
  if (!raw.video_path) fail('缺少视频，无法发布', 2)
  if (!raw.cover_3x4_src) fail('缺少 3:4 封面', 2)
  if (!raw.cover_4x3_src) fail('缺少 4:3 封面', 2)
  if (!raw.description) fail('缺少作品描述（开头钩子+结尾悬念都为空）', 2)

  // 解析绝对路径 + 校验文件存在
  const videoPath = toAbsPath(raw.video_path)
  if (!fs.existsSync(videoPath)) fail(`视频文件不存在: ${videoPath}`, 2)
  const cover3x4Src = toAbsPath(raw.cover_3x4_src)
  const cover4x3Src = toAbsPath(raw.cover_4x3_src)
  if (!fs.existsSync(cover3x4Src)) fail(`3:4 封面不存在: ${cover3x4Src}`, 2)
  if (!fs.existsSync(cover4x3Src)) fail(`4:3 封面不存在: ${cover4x3Src}`, 2)

  // 校正封面比例（视频号要求严格 3:4 / 4:3）
  const cover3x4Path = await ensureAspectRatio(cover3x4Src, '3:4')
  const cover4x3Path = await ensureAspectRatio(cover4x3Src, '4:3')

  const manifest = {
    platform: 'wechat_channels',
    provider: args.provider,
    episode_id: raw.episode_id,
    session: `wechat-${raw.episode_id}`,
    title: raw.title,
    description: raw.description,
    video_path: videoPath,
    cover_3x4_path: cover3x4Path,
    cover_4x3_path: cover4x3Path,
    prepared_at: new Date().toISOString(),
  }

  const outDir = path.join(PROJECT_ROOT, 'data/publish-manifests')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = args.out || path.join(outDir, `wechat-${raw.episode_id}.json`)
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2))

  emit({ ok: true, manifest_path: outPath, session: manifest.session, title: manifest.title, description_len: manifest.description.length })
}

main().catch((err) => fail(err.message, 1))
