import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value))}\n`;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const codedError = (code, message) => Object.assign(new Error(message), {code});

export const hashFile = (filePath) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  stream.on('error', reject);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('end', () => resolve(hash.digest('hex')));
});

const statIdentity = (value) => ({
  ctimeMs: value.ctimeMs,
  dev: value.dev,
  ino: value.ino,
  mtimeMs: value.mtimeMs,
  size: value.size,
});

export class VerificationLedger {
  constructor() {
    this.leases = new Map();
  }

  #key(filePath, expectedHash) {
    return `${path.resolve(filePath)}\0${expectedHash}`;
  }

  hasLease(filePath, expectedHash) {
    return this.leases.has(this.#key(filePath, expectedHash));
  }

  async hasValidLease(filePath, expectedHash) {
    const lease = this.leases.get(this.#key(filePath, expectedHash));
    if (!lease) return false;
    try {
      return canonicalJson(statIdentity(await stat(filePath))) === canonicalJson(lease.stat);
    } catch {
      return false;
    }
  }

  async authenticate(filePath, expectedHash) {
    const before = statIdentity(await stat(filePath));
    const actualHash = await hashFile(filePath);
    const after = statIdentity(await stat(filePath));
    if (canonicalJson(before) !== canonicalJson(after) || actualHash !== expectedHash) {
      this.leases.delete(this.#key(filePath, expectedHash));
      throw codedError(
        'STAGED_ASSET_HASH_MISMATCH',
        `Staged asset bytes do not match the expected hash: ${filePath}`,
      );
    }
    this.leases.set(this.#key(filePath, expectedHash), {stat: after});
  }
}

export const getOrComputeMediaFacts = async ({
  cacheRoot,
  mediaPath,
  expectedHash,
  identity,
  compute,
  ledger = new VerificationLedger(),
}) => {
  await ledger.authenticate(mediaPath, expectedHash);
  const key = digest(canonicalJson({expectedHash, identity}));
  const cachePath = path.join(cacheRoot, `${key}.json`);
  await mkdir(cacheRoot, {recursive: true});
  try {
    const record = JSON.parse(await readFile(cachePath, 'utf8'));
    if (
      record.expectedHash === expectedHash &&
      canonicalJson(record.identity) === canonicalJson(identity)
    ) {
      return {cacheHit: true, facts: record.facts, key};
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }

  const facts = await compute();
  const temporary = `${cachePath}.${process.pid}.tmp`;
  await writeFile(temporary, canonicalJson({expectedHash, facts, identity}));
  await rename(temporary, cachePath);
  return {cacheHit: false, facts, key};
};
