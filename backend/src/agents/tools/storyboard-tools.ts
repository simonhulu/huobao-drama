/**
 * 分镜拆解 Agent 工具
 * 工厂函数模式 — 注入 episodeId + dramaId
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { stripVideoTags } from '../../services/adapters/prompt-utils.js'
import { normalizeStoryboardImagePromptForAspectRatio } from '../../services/storyboard-aspect-prompt.js'

const STORY_RETENTION_RULES = [
  '镜头服务于故事，不得只保留表面动作。',
  '原文中的内心、背景、因果、动机、悬念与反转默认都是有效信息。',
  '不可直接看见的信息，要通过反应镜头、环境细节、物件特写、表情停顿或空间变化转译到镜头里。',
  '若某个镜头主要承担背景、心理或上下文承接，要在 description/action/result/atmosphere 中写清楚。',
  '只有信息重复且无叙事功能时，才允许压缩。',
]

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()

  const uniqueIds = [...new Set(characterIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

function getEpisodeSceneIds(episodeId: number) {
  return new Set(
    db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
      .map(link => link.sceneId),
  )
}

function getEpisodeCharacterIds(episodeId: number) {
  return new Set(
    db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      .map(link => link.characterId),
  )
}

function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined) {
  const episodeSceneIds = getEpisodeSceneIds(episodeId)
  const episodeCharacterIds = getEpisodeCharacterIds(episodeId)

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error(`scene_id ${sceneId} 不属于当前集`)
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error(`character_ids 不属于当前集: ${invalidCharacterIds.join(', ')}`)
  }
}

export function createStoryboardTools(episodeId: number, dramaId: number) {
  const getEpisodeAspectRatio = () => {
    const [ep] = db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId)).all()
    return ep?.aspectRatio ?? null
  }

  const readStoryboardContext = createTool({
    id: 'read_storyboard_context',
    description: 'Read the screenplay, characters, and scenes for storyboard breakdown.',
    inputSchema: z.object({}),
    execute: async () => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: 'Episode not found' }
      const script = ep.content || ep.scriptContent
      if (!script) return { error: 'Episode has no script' }
      const originalStory = ep.content || ''
      const formattedScript = ep.scriptContent || ''

      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()

      const charLinks = db.select().from(schema.episodeCharacters)
        .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      const sceneLinks = db.select().from(schema.episodeScenes)
        .where(eq(schema.episodeScenes.episodeId, episodeId)).all()

      const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
      const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))

      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
      const scns = db.select().from(schema.scenes)
        .where(eq(schema.scenes.dramaId, dramaId)).all()
      const existingStoryboards = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()

      const characters = chars
        .filter(c => !c.deletedAt)
        .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
        .map(c => ({
          id: c.id,
          name: c.name,
          role: c.role || '',
          description: c.description || '',
          appearance: c.appearance || '',
          personality: c.personality || '',
          voice_style: c.voiceStyle || '',
          image_url: c.imageUrl || '',
          reference_images: c.referenceImages || '',
        }))

      const scenes = scns
        .filter(s => !s.deletedAt)
        .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
        .map(s => ({
          id: s.id,
          location: s.location,
          time: s.time,
          prompt: s.prompt || '',
          image_url: s.imageUrl || '',
          storyboard_count: s.storyboardCount || 0,
        }))

      const payload = {
        drama: {
          id: drama?.id,
          title: drama?.title || '',
          style: drama?.style || '',
        },
        episode: {
          id: ep.id,
          title: ep.title,
          episode_number: ep.episodeNumber,
          description: ep.description || '',
          aspect_ratio: ep.aspectRatio || '',
          dialogue_mode: ep.dialogueMode || 'narration_only',
          opening_hook: ep.openingHook || '',
          cliffhanger: ep.cliffhanger || '',
        },
        original_story: originalStory,
        formatted_script: formattedScript,
        script,
        source_material: {
          original_story: originalStory,
          formatted_script: formattedScript,
          active_script: script,
          episode_synopsis: ep.description || '',
        },
        storytelling_rules: STORY_RETENTION_RULES,
        characters,
        scenes,
        existing_storyboards: existingStoryboards
          .filter(sb => !sb.deletedAt)
          .map(sb => ({
            id: sb.id,
            shot_number: sb.storyboardNumber,
            title: sb.title || '',
            scene_id: sb.sceneId,
            character_ids: db.select().from(schema.storyboardCharacters)
              .where(eq(schema.storyboardCharacters.storyboardId, sb.id)).all()
              .map(link => link.characterId),
            shot_type: sb.shotType || '',
            duration: sb.duration || 0,
            description: sb.description || '',
            action: sb.action || '',
            result: sb.result || '',
            atmosphere: sb.atmosphere || '',
            dialogue: sb.dialogue || '',
            narration: sb.narration || '',
          })),
      }
      logTaskSuccess('StoryboardTool', 'read-context', {
        episodeId,
        dramaId,
        characters: characters.length,
        scenes: scenes.length,
        existingStoryboards: payload.existing_storyboards.length,
        scriptLength: script.length,
      })
      return payload
    },
  })

  const saveStoryboards = createTool({
    id: 'save_storyboards',
    description: 'Save generated storyboards. Replaces all existing storyboards for this episode. When calling this tool, output the arguments as a plain JSON object. Do not wrap them in markdown code fences (```json). In direct_script mode, shots are saved exactly as provided; each shot should represent a complete narrative event or plot beat, not a sentence or time segment.',
    inputSchema: z.object({
      storyboards: z.array(z.object({
        shot_number: z.number(),
        title: z.string().optional(),
        shot_type: z.string().optional(),
        angle: z.string().optional(),
        movement: z.string().optional(),
        location: z.string().optional(),
        time: z.string().optional(),
        action: z.string().optional(),
        dialogue: z.string().optional(),
        description: z.string().optional(),
        result: z.string().optional(),
        atmosphere: z.string().optional(),
        image_prompt: z.string().optional(),
        video_prompt: z.string().optional(),
        bgm_prompt: z.string().optional(),
        sound_effect: z.string().optional(),
        duration: z.number().optional(),
        energy_level: z.enum(['high', 'medium', 'low']).optional(),
        scene_id: z.number().nullable().optional(),
        character_ids: z.array(z.number()).optional(),
      })),
    }),
    execute: async ({ storyboards }) => {
      const ts = now()
      logTaskProgress('StoryboardTool', 'save-begin', {
        episodeId,
        dramaId,
        count: storyboards.length,
        shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
      })
      const existingStoryboardIds = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()
        .map(sb => sb.id)
      for (const storyboardId of existingStoryboardIds) {
        db.delete(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
          .run()
      }
      db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()

      const aspectRatio = getEpisodeAspectRatio()
      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
      const style = drama?.style || ''

      const shotsToSave = storyboards
        .slice()
        .sort((a, b) => a.shot_number - b.shot_number)

      let totalDuration = 0
      for (const sb of shotsToSave) {
        validateStoryboardBindings(episodeId, sb.scene_id, sb.character_ids)
        const cleanedImagePrompt = normalizeStoryboardImagePromptForAspectRatio(
          stripVideoTags(sb.image_prompt || ''),
          aspectRatio,
        )
        const fallbackImagePrompt = cleanedImagePrompt || [sb.title, sb.location, sb.atmosphere].filter(Boolean).join('，')
        const res = db.insert(schema.storyboards).values({
          episodeId,
          storyboardNumber: sb.shot_number,
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          action: sb.action, dialogue: sb.dialogue,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere, imagePrompt: fallbackImagePrompt,
          videoPrompt: sb.video_prompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          sceneId: sb.scene_id, duration: sb.duration || 8,
          energyLevel: sb.energy_level || 'medium',
          createdAt: ts, updatedAt: ts,
        }).run()
        syncStoryboardCharacters(Number(res.lastInsertRowid), sb.character_ids || [])
        totalDuration += sb.duration || 8
      }

      db.update(schema.episodes)
        .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
        .where(eq(schema.episodes.id, episodeId)).run()

      logTaskSuccess('StoryboardTool', 'save-complete', {
        episodeId,
        count: shotsToSave.length,
        totalDuration,
      })
      return { message: `Saved ${shotsToSave.length} storyboards`, count: shotsToSave.length, total_duration: totalDuration }
    },
  })

  const updateStoryboard = createTool({
    id: 'update_storyboard',
    description: 'Update a specific storyboard shot.',
    inputSchema: z.object({
      storyboard_id: z.number(),
      title: z.string().optional(),
      shot_type: z.string().optional(),
      angle: z.string().optional(),
      movement: z.string().optional(),
      location: z.string().optional(),
      time: z.string().optional(),
      action: z.string().optional(),
      result: z.string().optional(),
      atmosphere: z.string().optional(),
      image_prompt: z.string().optional(),
      video_prompt: z.string().optional(),
      bgm_prompt: z.string().optional(),
      sound_effect: z.string().optional(),
      description: z.string().optional(),
      dialogue: z.string().optional(),
      scene_id: z.number().nullable().optional(),
      character_ids: z.array(z.number()).optional(),
      duration: z.number().optional(),
    }),
    execute: async ({ storyboard_id, ...fields }) => {
      const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).all()
      if (!storyboard) return { error: `Storyboard ${storyboard_id} not found` }
      logTaskProgress('StoryboardTool', 'update-begin', {
        episodeId,
        storyboardId: storyboard_id,
        fields: Object.keys(fields),
      })

      validateStoryboardBindings(
        episodeId,
        'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
        'character_ids' in fields
          ? fields.character_ids
          : db.select().from(schema.storyboardCharacters)
              .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)).all()
              .map(link => link.characterId),
      )

      const updates: Record<string, any> = { updatedAt: now() }
      if ('title' in fields) updates.title = fields.title
      if ('shot_type' in fields) updates.shotType = fields.shot_type
      if ('angle' in fields) updates.angle = fields.angle
      if ('movement' in fields) updates.movement = fields.movement
      if ('location' in fields) updates.location = fields.location
      if ('time' in fields) updates.time = fields.time
      if ('action' in fields) updates.action = fields.action
      if ('result' in fields) updates.result = fields.result
      if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
      if ('image_prompt' in fields) {
        updates.imagePrompt = normalizeStoryboardImagePromptForAspectRatio(
          stripVideoTags(fields.image_prompt || ''),
          getEpisodeAspectRatio(),
        )
        updates.imagePromptFinal = false
        if (!updates.imagePrompt) {
          const [existing] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).all()
          updates.imagePrompt = [existing?.title, existing?.location, existing?.atmosphere].filter(Boolean).join('，')
        }
      }
      if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt
      if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
      if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
      if ('description' in fields) updates.description = fields.description
      if ('dialogue' in fields) updates.dialogue = fields.dialogue
      if ('scene_id' in fields) updates.sceneId = fields.scene_id
      if ('duration' in fields) updates.duration = fields.duration
      db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id)).run()
      if ('character_ids' in fields) syncStoryboardCharacters(storyboard_id, fields.character_ids || [])
      logTaskSuccess('StoryboardTool', 'update-complete', {
        episodeId,
        storyboardId: storyboard_id,
        updatedFields: Object.keys(updates),
        characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      })
      return { message: `Storyboard ${storyboard_id} updated` }
    },
  })

  // 为宫格图生成整体提示词（分析选中镜头的描述，生成一个连贯的画格布局描述）
  const generateGridPrompt = createTool({
    id: 'generate_grid_prompt',
    description: '为宫格图生成整体画面描述。根据选中的镜头列表及其描述，生成一个连贯的宫格图提示词，用于一次性生成完整的宫格拼图。',
    inputSchema: z.object({
      shots: z.array(z.object({
        shot_number: z.number(),
        description: z.string(),
        shot_type: z.string().optional(),
        dialogue: z.string().optional(),
      })),
      rows: z.number(),
      cols: z.number(),
      mode: z.string(), // 'first_frame' | 'first_last' | 'multi_ref'
    }),
    execute: async ({ shots, rows, cols, mode }) => {
      if (!shots.length) return { error: 'No shots provided' }
      logTaskProgress('StoryboardTool', 'grid-prompt-begin', {
        episodeId,
        shots: shots.length,
        rows,
        cols,
        mode,
      })

      if (mode === 'multi_ref') {
        const sb = shots[0]
        const payload = {
          grid_prompt: `电影级高质量参考图，${sb.description}，专业摄影，电影质感，4K分辨率，${rows}x${cols} 宫格统一风格参考图`,
          cell_prompts: shots.map(s => ({
            shot_number: s.shot_number,
            frame_type: 'reference',
            prompt: `电影级高质量参考图，${s.description}，专业摄影，电影质感，4K分辨率，统一风格`,
          })),
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      if (mode === 'first_last') {
        const cellPrompts = []
        for (const s of shots) {
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'first_frame',
            prompt: `电影级高质量首帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'last_frame',
            prompt: `电影级高质量尾帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
        }
        const payload = {
          grid_prompt: `${shots.length}个镜头首尾帧拼图，${shots.map(s => s.description).join(' | ')}，电影级画面，专业摄影，${rows}行${cols}列风格统一`,
          cell_prompts: cellPrompts,
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      // first_frame mode
      const cellPrompts = shots.slice(0, rows * cols).map(s => ({
        shot_number: s.shot_number,
        frame_type: 'first_frame',
        prompt: `电影级高质量首帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
      }))
      const payload = {
        grid_prompt: `${shots.length}个镜头首帧拼图，${shots.map(s => s.description).join(' | ')}，电影级画面，专业摄影，${rows}行${cols}列风格统一`,
        cell_prompts: cellPrompts,
      }
      logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
      return payload
    },
  })

  return { readStoryboardContext, saveStoryboards, updateStoryboard, generateGridPrompt }
}
