import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { AiProviderError, classifyImageError, computeRetryDelay } from '../utils/error-taxonomy.js'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-image-limiter-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { ImageGenerationLimiter, executeImageGeneration } = await import('./image-generation.js')
const { db, schema } = await import('../db/index.js')

test('ImageGenerationLimiter caps concurrent executions', async () => {
  const limiter = new ImageGenerationLimiter(2, 60_000, 100)
  let running = 0
  let maxRunning = 0

  const jobs = Array.from({ length: 6 }, async (_, i) => {
    await limiter.run(async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return i
    })
  })

  await Promise.all(jobs)
  assert.equal(maxRunning, 2)
  assert.equal(running, 0)
})

test('ImageGenerationLimiter caps executions per interval', async () => {
  const limiter = new ImageGenerationLimiter(10, 100, 2)
  const start = Date.now()
  const starts: number[] = []

  const jobs = Array.from({ length: 4 }, async (_, i) => {
    await limiter.run(async () => {
      starts.push(Date.now() - start)
      return i
    })
  })

  await Promise.all(jobs)
  assert.equal(starts.length, 4)
  assert.ok(starts[1] < 10, `second job started at ${starts[1]}ms`)
  assert.ok(starts[2] >= 90, `third job started at ${starts[2]}ms`)
  assert.ok(starts[3] >= 90, `fourth job started at ${starts[3]}ms`)
})

test('classifyImageError treats 524 as retryable provider timeout', () => {
  const err = new AiProviderError('API error 524: timeout', 524, { provider: 'doubao' })
  const classified = classifyImageError(err)
  assert.equal(classified.code, 'provider_timeout')
  assert.equal(classified.retryable, true)
  assert.equal(classified.isProviderError, true)
})

test('classifyImageError treats fetch failed as retryable provider timeout', () => {
  const err = new TypeError('fetch failed')
  const classified = classifyImageError(err)
  assert.equal(classified.code, 'provider_timeout')
  assert.equal(classified.retryable, true)
  assert.equal(classified.isProviderError, true)
})

test('classifyImageError treats circuit breaker as retryable cooldown state', () => {
  const err = new AiProviderError('Circuit breaker is open', 0)
  const classified = classifyImageError(err)
  assert.equal(classified.code, 'circuit_open')
  assert.equal(classified.retryable, true)
})

test('classifyImageError treats 400 as non-retryable bad request', () => {
  const err = new AiProviderError('API error 400: bad request', 400)
  const classified = classifyImageError(err)
  assert.equal(classified.code, 'bad_request')
  assert.equal(classified.retryable, false)
  assert.equal(classified.isProviderError, true)
})

test('classifyImageError treats OpenAI content policy 400 as content_policy_violation', () => {
  const err = new AiProviderError(
    'API error 400: {"error":{"message":"We are sorry, but the images we created may have violated our relevant policies.","type":"upstream_error"}}',
    400,
  )
  const classified = classifyImageError(err)
  assert.equal(classified.code, 'content_policy_violation')
  assert.equal(classified.retryable, false)
  assert.equal(classified.isProviderError, true)
  assert.equal(classified.userMessageZh, '图片内容触发平台安全策略，请修改提示词后重试')
})

test('classifyImageError treats HTTP 500 content policy violation as content_policy_violation', () => {
  const err = new AiProviderError(
    'API error 500: {"error":{"code":null,"message":"非常抱歉，该提示可能违反了我们的内容政策。如果你认为此判断有误，请重试或修改提示语。","param":null,"type":"invalid_request_error"}}',
    500,
  )
  const classified = classifyImageError(err)
  assert.equal(classified.code, 'content_policy_violation')
  assert.equal(classified.retryable, false)
  assert.equal(classified.isProviderError, true)
  assert.equal(classified.userMessageZh, '图片内容触发平台安全策略，请修改提示词后重试')
})

test('classifyImageError treats APIMart violence guard HTTP 500 as content_policy_violation', () => {
  const err = new AiProviderError(
    'API error 500: {"error":{"code":null,"message":"非常抱歉，该提示可能违反了关于暴力内容的防护限制。如果你认为此判断有误，请重试或修改提示语。（traceid: b5eaa0d81748bd183e197e07423a4f4b）","param":null,"type":"invalid_request_error"}}',
    500,
  )
  const classified = classifyImageError(err)
  assert.equal(classified.code, 'content_policy_violation')
  assert.equal(classified.retryable, false)
  assert.equal(classified.isProviderError, true)
  assert.equal(classified.userMessageZh, '图片内容触发平台安全策略，请修改提示词后重试')
})

test('executeImageGeneration fails immediately when async poll returns terminal safety failure', async () => {
  const ts = new Date().toISOString()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image',
    provider: 'polltest',
    name: 'Poll terminal failure provider',
    baseUrl: 'https://example.com',
    apiKey: 'test-key',
    model: JSON.stringify(['test-model']),
    settings: JSON.stringify({
      adapter: {
        request: {
          url: '/generate',
          method: 'POST',
          body: { prompt: '{{prompt}}', model: '{{model}}', size: '{{size}}' },
        },
        response: {
          async: true,
          taskIdPath: 'task_id',
        },
        poll: {
          request: {
            url: '/tasks/{{taskId}}',
            method: 'GET',
          },
          response: {
            statusPath: 'status',
            completedValues: ['completed'],
            failedValues: ['failed'],
            imageUrlPath: 'result.image_url',
            errorPath: 'error.message',
          },
        },
      },
    }),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const generationId = Number(db.insert(schema.imageGenerations).values({
    provider: 'polltest',
    prompt: 'cinematic frame',
    model: 'test-model',
    size: '1024x1024',
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const originalFetch = global.fetch
  const originalSetTimeout = global.setTimeout
  const fetchCalls: string[] = []

  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    fetchCalls.push(url)
    if (fetchCalls.length === 1) {
      return new Response(JSON.stringify({ task_id: 'task-terminal-safety' }), { status: 200 })
    }
    return new Response(JSON.stringify({
      status: 'failed',
      error: { message: 'Your request was rejected by the safety system.' },
    }), { status: 200 })
  }) as typeof fetch

  global.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: any[]) => {
    if (typeof handler === 'function') handler(...args)
    return 0 as any
  }) as typeof setTimeout

  try {
    await assert.rejects(
      () => executeImageGeneration(generationId, { configId }),
      /safety system/,
    )
  } finally {
    global.fetch = originalFetch
    global.setTimeout = originalSetTimeout
  }

  assert.deepEqual(fetchCalls, [
    'https://example.com/generate',
    'https://example.com/tasks/task-terminal-safety',
  ])

  const [updated] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, generationId))
    .all()
  assert.equal(updated.status, 'failed')
  assert.equal(updated.lastErrorCode, 'content_policy_violation')
  assert.match(updated.errorMsg ?? '', /safety system/)
})

test('classifyImageError extracts Retry-After from 429', () => {
  const err = new AiProviderError('API error 429: too many requests', 429, { retryAfterSeconds: 37 })
  const classified = classifyImageError(err)
  assert.equal(classified.code, 'rate_limited')
  assert.equal(classified.retryable, true)
  assert.equal(classified.retryAfterSeconds, 37)
})

test('computeRetryDelay honors Retry-After when provided', () => {
  const delay = computeRetryDelay('rate_limited', 1, 37)
  assert.equal(delay, 37_000)
})

test('computeRetryDelay waits for circuit breaker cooldown on network failures', () => {
  const timeoutDelay = computeRetryDelay('provider_timeout', 1)
  const circuitDelay = computeRetryDelay('circuit_open', 1)
  assert.ok(timeoutDelay >= 30_000, `provider timeout delay was ${timeoutDelay}`)
  assert.ok(circuitDelay >= 30_000, `circuit delay was ${circuitDelay}`)
})
