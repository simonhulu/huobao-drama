import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { createTask } from '../services/tasks/store.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { normalizeStoryboardImagePromptForAspectRatio } from '../services/storyboard-aspect-prompt.js'
import { getEpisodeScriptSource } from '../services/episode-mode.js'


const app = new Hono()

const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

function parseDialogueForTTS(dialogue?: string | null) {
  const raw = dialogue?.trim() || ''
  if (!raw) return { speaker: '', pureText: '', ignorable: true }
  const speakerMatch = raw.match(/^(.+?)[:：]/)
  const speaker = speakerMatch ? speakerMatch[1].replace(/[（(].+?[)）]/g, '').trim() : ''
  const pureText = raw.replace(/^.+?[:：]\s*/, '').replace(/[（(].+?[)）]/g, '').trim()
  const ignorable = (!!speaker && IGNORE_TTS_SPEAKERS.test(speaker)) || !pureText || IGNORE_TTS_TEXT.test(pureText)
  return { speaker, pureText, ignorable }
}

function isIgnorableTTS(text?: string | null): boolean {
  const raw = text?.trim() || ''
  return !raw || IGNORE_TTS_TEXT.test(raw)
}

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()

  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

function getStoryboardCharacterIds(storyboardId: number) {
  return db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
    .map(link => link.characterId)
}

function getEpisodeAspectRatio(episodeId: number) {
  const [episode] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId)).all()
  return episode?.aspectRatio ?? null
}

function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined) {
  const episodeSceneIds = new Set(
    db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
      .map(link => link.sceneId),
  )
  const episodeCharacterIds = new Set(
    db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      .map(link => link.characterId),
  )

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error('scene_id 必须来自当前集已关联场景')
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error('character_ids 必须来自当前集已关联角色')
  }
}

// POST /storyboards
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  logTaskStart('StoryboardAPI', 'create', {
    episodeId: body.episode_id,
    shotNumber: body.storyboard_number || 1,
    sceneId: body.scene_id,
    characterIds: body.character_ids,
  })
  logTaskPayload('StoryboardAPI', 'create body', body)
  validateStoryboardBindings(body.episode_id, body.scene_id, body.character_ids)
  const res = db.insert(schema.storyboards).values({
    episodeId: body.episode_id,
    storyboardNumber: body.storyboard_number || 1,
    title: body.title,
    description: body.description,
    action: body.action,
    dialogue: body.dialogue,
    sceneId: body.scene_id,
    duration: body.duration || 8,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  syncStoryboardCharacters(Number(res.lastInsertRowid), body.character_ids || [])
  const [result] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, Number(res.lastInsertRowid))).all()
  logTaskSuccess('StoryboardAPI', 'create', {
    storyboardId: result.id,
    episodeId: result.episodeId,
    shotNumber: result.storyboardNumber,
  })
  return created(c, {
    ...toSnakeCase(result),
    character_ids: getStoryboardCharacterIds(result.id),
  })
})

// PUT /storyboards/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!storyboard) return badRequest(c, '镜头不存在')
  logTaskStart('StoryboardAPI', 'update', {
    storyboardId: id,
    episodeId: storyboard.episodeId,
    fields: Object.keys(body),
  })
  logTaskPayload('StoryboardAPI', 'update body', body)

  const fieldMap: Record<string, string> = {
    title: 'title', description: 'description', shot_type: 'shotType',
    angle: 'angle', movement: 'movement', action: 'action',
    dialogue: 'dialogue', narration: 'narration', duration: 'duration', video_prompt: 'videoPrompt',
    image_prompt: 'imagePrompt', scene_id: 'sceneId', location: 'location',
    time: 'time', atmosphere: 'atmosphere', result: 'result',
    bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect',
  }

  const updates: Record<string, any> = { updatedAt: now() }
  for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
    if (snakeKey in body) updates[camelKey] = body[snakeKey]
  }

  if ('dialogue' in body) {
    updates.ttsAudioUrl = null
    updates.subtitleUrl = null
  }
  if ('image_prompt' in body) updates.imagePromptFinal = false
  if ('image_prompt' in body) {
    updates.imagePrompt = normalizeStoryboardImagePromptForAspectRatio(
      updates.imagePrompt,
      getEpisodeAspectRatio(storyboard.episodeId),
    )
  }

  validateStoryboardBindings(
    storyboard.episodeId,
    'scene_id' in body ? body.scene_id : storyboard.sceneId,
    'character_ids' in body ? body.character_ids : getStoryboardCharacterIds(id),
  )

  db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id)).run()
  if ('character_ids' in body) syncStoryboardCharacters(id, body.character_ids || [])
  logTaskSuccess('StoryboardAPI', 'update', {
    storyboardId: id,
    updatedFields: Object.keys(updates),
    characterIds: body.character_ids,
  })
  return success(c)
})

// POST /storyboards/:id/generate-tts
app.post('/:id/generate-tts', async (c) => {
  const id = Number(c.req.param('id'))
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!sb) return badRequest(c, '镜头不存在')
  const parsedDialogue = parseDialogueForTTS(sb.dialogue)
  const hasDialogueAudio = !parsedDialogue.ignorable
  const hasNarrationAudio = !!sb.narration?.trim() && !isIgnorableTTS(sb.narration)
  if (!hasDialogueAudio && !hasNarrationAudio) return badRequest(c, '该镜头没有可生成的对白或旁白')
  logTaskStart('StoryboardAPI', 'generate-tts', {
    storyboardId: id,
    episodeId: sb.episodeId,
    dialoguePreview: (sb.dialogue || '').slice(0, 40),
    narrationPreview: (sb.narration || '').slice(0, 40),
  })
  logTaskPayload('StoryboardAPI', 'generate-tts input', {
    storyboardId: id,
    episodeId: sb.episodeId,
    dialogue: sb.dialogue,
    narration: sb.narration,
  })

  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()

  const task = createTask({
    type: 'tts.storyboard',
    dramaId: episode?.dramaId ?? null,
    episodeId: sb.episodeId,
    scopeType: 'storyboard',
    scopeId: id,
    idempotencyKey: `tts.storyboard:${id}`,
    payload: {
      storyboard_id: id,
      episode_id: sb.episodeId,
    },
  })

  logTaskSuccess('StoryboardAPI', 'generate-tts', { storyboardId: id, taskId: task.id })
  return success(c, { task_id: task.id, status: 'queued' })
})

// DELETE /storyboards/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  logTaskStart('StoryboardAPI', 'delete', { storyboardId: id })
  db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id)).run()
  db.delete(schema.storyboards).where(eq(schema.storyboards.id, id)).run()
  logTaskSuccess('StoryboardAPI', 'delete', { storyboardId: id })
  return success(c)
})

const DEFAULT_OVERLOAD_THRESHOLD = 60

function shotTextLength(sb: typeof schema.storyboards.$inferSelect): number {
  return (sb.narration || '').length + (sb.dialogue || '').length
}

function buildStoryBearingFields(sb: typeof schema.storyboards.$inferSelect): string[] {
  return [
    sb.narration,
    sb.dialogue,
    sb.action,
    sb.description,
    sb.result,
    sb.atmosphere,
  ]
    .map(value => (value || '').trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
}

function buildStoryBearingSource(sb: typeof schema.storyboards.$inferSelect): string {
  const source = buildStoryBearingFields(sb).join('。')
  return source || (sb.imagePrompt || '').trim()
}

function storyLoadLength(sb: typeof schema.storyboards.$inferSelect): number {
  return buildStoryBearingFields(sb).join('').length
}

function resolveOverloadThreshold(_episodeId: number, threshold: number): number {
  return threshold
}

export function detectOverloadShots(episodeId: number, threshold = DEFAULT_OVERLOAD_THRESHOLD) {
  const effectiveThreshold = resolveOverloadThreshold(episodeId, threshold)
  const isDirectScript = getEpisodeScriptSource(episodeId) === 'direct_script'
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()

  const overloaded = rows
    .map((sb) => ({
      id: sb.id,
      storyboard_number: sb.storyboardNumber,
      length: isDirectScript ? storyLoadLength(sb) : shotTextLength(sb),
      threshold: effectiveThreshold,
    }))
    .filter((item) => item.length > item.threshold)

  return {
    count: overloaded.length,
    threshold: effectiveThreshold,
    shots: overloaded,
  }
}

app.get('/overloads', async (c) => {
  const episodeId = Number(c.req.query('episode_id'))
  if (!episodeId) return badRequest(c, 'episode_id is required')
  const threshold = Number(c.req.query('threshold') || DEFAULT_OVERLOAD_THRESHOLD)
  return success(c, detectOverloadShots(episodeId, threshold))
})

function splitIntoVisualClauses(text: string): string[] {
  const trimmed = (text || '').trim()
  if (!trimmed) return []

  // Keep delimiters attached to the preceding phrase. Chinese narration often
  // packs several visual beats into one sentence separated by commas.
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
    .map((s) => s.trim())
    .filter(Boolean)
}

function splitTextIntoChunks(text: string, parts: number): string[] {
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

function buildSplitImagePrompt(
  sb: typeof schema.storyboards.$inferSelect,
  beat: string,
  aspectRatio?: string | null,
): string {
  const base = [
    beat || sb.action || sb.description || sb.imagePrompt || sb.title || '',
    sb.location ? `地点：${sb.location}` : '',
    sb.time ? `时间：${sb.time}` : '',
    sb.atmosphere ? `氛围：${sb.atmosphere}` : '',
    '单帧静态画面，只表现当前视觉节拍',
  ].filter(Boolean).join('，')

  return normalizeStoryboardImagePromptForAspectRatio(base, aspectRatio)
}

interface SplitPlanShot {
  id: number
  storyboard_number: number
  split_into: number
  proposed: Array<{
    title: string
    description: string
    narration: string
    dialogue: string
    duration: number
    action: string
    result: string
    atmosphere: string
    image_prompt: string
  }>
}

export function buildAutoSplitPlan(
  episodeId: number,
  threshold = DEFAULT_OVERLOAD_THRESHOLD,
  onlyShotIds?: number[],
): { threshold: number; shots: SplitPlanShot[] } {
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
  const aspectRatio = getEpisodeAspectRatio(episodeId)
  const effectiveThreshold = resolveOverloadThreshold(episodeId, threshold)
  const isDirectScript = getEpisodeScriptSource(episodeId) === 'direct_script'

  const plan: SplitPlanShot[] = []

  for (const sb of rows) {
    if (onlyShotIds?.length && !onlyShotIds.includes(sb.id)) continue
    const textLen = isDirectScript ? storyLoadLength(sb) : shotTextLength(sb)
    const storySource = buildStoryBearingSource(sb)
    const storyLoad = storyLoadLength(sb)
    const visualSource = storySource || sb.imagePrompt || ''
    const visualClauses = splitIntoVisualClauses(visualSource)
    const semanticOverload = visualClauses.length >= 3 && storyLoad > Math.floor(effectiveThreshold * 0.75)
    if (textLen <= effectiveThreshold && !semanticOverload) continue

    const parts = Math.max(
      2,
      Math.min(4, Math.ceil(Math.max(textLen, storyLoad, semanticOverload ? effectiveThreshold + 1 : textLen) / effectiveThreshold)),
    )
    const narrationChunks = splitTextIntoChunks(sb.narration || '', parts)
    const dialogueChunks = splitTextIntoChunks(sb.dialogue || '', parts)
    const actionChunks = splitTextIntoChunks(sb.action || '', parts)
    const descriptionChunks = splitTextIntoChunks(sb.description || '', parts)
    const resultChunks = splitTextIntoChunks(sb.result || '', parts)
    const atmosphereChunks = splitTextIntoChunks(sb.atmosphere || '', parts)
    const visualChunks = splitTextIntoChunks(visualSource, parts)
    const baseDuration = Math.max(3, Math.floor((sb.duration || 8) / parts))

    const proposed = Array.from({ length: parts }, (_, i) => {
      const suffix = parts > 2 ? ` (${i + 1}/${parts})` : ''
      const beat = (
        visualChunks[i]
        || descriptionChunks[i]
        || actionChunks[i]
        || resultChunks[i]
        || narrationChunks[i]
        || dialogueChunks[i]
        || sb.description
        || sb.title
        || ''
      ).trim()
      const title = compactTitle(beat, `${sb.title || `镜头${sb.storyboardNumber}`}${suffix}`)
      return {
        title,
        description: descriptionChunks[i] || beat || sb.description || '',
        action: actionChunks[i] || beat || sb.action || '',
        result: resultChunks[i] || '',
        atmosphere: atmosphereChunks[i] || '',
        image_prompt: buildSplitImagePrompt(sb, beat, aspectRatio),
        narration: narrationChunks[i] || '',
        dialogue: dialogueChunks[i] || '',
        duration: baseDuration,
      }
    })

    plan.push({
      id: sb.id,
      storyboard_number: sb.storyboardNumber,
      split_into: parts,
      proposed,
    })
  }

  return { threshold: effectiveThreshold, shots: plan }
}

function executeAutoSplitPlan(
  episodeId: number,
  plan: SplitPlanShot[],
): { created: number[]; deleted: number[] } {
  const created: number[] = []
  const deleted: number[] = []
  const ts = now()

  for (const item of plan) {
    const [original] = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.id, item.id)).all()
    if (!original) continue

    const characterIds = getStoryboardCharacterIds(original.id)

    // Insert new shots with temporary high numbers to avoid collisions.
    const tempBase = original.id * 1_000_000
    for (let i = 0; i < item.proposed.length; i++) {
      const p = item.proposed[i]
      const res = db.insert(schema.storyboards).values({
        episodeId,
        storyboardNumber: tempBase + i,
        title: p.title,
        description: p.description,
        action: p.action || original.action,
        result: p.result || original.result,
        dialogue: p.dialogue,
        narration: p.narration,
        sceneId: original.sceneId,
        duration: p.duration,
        shotType: original.shotType,
        angle: original.angle,
        movement: original.movement,
        location: original.location,
        time: original.time,
        atmosphere: p.atmosphere || original.atmosphere,
        imagePrompt: p.image_prompt || original.imagePrompt,
        videoPrompt: original.videoPrompt,
        bgmPrompt: original.bgmPrompt,
        soundEffect: original.soundEffect,
        createdAt: ts,
        updatedAt: ts,
      }).run()

      const newId = Number(res.lastInsertRowid)
      syncStoryboardCharacters(newId, characterIds)
      created.push(newId)
    }

    db.delete(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, original.id))
      .run()
    db.delete(schema.storyboards)
      .where(eq(schema.storyboards.id, original.id))
      .run()
    deleted.push(original.id)
  }

  const remaining = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  for (let i = 0; i < remaining.length; i++) {
    db.update(schema.storyboards)
      .set({ storyboardNumber: i + 1, updatedAt: ts })
      .where(eq(schema.storyboards.id, remaining[i].id))
      .run()
  }

  return { created, deleted }
}

// POST /storyboards/auto-split
// Body: { episode_id, threshold?, shot_ids?, preview? }
// When preview=true returns the split plan without mutating the DB.
app.post('/auto-split', async (c) => {
  const body = await c.req.json()
  const episodeId = Number(body.episode_id)
  if (!episodeId) return badRequest(c, 'episode_id is required')

  const threshold = Number(body.threshold || DEFAULT_OVERLOAD_THRESHOLD)
  const onlyShotIds = Array.isArray(body.shot_ids)
    ? body.shot_ids.map(Number).filter(Boolean)
    : undefined
  const preview = body.preview === true

  logTaskStart('StoryboardAPI', 'auto-split', { episodeId, threshold, preview, shotCount: onlyShotIds?.length })

  const plan = buildAutoSplitPlan(episodeId, threshold, onlyShotIds)
  if (plan.shots.length === 0) {
    return success(c, { preview, threshold, shots: [], message: '没有检测到超载镜头' })
  }

  if (preview) {
    logTaskSuccess('StoryboardAPI', 'auto-split-preview', { episodeId, shotCount: plan.shots.length })
    return success(c, { preview: true, threshold, shots: plan.shots })
  }

  try {
    const result = executeAutoSplitPlan(episodeId, plan.shots)
    logTaskSuccess('StoryboardAPI', 'auto-split-execute', {
      episodeId,
      createdCount: result.created.length,
      deletedCount: result.deleted.length,
    })
    return success(c, {
      preview: false,
      threshold,
      created_shot_ids: result.created,
      deleted_shot_ids: result.deleted,
      shots: plan.shots,
    })
  } catch (err: any) {
    logTaskError('StoryboardAPI', 'auto-split-execute', { episodeId, error: err.message })
    return badRequest(c, err.message)
  }
})

export default app
