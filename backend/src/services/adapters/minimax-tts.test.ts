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
