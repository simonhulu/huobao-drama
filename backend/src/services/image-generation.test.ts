import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { AiProviderError, classifyImageError, computeRetryDelay } from '../utils/error-taxonomy.js'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-image-limiter-'))
process.env.DB_PATH = join(dbDir, 'test.db')
process.env.STORAGE_PATH = join(dbDir, 'static')

const { ImageGenerationLimiter, createImageGenerationRecord, executeImageGeneration, canRecoverDurableImageRelayAdmission,
  readProviderJsonWithinDeadline, resolveImagePollDeadlineMs } = await import('./image-generation.js')
const { db, schema } = await import('../db/index.js')

const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

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

test('provider JSON decoding respects cancellation and never leaves a worker hung on an open body', async () => {
  const controller = new AbortController()
  const hangingResponse = new Response(new ReadableStream({
    start() {
      // Deliberately send neither bytes nor close: this reproduces a provider
      // that accepts the poll but never completes the response body.
    },
  }))

  const pending = readProviderJsonWithinDeadline(hangingResponse, 60_000, controller.signal)
  controller.abort(new Error('Task cancel requested'))

  await assert.rejects(pending, /Task cancel requested/)
})

test('provider JSON decoding has a body deadline after headers arrive', async () => {
  const hangingResponse = new Response(new ReadableStream({ start() {} }))
  await assert.rejects(
    () => readProviderJsonWithinDeadline(hangingResponse, 10),
    /Provider poll response timed out after 10ms/,
  )
})

test('provider poll deadline is anchored to the persisted submission time', () => {
  const submittedAt = Date.parse('2026-07-29T03:00:00.000Z')
  const timeoutMs = 20 * 60 * 1000
  assert.equal(
    resolveImagePollDeadlineMs('2026-07-29T03:00:00.000Z', timeoutMs, submittedAt + 25 * 60 * 1000),
    submittedAt + timeoutMs,
  )
  assert.equal(
    resolveImagePollDeadlineMs(null, timeoutMs, submittedAt),
    submittedAt + timeoutMs,
  )
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

  global.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
    // Skip the normal five-second polling delay, but preserve provider-body
    // deadlines so this test still exercises the actual response parser.
    if (Number(timeout) <= 5_000 && typeof handler === 'function') {
      handler(...args)
      return 0 as any
    }
    return originalSetTimeout(handler, timeout, ...args)
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

test('executeImageGeneration completes egaki-chatgpt generation through local provider branch', async () => {
  const fakeDir = mkdtempSync(join(tmpdir(), 'huobao-egaki-provider-'))
  const fakeBin = join(fakeDir, 'egaki')
  const capturePath = join(fakeDir, 'capture.json')
  writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const out = args[args.indexOf('-o') + 1]
fs.writeFileSync(out, Buffer.from('${png1x1.toString('base64')}', 'base64'))
fs.writeFileSync('${capturePath}', JSON.stringify({
  args,
  openaiKey: process.env.OPENAI_API_KEY || null
}))
`, { mode: 0o755 })

  const originalEgakiBin = process.env.EGAKI_BIN
  const originalOpenAIKey = process.env.OPENAI_API_KEY
  process.env.EGAKI_BIN = fakeBin
  process.env.OPENAI_API_KEY = 'sk-should-not-leak'

  const ts = new Date().toISOString()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image',
    provider: 'egaki-chatgpt',
    name: 'Egaki ChatGPT image',
    baseUrl: 'local-egaki',
    apiKey: 'unused',
    model: JSON.stringify(['gpt-image-2']),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const generationId = Number(db.insert(schema.imageGenerations).values({
    provider: 'egaki-chatgpt',
    prompt: 'cinematic frame',
    model: 'gpt-image-2',
    size: '1920x1080',
    seed: 123,
    referenceImages: JSON.stringify([`data:image/png;base64,${png1x1.toString('base64')}`]),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  try {
    const result = await executeImageGeneration(generationId, { configId })
    assert.equal(result.image_generation_id, generationId)
    assert.match(result.local_path, /^static\/images\/.+\.png$/)
    assert.deepEqual(readFileSync(join(process.env.STORAGE_PATH!, '..', result.local_path)), png1x1)

    const capture = JSON.parse(readFileSync(capturePath, 'utf8'))
    assert.equal(capture.openaiKey, null)
    assert.equal(capture.args[capture.args.indexOf('--aspect-ratio') + 1], '3:2')
    assert.equal(capture.args.includes('--seed'), false)
  } finally {
    if (originalEgakiBin == null) delete process.env.EGAKI_BIN
    else process.env.EGAKI_BIN = originalEgakiBin
    if (originalOpenAIKey == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenAIKey
  }

  const [updated] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, generationId))
    .all()
  assert.equal(updated.status, 'completed')
  assert.match(updated.localPath ?? '', /^static\/images\/.+\.png$/)
  assert.match(updated.taskId ?? '', /^egaki-local-/)
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

test('executeImageGeneration saves synchronous GPT Image 2 bytes only with the per-task opt-in', async () => {
  const ts = new Date().toISOString()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'gpt-image2', name: 'Synchronous image fixture',
    baseUrl: 'https://sync-image.example.test', apiKey: 'test-key', model: JSON.stringify(['gpt-image-2']),
    createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  const originalFetch = global.fetch
  const originalProxyProviders = process.env.IMAGE_PROXY_ENABLED_PROVIDERS
  process.env.IMAGE_PROXY_ENABLED_PROVIDERS = 'none'
  let requests = 0
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://sync-image.example.test/v1/images/generations')
    assert.equal(JSON.parse(String(init?.body)).async, true)
    requests++
    return new Response(JSON.stringify({ data: [{ b64_json: png1x1.toString('base64') }] }), { status: 200 })
  }) as typeof fetch
  try {
    for (const optIn of [undefined, false, true]) {
      const generationId = Number(db.insert(schema.imageGenerations).values({
        provider: 'gpt-image2', prompt: 'Cover background', model: 'gpt-image-2', size: '1024x1024',
        status: 'processing', createdAt: ts, updatedAt: ts,
      }).run().lastInsertRowid)
      if (optIn) {
        const result = await executeImageGeneration(generationId, { configId, allowSynchronousImage: optIn })
        assert.deepEqual(readFileSync(join(process.env.STORAGE_PATH!, '..', result.local_path)), png1x1)
      } else {
        await assert.rejects(executeImageGeneration(generationId, { configId, allowSynchronousImage: optIn }),
          /synchronous image response; async task id is required/)
      }
      const updated = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, generationId)).get()!
      assert.equal(updated.status, optIn ? 'completed' : 'failed')
      assert.equal(updated.taskId, null)
    }
    assert.equal(requests, 3)
  } finally {
    global.fetch = originalFetch
    if (originalProxyProviders == null) delete process.env.IMAGE_PROXY_ENABLED_PROVIDERS
    else process.env.IMAGE_PROXY_ENABLED_PROVIDERS = originalProxyProviders
  }
})

test('image completion reserves its WAL write before a competing connection can invalidate the read snapshot', async t => {
  const ts = new Date().toISOString()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'gpt-image2', name: 'Concurrent completion fixture',
    baseUrl: 'https://completion-lock.example.test', apiKey: 'test-key', model: JSON.stringify(['gpt-image-2']),
    createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  const generationId = Number(db.insert(schema.imageGenerations).values({
    provider: 'gpt-image2', prompt: 'Canal scene', model: 'gpt-image-2', status: 'processing',
    createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  db.$client.exec('CREATE TABLE image_completion_lock_probe (value INTEGER); INSERT INTO image_completion_lock_probe VALUES (0)')
  const competitor = new Database(process.env.DB_PATH!)
  competitor.pragma('busy_timeout=0')
  t.after(() => competitor.close())
  assert.equal(competitor.pragma('journal_mode', { simple: true }), 'wal')
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    data: [{ b64_json: png1x1.toString('base64') }],
  }), { status: 200 }))
  const originalPrepare = db.$client.prepare.bind(db.$client)
  let competingWriteCode: string | undefined
  let competingWrites = 0
  t.mock.method(db.$client, 'prepare', (sql: string) => {
    if (sql.startsWith('update "image_generations"') && sql.includes('"completed_at"')) {
      // syncRelatedImageTables has already read its generation here. A deferred
      // transaction lets this writer commit and then fails SQLITE_BUSY_SNAPSHOT.
      competingWrites++
      try { competitor.prepare('UPDATE image_completion_lock_probe SET value=value+1').run() }
      catch (error) { competingWriteCode = (error as { code: string }).code }
    }
    return originalPrepare(sql)
  })
  const result = await executeImageGeneration(generationId, { configId, allowSynchronousImage: true })
  assert.equal(competingWrites, 1)
  assert.equal(competingWriteCode, 'SQLITE_BUSY')
  assert.deepEqual(readFileSync(join(process.env.STORAGE_PATH!, '..', result.local_path)), png1x1)
  assert.equal(db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, generationId)).get()!.status, 'completed')
  competitor.prepare('UPDATE image_completion_lock_probe SET value=value+1').run()
  assert.equal((competitor.prepare('SELECT value FROM image_completion_lock_probe').get() as { value: number }).value, 1)
})

test('singleSubmission prevents HTTP retries after an ambiguous timeout while ordinary image generation still retries', async () => {
  const ts = new Date().toISOString()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'single-submission-test', name: 'Single submission fixture',
    baseUrl: 'https://single-submission.example.test', apiKey: 'test-key', model: 'fixture',
    settings: JSON.stringify({ adapter: {
      request: { url: '/generate', method: 'POST', body: { prompt: '{{prompt}}' } },
      response: { async: false, imageUrlPath: 'image_url' },
    } }),
    createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  const originalFetch = global.fetch
  const originalProxyProviders = process.env.IMAGE_PROXY_ENABLED_PROVIDERS
  process.env.IMAGE_PROXY_ENABLED_PROVIDERS = 'none'
  let requests = 0
  let failNext = true
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('data:')) return originalFetch(input, init)
    assert.equal(init?.method, 'POST')
    requests++
    if (failNext) {
      failNext = false
      throw new TypeError('fetch failed: request timed out after submission')
    }
    return new Response(JSON.stringify({ image_url: `data:image/png;base64,${png1x1.toString('base64')}` }), { status: 200 })
  }) as typeof fetch
  try {
    for (const singleSubmission of [true, false]) {
      failNext = true
      requests = 0
      const generationId = Number(db.insert(schema.imageGenerations).values({
        provider: 'single-submission-test', prompt: 'Cover background', model: 'fixture', size: '1024x1024',
        status: 'processing', createdAt: ts, updatedAt: ts,
      }).run().lastInsertRowid)
      if (singleSubmission) {
        await assert.rejects(executeImageGeneration(generationId, { configId, singleSubmission }), /timed out/)
        assert.equal(requests, 1)
      } else {
        await executeImageGeneration(generationId, { configId })
        assert.equal(requests, 2)
      }
    }
  } finally {
    global.fetch = originalFetch
    if (originalProxyProviders == null) delete process.env.IMAGE_PROXY_ENABLED_PROVIDERS
    else process.env.IMAGE_PROXY_ENABLED_PROVIDERS = originalProxyProviders
  }
})

function relayFixture(t: import('node:test').TestContext) {
  const ts = new Date().toISOString()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'gpt-image2', name: 'Explicit durable relay fixture',
    baseUrl: 'http://127.0.0.1:18080', apiKey: 'fake-relay-key', model: JSON.stringify(['gpt-image-2']),
    createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'IMAGE_HTTP_PROXY', 'IMAGE_HTTPS_PROXY']) {
    const original = process.env[key]
    process.env[key] = 'http://127.0.0.1:9'
    t.after(() => { if (original == null) delete process.env[key]; else process.env[key] = original })
  }
  const generationId = createImageGenerationRecord({ configId, durableRelay: true,
    prompt: 'Portrait cover background', imageType: 'science_cover_base', size: '1152x1536', frameType: '3:4' })
  const record = () => db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, generationId)).get()!
  const completed = () => Response.json({ id: record().taskId, status: 'completed', data: {
    url: `http://127.0.0.1:18080/assets/${record().taskId}/${createHash('sha256').update(png1x1).digest('hex')}.png`,
  } })
  return { configId, generationId, record, completed }
}

test('explicit birth-bound relay recovers a lost 202 and persists its original task before any dispatch', async t => {
  const f = relayFixture(t), calls: string[] = []
  let reserved = false
  assert.equal(canRecoverDurableImageRelayAdmission(f.generationId, f.configId), true)
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/assets/')) return new Response(png1x1, { headers: { 'content-type': 'image/png' } })
    calls.push(init!.method!)
    assert.match(f.record().taskId!, /^[a-f0-9]{64}$/)
    if (init!.method === 'GET') return reserved ? f.completed() : new Response('', { status: 404 })
    reserved = true
    throw new TypeError('fetch failed after relay persisted its reservation')
  })
  const result = await executeImageGeneration(f.generationId, { configId: f.configId, durableRelay: true, singleSubmission: true })
  assert.deepEqual(calls, ['GET', 'POST', 'GET'])
  assert.equal(f.record().status, 'completed')
  assert.deepEqual(readFileSync(join(process.env.STORAGE_PATH!, '..', result.local_path)), png1x1)
})

test('birth-bound relay survives admission and poll interruption and the next executor only fetches the same task', async t => {
  const f = relayFixture(t), calls: string[] = []
  let submitted = false, disconnected = true
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/assets/')) return new Response(png1x1)
    calls.push(init!.method!)
    if (init!.method === 'POST') { submitted = true; throw new TypeError('lost 202') }
    if (!submitted) return new Response('', { status: 404 })
    if (disconnected) throw new TypeError('poll disconnected')
    return f.completed()
  })
  const options = { configId: f.configId, durableRelay: true as const, singleSubmission: true }
  await assert.rejects(executeImageGeneration(f.generationId, options), { code: 'image_relay_pending', retryable: true })
  const taskId = f.record().taskId
  assert.equal(f.record().status, 'failed')
  disconnected = false
  await executeImageGeneration(f.generationId, options)
  assert.equal(f.record().taskId, taskId)
  assert.equal(f.record().status, 'completed')
  assert.deepEqual(calls, ['GET', 'POST', 'GET', 'GET'])
})

test('an old direct submission cannot acquire relay provenance by passing the execute opt-in', async t => {
  const f = relayFixture(t), ts = new Date().toISOString()
  const directId = Number(db.insert(schema.imageGenerations).values({
    provider: 'gpt-image2', model: 'gpt-image-2', prompt: 'Original direct submission', size: '1152x1536',
    status: 'failed', errorMsg: 'fetch failed', lastErrorCode: 'provider_timeout', createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must not reach network') })
  assert.equal(canRecoverDurableImageRelayAdmission(directId, f.configId), false)
  await assert.rejects(executeImageGeneration(directId, { configId: f.configId, durableRelay: true }), /ENOENT/)
  assert.equal(requests, 0)
  assert.equal(db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, directId)).get()!.taskId, null)
})

test('relay execution rejects changed authentication and missing explicit opt-in before any network request', async t => {
  const f = relayFixture(t)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must not reach network') })
  await assert.rejects(executeImageGeneration(f.generationId, { configId: f.configId }), /explicit recovery opt-in/)
  db.update(schema.aiServiceConfigs).set({ apiKey: 'changed-relay-key' }).where(eq(schema.aiServiceConfigs.id, f.configId)).run()
  assert.equal(canRecoverDurableImageRelayAdmission(f.generationId, f.configId), false)
  await assert.rejects(executeImageGeneration(f.generationId, { configId: f.configId, durableRelay: true }), /does not match/)
  assert.equal(requests, 0)
})

test('inactive relay config never lets fallback mutate its original provider, model or task identity', async t => {
  const f = relayFixture(t), ts = new Date().toISOString()
  db.update(schema.imageGenerations).set({ taskId: 'a'.repeat(64), status: 'failed' })
    .where(eq(schema.imageGenerations.id, f.generationId)).run()
  db.update(schema.aiServiceConfigs).set({ isActive: false }).where(eq(schema.aiServiceConfigs.id, f.configId)).run()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'other-provider', name: 'Unrelated active fallback', priority: 9999,
    baseUrl: 'https://fallback.invalid', apiKey: 'unrelated-key', model: JSON.stringify(['other-model']),
    createdAt: ts, updatedAt: ts,
  }).run()
  const before = f.record()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must not reach network') })
  await assert.rejects(executeImageGeneration(f.generationId, { configId: f.configId }), /explicit recovery opt-in/)
  assert.deepEqual(f.record(), before)
  await assert.rejects(executeImageGeneration(f.generationId, { configId: f.configId, durableRelay: true }), /cannot fall back/)
  assert.deepEqual(f.record(), before)
  assert.equal(requests, 0)
})

test('executor can reclaim a completed relay cache after the original twenty-minute generation deadline', async t => {
  const f = relayFixture(t), calls: string[] = []
  const beyondDeadline = Date.parse(f.record().createdAt) + 21 * 60_000
  t.mock.method(Date, 'now', () => beyondDeadline)
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init!.method} ${String(input).includes('/assets/') ? 'asset' : 'task'}`)
    if (String(input).includes('/assets/')) return new Response(png1x1)
    return f.completed()
  })
  await executeImageGeneration(f.generationId, { configId: f.configId, durableRelay: true })
  assert.equal(f.record().status, 'completed')
  assert.deepEqual(calls, ['GET task', 'GET asset'])
})
