import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import type { TextModelTool } from './ai.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-http-error-'))
const originalDb = process.env.DB_PATH
process.env.DB_PATH = path.join(root, 'test.db')
const { db, schema } = await import('../db/index.js')
const { callTextModel } = await import('./ai.js')
const { closeAIProviderAdmission, providerAdmissionKey } = await import('./ai-provider-admission.js')
db.insert(schema.aiServiceConfigs).values({ name: 'HTTP error fixture', serviceType: 'text', provider: 'openai',
  baseUrl: 'https://text.fixture.invalid', apiKey: 'fixture-only', model: JSON.stringify(['fixture-model']),
  isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
test.after(() => {
  closeAIProviderAdmission(); db.$client.close(); fs.rmSync(root, { recursive: true, force: true })
  if (originalDb === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = originalDb
})

test('text HTTP errors expose status and Retry-After without changing the shared request retry policy', async t => {
  for (const [status, retryAfter, expectedDelay] of [[502, null, undefined], [429, '12', 12_000], [429, '0', 0],
    [401, null, undefined], [403, 'invalid', undefined], [503, '-1', undefined]] as const) {
    let calls = 0
    db.update(schema.aiServiceConfigs).set({ apiKey: `fixture-only-${status}-${retryAfter}` }).run()
    const mocked = t.mock.method(globalThis, 'fetch', async () => {
      calls++
      return new Response('fixture upstream error', { status, headers: retryAfter === null ? {} : { 'retry-after': retryAfter } })
    })
    try {
      await assert.rejects(callTextModel([{ role: 'user', content: 'fixture' }]), {
        name: 'TextModelHttpError', status, retryAfterMs: expectedDelay,
        message: `Text model request failed: ${status} fixture upstream error`,
      })
      assert.equal(calls, 1)
    } finally { mocked.mock.restore() }
  }
})

test('text HTTP Retry-After dates are parsed as a delay while successful responses remain unchanged', async t => {
  const retryAt = Date.now() + 15_000
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Response('overloaded', { status: 503, headers: { 'retry-after': new Date(retryAt).toUTCString() } })
    : Response.json({ choices: [{ finish_reason: 'stop', message: { content: ' complete text ' } }] }))
  await assert.rejects(callTextModel([{ role: 'user', content: 'fixture' }]), error => {
    const failure = error as Error & { status: number; retryAfterMs: number }
    assert.equal(failure.status, 503); assert.ok(failure.retryAfterMs > 0 && failure.retryAfterMs <= 15_000)
    return true
  })
  assert.equal(await callTextModel([{ role: 'user', content: 'fixture' }], { requireComplete: true }), 'complete text')
  assert.equal(calls, 2)
})

const toolName = 'submit_science_script'
const outputTool: TextModelTool = { type: 'function', function: {
  name: toolName, description: 'Submit the complete science script', strict: true,
  parameters: { type: 'object', additionalProperties: false, required: ['title', 'script'], properties: {
    title: { type: 'string', minLength: 1 }, script: { type: 'string', minLength: 1 },
  } },
} }
const requiredToolOptions = { tools: [outputTool], toolChoice: { type: 'function' as const, function: { name: toolName } }, requireComplete: true }
const toolArguments = JSON.stringify({ title: '冰为什么能浮在水上', script: '水结冰后密度降低。' })
const toolCall = { id: 'call_science', type: 'function', function: { name: toolName, arguments: toolArguments } }

test('strict tool requests force the named function and consume its arguments with null text content', async t => {
  const messages = [{ role: 'user', content: 'Write a science script from the supplied source.' }]
  const controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    calls++
    assert.equal(String(url), 'https://text.fixture.invalid/v1/chat/completions')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.signal, controller.signal)
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'gpt-6.1-terra')
    assert.equal(body.temperature, 0.3)
    assert.equal(body.max_tokens, 6000)
    assert.deepEqual(body.messages, messages)
    assert.deepEqual(body.tools, [outputTool])
    assert.deepEqual(body.tool_choice, requiredToolOptions.toolChoice)
    assert.equal(body.parallel_tool_calls, false)
    assert.equal(body.response_format, undefined)
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
      content: null, tool_calls: [{ ...toolCall, function: { ...toolCall.function, arguments: `  ${toolArguments}\n` } }],
    } }] })
  })
  const result = await callTextModel(messages, { ...requiredToolOptions, temperature: 0.3, maxTokens: 6000,
    signal: controller.signal, responseFormat: { type: 'json_object' },
    extraBody: { model: 'gpt-6.1-terra', parallel_tool_calls: true, response_format: { type: 'json_object' } },
  })
  assert.equal(result, toolArguments)
  assert.equal(calls, 1)
})

test('tool transport rejects missing, wrong, duplicate and malformed calls without falling back to JSON text', async t => {
  const invalidMessages = [
    { label: 'plain JSON text', message: { content: toolArguments } },
    { label: 'empty tool list', message: { content: toolArguments, tool_calls: [] } },
    { label: 'wrong tool name', message: { content: null, tool_calls: [{ ...toolCall, function: { ...toolCall.function, name: 'other_tool' } }] } },
    { label: 'multiple calls', message: { content: null, tool_calls: [toolCall, { ...toolCall, id: 'call_duplicate' }] } },
    { label: 'wrong call type', message: { content: null, tool_calls: [{ ...toolCall, type: 'custom' }] } },
    { label: 'empty arguments', message: { content: null, tool_calls: [{ ...toolCall, function: { ...toolCall.function, arguments: '' } }] } },
    { label: 'whitespace arguments', message: { content: null, tool_calls: [{ ...toolCall, function: { ...toolCall.function, arguments: ' \n ' } }] } },
    { label: 'object arguments', message: { content: null, tool_calls: [{ ...toolCall, function: { ...toolCall.function, arguments: { title: 'title', script: 'script' } } }] } },
    { label: 'missing arguments', message: { content: null, tool_calls: [{ ...toolCall, function: { name: toolName } }] } },
    { label: 'refusal', message: { content: null, refusal: 'Cannot comply with this request.' } },
  ]
  for (const item of invalidMessages) {
    await t.test(item.label, async context => {
      let calls = 0
      context.mock.method(globalThis, 'fetch', async () => {
        calls++
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: item.message }] })
      })
      await assert.rejects(callTextModel([{ role: 'user', content: 'fixture' }], requiredToolOptions), /指定工具.*submit_science_script/)
      assert.equal(calls, 1, 'The transport must not silently retry with a different output mode')
    })
  }
})

test('tool responses must finish with tool_calls even when text completion checks are disabled', async t => {
  for (const finishReason of ['length', 'stop', 'content_filter', undefined]) {
    await t.test(String(finishReason), async context => {
      context.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ finish_reason: finishReason,
        message: { content: toolArguments, tool_calls: [toolCall] },
      }] }))
      for (const requireComplete of [true, false]) {
        await assert.rejects(callTextModel([{ role: 'user', content: 'fixture' }], { ...requiredToolOptions, requireComplete }), /did not complete normally/)
      }
    })
  }
})

test('ordinary complete-text requests still reject tool_calls as their finish reason', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ finish_reason: 'tool_calls',
    message: { content: 'This is not a completed text response.', tool_calls: [toolCall] },
  }] }))
  await assert.rejects(callTextModel([{ role: 'user', content: 'fixture' }], { requireComplete: true }), /did not complete normally/)
})

test('tool-mode HTTP failures preserve status and Retry-After without a plain-text fallback request', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls++
    assert.deepEqual(JSON.parse(String(init?.body)).tools, [outputTool])
    return new Response('provider unavailable', { status: 503, headers: { 'retry-after': '3' } })
  })
  await assert.rejects(callTextModel([{ role: 'user', content: 'fixture' }], requiredToolOptions), {
    name: 'TextModelHttpError', status: 503, retryAfterMs: 3000,
  })
  assert.equal(calls, 1)
})

test('provider capacity is held until the complete response body is consumed', async t => {
  db.update(schema.aiServiceConfigs).set({ apiKey: 'body-capacity', settings: JSON.stringify({ textMaxConcurrency: 1 }) }).run()
  t.after(() => { db.update(schema.aiServiceConfigs).set({ settings: null }).run() })
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }))
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? response
    : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'second' } }] }))
  const first = callTextModel([{ role: 'user', content: 'first' }])
  await delay(20)
  const second = callTextModel([{ role: 'user', content: 'second' }])
  await delay(30)
  assert.equal(calls, 1, 'Receiving HTTP headers must not free capacity before the body arrives')
  stream.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'first' } }] })))
  stream.close()
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.equal(calls, 2)
})

test('an admitted HTTP request receives the original abort signal and is never replayed', async t => {
  db.update(schema.aiServiceConfigs).set({ apiKey: 'abort-admitted', settings: JSON.stringify({ textMaxConcurrency: 1 }) }).run()
  t.after(() => { db.update(schema.aiServiceConfigs).set({ settings: null }).run() })
  const controller = new AbortController()
  let dispatched!: () => void
  const started = new Promise<void>(resolve => { dispatched = resolve })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (++calls > 1) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'next' } }] })
    assert.equal(init?.signal, controller.signal)
    dispatched()
    return new Promise<Response>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
  })
  const request = callTextModel([{ role: 'user', content: 'fixture' }], { signal: controller.signal })
  await started
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  assert.equal(calls, 1)
  assert.equal(await callTextModel([{ role: 'user', content: 'next' }]), 'next')
  assert.equal(calls, 2)
})

test('provider HTTP 429 shares its cooldown with the next call without replaying the rejected request', async t => {
  db.update(schema.aiServiceConfigs).set({ apiKey: 'cooldown-transport' }).run()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Response('explicit refusal', { status: 429, headers: { 'retry-after': '0.08' } })
    : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }] }))
  await assert.rejects(callTextModel([{ role: 'user', content: 'fixture' }]), { name: 'TextModelHttpError', status: 429, retryAfterMs: 80 })
  assert.equal(calls, 1)
  const started = Date.now()
  assert.equal(await callTextModel([{ role: 'user', content: 'next task' }]), 'recovered')
  assert.ok(Date.now() - started >= 60, 'The second request must respect the first request\'s Retry-After')
  assert.equal(calls, 2)
})

test('local queue exhaustion dispatches nothing and does not create a provider cooldown', async t => {
  const apiKey = 'local-queue-timeout'
  db.update(schema.aiServiceConfigs).set({ apiKey, settings: JSON.stringify({ textMaxConcurrency: 1, textAdmissionMaxWaitMs: 20 }) }).run()
  t.after(() => { db.update(schema.aiServiceConfigs).set({ settings: null }).run() })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let dispatched!: () => void
  const started = new Promise<void>(resolve => { dispatched = resolve })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; dispatched(); await held
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] })
  })
  const first = callTextModel([{ role: 'user', content: 'first' }])
  try {
    await started
    await assert.rejects(callTextModel([{ role: 'user', content: 'waiting' }]), {
      name: 'AIProviderAdmissionError', status: 429, source: 'local_admission', code: 'AI_TEXT_ADMISSION_TIMEOUT', upstreamDispatched: false,
    })
    assert.equal(calls, 1)
    const database = new Database(process.env.DB_PATH! + '.ai-admission.db', { readonly: true })
    try {
      const scope = providerAdmissionKey({ endpoint: 'https://text.fixture.invalid/v1/chat/completions', apiKey })
      assert.equal(database.prepare('SELECT * FROM ai_provider_cooldowns WHERE scope=?').get(scope), undefined)
    } finally { database.close() }
  } finally { release(); await first }
})

test('an unknown HTTP transport outcome is propagated after one dispatch without adding cooldown', async t => {
  db.update(schema.aiServiceConfigs).set({ apiKey: 'unknown-network-outcome' }).run()
  let calls = 0
  const error = new TypeError('fetch failed')
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw error })
  await assert.rejects(callTextModel([{ role: 'user', content: 'fixture' }]), failure => failure === error)
  assert.equal(calls, 1)
})
