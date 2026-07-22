import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findNearestProjectConfig,
  resolveDirectorManifest,
} from '../../scripts/lib/config.mjs';

test('nearest project config stops at the git root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-config-'));
  await writeFile(path.join(root, '.git'), 'gitdir: elsewhere\n');
  await writeFile(path.join(root, '.remotion-editorial-director.json'), '{}\n');
  const nested = path.join(root, 'a', 'b');
  await mkdir(nested, {recursive: true});
  assert.equal(await findNearestProjectConfig(nested), path.join(root, '.remotion-editorial-director.json'));
});

test('config precedence is CLI then manifest then project then defaults', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-config-'));
  await writeFile(path.join(root, '.git'), 'gitdir: elsewhere\n');
  await writeFile(path.join(root, '.remotion-editorial-director.json'), JSON.stringify({
    outputRoot: 'project-runs',
    policy: {adapterTimeoutSeconds: 60, maxRunBytes: 1000},
  }));
  const manifestPath = path.join(root, 'manifest.json');
  const resolved = await resolveDirectorManifest({
    cli: {outputRoot: 'cli-runs'},
    manifest: {
      operation: 'analyze-reference',
      policy: {adapterTimeoutSeconds: 90},
      referenceCorpus: [],
      runSchemaVersion: 1,
    },
    manifestPath,
  });
  assert.equal(resolved.manifest.outputRoot, 'cli-runs');
  assert.equal(resolved.manifest.policy.adapterTimeoutSeconds, 90);
  assert.equal(resolved.manifest.policy.analysisTimeoutSeconds, 120);
  assert.equal(resolved.manifest.policy.maxRunBytes, 1000);
  assert.deepEqual(resolved.manifest.modelPolicy, {
    authoringMode: 'deterministic',
    reviewMode: 'deterministic',
  });
});

test('project config rejects unknown authority fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-config-'));
  await writeFile(path.join(root, '.git'), 'gitdir: elsewhere\n');
  await writeFile(path.join(root, '.remotion-editorial-director.json'), JSON.stringify({recipe: 'hidden.json'}));
  await assert.rejects(
    resolveDirectorManifest({manifest: {}, manifestPath: path.join(root, 'manifest.json')}),
    (error) => error.code === 'PROJECT_CONFIG_INVALID',
  );
});

test('project-owned relative paths resolve from the project config directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-config-'));
  await writeFile(path.join(root, '.git'), 'gitdir: elsewhere\n');
  await writeFile(path.join(root, '.remotion-editorial-director.json'), JSON.stringify({
    adapterConfig: 'config/adapter.json',
    outputRoot: 'project-runs',
  }));
  const manifestPath = path.join(root, 'nested', 'manifest.json');
  await mkdir(path.dirname(manifestPath), {recursive: true});

  const resolved = await resolveDirectorManifest({
    manifest: {operation: 'analyze-reference', referenceCorpus: [], runSchemaVersion: 1},
    manifestPath,
  });

  assert.equal(resolved.manifest.adapterConfig, path.join(root, 'config/adapter.json'));
  assert.equal(resolved.manifest.outputRoot, path.join(root, 'project-runs'));
});
