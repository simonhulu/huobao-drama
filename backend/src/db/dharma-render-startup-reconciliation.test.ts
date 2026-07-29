import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { reconcileDharmaActiveRenderStartupState } from './dharma-render-startup-reconciliation.js'

function createTaskTables(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE creation_tasks (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      episode_id INTEGER,
      lease_owner TEXT,
      lease_expires_at TEXT,
      commit_claimed_at TEXT,
      error_code TEXT,
      error_message TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE creation_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL
    );
  `)
}

test('startup reconciliation makes expired commit claims stale and preserves one live Dharma render', () => {
  const sqlite = new Database(':memory:')
  createTaskTables(sqlite)
  const now = '2026-07-28T08:00:00.000Z'
  const insert = sqlite.prepare(`
    INSERT INTO creation_tasks (
      id, type, status, episode_id, lease_owner, lease_expires_at, commit_claimed_at,
      updated_at, created_at
    ) VALUES (?, 'dharma.episode_render', ?, 693, ?, ?, ?, ?, ?)
  `)
  insert.run(1, 'running', 'old-worker', '2026-07-28T07:59:00.000Z', '2026-07-28T07:58:00.000Z', now, now)
  insert.run(2, 'queued', null, null, null, now, now)
  insert.run(3, 'running', 'live-worker', '2026-07-28T08:05:00.000Z', null, now, now)

  const result = reconcileDharmaActiveRenderStartupState(sqlite, now)

  assert.deepEqual(result, {
    expiredCommitClaimsMarkedStale: 1,
    duplicateActiveRendersMarkedStale: 1,
    reconciledEpisodeIds: [693],
  })
  const rows = sqlite.prepare(`
    SELECT id, status, lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
      error_code AS errorCode
    FROM creation_tasks
    ORDER BY id
  `).all() as Array<{ id: number; status: string; leaseOwner: string | null; leaseExpiresAt: string | null; errorCode: string | null }>
  assert.deepEqual(rows, [
    { id: 1, status: 'stale', leaseOwner: null, leaseExpiresAt: null, errorCode: 'task_commit_claimed_reconciliation_required' },
    { id: 2, status: 'stale', leaseOwner: null, leaseExpiresAt: null, errorCode: 'duplicate_active_dharma_render' },
    { id: 3, status: 'running', leaseOwner: 'live-worker', leaseExpiresAt: '2026-07-28T08:05:00.000Z', errorCode: null },
  ])
  const eventCount = sqlite.prepare(`SELECT COUNT(*) AS count FROM creation_task_events`).get() as { count: number }
  assert.equal(eventCount.count, 2)

  assert.doesNotThrow(() => sqlite.exec(`
    CREATE UNIQUE INDEX uniq_active_dharma_episode_render
      ON creation_tasks (episode_id)
      WHERE type = 'dharma.episode_render'
        AND status IN ('queued', 'running')
        AND episode_id IS NOT NULL
  `))
  sqlite.close()
})
