/**
 * 旁白(解说)Agent 工具
 * 工厂函数模式 — 注入 episodeId + dramaId
 *
 * 设计要点:旁白要"看图说书",从原始故事取料,贴合每个镜头画面,上下文连贯。
 * read_narration_context 一次性给齐:原始故事原文 + 全镜头画面语义 + 已有旁白。
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'

export function createNarratorTools(episodeId: number, dramaId: number) {
  const readNarrationContext = createTool({
    id: 'read_narration_context',
    description: 'Read the original story and all storyboard shots for narration writing.',
    inputSchema: z.object({}),
    execute: async () => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: 'Episode not found' }

      // 旁白回原文取料：原始内容优先，没有再退回格式化剧本
      const originalStory = ep.content || ep.scriptContent
      if (!originalStory) return { error: 'Episode has no story content' }

      const shots = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()
        .filter(sb => !sb.deletedAt)
        .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
        .map(sb => ({
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          location: sb.location || '',
          time: sb.time || '',
          shot_type: sb.shotType || '',
          action: sb.action || '',
          result: sb.result || '',
          atmosphere: sb.atmosphere || '',
          description: sb.description || '',
          image_prompt: sb.imagePrompt || '',
          dialogue: sb.dialogue || '',
          narration: sb.narration || '',
          duration: sb.duration || 0,
        }))

      if (!shots.length) return { error: 'No storyboards yet — run storyboard breakdown first' }

      const payload = {
        episode: {
          id: ep.id,
          title: ep.title,
          episode_number: ep.episodeNumber,
        },
        original_story: originalStory,
        shots,
      }
      logTaskSuccess('NarratorTool', 'read-context', {
        episodeId,
        dramaId,
        shots: shots.length,
        storyLength: originalStory.length,
      })
      return payload
    },
  })

  const saveNarrations = createTool({
    id: 'save_narrations',
    description: 'Save narration text per shot. Matches by shot_number, updates existing storyboards.',
    inputSchema: z.object({
      narrations: z.array(z.object({
        shot_number: z.number(),
        narration: z.string(),
      })),
    }),
    execute: async ({ narrations }) => {
      const ts = now()
      logTaskProgress('NarratorTool', 'save-begin', {
        episodeId,
        count: narrations.length,
        shotNumbers: narrations.map(n => n.shot_number).join(','),
      })

      const shots = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()
        .filter(sb => !sb.deletedAt)
      const byNumber = new Map(shots.map(sb => [sb.storyboardNumber, sb.id]))

      let updated = 0
      const missing: number[] = []
      for (const item of narrations) {
        const sbId = byNumber.get(item.shot_number)
        if (!sbId) { missing.push(item.shot_number); continue }
        db.update(schema.storyboards)
          .set({ narration: item.narration, updatedAt: ts })
          .where(eq(schema.storyboards.id, sbId))
          .run()
        updated++
      }

      logTaskSuccess('NarratorTool', 'save-complete', { episodeId, updated, missing: missing.join(',') })
      return {
        message: `Saved narration for ${updated} shots`,
        updated,
        missing_shot_numbers: missing,
      }
    },
  })

  return { readNarrationContext, saveNarrations }
}
