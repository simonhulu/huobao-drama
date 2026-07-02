import { z } from 'zod'
import { aiFetch } from './ai-client.js'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { joinProviderUrl } from './adapters/url.js'

export const SMART_SPLIT_MODEL = 'deepseek-v4-flash'
export const SMART_PLOT_CHAIN_TOOL_NAME = 'submit_plot_progression_chain'
export const SMART_SPLIT_TOOL_NAME = 'submit_episode_split_plan'

export interface SmartSplitDurationPreset {
  id: string
  label: string
  youtubeReference: string
  minSeconds: number
  maxSeconds: number
  recommendedSeconds: number
}

export const SMART_SPLIT_DURATION_PRESETS: SmartSplitDurationPreset[] = [
  {
    id: 'micro_30_60',
    label: '30-60 秒',
    youtubeReference: '短视频节奏',
    minSeconds: 30,
    maxSeconds: 60,
    recommendedSeconds: 45,
  },
  {
    id: 'ai_manga_60_90',
    label: '60-90 秒（AI 漫剧）',
    youtubeReference: 'AI 漫剧/竖屏短剧高密度节奏',
    minSeconds: 60,
    maxSeconds: 90,
    recommendedSeconds: 75,
  },
  {
    id: 'shorts_1_3',
    label: '1-3 分钟',
    youtubeReference: 'YouTube Shorts（3 分钟内）',
    minSeconds: 60,
    maxSeconds: 180,
    recommendedSeconds: 150,
  },
  {
    id: 'mid_3_8',
    label: '3-8 分钟',
    youtubeReference: 'YouTube 长视频起步段',
    minSeconds: 180,
    maxSeconds: 480,
    recommendedSeconds: 360,
  },
  {
    id: 'mid_8_15',
    label: '8-15 分钟',
    youtubeReference: 'YouTube 常规长视频',
    minSeconds: 480,
    maxSeconds: 900,
    recommendedSeconds: 720,
  },
  {
    id: 'long_15_30',
    label: '15-30 分钟',
    youtubeReference: 'YouTube 较长正片',
    minSeconds: 900,
    maxSeconds: 1800,
    recommendedSeconds: 1200,
  },
]

const plotProgressionBeatSchema = z.object({
  beat_id: z.string().min(1),
  phase: z.string().min(1),
  summary: z.string().min(1),
  dramatic_function: z.string().min(1),
  suspense_value: z.string().min(1),
  must_keep_context: z.string().min(1),
})

const splitEpisodeSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  opening_hook: z.string().min(1),
  cliffhanger_hook: z.string().min(1),
  estimated_duration_seconds: z.number().int().positive(),
  opening_anchor: z.string().min(1),
  ending_anchor: z.string().min(1),
  covered_beat_ids: z.array(z.string().min(1)).min(1),
})

const plotChainToolPayloadSchema = z.object({
  plot_progression_chain: z.array(plotProgressionBeatSchema).min(1),
})

const splitEpisodesToolPayloadSchema = z.object({
  series_hook: z.string().min(1),
  episodes: z.array(splitEpisodeSchema).min(1),
})

const plotChainToolJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plot_progression_chain: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          beat_id: { type: 'string' },
          phase: { type: 'string' },
          summary: { type: 'string' },
          dramatic_function: { type: 'string' },
          suspense_value: { type: 'string' },
          must_keep_context: { type: 'string' },
        },
        required: ['beat_id', 'phase', 'summary', 'dramatic_function', 'suspense_value', 'must_keep_context'],
      },
    },
  },
  required: ['plot_progression_chain'],
} as const

const splitEpisodesToolJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    series_hook: { type: 'string' },
    episodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          opening_hook: { type: 'string' },
          cliffhanger_hook: { type: 'string' },
          estimated_duration_seconds: { type: 'integer' },
          opening_anchor: { type: 'string' },
          ending_anchor: { type: 'string' },
          covered_beat_ids: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: [
          'title',
          'summary',
          'opening_hook',
          'cliffhanger_hook',
          'estimated_duration_seconds',
          'opening_anchor',
          'ending_anchor',
          'covered_beat_ids',
        ],
      },
    },
  },
  required: ['series_hook', 'episodes'],
} as const

export type SmartSplitStyle = 'default' | 'ai_manga_drama'

export interface SmartSplitInput {
  dramaTitle?: string | null
  sourceText: string
  durationPresetId: string
  style?: SmartSplitStyle
  pacingMode?: string
}

export interface PlotProgressionBeat {
  beatId: string
  phase: string
  summary: string
  dramaticFunction: string
  suspenseValue: string
  mustKeepContext: string
}

export interface SmartSplitEpisodeBoundary {
  title: string
  summary: string
  openingHook: string
  cliffhangerHook: string
  estimatedDurationSeconds: number
  openingAnchor: string
  endingAnchor: string
  coveredBeatIds: string[]
}

export interface MaterializedSmartSplitEpisode extends SmartSplitEpisodeBoundary {
  content: string
}

export interface SmartSplitResult {
  hook: string
  durationPreset: SmartSplitDurationPreset
  plotProgressionChain: PlotProgressionBeat[]
  episodes: MaterializedSmartSplitEpisode[]
}

function isDeepSeekHost(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname === 'api.deepseek.com'
  } catch {
    return false
  }
}

function getSmartSplitUrl() {
  const textConfig = getTextConfig()
  const providerBase = getTextProviderBaseUrl(textConfig)

  if (isDeepSeekHost(providerBase)) {
    const url = new URL(providerBase)
    return {
      textConfig,
      url: `${url.origin}/beta/chat/completions`,
      strictMode: true,
    }
  }

  return {
    textConfig,
    url: joinProviderUrl(providerBase, '', '/chat/completions'),
    strictMode: false,
  }
}

export function getSmartSplitDurationPreset(id: string) {
  return SMART_SPLIT_DURATION_PRESETS.find((preset) => preset.id === id) || null
}

function isAiMangaDramaMode(preset: SmartSplitDurationPreset, style?: SmartSplitStyle) {
  return style === 'ai_manga_drama' || preset.id === 'ai_manga_60_90'
}

function buildPlotChainSystemPrompt(preset: SmartSplitDurationPreset, style?: SmartSplitStyle) {
  const aiManga = isAiMangaDramaMode(preset, style)
  const base = [
    '你是短剧总编剧。',
    '你的任务是先抽取剧情推进链，不做分集，不改写原文。',
  ]

  if (aiManga) {
    base.push(
      '本次采用 AI 漫剧（竖屏高密度短剧）节奏。',
      '你只保留两类 beat：推进主线的关键事件、承载强情绪的核心转折。',
      '明确剔除：重复的情绪宣泄、大段背景说明、与主线无关的回忆、低信息量的过渡。',
      '每个 beat 必须能在 5-10 秒内形成画面或情绪冲击。',
      `本次目标分集时长参考是 ${preset.label}，建议每集约 ${preset.recommendedSeconds} 秒。抽取 beat 时要高密度、快节奏。`,
    )
  } else {
    base.push(
      '所有有效信息都要保住：动作、冲突、内心、背景、因果、人物动机、伏笔、悬念、反转。',
      '不要为了追求节奏删掉内心世界或背景交代；这些常常正是镜头和解说成立的原因。',
      `本次目标分集时长参考是 ${preset.label}，建议每集约 ${preset.recommendedSeconds} 秒。你抽取 beat 时，要为后续分集保留足够完整的上下文。`,
    )
  }

  base.push(
    '每个 beat 都必须写清楚它的剧情功能、悬念价值，以及后续分镜绝不能丢掉的上下文。',
    '只通过函数调用提交剧情推进链，不要输出额外正文。',
  )

  return base.join('\n')
}

function buildPlotChainUserPrompt(input: SmartSplitInput, preset: SmartSplitDurationPreset) {
  const aiManga = isAiMangaDramaMode(preset, input.style)
  return [
    `剧名：${input.dramaTitle?.trim() || '未命名项目'}`,
    `目标分集时长：${preset.label}（${preset.minSeconds}-${preset.maxSeconds} 秒，建议 ${preset.recommendedSeconds} 秒）`,
    `分集风格：${aiManga ? 'AI 漫剧（高密度、快节奏、以情节和情绪为推进方式）' : '标准短剧（故事保真，保留完整上下文）'}`,
    '要求：',
    '1. 只抽取剧情推进链，不要开始分集。',
    aiManga
      ? '2. beat 只保留推进主线的关键事件和承载强情绪的核心转折；剔除重复情绪、背景说明、非必要过渡。'
      : '2. beat 要覆盖完整原文，不得遗漏关键上下文。',
    aiManga
      ? '3. 对每个保留的 beat，标注它的情绪功能和剧情推进功能。'
      : '3. 对内心、背景、因果、铺垫、伏笔要显式标注为什么必须保留。',
    '',
    '原文：',
    input.sourceText,
  ].join('\n')
}

function buildEpisodeSplitSystemPrompt(preset: SmartSplitDurationPreset, style?: SmartSplitStyle) {
  const aiManga = isAiMangaDramaMode(preset, style)
  const base = [
    '你是短剧分集编辑。',
    '剧情推进链已经确定，你现在只能基于这条链做分集。',
  ]

  if (aiManga) {
    base.push(
      '本次采用 AI 漫剧（竖屏高密度短剧）节奏。',
      '允许压缩、合并相邻的低密度 beat；不必逐字覆盖原文，只保留情节需要和情绪完整的内容。',
      '每集开场必须在 3 秒内形成强钩子（冲突、身份错位、情绪反差、悬念）。',
      '每集结束必须是强情绪落点或 cliffhanger：信息揭晓前一拍、关系反转、风险升级、行动将起未起。',
      `本次目标时长是 ${preset.label}，建议每集约 ${preset.recommendedSeconds} 秒，允许在 ${preset.minSeconds}-${preset.maxSeconds} 秒区间内浮动。宁短勿拖。`,
      '分集保持原文主线顺序，不倒叙重组，但允许跳过非必要的说明和重复情绪。',
    )
  } else {
    base.push(
      '不要重新输出剧情推进链，不要改写原文，不要按字数机械切分。',
      `本次目标时长是 ${preset.label}，建议每集约 ${preset.recommendedSeconds} 秒，允许在 ${preset.minSeconds}-${preset.maxSeconds} 秒区间内浮动。`,
      '每集结束必须形成明确的追看动力：信息揭晓前一拍、情绪落差、关系反转、风险升级、谜底半开、行动将起未起。',
      '分集必须保持原文顺序，不能倒叙重组，不能跳过任何关键上下文。',
    )
  }

  base.push(
    '每集必须提供 opening_hook 和 cliffhanger_hook。',
    'opening_hook 必须是“一句话总结本集情节并留下悬念”的解说式开头，例如：“婆婆说我不能生，我当场气得离家出走，我的丈夫会怎么办？”',
    'cliffhanger_hook 必须是结尾悬念，让观众想看下一集。',
    '同时提供一个 series_hook（整部剧的一句话核心钩子），用于封面和标题。',
    '每集的 opening_anchor 和 ending_anchor 必须直接从原文中逐字复制。',
    '只通过函数调用提交 episodes 和 series_hook，不要输出额外正文。',
  )

  return base.join('\n')
}

function buildEpisodeSplitUserPrompt(
  input: SmartSplitInput,
  preset: SmartSplitDurationPreset,
  plotProgressionChain: Array<z.infer<typeof plotProgressionBeatSchema>>,
) {
  const aiManga = isAiMangaDramaMode(preset, input.style)
  return [
    `剧名：${input.dramaTitle?.trim() || '未命名项目'}`,
    `目标分集时长：${preset.label}（${preset.minSeconds}-${preset.maxSeconds} 秒，建议每集约 ${preset.recommendedSeconds} 秒）。允许 10 分钟以上的长集，不要硬拆。`,
    `分集风格：${aiManga ? 'AI 漫剧（高密度、快节奏、以情节和情绪为推进方式）' : '标准短剧（故事保真，保留完整上下文）'}`,
    '已确定的剧情推进链：',
    JSON.stringify(plotProgressionChain, null, 2),
    '',
    '要求：',
    '1. 输出 series_hook 和 episodes。',
    '2. series_hook 用一句话概括整部剧最大冲突/悬念，适合做封面标题。',
    '3. 每一集都要引用 covered_beat_ids，保证分集决策严格受剧情推进链约束。',
    '4. 每集 summary 要写清真实推进，不要只写表面动作。',
    '5. 每集 opening_hook 必须是“一句话总结本集情节并留下悬念”的解说式开头，例如：“婆婆说我不能生，我当场气得离家出走，我的丈夫会怎么办？”',
    '6. 每集 cliffhanger_hook 必须是结尾悬念，让观众想看下一集。',
    aiManga
      ? '7. AI 漫剧模式下：允许合并相邻低密度 beat、跳过非必要说明；所有集数合起来必须完整覆盖主线情节和情绪弧线，不必逐字覆盖原文。'
      : '7. 所有集数合起来必须完整覆盖原文，不得遗漏关键上下文。',
    '',
    '原文：',
    input.sourceText,
  ].join('\n')
}

function buildToolDefinition(
  strictMode: boolean,
  name: string,
  description: string,
  parameters: Record<string, unknown>,
) {
  return [{
    type: 'function',
    function: {
      name,
      description,
      strict: strictMode,
      parameters,
    },
  }]
}

function formatSchemaError(error: z.ZodError) {
  return JSON.stringify(error.issues.map((issue) => ({
    path: issue.path,
    code: issue.code,
    message: issue.message,
    expected: 'expected' in issue ? issue.expected : undefined,
  })))
}

function parseStructuredToolArguments<T extends z.ZodTypeAny>(
  response: any,
  toolName: string,
  schema: T,
  label: string,
): z.infer<T> {
  const toolCall = response?.choices?.[0]?.message?.tool_calls?.find(
    (item: any) => item?.function?.name === toolName,
  )
  const rawArguments = toolCall?.function?.arguments

  if (typeof rawArguments !== 'string' || !rawArguments.trim()) {
    throw new Error(`${label}模型未按约定返回结构化 tool 调用`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    throw new Error(`${label}模型返回了不可解析的 JSON arguments`)
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`${label}模型返回结构不完整：${formatSchemaError(result.error)}`)
  }

  return result.data
}

function normalizeStoryText(sourceText: string) {
  return sourceText.replace(/\r\n/g, '\n').trim()
}

function stripAndMap(sourceText: string) {
  const stripped: string[] = []
  const map: number[] = []
  for (let i = 0; i < sourceText.length; i++) {
    const ch = sourceText[i]
    if (/\s/.test(ch)) continue
    if (ch === '"' || ch === "'" || ch === '“' || ch === '”' || ch === '‘' || ch === '’' || ch === '「' || ch === '」' || ch === '『' || ch === '』' || ch === '«' || ch === '»') continue
    stripped.push(ch)
    map.push(i)
  }
  return { stripped: stripped.join(''), map }
}

function stripText(text: string) {
  return stripAndMap(text).stripped
}

export function materializeEpisodeContents(
  sourceText: string,
  episodes: SmartSplitEpisodeBoundary[],
): MaterializedSmartSplitEpisode[] {
  const normalized = normalizeStoryText(sourceText)
  const { stripped: strippedNormalized, map: normalizedMap } = stripAndMap(normalized)
  let cursor = 0

  return episodes.map((episode, index) => {
    const isLastEpisode = index === episodes.length - 1
    const strippedEndingAnchor = stripText(episode.endingAnchor)
    let sliceEnd: number

    if (isLastEpisode) {
      sliceEnd = normalized.length
    } else {
      if (strippedEndingAnchor.length === 0) {
        throw new Error(`模型返回的文本锚点无法映射回原文：${episode.endingAnchor}`)
      }
      const cursorStrippedPos = strippedNormalized.length - stripText(normalized.slice(cursor)).length
      const pos = strippedNormalized.indexOf(strippedEndingAnchor, cursorStrippedPos)
      if (pos === -1) {
        throw new Error(`模型返回的文本锚点无法映射回原文：${episode.endingAnchor}`)
      }
      sliceEnd = normalizedMap[pos + strippedEndingAnchor.length - 1] + 1
    }

    const rawContent = normalized.slice(cursor, sliceEnd)
    const content = rawContent.trim()

    if (!content) {
      throw new Error(`第 ${index + 1} 集切分结果为空`)
    }

    // opening_anchor 仅作模型自检参考，不参与实际切分：切片连续性已由 cursor + ending_anchor 保证。
    // 模型给的 opening/ending 锚点是两个独立摘录，不保证严丝合缝衔接，因此这里不再硬校验，避免误杀整次切分。

    cursor = sliceEnd

    return {
      ...episode,
      content,
    }
  })
}

function estimateTextDuration(content: string, pacingMode: string): number {
  const charsPerSecond = pacingMode === 'extreme' ? 4.5 : pacingMode === 'tight' ? 3.2 : 2.2
  return Math.max(10, Math.round(content.length / charsPerSecond))
}

function mergeSplitEpisodesByDuration(
  episodes: MaterializedSmartSplitEpisode[],
  pacingMode: string,
  preset: SmartSplitDurationPreset,
): MaterializedSmartSplitEpisode[] {
  if (episodes.length <= 1) return episodes
  const merged: MaterializedSmartSplitEpisode[] = []
  let current: MaterializedSmartSplitEpisode | null = null
  let currentDuration = 0

  function pushCurrent() {
    if (!current) return
    current.estimatedDurationSeconds = Math.min(preset.maxSeconds, Math.max(preset.minSeconds, currentDuration))
    merged.push(current)
    current = null
    currentDuration = 0
  }

  for (const ep of episodes) {
    const epDuration = estimateTextDuration(ep.content, pacingMode)
    if (!current) {
      current = { ...ep }
      currentDuration = epDuration
      continue
    }
    const combinedDuration = currentDuration + epDuration
    if (combinedDuration <= preset.maxSeconds) {
      current.content = `${current.content}\n\n${ep.content}`
      current.summary = `${current.summary}；${ep.summary}`
      current.cliffhangerHook = ep.cliffhangerHook
      current.endingAnchor = ep.endingAnchor
      current.coveredBeatIds = [...current.coveredBeatIds, ...ep.coveredBeatIds]
      currentDuration = combinedDuration
    } else {
      pushCurrent()
      current = { ...ep }
      currentDuration = epDuration
    }
  }
  pushCurrent()

  // If the final group is too short and we can merge it back into the previous one without wildly exceeding max, do so.
  if (merged.length >= 2) {
    const last = merged[merged.length - 1]
    const prev = merged[merged.length - 2]
    const lastDuration = estimateTextDuration(last.content, pacingMode)
    const prevDuration = estimateTextDuration(prev.content, pacingMode)
    if (lastDuration < preset.minSeconds && prevDuration + lastDuration <= preset.maxSeconds) {
      prev.content = `${prev.content}\n\n${last.content}`
      prev.summary = `${prev.summary}；${last.summary}`
      prev.cliffhangerHook = last.cliffhangerHook
      prev.endingAnchor = last.endingAnchor
      prev.coveredBeatIds = [...prev.coveredBeatIds, ...last.coveredBeatIds]
      prev.estimatedDurationSeconds = Math.min(preset.maxSeconds, prevDuration + lastDuration)
      merged.pop()
    }
  }

  return merged
}

function getMaxTokens() {
  const value = Number(process.env.SMART_EPISODE_SPLIT_MAX_TOKENS || 16000)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 16000
}

async function requestStructuredToolResult<T extends z.ZodTypeAny>(input: {
  url: string
  provider: string
  apiKey: string
  model: string
  strictMode: boolean
  systemPrompt: string
  userPrompt: string
  toolName: string
  toolDescription: string
  toolParameters: Record<string, unknown>
  schema: T
  label: string
}): Promise<z.infer<T>> {
  const response = await aiFetch(input.provider || 'text', input.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      temperature: 0.2,
      max_tokens: getMaxTokens(),
      thinking: { type: 'disabled' },
      tools: buildToolDefinition(
        input.strictMode,
        input.toolName,
        input.toolDescription,
        input.toolParameters,
      ),
      tool_choice: {
        type: 'function',
        function: { name: input.toolName },
      },
    }),
  }, { timeoutMs: 180_000, maxAttempts: 2 })

  const data = await response.json()
  return parseStructuredToolArguments(data, input.toolName, input.schema, input.label)
}

export async function splitStoryIntoEpisodes(input: SmartSplitInput): Promise<SmartSplitResult> {
  const sourceText = normalizeStoryText(input.sourceText)
  if (!sourceText) throw new Error('sourceText is required')

  const durationPreset = getSmartSplitDurationPreset(input.durationPresetId)
  if (!durationPreset) throw new Error(`Unknown duration preset: ${input.durationPresetId}`)

  const pacingMode = input.pacingMode || 'standard'
  const pacingFactor = pacingMode === 'extreme' ? 2.0 : pacingMode === 'tight' ? 1.5 : 1.0
  const style = input.style || (pacingMode === 'extreme' || pacingMode === 'tight' ? 'ai_manga_drama' : 'default')
  const effectivePreset: SmartSplitDurationPreset = {
    ...durationPreset,
    minSeconds: Math.round(durationPreset.minSeconds * pacingFactor),
    maxSeconds: Math.round(durationPreset.maxSeconds * pacingFactor),
    recommendedSeconds: Math.round(durationPreset.recommendedSeconds * pacingFactor),
  }

  const { textConfig, url, strictMode } = getSmartSplitUrl()
  const model = process.env.SMART_EPISODE_SPLIT_MODEL || SMART_SPLIT_MODEL

  const plotChainPayload = await requestStructuredToolResult({
    url,
    provider: textConfig.provider,
    apiKey: textConfig.apiKey,
    model,
    strictMode,
    systemPrompt: buildPlotChainSystemPrompt(effectivePreset, style),
    userPrompt: buildPlotChainUserPrompt({ ...input, sourceText }, effectivePreset),
    toolName: SMART_PLOT_CHAIN_TOOL_NAME,
    toolDescription: '提交剧情推进链，为后续按悬念分集提供依据',
    toolParameters: plotChainToolJsonSchema,
    schema: plotChainToolPayloadSchema,
    label: '剧情推进链',
  })

  const splitEpisodesPayload = await requestStructuredToolResult({
    url,
    provider: textConfig.provider,
    apiKey: textConfig.apiKey,
    model,
    strictMode,
    systemPrompt: buildEpisodeSplitSystemPrompt(effectivePreset, style),
    userPrompt: buildEpisodeSplitUserPrompt({ ...input, sourceText }, effectivePreset, plotChainPayload.plot_progression_chain),
    toolName: SMART_SPLIT_TOOL_NAME,
    toolDescription: '提交基于剧情推进链的分集计划',
    toolParameters: splitEpisodesToolJsonSchema,
    schema: splitEpisodesToolPayloadSchema,
    label: '分集结果',
  })

  let episodes = materializeEpisodeContents(sourceText, splitEpisodesPayload.episodes.map((episode) => ({
    title: episode.title,
    summary: episode.summary,
    openingHook: episode.opening_hook,
    cliffhangerHook: episode.cliffhanger_hook,
    estimatedDurationSeconds: episode.estimated_duration_seconds,
    openingAnchor: episode.opening_anchor,
    endingAnchor: episode.ending_anchor,
    coveredBeatIds: episode.covered_beat_ids,
  })))

  episodes = mergeSplitEpisodesByDuration(episodes, pacingMode, effectivePreset)

  const hook = splitEpisodesPayload.series_hook || episodes[0]?.openingHook || episodes[0]?.cliffhangerHook || input.dramaTitle || '精彩故事即将展开'

  return {
    hook,
    durationPreset,
    plotProgressionChain: plotChainPayload.plot_progression_chain.map((beat) => ({
      beatId: beat.beat_id,
      phase: beat.phase,
      summary: beat.summary,
      dramaticFunction: beat.dramatic_function,
      suspenseValue: beat.suspense_value,
      mustKeepContext: beat.must_keep_context,
    })),
    episodes,
  }
}
