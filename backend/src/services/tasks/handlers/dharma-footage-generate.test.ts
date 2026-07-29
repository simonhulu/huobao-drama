import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inArray } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-dharma-footage-task-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../../db/index.js')
const { now } = await import('../../../utils/response.js')
const { createTask } = await import('../store.js')
const { createDharmaFootageGenerateHandler } = await import('./dharma-footage-generate.js')
const { resolveDharmaStyleForEmotion, snapshotDharmaImageStyle } = await import('../../dharma-image-style.js')

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

test('Dharma footage task persists the explicit emotional style contract across its segment', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Dharma task fixture',
    genre: 'dharma',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Segment assignment',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image',
    provider: 'test-image-provider',
    name: 'Dharma image task config',
    baseUrl: 'https://example.invalid',
    apiKey: 'test-api-key',
    model: JSON.stringify(['test-image-model']),
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const referenceImage = `static/images/dharma-reference-handler-${process.pid}.png`
  const firstStoryboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    gridCells: JSON.stringify({
      dharma: 1,
      role: 'ritual',
      theme: '香火静室',
      image: { src: referenceImage },
      quote: { text: '守住此刻' },
    }),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const secondStoryboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 2,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const localPath = `static/images/dharma-generated-handler-${process.pid}.png`
  const absolutePath = join(repoRoot, 'data', localPath)
  const referenceAbsolutePath = join(repoRoot, 'data', referenceImage)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, 'test image')
  writeFileSync(referenceAbsolutePath, 'reference image')

  try {
    const style = resolveDharmaStyleForEmotion('insight')
    const narrativeSemantic = {
      subjectCount: 2,
      subjects: '焦虑的父亲与安静的成年孩子',
      relationship: '爱被控制欲扭曲的父子',
      action: '父亲攥着写满安排的纸，孩子从纸张指向的道路旁迈开一步',
      visibleEmotion: '父亲焦虑，孩子疲惫但坚定',
      visualEvidence: '父亲手里的安排纸与孩子偏离指定道路同时清晰可见',
    }
    const task = createTask({
      type: 'dharma.footage_generate',
      dramaId,
      episodeId,
      scopeType: 'episode',
      scopeId: episodeId,
      payload: {
        episode_id: episodeId,
        storyboard_ids: [firstStoryboardId, secondStoryboardId],
        kind: 'image',
        prompt: '一盏灯照亮禅室',
        model: 'test-image-model',
        reference_images: [referenceImage],
        config_id: configId,
        role: 'ritual',
        emotion: 'insight',
        style_id: style.id,
        style_snapshot: snapshotDharmaImageStyle(style),
        move: 'hold',
        shot_function: 'narrative_illustration',
        semantic: narrativeSemantic,
      },
    })
    let capturedImageStyle = ''
    let capturedImagePrompt = ''
    let capturedImageModel = ''
    let capturedReferenceImages: string[] = []
    const handler = createDharmaFootageGenerateHandler({
      createImageGenerationRecord: (params) => {
        capturedImageStyle = params.style || ''
        capturedImagePrompt = params.prompt
        capturedImageModel = params.model || ''
        capturedReferenceImages = params.referenceImages || []
        db.insert(schema.imageGenerations).values({
          id: 71,
          episodeId,
          dramaId,
          imageType: 'dharma_footage',
          style: params.style,
          localPath,
          status: 'completed',
          createdAt: ts,
          updatedAt: ts,
        }).run()
        return 71
      },
      executeImageGeneration: async () => ({
        image_generation_id: 71,
        local_path: localPath,
      }),
    })

    const result = await handler.run({
      taskId: task.id,
      episodeId,
      payload: task.payload,
      signal: new AbortController().signal,
      attempts: 1,
      progress() {},
      event() {},
      isCancelRequested() { return false },
    })

    assert.deepEqual(result, {
      kind: 'image',
      role: 'ritual',
      emotion: 'insight',
      style_id: style.id,
      shot_function: 'narrative_illustration',
      semantic: narrativeSemantic,
      reference_images: [referenceImage],
      image_generation_id: 71,
      image_style: style.id,
      move: 'hold',
      local_path: localPath,
      storyboard_ids: [firstStoryboardId, secondStoryboardId],
    })
    assert.equal(capturedImageStyle, style.id)
    assert.equal(capturedImageModel, 'test-image-model')
    assert.deepEqual(capturedReferenceImages, [referenceImage])
    assert.match(capturedImagePrompt, /minimal cinematic light-and-shadow study/)
    assert.match(capturedImagePrompt, /restrained Buddhist ritual detail inside a quiet temple/)
    assert.match(capturedImagePrompt, /一盏灯照亮禅室/)
    assert.match(capturedImagePrompt, /Mandatory visual evidence:.*安排纸.*偏离指定道路/)
    const cells = db.select({ id: schema.storyboards.id, gridCells: schema.storyboards.gridCells })
      .from(schema.storyboards)
      .where(inArray(schema.storyboards.id, [firstStoryboardId, secondStoryboardId]))
      .all()
      .map((row) => ({ id: row.id, cell: JSON.parse(row.gridCells || '{}') }))
    const first = cells.find((row) => row.id === firstStoryboardId)?.cell
    const second = cells.find((row) => row.id === secondStoryboardId)?.cell
    assert.deepEqual(first, {
      dharma: 1,
      role: 'ritual',
      emotion: 'insight',
      styleId: style.id,
      shotFunction: 'narrative_illustration',
      semantic: narrativeSemantic,
      theme: '香火静室',
      quote: { text: '守住此刻' },
      image: { src: localPath, generatedSegmentTaskId: task.id, move: 'hold' },
    })
    assert.deepEqual(second, {
      dharma: 1,
      role: 'ritual',
      emotion: 'insight',
      styleId: style.id,
      shotFunction: 'narrative_illustration',
      semantic: narrativeSemantic,
      image: { src: localPath, generatedSegmentTaskId: task.id, move: 'hold' },
    })
  } finally {
    rmSync(absolutePath, { force: true })
    rmSync(referenceAbsolutePath, { force: true })
  }
})
