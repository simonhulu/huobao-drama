import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const exec = promisify(execFile)
const root = mkdtempSync(join(tmpdir(), 'video-frame-cover-'))
const { selectVideoCoverFrame } = await import('./video-frame-cover.js')

after(() => rmSync(root, { recursive: true, force: true }))

test('selects a clear real interior frame and retains native 720p pixels', async () => {
  const video = join(root, 'source.mp4')
  const output = join(root, 'cover')
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=10:duration=2', '-vf', "gblur=sigma=16:enable='lt(t,1)'", '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-n', video])

  const filename = await selectVideoCoverFrame(video, output)
  const metadata = await sharp(filename).metadata()
  assert.equal(metadata.width, 1280)
  assert.equal(metadata.height, 720)
  assert.deepEqual([...readFileSync(filename).subarray(0, 4)], [137, 80, 78, 71])
  const baseline = join(root, 'blurred.png')
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', '0.4', '-i', video, '-frames:v', '1', '-n', baseline])
  assert.ok((await sharp(filename).stats()).sharpness > (await sharp(baseline).stats()).sharpness * 2)
})

test('rejects a file without a usable video stream', async () => {
  await assert.rejects(selectVideoCoverFrame(join(root, 'missing.mp4'), join(root, 'missing-cover')), /视频|读取|不存在/)
})

test('rejects blank footage and small footage rather than fabricating a sharp cover', async () => {
  for (const [name, input] of [['black', 'color=black:size=1280x720:duration=1'], ['white', 'color=white:size=1280x720:duration=1'], ['small', 'testsrc2=size=320x240:duration=1']] as const) {
    const video = join(root, `${name}.mp4`)
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', input, '-c:v', 'libx264', '-preset', 'ultrafast', '-n', video])
    await assert.rejects(selectVideoCoverFrame(video, join(root, `cover-${name}`)), /清晰|分辨率|画面/)
  }
})

test('accepts a clear portrait video without forcing landscape dimensions', async () => {
  const video = join(root, 'portrait.mp4')
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=5:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-n', video])
  const filename = await selectVideoCoverFrame(video, join(root, 'portrait-cover'))
  const metadata = await sharp(filename).metadata()
  assert.deepEqual([metadata.width, metadata.height], [720, 1280])
})
