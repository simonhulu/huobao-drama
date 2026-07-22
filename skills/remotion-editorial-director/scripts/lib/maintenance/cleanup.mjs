import {lstat, readdir, rm, stat} from 'node:fs/promises';
import path from 'node:path';

const durationPattern = /^(\d+)(ms|s|m|h|d|w)$/u;
const units = Object.freeze({d: 86400000, h: 3600000, m: 60000, ms: 1, s: 1000, w: 604800000});

export const parseRetentionDuration = (value) => {
  const match = durationPattern.exec(String(value));
  if (!match || Number(match[1]) <= 0) {
    throw Object.assign(new Error('older-than must be a positive duration such as 24h or 30d'), {
      code: 'CLEANUP_DURATION_INVALID',
      exitCode: 2,
    });
  }
  return Number(match[1]) * units[match[2]];
};
const protectedPath = (relative) => {
  const normalized = relative.split(path.sep).join('/');
  return normalized === 'run.json' || normalized.endsWith('.lock.json') ||
    normalized.startsWith('evidence/') || normalized.startsWith('recipe/') ||
    normalized.startsWith('agent/') || normalized.endsWith('.report.json') ||
    normalized.endsWith('.manifest.json');
};

const listFiles = async (root, current = root) => {
  const files = [];
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push({absolute, relative: path.relative(root, absolute)});
  }
  return files;
};

export const cleanupRuns = async ({
  apply = false,
  now = Date.now(),
  olderThan,
  outputRoot,
  preserveLocks = true,
}) => {
  const root = path.resolve(outputRoot);
  const cutoff = now - parseRetentionDuration(olderThan);
  const candidates = [];
  let entries;
  try {
    entries = await readdir(root, {withFileTypes: true});
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    entries = [];
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const runDirectory = path.join(root, entry.name);
    try {
      await lstat(path.join(runDirectory, '.run.lock'));
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const runStat = await stat(runDirectory);
    if (runStat.mtimeMs >= cutoff) continue;
    for (const file of await listFiles(runDirectory)) {
      if (preserveLocks && protectedPath(file.relative)) continue;
      const fileStat = await stat(file.absolute);
      candidates.push({bytes: fileStat.size, path: file.absolute, runId: entry.name});
    }
  }
  if (apply) {
    for (const candidate of candidates) await rm(candidate.path, {force: true});
  }
  return {
    applied: apply,
    artifacts: {},
    candidates,
    error: null,
    exitCode: 0,
    operation: 'cleanup',
    preserveLocks,
    reclaimedBytes: apply ? candidates.reduce((sum, {bytes}) => sum + bytes, 0) : 0,
    reclaimableBytes: candidates.reduce((sum, {bytes}) => sum + bytes, 0),
    status: 'ok',
    terminalStage: null,
    warnings: [],
  };
};
