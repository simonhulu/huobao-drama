/**
 * DharmaEpisode 渲染参数构建（佛学/哲学口播管线）。
 *
 * 与 grid-story-props（历史叙事管线）的根本差异：
 *  - 画面有两种职责：AI 叙事插画直接证明旁白命题，动态视频只承担空间与情绪衔接。
 *  - 视觉单元是「段落」而非「镜头」：连续使用同一素材、情绪、风格和运镜的相邻分镜
 *    合并为一个段落；同一生成任务的连续 AI 图只启动一次 Ken Burns。
 *  - BGM 是单轨固定循环，在 Remotion 内混音（props.bgm），不再走 ffmpeg 后混。
 *
 * 时序契约与 v8 相同且更严格：每个分镜的绝对起止都从 preTtsTitlesJson 主时间轴
 * 顺序定位（locateNarrationWindow），定位失败直接抛错——禁止按字数比例估算，
 * 不存在降级路径（历史教训：字数估算导致画面/字幕平均落后旁白 2.7s）。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import {
  ensureDharmaDeliveryProxy,
  type DharmaDeliveryProxyResult,
} from './dharma-delivery-proxy.js'
import {
  areStoryboardNumbersContiguous,
  buildMasterTimeline,
  buildMasterSubtitleClauses,
  buildWindowSubtitleClauses,
  locateNarrationWindow,
  masterTimeAt,
  resolveStoryboardNarration,
  type MasterTimeline,
} from './grid-story-props.js'
import {
  selectDharmaCanaryWindow,
  type DharmaCanaryWindow,
  type DharmaCanaryWindowCandidate,
} from './dharma-production-gate.js'
import {
  DHARMA_EMOTIONAL_INK_STYLE_ID,
  DHARMA_EMOTIONS,
  DHARMA_MINIMAL_LIGHT_STYLE_ID,
  DHARMA_SURREAL_DREAM_STYLE_ID,
  findDharmaImageStyle,
  normalizeDharmaEmotion,
  validateDharmaStyleEmotion,
  type DharmaEmotion,
  type DharmaImageMove,
} from './dharma-image-style.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

const FPS = 30
/** Changes only when pixels/audio semantics change and therefore invalidates review evidence. */
export const DHARMA_RENDERER_CONTRACT_VERSION = 'emotion-arc-v5'
export const DHARMA_FULL_PLAN_VALIDATOR_VERSION = 'dharma-full-plan-v5'
/** Must stay aligned with DharmaEpisode's maximum visual crossfade lead. */
export const DHARMA_CROSSFADE_FRAMES = 24

/** 素材慢放下限：片段时长/段落时长低于此值直接失败（换更长素材），禁止硬循环。 */
export const MIN_PLAYBACK_RATE = 0.6
/** BGM 最短时长（秒）：过短的循环在禅意内容里听感明显。 */
export const MIN_BGM_DURATION_SEC = 180
/** The only preview duration that may be manually approved for full delivery. */
export const DHARMA_REVIEW_PILOT_DURATION_SEC = 60
/** AAC priming can make an MP4 container report a few milliseconds beyond the exact video frame duration. */
export const DHARMA_REVIEW_PILOT_CONTAINER_DURATION_TOLERANCE_SEC = 0.1
/** Central quote cards stay readable only when authors keep the teaching phrase concise. */
export const DHARMA_QUOTE_MAX_CHARACTERS = 36
/** Full delivery must stay predominantly inside the sacred teaching-room visual world. */
export const DHARMA_MIN_SACRED_VISUAL_COVERAGE_RATIO = 0.6
/** A nature-only opening may set the hook, but sacred space must arrive promptly. */
export const DHARMA_EARLY_SACRED_ROLE_DEADLINE_MS = 25_000
export const DHARMA_EARLY_VISUAL_WINDOW_MS = 60_000
/** AI stills are key emotional shots, not the entire film and not a rare fallback. */
export const DHARMA_MIN_GENERATED_IMAGE_COVERAGE_RATIO = 0.35
export const DHARMA_MAX_GENERATED_IMAGE_COVERAGE_RATIO = 0.65
/** The 14-20 key-image target applies once an episode reaches eight minutes. */
export const DHARMA_KEY_IMAGE_REFERENCE_DURATION_MS = 8 * 60 * 1000
export const DHARMA_KEY_IMAGE_REFERENCE_MIN_SEGMENTS = 14
export const DHARMA_KEY_IMAGE_REFERENCE_MAX_SEGMENTS = 20
/** No single still may carry more than a quarter of the whole emotional arc. */
export const DHARMA_MAX_SINGLE_GENERATED_IMAGE_COVERAGE_RATIO = 0.25
/** Long-form stills remain deliberate shots rather than static wallpaper. */
export const DHARMA_MAX_GENERATED_IMAGE_SEGMENT_DURATION_MS = 30_000
/** A hybrid plan still needs some genuine internal motion between generated keyframes. */
export const DHARMA_MIN_VIDEO_COVERAGE_RATIO = 0.1
/** BGM 在旁白之外相对人声的目标响度差。旁白期间还会继续闪避。 */
export const DHARMA_BGM_NARRATION_GAP_LU = 14
/** 旁白正在说话时的 BGM 增益，约等于再降低 6 dB。 */
export const DHARMA_BGM_SPEECH_DUCK_GAIN = 0.5
/** Above this would mean the source is too quiet to be a reliable long-form bed. */
export const DHARMA_BGM_MAX_VOLUME = 0.5
/** Loudnorm scans the entire input; keep a bad media file from holding a worker indefinitely. */
export const DHARMA_AUDIO_LOUDNESS_PROBE_MAX_RUNTIME_MS = 2 * 60 * 1000
/** ffprobe should only read container metadata; a damaged file must not freeze request handling. */
export const DHARMA_MEDIA_DURATION_PROBE_MAX_RUNTIME_MS = 15 * 1000
const MAX_DHARMA_AUDIO_LOUDNESS_CACHE_ENTRIES = 64

export function isDharmaReviewPilotDuration(value: unknown): boolean {
  return Number.isFinite(Number(value))
    && Math.abs(Number(value) - DHARMA_REVIEW_PILOT_DURATION_SEC) < 0.001
}

/**
 * Container timing may include a tiny AAC muxing offset, but a review pilot
 * still has to describe exactly sixty rendered seconds at the video frame
 * boundary. A task can request 60 seconds and still accidentally publish a
 * shorter composition, so this must be separate from the payload check.
 */
export function isDharmaReviewPilotOutputDuration(value: unknown): boolean {
  return Number.isFinite(Number(value))
    && Math.abs(Number(value) - DHARMA_REVIEW_PILOT_DURATION_SEC) <= DHARMA_REVIEW_PILOT_CONTAINER_DURATION_TOLERANCE_SEC
}

export interface DharmaBuildOptions {
  onlyStoryboardIds?: number[]
  maxDurationSec?: number
  validationMode?: 'production' | 'semantic_preview'
  signal?: AbortSignal
  deliveryProxyConcurrency?: number
  onDeliveryProxy?: (result: DharmaDeliveryProxyResult, elapsedMs: number) => void
  compiledPlan?: DharmaCompiledProductionPlan
}

/**
 * A duration cap still has the complete episode plan available for review.
 * Only a storyboard subset lacks the whole-plan context needed for the
 * sacred-space coverage gate.
 */
export function requiresDharmaProductionVisualPlan(options: DharmaBuildOptions): boolean {
  return !options.onlyStoryboardIds?.length
}

export interface DharmaBuildResult {
  propsPath: string
  segmentCount: number
  quoteCount: number
  durationInFrames: number
  /** 分句字幕未能在主时间轴精确定位、回退为分镜窗口内均分的分镜数 */
  subtitleFallbacks: number
  bgm: DharmaBgmMix
  deliveryProxy: DharmaDeliveryProxySummary
}

export interface DharmaRenderTimingWindow {
  startMs: number
  endMs: number
}

/**
 * A duration-capped preview ends narration at the final complete TTS title
 * before the requested boundary. A storyboard may span many TTS titles, so
 * dropping the whole crossing storyboard would create a long silent tail.
 * The final image continues to `visualTailEndMs` for a short BGM breath.
 */
export function scopeDharmaTimingWindowsToDuration<T extends DharmaRenderTimingWindow>(
  windows: T[],
  maxDurationSec?: number,
  timeline?: MasterTimeline | null,
): { windows: T[]; durationInFrames?: number; visualTailEndMs?: number } {
  const requestedDurationSec = Number(maxDurationSec)
  if (!Number.isFinite(requestedDurationSec) || requestedDurationSec <= 0) return { windows }
  const durationInFrames = Math.max(1, Math.round(requestedDurationSec * FPS))
  if (!windows.length) return { windows, durationInFrames }

  const startMs = windows[0].startMs
  const visualTailEndMs = startMs + (durationInFrames / FPS) * 1000
  const finalCompleteSpan = timeline?.spans
    .filter((span) => span.endSec * 1000 > startMs && span.endSec * 1000 <= visualTailEndMs)
    .at(-1)
  if (finalCompleteSpan) {
    const narrationEndMs = Math.round(finalCompleteSpan.endSec * 1000)
    const scoped = windows
      .filter((window) => window.startMs < narrationEndMs)
      .map((window) => {
        if (window.endMs <= narrationEndMs) return window
        const record = window as T & {
          charStart?: unknown
          charEnd?: unknown
          narration?: unknown
        }
        if (!Number.isInteger(record.charStart)
          || !Number.isInteger(record.charEnd)
          || typeof record.narration !== 'string') {
          return { ...window, endMs: narrationEndMs }
        }
        const charStart = Number(record.charStart)
        const charEnd = Math.min(Number(record.charEnd), finalCompleteSpan.charEnd)
        return {
          ...window,
          endMs: narrationEndMs,
          charEnd,
          narration: record.narration.slice(0, Math.max(0, charEnd - charStart)),
        }
      }) as T[]
    return { windows: scoped, durationInFrames, visualTailEndMs }
  }
  return {
    windows: windows
      .filter((window) => window.startMs >= startMs && window.endMs <= visualTailEndMs),
    durationInFrames,
    visualTailEndMs,
  }
}

const DHARMA_QUOTE_LEAD_MS = 450
const DHARMA_QUOTE_HOLD_MS = 1_600

/** Locate an on-screen quote against the exact spoken phrase on the master timeline. */
export function resolveDharmaQuoteTimingWindow(
  timing: Pick<StoryboardTiming, 'narration' | 'charStart' | 'charEnd' | 'startMs' | 'endMs'>,
  quoteText: string,
  timeline: MasterTimeline,
): { startMs: number; endMs: number } | null {
  const normalizedQuote = quoteText.replace(/\s+/g, '')
  if (!normalizedQuote) return null
  const localStart = timing.narration.indexOf(normalizedQuote)
  if (localStart < 0) return null
  const quoteCharStart = timing.charStart + localStart
  const quoteCharEnd = quoteCharStart + normalizedQuote.length
  if (quoteCharEnd > timing.charEnd) return null
  const spokenStartMs = Math.round(masterTimeAt(timeline, quoteCharStart) * 1000)
  const spokenEndMs = Math.round(masterTimeAt(timeline, quoteCharEnd) * 1000)
  const startMs = Math.max(timing.startMs, spokenStartMs - DHARMA_QUOTE_LEAD_MS)
  const endMs = Math.min(timing.endMs, spokenEndMs + DHARMA_QUOTE_HOLD_MS)
  return endMs > startMs ? { startMs, endMs } : null
}

export interface DharmaDeliveryProxySummary {
  /** Sources already at or below the 1280x720 delivery canvas. */
  source: number
  /** Oversized sources served from the validated proxy cache. */
  cacheHits: number
  /** Oversized sources transcoded during this props build. */
  created: number
  elapsedMs: number
}

export interface DharmaAudioLoudness {
  integratedLufs: number
  truePeakDb: number
  loudnessRangeLu: number
}

export interface DharmaBgmMix {
  volume: number
  narrationVolume: number
  fadeInSec: number
  fadeOutSec: number
  loopCrossfadeSec: number
  sourceDurationSec: number
  targetLufs: number
  narrationLufs: number
  bgmLufs: number
}

export const DHARMA_VISUAL_ROLES = [
  'temple_interior',
  'ritual',
  'temple_exterior',
  'contemplative_nature',
  'human_relationship',
] as const

export type DharmaVisualRole = typeof DHARMA_VISUAL_ROLES[number]

export const DHARMA_SHOT_FUNCTIONS = [
  'narrative_illustration',
  'atmosphere_bridge',
] as const

export type DharmaShotFunction = typeof DHARMA_SHOT_FUNCTIONS[number]

export interface DharmaNarrativeSemanticPlan {
  subjectCount: number
  subjects: string
  relationship: string
  action: string
  visibleEmotion: string
  visualEvidence: string
}

const DHARMA_VISUAL_ROLE_SET = new Set<string>(DHARMA_VISUAL_ROLES)
const DHARMA_SHOT_FUNCTION_SET = new Set<string>(DHARMA_SHOT_FUNCTIONS)
const DHARMA_SEMANTIC_TEXT_MAX_LENGTH = 240

const DHARMA_VISUAL_ROLE_GENERATION_PROMPTS: Record<DharmaVisualRole, string> = {
  temple_interior: 'Spatial anchor: an authentic silent Chinese Buddhist teaching room with restrained timber, meditation cushions, sutra or incense detail, and no tourist spectacle',
  ritual: 'Spatial anchor: a restrained Buddhist ritual detail inside a quiet temple, such as incense, sutra pages, lamp light, prayer beads, or a distant practitioner, never a staged religious poster',
  temple_exterior: 'Spatial anchor: an authentic Chinese temple courtyard, covered corridor, bell tower, or mountain gate with sparse human presence and contemplative scale',
  contemplative_nature: 'Spatial anchor: an East Asian landscape used only as a breathing interval, quiet and spacious, with no modern park, traffic, resort, or postcard spectacle',
  human_relationship: 'Spatial anchor: a specific East Asian human relationship scene in an authentic lived-in home or teaching space. People, distance, gesture, and interaction are the primary visual content; never replace them with an empty temple, landscape, or symbolic still life',
}

export function buildDharmaVisualRoleGenerationPrompt(role: DharmaVisualRole): string {
  return DHARMA_VISUAL_ROLE_GENERATION_PROMPTS[role]
}

/**
 * `theme` remains free-form review copy. `role` is deliberately controlled so
 * a valid local file cannot be labelled as sacred only in prose.
 */
export function normalizeDharmaVisualRole(value: unknown): { role: DharmaVisualRole } | { error: string } {
  if (typeof value !== 'string' || !DHARMA_VISUAL_ROLE_SET.has(value)) {
    return { error: `视觉角色必须是 ${DHARMA_VISUAL_ROLES.join('、')} 之一` }
  }
  return { role: value as DharmaVisualRole }
}

export function isDharmaSacredVisualRole(role: DharmaVisualRole): boolean {
  return role === 'temple_interior' || role === 'ritual' || role === 'temple_exterior'
}

export function normalizeDharmaShotFunction(value: unknown): { shotFunction: DharmaShotFunction } | { error: string } {
  if (typeof value !== 'string' || !DHARMA_SHOT_FUNCTION_SET.has(value)) {
    return { error: `镜头职能必须是 ${DHARMA_SHOT_FUNCTIONS.join('、')} 之一` }
  }
  return { shotFunction: value as DharmaShotFunction }
}

function normalizeDharmaSemanticText(
  record: Record<string, unknown>,
  key: string,
  label: string,
): { value: string } | { error: string } {
  const raw = record[key]
  if (typeof raw !== 'string' || !raw.trim()) return { error: `${label}必须是非空文本` }
  const value = raw.trim()
  if (Array.from(value).length > DHARMA_SEMANTIC_TEXT_MAX_LENGTH) {
    return { error: `${label}不能超过 ${DHARMA_SEMANTIC_TEXT_MAX_LENGTH} 个字符` }
  }
  return { value }
}

export function normalizeDharmaNarrativeSemanticPlan(
  value: unknown,
): { semantic: DharmaNarrativeSemanticPlan } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '叙事插画必须提供 semantic 对象' }
  }
  const record = value as Record<string, unknown>
  const subjectCount = Number(record.subjectCount ?? record.subject_count)
  if (!Number.isInteger(subjectCount) || subjectCount < 1 || subjectCount > 8) {
    return { error: 'semantic.subject_count 必须是 1–8 的整数' }
  }
  const subjects = normalizeDharmaSemanticText(record, 'subjects', 'semantic.subjects')
  if ('error' in subjects) return subjects
  const relationship = normalizeDharmaSemanticText(record, 'relationship', 'semantic.relationship')
  if ('error' in relationship) return relationship
  const action = normalizeDharmaSemanticText(record, 'action', 'semantic.action')
  if ('error' in action) return action
  const visibleEmotion = normalizeDharmaSemanticText(
    { ...record, visibleEmotion: record.visibleEmotion ?? record.visible_emotion },
    'visibleEmotion',
    'semantic.visible_emotion',
  )
  if ('error' in visibleEmotion) return visibleEmotion
  const visualEvidence = normalizeDharmaSemanticText(
    { ...record, visualEvidence: record.visualEvidence ?? record.visual_evidence },
    'visualEvidence',
    'semantic.visual_evidence',
  )
  if ('error' in visualEvidence) return visualEvidence
  return {
    semantic: {
      subjectCount,
      subjects: subjects.value,
      relationship: relationship.value,
      action: action.value,
      visibleEmotion: visibleEmotion.value,
      visualEvidence: visualEvidence.value,
    },
  }
}

export function normalizeDharmaVisualSemanticContract(input: {
  role: DharmaVisualRole
  kind: 'image' | 'video'
  shotFunction: unknown
  semantic: unknown
}): { shotFunction?: DharmaShotFunction; semantic?: DharmaNarrativeSemanticPlan } | { error: string } {
  const hasShotFunction = input.shotFunction !== undefined && input.shotFunction !== null && input.shotFunction !== ''
  if (!hasShotFunction) {
    if (input.role === 'human_relationship') {
      return { error: 'human_relationship 必须声明 shot_function=narrative_illustration 并提供 semantic' }
    }
    if (input.semantic !== undefined && input.semantic !== null) {
      return { error: '提供 semantic 时必须同时声明 shot_function' }
    }
    return {}
  }
  const normalizedFunction = normalizeDharmaShotFunction(input.shotFunction)
  if ('error' in normalizedFunction) return normalizedFunction
  if (input.role === 'human_relationship' && normalizedFunction.shotFunction !== 'narrative_illustration') {
    return { error: 'human_relationship 只能用于 narrative_illustration' }
  }
  if (normalizedFunction.shotFunction === 'narrative_illustration') {
    if (input.kind !== 'image') return { error: 'narrative_illustration 当前只允许使用 AI 图片' }
    const semantic = normalizeDharmaNarrativeSemanticPlan(input.semantic)
    if ('error' in semantic) return semantic
    return { shotFunction: normalizedFunction.shotFunction, semantic: semantic.semantic }
  }
  if (input.semantic !== undefined && input.semantic !== null) {
    return { error: 'atmosphere_bridge 不接受 narrative semantic；请只描述空间与情绪' }
  }
  return { shotFunction: normalizedFunction.shotFunction }
}

export function buildDharmaSemanticGenerationPrompt(
  shotFunction: DharmaShotFunction | undefined,
  semantic: DharmaNarrativeSemanticPlan | undefined,
): string {
  if (shotFunction !== 'narrative_illustration' || !semantic) {
    return 'Shot function: atmosphere bridge. Let the image carry a pause or transition without pretending to explain the narration'
  }
  return [
    'Shot function: narrative illustration. Depict one specific story moment whose human meaning is readable at a glance, not generic atmosphere',
    `Intended visible people: ${semantic.subjectCount}`,
    `Subjects: ${semantic.subjects}`,
    `Relationship: ${semantic.relationship}`,
    `Visible action and blocking: ${semantic.action}`,
    `Visible emotion: ${semantic.visibleEmotion}`,
    `Mandatory visual evidence: ${semantic.visualEvidence}`,
    'The image must visibly prove the mandatory evidence. Human gesture, gaze, distance, and interaction outrank decorative symbolism. Do not substitute an empty temple, Buddha statue, incense, landscape, abstract diagram, or readable text for the people and action',
  ].join('. ')
}

export interface DharmaVisualPlanWindow {
  startMs: number
  endMs: number
  role: DharmaVisualRole
}

export interface DharmaVisualPlanSummary {
  totalCoverageMs: number
  sacredCoverageMs: number
  sacredCoverageRatio: number
  coverageMsByRole: Record<DharmaVisualRole, number>
  firstVisualStartMs: number | null
  /** Relative to the first timed visual window, never an estimated storyboard duration. */
  firstSacredStartOffsetMs: number | null
}

function emptyDharmaRoleCoverage(): Record<DharmaVisualRole, number> {
  return {
    temple_interior: 0,
    ritual: 0,
    temple_exterior: 0,
    contemplative_nature: 0,
    human_relationship: 0,
  }
}

/**
 * Summarise only TTS-located visual windows. This intentionally does not read
 * `storyboards.duration`, which is an estimate and cannot be an approval gate.
 */
export function summarizeDharmaVisualPlan(windows: DharmaVisualPlanWindow[]): DharmaVisualPlanSummary {
  const coverageMsByRole = emptyDharmaRoleCoverage()
  let totalCoverageMs = 0
  let sacredCoverageMs = 0
  let firstVisualStartMs: number | null = null
  let firstSacredStartMs: number | null = null

  for (const window of windows) {
    if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs) || window.endMs <= window.startMs) {
      throw new Error(`视觉计划时序无效（${window.startMs}→${window.endMs}ms）`)
    }
    const role = normalizeDharmaVisualRole(window.role)
    if ('error' in role) throw new Error(role.error)

    const durationMs = window.endMs - window.startMs
    coverageMsByRole[role.role] += durationMs
    totalCoverageMs += durationMs
    if (isDharmaSacredVisualRole(role.role)) {
      sacredCoverageMs += durationMs
      if (window.startMs < (firstSacredStartMs ?? Number.POSITIVE_INFINITY)) firstSacredStartMs = window.startMs
    }
    if (window.startMs < (firstVisualStartMs ?? Number.POSITIVE_INFINITY)) firstVisualStartMs = window.startMs
  }

  return {
    totalCoverageMs,
    sacredCoverageMs,
    sacredCoverageRatio: totalCoverageMs > 0 ? sacredCoverageMs / totalCoverageMs : 0,
    coverageMsByRole,
    firstVisualStartMs,
    firstSacredStartOffsetMs: firstVisualStartMs === null || firstSacredStartMs === null
      ? null
      : firstSacredStartMs - firstVisualStartMs,
  }
}

/**
 * Full deliveries need an actual sacred visual plan. Scoped previews still
 * validate each role at the input boundary, but deliberately skip this
 * episode-wide composition gate.
 */
export function validateDharmaProductionVisualPlan(windows: DharmaVisualPlanWindow[]): DharmaVisualPlanSummary {
  const summary = summarizeDharmaVisualPlan(windows)
  if (summary.totalCoverageMs <= 0) throw new Error('视觉计划没有可计算的 TTS 时序覆盖')

  const problems: string[] = []
  if (summary.sacredCoverageRatio < DHARMA_MIN_SACRED_VISUAL_COVERAGE_RATIO) {
    problems.push(
      `神圣素材覆盖率 ${(summary.sacredCoverageRatio * 100).toFixed(1)}% 低于 ${(DHARMA_MIN_SACRED_VISUAL_COVERAGE_RATIO * 100).toFixed(0)}% 下限`,
    )
  }
  const sacredStartMs = summary.firstSacredStartOffsetMs
  if (sacredStartMs === null || sacredStartMs > DHARMA_EARLY_SACRED_ROLE_DEADLINE_MS || sacredStartMs >= DHARMA_EARLY_VISUAL_WINDOW_MS) {
    problems.push(`前 ${DHARMA_EARLY_SACRED_ROLE_DEADLINE_MS / 1000}s 内必须进入 temple_interior、ritual 或 temple_exterior 画面`)
  }
  if (problems.length) throw new Error(`视觉计划不合格：${problems.join('；')}`)
  return summary
}

/** storyboards.grid_cells 里 dharma 素材指派的持久化形状（footage 路由写入）。 */
export interface DharmaCell {
  dharma: 1
  /** Required at assignment/render boundaries; optional here so legacy raw JSON can be diagnosed. */
  role?: DharmaVisualRole
  /** Emotional function is independent from the physical-space role. */
  emotion?: DharmaEmotion
  /** Production visual style applied to video treatment and image generation alike. */
  styleId?: string
  /** Semantic job of the shot. Legacy atmosphere assignments may omit it. */
  shotFunction?: DharmaShotFunction
  /** Required evidence plan for narrative_illustration. */
  semantic?: DharmaNarrativeSemanticPlan
  theme?: string
  video?: {
    src: string
    provider?: string
    videoId?: string
    sourceUrl?: string
    licenseUrl?: string
    creator?: string
    durationSec?: number
    sourceStartSec?: number
    focusX?: number
    focusY?: number
    grade?: string
  }
  image?: {
    src: string
    move?: DharmaImageMove
    /** Task-owned marker for one AI-generated still used across a contiguous review segment. */
    generatedSegmentTaskId?: number
  }
  quote?: {
    text: string
    source?: string
  }
}

/** Returns a display-safe quote or a human-readable gate error. */
export function normalizeDharmaQuoteText(value: unknown): { text: string } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: '金句必须是非空文本' }
  const text = value.trim()
  if (Array.from(text).length > DHARMA_QUOTE_MAX_CHARACTERS) {
    return { error: `金句最多 ${DHARMA_QUOTE_MAX_CHARACTERS} 个字符；请拆成一句核心教义` }
  }
  return { text }
}

export function parseDharmaCell(raw: string | null | undefined): DharmaCell | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.dharma === 1 && (parsed.video?.src || parsed.image?.src)) return parsed as DharmaCell
    return null
  } catch {
    return null
  }
}

function taskNumberArray(record: Record<string, unknown>, snakeKey: string, camelKey: string): number[] {
  const value = record[snakeKey] ?? record[camelKey]
  if (!Array.isArray(value)) return []
  return value.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0)
}

function taskNumber(record: Record<string, unknown>, snakeKey: string, camelKey: string): number | null {
  const value = Number(record[snakeKey] ?? record[camelKey])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export interface DharmaGeneratedImageOwnership {
  taskIds: ReadonlySet<number>
  generationIds: ReadonlySet<number>
}

/**
 * Prove every client-visible generated marker against durable task and image rows.
 * A number copied into grid_cells is not provenance by itself.
 */
export function validateDharmaGeneratedImageOwnership(
  episodeId: number,
  storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all(),
): DharmaGeneratedImageOwnership {
  const uses = storyboards.flatMap((storyboard) => {
    const cell = parseDharmaCell(storyboard.gridCells)
    const taskId = Number(cell?.image?.generatedSegmentTaskId)
    if (!cell?.image?.src || !Number.isSafeInteger(taskId) || taskId <= 0) return []
    return [{ storyboard, cell, taskId }]
  })
  if (!uses.length) return { taskIds: new Set(), generationIds: new Set() }

  const taskIds = [...new Set(uses.map((use) => use.taskId))]
  const taskRows = db.select().from(schema.creationTasks)
    .where(inArray(schema.creationTasks.id, taskIds))
    .all()
  const tasksById = new Map(taskRows.map((row) => [row.id, row]))
  const generationIds = taskRows
    .map((row) => taskNumber(parseDharmaMetadata(row.resultJson), 'image_generation_id', 'imageGenerationId'))
    .filter((id): id is number => id !== null)
  const generationRows = generationIds.length
    ? db.select().from(schema.imageGenerations)
      .where(inArray(schema.imageGenerations.id, [...new Set(generationIds)]))
      .all()
    : []
  const generationsById = new Map(generationRows.map((row) => [row.id, row]))
  const problems: string[] = []
  const verifiedTaskIds = new Set<number>()
  const verifiedGenerationIds = new Set<number>()

  for (const { storyboard, cell, taskId } of uses) {
    const task = tasksById.get(taskId)
    if (!task
      || task.type !== 'dharma.footage_generate'
      || task.status !== 'succeeded'
      || task.episodeId !== episodeId) {
      problems.push(`分镜 #${storyboard.storyboardNumber} 的 AI 图任务 #${taskId} 不存在、未成功或不属于本集`)
      continue
    }
    const payload = parseDharmaMetadata(task.payloadJson)
    const result = parseDharmaMetadata(task.resultJson)
    const payloadEpisodeId = taskNumber(payload, 'episode_id', 'episodeId')
    const payloadStoryboardIds = taskNumberArray(payload, 'storyboard_ids', 'storyboardIds')
    const resultStoryboardIds = taskNumberArray(result, 'storyboard_ids', 'storyboardIds')
    const generationId = taskNumber(result, 'image_generation_id', 'imageGenerationId')
    const sourceMatches = typeof result.local_path === 'string'
      && canonicalDharmaAssetKey(result.local_path) === canonicalDharmaAssetKey(cell.image!.src)
    const metadataMatches = payload.kind === 'image'
      && payloadEpisodeId === episodeId
      && payloadStoryboardIds.includes(storyboard.id)
      && resultStoryboardIds.includes(storyboard.id)
      && payload.style_id === cell.styleId
      && result.style_id === cell.styleId
      && payload.role === cell.role
      && payload.emotion === cell.emotion
      && result.role === cell.role
      && result.emotion === cell.emotion
      && result.move === (cell.image?.move ?? findDharmaImageStyle(cell.styleId)?.defaultMove)
      && payload.move === (cell.image?.move ?? findDharmaImageStyle(cell.styleId)?.defaultMove)
    const generation = generationId ? generationsById.get(generationId) : null
    const generationMatches = Boolean(generation
      && generation.status === 'completed'
      && generation.episodeId === episodeId
      && generation.imageType === 'dharma_footage'
      && generation.style === cell.styleId
      && typeof generation.localPath === 'string'
      && canonicalDharmaAssetKey(generation.localPath) === canonicalDharmaAssetKey(cell.image!.src))
    if (!sourceMatches || !metadataMatches || !generationMatches) {
      problems.push(`分镜 #${storyboard.storyboardNumber} 的 AI 图任务 #${taskId} 与素材、分镜或风格记录不一致`)
      continue
    }
    verifiedTaskIds.add(taskId)
    verifiedGenerationIds.add(generationId!)
  }

  if (problems.length) throw new Error(`AI 关键图所有权无效：${[...new Set(problems)].join('；')}`)
  return { taskIds: verifiedTaskIds, generationIds: verifiedGenerationIds }
}

function resolveStaticPath(rel: string): string {
  // 约定：DB 里存的是 'static/xxx'，实际文件在 data/static/xxx
  if (rel.startsWith('static/')) return path.join(repoRoot, 'data', rel)
  return rel.startsWith('/') ? rel : path.join(repoRoot, 'data', rel)
}

export type DharmaAssignedAssetKind = 'video' | 'image'

const DHARMA_VIDEO_ASSET_ROOTS = [
  path.join(repoRoot, 'data/static/remotion/stock'),
  path.join(repoRoot, 'data/static/videos'),
]
const DHARMA_IMAGE_ASSET_ROOTS = [
  path.join(repoRoot, 'data/static/images'),
  path.join(repoRoot, 'data/static/remotion/stock'),
]
const DHARMA_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm'])
const DHARMA_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const DHARMA_STOCK_MANIFEST_DIR = path.join(repoRoot, 'data/static/remotion/stock/manifests')

const DHARMA_GENERATED_VIDEO_ASSET_ROOT = path.join(repoRoot, 'data/static/videos')

export interface DharmaStockManifestRecord {
  provider: string
  videoId?: string
  sourceUrl: string
  licenseUrl: string
  creator: string
}

export type DharmaStockManifestIndex = ReadonlyMap<string, readonly DharmaStockManifestRecord[]>

export interface DharmaStockAsset {
  kind: DharmaAssignedAssetKind
  src: string
  url: string
  label?: string
  duration?: number
  provider?: string
  video_id?: string
  source_url?: string
  license_url?: string
  creator?: string
}

function isInsideDharmaAssetRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), candidate)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  })
}

/**
 * Footage assignments are an input boundary, not arbitrary local filenames.
 * Resolve through realpath so a symlink inside stock/ cannot publish a file
 * from elsewhere on the render host.
 */
export function resolveDharmaAssignedAssetPath(src: string, kind: DharmaAssignedAssetKind): string {
  const raw = String(src ?? '').trim()
  if (!raw || raw.includes('\0')) throw new Error('素材路径不能为空')
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.includes('\\')) {
    throw new Error(`素材路径必须是受控的 static 相对路径：${raw}`)
  }
  if (!raw.startsWith('static/') || raw.split('/').includes('..')) {
    throw new Error(`素材路径不能离开 static 目录：${raw}`)
  }
  const normalized = path.posix.normalize(raw)
  if (!normalized.startsWith('static/') || normalized === 'static') {
    throw new Error(`素材路径无效：${raw}`)
  }
  if (kind === 'video' && normalized.startsWith('static/remotion/stock/proxy/')) {
    throw new Error(`素材必须指向原始 stock 文件，不能把 delivery proxy 当作指派来源：${raw}`)
  }

  const roots = kind === 'video' ? DHARMA_VIDEO_ASSET_ROOTS : DHARMA_IMAGE_ASSET_ROOTS
  const extensions = kind === 'video' ? DHARMA_VIDEO_EXTENSIONS : DHARMA_IMAGE_EXTENSIONS
  const extension = path.extname(normalized).toLowerCase()
  if (!extensions.has(extension)) {
    throw new Error(`${kind === 'video' ? '视频' : '图片'}素材扩展名不受支持：${raw}`)
  }

  const candidate = path.resolve(repoRoot, 'data', normalized)
  let realPath: string
  try {
    realPath = fs.realpathSync.native(candidate)
  } catch {
    throw new Error(`素材文件不存在：${raw}`)
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(realPath)
  } catch {
    throw new Error(`无法读取素材文件：${raw}`)
  }
  if (!stat.isFile() || !isInsideDharmaAssetRoot(realPath, roots)) {
    throw new Error(`素材不在 Dharma 允许目录中：${raw}`)
  }
  return realPath
}

export function isDharmaAssignedAssetAvailable(src: string, kind: DharmaAssignedAssetKind): boolean {
  try {
    resolveDharmaAssignedAssetPath(src, kind)
    return true
  } catch {
    return false
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resolveManifestLocalPath(value: unknown): string | null {
  const raw = nonEmptyString(value)
  if (!raw) return null
  const candidates = path.isAbsolute(raw)
    ? [raw, path.join(repoRoot, 'data/static/remotion/stock', path.basename(raw))]
    : [path.resolve(repoRoot, raw), path.resolve(repoRoot, 'data', raw)]
  for (const candidate of candidates) {
    try {
      return fs.realpathSync.native(candidate)
    } catch {
      // Manifests can retain their old absolute workspace path after a checkout
      // move; the stock filename fallback above preserves the provenance link.
    }
  }
  return null
}

/**
 * Build a local, manifest-backed provenance index. It deliberately reads the
 * manifest files at validation time so freshly downloaded footage is usable
 * without restarting the API process.
 */
export function buildDharmaStockManifestIndex(): DharmaStockManifestIndex {
  const recordsBySource = new Map<string, DharmaStockManifestRecord[]>()
  let manifestFiles: string[] = []
  try {
    manifestFiles = fs.readdirSync(DHARMA_STOCK_MANIFEST_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    return recordsBySource
  }
  for (const filename of manifestFiles) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(DHARMA_STOCK_MANIFEST_DIR, filename), 'utf8')) as Record<string, unknown>
      const fallbackProvider = nonEmptyString(manifest.provider)
      const results = Array.isArray(manifest.results) ? manifest.results : []
      for (const value of results) {
        if (!value || typeof value !== 'object') continue
        const entry = value as Record<string, unknown>
        const sourcePath = resolveManifestLocalPath(entry.localPath)
        const provider = nonEmptyString(entry.provider) ?? fallbackProvider
        const sourceUrl = nonEmptyString(entry.sourceUrl)
        const licenseUrl = nonEmptyString(entry.licenseUrl)
        const creator = nonEmptyString(entry.creator)
        if (!sourcePath || !provider || !sourceUrl || !licenseUrl || !creator) continue
        const record: DharmaStockManifestRecord = {
          provider,
          ...(nonEmptyString(entry.videoId) ? { videoId: nonEmptyString(entry.videoId)! } : {}),
          sourceUrl,
          licenseUrl,
          creator,
        }
        const existing = recordsBySource.get(sourcePath) ?? []
        if (!existing.some((candidate) => JSON.stringify(candidate) === JSON.stringify(record))) {
          existing.push(record)
          recordsBySource.set(sourcePath, existing)
        }
      }
    } catch {
      // One corrupt manifest must not make unrelated, valid manifests unusable.
    }
  }
  return recordsBySource
}

function collectDharmaStockFiles(directory: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    if (entry.name === 'manifests' || entry.name === 'proxy') return []
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectDharmaStockFiles(candidate)
    return entry.isFile() ? [candidate] : []
  })
}

function dharmaStaticSourcePath(absolutePath: string): string | null {
  const relative = path.relative(path.join(repoRoot, 'data'), absolutePath)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

/**
 * List only stock assets that can be passed straight back to the footage
 * assignment endpoint. Videos without a manifest are intentionally excluded:
 * their local filename is not sufficient permission to ship them.
 */
export function listDharmaStockAssets(): DharmaStockAsset[] {
  const manifestIndex = buildDharmaStockManifestIndex()
  const assets: DharmaStockAsset[] = []
  for (const absolutePath of collectDharmaStockFiles(path.join(repoRoot, 'data/static/remotion/stock'))) {
    const extension = path.extname(absolutePath).toLowerCase()
    const kind = DHARMA_VIDEO_EXTENSIONS.has(extension)
      ? 'video' as const
      : DHARMA_IMAGE_EXTENSIONS.has(extension)
        ? 'image' as const
        : null
    if (!kind) continue
    const src = dharmaStaticSourcePath(absolutePath)
    if (!src) continue

    let resolvedPath: string
    try {
      resolvedPath = resolveDharmaAssignedAssetPath(src, kind)
    } catch {
      continue
    }
    const provenance = kind === 'video' ? manifestIndex.get(resolvedPath)?.[0] : null
    if (kind === 'video' && !provenance) continue
    assets.push({
      kind,
      src,
      url: `/${src}`,
      label: path.basename(src, extension),
      ...(provenance ? {
        provider: provenance.provider,
        ...(provenance.videoId ? { video_id: provenance.videoId } : {}),
        source_url: provenance.sourceUrl,
        license_url: provenance.licenseUrl,
        creator: provenance.creator,
      } : {}),
    })
  }
  return assets.sort((a, b) => a.src.localeCompare(b.src))
}

/**
 * A local filename alone is not sufficient proof that stock footage may be
 * shipped. Require the persisted fields to match a downloaded manifest entry.
 */
export function validateDharmaVideoProvenance(
  video: NonNullable<DharmaCell['video']>,
  index: DharmaStockManifestIndex = buildDharmaStockManifestIndex(),
): string | null {
  let sourcePath: string
  try {
    sourcePath = resolveDharmaAssignedAssetPath(video.src, 'video')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  if (isInsideDharmaAssetRoot(sourcePath, [DHARMA_GENERATED_VIDEO_ASSET_ROOT])) {
    const [generation] = db.select({
      provider: schema.videoGenerations.provider,
      localPath: schema.videoGenerations.localPath,
      status: schema.videoGenerations.status,
    }).from(schema.videoGenerations)
      .where(and(
        eq(schema.videoGenerations.localPath, video.src),
        eq(schema.videoGenerations.status, 'completed'),
      ))
      .all()
    if (!generation) return `AI 生成视频没有完成记录：${video.src}`
    const provider = nonEmptyString(video.provider)
    if (provider && provider !== nonEmptyString(generation.provider)) {
      return `AI 生成视频的 provider 与完成记录不匹配：${video.src}`
    }
    return null
  }

  const requiredFields: Array<[keyof Pick<NonNullable<DharmaCell['video']>, 'provider' | 'sourceUrl' | 'licenseUrl' | 'creator'>, string]> = [
    ['provider', 'provider'],
    ['sourceUrl', 'sourceUrl'],
    ['licenseUrl', 'licenseUrl'],
    ['creator', 'creator'],
  ]
  const missing = requiredFields
    .filter(([key]) => !nonEmptyString(video[key]))
    .map(([, label]) => label)
  if (missing.length) return `视频素材缺少授权证据：${missing.join(', ')}`
  const candidates = index.get(sourcePath)
  if (!candidates?.length) return `视频素材没有对应的 stock manifest 授权证据：${video.src}`

  const inputVideoId = nonEmptyString(video.videoId)
  const matches = candidates.some((candidate) => (
    candidate.provider === nonEmptyString(video.provider)
    && candidate.sourceUrl === nonEmptyString(video.sourceUrl)
    && candidate.licenseUrl === nonEmptyString(video.licenseUrl)
    && candidate.creator === nonEmptyString(video.creator)
    && (!candidate.videoId || candidate.videoId === inputVideoId)
  ))
  return matches ? null : `视频素材授权证据与 stock manifest 不匹配：${video.src}`
}

export interface DharmaPilotReview {
  status: 'rendered' | 'approved'
  output: string
  inputFingerprint: string
  taskId: number
  requestedDurationSec: number
  renderedAt: string
  approvedAt?: string
  durationSec?: number
}

export interface DharmaPilotApprovalState {
  approved: boolean
  inputFingerprint: string
  pilot: DharmaPilotReview | null
  reason?: string
}

function parseDharmaMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function getDharmaPilotReview(metadata: string | null | undefined): DharmaPilotReview | null {
  const candidate = parseDharmaMetadata(metadata).dharmaPilot
  if (!candidate || typeof candidate !== 'object') return null
  const record = candidate as Record<string, unknown>
  const taskId = Number(record.taskId)
  const requestedDurationSec = Number(record.requestedDurationSec)
  if ((record.status !== 'rendered' && record.status !== 'approved')
    || typeof record.output !== 'string'
    || typeof record.inputFingerprint !== 'string'
    || !Number.isInteger(taskId)
    || !isDharmaReviewPilotDuration(requestedDurationSec)
    || typeof record.renderedAt !== 'string') return null
  return {
    status: record.status,
    output: record.output,
    inputFingerprint: record.inputFingerprint,
    taskId,
    requestedDurationSec,
    renderedAt: record.renderedAt,
    ...(typeof record.approvedAt === 'string' ? { approvedAt: record.approvedAt } : {}),
    ...(Number.isFinite(record.durationSec) ? { durationSec: Number(record.durationSec) } : {}),
  }
}

function staticFileIdentity(rel: string | null | undefined): string | null {
  if (!rel) return null
  try {
    const realPath = fs.realpathSync.native(resolveStaticPath(String(rel)))
    const stat = fs.statSync(realPath)
    return `${realPath}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return `missing:${rel}`
  }
}

function dharmaAssetIdentity(cell: DharmaCell | null): string | null {
  if (!cell) return null
  const kind: DharmaAssignedAssetKind = cell.video?.src ? 'video' : 'image'
  const src = cell.video?.src ?? cell.image?.src
  if (!src) return null
  try {
    const realPath = resolveDharmaAssignedAssetPath(src, kind)
    const stat = fs.statSync(realPath)
    return `${kind}:${realPath}:${stat.size}:${stat.mtimeMs}`
  } catch {
    return `invalid:${kind}:${src}`
  }
}

/**
 * A pilot is only evidence for the exact render inputs it auditioned. This
 * covers episode copy/audio/BGM plus every assigned source and storyboard
 * narration; changing any of them invalidates the previous approval.
 */
export type DharmaInputFingerprintClient = Pick<typeof db, 'select'>

export interface DharmaCanaryFingerprintSnapshot {
  rendererContractVersion: string
  episode: {
    title?: string | null
    preTtsAudio: string | null
    bgm: string | null
  }
  storyboards: Array<{
    id: number
    number: number
    narration: string | null
    description: string | null
    gridCells: string | null
    asset: string | null
    startMs: number
    endMs: number
  }>
}

export function buildDharmaCanaryFingerprintFromSnapshot(snapshot: DharmaCanaryFingerprintSnapshot): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, ...snapshot })).digest('hex')
}

export function buildDharmaEpisodeInputFingerprint(
  episodeId: number,
  client: DharmaInputFingerprintClient = db,
): string {
  const [episode] = client.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) throw new Error(`Episode ${episodeId} 不存在`)
  const storyboards = client.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
  const value = {
    version: 3,
    rendererProfile: DHARMA_RENDERER_CONTRACT_VERSION,
    episode: {
      title: episode.title,
      preTtsTitlesJson: episode.preTtsTitlesJson,
      preTtsAudio: staticFileIdentity(episode.preTtsAudioUrl),
      bgm: staticFileIdentity(episode.bgmAudioUrl),
    },
    storyboards: storyboards.map((storyboard) => {
      const cell = parseDharmaCell(storyboard.gridCells)
      return {
        id: storyboard.id,
        number: storyboard.storyboardNumber,
        narration: storyboard.narration,
        description: storyboard.description,
        gridCells: storyboard.gridCells,
        asset: dharmaAssetIdentity(cell),
      }
    }),
  }
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function buildDharmaCanaryInputFingerprint(
  episodeId: number,
  storyboardIds: number[],
  client: DharmaInputFingerprintClient = db,
): string {
  const uniqueIds = [...new Set(storyboardIds)]
  if (!uniqueIds.length || uniqueIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('canary storyboardIds 必须是非空的正整数数组')
  }
  const [episode] = client.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) throw new Error(`Episode ${episodeId} 不存在`)
  const timeline = buildMasterTimeline(episode.preTtsTitlesJson)
  if (!timeline) throw new Error(`Episode ${episodeId} 的 preTtsTitlesJson 无法解析为有效时间轴`)
  const storyboards = client.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
  const selected = storyboards.filter((storyboard) => uniqueIds.includes(storyboard.id))
  if (selected.length !== uniqueIds.length) throw new Error('canary 包含不属于当前剧集的 storyboardId')
  if (!areStoryboardNumbersContiguous(selected.map((storyboard) => storyboard.storyboardNumber))) {
    throw new Error('canary storyboardIds 必须对应连续分镜')
  }

  const selectedIds = new Set(uniqueIds)
  const lastSelectedNumber = selected[selected.length - 1].storyboardNumber
  const snapshots: DharmaCanaryFingerprintSnapshot['storyboards'] = []
  let cursor = 0
  for (const storyboard of storyboards) {
    if (storyboard.storyboardNumber > lastSelectedNumber) break
    const narration = resolveStoryboardNarration(storyboard)
    if (!narration) continue
    const located = locateNarrationWindow(timeline, narration, cursor)
    if (!located) {
      throw new Error(`分镜 #${storyboard.storyboardNumber} 的旁白无法在 TTS 主时间轴上定位`)
    }
    cursor = located.cursor
    if (!selectedIds.has(storyboard.id)) continue
    const cell = parseDharmaCell(storyboard.gridCells)
    snapshots.push({
      id: storyboard.id,
      number: storyboard.storyboardNumber,
      narration: storyboard.narration,
      description: storyboard.description,
      gridCells: storyboard.gridCells,
      asset: dharmaAssetIdentity(cell),
      startMs: Math.round(masterTimeAt(timeline, located.start) * 1000),
      endMs: Math.round(masterTimeAt(timeline, located.end) * 1000),
    })
  }
  if (snapshots.length !== selected.length) throw new Error('canary 风险窗口包含无有效旁白的分镜')

  return buildDharmaCanaryFingerprintFromSnapshot({
    rendererContractVersion: DHARMA_RENDERER_CONTRACT_VERSION,
    episode: {
      ...(selected[0].storyboardNumber === 1 ? { title: episode.title } : {}),
      preTtsAudio: staticFileIdentity(episode.preTtsAudioUrl),
      bgm: staticFileIdentity(episode.bgmAudioUrl),
    },
    storyboards: snapshots,
  })
}

export function isDharmaPilotOutputAvailable(output: string): boolean {
  // Task-specific pilot paths prevent a newer pilot render from overwriting the
  // file that an earlier approval still references. Accept the historic path
  // for already-approved episodes, but only create the immutable form now.
  const expected = new RegExp(`^static/remotion/dharma-ep\\d+-pilot-${DHARMA_REVIEW_PILOT_DURATION_SEC}s(?:-task\\d+)?\\.mp4$`)
  if (!expected.test(output)) return false
  const root = path.join(repoRoot, 'data/static/remotion')
  const candidate = path.resolve(repoRoot, 'data', output)
  return isInsideDharmaAssetRoot(candidate, [root]) && fs.existsSync(candidate)
}

export function getDharmaPilotApprovalState(
  episodeId: number,
  client: DharmaInputFingerprintClient = db,
): DharmaPilotApprovalState {
  const [episode] = client.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) throw new Error(`Episode ${episodeId} 不存在`)
  const inputFingerprint = buildDharmaEpisodeInputFingerprint(episodeId, client)
  const pilot = getDharmaPilotReview(episode.metadata)
  if (!pilot) return { approved: false, inputFingerprint, pilot: null, reason: '尚未完成可审核的 60 秒 pilot' }
  if (!isDharmaReviewPilotOutputDuration(pilot.durationSec)) {
    return { approved: false, inputFingerprint, pilot, reason: 'pilot 实际输出不是精确 60 秒，需重新试渲' }
  }
  if (pilot.status !== 'approved' || !pilot.approvedAt) {
    return { approved: false, inputFingerprint, pilot, reason: 'pilot 尚未人工审核通过' }
  }
  if (pilot.inputFingerprint !== inputFingerprint) {
    return { approved: false, inputFingerprint, pilot, reason: 'pilot 对应的素材、旁白、BGM 或标题已变化，需重新试渲并审核' }
  }
  if (!isDharmaPilotOutputAvailable(pilot.output)) {
    return { approved: false, inputFingerprint, pilot, reason: '已审核的 pilot 文件不存在，需重新试渲' }
  }
  return { approved: true, inputFingerprint, pilot }
}

const FFPROBE_BIN = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe'

export interface DharmaAudioLoudnessProcessResult {
  status: number | null
  stderr: string
}

export interface DharmaAudioLoudnessProbeOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface DharmaMediaProbeProcessResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface DharmaMediaDurationProbeOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * ffprobe is intentionally asynchronous: route assignment, render preflight,
 * and props building must keep serving cancellation and task-polling traffic
 * even when a malformed media container stalls metadata parsing.
 */
export function runDharmaMediaProbeProcess(
  command: string,
  args: readonly string[],
  options: DharmaMediaDurationProbeOptions = {},
): Promise<DharmaMediaProbeProcessResult | null> {
  if (options.signal?.aborted) return Promise.resolve(null)

  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DHARMA_MEDIA_DURATION_PROBE_MAX_RUNTIME_MS

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let terminated = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let terminate = () => {}

    const finish = (value: DharmaMediaProbeProcessResult | null) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', terminate)
      resolve(value)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      finish(null)
      return
    }

    terminate = () => {
      if (terminated || settled) return
      terminated = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 10_000)
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-64 * 1024)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024)
    })
    child.once('error', () => finish(null))
    child.once('close', (status) => {
      finish(terminated || options.signal?.aborted ? null : { status, stdout, stderr })
    })

    options.signal?.addEventListener('abort', terminate, { once: true })
    timeout = setTimeout(terminate, timeoutMs)
    if (options.signal?.aborted) terminate()
  })
}

/** 读取媒体文件时长（秒）；读不到返回 null（由调用方决定是门禁还是警告）。 */
export async function probeMediaDurationSec(
  absPath: string,
  options: DharmaMediaDurationProbeOptions = {},
): Promise<number | null> {
  const result = await runDharmaMediaProbeProcess(FFPROBE_BIN, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    absPath,
  ], options)
  if (!result || result.status !== 0) return null
  const duration = Number(result.stdout.trim())
  return Number.isFinite(duration) && duration > 0 ? duration : null
}

/**
 * Run the expensive loudnorm pass without blocking task polling or other API requests.
 * The caller-provided signal comes from the props-build deadline and also terminates ffmpeg.
 */
export function runDharmaAudioLoudnessProcess(
  command: string,
  args: readonly string[],
  options: DharmaAudioLoudnessProbeOptions = {},
): Promise<DharmaAudioLoudnessProcessResult | null> {
  if (options.signal?.aborted) return Promise.resolve(null)

  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DHARMA_AUDIO_LOUDNESS_PROBE_MAX_RUNTIME_MS

  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    let terminated = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let terminate = () => {}

    const finish = (value: DharmaAudioLoudnessProcessResult | null) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', terminate)
      resolve(value)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch {
      finish(null)
      return
    }

    terminate = () => {
      if (terminated || settled) return
      terminated = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 10_000)
    }

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      // The final loudnorm JSON is at the end of stderr. Cap memory but retain that tail.
      stderr = `${stderr}${String(chunk)}`.slice(-2 * 1024 * 1024)
    })
    child.once('error', () => finish(null))
    child.once('close', (status) => {
      finish(terminated || options.signal?.aborted ? null : { status, stderr })
    })

    options.signal?.addEventListener('abort', terminate, { once: true })
    timeout = setTimeout(terminate, timeoutMs)
    if (options.signal?.aborted) terminate()
  })
}

const dharmaAudioLoudnessCache = new Map<string, DharmaAudioLoudness>()

function getDharmaAudioLoudnessCacheKey(absPath: string): string | null {
  try {
    const realPath = fs.realpathSync(absPath)
    const stat = fs.statSync(realPath)
    return `${realPath}\0${stat.size}\0${stat.mtimeMs}`
  } catch {
    return null
  }
}

function cacheDharmaAudioLoudness(cacheKey: string, loudness: DharmaAudioLoudness): void {
  if (dharmaAudioLoudnessCache.size >= MAX_DHARMA_AUDIO_LOUDNESS_CACHE_ENTRIES) {
    const oldestKey = dharmaAudioLoudnessCache.keys().next().value
    if (oldestKey) dharmaAudioLoudnessCache.delete(oldestKey)
  }
  dharmaAudioLoudnessCache.set(cacheKey, loudness)
}

/**
 * 用 ffmpeg loudnorm 的首遍测量读取综合响度、真峰值和响度范围。这里不做转码；
 * 结果只用于计算 Remotion 的安全增益，测量失败就拒绝渲染，避免把未审计的音乐交付出去。
 */
export async function probeDharmaAudioLoudness(
  absPath: string,
  options: DharmaAudioLoudnessProbeOptions = {},
): Promise<DharmaAudioLoudness | null> {
  const cacheKey = getDharmaAudioLoudnessCacheKey(absPath)
  const cached = cacheKey ? dharmaAudioLoudnessCache.get(cacheKey) : undefined
  if (cached) return cached

  const result = await runDharmaAudioLoudnessProcess(FFPROBE_BIN.replace(/ffprobe$/, 'ffmpeg'), [
    '-hide_banner',
    '-nostats',
    '-i', absPath,
    '-af', 'loudnorm=I=-24:TP=-1.5:LRA=11:print_format=json',
    '-f', 'null',
    '-',
  ], options)
  if (!result || result.status !== 0) return null

  const output = result.stderr
  const blocks = output.match(/\{\s*"input_i"[\s\S]*?\}/g)
  const raw = blocks?.at(-1)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const integratedLufs = Number(parsed.input_i)
    const truePeakDb = Number(parsed.input_tp)
    const loudnessRangeLu = Number(parsed.input_lra)
    if (![integratedLufs, truePeakDb, loudnessRangeLu].every(Number.isFinite)) return null
    const loudness = { integratedLufs, truePeakDb, loudnessRangeLu }
    if (cacheKey && !options.signal?.aborted) cacheDharmaAudioLoudness(cacheKey, loudness)
    return loudness
  } catch {
    return null
  }
}

function roundMixVolume(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * 将任意来源曲目的实测响度映射到稳定的讲法音床，而不是把同一个 0.14
 * 增益套到所有曲目上。这样热母带不会盖住 TTS，安静曲目也不会被误判为无声。
 */
export function deriveDharmaBgmMix(
  narration: DharmaAudioLoudness,
  bgm: DharmaAudioLoudness,
  sourceDurationSec: number,
): DharmaBgmMix {
  if (!(sourceDurationSec >= MIN_BGM_DURATION_SEC)) {
    throw new Error(
      `BGM 时长 ${sourceDurationSec.toFixed(1)}s 低于 ${MIN_BGM_DURATION_SEC}s 下限；` +
      '长口播只能使用经过试听的长音床，不能反复循环短 loop',
    )
  }
  const targetLufs = narration.integratedLufs - DHARMA_BGM_NARRATION_GAP_LU
  const rawVolume = 10 ** ((targetLufs - bgm.integratedLufs) / 20)
  if (rawVolume > DHARMA_BGM_MAX_VOLUME) {
    throw new Error(
      `BGM 响度过低（${bgm.integratedLufs.toFixed(1)} LUFS），需要 ${rawVolume.toFixed(2)} 倍增益才会达到安全音床；` +
      '请换一首响度更稳定的长曲目，不要用大幅增益硬救',
    )
  }
  const volume = rawVolume
  return {
    volume: roundMixVolume(volume),
    narrationVolume: roundMixVolume(volume * DHARMA_BGM_SPEECH_DUCK_GAIN),
    fadeInSec: 3,
    fadeOutSec: 5,
    loopCrossfadeSec: 4,
    sourceDurationSec,
    targetLufs: Math.round(targetLufs * 10) / 10,
    narrationLufs: narration.integratedLufs,
    bgmLufs: bgm.integratedLufs,
  }
}

// ---- 纯函数（单元测试不依赖 DB）----

export interface DharmaWindowInput {
  storyboardNumber: number
  startMs: number
  endMs: number
  kind: 'video' | 'image'
  src: string
  generatedSegmentTaskId?: number
}

export interface DharmaSegmentWindow {
  kind: 'video' | 'image'
  src: string
  startMs: number
  endMs: number
  storyboardNumbers: number[]
  generatedSegmentTaskId?: number
}

/**
 * Derive a segment from absolute timeline boundaries. Rounding its duration
 * separately from its start can leave a one-frame hole at otherwise contiguous
 * TTS windows; a shared rounded end frame cannot.
 */
export function resolveDharmaSegmentFrameWindow(startMs: number, endMs: number): {
  startFrame: number
  durationInFrames: number
} {
  const startFrame = Math.round((startMs / 1000) * FPS)
  const endFrame = Math.round((endMs / 1000) * FPS)
  return {
    startFrame,
    durationInFrames: Math.max(1, endFrame - startFrame),
  }
}

export interface DharmaAssetUse {
  storyboardNumber: number
  kind: 'video' | 'image'
  /** Stored source path, retained for human-readable error output. */
  src: string
  /** Canonical file identity when validation runs against real files. */
  sourceKey?: string
  /** Allows one task-owned AI still to cover its requested contiguous segment. */
  generatedSegmentTaskId?: number
}

export interface DharmaAssetReuse {
  kind: 'video' | 'image'
  src: string
  storyboardRanges: Array<{ start: number; end: number }>
}

export interface DharmaVisualRoleUse extends DharmaAssetUse {
  role: DharmaVisualRole
}

export interface DharmaVisualRoleMismatch {
  src: string
  storyboardNumbers: [number, number]
  roles: [DharmaVisualRole, DharmaVisualRole]
}

export interface DharmaNarrationWindow {
  startFrame: number
  endFrame: number
}

/** Incoming video starts this many frames before its semantic boundary. */
export function resolveDharmaCrossfadeLeadFrames(segmentDurationInFrames: number, segmentIndex: number): number {
  if (segmentIndex === 0) return 0
  return Math.min(DHARMA_CROSSFADE_FRAMES, Math.max(0, Math.floor(segmentDurationInFrames / 3)))
}

/** Merge near-contiguous spoken ranges so a clause boundary cannot make the BGM pump. */
export function mergeDharmaNarrationWindows(
  windows: DharmaNarrationWindow[],
  // The visual envelope starts 8 frames before and ends 14 frames after a
  // narration window. Merge at least that combined gap so BGM cannot pop up
  // between adjacent spoken clauses.
  maxGapFrames = 22,
): DharmaNarrationWindow[] {
  const merged: DharmaNarrationWindow[] = []
  for (const window of [...windows].sort((a, b) => a.startFrame - b.startFrame)) {
    const previous = merged[merged.length - 1]
    if (previous && window.startFrame <= previous.endFrame + maxGapFrames) {
      previous.endFrame = Math.max(previous.endFrame, window.endFrame)
    } else {
      merged.push({ ...window })
    }
  }
  return merged
}

/**
 * A source may cover one contiguous visual run, but may never return after a
 * different source has appeared. This is deliberately episode-wide: a pilot
 * must not hide a duplicate that would reach the final delivery later.
 */
export function findNonAdjacentDharmaAssetReuse(items: DharmaAssetUse[]): DharmaAssetReuse[] {
  const grouped = new Map<string, {
    kind: 'video' | 'image'
    src: string
    ranges: Array<{ start: number; end: number; generatedSegmentTaskId?: number }>
  }>()
  for (const item of [...items].sort((a, b) => a.storyboardNumber - b.storyboardNumber)) {
    const key = item.sourceKey || `${item.kind}:${item.src}`
    const group = grouped.get(key)
    if (!group) {
      grouped.set(key, {
        kind: item.kind,
        src: item.src,
        ranges: [{
          start: item.storyboardNumber,
          end: item.storyboardNumber,
          ...(item.generatedSegmentTaskId != null ? { generatedSegmentTaskId: item.generatedSegmentTaskId } : {}),
        }],
      })
      continue
    }
    const current = group.ranges[group.ranges.length - 1]
    const isContiguous = item.storyboardNumber === current.end + 1
    const sameGeneratedImageSegment = group.kind === 'image'
      && item.kind === 'image'
      && current.generatedSegmentTaskId != null
      && current.generatedSegmentTaskId === item.generatedSegmentTaskId
    // Videos form a contiguous visual run. A generated still remains an
    // independent Ken-Burns board, but a task-owned contiguous group is an
    // explicit user-approved segment rather than an accidental repeat.
    if (isContiguous && (
      (group.kind === 'video' && item.kind === 'video')
      || sameGeneratedImageSegment
    )) {
      current.end = item.storyboardNumber
    } else if (item.storyboardNumber > current.end) {
      group.ranges.push({
        start: item.storyboardNumber,
        end: item.storyboardNumber,
        ...(item.generatedSegmentTaskId != null ? { generatedSegmentTaskId: item.generatedSegmentTaskId } : {}),
      })
    }
  }
  return [...grouped.values()]
    .filter((group) => group.ranges.length > 1)
    .map((group) => ({
      kind: group.kind,
      src: group.src,
      storyboardRanges: group.ranges.map(({ start, end }) => ({ start, end })),
    }))
}

/**
 * Adjacent video cells with one canonical source become one visual segment.
 * Letting their roles diverge would let a caller relabel the same frames to
 * manipulate the full-episode sacred-coverage ratio.
 */
export function findAdjacentDharmaSegmentRoleMismatches(items: DharmaVisualRoleUse[]): DharmaVisualRoleMismatch[] {
  const mismatches: DharmaVisualRoleMismatch[] = []
  const ordered = [...items].sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    const previousKey = previous.sourceKey || `${previous.kind}:${previous.src}`
    const currentKey = current.sourceKey || `${current.kind}:${current.src}`
    if (
      previous.kind === 'video'
      && current.kind === 'video'
      && current.storyboardNumber === previous.storyboardNumber + 1
      && currentKey === previousKey
      && current.role !== previous.role
    ) {
      mismatches.push({
        src: current.src,
        storyboardNumbers: [previous.storyboardNumber, current.storyboardNumber],
        roles: [previous.role, current.role],
      })
    }
  }
  return mismatches
}

export function formatDharmaVisualRoleMismatches(mismatches: DharmaVisualRoleMismatch[]): string {
  return mismatches
    .map((entry) => `${entry.src}（#${entry.storyboardNumbers[0]}=${entry.roles[0]}，#${entry.storyboardNumbers[1]}=${entry.roles[1]}）`)
    .join('；')
}

export function formatDharmaAssetReuse(reuse: DharmaAssetReuse[]): string {
  return reuse
    .map((entry) => `${entry.src}（${entry.storyboardRanges.map((range) =>
      range.start === range.end ? `#${range.start}` : `#${range.start}-#${range.end}`).join('、')}）`)
    .join('；')
}

/** Canonicalization prevents `../` aliases or symlinks from bypassing the no-reuse gate. */
export function canonicalDharmaAssetKey(src: string): string {
  const absolute = path.resolve(resolveStaticPath(src))
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/**
 * Remotion needs public files, but copying every selected original into every
 * episode directory turned each render into an 800MB staging job. Assets are
 * staged once under a content-identity filename; hard links keep the common
 * case instantaneous and a copy fallback preserves cross-device compatibility.
 */
function stageDharmaAsset(absPath: string): string {
  const stat = fs.statSync(absPath)
  const extension = path.extname(absPath) || '.bin'
  const identity = createHash('sha256')
    .update(`${fs.realpathSync.native(absPath)}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 20)
  const filename = `${identity}${extension}`
  const targetDir = path.join(repoRoot, 'remotion/public/dharma-assets')
  const target = path.join(targetDir, filename)
  if (!fs.existsSync(target)) {
    fs.mkdirSync(targetDir, { recursive: true })
    try {
      fs.linkSync(absPath, target)
    } catch {
      fs.copyFileSync(absPath, target)
    }
  }
  return `dharma-assets/${filename}`
}

type DharmaDeliveryProxyEnsurer = (
  sourcePath: string,
  options: { signal?: AbortSignal },
) => Promise<DharmaDeliveryProxyResult>

function propsAbortError(): Error {
  const error = new Error('Dharma props 构建已取消')
  error.name = 'AbortError'
  return error
}

/**
 * Resolve each unique source once before staging it for Remotion. The source
 * path remains the provenance identity in the DB; only the delivery path
 * changes, so a 720p render never repeatedly decodes a 4K stock original.
 */
export async function prepareDharmaDeliveryAssets(
  sourcePaths: readonly string[],
  options: {
    signal?: AbortSignal
    concurrency?: number
    onDeliveryProxy?: (result: DharmaDeliveryProxyResult, elapsedMs: number) => void
    ensureProxy?: DharmaDeliveryProxyEnsurer
  } = {},
): Promise<{
  bySourcePath: ReadonlyMap<string, DharmaDeliveryProxyResult>
  summary: DharmaDeliveryProxySummary
}> {
  const bySourcePath = new Map<string, DharmaDeliveryProxyResult>()
  const summary: DharmaDeliveryProxySummary = { source: 0, cacheHits: 0, created: 0, elapsedMs: 0 }
  const ensureProxy = options.ensureProxy ?? ensureDharmaDeliveryProxy
  const concurrency = Number(options.concurrency ?? 2)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error(`Dharma delivery proxy 并发必须是 1-4 的整数，当前值为 ${JSON.stringify(options.concurrency)}`)
  }
  const uniqueSourcePaths = [...new Set(sourcePaths.map((sourcePath) => path.resolve(sourcePath)))]
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const startedAt = Date.now()
  let nextIndex = 0

  const worker = async () => {
    while (true) {
      if (controller.signal.aborted) throw propsAbortError()
      const sourcePath = uniqueSourcePaths[nextIndex++]
      if (!sourcePath) return
      const proxyStartedAt = Date.now()
      try {
        const result = await ensureProxy(sourcePath, { signal: controller.signal })
        const elapsedMs = Date.now() - proxyStartedAt
        bySourcePath.set(sourcePath, result)
        if (result.cacheStatus === 'source') summary.source += 1
        else if (result.cacheStatus === 'hit') summary.cacheHits += 1
        else summary.created += 1
        options.onDeliveryProxy?.(result, elapsedMs)
      } catch (error) {
        controller.abort()
        throw error
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, uniqueSourcePaths.length) }, worker))
  } finally {
    options.signal?.removeEventListener('abort', abortFromCaller)
    summary.elapsedMs = Date.now() - startedAt
  }

  return { bySourcePath, summary }
}

/** Segment metadata belongs to the range's lead storyboard, never to a source-keyed cache. */
export function resolveSegmentLeadCell(
  segment: Pick<DharmaSegmentWindow, 'storyboardNumbers'>,
  cellsByStoryboardNumber: ReadonlyMap<number, DharmaCell>,
): DharmaCell {
  const storyboardNumber = segment.storyboardNumbers[0]
  const cell = cellsByStoryboardNumber.get(storyboardNumber)
  if (!cell) throw new Error(`视觉段落缺少起始分镜 #${storyboardNumber} 的素材指派`)
  return cell
}

/**
 * 把相邻且使用同一素材的视频分镜合并为一个视觉段落。由同一生成任务产出的
 * AI 图片也合并为一个连续 Ken Burns 段落，避免每个分镜重启运镜。
 */
export function mergeDharmaSegments(items: DharmaWindowInput[]): DharmaSegmentWindow[] {
  const segments: DharmaSegmentWindow[] = []
  for (const item of items) {
    const prev = segments[segments.length - 1]
    const sameGeneratedImageSegment = prev
      && prev.kind === 'image'
      && item.kind === 'image'
      && prev.src === item.src
      && prev.generatedSegmentTaskId != null
      && prev.generatedSegmentTaskId === item.generatedSegmentTaskId
    if (prev
      && prev.src === item.src
      // A narration pause belongs to the preceding visual segment. Continuity is
      // defined by adjacent storyboards, not by a small gap in their TTS windows.
      && item.storyboardNumber === prev.storyboardNumbers[prev.storyboardNumbers.length - 1] + 1
      && ((prev.kind === 'video' && item.kind === 'video') || sameGeneratedImageSegment)) {
      prev.endMs = Math.max(prev.endMs, item.endMs)
      prev.storyboardNumbers.push(item.storyboardNumber)
      continue
    }
    segments.push({
      kind: item.kind,
      src: item.src,
      startMs: item.startMs,
      endMs: item.endMs,
      storyboardNumbers: [item.storyboardNumber],
      ...(item.generatedSegmentTaskId != null ? { generatedSegmentTaskId: item.generatedSegmentTaskId } : {}),
    })
  }
  return segments
}

/**
 * TTS title timing can include real narration pauses between different visual
 * sources. A pause is still part of the film: keep the outgoing source alive
 * until the next segment begins, rather than exposing the composition's black
 * background. When that would make a generated key image exceed its 30-second
 * limit, begin the incoming visual during the silent interval instead. Source-
 * duration validation runs after this step and rejects a video extension that
 * would require playback slower than the permitted 0.6x floor.
 */
export function fillDharmaVisualGaps(segments: DharmaSegmentWindow[]): DharmaSegmentWindow[] {
  const filled = segments.map((segment) => ({
    ...segment,
    storyboardNumbers: [...segment.storyboardNumbers],
  }))
  const isGeneratedImage = (segment: DharmaSegmentWindow): boolean => (
    segment.kind === 'image' && segment.generatedSegmentTaskId != null
  )

  for (let index = 0; index < filled.length - 1; index += 1) {
    const outgoing = filled[index]
    const incoming = filled[index + 1]
    if (outgoing.endMs >= incoming.startMs) continue

    const outgoingWouldExceedImageLimit = isGeneratedImage(outgoing)
      && incoming.startMs - outgoing.startMs > DHARMA_MAX_GENERATED_IMAGE_SEGMENT_DURATION_MS
    if (!outgoingWouldExceedImageLimit) {
      outgoing.endMs = incoming.startMs
      continue
    }

    // The silence belongs visually to the incoming segment when the outgoing
    // AI still has reached its deliberate-hold limit. Do not trade one invalid
    // generated-image segment for another; require a new visual assignment.
    if (isGeneratedImage(incoming)
      && incoming.endMs - outgoing.endMs > DHARMA_MAX_GENERATED_IMAGE_SEGMENT_DURATION_MS) {
      throw new Error(
        `AI 关键图段落 #${outgoing.storyboardNumbers[0]} 与 #${incoming.storyboardNumbers[0]} `
        + `之间的静音间隔会使任一图超过 ${DHARMA_MAX_GENERATED_IMAGE_SEGMENT_DURATION_MS / 1000}s 上限；请拆分或更换该段素材`,
      )
    }
    incoming.startMs = outgoing.endMs
  }

  return filled
}

export interface DharmaCreativePlanWindow {
  storyboardNumber: number
  startMs: number
  endMs: number
  cell: DharmaCell
}

export interface DharmaCreativePlanSegment {
  storyboardNumbers: number[]
  startMs: number
  endMs: number
  kind: 'video' | 'image'
  emotion: DharmaEmotion
  styleId: string
  generatedImage: boolean
  hasQuote: boolean
  move?: DharmaImageMove
}

export interface DharmaCreativePlanSummary {
  segmentCount: number
  styleIds: string[]
  emotionSequence: DharmaEmotion[]
  generatedImageSegmentCount: number
  generatedImageSegmentBudget: { min: number; max: number }
  generatedImageCoverageRatio: number
  maxSingleGeneratedImageCoverageRatio: number
  videoCoverageRatio: number
  coverageMsByStyle: Record<string, number>
  coverageMsByEmotion: Record<DharmaEmotion, number>
  segments: DharmaCreativePlanSegment[]
}

export interface DharmaCreativePlanValidationOptions {
  verifiedGeneratedImageTaskIds?: ReadonlySet<number>
}

export function resolveDharmaGeneratedImageSegmentBudget(totalCoverageMs: number): { min: number; max: number } {
  const scale = Math.min(1, Math.max(0, totalCoverageMs) / DHARMA_KEY_IMAGE_REFERENCE_DURATION_MS)
  const min = Math.max(3, Math.ceil(DHARMA_KEY_IMAGE_REFERENCE_MIN_SEGMENTS * scale))
  const max = Math.max(min, 4, Math.ceil(DHARMA_KEY_IMAGE_REFERENCE_MAX_SEGMENTS * scale))
  return {
    min: Math.min(DHARMA_KEY_IMAGE_REFERENCE_MIN_SEGMENTS, min),
    max: Math.min(DHARMA_KEY_IMAGE_REFERENCE_MAX_SEGMENTS, max),
  }
}

function emptyDharmaEmotionCoverage(): Record<DharmaEmotion, number> {
  return Object.fromEntries(DHARMA_EMOTIONS.map((emotion) => [emotion, 0])) as Record<DharmaEmotion, number>
}

function requireDharmaCreativeMetadata(cell: DharmaCell, storyboardNumber: number) {
  const emotion = normalizeDharmaEmotion(cell.emotion)
  if ('error' in emotion) throw new Error(`分镜 #${storyboardNumber} ${emotion.error}`)
  const style = findDharmaImageStyle(cell.styleId)
  if (!style) throw new Error(`分镜 #${storyboardNumber} 缺少有效的情绪画面风格 styleId`)
  const mismatch = validateDharmaStyleEmotion(style, emotion.emotion)
  if (mismatch) throw new Error(`分镜 #${storyboardNumber} ${mismatch}`)
  return { emotion: emotion.emotion, style }
}

/**
 * Validate the film's emotional composition before proxying, loudness scans, or
 * frame rendering. The visuals carry a feeling arc; asset coverage alone is not
 * a creative plan.
 */
export function validateDharmaCreativeProductionPlan(
  windows: DharmaCreativePlanWindow[],
  options: DharmaCreativePlanValidationOptions = {},
): DharmaCreativePlanSummary {
  if (!windows.length) throw new Error('情绪视觉方案没有可计算的 TTS 时序覆盖')
  const cellsByStoryboardNumber = new Map(windows.map((window) => [window.storyboardNumber, window.cell]))
  const merged = fillDharmaVisualGaps(mergeDharmaSegments(windows.map((window) => ({
    storyboardNumber: window.storyboardNumber,
    startMs: window.startMs,
    endMs: window.endMs,
    kind: window.cell.video?.src ? 'video' as const : 'image' as const,
    src: window.cell.video?.src ?? window.cell.image?.src ?? '',
    ...(window.cell.image?.generatedSegmentTaskId != null
      ? { generatedSegmentTaskId: window.cell.image.generatedSegmentTaskId }
      : {}),
  }))))

  const problems: string[] = []
  const coverageMsByStyle: Record<string, number> = {}
  const coverageMsByEmotion = emptyDharmaEmotionCoverage()
  const segments: DharmaCreativePlanSegment[] = []
  let totalCoverageMs = 0
  let generatedImageCoverageMs = 0
  let videoCoverageMs = 0

  for (const segment of merged) {
    const leadNumber = segment.storyboardNumbers[0]
    const leadCell = cellsByStoryboardNumber.get(leadNumber)
    if (!leadCell) throw new Error(`情绪视觉段落缺少起始分镜 #${leadNumber}`)
    const lead = requireDharmaCreativeMetadata(leadCell, leadNumber)
    const leadMove = leadCell.image?.move ?? lead.style.defaultMove
    let hasQuote = false
    let hasAttributedQuote = false

    for (const storyboardNumber of segment.storyboardNumbers) {
      const cell = cellsByStoryboardNumber.get(storyboardNumber)
      if (!cell) continue
      const metadata = requireDharmaCreativeMetadata(cell, storyboardNumber)
      const move = cell.image?.move ?? metadata.style.defaultMove
      if (metadata.emotion !== lead.emotion || metadata.style.id !== lead.style.id || move !== leadMove) {
        problems.push(`同一连续视觉段落 #${leadNumber}-#${storyboardNumber} 的 emotion/style/move 必须一致`)
      }
      hasQuote = hasQuote || Boolean(cell.quote?.text)
      hasAttributedQuote = hasAttributedQuote || Boolean(cell.quote?.text && cell.quote.source?.trim())
    }

    const durationMs = segment.endMs - segment.startMs
    totalCoverageMs += durationMs
    coverageMsByStyle[lead.style.id] = (coverageMsByStyle[lead.style.id] ?? 0) + durationMs
    coverageMsByEmotion[lead.emotion] += durationMs
    const generatedImage = segment.kind === 'image'
      && segment.generatedSegmentTaskId != null
      && Boolean(options.verifiedGeneratedImageTaskIds?.has(segment.generatedSegmentTaskId))
    if (generatedImage) generatedImageCoverageMs += durationMs
    if (segment.kind === 'video') videoCoverageMs += durationMs

    if (lead.emotion === 'insight'
      && (lead.style.id !== DHARMA_MINIMAL_LIGHT_STYLE_ID || !generatedImage || leadMove !== 'hold' || !hasQuote)) {
      problems.push(`顿悟段 #${leadNumber} 必须使用极简光影 AI 图片、hold 运镜并承载金句停顿`)
    }
    const isInsightQuote = lead.emotion === 'insight'
      && lead.style.id === DHARMA_MINIMAL_LIGHT_STYLE_ID
      && generatedImage
      && leadMove === 'hold'
    const isAttributedScriptureReveal = hasAttributedQuote && generatedImage && leadMove === 'hold'
    if (hasQuote
      && !isInsightQuote
      && !isAttributedScriptureReveal) {
      problems.push(`金句段 #${leadNumber} 必须是 insight 极简光影停顿，或有明确出处的经文揭示；两者都必须使用可信 AI 图片和 hold 运镜`)
    }

    segments.push({
      storyboardNumbers: [...segment.storyboardNumbers],
      startMs: segment.startMs,
      endMs: segment.endMs,
      kind: segment.kind,
      emotion: lead.emotion,
      styleId: lead.style.id,
      generatedImage,
      hasQuote,
      ...(segment.kind === 'image' ? { move: leadMove } : {}),
    })
  }

  const styleIds = [...new Set(segments.map((segment) => segment.styleId))]
  const requiredStyleIds = [
    DHARMA_EMOTIONAL_INK_STYLE_ID,
    DHARMA_SURREAL_DREAM_STYLE_ID,
    DHARMA_MINIMAL_LIGHT_STYLE_ID,
  ]
  if (styleIds.length !== requiredStyleIds.length
    || requiredStyleIds.some((styleId) => !styleIds.includes(styleId))) {
    problems.push('完整情绪弧线必须实际使用水墨意境、超现实梦境、极简光影三种风格')
  }
  const first = segments[0]
  if (first.emotion !== 'curiosity' || first.styleId !== DHARMA_SURREAL_DREAM_STYLE_ID) {
    problems.push('开场必须以 curiosity + 超现实梦境制造问题感')
  }
  if (first.kind === 'image' && (!first.generatedImage || first.move === 'hold')) {
    problems.push('开场静态图必须是 AI 关键图，并使用可见的 Ken Burns/漂移运镜')
  }
  const last = segments[segments.length - 1]
  if (last.emotion !== 'release' || last.styleId !== DHARMA_EMOTIONAL_INK_STYLE_ID) {
    problems.push('结尾必须以 release + 水墨意境开放式离场')
  }

  const emotionSequence = segments
    .map((segment) => segment.emotion)
    .filter((emotion, index, values) => index === 0 || emotion !== values[index - 1])
  const requiredArc: DharmaEmotion[] = ['curiosity', 'stillness', 'tension', 'acceptance', 'insight', 'release']
  const emotionRank = new Map(requiredArc.map((emotion, index) => [emotion, index]))
  for (let index = 1; index < emotionSequence.length; index += 1) {
    const previous = emotionSequence[index - 1]
    const current = emotionSequence[index]
    if ((emotionRank.get(current) ?? -1) < (emotionRank.get(previous) ?? -1)) {
      problems.push(`情绪弧线不能逆序回跳：${previous} -> ${current}`)
      break
    }
  }
  let arcCursor = -1
  for (const milestone of requiredArc) {
    const foundAt = emotionSequence.findIndex((emotion, index) => index > arcCursor && emotion === milestone)
    if (foundAt < 0) {
      problems.push(`情绪弧线缺少或乱序：${requiredArc.join(' -> ')}`)
      break
    }
    arcCursor = foundAt
  }

  const minimumMilestoneMs = Math.min(6_000, Math.max(1_000, totalCoverageMs * 0.01))
  for (const milestone of requiredArc) {
    if (coverageMsByEmotion[milestone] < minimumMilestoneMs) {
      problems.push(`情绪节点 ${milestone} 只有 ${(coverageMsByEmotion[milestone] / 1000).toFixed(1)}s，不能用瞬时标签冒充完整段落`)
    }
  }

  const generatedImageCoverageRatio = totalCoverageMs > 0 ? generatedImageCoverageMs / totalCoverageMs : 0
  if (generatedImageCoverageRatio < DHARMA_MIN_GENERATED_IMAGE_COVERAGE_RATIO
    || generatedImageCoverageRatio > DHARMA_MAX_GENERATED_IMAGE_COVERAGE_RATIO) {
    problems.push(
      `AI 关键图覆盖率 ${(generatedImageCoverageRatio * 100).toFixed(1)}% 不在 `
      + `${(DHARMA_MIN_GENERATED_IMAGE_COVERAGE_RATIO * 100).toFixed(0)}%-${(DHARMA_MAX_GENERATED_IMAGE_COVERAGE_RATIO * 100).toFixed(0)}% 生产范围`,
    )
  }
  const generatedImageSegments = segments.filter((segment) => segment.generatedImage)
  const generatedImageSegmentBudget = resolveDharmaGeneratedImageSegmentBudget(totalCoverageMs)
  if (generatedImageSegments.length < generatedImageSegmentBudget.min
    || generatedImageSegments.length > generatedImageSegmentBudget.max) {
    problems.push(
      `按片长需要 ${generatedImageSegmentBudget.min}-${generatedImageSegmentBudget.max} 个独立 AI 关键图段落，`
      + `当前为 ${generatedImageSegments.length} 个`,
    )
  }
  const maxSingleGeneratedImageCoverageRatio = totalCoverageMs > 0
    ? Math.max(0, ...generatedImageSegments.map((segment) => (segment.endMs - segment.startMs) / totalCoverageMs))
    : 0
  const maxGeneratedImageDurationMs = Math.min(
    DHARMA_MAX_GENERATED_IMAGE_SEGMENT_DURATION_MS,
    totalCoverageMs * DHARMA_MAX_SINGLE_GENERATED_IMAGE_COVERAGE_RATIO,
  )
  const overlongGeneratedImage = generatedImageSegments.find(
    (segment) => segment.endMs - segment.startMs > maxGeneratedImageDurationMs,
  )
  if (overlongGeneratedImage) {
    problems.push(
      `AI 关键图段落 #${overlongGeneratedImage.storyboardNumbers[0]} 覆盖 `
      + `${((overlongGeneratedImage.endMs - overlongGeneratedImage.startMs) / 1000).toFixed(1)}s，`
      + `超过单图上限 ${(maxGeneratedImageDurationMs / 1000).toFixed(1)}s`,
    )
  }
  const videoCoverageRatio = totalCoverageMs > 0 ? videoCoverageMs / totalCoverageMs : 0
  if (videoCoverageRatio < DHARMA_MIN_VIDEO_COVERAGE_RATIO) {
    problems.push(`动态视频覆盖率 ${(videoCoverageRatio * 100).toFixed(1)}% 低于 ${(DHARMA_MIN_VIDEO_COVERAGE_RATIO * 100).toFixed(0)}% 下限`)
  }
  if (problems.length) throw new Error(`情绪视觉方案不合格：${[...new Set(problems)].join('；')}`)

  return {
    segmentCount: segments.length,
    styleIds,
    emotionSequence,
    generatedImageSegmentCount: generatedImageSegments.length,
    generatedImageSegmentBudget,
    generatedImageCoverageRatio,
    maxSingleGeneratedImageCoverageRatio,
    videoCoverageRatio,
    coverageMsByStyle,
    coverageMsByEmotion,
    segments,
  }
}

/**
 * A review pilot may end between narration windows. Keep the final source
 * alive through the frame-accurate boundary instead of making a black gap or
 * cutting the next spoken sentence in half.
 */
export function extendDharmaVisualTail(
  segments: DharmaSegmentWindow[],
  visualTailEndMs?: number,
): DharmaSegmentWindow[] {
  if (visualTailEndMs === undefined || !segments.length) return segments
  const lastIndex = segments.length - 1
  const last = segments[lastIndex]
  if (last.endMs >= visualTailEndMs) return segments
  return [
    ...segments.slice(0, lastIndex),
    { ...last, endMs: visualTailEndMs },
  ]
}

/**
 * The assignment API can only see storyboard adjacency. Rendering also knows
 * the real TTS windows: a long silent gap can split adjacent boards into two
 * segments, and that is a second use of the same source. Validate the merged
 * visual timeline so neither a pilot nor direct SQL edit can hide it.
 */
export function findDharmaSegmentAssetReuse(segments: DharmaSegmentWindow[]): DharmaAssetReuse[] {
  const grouped = new Map<string, {
    kind: 'video' | 'image'
    src: string
    ranges: Array<{ start: number; end: number; generatedSegmentTaskId?: number }>
  }>()
  for (const segment of segments) {
    const key = `${segment.kind}:${canonicalDharmaAssetKey(segment.src)}`
    const group = grouped.get(key)
    const range = {
      start: segment.storyboardNumbers[0],
      end: segment.storyboardNumbers[segment.storyboardNumbers.length - 1],
      ...(segment.generatedSegmentTaskId != null ? { generatedSegmentTaskId: segment.generatedSegmentTaskId } : {}),
    }
    if (!group) {
      grouped.set(key, { kind: segment.kind, src: segment.src, ranges: [range] })
      continue
    }
    const previous = group.ranges[group.ranges.length - 1]
    const sameGeneratedImageSegment = group.kind === 'image'
      && segment.kind === 'image'
      && previous.generatedSegmentTaskId != null
      && previous.generatedSegmentTaskId === segment.generatedSegmentTaskId
      && range.start === previous.end + 1
    if (sameGeneratedImageSegment) previous.end = range.end
    else group.ranges.push(range)
  }
  return [...grouped.values()]
    .filter((group) => group.ranges.length > 1)
    .map((group) => ({
      kind: group.kind,
      src: group.src,
      storyboardRanges: group.ranges.map(({ start, end }) => ({ start, end })),
    }))
}

export interface VideoWindowTiming {
  sourceStartSec: number
  playbackRate: number
}

export interface DharmaSegmentPlaybackPlan extends VideoWindowTiming {
  storyboardNumbers: number[]
  src: string
  renderedDurationSec: number
}

export function validateDharmaSegmentPlaybackPlan(
  segments: DharmaSegmentWindow[],
  cellsByStoryboardNumber: ReadonlyMap<number, DharmaCell>,
  sourceDurationsSec: ReadonlyMap<string, number>,
): DharmaSegmentPlaybackPlan[] {
  const plans: DharmaSegmentPlaybackPlan[] = []
  segments.forEach((segment, segmentIndex) => {
    if (segment.kind !== 'video') return
    const { durationInFrames } = resolveDharmaSegmentFrameWindow(segment.startMs, segment.endMs)
    const crossfadeLeadFrames = resolveDharmaCrossfadeLeadFrames(durationInFrames, segmentIndex)
    const renderedDurationSec = (durationInFrames + crossfadeLeadFrames) / FPS
    const clipDurationSec = sourceDurationsSec.get(segment.src)
    if (!Number.isFinite(clipDurationSec)) throw new Error(`素材 ${segment.src} 缺少可验证的时长`)
    const leadCell = resolveSegmentLeadCell(segment, cellsByStoryboardNumber)
    try {
      const timing = resolveVideoWindowTiming(
        Number(clipDurationSec),
        renderedDurationSec,
        leadCell.video?.sourceStartSec,
      )
      plans.push({
        ...timing,
        storyboardNumbers: [...segment.storyboardNumbers],
        src: segment.src,
        renderedDurationSec,
      })
    } catch (error) {
      throw new Error(`素材 ${segment.src} 的全片播放计划无效：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return plans
}

/**
 * 视频段落的时间适配：
 *  - 素材够长：按 sourceStartSec 起播（必要时前移以保证尾段不超出素材）；
 *  - 素材偏短：慢放拉伸（下限 MIN_PLAYBACK_RATE），绝不硬循环——
 *    循环断点在慢节奏禅意画面里非常刺眼，宁可失败换素材。
 */
export function resolveVideoWindowTiming(
  clipDurationSec: number,
  segmentDurationSec: number,
  requestedSourceStartSec?: number,
): VideoWindowTiming {
  if (!(clipDurationSec > 0)) throw new Error(`素材时长无效（${clipDurationSec}s）`)
  if (!(segmentDurationSec > 0)) throw new Error(`段落时长无效（${segmentDurationSec}s）`)

  if (clipDurationSec >= segmentDurationSec) {
    const requested = Math.max(0, Number(requestedSourceStartSec) || 0)
    const sourceStartSec = Math.min(requested, clipDurationSec - segmentDurationSec)
    return { sourceStartSec, playbackRate: 1 }
  }

  const playbackRate = clipDurationSec / segmentDurationSec
  if (playbackRate < MIN_PLAYBACK_RATE) {
    throw new Error(
      `素材 ${clipDurationSec.toFixed(1)}s 无法覆盖 ${segmentDurationSec.toFixed(1)}s 段落` +
      `（慢放比 ${playbackRate.toFixed(2)} 低于下限 ${MIN_PLAYBACK_RATE}）。` +
      `请换更长的素材，或把该段落拆成两段各配一条素材`,
    )
  }
  return { sourceStartSec: 0, playbackRate }
}

// ---- DB 装配 ----

export interface StoryboardTiming {
  sb: typeof schema.storyboards.$inferSelect
  cell: DharmaCell
  narration: string
  charStart: number
  charEnd: number
  startMs: number
  endMs: number
}

function requireDharmaVisualRole(cell: DharmaCell, storyboardNumber: number): DharmaVisualRole {
  const role = normalizeDharmaVisualRole(cell.role)
  if ('error' in role) throw new Error(`分镜 #${storyboardNumber} 的素材不合规：${role.error}`)
  return role.role
}

function requireDharmaVisualSemanticContract(cell: DharmaCell, storyboardNumber: number): void {
  const role = requireDharmaVisualRole(cell, storyboardNumber)
  const contract = normalizeDharmaVisualSemanticContract({
    role,
    kind: cell.video?.src ? 'video' : 'image',
    shotFunction: cell.shotFunction,
    semantic: cell.semantic,
  })
  if ('error' in contract) {
    throw new Error(`分镜 #${storyboardNumber} 的语义画面计划不合规：${contract.error}`)
  }
}

function resolveStoryboardTimings(
  episodeId: number,
  timeline: MasterTimeline,
  onlyStoryboardIds?: number[],
): { timings: StoryboardTiming[]; allTimings: StoryboardTiming[]; subtitleFallbackCandidates: number } {
  const selected = onlyStoryboardIds?.length ? new Set(onlyStoryboardIds) : null
  const allStoryboards = db
    .select()
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
  const manifestIndex = buildDharmaStockManifestIndex()

  // The final-video uniqueness policy is episode-wide. Checking it before a
  // pilot/partial scope makes SQL edits and short previews unable to bypass it.
  const missingCells = allStoryboards.filter((sb) => !parseDharmaCell(sb.gridCells)).map((sb) => sb.storyboardNumber)
  if (missingCells.length) {
    throw new Error(
      `有 ${missingCells.length} 个分镜缺少 dharma 素材指派（#${missingCells.join(', #')}）。` +
      `先用 POST /api/v1/dharma/episode/${episodeId}/footage 完成素材指派再渲染`,
    )
  }
  for (const sb of allStoryboards) {
    const cell = parseDharmaCell(sb.gridCells)!
    requireDharmaVisualRole(cell, sb.storyboardNumber)
    requireDharmaVisualSemanticContract(cell, sb.storyboardNumber)
    const kind: DharmaAssignedAssetKind = cell.video?.src ? 'video' : 'image'
    const src = cell.video?.src ?? cell.image?.src ?? ''
    try {
      resolveDharmaAssignedAssetPath(src, kind)
    } catch (error) {
      throw new Error(`分镜 #${sb.storyboardNumber} 的素材不合规：${error instanceof Error ? error.message : String(error)}`)
    }
    if (cell.video) {
      const provenanceError = validateDharmaVideoProvenance(cell.video, manifestIndex)
      if (provenanceError) throw new Error(`分镜 #${sb.storyboardNumber} 的素材不合规：${provenanceError}`)
    }
  }
  const duplicateSources = findNonAdjacentDharmaAssetReuse(allStoryboards.map((sb) => {
    const cell = parseDharmaCell(sb.gridCells)!
    const src = cell.video?.src ?? cell.image?.src ?? ''
    return {
      storyboardNumber: sb.storyboardNumber,
      kind: cell.video?.src ? 'video' as const : 'image' as const,
      src,
      sourceKey: canonicalDharmaAssetKey(src),
      ...(cell.image?.generatedSegmentTaskId != null ? { generatedSegmentTaskId: cell.image.generatedSegmentTaskId } : {}),
    }
  }))
  if (duplicateSources.length) {
    throw new Error(
      `同一素材不能在不同视觉段落重复使用：${formatDharmaAssetReuse(duplicateSources)}。` +
      '请为后续段落更换新的本地素材；相邻分镜可继续共用同一素材作为一个段落',
    )
  }
  const roleMismatches = findAdjacentDharmaSegmentRoleMismatches(allStoryboards.map((sb) => {
    const cell = parseDharmaCell(sb.gridCells)!
    const src = cell.video?.src ?? cell.image?.src ?? ''
    return {
      storyboardNumber: sb.storyboardNumber,
      kind: cell.video?.src ? 'video' as const : 'image' as const,
      src,
      role: requireDharmaVisualRole(cell, sb.storyboardNumber),
      sourceKey: canonicalDharmaAssetKey(src),
    }
  }))
  if (roleMismatches.length) {
    throw new Error(
      `同一连续视频段落不能混用视觉角色：${formatDharmaVisualRoleMismatches(roleMismatches)}。` +
      '相邻且同源的视频会合并为一个画面，请为整个段落指定同一角色',
    )
  }

  const storyboards = allStoryboards.filter((sb) => !selected || selected.has(sb.id))
  if (!storyboards.length) throw new Error(`Episode ${episodeId} 没有分镜；先完成文稿导入（import-script）`)

  let cursor = 0
  const allTimings: StoryboardTiming[] = []
  for (const sb of allStoryboards) {
    const narration = resolveStoryboardNarration(sb)
    if (!narration) continue  // 空分镜（breaker 产生的无声 beat）直接跳过，不参与时序定位
    const located = locateNarrationWindow(timeline, narration, cursor)
    if (!located) {
      throw new Error(
        `分镜 #${sb.storyboardNumber} 的旁白无法在 TTS 主时间轴上定位「${narration.slice(0, 24)}…」。` +
        `禁止估算渲染：请确认分镜旁白与 preTtsTitlesJson 同源（重新导入文稿或重跑 tts.pre_generate）`,
      )
    }
    cursor = located.cursor
    const startMs = Math.round(masterTimeAt(timeline, located.start) * 1000)
    const endMs = Math.round(masterTimeAt(timeline, located.end) * 1000)
    if (!(endMs > startMs)) throw new Error(`分镜 #${sb.storyboardNumber} 时序窗口无效（${startMs}→${endMs}ms）`)
    allTimings.push({ sb, cell: parseDharmaCell(sb.gridCells)!, narration, charStart: located.start, charEnd: located.end, startMs, endMs })
  }

  // 时序门禁：窗口必须单调不减（主时间轴顺序铺设时天然满足；±500ms 容差吸相邻舍入）
  for (let i = 1; i < allTimings.length; i++) {
    if (allTimings[i].startMs < allTimings[i - 1].endMs - 500) {
      throw new Error(
        `分镜时序窗口重叠/乱序（#${allTimings[i - 1].sb.storyboardNumber} 结束于 ${allTimings[i - 1].endMs}ms，` +
        `#${allTimings[i].sb.storyboardNumber} 起始于 ${allTimings[i].startMs}ms），TTS 主时间轴与分镜旁白不同源`,
      )
    }
  }

  const timings = selected ? allTimings.filter((timing) => selected.has(timing.sb.id)) : allTimings
  return { timings, allTimings, subtitleFallbackCandidates: 0 }
}

export type DharmaCanaryRiskReason =
  | 'static_image_motion'
  | 'quote_card'
  | 'slow_video'
  | 'mixed_media_transition'

export interface DharmaFullPlanReport extends Record<string, unknown> {
  valid: boolean
  creativePlanError?: string
  durationSec: number
  storyboardCount: number
  segmentCount: number
  videoSegmentCount: number
  imageSegmentCount: number
  generatedImageSegmentCount: number
  generatedImageSegmentBudget: { min: number; max: number }
  generatedImageCoverageRatio: number
  maxSingleGeneratedImageCoverageRatio: number
  videoCoverageRatio: number
  emotionalStyleIds: string[]
  emotionSequence: DharmaEmotion[]
  emotionCoverageMs: Record<DharmaEmotion, number>
  styleCoverageMs: Record<string, number>
  quoteCount: number
  sacredCoverageRatio: number
  mediaProbeCount: number
  canaryRequirement: 'required' | 'not_required'
  canaryReasons: DharmaCanaryRiskReason[]
  canaryWindow: DharmaCanaryWindow | null
}

export interface DharmaCompiledProductionPlan {
  episode: typeof schema.episodes.$inferSelect
  timeline: MasterTimeline
  allTimings: StoryboardTiming[]
  fullSegments: DharmaSegmentWindow[]
  cellsByStoryboardNumber: Map<number, DharmaCell>
  sourceDurationsSec: Map<string, number>
  narrationPath: string
  narrationDurationSec: number
  bgmPath: string
  bgmDurationSec: number
  fullPlanFingerprint: string
  report: DharmaFullPlanReport
  creativePlan: DharmaCreativePlanSummary | null
  canary:
    | { requirement: 'not_required'; reasons: DharmaCanaryRiskReason[] }
    | {
        requirement: 'required'
        reasons: DharmaCanaryRiskReason[]
        window: DharmaCanaryWindow
        fingerprint: string
      }
}

async function probeDharmaProductionMediaDurations(
  sources: Array<{ key: string; path: string; label: string }>,
  signal?: AbortSignal,
  concurrency = 4,
): Promise<Map<string, number>> {
  const durations = new Map<string, number>()
  const errors: string[] = []
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < sources.length) {
      const source = sources[nextIndex++]
      const duration = await probeMediaDurationSec(source.path, { signal })
      if (duration === null) errors.push(`无法读取${source.label}时长：${source.path}`)
      else durations.set(source.key, duration)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), sources.length) }, worker))
  if (errors.length) throw new Error(`全片预检失败：${errors.join('；')}`)
  return durations
}

function addDharmaCanaryRisk(
  risks: Map<number, Set<DharmaCanaryRiskReason>>,
  storyboardNumber: number,
  reason: DharmaCanaryRiskReason,
) {
  const current = risks.get(storyboardNumber) ?? new Set<DharmaCanaryRiskReason>()
  current.add(reason)
  risks.set(storyboardNumber, current)
}

/**
 * Compile and validate the complete episode before loudness scans, proxy
 * generation, bundling, or Remotion can consume production time.
 */
export async function compileDharmaProductionPlan(
  episodeId: number,
  options: {
    signal?: AbortSignal
    mediaProbeConcurrency?: number
    validationMode?: 'production' | 'semantic_preview'
  } = {},
): Promise<DharmaCompiledProductionPlan> {
  const [episode] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!episode) throw new Error(`Episode ${episodeId} 不存在或已删除`)
  if (!episode.preTtsAudioUrl || !episode.preTtsTitlesJson) {
    throw new Error(`Episode ${episodeId} 缺少 TTS 主音轨/时间轴（preTtsAudioUrl/preTtsTitlesJson）`)
  }
  if (!episode.bgmAudioUrl) throw new Error(`Episode ${episodeId} 未配置 BGM（bgm_audio_url）`)

  const initialFingerprint = buildDharmaEpisodeInputFingerprint(episodeId)
  const timeline = buildMasterTimeline(episode.preTtsTitlesJson)
  if (!timeline) throw new Error(`Episode ${episodeId} 的 preTtsTitlesJson 无法解析为有效时间轴`)
  const { allTimings } = resolveStoryboardTimings(episodeId, timeline)
  if (!allTimings.length) throw new Error(`Episode ${episodeId} 没有可定位的有声分镜`)

  const visualPlan = validateDharmaProductionVisualPlan(allTimings.map((timing) => ({
    startMs: timing.startMs,
    endMs: timing.endMs,
    role: requireDharmaVisualRole(timing.cell, timing.sb.storyboardNumber),
  })))
  const generatedImageOwnership = validateDharmaGeneratedImageOwnership(episodeId)

  const fullSegments = fillDharmaVisualGaps(mergeDharmaSegments(allTimings.map((timing) => ({
    storyboardNumber: timing.sb.storyboardNumber,
    startMs: timing.startMs,
    endMs: timing.endMs,
    kind: timing.cell.video?.src ? 'video' as const : 'image' as const,
    src: timing.cell.video?.src ?? timing.cell.image?.src ?? '',
    ...(timing.cell.image?.generatedSegmentTaskId != null
      ? { generatedSegmentTaskId: timing.cell.image.generatedSegmentTaskId }
      : {}),
  }))))
  let creativePlan: DharmaCreativePlanSummary | null = null
  let creativePlanError: string | undefined
  try {
    creativePlan = validateDharmaCreativeProductionPlan(allTimings.map((timing) => ({
      storyboardNumber: timing.sb.storyboardNumber,
      startMs: timing.startMs,
      endMs: timing.endMs,
      cell: timing.cell,
    })), { verifiedGeneratedImageTaskIds: generatedImageOwnership.taskIds })
  } catch (error) {
    if (options.validationMode !== 'semantic_preview') throw error
    creativePlanError = (error as Error).message
  }
  const repeatedSegments = findDharmaSegmentAssetReuse(fullSegments)
  if (repeatedSegments.length) {
    throw new Error(
      `同一素材不能在不同视觉段落重复使用：${formatDharmaAssetReuse(repeatedSegments)}。` +
      '请为后续段落更换新的本地素材；视频只有在实际合并为同一连续段时才可共用',
    )
  }

  const narrationPath = resolveStaticPath(String(episode.preTtsAudioUrl))
  const bgmPath = resolveStaticPath(String(episode.bgmAudioUrl))
  if (!fs.existsSync(narrationPath)) throw new Error(`TTS 主音轨文件缺失：${episode.preTtsAudioUrl}`)
  if (!fs.existsSync(bgmPath)) throw new Error(`BGM 文件缺失：${episode.bgmAudioUrl}`)

  const uniqueVideoSources = [...new Set(fullSegments
    .filter((segment) => segment.kind === 'video')
    .map((segment) => segment.src))]
  const videoPaths = new Map(uniqueVideoSources.map((src) => [src, resolveDharmaAssignedAssetPath(src, 'video')]))
  const durationSources = [
    { key: 'narration', path: narrationPath, label: '旁白' },
    { key: 'bgm', path: bgmPath, label: ' BGM' },
    ...[...videoPaths].map(([src, sourcePath]) => ({ key: `video:${src}`, path: sourcePath, label: `视频素材 ${src} 的` })),
  ]
  const mediaDurations = await probeDharmaProductionMediaDurations(
    durationSources,
    options.signal,
    options.mediaProbeConcurrency,
  )
  const narrationDurationSec = mediaDurations.get('narration')!
  const bgmDurationSec = mediaDurations.get('bgm')!
  if (bgmDurationSec < MIN_BGM_DURATION_SEC) {
    throw new Error(`BGM 时长 ${bgmDurationSec.toFixed(1)}s 低于 ${MIN_BGM_DURATION_SEC}s 下限；换更长的曲目`)
  }

  let titles: Array<{ time_begin?: unknown; time_end?: unknown }>
  try {
    const parsed = JSON.parse(episode.preTtsTitlesJson)
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('empty titles')
    titles = parsed
  } catch {
    throw new Error('preTtsTitlesJson 解析失败；重跑 tts.pre_generate')
  }
  const coveredMs = Number(titles.at(-1)?.time_end ?? 0) - Number(titles[0]?.time_begin ?? 0)
  const coverageRatio = coveredMs / 1000 / narrationDurationSec
  if (!Number.isFinite(coverageRatio) || coverageRatio < 0.6 || coverageRatio > 1.05) {
    throw new Error(
      `titles 覆盖率 ${Number.isFinite(coverageRatio) ? coverageRatio.toFixed(2) : '无效'} ` +
      `超出 0.60–1.05（主音轨 ${narrationDurationSec.toFixed(1)}s）；重跑 tts.pre_generate`,
    )
  }

  const sourceDurationsSec = new Map<string, number>()
  for (const src of uniqueVideoSources) sourceDurationsSec.set(src, mediaDurations.get(`video:${src}`)!)
  const cellsByStoryboardNumber = new Map(allTimings.map((timing) => [timing.sb.storyboardNumber, timing.cell]))
  const playbackPlans = validateDharmaSegmentPlaybackPlan(fullSegments, cellsByStoryboardNumber, sourceDurationsSec)

  const risks = new Map<number, Set<DharmaCanaryRiskReason>>()
  let quoteCount = 0
  for (const timing of allTimings) {
    if (timing.cell.image && timing.cell.image.generatedSegmentTaskId == null && timing.cell.image.move !== 'hold') {
      addDharmaCanaryRisk(
        risks,
        timing.sb.storyboardNumber,
        'static_image_motion',
      )
    }
    if (timing.cell.quote?.text) {
      const quote = normalizeDharmaQuoteText(timing.cell.quote.text)
      if ('error' in quote) throw new Error(`分镜 #${timing.sb.storyboardNumber} ${quote.error}`)
      quoteCount += 1
      if (Array.from(quote.text).length > 24 || Array.from(timing.cell.quote.source ?? '').length > 20) {
        addDharmaCanaryRisk(risks, timing.sb.storyboardNumber, 'quote_card')
      }
    }
  }
  for (const playback of playbackPlans) {
    if (playback.playbackRate < 0.75) {
      addDharmaCanaryRisk(risks, playback.storyboardNumbers[0], 'slow_video')
    }
  }
  for (let index = 1; index < fullSegments.length; index += 1) {
    const previous = fullSegments[index - 1]
    const current = fullSegments[index]
    const previousDurationMs = previous.endMs - previous.startMs
    const currentDurationMs = current.endMs - current.startMs
    if (previous.kind !== current.kind && Math.min(previousDurationMs, currentDurationMs) < 2_000) {
      addDharmaCanaryRisk(risks, fullSegments[index].storyboardNumbers[0], 'mixed_media_transition')
    }
  }

  const canaryCandidates: DharmaCanaryWindowCandidate[] = allTimings.map((timing) => ({
    storyboardId: timing.sb.id,
    storyboardNumber: timing.sb.storyboardNumber,
    startMs: timing.startMs,
    endMs: timing.endMs,
    riskReasons: [...(risks.get(timing.sb.storyboardNumber) ?? [])],
  }))
  const canaryWindow = selectDharmaCanaryWindow(canaryCandidates)
  const canaryReasons = [...new Set(canaryCandidates.flatMap((candidate) => candidate.riskReasons))]
    .sort() as DharmaCanaryRiskReason[]
  const canary = canaryWindow
    ? {
        requirement: 'required' as const,
        reasons: canaryReasons,
        window: canaryWindow,
        fingerprint: buildDharmaCanaryInputFingerprint(episodeId, canaryWindow.storyboardIds),
      }
    : { requirement: 'not_required' as const, reasons: [] as DharmaCanaryRiskReason[] }

  const finalFingerprint = buildDharmaEpisodeInputFingerprint(episodeId)
  const finalGeneratedImageOwnership = validateDharmaGeneratedImageOwnership(episodeId)
  const generatedEvidenceChanged = finalGeneratedImageOwnership.taskIds.size !== generatedImageOwnership.taskIds.size
    || [...generatedImageOwnership.taskIds].some((taskId) => !finalGeneratedImageOwnership.taskIds.has(taskId))
    || finalGeneratedImageOwnership.generationIds.size !== generatedImageOwnership.generationIds.size
    || [...generatedImageOwnership.generationIds].some(
      (generationId) => !finalGeneratedImageOwnership.generationIds.has(generationId),
    )
  if (generatedEvidenceChanged) {
    throw new Error('AI 关键图证据在预检期间发生变化；请等待生成任务稳定后重新预检')
  }
  if (initialFingerprint !== finalFingerprint) {
    throw new Error('全片输入在预检期间发生变化；请在素材、旁白和 BGM 稳定后重新预检')
  }
  const imageSegments = fullSegments.filter((segment) => segment.kind === 'image')
  const report: DharmaFullPlanReport = {
    valid: creativePlan !== null,
    ...(creativePlanError ? { creativePlanError } : {}),
    durationSec: (allTimings[allTimings.length - 1].endMs - allTimings[0].startMs) / 1000,
    storyboardCount: allTimings.length,
    segmentCount: fullSegments.length,
    videoSegmentCount: fullSegments.length - imageSegments.length,
    imageSegmentCount: imageSegments.length,
    generatedImageSegmentCount: creativePlan?.generatedImageSegmentCount ?? 0,
    generatedImageSegmentBudget: creativePlan?.generatedImageSegmentBudget ?? resolveDharmaGeneratedImageSegmentBudget(
      allTimings[allTimings.length - 1].endMs - allTimings[0].startMs,
    ),
    generatedImageCoverageRatio: creativePlan?.generatedImageCoverageRatio ?? 0,
    maxSingleGeneratedImageCoverageRatio: creativePlan?.maxSingleGeneratedImageCoverageRatio ?? 0,
    videoCoverageRatio: creativePlan?.videoCoverageRatio ?? 0,
    emotionalStyleIds: creativePlan?.styleIds ?? [],
    emotionSequence: creativePlan?.emotionSequence ?? [],
    emotionCoverageMs: creativePlan?.coverageMsByEmotion ?? emptyDharmaEmotionCoverage(),
    styleCoverageMs: creativePlan?.coverageMsByStyle ?? {},
    quoteCount,
    sacredCoverageRatio: visualPlan.sacredCoverageRatio,
    mediaProbeCount: durationSources.length,
    canaryRequirement: canary.requirement,
    canaryReasons,
    canaryWindow,
  }
  return {
    episode,
    timeline,
    allTimings,
    fullSegments,
    cellsByStoryboardNumber,
    sourceDurationsSec,
    narrationPath,
    narrationDurationSec,
    bgmPath,
    bgmDurationSec,
    fullPlanFingerprint: finalFingerprint,
    report,
    creativePlan,
    canary,
  }
}

export async function buildDharmaProps(episodeId: number, opts: DharmaBuildOptions = {}): Promise<DharmaBuildResult> {
  if (opts.validationMode === 'semantic_preview'
    && (!opts.onlyStoryboardIds?.length || !isDharmaReviewPilotDuration(opts.maxDurationSec))) {
    throw new Error('semantic_preview 只允许连续分镜子集的精确 60 秒验证，不得绕过正式整集门禁')
  }
  const compiled = opts.compiledPlan ?? await compileDharmaProductionPlan(episodeId, {
    signal: opts.signal,
    validationMode: opts.validationMode,
  })
  if (compiled.episode.id !== episodeId) throw new Error('compiled Dharma plan belongs to a different episode')
  if (buildDharmaEpisodeInputFingerprint(episodeId) !== compiled.fullPlanFingerprint) {
    throw new Error('全片输入在预检后发生变化；已拒绝复用过期的编译计划')
  }
  const ep = compiled.episode

  let timings = compiled.allTimings
  if (opts.onlyStoryboardIds?.length) {
    const selectedNumbers = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
      .filter((sb) => opts.onlyStoryboardIds!.includes(sb.id))
      .map((sb) => sb.storyboardNumber)
    if (selectedNumbers.length !== new Set(opts.onlyStoryboardIds).size) throw new Error('unknown storyboardId')
    if (!areStoryboardNumbersContiguous(selectedNumbers)) {
      throw new Error('non-contiguous storyboard render would skip narration')
    }
    const selectedIds = new Set(opts.onlyStoryboardIds)
    timings = compiled.allTimings.filter((timing) => selectedIds.has(timing.sb.id))
  }
  const timeline = compiled.timeline

  const timingScope = scopeDharmaTimingWindowsToDuration(timings, opts.maxDurationSec, timeline)
  const scoped = timingScope.windows
  if (!scoped.length) throw new Error('预算/范围内没有可渲染的分镜')

  // 段落合并：相邻同素材视频分镜合成一个视觉段落
  const segmentInputs: DharmaWindowInput[] = scoped.map((t) => ({
    storyboardNumber: t.sb.storyboardNumber,
    startMs: t.startMs,
    endMs: t.endMs,
    kind: t.cell.video?.src ? 'video' : 'image',
    src: t.cell.video?.src ?? t.cell.image?.src ?? '',
    ...(t.cell.image?.generatedSegmentTaskId != null
      ? { generatedSegmentTaskId: t.cell.image.generatedSegmentTaskId }
      : {}),
  }))
  const merged = extendDharmaVisualTail(
    fillDharmaVisualGaps(mergeDharmaSegments(segmentInputs)),
    timingScope.visualTailEndMs,
  )

  const firstStartMs = scoped[0].startMs
  const cellByStoryboardNumber = new Map(scoped.map((t) => [t.sb.storyboardNumber, t.cell]))

  // This is intentionally before loudnorm and proxy generation. A duration cap
  // can extend the final visual tail, so validate the exact render scope even
  // though the complete episode was already compiled.
  validateDharmaSegmentPlaybackPlan(merged, cellByStoryboardNumber, compiled.sourceDurationsSec)

  // The two full-file loudnorm scans are independent and run concurrently.
  const [narrationLoudness, bgmLoudness] = await Promise.all([
    probeDharmaAudioLoudness(compiled.narrationPath, { signal: opts.signal }),
    probeDharmaAudioLoudness(compiled.bgmPath, { signal: opts.signal }),
  ])
  if (!narrationLoudness) throw new Error(`无法测量旁白响度：${ep.preTtsAudioUrl}（ffmpeg loudnorm 失败）`)
  if (!bgmLoudness) throw new Error(`无法测量 BGM 响度：${ep.bgmAudioUrl}（ffmpeg loudnorm 失败）`)
  const bgmMix = deriveDharmaBgmMix(narrationLoudness, bgmLoudness, compiled.bgmDurationSec)
  const stagedMaster = stageDharmaAsset(compiled.narrationPath)
  const stagedBgm = stageDharmaAsset(compiled.bgmPath)

  const videoSources = merged
    .filter((seg) => seg.kind === 'video')
    .map((seg) => resolveDharmaAssignedAssetPath(seg.src, 'video'))
  const deliveryAssets = await prepareDharmaDeliveryAssets(videoSources, {
    signal: opts.signal,
    concurrency: opts.deliveryProxyConcurrency,
    onDeliveryProxy: opts.onDeliveryProxy,
  })

  const segments = merged.map((seg, segmentIndex) => {
    const { startFrame, durationInFrames } = resolveDharmaSegmentFrameWindow(seg.startMs, seg.endMs)
    const crossfadeLeadFrames = resolveDharmaCrossfadeLeadFrames(durationInFrames, segmentIndex)
    const leadCell = resolveSegmentLeadCell(seg, cellByStoryboardNumber)
    const creative = requireDharmaCreativeMetadata(leadCell, seg.storyboardNumbers[0])
    if (seg.kind === 'video') {
      const cell = leadCell.video
      if (!cell) throw new Error(`视觉段落 #${seg.storyboardNumbers[0]} 缺少视频素材指派`)
      // Remotion mounts incoming video before its semantic window for the
      // crossfade. Include those frames in the source budget so an exactly
      // sized clip cannot freeze or run past EOF during the fade.
      const renderedDurationSec = (durationInFrames + crossfadeLeadFrames) / FPS
      const abs = resolveDharmaAssignedAssetPath(seg.src, 'video')
      const delivery = deliveryAssets.bySourcePath.get(path.resolve(abs))
      if (!delivery) throw new Error(`素材 delivery proxy 缺失：${seg.src}`)
      const clipDurationSec = delivery.deliveryDurationSec
      const timing = resolveVideoWindowTiming(clipDurationSec, renderedDurationSec, cell.sourceStartSec)
      return {
        kind: 'video' as const,
        src: stageDharmaAsset(delivery.deliveryPath),
        startFrame,
        durationInFrames,
        crossfadeLeadFrames,
        sourceStartSec: timing.sourceStartSec,
        playbackRate: timing.playbackRate,
        ...(cell.focusX !== undefined ? { focusX: cell.focusX } : {}),
        ...(cell.focusY !== undefined ? { focusY: cell.focusY } : {}),
        ...(cell.grade ? { grade: cell.grade } : {}),
        ...(leadCell.theme ? { theme: leadCell.theme } : {}),
        emotion: creative.emotion,
        styleId: creative.style.id,
        treatment: creative.style.treatment,
        ...(leadCell.shotFunction ? { shotFunction: leadCell.shotFunction } : {}),
      }
    }
    const imageCell = leadCell.image
    if (!imageCell) throw new Error(`视觉段落 #${seg.storyboardNumbers[0]} 缺少静态图素材指派`)
    const abs = resolveDharmaAssignedAssetPath(seg.src, 'image')
    return {
      kind: 'image' as const,
      src: stageDharmaAsset(abs),
      startFrame,
      durationInFrames,
      crossfadeLeadFrames,
      move: imageCell.move ?? creative.style.defaultMove,
      emotion: creative.emotion,
      styleId: creative.style.id,
      treatment: creative.style.treatment,
      ...(leadCell.shotFunction ? { shotFunction: leadCell.shotFunction } : {}),
      ...(leadCell.theme ? { theme: leadCell.theme } : {}),
    }
  })

  // 金句卡：锚定在主时间轴中真正说出该短语的位置，而不是覆盖整个 storyboard。
  const quotes = scoped
    .filter((t) => t.cell.quote?.text)
    .map((t) => {
      const quote = normalizeDharmaQuoteText(t.cell.quote!.text)
      if ('error' in quote) throw new Error(`分镜 #${t.sb.storyboardNumber} ${quote.error}`)
      const quoteTiming = resolveDharmaQuoteTimingWindow(t, quote.text, timeline)
      if (!quoteTiming) {
        throw new Error(
          `分镜 #${t.sb.storyboardNumber} 的金句「${quote.text}」无法在该分镜 TTS 旁白中精确定位；` +
          '金句必须是当前正在说出的短语，不能用整镜覆盖或靠字幕隐藏兜底',
        )
      }
      return {
        text: quote.text,
        ...(t.cell.quote!.source ? { source: String(t.cell.quote!.source) } : {}),
        startFrame: Math.round((quoteTiming.startMs / 1000) * FPS),
        durationInFrames: Math.max(1, Math.round(((quoteTiming.endMs - quoteTiming.startMs) / 1000) * FPS)),
      }
    })

  // 全局分句字幕：绝对时间（相对渲染 0 帧 = 首个分镜起点），主时间轴插值，
  // 定位失败的分镜回退为窗口内均分并计数上报。
  let subtitleFallbacks = 0
  const subtitles: Array<{ text: string; startSec: number; endSec: number }> = []
  for (const t of scoped) {
    const shotStartSec = t.startMs / 1000
    let clauses = buildMasterSubtitleClauses(t.narration, { start: t.charStart, end: t.charEnd }, timeline, shotStartSec)
    if (!clauses) {
      clauses = buildWindowSubtitleClauses(t.narration, (t.endMs - t.startMs) / 1000)
      if (clauses) subtitleFallbacks += 1
    }
    if (!clauses) continue
    for (const clause of clauses) {
      subtitles.push({
        text: clause.text,
        startSec: clause.startSec + shotStartSec - firstStartMs / 1000,
        endSec: clause.endSec + shotStartSec - firstStartMs / 1000,
      })
    }
  }

  // 绝对帧位重定基：渲染 0 帧 = 首个分镜起点（子集渲染时主音轨用 startFrom 同步裁剪）
  const audioStartFrame = Math.round((firstStartMs / 1000) * FPS)
  const narrationWindows = mergeDharmaNarrationWindows(scoped.map((t) => ({
    startFrame: Math.round((t.startMs / 1000) * FPS) - audioStartFrame,
    endFrame: Math.max(1, Math.round((t.endMs / 1000) * FPS) - audioStartFrame),
  })))
  const narrationEndFrame = narrationWindows.reduce((endFrame, window) => Math.max(endFrame, window.endFrame), 0)
  for (const seg of segments) seg.startFrame -= audioStartFrame
  for (const quote of quotes) quote.startFrame -= audioStartFrame

  const durationInFrames = timingScope.durationInFrames
    ?? segments.reduce((a, s) => Math.max(a, s.startFrame + s.durationInFrames), 0)
  // `opening_hook` belongs to older drama flows and can be stale. Episode title is
  // the safe fallback for the 2–3 second opening invocation until an explicitly
  // approved Dharma opening-copy field is introduced.
  const openingText = String(ep.title || '').trim()
  const includesEpisodeOpening = scoped[0]?.sb.id === compiled.allTimings[0]?.sb.id
  const opening = openingText && includesEpisodeOpening && segments[0]
    ? {
      text: openingText,
      startFrame: 0,
      durationInFrames: Math.max(1, Math.min(96, Math.max(1, segments[0].durationInFrames - 6))),
    }
    : undefined

  const propsDir = getAbsolutePath('temp')
  fs.mkdirSync(propsDir, { recursive: true })
  const suffix = timingScope.durationInFrames !== undefined ? `-pilot-${Math.round(Number(opts.maxDurationSec))}s` : ''
  const propsPath = path.join(propsDir, `dharma-props-${episodeId}${suffix}.json`)
  fs.writeFileSync(
    propsPath,
    JSON.stringify(
      {
        durationInFrames,
        audio: stagedMaster,
        ...(audioStartFrame > 0 ? { audioStartFrame } : {}),
        ...(narrationEndFrame > 0 ? { narrationEndFrame } : {}),
        bgm: {
          src: stagedBgm,
          ...bgmMix,
        },
        segments,
        ...(opening ? { opening } : {}),
        quotes,
        subtitles,
        narrationWindows,
      },
      null,
      2,
    ),
  )

  return {
    propsPath,
    segmentCount: segments.length,
    quoteCount: quotes.length,
    durationInFrames,
    subtitleFallbacks,
    bgm: bgmMix,
    deliveryProxy: deliveryAssets.summary,
  }
}
