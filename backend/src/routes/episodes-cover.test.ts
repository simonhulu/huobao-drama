import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-episodes-cover-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { default: route } = await import('./episodes.js')

test('POST /episodes stores cover_prompt and auto-schedules cover generation', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Cover Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image',
    provider: 'apimart',
    name: 'APIMart image',
    baseUrl: 'https://api.apimart.ai',
    apiKey: 'test-key',
    model: JSON.stringify(['gpt-image-2']),
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const res = await route.request('/', {
    method: 'POST',
    body: JSON.stringify({
      drama_id: dramaId,
      title: 'Cover Episode',
      cover_prompt: 'silver and tax system collapse cover image',
      image_config_id: null,
      video_config_id: null,
      audio_config_id: null,
    }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()
  assert.equal(res.status, 200)
  const episodeId = Number(json.data.id)
  assert.ok(json.data.cover_task_id, 'cover_task_id should be returned')

  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  assert.equal(episode.coverPrompt, 'silver and tax system collapse cover image')

  const getRes = await route.request(`/${episodeId}/covers`)
  const getJson = await getRes.json()
  assert.equal(getRes.status, 200)
  assert.equal(getJson.data.cover_prompt, 'silver and tax system collapse cover image')

  db.insert(schema.imageGenerations).values({
    episodeId,
    imageType: 'cover_base',
    frameType: '4:3',
    localPath: 'static/images/cover-base.png',
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const generationsRes = await route.request(`/${episodeId}/covers`)
  const generationsJson = await generationsRes.json()
  assert.equal(generationsJson.data.generations.length, 1)
  assert.equal(generationsJson.data.generations[0].local_path, 'static/images/cover-base.png')
})

test('POST /episodes/:id/generate-covers auto-designs when prompt is empty', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Cover Drama 2',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'No Cover Prompt',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const res = await route.request(`/${episodeId}/generate-covers`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.ok(json.data.task_id)
})

test('PUT /episodes/:id extracts a polish cover plan from script_content', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Polish Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 4,
    title: '被隐藏的账本',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const script = `## 二、优化后口播脚本
她打开那本旧账，才发现所有人都在等一个替罪羊。

## 八、封面设计方案

### 封面 A：冲突型
- **建议画幅比**：9:16
- **画面描述**：宫殿与荒街并置。
- **主标题文案**：盛世是假象
- **副标题文案**：繁华背后谁在承担代价
- **AI图片生成提示词**：cinematic palace and empty street, highly detailed, no text, no watermark
- **为什么有效**：缩小后仍然有强烈反差。

### 推荐
推荐使用封面 A。
`

  const res = await route.request(`/${episodeId}`, {
    method: 'PUT',
    body: JSON.stringify({ script_content: script }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()
  assert.equal(res.status, 200)
  assert.equal(json.data.cover_design_saved, true)
  assert.equal(json.data.cover_design.main_title, '盛世是假象')

  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  assert.equal(JSON.parse(episode.coverDesignJson || '{}').main_title, '盛世是假象')
  assert.match(episode.coverPrompt || '', /cinematic palace and empty street/)
})
