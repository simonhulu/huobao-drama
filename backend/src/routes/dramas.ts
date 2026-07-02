import { Hono } from 'hono'
import { eq, and, isNull, like, desc, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, created, now, serverError } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { scheduleAutoStartForEpisode, scheduleExtractAfterRewrite, resetDramaEpisodes, scheduleDirectScriptPipeline } from '../services/tasks/auto-pipeline.js'
import { getSmartSplitDurationPreset, splitStoryIntoEpisodes } from '../services/episode-splitter.js'
import { generateRetentionTitles } from '../services/title-generator.js'
import { cleanDirectScript, type HookStyle, type RetentionMode } from '../services/direct-script-cleaner.js'
import { buildRetentionStructureFromScript, optimizeScriptForRetention, type RetentionStructure } from '../services/retention-script-optimizer.js'
import { smartSplitDirectScript, splitDirectScriptByMarkers, type DirectScriptSegment } from '../services/direct-script-splitter.js'
import { createTask, addTaskDependency } from '../services/tasks/store.js'

const app = new Hono()
type CleanMode = 'faithful' | 'retention'

function isTruthy(value: unknown) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function parseRetentionMode(value: unknown): RetentionMode {
  return value === 'tight' ? 'tight' : 'standard'
}

function parseCleanMode(value: unknown, retentionMode: RetentionMode): CleanMode {
  if (value === 'retention' || retentionMode === 'tight') return 'retention'
  return 'faithful'
}

function parseHookStyle(value: unknown): HookStyle {
  if (value === 'suspense' || value === 'conflict' || value === 'data') return value
  return 'auto'
}

function readActiveConfig(id: number, serviceType: 'image' | 'video' | 'audio') {
  const [row] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, id))
    .all()
  if (!row || !row.isActive || row.serviceType !== serviceType) return null
  return row
}

function buildContentPreview(content: string) {
  return content.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function isReusableSmartSplitPlaceholder(episode: typeof schema.episodes.$inferSelect) {
  return episode.title === `第${episode.episodeNumber}集`
    && !String(episode.content || '').trim()
    && !String(episode.scriptContent || '').trim()
    && !String(episode.description || '').trim()
    && !(episode.duration || 0)
    && !episode.imageConfigId
    && !episode.videoConfigId
    && !episode.audioConfigId
    && !episode.aspectRatio
    && (!episode.renderMode || episode.renderMode === 'image_story')
    && (episode.status || 'draft') === 'draft'
}

// GET /dramas - List dramas
app.get('/', async (c) => {
  const page = Number(c.req.query('page') || 1)
  const pageSize = Number(c.req.query('page_size') || 20)
  const status = c.req.query('status')
  const keyword = c.req.query('keyword')

  let query = db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt))

  const allRows = await query.orderBy(desc(schema.dramas.updatedAt))
  let filtered = allRows

  if (status) filtered = filtered.filter(d => d.status === status)
  if (keyword) filtered = filtered.filter(d => d.title.includes(keyword))

  const total = filtered.length
  const items = filtered.slice((page - 1) * pageSize, page * pageSize)

  // Attach episode/character/scene counts
  const enriched = await Promise.all(items.map(async (drama) => {
    const eps = await db.select().from(schema.episodes)
      .where(and(eq(schema.episodes.dramaId, drama.id), isNull(schema.episodes.deletedAt)))
    const chars = await db.select().from(schema.characters)
      .where(and(eq(schema.characters.dramaId, drama.id), isNull(schema.characters.deletedAt)))
    const scns = await db.select().from(schema.scenes)
      .where(and(eq(schema.scenes.dramaId, drama.id), isNull(schema.scenes.deletedAt)))
    return {
      ...toSnakeCase(drama),
      tags: drama.tags ? JSON.parse(drama.tags) : [],
      total_episodes: eps.length,
      episodes: toSnakeCaseArray(eps),
      characters: toSnakeCaseArray(chars),
      scenes: toSnakeCaseArray(scns),
    }
  }))

  return success(c, {
    items: enriched,
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
  })
})

// POST /dramas - Create drama
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  const res = db.insert(schema.dramas).values({
    title: body.title,
    description: body.description,
    genre: body.genre,
    style: body.style,
    tags: body.tags ? JSON.stringify(body.tags) : null,
    metadata: body.metadata,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [result] = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, Number(res.lastInsertRowid))).all()

  // Create default episodes
  const totalEpisodes = body.total_episodes || 1
  for (let i = 1; i <= totalEpisodes; i++) {
    db.insert(schema.episodes).values({
      dramaId: result.id,
      episodeNumber: i,
      title: `第${i}集`,
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }

  return created(c, toSnakeCase(result))
})


// GET /dramas/stats — must be before /:id
app.get('/stats', async (c) => {
  const all = db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt)).all()
  const byStatus = Object.entries(
    all.reduce((acc, d) => {
      acc[d.status || 'draft'] = (acc[d.status || 'draft'] || 0) + 1
      return acc
    }, {} as Record<string, number>)
  ).map(([status, count]) => ({ status, count }))
  return success(c, { total: all.length, by_status: byStatus })
})

// POST /dramas/:id/smart-split - Smart split original story into episodes
app.post('/:id/smart-split', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({} as Record<string, any>))

  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
  if (!drama) return notFound(c, '剧本不存在')

  const sourceText = String(body.source_text || '').trim()
  const durationPresetId = String(body.duration_preset || '').trim()
  const imageConfigId = Number(body.image_config_id)
  const videoConfigId = Number(body.video_config_id)
  const audioConfigId = Number(body.audio_config_id)
  const aspectRatio = String(body.aspect_ratio || '16:9')
  const renderMode = body.render_mode === 'ai_video' ? 'ai_video' : 'image_story'
  const style = body.style === 'ai_manga_drama' ? 'ai_manga_drama' : body.style === 'default' ? 'default' : undefined
  const pacingMode = String(body.pacing_mode || drama.pacingMode || 'standard').trim()
  const replaceExisting = body.replace === true

  if (!sourceText || !durationPresetId || !Number.isInteger(imageConfigId) || !Number.isInteger(videoConfigId) || !Number.isInteger(audioConfigId)) {
    return badRequest(c, 'source_text、duration_preset、image_config_id、video_config_id、audio_config_id 必填')
  }

  if (!getSmartSplitDurationPreset(durationPresetId)) {
    return badRequest(c, `不支持的分集时长选项: ${durationPresetId}`)
  }

  if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
    return badRequest(c, 'aspect_ratio 仅支持 16:9 或 9:16')
  }

  if (!readActiveConfig(imageConfigId, 'image') || !readActiveConfig(videoConfigId, 'video') || !readActiveConfig(audioConfigId, 'audio')) {
    return badRequest(c, '所选图片、视频或音频配置不存在，或未启用')
  }

  try {
    const splitResult = await splitStoryIntoEpisodes({
      dramaTitle: drama.title,
      sourceText,
      durationPresetId,
      style,
      pacingMode,
    })

    if (replaceExisting) {
      resetDramaEpisodes(dramaId)
    }

    const existingEpisodes = db.select().from(schema.episodes)
      .where(eq(schema.episodes.dramaId, dramaId))
      .orderBy(schema.episodes.episodeNumber)
      .all()
    const startNumber = existingEpisodes.length ? Math.max(...existingEpisodes.map((episode) => episode.episodeNumber)) + 1 : 1
    const ts = now()

    const reusablePlaceholders = existingEpisodes.filter(isReusableSmartSplitPlaceholder)

    const createdEpisodes = db.transaction((tx) => {
      let nextEpisodeNumber = startNumber

      return splitResult.episodes.map((episode, index) => {
        const reusableEpisode = reusablePlaceholders[index]
        const episodeNumber = reusableEpisode?.episodeNumber ?? nextEpisodeNumber++
        const description = `${episode.summary}\n\n集尾钩子：${episode.cliffhangerHook}`
        let episodeId: number

        if (reusableEpisode) {
          tx.update(schema.episodes).set({
            title: episode.title || `第${episodeNumber}集`,
            content: episode.content,
            description,
            duration: episode.estimatedDurationSeconds,
            imageConfigId,
            videoConfigId,
            audioConfigId,
            aspectRatio,
            renderMode,
            pacingMode,
            dialogueMode: 'narration_only',
            openingHook: episode.openingHook,
            cliffhanger: episode.cliffhangerHook,
            narrationVoiceId: 'DaniangzhuVoice01',
            workflowType: 'story_rewrite',
            status: 'draft',
            updatedAt: ts,
          }).where(eq(schema.episodes.id, reusableEpisode.id)).run()

          episodeId = reusableEpisode.id
        } else {
          const res = tx.insert(schema.episodes).values({
            dramaId,
            episodeNumber,
            title: episode.title || `第${episodeNumber}集`,
            content: episode.content,
            description,
            duration: episode.estimatedDurationSeconds,
            imageConfigId,
            videoConfigId,
            audioConfigId,
            aspectRatio,
            renderMode,
            pacingMode,
            dialogueMode: 'narration_only',
            openingHook: episode.openingHook,
            cliffhanger: episode.cliffhangerHook,
            narrationVoiceId: 'DaniangzhuVoice01',
            workflowType: 'story_rewrite',
            status: 'draft',
            createdAt: ts,
            updatedAt: ts,
          }).run()

          episodeId = Number(res.lastInsertRowid)
        }

        const [row] = tx.select().from(schema.episodes)
          .where(eq(schema.episodes.id, episodeId))
          .all()

        return {
          id: row.id,
          episode_number: row.episodeNumber,
          title: row.title,
          duration: row.duration,
          description: row.description,
          content_preview: buildContentPreview(row.content || ''),
          opening_hook: episode.openingHook,
          cliffhanger_hook: episode.cliffhangerHook,
          summary: episode.summary,
          covered_beat_ids: episode.coveredBeatIds,
        }
      })
    })

    db.update(schema.dramas)
      .set({ hook: splitResult.hook, totalEpisodes: createdEpisodes.length, updatedAt: ts })
      .where(eq(schema.dramas.id, dramaId))
      .run()

    // 生成 retention 风格的项目/分集标题
    let videoTitles: { dramaTitle: string; episodeTitles: string[] } | null = null
    try {
      videoTitles = await generateRetentionTitles({
        dramaTitle: drama.title,
        sourceText,
        splitResult,
        style: drama.style || '',
      })
      db.update(schema.dramas)
        .set({ videoTitle: videoTitles.dramaTitle, updatedAt: ts })
        .where(eq(schema.dramas.id, dramaId))
        .run()
      for (let i = 0; i < createdEpisodes.length; i++) {
        const ep = createdEpisodes[i]
        if (!ep) continue
        db.update(schema.episodes)
          .set({ videoTitle: videoTitles.episodeTitles[i], updatedAt: ts })
          .where(eq(schema.episodes.id, ep.id))
          .run()
      }
    } catch (err) {
      console.error('Generate retention titles failed:', err)
    }

    return created(c, {
      drama_id: dramaId,
      hook: splitResult.hook,
      video_title: videoTitles?.dramaTitle || null,
      duration_preset: splitResult.durationPreset,
      plot_progression_chain: splitResult.plotProgressionChain.map((beat) => ({
        beat_id: beat.beatId,
        phase: beat.phase,
        summary: beat.summary,
        dramatic_function: beat.dramaticFunction,
        suspense_value: beat.suspenseValue,
        must_keep_context: beat.mustKeepContext,
      })),
      created_episodes: createdEpisodes.map((ep, idx) => ({
        ...ep,
        video_title: videoTitles?.episodeTitles[idx] || null,
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '智能分集失败'
    return serverError(c, message)
  }
})

// POST /dramas/:id/import-script - 导入成品稿（可选 AI 清理 + AI 智能分集）
app.post('/:id/import-script', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
  if (!drama) return notFound(c, '剧本不存在')

  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  let scriptContent = String(body.script_content || '').trim()
  if (!scriptContent) return badRequest(c, 'script_content is required')

  const requestedRetentionMode = parseRetentionMode(body.retention_mode)
  const cleanMode = parseCleanMode(body.clean_mode, requestedRetentionMode)
  const retentionMode: RetentionMode = cleanMode === 'retention' ? 'tight' : 'standard'
  const hookStyle = parseHookStyle(body.hook_style)
  const cleanAlreadyApplied = isTruthy(body.clean_already_applied)

  // 可选：AI 清理解说稿。留存优化模式先做保真清理，后续按分集逐段做结构编辑。
  const shouldClean = body.clean === true || body.enable_clean === true
  if (shouldClean) {
    try {
      scriptContent = await cleanDirectScript(scriptContent, { retentionMode: 'standard', hookStyle })
    } catch (err) {
      const message = err instanceof Error ? err.message : '清理解说稿失败'
      return serverError(c, message)
    }
  }

  // 分集：支持 AI 智能分集；不传 duration_preset 时整篇作为 1 集
  let segments: DirectScriptSegment[]
  const segmentMarkers = Array.isArray(body.segment_markers)
    ? body.segment_markers.map((marker: unknown) => String(marker || '').trim()).filter(Boolean)
    : []
  const durationPresetId = body.duration_preset
  if (segmentMarkers.length > 0) {
    segments = splitDirectScriptByMarkers(scriptContent, segmentMarkers)
    if (segments.length === 0) {
      return badRequest(c, 'segment_markers did not produce any script segments')
    }
  } else if (durationPresetId) {
    try {
      segments = await smartSplitDirectScript(scriptContent, {
        dramaTitle: drama.title,
        durationPresetId,
        style: body.split_style === 'ai_manga_drama' ? 'ai_manga_drama' : 'default',
        pacingMode: body.pacing_mode || 'standard',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : '智能分集失败'
      return serverError(c, message)
    }
  } else {
    segments = [{
      title: body.title || '导入集',
      content: scriptContent,
      summary: body.description || '',
      openingHook: '',
      cliffhangerHook: '',
      estimatedDurationSeconds: 0,
    }]
  }

  const ts = now()
  const existing = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .orderBy(schema.episodes.episodeNumber).all()
  let nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  const createdEpisodes: {
    id: number
    episode_number: number
    title: string
    initial_task_id: number | null
    opening_hook?: string | null
    cliffhanger?: string | null
    retention_beats?: RetentionStructure | null
  }[] = []

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    let segmentContent = segment.content
    let openingHook = segment.openingHook
    let cliffhanger = segment.cliffhangerHook
    let retentionBeats: RetentionStructure | null = null

    // 留存优化模式下，对每段做结构化编辑，并提取开头钩子/结尾悬念/留存 beat。
    if (cleanMode === 'retention') {
      try {
        if (cleanAlreadyApplied && !shouldClean) {
          retentionBeats = buildRetentionStructureFromScript(segmentContent, { hookStyle }) || null
          openingHook = retentionBeats?.openingHook.text || openingHook
          cliffhanger = retentionBeats?.cliffhanger.text || cliffhanger
        } else {
          const optimized = await optimizeScriptForRetention(segmentContent, {
            retentionMode,
            hookStyle,
            targetDurationSeconds: segment.estimatedDurationSeconds || undefined,
          })
          segmentContent = optimized.productionScript
          openingHook = optimized.openingHook || openingHook
          cliffhanger = optimized.cliffhanger || cliffhanger
          retentionBeats = optimized.retentionBeats || null
        }
      } catch (err) {
        // 优化失败时回退到原内容，不阻断导入
        console.error('optimizeScriptForRetention failed:', err)
      }
    }

    const title = body.title
      ? (segments.length > 1 ? `${body.title} ${i + 1}` : body.title)
      : (segment.title || `第${nextNum}集`)

    const res = db.insert(schema.episodes).values({
      dramaId,
      episodeNumber: nextNum,
      title,
      scriptContent: segmentContent,
      content: segmentContent,
      description: body.description ?? segment.summary ?? null,
      openingHook: openingHook || null,
      cliffhanger: cliffhanger || null,
      retentionBeats: retentionBeats ? JSON.stringify(retentionBeats) : null,
      imageConfigId: body.image_config_id ?? null,
      videoConfigId: body.video_config_id ?? null,
      audioConfigId: body.audio_config_id ?? null,
      aspectRatio: body.aspect_ratio ?? '16:9',
      renderMode: body.render_mode === 'ai_video' ? 'ai_video' : 'image_story',
      autoMode: true,
      enableAiRewrite: false,
      workflowType: 'direct_script',
      pacingMode: 'literal',
      narrationMode: 'verbatim',
      narrationVoiceId: body.narration_voice_id ?? 'DaniangzhuVoice01',
      createdAt: ts,
      updatedAt: ts,
    }).run()

    const episodeId = Number(res.lastInsertRowid)
    const extractTask = scheduleExtractAfterRewrite(dramaId, episodeId)
    // 精稿直出：extractor 完成后自动拆镜，再自动推进 image/tts/compose/merge
    const directPipeline = scheduleDirectScriptPipeline(dramaId, episodeId)
    if (directPipeline?.breaker) {
      addTaskDependency(directPipeline.breaker.id, extractTask.id)
    }

    createdEpisodes.push({
      id: episodeId,
      episode_number: nextNum,
      title,
      initial_task_id: extractTask.id,
      opening_hook: openingHook || null,
      cliffhanger: cliffhanger || null,
      retention_beats: retentionBeats,
    })

    nextNum++
  }

  db.update(schema.dramas)
    .set({ totalEpisodes: nextNum - 1, updatedAt: ts })
    .where(eq(schema.dramas.id, dramaId))
    .run()

  return created(c, {
    drama_id: dramaId,
    clean_mode: cleanMode,
    retention_mode: retentionMode,
    episodes: createdEpisodes,
    segment_count: createdEpisodes.length,
    cleaned: shouldClean,
  })
})

// POST /dramas/:id/pre-production - Drama 级预生产
app.post('/:id/pre-production', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
  if (!drama) return notFound(c, '剧本不存在')

  const episodes = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))
    .orderBy(schema.episodes.episodeNumber)
    .all()
    .filter(ep => String(ep.content || '').trim() || String(ep.scriptContent || '').trim())

  if (episodes.length === 0) {
    return badRequest(c, '当前 drama 下没有可提取的 episode 内容')
  }

  const task = createTask({
    type: 'drama.pre_production',
    dramaId,
    scopeType: 'drama',
    scopeId: dramaId,
    priority: 60,
    idempotencyKey: `drama.pre_production:${dramaId}`,
    payload: { drama_id: dramaId },
  })

  return success(c, {
    drama_id: dramaId,
    task_id: task.id,
    status: task.status,
    episodes_count: episodes.length,
  })
})

// GET /dramas/:id - Get drama detail
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, id))
  if (!drama) return notFound(c, '剧本不存在')

  const eps = await db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, id), isNull(schema.episodes.deletedAt)))
  const chars = await db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, id), isNull(schema.characters.deletedAt)))
  const scns = await db.select().from(schema.scenes)
    .where(and(eq(schema.scenes.dramaId, id), isNull(schema.scenes.deletedAt)))
  const prps = await db.select().from(schema.props)
    .where(and(eq(schema.props.dramaId, id), isNull(schema.props.deletedAt)))

  const episodeIds = eps.map(ep => ep.id)
  const storyboardCounts = new Map<number, number>()
  const composedCounts = new Map<number, number>()
  if (episodeIds.length) {
    const sbs = await db.select().from(schema.storyboards)
      .where(and(inArray(schema.storyboards.episodeId, episodeIds), isNull(schema.storyboards.deletedAt)))
    for (const sb of sbs) {
      if (!sb.episodeId) continue
      storyboardCounts.set(sb.episodeId, (storyboardCounts.get(sb.episodeId) || 0) + 1)
      if (sb.composedVideoUrl) {
        composedCounts.set(sb.episodeId, (composedCounts.get(sb.episodeId) || 0) + 1)
      }
    }
  }

  const enrichedEpisodes = eps.map(ep => ({
    ...toSnakeCase(ep),
    storyboard_count: storyboardCounts.get(ep.id) || 0,
    composed_count: composedCounts.get(ep.id) || 0,
  }))

  return success(c, {
    ...toSnakeCase(drama),
    tags: drama.tags ? JSON.parse(drama.tags) : [],
    episodes: enrichedEpisodes,
    characters: toSnakeCaseArray(chars),
    scenes: toSnakeCaseArray(scns),
    props: toSnakeCaseArray(prps),
  })
})

// PUT /dramas/:id - Update drama
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.genre !== undefined) updates.genre = body.genre
  if (body.style !== undefined) updates.style = body.style
  if (body.pacing_mode !== undefined) updates.pacingMode = body.pacing_mode || 'tight'
  if (body.status !== undefined) updates.status = body.status
  if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags)
  if (body.metadata !== undefined) updates.metadata = body.metadata
  db.update(schema.dramas).set(updates).where(eq(schema.dramas.id, id)).run()
  return success(c)
})

// DELETE /dramas/:id - Soft delete
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.update(schema.dramas).set({ deletedAt: now() }).where(eq(schema.dramas.id, id))
  return success(c)
})

// PUT /dramas/:id/characters - Save characters
app.put('/:id/characters', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const chars = body.characters || []
  const ts = now()

  for (const char of chars) {
    if (char.id) {
      await db.update(schema.characters).set({ ...char, updatedAt: ts }).where(eq(schema.characters.id, char.id))
    } else {
      await db.insert(schema.characters).values({ ...char, dramaId, createdAt: ts, updatedAt: ts })
    }
  }
  return success(c)
})

// PUT /dramas/:id/episodes - Save episodes
app.put('/:id/episodes', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const episodes = body.episodes || []
  const ts = now()

  for (const ep of episodes) {
    if (ep.id) {
      await db.update(schema.episodes).set({ ...ep, updatedAt: ts }).where(eq(schema.episodes.id, ep.id))
    } else {
      await db.insert(schema.episodes).values({
        ...ep,
        dramaId,
        episodeNumber: ep.episode_number || ep.episodeNumber || 1,
        title: ep.title || '未命名',
        createdAt: ts,
        updatedAt: ts,
      })
    }
  }
  return success(c)
})

// POST /dramas/:id/episodes - Create a single episode under a drama (remote creation)
// Query: ?auto=true 开启自动创作流水线（需要传入 content）
app.post('/:id/episodes', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const auto = isTruthy(c.req.query('auto')) || isTruthy(body.auto) || isTruthy(body.auto_mode)
  const ts = now()

  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
  if (!drama) return notFound(c, '剧本不存在')

  if (auto && !body.content) {
    return badRequest(c, 'auto=true 时必须传入 content（原始故事）')
  }

  const existing = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .orderBy(schema.episodes.episodeNumber).all()
  const nextNum = existing.length ? Math.max(...existing.map(e => e.episodeNumber)) + 1 : 1

  const res = db.insert(schema.episodes).values({
    dramaId,
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
    enableAiRewrite: body.enable_ai_rewrite === undefined ? true : isTruthy(body.enable_ai_rewrite),
    narrationVoiceId: body.narration_voice_id ?? null,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [ep] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, Number(res.lastInsertRowid))).all()

  let initialTaskId: number | null = null
  let autoStarted = false
  if (auto) {
    const task = scheduleAutoStartForEpisode(dramaId, ep.id, body.content)
    initialTaskId = task.id
    autoStarted = true
  }

  return created(c, {
    id: ep.id,
    drama_id: ep.dramaId,
    episode_number: ep.episodeNumber,
    title: ep.title,
    aspect_ratio: ep.aspectRatio,
    render_mode: ep.renderMode,
    image_config_id: ep.imageConfigId,
    video_config_id: ep.videoConfigId,
    audio_config_id: ep.audioConfigId,
    auto_started: autoStarted,
    initial_task_id: initialTaskId,
    created_at: ep.createdAt,
    updated_at: ep.updatedAt,
  })
})

export default app
