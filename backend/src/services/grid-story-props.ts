/**
 * GridStoryPreview 渲染参数构建（生产版）
 * 从 storyboards.gridCells 读取每镜单张画面 + 运镜 + 过场 + 文字层，
 * 拷贝素材到 remotion/public/grid-ep{id}/，输出 GridStoryPreview props JSON。
 */
import { eq } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

interface GridStoryBuildResult {
  propsPath: string
  shotCount: number
  durationInFrames: number
  skippedStoryboards: number[]
}

interface IdentityRevealSfx {
  paper?: string
  click?: string
}

export interface GridStoryBuildOptions {
  onlyStoryboardIds?: number[]
  maxDurationSec?: number
}

export interface GridStoryVideoRenderConfig {
  src: string
  mode?: 'full' | 'cutaway'
  startFrame?: number
  durationInFrames?: number
  sourceStartFrame?: number
  scale?: number
  focusX?: number
  focusY?: number
  grade?: 'neutral' | 'period_warm' | 'documentary_muted' | 'night_muted'
  transitionFrames?: number
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(max, Math.max(min, parsed))
}

export function normalizeGridVideo(
  raw: any,
  shotDurationInFrames: number,
  fps = 30,
): GridStoryVideoRenderConfig | null {
  const src = raw?.src ? String(raw.src) : ''
  if (!src) return null

  const sourceStartSec = clampNumber(raw?.sourceStartSec, 0, 60 * 60)
  const sourceStartFrame = sourceStartSec === undefined ? undefined : Math.round(sourceStartSec * fps)
  const scale = clampNumber(raw?.scale, 1, 1.8)
  const focusX = clampNumber(raw?.focusX, 0, 100)
  const focusY = clampNumber(raw?.focusY, 0, 100)
  const grade = ['neutral', 'period_warm', 'documentary_muted', 'night_muted'].includes(String(raw?.grade))
    ? raw.grade as GridStoryVideoRenderConfig['grade']
    : undefined

  if (raw?.mode !== 'cutaway') {
    return {
      src,
      ...(sourceStartFrame === undefined ? {} : { sourceStartFrame }),
      ...(scale === undefined ? {} : { scale }),
      ...(focusX === undefined ? {} : { focusX }),
      ...(focusY === undefined ? {} : { focusY }),
      ...(grade === undefined ? {} : { grade }),
    }
  }

  const wholeShot = Math.max(1, Math.round(shotDurationInFrames))
  const requestedStartSec = clampNumber(raw?.startSec, 0, wholeShot / fps) ?? 0
  const startFrame = Math.min(wholeShot - 1, Math.max(0, Math.round(requestedStartSec * fps)))
  const availableFrames = wholeShot - startFrame
  const requestedDurationSec = clampNumber(raw?.durationSec, 1 / fps, availableFrames / fps)
  const durationInFrames = requestedDurationSec === undefined
    ? availableFrames
    : Math.min(availableFrames, Math.max(1, Math.round(requestedDurationSec * fps)))
  const transitionFrames = Math.round(clampNumber(raw?.transitionFrames, 0, 15) ?? 8)

  return {
    src,
    mode: 'cutaway',
    startFrame,
    durationInFrames,
    ...(sourceStartFrame === undefined ? {} : { sourceStartFrame }),
    ...(scale === undefined ? {} : { scale }),
    ...(focusX === undefined ? {} : { focusX }),
    ...(focusY === undefined ? {} : { focusY }),
    ...(grade === undefined ? {} : { grade }),
    transitionFrames,
  }
}

export function areStoryboardNumbersContiguous(numbers: number[]): boolean {
  const ordered = [...new Set(numbers)].sort((a, b) => a - b)
  return ordered.every((number, index) => index === 0 || number === ordered[index - 1] + 1)
}

export function fitShotFramesToBudget(
  shotFrames: number[],
  maxDurationSec: number | undefined,
  fps = 30,
): number[] {
  if (!Number.isFinite(maxDurationSec) || Number(maxDurationSec) <= 0) return shotFrames
  let remaining = Math.max(1, Math.round(Number(maxDurationSec) * fps))
  const fitted: number[] = []
  for (const frames of shotFrames) {
    const wholeShot = Math.max(1, frames)
    if (wholeShot > remaining) break
    fitted.push(wholeShot)
    remaining -= wholeShot
  }
  return fitted
}

function resolveStaticPath(rel: string): string {
  // 约定：DB 里存的是 'static/xxx'，实际文件在 data/static/xxx
  if (rel.startsWith('static/')) return path.join(repoRoot, 'data', rel)
  return rel.startsWith('/') ? rel : path.join(repoRoot, 'data', rel)
}

function ensureIdentityRevealSfx(): IdentityRevealSfx | undefined {
  const sharedDir = path.join(repoRoot, 'remotion/public/grid-shared')
  const sources = {
    paper: path.join(repoRoot, 'data/sfx/library/rpg-sounds/OGG/bookFlip2.mp3'),
    click: path.join(repoRoot, 'data/sfx/library/rpg-sounds/OGG/metalClick.mp3'),
  }
  const copied: IdentityRevealSfx = {}
  for (const [key, source] of Object.entries(sources) as Array<[keyof IdentityRevealSfx, string]>) {
    if (!fs.existsSync(source)) continue
    fs.mkdirSync(sharedDir, { recursive: true })
    const fileName = key === 'paper' ? 'evidence-paper.mp3' : 'evidence-pen-stop.mp3'
    fs.copyFileSync(source, path.join(sharedDir, fileName))
    copied[key] = `grid-shared/${fileName}`
  }
  return copied.paper || copied.click ? copied : undefined
}

// ---- 分句字幕：按标点切分旁白，按字数比例分配到音频时长 ----
interface SubtitleClause {
  text: string
  startSec: number
  endSec: number
}

function splitNarrationToClauses(text: string): string[] {
  const parts = text
    .split(/(?<=[，。！？；：、])/u)
    .map((s) => s.trim())
    .filter(Boolean)
  const merged: string[] = []
  for (const p of parts) {
    if (merged.length && (p.length <= 3 || merged[merged.length - 1].length <= 3)) {
      merged[merged.length - 1] += p
    } else {
      merged.push(p)
    }
  }
  return merged
}

function loadAudioWindowMs(audioRel: string): { beginMs: number; endMs: number } | null {
  const titlesPath = resolveStaticPath(audioRel) + '.titles.json'
  try {
    if (!fs.existsSync(titlesPath)) return null
    const raw = JSON.parse(fs.readFileSync(titlesPath, 'utf8'))
    const titles = raw?.titles
    if (Array.isArray(titles) && titles.length) {
      const beginMs = Math.min(...titles.map((t: any) => Number(t.time_begin ?? 0)))
      const endMs = Math.max(...titles.map((t: any) => Number(t.time_end ?? 0)))
      if (endMs > beginMs) return { beginMs, endMs }
    }
    const len = Number(raw?.extra?.audio_length)
    if (len > 0) return { beginMs: 0, endMs: len }
  } catch {
    /* fallthrough */
  }
  return null
}

function resolveStoryboardDurationSec(sb: { narrationAudioUrl?: string | null; duration?: number | null }): number {
  const audioRel = sb.narrationAudioUrl ? String(sb.narrationAudioUrl) : ''
  const win = audioRel ? loadAudioWindowMs(audioRel) : null
  return win ? (win.endMs - win.beginMs) / 1000 : Number(sb.duration || 8)
}

export function resolveStoryboardNarration(sb: { narration?: string | null; description?: string | null }): string {
  return String(sb.narration || sb.description || '').replace(/\s+/g, '')
}

function buildSubtitleClauses(narration: string, audioRel: string, fallbackDurationSec: number): SubtitleClause[] | null {
  const clauses = splitNarrationToClauses(narration)
  if (clauses.length <= 1) return null
  const win = loadAudioWindowMs(audioRel)
  const totalSec = win ? (win.endMs - win.beginMs) / 1000 : fallbackDurationSec
  const beginSec = win ? win.beginMs / 1000 : 0
  const totalChars = clauses.reduce((a, c) => a + c.length, 0)
  if (!totalChars) return null
  let cursor = beginSec
  return clauses.map((text) => {
    const dur = (text.length / totalChars) * totalSec
    const clause = { text, startSec: cursor, endSec: cursor + dur }
    cursor += dur
    return clause
  })
}

export function buildGridStoryProps(
  episodeId: number,
  opts: GridStoryBuildOptions = {},
): GridStoryBuildResult {
  const selectedIds = opts.onlyStoryboardIds?.length ? new Set(opts.onlyStoryboardIds) : null
  const storyboards = db
    .select()
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter((sb) => !selectedIds || selectedIds.has(sb.id))

  const publicDir = path.join(repoRoot, 'remotion/public/grid-ep' + episodeId)
  fs.mkdirSync(path.join(publicDir, 'audio'), { recursive: true })

  const fps = 30
  const shots: any[] = []
  const skipped: number[] = []

  const frameBudget = fitShotFramesToBudget(
    storyboards.map((sb) => Math.max(60, Math.round(resolveStoryboardDurationSec(sb) * fps))),
    opts.maxDurationSec,
    fps,
  )

  for (let storyboardIndex = 0; storyboardIndex < storyboards.length; storyboardIndex++) {
    const sb = storyboards[storyboardIndex]
    const shotDurationInFrames = frameBudget[storyboardIndex]
    if (!shotDurationInFrames) break
    let parsed: { theme: string; displayTitle?: string; cells: any[]; video?: any } | null = null
    try {
      const raw = sb.gridCells ? JSON.parse(sb.gridCells) : null
      if ([1, 2].includes(raw?.cells?.length)) parsed = raw
    } catch {
      /* ignore */
    }
    if (!parsed || parsed.cells.some((c: any) => !c.src)) {
      skipped.push(sb.storyboardNumber)
      continue
    }

    const cells = parsed.cells.map((c: any, i: number) => {
      const relSrc = String(c.src)
      const fileName = `sb${sb.storyboardNumber}_cell${i + 1}.png`
      const abs = resolveStaticPath(relSrc)
      if (fs.existsSync(abs)) {
        fs.copyFileSync(abs, path.join(publicDir, fileName))
      }
      const identitySfx = c.graphic?.type === 'identity_reveal' && c.graphic?.alias
        ? ensureIdentityRevealSfx()
        : undefined
      return {
        src: `grid-ep${episodeId}/${fileName}`,
        move: c.move || 'push',
        enter: c.enter || 'cut',
        ...(c.enterFrames ? { enterFrames: c.enterFrames } : {}),
        ...(c.graphic ? { graphic: c.graphic } : {}),
        ...(identitySfx ? { sfx: identitySfx } : {}),
      }
    })

    let audio = ''
    const audioRel = sb.narrationAudioUrl ? String(sb.narrationAudioUrl) : ''
    if (audioRel) {
      const abs = resolveStaticPath(audioRel)
      if (fs.existsSync(abs)) {
        const name = `sb${sb.storyboardNumber}.m4a`
        fs.copyFileSync(abs, path.join(publicDir, 'audio', name))
        audio = `grid-ep${episodeId}/audio/${name}`
      }
    }

    // 本地视频镜头（Grok/素材库/档案）：gridCells.video.src 存在则替换静态格画面。
    let video: GridStoryVideoRenderConfig | null = null
    const normalizedVideo = normalizeGridVideo(parsed.video, shotDurationInFrames, fps)
    if (normalizedVideo) {
      const abs = resolveStaticPath(normalizedVideo.src)
      if (fs.existsSync(abs)) {
        fs.mkdirSync(path.join(publicDir, 'video'), { recursive: true })
        const name = `sb${sb.storyboardNumber}.mp4`
        fs.copyFileSync(abs, path.join(publicDir, 'video', name))
        video = { ...normalizedVideo, src: `grid-ep${episodeId}/video/${name}` }
      }
    }

    const narration = resolveStoryboardNarration(sb)
    const subtitles = narration && audioRel ? buildSubtitleClauses(narration, audioRel, sb.duration || 8) : null

    shots.push({
      title: parsed.displayTitle || sb.title || `镜头${sb.storyboardNumber}`,
      narration,
      audio,
      cells,
      ...(video ? { video } : {}),
      ...(subtitles ? { subtitles } : {}),
      durationInFrames: shotDurationInFrames,
    })
  }

  // 显影签名：仅全片第一镜第一格
  if (shots.length) shots[0].cells[0].enter = 'reveal'

  const durationInFrames = shots.reduce((a, s) => a + s.durationInFrames, 0)
  const propsDir = getAbsolutePath('temp')
  fs.mkdirSync(propsDir, { recursive: true })
  const suffix = Number.isFinite(opts.maxDurationSec) && Number(opts.maxDurationSec) > 0
    ? `-pilot-${Math.round(Number(opts.maxDurationSec))}s`
    : ''
  const propsPath = path.join(propsDir, `grid-story-props-${episodeId}${suffix}.json`)
  fs.writeFileSync(propsPath, JSON.stringify({ durationInFrames, shots }, null, 2))

  return { propsPath, shotCount: shots.length, durationInFrames, skippedStoryboards: skipped }
}
