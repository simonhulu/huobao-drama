import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPERATION_STEPS,
  STAGE_DEFINITIONS,
  createWorkflowStages,
} from '../../scripts/lib/workflow-definition.mjs';
import {validateWorkflow} from '../../scripts/lib/stage-engine.mjs';

test('workflow definitions expose the four approved static operation DAGs', () => {
  assert.deepEqual(Object.keys(OPERATION_STEPS).sort(), [
    'analyze-reference',
    'plan-edit',
    'produce',
    'render-recipe',
  ]);
  assert.deepEqual(OPERATION_STEPS['analyze-reference'], [
    'INTAKE_LOCKED',
    ['BOUNDARIES_READY', 'SEMANTICS_READY'],
    'REVIEW_INPUT_READY',
    'TECHNIQUES_CLASSIFIED',
  ]);
  assert.deepEqual(OPERATION_STEPS['plan-edit'], [
    'INTAKE_LOCKED',
    'SEMANTICS_READY',
    'AUTHORING_INPUT_READY',
    'RECIPE_DRAFTED',
    'RECIPE_VALIDATED',
  ]);
  assert.deepEqual(OPERATION_STEPS['render-recipe'].slice(-7), [
    'RECIPE_VALIDATED',
    'AUDIO_CONFORMED',
    'ADAPTER_READY',
    'PROPS_BUILT',
    'RENDERED',
    'INSPECTED',
    'QA_PASSED',
  ]);
  assert.deepEqual(OPERATION_STEPS.produce.slice(-7), OPERATION_STEPS['render-recipe'].slice(-7));
});

test('every workflow stage declares outputs and accepts only injected executors', () => {
  const executors = Object.fromEntries(STAGE_DEFINITIONS.map(({id}) => [id, async () => ({
    artifacts: [],
    outputHashes: {[id]: 'a'.repeat(64)},
  })]));
  const stages = createWorkflowStages(executors);
  assert.equal(stages.length, STAGE_DEFINITIONS.length);
  assert.ok(stages.every(({outputs}) => outputs.length > 0));
  assert.doesNotThrow(() => validateWorkflow({operations: OPERATION_STEPS, stages}));
  assert.throws(
    () => createWorkflowStages({...executors, INTAKE_LOCKED: undefined}),
    (error) => error.code === 'STAGE_EXECUTOR_MISSING',
  );
});
