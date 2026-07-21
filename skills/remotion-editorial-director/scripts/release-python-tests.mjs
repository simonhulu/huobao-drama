#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const skillRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testArguments = [
  '-m', 'unittest', 'discover',
  '-s', path.join(skillRoot, 'tests/python'),
  '-p', 'test_*.py',
];

const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {shell: false, stdio: 'inherit'});
  child.on('error', reject);
  child.on('close', (code) => resolve(code ?? 1));
});

const configuredPython = process.env.EDITORIAL_PYTHON;
if (configuredPython) {
  process.exitCode = await run(configuredPython, testArguments);
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-python-tests-'));
  try {
    const created = await run('python3.12', ['-m', 'venv', root]);
    if (created !== 0) process.exitCode = created;
    else {
      const python = path.join(root, 'bin', 'python');
      const installed = await run(python, [
        '-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes',
        '-r', path.join(skillRoot, 'python/requirements.lock'),
      ]);
      process.exitCode = installed === 0 ? await run(python, testArguments) : installed;
    }
  } finally {
    await rm(root, {force: true, recursive: true});
  }
}
