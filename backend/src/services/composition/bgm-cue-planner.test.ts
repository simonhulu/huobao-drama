import test from 'node:test'
import assert from 'node:assert/strict'
import { planBgmCues } from './bgm-cue-planner.js'

test('planBgmCues keeps short adjacent shots in one music cue', () => {
  const cues = planBgmCues([
    { videoDuration: 8, bgmPath: 'a.mp3' },
    { videoDuration: 8, bgmPath: 'b.mp3' },
    { videoDuration: 8, bgmPath: 'a.mp3' },
    { videoDuration: 8, bgmPath: 'b.mp3' },
    { videoDuration: 8, bgmPath: 'a.mp3' },
  ], { minCueDuration: 35, maxCueDuration: 75 })

  assert.equal(cues.length, 1)
  assert.equal(cues[0].start, 0)
  assert.equal(cues[0].duration, 40)
  assert.equal(cues[0].shotStartIndex, 0)
  assert.equal(cues[0].shotEndIndex, 4)
  assert.equal(cues[0].bgmPath, 'a.mp3')
})

test('planBgmCues switches BGM only after the current cue has time to establish', () => {
  const cues = planBgmCues([
    { videoDuration: 10, bgmPath: 'a.mp3' },
    { videoDuration: 10, bgmPath: 'a.mp3' },
    { videoDuration: 10, bgmPath: 'a.mp3' },
    { videoDuration: 10, bgmPath: 'a.mp3' },
    { videoDuration: 10, bgmPath: 'b.mp3' },
    { videoDuration: 10, bgmPath: 'b.mp3' },
    { videoDuration: 10, bgmPath: 'b.mp3' },
    { videoDuration: 10, bgmPath: 'b.mp3' },
  ], { minCueDuration: 35, maxCueDuration: 75 })

  assert.deepEqual(cues.map(cue => ({
    start: cue.start,
    duration: cue.duration,
    bgmPath: cue.bgmPath,
    shotStartIndex: cue.shotStartIndex,
    shotEndIndex: cue.shotEndIndex,
  })), [
    { start: 0, duration: 40, bgmPath: 'a.mp3', shotStartIndex: 0, shotEndIndex: 3 },
    { start: 40, duration: 40, bgmPath: 'b.mp3', shotStartIndex: 4, shotEndIndex: 7 },
  ])
})

test('planBgmCues splits long continuous music beds by max cue duration', () => {
  const cues = planBgmCues(Array.from({ length: 10 }, () => ({
    videoDuration: 10,
    bgmPath: 'bed.mp3',
  })), { minCueDuration: 35, maxCueDuration: 60 })

  assert.deepEqual(cues.map(cue => ({
    start: cue.start,
    duration: cue.duration,
    bgmPath: cue.bgmPath,
    shotStartIndex: cue.shotStartIndex,
    shotEndIndex: cue.shotEndIndex,
  })), [
    { start: 0, duration: 60, bgmPath: 'bed.mp3', shotStartIndex: 0, shotEndIndex: 5 },
    { start: 60, duration: 40, bgmPath: 'bed.mp3', shotStartIndex: 6, shotEndIndex: 9 },
  ])
})

test('planBgmCues protects the opening 30 seconds from early BGM switches', () => {
  const cues = planBgmCues([
    { videoDuration: 10, bgmPath: 'hook.mp3' },
    { videoDuration: 10, bgmPath: 'threat.mp3' },
    { videoDuration: 10, bgmPath: 'hook.mp3' },
    { videoDuration: 10, bgmPath: 'later.mp3' },
  ], { minCueDuration: 10, maxCueDuration: 75, openingCueDuration: 30 })

  assert.equal(cues[0].start, 0)
  assert.ok(cues[0].duration >= 30, `opening cue duration ${cues[0].duration} should cover the hook window`)
})

test('planBgmCues chooses the first cue BGM from the opening hook window', () => {
  const cues = planBgmCues([
    { videoDuration: 10, bgmPath: 'hook.mp3' },
    { videoDuration: 10, bgmPath: 'hook.mp3' },
    { videoDuration: 5, bgmPath: 'hook.mp3' },
    { videoDuration: 30, bgmPath: 'later.mp3' },
  ], { minCueDuration: 35, maxCueDuration: 75, openingCueDuration: 30 })

  assert.equal(cues.length, 1)
  assert.equal(cues[0].bgmPath, 'hook.mp3')
})
