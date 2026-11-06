import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-style-pilots-route-'))
process.env.DB_PATH = join(dbDir, 'test.db')
process.env.TASK_WORKER_DISABLED = '1'

const { default: remotionRoute } = await import('./remotion.js')
const sqlite = new Database(process.env.DB_PATH)

test('a fresh database returns an empty style catalog without seeding obsolete preview URLs', async () => {
  const response = await remotionRoute.request('/style-pilots')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { code: 200, data: { items: [] }, message: 'success' })
})

const expectedItems = [
  {
    id: 'first', name: '已保存的图片', desc: '数据库里的说明', mood: '沉静', lens: '广角',
    profile: 'history', aspectRatio: '16:9', prompt: '既有提示词',
    url: '/static/images/saved-pilot.png', mediaType: 'image', sortOrder: 0,
  },
  {
    id: 'a-video', name: '已保存的视频', desc: null, mood: null, lens: null,
    profile: null, aspectRatio: '9:16', prompt: null,
    url: '/static/videos/saved-pilot.mp4', mediaType: 'video', sortOrder: 10,
  },
  {
    id: 'z-image', name: '同序号后排', desc: null, mood: null, lens: null,
    profile: null, aspectRatio: null, prompt: null,
    url: '/static/images/another-saved-pilot.png', mediaType: 'image', sortOrder: 10,
  },
]

test('the catalog returns stored media URLs and metadata in stable order, excluding disabled rows', async () => {
  const insert = sqlite.prepare(`
    INSERT INTO style_pilots
      (id, name, "desc", mood, lens, profile, aspect_ratio, prompt, url, media_type, sort_order, is_active, created_at, updated_at)
    VALUES (@id, @name, @desc, @mood, @lens, @profile, @aspectRatio, @prompt, @url, @mediaType, @sortOrder, @isActive, @createdAt, @updatedAt)
  `)
  for (const item of [...expectedItems].reverse()) {
    insert.run({ ...item, isActive: 1, createdAt: '2026-01-01', updatedAt: '2026-01-02' })
  }
  insert.run({
    ...expectedItems[0], id: 'disabled', isActive: 0, sortOrder: -1,
    createdAt: '2026-01-01', updatedAt: '2026-01-02',
  })
  const before = sqlite.prepare('SELECT * FROM style_pilots ORDER BY id').all()
  const response = await remotionRoute.request('/style-pilots')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { code: 200, data: { items: expectedItems }, message: 'success' })
  assert.deepEqual(sqlite.prepare('SELECT * FROM style_pilots ORDER BY id').all(), before)
})

test('reopening the database on a new process preserves saved previews without reseeding or replacement', () => {
  const before = sqlite.prepare('SELECT * FROM style_pilots ORDER BY id').all()
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { default: app } = await import('./src/routes/remotion.ts')
    const response = await app.request('/style-pilots')
    console.log('STYLE_PILOTS_RESPONSE:' + JSON.stringify({ status: response.status, body: await response.json() }))
  `], {
    cwd: new URL('../..', import.meta.url),
    env: process.env,
    encoding: 'utf8',
    timeout: 30000,
  })
  const result = output.split('\n').find(line => line.startsWith('STYLE_PILOTS_RESPONSE:'))
  assert.ok(result)
  assert.deepEqual(JSON.parse(result.slice('STYLE_PILOTS_RESPONSE:'.length)), {
    status: 200,
    body: { code: 200, data: { items: expectedItems }, message: 'success' },
  })
  assert.deepEqual(sqlite.prepare('SELECT * FROM style_pilots ORDER BY id').all(), before)
})
