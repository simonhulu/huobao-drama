import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  ...fields,
});

const readOwner = async (ownerPath) => {
  try {
    return JSON.parse(await readFile(ownerPath, 'utf8'));
  } catch {
    return {host: null, pid: null, token: null, unreadable: true};
  }
};

const processIsAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};

const preserveStaleLock = async (root, lockDirectory) => {
  const diagnostics = path.join(root, 'diagnostics');
  await mkdir(diagnostics, {recursive: true});
  const destination = path.join(diagnostics, `stale-run-lock-${Date.now()}-${randomUUID()}`);
  await rename(lockDirectory, destination);
};

export const acquireRunLock = async (root, {command}) => {
  const resolvedRoot = path.resolve(root);
  const lockDirectory = path.join(resolvedRoot, '.run.lock');
  const ownerPath = path.join(lockDirectory, 'owner.json');
  await mkdir(resolvedRoot, {recursive: true});

  for (;;) {
    try {
      await mkdir(lockDirectory);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readOwner(ownerPath);
      if (owner.host === os.hostname() && !processIsAlive(owner.pid)) {
        try {
          await preserveStaleLock(resolvedRoot, lockDirectory);
          continue;
        } catch (moveError) {
          if (moveError.code === 'ENOENT') continue;
          throw moveError;
        }
      }
      throw codedError('RUN_LOCKED', `Run is locked by ${owner.command ?? 'an unknown writer'}`, {owner});
    }
  }

  const owner = {
    acquiredAt: new Date().toISOString(),
    command,
    host: os.hostname(),
    pid: process.pid,
    token: randomUUID(),
  };
  try {
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {flag: 'wx'});
  } catch (error) {
    await rm(lockDirectory, {force: true, recursive: true});
    throw error;
  }

  const verify = async () => {
    const current = await readOwner(ownerPath);
    if (current.token !== owner.token) {
      throw codedError('RUN_LOCK_TOKEN_LOST', 'Run writer no longer owns the lock', {
        currentOwner: current,
        owner,
      });
    }
  };
  return {
    directory: lockDirectory,
    owner,
    verify,
    async release() {
      await verify();
      await rm(lockDirectory, {recursive: true});
    },
  };
};
