export const FPS = 30
export const WIDTH = 1280
export const HEIGHT = 720
export const INK = '#080d12'
export const TRANSITION_FRAMES = 12
export const PAGE_DIP_FRAMES = 8
export const NATIVE_RENDERER_VERSION = 'native-comic-v12'
export const NATIVE_AUDIO_MIX_VERSION = 'native-audio-v2-bgm-target'
export const TEXT_PRESENTATION_VERSION = 'dharma-text-v5'
// dharma-text-v5：subtitle/emphasis 文字层改由 Remotion overlay（DharmaTextOverlay）
// 真渲染后合成，ffmpeg renderer 只出底片（props.textLayers='overlay' 的 plate 模式）。
// TEXT_OVERLAY_VERSION 进 overlayFingerprint，叠加层实现变化时 bump。
export const TEXT_OVERLAY_VERSION = 'dharma-text-overlay-v1'
export const MOTION_WIDTH = 1300
export const MOTION_HEIGHT = 732
export const MOTION_MARGIN_X = (MOTION_WIDTH - WIDTH) / 2
export const MOTION_MARGIN_Y = (MOTION_HEIGHT - HEIGHT) / 2

const OFFSTAGE = { x: 104, y: 0, width: 60, height: 100 }

const CLOSING_PUNCTUATION = new Set([...'。，！？；：、”’》〉】〕〗〙'])
const OPENING_PUNCTUATION = new Set([...'“‘《〈【〔〖〘'])

function preferredBreak(chars, start, idealEnd, hardEnd) {
  const minimum = Math.min(hardEnd, start + Math.max(1, Math.floor((hardEnd - start) * 0.58)))
  for (let index = Math.min(hardEnd, idealEnd + 2); index >= minimum; index -= 1) {
    if (CLOSING_PUNCTUATION.has(chars[index - 1]) && !OPENING_PUNCTUATION.has(chars[index - 1])) return index
  }
  let end = Math.min(hardEnd, idealEnd)
  while (end > start + 1 && CLOSING_PUNCTUATION.has(chars[end])) end -= 1
  while (end > start + 1 && OPENING_PUNCTUATION.has(chars[end - 1])) end -= 1
  return end
}

export function balancedChineseLines(value, maxChars, maxLines) {
  const chars = [...String(value || '').trim().replace(/\s+/gu, '')]
  if (!chars.length) return []
  const lineCount = Math.min(maxLines, Math.max(1, Math.ceil(chars.length / maxChars)))
  const lines = []
  let cursor = 0
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const remainingLines = lineCount - lineIndex
    const remainingChars = chars.length - cursor
    if (remainingLines === 1) {
      lines.push(chars.slice(cursor).join(''))
      break
    }
    const ideal = cursor + Math.ceil(remainingChars / remainingLines)
    const hardEnd = Math.min(chars.length - (remainingLines - 1), cursor + maxChars)
    const end = preferredBreak(chars, cursor, ideal, hardEnd)
    lines.push(chars.slice(cursor, end).join(''))
    cursor = end
  }
  return lines
}

export function subtitleTextPlan(value) {
  const length = [...String(value || '').trim().replace(/\s+/gu, '')].length
  if (!length) return { lines: [], fontSize: 44 }
  const maxChars = length <= 16 ? 16 : Math.max(16, Math.ceil(length / 2))
  const lines = balancedChineseLines(value, maxChars, 2)
  const longestLine = Math.max(...lines.map((line) => [...line].length))
  return {
    lines,
    fontSize: lines.length === 1
      ? Math.max(38, Math.min(44, Math.floor(800 / Math.max(1, longestLine))))
      : Math.max(34, Math.min(40, Math.floor(760 / Math.max(1, longestLine)))),
  }
}

// ink-read-v2 底部字幕呈现常量（dharma-text-v4）：8 帧 easeOutCubic 入场、旁白窗口
// 后 +0.35s 驻留（相邻间隙 <12 帧时减半）、相邻句间 SharedAxisZ 纵深转场（旧句放大
// 变糊淡出 + 新句缩小升入对焦，10 帧，窗口不足回退 blur-out+普通入场）、末句/孤立句
// 退场仍走 blur-out 失焦消散（原图 2 帧淡出、blur 4/8 两级交叉淡化，6 帧窗口内收净；
// 窗口不足 5 帧回退普通淡出）、相邻句退场与入场重叠 3 帧、第二行晚 2 帧入场、theme
// 金线随首字落定生长。关键词高亮为 InlineHighlight：落定后 6 帧暖白→金 #C7A45A
// 交叉淡化（短驻留段整体跳过变色）。
export const SUBTITLE_ENTRY_FRAMES = 8
export const SUBTITLE_EXIT_FRAMES = 6
export const SUBTITLE_DWELL_SEC = 0.35
export const SUBTITLE_SHORT_GAP_FRAMES = 12
export const SUBTITLE_EXIT_OVERLAP_FRAMES = 3
export const SUBTITLE_LINE_STAGGER_FRAMES = 2
export const SUBTITLE_UNDERLINE_GROW_FRAMES = 4
export const SUBTITLE_ENTRY_RISE_PX = 18
export const SUBTITLE_INLINE_HIGHLIGHT_FRAMES = 6
export const SUBTITLE_BLUR_OUT_MIN_EXIT_FRAMES = 5
// SharedAxisZ 句间转场（demo3 验收调参）：每句 3 档缩放/模糊变体绕底部字幕中心
// (640,547) 烘焙；旧句 alpha 上限 0.65（暗底上保留可读残影），blur 上限 6。
// 转场 10 帧 = 每档 2 帧步进 ×（3 档变体 + 本体 2 帧交错）。相邻判定：下一句开始
// 不晚于本句 displayEnd +3 帧；新句窗口不足 10 帧转场 + 0.2s 落定余量时整组回退
// v3 blur-out + 普通入场。
export const SUBTITLE_AXIS_TRANSITION_FRAMES = 10
export const SUBTITLE_AXIS_STEP_FRAMES = 2
export const SUBTITLE_AXIS_MAX_GAP_FRAMES = 3
export const SUBTITLE_AXIS_SETTLE_MARGIN_SEC = 0.2
export const SUBTITLE_AXIS_OLD_MAX_ALPHA = 0.65
export const SUBTITLE_AXIS_OLD_TIERS = Object.freeze([[1.06, 1.5], [1.12, 3], [1.18, 6]])
export const SUBTITLE_AXIS_NEW_TIERS = Object.freeze([[0.85, 5], [0.92, 3], [0.96, 1.5]])

// Handwrite 金句（dharma-text-v4）：theme 类金句以 Ma Shan Zheng 毛笔体逐字定格
// 入场——首 pose 2 字、其后每 pose +1 字硬切累积；≤8 字 3 帧/pose，更长按句长
// 动态压 pose 帧数，保证总入场 ≤1s（30 帧）。scripture/explanation 维持现行路径。
export const QUOTE_HANDWRITE_POSE_FRAMES = 3
export const QUOTE_HANDWRITE_MAX_ENTRY_FRAMES = 30
export function handwritePosePlan(charCount) {
  const count = Math.max(1, Number(charCount) || 1)
  const counts = count <= 2
    ? Array.from({ length: count }, (_, index) => index + 1)
    : [...Array.from({ length: count - 2 }, (_, index) => index + 2), count]
  const poseFrames = count <= 8
    ? QUOTE_HANDWRITE_POSE_FRAMES
    : Math.max(1, Math.floor(QUOTE_HANDWRITE_MAX_ENTRY_FRAMES / counts.length))
  return { counts, poseFrames }
}

// 从连续旁白窗口推导每句字幕的显示窗口（ink-read-v2 驻留规则）。
// 纯函数：同样的 spoken 窗口序列永远得到同样的显示窗口，check_dharma_sync.mjs
// 依此从冻结 TTS titles 独立重算。返回与输入等长的
// [{ displayStartSec, displayEndSec }]，displayStartSec 恒等于 startSec。
export function computeSubtitleDisplayWindows(subtitles, fps = FPS) {
  const windows = subtitles.map((subtitle) => ({
    startSec: Number(subtitle.startSec),
    endSec: Number(subtitle.endSec),
  }))
  return windows.map((window, index) => {
    const next = windows[index + 1]
    const gapSec = next ? next.startSec - window.endSec : Number.POSITIVE_INFINITY
    const dwellSec = gapSec < SUBTITLE_SHORT_GAP_FRAMES / fps
      ? SUBTITLE_DWELL_SEC / 2
      : SUBTITLE_DWELL_SEC
    let displayEndSec = window.endSec + dwellSec
    if (next) displayEndSec = Math.min(displayEndSec, next.startSec + SUBTITLE_EXIT_OVERLAP_FRAMES / fps)
    return { displayStartSec: window.startSec, displayEndSec }
  })
}

// ink-read-v2 关键词自动提取：佛学术语 > 否定短语 > 转折词 > 金句式短词，
// 每句最多 2 个，互不重叠，位置靠前者优先。纯函数、确定性。
const KEYWORD_DHARMA_TERMS = [
  '应无所住', '而生其心', '缘起性空', '明心见性', '知行合一', '色即是空', '知足常乐',
  '执着', '放下', '缘起', '无常', '空性', '因果', '业障', '般若', '菩提', '涅槃',
  '轮回', '布施', '持戒', '忍辱', '精进', '禅定', '慈悲', '智慧', '烦恼', '妄想',
  '分别', '我执', '法执', '中道', '自在', '解脱', '觉悟', '修行', '念佛', '忏悔',
  '回向', '愿力', '本心', '自性', '清净', '顿悟', '渐修', '良知', '天理', '心即理',
  '格物', '致知', '诚意', '正心', '修身', '慎独', '无欲', '无念', '无相', '无住',
  '妙有', '真空', '彼岸', '此岸', '安心', '静心', '开悟', '看破', '随缘', '舍得',
  '执念', '妄念', '初心',
]
const KEYWORD_CONTRAST_WORDS = ['但是', '可是', '然而', '反倒', '反而', '偏偏', '却', '但']
const KEYWORD_PUNCH_WORDS = [
  '钥匙', '答案', '真相', '根源', '枷锁', '牢笼', '自由', '命运', '选择', '功课',
  '考验', '礼物', '陷阱', '幻觉', '镜子', '种子', '光明', '力量', '勇气', '内耗',
  '焦虑', '痛苦', '幸福', '意义', '价值', '底线', '分寸', '格局', '心境', '心态',
  '良心', '善恶', '得失', '成败', '生死', '祸福', '心安',
]
const KEYWORD_NEGATION_RE = /(没有|不|没|无|莫|勿|未)([一-龥]{1,2})?/gu

export function extractSubtitleKeywords(value) {
  const text = String(value || '')
  if (!text) return []
  const candidates = []
  const collect = (terms, priority) => {
    for (const term of terms) {
      const index = text.indexOf(term)
      if (index >= 0) candidates.push({ word: term, index, priority })
    }
  }
  collect(KEYWORD_DHARMA_TERMS, 0)
  for (const match of text.matchAll(KEYWORD_NEGATION_RE)) {
    // 否定短语封顶 2 字（不是/不会/没有），避免“不是世”这类拙劣切分。
    candidates.push({ word: match[0].slice(0, 2), index: match.index, priority: 1 })
  }
  collect(KEYWORD_CONTRAST_WORDS, 2)
  collect(KEYWORD_PUNCH_WORDS, 3)
  candidates.sort((left, right) => (
    left.priority - right.priority
    || left.index - right.index
    || right.word.length - left.word.length
  ))
  const picked = []
  for (const candidate of candidates) {
    if (picked.length >= 2) break
    const overlaps = picked.some((existing) => (
      candidate.index < existing.index + existing.word.length
      && existing.index < candidate.index + candidate.word.length
    ))
    if (!overlaps) picked.push(candidate)
  }
  return picked.sort((left, right) => left.index - right.index).map((candidate) => candidate.word)
}

export function emphasisTextPlan(quote) {
  const kind = String(quote?.kind || '')
  const text = String(quote?.text || '').trim()
  const length = [...text].length
  if (kind === 'theme') {
    // dharma-text-v4：theme 金句改 Ma Shan Zheng 毛笔体（renderer 走 Handwrite
    // 逐字定格 pose 入场），字号较 v3 serif 略收以留笔锋空间。
    const fontSize = length <= 6 ? 84 : length <= 10 ? 72 : 60
    const lines = balancedChineseLines(text, 8, 2)
    return {
      kind,
      lines,
      fontFamily: 'hand',
      fontSize,
      lineHeight: 1.18,
      entryFrames: 4,
      exitFrames: 6,
      staggerFrames: 2,
      risePx: 10,
    }
  }
  if (kind === 'scripture') {
    const fontSize = length <= 12 ? 58 : length <= 24 ? 48 : 42
    return {
      kind,
      lines: balancedChineseLines(text, 8, 3),
      fontFamily: 'serif',
      fontSize,
      sourceFontSize: 24,
      lineHeight: 1.3,
      entryFrames: 4,
      exitFrames: 6,
      staggerFrames: 3,
      risePx: 8,
    }
  }
  if (kind === 'explanation') {
    // ink-read-v2 中置分级：认知拐点 punch 句升到 56–64px（长句兜底 48px 防溢出）。
    const fontSize = length <= 10 ? 64 : length <= 15 ? 60 : length <= 24 ? 56 : 48
    const maxChars = length <= 16 ? 16 : fontSize >= 56 ? 15 : 17
    return {
      kind,
      lines: balancedChineseLines(text, maxChars, 2),
      fontFamily: 'sans',
      fontSize,
      lineHeight: 1.34,
      entryFrames: 4,
      exitFrames: 6,
      staggerFrames: 2,
      risePx: 8,
    }
  }
  throw new Error(`Unknown emphasis kind: ${kind}`)
}

export const PROGRESSIVE_LAYOUTS = [
  [
    { x: 0, y: 0, width: 100, height: 100 },
    OFFSTAGE, OFFSTAGE, OFFSTAGE, OFFSTAGE,
  ],
  [
    { x: 0, y: 0, width: 39.4, height: 100 },
    { x: 40.1, y: 0, width: 59.9, height: 100 },
    OFFSTAGE, OFFSTAGE, OFFSTAGE,
  ],
  [
    { x: 0, y: 0, width: 37.4, height: 49.5 },
    { x: 0, y: 50.2, width: 37.4, height: 49.8 },
    { x: 38.1, y: 0, width: 61.9, height: 100 },
    OFFSTAGE, OFFSTAGE,
  ],
  [
    { x: 0, y: 0, width: 18.4, height: 49.5 },
    { x: 19.1, y: 0, width: 18.3, height: 49.5 },
    { x: 0, y: 50.2, width: 37.4, height: 49.8 },
    { x: 38.1, y: 0, width: 61.9, height: 100 },
    OFFSTAGE,
  ],
  [
    { x: 0, y: 0, width: 19.4, height: 49.5 },
    { x: 20.1, y: 0, width: 19.3, height: 49.5 },
    { x: 0, y: 50.2, width: 19.4, height: 49.8 },
    { x: 20.1, y: 50.2, width: 19.3, height: 49.8 },
    { x: 40.1, y: 0, width: 59.9, height: 100 },
  ],
]

export function cubicInOut(value) {
  const t = Math.max(0, Math.min(1, value))
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

export function mixRect(from, to, progress) {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    width: from.width + (to.width - from.width) * progress,
    height: from.height + (to.height - from.height) * progress,
  }
}

export function layoutAtTransitionFrame(activeIndex, transitionFrame) {
  if (activeIndex === 0) return PROGRESSIVE_LAYOUTS[0]
  if (transitionFrame <= 0) return PROGRESSIVE_LAYOUTS[activeIndex - 1]
  if (transitionFrame >= TRANSITION_FRAMES) return PROGRESSIVE_LAYOUTS[activeIndex]
  const progress = cubicInOut(transitionFrame / TRANSITION_FRAMES)
  const from = PROGRESSIVE_LAYOUTS[activeIndex - 1]
  const to = PROGRESSIVE_LAYOUTS[activeIndex]
  return to.map((rect, index) => mixRect(from[index], rect, progress))
}

export function rectToPixels(rect) {
  return {
    x: Math.round(rect.x * WIDTH / 100),
    y: Math.round(rect.y * HEIGHT / 100),
    width: Math.max(1, Math.round(rect.width * WIDTH / 100)),
    height: Math.max(1, Math.round(rect.height * HEIGHT / 100)),
  }
}

export function coverCrop(sourceWidth, sourceHeight, targetWidth, targetHeight, focusX = 50, focusY = 50) {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const width = Math.max(targetWidth, Math.ceil(sourceWidth * scale))
  const height = Math.max(targetHeight, Math.ceil(sourceHeight * scale))
  const maxLeft = Math.max(0, width - targetWidth)
  const maxTop = Math.max(0, height - targetHeight)
  const left = Math.round(Math.max(0, Math.min(maxLeft, width * focusX / 100 - targetWidth / 2)))
  const top = Math.round(Math.max(0, Math.min(maxTop, height * focusY / 100 - targetHeight / 2)))
  return { width, height, left, top }
}

export function bubbleAnchor(rect, bubble) {
  const panel = rectToPixels(rect)
  return {
    x: Math.round(panel.x + panel.width * bubble.x / 100),
    y: Math.round(panel.y + panel.height * bubble.y / 100),
    clip: panel,
  }
}

export function activeRectForIndex(activeIndex) {
  return PROGRESSIVE_LAYOUTS[activeIndex][activeIndex]
}

export function motionOffsetAtFrame(intervalIndex, durationInFrames, frame) {
  const denominator = Math.max(1, durationInFrames - 1)
  const progress = Math.max(0, Math.min(denominator, frame)) / denominator
  const forward = MOTION_MARGIN_X * (1 - 2 * progress)
  return intervalIndex % 2 === 0 ? forward : -forward
}

export function cropPositionExpression(intervalIndex, durationInFrames, frameVariable) {
  const denominator = Math.max(1, durationInFrames - 1)
  const travel = MOTION_MARGIN_X * 2
  return intervalIndex % 2 === 0
    ? `${travel}*${frameVariable}/${denominator}`
    : `${travel}*(1-${frameVariable}/${denominator})`
}

export function legacyMotionFilter(intervalIndex, durationInFrames, input = 'base', output = 'moved', options = {}) {
  const frameOffset = Number(options.frameOffset || 0)
  const frameVariable = frameOffset ? `(n+${frameOffset})` : 'n'
  const position = cropPositionExpression(intervalIndex, Number(options.frameDuration || durationInFrames), frameVariable)
  return `[${input}]crop=${WIDTH}:${HEIGHT}:x='${position}':y=${MOTION_MARGIN_Y}[${output}]`
}

export function perspectiveMotionFilter(intervalIndex, durationInFrames, input = 'base', output = 'moved', options = {}) {
  const frameOffset = Number(options.frameOffset || 0)
  const motionDuration = Number(options.frameDuration || durationInFrames)
  const denominator = Math.max(1, motionDuration - 1)
  const travel = MOTION_MARGIN_X * 2
  const frameVariable = frameOffset ? `(in+${frameOffset})` : 'in'
  const dx = intervalIndex % 2 === 0
    ? `-${travel}*${frameVariable}/${denominator}`
    : `-${travel}*(1-${frameVariable}/${denominator})`
  return `[${input}]perspective=x0='${dx}':y0=0:x1='W+${dx}':y1=0:x2='${dx}':y2=H:x3='W+${dx}':y3=H:sense=destination:interpolation=linear:eval=frame,crop=${WIDTH}:${HEIGHT}:x=0:y=${MOTION_MARGIN_Y}[${output}]`
}

export function motionFilter(mode, intervalIndex, durationInFrames, input = 'base', output = 'moved', options = {}) {
  if (mode === 'legacy-crop') return legacyMotionFilter(intervalIndex, durationInFrames, input, output, options)
  if (mode === 'perspective-linear') return perspectiveMotionFilter(intervalIndex, durationInFrames, input, output, options)
  if (mode === 'narrative-push') return narrativePushMotionFilter(options.center, input, output)
  throw new Error(`Unknown native comic motion mode: ${mode}`)
}

// 叙事推镜：镜头始终以恒定速度向当前被讲述的 panel 中心推近（速度按真实
// 时间计，与 interval 时长无关），叠加同向（向右=向前）的常驻微漂移。方向在
// interval 之间永不交替，速度永不为零，让切镜读起来是「继续深入」而非「换图」。
export const PUSH_ZOOM_PER_SECOND = 0.008
export const PUSH_DRIFT_PX_PER_SECOND = 1.5

export function narrativePushMotionFilter(center, input = 'base', output = 'moved') {
  const cx = Number.isFinite(center?.x) ? center.x : WIDTH / 2
  const cy = (Number.isFinite(center?.y) ? center.y : HEIGHT / 2) + MOTION_MARGIN_Y
  const zoom = `(1+${(PUSH_ZOOM_PER_SECOND / FPS).toFixed(9)}*in)`
  const drift = `${(PUSH_DRIFT_PX_PER_SECOND / FPS).toFixed(6)}*in`
  const x0 = `${cx}-${cx}*${zoom}-${drift}`
  const y0 = `${cy}-${cy}*${zoom}`
  const x1 = `${cx}+${MOTION_WIDTH - cx}*${zoom}-${drift}`
  const y2 = `${cy}+${MOTION_HEIGHT - cy}*${zoom}`
  return `[${input}]perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y0}':x2='${x0}':y2='${y2}':x3='${x1}':y3='${y2}':sense=destination:interpolation=linear:eval=frame,crop=${WIDTH}:${HEIGHT}:x=0:y=${MOTION_MARGIN_Y}[${output}]`
}

export function buildIntervals(props, maxDurationSec) {
  const hardEndFrame = Math.min(
    Number(props.durationInFrames),
    Number.isFinite(maxDurationSec) ? Math.round(maxDurationSec * FPS) : Number(props.durationInFrames),
  )
  const panels = props.panels.filter((panel) => panel.emphasisStartFrame < hardEndFrame)
  return panels.map((panel, index) => {
    const startFrame = panel.emphasisStartFrame
    const endFrame = Math.min(panels[index + 1]?.emphasisStartFrame ?? hardEndFrame, hardEndFrame)
    const pageIndex = Math.floor(index / 5)
    const activeIndex = index % 5
    return {
      index,
      panel,
      pageIndex,
      activeIndex,
      pagePanels: props.panels.slice(pageIndex * 5, pageIndex * 5 + 5),
      startFrame,
      endFrame,
      durationInFrames: endFrame - startFrame,
      hasLayoutTransition: activeIndex > 0,
      pageDipIn: index > 0 && activeIndex === 0,
      pageDipOut: endFrame < hardEndFrame && (index + 1) % 5 === 0,
    }
  })
}

export function assertContinuousIntervals(intervals, expectedFrames) {
  if (!intervals.length) throw new Error('Native comic render plan has no intervals')
  if (intervals[0].startFrame !== 0) throw new Error('Native comic render plan must start at frame 0')
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index - 1].endFrame !== intervals[index].startFrame) {
      throw new Error(`Native comic render plan gap at interval ${index}`)
    }
  }
  if (intervals.at(-1).endFrame !== expectedFrames) {
    throw new Error(`Native comic render plan ends at ${intervals.at(-1).endFrame}, expected ${expectedFrames}`)
  }
}
