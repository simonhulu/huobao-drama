import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import {
  HISTORY_REWRITE_MODEL, HISTORY_REWRITE_PROMPT, planHistoryAudioChunks,
  EmptyAsrTranscriptionError, transcribeHistoryAudio, correctHistoryTranscript, rewriteHistoryScript, inspectHistoryLocalModel, estimateHistoryScriptTiming,
} from './history-script-processing.js'

function loadedModelResponse(context = 16_384, state = 'loaded') {
  return Response.json({ data: [{ id: HISTORY_REWRITE_MODEL, state, max_context_length: 262_144, loaded_context_length: context }] })
}

test('script duration estimates provide neutral timing without length judgments', () => {
  const target = estimateHistoryScriptTiming('史'.repeat(4500))
  assert.equal(target.targetSeconds, 900)
  assert.equal(target.estimatedSeconds, 900)
  assert.equal(target.unitsPerMinute, 300)
  assert.equal('fit' in target, false)
  assert.deepEqual(target.estimatedRangeSeconds, [819, 1000])
  assert.equal(estimateHistoryScriptTiming('史，史。 hello world!').spokenUnits, 4)
  assert.equal(estimateHistoryScriptTiming('史'.repeat(1000)).estimatedSeconds, 200)
  assert.equal(estimateHistoryScriptTiming('史'.repeat(3100)).estimatedSeconds, 620)
})

test('audio chunk plan covers the complete recording without breaching MiniMax duration limits', () => {
  assert.deepEqual(planHistoryAudioChunks(128.4), [{ start: 0, duration: 128.4 }])
  assert.deepEqual(planHistoryAudioChunks(1000), [
    { start: 0, duration: 480 }, { start: 480, duration: 480 }, { start: 960, duration: 40 },
  ])
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => planHistoryAudioChunks(bad))
})

async function audioFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'history-asr-'))
  const file = path.join(dir, 'audio.wav')
  await writeFile(file, Buffer.from('mock audio bytes'))
  return file
}

test('ASR uses the documented multipart API, Chinese hint and preserves source timestamps', async () => {
  const file = await audioFixture()
  const result = await transcribeHistoryAudio(file, 10, {
    config: { baseUrl: 'https://asr.example/v1', apiKey: 'test-key' },
    fetchFn: async (url, init) => {
      assert.equal(String(url), 'https://asr.example/v1/speech_to_text')
      assert.equal(new Headers(init?.headers).get('language'), 'zh')
      assert.equal(new Headers(init?.headers).get('Content-Type'), null)
      const form = init?.body as FormData
      assert.equal(form.get('model'), 'asr-1.0')
      assert.equal(form.get('response_format'), 'verbose_json')
      assert.ok(form.get('file') instanceof Blob)
      return Response.json({ text: ' 做东的来历。\n', duration: 10, trace_id: 'trace-test', segments: [
        { start: 0.1, end: 5, text: '做东的来历。', speaker: 'S1' },
      ] })
    },
  })
  assert.equal(result.trace_id, 'trace-test')
  assert.equal(result.text, '做东的来历。')
  assert.equal(result.segments?.[0]?.end, 5)
})

test('ASR rejects oversized-duration, error envelopes and partial audio responses', async () => {
  const file = await audioFixture()
  const config = { baseUrl: 'https://asr.example', apiKey: 'test-key' }
  await assert.rejects(transcribeHistoryAudio(file, 501, { config }), /500/)
  await assert.rejects(transcribeHistoryAudio(file, 10, {
    config, fetchFn: async () => Response.json({ error: { message: 'no quota' } }, { status: 402 }),
  }), /402: no quota/)
  await assert.rejects(transcribeHistoryAudio(file, 100, {
    config, fetchFn: async () => Response.json({ text: 'incomplete', duration: 10 }),
  }), /incomplete transcription/)
  for (const text of ['', ' \n\t']) await assert.rejects(transcribeHistoryAudio(file, 10, {
    config, fetchFn: async () => Response.json({ text, duration: 10 }),
  }), error => error instanceof EmptyAsrTranscriptionError && /empty transcription/.test(error.message))
})

test('transcript correction cannot claim unsourced history is verified', async () => {
  const review = {
    correctedTranscript: '败北中的北与背有关。', corrections: [],
    factualConcerns: [{ claim: '北与背有关', reason: '需要字书来源', searchQuery: '说文解字 北 背' }],
    factCheckStatus: 'needs_sources',
  }
  const result = await correctHistoryTranscript('败北中的北与背有关。', async () => JSON.stringify(review))
  assert.equal(result.factCheckStatus, 'needs_sources')
  await assert.rejects(correctHistoryTranscript('文本', async () => JSON.stringify({ ...review, factCheckStatus: 'verified' })))
  await assert.rejects(correctHistoryTranscript('文本', async () => 'not json'))
})

test('correction and legacy rewriting preserve complete output regardless of source length ratio', async () => {
  const reference = '史'.repeat(1000)
  for (const body of ['短稿。', '历史正文。'.repeat(1000)]) {
    const corrected = await correctHistoryTranscript(reference, async () => JSON.stringify({
      correctedTranscript: body, corrections: [], factualConcerns: [], factCheckStatus: 'needs_sources',
    }))
    assert.equal(corrected.correctedTranscript, body)
    const rewritten = await rewriteHistoryScript(reference, { fetchFn: async url =>
      String(url).endsWith('/api/v0/models') ? loadedModelResponse() : Response.json({ choices: [{ finish_reason: 'stop', message: { content: body } }] }),
    })
    assert.equal(rewritten, body)
  }
})

test('pre-aborted ASR, review and rewriting do not send provider requests', async () => {
  const controller = new AbortController()
  controller.abort(new Error('User stopped collection'))
  const fetchFn: typeof fetch = async () => { assert.fail('No provider request after stopping'); return Response.json({}) }
  await assert.rejects(transcribeHistoryAudio('/not-needed.wav', 10, { signal: controller.signal, fetchFn }), /User stopped/)
  await assert.rejects(correctHistoryTranscript('A transcript', async () => { assert.fail('No review request'); return '{}' }, { signal: controller.signal }), /User stopped/)
  await assert.rejects(rewriteHistoryScript('A corrected transcript', { signal: controller.signal, fetchFn }), /User stopped/)
})

test('ASR and review receive a live abort signal while a provider is responding', async () => {
  const file = await audioFixture()
  const controller = new AbortController()
  const fetchFn: typeof fetch = async (_url, init) => {
    const signal = init?.signal
    assert.ok(signal)
    controller.abort(new Error('User stopped ASR'))
    signal.throwIfAborted()
    return Response.json({})
  }
  await assert.rejects(transcribeHistoryAudio(file, 10, { config: { baseUrl: 'https://asr.example', apiKey: 'test-only' }, signal: controller.signal, fetchFn }), /User stopped ASR/)
  const reviewController = new AbortController()
  await assert.rejects(correctHistoryTranscript('A transcript', async (_messages, options) => {
    assert.ok(options.signal)
    reviewController.abort(new Error('User stopped review'))
    options.signal.throwIfAborted()
    return '{}'
  }, { signal: reviewController.signal }), /User stopped review/)
})

test('local rewrite uses the exact requested system prompt and model', async () => {
  const rewritten = await rewriteHistoryScript('古人的座次有讲究。', {
    fetchFn: async (url, init) => {
      if (String(url).endsWith('/api/v0/models')) return loadedModelResponse()
      assert.equal(String(url), 'http://127.0.0.1:1234/v1/chat/completions')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, HISTORY_REWRITE_MODEL)
      assert.equal(body.messages[0].content, HISTORY_REWRITE_PROMPT)
      assert.equal(body.messages[1].content, '古人的座次有讲究。')
      assert.equal(body.max_tokens, 6000)
      return Response.json({ choices: [{ message: { content: '古人坐在哪里，可大有讲究。' }, finish_reason: 'stop' }] })
    },
  })
  assert.equal(rewritten, '古人坐在哪里，可大有讲究。')
})

test('rewrite checks the loaded context, not the model training maximum, before generating', async () => {
  let generationCalls = 0
  for (const [context, state] of [[8192, 'loaded'], [16_384, 'not-loaded']] as const) {
    const fetchFn: typeof fetch = async url => {
      if (String(url).endsWith('/api/v0/models')) return loadedModelResponse(context, state)
      generationCalls++
      return Response.json({ choices: [] })
    }
    const status = await inspectHistoryLocalModel({ fetchFn })
    assert.equal(status.loadedContextLength, context)
    assert.equal(status.contextReady, false)
    await assert.rejects(rewriteHistoryScript('历史稿', { fetchFn }), /16384 context tokens/)
  }
  assert.equal(generationCalls, 0)
  assert.equal((await inspectHistoryLocalModel({ fetchFn: async () => loadedModelResponse() })).contextReady, true)
})

test('default local rewrite transport uses an isolated client and closes after a real HTTP response', async () => {
  let requestBody: Record<string, unknown> | undefined
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/v0/models') {
      response.end(JSON.stringify({ data: [{ id: HISTORY_REWRITE_MODEL, state: 'loaded', loaded_context_length: 16_384 }] }))
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    requestBody = JSON.parse(body)
    response.end(JSON.stringify({ choices: [{ message: { content: '古代也存在食品造假。' }, finish_reason: 'stop' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const rewritten = await rewriteHistoryScript('古代有食品造假。', { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` })
    assert.equal(rewritten, '古代也存在食品造假。')
    assert.equal(requestBody?.model, HISTORY_REWRITE_MODEL)
    assert.equal(requestBody?.stream, false)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('canceling a real local HTTP generation releases the rewrite transport promptly', async () => {
  const controller = new AbortController()
  let generationRequests = 0
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/v0/models') {
      response.end(JSON.stringify({ data: [{ id: HISTORY_REWRITE_MODEL, state: 'loaded', loaded_context_length: 16_384 }] }))
    } else {
      generationRequests++
      controller.abort(new Error('Stop local generation'))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(rewriteHistoryScript('A corrected transcript', { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, signal: controller.signal }), /Stop local generation/)
    assert.equal(generationRequests, 1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('rewrite rejects truncated, empty or remote responses', async () => {
  await assert.rejects(rewriteHistoryScript('文本', { baseUrl: 'https://external.example/v1' }), /local LM Studio/)
  await assert.rejects(rewriteHistoryScript('文本', {
    fetchFn: async url => String(url).endsWith('/api/v0/models') ? loadedModelResponse() : Response.json({ choices: [{ message: { content: '部分稿件' }, finish_reason: 'length' }] }),
  }), /truncated/)
  await assert.rejects(rewriteHistoryScript('文本', {
    fetchFn: async url => String(url).endsWith('/api/v0/models') ? loadedModelResponse() : Response.json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
  }), /no rewritten script/)
})
