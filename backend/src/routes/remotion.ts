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

const app = new Hono()

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
