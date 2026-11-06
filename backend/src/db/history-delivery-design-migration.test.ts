import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const directory = mkdtempSync(join(tmpdir(), 'history-delivery-design-migration-'))
process.env.DB_PATH = join(directory, 'existing.db')
process.env.TASK_WORKER_DISABLED = '1'
const sqlite = new Database(process.env.DB_PATH)
sqlite.exec(`
  CREATE TABLE history_script_deliveries (
    script_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    video_path TEXT, video_name TEXT, duration REAL, script_sha256 TEXT, cover_script_sha256 TEXT,
    cover_design_json TEXT NOT NULL DEFAULT '{}', covers_json TEXT NOT NULL DEFAULT '{}',
    cover_status TEXT NOT NULL DEFAULT 'idle', cover_run_id TEXT, cover_lease_until TEXT,
    error TEXT, updated_at TEXT NOT NULL
  );
  INSERT INTO history_script_deliveries (script_id, title, description, video_path, cover_design_json,
    covers_json, cover_status, updated_at)
  VALUES (1, '保留已确认的标题', '保留已确认的简介', 'static/existing.mp4', '{"main_title":"保留已确认的标题"}',
    '{"16:9":"static/existing.png"}', 'completed', '2026-10-01T00:00:00Z');
`)
const original = sqlite.prepare('SELECT * FROM history_script_deliveries').get() as Record<string, unknown>
const { db } = await import('./index.js')
after(() => {
  db.$client.close()
  sqlite.close()
  rmSync(directory, { recursive: true, force: true })
})

test('existing delivery databases gain independent design task fields without changing saved content', () => {
  assert.deepEqual(sqlite.prepare('SELECT * FROM history_script_deliveries').get(), {
    ...original, design_status: 'idle', design_run_id: null, design_lease_until: null, design_error: null, baijiahao_title: '',
  })
})

test('restarting the database migration preserves an existing design job and its saved package', () => {
  sqlite.prepare(`UPDATE history_script_deliveries SET design_status='generating', design_run_id='existing-run',
    design_lease_until='2099-01-01T00:00:00Z', baijiahao_title='保留百家号独立标题' WHERE script_id=1`).run()
  const before = sqlite.prepare('SELECT * FROM history_script_deliveries').get()
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { db } = await import('./src/db/index.ts')
    console.log('DESIGN_MIGRATION:' + JSON.stringify(db.$client.prepare('SELECT * FROM history_script_deliveries').get()))
    db.$client.close()
  `], { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', timeout: 30000 })
  const line = output.split('\n').find(value => value.startsWith('DESIGN_MIGRATION:'))
  assert.ok(line)
  assert.deepEqual(JSON.parse(line.slice('DESIGN_MIGRATION:'.length)), before)
  assert.deepEqual(sqlite.prepare('SELECT * FROM history_script_deliveries').get(), before)
})
