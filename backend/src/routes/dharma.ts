/**
 * 佛学/哲学口播管线（remotion-dharma-factory）的 HTTP 表面。
 *
 * 与 grid 管线的分工：grid.* 负责历史叙事（逐镜制作图 + 叙事层级），
 * dharma.* 负责佛学/哲学口播（三风格 AI 关键图 + 选择性动态视频 + 金句卡 + 单轨 BGM）。
 * 文稿导入/TTS/分镜仍复用 dramas import-script 链路，这里只新增：
 *   - 素材指派（footage）的读写
 *   - DharmaEpisode 渲染任务
 */
import { Hono, type Context } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, now } from '../utils/response.js'
import { createTask, getTask, listTasks, reconcileDharmaCommitClaim } from '../services/tasks/store.js'
import {
  createDharmaRenderPayload,
  dharmaRenderArtifactOutput,
  parseDharmaRenderPayload,
  resolveDharmaRenderArtifact,
  sameCanonicalDharmaRenderPayload,
  type DharmaRenderPayload,
} from '../services/dharma-render-payload.js'
import {
  TASK_CANCEL_ACTOR_MAX_LENGTH,
  TASK_CANCEL_REASON_MAX_LENGTH,
  type CreationTask,
  type DharmaCommitReconciliationResolution,
} from '../services/tasks/types.js'
import {
  areStoryboardNumbersContiguous,
  buildMasterTimeline,
  locateNarrationWindow,
  masterTimeAt,
  resolveStoryboardNarration,
} from '../services/grid-story-props.js'
import {
  canonicalDharmaAssetKey,
  buildDharmaEpisodeInputFingerprint,
  buildDharmaStockManifestIndex,
  compileDharmaProductionPlan,
  DHARMA_FULL_PLAN_VALIDATOR_VERSION,
  DHARMA_RENDERER_CONTRACT_VERSION,
  listDharmaStockAssets,
  DHARMA_EARLY_SACRED_ROLE_DEADLINE_MS,
  DHARMA_MAX_GENERATED_IMAGE_COVERAGE_RATIO,
  DHARMA_MIN_GENERATED_IMAGE_COVERAGE_RATIO,
  DHARMA_MIN_SACRED_VISUAL_COVERAGE_RATIO,
  DHARMA_MIN_VIDEO_COVERAGE_RATIO,
  DHARMA_VISUAL_ROLES,
  findAdjacentDharmaSegmentRoleMismatches,
  findNonAdjacentDharmaAssetReuse,
  formatDharmaAssetReuse,
  formatDharmaVisualRoleMismatches,
  isDharmaAssignedAssetAvailable,
  isDharmaPilotOutputAvailable,
  isDharmaReviewPilotOutputDuration,
  getDharmaPilotApprovalState,
  getDharmaPilotReview,
  normalizeDharmaQuoteText,
  normalizeDharmaVisualRole,
  normalizeDharmaVisualSemanticContract,
  parseDharmaCell,
  probeMediaDurationSec,
  resolveDharmaAssignedAssetPath,
  summarizeDharmaVisualPlan,
  validateDharmaCreativeProductionPlan,
  validateDharmaGeneratedImageOwnership,
  validateDharmaVideoProvenance,
  type DharmaCell,
  type DharmaNarrativeSemanticPlan,
  type DharmaShotFunction,
  type DharmaVisualRole,
} from '../services/dharma-props.js'
import {
  applyDharmaProductionPreflight,
  approveDharmaProductionGate,
  getDharmaProductionGate,
  scheduleDharmaCanary,
  setDharmaProductionGateMetadata,
} from '../services/dharma-production-gate.js'
import {
  getDharmaFormalRenderAdmission,
  isDharmaCanaryOutputAvailable,
} from '../services/dharma-production-admission.js'
import {
  DEFAULT_DHARMA_IMAGE_STYLE_ID,
  findDharmaImageStyle,
  listDharmaImageStyles,
  normalizeDharmaEmotion,
  normalizeDharmaImageMove,
  resolveDharmaImageStyle,
  resolveDharmaStyleForEmotion,
  snapshotDharmaImageStyle,
  validateDharmaStyleEmotion,
  type DharmaEmotion,
  type DharmaImageMove,
} from '../services/dharma-image-style.js'
import { parseAIConfigModels } from '../services/ai.js'

const app = new Hono()

interface FootageAssignment {
  storyboardId: number
  role: DharmaVisualRole
  emotion: DharmaEmotion
  styleId: string
  shotFunction?: DharmaShotFunction
  semantic?: DharmaNarrativeSemanticPlan
  theme?: string
  video?: DharmaCell['video']
  image?: DharmaCell['image']
  quote?: DharmaCell['quote'] | null
}

function activeRenderConflict(c: Context, taskId: number) {
  return c.json({
    code: 409,
    message: '该剧集已有不同参数的 Dharma 渲染任务正在进行；请等待或取消现有任务后再提交',
    data: { task_id: taskId },
  }, 409)
}

function reconciliationRequiredRenderConflict(c: Context, taskId: number) {
  return c.json({
    code: 409,
    message: '该剧集存在已跨过交付提交点但尚未完成对账的 Dharma 渲染；请先核对现有交付并完成 reconciliation，不能直接重渲',
    data: { task_id: taskId },
  }, 409)
}

function findPendingDharmaRenderReconciliation(episodeId: number) {
  return listTasks({ type: 'dharma.episode_render', episodeId }).find((task) => (
    task.status === 'stale'
    && task.commitClaimedAt !== null
    && task.errorCode === 'task_commit_claimed_reconciliation_required'
  )) ?? null
}

function hasValidTaskControlToken(c: Context) {
  const configured = process.env.TASK_CONTROL_TOKEN
  const supplied = c.req.header('x-task-control-token')
  if (!configured || !supplied) return false
  const configuredDigest = createHash('sha256').update(configured).digest()
  const suppliedDigest = createHash('sha256').update(supplied).digest()
  return timingSafeEqual(configuredDigest, suppliedDigest)
}

function parseRequiredControlText(body: Record<string, unknown>, field: string, maxLength: number) {
  const value = body[field]
  if (typeof value !== 'string') return { error: `${field} is required` }
  const normalized = value.trim()
  if (!normalized) return { error: `${field} is required` }
  if (normalized.length > maxLength) return { error: `${field} must not exceed ${maxLength} characters` }
  return { value: normalized }
}

type DharmaTaskArtifact = {
  output: string
  isPreview: boolean
  isReviewPilot: boolean
}

function resolveDharmaTaskArtifact(task: CreationTask): DharmaTaskArtifact | null {
  if (task.type !== 'dharma.episode_render' || task.episodeId === null) return null
  const plan = parseDharmaRenderPayload(task.payload, {
    mode: 'historical',
    expectedEpisodeId: task.episodeId,
  })
  if (!plan) return null
  const artifact = resolveDharmaRenderArtifact(task.episodeId, task.id, plan)
  return {
    output: dharmaRenderArtifactOutput(artifact),
    isPreview: artifact.isPreview,
    isReviewPilot: artifact.isReviewPilot,
  }
}

function pointerMatchesDharmaTaskArtifact(episode: typeof schema.episodes.$inferSelect, task: CreationTask, artifact: DharmaTaskArtifact) {
  if (artifact.isReviewPilot) {
    const pilot = getDharmaPilotReview(episode.metadata)
    return pilot?.taskId === task.id && pilot.output === artifact.output
  }
  return !artifact.isPreview && episode.videoUrl === artifact.output
}

class DharmaReconciliationConflictError extends Error {}

async function validateAssignment(
  body: any,
  index: number,
  manifestIndex: ReturnType<typeof buildDharmaStockManifestIndex>,
  durationProbes: Map<string, Promise<number | null>>,
): Promise<{ ok: true; value: FootageAssignment } | { ok: false; error: string }> {
  const storyboardId = Number(body?.storyboardId ?? body?.storyboard_id)
  if (!Number.isFinite(storyboardId) || storyboardId <= 0) {
    return { ok: false, error: `assignments[${index}]: storyboardId 无效` }
  }
  const videoSrc = body?.video?.src ? String(body.video.src) : ''
  const imageSrc = body?.image?.src ? String(body.image.src) : ''
  if ((videoSrc ? 1 : 0) + (imageSrc ? 1 : 0) !== 1) {
    return { ok: false, error: `assignments[${index}]: 必须且只能提供 video.src 或 image.src 之一` }
  }
  const role = normalizeDharmaVisualRole(body?.role)
  if ('error' in role) return { ok: false, error: `assignments[${index}]: ${role.error}` }
  const emotion = normalizeDharmaEmotion(body?.emotion)
  if ('error' in emotion) return { ok: false, error: `assignments[${index}]: ${emotion.error}` }
  const styleId = typeof body?.style_id === 'string'
    ? body.style_id.trim()
    : typeof body?.styleId === 'string'
      ? body.styleId.trim()
      : ''
  const style = findDharmaImageStyle(styleId)
  if (!style) return { ok: false, error: `assignments[${index}]: style_id 无效` }
  const styleError = validateDharmaStyleEmotion(style, emotion.emotion)
  if (styleError) return { ok: false, error: `assignments[${index}]: ${styleError}` }
  if (emotion.emotion === 'insight' && videoSrc) {
    return { ok: false, error: `assignments[${index}]: 顿悟段只能使用极简光影 AI 图片，不能使用视频` }
  }
  const semanticContract = normalizeDharmaVisualSemanticContract({
    role: role.role,
    kind: videoSrc ? 'video' : 'image',
    shotFunction: body?.shot_function ?? body?.shotFunction,
    semantic: body?.semantic,
  })
  if ('error' in semanticContract) {
    return { ok: false, error: `assignments[${index}]: ${semanticContract.error}` }
  }
  const src = videoSrc || imageSrc
  let absolutePath: string
  try {
    absolutePath = resolveDharmaAssignedAssetPath(src, videoSrc ? 'video' : 'image')
  } catch (error) {
    return { ok: false, error: `assignments[${index}]: ${error instanceof Error ? error.message : String(error)}` }
  }
  const value: FootageAssignment = {
    storyboardId,
    role: role.role,
    emotion: emotion.emotion,
    styleId: style.id,
    ...semanticContract,
    theme: body?.theme ? String(body.theme) : undefined,
  }
  if (videoSrc) {
    let durationProbe = durationProbes.get(absolutePath)
    if (!durationProbe) {
      durationProbe = probeMediaDurationSec(absolutePath)
      durationProbes.set(absolutePath, durationProbe)
    }
    const durationSec = await durationProbe
    if (durationSec === null) {
      return { ok: false, error: `assignments[${index}]: 无法读取视频时长：${src}` }
    }
    const stockProvenance = manifestIndex.get(absolutePath)?.[0]
    value.video = {
      src: videoSrc,
      ...(body.video.provider ? { provider: String(body.video.provider) } : stockProvenance ? { provider: stockProvenance.provider } : {}),
      ...(body.video.videoId ? { videoId: String(body.video.videoId) } : stockProvenance?.videoId ? { videoId: stockProvenance.videoId } : {}),
      ...(body.video.sourceUrl ? { sourceUrl: String(body.video.sourceUrl) } : stockProvenance ? { sourceUrl: stockProvenance.sourceUrl } : {}),
      ...(body.video.licenseUrl ? { licenseUrl: String(body.video.licenseUrl) } : stockProvenance ? { licenseUrl: stockProvenance.licenseUrl } : {}),
      ...(body.video.creator ? { creator: String(body.video.creator) } : stockProvenance ? { creator: stockProvenance.creator } : {}),
      // Do not accept a client-claimed duration. The render timing gate must
      // work from the source that is actually on disk.
      durationSec,
      ...(Number.isFinite(Number(body.video.sourceStartSec)) ? { sourceStartSec: Number(body.video.sourceStartSec) } : {}),
      ...(Number.isFinite(Number(body.video.focusX)) ? { focusX: Number(body.video.focusX) } : {}),
      ...(Number.isFinite(Number(body.video.focusY)) ? { focusY: Number(body.video.focusY) } : {}),
      ...(body.video.grade ? { grade: String(body.video.grade) } : {}),
    }
    const provenanceError = validateDharmaVideoProvenance(value.video, manifestIndex)
    if (provenanceError) return { ok: false, error: `assignments[${index}]: ${provenanceError}` }
  } else {
    const move = body?.image?.move === undefined
      ? { move: style.defaultMove }
      : normalizeDharmaImageMove(body.image.move)
    if ('error' in move) return { ok: false, error: `assignments[${index}]: ${move.error}` }
    if (emotion.emotion === 'insight' && move.move !== 'hold') {
      return { ok: false, error: `assignments[${index}]: 顿悟段必须使用 hold 运镜` }
    }
    value.image = {
      src: imageSrc,
      move: move.move,
    }
  }
  if (body?.quote && typeof body.quote.text === 'string' && body.quote.text.trim()) {
    const quote = normalizeDharmaQuoteText(body.quote.text)
    if ('error' in quote) return { ok: false, error: `assignments[${index}]: ${quote.error}` }
    value.quote = { text: quote.text, ...(body.quote.source ? { source: String(body.quote.source) } : {}) }
  } else if (body?.quote === null) {
    value.quote = null
  }
  return { ok: true, value }
}

function applyFootageAssignment(
  existing: DharmaCell | null,
  assignment: FootageAssignment,
  clearUnspecifiedQuote = false,
): DharmaCell {
  const assignedSrc = assignment.video?.src ?? assignment.image?.src
  const existingSrc = existing?.video?.src ?? existing?.image?.src
  const semanticMetadata = assignment.shotFunction
    ? {
        shotFunction: assignment.shotFunction,
        ...(assignment.semantic ? { semantic: assignment.semantic } : {}),
      }
    : assignedSrc === existingSrc && existing?.shotFunction
      ? {
          shotFunction: existing.shotFunction,
          ...(existing.semantic ? { semantic: existing.semantic } : {}),
        }
      : {}
  return {
    dharma: 1,
    role: assignment.role,
    emotion: assignment.emotion,
    styleId: assignment.styleId,
    ...semanticMetadata,
    ...(assignment.theme ? { theme: assignment.theme } : {}),
    ...(assignment.video ? { video: assignment.video } : {}),
    ...(assignment.image ? {
      image: {
        ...assignment.image,
        ...(existing?.image?.src === assignment.image.src
          && existing.image.generatedSegmentTaskId != null
          ? { generatedSegmentTaskId: existing.image.generatedSegmentTaskId }
          : {}),
      },
    } : {}),
    // quote 未提供时保留既有值；显式传 null 表示移除
    ...(assignment.quote !== undefined
      ? (assignment.quote ? { quote: assignment.quote } : {})
      : (!clearUnspecifiedQuote && existing?.quote ? { quote: existing.quote } : {})),
  }
}

function emptyDharmaVisualRoleCounts(): Record<DharmaVisualRole, number> {
  return {
    temple_interior: 0,
    ritual: 0,
    temple_exterior: 0,
    contemplative_nature: 0,
    human_relationship: 0,
  }
}

function activeDharmaGenerationConfigId(
  episode: typeof schema.episodes.$inferSelect,
  kind: 'image' | 'video',
): number | null {
  const configId = kind === 'image' ? episode.imageConfigId : episode.videoConfigId
  if (!Number.isInteger(configId) || !configId || configId <= 0) return null
  const [config] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, configId))
    .all()
  return config?.isActive && config.serviceType === kind ? config.id : null
}

/**
 * Read-only review status. It deliberately replays the same master-timeline
 * locator used by props construction rather than falling back to the estimated
 * storyboard duration field.
 */
function buildDharmaVisualPlanReview(
  episodeId: number,
  storyboards: Array<typeof schema.storyboards.$inferSelect>,
  preTtsTitlesJson: string | null,
) {
  const roleErrors: string[] = []
  const timingErrors: string[] = []
  const creativeErrors: string[] = []
  const roleCounts = emptyDharmaVisualRoleCounts()
  const rolesByStoryboardId = new Map<number, DharmaVisualRole>()
  const roleUses: Array<{
    storyboardNumber: number
    kind: 'video' | 'image'
    src: string
    role: DharmaVisualRole
    sourceKey: string
  }> = []

  for (const storyboard of storyboards) {
    const cell = parseDharmaCell(storyboard.gridCells)
    if (!cell) {
      roleErrors.push(`分镜 #${storyboard.storyboardNumber} 缺少 dharma 素材指派`)
      continue
    }
    const role = normalizeDharmaVisualRole(cell.role)
    if ('error' in role) {
      roleErrors.push(`分镜 #${storyboard.storyboardNumber} ${role.error}`)
      continue
    }
    const src = cell.video?.src ?? cell.image?.src
    if (!src) {
      roleErrors.push(`分镜 #${storyboard.storyboardNumber} 缺少素材路径`)
      continue
    }
    roleCounts[role.role] += 1
    rolesByStoryboardId.set(storyboard.id, role.role)
    roleUses.push({
      storyboardNumber: storyboard.storyboardNumber,
      kind: cell.video?.src ? 'video' : 'image',
      src,
      role: role.role,
      sourceKey: canonicalDharmaAssetKey(src),
    })
  }

  if (!roleErrors.length) {
    const mismatches = findAdjacentDharmaSegmentRoleMismatches(roleUses)
    if (mismatches.length) {
      roleErrors.push(
        `同一连续视频段落不能混用视觉角色：${formatDharmaVisualRoleMismatches(mismatches)}`,
      )
    }
  }

  const timeline = preTtsTitlesJson ? buildMasterTimeline(preTtsTitlesJson) : null
  if (!timeline) {
    timingErrors.push('TTS 主时间轴未就绪')
  }

  const windows: Array<{ startMs: number; endMs: number; role: DharmaVisualRole }> = []
  const creativeWindows: Array<{
    storyboardNumber: number
    startMs: number
    endMs: number
    cell: DharmaCell
  }> = []
  if (timeline) {
    let cursor = 0
    for (const storyboard of storyboards) {
      const narration = resolveStoryboardNarration(storyboard)
      if (!narration) continue
      const located = locateNarrationWindow(timeline, narration, cursor)
      if (!located) {
        timingErrors.push(`分镜 #${storyboard.storyboardNumber} 无法在 TTS 主时间轴定位`)
        break
      }
      cursor = located.cursor
      const role = rolesByStoryboardId.get(storyboard.id)
      if (!role) continue
      const cell = parseDharmaCell(storyboard.gridCells)
      if (!cell) continue
      const startMs = Math.round(masterTimeAt(timeline, located.start) * 1000)
      const endMs = Math.round(masterTimeAt(timeline, located.end) * 1000)
      if (!(endMs > startMs)) {
        timingErrors.push(`分镜 #${storyboard.storyboardNumber} 的 TTS 时序无效`)
        continue
      }
      windows.push({ startMs, endMs, role })
      creativeWindows.push({ storyboardNumber: storyboard.storyboardNumber, startMs, endMs, cell })
    }
  }

  const roleReady = roleErrors.length === 0
  const timingReady = timingErrors.length === 0 && windows.length > 0
  const summary = roleReady && timingReady ? summarizeDharmaVisualPlan(windows) : null
  const sacredCoverageReady = Boolean(summary && summary.sacredCoverageRatio >= DHARMA_MIN_SACRED_VISUAL_COVERAGE_RATIO)
  const earlySacredReady = Boolean(
    summary
    && summary.firstSacredStartOffsetMs !== null
    && summary.firstSacredStartOffsetMs <= DHARMA_EARLY_SACRED_ROLE_DEADLINE_MS,
  )
  let creativePlan: ReturnType<typeof validateDharmaCreativeProductionPlan> | null = null
  if (roleReady && timingReady) {
    try {
      const ownership = validateDharmaGeneratedImageOwnership(episodeId, storyboards)
      creativePlan = validateDharmaCreativeProductionPlan(creativeWindows, {
        verifiedGeneratedImageTaskIds: ownership.taskIds,
      })
    } catch (error) {
      creativeErrors.push(error instanceof Error ? error.message : String(error))
    }
  }
  const creativeReady = Boolean(creativePlan && creativeErrors.length === 0)
  const coverageMsByRole = summary?.coverageMsByRole ?? {
    temple_interior: 0,
    ritual: 0,
    temple_exterior: 0,
    contemplative_nature: 0,
    human_relationship: 0,
  }

  return {
    ready: roleReady && timingReady && sacredCoverageReady && earlySacredReady && creativeReady,
    role_ready: roleReady,
    timing_ready: timingReady,
    required_sacred_coverage_ratio: DHARMA_MIN_SACRED_VISUAL_COVERAGE_RATIO,
    sacred_coverage_ratio: summary?.sacredCoverageRatio ?? null,
    sacred_coverage_ready: sacredCoverageReady,
    early_sacred_deadline_sec: DHARMA_EARLY_SACRED_ROLE_DEADLINE_MS / 1000,
    early_sacred_start_sec: summary?.firstSacredStartOffsetMs === null || !summary
      ? null
      : summary.firstSacredStartOffsetMs / 1000,
    early_sacred_ready: earlySacredReady,
    creative_ready: creativeReady,
    emotional_style_ids: creativePlan?.styleIds ?? [],
    emotion_sequence: creativePlan?.emotionSequence ?? [],
    generated_image_segment_count: creativePlan?.generatedImageSegmentCount ?? 0,
    generated_image_segment_budget: creativePlan?.generatedImageSegmentBudget ?? null,
    generated_image_coverage_ratio: creativePlan?.generatedImageCoverageRatio ?? null,
    max_single_generated_image_coverage_ratio: creativePlan?.maxSingleGeneratedImageCoverageRatio ?? null,
    required_generated_image_coverage_ratio: {
      min: DHARMA_MIN_GENERATED_IMAGE_COVERAGE_RATIO,
      max: DHARMA_MAX_GENERATED_IMAGE_COVERAGE_RATIO,
    },
    video_coverage_ratio: creativePlan?.videoCoverageRatio ?? null,
    required_video_coverage_ratio: DHARMA_MIN_VIDEO_COVERAGE_RATIO,
    total_coverage_ms: summary?.totalCoverageMs ?? null,
    sacred_coverage_ms: summary?.sacredCoverageMs ?? null,
    roles: Object.fromEntries(DHARMA_VISUAL_ROLES.map((role) => [role, {
      storyboard_count: roleCounts[role],
      coverage_ms: coverageMsByRole[role],
    }])),
    errors: [...roleErrors, ...timingErrors, ...creativeErrors],
  }
}

// GET /dharma/stock-assets —— 供段落卡素材选择器使用的本地可指派 stock 素材。
app.get('/stock-assets', (c) => success(c, { items: listDharmaStockAssets() }))

// GET /dharma/image-styles —— 佛学图片生成的受控项目级风格目录。
app.get('/image-styles', (c) => success(c, {
  default_style_id: DEFAULT_DHARMA_IMAGE_STYLE_ID,
  items: listDharmaImageStyles().map(({ id, name, description, previewUrl, defaultMove, treatment, emotions, production }) => ({
    id,
    name,
    description,
    preview_url: previewUrl,
    default_move: defaultMove,
    treatment,
    emotions,
    production,
  })),
}))

// POST /dharma/episode/:episodeId/footage/generate —— 为一个连续视觉段落异步生成并自动回指素材。
app.post('/episode/:episodeId/footage/generate', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isInteger(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')
  const [episode] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!episode) return notFound(c, 'Episode not found')
  const [drama] = db.select().from(schema.dramas)
    .where(and(eq(schema.dramas.id, episode.dramaId), isNull(schema.dramas.deletedAt)))
    .all()
  if (!drama) return notFound(c, 'Drama not found')

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, 'generation body must be an object')
  }
  const request = body as Record<string, unknown>
  if (!Array.isArray(request.storyboard_ids) || !request.storyboard_ids.length) {
    return badRequest(c, 'storyboard_ids must be a non-empty array of positive integers')
  }
  const storyboardIds = request.storyboard_ids.map(Number).sort((a, b) => a - b)
  if (storyboardIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return badRequest(c, 'storyboard_ids must contain positive integers')
  }
  if (new Set(storyboardIds).size !== storyboardIds.length) return badRequest(c, 'storyboard_ids contains duplicates')
  const kind = request.kind
  if (kind !== 'image' && kind !== 'video') return badRequest(c, 'kind must be image or video')
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) return badRequest(c, 'prompt is required')
  const prompt = request.prompt.trim()
  if (prompt.length > 12_000) return badRequest(c, 'prompt must not exceed 12000 characters')

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
  const selected = storyboards.filter((storyboard) => storyboardIds.includes(storyboard.id))
  if (selected.length !== storyboardIds.length) return badRequest(c, 'unknown storyboardId for this episode')
  if (!areStoryboardNumbersContiguous(selected.map((storyboard) => storyboard.storyboardNumber))) {
    return badRequest(c, 'storyboard_ids must describe one contiguous visual segment')
  }

  let referenceImages: string[] = []
  if (request.reference_images !== undefined) {
    if (kind !== 'image') return badRequest(c, 'reference_images is only supported for image generation')
    if (!Array.isArray(request.reference_images) || request.reference_images.length > 3) {
      return badRequest(c, 'reference_images must be an array of at most 3 assigned Episode image paths')
    }
    referenceImages = Array.from(new Set(request.reference_images.map((value) => String(value ?? '').trim())))
    if (referenceImages.some((value) => !value)) {
      return badRequest(c, 'reference_images must contain non-empty image paths')
    }
    const assignedEpisodeImages = new Set(storyboards
      .map((storyboard) => parseDharmaCell(storyboard.gridCells)?.image?.src)
      .filter((src): src is string => Boolean(src)))
    for (const src of referenceImages) {
      if (!assignedEpisodeImages.has(src)) {
        return badRequest(c, `reference image must already be assigned in this Episode: ${src}`)
      }
      try {
        resolveDharmaAssignedAssetPath(src, 'image')
      } catch (err) {
        return badRequest(c, (err as Error).message)
      }
    }
  }

  const role = normalizeDharmaVisualRole(request.role)
  if ('error' in role) return badRequest(c, role.error)
  const emotion = normalizeDharmaEmotion(request.emotion)
  if ('error' in emotion) return badRequest(c, emotion.error)
  const requestedStyleId = typeof request.style_id === 'string' ? request.style_id.trim() : ''
  const style = requestedStyleId
    ? findDharmaImageStyle(requestedStyleId)
    : resolveDharmaStyleForEmotion(emotion.emotion)
  if (!style) return badRequest(c, 'style_id is unknown')
  const styleError = validateDharmaStyleEmotion(style, emotion.emotion)
  if (styleError) return badRequest(c, styleError)
  let imageMove: DharmaImageMove | undefined
  if (kind === 'image') {
    const move = request.move === undefined
      ? { move: style.defaultMove }
      : normalizeDharmaImageMove(request.move)
    if ('error' in move) return badRequest(c, move.error)
    imageMove = move.move
  }
  const semanticContract = normalizeDharmaVisualSemanticContract({
    role: role.role,
    kind,
    shotFunction: request.shot_function ?? request.shotFunction,
    semantic: request.semantic,
  })
  if ('error' in semanticContract) return badRequest(c, semanticContract.error)

  const configId = activeDharmaGenerationConfigId(episode, kind)
  if (!configId) {
    return badRequest(c, `${kind === 'image' ? '图片' : '视频'}生成配置不存在、未启用或未绑定到当前 Episode`)
  }
  const [generationConfig] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, configId))
    .all()
  const requestedModel = typeof request.model === 'string' ? request.model.trim() : ''
  if (requestedModel && !parseAIConfigModels(generationConfig?.model).includes(requestedModel)) {
    return badRequest(c, `model ${requestedModel} is not configured for the Episode ${kind} service`)
  }
  const styleSnapshot = kind === 'image' ? snapshotDharmaImageStyle(style) : undefined
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      kind,
      prompt,
      storyboard_ids: storyboardIds,
      config_id: configId,
      model: requestedModel || undefined,
      role: role.role,
      emotion: emotion.emotion,
      style_id: style.id,
      style_snapshot: styleSnapshot,
      move: imageMove,
      reference_images: referenceImages,
      shot_function: semanticContract.shotFunction,
      semantic: semanticContract.semantic,
    }))
    .digest('hex')
    .slice(0, 24)
  const task = createTask({
    type: 'dharma.footage_generate',
    dramaId: episode.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `dharma.footage_generate:${episodeId}:${fingerprint}`,
    payload: {
      episode_id: episodeId,
      storyboard_ids: storyboardIds,
      kind,
      prompt,
      config_id: configId,
      ...(requestedModel ? { model: requestedModel } : {}),
      role: role.role,
      emotion: emotion.emotion,
      style_id: style.id,
      ...(styleSnapshot ? { style_snapshot: styleSnapshot } : {}),
      ...(imageMove ? { move: imageMove } : {}),
      ...(referenceImages.length ? { reference_images: referenceImages } : {}),
      ...(semanticContract.shotFunction ? { shot_function: semanticContract.shotFunction } : {}),
      ...(semanticContract.semantic ? { semantic: semanticContract.semantic } : {}),
    },
    maxAttempts: 2,
  })
  return success(c, { task_id: task.id })
})

// POST /dharma/episode/:episodeId/footage —— 素材指派（ upsert 到 storyboards.grid_cells ）
app.post('/episode/:episodeId/footage', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')

  const [ep] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!ep) return notFound(c, 'Episode not found')

  const body = await c.req.json().catch(() => ({} as any))
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, 'footage body must be an object')
  }
  const rawAssignments = Array.isArray((body as any).assignments) ? (body as any).assignments : null
  if (!rawAssignments?.length) return badRequest(c, 'assignments is required (non-empty array)')

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()
  const byId = new Map(storyboards.map((sb) => [sb.id, sb]))

  const parsed: FootageAssignment[] = []
  const parsedByStoryboardId = new Map<number, FootageAssignment>()
  const manifestIndex = buildDharmaStockManifestIndex()
  const durationProbes = new Map<string, Promise<number | null>>()
  for (let i = 0; i < rawAssignments.length; i++) {
    const result = await validateAssignment(rawAssignments[i], i, manifestIndex, durationProbes)
    if (!result.ok) return badRequest(c, result.error)
    if (!byId.has(result.value.storyboardId)) {
      return badRequest(c, `assignments[${i}]: storyboard ${result.value.storyboardId} 不属于 Episode ${episodeId}`)
    }
    if (parsedByStoryboardId.has(result.value.storyboardId)) {
      return badRequest(c, `assignments[${i}]: storyboard ${result.value.storyboardId} 在同一请求中重复出现`)
    }
    parsed.push(result.value)
    parsedByStoryboardId.set(result.value.storyboardId, result.value)
  }

  // A complete assignment payload is a new visual plan, so stale quotes must
  // not silently survive it. Partial edits retain the documented patch
  // semantics unless quote: null is supplied.
  const replacesEveryStoryboard = parsedByStoryboardId.size === storyboards.length

  // Validate the complete post-request episode before committing anything.
  // Partial requests must not be able to introduce a duplicate by relying on
  // an older assignment outside the request body.
  const plannedCells = storyboards.map((sb) => {
    const assignment = parsedByStoryboardId.get(sb.id)
    return {
      storyboardNumber: sb.storyboardNumber,
      cell: assignment
        ? applyFootageAssignment(parseDharmaCell(sb.gridCells), assignment, replacesEveryStoryboard)
        : parseDharmaCell(sb.gridCells),
    }
  })
  const plannedRoleUses = [] as Array<{
    storyboardNumber: number
    kind: 'video' | 'image'
    src: string
    role: DharmaVisualRole
    sourceKey: string
  }>
  for (const { storyboardNumber, cell } of plannedCells) {
    if (!cell) continue
    const role = normalizeDharmaVisualRole(cell.role)
    if ('error' in role) return badRequest(c, `分镜 #${storyboardNumber}: ${role.error}`)
    const src = cell.video?.src ?? cell.image?.src
    if (!src) continue
    plannedRoleUses.push({
      storyboardNumber,
      kind: cell.video?.src ? 'video' : 'image',
      src,
      role: role.role,
      sourceKey: canonicalDharmaAssetKey(src),
    })
  }
  const roleMismatches = findAdjacentDharmaSegmentRoleMismatches(plannedRoleUses)
  if (roleMismatches.length) {
    return badRequest(
      c,
      `同一连续视频段落不能混用视觉角色：${formatDharmaVisualRoleMismatches(roleMismatches)}。` +
      '相邻且同源的视频会合并为一个画面，请为整个段落指定同一角色',
    )
  }
  const reuse = findNonAdjacentDharmaAssetReuse(plannedCells.flatMap(({ storyboardNumber, cell }) => {
    if (!cell) return []
    const src = cell.video?.src ?? cell.image?.src
    if (!src) return []
    return [{
      storyboardNumber,
      kind: cell.video?.src ? 'video' as const : 'image' as const,
      src,
      sourceKey: canonicalDharmaAssetKey(src),
      ...(cell.image?.generatedSegmentTaskId != null
        ? { generatedSegmentTaskId: cell.image.generatedSegmentTaskId }
        : {}),
    }]
  }))
  if (reuse.length) {
    return badRequest(
      c,
      `同一素材不能在不同视觉段落重复使用：${formatDharmaAssetReuse(reuse)}。相邻分镜可共用同一素材作为一个段落`,
    )
  }

  try {
    validateDharmaGeneratedImageOwnership(
      episodeId,
      plannedCells.map(({ storyboardNumber, cell }) => ({
        ...storyboards.find((storyboard) => storyboard.storyboardNumber === storyboardNumber)!,
        gridCells: cell ? JSON.stringify(cell) : null,
      })),
    )
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }

  db.transaction((tx) => {
    for (const assignment of parsed) {
      const sb = byId.get(assignment.storyboardId)!
      const cell = applyFootageAssignment(parseDharmaCell(sb.gridCells), assignment, replacesEveryStoryboard)
      tx.update(schema.storyboards)
        .set({ gridCells: JSON.stringify(cell), updatedAt: now() })
        .where(eq(schema.storyboards.id, assignment.storyboardId))
        .run()
    }
  })

  return success(c, { updated: parsed.length })
})

// GET /dharma/episode/:episodeId/footage —— 素材指派现状（审查面）
app.get('/episode/:episodeId/footage', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')

  const [ep] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!ep) return badRequest(c, 'Episode not found')
  const [drama] = db.select().from(schema.dramas)
    .where(and(eq(schema.dramas.id, ep.dramaId), isNull(schema.dramas.deletedAt)))
    .all()

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const items = storyboards.map((sb) => {
    const cell = parseDharmaCell(sb.gridCells)
    const src = cell?.video?.src ?? cell?.image?.src ?? null
    return {
      storyboard_id: sb.id,
      storyboard_number: sb.storyboardNumber,
      narration: sb.narration || sb.description || '',
      duration: sb.duration,
      assigned: Boolean(cell),
      role: cell?.role ?? null,
      emotion: cell?.emotion ?? null,
      style_id: cell?.styleId ?? null,
      shot_function: cell?.shotFunction ?? null,
      semantic: cell?.semantic ?? null,
      theme: cell?.theme ?? null,
      kind: cell?.video?.src ? 'video' : cell?.image?.src ? 'image' : null,
      src,
      file_exists: src && cell
        ? isDharmaAssignedAssetAvailable(src, cell.video?.src ? 'video' : 'image')
        : false,
      video: cell?.video ?? null,
      image: cell?.image ?? null,
      quote: cell?.quote ?? null,
    }
  })
  const assetReuseViolations = findNonAdjacentDharmaAssetReuse(items.flatMap((item) => {
    if (!item.src || !item.kind) return []
    return [{
      storyboardNumber: item.storyboard_number,
      kind: item.kind === 'video' ? 'video' as const : 'image' as const,
      src: item.src,
      sourceKey: canonicalDharmaAssetKey(item.src),
      ...(item.image?.generatedSegmentTaskId != null
        ? { generatedSegmentTaskId: item.image.generatedSegmentTaskId }
        : {}),
    }]
  }))
  const pilotApproval = getDharmaPilotApprovalState(episodeId)
  const productionAdmission = getDharmaFormalRenderAdmission(episodeId)
  const visualPlan = buildDharmaVisualPlanReview(episodeId, storyboards, ep.preTtsTitlesJson)

  return success(c, {
    episode_id: episodeId,
    drama_id: ep.dramaId,
    image_style: resolveDharmaImageStyle(drama?.style).id,
    bgm_audio_url: ep.bgmAudioUrl ?? null,
    pre_tts_ready: Boolean(ep.preTtsAudioUrl && ep.preTtsTitlesJson),
    video_url: ep.videoUrl ?? null,
    assigned_count: items.filter((i) => i.assigned).length,
    total: items.length,
    asset_reuse_ready: assetReuseViolations.length === 0,
    asset_reuse_violations: assetReuseViolations,
    visual_plan: visualPlan,
    pilot_review: pilotApproval.pilot,
    pilot_approval: {
      approved: pilotApproval.approved,
      ...(pilotApproval.reason ? { reason: pilotApproval.reason } : {}),
    },
    production_gate: productionAdmission.gate,
    production_admission: productionAdmission.admission,
    items,
  })
})

// POST /dharma/episode/:episodeId/preflight — compile every render input without proxying or rendering.
app.post('/episode/:episodeId/preflight', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')
  const [episode] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!episode) return notFound(c, 'Episode not found')

  let compiled
  try {
    compiled = await compileDharmaProductionPlan(episodeId)
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
  if (buildDharmaEpisodeInputFingerprint(episodeId) !== compiled.fullPlanFingerprint) {
    return c.json({ code: 409, message: '全片输入在预检提交前发生变化；请重新预检' }, 409)
  }

  const existing = getDharmaProductionGate(episode.metadata)
  const validatedAt = now()
  const gate = applyDharmaProductionPreflight(existing, {
    fullPlanFingerprint: compiled.fullPlanFingerprint,
    validatorVersion: DHARMA_FULL_PLAN_VALIDATOR_VERSION,
    rendererContractVersion: DHARMA_RENDERER_CONTRACT_VERSION,
    report: compiled.report,
    validatedAt,
    canary: compiled.canary,
  })
  const update = db.update(schema.episodes).set({
    metadata: setDharmaProductionGateMetadata(episode.metadata, gate),
    updatedAt: validatedAt,
  }).where(and(
    eq(schema.episodes.id, episodeId),
    isNull(schema.episodes.deletedAt),
    eq(schema.episodes.dharmaInputRevision, compiled.episode.dharmaInputRevision),
  )).run()
  if (update.changes !== 1) return c.json({ code: 409, message: '全片输入在预检期间发生变化；请重新预检' }, 409)
  return success(c, { episode_id: episodeId, production_gate: gate })
})

// POST /dharma/episode/:episodeId/review/approve — approve the exact current plan and review evidence.
app.post('/episode/:episodeId/review/approve', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(c, 'approval body must be an object')
  const request = body as Record<string, unknown>
  const fullPlanFingerprint = parseRequiredControlText(request, 'fullPlanFingerprint', 128)
  if ('error' in fullPlanFingerprint) return badRequest(c, fullPlanFingerprint.error)
  const actor = parseRequiredControlText(request, 'actor', TASK_CANCEL_ACTOR_MAX_LENGTH)
  if ('error' in actor) return badRequest(c, actor.error)
  const reason = parseRequiredControlText(request, 'reason', TASK_CANCEL_REASON_MAX_LENGTH)
  if ('error' in reason) return badRequest(c, reason.error)

  const [episode] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!episode) return notFound(c, 'Episode not found')
  const gate = getDharmaProductionGate(episode.metadata)
  if (!gate) return badRequest(c, '尚未完成全片生产预检')
  const current = getDharmaFormalRenderAdmission(episodeId)
  if (current.currentFullPlanFingerprint !== fullPlanFingerprint.value
    || gate.fullPlan.fingerprint !== fullPlanFingerprint.value) {
    return badRequest(c, '全片输入已变化或审批指纹不匹配；请重新预检')
  }

  let canaryFingerprint: string | undefined
  if (gate.canary.requirement === 'required') {
    const parsedCanaryFingerprint = parseRequiredControlText(request, 'canaryFingerprint', 128)
    if ('error' in parsedCanaryFingerprint) return badRequest(c, parsedCanaryFingerprint.error)
    canaryFingerprint = parsedCanaryFingerprint.value
    if (current.currentCanaryFingerprint !== canaryFingerprint
      || gate.canary.fingerprint !== canaryFingerprint) {
      return badRequest(c, 'canary 输入已变化或审批指纹不匹配；请重新生成 canary')
    }
    if (!isDharmaCanaryOutputAvailable(gate.canary.output)) {
      return badRequest(c, 'canary 输出文件不存在；请恢复或重新生成')
    }
  }

  const approvedAt = now()
  let approved
  try {
    approved = approveDharmaProductionGate(gate, {
      fullPlanFingerprint: fullPlanFingerprint.value,
      ...(canaryFingerprint ? { canaryFingerprint } : {}),
      actor: actor.value,
      reason: reason.value,
      approvedAt,
    })
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : String(error))
  }
  const update = db.update(schema.episodes).set({
    metadata: setDharmaProductionGateMetadata(episode.metadata, approved),
    updatedAt: approvedAt,
  }).where(and(
    eq(schema.episodes.id, episodeId),
    isNull(schema.episodes.deletedAt),
    eq(schema.episodes.updatedAt, episode.updatedAt),
  )).run()
  if (update.changes !== 1) return c.json({ code: 409, message: '审批期间生产状态发生变化；请刷新后重试' }, 409)
  return success(c, { episode_id: episodeId, production_gate: approved })
})

// POST /dharma/episode/:episodeId/canary — render only the server-selected risk window.
app.post('/episode/:episodeId/canary', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')
  const body = await c.req.json().catch(() => ({}))
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
    return badRequest(c, 'canary body must be an empty object; the server selects the risk window')
  }
  const [episode] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!episode) return notFound(c, 'Episode not found')
  const gate = getDharmaProductionGate(episode.metadata)
  if (!gate) return badRequest(c, '尚未完成全片生产预检')
  if (gate.canary.requirement !== 'required' || !gate.canary.window || !gate.canary.fingerprint) {
    return badRequest(c, '当前全片预检未要求风险 canary；可直接审批生产计划')
  }
  const current = getDharmaFormalRenderAdmission(episodeId)
  if (current.currentFullPlanFingerprint !== gate.fullPlan.fingerprint) {
    return badRequest(c, '全片输入已变化；请重新预检')
  }
  if (current.currentCanaryFingerprint !== gate.canary.fingerprint) {
    return badRequest(c, 'canary 风险窗口输入已变化；请重新预检')
  }
  if ((gate.canary.status === 'rendered' || gate.canary.status === 'approved') && gate.canary.taskId) {
    return success(c, {
      task_id: gate.canary.taskId,
      preview: true,
      review_kind: 'canary',
      output: gate.canary.output ?? null,
    })
  }

  const requestedPayload = createDharmaRenderPayload(episodeId, {
    onlyStoryboardIds: gate.canary.window.storyboardIds,
    maxDurationSec: gate.canary.window.durationSec,
    reviewKind: 'canary',
  })
  if (gate.canary.taskId) {
    const previous = getTask(gate.canary.taskId)
    if (previous && (previous.status === 'queued' || previous.status === 'running')) {
      if (!sameCanonicalDharmaRenderPayload(previous.payload, requestedPayload)) {
        return activeRenderConflict(c, previous.id)
      }
      return success(c, { task_id: previous.id, preview: true, review_kind: 'canary' })
    }
    if (previous?.status === 'succeeded' || previous?.commitClaimedAt) {
      return c.json({ code: 409, message: 'canary 任务已完成但审查指针未确认；请先核对任务交付状态' }, 409)
    }
  }
  const pendingReconciliation = findPendingDharmaRenderReconciliation(episodeId)
  if (pendingReconciliation) return reconciliationRequiredRenderConflict(c, pendingReconciliation.id)
  const active = listTasks({ type: 'dharma.episode_render', episodeId, activeOnly: true })[0]
  if (active && !sameCanonicalDharmaRenderPayload(active.payload, requestedPayload)) return activeRenderConflict(c, active.id)

  const task = createTask({
    type: 'dharma.episode_render',
    dramaId: episode.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `dharma.episode_render:${episodeId}`,
    payload: requestedPayload,
  })
  if (!sameCanonicalDharmaRenderPayload(task.payload, requestedPayload)) return activeRenderConflict(c, task.id)
  let scheduled
  try {
    scheduled = scheduleDharmaCanary(gate, {
      taskId: task.id,
      fullPlanFingerprint: current.currentFullPlanFingerprint,
      canaryFingerprint: current.currentCanaryFingerprint,
    })
  } catch (error) {
    return c.json({ code: 409, message: error instanceof Error ? error.message : String(error) }, 409)
  }
  const scheduledAt = now()
  const update = db.update(schema.episodes).set({
    metadata: setDharmaProductionGateMetadata(episode.metadata, scheduled),
    updatedAt: scheduledAt,
  }).where(and(
    eq(schema.episodes.id, episodeId),
    isNull(schema.episodes.deletedAt),
    eq(schema.episodes.updatedAt, episode.updatedAt),
  )).run()
  if (update.changes !== 1) return c.json({ code: 409, message: 'canary 调度期间生产状态发生变化；请刷新后重试' }, 409)
  return success(c, { task_id: task.id, preview: true, review_kind: 'canary' })
})

// POST /dharma/episode/:episodeId/pilot/approve —— 人工试听/审画后显式放行整集
app.post('/episode/:episodeId/pilot/approve', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')
  const [episode] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!episode) return notFound(c, 'Episode not found')

  const pilot = getDharmaPilotReview(episode.metadata)
  if (!pilot || pilot.status !== 'rendered') return badRequest(c, '没有可审核的 pilot；先完成 60 秒 pilot 渲染')
  const inputFingerprint = buildDharmaEpisodeInputFingerprint(episodeId)
  if (pilot.inputFingerprint !== inputFingerprint) {
    return badRequest(c, 'pilot 对应的素材、旁白、BGM 或标题已变化；请重新试渲后再审核')
  }
  if (!isDharmaReviewPilotOutputDuration(pilot.durationSec)) {
    return badRequest(c, 'pilot 实际输出不是精确 60 秒；请重新试渲后再审核')
  }
  if (!isDharmaPilotOutputAvailable(pilot.output)) return badRequest(c, 'pilot 输出文件不存在；请重新试渲')

  let metadata: Record<string, unknown> = {}
  try {
    const parsed = episode.metadata ? JSON.parse(episode.metadata) : {}
    if (parsed && typeof parsed === 'object') metadata = parsed
  } catch { /* reset malformed legacy metadata */ }
  const approvedAt = now()
  metadata.dharmaPilot = { ...pilot, status: 'approved', approvedAt }
  const approvalUpdate = db.update(schema.episodes)
    .set({ metadata: JSON.stringify(metadata), updatedAt: approvedAt })
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .run()
  if (approvalUpdate.changes !== 1) return notFound(c, 'Episode not found')
  return success(c, { episode_id: episodeId, approved_at: approvedAt, input_fingerprint: inputFingerprint })
})

// POST /dharma/episode/:episodeId/render/:taskId/reconcile — resolve a stale claimed delivery after manual inspection.
app.post('/episode/:episodeId/render/:taskId/reconcile', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  const taskId = Number(c.req.param('taskId'))
  if (!Number.isInteger(episodeId) || episodeId <= 0 || !Number.isInteger(taskId) || taskId <= 0) {
    return badRequest(c, 'invalid episodeId or taskId')
  }
  if (!hasValidTaskControlToken(c)) {
    return c.json({ code: 403, message: 'Task control token is required to reconcile a Dharma delivery' }, 403)
  }

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(c, 'reconciliation body must be an object')
  const request = body as Record<string, unknown>
  const resolution = request.resolution
  if (resolution !== 'retain_published' && resolution !== 'discard_unpublished') {
    return badRequest(c, 'resolution must be retain_published or discard_unpublished')
  }
  const reason = parseRequiredControlText(request, 'reason', TASK_CANCEL_REASON_MAX_LENGTH)
  if ('error' in reason) return badRequest(c, reason.error)
  const actor = parseRequiredControlText(request, 'actor', TASK_CANCEL_ACTOR_MAX_LENGTH)
  if ('error' in actor) return badRequest(c, actor.error)
  const confirmation = parseRequiredControlText(request, 'confirmation', 128)
  if ('error' in confirmation) return badRequest(c, confirmation.error)
  if (confirmation.value !== `RECONCILE ${taskId}`) return badRequest(c, `confirmation must exactly equal RECONCILE ${taskId}`)

  const task = getTask(taskId)
  if (!task || task.type !== 'dharma.episode_render' || task.episodeId !== episodeId) {
    return c.json({ code: 404, message: 'Dharma render task not found for this episode' }, 404)
  }
  const artifact = resolveDharmaTaskArtifact(task)
  if (!artifact) return badRequest(c, 'Dharma render task has an invalid immutable artifact identity')

  let reconciliation
  try {
    reconciliation = reconcileDharmaCommitClaim(taskId, {
      episodeId,
      resolution: resolution as DharmaCommitReconciliationResolution,
      reason: reason.value,
      actor: actor.value,
      expectedOutput: artifact.output,
      validate: (tx, currentTask) => {
        const [episode] = tx.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
        if (!episode) throw new DharmaReconciliationConflictError('Episode no longer exists')
        const pointerMatchesOutput = pointerMatchesDharmaTaskArtifact(episode, currentTask, artifact)
        if (resolution === 'retain_published' && !pointerMatchesOutput) {
          throw new DharmaReconciliationConflictError('Current episode delivery pointer does not match this claimed task artifact')
        }
        if (resolution === 'discard_unpublished' && pointerMatchesOutput) {
          throw new DharmaReconciliationConflictError('Current episode delivery pointer still references this task artifact; retain it or repair the pointer before discarding')
        }
        return pointerMatchesOutput
      },
    })
  } catch (error) {
    if (error instanceof DharmaReconciliationConflictError) {
      return c.json({ code: 409, message: error.message }, 409)
    }
    throw error
  }

  if (reconciliation.outcome === 'not_found') return c.json({ code: 404, message: 'Dharma render task not found' }, 404)
  if (reconciliation.outcome !== 'reconciled' || !reconciliation.task) {
    return c.json({ code: 409, message: 'Dharma render task is not awaiting commit reconciliation' }, 409)
  }
  return success(c, {
    task_id: taskId,
    resolution,
    expected_output: artifact.output,
    status: 'reconciled',
  })
})

// POST /dharma/episode/:episodeId/render —— DharmaEpisode 合成整集 mp4
app.post('/episode/:episodeId/render', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')

  const [ep] = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!ep) return notFound(c, 'Episode not found')

  const body = await c.req.json().catch(() => ({} as any))
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequest(c, 'render body must be an object')
  }
  const hasOnlyStoryboardIds = Object.prototype.hasOwnProperty.call(body, 'onlyStoryboardIds')
  if (hasOnlyStoryboardIds && !Array.isArray((body as any).onlyStoryboardIds)) {
    return badRequest(c, 'onlyStoryboardIds must be a non-empty array of positive integers')
  }
  if (hasOnlyStoryboardIds && !(body as any).onlyStoryboardIds.length) {
    return badRequest(c, 'onlyStoryboardIds must not be empty; omit it for a full render')
  }
  const rawOnlyIds = hasOnlyStoryboardIds
    ? (body as any).onlyStoryboardIds.map(Number)
    : undefined
  if (rawOnlyIds?.some((id: number) => !Number.isInteger(id) || id <= 0)) {
    return badRequest(c, 'onlyStoryboardIds must contain positive integers')
  }
  if (rawOnlyIds && new Set(rawOnlyIds).size !== rawOnlyIds.length) return badRequest(c, 'onlyStoryboardIds contains duplicates')
  const onlyIds = rawOnlyIds ? [...rawOnlyIds].sort((a, b) => a - b) : undefined
  const hasMaxDurationSec = Object.prototype.hasOwnProperty.call(body, 'maxDurationSec')
  const maxDurationSec = Number((body as any).maxDurationSec)
  if (hasMaxDurationSec && (!Number.isFinite(maxDurationSec) || maxDurationSec <= 0)) {
    return badRequest(c, 'maxDurationSec must be a positive finite number')
  }
  if (onlyIds?.length) {
    const selectedNumbers = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
      .filter((sb) => onlyIds.includes(sb.id))
      .map((sb) => sb.storyboardNumber)
    if (selectedNumbers.length !== new Set(onlyIds).size) return badRequest(c, 'unknown storyboardId')
    if (!areStoryboardNumbersContiguous(selectedNumbers)) {
      return badRequest(c, 'non-contiguous storyboard render would skip narration')
    }
  }

  const requestedPayload: DharmaRenderPayload = createDharmaRenderPayload(episodeId, {
    onlyStoryboardIds: onlyIds,
    ...(hasMaxDurationSec ? { maxDurationSec } : {}),
  })
  const isPreview = Boolean(requestedPayload.only_storyboard_ids?.length || requestedPayload.max_duration_sec)
  const pendingReconciliation = findPendingDharmaRenderReconciliation(episodeId)
  if (pendingReconciliation) return reconciliationRequiredRenderConflict(c, pendingReconciliation.id)
  const active = listTasks({ type: 'dharma.episode_render', episodeId, activeOnly: true })[0]
  if (active && !sameCanonicalDharmaRenderPayload(active.payload, requestedPayload)) return activeRenderConflict(c, active.id)

  if (!isPreview) {
    const productionAdmission = getDharmaFormalRenderAdmission(episodeId)
    if (!productionAdmission.admission.allowed) {
      return badRequest(c, `整集渲染未通过生产门禁：${productionAdmission.admission.reason}`)
    }
  }

  const task = createTask({
    type: 'dharma.episode_render',
    dramaId: ep.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    // One active Dharma render owns an episode. The post-create payload check
    // below also handles concurrent requests that raced the pre-check.
    idempotencyKey: `dharma.episode_render:${episodeId}`,
    payload: requestedPayload,
  })
  if (!sameCanonicalDharmaRenderPayload(task.payload, requestedPayload)) return activeRenderConflict(c, task.id)
  return success(c, { task_id: task.id, preview: isPreview })
})

export default app
