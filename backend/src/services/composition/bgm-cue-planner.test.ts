import test from 'node:test'
import assert from 'node:assert/strict'
import { planBgmCues, planEpisodeBgmCues, type EpisodeBgmTrack } from './bgm-cue-planner.js'
import type { AudioProfile } from '../audio-profile.js'

function profile(bucket: AudioProfile['emotionBucket']): AudioProfile {
  return {
    emotionBucket: bucket,
    bgmIntensity: 'medium',
    bgmPrompt: '',
    bgmPromptVariants: [],
    sfxDescriptions: [],
    ambientDescription: '',
  }
}

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

test('planEpisodeBgmCues groups same-emotion shots into one music cue', () => {
  const shots = [
    { id: 1, videoDuration: 10 },
    { id: 2, videoDuration: 10 },
    { id: 3, videoDuration: 10 },
  ]
  const profiles = new Map([
    [1, profile('tense')],
    [2, profile('tense')],
    [3, profile('tense')],
  ])
  const tracks: EpisodeBgmTrack[] = [{ path: 'tense.mp3', emotionBucket: 'tense', role: 'primary' }]

  const cues = planEpisodeBgmCues(shots, profiles, tracks)
  assert.equal(cues.length, 1)
  assert.equal(cues[0].duration, 30)
  assert.equal(cues[0].bgmPath, 'tense.mp3')
})

test('planEpisodeBgmCues switches music only on substantial emotional turns', () => {
  const shots = [
    { id: 1, videoDuration: 40 }, // tense
    { id: 2, videoDuration: 40 }, // tense
    { id: 3, videoDuration: 40 }, // epic
    { id: 4, videoDuration: 40 }, // epic
    { id: 5, videoDuration: 5 },  // tense (transient, should be absorbed)
  ]
  const profiles = new Map([
    [1, profile('tense')],
    [2, profile('tense')],
    [3, profile('epic')],
    [4, profile('epic')],
    [5, profile('tense')],
  ])
  const tracks: EpisodeBgmTrack[] = [
    { path: 'tense.mp3', emotionBucket: 'tense', role: 'primary' },
    { path: 'epic.mp3', emotionBucket: 'epic', role: 'secondary' },
  ]

  const cues = planEpisodeBgmCues(shots, profiles, tracks, { minActDuration: 25 })
  assert.equal(cues.length, 2)
  assert.equal(cues[0].bgmPath, 'tense.mp3')
  assert.equal(cues[0].duration, 80)
  assert.equal(cues[1].bgmPath, 'epic.mp3')
  assert.equal(cues[1].duration, 85)
})

test('planEpisodeBgmCues ignores short emotional blips without a dedicated track', () => {
  const shots = [
    { id: 1, videoDuration: 30 }, // calm
    { id: 2, videoDuration: 5 },  // happy (no track)
    { id: 3, videoDuration: 30 }, // calm
  ]
  const profiles = new Map([
    [1, profile('calm')],
    [2, profile('happy')],
    [3, profile('calm')],
  ])
  const tracks: EpisodeBgmTrack[] = [{ path: 'calm.mp3', emotionBucket: 'calm', role: 'primary' }]

  const cues = planEpisodeBgmCues(shots, profiles, tracks)
  assert.equal(cues.length, 1)
  assert.equal(cues[0].bgmPath, 'calm.mp3')
  assert.equal(cues[0].duration, 65)
})
