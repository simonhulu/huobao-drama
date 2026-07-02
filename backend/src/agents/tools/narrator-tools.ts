/**
 * 旁白(解说)Agent 工具
 * 工厂函数模式 — 注入 episodeId + dramaId
 *
 * 设计要点:旁白要锚定镜头,同时保留原始故事里的关键信息。
 * read_narration_context 一次性给齐:原始故事原文 + 格式化剧本 + 全镜头语义 + 角色信息。
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { usesOriginalTextForNarration } from '../../services/episode-mode.js'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'

const NARRATION_RETENTION_RULES = [
  '旁白要锚定当前镜头承载的故事功能，而不只是复述表面动作。',
  '内心、背景、因果、动机、悬念只要与当前镜头有关，就必须保留。',
  '不可直接看见的信息，要借当前镜头的表演、环境、物件和前后关系来转译。',
  '对白镜头优先给对白让位，但仍要保留必要的铺垫和上下文。',
]

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
      const formattedScript = ep.scriptContent || ''

      const episodeCharacters = db.select().from(schema.episodeCharacters)
        .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      const characterIds = new Set(episodeCharacters.map(link => link.characterId))
      const characters = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
        .filter(c => !c.deletedAt)
        .filter(c => !characterIds.size || characterIds.has(c.id))
        .map(c => ({
          id: c.id,
          name: c.name,
          role: c.role || '',
          description: c.description || '',
          appearance: c.appearance || '',
          personality: c.personality || '',
        }))
      const charactersById = new Map(characters.map(character => [character.id, character]))

      const shots = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()
        .filter(sb => !sb.deletedAt)
        .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
        .map(sb => {
          const shotCharacterIds = db.select().from(schema.storyboardCharacters)
            .where(eq(schema.storyboardCharacters.storyboardId, sb.id)).all()
            .map(link => link.characterId)
          const shotCharacters = shotCharacterIds
            .map(characterId => charactersById.get(characterId))
            .filter((character): character is (typeof characters)[number] => Boolean(character))
          return {
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
            character_ids: shotCharacterIds,
            character_names: shotCharacters.map(character => character.name),
            story_focus: [sb.description, sb.action, sb.result, sb.atmosphere].filter(Boolean).join(' | '),
          }
        })

      if (!shots.length) return { error: 'No storyboards yet — run storyboard breakdown first' }

      const payload = {
        episode: {
          id: ep.id,
          title: ep.title,
          episode_number: ep.episodeNumber,
          dialogue_mode: ep.dialogueMode || 'narration_only',
          opening_hook: ep.openingHook || '',
          cliffhanger: ep.cliffhanger || '',
        },
        original_story: originalStory,
        formatted_script: formattedScript,
        episode_synopsis: ep.description || '',
        source_material: {
          original_story: originalStory,
          formatted_script: formattedScript,
        },
        storytelling_rules: NARRATION_RETENTION_RULES,
        characters,
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
      const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()

      if (usesOriginalTextForNarration(ep)) {
        logTaskSuccess('NarratorTool', 'save-skipped-original-text', {
          episodeId,
          attemptedCount: narrations.length,
        })
        return {
          message: 'Skipped AI narration; this episode uses original text for TTS',
          updated: 0,
          missing_shot_numbers: [],
        }
      }

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

      // 只有 story_rewrite + rewrite 模式才强制注入钩子、过渡、悬念；原文模式不注入。
      if (!usesOriginalTextForNarration(ep)) {
        const sortedShots = shots.slice().sort((a, b) => a.storyboardNumber - b.storyboardNumber)
        const openingHook = ep?.openingHook?.trim() || ''
        const cliffhanger = ep?.cliffhanger?.trim() || ''
        const transition = '到底发生了什么？我们接着看。'
        if (sortedShots.length === 1) {
          const only = sortedShots[0]
          const parts = [openingHook, cliffhanger].filter(Boolean)
          if (parts.length && only) {
            db.update(schema.storyboards)
              .set({ narration: parts.join(' '), updatedAt: ts })
              .where(eq(schema.storyboards.id, only.id))
              .run()
          }
        } else if (sortedShots.length >= 2) {
          const first = sortedShots[0]
          const last = sortedShots[sortedShots.length - 1]
          if (openingHook && first) {
            db.update(schema.storyboards)
              .set({ narration: openingHook, updatedAt: ts })
              .where(eq(schema.storyboards.id, first.id))
              .run()
          }
          if (cliffhanger && last) {
            db.update(schema.storyboards)
              .set({ narration: cliffhanger, updatedAt: ts })
              .where(eq(schema.storyboards.id, last.id))
              .run()
          }
          if (sortedShots.length >= 3) {
            const second = sortedShots[1]
            if (second) {
              db.update(schema.storyboards)
                .set({ narration: transition, updatedAt: ts })
                .where(eq(schema.storyboards.id, second.id))
                .run()
            }
          }
        }
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
