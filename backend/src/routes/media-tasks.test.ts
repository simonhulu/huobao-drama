import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-media-routes-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { getTask } = await import('../services/tasks/store.js')
const { default: imagesRoute } = await import('./images.js')
const { default: videosRoute } = await import('./videos.js')
const { default: storyboardsRoute } = await import('./storyboards.js')
const { default: charactersRoute } = await import('./characters.js')

const { default: gridRoute } = await import('./grid.js')

function insertConfig(serviceType: string, provider = 'openai-compatible') {
  const ts = now()
  return Number(db.insert(schema.aiServiceConfigs).values({
    serviceType,
    provider,
    name: `${serviceType} config`,
    baseUrl: 'https://example.test',
    apiKey: 'test-key',
    model: JSON.stringify([`${serviceType}-model`]),
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function insertEpisode() {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    imageConfigId: insertConfig('image'),
    videoConfigId: insertConfig('video'),
    audioConfigId: insertConfig('audio', 'minimax'),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  return { dramaId, episodeId, ts }
}

test('POST /images creates image.generate task and keeps generation status queryable', async () => {
  const { dramaId } = insertEpisode()

  const response = await imagesRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drama_id: dramaId,
      prompt: 'image prompt',
      frame_type: 'first_frame',
    }),
  })

  assert.equal(response.status, 201)
  const json = await response.json()
  assert.equal(typeof json.data.id, 'number')
  assert.equal(typeof json.data.task_id, 'number')
  assert.equal(json.data.status, 'pending')
  const task = getTask(json.data.task_id)
  assert.equal(task?.type, 'image.generate')
  assert.equal(task?.payload?.frame_type, 'first_frame')
})

test('POST /videos creates video.generate task and keeps generation status queryable', async () => {
  const { dramaId } = insertEpisode()

  const response = await videosRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drama_id: dramaId,
      prompt: 'video prompt',
    }),
  })

  assert.equal(response.status, 201)
  const json = await response.json()
  assert.equal(typeof json.data.task_id, 'number')
  assert.equal(json.data.status, 'pending')
  assert.equal(getTask(json.data.task_id)?.type, 'video.generate')
})

test('POST /storyboards/:id/generate-tts creates tts.storyboard task', async () => {
  const { dramaId, episodeId, ts } = insertEpisode()
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    dialogue: '角色：你好',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const response = await storyboardsRoute.request(`/${storyboardId}/generate-tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })

  assert.equal(response.status, 200)
  const json = await response.json()
  assert.equal(typeof json.data.task_id, 'number')
  assert.equal(json.data.status, 'queued')
  const task = getTask(json.data.task_id)
  assert.equal(task?.type, 'tts.storyboard')
  assert.equal(task?.dramaId, dramaId)
  assert.equal(task?.episodeId, episodeId)
})

test('POST /characters/:id/generate-voice-sample creates tts.character_sample task', async () => {
  const { dramaId, episodeId, ts } = insertEpisode()
  const characterId = Number(db.insert(schema.characters).values({
    dramaId,
    name: '角色',
    voiceStyle: 'voice-1',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const response = await charactersRoute.request(`/${characterId}/generate-voice-sample`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episode_id: episodeId }),
  })

  assert.equal(response.status, 200)
  const json = await response.json()
  assert.equal(typeof json.data.task_id, 'number')
  assert.equal(json.data.status, 'queued')
  assert.equal(getTask(json.data.task_id)?.type, 'tts.character_sample')
})

import { eq } from 'drizzle-orm'

test('POST /images with storyboard_id derives seed and style consistency from characters/scene', async () => {
  const { dramaId, episodeId, ts } = insertEpisode()
  db.update(schema.dramas).set({ style: 'film noir' }).where(eq(schema.dramas.id, dramaId)).run()

  const characterId = Number(db.insert(schema.characters).values({
    dramaId,
    name: 'Hero',
    appearance: 'black coat, red tie',
    seed: 12345,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const sceneId = Number(db.insert(schema.scenes).values({
    dramaId,
    episodeId,
    location: 'rainy street',
    time: 'night',
    prompt: 'rainy street at night',
    seed: 67890,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    sceneId,
    title: 'Opening shot',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
  db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).run()
  db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).run()

  const response = await imagesRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storyboard_id: storyboardId,
      drama_id: dramaId,
      prompt: 'a cinematic frame',
    }),
  })

  assert.equal(response.status, 201)
  const json = await response.json()
  const genId = getTask(json.data.task_id)?.payload?.image_generation_id ?? json.data.image_generation_id
  const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()

  assert.ok(typeof record.seed === 'number')
  assert.notEqual(record.seed, 12345 ^ 67890)
  assert.ok(record.prompt?.includes('保持角色Hero形象一致'))
  assert.ok(record.prompt?.startsWith('film noir style'))
  assert.equal(record.style, 'film noir')
})

test('POST /grid/generate derives combined seed and style consistency suffix', async () => {
  const { dramaId, episodeId, ts } = insertEpisode()
  db.update(schema.dramas).set({ style: 'anime' }).where(eq(schema.dramas.id, dramaId)).run()

  const characterId = Number(db.insert(schema.characters).values({
    dramaId,
    name: 'Sidekick',
    appearance: 'blue hair',
    seed: 11111,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const sceneId = Number(db.insert(schema.scenes).values({
    dramaId,
    episodeId,
    location: 'rooftop',
    time: 'sunset',
    prompt: 'rooftop at sunset',
    seed: 22222,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    sceneId,
    title: 'Rooftop',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
  db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).run()
  db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).run()

  const response = await gridRoute.request('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storyboard_ids: [storyboardId],
      drama_id: dramaId,
      rows: 1,
      cols: 2,
      mode: 'first_frame',
    }),
  })

  assert.equal(response.status, 200)
  const json = await response.json()
  const genId = json.data.image_generation_id
  const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, genId)).all()

  assert.ok(typeof record.seed === 'number')
  assert.notEqual(record.seed, 11111 ^ 22222)
  assert.ok(record.prompt?.includes('保持角色Sidekick形象一致'))
  assert.ok(record.prompt?.includes('anime style'))
  assert.equal(record.style, 'anime')
})
