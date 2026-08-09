import assert from 'node:assert/strict';
import test from 'node:test';

import {
  budgetTransition,
  isHighEnergyTransition,
  selectEditorialTreatment,
} from '../../scripts/lib/authoring/effect-budget.mjs';

test('focus movement selects a directional camera and transition bridge', () => {
  const rightward = selectEditorialTreatment({
    role: 'mechanism',
    emphasis: 0.6,
    currentFocus: {x: 0.2, y: 0.5},
    nextFocus: {x: 0.8, y: 0.52},
    scaleDelta: 0,
  });
  const leftward = selectEditorialTreatment({
    role: 'mechanism',
    emphasis: 0.6,
    currentFocus: {x: 0.8, y: 0.5},
    nextFocus: {x: 0.2, y: 0.48},
    scaleDelta: 0,
  });

  assert.equal(rightward.camera.preset, 'pan_right');
  assert.equal(rightward.transition.class, 'directional_blur');
  assert.equal(leftward.camera.preset, 'pan_left');
  assert.equal(leftward.transition.class, 'directional_blur');
});

test('scale change selects a matching push or pull camera and zoom bridge', () => {
  const tighter = selectEditorialTreatment({
    role: 'mechanism',
    emphasis: 0.7,
    scaleDelta: 0.16,
  });
  const wider = selectEditorialTreatment({
    role: 'mechanism',
    emphasis: 0.7,
    scaleDelta: -0.16,
  });

  assert.equal(tighter.camera.preset, 'push_in');
  assert.equal(tighter.transition.class, 'zoom_blur');
  assert.equal(wider.camera.preset, 'pull_out');
  assert.equal(wider.transition.class, 'zoom_blur');
});

test('recent history cools down repeated camera and transition choices', () => {
  const result = selectEditorialTreatment({
    role: 'mechanism',
    emphasis: 0.6,
    currentFocus: {x: 0.2, y: 0.5},
    nextFocus: {x: 0.8, y: 0.5},
    scaleDelta: 0,
    recent: {
      cameras: ['pan_right', 'pan_right'],
      transitions: ['directional_blur'],
    },
  });

  assert.equal(result.camera.preset, 'hold');
  assert.equal(result.transition.class, 'blur_bridge');
});

test('protected crisis and reversal beats retain their semantic high-energy treatment', () => {
  const recent = {
    cameras: ['push_in', 'push_in'],
    transitions: ['film_burn', 'zoom_blur'],
  };
  const crisis = selectEditorialTreatment({
    role: 'crisis',
    emphasis: 0.92,
    scaleDelta: 0,
    recent,
  });
  const reversal = selectEditorialTreatment({
    role: 'reversal',
    emphasis: 0.9,
    scaleDelta: 0,
    recent,
  });

  assert.equal(crisis.transition.class, 'zoom_blur');
  assert.equal(reversal.transition.class, 'ink_bleed');
  assert.notEqual(crisis.camera.preset, 'whip');
  assert.notEqual(reversal.camera.preset, 'whip');
});

test('protected beats still follow a meaningful focus handoff and cool repeated cameras', () => {
  const result = selectEditorialTreatment({
    role: 'crisis',
    emphasis: 0.94,
    currentFocus: {x: 0.18, y: 0.5},
    nextFocus: {x: 0.82, y: 0.5},
    recent: {cameras: ['pan_right', 'pan_right'], transitions: []},
  });

  assert.equal(result.camera.preset, 'hold');
  assert.equal(result.transition.class, 'directional_blur');
});

test('effect budget inserts a cooldown after a high-energy cluster', () => {
  const recent = ['distortion', 'matte_transition'];
  const result = budgetTransition({role: 'mechanism', emphasis: 0.6, requested: {class: 'distortion', frames: 20}, recent});
  assert.equal(result.class, 'blur_bridge');
  assert.equal(isHighEnergyTransition(result.class), false);
});

test('crisis and reversal beats may retain a high-energy transition', () => {
  const result = budgetTransition({role: 'crisis', emphasis: 0.9, requested: {class: 'distortion', frames: 20}, recent: ['distortion', 'matte_transition']});
  assert.equal(result.class, 'distortion');
});
