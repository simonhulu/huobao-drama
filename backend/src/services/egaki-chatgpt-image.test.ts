import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-egaki-image-'))
process.env.DB_PATH = path.join(dbDir, 'test.db')
process.env.STORAGE_PATH = path.join(dbDir, 'static')

const {
  buildEgakiChildEnv,
  cancelEgakiChatGptImageJob,
  getEgakiChatGptImageJob,
  mapSizeToEgakiAspectRatio,
  materializeEgakiReferenceImages,
  runEgakiChatGptImage,
  submitEgakiChatGptImageJob,
  waitForEgakiChatGptImageJob,
} = await import('./egaki-chatgpt-image.js')

const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test('mapSizeToEgakiAspectRatio chooses nearest supported ChatGPT ratio without crop', () => {
  assert.equal(mapSizeToEgakiAspectRatio('1920x1080'), '3:2')
  assert.equal(mapSizeToEgakiAspectRatio('1080x1920'), '2:3')
  assert.equal(mapSizeToEgakiAspectRatio('1024x1024'), '1:1')
  assert.equal(mapSizeToEgakiAspectRatio('4:3'), '3:2')
  assert.equal(mapSizeToEgakiAspectRatio('3:4'), '2:3')
})

test('buildEgakiChildEnv forces ChatGPT OAuth path and preserves proxy env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-egaki-bootstrap-'))
  const bootstrap = path.join(dir, 'proxy-bootstrap.mjs')
  fs.writeFileSync(bootstrap, '')
  const env = buildEgakiChildEnv({
    OPENAI_API_KEY: 'sk-should-not-leak',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    NODE_OPTIONS: '--trace-warnings',
  }, bootstrap)

  assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false)
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897')
  assert.match(env.NODE_OPTIONS ?? '', /--trace-warnings/)
  assert.match(env.NODE_OPTIONS ?? '', /--import/)
  assert.match(env.NODE_OPTIONS ?? '', /proxy-bootstrap\.mjs/)
})

test('buildEgakiChildEnv injects the proxy bootstrap for lowercase proxy env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-egaki-bootstrap-lowercase-'))
  const bootstrap = path.join(dir, 'proxy-bootstrap.mjs')
  fs.writeFileSync(bootstrap, '')
  const env = buildEgakiChildEnv({
    PATH: process.env.PATH,
    https_proxy: 'http://127.0.0.1:7897',
  }, bootstrap)

  assert.equal(env.https_proxy, 'http://127.0.0.1:7897')
  assert.match(env.NODE_OPTIONS ?? '', /--import/)
  assert.match(env.NODE_OPTIONS ?? '', /proxy-bootstrap\.mjs/)
})

test('materializeEgakiReferenceImages writes data URLs to temp input files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-egaki-refs-'))
  const refs = await materializeEgakiReferenceImages([
    `data:image/png;base64,${png1x1.toString('base64')}`,
  ], dir)

  assert.equal(refs.length, 1)
  assert.equal(path.extname(refs[0]), '.png')
  assert.deepEqual(fs.readFileSync(refs[0]), png1x1)
})

test('runEgakiChatGptImage spawns egaki with refs, omits seed, and saves local image', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-fake-egaki-'))
  const fakeBin = path.join(tmp, 'egaki')
  const capturePath = path.join(tmp, 'capture.json')
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const out = args[args.indexOf('-o') + 1]
fs.writeFileSync(out, Buffer.from('${png1x1.toString('base64')}', 'base64'))
fs.writeFileSync('${capturePath}', JSON.stringify({
  args,
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,
    HTTPS_PROXY: process.env.HTTPS_PROXY || null,
    NODE_OPTIONS: process.env.NODE_OPTIONS || null
  }
}))
`, { mode: 0o755 })

  const localPath = await runEgakiChatGptImage({
    id: 77,
    prompt: 'cinematic frame',
    model: 'gpt-image-2',
    size: '1920x1080',
    seed: 123,
    referenceImages: JSON.stringify([`data:image/png;base64,${png1x1.toString('base64')}`]),
  }, {
    egakiBin: fakeBin,
    env: {
      PATH: process.env.PATH,
      OPENAI_API_KEY: 'sk-should-not-leak',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
    },
    proxyBootstrapPath: path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/egaki-undici-proxy.mjs'),
  })

  assert.match(localPath, /^static\/images\/.+\.png$/)
  assert.deepEqual(fs.readFileSync(path.join(process.env.STORAGE_PATH!, '..', localPath)), png1x1)

  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'))
  assert.deepEqual(capture.args.slice(0, 2), ['image', 'cinematic frame'])
  assert.equal(capture.args.includes('--seed'), false)
  assert.equal(capture.args.includes('123'), false)
  assert.equal(capture.args[capture.args.indexOf('-m') + 1], 'gpt-image-2')
  assert.equal(capture.args[capture.args.indexOf('--aspect-ratio') + 1], '3:2')
  assert.equal(capture.args.filter((arg: string) => arg === '--input').length, 1)
  assert.equal(capture.env.OPENAI_API_KEY, null)
  assert.equal(capture.env.HTTPS_PROXY, 'http://127.0.0.1:7897')
})

test('runEgakiChatGptImage cancels the egaki child process when aborted', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-fake-egaki-cancel-'))
  const fakeBin = path.join(tmp, 'egaki')
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
setTimeout(() => {}, 60000)
`, { mode: 0o755 })

  const controller = new AbortController()
  const promise = runEgakiChatGptImage({
    id: 78,
    prompt: 'cinematic frame',
    model: 'gpt-image-2',
    size: '1:1',
  }, {
    egakiBin: fakeBin,
    env: { PATH: process.env.PATH },
    signal: controller.signal,
    timeoutMs: 60_000,
  })

  setTimeout(() => controller.abort(), 50)

  await assert.rejects(
    () => promise,
    /canceled/,
  )
})

test('egaki local image jobs expose submit, poll, and completed status', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-fake-egaki-job-'))
  const fakeBin = path.join(tmp, 'egaki')
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const out = args[args.indexOf('-o') + 1]
setTimeout(() => {
  fs.writeFileSync(out, Buffer.from('${png1x1.toString('base64')}', 'base64'))
}, 50)
`, { mode: 0o755 })

  const jobId = submitEgakiChatGptImageJob({
    id: 79,
    prompt: 'cinematic frame',
    model: 'gpt-image-2',
    size: '1:1',
  }, {
    egakiBin: fakeBin,
    env: { PATH: process.env.PATH },
    timeoutMs: 60_000,
  })

  assert.match(jobId, /^egaki-local-79-/)
  assert.match(getEgakiChatGptImageJob(jobId)?.status ?? '', /queued|running/)

  const localPath = await waitForEgakiChatGptImageJob(jobId, { pollMs: 10, timeoutMs: 5_000 })
  const job = getEgakiChatGptImageJob(jobId)
  assert.equal(job?.status, 'completed')
  assert.equal(job?.localPath, localPath)
  assert.match(localPath, /^static\/images\/.+\.png$/)
})

test('egaki local image jobs can be canceled while running', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-fake-egaki-job-cancel-'))
  const fakeBin = path.join(tmp, 'egaki')
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
setTimeout(() => {}, 60000)
`, { mode: 0o755 })

  const jobId = submitEgakiChatGptImageJob({
    id: 80,
    prompt: 'cinematic frame',
    model: 'gpt-image-2',
    size: '1:1',
  }, {
    egakiBin: fakeBin,
    env: { PATH: process.env.PATH },
    timeoutMs: 60_000,
  })

  assert.equal(cancelEgakiChatGptImageJob(jobId), true)
  await assert.rejects(
    () => waitForEgakiChatGptImageJob(jobId, { pollMs: 10, timeoutMs: 5_000 }),
    /canceled/,
  )
  assert.equal(getEgakiChatGptImageJob(jobId)?.status, 'canceled')
})
