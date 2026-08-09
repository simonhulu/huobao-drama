import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {conformRemotionDelivery, probeDelivery, verifyDeliveryProbe} from './conform_remotion_delivery.mjs';

test('delivery conformance produces limited-range yuv420p and preserves AAC packets', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'remotion-delivery-'));
  const input = path.join(directory, 'input.mp4');
  const output = path.join(directory, 'output.mp4');
  try {
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '1',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv444p',
      '-color_range', 'pc',
      '-c:a', 'aac',
      '-shortest',
      '-y', input,
    ]);
    const result = conformRemotionDelivery({input, output, width: 320, height: 180, fps: 30, frames: 30});
    assert.equal(result.pixelFormat, 'yuv420p');
    assert.equal(result.colorRange, 'tv');
    assert.equal(result.audioCodec, 'aac');
    assert.match(result.audioPacketSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(verifyDeliveryProbe(probeDelivery(output), {width: 320, height: 180, fps: 30, frames: 30}), {
      width: 320,
      height: 180,
      fps: 30,
      frames: 30,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      colorRange: 'tv',
      audioCodec: 'aac',
      audioChannels: 1,
      audioSampleRate: 48000,
    });
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('delivery verification fails closed on full-range output', () => {
  assert.throws(() => verifyDeliveryProbe({streams: [
    {codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1', nb_read_frames: '2670', pix_fmt: 'yuv420p', color_range: 'pc'},
    {codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000'},
  ]}, {width: 1280, height: 720, fps: 30, frames: 2670}), /limited\/tv/);
});
