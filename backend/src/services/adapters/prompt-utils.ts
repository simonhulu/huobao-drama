/**
 * Prompt 归一化工具
 * - 清理视频专用的 XML 标签（<role>, <location>, <voice>, <n>）
 * - 按 provider 限制截断 prompt
 */

export const PROVIDER_PROMPT_LIMITS: Record<string, number> = {
  minimax: 1500,
  openai: 4000,
  gemini: 8000,
  ali: 4000,
  volcengine: 4000,
  configurable: 4000,
}

export function stripVideoTags(prompt: string): string {
  return prompt
    .replace(/<location>([^<]*)<\/location>/gi, '$1')
    .replace(/<voice>([^<]*)<\/voice>/gi, '$1')
    .replace(/<n\s*\/?>/gi, ' ')
    .replace(/<role>([^<]*)<\/role>/gi, '$1')
    .trim()
}

export function truncatePrompt(prompt: string, maxLength: number): string {
  if (prompt.length <= maxLength) return prompt
  return prompt.slice(0, maxLength)
}

export function normalizePrompt(
  prompt: string | null | undefined,
  provider: string,
): string {
  const cleaned = stripVideoTags(prompt || '')
  const max = PROVIDER_PROMPT_LIMITS[provider] ?? 4000
  return truncatePrompt(cleaned, max)
}
