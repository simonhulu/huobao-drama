import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNonGraphicConstraint,
  classifyStoryboardImageFailure,
  deriveWaypointWindows,
  planSemanticMotion,
  requireNarrationAnchoredWaypointWindows,
  selectImageRecoveryAction,
} from './narrative_storyboard_runtime.mjs'

test('derives waypoint windows from narration anchor text instead of equal spacing', () => {
  const result = deriveWaypointWindows({
    event: { startMs: 1000, endMs: 7000 },
    captions: [
      { text: '李敢认为父亲李广的死和卫青有关，一时愤怒，', startMs: 1000, endMs: 5400 },
      { text: '对卫青动了手。', startMs: 5400, endMs: 7000 },
    ],
    beats: [
      { id: 'approach', anchorText: '父亲李广的死' },
      { id: 'confront', anchorText: '和卫青有关' },
      { id: 'anger', anchorText: '一时愤怒' },
      { id: 'strike', anchorText: '动了手' },
    ],
  })

  assert.equal(result.strategy, 'narration-anchor')
  assert.equal(result.windows[0].startMs, 1000)
  assert.ok(result.windows[1].startMs > 2500)
  assert.ok(result.windows[2].startMs > result.windows[1].startMs)
  assert.ok(result.windows[3].startMs >= 5400)
  assert.equal(result.windows.at(-1).endMs, 7000)
  assert.deepEqual(result.windows.map((window) => window.id), ['approach', 'confront', 'anger', 'strike'])
})

test('falls back to continuous equal windows when anchors cannot be resolved', () => {
  const result = deriveWaypointWindows({
    event: { startMs: 0, endMs: 9000 },
    captions: [],
    beats: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  })

  assert.equal(result.strategy, 'equal-fallback')
  assert.equal(result.fallbackReason, 'anchor-missing-or-ambiguous')
  assert.deepEqual(result.windows, [
    { id: 'a', startMs: 0, endMs: 3000 },
    { id: 'b', startMs: 3000, endMs: 6000 },
    { id: 'c', startMs: 6000, endMs: 9000 },
  ])
})

test('rejects ambiguous or reversed anchors in production timing', () => {
  const ambiguous = {
    event: { id: 'event-ambiguous', startMs: 0, endMs: 6000 },
    captions: [{ text: '逼近以后再次逼近', startMs: 0, endMs: 6000 }],
    beats: [{ id: 'a' }, { id: 'b', anchorText: '逼近' }],
  }
  assert.equal(deriveWaypointWindows(ambiguous).fallbackReason, 'anchor-missing-or-ambiguous')
  assert.throws(
    () => requireNarrationAnchoredWaypointWindows(ambiguous),
    (error) => error?.code === 'INVALID_NARRATIVE_STORYBOARD_TIMING' && /unique ordered narration anchors/.test(error.message),
  )

  const reversed = {
    event: { id: 'event-reversed', startMs: 0, endMs: 6000 },
    captions: [{ text: '先动手，后来才逼近', startMs: 0, endMs: 6000 }],
    beats: [
      { id: 'a' },
      { id: 'b', anchorText: '逼近' },
      { id: 'c', anchorText: '动手' },
    ],
  }
  assert.equal(deriveWaypointWindows(reversed).fallbackReason, 'anchor-order')
  assert.throws(() => requireNarrationAnchoredWaypointWindows(reversed), /unique ordered narration anchors/)
})

test('semantic motion varies by narrative function', () => {
  const establishing = planSemanticMotion({ description: 'Very low EWS / Imperial Hunt Enters', eventText: '进入甘泉宫猎场', index: 0 })
  const impact = planSemanticMotion({ description: 'Low profile FS / Sudden Strike', eventText: '突然动手', index: 1 })
  const memory = planSemanticMotion({ description: 'High court WS / Question Falls into Childhood', eventText: '看看卫青小时候', index: 2 })

  assert.equal(establishing.preset, 'establish-pull')
  assert.equal(impact.preset, 'impact-push')
  assert.equal(memory.preset, 'memory-pull')
  assert.notDeepEqual(establishing, impact)
})

test('recovery action reuses, adopts, waits, or resubmits only after a terminal provider failure', () => {
  assert.equal(selectImageRecoveryAction({ force: false, localExists: true, stateStatus: 'completed' }), 'reuse')
  assert.equal(selectImageRecoveryAction({ force: false, localExists: false, stateStatus: 'submitted', providerStatus: 'completed' }), 'adopt')
  assert.equal(selectImageRecoveryAction({ force: false, localExists: false, stateStatus: 'submitted', providerStatus: 'processing' }), 'wait')
  assert.equal(selectImageRecoveryAction({ force: false, localExists: false, stateStatus: 'submitted', providerStatus: 'failed', errorClass: 'provider_overloaded', attempts: 1, maxAttempts: 3 }), 'resubmit')
  assert.equal(selectImageRecoveryAction({ force: false, localExists: false, stateStatus: 'submitted', providerStatus: 'failed', errorClass: 'provider_overloaded', attempts: 3, maxAttempts: 3 }), 'blocked')
  assert.equal(selectImageRecoveryAction({ force: false, localExists: false, stateStatus: 'submitted', providerStatus: 'failed', errorClass: 'submission_uncertain', attempts: 1, maxAttempts: 3 }), 'blocked')
  assert.equal(selectImageRecoveryAction({ force: true, localExists: true, stateStatus: 'completed' }), 'resubmit')
})

test('classifies production failures so retryable provider faults cannot hide terminal failures', () => {
  assert.deepEqual(classifyStoryboardImageFailure(new Error('POST /images -> 429: provider overloaded')), {code: 'provider_overloaded', retryable: true, safeToResubmit: true})
  assert.deepEqual(classifyStoryboardImageFailure(new Error('panel-21 failed: content policy violation')), {code: 'content_policy', retryable: false, safeToResubmit: false})
  assert.deepEqual(classifyStoryboardImageFailure(new Error('POST /images fetch failed: socket hang up')), {code: 'submission_uncertain', retryable: false, safeToResubmit: false})
  assert.deepEqual(classifyStoryboardImageFailure(new Error('panel-21 failed: invalid aspect ratio')), {code: 'validation', retryable: false, safeToResubmit: false})
})

test('risk tags compile to non-graphic constraints without deleting narrative causality', () => {
  const constraint = buildNonGraphicConstraint(['covered_aftermath', 'weapon_contact', 'minor_hardship'])
  assert.match(constraint, /fully covered/i)
  assert.match(constraint, /cause and effect/i)
  assert.match(constraint, /respectfully/i)
  assert.match(constraint, /no blood/i)
})
