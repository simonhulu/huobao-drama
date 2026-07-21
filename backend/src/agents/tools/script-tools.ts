/**
 * 剧本改写 Agent 工具
 * 工厂函数模式 — 注入 episodeId，工具不再需要 LLM 传递 ID
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { extractCoverDesign } from '../../services/cover-design-extractor.js'

export function createScriptTools(episodeId: number) {
  const readEpisodeScript = createTool({
    id: 'read_episode_script',
    description: 'Read the script content of the current episode.',
    inputSchema: z.object({}),
    execute: async () => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: `Episode not found (id=${episodeId})` }
      const content = ep.content || ep.scriptContent
      if (!content) return { error: `Episode has no content (id=${episodeId})` }
      return { content, word_count: content.length, episode_id: episodeId }
    },
  })

  const rewriteToScreenplay = createTool({
    id: 'rewrite_to_screenplay',
    description: 'Read the original content for AI rewriting. Returns the source text with formatting instructions.',
    inputSchema: z.object({
      instructions: z.string().optional().describe('Additional rewrite instructions'),
    }),
    execute: async ({ instructions }) => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: `Episode not found` }
      const source = ep.content || ep.scriptContent
      if (!source) return { error: `Episode has no content to rewrite` }

      return {
        source_content: source,
        instruction: `请将以下内容改写为格式化剧本。

格式规范：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段
- 动作描写：自然段落，不包含镜头语言
- 对白：角色名：（状态/表情）台词内容
- 每个场景 30-60 秒内容

${instructions || ''}

【原始内容】
${source}`,
      }
    },
  })

  const saveScript = createTool({
    id: 'save_script',
    description: 'Save the rewritten screenplay and any cover design produced with it to the current episode.',
    inputSchema: z.object({
      content: z.string().describe('The formatted screenplay content to save'),
      cover_design: z.unknown().optional().describe('Optional cover design object. If omitted, extract it from content.'),
    }),
    execute: async ({ content, cover_design }) => {
      const [episode] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!episode) return { error: `Episode not found (id=${episodeId})` }

      const designSource = cover_design === undefined || cover_design === null || cover_design === ''
        ? content
        : cover_design
      const coverDesign = extractCoverDesign(designSource, {
        episodeTitle: episode.title,
        episodeNumber: episode.episodeNumber,
        fallbackPrompt: episode.coverPrompt || undefined,
      })
      const updates: Record<string, any> = {
        scriptContent: content,
        updatedAt: now(),
      }
      if (coverDesign) {
        updates.coverDesignJson = JSON.stringify(coverDesign)
        if (coverDesign.ai_prompt?.trim()) updates.coverPrompt = coverDesign.ai_prompt.trim()
      }

      db.update(schema.episodes)
        .set(updates)
        .where(eq(schema.episodes.id, episodeId))
        .run()
      return {
        message: 'Script saved',
        word_count: content.length,
        cover_design_saved: !!coverDesign,
        cover_design: coverDesign,
      }
    },
  })

  return { readEpisodeScript, rewriteToScreenplay, saveScript }
}
