import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { ScriptSource, VisualStyle } from '../types/episode-mode.js'

type EpisodeModeRow = Pick<typeof schema.episodes.$inferSelect, 'workflowType' | 'renderMode' | 'narrationMode'>

/**
 * 获取剧集的剧本来源模式（ScriptSource）。
 * 对应数据库字段 episodes.workflow_type。
 */
export function getEpisodeScriptSource(episodeId: number): ScriptSource {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  return getEpisodeScriptSourceFromRow(ep)
}

export function getEpisodeScriptSourceFromRow(ep?: Pick<EpisodeModeRow, 'workflowType'> | null): ScriptSource {
  return ep?.workflowType === 'direct_script' ? 'direct_script' : 'story_rewrite'
}

/**
 * 获取剧集的视觉呈现形式（VisualStyle）。
 * 对应数据库字段 episodes.render_mode。
 */
export function getEpisodeVisualStyle(episodeId: number): VisualStyle {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  return getEpisodeVisualStyleFromRow(ep)
}

export function getEpisodeVisualStyleFromRow(ep?: Pick<EpisodeModeRow, 'renderMode'> | null): VisualStyle {
  return ep?.renderMode === 'ai_video' ? 'ai_video' : 'image_story'
}

/**
 * 解说/旁白生产契约。
 *
 * 注意：数据库历史字段叫 storyboards.narration，但它在不同剧本来源下含义不同：
 * - story_rewrite + rewrite：narration 是 AI narrator 生成的“解说/旁白文案”。
 * - direct_script：用户导入的精稿本身就是最终 TTS 文本；narration 只是逐镜头原文切片缓存。
 * - 任意来源 + verbatim：narration 也只是原文切片缓存，不允许 narrator 改写。
 *
 * 因此 direct_script 永远不能调 narrator agent。以后不要用 narration 字段名反推业务含义。
 */
export function usesOriginalTextForNarration(ep?: Pick<EpisodeModeRow, 'workflowType' | 'narrationMode'> | null): boolean {
  return getEpisodeScriptSourceFromRow(ep) === 'direct_script' || ep?.narrationMode === 'verbatim'
}

/**
 * 只有故事改编且 narration_mode=rewrite 时，才允许生成新的 AI 解说/旁白文案。
 *
 * 这个函数是 narrator agent 的唯一业务闸口。不要在调用点用按钮状态、
 * 字段名或 workflow_type 字符串重新推断，否则 direct_script 会再次被污染。
 */
export function allowsNarratorAgent(ep?: Pick<EpisodeModeRow, 'workflowType' | 'narrationMode'> | null): boolean {
  return getEpisodeScriptSourceFromRow(ep) === 'story_rewrite' && ep?.narrationMode !== 'verbatim'
}
