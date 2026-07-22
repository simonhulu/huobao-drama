import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {runDirectorOperation} from '../../scripts/director.mjs';
import {hashFile} from '../../scripts/lib/media-facts-cache.mjs';

const stubSource = String.raw`#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const mediaFixture = process.argv[2];
const mode = process.argv[3] ?? 'pass';
const adapter = {name: 'director-test-adapter', version: '1.0.0'};
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
};
const hashPayload = (value) => hash(canonical(value));
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const bytes = Buffer.from(canonical(value) + '\n');
  fs.writeFileSync(filePath, bytes);
  return hash(bytes);
};
const artifact = (type, filePath, schemaId) => ({
  path: filePath,
  schemaId,
  sha256: hash(fs.readFileSync(filePath)),
  type,
});
const tool = (name) => ({path: '/tmp/' + name, sha256: hash(name), version: '1.0.0'});
const capabilities = {
  adapter,
  architecture: undefined,
  audioModes: ['required', 'optional', 'forbidden'],
  compositionIds: ['TestComposition'],
  environmentIdentity: {
    adapterConfigHash: hash('config'),
    adapterExecutableHash: hash('adapter'),
    architecture: process.arch === 'x64' ? 'x64' : 'arm64',
    browser: tool('browser'),
    ffmpeg: tool('ffmpeg'),
    ffprobe: tool('ffprobe'),
    fontHashes: {'Test.font': hash('font')},
    nodeVersion: process.version,
    os: process.platform === 'linux' ? 'linux' : 'darwin',
    packageLockHash: hash('package-lock'),
    remotion: tool('remotion'),
    supportedCodecs: ['h264', 'aac'],
  },
  operations: ['capabilities', 'build-props', 'render', 'inspect'],
  recipeSchemaVersions: ['magnates-remotion-recipe-v2'],
  schemaDigests: {'editorial://schema/adapter-request/v1': hash('request-schema')},
  supportedProtocolVersions: [1],
  targetProfiles: [{fps: 30, height: 720, profileId: 'youtube-720p', width: 1280}],
  telemetryFields: [
    'layerId', 'frameInterval', 'boundingBox', 'opacity', 'transform', 'maskBounds',
    'assetId', 'decodeStatus',
  ],
};
delete capabilities.architecture;

const readRequest = async () => {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
};

const request = await readRequest();
let artifacts = [];
let returnedCapabilities = null;
if (request.operation === 'capabilities') {
  returnedCapabilities = capabilities;
} else if (request.operation === 'build-props') {
  const recipe = JSON.parse(fs.readFileSync(request.inputs.recipePayload, 'utf8'));
  const narration = request.inputs.narrationConform
    ? JSON.parse(fs.readFileSync(request.inputs.narrationConform, 'utf8'))
    : null;
  const audioAssetId = narration?.status === 'conformed' ? 'narration-conformed' : null;
  const props = {
    assetBindings: audioAssetId ? {
      [audioAssetId]: {
        kind: 'audio',
        path: narration.output.path,
        sha256: narration.output.sha256,
      },
    } : {},
    compositionId: 'TestComposition',
    durationInFrames: recipe.durationInFrames,
    fps: recipe.fps,
    projectPropsSchemaId: 'editorial://test/props/v1',
    props: {audioAssetId, audioUrl: narration?.output?.path ?? null},
    recipeHash: hashPayload(recipe),
    recipeSchemaVersion: 'magnates-remotion-recipe-v2',
    schemaVersion: 'editorial://schema/remotion-props/v1',
    target: request.target,
  };
  writeJson(request.outputs.props, props);
  writeJson(request.outputs.buildTelemetry, {operationId: request.operationId});
  artifacts = [
    artifact('remotion-props', request.outputs.props, 'editorial://schema/remotion-props/v1'),
    artifact('build-telemetry', request.outputs.buildTelemetry, 'editorial://schema/build-telemetry/v1'),
  ];
} else if (request.operation === 'render') {
  const props = JSON.parse(fs.readFileSync(request.inputs.props, 'utf8'));
  const environment = JSON.parse(fs.readFileSync(request.inputs.rendererEnvironmentLock, 'utf8'));
  fs.mkdirSync(path.dirname(request.outputs.media), {recursive: true});
  fs.copyFileSync(mediaFixture, request.outputs.media);
  const mediaHash = hash(fs.readFileSync(request.outputs.media));
  writeJson(request.outputs.renderTelemetry, {operationId: request.operationId});
  const now = '2026-07-22T00:00:00.000Z';
  const manifest = {
    adapter,
    compositionId: 'TestComposition',
    environmentLockHash: hash(fs.readFileSync(request.inputs.rendererEnvironmentLock)),
    layerIntervals: {'background:main': {endFrame: props.durationInFrames, startFrame: 0}},
    media: {frameCount: props.durationInFrames, path: request.outputs.media, sha256: mediaHash},
    operationId: request.operationId,
    outputSettings: environment.outputPolicy,
    processTiming: {durationMilliseconds: 1, endedAt: now, startedAt: now},
    propsHash: request.inputs.propsHash,
    recipeHash: props.recipeHash,
    schemaVersion: 'editorial://schema/render-manifest/v1',
    target: request.target,
    telemetryLimits: {
      maximumFramePacketBytes: 1048576,
      maximumRawTelemetryBytes: 1048576,
      maximumRenderedFrames: props.durationInFrames,
      maximumVisibleLayersPerFrame: 10,
    },
  };
  writeJson(request.outputs.renderManifest, manifest);
  artifacts = [
    artifact('media', request.outputs.media, 'editorial://schema/media/v1'),
    artifact('render-manifest', request.outputs.renderManifest, 'editorial://schema/render-manifest/v1'),
    artifact('render-telemetry', request.outputs.renderTelemetry, 'editorial://schema/render-telemetry/v1'),
  ];
} else {
  const manifest = JSON.parse(fs.readFileSync(request.inputs.renderManifest, 'utf8'));
  const layout = {
    coordinateSpace: {
      geometryUnits: 'normalized_output',
      intervalSemantics: 'zero_based_start_inclusive_end_exclusive',
      origin: 'top_left',
      rotationUnits: 'degrees_clockwise',
      translationUnits: 'output_pixels',
    },
    frameCount: manifest.media.frameCount,
    layers: [{
      interval: {endFrame: manifest.media.frameCount, startFrame: 0},
      kind: 'background',
      layerId: 'background:main',
      runs: [{
        endFrame: manifest.media.frameCount,
        sample: {
          boundingBox: {height: 1, width: 1, x: 0, y: 0},
          decodeStatus: 'not_applicable',
          maskBounds: null,
          opacity: 1,
          transform: {rotation: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0},
          transformOrigin: {x: 0.5, y: 0.5},
        },
        startFrame: 0,
      }],
      sampling: 'constant',
      sourceAsset: null,
    }],
    operationId: request.operationId,
    schemaVersion: 'editorial://schema/layout-telemetry/v1',
    target: request.target,
  };
  writeJson(request.outputs.layoutTelemetry, layout);
  const report = {
    assetDecodeResults: [],
    decodeStatus: mode === 'qa-fail' ? 'failed' : 'decoded',
    frameCount: manifest.media.frameCount,
    inspectedAt: '2026-07-22T00:00:00.000Z',
    layoutTelemetry: {
      path: request.outputs.layoutTelemetry,
      sha256: hash(fs.readFileSync(request.outputs.layoutTelemetry)),
    },
    media: {path: request.inputs.media, sha256: hash(fs.readFileSync(request.inputs.media))},
    operationId: request.operationId,
    renderManifestHash: hash(fs.readFileSync(request.inputs.renderManifest)),
    schemaVersion: 'editorial://schema/inspect-report/v1',
    streams: [{
      codec: 'h264',
      durationSeconds: manifest.media.frameCount / request.target.fps,
      height: request.target.height,
      index: 0,
      kind: 'video',
      width: request.target.width,
    }, ...(manifest.outputSettings.audioMode === 'forbidden' ? [] : [{
      channels: 2,
      codec: 'aac',
      durationSeconds: manifest.media.frameCount / request.target.fps,
      index: 1,
      kind: 'audio',
      sampleRate: 48000,
    }])],
    warnings: [],
  };
  writeJson(request.outputs.inspectReport, report);
  artifacts = [
    artifact('inspect-report', request.outputs.inspectReport, 'editorial://schema/inspect-report/v1'),
    artifact('layout-telemetry', request.outputs.layoutTelemetry, 'editorial://schema/layout-telemetry/v1'),
  ];
}

process.stdout.write(JSON.stringify({
  adapter,
  adapterProtocolVersion: 1,
  artifacts,
  capabilities: returnedCapabilities,
  error: null,
  operation: request.operation,
  operationId: request.operationId,
  status: 'ok',
  telemetry: {},
  warnings: [],
}) + '\n');
`;

const target = {
  outputPolicy: {
    audioMode: 'optional',
    codec: 'h264',
    container: 'mp4',
    pixelFormat: 'yuv420p',
    safeArea: {bottom: 0.05, left: 0.05, right: 0.05, top: 0.05},
    videoBitrate: '2M',
  },
  profile: {fps: 30, height: 720, profileId: 'youtube-720p', width: 1280},
};

const writeProductionFixture = async (t) => {
  const available = spawnSync('ffmpeg', ['-version'], {encoding: 'utf8'});
  if (available.status !== 0) {
    t.skip(`ffmpeg is required for real-media Director coverage: ${available.stderr || available.error}`);
    return null;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-production-'));
  const mediaPath = path.join(root, 'fixture.mp4');
  const generated = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=1280x720:r=30:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mediaPath,
  ], {encoding: 'utf8'});
  assert.equal(generated.status, 0, generated.stderr);
  const narrationPath = path.join(root, 'narration.wav');
  const generatedNarration = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '1', '-c:a', 'pcm_s16le', narrationPath,
  ], {encoding: 'utf8'});
  assert.equal(generatedNarration.status, 0, generatedNarration.stderr);
  const adapterPath = path.join(root, 'stub-adapter.mjs');
  await writeFile(adapterPath, stubSource);
  await chmod(adapterPath, 0o755);
  await writeFile(path.join(root, 'adapter.json'), JSON.stringify({
    adapterProtocolVersion: 1,
    command: [process.execPath, adapterPath, mediaPath],
    compositionId: 'TestComposition',
    workspace: '.',
  }));
  const assetPath = path.join(root, 'asset.bin');
  await writeFile(assetPath, 'production-fixture');
  await writeFile(path.join(root, 'assets.json'), JSON.stringify({
    assets: [{
      assetId: 'asset-main',
      byteSize: 18,
      entityIds: ['entity-main'],
      kind: 'image',
      licenseStatus: 'project_owned',
      mediaMetadata: {height: 720, mimeType: 'image/png', width: 1280},
      path: 'asset.bin',
      provenance: {owner: 'test', source: 'fixture'},
      sha256: await hashFile(assetPath),
      subjectIds: ['entity-main'],
    }],
    inventoryVersion: 1,
    schemaVersion: 'editorial://schema/asset-inventory/v1',
  }));
  await writeFile(path.join(root, 'script.md'), 'A deterministic production fixture.');
  await writeFile(path.join(root, 'timing.json'), JSON.stringify({
    durationSeconds: 1,
    schemaVersion: 'editorial://schema/timed-transcript/v1',
    spans: [{
      endSeconds: 1,
      spanId: 'span-1',
      startSeconds: 0,
      text: 'A deterministic production fixture.',
    }],
  }));
  return root;
};

test('produce and render-recipe complete through deterministic QA with real media', async (t) => {
  const root = await writeProductionFixture(t);
  if (!root) return;
  const produceManifestPath = path.join(root, 'produce.json');
  await writeFile(produceManifestPath, JSON.stringify({
    adapterConfig: 'adapter.json',
    assets: 'assets.json',
    modelPolicy: {authoringMode: 'deterministic', reviewMode: 'deterministic'},
    narration: {script: 'script.md', timing: 'timing.json'},
    operation: 'produce',
    outputRoot: 'produce-runs',
    runSchemaVersion: 1,
    target,
  }));

  const produced = await runDirectorOperation({manifestPath: produceManifestPath, operation: 'produce'});
  assert.equal(produced.exitCode, 0, JSON.stringify(produced.error));
  assert.equal(produced.terminalStage, 'QA_PASSED');
  const produceRun = JSON.parse(await readFile(produced.runPath, 'utf8'));
  const qaReport = JSON.parse(await readFile(produceRun.artifacts['qa-report'].path, 'utf8'));
  assert.equal(qaReport.deterministicStatus, 'pass');
  assert.equal(qaReport.mediaHash, produceRun.artifacts['final-media'].sha256);
  assert.equal(qaReport.layoutTelemetryHash, produceRun.artifacts['layout-telemetry'].sha256);
  assert.equal(qaReport.checks.every(({status}) => status === 'pass'), true);

  const renderManifestPath = path.join(root, 'render-recipe.json');
  await writeFile(renderManifestPath, JSON.stringify({
    adapterConfig: 'adapter.json',
    operation: 'render-recipe',
    outputRoot: 'render-runs',
    recipeLock: produceRun.artifacts['recipe-lock'].path,
    runSchemaVersion: 1,
    target,
  }));
  const rendered = await runDirectorOperation({manifestPath: renderManifestPath, operation: 'render-recipe'});
  assert.equal(rendered.exitCode, 0, JSON.stringify(rendered.error));
  assert.equal(rendered.terminalStage, 'QA_PASSED');
  const renderRun = JSON.parse(await readFile(rendered.runPath, 'utf8'));
  assert.equal(renderRun.artifacts['final-media'].sha256, produceRun.artifacts['final-media'].sha256);
  assert.notEqual(renderRun.artifacts['recipe-payload'].path, produceRun.artifacts['recipe-payload'].path);
  assert.equal(
    JSON.parse(await readFile(renderRun.artifacts['qa-report'].path, 'utf8')).deterministicStatus,
    'pass',
  );
});

test('deterministic QA failure returns exit 6 and preserves render evidence', async (t) => {
  const root = await writeProductionFixture(t);
  if (!root) return;
  const adapter = JSON.parse(await readFile(path.join(root, 'adapter.json'), 'utf8'));
  adapter.command.push('qa-fail');
  await writeFile(path.join(root, 'adapter.json'), JSON.stringify(adapter));
  const manifestPath = path.join(root, 'qa-failure.json');
  await writeFile(manifestPath, JSON.stringify({
    adapterConfig: 'adapter.json',
    assets: 'assets.json',
    modelPolicy: {authoringMode: 'deterministic', reviewMode: 'deterministic'},
    narration: {script: 'script.md', timing: 'timing.json'},
    operation: 'produce',
    outputRoot: 'failure-runs',
    runSchemaVersion: 1,
    target,
  }));

  const result = await runDirectorOperation({manifestPath, operation: 'produce'});
  assert.equal(result.exitCode, 6, JSON.stringify(result.error));
  assert.equal(result.error.code, 'DETERMINISTIC_QA_FAILED');
  const run = JSON.parse(await readFile(result.runPath, 'utf8'));
  assert.ok(run.artifacts['rendered-media']);
  assert.ok(run.artifacts['render-manifest']);
  assert.ok(run.artifacts['qa-report']);
  assert.equal(run.artifacts['final-media'], undefined);
  const report = JSON.parse(await readFile(run.artifacts['qa-report'].path, 'utf8'));
  assert.equal(report.deterministicStatus, 'fail');
  assert.equal(report.checks.find(({checkId}) => checkId === 'media-decode').status, 'fail');
});

test('required narration is bound into props and inherited by render-recipe', async (t) => {
  const root = await writeProductionFixture(t);
  if (!root) return;
  const requiredTarget = structuredClone(target);
  requiredTarget.outputPolicy.audioMode = 'required';
  requiredTarget.outputPolicy.audioCodec = 'aac';
  const produceManifestPath = path.join(root, 'produce-audio.json');
  await writeFile(produceManifestPath, JSON.stringify({
    adapterConfig: 'adapter.json',
    assets: 'assets.json',
    modelPolicy: {authoringMode: 'deterministic', reviewMode: 'deterministic'},
    narration: {audio: 'narration.wav', script: 'script.md', timing: 'timing.json'},
    operation: 'produce',
    outputRoot: 'produce-audio-runs',
    runSchemaVersion: 1,
    target: requiredTarget,
  }));

  const produced = await runDirectorOperation({manifestPath: produceManifestPath, operation: 'produce'});
  assert.equal(produced.exitCode, 0, JSON.stringify(produced.error));
  const produceRun = JSON.parse(await readFile(produced.runPath, 'utf8'));
  const produceProps = JSON.parse(await readFile(produceRun.artifacts['remotion-props'].path, 'utf8'));
  assert.equal(produceProps.props.audioAssetId, 'narration-conformed');

  const renderManifestPath = path.join(root, 'render-recipe-audio.json');
  await writeFile(renderManifestPath, JSON.stringify({
    adapterConfig: 'adapter.json',
    operation: 'render-recipe',
    outputRoot: 'render-audio-runs',
    recipeLock: produceRun.artifacts['recipe-lock'].path,
    runSchemaVersion: 1,
    target: requiredTarget,
  }));
  const rendered = await runDirectorOperation({manifestPath: renderManifestPath, operation: 'render-recipe'});
  assert.equal(rendered.exitCode, 0, JSON.stringify(rendered.error));
  const renderRun = JSON.parse(await readFile(rendered.runPath, 'utf8'));
  const renderProps = JSON.parse(await readFile(renderRun.artifacts['remotion-props'].path, 'utf8'));
  assert.equal(renderProps.props.audioAssetId, 'narration-conformed');
  const inheritedConform = JSON.parse(await readFile(renderRun.artifacts['narration-conform'].path, 'utf8'));
  assert.equal(inheritedConform.sourceHash, produceRun.artifacts['conformed-narration'].sha256);
});
