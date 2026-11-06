import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const ownerName = /^owner-([1-9]\d*)-[a-f0-9-]{36}\.json$/

export class NbaJobLockBusyError extends Error {
  constructor() { super('NBA job is already locked'); this.name = 'NbaJobLockBusyError' }
}

function entries(file: string) {
  try { return fs.readdirSync(file) }
  catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error }
}

function ownerAlive(name: string) {
  const match = ownerName.exec(name)
  if (!match) return true
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid)) return true
  try { process.kill(pid, 0); return true }
  catch (error: any) { return error.code !== 'ESRCH' }
}

function removeOwner(file: string, name: string) {
  try { fs.unlinkSync(path.join(file, name)) }
  catch (error: any) { if (error.code !== 'ENOENT') throw error }
}

function removeEmptyDirectory(file: string) {
  try { fs.rmdirSync(file) }
  catch (error: any) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
}

export function nbaJobLockAlive(file: string) {
  return entries(file)?.some(ownerAlive) || false
}

export function acquireNbaJobLock(file: string): () => void {
  const token = randomUUID(), name = `owner-${process.pid}-${token}.json`
  const staging = `${file}.${token}.staging`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(staging, { mode: 0o700 })
  try {
    fs.writeFileSync(path.join(staging, name), JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(staging, file); break }
      catch (error: any) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
        if (attempt) throw new NbaJobLockBusyError()
        const owners = entries(file) || []
        if (owners.some(ownerAlive)) throw new NbaJobLockBusyError()
        // A delayed cleaner can only remove the dead owner's immutable filename.
        for (const owner of owners) removeOwner(file, owner)
        removeEmptyDirectory(file)
      }
    }
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
  let released = false
  return () => {
    if (released) return
    removeOwner(file, name)
    // A new owner may already have replaced the empty directory.
    removeEmptyDirectory(file)
    released = true
  }
}
