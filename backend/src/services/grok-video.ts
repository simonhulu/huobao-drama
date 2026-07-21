/**
 * Grok 视频素材层（egaki / grok-imagine-video）
 * 成本策略：只有开头和重要场景才生成视频；素材按 年代/场景/事件 打标签入 video_assets 库，
 * 后续镜头（含其他剧集）先查库复用，命中即零成本。
 * 生成结果写回 storyboards.gridCells 的 video 字段，渲染时替换该镜的静态格画面。
 */
import { eq } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { designVideoShot } from './shot-design.js'
import { buildEgakiChildEnv } from './egaki-chatgpt-image.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')
const EGAKI_BIN = path.join(repoRoot, 'backend/node_modules/.bin/egaki')
const VIDEO_DIR = path.join(repoRoot, 'data/static/videos')

const DEFAULT_T2V_MODEL = 'grok-imagine-video'
const DEFAULT_I2V_MODEL = 'grok-imagine-video-1.5'
const MIN_GROK_DURATION_SEC = 6
const MAX_GROK_DURATION_SEC = 10
const GENERATE_TIMEOUT_MS = 10 * 60_000 // egaki 官方建议自动化调用至少 5 分钟

export interface VideoTags {
  era?: string
  scene?: string
  event?: string
  mood?: string
}

export interface EpisodeVideoOptions {
  storyboardIds: number[]
  tags?: VideoTags
  durationSec?: number
  resolution?: string
  mode?: 't2v' | 'i2v'
  force?: boolean
}

type ProgressFn = (current: number, total: number, message: string) => void

function summarizeGenerationError(error: unknown, maxLength: number): string {
  const message = String((error as any)?.message || error)
  if (message.length <= maxLength) return message
  const headLength = Math.min(180, Math.floor(maxLength * 0.2))
  const marker = '\n...\n'
  return `${message.slice(0, headLength)}${marker}${message.slice(-(maxLength - headLength - marker.length))}`
}

function resolveStaticPath(rel: string): string {
  if (rel.startsWith('static/')) return path.join(repoRoot, 'data', rel)
  return rel.startsWith('/') ? rel : path.join(repoRoot, 'data', rel)
}

function resolveNarrationDurationSec(sb: { narrationAudioUrl?: string | null; duration?: number | null }): number {
  const audioRel = sb.narrationAudioUrl ? String(sb.narrationAudioUrl) : ''
  const titlesPath = audioRel ? `${resolveStaticPath(audioRel)}.titles.json` : ''
  try {
    if (titlesPath && fs.existsSync(titlesPath)) {
      const parsed = JSON.parse(fs.readFileSync(titlesPath, 'utf8'))
      const titles = Array.isArray(parsed?.titles) ? parsed.titles : []
      if (titles.length) {
        const beginMs = Math.min(...titles.map((title: any) => Number(title.time_begin ?? 0)))
        const endMs = Math.max(...titles.map((title: any) => Number(title.time_end ?? 0)))
        if (endMs > beginMs) return (endMs - beginMs) / 1000
      }
      const audioLengthMs = Number(parsed?.extra?.audio_length)
      if (audioLengthMs > 0) return audioLengthMs / 1000
    }
  } catch {
    /* fall through to storyboard duration */
  }
  return Number(sb.duration || MIN_GROK_DURATION_SEC)
}

export function fitGrokVideoDurationSec(narrationDurationSec: number, requestedDurationSec?: number): number {
  const required = Math.max(narrationDurationSec, requestedDurationSec || 0)
  if (required > MAX_GROK_DURATION_SEC) {
    throw new Error(`narration requires ${required.toFixed(2)}s but Grok is capped at ${MAX_GROK_DURATION_SEC}s; split the storyboard first`)
  }
  return Math.max(MIN_GROK_DURATION_SEC, Math.ceil(required))
}

/** 复用匹配：年代+场景+事件 全中 > 年代+场景 > 年代。要求成片状态且文件还在。 */
export function findReusableVideoAsset(
  tags: VideoTags,
  requirements: { durationSec?: number; resolution?: string; aspectRatio?: string } = {},
): typeof schema.videoAssets.$inferSelect | null {
  const era = (tags.era || '').trim()
  const scene = (tags.scene || '').trim()
  const event = (tags.event || '').trim()
  if (!era) return null
  const rows = db
    .select()
    .from(schema.videoAssets)
    .where(eq(schema.videoAssets.status, 'completed'))
    .all()
    .filter((r) => r.localPath && fs.existsSync(resolveStaticPath(String(r.localPath))))
    .filter((r) => String(r.era || '') === era)
    .filter((r) => !requirements.durationSec || Number(r.durationSec || 0) >= requirements.durationSec)
    .filter((r) => !requirements.resolution || String(r.resolution || '') === requirements.resolution)
    .filter((r) => !requirements.aspectRatio || String(r.aspectRatio || '') === requirements.aspectRatio)

  const scored = rows
    .map((r) => {
      let score = 1 // 年代命中
      if (scene && String(r.sceneTag || '') === scene) score += 2
      if (event && String(r.eventTag || '') === event) score += 4
      return { r, score }
    })
    // 要求至少 年代+场景 才复用，仅年代相同不复用（太泛，容易文不对题）
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score || (a.r.useCount || 0) - (b.r.useCount || 0) || a.r.id - b.r.id)
  return scored[0]?.r ?? null
}

/** 视频提示词：叙事内容 + 运镜/质感约束（画面零文字是硬约束） */
export function buildVideoPrompt(theme: string, cells: any[], narration: string): string {
  const beats = cells.map((c: any) => String(c.description || '')).filter(Boolean)
  return [
    `历史纪录片镜头：${theme || narration.slice(0, 60)}`,
    beats.length ? `画面内容：${beats.join('；')}` : '',
    '缓慢电影感运镜，史诗氛围，写实质感，自然光影，细节丰富',
    '画面中不要出现任何文字、字幕、水印',
  ]
    .filter(Boolean)
    .join('。')
}

export function parseStoryboardGrid(raw: string | null | undefined): {
  theme: string
  displayTitle?: string
  styleProfile?: string
  look?: Record<string, unknown>
  cells: any[]
  video?: any
} | null {
  try {
    const parsed = raw ? JSON.parse(raw) : null
    return [1, 2].includes(parsed?.cells?.length) ? parsed : null
  } catch {
    return null
  }
}

async function runEgakiVideo(opts: {
  model: string
  prompt: string
  output: string
  durationSec: number
  resolution: string
  aspectRatio: string
  inputImage?: string
}): Promise<void> {
  const args = [
    'video',
    opts.prompt,
    '-m', opts.model,
    '--duration', String(opts.durationSec),
    '--resolution', opts.resolution,
    '--aspect-ratio', opts.aspectRatio,
    '-o', opts.output,
    ...(opts.inputImage ? ['-i', opts.inputImage] : []),
  ]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(EGAKI_BIN, args, {
      env: buildEgakiChildEnv(process.env),
      timeout: GENERATE_TIMEOUT_MS,
    })
    let tail = ''
    child.stdout.on('data', (d) => {
      tail = (tail + String(d)).slice(-8000)
    })
    child.stderr.on('data', (d) => {
      tail = (tail + String(d)).slice(-8000)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0 && fs.existsSync(opts.output)) resolve()
      else reject(new Error(`egaki video exit ${code}: ${tail.slice(-4000)}`))
    })
  })
}

function writeGridVideo(sbId: number, grid: any, video: { src: string; assetId: number; reused: boolean }) {
  db.update(schema.storyboards)
    .set({ gridCells: JSON.stringify({ ...grid, video }), updatedAt: now() })
    .where(eq(schema.storyboards.id, sbId))
    .run()
}

export async function generateEpisodeVideos(
  episodeId: number,
  opts: EpisodeVideoOptions,
  onProgress?: ProgressFn,
): Promise<{
  planned: number
  generated: number
  reused: number
  skipped: number
  failed: Array<{ storyboardId: number; error: string }>
  items: Array<{ storyboardId: number; storyboardNumber: number; src: string; assetId: number; reused: boolean }>
}> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()
  fs.mkdirSync(VIDEO_DIR, { recursive: true })

  const resolution = opts.resolution || '720p'
  const mode = opts.mode || 'i2v'
  const model = mode === 'i2v' ? DEFAULT_I2V_MODEL : DEFAULT_T2V_MODEL
  const tags = opts.tags || {}

  const storyboards = db
    .select()
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter((sb) => opts.storyboardIds.includes(sb.id))

  let generated = 0
  let reused = 0
  let skipped = 0
  const failed: Array<{ storyboardId: number; error: string }> = []
  const items: Array<{ storyboardId: number; storyboardNumber: number; src: string; assetId: number; reused: boolean }> = []

  for (let i = 0; i < storyboards.length; i++) {
    const sb = storyboards[i]
    const grid = parseStoryboardGrid(sb.gridCells)
    if (!grid) {
      failed.push({ storyboardId: sb.id, error: 'no grid cells' })
      continue
    }
    if (grid.video?.src && !opts.force) {
      skipped++
      continue
    }

    let durationSec: number
    try {
      durationSec = fitGrokVideoDurationSec(resolveNarrationDurationSec(sb), opts.durationSec)
    } catch (error: any) {
      failed.push({ storyboardId: sb.id, error: String(error?.message || error) })
      onProgress?.(i + 1, storyboards.length, `跳过 sb${sb.storyboardNumber}：旁白超过 Grok 时长上限`)
      continue
    }

    // 1) 先查素材库复用。时长不足的素材不可复用，否则渲染时会循环穿帮。
    if (!opts.force) {
      const hit = findReusableVideoAsset(tags, { durationSec, resolution, aspectRatio: '16:9' })
      if (hit) {
        db.update(schema.videoAssets)
          .set({ useCount: (hit.useCount || 0) + 1, lastUsedAt: now(), updatedAt: now() })
          .where(eq(schema.videoAssets.id, hit.id))
          .run()
        const src = String(hit.localPath)
        writeGridVideo(sb.id, grid, { src, assetId: hit.id, reused: true })
        reused++
        items.push({ storyboardId: sb.id, storyboardNumber: sb.storyboardNumber, src, assetId: hit.id, reused: true })
        onProgress?.(i + 1, storyboards.length, `复用素材库 sb${sb.storyboardNumber}（asset#${hit.id}）`)
        continue
      }
    }

    // 2) 库里没有 → 镜头设计 + egaki 生成
    onProgress?.(i + 1, storyboards.length, `镜头设计中 sb${sb.storyboardNumber}「${sb.title || ''}」`)
    const approvedPrompt = String(sb.videoPrompt || '').trim()
    const designed = approvedPrompt
      ? null
      : await designVideoShot({
          theme: grid.theme || String(sb.title || ''),
          narration: String(sb.narration || sb.description || ''),
          cellDescriptions: grid.cells.map((c: any) => String(c.description || '')).filter(Boolean),
          dramaTitle: String(drama?.title || ''),
        })
    const prompt = approvedPrompt || designed?.prompt || buildVideoPrompt(
      grid.theme || String(sb.title || ''),
      grid.cells,
      String(sb.narration || sb.description || ''),
    )
    const sourceImage = mode === 'i2v' && grid.cells[0]?.src ? String(grid.cells[0].src) : undefined
    const productionDesign = approvedPrompt
      ? {
          schemaVersion: 1,
          promptSource: 'storyboard.video_prompt',
          storyboardId: sb.id,
          storyboardNumber: sb.storyboardNumber,
          narration: String(sb.narration || sb.description || ''),
          theme: grid.theme || String(sb.title || ''),
          styleProfile: grid.styleProfile || null,
          look: grid.look || null,
          firstFrame: sourceImage || null,
        }
      : designed?.design

    onProgress?.(i + 1, storyboards.length, `Grok 生成中 sb${sb.storyboardNumber}「${sb.title || ''}」（${durationSec}s）`)
    const ts = now()
    const insert = db
      .insert(schema.videoAssets)
      .values({
        dramaId: ep.dramaId,
        episodeId,
        storyboardId: sb.id,
        prompt,
        model,
        provider: 'xai-oauth',
        mode,
        sourceImage: sourceImage || null,
        era: tags.era || '',
        sceneTag: tags.scene || '',
        eventTag: tags.event || '',
        mood: tags.mood || '',
        durationSec,
        resolution,
        aspectRatio: '16:9',
        status: 'pending',
        designJson: productionDesign ? JSON.stringify(productionDesign) : null,
        refsJson: sourceImage
          ? JSON.stringify([{ kind: 'storyboard_first_frame', src: sourceImage }])
          : designed
            ? JSON.stringify(designed.refs)
            : null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run()
    const assetId = Number(insert.lastInsertRowid)
    const fileName = `asset-${assetId}.mp4`
    const absOut = path.join(VIDEO_DIR, fileName)
    const relOut = `static/videos/${fileName}`

    try {
      const inputImage = sourceImage ? resolveStaticPath(sourceImage) : undefined
      const [asset] = db.select().from(schema.videoAssets).where(eq(schema.videoAssets.id, assetId)).all()
      await runEgakiVideo({
        model,
        prompt: String(asset.prompt),
        output: absOut,
        durationSec,
        resolution,
        aspectRatio: '16:9',
        inputImage,
      })
      db.update(schema.videoAssets)
        .set({ localPath: relOut, status: 'completed', useCount: 1, lastUsedAt: now(), updatedAt: now() })
        .where(eq(schema.videoAssets.id, assetId))
        .run()
      writeGridVideo(sb.id, grid, { src: relOut, assetId, reused: false })
      generated++
      items.push({ storyboardId: sb.id, storyboardNumber: sb.storyboardNumber, src: relOut, assetId, reused: false })
    } catch (e: any) {
      const errorMessage = summarizeGenerationError(e, 3000)
      db.update(schema.videoAssets)
        .set({ status: 'failed', errorMsg: errorMessage, updatedAt: now() })
        .where(eq(schema.videoAssets.id, assetId))
        .run()
      failed.push({ storyboardId: sb.id, error: summarizeGenerationError(e, 1200) })
    }
  }

  onProgress?.(storyboards.length, storyboards.length, `视频层完成 生成${generated} 复用${reused} 跳过${skipped} 失败${failed.length}`)
  return {
    planned: storyboards.length,
    generated,
    reused,
    skipped,
    failed,
    items,
  }
}
