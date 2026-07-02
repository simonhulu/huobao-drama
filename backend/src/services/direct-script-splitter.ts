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
  type PlotProgressionBeat,
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
  estimatedDurationSeconds: number
  coveredBeatIds: string[]
}

export interface DirectScriptSplitResult {
  segments: DirectScriptSegment[]
  plotProgressionChain: PlotProgressionBeat[]
  seriesHook: string
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
      estimatedDurationSeconds: 0,
      coveredBeatIds: [],
    }))
}

export async function smartSplitDirectScript(
  sourceText: string,
  options: SmartSplitDirectScriptOptions,
): Promise<DirectScriptSplitResult> {
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

  return {
    segments: result.episodes.map((ep: MaterializedSmartSplitEpisode) => ({
      title: ep.title,
      content: ep.content,
      summary: ep.summary,
      estimatedDurationSeconds: ep.estimatedDurationSeconds,
      coveredBeatIds: ep.coveredBeatIds,
    })),
    plotProgressionChain: result.plotProgressionChain,
    seriesHook: result.hook,
  }
}

export { getSmartSplitDurationPreset, type SmartSplitDurationPreset }
