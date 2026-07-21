import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-media-accounts-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { default: mediaAccountsRoute } = await import('./mediaAccounts.js')
const { default: dramasRoute } = await import('./dramas.js')
const { default: episodesRoute } = await import('./episodes.js')
const { createRemotionProjectFromEpisode } = await import('../services/remotion.js')

test('media accounts own positioning and remotion snapshots inherit it', async () => {
  const createAccount = await mediaAccountsRoute.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '历史男人志',
      positioning: {
        audience: '25～45 岁男性',
        promise: '从历史人物的选择与代价中获得现实共鸣',
        pillars: ['家庭', '情感', '事业'],
      },
    }),
  })
  assert.equal(createAccount.status, 201)
  const account = (await createAccount.json() as any).data
  assert.deepEqual(account.positioning.pillars, ['家庭', '情感', '事业'])

  const createDrama = await dramasRoute.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: '人物选择与代价',
      media_account_id: account.id,
      project_positioning: {
        thesis: '从历史男性人物的家庭、情感和事业代价出发讲故事',
        narrative_lens: '人物选择与代价',
      },
    }),
  })
  assert.equal(createDrama.status, 201)
  const drama = (await createDrama.json() as any).data

  const ts = now()
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId: drama.id,
    episodeNumber: 1,
    title: '第一集',
    content: '一个人的选择改变了一生。',
    creativeBriefJson: JSON.stringify({
      core_question: '他为什么放弃家庭？',
      emotion: '克制的遗憾',
    }),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const project = createRemotionProjectFromEpisode(episodeId)
  if (!project) throw new Error('project creation failed')
  const positioning = project.project.positioningSnapshot
  if (!positioning) throw new Error('positioning snapshot missing')
  const sourcePositioning = project.project.sourceSnapshot.positioning
  if (!sourcePositioning) throw new Error('source positioning snapshot missing')
  assert.equal(project.project.mediaAccountId, account.id)
  assert.equal(positioning.account?.name, '历史男人志')
  assert.equal(positioning.project.narrative_lens, '人物选择与代价')
  assert.equal(positioning.episode.core_question, '他为什么放弃家庭？')
  assert.equal(sourcePositioning.account?.id, account.id)
})

test('episode creative brief accepts an already serialized JSON payload', async () => {
  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Brief 序列化测试',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const brief = { core_question: '他为什么留下？', emotion: '克制的遗憾' }

  const response = await episodesRoute.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      drama_id: dramaId,
      title: '第一集',
      creative_brief_json: JSON.stringify(brief),
    }),
  })
  assert.equal(response.status, 200)
  const episode = (await response.json() as any).data
  const [row] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).all()
  assert.deepEqual(JSON.parse(row.creativeBriefJson || '{}'), brief)
})
