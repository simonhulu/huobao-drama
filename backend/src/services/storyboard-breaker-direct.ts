/**
 * DeepSeek 分镜拆解直连 fallback
 *
 * Mastra + @ai-sdk/openai 在 deepseek-v4-pro 的 thinking 模式下多轮 tool calling
 * 会丢失 reasoning_content，导致 400 错误。本模块绕过 Mastra，直接调用
 * DeepSeek /chat/completions，手动解析 tool_calls 并执行 save_storyboards。
 */
import { createStoryboardTools } from '../agents/tools/storyboard-tools.js'
import { buildAgentInstructions } from '../agents/index.js'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { logTaskProgress, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

const SAVE_STORYBOARDS_SCHEMA = {
  type: 'function',
  function: {
    name: 'save_storyboards',
    description: 'Save generated storyboards. Replaces all existing storyboards for this episode. Every shot must represent one complete narrative event with a concrete action and result, not a generic scene plate. When calling this tool, output the arguments as a plain JSON object. Do not wrap them in markdown code fences.',
    parameters: {
      type: 'object',
      properties: {
        storyboards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              shot_number: { type: 'number' },
              title: { type: 'string' },
              shot_type: { type: 'string' },
              angle: { type: 'string' },
              movement: { type: 'string' },
              location: { type: 'string' },
              time: { type: 'string' },
              action: { type: 'string' },
              dialogue: { type: 'string' },
              description: { type: 'string' },
              result: { type: 'string' },
              atmosphere: { type: 'string' },
              image_prompt: { type: 'string' },
              video_prompt: { type: 'string' },
              bgm_prompt: { type: 'string' },
              sound_effect: { type: 'string' },
              duration: { type: 'number' },
              energy_level: { type: 'string', enum: ['high', 'medium', 'low'] },
              scene_id: { type: ['number', 'null'] },
              character_ids: { type: 'array', items: { type: 'number' } },
            },
            // Keep the tool contract as strict as the storyboard prompt. If
            // these fields are optional, a model can legally save a title and
            // an image prompt with no event, actor, scene, action, or result.
            // That is how generic scene plates enter the production graph.
            required: [
              'shot_number', 'title', 'shot_type', 'angle', 'movement',
              'location', 'time', 'action', 'dialogue', 'description', 'result',
              'atmosphere', 'image_prompt', 'video_prompt', 'bgm_prompt',
              'sound_effect', 'duration', 'scene_id', 'character_ids',
            ],
          },
        },
      },
      required: ['storyboards'],
    },
  },
} as const

const SAVE_DIRECTOR_PLAN_SCHEMA = {
  type: 'function',
  function: {
    name: 'save_director_plan',
    description: 'Save the director treatment before shot breakdown. It must classify the genre, protagonist arc, scenes, causal beats, concrete actions, and manual Shot.Cafe/Flim.ai composition references.',
    parameters: {
      type: 'object',
      properties: {
        director_plan: { type: 'object' },
      },
      required: ['director_plan'],
    },
  },
} as const

interface DirectStoryboardResult {
  text: string
  toolCalls: Array<{ toolName: string; args: any }>
  toolResults: Array<{ toolName: string; result: string }>
}

export function isDeepSeekProvider(): boolean {
  try {
    const config = getTextConfig()
    return config.provider.toLowerCase() === 'openai' && config.baseUrl.includes('deepseek.com')
  } catch {
    return false
  }
}

export async function runStoryboardBreakerDirect(
  episodeId: number,
  dramaId: number,
  message: string,
): Promise<DirectStoryboardResult> {
  const tools = createStoryboardTools(episodeId, dramaId)
  const instructions = buildAgentInstructions('storyboard_breaker', episodeId)
  if (!instructions) {
    throw new Error('Failed to build storyboard_breaker instructions')
  }

  logTaskProgress('StoryboardBreakerDirect', 'read-context', { episodeId, dramaId })
  const context = await (tools.readStoryboardContext as any).execute({})
  logTaskSuccess('StoryboardBreakerDirect', 'read-context', {
    episodeId,
    dramaId,
    characters: (context as any).characters?.length,
    scenes: (context as any).scenes?.length,
    scriptLength: (context as any).script?.length,
  })

  const config = getTextConfig()
  const baseUrl = getTextProviderBaseUrl(config)
  const model = config.model

  const messages: any[] = [
    { role: 'system', content: instructions },
    { role: 'user', content: message },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_ctx', type: 'function', function: { name: 'read_storyboard_context', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_ctx', content: JSON.stringify(context) },
  ]

  logTaskProgress('StoryboardBreakerDirect', 'llm-request', { episodeId, dramaId, model, baseUrl })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 900_000)

  // instructions 要求先 save_director_plan 再 save_storyboards——两个工具都必须提供，
  // 否则模型会幻觉调用不存在的工具。用小循环消化"先存规划、再存分镜"的两轮调用。
  const callLlm = async (msgs: any[]) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: msgs,
        tools: [SAVE_DIRECTOR_PLAN_SCHEMA, SAVE_STORYBOARDS_SCHEMA],
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 32768,
        thinking: { type: 'disabled' },
      }),
    })

    const raw = await res.text()
    if (!res.ok) {
      throw new Error(`DeepSeek request failed: ${res.status} ${raw}`)
    }
    const data = JSON.parse(raw)
    const responseMessage = data.choices?.[0]?.message
    if (!responseMessage) {
      throw new Error('DeepSeek returned no message')
    }
    return responseMessage
  }

  try {
    let lastText = ''
    for (let round = 0; round < 4; round++) {
      const responseMessage = await callLlm(messages)
      lastText = responseMessage.content || lastText
      const toolCalls = responseMessage.tool_calls || []
      const planCall = toolCalls.find((tc: any) => tc.function?.name === 'save_director_plan')
      const saveCall = toolCalls.find((tc: any) => tc.function?.name === 'save_storyboards')

      if (planCall) {
        let planArgs: any
        try {
          planArgs = JSON.parse(planCall.function.arguments)
        } catch (err: any) {
          throw new Error(`Failed to parse save_director_plan arguments: ${err.message}`)
        }
        // 模型常给出 {plan:{...}} 或缺 schemaVersion 的规划——归一化后再校验。
        const rawPlan = planArgs?.director_plan ?? planArgs?.plan ?? planArgs
        if (rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan) && rawPlan.schemaVersion == null) {
          rawPlan.schemaVersion = 1
        }
        let planToolContent: string
        try {
          const planResult = await (tools.saveDirectorPlan as any).execute({ director_plan: rawPlan })
          logTaskSuccess('StoryboardBreakerDirect', 'director-plan-saved', { episodeId, dramaId })
          planToolContent = JSON.stringify(planResult)
        } catch (err: any) {
          // 导演规划是编排层产物，v7 流水线不消费；校验不过不阻断分镜落库。
          logTaskWarn('StoryboardBreakerDirect', 'director-plan-rejected', { episodeId, dramaId, error: err?.message })
          planToolContent = JSON.stringify({ saved: false, error: err?.message, message: '导演规划校验未过，已跳过；请直接调用 save_storyboards 保存分镜。' })
        }
        messages.push(
          { role: 'assistant', content: responseMessage.content || '', tool_calls: toolCalls },
          { role: 'tool', tool_call_id: planCall.id, content: planToolContent },
        )
      }

      if (saveCall) {
        let args: any
        try {
          args = JSON.parse(saveCall.function.arguments)
        } catch (err: any) {
          throw new Error(`Failed to parse save_storyboards arguments: ${err.message}`)
        }
        logTaskProgress('StoryboardBreakerDirect', 'save-begin', {
          episodeId,
          dramaId,
          count: args.storyboards?.length || 0,
        })
        const saveResult = await (tools.saveStoryboards as any).execute(args)
        logTaskSuccess('StoryboardBreakerDirect', 'save-complete', {
          episodeId,
          dramaId,
          count: (saveResult as any).count,
          totalDuration: (saveResult as any).total_duration,
        })
        return {
          text: responseMessage.content || lastText || '',
          toolCalls: [{ toolName: 'save_storyboards', args }],
          toolResults: [{ toolName: 'save_storyboards', result: JSON.stringify(saveResult) }],
        }
      }

      if (planCall) continue

      // 模型既没存规划也没存分镜：追加明确指令再试一轮
      messages.push(
        { role: 'assistant', content: responseMessage.content || '' },
        { role: 'user', content: '请停止输出分析文字，立即调用 save_director_plan，然后调用 save_storyboards 保存全部分镜。' },
      )
    }

    logTaskWarn('StoryboardBreakerDirect', 'no-save-call', { episodeId, dramaId, text: lastText })
    return {
      text: lastText,
      toolCalls: [],
      toolResults: [],
    }
  } finally {
    clearTimeout(timeout)
  }
}
