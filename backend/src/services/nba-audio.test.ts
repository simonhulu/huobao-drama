import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { measureNbaAudio, prepareNbaAudio } from './nba-audio.js'
import { runNbaCommand, type NbaCommand } from './nba-production.js'

async function fixture(t: TestContext, peaks = [.08, -2.1]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-audio-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'video.pending.mp4')
  await fs.writeFile(filename, 'original-video-and-audio')
  let encodes = 0
  const run: NbaCommand = async (_command, args, options) => {
    options.signal.throwIfAborted()
    if (args.includes('streamhash')) return { stdout: Buffer.from('0,v,SHA256=unchanged-video-packets\n'), stderr: '' }
    if (args.includes('copy')) {
      assert.equal(args[args.indexOf('-c:v') + 1], 'copy')
      assert.equal(args[args.indexOf('-i') + 1], filename, 'each attempt uses the original audio')
      assert.match(args[args.indexOf('-af') + 1], /^volume=-[\d.]+dB$/)
      encodes++
      await fs.writeFile(args.at(-1)!, `repaired-${encodes}`)
      return { stdout: Buffer.alloc(0), stderr: '' }
    }
    const peak = args[args.indexOf('-i') + 1] === filename ? peaks[0] : peaks[Math.min(encodes, peaks.length - 1)]
    return { stdout: Buffer.alloc(0), stderr: JSON.stringify({ input_i: '-15.84', input_tp: String(peak) }) }
  }
  return { directory, filename, run, signal: new AbortController().signal, encodes: () => encodes }
}

test('safe audio is measured without encoding or changing the source', async t => {
  const f = await fixture(t, [-2])
  const result = await prepareNbaAudio(f.filename, f)
  assert.equal(result.path, f.filename)
  assert.equal(result.measurement.truePeakDbTP, -2)
  assert.equal(f.encodes(), 0)
})

test('AAC true-peak overshoot repairs only audio, preserves the source, and reuses a verified candidate', async t => {
  const f = await fixture(t)
  const result = await prepareNbaAudio(f.filename, f)
  assert.notEqual(result.path, f.filename)
  assert.equal(result.measurement.truePeakDbTP, -2.1)
  assert.equal(f.encodes(), 1)
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'original-video-and-audio')
  const report = JSON.parse(await fs.readFile(path.join(f.directory, 'audio-recovery.json'), 'utf8'))
  assert.equal(report.status, 'recovered')
  assert.equal(report.before.truePeakDbTP, .08)
  assert.equal(report.attempts[0].gainDb, -2.08)
  assert.equal(report.videoPacketsUnchanged, true)
  assert.equal((await prepareNbaAudio(f.filename, f)).path, result.path)
  assert.equal(f.encodes(), 1)
})

test('failed peak repair is bounded across resume and never replaces the original', async t => {
  const f = await fixture(t, [.08, .04, .02])
  await assert.rejects(prepareNbaAudio(f.filename, f), /两次.*真峰值/)
  assert.equal(f.encodes(), 2)
  await assert.rejects(prepareNbaAudio(f.filename, { ...f, run: async () => ({ stdout: Buffer.alloc(0), stderr: 'transient missing measurement' }) }), /未返回/)
  await assert.rejects(prepareNbaAudio(f.filename, f), /两次.*真峰值/)
  assert.equal(f.encodes(), 2)
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'original-video-and-audio')
})

test('silence and malformed measurements are distinct failures and never trigger encoding', async t => {
  const f = await fixture(t)
  for (const [stderr, message] of [
    ['{"input_i":"-inf","input_tp":"-inf"}', /静音/],
    ['{"input_i":"NaN","input_tp":"0.08"}', /检测数据无效/],
    ['{"input_i":null,"input_tp":"0.08"}', /检测数据无效/],
    ['{"input_i":"-16"}', /检测数据无效/],
    ['no JSON', /未返回/],
  ] as const) {
    const run: NbaCommand = async () => ({ stdout: Buffer.alloc(0), stderr })
    await assert.rejects(measureNbaAudio(f.filename, { signal: f.signal, run }), message)
    await assert.rejects(prepareNbaAudio(f.filename, { ...f, run }), message)
  }
  assert.equal(f.encodes(), 0)
})

test('changed video packets and cancellation cannot promote an audio repair', async t => {
  const f = await fixture(t)
  let packetHashes = 0
  const run: NbaCommand = (command, args, options) => args.includes('streamhash')
    ? Promise.resolve({ stdout: Buffer.from(`0,v,SHA256=${packetHashes++}\n`), stderr: '' }) : f.run(command, args, options)
  await assert.rejects(prepareNbaAudio(f.filename, { ...f, run }), /画面数据/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareNbaAudio(f.filename, { ...f, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'original-video-and-audio')
})

test('real ffmpeg repairs an encoded overshoot while preserving every video packet', async t => {
  const f = await fixture(t), options = { signal: f.signal, run: runNbaCommand }
  await runNbaCommand('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000:duration=3', '-af', 'volume=13', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', f.filename], { signal: f.signal, timeout: 30000 })
  assert.ok((await measureNbaAudio(f.filename, options)).truePeakDbTP >= 0)
  const result = await prepareNbaAudio(f.filename, { ...options, directory: f.directory })
  assert.ok(result.measurement.truePeakDbTP <= -1.5)
  assert.ok((await measureNbaAudio(f.filename, options)).truePeakDbTP >= 0, 'source remains intact')
  await runNbaCommand('ffmpeg', ['-nostdin', '-v', 'error', '-i', result.path, '-f', 'null', '-'], { signal: f.signal, timeout: 30000 })
})
