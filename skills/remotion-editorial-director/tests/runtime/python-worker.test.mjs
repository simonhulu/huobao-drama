import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {runPythonWorker} from '../../scripts/lib/python-worker.mjs';

const packageRoot = path.resolve('skills/remotion-editorial-director/python');

test('Python worker accepts one bounded JSON request and returns portable SRT cues', async () => {
  const result = await runPythonWorker({
    operation: 'parse_srt',
    packageRoot,
    params: {
      mediaDurationSeconds: 2,
      text: '1\n00:00:00,000 --> 00:00:01,500\nYahoo changed.\n',
    },
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.length, 1);
  assert.equal(result.result[0].text, 'Yahoo changed.');
});

test('Python worker rejects a failed worker envelope and caps output', async () => {
  await assert.rejects(
    runPythonWorker({operation: 'missing', packageRoot, params: {}, timeoutMs: 5000}),
    (error) => error.code === 'PYTHON_WORKER_FAILED',
  );
  await assert.rejects(
    runPythonWorker({
      maxStdoutBytes: 16,
      operation: 'parse_srt',
      packageRoot,
      params: {mediaDurationSeconds: 2, text: '1\n00:00:00,000 --> 00:00:01,500\nLong output.\n'},
      timeoutMs: 5000,
    }),
    (error) => error.code === 'PYTHON_WORKER_STDOUT_LIMIT',
  );
});
