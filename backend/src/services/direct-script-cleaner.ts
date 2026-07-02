/**
 * 精稿直出导入前的解说稿清理服务
 * 支持两种模式：
 *   - standard：保留全部情节和情绪，仅去除无关内容与诱导话术
 *   - tight（留存驱动）：压缩铺垫、合并列举、删除重复总结、前置钩子
 */
import { callTextModel } from './ai.js'

export type RetentionMode = 'standard' | 'tight'
export type HookStyle = 'suspense' | 'conflict' | 'data' | 'auto'

export interface CleanDirectScriptOptions {
  temperature?: number
  maxTokens?: number
  retentionMode?: RetentionMode
  hookStyle?: HookStyle
}

function buildSystemPrompt(options: CleanDirectScriptOptions): string {
  if (options.retentionMode === 'tight') {
    return `你是短视频 retention 编辑，专门优化知识类/历史类解说稿的完播率。
优化原则：
1. 开头必须前 10 秒出钩子：用悬念、冲突或数据反差直接点出核心矛盾，禁止先铺陈背景或理由。
2. 压缩铺垫：背景信息只保留理解主线所必需的最小份额；大段背景改为服务于主线的对比（繁荣→衰败、支持→反对）。
3. 合并列举：三条理由、四种手段等并列内容，合并成 1-2 句紧凑表述，不再逐条展开。
4. 删除重复总结：结尾只保留最有力量的收束句，禁止复述前文结论。
5. 保留核心信息、关键数据、直接引语、动作和空间转换；不编造原文没有的内容。
6. 输出只包含改写后的完整文稿，不要添加说明、总结或分段标题。`
  }

  return `你是纪录片/知识类视频编辑，擅长对已有解说稿做清理和精简。
清理原则：
- 保留全部情节和情绪
- 去除和文章主题无关的语句
- 去除吸引关注、制造悬念、诱导点击的话术
- 保留核心信息、事实、对白、动作、空间转换和背景交代
- 不添加原文没有的内容
- 不改变叙事结构，仅做删减和语句通顺处理

请直接输出清理后的完整文稿，不要添加任何说明或总结。`
}

function buildUserPrompt(script: string, options: CleanDirectScriptOptions): string {
  const hookHint = options.hookStyle && options.hookStyle !== 'auto'
    ? `\n优先使用「${options.hookStyle === 'suspense' ? '悬念前置' : options.hookStyle === 'conflict' ? '冲突引爆' : '数据冲击'}」风格开头。`
    : ''
  return `请清理并优化以下解说稿：${hookHint}\n\n${script}`
}

export async function cleanDirectScript(
  script: string,
  options: CleanDirectScriptOptions = {},
): Promise<string> {
  if (!script.trim()) return script

  const systemPrompt = buildSystemPrompt(options)
  const userPrompt = buildUserPrompt(script, options)

  const cleaned = await callTextModel(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens,
    },
  )

  return cleaned || script
}
