import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareScienceVideoWithIntro, prepareScienceVideoWithIntroOnly, prepareScienceVideoIntroPreview, resolveScienceVideoIntroSource } from './science-video-intro.js'

const exec = promisify(execFile)
const signal = () => new AbortController().signal
const digest = async (filename: string) => createHash('sha256').update(await fs.readFile(filename)).digest('hex')

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-intro-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const introPath = path.join(root, 'intro.mp4'), videoPath = path.join(root, 'main.mp4'), directory = path.join(root, 'prepared')
  const presenterPath = path.join(root, 'presenter.mp4')
  await clip(introPath, 'red', 440, '640x360', 24, 32000, 2, .6)
  await clip(videoPath, 'blue', 880, '320x180', 15, 44100, 1, 1.2)
  await presenter(presenterPath)
  return { root, introPath, videoPath, directory, presenterPath }
}

async function clip(filename: string, color: string, frequency: number, dimensions: string, fps: number, sampleRate: number, channels: number, duration: number) {
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:s=${dimensions}:r=${fps}:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${sampleRate}:duration=${duration}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', String(channels), '-shortest', filename], { timeout: 30_000 })
}

async function presenter(filename: string, duration = 1.3) {
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=160x160:rate=15:duration=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=2200:sample_rate=48000:duration=${duration}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', filename])
}

async function probe(filename: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename])
  return JSON.parse(stdout)
}

async function pixel(filename: string, timestamp: number, crop?: { x: number; y: number; width: number; height: number }) {
  const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(timestamp), '-i', filename, '-frames:v', '1',
    '-vf', crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=1:1` : 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  return [...stdout.subarray(0, 3)]
}

async function frequency(filename: string, timestamp: number) {
  const sampleRate = 8000
  const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(timestamp), '-i', filename, '-t', '0.25',
    '-vn', '-ar', String(sampleRate), '-ac', '1', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' })
  const samples = Array.from({ length: stdout.length / 4 }, (_, index) => stdout.readFloatLE(index * 4))
  assert.ok(samples.some(value => Math.abs(value) > .02), 'original audio remains audible')
  let crossings = 0
  for (let index = 1; index < samples.length; index++) if (samples[index - 1]! < 0 && samples[index]! >= 0) crossings++
  return crossings * sampleRate / samples.length
}

test('prepends the actual intro before the main, normalizes media formats and preserves both original audio segments', async t => {
  const f = await fixture(t), mainHash = await digest(f.videoPath), introHash = await digest(f.introPath)
  const result = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  assert.notEqual(result.videoPath, f.videoPath)
  assert.equal(result.sourceSha256, mainHash)
  assert.equal(result.introSha256, introHash)
  assert.equal(await digest(f.videoPath), mainHash)
  const metadata = await probe(result.videoPath)
  const video = metadata.streams.find((item: any) => item.codec_type === 'video')
  const audio = metadata.streams.find((item: any) => item.codec_type === 'audio')
  assert.equal(video.codec_name, 'h264')
  assert.deepEqual([video.width, video.height], [320, 180])
  assert.equal(video.avg_frame_rate, '15/1')
  assert.equal(audio.codec_name, 'aac')
  assert.equal(audio.sample_rate, '48000')
  assert.equal(audio.channels, 2)
  assert.ok(Math.abs(Number(metadata.format.duration) - 1.8) < .2)
  const introPixel = await pixel(result.videoPath, .2), mainPixel = await pixel(result.videoPath, 1.3, { x: 80, y: 60, width: 4, height: 4 })
  assert.ok(introPixel[0]! > 200 && introPixel[2]! < 40, `intro appears first: ${introPixel}`)
  assert.ok(mainPixel[2]! > 200 && mainPixel[0]! < 40, `main follows intro: ${mainPixel}`)
  assert.ok(Math.abs(await frequency(result.videoPath, .15) - 440) < 15)
  assert.ok(Math.abs(await frequency(result.videoPath, 1) - 880) < 15)
})

test('reports encoder progress before completion and reports 100 only after validated output is committed', async t => {
  const f = await fixture(t)
  const updates: Array<{ percent: number; processedSeconds: number; totalSeconds: number; speed?: number }> = []
  const messages: string[] = []
  let committedAtCompletion = false
  const result = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath,
    report: message => messages.push(message),
    onProgress: progress => {
      updates.push(progress)
      if (progress.percent === 100) committedAtCompletion = existsSync(path.join(f.directory, 'science-video-intro.json'))
    },
  })
  assert.ok(updates.some(progress => progress.percent < 100), 'the encoder exposes actual output progress before commit')
  assert.equal(updates.at(-1)?.percent, 100)
  assert.ok(committedAtCompletion, '100% requires the validated output and its manifest')
  assert.ok(updates.every(progress => progress.processedSeconds >= 0 && progress.totalSeconds > 0
    && progress.processedSeconds <= progress.totalSeconds && progress.percent >= 0 && progress.percent <= 100))
  assert.ok(Math.abs(updates.at(-1)!.totalSeconds - 1.8) < .1)
  assert.ok(messages.some(message => /合成.*\d+%/.test(message)), 'progress is visible to callers using the existing report callback')
  assert.ok(existsSync(result.videoPath))
})

test('encoder progress handles split records, ignores unavailable values and throttles frequent updates', async t => {
  const f = await fixture(t)
  const realFfmpeg = (await exec('which', ['ffmpeg'])).stdout.trim()
  const bin = path.join(f.root, 'bin')
  await fs.mkdir(bin)
  const wrapper = `#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);
if(args.includes('-progress')){
  process.stdout.write('out_time_us=N/A\\nspeed=N/A\\nprogress=continue\\n');
  process.stdout.write('out_time_');process.stdout.write('us=200000\\nspeed=2.0x\\nprogress=continue\\n');
  for(let i=0;i<200;i++)process.stdout.write('out_time_us='+(300000+i*1000)+'\\nspeed=N/A\\nprogress=continue\\n');
}
const r=cp.spawnSync(${JSON.stringify(realFfmpeg)},args,{stdio:'inherit'});process.exit(r.status??1);\n`
  await fs.writeFile(path.join(bin, 'ffmpeg'), wrapper, { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath })
  const updates: Array<{ percent: number; processedSeconds: number; totalSeconds: number; speed?: number }> = []
  await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath,
    onProgress: progress => updates.push(progress) })
  assert.equal(updates[0]?.processedSeconds, .2)
  assert.equal(updates[0]?.speed, 2)
  assert.ok(updates.length <= 4, 'a burst of encoder records must not create a burst of persisted job updates')
  assert.equal(updates.at(-1)?.percent, 100)
  let clock = 0, liveUpdates = 0
  t.mock.method(Date, 'now', () => { clock += 5_000; return clock })
  const messages: string[] = []
  await prepareScienceVideoWithIntro({ ...f, directory: path.join(f.root, 'slow-progress') }, {
    signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath,
    onProgress: () => liveUpdates++, report: message => messages.push(message),
  })
  assert.ok(liveUpdates > 20, 'the simulated long render still refreshes structured progress')
  assert.ok(messages.filter(message => message.includes('正在合成')).length < liveUpdates / 2,
    'text logs use a separate 30-second budget to preserve earlier job history')
})

test('repeated encoder timestamps do not refresh progress while a restarted render can advance from an earlier timestamp', async t => {
  const f = await fixture(t)
  const realFfmpeg = (await exec('which', ['ffmpeg'])).stdout.trim()
  const bin = path.join(f.root, 'bin')
  await fs.mkdir(bin)
  const wrapper = `#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);
if(args.includes('-progress'))for(const us of [200000,200000,200000,400000,400000,100000,100000,200000,200000]){
  process.stdout.write('out_time_us='+us+'\\nspeed=2.0x\\nprogress=continue\\n');
}
const r=cp.spawnSync(${JSON.stringify(realFfmpeg)},args,{stdio:'inherit'});process.exit(r.status??1);\n`
  await fs.writeFile(path.join(bin, 'ffmpeg'), wrapper, { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath })
  let clock = 0
  t.mock.method(Date, 'now', () => { clock += 5_000; return clock })
  const updates: Array<{ percent: number; processedSeconds: number }> = []
  await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath,
    onProgress: progress => updates.push(progress) })
  const rendering = updates.filter(progress => progress.percent < 100)
  assert.ok(rendering.every((progress, index) => !index || progress.processedSeconds !== rendering[index - 1]!.processedSeconds),
    'repeated stats must not make a stalled render appear to be progressing')
  assert.deepEqual(rendering.slice(0, 4).map(progress => progress.processedSeconds), [.2, .4, .1, .2],
    'encoder fallback and a new copy phase may restart their output timestamps')
  assert.equal(updates.at(-1)?.percent, 100)
})

test('retries reuse content-bound output, including when the prepared output itself becomes the input', async t => {
  const f = await fixture(t)
  const first = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  const before = await fs.stat(first.videoPath)
  const second = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  const third = await prepareScienceVideoWithIntro({ ...f, videoPath: first.videoPath }, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  assert.deepEqual(second, first)
  assert.deepEqual(third, first)
  assert.equal((await fs.stat(first.videoPath)).mtimeMs, before.mtimeMs)
  assert.ok(Math.abs(Number((await probe(third.videoPath)).format.duration) - 1.8) < .2)
})

test('changed input or intro creates a new version and corrupted cached bytes are never accepted', async t => {
  const f = await fixture(t)
  const first = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  await fs.writeFile(first.videoPath, 'interrupted or corrupted output')
  const repaired = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  assert.equal(repaired.sourceSha256, first.sourceSha256)
  assert.ok((await probe(repaired.videoPath)).streams.some((item: any) => item.codec_type === 'audio'))
  await clip(f.introPath, 'yellow', 220, '640x360', 24, 32000, 2, .6)
  const replacedIntro = await prepareScienceVideoWithIntro({ ...f, videoPath: repaired.videoPath }, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  assert.equal(replacedIntro.sourceSha256, first.sourceSha256)
  assert.notEqual(replacedIntro.introSha256, first.introSha256)
  assert.notEqual(replacedIntro.videoPath, repaired.videoPath)
  assert.ok(Math.abs(Number((await probe(replacedIntro.videoPath)).format.duration) - 1.8) < .2)
  await clip(f.videoPath, 'green', 660, '320x180', 15, 44100, 1, 1.2)
  const replacedMain = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  assert.notEqual(replacedMain.sourceSha256, first.sourceSha256)
  assert.notEqual(replacedMain.videoPath, replacedIntro.videoPath)
})

test('cancellation kills an encoder that ignores SIGTERM instead of leaving an orphan process', async t => {
  const f = await fixture(t), controller = new AbortController()
  const realFfmpeg = (await exec('which', ['ffmpeg'])).stdout.trim()
  const bin = path.join(f.root, 'bin'), pidFile = path.join(f.root, 'encoder.pid')
  await fs.mkdir(bin)
  const wrapper = `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');
if(process.argv.includes('-c:v')){process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)}
else{const r=cp.spawnSync(${JSON.stringify(realFfmpeg)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1)}\n`
  await fs.writeFile(path.join(bin, 'ffmpeg'), wrapper, { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`
  let pid = 0
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
  })
  const running = prepareScienceVideoWithIntro(f, { signal: controller.signal, introPath: f.introPath, presenterPath: f.presenterPath })
  const rejected = assert.rejects(running, /abort|cancel/i)
  for (let attempt = 0; attempt < 500; attempt++) {
    try { pid = Number(await fs.readFile(pidFile, 'utf8')); break } catch {}
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(pid > 1, 'the actual compositor reaches its encoder subprocess')
  controller.abort(new Error('cancel unresponsive encoder'))
  await rejected
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('cancelled encoder must not survive its task')
})

test('a force-killed hardware encoder does not restart the entire render in software', async t => {
  const f = await fixture(t)
  const realFfmpeg = (await exec('which', ['ffmpeg'])).stdout.trim()
  const bin = path.join(f.root, 'bin'), attempts = path.join(f.root, 'encoders.txt')
  await fs.mkdir(bin)
  const wrapper = `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');
const args=process.argv.slice(2);const encoder=args[args.indexOf('-c:v')+1];
if(args.includes('-c:v'))fs.appendFileSync(${JSON.stringify(attempts)},encoder+'\\n');
if(encoder==='h264_videotoolbox')process.kill(process.pid,'SIGKILL');
else{const r=cp.spawnSync(${JSON.stringify(realFfmpeg)},args,{stdio:'inherit'});process.exit(r.status??1)}\n`
  await fs.writeFile(path.join(bin, 'ffmpeg'), wrapper, { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath })
  t.mock.method(os, 'platform', () => 'darwin')
  t.mock.method(os, 'arch', () => 'x64')
  await assert.rejects(prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath }),
    (error: any) => error.signal === 'SIGKILL')
  assert.equal(await fs.readFile(attempts, 'utf8'), 'h264_videotoolbox\n')
  assert.deepEqual(await fs.readdir(f.directory), [])
})

test('cancellation keeps original media and leaves no successful manifest or partial output', async t => {
  const f = await fixture(t), controller = new AbortController(), mainHash = await digest(f.videoPath)
  const reason = new Error('cancel intro preparation')
  await assert.rejects(prepareScienceVideoWithIntro(f, { signal: controller.signal, introPath: f.introPath, presenterPath: f.presenterPath,
    report: message => { if (message.includes('拼接')) setTimeout(() => controller.abort(reason), 1) },
  }), /cancel intro preparation|aborted/i)
  assert.equal(await digest(f.videoPath), mainHash)
  assert.deepEqual(await fs.readdir(f.directory), [])
  const retried = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  assert.ok((await probe(retried.videoPath)).streams.some((item: any) => item.codec_type === 'video'))
})

test('environment override supplies the fixed intro without changing a caller supplied main path', async t => {
  const f = await fixture(t)
  const previous = process.env.SCIENCE_INTRO_VIDEO_PATH, previousPresenter = process.env.SCIENCE_PRESENTER_VIDEO_PATH
  process.env.SCIENCE_INTRO_VIDEO_PATH = f.introPath
  process.env.SCIENCE_PRESENTER_VIDEO_PATH = f.presenterPath
  t.after(() => {
    if (previous === undefined) delete process.env.SCIENCE_INTRO_VIDEO_PATH; else process.env.SCIENCE_INTRO_VIDEO_PATH = previous
    if (previousPresenter === undefined) delete process.env.SCIENCE_PRESENTER_VIDEO_PATH; else process.env.SCIENCE_PRESENTER_VIDEO_PATH = previousPresenter
  })
  const result = await prepareScienceVideoWithIntro(f, { signal: signal() })
  assert.equal(result.introSha256, await digest(f.introPath))
  assert.equal(result.sourceSha256, await digest(f.videoPath))
})

test('missing original audio in either segment is rejected before creating a deliverable', async t => {
  for (const segment of ['videoPath', 'introPath'] as const) {
    const f = await fixture(t)
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=green:s=320x180:r=15:d=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-an', f[segment]])
    await assert.rejects(prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath }), /音轨/)
    assert.deepEqual(await fs.readdir(f.directory), [])
  }
})

test('the intro visibly shrinks and travels into the lower-right circle before synchronized narration begins', async t => {
  const f = await fixture(t)
  const result = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  const redBounds = async (timestamp: number) => {
    const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(timestamp), '-i', result.videoPath,
      '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
    let count = 0, sumX = 0, sumY = 0
    for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
      const index = (y * 320 + x) * 3
      if (stdout[index]! > 150 && stdout[index + 1]! < 80 && stdout[index + 2]! < 80) {
        count++; sumX += x; sumY += y
      }
    }
    assert.ok(count > 500, 'the original intro remains visible during its movement')
    return { count, x: sumX / count, y: sumY / count }
  }
  const early = await redBounds(.333), middle = await redBounds(.4), late = await redBounds(.533)
  assert.ok(early.count > middle.count * 1.15 && middle.count > late.count * 1.8,
    `intro continuously shrinks: ${JSON.stringify([early, middle, late])}`)
  assert.ok(middle.x > early.x + 8 && late.x > middle.x + 25 && late.y > middle.y + 10,
    `the same intro travels toward the lower right: ${JSON.stringify([early, middle, late])}`)
  const revealed = await pixel(result.videoPath, .533, { x: 80, y: 60, width: 4, height: 4 })
  assert.ok(revealed[2]! > 200 && revealed[0]! < 40, `the main is revealed behind the moving intro: ${revealed}`)
  const circle = await pixel(result.videoPath, 1.35, { x: 235, y: 119, width: 8, height: 8 })
  assert.ok(circle[0]! + circle[1]! > 70, `presenter is visible in lower right: ${circle}`)
  for (const point of [{ x: 215, y: 99 }, { x: 160, y: 145 }, { x: 290, y: 70 }]) {
    const outside = await pixel(result.videoPath, 1.35, { ...point, width: 2, height: 2 })
    assert.ok(outside[2]! > 200 && outside[0]! < 40, `main remains outside circular window: ${outside}`)
  }
  const crop = 'crop=46:46:216:100'
  const frame = async (timestamp: number) => (await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(timestamp), '-i', result.videoPath,
    '-frames:v', '1', '-vf', crop, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })).stdout
  const first = await frame(1.2), later = await frame(1.6)
  const difference = first.reduce((total, value, index) => total + Math.abs(value - later[index]!), 0) / first.length
  assert.ok(difference > 4, `presenter video retains moving frames throughout the main: ${difference}`)
  assert.ok(Math.abs(await frequency(result.videoPath, .15) - 440) < 15, 'intro audio remains alone')
  assert.ok(Math.abs(await frequency(result.videoPath, 1.25) - 880) < 15, 'main audio remains alone; presenter audio is excluded')
})

test('HD motion stays correctly framed while the final presenter and output retain full resolution', async t => {
  const f = await fixture(t)
  await clip(f.videoPath, 'blue', 880, '1280x720', 15, 48000, 2, 1.2)
  const result = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  const video = (await probe(result.videoPath)).streams.find((item: any) => item.codec_type === 'video')
  assert.deepEqual([video.width, video.height], [1280, 720])
  const moving = await pixel(result.videoPath, .533, { x: 914, y: 463, width: 8, height: 8 })
  assert.ok(moving[0]! > 200 && moving[2]! < 40, `the shrinking intro remains at its expected HD position: ${moving}`)
  const outside = await pixel(result.videoPath, .533, { x: 400, y: 200, width: 8, height: 8 })
  assert.ok(outside[2]! > 200 && outside[0]! < 40, `main is revealed outside the moving layer: ${outside}`)
  const circle = await pixel(result.videoPath, 1.35, { x: 956, y: 496, width: 8, height: 8 })
  assert.ok(circle[0]! + circle[1]! > 70, `full-size presenter remains visible in the final window: ${circle}`)
})

for (const dimensions of ['320x180', '300x200', '180x320']) test(`mobile feed preserves the full presenter above subtitles at ${dimensions}`, async t => {
  const f = await fixture(t)
  const [width, height] = dimensions.split('x').map(Number) as [number, number]
  await clip(f.videoPath, 'blue', 880, dimensions, 15, 48000, 2, 1.2)
  await clip(f.presenterPath, 'yellow', 2200, '160x160', 15, 48000, 2, 1.3)
  const result = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  const video = (await probe(result.videoPath)).streams.find((item: any) => item.codec_type === 'video')
  assert.deepEqual([video.width, video.height], [width, height], 'keep the original video aspect ratio')
  const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', '1.35', '-i', result.videoPath,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  const cropWidth = Math.min(width, height * 1.5), cropLeft = (width - cropWidth) / 2
  let presenterPixels = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3
    if (stdout[index]! < 170 || stdout[index + 1]! < 160) continue
    presenterPixels++
    assert.ok(x >= cropLeft && x < cropLeft + cropWidth, `the centered 3:2 feed crop must retain presenter pixel ${x},${y}`)
    assert.ok(x < cropLeft + cropWidth * .88, 'presenter must clear the right-side player controls after cropping')
    assert.ok(y < height * .82, 'presenter must clear the bottom subtitle band')
  }
  assert.ok(presenterPixels > 500, 'the full presenter is visible in the actual encoded frame')
})

for (const dimensions of ['320x180', '180x320']) test(`larger half-body circle keeps its 30-percent diameter inside the mobile safe area at ${dimensions}`, async t => {
  const f = await fixture(t)
  const [width, height] = dimensions.split('x').map(Number) as [number, number]
  await clip(f.videoPath, 'blue', 880, dimensions, 15, 48000, 2, 1.2)
  await clip(f.presenterPath, 'yellow', 2200, '160x160', 15, 48000, 2, 1.3)
  const result = await prepareScienceVideoWithIntro(f,
    { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath, presenterFraming: 'half-body' })
  const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', '1.35', '-i', result.videoPath,
    '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
  const cropWidth = Math.min(width, height * 1.5), cropLeft = (width - cropWidth) / 2
  const diameter = Math.round(Math.min(width, height) * .30 / 2) * 2
  const right = Math.ceil((cropLeft + cropWidth * .12) / 2) * 2
  const bottom = Math.ceil(height * .18 / 2) * 2
  const left = width - diameter - right, top = height - diameter - bottom
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3
    if (stdout[index]! < 170 || stdout[index + 1]! < 160) continue
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    assert.ok(x >= cropLeft && x < cropLeft + cropWidth * .88, 'the larger circle clears feed cropping and right controls')
    assert.ok(y < height * .82, 'the larger circle stays above the subtitle band')
  }
  assert.ok(Math.abs(minX - left) <= 1 && Math.abs(minY - top) <= 1, `larger circle begins at ${left},${top}, got ${minX},${minY}`)
  assert.ok(maxX - minX + 1 >= diameter - 2 && maxY - minY + 1 >= diameter - 2,
    `the encoded circle must span ${diameter}px rather than the old 25 percent: ${maxX - minX + 1}x${maxY - minY + 1}`)
})

test('a missing or too-short synchronized presenter is rejected instead of looping or substituting silence', async t => {
  const f = await fixture(t), previous = process.env.SCIENCE_PRESENTER_VIDEO_PATH
  delete process.env.SCIENCE_PRESENTER_VIDEO_PATH
  t.after(() => { if (previous !== undefined) process.env.SCIENCE_PRESENTER_VIDEO_PATH = previous })
  await assert.rejects(prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath }), /主播/)
  await presenter(f.presenterPath, .4)
  await assert.rejects(prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath }), /主播.*(?:时长|长度)|覆盖/)
})

test('presenter byte changes invalidate the composite while keeping the original main binding', async t => {
  const f = await fixture(t)
  const first = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  await clip(f.presenterPath, 'green', 3300, '160x160', 15, 32000, 2, 1.3)
  const changed = await prepareScienceVideoWithIntro({ ...f, videoPath: first.videoPath },
    { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  assert.equal(changed.sourceSha256, first.sourceSha256)
  assert.notEqual(changed.videoPath, first.videoPath)
  assert.ok(Math.abs(Number((await probe(changed.videoPath)).format.duration) - 1.8) < .2)
})

for (const legacyVersion of [1, 2, 3, 4] as const) test(`version-${legacyVersion} composites recover the original main and upgrade their render without repeating the intro`, async t => {
  const f = await fixture(t)
  await fs.mkdir(f.directory, { recursive: true })
  const oldOutput = path.join(f.directory, 'science-with-intro-' + '1'.repeat(64) + '.mp4')
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', f.introPath, '-i', f.videoPath,
    '-filter_complex', '[0:v]scale=320:180,fps=15,setsar=1[v0];[1:v]setsar=1[v1];[0:a]aresample=48000[a0];[1:a]aresample=48000[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', oldOutput])
  await fs.writeFile(path.join(f.directory, 'science-video-intro.json'), JSON.stringify({ version: legacyVersion, entries: [{
    videoPath: oldOutput, sourcePath: f.videoPath, sourceSha256: await digest(f.videoPath),
    introSha256: await digest(f.introPath), outputSha256: await digest(oldOutput),
    ...(legacyVersion >= 2 ? { presenterSha256: await digest(f.presenterPath) } : {}),
  }] }))
  assert.deepEqual(await resolveScienceVideoIntroSource({ videoPath: oldOutput, directory: f.directory }, { signal: signal() }),
    { videoPath: f.videoPath, sourceSha256: await digest(f.videoPath) })
  const upgraded = await prepareScienceVideoWithIntro({ ...f, videoPath: oldOutput },
    { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  assert.notEqual(upgraded.videoPath, oldOutput)
  assert.equal(upgraded.sourceSha256, await digest(f.videoPath))
  assert.ok(Math.abs(Number((await probe(upgraded.videoPath)).format.duration) - 1.8) < .2, 'upgrade does not prepend the intro twice')
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory, 'science-video-intro.json'), 'utf8'))
  assert.equal(manifest.version, 5)
  const current = manifest.entries.find((entry: any) => entry.videoPath === upgraded.videoPath)
  assert.equal(current.presenterSha256, await digest(f.presenterPath))
  assert.equal(current.renderVersion, 5)
  assert.equal(manifest.entries.find((entry: any) => entry.videoPath === oldOutput).renderVersion, legacyVersion)
  assert.deepEqual(await resolveScienceVideoIntroSource({ videoPath: oldOutput, directory: f.directory }, { signal: signal() }),
    { videoPath: f.videoPath, sourceSha256: await digest(f.videoPath) })
})

test('a very short main retains its entire audio and finishes the already-settled circle without extending the timeline', async t => {
  const f = await fixture(t)
  await clip(f.videoPath, 'blue', 880, '320x180', 25, 48000, 1, .12)
  const mainDuration = Number((await probe(f.videoPath)).format.duration)
  const introDuration = Number((await probe(f.introPath)).format.duration)
  const result = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  const output = await probe(result.videoPath)
  assert.ok(Math.abs(Number(output.format.duration) - mainDuration - introDuration) < .08)
  const video = output.streams.find((item: any) => item.codec_type === 'video')
  assert.equal(video.avg_frame_rate, '25/1')
  const outside = await pixel(result.videoPath, introDuration + .04, { x: 80, y: 60, width: 4, height: 4 })
  assert.ok(outside[2]! > 200 && outside[0]! < 40, 'the main is immediately visible after the intro')
})

test('the circular presenter is framed on the head and shoulders rather than the lower body', async t => {
  const f = await fixture(t)
  // Sample inside the color markers, away from subsampled chroma boundaries.
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'color=yellow:s=160x160:r=15:d=1.3,drawbox=x=0:y=0:w=160:h=40:color=red:t=fill,drawbox=x=0:y=110:w=160:h=50:color=green:t=fill',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-an', f.presenterPath])
  const result = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  const shoulder = await pixel(result.videoPath, 1.35, { x: 237, y: 133, width: 4, height: 4 })
  assert.ok(shoulder[0]! > 170 && shoulder[1]! > 170 && shoulder[2]! < 60, `window retains the shoulder area rather than lower body: ${shoulder}`)
  const head = await pixel(result.videoPath, 1.35, { x: 237, y: 107, width: 4, height: 4 })
  assert.ok(head[0]! > 170 && head[1]! < 70, `head top stays inside the circular frame: ${head}`)
})

test('closeup framing preserves the chin area and never reuses the zoomed presenter composite', async t => {
  const f = await fixture(t)
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'color=yellow:s=160x160:r=15:d=1.3,drawbox=x=0:y=0:w=160:h=40:color=red:t=fill,drawbox=x=0:y=110:w=160:h=50:color=lime:t=fill',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-an', f.presenterPath])
  const options = { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath }
  const zoomed = await prepareScienceVideoWithIntro(f, { ...options, presenterFraming: 'head-and-shoulders' })
  const closeup = await prepareScienceVideoWithIntro({ ...f, videoPath: zoomed.videoPath }, { ...options, presenterFraming: 'closeup' })
  assert.notEqual(closeup.videoPath, zoomed.videoPath)
  assert.equal(closeup.sourceSha256, zoomed.sourceSha256)
  const chin = await pixel(closeup.videoPath, 1.35, { x: 237, y: 133, width: 4, height: 4 })
  assert.ok(chin[1]! > 170 && chin[0]! < 70 && chin[2]! < 70, `full closeup keeps the lower face: ${chin}`)
  const zoomedChin = await pixel(zoomed.videoPath, 1.35, { x: 237, y: 133, width: 4, height: 4 })
  assert.ok(zoomedChin[0]! > 170 && zoomedChin[1]! > 170, 'legacy zoom excludes the closeup lower-face marker')
  const forehead = await pixel(closeup.videoPath, 1.35, { x: 237, y: 105, width: 4, height: 4 })
  assert.ok(forehead[0]! > 170 && forehead[1]! < 70, `closeup retains the upper face: ${forehead}`)
  assert.deepEqual(await prepareScienceVideoWithIntro(f, { ...options, presenterFraming: 'closeup' }), closeup)
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory, 'science-video-intro.json'), 'utf8'))
  assert.equal(manifest.entries.find((entry: any) => entry.videoPath === closeup.videoPath).presenterFraming, 'closeup')
})

test('half-body framing preserves the centered source body and both gestures with a separately bound cache', async t => {
  const f = await fixture(t)
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'color=yellow:s=200x160:r=15:d=1.3,drawbox=x=0:y=0:w=200:h=40:color=red:t=fill,'
      + 'drawbox=x=70:y=110:w=60:h=50:color=lime:t=fill,'
      + 'drawbox=x=40:y=65:w=25:h=35:color=cyan:t=fill,drawbox=x=135:y=65:w=25:h=35:color=magenta:t=fill',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-an', f.presenterPath])
  const options = { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath }
  const zoomed = await prepareScienceVideoWithIntro(f, { ...options, presenterFraming: 'head-and-shoulders' })
  const closeup = await prepareScienceVideoWithIntro(f, { ...options, presenterFraming: 'closeup' })
  const halfBody = await prepareScienceVideoWithIntro({ ...f, videoPath: zoomed.videoPath },
    { ...options, presenterFraming: 'half-body' })
  assert.notEqual(halfBody.videoPath, zoomed.videoPath)
  assert.notEqual(halfBody.videoPath, closeup.videoPath)
  assert.equal(halfBody.sourceSha256, zoomed.sourceSha256)
  const body = await pixel(halfBody.videoPath, 1.35, { x: 237, y: 133, width: 4, height: 4 })
  assert.ok(body[1]! > 170 && body[0]! < 70 && body[2]! < 70, `the lower torso remains visible: ${body}`)
  const leftHand = await pixel(halfBody.videoPath, 1.35, { x: 219, y: 116, width: 4, height: 4 })
  assert.ok(leftHand[0]! < 70 && leftHand[1]! > 170 && leftHand[2]! > 170, `the left gesture remains visible: ${leftHand}`)
  const rightHand = await pixel(halfBody.videoPath, 1.35, { x: 249, y: 116, width: 4, height: 4 })
  assert.ok(rightHand[0]! > 170 && rightHand[1]! < 70 && rightHand[2]! > 170, `the right gesture remains visible: ${rightHand}`)
  assert.deepEqual(await prepareScienceVideoWithIntro({ ...f, videoPath: halfBody.videoPath },
    { ...options, presenterFraming: 'half-body' }), halfBody)
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory, 'science-video-intro.json'), 'utf8'))
  assert.equal(manifest.entries.find((entry: any) => entry.videoPath === halfBody.videoPath).presenterFraming, 'half-body')
})

test('half-body intro motion keeps the torso and both gestures while shrinking into the same safe circle', async t => {
  const f = await fixture(t)
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'color=yellow:s=640x360:r=24:d=0.6,drawbox=x=240:y=250:w=160:h=70:color=lime:t=fill,'
      + 'drawbox=x=200:y=160:w=60:h=60:color=cyan:t=fill,drawbox=x=380:y=160:w=60:h=60:color=magenta:t=fill',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=32000:duration=0.6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', f.introPath])
  const result = await prepareScienceVideoWithIntro(f,
    { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath, presenterFraming: 'half-body' })
  const body = await pixel(result.videoPath, .6, { x: 237, y: 133, width: 4, height: 4 })
  assert.ok(body[1]! > 170 && body[0]! < 70 && body[2]! < 70, `intro motion retains the torso: ${body}`)
  const leftHand = await pixel(result.videoPath, .6, { x: 220, y: 120, width: 3, height: 3 })
  assert.ok(leftHand[0]! < 70 && leftHand[1]! > 170 && leftHand[2]! > 170, `intro motion retains the left gesture: ${leftHand}`)
  const rightHand = await pixel(result.videoPath, .6, { x: 249, y: 123, width: 3, height: 3 })
  assert.ok(rightHand[0]! > 170 && rightHand[1]! < 70 && rightHand[2]! > 170, `intro motion retains the right gesture: ${rightHand}`)
})

test('half-body layout upgrades cannot reuse an older smaller-circle cache', async t => {
  const f = await fixture(t)
  const options = { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath, presenterFraming: 'half-body' as const }
  const first = await prepareScienceVideoWithIntro(f, options)
  const manifestPath = path.join(f.directory, 'science-video-intro.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const entry = manifest.entries.find((entry: any) => entry.videoPath === first.videoPath)
  const oldKey = createHash('sha256').update(JSON.stringify([5, first.sourceSha256, first.introSha256,
    await digest(f.presenterPath), 'half-body'])).digest('hex')
  const oldPath = path.join(f.directory, `science-with-intro-${oldKey}.mp4`)
  if (oldPath !== first.videoPath) await fs.copyFile(first.videoPath, oldPath)
  entry.videoPath = oldPath
  delete entry.presenterLayoutVersion
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  const upgraded = await prepareScienceVideoWithIntro({ ...f, videoPath: oldPath }, options)
  assert.notEqual(upgraded.videoPath, oldPath, 'an old half-body proof cannot authorize the enlarged-circle cache')
  assert.equal(upgraded.sourceSha256, first.sourceSha256, 'the original main remains bound without another intro')
  const updated = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert.equal(updated.entries.find((entry: any) => entry.videoPath === upgraded.videoPath).presenterLayoutVersion, 2)
  assert.deepEqual(await prepareScienceVideoWithIntro(f, options), upgraded)
})

test('presenter framing environment changes only presenter composites and explicit framing overrides it', async t => {
  const f = await fixture(t), previous = process.env.SCIENCE_PRESENTER_FRAMING
  t.after(() => { if (previous === undefined) delete process.env.SCIENCE_PRESENTER_FRAMING; else process.env.SCIENCE_PRESENTER_FRAMING = previous })
  const options = { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath }
  delete process.env.SCIENCE_PRESENTER_FRAMING
  const preview = await prepareScienceVideoIntroPreview(f, options)
  const legacy = await prepareScienceVideoWithIntro(f, options)
  process.env.SCIENCE_PRESENTER_FRAMING = 'closeup'
  const closeup = await prepareScienceVideoWithIntro(f, options)
  assert.notEqual(closeup.videoPath, legacy.videoPath)
  process.env.SCIENCE_PRESENTER_FRAMING = 'half-body'
  const halfBody = await prepareScienceVideoWithIntro(f, options)
  assert.notEqual(halfBody.videoPath, closeup.videoPath)
  assert.notEqual(halfBody.videoPath, legacy.videoPath)
  assert.deepEqual(await prepareScienceVideoIntroPreview(f, options), preview)
  assert.deepEqual(await prepareScienceVideoWithIntro(f, { ...options, presenterFraming: 'closeup' }), closeup)
  assert.deepEqual(await prepareScienceVideoWithIntro(f, { ...options, presenterFraming: 'head-and-shoulders' }), legacy)
  process.env.SCIENCE_PRESENTER_FRAMING = 'invalid-mode'
  assert.deepEqual(await prepareScienceVideoIntroPreview(f, options), preview)
})

test('invalid presenter framing is rejected before reading media or creating output files', async t => {
  const f = await fixture(t)
  await fs.rm(f.videoPath)
  await assert.rejects(prepareScienceVideoWithIntro(f, { signal: signal(), presenterPath: f.presenterPath,
    presenterFraming: 'invalid-mode' as any }), /主播取景模式无效/)
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' })
})

test('source resolution validates the original main before presenter generation and refuses changed or missing originals', async t => {
  const f = await fixture(t), raw = { videoPath: f.videoPath, sourceSha256: await digest(f.videoPath) }
  assert.deepEqual(await resolveScienceVideoIntroSource(f, { signal: signal() }), raw)
  const composed = await prepareScienceVideoWithIntro(f, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  const input = { videoPath: composed.videoPath, directory: f.directory }
  assert.deepEqual(await resolveScienceVideoIntroSource(input, { signal: signal() }), raw)
  await fs.writeFile(f.videoPath, 'changed main audio')
  await assert.rejects(resolveScienceVideoIntroSource(input, { signal: signal() }), /原.*(?:缺失|改变|变更)/)
  await assert.rejects(prepareScienceVideoWithIntro(input, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath }), /原.*(?:缺失|改变|变更)/)
  await fs.rm(f.videoPath)
  await assert.rejects(resolveScienceVideoIntroSource(input, { signal: signal() }), /原.*(?:缺失|改变|变更)/)
})

test('local intro previews preserve order and original audio, reuse their own cache and upgrade to a presenter without repeating the intro', async t => {
  const f = await fixture(t), previousPresenter = process.env.SCIENCE_PRESENTER_VIDEO_PATH
  process.env.SCIENCE_PRESENTER_VIDEO_PATH = path.join(f.root, 'unavailable-presenter.mp4')
  t.after(() => { if (previousPresenter === undefined) delete process.env.SCIENCE_PRESENTER_VIDEO_PATH; else process.env.SCIENCE_PRESENTER_VIDEO_PATH = previousPresenter })
  const preview = await prepareScienceVideoIntroPreview(f, { signal: signal(), introPath: f.introPath })
  const before = await fs.stat(preview.videoPath)
  assert.equal(preview.sourceSha256, await digest(f.videoPath))
  assert.ok(Math.abs(Number((await probe(preview.videoPath)).format.duration) - 1.8) < .2)
  const intro = await pixel(preview.videoPath, .2), transition = await pixel(preview.videoPath, .85)
  assert.ok(intro[0]! > 200 && intro[2]! < 40)
  assert.ok(transition[0]! > 40 && transition[2]! > 40)
  const body = await pixel(preview.videoPath, 1.35, { x: 288, y: 148, width: 8, height: 8 })
  assert.ok(body[2]! > 200 && body[0]! < 40, 'preview contains no presenter window')
  assert.ok(Math.abs(await frequency(preview.videoPath, .15) - 440) < 15)
  assert.ok(Math.abs(await frequency(preview.videoPath, 1.25) - 880) < 15)
  const previewInput = { ...f, videoPath: preview.videoPath }
  assert.deepEqual(await prepareScienceVideoIntroPreview(previewInput, { signal: signal(), introPath: f.introPath }), preview)
  assert.equal((await fs.stat(preview.videoPath)).mtimeMs, before.mtimeMs)
  assert.deepEqual(await resolveScienceVideoIntroSource(previewInput, { signal: signal() }), { videoPath: f.videoPath, sourceSha256: preview.sourceSha256 })
  const full = await prepareScienceVideoWithIntro(previewInput, { signal: signal(), introPath: f.introPath, presenterPath: f.presenterPath })
  assert.notEqual(full.videoPath, preview.videoPath)
  assert.equal(full.sourceSha256, preview.sourceSha256)
  assert.ok(Math.abs(Number((await probe(full.videoPath)).format.duration) - 1.8) < .2)
  assert.deepEqual(await prepareScienceVideoIntroPreview({ ...f, videoPath: full.videoPath }, { signal: signal(), introPath: f.introPath }), preview)
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory, 'science-video-intro.json'), 'utf8'))
  assert.equal(manifest.entries.find((entry: any) => entry.videoPath === preview.videoPath).presenterSha256, undefined)
  assert.equal(manifest.entries.find((entry: any) => entry.videoPath === full.videoPath).presenterSha256, await digest(f.presenterPath))
})

test('intro-only final delivery preserves the full intro and body audio with a fade and no presenter or network dependency', async t => {
  const f = await fixture(t), reports: string[] = []
  await fs.rm(f.presenterPath)
  const keys = ['SCIENCE_PRESENTER_VIDEO_PATH', 'SCIENCE_PRESENTER_REFERENCE_PATH', 'SCIENCE_PRESENTER_FRAMING', 'LATENTSYNC_API_URL'] as const
  const previous = keys.map(key => [key, process.env[key]] as const)
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  process.env.SCIENCE_PRESENTER_VIDEO_PATH = f.presenterPath
  process.env.SCIENCE_PRESENTER_REFERENCE_PATH = f.presenterPath
  process.env.SCIENCE_PRESENTER_FRAMING = 'invalid-unused-framing'
  process.env.LATENTSYNC_API_URL = 'http://127.0.0.1:1'
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('intro-only delivery must not call a network service') })
  const options = { signal: signal(), introPath: f.introPath, report: (message: string) => reports.push(message) }
  const result = await prepareScienceVideoWithIntroOnly(f, options)
  const metadata = await probe(result.videoPath)
  const video = metadata.streams.find((item: any) => item.codec_type === 'video')
  assert.ok(Math.abs(Number(metadata.format.duration) - 1.8) < .08)
  assert.ok(Math.abs(Number(video.duration) - 1.8) < .08, 'the complete intro and main retain their combined timeline')
  const intro = await pixel(result.videoPath, .2), fade = await pixel(result.videoPath, .85)
  assert.ok(intro[0]! > 200 && intro[2]! < 40, 'the actual intro plays before the body')
  assert.ok(fade[0]! > 40 && fade[2]! > 40, 'the intro fades into the body')
  for (const timestamp of [1.25, 1.65]) {
    const lowerRight = await pixel(result.videoPath, timestamp, { x: 288, y: 148, width: 8, height: 8 })
    assert.ok(lowerRight[2]! > 200 && lowerRight[0]! < 40, 'the body contains no presenter circle')
  }
  assert.ok(Math.abs(await frequency(result.videoPath, .15) - 440) < 15, 'original intro audio is retained')
  assert.ok(Math.abs(await frequency(result.videoPath, 1.5) - 880) < 15, 'original body narration reaches the end')
  const before = await fs.stat(result.videoPath)
  assert.deepEqual(await prepareScienceVideoIntroPreview({ ...f, videoPath: result.videoPath }, options), result)
  assert.deepEqual(await prepareScienceVideoWithIntroOnly({ ...f, videoPath: result.videoPath }, options), result)
  assert.equal((await fs.stat(result.videoPath)).mtimeMs, before.mtimeMs)
  assert.equal(network.mock.callCount(), 0)
  assert.ok(reports.length > 0 && reports.every(message => !message.includes('预览')), 'final-delivery progress does not describe a preview')
})

test('intro-only delivery copies the body after the transition without changing decoded frames, narration or timeline', async t => {
  const f = await fixture(t), reports: string[] = []
  const progress: Array<{ percent: number; totalSeconds: number }> = []
  const videoPath = path.join(f.root, "main 'quoted'.mp4")
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=6',
    '-c:v', 'libx264', '-preset', 'fast', '-bf', '0', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-shortest', videoPath])
  const result = await prepareScienceVideoWithIntroOnly({ ...f, videoPath },
    { signal: signal(), introPath: f.introPath, report: message => reports.push(message), onProgress: update => progress.push(update) })
  const frameHashes = async (file: string) => {
    const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-an',
      '-pix_fmt', 'yuv420p', '-f', 'framemd5', 'pipe:1'])
    return stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1)!.trim())
  }
  const [source, output] = await Promise.all([frameHashes(videoPath), frameHashes(result.videoPath)])
  assert.equal(output.length, source.length + 9, 'the complete intro and main retain every frame')
  assert.deepEqual(output.slice(24), source.slice(15), 'all body frames after the one-second splice remain lossless')
  const fade = await pixel(result.videoPath, .85)
  assert.ok(fade[0]! > 40, 'the original fade is retained before the copied body')
  assert.ok(Math.abs(await frequency(result.videoPath, .15) - 440) < 15)
  assert.ok(Math.abs(await frequency(result.videoPath, 6.3) - 880) < 15, 'main narration remains audible near the end')
  const metadata = await probe(result.videoPath)
  assert.ok(Math.abs(Number(metadata.format.duration) - 6.6) < .08)
  assert.ok(reports.some(message => message.includes('复制')), 'progress identifies the fast body-copy path')
  assert.ok(progress.some(update => update.percent < 100), 'the copy pipeline reports progress before committing')
  assert.equal(progress.at(-1)?.percent, 100)
  assert.ok(progress.every(update => Math.abs(update.totalSeconds - 6.6) < .1), 'both copy phases use the full delivery duration')
  assert.deepEqual((await fs.readdir(f.directory)).sort(), [path.basename(result.videoPath), 'science-video-intro.json'].sort())
})

test('fractional frame rates retain the copied body without cumulative audio or video drift', async t => {
  const f = await fixture(t), reports: string[] = []
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30000/1001:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
    '-c:v', 'libx264', '-preset', 'fast', '-bf', '0', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', f.videoPath])
  const result = await prepareScienceVideoWithIntroOnly(f, { signal: signal(), introPath: f.introPath, report: message => reports.push(message) })
  const metadata = await probe(result.videoPath), video = metadata.streams.find((item: any) => item.codec_type === 'video')
  assert.equal(video.avg_frame_rate, '30000/1001')
  assert.equal(Number(video.nb_frames), 108)
  assert.ok(Math.abs(Number(video.duration) - 3.6) < 1 / 29.97)
  assert.ok(Math.abs(Number(metadata.format.duration) - Number(video.duration)) < .03)
  assert.ok(Math.abs(await frequency(result.videoPath, 3.25) - 880) < 15)
  assert.ok(reports.some(message => message.includes('直接复制正文')), reports.join('\n'))
  assert.ok(reports.every(message => !message.includes('兼容模式')), reports.join('\n'))
})

test('cancelling the fast copy path cleans its encoded prefix and never falls back to a full render', async t => {
  const f = await fixture(t), controller = new AbortController(), reports: string[] = []
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
    '-c:v', 'libx264', '-preset', 'fast', '-bf', '0', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f.videoPath])
  const sourceHash = await digest(f.videoPath)
  await assert.rejects(prepareScienceVideoWithIntroOnly(f, { signal: controller.signal, introPath: f.introPath, report: message => {
    reports.push(message)
    if (message.includes('直接复制正文')) controller.abort(new Error('cancel fast copy'))
  } }), /cancel fast copy|aborted/i)
  assert.ok(reports.some(message => message.includes('直接复制正文')), reports.join('\n'))
  assert.ok(reports.every(message => !message.includes('兼容模式')), reports.join('\n'))
  assert.equal(await digest(f.videoPath), sourceHash)
  assert.deepEqual(await fs.readdir(f.directory), [])
})

test('body video with B frames uses the compatible renderer and preserves the complete narration', async t => {
  const f = await fixture(t), reports: string[] = []
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=3',
    '-c:v', 'libx264', '-preset', 'fast', '-bf', '2', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f.videoPath])
  assert.ok((await probe(f.videoPath)).streams.find((item: any) => item.codec_type === 'video').has_b_frames > 0)
  const result = await prepareScienceVideoWithIntroOnly(f, { signal: signal(), introPath: f.introPath, report: message => reports.push(message) })
  const metadata = await probe(result.videoPath)
  assert.equal(Number(metadata.streams.find((item: any) => item.codec_type === 'video').nb_frames), 54)
  assert.ok(Math.abs(Number(metadata.format.duration) - 3.6) < .08)
  assert.ok(Math.abs(await frequency(result.videoPath, 3.2) - 880) < 15)
  assert.ok(reports.every(message => !message.includes('复制')), reports.join('\n'))
})
