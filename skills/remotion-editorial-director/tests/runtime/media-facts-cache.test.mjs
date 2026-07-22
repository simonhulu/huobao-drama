import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  VerificationLedger,
  getOrComputeMediaFacts,
  hashFile,
} from '../../scripts/lib/media-facts-cache.mjs';

test('media facts cache reuses derived facts only after byte authentication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-media-facts-'));
  const mediaPath = path.join(root, 'asset.bin');
  const cacheRoot = path.join(root, 'cache');
  await writeFile(mediaPath, 'authenticated bytes');
  const expectedHash = await hashFile(mediaPath);
  let probes = 0;
  const compute = async () => ({probe: ++probes, duration: 12});
  const identity = {
    operation: 'ffprobe',
    policyVersion: 'v1',
    args: ['-show_streams'],
    toolHash: 'ffprobe-hash',
  };

  const cold = await getOrComputeMediaFacts({
    cacheRoot,
    mediaPath,
    expectedHash,
    identity,
    compute,
  });
  const warm = await getOrComputeMediaFacts({
    cacheRoot,
    mediaPath,
    expectedHash,
    identity,
    compute,
  });

  assert.equal(cold.cacheHit, false);
  assert.equal(warm.cacheHit, true);
  assert.equal(probes, 1);
  assert.deepEqual(warm.facts, {probe: 1, duration: 12});

  await writeFile(mediaPath, 'tampered bytes.....');
  await assert.rejects(
    getOrComputeMediaFacts({
      cacheRoot,
      mediaPath,
      expectedHash,
      identity,
      compute,
    }),
    (error) => error.code === 'STAGED_ASSET_HASH_MISMATCH',
  );
});

test('verification leases are process-local and invalidate on stat changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-media-lease-'));
  const mediaPath = path.join(root, 'asset.bin');
  await writeFile(mediaPath, 'first');
  const expectedHash = await hashFile(mediaPath);
  const ledger = new VerificationLedger();

  await ledger.authenticate(mediaPath, expectedHash);
  assert.equal(await ledger.hasValidLease(mediaPath, expectedHash), true);
  await writeFile(mediaPath, 'second');
  assert.equal(await ledger.hasValidLease(mediaPath, expectedHash), false);
  assert.equal(new VerificationLedger().hasLease(mediaPath, expectedHash), false);
});
