import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { acquireNbaJobLock, nbaJobLockAlive, NbaJobLockBusyError } from './nba-job-lock.js'

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-job-lock-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, file: path.join(root, '.job-fixture.lock') }
}

function staleOwner(file: string) {
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid
  assert.ok(deadPid)
  assert.throws(() => process.kill(deadPid, 0), (error: any) => error.code === 'ESRCH')
  const name = `owner-${deadPid}-${randomUUID()}.json`
  fs.mkdirSync(file)
  fs.writeFileSync(path.join(file, name), JSON.stringify({ pid: deadPid }))
  return name
}

test('a nonempty live lease excludes other owners, releases idempotently, and leaves no staging directories', t => {
  const { file, root } = fixture(t)
  assert.equal(nbaJobLockAlive(file), false)
  const release = acquireNbaJobLock(file)
  assert.equal(fs.statSync(file).isDirectory(), true)
  assert.equal(fs.readdirSync(file).length, 1)
  assert.equal(nbaJobLockAlive(file), true)
  assert.throws(() => acquireNbaJobLock(file), NbaJobLockBusyError)
  assert.equal(fs.readdirSync(root).length, 1)
  release()
  assert.equal(nbaJobLockAlive(file), false)
  assert.equal(fs.existsSync(file), false)
  const second = acquireNbaJobLock(file)
  release()
  assert.equal(nbaJobLockAlive(file), true)
  assert.throws(() => acquireNbaJobLock(file), NbaJobLockBusyError)
  second()
  assert.deepEqual(fs.readdirSync(root), [])
})

test('a dead owner can be reclaimed without retaining its ownership token', t => {
  const { file } = fixture(t)
  const stale = staleOwner(file)
  assert.equal(nbaJobLockAlive(file), false)
  const release = acquireNbaJobLock(file)
  assert.equal(nbaJobLockAlive(file), true)
  assert.equal(fs.existsSync(path.join(file, stale)), false)
  assert.equal(fs.readdirSync(file).length, 1)
  release()
})

test('an empty released directory can be replaced while an unknown owner remains protected', t => {
  const { file } = fixture(t)
  fs.mkdirSync(file)
  const release = acquireNbaJobLock(file)
  release()
  fs.mkdirSync(file)
  fs.writeFileSync(path.join(file, 'unknown-owner'), 'preserve this')
  assert.equal(nbaJobLockAlive(file), true)
  assert.throws(() => acquireNbaJobLock(file), NbaJobLockBusyError)
  assert.equal(fs.readFileSync(path.join(file, 'unknown-owner'), 'utf8'), 'preserve this')
})

const workerSource = String.raw`
const fs = require('node:fs')
const { parentPort, workerData: d } = require('node:worker_threads')
;(async () => {
  const { tsImport } = await import('tsx/esm/api')
  const { acquireNbaJobLock, NbaJobLockBusyError } = await tsImport(d.moduleUrl, d.moduleUrl)
  const original = fs[d.pauseOperation]
  let paused = false
  fs[d.pauseOperation] = function(file, ...args) {
    if (String(file) === d.pauseFile && !paused) {
      paused = true
      parentPort.postMessage('paused')
      Atomics.wait(new Int32Array(d.gate), 0, 0)
    }
    return original.call(fs, file, ...args)
  }
  try {
    const release = acquireNbaJobLock(d.file)
    parentPort.postMessage('acquired')
    parentPort.on('message', command => {
      if (command !== 'release') return
      release()
      parentPort.postMessage('released')
      parentPort.close()
    })
  } catch (error) {
    parentPort.postMessage(error instanceof NbaJobLockBusyError ? 'busy' : { error: error.message })
    parentPort.close()
  }
})().catch(error => { parentPort.postMessage({ error: error.message }); parentPort.close() })
`

function worker(t: TestContext, file: string, pauseOperation: 'unlinkSync' | 'rmdirSync', pauseFile: string) {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const resume = () => { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0) }
  const thread = new Worker(workerSource, { eval: true, execArgv: [], workerData: {
    gate, file, pauseOperation, pauseFile, moduleUrl: new URL('./nba-job-lock.ts', import.meta.url).href,
  } })
  t.after(async () => { resume(); await thread.terminate() })
  return { thread, resume, async message() {
    const [message] = await once(thread, 'message', { signal: t.signal })
    if (message?.error) assert.fail(message.error)
    return message
  } }
}

test('two stale cleaners cannot both acquire the job or remove the new live lease', { timeout: 15_000 }, async t => {
  const { file } = fixture(t), stale = staleOwner(file)
  const first = worker(t, file, 'unlinkSync', path.join(file, stale))
  assert.equal(await first.message(), 'paused')
  const second = worker(t, file, 'unlinkSync', path.join(file, stale))
  assert.equal(await second.message(), 'paused')
  const acquired = first.message()
  first.resume()
  assert.equal(await acquired, 'acquired')
  const rejected = second.message()
  second.resume()
  assert.equal(await rejected, 'busy')
  assert.equal(nbaJobLockAlive(file), true)
  assert.throws(() => acquireNbaJobLock(file), NbaJobLockBusyError)
  const released = first.message()
  first.thread.postMessage('release')
  assert.equal(await released, 'released')
  assert.equal(nbaJobLockAlive(file), false)
})

test('a delayed release cannot remove a successor published into the empty directory', { timeout: 15_000 }, async t => {
  const { file } = fixture(t)
  const first = worker(t, file, 'rmdirSync', file)
  assert.equal(await first.message(), 'acquired')
  const paused = first.message()
  first.thread.postMessage('release')
  assert.equal(await paused, 'paused')
  const release = acquireNbaJobLock(file)
  const released = first.message()
  first.resume()
  assert.equal(await released, 'released')
  assert.equal(nbaJobLockAlive(file), true)
  assert.throws(() => acquireNbaJobLock(file), NbaJobLockBusyError)
  release()
})
