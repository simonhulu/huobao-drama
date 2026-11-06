import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { prepareNbaCover } from './nba-cover.js'

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-cover-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const pixels = Buffer.alloc(1920 * 1080 * 3)
  for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
    const value = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? 205 : 45
    pixels.fill(value, (y * 1920 + x) * 3, (y * 1920 + x) * 3 + 3)
  }
  const clear = await sharp(pixels, { raw: { width: 1920, height: 1080, channels: 3 } }).png().toBuffer()
  const blurred = await sharp(clear).blur(12).png().toBuffer()
  const filename = path.join(directory, 'cover.png')
  const source = { id: 'abcdefghijk', path: path.join(directory, 'source.mp4'), sha256: 'a'.repeat(64), width: 1920, height: 1080 }
  await fs.writeFile(source.path, 'source fixture')
  return { filename, source, clear, blurred, signal: new AbortController().signal, sourceStart: 10, sourceEnd: 30 }
}

test('cover chooses a clear frame from the original video at native dimensions without JPEG or scaling', async t => {
  const f = await fixture(t), commands: string[][] = []
  const cover = await prepareNbaCover({ ...f, run: async (command, args) => {
    assert.equal(command, 'ffmpeg'); commands.push(args)
    assert.equal(args[args.indexOf('-i') + 1], f.source.path)
    assert.equal(args.includes('-vf'), false)
    assert.equal(args.at(-1), 'pipe:1')
    return { stdout: commands.length === 8 ? f.clear : f.blurred, stderr: '' }
  } })
  const image = await sharp(cover.path).metadata()
  assert.equal(image.width, 1920); assert.equal(image.height, 1080); assert.equal(image.format, 'png')
  assert.equal(commands.length, 8)
  assert.equal(cover.evidence.sourceSha256, f.source.sha256)
  assert.equal(cover.evidence.timeSeconds, cover.evidence.candidates.at(-1)!.timeSeconds)
  assert.ok(cover.evidence.timeSeconds > 10 && cover.evidence.timeSeconds < 30)
  assert.equal(cover.evidence.method, 'source-frame-sharpness-v1')
  assert.equal(cover.evidence.candidates.length, 8)
  assert.equal(cover.evidence.sha256.length, 64)
  const cached = await prepareNbaCover({ ...f, run: async () => { throw Error('Valid cover must be reused') } })
  assert.deepEqual(cached, cover)
})

test('a corrupt cover is regenerated, and a changed source cannot reuse old cover evidence', async t => {
  const f = await fixture(t); let calls = 0
  const run = async () => { calls++; return { stdout: f.clear, stderr: '' } }
  await prepareNbaCover({ ...f, run })
  await fs.writeFile(f.filename, f.blurred)
  await prepareNbaCover({ ...f, run })
  assert.equal(calls, 16)
  const changed = await prepareNbaCover({ ...f, source: { ...f.source, sha256: 'b'.repeat(64) }, run })
  assert.equal(calls, 24)
  assert.equal(changed.evidence.sourceSha256, 'b'.repeat(64))
})

test('cover extraction rejects a lower resolution frame rather than enlarging it', async t => {
  const f = await fixture(t), small = await sharp(f.clear).resize(640, 360).png().toBuffer()
  await assert.rejects(prepareNbaCover({ ...f, run: async () => ({ stdout: small, stderr: '' }) }), /原生尺寸/)
  await assert.rejects(fs.stat(f.filename), { code: 'ENOENT' })
})
