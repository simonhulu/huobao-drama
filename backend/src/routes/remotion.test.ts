import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-remotion-route-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { default: remotionRoute } = await import('./remotion.js')

const testAccountId = Number(db.insert(schema.mediaAccounts).values({
  name: '接口测试账号',
  positioningJson: JSON.stringify({ audience: '测试观众', promise: '验证账号绑定', tone: '克制' }),
  createdAt: now(),
  updatedAt: now(),
}).run().lastInsertRowid)

test('Remotion producer writes and query endpoints expose the same render state', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    mediaAccountId: testAccountId,
    title: '接口测试剧',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '接口测试集',
    content: '口播内容',
    duration: 4,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const emptyEpisodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 2,
    title: '未开始的接口集',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const projectResponse = await remotionRoute.request('/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: episodeId, media_account_id: testAccountId, title: '接口测试项目' }),
  })
  assert.equal(projectResponse.status, 201)
  const projectBody = await projectResponse.json() as any
  const projectId = projectBody.data.project.id

  const shotsResponse = await remotionRoute.request(`/projects/${projectId}/shots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shots: [{
      shotNumber: 1,
      title: '接口镜头',
      durationMs: 4000,
      shotType: 'ai_plate',
      visualPlan: { schemaVersion: 1, visualMode: 'crop' },
    }] }),
  })
  assert.equal(shotsResponse.status, 200)
  const shotsBody = await shotsResponse.json() as any
  const shotId = shotsBody.data[0].id

  const renderResponse = await remotionRoute.request(`/projects/${projectId}/renders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      render_kind: 'shot',
      shot_id: shotId,
      status: 'succeeded',
      output_url: '/static/remotion/route-test-shot.mp4',
      duration_ms: 4000,
    }),
  })
  assert.equal(renderResponse.status, 200)

  const queryResponse = await remotionRoute.request(`/projects/${projectId}`)
  assert.equal(queryResponse.status, 200)
  const queryBody = await queryResponse.json() as any
  assert.equal(queryBody.data.shots[0].status, 'rendered')
  assert.equal(queryBody.data.renders[0].outputUrl, '/static/remotion/route-test-shot.mp4')

  const rendersResponse = await remotionRoute.request(`/projects/${projectId}/renders`)
  assert.equal(rendersResponse.status, 200)
  const rendersBody = await rendersResponse.json() as any
  assert.equal(rendersBody.data.length, 1)

  const treeResponse = await remotionRoute.request('/projects/tree')
  assert.equal(treeResponse.status, 200)
  const treeBody = await treeResponse.json() as any
  const group = treeBody.data.find((item: any) => item.drama.id === dramaId)
  assert.ok(group)
  assert.equal(group.episodes.find((item: any) => item.episode.id === episodeId).production.id, projectId)
  assert.equal(group.episodes.find((item: any) => item.episode.id === emptyEpisodeId).production, null)
})

test('Remotion factory initialization exposes the eleven native stage rows', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    mediaAccountId: testAccountId,
    title: '十一阶段接口测试剧',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '十一阶段接口测试集',
    content: '口播内容',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const projectResponse = await remotionRoute.request('/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: episodeId, media_account_id: testAccountId, title: '十一阶段接口测试项目' }),
  })
  assert.equal(projectResponse.status, 201)
  const projectId = (await projectResponse.json() as any).data.project.id

  const initializeResponse = await remotionRoute.request(`/projects/${projectId}/factory/initialize`, {
    method: 'POST',
  })
  assert.equal(initializeResponse.status, 200)
  const initialized = (await initializeResponse.json() as any).data
  const nativeStages = initialized.stages.filter((stage: any) => stage.stage === stage.canonicalStage)
  assert.equal(nativeStages.length, 11)
  assert.equal(initialized.project.canonicalStage, 'historical_analysis')
  assert.deepEqual([initialized.project.progressCurrent, initialized.project.progressTotal], [1, 11])
})

test('Remotion script intake requires an account and creates one production per smart-split episode', async () => {
  const missingAccount = await remotionRoute.request('/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script: '没有账号的脚本。' }),
  })
  assert.equal(missingAccount.status, 400)
  assert.match((await missingAccount.json() as any).message, /media_account_id/)

  const missingDurationPreset = await remotionRoute.request('/projects/intake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      script: '没有明确分集时长的脚本。',
      title: '缺少分集级别',
      media_account_id: testAccountId,
    }),
  })
  assert.equal(missingDurationPreset.status, 400)
  assert.match((await missingDurationPreset.json() as any).message, /duration_preset/)

  const autoDurationPreset = await remotionRoute.request('/projects/intake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      script: '不允许由原稿时长自动决定分集级别。',
      title: '禁止自动选择',
      media_account_id: testAccountId,
      duration_preset: 'auto',
    }),
  })
  assert.equal(autoDurationPreset.status, 400)
  assert.match((await autoDurationPreset.json() as any).message, /duration_preset/)

  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text',
    provider: 'openai',
    name: 'intake-text',
    baseUrl: 'https://api.example.invalid',
    apiKey: 'test-key',
    model: JSON.stringify(['test-model']),
    isActive: true,
    priority: 100,
    createdAt: now(),
    updatedAt: now(),
  }).run()

  const originalFetch = global.fetch
  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    const payload = callCount === 1
      ? {
        plot_progression_chain: [{
          beat_id: 'beat-1',
          phase: 'setup',
          summary: '建立核心冲突。',
          dramatic_function: '建立问题',
          suspense_value: '问题会如何升级',
          must_keep_context: '人物和冲突必须保留',
        }],
      }
      : {
        series_hook: '一场选择改变了一个人的命运',
        episodes: [{
          title: '第一集',
          summary: '核心冲突出现。',
          estimated_duration_seconds: 60,
          opening_anchor: '故事开始',
          ending_anchor: '冲突出现。',
          covered_beat_ids: ['beat-1'],
        }],
      }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: callCount === 1 ? 'submit_plot_progression_chain' : 'submit_episode_split_plan',
              arguments: JSON.stringify(payload),
            },
          }],
        },
      }],
    }), { status: 200 })
  }) as typeof fetch

  try {
    const response = await remotionRoute.request('/projects/intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        script: '故事开始，人物面临选择。冲突出现。',
        title: '智能分集入口测试',
        media_account_id: testAccountId,
        duration_preset: 'shorts_1_3',
        project_positioning: { thesis: '验证分集与生产层级' },
      }),
    })
    assert.equal(response.status, 201)
    const body = await response.json() as any
    assert.equal(body.data.content_project.media_account_id, testAccountId)
    assert.equal(body.data.episodes.length, 1)
    assert.equal(body.data.productions.length, 1)
    assert.equal(body.data.productions[0].mediaAccountId, testAccountId)
    const splitMetadata = JSON.parse(
      db.select().from(schema.episodes).all().find((episode) => episode.id === body.data.episodes[0].id)?.metadata || '{}',
    )
    assert.equal(splitMetadata.intake.durationPreset.id, 'shorts_1_3')
    assert.equal(splitMetadata.intake.estimatedEpisodeCount, 1)
    assert.equal(callCount, 2)
  } finally {
    global.fetch = originalFetch
  }
})
