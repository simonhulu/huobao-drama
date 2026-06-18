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
    }),
  })

  assert.equal(response.status, 201)
  const json = await response.json()
  assert.equal(typeof json.data.task_id, 'number')
  assert.equal(json.data.status, 'pending')
  assert.equal(getTask(json.data.task_id)?.type, 'image.generate')
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
  const { episodeId, ts } = insertEpisode()
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
  assert.equal(getTask(json.data.task_id)?.type, 'tts.storyboard')
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
