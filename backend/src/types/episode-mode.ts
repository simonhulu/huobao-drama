/**
 * 剧集生产流程的两种独立维度
 *
 * 为了避免 "story"/"script"/"render"/"mode" 等词互相混淆，
 * 这里把两个维度拆成两个正交的类型：
 *
 * 1. ScriptSource —— 剧本/文稿从哪来（决定前期流程）
 *    - story_rewrite：用户提供故事梗概，由 AI 改写成剧本后拆分分镜
 *    - direct_script：用户直接导入精稿/成品稿，按原文结构拆分分镜；原文直接作为 TTS 内容
 *
 * 2. VisualStyle —— 每个镜头用什么视觉形式呈现（决定后期合成）
 *    - image_story：静态图 + Ken Burns 运动 + 旁白/音效
 *    - ai_video：AI 生成的动态视频 + 对白/字幕
 *
 * 二者完全独立：
 *   从故事生成可以用 image_story，也可以用 ai_video；
 *   精稿直出也可以用 image_story 或 ai_video。
 *
 * 解说/旁白不是第三个 workflow_type：
 *   - story_rewrite + narration_mode=rewrite 才生成 AI 解说/旁白文案。
 *   - direct_script 不生成 AI 解说/旁白，storyboards.narration 只保存逐镜头原文 TTS 切片。
 */

export type ScriptSource = 'story_rewrite' | 'direct_script'
export type VisualStyle = 'image_story' | 'ai_video'

export const SCRIPT_SOURCE_LABELS: Record<ScriptSource, string> = {
  story_rewrite: '从故事生成',
  direct_script: '导入精稿直出',
}

export const VISUAL_STYLE_LABELS: Record<VisualStyle, string> = {
  image_story: '图文叙事',
  ai_video: 'AI 视频',
}

export function isStoryRewrite(source?: string | null): source is ScriptSource {
  return source === 'story_rewrite'
}

export function isDirectScript(source?: string | null): source is ScriptSource {
  return source === 'direct_script'
}

export function isImageStory(style?: string | null): style is VisualStyle {
  return style === 'image_story'
}

export function isAIVideo(style?: string | null): style is VisualStyle {
  return style === 'ai_video'
}
