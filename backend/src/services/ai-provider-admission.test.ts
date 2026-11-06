import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { createAIProviderAdmission, providerAdmissionKey } from './ai-provider-admission.js'

const identity = { endpoint: 'https://text.fixture.invalid/v1/chat/completions', apiKey: 'fixture-only-secret' }
const roots: string[] = []
function fixture(options: Partial<Omit<Parameters<typeof createAIProviderAdmission>[0], 'filename'>> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-admission-'))
  roots.push(root)
  const filename = path.join(root, 'admission.db')
  const coordinator = createAIProviderAdmission({ filename, pollMs: 5, maxWaitMs: 2000, ...options })
  return { filename, coordinator }
}
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) })

test('credential and normalized endpoint share capacity across models without persisting secrets', async () => {
  const { filename, coordinator } = fixture({ maxConcurrency: 1 })
  try {
    assert.equal(providerAdmissionKey(identity), providerAdmissionKey({ ...identity, endpoint: identity.endpoint + '/' }))
    assert.notEqual(providerAdmissionKey(identity), providerAdmissionKey({ ...identity, apiKey: 'other-secret' }))
    assert.notEqual(providerAdmissionKey(identity), providerAdmissionKey({ ...identity, endpoint: 'https://other.fixture.invalid/v1/chat/completions' }))
    await coordinator.run(identity, async () => {
      const database = new Database(filename, { readonly: true })
      try {
        const row = database.prepare('SELECT * FROM ai_provider_requests').get()
        const serialized = JSON.stringify(row)
        assert.ok(serialized.includes(providerAdmissionKey(identity)))
        assert.ok(!serialized.includes(identity.apiKey))
        assert.ok(!serialized.includes(identity.endpoint))
      } finally { database.close() }
    })
  } finally { coordinator.close() }
})

test('FIFO waiters retain order and independent credentials can run while a provider is occupied', async () => {
  const { coordinator } = fixture({ maxConcurrency: 1 })
  const events: string[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    const first = coordinator.run(identity, async () => { events.push('first'); await held })
    const second = coordinator.run(identity, async () => { events.push('second') })
    const third = coordinator.run(identity, async () => { events.push('third') })
    await coordinator.run({ ...identity, apiKey: 'independent' }, async () => { events.push('independent') })
    assert.deepEqual(events, ['first', 'independent'])
    release()
    await Promise.all([first, second, third])
    assert.deepEqual(events, ['first', 'independent', 'second', 'third'])
  } finally { release(); coordinator.close() }
})

test('aborted and expired waiters never dispatch and stop blocking the next request', async () => {
  const { filename, coordinator } = fixture({ maxConcurrency: 1 })
  const controller = new AbortController()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    const active = coordinator.run(identity, () => held)
    const aborted = coordinator.run(identity, async () => { assert.fail('aborted waiter was dispatched') }, { signal: controller.signal })
    controller.abort()
    await assert.rejects(aborted, { name: 'AbortError' })
    await assert.rejects(coordinator.run(identity, async () => { assert.fail('timed out waiter was dispatched') }, { maxWaitMs: 20 }), {
      name: 'AIProviderAdmissionError', status: 429, code: 'AI_TEXT_ADMISSION_TIMEOUT', source: 'local_admission', upstreamDispatched: false,
    })
    const database = new Database(filename, { readonly: true })
    try { assert.equal((database.prepare('SELECT count(*) AS count FROM ai_provider_requests').get() as {count: number}).count, 1) }
    finally { database.close() }
    release(); await active
    assert.equal(await coordinator.run(identity, async () => 'next'), 'next')
  } finally { release(); coordinator.close() }
})

test('HTTP 429 cooldown survives coordinator recreation and explicit zero does not impose a default delay', async () => {
  const { filename, coordinator } = fixture()
  let now = 10_000
  const clocked = createAIProviderAdmission({ filename, now: () => now, pollMs: 2, maxWaitMs: 10 })
  try {
    await clocked.run(identity, async lease => { await lease.defer(5000) })
    const another = createAIProviderAdmission({ filename, now: () => now, pollMs: 2, maxWaitMs: 10 })
    try {
      const controller = new AbortController()
      const blocked = another.run(identity, async () => { assert.fail('cooling provider was dispatched') }, { signal: controller.signal })
      await delay(5); controller.abort()
      await assert.rejects(blocked, { name: 'AbortError' })
      now += 5000
      await another.run(identity, async lease => { await lease.defer(0) })
      assert.equal(await another.run(identity, async () => 'after-zero'), 'after-zero')
    } finally { another.close() }
  } finally { clocked.close(); coordinator.close() }
})

test('expired crashed leases and dead waiters are reclaimed, but live request heartbeats hold capacity', async () => {
  const { filename, coordinator } = fixture({ maxConcurrency: 1, leaseMs: 60 })
  const database = new Database(filename)
  const scope = providerAdmissionKey(identity)
  try {
    database.prepare(`INSERT INTO ai_provider_requests(id,scope,pid,state,expires_at,max_concurrency) VALUES(?,?,?,'active',?,1)`)
      .run('crashed', scope, 2147483647, Date.now() - 1)
    database.prepare(`INSERT INTO ai_provider_requests(id,scope,pid,state,expires_at,max_concurrency) VALUES(?,?,?,'waiting',?,1)`)
      .run('dead-waiter', scope, 2147483647, Date.now() + 5000)
    let active = 0
    const runs = [0, 1].map(() => coordinator.run(identity, async () => {
      active++; assert.equal(active, 1)
      await delay(140)
      active--
    }))
    await Promise.all(runs)
    assert.equal((database.prepare('SELECT count(*) AS count FROM ai_provider_requests').get() as {count: number}).count, 0)
  } finally { database.close(); coordinator.close() }
})

test('unknown failures are never replayed and their capacity is released', async () => {
  const { coordinator } = fixture({ maxConcurrency: 1 })
  let calls = 0
  try {
    const failure = new Error('unknown remote outcome')
    await assert.rejects(coordinator.run(identity, async () => { calls++; throw failure }), error => error === failure)
    assert.equal(await coordinator.run(identity, async () => 'continued'), 'continued')
    assert.equal(calls, 1)
  } finally { coordinator.close() }
})

test('an expired heartbeat from a live process remains protected against oversubscription', async () => {
  const { filename, coordinator } = fixture({ maxConcurrency: 1 })
  const database = new Database(filename)
  try {
    database.prepare(`INSERT INTO ai_provider_requests(id,scope,pid,state,expires_at,max_concurrency) VALUES(?,?,?,'active',?,1)`)
      .run('delayed-live-heartbeat', providerAdmissionKey(identity), process.pid, Date.now() - 1000)
    await assert.rejects(coordinator.run(identity, async () => { assert.fail('live request was evicted') }, { maxWaitMs: 20 }), {
      code: 'AI_TEXT_ADMISSION_TIMEOUT', upstreamDispatched: false,
    })
    assert.ok(database.prepare('SELECT 1 FROM ai_provider_requests WHERE id=?').get('delayed-live-heartbeat'))
    database.prepare('DELETE FROM ai_provider_requests WHERE id=?').run('delayed-live-heartbeat')
  } finally { database.close(); coordinator.close() }
})

test('a delayed release does not replace a successful response and is retried before the next admission', async t => {
  let now = Date.now(), blockRelease = false
  const { filename, coordinator } = fixture({ maxConcurrency: 1, now: () => now })
  const database = new Database(filename)
  const prototype = Object.getPrototypeOf(database.prepare('SELECT 1'))
  const originalRun = prototype.run
  t.mock.method(prototype, 'run', function (this: {source: string}, ...values: unknown[]) {
    if (blockRelease && this.source === 'DELETE FROM ai_provider_requests WHERE id=?') {
      now += 6000
      throw Object.assign(new Error('fixture contention'), { code: 'SQLITE_BUSY' })
    }
    return Reflect.apply(originalRun, this, values)
  })
  t.mock.method(console, 'warn', () => undefined)
  try {
    assert.equal(await coordinator.run(identity, async () => { blockRelease = true; return 'complete response' }), 'complete response')
    assert.equal((database.prepare('SELECT count(*) AS count FROM ai_provider_requests').get() as {count: number}).count, 1)
    blockRelease = false
    assert.equal(await coordinator.run(identity, async () => 'next response'), 'next response')
    assert.equal((database.prepare('SELECT count(*) AS count FROM ai_provider_requests').get() as {count: number}).count, 0)
  } finally { database.close(); coordinator.close() }
})

test('a rolled-back admission retains pending releases for the next request', async t => {
  let clockOffset = 0, blockRelease = false, failAdmission = false
  const { filename, coordinator } = fixture({ maxConcurrency: 1, now: () => Date.now() + clockOffset })
  const database = new Database(filename)
  const prototype = Object.getPrototypeOf(database.prepare('SELECT 1'))
  const originalRun = prototype.run
  t.mock.method(prototype, 'run', function (this: {source: string}, ...values: unknown[]) {
    if (blockRelease && this.source === 'DELETE FROM ai_provider_requests WHERE id=?') {
      clockOffset += 6000
      throw Object.assign(new Error('fixture contention'), { code: 'SQLITE_BUSY' })
    }
    if (failAdmission && this.source === "DELETE FROM ai_provider_requests WHERE state='waiting' AND expires_at<=?") {
      failAdmission = false
      throw Object.assign(new Error('fixture storage failure after pending release'), { code: 'SQLITE_FULL' })
    }
    return Reflect.apply(originalRun, this, values)
  })
  t.mock.method(console, 'warn', () => undefined)
  try {
    assert.equal(await coordinator.run(identity, async () => { blockRelease = true; return 'complete response' }), 'complete response')
    blockRelease = false; failAdmission = true
    await assert.rejects(coordinator.run(identity, async () => { assert.fail('failed admission dispatched work') }), {
      code: 'AI_TEXT_ADMISSION_UNAVAILABLE', upstreamDispatched: false,
    })
    assert.equal((database.prepare('SELECT count(*) AS count FROM ai_provider_requests').get() as {count: number}).count, 1)
    assert.equal(await coordinator.run(identity, async () => 'recovered', { maxWaitMs: 50 }), 'recovered')
    assert.equal((database.prepare('SELECT count(*) AS count FROM ai_provider_requests').get() as {count: number}).count, 0)
  } finally { database.close(); coordinator.close() }
})

test('a killed owner reserves its short grace lease and then another process can continue', { timeout: 15_000 }, async () => {
  const { filename, coordinator } = fixture({ maxConcurrency: 1 })
  const moduleUrl = new URL('./ai-provider-admission.ts', import.meta.url).href
  const script = `
    import {createAIProviderAdmission} from ${JSON.stringify(moduleUrl)};
    const admission=createAIProviderAdmission({filename:process.argv[1],maxConcurrency:1,leaseMs:150,pollMs:5});
    await admission.run(${JSON.stringify(identity)},async()=>{
      setInterval(()=>{},1000);
      process.stdout.write('leased\\n');
      await new Promise(()=>{});
    });
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, filename], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exit = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject) })
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = ''
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('leased')) resolve() })
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`owner exited before admission: ${code}`)))
    })
    const database = new Database(filename, { readonly: true })
    const expires = (database.prepare("SELECT expires_at FROM ai_provider_requests WHERE state='active'").get() as {expires_at:number}).expires_at
    database.close()
    child.kill('SIGKILL'); await exit
    await coordinator.run(identity, async () => { assert.ok(Date.now() >= expires, 'crashed work must keep its grace period') })
  } finally { child.kill('SIGKILL'); await exit; coordinator.close() }
})

test('separate processes enforce the same provider limit', { timeout: 20_000 }, async () => {
  const { filename, coordinator } = fixture()
  coordinator.close()
  const moduleUrl = new URL('./ai-provider-admission.ts', import.meta.url).href
  const script = `
    import {createAIProviderAdmission} from ${JSON.stringify(moduleUrl)};
    import {setTimeout as delay} from 'node:timers/promises';
    const admission=createAIProviderAdmission({filename:process.argv[1],maxConcurrency:2,pollMs:5,maxWaitMs:10000});
    try { await admission.run(${JSON.stringify(identity)},async()=>{
      process.stdout.write(JSON.stringify({kind:'start',at:Date.now(),pid:process.pid})+'\\n');
      await delay(250);
      process.stdout.write(JSON.stringify({kind:'end',at:Date.now(),pid:process.pid})+'\\n');
    }) } finally {admission.close()}
  `
  const events: Array<{kind:string;at:number;pid:number}> = []
  await Promise.all([0, 1, 2, 3].map(() => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, filename], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${stderr}`))
      for (const line of stdout.trim().split('\n')) events.push(JSON.parse(line))
      resolve()
    })
  })))
  let active = 0, maximum = 0
  for (const event of events.sort((a, b) => a.at - b.at || (a.kind === 'end' ? -1 : 1))) {
    active += event.kind === 'start' ? 1 : -1
    maximum = Math.max(maximum, active)
    assert.ok(active <= 2, `cross-process limit exceeded: ${JSON.stringify(events)}`)
  }
  assert.equal(events.length, 8)
  assert.equal(active, 0)
  assert.equal(maximum, 2)
})
