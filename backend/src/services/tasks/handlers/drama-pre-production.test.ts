import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-drama-pre-prod-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { createTask, getTask, listTasks } = await import('../store.js')
const { db, schema } = await import('../../../db/index.js')
const { createDramaPreProductionHandler } = await import('./drama-pre-production.js')

function createContext(taskId: number, signal = new AbortController().signal, payload: any = { drama_id: 1 }) {
  return {
    taskId,
    payload,
    signal,
    attempts: 1,
    progress() {},
    event() {},
    isCancelRequested() { return false },
  }
}

test('drama.pre_production extracts, assigns voices, and schedules image/sample tasks', async () => {
  const ts = new Date().toISOString()

  db.insert(schema.dramas).values({
    id: 1,
    title: 'Test Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  db.insert(schema.episodes).values([
    { id: 1, dramaId: 1, episodeNumber: 1, title: 'E1', content: 'episode one content', dialogueMode: 'dialogue', createdAt: ts, updatedAt: ts },
    { id: 2, dramaId: 1, episodeNumber: 2, title: 'E2', content: 'episode two content', dialogueMode: 'dialogue', createdAt: ts, updatedAt: ts },
  ]).run()

  // 预置一个已有形象、已有样本的角色
  db.insert(schema.characters).values({
    id: 1, dramaId: 1, name: 'Hero', voiceStyle: 'voice-a', voiceSampleUrl: 'http://sample/1.mp3',
    imageUrl: 'static/images/hero.png', createdAt: ts, updatedAt: ts,
  }).run()
  // 预置一个无形象、无样本的角色
  db.insert(schema.characters).values({
    id: 2, dramaId: 1, name: 'Villain', voiceStyle: 'voice-b', createdAt: ts, updatedAt: ts,
  }).run()
  // 预置一个无形象、无音色的角色
  db.insert(schema.characters).values({
    id: 3, dramaId: 1, name: 'Extra', createdAt: ts, updatedAt: ts,
  }).run()

  // 预置一个无形象的场景
  db.insert(schema.scenes).values({
    id: 1, dramaId: 1, location: 'Street', time: 'night', prompt: 'rainy street', createdAt: ts, updatedAt: ts,
  }).run()

  let extractCount = 0
  let voiceAssignCount = 0
  const imageRecords: Array<{ characterId?: number; sceneId?: number; dramaId?: number; size?: string }> = []

  const handler = createDramaPreProductionHandler({
    createAgent: (type: string, episodeId: number, dramaId: number) => ({
      generate: async (_messages: any[], options: any) => {
        assert.equal(dramaId, 1)
        if (type === 'extractor') {
          extractCount++
          assert.ok([1, 2].includes(episodeId))
        } else if (type === 'voice_assigner') {
          voiceAssignCount++
          assert.equal(episodeId, 1)
        } else {
          assert.fail(`unexpected agent type: ${type}`)
        }
        return { text: 'done', toolCalls: [], toolResults: [] }
      },
    }),
    createImageGenerationRecord: (params: any) => {
      imageRecords.push(params)
      return 1000 + (params.characterId || params.sceneId || 0)
    },
  })

  const task = createTask({
    type: 'drama.pre_production',
    dramaId: 1,
    payload: { drama_id: 1 },
  })

  const result = await handler.run(createContext(task.id, new AbortController().signal, task.payload))

  assert.equal(extractCount, 2)
  assert.equal(voiceAssignCount, 1)

  // Villain 和 Extra 都没有形象，应该创建 image generation record
  assert.ok(imageRecords.some(r => r.characterId === 2))
  assert.ok(imageRecords.some(r => r.characterId === 3))
  // 无形象的场景也应该创建 image generation record
  assert.ok(imageRecords.some(r => r.sceneId === 1))

  // 检查生成的 image.generate 任务
  const allTasks = listTasks()
  const imageTasks = allTasks.filter(t => t.type === 'image.generate' && t.scopeId === 2)
  assert.equal(imageTasks.length, 1)
  assert.equal(imageTasks[0].idempotencyKey, 'image.generate:character:drama_pre_production:2')

  const sceneImageTasks = allTasks.filter(t => t.type === 'image.generate' && t.scopeId === 1 && t.scopeType === 'scene')
  assert.equal(sceneImageTasks.length, 1)
  assert.equal(sceneImageTasks[0].idempotencyKey, 'image.generate:scene:drama_pre_production:1')

  // Villain 有音色但无样本，应该创建 tts.character_sample 任务
  const sampleTasks = allTasks.filter(t => t.type === 'tts.character_sample')
  assert.equal(sampleTasks.length, 1)
  assert.equal(sampleTasks[0].scopeId, 2)
  assert.equal(sampleTasks[0].idempotencyKey, 'tts.character_sample:drama_pre_production:2')

  assert.equal(result.drama_id, 1)
  assert.equal(result.episodes_processed, 2)
  assert.equal(result.characters_without_image, 2)
  assert.equal(result.scenes_without_image, 1)
  assert.equal(result.characters_need_sample, 1)
})

test('drama.pre_production skips when no episodes have content', async () => {
  const ts = new Date().toISOString()
  // 使用新的 drama id 避免与上一个测试的 id 冲突（虽然 DB 是新的，但显式使用不同 id 更安全）
  db.insert(schema.dramas).values({
    id: 2, title: 'Empty Drama', status: 'draft', createdAt: ts, updatedAt: ts,
  }).run()
  db.insert(schema.episodes).values({
    id: 10, dramaId: 2, episodeNumber: 1, title: 'E1', createdAt: ts, updatedAt: ts,
  }).run()

  const handler = createDramaPreProductionHandler({
    createAgent: () => null,
  })

  const task = createTask({
    type: 'drama.pre_production',
    dramaId: 2,
    payload: { drama_id: 2 },
  })

  await assert.rejects(
    () => handler.run(createContext(task.id, new AbortController().signal, task.payload)),
    /没有可用的 episode 内容/,
  )
})
