import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, stat, utimes, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {cleanupRuns, parseRetentionDuration} from '../../scripts/lib/maintenance/cleanup.mjs';

test('cleanup is preview-only by default and preserves lock/evidence metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-cleanup-'));
  const run = path.join(root, 'run-old');
  await mkdir(path.join(run, 'evidence'), {recursive: true});
  await mkdir(path.join(run, 'render'), {recursive: true});
  await writeFile(path.join(run, 'run.json'), '{}\n');
  await writeFile(path.join(run, 'evidence', 'outline.json'), '{}\n');
  await writeFile(path.join(run, 'render', 'final.mp4'), 'media');
  await utimes(run, new Date(0), new Date(0));
  const preview = await cleanupRuns({now: 10_000, olderThan: '1s', outputRoot: root});
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.candidates.map(({path: candidate}) => path.basename(candidate)), ['final.mp4']);
  assert.equal(await readFile(path.join(run, 'render', 'final.mp4'), 'utf8'), 'media');
  const applied = await cleanupRuns({apply: true, now: 10_000, olderThan: '1s', outputRoot: root});
  assert.equal(applied.reclaimedBytes, 5);
  await assert.rejects(stat(path.join(run, 'render', 'final.mp4')), (error) => error.code === 'ENOENT');
  assert.equal(await readFile(path.join(run, 'run.json'), 'utf8'), '{}\n');
});
test('cleanup skips active runs and rejects ambiguous durations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-cleanup-'));
  const run = path.join(root, 'run-active');
  await mkdir(path.join(run, '.run.lock'), {recursive: true});
  await writeFile(path.join(run, 'large.bin'), 'content');
  await utimes(run, new Date(0), new Date(0));
  assert.equal((await cleanupRuns({now: 10_000, olderThan: '1s', outputRoot: root})).candidates.length, 0);
  assert.throws(() => parseRetentionDuration('one week'), {code: 'CLEANUP_DURATION_INVALID'});
});
