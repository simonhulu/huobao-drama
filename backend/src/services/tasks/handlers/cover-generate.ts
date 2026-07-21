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
  // APIMart gpt-image-2 实测只支持 16:9 / 9:16 / 1:1，
  // 4:3 与 3:4 会被拒绝。先用相近的横竖屏尺寸生成，前端 CSS 按 4:3/3:4 裁剪。
  return ratio === '4:3' ? '1920x1080' : '1080x1920'
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

  async function generateBase(ratio: '4:3' | '3:4') {
    const genId = createRecord({
      ...baseParams,
      size: coverRatioToSize(ratio),
      frameType: ratio,
    })
    return await execute(genId, { configId, taskContext: ctx })
  }

  const baseResults = await Promise.all(ratios.map(async ratio => ({ ratio, result: await generateBase(ratio) })))
  if (baseResults.some(item => !item.result.local_path)) throw new Error('封面底图生成未完成')

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
  const explicitPrompt = payload?.prompt?.trim()
  const roughPrompt = payload?.roughPrompt?.trim()
  const defaultPrompt = buildDefaultCoverPrompt(episode)
  const hasPrompt = explicitPrompt || episode.coverPrompt || roughPrompt || coverDesign?.ai_prompt || episode.title || defaultPrompt
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
