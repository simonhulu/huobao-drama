import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-import-script-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const dramasRoute = (await import('./dramas.js')).default
const originalFetch = global.fetch

after(() => {
  global.fetch = originalFetch
})

function seedDrama() {
  const ts = now()
  return Number(db.insert(schema.dramas).values({
    title: '历史科普项目',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function seedConfig(serviceType: 'text' | 'image' | 'video' | 'audio', idLabel: string) {
  const ts = now()
  return Number(db.insert(schema.aiServiceConfigs).values({
    serviceType,
    provider: idLabel,
    name: `${idLabel}-${serviceType}`,
    baseUrl: `https://${idLabel}.example.com`,
    apiKey: 'test-key',
    model: JSON.stringify([`${idLabel}-model`]),
    isActive: true,
    priority: 100,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function mockTextResponses(contents: string[]) {
  let callCount = 0
  global.fetch = (async () => {
    const content = contents[Math.min(callCount, contents.length - 1)] || ''
    callCount += 1
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }))
  }) as typeof fetch
  return () => callCount
}

test('POST /:id/import-script creates a direct-script episode and schedules extraction', async () => {
  const dramaId = seedDrama()
  const imageConfigId = seedConfig('image', 'image')
  const videoConfigId = seedConfig('video', 'video')
  const audioConfigId = seedConfig('audio', 'audio')

  const scriptContent = '公元前三世纪，秦始皇统一六国。镜头一：咸阳宫，秦始皇俯瞰地图。'

  const response = await dramasRoute.request(`/${dramaId}/import-script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '秦统一六国',
      script_content: scriptContent,
      image_config_id: imageConfigId,
      video_config_id: videoConfigId,
      audio_config_id: audioConfigId,
      aspect_ratio: '16:9',
      render_mode: 'image_story',
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 201)
  assert.equal(json.data.segment_count, 1)
  assert.equal(json.data.episodes.length, 1)
  assert.equal(json.data.episodes[0].title, '秦统一六国')
  assert.equal(typeof json.data.episodes[0].initial_task_id, 'number')

  const rows = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .orderBy(schema.episodes.episodeNumber)
    .all()
  assert.equal(rows.length, 1)

  const ep = rows[0]!
  assert.equal(ep.workflowType, 'direct_script')
  assert.equal(ep.pacingMode, 'literal')
  assert.equal(ep.enableAiRewrite, false)
  assert.equal(ep.scriptContent, scriptContent)
  assert.equal(ep.content, scriptContent)
  assert.equal(ep.imageConfigId, imageConfigId)
  assert.equal(ep.videoConfigId, videoConfigId)
  assert.equal(ep.audioConfigId, audioConfigId)
  assert.equal(ep.aspectRatio, '16:9')
  assert.equal(ep.renderMode, 'image_story')
  assert.equal(ep.autoMode, true)

  const tasks = db.select().from(schema.creationTasks)
    .where(eq(schema.creationTasks.episodeId, ep.id))
    .all()
  const extractorTask = tasks.find(t => {
    const payload = typeof t.payloadJson === 'string' ? JSON.parse(t.payloadJson) : t.payloadJson
    return payload?.agent_type === 'extractor'
  })
  assert.ok(extractorTask, 'should schedule an extractor task')
})

test('POST /:id/import-script splits by segment markers and creates multiple direct-script episodes', async () => {
  const dramaId = seedDrama()
  seedConfig('image', 'image')
  seedConfig('video', 'video')
  seedConfig('audio', 'audio')

  const scriptContent = '第一部分：引言。\n---SEG---\n第二部分：主体。\n---SEG---\n第三部分：结语。'

  const response = await dramasRoute.request(`/${dramaId}/import-script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '纪录片',
      script_content: scriptContent,
      segment_markers: ['---SEG---'],
      image_config_id: 1,
      video_config_id: 2,
      audio_config_id: 3,
      aspect_ratio: '16:9',
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 201)
  assert.equal(json.data.segment_count, 3)

  const rows = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .orderBy(schema.episodes.episodeNumber)
    .all()
  assert.equal(rows.length, 3)
  assert.ok(rows.every(r => r.workflowType === 'direct_script' && r.pacingMode === 'literal' && r.enableAiRewrite === false))
  assert.equal(rows[0].title, '纪录片 1')
  assert.equal(rows[1].title, '纪录片 2')
  assert.equal(rows[2].title, '纪录片 3')
})

test('POST /:id/import-script retention clean writes production script and retention structure', async () => {
  const dramaId = seedDrama()
  seedConfig('text', 'text')
  const imageConfigId = seedConfig('image', 'image')
  const videoConfigId = seedConfig('video', 'video')
  const audioConfigId = seedConfig('audio', 'audio')

  const callCount = mockTextResponses([
    '万历皇帝要开矿，大臣们集体反对。嘉靖开矿亏了一千五百两，可万历仍然坚持。',
    '大臣们反对开矿，真正怕的是矿税不进他们的口袋。嘉靖旧账说明亏钱只是表象。万历执意开矿，是要撕开大明官僚的钱袋。下一集，矿监进场后，矛盾才真正失控。',
  ])

  const response = await dramasRoute.request(`/${dramaId}/import-script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '万历矿税',
      script_content: '万历皇帝要开矿，大臣们集体反对。嘉靖开矿亏了一千五百两，可万历仍然坚持。',
      clean: true,
      clean_mode: 'retention',
      image_config_id: imageConfigId,
      video_config_id: videoConfigId,
      audio_config_id: audioConfigId,
      aspect_ratio: '9:16',
      render_mode: 'image_story',
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 201)
  assert.equal(callCount(), 2, 'retention clean should run faithful clean then retention edit')
  assert.equal(json.data.episodes[0].opening_hook, '大臣们反对开矿，真正怕的是矿税不进他们的口袋')
  assert.equal(json.data.episodes[0].cliffhanger, '下一集，矿监进场后，矛盾才真正失控')
  assert.ok(json.data.episodes[0].retention_beats)

  const rows = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .all()
  assert.equal(rows.length, 1)
  const ep = rows[0]!
  assert.equal(ep.content, '大臣们反对开矿，真正怕的是矿税不进他们的口袋。嘉靖旧账说明亏钱只是表象。万历执意开矿，是要撕开大明官僚的钱袋。下一集，矿监进场后，矛盾才真正失控。')
  assert.equal(ep.scriptContent, ep.content)
  assert.equal(ep.openingHook, '大臣们反对开矿，真正怕的是矿税不进他们的口袋')
  assert.equal(ep.cliffhanger, '下一集，矿监进场后，矛盾才真正失控')
  assert.ok(ep.retentionBeats)
  const beats = JSON.parse(ep.retentionBeats)
  assert.equal(beats.openingHook.text, ep.openingHook)
  assert.equal(beats.cliffhanger.text, ep.cliffhanger)
  assert.ok(beats.midBeats.length >= 1)
})

test('POST /:id/import-script rejects empty script_content', async () => {
  const dramaId = seedDrama()
  const response = await dramasRoute.request(`/${dramaId}/import-script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script_content: '' }),
  })
  const json = await response.json()

  assert.equal(response.status, 400)
  assert.match(json.message, /script_content/)
})
