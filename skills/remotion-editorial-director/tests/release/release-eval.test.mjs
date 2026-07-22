import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('release eval remains opt-in and names its immutable evidence manifest', async (context) => {
  const manifestPath = process.env.EDITORIAL_RELEASE_EVAL_MANIFEST;
  if (!manifestPath) {
    context.skip('EDITORIAL_RELEASE_EVAL_MANIFEST is not configured');
    return;
  }
  const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8'));
  assert.equal(typeof manifest.commit, 'string');
  assert.match(manifest.commit, /^[0-9a-f]{7,64}$/u);
  assert.equal(typeof manifest.environmentLockHash, 'string');
  assert.match(manifest.environmentLockHash, /^[a-f0-9]{64}$/u);
  assert.equal(typeof manifest.resultHash, 'string');
  assert.match(manifest.resultHash, /^[a-f0-9]{64}$/u);
});
