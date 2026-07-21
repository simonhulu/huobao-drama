import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {RunStore} from '../../scripts/lib/run-store.mjs';

const makeRoot = () => mkdtemp(path.join(os.tmpdir(), 'editorial-run-store-'));

test('RunStore promotes canonical immutable JSON and commits the run index', async () => {
  const root = await makeRoot();
  const store = await RunStore.open(root, {
    runId: 'run-1',
    command: 'test',
  });

  await store.initialize({operation: 'produce'});
  const first = await store.promoteJson('evidence/result.json', {
    z: 1,
    a: {second: true, first: true},
  });
  const second = await store.promoteJson('evidence/equivalent.json', {
    a: {first: true, second: true},
    z: 1,
  });
  await store.commitStage({stage: 'SEMANTICS_READY', artifacts: [first]});
  await store.close();

  assert.equal(first.contentHash, second.contentHash);
  assert.equal(
    await readFile(path.join(root, 'evidence/result.json'), 'utf8'),
    '{"a":{"first":true,"second":true},"z":1}\n',
  );
  const run = JSON.parse(await readFile(path.join(root, 'run.json'), 'utf8'));
  assert.equal(run.currentStage, 'SEMANTICS_READY');
  assert.equal(run.artifacts[0].contentHash, first.contentHash);
});

test('RunStore rejects traversal, immutable overwrite, and a competing writer', async () => {
  const root = await makeRoot();
  const store = await RunStore.open(root, {runId: 'run-2', command: 'first'});
  await store.initialize({operation: 'analyze-reference'});

  await assert.rejects(
    store.promoteJson('../escape.json', {bad: true}),
    (error) => error.code === 'PATH_OUTSIDE_RUN',
  );
  await store.promoteJson('locks/evidence.json', {locked: true});
  await assert.rejects(
    store.promoteJson('locks/evidence.json', {locked: false}),
    (error) => error.code === 'IMMUTABLE_DESTINATION_EXISTS',
  );
  await assert.rejects(
    RunStore.open(root, {runId: 'run-2', command: 'second'}),
    (error) => error.code === 'RUN_LOCKED',
  );
  await store.close();
});

test('RunStore atomically replaces the mutable run index under its writer lock', async () => {
  const root = await makeRoot();
  const store = await RunStore.open(root, {runId: 'run-3', command: 'director'});
  await store.initialize({operation: 'plan-edit'});
  await store.commitRun({
    artifacts: {},
    currentStage: 'SEMANTICS_READY',
    operation: 'plan-edit',
    runId: 'run-3',
    status: 'running',
  });
  assert.deepEqual(await store.readRun(), {
    artifacts: {},
    currentStage: 'SEMANTICS_READY',
    operation: 'plan-edit',
    runId: 'run-3',
    status: 'running',
  });
  await store.close();
});
