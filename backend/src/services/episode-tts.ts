/**
 * 整集统一 TTS 合成服务
 * 把一集所有分镜的旁白拼成一段长文本，调一次 MiniMax 异步 TTS，
 * 然后按返回的句级字幕时间戳切成每镜一段音频。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import ffmpeg from 'fluent-ffmpeg'
import { v4 as uuid } from 'uuid'
import { eq, inArray, asc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { callTextModel, getAudioConfigById, getNarrationAudioConfig } from './ai.js'
import { isIgnorableTTS } from './ffmpeg-compose.js'
import { MiniMaxTTSAdapter, retrieveAsyncResult, type TTSParams } from './adapters/minimax-tts.js'
import { resolveStoryboardNarrationTextForTTS, getVerbatimSource, findOriginalFragmentRange } from './narration-generation.js'
import { usesOriginalTextForNarration } from './episode-mode.js'
import { logTaskStart, logTaskProgress, logTaskSuccess, logTaskError } from '../utils/task-logger.js'
import { normalizeTtsText } from '../utils/tts-text.js'
import { DEFAULT_NARRATION_VOICE_ID } from './narration-defaults.js'
import { sanitizeCharacterVisualIdentity } from './character-visual-identity.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')

interface Segment {
  id: number
  text: string
  startChar: number
  endChar: number
}

interface SegmentTiming {
  id: number
  startMs: number
  endMs: number
}

export interface GenerateEpisodeUnifiedTTSOptions {
  model?: string
  emotion?: string
  onlyStoryboardIds?: number[]
}

export interface EpisodePreTTSResult {
  audioUrl: string
  titles: any[]
  extra: Record<string, any>
}

/**
 * 在拆镜前预生成整集 TTS，并保存句级字幕时间轴。
 * direct_script 下用这些真实时间戳来设定每个分镜的 duration。
 */
export async function generateEpisodePreTTS(episodeId: number): Promise<EpisodePreTTSResult> {
  logTaskStart('EpisodeTTS', 'pre-tts-start', { episodeId })

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)

  const sourceText = getVerbatimSource(ep)
  if (!sourceText) throw new Error(`Episode ${episodeId} has no source text for pre-TTS`)

  const config = getNarrationAudioConfig() ?? getAudioConfigById(ep.audioConfigId ?? undefined)
  if (!config) throw new Error(`Episode ${episodeId} has no active audio config`)

  const voiceId = ep.narrationVoiceId || DEFAULT_NARRATION_VOICE_ID
  const speed = ep.narrationSpeed ?? 1.0

  const adapter = new MiniMaxTTSAdapter()
  const params: TTSParams = {
    text: sourceText,
    voice: voiceId,
    speed,
    subtitleEnable: true,
    subtitleType: 'sentence',
  }

  const { url, method, headers, body } = adapter.buildGenerateRequest(config, params)
  const createResp = await fetch(url, { method, headers, body: JSON.stringify(body) })
  if (!createResp.ok) {
    const errText = await createResp.text()
    throw new Error(`Pre-TTS create error ${createResp.status}: ${errText}`)
  }

  const createResult = await createResp.json()
  if (createResult.base_resp?.status_code !== 0) {
    throw new Error(createResult.base_resp?.status_msg || 'Pre-TTS create failed')
  }

  const taskId = createResult.task_id
  const fileId = createResult.file_id
  logTaskProgress('EpisodeTTS', 'pre-tts-created', { episodeId, taskId, fileId })

  const { audioBuffer, titles, extra } = await retrieveAsyncResult(config, taskId, fileId)
  logTaskProgress('EpisodeTTS', 'pre-tts-retrieved', {
    episodeId,
    audioBytes: audioBuffer.length,
    titleCount: Array.isArray(titles) ? titles.length : 0,
    extraAudioLength: extra?.audio_length,
  })

  const audioDir = path.join(STORAGE_ROOT, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const filename = `${uuid()}_pre_episode${episodeId}.mp3`
  const absPath = path.join(audioDir, filename)
  fs.writeFileSync(absPath, audioBuffer)
  const audioUrl = `static/audio/${filename}`

  db.update(schema.episodes)
    .set({
      preTtsAudioUrl: audioUrl,
      preTtsTitlesJson: JSON.stringify(titles),
      updatedAt: now(),
    })
    .where(eq(schema.episodes.id, episodeId))
    .run()

  logTaskSuccess('EpisodeTTS', 'pre-tts-done', { episodeId, audioUrl, titleCount: titles.length })
  return { audioUrl, titles, extra }
}

interface TitleItem {
  text?: string
  text_begin?: number
  text_end?: number
  time_begin?: number
  time_end?: number
}

function buildTitleTimelineText(titles: TitleItem[]): string {
  return titles
    .slice()
    .sort((a, b) => Number(a.text_begin) - Number(b.text_begin))
    .map((title) => String(title.text || ''))
    .join('')
}

/**
 * 用预生成的 TTS 时间戳修正所有分镜的 duration。
 * 只在 direct_script / verbatim 模式下生效。
 */
export function applyPreTTSTimingsToStoryboards(episodeId: number): { updated: number; fallback: number } {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep?.preTtsTitlesJson) return { updated: 0, fallback: 0 }

  let titles: TitleItem[]
  try {
    titles = JSON.parse(ep.preTtsTitlesJson)
  } catch {
    return { updated: 0, fallback: 0 }
  }
  if (!Array.isArray(titles) || titles.length === 0) return { updated: 0, fallback: 0 }

  const timelineText = buildTitleTimelineText(titles)
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  let updated = 0
  let fallback = 0

  for (const sb of storyboards) {
    const fragment = resolveStoryboardNarrationTextForTTS(sb, ep)
    if (!fragment) {
      fallback++
      continue
    }

    const range = findOriginalFragmentRange(timelineText, fragment)
    if (!range) {
      fallback++
      continue
    }

    const startMs = findTimeAtChar(titles, range.start, 'begin')
    const endMs = findTimeAtChar(titles, range.end, 'end')

    if (startMs === null || endMs === null || endMs <= startMs) {
      fallback++
      continue
    }

    const duration = Math.max(1, Math.ceil((endMs - startMs) / 1000))
    db.update(schema.storyboards)
      .set({ duration, updatedAt: now() })
      .where(eq(schema.storyboards.id, sb.id))
      .run()
    updated++
  }

  return { updated, fallback }
}

function findTimeAtChar(
  titles: TitleItem[],
  charIndex: number,
  edge: 'begin' | 'end',
): number | null {
  for (const t of titles) {
    const textBegin = Number(t.text_begin)
    const textEnd = Number(t.text_end)
    const timeBegin = Number(t.time_begin)
    const timeEnd = Number(t.time_end)
    if (!Number.isFinite(textBegin) || !Number.isFinite(textEnd) ||
        !Number.isFinite(timeBegin) || !Number.isFinite(timeEnd)) continue

    // 用比例插值，避免 description 从句子中间开始时把整个句子的开头音频算进来
    const inside = edge === 'begin'
      ? charIndex >= textBegin && charIndex < textEnd
      : charIndex > textBegin && charIndex <= textEnd
    if (inside) {
      const textLen = textEnd - textBegin
      const timeLen = timeEnd - timeBegin
      if (textLen <= 0 || timeLen <= 0) {
        return edge === 'begin' ? timeBegin : timeEnd
      }
      const ratio = (charIndex - textBegin) / textLen
      return Math.round(timeBegin + timeLen * ratio)
    }
  }
  return null
}

interface ChildPromptContext {
  index: number
  groupText: string
  parentImagePrompt: string | null
  shotType: string | null
  angle: string | null
  movement: string | null
  location: string | null
  time: string | null
  action: string | null
  dialogue: string | null
  atmosphere: string | null
  characters: Array<{ name: string; appearance: string | null }>
  dramaStyle: string | null
}

interface SplitCharacterInfo {
  id: number
  name: string
  role: string | null
  appearance: string | null
}

interface PendingSplitChild {
  index: number
  group: TimedVisualClause[]
  groupDuration: number
  suffix: string
  characterIds: number[]
}

interface TimedVisualClause {
  text: string
  text_begin: number
  text_end: number
  time_begin: number
  time_end: number
}

interface PendingSplit {
  originalId: number
  storyboardNumber: number
  title: string | null
  shotType: string | null
  angle: string | null
  movement: string | null
  location: string | null
  time: string | null
  action: string | null
  dialogue: string | null
  result: string | null
  atmosphere: string | null
  videoPrompt: string | null
  bgmPrompt: string | null
  soundEffect: string | null
  sceneId: number | null
  status: string | null
  energyLevel: string | null
  children: PendingSplitChild[]
}

function selectCharactersForFragment(
  text: string,
  allCharacters: SplitCharacterInfo[],
  fallbackIds: number[],
): SplitCharacterInfo[] {
  const normalized = text.replace(/[\s\p{P}\p{S}]/gu, '')
  const direct = allCharacters.filter((character) => {
    const name = character.name.replace(/[\s\p{P}\p{S}]/gu, '')
    return name.length >= 2 && normalized.includes(name)
  })
  if (direct.length) return direct

  const relationMatchers: Array<{ text: RegExp; character: RegExp }> = [
    { text: /妻子|夫人|遗孀|老婆/u, character: /妻子|夫人|遗孀|老婆/u },
    { text: /九十五岁|老头|利文斯顿医生/u, character: /九十五岁|老头|乡村医生/u },
  ]
  for (const matcher of relationMatchers) {
    if (!matcher.text.test(text)) continue
    const matched = allCharacters.filter((character) => matcher.character.test([
      character.name,
      character.role || '',
      character.appearance || '',
    ].join(' ')))
    if (matched.length) return matched
  }

  const fallback = allCharacters.filter((character) => fallbackIds.includes(character.id))
  return fallback
}

function buildChildImagePromptSystemPrompt(): string {
  return [
    'You are a trailer director, cinematographer, and storyboard designer.',
    'You receive an ordered sequence of shot fragments split from one or more longer storyboards.',
    'Plan the sibling fragments as a continuous film sequence, then write one English image-generation prompt for each fragment.',
    '',
    'Rules:',
    '1. Output ONLY a JSON object with field "prompts": an array of { "index": number, "image_prompt": string }.',
    '2. Use the exact input index for each fragment; do not skip or reorder.',
    '3. Each prompt must describe a single static frame in English.',
    '4. Each prompt must capture ONLY its assigned narration fragment. Never carry an action or subject from an earlier fragment into a later one.',
    '5. Across siblings in the same scene, lock faces, age, hair, costume, props, environment, time, weather, light direction, and color response.',
    '6. Create visual progression through shot size, camera angle, camera position, action, expression, blocking, foreground occlusion, and focus only. Preserve eyelines, screen direction, axis, spatial relationships, light, and color.',
    '7. Build setup -> development -> turn -> landing. Vary establishing wide, full, medium, close, face close-up, extreme detail, and a high/low power angle where the sequence supports them.',
    '8. Do not add people, animals, vehicles, weapons, buildings, or props that are absent from the current fragment, cast, or parent context.',
    '9. Wide shots use deeper focus; medium shots retain readable background structure; close shots use natural shallow focus. Do not make every shot shallow-focus.',
    '10. Do not include XML tags, subtitles, text overlays, camera UI, or any rendered words in the image.',
    '11. Keep each prompt under 1200 characters.',
    '12. If a drama style is provided, apply it through visible photographic mechanisms, not a creator name.',
  ].join('\n')
}

function splitTextWithOffsets(text: string, absoluteStart: number): Array<{ text: string; start: number; end: number }> {
  const rawParts = text.split(/(?<=[，,；;。！？.!?：:—])/u)
  const result: Array<{ text: string; start: number; end: number }> = []
  let cursor = 0
  for (const rawPart of rawParts) {
    if (!rawPart) continue
    const leading = rawPart.length - rawPart.trimStart().length
    const trailing = rawPart.length - rawPart.trimEnd().length
    const start = cursor + leading
    const end = cursor + rawPart.length - trailing
    if (end > start) {
      result.push({ text: text.slice(start, end), start: absoluteStart + start, end: absoluteStart + end })
    }
    cursor += rawPart.length
  }
  return result
}

function splitOversizedClause(clause: TimedVisualClause, maxDurationMs: number): TimedVisualClause[] {
  const durationMs = clause.time_end - clause.time_begin
  if (durationMs <= maxDurationMs) return [clause]
  const parts = Math.max(2, Math.ceil(durationMs / maxDurationMs))
  const length = clause.text_end - clause.text_begin
  const result: TimedVisualClause[] = []
  for (let i = 0; i < parts; i++) {
    const startOffset = Math.floor((length * i) / parts)
    const endOffset = Math.floor((length * (i + 1)) / parts)
    if (endOffset <= startOffset) continue
    const startRatio = startOffset / length
    const endRatio = endOffset / length
    result.push({
      text: clause.text.slice(startOffset, endOffset),
      text_begin: clause.text_begin + startOffset,
      text_end: clause.text_begin + endOffset,
      time_begin: Math.round(clause.time_begin + durationMs * startRatio),
      time_end: Math.round(clause.time_begin + durationMs * endRatio),
    })
  }
  return result
}

function buildTimedVisualClauses(
  source: string,
  titles: TitleItem[],
  range: { start: number; end: number },
  maxDurationMs: number,
): TimedVisualClause[] {
  const fragment = source.slice(range.start, range.end)
  const clauses: TimedVisualClause[] = []
  for (const part of splitTextWithOffsets(fragment, range.start)) {
    const timeBegin = findTimeAtChar(titles, part.start, 'begin')
    const timeEnd = findTimeAtChar(titles, part.end, 'end')
    if (timeBegin === null || timeEnd === null || timeEnd <= timeBegin) continue
    clauses.push(...splitOversizedClause({
      text: part.text,
      text_begin: part.start,
      text_end: part.end,
      time_begin: timeBegin,
      time_end: timeEnd,
    }, maxDurationMs))
  }
  return clauses
}

function groupTimedVisualClauses(clauses: TimedVisualClause[], maxDurationMs: number): TimedVisualClause[][] {
  const groups: TimedVisualClause[][] = []
  let current: TimedVisualClause[] = []
  for (const clause of clauses) {
    if (!current.length) {
      current = [clause]
      continue
    }
    const candidateDuration = clause.time_end - current[0].time_begin
    if (candidateDuration <= maxDurationMs) {
      current.push(clause)
    } else {
      groups.push(current)
      current = [clause]
    }
  }
  if (current.length) groups.push(current)
  return groups
}

function compactSplitTitle(text: string, fallback: string): string {
  const compact = text
    .replace(/^[0-9]{4}年[0-9]{0,2}月?[，,]?/u, '')
    .replace(/^[\s，,；;。！？.!?：:—]+|[\s，,；;。！？.!?：:—]+$/gu, '')
    .trim()
  return compact ? compact.slice(0, 14) : fallback
}

function buildChildImagePromptUserPrompt(contexts: ChildPromptContext[]): string {
  const fragments = contexts.map((ctx) => {
    const lines = [
      `Index: ${ctx.index}`,
      `Fragment text: ${ctx.groupText}`,
      `Parent prompt hint: ${ctx.parentImagePrompt || '(none)'}`,
      `Shot type: ${ctx.shotType || ''}`,
      `Angle: ${ctx.angle || ''}`,
      `Movement: ${ctx.movement || ''}`,
      `Location: ${ctx.location || ''}`,
      `Time: ${ctx.time || ''}`,
      `Action: ${ctx.action || ''}`,
      `Dialogue: ${ctx.dialogue || ''}`,
      `Atmosphere: ${ctx.atmosphere || ''}`,
      `Characters: ${ctx.characters.map((c) => `${c.name}${c.appearance ? ` (${c.appearance})` : ''}`).join('; ') || '(none)'}`,
      `Drama style: ${ctx.dramaStyle || '(none)'}`,
    ]
    return lines.join('\n')
  }).join('\n\n---\n\n')

  return [
    'Write a distinct English image prompt for each fragment below.',
    '',
    fragments,
    '',
    'Return only the JSON object.',
  ].join('\n')
}

function parseChildImagePromptsResult(resultText: string): Array<{ index: number; imagePrompt: string }> {
  let text = resultText.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }
  const parsed = JSON.parse(text)
  const prompts = Array.isArray(parsed.prompts) ? parsed.prompts : Array.isArray(parsed) ? parsed : []
  return prompts
    .map((p: any) => ({
      index: Number(p.index ?? p.shot_number),
      imagePrompt: String(p.image_prompt ?? p.imagePrompt ?? p.prompt ?? '').trim(),
    }))
    .filter((p: any) => Number.isFinite(p.index))
}

const CHILD_PROMPT_BATCH_SIZE = 5

async function generateChildImagePrompts(contexts: ChildPromptContext[]): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  for (let i = 0; i < contexts.length; i += CHILD_PROMPT_BATCH_SIZE) {
    const batch = contexts.slice(i, i + CHILD_PROMPT_BATCH_SIZE)
    try {
      const raw = await callTextModel([
        { role: 'system', content: buildChildImagePromptSystemPrompt() },
        { role: 'user', content: buildChildImagePromptUserPrompt(batch) },
      ], {
        temperature: 0.5,
        maxTokens: 8000,
        responseFormat: { type: 'json_object' },
        extraBody: { thinking: { type: 'disabled' } },
      })
      const parsed = parseChildImagePromptsResult(raw)
      for (const p of parsed) {
        result.set(p.index, p.imagePrompt)
      }
    } catch (err) {
      logTaskError('EpisodeTTS', 'child-image-prompt-batch-failed', {
        batchIndex: i,
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      })
      // Fallback: leave prompts empty so downstream builders use description as a fallback.
    }
  }
  return result
}

/**
 * 按预生成 TTS 的真实时间轴，把超过 maxDurationSeconds 的镜头拆成多个子镜头。
 * 只在 direct_script / verbatim 模式下生效。
 * 返回 { split: 被拆分的原镜数量, created: 新增子镜头数量, fallback: 无法拆分的数量 }。
 */
export async function splitLongStoryboardsByPreTTS(
  episodeId: number,
  maxDurationSeconds: number = 12,
  deps?: {
    generateImagePrompts?: (contexts: ChildPromptContext[]) => Promise<Map<number, string>>
    onlyStoryboardIds?: number[]
  },
): Promise<{ split: number; created: number; fallback: number }> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep?.preTtsTitlesJson) return { split: 0, created: 0, fallback: 0 }
  if (!usesOriginalTextForNarration(ep)) return { split: 0, created: 0, fallback: 0 }

  let titles: TitleItem[]
  try {
    titles = JSON.parse(ep.preTtsTitlesJson)
  } catch {
    return { split: 0, created: 0, fallback: 0 }
  }
  if (!Array.isArray(titles) || titles.length === 0) return { split: 0, created: 0, fallback: 0 }

  const source = buildTitleTimelineText(titles)
  if (!source) return { split: 0, created: 0, fallback: 0 }

  const maxDurationMs = maxDurationSeconds * 1000
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()

  const dramaStyle = ep.dramaId
    ? db.select({ style: schema.dramas.style }).from(schema.dramas)
        .where(eq(schema.dramas.id, ep.dramaId)).all()[0]?.style || null
    : null
  const allCharacters: SplitCharacterInfo[] = ep.dramaId
    ? db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, ep.dramaId)).all()
        .map((character) => ({
          id: character.id,
          name: character.name || '',
          role: character.role || null,
          appearance: sanitizeCharacterVisualIdentity(character.appearance || character.description || character.role) || null,
        }))
    : []

  let splitCount = 0
  let createdCount = 0
  let fallbackCount = 0
  const replacements: Array<{ originalId: number; newIds: number[] }> = []
  const allContexts: ChildPromptContext[] = []
  const pendingSplits: PendingSplit[] = []
  let nextIndex = 0

  for (const sb of storyboards) {
    if (deps?.onlyStoryboardIds?.length && !deps.onlyStoryboardIds.includes(sb.id)) continue
    if ((sb.duration || 0) <= maxDurationSeconds) continue

    const fragment = resolveStoryboardNarrationTextForTTS(sb, ep)
    if (!fragment) {
      fallbackCount++
      continue
    }

    const range = findOriginalFragmentRange(source, fragment)
    if (!range) {
      fallbackCount++
      continue
    }

    const visualClauses = buildTimedVisualClauses(source, titles, range, maxDurationMs)
    if (visualClauses.length === 0) {
      fallbackCount++
      continue
    }
    const groups = groupTimedVisualClauses(visualClauses, maxDurationMs)

    if (groups.length <= 1) {
      // 句子无法进一步拆分，保持原镜
      fallbackCount++
      continue
    }

    // 查询原镜关联的角色
    const characterRows = db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
      .all()
    const characterIds = characterRows.map(r => r.characterId)

    const children: PendingSplitChild[] = []
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]
      const groupText = source.slice(group[0].text_begin, group[group.length - 1].text_end).trim()
      const groupStartMs = group[0].time_begin
      const groupEndMs = group[group.length - 1].time_end
      const groupDuration = Math.max(1, Math.ceil((groupEndMs - groupStartMs) / 1000))
      const suffix = `(${i + 1}/${groups.length})`
      const index = nextIndex++
      const childCharacters = selectCharactersForFragment(groupText, allCharacters, characterIds)

      allContexts.push({
        index,
        groupText,
        parentImagePrompt: sb.imagePrompt,
        shotType: sb.shotType,
        angle: sb.angle,
        movement: sb.movement,
        location: sb.location,
        time: sb.time,
        action: sb.action,
        dialogue: sb.dialogue,
        atmosphere: sb.atmosphere,
        characters: childCharacters,
        dramaStyle,
      })

      children.push({
        index,
        group,
        groupDuration,
        suffix,
        characterIds: childCharacters.map((character) => character.id),
      })
    }

    pendingSplits.push({
      originalId: sb.id,
      storyboardNumber: sb.storyboardNumber,
      title: sb.title,
      shotType: sb.shotType,
      angle: sb.angle,
      movement: sb.movement,
      location: sb.location,
      time: sb.time,
      action: sb.action,
      dialogue: sb.dialogue,
      result: sb.result,
      atmosphere: sb.atmosphere,
      videoPrompt: sb.videoPrompt,
      bgmPrompt: sb.bgmPrompt,
      soundEffect: sb.soundEffect,
      sceneId: sb.sceneId,
      status: sb.status,
      energyLevel: sb.energyLevel,
      children,
    })
    splitCount++
    createdCount += children.length
  }

  // 为所有子片段批量生成独立的 image prompt
  let promptMap = new Map<number, string>()
  if (allContexts.length > 0) {
    const generator = deps?.generateImagePrompts ?? generateChildImagePrompts
    promptMap = await generator(allContexts)
  }

  const ts = now()
  for (const plan of pendingSplits) {
    const newIds: number[] = []

    for (const child of plan.children) {
      const groupText = source.slice(child.group[0].text_begin, child.group[child.group.length - 1].text_end).trim()
      const imagePrompt = promptMap.get(child.index) ?? ''

      const res = db.insert(schema.storyboards).values({
        episodeId,
        storyboardNumber: plan.storyboardNumber,
        title: compactSplitTitle(groupText, `${plan.title || '镜头'}${child.suffix}`),
        shotType: null,
        angle: null,
        movement: null,
        location: plan.location,
        time: plan.time,
        action: groupText,
        dialogue: null,
        description: groupText,
        narration: groupText,
        result: null,
        atmosphere: plan.atmosphere,
        imagePrompt,
        videoPrompt: null,
        bgmPrompt: plan.bgmPrompt,
        soundEffect: plan.soundEffect,
        sceneId: plan.sceneId,
        duration: child.groupDuration,
        energyLevel: plan.energyLevel,
        status: plan.status,
        createdAt: ts,
        updatedAt: ts,
      }).run()

      const newId = Number(res.lastInsertRowid)
      newIds.push(newId)

      for (const characterId of child.characterIds) {
        db.insert(schema.storyboardCharacters).values({
          storyboardId: newId,
          characterId,
        }).run()
      }
    }

    replacements.push({ originalId: plan.originalId, newIds })
  }

  // 删除原镜及其角色关联
  for (const { originalId } of replacements) {
    db.delete(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, originalId))
      .run()
    db.delete(schema.storyboards)
      .where(eq(schema.storyboards.id, originalId))
      .run()
  }

  // 重排本集所有分镜编号
  const remaining = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id))
    .all()

  for (let i = 0; i < remaining.length; i++) {
    db.update(schema.storyboards)
      .set({ storyboardNumber: i + 1, updatedAt: now() })
      .where(eq(schema.storyboards.id, remaining[i].id))
      .run()
  }

  logTaskSuccess('EpisodeTTS', 'split-long-storyboards', {
    episodeId,
    maxDurationSeconds,
    split: splitCount,
    created: createdCount,
    fallback: fallbackCount,
  })

  return { split: splitCount, created: createdCount, fallback: fallbackCount }
}

async function reusePreTTSForEpisode(
  episodeId: number,
  ep: any,
  rawStoryboards: any[],
  options: GenerateEpisodeUnifiedTTSOptions = {},
): Promise<{ fullAudioPath: string; segmentCount: number; fallback: boolean }> {
  logTaskProgress('EpisodeTTS', 'unified-tts-reuse-pre', { episodeId })

  let titles: TitleItem[]
  try {
    titles = JSON.parse(ep.preTtsTitlesJson)
  } catch {
    titles = []
  }
  if (!Array.isArray(titles) || titles.length === 0) {
    throw new Error(`Episode ${episodeId} has pre-TTS audio but no titles`)
  }

  const source = buildTitleTimelineText(titles)
  const audioDir = path.join(STORAGE_ROOT, 'audio')
  const fullAudioPathAbs = path.join(audioDir, path.basename(ep.preTtsAudioUrl))
  if (!fs.existsSync(fullAudioPathAbs)) {
    throw new Error(`Pre-TTS audio file not found: ${fullAudioPathAbs}`)
  }

  const totalAudioMs = titles.length ? Number(titles[titles.length - 1].time_end) : 0

  let splitCount = 0
  let fallback = false
  for (const sb of rawStoryboards) {
    const fragment = resolveStoryboardNarrationTextForTTS(sb, ep)
    if (!fragment) {
      fallback = true
      db.update(schema.storyboards)
        .set({ narrationAudioUrl: null, updatedAt: now() })
        .where(eq(schema.storyboards.id, sb.id))
        .run()
      continue
    }

    const range = findOriginalFragmentRange(source, fragment)
    if (!range) {
      fallback = true
      db.update(schema.storyboards)
        .set({ narrationAudioUrl: null, updatedAt: now() })
        .where(eq(schema.storyboards.id, sb.id))
        .run()
      continue
    }

    const startMs = findTimeAtChar(titles, range.start, 'begin')
    const endMs = findTimeAtChar(titles, range.end, 'end')

    if (startMs === null || endMs === null || endMs <= startMs) {
      fallback = true
      db.update(schema.storyboards)
        .set({ narrationAudioUrl: null, updatedAt: now() })
        .where(eq(schema.storyboards.id, sb.id))
        .run()
      continue
    }

    const startSec = startMs / 1000
    const durationSec = (endMs - startMs) / 1000
    const segmentFilename = `${uuid()}.m4a`
    const segmentAbsPath = path.join(audioDir, segmentFilename)

    await splitAndNormalizeAudio(fullAudioPathAbs, startSec, durationSec, segmentAbsPath)

    const segmentTitles = extractSegmentTitles(titles, range.start, range.end, startMs)
    if (segmentTitles.length > 0) {
      const titlesPath = path.join(audioDir, `${segmentFilename}.titles.json`)
      fs.writeFileSync(titlesPath, JSON.stringify({
        text: fragment,
        titles: segmentTitles,
        extra: { audio_length: endMs - startMs },
        createdAt: new Date().toISOString(),
      }, null, 2), 'utf-8')
    }

    db.update(schema.storyboards)
      .set({ narrationAudioUrl: `static/audio/${segmentFilename}`, updatedAt: now() })
      .where(eq(schema.storyboards.id, sb.id))
      .run()
    splitCount++
  }

  logTaskSuccess('EpisodeTTS', 'unified-tts-reuse-done', {
    episodeId,
    fullAudioPath: ep.preTtsAudioUrl,
    segmentCount: splitCount,
    fallback,
  })

  return { fullAudioPath: ep.preTtsAudioUrl, segmentCount: splitCount, fallback }
}

/**
 * 生成整集统一旁白 TTS，并把切分后的音频写入每个分镜的 narration_audio_url
 */
export async function generateEpisodeUnifiedTTS(
  episodeId: number,
  options: GenerateEpisodeUnifiedTTSOptions = {},
): Promise<{ fullAudioPath: string; segmentCount: number; fallback: boolean }> {
  logTaskStart('EpisodeTTS', 'unified-tts-start', { episodeId })

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)

  const config = getNarrationAudioConfig() ?? getAudioConfigById(ep.audioConfigId ?? undefined)
  if (!config) throw new Error(`Episode ${episodeId} has no active audio config`)

  const voiceId = ep.narrationVoiceId || DEFAULT_NARRATION_VOICE_ID
  const speed = ep.narrationSpeed ?? 1.0

  const rawStoryboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter((sb) => !options.onlyStoryboardIds?.length || options.onlyStoryboardIds.includes(sb.id))

  // direct_script 且已有预生成 TTS：直接复用整段音频并按分镜切片
  if (ep.preTtsAudioUrl && ep.preTtsTitlesJson && usesOriginalTextForNarration(ep)) {
    return reusePreTTSForEpisode(episodeId, ep, rawStoryboards, options)
  }

  const segments: Segment[] = []
  let fullText = ''
  for (const sb of rawStoryboards) {
    const clean = normalizeTtsText(resolveStoryboardNarrationTextForTTS(sb, ep))
    if (!clean || isIgnorableTTS(clean)) continue
    const startChar = fullText.length
    fullText += clean
    segments.push({ id: sb.id, text: clean, startChar, endChar: fullText.length })
  }

  if (segments.length === 0) {
    throw new Error(`Episode ${episodeId} has no narratable text`)
  }

  logTaskProgress('EpisodeTTS', 'unified-tts-text-built', {
    episodeId,
    segmentCount: segments.length,
    totalChars: fullText.length,
  })

  const adapter = new MiniMaxTTSAdapter()
  const params: TTSParams = {
    text: fullText,
    voice: voiceId,
    speed,
    model: options.model,
    emotion: options.emotion,
    subtitleEnable: true,
    subtitleType: 'word',
  }

  const { url, method, headers, body } = adapter.buildGenerateRequest(config, params)
  const createResp = await fetch(url, { method, headers, body: JSON.stringify(body) })
  if (!createResp.ok) {
    const errText = await createResp.text()
    throw new Error(`Unified TTS create error ${createResp.status}: ${errText}`)
  }

  const createResult = await createResp.json()
  if (createResult.base_resp?.status_code !== 0) {
    throw new Error(createResult.base_resp?.status_msg || 'Unified TTS create failed')
  }

  const taskId = createResult.task_id
  const fileId = createResult.file_id
  logTaskProgress('EpisodeTTS', 'unified-tts-created', { episodeId, taskId, fileId })

  const { audioBuffer, titles, extra } = await retrieveAsyncResult(config, taskId, fileId)
  logTaskProgress('EpisodeTTS', 'unified-tts-retrieved', {
    episodeId,
    audioBytes: audioBuffer.length,
    titleCount: Array.isArray(titles) ? titles.length : 0,
    extraAudioLength: extra?.audio_length,
  })

  // 保存整段音频（调试用，也可用于后续直接使用）
  const audioDir = path.join(STORAGE_ROOT, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  const fullAudioFilename = `${uuid()}_episode${episodeId}.mp3`
  const fullAudioPathAbs = path.join(audioDir, fullAudioFilename)
  fs.writeFileSync(fullAudioPathAbs, audioBuffer)
  const fullAudioPath = `static/audio/${fullAudioFilename}`

  // 计算每个分镜的时间范围
  const totalAudioMs = Number(extra?.audio_length) || (titles.length ? titles[titles.length - 1].time_end : 0)
  const timings = computeSegmentTimings(segments, titles, totalAudioMs)

  // 切分音频
  let splitCount = 0
  const fallback = timings.some(t => t.startMs === 0 && t.endMs === 0)
  for (const seg of segments) {
    const timing = timings.find(t => t.id === seg.id)
    if (!timing || timing.endMs <= timing.startMs) {
      db.update(schema.storyboards)
        .set({ narrationAudioUrl: null, updatedAt: now() })
        .where(eq(schema.storyboards.id, seg.id))
        .run()
      continue
    }

    const startSec = timing.startMs / 1000
    const durationSec = (timing.endMs - timing.startMs) / 1000
    const segmentFilename = `${uuid()}.m4a`
    const segmentAbsPath = path.join(audioDir, segmentFilename)

    await splitAndNormalizeAudio(fullAudioPathAbs, startSec, durationSec, segmentAbsPath)

    // 把属于本分镜的 titles 切片并保存，供后续字幕生成直接对轴
    const segmentTitles = extractSegmentTitles(titles, seg.startChar, seg.endChar, timing.startMs)
    if (segmentTitles.length > 0) {
      const titlesPath = path.join(audioDir, `${segmentFilename}.titles.json`)
      fs.writeFileSync(titlesPath, JSON.stringify({
        text: seg.text,
        titles: segmentTitles,
        extra: { audio_length: timing.endMs - timing.startMs },
        createdAt: new Date().toISOString(),
      }, null, 2), 'utf-8')
    }

    db.update(schema.storyboards)
      .set({ narrationAudioUrl: `static/audio/${segmentFilename}`, updatedAt: now() })
      .where(eq(schema.storyboards.id, seg.id))
      .run()

    splitCount++
  }

  logTaskSuccess('EpisodeTTS', 'unified-tts-done', {
    episodeId,
    fullAudioPath,
    segmentCount: splitCount,
    fallback,
  })

  return { fullAudioPath, segmentCount: splitCount, fallback }
}


function computeSegmentTimings(
  segments: Segment[],
  titles: any[],
  totalAudioMs: number,
): SegmentTiming[] {
  if (!Array.isArray(titles) || titles.length === 0) {
    return fallbackProportionalTimings(segments, totalAudioMs)
  }

  const timings = new Map<number, { startMs: number; endMs: number }>()
  for (const seg of segments) {
    timings.set(seg.id, { startMs: Infinity, endMs: 0 })
  }

  for (const t of titles) {
    const textBegin = Number(t.text_begin)
    if (!Number.isFinite(textBegin)) continue

    const seg = segments.find(s => textBegin >= s.startChar && textBegin < s.endChar)
    if (!seg) continue

    const timing = timings.get(seg.id)!
    const timeBegin = Number(t.time_begin)
    const timeEnd = Number(t.time_end)
    if (Number.isFinite(timeBegin)) timing.startMs = Math.min(timing.startMs, timeBegin)
    if (Number.isFinite(timeEnd)) timing.endMs = Math.max(timing.endMs, timeEnd)
  }

  const result: SegmentTiming[] = []
  for (const seg of segments) {
    const timing = timings.get(seg.id)!
    if (Number.isFinite(timing.startMs) && timing.endMs > timing.startMs) {
      result.push({ id: seg.id, startMs: timing.startMs, endMs: timing.endMs })
    } else {
      result.push({ id: seg.id, startMs: 0, endMs: 0 })
    }
  }

  // 如果有分镜没有匹配到字幕，整体回退到按字数比例
  if (result.some(t => t.startMs === 0 && t.endMs === 0)) {
    return fallbackProportionalTimings(segments, totalAudioMs)
  }

  return result
}

function extractSegmentTitles(
  titles: any[],
  segmentStartChar: number,
  segmentEndChar: number,
  segmentStartMs: number,
): any[] {
  return titles
    .filter((t) => {
      const textBegin = Number(t.text_begin)
      const textEnd = Number(t.text_end)
      return Number.isFinite(textBegin) && Number.isFinite(textEnd) &&
        textEnd > segmentStartChar && textBegin < segmentEndChar
    })
    .map((t) => {
      const titleStart = Number(t.text_begin)
      const titleEnd = Number(t.text_end)
      const overlapStart = Math.max(titleStart, segmentStartChar)
      const overlapEnd = Math.min(titleEnd, segmentEndChar)
      const titleText = String(t.text || '')
      const timeStart = Number(t.time_begin)
      const timeEnd = Number(t.time_end)
      const titleLength = Math.max(1, titleEnd - titleStart)
      const titleDuration = Math.max(0, timeEnd - timeStart)
      const overlapTimeStart = timeStart + titleDuration * ((overlapStart - titleStart) / titleLength)
      const overlapTimeEnd = timeStart + titleDuration * ((overlapEnd - titleStart) / titleLength)
      return {
        text: titleText.slice(overlapStart - titleStart, overlapEnd - titleStart),
        text_begin: overlapStart - segmentStartChar,
        text_end: overlapEnd - segmentStartChar,
        time_begin: Math.max(0, overlapTimeStart - segmentStartMs),
        time_end: Math.max(0, overlapTimeEnd - segmentStartMs),
      }
    })
}

function fallbackProportionalTimings(segments: Segment[], totalAudioMs: number): SegmentTiming[] {
  const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0)
  const totalAudioSec = totalAudioMs / 1000
  let currentSec = 0
  const result: SegmentTiming[] = []

  for (const seg of segments) {
    const segDurationSec = totalAudioSec * (seg.text.length / totalChars)
    result.push({
      id: seg.id,
      startMs: currentSec * 1000,
      endMs: (currentSec + segDurationSec) * 1000,
    })
    currentSec += segDurationSec
  }

  return result
}

function splitAndNormalizeAudio(
  inputPath: string,
  startSec: number,
  durationSec: number,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .setDuration(durationSec)
      .audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11')
      .audioCodec('aac')
      .audioBitrate('192k')
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}
