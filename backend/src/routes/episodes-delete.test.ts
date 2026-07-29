import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq, inArray } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-episodes-delete-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { createTask, getTask, listTaskEvents } = await import('../services/tasks/store.js')
const { default: episodesRoute } = await import('./episodes.js')

function insertEpisode(dramaId?: number) {
  const ts = now()
  const resolvedDramaId = dramaId ?? Number(db.insert(schema.dramas).values({
    title: 'Episode deletion task safety',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId: resolvedDramaId,
    episodeNumber: 1,
    title: 'Deletion target',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  return { dramaId: resolvedDramaId, episodeId }
}

function queueFormalDharmaRender(dramaId: number, episodeId: number) {
  return createTask({
    type: 'dharma.episode_render',
    dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `delete-guard-dharma-render:${episodeId}`,
    payload: { episode_id: episodeId },
  })
}

test('DELETE /episodes/:id refuses to bypass a formal Dharma render cancellation', async () => {
  const { dramaId, episodeId } = insertEpisode()
  const render = queueFormalDharmaRender(dramaId, episodeId)

  const response = await episodesRoute.request(`/${episodeId}`, { method: 'DELETE' })
  const payload = await response.json() as { message?: string }

  assert.equal(response.status, 409)
  assert.match(payload.message || '', /Dharma.*渲染.*取消|取消.*Dharma/i)
  assert.equal(getTask(render.id)?.status, 'queued')
  assert.equal(getTask(render.id)?.cancelRequested, false)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  assert.equal(episode.deletedAt, null)
})

test('POST /episodes/bulk-delete is atomic when any target has a formal Dharma render', async () => {
  const first = insertEpisode()
  const second = insertEpisode(first.dramaId)
  const render = queueFormalDharmaRender(first.dramaId, second.episodeId)

  const response = await episodesRoute.request('/bulk-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_ids: [first.episodeId, second.episodeId] }),
  })
  const payload = await response.json() as { message?: string }

  assert.equal(response.status, 409)
  assert.match(payload.message || '', /Dharma.*渲染.*取消|取消.*Dharma/i)
  assert.equal(getTask(render.id)?.status, 'queued')
  assert.equal(getTask(render.id)?.cancelRequested, false)
  const episodes = db.select().from(schema.episodes)
    .where(inArray(schema.episodes.id, [first.episodeId, second.episodeId])).all()
  assert.equal(episodes.every((episode) => episode.deletedAt === null), true)
})

test('DELETE /episodes/:id finds a formal Dharma render beyond the global active-task page', async () => {
  const { dramaId, episodeId } = insertEpisode()
  const render = queueFormalDharmaRender(dramaId, episodeId)

  // `listTasks({ activeOnly: true })` is intentionally UI-bounded. A deletion
  // guard must query the requested episode directly rather than lose an older
  // formal render behind unrelated, newer active work.
  for (let index = 0; index < 201; index += 1) {
    createTask({
      type: 'test.delete-page-pressure',
      episodeId: 50_000 + index,
      idempotencyKey: `delete-page-pressure:${episodeId}:${index}`,
    })
  }

  const response = await episodesRoute.request(`/${episodeId}`, { method: 'DELETE' })
  assert.equal(response.status, 409)
  assert.equal(getTask(render.id)?.cancelRequested, false)
  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  assert.equal(episode.deletedAt, null)
})

test('DELETE /episodes/:id preflights Dharma blockers before canceling ordinary tasks', async () => {
  const { dramaId, episodeId } = insertEpisode()
  const formalRender = queueFormalDharmaRender(dramaId, episodeId)
  const ordinaryTask = createTask({
    type: 'test.delete-preflight-side-effect',
    dramaId,
    episodeId,
    idempotencyKey: `delete-preflight-side-effect:${episodeId}`,
  })

  const response = await episodesRoute.request(`/${episodeId}`, { method: 'DELETE' })
  assert.equal(response.status, 409)
  assert.equal(getTask(formalRender.id)?.cancelRequested, false)
  assert.equal(getTask(ordinaryTask.id)?.cancelRequested, false)
  assert.equal(listTaskEvents(ordinaryTask.id).some(event => event.eventType === 'cancel.requested'), false)
})
