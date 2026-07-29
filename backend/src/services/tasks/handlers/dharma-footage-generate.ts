import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../../../db/index.js'
import { now } from '../../../utils/response.js'
import { createImageGenerationRecord, executeImageGeneration } from '../../image-generation.js'
import { createVideoGenerationRecord, executeVideoGeneration } from '../../video-generation.js'
import {
  buildDharmaImagePrompt,
  findDharmaImageStyle,
  isCanonicalDharmaImageStyleSnapshot,
  normalizeDharmaEmotion,
  normalizeDharmaImageMove,
  parseDharmaImageStyleSnapshot,
  snapshotDharmaImageStyle,
  validateDharmaStyleEmotion,
  type DharmaImageMove,
  type DharmaImageStyleSnapshot,
} from '../../dharma-image-style.js'
import {
  buildDharmaSemanticGenerationPrompt,
  buildDharmaVisualRoleGenerationPrompt,
  normalizeDharmaVisualRole,
  normalizeDharmaVisualSemanticContract,
  parseDharmaCell,
  probeMediaDurationSec,
  resolveDharmaAssignedAssetPath,
  validateDharmaVideoProvenance,
  type DharmaCell,
  type DharmaNarrativeSemanticPlan,
  type DharmaShotFunction,
} from '../../dharma-props.js'
import { registerTaskHandler } from '../registry.js'
import type { TaskContext, TaskHandler } from '../types.js'
import { parseAIConfigModels } from '../../ai.js'

export interface DharmaFootageGeneratePayload {
  episode_id?: number
  episodeId?: number
  storyboard_ids?: number[]
  storyboardIds?: number[]
  kind?: 'image' | 'video'
  prompt?: string
  config_id?: number
  configId?: number
  model?: string
  reference_images?: string[]
  referenceImages?: string[]
  image_style?: string
  imageStyle?: string
  style_id?: string
  role?: string
  emotion?: string
  move?: DharmaImageMove
  style_snapshot?: DharmaImageStyleSnapshot
  shot_function?: DharmaShotFunction
  shotFunction?: DharmaShotFunction
  semantic?: DharmaNarrativeSemanticPlan
}

interface DharmaFootageGenerateDeps {
  createImageGenerationRecord?: typeof createImageGenerationRecord
  executeImageGeneration?: typeof executeImageGeneration
  createVideoGenerationRecord?: typeof createVideoGenerationRecord
  executeVideoGeneration?: typeof executeVideoGeneration
}

function abortError(): Error {
  const error = new Error('Dharma 素材生成已取消')
  error.name = 'AbortError'
  return error
}

function throwIfCanceled(ctx: TaskContext<DharmaFootageGeneratePayload>) {
  if (ctx.signal.aborted || ctx.isCancelRequested()) throw abortError()
}

function readPayload(payload: DharmaFootageGeneratePayload) {
  const episodeId = Number(payload.episode_id ?? payload.episodeId)
  const rawStoryboardIds = payload.storyboard_ids ?? payload.storyboardIds
  const storyboardIds = Array.isArray(rawStoryboardIds)
    ? rawStoryboardIds.map(Number).sort((a, b) => a - b)
    : []
  const kind = payload.kind
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
  const configId = Number(payload.config_id ?? payload.configId)
  const model = typeof payload.model === 'string' ? payload.model.trim() : ''
  const rawReferenceImages = payload.reference_images ?? payload.referenceImages
  const referenceImages = rawReferenceImages === undefined
    ? []
    : Array.isArray(rawReferenceImages)
      ? Array.from(new Set(rawReferenceImages.map((value) => String(value ?? '').trim())))
      : []
  const styleId = typeof (payload.style_id ?? payload.image_style ?? payload.imageStyle) === 'string'
    ? String(payload.style_id ?? payload.image_style ?? payload.imageStyle)
    : ''
  const style = findDharmaImageStyle(styleId)
  const role = normalizeDharmaVisualRole(payload.role)
  const emotion = normalizeDharmaEmotion(payload.emotion)
  if (!Number.isInteger(episodeId) || episodeId <= 0) throw new Error('episode_id is required')
  if (!storyboardIds.length || storyboardIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('storyboard_ids must be a non-empty array of positive integers')
  }
  if (new Set(storyboardIds).size !== storyboardIds.length) throw new Error('storyboard_ids contains duplicates')
  if (kind !== 'image' && kind !== 'video') throw new Error('kind must be image or video')
  if (!prompt) throw new Error('prompt is required')
  if (rawReferenceImages !== undefined && !Array.isArray(rawReferenceImages)) {
    throw new Error('reference_images must be an array')
  }
  if (referenceImages.length > 3 || referenceImages.some((value) => !value)) {
    throw new Error('reference_images must contain at most 3 non-empty image paths')
  }
  if (kind !== 'image' && referenceImages.length > 0) {
    throw new Error('reference_images is only supported for image generation')
  }
  if (!Number.isInteger(configId) || configId <= 0) throw new Error('config_id is required')
  if (!style) throw new Error('style_id is required and must reference a known Dharma style')
  if ('error' in role) throw new Error(role.error)
  if ('error' in emotion) throw new Error(emotion.error)
  const semanticContract = normalizeDharmaVisualSemanticContract({
    role: role.role,
    kind,
    shotFunction: payload.shot_function ?? payload.shotFunction,
    semantic: payload.semantic,
  })
  if ('error' in semanticContract) throw new Error(semanticContract.error)
  const styleError = validateDharmaStyleEmotion(style, emotion.emotion)
  if (styleError) throw new Error(styleError)
  const styleSnapshot = payload.style_snapshot === undefined
    ? snapshotDharmaImageStyle(style)
    : parseDharmaImageStyleSnapshot(payload.style_snapshot)
  if (!styleSnapshot || !isCanonicalDharmaImageStyleSnapshot(style, styleSnapshot)) {
    throw new Error('style_snapshot is invalid or does not match the production style catalog')
  }
  const move = normalizeDharmaImageMove(payload.move ?? styleSnapshot.defaultMove)
  if ('error' in move) throw new Error(move.error)
  return {
    episodeId,
    storyboardIds,
    kind,
    prompt,
    configId,
    model,
    referenceImages,
    style,
    styleSnapshot,
    role: role.role,
    emotion: emotion.emotion,
    move: move.move,
    ...semanticContract,
  }
}

function imageSizeForAspectRatio(
  aspectRatio: string | null | undefined,
  usePcore1k = false,
) {
  if (usePcore1k) {
    if (aspectRatio === '9:16') return '720x1280'
    if (aspectRatio === '1:1') return '960x960'
    return '1280x720'
  }
  if (aspectRatio === '9:16') return '1080x1920'
  if (aspectRatio === '1:1') return '1024x1024'
  return '1920x1080'
}

function findExistingDharmaImageGeneration(taskId: number, episodeId: number): number | null {
  const events = db.select().from(schema.creationTaskEvents)
    .where(and(
      eq(schema.creationTaskEvents.taskId, taskId),
      eq(schema.creationTaskEvents.eventType, 'dharma.footage.generation'),
    ))
    .all()
    .sort((a, b) => b.id - a.id)

  for (const event of events) {
    try {
      const data = JSON.parse(event.dataJson || '{}') as { kind?: unknown; image_generation_id?: unknown }
      const generationId = Number(data.image_generation_id)
      if (data.kind !== 'image' || !Number.isInteger(generationId) || generationId <= 0) continue
      const [generation] = db.select().from(schema.imageGenerations)
        .where(and(
          eq(schema.imageGenerations.id, generationId),
          eq(schema.imageGenerations.episodeId, episodeId),
          eq(schema.imageGenerations.imageType, 'dharma_footage'),
        ))
        .all()
      if (generation) return generation.id
    } catch {
      // Malformed historical event data cannot be a reusable generation.
    }
  }
  return null
}

function preserveDharmaEditorialMetadata(existing: DharmaCell | null) {
  return {
    ...(existing?.theme ? { theme: existing.theme } : {}),
    ...(existing?.quote ? { quote: existing.quote } : {}),
  }
}

function ensureSelectedStoryboardsAreContiguous(storyboards: Array<typeof schema.storyboards.$inferSelect>) {
  const numbers = storyboards.map((storyboard) => storyboard.storyboardNumber).sort((a, b) => a - b)
  if (numbers.some((number, index) => index > 0 && number !== numbers[index - 1] + 1)) {
    throw new Error('storyboard_ids must describe one contiguous Dharma visual segment')
  }
}

export function createDharmaFootageGenerateHandler(deps: DharmaFootageGenerateDeps = {}): TaskHandler<DharmaFootageGeneratePayload> {
  const createImageRecord = deps.createImageGenerationRecord ?? createImageGenerationRecord
  const executeImage = deps.executeImageGeneration ?? executeImageGeneration
  const createVideoRecord = deps.createVideoGenerationRecord ?? createVideoGenerationRecord
  const executeVideo = deps.executeVideoGeneration ?? executeVideoGeneration

  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx) {
      const {
        episodeId,
        storyboardIds,
        kind,
        prompt,
        configId,
        model,
        referenceImages,
        style,
        styleSnapshot,
        role,
        emotion,
        move,
        shotFunction,
        semantic,
      } = readPayload(ctx.payload)
      if (ctx.episodeId != null && ctx.episodeId !== episodeId) {
        throw new Error('Task episode ownership does not match payload')
      }
      const [episode] = db.select().from(schema.episodes)
        .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
        .all()
      if (!episode) throw new Error(`Episode ${episodeId} not found`)

      const [config] = db.select().from(schema.aiServiceConfigs)
        .where(eq(schema.aiServiceConfigs.id, configId))
        .all()
      if (!config?.isActive || config.serviceType !== kind) {
        throw new Error(`${kind} config is missing or inactive`)
      }
      const configuredModels = parseAIConfigModels(config.model)
      if (model && !configuredModels.includes(model)) {
        throw new Error(`model ${model} is not configured for this ${kind} service`)
      }
      const selectedModel = model || configuredModels[0] || ''

      const storyboards = db.select().from(schema.storyboards)
        .where(and(
          eq(schema.storyboards.episodeId, episodeId),
          inArray(schema.storyboards.id, storyboardIds),
        ))
        .all()
      if (storyboards.length !== storyboardIds.length) {
        throw new Error('One or more storyboard_ids no longer belong to the episode')
      }
      ensureSelectedStoryboardsAreContiguous(storyboards)
      if (referenceImages.length > 0) {
        const episodeStoryboards = db.select().from(schema.storyboards)
          .where(eq(schema.storyboards.episodeId, episodeId))
          .all()
        const assignedEpisodeImages = new Set(episodeStoryboards
          .map((storyboard) => parseDharmaCell(storyboard.gridCells)?.image?.src)
          .filter((src): src is string => Boolean(src)))
        for (const src of referenceImages) {
          if (!assignedEpisodeImages.has(src)) {
            throw new Error(`reference image must already be assigned in this Episode: ${src}`)
          }
          resolveDharmaAssignedAssetPath(src, 'image')
        }
      }
      throwIfCanceled(ctx)

      ctx.progress(`Dharma 段落：生成${kind === 'image' ? '图片' : '视频'}`, 0, 3)
      let localPath: string
      let generationId: number
      let video: DharmaCell['video'] | undefined
      if (kind === 'image') {
        const styledPrompt = buildDharmaImagePrompt(prompt, style.id, {
          emotion,
          spatialContext: [
            buildDharmaVisualRoleGenerationPrompt(role),
            buildDharmaSemanticGenerationPrompt(shotFunction, semantic),
          ].join('. '),
          snapshot: styleSnapshot,
        })
        const existingGenerationId = findExistingDharmaImageGeneration(ctx.taskId, episodeId)
        generationId = existingGenerationId ?? createImageRecord({
          episodeId,
          dramaId: episode.dramaId,
          prompt: styledPrompt.prompt,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(referenceImages.length ? { referenceImages } : {}),
          size: imageSizeForAspectRatio(
            episode.aspectRatio,
            config.provider?.toLowerCase() === 'pcore' && selectedModel === 'gpt-image-2-1k',
          ),
          imageType: 'dharma_footage',
          configId,
          style: styledPrompt.style.id,
        })
        if (!existingGenerationId) {
          ctx.event('dharma.footage.generation', {
            kind,
            image_generation_id: generationId,
            image_style: styledPrompt.style.id,
          })
        }
        const result = await executeImage(generationId, { configId, taskContext: ctx })
        localPath = result.local_path
        const [generation] = db.select().from(schema.imageGenerations)
          .where(eq(schema.imageGenerations.id, generationId))
          .all()
        if (!generation
          || generation.status !== 'completed'
          || generation.episodeId !== episodeId
          || generation.imageType !== 'dharma_footage'
          || generation.localPath !== localPath
          || generation.style !== style.id) {
          throw new Error(`Image generation ${generationId} did not persist the expected completed Dharma asset`)
        }
      } else {
        generationId = createVideoRecord({
          dramaId: episode.dramaId,
          prompt,
          duration: 5,
          aspectRatio: episode.aspectRatio || '16:9',
          configId,
        })
        ctx.event('dharma.footage.generation', { kind, video_generation_id: generationId })
        const result = await executeVideo(generationId, { configId, taskContext: ctx })
        localPath = result.local_path
        const [generation] = db.select().from(schema.videoGenerations)
          .where(eq(schema.videoGenerations.id, generationId))
          .all()
        if (!generation || generation.status !== 'completed' || generation.localPath !== localPath) {
          throw new Error(`Video generation ${generationId} did not persist a completed local asset`)
        }
        const durationSec = await probeMediaDurationSec(resolveDharmaAssignedAssetPath(localPath, 'video'))
        if (durationSec === null) throw new Error(`Unable to read generated video duration: ${localPath}`)
        video = {
          src: localPath,
          ...(generation.provider ? { provider: generation.provider } : {}),
          durationSec,
        }
        const provenanceError = validateDharmaVideoProvenance(video)
        if (provenanceError) throw new Error(`Generated video is not an eligible Dharma asset: ${provenanceError}`)
      }

      if (!localPath) throw new Error(`Generated ${kind} has no local asset path`)
      resolveDharmaAssignedAssetPath(localPath, kind)
      throwIfCanceled(ctx)
      ctx.progress('Dharma 段落：写入素材指派', 2, 3)
      const updatedAt = now()
      // The source is now a completed local asset. From this point the task's
      // observable side effect is the assignment itself, so a racing cancel
      // must not leave a canceled task that has already changed the segment.
      ctx.markCommitPoint?.()
      db.transaction((tx) => {
        for (const storyboardId of storyboardIds) {
          const [storyboard] = tx.select().from(schema.storyboards)
            .where(and(
              eq(schema.storyboards.id, storyboardId),
              eq(schema.storyboards.episodeId, episodeId),
            ))
            .all()
          if (!storyboard) throw new Error(`Storyboard ${storyboardId} no longer belongs to Episode ${episodeId}`)
          const existing = parseDharmaCell(storyboard.gridCells)
          const cell: DharmaCell = {
            dharma: 1,
            role,
            emotion,
            styleId: style.id,
            ...(shotFunction ? { shotFunction } : {}),
            ...(semantic ? { semantic } : {}),
            ...preserveDharmaEditorialMetadata(existing),
            ...(kind === 'image'
              ? { image: { src: localPath, generatedSegmentTaskId: ctx.taskId, move } }
              : { video }),
          }
          tx.update(schema.storyboards)
            .set({ gridCells: JSON.stringify(cell), updatedAt })
            .where(and(
              eq(schema.storyboards.id, storyboard.id),
              eq(schema.storyboards.episodeId, episodeId),
            ))
            .run()
        }
      })
      ctx.progress('Dharma 段落素材已指派', 3, 3)

      return {
        kind,
        role,
        emotion,
        style_id: style.id,
        ...(shotFunction ? { shot_function: shotFunction } : {}),
        ...(semantic ? { semantic } : {}),
        ...(referenceImages.length ? { reference_images: referenceImages } : {}),
        ...(kind === 'image'
          ? { image_generation_id: generationId, image_style: style.id, move }
          : { video_generation_id: generationId }),
        local_path: localPath,
        storyboard_ids: storyboardIds,
      }
    },
  }
}

export function registerDharmaFootageGenerateHandler() {
  registerTaskHandler('dharma.footage_generate', createDharmaFootageGenerateHandler())
}
