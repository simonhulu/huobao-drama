import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-auto-pipeline-refs-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../db/index.js')
const { now } = await import('../../utils/response.js')
const { scheduleImageGenerationForEpisode } = await import('./auto-pipeline.js')

function insertConfig(serviceType: string, provider = 'openai-compatible') {
  const ts = now()
  return Number(db.insert(schema.aiServiceConfigs).values({
    serviceType,
    provider,
    name: `${serviceType} config`,
    baseUrl: 'https://example.test',
    apiKey: 'test-key',
    model: JSON.stringify(['test-model']),
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

test('scheduleImageGenerationForEpisode sets reference images from characters and scene', () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Ref Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const imageConfigId = insertConfig('image')
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    imageConfigId,
    aspectRatio: '16:9',
    renderMode: 'image_story',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const sceneId = Number(db.insert(schema.scenes).values({
    dramaId,
    episodeId,
    location: 'Street',
    time: 'night',
    prompt: 'rainy street',
    imageUrl: 'static/images/scene.png',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const charA = Number(db.insert(schema.characters).values({
    dramaId,
    name: 'Hero',
    imageUrl: 'static/images/hero.png',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const charB = Number(db.insert(schema.characters).values({
    dramaId,
    name: 'Sidekick',
    imageUrl: 'static/images/sidekick.png',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    sceneId,
    storyboardNumber: 1,
    title: 'Opening',
    imagePrompt: 'cinematic opening',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.storyboardCharacters).values([
    { storyboardId, characterId: charA },
    { storyboardId, characterId: charB },
  ]).run()

  const result = scheduleImageGenerationForEpisode(dramaId, episodeId)
  assert.ok(result.parentTask, 'should create parent task')
  assert.equal(result.childTasks.length, 1)

  const [imageGen] = db.select()
    .from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.storyboardId, storyboardId))
    .all()

  assert.ok(imageGen, 'image generation record should exist')
  assert.ok(imageGen.referenceImages, 'referenceImages should be set')

  const refs = JSON.parse(imageGen.referenceImages)
  assert.ok(refs.includes('static/images/hero.png'))
  assert.ok(refs.includes('static/images/sidekick.png'))
  assert.ok(refs.includes('static/images/scene.png'))
})
