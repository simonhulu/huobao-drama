/**
 * 精稿直出导入时的 AI 智能分集
 *
 * 直接复用项目已有的 splitStoryIntoEpisodes，但使用 default 风格，
 * 强调保留完整上下文、不压缩关键信息、不为了短剧节奏丢失原文。
 */
import {
  splitStoryIntoEpisodes,
  getSmartSplitDurationPreset,
  type SmartSplitDurationPreset,
  type MaterializedSmartSplitEpisode,
} from './episode-splitter.js'

export interface SmartSplitDirectScriptOptions {
  durationPresetId: string
  style?: 'default' | 'ai_manga_drama'
  pacingMode?: string
  dramaTitle?: string | null
}

export interface DirectScriptSegment {
  title: string
  content: string
  summary: string
  openingHook: string
  cliffhangerHook: string
  estimatedDurationSeconds: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function splitDirectScriptByMarkers(sourceText: string, markers: string[]): DirectScriptSegment[] {
  const normalizedMarkers = markers
    .map(marker => String(marker || '').trim())
    .filter(Boolean)
  if (!normalizedMarkers.length) return []

  const markerPattern = new RegExp(normalizedMarkers.map(escapeRegExp).join('|'), 'g')
  return sourceText
    .split(markerPattern)
    .map(part => part.trim())
    .filter(Boolean)
    .map((content, index) => ({
      title: `第${index + 1}段`,
      content,
      summary: '',
      openingHook: '',
      cliffhangerHook: '',
      estimatedDurationSeconds: 0,
    }))
}

export async function smartSplitDirectScript(
  sourceText: string,
  options: SmartSplitDirectScriptOptions,
): Promise<DirectScriptSegment[]> {
  const durationPreset = getSmartSplitDurationPreset(options.durationPresetId)
  if (!durationPreset) {
    throw new Error(`Unknown duration preset: ${options.durationPresetId}`)
  }

  const result = await splitStoryIntoEpisodes({
    dramaTitle: options.dramaTitle,
    sourceText,
    durationPresetId: options.durationPresetId,
    style: options.style ?? 'default',
    pacingMode: options.pacingMode ?? 'standard',
  })

  return result.episodes.map((ep: MaterializedSmartSplitEpisode) => ({
    title: ep.title,
    content: ep.content,
    summary: ep.summary,
    openingHook: ep.openingHook,
    cliffhangerHook: ep.cliffhangerHook,
    estimatedDurationSeconds: ep.estimatedDurationSeconds,
  }))
}

export { getSmartSplitDurationPreset, type SmartSplitDurationPreset }
