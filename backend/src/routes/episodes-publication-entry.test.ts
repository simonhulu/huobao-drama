import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { eq } from 'drizzle-orm'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-publication-entry-'))
process.env.DB_PATH = path.join(directory, 'fixture.db')
process.env.DOUYIN_PROFILE_DIR = path.join(directory, 'douyin')
process.env.WECHAT_CHANNELS_PROFILE_DIR = path.join(directory, 'wechat')
process.env.TASK_WORKER_DISABLED = '1'
const { db, schema } = await import('../db/index.js')
const { default: route } = await import('./episodes.js')

function episode(metadata?: unknown, dramaMetadata?: unknown) {
  const timestamp = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({ title: 'Publication route fixture',
    metadata: dramaMetadata === undefined ? null : JSON.stringify(dramaMetadata), createdAt: timestamp, updatedAt: timestamp }).run().lastInsertRowid)
  const id = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: 'Episode',
    metadata: metadata === undefined ? null : JSON.stringify(metadata), videoUrl: '/static/video.mp4',
    coverImage4x3Url: '/static/cover-landscape.png', coverImage3x4Url: '/static/cover-portrait.png',
    createdAt: timestamp, updatedAt: timestamp }).run().lastInsertRowid)
  return { id, dramaId }
}

function post(id: number, path: string, body: unknown = {}) {
  return route.request(`/${id}/publish/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

test('history Episodes cannot dispatch old platform jobs through either legacy publication API', async () => {
  for (const entry of [
    { metadata: { historyFactory: { jobId: 'history-motion', sourceId: 71 } }, sourceId: 71 },
    { metadata: {}, dramaMetadata: { historySourceId: 72 }, sourceId: 72 },
    { metadata: { historyFactory: 'remotion-history-factory' }, sourceId: null },
    { metadata: { history_factory: 'remotion-history-factory' }, sourceId: null },
  ]) {
    const ep = episode(entry.metadata, 'dramaMetadata' in entry ? entry.dramaMetadata : undefined)
    const before = db.select().from(schema.creationTasks).all()
    for (const platform of ['douyin', 'wechat-channels']) {
      const response = await post(ep.id, platform)
      const payload = await response.json() as { message: string; data: { publicationUrl: string } }
      assert.equal(response.status, 409)
      assert.match(payload.message, /统一.*发表|发表工作台/)
      assert.equal(payload.data.publicationUrl, `/history-scripts?view=uploads${entry.sourceId ? `&script=${entry.sourceId}` : ''}`)
    }
    assert.deepEqual(db.select().from(schema.creationTasks).all(), before)
    assert.equal(db.select().from(schema.episodePublishRecords).where(eq(schema.episodePublishRecords.episodeId, ep.id)).all().length, 0)
  }
})

test('history confirmations retain old records without writing either platform confirmation marker', async () => {
  const ep = episode({ historyFactory: { jobId: 'history-motion', sourceId: 71 } })
  const timestamp = new Date().toISOString()
  for (const [platform, target, taskId] of [['douyin', 'douyin', 901], ['wechat_channels', 'wechat-channels', 902]] as const) {
    db.insert(schema.episodePublishRecords).values({ episodeId: ep.id, platform, status: 'awaiting_confirm', taskId,
      createdAt: timestamp, updatedAt: timestamp }).run()
    const before = db.select().from(schema.episodePublishRecords).where(eq(schema.episodePublishRecords.episodeId, ep.id)).all()
    const response = await post(ep.id, `${target}/confirm`, { task_id: taskId })
    assert.equal(response.status, 409)
    assert.deepEqual(db.select().from(schema.episodePublishRecords).where(eq(schema.episodePublishRecords.episodeId, ep.id)).all(), before)
    const profile = platform === 'douyin' ? process.env.DOUYIN_PROFILE_DIR! : process.env.WECHAT_CHANNELS_PROFILE_DIR!
    assert.equal(fs.existsSync(path.join(profile, `confirm-${taskId}.json`)), false)
  }
})

test('ordinary Episodes still queue both platforms and confirm their existing draft records', async () => {
  const ep = episode({ notes: 'not a historical factory marker' })
  for (const [platform, target] of [['douyin', 'douyin'], ['wechat_channels', 'wechat-channels']] as const) {
    const response = await post(ep.id, target)
    const payload = await response.json() as { data: { task_id: number } }
    assert.equal(response.status, 200)
    assert.ok(payload.data.task_id)
    const task = db.select().from(schema.creationTasks).where(eq(schema.creationTasks.id, payload.data.task_id)).get()!
    assert.equal(task.type, `publish.${platform}`)
    assert.equal(task.status, 'queued')
    db.update(schema.episodePublishRecords).set({ status: 'awaiting_confirm' })
      .where(eq(schema.episodePublishRecords.taskId, payload.data.task_id)).run()
    const confirmed = await post(ep.id, `${target}/confirm`, { task_id: payload.data.task_id })
    assert.equal(confirmed.status, 200)
    const profile = platform === 'douyin' ? process.env.DOUYIN_PROFILE_DIR! : process.env.WECHAT_CHANNELS_PROFILE_DIR!
    assert.equal(fs.existsSync(path.join(profile, `confirm-${payload.data.task_id}.json`)), true)
  }
})
