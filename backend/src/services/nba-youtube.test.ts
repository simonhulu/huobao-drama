import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createNbaYoutubeTransport, NbaYoutubeFailure, type NbaYoutubeTransportOptions } from './nba-youtube.js'

const url = 'https://www.youtube.com/watch?v=ZJgGy7TWM9U'
const bot = () => Object.assign(new Error("Sign in to confirm you're not a bot"), { stderr: "ERROR: [youtube] ZJgGy7TWM9U: Sign in to confirm you're not a bot" })
const result = () => ({ stdout: Buffer.from('{"id":"ZJgGy7TWM9U"}'), stderr: '' })
async function fixture(t: TestContext, overrides: Partial<NbaYoutubeTransportOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-youtube-'))
  const controller = new AbortController(), progress: string[] = []
  const options = { directory, signal: controller.signal, run: async () => result(), networkArgs: () => ['--proxy', 'http://127.0.0.1:7897'],
    onProgress: (message: string) => { progress.push(message) }, ...overrides }
  const transport = await createNbaYoutubeTransport(options)
  t.after(async () => { await transport.close(); await fs.rm(directory, { recursive: true, force: true }) })
  return { directory, controller, progress, transport, options }
}
const command = (signal: AbortSignal) => ({ signal, timeout: 1000 })

test('metadata-only format tolerance never leaks into an actual media download', async t => {
  const calls: string[][] = []
  const f = await fixture(t, { run: async (_binary, args) => { calls.push(args); return result() } })
  await f.transport.run(['--dump-single-json', '--skip-download', '--', url], command(f.controller.signal))
  await f.transport.run(['--write-info-json', '-o', path.join(f.directory, 'source.%(ext)s'), '--', url], command(f.controller.signal))
  assert.ok(calls[0]!.includes('--ignore-no-formats-error'))
  assert.equal(calls[1]!.includes('--ignore-no-formats-error'), false)
  assert.ok(calls.every(args => args.includes('--continue') && args[args.indexOf('--proxy') + 1] === 'http://127.0.0.1:7897'))
})

test('an invalid session refreshes once and repeats the original bound operation with a fresh private snapshot', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-youtube-session-')), cookie = path.join(root, 'cookies.txt')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(cookie, 'old-fixture-session', { mode: 0o600 })
  let runs = 0, refreshes = 0
  const snapshots: string[] = []
  const f = await fixture(t, { networkArgs: () => ['--proxy', 'http://127.0.0.1:7897', '--cookies', cookie],
    run: async (_binary, args) => {
      runs++; assert.equal(args.at(-1), url)
      const snapshot = args[args.indexOf('--cookies') + 1]!; snapshots.push(snapshot)
      assert.notEqual(snapshot, cookie)
      assert.equal((await fs.stat(snapshot)).mode & 0o777, 0o600)
      const value = await fs.readFile(snapshot, 'utf8')
      if (runs === 1) { assert.equal(value, 'old-fixture-session'); throw bot() }
      assert.equal(value, 'new-fixture-session'); return result()
    },
    refreshSession: async (source, signal) => { signal.throwIfAborted(); assert.equal(source, url); refreshes++; await fs.writeFile(cookie, 'new-fixture-session') },
  })
  await f.transport.run(['--write-info-json', '--', url], command(f.controller.signal))
  assert.equal(runs, 2); assert.equal(refreshes, 1)
  assert.notEqual(snapshots[0], snapshots[1])
  assert.equal(await fs.access(snapshots[0]!).then(() => true, () => false), false)
  await f.transport.close()
  assert.equal(await fs.access(snapshots[1]!).then(() => true, () => false), false)
})

test('a rejected refreshed session is actionable and cannot run an infinite authentication retry loop', async t => {
  let runs = 0, refreshes = 0
  const f = await fixture(t, { run: async () => { runs++; throw bot() }, refreshSession: async () => { refreshes++ } })
  await assert.rejects(f.transport.run(['--', url], command(f.controller.signal)), error => error instanceof NbaYoutubeFailure && !error.retryable
    && error.recoveryCode === 'youtube_login_required' && /Chrome/.test(error.message) && !/Sign in|--cookies/.test(error.message))
  assert.equal(runs, 2); assert.equal(refreshes, 1)
})

test('a failed browser export stops before a second write and does not expose credential-bearing provider errors', async t => {
  let runs = 0
  const f = await fixture(t, { run: async () => { runs++; throw bot() }, refreshSession: async () => { throw Error('Cookie: private-value https://user:pass@example.test/?token=private') } })
  await assert.rejects(f.transport.run(['--', url], command(f.controller.signal)), error => error instanceof NbaYoutubeFailure
    && !error.retryable && !/private|user:pass/.test(error.message))
  assert.equal(runs, 1)
})

test('a missing Chrome cookie database can retry a public request while retaining the configured proxy', async t => {
  let runs = 0
  const f = await fixture(t, { networkArgs: () => ['--proxy', 'http://127.0.0.1:7897', '--cookies-from-browser', 'chrome'],
    run: async (_binary, args) => {
      runs++; assert.equal(args[args.indexOf('--proxy') + 1], 'http://127.0.0.1:7897')
      if (runs === 1) throw Error('could not find chrome cookies database')
      assert.equal(args.includes('--cookies-from-browser'), false); return result()
    }, refreshSession: async () => { throw Error('A public request must not refresh a session') },
  })
  await f.transport.run(['--', url], command(f.controller.signal))
  assert.equal(runs, 2)
})

test('only transient network errors are marked for orchestrator retry', async t => {
  for (const detail of ['ECONNRESET while downloading', 'HTTP Error 503: Service Unavailable', 'SSL UNEXPECTED_EOF_WHILE_READING; fragment 121 not found']) {
    const network = await fixture(t, { run: async () => { throw Error(detail) }, refreshSession: async () => { throw Error('Must not refresh') } })
    await assert.rejects(network.transport.run(['--', url], command(network.controller.signal)), error => error instanceof NbaYoutubeFailure && error.retryable && error.recoveryCode === 'youtube_network')
  }
  const unavailable = await fixture(t, { run: async () => { throw Error('Requested format is not available') } })
  await assert.rejects(unavailable.transport.run(['--', url], command(unavailable.controller.signal)), error => error instanceof NbaYoutubeFailure && !error.retryable)
})

test('rotated browser cookies refresh even when the provider omits the not-a-bot message', async t => {
  let refreshed = false
  const f = await fixture(t, { run: async () => { if (!refreshed) throw Error('The provided YouTube account cookies are no longer valid. They have likely been rotated in the browser.'); return result() },
    refreshSession: async () => { refreshed = true } })
  await f.transport.run(['--', url], command(f.controller.signal))
  assert.equal(refreshed, true)
})

test('a process timeout remains retryable when yt-dlp already emitted warnings', async t => {
  const f = await fixture(t, { run: async () => { throw Object.assign(new Error('yt-dlp 超时，已保留完成的检查点'), { stderr: 'WARNING: No title found in player responses' }) } })
  await assert.rejects(f.transport.run(['--', url], command(f.controller.signal)), error => error instanceof NbaYoutubeFailure
    && error.retryable && error.recoveryCode === 'youtube_network')
})

test('a permanent HTTP denial is not a transient download error', async t => {
  for (const status of [403, 404]) {
    const f = await fixture(t, { run: async () => { throw Error(`ERROR: unable to download video data: HTTP Error ${status}: Denied`) } })
    await assert.rejects(f.transport.run(['--', url], command(f.controller.signal)), error => error instanceof NbaYoutubeFailure && !error.retryable)
  }
})

test('a network interruption while validating a refreshed session remains retryable', async t => {
  let runs = 0, refreshes = 0
  const f = await fixture(t, { run: async () => { runs++; throw bot() }, refreshSession: async () => { refreshes++; throw Error('ECONNRESET validating refreshed session') } })
  await assert.rejects(f.transport.run(['--', url], command(f.controller.signal)), error => error instanceof NbaYoutubeFailure
    && error.retryable && error.recoveryCode === 'youtube_network')
  assert.equal(runs, 1); assert.equal(refreshes, 1)
})

test('cancellation during refresh prevents another command and preserves the original cancellation reason', async t => {
  const controller = new AbortController(), reason = new DOMException('Stopped by user', 'AbortError'); let runs = 0
  const f = await fixture(t, { signal: controller.signal, run: async () => { runs++; throw bot() }, refreshSession: async () => { controller.abort(reason) } })
  await assert.rejects(f.transport.run(['--', url], command(controller.signal)), error => error === reason)
  assert.equal(runs, 1)
})
