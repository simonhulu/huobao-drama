import test from 'node:test'
import assert from 'node:assert/strict'
import { MiniMaxMusicAdapter } from './minimax-music.js'
import type { AIConfig, MusicGenerationRecord } from './types.js'

const adapter = new MiniMaxMusicAdapter()

const config: AIConfig = {
  provider: 'minimax',
  baseUrl: 'https://api.minimax.io',
  apiKey: 'test-key',
  model: 'music-2.6',
}

const record: MusicGenerationRecord = {
  id: 1,
  prompt: 'epic orchestral, cinematic, no vocals',
  duration: 30,
  model: 'music-2.6',
}

test('MiniMax Music builds instrumental generation request', () => {
  const request = adapter.buildGenerateRequest(config, record)

  assert.equal(request.url, 'https://api.minimax.io/v1/music_generation')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.equal(request.body.model, 'music-2.6')
  assert.equal(request.body.prompt, record.prompt)
  assert.equal(request.body.is_instrumental, true)
  assert.equal(request.body.output_format, 'url')
  assert.deepEqual(request.body.audio_setting, {
    sample_rate: 44100,
    bitrate: 256000,
    format: 'mp3',
  })
})

test('MiniMax Music parses async task response', () => {
  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 'task-123' }), {
    isAsync: true,
    taskId: 'task-123',
  })
})

test('MiniMax Music parses failed base_resp', () => {
  assert.deepEqual(adapter.parseGenerateResponse({
    base_resp: { status_code: 1001, status_msg: 'bad prompt' },
  }), {
    isAsync: false,
    error: 'bad prompt',
  })
})

test('MiniMax Music builds poll request', () => {
  const request = adapter.buildPollRequest(config, 'task-123')
  assert.equal(request.url, 'https://api.minimax.io/v1/query/music_generation?task_id=task-123')
  assert.equal(request.method, 'GET')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
})

test('MiniMax Music parses completed poll with file_id', () => {
  const result = adapter.parsePollResponse({
    task_id: 'task-123',
    status: 'Success',
    file_id: 'file-456',
    base_resp: { status_code: 0, status_msg: 'success' },
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.fileId, 'file-456')
})

test('MiniMax Music parses failed poll', () => {
  const result = adapter.parsePollResponse({
    task_id: 'task-123',
    status: 'Fail',
    error_msg: 'generation failed',
    base_resp: { status_code: 0, status_msg: 'success' },
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'generation failed')
})

test('MiniMax Music builds file retrieve request', () => {
  const request = adapter.buildFileRetrieveRequest(config, 'file-456')
  assert.equal(request.url, 'https://api.minimax.io/v1/files/retrieve?file_id=file-456')
  assert.equal(request.method, 'GET')
})

test('MiniMax Music parses file retrieve response', () => {
  const result = adapter.parseFileRetrieveResponse({
    file: {
      file_id: 'file-456',
      download_url: 'https://cdn.example.com/music.mp3',
    },
    base_resp: { status_code: 0, status_msg: 'success' },
  })
  assert.equal(result.audioUrl, 'https://cdn.example.com/music.mp3')
})
