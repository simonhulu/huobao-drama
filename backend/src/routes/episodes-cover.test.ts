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

test('Dharma narration speed defaults to 0.85 in storage and remains adjustable', async () => {
  const ts = now()
  const dharmaDramaId = Number(db.insert(schema.dramas).values({
    title: 'Dharma Speed Drama',
    genre: 'dharma',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const storedDefaultId = Number(db.insert(schema.episodes).values({
    dramaId: dharmaDramaId,
    episodeNumber: 1,
    title: 'Stored Default',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const [storedDefault] = db.select().from(schema.episodes).where(eq(schema.episodes.id, storedDefaultId)).all()
  assert.equal(storedDefault?.narrationSpeed, 0.85)

  const createResponse = await route.request('/', {
    method: 'POST',
    body: JSON.stringify({ drama_id: dharmaDramaId, title: 'Adjustable Episode' }),
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(createResponse.status, 200)
  const created = await createResponse.json() as { data: { id: number } }

  const updateResponse = await route.request(`/${created.data.id}`, {
    method: 'PUT',
    body: JSON.stringify({ narration_speed: 1.1 }),
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(updateResponse.status, 200)
  let [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, created.data.id)).all()
  assert.equal(episode?.narrationSpeed, 1.1)

  const invalidUpdateResponse = await route.request(`/${created.data.id}`, {
    method: 'PUT',
    body: JSON.stringify({ narration_speed: 9 }),
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(invalidUpdateResponse.status, 200)
  ;[episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, created.data.id)).all()
  assert.equal(episode?.narrationSpeed, 0.85)
})

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

test('history factory cover generation rejects missing user-provided title', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'History Cover Contract Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '用户确认的正片标题',
    metadata: JSON.stringify({ historyFactory: 'remotion-history-factory' }),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const res = await route.request(`/${episodeId}/generate-covers`, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'cinematic historical scene' }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()
  assert.equal(res.status, 400)
  assert.match(json.message, /cover_design\.main_title/u)
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

test('PUT /episodes/:id stores every publishing package field for platform publishing', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Dharma Publishing Package Drama',
    genre: 'dharma',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '亲情边界测试',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const publishingPackage = {
    schema_version: 'dharma-publishing-package/v1',
    title: '亲情边界测试',
    opening_hook: '把你熬垮的孝顺，已经不只是孝顺了。',
    cliffhanger: '承认做不到，才知道如何重新安排照护。',
    creative_brief: { stance: '责任不应以自我消失为证明。' },
    cover_design: {
      main_title: '孝顺不是服从',
      sub_title: '可以报恩',
      ai_prompt: 'cinematic family care scene, no text',
    },
    extension: { source: 'dharma-video-script' },
  }

  const response = await route.request(`/${episodeId}`, {
    method: 'PUT',
    body: JSON.stringify({ publishing_package: publishingPackage }),
    headers: { 'Content-Type': 'application/json' },
  })
  assert.equal(response.status, 200)
  const body = await response.json() as any
  assert.equal(body.data.publishing_package_saved, true)

  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  assert.equal(episode?.openingHook, publishingPackage.opening_hook)
  assert.equal(episode?.cliffhanger, publishingPackage.cliffhanger)
  assert.deepEqual(JSON.parse(episode?.creativeBriefJson || '{}'), publishingPackage.creative_brief)
  assert.deepEqual(JSON.parse(episode?.coverDesignJson || '{}'), publishingPackage.cover_design)
  const metadata = JSON.parse(episode?.metadata || '{}')
  assert.deepEqual(metadata.dharmaPublishing.package, publishingPackage)
  assert.ok(metadata.dharmaPublishing.package_sha256)
})
