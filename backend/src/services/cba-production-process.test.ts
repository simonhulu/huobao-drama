import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { CbaVideoService } from './cba-video.js'
import { runCbaProductionPipeline } from './cba-production-pipeline.js'

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-model-process-'))
  const stateFile = path.join(root, '.console.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, settings: { autoUpload: false, targets: [] }, uploads: [], runs: [
    { id: 'original-run', status: 'running', ownerPid: process.pid, jobIds: [], logs: [] },
  ] }))
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; exitCode: number | null }> = []
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null as number | null })
    children.push(child)
    return child as unknown as childProcess.ChildProcess
  })
  syncBuiltinESMExports()
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }) })
  const service = new CbaVideoService({ root, autoRecover: false })
  const logs: string[] = []
  function launch() {
    // Exercise the real launcher/parser; spawn is mocked, so no Codex request runs.
    const process = (service as any).launch('offline fixture', (message: string) => logs.push(message), { phase: 'audit' })
    const completion: Promise<void> = (service as any).ownedProcess('original-run', process)
    const child = children.at(-1)!
    return { completion, emit: (event: unknown, newline = true) => child.stdout.write(JSON.stringify(event) + (newline ? '\n' : '')),
      stderr: (message: string) => child.stderr.write(message), close: (code: number) => { child.exitCode = code; child.emit('close', code) } }
  }
  function command(name = 'tts') {
    const completion: Promise<void> = (service as any).command('original-run', [name, '--job', root])
    const child = children.at(-1)!
    return { completion, stdout: (message: string) => child.stdout.write(message), stderr: (message: string) => child.stderr.write(message),
      close: (code: number) => { child.exitCode = code; child.emit('close', code) } }
  }
  return { root, launch, command, logs, children, state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    stop: () => { const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); state.runs[0].status = 'stopping'; fs.writeFileSync(stateFile, JSON.stringify(state)) } }
}

test('a failed CLI command retains its final stderr error despite a large request body and later stdout', async t => {
  const f = fixture(t), process = f.command()
  process.stdout('request debug body: ' + 'unneeded payload '.repeat(1200) + '\n')
  process.stderr('\u001b[31mError: Narration n1 failed: the TTS response did not contain audio\u001b[0m\n    at synthesize (/Users/test/private/source.ts:10:2)\n')
  process.stdout('request debug body: ' + 'later payload '.repeat(1200) + '\n')
  process.close(1)
  await assert.rejects(process.completion, error => {
    assert.match(String(error), /tts.*失败.*TTS response did not contain audio/)
    assert.doesNotMatch(String(error), /payload|request debug|\u001b|private\/source|当前生产步骤退出/)
    return true
  })
  const saved = f.state().runs[0]
  assert.match(saved.logs.at(-1), /TTS response did not contain audio/)
  assert.equal(saved.modelFailure, undefined)
  assert.equal(saved.modelAttempts, undefined)
  assert.equal(f.children.length, 1)
})

test('CLI diagnostics redact text and JSON credentials, bearer tokens and credentialed URLs before saving', async t => {
  const f = fixture(t), process = f.command('render')
  process.stderr('Error: render failed; token=private-text; {"api_key":"private-json", "access_token":"private-access", "secret":"private secret with spaces", "authorization":"Bearer private-bearer"}; https://user:private-password@provider.test/api?key=private-query#private-fragment; terminal reason: missing font\n')
  process.close(1)
  await assert.rejects(process.completion, error => {
    assert.match(String(error), /terminal reason: missing font/)
    assert.doesNotMatch(String(error), /private|Bearer|user:/)
    return true
  })
  assert.doesNotMatch(JSON.stringify(f.state().runs[0].logs), /private|Bearer|user:/)
})

test('CLI and model diagnostics redact complete Basic and Bearer authorization payloads', async t => {
  for (const channel of ['cli', 'model']) for (const scheme of ['Basic', 'Bearer']) await t.test(`${channel}: ${scheme}`, async sub => {
    const f = fixture(sub), payload = 'cHJp+dmF0ZS/vPQ=='
    const reason = `Error: provider request failed; Authorization: ${scheme} ${payload}; terminal reason: provider rejected request`
    const process = channel === 'cli' ? f.command('render') : f.launch()
    process.stderr(reason + '\n'); process.close(1)
    await assert.rejects(process.completion, error => {
      assert.match(String(error), /provider rejected request/)
      assert.doesNotMatch(String(error), /cHJp|dmF0ZS|vPQ|Basic|Bearer/)
      return true
    })
    assert.doesNotMatch(JSON.stringify(f.state().runs[0].logs), /cHJp|dmF0ZS|vPQ|Basic|Bearer/)
  })
})

test('a CLI JSON error exposes the error message without echoing the request body', async t => {
  const f = fixture(t), process = f.command('acquire-media')
  process.stdout(JSON.stringify({ error: { code: 'BAD_MEDIA', message: 'The downloaded file is incomplete' }, request: { token: 'private-json-token', body: 'unneeded-request-body' } }) + '\n')
  process.close(1)
  await assert.rejects(process.completion, error => {
    assert.match(String(error), /downloaded file is incomplete/)
    assert.doesNotMatch(String(error), /private|unneeded-request-body/)
    return true
  })
  assert.equal(f.state().runs[0].modelFailure, undefined)
})

test('CLI cancellation stays stopped even if stderr contains a provider quota error', async t => {
  const f = fixture(t), process = f.command()
  process.stderr('Error: MiniMax 2056: 已达到 Token Plan 用量上限\n')
  f.stop(); process.close(143)
  await assert.rejects(process.completion, /生产已停止/)
  assert.equal(f.state().runs[0].modelFailure, undefined)
  assert.equal(f.state().runs[0].logs.length, 0)
})

test('owned audit failures preserve the latest terminal model reason in Chinese', async t => {
  const f = fixture(t), process = f.launch()
  process.emit({ type: 'error', message: 'Reconnecting: Concurrency limit exceeded' })
  process.emit({ type: 'turn.failed', error: { message: 'Upstream service temporarily unavailable; authorization=private-token https://user:private@provider.test/responses?key=private' } }, false)
  process.close(1)
  await assert.rejects(process.completion, error => {
    assert.match(String(error), /模型上游服务暂时不可用/)
    assert.doesNotMatch(String(error), /并发|private|provider\.test|退出（1）/)
    return true
  })
})

test('concurrency rejection is identified from the current process stderr', async t => {
  const process = fixture(t).launch()
  process.stderr('ERROR: unexpected status 429: Concurrency limit exceeded; token=secret-value\n')
  process.close(1)
  await assert.rejects(process.completion, error => {
    assert.match(String(error), /模型服务并发已达上限/)
    assert.doesNotMatch(String(error), /secret-value/)
    return true
  })
})

test('a provider stream disconnect remains a specific transient model failure', async t => {
  const process = fixture(t).launch()
  process.emit({ type: 'turn.failed', error: { message: 'stream disconnected before completion: error sending request; token=private-stream' } })
  process.close(1)
  await assert.rejects(process.completion, error => {
    assert.match(String(error), /模型连接暂时中断/)
    assert.doesNotMatch(String(error), /private-stream/)
    return true
  })
})

test('a permanent quota error with HTTP 429 is not reported as a transient rate limit', async t => {
  const process = fixture(t).launch()
  process.emit({ type: 'turn.failed', error: { message: 'HTTP 429 insufficient_quota: check billing plan' } })
  process.close(1)
  await assert.rejects(process.completion, error => {
    assert.match(String(error), /模型服务额度不足/)
    assert.doesNotMatch(String(error), /请求频率受限/)
    return true
  })
})

test('successful reconnects and later subprocesses do not inherit old model errors', async t => {
  const f = fixture(t), first = f.launch()
  first.emit({ type: 'error', message: 'Concurrency limit exceeded; reconnecting 1/5' })
  first.emit({ type: 'turn.completed', usage: {} }); first.close(0)
  await first.completion
  const second = f.launch(); second.close(1)
  await assert.rejects(second.completion, error => {
    assert.match(String(error), /当前生产步骤退出（1）/)
    assert.doesNotMatch(String(error), /并发|Concurrency/)
    return true
  })
})

test('cancellation stays a stopped outcome instead of a retryable model error', async t => {
  const f = fixture(t), process = f.launch()
  process.emit({ type: 'error', message: 'Upstream service temporarily unavailable' })
  f.stop(); process.close(143)
  await assert.rejects(process.completion, error => {
    assert.match(String(error), /生产已停止/)
    assert.doesNotMatch(String(error), /暂时不可用|并发|稍后/)
    return true
  })
  assert.equal(f.children.length, 1)
})

test('an unclassified current error remains informative without exposing secrets', async t => {
  const process = fixture(t).launch()
  process.emit({ type: 'turn.failed', error: { message: 'Unsupported model variant; token=private-value; "api_key":"private-json"; Bearer private-access; https://user:password@provider.test/api?secret=private-query' } })
  process.close(1)
  await assert.rejects(process.completion, error => {
    assert.match(String(error), /模型执行失败.*Unsupported model variant/)
    assert.doesNotMatch(String(error), /private-value|private-json|private-access|password|private-query/)
    return true
  })
})

test('the pipeline persists the actual model failure in production.message before any paid step', async t => {
  const f = fixture(t), media = path.join(f.root, 'source.mp4')
  fs.writeFileSync(media, 'fixture')
  fs.writeFileSync(path.join(f.root, 'job.json'), JSON.stringify({ media: [{ path: media }] }))
  const commands: string[] = []
  const result = await runCbaProductionPipeline(f.root, 'original-run', {
    command: async args => { commands.push(args[0]!) },
    edit: async () => { assert.fail('complete editing does not need another producer') },
    review: async () => {
      const process = f.launch()
      process.emit({ type: 'turn.failed', error: { message: 'Concurrency limit exceeded' } }); process.close(1)
      await process.completion
      assert.fail('a failed reviewer cannot return a passing audit')
    },
    verifyDelivery: async () => ({ stage: 'rendering', message: 'pending' }), stopped: () => false, progress: () => {},
    gates: {
      editorialDigest: () => 'edit-one', validateJob: () => ({ errors: [] }),
      prepareEditorialAudit: async () => ({ digest: 'edit-one', packetPath: path.join(f.root, 'packet.json'), packetSha256: 'packet', imagePaths: [] }),
      validateEditorialAudit: () => ({ valid: false, errors: ['review required'] }),
    },
  })
  assert.equal(result.ready, false)
  assert.match(result.message, /模型服务并发已达上限/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'production.json'), 'utf8')).message, result.message)
  assert.equal(commands.includes('tts'), false)
  assert.equal(f.children.length, 1, 'the coordinator does not add another model request')
})
