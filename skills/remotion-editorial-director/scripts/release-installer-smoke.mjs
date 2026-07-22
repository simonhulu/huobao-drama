#!/usr/bin/env node

import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = process.argv[2];
if (!source) throw new Error('usage: release-installer-smoke.mjs <skill-source>');

const installer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.mjs');
const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-installer-smoke-'));
const target = path.join(root, 'installed-skill');

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer, 'install', '--source', path.resolve(source), '--target', target, '--json'], {
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(root, {force: true, recursive: true});
}
