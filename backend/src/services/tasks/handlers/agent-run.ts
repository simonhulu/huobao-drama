import { createAgent as defaultCreateAgent, validAgentTypes } from '../../../agents/index.js'
import { registerTaskHandler } from '../registry.js'
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

export function createAgentRunHandler(deps: CreateAgentRunHandlerDeps = {}): TaskHandler<AgentRunPayload> {
  const createAgent = deps.createAgent ?? defaultCreateAgent

  return {
    resumable: false,
    maxAttempts: 1,
    async run(ctx: TaskContext<AgentRunPayload>) {
      const { agentType, message, dramaId, episodeId } = readPayload(ctx.payload)
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
