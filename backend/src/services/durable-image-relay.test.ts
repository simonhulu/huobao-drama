import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createDurableImageRelayCheckpoint, readDurableImageRelayCheckpoint, recoverDurableImageRelay,
  isDurableImageRelayConfig, downloadDurableImageRelayResult, DURABLE_IMAGE_RELAY_ORIGIN, type DurableRelayImage } from './durable-image-relay.js'

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-image-relay-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const config = { provider: 'gpt-image2', baseUrl: DURABLE_IMAGE_RELAY_ORIGIN,
    apiKey: 'fake-relay-secret', model: 'gpt-image-2', settings: '{"quality":"high"}' }
  const record: DurableRelayImage = { id: 7, provider: config.provider, imageType: 'science_cover_base',
    model: config.model, prompt: 'A portrait photograph of a meerkat', size: '1152x1536', frameType: '3:4',
    referenceImages: null, seed: null, createdAt: new Date().toISOString() }
  const filename = path.join(directory, '7.json')
  const taskId = createDurableImageRelayCheckpoint(filename, record, 99, config)
  const url = `${DURABLE_IMAGE_RELAY_ORIGIN}/assets/${taskId}/${'b'.repeat(64)}.png`
  const completed = () => Response.json({ id: taskId, status: 'completed', data: { url, sha256: 'b'.repeat(64), bytes: 100 } })
  const accepted = () => Response.json({ id: taskId, task_id: taskId, status: 'processing' }, { status: 202 })
  const processing = () => Response.json({ id: taskId, status: 'processing' })
  const missing = () => new Response('', { status: 404 })
  const options = { filename, record, configId: 99, config, deadlineAt: Date.now() + 60_000, pollIntervalMs: 1 }
  return { ...options, options, directory, taskId, url, completed, accepted, processing, missing }
}

test('lost 202 recovers the original deterministic task without another upstream submission', async t => {
  const f = fixture(t), calls: string[] = []
  let reserved = false
  const fetch = (async (_url, init) => {
    calls.push(init!.method!)
    if (init!.method === 'GET') return reserved ? f.completed() : f.missing()
    reserved = true
    throw new TypeError('fetch failed after relay reservation')
  }) as typeof globalThis.fetch
  assert.equal(await recoverDurableImageRelay({ ...f.options, fetch }), f.url)
  assert.deepEqual(calls, ['GET', 'POST', 'GET'])
  const checkpoint = readDurableImageRelayCheckpoint(f.filename, f.record, f.configId, f.config)
  assert.equal(checkpoint.admitted, true)
  const authHash = createHash('sha256').update(`Bearer ${f.config.apiKey}`).digest('hex')
  assert.equal(checkpoint.authHash, authHash)
  assert.equal(fs.readFileSync(f.filename, 'utf8').includes(f.config.apiKey), false)
  assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600)
})

test('admission retry is bounded and preserves exact auth and body when no task was accepted', async t => {
  const f = fixture(t), posts: Array<{ authorization: unknown; body: unknown }> = []
  let reserved = false
  const fetch = (async (_url, init) => {
    if (init!.method === 'GET') return reserved ? f.completed() : f.missing()
    posts.push({ authorization: (init!.headers as Record<string, string>).Authorization, body: init!.body })
    if (posts.length === 1) throw new TypeError('fetch failed before reaching relay')
    reserved = true
    return f.accepted()
  }) as typeof globalThis.fetch
  assert.equal(await recoverDurableImageRelay({ ...f.options, fetch }), f.url)
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[0], posts[1])
})

test('a persisted acknowledged task resumes after a connection failure using GET only', async t => {
  const f = fixture(t), calls: string[] = []
  let accepted = false
  const firstFetch = (async (_url, init) => {
    calls.push(init!.method!)
    if (init!.method === 'POST') { accepted = true; return f.accepted() }
    if (accepted) throw new TypeError('fetch failed while polling')
    return f.missing()
  }) as typeof globalThis.fetch
  await assert.rejects(recoverDurableImageRelay({ ...f.options, fetch: firstFetch }), { code: 'image_relay_pending', retryable: true })
  assert.equal(readDurableImageRelayCheckpoint(f.filename, f.record, f.configId, f.config).admitted, true)
  assert.equal(await recoverDurableImageRelay({ ...f.options, fetch: (async (_url, init) => {
    calls.push(init!.method!); return f.completed()
  }) as typeof globalThis.fetch }), f.url)
  assert.deepEqual(calls, ['GET', 'POST', 'GET', 'GET'])
})

test('expired generation recovers a cached completed result through one GET without extending its deadline', async t => {
  const f = fixture(t), calls: string[] = []
  assert.equal(await recoverDurableImageRelay({ ...f.options, deadlineAt: Date.now() - 60_000,
    fetch: (async (_url, init) => { calls.push(init!.method!); return f.completed() }) as typeof globalThis.fetch }), f.url)
  assert.deepEqual(calls, ['GET'])
})

for (const status of ['processing', 'missing', 'uncertain', 'rejected'] as const) {
  test(`expired ${status} task performs one GET and never dispatches another generation`, async t => {
    const f = fixture(t), calls: string[] = []
    const fetch = (async (_url, init) => {
      calls.push(init!.method!)
      return status === 'processing' ? f.processing() : status === 'missing' ? f.missing()
        : Response.json({ id: f.taskId, status: 'failed', outcome: status === 'rejected' ? 'rejected' : 'unknown' })
    }) as typeof globalThis.fetch
    await assert.rejects(recoverDurableImageRelay({ ...f.options, deadlineAt: Date.now() - 1, fetch }), { retryable: false })
    assert.deepEqual(calls, ['GET'])
  })
}

test('acknowledged reservation disappearing never authorizes another POST', async t => {
  const f = fixture(t)
  await recoverDurableImageRelay({ ...f.options, fetch: (async () => f.completed()) as typeof globalThis.fetch })
  const calls: string[] = []
  await assert.rejects(recoverDurableImageRelay({ ...f.options, fetch: (async (_url, init) => {
    calls.push(init!.method!); return f.missing()
  }) as typeof globalThis.fetch }), /Acknowledged.*missing/)
  assert.deepEqual(calls, ['GET'])
})

test('config, authentication and original input changes cannot acquire a new relay identity', async t => {
  const f = fixture(t)
  for (const config of [
    { ...f.config, apiKey: 'changed-key' }, { ...f.config, model: 'another-model' },
    { ...f.config, settings: '{"quality":"low"}' }, { ...f.config, baseUrl: 'http://192.168.0.188:8080' },
  ]) {
    await assert.rejects(recoverDurableImageRelay({ ...f.options, config,
      fetch: (async () => { throw new Error('must not reach network') }) as typeof globalThis.fetch }),
    /checkpoint does not match|explicitly bound/)
  }
  assert.throws(() => readDurableImageRelayCheckpoint(f.filename, { ...f.record, prompt: 'Changed portrait' }, f.configId, f.config), /does not match/)
  assert.throws(() => readDurableImageRelayCheckpoint(f.filename, f.record, 100, f.config), /does not match/)
})

test('a preexisting direct generation cannot gain relay provenance during execute', async t => {
  const f = fixture(t)
  fs.rmSync(f.filename)
  await assert.rejects(recoverDurableImageRelay({ ...f.options, fetch: (async () => {
    throw new Error('must not dispatch')
  }) as typeof globalThis.fetch }), /ENOENT/)
  assert.equal(fs.existsSync(f.filename), false)
})

test('a hanging cached response body is bounded, including after the original generation deadline', async t => {
  const f = fixture(t)
  let calls = 0
  await assert.rejects(recoverDurableImageRelay({ ...f.options, responseTimeoutMs: 10, deadlineAt: Date.now() - 1,
    fetch: (async () => { calls++; return new Response(new ReadableStream({ start() {} })) }) as typeof globalThis.fetch }),
  { code: 'image_relay_pending', retryable: true })
  assert.equal(calls, 1)
})

test('wrong relay task identity and terminal uncertain results stop without redispatch', async t => {
  const f = fixture(t), calls: string[] = []
  await assert.rejects(recoverDurableImageRelay({ ...f.options, fetch: (async (_url, init) => {
    calls.push(init!.method!)
    return init!.method === 'GET' ? f.missing()
      : Response.json({ id: 'c'.repeat(64), task_id: 'c'.repeat(64) }, { status: 202 })
  }) as typeof globalThis.fetch }), { code: 'image_relay_terminal', retryable: false })
  assert.deepEqual(calls, ['GET', 'POST'])
})

test('only the exact loopback relay configuration opts in and birth checkpoint creation is exclusive', t => {
  const f = fixture(t)
  assert.equal(isDurableImageRelayConfig(f.config), true)
  for (const baseUrl of ['https://127.0.0.1:18080', 'http://127.0.0.1:18081', 'http://localhost:18080', 'http://192.168.0.188:8080']) {
    assert.equal(isDurableImageRelayConfig({ ...f.config, baseUrl }), false)
  }
  assert.throws(() => createDurableImageRelayCheckpoint(f.filename, f.record, f.configId, f.config), /EEXIST/)
})

test('cached image download is direct, bounded and verifies its content hash without sending credentials', async () => {
  const bytes = Buffer.from('cached-image-fixture'), sha = createHash('sha256').update(bytes).digest('hex')
  const url = `${DURABLE_IMAGE_RELAY_ORIGIN}/assets/${'a'.repeat(64)}/${sha}.png`
  const image = await downloadDurableImageRelayResult(url, { fetch: (async (_url, init) => {
    assert.equal(init!.method, 'GET')
    assert.equal(init!.headers, undefined)
    assert.equal(init!.redirect, 'error')
    return new Response(bytes)
  }) as typeof globalThis.fetch })
  assert.deepEqual(image, { data: bytes.toString('base64'), mimeType: 'image/png' })
  await assert.rejects(downloadDurableImageRelayResult(url, { fetch: (async () => new Response('corrupted')) as typeof globalThis.fetch }),
    /integrity check failed/)
  await assert.rejects(downloadDurableImageRelayResult(url, { responseTimeoutMs: 10,
    fetch: (async () => new Response(new ReadableStream({ start() {} }))) as typeof globalThis.fetch }),
  { code: 'image_relay_pending', retryable: true })
})
