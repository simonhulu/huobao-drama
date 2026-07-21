import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDeterministicMotionPlan,
  buildPreferredStoryboardMotionPlan,
  buildStoryboardMotionPlan,
  parseMovement,
  parseTimedVisualBeats,
  splitNarrativeBeats,
} from './motion.js'

test('parseMovement returns null for empty input', () => {
  assert.equal(parseMovement(''), null)
  assert.equal(parseMovement(null), null)
  assert.equal(parseMovement(undefined), null)
})

test('parseMovement detects zoom in on face', () => {
  const plan = parseMovement('缓慢推近到女主角面部')
  assert.ok(plan)
  assert.equal(plan!.kind, 'kenburns')
  assert.ok(plan!.keyframes[0].zoom < plan!.keyframes[1].zoom)
  assert.ok(plan!.keyframes[1].zoom > 1)
})

test('parseMovement detects zoom out', () => {
  const plan = parseMovement('从面部特写拉远到全景')
  assert.ok(plan)
  assert.equal(plan!.kind, 'kenburns')
  assert.ok(plan!.keyframes[0].zoom > plan!.keyframes[1].zoom)
})

test('parseMovement detects pan right', () => {
  const plan = parseMovement('镜头缓慢向右平移')
  assert.ok(plan)
  assert.equal(plan!.kind, 'pan')
  assert.ok(plan!.keyframes[0].focusX < plan!.keyframes[1].focusX)
})

test('parseMovement detects pan down', () => {
  const plan = parseMovement('缓慢下移展示地面')
  assert.ok(plan)
  assert.equal(plan!.kind, 'pan')
  assert.ok(plan!.keyframes[0].focusY < plan!.keyframes[1].focusY)
})

test('parseMovement supports multi-segment movement', () => {
  const plan = parseMovement('先推近脸部，再横摇到窗外')
  assert.ok(plan)
  assert.equal(plan!.kind, 'keyframes')
  assert.ok(plan!.keyframes.length >= 3)
})

test('parseMovement supports English descriptions', () => {
  const plan = parseMovement('slow zoom in on face')
  assert.ok(plan)
  assert.equal(plan!.kind, 'kenburns')
  assert.ok(plan!.keyframes[1].zoom > 1)
})

test('buildDeterministicMotionPlan is stable and varied', () => {
  const a = buildDeterministicMotionPlan(1)
  const b = buildDeterministicMotionPlan(2)
  assert.notDeepEqual(a.keyframes, b.keyframes)
  const again = buildDeterministicMotionPlan(1)
  assert.deepEqual(a.keyframes, again.keyframes)
})

test('parseTimedVisualBeats parses storyboard video prompt timing', () => {
  const beats = parseTimedVisualBeats(
    '0-3秒：远景，风暴云层聚集。3-6秒：镜头推近风柱。6-9秒：画面定格。',
  )

  assert.deepEqual(beats, [
    { start: 0, end: 3, text: '远景，风暴云层聚集。' },
    { start: 3, end: 6, text: '镜头推近风柱。' },
    { start: 6, end: 9, text: '画面定格。' },
  ])
})

test('splitNarrativeBeats keeps sentence-level story beats', () => {
  assert.deepEqual(
    splitNarrativeBeats('第一句说明背景。第二句制造悬念！第三句落到结论。'),
    ['第一句说明背景。', '第二句制造悬念！', '第三句落到结论。'],
  )
})

test('buildStoryboardMotionPlan creates beat-aware keyframes', () => {
  const plan = buildStoryboardMotionPlan({
    seed: 3670,
    duration: 9,
    narration: '最近台风和龙卷风又上了热门。很多人以为这是现代才有的事。',
    videoPrompt: '0-3秒：远景，卫星云图旋转。3-6秒：镜头快速切换灾情。6-9秒：画面定格。',
  })

  assert.ok(plan)
  assert.ok(plan!.keyframes.length >= 6)
  assert.ok(plan!.keyframes.some((keyframe) => keyframe.t === 1 / 3 && keyframe.transition === 'cut'))
  assert.ok(plan!.keyframes.some((keyframe) => keyframe.t === 2 / 3))
  assert.ok(plan!.keyframes.some((keyframe) => keyframe.easing === 'ease-in-out'))
  assert.ok(plan!.keyframes.some((keyframe) => keyframe.focusX !== plan!.keyframes[0].focusX || keyframe.zoom !== plan!.keyframes[0].zoom))
  const cutFrame = plan!.keyframes.find((keyframe) => keyframe.transition === 'cut')
  assert.ok(cutFrame && cutFrame.zoom >= 1.7)
  const holdStart = plan!.keyframes.find((keyframe) => keyframe.t > 2 / 3 && keyframe.t < 0.8)
  assert.ok(holdStart)
  assert.notEqual(`${holdStart!.focusX}:${holdStart!.focusY}:${holdStart!.zoom}`, `${cutFrame!.focusX}:${cutFrame!.focusY}:${cutFrame!.zoom}`)
})

test('buildStoryboardMotionPlan returns null without enough visual text', () => {
  assert.equal(buildStoryboardMotionPlan({ duration: 6, narration: '一句话。' }), null)
  assert.equal(buildStoryboardMotionPlan({ duration: 6 }), null)
})

test('buildPreferredStoryboardMotionPlan prefers timed beats over a broad movement', () => {
  const plan = buildPreferredStoryboardMotionPlan({
    seed: 3670,
    movement: '缓慢推近',
    duration: 9,
    narration: '最近台风和龙卷风又上了热门。很多人以为这是现代才有的事。',
    videoPrompt: '0-3秒：远景，卫星云图旋转。3-6秒：镜头快速切换灾情。6-9秒：画面定格。',
  })

  assert.ok(plan.keyframes.some((keyframe) => keyframe.t === 1 / 3 && keyframe.transition === 'cut'))
})

test('buildPreferredStoryboardMotionPlan keeps explicit movement without timed beats', () => {
  const plan = buildPreferredStoryboardMotionPlan({
    seed: 3670,
    movement: '缓慢推近',
    duration: 9,
    narration: '一句没有拆分的旁白',
  })

  assert.equal(plan.kind, 'kenburns')
  assert.equal(plan.keyframes.length, 2)
})

test('buildStoryboardMotionPlan supports hold beats and hard cuts', () => {
  const plan = buildStoryboardMotionPlan({
    seed: 3670,
    duration: 9,
    narration: '先交代背景，再揭示线索，最后停下来。',
    videoPrompt: '0-3秒：环境全景。3-6秒：快速切换到关键线索。6-9秒：画面定格。',
  })

  assert.ok(plan)
  assert.equal(plan!.keyframes.at(-1)?.transition, undefined)
  assert.equal(plan!.keyframes.at(-1)?.focusX, plan!.keyframes.at(-2)?.focusX)
  assert.equal(plan!.keyframes.at(-1)?.focusY, plan!.keyframes.at(-2)?.focusY)
  assert.equal(plan!.keyframes.at(-1)?.zoom, plan!.keyframes.at(-2)?.zoom)
  assert.equal(plan!.keyframes[2].transition, 'cut')
})

test('buildStoryboardMotionPlan marks real flash and dip-black transitions', () => {
  const plan = buildStoryboardMotionPlan({
    seed: 3670,
    duration: 9,
    narration: '先建立空间，再闪白切换，最后暗下。',
    videoPrompt: '0-3秒：环境全景。3-6秒：闪白切换到灾情。6-9秒：画面暗下进入下一镜。',
  })

  assert.ok(plan)
  assert.equal(plan!.keyframes.find((keyframe) => keyframe.t === 1 / 3)?.transition, 'flash')
  assert.equal(plan!.keyframes.at(-1)?.transition, 'dip-black')
})

test('buildStoryboardMotionPlan compresses timed beats for very short shots', () => {
  const plan = buildStoryboardMotionPlan({
    seed: 3814,
    duration: 2.044,
    narration: '这个人就是洪秀全。',
    videoPrompt: '0-3秒：背影抬头。3-6秒：转身面对镜头。6-9秒：人物特写定格。',
  })

  assert.ok(plan)
  assert.ok(plan!.keyframes.every((keyframe) => keyframe.t >= 0 && keyframe.t <= 1))
  assert.ok(plan!.keyframes.some((keyframe) => keyframe.t === 2 / 3))
})

test('buildStoryboardMotionPlan turns explicit impact imagery into a short flash', () => {
  const plan = buildStoryboardMotionPlan({
    seed: 3800,
    duration: 9,
    narration: '地道爆破城墙。',
    videoPrompt: '0-3秒：士兵挖掘地道。3-6秒：炮口火光与火花四溅。6-9秒：城墙轰然崩塌。',
  })

  assert.ok(plan)
  assert.equal(plan!.keyframes.find((keyframe) => keyframe.t === 1 / 3)?.transition, 'flash')
  assert.equal(plan!.keyframes.find((keyframe) => keyframe.t === 2 / 3)?.transition, 'flash')
})

test('buildStoryboardMotionPlan keeps text-bearing reveals inside a readable safe frame', () => {
  const plan = buildStoryboardMotionPlan({
    seed: 3822,
    duration: 11.8,
    narration: '气数已尽四个字，与其说是迷信，不如说是一个王朝亮起红灯后的解释。',
    videoPrompt: '0-3秒：古老匾额在昏暗中若隐若现，气数已尽四字模糊。3-6秒：金色光线渐亮，四个字逐渐清晰。6-9秒：四字清晰定格。',
  })

  assert.ok(plan)
  assert.ok(plan!.keyframes.every((keyframe) => keyframe.zoom <= 1.28))
  assert.ok(plan!.keyframes.every((keyframe) => keyframe.focusX >= 0.38 && keyframe.focusX <= 0.62))
})

test('buildStoryboardMotionPlan keeps split-screen subjects away from the crop edge', () => {
  const plan = buildStoryboardMotionPlan({
    seed: 3795,
    duration: 18,
    narration: '康熙和雍正分别推行不同政策。',
    videoPrompt: '0-3秒：左侧康熙批阅奏折。3-6秒：右侧雍正伏案疾书。6-9秒：两幅画面逐渐融合。',
  })

  assert.ok(plan)
  assert.ok(plan!.keyframes.every((keyframe) => keyframe.zoom <= 1.3))
  assert.ok(plan!.keyframes.every((keyframe) => keyframe.focusX >= 0.2 && keyframe.focusX <= 0.8))
})
