import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const defaultDharmaRenderLockPath = join(repoRoot, 'data/temp/dharma-comic-render.lock')
const remoteLockLeaseMs = 12 * 60 * 60_000

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, milliseconds)
}

function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function acquireDharmaRenderLock(options = {}) {
  const lockPath = resolve(options.lockPath || defaultDharmaRenderLockPath)
  const owner = String(options.owner || `${hostname()}:${process.pid}:${randomUUID()}`)
  const waitMs = Number(options.waitMs ?? 1000)
  const maxWaitMs = Number(options.maxWaitMs ?? Number.POSITIVE_INFINITY)
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('Render lock waitMs must be non-negative')
  if (!(maxWaitMs === Number.POSITIVE_INFINITY || (Number.isFinite(maxWaitMs) && maxWaitMs >= 0))) {
    throw new Error('Render lock maxWaitMs must be non-negative or Infinity')
  }

  const startedAtMs = Date.now()
  const record = {
    owner,
    pid: Number(options.pid || process.pid),
    hostname: String(options.hostname || hostname()),
    acquiredAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(startedAtMs + remoteLockLeaseMs).toISOString(),
    ...(options.metadata && typeof options.metadata === 'object' ? { metadata: options.metadata } : {}),
  }
  mkdirSync(dirname(lockPath), { recursive: true })

  while (true) {
    try {
      const descriptor = openSync(lockPath, 'wx')
      try {
        writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`)
      } finally {
        closeSync(descriptor)
      }
      return { lockPath, owner, record }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = readLock(lockPath)
      const sameHostLiveProcess = existing?.hostname === hostname()
        && processIsAlive(Number(existing?.pid))
      const expiresAt = new Date(existing?.expiresAt || 0).getTime()
      const remoteLockStillValid = existing?.hostname !== hostname()
        && Number.isFinite(expiresAt)
        && expiresAt > Date.now()
      if (!sameHostLiveProcess && !remoteLockStillValid) {
        try {
          unlinkSync(lockPath)
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError
        }
        continue
      }

      if (Date.now() - startedAtMs >= maxWaitMs) {
        throw new Error(`DHARMA_RENDER_LOCK_ACTIVE: ${lockPath} is owned by ${existing?.owner || 'unknown'}`)
      }
      sleepSync(waitMs)
    }
  }
}

export function releaseDharmaRenderLock(lock) {
  if (!lock?.lockPath || !existsSync(lock.lockPath)) return
  const existing = readLock(lock.lockPath)
  if (existing?.owner && existing.owner !== lock.owner) {
    throw new Error(`DHARMA_RENDER_LOCK_OWNERSHIP_MISMATCH: ${lock.lockPath}`)
  }
  unlinkSync(lock.lockPath)
}
