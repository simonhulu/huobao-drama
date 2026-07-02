import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-auto-pipeline-fs-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../db/index.js')
const {
  scheduleBreakdownAndNarrationForEpisode,
  scheduleDirectScriptPipeline,
  scheduleNarratorAfterSplitter,
  scheduleTTSForEpisode,
} = await import('./auto-pipeline.js')

test('scheduleDirectScriptPipeline creates only breaker for direct-script source text', () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'FS Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'FS Episode',
    workflowType: 'direct_script',
    pacingMode: 'literal',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const { breaker, narrator } = scheduleDirectScriptPipeline(dramaId, episodeId)

  assert.equal(breaker.type, 'agent.run')
  assert.equal(narrator, null, 'direct_script uses original text for TTS and must not create narrator tasks')

  assert.equal(breaker.payload.agent_type, 'storyboard_breaker')
  assert.ok(String(breaker.payload.message).includes('精稿直出'))

  const allTasks = db.select().from(schema.creationTasks).all().filter(row => row.episodeId === episodeId)
  const narratorTasks = allTasks.filter(row => row.payloadJson?.includes('"agent_type":"narrator"'))
  assert.equal(narratorTasks.length, 0)
})

test('story-rewrite rewrite mode still schedules narrator after splitter', () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Story Rewrite Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 3,
    title: 'Rewrite Episode',
    workflowType: 'story_rewrite',
    narrationMode: 'rewrite',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const narrator = scheduleNarratorAfterSplitter(dramaId, episodeId)

  assert.ok(narrator)
  assert.equal(narrator.type, 'agent.run')
  assert.equal(narrator.payload.agent_type, 'narrator')
})

test('story-rewrite verbatim mode keeps splitter but blocks narrator agent', () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Story Verbatim Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 4,
    title: 'Verbatim Episode',
    workflowType: 'story_rewrite',
    narrationMode: 'verbatim',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const { splitter, narrator } = scheduleBreakdownAndNarrationForEpisode(dramaId, episodeId)

  assert.ok(splitter, 'story_rewrite can still use splitter for structure')
  assert.equal(narrator, null, 'verbatim mode must not create narrator agent')
  assert.equal(scheduleNarratorAfterSplitter(dramaId, episodeId), null)
})

test('scheduleTTSForEpisode uses direct-script description when narration is empty', () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'FS Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 2,
    title: 'FS Episode 2',
    workflowType: 'direct_script',
    narrationMode: 'verbatim',
    dialogueMode: 'narration_only',
    scriptContent: '第一句原文。第二句原文。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    description: '第一句原文。',
    narration: '',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const { parentTask, childTasks } = scheduleTTSForEpisode(dramaId, episodeId)

  assert.ok(parentTask)
  assert.equal(childTasks.length, 1)
  assert.equal(childTasks[0].payload.storyboard_id, storyboardId)
})
