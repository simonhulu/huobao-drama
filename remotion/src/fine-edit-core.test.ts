import test from 'node:test';
import assert from 'node:assert/strict';
import {fineCameraAt, fineEffectState, projectFineEffect, validateFineEditProps, type FineEditProps, type FineEffect} from './fine-edit-core';
const effect: FineEffect = {id: 'ring', kind: 'ring', space: 'image', x: 0.3, y: 0.2, width: 0.2, height: 0.2, startFrame: 10, endFrame: 60};
const props: FineEditProps = {width: 1920, height: 1080, fps: 30, durationInFrames: 90, shotDurationInFrames: 301, shotFrameOffset: 60,
  camera: {mode: 'push', focusX: 0.6, focusY: 0.4, amount: 0.08}, effects: [effect]};
test('clip windows cannot leak effects or restart drawing', () => {
  assert.equal(fineEffectState(effect, 9, 30).active, false);
  assert.equal(fineEffectState(effect, 10, 30).active, true);
  assert.equal(fineEffectState(effect, 10, 30).opacity, 0);
  assert.equal(fineEffectState(effect, 30, 30).draw, 1);
  assert.equal(fineEffectState(effect, 50, 30).draw, 1);
  assert.equal(fineEffectState(effect, 59, 30).opacity, 0);
  assert.equal(fineEffectState(effect, 60, 30).active, false);
});
test('camera holds at shot ends and reaches exact eased midpoint', () => {
  assert.equal(fineCameraAt(props.camera, 0, 301).zoom, 1);
  assert.equal(fineCameraAt(props.camera, 45, 301).zoom, 1);
  assert.equal(fineCameraAt(props.camera, 150, 301).zoom, 1.04);
  assert.equal(fineCameraAt(props.camera, 255, 301).zoom, 1.08);
  assert.equal(fineCameraAt(props.camera, 300, 301).zoom, 1.08);
  assert.equal(fineCameraAt({...props.camera, mode: 'pull'}, 0, 301).zoom, 1.08);
  assert.equal(fineCameraAt({...props.camera, mode: 'pull'}, 300, 301).zoom, 1);
  assert.equal(fineCameraAt({...props.camera, mode: 'hold'}, 150, 301).zoom, 1);
});
test('image projection matches CSS scale around focus; screen space stays fixed', () => {
  const camera = {zoom: 1.2, focusX: 0.5, focusY: 0.5};
  const projected = projectFineEffect(effect, camera);
  assert.ok(Math.abs(projected.x - 0.26) < 1e-12);
  assert.ok(Math.abs(projected.y - 0.14) < 1e-12);
  assert.equal(projected.width, 0.24);
  assert.deepEqual(projectFineEffect({...effect, space: 'screen'}, camera), {x: 0.3, y: 0.2, width: 0.2, height: 0.2});
  assert.notEqual(fineCameraAt(props.camera, 0 + props.shotFrameOffset, 301).zoom, fineCameraAt(props.camera, 0, 301).zoom);
});
test('pan direction and focus clipping are deterministic', () => {
  const right = {...props.camera, mode: 'pan-right' as const};
  assert.ok(fineCameraAt(right, 0, 301).focusX < fineCameraAt(right, 300, 301).focusX);
  const left = {...right, mode: 'pan-left' as const};
  assert.ok(fineCameraAt(left, 0, 301).focusX > fineCameraAt(left, 300, 301).focusX);
  assert.equal(fineCameraAt({...right, focusX: 1}, 300, 301).focusX, 1);
});
test('invalid contracts fail before rendering and valid marks/text pass', () => {
  assert.doesNotThrow(() => validateFineEditProps(props));
  for (const invalid of [
    {...props, shotFrameOffset: 250}, {...props, effects: [effect, effect]},
    {...props, effects: [{...effect, endFrame: 91}]},
    {...props, effects: [{...effect, y: 0.8}]},
    {...props, effects: [{...effect, kind: 'emphasis', text: ''}]},
    {...props, effects: [{...effect, kind: 'sparkle'}]},
    {...props, camera: {...props.camera, amount: NaN}},
  ]) assert.throws(() => validateFineEditProps(invalid as FineEditProps));
  assert.doesNotThrow(() => validateFineEditProps({...props, effects: [{...effect, kind: 'emphasis', text: '十五天'}]}));
});
