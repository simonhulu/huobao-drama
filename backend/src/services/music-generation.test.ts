import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(path.join(tmpdir(), 'huobao-music-'))
process.env.DB_PATH = path.join(dbDir, 'test.db')
const storageDir = mkdtempSync(path.join(tmpdir(), 'huobao-music-storage-'))
process.env.STORAGE_PATH = storageDir

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { ensureStoryboardBGM } = await import('./music-generation.js')
const { saveMusicLibrary } = await import('./music-library.js')

function insertMusicConfig() {
  const ts = now()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'music',
    provider: 'minimax',
    name: 'MiniMax Music Test',
    baseUrl: 'https://api.minimax.io',
    apiKey: 'test-key',
    model: JSON.stringify(['music-2.6']),
    isActive: true,
    priority: 1,
    createdAt: ts,
    updatedAt: ts,
  }).run()
}

function insertStoryboard(values: Partial<typeof schema.storyboards.$inferInsert> = {}) {
  const ts = now()
  const dramaRes = db.insert(schema.dramas).values({
    title: 'Music Test Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const dramaId = Number(dramaRes.lastInsertRowid)

  const epRes = db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode 1',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const episodeId = Number(epRes.lastInsertRowid)

  const sbRes = db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    bgmPrompt: 'epic orchestral cinematic instrumental',
    duration: 10,
    createdAt: ts,
    updatedAt: ts,
    ...values,
  }).run()
  return { storyboardId: Number(sbRes.lastInsertRowid), episodeId, dramaId }
}

test('ensureStoryboardBGM reuses matched library music before calling MiniMax', async () => {
  insertMusicConfig()
  const { storyboardId } = insertStoryboard({
    description: '古代皇帝站在宫廷大殿，王朝气势宏大',
    bgmPrompt: 'historical Chinese orchestral epic instrumental music',
  })
  const relativePath = 'static/music/library-first-epic.mp3'
  const absPath = path.join(storageDir, 'music', 'library-first-epic.mp3')
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, Buffer.alloc(1024))
  saveMusicLibrary({
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: [{
      filename: 'library-first-epic.mp3',
      relativePath,
      url: relativePath,
      duration: 120,
      prompt: 'historical Chinese orchestral epic instrumental music',
      emotionBucket: 'epic',
      intensity: 'high',
      tags: ['epic', 'high', 'historical', 'orchestral'],
      source: 'minimax',
      createdAt: new Date().toISOString(),
    }],
  })

  const originalFetch = global.fetch
  let fetchCount = 0
  global.fetch = async () => {
    fetchCount++
    throw new Error('MiniMax should not be called when library music matches')
  }

  try {
    const url = await ensureStoryboardBGM(storyboardId, { force: true })
    assert.equal(url, relativePath)
    assert.equal(fetchCount, 0)

    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
    assert.equal(sb.bgmAudioUrl, relativePath)
  } finally {
    global.fetch = originalFetch
  }
})

test('ensureStoryboardBGM generates and stores BGM via MiniMax Music', async () => {
  insertMusicConfig()
  const { storyboardId } = insertStoryboard()

  const originalFetch = global.fetch
  let fetchCount = 0
  global.fetch = async (url: RequestInfo | URL) => {
    fetchCount++
    const u = url.toString()
    if (u.includes('/query/music_generation')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ task_id: 'task-123', status: 'Success', file_id: 'file-456' }),
      } as Response
    }
    if (u.includes('/files/retrieve')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          file: { file_id: 'file-456', download_url: 'https://cdn.example.com/bgm.mp3' },
          base_resp: { status_code: 0, status_msg: 'success' },
        }),
      } as Response
    }
    if (u.includes('/music_generation')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ task_id: 'task-123', status: 'queued' }),
      } as Response
    }
    if (u.includes('/files/retrieve')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          file: { file_id: 'file-456', download_url: 'https://cdn.example.com/bgm.mp3' },
          base_resp: { status_code: 0, status_msg: 'success' },
        }),
      } as Response
    }
    // download
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('fake music'),
    } as unknown as Response
  }

  try {
    const url = await ensureStoryboardBGM(storyboardId)
    assert.ok(url)
    assert.ok(url!.startsWith('static/music/'))
    assert.ok(fs.existsSync(path.join(storageDir, url!.replace('static/', ''))))

    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
    assert.equal(sb.bgmAudioUrl, url)
  } finally {
    global.fetch = originalFetch
  }
})
