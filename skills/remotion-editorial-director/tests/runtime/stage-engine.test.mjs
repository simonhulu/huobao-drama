import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DirectorEngine,
  validateWorkflow,
} from '../../scripts/lib/stage-engine.mjs';

const stage = (id, prerequisites, execute, outputs = [`${id}.json`]) => ({
  execute,
  id,
  outputs,
  prerequisites,
});

test('workflow validation rejects unknown, cyclic, and output-less stages', () => {
  assert.throws(
    () => validateWorkflow({
      operations: {bad: ['MISSING']},
      stages: [stage('CREATED', [], async () => ({}))],
    }),
    (error) => error.code === 'UNKNOWN_STAGE',
  );
  assert.throws(
    () => validateWorkflow({
      operations: {bad: ['A', 'B']},
      stages: [
        stage('A', ['B'], async () => ({})),
        stage('B', ['A'], async () => ({})),
      ],
    }),
    (error) => error.code === 'STAGE_DEPENDENCY_CYCLE',
  );
  assert.throws(
    () => validateWorkflow({
      operations: {bad: ['A']},
      stages: [stage('A', [], async () => ({}), [])],
    }),
    (error) => error.code === 'STAGE_OUTPUT_MISSING',
  );
});

test('director owns commits and runs the one declared parallel group', async () => {
  const events = [];
  let releaseParallel;
  const parallelGate = new Promise((resolve) => {
    releaseParallel = resolve;
  });
  let ready = 0;
  const parallelExecutor = (id) => async (context) => {
    assert.equal('commit' in context, false);
    events.push(`start:${id}`);
    ready += 1;
    if (ready === 2) releaseParallel();
    await parallelGate;
    events.push(`end:${id}`);
    return {artifacts: [{path: `${id}.json`}], outputHashes: {[id]: `${id}-hash`}};
  };
  const stages = [
    stage('INTAKE', [], async () => ({artifacts: [], outputHashes: {INTAKE: 'intake-hash'}})),
    stage('BOUNDARIES', ['INTAKE'], parallelExecutor('BOUNDARIES')),
    stage('SEMANTICS', ['INTAKE'], parallelExecutor('SEMANTICS')),
    stage('REVIEW', ['BOUNDARIES', 'SEMANTICS'], async () => ({
      artifacts: [],
      outputHashes: {REVIEW: 'review-hash'},
    })),
  ];
  const commits = [];
  const engine = new DirectorEngine({
    operations: {analyze: ['INTAKE', ['BOUNDARIES', 'SEMANTICS'], 'REVIEW']},
    stages,
  });
  const result = await engine.execute({
    commit: async (state) => commits.push(structuredClone(state)),
    context: {runDirectory: '/tmp/run'},
    implementationLockHash: 'impl-1',
    inputLockHash: 'input-1',
    operation: 'analyze',
    run: {attempts: [], completedStages: [], status: 'created'},
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.completedStages, ['INTAKE', 'BOUNDARIES', 'SEMANTICS', 'REVIEW']);
  assert.deepEqual(events.slice(0, 2).sort(), ['start:BOUNDARIES', 'start:SEMANTICS']);
  assert.equal(commits.at(-1).status, 'complete');
  assert.ok(commits.every((state) => state.inputLockHash === 'input-1'));
});

test('resume skips committed work and lock drift requires a revision', async () => {
  let executions = 0;
  const engine = new DirectorEngine({
    operations: {produce: ['A', 'B']},
    stages: [
      stage('A', [], async () => {
        executions += 1;
        return {artifacts: [], outputHashes: {A: 'a'}};
      }),
      stage('B', ['A'], async () => {
        executions += 1;
        return {artifacts: [], outputHashes: {B: 'b'}};
      }),
    ],
  });
  const run = {
    attempts: [{attemptId: 'old', stage: 'A', status: 'succeeded'}],
    completedStages: ['A'],
    implementationLockHash: 'impl-1',
    inputLockHash: 'input-1',
    outputHashes: {A: 'a'},
    status: 'failed',
  };
  const resumed = await engine.execute({
    commit: async () => {},
    context: {},
    implementationLockHash: 'impl-1',
    inputLockHash: 'input-1',
    operation: 'produce',
    resume: true,
    run,
  });
  assert.equal(executions, 1);
  assert.deepEqual(resumed.completedStages, ['A', 'B']);

  await assert.rejects(
    engine.execute({
      commit: async () => {},
      context: {},
      implementationLockHash: 'impl-1',
      inputLockHash: 'input-2',
      operation: 'produce',
      resume: true,
      run,
    }),
    (error) => error.code === 'RUN_REVISION_REQUIRED' && error.supersedes === run,
  );
});

test('cancellation commits a resumable terminal state and stops dispatch', async () => {
  const controller = new AbortController();
  let secondRan = false;
  const engine = new DirectorEngine({
    operations: {produce: ['A', 'B']},
    stages: [
      stage('A', [], async () => {
        controller.abort();
        return {artifacts: [], outputHashes: {A: 'a'}};
      }),
      stage('B', ['A'], async () => {
        secondRan = true;
        return {artifacts: [], outputHashes: {B: 'b'}};
      }),
    ],
  });
  const commits = [];
  const result = await engine.execute({
    commit: async (state) => commits.push(structuredClone(state)),
    context: {},
    implementationLockHash: 'impl',
    inputLockHash: 'input',
    operation: 'produce',
    run: {attempts: [], completedStages: [], status: 'created'},
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.completedStages, ['A']);
  assert.equal(secondRan, false);
  assert.equal(commits.at(-1).status, 'cancelled');
});

test('agent stages commit their input then pause in an explicit awaiting state', async () => {
  let downstreamRan = false;
  const engine = new DirectorEngine({
    operations: {plan: ['AUTHORING_INPUT_READY', 'RECIPE_DRAFTED']},
    stages: [
      stage('AUTHORING_INPUT_READY', [], async () => ({
        artifacts: [{path: 'agent/request.json'}],
        awaitingAgent: {attemptId: 'attempt-1', stage: 'AUTHORING'},
        outputHashes: {AUTHORING_INPUT_READY: 'request-hash'},
      })),
      stage('RECIPE_DRAFTED', ['AUTHORING_INPUT_READY'], async () => {
        downstreamRan = true;
        return {artifacts: [], outputHashes: {RECIPE_DRAFTED: 'recipe-hash'}};
      }),
    ],
  });
  const commits = [];
  const result = await engine.execute({
    commit: async (state) => commits.push(structuredClone(state)),
    context: {},
    implementationLockHash: 'impl',
    inputLockHash: 'input',
    operation: 'plan',
    run: {attempts: [], completedStages: [], status: 'created'},
  });

  assert.equal(result.status, 'awaiting_agent');
  assert.equal(result.currentStage, 'AUTHORING_AWAITING_AGENT');
  assert.equal(result.awaitingAgent.attemptId, 'attempt-1');
  assert.deepEqual(result.completedStages, ['AUTHORING_INPUT_READY']);
  assert.equal(downstreamRan, false);
  assert.equal(commits.at(-1).status, 'awaiting_agent');
});
