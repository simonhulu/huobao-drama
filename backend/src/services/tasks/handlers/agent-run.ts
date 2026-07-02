import { createAgent as defaultCreateAgent, validAgentTypes } from '../../../agents/index.js'
import { registerTaskHandler } from '../registry.js'
import {
  scheduleDirectScriptPipeline,
  scheduleExtractAfterRewrite,
  scheduleImageGenerationForEpisode,
  scheduleNarratorAfterSplitter,
  scheduleStoryboardBreakerAfterVoiceAssign,
  scheduleStoryboardSplitterAfterBreakdown,
  scheduleTTSForEpisode,
  scheduleVoiceAssignAfterExtract,
} from '../auto-pipeline.js'
import { restoreOriginalTextNarrations } from '../../narration-generation.js'
import { usesOriginalTextForNarration } from '../../episode-mode.js'
import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import type { TaskContext, TaskHandler } from '../types.js'

interface AgentRunPayload {
  agent_type?: string
  agentType?: string
  message?: string
  drama_id?: number
  dramaId?: number
  episode_id?: number
  episodeId?: number
}

interface AgentLike {
  generate(messages: Array<{ role: string; content: string }>, options: { maxSteps: number }): Promise<any>
}

interface CreateAgentRunHandlerDeps {
  createAgent?: (type: string, episodeId: number, dramaId: number) => AgentLike | null
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

function readPayload(payload: AgentRunPayload) {
  const agentType = payload.agent_type ?? payload.agentType
  const message = payload.message
  const dramaId = Number(payload.drama_id ?? payload.dramaId)
  const episodeId = Number(payload.episode_id ?? payload.episodeId)

  if (!agentType || !validAgentTypes.includes(agentType)) {
    throw new Error(`Invalid agent type: ${agentType || 'missing'}`)
  }
  if (!message) throw new Error('message is required')
  if (!Number.isFinite(dramaId) || !Number.isFinite(episodeId) || !dramaId || !episodeId) {
    throw new Error('drama_id and episode_id are required')
  }

  return { agentType, message, dramaId, episodeId }
}

function advanceAfterStoryboardBreaker(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep || !ep.autoMode) return

  // direct_script/verbatim 下 narration 字段是 TTS 原文切片，不是 AI 旁白文案。
  if (usesOriginalTextForNarration(ep)) {
    try {
      restoreOriginalTextNarrations(episodeId)
    } catch (err) {
      console.error('[advanceAfterStoryboardBreaker] restoreOriginalTextNarrations failed', err)
    }
  }

  // 自动调度图片生成与 TTS；compose/merge 由对应 handler 完成后自动触发
  try {
    scheduleImageGenerationForEpisode(dramaId, episodeId)
  } catch (err) {
    console.error('[advanceAfterStoryboardBreaker] scheduleImageGenerationForEpisode failed', err)
  }
  try {
    scheduleTTSForEpisode(dramaId, episodeId)
  } catch (err) {
    console.error('[advanceAfterStoryboardBreaker] scheduleTTSForEpisode failed', err)
  }
}

function advanceAfterExtractor(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep || !ep.autoMode) return

  const voiceTask = scheduleVoiceAssignAfterExtract(dramaId, episodeId)
  if (voiceTask) return

  if (ep.workflowType === 'direct_script') {
    scheduleDirectScriptPipeline(dramaId, episodeId)
    return
  }

  scheduleStoryboardBreakerAfterVoiceAssign(dramaId, episodeId)
}

function advanceAfterScriptRewrite(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep || !ep.autoMode) return
  scheduleExtractAfterRewrite(dramaId, episodeId)
}

function advanceAfterVoiceAssign(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep || !ep.autoMode) return

  if (ep.workflowType === 'direct_script') {
    scheduleDirectScriptPipeline(dramaId, episodeId)
    return
  }

  scheduleStoryboardBreakerAfterVoiceAssign(dramaId, episodeId)
}

function advanceAfterStoryboardStructure(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep || !ep.autoMode) return

  if (ep.workflowType === 'direct_script') {
    // direct_script 分镜完成后直接回填原文 TTS 并进入后期任务，不存在 narrator 阶段。
    advanceAfterStoryboardBreaker(dramaId, episodeId)
    return
  }

  scheduleStoryboardSplitterAfterBreakdown(dramaId, episodeId)
}

function advanceAfterStoryboardSplitter(dramaId: number, episodeId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep || !ep.autoMode) return
  const narrator = scheduleNarratorAfterSplitter(dramaId, episodeId)
  if (!narrator) advanceAfterStoryboardBreaker(dramaId, episodeId)
}

export function createAgentRunHandler(deps: CreateAgentRunHandlerDeps = {}): TaskHandler<AgentRunPayload> {
  const createAgent = deps.createAgent ?? defaultCreateAgent

  return {
    resumable: false,
    maxAttempts: 1,
    async run(ctx: TaskContext<AgentRunPayload>) {
      const { agentType, message, dramaId, episodeId } = readPayload(ctx.payload)

      const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (agentType === 'narrator' && usesOriginalTextForNarration(ep)) {
        ctx.progress('Restoring original text for TTS', 0, 1)
        ctx.event('agent.skipped', {
          agentType,
          dramaId,
          episodeId,
          reason: 'original-text-narration-contract',
        })
        const restored = restoreOriginalTextNarrations(episodeId)
        advanceAfterStoryboardBreaker(dramaId, episodeId)
        ctx.progress('Original text restored for TTS', 1, 1)
        return {
          type: 'done',
          text: `已按原文回填 ${restored.updated} 个镜头；direct_script/verbatim 不运行 narrator agent。`,
          toolCalls: [],
          toolResults: [],
        }
      }

      ctx.progress(`Starting ${agentType}`, 0, 1)
      ctx.event('agent.started', { agentType, dramaId, episodeId })

      const agent = createAgent(agentType, episodeId, dramaId)
      if (!agent) throw new Error('Agent not found')

      const result = await agent.generate(
        [{ role: 'user', content: message }],
        { maxSteps: 20 },
      )

      const toolCalls = normalizeToolCalls(result.toolCalls || [])
      const toolResults = normalizeToolResults(result.toolResults || [])

      for (const toolCall of toolCalls) ctx.event('agent.tool_call', toolCall)
      for (const toolResult of toolResults) ctx.event('agent.tool_result', toolResult)

      ctx.progress(`Finished ${agentType}`, 1, 1)
      ctx.event('agent.completed', {
        agentType,
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
      })

      // 自动流水线：按结构链推进；TTS 必须等旁白/原文回填后再调度。
      if (agentType === 'script_rewriter') {
        advanceAfterScriptRewrite(dramaId, episodeId)
      } else if (agentType === 'extractor') {
        advanceAfterExtractor(dramaId, episodeId)
      } else if (agentType === 'voice_assigner') {
        advanceAfterVoiceAssign(dramaId, episodeId)
      } else if (agentType === 'storyboard_breaker') {
        advanceAfterStoryboardStructure(dramaId, episodeId)
      } else if (agentType === 'storyboard_splitter') {
        advanceAfterStoryboardSplitter(dramaId, episodeId)
      } else if (agentType === 'narrator') {
        advanceAfterStoryboardBreaker(dramaId, episodeId)
      }

      return {
        type: 'done',
        text: result.text || '',
        toolCalls,
        toolResults,
      }
    },
  }
}

export function registerAgentRunHandler() {
  registerTaskHandler('agent.run', createAgentRunHandler())
}
