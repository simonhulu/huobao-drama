import assert from 'node:assert/strict'
import test from 'node:test'
import {
  areStoryboardNumbersContiguous,
  fitShotFramesToBudget,
  normalizeGridVideo,
  resolveStoryboardNarration,
} from './grid-story-props.js'

test('fitShotFramesToBudget stops at the last complete shot inside the budget', () => {
  assert.deepEqual(fitShotFramesToBudget([24 * 30, 9 * 30, 22 * 30], 30), [24 * 30])
})

test('fitShotFramesToBudget never clips narration in the final included shot', () => {
  assert.deepEqual(fitShotFramesToBudget([155, 172, 172], 15), [155, 172])
})

test('fitShotFramesToBudget leaves an uncapped render unchanged', () => {
  assert.deepEqual(fitShotFramesToBudget([720, 270], undefined), [720, 270])
})

test('resolveStoryboardNarration prefers exact narration over stale visual description', () => {
  assert.equal(resolveStoryboardNarration({
    narration: '他的真名叫威廉·洛克菲勒。',
    description: '妻子主持了葬礼。他的真名叫威廉·洛克菲勒。',
  }), '他的真名叫威廉·洛克菲勒。')
})

test('sparse storyboard selections are detected before rendering', () => {
  assert.equal(areStoryboardNumbersContiguous([1, 2, 3]), true)
  assert.equal(areStoryboardNumbersContiguous([3, 2, 2, 1]), true)
  assert.equal(areStoryboardNumbersContiguous([1, 5, 6]), false)
})

test('stock cutaways are converted to bounded frame windows', () => {
  assert.deepEqual(normalizeGridVideo({
    src: 'static/remotion/stock/pexels-28043983.mp4',
    mode: 'cutaway',
    startSec: 0.6,
    durationSec: 2.1,
    sourceStartSec: 5.2,
    scale: 1.25,
    focusX: 35,
    focusY: 50,
    grade: 'documentary_muted',
    transitionFrames: 6,
  }, 191), {
    src: 'static/remotion/stock/pexels-28043983.mp4',
    mode: 'cutaway',
    startFrame: 18,
    durationInFrames: 63,
    sourceStartFrame: 156,
    scale: 1.25,
    focusX: 35,
    focusY: 50,
    grade: 'documentary_muted',
    transitionFrames: 6,
  })
})

test('stock cutaways cannot run past the narration shot', () => {
  const normalized = normalizeGridVideo({
    src: 'static/remotion/stock/pixabay-33.mp4',
    mode: 'cutaway',
    startSec: 9,
    durationSec: 8,
    scale: 4,
    focusX: -20,
  }, 120)

  assert.equal(normalized?.startFrame, 119)
  assert.equal(normalized?.durationInFrames, 1)
  assert.equal(normalized?.scale, 1.8)
  assert.equal(normalized?.focusX, 0)
})
