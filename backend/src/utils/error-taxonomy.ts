export type ImageErrorCode =
  | 'provider_timeout'
  | 'provider_overloaded'
  | 'rate_limited'
  | 'circuit_open'
  | 'content_policy_violation'
  | 'bad_request'
  | 'auth_failed'
  | 'payment_required'
  | 'not_found'
  | 'stale_worker'
  | 'unknown_error'

export interface ErrorClassification {
  code: ImageErrorCode
  retryable: boolean
  userMessageZh: string
  isProviderError: boolean
  retryAfterSeconds?: number
}

export class AiProviderError extends Error {
  status: number
  retryAfterSeconds?: number
  provider?: string

  constructor(message: string, status: number, options?: { retryAfterSeconds?: number; provider?: string }) {
    super(message)
    this.name = 'AiProviderError'
    this.status = status
    this.retryAfterSeconds = options?.retryAfterSeconds
    this.provider = options?.provider
  }
}

const CIRCUIT_BREAKER_COOLDOWN_MS = Math.max(
  30_000,
  Number(process.env.IMAGE_CIRCUIT_BREAKER_TIMEOUT_MS || 30_000),
)

const ERROR_MESSAGES_ZH: Record<ImageErrorCode, string> = {
  provider_timeout: '生成服务响应超时，正在重试',
  provider_overloaded: '生成服务负载过高，稍后重试',
  rate_limited: '请求过于频繁，已放缓重试',
  circuit_open: '生成服务暂时不可用，请稍后重试',
  content_policy_violation: '图片内容触发平台安全策略，请修改提示词后重试',
  bad_request: '生成参数有误，请检查提示词或配置',
  auth_failed: 'AI 服务认证失败，请检查 API Key',
  payment_required: 'AI 服务账户余额不足，请充值后继续',
  not_found: '生成任务未找到或服务不可用',
  stale_worker: '任务执行中断，已重新排队',
  unknown_error: '生成出错，正在尝试恢复',
}

function isContentPolicyViolation(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('violated our relevant policies')
    || lower.includes('content policy')
    || lower.includes('safety system')
    || lower.includes('content moderation')
    || lower.includes('policy violation')
    || lower.includes('内容政策')
    || lower.includes('内容审核')
    || lower.includes('安全策略')
    || lower.includes('违反了我们的内容政策')
    || lower.includes('防护限制')
    || lower.includes('暴力内容')
    || lower.includes('血腥内容')
    || lower.includes('敏感内容')
    || lower.includes('该提示可能违反')
}

export function classifyImageError(error: unknown): ErrorClassification {
  if (error === null || error === undefined) {
    return { code: 'unknown_error', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.unknown_error, isProviderError: false }
  }

  if (error instanceof AiProviderError) {
    if (error.status === 0 && error.message.toLowerCase().includes('circuit breaker')) {
      return { code: 'circuit_open', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.circuit_open, isProviderError: false }
    }
    if (error.status === 400 && isContentPolicyViolation(error.message)) {
      return {
        code: 'content_policy_violation',
        retryable: false,
        userMessageZh: ERROR_MESSAGES_ZH.content_policy_violation,
        isProviderError: true,
      }
    }
    return classifyByStatus(error.status, error.message, error.retryAfterSeconds)
  }

  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  if (lower.includes('circuit_open') || lower.includes('circuit open')) {
    return { code: 'circuit_open', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.circuit_open, isProviderError: false }
  }

  if (lower.includes('stale_worker') || lower.includes('stale worker')) {
    return { code: 'stale_worker', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.stale_worker, isProviderError: false }
  }

  const statusMatch = message.match(/\b(\d{3})\b/)
  if (statusMatch) {
    const status = Number(statusMatch[1])
    const retryAfter = extractRetryAfter(message)
    return classifyByStatus(status, message, retryAfter)
  }

  if (
    lower.includes('timeout') ||
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('aborted') ||
    lower.includes('network')
  ) {
    return { code: 'provider_timeout', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.provider_timeout, isProviderError: true }
  }

  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return { code: 'rate_limited', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.rate_limited, isProviderError: true }
  }

  if (lower.includes('excessive system load') || lower.includes('server overloaded') || lower.includes('service unavailable')) {
    return { code: 'provider_overloaded', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.provider_overloaded, isProviderError: true }
  }

  if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('invalid api key')) {
    return { code: 'auth_failed', retryable: false, userMessageZh: ERROR_MESSAGES_ZH.auth_failed, isProviderError: true }
  }

  if (isContentPolicyViolation(message)) {
    return {
      code: 'content_policy_violation',
      retryable: false,
      userMessageZh: ERROR_MESSAGES_ZH.content_policy_violation,
      isProviderError: true,
    }
  }

  if (lower.includes('invalid') || lower.includes('bad request')) {
    return { code: 'bad_request', retryable: false, userMessageZh: ERROR_MESSAGES_ZH.bad_request, isProviderError: true }
  }

  return { code: 'unknown_error', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.unknown_error, isProviderError: false }
}

function extractRetryAfter(message: string): number | undefined {
  const match = message.match(/retry-after[:\s]+(\d+)/i)
  if (match) {
    const value = Number(match[1])
    if (value > 0 && value <= 3600) return value
  }
  return undefined
}

function classifyByStatus(status: number, message: string, retryAfterSeconds?: number): ErrorClassification {
  if (status === 500 && isContentPolicyViolation(message)) {
    return {
      code: 'content_policy_violation',
      retryable: false,
      userMessageZh: ERROR_MESSAGES_ZH.content_policy_violation,
      isProviderError: true,
    }
  }

  if (status === 524 || status === 408 || status === 502 || status === 503 || status === 504) {
    return { code: 'provider_timeout', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.provider_timeout, isProviderError: true }
  }

  if (status === 429) {
    return { code: 'rate_limited', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.rate_limited, isProviderError: true, retryAfterSeconds }
  }

  if (status === 401 || status === 403) {
    return { code: 'auth_failed', retryable: false, userMessageZh: ERROR_MESSAGES_ZH.auth_failed, isProviderError: true }
  }

  if (status === 402) {
    return { code: 'payment_required', retryable: false, userMessageZh: ERROR_MESSAGES_ZH.payment_required, isProviderError: true }
  }

  if (status === 404) {
    return { code: 'not_found', retryable: false, userMessageZh: ERROR_MESSAGES_ZH.not_found, isProviderError: true }
  }

  if (status === 400) {
    const lower = message.toLowerCase()
    if (isContentPolicyViolation(message)) {
      return {
        code: 'content_policy_violation',
        retryable: false,
        userMessageZh: ERROR_MESSAGES_ZH.content_policy_violation,
        isProviderError: true,
      }
    }
    if (lower.includes('excessive system load') || lower.includes('server overloaded') || lower.includes('service unavailable')) {
      return { code: 'provider_overloaded', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.provider_overloaded, isProviderError: true }
    }
    return { code: 'bad_request', retryable: false, userMessageZh: ERROR_MESSAGES_ZH.bad_request, isProviderError: true }
  }

  return { code: 'unknown_error', retryable: true, userMessageZh: ERROR_MESSAGES_ZH.unknown_error, isProviderError: true }
}

export function getUserMessageZh(code: ImageErrorCode | string): string {
  return ERROR_MESSAGES_ZH[code as ImageErrorCode] || ERROR_MESSAGES_ZH.unknown_error
}

export function computeRetryDelay(code: ImageErrorCode, attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 300_000)
  }
  if (code === 'circuit_open') {
    const jitter = Math.floor(Math.random() * 5_000)
    return Math.min(CIRCUIT_BREAKER_COOLDOWN_MS + jitter, 300_000)
  }
  const base = 2_000
  const max = 60_000
  const exponential = base * Math.pow(2, attempt)
  const jitter = Math.floor(Math.random() * 0.3 * exponential)
  const delay = Math.min(exponential + jitter, max)
  if (code === 'provider_timeout' || code === 'provider_overloaded') {
    return Math.max(delay, CIRCUIT_BREAKER_COOLDOWN_MS)
  }
  return delay
}
