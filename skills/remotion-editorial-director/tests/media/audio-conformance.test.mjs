import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {
  buildAudioConformArgs,
  conformNarration,
  expectedAudioSamples,
} from '../../scripts/lib/media/audio-conformance.mjs';

const execFileAsync = promisify(execFile);

test('audio conformance derives an exact 48 kHz sample count from frames', () => {
  assert.equal(expectedAudioSamples({durationInFrames: 300, fps: 30}), 480000);
  assert.deepEqual(
    buildAudioConformArgs({
      durationInFrames: 300,
      fps: 30,
      inputPath: '/input/narration.wav',
      outputPath: '/run/narration.pcm.wav',
    }),
    [
      '-hide_banner', '-nostdin', '-y',
      '-i', '/input/narration.wav',
      '-vn', '-ac', '2', '-ar', '48000',
      '-af', 'aresample=48000:async=0:first_pts=0,apad,atrim=end_sample=480000',
      '-c:a', 'pcm_s16le', '/run/narration.pcm.wav',
    ],
  );
});

test('audio conformance rejects timelines that cannot map to whole samples', () => {
  assert.throws(
    () => expectedAudioSamples({durationInFrames: 1, fps: 29}),
    (error) => error.code === 'AUDIO_SAMPLE_COUNT_NON_INTEGER',
  );
});

test('audio conformance produces exact decoded samples with host ffmpeg', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editorial-audio-conform-'));
  const inputPath = path.join(root, 'short.wav');
  const outputPath = path.join(root, 'exact.wav');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=0.4',
    inputPath,
  ]);
  const result = await conformNarration({
    durationInFrames: 30,
    fps: 30,
    inputPath,
    outputPath,
  });
  assert.equal(result.sampleRate, 48000);
  assert.equal(result.sampleCount, 48000);
  assert.equal(result.channels, 2);
});
