import test from 'node:test'
import assert from 'node:assert/strict'
import { assertMediaDiskSpace, MEDIA_DISK_RESERVE_BYTES, watchMediaDiskSpace } from './storage-space.js'

test('disk preflight keeps the default reserve in addition to remaining write bytes', async t => {
  const previous = process.env.MEDIA_DISK_RESERVE_GIB
  t.after(() => { if (previous === undefined) delete process.env.MEDIA_DISK_RESERVE_GIB; else process.env.MEDIA_DISK_RESERVE_GIB = previous })
  process.env.MEDIA_DISK_RESERVE_GIB = ''
  const pendingBytes = 3 * 1024 ** 3
  await assert.rejects(assertMediaDiskSpace('/unused', pendingBytes, async () => ({
    bavail: MEDIA_DISK_RESERVE_BYTES + pendingBytes - 1, bsize: 1,
  })), { code: 'MEDIA_DISK_FULL' })
  await assertMediaDiskSpace('/unused', pendingBytes, async () => ({
    bavail: MEDIA_DISK_RESERVE_BYTES + pendingBytes, bsize: 1,
  }))
})

test('configured disk reserve is applied while invalid values use the default', async t => {
  const available = async () => ({ bavail: 11 * 1024 ** 3, bsize: 1 })
  const previous = process.env.MEDIA_DISK_RESERVE_GIB
  t.after(() => { if (previous === undefined) delete process.env.MEDIA_DISK_RESERVE_GIB; else process.env.MEDIA_DISK_RESERVE_GIB = previous })
  process.env.MEDIA_DISK_RESERVE_GIB = '12'
  await assert.rejects(assertMediaDiskSpace('/unused', 0, available), { code: 'MEDIA_DISK_FULL' })
  process.env.MEDIA_DISK_RESERVE_GIB = 'invalid'
  await assertMediaDiskSpace('/unused', -1, available)
})

test('a periodic low-space result aborts once and stops further checks', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const lowSpace = Object.assign(new Error('reserve reached'), { code: 'MEDIA_DISK_FULL' })
  let checks = 0
  const watcher = watchMediaDiskSpace('/unused', { check: async () => {
    if (++checks === 2) throw lowSpace
  } })
  t.after(() => watcher.stop())
  t.mock.timers.tick(1000)
  await watcher.check()
  assert.equal(watcher.signal.aborted, false)
  t.mock.timers.tick(1000)
  await watcher.check()
  assert.equal(watcher.signal.reason, lowSpace)
  t.mock.timers.tick(10_000)
  await watcher.check()
  assert.equal(checks, 2)
})

test('disk watchers do not overlap checks or abort work after stopping', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let checks = 0, rejectCheck!: (reason: Error) => void
  const watcher = watchMediaDiskSpace('/unused', { check: () => {
    checks++
    return new Promise<void>((_resolve, reject) => { rejectCheck = reject })
  } })
  t.after(() => watcher.stop())
  t.mock.timers.tick(1000)
  const pending = watcher.check()
  t.mock.timers.tick(5000)
  assert.equal(checks, 1)
  watcher.stop()
  rejectCheck(new Error('completed operation no longer needs a watcher'))
  await pending
  assert.equal(watcher.signal.aborted, false)
  t.mock.timers.tick(5000)
  assert.equal(checks, 1)
})
