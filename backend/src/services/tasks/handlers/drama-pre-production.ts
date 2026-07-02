/**
 * Drama 级预生产任务
 *
 * 目标：把角色/场景提取、音色分配、角色/场景形象生成、音色样本生成
 * 等一次性的 drama 级工作集中执行，避免在多集自动流水线中重复生成
 * 或出现跨集不一致。
 *
 * 执行流程：
 * 1. 遍历所有非删除集，运行 extractor agent 提取角色/场景
 * 2. 运行 voice_assigner agent 为所有未分配音色角色分配音色
 * 3. 为没有 imageUrl/localPath 的角色创建 image.generate 任务
 * 4. 为没有 imageUrl/localPath 的场景创建 image.generate 任务
 * 5. 为没有 voiceSampleUrl 的角色创建 tts.character_sample 任务
 */
import { createAgent as defaultCreateAgent, validAgentTypes } from '../../../agents/index.js'
import { db, schema } from '../../../db/index.js'
import { eq, and, isNull } from 'drizzle-orm'
import { registerTaskHandler } from '../registry.js'
import { createTask } from '../store.js'
import { createImageGenerationRecord } from '../../image-generation.js'
import { aspectRatioToSize } from '../../adapters/aspect-ratio-to-size.js'
import { ensureCharacterSeed, ensureSceneSeed } from '../../image-seed.js'
import { logTaskProgress, logTaskSuccess, logTaskWarn } from '../../../utils/task-logger.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface DramaPreProductionPayload {
  drama_id?: number
  dramaId?: number
}

interface CreateAgentLike {
  generate(messages: any, options: { maxSteps: number; abortSignal?: AbortSignal }): Promise<any>
}

interface DramaPreProductionDeps {
  createAgent?: (type: string, episodeId: number, dramaId: number) => CreateAgentLike | null
  createImageGenerationRecord?: typeof createImageGenerationRecord
}

const DEFAULT_EXTRACTOR_TIMEOUT_MS = 8 * 60 * 1000
const DEFAULT_VOICE_ASSIGNER_TIMEOUT_MS = 5 * 60 * 1000

function readPayload(payload: DramaPreProductionPayload) {
  const dramaId = Number(payload.drama_id ?? payload.dramaId)
  if (!Number.isFinite(dramaId) || !dramaId) {
    throw new Error('drama_id is required')
  }
  return { dramaId }
}

function createTimeoutSignal(parent: AbortSignal, timeoutMs: number, label: string) {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  const abortFromParent = () => {
    controller.abort(parent.reason ?? new Error('Task aborted'))
  }
  if (parent.aborted) abortFromParent()
  else parent.addEventListener('abort', abortFromParent, { once: true })

  return {
    signal: controller.signal,
    wasTimeout: () => timedOut,
    cleanup() {
      clearTimeout(timeout)
      parent.removeEventListener('abort', abortFromParent)
    },
  }
}

function normalizeToolName(entry: any) {
  return entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.result ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

function normalizeToolCalls(toolCalls: any[] = []) {
  return toolCalls.map((toolCall: any) => ({
    toolName: normalizeToolName(toolCall),
    args: toolCall?.args ?? toolCall?.input ?? null,
  }))
}

function normalizeToolResults(toolResults: any[] = []) {
  return toolResults.map((toolResult: any) => ({
    toolName: normalizeToolName(toolResult),
    result: normalizeToolResult(toolResult),
  }))
}

async function runAgent(
  createAgent: (type: string, episodeId: number, dramaId: number) => CreateAgentLike | null,
  ctx: TaskContext<DramaPreProductionPayload>,
  agentType: string,
  dramaId: number,
  episodeId: number,
  message: string,
  timeoutMs: number,
) {
  if (!validAgentTypes.includes(agentType)) {
    throw new Error(`Invalid agent type: ${agentType}`)
  }

  const agent = createAgent(agentType, episodeId, dramaId)
  if (!agent) throw new Error(`Agent ${agentType} not found`)

  ctx.event('drama_pre_production.agent_started', { agentType, dramaId, episodeId })

  const runSignal = createTimeoutSignal(ctx.signal, timeoutMs, `Agent ${agentType}`)
  let result: any
  try {
    result = await agent.generate(
      [{ role: 'user', content: message }],
      { maxSteps: 20, abortSignal: runSignal.signal },
    )
  } catch (error) {
    if (runSignal.wasTimeout()) {
      throw new Error(`Agent ${agentType} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    runSignal.cleanup()
  }

  const toolCalls = normalizeToolCalls(result.toolCalls || [])
  const toolResults = normalizeToolResults(result.toolResults || [])
  for (const toolCall of toolCalls) ctx.event('drama_pre_production.tool_call', toolCall)
  for (const toolResult of toolResults) ctx.event('drama_pre_production.tool_result', toolResult)

  ctx.event('drama_pre_production.agent_completed', {
    agentType,
    dramaId,
    episodeId,
    toolCallCount: toolCalls.length,
    toolResultCount: toolResults.length,
  })

  return {
    text: result.text || '',
    toolCalls,
    toolResults,
  }
}

function createCharacterImageGenerationRecord(
  createRecord: typeof createImageGenerationRecord,
  characterId: number,
  dramaId: number,
) {
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).all()
  if (!char) throw new Error(`Character ${characterId} not found`)

  const seed = char.seed ?? ensureCharacterSeed(characterId)
  const prompt = `${char.name}, ${char.appearance || char.description || '人物立绘'}, 高质量, 正面, 白色背景`

  return createRecord({
    characterId,
    dramaId,
    prompt,
    size: '1024x1024',
    seed,
  })
}

function createSceneImageGenerationRecord(
  createRecord: typeof createImageGenerationRecord,
  sceneId: number,
  dramaId: number,
  aspectRatio: string,
) {
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId)).all()
  if (!scene) throw new Error(`Scene ${sceneId} not found`)

  const seed = scene.seed ?? ensureSceneSeed(sceneId)
  const prompt = scene.prompt || `${scene.location}, ${scene.time || ''}, 高质量场景, 电影感`

  return createRecord({
    sceneId,
    dramaId,
    prompt,
    size: aspectRatioToSize(aspectRatio),
    seed,
  })
}

export function createDramaPreProductionHandler(deps: DramaPreProductionDeps = {}) {
  const createAgent = deps.createAgent ?? defaultCreateAgent
  const createRecord = deps.createImageGenerationRecord ?? createImageGenerationRecord

  return {
    resumable: false,
    maxAttempts: 1,
    async run(ctx: TaskContext<DramaPreProductionPayload>) {
      const { dramaId } = readPayload(ctx.payload)

      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
      if (!drama) throw new Error(`Drama ${dramaId} not found`)

      const episodes = db.select().from(schema.episodes)
        .where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))
        .orderBy(schema.episodes.episodeNumber)
        .all()
        .filter(ep => String(ep.content || '').trim() || String(ep.scriptContent || '').trim())

      if (episodes.length === 0) {
        throw new Error('没有可用的 episode 内容用于预生产')
      }

      ctx.progress('开始 drama 级预生产', 0, 5)
      logTaskProgress('DramaPreProduction', 'start', { dramaId, episodes: episodes.length })

      // 1. 逐集提取角色/场景
      const extractResults: { episodeId: number; success: boolean; error?: string }[] = []
      for (let i = 0; i < episodes.length; i++) {
        const ep = episodes[i]
        ctx.progress(`提取第 ${ep.episodeNumber} 集角色/场景`, i + 1, episodes.length)
        try {
          await runAgent(
            createAgent,
            ctx,
            'extractor',
            dramaId,
            ep.id,
            '请从当前集格式化剧本/原文中提取所有角色和场景，与 drama 中已有数据去重合并后保存。',
            DEFAULT_EXTRACTOR_TIMEOUT_MS,
          )
          extractResults.push({ episodeId: ep.id, success: true })
        } catch (err: any) {
          const error = err instanceof Error ? err.message : String(err)
          logTaskWarn('DramaPreProduction', 'extract-failed', { dramaId, episodeId: ep.id, error })
          extractResults.push({ episodeId: ep.id, success: false, error })
          // 单集失败不阻断后续集数，但会记录失败
        }
      }

      const failedExtracts = extractResults.filter(r => !r.success)
      if (failedExtracts.length > 0) {
        ctx.event('drama_pre_production.extract_warnings', { failed: failedExtracts })
      }

      // 2. 音色分配（voice_assigner 工具返回 drama 下所有角色，不限于单集）
      ctx.progress('分配角色音色', 1, 5)
      const firstEpisode = episodes[0]
      await runAgent(
        createAgent,
        ctx,
        'voice_assigner',
        dramaId,
        firstEpisode.id,
        '请为当前 drama 中所有尚未分配音色的角色分配合适的音色。',
        DEFAULT_VOICE_ASSIGNER_TIMEOUT_MS,
      )

      // 3. 为没有形象的角色生成图片
      ctx.progress('生成角色形象', 2, 5)
      const charactersWithoutImage = db.select().from(schema.characters)
        .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
        .all()
        .filter(c => !c.imageUrl && !c.localPath)

      const imageTaskIds: number[] = []
      for (const char of charactersWithoutImage) {
        try {
          const generationId = createCharacterImageGenerationRecord(createRecord, char.id, dramaId)
          const task = createTask({
            type: 'image.generate',
            dramaId,
            scopeType: 'character',
            scopeId: char.id,
            priority: 10,
            idempotencyKey: `image.generate:character:drama_pre_production:${char.id}`,
            payload: { image_generation_id: generationId },
          })
          imageTaskIds.push(task.id)
        } catch (err: any) {
          const error = err instanceof Error ? err.message : String(err)
          logTaskWarn('DramaPreProduction', 'character-image-failed', { dramaId, characterId: char.id, error })
        }
      }

      // 4. 为没有形象的场景生成图片
      ctx.progress('生成场景形象', 3, 5)
      const scenesWithoutImage = db.select().from(schema.scenes)
        .where(and(eq(schema.scenes.dramaId, dramaId), isNull(schema.scenes.deletedAt)))
        .all()
        .filter(s => !s.imageUrl && !s.localPath)

      const sceneImageTaskIds: number[] = []
      const sceneAspectRatio = firstEpisode.aspectRatio || '16:9'
      for (const scene of scenesWithoutImage) {
        try {
          const generationId = createSceneImageGenerationRecord(createRecord, scene.id, dramaId, sceneAspectRatio)
          const task = createTask({
            type: 'image.generate',
            dramaId,
            scopeType: 'scene',
            scopeId: scene.id,
            priority: 8,
            idempotencyKey: `image.generate:scene:drama_pre_production:${scene.id}`,
            payload: { image_generation_id: generationId },
          })
          sceneImageTaskIds.push(task.id)
        } catch (err: any) {
          const error = err instanceof Error ? err.message : String(err)
          logTaskWarn('DramaPreProduction', 'scene-image-failed', { dramaId, sceneId: scene.id, error })
        }
      }

      // 5. 为没有样本的角色生成音色样本（仅当 drama 下存在需要角色对白的剧集时才需要）
      ctx.progress('生成音色样本', 4, 5)
      const hasNonNarrationOnlyEpisode = episodes.some(ep => ep.dialogueMode !== 'narration_only')
      const sampleTaskIds: number[] = []

      let charactersNeedingSample: typeof schema.characters.$inferSelect[] = []
      if (hasNonNarrationOnlyEpisode) {
        charactersNeedingSample = db.select().from(schema.characters)
          .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
          .all()
          .filter(c => c.voiceStyle && !c.voiceSampleUrl)

        for (const char of charactersNeedingSample) {
          // 任选一个该角色已关联的 episode 作为 audio config 来源；
          // 如果没有关联，则使用 drama 下第一个有 audioConfigId 的 episode
          const links = db.select().from(schema.episodeCharacters)
            .where(eq(schema.episodeCharacters.characterId, char.id))
            .all()
          let sampleEpisodeId = links[0]?.episodeId ?? firstEpisode.id

          // 确保选中的 episode 有音频配置
          const sampleEp = db.select().from(schema.episodes).where(eq(schema.episodes.id, sampleEpisodeId)).all()[0]
          if (!sampleEp?.audioConfigId) {
            const fallbackEp = episodes.find(e => e.audioConfigId)
            if (fallbackEp) sampleEpisodeId = fallbackEp.id
          }

          try {
            const task = createTask({
              type: 'tts.character_sample',
              dramaId,
              scopeType: 'character',
              scopeId: char.id,
              idempotencyKey: `tts.character_sample:drama_pre_production:${char.id}`,
              payload: { character_id: char.id, episode_id: sampleEpisodeId },
            })
            sampleTaskIds.push(task.id)
          } catch (err: any) {
            const error = err instanceof Error ? err.message : String(err)
            logTaskWarn('DramaPreProduction', 'voice-sample-task-failed', { dramaId, characterId: char.id, error })
          }
        }
      } else {
        logTaskSuccess('DramaPreProduction', 'skip-voice-samples', { dramaId, reason: 'all_episodes_are_narration_only' })
      }

      ctx.progress('drama 级预生产调度完成', 5, 5)

      const summary = {
        drama_id: dramaId,
        episodes_processed: episodes.length,
        episodes_failed: failedExtracts.length,
        characters_without_image: charactersWithoutImage.length,
        image_task_ids: imageTaskIds,
        scenes_without_image: scenesWithoutImage.length,
        scene_image_task_ids: sceneImageTaskIds,
        characters_need_sample: charactersNeedingSample.length,
        sample_task_ids: sampleTaskIds,
      }

      logTaskSuccess('DramaPreProduction', 'complete', summary)
      ctx.event('drama_pre_production.completed', summary)

      return summary
    },
  }
}

export function registerDramaPreProductionHandler() {
  registerTaskHandler('drama.pre_production', createDramaPreProductionHandler())
}
