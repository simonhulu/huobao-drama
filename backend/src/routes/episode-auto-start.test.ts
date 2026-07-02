import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-episode-auto-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { getTask } = await import('../services/tasks/store.js')
const { AUTO_STRUCTURE_TASK_PRIORITY } = await import('../services/tasks/auto-pipeline.js')
const dramasRoute = (await import('./dramas.js')).default
const episodesRoute = (await import('./episodes.js')).default

function createDrama() {
  const ts = new Date().toISOString()
  return Number(db.insert(schema.dramas).values({
    title: 'Remote Auto Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

test('POST /dramas/:id/episodes accepts body auto=true and starts script rewrite', async () => {
  const dramaId = createDrama()

  const response = await dramasRoute.request(`/${dramaId}/episodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Auto episode',
      content: 'A doctor visits a patient and changes the family dynamic.',
      auto: true,
      aspect_ratio: '9:16',
      render_mode: 'image_story',
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 201)
  assert.equal(json.data.auto_started, true)
  assert.ok(json.data.initial_task_id)

  const task = getTask(json.data.initial_task_id)
  assert.equal(task?.type, 'agent.run')
  assert.equal(task?.priority, AUTO_STRUCTURE_TASK_PRIORITY)
  assert.equal(task?.payload?.agent_type, 'script_rewriter')
})

test('POST /episodes accepts body auto_mode=true and starts script rewrite', async () => {
  const dramaId = createDrama()

  const response = await episodesRoute.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      drama_id: dramaId,
      title: 'Generic auto episode',
      content: 'A family argument turns into a reconciliation.',
      auto_mode: true,
      aspect_ratio: '9:16',
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 200)
  assert.equal(json.data.auto_started, true)
  assert.ok(json.data.initial_task_id)

  const task = getTask(json.data.initial_task_id)
  assert.equal(task?.type, 'agent.run')
  assert.equal(task?.priority, AUTO_STRUCTURE_TASK_PRIORITY)
  assert.equal(task?.payload?.agent_type, 'script_rewriter')
})

test('PUT /episodes/:id auto_mode=true starts script rewrite when content exists', async () => {
  const dramaId = createDrama()
  const ts = new Date().toISOString()
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Existing episode',
    content: 'An existing story that should enter auto mode.',
    autoMode: false,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const response = await episodesRoute.request(`/${episodeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auto_mode: true }),
  })
  const json = await response.json()

  assert.equal(response.status, 200)
  assert.equal(json.data.auto_started, true)
  assert.ok(json.data.initial_task_id)

  const task = getTask(json.data.initial_task_id)
  assert.equal(task?.type, 'agent.run')
  assert.equal(task?.priority, AUTO_STRUCTURE_TASK_PRIORITY)
  assert.equal(task?.payload?.agent_type, 'script_rewriter')
})
