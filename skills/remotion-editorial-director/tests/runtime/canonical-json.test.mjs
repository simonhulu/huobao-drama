import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSafeJsonInteger,
  canonicalizePayload,
  parseStrictJson,
  verifyEnvelope,
  writeEnvelope,
} from '../../scripts/lib/canonical-json.mjs';

test('canonical JSON follows JCS ordering and number serialization', () => {
  assert.equal(
    canonicalizePayload({z: 1e30, a: 333333333.33333329, nested: {b: true, a: null}}),
    '{"a":333333333.3333333,"nested":{"a":null,"b":true},"z":1e+30}',
  );
});

test('strict JSON rejects duplicates, non-finite values, and lone surrogates', () => {
  assert.throws(
    () => parseStrictJson('{"same":1,"same":2}'),
    (error) => error.code === 'DUPLICATE_JSON_KEY',
  );
  assert.throws(
    () => canonicalizePayload({bad: Number.POSITIVE_INFINITY}),
    (error) => error.code === 'INVALID_JSON_VALUE',
  );
  assert.throws(
    () => canonicalizePayload({bad: '\ud800'}),
    (error) => error.code === 'INVALID_JSON_UNICODE',
  );
  assert.throws(
    () => assertSafeJsonInteger(Number.MAX_SAFE_INTEGER + 1, '$.frame'),
    (error) => error.code === 'UNSAFE_JSON_INTEGER',
  );
});

test('envelope writer hashes payload identity and verifies persisted bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-envelope-'));
  const destination = path.join(root, 'artifact.json');
  const written = await writeEnvelope(destination, {
    metadata: {createdBy: 'test'},
    payload: {z: 1, a: 2},
    schema: 'editorial://schema/test/v1',
  });
  const verified = await verifyEnvelope(destination);
  assert.equal(verified.contentHash, written.contentHash);
  assert.equal(verified.artifactHash, written.artifactHash);
  assert.deepEqual(verified.payload, {a: 2, z: 1});
  assert.match(await readFile(destination, 'utf8'), /"contentHash"/);
});
