import { aiFetch } from './ai-client.js'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { joinProviderUrl } from './adapters/url.js'

export interface CoverPromptEnhanceInput {
  roughPrompt: string
  episodeTitle?: string
  episodeContent?: string
  episodeSynopsis?: string
  dramaTitle?: string
  dramaStyle?: string
}

export interface CoverPromptEnhanceResult {
  enhanced_prompt: string
  image_prompt: string
  main_title: string
  sub_title: string
  kicker: string
  accent_color: string
  rationale: string
}

function buildSystemPrompt(): string {
  return `你是资深短视频封面总监 + AI 图像提示词工程师。你的任务是为每一集产出一套能在信息流缩略图中抓住注意力的封面方案。

必须遵守以下创作技巧：
1. 视觉讲故事：
   - 用一个明确的冲突、代价或反常识结论作为视觉中心。
   - 避免只画单一文物/地图；优先使用两极对照、人物处境、关键物件特写或正在发生的动作。
   - 画面必须像电影海报，主体清楚、前中后景分明、光影有方向，缩小后仍能读出故事。
2. 封面文案：
   - main_title 是 4-10 个汉字的短钩子，提炼“为什么值得点开”，不要照抄完整集标题。
   - sub_title 是 8-20 个汉字的补充论断或悬念，避免和 main_title 重复。
   - kicker 是 4-10 个汉字的栏目标签，例如“制度拆解”“历史真相”“命运转折”。
   - 文案要克制、直接、有冲突，不使用空泛的“震撼揭秘”“精彩故事”。
3. 画面提示词：
   - image_prompt 只能描述画面、构图、镜头、人物、物件、光影、色彩和情绪。
   - 严禁在 image_prompt 中要求任何文字、标题、字幕、书法、水印、字符、字母、语言或排版；所有文字由程序后期渲染。
   - 必须包含 cinematic、highly detailed、no text、no watermark 等质量约束，控制在 500 字以内。
4. 构图与配色：
   - 为标题保留画面上方或左上方的低细节安全区，人物和关键物件不要挤满画面。
   - accent_color 只返回 6 位十六进制颜色；优先使用能和画面形成对比的旧金、朱砂、青绿或冷蓝。

输出要求（JSON）：
{
  "enhanced_prompt": "优化后的中文创意说明，控制在 200 字以内。",
  "image_prompt": "只描述无字底图的英文生图提示词，控制在 500 字以内。",
  "main_title": "4-10 个汉字的主标题钩子",
  "sub_title": "8-20 个汉字的副标题论断或悬念",
  "kicker": "4-10 个汉字的栏目标签",
  "accent_color": "#D7A649",
  "rationale": "简要说明画面和文案如何制造点击动机，1-2 句话。"
}`
}

function buildUserPrompt(input: CoverPromptEnhanceInput): string {
  const parts = [
    `项目标题：${input.dramaTitle || '未提供'}`,
    `项目视觉风格：${input.dramaStyle || '未提供'}`,
    `本集标题：${input.episodeTitle || '未提供'}`,
    `本集原文/梗概：${input.episodeSynopsis || input.episodeContent || '未提供'}`,
    `用户原始封面想法：${input.roughPrompt}`,
  ]
  return parts.join('\n')
}

export async function enhanceCoverPrompt(input: CoverPromptEnhanceInput): Promise<CoverPromptEnhanceResult> {
  const textConfig = getTextConfig()
  if (!textConfig) throw new Error('No active text AI config')

  const providerBase = getTextProviderBaseUrl(textConfig)
  const url = joinProviderUrl(providerBase, '', '/chat/completions')

  const response = await aiFetch(textConfig.provider || 'text', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${textConfig.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: textConfig.model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      temperature: 0.5,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  }, { timeoutMs: 120_000, maxAttempts: 2 })

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('Cover prompt enhancement returned empty content')

  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Cover prompt enhancement returned invalid JSON')
  }

  return {
    enhanced_prompt: String(parsed.enhanced_prompt || parsed.enhancedPrompt || '').trim(),
    image_prompt: String(parsed.image_prompt || parsed.imagePrompt || '').trim(),
    main_title: String(parsed.main_title || parsed.mainTitle || '').trim(),
    sub_title: String(parsed.sub_title || parsed.subTitle || '').trim(),
    kicker: String(parsed.kicker || parsed.label || '').trim(),
    accent_color: String(parsed.accent_color || parsed.accentColor || '').trim(),
    rationale: String(parsed.rationale || '').trim(),
  }
}
