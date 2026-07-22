import assert from 'node:assert/strict';
import test from 'node:test';

import {migrateRecipeV1ToV2} from '../../scripts/lib/authoring/migrate-v1.mjs';

const recipeV1 = {
  durationInFrames: 60,
  fps: 30,
  schemaVersion: 'magnates-remotion-recipe-v1',
  shots: [{
    background: {fit: 'cover', src: 'media/yahoo.png'},
    durationInFrames: 60,
    id: 'shot-1',
    texts: [{endFrame: 45, startFrame: 5, subject: 'Yahoo', text: 'Yahoo', type: 'text'}],
  }],
};

test('v1 migration uses only explicit identity bindings and emits field lineage', () => {
  const original = structuredClone(recipeV1);
  const result = migrateRecipeV1ToV2({
    identityMap: {
      assetsBySource: {'media/yahoo.png': 'asset-yahoo'},
      semanticRolesByShotId: {'shot-1': 'establishing'},
      subjectsByPointer: {'/shots/0/texts/0': 'entity-yahoo'},
    },
    recipe: recipeV1,
    sourceHash: 'v1-source-hash',
  });
  assert.equal(result.status, 'migrated');
  assert.equal(result.recipeCandidate.schemaVersion, 'magnates-remotion-recipe-v2');
  assert.deepEqual(result.recipeCandidate.shots[0].background, {assetId: 'asset-yahoo', fit: 'cover'});
  assert.equal(result.recipeCandidate.shots[0].semanticRole, 'establishing');
  assert.equal(result.recipeCandidate.shots[0].texts[0].id, 'shot-1:text:0');
  assert.equal(result.recipeCandidate.shots[0].texts[0].subjectId, 'entity-yahoo');
  assert.equal(result.report.sourceHash, 'v1-source-hash');
  assert.deepEqual(recipeV1, original);
});

test('v1 migration returns needs_mapping without guessing from display strings', () => {
  const result = migrateRecipeV1ToV2({identityMap: {}, recipe: recipeV1, sourceHash: 'hash'});
  assert.equal(result.status, 'needs_mapping');
  assert.equal(result.recipeCandidate, null);
  assert.deepEqual(
    result.diagnostics.map(({pointer}) => pointer),
    [
      '/shots/0/background/src',
      '/shots/0/semanticRole',
      '/shots/0/texts/0/subjectId',
    ],
  );
});
