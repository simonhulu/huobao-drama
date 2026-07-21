import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-remotion-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const {
  createRemotionProjectFromEpisode,
  createRemotionProjectFromScript,
  enqueueRemotionImageAsset,
  getRemotionProjectSnapshot,
  getRemotionAssets,
  initializeRemotionFactory,
  planRemotionProject,
  resolveRemotionStoryboards,
  listRemotionProductionTree,
  REMOTION_STAGES,
  recordRemotionStageRun,
  upsertRemotionAsset,
  syncRemotionAssetForImageGeneration,
  upsertRemotionRender,
  upsertRemotionShots,
} = await import('./remotion.js')
const { syncRelatedImageTables } = await import('./image-generation-sync.js')

function timestamp() {
  return new Date().toISOString()
}

const testAccountId = Number(db.insert(schema.mediaAccounts).values({
  name: '测试自媒体账号',
  positioningJson: JSON.stringify({ audience: '测试观众', promise: '验证生产契约', tone: '克制' }),
  createdAt: timestamp(),
  updatedAt: timestamp(),
}).run().lastInsertRowid)

const otherAccountId = Number(db.insert(schema.mediaAccounts).values({
  name: '另一个自媒体账号',
  positioningJson: JSON.stringify({ audience: '另一组观众', promise: '验证账号隔离', tone: '冷静' }),
  createdAt: timestamp(),
  updatedAt: timestamp(),
}).run().lastInsertRowid)

test('Remotion can start from a standalone narration script', () => {
  const project = createRemotionProjectFromScript('第一段口播。第二段口播。', {
    title: '独立口播入口',
    mediaAccountId: testAccountId,
  })
  if (!project) throw new Error('project creation failed')
  assert.equal(project.project.sourceType, 'script')
  assert.equal(project.project.sourceEpisodeId, null)
  assert.equal(project.project.sourceSnapshot.episode.scriptContent, '第一段口播。第二段口播。')
  assert.equal(project.project.sourceSnapshot.storyboards.length, 0)
  assert.equal(project.project.mediaAccountId, testAccountId)
  assert.equal(project.project.positioningSnapshot?.account?.name, '测试自媒体账号')
})

test('Remotion rejects long standalone scripts so they must use smart episode intake', () => {
  assert.throws(
    () => createRemotionProjectFromScript('长稿'.repeat(500), {
      title: '必须智能分集的长稿',
      mediaAccountId: testAccountId,
    }),
    /must use \/api\/v1\/remotion\/projects\/intake/,
  )
})

test('Remotion refuses a standalone script without an explicit positioned account', () => {
  assert.throws(
    () => createRemotionProjectFromScript('没有账号不应开始生产。', { title: '缺少账号' }),
    /media_account_id is required/,
  )
})

test('Remotion refuses an account override that differs from the content project', () => {
  const ts = timestamp()
  const dramaId = Number(db.insert(schema.dramas).values({
    mediaAccountId: testAccountId,
    title: '账号隔离测试项目',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '账号隔离测试集',
    content: '账号必须继承内容项目。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  assert.throws(
    () => createRemotionProjectFromEpisode(episodeId, { mediaAccountId: otherAccountId }),
    /belongs to media account/,
  )
})

test('Remotion shot writes enforce the default and hard duration limits', () => {
  const project = createRemotionProjectFromScript('镜头节奏校验。', {
    title: '镜头节奏校验',
    mediaAccountId: testAccountId,
  })
  if (!project) throw new Error('project creation failed')

  assert.throws(() => upsertRemotionShots(project.project.id, [{
    shotNumber: 1,
    durationMs: 90000,
    shotType: 'ai_plate',
    visualPlan: { schemaVersion: 1 },
  }]), /hard duration limit/)

  const [longShot] = upsertRemotionShots(project.project.id, [{
    shotNumber: 1,
    durationMs: 10000,
    shotType: 'map',
    visualPlan: {
      schemaVersion: 1,
      longShotJustification: '完整呈现路线从起点到终点的移动。',
    },
  }])
  assert.equal(longShot.durationMs, 10000)
})

test('Remotion refuses to plan an episode when semantic storyboards are absent', () => {
  const ts = timestamp()
  const dramaId = Number(db.insert(schema.dramas).values({
    mediaAccountId: testAccountId,
    title: '无旧分镜回退测试',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '原稿可规划',
    content: '第一段历史叙事，说明背景与冲突。第二段历史叙事，说明关键转折与结果。',
    scriptContent: '第一段历史叙事，说明背景与冲突。第二段历史叙事，说明关键转折与结果。',
    duration: 8,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const project = createRemotionProjectFromEpisode(episodeId)
  if (!project) throw new Error('project creation failed')
  assert.throws(
    () => planRemotionProject(project.project.id),
    /requires semantic source storyboards; run storyboard_breaker first/,
  )
})

test('Remotion resolves staged storyboards before frozen source storyboards', () => {
  const source = [{ storyboardNumber: 1, title: 'source' }]
  const staged = [{ storyboardNumber: 1, title: 'staged' }]
  assert.equal(resolveRemotionStoryboards(source, staged)[0]?.title, 'staged')
  assert.equal(resolveRemotionStoryboards(source, [])[0]?.title, 'source')
  assert.throws(
    () => resolveRemotionStoryboards([], []),
    /requires semantic source storyboards; run storyboard_breaker first/,
  )
})

test('Remotion project imports a source snapshot without mutating legacy storyboard media', () => {
  const ts = timestamp()
  const dramaId = Number(db.insert(schema.dramas).values({
    mediaAccountId: testAccountId,
    title: '白银航路',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 9,
    title: '流向改变',
    content: '口播原文',
    scriptContent: '脚本原文',
    duration: 8,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const characterId = Number(db.insert(schema.characters).values({
    dramaId,
    name: '港口商人',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const sceneId = Number(db.insert(schema.scenes).values({
    dramaId,
    episodeId,
    location: '广州港',
    time: '清晨',
    prompt: '广州港的清晨',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '港口',
    sceneId,
    action: '港口商人把白银装上船。',
    narration: '白银从港口出发。',
    duration: 8,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()

  const beforeStoryboards = db.select().from(schema.storyboards).all().length
  const project = createRemotionProjectFromEpisode(episodeId)
  assert.ok(project)
  if (!project) throw new Error('project creation failed')
  assert.equal(project.project.sourceEpisodeId, episodeId)
  assert.equal(project.project.sourceSnapshot.storyboards.length, 1)
  assert.deepEqual(project.project.sourceSnapshot.storyboards[0], {
    id: storyboardId,
    storyboardNumber: 1,
    sceneId,
    characterIds: [characterId],
    people: ['港口商人'],
    title: '港口',
    location: null,
    time: null,
    shotType: null,
    angle: null,
    movement: null,
    action: '港口商人把白银装上船。',
    result: null,
    atmosphere: null,
    imagePrompt: null,
    videoPrompt: null,
    dialogue: null,
    narration: '白银从港口出发。',
    description: null,
    duration: 8,
    energyLevel: 'medium',
    firstFrameImage: null,
    lastFrameImage: null,
    composedImage: null,
    narrationAudioUrl: null,
  })
  assert.equal(project.stages.find((stage) => stage.stage === 'source_snapshot')?.status, 'succeeded')
  assert.deepEqual(project.stages.find((stage) => stage.stage === 'source_snapshot')?.output, {
    schemaVersion: 1,
    factoryStage: 'source_snapshot',
    attempt: 1,
    artifacts: [],
    checks: [],
    risks: [],
    sourceHash: project.project.sourceHash,
    sourceType: 'episode',
    episodeId,
    positioningSnapshot: project.project.positioningSnapshot,
    storyboardCount: 1,
  })
  assert.deepEqual([project.project.progressCurrent, project.project.progressTotal], [1, 11])
  assert.equal(db.select().from(schema.storyboards).all().length, beforeStoryboards)
  assert.equal(db.select().from(schema.imageGenerations).all().length, 0)

  const shots = upsertRemotionShots(project.project.id, [{
    shotNumber: 1,
    sourceStoryboardId: storyboardId,
    title: '地图建立',
    narration: '白银从港口出发。',
    durationMs: 8000,
    shotType: 'map',
    visualPlan: {
      schemaVersion: 1,
      visualMode: 'map-svg',
      beats: [{ start: 0, end: 8000, motion: 'route reveal' }],
    },
    sourceEvidence: { narration: '白银从港口出发。' },
  }])
  assert.equal(shots[0]?.shotType, 'map')
  assert.equal(getRemotionProjectSnapshot(project.project.id)?.shots.length, 1)
  assert.deepEqual([
    getRemotionProjectSnapshot(project.project.id)?.project.currentStage,
    getRemotionProjectSnapshot(project.project.id)?.project.progressCurrent,
    getRemotionProjectSnapshot(project.project.id)?.project.progressTotal,
  ], ['storyboard', 3, 11])

  recordRemotionStageRun({
    projectId: project.project.id,
    stage: 'historical_analysis',
    input: { sourceHash: project.project.sourceHash },
    output: {
      schemaVersion: 1,
      factoryStage: 'historical_analysis',
      artifacts: [],
      checks: [],
      risks: [],
      claims: [],
      people: [],
      locations: [],
      routes: [],
      beats: ['迁徙', '贸易'],
    },
  })
  assert.equal(getRemotionProjectSnapshot(project.project.id)?.stages.find((stage) => stage.stage === 'historical_analysis')?.status, 'succeeded')
})

test('Remotion factory initializes all eleven native stages and preserves legacy rows', () => {
  const project = createRemotionProjectFromScript('工厂阶段初始化测试。', { title: '十一阶段工厂', mediaAccountId: testAccountId })
  if (!project) throw new Error('project creation failed')

  recordRemotionStageRun({
    projectId: project.project.id,
    stage: 'script_analysis',
    output: { schemaVersion: 1, characters: ['测试人物'] },
  })
  recordRemotionStageRun({
    projectId: project.project.id,
    stage: 'qa',
    output: { schemaVersion: 1, passed: true, checks: ['legacy qa'] },
  })
  assert.notEqual(getRemotionProjectSnapshot(project.project.id)?.project.status, 'completed')
  const initialized = initializeRemotionFactory(project.project.id)
  if (!initialized) throw new Error('factory initialization failed')

  assert.deepEqual(
    initialized.stages.filter((stage) => stage.stage === stage.canonicalStage).map((stage) => stage.canonicalStage),
    [...REMOTION_STAGES],
  )
  assert.equal(initialized.stages.some((stage) => stage.legacyStage === 'script_analysis'), true)
  assert.equal(initialized.project.canonicalStage, 'historical_analysis')
  assert.deepEqual([initialized.project.progressCurrent, initialized.project.progressTotal], [1, 11])
})

test('Remotion production tree groups Episodes and selects the latest production record', () => {
  const ts = timestamp()
  const dramaId = Number(db.insert(schema.dramas).values({
    mediaAccountId: testAccountId,
    title: '生产树测试项目',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 3,
    title: '有生产记录的集',
    content: '第一版内容',
    scriptContent: '第一版内容',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const emptyEpisodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 4,
    title: '尚未开始的集',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const first = createRemotionProjectFromEpisode(episodeId, { title: '第一版 Remotion' })
  db.update(schema.episodes).set({ content: '第二版内容', scriptContent: '第二版内容', updatedAt: timestamp() })
    .where(eq(schema.episodes.id, episodeId)).run()
  const second = createRemotionProjectFromEpisode(episodeId, { title: '第二版 Remotion' })
  assert.ok(first && second)
  if (!first || !second) throw new Error('project creation failed')
  assert.notEqual(first.project.id, second.project.id)

  const tree = listRemotionProductionTree()
  const group = tree.find((item) => item.drama.id === dramaId)
  assert.ok(group)
  if (!group) throw new Error('production tree group missing')
  const current = group.episodes.find((item) => item.episode?.id === episodeId)
  const notStarted = group.episodes.find((item) => item.episode?.id === emptyEpisodeId)
  assert.equal(current?.production?.id, second.project.id)
  assert.equal(current?.productionCount, 2)
  assert.equal(notStarted?.production, null)
})

test('Remotion AI image task is isolated and image worker completion updates asset state', () => {
  const ts = timestamp()
  const dramaId = Number(db.insert(schema.dramas).values({
    mediaAccountId: testAccountId,
    title: '任务状态测试',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '第一集',
    duration: 4,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '人物',
    narration: '一个人走进港口。',
    duration: 4,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image',
    provider: 'openai',
    name: 'test-image',
    baseUrl: 'https://example.invalid',
    apiKey: 'test-key',
    model: JSON.stringify(['gpt-image-1']),
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const project = createRemotionProjectFromEpisode(episodeId)
  if (!project) throw new Error('project creation failed')
  const [shot] = upsertRemotionShots(project.project.id, [{
    shotNumber: 1,
    title: '独立人物',
    durationMs: 4000,
    shotType: 'character',
    visualPlan: { subject: 'single character' },
  }])
  const result = enqueueRemotionImageAsset({
    projectId: project.project.id,
    shotId: shot.id,
    prompt: '电影感单人物港口镜头，无文字',
    assetKey: 'shot-1-character-plate',
    assetType: 'character',
  })
  assert.equal(result.task?.type, 'image.generate')
  assert.equal(result.task?.scopeType, 'remotion_asset')
  assert.equal(result.asset.status, 'queued')
  assert.equal(result.asset.assetType, 'character')
  assert.equal((result.asset.metadata as any)?.alphaReady, false)
  assert.equal(result.asset.imageGenerationId != null, true)

  const [generation] = db.select().from(schema.imageGenerations).all().filter((row) => row.id === result.asset.imageGenerationId)
  assert.equal(generation?.storyboardId, null)
  assert.equal(db.select().from(schema.storyboards).all().filter((row) => row.episodeId === episodeId).length, 1)

  db.transaction((tx) => {
    syncRelatedImageTables(tx, result.asset.imageGenerationId!, 'static/images/remotion-test.png', 'https://example.invalid/remotion-test.png')
  })
  const snapshot = getRemotionProjectSnapshot(project.project.id)
  assert.equal(snapshot?.shots[0]?.assets[0]?.status, 'completed')
  assert.equal(snapshot?.shots[0]?.assets[0]?.localPath, 'static/images/remotion-test.png')
  assert.equal(snapshot?.shots[0]?.status, 'asset_pending')
  upsertRemotionAsset(project.project.id, {
    shotId: shot.id,
    assetKey: result.asset.assetKey,
    assetType: 'character',
    status: 'completed',
    localPath: 'static/images/remotion-test-alpha.png',
    version: 2,
    metadata: { requiresAlpha: true, alphaReady: true },
  })
  assert.equal(getRemotionProjectSnapshot(project.project.id)?.shots[0]?.status, 'ready')
})

test('Remotion image retries create a new asset version and preserve the failed version', () => {
  const project = createRemotionProjectFromScript('重试版本测试。', { title: '重试版本测试', mediaAccountId: testAccountId })
  if (!project) throw new Error('project creation failed')
  const [shot] = upsertRemotionShots(project.project.id, [{
    shotNumber: 1,
    title: '重试镜头',
    durationMs: 4000,
    shotType: 'ai_plate',
    visualPlan: { schemaVersion: 1, visualMode: 'crop' },
  }])

  const first = enqueueRemotionImageAsset({
    projectId: project.project.id,
    shotId: shot.id,
    assetKey: 'retryable-plate',
    prompt: '第一次生成',
  })
  upsertRemotionAsset(project.project.id, {
    shotId: shot.id,
    assetKey: first.asset.assetKey,
    assetType: 'ai_image',
    version: 1,
    status: 'failed',
    errorCode: 'provider_timeout',
    errorMessage: '首次超时',
  })

  const second = enqueueRemotionImageAsset({
    projectId: project.project.id,
    shotId: shot.id,
    assetKey: 'retryable-plate',
    prompt: '第二次生成',
  })
  assert.equal(second.asset.version, 2)
  assert.equal(getRemotionAssets(project.project.id).filter((asset) => asset.assetKey === 'retryable-plate').length, 1)
  assert.equal(getRemotionAssets(project.project.id).find((asset) => asset.assetKey === 'retryable-plate')?.version, 2)
  assert.equal(db.select().from(schema.remotionAssets)
    .where(eq(schema.remotionAssets.projectId, project.project.id)).all()
    .filter((asset) => asset.assetKey === 'retryable-plate').length, 2)
})

test('Remotion asset writes reject a shot from another project and sync timestamps', () => {
  const firstProject = createRemotionProjectFromScript('项目一。', { title: '项目一', mediaAccountId: testAccountId })
  const secondProject = createRemotionProjectFromScript('项目二。', { title: '项目二', mediaAccountId: testAccountId })
  if (!firstProject || !secondProject) throw new Error('project creation failed')
  const [firstShot] = upsertRemotionShots(firstProject.project.id, [{
    shotNumber: 1,
    durationMs: 1000,
    shotType: 'ai_plate',
    visualPlan: { schemaVersion: 1 },
  }])
  assert.throws(() => upsertRemotionAsset(secondProject.project.id, {
    shotId: firstShot.id,
    assetKey: 'foreign-shot-asset',
    assetType: 'ai_image',
  }), /not found in project/)

  const [secondShot] = upsertRemotionShots(secondProject.project.id, [{
    shotNumber: 1,
    durationMs: 1000,
    shotType: 'ai_plate',
    visualPlan: { schemaVersion: 1 },
  }])
  const asset = upsertRemotionAsset(secondProject.project.id, {
    shotId: secondShot.id,
    assetKey: 'timestamped-asset',
    assetType: 'ai_image',
    status: 'queued',
    imageGenerationId: 999999,
  })
  syncRemotionAssetForImageGeneration(db, 999999, { status: 'processing' })
  const processing = db.select().from(schema.remotionAssets).all().find((row) => row.id === asset.id)
  assert.ok(processing?.startedAt)
  assert.equal(processing?.status, 'processing')
})

test('Remotion aggregates latest asset versions and persists shot/episode renders', () => {
  const project = createRemotionProjectFromScript('渲染状态测试。', { title: '渲染状态测试', mediaAccountId: testAccountId })
  if (!project) throw new Error('project creation failed')
  const [shot] = upsertRemotionShots(project.project.id, [{
    shotNumber: 1,
    title: '测试镜头',
    durationMs: 4000,
    shotType: 'hybrid',
    visualPlan: { schemaVersion: 1, visualMode: 'crop' },
  }])

  upsertRemotionAsset(project.project.id, {
    shotId: shot.id,
    assetKey: 'background',
    assetType: 'ai_image',
    status: 'completed',
    localPath: 'static/images/background.png',
  })
  const pending = upsertRemotionAsset(project.project.id, {
    shotId: shot.id,
    assetKey: 'character',
    assetType: 'character',
    status: 'queued',
  })
  assert.equal(pending.status, 'queued')
  assert.equal(getRemotionProjectSnapshot(project.project.id)?.shots[0]?.status, 'asset_pending')

  upsertRemotionAsset(project.project.id, {
    shotId: shot.id,
    assetKey: 'character',
    assetType: 'character',
    status: 'completed',
    localPath: 'static/images/character.png',
    version: 2,
    metadata: { requiresAlpha: true, alphaReady: true },
  })
  assert.equal(getRemotionProjectSnapshot(project.project.id)?.shots[0]?.status, 'ready')
  assert.equal(getRemotionProjectSnapshot(project.project.id)?.shots[0]?.assets.length, 2)

  upsertRemotionRender(project.project.id, {
    renderKind: 'shot',
    shotId: shot.id,
    status: 'running',
    width: 1280,
    height: 720,
    fps: 30,
  })
  assert.equal(getRemotionProjectSnapshot(project.project.id)?.shots[0]?.status, 'rendering')

  const rendered = upsertRemotionRender(project.project.id, {
    renderKind: 'shot',
    shotId: shot.id,
    status: 'succeeded',
    outputPath: 'data/static/remotion/test-shot.mp4',
    outputUrl: '/static/remotion/test-shot.mp4',
    durationMs: 4000,
  })
  assert.equal(rendered.status, 'succeeded')
  assert.equal(getRemotionProjectSnapshot(project.project.id)?.shots[0]?.status, 'rendered')

  const episodeRender = upsertRemotionRender(project.project.id, {
    renderKind: 'episode',
    status: 'succeeded',
    outputPath: 'data/static/remotion/test-episode.mp4',
    outputUrl: '/static/remotion/test-episode.mp4',
    durationMs: 4000,
  })
  const snapshot = getRemotionProjectSnapshot(project.project.id)
  assert.equal(episodeRender.renderKind, 'episode')
  assert.equal(snapshot?.project.finalVideoUrl, '/static/remotion/test-episode.mp4')
  assert.equal(snapshot?.renders.length, 2)
})
