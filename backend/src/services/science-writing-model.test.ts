import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { callScienceWritingModel, getScienceWritingModel, openScienceWritingApi, SCIENCE_WRITING_MODEL } from './science-writing-model.js'

const messages = [{ role: 'system', content: '保留故事推进与情绪弧线，缩写为自然通顺的中文。' }, { role: 'user', content: '科学家先观察现象，再做实验，最后解释原因。' }]
const draft = { title: '现象背后的原因', script: '先把眼前的现象看清，再看看实验揭开了什么。' }
const tool = { type: 'function' as const, function: { name: 'submit_science_script', parameters: {
  type: 'object', properties: { title: { type: 'string' }, script: { type: 'string' } }, required: ['title', 'script'], additionalProperties: false,
} } }

async function fixture(t: test.TestContext, handle: (request: http.IncomingMessage, response: http.ServerResponse, body: any) => void) {
  const previousUrl = process.env.SCIENCE_WRITER_API_URL, previousModel = process.env.SCIENCE_WRITER_MODEL
  const previousLimit = process.env.SCIENCE_WRITER_MAX_TOKENS
  const thinkingEnvironment = Object.fromEntries(['SCIENCE_WRITER_ENABLE_THINKING', 'SCIENCE_WRITER_THINKING_BUDGET_TOKENS']
    .map(name => [name, process.env[name]]))
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    handle(request, response, body ? JSON.parse(body) : undefined)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  process.env.SCIENCE_WRITER_API_URL = `http://127.0.0.1:${address.port}/v1`
  delete process.env.SCIENCE_WRITER_MODEL
  delete process.env.SCIENCE_WRITER_MAX_TOKENS
  for (const name of Object.keys(thinkingEnvironment)) delete process.env[name]
  t.after(async () => {
    if (previousUrl === undefined) delete process.env.SCIENCE_WRITER_API_URL; else process.env.SCIENCE_WRITER_API_URL = previousUrl
    if (previousModel === undefined) delete process.env.SCIENCE_WRITER_MODEL; else process.env.SCIENCE_WRITER_MODEL = previousModel
    if (previousLimit === undefined) delete process.env.SCIENCE_WRITER_MAX_TOKENS; else process.env.SCIENCE_WRITER_MAX_TOKENS = previousLimit
    for (const [name, value] of Object.entries(thinkingEnvironment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return server
}

function respond(response: http.ServerResponse, content: unknown = JSON.stringify(draft), finish_reason = 'stop') {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }))
}

test('the remote writer requests the exact configured model and converts the script tool to JSON schema', async t => {
  const sent: any[] = []
  await fixture(t, (request, response, body) => {
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, undefined)
    sent.push(body)
    respond(response)
  })
  const before = structuredClone(messages)
  const result = await callScienceWritingModel(messages, { tools: [tool], maxTokens: 22000,
    extraBody: { model: 'unrelated-gpt', api_key: 'never-send-this' }, requireComplete: true })
  assert.deepEqual(JSON.parse(result), draft)
  assert.deepEqual(messages, before)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].model, SCIENCE_WRITING_MODEL)
  assert.equal(sent[0].max_tokens, 8192)
  assert.equal(sent[0].tools, undefined)
  assert.equal(sent[0].tool_choice, undefined)
  assert.equal(sent[0].api_key, undefined)
  assert.equal(sent[0].stream, false)
  assert.equal(sent[0].top_p, .8)
  assert.equal(sent[0].top_k, 20)
  assert.equal(sent[0].min_p, 0)
  assert.equal(sent[0].repeat_penalty, 1)
  assert.deepEqual(sent[0].chat_template_kwargs, { enable_thinking: false })
  assert.equal(sent[0].reasoning_budget_tokens, 0)
  assert.deepEqual(sent[0].response_format.json_schema.schema, tool.function.parameters)
  assert.match(sent[0].messages[0].content, /只返回一个 JSON 对象/)
  process.env.SCIENCE_WRITER_MODEL = 'configured-writing-model'
  await callScienceWritingModel(messages)
  assert.equal(sent[1].model, 'configured-writing-model')
  assert.equal(getScienceWritingModel(), 'configured-writing-model')
})

test('optional bounded thinking keeps science JSON in content and reasoning out of the returned draft', async t => {
  let sent: any
  await fixture(t, (_request, response, body) => {
    sent = body
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify(draft), reasoning_content: 'private model reasoning',
    } }] }))
  })
  process.env.SCIENCE_WRITER_ENABLE_THINKING = 'true'
  process.env.SCIENCE_WRITER_THINKING_BUDGET_TOKENS = '1024'
  const result = await callScienceWritingModel(messages, { maxTokens: 4000, tools: [tool] })
  assert.deepEqual(JSON.parse(result), draft)
  assert.doesNotMatch(result, /private model reasoning/)
  assert.deepEqual(sent.chat_template_kwargs, { enable_thinking: true })
  assert.equal(sent.reasoning_budget_tokens, 1024)
  assert.equal(sent.max_tokens, 5024)
  assert.equal(sent.response_format.type, 'json_schema')
})

test('the configured output ceiling preserves caller budgets and invalid settings fail before sending source', async t => {
  const sent: any[] = []
  await fixture(t, (_request, response, body) => { sent.push(body); respond(response) })
  process.env.SCIENCE_WRITER_MAX_TOKENS = '12000'
  await callScienceWritingModel(messages, { maxTokens: 16000 })
  await callScienceWritingModel(messages, { maxTokens: 1800 })
  assert.deepEqual(sent.map(body => body.max_tokens), [12000, 1800])
  for (const invalid of ['0', '-1', '1.5', 'NaN', '32769']) {
    process.env.SCIENCE_WRITER_MAX_TOKENS = invalid
    await assert.rejects(callScienceWritingModel(messages), /SCIENCE_WRITER_MAX_TOKENS/)
  }
  assert.equal(sent.length, 2)
})

test('an explicitly configured loopback API does not need SSH credentials', async t => {
  await fixture(t, (_request, response) => respond(response))
  const api = await openScienceWritingApi(new AbortController().signal)
  assert.match(api.apiUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  await api.close()
  await api.close()
})

test('the small writer receives readable source, story and corrections in one user request', async t => {
  let sent: any
  await fixture(t, (_request, response, body) => { sent = body; respond(response) })
  const input = [{ role: 'system', content: '忠实缩写。' }, { role: 'user', content: JSON.stringify({
    title: '冰的故事', readingMaterial: '先观察冰浮起，再解释密度。', lengthGuide: { suggested: '缩写，不凑字数' },
    previousDraft: { script: '冰会沉下去。' }, revisionInstruction: '原文是浮起来，修正相反结论。',
  }) }, { role: 'user', content: '原文：Ice floats.' }]
  const before = structuredClone(input)
  await callScienceWritingModel(input)
  assert.deepEqual(input, before)
  assert.equal(sent.messages.length, 2)
  assert.match(sent.messages[1].content, /原标题：冰的故事/)
  assert.match(sent.messages[1].content, /先观察冰浮起，再解释密度/)
  assert.match(sent.messages[1].content, /原文是浮起来，修正相反结论/)
  assert.match(sent.messages[1].content, /冰会沉下去/)
  assert.match(sent.messages[1].content, /Ice floats/)
  assert.doesNotMatch(sent.messages[1].content, /readingMaterial|previousDraft|revisionInstruction/)
})

test('remote decoding uses a small JSON grammar while application validation owns length limits', async t => {
  let sent: any
  await fixture(t, (_request, response, body) => { sent = body; respond(response) })
  await callScienceWritingModel(messages, { tools: [{ ...tool, function: { ...tool.function, parameters: {
    ...tool.function.parameters, properties: { title: { type: 'string', minLength: 1, maxLength: 60 }, script: { type: 'string', minLength: 1, maxLength: 80000 } },
  } } }] })
  assert.deepEqual(sent.response_format.json_schema.schema.properties, { title: { type: 'string' }, script: { type: 'string' } })
  assert.deepEqual(sent.response_format.json_schema.schema.required, ['title', 'script'])
})

test('only an explicit passage repair can return an empty script to delete source promotion', async t => {
  let sent: any
  await fixture(t, (_request, response, body) => { sent = body; respond(response, JSON.stringify({ title: '冰', script: '' })) })
  await assert.rejects(callScienceWritingModel(messages, { tools: [tool] }), /必须返回完整标题和正文/)
  const deletionTool = { ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters,
    properties: { title: { type: 'string' }, script: { type: 'string', minLength: 0 } },
  } } }
  assert.deepEqual(JSON.parse(await callScienceWritingModel(messages, { tools: [deletionTool] })), { title: '冰', script: '' })
  assert.match(sent.messages[0].content, /整段删除时script返回空字符串/)
})

test('invalid, remote and credential-bearing direct URLs fail before transmitting text', async t => {
  let count = 0
  await fixture(t, (_request, response) => { count++; respond(response) })
  for (const value of ['not-a-url', 'https://remote.example/v1', 'http://127.0.0.1.evil.example/v1',
    'http://user:private-password@127.0.0.1:8788/v1', 'http://127.0.0.1:8788/v1?key=private-password']) {
    process.env.SCIENCE_WRITER_API_URL = value
    await assert.rejects(callScienceWritingModel(messages), error => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /private-password/)
      return true
    })
  }
  assert.equal(count, 0)
})

test('HTTP errors retain status and retry timing without exposing response secrets or selecting another model', async t => {
  let count = 0
  await fixture(t, (_request, response) => {
    count++
    response.writeHead(429, { 'Retry-After': '7' })
    response.end('Authorization: private-upstream-secret')
  })
  await assert.rejects(callScienceWritingModel(messages), error => {
    assert.equal((error as any).status, 429)
    assert.equal((error as any).retryAfterMs, 7000)
    assert.doesNotMatch((error as Error).message, /private-upstream-secret|Authorization/)
    return true
  })
  assert.equal(count, 1)
})

test('context rejection never silently truncates the original input or repeats a request', async t => {
  let count = 0
  await fixture(t, (_request, response, body) => {
    count++
    assert.equal(body.messages[1].content, messages[1]!.content)
    response.writeHead(400)
    response.end('prompt too long: private-source')
  })
  await assert.rejects(callScienceWritingModel(messages), /上下文长度.*原文未被裁剪/)
  assert.equal(count, 1)
})

test('truncated, empty, malformed or reasoning-only responses cannot become manuscripts', async t => {
  const replies = [
    () => ({ content: JSON.stringify(draft), reason: 'length' }),
    () => ({ content: '', reason: 'stop' }),
    () => ({ content: 'not-json', reason: 'stop' }),
    () => ({ content: '{"title":"title"}', reason: 'stop' }),
    () => ({ content: JSON.stringify({ ...draft, reasoning: 'not body' }), reason: 'stop' }),
    () => ({ content: null, reason: 'stop' }),
  ]
  let index = 0
  await fixture(t, (_request, response) => {
    const next = replies[index++]!()
    respond(response, next.content, next.reason)
  })
  for (const _reply of replies) await assert.rejects(callScienceWritingModel(messages))
  assert.equal(index, replies.length)
})

test('cancellation aborts the request and never leaves a second generation running', async t => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let count = 0
  await fixture(t, () => { count++; started() })
  const controller = new AbortController()
  const task = callScienceWritingModel(messages, { signal: controller.signal })
  await ready
  controller.abort(new Error('stop-writing'))
  await assert.rejects(task, /stop-writing/)
  assert.equal(count, 1)
})

test('pre-cancelled requests and unsupported tools never reach the API', async t => {
  let count = 0
  await fixture(t, (_request, response) => { count++; respond(response) })
  const controller = new AbortController()
  controller.abort(new Error('already-stopped'))
  await assert.rejects(callScienceWritingModel(messages, { signal: controller.signal }), /already-stopped/)
  await assert.rejects(callScienceWritingModel(messages, { tools: [{ ...tool, function: { ...tool.function, name: 'submit_science_plan' } }] }), /仅支持正文写作/)
  assert.equal(count, 0)
})
