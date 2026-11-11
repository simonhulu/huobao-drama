import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseHistoryStatusMaintenanceOptions, runHistoryStatusMaintenance } from './history-status-maintenance.js'

test('maintenance checks without writes and resumes bounded batches after reopening the database', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-status-maintenance-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'test.db'), backup = path.join(directory, 'before.db')
  const database = new Database(filename)
  database.exec(`CREATE TABLE history_motion_productions(id TEXT PRIMARY KEY,script_id INTEGER,status TEXT,updated_at TEXT,snapshot TEXT);
    INSERT INTO history_motion_productions VALUES('one',1,'queued','now','{}'),('two',2,'queued','now','{}');`)
  database.close()
  const check = await runHistoryStatusMaintenance(parseHistoryStatusMaintenanceOptions(['--db',filename]), () => {})
  assert.equal(check.motion.pending, 2)
  const untouched = new Database(filename, { readonly: true })
  assert.equal(untouched.prepare("SELECT name FROM sqlite_master WHERE name='history_motion_status'").get(), undefined)
  untouched.close()
  const first = await runHistoryStatusMaintenance(parseHistoryStatusMaintenanceOptions([
    '--db',filename,'--apply','--batch-size','1','--max-batches','1','--backup',backup,
  ]), () => {})
  assert.equal(first.motion.current, 1)
  assert.equal(first.motion.pending, 1)
  const second = await runHistoryStatusMaintenance(parseHistoryStatusMaintenanceOptions(['--db',filename,'--apply']), () => {})
  assert.equal(second.motion.current, 2)
  assert.equal(second.motion.pending, 0)
  const saved = new Database(backup, { readonly: true })
  assert.equal(saved.prepare("SELECT COUNT(*) AS count FROM history_motion_productions").get()!.count, 2)
  assert.equal(saved.prepare("SELECT name FROM sqlite_master WHERE name='history_motion_status'").get(), undefined)
  saved.close()
})

test('maintenance rejects mutating flags without apply and invalid batch options', () => {
  assert.throws(() => parseHistoryStatusMaintenanceOptions(['--db','test.db','--watch']), /require --apply/)
  assert.throws(() => parseHistoryStatusMaintenanceOptions(['--db','test.db','--batch-size','0']), /Invalid/)
})
