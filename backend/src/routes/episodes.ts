import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, notFound, badRequest, now } from '../utils/response.js'
import { toSnakeCaseArray, toSnakeCase } from '../utils/transform.js'
import { createTask, addTaskDependency } from '../services/tasks/store.js'
import { scheduleAutoStartForEpisode, resetEpisodeStoryboards, scheduleBreakdownAndNarrationForEpisode, scheduleDirectScriptPipeline } from '../services/tasks/auto-pipeline.js'
import { allowsNarratorAgent, getEpisodeVisualStyle, usesOriginalTextForNarration } from '../services/episode-mode.js'
import { resolveStoryboardNarrationTextForTTS, restoreOriginalTextNarrations } from '../services/narration-generation.js'
import { logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { parseDialogueForTTS, isIgnorableTTS, toAbsPath, resolveNarratorVoice } from '../services/ffmpeg-compose.js'
import crypto from 'node:crypto'
import fs from 'node:fs'

const app = new Hono()

function isTruthy(value: unknown) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

// POST /episodes — Create a new episode
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id required')
  const auto = isTruthy(c.req.query('auto')) || isTruthy(body.auto) || isTruthy(body.auto_mode)
  if (auto && !body.content) {
    return badRequest(c, 'auto=true 时必须传入 content（原始故事）')
  }
  const ts = now()

  // Get next episode number
  const existing = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, body.drama_id))
    .orderBy(schema.episodes.episodeNumber).all()
  const nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  const res = db.insert(schema.episodes).values({
    dramaId: body.drama_id,
    episodeNumber: nextNum,
    title: body.title || `第${nextNum}集`,
    content: body.content ?? null,
    description: body.description ?? null,
    imageConfigId: body.image_config_id ?? null,
    videoConfigId: body.video_config_id ?? null,
    audioConfigId: body.audio_config_id ?? null,
    aspectRatio: body.aspect_ratio ?? null,
    renderMode: body.render_mode ?? 'image_story',
    autoMode: auto,
    enableAiRewrite: isTruthy(body.enable_ai_rewrite) || body.enable_ai_rewrite === undefined,
    narrationVoiceId: body.narration_voice_id ?? 'DaniangzhuVoice01',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, Number(res.lastInsertRowid))).all()
  let initialTaskId: number | null = null
  let autoStarted = false
  if (auto) {
    const task = scheduleAutoStartForEpisode(Number(body.drama_id), ep.id, body.content)
    initialTaskId = task.id
    autoStarted = true
  }

  return success(c, {
    id: ep.id,
    drama_id: ep.dramaId,
    episode_number: ep.episodeNumber,
    title: ep.title,
    image_config_id: ep.imageConfigId,
    video_config_id: ep.videoConfigId,
    audio_config_id: ep.audioConfigId,
    aspect_ratio: ep.aspectRatio,
    render_mode: ep.renderMode,
    auto_started: autoStarted,
    initial_task_id: initialTaskId,
  })
})

// PUT /episodes/:id - Update episode fields
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()

  const allowed = ['content', 'script_content', 'title', 'description', 'status', 'render_mode', 'auto_mode', 'enable_ai_rewrite', 'narration_voice_id', 'narration_speed', 'pacing_mode', 'dialogue_mode', 'narration_mode', 'subtitle_enabled', 'subtitle_font', 'subtitle_color', 'subtitle_size', 'subtitle_position', 'subtitle_margin', 'subtitle_margin_v', 'subtitle_background_color', 'subtitle_stroke_color', 'subtitle_stroke_width']
  const updates: Record<string, any> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }
  if (Object.keys(updates).length === 0) return badRequest(c, 'no valid fields')

  // Map snake_case to camelCase for drizzle
  const drizzleUpdates: Record<string, any> = { updatedAt: now() }
  if ('content' in updates) drizzleUpdates.content = updates.content
  if ('script_content' in updates) drizzleUpdates.scriptContent = updates.script_content
  if ('title' in updates) drizzleUpdates.title = updates.title
  if ('description' in updates) drizzleUpdates.description = updates.description
  if ('status' in updates) drizzleUpdates.status = updates.status
  if ('render_mode' in updates) drizzleUpdates.renderMode = updates.render_mode
  if ('auto_mode' in updates) drizzleUpdates.autoMode = updates.auto_mode
  if ('enable_ai_rewrite' in updates) drizzleUpdates.enableAiRewrite = isTruthy(updates.enable_ai_rewrite)
  if ('narration_voice_id' in updates) drizzleUpdates.narrationVoiceId = updates.narration_voice_id || null
  if ('narration_speed' in updates) {
    const speed = Number(updates.narration_speed)
    drizzleUpdates.narrationSpeed = Number.isFinite(speed) && speed >= 0.8 && speed <= 2.5 ? speed : 1.0
  }
  if ('pacing_mode' in updates) drizzleUpdates.pacingMode = updates.pacing_mode || 'tight'
  if ('dialogue_mode' in updates) drizzleUpdates.dialogueMode = updates.dialogue_mode || 'narration_only'
  if ('narration_mode' in updates) drizzleUpdates.narrationMode = updates.narration_mode || 'rewrite'
  if ('subtitle_enabled' in updates) drizzleUpdates.subtitleEnabled = isTruthy(updates.subtitle_enabled)
  if ('subtitle_font' in updates) drizzleUpdates.subtitleFont = updates.subtitle_font || 'PingFang SC'
  if ('subtitle_color' in updates) drizzleUpdates.subtitleColor = updates.subtitle_color || '#FFFFFF'
  if ('subtitle_size' in updates) drizzleUpdates.subtitleSize = Number(updates.subtitle_size) || 48
  if ('subtitle_position' in updates) drizzleUpdates.subtitlePosition = updates.subtitle_position || 'bottom'
  if ('subtitle_margin' in updates) drizzleUpdates.subtitleMargin = Number(updates.subtitle_margin) || 60
  if ('subtitle_margin_v' in updates) drizzleUpdates.subtitleMarginV = Number(updates.subtitle_margin_v) || 40
  if ('subtitle_background_color' in updates) drizzleUpdates.subtitleBackgroundColor = updates.subtitle_background_color || null
  if ('subtitle_stroke_color' in updates) drizzleUpdates.subtitleStrokeColor = updates.subtitle_stroke_color || '#000000'
  if ('subtitle_stroke_width' in updates) drizzleUpdates.subtitleStrokeWidth = Number(updates.subtitle_stroke_width) || 2

  const [epBefore] = db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).all()
  await db.update(schema.episodes).set(drizzleUpdates).where(eq(schema.episodes.id, id))

  // Changing narration mode invalidates generated audio/composed videos and may restore verbatim text.
  if ('narration_mode' in updates && epBefore) {
    const newMode = updates.narration_mode
    if (newMode === 'verbatim') {
      try {
        restoreOriginalTextNarrations(id)
      } catch (err) {
        console.error('[PUT /episodes/:id] restoreOriginalTextNarrations failed', err)
      }
    } else if (epBefore.narrationMode === 'verbatim' && newMode === 'rewrite') {
      // 切回改写模式时清空旧原文旁白，下次 narrator agent 重新生成
      await db.update(schema.storyboards)
        .set({ narration: null, updatedAt: now() })
        .where(eq(schema.storyboards.episodeId, id))
    }
    await db.update(schema.storyboards)
      .set({ narrationAudioUrl: null, composedVideoUrl: null })
      .where(eq(schema.storyboards.episodeId, id))
  }

  // Changing the narration voice or speed invalidates previously generated narration audio and composed videos.
  if ('narration_voice_id' in updates || 'narration_speed' in updates) {
    await db.update(schema.storyboards)
      .set({ narrationAudioUrl: null, composedVideoUrl: null })
      .where(eq(schema.storyboards.episodeId, id))
  }

  // Changing subtitle settings invalidates previously composed videos so the new style is applied on next compose.
  const subtitleFields = ['subtitle_enabled', 'subtitle_font', 'subtitle_color', 'subtitle_size', 'subtitle_position', 'subtitle_margin', 'subtitle_margin_v', 'subtitle_background_color', 'subtitle_stroke_color', 'subtitle_stroke_width']
  if (subtitleFields.some(f => f in updates)) {
    await db.update(schema.storyboards)
      .set({ composedVideoUrl: null })
      .where(eq(schema.storyboards.episodeId, id))
  }

  // Changing pacing/dialogue resets storyboards. direct_script reruns only its literal breaker;
  // story_rewrite may continue breaker -> splitter -> narrator depending on narration_mode.
  let pacingTask: { breaker: { id: number }; splitter?: { id: number } | null; narrator?: { id: number } | null } | null = null
  if ('pacing_mode' in updates || 'dialogue_mode' in updates) {
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).all()
    if (ep) {
      resetEpisodeStoryboards(id)
      pacingTask = ep.workflowType === 'direct_script'
        ? scheduleDirectScriptPipeline(ep.dramaId, id)
        : scheduleBreakdownAndNarrationForEpisode(ep.dramaId, id)
    }
  }

  let initialTaskId: number | null = null
  let autoStarted = false
  if (isTruthy(updates.auto_mode)) {
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).all()
    if (!ep) return notFound(c, 'Episode not found')
    if (!ep.content) return badRequest(c, 'auto_mode=true 时必须先保存 content（原始故事）')
    const task = scheduleAutoStartForEpisode(ep.dramaId, ep.id, ep.content)
    initialTaskId = task.id
    autoStarted = task.status === 'queued' || task.status === 'running'
  }

  return success(c, {
    auto_started: autoStarted,
    initial_task_id: initialTaskId,
    pacing_regenerated: !!pacingTask,
    pacing_task_ids: pacingTask
      ? { breaker: pacingTask.breaker.id, splitter: pacingTask.splitter?.id ?? null, narrator: pacingTask.narrator?.id ?? null }
      : null,
  })
})

// GET /episodes/:id/characters — characters linked to this episode
app.get('/:id/characters', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const links = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
  const charIds = links.map(l => l.characterId)
  if (!charIds.length) return success(c, [])
  const allChars = db.select().from(schema.characters).all()
  const result = allChars.filter(ch => charIds.includes(ch.id) && !ch.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:id/scenes — scenes linked to this episode
app.get('/:id/scenes', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const links = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
  const sceneIds = links.map(l => l.sceneId)
  if (!sceneIds.length) return success(c, [])
  const allScenes = db.select().from(schema.scenes).all()
  const result = allScenes.filter(sc => sceneIds.includes(sc.id) && !sc.deletedAt)
  return success(c, toSnakeCaseArray(result))
})

// GET /episodes/:episode_id/storyboards
app.get('/:episode_id/storyboards', async (c) => {
  const episodeId = Number(c.req.param('episode_id'))
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
  const links = db.select().from(schema.storyboardCharacters).all()
  const charIdsByStoryboard = new Map<number, number[]>()
  for (const link of links) {
    const arr = charIdsByStoryboard.get(link.storyboardId) || []
    arr.push(link.characterId)
    charIdsByStoryboard.set(link.storyboardId, arr)
  }

  const episodeCharIds = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
    .map(link => link.characterId)
  const allChars = db.select().from(schema.characters).all()
    .filter(ch => episodeCharIds.includes(ch.id) && !ch.deletedAt)

  return success(c, rows.map((row) => ({
    ...toSnakeCase(row),
    character_ids: charIdsByStoryboard.get(row.id) || [],
    characters: allChars
      .filter(ch => (charIdsByStoryboard.get(row.id) || []).includes(ch.id))
      .map(ch => toSnakeCase(ch)),
  })))
})

// GET /episodes/:id/pipeline-status — 流水线进度
app.get('/:id/pipeline-status', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  const chars = db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
  const scenes = db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, ep.dramaId)).all()
  const sbs = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
  const merges = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .orderBy(desc(schema.videoMerges.id))
    .all()

  const visualStyle = getEpisodeVisualStyle(episodeId)
  const charsWithVoice = chars.filter(c => c.voiceStyle)
  const charsWithSample = chars.filter(c => c.voiceSampleUrl)
  // image_story uses firstFrameImage; ai_video uses composedImage (reference for video gen)
  const sbsWithImage = visualStyle === 'ai_video'
    ? sbs.filter(s => s.composedImage)
    : sbs.filter(s => s.firstFrameImage)
  const sbsWithVideo = sbs.filter(s => s.videoUrl)
  const sbsComposed = sbs.filter(s => s.composedVideoUrl)
  const latestMerge = merges.find(m => m.status === 'completed') ?? merges[0]

  function stepStatus(done: boolean, partial?: boolean) {
    if (done) return 'done'
    if (partial) return 'partial'
    return 'pending'
  }

  // image_story doesn't have a separate video generation step
  const stepOrder = visualStyle === 'ai_video'
    ? ['script_rewrite', 'extract_characters', 'extract_scenes', 'assign_voices', 'generate_voice_samples', 'extract_storyboards', 'generate_images', 'generate_videos', 'compose_shots', 'merge_episode'] as const
    : ['script_rewrite', 'extract_characters', 'extract_scenes', 'assign_voices', 'generate_voice_samples', 'extract_storyboards', 'generate_images', 'compose_shots', 'merge_episode'] as const

  const steps: Record<string, unknown> = {
    script_rewrite: { status: ep.scriptContent ? 'done' : (ep.content ? 'ready' : 'pending') },
    extract_characters: { status: stepStatus(chars.length > 0), count: chars.length },
    extract_scenes: { status: stepStatus(scenes.length > 0), count: scenes.length },
    assign_voices: { status: stepStatus(charsWithVoice.length === chars.length && chars.length > 0, charsWithVoice.length > 0), assigned: charsWithVoice.length, total: chars.length },
    generate_voice_samples: { status: stepStatus(charsWithSample.length === charsWithVoice.length && charsWithVoice.length > 0, charsWithSample.length > 0), completed: charsWithSample.length, total: charsWithVoice.length },
    extract_storyboards: { status: stepStatus(sbs.length > 0), count: sbs.length },
    generate_images: { status: stepStatus(sbsWithImage.length === sbs.length && sbs.length > 0, sbsWithImage.length > 0), completed: sbsWithImage.length, total: sbs.length },
    ...(visualStyle === 'ai_video' ? { generate_videos: { status: stepStatus(sbsWithVideo.length === sbs.length && sbs.length > 0, sbsWithVideo.length > 0), completed: sbsWithVideo.length, total: sbs.length } } : {}),
    compose_shots: { status: stepStatus(sbsComposed.length === sbs.length && sbs.length > 0, sbsComposed.length > 0), completed: sbsComposed.length, total: sbs.length },
    merge_episode: { status: latestMerge?.status === 'completed' ? 'done' : (latestMerge ? latestMerge.status : 'pending'), merged_url: latestMerge?.mergedUrl },
  }

  // 计算当前进度：找第一个非 done 步骤；如果全部 done 则 current_step = total_steps
  let currentStep = 0
  for (const key of stepOrder) {
    const status = (steps[key] as { status: string }).status
    if (status === 'done') {
      currentStep++
    } else {
      break
    }
  }

  const totalSteps = stepOrder.length

  return success(c, {
    episode_id: episodeId,
    progress: {
      current_step: currentStep,
      total_steps: totalSteps,
      percentage: Math.round((currentStep / totalSteps) * 100),
      is_completed: currentStep === totalSteps,
    },
    steps,
  })
})

// POST /episodes/:id/generate-tts-all — 批量生成当前集所有可配音镜头的语音
app.post('/:id/generate-tts-all', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const force = body?.force === true

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()

  const dialogueMode = ep.dialogueMode || 'narration_only'
  const targets = sbs.filter((sb) => {
    const parsed = parseDialogueForTTS(sb.dialogue)
    const needsDialogue = dialogueMode !== 'narration_only' && !parsed.ignorable && (force || !sb.ttsAudioUrl)
    const needsNarration = !isIgnorableTTS(sb.narration) && (force || !sb.narrationAudioUrl)
    return needsDialogue || needsNarration
  })

  if (!targets.length) {
    return badRequest(c, force ? '当前没有可重新生成的对白或旁白' : '当前没有待生成的对白或旁白')
  }

  logTaskStart('EpisodeAPI', 'generate-tts-all', { episodeId, count: targets.length, force })

  const childTasks = targets.map((sb) =>
    createTask({
      type: 'tts.storyboard',
      dramaId: ep.dramaId,
      episodeId,
      scopeType: 'storyboard',
      scopeId: sb.id,
      idempotencyKey: `tts.storyboard:${sb.id}`,
      payload: {
        storyboard_id: sb.id,
        episode_id: episodeId,
      },
    })
  )

  const parentTask = createTask({
    type: 'tts.episode',
    dramaId: ep.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `tts.episode:${episodeId}:${force ? 'force' : 'normal'}`,
    payload: {
      episode_id: episodeId,
      force,
    },
  })

  for (const child of childTasks) {
    addTaskDependency(parentTask.id, child.id)
  }

  logTaskSuccess('EpisodeAPI', 'generate-tts-all', {
    episodeId,
    count: targets.length,
    parentTaskId: parentTask.id,
    childTaskIds: childTasks.map(t => t.id),
  })

  return success(c, {
    task_id: parentTask.id,
    total: targets.length,
    child_task_ids: childTasks.map(t => t.id),
    status: 'queued',
  })
})

// POST /episodes/:id/generate-narrations — 为图文叙事集生成/重新生成旁白
app.post('/:id/generate-narrations', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()
  if (!sbs.length) return badRequest(c, 'No storyboards yet')

  // direct_script/verbatim: storyboards.narration 是逐镜头 TTS 原文切片，不是 AI 旁白文案。
  if (usesOriginalTextForNarration(ep)) {
    try {
      const result = restoreOriginalTextNarrations(episodeId)
      return success(c, { restored: result.updated, mode: 'original_text' })
    } catch (err: any) {
      return badRequest(c, err?.message || 'Failed to restore original-text narrations')
    }
  }

  if (!allowsNarratorAgent(ep)) return badRequest(c, '当前剧集模式不允许生成 AI 解说文案')

  const task = createTask({
    type: 'agent.run',
    dramaId: ep.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `narrator:${ep.dramaId}:${episodeId}:generate`,
    payload: {
      agent_type: 'narrator',
      message: '请读取 original_story 原文（已按集优化），用电影解说视角把原文拆成逐镜头旁白。每镜头 1-3 句，先让观众听懂人物关系和情节，再带情绪；不要假设观众看过前文；不写内心独白；有原声对白的镜头要铺垫对白分量，不要复述台词。保存到每个镜头的 narration 字段。',
      drama_id: ep.dramaId,
      episode_id: episodeId,
    },
  })

  return success(c, { task_id: task.id, status: task.status })
})

// POST /episodes/:id/generate-narration-audio — 批量生成/重新生成当前集所有解说旁白音频
app.post('/:id/generate-narration-audio', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const force = body?.force === true

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()

  const speed = ep.narrationSpeed ?? 1.0

  function narrationTTSHash(sb: typeof sbs[number]): string {
    const { voiceId, audioConfigId } = resolveNarratorVoice(episodeId)
    const raw = [
      resolveStoryboardNarrationTextForTTS(sb, ep),
      voiceId,
      audioConfigId ?? '',
      speed,
      'word',
    ].join('\n')
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)
  }

  function findExistingValidAudio(sb: typeof sbs[number], hash: string): string | null {
    const key = `tts.storyboard:narration:${sb.id}:${hash}`
    const existing = db.select().from(schema.creationTasks)
      .where(and(
        eq(schema.creationTasks.idempotencyKey, key),
        eq(schema.creationTasks.status, 'succeeded'),
      ))
      .orderBy(desc(schema.creationTasks.id))
      .all()[0]
    if (!existing?.resultJson) return null
    try {
      const result = JSON.parse(existing.resultJson)
      const url = result?.narration_audio_url || result?.audioUrl
      if (url && fs.existsSync(toAbsPath(url))) return url
    } catch {}
    return null
  }

  let currentSbs = sbs
  if (usesOriginalTextForNarration(ep)) {
    const needsRestore = force || currentSbs.some(sb => !resolveStoryboardNarrationTextForTTS(sb, ep).trim())
    if (needsRestore) {
      try {
        restoreOriginalTextNarrations(episodeId)
        currentSbs = db.select().from(schema.storyboards)
          .where(eq(schema.storyboards.episodeId, episodeId)).all()
      } catch (err: any) {
        return badRequest(c, err?.message || '回填原文 TTS 文本失败')
      }
    }
  }

  let targets = currentSbs
    .map((sb) => {
      const narrationText = resolveStoryboardNarrationTextForTTS(sb, ep)
      if (isIgnorableTTS(narrationText)) return null
      if (!force && sb.narrationAudioUrl) return null
      const hash = narrationTTSHash(sb)
      // force=true 时覆盖旧音频，不再检查历史有效文件
      if (!force) {
        const existingUrl = findExistingValidAudio(sb, hash)
        if (existingUrl) return null
      }
      return { sb, hash }
    })
    .filter(Boolean) as { sb: typeof sbs[number]; hash: string }[]

  // narration 字段为空时，根据契约处理：原文模式只回填原文；rewrite 模式才创建 narrator。
  if (!targets.length) {
    const hasStoryboards = currentSbs.length > 0
    const hasAnyNarration = currentSbs.some(sb => !isIgnorableTTS(resolveStoryboardNarrationTextForTTS(sb, ep)))

    if (hasStoryboards && !hasAnyNarration) {
      if (usesOriginalTextForNarration(ep)) {
        try {
          const restored = restoreOriginalTextNarrations(episodeId)
          return success(c, {
            narration_filled: true,
            mode: 'original_text',
            restored: restored.updated,
            message: '已按原文回填 TTS 文本，但没有可生成的解说音频',
          })
        } catch (err: any) {
          return badRequest(c, err?.message || '回填原文 TTS 文本失败')
        }
      }

      // 只有 story_rewrite + rewrite 模式：调度 narrator agent 生成旁白
      const narratorTask = createTask({
        type: 'agent.run',
        dramaId: ep.dramaId,
        episodeId,
        scopeType: 'episode',
        scopeId: episodeId,
        idempotencyKey: `narrator:${ep.dramaId}:${episodeId}:generate:audio-fallback`,
        payload: {
          agent_type: 'narrator',
          message: '请为当前集所有分镜生成解说旁白，并保存到每个镜头的 narration 字段。',
          drama_id: ep.dramaId,
          episode_id: episodeId,
        },
      })
      return success(c, {
        narration_task_id: narratorTask.id,
        message: '已创建解说文案生成任务，请在旁白文案生成后再点击生成音频',
      })
    }

    return badRequest(c, force ? '当前没有可重新生成的解说旁白' : '当前没有待生成的解说旁白')
  }

  logTaskStart('EpisodeAPI', 'generate-narration-audio', { episodeId, count: targets.length, force })

  const childTasks = targets.map(({ sb, hash }) =>
    createTask({
      type: 'tts.storyboard',
      dramaId: ep.dramaId,
      episodeId,
      scopeType: 'storyboard',
      scopeId: sb.id,
      idempotencyKey: `tts.storyboard:narration:${sb.id}:${hash}`,
      payload: {
        storyboard_id: sb.id,
        episode_id: episodeId,
      },
    })
  )

  const parentTask = createTask({
    type: 'tts.episode',
    dramaId: ep.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `tts.episode:narration:${episodeId}:${force ? 'force' : 'normal'}`,
    payload: {
      episode_id: episodeId,
      force,
    },
  })

  for (const child of childTasks) {
    addTaskDependency(parentTask.id, child.id)
  }

  logTaskSuccess('EpisodeAPI', 'generate-narration-audio', {
    episodeId,
    count: targets.length,
    parentTaskId: parentTask.id,
    childTaskIds: childTasks.map(t => t.id),
  })

  return success(c, {
    task_id: parentTask.id,
    total: targets.length,
    child_task_ids: childTasks.map(t => t.id),
    status: 'queued',
  })
})

// POST /episodes/:id/generate-unified-narration-audio — 整集统一 TTS 合成旁白
app.post('/:id/generate-unified-narration-audio', async (c) => {
  const episodeId = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  const task = createTask({
    type: 'tts.episode_unified',
    dramaId: ep.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `tts.episode_unified:${episodeId}`,
    payload: {
      episode_id: episodeId,
    },
  })

  logTaskSuccess('EpisodeAPI', 'generate-unified-narration-audio', {
    episodeId,
    taskId: task.id,
  })

  return success(c, {
    task_id: task.id,
    status: 'queued',
  })
})

// Helper: cancel active/pending tasks for a list of episodes
function cancelPendingTasksForEpisodes(episodeIds: number[]) {
  if (!episodeIds.length) return
  const ts = now()
  db.update(schema.creationTasks)
    .set({
      status: 'canceled',
      cancelRequested: true,
      updatedAt: ts,
      completedAt: ts,
    })
    .where(and(
      inArray(schema.creationTasks.episodeId, episodeIds),
      inArray(schema.creationTasks.status, ['queued', 'running', 'pending']),
    ))
    .run()
}

// Helper: renumber remaining episodes and update drama totals
function renumberEpisodesAndUpdateDrama(dramaId: number) {
  const remaining = db.select()
    .from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))
    .orderBy(schema.episodes.episodeNumber)
    .all()

  for (let i = 0; i < remaining.length; i++) {
    db.update(schema.episodes)
      .set({ episodeNumber: i + 1, updatedAt: now() })
      .where(eq(schema.episodes.id, remaining[i].id))
      .run()
  }

  const totalDuration = remaining.reduce((sum, e) => sum + (e.duration || 0), 0)
  db.update(schema.dramas)
    .set({
      totalEpisodes: remaining.length,
      totalDuration,
      updatedAt: now(),
    })
    .where(eq(schema.dramas.id, dramaId))
    .run()

  return remaining.length
}

// DELETE /episodes/:id — Soft delete a single episode and clean up dependents
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).all()
  if (!ep) return notFound(c, 'Episode not found')
  if (ep.deletedAt) return success(c, { id, deleted: false, reason: 'already_deleted' })

  resetEpisodeStoryboards(id)
  db.delete(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, id)).run()
  db.delete(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, id)).run()
  cancelPendingTasksForEpisodes([id])

  db.update(schema.episodes)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(eq(schema.episodes.id, id))
    .run()

  const remainingCount = renumberEpisodesAndUpdateDrama(ep.dramaId)

  return success(c, { id, deleted: true, remaining_count: remainingCount })
})

// POST /episodes/bulk-delete — Soft delete multiple episodes (must belong to same drama)
app.post('/bulk-delete', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const ids: number[] = Array.isArray(body.episode_ids)
    ? body.episode_ids.map(Number).filter(Boolean)
    : []
  if (!ids.length) return badRequest(c, 'episode_ids is required')

  const episodes = db.select().from(schema.episodes)
    .where(and(inArray(schema.episodes.id, ids), isNull(schema.episodes.deletedAt)))
    .all()
  if (!episodes.length) return notFound(c, 'No episodes found')

  const dramaId = episodes[0].dramaId
  if (episodes.some(e => e.dramaId !== dramaId)) {
    return badRequest(c, '批量删除的集必须属于同一 Drama')
  }

  for (const ep of episodes) {
    resetEpisodeStoryboards(ep.id)
    db.delete(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).run()
    db.delete(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, ep.id)).run()
  }
  cancelPendingTasksForEpisodes(ids)

  db.update(schema.episodes)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(inArray(schema.episodes.id, ids))
    .run()

  const remainingCount = renumberEpisodesAndUpdateDrama(dramaId)

  return success(c, { deleted: ids.length, remaining_count: remainingCount })
})

export default app
