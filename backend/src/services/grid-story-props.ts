/**
 * GridStoryPreview 渲染参数构建（生产版）
 * 从 storyboards.gridCells 读取每镜单张画面 + 运镜 + 过场 + 文字层，
 * 拷贝素材到 remotion/public/grid-ep{id}/，输出 GridStoryPreview props JSON。
 */
import { and, eq } from 'drizzle-orm'
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
  /** 分句字幕未能在主时间轴精确定位、回退为 Beat 窗口内均分的镜头数 */
  subtitleFallbacks?: number
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
  muted?: boolean
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

  const muted = raw?.muted === false ? false : undefined

  if (raw?.mode !== 'cutaway') {
    return {
      src,
      ...(sourceStartFrame === undefined ? {} : { sourceStartFrame }),
      ...(scale === undefined ? {} : { scale }),
      ...(focusX === undefined ? {} : { focusX }),
      ...(focusY === undefined ? {} : { focusY }),
      ...(grade === undefined ? {} : { grade }),
      ...(muted === false ? { muted: false } : {}),
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
    ...(muted === false ? { muted: false } : {}),
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

// ---- 分句字幕：按标点切分旁白 ----
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

function normLen(s?: string | null): string {
  return (s || '').replace(/\s+/g, '')
}

// ---- v8 权威时序：storyboard -> storyboard_panels(sb-{id}) -> visual_beats 窗口 ----
// 旁白主音轨、镜头起止、字幕全部从同一份 MiniMax titles 对齐结果派生，构造上零漂移。
// 严禁按字数比例重猜镜头时长（历史 bug：画面/字幕平均落后旁白 2.7s、峰值 8s）。
export interface BeatWindow {
  startMs: number
  endMs: number
}

/** 兼容 `sb-{storyboardId}` 与多 Panel 的 `sb-{storyboardId}-p{panelIndex}` */
export function parsePanelStoryboardId(panelKey: string): number | null {
  const m = /^sb-(\d+)(?:-p\d+)?$/.exec(panelKey)
  return m ? Number(m[1]) : null
}

/**
 * 把 panel+beat 行合并为 storyboardId -> Beat 窗口（同一 Shot 多 Panel 取 min/max）。
 * 任何无法解析的 key 或无效窗口都直接抛错——渲染时序不允许降级估算。
 */
export function mergeBeatWindows(
  rows: Array<{ panelKey: string; startMs: number | null; endMs: number | null }>,
): Map<number, BeatWindow> {
  const map = new Map<number, BeatWindow>()
  for (const row of rows) {
    const storyboardId = parsePanelStoryboardId(row.panelKey)
    if (storyboardId === null) {
      throw new Error(`无法识别的 panel_key「${row.panelKey}」，期望 sb-{storyboardId}[-pN]`)
    }
    if (row.startMs == null || row.endMs == null || !(row.endMs > row.startMs)) {
      throw new Error(`panel ${row.panelKey} 的 Beat 窗口无效（${row.startMs}→${row.endMs}ms）；先重新导入叙事层级对齐 titles`)
    }
    const prev = map.get(storyboardId)
    map.set(storyboardId, prev
      ? { startMs: Math.min(prev.startMs, row.startMs), endMs: Math.max(prev.endMs, row.endMs) }
      : { startMs: row.startMs, endMs: row.endMs })
  }
  return map
}

export function resolveBeatTimingMap(episodeId: number): Map<number, BeatWindow> {
  const [plan] = db
    .select()
    .from(schema.narrativePlans)
    .where(and(eq(schema.narrativePlans.episodeId, episodeId), eq(schema.narrativePlans.kind, 'full')))
    .all()
  if (!plan) {
    throw new Error(`Episode ${episodeId} 缺少 kind='full' 叙事计划，无法解析权威时序；先完成叙事设计导入`)
  }
  const rows = db
    .select({
      panelKey: schema.storyboardPanels.panelKey,
      startMs: schema.visualBeats.startMs,
      endMs: schema.visualBeats.endMs,
    })
    .from(schema.storyboardPanels)
    .innerJoin(schema.visualBeats, eq(schema.storyboardPanels.beatId, schema.visualBeats.id))
    .where(eq(schema.storyboardPanels.planId, plan.id))
    .all()
  try {
    return mergeBeatWindows(rows)
  } catch (err) {
    throw new Error(`plan ${plan.id} 时序解析失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---- 整集旁白主时间轴（preTtsTitlesJson）：字符位置 -> 绝对秒 ----
export interface MasterSpan {
  charStart: number
  charEnd: number
  beginSec: number
  endSec: number
}

export interface MasterTimeline {
  stream: string
  spans: MasterSpan[]
}

export function buildMasterTimeline(masterTitlesJson?: string | null): MasterTimeline | null {
  if (!masterTitlesJson) return null
  let parsed: any = null
  try {
    parsed = JSON.parse(masterTitlesJson)
  } catch {
    return null
  }
  const titles: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.titles) ? parsed.titles : []
  let stream = ''
  const spans: MasterSpan[] = []
  for (const t of titles) {
    const text = normLen(t?.text)
    const beginSec = Number(t?.time_begin ?? 0) / 1000
    const endSec = Number(t?.time_end ?? 0) / 1000
    if (!text || !(endSec > beginSec)) continue
    spans.push({ charStart: stream.length, charEnd: stream.length + text.length, beginSec, endSec })
    stream += text
  }
  return spans.length ? { stream, spans } : null
}

export function masterTimeAt(timeline: MasterTimeline, pos: number): number {
  if (pos <= 0) return timeline.spans[0].beginSec
  for (const span of timeline.spans) {
    if (pos < span.charEnd) {
      const ratio = (pos - span.charStart) / (span.charEnd - span.charStart)
      return span.beginSec + ratio * (span.endSec - span.beginSec)
    }
  }
  return timeline.spans[timeline.spans.length - 1].endSec
}

/** 在主时间轴上顺序定位本镜旁白的字符区间（游标前移，防止重复文本串位） */
export function locateNarrationWindow(
  timeline: MasterTimeline,
  narration: string,
  cursor: number,
): { start: number; end: number; cursor: number } | null {
  if (!narration) return null
  const probe12 = narration.slice(0, Math.min(12, narration.length))
  const probe8 = narration.slice(0, Math.min(8, narration.length))
  let idx = timeline.stream.indexOf(probe12, cursor)
  if (idx < 0) idx = timeline.stream.indexOf(probe8, cursor)
  if (idx < 0) idx = timeline.stream.indexOf(probe8)
  if (idx < 0) return null
  return { start: idx, end: idx + narration.length, cursor: idx + narration.length }
}

/** 分句字幕：字符区间在主时间轴上插值出绝对秒，再减去镜头起点转为镜内相对时间 */
export function buildMasterSubtitleClauses(
  narration: string,
  window: { start: number; end: number },
  timeline: MasterTimeline,
  shotStartSec: number,
): SubtitleClause[] | null {
  const clauses = splitNarrationToClauses(narration)
  if (!clauses.length) return null
  let offset = 0
  const out: SubtitleClause[] = []
  for (const text of clauses) {
    const charStart = window.start + offset
    const charEnd = Math.min(charStart + text.length, timeline.stream.length)
    out.push({
      text,
      startSec: Math.max(0, masterTimeAt(timeline, charStart) - shotStartSec),
      endSec: Math.max(0, masterTimeAt(timeline, charEnd) - shotStartSec),
    })
    offset += text.length
  }
  return out
}

/** 兜底：旁白在主时间轴定位失败时，在本镜 Beat 窗口内按字数均分（窗口两端仍精确锚定） */
export function buildWindowSubtitleClauses(narration: string, shotDurationSec: number): SubtitleClause[] | null {
  const clauses = splitNarrationToClauses(narration)
  if (clauses.length <= 1) return null
  const totalChars = clauses.reduce((a, c) => a + c.length, 0)
  if (!totalChars) return null
  let cursor = 0
  return clauses.map((text) => {
    const dur = (text.length / totalChars) * shotDurationSec
    const clause = { text, startSec: cursor, endSec: cursor + dur }
    cursor += dur
    return clause
  })
}

export function resolveStoryboardNarration(sb: { narration?: string | null; description?: string | null }): string {
  return String(sb.narration || sb.description || '').replace(/\s+/g, '')
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

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()

  const publicDir = path.join(repoRoot, 'remotion/public/grid-ep' + episodeId)
  fs.mkdirSync(path.join(publicDir, 'audio'), { recursive: true })

  // v8 时间线契约：整集挂载唯一 narration master，不逐镜切片。
  let episodeAudio = ''
  const masterAudioRel = ep?.preTtsAudioUrl ? String(ep.preTtsAudioUrl) : ''
  if (masterAudioRel) {
    const masterAbs = resolveStaticPath(masterAudioRel)
    if (fs.existsSync(masterAbs)) {
      const ext = path.extname(masterAudioRel) || '.mp3'
      const masterName = `master_narration${ext}`
      fs.copyFileSync(masterAbs, path.join(publicDir, 'audio', masterName))
      episodeAudio = `grid-ep${episodeId}/audio/${masterName}`
    }
  }

  const fps = 30
  const shots: any[] = []
  const skipped: number[] = []

  // v8 时间线契约（硬门禁）：每镜起止必须来自 Beat 权威窗口
  // （storyboard_panels(sb-{id}) -> visual_beats.start_ms/end_ms），与旁白主音轨同源。
  // 严禁按字数比例反推或回退 storyboard.duration（历史 bug：画面/字幕平均落后旁白 2.7s）。
  const beatTiming = resolveBeatTimingMap(episodeId)
  const missingTiming = storyboards.filter((sb) => !beatTiming.has(sb.id)).map((sb) => sb.storyboardNumber)
  if (missingTiming.length) {
    throw new Error(
      `有 ${missingTiming.length} 个分镜缺少 Beat 权威时序（#${missingTiming.join(', #')}），` +
      `禁止估算渲染。请先完成叙事设计导入（grid.episode_design / narrative-hierarchy/import）`,
    )
  }
  const masterTimeline = buildMasterTimeline(ep?.preTtsTitlesJson)

  // 逐镜绝对帧窗；pilot 预算只保留完整落入预算的镜头（不裁断旁白）
  const budgetFrames = Number.isFinite(opts.maxDurationSec) && Number(opts.maxDurationSec) > 0
    ? Math.max(1, Math.round(Number(opts.maxDurationSec) * fps))
    : null
  const shotWindows = storyboards.map((sb) => {
    const win = beatTiming.get(sb.id)!
    const absStartFrame = Math.round((win.startMs / 1000) * fps)
    const absEndFrame = Math.max(absStartFrame + 1, Math.round((win.endMs / 1000) * fps))
    return { absStartFrame, absEndFrame }
  })

  let narrationCursor = 0
  let subtitleFallbacks = 0

  for (let storyboardIndex = 0; storyboardIndex < storyboards.length; storyboardIndex++) {
    const sb = storyboards[storyboardIndex]
    const { absStartFrame, absEndFrame } = shotWindows[storyboardIndex]
    if (budgetFrames !== null && absEndFrame > budgetFrames) break
    const shotDurationInFrames = absEndFrame - absStartFrame
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
    const shotStartSec = absStartFrame / fps
    let subtitles: SubtitleClause[] | null = null
    if (narration && masterTimeline) {
      const located = locateNarrationWindow(masterTimeline, narration, narrationCursor)
      if (located) {
        narrationCursor = located.cursor
        subtitles = buildMasterSubtitleClauses(narration, located, masterTimeline, shotStartSec)
      }
    }
    if (!subtitles && narration) {
      subtitles = buildWindowSubtitleClauses(narration, shotDurationInFrames / fps)
      if (subtitles) subtitleFallbacks += 1
    }

    shots.push({
      title: parsed.displayTitle || sb.title || `镜头${sb.storyboardNumber}`,
      narration,
      audio,
      cells,
      ...(video ? { video } : {}),
      ...(subtitles ? { subtitles } : {}),
      durationInFrames: shotDurationInFrames,
      absStartFrame,
    })
  }

  // 显影签名：仅全片第一镜第一格
  if (shots.length) shots[0].cells[0].enter = 'reveal'

  // 绝对帧位：以首个镜头的绝对起点为渲染 0 帧（子集渲染时主音轨用 startFrom 同步裁剪）。
  // 镜头按 startFrame 绝对挂载，不再累计堆叠——单镜缺图被跳过也不会压缩后续时间轴。
  const audioStartFrame = shots.length ? shots[0].absStartFrame : 0
  for (const shot of shots) {
    shot.startFrame = shot.absStartFrame - audioStartFrame
    delete shot.absStartFrame
  }
  // 时序门禁：帧窗必须单调不减（Beat 窗口连续铺设时天然满足）
  for (let i = 1; i < shots.length; i++) {
    const prevEnd = shots[i - 1].startFrame + shots[i - 1].durationInFrames
    if (shots[i].startFrame < prevEnd - 1) {
      throw new Error(
        `镜头帧窗重叠/乱序（第 ${i} 镜起始于 ${shots[i].startFrame}，前一镜结束于 ${prevEnd}），叙事层级时序损坏`,
      )
    }
  }
  const durationInFrames = shots.reduce((a, s) => Math.max(a, s.startFrame + s.durationInFrames), 0)
  const propsDir = getAbsolutePath('temp')
  fs.mkdirSync(propsDir, { recursive: true })
  const suffix = Number.isFinite(opts.maxDurationSec) && Number(opts.maxDurationSec) > 0
    ? `-pilot-${Math.round(Number(opts.maxDurationSec))}s`
    : ''
  const propsPath = path.join(propsDir, `grid-story-props-${episodeId}${suffix}.json`)
  fs.writeFileSync(
    propsPath,
    JSON.stringify(
      {
        durationInFrames,
        shots,
        ...(episodeAudio ? { audio: episodeAudio } : {}),
        ...(audioStartFrame > 0 ? { audioStartFrame } : {}),
      },
      null,
      2,
    ),
  )

  return { propsPath, shotCount: shots.length, durationInFrames, skippedStoryboards: skipped, subtitleFallbacks }
}
