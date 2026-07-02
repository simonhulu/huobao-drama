import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { createTask, addTaskDependency, normalizeTask } from './store.js'
import type { CreationTask } from './types.js'
import { getActiveConfig } from '../ai.js'
import { aspectRatioToSize } from '../adapters/aspect-ratio-to-size.js'
import { buildStoryboardImagePrompt } from '../storyboard-image-prompt.js'
import { ensureCharacterSeed } from '../image-seed.js'
import { parseDialogueForTTS, isIgnorableTTS } from '../ffmpeg-compose.js'
import { allowsNarratorAgent, getEpisodeVisualStyle, usesOriginalTextForNarration } from '../episode-mode.js'
import { resolveStoryboardNarrationTextForTTS, restoreOriginalTextNarrations } from '../narration-generation.js'
import { now } from '../../utils/response.js'

export const AUTO_STRUCTURE_TASK_PRIORITY = 50
const ACTIVE_STATUSES = new Set(['queued', 'running'])

function isAutoMode(episodeId: number): boolean {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  return ep?.autoMode === true
}

function parsePayloadJson(payloadJson: string | null | undefined) {
  if (!payloadJson) return null
  try {
    return JSON.parse(payloadJson)
  } catch {
    return null
  }
}

function isIgnorableNarration(text?: string | null): boolean {
  const raw = text?.trim() || ''
  if (!raw) return true
  return /^(无|无旁白|无需配音|无需旁白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i.test(raw)
}

function formatRetentionInstruction(ep?: typeof schema.episodes.$inferSelect | null): string {
  const raw = ep?.retentionBeats
  if (!raw) return ''
  try {
    const plan = JSON.parse(raw)
    const opening = plan?.openingHook?.text ? `开头：${plan.openingHook.text}` : ''
    const cliffhanger = plan?.cliffhanger?.text ? `结尾：${plan.cliffhanger.text}` : ''
    const midBeats = Array.isArray(plan?.midBeats)
      ? plan.midBeats
        .slice(0, 4)
        .map((beat: any) => `${beat.atSeconds || ''}秒 ${beat.label || '留存推进'}：${beat.question || beat.purpose || ''}`.trim())
        .filter(Boolean)
        .join('；')
      : ''
    const checks = Array.isArray(plan?.retentionChecks)
      ? plan.retentionChecks.slice(0, 5).join('；')
      : ''
    const parts = [opening, midBeats ? `中段：${midBeats}` : '', cliffhanger, checks ? `检查：${checks}` : ''].filter(Boolean)
    return parts.length ? `留存结构要求：${parts.join('。')}。` : ''
  } catch {
    return ''
  }
}

function findActiveNarratorTask(episodeId: number): CreationTask | null {
  const rows = db.select().from(schema.creationTasks)
    .where(and(
      eq(schema.creationTasks.type, 'agent.run'),
      eq(schema.creationTasks.episodeId, episodeId),
    ))
    .all()
  const active = rows
    .filter(row => {
      const payload = parsePayloadJson(row.payloadJson)
      return payload && (payload.agent_type === 'narrator' || payload.agentType === 'narrator')
    })
    .find(row => ACTIVE_STATUSES.has(row.status))
  return active ? normalizeTask(active) : null
}

function hasMissingNarrations(episodeId: number): boolean {
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
  return storyboards.some(sb => !isIgnorableNarration(sb.narration) && !sb.narration?.trim())
}

export function ensureNarratorTaskForEpisode(dramaId: number, episodeId: number): CreationTask | null {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()

  if (!hasMissingNarrations(episodeId)) return null

  if (usesOriginalTextForNarration(ep)) {
    // direct_script/verbatim: narration 字段只是逐镜头 TTS 原文切片，不允许调 narrator 改写。
    try {
      restoreOriginalTextNarrations(episodeId)
    } catch (err) {
      console.error('[ensureNarratorTaskForEpisode] restoreOriginalTextNarrations failed', err)
    }
    return null
  }

  const active = findActiveNarratorTask(episodeId)
  if (active) return active

  return scheduleNarratorAfterSplitter(dramaId, episodeId)
}

export function scheduleScriptRewriteForEpisode(dramaId: number, episodeId: number, content: string) {
  return createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:script_rewriter:auto:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'script_rewriter',
      message: `请根据以下原始故事内容改写成剧本，并保存到 episode ${episodeId}。\n\n原始故事：\n${content}`,
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })
}

export function scheduleAutoStartForEpisode(dramaId: number, episodeId: number, content: string) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const enableAiRewrite = ep?.enableAiRewrite ?? true
  if (enableAiRewrite) {
    return scheduleScriptRewriteForEpisode(dramaId, episodeId, content)
  }
  return scheduleExtractAfterRewrite(dramaId, episodeId)
}

export function scheduleExtractAfterRewrite(dramaId: number, episodeId: number) {
  return createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:extractor:auto:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'extractor',
      message: '请从当前集的格式化剧本中提取角色和场景信息，去重合并后保存。',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })
}

export function scheduleVoiceAssignAfterExtract(dramaId: number, episodeId: number): CreationTask | null {
  // 如果 drama 下所有非删除角色都已分配音色，则跳过本次调度
  const chars = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, dramaId)).all()
    .filter(c => !c.deletedAt)
  if (chars.length === 0 || chars.every(c => c.voiceStyle)) {
    return null
  }

  return createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:voice_assigner:auto:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'voice_assigner',
      message: '请为当前集所有角色分配合适的音色。',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })
}

export function resetEpisodeStoryboards(episodeId: number) {
  const ids = db.select({ id: schema.storyboards.id })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .map(r => r.id)
  if (ids.length) {
    db.delete(schema.storyboardCharacters)
      .where(inArray(schema.storyboardCharacters.storyboardId, ids))
      .run()
  }
  db.delete(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .run()
}

export function resetDramaEpisodes(dramaId: number) {
  const episodes = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId)).all()
  for (const ep of episodes) {
    resetEpisodeStoryboards(ep.id)
    db.delete(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, ep.id)).run()
    db.delete(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, ep.id)).run()
  }
  db.delete(schema.episodes).where(eq(schema.episodes.dramaId, dramaId)).run()
  db.update(schema.dramas)
    .set({ totalEpisodes: 0, totalDuration: 0, updatedAt: now() })
    .where(eq(schema.dramas.id, dramaId))
    .run()
}

export function scheduleBreakdownAndNarrationForEpisode(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const openingHook = ep?.openingHook || ''
  const cliffhanger = ep?.cliffhanger || ''
  const dialogueMode = ep?.dialogueMode || 'narration_only'
  const retentionInstruction = formatRetentionInstruction(ep)

  const breaker = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:storyboard_breaker:pacing:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'storyboard_breaker',
      message: `请按高留存短剧要求重新拆解分镜。本集 dialogue_mode=${dialogueMode}。第一镜必须是 3 秒钩子（opening_hook：${openingHook}），最后一镜必须是结尾悬念（cliffhanger：${cliffhanger}）。${retentionInstruction}每镜标注 energy_level（high/medium/low），删除纯内心独白镜头，保留关键事件和强情绪转折。保存完整分镜。`,
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  const splitter = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:storyboard_splitter:pacing:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'storyboard_splitter',
      message: '请按高留存短剧节奏检查并细分超载镜头：按动作阶段/情绪转折/空间转移拆分，禁止因内心独白递进拆分，保持第一镜为钩子、最后一镜为悬念，每镜标注 energy_level。保存完整分镜。',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  const narrator = allowsNarratorAgent(ep) ? createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:narrator:pacing:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'narrator',
      message: `请用电影解说视角重新生成旁白。本集 dialogue_mode=${dialogueMode}。第一句必须是钩子（${openingHook}），最后一句必须是悬念（${cliffhanger}）。${retentionInstruction}每镜 1-3 句，交代人物关系和情节，不写内心独白，有对白时转述为旁白。保存到每个镜头的 narration 字段。`,
      drama_id: dramaId,
      episode_id: episodeId,
    },
  }) : null

  addTaskDependency(splitter.id, breaker.id)
  if (narrator) {
    addTaskDependency(narrator.id, splitter.id)
  }

  return { breaker, splitter, narrator }
}

export function scheduleDirectScriptPipeline(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const dialogueMode = ep?.dialogueMode || 'narration_only'
  const retentionInstruction = formatRetentionInstruction(ep)

  const breaker = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:storyboard_breaker:direct_script:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'storyboard_breaker',
      message: retentionInstruction
        ? `请将当前集精稿直出拆分成镜头。dialogue_mode=${dialogueMode}。忠实于生产稿，不添加原文没有的情节；第一镜承接 opening hook，结尾镜承接 cliffhanger，并按留存结构安排中段证据/反转。${retentionInstruction}保存完整分镜。`
        : `请将当前集精稿直出拆分成镜头。dialogue_mode=${dialogueMode}。请忠实于原文结构，保留对白、动作、空间转换和背景交代，不强制短剧钩子/悬念/energy_level。保存完整分镜。`,
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  // direct_script 的原文就是最终 TTS 内容；这里绝不创建 narrator 改写任务。
  return { breaker, narrator: null }
}

export function scheduleStoryboardBreakerForDirectScript(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const dialogueMode = ep?.dialogueMode || 'narration_only'
  const retentionInstruction = formatRetentionInstruction(ep)
  return createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:storyboard_breaker:direct_script:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'storyboard_breaker',
      message: retentionInstruction
        ? `请将当前集精稿直出拆分成镜头。dialogue_mode=${dialogueMode}。忠实于生产稿，不添加原文没有的情节；第一镜承接 opening hook，结尾镜承接 cliffhanger，并按留存结构安排中段证据/反转。${retentionInstruction}保存完整分镜。`
        : `请将当前集精稿直出拆分成镜头。dialogue_mode=${dialogueMode}。请忠实于原文结构，保留对白、动作、空间转换和背景交代，不强制短剧钩子/悬念/energy_level。保存完整分镜。`,
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })
}

export function scheduleStoryboardBreakerAfterVoiceAssign(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const openingHook = ep?.openingHook || ''
  const cliffhanger = ep?.cliffhanger || ''
  const dialogueMode = ep?.dialogueMode || 'narration_only'
  const retentionInstruction = formatRetentionInstruction(ep)
  return createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:storyboard_breaker:auto:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'storyboard_breaker',
      message: `请将当前集剧本拆成高留存分镜。dialogue_mode=${dialogueMode}。第一镜必须是 3 秒钩子（${openingHook}），最后一镜必须是结尾悬念（${cliffhanger}）。${retentionInstruction}每镜标注 energy_level（high/medium/low），删除纯内心独白镜头，保留关键事件和强情绪转折，并保存所有分镜。`,
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })
}

export function scheduleNarratorAfterSplitter(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!allowsNarratorAgent(ep)) return null
  const openingHook = ep?.openingHook || ''
  const cliffhanger = ep?.cliffhanger || ''
  const dialogueMode = ep?.dialogueMode || 'narration_only'
  const retentionInstruction = formatRetentionInstruction(ep)
  return createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:narrator:auto:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'narrator',
      message: `请用电影解说视角生成旁白。dialogue_mode=${dialogueMode}。第一句必须是钩子（${openingHook}），最后一句必须是悬念（${cliffhanger}）。${retentionInstruction}每镜 1-3 句，交代人物关系和情节，不写内心独白，有对白时转述为旁白。保存到每个镜头的 narration 字段。`,
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })
}

export function scheduleStoryboardSplitterAfterBreakdown(dramaId: number, episodeId: number) {
  return createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    priority: AUTO_STRUCTURE_TASK_PRIORITY,
    idempotencyKey: `agent.run:storyboard_splitter:auto:${dramaId}:${episodeId}`,
    payload: {
      agent_type: 'storyboard_splitter',
      message: '请检查本集所有镜头，按动作阶段/情绪转折/空间转移细分超载镜头。每个子镜头 5-12 秒，每镜标注 energy_level，保持第一镜为钩子、最后一镜为悬念，保存完整分镜序列。',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })
}

export function scheduleVoiceSampleTasks(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  // narration_only 模式下分镜没有角色对白，试听样本永远不会被使用
  if (ep?.dialogueMode === 'narration_only') {
    return { parentTask: null, childTasks: [] }
  }

  const chars = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, dramaId)).all()
    .filter(c => c.voiceStyle && !c.deletedAt && !c.voiceSampleUrl)

  if (chars.length === 0) return { parentTask: null, childTasks: [] }

  const childTasks = chars.map(char =>
    createTask({
      type: 'tts.character_sample',
      dramaId,
      episodeId,
      scopeType: 'character',
      scopeId: char.id,
      idempotencyKey: `tts.character_sample:auto:${char.id}:${episodeId}`,
      payload: {
        character_id: char.id,
        episode_id: episodeId,
      },
    })
  )

  const parentTask = createTask({
    type: 'tts.episode',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `tts.episode:voice_samples:auto:${episodeId}`,
    payload: {
      episode_id: episodeId,
    },
  })

  for (const child of childTasks) {
    addTaskDependency(parentTask.id, child.id)
  }

  return { parentTask, childTasks }
}

export function scheduleCharacterImageTasks(dramaId: number, episodeId: number) {
  const episodeLinks = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
  const linkedCharacterIds = new Set(episodeLinks.map(link => link.characterId))

  const chars = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, dramaId)).all()
    .filter(char => {
      if (char.deletedAt) return false
      if (linkedCharacterIds.size > 0 && !linkedCharacterIds.has(char.id)) return false
      return !char.imageUrl && !char.localPath
    })

  if (chars.length === 0) return { parentTask: null, childTasks: [] }

  const childTasks = chars.map(char =>
    createTask({
      type: 'image.generate',
      dramaId,
      episodeId,
      scopeType: 'character',
      scopeId: char.id,
      priority: 10,
      idempotencyKey: `image.generate:character:auto:${char.id}:episode:${episodeId}`,
      payload: {
        image_generation_id: createImageGenerationRecordForCharacter(char.id, dramaId),
      },
    })
  )

  return { parentTask: null, childTasks }
}

export function scheduleImageGenerationForEpisode(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return { parentTask: null, childTasks: [] }

  const size = aspectRatioToSize(ep.aspectRatio)
  const visualStyle = getEpisodeVisualStyle(episodeId)
  // image_story uses first_frame (written to storyboard.firstFrameImage, consumed by ffmpeg-compose)
  // ai_video uses composed (reference image for video generation)
  const frameType = visualStyle === 'ai_video' ? 'composed' : 'first_frame'

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber).all()

  const targets = storyboards.filter(sb =>
    visualStyle === 'ai_video' ? !sb.composedImage : !sb.firstFrameImage
  )
  if (targets.length === 0) return { parentTask: null, childTasks: [] }

  const childTasks = targets.map(sb =>
    createTask({
      type: 'image.generate',
      dramaId,
      episodeId,
      scopeType: 'storyboard',
      scopeId: sb.id,
      idempotencyKey: `image.generate:storyboard:auto:${sb.id}:${frameType}`,
      payload: {
        image_generation_id: createImageGenerationRecordForStoryboard(sb.id, dramaId, episodeId, size, frameType),
        frame_type: frameType,
      },
    })
  )

  const parentTask = createTask({
    type: 'image.episode',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `image.episode:auto:${episodeId}`,
    payload: { episode_id: episodeId },
  })

  for (const child of childTasks) {
    addTaskDependency(parentTask.id, child.id)
  }

  return { parentTask, childTasks }
}

export function scheduleVideoGenerationForEpisode(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return { parentTask: null, childTasks: [] }

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber).all()

  const targets = storyboards.filter(sb => !sb.videoUrl && sb.composedImage)
  if (targets.length === 0) return { parentTask: null, childTasks: [] }

  const childTasks = targets.map(sb =>
    createTask({
      type: 'video.generate',
      dramaId,
      episodeId,
      scopeType: 'storyboard',
      scopeId: sb.id,
      idempotencyKey: `video.generate:storyboard:auto:${sb.id}`,
      payload: {
        video_generation_id: createVideoGenerationRecordForStoryboard(sb.id, dramaId, episodeId, ep.aspectRatio),
      },
    })
  )

  const parentTask = createTask({
    type: 'video.episode',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `video.episode:auto:${episodeId}`,
    payload: { episode_id: episodeId },
  })

  for (const child of childTasks) {
    addTaskDependency(parentTask.id, child.id)
  }

  return { parentTask, childTasks }
}

export function scheduleTTSForEpisode(dramaId: number, episodeId: number) {
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber).all()

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const dialogueMode = ep?.dialogueMode || 'narration_only'

  const targets = storyboards.filter((sb) => {
    const parsed = parseDialogueForTTS(sb.dialogue)
    const needsDialogue = dialogueMode !== 'narration_only' && !parsed.ignorable && !sb.ttsAudioUrl
    const narrationText = resolveStoryboardNarrationTextForTTS(sb, ep)
    const needsNarration = !isIgnorableTTS(narrationText) && !sb.narrationAudioUrl
    return needsDialogue || needsNarration
  })

  if (targets.length === 0) return { parentTask: null, childTasks: [] }

  const childTasks = targets.map(sb =>
    createTask({
      type: 'tts.storyboard',
      dramaId,
      episodeId,
      scopeType: 'storyboard',
      scopeId: sb.id,
      idempotencyKey: `tts.storyboard:auto:${sb.id}`,
      payload: {
        storyboard_id: sb.id,
        episode_id: episodeId,
      },
    })
  )

  const parentTask = createTask({
    type: 'tts.episode',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `tts.episode:auto:${episodeId}`,
    payload: { episode_id: episodeId },
  })

  for (const child of childTasks) {
    addTaskDependency(parentTask.id, child.id)
  }

  return { parentTask, childTasks }
}

export function scheduleComposeForEpisode(dramaId: number, episodeId: number, storyboardIds?: number[]) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return { parentTask: null, childTasks: [] }

  const visualStyle = getEpisodeVisualStyle(episodeId)
  let storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber).all()

  if (storyboardIds?.length) {
    const idSet = new Set(storyboardIds)
    storyboards = storyboards.filter(sb => idSet.has(sb.id))
  }

  const withMedia = storyboards.filter(sb =>
    visualStyle === 'ai_video' ? !!sb.videoUrl : !!sb.firstFrameImage
  )

  if (withMedia.length === 0) return { parentTask: null, childTasks: [] }

  const childTasks = withMedia.map(sb =>
    createTask({
      type: 'compose.storyboard',
      dramaId,
      episodeId,
      scopeType: 'storyboard',
      scopeId: sb.id,
      idempotencyKey: `compose.storyboard:auto:${sb.id}`,
      payload: {
        storyboard_id: sb.id,
        force: false,
      },
    })
  )

  const parentTask = createTask({
    type: 'compose.episode',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `compose.episode:auto:${episodeId}`,
    payload: { episode_id: episodeId },
  })

  for (const child of childTasks) {
    addTaskDependency(parentTask.id, child.id)
  }

  // 图文叙事模式下，合成必须等 narrator 完成，否则旁白字段为空会导致合成出无旁白的镜头
  const activeNarrator = findActiveNarratorTask(episodeId)
  if (activeNarrator) {
    for (const child of childTasks) {
      addTaskDependency(child.id, activeNarrator.id)
    }
  }

  return { parentTask, childTasks }
}

export function scheduleMergeForEpisode(dramaId: number, episodeId: number) {
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber).all()

  const videos = storyboards
    .map(sb => sb.composedVideoUrl)
    .filter(Boolean) as string[]

  if (videos.length === 0) return null

  // Prevent duplicate merge records — skip if one already exists for this episode
  const existing = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()
    .filter(m => m.status === 'pending' || m.status === 'completed' || m.status === 'running')
  if (existing.length > 0) return null

  const ts = new Date().toISOString()
  const mergeResult = db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: `Episode ${episodeId} Auto Merge`,
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'pending',
    scenes: JSON.stringify(videos),
    createdAt: ts,
  }).run()
  const mergeId = Number(mergeResult.lastInsertRowid)

  const task = createTask({
    type: 'merge.episode',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `merge.episode:auto:${episodeId}`,
    payload: {
      merge_id: mergeId,
      episode_id: episodeId,
      drama_id: dramaId,
    },
  })

  db.update(schema.videoMerges)
    .set({ taskId: String(task.id) })
    .where(eq(schema.videoMerges.id, mergeId))
    .run()

  return task
}

function createImageGenerationRecordForStoryboard(
  storyboardId: number,
  dramaId: number,
  episodeId: number,
  size: string,
  frameType: string,
) {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)

  const ts = new Date().toISOString()
  const config = getActiveConfig('image')
  if (!config) throw new Error('No active image AI config')

  // 收集分镜关联的角色参考图和场景参考图，用于保持跨集形象/场景一致性
  const referenceImages = collectStoryboardReferenceImages(storyboardId, sb.sceneId)

  const res = db.insert(schema.imageGenerations).values({
    storyboardId,
    dramaId,
    prompt: buildStoryboardImagePrompt(storyboardId),
    model: config.model,
    provider: config.provider,
    size,
    frameType,
    referenceImages: referenceImages.length > 0 ? JSON.stringify(referenceImages) : null,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function collectStoryboardReferenceImages(storyboardId: number, sceneId: number | null): string[] {
  const refs: string[] = []

  // 角色参考图
  const characterLinks = db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .all()
  if (characterLinks.length > 0) {
    const characterIds = characterLinks.map(l => l.characterId)
    const characters = db.select().from(schema.characters)
      .where(inArray(schema.characters.id, characterIds))
      .all()
    for (const char of characters) {
      if (char.imageUrl) refs.push(char.imageUrl)
      else if (char.localPath) refs.push(char.localPath)
    }
  }

  // 场景参考图
  if (sceneId) {
    const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId)).all()
    if (scene?.imageUrl) refs.push(scene.imageUrl)
    else if (scene?.localPath) refs.push(scene.localPath)
  }

  return Array.from(new Set(refs.filter(Boolean)))
}

function createImageGenerationRecordForCharacter(characterId: number, dramaId: number) {
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).all()
  if (!char) throw new Error(`Character ${characterId} not found`)

  const ts = new Date().toISOString()
  const config = getActiveConfig('image')
  if (!config) throw new Error('No active image AI config')
  const seed = char.seed ?? ensureCharacterSeed(characterId)
  const prompt = `${char.name}, ${char.appearance || char.description || '人物立绘'}, 高质量, 正面, 白色背景`

  const res = db.insert(schema.imageGenerations).values({
    dramaId,
    characterId,
    imageType: 'character',
    prompt,
    model: config.model,
    provider: config.provider,
    size: '1024x1024',
    seed,
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function createVideoGenerationRecordForStoryboard(
  storyboardId: number,
  dramaId: number,
  episodeId: number,
  aspectRatio: string | null,
) {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)

  const ts = new Date().toISOString()
  const config = getActiveConfig('video')
  if (!config) throw new Error('No active video AI config')

  const res = db.insert(schema.videoGenerations).values({
    storyboardId,
    dramaId,
    prompt: sb.videoPrompt || sb.imagePrompt || sb.description || `Storyboard ${storyboardId}`,
    model: config.model,
    provider: config.provider,
    referenceMode: 'first_frame',
    imageUrl: sb.composedImage,
    duration: sb.duration || 5,
    aspectRatio: aspectRatio || '16:9',
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}
