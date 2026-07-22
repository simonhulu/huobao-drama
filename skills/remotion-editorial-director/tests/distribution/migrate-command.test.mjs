import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {migrateRecipe} from '../../scripts/lib/maintenance/migrate.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractsDirectory = path.join(skillRoot, 'contracts');
const v1Fixture = path.join(skillRoot, 'fixtures/json/recipe-v1-minimal.json');

test('migration requires explicit identity sources and never overwrites input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-migrate-'));
  const inputPath = path.join(root, 'recipe.json');
  const source = await readFile(v1Fixture);
  await writeFile(inputPath, source);
  const missing = await migrateRecipe({contractsDirectory, inputPath, to: 'magnates-remotion-recipe-v2'});
  assert.equal(missing.status, 'needs_mapping');
  assert.equal(missing.diagnostics.length, 3);
  assert.deepEqual(await readFile(inputPath), source);
});

test('migration emits an unlocked v2 draft and lineage report from explicit mappings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-migrate-'));
  const inputPath = path.join(root, 'recipe.json');
  await writeFile(inputPath, await readFile(v1Fixture));
  await writeFile(path.join(root, 'identity-map.json'), JSON.stringify({
    assetsBySource: {'legacy-background.png': 'asset-background'},
  }));
  await writeFile(path.join(root, 'asset-inventory.json'), JSON.stringify({
    assets: [{
      assetId: 'asset-background', byteSize: 1, entityIds: [], kind: 'image',
      licenseStatus: 'project_owned', mediaMetadata: {height: 1, mimeType: 'image/png', width: 1},
      path: 'background.png', provenance: {owner: 'test', source: 'fixture'}, sha256: 'a'.repeat(64), subjectIds: [],
    }],
    inventoryVersion: 1,
    schemaVersion: 'editorial://schema/asset-inventory/v1',
  }));
  await writeFile(path.join(root, 'semantic-outline.json'), JSON.stringify({
    claims: [], entities: [], metrics: [], outlineId: 'outline-1',
    schemaVersion: 'editorial://schema/semantic-outline/v1',
    units: [{assetRequirements: ['asset-background'], claimIds: [], emphasis: 0.5, endSeconds: 2, entityIds: [], narrativeRole: 'hook', semanticUnitId: 'unit-1', startSeconds: 0, text: 'Hook', uncertainty: 0}],
  }));
  const result = await migrateRecipe({contractsDirectory, inputPath, to: 'magnates-remotion-recipe-v2'});
  assert.equal(result.status, 'ok');
  assert.equal(JSON.parse(await readFile(result.artifacts.recipeDraft.path)).shots[0].background.assetId, 'asset-background');
  assert.equal(JSON.parse(await readFile(result.artifacts.migrationReport.path)).sourceVersion, 'magnates-remotion-recipe-v1');
});
