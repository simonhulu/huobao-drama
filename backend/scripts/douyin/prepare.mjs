#!/usr/bin/env node
/**
 * 抖音 · 阶段 1 · 数据准备
 *   node scripts/douyin/prepare.mjs 436
 *   node scripts/douyin/prepare.mjs "http://localhost:3013/drama/93/episode/3"
 *
 * 产出已校验的 manifest，供 operate 消费。数据源可插拔（--provider，默认 db）。
 * 描述 = opening_hook + cliffhanger（绝不 AI 创作）。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { PROJECT_ROOT, COVER_TARGETS, emit, fail } from './lib.mjs'
import { loadEpisodeFromDb } from '../publish-episode-reference.mjs'

function parseArgs(argv) {
  const args = { provider: 'db' }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--provider') args.provider = argv[++i]
    else if (a === '--episode') args.episodeReference = argv[++i]
    else if (a === '--title') args.title = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (!a.startsWith('--') && !args.reference) args.reference = a
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
    const reference = args.episodeReference || args.reference
    if (!reference) fail('db provider 需要 episode id/URL（例如 833 或 /dharma/episode/833）', 2)
    return loadEpisodeFromDb(reference, {
      dbPath: process.env.DB_PATH || path.join(PROJECT_ROOT, 'data/huobao_drama.db'),
      projectRoot: PROJECT_ROOT,
      title: args.title,
    })
  },
}

async function main() {
  const args = parseArgs(process.argv)
  const provider = providers[args.provider]
  if (!provider) fail(`未知 provider: ${args.provider}（可用: ${Object.keys(providers).join(', ')}）`, 2)

  const raw = await provider(args)
  if (!raw.video_path) fail('缺少视频', 2)
  if (!raw.cover_3x4_src) fail(`缺少 3:4 封面。请先生成封面：curl -X POST http://localhost:3013/api/v1/episodes/${raw.episode_id}/generate-covers -H "Content-Type: application/json" -d '{}'`, 2)
  if (!raw.cover_4x3_src) fail(`缺少 4:3 封面。请先生成封面：curl -X POST http://localhost:3013/api/v1/episodes/${raw.episode_id}/generate-covers -H "Content-Type: application/json" -d '{"frame_type":"4:3"}'`, 2)
  if (!raw.opening_hook) fail('数据库缺少 opening_hook，无法生成社交平台描述', 2)
  if (!raw.cliffhanger) fail('数据库缺少 cliffhanger，无法生成社交平台描述', 2)

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
  const outPath = args.out || path.join(outDir, `douyin-${raw.episode_id}.json`)
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2))
  emit({ ok: true, manifest_path: outPath, session: manifest.session, title: manifest.title, description_len: manifest.description.length })
}

main().catch((err) => fail(err.message, err.exitCode || 1))
