import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-images-route-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { default: route } = await import('./images.js')
const { getTask } = await import('../services/tasks/store.js')

test('POST /images uses storyboard episode aspect ratio over request aspect ratio', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Portrait Drama',
    status: 'draft',
    style: 'cinematic',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image',
    provider: 'apimart',
    name: 'APIMart image',
    baseUrl: 'https://api.apimart.ai',
    apiKey: 'test-key',
    model: JSON.stringify(['gpt-image-2']),
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Portrait Episode',
    aspectRatio: '9:16',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '羊汤重逢',
    imagePrompt: '横屏16:9宽银幕北方小羊汤馆傍晚，赵磊坐在塑料凳上。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const res = await route.request('/', {
    method: 'POST',
    body: JSON.stringify({
      storyboard_id: storyboardId,
      drama_id: dramaId,
      prompt: '前端传入的横屏 prompt',
      aspect_ratio: '16:9',
    }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()

  assert.equal(res.status, 201)
  const generationId = Number(json.data.id)
  const [record] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, generationId))
    .all()

  assert.equal(record.size, '1080x1920')
  assert.equal(record.style, 'cinematic')
  assert.match(record.prompt || '', /^cinematic film still/)
  assert.match(record.prompt || '', /竖屏9:16/)
  assert.doesNotMatch(record.prompt || '', /横屏|宽银幕/)
})

test('POST /images stores an explicitly configured model and style', async () => {
  const ts = now()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image',
    provider: 'pcore',
    name: 'pcore GPT Image 2',
    baseUrl: 'https://pcore.ai',
    apiKey: 'test-key',
    model: JSON.stringify(['gpt-image-2', 'gpt-image-2-1k']),
    priority: 100,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const res = await route.request('/', {
    method: 'POST',
    body: JSON.stringify({
      prompt: '清晰的复古动画家庭场景',
      config_id: configId,
      model: 'gpt-image-2-1k',
      style: 'retro-anime-1980s',
      aspect_ratio: '16:9',
      frame_type: 'images-route-model-test',
    }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()

  assert.equal(res.status, 201)
  const [record] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, Number(json.data.id)))
    .all()

  assert.equal(record.model, 'gpt-image-2-1k')
  assert.equal(record.style, 'retro-anime-1980s')
  assert.equal(record.size, '1280x720')
})

test('POST /images rejects a model outside the selected config allowlist', async () => {
  const ts = now()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image',
    provider: 'pcore',
    name: 'pcore 1K only',
    baseUrl: 'https://pcore.ai',
    apiKey: 'test-key',
    model: JSON.stringify(['gpt-image-2-1k']),
    priority: 100,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const res = await route.request('/', {
    method: 'POST',
    body: JSON.stringify({
      prompt: '不应进入生成队列',
      config_id: configId,
      model: 'gpt-image-2-2k',
      aspect_ratio: '16:9',
      frame_type: 'images-route-model-rejection-test',
    }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()

  assert.equal(res.status, 400)
  assert.match(json.message || json.error || '', /not configured/)
})

test('POST /images reuses the active task and image generation for duplicate idempotency keys', async () => {
  const ts = now()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image',
    provider: 'apimart',
    name: 'APIMart duplicate route image',
    baseUrl: 'https://api.apimart.ai',
    apiKey: 'test-key',
    model: JSON.stringify(['gpt-image-2']),
    priority: 200,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const body = {
    prompt: '同一个全局图片任务只应入队一次',
    drama_id: 88_001,
    aspect_ratio: '16:9',
    frame_type: 'route-idempotency-race',
  }

  const [firstRes, secondRes] = await Promise.all([
    route.request('/', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    route.request('/', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  ])
  const first = await firstRes.json()
  const second = await secondRes.json()

  assert.equal(firstRes.status, 201)
  assert.equal(secondRes.status, 201)
  assert.equal(second.data.task_id, first.data.task_id)
  assert.equal(second.data.id, first.data.id)

  const generations = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.frameType, 'route-idempotency-race'))
    .all()
  assert.equal(generations.length, 1)
  assert.equal(generations[0].id, first.data.id)
})

test('POST /images persists synchronous-image compatibility only when explicitly requested', async () => {
  const ts = now()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'gpt-image2', name: 'Synchronous-compatible image config',
    baseUrl: 'https://sync-image.example.test', apiKey: 'test-key', model: JSON.stringify(['gpt-image-2']),
    isActive: true, createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  for (const optIn of [undefined, false, true]) {
    const res = await route.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Cover background', config_id: configId,
        frame_type: `sync-compatibility-${String(optIn)}`, allow_synchronous_image: optIn }),
    })
    assert.equal(res.status, 201)
    const result = await res.json()
    assert.equal(getTask(result.data.task_id)?.payload.allow_synchronous_image, optIn === true)
  }
  const invalid = await route.request('/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Cover background', config_id: configId, allow_synchronous_image: 'true' }),
  })
  assert.equal(invalid.status, 400)
})

test('POST /images persists single-submission policy and one queue attempt only when explicitly requested', async () => {
  for (const optIn of [undefined, false, true]) {
    const res = await route.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Single submission cover',
        frame_type: `single-submission-${String(optIn)}`, single_image_submission: optIn }),
    })
    assert.equal(res.status, 201)
    const result = await res.json()
    const task = getTask(result.data.task_id)
    assert.equal(task?.payload.single_image_submission, optIn === true)
    assert.equal(task?.maxAttempts, 1)
  }
  const invalid = await route.request('/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Cover background', single_image_submission: 'true' }),
  })
  assert.equal(invalid.status, 400)
  assert.match(await invalid.text(), /single_image_submission must be a boolean/)
})

test('GET /images/capabilities advertises single-submission support before matching generation IDs', async () => {
  const response = await route.request('/capabilities')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, { single_image_submission: true })
})
