import test from 'node:test'
import assert from 'node:assert/strict'
import { GptImage2Adapter } from './gpt-image2.js'
import { getImageAdapter } from './registry.js'
import type { AIConfig, ImageGenerationRecord } from './types.js'

const adapter = new GptImage2Adapter()
const config: AIConfig = {
  provider: 'gpt-image2',
  baseUrl: 'https://pcore.ai',
  apiKey: 'test-key',
  model: 'gpt-image-2',
  settings: JSON.stringify({ quality: 'high' }),
}
const record: ImageGenerationRecord = {
  id: 1,
  model: 'gpt-image-2',
  prompt: 'cinematic historical frame',
  size: '1920x1080',
  referenceImages: JSON.stringify(['data:image/png;base64,AAAA']),
}

test('builds the documented async GPT Image 2 generation request', () => {
  const request = adapter.buildGenerateRequest(config, record)
  assert.equal(request.url, 'https://pcore.ai/v1/images/generations')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(request.body, {
    async: true,
    model: 'gpt-image-2',
    prompt: 'cinematic historical frame',
    n: 1,
    size: '16:9',
    quality: 'high',
    images: ['data:image/png;base64,AAAA'],
  })
})

test('forces async submission even when stale config settings request sync mode', () => {
  const request = adapter.buildGenerateRequest({ ...config, settings: JSON.stringify({ async: false }) }, record)
  assert.equal(request.body.async, true)
})

test('keeps exact dimensions for tiered models', () => {
  const request = adapter.buildGenerateRequest({ ...config, model: 'gpt-image-2-1k' }, {
    ...record,
    model: 'gpt-image-2-1k',
    size: '1024x1024',
  })
  assert.equal(request.body.size, '1024x1024')
})

test('parses async submission and same-resource polling', () => {
  assert.deepEqual(adapter.parseGenerateResponse({
    id: 'task_img_123',
    status: 'queued',
    object: 'image.generation',
  }), { isAsync: true, taskId: 'task_img_123' })
  assert.equal(adapter.buildPollRequest(config, 'task_img_123').url, 'https://pcore.ai/v1/images/generations/task_img_123')
})

test('rejects synchronous image responses instead of bypassing the task queue', () => {
  assert.throws(
    () => adapter.parseGenerateResponse({ data: [{ b64_json: 'iVBORw0KGgo=' }] }),
    /synchronous image response; async task id is required/,
  )
})

test('parses completed and failed task responses', () => {
  assert.deepEqual(adapter.parsePollResponse({
    id: 'task_img_123',
    status: 'completed',
    data: [{ url: 'https://cdn.example.com/result.png' }],
  }), { status: 'completed', imageUrl: 'https://cdn.example.com/result.png' })
  assert.deepEqual(adapter.parsePollResponse({
    status: 'failed',
    error: { message: 'invalid prompt' },
  }), { status: 'failed', error: 'invalid prompt' })
})

test('registry selects GPT Image 2 adapter for canonical aliases', () => {
  assert.equal(getImageAdapter(config).provider, 'gpt-image2')
  assert.equal(getImageAdapter({ ...config, provider: 'pcore' }).provider, 'gpt-image2')
})
