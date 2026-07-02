import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-storyboards-route-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { default: route, buildAutoSplitPlan } = await import('./storyboards.js')

function createEpisode(ts: string, overrides: Partial<typeof schema.episodes.$inferInsert> = {}) {
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Test Drama',
    status: 'draft',
    style: 'cinematic',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Test Episode',
    imageConfigId: 1,
    videoConfigId: 1,
    audioConfigId: 1,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  }).run().lastInsertRowid)

  return { dramaId, episodeId }
}

function createShot(
  episodeId: number,
  num: number,
  narration: string,
  dialogue: string,
  overrides: Partial<typeof schema.storyboards.$inferInsert> = {},
) {
  const ts = now()
  const id = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: num,
    title: `Shot ${num}`,
    narration,
    dialogue,
    duration: 10,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  }).run().lastInsertRowid)
  return id
}

test('buildAutoSplitPlan detects overloaded shots and proposes splits', () => {
  const ts = now()
  const { episodeId } = createEpisode(ts)
  createShot(episodeId, 1, '短。', '')
  const longId = createShot(episodeId, 2, '这是一个很长的旁白内容。'.repeat(8), '角色A：这也是很长的对白。'.repeat(4))

  const plan = buildAutoSplitPlan(episodeId, 60)

  assert.equal(plan.shots.length, 1)
  assert.equal(plan.shots[0].id, longId)
  assert.ok(plan.shots[0].split_into >= 2)
  assert.equal(plan.shots[0].proposed.length, plan.shots[0].split_into)
})

test('buildAutoSplitPlan splits comma-separated visual beats and keeps portrait prompt', () => {
  const ts = now()
  const { episodeId } = createEpisode(ts, { aspectRatio: '9:16' })
  const shotId = createShot(
    episodeId,
    1,
    '2016年，赵磊开着一辆不起眼的车来接我，停在老火车站附近一家小羊汤店门口。他比从前胖了，眼里却满是疲惫。',
    '',
    {
      imagePrompt: '横屏16:9宽银幕北方小羊汤馆傍晚，赵磊坐在塑料凳上。',
      location: '老火车站附近',
      time: '傍晚',
    },
  )

  const plan = buildAutoSplitPlan(episodeId, 60)

  assert.equal(plan.shots.length, 1)
  assert.equal(plan.shots[0].id, shotId)
  assert.equal(plan.shots[0].split_into, 2)
  assert.match(plan.shots[0].proposed[0].description, /开着.*车.*接我/)
  assert.match(plan.shots[0].proposed[1].description, /羊汤店/)
  assert.match(plan.shots[0].proposed[0].image_prompt, /^竖屏9:16/)
  assert.doesNotMatch(plan.shots[0].proposed[0].image_prompt, /横屏|宽银幕/)
})

test('buildAutoSplitPlan uses story-bearing fields beyond narration and dialogue', () => {
  const ts = now()
  const { episodeId } = createEpisode(ts)
  const shotId = createShot(
    episodeId,
    1,
    '他没说话。',
    '',
    {
      action: '先站在门口迟疑。再看见桌上的离婚协议。最后把笔狠狠摔下。',
      description: '一个镜头里塞进了犹豫、发现和爆发三个节拍。',
      result: '他终于意识到这段婚姻真的走到了尽头。',
    },
  )

  const plan = buildAutoSplitPlan(episodeId, 30)

  assert.equal(plan.shots.length, 1)
  assert.equal(plan.shots[0].id, shotId)
  assert.ok(plan.shots[0].split_into >= 2)
  assert.match(plan.shots[0].proposed.map(item => item.action).join(' '), /离婚协议|摔下/)
  assert.match(plan.shots[0].proposed.map(item => item.result).join(' '), /婚姻/)
})

test('POST /auto-split preview returns plan without mutating DB', async () => {
  const ts = now()
  const { episodeId } = createEpisode(ts)
  createShot(episodeId, 1, '第一段。第二段。第三段。第四段。第五段。第六段。第七段。', '角色A：第一句话。第二句话。')

  const res = await route.request('/auto-split', {
    method: 'POST',
    body: JSON.stringify({ episode_id: episodeId, preview: true, threshold: 30 }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()

  assert.equal(res.status, 200)
  assert.equal(json.data.preview, true)
  assert.ok(json.data.shots.length >= 1)

  const rows = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
  assert.equal(rows.length, 1)
})

test('POST /auto-split execute splits overloaded shots and renumbers', async () => {
  const ts = now()
  const { episodeId } = createEpisode(ts)
  createShot(episodeId, 1, '短。', '')
  const overloadedId = createShot(episodeId, 2, '镜头一内容。镜头二内容。镜头三内容。镜头四内容。', '角色A：第一句。第二句。')
  createShot(episodeId, 3, '短。', '')

  const res = await route.request('/auto-split', {
    method: 'POST',
    body: JSON.stringify({ episode_id: episodeId, threshold: 30 }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()

  assert.equal(res.status, 200)
  assert.equal(json.data.preview, false)
  assert.ok(json.data.created_shot_ids.length >= 2)
  assert.deepEqual(json.data.deleted_shot_ids, [overloadedId])

  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  assert.equal(rows.length, 2 + json.data.created_shot_ids.length)
  rows.forEach((row, i) => assert.equal(row.storyboardNumber, i + 1))
})

test('POST /auto-split returns empty plan when no overloads exist', async () => {
  const ts = now()
  const { episodeId } = createEpisode(ts)
  createShot(episodeId, 1, '短。', '')

  const res = await route.request('/auto-split', {
    method: 'POST',
    body: JSON.stringify({ episode_id: episodeId, threshold: 60 }),
    headers: { 'Content-Type': 'application/json' },
  })
  const json = await res.json()

  assert.equal(res.status, 200)
  assert.equal(json.data.shots.length, 0)
})

test('PUT /:id image_prompt clears imagePromptFinal', async () => {
  const ts = now()
  const { episodeId } = createEpisode(ts)
  const id = Number(db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: 'Shot',
    imagePrompt: '完整安全 prompt',
    imagePromptFinal: true,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const res = await route.request(`/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ image_prompt: '手动改写 prompt' }),
    headers: { 'Content-Type': 'application/json' },
  })

  assert.equal(res.status, 200)
  const [row] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  assert.equal(row.imagePrompt, '手动改写 prompt')
  assert.equal(row.imagePromptFinal, false)
})
