import test from 'node:test'
import assert from 'node:assert/strict'
import { aiFetch, resetCircuitBreaker, resetAllCircuitBreakers } from './ai-client.js'

let fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = []
let fetchResponses: Response[] = []
let fetchIndex = 0

async function mockFetch(url: string, init?: RequestInit): Promise<Response> {
  fetchCalls.push({ url, init })
  if (fetchIndex >= fetchResponses.length) {
    return new Response('unexpected fetch', { status: 500 })
  }
  return fetchResponses[fetchIndex++]!
}

const originalFetch = global.fetch

test.beforeEach(() => {
  fetchCalls = []
  fetchResponses = []
  fetchIndex = 0
  resetAllCircuitBreakers()
  global.fetch = mockFetch as unknown as typeof fetch
})

test.afterEach(() => {
  global.fetch = originalFetch
})

test('aiFetch retries on 524 and eventually succeeds', async () => {
  fetchResponses = [
    new Response('timeout', { status: 524 }),
    new Response('timeout', { status: 524 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ]

  const resp = await aiFetch('test-provider', 'http://example.com/generate', {}, {
    maxAttempts: 3,
    baseDelayMs: 10,
  })

  assert.equal(resp.status, 200)
  assert.equal(fetchCalls.length, 3)
})

test('aiFetch honors Retry-After on 429', async () => {
  const start = Date.now()
  fetchResponses = [
    new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ]

  await aiFetch('test-provider', 'http://example.com/generate', {}, {
    maxAttempts: 3,
    baseDelayMs: 10_000,
  })

  assert.equal(fetchCalls.length, 2)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 500, `Expected Retry-After to override base delay, but took ${elapsed}ms`)
})

test('aiFetch does not retry 400 bad request', async () => {
  fetchResponses = [
    new Response('invalid prompt', { status: 400 }),
  ]

  await assert.rejects(
    () => aiFetch('test-provider', 'http://example.com/generate', {}, { maxAttempts: 3 }),
    /invalid prompt/,
  )
  assert.equal(fetchCalls.length, 1)
})

test('circuit breaker opens after threshold failures', async () => {
  fetchResponses = [
    new Response('timeout', { status: 524 }),
    new Response('timeout', { status: 524 }),
    new Response('timeout', { status: 524 }),
    new Response('timeout', { status: 524 }),
    new Response('timeout', { status: 524 }),
  ]

  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () => aiFetch('cb-provider', 'http://example.com/generate', {}, {
        maxAttempts: 1,
        circuitBreakerThreshold: 5,
        baseDelayMs: 1,
      }),
      /524/,
    )
  }

  await assert.rejects(
    () => aiFetch('cb-provider', 'http://example.com/generate', {}, { maxAttempts: 1 }),
    /Circuit breaker/,
  )

  assert.equal(fetchCalls.length, 5)
})

test('circuit breaker half-opens after timeout and closes on successes', async () => {
  fetchResponses = [
    new Response('timeout', { status: 524 }),
    new Response('timeout', { status: 524 }),
    new Response('timeout', { status: 524 }),
    new Response('timeout', { status: 524 }),
    new Response('timeout', { status: 524 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ]

  for (let i = 0; i < 5; i++) {
    await assert.rejects(
      () => aiFetch('cb-half-provider', 'http://example.com/generate', {}, {
        maxAttempts: 1,
        circuitBreakerThreshold: 5,
        circuitBreakerTimeoutMs: 50,
        baseDelayMs: 1,
      }),
      /524/,
    )
  }

  await new Promise((r) => setTimeout(r, 60))

  const first = await aiFetch('cb-half-provider', 'http://example.com/generate', {}, { maxAttempts: 1 })
  assert.equal(first.status, 200)

  const second = await aiFetch('cb-half-provider', 'http://example.com/generate', {}, { maxAttempts: 1 })
  assert.equal(second.status, 200)

  const third = await aiFetch('cb-half-provider', 'http://example.com/generate', {}, { maxAttempts: 1 })
  assert.equal(third.status, 200)

  assert.equal(fetchCalls.length, 8)
})

test('aiFetch does not record content policy 400 as circuit breaker failure', async () => {
  const policyMessage = JSON.stringify({
    error: {
      message: 'We are sorry, but the images we created may have violated our relevant policies.',
      type: 'upstream_error',
    },
  })
  fetchResponses = [
    new Response(policyMessage, { status: 400 }),
  ]

  await assert.rejects(
    () => aiFetch('policy-provider', 'http://example.com/generate', {}, {
      maxAttempts: 1,
      circuitBreakerThreshold: 1,
      baseDelayMs: 1,
    }),
    /violated our relevant policies/,
  )

  // A subsequent request should NOT trip the circuit breaker, because the
  // content-policy 400 should not count as a failure.
  fetchIndex = 0
  fetchResponses = [
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ]
  const resp = await aiFetch('policy-provider', 'http://example.com/generate', {}, { maxAttempts: 1 })
  assert.equal(resp.status, 200)
})

test('aiFetch exposes circuit breaker state reset helper', () => {
  resetCircuitBreaker('nonexistent-provider')
  assert.ok(true)
})
