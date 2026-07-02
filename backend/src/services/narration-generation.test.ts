import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-narration-generation-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const {
  resolveStoryboardNarrationTextForTTS,
  restoreOriginalTextNarrations,
  restoreVerbatimNarrations,
} = await import('./narration-generation.js')

function seedDirectScriptEpisode() {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Direct Script Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Direct Script Episode',
    workflowType: 'direct_script',
    narrationMode: 'verbatim',
    content: '旧内容不应优先。',
    scriptContent: '第一句原文。第二句原文：“关键引语”。第三句原文。',
    openingHook: '错误钩子',
    cliffhanger: '错误悬念',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  return { dramaId, episodeId, ts }
}

test('direct-script verbatim TTS uses restored narration before storyboard description', () => {
  const { episodeId, ts } = seedDirectScriptEpisode()
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    description: '为了留住观众，这里先抛出一个悬念。',
    narration: '第二句原文：「关键引语」。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()

  assert.equal(
    resolveStoryboardNarrationTextForTTS(sb, ep),
    '第二句原文：“关键引语”。',
  )
})

test('direct-script verbatim TTS falls back to description when narration is empty', () => {
  const { episodeId, ts } = seedDirectScriptEpisode()
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    description: '第一句原文，第二句原文：「关键引语」。',
    narration: '',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()

  assert.equal(
    resolveStoryboardNarrationTextForTTS(sb, ep),
    '第一句原文。第二句原文：“关键引语”。',
  )
})

test('direct-script verbatim TTS rejects storyboard text that is not in source', () => {
  const { episodeId, ts } = seedDirectScriptEpisode()
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    description: '这是 AI 分镜描述，不是原文。',
    narration: '我被污染成第一人称。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()

  assert.equal(resolveStoryboardNarrationTextForTTS(sb, ep), '')
})

test('restoreVerbatimNarrations does not inject hooks into direct-script original text', () => {
  const { episodeId, ts } = seedDirectScriptEpisode()
  db.insert(schema.storyboards).values([
    { episodeId, storyboardNumber: 1, createdAt: ts, updatedAt: ts },
    { episodeId, storyboardNumber: 2, createdAt: ts, updatedAt: ts },
  ]).run()

  restoreVerbatimNarrations(episodeId)

  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  assert.equal(rows.map(row => row.narration).join(''), '第一句原文。第二句原文：“关键引语”。第三句原文。')
  assert.ok(!rows[0].narration?.includes('错误钩子'))
  assert.ok(!rows[1].narration?.includes('错误悬念'))
})

test('restoreOriginalTextNarrations clears extra storyboard narration beyond source text', () => {
  const { episodeId, ts } = seedDirectScriptEpisode()
  db.update(schema.episodes)
    .set({ scriptContent: '第一句原文。第二句原文。' })
    .where(eq(schema.episodes.id, episodeId))
    .run()
  db.insert(schema.storyboards).values([
    { episodeId, storyboardNumber: 1, narration: '污染1', createdAt: ts, updatedAt: ts },
    { episodeId, storyboardNumber: 2, narration: '污染2', createdAt: ts, updatedAt: ts },
    { episodeId, storyboardNumber: 3, narration: '我不在原文里。', description: 'AI 分镜描述', createdAt: ts, updatedAt: ts },
  ]).run()

  restoreOriginalTextNarrations(episodeId)

  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  assert.equal(rows[0].narration, '第一句原文。')
  assert.equal(rows[1].narration, '第二句原文。')
  assert.equal(rows[2].narration, '')
  assert.equal(resolveStoryboardNarrationTextForTTS(rows[2], db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()[0]), '')
})
