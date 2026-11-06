import { Hono } from 'hono'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'
import {
  createRemotionProjectFromEpisode,
  createRemotionProjectFromScript,
  enqueueRemotionImageAsset,
  getRemotionAssets,
  getRemotionProjectSnapshot,
  getRemotionStageRuns,
  initializeRemotionFactory,
  listRemotionProductionTree,
  listRemotionProjects,
  listRemotionTasks,
  planRemotionProject,
  recordRemotionStageRun,
  resolveRemotionMediaAccount,
  upsertRemotionAsset,
  upsertRemotionRender,
  upsertRemotionShots,
  type RemotionAssetInput,
  type RemotionRenderInput,
  type RemotionShotInput,
  type RemotionStage,
} from '../services/remotion.js'
import {
  buildEpisodeSplitMetadata,
  estimateSourceDurationSeconds,
  getSmartSplitDurationPreset,
  splitStoryIntoEpisodes,
} from '../services/episode-splitter.js'
import { parseJsonRecord, serializePositioning } from '../services/media-accounts.js'
import { getNarrativeStoryboardProgress } from '../services/narrative-storyboard-progress.js'
import { ensureNarrativePlanFromStoryboards, getNarrativeHierarchyForEpisode, importNarrativePlan, updatePanelStatus, mapSoundPlanDocument, findPlanId, upsertSheets, applyPanelStates } from '../services/narrative-hierarchy.js'
import { listProjectRenderArtifacts } from '../services/render-artifacts.js'
import { createTask } from '../services/tasks/store.js'
import { DEFAULT_NARRATION_SPEED } from '../services/narration-defaults.js'
import stylePilotsRoute from './remotion-style-pilots.js'
import { createHistoryFactoryRoute } from './history-factory.js'

const app = new Hono()
app.route('/style-pilots', stylePilotsRoute)
app.route('/', createHistoryFactoryRoute())

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function projectIdFromParam(value: string): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

// Producer endpoints are intentionally separate from the display/query
// endpoints below. The Web UI only needs GET; the videoeditor Skill uses these
// writes to persist its latest schema-shaped artifacts.
app.post('/projects', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const episodeId = numberOrUndefined(body.episode_id ?? body.episodeId)
  const script = typeof body.script === 'string'
    ? body.script
    : typeof body.narration === 'string' ? body.narration : null
  if (!episodeId && !script?.trim()) return badRequest(c, 'episode_id or script is required')
  try {
    const options = {
      title: typeof body.title === 'string' ? body.title : undefined,
      slug: typeof body.slug === 'string' ? body.slug : undefined,
      metadata: body.metadata,
      sourceDramaId: numberOrUndefined(body.source_drama_id ?? body.sourceDramaId),
      mediaAccountId: numberOrUndefined(body.media_account_id ?? body.mediaAccountId),
      projectPositioning: body.project_positioning ?? body.projectPositioning,
      episodeBrief: body.episode_brief ?? body.episodeBrief,
    }
    const snapshot = episodeId
      ? createRemotionProjectFromEpisode(episodeId, options)
      : createRemotionProjectFromScript(script!, {
        ...options,
        narration: typeof body.narration === 'string' ? body.narration : undefined,
      })
    return created(c, snapshot)
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
})

/**
 * Remotion-only script intake. It creates the content-project/episode layer
 * first, runs the existing semantic smart-splitter, then creates one
 * independent Remotion production record per episode. The legacy episode
 * pipeline is not scheduled here.
 */
app.post('/projects/intake', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const script = typeof body.script === 'string'
    ? body.script.trim()
    : typeof body.narration === 'string' ? body.narration.trim() : ''
  const accountId = numberOrUndefined(body.media_account_id ?? body.mediaAccountId)
  const requestedDurationPresetId = typeof body.duration_preset === 'string'
    ? body.duration_preset.trim()
    : typeof body.durationPreset === 'string' ? body.durationPreset.trim() : ''
  const sourceDramaId = numberOrUndefined(body.source_drama_id ?? body.sourceDramaId)
  const title = typeof body.title === 'string' && body.title.trim()
    ? body.title.trim()
    : 'Remotion 历史口播项目'

  if (!script) return badRequest(c, 'script is required')
  if (!accountId) return badRequest(c, 'media_account_id is required')
  // The episode range is an editorial decision made by the user. Source
  // duration is useful for an estimate shown in the UI, but must never select
  // a preset implicitly or turn a long source into one oversized episode.
  if (!requestedDurationPresetId || requestedDurationPresetId === 'auto') {
    return badRequest(c, 'duration_preset is required; choose the target range for each episode')
  }
  const durationPresetId = requestedDurationPresetId
  if (!getSmartSplitDurationPreset(durationPresetId)) {
    return badRequest(c, `Unknown duration preset: ${durationPresetId}`)
  }

  try {
    const account = resolveRemotionMediaAccount(accountId)
    const sourceDrama = sourceDramaId
      ? db.select().from(schema.dramas).where(and(
        eq(schema.dramas.id, sourceDramaId),
        isNull(schema.dramas.deletedAt),
      )).all()[0] || null
      : null
    if (sourceDramaId && !sourceDrama) return notFound(c, `Content project ${sourceDramaId} not found`)
    if (sourceDrama && sourceDrama.mediaAccountId !== account.id) {
      return badRequest(c, `Content project ${sourceDrama.id} belongs to media account ${sourceDrama.mediaAccountId ?? 'none'}, not ${account.id}`)
    }

    const splitResult = await splitStoryIntoEpisodes({
      dramaTitle: sourceDrama?.title || title,
      sourceText: script,
      durationPresetId,
      style: body.split_style === 'ai_manga_drama' ? 'ai_manga_drama' : 'default',
      productionMode: 'direct_script',
    })
    if (!splitResult.episodes.length) throw new Error('smart split produced no episodes')

    const projectPositioning = body.project_positioning ?? body.projectPositioning
    const episodeBrief = parseJsonRecord(body.episode_brief ?? body.episodeBrief)
    const ts = now()
    const intake = db.transaction((tx) => {
      let dramaId = sourceDrama?.id ?? null
      if (!dramaId) {
        const result = tx.insert(schema.dramas).values({
          mediaAccountId: account.id,
          title,
          projectPositioningJson: serializePositioning(projectPositioning ?? {}),
          workflowType: 'direct_script',
          status: 'draft',
          totalEpisodes: 0,
          createdAt: ts,
          updatedAt: ts,
        }).run()
        dramaId = Number(result.lastInsertRowid)
      }

      const existingEpisodes = tx.select().from(schema.episodes)
        .where(eq(schema.episodes.dramaId, dramaId))
        .orderBy(asc(schema.episodes.episodeNumber))
        .all()
      let nextEpisodeNumber = existingEpisodes.length
        ? Math.max(...existingEpisodes.map((episode) => episode.episodeNumber)) + 1
        : 1
      const episodes = splitResult.episodes.map((episode) => {
        const brief = {
          ...episodeBrief,
          series_hook: splitResult.hook,
          covered_beat_ids: episode.coveredBeatIds,
        }
        const result = tx.insert(schema.episodes).values({
          dramaId,
          episodeNumber: nextEpisodeNumber++,
          title: episode.title || `第${nextEpisodeNumber - 1}集`,
          content: episode.content,
          scriptContent: episode.content,
          description: episode.summary,
          duration: episode.estimatedDurationSeconds,
          metadata: buildEpisodeSplitMetadata(episode, splitResult.plotProgressionChain, {
            durationPreset: splitResult.durationPreset,
            sourceDurationSeconds: estimateSourceDurationSeconds(script),
            estimatedEpisodeCount: splitResult.episodes.length,
          }),
          creativeBriefJson: JSON.stringify(brief),
          seriesHook: splitResult.hook,
          aspectRatio: body.aspect_ratio === '9:16' ? '9:16' : '16:9',
          renderMode: 'image_story',
          workflowType: 'direct_script',
          narrationMode: 'verbatim',
          dialogueMode: 'narration_only',
          narrationSpeed: DEFAULT_NARRATION_SPEED,
          autoMode: false,
          enableAiRewrite: false,
          status: 'draft',
          createdAt: ts,
          updatedAt: ts,
        }).run()
        return Number(result.lastInsertRowid)
      })
      tx.update(schema.dramas).set({
        hook: splitResult.hook,
        totalEpisodes: existingEpisodes.length + episodes.length,
        updatedAt: ts,
      }).where(eq(schema.dramas.id, dramaId)).run()
      return { dramaId, episodeIds: episodes }
    })

    const productions = intake.episodeIds
      .map((episodeId) => createRemotionProjectFromEpisode(episodeId, {
        mediaAccountId: account.id,
        projectPositioning,
      }))
      .filter((production): production is NonNullable<typeof production> => Boolean(production))
    const episodes = db.select().from(schema.episodes)
      .where(and(
        eq(schema.episodes.dramaId, intake.dramaId),
        isNull(schema.episodes.deletedAt),
      ))
      .orderBy(asc(schema.episodes.episodeNumber))
      .all()
      .filter((episode) => intake.episodeIds.includes(episode.id))

    return created(c, {
      content_project: {
        id: intake.dramaId,
        title: db.select().from(schema.dramas).where(eq(schema.dramas.id, intake.dramaId)).all()[0]?.title || title,
        media_account_id: account.id,
        media_account_name: account.name,
        positioning: parseJsonRecord(db.select().from(schema.dramas).where(eq(schema.dramas.id, intake.dramaId)).all()[0]?.projectPositioningJson),
      },
      duration_preset: splitResult.durationPreset,
      series_hook: splitResult.hook,
      episodes: episodes.map((episode) => ({
        id: episode.id,
        episode_number: episode.episodeNumber,
        title: episode.title,
        duration: episode.duration,
        summary: episode.description,
        production_project_id: productions.find((production) => production.project.sourceEpisodeId === episode.id)?.project.id || null,
      })),
      productions: productions.map((production) => production.project),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return badRequest(c, message)
  }
})

app.delete('/projects/:id', async (c) => {
  const param = c.req.param('id')
  const numericId = Number(param)
  const ts = now()

  if (!Number.isInteger(numericId) || numericId <= 0) return badRequest(c, 'invalid id')

  // 先按 source_episode_id 查找 remotion project
  const project = db.select().from(schema.remotionProjects)
    .where(and(
      eq(schema.remotionProjects.sourceEpisodeId, numericId),
      isNull(schema.remotionProjects.deletedAt),
    )).get()

  if (project) {
    db.update(schema.remotionProjects)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(eq(schema.remotionProjects.id, project.id))
      .run()
    return success(c, { id: project.id, deleted: true, sourceEpisodeId: numericId })
  }

  // 再按 project id 查找
  const projectById = db.select().from(schema.remotionProjects)
    .where(and(
      eq(schema.remotionProjects.id, numericId),
      isNull(schema.remotionProjects.deletedAt),
    )).get()

  if (projectById) {
    db.update(schema.remotionProjects)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(eq(schema.remotionProjects.id, projectById.id))
      .run()
    return success(c, { id: projectById.id, deleted: true, sourceEpisodeId: projectById.sourceEpisodeId })
  }

  // 没有 remotion project——检查 episode 是否存在，清理关联数据使其从列表消失
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, numericId)).all()
  if (!ep) return notFound(c, 'Episode not found')

  // 清理 narrative plans
  db.delete(schema.narrativePlans).where(eq(schema.narrativePlans.episodeId, numericId)).run()
  // 删除 storyboard
  db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, numericId)).run()

  return success(c, { id: numericId, deleted: true, episodeCleaned: true })
})

app.post('/projects/:id/stages/:stage', async (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  try {
    const stage = c.req.param('stage') as RemotionStage
    const run = recordRemotionStageRun({
      projectId,
      stage,
      status: typeof body.status === 'string' ? body.status as any : undefined,
      input: body.input,
      inputHash: typeof body.input_hash === 'string' ? body.input_hash : undefined,
      output: body.output,
      taskId: numberOrUndefined(body.task_id ?? body.taskId) ?? null,
      errorCode: typeof body.error_code === 'string' ? body.error_code : null,
      errorMessage: typeof body.error_message === 'string' ? body.error_message : null,
      stageVersion: numberOrUndefined(body.stage_version ?? body.stageVersion),
    })
    return success(c, run)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('not found') ? notFound(c, message) : badRequest(c, message)
  }
})

app.post('/projects/:id/factory/initialize', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  try {
    const snapshot = initializeRemotionFactory(projectId)
    return success(c, snapshot)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('not found') ? notFound(c, message) : badRequest(c, message)
  }
})

// The videoeditor Skill is the producer. It sends the stock catalog it has
// already searched/downloaded; this endpoint persists the resulting plan and
// leaves image generation/rendering as later stages.
app.post('/projects/:id/plan', async (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const stockCatalog = Array.isArray(body.stock_catalog)
    ? body.stock_catalog
    : Array.isArray(body.stockCatalog) ? body.stockCatalog : []
  try {
    return success(c, planRemotionProject(projectId, stockCatalog as any[], {
      regenerateFromSource: body.regenerate_from_source === true || body.regenerateFromSource === true,
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('not found') ? notFound(c, message) : badRequest(c, message)
  }
})

app.post('/projects/:id/shots', async (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  if (!Array.isArray(body.shots)) return badRequest(c, 'shots array is required')
  try {
    const shots = upsertRemotionShots(projectId, body.shots as RemotionShotInput[])
    return success(c, shots)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('not found') ? notFound(c, message) : badRequest(c, message)
  }
})

app.post('/projects/:id/assets', async (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  try {
    const inputs = Array.isArray(body.assets) ? body.assets : [body]
    return success(c, inputs.map((input) => upsertRemotionAsset(projectId, input as RemotionAssetInput)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('not found') ? notFound(c, message) : badRequest(c, message)
  }
})

app.post('/projects/:id/assets/image', async (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const shotId = numberOrUndefined(body.shot_id ?? body.shotId)
  if (!shotId || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return badRequest(c, 'shot_id and prompt are required')
  }
  try {
    return created(c, enqueueRemotionImageAsset({
      projectId,
      shotId,
      assetKey: typeof body.asset_key === 'string' ? body.asset_key : undefined,
      assetType: typeof body.asset_type === 'string' ? body.asset_type as 'ai_image' | 'character' : undefined,
      prompt: body.prompt,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      configId: numberOrUndefined(body.config_id ?? body.configId),
      referenceImages: Array.isArray(body.reference_images) ? body.reference_images.filter((item): item is string => typeof item === 'string') : [],
      seed: numberOrUndefined(body.seed),
      size: typeof body.size === 'string' ? body.size : undefined,
      style: typeof body.style === 'string' ? body.style : undefined,
      width: numberOrUndefined(body.width),
      height: numberOrUndefined(body.height),
      metadata: body.metadata,
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('not found') ? notFound(c, message) : badRequest(c, message)
  }
})

app.post('/projects/:id/renders', async (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  try {
    const render = upsertRemotionRender(projectId, {
      shotId: numberOrUndefined(body.shot_id ?? body.shotId) ?? null,
      renderKind: typeof body.render_kind === 'string' ? body.render_kind as RemotionRenderInput['renderKind'] : 'shot',
      status: typeof body.status === 'string' ? body.status as RemotionRenderInput['status'] : undefined,
      inputHash: typeof body.input_hash === 'string' ? body.input_hash : null,
      props: body.props,
      outputPath: typeof body.output_path === 'string' ? body.output_path : null,
      outputUrl: typeof body.output_url === 'string' ? body.output_url : null,
      width: numberOrUndefined(body.width) ?? null,
      height: numberOrUndefined(body.height) ?? null,
      fps: numberOrUndefined(body.fps) ?? null,
      durationMs: numberOrUndefined(body.duration_ms ?? body.durationMs) ?? null,
      qa: body.qa,
      taskId: numberOrUndefined(body.task_id ?? body.taskId) ?? null,
      errorCode: typeof body.error_code === 'string' ? body.error_code : null,
      errorMessage: typeof body.error_message === 'string' ? body.error_message : null,
    })
    return success(c, render)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('not found') ? notFound(c, message) : badRequest(c, message)
  }
})

app.get('/projects', (c) => success(c, listRemotionProjects({
  sourceEpisodeId: numberOrUndefined(c.req.query('source_episode_id')),
  status: c.req.query('status'),
})))

// The Web UI reads the business hierarchy first, then loads one production
// snapshot for the selected Episode. Existing producer/query endpoints remain flat.
app.get('/projects/tree', (c) => success(c, listRemotionProductionTree()))

app.get('/projects/:id/narrative-storyboard-progress', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  return snapshot
    ? success(c, getNarrativeStoryboardProgress(projectId))
    : notFound(c, 'Remotion project not found')
})

// v8 渲染产物发现：列出 project-{id}-*.mp4（deliver/pilot/proof 等分类），
// 并把该 source episode 的 history-comic 交付（episodes.video_url）一并纳入。
app.get('/projects/:id/render-artifacts', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  if (!snapshot) return notFound(c, 'Remotion project not found')
  let episodeVideoUrl: string | null = null
  const sourceEpisodeId = snapshot.project.sourceEpisodeId
  if (sourceEpisodeId != null) {
    const [ep] = db.select({ videoUrl: schema.episodes.videoUrl })
      .from(schema.episodes)
      .where(eq(schema.episodes.id, sourceEpisodeId))
      .all()
    episodeVideoUrl = ep?.videoUrl ?? null
  }
  return success(c, { artifacts: listProjectRenderArtifacts(projectId, { episodeVideoUrl }) })
})

// v8 叙事层级：查询（episode 维度，生产中心页用）
app.get('/projects/:id/narrative-hierarchy', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  if (!snapshot) return notFound(c, 'Remotion project not found')
  if (!snapshot.project.sourceEpisodeId) return badRequest(c, 'project has no source episode')
  const kind = c.req.query('kind') || 'full'
  // 如果已有 storyboards 但还没有 narrative plan，自动从 storyboards 同步一份轻量层级。
  ensureNarrativePlanFromStoryboards(snapshot.project.sourceEpisodeId, kind)
  return success(c, getNarrativeHierarchyForEpisode(snapshot.project.sourceEpisodeId, kind))
})

// v8 叙事层级：整包导入（producer 写库路径，事务内整体替换）
app.post('/projects/:id/narrative-hierarchy/import', async (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  if (!snapshot) return notFound(c, 'Remotion project not found')
  if (!snapshot.project.sourceEpisodeId) return badRequest(c, 'project has no source episode')
  const body = await c.req.json().catch(() => null)
  if (!body || !Array.isArray(body.sequences)) return badRequest(c, 'sequences required')
  const result = importNarrativePlan({
    ...body,
    episodeId: snapshot.project.sourceEpisodeId,
    remotionProjectId: projectId,
    kind: body.kind || 'full',
  })
  return success(c, result)
})

// v8 叙事层级：原始文档导入（producer 直接 POST sound-plan / sheet-manifest / production-state）
app.post('/projects/:id/narrative-hierarchy/import-document', async (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  if (!snapshot) return notFound(c, 'Remotion project not found')
  const body = await c.req.json().catch(() => null)
  if (!body || (!body.plan && !body.sheetManifest && !body.productionState)) {
    return badRequest(c, 'plan, sheetManifest or productionState required')
  }
  if (!snapshot.project.sourceEpisodeId) return badRequest(c, 'project has no source episode')
  const episodeId = snapshot.project.sourceEpisodeId
  const kind = body.kind || 'full'

  if (body.plan) {
    const mapped = mapSoundPlanDocument(body)
    const result = importNarrativePlan({
      episodeId,
      remotionProjectId: projectId,
      kind,
      ...mapped,
    })
    return success(c, result)
  }

  const planId = findPlanId(episodeId, kind)
  if (!planId) return notFound(c, 'narrative plan not found; import plan first')

  if (body.sheetManifest) {
    const sheets = (body.sheetManifest.sheets ?? []).map((sh: any) => ({
      sheetKey: sh.id,
      sequenceKey: sh.sequenceId ?? null,
      title: sh.sequenceTitle ?? null,
      imageUrl: typeof sh.imageUrl === 'string' ? sh.imageUrl.replace(/^\//, '') : null,
      panelKeys: sh.panelIds ?? [],
    }))
    return success(c, upsertSheets(planId, sheets))
  }

  const states = Object.entries(body.productionState.finals ?? {}).map(([panelKey, st]: [string, any]) => ({
    panelKey,
    genStatus: st.status ?? 'pending',
    generationId: st.generationId ?? null,
    taskId: st.taskId ?? null,
    prompt: st.prompt ?? null,
    finalPath: typeof st.localPath === 'string' ? st.localPath.replace(/^\//, '') : null,
    referenceMode: st.referenceMode ?? null,
    error: st.error ?? null,
  }))
  return success(c, applyPanelStates(planId, states))
})

// v8 叙事层级：单 panel 生产状态汇报
app.put('/projects/:id/narrative-panels/:panelKey', async (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  if (!snapshot) return notFound(c, 'Remotion project not found')
  const body = await c.req.json().catch(() => null)
  if (!body?.genStatus) return badRequest(c, 'genStatus required')
  if (!snapshot.project.sourceEpisodeId) return badRequest(c, 'project has no source episode')
  const result = updatePanelStatus({
    episodeId: snapshot.project.sourceEpisodeId,
    kind: body.kind,
    panelKey: c.req.param('panelKey'),
    genStatus: body.genStatus,
    generationId: body.generationId ?? null,
    taskId: body.taskId ?? null,
    prompt: body.prompt ?? null,
    finalPath: body.finalPath ?? null,
    referenceMode: body.referenceMode ?? null,
    error: body.error ?? null,
  })
  return result.updated ? success(c, result) : notFound(c, 'panel not found')
})

app.post('/projects/:id/narrative-storyboard-progress/monitor', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  if (!snapshot) return notFound(c, 'Remotion project not found')
  const progress = getNarrativeStoryboardProgress(projectId)
  if (!progress.available) return badRequest(c, `Project ${projectId} has no narrative storyboard production plan`)

  const task = createTask({
    type: 'remotion.narrative_storyboard.monitor',
    dramaId: snapshot.project.sourceDramaId,
    episodeId: snapshot.project.sourceEpisodeId,
    scopeType: 'remotion_project',
    scopeId: projectId,
    idempotencyKey: `remotion:narrative-storyboard:${projectId}:full-v2`,
    payload: { project_id: projectId, production_panels: progress.productionPanels },
    provider: progress.provider,
    maxAttempts: 1,
    priority: 20,
  })
  return created(c, task)
})

app.get('/projects/:id', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  return snapshot ? success(c, snapshot) : notFound(c, 'Remotion project not found')
})

app.get('/projects/:id/stages', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const stages = getRemotionStageRuns(projectId)
  return stages.length || getRemotionProjectSnapshot(projectId)
    ? success(c, stages)
    : notFound(c, 'Remotion project not found')
})

app.get('/projects/:id/assets', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  return snapshot ? success(c, getRemotionAssets(projectId)) : notFound(c, 'Remotion project not found')
})

app.get('/projects/:id/tasks', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  return snapshot ? success(c, listRemotionTasks(projectId)) : notFound(c, 'Remotion project not found')
})

app.get('/projects/:id/renders', (c) => {
  const projectId = projectIdFromParam(c.req.param('id'))
  if (!projectId) return badRequest(c, 'invalid project id')
  const snapshot = getRemotionProjectSnapshot(projectId)
  return snapshot ? success(c, snapshot.renders) : notFound(c, 'Remotion project not found')
})

export default app
