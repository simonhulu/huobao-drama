import assert from 'node:assert/strict'
import test from 'node:test'
import { MiniMaxTTSAdapter } from './minimax-tts.js'

test('MiniMax TTS lets the model infer emotion when none is requested', () => {
  const request = new MiniMaxTTSAdapter().buildGenerateRequest({
    provider: 'minimax',
    apiKey: 'test-key',
    baseUrl: 'https://api.minimaxi.com',
    model: 'speech-2.8-turbo',
  }, {
    text: '门外的脚步声停了。',
    voice: 'test-voice',
  })

  assert.equal('emotion' in (request.body as any).voice_setting, false)
})

test('MiniMax TTS preserves an explicitly requested emotion', () => {
  const request = new MiniMaxTTSAdapter().buildGenerateRequest({
    provider: 'minimax',
    apiKey: 'test-key',
    baseUrl: 'https://api.minimaxi.com',
    model: 'speech-2.8-turbo',
  }, {
    text: '他终于笑了。',
    voice: 'test-voice',
    emotion: 'happy',
  })

  assert.equal((request.body as any).voice_setting.emotion, 'happy')
})

test('short voice previews use synchronous hex output while production stays asynchronous', async () => {
  const adapter = new MiniMaxTTSAdapter()
  const config = { provider: 'minimax', apiKey: 'test-key', baseUrl: 'https://api.minimaxi.com', model: 'speech-2.8-hd' }
  const request = adapter.buildGenerateRequest(config, { text: '一段试听', voice: 'reference-voice', synchronous: true })
  assert.equal(request.url, 'https://api.minimaxi.com/v1/t2a_v2')
  assert.equal((request.body as any).stream, false)
  assert.equal((request.body as any).output_format, 'hex')
  assert.equal((request.body as any).voice_setting.voice_id, 'reference-voice')
  assert.equal((request.body as any).model, 'speech-2.8-hd')
  assert.equal(adapter.buildGenerateRequest(config, { text: '正式长配音', voice: 'reference-voice' }).url, 'https://api.minimaxi.com/v1/t2a_async_v2')
  const result = await adapter.parseResponse({ data: { audio: '494433', status: 2 },
    extra_info: { audio_length: 1000, audio_sample_rate: 32000, bitrate: 128000, audio_format: 'mp3', audio_channel: 1 },
    base_resp: { status_code: 0 } }, config)
  assert.equal(result.audioHex, '494433')
  assert.equal(result.audioLength, 1000)
  await assert.rejects(() => adapter.parseResponse({ data: { audio: 'not-audio' }, base_resp: { status_code: 0 } }, config), /音频|audio/i)
})
