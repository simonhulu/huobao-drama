import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-storyboard-tools-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../db/index.js')
const { createStoryboardTools } = await import('./storyboard-tools.js')

test('read_storyboard_context exposes source material and retention rules', async () => {
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
    content: '原始故事：她嘴上没说，但心里已经开始害怕。',
    scriptContent: '## S1 | 内景 · 客厅 | 夜\n她站在窗边，迟迟没有回头。',
    aspectRatio: '9:16',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const sceneId = Number(db.insert(schema.scenes).values({
    dramaId,
    location: '客厅',
    time: '夜',
    prompt: '安静客厅，窗边光线偏冷。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).run()

  const charId = Number(db.insert(schema.characters).values({
    dramaId,
    name: '林夏',
    role: '主角',
    description: '年轻女性',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId, characterId: charId, createdAt: ts }).run()

  const tools = createStoryboardTools(episodeId, dramaId)
  const payload = await (tools.readStoryboardContext.execute as any)({}, {} as any) as any

  assert.equal(payload.original_story, '原始故事：她嘴上没说，但心里已经开始害怕。')
  assert.equal(payload.formatted_script, '## S1 | 内景 · 客厅 | 夜\n她站在窗边，迟迟没有回头。')
  assert.equal(payload.source_material.active_script, payload.script)
  assert.equal(payload.characters.length, 1)
  assert.equal(payload.scenes.length, 1)
  assert.match(payload.storytelling_rules.join(' '), /内心/)
  assert.match(payload.storytelling_rules.join(' '), /因果/)
})

test('direct storyboard saves reject a shot without an event contract before replacement', async () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Direct drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Direct episode',
    content: '原稿',
    scriptContent: '原稿',
    workflowType: 'direct_script',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const oldStoryboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '旧镜头',
    action: '旧动作',
    result: '旧结果',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const tools = createStoryboardTools(episodeId, dramaId)
  await assert.rejects(
    () => (tools.saveStoryboards.execute as any)({
      storyboards: [{
        shot_number: 1,
        title: '新镜头',
        shot_type: '中景',
        angle: '平视',
        movement: '固定',
        location: '室内',
        time: '夜',
        action: '',
        dialogue: '',
        description: '原稿片段',
        result: '状态改变',
        atmosphere: '克制',
        image_prompt: '单幅画面',
        video_prompt: '动作从开始到结束',
        bgm_prompt: '钢琴',
        sound_effect: '脚步',
        duration: 5,
        scene_id: null,
        character_ids: [],
      }],
    }, {} as any),
    /requires action/,
  )
  assert.equal(db.select().from(schema.storyboards).all().some((row) => row.id === oldStoryboardId), true)
})
