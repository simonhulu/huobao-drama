import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

import {readJson, skillRoot} from './helpers.mjs';

function runGenerator(args) {
  return spawnSync(process.execPath, ['tests/contracts/generate-contracts.mjs', ...args], {
    cwd: skillRoot,
    encoding: 'utf8',
  });
}

test('checked-in generated contracts are current', () => {
  const result = runGenerator(['--check']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('generation is byte-deterministic and covers schema, enum, and error identities', () => {
  const temp = mkdtempSync(join(tmpdir(), 'editorial-contracts-'));
  const first = join(temp, 'first');
  const second = join(temp, 'second');

  try {
    assert.equal(runGenerator(['--out-dir', first]).status, 0);
    assert.equal(runGenerator(['--out-dir', second]).status, 0);

    const firstTypes = readFileSync(join(first, 'contracts.ts'));
    const secondTypes = readFileSync(join(second, 'contracts.ts'));
    const firstDigests = readFileSync(join(first, 'schema-digests.json'));
    const secondDigests = readFileSync(join(second, 'schema-digests.json'));
    assert.deepEqual(firstTypes, secondTypes);
    assert.deepEqual(firstDigests, secondDigests);

    const generated = firstTypes.toString('utf8');
    assert.match(generated, /^\/\/ Generated from contracts\/. Do not edit\./);
    assert.match(generated, /magnates-remotion-recipe-v2/);
    assert.match(generated, /export type AdapterOperation/);
    assert.match(generated, /export type EditorialErrorCode/);

    const digestManifest = JSON.parse(firstDigests.toString('utf8'));
    const registry = readJson('contracts/schema-registry.json');
    assert.deepEqual(
      Object.keys(digestManifest.schemas),
      registry.schemas.map((entry) => entry.id).sort(),
    );
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }
});

test('generated recipe types reject unknown cue and shot properties', () => {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'generated/contracts.ts',
      'tests/contracts/generated-contracts.type-test.ts',
    ],
    {cwd: skillRoot, encoding: 'utf8'},
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
