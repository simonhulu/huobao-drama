import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { HistoryProductionGate } from './history-production-gate.js'

test('two project slots are shared across connections and retained until every branch releases', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'production-gate-'))
  const first = new Database(path.join(root, 'db.sqlite'))
  const second = new Database(path.join(root, 'db.sqlite'))
  t.after(() => { first.close(); second.close(); rmSync(root, { recursive: true, force: true }) })
  const a = new HistoryProductionGate(first), b = new HistoryProductionGate(second)
  assert.equal(a.tryAcquire(1, 'design:1'), true)
  assert.equal(b.tryAcquire(1, 'article:1'), true)
  assert.equal(b.tryAcquire(2, 'design:2'), true)
  assert.equal(a.tryAcquire(3, 'design:3'), false)
  a.release('design:1')
  assert.equal(a.tryAcquire(3, 'design:3'), false, 'The first project still has an article running')
  b.release('article:1')
  assert.equal(a.tryAcquire(3, 'design:3'), true)
  assert.deepEqual(a.overview(), { limit: 2, activeProjects: 2, waitingProjects: 0 })
})

test('queued production never calls its action, cancellation releases it and model failure frees capacity', async t => {
  const db = new Database(':memory:'); t.after(() => db.close())
  const gate = new HistoryProductionGate(db, { pollMs: 1 })
  gate.tryAcquire(1, 'one'); gate.tryAcquire(2, 'two')
  const controller = new AbortController()
  let calls = 0
  const waiting = gate.run(3, 'three', async () => { calls++ }, controller.signal)
  assert.equal(calls, 0)
  assert.deepEqual(gate.overview(), { limit: 2, activeProjects: 2, waitingProjects: 1 })
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(gate.overview().waitingProjects, 0)
  gate.release('one')
  await assert.rejects(gate.run(3, 'three', async () => { throw new Error('model failed') }), /model failed/)
  assert.equal(gate.tryAcquire(4, 'four'), true)
})

test('pipeline reservation survives its caller and releases when the saved task settles', t => {
  const db = new Database(':memory:'); t.after(() => db.close())
  db.exec('CREATE TABLE history_huasheng_export_jobs(id INTEGER,source_id INTEGER,status TEXT); INSERT INTO history_huasheng_export_jobs VALUES(1,1,\'processing\'),(2,2,\'processing\')')
  const before = new HistoryProductionGate(db), after = new HistoryProductionGate(db, { isProcessAlive: () => false })
  before.tryAcquire(1, 'export:1', 'pipeline'); before.tryAcquire(2, 'export:2', 'pipeline')
  assert.equal(after.tryAcquire(3, 'third'), false)
  db.exec("UPDATE history_huasheng_export_jobs SET status='completed' WHERE id=1")
  assert.equal(after.tryAcquire(3, 'third'), true)
  assert.equal(after.overview().activeProjects, 2)
})

test('three real processes obey the shared project limit and a crashed producer cannot strand a slot', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'production-process-'))
  const filename = path.join(root, 'db.sqlite')
  const db = new Database(filename)
  const gate = new HistoryProductionGate(db)
  const script = `
    import Database from 'better-sqlite3';
    import { HistoryProductionGate } from ${JSON.stringify(new URL('./history-production-gate.ts', import.meta.url).href)};
    const db = new Database(process.argv[1], { timeout: 5000 });
    const gate = new HistoryProductionGate(db, { pollMs: 10 });
    const id = Number(process.argv[2]);
    process.stdin.resume();
    await gate.run(id, 'process:' + id, async () => {
      console.log('started:' + id);
      await new Promise(resolve => process.stdin.once('data', resolve));
    });
    db.close(); process.exit(0);
  `
  const children: ReturnType<typeof spawn>[] = []
  const output = new Map<number, string>()
  const errors: string[] = []
  const waitFor = async (check: () => boolean) => {
    const until = Date.now() + 5000
    while (!check()) {
      if (Date.now() > until) throw new Error(`Timed out: ${errors.join(';')}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  t.after(async () => {
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', () => resolve()); child.kill('SIGKILL')
    })))
    db.close(); rmSync(root, { recursive: true, force: true })
  })
  for (const id of [1, 2, 3]) {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, filename, String(id)], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    child.stdout!.on('data', chunk => output.set(id, (output.get(id) || '') + String(chunk)))
    child.stderr!.on('data', chunk => errors.push(String(chunk)))
    if (id < 3) await waitFor(() => !!output.get(id)?.includes(`started:${id}`))
  }
  await waitFor(() => gate.overview().waitingProjects === 1)
  assert.equal(gate.overview().activeProjects, 2)
  assert.equal(output.has(3), false, 'The third process must not start actual production')
  children[0]!.kill('SIGKILL')
  await waitFor(() => !!output.get(3)?.includes('started:3'))
  assert.equal(gate.overview().activeProjects, 2)
  assert.equal(gate.isActive(1), false)
})
