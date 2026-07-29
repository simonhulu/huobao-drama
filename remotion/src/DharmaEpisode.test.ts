import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDharmaBgmLoopStarts,
  dharmaTreatmentOverlayStyle,
  narrationPresence,
  resolveDharmaImageTransform,
  resolveDharmaNarrativeDipOpacity,
  resolveDharmaSegmentOpacity,
  resolveDharmaNarrationDurationInFrames,
  resolveDharmaOpeningInvocation,
  sacredPhraseFontSize,
  usesDharmaNarrativeDip,
} from './DharmaEpisode.js'

test('Dharma BGM repeats through deliberate overlaps instead of hard source loops', () => {
  assert.deepEqual(buildDharmaBgmLoopStarts(1_000, 400, 60), [0, 340, 680])
})

test('Dharma BGM narration presence eases into and out of speech windows', () => {
  const windows = [{ startFrame: 100, endFrame: 200 }]
  assert.equal(narrationPresence(50, windows), 0)
  assert.equal(narrationPresence(100, windows), 1)
  assert.equal(narrationPresence(200, windows), 1)
  assert.equal(narrationPresence(214, windows), 0)
  assert.ok(narrationPresence(96, windows) > 0)
  assert.ok(narrationPresence(207, windows) > 0)
})

test('Dharma review pilot preserves a complete final sentence and leaves a quiet visual tail', () => {
  assert.equal(resolveDharmaNarrationDurationInFrames(1_800, 1_763), 1_763)
  assert.equal(resolveDharmaNarrationDurationInFrames(1_800), 1_800)
})

test('Dharma opening footage is visible on frame zero while later segments crossfade', () => {
  assert.equal(resolveDharmaSegmentOpacity(0, true, 18), 1)
  assert.equal(resolveDharmaSegmentOpacity(0, false, 24), 0)
  assert.equal(resolveDharmaSegmentOpacity(24, false, 24), 1)
})

test('Dharma narrative illustrations dip through ink instead of overlapping faces', () => {
  const narrative = {
    kind: 'image' as const,
    src: 'narrative.png',
    startFrame: 0,
    durationInFrames: 180,
    shotFunction: 'narrative_illustration' as const,
  }
  const nextNarrative = { ...narrative, src: 'next.png', startFrame: 180 }
  const atmosphere = { ...narrative, src: 'mist.png', shotFunction: 'atmosphere_bridge' as const }
  assert.equal(usesDharmaNarrativeDip(narrative, nextNarrative), true)
  assert.equal(usesDharmaNarrativeDip(atmosphere, { ...atmosphere, src: 'rain.png' }), false)
  assert.equal(resolveDharmaSegmentOpacity(0, false, 0), 1)
  assert.equal(resolveDharmaNarrativeDipOpacity(0), 0)
  assert.ok(resolveDharmaNarrativeDipOpacity(8) > 0.9)
  assert.equal(resolveDharmaNarrativeDipOpacity(16), 0)
})

test('Dharma image motion stays transform-only and hold is actually still', () => {
  assert.equal(resolveDharmaImageTransform('hold', 0), 'scale(1.06)')
  assert.equal(resolveDharmaImageTransform('hold', 1), 'scale(1.06)')
  assert.equal(resolveDharmaImageTransform('push', 0), 'scale(1.06)')
  assert.equal(resolveDharmaImageTransform('push', 1), 'scale(1.18)')
  assert.match(resolveDharmaImageTransform('drift_left', 0.5), /translate3d\(0%/)
})

test('Dharma treatments use cheap CSS overlays without blur or canvas effects', () => {
  for (const treatment of ['ink_wash', 'surreal_dream', 'minimal_light'] as const) {
    const style = dharmaTreatmentOverlayStyle(treatment)
    assert.equal(typeof style.background, 'string')
    assert.doesNotMatch(String(style.background), /blur|url\(/)
  }
})

test('Dharma teaching phrases retain visual priority at 720p', () => {
  assert.equal(sacredPhraseFontSize('亲情中的适度冷酷'), 76)
  assert.equal(sacredPhraseFontSize('应无所住，而生其心'), 76)
  assert.equal(sacredPhraseFontSize('真正的慈悲，是既不控制，也不抛弃'), 66)
  assert.equal(sacredPhraseFontSize('真正的慈悲，是既不控制，也不抛弃，也允许自己有边界'), 56)
  assert.equal(sacredPhraseFontSize('愿你在所有关系里，既有靠近的温度，也有不失自己的边界，还能保持内心的清醒与安宁。'), 46)
})

test('Dharma opening yields to an immediate central quote instead of stacking two headlines', () => {
  const opening = { text: '亲情中的适度冷酷', startFrame: 0, durationInFrames: 90 }
  const quote = { text: '真正的慈悲，也允许边界', startFrame: 30, durationInFrames: 120 }
  assert.equal(resolveDharmaOpeningInvocation(opening, [quote]), undefined)
})

test('Dharma opening trims to the first quote only when it remains readable', () => {
  const opening = { text: '亲情中的适度冷酷', startFrame: 0, durationInFrames: 90 }
  const quote = { text: '真正的慈悲，也允许边界', startFrame: 72, durationInFrames: 120 }
  assert.deepEqual(resolveDharmaOpeningInvocation(opening, [quote]), {
    ...opening,
    durationInFrames: 72,
  })
})

test('Dharma opening remains intact when the quote begins after its invocation window', () => {
  const opening = { text: '亲情中的适度冷酷', startFrame: 0, durationInFrames: 90 }
  const quote = { text: '真正的慈悲，也允许边界', startFrame: 120, durationInFrames: 120 }
  assert.equal(resolveDharmaOpeningInvocation(opening, [quote]), opening)
})
