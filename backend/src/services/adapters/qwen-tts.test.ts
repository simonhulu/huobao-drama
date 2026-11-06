import test from 'node:test'
import assert from 'node:assert/strict'
import { getTTSAdapter } from './registry.js'

const config = { provider: 'qwen-tts', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'test-key',
  model: 'qwen-audio-3.1-tts-flash', settings: { instruction: '请用中文自然讲述，转折处加强情绪。' } }

test('cloud Qwen TTS uses the native API, model, provider voice and expressive instruction', () => {
  const adapter = getTTSAdapter(config.provider)
  assert.equal(adapter.provider, 'qwen-tts')
  const request = adapter.buildGenerateRequest(config, { text: '历史正文。', voice: 'longanhuan_v3.1', speed: 1.15 })
  assert.equal(request.url, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(request.body, { model: config.model, input: {
    text: '历史正文。', voice: 'longanhuan_v3.1', format: 'wav', sample_rate: 24000, rate: 1.15,
    instruction: config.settings.instruction,
  } })
  const workspace = adapter.buildGenerateRequest({ ...config, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/' },
    { text: '正文。', voice: 'longanhuan_v3.1', instruction: '请用中文表达悬念。' })
  assert.equal(workspace.url, 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer')
  assert.equal(workspace.body.input.instruction, '请用中文表达悬念。')
})

test('cloud Qwen TTS refuses MiniMax voices, incompatible cloned target models and invalid rates', () => {
  const adapter = getTTSAdapter(config.provider)
  for (const voice of ['ttv-voice-minimax', 'Chinese_deep_voiced_male_nv1', 'male-qn-qingse', 'qwen3-north-tense-narrator']) {
    assert.throws(() => adapter.buildGenerateRequest(config, { text: '正文。', voice }), /音色|voice/i)
  }
  assert.throws(() => adapter.buildGenerateRequest(config, { text: '正文。', voice: 'longanhuan_v3.1', model: 'speech-2.8-hd' }), /model|模型/i)
  for (const speed of [0.4, 2.1, NaN]) assert.throws(() => adapter.buildGenerateRequest(config,
    { text: '正文。', voice: 'longanhuan_v3.1', speed }), /rate|语速/i)
})

test('cloud Qwen TTS downloads the complete signed audio without forwarding its API key', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const audio = Buffer.from('test audio bytes')
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://result.example/audio.wav')
    assert.equal(new Headers(init?.headers).get('Authorization'), null)
    assert.ok(init?.signal)
    return new Response(audio)
  }
  const result = await getTTSAdapter(config.provider).parseResponse({ output: {
    finish_reason: 'stop', audio: { url: 'https://result.example/audio.wav' },
  }, request_id: 'trace-1' }, config)
  assert.equal(result.audioHex, audio.toString('hex'))
  assert.equal(result.format, 'wav')
  assert.deepEqual(result.titles, [])
  await assert.rejects(getTTSAdapter(config.provider).parseResponse({ code: 'InvalidApiKey', message: 'invalid key' }, config), /invalid key/)
  await assert.rejects(getTTSAdapter(config.provider).parseResponse({ output: { finish_reason: 'length', audio: { url: 'https://result.example/audio.wav' } } }, config), /完整|complete/i)
})
