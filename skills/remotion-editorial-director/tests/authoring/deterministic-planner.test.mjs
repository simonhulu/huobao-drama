import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeterministicAuthoringResult,
  validateAuthoringTrace,
} from '../../scripts/lib/authoring/deterministic-planner.mjs';
import {buildPlannerInputs} from '../../scripts/director.mjs';

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

test('deterministic planner emits only traceable supported defaults', () => {
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

test('deterministic planner binds narration meaning to visible cues', () => {
  const result = buildDeterministicAuthoringResult({
    assetInventory,
    grammar: {rules: [{
      allowedCameras: ['push_in'],
      allowedTransitions: ['distortion'],
      defaults: {camera: {preset: 'push_in', intensity: 0.8}, transition: {class: 'distortion', frames: 12}},
      grammarRuleId: 'default-crisis',
    }]},
    semanticOutline: {
      durationInFrames: 90,
      fps: 30,
      semanticUnits: [{
        assetId: 'asset-yahoo',
        claimIds: ['claim-1'],
        evidenceClaimIds: ['evidence-1'],
        endFrame: 90,
        grammarRuleIds: ['default-crisis'],
        narrativeRole: 'crisis',
        semanticUnitId: 'unit-crisis',
        startFrame: 0,
        subjectId: 'entity-yahoo',
        text: '客户赖账，货物积压，损失4000美元。',
      }],
    },
  });
  const shot = result.recipeCandidate.shots[0];
  assert.ok(shot.texts.some((cue) => cue.type === 'counter' && cue.to === 4000));
  assert.ok(shot.texts.some((cue) => cue.entry === 'kinetic' && cue.label === '危机'));
  assert.equal(shot.graphics.some((cue) => ['badge', 'monitor'].includes(cue.kind)), false);
  assert.ok(result.traceByNodeId['cue:unit-crisis:metric']);
  assert.ok(result.traceByNodeId['cue:unit-crisis:metric'].sourceNote);
  assert.doesNotThrow(() => validateAuthoringTrace({
    assetInventory,
    authoringResult: result,
    grammar: {rules: [{grammarRuleId: 'default-crisis'}]},
    semanticOutline: {
      durationInFrames: 90,
      semanticUnits: [{semanticUnitId: 'unit-crisis'}],
    },
  }));
});

test('deterministic planner does not animate historical dates as metrics and keeps typography concise', () => {
  const result = buildDeterministicAuthoringResult({
    assetInventory,
    grammar: {rules: [{
      allowedCameras: ['push_in'],
      allowedTransitions: ['hard_cut'],
      defaults: {camera: {preset: 'push_in'}, transition: {class: 'hard_cut'}},
      grammarRuleId: 'default-hook',
    }]},
    semanticOutline: {
      durationInFrames: 90,
      fps: 30,
      semanticUnits: [{
        assetId: 'asset-yahoo',
        endFrame: 90,
        grammarRuleIds: ['default-hook'],
        narrativeRole: 'hook',
        semanticUnitId: 'unit-history-hook',
        startFrame: 0,
        text: '公元前118年，汉武帝带着群臣到甘泉宫打猎。',
      }],
    },
  });
  const texts = result.recipeCandidate.shots[0].texts;
  assert.equal(texts.some((cue) => cue.type === 'counter'), false);
  assert.ok(texts.some((cue) => cue.text === '甘泉宫打猎'));
  assert.ok(texts.every((cue) => !cue.text || [...cue.text].length <= 10));
});

test('deterministic planner does not emit a one-character reversal connector', () => {
  const result = buildDeterministicAuthoringResult({
    assetInventory,
    grammar: {rules: [{
      allowedCameras: ['push_in'],
      allowedTransitions: ['ink_bleed'],
      defaults: {camera: {preset: 'push_in'}, transition: {class: 'ink_bleed'}},
      grammarRuleId: 'default-reversal',
    }]},
    semanticOutline: {
      durationInFrames: 90,
      fps: 30,
      semanticUnits: [{
        assetId: 'asset-yahoo',
        endFrame: 90,
        grammarRuleIds: ['default-reversal'],
        narrativeRole: 'reversal',
        semanticUnitId: 'unit-reversal',
        startFrame: 0,
        text: '汉军其他几路损失惨重，他这八百人却成了整场战役最亮眼的一支部队。',
      }],
    },
  });
  const cue = result.recipeCandidate.shots[0].texts[0];
  assert.ok([...cue.subject].length >= 2);
  assert.notEqual(cue.subject, '却');
});

test('mechanism typography uses the narrated phrase instead of a generic placeholder', () => {
  const result = buildDeterministicAuthoringResult({
    assetInventory,
    grammar: {rules: [{
      allowedCameras: ['hold'],
      allowedTransitions: ['hard_cut'],
      defaults: {camera: {preset: 'hold'}, transition: {class: 'hard_cut'}},
      grammarRuleId: 'default-mechanism',
    }]},
    semanticOutline: {
      durationInFrames: 90,
      fps: 30,
      semanticUnits: [{
        assetId: 'asset-yahoo',
        endFrame: 90,
        grammarRuleIds: ['default-mechanism'],
        narrativeRole: 'mechanism',
        semanticUnitId: 'unit-mechanism',
        startFrame: 0,
        text: '卫青把决定权交还皇帝。',
        editorialHint: {emphasis: 0.8},
      }],
    },
  });
  const cue = result.recipeCandidate.shots[0].texts[0];
  assert.equal(cue.subject, '卫青把决定权交还皇帝');
  assert.notEqual(cue.subject, '关键现场');
});

test('low-emphasis mechanism beats rely on subtitles instead of redundant typography', () => {
  const result = buildDeterministicAuthoringResult({
    assetInventory,
    grammar: {rules: [{
      allowedCameras: ['hold'],
      allowedTransitions: ['hard_cut'],
      defaults: {camera: {preset: 'hold'}, transition: {class: 'hard_cut'}},
      grammarRuleId: 'default-mechanism',
    }]},
    semanticOutline: {
      durationInFrames: 90,
      fps: 30,
      semanticUnits: [{
        assetId: 'asset-yahoo',
        endFrame: 90,
        grammarRuleIds: ['default-mechanism'],
        narrativeRole: 'mechanism',
        semanticUnitId: 'unit-mechanism-low',
        startFrame: 0,
        text: '这是连续解释中的普通信息。',
        editorialHint: {emphasis: 0.62},
      }],
    },
  });
  assert.deepEqual(result.recipeCandidate.shots[0].texts, []);
});

test('deterministic planner stops when a conservative treatment or identity is unavailable', () => {
  assert.throws(
    () => buildDeterministicAuthoringResult({
      assetInventory,
      grammar: {rules: [{...grammar.rules[0], allowedCameras: ['unsupported-camera'], defaults: {camera: 'unsupported-camera'}}]},
      semanticOutline,
    }),
    (error) => error.code === 'DETERMINISTIC_PLAN_NEEDS_REVIEW',
  );
  assert.throws(
    () => buildDeterministicAuthoringResult({
      assetInventory,
      grammar: {rules: [{
        ...grammar.rules[0],
        allowedTransitions: ['unsupported-transition'],
        defaults: {camera: 'hold', transition: 'unsupported-transition'},
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

test('deterministic planner never authors the retired whip camera', () => {
  assert.throws(
    () => buildDeterministicAuthoringResult({
      assetInventory,
      grammar: {rules: [{
        allowedCameras: ['whip'],
        allowedTransitions: ['hard_cut'],
        defaults: {camera: {preset: 'whip'}, transition: {class: 'hard_cut'}},
        grammarRuleId: 'default-reversal',
      }]},
      semanticOutline: {
        ...semanticOutline,
        semanticUnits: [{
          ...semanticOutline.semanticUnits[0],
          grammarRuleIds: ['default-reversal'],
          narrativeRole: 'reversal',
        }],
      },
    }),
    (error) => error.code === 'DETERMINISTIC_PLAN_NEEDS_REVIEW',
  );
});

test('director planner inputs derive treatments from visual continuity instead of shot index', () => {
  const planning = buildPlannerInputs({
    fps: 30,
    inventory: {assets: [{assetId: 'visual-1'}, {assetId: 'visual-2'}, {assetId: 'visual-3'}]},
    outline: {
      claims: [],
      units: [
        {
          assetRequirements: ['visual-1'], claimIds: [], emphasis: 0.6, endSeconds: 1,
          entityIds: [], narrativeRole: 'mechanism', semanticUnitId: 'unit-1', startSeconds: 0,
          text: '向右追踪', editorialHint: {focus: {x: 0.2, y: 0.5}},
        },
        {
          assetRequirements: ['visual-2'], claimIds: [], emphasis: 0.6, endSeconds: 2,
          entityIds: [], narrativeRole: 'mechanism', semanticUnitId: 'unit-2', startSeconds: 1,
          text: '主体移到右侧', editorialHint: {focus: {x: 0.8, y: 0.5}},
        },
        {
          assetRequirements: ['visual-3'], claimIds: [], emphasis: 0.92, endSeconds: 3,
          entityIds: [], narrativeRole: 'crisis', semanticUnitId: 'unit-3', startSeconds: 2,
          text: '危机逼近', editorialHint: {focus: {x: 0.8, y: 0.5}},
        },
      ],
    },
  });

  assert.equal(planning.grammar.rules[0].defaults.camera.preset, 'pan_right');
  assert.equal(planning.grammar.rules[0].defaults.transition.class, 'directional_blur');
  assert.equal(planning.grammar.rules[1].defaults.camera.preset, 'push_in');
  assert.equal(planning.grammar.rules[1].defaults.transition.class, 'zoom_blur');
  assert.equal(planning.grammar.rules[2].defaults.transition.class, 'zoom_blur');
  assert.ok(planning.grammar.rules.every((rule) => rule.defaults.camera.preset !== 'whip'));
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
