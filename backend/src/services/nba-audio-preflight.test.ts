import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { inspectNbaAudioWindow, selectNbaClosingAudio, verifyNbaAudioPreflight } from './nba-audio-preflight.js'
import { runNbaCommand, type NbaCommand } from './nba-production.js'

const signal = () => new AbortController().signal
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-audio-preflight-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return { directory, signal: signal(), run: runNbaCommand }
}

test('real closing audio selection detects a silent scoreboard and selects adjacent arena audio', async t => {
  const f = await fixture(t), audio = path.join(f.directory, 'arena.wav')
  await f.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=8',
    '-af', 'apad=whole_dur=12', '-ac', '2', audio], f)
  const result = await selectNbaClosingAudio({ audioPath: audio, closingStartSeconds: 8, closingDurationSeconds: 4, liveEndSeconds: 8, sourceDurationSeconds: 12 }, f)
  assert.equal(result.sourceStartSeconds, 4)
  assert.equal(result.usedFallback, true)
  assert.equal(result.candidates[0].metrics.longestSilenceSeconds, 4)
  assert.ok(result.candidates[1].metrics.rmsDbFS > -30)
  assert.equal(result.candidates[1].metrics.audibleFraction, 1)
})

test('a source without an audible closing bed fails after a bounded candidate search', async t => {
  const f = await fixture(t), audio = path.join(f.directory, 'silence.wav')
  await f.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=stereo', '-t', '20', audio], f)
  await assert.rejects(selectNbaClosingAudio({ audioPath: audio, closingStartSeconds: 16, closingDurationSeconds: 4, liveEndSeconds: 16, sourceDurationSeconds: 20 }, f),
    (error: any) => /同源.*有声/.test(error.message) && error.evidence.candidates.length === 4)
})

test('the old 3.5-second silent ending fails while a natural one-second fade passes', async t => {
  const f = await fixture(t), broken = path.join(f.directory, 'broken.wav'), good = path.join(f.directory, 'good.wav')
  for (const [output, filter] of [[broken, 'atrim=duration=16.5,apad=whole_dur=20'], [good, 'afade=t=out:st=19:d=1']] as const) {
    await f.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:duration=20', '-af', filter, '-ac', '2', output], f)
  }
  await assert.rejects(verifyNbaAudioPreflight(broken, { ...f, durationSeconds: 20 }), /片尾.*静音/)
  const result = await verifyNbaAudioPreflight(good, { ...f, durationSeconds: 20 })
  assert.equal(result.status, 'passed')
  assert.ok(result.ending.longestSilenceOutsideFinalFadeSeconds <= .1)
  assert.equal(result.narrationAlignment.status, 'not-provided')
})

test('real mixed audio locates the TTS insertion and rejects a shifted narration track', async t => {
  const f = await fixture(t), voice = path.join(f.directory, 'voice.wav')
  await f.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:seed=42:sample_rate=48000:duration=12:amplitude=0.2', voice], f)
  for (const delay of [120, 320]) {
    const output = path.join(f.directory, `mixed-${delay}.wav`)
    await f.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', voice, '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=20',
      '-filter_complex', `[0:a]adelay=${delay}:all=1[v];[1:a]volume=0.3[b];[b][v]amix=normalize=0:duration=first,afade=t=out:st=19:d=1[a]`, '-map', '[a]', '-ac', '2', output], f)
    const options = { ...f, durationSeconds: 20, narration: { path: voice, durationSeconds: 12, startSeconds: .12 } }
    if (delay === 120) {
      const result = await verifyNbaAudioPreflight(output, options)
      assert.equal(result.narrationAlignment.status, 'passed')
      assert.ok(Math.abs(result.narrationAlignment.detectedDelaySeconds! - .12) < .001)
    } else await assert.rejects(verifyNbaAudioPreflight(output, options), /配音.*错位/)
  }
})

test('missing or nonfinite PCM is never accepted as silence or a valid window', async () => {
  const run: NbaCommand = async () => ({ stdout: Buffer.alloc(4), stderr: '' })
  await assert.rejects(inspectNbaAudioWindow('test.wav', 0, 4, { signal: signal(), run }), /采样不足/)
  const pcm = Buffer.alloc(4 * 16000 * 2 * 4)
  pcm.writeFloatLE(NaN)
  await assert.rejects(inspectNbaAudioWindow('test.wav', 0, 4, { signal: signal(), run: async () => ({ stdout: pcm, stderr: '' }) }), /非有限/)
})
