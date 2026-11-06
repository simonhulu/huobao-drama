import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import sharp from 'sharp'
import { execFileAsync, fingerprint, loadPackage, packageIdentity, parseScriptReference, sha256, validatePackaging, verifyVideo, withPackageLock, writeJson } from './lib.mjs'
import { preparePackage } from './prepare.mjs'
import { findOrSubmit, generationKey, prepareBackgrounds } from './backgrounds.mjs'
import { finalizePackage } from './finalize.mjs'

const packaging = () => ({ title: '完整既有发布标题', opening_hook: '古人吃饭就能放心吗？',
  cover_design: { main_title: '古代餐桌骗局', sub_title: '历史趣谈', kicker: '历史趣谈' },
  platforms: { baijiahao: { description: '没有现代添加剂，就一定能放心吗？' }, wechat: { title: '古代餐桌骗局', description: '没有现代添加剂，就一定能放心吗？' } } })

test('history identity accepts stable links and IDs, never episode links or ambiguous IDs', () => {
  assert.equal(parseScriptReference('http://localhost:3013/history-scripts?script=37').id, 37)
  assert.equal(parseScriptReference('37').url, 'http://localhost:3013/history-scripts?script=37')
  assert.equal(parseScriptReference('/history-scripts?script=9').id, 9)
  for (const value of ['0', '-1', '1.2', '/drama/1/episode/37', '/history-scripts?script=1&script=2',
    'https://example.com/history-scripts?script=1', '/history-scripts?script=01', '9007199254740992']) {
    assert.throws(() => parseScriptReference(value))
  }
})

test('packaging rejects over-limit fields without truncation', () => {
  const input = packaging()
  assert.equal(validatePackaging(input), input)
  assert.equal(input.title, '完整既有发布标题')
  input.platforms.wechat.description = '字'.repeat(201)
  assert.equal(validatePackaging(input), input)
  assert.equal(input.platforms.wechat.description, '字'.repeat(201))
  input.platforms.baijiahao.description = '字'.repeat(51)
  assert.throws(() => validatePackaging(input), /short version/)
  input.platforms.baijiahao.description = '可用'
  input.platforms.wechat.title = '字'.repeat(17)
  assert.throws(() => validatePackaging(input), /1-16/)
  input.platforms.wechat.title = '短标题'
  input.cover_design.main_title = '太短'
  assert.throws(() => validatePackaging(input), /6-8/)
})

test('package and paid-task identities isolate script/video/design/model/ratio', () => {
  const original = packageIdentity(1, 'script', 'video', 'copy')
  assert.notEqual(original, packageIdentity(2, 'script', 'video', 'copy'))
  assert.notEqual(original, packageIdentity(1, 'script2', 'video', 'copy'))
  assert.notEqual(original, packageIdentity(1, 'script', 'video2', 'copy'))
  assert.notEqual(original, packageIdentity(1, 'script', 'video', 'copy2'))
  const key = generationKey(original, 'prompt', '16:9', 95, 'model')
  for (const args of [['other', 'prompt', '16:9', 95, 'model'], [original, 'new prompt', '16:9', 95, 'model'],
    [original, 'prompt', '3:4', 95, 'model'], [original, 'prompt', '16:9', 94, 'model'], [original, 'prompt', '16:9', 95, 'new model']]) {
    assert.notEqual(key, generationKey(...args))
  }
})

test('lost response recovers completed or failed generations without another paid submission', async () => {
  for (const status of ['completed', 'processing', 'failed']) {
    const calls = []
    const result = await findOrSubmit({ origin: 'http://localhost:3013', key: 'unique', prompt: 'p', ratio: '16:9', configId: 95, model: 'm',
      request: async (_origin, route, options) => { calls.push({ route, options }); return route.startsWith('/tasks')
        ? [{ id: 99, payload: { image_generation_id: 42 } }] : [{ id: 42, frameType: 'unique', status }] } })
    assert.equal(result.generation_id, 42)
    assert.equal(result.recovered, true)
    assert.equal(calls.length, status === 'processing' ? 2 : 1)
    if (status === 'processing') assert.equal(result.task_id, 99)
    assert.equal(calls[0].options, undefined)
  }
  const calls = []
  await findOrSubmit({ origin: 'http://localhost:3013', key: 'new', prompt: 'p', ratio: '3:4', configId: 95, model: 'm',
    request: async (_origin, route, options) => {
      calls.push({ route, options })
      if (route === '/images/capabilities') return { single_image_submission: true }
      return options ? { id: 7, task_id: 9 } : []
    } })
  assert.equal(calls.length, 3)
  assert.equal(calls[1].route, '/images/capabilities')
  assert.equal(JSON.parse(calls[2].options.body).frame_type, 'new')
  assert.equal(JSON.parse(calls[2].options.body).single_image_submission, true)
})

test('new paid image tasks fail closed against an older API without single-submission support', async () => {
  for (const capabilities of [null, {}, { single_image_submission: false }, { single_image_submission: 'true' }]) {
    const calls = []
    await assert.rejects(findOrSubmit({ origin: 'http://localhost:3013', key: 'new', prompt: 'p',
      ratio: '3:4', configId: 95, model: 'm', request: async (_origin, route, options) => {
        calls.push({ route, options })
        return route === '/images/capabilities' ? capabilities : []
      } }), /load the current backend/)
    assert.deepEqual(calls.map(call => call.route), ['/images', '/images/capabilities'])
    assert.ok(calls.every(call => !call.options))
  }
})

test('local package integration freezes provenance, covers and upload session; source edits create a new package', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-publish-test-'))
  let server
  try {
    const video = path.join(root, 'external.mp4')
    await execFileAsync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
    const source = { id: 37, title: '来源标题', rewrittenScript: '实际用于制作的原稿。', revision: 'revision1', artifactState: { rewritten: 'current' }, reviewJson: '{"factCheckStatus":"needs_sources"}' }
    server = http.createServer((req, res) => {
      assert.equal(req.url, '/api/v1/history-scripts/37')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 200, data: source }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const script = `http://127.0.0.1:${server.address().port}/history-scripts?script=37`
    const copyFile = path.join(root, 'packaging.json')
    writeJson(copyFile, packaging())
    const options = { script, video, packagingPath: copyFile, outputRoot: path.join(root, 'packages') }
    const result = await preparePackage(options)
    assert.equal((await preparePackage(options)).reused, true)
    const frozen = loadPackage(result.directory)
    assert.equal(frozen.state.history_source_id, 37)
    assert.equal(fs.readFileSync(path.join(result.directory, 'production-script.txt'), 'utf8'), source.rewrittenScript)
    const snapshot = JSON.parse(fs.readFileSync(path.join(result.directory, 'source-snapshot.json')))
    assert.equal(JSON.parse(snapshot.source.reviewJson).factCheckStatus, 'needs_sources')
    writeJson(path.join(result.directory, 'video-reference.json'), { ...frozen.video, sha256: sha256('another video') })
    assert.throws(() => loadPackage(result.directory), /package identity/)
    writeJson(path.join(result.directory, 'video-reference.json'), frozen.video)
    await assert.rejects(withPackageLock(result.directory, () => withPackageLock(result.directory, async () => {})), /locked/)
    const landscape = path.join(root, 'landscape.png'), portrait = path.join(root, 'portrait.png')
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#204c44' } }).png().toFile(landscape)
    await sharp({ create: { width: 300, height: 400, channels: 3, background: '#462b21' } }).png().toFile(portrait)
    await prepareBackgrounds({ directory: result.directory, landscape, portrait })
    await assert.rejects(prepareBackgrounds({ directory: result.directory, configId: 95, model: 'gpt-image-2-1k' }), /3:4-capable/)
    const final = await finalizePackage(result.directory)
    const firstManifest = JSON.parse(fs.readFileSync(final.manifests.baijiahao))
    assert.equal(firstManifest.source_type, 'history_script')
    assert.equal(firstManifest.episode_id, undefined)
    assert.equal(firstManifest.work_description, packaging().platforms.baijiahao.description)
    assert.equal(firstManifest.cover_fingerprint, await fingerprint(final.covers.landscape_16x9.path))
    const wechat = JSON.parse(fs.readFileSync(final.manifests.wechat))
    assert.equal(wechat.video_sha256, await fingerprint(video))
    assert.equal(wechat.title, packaging().platforms.wechat.title)
    writeJson(`${final.manifests.baijiahao}.staged.json`, { saved: true })
    const again = await finalizePackage(result.directory)
    assert.equal(again.reused, true)
    assert.equal(JSON.parse(fs.readFileSync(final.manifests.baijiahao)).session, firstManifest.session)
    assert.deepEqual(JSON.parse(fs.readFileSync(`${final.manifests.baijiahao}.staged.json`)), { saved: true })
    writeJson(final.manifests.baijiahao, { ...firstManifest, work_description: '不是确认的文案' })
    await assert.rejects(finalizePackage(result.directory), /manifest fingerprint changed/)
    writeJson(final.manifests.baijiahao, firstManifest)
    const finalState = loadPackage(result.directory).state
    const interrupted = { ...finalState }
    delete interrupted.covers
    writeJson(path.join(result.directory, 'state.json'), interrupted)
    const coverBefore = await fingerprint(final.covers.landscape_16x9.path)
    await assert.rejects(finalizePackage(result.directory), /Existing manifest\/upload state/)
    assert.equal(await fingerprint(final.covers.landscape_16x9.path), coverBefore)
    writeJson(path.join(result.directory, 'state.json'), finalState)
    source.rewrittenScript = '制作之后修改的新版原稿。'
    source.revision = 'revision2'
    const changed = await preparePackage(options)
    assert.notEqual(changed.directory, result.directory)
    assert.equal(loadPackage(result.directory).state.script_sha256, sha256('实际用于制作的原稿。'))
    source.artifactState.rewritten = 'stale'
    await assert.rejects(preparePackage(options), /stale/)
    const productionFile = path.join(root, 'production.txt')
    fs.writeFileSync(productionFile, '实际用于制作的原稿。')
    assert.equal((await preparePackage({ ...options, scriptFile: productionFile })).directory, result.directory)
    source.artifactState.rewritten = 'current'
    source.mediaJson = JSON.stringify({ videoSha256: await fingerprint(video) })
    await assert.rejects(preparePackage(options), /source video/)
    const coverBytes = fs.readFileSync(final.covers.landscape_16x9.path)
    fs.appendFileSync(final.covers.landscape_16x9.path, 'changed')
    await assert.rejects(finalizePackage(result.directory), /Frozen cover fingerprint changed/)
    fs.writeFileSync(final.covers.landscape_16x9.path, coverBytes)
    fs.appendFileSync(video, 'changed')
    await assert.rejects(verifyVideo(frozen.video), /Video fingerprint changed/)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
