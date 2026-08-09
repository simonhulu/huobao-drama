import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  acquireDharmaRenderLock,
  releaseDharmaRenderLock,
} from './dharma_render_lock.mjs'

test('one global render lock serializes different run owners', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-render-lock-'))
  const lockPath = join(temp, 'render.lock')
  const first = acquireDharmaRenderLock({ lockPath, owner: 'run-a', waitMs: 0, maxWaitMs: 0 })
  assert.throws(
    () => acquireDharmaRenderLock({ lockPath, owner: 'run-b', waitMs: 0, maxWaitMs: 0 }),
    /DHARMA_RENDER_LOCK_ACTIVE/u,
  )
  releaseDharmaRenderLock(first)
  const second = acquireDharmaRenderLock({ lockPath, owner: 'run-b', waitMs: 0, maxWaitMs: 0 })
  assert.equal(second.owner, 'run-b')
  releaseDharmaRenderLock(second)
  assert.equal(existsSync(lockPath), false)
})

test('a dead owner lock is recoverable without waiting for its old expiry', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-render-lock-stale-'))
  const lockPath = join(temp, 'render.lock')
  writeFileSync(lockPath, JSON.stringify({
    owner: 'dead-run',
    pid: 999999,
    hostname: hostname(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  }))
  const acquired = acquireDharmaRenderLock({ lockPath, owner: 'new-run', waitMs: 0, maxWaitMs: 0 })
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).owner, 'new-run')
  releaseDharmaRenderLock(acquired)
  assert.equal(existsSync(lockPath), false)
})
