import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { createTask } from '../services/tasks/store.js'
import { generateImage } from '../services/image-generation.js'
import { ensureCharacterSeed } from '../services/image-seed.js'
import { applyVisualStyle } from '../services/visual-style.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'role', 'description', 'appearance', 'personality', 'voiceStyle', 'voiceProvider', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  if ('voice_style' in body || 'voiceStyle' in body) {
    updates.voiceSampleUrl = null
  }
  db.update(schema.characters).set(updates).where(eq(schema.characters.id, id)).run()
  return success(c)
})

// DELETE /characters/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.update(schema.characters).set({ deletedAt: now() }).where(eq(schema.characters.id, id)).run()
  return success(c)
})

// POST /characters/:id/generate-voice-sample — 生成角色音色试听
app.post('/:id/generate-voice-sample', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  if (!char.voiceStyle) return badRequest(c, '请先分配音色')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  logTaskStart('VoiceSample', 'generate', { characterId: id, characterName: char.name, episodeId: ep.id, voice: char.voiceStyle })

  const task = createTask({
    type: 'tts.character_sample',
    dramaId: char.dramaId,
    episodeId: ep.id,
    scopeType: 'character',
    scopeId: id,
    idempotencyKey: `tts.character_sample:${id}:${body.episode_id}`,
    payload: {
      character_id: id,
      episode_id: ep.id,
    },
  })

  logTaskSuccess('VoiceSample', 'generate', { characterId: id, taskId: task.id })
  return success(c, { task_id: task.id, status: 'queued' })
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const existing = db.select().from(schema.creationTasks)
    .where(and(
      eq(schema.creationTasks.type, 'image.generate'),
      eq(schema.creationTasks.scopeType, 'character'),
      eq(schema.creationTasks.scopeId, id),
      eq(schema.creationTasks.episodeId, ep.id),
    ))
    .all()
    .find(row => row.status === 'queued' || row.status === 'running')
  if (existing) {
    return success(c, { image_generation_id: existing.id, task_id: existing.id, status: existing.status })
  }

  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, char.dramaId)).all()
  const style = drama?.style || undefined
  const prompt = applyVisualStyle(
    `${char.name}, ${char.appearance || char.description || '人物立绘'}, 高质量, 正面, 白色背景`,
    style,
  )
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId })
    const seed = char.seed ?? ensureCharacterSeed(id)
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, seed, style })
    const task = createTask({
      type: 'image.generate',
      dramaId: char.dramaId,
      episodeId: ep.id,
      scopeType: 'character',
      scopeId: id,
      priority: 10,
      idempotencyKey: `image.generate:character:${id}:episode:${ep.id}`,
      payload: { image_generation_id: genId },
    })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: genId, taskId: task.id })
    return success(c, { image_generation_id: genId, task_id: task.id, status: task.status })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')
  const results: { generation_id: number; task_id: number; character_id: number }[] = []
  for (const cid of ids) {
    const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, cid)).all()
    if (!char) continue

    const existing = db.select().from(schema.creationTasks)
      .where(and(
        eq(schema.creationTasks.type, 'image.generate'),
        eq(schema.creationTasks.scopeType, 'character'),
        eq(schema.creationTasks.scopeId, cid),
        eq(schema.creationTasks.episodeId, ep.id),
      ))
      .all()
      .find(row => row.status === 'queued' || row.status === 'running')
    if (existing) {
      results.push({ generation_id: existing.id, task_id: existing.id, character_id: cid })
      continue
    }

    const [charDrama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, char.dramaId)).all()
    const charStyle = charDrama?.style || undefined
    const prompt = applyVisualStyle(
      `${char.name}, ${char.appearance || char.description || '人物立绘'}, 高质量, 正面, 白色背景`,
      charStyle,
    )
    try {
      const seed = char.seed ?? ensureCharacterSeed(cid)
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, seed, style: charStyle })
      const task = createTask({
        type: 'image.generate',
        dramaId: char.dramaId,
        episodeId: ep.id,
        scopeType: 'character',
        scopeId: cid,
        priority: 10,
        idempotencyKey: `image.generate:character:${cid}:episode:${ep.id}`,
        payload: { image_generation_id: genId },
      })
      results.push({ generation_id: genId, task_id: task.id, character_id: cid })
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, results })
})

export default app
