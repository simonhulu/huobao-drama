import test from 'node:test'
import assert from 'node:assert/strict'
import { RightCodeImageAdapter } from './rightcode-image.js'
import { getImageAdapter } from './registry.js'
import type { AIConfig, ImageGenerationRecord } from './types.js'

const adapter = new RightCodeImageAdapter()
const config: AIConfig = {
  provider: 'rightcode',
  baseUrl: 'https://www.right.codes/draw',
  apiKey: 'test-key',
  model: 'gpt-image-2',
  settings: JSON.stringify({ resolution: '2k' }),
}
const record: ImageGenerationRecord = {
  id: 1,
  prompt: 'cinematic historical frame',
  size: '1920x1080',
  referenceImages: JSON.stringify(['data:image/png;base64,AAAA']),
}

test('builds the documented async RightCode Images request', () => {
  const request = adapter.buildGenerateRequest(config, record)
  assert.equal(request.url, 'https://www.right.codes/draw/v1/images/generations')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(request.body, {
    model: 'gpt-image-2',
    prompt: 'cinematic historical frame',
    n: 1,
    size: '16:9',
    imageSize: '2K',
    async: true,
    image: ['data:image/png;base64,AAAA'],
  })
})

test('does not duplicate the draw prefix when base URL is the site root', () => {
  const request = adapter.buildGenerateRequest({ ...config, baseUrl: 'https://www.right.codes' }, record)
  assert.equal(request.url, 'https://www.right.codes/draw/v1/images/generations')
})

test('uses the site-level task endpoint without the draw prefix', () => {
  const request = adapter.buildPollRequest(config, 'task-123')
  assert.equal(request.url, 'https://www.right.codes/v1/tasks/task-123')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
})

test('parses async submission and documented status-only processing response', () => {
  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 'task-123', status: 'processing' }), {
    isAsync: true,
    taskId: 'task-123',
  })
  assert.deepEqual(adapter.parsePollResponse({ task_id: 'task-123', status: 'in_progress', progress: 45 }), {
    status: 'processing',
  })
})

test('treats documented Images result without status as completed', () => {
  assert.deepEqual(adapter.parsePollResponse({
    created: 1782800000,
    data: [{ url: 'https://cdn.example.com/result.png' }],
  }), {
    status: 'completed',
    imageUrl: 'https://cdn.example.com/result.png',
  })
})

test('supports base64 task results described by the RightCode overview', () => {
  assert.deepEqual(adapter.parsePollResponse({
    data: [{ b64_json: 'AAAA', output_format: 'webp' }],
  }), {
    status: 'completed',
    imageBase64: 'AAAA',
    mimeType: 'image/webp',
  })
})

test('parses documented failed task details', () => {
  assert.deepEqual(adapter.parsePollResponse({
    task_id: 'task-123',
    status: 'failed',
    error: { message: 'upstream failed', code: '' },
  }), {
    status: 'failed',
    error: 'upstream failed',
  })
})

test('treats delayed task registration as transient pending state', () => {
  assert.deepEqual(adapter.parsePollResponse({
    status: 'failed',
    error: { message: 'No associated task found' },
  }), { status: 'pending' })
})

test('registry selects built-in RightCode adapter over legacy configurable settings', () => {
  assert.equal(getImageAdapter(config).provider, 'rightcode')
})
