import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-narrator-tools-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../db/index.js')
const { createNarratorTools } = await import('./narrator-tools.js')

test('read_narration_context exposes script, characters, and shot story focus', async () => {
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
    content: '原始故事：他表面很冷静，其实已经知道这段婚姻撑不住了。',
    scriptContent: '## S1 | 内景 · 餐厅 | 夜\n阿明看着桌上的离婚协议，没有说话。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const charId = Number(db.insert(schema.characters).values({
    dramaId,
    name: '阿明',
    role: '丈夫',
    description: '表面冷静，内里压抑',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId, characterId: charId, createdAt: ts }).run()

  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '协议压桌',
    description: '阿明盯着桌上的离婚协议，迟迟没有抬头。',
    action: '他手指压住纸角，像是在硬撑镇定。',
    result: '他没有签字，但已经默认这段关系走到了尽头。',
    atmosphere: '房间安静得发闷。',
    dialogue: '',
    duration: 10,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.storyboardCharacters).values({ storyboardId, characterId: charId }).run()

  const tools = createNarratorTools(episodeId, dramaId)
  const payload = await (tools.readNarrationContext.execute as any)({}, {} as any) as any

  assert.equal(payload.original_story, '原始故事：他表面很冷静，其实已经知道这段婚姻撑不住了。')
  assert.equal(payload.formatted_script, '## S1 | 内景 · 餐厅 | 夜\n阿明看着桌上的离婚协议，没有说话。')
  assert.equal(payload.characters.length, 1)
  assert.equal(payload.characters[0].name, '阿明')
  assert.deepEqual(payload.shots[0].character_names, ['阿明'])
  assert.match(payload.shots[0].story_focus, /离婚协议/)
  assert.match(payload.storytelling_rules.join(' '), /内心/)
  assert.match(payload.storytelling_rules.join(' '), /动机|因果/)
})
