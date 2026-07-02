/**
 * Direct-script storyboard splitter.
 *
 * In direct_script mode there is no narration/dub audio, so the shot duration is
 * driven by `storyboards.duration`. Long text paragraphs that stay on screen for
 * more than ~8 seconds feel static and hurt text-image alignment. This module
 * splits such shots into multiple ≤8-second sub-shots, each with its own text
 * snippet and image prompt.
 */
import { stripVideoTags } from './adapters/prompt-utils.js'
import { normalizeStoryboardImagePromptForAspectRatio } from './storyboard-aspect-prompt.js'

export const DEFAULT_DIRECT_SCRIPT_MAX_DURATION_SECONDS = 8
export const DIRECT_SCRIPT_READING_CHARS_PER_SECOND = 4.5

export interface StoryboardInput {
  shot_number: number
  title?: string
  shot_type?: string
  angle?: string
  movement?: string
  location?: string
  time?: string
  action?: string
  dialogue?: string
  narration?: string
  description?: string
  result?: string
  atmosphere?: string
  image_prompt?: string
  video_prompt?: string
  bgm_prompt?: string
  sound_effect?: string
  duration?: number
  energy_level?: 'high' | 'medium' | 'low'
  scene_id?: number | null
  character_ids?: number[]
}

function isCjk(char: string): boolean {
  return /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]/.test(char)
}

export function estimateReadingDurationSeconds(text: string | null | undefined): number {
  const trimmed = (text || '').trim()
  if (!trimmed) return 0
  let cjk = 0
  let other = 0
  for (const char of trimmed) {
    if (isCjk(char)) cjk++
    else other++
  }
  const duration = cjk / DIRECT_SCRIPT_READING_CHARS_PER_SECOND + other / 8
  return Math.max(1, Math.ceil(duration))
}

function estimateStoryTextDuration(sb: StoryboardInput): number {
  const text = [
    sb.title,
    sb.description,
    sb.action,
    sb.result,
    sb.atmosphere,
    sb.narration,
    sb.dialogue,
  ]
    .map(v => (v || '').trim())
    .filter(Boolean)
    .join('。')
  return estimateReadingDurationSeconds(text)
}

export function splitIntoVisualClauses(text: string | null | undefined): string[] {
  const trimmed = (text || '').trim()
  if (!trimmed) return []

  return trimmed
    .split(/([，,；;。！？.!?]+)/)
    .filter(Boolean)
    .reduce<string[]>((acc, part) => {
      if (/^[，,；;。！？.!?]+$/.test(part)) {
        const prev = acc[acc.length - 1]
        if (prev !== undefined) acc[acc.length - 1] = prev + part
      } else {
        acc.push(part)
      }
      return acc
    }, [])
    .map(s => s.trim())
    .filter(Boolean)
}

export function splitTextIntoChunks(text: string | null | undefined, parts: number): string[] {
  const trimmed = (text || '').trim()
  if (!trimmed || parts <= 1) return [trimmed]

  const clauses = splitIntoVisualClauses(trimmed)
  if (clauses.length === 0) return Array.from({ length: parts }, () => trimmed)
  if (clauses.length <= parts) {
    const result = clauses.slice()
    while (result.length < parts) result.push('')
    return result
  }

  const targetLength = Math.ceil(trimmed.length / parts)
  const chunks: string[] = []
  let current = ''
  for (const clause of clauses) {
    const candidate = current ? `${current}${clause}` : clause
    if (current && chunks.length < parts - 1 && candidate.length > targetLength) {
      chunks.push(current)
      current = clause
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)

  while (chunks.length < parts) chunks.push('')
  if (chunks.length > parts) {
    const head = chunks.slice(0, parts - 1)
    const tail = chunks.slice(parts - 1).join('')
    return [...head, tail]
  }
  return chunks
}

function compactTitle(text: string, fallback: string): string {
  const normalized = text
    .replace(/^[0-9]{4}年[，,]?\s*/u, '')
    .replace(/^[，,；;。！？.!?\s]+/u, '')
    .replace(/[，,；;。！？.!?\s]+$/u, '')
    .trim()
  if (!normalized) return fallback
  return normalized.slice(0, 8)
}

function buildChunkImagePrompt(
  sb: StoryboardInput,
  beat: string,
  aspectRatio?: string | null,
  style?: string | null,
): string {
  const base = [
    beat || sb.action || sb.description || sb.image_prompt || sb.title || '',
    sb.location ? `地点：${sb.location}` : '',
    sb.time ? `时间：${sb.time}` : '',
    sb.atmosphere ? `氛围：${sb.atmosphere}` : '',
    style ? `风格：${style}` : '',
    '单帧静态画面，只表现当前视觉节拍',
  ]
    .filter(Boolean)
    .join('，')

  return normalizeStoryboardImagePromptForAspectRatio(stripVideoTags(base), aspectRatio)
}

function buildChunkVideoPrompt(sb: StoryboardInput, beat: string): string {
  return [
    sb.movement ? `运镜：${sb.movement}` : '',
    beat || sb.description || sb.action || sb.title || '',
    sb.location ? `地点：${sb.location}` : '',
    sb.time ? `时间：${sb.time}` : '',
    sb.atmosphere ? `氛围：${sb.atmosphere}` : '',
  ]
    .filter(Boolean)
    .join('，')
}

function distributeDuration(totalSeconds: number, parts: number): number[] {
  if (parts <= 1) return [totalSeconds]
  const base = Math.floor(totalSeconds / parts)
  const remainder = totalSeconds % parts
  const durations: number[] = []
  for (let i = 0; i < parts; i++) {
    durations.push(base + (i < remainder ? 1 : 0))
  }
  return durations
}

/**
 * Split a single direct-script storyboard into multiple shots if its expected
 * on-screen time exceeds `maxDurationSeconds`. Text fields are split by visual
 * clauses so each sub-shot carries a coherent fragment of the original paragraph.
 */
export function splitStoryboardForDirectScript(
  sb: StoryboardInput,
  options?: {
    maxDurationSeconds?: number
    aspectRatio?: string | null
    style?: string | null
  },
): StoryboardInput[] {
  const maxDuration = options?.maxDurationSeconds ?? DEFAULT_DIRECT_SCRIPT_MAX_DURATION_SECONDS
  const textDuration = estimateStoryTextDuration(sb)
  const declaredDuration = sb.duration && sb.duration > 0 ? sb.duration : 0

  // If both text and declared duration fit, keep the shot as-is.
  if (textDuration <= maxDuration && declaredDuration <= maxDuration) {
    return [sb]
  }

  // If the text fits but the agent declared an excessive duration (sometimes it
  // mistakenly returns character counts instead of seconds), clamp it without splitting.
  if (textDuration <= maxDuration) {
    return [{ ...sb, duration: Math.min(declaredDuration, maxDuration) }]
  }

  // Split by estimated reading time. Do not cap the number of parts so that every
  // sub-shot stays within maxDuration.
  const parts = Math.max(2, Math.ceil(textDuration / maxDuration))
  const durations = distributeDuration(textDuration, parts)

  const descriptionChunks = splitTextIntoChunks(sb.description, parts)
  const actionChunks = splitTextIntoChunks(sb.action, parts)
  const resultChunks = splitTextIntoChunks(sb.result, parts)
  const atmosphereChunks = splitTextIntoChunks(sb.atmosphere, parts)
  const narrationChunks = splitTextIntoChunks(sb.narration, parts)
  const dialogueChunks = splitTextIntoChunks(sb.dialogue, parts)

  return Array.from({ length: parts }, (_, i) => {
    const suffix = parts > 2 ? ` (${i + 1}/${parts})` : ''
    const beat = (
      descriptionChunks[i]
      || actionChunks[i]
      || resultChunks[i]
      || narrationChunks[i]
      || dialogueChunks[i]
      || sb.description
      || sb.title
      || ''
    ).trim()

    const title = compactTitle(beat, `${sb.title || `镜头${sb.shot_number}`}${suffix}`)

    return {
      ...sb,
      title,
      description: descriptionChunks[i] || beat || sb.description || '',
      action: actionChunks[i] || beat || sb.action || '',
      result: resultChunks[i] || '',
      atmosphere: atmosphereChunks[i] || sb.atmosphere || '',
      narration: narrationChunks[i] || '',
      dialogue: dialogueChunks[i] || '',
      image_prompt: buildChunkImagePrompt(sb, beat, options?.aspectRatio, options?.style),
      video_prompt: buildChunkVideoPrompt(sb, beat),
      duration: durations[i],
      energy_level: sb.energy_level || 'medium',
    }
  })
}

/**
 * Expand a list of storyboards, splitting any direct-script shots that are too
 * long, then renumber them sequentially.
 */
export function expandDirectScriptStoryboards(
  storyboards: StoryboardInput[],
  options?: {
    maxDurationSeconds?: number
    aspectRatio?: string | null
    style?: string | null
  },
): StoryboardInput[] {
  const expanded: StoryboardInput[] = []
  for (const sb of storyboards) {
    expanded.push(...splitStoryboardForDirectScript(sb, options))
  }
  return expanded.map((sb, index) => ({ ...sb, shot_number: index + 1 }))
}
