import { z } from 'zod'
import type { CoverJsonRequest } from './cover-prompt-enhance.js'
import { localModelEndpoint } from './history-script-processing.js'
import { normalizeVideoTitle } from './video-title-format.js'

export const HISTORY_TITLE_REWRITE_MODEL = 'qwen3.5-9b-writing-dpo@q4_k_s' as const
export const LEGACY_HISTORY_TITLE_REWRITE_PROMPT = '请将下面这个标题改写为更自然、更有人类写作风格的表达，要求字数不超过25个字。更有情绪和冲突，能激起人的好奇心和求知欲' as const
export const HISTORY_TITLE_REWRITE_PROMPT = '请将下面这个标题改写为更自然、更有人类写作风格的表达，要求字数不超过16个字。更有情绪和冲突，能激起人的好奇心和求知欲' as const

const batchSchema = z.object({
  purpose: z.literal('history-title-rewrite'), sourceTitle: z.string().optional(), script: z.string().trim().min(1),
  titles: z.array(z.object({ reference_id: z.string().regex(/^R[1-9]\d*$/), original_title: z.string().min(1).max(160),
    rewrite_guidance: z.string().trim().min(1).max(300).optional(),
  }).strict()).min(1).max(5),
  feedback: z.string().optional(), format: z.string().optional(),
}).strict().refine(value => new Set(value.titles.map(item => item.reference_id)).size === value.titles.length)
const correctionSchema = z.object({
  purpose: z.literal('history-title-correction'),
  previous_output: z.object({ rewrites: z.array(z.object({ reference_id: z.string(), title: z.string().min(1) })).min(1).max(5) }),
})

export const requestHistoryTitleRewrites: CoverJsonRequest = async (messages) => {
  let input: z.infer<typeof batchSchema>
  let previousTitles: z.infer<typeof correctionSchema>['previous_output']['rewrites'] = []
  try {
    input = batchSchema.parse(JSON.parse(messages[1]?.content || ''))
    if (messages.length > 2) {
      previousTitles = correctionSchema.parse(JSON.parse(messages.at(-1)?.content || '')).previous_output.rewrites
      if (previousTitles.length !== input.titles.length || new Set(previousTitles.map(item => item.reference_id)).size !== input.titles.length ||
        previousTitles.some(item => !input.titles.some(parent => parent.reference_id === item.reference_id))) throw new Error('Invalid correction parents')
    }
  } catch {
    throw new Error('LM Studio标题改写输入不完整，未调用其他模型')
  }
  let endpoint: URL
  try {
    endpoint = localModelEndpoint('/v1/chat/completions')
  } catch {
    throw new Error('LM Studio标题改写仅允许无凭据的本地服务地址')
  }
  const rewrites: { reference_id: string; title: string; adaptation: string }[] = []
  for (const item of input.titles) {
    const previous = previousTitles.find(title => title.reference_id === item.reference_id)
    const parent = item.original_title + (item.rewrite_guidance ? `\n\n正文事实边界：${item.rewrite_guidance}` : '')
    const titleInput = previous
      ? `${parent}\n\n上次改写：${previous.title}\n这批标题重复，请换一种表达重新改写，不要重复上次的标题。`
      : parent
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ model: HISTORY_TITLE_REWRITE_MODEL,
          messages: [
            { role: 'system', content: HISTORY_TITLE_REWRITE_PROMPT },
            { role: 'user', content: titleInput },
            // This model's template already opens <think>; close it without nesting another block.
            { role: 'assistant', content: '</think>\n\n' },
          ], temperature: 0.3, repeat_penalty: 1, seed: 42, max_tokens: 256, stream: false,
        }),
        signal: AbortSignal.timeout(90_000),
      })
    } catch {
      throw new Error('LM Studio标题改写请求失败或超时，未调用其他模型')
    }
    if (!response.ok) throw new Error(`LM Studio标题改写服务返回${response.status}，未调用其他模型`)
    let data: { error?: unknown; choices?: { finish_reason?: string; message?: { content?: unknown } }[] }
    try { data = await response.json() } catch { throw new Error('LM Studio标题改写响应格式无效') }
    if (!data || data.error) throw new Error('LM Studio标题改写服务返回错误')
    const choice = data.choices?.[0]
    if (choice?.finish_reason === 'length') throw new Error('LM Studio标题改写输出被截断')
    const content = choice?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('LM Studio未返回标题')
    const rawTitle = content
    // Keep the model's wording and punctuation for manual editing, even when not ready to publish.
    const title = normalizeVideoTitle(rawTitle)
    if (!title || !/[\p{L}\p{N}]/u.test(title)) throw new Error('LM Studio标题必须有实际文字或数字')
    rewrites.push({ reference_id: item.reference_id, title,
      adaptation: `LM Studio ${HISTORY_TITLE_REWRITE_MODEL}按指定提示词逐条改写。${title !== rawTitle ? `仅规范化标点与空格，模型原文：${rawTitle}` : ''}` })
  }
  return { rewrites }
}
