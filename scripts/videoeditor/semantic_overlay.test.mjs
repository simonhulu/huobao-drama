import test from 'node:test'
import assert from 'node:assert/strict'
import { readAssCues, validateSelection, buildPlan, compositionArgs, planFingerprint, validateRenderedManifest, validateOverlayMedia } from './semantic_overlay.mjs'

const snapshot = { episode: { id: 1 }, sourceUrl: 'local', storyboards: Array.from({ length: 10 }, (_, index) => ({
  id: index + 1, storyboardNumber: index + 1, duration: 5, narration: '先思考，再行动。', firstFrameImage: 'static/test.png',
})) }
const selection = { shots: [{ storyboardNumber: 1, rationale: '空白区域，不遮挡头部。',
  effects: [{ kind: 'thought', start: 0.5, end: 3, trigger: '思考', x: 0.1, y: 0.1, width: 0.2, height: 0.1 }] }] }
const media = { streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }], format: { duration: '50' } }

test('ASS cue parsing preserves comma text and actual subtitle timestamps', () => {
  assert.deepEqual(readAssCues('Dialogue: 0,0:01:02.34,0:01:05.67,Default,,0,0,0,,{\\b1}思考,行动\\N下一句'),
    [{ start: 62.34, end: 65.67, text: '思考,行动\n下一句' }])
  assert.throws(() => readAssCues('Dialogue: 0,invalid,invalid,Default,,0,0,0,,text'), /Invalid ASS/)
})
test('selection rejects subtitle collisions, unknown triggers, timing errors and dense edits', () => {
  assert.equal(validateSelection(snapshot, selection).length, 1)
  const change = (value) => ({ shots: [{ ...selection.shots[0], effects: [{ ...selection.shots[0].effects[0], ...value }] }] })
  assert.throws(() => validateSelection(snapshot, change({ y: 0.85 })), /subtitle safe area/)
  assert.throws(() => validateSelection(snapshot, change({ end: 6 })), /safe window/)
  assert.throws(() => validateSelection(snapshot, change({ trigger: '另一篇稿子' })), /trigger/)
  assert.throws(() => validateSelection(snapshot, { shots: [selection.shots[0], { ...selection.shots[0], storyboardNumber: 2 }] }), /sparse/)
})
test('plan includes every source shot, preserves timing and selects only authored overlays', () => {
  const plan = buildPlan(snapshot, selection, '/test.mp4', 'fingerprint', media)
  assert.equal(plan.shots.length, 10)
  assert.equal(plan.shots[9].timelineStart, 45)
  assert.equal(plan.shots[0].effects[0].startFrame, 15)
  assert.equal(plan.shots[1].effects.length, 0)
  assert.equal(plan.shots[0].beats[0].end, 5)
  assert.throws(() => buildPlan(snapshot, selection, '/test.mp4', 'hash', { ...media, format: { duration: '52' } }), /alignment/)
})
test('finishing pass copies audio, preserves timestamps and disables repeated last overlay frames', () => {
  const plan = buildPlan(snapshot, selection, '/test.mp4', 'hash', media)
  const args = compositionArgs(plan, [{ clip: '/effect.mov', globalStart: 0.5, globalEnd: 3 }], '/new.mp4')
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy')
  assert.equal(args[args.indexOf('-fps_mode') + 1], 'passthrough')
  assert.match(args[args.indexOf('-filter_complex') + 1], /repeatlast=0/)
  assert.doesNotMatch(args.join(' '), /amix|loudnorm|volume=/)
})

test('render approval is bound to the exact current plan and source', () => {
  const plan = buildPlan(snapshot, selection, '/test.mp4', 'hash', media)
  const manifest = { sourceFingerprint: 'hash', planFingerprint: planFingerprint(plan), rendered: [{ storyboardNumber: 1 }] }
  assert.doesNotThrow(() => validateRenderedManifest(plan, manifest))
  assert.throws(() => validateRenderedManifest({ ...plan, shots: plan.shots.map((shot) => ({ ...shot, effects: shot.effects.map((effect) => ({ ...effect, x: 0.2 })) })) }, manifest), /stale/)
  assert.throws(() => validateRenderedManifest(plan, { ...manifest, sourceFingerprint: 'different' }), /stale/)
  assert.throws(() => validateRenderedManifest(plan, { ...manifest, rendered: [] }), /every selected/)
})

test('overlay cache must have complete alpha frames at the required frame rate', () => {
  const clip = { streams: [{ codec_type: 'video', codec_name: 'prores', pix_fmt: 'yuva444p12le', nb_frames: '75', r_frame_rate: '30/1' }] }
  assert.doesNotThrow(() => validateOverlayMedia(clip, 75, 30))
  for (const patch of [{ nb_frames: '5' }, { pix_fmt: 'yuv444p12le' }, { r_frame_rate: '24/1' }, { codec_name: 'h264' }]) {
    assert.throws(() => validateOverlayMedia({ streams: [{ ...clip.streams[0], ...patch }] }, 75, 30), /Invalid overlay/)
  }
})
