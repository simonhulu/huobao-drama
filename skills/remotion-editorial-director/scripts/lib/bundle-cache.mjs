import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';

const requiredIdentityFields = [
  'sourceTreeHash',
  'dependencyLockHash',
  'generatedContractsHash',
  'bundlerHash',
  'node',
  'platform',
];

const canonicalJson = (value) => `${JSON.stringify(
  Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
)}\n`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const computeBundleKey = (identity) => {
  for (const field of requiredIdentityFields) {
    if (typeof identity[field] !== 'string' || identity[field].length === 0) {
      throw new TypeError(`Bundle identity requires ${field}`);
    }
  }
  return hash(canonicalJson(identity));
};

const listFiles = async (root, current = root) => {
  const entries = await readdir(current, {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolute));
    } else if (entry.isFile() && entry.name !== '.bundle-manifest.json') {
      files.push(path.relative(root, absolute));
    }
  }
  return files;
};

const createManifest = async (directory, key, identity) => {
  const files = {};
  for (const relative of await listFiles(directory)) {
    files[relative] = hash(await readFile(path.join(directory, relative)));
  }
  return {files, identity, key};
};

const validate = async (directory, key, identity) => {
  try {
    if (!(await stat(directory)).isDirectory()) return false;
    const manifest = JSON.parse(
      await readFile(path.join(directory, '.bundle-manifest.json'), 'utf8'),
    );
    if (manifest.key !== key || canonicalJson(manifest.identity) !== canonicalJson(identity)) {
      return false;
    }
    const actualFiles = await listFiles(directory);
    const expectedFiles = Object.keys(manifest.files).sort();
    if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) return false;
    for (const relative of expectedFiles) {
      if (hash(await readFile(path.join(directory, relative))) !== manifest.files[relative]) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

const acquireLock = async (lockPath) => {
  for (;;) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await sleep(20);
    }
  }
};

export const getOrBuildBundle = async ({cacheRoot, key, identity, build}) => {
  if (key !== computeBundleKey(identity)) {
    throw new Error('Bundle key does not match its complete identity');
  }
  await mkdir(cacheRoot, {recursive: true});
  const directory = path.join(cacheRoot, key);
  const lockPath = path.join(cacheRoot, `${key}.lock`);
  await acquireLock(lockPath);
  try {
    if (await validate(directory, key, identity)) {
      return {cacheHit: true, directory, key};
    }
    try {
      if ((await stat(directory)).isDirectory()) {
        await rename(directory, path.join(cacheRoot, `${key}.corrupt-${randomUUID()}`));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const temporary = path.join(cacheRoot, `${key}.build-${randomUUID()}`);
    await mkdir(temporary);
    try {
      await build(temporary);
      const manifest = await createManifest(temporary, key, identity);
      await writeFile(
        path.join(temporary, '.bundle-manifest.json'),
        canonicalJson(manifest),
        {flag: 'wx'},
      );
      await rename(temporary, directory);
    } catch (error) {
      await rm(temporary, {force: true, recursive: true});
      throw error;
    }
    return {cacheHit: false, directory, key};
  } finally {
    await rm(lockPath, {force: true, recursive: true});
  }
};
