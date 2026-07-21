import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const sha256 = /^[a-f0-9]{64}$/u;

test('render-lock evidence is explicit and structurally closed', async (context) => {
  const manifestPath = process.env.EDITORIAL_RENDER_LOCK_MANIFEST;
  const renderManifestPath = process.env.EDITORIAL_RENDER_LOCK_RENDER_MANIFEST;
  const mediaPath = process.env.EDITORIAL_RENDER_LOCK_MEDIA;
  if (!manifestPath || !renderManifestPath || !mediaPath) {
    context.skip('EDITORIAL_RENDER_LOCK_MANIFEST, EDITORIAL_RENDER_LOCK_RENDER_MANIFEST, and EDITORIAL_RENDER_LOCK_MEDIA are required');
    return;
  }
  const lockBytes = await readFile(path.resolve(manifestPath));
  const manifest = JSON.parse(lockBytes.toString('utf8'));
  assert.equal(manifest.schemaVersion, 'editorial://schema/renderer-environment-lock/v1');
  assert.match(manifest.lockId, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
  assert.match(manifest.capabilitiesHash, sha256);
  assert.ok(manifest.adapter && typeof manifest.adapter.name === 'string');
  assert.deepEqual(manifest.target, {fps: 30, height: 1080, profileId: 'youtube-1080p', width: 1920});
  assert.ok(manifest.outputPolicy && manifest.outputPolicy.container === 'mp4');
  assert.ok(manifest.environmentIdentity && typeof manifest.environmentIdentity.nodeVersion === 'string');
  assert.ok(manifest.schemaDigests && Object.keys(manifest.schemaDigests).length > 0);
  assert.equal(Number.isNaN(Date.parse(manifest.lockedAt)), false);

  const renderBytes = await readFile(path.resolve(renderManifestPath));
  const render = JSON.parse(renderBytes.toString('utf8'));
  assert.equal(render.schemaVersion, 'editorial://schema/render-manifest/v1');
  assert.deepEqual(render.target, manifest.target);
  assert.equal(render.environmentLockHash, createHash('sha256').update(lockBytes).digest('hex'));
  assert.equal(render.media.sha256, createHash('sha256').update(await readFile(path.resolve(mediaPath))).digest('hex'));
  assert.equal(path.resolve(render.media.path), path.resolve(mediaPath));

  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate,nb_frames:format=duration',
    '-of', 'json',
    path.resolve(mediaPath),
  ], {encoding: 'utf8'});
  assert.equal(probe.status, 0, probe.stderr || 'ffprobe failed');
  const facts = JSON.parse(probe.stdout);
  const video = facts.streams?.find(({codec_type}) => codec_type === 'video');
  assert.ok(video, '1080p smoke media must contain a video stream');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.equal(video.r_frame_rate, '30/1');
  assert.ok(Number(video.nb_frames ?? 0) > 0 || Number(facts.format?.duration ?? 0) > 0, '1080p smoke media must contain frames');
});
