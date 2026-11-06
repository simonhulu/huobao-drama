import test from 'node:test'
import assert from 'node:assert/strict'
import { createQwenVoice, listQwenVoices, queryQwenVoice, waitForQwenVoice } from './qwen-tts-voices.js'

const model = 'qwen-audio-3.1-tts-flash'
const config = { provider: 'qwen-tts', model, apiKey: 'qwen-test-key', baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com' }
const voiceId = `${model}-huobao-unique`

test('Qwen voice cloning sends the official customization contract once and returns the model-bound voice ID', async () => {
  let calls = 0
  const created = await createQwenVoice(config, { audio: 'data:audio/wav;base64,UklGRg==', prefix: 'huobao',
    languageHints: ['zh'], maxPromptAudioLength: 20, enablePreprocess: true, enableVolumeNormalization: false }, {
    fetchFn: async (url, init) => {
      calls++
      assert.equal(String(url), `${config.baseUrl}/api/v1/services/audio/tts/customization`)
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer qwen-test-key')
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), { model: 'voice-enrollment', input: {
        action: 'create_voice', target_model: model, prefix: 'huobao', audio: 'data:audio/wav;base64,UklGRg==',
        language_hints: ['zh'], max_prompt_audio_length: 20, enable_preprocess: true, enable_volume_normalization: 'false',
      } })
      return Response.json({ output: { voice_id: voiceId } })
    },
  })
  assert.equal(created, voiceId)
  assert.equal(calls, 1)
})

test('invalid cloning parameters never submit a paid or duplicate enrollment', async () => {
  const options = { fetchFn: async () => assert.fail('Invalid parameters must fail before a request') }
  await assert.rejects(createQwenVoice(config, { audio: 'data:audio/wav;base64,UklGRg==', prefix: 'has-dash' }, options), /prefix/)
  await assert.rejects(createQwenVoice(config, { audio: '', prefix: 'huobao' }, options), /audio/)
  await assert.rejects(createQwenVoice(config, { audio: 'https://example.test/audio.wav', prefix: 'huobao', maxPromptAudioLength: 31 }, options), /3.*30/)
})

test('Qwen voice details preserve the native status, resource and target model', async () => {
  const output = { status: 'OK', target_model: model, resource_link: 'https://audio.test/reference.wav', gmt_create: '2026-10-31' }
  const queried = await queryQwenVoice(config, voiceId, { fetchFn: async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: voiceId } })
    return Response.json({ output })
  } })
  assert.deepEqual(queried, output)
})

test('Qwen voice listing paginates and verifies ready voices against the exact target model', async () => {
  const valid = Array.from({ length: 100 }, (_, index) => `${model}-voice-${index}`)
  const queried: string[] = []
  let pages = 0
  const voices = await listQwenVoices(config, { fetchFn: async (_url, init) => {
    const { input } = JSON.parse(String(init?.body))
    if (input.action === 'list_voice') {
      assert.equal(input.page_size, 100)
      assert.equal(input.page_index, pages++)
      return Response.json({ output: { voice_list: input.page_index === 0
        ? valid.map(voice_id => ({ voice_id, status: 'OK' }))
        : [{ voice_id: `${model}-pending`, status: 'DEPLOYING' },
          { voice_id: 'qwen-audio-3.1-tts-plus-other', status: 'OK' }] } })
    }
    assert.equal(input.action, 'query_voice')
    queried.push(input.voice_id)
    return Response.json({ output: { status: 'OK', target_model: input.voice_id === valid[1] ? 'other-model' : model } })
  } })
  assert.equal(pages, 2)
  assert.equal(queried.length, 100)
  assert.equal(voices.length, 99)
  assert.equal(voices[0]!.voice_id, valid[0])
  assert.equal(voices.some(voice => voice.voice_id === valid[1]), false)
})

test('Qwen voice deployment waits for OK and rejects rejected, mismatched and unknown statuses', async () => {
  let calls = 0
  const ready = await waitForQwenVoice(config, voiceId, { pollMs: 0, fetchFn: async () =>
    Response.json({ output: { status: calls++ === 0 ? 'DEPLOYING' : 'OK', target_model: model } }) })
  assert.equal(ready.status, 'OK')
  assert.equal(calls, 2)
  for (const output of [
    { status: 'UNDEPLOYED', target_model: model }, { status: 'UNKNOWN', target_model: model }, { status: 'OK', target_model: 'other-model' },
  ]) {
    await assert.rejects(waitForQwenVoice(config, voiceId, { pollMs: 0, fetchFn: async () => Response.json({ output }) }), /Qwen/)
  }
})

test('Qwen voice errors redact API credentials and do not retry enrollment', async () => {
  let calls = 0
  await assert.rejects(createQwenVoice(config, { audio: 'https://example.test/audio.wav', prefix: 'huobao' }, {
    fetchFn: async () => { calls++; return Response.json({ code: 'InvalidParameter', message: 'bad audio qwen-test-key' }, { status: 400 }) },
  }), error => error instanceof Error && /InvalidParameter/.test(error.message) && !error.message.includes(config.apiKey))
  assert.equal(calls, 1)
  await assert.rejects(queryQwenVoice(config, voiceId, { fetchFn: async () => { throw Error(`network failed ${config.apiKey}`) } }),
    error => error instanceof Error && !error.message.includes(config.apiKey))
})

test('Qwen voice deployment responds to cancellation and an elapsed polling deadline', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(waitForQwenVoice(config, voiceId, { signal: controller.signal,
    fetchFn: async () => assert.fail('Already cancelled requests must not be submitted') }), /cancelled/)
  await assert.rejects(waitForQwenVoice(config, voiceId, { pollMs: 1, timeoutMs: 10,
    fetchFn: async () => Response.json({ output: { status: 'DEPLOYING', target_model: model } }) }), /超时|Timeout/)
})
