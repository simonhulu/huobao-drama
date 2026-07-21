import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-episode-tts-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { splitLongStoryboardsByPreTTS } = await import('./episode-tts.js')

test('splitLongStoryboardsByPreTTS splits shots longer than 12 seconds at sentence boundaries', async () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const source = '第一句。第二句。第三句。'
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    workflowType: 'direct_script',
    content: source,
    scriptContent: source,
    preTtsTitlesJson: JSON.stringify([
      { text: '第一句。', text_begin: 0, text_end: 4, time_begin: 0, time_end: 7000 },
      { text: '第二句。', text_begin: 4, text_end: 8, time_begin: 7000, time_end: 14000 },
      { text: '第三句。', text_begin: 8, text_end: 12, time_begin: 14000, time_end: 21000 },
    ]),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '长镜头',
    description: '第一句。第二句。',
    duration: 15,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 2,
    title: '短镜头',
    description: '第三句。',
    duration: 7,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const result = await splitLongStoryboardsByPreTTS(episodeId, 12)

  assert.equal(result.split, 1)
  assert.equal(result.created, 2)
  assert.equal(result.fallback, 0)

  const remaining = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  assert.equal(remaining.length, 3)
  assert.equal(remaining[0].storyboardNumber, 1)
  assert.equal(remaining[0].description, '第一句。')
  assert.equal(remaining[0].duration, 7)
  assert.equal(remaining[1].storyboardNumber, 2)
  assert.equal(remaining[1].description, '第二句。')
  assert.equal(remaining[1].duration, 7)
  assert.equal(remaining[2].storyboardNumber, 3)
  assert.equal(remaining[2].description, '第三句。')
  assert.equal(remaining[2].duration, 7)
})

test('splitLongStoryboardsByPreTTS splits a long sentence at visual clause boundaries', async () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const source = '讣告写着假名，妻子主持了葬礼，他的真名另有其人。'
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    workflowType: 'direct_script',
    content: source,
    scriptContent: source,
    preTtsTitlesJson: JSON.stringify([
      { text: source, text_begin: 0, text_end: source.length, time_begin: 0, time_end: 12000 },
    ]),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const originalId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '错误的旧标题',
    description: source,
    narration: source,
    action: '错误的旧动作，不能复制给所有子镜头',
    duration: 12,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const result = await splitLongStoryboardsByPreTTS(episodeId, 5, {
    onlyStoryboardIds: [originalId],
    generateImagePrompts: async () => new Map(),
  })

  assert.equal(result.split, 1)
  assert.equal(result.created, 3)
  assert.equal(result.fallback, 0)

  const remaining = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  assert.deepEqual(remaining.map((sb) => sb.narration), [
    '讣告写着假名，',
    '妻子主持了葬礼，',
    '他的真名另有其人。',
  ])
  assert.deepEqual(remaining.map((sb) => sb.action), remaining.map((sb) => sb.narration))
  assert.ok(remaining.every((sb) => (sb.duration || 0) <= 5))
  assert.ok(remaining.every((sb) => !sb.title?.includes('错误的旧标题')))
})

test('splitLongStoryboardsByPreTTS keeps short shots unchanged', async () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const source = '只有一句。'
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    workflowType: 'direct_script',
    content: source,
    scriptContent: source,
    preTtsTitlesJson: JSON.stringify([
      { text: '只有一句。', text_begin: 0, text_end: 5, time_begin: 0, time_end: 5000 },
    ]),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '短镜头',
    description: '只有一句。',
    duration: 5,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const result = await splitLongStoryboardsByPreTTS(episodeId, 12)

  assert.equal(result.split, 0)
  assert.equal(result.created, 0)
  assert.equal(result.fallback, 0)

  const remaining = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()

  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].duration, 5)
})

test('splitLongStoryboardsByPreTTS skips when episode has no pre-TTS titles', async () => {
  const ts = new Date().toISOString()
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
    workflowType: 'direct_script',
    content: '内容。',
    scriptContent: '内容。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '长镜头',
    description: '内容。',
    duration: 20,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const result = await splitLongStoryboardsByPreTTS(episodeId, 12)

  assert.equal(result.split, 0)
  assert.equal(result.created, 0)
  assert.equal(result.fallback, 0)

  const remaining = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()

  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].duration, 20)
})

test('splitLongStoryboardsByPreTTS generates distinct image prompts per child fragment', async () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const source = '第一句。第二句。'
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    workflowType: 'direct_script',
    content: source,
    scriptContent: source,
    preTtsTitlesJson: JSON.stringify([
      { text: '第一句。', text_begin: 0, text_end: 4, time_begin: 0, time_end: 7000 },
      { text: '第二句。', text_begin: 4, text_end: 9, time_begin: 7000, time_end: 14000 },
    ]),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '长镜头',
    description: '第一句。第二句。',
    imagePrompt: 'parent prompt',
    duration: 15,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const stubGenerator = async (contexts: any[]) => {
    const map = new Map<number, string>()
    for (const ctx of contexts) {
      map.set(ctx.index, `prompt for ${ctx.groupText}`)
    }
    return map
  }

  const result = await splitLongStoryboardsByPreTTS(episodeId, 12, { generateImagePrompts: stubGenerator })

  assert.equal(result.split, 1)
  assert.equal(result.created, 2)

  const remaining = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  assert.equal(remaining.length, 2)
  assert.ok(remaining[0].imagePrompt?.includes('第一句'))
  assert.ok(remaining[1].imagePrompt?.includes('第二句'))
  assert.notEqual(remaining[0].imagePrompt, remaining[1].imagePrompt)
  assert.notEqual(remaining[0].imagePrompt, 'parent prompt')
  assert.notEqual(remaining[1].imagePrompt, 'parent prompt')
})
