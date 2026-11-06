import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { prepareNbaBodyImage, type NbaBodyInspection, type NbaBodyPhotoInput, type NbaBodyPhotoOptions } from './nba-cover-body-image.js'

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const region = { x: .4, y: .45, width: .1, height: .08, label: 'small jersey sponsor' }
const execute = promisify(execFile)

async function opencvPython() {
  const candidates = [...new Set([process.env.NBA_COVER_PYTHON, process.env.NBA_AUDIO_PYTHON,
    '/tmp/vDdPLHaKK4k-audio-env/bin/python', 'python3'].filter((value): value is string => Boolean(value)))]
  for (const python of candidates) {
    try { await execute(python, ['-c', 'import cv2, numpy'], { timeout: 10000, maxBuffer: 1024 }); return python }
    catch { /* Try the next existing Python environment. */ }
  }
}

function accepted(): NbaBodyInspection {
  return { teamMatches: true, confidence: 'high', framing: 'upper-body', torsoAndArmsVisible: true,
    visibleTeam: 'Los Angeles Lakers', reason: 'Current Lakers jersey, both arms and torso visible.',
    crop: { x: .1, y: .05, width: .8, height: .85 }, commercialRegions: [] }
}

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-body-image-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const width = 320, height = 480, pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4
    pixels[index] = 35 + x % 90; pixels[index + 1] = 60 + y % 100; pixels[index + 2] = 150 + (x + y) % 80
    pixels[index + 3] = x < 20 || x >= width - 20 || y < 12 || y >= height - 12 ? 0 : x < 24 ? 128 : 255
    if (x >= region.x * width && x < (region.x + region.width) * width && y >= region.y * height && y < (region.y + region.height) * height) {
      pixels[index] = pixels[index + 1] = pixels[index + 2] = (x + y) % 4 < 2 ? 255 : 0
    }
  }
  const filename = path.join(directory, 'source.png')
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(filename)
  const input: NbaBodyPhotoInput = { filename, playerName: 'Luka Doncic', teamName: 'Los Angeles Lakers', teamAbbreviation: 'LAL', signal: new AbortController().signal }
  const decision = accepted(), calls = { inspect: 0, clean: 0 }
  const options: NbaBodyPhotoOptions = { repairMarks: true, inspect: async () => { calls.inspect++; return structuredClone(decision) } }
  return { directory, input, decision, calls, options, pixels, width, height }
}

test('old-team jerseys, headshots and uncertain body photographs are rejected and cached', async t => {
  for (const [label, patch] of [
    ['old-team jersey', { teamMatches: false, visibleTeam: 'Milwaukee Bucks' }],
    ['headshot', { framing: 'headshot' as const }],
    ['torso hidden', { torsoAndArmsVisible: false }],
    ['uncertain jersey', { confidence: 'low' as const }],
  ] as const) await t.test(label, async sub => {
    const f = await fixture(sub); Object.assign(f.decision, patch)
    f.options.clean = async () => { f.calls.clean++ }
    assert.equal(await prepareNbaBodyImage(f.input, f.options), null)
    assert.equal(await prepareNbaBodyImage(f.input, f.options), null)
    assert.deepEqual(f.calls, { inspect: 1, clean: 0 })
  })
})

test('accepted body photos retain their native pixels and a body-sized crop', async t => {
  const f = await fixture(t), source = await fs.readFile(f.input.filename)
  const result = await prepareNbaBodyImage(f.input, f.options)
  assert.ok(result)
  assert.deepEqual([result.width, result.height], [f.width, f.height])
  assert.deepEqual(result.crop, f.decision.crop)
  assert.deepEqual(await fs.readFile(result.path), source)
  assert.equal(result.sha256, hash(source))
  assert.deepEqual(await sharp(result.path).raw().toBuffer(), f.pixels)
  assert.equal(result.verification.realPhoto, true)
  assert.equal(result.verification.posePreserved, true)
  assert.equal(result.verification.untouchedPixelsVerified, true)
})

test('prior inspection policy decisions cannot override the current upper-body policy', async t => {
  const f = await fixture(t)
  const sourceSha256 = hash(await fs.readFile(f.input.filename))
  const oldHash = hash(JSON.stringify(['nba-body-photo-cleanup-v2', 'gpt-6.1-terra', sourceSha256,
    f.input.playerName, f.input.teamName, f.input.teamAbbreviation, 'repair-marks']))
  await fs.writeFile(path.join(f.directory, `body-${oldHash.slice(0, 20)}.json`), JSON.stringify({
    method: 'nba-body-photo-cleanup-v2', inputHash: oldHash, accepted: false,
    inspection: { ...f.decision, torsoAndArmsVisible: false, reason: 'Abdomen and elbows are outside the photograph.' },
  }))
  f.decision.crop = null
  f.decision.reason = 'Both shoulders, upper arms and chest jersey are visible.'
  const result = await prepareNbaBodyImage(f.input, f.options)
  assert.ok(result)
  assert.equal(f.calls.inspect, 1)
  assert.equal(result.crop, undefined)
  assert.equal(result.verification.inspectionRevision, 2)
})

test('default action covers preserve natural player photos without repairing small brands', async t => {
  const f = await fixture(t); delete f.options.repairMarks
  f.decision.commercialRegions = [region]
  f.options.clean = async () => { throw new Error('Default covers must not repaint the player') }
  const result = await prepareNbaBodyImage(f.input, f.options)
  assert.ok(result)
  assert.deepEqual(await fs.readFile(result.path), await fs.readFile(f.input.filename))
  assert.equal(result.verification.cleanedRegions, 0)
})

test('face-only crop proposals keep the complete original body image', async t => {
  const f = await fixture(t); f.decision.crop = { x: .2, y: .1, width: .2, height: .2 }
  const result = await prepareNbaBodyImage(f.input, f.options)
  assert.ok(result)
  assert.equal(result.crop, undefined)
  assert.deepEqual([result.width, result.height], [f.width, f.height])
  assert.deepEqual(await sharp(result.path).raw().toBuffer(), f.pixels)
})

test('cleanup rejects changed alpha, off-region pixels and changed image dimensions', async t => {
  for (const violation of ['alpha', 'off-region', 'dimensions', 'missing-alpha'] as const) await t.test(violation, async sub => {
    const f = await fixture(sub); f.decision.commercialRegions = [region]
    f.options.clean = async ({ output }) => {
      f.calls.clean++
      const changed = Buffer.from(f.pixels)
      if (violation === 'alpha') changed[(240 * f.width + 140) * 4 + 3] = 0
      if (violation === 'off-region') changed[(100 * f.width + 80) * 4] ^= 255
      let image = sharp(changed, { raw: { width: f.width, height: f.height, channels: 4 } })
      if (violation === 'dimensions') image = image.resize(300, 480)
      if (violation === 'missing-alpha') image = image.removeAlpha()
      await image.png().toFile(output)
    }
    await assert.rejects(prepareNbaBodyImage(f.input, f.options), violation === 'alpha' ? /人物轮廓/ : violation === 'off-region' ? /区域之外/ : /尺寸或透明通道/)
    assert.equal(f.calls.clean, 1)
    assert.deepEqual((await fs.readdir(f.directory)).filter(name => /\.pending\.png$/.test(name)), [])
  })
})

test('real OpenCV cleanup preserves all alpha and every pixel outside its explicit repair mask', { timeout: 60000 }, async t => {
  const python = await opencvPython()
  if (!python) { t.skip('No Python environment with cv2 and numpy is available'); return }
  const f = await fixture(t); f.decision.commercialRegions = [region]
  const previousPython = process.env.NBA_COVER_PYTHON
  process.env.NBA_COVER_PYTHON = python
  t.after(() => { if (previousPython === undefined) delete process.env.NBA_COVER_PYTHON; else process.env.NBA_COVER_PYTHON = previousPython })
  const result = await prepareNbaBodyImage(f.input, f.options)
  assert.ok(result)
  const after = await sharp(result.path).raw().toBuffer(), metadata = await sharp(result.path).metadata()
  assert.deepEqual([metadata.width, metadata.height, metadata.hasAlpha], [f.width, f.height, true])
  const left = Math.floor(region.x * f.width) - 2, right = Math.ceil((region.x + region.width) * f.width) + 2
  const top = Math.floor(region.y * f.height) - 2, bottom = Math.ceil((region.y + region.height) * f.height) + 2
  let changed = 0
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const index = (y * f.width + x) * 4
    assert.equal(after[index + 3], f.pixels[index + 3], `alpha at ${x},${y}`)
    const inMask = x >= left && x < right && y >= top && y < bottom && f.pixels[index + 3] >= 250
    if (!inMask) assert.deepEqual(after.subarray(index, index + 4), f.pixels.subarray(index, index + 4), `outside mask at ${x},${y}`)
    else if (!after.subarray(index, index + 3).equals(f.pixels.subarray(index, index + 3))) changed++
  }
  assert.ok(changed > 0, 'the branding region must actually be repaired')
  assert.equal(result.verification.cleanedRegions, 1)
  assert.deepEqual(result.crop, f.decision.crop)
  assert.deepEqual(await sharp(f.input.filename).raw().toBuffer(), f.pixels)
})

test('nearby dark collars and white sleeves cannot contaminate a yellow sponsor repair', { timeout: 60000 }, async t => {
  const python = await opencvPython()
  if (!python) { t.skip('No Python environment with cv2 and numpy is available'); return }
  const f = await fixture(t), pixels = Buffer.from(f.pixels)
  const left = Math.floor(region.x * f.width), right = Math.ceil((region.x + region.width) * f.width)
  const top = Math.floor(region.y * f.height), bottom = Math.ceil((region.y + region.height) * f.height)
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const i = (y * f.width + x) * 4
    pixels[i] = 244; pixels[i + 1] = 211; pixels[i + 2] = 35
    if (x >= left - 2 && x < right + 2 && y >= top - 6 && y < top - 2) { pixels[i] = 15; pixels[i + 1] = 12; pixels[i + 2] = 30 }
    if (x >= right + 2 && x < right + 7 && y >= top - 2 && y < bottom + 2) { pixels[i] = 240; pixels[i + 1] = 240; pixels[i + 2] = 240 }
    if (x >= left && x < right && y >= top && y < bottom) { pixels[i] = 25; pixels[i + 1] = 20; pixels[i + 2] = 30 }
  }
  await sharp(pixels, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toFile(f.input.filename)
  f.decision.commercialRegions = [region]
  const previousPython = process.env.NBA_COVER_PYTHON; process.env.NBA_COVER_PYTHON = python
  t.after(() => { if (previousPython === undefined) delete process.env.NBA_COVER_PYTHON; else process.env.NBA_COVER_PYTHON = previousPython })
  const result = await prepareNbaBodyImage(f.input, f.options)
  assert.ok(result)
  const after = await sharp(result.path).raw().toBuffer()
  let matching = 0, count = 0
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = (y * f.width + x) * 4; count++
    if (after[i] > 200 && after[i + 1] > 170 && after[i + 2] < 80) matching++
  }
  assert.ok(matching / count > .98, 'the repaired sponsor must retain yellow fabric without gray or white wedges')
})

test('coarse logo boxes preserve connected pants and skin inside the box while removing isolated lettering', { timeout: 60000 }, async t => {
  const python = await opencvPython()
  if (!python) { t.skip('No Python environment with cv2 and numpy is available'); return }
  const f = await fixture(t), pixels = Buffer.from(f.pixels)
  const left = Math.floor(region.x * f.width), right = Math.ceil((region.x + region.width) * f.width)
  const top = Math.floor(region.y * f.height), bottom = Math.ceil((region.y + region.height) * f.height)
  const protectedPixels: number[] = [], lettering: number[] = []
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const i = (y * f.width + x) * 4
    pixels[i] = 195; pixels[i + 1] = 108; pixels[i + 2] = 45
    const pants = x >= left - 12 && x <= left + 4 && y >= top + 8 && y < bottom + 12
    const skin = x >= right - 5 && x < right + 12 && y >= top - 12 && y <= top + 5
    if (pants) { pixels[i] = 16; pixels[i + 1] = 17; pixels[i + 2] = 22 }
    if (skin) { pixels[i] = 212; pixels[i + 1] = 169; pixels[i + 2] = 143 }
    if ((pants || skin) && x >= left && x < right && y >= top && y < bottom) protectedPixels.push(i)
    if (x >= left + 12 && x < right - 10 && y >= top + 12 && y < bottom - 10) {
      pixels[i] = 18; pixels[i + 1] = 19; pixels[i + 2] = 23; lettering.push(i)
    }
  }
  await sharp(pixels, { raw: { width: f.width, height: f.height, channels: 4 } }).png().toFile(f.input.filename)
  f.decision.commercialRegions = [region]
  const previousPython = process.env.NBA_COVER_PYTHON; process.env.NBA_COVER_PYTHON = python
  t.after(() => { if (previousPython === undefined) delete process.env.NBA_COVER_PYTHON; else process.env.NBA_COVER_PYTHON = previousPython })
  const result = await prepareNbaBodyImage(f.input, f.options)
  assert.ok(result)
  const after = await sharp(result.path).raw().toBuffer()
  assert.ok(protectedPixels.length > 100)
  for (const i of protectedPixels) assert.deepEqual(after.subarray(i, i + 4), pixels.subarray(i, i + 4), 'non-target surfaces must remain byte-identical even inside a coarse logo box')
  assert.ok(lettering.length > 0)
  assert.ok(lettering.filter(i => after[i] > 150 && after[i + 1] > 75).length / lettering.length > .98, 'isolated lettering must still be repaired')
})

test('verified cache avoids repeated inspection and recovers damaged output or checkpoint', async t => {
  const f = await fixture(t), first = await prepareNbaBodyImage(f.input, f.options)
  assert.ok(first)
  assert.deepEqual(await prepareNbaBodyImage(f.input, f.options), first)
  assert.equal(f.calls.inspect, 1)
  await fs.writeFile(first.path, 'damaged cleaned png')
  assert.deepEqual(await prepareNbaBodyImage(f.input, f.options), first)
  assert.equal(f.calls.inspect, 1, 'valid saved visual decisions can repair lost image output')
  assert.deepEqual(await sharp(first.path).raw().toBuffer(), f.pixels)
  await fs.writeFile(first.path.replace(/\.png$/, '.json'), 'invalid checkpoint')
  assert.deepEqual(await prepareNbaBodyImage(f.input, f.options), first)
  assert.equal(f.calls.inspect, 2)
})

test('old cleanup revisions reuse the accepted visual inspection but rerun local cleanup', async t => {
  const f = await fixture(t); f.decision.commercialRegions = [region]
  f.options.clean = async ({ source, output }) => { f.calls.clean++; await fs.copyFile(source, output) }
  const first = await prepareNbaBodyImage(f.input, f.options)
  assert.ok(first)
  const checkpointPath = first.path.replace(/\.png$/, '.json')
  for (const revision of [undefined, -1]) {
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'))
    if (revision === undefined) delete checkpoint.cleanupRevision
    else checkpoint.cleanupRevision = revision
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint))
    assert.deepEqual(await prepareNbaBodyImage(f.input, f.options), first)
    assert.equal(f.calls.inspect, 1)
  }
  assert.equal(f.calls.clean, 3)
})

test('cancellation before inspection and after cleanup never commits a usable body image', async t => {
  await t.test('before inspection', async sub => {
    const f = await fixture(sub), controller = new AbortController(); controller.abort()
    await assert.rejects(prepareNbaBodyImage({ ...f.input, signal: controller.signal }, f.options), { name: 'AbortError' })
    assert.equal(f.calls.inspect, 0)
  })
  await t.test('after cleanup', async sub => {
    const f = await fixture(sub), controller = new AbortController(); f.decision.commercialRegions = [region]
    f.options.clean = async ({ source, output }) => { await fs.copyFile(source, output); controller.abort() }
    await assert.rejects(prepareNbaBodyImage({ ...f.input, signal: controller.signal }, f.options), { name: 'AbortError' })
    assert.deepEqual((await fs.readdir(f.directory)).filter(name => /^body-.*\.png$/.test(name)), [])
  })
})

test('oversized individual or total repair regions are rejected before cleanup', async t => {
  for (const [label, regions] of [
    ['individual', [{ ...region, width: .3, height: .2 }]],
    ['total', Array.from({ length: 5 }, () => ({ ...region, width: .2, height: .18 }))],
  ] as const) await t.test(label, async sub => {
    const f = await fixture(sub); f.decision.commercialRegions = [...regions]
    f.options.clean = async () => { f.calls.clean++ }
    await assert.rejects(prepareNbaBodyImage(f.input, f.options), /修补区域过大/)
    assert.equal(f.calls.clean, 0)
  })
})
