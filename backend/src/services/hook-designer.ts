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
    '3. recap_script：仅对第 2 集及以后生成，用于本集开头回顾上一集内容。',
    '4. series_hook：全剧一句话核心钩子，用于封面标题。',
    '',
    'recap_script 要求：',
    '- 必须以"上一集"开头，例如"上一集，张居正清丈土地，宗室被削爵震慑。如今，一条鞭法即将推行。"',
    '- 只保留主角动作、关键转折、当前状态三要素。',
    '- 字数控制在 35–50 字（含标点），既要简洁又要保留关键转折。',
    '- 不要细节、不要背景铺垫、不要人名全称。',
    '',
    '输出格式：',
    '只输出一段合法的 JSON，不要 markdown 代码块，不要解释。格式如下：',
    '{',
    '  "series_hook": "全剧一句话钩子",',
    '  "episode_hooks": [',
    '    { "episode_number": 1, "opening_hook": "...", "cliffhanger_hook": "..." },',
    '    { "episode_number": 2, "opening_hook": "...", "cliffhanger_hook": "...", "recap_script": "上一集，..." }',
    '  ]',
    '}',
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
    '2. opening_hook 不再承担前情交代，只负责把观众拉进本集冲突。',
    '3. cliffhanger_hook 要制造强烈悬念，让观众想看下一集。',
    '4. recap_script 仅对第 2 集及以后生成；第 1 集可留空。',
    '5. recap_script 必须包含"上一集"引导语，控制在 35–50 字（含标点）。'
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
      response_format: { type: 'json_object' },
    })
  }, { timeoutMs: 180_000, maxAttempts: 2 })

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('Hook design model returned empty content')

  const parsed = JSON.parse(content)
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
