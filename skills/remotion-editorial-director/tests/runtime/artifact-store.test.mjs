import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {promoteArtifact} from '../../scripts/lib/artifact-store.mjs';
import {createContractValidator} from '../../scripts/lib/contract-validator.mjs';
import {RunStore} from '../../scripts/lib/run-store.mjs';

const contractsDirectory = path.resolve('skills/remotion-editorial-director/contracts');

test('artifact promotion validates payload and writes a hash-linked closed envelope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-artifact-store-'));
  const store = await RunStore.open(root, {command: 'test', runId: 'run-artifact'});
  await store.initialize({operation: 'plan-edit'});
  const validator = await createContractValidator({contractsDirectory});
  const payload = {
    durationSeconds: 1,
    schemaVersion: 'editorial://schema/timed-transcript/v1',
    spans: [{endSeconds: 1, spanId: 'span-1', startSeconds: 0, text: 'One second.'}],
  };
  const promoted = await promoteArtifact({
    artifactType: 'timed-transcript',
    inputHashes: {source: 'a'.repeat(64)},
    payload,
    relativePath: 'evidence/timing.json',
    runId: 'run-artifact',
    schemaName: 'timedTranscript',
    store,
    validator,
  });

  assert.equal(promoted.reference.artifactType, 'timed-transcript');
  assert.equal(promoted.reference.schemaId, 'editorial://schema/timed-transcript/v1');
  assert.match(promoted.reference.sha256, /^[a-f0-9]{64}$/);
  const envelope = JSON.parse(await readFile(promoted.reference.path, 'utf8'));
  assert.equal(envelope.contentHash, promoted.contentHash);
  assert.deepEqual(envelope.payload, payload);
  validator.validate('artifactEnvelope', envelope);
  await store.close();
});

test('artifact promotion rejects an invalid payload before creating its destination', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-artifact-invalid-'));
  const store = await RunStore.open(root, {command: 'test', runId: 'run-invalid'});
  await store.initialize({operation: 'plan-edit'});
  const validator = await createContractValidator({contractsDirectory});
  await assert.rejects(
    promoteArtifact({
      artifactType: 'timed-transcript',
      inputHashes: {},
      payload: {schemaVersion: 'editorial://schema/timed-transcript/v1', spans: []},
      relativePath: 'evidence/invalid.json',
      runId: 'run-invalid',
      schemaName: 'timedTranscript',
      store,
      validator,
    }),
    (error) => error.code === 'SCHEMA_VALIDATION_FAILED',
  );
  await assert.rejects(readFile(path.join(root, 'evidence/invalid.json')), {code: 'ENOENT'});
  await store.close();
});
