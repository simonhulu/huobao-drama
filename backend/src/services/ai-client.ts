import { AiProviderError, classifyImageError } from '../utils/error-taxonomy.js'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type Dispatcher from 'undici/types/dispatcher'

export interface AiClientOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  circuitBreakerThreshold?: number
  circuitBreakerTimeoutMs?: number
  circuitBreakerHalfOpenMaxAttempts?: number
}

export interface FetchInit extends RequestInit {
  // Allow callers to pass an explicit per-request timeout signal in addition to init.signal
  dispatcher?: Dispatcher
}

interface CircuitState {
  status: 'closed' | 'open' | 'half-open'
  failures: number
  lastFailureAt: number
  halfOpenAttempts: number
  successesInHalfOpen: number
}

const DEFAULT_OPTIONS: Required<AiClientOptions> = {
  maxAttempts: Number(process.env.IMAGE_RETRY_MAX_ATTEMPTS || 3),
  baseDelayMs: Number(process.env.IMAGE_RETRY_BASE_DELAY_MS || 2_000),
  maxDelayMs: 60_000,
  circuitBreakerThreshold: Number(process.env.IMAGE_CIRCUIT_BREAKER_THRESHOLD || 5),
  circuitBreakerTimeoutMs: 30_000,
  circuitBreakerHalfOpenMaxAttempts: 2,
}

function getImageHttpProxy(): string | undefined {
  return process.env.IMAGE_HTTP_PROXY || process.env.HTTP_PROXY || undefined
}

function getImageHttpsProxy(): string | undefined {
  return process.env.IMAGE_HTTPS_PROXY || process.env.HTTPS_PROXY || getImageHttpProxy()
}

function getProxyEnabledProviders(): Set<string> {
  return new Set((process.env.IMAGE_PROXY_ENABLED_PROVIDERS || 'apimart,chatfire,right,rightcodes')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean))
}

function getProxyAgent(provider: string, url: string): ProxyAgent | undefined {
  const providerLower = provider.toLowerCase()
  const proxyEnabledProviders = getProxyEnabledProviders()
  const enabled =
    proxyEnabledProviders.has(providerLower) ||
    proxyEnabledProviders.has('all') ||
    url.toLowerCase().includes('right.codes')
  if (!enabled) return undefined

  const proxy = url.startsWith('https:') ? getImageHttpsProxy() : getImageHttpProxy()
  if (!proxy) return undefined

  return new ProxyAgent(proxy)
}

function mergeOptions(options?: AiClientOptions): Required<AiClientOptions> {
  return {
    maxAttempts: options?.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts,
    baseDelayMs: options?.baseDelayMs ?? DEFAULT_OPTIONS.baseDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_OPTIONS.maxDelayMs,
    circuitBreakerThreshold: options?.circuitBreakerThreshold ?? DEFAULT_OPTIONS.circuitBreakerThreshold,
    circuitBreakerTimeoutMs: options?.circuitBreakerTimeoutMs ?? DEFAULT_OPTIONS.circuitBreakerTimeoutMs,
    circuitBreakerHalfOpenMaxAttempts: options?.circuitBreakerHalfOpenMaxAttempts ?? DEFAULT_OPTIONS.circuitBreakerHalfOpenMaxAttempts,
  }
}

class CircuitBreaker {
  private state: CircuitState
  private options: Required<AiClientOptions>

  constructor(options: Required<AiClientOptions>) {
    this.options = options
    this.state = {
      status: 'closed',
      failures: 0,
      lastFailureAt: 0,
      halfOpenAttempts: 0,
      successesInHalfOpen: 0,
    }
  }

  private shouldOpen(): boolean {
    return this.state.failures >= this.options.circuitBreakerThreshold
  }

  check(): void {
    if (this.state.status === 'open') {
      const elapsed = Date.now() - this.state.lastFailureAt
      if (elapsed >= this.options.circuitBreakerTimeoutMs) {
        this.state.status = 'half-open'
        this.state.halfOpenAttempts = 0
        this.state.successesInHalfOpen = 0
      } else {
        throw new AiProviderError('Circuit breaker is open', 0, { provider: 'circuit' })
      }
    }
  }

  recordSuccess(): void {
    if (this.state.status === 'half-open') {
      this.state.successesInHalfOpen++
      if (this.state.successesInHalfOpen >= this.options.circuitBreakerHalfOpenMaxAttempts) {
        this.state.status = 'closed'
        this.state.failures = 0
        this.state.halfOpenAttempts = 0
        this.state.successesInHalfOpen = 0
      }
    } else {
      this.state.failures = Math.max(0, this.state.failures - 1)
    }
  }

  recordFailure(): void {
    if (this.state.status === 'half-open') {
      this.state.status = 'open'
      this.state.lastFailureAt = Date.now()
      return
    }

    this.state.failures++
    this.state.lastFailureAt = Date.now()
    if (this.shouldOpen()) {
      this.state.status = 'open'
    }
  }

  getState(): CircuitState {
    return { ...this.state }
  }

  resetForTests(): void {
    this.state = {
      status: 'closed',
      failures: 0,
      lastFailureAt: 0,
      halfOpenAttempts: 0,
      successesInHalfOpen: 0,
    }
  }
}

const circuitBreakers = new Map<string, CircuitBreaker>()

export function getCircuitBreaker(provider: string, options?: AiClientOptions): CircuitBreaker {
  const existing = circuitBreakers.get(provider)
  if (existing) return existing
  const merged = mergeOptions(options)
  const cb = new CircuitBreaker(merged)
  circuitBreakers.set(provider, cb)
  return cb
}

export function resetCircuitBreaker(provider: string): void {
  circuitBreakers.get(provider)?.resetForTests()
}

export function resetAllCircuitBreakers(): void {
  for (const cb of circuitBreakers.values()) {
    cb.resetForTests()
  }
}

export function listCircuitBreakerProviders(): string[] {
  return Array.from(circuitBreakers.keys())
}

function computeDelay(attempt: number, retryAfterSeconds: number | undefined, options: Required<AiClientOptions>): number {
  if (retryAfterSeconds != null && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, options.maxDelayMs)
  }
  const exponential = options.baseDelayMs * Math.pow(2, attempt - 1)
  const jitter = Math.floor(Math.random() * 0.3 * exponential)
  return Math.min(exponential + jitter, options.maxDelayMs)
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

function combineSignals(signals: (AbortSignal | null | undefined)[]): AbortSignal {
  const controller = new AbortController()
  const cleanup: Array<() => void> = []

  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const handler = () => controller.abort(signal.reason)
    signal.addEventListener('abort', handler, { once: true })
    cleanup.push(() => signal.removeEventListener('abort', handler))
  }

  const abortHandler = () => {
    for (const fn of cleanup) fn()
  }
  controller.signal.addEventListener('abort', abortHandler, { once: true })

  return controller.signal
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function attemptFetch(provider: string, url: string, init: FetchInit, timeoutMs?: number): Promise<Response> {
  const signals: AbortSignal[] = []
  if (init.signal) signals.push(init.signal as AbortSignal)
  if (timeoutMs !== undefined) signals.push(createTimeoutSignal(timeoutMs))

  const finalInit: FetchInit = signals.length > 0
    ? { ...init, signal: combineSignals(signals) }
    : { ...init }

  const dispatcher = getProxyAgent(provider, url)
  if (dispatcher) {
    const undiciResp = await undiciFetch(url, {
      ...finalInit,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1])
    return undiciResp as unknown as Response
  }
  return fetch(url, finalInit)
}

export interface AiFetchOptions extends AiClientOptions {
  timeoutMs?: number
  skipCircuitBreaker?: boolean
}

export async function aiFetch(
  provider: string,
  url: string,
  init: FetchInit = {},
  options: AiFetchOptions = {},
): Promise<Response> {
  const merged = mergeOptions(options)
  const breaker = getCircuitBreaker(provider, merged)

  if (!options.skipCircuitBreaker) {
    breaker.check()
  }

  let lastError: Error | undefined
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt++) {
    try {
      const resp = await attemptFetch(provider, url, init, options.timeoutMs)
      if (!resp.ok) {
        const retryAfter = resp.headers.get('retry-after')
        const text = await resp.text()
        throw new AiProviderError(`API error ${resp.status}: ${text}`, resp.status, {
          retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined,
          provider,
        })
      }
      breaker.recordSuccess()
      return resp
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err))

      if (lastError instanceof AiProviderError && lastError.status === 0 && lastError.message.includes('Circuit breaker')) {
        throw lastError
      }

      const classification = classifyImageError(lastError)
      const isPolicyViolation = classification.code === 'content_policy_violation'
      const isRetryable = classification.retryable
      const retryAfter = lastError instanceof AiProviderError ? lastError.retryAfterSeconds : undefined

      if (attempt >= merged.maxAttempts || !isRetryable) {
        if (!isPolicyViolation) {
          breaker.recordFailure()
        }
        throw lastError
      }

      if (!isPolicyViolation) {
        breaker.recordFailure()
      }
      const delay = computeDelay(attempt, retryAfter, merged)
      await sleep(delay)
    }
  }

  throw lastError ?? new Error('aiFetch failed')
}

function isRetryableError(error: Error): boolean {
  if (error instanceof AiProviderError) {
    if (error.status === 0 && error.message.includes('Circuit breaker')) return false
    if (error.status === 400) {
      const classification = classifyImageError(error)
      if (classification.code === 'content_policy_violation') return false
      const lower = error.message.toLowerCase()
      return lower.includes('excessive system load') || lower.includes('server overloaded') || lower.includes('service unavailable')
    }
    if (error.status === 401 || error.status === 403 || error.status === 404) return false
    return true
  }

  const message = error.message.toLowerCase()
  if (message.includes('aborted')) return false
  return true
}

export function createAiClient(provider: string, options?: AiClientOptions) {
  return {
    fetch(url: string, init?: FetchInit, fetchOptions?: Omit<AiFetchOptions, keyof AiClientOptions>) {
      return aiFetch(provider, url, init, { ...options, ...fetchOptions })
    },
  }
}
