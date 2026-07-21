import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyImageError, AiProviderError } from './error-taxonomy.js'

test('classifies "filtered by the safety policy" as content_policy_violation', () => {
  const error = new AiProviderError(
    'The generated image was filtered by the safety policy. Please adjust your prompt and try again.',
    500,
  )
  const result = classifyImageError(error)
  assert.equal(result.code, 'content_policy_violation')
  assert.equal(result.retryable, false)
})

test('classifies Chinese violence content guardrail as content_policy_violation', () => {
  const error = new AiProviderError(
    'HTTP 500: {"error":{"message":"非常抱歉，生成的图片可能违反了关于暴力内容的防护限制"}}',
    500,
  )
  const result = classifyImageError(error)
  assert.equal(result.code, 'content_policy_violation')
})

test('classifies generic 500 as unknown_error when no policy keywords present', () => {
  const error = new AiProviderError('Internal server error', 500)
  const result = classifyImageError(error)
  assert.equal(result.code, 'unknown_error')
})

test('classifies egaki ChatGPT login failures as non-retryable login_required', () => {
  const result = classifyImageError(new Error('egaki-chatgpt exit 1: Missing ChatGPT account metadata. Run `egaki login --provider chatgpt`.'))
  assert.equal(result.code, 'egaki_login_required')
  assert.equal(result.retryable, false)
  assert.equal(result.userMessageZh, 'ChatGPT 登录已失效，请运行 egaki login --provider chatgpt')
})

test('classifies egaki ChatGPT proxy/network failures separately from generic timeout', () => {
  const result = classifyImageError(new Error('egaki-chatgpt exit 1: TypeError: fetch failed while connecting to chatgpt.com through proxy'))
  assert.equal(result.code, 'egaki_proxy_failed')
  assert.equal(result.retryable, true)
  assert.equal(result.userMessageZh, 'ChatGPT 连接失败，请检查代理配置')
})

test('classifies egaki ChatGPT rate limits as retryable rate_limited', () => {
  const result = classifyImageError(new Error('egaki-chatgpt exit 1: ChatGPT returned 429 too many requests'))
  assert.equal(result.code, 'rate_limited')
  assert.equal(result.retryable, true)
})
