/**
 * 镜头图片 Prompt 故事性拼装
 *
 * 把一个分镜的多维信息（画面、动作、对白、氛围、角色外观、上下文承接）
 * 结构化拼装成一段「有故事性、能表现对白表演、承上启下」的图片生成 prompt。
 *
 * 关键约束：本项目是视频剧，对白由 TTS 配音 + 烧录字幕承担。
 * 因此对白「只演不写字」——把 dialogue 转化为人物表情/口型/姿态/眼神/情绪的
 * 视觉表演描写，绝不要求把台词文字渲染进画面（会与烧录字幕冲突）。
 */
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { stripVideoTags } from './adapters/prompt-utils.js'
import { normalizeStoryboardImagePromptForAspectRatio } from './storyboard-aspect-prompt.js'
import { applyVisualStyle } from './visual-style.js'

// 保守的字符预算上限。最终的 provider 适配截断由 adapter 层 normalizePrompt 负责，
// 这里只保证拼装不会无脑膨胀到丢失关键信息（minimax 仅 1500 字符）。
const PROMPT_CHAR_BUDGET = 1400
// 相邻镜头上下文摘要的单条最大长度
const CONTEXT_SUMMARY_MAX = 40

type StoryboardRecord = typeof schema.storyboards.$inferSelect
type CharacterRecord = typeof schema.characters.$inferSelect

interface DialogueLine {
  readonly speaker: string | null
  readonly text: string
}

/**
 * 解析 `角色名：台词` 格式的对白（项目约定，见 narrator skill）。
 * 支持中英文冒号，按行拆分。无冒号的行视为无明确说话人的台词。
 */
export function parseDialogueLines(dialogue: string | null | undefined): DialogueLine[] {
  const raw = (dialogue || '').trim()
  if (!raw) return []

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^：:]{1,20})[：:]\s*(.+)$/)
      if (match) {
        return { speaker: match[1].trim(), text: match[2].trim() }
      }
      return { speaker: null, text: line }
    })
    .filter((entry) => entry.text.length > 0)
}

/**
 * 从台词文本做轻量情绪线索推断（不输出台词本身，只输出情绪形容）。
 */
function inferEmotion(text: string): string {
  if (/[！!]/.test(text)) return '情绪激动、语气强烈'
  if (/[？?]/.test(text)) return '面带疑问、神情探询'
  if (/[…⋯]|\.\.\./.test(text)) return '欲言又止、神情迟疑'
  if (/[。.]$/.test(text)) return '语气平稳、神情自然'
  return '自然交谈神态'
}

/**
 * 把对白转化为「正在说话」的视觉表演描述。只演不写字。
 */
export function describeDialoguePerformance(
  dialogue: string | null | undefined,
  characterNames: string[] = [],
): string {
  const lines = parseDialogueLines(dialogue)
  if (!lines.length) return ''

  // 找出本镜对白里出现的说话角色（去重、保序）
  const speakers: string[] = []
  for (const line of lines) {
    if (line.speaker && !speakers.includes(line.speaker)) speakers.push(line.speaker)
  }

  // 用最后一句（通常是当前画面定格的台词）的情绪作为主导神态
  const dominantEmotion = inferEmotion(lines[lines.length - 1].text)

  if (speakers.length === 0) {
    // 没有明确说话人，但有台词内容：视为画外/独白氛围
    return `画面中人物正在说话，口型张开、${dominantEmotion}，肢体语言自然`
  }

  if (speakers.length === 1) {
    const hasOthers = characterNames.length > 1
    const target = hasOthers ? '看向对话对象' : '神情专注、像在独白自语'
    return `${speakers[0]} 正在说话，口型张开、${dominantEmotion}，眼神${target}`
  }

  // 多角色对话进行中
  return `${speakers.join('、')} 之间正在对话，说话者口型张开、${dominantEmotion}，` +
    `角色间有眼神与姿态互动，呈现对话进行中的戏剧张力`
}

function loadStoryboardCharacters(storyboardId: number): CharacterRecord[] {
  const links = db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
  if (!links.length) return []
  const characterIds = links.map((l) => l.characterId)
  return characterIds.length
    ? db.select().from(schema.characters).where(inArray(schema.characters.id, characterIds)).all()
    : []
}

function truncate(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : t.slice(0, max)
}

/**
 * 取同一集内相邻镜头（前一个/后一个 storyboardNumber）的摘要，用于承上启下。
 */
function buildContinuityNote(sb: StoryboardRecord): string {
  if (sb.storyboardNumber == null) return ''
  const siblings = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, sb.episodeId)).all()
    .filter((s) => !s.deletedAt)

  const summarize = (s: StoryboardRecord | undefined): string => {
    if (!s) return ''
    const text = s.title || s.action || s.description || ''
    return truncate(text, CONTEXT_SUMMARY_MAX)
  }

  const prev = siblings.find((s) => s.storyboardNumber === sb.storyboardNumber! - 1)
  const next = siblings.find((s) => s.storyboardNumber === sb.storyboardNumber! + 1)

  const parts: string[] = []
  const prevSummary = summarize(prev)
  const nextSummary = summarize(next)
  if (prevSummary) parts.push(`承接上一镜：${prevSummary}`)
  if (nextSummary) parts.push(`将引出下一镜：${nextSummary}`)
  return parts.join('；')
}

/**
 * 把一个角色描述成「角色名（外观）」纯文本，用于跨镜头角色一致性。
 * 不使用 <role> 标签，避免与 images.ts 的 expandRoleTags 冲突。
 */
function describeCharacter(char: CharacterRecord): string {
  const appearance = (char.appearance || char.description || char.role || '').trim()
  if (!char.name) return ''
  return appearance ? `${char.name}（${appearance}）` : char.name
}

/**
 * 主函数：拼装分镜图片 prompt。
 *
 * 按优先级分层累加，维护字符预算：
 *   必保层：基础画面 / 对白表演 / 角色外观
 *   可裁层（预算不足时依次跳过）：上下文承接 → 氛围补充 → result
 */
function loadDramaStyle(episodeId: number | null | undefined): string | null {
  if (!episodeId) return null
  const [episode] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId)).all()
  if (!episode?.dramaId) return null
  const [drama] = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId)).all()
  return drama?.style || null
}

export function buildStoryboardImagePrompt(storyboardId: number): string {
  const [sb] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) return `Storyboard ${storyboardId}`
  const [episode] = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, sb.episodeId)).all()

  const dramaStyle = loadDramaStyle(sb.episodeId)
  const characters = loadStoryboardCharacters(storyboardId)
  const characterNames = characters.map((c) => c.name || '').filter(Boolean)

  // 必保层
  const basePicture = normalizeStoryboardImagePromptForAspectRatio(
    stripVideoTags(sb.imagePrompt || sb.description || sb.title || `Storyboard ${storyboardId}`),
    episode?.aspectRatio,
  )
  if (sb.imagePromptFinal && sb.imagePrompt) {
    return applyVisualStyle(basePicture, dramaStyle)
  }

  const dialoguePerformance = describeDialoguePerformance(sb.dialogue, characterNames)
  const characterDesc = characters
    .map(describeCharacter)
    .filter(Boolean)
    .join('；')

  // 可裁层素材
  const action = stripVideoTags(sb.action || '')
  const result = stripVideoTags(sb.result || '')
  const atmosphere = stripVideoTags(sb.atmosphere || '')
  const place = [sb.location, sb.time].map((v) => (v || '').trim()).filter(Boolean).join('，')
  const continuity = buildContinuityNote(sb)

  // 去重：若基础画面已包含某文本，则不重复拼
  const seen = basePicture
  const notInBase = (text: string) => text && !seen.includes(text)

  const segments: { text: string; required: boolean }[] = []
  segments.push({ text: basePicture, required: true })
  if (notInBase(action)) segments.push({ text: `动作：${action}`, required: false })
  if (dialoguePerformance) segments.push({ text: dialoguePerformance, required: true })
  if (characterDesc) segments.push({ text: `角色形象：${characterDesc}`, required: true })
  if (notInBase(result)) segments.push({ text: `画面结果：${result}`, required: false })
  if (notInBase(atmosphere)) segments.push({ text: `氛围：${atmosphere}`, required: false })
  if (notInBase(place)) segments.push({ text: `场景：${place}`, required: false })
  if (continuity) segments.push({ text: continuity, required: false })

  // 按预算累加：必保层始终拼入，可裁层超预算则跳过
  const SEPARATOR = '。'
  let assembled = ''
  for (const seg of segments) {
    const piece = seg.text.trim()
    if (!piece) continue
    const candidate = assembled ? `${assembled}${SEPARATOR}${piece}` : piece
    if (seg.required || candidate.length <= PROMPT_CHAR_BUDGET) {
      assembled = candidate
    }
  }

  return applyVisualStyle(stripVideoTags(assembled), dramaStyle)
}
