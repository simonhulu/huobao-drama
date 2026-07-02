import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-image-sync-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { eq } = await import('drizzle-orm')
const { db, schema } = await import('../../db/index.js')
const { createTask, transitionTask, scheduleTaskRetry } = await import('./store.js')
const { syncImageGenerationTaskState, reconcileImageGenerationState } = await import('../image-generation-sync.js')
const { now } = await import('../../utils/response.js')

function createCharacter(dramaId: number, name: string) {
  const result = db.insert(schema.characters).values({
    dramaId,
    name,
    createdAt: now(),
    updatedAt: now(),
  }).run()
  return Number(result.lastInsertRowid)
}

function createScene(dramaId: number, episodeId: number, location: string, time: string, prompt: string) {
  const result = db.insert(schema.scenes).values({
    dramaId,
    episodeId,
    location,
    time,
    prompt,
    createdAt: now(),
    updatedAt: now(),
  }).run()
  return Number(result.lastInsertRowid)
}

function createStoryboard(episodeId: number) {
  const result = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    createdAt: now(),
    updatedAt: now(),
  }).run()
  return Number(result.lastInsertRowid)
}

function createImageGeneration(overrides: {
  storyboardId?: number
  characterId?: number
  sceneId?: number
  frameType?: string
  status?: string
} = {}) {
  const result = db.insert(schema.imageGenerations).values({
    storyboardId: overrides.storyboardId ?? null,
    characterId: overrides.characterId ?? null,
    sceneId: overrides.sceneId ?? null,
    frameType: overrides.frameType ?? null,
    prompt: 'test prompt',
    status: overrides.status ?? 'processing',
    createdAt: now(),
    updatedAt: now(),
  }).run()
  return Number(result.lastInsertRowid)
}

function loadImageGeneration(id: number) {
  const [row] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).all()
  return row
}

function loadStoryboard(id: number) {
  const [row] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  return row
}

function loadCharacter(id: number) {
  const [row] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  return row
}

function loadScene(id: number) {
  const [row] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  return row
}

function resetTables() {
  db.delete(schema.imageGenerations).run()
  db.delete(schema.creationTasks).run()
  db.delete(schema.creationTaskEvents).run()
  db.delete(schema.storyboards).run()
  db.delete(schema.scenes).run()
  db.delete(schema.characters).run()
}

test('syncImageGenerationTaskState updates related tables on succeeded', () => {
  resetTables()
  const characterId = createCharacter(1, 'Hero')
  const sceneId = createScene(1, 1, 'Street', 'Day', 'city street')
  const storyboardId = createStoryboard(1)
  const generationId = createImageGeneration({ storyboardId, characterId, sceneId, frameType: 'first_frame' })

  const task = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 1,
    scopeType: 'storyboard',
    scopeId: storyboardId,
    payload: { image_generation_id: generationId },
  })

  transitionTask(task.id, 'succeeded', {
    result: { image_generation_id: generationId, local_path: 'images/test.png', image_url: 'http://example.com/test.png' },
    sync: (tx, updatedTask) => syncImageGenerationTaskState(tx, updatedTask),
  })

  const record = loadImageGeneration(generationId)
  assert.equal(record?.status, 'completed')
  assert.equal(record?.localPath, 'images/test.png')
  assert.equal(record?.imageUrl, 'http://example.com/test.png')

  const storyboard = loadStoryboard(storyboardId)
  assert.equal(storyboard?.firstFrameImage, 'images/test.png')

  const character = loadCharacter(characterId)
  assert.equal(character?.imageUrl, 'images/test.png')

  const scene = loadScene(sceneId)
  assert.equal(scene?.imageUrl, 'images/test.png')
  assert.equal(scene?.status, 'completed')
})

test('syncImageGenerationTaskState marks failed on terminal failure', () => {
  resetTables()
  const generationId = createImageGeneration()
  const task = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 1,
    payload: { image_generation_id: generationId },
  })

  transitionTask(task.id, 'failed', {
    errorCode: 'provider_timeout',
    errorMessage: 'Provider timed out',
    sync: (tx, updatedTask) => syncImageGenerationTaskState(tx, updatedTask),
  })

  const record = loadImageGeneration(generationId)
  assert.equal(record?.status, 'failed')
  assert.equal(record?.errorMsg, 'Provider timed out')
  assert.equal(record?.lastErrorCode, 'provider_timeout')
})

test('syncImageGenerationTaskState marks canceled', () => {
  resetTables()
  const generationId = createImageGeneration()
  const task = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 1,
    payload: { image_generation_id: generationId },
  })

  transitionTask(task.id, 'canceled', {
    sync: (tx, updatedTask) => syncImageGenerationTaskState(tx, updatedTask),
  })

  const record = loadImageGeneration(generationId)
  assert.equal(record?.status, 'canceled')
})

test('syncImageGenerationTaskState resets to processing on retry', () => {
  resetTables()
  const generationId = createImageGeneration({ status: 'failed' })
  const task = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 1,
    payload: { image_generation_id: generationId },
  })

  transitionTask(task.id, 'running')
  scheduleTaskRetry(task.id, new Error('rate limited'), 'rate_limited', new Date(Date.now() + 5000).toISOString(), (tx, updatedTask) => {
    syncImageGenerationTaskState(tx, updatedTask)
  })

  const record = loadImageGeneration(generationId)
  assert.equal(record?.status, 'processing')
  assert.equal(record?.lastErrorCode, 'rate_limited')
})

test('reconcileImageGenerationState backfills from succeeded task', () => {
  resetTables()
  const storyboardId = createStoryboard(1)
  const generationId = createImageGeneration({ storyboardId, status: 'processing' })
  const task = createTask({
    type: 'image.generate',
    dramaId: 1,
    episodeId: 1,
    payload: { image_generation_id: generationId },
  })

  transitionTask(task.id, 'succeeded', {
    result: { image_generation_id: generationId, local_path: 'images/reconciled.png' },
  })

  const result = reconcileImageGenerationState()
  assert.equal(result.processed, 1)
  assert.equal(result.updated, 1)

  const record = loadImageGeneration(generationId)
  assert.equal(record?.status, 'completed')
  assert.equal(record?.localPath, 'images/reconciled.png')

  const storyboard = loadStoryboard(storyboardId)
  assert.equal(storyboard?.composedImage, 'images/reconciled.png')
})

test('reconcileImageGenerationState marks orphan processing records as failed', () => {
  resetTables()
  const generationId = createImageGeneration({ status: 'processing' })

  const result = reconcileImageGenerationState()
  assert.equal(result.processed, 1)
  assert.equal(result.updated, 1)

  const record = loadImageGeneration(generationId)
  assert.equal(record?.status, 'failed')
  assert.equal(record?.errorMsg, 'No associated task found')
})
