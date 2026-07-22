import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeterministicAuthoringResult,
  validateAuthoringTrace,
} from '../../scripts/lib/authoring/deterministic-planner.mjs';

const semanticOutline = {
  durationInFrames: 90,
  fps: 30,
  semanticUnits: [{
    assetId: 'asset-yahoo',
    endFrame: 90,
    grammarRuleIds: ['default-establishing'],
    narrativeRole: 'establishing',
    semanticUnitId: 'unit-1',
    startFrame: 0,
    subjectId: 'entity-yahoo',
  }],
};
const assetInventory = {assets: [{assetId: 'asset-yahoo'}]};
const grammar = {rules: [{
  allowedCameras: ['hold'],
  allowedTransitions: ['hard_cut'],
  defaults: {camera: 'hold', transition: 'hard_cut'},
  grammarRuleId: 'default-establishing',
}]};

test('deterministic planner emits only traceable conservative defaults', () => {
  const result = buildDeterministicAuthoringResult({assetInventory, grammar, semanticOutline});
  assert.equal(result.recipeCandidate.schemaVersion, 'magnates-remotion-recipe-v2');
  assert.equal(result.recipeCandidate.shots[0].camera.preset, 'hold');
  assert.equal(result.recipeCandidate.shots[0].background.assetId, 'asset-yahoo');
  assert.ok(Object.keys(result.traceByNodeId).every((key) => key.startsWith('shot:shot:unit-1')));
  assert.doesNotThrow(() => validateAuthoringTrace({
    assetInventory,
    authoringResult: result,
    grammar,
    semanticOutline,
  }));
});

test('deterministic planner stops when a conservative treatment or identity is unavailable', () => {
  assert.throws(
    () => buildDeterministicAuthoringResult({
      assetInventory,
      grammar: {rules: [{...grammar.rules[0], allowedCameras: ['whip'], defaults: {camera: 'whip'}}]},
      semanticOutline,
    }),
    (error) => error.code === 'DETERMINISTIC_PLAN_NEEDS_REVIEW',
  );
  assert.throws(
    () => buildDeterministicAuthoringResult({
      assetInventory,
      grammar: {rules: [{
        ...grammar.rules[0],
        allowedTransitions: ['fade'],
        defaults: {camera: 'hold', transition: 'fade'},
      }]},
      semanticOutline: {
        ...semanticOutline,
        semanticUnits: [
          {...semanticOutline.semanticUnits[0], endFrame: 45},
          {...semanticOutline.semanticUnits[0], semanticUnitId: 'unit-2', startFrame: 45},
        ],
      },
    }),
    (error) => error.code === 'DETERMINISTIC_PLAN_NEEDS_REVIEW',
  );
  assert.throws(
    () => buildDeterministicAuthoringResult({
      assetInventory: {assets: []},
      grammar,
      semanticOutline,
    }),
    (error) => error.code === 'DETERMINISTIC_PLAN_NEEDS_REVIEW',
  );
});

test('authoring trace fails closed when a render-affecting node is untraced', () => {
  const result = buildDeterministicAuthoringResult({assetInventory, grammar, semanticOutline});
  delete result.traceByNodeId['shot:shot:unit-1:camera'];
  assert.throws(
    () => validateAuthoringTrace({assetInventory, authoringResult: result, grammar, semanticOutline}),
    (error) => error.code === 'AUTHORING_TRACE_INCOMPLETE' &&
      error.missingNodeIds.includes('shot:shot:unit-1:camera'),
  );
});
