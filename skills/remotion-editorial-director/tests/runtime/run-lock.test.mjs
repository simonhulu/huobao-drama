import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {acquireRunLock} from '../../scripts/lib/run-lock.mjs';

test('run lock reports its owner and verifies the writer token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-lock-'));
  const lock = await acquireRunLock(root, {command: 'first'});
  await lock.verify();
  await assert.rejects(
    acquireRunLock(root, {command: 'second'}),
    (error) => error.code === 'RUN_LOCKED' && error.owner.command === 'first',
  );
  const ownerPath = path.join(root, '.run.lock', 'owner.json');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  await writeFile(ownerPath, JSON.stringify({...owner, token: 'replaced'}));
  await assert.rejects(lock.verify(), (error) => error.code === 'RUN_LOCK_TOKEN_LOST');
  await assert.rejects(lock.release(), (error) => error.code === 'RUN_LOCK_TOKEN_LOST');
});

test('same-host dead-owner locks are preserved in diagnostics and reclaimed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-stale-lock-'));
  const lockDirectory = path.join(root, '.run.lock');
  await mkdir(lockDirectory);
  await writeFile(path.join(lockDirectory, 'owner.json'), JSON.stringify({
    command: 'crashed',
    host: os.hostname(),
    pid: 2147483647,
    token: 'stale-token',
  }));

  const lock = await acquireRunLock(root, {command: 'recovery'});
  const diagnostics = path.join(root, 'diagnostics');
  const entries = await import('node:fs/promises').then(({readdir}) => readdir(diagnostics));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^stale-run-lock-/);
  await lock.release();
});

test('foreign-host locks are never reclaimed automatically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-foreign-lock-'));
  const lockDirectory = path.join(root, '.run.lock');
  await mkdir(lockDirectory);
  await writeFile(path.join(lockDirectory, 'owner.json'), JSON.stringify({
    command: 'remote',
    host: 'another-host.invalid',
    pid: 2147483647,
    token: 'remote-token',
  }));
  await assert.rejects(
    acquireRunLock(root, {command: 'local'}),
    (error) => error.code === 'RUN_LOCKED' && error.owner.host === 'another-host.invalid',
  );
});
