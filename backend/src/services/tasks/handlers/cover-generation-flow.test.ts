import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-cover-flow-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../../db/index.js')
const { now } = await import('../../../utils/response.js')
const { createCoverGenerateHandler } = await import('./cover-generate.js')

test('legacy prompt-only episodes use the composed cover pipeline', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Cover Flow Drama',
    style: 'cinematic',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 2,
    title: '制度危机：谁在承担代价',
    coverPrompt: 'cinematic historical drama with a visible human cost',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const imageCalls: any[] = []
  const composeCalls: any[] = []
  const handler = createCoverGenerateHandler({
    createImageGenerationRecord: ((params: any) => {
      imageCalls.push(params)
      return imageCalls.length
    }) as any,
    executeImageGeneration: (async (id: number) => ({
      image_generation_id: id,
      local_path: `static/images/base-${id}.png`,
      image_url: null,
    })) as any,
    enhanceCoverPrompt: (async () => ({
      enhanced_prompt: 'unused creative description',
      image_prompt: 'cinematic historical drama, highly detailed, no text, no watermark',
      main_title: '谁在承担代价',
      sub_title: '一套制度如何把人推向绝境',
      kicker: '制度拆解',
      accent_color: '#B84A34',
      rationale: '把制度后果转成可见的人物冲突。',
    })) as any,
    composeCoverImages: (async (input: any) => {
      composeCalls.push(input)
      return {
        cover4x3Url: 'static/covers/composed-4x3.png',
        cover3x4Url: 'static/covers/composed-3x4.png',
      }
    }) as any,
  })

  const ctx: any = {
    taskId: 1,
    payload: { episode_id: episodeId },
    signal: new AbortController().signal,
    attempts: 0,
    progress: () => {},
    event: () => {},
    isCancelRequested: () => false,
  }

  const result = await handler.run(ctx)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()

  assert.equal(imageCalls.length, 2)
  assert.deepEqual(imageCalls.map(call => [call.imageType, call.frameType, call.size]), [
    ['cover_base', '4:3', '1920x1080'],
    ['cover_base', '3:4', '1080x1920'],
  ])
  assert.equal(composeCalls.length, 1)
  assert.equal(composeCalls[0].design.main_title, '谁在承担代价')
  assert.equal(episode.coverPrompt, 'cinematic historical drama, highly detailed, no text, no watermark')
  assert.equal(JSON.parse(episode.coverDesignJson || '{}').kicker, '制度拆解')
  assert.equal(episode.coverImage4x3Url, 'static/covers/composed-4x3.png')
  assert.equal(episode.coverImage3x4Url, 'static/covers/composed-3x4.png')
  assert.equal(episode.thumbnail, 'static/covers/composed-4x3.png')
  assert.equal(result.cover_4x3.local_path, 'static/covers/composed-4x3.png')
})

test('episodes without a saved prompt still get an automatic cover design', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Automatic Cover Drama',
    style: 'cinematic',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '救命药变催命符',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const imageCalls: any[] = []
  const composeCalls: any[] = []
  const handler = createCoverGenerateHandler({
    createImageGenerationRecord: ((params: any) => {
      imageCalls.push(params)
      return imageCalls.length
    }) as any,
    executeImageGeneration: (async (id: number) => ({
      image_generation_id: id,
      local_path: `static/images/automatic-base-${id}.png`,
      image_url: null,
    })) as any,
    enhanceCoverPrompt: (async ({ roughPrompt }: { roughPrompt: string }) => ({
      enhanced_prompt: roughPrompt,
      image_prompt: 'cinematic historical conflict, highly detailed, no text, no watermark',
      main_title: '救命药变毒药',
      sub_title: '改革为何反噬普通人',
      kicker: '命运转折',
      accent_color: '#B84A34',
      rationale: '用人物代价把制度冲突变成可见画面。',
    })) as any,
    composeCoverImages: (async (input: any) => {
      composeCalls.push(input)
      return {
        cover4x3Url: 'static/covers/automatic-4x3.png',
        cover3x4Url: 'static/covers/automatic-3x4.png',
      }
    }) as any,
  })

  const result = await handler.run({
    taskId: 2,
    payload: { episode_id: episodeId },
    signal: new AbortController().signal,
    attempts: 0,
    progress: () => {},
    event: () => {},
    isCancelRequested: () => false,
  } as any)

  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  assert.equal(imageCalls.length, 2)
  assert.equal(composeCalls.length, 1)
  assert.match(composeCalls[0].design.ai_prompt, /highly detailed/)
  assert.equal(JSON.parse(episode.coverDesignJson || '{}').main_title, '救命药变毒药')
  assert.equal(result.cover_3x4.local_path, 'static/covers/automatic-3x4.png')
})

test('copy-only cover designs keep user text while automatic flow supplies the image prompt', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Copy Only Cover Drama',
    style: 'cinematic',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '制度如何反噬',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const composeCalls: any[] = []
  const handler = createCoverGenerateHandler({
    createImageGenerationRecord: (() => 1) as any,
    executeImageGeneration: (async () => ({
      image_generation_id: 1,
      local_path: 'static/images/copy-only-base.png',
      image_url: null,
    })) as any,
    enhanceCoverPrompt: (async () => ({
      enhanced_prompt: '',
      image_prompt: 'automatic cinematic base, highly detailed, no text, no watermark',
      main_title: '自动标题',
      sub_title: '自动副标题',
      kicker: '自动栏目',
      accent_color: '#B84A34',
      rationale: 'automatic',
    })) as any,
    composeCoverImages: (async (input: any) => {
      composeCalls.push(input)
      return { cover4x3Url: 'static/covers/copy-only-4x3.png', cover3x4Url: 'static/covers/copy-only-3x4.png' }
    }) as any,
  })

  await handler.run({
    taskId: 3,
    payload: {
      episode_id: episodeId,
      cover_design: { main_title: '自定义标题', sub_title: '自定义副标题', kicker: '自定义栏目' },
    },
    signal: new AbortController().signal,
    attempts: 0,
    progress: () => {},
    event: () => {},
    isCancelRequested: () => false,
  } as any)

  assert.equal(composeCalls.length, 1)
  assert.equal(composeCalls[0].design.main_title, '自定义标题')
  assert.equal(composeCalls[0].design.sub_title, '自定义副标题')
  assert.equal(composeCalls[0].design.kicker, '自定义栏目')
  assert.equal(composeCalls[0].design.ai_prompt, 'automatic cinematic base, highly detailed, no text, no watermark')
})
