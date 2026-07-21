/**
 * 旁白生成兜底服务
 *
 * narrator agent 在部分模型/Provider 下无法可靠地通过 tool call 保存旁白，
 * 这个服务直接调用文本模型，以 JSON 模式生成并保存逐镜头旁白。
 */
import { db, schema } from '../db/index.js'
import { eq, asc } from 'drizzle-orm'
import { aiFetch } from './ai-client.js'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { joinProviderUrl } from './adapters/url.js'
import { createNarratorTools } from '../agents/tools/narrator-tools.js'
import { now } from '../utils/response.js'
import { logTaskProgress, logTaskSuccess, logTaskError } from '../utils/task-logger.js'
import { usesOriginalTextForNarration } from './episode-mode.js'
import { normalizeTtsText } from '../utils/tts-text.js'

const MAX_TOKENS = Number(process.env.NARRATION_GENERATION_MAX_TOKENS || 8000)

const NARRATION_RULES = [
  '使用电影解说视角撰写，保持原文叙事人称；不要强制改成主角“我”的第一人称。',
  '优先直接使用 original_story 原文的事实和表达，按镜头做最小拆分，不要改变人物视角。',
  '每镜头 1-2 句，快速推进，不解释、不铺陈、不拖沓。',
  '保留原文的情绪转折点和金句，第一句就要带情绪。',
  '对白镜头优先给对白让位，旁白只做极短铺垫或留白。',
  '不编造原文里没有的情节、名字或细节。',
  '不带"旁白："前缀，不带角色名。',
].join('\n')

function buildSystemPrompt() {
  return [
    '你是短剧/图文视频解说词撰稿人，擅长把故事拆成逐镜头旁白。',
    '',
    '撰写原则：',
    NARRATION_RULES,
    '',
    '输出要求：',
    '1. 只输出合法 JSON，不要任何 Markdown、代码块标记或解释性文字。',
    '2. JSON 顶层字段为 "narrations"，是一个数组。',
    '3. 数组每个元素包含 "shot_number"（整数，从 1 开始）和 "narration"（字符串，该镜头的解说词；没有旁白时传空字符串）。',
    '4. 必须为每一个输入的镜头返回一条记录，不能遗漏。',
  ].join('\n')
}

function buildUserPrompt(context: any) {
  const shots = context.shots || []
  const shotsText = shots.map((s: any, idx: number) => {
    const lines = [
      `【镜头 ${s.shot_number || idx + 1}】`,
      `标题：${s.title || ''}`,
      `地点：${s.location || ''} | 时间：${s.time || ''}`,
      `景别：${s.shot_type || ''}`,
      `动作：${s.action || ''}`,
      `结果：${s.result || ''}`,
      `氛围：${s.atmosphere || ''}`,
      `描述：${s.description || ''}`,
      `对白：${s.dialogue || '（无）'}`,
    ]
    return lines.join('\n')
  }).join('\n\n')

  return [
    `剧名：${context.episode?.title || '未命名'}`,
    `集数：第 ${context.episode?.episode_number || 1} 集`,
    '',
    '原始故事原文：',
    context.original_story || '',
    '',
    '格式化剧本：',
    context.formatted_script || '',
    '',
    '镜头列表：',
    shotsText,
    '',
    '请按输出要求返回 JSON。',
  ].join('\n')
}

function parseNarrations(resultText: string): Array<{ shot_number: number; narration: string }> {
  let text = resultText.trim()
  // 去掉可能的代码块标记
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }
  const parsed = JSON.parse(text)
  const narrations = Array.isArray(parsed.narrations) ? parsed.narrations : Array.isArray(parsed) ? parsed : []
  return narrations.map((n: any) => ({
    shot_number: Number(n.shot_number || n.shotNumber),
    narration: String(n.narration || n.text || ''),
  })).filter((n: any) => Number.isFinite(n.shot_number))
}

export async function generateAndSaveNarrations(episodeId: number, dramaId: number) {
  logTaskProgress('NarrationFallback', 'start', { episodeId, dramaId })

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (usesOriginalTextForNarration(ep)) {
    const restored = restoreOriginalTextNarrations(episodeId)
    logTaskSuccess('NarrationFallback', 'original-text-restored', { episodeId, restored: restored.updated })
    return { narrations: [], saveResult: restored }
  }

  const tools = createNarratorTools(episodeId, dramaId)
  const context = await (tools.readNarrationContext.execute as any)({}, {} as any)
  if ((context as any)?.error) {
    throw new Error(`读取旁白上下文失败: ${(context as any).error}`)
  }

  const textConfig = getTextConfig()
  const baseUrl = getTextProviderBaseUrl(textConfig)
  const url = joinProviderUrl(baseUrl, '', '/chat/completions')
  const model = textConfig.model

  const resp = await aiFetch(textConfig.provider || 'text', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${textConfig.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(context) },
      ],
      temperature: 0.5,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
    }),
  }, { timeoutMs: 180_000, maxAttempts: 2 })

  const data = await resp.json()
  const resultText = data?.choices?.[0]?.message?.content
  if (!resultText) {
    throw new Error('模型未返回旁白内容')
  }

  const narrations = parseNarrations(resultText)
  if (!narrations.length) {
    throw new Error('解析旁白结果为空')
  }

  const saveResult = await (tools.saveNarrations.execute as any)({ narrations }, {} as any)
  logTaskSuccess('NarrationFallback', 'saved', { episodeId, count: narrations.length, saveResult })
  return { narrations, saveResult }
}

export function countExistingNarrations(episodeId: number): number {
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
  return rows.filter(sb => (sb.narration || '').trim()).length
}

type EpisodeRow = typeof schema.episodes.$inferSelect
type StoryboardRow = typeof schema.storyboards.$inferSelect

export function getVerbatimSource(ep: EpisodeRow): string {
  if (ep.workflowType === 'direct_script') {
    return (ep.scriptContent || ep.content || '').trim()
  }
  return (ep.content || ep.scriptContent || '').trim()
}

function normalizeForFragmentMatch(text: string): string {
  return text
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim()
}

function isMatchIgnoredChar(char: string): boolean {
  return !normalizeForFragmentMatch(char)
}

function normalizeWithOriginalIndex(text: string): { normalized: string; indexes: number[] } {
  let normalized = ''
  const indexes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (/\s/.test(char)) continue
    const normalizedChar = normalizeForFragmentMatch(char)
    if (!normalizedChar) continue
    normalized += normalizedChar
    indexes.push(i)
  }
  return { normalized, indexes }
}

function extractOriginalFragment(source: string, fragment: string): string | null {
  const range = findOriginalFragmentRange(source, fragment)
  if (!range) return null
  return source.slice(range.start, range.end).trim()
}

export function findOriginalFragmentRange(source: string, fragment: string): { start: number; end: number } | null {
  const cleanFragment = normalizeForFragmentMatch(fragment)
  if (!source.trim() || !cleanFragment) return null

  const indexedSource = normalizeWithOriginalIndex(source)
  const start = indexedSource.normalized.indexOf(cleanFragment)
  if (start === -1) return null

  const end = start + cleanFragment.length - 1
  const originalStart = indexedSource.indexes[start]
  const originalEnd = indexedSource.indexes[end]
  if (originalStart == null || originalEnd == null) return null

  let sliceEnd = originalEnd + 1
  while (sliceEnd < source.length && isMatchIgnoredChar(source[sliceEnd])) {
    sliceEnd++
  }

  return { start: originalStart, end: sliceEnd }
}

export function resolveStoryboardNarrationTextForTTS(sb: StoryboardRow, ep?: EpisodeRow | null): string {
  let raw = ''
  if (ep && usesOriginalTextForNarration(ep)) {
    const source = getVerbatimSource(ep)
    const narration = (sb.narration || '').trim()
    const description = (sb.description || '').trim()

    if (narration) {
      raw = extractOriginalFragment(source, narration) || ''
    } else if (description) {
      raw = extractOriginalFragment(source, description) || ''
    }
  } else {
    raw = (sb.narration || '').trim()
  }

  return normalizeTtsText(raw)
}

/**
 * 把原文按句子切分后分配到每个分镜的 narration 字段。
 *
 * 分配策略：
 * 1. 优先尝试用每个分镜已有的 narration / description 在原文中定位。
 * 2. 定位成功后，直接使用对应的原文片段，保证画面和旁白对齐。
 * 3. 定位失败或产生重叠的分镜，再把剩余原文按字数平均分配。
 *
 * 这里的 narration 只是历史字段名：
 * - direct_script / verbatim 下，它不是 AI 生成的“旁白文案”，只是逐镜头 TTS 原文切片。
 * - 调用该函数会清空已生成的解说音频和合成视频，避免旧音频继续读污染文本。
 */
export function restoreOriginalTextNarrations(episodeId: number): { updated: number } {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)
  if (!usesOriginalTextForNarration(ep)) {
    throw new Error(`Episode ${episodeId} does not use original text for narration`)
  }
  const original = getVerbatimSource(ep)
  if (!original) throw new Error(`Episode ${episodeId} has no original content`)

  const shots = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  if (shots.length === 0) throw new Error(`Episode ${episodeId} has no storyboards`)

  // 先把文本按句末标点拆成句，再把超长句按逗号/顿号/分号二次拆分，避免单个分镜过长。
  function splitSentences(text: string, maxChars = 300): string[] {
    const major = text
      .replace(/([。！？；\.\!\?\;])/g, '$1\n')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)

    const result: string[] = []
    for (const s of major) {
      if (s.length <= maxChars) {
        result.push(s)
        continue
      }
      // 超长句：优先在逗号、顿号、分号处切分；找不到就按字数硬切
      let remaining = s
      while (remaining.length > maxChars) {
        let cutAt = remaining.lastIndexOf('，', maxChars)
        if (cutAt < maxChars / 2) cutAt = remaining.lastIndexOf('、', maxChars)
        if (cutAt < maxChars / 2) cutAt = remaining.lastIndexOf('；', maxChars)
        if (cutAt < maxChars / 2) cutAt = remaining.lastIndexOf(',', maxChars)
        if (cutAt < maxChars / 2) cutAt = maxChars
        result.push(remaining.slice(0, cutAt).trim())
        remaining = remaining.slice(cutAt).trim()
      }
      if (remaining) result.push(remaining)
    }
    return result
  }

  // 把一段未分配的原文均匀切分给若干分镜
  function distributeText(text: string, shotIds: number[], out: Map<number, string>) {
    if (shotIds.length === 0) return
    const sentences = splitSentences(text, 300)
    if (sentences.length === 0) {
      for (const id of shotIds) out.set(id, '')
      return
    }

    const totalChars = sentences.reduce((sum, s) => sum + s.length, 0)
    const targetChars = totalChars / shotIds.length
    const chunks: string[][] = []
    let current: string[] = []
    let currentChars = 0

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i]
      if (
        chunks.length < shotIds.length - 1 &&
        currentChars > 0 &&
        currentChars + sentence.length > targetChars * 1.2
      ) {
        chunks.push(current)
        current = [sentence]
        currentChars = sentence.length
      } else {
        current.push(sentence)
        currentChars += sentence.length
      }
    }
    if (current.length > 0) {
      chunks.push(current)
    }

    while (chunks.length < shotIds.length) {
      chunks.push([])
    }

    for (let i = 0; i < shotIds.length; i++) {
      out.set(shotIds[i], chunks[i].join(''))
    }
  }

  // 第一遍：尝试用 narration / description 在原文中定位
  const matchedRanges: Array<{ start: number; end: number; shotId: number; text: string }> = []
  const matchedByShotId = new Map<number, { start: number; end: number; text: string }>()

  for (const sb of shots) {
    const fragment = (sb.narration || sb.description || '').trim()
    if (!fragment) continue

    const range = findOriginalFragmentRange(original, fragment)
    if (!range) continue

    // 避免重叠：如果和已定位区域重叠，则视为未命中，交给后面的均分兜底
    const overlaps = matchedRanges.some(
      r => !(range.end <= r.start || range.start >= r.end),
    )
    if (overlaps) continue

    const text = original.slice(range.start, range.end).trim()
    matchedRanges.push({ start: range.start, end: range.end, shotId: sb.id, text })
    matchedByShotId.set(sb.id, { start: range.start, end: range.end, text })
  }

  matchedRanges.sort((a, b) => a.start - b.start)

  // 第二遍：按顺序遍历分镜，把匹配成功的直接采用，未匹配的收集成“缺口”再均分
  const narrations = new Map<number, string>()
  let cursor = 0
  let pendingShotIds: number[] = []

  function flushPending(end: number) {
    if (pendingShotIds.length === 0) return
    const gapText = original.slice(cursor, end)
    distributeText(gapText, pendingShotIds, narrations)
    pendingShotIds = []
  }

  for (const sb of shots) {
    const matched = matchedByShotId.get(sb.id)
    if (matched) {
      flushPending(matched.start)
      narrations.set(sb.id, matched.text)
      cursor = matched.end
    } else {
      pendingShotIds.push(sb.id)
    }
  }
  flushPending(original.length)

  const ts = now()
  let updated = 0
  for (const sb of shots) {
    const text = normalizeTtsText(narrations.get(sb.id) || '')
    db.update(schema.storyboards)
      .set({ narration: text, updatedAt: ts })
      .where(eq(schema.storyboards.id, sb.id))
      .run()
    updated++
  }

  // 清空已生成的旁白音频和合成视频，强制后续重新生成
  db.update(schema.storyboards)
    .set({ narrationAudioUrl: null, composedVideoUrl: null, updatedAt: ts })
    .where(eq(schema.storyboards.episodeId, episodeId))
    .run()

  logTaskSuccess('NarrationFallback', 'original-text-restored', {
    episodeId,
    shots: shots.length,
    matched: matchedRanges.length,
    updated,
  })
  return { updated }
}

/**
 * Backward-compatible name kept for older routes/tests.
 * New code should call restoreOriginalTextNarrations to avoid mixing the business meaning.
 */
export function restoreVerbatimNarrations(episodeId: number): { updated: number } {
  return restoreOriginalTextNarrations(episodeId)
}
