/**
 * Movement / Motion 计划生成与解析
 *
 * 借鉴 HyperFrames 的 seekable animation 思想：把自然语言运镜描述解析成
 * 确定性的关键帧计划，再交给 FFmpeg zoompan 执行。
 */
import type { MotionKeyframe, MotionPlan } from './types.js'

export function buildDeterministicMotionPlan(seed: number): MotionPlan {
  const presets = [
    { name: 'zoom-in-center', startZoom: 1, endZoom: 1.18, startX: 0.5, endX: 0.5, startY: 0.5, endY: 0.5 },
    { name: 'zoom-in-top-left', startZoom: 1, endZoom: 1.2, startX: 0.35, endX: 0.65, startY: 0.35, endY: 0.65 },
    { name: 'zoom-out-center', startZoom: 1.2, endZoom: 1, startX: 0.5, endX: 0.5, startY: 0.5, endY: 0.5 },
    { name: 'pan-right', startZoom: 1.12, endZoom: 1.12, startX: 0.35, endX: 0.65, startY: 0.5, endY: 0.5 },
    { name: 'pan-down', startZoom: 1.12, endZoom: 1.12, startX: 0.5, endX: 0.5, startY: 0.35, endY: 0.65 },
    { name: 'pan-diagonal', startZoom: 1.1, endZoom: 1.18, startX: 0.3, endX: 0.7, startY: 0.3, endY: 0.7 },
  ]
  const preset = presets[Math.abs(seed) % presets.length]

  return {
    kind: preset.name.includes('pan') ? 'pan' : 'kenburns',
    durationScale: 1,
    keyframes: [
      { t: 0, focusX: preset.startX, focusY: preset.startY, zoom: preset.startZoom },
      { t: 1, focusX: preset.endX, focusY: preset.endY, zoom: preset.endZoom },
    ],
  }
}

const DIRECTION_KEYWORDS = {
  zoomIn: ['推近', 'zoom in', 'push in', '逼近', '放大'],
  zoomOut: ['拉远', 'zoom out', 'pull back', '推远', '缩小'],
  panLeft: ['向左', '左移', '左摇', '左平移', '横摇左', 'pan left', 'move left'],
  panRight: ['向右', '右移', '右摇', '右平移', '横摇右', 'pan right', 'move right'],
  panUp: ['向上', '上移', '上摇', '上摇镜', 'pan up', 'move up'],
  panDown: ['向下', '下移', '下摇', '下摇镜', 'pan down', 'move down'],
  panGeneric: ['平移', '横摇', '摇镜', 'pan', 'tilt'],
}

const SUBJECT_KEYWORDS: Array<{ keywords: string[]; focusX: number; focusY: number; zoomBias: number }> = [
  { keywords: ['面部', '脸', '眼神', 'face', 'eyes'], focusX: 0.5, focusY: 0.42, zoomBias: 1.25 },
  { keywords: ['手部', '手', 'hand'], focusX: 0.5, focusY: 0.65, zoomBias: 1.18 },
  { keywords: ['物品', '物件', 'object', '道具'], focusX: 0.5, focusY: 0.55, zoomBias: 1.15 },
  { keywords: ['建筑', '宫殿', '城堡', 'building', 'palace', 'castle'], focusX: 0.5, focusY: 0.45, zoomBias: 1.08 },
  { keywords: ['全景', ' wide', 'full', '远景'], focusX: 0.5, focusY: 0.5, zoomBias: 1.0 },
]

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw))
}

function detectSubject(text: string): { focusX: number; focusY: number; zoomBias: number } {
  for (const subject of SUBJECT_KEYWORDS) {
    if (containsAny(text, subject.keywords)) {
      return { focusX: subject.focusX, focusY: subject.focusY, zoomBias: subject.zoomBias }
    }
  }
  return { focusX: 0.5, focusY: 0.5, zoomBias: 1.0 }
}

function detectDurationScale(text: string): number {
  if (containsAny(text, ['急速', '快速', '快', 'fast', 'quick', 'rapid'])) return 0.7
  if (containsAny(text, ['缓慢', '慢速', '慢', 'slow', 'gentle'])) return 1.0
  return 1.0
}

interface Direction {
  kind: 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'panUp' | 'panDown'
  subject: { focusX: number; focusY: number; zoomBias: number }
}

function detectDirections(text: string): Direction[] {
  const directions: Direction[] = []
  const subject = detectSubject(text)

  const addIf = (kind: Direction['kind'], keywords: string[]) => {
    if (containsAny(text, keywords)) {
      directions.push({ kind, subject })
    }
  }

  addIf('zoomIn', DIRECTION_KEYWORDS.zoomIn)
  addIf('zoomOut', DIRECTION_KEYWORDS.zoomOut)
  addIf('panLeft', DIRECTION_KEYWORDS.panLeft)
  addIf('panRight', DIRECTION_KEYWORDS.panRight)
  addIf('panUp', DIRECTION_KEYWORDS.panUp)
  addIf('panDown', DIRECTION_KEYWORDS.panDown)

  // 仅出现“横摇/平移/pan/tilt”等泛化词时，默认向右平移
  if (directions.length === 0 && containsAny(text, DIRECTION_KEYWORDS.panGeneric)) {
    directions.push({ kind: 'panRight', subject })
  }

  return directions
}

function directionToKeyframes(direction: Direction): [MotionKeyframe, MotionKeyframe] {
  const { focusX, focusY, zoomBias } = direction.subject
  switch (direction.kind) {
    case 'zoomIn':
      return [
        { t: 0, focusX, focusY, zoom: 1 },
        { t: 1, focusX, focusY, zoom: 1.18 * zoomBias },
      ]
    case 'zoomOut':
      return [
        { t: 0, focusX, focusY, zoom: 1.18 * zoomBias },
        { t: 1, focusX, focusY, zoom: 1 },
      ]
    case 'panLeft':
      return [
        { t: 0, focusX: 0.65, focusY, zoom: 1.12 },
        { t: 1, focusX: 0.35, focusY, zoom: 1.12 },
      ]
    case 'panRight':
      return [
        { t: 0, focusX: 0.35, focusY, zoom: 1.12 },
        { t: 1, focusX: 0.65, focusY, zoom: 1.12 },
      ]
    case 'panUp':
      return [
        { t: 0, focusX, focusY: 0.65, zoom: 1.12 },
        { t: 1, focusX, focusY: 0.35, zoom: 1.12 },
      ]
    case 'panDown':
      return [
        { t: 0, focusX, focusY: 0.35, zoom: 1.12 },
        { t: 1, focusX, focusY: 0.65, zoom: 1.12 },
      ]
  }
}

/**
 * 从自然语言 movement 描述解析 MotionPlan。
 * 支持中文/英文，支持单段运动和“先...再...”多段运动。
 * 无法解析时返回 null，调用方应回退到 buildDeterministicMotionPlan。
 */
export function parseMovement(movement?: string | null): MotionPlan | null {
  const raw = movement?.trim()
  if (!raw) return null

  const text = raw.toLowerCase()

  // 多段运动：按“先...再...”、“然后”、“接着”、“，”拆分
  const segments = text
    .split(/(?:先|再|然后|接着|之后|，|,)/)
    .map((s) => s.trim())
    .filter(Boolean)

  const allDirections: Direction[] = []
  for (const segment of segments) {
    const dirs = detectDirections(segment)
    allDirections.push(...dirs)
  }

  if (allDirections.length === 0) return null

  // 合并多个方向为关键帧序列
  const keyframes: MotionKeyframe[] = []
  allDirections.forEach((dir, index) => {
    const [start, end] = directionToKeyframes(dir)
    const tStart = index / allDirections.length
    const tEnd = (index + 1) / allDirections.length
    keyframes.push({ ...start, t: tStart }, { ...end, t: tEnd })
  })

  // 去重并按 t 排序
  const normalized = keyframes
    .filter((k, i, arr) => i === 0 || k.t !== arr[i - 1].t)
    .sort((a, b) => a.t - b.t)

  const hasZoom = normalized.some((k, i) => i > 0 && k.zoom !== normalized[i - 1].zoom)
  const hasPan = normalized.some((k, i) => i > 0 && (k.focusX !== normalized[i - 1].focusX || k.focusY !== normalized[i - 1].focusY))

  let kind: MotionPlan['kind'] = 'static'
  if (hasZoom && hasPan) kind = 'keyframes'
  else if (hasZoom) kind = 'kenburns'
  else if (hasPan) kind = 'pan'

  return {
    kind,
    durationScale: detectDurationScale(text),
    keyframes: normalized,
  }
}
