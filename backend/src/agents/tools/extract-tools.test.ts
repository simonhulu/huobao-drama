import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-extract-tools-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../db/index.js')
const { createExtractTools } = await import('./extract-tools.js')

function seedEpisode(workflowType: string, content?: string, scriptContent?: string) {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Test Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Test Episode',
    content,
    scriptContent,
    workflowType,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  return { dramaId, episodeId }
}

test('readScriptForExtraction prefers scriptContent for direct-script workflow', async () => {
  const { dramaId, episodeId } = seedEpisode('direct_script', 'novel content', 'finished script content')
  const tools: any = createExtractTools(episodeId, dramaId)
  const result = await tools.readScriptForExtraction.execute({})

  assert.equal(result.script_content, 'finished script content')
  assert.equal(result.original_story, 'finished script content')
})

test('readScriptForExtraction prefers content for story-rewrite workflow', async () => {
  const { dramaId, episodeId } = seedEpisode('story_rewrite', 'novel content', 'finished script content')
  const tools: any = createExtractTools(episodeId, dramaId)
  const result = await tools.readScriptForExtraction.execute({})

  assert.equal(result.original_story, 'novel content')
})

test('saveDedupCharacters skips empty names and still saves valid characters', async () => {
  const { dramaId, episodeId } = seedEpisode('direct_script', 'content')
  const tools: any = createExtractTools(episodeId, dramaId)

  const result = await tools.saveDedupCharacters.execute({
    characters: [
      { name: '秦始皇', description: '秦朝第一位皇帝' },
      { name: '', description: 'should be skipped' },
      { name: '  ', description: 'should also be skipped' },
    ],
  })

  assert.equal(result.created, 1)
  assert.equal(result.skipped, 2)

  const chars = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, dramaId))
    .all()
  assert.equal(chars.length, 1)
  assert.equal(chars[0].name, '秦始皇')
})

test('saveDedupScenes skips empty locations and still saves valid scenes', async () => {
  const { dramaId, episodeId } = seedEpisode('direct_script', 'content')
  const tools: any = createExtractTools(episodeId, dramaId)

  const result = await tools.saveDedupScenes.execute({
    scenes: [
      { location: '咸阳宫', time: '白天' },
      { location: '', time: '夜晚' },
      { location: '  ', time: '清晨' },
    ],
  })

  assert.equal(result.created, 1)
  assert.equal(result.skipped, 2)

  const scenes = db.select().from(schema.scenes)
    .where(eq(schema.scenes.dramaId, dramaId))
    .all()
  assert.equal(scenes.length, 1)
  assert.equal(scenes[0].location, '咸阳宫')
})
