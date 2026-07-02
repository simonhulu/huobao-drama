import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-agent-run-fs-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { createTask, getTask } = await import('../store.js')
const { createAgentRunHandler } = await import('./agent-run.js')
const { db, schema } = await import('../../../db/index.js')

function seedEpisode(workflowType: string, overrides: Partial<typeof schema.episodes.$inferInsert> = {}) {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Direct Script Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    autoMode: true,
    workflowType,
    pacingMode: workflowType === 'direct_script' ? 'literal' : 'tight',
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  }).run().lastInsertRowid)
  return { dramaId, episodeId, ts }
}

test('direct-script extractor schedules breaker directly when no characters need voices', async () => {
  const { dramaId, episodeId } = seedEpisode('direct_script')

  const handler = createAgentRunHandler({
    createAgent: () => ({
      generate: async () => ({ text: 'extracted', toolCalls: [], toolResults: [] }),
    }),
  })
  const task = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    payload: {
      agent_type: 'extractor',
      message: 'extract characters and scenes',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    attempts: 1,
    progress() {},
    event() {},
    isCancelRequested() { return false },
  })

  const allTasks = db.select().from(schema.creationTasks).all().filter(row => row.episodeId === episodeId)
  const voiceTasks = allTasks.filter(row => getTask(row.id)?.payload?.agent_type === 'voice_assigner')
  const breakerTasks = allTasks.filter(row => getTask(row.id)?.payload?.agent_type === 'storyboard_breaker')

  assert.equal(voiceTasks.length, 0, 'no characters means no voice_assigner')
  assert.equal(breakerTasks.length, 1, 'direct-script extractor should schedule breaker directly')
})

test('direct-script voice_assigner schedules breaker instead of story-rewrite pipeline', async () => {
  const { dramaId, episodeId } = seedEpisode('direct_script')
  const ts = new Date().toISOString()
  const charId = Number(db.insert(schema.characters).values({
    dramaId,
    name: 'Narrator',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId, characterId: charId, createdAt: ts }).run()

  const handler = createAgentRunHandler({
    createAgent: () => ({
      generate: async () => ({ text: 'voices assigned', toolCalls: [], toolResults: [] }),
    }),
  })
  const task = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    payload: {
      agent_type: 'voice_assigner',
      message: 'assign voices',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    attempts: 1,
    progress() {},
    event() {},
    isCancelRequested() { return false },
  })

  const allTasks = db.select().from(schema.creationTasks).all().filter(row => row.episodeId === episodeId)
  const breakerTasks = allTasks.filter(row => getTask(row.id)?.payload?.agent_type === 'storyboard_breaker')
  const imageTasks = allTasks.filter(row => row.type === 'image.generate')

  assert.equal(breakerTasks.length, 1)
  assert.equal(imageTasks.length, 0, 'direct-script voice_assigner should not schedule character image tasks')
})

test('direct-script narrator agent restores original text and does not run narrator model', async () => {
  const { dramaId, episodeId, ts } = seedEpisode('direct_script', {
    narrationMode: 'verbatim',
    scriptContent: '第一句原文。第二句原文。',
  })
  db.insert(schema.storyboards).values([
    {
      episodeId,
      storyboardNumber: 1,
      narration: '我被污染了。',
      firstFrameImage: '/tmp/shot-1.png',
      createdAt: ts,
      updatedAt: ts,
    },
    {
      episodeId,
      storyboardNumber: 2,
      narration: '我还是第一人称。',
      firstFrameImage: '/tmp/shot-2.png',
      createdAt: ts,
      updatedAt: ts,
    },
  ]).run()

  let createAgentCalled = false
  const handler = createAgentRunHandler({
    createAgent: () => {
      createAgentCalled = true
      throw new Error('direct_script must not call narrator agent')
    },
  })
  const task = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    payload: {
      agent_type: 'narrator',
      message: '以主角“我”的第一人称视角生成旁白',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  const result = await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    attempts: 1,
    progress() {},
    event() {},
    isCancelRequested() { return false },
  })

  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  assert.equal(createAgentCalled, false)
  assert.equal(rows.map(row => row.narration).join(''), '第一句原文。第二句原文。')
  assert.match(result.text, /原文/)
})

test('direct-script storyboard_breaker restores source narration and skips narrator/splitter', async () => {
  const { dramaId, episodeId, ts } = seedEpisode('direct_script', {
    scriptContent: '第一句原文。第二句原文。',
  })

  const handler = createAgentRunHandler({
    createAgent: () => ({
      generate: async () => {
        db.insert(schema.storyboards).values([
          {
            episodeId,
            storyboardNumber: 1,
            firstFrameImage: '/tmp/shot-1.png',
            createdAt: ts,
            updatedAt: ts,
          },
          {
            episodeId,
            storyboardNumber: 2,
            firstFrameImage: '/tmp/shot-2.png',
            createdAt: ts,
            updatedAt: ts,
          },
        ]).run()
        return { text: 'storyboards broken down', toolCalls: [], toolResults: [] }
      },
    }),
  })
  const task = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    payload: {
      agent_type: 'storyboard_breaker',
      message: 'break down direct script',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    attempts: 1,
    progress() {},
    event() {},
    isCancelRequested() { return false },
  })

  const allTasks = db.select().from(schema.creationTasks).all().filter(row => row.episodeId === episodeId)
  const splitterTasks = allTasks.filter(row => getTask(row.id)?.payload?.agent_type === 'storyboard_splitter')
  const narratorTasks = allTasks.filter(row => getTask(row.id)?.payload?.agent_type === 'narrator')

  assert.equal(splitterTasks.length, 0, 'direct-script workflow should not schedule storyboard_splitter')
  assert.equal(narratorTasks.length, 0, 'direct-script workflow should not schedule narrator')
})

test('story-rewrite storyboard_breaker still schedules storyboard_splitter', async () => {
  const { dramaId, episodeId } = seedEpisode('story_rewrite')

  const handler = createAgentRunHandler({
    createAgent: () => ({
      generate: async () => ({ text: 'storyboards broken down', toolCalls: [], toolResults: [] }),
    }),
  })
  const task = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    payload: {
      agent_type: 'storyboard_breaker',
      message: 'break down story rewrite',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    attempts: 1,
    progress() {},
    event() {},
    isCancelRequested() { return false },
  })

  const allTasks = db.select().from(schema.creationTasks).all().filter(row => row.episodeId === episodeId)
  const splitterTasks = allTasks.filter(row => getTask(row.id)?.payload?.agent_type === 'storyboard_splitter')
  const narratorTasks = allTasks.filter(row => getTask(row.id)?.payload?.agent_type === 'narrator')

  assert.equal(splitterTasks.length, 1)
  assert.equal(narratorTasks.length, 0)
})

test('story-rewrite narrator agent still runs normally', async () => {
  const { dramaId, episodeId } = seedEpisode('story_rewrite', {
    narrationMode: 'rewrite',
    content: '原始故事',
    scriptContent: '格式化剧本',
  })

  let createAgentCalled = false
  const handler = createAgentRunHandler({
    createAgent: (type) => {
      createAgentCalled = true
      assert.equal(type, 'narrator')
      return {
        generate: async () => ({ text: 'narrator ran', toolCalls: [], toolResults: [] }),
      }
    },
  })
  const task = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    payload: {
      agent_type: 'narrator',
      message: '生成解说文案',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  const result = await handler.run({
    taskId: task.id,
    payload: task.payload,
    signal: new AbortController().signal,
    attempts: 1,
    progress() {},
    event() {},
    isCancelRequested() { return false },
  })

  assert.equal(createAgentCalled, true)
  assert.equal(result.text, 'narrator ran')
})
