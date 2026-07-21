import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptAgentResponse,
  loadReplayResponse,
  prepareAgentAttempt,
  sha256File,
} from '../../scripts/lib/authoring/agent-handshake.mjs';

const sha = (character) => character.repeat(64);
const artifact = (artifactType, schemaId, character) => ({
  artifactType,
  path: `/tmp/editorial-run/${artifactType}.json`,
  schemaId,
  sha256: sha(character),
});
const authoringPayload = {
  assetInventory: artifact('asset-inventory', 'editorial://schema/asset-inventory/v1', 'b'),
  grammarRuleIds: ['default-establishing'],
  semanticOutline: artifact('semantic-outline', 'editorial://schema/semantic-outline/v1', 'a'),
  target: {fps: 30, height: 720, profileId: 'youtube-720p', width: 1280},
};
const modelMetadata = {
  costKnown: false,
  model: 'gpt-test',
  parserVersion: '1.0.0',
  promptHash: sha('c'),
  promptTemplateVersion: '1.0.0',
  provider: 'codex-host',
  rawResponseHash: sha('d'),
  seedSupported: false,
  sessionId: 'session-test',
  temperature: 0,
};
const authoringResult = JSON.parse(
  await readFile(new URL('../../fixtures/json/authoring-result-minimal.json', import.meta.url), 'utf8'),
);

test('agent authoring request enters awaiting state and accepts exactly one bound response', async () => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), 'editorial-agent-'));
  const attempt = await prepareAgentAttempt({
    attemptId: 'attempt-1',
    inputLockHash: sha('e'),
    payload: authoringPayload,
    runDirectory,
    runId: 'run-1',
    stage: 'AUTHORING',
  });
  assert.equal(attempt.status, 'awaiting_agent');
  assert.equal(attempt.exitCode, 10);
  const request = JSON.parse(await readFile(attempt.requestPath, 'utf8'));
  assert.equal(request.stage, 'AUTHORING');

  const candidatePath = path.join(runDirectory, 'candidate.json');
  await writeFile(candidatePath, JSON.stringify({
    attemptId: 'attempt-1',
    createdAt: '2026-07-22T00:00:00.000Z',
    modelMetadata,
    payload: {authoringResult},
    requestHash: attempt.requestHash,
    requestId: attempt.requestId,
    responseId: 'response-1',
    runId: 'run-1',
    schemaVersion: 'editorial://schema/agent-response/v1',
    stage: 'AUTHORING',
    status: 'ok',
  }));
  const accepted = await acceptAgentResponse({
    attempt,
    currentInputLockHash: sha('e'),
    inputPath: candidatePath,
  });
  assert.equal(accepted.status, 'response_accepted');
  await assert.rejects(
    acceptAgentResponse({attempt, currentInputLockHash: sha('e'), inputPath: candidatePath}),
    (error) => error.code === 'AGENT_RESPONSE_ALREADY_ACCEPTED',
  );
});

test('agent response rejects request mismatch and changed run inputs', async () => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), 'editorial-agent-mismatch-'));
  const attempt = await prepareAgentAttempt({
    attemptId: 'attempt-2',
    inputLockHash: sha('e'),
    payload: authoringPayload,
    runDirectory,
    runId: 'run-2',
    stage: 'AUTHORING',
  });
  const candidatePath = path.join(runDirectory, 'candidate.json');
  await writeFile(candidatePath, JSON.stringify({
    attemptId: 'attempt-2', createdAt: '2026-07-22T00:00:00.000Z',
    modelMetadata, payload: {authoringResult}, requestHash: sha('f'),
    requestId: attempt.requestId, responseId: 'response-2', runId: 'run-2',
    schemaVersion: 'editorial://schema/agent-response/v1', stage: 'AUTHORING', status: 'ok',
  }));
  await assert.rejects(
    acceptAgentResponse({attempt, currentInputLockHash: sha('e'), inputPath: candidatePath}),
    (error) => error.code === 'AGENT_RESPONSE_REQUEST_MISMATCH',
  );
  await assert.rejects(
    acceptAgentResponse({attempt, currentInputLockHash: 'changed', inputPath: candidatePath}),
    (error) => error.code === 'AGENT_RESPONSE_INPUT_LOCK_CHANGED',
  );
});

test('replay authenticates the exact locked raw response bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-replay-'));
  const replayPath = path.join(root, 'response.json');
  await writeFile(replayPath, '{"status":"ok","payload":{}}\n');
  const expectedHash = await sha256File(replayPath);
  assert.deepEqual(
    await loadReplayResponse({expectedHash, replayPath}),
    {payload: {}, status: 'ok'},
  );
  await writeFile(replayPath, '{"status":"ok", "payload":{}}\n');
  await assert.rejects(
    loadReplayResponse({expectedHash, replayPath}),
    (error) => error.code === 'REPLAY_HASH_MISMATCH',
  );
});
