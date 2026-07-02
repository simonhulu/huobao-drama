import { z } from 'zod'
import { aiFetch } from './ai-client.js'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { joinProviderUrl } from './adapters/url.js'

const SMART_HOOK_DESIGN_MODEL = 'deepseek-v4-flash'

const episodeHookSchema = z.object({
  episode_number: z.number().int().positive(),
  opening_hook: z.string().min(1),
  cliffhanger_hook: z.string().min(1),
  recap_script: z.string().optional(),
})

const hookDesignPayloadSchema = z.object({
  series_hook: z.string().min(1),
  episode_hooks: z.array(episodeHookSchema).min(1),
})

export interface HookDesignInput {
  dramaTitle?: string | null
  episodes: Array<{
    episodeNumber: number
    content: string
    summary: string
    coveredBeatIds: string[]
  }>
  plotChain: Array<{
    beatId: string
    summary: string
    mustKeepContext: string
  }>
}

export interface EpisodeHooks {
  episodeNumber: number
  openingHook: string
  cliffhangerHook: string
  recapScript?: string
}

export interface HookDesignResult {
  seriesHook: string
  episodeHooks: EpisodeHooks[]
}

function buildSystemPrompt(): string {
  return [
    '你是短剧钩子设计师。',
    '你已经收到了完整的分集结果和剧情推进链。',
    '你的任务是为每一集生成：',
    '1. opening_hook：recap 结束后、正文开始前的过渡钩子，直接抛出本集核心冲突，不要交代前情。',
    '2. cliffhanger_hook：本集结尾悬念，让观众想看下一集。',
    '3. recap_script（从第二集开始）：用上一集画面+新配音生成前情提要，40-70字，概括上一集关键事件。',
    '4. series_hook：全剧一句话核心钩子，用于封面标题。',
    'recap_script 必须基于上一集的 cliffhanger_hook 和 must_keep_context 生成。',
    '第一集不需要 recap_script。',
    '只通过函数调用提交结果，不要输出额外正文。',
  ].join('\n')
}

function buildUserPrompt(input: HookDesignInput): string {
  return [
    `剧名：${input.dramaTitle?.trim() || '未命名项目'}`,
    '分集结果：',
    JSON.stringify(input.episodes.map(ep => ({
      episode_number: ep.episodeNumber,
      summary: ep.summary,
      covered_beat_ids: ep.coveredBeatIds,
    })), null, 2),
    '',
    '剧情推进链：',
    JSON.stringify(input.plotChain.map(b => ({
      beat_id: b.beatId,
      summary: b.summary,
      must_keep_context: b.mustKeepContext,
    })), null, 2),
    '',
    '要求：',
    '1. series_hook 用一句话概括全剧最大冲突。',
    '2. 第一集 recap_script 为空。',
    '3. 从第二集开始，recap_script 必须让观众理解当前集的前因。',
    '4. opening_hook 不再承担前情交代，只负责把观众拉进本集冲突。',
  ].join('\n')
}

export async function designHooksForEpisodes(input: HookDesignInput): Promise<HookDesignResult> {
  const textConfig = getTextConfig()
  const providerBase = getTextProviderBaseUrl(textConfig)
  const url = joinProviderUrl(providerBase, '', '/chat/completions')
  const model = process.env.SMART_HOOK_DESIGN_MODEL || SMART_HOOK_DESIGN_MODEL

  const response = await aiFetch(textConfig.provider || 'text', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${textConfig.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      temperature: 0.3,
      max_tokens: 8000,
      tools: [{
        type: 'function',
        function: {
          name: 'submit_hook_design',
          description: '提交全剧钩子设计',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              series_hook: { type: 'string' },
              episode_hooks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    episode_number: { type: 'integer' },
                    opening_hook: { type: 'string' },
                    cliffhanger_hook: { type: 'string' },
                    recap_script: { type: 'string' },
                  },
                  required: ['episode_number', 'opening_hook', 'cliffhanger_hook'],
                },
              },
            },
            required: ['series_hook', 'episode_hooks'],
          },
        },
      }],
      tool_choice: {
        type: 'function',
        function: { name: 'submit_hook_design' },
      },
    })
  }, { timeoutMs: 180_000, maxAttempts: 2 })

  const data = await response.json()
  const toolCall = data?.choices?.[0]?.message?.tool_calls?.find(
    (item: any) => item?.function?.name === 'submit_hook_design'
  )
  if (!toolCall) throw new Error('Hook design model did not return expected tool call')
  const parsed = JSON.parse(toolCall.function.arguments)
  const validated = hookDesignPayloadSchema.parse(parsed)

  return {
    seriesHook: validated.series_hook,
    episodeHooks: validated.episode_hooks.map(h => ({
      episodeNumber: h.episode_number,
      openingHook: h.opening_hook,
      cliffhangerHook: h.cliffhanger_hook,
      recapScript: h.recap_script,
    })),
  }
}
