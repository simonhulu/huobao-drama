import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-grid-task-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../../db/index.js')
const { now } = await import('../../../utils/response.js')
const { createTask, getTask } = await import('../store.js')
const { createGridGenerateHandler, createGridSplitHandler } = await import('./grid-generate.js')

test('grid.generate handler executes grid image generation and updates grid draft', async () => {
  const ts = now()
  const draftId = Number(db.insert(schema.gridDrafts).values({
    dramaId: 1,
    episodeId: 2,
    mode: 'first_frame',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const task = createTask({
    type: 'grid.generate',
    payload: { grid_draft_id: draftId, image_generation_id: 11, config_id: 3 },
  })
  const handler = createGridGenerateHandler({
    executeImageGeneration: async () => ({
      image_generation_id: 11,
      local_path: 'static/images/grid.png',
    }),
  })

  const result = await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    progress() {},
    event() {},
    isCancelRequested() {
      return false
    },
  })

  assert.equal(result.grid_draft_id, draftId)
  assert.equal(result.image_generation_id, 11)
  const [draft] = db.select().from(schema.gridDrafts).where(eq(schema.gridDrafts.id, draftId)).all()
  assert.equal(draft.activeImagePath, 'static/images/grid.png')
  assert.equal(getTask(task.id)?.type, 'grid.generate')
})

test('grid.split handler applies assignments to storyboards', async () => {
  const ts = now()
  const storyboardId = Number(db.insert(schema.storyboards).values({
    episodeId: 2,
    storyboardNumber: 1,
    title: 'shot',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.imageGenerations).values({
    id: 12,
    prompt: 'grid',
    provider: 'test',
    status: 'completed',
    localPath: 'static/images/grid.png',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const task = createTask({
    type: 'grid.split',
    payload: {
      image_generation_id: 12,
      rows: 1,
      cols: 1,
      assignments: [{ storyboard_id: storyboardId, frame_type: 'first_frame' }],
    },
  })
  const handler = createGridSplitHandler({
    splitGridImage: async () => [{ index: 0, localPath: 'static/grid-cells/cell.png' }],
  })

  const result = await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    progress() {},
    event() {},
    isCancelRequested() {
      return false
    },
  })

  assert.deepEqual(result.cells, [{
    storyboard_id: storyboardId,
    frame_type: 'first_frame',
    local_path: 'static/grid-cells/cell.png',
  }])
  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  assert.equal(storyboard.firstFrameImage, 'static/grid-cells/cell.png')
})
