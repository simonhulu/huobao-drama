import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const directory = mkdtempSync(join(tmpdir(), 'history-script-deletion-migration-'))
process.env.DB_PATH = join(directory, 'existing.db')
process.env.TASK_WORKER_DISABLED = '1'
const sqlite = new Database(process.env.DB_PATH)
sqlite.exec(`
  CREATE TABLE history_script_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT 'douyin', source_video_id TEXT NOT NULL,
    source_url TEXT NOT NULL, title TEXT NOT NULL, author_name TEXT, category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'selected', metrics_json TEXT NOT NULL DEFAULT '{}',
    selection_json TEXT NOT NULL DEFAULT '{}', media_json TEXT NOT NULL DEFAULT '{}',
    raw_transcript TEXT, corrected_transcript TEXT, rewritten_script TEXT,
    asr_json TEXT, review_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CONSTRAINT history_script_sources_platform_video_unique UNIQUE (platform, source_video_id)
  );
  INSERT INTO history_script_sources (source_video_id, source_url, title, category, rewritten_script, created_at, updated_at)
  VALUES ('123', 'https://www.douyin.com/video/123', 'Existing draft', 'history_trivia', 'Keep this script', '2026-10-01', '2026-10-02');
`)
const original = sqlite.prepare('SELECT * FROM history_script_sources').get() as Record<string, unknown>

const { createHistoryScriptsRoute } = await import('../routes/history-scripts.js')
const route = createHistoryScriptsRoute({ storageRoot: join(directory, 'media') })

test('existing databases gain a nullable deletion marker without losing data, and deletion survives restart', async () => {
  assert.deepEqual(sqlite.prepare('SELECT * FROM history_script_sources').get(), { ...original, deleted_at: null })
  const before = (await (await route.request('/1')).json()).data
  assert.equal(before.rewrittenScript, 'Keep this script')
  assert.equal((await route.request('/1', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: before.revision }),
  })).status, 200)
  const deleted = sqlite.prepare('SELECT * FROM history_script_sources').get() as Record<string, unknown>
  assert.ok(deleted.deleted_at)
  assert.equal(deleted.rewritten_script, original.rewritten_script)
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { createHistoryScriptsRoute } = await import('./src/routes/history-scripts.ts')
    const route = createHistoryScriptsRoute()
    const listing = await (await route.request('/')).json()
    const detail = await route.request('/1')
    console.log('DELETION_CHECK:' + JSON.stringify({ total: listing.data.total, status: detail.status }))
  `], { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 30000 })
  const result = output.split('\n').find(line => line.startsWith('DELETION_CHECK:'))
  assert.ok(result)
  assert.deepEqual(JSON.parse(result.slice('DELETION_CHECK:'.length)), { total: 0, status: 404 })
  assert.deepEqual(sqlite.prepare('SELECT * FROM history_script_sources').get(), deleted)
  sqlite.close()
})
