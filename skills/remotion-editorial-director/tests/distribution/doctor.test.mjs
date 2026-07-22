import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {runDoctor} from '../../scripts/doctor.mjs';

const makeSkill = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-doctor-'));
  await mkdir(path.join(root, 'agents'), {recursive: true});
  await mkdir(path.join(root, 'contracts'), {recursive: true});
  await writeFile(path.join(root, 'SKILL.md'), 'portable skill\n');
  await writeFile(path.join(root, 'agents/openai.yaml'), 'interface:\n  display_name: Test\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({version: '1.0.0'}));
  await writeFile(path.join(root, 'package-lock.json'), '{}\n');
  await writeFile(path.join(root, 'contracts/schema-registry.json'), '{"schemas":[]}\n');
  return root;
};

const healthyRunner = async (command, args) => {
  if (command === 'python3.12') return {code: 0, stderr: '', stdout: 'Python 3.12.9\n'};
  if (command === 'ffprobe') return {code: 0, stderr: '', stdout: 'ffprobe version 7.1.1\n'};
  if (command === 'ffmpeg' && args[0] === '-filters') {
    return {code: 0, stderr: '', stdout: 'blackframe signalstats scale fps aresample\n'};
  }
  if (command === 'ffmpeg' && args[0] === '-encoders') {
    return {code: 0, stderr: '', stdout: ' V....D libx264 H.264\n A....D aac AAC\n'};
  }
  if (command === 'ffmpeg') return {code: 0, stderr: '', stdout: 'ffmpeg version 7.1.1\n'};
  throw new Error(`Unexpected command ${command} ${args.join(' ')}`);
};

test('doctor passes required portable runtime checks', async () => {
  const skillRoot = await makeSkill();
  const report = await runDoctor({
    commandRunner: healthyRunner,
    forbiddenRoots: ['/original/repository', '/Users/developer'],
    skillRoot,
  });
  assert.equal(report.status, 'ok');
  assert.equal(report.productionBlocked, false);
  assert.ok(report.checks.every(({status}) => status === 'passed'));
});

test('doctor reports old media tools and absolute path contamination as blocking', async () => {
  const skillRoot = await makeSkill();
  await writeFile(path.join(skillRoot, 'SKILL.md'), 'load /original/repository/private/file\n');
  const report = await runDoctor({
    commandRunner: async (command, args) => {
      const result = await healthyRunner(command, args);
      if (command === 'ffmpeg' && args[0] === '-version') result.stdout = 'ffmpeg version 6.1\n';
      return result;
    },
    forbiddenRoots: ['/original/repository'],
    skillRoot,
  });
  assert.equal(report.status, 'error');
  assert.equal(report.productionBlocked, true);
  assert.deepEqual(
    report.checks.filter(({status}) => status === 'failed').map(({id}) => id),
    ['path-independence', 'ffmpeg-version'],
  );
});

test('doctor includes configured adapter negotiation and optional render smoke checks', async () => {
  const skillRoot = await makeSkill();
  const adapterConfigPath = path.join(skillRoot, 'adapter.json');
  await writeFile(adapterConfigPath, '{}\n');
  const calls = [];
  const report = await runDoctor({
    adapterConfigPath,
    adapterVerifier: async (options) => {
      calls.push(options);
      return {checks: [{
        blocking: true,
        command: null,
        expected: 'ok',
        id: 'adapter-render-smoke',
        message: null,
        observed: 'ok',
        status: 'passed',
      }]};
    },
    commandRunner: healthyRunner,
    renderSmoke: true,
    skillRoot,
  });
  assert.equal(report.status, 'ok');
  assert.equal(report.checks.at(-1).id, 'adapter-render-smoke');
  assert.equal(calls[0].renderSmoke, true);
});
