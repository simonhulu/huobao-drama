import {randomUUID} from 'node:crypto';
import {chmod, copyFile, link, lstat, mkdir, rm, stat} from 'node:fs/promises';
import path from 'node:path';

import {hashFile} from './media-facts-cache.mjs';

const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  category: 4,
  code,
  exitCode: 4,
  ...fields,
});

const fingerprint = ({ctimeMs, dev, ino, mtimeMs, size}) => ({ctimeMs, dev, ino, mtimeMs, size});
const sameFingerprint = (left, right) => Object.keys(left).every((key) => left[key] === right[key]);

const sourcePathFor = (inventoryDirectory, candidate) => {
  if (typeof candidate !== 'string' || candidate.length === 0 || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|data:)/u.test(candidate)) {
    throw codedError('ASSET_PATH_INVALID', 'Asset path must be a non-empty local path');
  }
  return path.resolve(inventoryDirectory, candidate);
};

const snapshotOne = async ({asset, inventoryDirectory, runDirectory}) => {
  const sourcePath = sourcePathFor(inventoryDirectory, asset.path);
  const sourceLinkStat = await lstat(sourcePath);
  if (sourceLinkStat.isSymbolicLink()) {
    throw codedError('ASSET_SYMLINK_FORBIDDEN', `Symbolic-link asset sources are forbidden: ${sourcePath}`);
  }
  if (!sourceLinkStat.isFile()) {
    throw codedError('ASSET_NOT_REGULAR_FILE', `Asset source is not a regular file: ${sourcePath}`);
  }
  const before = fingerprint(await stat(sourcePath));
  if (before.size !== asset.byteSize) {
    throw codedError('ASSET_SIZE_MISMATCH', `Asset byte size changed: ${asset.assetId}`);
  }

  const extension = path.extname(sourcePath).toLowerCase() || '.bin';
  const destinationDirectory = path.join(runDirectory, 'assets', 'sha256', asset.sha256);
  const destination = path.join(destinationDirectory, `asset${extension}`);
  await mkdir(destinationDirectory, {recursive: true});

  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== asset.byteSize ||
      await hashFile(destination) !== asset.sha256) {
      throw codedError('ASSET_SNAPSHOT_CORRUPT', `Existing snapshot is invalid: ${destination}`);
    }
    return {...asset, path: destination};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = path.join(destinationDirectory, `.asset-${process.pid}-${randomUUID()}.tmp`);
  try {
    await copyFile(sourcePath, temporary);
    const after = fingerprint(await stat(sourcePath));
    if (!sameFingerprint(before, after)) {
      throw codedError('ASSET_SOURCE_CHANGED', `Asset changed while being copied: ${asset.assetId}`);
    }
    const copiedHash = await hashFile(temporary);
    if (copiedHash !== asset.sha256) {
      throw codedError('ASSET_HASH_MISMATCH', `Asset hash does not match inventory: ${asset.assetId}`, {
        actualHash: copiedHash,
        expectedHash: asset.sha256,
      });
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existingHash = await hashFile(destination);
      if (existingHash !== asset.sha256) {
        throw codedError('ASSET_SNAPSHOT_CORRUPT', `Concurrent snapshot is invalid: ${destination}`);
      }
    }
    await chmod(destination, 0o444);
  } finally {
    await rm(temporary, {force: true});
  }
  return {...asset, path: destination};
};

export const snapshotAssetInventory = async ({inventory, inventoryDirectory, runDirectory}) => ({
  ...inventory,
  assets: await Promise.all(inventory.assets.map((asset) => snapshotOne({
    asset,
    inventoryDirectory,
    runDirectory,
  }))),
});
