import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { buildNbaTopicTitleSvg, prepareNbaTopicCover } from './nba-topic-cover.js'

test('topic cover uses native clear video pixels and a full-width title panel, with reusable landscape and portrait outputs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-topic-cover-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const width = 1920, height = 1080, pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3, value = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 ? 210 : 40
    pixels[offset] = value; pixels[offset + 1] = 120; pixels[offset + 2] = 60
  }
  const frame = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer()
  let commands = 0
  const input = { videoPath: '/fixture.mp4', sourceSha256: 'a'.repeat(64), sourceVideoId: 'vDdPLHaKK4k', headline: '球星畅谈训练与新赛季目标', directory,
    signal: new AbortController().signal, run: async (command: string) => {
      commands++
      return { stdout: command === 'ffprobe' ? Buffer.from(JSON.stringify({ format: { duration: '50' }, streams: [{ codec_type: 'video', width, height }] })) : frame, stderr: '' }
    } }
  const cover = await prepareNbaTopicCover(input)
  assert.equal(cover.evidence.method, 'sports-topic-frame-title-v1')
  assert.equal(cover.evidence.sourceWidth, 1920)
  assert.equal(cover.evidence.sourceHeight, 1080)
  const landscape = await sharp(cover.path).metadata(), portrait = await sharp(cover.portraitPath).metadata()
  assert.equal(landscape.width, 1920); assert.equal(landscape.height, 1080)
  assert.equal(portrait.width, 1080); assert.equal(portrait.height, 1440)
  const { data, info } = await sharp(cover.path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  for (const x of [5, width - 6]) {
    const offset = (5 * info.width + x) * info.channels
    assert.ok(data[offset] < 55, 'the full top band covers both broadcast corners')
  }
  assert.equal((await prepareNbaTopicCover(input)).evidence.inputHash, cover.evidence.inputHash)
  assert.equal(commands, 9, 'a cached cover does not re-probe or extract the video again')
})

test('topic title escapes source text and fits long titles into the top panel', () => {
  const svg = buildNbaTopicTitleSvg('训练 <script>alert(1)</script> & 新赛季'.repeat(3), 1080, 1440).toString()
  assert.equal(svg.includes('<script>'), false)
  assert.ok(svg.includes('&lt;script&gt;'))
  assert.ok(svg.includes('fill-opacity=".94"'))
})
