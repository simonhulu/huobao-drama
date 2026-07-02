/**
 * 留存驱动脚本优化服务
 *
 * 在保真清理稿之上提供结构化输出：
 * - cleanScript：保真清理后的正文
 * - productionScript：留存结构编辑后的生产稿
 * - 独立开头钩子（openingHook）
 * - 结尾悬念（cliffhanger）
 * - retentionBeats：给分镜/旁白阶段复用的留存结构
 * - 预估时长与改动摘要
 */
import { cleanDirectScript, type HookStyle, type RetentionMode } from './direct-script-cleaner.js'

export interface RetentionBeat {
  atSeconds?: number
  label: string
  question: string
  purpose: string
  sourceEvidence?: string[]
}

export interface RetentionStructure {
  openingHook: {
    text: string
    visualBeat?: string
    question?: string
    durationSeconds?: number
  }
  cliffhanger: {
    text: string
    visualBeat?: string
    nextQuestion?: string
    durationSeconds?: number
  }
  midBeats: RetentionBeat[]
  retentionChecks: string[]
}

export interface RetentionOptimizationResult {
  cleanScript: string
  productionScript: string
  content: string
  openingHook?: string
  cliffhanger?: string
  hookStyle: HookStyle
  estimatedDurationSeconds: number
  changes: string[]
  retentionBeats?: RetentionStructure
}

export interface RetentionOptimizerOptions {
  retentionMode?: RetentionMode
  hookStyle?: HookStyle
  targetDurationSeconds?: number
}

function estimateDurationSeconds(script: string): number {
  // 按中文语速 ~250 字/分钟，再乘以短视频节奏系数 0.9
  return Math.max(1, Math.ceil((script.length / 250) * 60 * 0.9))
}

function stripSentenceEnd(sentence: string): string {
  return sentence.trim().replace(/[。！？!?]+$/g, '').trim()
}

function splitSentences(script: string): string[] {
  const matches = script
    .replace(/\r/g, '\n')
    .split(/(?<=[。！？!?])|\n+/)
    .map(stripSentenceEnd)
    .filter(Boolean)
  if (matches.length) return matches
  const fallback = stripSentenceEnd(script)
  return fallback ? [fallback] : []
}

function extractOpeningHook(optimized: string, style: HookStyle): string | undefined {
  const firstSentence = splitSentences(optimized)[0]
  if (!firstSentence) return undefined
  if (style === 'auto') {
    return firstSentence.length > 60 ? firstSentence.slice(0, 60) + '……' : firstSentence
  }
  return firstSentence
}

function extractCliffhanger(optimized: string): string | undefined {
  const sentences = splitSentences(optimized)
  return sentences.length ? sentences[sentences.length - 1] : undefined
}

function makeQuestionFromText(text: string, fallback: string): string {
  const normalized = stripSentenceEnd(text)
  if (!normalized) return fallback
  if (/[？?]$/.test(normalized)) return normalized
  return `${normalized}，这背后到底藏着什么？`
}

export function buildRetentionStructureFromScript(
  productionScript: string,
  options: { hookStyle?: HookStyle } = {},
): RetentionStructure | undefined {
  const sentences = splitSentences(productionScript)
  if (!sentences.length) return undefined

  const hookStyle = options.hookStyle ?? 'auto'
  const openingHook = extractOpeningHook(productionScript, hookStyle) || sentences[0]
  const cliffhanger = extractCliffhanger(productionScript) || sentences[sentences.length - 1]
  const middle = sentences.slice(1, Math.max(1, sentences.length - 1))
  const estimatedDuration = estimateDurationSeconds(productionScript)

  const selectedMiddle = middle.length ? middle : sentences.slice(0, 1)
  const midBeats = selectedMiddle.slice(0, 4).map((sentence, index) => ({
    atSeconds: Math.min(Math.max(6 + index * 12, 6), Math.max(estimatedDuration - 8, 6)),
    label: index === 0 ? '第一证据/反转' : `留存推进 ${index + 1}`,
    question: makeQuestionFromText(sentence, '这条证据会怎样改变局势？'),
    purpose: index === 0
      ? '在 15-30 秒给出第一个证据或反转，承接开头悬念'
      : '用新的证据、代价或权力关系维持观看动机',
    sourceEvidence: [sentence],
  }))

  return {
    openingHook: {
      text: openingHook,
      visualBeat: '0-3 秒使用强冲突证据、朱批特写、群臣争执或账本数字承接第一句',
      question: makeQuestionFromText(openingHook, '观众为什么要继续看？'),
      durationSeconds: 6,
    },
    cliffhanger: {
      text: cliffhanger,
      visualBeat: '结尾停在下一步动作、未揭开的账本或冲突升级前一刻',
      nextQuestion: makeQuestionFromText(cliffhanger, '下一集最大的未解问题是什么？'),
      durationSeconds: 5,
    },
    midBeats,
    retentionChecks: [
      '0-3 秒给反常事实或利益反差，不先铺背景',
      '3-6 秒明确核心冲突',
      '6-15 秒交代具体代价、权力关系或钱的问题',
      '15-30 秒给第一个证据或反转',
      '结尾留下下一集必须回答的问题',
    ],
  }
}

function summarizeChanges(original: string, optimized: string): string[] {
  const changes: string[] = []
  if (optimized.length < original.length * 0.9) {
    changes.push(`字数压缩 ${original.length} → ${optimized.length}`)
  }
  if (optimized.length < original.length * 0.7) {
    changes.push('大幅精简铺垫与重复总结')
  }
  return changes
}

export async function optimizeScriptForRetention(
  script: string,
  options: RetentionOptimizerOptions = {},
): Promise<RetentionOptimizationResult> {
  const retentionMode = options.retentionMode ?? 'tight'
  const hookStyle = options.hookStyle ?? 'auto'

  if (retentionMode === 'standard') {
    return {
      cleanScript: script,
      productionScript: script,
      content: script,
      hookStyle,
      estimatedDurationSeconds: estimateDurationSeconds(script),
      changes: [],
    }
  }

  const optimized = await cleanDirectScript(script, {
    retentionMode,
    hookStyle,
    temperature: 0.4,
  })

  const openingHook = extractOpeningHook(optimized, hookStyle)
  const cliffhanger = extractCliffhanger(optimized)
  const changes = summarizeChanges(script, optimized)
  const retentionBeats = buildRetentionStructureFromScript(optimized, { hookStyle })

  return {
    cleanScript: script,
    productionScript: optimized,
    content: optimized,
    openingHook,
    cliffhanger,
    hookStyle,
    estimatedDurationSeconds: estimateDurationSeconds(optimized),
    changes,
    retentionBeats,
  }
}
