import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeBundleKey,
  getOrBuildBundle,
} from '../../scripts/lib/bundle-cache.mjs';

test('bundle cache reuses a fully validated content-addressed build', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'editorial-bundle-'));
  const identity = {
    sourceTreeHash: 'source-a',
    dependencyLockHash: 'lock-a',
    generatedContractsHash: 'contracts-a',
    bundlerHash: 'bundler-a',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  const key = computeBundleKey(identity);
  let builds = 0;
  const build = async (directory) => {
    builds += 1;
    await writeFile(path.join(directory, 'index.js'), 'export default 1;\n');
  };

  const cold = await getOrBuildBundle({cacheRoot, key, identity, build});
  const warm = await getOrBuildBundle({cacheRoot, key, identity, build});

  assert.equal(builds, 1);
  assert.equal(cold.cacheHit, false);
  assert.equal(warm.cacheHit, true);
  assert.equal(await readFile(path.join(warm.directory, 'index.js'), 'utf8'), 'export default 1;\n');
});

test('bundle cache quarantines corruption and rebuilds under the same key', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'editorial-bundle-'));
  const identity = {
    sourceTreeHash: 'source-b',
    dependencyLockHash: 'lock-b',
    generatedContractsHash: 'contracts-b',
    bundlerHash: 'bundler-b',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  const key = computeBundleKey(identity);
  let builds = 0;
  const build = async (directory) => {
    builds += 1;
    await writeFile(path.join(directory, 'index.js'), `build-${builds}\n`);
  };
  const first = await getOrBuildBundle({cacheRoot, key, identity, build});
  await writeFile(path.join(first.directory, 'index.js'), 'corrupt\n');
  const rebuilt = await getOrBuildBundle({cacheRoot, key, identity, build});

  assert.equal(builds, 2);
  assert.equal(rebuilt.cacheHit, false);
  assert.equal(await readFile(path.join(rebuilt.directory, 'index.js'), 'utf8'), 'build-2\n');
});

test('bundle key changes for every browser-code identity input', () => {
  const base = {
    sourceTreeHash: 'source',
    dependencyLockHash: 'lock',
    generatedContractsHash: 'contracts',
    bundlerHash: 'bundler',
    node: 'node',
    platform: 'platform',
  };
  const baseline = computeBundleKey(base);
  for (const field of Object.keys(base)) {
    assert.notEqual(computeBundleKey({...base, [field]: `${base[field]}-changed`}), baseline);
  }
});
