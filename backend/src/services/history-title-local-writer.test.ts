import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import type { CoverJsonRequest } from './cover-prompt-enhance.js'
import { HISTORY_TITLE_REWRITE_MODEL, HISTORY_TITLE_REWRITE_PROMPT, requestHistoryTitleRewrites } from './history-title-local-writer.js'
import { rewriteHistoryTitles } from './history-title-rewrite.js'
import type { HistoryTitleResearch } from './history-title-research.js'

function messages(): Parameters<CoverJsonRequest>[0] {
  return [
    { role: 'system', content: HISTORY_TITLE_REWRITE_PROMPT },
    { role: 'user', content: JSON.stringify({ purpose: 'history-title-rewrite',
      sourceTitle: '正文原视频', script: '唯一事实源：统一后的皇族内斗，统一局面维持不住。',
      titles: [
        { reference_id: 'R5', original_title: '第一条原题：“自己的天下自己拆” - 今日头条' },
        { reference_id: 'R2', original_title: '第二条原题：亲人打起来，把天下玩没了？ - 百家号' },
        { reference_id: 'R4', original_title: '第三条原题：统一之后，自己人怎么先翻了脸？' },
      ],
    }) },
  ]
}

function completion(content: unknown, finish_reason = 'stop') {
  return Response.json({ choices: [{ finish_reason, message: { content } }] })
}

function withLocalUrl<T>(value: string | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env.HISTORY_LM_STUDIO_URL
  if (value === undefined) delete process.env.HISTORY_LM_STUDIO_URL
  else process.env.HISTORY_LM_STUDIO_URL = value
  return action().finally(() => {
    if (previous === undefined) delete process.env.HISTORY_LM_STUDIO_URL
    else process.env.HISTORY_LM_STUDIO_URL = previous
  })
}

test('complete overlong and unsupported-symbol titles remain available for selection and manual editing', async () => {
  const titles = ['八王之乱：西晋皇族为何把刚统一的天下打散了？', '皇族内斗★为何让百姓遭殃？', '统一之后自己人先翻脸了']
  let calls = 0
  const stub = mock.method(globalThis, 'fetch', async () => completion(titles[calls++ % titles.length]))
  try {
    const result = await withLocalUrl(undefined, () => requestHistoryTitleRewrites(messages())) as {
      rewrites: { title: string }[]
    }
    assert.deepEqual(result.rewrites.map(item => item.title), titles)
    assert.equal(calls, 3, 'length or symbol issues must not discard or rewrite complete candidates')
  } finally { stub.mock.restore() }
})

test('each actual parent is sent sequentially to the exact local model with the exact unmodified system prompt', async () => {
  const input = messages()
  const payload = JSON.parse(input[1]!.content)
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  let active = 0
  let maximum = 0
  const stub = mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    active++
    maximum = Math.max(maximum, active)
    requests.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) })
    const index = requests.length - 1
    await new Promise<void>(resolve => setImmediate(resolve))
    active--
    return completion(['皇族把统一天下打散了', '亲人打起来怎么把天下玩没了', '统一之后自己人先翻脸了'][index])
  })
  try {
    const result = await withLocalUrl(undefined, () => requestHistoryTitleRewrites(input)) as {
      rewrites: { reference_id: string; title: string; adaptation: string }[]
    }
    assert.equal(maximum, 1)
    assert.equal(requests.length, 3)
    assert.equal(HISTORY_TITLE_REWRITE_MODEL, 'qwen3.5-9b-writing-dpo@q4_k_s')
    assert.equal(HISTORY_TITLE_REWRITE_PROMPT, '请将下面这个标题改写为更自然、更有人类写作风格的表达，要求字数不超过16个字。更有情绪和冲突，能激起人的好奇心和求知欲')
    for (const [index, request] of requests.entries()) {
      assert.equal(request.url, 'http://127.0.0.1:1234/v1/chat/completions')
      assert.equal(request.init.method, 'POST')
      assert.equal(request.init.redirect, 'error')
      assert.ok(request.init.signal instanceof AbortSignal)
      assert.equal(request.body.model, HISTORY_TITLE_REWRITE_MODEL)
      assert.equal(request.body.stream, false)
      assert.equal(request.body.temperature, 0.3)
      assert.equal(request.body.repeat_penalty, 1)
      assert.equal(request.body.response_format, undefined)
      assert.equal(request.body.seed, 42)
      const sentMessages = request.body.messages as { role: string; content: string }[]
      assert.equal(sentMessages.length, 3)
      assert.deepEqual(sentMessages[0], { role: 'system', content: HISTORY_TITLE_REWRITE_PROMPT })
      assert.equal(sentMessages[1]!.content, payload.titles[index].original_title)
      assert.deepEqual(sentMessages[2], { role: 'assistant', content: '</think>\n\n' })
      assert.ok(!sentMessages[1]!.content.includes(payload.script))
      assert.ok(!sentMessages[1]!.content.includes(payload.sourceTitle))
      for (let other = 0; other < payload.titles.length; other++) {
        if (other !== index) assert.ok(!sentMessages[1]!.content.includes(payload.titles[other].original_title))
      }
      assert.ok(!sentMessages[1]!.content.includes('snippet'))
      assert.ok(!sentMessages[1]!.content.includes('titleResearch'))
    }
    assert.deepEqual(result.rewrites.map(item => item.reference_id), ['R5', 'R2', 'R4'])
    assert.ok(result.rewrites.every(item => item.adaptation === `LM Studio ${HISTORY_TITLE_REWRITE_MODEL}按指定提示词逐条改写。`))
  } finally { stub.mock.restore() }
})

test('uses an explicitly configured loopback LM Studio URL without changing model configuration', async () => {
  const urls: string[] = []
  const stub = mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    urls.push(String(url))
    return completion('皇族为何自己打起来了')
  })
  try {
    await withLocalUrl('http://localhost:4321/v1', () => requestHistoryTitleRewrites(messages()))
    assert.deepEqual(urls, Array(3).fill('http://localhost:4321/v1/chat/completions'))
    assert.ok(urls.every(url => !/load|unload|models/.test(url)))
  } finally { stub.mock.restore() }
})

for (const count of [1, 2]) {
  test(`rewrites only the ${count} available parents with the same Q4 prompt and thinking disabled`, async () => {
    const input = messages()
    const payload = JSON.parse(input[1]!.content)
    payload.titles = payload.titles.slice(0, count)
    input[1]!.content = JSON.stringify(payload)
    const bodies: any[] = []
    const stub = mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return completion(`皇族把到手的天下打散了${bodies.length}？`)
    })
    try {
      const result = await withLocalUrl(undefined, () => requestHistoryTitleRewrites(input)) as {
        rewrites: { reference_id: string; title: string }[]
      }
      assert.equal(bodies.length, count)
      assert.deepEqual(result.rewrites.map(item => item.reference_id), payload.titles.map((item: { reference_id: string }) => item.reference_id))
      for (const [index, body] of bodies.entries()) {
        assert.equal(body.model, HISTORY_TITLE_REWRITE_MODEL)
        assert.deepEqual(body.messages, [
          { role: 'system', content: HISTORY_TITLE_REWRITE_PROMPT },
          { role: 'user', content: payload.titles[index].original_title },
          { role: 'assistant', content: '</think>\n\n' },
        ])
      }
    } finally { stub.mock.restore() }
  })
}

test('rejects remote or credential-bearing endpoints before sending any request and never follows redirects', async () => {
  let calls = 0
  const stub = mock.method(globalThis, 'fetch', async () => { calls++; return completion('合法标题') })
  try {
    for (const url of ['https://remote.example/v1', 'http://127.0.0.1.evil.example/v1', 'http://secret:token@127.0.0.1:1234/v1']) {
      await assert.rejects(withLocalUrl(url, () => requestHistoryTitleRewrites(messages())), error => {
        assert.ok(error instanceof Error)
        assert.doesNotMatch(error.message, /secret|token@/)
        return true
      })
    }
    assert.equal(calls, 0)
  } finally { stub.mock.restore() }
})

test('rejects HTTP errors, truncated, missing, empty and non-text output without inventing a title', async () => {
  for (const response of [
    () => new Response('Authorization: secret-local-token', { status: 503 }),
    () => Response.json({ error: { message: 'secret-local-token' } }),
    () => completion('部分标题', 'length'),
    () => completion('', 'stop'),
    () => completion('   ', 'stop'),
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: '推理过程不是最终标题，不能拿来发布' } }] }),
    () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '被截断的推理不是标题' } }] }),
    () => completion(null, 'stop'),
    () => completion({ title: '不能把整个对象当作标题' }),
    () => completion('★🔥', 'stop'),
  ]) {
    let calls = 0
    const stub = mock.method(globalThis, 'fetch', async () => { calls++; return response() })
    try {
      await assert.rejects(withLocalUrl(undefined, () => requestHistoryTitleRewrites(messages())), error => {
        assert.ok(error instanceof Error)
        assert.doesNotMatch(error.message, /Authorization|secret-local-token/)
        return true
      })
      assert.equal(calls, 1)
    } finally { stub.mock.restore() }
  }
})

test('transport failure stops immediately and never falls back to another model or provider', async () => {
  let calls = 0
  const stub = mock.method(globalThis, 'fetch', async () => {
    calls++
    throw new Error('Authorization: secret-transport-key')
  })
  try {
    await assert.rejects(withLocalUrl(undefined, () => requestHistoryTitleRewrites(messages())), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /LM Studio/)
      assert.doesNotMatch(error.message, /Authorization|secret-transport-key/)
      return true
    })
    assert.equal(calls, 1)
  } finally { stub.mock.restore() }
})

test('adapter input must be a supported title rewrite batch before any local request', async () => {
  let calls = 0
  const stub = mock.method(globalThis, 'fetch', async () => { calls++; return completion('合法标题') })
  try {
    for (const content of ['not json', JSON.stringify({ purpose: 'different-stage', titles: [] }), JSON.stringify({
      purpose: 'history-title-rewrite', script: '正文', titles: [],
    })]) {
      await assert.rejects(requestHistoryTitleRewrites([{ role: 'system', content: HISTORY_TITLE_REWRITE_PROMPT }, { role: 'user', content }]))
    }
    assert.equal(calls, 0)
  } finally { stub.mock.restore() }
})

test('default writer corrects duplicate titles using only the current parent and its own previous rewrite', async () => {
  const references = Array.from({ length: 3 }, (_, index) => ({ id: `R${index + 1}`, title: `皇族内斗原题真实来源${index + 1}`,
    url: `https://www.toutiao.com/article/${index + 2000}`, platform: 'toutiao' as const,
    snippet: '不能交给本地写作模型的摘要', query: '皇族' }))
  const titleResearch: HistoryTitleResearch = {
    searched_at: '2026-10-21T01:02:03.000Z', keywords: [['皇族'], ['统一']],
    queries: Array.from({ length: 4 }, (_, index) => ({ platform: 'toutiao', query: `皇族${index}`, status: 'ok' })), references,
  }
  const firstTitles = ['皇族把天下打散了', '皇族把天下打散了？', '到手的天下为何守不住']
  const correctedTitles = ['皇族为何自己砸了天下', '统一江山为何败给自家人', '天下到手却先翻脸了']
  const sent: { role: string; content: string }[][] = []
  const stub = mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init!.body))
    sent.push(body.messages)
    const index = sent.length - 1
    return completion(index < 3 ? firstTitles[index] : correctedTitles[index - 3])
  })
  try {
    const chooser: CoverJsonRequest = async () => ({ selected: references.map(reference => ({ reference_id: reference.id, reason: '真实原题有冲突' })) })
    const result = await withLocalUrl(undefined, () => rewriteHistoryTitles({
      script: '不能泄露给本地模型的完整正文：统一后皇族内斗。', titleResearch,
    }, chooser))
    assert.ok(result)
    assert.deepEqual(result.rewrites.map(item => item.title), correctedTitles)
    assert.equal(sent.length, 6)
    for (let index = 0; index < 3; index++) {
      assert.equal(sent[index]![1]!.content, references[index]!.title)
      const corrected = sent[index + 3]!
      assert.deepEqual(corrected[0], { role: 'system', content: HISTORY_TITLE_REWRITE_PROMPT })
      assert.deepEqual(corrected.at(-1), { role: 'assistant', content: '</think>\n\n' })
      const user = corrected[1]!.content
      assert.ok(user.includes(references[index]!.title))
      assert.ok(user.includes(firstTitles[index]!))
      assert.match(user, /重新改写|重复/)
      assert.doesNotMatch(user, /完整正文|摘要|previous_output|candidate-/)
      for (const [other, reference] of references.entries()) {
        if (other !== index) assert.ok(!user.includes(reference.title))
      }
      if (index < 2) assert.ok(!user.includes(firstTitles[2]!))
      else assert.ok(!user.includes(firstTitles[0]!))
    }
  } finally { stub.mock.restore() }
})

test('the helper retains complete title drafts including length, symbol and multiline issues without using another writer', async () => {
  for (const title of ['西晋皇族★为什么打起来', `${'晋'.repeat(26)}？`, '皇族\u200b把天下打散了', '西晋皇族\n为何打散天下']) {
    let localCalls = 0
    let projectCalls = 0
    const stub = mock.method(globalThis, 'fetch', async () => { localCalls++; return completion(`${title}${localCalls}`) })
    try {
      const titleResearch: HistoryTitleResearch = {
        searched_at: '2026-10-21T01:02:03.000Z', keywords: [['皇族'], ['统一']],
        queries: Array.from({ length: 4 }, (_, index) => ({ platform: 'toutiao', query: `皇族${index}`, status: 'ok' })),
        references: Array.from({ length: 3 }, (_, index) => ({ id: `R${index + 1}`, title: `皇族原题真实来源${index}`,
          url: `https://www.toutiao.com/article/${index + 1000}`, platform: 'toutiao', snippet: '不允许进入改写模型的检索摘要', query: '皇族' })),
      }
      const chooser: CoverJsonRequest = async () => {
        projectCalls++
        return { selected: titleResearch.references.map(reference => ({ reference_id: reference.id, reason: '情绪表达贴合正文' })) }
      }
      const result = await withLocalUrl(undefined, () => rewriteHistoryTitles({
        script: '统一后皇族内斗，统一局面维持不住。', titleResearch,
      }, chooser))
      assert.deepEqual(result!.rewrites.map(item => item.title), [`${title}1`, `${title}2`, `${title}3`])
      assert.equal(projectCalls, 1)
      assert.equal(localCalls, 3)
    } finally { stub.mock.restore() }
  }
})

test('commas normalize while the Q4 emotional punctuation remains available for manual editing', async () => {
  const outputs = ['八王之乱！皇族内斗，天下崩塌。', '皇族争权；天下遭殃！', '古人天黑就睡,不是懒,是保命！']
  let calls = 0
  const stub = mock.method(globalThis, 'fetch', async () => completion(outputs[calls++]))
  try {
    const result = await withLocalUrl(undefined, () => requestHistoryTitleRewrites(messages())) as {
      rewrites: { title: string; adaptation: string }[]
    }
    assert.equal(calls, 3)
    assert.deepEqual(result.rewrites.map(item => item.title), [
      '八王之乱！皇族内斗 天下崩塌。', '皇族争权；天下遭殃！', '古人天黑就睡 不是懒 是保命！',
    ])
    assert.ok(result.rewrites[0]!.adaptation.includes(outputs[0]!))
    assert.ok(result.rewrites[2]!.adaptation.includes(outputs[2]!))
  } finally { stub.mock.restore() }
})

test('Q4 receives only its own concise factual boundary while the system instruction remains unchanged', async () => {
  const input = messages()
  const payload = JSON.parse(input[1]!.content)
  payload.titles[0].rewrite_guidance = '正文没有三百年这一数字，删除时间断言，保留皇族内斗与西晋失去统一的冲突。'
  input[1]!.content = JSON.stringify(payload)
  const sent: { role: string; content: string }[][] = []
  const stub = mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push(JSON.parse(String(init!.body)).messages)
    return completion(['皇族内斗竟把西晋江山拆散了', '亲人打起来怎么把天下玩没了', '统一之后自己人先翻脸了'][sent.length - 1])
  })
  try {
    await withLocalUrl(undefined, () => requestHistoryTitleRewrites(input))
    assert.deepEqual(sent[0]![0], { role: 'system', content: HISTORY_TITLE_REWRITE_PROMPT })
    assert.ok(sent[0]![1]!.content.includes(payload.titles[0].original_title))
    assert.ok(sent[0]![1]!.content.includes(payload.titles[0].rewrite_guidance))
    assert.ok(!sent[0]![1]!.content.includes(payload.script))
    assert.equal(sent[1]![1]!.content, payload.titles[1].original_title)
    assert.equal(sent[2]![1]!.content, payload.titles[2].original_title)
  } finally { stub.mock.restore() }
})

test('an overlong title keeps its original wording and the rest of the batch continues without format retries', async () => {
  const overlong = '八王之乱爆发，五胡军队入侵中原，西晋是如何自我毁灭的？'
  const sent: { model: string; messages: { role: string; content: string }[] }[] = []
  const outputs = [overlong, '亲人打起来怎么把天下玩没了', '统一之后自己人先翻脸了']
  const stub = mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    sent.push(JSON.parse(String(init!.body)))
    return completion(outputs[sent.length - 1])
  })
  try {
    const input = messages()
    const result = await withLocalUrl(undefined, () => requestHistoryTitleRewrites(input)) as { rewrites: { title: string }[] }
    assert.equal(sent.length, 3)
    assert.ok(sent.every(item => item.model === 'qwen3.5-9b-writing-dpo@q4_k_s'))
    const next = sent[1]!.messages
    assert.deepEqual(next[0], { role: 'system', content: HISTORY_TITLE_REWRITE_PROMPT })
    assert.deepEqual(next[2], { role: 'assistant', content: '</think>\n\n' })
    assert.ok(next[1]!.content.includes('第二条原题'))
    assert.ok(!next[1]!.content.includes(overlong))
    assert.ok(!next[1]!.content.includes('唯一事实源'))
    assert.equal(result.rewrites[0]!.title, '八王之乱爆发 五胡军队入侵中原 西晋是如何自我毁灭的？')
    assert.deepEqual(result.rewrites.slice(1).map(item => item.title), outputs.slice(1))
  } finally { stub.mock.restore() }
})

test('all overlong candidates are retained without truncation', async () => {
  let calls = 0
  const stub = mock.method(globalThis, 'fetch', async () => { calls++; return completion('晋'.repeat(17)) })
  try {
    const result = await withLocalUrl(undefined, () => requestHistoryTitleRewrites(messages())) as { rewrites: { title: string }[] }
    assert.deepEqual(result.rewrites.map(item => item.title), ['晋'.repeat(17), '晋'.repeat(17), '晋'.repeat(17)])
    assert.equal(calls, 3)
  } finally { stub.mock.restore() }
})
