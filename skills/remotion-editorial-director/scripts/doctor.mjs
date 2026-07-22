#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {canonicalizePayload} from './lib/canonical-json.mjs';
import {createContractValidator} from './lib/contract-validator.mjs';
import {verifyProjectAdapter} from './lib/doctor-adapter.mjs';

const ignored = new Set(['node_modules', '.venv', '__pycache__', '.DS_Store']);
const requiredFiles = [
  'SKILL.md',
  'agents/openai.yaml',
  'package.json',
  'package-lock.json',
  'contracts/schema-registry.json',
];
const requiredFilters = ['blackframe', 'signalstats', 'scale', 'fps', 'aresample'];
const requiredEncoders = [
  {id: 'h264', patterns: ['libx264', ' h264_']},
  {id: 'aac', patterns: [' aac ']},
];

const defaultCommandRunner = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, {shell: false, stdio: ['ignore', 'pipe', 'pipe']});
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', (error) => resolve({code: null, error, stderr: '', stdout: ''}));
  child.on('close', (code) => resolve({
    code,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  }));
});

const versionFrom = (text) => {
  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/u);
  return match ? match.slice(1).map((part) => Number(part ?? 0)) : null;
};
const versionAtLeast = (actual, required) => {
  if (!actual) return false;
  for (let index = 0; index < required.length; index += 1) {
    if ((actual[index] ?? 0) > required[index]) return true;
    if ((actual[index] ?? 0) < required[index]) return false;
  }
  return true;
};
const outcome = (id, ok, {command = null, expected, observed, message}) => ({
  blocking: true,
  command,
  expected,
  id,
  message: ok ? null : message,
  observed,
  status: ok ? 'passed' : 'failed',
});

const listSourceFiles = async (root, current = root) => {
  const files = [];
  for (const entry of await readdir(current, {withFileTypes: true})) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listSourceFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files;
};

const checkRequiredTree = async (skillRoot) => {
  const missing = [];
  for (const relative of requiredFiles) {
    try {
      if (!(await stat(path.join(skillRoot, relative))).isFile()) missing.push(relative);
    } catch {
      missing.push(relative);
    }
  }
  return outcome('required-tree', missing.length === 0, {
    expected: requiredFiles,
    observed: {missing},
    message: `Missing required Skill files: ${missing.join(', ')}`,
  });
};

const checkPathIndependence = async (skillRoot, forbiddenRoots) => {
  const contaminated = [];
  for (const relative of await listSourceFiles(skillRoot)) {
    const bytes = await readFile(path.join(skillRoot, relative));
    const text = bytes.toString('utf8');
    if (forbiddenRoots.some((root) => root && text.includes(root))) contaminated.push(relative);
  }
  return outcome('path-independence', contaminated.length === 0, {
    expected: 'no canonical repository or developer-home absolute paths',
    observed: {contaminatedFiles: contaminated},
    message: `Installed files contain forbidden absolute paths: ${contaminated.join(', ')}`,
  });
};

const commandVersionCheck = async ({id, command, args, required, runner}) => {
  const result = await runner(command, args);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const version = versionFrom(output);
  const ok = result.code === 0 && versionAtLeast(version, required);
  return outcome(id, ok, {
    command: [command, ...args],
    expected: required.join('.'),
    observed: {exitCode: result.code, version},
    message: `${command} ${required.join('.')} or later is required`,
  });
};

export const runDoctor = async ({
  adapterConfigPath,
  adapterVerifier = verifyProjectAdapter,
  skillRoot,
  commandRunner = defaultCommandRunner,
  forbiddenRoots = (process.env.EDITORIAL_FORBIDDEN_ROOTS ?? '').split(path.delimiter).filter(Boolean),
  renderSmoke = false,
}) => {
  const resolvedRoot = path.resolve(skillRoot);
  const checks = [];
  checks.push(await checkRequiredTree(resolvedRoot));
  checks.push(await checkPathIndependence(resolvedRoot, forbiddenRoots));
  checks.push(outcome('node-version', versionAtLeast(versionFrom(process.version), [20, 0, 0]), {
    command: ['node', '--version'],
    expected: '20.0.0',
    observed: process.version,
    message: 'Node 20 or later is required',
  }));
  checks.push(await commandVersionCheck({
    args: ['--version'], command: 'python3.12', id: 'python-version', required: [3, 12, 0], runner: commandRunner,
  }));
  checks.push(await commandVersionCheck({
    args: ['-version'], command: 'ffmpeg', id: 'ffmpeg-version', required: [7, 1, 0], runner: commandRunner,
  }));
  checks.push(await commandVersionCheck({
    args: ['-version'], command: 'ffprobe', id: 'ffprobe-version', required: [7, 1, 0], runner: commandRunner,
  }));
  const filterResult = await commandRunner('ffmpeg', ['-filters']);
  const filterOutput = `${filterResult.stdout ?? ''}\n${filterResult.stderr ?? ''}`;
  const missingFilters = requiredFilters.filter((filter) => !filterOutput.includes(filter));
  checks.push(outcome('ffmpeg-filters', filterResult.code === 0 && missingFilters.length === 0, {
    command: ['ffmpeg', '-filters'],
    expected: requiredFilters,
    observed: {exitCode: filterResult.code, missing: missingFilters},
    message: `ffmpeg is missing required filters: ${missingFilters.join(', ')}`,
  }));
  const encoderResult = await commandRunner('ffmpeg', ['-encoders']);
  const encoderOutput = `${encoderResult.stdout ?? ''}\n${encoderResult.stderr ?? ''}`;
  const missingEncoders = requiredEncoders
    .filter(({patterns}) => !patterns.some((pattern) => encoderOutput.includes(pattern)))
    .map(({id}) => id);
  checks.push(outcome('ffmpeg-encoders', encoderResult.code === 0 && missingEncoders.length === 0, {
    command: ['ffmpeg', '-encoders'],
    expected: requiredEncoders.map(({id}) => id),
    observed: {exitCode: encoderResult.code, missing: missingEncoders},
    message: `ffmpeg is missing required encoders: ${missingEncoders.join(', ')}`,
  }));
  let canonicalOk = false;
  let canonicalObserved = {testedVectors: 0};
  try {
    let vectors;
    try {
      vectors = JSON.parse(await readFile(path.join(resolvedRoot, 'fixtures/json/rfc8785-vectors.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      vectors = [{
        canonical: '{"a":333333333.3333333,"z":1e+30}',
        input: {z: 1e30, a: 333333333.33333329},
      }];
    }
    canonicalOk = vectors.every((vector) => {
      const canonical = canonicalizePayload(vector.input);
      return canonical === vector.canonical && (!vector.sha256 ||
        createHash('sha256').update(canonical).digest('hex') === vector.sha256);
    });
    canonicalObserved = {testedVectors: vectors.length};
  } catch {
    canonicalOk = false;
  }
  checks.push(outcome('jcs-canonicalizer', canonicalOk, {
    command: null,
    expected: 'all bundled RFC 8785 vectors and digests',
    observed: canonicalObserved,
    message: 'RFC 8785 canonicalizer failed a bundled vector',
  }));
  let registryOk = false;
  let registryObserved = {schemaCount: 0};
  try {
    const registry = JSON.parse(await readFile(path.join(resolvedRoot, 'contracts/schema-registry.json'), 'utf8'));
    if (!Array.isArray(registry.schemas)) throw new Error('schema registry requires schemas array');
    await createContractValidator({contractsDirectory: path.join(resolvedRoot, 'contracts')});
    registryObserved = {schemaCount: registry.schemas.length};
    registryOk = true;
  } catch {
    registryOk = false;
  }
  checks.push(outcome('schema-registry', registryOk, {
    command: null,
    expected: 'registered schemas load and compile without ID mismatch',
    observed: registryObserved,
    message: 'Contract schema registry is missing, invalid, or cannot compile',
  }));
  if (adapterConfigPath) {
    try {
      const adapterReport = await adapterVerifier({
        adapterConfigPath,
        contractsDirectory: path.join(resolvedRoot, 'contracts'),
        renderSmoke,
      });
      checks.push(...adapterReport.checks);
    } catch (error) {
      checks.push(outcome('adapter-capabilities', false, {
        command: null,
        expected: 'valid adapter config and successful capability negotiation',
        observed: {code: error.code ?? 'INTERNAL_ERROR'},
        message: error.message,
      }));
    }
  }
  const productionBlocked = checks.some(({blocking, status}) => blocking && status === 'failed');
  return {
    checks,
    productionBlocked,
    skillRoot: resolvedRoot,
    status: productionBlocked ? 'error' : 'ok',
  };
};

const parseArguments = (arguments_) => {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === '--skill-root') options.skillRoot = arguments_[++index];
    else if (arguments_[index] === '--adapter-config') options.adapterConfigPath = arguments_[++index];
    else if (arguments_[index] === '--render-smoke') options.renderSmoke = true;
    else if (arguments_[index] === '--json') options.json = true;
    else throw new Error(`Unknown doctor argument: ${arguments_[index]}`);
  }
  return options;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const skillRoot = options.skillRoot ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const report = await runDoctor({
    adapterConfigPath: options.adapterConfigPath,
    renderSmoke: options.renderSmoke,
    skillRoot,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    for (const check of report.checks) {
      process.stdout.write(`${check.status === 'passed' ? 'PASS' : 'FAIL'} ${check.id}\n`);
    }
  }
  if (report.productionBlocked) process.exitCode = 3;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
