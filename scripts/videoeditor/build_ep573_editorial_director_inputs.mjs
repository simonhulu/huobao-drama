#!/usr/bin/env node

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const requestedSeconds = Number(process.argv[process.argv.indexOf('--seconds') + 1]);
const previewSeconds = Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? requestedSeconds : null;
const runLabel = previewSeconds ? `-${previewSeconds}s` : '';
const work = path.join(root, `.tmp/ep573-editorial-director${runLabel}`);
const sourcePropsPath = path.join(root, 'data', 'static', 'temp', 'grid-story-props-573.json');
const sourceProps = JSON.parse(readFileSync(sourcePropsPath, 'utf8'));
const fps = Number(sourceProps.fps) || 30;
const audioPath = path.join(work, 'narration-source.m4a');
const outputRoot = path.join(root, '.remotion-editorial-runs', `ep573${runLabel}`);
const adapterConfigPath = path.join(work, 'adapter-config.json');

const previewFrameLimit = previewSeconds ? Math.round(previewSeconds * fps) : null;
const shots = [];
let remainingFrames = previewFrameLimit;
for (const shot of sourceProps.shots) {
  if (remainingFrames !== null && remainingFrames <= 0) break;
  const durationInFrames = remainingFrames === null
    ? shot.durationInFrames
    : Math.min(shot.durationInFrames, remainingFrames);
  shots.push({...shot, durationInFrames});
  if (remainingFrames !== null) remainingFrames -= durationInFrames;
}

mkdirSync(work, {recursive: true});

const sha256 = (filePath) => crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex');
const probe = (filePath) => {
  const raw = execFileSync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], {encoding: 'utf8'});
  const data = JSON.parse(raw);
  const stream = data.streams?.find((item) => ['video', 'audio'].includes(item.codec_type)) ?? {};
  const metadata = {};
  if (stream.width) metadata.width = Number(stream.width);
  if (stream.height) metadata.height = Number(stream.height);
  if (stream.sample_rate) metadata.sampleRate = Number(stream.sample_rate);
  if (stream.channels) metadata.channels = Number(stream.channels);
  if (stream.codec_name) metadata.codec = stream.codec_name;
  if (stream.duration) metadata.durationSeconds = Number(stream.duration);
  if (stream.r_frame_rate && stream.r_frame_rate !== '0/0') {
    const [n, d] = stream.r_frame_rate.split('/').map(Number);
    if (n && d) metadata.frameRate = n / d;
  }
  metadata.mimeType = stream.codec_type === 'audio' ? 'audio/mp4' : 'image/png';
  return metadata;
};

if (!statSync(path.join(root, 'data', 'static', 'remotion', 'grid-story-ep573.mp4')).isFile()) {
  throw new Error('The existing Episode 573 render is required to extract the narration source.');
}
execFileSync('ffmpeg', [
  '-y', '-i', path.join(root, 'data', 'static', 'remotion', 'grid-story-ep573.mp4'),
  ...(previewSeconds ? ['-t', String(previewSeconds)] : []),
  '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', audioPath,
], {stdio: 'inherit'});

const visualAssets = shots.map((shot, index) => {
  const number = index + 1;
  const visualPath = number === 1
    ? path.join(root, 'remotion', 'public', 'grid-ep573', 'video', 'sb1.mp4')
    : path.join(root, 'remotion', 'public', 'grid-ep573', `sb${number}_cell1.png`);
  if (!statSync(visualPath).isFile()) throw new Error(`Missing visual asset for storyboard ${number}: ${visualPath}`);
  return {
    assetId: number === 1 ? 'ep573-opening-video' : `ep573-still-${String(number).padStart(3, '0')}`,
    kind: number === 1 ? 'video' : 'image',
    path: visualPath,
    source: number === 1 ? 'approved Grok opening video bound to storyboard 1' : `approved storyboard ${number} static image`,
    owner: 'huobao-drama episode 573',
    notes: number === 1 ? 'Reusable opening hook video; exact storyboard identity preserved.' : 'Static storyboard image passed structural review.',
  };
});

const assets = [...visualAssets, {
  assetId: 'ep573-narration',
  kind: 'audio',
  path: audioPath,
  source: 'existing Episode 573 grid render audio track',
  owner: 'huobao-drama episode 573',
  notes: 'Used only as the locked narration/BGM source and conformed by the director.',
}].map((asset) => {
  const stats = statSync(asset.path);
  return {
    assetId: asset.assetId,
    kind: asset.kind,
    path: asset.path,
    sha256: sha256(asset.path),
    byteSize: stats.size,
    mediaMetadata: probe(asset.path),
    subjectIds: [asset.assetId],
    entityIds: [`episode-573-${asset.assetId}`],
    provenance: {source: asset.source, owner: asset.owner, notes: asset.notes},
    licenseStatus: 'project_owned',
  };
});

let frameCursor = 0;
const spans = shots.map((shot, index) => {
  const startFrame = frameCursor;
  frameCursor += shot.durationInFrames;
  return {
    spanId: `sb-${String(index + 1).padStart(3, '0')}`,
    startSeconds: startFrame / fps,
    endSeconds: frameCursor / fps,
    text: String(shot.narration || '').trim() || `Storyboard ${index + 1}`,
  };
});

const script = spans.map(({text}) => text).join('\n');
const inventoryPath = path.join(work, 'asset-inventory.json');
const timingPath = path.join(work, 'timed-transcript.json');
const scriptPath = path.join(work, 'narration.txt');
const manifestPath = path.join(work, 'manifest.json');
writeFileSync(inventoryPath, JSON.stringify({schemaVersion: 'editorial://schema/asset-inventory/v1', inventoryVersion: 1, assets}, null, 2));
writeFileSync(timingPath, JSON.stringify({
  schemaVersion: 'editorial://schema/timed-transcript/v1',
  durationSeconds: frameCursor / fps,
  spans,
}, null, 2));
writeFileSync(scriptPath, `${script}\n`);
writeFileSync(adapterConfigPath, JSON.stringify({
  adapterProtocolVersion: 1,
  command: ['node', 'scripts/videoeditor/remotion_editorial_adapter.mjs'],
  workspace: root,
  compositionId: 'MagnatesEditorial',
  environmentVariables: ['REMOTION_CACHE_DIR'],
}, null, 2));
writeFileSync(manifestPath, JSON.stringify({
  runSchemaVersion: 1,
  operation: 'produce',
  narration: {script: scriptPath, timing: timingPath, audio: audioPath},
  assets: inventoryPath,
  target: {
    profile: {profileId: 'youtube-720p', width: 1280, height: 720, fps: 30},
    outputPolicy: {
      container: 'mp4', codec: 'h264', pixelFormat: 'yuv420p', audioMode: 'required', audioCodec: 'aac',
      crf: 20, safeArea: {left: 0.05, right: 0.05, top: 0.05, bottom: 0.05},
      durationToleranceFrames: 0, audioToleranceFrames: 2, hardwareAcceleration: 'disabled',
    },
  },
  adapterConfig: adapterConfigPath,
  outputRoot,
  modelPolicy: {authoringMode: 'deterministic', reviewMode: 'deterministic'},
  policy: {adapterTimeoutSeconds: previewSeconds ? 900 : 1800, analysisTimeoutSeconds: 120, maxRunBytes: 9000000000},
}, null, 2));
console.log(JSON.stringify({manifestPath, inventoryPath, timingPath, audioPath, previewSeconds, durationInFrames: frameCursor, assetCount: assets.length}, null, 2));
