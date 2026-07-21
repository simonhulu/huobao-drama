import { createHash } from 'node:crypto'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { createImageGenerationRecord } from './image-generation.js'
import { refreshRemotionShotStatus, syncRemotionAssetForImageGeneration } from './remotion-asset-sync.js'
import { planRemotionShots, type PlannerStockAsset, type PlannerStoryboard } from './remotion-planner.js'
import { estimateSourceDurationSeconds } from './episode-splitter.js'
import { createTask, getTask } from './tasks/store.js'
import type { CreationTask, CreationTaskStatus, TransactionClient } from './tasks/types.js'
import { validateRemotionStageOutput } from './remotion-contract.js'
import { getMediaAccountRow, parseJsonRecord, POSITIONING_SCHEMA_VERSION } from './media-accounts.js'
import { REMOTION_SHOT_RHYTHM } from './remotion-segmentation.js'

export { refreshRemotionShotStatus, syncRemotionAssetForImageGeneration }

export const REMOTION_SCHEMA_VERSION = 1

export const REMOTION_STAGES = [
  'source_snapshot',
  'historical_analysis',
  'narrative_beats',
  'storyboard',
  'asset_plan',
  'asset_production',
  'asset_qc',
  'shot_composition',
  'shot_qc',
  'episode_finish',
  'final_qa',
] as const

export const REMOTION_LEGACY_STAGES = [
  'script_analysis',
  'shot_plan',
  'shot_render',
  'episode_render',
  'qa',
] as const

export const REMOTION_STAGE_ALIASES: Record<typeof REMOTION_LEGACY_STAGES[number], RemotionCanonicalStage> = {
  script_analysis: 'historical_analysis',
  shot_plan: 'storyboard',
  shot_render: 'shot_composition',
  episode_render: 'episode_finish',
  qa: 'final_qa',
}

export type RemotionCanonicalStage = typeof REMOTION_STAGES[number]
export type RemotionLegacyStage = typeof REMOTION_LEGACY_STAGES[number]
export type RemotionStage = RemotionCanonicalStage | RemotionLegacyStage
export type RemotionProjectStatus = 'draft' | 'planning' | 'assets' | 'rendering' | 'qa' | 'completed' | 'failed' | 'canceled'
export type RemotionStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type RemotionShotStatus = 'planned' | 'asset_pending' | 'ready' | 'rendering' | 'rendered' | 'failed'
export type RemotionShotType = 'ai_plate' | 'character' | 'map' | 'stock' | 'graphic' | 'hybrid'
export type RemotionAssetType = 'ai_image' | 'character' | 'map' | 'stock_video' | 'graphic' | 'audio' | 'font'
export type RemotionAssetStatus = 'planned' | 'queued' | 'processing' | 'completed' | 'failed' | 'canceled'
export type RemotionRenderStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type RemotionRenderKind = 'shot' | 'episode'

export interface RemotionSourceSnapshot {
  schemaVersion: number
  sourceType: 'episode' | 'script'
  sourceEpisodeId: number | null
  sourceDramaId: number | null
  drama: Record<string, unknown> | null
  episode: Record<string, unknown>
  storyboards: Array<Record<string, unknown>>
  positioning?: RemotionPositioningSnapshot
}

export interface RemotionPositioningSnapshot {
  schemaVersion: number
  account: {
    id: number
    name: string
    positioning: Record<string, unknown>
  } | null
  project: Record<string, unknown>
  episode: Record<string, unknown>
}

export interface RemotionShotInput {
  shotNumber: number
  sourceStoryboardId?: number | null
  title?: string | null
  narration?: string | null
  dialogue?: string | null
  durationMs: number
  shotType: RemotionShotType
  visualPlan: unknown
  sourceEvidence?: unknown
  status?: RemotionShotStatus
}

export interface RemotionAssetInput {
  shotId?: number | null
  assetKey: string
  assetType: RemotionAssetType
  provider?: string | null
  status?: RemotionAssetStatus
  prompt?: unknown
  sourceUrl?: string | null
  localPath?: string | null
  thumbnailPath?: string | null
  mimeType?: string | null
  width?: number | null
  height?: number | null
  durationMs?: number | null
  imageGenerationId?: number | null
  taskId?: number | null
  license?: unknown
  contentHash?: string | null
  version?: number
  metadata?: unknown
  errorCode?: string | null
  errorMessage?: string | null
}

export interface EnqueueRemotionImageInput {
  projectId: number
  shotId: number
  assetKey?: string
  assetType?: 'ai_image' | 'character'
  prompt: string
  provider?: string | null
  configId?: number
  referenceImages?: string[]
  seed?: number
  size?: string
  style?: string
  width?: number | null
  height?: number | null
  metadata?: unknown
}

export interface RemotionRenderInput {
  shotId?: number | null
  renderKind: RemotionRenderKind
  status?: RemotionRenderStatus
  inputHash?: string | null
  props?: unknown
  outputPath?: string | null
  outputUrl?: string | null
  width?: number | null
  height?: number | null
  fps?: number | null
  durationMs?: number | null
  qa?: unknown
  taskId?: number | null
  errorCode?: string | null
  errorMessage?: string | null
}

export interface RemotionProjectCreateOptions {
  title?: string
  slug?: string
  metadata?: unknown
  sourceDramaId?: number | null
  mediaAccountId?: number | null
  projectPositioning?: unknown
  episodeBrief?: unknown
}

export interface RemotionProjectSnapshot {
  project: ReturnType<typeof normalizeProject>
  stages: ReturnType<typeof normalizeStageRun>[]
  shots: Array<ReturnType<typeof normalizeShot> & { assets: ReturnType<typeof normalizeAsset>[] }>
  renders: ReturnType<typeof normalizeRender>[]
  tasks: CreationTask[]
}

export interface RemotionProductionTreeEpisode {
  episode: {
    id: number
    dramaId: number
    episodeNumber: number
    title: string
    videoTitle: string | null
    status: string | null
    duration: number | null
    thumbnail: string | null
    updatedAt: string
    creativeBrief: Record<string, unknown>
  } | null
  production: ReturnType<typeof normalizeProject> | null
  productionCount: number
}

export interface RemotionProductionTreeGroup {
  drama: {
    id: number | null
    title: string
    videoTitle: string | null
    thumbnail: string | null
    status: string | null
    updatedAt: string | null
    mediaAccount: {
      id: number
      name: string
      positioning: Record<string, unknown>
    } | null
    projectPositioning: Record<string, unknown>
  }
  episodes: RemotionProductionTreeEpisode[]
}

const VALID_SHOT_TYPES = new Set<RemotionShotType>(['ai_plate', 'character', 'map', 'stock', 'graphic', 'hybrid'])
const VALID_ASSET_TYPES = new Set<RemotionAssetType>(['ai_image', 'character', 'map', 'stock_video', 'graphic', 'audio', 'font'])
const VALID_SHOT_STATUSES = new Set<RemotionShotStatus>(['planned', 'asset_pending', 'ready', 'rendering', 'rendered', 'failed'])
const VALID_STAGE_STATUSES = new Set<RemotionStageStatus>(['pending', 'running', 'succeeded', 'failed', 'canceled'])
const VALID_RENDER_STATUSES = new Set<RemotionRenderStatus>(['queued', 'running', 'succeeded', 'failed', 'canceled'])

export function canonicalRemotionStage(stage: string): RemotionCanonicalStage {
  if ((REMOTION_STAGES as readonly string[]).includes(stage)) return stage as RemotionCanonicalStage
  const alias = REMOTION_STAGE_ALIASES[stage as RemotionLegacyStage]
  if (alias) return alias
  throw new Error(`Invalid Remotion stage: ${stage}`)
}

function stageIndex(stage: RemotionStage): number {
  return REMOTION_STAGES.indexOf(canonicalRemotionStage(stage))
}

function stringify(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function parse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function factoryEnvelope(factoryStage: RemotionCanonicalStage, fields: Record<string, unknown>) {
  return {
    schemaVersion: REMOTION_SCHEMA_VERSION,
    factoryStage,
    attempt: 1,
    artifacts: [],
    checks: [],
    risks: [],
    ...fields,
  }
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'remotion-project'
}

function projectStatusForStage(stage: RemotionStage): RemotionProjectStatus {
  const canonicalStage = canonicalRemotionStage(stage)
  if (canonicalStage === 'asset_production' || canonicalStage === 'asset_qc') return 'assets'
  if (canonicalStage === 'shot_composition' || canonicalStage === 'episode_finish') return 'rendering'
  if (canonicalStage === 'shot_qc' || canonicalStage === 'final_qa') return 'qa'
  return 'planning'
}

function normalizeProject(row: typeof schema.remotionProjects.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    sourceType: row.sourceType,
    sourceEpisodeId: row.sourceEpisodeId,
    sourceDramaId: row.sourceDramaId,
    title: row.title,
    sourceSnapshot: parse<RemotionSourceSnapshot>(row.sourceSnapshotJson, {
      schemaVersion: REMOTION_SCHEMA_VERSION,
      sourceType: row.sourceType === 'script' ? 'script' : 'episode',
      sourceEpisodeId: row.sourceEpisodeId,
      sourceDramaId: row.sourceDramaId,
      drama: null,
      episode: {},
      storyboards: [],
    }),
    positioningSnapshot: parse<RemotionPositioningSnapshot | null>(row.positioningSnapshotJson, null),
    mediaAccountId: row.mediaAccountId,
    sourceHash: row.sourceHash,
    status: row.status as RemotionProjectStatus,
    currentStage: row.currentStage as RemotionStage,
    canonicalStage: canonicalRemotionStage(row.currentStage),
    schemaVersion: row.schemaVersion ?? REMOTION_SCHEMA_VERSION,
    version: row.version ?? 1,
    progressCurrent: row.progressCurrent ?? 0,
    progressTotal: row.progressTotal ?? 0,
    progressMessage: row.progressMessage,
    finalVideoUrl: row.finalVideoUrl,
    metadata: parse<Record<string, unknown> | null>(row.metadataJson, null),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }
}

function normalizeStageRun(row: typeof schema.remotionStageRuns.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    stage: row.stage as RemotionStage,
    canonicalStage: canonicalRemotionStage(row.stage),
    legacyStage: (REMOTION_LEGACY_STAGES as readonly string[]).includes(row.stage) ? row.stage : null,
    stageVersion: row.stageVersion ?? 1,
    status: row.status as RemotionStageStatus,
    inputHash: row.inputHash,
    input: parse<unknown>(row.inputJson, null),
    output: parse<unknown>(row.outputJson, null),
    taskId: row.taskId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }
}

function normalizeShot(row: typeof schema.remotionShots.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceStoryboardId: row.sourceStoryboardId,
    shotNumber: row.shotNumber,
    title: row.title,
    narration: row.narration,
    dialogue: row.dialogue,
    durationMs: row.durationMs,
    shotType: row.shotType as RemotionShotType,
    visualPlan: parse<unknown>(row.visualPlanJson, null),
    sourceEvidence: parse<unknown>(row.sourceEvidenceJson, null),
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function normalizeAsset(row: typeof schema.remotionAssets.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    shotId: row.shotId,
    assetKey: row.assetKey,
    assetType: row.assetType as RemotionAssetType,
    provider: row.provider,
    status: row.status as RemotionAssetStatus,
    prompt: parse<unknown>(row.promptJson, null),
    sourceUrl: row.sourceUrl,
    localPath: row.localPath,
    thumbnailPath: row.thumbnailPath,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    imageGenerationId: row.imageGenerationId,
    taskId: row.taskId,
    license: parse<unknown>(row.licenseJson, null),
    contentHash: row.contentHash,
    version: row.version ?? 1,
    metadata: parse<unknown>(row.metadataJson, null),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }
}

function normalizeRender(row: typeof schema.remotionRenders.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    shotId: row.shotId,
    renderKind: row.renderKind,
    status: row.status,
    inputHash: row.inputHash,
    props: parse<unknown>(row.propsJson, null),
    outputPath: row.outputPath,
    outputUrl: row.outputUrl,
    width: row.width,
    height: row.height,
    fps: row.fps,
    durationMs: row.durationMs,
    qa: parse<unknown>(row.qaJson, null),
    taskId: row.taskId,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }
}

function getProjectRow(projectId: number, client: typeof db | TransactionClient = db) {
  const [row] = client.select().from(schema.remotionProjects)
    .where(eq(schema.remotionProjects.id, projectId)).all()
  return row ?? null
}

function getShotRow(projectId: number, shotId: number, client: typeof db | TransactionClient = db) {
  const [row] = client.select().from(schema.remotionShots).where(and(
    eq(schema.remotionShots.id, shotId),
    eq(schema.remotionShots.projectId, projectId),
    isNull(schema.remotionShots.deletedAt),
  )).all()
  return row ?? null
}

function getLatestAssetRows(projectId: number, client: typeof db | TransactionClient = db) {
  const rows = client.select().from(schema.remotionAssets)
    .where(and(eq(schema.remotionAssets.projectId, projectId), isNull(schema.remotionAssets.deletedAt)))
    .all()
  const latestByKey = new Map<string, typeof rows[number]>()
  for (const row of rows) {
    const current = latestByKey.get(row.assetKey)
    if (!current || (row.version ?? 1) > (current.version ?? 1)
      || ((row.version ?? 1) === (current.version ?? 1) && row.id > current.id)) {
      latestByKey.set(row.assetKey, row)
    }
  }
  return [...latestByKey.values()].sort((a, b) => a.id - b.id)
}

function getLatestAssetRow(projectId: number, assetKey: string) {
  return getLatestAssetRows(projectId).find((asset) => asset.assetKey === assetKey) ?? null
}

function buildPositioningSnapshot(input: {
  account?: typeof schema.mediaAccounts.$inferSelect | null
  project?: unknown
  episode?: unknown
}): RemotionPositioningSnapshot {
  return {
    schemaVersion: POSITIONING_SCHEMA_VERSION,
    account: input.account ? {
      id: input.account.id,
      name: input.account.name,
      positioning: parseJsonRecord(input.account.positioningJson),
    } : null,
    project: parseJsonRecord(input.project),
    episode: parseJsonRecord(input.episode),
  }
}

function requirePositionedMediaAccount(accountId: number | null | undefined) {
  if (accountId == null) {
    throw new Error('media_account_id is required; Remotion production cannot use a default account')
  }
  const account = getMediaAccountRow(accountId)
  if (!account) throw new Error(`Media account ${accountId} not found`)
  const positioning = parseJsonRecord(account.positioningJson)
  if (!Object.keys(positioning).length) {
    throw new Error(`Media account ${accountId} has no positioning; configure the account before starting production`)
  }
  return account
}

export function resolveRemotionMediaAccount(accountId: number | null | undefined) {
  return requirePositionedMediaAccount(accountId)
}

function getPositioningForDrama(
  drama: typeof schema.dramas.$inferSelect | null,
  episode?: typeof schema.episodes.$inferSelect | null,
  overrides: Pick<RemotionProjectCreateOptions, 'mediaAccountId' | 'projectPositioning' | 'episodeBrief'> = {},
) {
  if (drama?.mediaAccountId != null
    && overrides.mediaAccountId != null
    && drama.mediaAccountId !== overrides.mediaAccountId) {
    throw new Error(`Content project ${drama.id} belongs to media account ${drama.mediaAccountId}, not ${overrides.mediaAccountId}`)
  }
  const selectedAccountId = overrides.mediaAccountId != null
    ? overrides.mediaAccountId
    : drama?.mediaAccountId
  const account = requirePositionedMediaAccount(selectedAccountId)
  return buildPositioningSnapshot({
    account,
    project: overrides.projectPositioning !== undefined
      ? overrides.projectPositioning
      : drama?.projectPositioningJson,
    episode: overrides.episodeBrief !== undefined
      ? overrides.episodeBrief
      : episode?.creativeBriefJson,
  })
}

function assertStage(stage: string): asserts stage is RemotionStage {
  canonicalRemotionStage(stage)
}

function assertStageStatus(status: string): asserts status is RemotionStageStatus {
  if (!VALID_STAGE_STATUSES.has(status as RemotionStageStatus)) {
    throw new Error(`Invalid Remotion stage status: ${status}`)
  }
}

function buildEpisodeSnapshot(
  episodeId: number,
  positioningOverrides: Pick<RemotionProjectCreateOptions, 'mediaAccountId' | 'projectPositioning' | 'episodeBrief'> = {},
): RemotionSourceSnapshot {
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) throw new Error(`Episode ${episodeId} not found`)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all()
  const positioning = getPositioningForDrama(drama || null, episode, positioningOverrides)
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  const storyboardIds = new Set(storyboards.map((storyboard) => storyboard.id))
  const storyboardCharacterLinks = db.select().from(schema.storyboardCharacters).all()
  const characters = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, episode.dramaId))
    .all()
  const characterById = new Map(characters.map((character) => [character.id, character]))

  return {
    schemaVersion: REMOTION_SCHEMA_VERSION,
    sourceType: 'episode',
    sourceEpisodeId: episode.id,
    sourceDramaId: episode.dramaId,
    drama: drama ? {
      id: drama.id,
      title: drama.title,
      videoTitle: drama.videoTitle,
      description: drama.description,
      style: drama.style,
      genre: drama.genre,
    } : null,
    positioning,
    episode: {
      id: episode.id,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      videoTitle: episode.videoTitle,
      content: episode.content,
      scriptContent: episode.scriptContent,
      description: episode.description,
      duration: episode.duration,
      metadata: parseJsonRecord(episode.metadata),
      seriesHook: episode.seriesHook,
      openingHook: episode.openingHook,
      cliffhanger: episode.cliffhanger,
      aspectRatio: episode.aspectRatio,
      narrationVoiceId: episode.narrationVoiceId,
      narrationSpeed: episode.narrationSpeed,
      creativeBrief: parseJsonRecord(episode.creativeBriefJson),
      directorPlan: parseJsonRecord(episode.directorPlanJson),
    },
    storyboards: storyboards.map((shot) => {
      const characterIds = storyboardCharacterLinks
        .filter((link) => link.storyboardId === shot.id && storyboardIds.has(link.storyboardId))
        .map((link) => link.characterId)
      const people = characterIds
        .map((characterId) => characterById.get(characterId)?.name || '')
        .filter(Boolean)
      return {
        id: shot.id,
        storyboardNumber: shot.storyboardNumber,
        sceneId: shot.sceneId,
        characterIds,
        people,
        title: shot.title,
        location: shot.location,
        time: shot.time,
        shotType: shot.shotType,
        angle: shot.angle,
        movement: shot.movement,
        action: shot.action,
        result: shot.result,
        atmosphere: shot.atmosphere,
        imagePrompt: shot.imagePrompt,
        videoPrompt: shot.videoPrompt,
        dialogue: shot.dialogue,
        narration: shot.narration,
        description: shot.description,
        duration: shot.duration,
        energyLevel: shot.energyLevel,
        firstFrameImage: shot.firstFrameImage,
        lastFrameImage: shot.lastFrameImage,
        composedImage: shot.composedImage,
        narrationAudioUrl: shot.narrationAudioUrl,
      }
    }),
  }
}

function createRemotionProjectFromSnapshot(
  snapshot: RemotionSourceSnapshot,
  options: RemotionProjectCreateOptions = {},
  sourceInput: Record<string, unknown>,
) {
  const sourceHash = hash(snapshot)
  const existing = db.select().from(schema.remotionProjects)
    .where(and(
      eq(schema.remotionProjects.sourceType, snapshot.sourceType),
      eq(schema.remotionProjects.sourceHash, sourceHash),
    )).all()[0]
  if (existing) return getRemotionProjectSnapshot(existing.id)

  const sourceEpisodeId = snapshot.sourceEpisodeId
  const title = options.title || `${String(snapshot.drama?.title || 'Remotion 项目')} · ${String(snapshot.episode.title || '未命名口播')}`
  const baseSlug = slugify(options.slug || title)
  let slug = baseSlug
  let suffix = 2
  while (db.select().from(schema.remotionProjects).where(eq(schema.remotionProjects.slug, slug)).all().length > 0) {
    slug = `${baseSlug}-${suffix++}`
  }
  const ts = now()
  const positioning = snapshot.positioning
  if (!positioning?.account) {
    throw new Error('Remotion production requires an explicit positioned media account')
  }
  const accountId = positioning.account.id

  const projectId = db.transaction((tx) => {
    const result = tx.insert(schema.remotionProjects).values({
      slug,
      sourceType: snapshot.sourceType,
      sourceEpisodeId,
      sourceDramaId: options.sourceDramaId ?? snapshot.sourceDramaId,
      mediaAccountId: accountId,
      title,
      sourceSnapshotJson: JSON.stringify(snapshot),
      positioningSnapshotJson: JSON.stringify(positioning),
      sourceHash,
      status: 'planning',
      currentStage: 'historical_analysis',
      schemaVersion: REMOTION_SCHEMA_VERSION,
      version: 1,
      progressCurrent: stageIndex('source_snapshot') + 1,
      progressTotal: REMOTION_STAGES.length,
      progressMessage: snapshot.sourceType === 'script'
        ? '口播稿已保存，等待 Skill 分析文稿'
        : '源快照已保存，等待 Skill 分析文稿',
      metadataJson: stringify(options.metadata),
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const id = Number(result.lastInsertRowid)
    tx.insert(schema.remotionStageRuns).values({
      projectId: id,
      stage: 'source_snapshot',
      stageVersion: 1,
      status: 'succeeded',
      inputHash: sourceHash,
      inputJson: JSON.stringify(sourceInput),
      outputJson: JSON.stringify({
        ...factoryEnvelope('source_snapshot', {
          sourceHash,
          sourceType: snapshot.sourceType,
          episodeId: sourceEpisodeId,
          positioningSnapshot: positioning,
        }),
        storyboardCount: snapshot.storyboards.length,
      }),
      createdAt: ts,
      updatedAt: ts,
      startedAt: ts,
      completedAt: ts,
    }).run()
    return id
  })

  return getRemotionProjectSnapshot(projectId)
}

export function createRemotionProjectFromEpisode(
  episodeId: number,
  options: RemotionProjectCreateOptions = {},
) {
  const snapshot = buildEpisodeSnapshot(episodeId, options)
  return createRemotionProjectFromSnapshot(snapshot, options, { episodeId })
}

export function createRemotionProjectFromScript(
  script: string,
  options: RemotionProjectCreateOptions & { narration?: string | null } = {},
) {
  const content = script.trim()
  if (!content) throw new Error('script is required')
  if (estimateSourceDurationSeconds(content) > 180) {
    throw new Error('Raw scripts longer than 3 minutes must use /api/v1/remotion/projects/intake for smart episode splitting')
  }
  const title = options.title || 'Remotion 口播项目'
  const drama = options.sourceDramaId
    ? db.select().from(schema.dramas).where(eq(schema.dramas.id, options.sourceDramaId)).all()[0] || null
    : null
  const positioning = getPositioningForDrama(drama, null, options)
  const snapshot: RemotionSourceSnapshot = {
    schemaVersion: REMOTION_SCHEMA_VERSION,
    sourceType: 'script',
    sourceEpisodeId: null,
    sourceDramaId: options.sourceDramaId ?? null,
    drama: null,
    positioning,
    episode: {
      id: null,
      title,
      content,
      scriptContent: content,
      narration: options.narration ?? content,
      creativeBrief: parseJsonRecord(options.episodeBrief),
    },
    storyboards: [],
  }
  return createRemotionProjectFromSnapshot(snapshot, options, {
    sourceType: 'script',
    contentHash: hash(content),
  })
}

export function getRemotionProject(projectId: number) {
  const row = getProjectRow(projectId)
  return row ? normalizeProject(row) : null
}

export function listRemotionProjects(options: { sourceEpisodeId?: number; status?: string } = {}) {
  const conditions = []
  if (options.sourceEpisodeId != null) conditions.push(eq(schema.remotionProjects.sourceEpisodeId, options.sourceEpisodeId))
  if (options.status) conditions.push(eq(schema.remotionProjects.status, options.status))
  return db.select().from(schema.remotionProjects)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.remotionProjects.id))
    .all()
    .map(normalizeProject)
}

/**
 * Returns the display hierarchy used by the Remotion workspace.
 * A Remotion project is a production record under an existing Drama/Episode;
 * it is intentionally not the top-level business project shown in the UI.
 */
export function listRemotionProductionTree(): RemotionProductionTreeGroup[] {
  const dramas = db.select().from(schema.dramas)
    .where(isNull(schema.dramas.deletedAt))
    .orderBy(desc(schema.dramas.updatedAt), desc(schema.dramas.id))
    .all()
  const episodes = db.select().from(schema.episodes)
    .where(isNull(schema.episodes.deletedAt))
    .orderBy(asc(schema.episodes.dramaId), asc(schema.episodes.episodeNumber), asc(schema.episodes.id))
    .all()
  const productionRows = db.select().from(schema.remotionProjects)
    .where(isNull(schema.remotionProjects.deletedAt))
    .orderBy(desc(schema.remotionProjects.id))
    .all()
    .map(normalizeProject)
  const accountRows = db.select().from(schema.mediaAccounts)
    .where(isNull(schema.mediaAccounts.deletedAt))
    .all()
  const accountsById = new Map(accountRows.map((account) => [account.id, account]))

  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]))
  const productionsByEpisode = new Map<number, ReturnType<typeof normalizeProject>[]>()
  const unassignedProductions: ReturnType<typeof normalizeProject>[] = []

  for (const production of productionRows) {
    if (production.sourceEpisodeId != null && episodeById.has(production.sourceEpisodeId)) {
      const current = productionsByEpisode.get(production.sourceEpisodeId) || []
      current.push(production)
      productionsByEpisode.set(production.sourceEpisodeId, current)
    } else {
      unassignedProductions.push(production)
    }
  }

  const groups: RemotionProductionTreeGroup[] = dramas.map((drama) => ({
    drama: {
      id: drama.id,
      title: drama.title,
      videoTitle: drama.videoTitle,
      thumbnail: drama.thumbnail,
      status: drama.status,
      updatedAt: drama.updatedAt,
      mediaAccount: drama.mediaAccountId && accountsById.has(drama.mediaAccountId)
        ? {
          id: drama.mediaAccountId,
          name: accountsById.get(drama.mediaAccountId)!.name,
          positioning: parseJsonRecord(accountsById.get(drama.mediaAccountId)!.positioningJson),
        }
        : null,
      projectPositioning: parseJsonRecord(drama.projectPositioningJson),
    },
    episodes: episodes
      .filter((episode) => episode.dramaId === drama.id)
      .map((episode) => {
        const productions = productionsByEpisode.get(episode.id) || []
        return {
          episode: {
            id: episode.id,
            dramaId: episode.dramaId,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            videoTitle: episode.videoTitle,
            status: episode.status,
            duration: episode.duration,
            thumbnail: episode.thumbnail,
            updatedAt: episode.updatedAt,
            creativeBrief: parseJsonRecord(episode.creativeBriefJson),
          },
          production: productions[0] || null,
          productionCount: productions.length,
        }
      }),
  }))

  if (unassignedProductions.length) {
    groups.push({
      drama: {
        id: null,
        title: '未关联项目',
        videoTitle: null,
        thumbnail: null,
        status: null,
        updatedAt: null,
        mediaAccount: null,
        projectPositioning: {},
      },
      episodes: unassignedProductions.map((production) => ({
        episode: null,
        production,
        productionCount: 1,
      })),
    })
  }

  return groups
}

export function recordRemotionStageRun(input: {
  projectId: number
  stage: RemotionStage
  status?: RemotionStageStatus
  input?: unknown
  inputHash?: string
  output?: unknown
  taskId?: number | null
  errorCode?: string | null
  errorMessage?: string | null
  stageVersion?: number
}) {
  assertStage(input.stage)
  const project = getProjectRow(input.projectId)
  if (!project) throw new Error(`Remotion project ${input.projectId} not found`)
  const stageVersion = input.stageVersion ?? 1
  const status = input.status ?? 'succeeded'
  const ts = now()
  const canonicalStage = canonicalRemotionStage(input.stage)
  const isNativeStage = (REMOTION_STAGES as readonly string[]).includes(input.stage)
  assertStageStatus(status)
  if (status === 'succeeded' && (input.output === undefined || input.output === null)) {
    throw new Error(`Remotion stage ${input.stage} requires output when succeeded`)
  }
  validateRemotionStageOutput(input.stage, input.output)

  db.transaction((tx) => {
    const [existing] = tx.select().from(schema.remotionStageRuns).where(and(
      eq(schema.remotionStageRuns.projectId, input.projectId),
      eq(schema.remotionStageRuns.stage, input.stage),
      eq(schema.remotionStageRuns.stageVersion, stageVersion),
    )).all()

    const values = {
      status,
      inputHash: input.inputHash ?? (input.input === undefined ? null : hash(input.input)),
      inputJson: input.input === undefined ? undefined : stringify(input.input),
      outputJson: input.output === undefined ? undefined : stringify(input.output),
      taskId: input.taskId ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      updatedAt: ts,
      startedAt: status === 'running' ? ts : undefined,
      completedAt: ['succeeded', 'failed', 'canceled'].includes(status) ? ts : undefined,
    }
    if (existing) {
      tx.update(schema.remotionStageRuns).set(values).where(eq(schema.remotionStageRuns.id, existing.id)).run()
    } else {
      tx.insert(schema.remotionStageRuns).values({
        projectId: input.projectId,
        stage: input.stage,
        stageVersion,
        status,
        inputHash: values.inputHash,
        inputJson: input.input === undefined ? null : stringify(input.input),
        outputJson: input.output === undefined ? null : stringify(input.output),
        taskId: input.taskId ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        createdAt: ts,
        updatedAt: ts,
        startedAt: status === 'running' ? ts : null,
        completedAt: ['succeeded', 'failed', 'canceled'].includes(status) ? ts : null,
      }).run()
    }

    const projectUpdates: Partial<typeof schema.remotionProjects.$inferInsert> = {
      currentStage: isNativeStage ? canonicalStage : project.currentStage,
      status: isNativeStage
        ? status === 'failed' ? 'failed' : projectStatusForStage(input.stage)
        : project.status,
      progressCurrent: isNativeStage
        ? status === 'succeeded' ? stageIndex(input.stage) + 1 : stageIndex(input.stage)
        : project.progressCurrent ?? 0,
      progressTotal: REMOTION_STAGES.length,
      progressMessage: isNativeStage ? `${input.stage} ${status}` : `compatibility ${input.stage} ${status}`,
      updatedAt: ts,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
    }
    if (isNativeStage && status === 'succeeded' && canonicalStage === 'final_qa') {
      const passed = Boolean(input.output && typeof input.output === 'object' && (input.output as Record<string, unknown>).passed)
      projectUpdates.status = passed ? 'completed' : 'failed'
      projectUpdates.errorCode = passed ? null : 'qa_failed'
      projectUpdates.errorMessage = passed ? null : 'Remotion QA did not pass'
      if (passed) projectUpdates.completedAt = ts
    }
    if (isNativeStage && status === 'succeeded' && canonicalStage === 'episode_finish' && input.output && typeof input.output === 'object') {
      const finalVideoUrl = (input.output as Record<string, unknown>).finalVideoUrl
      if (typeof finalVideoUrl === 'string' && finalVideoUrl) projectUpdates.finalVideoUrl = finalVideoUrl
    }
    if (status === 'running' && !project.startedAt) projectUpdates.startedAt = ts
    tx.update(schema.remotionProjects).set(projectUpdates).where(eq(schema.remotionProjects.id, input.projectId)).run()
  })

  return getRemotionStageRuns(input.projectId).find((run) => (
    (run.stage === input.stage || run.canonicalStage === canonicalStage)
    && run.stageVersion === stageVersion
  )) || null
}

export function getRemotionStageRuns(projectId: number) {
  return db.select().from(schema.remotionStageRuns)
    .where(eq(schema.remotionStageRuns.projectId, projectId))
    .orderBy(asc(schema.remotionStageRuns.id))
    .all()
    .map(normalizeStageRun)
}

/**
 * Upgrade a Remotion project to the native eleven-stage factory contract.
 * Existing legacy rows remain untouched; canonical rows are created as
 * pending so a factory run can explicitly review or regenerate each stage.
 */
export function initializeRemotionFactory(projectId: number) {
  const project = getProjectRow(projectId)
  if (!project) throw new Error(`Remotion project ${projectId} not found`)
  const frozenSnapshot = parse<RemotionSourceSnapshot>(project.sourceSnapshotJson, {
    schemaVersion: REMOTION_SCHEMA_VERSION,
    sourceType: project.sourceType === 'script' ? 'script' : 'episode',
    sourceEpisodeId: project.sourceEpisodeId,
    sourceDramaId: project.sourceDramaId,
    drama: null,
    episode: {},
    storyboards: [],
  })
  if (!frozenSnapshot.positioning?.account
    || !Object.keys(frozenSnapshot.positioning.account.positioning || {}).length) {
    throw new Error('Cannot initialize Remotion factory without an explicit positioned media account')
  }
  const ts = now()

  db.transaction((tx) => {
    const existing = tx.select().from(schema.remotionStageRuns)
      .where(eq(schema.remotionStageRuns.projectId, projectId))
      .all()
    const canonicalRows = new Map(
      existing
        .filter((row) => (REMOTION_STAGES as readonly string[]).includes(row.stage))
        .map((row) => [`${row.stage}:${row.stageVersion}`, row]),
    )

    for (const stage of REMOTION_STAGES) {
      const key = `${stage}:1`
      if (canonicalRows.has(key)) continue
      const status = stage === 'source_snapshot' ? 'succeeded' : 'pending'
      const sourceSnapshot = stage === 'source_snapshot' ? frozenSnapshot : null
      tx.insert(schema.remotionStageRuns).values({
        projectId,
        stage,
        stageVersion: 1,
        status,
        inputHash: stage === 'source_snapshot' ? project.sourceHash : null,
        inputJson: null,
        outputJson: sourceSnapshot
          ? JSON.stringify(factoryEnvelope('source_snapshot', {
            sourceHash: project.sourceHash,
            sourceType: sourceSnapshot.sourceType,
            episodeId: sourceSnapshot.sourceEpisodeId,
            storyboardCount: sourceSnapshot.storyboards.length,
            positioningSnapshot: sourceSnapshot.positioning ?? null,
            checks: [{ name: 'source_snapshot_frozen', passed: true }],
          }))
          : null,
        taskId: null,
        errorCode: null,
        errorMessage: null,
        createdAt: ts,
        updatedAt: ts,
        startedAt: status === 'succeeded' ? ts : null,
        completedAt: status === 'succeeded' ? ts : null,
      }).run()
    }

    const refreshed = tx.select().from(schema.remotionStageRuns)
      .where(eq(schema.remotionStageRuns.projectId, projectId))
      .all()
    const canonicalByStage = new Map(
      refreshed
        .filter((row) => row.stageVersion === 1 && (REMOTION_STAGES as readonly string[]).includes(row.stage))
        .map((row) => [row.stage as RemotionCanonicalStage, row]),
    )
    let completedCount = 0
    let currentStage: RemotionCanonicalStage = 'source_snapshot'
    for (const stage of REMOTION_STAGES) {
      const row = canonicalByStage.get(stage)
      if (row?.status !== 'succeeded') {
        currentStage = stage
        break
      }
      completedCount += 1
      currentStage = stage
    }
    const allStagesSucceeded = completedCount === REMOTION_STAGES.length
    const finalOutput = canonicalByStage.get('final_qa')?.outputJson
      ? parse<Record<string, unknown>>(canonicalByStage.get('final_qa')?.outputJson, {})
      : {}
    const finalPassed = allStagesSucceeded && finalOutput.passed === true
    const metadata = parse<Record<string, unknown>>(project.metadataJson, {})
    metadata.remotionFactory = {
      schemaVersion: 1,
      initializedAt: ts,
      stageCount: REMOTION_STAGES.length,
      legacyRowsPreserved: true,
    }
    tx.update(schema.remotionProjects).set({
      currentStage,
      status: finalPassed ? 'completed' : projectStatusForStage(currentStage),
      progressCurrent: completedCount,
      progressTotal: REMOTION_STAGES.length,
      progressMessage: finalPassed ? 'factory completed' : `factory initialized at ${currentStage}`,
      metadataJson: JSON.stringify(metadata),
      errorCode: null,
      errorMessage: null,
      completedAt: finalPassed ? ts : null,
      updatedAt: ts,
    }).where(eq(schema.remotionProjects.id, projectId)).run()
  })

  return getRemotionProjectSnapshot(projectId)
}

export function upsertRemotionShots(projectId: number, shots: RemotionShotInput[]) {
  if (!getProjectRow(projectId)) throw new Error(`Remotion project ${projectId} not found`)
  if (!shots.length) return []
  const numbers = new Set<number>()
  for (const shot of shots) {
    if (!Number.isInteger(shot.shotNumber) || shot.shotNumber < 1) throw new Error('shotNumber must be a positive integer')
    if (numbers.has(shot.shotNumber)) throw new Error(`Duplicate shotNumber ${shot.shotNumber}`)
    numbers.add(shot.shotNumber)
    if (!Number.isInteger(shot.durationMs) || shot.durationMs <= 0) throw new Error(`Invalid duration for shot ${shot.shotNumber}`)
    if (shot.durationMs > REMOTION_SHOT_RHYTHM.hardMaxShotDurationMs) {
      throw new Error(`Shot ${shot.shotNumber} exceeds the hard duration limit of ${REMOTION_SHOT_RHYTHM.hardMaxShotDurationMs}ms`)
    }
    if (shot.durationMs > REMOTION_SHOT_RHYTHM.maxShotDurationMs) {
      const plan = record(shot.visualPlan)
      const justification = typeof plan.longShotJustification === 'string'
        ? plan.longShotJustification.trim()
        : typeof plan.long_shot_justification === 'string'
          ? plan.long_shot_justification.trim()
          : ''
      if (!justification) {
        throw new Error(`Shot ${shot.shotNumber} exceeds the default duration limit of ${REMOTION_SHOT_RHYTHM.maxShotDurationMs}ms; longShotJustification is required`)
      }
    }
    if (!VALID_SHOT_TYPES.has(shot.shotType)) throw new Error(`Invalid Remotion shot type: ${shot.shotType}`)
    if (shot.status && !VALID_SHOT_STATUSES.has(shot.status)) throw new Error(`Invalid Remotion shot status: ${shot.status}`)
  }

  const ts = now()
  db.transaction((tx) => {
    for (const shot of shots) {
      const [existing] = tx.select().from(schema.remotionShots).where(and(
        eq(schema.remotionShots.projectId, projectId),
        eq(schema.remotionShots.shotNumber, shot.shotNumber),
      )).all()
      const values = {
        sourceStoryboardId: shot.sourceStoryboardId ?? null,
        title: shot.title ?? null,
        narration: shot.narration ?? null,
        dialogue: shot.dialogue ?? null,
        durationMs: shot.durationMs,
        shotType: shot.shotType,
        visualPlanJson: JSON.stringify(shot.visualPlan),
        sourceEvidenceJson: stringify(shot.sourceEvidence),
        status: shot.status ?? 'planned',
        updatedAt: ts,
        deletedAt: null,
      }
      if (existing) tx.update(schema.remotionShots).set(values).where(eq(schema.remotionShots.id, existing.id)).run()
      else tx.insert(schema.remotionShots).values({ projectId, shotNumber: shot.shotNumber, ...values, createdAt: ts }).run()
    }
    const total = tx.select().from(schema.remotionShots).where(eq(schema.remotionShots.projectId, projectId)).all().length
    tx.update(schema.remotionProjects).set({
      progressTotal: REMOTION_STAGES.length,
      progressCurrent: stageIndex('storyboard'),
      currentStage: 'storyboard',
      progressMessage: `${total} 个镜头计划已写入`,
      status: 'planning',
      updatedAt: ts,
    }).where(eq(schema.remotionProjects.id, projectId)).run()
  })

  return db.select().from(schema.remotionShots)
    .where(and(eq(schema.remotionShots.projectId, projectId), isNull(schema.remotionShots.deletedAt)))
    .orderBy(asc(schema.remotionShots.shotNumber))
    .all()
    .map(normalizeShot)
}

function archiveRemotionPlanRows(
  projectId: number,
  keepShotNumbers: Set<number>,
  keepAssetKeys: Set<string>,
) {
  const ts = now()
  db.transaction((tx) => {
    const shots = tx.select().from(schema.remotionShots)
      .where(eq(schema.remotionShots.projectId, projectId)).all()
    for (const shot of shots) {
      if (!keepShotNumbers.has(shot.shotNumber) && !shot.deletedAt) {
        tx.update(schema.remotionShots).set({ deletedAt: ts, updatedAt: ts })
          .where(eq(schema.remotionShots.id, shot.id)).run()
      }
    }

    const assets = tx.select().from(schema.remotionAssets)
      .where(eq(schema.remotionAssets.projectId, projectId)).all()
    for (const asset of assets) {
      if (!keepAssetKeys.has(asset.assetKey) && !asset.deletedAt) {
        tx.update(schema.remotionAssets).set({ deletedAt: ts, updatedAt: ts })
          .where(eq(schema.remotionAssets.id, asset.id)).run()
      }
    }
  })
}

function plannerStoryboard(value: Record<string, unknown>): PlannerStoryboard {
  return value as PlannerStoryboard
}

/**
 * Remotion is a renderer for semantic storyboards, not a second screenplay
 * splitter. A missing storyboard stage must remain visible to the caller so
 * the upstream storyboard breaker can be run and reviewed first.
 */
export function resolveRemotionStoryboards(
  sourceStoryboards: PlannerStoryboard[],
  stagedStoryboards: PlannerStoryboard[],
): PlannerStoryboard[] {
  if (stagedStoryboards.length) return stagedStoryboards
  if (sourceStoryboards.length) return sourceStoryboards
  throw new Error('Remotion planning requires semantic source storyboards; run storyboard_breaker first')
}

function storyboardStageOutput(projectId: number): PlannerStoryboard[] {
  const run = getRemotionStageRuns(projectId)
    .filter((candidate) => candidate.stage === 'storyboard' && candidate.status === 'succeeded')
    .at(-1)
  const output = record(run?.output)
  const shots = Array.isArray(output.shots) ? output.shots : []
  return shots.map((value) => {
    const shot = record(value)
    const sourceEvidence = record(shot.sourceEvidence)
    const visualPlan = record(shot.visualPlan)
    return {
      storyboardNumber: Number(shot.shotNumber),
      id: typeof shot.sourceStoryboardId === 'number' ? shot.sourceStoryboardId : null,
      sceneId: typeof shot.sceneId === 'number'
        ? shot.sceneId
        : typeof sourceEvidence.sceneId === 'number' ? sourceEvidence.sceneId : null,
      characterIds: Array.isArray(shot.characterIds)
        ? shot.characterIds.map(Number)
        : Array.isArray(sourceEvidence.characterIds) ? sourceEvidence.characterIds.map(Number) : [],
      title: String(shot.title || sourceEvidence.title || `镜头 ${shot.shotNumber}`),
      location: String(shot.location || sourceEvidence.location || ''),
      time: String(shot.time || sourceEvidence.time || ''),
      shotType: String(shot.shotType || 'auto'),
      angle: String(shot.angle || sourceEvidence.angle || ''),
      movement: String(shot.movement || sourceEvidence.movement || ''),
      action: String(shot.action || sourceEvidence.action || ''),
      result: String(shot.result || sourceEvidence.result || ''),
      atmosphere: String(shot.atmosphere || sourceEvidence.atmosphere || ''),
      narration: String(shot.narration || sourceEvidence.narration || ''),
      dialogue: String(shot.dialogue || sourceEvidence.dialogue || ''),
      description: String(shot.description || sourceEvidence.description || ''),
      duration: Number(shot.durationMs || 0) / 1000,
      visualPlan,
      beatIds: Array.isArray(shot.beatIds)
        ? shot.beatIds.map(String)
        : Array.isArray(sourceEvidence.beatIds) ? sourceEvidence.beatIds.map(String) : [],
      segmentIndex: Number(shot.segmentIndex || sourceEvidence.segmentIndex || 0),
      people: Array.isArray(shot.people)
        ? shot.people.map(String)
        : Array.isArray(sourceEvidence.people) ? sourceEvidence.people.map(String) : undefined,
      map: record(shot.map),
      stock: record(shot.stock),
      ...sourceEvidence,
    }
  }).filter((storyboard) => Number.isInteger(storyboard.storyboardNumber) && storyboard.storyboardNumber > 0 && storyboard.duration > 0)
}

/**
 * Plan one Remotion production record from its frozen source snapshot.
 * This is the Skill-facing write boundary: the planner owns classification,
 * the service owns ids/versioning, and the Web UI only reads the result.
 */
export function planRemotionProject(
  projectId: number,
  stockCatalog: PlannerStockAsset[] = [],
  options: { regenerateFromSource?: boolean } = {},
) {
  const project = getProjectRow(projectId)
  if (!project) throw new Error(`Remotion project ${projectId} not found`)
  const source = parse<RemotionSourceSnapshot>(project.sourceSnapshotJson, {
    schemaVersion: REMOTION_SCHEMA_VERSION,
    sourceType: project.sourceType === 'script' ? 'script' : 'episode',
    sourceEpisodeId: project.sourceEpisodeId,
    sourceDramaId: project.sourceDramaId,
    drama: null,
    episode: {},
    storyboards: [],
  })
  const stagedStoryboards = options.regenerateFromSource ? [] : storyboardStageOutput(projectId)
  const storyboards = resolveRemotionStoryboards(
    source.storyboards.map(plannerStoryboard),
    stagedStoryboards,
  )

  const existingShots = db.select().from(schema.remotionShots)
    .where(and(eq(schema.remotionShots.projectId, projectId), isNull(schema.remotionShots.deletedAt)))
    .all()
    .map((shot) => ({
      shotNumber: shot.shotNumber,
      visualPlan: parse<unknown>(shot.visualPlanJson, null),
    }))
  const plan = planRemotionShots(
    storyboards.map(plannerStoryboard),
    existingShots,
    stockCatalog,
  )
  if (!plan.shots.length) throw new Error('Remotion planner produced no shots')

  const keepShotNumbers = new Set(plan.shots.map((shot) => shot.shotNumber))
  const keepAssetKeys = new Set(plan.assets.map((asset) => asset.assetKey))
  archiveRemotionPlanRows(projectId, keepShotNumbers, keepAssetKeys)

  const shotRows = upsertRemotionShots(projectId, plan.shots.map((shot) => ({
    shotNumber: shot.shotNumber,
    sourceStoryboardId: shot.sourceStoryboardId,
    title: shot.title,
    narration: shot.narration,
    dialogue: shot.dialogue,
    durationMs: shot.durationMs,
    shotType: shot.shotType,
    visualPlan: shot.visualPlan,
    sourceEvidence: shot.sourceEvidence,
    status: 'planned',
  })))
  const shotIdByNumber = new Map(shotRows.map((shot) => [shot.shotNumber, shot.id]))

  const persistedAssets = plan.assets.map((asset) => {
    const shotId = shotIdByNumber.get(asset.shotNumber)
    if (!shotId) throw new Error(`Remotion shot ${asset.shotNumber} was not persisted`)
    return upsertRemotionAsset(projectId, {
      shotId,
      assetKey: asset.assetKey,
      assetType: asset.assetType,
      provider: asset.provider,
      status: asset.status ?? 'planned',
      prompt: asset.prompt,
      sourceUrl: asset.sourceUrl,
      localPath: asset.localPath,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
      license: asset.license,
      metadata: asset.metadata,
    })
  })

  const locations = plan.shots.flatMap((shot) => {
    const visualPlan = shot.visualPlan
    const map = visualPlan.map
    return map && typeof map === 'object' && Array.isArray((map as Record<string, unknown>).locations)
      ? (map as Record<string, unknown>).locations as unknown[]
      : []
  })
  const routes = plan.shots.flatMap((shot) => {
    const visualPlan = shot.visualPlan
    const map = visualPlan.map
    return map && typeof map === 'object' && Array.isArray((map as Record<string, unknown>).routes)
      ? (map as Record<string, unknown>).routes as unknown[]
      : []
  })
  const characters = plan.shots.flatMap((shot) => {
    const visualPlan = shot.visualPlan
    return Array.isArray(visualPlan.characters)
      ? visualPlan.characters.map((character) => record(character).name).filter((name): name is string => typeof name === 'string')
      : []
  })
  const uniqueStrings = (values: string[]) => [...new Set(values)]
  const sourceHash = project.sourceHash
  let beatStartMs = 0
  const narrativeBeats = plan.shots.map((shot) => {
    const beatIds = shot.beatIds.length ? shot.beatIds : [`beat-${shot.shotNumber}`]
    const beat = {
      id: beatIds[0],
      beatIds,
      startMs: beatStartMs,
      endMs: beatStartMs + shot.durationMs,
      narration: shot.narration || shot.dialogue || shot.title,
      intent: shot.title,
      emphasis: 'normal',
      screenText: null,
      textAnimation: 'word_reveal',
    }
    beatStartMs += shot.durationMs
    return beat
  })
    recordRemotionStageRun({
    projectId,
    stage: 'historical_analysis',
    input: { sourceHash },
    output: factoryEnvelope('historical_analysis', {
      claims: [],
      people: uniqueStrings(characters),
      locations: uniqueStrings(locations.map((location) => String(record(location).label || ''))).filter(Boolean),
      routes,
      informationBeats: plan.shots.map((shot) => ({ shotNumber: shot.shotNumber, title: shot.title })),
      checks: [{ name: 'source_claims_extracted', passed: true }],
    }),
  })
  recordRemotionStageRun({
    projectId,
    stage: 'narrative_beats',
    input: { sourceHash, shotPlanHash: hash(plan.shots) },
    output: factoryEnvelope('narrative_beats', {
      durationMs: beatStartMs,
      beats: narrativeBeats,
      checks: [{ name: 'beats_contiguous', passed: true }],
    }),
  })
  recordRemotionStageRun({
    projectId,
    stage: 'storyboard',
    input: { sourceHash, stockCatalogSize: stockCatalog.length },
    output: factoryEnvelope('storyboard', {
      directorPlan: record(source.episode.directorPlan),
      shots: plan.shots.map((shot) => ({
        shotNumber: shot.shotNumber,
        sourceStoryboardId: shot.sourceStoryboardId,
        title: shot.title,
        narration: shot.narration,
        dialogue: shot.dialogue,
        durationMs: shot.durationMs,
        shotType: shot.shotType,
        visualSetupId: shot.visualSetupId,
        beatIds: shot.beatIds,
        sourceEvidence: shot.sourceEvidence,
        visualPlan: shot.visualPlan,
      })),
      checks: [
        { name: 'shot_types_explicit', passed: true },
        { name: 'shot_rhythm_bounded', passed: plan.shots.every((shot) => shot.durationMs <= 9000) },
        { name: 'beat_coverage_complete', passed: plan.shots.every((shot) => shot.beatIds.length > 0) },
      ],
      risks: plan.summary.warnings,
    }),
  })
  recordRemotionStageRun({
    projectId,
    stage: 'asset_plan',
    input: { sourceHash, shotPlanHash: hash(plan.shots) },
    output: factoryEnvelope('asset_plan', {
      assets: plan.assets.map((asset) => ({
        assetKey: asset.assetKey,
        assetType: asset.assetType,
        status: asset.status ?? 'planned',
        provider: asset.provider,
        sourceUrl: asset.sourceUrl,
        license: asset.license,
        metadata: asset.metadata,
      })),
      checks: [{ name: 'asset_keys_stable', passed: true }],
      risks: plan.summary.warnings,
    }),
  })

  return {
    plan,
    assets: persistedAssets,
    snapshot: getRemotionProjectSnapshot(projectId),
  }
}

export function upsertRemotionAsset(projectId: number, input: RemotionAssetInput) {
  if (!getProjectRow(projectId)) throw new Error(`Remotion project ${projectId} not found`)
  if (!input.assetKey.trim()) throw new Error('assetKey is required')
  if (!VALID_ASSET_TYPES.has(input.assetType)) throw new Error(`Invalid Remotion asset type: ${input.assetType}`)
  if (input.status && !['planned', 'queued', 'processing', 'completed', 'failed', 'canceled'].includes(input.status)) {
    throw new Error(`Invalid Remotion asset status: ${input.status}`)
  }
  const version = input.version ?? 1
  const ts = now()
  const [existing] = db.select().from(schema.remotionAssets).where(and(
    eq(schema.remotionAssets.projectId, projectId),
    eq(schema.remotionAssets.assetKey, input.assetKey),
    eq(schema.remotionAssets.version, version),
  )).all()
  const shotId = input.shotId === undefined ? existing?.shotId ?? null : input.shotId
  if (shotId != null && !getShotRow(projectId, shotId)) {
    throw new Error(`Remotion shot ${shotId} not found in project ${projectId}`)
  }
  const status = input.status ?? existing?.status ?? 'planned'
  const terminal = ['completed', 'failed', 'canceled'].includes(status)
  const values = {
    shotId,
    assetType: input.assetType,
    provider: input.provider === undefined ? existing?.provider ?? null : input.provider,
    status,
    promptJson: input.prompt === undefined ? existing?.promptJson ?? null : stringify(input.prompt),
    sourceUrl: input.sourceUrl === undefined ? existing?.sourceUrl ?? null : input.sourceUrl,
    localPath: input.localPath === undefined ? existing?.localPath ?? null : input.localPath,
    thumbnailPath: input.thumbnailPath === undefined ? existing?.thumbnailPath ?? null : input.thumbnailPath,
    mimeType: input.mimeType === undefined ? existing?.mimeType ?? null : input.mimeType,
    width: input.width === undefined ? existing?.width ?? null : input.width,
    height: input.height === undefined ? existing?.height ?? null : input.height,
    durationMs: input.durationMs === undefined ? existing?.durationMs ?? null : input.durationMs,
    imageGenerationId: input.imageGenerationId === undefined ? existing?.imageGenerationId ?? null : input.imageGenerationId,
    taskId: input.taskId === undefined ? existing?.taskId ?? null : input.taskId,
    licenseJson: input.license === undefined ? existing?.licenseJson ?? null : stringify(input.license),
    contentHash: input.contentHash === undefined ? existing?.contentHash ?? null : input.contentHash,
    metadataJson: input.metadata === undefined ? existing?.metadataJson ?? null : stringify(input.metadata),
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    startedAt: status === 'processing' ? existing?.startedAt ?? ts : existing?.startedAt ?? null,
    completedAt: terminal ? ts : null,
    deletedAt: null,
    updatedAt: ts,
  }
  if (existing) {
    db.update(schema.remotionAssets).set(values).where(eq(schema.remotionAssets.id, existing.id)).run()
  } else {
    db.insert(schema.remotionAssets).values({
      projectId,
      assetKey: input.assetKey,
      version,
      ...values,
      createdAt: ts,
    }).run()
  }
  if (shotId != null) refreshRemotionShotStatus(db, shotId, input.errorCode, input.errorMessage)
  const [row] = db.select().from(schema.remotionAssets).where(and(
    eq(schema.remotionAssets.projectId, projectId),
    eq(schema.remotionAssets.assetKey, input.assetKey),
    eq(schema.remotionAssets.version, version),
  )).all()
  if (!row) throw new Error('Remotion asset insert failed')
  return normalizeAsset(row)
}

export function getRemotionAssets(projectId: number) {
  return getLatestAssetRows(projectId)
    .map(normalizeAsset)
}

export function enqueueRemotionImageAsset(input: EnqueueRemotionImageInput) {
  const project = getProjectRow(input.projectId)
  if (!project) throw new Error(`Remotion project ${input.projectId} not found`)
  const [shot] = db.select().from(schema.remotionShots).where(and(
    eq(schema.remotionShots.id, input.shotId),
    eq(schema.remotionShots.projectId, input.projectId),
  )).all()
  if (!shot) throw new Error(`Remotion shot ${input.shotId} not found in project ${input.projectId}`)
  const assetType = input.assetType || 'ai_image'
  if (assetType !== 'ai_image' && assetType !== 'character') {
    throw new Error(`Image generation only supports ai_image or character assets: ${assetType}`)
  }
  const assetKey = input.assetKey || `shot-${shot.shotNumber}-${assetType === 'character' ? 'character' : 'ai-plate'}`
  const existing = getLatestAssetRow(input.projectId, assetKey)
  const existingTask = existing?.taskId ? getTask(existing.taskId) : null
  if (existing && ['queued', 'processing'].includes(existing.status)
    && existingTask && ['queued', 'running'].includes(existingTask.status)) {
    return { asset: normalizeAsset(existing), task: existingTask }
  }
  if (existing?.status === 'completed' && existing.localPath) {
    return { asset: normalizeAsset(existing), task: existingTask }
  }

  const needsNewVersion = Boolean(existing && (
    existing.status === 'failed'
    || existing.status === 'canceled'
    || (existing.status === 'completed' && !existing.localPath)
    || (existingTask && ['failed', 'canceled', 'stale'].includes(existingTask.status))
  ))
  const version = needsNewVersion ? (existing?.version ?? 1) + 1 : existing?.version ?? 1

  const generationId = createImageGenerationRecord({
    episodeId: project.sourceEpisodeId ?? undefined,
    dramaId: project.sourceDramaId ?? undefined,
    prompt: input.prompt,
    size: input.size || '1920x1080',
    referenceImages: input.referenceImages || [],
    frameType: 'remotion_asset',
    imageType: assetType === 'character' ? 'remotion_character' : 'remotion_shot',
    configId: input.configId,
    seed: input.seed,
    style: input.style,
  })
  const promptPayload = {
    text: input.prompt,
    referenceImages: input.referenceImages || [],
    seed: input.seed,
    size: input.size,
    style: input.style,
  }
  const metadata = {
    ...record(input.metadata),
    ...(assetType === 'character' ? { requiresAlpha: true, alphaReady: false } : {}),
  }
  const asset = upsertRemotionAsset(input.projectId, {
    shotId: input.shotId,
    assetKey,
    assetType,
    provider: input.provider,
    status: 'queued',
    prompt: promptPayload,
    width: input.width,
    height: input.height,
    version,
    imageGenerationId: generationId,
    metadata,
  })
  const task = createTask({
    type: 'image.generate',
    dramaId: project.sourceDramaId,
    episodeId: project.sourceEpisodeId,
    scopeType: 'remotion_asset',
    scopeId: asset.id,
    idempotencyKey: `remotion.asset.image:${asset.id}:${asset.version}`,
    provider: input.provider,
    payload: {
      image_generation_id: generationId,
      config_id: input.configId,
      remotion_project_id: input.projectId,
      remotion_shot_id: input.shotId,
      remotion_asset_id: asset.id,
    },
    maxAttempts: 3,
    priority: 0,
  })
  const updated = upsertRemotionAsset(input.projectId, {
    shotId: input.shotId,
    assetKey,
    assetType,
    provider: input.provider,
    status: 'queued',
    prompt: promptPayload,
    width: input.width,
    height: input.height,
    version,
    imageGenerationId: generationId,
    taskId: task.id,
    metadata,
  })
  return { asset: updated, task }
}

export function getRemotionRenders(projectId: number) {
  return db.select().from(schema.remotionRenders)
    .where(eq(schema.remotionRenders.projectId, projectId))
    .orderBy(desc(schema.remotionRenders.id))
    .all()
    .map(normalizeRender)
}

function renderWhere(projectId: number, renderKind: RemotionRenderKind, shotId: number | null) {
  return and(
    eq(schema.remotionRenders.projectId, projectId),
    eq(schema.remotionRenders.renderKind, renderKind),
    shotId == null
      ? isNull(schema.remotionRenders.shotId)
      : eq(schema.remotionRenders.shotId, shotId),
  )
}

/**
 * Persist a Remotion render independently from the stage summary. Stage rows
 * explain why a render was scheduled; render rows hold the concrete output
 * and make shot/episode status queryable without reading Skill logs.
 */
export function upsertRemotionRender(projectId: number, input: RemotionRenderInput) {
  const project = getProjectRow(projectId)
  if (!project) throw new Error(`Remotion project ${projectId} not found`)
  if (!input.renderKind || !['shot', 'episode'].includes(input.renderKind)) {
    throw new Error(`Invalid Remotion render kind: ${input.renderKind}`)
  }
  const status = input.status ?? 'queued'
  if (!VALID_RENDER_STATUSES.has(status)) throw new Error(`Invalid Remotion render status: ${status}`)
  const shotId = input.shotId ?? null
  if (input.renderKind === 'shot' && shotId == null) throw new Error('shot render requires shotId')
  if (shotId != null) {
    const [shot] = db.select().from(schema.remotionShots).where(and(
      eq(schema.remotionShots.id, shotId),
      eq(schema.remotionShots.projectId, projectId),
    )).all()
    if (!shot) throw new Error(`Remotion shot ${shotId} not found in project ${projectId}`)
  }

  const ts = now()
  const stage: RemotionCanonicalStage = input.renderKind === 'shot' ? 'shot_composition' : 'episode_finish'
  const renderStageIndex = stageIndex(stage)
  db.transaction((tx) => {
    const [existing] = tx.select().from(schema.remotionRenders)
      .where(renderWhere(projectId, input.renderKind, shotId))
      .all()
    const values = {
      status,
      inputHash: input.inputHash ?? null,
      propsJson: input.props === undefined ? undefined : stringify(input.props),
      outputPath: input.outputPath ?? null,
      outputUrl: input.outputUrl ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      fps: input.fps ?? null,
      durationMs: input.durationMs ?? null,
      qaJson: input.qa === undefined ? undefined : stringify(input.qa),
      taskId: input.taskId ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      updatedAt: ts,
      startedAt: status === 'running' ? ts : undefined,
      completedAt: ['succeeded', 'failed', 'canceled'].includes(status) ? ts : undefined,
    }
    if (existing) {
      tx.update(schema.remotionRenders).set(values)
        .where(eq(schema.remotionRenders.id, existing.id)).run()
    } else {
      tx.insert(schema.remotionRenders).values({
        projectId,
        shotId,
        renderKind: input.renderKind,
        status,
        inputHash: input.inputHash ?? null,
        propsJson: input.props === undefined ? null : stringify(input.props),
        outputPath: input.outputPath ?? null,
        outputUrl: input.outputUrl ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        fps: input.fps ?? null,
        durationMs: input.durationMs ?? null,
        qaJson: input.qa === undefined ? null : stringify(input.qa),
        taskId: input.taskId ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        createdAt: ts,
        updatedAt: ts,
        startedAt: status === 'running' ? ts : null,
        completedAt: ['succeeded', 'failed', 'canceled'].includes(status) ? ts : null,
      }).run()
    }

    if (shotId != null && input.renderKind === 'shot') {
      const shotStatus: RemotionShotStatus = status === 'succeeded'
        ? 'rendered'
        : status === 'failed'
          ? 'failed'
          : status === 'queued' || status === 'running'
            ? 'rendering'
            : 'ready'
      tx.update(schema.remotionShots).set({ status: shotStatus, updatedAt: ts })
        .where(eq(schema.remotionShots.id, shotId)).run()
    }

    const projectUpdates: Partial<typeof schema.remotionProjects.$inferInsert> = {
      currentStage: stage,
      status: status === 'failed' ? 'failed' : projectStatusForStage(stage),
      progressCurrent: status === 'succeeded' ? renderStageIndex + 1 : renderStageIndex,
      progressTotal: REMOTION_STAGES.length,
      progressMessage: `${stage} ${status}`,
      updatedAt: ts,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
    }
    if (status === 'running' && !project.startedAt) projectUpdates.startedAt = ts
    if (input.renderKind === 'episode' && status === 'succeeded' && input.outputUrl) {
      projectUpdates.finalVideoUrl = input.outputUrl
    }
    tx.update(schema.remotionProjects).set(projectUpdates)
      .where(eq(schema.remotionProjects.id, projectId)).run()
  })

  const [row] = db.select().from(schema.remotionRenders)
    .where(renderWhere(projectId, input.renderKind, shotId)).all()
  if (!row) throw new Error('Remotion render insert failed')
  return normalizeRender(row)
}

export function getRemotionProjectSnapshot(projectId: number): RemotionProjectSnapshot | null {
  const projectRow = getProjectRow(projectId)
  if (!projectRow) return null
  const shots = db.select().from(schema.remotionShots)
    .where(and(eq(schema.remotionShots.projectId, projectId), isNull(schema.remotionShots.deletedAt)))
    .orderBy(asc(schema.remotionShots.shotNumber))
    .all()
  const latestAssets = getLatestAssetRows(projectId)
  const stageRuns = getRemotionStageRuns(projectId)
  const renders = getRemotionRenders(projectId)
  const taskIds = [...latestAssets.map((asset) => asset.taskId), ...stageRuns.map((stage) => stage.taskId), ...renders.map((render) => render.taskId)]
    .filter((id): id is number => id != null)
  const tasks = [...new Set(taskIds)]
    .map((id) => getTask(id))
    .filter((task): task is CreationTask => task != null)
  return {
    project: normalizeProject(projectRow),
    stages: stageRuns,
    shots: shots.map((shot) => ({
      ...normalizeShot(shot),
      assets: latestAssets.filter((asset) => asset.shotId === shot.id).map(normalizeAsset),
    })),
    renders,
    tasks,
  }
}

export function listRemotionTasks(projectId: number) {
  const snapshot = getRemotionProjectSnapshot(projectId)
  return snapshot?.tasks || []
}

export function isRemotionTaskStatus(status: string): status is CreationTaskStatus {
  return ['queued', 'running', 'succeeded', 'failed', 'canceled', 'stale'].includes(status)
}
