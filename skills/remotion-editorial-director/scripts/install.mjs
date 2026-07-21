#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const ignoredSegments = new Set(['node_modules', '.venv', '__pycache__', '.DS_Store']);
const manifestName = '.install-manifest.json';
const divergenceName = '.preserved-divergence.json';
const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  ...fields,
});
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const shouldInclude = (source, candidate) => {
  const relative = path.relative(source, candidate);
  if (relative === '') return true;
  return !relative.split(path.sep).some((segment) =>
    ignoredSegments.has(segment) || segment === manifestName || segment === divergenceName,
  );
};

const listFiles = async (root, current = root) => {
  const entries = await readdir(current, {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (ignoredSegments.has(entry.name) || entry.name === manifestName || entry.name === divergenceName) {
      continue;
    }
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw codedError('INVALID_INSTALL_SOURCE', `Symbolic links are not portable: ${absolute}`, {exitCode: 2});
    }
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files;
};

const buildManifest = async (root) => {
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await stat(path.join(root, 'SKILL.md'));
    await stat(path.join(root, 'agents/openai.yaml'));
    await stat(path.join(root, 'package-lock.json'));
  } catch (error) {
    throw codedError('INVALID_INSTALL_SOURCE', 'Skill source is missing required package files', {
      cause: error,
      exitCode: 2,
    });
  }
  if (typeof packageMetadata.version !== 'string' || packageMetadata.version.length === 0) {
    throw codedError('INVALID_INSTALL_SOURCE', 'Skill package.json requires a version', {exitCode: 2});
  }
  const files = {};
  for (const relative of await listFiles(root)) {
    files[relative] = hash(await readFile(path.join(root, relative)));
  }
  return {files, manifestVersion: 1, version: packageMetadata.version};
};

const readManifest = async (root) => {
  try {
    return JSON.parse(await readFile(path.join(root, manifestName), 'utf8'));
  } catch (error) {
    throw codedError('INSTALL_MANIFEST_INVALID', `Cannot read install manifest under ${root}`, {
      cause: error,
      exitCode: 3,
    });
  }
};

const readRecordedDivergence = async (root) => {
  try {
    return new Set(JSON.parse(await readFile(path.join(root, divergenceName), 'utf8')).files);
  } catch {
    return new Set();
  }
};

const findDivergence = async (root, manifest, {allowRecorded = false} = {}) => {
  const recorded = allowRecorded ? await readRecordedDivergence(root) : new Set();
  const diverged = [];
  for (const [relative, expectedHash] of Object.entries(manifest.files)) {
    try {
      if (hash(await readFile(path.join(root, relative))) !== expectedHash && !recorded.has(relative)) {
        diverged.push(relative);
      }
    } catch {
      if (!recorded.has(relative)) diverged.push(relative);
    }
  }
  return diverged.sort();
};

const sameManifest = (left, right) =>
  left.version === right.version && JSON.stringify(left.files) === JSON.stringify(right.files);

const runCommand = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {cwd, shell: false, stdio: 'inherit'});
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`${command} exited ${code}`));
  });
});

const defaultInstallDependencies = async (stage) => {
  try {
    await runCommand('npm', ['ci', '--omit=dev'], stage);
    const requirements = path.join(stage, 'python/requirements.lock');
    try {
      await stat(requirements);
      await runCommand('python3.12', ['-m', 'venv', '.venv'], stage);
      await runCommand(
        path.join(stage, '.venv/bin/python'),
        ['-m', 'pip', 'install', '--require-hashes', '-r', requirements],
        stage,
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } catch (error) {
    throw codedError('DEPENDENCY_INSTALL_FAILED', 'Failed to install locked Skill dependencies', {
      cause: error,
      exitCode: 5,
    });
  }
};

const resultEnvelope = ({
  action,
  target,
  sourceVersion = null,
  installedVersion = null,
  previousVersion = null,
  changedFiles = [],
  divergedFiles = [],
  rollbackPath = null,
}) => ({
  action,
  changedFiles,
  divergedFiles,
  error: null,
  installedVersion,
  previousVersion,
  rollbackPath,
  sourceVersion,
  status: 'ok',
  target,
});

const pathExists = async (candidate) => {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

export const installSkill = async ({
  source,
  target,
  forceDiverged = false,
  installDependencies = defaultInstallDependencies,
  failpoint,
}) => {
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);
  const parent = path.dirname(resolvedTarget);
  const rollbackPath = `${resolvedTarget}.rollback`;
  await mkdir(parent, {recursive: true});
  const sourceManifest = await buildManifest(resolvedSource);
  let installedManifest = null;
  let divergedFiles = [];
  if (await pathExists(resolvedTarget)) {
    installedManifest = await readManifest(resolvedTarget);
    divergedFiles = await findDivergence(resolvedTarget, installedManifest);
    if (divergedFiles.length > 0 && !forceDiverged) {
      throw codedError('INSTALLED_FILES_DIVERGED', 'Installed Skill has local modifications', {
        divergedFiles,
        exitCode: 4,
      });
    }
    if (divergedFiles.length === 0 && sameManifest(installedManifest, sourceManifest)) {
      return resultEnvelope({
        action: 'noop',
        installedVersion: installedManifest.version,
        previousVersion: installedManifest.version,
        sourceVersion: sourceManifest.version,
        target: resolvedTarget,
      });
    }
  }

  const stage = path.join(parent, `.${path.basename(resolvedTarget)}.stage-${randomUUID()}`);
  await cp(resolvedSource, stage, {
    filter: (candidate) => shouldInclude(resolvedSource, candidate),
    recursive: true,
  });
  try {
    await installDependencies(stage);
    await writeFile(path.join(stage, manifestName), `${JSON.stringify(sourceManifest)}\n`, {flag: 'wx'});
  } catch (error) {
    await rm(stage, {force: true, recursive: true});
    throw error;
  }

  let backedUp = false;
  try {
    if (installedManifest) {
      await rm(rollbackPath, {force: true, recursive: true});
      await rename(resolvedTarget, rollbackPath);
      backedUp = true;
      if (divergedFiles.length > 0) {
        await writeFile(
          path.join(rollbackPath, divergenceName),
          `${JSON.stringify({files: divergedFiles})}\n`,
        );
      }
    }
    if (failpoint === 'after-backup') throw new Error('Injected promotion failure');
    await rename(stage, resolvedTarget);
  } catch (error) {
    await rm(stage, {force: true, recursive: true});
    if (backedUp && !(await pathExists(resolvedTarget))) await rename(rollbackPath, resolvedTarget);
    throw codedError('INSTALL_PROMOTION_FAILED', 'Atomic Skill promotion failed', {
      cause: error,
      exitCode: 6,
    });
  }
  return resultEnvelope({
    action: installedManifest ? 'upgraded' : 'installed',
    changedFiles: Object.keys(sourceManifest.files).sort(),
    divergedFiles,
    installedVersion: sourceManifest.version,
    previousVersion: installedManifest?.version ?? null,
    rollbackPath: backedUp ? rollbackPath : null,
    sourceVersion: sourceManifest.version,
    target: resolvedTarget,
  });
};

export const uninstallSkill = async ({target, forceDiverged = false}) => {
  const resolvedTarget = path.resolve(target);
  const rollbackPath = `${resolvedTarget}.rollback`;
  const manifest = await readManifest(resolvedTarget);
  const divergedFiles = await findDivergence(resolvedTarget, manifest);
  if (divergedFiles.length > 0 && !forceDiverged) {
    throw codedError('INSTALLED_FILES_DIVERGED', 'Installed Skill has local modifications', {
      divergedFiles,
      exitCode: 4,
    });
  }
  await rm(rollbackPath, {force: true, recursive: true});
  await rename(resolvedTarget, rollbackPath);
  if (divergedFiles.length > 0) {
    await writeFile(path.join(rollbackPath, divergenceName), `${JSON.stringify({files: divergedFiles})}\n`);
  }
  return resultEnvelope({
    action: 'uninstalled',
    divergedFiles,
    previousVersion: manifest.version,
    rollbackPath,
    target: resolvedTarget,
  });
};

export const rollbackSkill = async ({target}) => {
  const resolvedTarget = path.resolve(target);
  const rollbackPath = `${resolvedTarget}.rollback`;
  const rollbackManifest = await readManifest(rollbackPath);
  const diverged = await findDivergence(rollbackPath, rollbackManifest, {allowRecorded: true});
  if (diverged.length > 0) {
    throw codedError('ROLLBACK_INVALID', 'Rollback copy failed manifest verification', {
      divergedFiles: diverged,
      exitCode: 6,
    });
  }
  const displaced = `${resolvedTarget}.displaced-${randomUUID()}`;
  const hasCurrent = await pathExists(resolvedTarget);
  try {
    if (hasCurrent) await rename(resolvedTarget, displaced);
    await rename(rollbackPath, resolvedTarget);
    if (hasCurrent) await rename(displaced, rollbackPath);
  } catch (error) {
    if (!(await pathExists(resolvedTarget)) && await pathExists(displaced)) {
      await rename(displaced, resolvedTarget);
    }
    throw codedError('ROLLBACK_FAILED', 'Atomic Skill rollback failed', {cause: error, exitCode: 6});
  }
  return resultEnvelope({
    action: 'rolled_back',
    installedVersion: rollbackManifest.version,
    rollbackPath: hasCurrent ? rollbackPath : null,
    target: resolvedTarget,
  });
};

const parseArguments = (arguments_) => {
  const [action, ...rest] = arguments_;
  const options = {action};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--force-diverged') options.forceDiverged = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--source' || argument === '--target') {
      options[argument.slice(2)] = rest[++index];
    } else throw codedError('INVALID_INSTALL_ARGUMENT', `Unknown installer argument: ${argument}`, {exitCode: 2});
  }
  return options;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const target = options.target ?? path.join(
    process.env.CODEX_HOME ?? path.join(process.env.HOME, '.codex'),
    'skills/remotion-editorial-director',
  );
  if (options.action === 'install') {
    if (!options.source) throw codedError('INVALID_INSTALL_ARGUMENT', 'install requires --source', {exitCode: 2});
    return installSkill({...options, target});
  }
  if (options.action === 'uninstall') return uninstallSkill({...options, target});
  if (options.action === 'rollback') return rollbackSkill({target});
  throw codedError('INVALID_INSTALL_ARGUMENT', `Unknown installer action: ${options.action}`, {exitCode: 2});
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({
      action: process.argv[2] ?? null,
      changedFiles: [],
      divergedFiles: error.divergedFiles ?? [],
      error: {code: error.code ?? 'INTERNAL_ERROR', message: error.message},
      installedVersion: null,
      previousVersion: null,
      rollbackPath: null,
      sourceVersion: null,
      status: 'error',
      target: null,
    })}\n`);
    process.exitCode = error.exitCode ?? 6;
  });
}
