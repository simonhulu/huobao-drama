import test from 'node:test'
import assert from 'node:assert/strict'
import { APIMartImageAdapter } from './apimart-image.js'
import { getImageAdapter } from './registry.js'
import type { AIConfig, ImageGenerationRecord } from './types.js'

const adapter = new APIMartImageAdapter()

const config: AIConfig = {
  provider: 'apimart',
  baseUrl: 'https://api.apimart.ai',
  apiKey: 'test-key',
  model: 'gpt-image-2',
  settings: JSON.stringify({ official_fallback: true }),
}

const record: ImageGenerationRecord = {
  id: 1,
  model: 'gpt-image-2',
  prompt: 'cinematic frame',
  size: '1920x1080',
  referenceImages: JSON.stringify(['https://example.com/ref.png']),
  seed: 123,
}

test('APIMart builds GPT-Image-2 generation request from official schema', () => {
  const request = adapter.buildGenerateRequest(config, record)

  assert.equal(request.url, 'https://api.apimart.ai/v1/images/generations')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(request.body, {
    model: 'gpt-image-2',
    prompt: 'cinematic frame',
    size: '16:9',
    resolution: '1k',
    n: 1,
    image_urls: ['https://example.com/ref.png'],
    seed: 123,
    official_fallback: true,
  })
})

test('APIMart normalizes portrait pixel size to aspect ratio', () => {
  const request = adapter.buildGenerateRequest(config, {
    ...record,
    size: '1080x1920',
  })

  assert.equal(request.body.size, '9:16')
  assert.equal(request.body.resolution, '1k')
})

test('APIMart preserves explicit resolution setting', () => {
  const request = adapter.buildGenerateRequest({
    ...config,
    settings: JSON.stringify({ resolution: '2k' }),
  }, record)

  assert.equal(request.body.resolution, '2k')
})

test('APIMart uses documented webhook field as callback base URL', () => {
  const request = adapter.buildGenerateRequest({
    ...config,
    settings: JSON.stringify({
      webhook: 'https://public.example.com/webhooks/apimart/images/callback/',
    }),
  }, record)

  assert.equal(request.body.webhook, 'https://public.example.com/webhooks/apimart/images')
  assert.equal(Object.hasOwn(request.body, 'callback_url'), false)
})

test('APIMart provider uses built-in adapter even when legacy configurable settings exist', () => {
  const selected = getImageAdapter({
    ...config,
    settings: JSON.stringify({
      adapter: {
        request: { url: '/v1/images/generations' },
        response: { imageUrlPath: 'data.0.url' },
      },
    }),
  })

  assert.equal(selected.provider, 'apimart')
})

test('APIMart treats generation response as async task', () => {
  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 'task-123' }), {
    isAsync: true,
    taskId: 'task-123',
  })
})

test('APIMart parses documented generation response data array', () => {
  assert.deepEqual(adapter.parseGenerateResponse({
    code: 200,
    data: [
      {
        status: 'submitted',
        task_id: 'task-array-123',
      },
    ],
  }), {
    isAsync: true,
    taskId: 'task-array-123',
  })
})

test('APIMart builds task poll request', () => {
  const request = adapter.buildPollRequest(config, 'task-123')

  assert.equal(request.url, 'https://api.apimart.ai/v1/tasks/task-123')
  assert.equal(request.method, 'GET')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
})

test('APIMart parses completed task result image URL', () => {
  const response = adapter.parsePollResponse({
    data: {
      status: 'completed',
      result: {
        images: [
          {
            url: ['https://cdn.example.com/image.png'],
          },
        ],
      },
    },
  })

  assert.deepEqual(response, {
    status: 'completed',
    imageUrl: 'https://cdn.example.com/image.png',
  })
})

test('APIMart parses failed task result', () => {
  const response = adapter.parsePollResponse({
    data: {
      status: 'failed',
      error: { message: 'invalid prompt' },
    },
  })

  assert.deepEqual(response, {
    status: 'failed',
    error: 'invalid prompt',
  })
})
