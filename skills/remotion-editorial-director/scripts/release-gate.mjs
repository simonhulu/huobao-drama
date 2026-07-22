#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const skillRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(path.dirname(skillRoot));
const skillPrefix = path.relative(repositoryRoot, skillRoot);
const node = process.execPath;
const npm = process.env.npm_execpath ?? 'npm';
const remotionRoot = path.join(repositoryRoot, 'remotion');
const remotionTypeScript = path.join(remotionRoot, 'node_modules/.bin/tsc');
const projectAdapterConfig = path.join(skillRoot, 'fixtures/json/adapter-config-project.json');
const pythonTestRunner = path.join(skillPrefix, 'scripts/release-python-tests.mjs');

export const GATE_NAMES = Object.freeze(['fast', 'integration', 'render-lock', 'release-eval']);
export const SKILL_TEST_GROUPS = Object.freeze([
  'authoring',
  'contracts',
  'director',
  'distribution',
  'media',
  'qa',
  'release',
  'runtime',
]);

const testFiles = async (groups) => {
  const files = [];
  for (const group of groups) {
    const directory = path.join(skillRoot, 'tests', group);
    let entries;
    try {
      entries = await readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        files.push(path.join(skillPrefix, 'tests', group, entry.name));
      }
    }
  }
  return files.sort();
};

const directoryTestFiles = async (directory) => {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => path.relative(repositoryRoot, path.join(directory, entry.name)))
    .sort();
};

const nodeTests = (id, groups) => ({id, command: node, args: ['--test'], testGroups: groups});
const nodeTestsIn = (id, directory) => ({id, command: node, args: ['--test'], testDirectory: directory});

const BASE_DEFINITIONS = Object.freeze({
  fast: [
    {id: 'generated-contracts', command: node, args: [path.join(skillPrefix, 'tests/contracts/generate-contracts.mjs'), '--check']},
    {id: 'skill-typecheck', command: npm, args: ['run', 'typecheck'], cwd: skillRoot},
    nodeTests('node-unit', SKILL_TEST_GROUPS),
    {id: 'scoped-coverage', command: node, args: [
      '--experimental-test-coverage',
      '--test-coverage-lines=100',
      '--test-coverage-functions=100',
      '--test-coverage-branches=100',
      `--test-coverage-include=${path.join(skillPrefix, 'scripts/lib/workflow-definition.mjs')}`,
      '--test',
      path.join(skillPrefix, 'tests/runtime/workflow-definition.test.mjs'),
    ]},
    nodeTestsIn('videoeditor-pure', path.join(repositoryRoot, 'scripts/videoeditor')),
    {id: 'python-unit', command: node, args: [pythonTestRunner]},
    {id: 'remotion-typecheck', command: remotionTypeScript, args: ['--noEmit', '-p', 'tsconfig.json'], cwd: remotionRoot},
    {id: 'remotion-editorial-tests', command: npm, args: ['run', 'test:editorial'], cwd: remotionRoot},
  ],
  integration: [
    nodeTests('node-integration', SKILL_TEST_GROUPS),
    {id: 'doctor-720p-render-smoke', command: node, args: [
      path.join(skillPrefix, 'scripts/doctor.mjs'),
      '--skill-root', skillRoot,
      '--adapter-config', projectAdapterConfig,
      '--render-smoke',
      '--json',
    ]},
    {id: 'installer-smoke', command: node, args: [
      path.join(skillPrefix, 'scripts/release-installer-smoke.mjs'),
      skillRoot,
    ]},
    {id: 'python-integration', command: node, args: [pythonTestRunner]},
  ],
  'render-lock': [
    {id: 'render-lock-manifest', command: node, args: ['--test', path.join(skillPrefix, 'tests/release/render-lock.test.mjs')]},
  ],
  'release-eval': [
    nodeTests('replay-eval', ['authoring', 'qa']),
    {id: 'release-eval-manifest', command: node, args: ['--test', path.join(skillPrefix, 'tests/release/release-eval.test.mjs')]},
  ],
});

export const gateDefinition = (name) => {
  if (!GATE_NAMES.includes(name)) throw new Error(`Unknown release gate: ${name}`);
  return BASE_DEFINITIONS[name].map((step) => ({...step, args: [...step.args]}));
};

const materialize = async (name) => {
  const definitions = gateDefinition(name);
  const steps = [];
  for (const step of definitions) {
    if (step.testGroups) {
      const files = await testFiles(step.testGroups);
      steps.push({id: step.id, command: step.command, args: [...step.args, ...files], ...(step.cwd ? {cwd: step.cwd} : {})});
    } else if (step.testDirectory) {
      const files = await directoryTestFiles(step.testDirectory);
      steps.push({id: step.id, command: step.command, args: [...step.args, ...files], ...(step.cwd ? {cwd: step.cwd} : {})});
    } else {
      steps.push({...step, args: [...step.args]});
    }
  }
  return steps;
};

const runCommand = ({command, args, cwd, env}) => new Promise((resolve) => {
  const child = spawn(command, args, {cwd, env, shell: false, stdio: 'inherit'});
  child.on('error', (error) => resolve({exitCode: null, error: error.message}));
  child.on('close', (exitCode, signal) => resolve({exitCode, signal: signal ?? null}));
});

const evidenceGateStep = (gate, step, env) => {
  if (gate === 'render-lock' && step.id === 'render-lock-manifest') {
    const required = [
      'EDITORIAL_RENDER_LOCK_MANIFEST',
      'EDITORIAL_RENDER_LOCK_RENDER_MANIFEST',
      'EDITORIAL_RENDER_LOCK_MEDIA',
    ];
    const missing = required.filter((name) => !env[name]);
    if (missing.length > 0) {
      return {id: step.id, status: 'blocked', reason: `required render-lock evidence is not configured: ${missing.join(', ')}`};
    }
  }
  if (gate === 'release-eval' && step.id === 'release-eval-manifest' && !env.EDITORIAL_RELEASE_EVAL_MANIFEST) {
    return {id: step.id, status: 'blocked', reason: 'EDITORIAL_RELEASE_EVAL_MANIFEST is not configured'};
  }
  return null;
};

export const runGate = async (name, {cwd = repositoryRoot, env = process.env, execute = runCommand} = {}) => {
  const steps = await materialize(name);
  const results = [];
  for (const step of steps) {
    const evidence = evidenceGateStep(name, step, env);
    if (evidence) {
      results.push(evidence);
      continue;
    }
    const result = await execute({command: step.command, args: step.args, cwd: step.cwd ?? cwd, env: {...env}});
    results.push({
      id: step.id,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      ...(result.signal ? {signal: result.signal} : {}),
      ...(result.error ? {error: result.error} : {}),
    });
    if (result.exitCode !== 0) break;
  }
  const failed = results.some(({status}) => status === 'failed');
  const blocked = results.some(({status}) => status === 'blocked');
  const skipped = results.some(({status}) => status === 'skipped');
  return {
    gate: name,
    status: failed ? 'failed' : blocked ? 'blocked' : skipped ? 'skipped' : 'passed',
    steps: results,
  };
};

const parseArguments = (arguments_) => {
  const [name, ...rest] = arguments_;
  const options = {json: false, name};
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--json') options.json = true;
    else throw new Error(`Unknown release gate argument: ${rest[index]}`);
  }
  if (!GATE_NAMES.includes(name)) throw new Error(`Usage: release-gate.mjs <${GATE_NAMES.join('|')}> [--json]`);
  return options;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const report = await runGate(options.name);
  if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    process.stdout.write(`${report.status.toUpperCase()} ${report.gate}\n`);
    for (const step of report.steps) {
      process.stdout.write(`  ${step.status.toUpperCase()} ${step.id}${step.reason ? `: ${step.reason}` : ''}\n`);
    }
  }
  if (report.status === 'failed') process.exitCode = 1;
  if (report.status === 'blocked') process.exitCode = 3;
};

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
