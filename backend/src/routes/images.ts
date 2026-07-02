import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { createImageGenerationRecord } from '../services/image-generation.js'
import { buildStoryboardImagePrompt } from '../services/storyboard-image-prompt.js'
import { buildConsistencySeed, buildConsistencySuffix, buildStoryboardConsistencyInput } from '../services/image-seed.js'
import { aspectRatioToSize } from '../services/adapters/aspect-ratio-to-size.js'
import { createTask } from '../services/tasks/store.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { normalizeStoryboardImagePromptForAspectRatio } from '../services/storyboard-aspect-prompt.js'

function parseReferenceImages(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function collectCharacterReferenceImages(characters: { id: number; imageUrl: string | null; referenceImages: string | null }[]): string[] {
  const images: string[] = []
  for (const char of characters) {
    if (char.imageUrl) images.push(char.imageUrl)
    images.push(...parseReferenceImages(char.referenceImages))
  }
  return images.filter(Boolean)
}

function detectPrimaryCharacter(
  storyboard: { title: string | null; description: string | null; imagePrompt: string | null },
  characters: { id: number; name: string | null }[],
): { id: number; name: string | null } | null {
  if (characters.length === 0) return null
  if (characters.length === 1) return characters[0] ?? null

  const text = `${storyboard.title || ''} ${storyboard.description || ''} ${storyboard.imagePrompt || ''}`
  const scored = characters.map((char) => {
    const name = char.name || ''
    if (!name) return { char, score: 0 }
    // 统计角色名出现次数，并给标题/描述开头位置更高权重
    const regex = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    const matches = text.match(regex)
    const count = matches ? matches.length : 0
    const firstIndex = text.indexOf(name)
    const positionScore = firstIndex >= 0 ? Math.max(0, 100 - firstIndex) : 0
    return { char, score: count * 10 + positionScore }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.char ?? null
}

function collectStoryboardReferenceImages(
  storyboardId: number,
  storyboard?: { title: string | null; description: string | null; imagePrompt: string | null } | null,
): string[] {
  const links = db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
  if (!links.length) return []

  const characterIds = links.map((l) => l.characterId)
  const characters = characterIds.length
    ? db.select().from(schema.characters).where(inArray(schema.characters.id, characterIds)).all()
    : []

  if (!storyboard) {
    return collectCharacterReferenceImages(characters)
  }

  const primary = detectPrimaryCharacter(storyboard, characters.map((c) => ({ id: c.id, name: c.name })))
  if (primary) {
    const primaryChar = characters.find((c) => c.id === primary.id)
    if (primaryChar) {
      return collectCharacterReferenceImages([primaryChar])
    }
  }

  return collectCharacterReferenceImages(characters)
}

function expandRoleTags(prompt: string, characters: { name: string; description: string | null; appearance: string | null; role: string | null }[]): string {
  // 图片 adapter 已统一清理 XML 标签，这里保留角色名展开仅作为兼容兜底
  let expanded = prompt
  for (const char of characters) {
    const escapedName = char.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tag = `<role>${char.name}</role>`
    if (!expanded.includes(tag)) continue
    const replacementParts = [char.name]
    if (char.appearance) replacementParts.push(char.appearance)
    else if (char.description) replacementParts.push(char.description)
    else if (char.role) replacementParts.push(char.role)
    const replacement = replacementParts.join('，')
    expanded = expanded.replace(new RegExp(`<role>${escapedName}</role>`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replacement)
  }
  return expanded
}

function loadStoryboardCharacters(storyboardId: number) {
  const links = db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
  if (!links.length) return []
  const characterIds = links.map((l) => l.characterId)
  return characterIds.length
    ? db.select().from(schema.characters).where(inArray(schema.characters.id, characterIds)).all()
    : []
}

const app = new Hono()
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')

  try {
    let configId: number | undefined = body.config_id
    let seed: number | undefined = typeof body.seed === 'number' ? body.seed : undefined
    let prompt = body.prompt
    let storyboardEpisodeId: number | null = null
    let effectiveAspectRatio: string | null | undefined = body.aspect_ratio
    let referenceImages: string[] = body.reference_images || []

    let dramaStyle: string | undefined
    if (body.drama_id) {
      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, Number(body.drama_id))).all()
      dramaStyle = drama?.style || undefined
    }

    if (body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        storyboardEpisodeId = sb.episodeId
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        effectiveAspectRatio = ep?.aspectRatio || body.aspect_ratio
        const storyboardCharacters = loadStoryboardCharacters(sb.id)

        // 默认用分镜结构化拼装 prompt（含对白表演/动作/角色/上下文承接/视觉风格）；
        // 调用方显式传 use_storyboard_prompt:false 时保留手填 prompt。
        if (body.use_storyboard_prompt !== false) {
          prompt = buildStoryboardImagePrompt(sb.id)
        } else {
          prompt = normalizeStoryboardImagePromptForAspectRatio(
            expandRoleTags(prompt, storyboardCharacters),
            effectiveAspectRatio,
          )
        }

        const characterReferenceImages = collectStoryboardReferenceImages(sb.id, sb)
        if (characterReferenceImages.length) {
          // 后端识别出的主要角色参考图优先，覆盖前端可能带来的多角色/场景参考图
          referenceImages = characterReferenceImages
        }

        const consistency = buildStoryboardConsistencyInput(sb.id)
        if (seed == null) {
          seed = buildConsistencySeed(consistency)
        }
        prompt = `${prompt}${buildConsistencySuffix(consistency)}`

        if (!dramaStyle && ep?.dramaId) {
          const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()
          dramaStyle = drama?.style || undefined
        }
      }
    }

    logTaskStart('ImageAPI', 'generate', {
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
      frameType: body.frame_type,
    })
    logTaskPayload('ImageAPI', 'request body', body)

    const generationId = createImageGenerationRecord({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      prompt,
      size: aspectRatioToSize(effectiveAspectRatio),
      referenceImages,
      frameType: body.frame_type,
      configId,
      seed,
      style: dramaStyle,
    })

    const task = createTask({
      type: 'image.generate',
      dramaId: body.drama_id ? Number(body.drama_id) : null,
      episodeId: storyboardEpisodeId ?? null,
      scopeType: body.storyboard_id ? 'storyboard' : body.character_id ? 'character' : body.scene_id ? 'scene' : null,
      scopeId: body.storyboard_id ? Number(body.storyboard_id) : body.character_id ? Number(body.character_id) : body.scene_id ? Number(body.scene_id) : null,
      priority: body.character_id ? 10 : body.scene_id ? 5 : 0,
      idempotencyKey: `image.generate:${body.storyboard_id ? 'storyboard' : body.character_id ? 'character' : body.scene_id ? 'scene' : 'global'}:${body.storyboard_id || body.character_id || body.scene_id || body.drama_id || 'new'}:${body.frame_type || 'default'}`,
      payload: {
        image_generation_id: generationId,
        config_id: configId,
        frame_type: body.frame_type,
      },
    })

    logTaskSuccess('ImageAPI', 'generate', { generationId, taskId: task.id })
    return created(c, { id: generationId, task_id: task.id, status: 'pending' })
  } catch (err: any) {
    logTaskError('ImageAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /images/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  return success(c, row || null)
})

// GET /images — List by storyboard_id or drama_id
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  let rows = db.select().from(schema.imageGenerations).all()

  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))

  return success(c, rows)
})

// DELETE /images/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).run()
  return success(c)
})

export default app
