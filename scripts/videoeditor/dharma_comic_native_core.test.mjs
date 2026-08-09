import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  NATIVE_RENDERER_VERSION,
  PROGRESSIVE_LAYOUTS,
  TRANSITION_FRAMES,
  activeRectForIndex,
  assertContinuousIntervals,
  balancedChineseLines,
  bubbleAnchor,
  buildIntervals,
  coverCrop,
  cubicInOut,
  emphasisTextPlan,
  handwritePosePlan,
  layoutAtTransitionFrame,
  motionFilter,
  motionOffsetAtFrame,
  rectToPixels,
  subtitleTextPlan,
} from './dharma_comic_native_core.mjs'

test('native text renderer version is pinned to the emphasis-capable contract', () => {
  assert.equal(NATIVE_RENDERER_VERSION, 'native-comic-v12')
})

test('emphasis typography has a distinct hierarchy and restrained frame motion', () => {
  const theme = emphasisTextPlan({ kind: 'theme', text: '缘起性空' })
  const scripture = emphasisTextPlan({ kind: 'scripture', text: '色即是空，空即是色' })
  const explanation = emphasisTextPlan({ kind: 'explanation', text: '所谓放下，是不再抓住' })

  // dharma-text-v4：theme 金句改 Ma Shan Zheng 毛笔体（Handwrite 定格 pose 入场）。
  assert.equal(theme.fontSize, 84)
  assert.equal(theme.fontFamily, 'hand')
  assert.equal(theme.staggerFrames, 2)
  assert.equal(theme.risePx, 10)
  assert.equal(scripture.fontSize, 58)
  assert.equal(scripture.sourceFontSize, 24)
  assert.equal(scripture.lines.length, 2)
  assert.equal(explanation.fontFamily, 'sans')
  assert.equal(explanation.fontSize, 64)
  assert.equal(theme.entryFrames, 4)
  assert.equal(scripture.entryFrames, 4)
  assert.equal(explanation.entryFrames, 4)
  assert.equal(theme.exitFrames, 6)
  assert.equal(scripture.exitFrames, 6)
  assert.equal(explanation.exitFrames, 6)
})

test('handwrite pose plan caps the glyph-reveal entry at one second', () => {
  assert.deepEqual(handwritePosePlan(4), { counts: [2, 3, 4], poseFrames: 3 })
  assert.deepEqual(handwritePosePlan(1), { counts: [1], poseFrames: 3 })
  assert.deepEqual(handwritePosePlan(2), { counts: [1, 2], poseFrames: 3 })
  assert.deepEqual(handwritePosePlan(8).counts, [2, 3, 4, 5, 6, 7, 8])
  const long = handwritePosePlan(16)
  assert.equal(long.counts.at(-1), 16)
  assert.ok(long.counts.length * long.poseFrames <= 30, 'entry stays within one second')
  assert.ok(long.poseFrames >= 1)
})

test('Chinese emphasis wrapping is balanced and does not orphan closing punctuation', () => {
  assert.deepEqual(balancedChineseLines('缘起性空', 8, 2), ['缘起性空'])
  const lines = balancedChineseLines('一切有为法，如梦幻泡影，如露亦如电', 8, 3)
  assert.equal(lines.join(''), '一切有为法，如梦幻泡影，如露亦如电')
  assert.ok(lines.every((line) => !/^[，。！？；：、]/u.test(line)))
  assert.ok(lines.every((line) => [...line].length <= 8))
})

test('ordinary subtitles stay prominent and wrap long Chinese text deterministically', () => {
  assert.deepEqual(subtitleTextPlan('先别急着回答。'), {
    lines: ['先别急着回答。'],
    fontSize: 44,
  })
  const long = subtitleTextPlan('你现在最放不下的，究竟是那个人，还是那段没有得到回应的自己？')
  assert.equal(long.lines.length, 2)
  assert.equal(long.lines.join(''), '你现在最放不下的，究竟是那个人，还是那段没有得到回应的自己？')
  assert.ok(long.lines.every((line) => !/^[，。！？；：、]/u.test(line)))
  assert.equal(long.fontSize, 40)
  assert.ok(long.lines.every((line) => [...line].length <= 18))
})

test('cubic transition reaches the exact Remotion layout endpoints', () => {
  assert.equal(cubicInOut(0), 0)
  assert.equal(cubicInOut(0.5), 0.5)
  assert.equal(cubicInOut(1), 1)
  assert.deepEqual(layoutAtTransitionFrame(3, 0), PROGRESSIVE_LAYOUTS[2])
  assert.deepEqual(layoutAtTransitionFrame(3, TRANSITION_FRAMES), PROGRESSIVE_LAYOUTS[3])
})

test('pixel layout keeps the progressive five page full-screen', () => {
  const finalLayout = PROGRESSIVE_LAYOUTS[4].map(rectToPixels)
  assert.deepEqual(finalLayout[4], { x: 513, y: 0, width: 767, height: 720 })
  assert.equal(finalLayout[0].x, 0)
  assert.equal(finalLayout[2].y, 361)
})

test('focus crop and bubble coordinates stay relative to the active panel', () => {
  assert.deepEqual(coverCrop(1280, 720, 512, 720, 75, 50), {
    width: 1280,
    height: 720,
    left: 704,
    top: 0,
  })
  assert.deepEqual(bubbleAnchor(activeRectForIndex(1), { x: 18, y: 14 }), {
    x: 651,
    y: 101,
    clip: { x: 513, y: 0, width: 767, height: 720 },
  })
})

test('episode 735 plan covers every frame and preserves page boundaries', () => {
  const props = JSON.parse(readFileSync('data/temp/dharma-comic-ep735-1789s-12217961eb.props.json', 'utf8'))
  const full = buildIntervals(props)
  assert.equal(full.length, 160)
  assertContinuousIntervals(full, 53667)
  assert.equal(full.filter((item) => item.hasLayoutTransition).length, 128)
  assert.equal(full.filter((item) => item.pageDipIn).length, 31)
  assert.equal(full.filter((item) => item.pageDipOut).length, 31)

  const smoke = buildIntervals(props, 60)
  assert.equal(smoke.length, 6)
  assertContinuousIntervals(smoke, 1800)
  assert.equal(smoke[5].pageDipIn, true)
})

test('Ken Burns uses continuous subpixel offsets instead of integer crop plateaus', () => {
  const offsets = Array.from({ length: 300 }, (_, frame) => motionOffsetAtFrame(0, 300, frame))
  const deltas = offsets.slice(1).map((offset, index) => offset - offsets[index])
  assert.ok(deltas.every((delta) => delta < 0 && Math.abs(delta) < 0.1))
  assert.equal(new Set(offsets.map((offset) => offset.toFixed(6))).size, 300)

  const reverse = Array.from({ length: 300 }, (_, frame) => motionOffsetAtFrame(1, 300, frame))
  assert.ok(reverse.slice(1).every((offset, index) => offset > reverse[index]))
})

test('Ken Burns production filter evaluates a linear subpixel transform on every frame', () => {
  assert.match(motionFilter('legacy-crop', 0, 300), /^\[base\]crop=/)
  assert.match(motionFilter('perspective-linear', 0, 300), /interpolation=linear/)
  assert.match(motionFilter('perspective-linear', 0, 300), /eval=frame/)
  assert.match(motionFilter('perspective-linear', 0, 300), /-20\*in\/299/)
  assert.match(motionFilter('perspective-linear', 1, 300), /-20\*\(1-in\/299\)/)
})

test('narrative-push keeps one push direction and a time-based velocity across intervals', () => {
  const first = motionFilter('narrative-push', 0, 300, 'base', 'moved', { center: { x: 640, y: 360 } })
  const second = motionFilter('narrative-push', 1, 300, 'base', 'moved', { center: { x: 640, y: 360 } })
  assert.equal(first, second)
  assert.match(first, /perspective=/)
  assert.match(first, /interpolation=linear/)
  assert.match(first, /eval=frame/)
  assert.match(first, /\(1\+0\.000266667\*in\)/)
  assert.match(first, /-0\.050000\*in/)
  assert.match(first, /crop=1280:720:x=0:y=6/)
})

test('narrative-push zooms toward the narrated panel center', () => {
  const filter = motionFilter('narrative-push', 2, 90, '0:v', 'v', { center: { x: 884, y: 360 } })
  assert.match(filter, /^\[0:v\]perspective=/)
  assert.match(filter, /x0='884-884\*/)
  assert.match(filter, /y0='366-366\*/)
  assert.match(filter, /\[v\]$/)
  const fallback = motionFilter('narrative-push', 0, 90)
  assert.match(fallback, /x0='640-640\*/)
})
