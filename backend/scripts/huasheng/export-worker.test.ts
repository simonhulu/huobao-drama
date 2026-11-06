import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { runExportWorker, type ExportWorkerServices, type ExportWorkerStatus } from './export-worker.js'

const workerUrl = new URL('./export-worker.ts', import.meta.url).href
const backend = fileURLToPath(new URL('../..', import.meta.url))

function fixture() {
  const controller = new AbortController()
  const events: string[] = []
  const statuses: ExportWorkerStatus[] = []
  const services: ExportWorkerServices = {
    exports: { start() { events.push('exports.start') }, stop() { events.push('exports.stop') }, close() { events.push('exports.close') } },
    articles: { start() { events.push('articles.start') }, stop() { events.push('articles.stop') }, close() { events.push('articles.close') } },
  }
  const run = () => runExportWorker({ signal: controller.signal, loadServices: async () => services, writeStatus: status => statuses.push(status) })
  return { controller, events, statuses, services, run }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the isolated worker fixture')
    await delay(5)
  }
}

test('standalone startup runs both services and shutdown awaits both before closing', async () => {
  const f = fixture()
  let finishExportStop!: () => void
  f.services.exports.stop = async () => {
    f.events.push('exports.stop')
    await new Promise<void>(resolve => { finishExportStop = resolve })
  }
  const running = f.run()
  await until(() => f.statuses.some(status => status.status === 'started'))
  assert.deepEqual(f.events, ['articles.start', 'exports.start'])
  f.controller.abort()
  await until(() => f.events.includes('articles.stop'))
  assert.equal(f.events.some(event => event.endsWith('.close')), false)
  finishExportStop()
  assert.equal(await running, 0)
  assert.deepEqual(f.events, ['articles.start', 'exports.start', 'exports.stop', 'articles.stop', 'exports.close', 'articles.close'])
  assert.deepEqual(f.statuses.map(status => status.status), ['started', 'stopping', 'stopped'])
})

test('startup and shutdown errors still release both services without logging exception secrets', async () => {
  for (const phase of ['startup', 'shutdown']) {
    const f = fixture()
    const secret = 'https://cdn.example/video.mp4?token=private Cookie=secret'
    if (phase === 'startup') f.services.exports.start = () => { throw new Error(secret) }
    else {
      f.services.exports.stop = () => { f.events.push('exports.stop'); throw new Error(secret) }
      f.services.exports.close = () => { f.events.push('exports.close'); throw new Error(secret) }
    }
    const running = f.run()
    if (phase === 'shutdown') {
      await until(() => f.statuses.some(status => status.status === 'started'))
      f.controller.abort()
    }
    assert.equal(await running, 1)
    for (const event of ['exports.stop', 'articles.stop', 'exports.close', 'articles.close']) assert.ok(f.events.includes(event), event)
    assert.ok(f.statuses.some(status => status.status === 'failed' && status.phase === phase))
    assert.doesNotMatch(JSON.stringify(f.statuses), /cdn|token|private|Cookie|secret/)
  }
})

test('a pre-aborted run does not construct or start services', async () => {
  const controller = new AbortController()
  controller.abort()
  const code = await runExportWorker({ signal: controller.signal, loadServices: async () => { throw new Error('must not load') } })
  assert.equal(code, 0)
})

test('shutdown requested while services load or start never launches the next service', async () => {
  for (const stage of ['load', 'article']) {
    const f = fixture()
    let finish!: () => void
    let entered = false
    const wait = () => new Promise<void>(resolve => { entered = true; finish = resolve })
    if (stage === 'article') f.services.articles.start = async () => { f.events.push('articles.start'); await wait() }
    const running = runExportWorker({
      signal: f.controller.signal, writeStatus: status => f.statuses.push(status),
      loadServices: async () => { if (stage === 'load') await wait(); return f.services },
    })
    await until(() => entered)
    f.controller.abort()
    finish()
    assert.equal(await running, 0)
    assert.equal(f.events.includes('exports.start'), false)
    assert.ok(f.events.includes('articles.stop'))
    assert.ok(f.events.includes('exports.stop'))
  }
})

test('service construction failures exit cleanly with status-only diagnostics', async () => {
  const statuses: ExportWorkerStatus[] = []
  const code = await runExportWorker({ signal: new AbortController().signal,
    loadServices: async () => { throw new Error('https://provider.invalid/?api_key=private') },
    writeStatus: status => statuses.push(status),
  })
  assert.equal(code, 1)
  assert.deepEqual(statuses.map(status => [status.status, status.phase]), [['failed', 'startup']])
  assert.doesNotMatch(JSON.stringify(statuses), /https|api_key|private/)
})

test('module import and CLI help never touch the database or load production services', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'huasheng-export-entry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const args of [
    ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(workerUrl)}); console.log('imported')`],
    ['run-tsx.mjs', 'scripts/huasheng/export-worker.ts', '--help'],
    ['run-tsx.mjs', 'scripts/huasheng/export-worker.ts', 'invalid'],
  ]) {
    const child = spawn(process.execPath, args, { cwd: backend,
      env: { ...process.env, TASK_WORKER_DISABLED: '1', DB_PATH: path.join(directory, 'must-not-create.db') }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', bytes => { output += String(bytes) })
    child.stderr.on('data', bytes => { output += String(bytes) })
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    assert.equal(code, args.at(-1) === 'invalid' ? 1 : 0)
    assert.match(output, args.includes('-e') ? /imported/ : /Usage:/)
    assert.deepEqual(await readdir(directory), [])
  }
})

test('the CLI survives idle unref timers and handles SIGINT and SIGTERM with disabled global workers', async t => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), 'huasheng-export-signal-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const code = `
      import { loadExportWorkerServices, exportWorkerMain } from ${JSON.stringify(workerUrl)};
      const services = await loadExportWorkerServices();
      for (const worker of [services.exports, services.articles]) {
        worker.runPending = async () => {};
        const originalStop = worker.stop.bind(worker);
        worker.stop = async () => { console.log(JSON.stringify({ fixture: 'stop' })); await originalStop(); };
      }
      process.exitCode = await exportWorkerMain(['serve']);
    `
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: backend, env: { ...process.env, DB_PATH: path.join(directory, 'isolated.db'),
        TASK_WORKER_DISABLED: '1', HISTORY_ARTICLE_WORKER_DISABLED: '1', HISTORY_HUASHENG_EXPORT_WORKER_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let stderr = ''
    let exited = false
    child.stdout.on('data', bytes => { output += String(bytes) })
    child.stderr.on('data', bytes => { stderr += String(bytes) })
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) })
    })
    try {
      await until(() => output.includes('"status":"started"') || exited)
      assert.equal(exited, false, stderr || output)
      await delay(100)
      assert.equal(exited, false, 'idle services must stay alive even though both timers are unrefed')
      assert.ok(child.kill(signal))
      await until(() => exited)
      assert.deepEqual(await exit, { code: 0, signal: null })
      assert.match(output, /"status":"stopping"/)
      assert.match(output, /"status":"stopped"/)
      assert.ok(output.split('\n').filter(line => line.includes('"fixture":"stop"')).length >= 2)
      assert.equal(stderr, '')
      assert.doesNotMatch(output, /https?:\/\/|_ra|csrf|Cookie|SESSDATA|download_url/)
    } finally {
      if (!exited) { child.kill('SIGKILL'); await exit }
    }
  }
})
