import assert from 'node:assert/strict';
import {mkdtemp, readFile, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {hashFile} from '../../scripts/lib/media-facts-cache.mjs';
import {snapshotAssetInventory} from '../../scripts/lib/asset-snapshot.mjs';

const asset = (sourcePath, sha256, byteSize) => ({
  assetId: 'asset-1',
  byteSize,
  entityIds: ['entity-1'],
  kind: 'image',
  licenseStatus: 'project_owned',
  mediaMetadata: {height: 1, mimeType: 'image/png', width: 1},
  path: sourcePath,
  provenance: {owner: 'test', source: 'fixture'},
  sha256,
  subjectIds: ['entity-1'],
});

test('asset snapshot is content-addressed and independent from later source mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-snapshot-'));
  const sourcePath = path.join(root, 'source.png');
  await writeFile(sourcePath, 'original-image-bytes');
  const sha256 = await hashFile(sourcePath);
  const inventory = {
    assets: [asset('source.png', sha256, 20)],
    inventoryVersion: 1,
    schemaVersion: 'editorial://schema/asset-inventory/v1',
  };
  const staged = await snapshotAssetInventory({
    inventory,
    inventoryDirectory: root,
    runDirectory: path.join(root, 'run'),
  });
  assert.equal(staged.assets[0].sha256, sha256);
  assert.match(staged.assets[0].path, /assets\/sha256\/[a-f0-9]{64}\/asset\.png$/);
  await writeFile(sourcePath, 'changed-source-bytes');
  assert.equal(await readFile(staged.assets[0].path, 'utf8'), 'original-image-bytes');
});

test('asset snapshot rejects hash drift and symbolic-link sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-snapshot-invalid-'));
  const sourcePath = path.join(root, 'source.png');
  await writeFile(sourcePath, 'bytes');
  const base = {
    assets: [asset('source.png', 'a'.repeat(64), 5)],
    inventoryVersion: 1,
    schemaVersion: 'editorial://schema/asset-inventory/v1',
  };
  await assert.rejects(
    snapshotAssetInventory({inventory: base, inventoryDirectory: root, runDirectory: path.join(root, 'run-a')}),
    (error) => error.code === 'ASSET_HASH_MISMATCH',
  );
  const linkPath = path.join(root, 'linked.png');
  await symlink(sourcePath, linkPath);
  const sha256 = await hashFile(sourcePath);
  await assert.rejects(
    snapshotAssetInventory({
      inventory: {...base, assets: [asset('linked.png', sha256, 5)]},
      inventoryDirectory: root,
      runDirectory: path.join(root, 'run-b'),
    }),
    (error) => error.code === 'ASSET_SYMLINK_FORBIDDEN',
  );
});
