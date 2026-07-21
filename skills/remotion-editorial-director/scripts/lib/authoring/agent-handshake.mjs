import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {canonicalizePayload, hashPayload, parseStrictJson} from '../canonical-json.mjs';
import {createContractValidator} from '../contract-validator.mjs';

const contractsDirectory = fileURLToPath(new URL('../../../contracts/', import.meta.url));
let validatorPromise;
const getContractValidator = () => {
  validatorPromise ??= createContractValidator({contractsDirectory});
  return validatorPromise;
};
const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  exitCode: 3,
  ...fields,
});

export const sha256File = (filePath) => new Promise((resolve, reject) => {
  const digest = createHash('sha256');
  const stream = createReadStream(filePath);
  stream.on('error', reject);
  stream.on('data', (chunk) => digest.update(chunk));
  stream.on('end', () => resolve(digest.digest('hex')));
});

export const prepareAgentAttempt = async ({
  runDirectory,
  runId,
  stage,
  attemptId,
  inputLockHash,
  payload,
  createdAt = new Date().toISOString(),
}) => {
  if (!['AUTHORING', 'REVIEW'].includes(stage)) {
    throw codedError('AGENT_STAGE_INVALID', `Invalid agent stage: ${stage}`);
  }
  const requestId = `${runId}:${stage}:${attemptId}`;
  const request = {
    attemptId,
    createdAt,
    inputHashes: {inputLockHash},
    payload,
    requestId,
    runId,
    schemaVersion: 'editorial://schema/agent-request/v1',
    stage,
  };
  const validator = await getContractValidator();
  validator.validate('agentRequest', request);
  const attemptDirectory = path.join(runDirectory, 'agent', stage.toLowerCase(), attemptId);
  const requestPath = path.join(attemptDirectory, 'request.json');
  await mkdir(attemptDirectory, {recursive: true});
  try {
    await writeFile(requestPath, `${canonicalizePayload(request)}\n`, {flag: 'wx'});
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw codedError('AGENT_ATTEMPT_EXISTS', `Agent attempt already exists: ${attemptId}`);
    }
    throw error;
  }
  return {
    attemptDirectory,
    attemptId,
    exitCode: 10,
    inputLockHash,
    requestHash: hashPayload(request),
    requestId,
    requestPath,
    runId,
    stage,
    status: 'awaiting_agent',
  };
};

export const acceptAgentResponse = async ({attempt, inputPath, currentInputLockHash}) => {
  const responsePath = path.join(attempt.attemptDirectory, 'response.json');
  try {
    await readFile(responsePath);
    throw codedError(
      'AGENT_RESPONSE_ALREADY_ACCEPTED',
      `Agent attempt ${attempt.attemptId} already has an accepted response`,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (currentInputLockHash !== attempt.inputLockHash) {
    throw codedError(
      'AGENT_RESPONSE_INPUT_LOCK_CHANGED',
      'Run inputs changed after the agent request was locked',
    );
  }
  const rawBytes = await readFile(inputPath);
  const response = parseStrictJson(rawBytes.toString('utf8'));
  const validator = await getContractValidator();
  validator.validate('agentResponse', response);
  if (
    response.schemaVersion !== 'editorial://schema/agent-response/v1' ||
    response.requestId !== attempt.requestId ||
    response.requestHash !== attempt.requestHash ||
    response.runId !== attempt.runId ||
    response.stage !== attempt.stage ||
    response.attemptId !== attempt.attemptId
  ) {
    throw codedError(
      'AGENT_RESPONSE_REQUEST_MISMATCH',
      'Agent response does not match the active immutable request',
    );
  }
  try {
    await writeFile(responsePath, rawBytes, {flag: 'wx'});
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw codedError('AGENT_RESPONSE_ALREADY_ACCEPTED', 'Agent response was accepted concurrently');
    }
    throw error;
  }
  return {
    rawResponseHash: await sha256File(responsePath),
    responseId: response.responseId,
    responsePath,
    status: 'response_accepted',
  };
};

export const loadReplayResponse = async ({replayPath, expectedHash}) => {
  const actualHash = await sha256File(replayPath);
  if (actualHash !== expectedHash) {
    throw codedError('REPLAY_HASH_MISMATCH', 'Replay bytes do not match the locked hash', {
      actualHash,
      expectedHash,
    });
  }
  return parseStrictJson(await readFile(replayPath, 'utf8'));
};
