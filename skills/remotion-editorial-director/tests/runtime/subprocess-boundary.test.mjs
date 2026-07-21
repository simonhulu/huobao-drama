import assert from 'node:assert/strict';
import test from 'node:test';

import {runJsonSubprocess} from '../../scripts/lib/subprocess-boundary.mjs';

const nodeCommand = (body) => [process.execPath, '-e', body];
const request = {
  adapterProtocolVersion: 1,
  operation: 'capabilities',
  operationId: 'operation-1',
};

test('subprocess boundary sends one request and validates response identity', async () => {
  const result = await runJsonSubprocess({
    command: nodeCommand(`
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => input += chunk);
      process.stdin.on('end', () => {
        const request = JSON.parse(input);
        process.stdout.write(JSON.stringify({
          adapterProtocolVersion: 1,
          operation: request.operation,
          operationId: request.operationId,
          status: 'ok',
          error: null
        }));
      });
    `),
    cwd: process.cwd(),
    request,
    timeoutMs: 1000,
  });
  assert.equal(result.status, 'ok');
});

test('subprocess boundary rejects multiple JSON values and identity mismatch', async () => {
  await assert.rejects(
    runJsonSubprocess({
      command: nodeCommand("process.stdout.write('{}\\n{}')"),
      cwd: process.cwd(),
      request,
      timeoutMs: 1000,
    }),
    (error) => error.code === 'SUBPROCESS_MALFORMED_OUTPUT',
  );
  await assert.rejects(
    runJsonSubprocess({
      command: nodeCommand(`process.stdout.write(JSON.stringify({
        adapterProtocolVersion: 1,
        operation: 'capabilities',
        operationId: 'wrong',
        status: 'ok',
        error: null
      }))`),
      cwd: process.cwd(),
      request,
      timeoutMs: 1000,
    }),
    (error) => error.code === 'SUBPROCESS_IDENTITY_MISMATCH',
  );
});

test('subprocess boundary enforces stdout limits and timeout categories', async () => {
  await assert.rejects(
    runJsonSubprocess({
      command: nodeCommand("process.stdout.write('x'.repeat(128))"),
      cwd: process.cwd(),
      maxStdoutBytes: 64,
      request,
      timeoutMs: 1000,
    }),
    (error) => error.code === 'SUBPROCESS_STDOUT_LIMIT',
  );
  await assert.rejects(
    runJsonSubprocess({
      command: nodeCommand('setInterval(() => {}, 1000)'),
      cwd: process.cwd(),
      request,
      timeoutMs: 30,
      terminationGraceMs: 10,
    }),
    (error) => error.code === 'SUBPROCESS_TIMEOUT' && error.category === 5,
  );
});

test('subprocess cancellation maps to exit 130', async () => {
  const controller = new AbortController();
  const pending = runJsonSubprocess({
    command: nodeCommand('setInterval(() => {}, 1000)'),
    cwd: process.cwd(),
    request,
    signal: controller.signal,
    timeoutMs: 1000,
    terminationGraceMs: 10,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    pending,
    (error) => error.code === 'CANCELLED' && error.exitCode === 130,
  );
});

test('subprocess boundary accepts the protocol category assigned to a nonzero exit', async () => {
  const result = await runJsonSubprocess({
    command: nodeCommand(`
      let input = '';
      process.stdin.on('data', (chunk) => input += chunk);
      process.stdin.on('end', () => {
        const request = JSON.parse(input);
        process.stdout.write(JSON.stringify({
          adapterProtocolVersion: request.adapterProtocolVersion,
          operation: request.operation,
          operationId: request.operationId,
          status: 'error',
          error: {category: 'asset_failure'}
        }));
        process.exitCode = 4;
      });
    `),
    cwd: process.cwd(),
    request,
    timeoutMs: 1000,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.diagnostics.exitCode, 4);
});
