import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/index.js'
import { now } from '../../../utils/response.js'
import { createImageGenerationRecord, executeImageGeneration } from '../../image-generation.js'
import { enhanceCoverPrompt } from '../../cover-prompt-enhance.js'
import {
  buildFallbackCoverDesign,
  composeCoverImage,
  composeCoverImages,
  normalizeCoverDesign,
  type CoverDesign,
} from '../../cover-image-composer.js'
import { registerTaskHandler } from '../registry.js'
import { createTask } from '../store.js'
import type { TaskContext, TaskHandler } from '../types.js'

export interface CoverGeneratePayload {
  episode_id?: number
  episodeId?: number
  prompt?: string
  config_id?: number
  configId?: number
  frame_type?: string
  frameType?: string
  rough_prompt?: string
  roughPrompt?: string
  cover_design?: CoverDesign
  coverDesign?: CoverDesign
}

export const HISTORY_FACTORY_ID = 'remotion-history-factory'

interface CoverGenerateDeps {
  executeImageGeneration?: typeof executeImageGeneration
  createImageGenerationRecord?: typeof createImageGenerationRecord
  composeCoverImages?: typeof composeCoverImages
  composeCoverImage?: typeof composeCoverImage
  enhanceCoverPrompt?: typeof enhanceCoverPrompt
}

function parseStoredCoverDesign(json: string | null | undefined): CoverDesign | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object') return parsed as CoverDesign
  } catch {
    // cover_design_json 损坏时忽略，回落到 prompt 流
  }
  return null
}

function parseEpisodeMetadata(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function isHistoryFactoryEpisode(
  episode: Pick<typeof schema.episodes.$inferSelect, 'metadata'>,
): boolean {
  const metadata = parseEpisodeMetadata(episode.metadata)
  return metadata.historyFactory === HISTORY_FACTORY_ID
    || metadata.history_factory === HISTORY_FACTORY_ID
}

function explicitMainTitle(design: CoverDesign | null | undefined): string {
  return typeof design?.main_title === 'string' ? design.main_title.trim() : ''
}

function hasUserProvidedTitle(design: CoverDesign | null | undefined): boolean {
  const marked = design as (CoverDesign & { user_provided_title?: boolean }) | null | undefined
  return Boolean(explicitMainTitle(design) && marked?.user_provided_title === true)
}

function withPrompt(design: CoverDesign | null, prompt?: string): CoverDesign | null {
  if (!design) return null
  const aiPrompt = design.ai_prompt?.trim() || prompt?.trim()
  // A text-only design is not enough to compose a cover: send it through the
  // automatic prompt flow so the image model can still produce a proper base.
  if (!aiPrompt) return null
  return { ...design, ai_prompt: aiPrompt || undefined }
}

function buildDefaultCoverPrompt(episode: typeof schema.episodes.$inferSelect): string {
  const title = episode.title?.trim() || `第${episode.episodeNumber}集`
  return [
    '电影级短剧纪录片封面，无文字、无字幕、无LOGO、无水印。',
    `围绕本集主题“${title}”呈现一个明确的人物处境或核心冲突。`,
    '主体清晰，前中后景分明，保留左上或上方低细节区域，强光影对比，缩小后仍能看懂故事，高质感电影海报构图。',
  ].join(' ')
}

function buildUserTitleCoverDesign(params: {
  coverDesign: CoverDesign
  episode: typeof schema.episodes.$inferSelect
  overridePrompt?: string
  roughPrompt?: string
}): CoverDesign {
  const { coverDesign, episode, overridePrompt, roughPrompt } = params
  const mainTitle = explicitMainTitle(coverDesign)
  if (!mainTitle) {
    throw new Error('历史工厂封面必须提供用户指定的 cover_design.main_title，禁止使用 episode.title 或 AI 标题')
  }
  const prompt = overridePrompt?.trim()
    || coverDesign.ai_prompt?.trim()
    || episode.coverPrompt?.trim()
    || roughPrompt?.trim()
    || buildDefaultCoverPrompt(episode)

  // History factory covers deliberately bypass the AI copy enhancer. The image
  // prompt may be filled from the user's prompt, but the rendered main title
  // always comes from the explicit cover design supplied by the user.
  return normalizeCoverDesign(
    { ...coverDesign, main_title: mainTitle, ai_prompt: prompt },
    '',
    episode.episodeNumber,
    prompt,
  )
}

async function buildAutomaticCoverDesign(params: {
  prompt: string
  episode: typeof schema.episodes.$inferSelect
  drama: typeof schema.dramas.$inferSelect | null
  enhancePrompt: typeof enhanceCoverPrompt
}): Promise<CoverDesign> {
  const { prompt, episode, drama, enhancePrompt } = params
  const fallback = buildFallbackCoverDesign(episode.title || '', episode.episodeNumber, prompt)

  try {
    const enhanced = await enhancePrompt({
      roughPrompt: prompt,
      episodeTitle: episode.title || undefined,
      episodeContent: episode.content || episode.scriptContent || undefined,
      episodeSynopsis: episode.description || undefined,
      dramaTitle: drama?.title || undefined,
      dramaStyle: drama?.style || undefined,
    })

    return normalizeCoverDesign({
      ...fallback,
      main_title: enhanced.main_title || fallback.main_title,
      sub_title: enhanced.sub_title || fallback.sub_title,
      kicker: enhanced.kicker || fallback.kicker,
      accent_color: enhanced.accent_color || fallback.accent_color,
      rationale: enhanced.rationale || fallback.rationale,
      // 只把 image_prompt 交给生图模型，避免中文创意说明被误当作画面指令。
      ai_prompt: enhanced.image_prompt || prompt,
    }, episode.title || '', episode.episodeNumber, prompt)
  } catch (err: any) {
    // 文案优化服务不可用时仍然生成可用封面，不能让旧 prompt 路径退化成裸底图。
    console.warn(`[cover] prompt enhancement failed for episode ${episode.id}: ${err?.message || err}`)
    return fallback
  }
}

function readPayload(payload: CoverGeneratePayload) {
  const episodeId = Number(payload.episode_id ?? payload.episodeId)
  if (!episodeId) throw new Error('episode_id is required')
  const rawFrameType = (payload.frame_type ?? payload.frameType)?.trim()
  const frameType = rawFrameType === '4:3' || rawFrameType === '3:4' ? (rawFrameType as '4:3' | '3:4') : null
  const coverDesign = (payload.cover_design ?? payload.coverDesign) || null
  return {
    episodeId,
    prompt: payload.prompt,
    roughPrompt: (payload.rough_prompt ?? payload.roughPrompt)?.trim(),
    coverDesign,
    configId: payload.config_id ?? payload.configId,
    frameType,
  }
}

export function createCoverGenerateHandler(deps: CoverGenerateDeps = {}): TaskHandler<CoverGeneratePayload> {
  const execute = deps.executeImageGeneration ?? executeImageGeneration
  const createRecord = deps.createImageGenerationRecord ?? createImageGenerationRecord
  const compose = deps.composeCoverImages ?? composeCoverImages
  const composeOne = deps.composeCoverImage ?? composeCoverImage
  const enhancePrompt = deps.enhanceCoverPrompt ?? enhanceCoverPrompt

  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<CoverGeneratePayload>) {
      const { episodeId, prompt: overridePrompt, roughPrompt, coverDesign, configId: overrideConfigId, frameType } = readPayload(ctx.payload)

      const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!episode) throw new Error(`Episode ${episodeId} not found`)

      const [drama] = episode.dramaId
        ? db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).all()
        : [null]

      // payload 未带设计时，回落到本集已存的 cover_design_json。
      // 旧 episode 只有 cover_prompt 时，会在下面自动补齐设计并走同一条合成链路。
      const storedDesign = parseStoredCoverDesign(episode.coverDesignJson)
      const requestedDesign = coverDesign ?? storedDesign
      const effectiveDesign = withPrompt(requestedDesign, episode.coverPrompt || undefined)

      if (isHistoryFactoryEpisode(episode)) {
        if (!requestedDesign || !hasUserProvidedTitle(requestedDesign)) {
          throw new Error('历史工厂封面必须提供用户指定的 cover_design.main_title，禁止自动生成封面标题')
        }
        const design = buildUserTitleCoverDesign({
          coverDesign: requestedDesign,
          episode,
          overridePrompt,
          roughPrompt,
        })
        return await runComposedCoverFlow({
          ctx,
          episodeId,
          episode,
          drama,
          coverDesign: design,
          frameType,
          configId: overrideConfigId ?? episode.imageConfigId ?? undefined,
          execute,
          createRecord,
          compose,
          composeOne,
          enhancePrompt,
        })
      }

      if (effectiveDesign) {
        return await runComposedCoverFlow({
          ctx,
          episodeId,
          episode,
          drama,
          coverDesign: effectiveDesign,
          frameType,
          configId: overrideConfigId ?? episode.imageConfigId ?? undefined,
          execute,
          createRecord,
          compose,
          composeOne,
          enhancePrompt,
        })
      }

      return await runPromptCoverFlow({
        ctx,
        episodeId,
        episode,
        drama,
        coverDesign: requestedDesign,
        overridePrompt,
        roughPrompt,
        configId: overrideConfigId ?? episode.imageConfigId ?? undefined,
        frameType,
        execute,
        createRecord,
        compose,
        composeOne,
        enhancePrompt,
      })
    },
  }
}

function coverRatioToSize(ratio: '4:3' | '3:4') {
  // The active pcore 1K tier accepts square generation reliably. The cover
  // composer performs the final 4:3 / 3:4 crop, so the base image does not
  // need to be generated at either delivery ratio.
  void ratio
  return '1024x1024'
}

interface FlowCtx {
  ctx: TaskContext<CoverGeneratePayload>
  episodeId: number
  episode: typeof schema.episodes.$inferSelect
  drama: typeof schema.dramas.$inferSelect | null
  configId?: number
  execute: typeof executeImageGeneration
  createRecord: typeof createImageGenerationRecord
  compose: typeof composeCoverImages
  composeOne: typeof composeCoverImage
  enhancePrompt: typeof enhanceCoverPrompt
}

async function runComposedCoverFlow(
  params: FlowCtx & { coverDesign: CoverDesign; frameType?: '4:3' | '3:4' | null },
) {
  const { ctx, episodeId, episode, drama, coverDesign, frameType, configId, execute, createRecord, compose, composeOne } = params

  const normalizedDesign = normalizeCoverDesign(
    coverDesign,
    episode.title || '',
    episode.episodeNumber,
    episode.coverPrompt || undefined,
  )
  const basePrompt = normalizedDesign.ai_prompt?.trim()
  if (!basePrompt) throw new Error('cover_design.ai_prompt 为空，无法生成底图')

  const ratios: Array<'4:3' | '3:4'> = frameType ? [frameType] : ['4:3', '3:4']
  ctx.progress('生成封面底图', 0, frameType ? 2 : 3)

  const baseParams = {
    episodeId,
    dramaId: episode.dramaId,
    prompt: basePrompt,
    imageType: 'cover_base',
    configId,
    style: drama?.style || undefined,
  }

  // 单张底图超时 8 分钟——封面底图比正片简单，不需要 20 分钟全超时。
  const COVER_BASE_TIMEOUT_MS = 480_000

  async function generateBase(ratio: '4:3' | '3:4') {
    const genId = createRecord({
      ...baseParams,
      size: coverRatioToSize(ratio),
      frameType: ratio,
    })
    const genPromise = execute(genId, { configId, taskContext: ctx })
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`封面 ${ratio} 底图生成超时 (${COVER_BASE_TIMEOUT_MS / 1000}s)`))
      }, COVER_BASE_TIMEOUT_MS)
    })
    try {
      return await Promise.race([genPromise, timeoutPromise])
    } finally {
      // A successful provider response must not keep the Node event loop alive
      // for the full timeout budget (or leave one timer per cover attempt).
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  // allSettled → 一张卡死不阻塞另一张；单 ratio 超时仍可交付另一张封面。
  const baseSettled = await Promise.allSettled(ratios.map(async ratio => ({ ratio, result: await generateBase(ratio) })))
  const baseResults: Array<{ ratio: '4:3' | '3:4'; result: Awaited<ReturnType<typeof execute>> }> = []
  const failedRatios: string[] = []
  for (const item of baseSettled) {
    if (item.status === 'fulfilled') {
      baseResults.push(item.value)
    } else {
      failedRatios.push(item.reason?.message || String(item.reason))
    }
  }

  if (failedRatios.length === ratios.length) {
    throw new Error(`封面底图全部失败: ${failedRatios.join('; ')}`)
  }
  if (failedRatios.length > 0) {
    ctx.progress(`部分封面底图失败，将继续合成成功的那张: ${failedRatios.join('; ')}`)
  }

  ctx.progress('合成文字与美术字', 1, frameType ? 2 : 3)

  const updates: Record<string, any> = {
    coverPrompt: basePrompt,
    coverDesignJson: JSON.stringify(normalizedDesign),
    updatedAt: now(),
  }
  const result: Record<string, any> = { episode_id: episodeId }

  if (frameType) {
    const base = baseResults[0]!.result
    const coverUrl = await composeOne({
      design: normalizedDesign,
      baseImagePath: base.local_path!,
      frameType,
    })
    if (frameType === '4:3') {
      updates.coverImage4x3Url = coverUrl
      updates.coverImage4x3GenId = null
      updates.thumbnail = coverUrl
      result.cover_4x3 = { local_path: coverUrl }
    } else {
      updates.coverImage3x4Url = coverUrl
      updates.coverImage3x4GenId = null
      updates.thumbnail = episode.coverImage4x3Url || coverUrl
      result.cover_3x4 = { local_path: coverUrl }
    }
  } else {
    const base4x3 = baseResults.find(item => item.ratio === '4:3')!.result
    const base3x4 = baseResults.find(item => item.ratio === '3:4')!.result
    const composed = await compose({
      design: normalizedDesign,
      baseImage4x3Path: base4x3.local_path!,
      baseImage3x4Path: base3x4.local_path!,
    })
    updates.coverImage4x3Url = composed.cover4x3Url
    updates.coverImage3x4Url = composed.cover3x4Url
    updates.coverImage4x3GenId = null
    updates.coverImage3x4GenId = null
    updates.thumbnail = composed.cover4x3Url
    result.cover_4x3 = { local_path: composed.cover4x3Url }
    result.cover_3x4 = { local_path: composed.cover3x4Url }
  }

  db.update(schema.episodes).set(updates).where(eq(schema.episodes.id, episodeId)).run()

  ctx.progress('封面生成完成', frameType ? 2 : 3, frameType ? 2 : 3)
  ctx.event('cover.generated', result)
  return result
}

async function runPromptCoverFlow(
  params: FlowCtx & {
    coverDesign?: CoverDesign | null
    overridePrompt?: string
    roughPrompt?: string
    frameType: '4:3' | '3:4' | null
  },
) {
  const { ctx, episodeId, episode, drama, coverDesign, overridePrompt, roughPrompt, frameType, configId, execute, createRecord, compose, composeOne, enhancePrompt } = params

  let prompt = overridePrompt?.trim() || episode.coverPrompt || null
  if (!prompt && roughPrompt) prompt = roughPrompt
  if (!prompt) prompt = buildDefaultCoverPrompt(episode)

  const automaticDesign = await buildAutomaticCoverDesign({ prompt, episode, drama, enhancePrompt })
  // A user may provide only the copy fields. Keep those fields while the
  // automatic flow supplies the missing image prompt and fallback metadata.
  const design = coverDesign
    ? normalizeCoverDesign({
        ...automaticDesign,
        ...coverDesign,
        ai_prompt: coverDesign.ai_prompt?.trim() || automaticDesign.ai_prompt,
      }, episode.title || '', episode.episodeNumber, prompt)
    : automaticDesign
  // 旧 prompt 流现在也使用统一的“无字底图 + 程序排版”流程，保证所有 episode 的成品质量一致。
  return await runComposedCoverFlow({
    ctx,
    episodeId,
    episode,
    drama,
    coverDesign: design,
    configId,
    execute,
    createRecord,
    compose,
    composeOne,
    enhancePrompt,
    frameType,
  })
}

export function scheduleCoverGeneration(
  episodeId: number,
  payload?: {
    prompt?: string
    configId?: number
    frameType?: string
    roughPrompt?: string
    coverDesign?: CoverDesign
  },
) {
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!episode) throw new Error(`Episode ${episodeId} not found`)

  const coverDesign = payload?.coverDesign
  const storedDesign = parseStoredCoverDesign(episode.coverDesignJson)
  const requestedDesign = coverDesign ?? storedDesign
  if (isHistoryFactoryEpisode(episode) && !hasUserProvidedTitle(requestedDesign)) {
    throw new Error('历史工厂封面必须先提供用户指定的 cover_design.main_title')
  }
  const explicitPrompt = payload?.prompt?.trim()
  const roughPrompt = payload?.roughPrompt?.trim()
  const defaultPrompt = buildDefaultCoverPrompt(episode)
  const hasPrompt = explicitPrompt || episode.coverPrompt || roughPrompt || requestedDesign?.ai_prompt || episode.title || defaultPrompt
  if (!hasPrompt) throw new Error('封面提示词为空')

  const frameType = payload?.frameType?.trim()
  const normalizedFrameType = frameType === '4:3' || frameType === '3:4' ? frameType : null
  const idempotencyKey = normalizedFrameType
    ? `cover.generate:episode:${episodeId}:${normalizedFrameType}`
    : `cover.generate:episode:${episodeId}`

  return createTask({
    type: 'cover.generate',
    dramaId: episode.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey,
    payload: {
      episode_id: episodeId,
      prompt: explicitPrompt || undefined,
      rough_prompt: roughPrompt || (!explicitPrompt && !episode.coverPrompt && !coverDesign?.ai_prompt ? defaultPrompt : undefined),
      cover_design: coverDesign,
      config_id: payload?.configId,
      frame_type: normalizedFrameType || undefined,
    },
    maxAttempts: 2,
  })
}

export function registerCoverGenerateHandler() {
  registerTaskHandler('cover.generate', createCoverGenerateHandler())
}
