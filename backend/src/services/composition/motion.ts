/**
 * Movement / Motion 计划生成与解析
 *
 * 借鉴 HyperFrames 的 seekable animation 思想：把自然语言运镜描述解析成
 * 确定性的关键帧计划，再交给 FFmpeg zoompan 执行。
 */
import type { MotionEasing, MotionKeyframe, MotionPlan } from './types.js'

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
      { t: 0, focusX: preset.startX, focusY: preset.startY, zoom: preset.startZoom, easing: 'ease-in-out' },
      { t: 1, focusX: preset.endX, focusY: preset.endY, zoom: preset.endZoom, easing: 'ease-in-out' },
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
  { keywords: ['台风眼', '卫星云图', '屏幕', '电视屏幕', '新闻屏幕'], focusX: 0.28, focusY: 0.28, zoomBias: 1.42 },
  { keywords: ['匾额', '牌匾', '石碑', '碑文', '题字', '书法', '文字', '四个字', '四字', '字样', '刻字'], focusX: 0.5, focusY: 0.54, zoomBias: 1.12 },
  { keywords: ['书页', '插图', '图案', '手部', '手', 'hand'], focusX: 0.5, focusY: 0.68, zoomBias: 1.25 },
  { keywords: ['风柱', '水柱', '龙卷风'], focusX: 0.65, focusY: 0.35, zoomBias: 1.42 },
  { keywords: ['物品', '物件', 'object', '道具'], focusX: 0.5, focusY: 0.52, zoomBias: 1.32 },
  { keywords: ['人物', '角色', 'person', 'character'], focusX: 0.5, focusY: 0.46, zoomBias: 1.12 },
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
    .map((keyframe, index) => ({
      ...keyframe,
      easing: index === 0 ? 'ease-in-out' as const : detectEasing(text),
    }))

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

export interface TimedVisualBeat {
  start: number
  end: number
  text: string
}

export interface StoryboardMotionInput {
  /** 分镜表中的整体运镜描述，作为没有时间节拍时的保底策略 */
  movement?: string | null
  /** 实际镜头时长，通常来自旁白/对白音频 */
  duration?: number
  /** 用于在没有明确运动时保持镜头变化可复现 */
  seed?: number
  narration?: string | null
  dialogue?: string | null
  videoPrompt?: string | null
}

const TIMED_VISUAL_BEAT = /(\d+(?:\.\d+)?)\s*(?:[-–—~～至到])\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[：:]\s*/gi

/** 解析 storyboard 中常见的“0-3秒：...”视觉节拍标记。 */
export function parseTimedVisualBeats(prompt?: string | null): TimedVisualBeat[] {
  const raw = prompt?.trim()
  if (!raw) return []

  const matches = Array.from(raw.matchAll(TIMED_VISUAL_BEAT))
  return matches
    .map((match, index) => {
      const start = Number(match[1])
      const end = Number(match[2])
      const contentStart = (match.index ?? 0) + match[0].length
      const contentEnd = index + 1 < matches.length
        ? (matches[index + 1].index ?? raw.length)
        : raw.length
      return {
        start,
        end,
        text: raw.slice(contentStart, contentEnd).trim(),
      }
    })
    .filter((beat) => Number.isFinite(beat.start) && Number.isFinite(beat.end) && beat.end > beat.start && beat.text.length > 0)
}

/** 把旁白/对白拆成可用于镜头变化的句子级节拍。 */
export function splitNarrativeBeats(text?: string | null): string[] {
  const raw = text?.replace(/\s+/g, ' ').trim()
  if (!raw) return []

  const sentences = raw
    .split(/(?<=[。！？!?；;])/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (sentences.length > 1) return sentences

  // 长句没有句号时，按逗号拆成少量连续节拍，避免把短句过度切碎。
  if (raw.length >= 24) {
    const clauses = raw
      .split(/(?<=[，,])/)
      .map((part) => part.trim())
      .filter(Boolean)
    if (clauses.length > 1) return clauses
  }

  return [raw]
}

function detectEasing(text: string): MotionEasing {
  if (containsAny(text, ['快速', '急速', '突然', '迅速', 'fast', 'quick', 'rapid'])) return 'ease-in'
  if (containsAny(text, ['缓慢', '慢速', '渐渐', '逐渐', 'slow', 'gentle'])) return 'ease-in-out'
  if (containsAny(text, ['定格', '停留', '固定', 'hold', 'still'])) return 'ease-out'
  return 'ease-in-out'
}

function isHoldBeat(text: string): boolean {
  return containsAny(text, ['定格', '固定', '停留', '静止', '暂停', '暗下', '黑场', '台词前停顿', 'hold', 'still', 'pause'])
}

function detectBeatTransition(text: string): MotionKeyframe['transition'] {
  if (containsAny(text, ['闪白', 'flash'])) return 'flash'
  if (containsAny(text, ['暗下', '黑场', '渐暗', '淡出黑场', 'fade to black', 'dip to black'])) return 'dip-black'
  if (containsAny(text, [
    '爆炸', '轰然', '炮口火光', '齐射', '点燃', '烈火', '崩塌', '火花四溅',
    'explosion', 'blast', 'impact',
  ])) return 'flash'
  return containsAny(text, ['硬切', '爆发', '冲击', '突然切换', '快速切换', 'hard cut'])
    ? 'cut'
    : 'smooth'
}

interface MotionState {
  focusX: number
  focusY: number
  zoom: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function stateFromKeyframe(keyframe: MotionKeyframe): MotionState {
  return {
    focusX: clamp(keyframe.focusX, 0.12, 0.88),
    focusY: clamp(keyframe.focusY, 0.12, 0.88),
    zoom: clamp(keyframe.zoom, 1, 2.2),
  }
}

function isCloseUpBeat(text: string): boolean {
  if (containsAny(text, ['中景', '远景', '全景', 'wide']) && !containsAny(text, ['特写', '近景', '推近', 'close-up'])) {
    return false
  }
  return containsAny(text, [
    '特写', '近景', '面部', '脸', '眼神', '手部', '道具', '书页', '插图', '图案', '风柱', '水柱', '台风眼', '线索', '秘密', '真相', '关键',
    '揭示', '清晰', 'close-up', 'detail', 'reveal',
    '匾额', '牌匾', '石碑', '碑文', '题字', '书法', '文字', '四个字', '四字', '字样', '刻字',
  ])
}

function isTextBearingBeat(text: string): boolean {
  return containsAny(text, [
    '匾额', '牌匾', '石碑', '碑文', '题字', '书法', '文字', '四个字', '四字', '字样', '刻字', '书页',
    '档案', '奏折', '课本', '告示', '字幕', '年号', '数字', '气数已尽',
  ])
}

function isSplitLayoutBeat(text: string): boolean {
  return containsAny(text, [
    '分屏', '左侧', '右侧', '左上', '右上', '四格', '两幅', '交替', '并置', '一侧', '另一侧',
    'split screen', 'side by side',
  ])
}

/**
 * 文字和分屏素材需要比普通人物特写更大的安全边界：文字常常横跨画面，
 * 分屏则需要保留斜切边和人物肩部。过度推进会让信息贴边或被裁掉。
 */
function constrainNarrativeFraming(text: string, state: MotionState): MotionState {
  const next = { ...state }

  if (isTextBearingBeat(text)) {
    next.focusX = clamp(next.focusX, 0.38, 0.62)
    next.focusY = clamp(next.focusY, 0.38, 0.66)
    next.zoom = Math.min(next.zoom, 1.28)
  }

  if (isSplitLayoutBeat(text)) {
    next.focusX = clamp(next.focusX, 0.2, 0.8)
    next.focusY = clamp(next.focusY, 0.3, 0.7)
    next.zoom = Math.min(next.zoom, 1.3)
  }

  return next
}

function isWideBeat(text: string): boolean {
  return containsAny(text, ['远景', '全景', '广角', '环境', 'wide', 'establishing'])
}

function isRapidBeat(text: string): boolean {
  return containsAny(text, ['快速切换', '突然切换', '切换到', '急速', '爆发', '冲击', 'hard cut', 'flash'])
}

function alternateFocus(index: number): { focusX: number; focusY: number } {
  // 把同一张合成图当成一张小型素材库，在节拍边界切到明显不同的构图区域。
  const choices = [
    { focusX: 0.28, focusY: 0.28 },
    { focusX: 0.72, focusY: 0.28 },
    { focusX: 0.28, focusY: 0.68 },
    { focusX: 0.72, focusY: 0.68 },
  ]
  return choices[Math.abs(index) % choices.length]
}

function initialStateForBeat(text: string, index: number, seed: number): MotionState {
  const subject = detectSubject(text)

  if (isTextBearingBeat(text)) {
    return constrainNarrativeFraming(text, {
      focusX: subject.focusX,
      focusY: subject.focusY,
      zoom: Math.min(Math.max(subject.zoomBias + 0.04, 1.08), 1.24),
    })
  }

  if (isWideBeat(text)) {
    return { focusX: 0.5, focusY: 0.5, zoom: 1.02 }
  }

  if (containsAny(text, ['中景', 'medium shot'])) {
    return { focusX: 0.5, focusY: 0.5, zoom: 1.15 }
  }

  if (isRapidBeat(text)) {
    const focus = alternateFocus(index + Math.abs(seed) % 2)
    return { ...focus, zoom: 1.75 }
  }

  if (isHoldBeat(text)) {
    // “定格”不是回到上一段的末帧，而是切到一个稳定的叙事落点。
    // 有明确主体时落到主体；否则使用可复现的四分构图，避免整段继续像单一推镜。
    if (subject.zoomBias > 1) {
      return {
        focusX: subject.focusX,
        focusY: subject.focusY,
        zoom: clamp(Math.max(subject.zoomBias + 0.1, 1.35), 1, 2.2),
      }
    }
    const focus = alternateFocus(index + Math.abs(seed) % 2)
    return { ...focus, zoom: 1.34 }
  }

  if (isCloseUpBeat(text)) {
    return {
      focusX: subject.focusX,
      focusY: subject.focusY,
      zoom: 1.55,
    }
  }

  return stateFromKeyframe(buildDeterministicMotionPlan(seed).keyframes[0])
}

function inferredBeatTarget(text: string, current: MotionState, index: number, seed: number): MotionState {
  const subject = detectSubject(text)
  const target: MotionState = { ...current }

  if (isHoldBeat(text)) return target

  if (isRapidBeat(text)) {
    const focus = alternateFocus(index + Math.abs(seed) % 2)
    target.focusX = focus.focusX
    target.focusY = focus.focusY
    target.zoom = 1.85
    return target
  }

  if (containsAny(text, ['风柱', '水柱', '龙卷风'])) {
    target.focusX = containsAny(text, ['海面', '远处']) ? 0.68 : 0.58
    target.focusY = 0.34
    target.zoom = clamp(Math.max(current.zoom + 0.3, 1.5), 1, 2.2)
    return target
  }

  if (containsAny(text, ['旋转', '翻滚', '环绕', 'rotate', 'orbit'])) {
    const direction = (Math.abs(seed) + index) % 2 === 0 ? 1 : -1
    target.focusX = clamp(current.focusX + direction * 0.22, 0.2, 0.8)
    target.focusY = clamp(current.focusY - 0.08, 0.2, 0.8)
    target.zoom = clamp(Math.max(current.zoom + 0.12, 1.18), 1, 2.2)
    return target
  }

  if (containsAny(text, ['推近', '靠近', '特写', '聚焦', '清晰', '揭示', '秘密', '线索', '真相', '关键', '情绪', 'zoom in', 'push in', 'close-up'])) {
    target.focusX = subject.focusX
    target.focusY = subject.focusY
    target.zoom = clamp(Math.max(current.zoom + 0.28, subject.zoomBias + 0.25, 1.5), 1, 2.2)
    return target
  }

  if (containsAny(text, ['拉远', '远景', '全景', '升至太空', 'zoom out', 'pull back', 'wide'])) {
    target.focusX = 0.5
    target.focusY = 0.5
    target.zoom = clamp(current.zoom - 0.28, 1, 2.2)
    return target
  }

  if (containsAny(text, ['上摇', '上升', '升起', '天空', '云层', '仰拍', '向上', 'pan up', 'move up'])) {
    target.focusY = clamp(current.focusY - 0.28, 0.15, 0.85)
    target.zoom = clamp(current.zoom + 0.1, 1, 2.2)
    return target
  }

  if (containsAny(text, ['下摇', '下降', '垂下', '落下', '俯瞰', '向下', 'pan down', 'move down'])) {
    target.focusY = clamp(current.focusY + 0.28, 0.15, 0.85)
    target.zoom = clamp(current.zoom + 0.08, 1, 2.2)
    return target
  }

  if (containsAny(text, ['横移', '横摇', '扫过', '切换', '移向', '旋转', '翻滚', '水柱', '风暴', 'pan', 'move'])) {
    const direction = (Math.abs(seed) + index) % 2 === 0 ? 1 : -1
    target.focusX = clamp(current.focusX + direction * 0.3, 0.15, 0.85)
    target.zoom = clamp(current.zoom + 0.1, 1, 2.2)
    return target
  }

  // 没有明确动作时仍做一次可感知的重构，但把大幅度留给剧情关键词。
  const focus = alternateFocus(index + Math.abs(seed) % 2)
  target.focusX = focus.focusX
  target.focusY = focus.focusY
  target.zoom = clamp(Math.max(current.zoom + 0.12, 1.22), 1, 1.65)
  return target
}

function targetForBeat(text: string, current: MotionState, index: number, seed: number): MotionState {
  const explicit = parseMovement(text)
  if (explicit && explicit.keyframes.length > 0) {
    const explicitTarget = stateFromKeyframe(explicit.keyframes[explicit.keyframes.length - 1])
    const inferredTarget = inferredBeatTarget(text, current, index, seed)
    // 文字同时包含“推近 + 书页/线索/风柱”时，保留明确方向，但不能让
    // parseMovement 的保守默认值把剧情特写压回到 1.18x。
    if (isCloseUpBeat(text) || isRapidBeat(text)) {
      return constrainNarrativeFraming(text, {
        focusX: inferredTarget.focusX,
        focusY: inferredTarget.focusY,
        zoom: Math.max(explicitTarget.zoom, inferredTarget.zoom),
      })
    }
    return constrainNarrativeFraming(text, explicitTarget)
  }
  return constrainNarrativeFraming(text, inferredBeatTarget(text, current, index, seed))
}

function getBeatEasing(text: string): MotionEasing {
  return detectEasing(text)
}

function getPlanKind(keyframes: MotionKeyframe[]): MotionPlan['kind'] {
  const hasZoom = keyframes.some((keyframe, index) => index > 0 && keyframe.zoom !== keyframes[index - 1].zoom)
  const hasPan = keyframes.some((keyframe, index) => index > 0 && (
    keyframe.focusX !== keyframes[index - 1].focusX || keyframe.focusY !== keyframes[index - 1].focusY
  ))
  if (hasZoom && hasPan) return 'keyframes'
  if (hasZoom) return 'kenburns'
  if (hasPan) return 'pan'
  return 'static'
}

interface NormalizedVisualBeat {
  text: string
  start: number
  end: number
}

/**
 * 短镜头不能照搬 0-3/3-6/6-9 的三段结构，否则每段只剩几百毫秒，
 * 观众来不及读画面。合并相邻 prompt 段，同时保留第一段的建立和最后一段的落点。
 */
function limitVisualBeats(beats: NormalizedVisualBeat[], duration?: number): NormalizedVisualBeat[] {
  if (!duration || beats.length <= 1) return beats

  const maxBeats = duration < 3.5 ? 2 : duration < 8 ? 3 : 4
  if (beats.length <= maxBeats) return beats

  if (maxBeats === 2) {
    const last = beats[beats.length - 1]
    return [
      {
        start: beats[0].start,
        end: last.start,
        text: beats.slice(0, -1).map((beat) => beat.text).join(' '),
      },
      { ...last },
    ]
  }

  const keep = Math.max(1, maxBeats - 1)
  const grouped: NormalizedVisualBeat[] = []
  const first = beats[0]
  grouped.push(first)

  const middle = beats.slice(1, -1)
  if (middle.length > 0) {
    const mergedText = middle.map((beat) => beat.text).join(' ')
    grouped.push({ start: middle[0].start, end: middle[middle.length - 1].end, text: mergedText })
  }

  if (beats.length > 1) grouped.push(beats[beats.length - 1])

  if (grouped.length > maxBeats) {
    return grouped.slice(0, keep).concat(grouped.slice(-1))
  }
  return grouped
}

function statesDiffer(a: MotionState, b: MotionState): boolean {
  return a.focusX !== b.focusX || a.focusY !== b.focusY || a.zoom !== b.zoom
}

function appendMotionKeyframe(
  keyframes: MotionKeyframe[],
  state: MotionState,
  t: number,
  easing: MotionEasing,
  transition?: MotionKeyframe['transition'],
) {
  const normalizedT = clamp(t, 0, 1)
  const next: MotionKeyframe = { ...state, t: normalizedT, easing }
  if (transition) next.transition = transition

  const last = keyframes[keyframes.length - 1]
  if (last && normalizedT <= last.t + 0.000001) {
    if (Math.abs(normalizedT - last.t) <= 0.000001) {
      keyframes[keyframes.length - 1] = { ...last, ...next }
    }
    return
  }
  keyframes.push(next)
}

/**
 * 用现有 storyboard 文本生成低成本的多段单图运动计划。
 * 优先使用 video_prompt 的时间节拍，再回退到旁白/对白的句子节拍。
 */
export function buildStoryboardMotionPlan(input: StoryboardMotionInput): MotionPlan | null {
  const seed = input.seed ?? 0
  const combinedNarrative = [input.narration, input.dialogue]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' ')
  const timedBeats = parseTimedVisualBeats(input.videoPrompt)

  let beats: NormalizedVisualBeat[]
  if (timedBeats.length >= 2) {
    const promptDuration = Math.max(...timedBeats.map((beat) => beat.end))
    if (!(promptDuration > 0)) return null
    beats = timedBeats.map((beat) => ({
      text: beat.text,
      start: clamp(beat.start / promptDuration, 0, 1),
      end: clamp(beat.end / promptDuration, 0, 1),
    }))
  } else {
    const narrativeBeats = splitNarrativeBeats(combinedNarrative)
    if (narrativeBeats.length < 2) return null
    beats = narrativeBeats.map((text, index) => ({
      text,
      start: index / narrativeBeats.length,
      end: (index + 1) / narrativeBeats.length,
    }))
  }

  beats = limitVisualBeats(beats, input.duration)

  let current = initialStateForBeat(beats[0]?.text || '', 0, seed)
  const keyframes: MotionKeyframe[] = [{ ...current, t: 0, easing: 'ease-in-out' }]

  beats.forEach((beat, index) => {
    // 每个 beat 都有自己的起始构图。只把上一段末帧作为过渡起点，
    // 不再把整条镜头当成一个连续的 Ken Burns 运动。
    const beatStart = index === 0 ? current : initialStateForBeat(beat.text, index, seed)
    const target = targetForBeat(beat.text, beatStart, index, seed)
    const start = clamp(beat.start, 0, 1)
    const end = clamp(Math.max(beat.end, beat.start), 0, 1)
    const span = Math.max(0.000001, end - start)
    const transition = detectBeatTransition(beat.text)
    const cutAtStart = transition === 'cut' || transition === 'flash'

    if (index === 0) {
      // 第一个 beat 先给观众一个稳定的建立镜头，再在段内完成语义动作。
      if (!isHoldBeat(beat.text) && statesDiffer(current, target)) {
        appendMotionKeyframe(keyframes, target, start + span * 0.78, getBeatEasing(beat.text))
      }
      appendMotionKeyframe(keyframes, target, end, 'ease-out')
      current = target
      return
    }

    if (cutAtStart) {
      // “快速切换”发生在新 beat 开始，而不是旧 beat 结束。
      appendMotionKeyframe(keyframes, beatStart, start, 'ease-out', transition)
      appendMotionKeyframe(keyframes, target, start + span * 0.42, getBeatEasing(beat.text))
      appendMotionKeyframe(keyframes, target, end, 'ease-out')
      current = target
      return
    }

    appendMotionKeyframe(keyframes, current, start, 'ease-out')
    if (statesDiffer(current, beatStart)) {
      // 新 beat 先快速完成构图重置，再进入该段自己的语义运动。
      appendMotionKeyframe(keyframes, beatStart, start + span * 0.12, 'ease-out')
    }
    if (isHoldBeat(beat.text)) {
      // 定格 beat 在自己的构图上保持，暗下/黑场转场挂在 beat 尾部。
      appendMotionKeyframe(keyframes, beatStart, end, 'ease-out', transition === 'dip-black' ? transition : undefined)
    } else {
      // 先 hold，再 push-in / pan，最后 hold，避免整段匀速滑动像 PPT。
      if (!statesDiffer(current, beatStart)) {
        appendMotionKeyframe(keyframes, current, start + span * 0.12, 'ease-out')
      }
      appendMotionKeyframe(keyframes, target, start + span * 0.78, getBeatEasing(beat.text))
      appendMotionKeyframe(keyframes, target, end, 'ease-out')
    }
    current = target
  })

  appendMotionKeyframe(keyframes, current, 1, 'ease-out')

  return {
    kind: getPlanKind(keyframes),
    durationScale: detectDurationScale(`${combinedNarrative} ${input.videoPrompt || ''}`),
    keyframes,
  }
}

/**
 * 选择最终单图运动策略。
 *
 * 带有 0-3/3-6/6-9 秒标记的 video_prompt 已经提供了镜头叙事节拍，
 * 必须优先于“缓慢推近”这类整体运镜，否则会把剧情节拍压扁成单段 Ken Burns。
 * 没有时间节拍时，继续尊重分镜表中的明确运镜描述。
 */
export function buildPreferredStoryboardMotionPlan(input: StoryboardMotionInput): MotionPlan {
  const timedBeatCount = parseTimedVisualBeats(input.videoPrompt).length
  const beatPlan = buildStoryboardMotionPlan(input)
  const explicitPlan = parseMovement(input.movement)

  if (timedBeatCount >= 2 && beatPlan && beatPlan.kind !== 'static') {
    return beatPlan
  }

  if (explicitPlan) return explicitPlan
  if (beatPlan && beatPlan.kind !== 'static') return beatPlan
  return buildDeterministicMotionPlan(input.seed ?? 0)
}
