import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-images-route-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { default: route } = await import('./images.js')

test('POST /images uses storyboard episode aspect ratio over request aspect ratio', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Portrait Drama',
    status: 'draft',
    style: 'cinematic',
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

  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Portrait Episode',
    aspectRatio: '9:16',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '羊汤重逢',
    imagePrompt: '横屏16:9宽银幕北方小羊汤馆傍晚，赵磊坐在塑料凳上。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const res = await route.request('/', {
    method: 'POST',
    body: JSON.stringify({
      storyboard_id: storyboardId,
      drama_id: dramaId,
      prompt: '前端传入的横屏 prompt',
      aspect_ratio: '16:9',
    }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()

  assert.equal(res.status, 201)
  const generationId = Number(json.data.id)
  const [record] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, generationId))
    .all()

  assert.equal(record.size, '1080x1920')
  assert.equal(record.style, 'cinematic')
  assert.match(record.prompt || '', /^cinematic film still/)
  assert.match(record.prompt || '', /竖屏9:16/)
  assert.doesNotMatch(record.prompt || '', /横屏|宽银幕/)
})
