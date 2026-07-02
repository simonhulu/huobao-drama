import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMovement, buildDeterministicMotionPlan } from './motion.js'

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
