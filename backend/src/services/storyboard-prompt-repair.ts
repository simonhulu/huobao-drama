import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { aiFetch } from './ai-client.js'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { joinProviderUrl } from './adapters/url.js'
import { stripVideoTags } from './adapters/prompt-utils.js'

const DEFAULT_REPAIR_MODEL = 'deepseek-v4-flash'

export interface StoryboardPromptRepairResult {
  repairedPrompt: string
  model: string
}

function getRepairModel(): string {
  return (process.env.STORYBOARD_PROMPT_REPAIR_MODEL || DEFAULT_REPAIR_MODEL).trim()
}

function parseRepairedPrompt(content: string): string {
  let text = content.trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const value = parsed.image_prompt ?? parsed.repaired_prompt ?? parsed.prompt
    if (typeof value === 'string') text = value
  } catch {
    text = text.replace(/^image_prompt\s*[:：]\s*/i, '')
  }

  const cleaned = stripVideoTags(text)
    .replace(/^["'“”]+/, '')
    .replace(/["'“”]+$/, '')
    .trim()

  if (!cleaned) throw new Error('Prompt repair returned empty image_prompt')
  return cleaned
}

function buildRepairMessages(input: {
  errorMessage: string
  originalPrompt: string | null
  storyboard: typeof schema.storyboards.$inferSelect
  previousPrompt?: string
  retryReason?: string
}) {
  return [
    {
      role: 'system',
      content: [
        '你是影视分镜图片提示词修正器。',
        '任务：把被图片生成安全系统拒绝的镜头 prompt 改写成可生成的单帧静态画面提示词。',
        '关键原则：修正的是“图片要生成的视觉任务”，不是替换敏感词。',
        '必须保留剧情意图、角色关系、场景、景别、光线、氛围和画面质量。',
        '如果原任务要求直接生成敏感对象、危险行为、受害者身份、伤害过程或可模仿细节，必须把这些内容移出画面。',
        '用安全的视觉替代承载同一剧情功能：旧照片、空座位、雨窗、人物表情、手部停顿、空间压抑、象征物、后果和反应。',
        '例如：不要把“自伤/死亡/未成年受害者”作为画面主体；改成“被珍藏的日常旧照 + 家属悲痛反应 + 环境氛围”。',
        '例如：不要把“危险操作/暴力动作”作为画面主体；改成“操作后的环境痕迹、远景、角色反应、警示性氛围”。',
        '最终 prompt 只能描述一个安全、可拍摄、静态的影视画面；不能解释剧情背景中的敏感事件。',
        '只输出 JSON：{"image_prompt":"..."}，不要输出解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        provider_error: input.errorMessage,
        retry_instruction: input.previousPrompt
          ? `上一版修正失败：${input.retryReason || '仍然在执行原来的敏感视觉任务'}。必须改变“画面要生成的任务”，用间接、安全、象征性的视觉表达同一剧情功能。`
          : undefined,
        previous_repaired_prompt: input.previousPrompt,
        original_image_generation_prompt: input.originalPrompt,
        storyboard: {
          title: input.storyboard.title,
          image_prompt: input.storyboard.imagePrompt,
          action: input.storyboard.action,
          result: input.storyboard.result,
          dialogue: input.storyboard.dialogue,
          atmosphere: input.storyboard.atmosphere,
          location: input.storyboard.location,
          time: input.storyboard.time,
          shot_type: input.storyboard.shotType,
          angle: input.storyboard.angle,
        },
      }, null, 2),
    },
  ]
}

async function requestPromptRepair(input: {
  url: string
  provider: string
  apiKey: string
  model: string
  errorMessage: string
  originalPrompt: string | null
  storyboard: typeof schema.storyboards.$inferSelect
  previousPrompt?: string
  retryReason?: string
}) {
  const resp = await aiFetch(input.provider || 'text', input.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      messages: buildRepairMessages({
        errorMessage: input.errorMessage,
        originalPrompt: input.originalPrompt,
        storyboard: input.storyboard,
        previousPrompt: input.previousPrompt,
        retryReason: input.retryReason,
      }),
      temperature: 0.2,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
    }),
  }, { timeoutMs: 60_000, maxAttempts: 2 })

  const data = await resp.json() as any
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('Prompt repair response missing choices[0].message.content')
  return parseRepairedPrompt(content)
}

function textSimilarity(a: string | null | undefined, b: string): number {
  const left = normalizeForSimilarity(a || '')
  const right = normalizeForSimilarity(b)
  if (!left || !right) return 0
  if (left === right) return 1

  const leftBigrams = makeBigrams(left)
  const rightBigrams = makeBigrams(right)
  if (leftBigrams.size === 0 || rightBigrams.size === 0) return 0

  let overlap = 0
  for (const item of leftBigrams) {
    if (rightBigrams.has(item)) overlap++
  }
  return (2 * overlap) / (leftBigrams.size + rightBigrams.size)
}

function normalizeForSimilarity(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')
}

function makeBigrams(value: string): Set<string> {
  if (value.length <= 1) return new Set(value ? [value] : [])
  const result = new Set<string>()
  for (let i = 0; i < value.length - 1; i++) {
    result.add(value.slice(i, i + 2))
  }
  return result
}

function shouldRetrySemanticRepair(originalPrompt: string | null, repairedPrompt: string): string | null {
  const similarity = textSimilarity(originalPrompt, repairedPrompt)
  if (similarity >= 0.72) {
    return `修正后的 prompt 与原 prompt 过于接近，相似度 ${similarity.toFixed(2)}`
  }
  return null
}

export async function repairStoryboardImagePromptForGeneration(
  generationId: number,
  errorMessage: string,
): Promise<StoryboardPromptRepairResult> {
  const [generation] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, generationId))
    .all()
  if (!generation) throw new Error(`Image generation ${generationId} not found`)
  if (!generation.storyboardId) throw new Error(`Image generation ${generationId} is not bound to a storyboard`)

  const [storyboard] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, generation.storyboardId))
    .all()
  if (!storyboard) throw new Error(`Storyboard ${generation.storyboardId} not found`)

  const textConfig = getTextConfig()
  const model = getRepairModel()
  const url = joinProviderUrl(getTextProviderBaseUrl(textConfig), '', '/chat/completions')

  let repairedPrompt = await requestPromptRepair({
    url,
    provider: textConfig.provider,
    apiKey: textConfig.apiKey,
    model,
    errorMessage,
    originalPrompt: generation.prompt,
    storyboard,
  })
  const retryReason = shouldRetrySemanticRepair(generation.prompt, repairedPrompt)
  if (retryReason) {
    repairedPrompt = await requestPromptRepair({
      url,
      provider: textConfig.provider,
      apiKey: textConfig.apiKey,
      model,
      errorMessage,
      originalPrompt: generation.prompt,
      storyboard,
      previousPrompt: repairedPrompt,
      retryReason,
    })
  }

  const ts = now()

  db.transaction((tx) => {
    tx.update(schema.storyboards)
      .set({
        imagePrompt: repairedPrompt,
        imagePromptFinal: true,
        updatedAt: ts,
      })
      .where(eq(schema.storyboards.id, storyboard.id))
      .run()

    tx.update(schema.imageGenerations)
      .set({
        prompt: repairedPrompt,
        status: 'processing',
        taskId: null,
        errorMsg: null,
        lastErrorCode: null,
        lastErrorDetail: null,
        updatedAt: ts,
      })
      .where(eq(schema.imageGenerations.id, generationId))
      .run()
  })

  return { repairedPrompt, model }
}
