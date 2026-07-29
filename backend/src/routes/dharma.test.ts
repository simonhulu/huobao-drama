import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inArray } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-dharma-route-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const {
  buildDharmaCanaryInputFingerprint,
  buildDharmaEpisodeInputFingerprint,
} = await import('../services/dharma-props.js')
const {
  DEFAULT_DHARMA_IMAGE_STYLE_ID,
  DHARMA_EMOTIONAL_INK_STYLE_ID,
  DHARMA_MINIMAL_LIGHT_STYLE_ID,
  DHARMA_SURREAL_DREAM_STYLE_ID,
  findDharmaImageStyle,
  snapshotDharmaImageStyle,
} = await import('../services/dharma-image-style.js')
const {
  getDharmaProductionGate,
  recordDharmaCanaryRendered,
  setDharmaProductionGateMetadata,
} = await import('../services/dharma-production-gate.js')
const { createTask, getTask, listTaskEvents } = await import('../services/tasks/store.js')
const { default: dharmaRoute } = await import('./dharma.js')

const sourceA = 'static/remotion/stock/pexels-35574243.mp4'
const sourceB = 'static/remotion/stock/pexels-38045734.mp4'
const sourceC = 'static/remotion/stock/pexels-28865204.mp4'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const reviewPilotEpisodeId = 2_000_000_000 + process.pid

const sourceProvenance: Record<string, Record<string, string>> = {
  [sourceA]: {
    provider: 'pexels',
    videoId: '35574243',
    sourceUrl: 'https://www.pexels.com/video/moody-clouds-over-dramatic-mountain-peaks-35574243/',
    licenseUrl: 'https://www.pexels.com/license/',
    creator: 'Astrella Visuals',
  },
  [sourceB]: {
    provider: 'pexels',
    videoId: '38045734',
    sourceUrl: 'https://www.pexels.com/video/candle-lighting-ritual-in-dimly-lit-temple-38045734/',
    licenseUrl: 'https://www.pexels.com/license/',
    creator: 'K',
  },
  [sourceC]: {
    provider: 'pexels',
    videoId: '28865204',
    sourceUrl: 'https://www.pexels.com/video/scenic-foggy-hillside-with-bright-sunlight-28865204/',
    licenseUrl: 'https://www.pexels.com/license/',
    creator: 'Ravi Kant',
  },
}

function videoAssignment(src: string) {
  return { src, ...sourceProvenance[src] }
}

function footageAssignment(
  storyboardId: number,
  src: string,
  role: 'temple_interior' | 'ritual' | 'temple_exterior' | 'contemplative_nature' = 'ritual',
) {
  return {
    storyboardId,
    role,
    emotion: 'stillness',
    style_id: DHARMA_EMOTIONAL_INK_STYLE_ID,
    video: videoAssignment(src),
  }
}

function insertFixture(options: {
  episodeId?: number
  preTtsTitlesJson?: string
  storyboardCount?: number
  style?: string
} = {}) {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Dharma footage uniqueness route test',
    genre: 'dharma',
    ...(options.style ? { style: options.style } : {}),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    ...(options.episodeId ? { id: options.episodeId } : {}),
    dramaId,
    episodeNumber: 1,
    title: 'No repeat test',
    ...(options.preTtsTitlesJson ? { preTtsTitlesJson: options.preTtsTitlesJson } : {}),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const storyboardIds = Array.from({ length: options.storyboardCount ?? 3 }, (_, index) => index + 1)
    .map((storyboardNumber) => Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber,
    narration: `旁白 ${storyboardNumber}`,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid))
  return { dramaId, episodeId, storyboardIds }
}

function insertGeneratedImageEvidence(input: {
  dramaId: number
  episodeId: number
  storyboardId: number
  src: string
  role: 'temple_interior' | 'ritual' | 'temple_exterior' | 'contemplative_nature'
  emotion: 'curiosity' | 'stillness' | 'tension' | 'acceptance' | 'insight' | 'release'
  styleId: string
  move: 'push' | 'pull' | 'hold' | 'drift_left' | 'drift_right'
}) {
  const ts = now()
  const generationId = Number(db.insert(schema.imageGenerations).values({
    dramaId: input.dramaId,
    episodeId: input.episodeId,
    imageType: 'dharma_footage',
    style: input.styleId,
    localPath: input.src,
    status: 'completed',
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  }).run().lastInsertRowid)
  return Number(db.insert(schema.creationTasks).values({
    type: 'dharma.footage_generate',
    status: 'succeeded',
    dramaId: input.dramaId,
    episodeId: input.episodeId,
    scopeType: 'episode',
    scopeId: input.episodeId,
    payloadJson: JSON.stringify({
      episode_id: input.episodeId,
      storyboard_ids: [input.storyboardId],
      kind: 'image',
      role: input.role,
      emotion: input.emotion,
      style_id: input.styleId,
      move: input.move,
    }),
    resultJson: JSON.stringify({
      kind: 'image',
      role: input.role,
      emotion: input.emotion,
      style_id: input.styleId,
      move: input.move,
      image_generation_id: generationId,
      local_path: input.src,
      storyboard_ids: [input.storyboardId],
    }),
    createdAt: ts,
    updatedAt: ts,
    completedAt: ts,
  }).run().lastInsertRowid)
}

function insertProductionFixture(options: { withQuote?: boolean; quoteText?: string } = {}) {
  const withQuote = options.withQuote ?? true
  const titles = JSON.stringify(Array.from({ length: 6 }, (_, index) => ({
    text: `旁白 ${index + 1}`,
    time_begin: index * 3_000,
    time_end: (index + 1) * 3_000,
  })))
  const fixture = insertFixture({ preTtsTitlesJson: titles, storyboardCount: 6 })
  db.update(schema.episodes).set({
    preTtsAudioUrl: sourceA,
    bgmAudioUrl: 'static/music/freepacks/holst-planets/2. Venus.mp3',
    updatedAt: now(),
  }).where(inArray(schema.episodes.id, [fixture.episodeId])).run()
  const stillnessSrc = 'static/images/song-dynasty-aesthetic.png'
  const acceptanceSrc = 'static/images/dreamy-pastoral-healing.png'
  const insightSrc = 'static/images/wabi-sabi-minimal.png'
  const stillnessTaskId = insertGeneratedImageEvidence({
    ...fixture,
    storyboardId: fixture.storyboardIds[1],
    src: stillnessSrc,
    role: 'ritual',
    emotion: 'stillness',
    styleId: DHARMA_EMOTIONAL_INK_STYLE_ID,
    move: 'drift_right',
  })
  const acceptanceTaskId = insertGeneratedImageEvidence({
    ...fixture,
    storyboardId: fixture.storyboardIds[3],
    src: acceptanceSrc,
    role: 'ritual',
    emotion: 'acceptance',
    styleId: DHARMA_EMOTIONAL_INK_STYLE_ID,
    move: 'drift_left',
  })
  const insightTaskId = insertGeneratedImageEvidence({
    ...fixture,
    storyboardId: fixture.storyboardIds[4],
    src: insightSrc,
    role: 'ritual',
    emotion: 'insight',
    styleId: DHARMA_MINIMAL_LIGHT_STYLE_ID,
    move: 'hold',
  })
  const assignments: Array<Record<string, unknown>> = [
    {
      role: 'ritual',
      emotion: 'curiosity',
      styleId: DHARMA_SURREAL_DREAM_STYLE_ID,
      video: videoAssignment(sourceA),
    },
    {
      role: 'ritual',
      emotion: 'stillness',
      styleId: DHARMA_EMOTIONAL_INK_STYLE_ID,
      image: {
        src: stillnessSrc,
        generatedSegmentTaskId: stillnessTaskId,
        move: 'drift_right',
      },
    },
    {
      role: 'ritual',
      emotion: 'tension',
      styleId: DHARMA_SURREAL_DREAM_STYLE_ID,
      video: videoAssignment(sourceB),
    },
    {
      role: 'ritual',
      emotion: 'acceptance',
      styleId: DHARMA_EMOTIONAL_INK_STYLE_ID,
      image: {
        src: acceptanceSrc,
        generatedSegmentTaskId: acceptanceTaskId,
        move: 'drift_left',
      },
    },
    {
      role: 'ritual',
      emotion: 'insight',
      styleId: DHARMA_MINIMAL_LIGHT_STYLE_ID,
      image: {
        src: insightSrc,
        generatedSegmentTaskId: insightTaskId,
        move: 'hold',
      },
      ...(withQuote ? { quote: { text: options.quoteText ?? '应无所住而生其心', source: '《金刚经》' } } : {}),
    },
    {
      role: 'ritual',
      emotion: 'release',
      styleId: DHARMA_EMOTIONAL_INK_STYLE_ID,
      video: videoAssignment(sourceC),
    },
  ]
  fixture.storyboardIds.forEach((storyboardId, index) => {
    db.update(schema.storyboards).set({
      gridCells: JSON.stringify({
        dharma: 1,
        ...assignments[index],
      }),
      updatedAt: now(),
    }).where(inArray(schema.storyboards.id, [storyboardId])).run()
  })
  return fixture
}

function bindGenerationConfig(episodeId: number, kind: 'image' | 'video') {
  const ts = now()
  const configId = Number(db.insert(schema.aiServiceConfigs).values({
    serviceType: kind,
    provider: `test-${kind}-provider`,
    name: `Dharma ${kind} generation config`,
    baseUrl: 'https://example.invalid',
    apiKey: 'test-api-key',
    model: JSON.stringify([`test-${kind}-model`]),
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.update(schema.episodes)
    .set(kind === 'image'
      ? { imageConfigId: configId, updatedAt: ts }
      : { videoConfigId: configId, updatedAt: ts })
    .where(inArray(schema.episodes.id, [episodeId]))
    .run()
  return configId
}

function createPendingDharmaRenderReconciliation(
  episodeId: number,
  payload: Record<string, unknown> = { episode_id: episodeId },
) {
  const task = createTask({
    type: 'dharma.episode_render',
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `pending-reconciliation:${episodeId}:${Math.random()}`,
    payload,
  })
  const ts = now()
  db.update(schema.creationTasks)
    .set({
      status: 'stale',
      commitClaimedAt: ts,
      errorCode: 'task_commit_claimed_reconciliation_required',
      errorMessage: 'Explicit delivery reconciliation is required.',
      completedAt: ts,
      updatedAt: ts,
    })
    .where(inArray(schema.creationTasks.id, [task.id]))
    .run()
  return task
}

async function withTaskControlToken<T>(token: string | undefined, run: () => Promise<T>) {
  const previous = process.env.TASK_CONTROL_TOKEN
  if (token === undefined) delete process.env.TASK_CONTROL_TOKEN
  else process.env.TASK_CONTROL_TOKEN = token
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.TASK_CONTROL_TOKEN
    else process.env.TASK_CONTROL_TOKEN = previous
  }
}

test('Dharma canary fingerprint ignores later storyboard changes but binds shared audio inputs', () => {
  const titles = JSON.stringify([
    { text: '旁白 1', time_begin: 0, time_end: 6_000 },
    { text: '旁白 2', time_begin: 6_000, time_end: 12_000 },
    { text: '旁白 3', time_begin: 12_000, time_end: 18_000 },
  ])
  const { episodeId, storyboardIds } = insertFixture({ preTtsTitlesJson: titles })
  db.update(schema.episodes).set({
    preTtsAudioUrl: 'static/audio/master-a.wav',
    bgmAudioUrl: 'static/music/bed-a.mp3',
    updatedAt: now(),
  }).where(inArray(schema.episodes.id, [episodeId])).run()

  const fullBefore = buildDharmaEpisodeInputFingerprint(episodeId)
  const canaryBefore = buildDharmaCanaryInputFingerprint(episodeId, storyboardIds.slice(0, 2))
  db.update(schema.storyboards).set({ narration: '后半段安全修改', updatedAt: now() })
    .where(inArray(schema.storyboards.id, [storyboardIds[2]])).run()

  assert.notEqual(buildDharmaEpisodeInputFingerprint(episodeId), fullBefore)
  assert.equal(buildDharmaCanaryInputFingerprint(episodeId, storyboardIds.slice(0, 2)), canaryBefore)

  db.update(schema.episodes).set({ bgmAudioUrl: 'static/music/bed-b.mp3', updatedAt: now() })
    .where(inArray(schema.episodes.id, [episodeId])).run()
  const afterBgm = buildDharmaCanaryInputFingerprint(episodeId, storyboardIds.slice(0, 2))
  assert.notEqual(afterBgm, canaryBefore)

  db.update(schema.episodes).set({ preTtsAudioUrl: 'static/audio/master-b.wav', updatedAt: now() })
    .where(inArray(schema.episodes.id, [episodeId])).run()
  assert.notEqual(buildDharmaCanaryInputFingerprint(episodeId, storyboardIds.slice(0, 2)), afterBgm)
})

test('Dharma production preflight and exact canary approval admit a full render without a fixed pilot', async () => {
  const { episodeId } = insertProductionFixture({ quoteText: '真正的放下不是遗忘，而是不再让过去决定此刻，也不再让昨天替你回答今天' })
  const preflightResponse = await dharmaRoute.request(`/episode/${episodeId}/preflight`, { method: 'POST' })
  const preflightBody = await preflightResponse.json() as any
  assert.equal(preflightResponse.status, 200, JSON.stringify(preflightBody))
  const preflight = preflightBody.data
  assert.equal(preflight.production_gate.fullPlan.status, 'validated')
  assert.equal(preflight.production_gate.canary.requirement, 'required')
  assert.equal(preflight.production_gate.fullPlan.report.valid, true)

  const blocked = await dharmaRoute.request(`/episode/${episodeId}/render`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(blocked.status, 400)
  assert.match((await blocked.json() as any).message, /生产计划尚未人工审核/)

  const malformedApproval = await dharmaRoute.request(`/episode/${episodeId}/review/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(malformedApproval.status, 400)

  const canaryResponse = await dharmaRoute.request(`/episode/${episodeId}/canary`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(canaryResponse.status, 200)
  const canaryTaskId = (await canaryResponse.json() as any).data.task_id as number
  const canaryDurationSec = preflight.production_gate.canary.window.durationSec as number
  const canaryOutput = `static/remotion/dharma-ep${episodeId}-canary-${canaryDurationSec}s-task${canaryTaskId}.mp4`
  const canaryOutputPath = join(repoRoot, 'data', canaryOutput)
  mkdirSync(dirname(canaryOutputPath), { recursive: true })
  writeFileSync(canaryOutputPath, 'test canary output')

  try {
    const [scheduledEpisode] = db.select().from(schema.episodes)
      .where(inArray(schema.episodes.id, [episodeId])).all()
    const scheduledGate = getDharmaProductionGate(scheduledEpisode.metadata)
    assert.ok(scheduledGate)
    const renderedAt = now()
    const renderedGate = recordDharmaCanaryRendered(scheduledGate, {
      taskId: canaryTaskId,
      fingerprint: preflight.production_gate.canary.fingerprint,
      output: canaryOutput,
      renderedAt,
    })
    db.update(schema.episodes).set({
      metadata: setDharmaProductionGateMetadata(scheduledEpisode.metadata, renderedGate),
      updatedAt: renderedAt,
    }).where(inArray(schema.episodes.id, [episodeId])).run()
    db.update(schema.creationTasks).set({
      status: 'succeeded',
      completedAt: renderedAt,
      updatedAt: renderedAt,
    }).where(inArray(schema.creationTasks.id, [canaryTaskId])).run()

    const approvalResponse = await dharmaRoute.request(`/episode/${episodeId}/review/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullPlanFingerprint: preflight.production_gate.fullPlan.fingerprint,
        canaryFingerprint: preflight.production_gate.canary.fingerprint,
        actor: 'route-test-producer',
        reason: 'full plan, audio evidence, and canary reviewed',
      }),
    })
    assert.equal(approvalResponse.status, 200)
    const approval = (await approvalResponse.json() as any).data
    assert.equal(approval.production_gate.fullPlan.status, 'approved')
    assert.equal(approval.production_gate.canary.status, 'approved')

    const renderResponse = await dharmaRoute.request(`/episode/${episodeId}/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    assert.equal(renderResponse.status, 200)
    const render = (await renderResponse.json() as any).data
    assert.equal(render.preview, false)
    assert.equal(getTask(render.task_id)?.payload.review_kind, undefined)
  } finally {
    rmSync(canaryOutputPath, { force: true })
  }
})

test('Dharma preflight skips canary for ordinary approved key images and a short quote', async () => {
  const { episodeId } = insertProductionFixture()
  const response = await dharmaRoute.request(`/episode/${episodeId}/preflight`, { method: 'POST' })
  const body = await response.json() as any
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.equal(body.data.production_gate.canary.requirement, 'not_required')
  assert.deepEqual(body.data.production_gate.canary.reasons, [])
})

test('Dharma preflight rejects a forged generated-image task marker', async () => {
  const { episodeId, storyboardIds } = insertProductionFixture()
  const rows = db.select().from(schema.storyboards)
    .where(inArray(schema.storyboards.id, [storyboardIds[1], storyboardIds[3]]))
    .all()
  const firstCell = JSON.parse(rows.find((row) => row.id === storyboardIds[1])?.gridCells || '{}')
  const second = rows.find((row) => row.id === storyboardIds[3])!
  const secondCell = JSON.parse(second.gridCells || '{}')
  secondCell.image.generatedSegmentTaskId = firstCell.image.generatedSegmentTaskId
  db.update(schema.storyboards).set({ gridCells: JSON.stringify(secondCell), updatedAt: now() })
    .where(inArray(schema.storyboards.id, [second.id])).run()

  const response = await dharmaRoute.request(`/episode/${episodeId}/preflight`, { method: 'POST' })
  assert.equal(response.status, 400)
  assert.match((await response.json() as any).message, /AI 关键图所有权无效/)
})

test('Dharma canary route uses only the server-selected contiguous 15-30 second window', async () => {
  const { episodeId } = insertProductionFixture({ quoteText: '真正的放下不是遗忘，而是不再让过去决定此刻，也不再让昨天替你回答今天' })
  const preflightResponse = await dharmaRoute.request(`/episode/${episodeId}/preflight`, { method: 'POST' })
  const preflightBody = await preflightResponse.json() as any
  assert.equal(preflightResponse.status, 200, JSON.stringify(preflightBody))
  const gate = preflightBody.data.production_gate
  assert.equal(gate.canary.requirement, 'required')
  assert.ok(gate.canary.window.durationSec >= 15 && gate.canary.window.durationSec <= 30)

  const customized = await dharmaRoute.request(`/episode/${episodeId}/canary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ onlyStoryboardIds: [gate.canary.window.storyboardIds[0]] }),
  })
  assert.equal(customized.status, 400)

  const canaryResponse = await dharmaRoute.request(`/episode/${episodeId}/canary`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(canaryResponse.status, 200)
  const canary = (await canaryResponse.json() as any).data
  const task = getTask(canary.task_id)
  assert.equal(task?.payload.review_kind, 'canary')
  assert.deepEqual(task?.payload.only_storyboard_ids, gate.canary.window.storyboardIds)
  assert.equal(task?.payload.max_duration_sec, gate.canary.window.durationSec)

  const repeated = await dharmaRoute.request(`/episode/${episodeId}/canary`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(repeated.status, 200)
  assert.equal((await repeated.json() as any).data.task_id, canary.task_id)

  const blocked = await dharmaRoute.request(`/episode/${episodeId}/render`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.ok([400, 409].includes(blocked.status))
  assert.match((await blocked.json() as any).message, /生产计划尚未人工审核|canary|正在进行/)
})

test('Dharma stock-assets exposes manifest-backed assets in the existing footage src format', async () => {
  const response = await dharmaRoute.request('/stock-assets')
  assert.equal(response.status, 200)

  const body = await response.json() as { data: { items: Array<Record<string, unknown>> } }
  const asset = body.data.items.find((item) => item.src === sourceA)
  assert.ok(asset)
  assert.equal(asset.kind, 'video')
  assert.equal(asset.url, `/${sourceA}`)
  assert.equal(asset.provider, sourceProvenance[sourceA].provider)
  assert.equal(asset.video_id, sourceProvenance[sourceA].videoId)
})

test('Dharma footage generation snapshots references/emotion/style/move and fingerprints every generation input', async (t) => {
  const { episodeId, storyboardIds } = insertFixture()
  const configId = bindGenerationConfig(episodeId, 'image')
  const inkStyle = findDharmaImageStyle(DHARMA_EMOTIONAL_INK_STYLE_ID)
  assert.ok(inkStyle)
  const referenceImage = `static/images/dharma-route-reference-${process.pid}-${episodeId}.png`
  const referencePath = join(repoRoot, 'data', referenceImage)
  mkdirSync(dirname(referencePath), { recursive: true })
  writeFileSync(referencePath, 'reference image')
  t.after(() => rmSync(referencePath, { force: true }))
  db.update(schema.storyboards)
    .set({
      gridCells: JSON.stringify({
        dharma: 1,
        role: 'ritual',
        emotion: 'stillness',
        styleId: DHARMA_EMOTIONAL_INK_STYLE_ID,
        image: { src: referenceImage, move: 'hold' },
      }),
      updatedAt: now(),
    })
    .where(inArray(schema.storyboards.id, [storyboardIds[2]]))
    .run()
  const request = {
    storyboard_ids: [storyboardIds[1], storyboardIds[0]],
    kind: 'image',
    prompt: '  一盏灯照亮禅室，留出宁静的文字空间  ',
    model: 'test-image-model',
    reference_images: [referenceImage],
    role: 'ritual',
    emotion: 'stillness',
    style_id: DHARMA_EMOTIONAL_INK_STYLE_ID,
    move: 'drift_left',
  }

  const response = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })

  assert.equal(response.status, 200)
  const body = await response.json() as { data: { task_id: number } }
  const task = getTask(body.data.task_id)
  assert.equal(task?.type, 'dharma.footage_generate')
  assert.deepEqual(task?.payload, {
    episode_id: episodeId,
    storyboard_ids: [storyboardIds[0], storyboardIds[1]],
    kind: 'image',
    prompt: '一盏灯照亮禅室，留出宁静的文字空间',
    config_id: configId,
    model: 'test-image-model',
    reference_images: [referenceImage],
    role: 'ritual',
    emotion: 'stillness',
    style_id: DHARMA_EMOTIONAL_INK_STYLE_ID,
    style_snapshot: snapshotDharmaImageStyle(inkStyle),
    move: 'drift_left',
  })
  assert.equal(task?.scopeType, 'episode')
  assert.equal(task?.scopeId, episodeId)

  const unknownModel = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, model: 'unconfigured-image-model' }),
  })
  assert.equal(unknownModel.status, 400)
  assert.match((await unknownModel.json() as any).message, /model.*配置|model.*configured/i)

  const unassignedReference = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, reference_images: ['static/images/not-assigned.png'] }),
  })
  assert.equal(unassignedReference.status, 400)
  assert.match((await unassignedReference.json() as any).message, /already be assigned|已指派/i)

  const repeated = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  assert.equal(repeated.status, 200)
  assert.equal((await repeated.json() as any).data.task_id, task?.id)

  const changedMove = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, move: 'drift_right' }),
  })
  assert.equal(changedMove.status, 200)
  assert.notEqual((await changedMove.json() as any).data.task_id, task?.id)

  const changedStyle = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...request,
      emotion: 'curiosity',
      style_id: DHARMA_SURREAL_DREAM_STYLE_ID,
      move: 'push',
    }),
  })
  assert.equal(changedStyle.status, 200)
  assert.notEqual((await changedStyle.json() as any).data.task_id, task?.id)

  const nextConfigId = bindGenerationConfig(episodeId, 'image')
  assert.notEqual(nextConfigId, configId)
  const changedConfig = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  assert.equal(changedConfig.status, 200)
  const changedConfigTask = getTask((await changedConfig.json() as any).data.task_id)
  assert.notEqual(changedConfigTask?.id, task?.id)
  assert.equal(changedConfigTask?.payload.config_id, nextConfigId)

  const nonContiguous = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      storyboard_ids: [storyboardIds[0], storyboardIds[2]],
      kind: 'image',
      prompt: '另一张画面',
      role: 'ritual',
      emotion: 'stillness',
      style_id: DHARMA_EMOTIONAL_INK_STYLE_ID,
      move: 'drift_right',
    }),
  })
  assert.equal(nonContiguous.status, 400)
  assert.match((await nonContiguous.json() as any).message, /contiguous|连续/)
})

test('Dharma narrative illustration generation requires structured people, relationship, action, emotion, and evidence', async () => {
  const { episodeId, storyboardIds } = insertFixture()
  const configId = bindGenerationConfig(episodeId, 'image')
  const baseRequest = {
    storyboard_ids: [storyboardIds[0]],
    kind: 'image',
    prompt: '成年子女站在安静的家中，亲人位于远处暖光里',
    role: 'human_relationship',
    emotion: 'curiosity',
    style_id: DHARMA_SURREAL_DREAM_STYLE_ID,
    move: 'push',
    shot_function: 'narrative_illustration',
  }

  const missingSemantic = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(baseRequest),
  })
  assert.equal(missingSemantic.status, 400)
  assert.match((await missingSemantic.json() as any).message, /semantic/)

  const response = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...baseRequest,
      semantic: {
        subject_count: 4,
        subjects: '一位冷静的成年子女与身后三位家人',
        relationship: '成年子女深爱家人但不被他们的情绪控制',
        action: '成年子女站在前景，身后的家人围桌交谈，双方之间留有明确距离',
        visible_emotion: '前景人物克制平静，家人温暖但无法牵动他',
        visual_evidence: '孤立前景与温暖家庭背景同时可见，距离表达边界而不是敌意',
      },
    }),
  })
  assert.equal(response.status, 200)
  const task = getTask((await response.json() as any).data.task_id)
  assert.equal(task?.payload.config_id, configId)
  assert.equal(task?.payload.role, 'human_relationship')
  assert.equal(task?.payload.shot_function, 'narrative_illustration')
  assert.deepEqual(task?.payload.semantic, {
    subjectCount: 4,
    subjects: '一位冷静的成年子女与身后三位家人',
    relationship: '成年子女深爱家人但不被他们的情绪控制',
    action: '成年子女站在前景，身后的家人围桌交谈，双方之间留有明确距离',
    visibleEmotion: '前景人物克制平静，家人温暖但无法牵动他',
    visualEvidence: '孤立前景与温暖家庭背景同时可见，距离表达边界而不是敌意',
  })
})

test('Dharma image-style catalog exposes exactly three production styles and generation rejects unknown styles', async () => {
  const stylesResponse = await dharmaRoute.request('/image-styles')
  assert.equal(stylesResponse.status, 200)
  const styles = await stylesResponse.json() as {
    data: {
      default_style_id: string
      items: Array<{
        id: string
        preview_url: string
        default_move: string
        treatment: string
        emotions: string[]
        production: boolean
      }>
    }
  }
  assert.equal(styles.data.default_style_id, DEFAULT_DHARMA_IMAGE_STYLE_ID)
  assert.deepEqual(
    styles.data.items.filter((item) => item.production).map((item) => item.id),
    [
      DHARMA_EMOTIONAL_INK_STYLE_ID,
      DHARMA_SURREAL_DREAM_STYLE_ID,
      DHARMA_MINIMAL_LIGHT_STYLE_ID,
    ],
  )
  for (const item of styles.data.items.filter((candidate) => candidate.production)) {
    assert.ok(item.preview_url.startsWith('/static/images/'))
    assert.ok(item.default_move)
    assert.ok(item.treatment)
    assert.ok(item.emotions.length > 0)
  }

  const { episodeId, storyboardIds } = insertFixture({ style: 'legacy-unknown-style' })
  bindGenerationConfig(episodeId, 'image')
  const response = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      storyboard_ids: [storyboardIds[0]],
      kind: 'image',
      prompt: '一束晨光照在佛堂门槛上',
      role: 'temple_interior',
      emotion: 'release',
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.json() as { data: { task_id: number } }
  assert.equal(getTask(body.data.task_id)?.payload.style_id, DHARMA_EMOTIONAL_INK_STYLE_ID)

  const unknown = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      storyboard_ids: [storyboardIds[0]],
      kind: 'image',
      prompt: '一束晨光照在佛堂门槛上',
      role: 'temple_interior',
      emotion: 'release',
      style_id: 'unknown-production-style',
    }),
  })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json() as any).message, /style_id is unknown/)
})

test('Dharma footage generation requires the episode kind-specific active configuration', async () => {
  const { episodeId, storyboardIds } = insertFixture()
  const response = await dharmaRoute.request(`/episode/${episodeId}/footage/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      storyboard_ids: [storyboardIds[0]],
      kind: 'video',
      prompt: '寺院晨雾与香火',
      role: 'ritual',
      emotion: 'stillness',
      style_id: DHARMA_EMOTIONAL_INK_STYLE_ID,
    }),
  })

  assert.equal(response.status, 400)
  assert.match((await response.json() as any).message, /视频.*配置|video.*config/i)
})

test('Dharma footage route rejects A-B-A atomically and accepts one contiguous asset run', async () => {
  const { episodeId, storyboardIds } = insertFixture()
  const duplicateResponse = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignments: [
        footageAssignment(storyboardIds[0], sourceA, 'contemplative_nature'),
        footageAssignment(storyboardIds[1], sourceB, 'ritual'),
        footageAssignment(storyboardIds[2], sourceA, 'contemplative_nature'),
      ],
    }),
  })
  assert.equal(duplicateResponse.status, 400)
  assert.match((await duplicateResponse.json() as any).message, /不能在不同视觉段落重复使用/)
  assert.deepEqual(
    db.select({ gridCells: schema.storyboards.gridCells }).from(schema.storyboards)
      .where(inArray(schema.storyboards.id, storyboardIds)).all()
      .map((row) => row.gridCells),
    [null, null, null],
  )

  const acceptedResponse = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignments: [
        footageAssignment(storyboardIds[0], sourceA, 'contemplative_nature'),
        footageAssignment(storyboardIds[1], sourceA, 'contemplative_nature'),
        footageAssignment(storyboardIds[2], sourceB, 'ritual'),
      ],
    }),
  })
  assert.equal(acceptedResponse.status, 200)

  const reviewResponse = await dharmaRoute.request(`/episode/${episodeId}/footage`)
  assert.equal(reviewResponse.status, 200)
  const review = await reviewResponse.json() as any
  assert.equal(review.data.asset_reuse_ready, true)
  assert.deepEqual(review.data.asset_reuse_violations, [])
  assert.equal(review.data.items[0].emotion, 'stillness')
  assert.equal(review.data.items[0].style_id, DHARMA_EMOTIONAL_INK_STYLE_ID)
})

test('Dharma footage route requires a controlled visual role', async () => {
  const { episodeId, storyboardIds } = insertFixture()
  const cases = [undefined, 'park']
  for (const role of cases) {
    const response = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assignments: [{
          storyboardId: storyboardIds[0],
          ...(role === undefined ? {} : { role }),
          video: videoAssignment(sourceA),
        }],
      }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json() as any).message, /视觉角色必须是/)
  }
})

test('Dharma footage route rejects conflicting roles within one adjacent canonical video segment', async () => {
  const { episodeId, storyboardIds } = insertFixture()
  const response = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignments: [
        footageAssignment(storyboardIds[0], sourceA, 'contemplative_nature'),
        footageAssignment(storyboardIds[1], sourceA, 'ritual'),
      ],
    }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json() as any).message, /同一连续视频段落不能混用视觉角色/)
  assert.deepEqual(
    db.select({ gridCells: schema.storyboards.gridCells }).from(schema.storyboards)
      .where(inArray(schema.storyboards.id, storyboardIds)).all()
      .map((row) => row.gridCells),
    [null, null, null],
  )
})

test('Dharma footage route completes provenance from an exact stock manifest match and rejects mismatches', async () => {
  const { episodeId, storyboardIds } = insertFixture()
  const response = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignments: [{
        storyboardId: storyboardIds[0],
        role: 'ritual',
        emotion: 'stillness',
        style_id: DHARMA_EMOTIONAL_INK_STYLE_ID,
        video: { src: sourceA },
      }],
    }),
  })
  assert.equal(response.status, 200)
  const [assigned] = db.select().from(schema.storyboards)
    .where(inArray(schema.storyboards.id, [storyboardIds[0]]))
    .all()
  const assignedVideo = JSON.parse(assigned.gridCells || '{}').video
  assert.equal(assignedVideo.src, sourceA)
  assert.equal(assignedVideo.provider, sourceProvenance[sourceA].provider)
  assert.equal(assignedVideo.videoId, sourceProvenance[sourceA].videoId)
  assert.equal(assignedVideo.sourceUrl, sourceProvenance[sourceA].sourceUrl)
  assert.equal(assignedVideo.licenseUrl, sourceProvenance[sourceA].licenseUrl)
  assert.equal(assignedVideo.creator, sourceProvenance[sourceA].creator)
  assert.equal(typeof assignedVideo.durationSec, 'number')

  const mismatch = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignments: [{
        storyboardId: storyboardIds[0],
        role: 'ritual',
        emotion: 'stillness',
        style_id: DHARMA_EMOTIONAL_INK_STYLE_ID,
        video: { ...videoAssignment(sourceA), creator: 'not-the-manifest-creator' },
      }],
    }),
  })
  assert.equal(mismatch.status, 400)
  assert.match((await mismatch.json() as any).message, /与 stock manifest 不匹配/)
})

test('Dharma footage route rejects quote text that would overflow the sacred center treatment', async () => {
  const { episodeId, storyboardIds } = insertFixture()
  const response = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignments: [{
        storyboardId: storyboardIds[0],
        role: 'ritual',
        emotion: 'stillness',
        style_id: DHARMA_EMOTIONAL_INK_STYLE_ID,
        video: videoAssignment(sourceA),
        quote: { text: '一'.repeat(37) },
      }],
    }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json() as any).message, /最多 36 个字符/)
})

test('Dharma footage metadata edits preserve generated image ownership only for the same source', async () => {
  const { dramaId, episodeId, storyboardIds } = insertFixture({ storyboardCount: 1 })
  const generatedImageSrc = 'static/images/wabi-sabi-minimal.png'
  const replacementImageSrc = 'static/images/song-dynasty-aesthetic.png'
  const generatedSegmentTaskId = insertGeneratedImageEvidence({
    dramaId,
    episodeId,
    storyboardId: storyboardIds[0],
    src: generatedImageSrc,
    role: 'ritual',
    emotion: 'insight',
    styleId: DHARMA_MINIMAL_LIGHT_STYLE_ID,
    move: 'hold',
  })
  db.update(schema.storyboards).set({
    gridCells: JSON.stringify({
      dharma: 1,
      role: 'ritual',
      emotion: 'insight',
      styleId: DHARMA_MINIMAL_LIGHT_STYLE_ID,
      image: {
        src: generatedImageSrc,
        move: 'hold',
        generatedSegmentTaskId,
      },
    }),
    updatedAt: now(),
  }).where(inArray(schema.storyboards.id, storyboardIds)).run()

  const quoteResponse = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignments: [{
        storyboardId: storyboardIds[0],
        role: 'ritual',
        emotion: 'insight',
        style_id: DHARMA_MINIMAL_LIGHT_STYLE_ID,
        image: { src: generatedImageSrc, move: 'hold' },
        quote: { text: '照见当下', source: '测试金句' },
      }],
    }),
  })
  assert.equal(quoteResponse.status, 200)
  const [quotedStoryboard] = db.select().from(schema.storyboards)
    .where(inArray(schema.storyboards.id, storyboardIds)).all()
  const quotedCell = JSON.parse(quotedStoryboard.gridCells || '{}')
  assert.equal(quotedCell.image.generatedSegmentTaskId, generatedSegmentTaskId)
  assert.deepEqual(quotedCell.quote, { text: '照见当下', source: '测试金句' })

  const replacementResponse = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignments: [{
        storyboardId: storyboardIds[0],
        role: 'ritual',
        emotion: 'insight',
        style_id: DHARMA_MINIMAL_LIGHT_STYLE_ID,
        image: { src: replacementImageSrc, move: 'hold' },
        quote: { text: '照见当下', source: '测试金句' },
      }],
    }),
  })
  assert.equal(replacementResponse.status, 200)
  const [replacedStoryboard] = db.select().from(schema.storyboards)
    .where(inArray(schema.storyboards.id, storyboardIds)).all()
  const replacedCell = JSON.parse(replacedStoryboard.gridCells || '{}')
  assert.equal(replacedCell.image.src, replacementImageSrc)
  assert.equal(Object.hasOwn(replacedCell.image, 'generatedSegmentTaskId'), false)
})

test('Dharma full-footage replacement clears stale quotes that are not in the new plan', async () => {
  const { episodeId, storyboardIds } = insertFixture()
  db.update(schema.storyboards)
    .set({
      gridCells: JSON.stringify({
        dharma: 1,
        video: videoAssignment(sourceA),
        quote: { text: 'legacy quote that must not survive a full replacement' },
      }),
      updatedAt: now(),
    })
    .where(inArray(schema.storyboards.id, [storyboardIds[0]]))
    .run()

  const response = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      assignments: [
        footageAssignment(storyboardIds[0], sourceA, 'contemplative_nature'),
        footageAssignment(storyboardIds[1], sourceA, 'contemplative_nature'),
        footageAssignment(storyboardIds[2], sourceB, 'ritual'),
      ],
    }),
  })
  assert.equal(response.status, 200)

  const review = await dharmaRoute.request(`/episode/${episodeId}/footage`)
  assert.equal((await review.json() as any).data.items[0].quote, null)
})

test('Dharma footage route rejects absolute and traversal paths before they can reach public staging', async () => {
  const { episodeId, storyboardIds } = insertFixture()
  for (const src of ['/etc/hosts', 'static/remotion/stock/../../../../etc/hosts']) {
    const response = await dharmaRoute.request(`/episode/${episodeId}/footage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assignments: [{
          storyboardId: storyboardIds[0],
          role: 'ritual',
          emotion: 'stillness',
          style_id: DHARMA_EMOTIONAL_INK_STYLE_ID,
          video: { src },
        }],
      }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json() as any).message, /素材路径/)
  }
})

test('Dharma footage review exposes an authoritative visual-plan readiness summary', async () => {
  const { episodeId } = insertProductionFixture()

  const reviewResponse = await dharmaRoute.request(`/episode/${episodeId}/footage`)
  assert.equal(reviewResponse.status, 200)
  const visualPlan = (await reviewResponse.json() as any).data.visual_plan
  assert.equal(visualPlan.role_ready, true)
  assert.equal(visualPlan.timing_ready, true)
  assert.equal(visualPlan.sacred_coverage_ratio, 1)
  assert.equal(visualPlan.early_sacred_start_sec, 0)
  assert.equal(visualPlan.early_sacred_ready, true)
  assert.deepEqual(visualPlan.emotional_style_ids, [
    DHARMA_SURREAL_DREAM_STYLE_ID,
    DHARMA_EMOTIONAL_INK_STYLE_ID,
    DHARMA_MINIMAL_LIGHT_STYLE_ID,
  ])
  assert.deepEqual(visualPlan.emotion_sequence, [
    'curiosity',
    'stillness',
    'tension',
    'acceptance',
    'insight',
    'release',
  ])
  assert.equal(visualPlan.generated_image_coverage_ratio, 0.5)
  assert.equal(visualPlan.video_coverage_ratio, 0.5)
  assert.equal(visualPlan.ready, true)
})

test('Dharma render route requires production admission and keeps legacy pilot previews isolated', async () => {
  const { episodeId } = insertFixture()
  const fullResponse = await dharmaRoute.request(`/episode/${episodeId}/render`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal(fullResponse.status, 400)
  assert.match((await fullResponse.json() as any).message, /生产门禁|全片生产预检/)

  const pilotResponse = await dharmaRoute.request(`/episode/${episodeId}/render`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxDurationSec: 60 }),
  })
  assert.equal(pilotResponse.status, 200)
  const pilot = await pilotResponse.json() as any
  assert.equal(pilot.data.preview, true)

  const samePilotResponse = await dharmaRoute.request(`/episode/${episodeId}/render`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxDurationSec: 60 }),
  })
  assert.equal(samePilotResponse.status, 200)
  assert.equal((await samePilotResponse.json() as any).data.task_id, pilot.data.task_id)

  const differentPreviewResponse = await dharmaRoute.request(`/episode/${episodeId}/render`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxDurationSec: 30 }),
  })
  assert.equal(differentPreviewResponse.status, 409)
})

test('Dharma render route rejects malformed preview inputs instead of silently starting a full render', async () => {
  const { episodeId } = insertFixture()
  const cases: Array<{ body: unknown; message: RegExp }> = [
    { body: [], message: /render body must be an object/ },
    { body: { onlyStoryboardIds: [] }, message: /onlyStoryboardIds must not be empty/ },
    { body: { onlyStoryboardIds: ['not-a-storyboard'] }, message: /onlyStoryboardIds must contain/ },
    { body: { onlyStoryboardIds: 1 }, message: /onlyStoryboardIds must be a non-empty array/ },
    { body: { maxDurationSec: 0 }, message: /maxDurationSec must be a positive/ },
    { body: { maxDurationSec: 'not-a-duration' }, message: /maxDurationSec must be a positive/ },
  ]
  for (const { body, message } of cases) {
    const response = await dharmaRoute.request(`/episode/${episodeId}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.match((await response.json() as any).message, message)
  }
  assert.equal(
    db.select().from(schema.creationTasks)
      .where(inArray(schema.creationTasks.episodeId, [episodeId])).all().length,
    0,
  )
})

test('Dharma render route does not enqueue work for a soft-deleted episode', async () => {
  const { episodeId } = insertFixture()
  db.update(schema.episodes)
    .set({ deletedAt: now(), updatedAt: now() })
    .where(inArray(schema.episodes.id, [episodeId]))
    .run()

  const response = await dharmaRoute.request(`/episode/${episodeId}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxDurationSec: 60 }),
  })

  assert.ok([404, 409].includes(response.status))
  assert.equal(
    db.select().from(schema.creationTasks)
      .where(inArray(schema.creationTasks.episodeId, [episodeId])).all().length,
    0,
  )

  const approveResponse = await dharmaRoute.request(`/episode/${episodeId}/pilot/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(approveResponse.status, 404)
})

test('Dharma render route blocks new work while a commit-claimed render awaits reconciliation', async () => {
  const { episodeId } = insertFixture()
  const pendingReconciliation = createPendingDharmaRenderReconciliation(episodeId)

  const response = await dharmaRoute.request(`/episode/${episodeId}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxDurationSec: 60 }),
  })
  const payload = await response.json() as { message?: string; data?: { task_id?: number } }

  assert.equal(response.status, 409)
  assert.match(payload.message || '', /reconciliation|对账|核对/i)
  assert.equal(payload.data?.task_id, pendingReconciliation.id)
  assert.equal(
    db.select().from(schema.creationTasks).where(inArray(schema.creationTasks.episodeId, [episodeId])).all().length,
    1,
  )
})

test('Dharma reconciliation fails closed without the task control token', async () => {
  const { episodeId } = insertFixture()
  const pendingReconciliation = createPendingDharmaRenderReconciliation(episodeId)
  const body = {
    resolution: 'discard_unpublished',
    reason: 'Verified that no delivery pointer was committed.',
    actor: 'render-operator',
    confirmation: `RECONCILE ${pendingReconciliation.id}`,
  }

  await withTaskControlToken(undefined, async () => {
    const response = await dharmaRoute.request(`/episode/${episodeId}/render/${pendingReconciliation.id}/reconcile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(response.status, 403)
  })

  assert.equal(getTask(pendingReconciliation.id)?.errorCode, 'task_commit_claimed_reconciliation_required')
})

test('Dharma reconciliation records a verified unpublished decision before reopening render admission', async () => {
  const { episodeId } = insertFixture()
  const pendingReconciliation = createPendingDharmaRenderReconciliation(episodeId)
  const body = {
    resolution: 'discard_unpublished',
    reason: 'Verified that the task-private output was never attached to this episode.',
    actor: 'render-operator',
    confirmation: `RECONCILE ${pendingReconciliation.id}`,
  }

  await withTaskControlToken('reconcile-control-token', async () => {
    const response = await dharmaRoute.request(`/episode/${episodeId}/render/${pendingReconciliation.id}/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-task-control-token': 'reconcile-control-token' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
  })

  assert.equal(getTask(pendingReconciliation.id)?.errorCode, 'task_commit_claimed_reconciled')
  const event = listTaskEvents(pendingReconciliation.id).find((item) => item.eventType === 'dharma.episode.render.reconciled')
  assert.deepEqual(event?.data, {
    resolution: 'discard_unpublished',
    reason: body.reason,
    declared_actor: body.actor,
    expected_output: `static/remotion/dharma-ep${episodeId}-task${pendingReconciliation.id}.mp4`,
    pointer_matches_output: false,
  })

  const renderResponse = await dharmaRoute.request(`/episode/${episodeId}/render`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxDurationSec: 60 }),
  })
  assert.equal(renderResponse.status, 200)
})

test('Dharma reconciliation only retains a matching published pointer', async () => {
  const { episodeId } = insertFixture()
  const pendingReconciliation = createPendingDharmaRenderReconciliation(episodeId)
  const output = `static/remotion/dharma-ep${episodeId}-task${pendingReconciliation.id}.mp4`
  db.update(schema.episodes)
    .set({ videoUrl: output, updatedAt: now() })
    .where(inArray(schema.episodes.id, [episodeId]))
    .run()

  await withTaskControlToken('reconcile-control-token', async () => {
    const discard = await dharmaRoute.request(`/episode/${episodeId}/render/${pendingReconciliation.id}/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-task-control-token': 'reconcile-control-token' },
      body: JSON.stringify({
        resolution: 'discard_unpublished',
        reason: 'This must not clear a published pointer.',
        actor: 'render-operator',
        confirmation: `RECONCILE ${pendingReconciliation.id}`,
      }),
    })
    assert.equal(discard.status, 409)

    const retain = await dharmaRoute.request(`/episode/${episodeId}/render/${pendingReconciliation.id}/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-task-control-token': 'reconcile-control-token' },
      body: JSON.stringify({
        resolution: 'retain_published',
        reason: 'Verified that this task committed the current episode delivery pointer.',
        actor: 'render-operator',
        confirmation: `RECONCILE ${pendingReconciliation.id}`,
      }),
    })
    assert.equal(retain.status, 200)
  })

  assert.equal(getTask(pendingReconciliation.id)?.errorCode, 'task_commit_claimed_reconciled')
  const [episode] = db.select().from(schema.episodes).where(inArray(schema.episodes.id, [episodeId])).all()
  assert.equal(episode.videoUrl, output)
})

test('Dharma reconciliation treats legacy camelCase preview fields as the historical formal artifact', async () => {
  const { episodeId } = insertFixture()
  const pendingReconciliation = createPendingDharmaRenderReconciliation(episodeId, {
    episodeId,
    maxDurationSec: 60,
  })
  const historicalFormalOutput = `static/remotion/dharma-ep${episodeId}-task${pendingReconciliation.id}.mp4`
  db.update(schema.episodes)
    .set({ videoUrl: historicalFormalOutput, updatedAt: now() })
    .where(inArray(schema.episodes.id, [episodeId]))
    .run()

  await withTaskControlToken('reconcile-control-token', async () => {
    const response = await dharmaRoute.request(`/episode/${episodeId}/render/${pendingReconciliation.id}/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-task-control-token': 'reconcile-control-token' },
      body: JSON.stringify({
        resolution: 'discard_unpublished',
        reason: 'The historical worker published its formal immutable artifact.',
        actor: 'render-operator',
        confirmation: `RECONCILE ${pendingReconciliation.id}`,
      }),
    })
    assert.equal(response.status, 409)
  })

  assert.equal(getTask(pendingReconciliation.id)?.errorCode, 'task_commit_claimed_reconciliation_required')
  assert.equal(
    listTaskEvents(pendingReconciliation.id).some(event => event.eventType === 'dharma.episode.render.reconciled'),
    false,
  )
})

test('Dharma pilot approval rejects a non-60-second preview even when its metadata is marked rendered', async () => {
  const { episodeId } = insertFixture()
  const inputFingerprint = buildDharmaEpisodeInputFingerprint(episodeId)
  const metadata = {
    dharmaPilot: {
      status: 'rendered',
      output: `static/remotion/dharma-ep${episodeId}-preview-task77.mp4`,
      inputFingerprint,
      taskId: 77,
      requestedDurationSec: 30,
      renderedAt: now(),
    },
  }
  db.update(schema.episodes)
    .set({ metadata: JSON.stringify(metadata), updatedAt: now() })
    .where(inArray(schema.episodes.id, [episodeId]))
    .run()

  const response = await dharmaRoute.request(`/episode/${episodeId}/pilot/approve`, { method: 'POST' })
  assert.equal(response.status, 400)
  assert.match((await response.json() as any).message, /60 秒 pilot/)

  const reviewResponse = await dharmaRoute.request(`/episode/${episodeId}/footage`)
  const review = await reviewResponse.json() as any
  assert.equal(review.data.pilot_approval.approved, false)
  assert.match(review.data.pilot_approval.reason, /60 秒 pilot/)
  assert.equal(review.data.pilot_review, null)
})

test('Dharma pilot approval rejects a short output even when the request asked for 60 seconds', async () => {
  const { episodeId } = insertFixture()
  const inputFingerprint = buildDharmaEpisodeInputFingerprint(episodeId)
  db.update(schema.episodes)
    .set({
      metadata: JSON.stringify({
        dharmaPilot: {
          status: 'rendered',
          output: `static/remotion/dharma-ep${episodeId}-pilot-60s-task79.mp4`,
          inputFingerprint,
          taskId: 79,
          requestedDurationSec: 60,
          durationSec: 58.816,
          renderedAt: now(),
        },
      }),
      updatedAt: now(),
    })
    .where(inArray(schema.episodes.id, [episodeId]))
    .run()

  const response = await dharmaRoute.request(`/episode/${episodeId}/pilot/approve`, { method: 'POST' })
  assert.equal(response.status, 400)
  assert.match((await response.json() as any).message, /实际输出不是精确 60 秒/)
})

test('Dharma footage review exposes an approved successful exact-60-second pilot', async () => {
  const { episodeId } = insertFixture({ episodeId: reviewPilotEpisodeId })
  const inputFingerprint = buildDharmaEpisodeInputFingerprint(episodeId)
  const output = `static/remotion/dharma-ep${episodeId}-pilot-60s.mp4`
  const outputPath = join(repoRoot, 'data', output)
  assert.equal(existsSync(outputPath), false, 'test pilot path must not replace a production artifact')
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, 'test pilot output')
  try {
    db.update(schema.episodes)
      .set({
        metadata: JSON.stringify({
          dharmaPilot: {
            status: 'rendered',
            output,
            inputFingerprint,
            taskId: 88,
            requestedDurationSec: 60,
            durationSec: 60,
            renderedAt: now(),
          },
        }),
        updatedAt: now(),
      })
      .where(inArray(schema.episodes.id, [episodeId]))
      .run()

    const approvalResponse = await dharmaRoute.request(`/episode/${episodeId}/pilot/approve`, { method: 'POST' })
    assert.equal(approvalResponse.status, 200)
    const approval = await approvalResponse.json() as any
    assert.equal(approval.data.episode_id, episodeId)
    assert.equal(approval.data.input_fingerprint, inputFingerprint)
    assert.equal(typeof approval.data.approved_at, 'string')

    const reviewResponse = await dharmaRoute.request(`/episode/${episodeId}/footage`)
    assert.equal(reviewResponse.status, 200)
    const review = await reviewResponse.json() as any
    assert.deepEqual(review.data.pilot_approval, { approved: true })
    assert.equal(review.data.pilot_review.status, 'approved')
    assert.equal(review.data.pilot_review.output, output)
    assert.equal(review.data.pilot_review.inputFingerprint, inputFingerprint)
    assert.equal(review.data.pilot_review.taskId, 88)
    assert.equal(review.data.pilot_review.requestedDurationSec, 60)
    assert.equal(review.data.pilot_review.durationSec, 60)
    assert.equal(typeof review.data.pilot_review.approvedAt, 'string')
  } finally {
    rmSync(outputPath, { force: true })
  }
})
