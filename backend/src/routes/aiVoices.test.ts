import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-ai-voices-'))
process.env.DB_PATH = join(dbDir, 'test.db')
process.env.STORAGE_PATH = join(dbDir, 'static')
process.env.TTS_GENERATION_INTERVAL_MS = '1'

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { default: aiVoicesRoute } = await import('./aiVoices.js')

const originalFetch = global.fetch
const configId = Number(db.insert(schema.aiServiceConfigs).values({
  serviceType: 'audio',
  provider: 'minimax',
  name: 'MiniMax test',
  baseUrl: 'https://api.minimaxi.com',
  apiKey: 'test-key',
  model: JSON.stringify(['speech-2.8-turbo']),
  isActive: true,
  createdAt: now(),
  updatedAt: now(),
}).run().lastInsertRowid)

test.after(() => {
  global.fetch = originalFetch
})

test('voice preview returns playable local audio through one synchronous request and reuses it across callers', async t => {
  const audio = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25', '-f', 'mp3', 'pipe:1'])
  let submissions = 0
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    submissions++
    assert.equal(String(input), 'https://api.minimaxi.com/v1/t2a_v2')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.voice_setting.voice_id, 'preview-reference')
    assert.equal(body.stream, false)
    return Response.json({ data: { audio: audio.toString('hex'), status: 2 }, base_resp: { status_code: 0 } })
  })
  const preview = () => aiVoicesRoute.request('/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id: configId, voice_id: 'preview-reference', text: '参考音色试听。' }) })
  const [first, second] = await Promise.all([preview(), preview()])
  assert.equal(first.status, 200, await first.clone().text())
  assert.equal(second.status, 200, await second.clone().text())
  const { data } = await first.json() as any
  assert.equal((await second.json() as any).data.audio_url, data.audio_url)
  assert.equal(submissions, 1)
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1',
    join(process.env.STORAGE_PATH!, data.audio_url.replace(/^\/?static\//, ''))], { encoding: 'utf8' }))
  assert.ok(duration > 0)
  assert.equal((await preview()).status, 200)
  assert.equal(submissions, 1, 'Later requests reuse the persisted preview instead of paying again')
})

test('failed previews expose the provider error and can be retried without falling back to another account', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ base_resp: { status_code: 1008, status_msg: 'voice unavailable test-key' } })
  })
  const request = (config_id = configId) => aiVoicesRoute.request('/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id, voice_id: 'unavailable-voice' }) })
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request()
    assert.equal(response.status, 400)
    const body = await response.text()
    assert.match(body, /1008|voice unavailable/)
    assert.equal(body.includes('test-key'), false)
  }
  assert.equal(calls, 2)
  const invalid = await request(90000)
  assert.equal(invalid.status, 400)
  assert.equal(calls, 2, 'An invalid selected configuration must not use a different account')
})

test('a stalled synchronous preview times out explicitly and releases the same voice for retry', async t => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    if (ms !== 60_000) return originalTimeout(ms)
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 15)
    return controller.signal
  })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (++calls > 1) return Response.json({ base_resp: { status_code: 1008, status_msg: 'voice unavailable' } })
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    })
  })
  const request = () => aiVoicesRoute.request('/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id: configId, voice_id: 'stalled-preview' }) })
  const stalled = await request()
  assert.equal(stalled.status, 400)
  assert.match(await stalled.text(), /试听生成超时.*60 秒/)
  const retried = await request()
  assert.equal(retried.status, 400)
  assert.match(await retried.text(), /voice unavailable/)
  assert.equal(calls, 2)
})

test('POST /design calls MiniMax Voice Design and persists generated voice', async () => {
  let requestUrl = ''
  let requestBody: any
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      voice_id: 'ttv-voice-test-001',
      trial_audio: '4949',
      base_resp: { status_code: 0, status_msg: 'success' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  const response = await aiVoicesRoute.request('/design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config_id: configId,
      voice_name: '历史纪实男声',
      prompt: '成熟男性，低沉稳厚，标准普通话。',
      preview_text: '这是一段历史旁白。',
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(requestUrl, 'https://api.minimaxi.com/v1/voice_design')
  assert.deepEqual(requestBody, {
    prompt: '成熟男性，低沉稳厚，标准普通话。',
    preview_text: '这是一段历史旁白。',
    aigc_watermark: false,
  })

  const json = await response.json() as any
  assert.equal(json.data.voice_id, 'ttv-voice-test-001')
  assert.equal(json.data.voice_type, 'voice_generation')
  assert.equal(json.data.trial_audio_url, 'data:audio/mpeg;base64,SUk=')

  const [row] = db.select().from(schema.aiVoices).all().filter(v => v.voiceId === 'ttv-voice-test-001')
  assert.equal(row.voiceName, '历史纪实男声')
  assert.equal(row.voiceType, 'voice_generation')
})

test('POST /sync imports all returned voice types without deleting generated voices', async () => {
  const ts = now()
  db.insert(schema.aiVoices).values([
    {
      voiceId: 'old-system',
      voiceName: '旧系统音色',
      description: '[]',
      language: '中文',
      provider: 'minimax',
      voiceType: 'system',
      createdAt: ts,
    },
    {
      voiceId: 'local-generated',
      voiceName: '本地生成音色',
      description: '["保留"]',
      language: '中文',
      provider: 'minimax',
      voiceType: 'voice_generation',
      createdAt: ts,
    },
  ]).run()

  global.fetch = (async () => new Response(JSON.stringify({
    system_voice: [
      { voice_id: 'Chinese (Mandarin)_Reliable_Executive', voice_name: '沉稳高管', description: ['沉稳男性'] },
      { voice_id: 'English_Radio_Host', voice_name: 'English host', description: ['English'] },
    ],
    voice_generation: [
      { voice_id: 'remote-generated', description: ['远端生成音色'], created_time: '2026-07-12' },
    ],
    voice_cloning: [
      { voice_id: 'remote-cloned', description: ['远端复刻音色'], created_time: '2026-07-12' },
    ],
    base_resp: { status_code: 0, status_msg: 'success' },
  }), { status: 200 })) as typeof fetch

  const response = await aiVoicesRoute.request('/sync', { method: 'POST' })
  assert.equal(response.status, 200)
  const json = await response.json() as any
  assert.deepEqual(json.data.counts, { system: 1, voice_generation: 1, voice_cloning: 1 })

  const rows = db.select().from(schema.aiVoices).all()
  assert.equal(rows.some(v => v.voiceId === 'old-system'), false)
  assert.equal(rows.some(v => v.voiceId === 'local-generated'), true)
  assert.equal(rows.find(v => v.voiceId === 'remote-generated')?.voiceType, 'voice_generation')
  assert.equal(rows.find(v => v.voiceId === 'remote-cloned')?.voiceType, 'voice_cloning')
})

test('POST /design returns MiniMax API errors without writing a voice', async () => {
  global.fetch = (async () => new Response(JSON.stringify({
    base_resp: { status_code: 1004, status_msg: 'invalid prompt' },
  }), { status: 200 })) as typeof fetch

  const response = await aiVoicesRoute.request('/design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config_id: configId,
      prompt: 'bad',
      preview_text: '试听',
    }),
  })

  assert.equal(response.status, 400)
  const json = await response.json() as any
  assert.equal(json.message, 'invalid prompt')
  assert.equal(db.select().from(schema.aiVoices).all().some(v => v.voiceId === 'invalid-prompt'), false)
})

test('available voices use the chosen account and keep all languages without stale local voices', async () => {
  let requestUrl = '', auth = '', requestBody: any
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input); auth = (init?.headers as any).Authorization; requestBody = JSON.parse(String(init?.body))
    return Response.json({ system_voice: [
      { voice_id: 'English_Radio_Host', voice_name: 'English host', description: ['English'] },
      { voice_id: 'Chinese (Mandarin)_News_Anchor', voice_name: '新闻女声', description: ['标准普通话'] },
    ], voice_generation: [{ voice_id: 'ttv-voice-test-001', description: [] }], voice_cloning: [],
      base_resp: { status_code: 0 } })
  }) as typeof fetch
  const response = await aiVoicesRoute.request(`/available?config_id=${configId}`)
  assert.equal(response.status, 200)
  const { data } = await response.json() as any
  assert.equal(requestUrl, 'https://api.minimax.cn/v1/get_voice')
  assert.equal(auth, 'Bearer test-key')
  assert.deepEqual(requestBody, { voice_type: 'all' })
  assert.equal(data.config_id, configId)
  assert.deepEqual(data.counts, { system: 2, voice_generation: 1, voice_cloning: 0 })
  assert.equal(data.voices.find((voice: any) => voice.voice_id === 'ttv-voice-test-001').voice_name, '历史纪实男声')
  assert.equal(data.voices.some((voice: any) => voice.voice_id === 'local-generated'), false)
  assert.equal(JSON.stringify(data).includes('test-key'), false)
})

test('voice query errors are explicit and never expose credentials or fall back to local voices', async () => {
  global.fetch = (async () => Response.json({ base_resp: { status_code: 2061, status_msg: 'rejected test-key' } })) as typeof fetch
  const response = await aiVoicesRoute.request(`/available?config_id=${configId}`)
  assert.equal(response.status, 400)
  const text = await response.text()
  assert.match(text, /2061/); assert.equal(text.includes('test-key'), false)
  for (const id of ['', '1.5', '-1', '90000']) {
    assert.equal((await aiVoicesRoute.request(`/available?config_id=${id}`)).status, 400)
  }
})

test('default selection validates remote availability and preserves other configuration settings', async () => {
  const previousId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'audio', provider: 'other', name: 'Previous narration', baseUrl: 'https://example.test',
    apiKey: 'other-key', model: '["test"]', isActive: true, priority: 999,
    settings: JSON.stringify({ useForNarration: true, speed: 1.2 }), createdAt: now(), updatedAt: now(),
  }).run().lastInsertRowid)
  db.update(schema.aiServiceConfigs).set({ settings: JSON.stringify({ pitch: 2 }) }).where(eq(schema.aiServiceConfigs.id, configId)).run()
  global.fetch = (async () => Response.json({ system_voice: [{ voice_id: 'remote-choice', voice_name: '当前账号声音' }],
    base_resp: { status_code: 0 } })) as typeof fetch
  const request = (voice_id: string) => aiVoicesRoute.request('/default', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config_id: configId, voice_id }) })
  assert.equal((await request('local-generated')).status, 400)
  assert.equal((await request('remote-choice')).status, 200)
  const rows = db.select().from(schema.aiServiceConfigs).all()
  assert.deepEqual(JSON.parse(rows.find(row => row.id === configId)!.settings!), { pitch: 2, useForNarration: true, narrationVoiceId: 'remote-choice' })
  assert.deepEqual(JSON.parse(rows.find(row => row.id === previousId)!.settings!), { speed: 1.2, useForNarration: false })
  const { resolveDefaultNarrationVoiceId } = await import('../services/qwen3-voice.js')
  assert.equal(resolveDefaultNarrationVoiceId('minimax'), 'remote-choice')
  const listing = await (await aiVoicesRoute.request(`/available?config_id=${configId}`)).json() as any
  assert.equal(listing.data.default_voice_id, 'remote-choice')
})

test('Qwen available voices belong to the selected account and model and keep saved labels', async () => {
  const model = 'qwen-audio-3.1-tts-flash'
  const voiceId = `${model}-huobao-current`
  const qwenConfigId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'audio', provider: 'qwen-tts', name: 'Qwen cloud', baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com',
    apiKey: 'qwen-selected-key', model: JSON.stringify([model]), isActive: true, createdAt: now(), updatedAt: now(),
  }).run().lastInsertRowid)
  db.insert(schema.aiVoices).values([
    { voiceId, voiceName: '参考视频复刻', provider: 'qwen-tts', voiceType: 'voice_cloning', language: '中文', description: '["有情感的讲述"]', createdAt: now() },
    { voiceId: `${model}-different-account`, voiceName: '另一个账号', provider: 'qwen-tts', voiceType: 'voice_cloning', createdAt: now() },
  ]).run()
  global.fetch = (async (url, init) => {
    assert.equal(String(url), 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer qwen-selected-key')
    const { input } = JSON.parse(String(init?.body))
    if (input.action === 'query_voice') return Response.json({ output: { status: 'OK', target_model: model } })
    assert.equal(input.action, 'list_voice')
    return Response.json({ output: { voice_list: [{ voice_id: voiceId, status: 'OK' },
      { voice_id: 'qwen-audio-3.1-tts-plus-other', status: 'OK' }, { voice_id: `${model}-pending`, status: 'DEPLOYING' }] } })
  }) as typeof fetch
  const response = await aiVoicesRoute.request(`/available?config_id=${qwenConfigId}`)
  assert.equal(response.status, 200, await response.clone().text())
  const { data } = await response.json() as any
  assert.deepEqual(data.voices.map((voice: any) => voice.voice_id), ['longanhuan_v3.1', voiceId])
  assert.equal(data.voices[1].voice_name, '参考视频复刻')
  assert.deepEqual(data.voices[1].description, ['有情感的讲述'])
  assert.ok(data.voices.every((voice: any) => voice.provider === 'qwen-tts'))
  assert.deepEqual(data.counts, { system: 1, voice_generation: 0, voice_cloning: 1 })
})

test('Qwen default selection rejects MiniMax IDs and retains Qwen instructions and existing account settings', async () => {
  const model = 'qwen-audio-3.1-tts-flash', voiceId = `${model}-huobao-default`
  const qwenConfigId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'audio', provider: 'qwen-tts', name: 'Qwen default', baseUrl: 'https://qwen.example/api/v1',
    apiKey: 'qwen-default-key', model: JSON.stringify([model]), isActive: true,
    settings: JSON.stringify({ instruction: '紧张而自然', speed: 1.1 }), createdAt: now(), updatedAt: now(),
  }).run().lastInsertRowid)
  global.fetch = (async (_url, init) => {
    const { input } = JSON.parse(String(init?.body))
    return Response.json({ output: input.action === 'query_voice'
      ? { status: 'OK', target_model: model } : { voice_list: [{ voice_id: voiceId, status: 'OK' }] } })
  }) as typeof fetch
  const request = (voice_id: string) => aiVoicesRoute.request('/default', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config_id: qwenConfigId, voice_id }) })
  assert.equal((await request('remote-choice')).status, 400)
  const selected = await request(voiceId)
  assert.equal(selected.status, 200, await selected.clone().text())
  const rows = db.select().from(schema.aiServiceConfigs).all()
  assert.deepEqual(JSON.parse(rows.find(row => row.id === qwenConfigId)!.settings!), {
    instruction: '紧张而自然', speed: 1.1, useForNarration: true, narrationVoiceId: voiceId,
  })
  assert.equal(JSON.parse(rows.find(row => row.id === configId)!.settings!).useForNarration, false)
  const listing = await (await aiVoicesRoute.request(`/available?config_id=${qwenConfigId}`)).json() as any
  assert.equal(listing.data.default_voice_id, voiceId)
})
