#!/usr/bin/env node
/**
 * 抖音 · 阶段 1 · 数据准备
 *   node scripts/douyin/prepare.mjs --provider db --episode 436
 *
 * 产出已校验的 manifest，供 operate 消费。数据源可插拔（--provider）。
 * 描述 = opening_hook + cliffhanger（绝不 AI 创作）。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import Database from 'better-sqlite3'
import { PROJECT_ROOT, COVER_TARGETS, emit, fail } from './lib.mjs'

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

function toAbsPath(rel) {
  if (!rel) return rel
  if (path.isAbsolute(rel)) return rel
  const cleaned = rel.replace(/^\/+/, '')
  if (cleaned.startsWith('data/')) return path.join(PROJECT_ROOT, cleaned)
  return path.join(PROJECT_ROOT, 'data', cleaned)
}

async function ensureAspectRatio(sourcePath, ratio) {
  const target = COVER_TARGETS[ratio]
  const meta = await sharp(sourcePath).metadata()
  if (!meta.width || !meta.height) throw new Error(`无法读取封面尺寸: ${sourcePath}`)
  const actual = meta.width / meta.height
  const wanted = target.width / target.height
  if (Math.abs(actual - wanted) / wanted <= 0.01) return sourcePath
  const outDir = path.join(PROJECT_ROOT, 'data/temp/douyin-covers/normalized')
  fs.mkdirSync(outDir, { recursive: true })
  const base = path.basename(sourcePath).replace(/\.[^.]+$/, '')
  const outPath = path.join(outDir, `${base}-${ratio.replace(':', 'x')}.png`)
  await sharp(sourcePath).rotate().resize(target.width, target.height, { fit: 'cover', position: 'centre' }).png().toFile(outPath)
  return outPath
}

const providers = {
  async db(args) {
    if (!args.episode) fail('db provider 需要 --episode <id>', 2)
    const dbPath = process.env.DB_PATH || path.join(PROJECT_ROOT, 'data/huobao_drama.db')
    const db = new Database(dbPath, { readonly: true, timeout: 30000 })
    try {
      const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(args.episode)
      if (!ep) fail(`episode ${args.episode} 不存在`, 2)
      const title = args.title || ep.video_title || ep.title || `第${ep.episode_number}集`
      const description = [ep.opening_hook, ep.cliffhanger].map((s) => (s || '').trim()).filter(Boolean).join('\n\n')
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

async function main() {
  const args = parseArgs(process.argv)
  const provider = providers[args.provider]
  if (!provider) fail(`未知 provider: ${args.provider}（可用: ${Object.keys(providers).join(', ')}）`, 2)

  const raw = await provider(args)
  if (!raw.video_path) fail('缺少视频', 2)
  if (!raw.cover_3x4_src) fail('缺少 3:4 封面', 2)
  if (!raw.cover_4x3_src) fail('缺少 4:3 封面', 2)
  if (!raw.description) fail('缺少作品描述（opening_hook+cliffhanger 都为空）', 2)

  const videoPath = toAbsPath(raw.video_path)
  if (!fs.existsSync(videoPath)) fail(`视频文件不存在: ${videoPath}`, 2)
  const cover3x4Src = toAbsPath(raw.cover_3x4_src)
  const cover4x3Src = toAbsPath(raw.cover_4x3_src)
  if (!fs.existsSync(cover3x4Src)) fail(`3:4 封面不存在: ${cover3x4Src}`, 2)
  if (!fs.existsSync(cover4x3Src)) fail(`4:3 封面不存在: ${cover4x3Src}`, 2)

  const cover3x4Path = await ensureAspectRatio(cover3x4Src, '3:4')
  const cover4x3Path = await ensureAspectRatio(cover4x3Src, '4:3')

  const manifest = {
    platform: 'douyin',
    provider: args.provider,
    episode_id: raw.episode_id,
    session: `douyin-${raw.episode_id}`,
    title: raw.title,
    description: raw.description,
    video_path: videoPath,
    cover_3x4_path: cover3x4Path,
    cover_4x3_path: cover4x3Path,
    prepared_at: new Date().toISOString(),
  }
  const outDir = path.join(PROJECT_ROOT, 'data/publish-manifests')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = args.out || path.join(outDir, `douyin-${raw.episode_id}.json`)
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2))
  emit({ ok: true, manifest_path: outPath, session: manifest.session, title: manifest.title, description_len: manifest.description.length })
}

main().catch((err) => fail(err.message, 1))
