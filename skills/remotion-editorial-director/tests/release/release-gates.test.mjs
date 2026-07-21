import assert from 'node:assert/strict';
import test from 'node:test';

import {GATE_NAMES, SKILL_TEST_GROUPS, gateDefinition, runGate} from '../../scripts/release-gate.mjs';

test('release gate catalog exposes the four approved lanes', () => {
  assert.deepEqual(GATE_NAMES, ['fast', 'integration', 'render-lock', 'release-eval']);
  for (const name of GATE_NAMES) {
    const steps = gateDefinition(name);
    assert.ok(steps.length > 0, `${name} must contain at least one step`);
    assert.ok(steps.every(({id, command, args}) => id && command && Array.isArray(args)));
  }
});

test('fast and integration gates cover every Skill test scope plus production lanes', () => {
  for (const gate of ['fast', 'integration']) {
    const nodeStep = gateDefinition(gate).find(({id}) => id === (gate === 'fast' ? 'node-unit' : 'node-integration'));
    assert.deepEqual(nodeStep.testGroups, SKILL_TEST_GROUPS);
  }
  const fastIds = gateDefinition('fast').map(({id}) => id);
  assert.deepEqual(fastIds, [
    'generated-contracts',
    'skill-typecheck',
    'node-unit',
    'scoped-coverage',
    'videoeditor-pure',
    'python-unit',
    'remotion-typecheck',
    'remotion-editorial-tests',
  ]);
  const integrationIds = gateDefinition('integration').map(({id}) => id);
  assert.deepEqual(integrationIds, [
    'node-integration',
    'doctor-720p-render-smoke',
    'installer-smoke',
    'python-integration',
  ]);
});

test('render and eval gates are explicitly blocked when release evidence is absent', async () => {
  const execute = async () => ({exitCode: 0});
  const render = await runGate('render-lock', {env: {}, execute});
  const evaluation = await runGate('release-eval', {env: {}, execute});
  assert.equal(render.status, 'blocked');
  assert.equal(evaluation.status, 'blocked');
  assert.ok(render.steps.some(({status}) => status === 'blocked'));
  assert.ok(evaluation.steps.some(({status}) => status === 'blocked'));
});

test('gate execution stops at the first failed step', async () => {
  const calls = [];
  const report = await runGate('release-eval', {
    env: {EDITORIAL_RELEASE_EVAL_MANIFEST: 'locked'},
    execute: async ({command, args}) => {
      calls.push([command, args]);
      return {exitCode: calls.length === 1 ? 7 : 0};
    },
  });
  assert.equal(report.status, 'failed');
  assert.equal(calls.length, 1);
  assert.equal(report.steps[0].exitCode, 7);
});
