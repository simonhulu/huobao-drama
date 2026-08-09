import assert from 'node:assert/strict';
import test from 'node:test';

import {buildDeterministicAuthoringResult} from '../../scripts/lib/authoring/deterministic-planner.mjs';

const inventory = {assets: [{assetId: 'visual-1'}, {assetId: 'visual-2'}]};

test('explicit editorial hints override keyword guessing and reach camera/text recipe nodes', () => {
  const result = buildDeterministicAuthoringResult({
    assetInventory: inventory,
    grammar: {rules: [
      {allowedCameras: ['push_in'], allowedTransitions: ['hard_cut'], defaults: {camera: {preset: 'push_in'}, transition: {class: 'hard_cut'}}, grammarRuleId: 'default-mechanism'},
      {allowedCameras: ['pan_right'], allowedTransitions: ['distortion'], defaults: {camera: {preset: 'pan_right'}, transition: {class: 'distortion', frames: 12}}, grammarRuleId: 'default-reversal-1'},
    ]},
    semanticOutline: {
      durationInFrames: 60,
      fps: 30,
      semanticUnits: [
        {assetId: 'visual-1', endFrame: 30, grammarRuleIds: ['default-mechanism'], narrativeRole: 'mechanism', semanticUnitId: 'unit-1', startFrame: 0, subjectId: 'visual-1', text: '为什么要杀人？', editorialHint: {role: 'mechanism', focus: {x: 0.21, y: 0.64}, typographyVariant: 'whisper', transitionEnergy: 'low'}},
        {assetId: 'visual-2', endFrame: 60, grammarRuleIds: ['default-reversal-1'], narrativeRole: 'reversal', semanticUnitId: 'unit-2', startFrame: 30, subjectId: 'visual-2', text: '平静叙述', editorialHint: {role: 'reversal', emphasis: 0.95, focus: {x: 0.78, y: 0.34}, typographyVariant: 'stamp', transitionEnergy: 'high'}},
      ],
    },
  });
  const [first, second] = result.recipeCandidate.shots;
  assert.equal(first.semanticRole, 'mechanism');
  assert.deepEqual(first.camera.focus, {x: 0.21, y: 0.64});
  assert.equal(first.texts[0].variant, 'whisper');
  assert.equal(second.semanticRole, 'reversal');
  assert.deepEqual(second.camera.focus, {x: 0.78, y: 0.34});
  assert.equal(second.texts[0].variant, 'stamp');
});

