import {randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {canonicalizePayload, hashPayload} from './canonical-json.mjs';
import {acquireRunLock} from './run-lock.mjs';

const canonicalJson = (value) => `${canonicalizePayload(value)}\n`;

const codedError = (code, message) => Object.assign(new Error(message), {code});

const resolveInside = (root, relativePath) => {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw codedError('PATH_OUTSIDE_RUN', 'Artifact path must be a non-empty relative path');
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw codedError('PATH_OUTSIDE_RUN', `Artifact path escapes the run: ${relativePath}`);
  }
  return resolved;
};

const atomicWrite = async (destination, contents, {exclusive = false} = {}) => {
  await mkdir(path.dirname(destination), {recursive: true});
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, {flag: 'wx'});
    if (exclusive) {
      const handle = await open(destination, 'wx');
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
      await rm(temporary, {force: true});
      return;
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
};

export class RunStore {
  static async open(root, metadata) {
    const resolvedRoot = path.resolve(root);
    await mkdir(resolvedRoot, {recursive: true});
    const runLock = await acquireRunLock(resolvedRoot, {command: metadata.command});
    return new RunStore(resolvedRoot, metadata, runLock);
  }

  constructor(root, metadata, runLock) {
    this.root = root;
    this.metadata = {...metadata};
    this.runLock = runLock;
    this.run = null;
    this.closed = false;
  }

  async initialize(details) {
    this.#assertOpen();
    await this.runLock.verify();
    this.run = {
      artifacts: [],
      command: this.metadata.command,
      currentStage: 'INITIALIZED',
      operation: details.operation,
      runId: this.metadata.runId,
    };
    await atomicWrite(path.join(this.root, 'run.json'), canonicalJson(this.run));
  }

  async promoteJson(relativePath, value) {
    this.#assertOpen();
    await this.runLock.verify();
    const destination = resolveInside(this.root, relativePath);
    const contents = canonicalJson(value);
    try {
      await atomicWrite(destination, contents, {exclusive: true});
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw codedError(
          'IMMUTABLE_DESTINATION_EXISTS',
          `Immutable artifact already exists: ${relativePath}`,
        );
      }
      throw error;
    }
    return {
      contentHash: hashPayload(value),
      mediaType: 'application/json',
      path: path.relative(this.root, destination),
      size: Buffer.byteLength(contents),
    };
  }

  async commitStage({stage, artifacts = []}) {
    this.#assertOpen();
    await this.runLock.verify();
    if (!this.run) {
      throw codedError('RUN_NOT_INITIALIZED', 'RunStore.initialize() must be called first');
    }
    this.run = {
      ...this.run,
      artifacts: [...this.run.artifacts, ...artifacts],
      currentStage: stage,
    };
    await atomicWrite(path.join(this.root, 'run.json'), canonicalJson(this.run));
  }

  async commitRun(run) {
    this.#assertOpen();
    await this.runLock.verify();
    this.run = structuredClone(run);
    await atomicWrite(path.join(this.root, 'run.json'), canonicalJson(this.run));
  }

  async readRun() {
    return JSON.parse(await readFile(path.join(this.root, 'run.json'), 'utf8'));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.runLock.release();
  }

  #assertOpen() {
    if (this.closed) {
      throw codedError('RUN_STORE_CLOSED', 'RunStore is closed');
    }
  }
}

export {canonicalJson};
