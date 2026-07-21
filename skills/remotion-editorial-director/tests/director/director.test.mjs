import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, utimes, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {hashFile} from '../../scripts/lib/media-facts-cache.mjs';
import {runDirectorOperation} from '../../scripts/director.mjs';

const directorPath = path.resolve('skills/remotion-editorial-director/scripts/director.mjs');

const writePlanFixture = async ({authoringMode = 'deterministic'} = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-director-'));
  const assetPath = path.join(root, 'image.png');
  await writeFile(assetPath, 'fixture-image');
  const assetHash = await hashFile(assetPath);
  await writeFile(path.join(root, 'script.md'), 'Yahoo changed direction.');
  await writeFile(path.join(root, 'timing.json'), JSON.stringify({
    durationSeconds: 1,
    schemaVersion: 'editorial://schema/timed-transcript/v1',
    spans: [{endSeconds: 1, spanId: 'span-1', startSeconds: 0, text: 'Yahoo changed direction.'}],
  }));
  await writeFile(path.join(root, 'assets.json'), JSON.stringify({
    assets: [{
      assetId: 'asset-yahoo',
      byteSize: 13,
      entityIds: ['entity-yahoo'],
      kind: 'image',
      licenseStatus: 'project_owned',
      mediaMetadata: {height: 720, mimeType: 'image/png', width: 1280},
      path: 'image.png',
      provenance: {owner: 'test', source: 'fixture'},
      sha256: assetHash,
      subjectIds: ['entity-yahoo'],
    }],
    inventoryVersion: 1,
    schemaVersion: 'editorial://schema/asset-inventory/v1',
  }));
  const manifest = {
    assets: 'assets.json',
    modelPolicy: {authoringMode, reviewMode: 'deterministic'},
    narration: {script: 'script.md', timing: 'timing.json'},
    operation: 'plan-edit',
    outputRoot: 'runs',
    runSchemaVersion: 1,
    target: {
      outputPolicy: {
        audioMode: 'optional',
        codec: 'h264',
        container: 'mp4',
        pixelFormat: 'yuv420p',
        safeArea: {bottom: 0.05, left: 0.05, right: 0.05, top: 0.05},
        videoBitrate: '2M',
      },
      profile: {fps: 30, height: 720, profileId: 'youtube-720p', width: 1280},
    },
  };
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return {manifestPath, root};
};

test('deterministic plan-edit produces a validated immutable v2 recipe lock', async () => {
  const {manifestPath} = await writePlanFixture();
  const result = await runDirectorOperation({manifestPath, operation: 'plan-edit'});
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'ok');
  assert.equal(result.terminalStage, 'RECIPE_VALIDATED');
  const run = JSON.parse(await readFile(result.runPath, 'utf8'));
  assert.equal(run.status, 'complete');
  assert.equal(run.stageAttempts.at(-1).stage, 'RECIPE_VALIDATED');
  const lock = JSON.parse(await readFile(run.artifacts['recipe-lock'].path, 'utf8'));
  assert.equal(lock.recipeSchemaVersion, 'magnates-remotion-recipe-v2');
  const recipe = JSON.parse(await readFile(lock.payloadPath, 'utf8'));
  assert.equal(recipe.durationInFrames, 30);
  assert.equal(recipe.shots[0].background.assetId, 'asset-yahoo');
});

test('agent plan-edit pauses, accepts one bound response, and resumes', async () => {
  const {manifestPath} = await writePlanFixture({authoringMode: 'agent'});
  const awaiting = await runDirectorOperation({manifestPath, operation: 'plan-edit'});
  assert.equal(awaiting.exitCode, 10);
  assert.equal(awaiting.status, 'awaiting_agent');
  const run = JSON.parse(await readFile(awaiting.runPath, 'utf8'));
  const requestPath = run.artifacts['agent-authoring-request'].path;
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const responsePath = path.join(path.dirname(manifestPath), 'agent-response.json');
  await writeFile(responsePath, JSON.stringify({
    attemptId: request.attemptId,
    createdAt: '2026-07-22T00:00:00.000Z',
    modelMetadata: {
      costKnown: false,
      model: 'gpt-test',
      parserVersion: '1.0.0',
      promptHash: 'a'.repeat(64),
      promptTemplateVersion: '1.0.0',
      provider: 'codex-host',
      rawResponseHash: 'b'.repeat(64),
      seedSupported: false,
      sessionId: 'session-test',
      temperature: 0,
    },
    payload: {
      authoringResult: {
        recipeCandidate: {
          durationInFrames: 30,
          fps: 30,
          schemaVersion: 'magnates-remotion-recipe-v2',
          shots: [{
            background: {assetId: 'asset-yahoo'},
            camera: {preset: 'hold'},
            durationInFrames: 30,
            id: 'shot:unit-span-1',
            semanticRole: 'hook',
          }],
        },
        schemaVersion: 'editorial://schema/authoring-result/v1',
        traceByNodeId: Object.fromEntries(['timing', 'background', 'camera'].map((field) => [
          `shot:shot:unit-span-1:${field}`,
          {
            assetIds: ['asset-yahoo'],
            evidenceClaimIds: [],
            fallback: 'hold',
            grammarRuleIds: ['default-hook'],
            rationale: 'Conservative agent-authored hold.',
            semanticUnitIds: ['unit-span-1'],
          },
        ])),
      },
    },
    requestHash: run.implementationVersions.agentRequestHash,
    requestId: request.requestId,
    responseId: 'response-test',
    runId: run.runId,
    schemaVersion: 'editorial://schema/agent-response/v1',
    stage: 'AUTHORING',
    status: 'ok',
  }));
  await writeFile(path.join(path.dirname(manifestPath), '.remotion-editorial-director.json'), JSON.stringify({
    outputRoot: 'runs',
  }));
  const accepted = spawnSync(process.execPath, [
    directorPath,
    'supply-agent-response',
    '--run', run.runId,
    '--stage', 'authoring',
    '--input', responsePath,
    '--json',
  ], {cwd: path.dirname(manifestPath), encoding: 'utf8'});
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).status, 'accepted');
  const resumed = await runDirectorOperation({manifestPath, operation: 'plan-edit', resume: run.runId});
  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.status, 'ok');
});

test('JSON CLI writes exactly one result object to stdout', async () => {
  const {manifestPath} = await writePlanFixture();
  const result = spawnSync(process.execPath, [directorPath, 'plan-edit', '--manifest', manifestPath, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stdout).status, 'ok');
});

test('project config supplies defaults before manifest validation', async () => {
  const {manifestPath, root} = await writePlanFixture();
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete manifest.outputRoot;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(root, '.git'), 'gitdir: elsewhere\n');
  await writeFile(path.join(root, '.remotion-editorial-director.json'), JSON.stringify({
    outputRoot: 'configured-runs',
  }));

  const result = await runDirectorOperation({manifestPath, operation: 'plan-edit'});

  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(path.dirname(path.dirname(result.runPath)), path.join(root, 'configured-runs'));
});

test('changed input on resume creates a superseding immutable run', async () => {
  const {manifestPath, root} = await writePlanFixture();
  const first = await runDirectorOperation({manifestPath, operation: 'plan-edit'});
  assert.equal(first.exitCode, 0, JSON.stringify(first.error));
  await writeFile(path.join(root, 'script.md'), 'Yahoo changed direction twice.');

  const revision = await runDirectorOperation({
    manifestPath,
    operation: 'plan-edit',
    resume: first.runId,
  });

  assert.equal(revision.exitCode, 0, JSON.stringify(revision.error));
  assert.notEqual(revision.runId, first.runId);
  const run = JSON.parse(await readFile(revision.runPath, 'utf8'));
  assert.equal(run.supersedesRunId, first.runId);
});

test('maintenance commands use the shared JSON result envelope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-maintenance-cli-'));
  const oldRun = path.join(root, 'runs', 'run-old');
  await mkdir(path.join(oldRun, 'render'), {recursive: true});
  await writeFile(path.join(oldRun, 'run.json'), '{}\n');
  await writeFile(path.join(oldRun, 'render', 'final.mp4'), 'fixture');
  await utimes(oldRun, new Date(0), new Date(0));
  const cleanup = spawnSync(process.execPath, [
    directorPath, 'cleanup', '--output-root', path.join(root, 'runs'), '--older-than', '1s', '--json',
  ], {encoding: 'utf8'});
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(JSON.parse(cleanup.stdout).operation, 'cleanup');

  const recipePath = path.join(root, 'recipe-v1.json');
  await writeFile(recipePath, await readFile(path.resolve(
    'skills/remotion-editorial-director/fixtures/json/recipe-v1-minimal.json',
  )));
  const migration = spawnSync(process.execPath, [
    directorPath, 'migrate', '--input', recipePath,
    '--to', 'magnates-remotion-recipe-v2', '--json',
  ], {encoding: 'utf8'});
  assert.equal(migration.status, 0, migration.stderr);
  assert.equal(JSON.parse(migration.stdout).status, 'needs_mapping');
});

test('analyze-reference probes video and produces fail-closed technique evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-analyze-'));
  const videoPath = path.join(root, 'reference.mp4');
  const ffmpeg = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
  ], {encoding: 'utf8'});
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  await writeFile(path.join(root, 'reference.srt'), [
    '1',
    '00:00:00,000 --> 00:00:00,900',
    'Yahoo changed direction.',
    '',
  ].join('\n'));
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    modelPolicy: {authoringMode: 'deterministic', reviewMode: 'deterministic'},
    operation: 'analyze-reference',
    outputRoot: 'runs',
    referenceCorpus: [{sourceId: 'reference-1', subtitles: 'reference.srt', video: 'reference.mp4'}],
    runSchemaVersion: 1,
  }));

  const result = await runDirectorOperation({manifestPath, operation: 'analyze-reference'});
  assert.equal(result.exitCode, 0, JSON.stringify(result.error));
  assert.equal(result.terminalStage, 'TECHNIQUES_CLASSIFIED');
  const run = JSON.parse(await readFile(result.runPath, 'utf8'));
  const techniques = JSON.parse(await readFile(run.artifacts['technique-annotations'].path, 'utf8'));
  assert.equal(techniques.payload.reviewStatus, 'needs_review');
  assert.equal(techniques.payload.claims[0].techniqueId, 'ambiguous');
  assert.ok(run.artifacts['boundary-samples-reference-1']);
});
