import assert from 'node:assert/strict';
import test from 'node:test';

import {evaluateDeterministicQa} from '../../scripts/lib/qa/deterministic-qa.mjs';

const validInput = () => ({
  mediaFacts: {
    audioSampleRate: 48000,
    decodable: true,
    durationSeconds: 3,
    fps: 30,
    frameCount: 90,
    hasAudio: true,
    height: 720,
    unintendedBlackRuns: [],
    width: 1280,
  },
  policy: {audioMode: 'required', safeAreaInset: 0.05},
  recipe: {
    durationInFrames: 90,
    fps: 30,
    shots: [{durationInFrames: 90, id: 'shot-1'}],
  },
  target: {fps: 30, height: 720, width: 1280},
  telemetry: {
    frames: Array.from({length: 90}, (_, frame) => ({frame, layers: []})),
  },
});

test('deterministic QA reports a complete passing structural gate', () => {
  const report = evaluateDeterministicQa(validInput());
  assert.equal(report.status, 'passed');
  assert.ok(report.checks.every((check) => check.status === 'passed'));
});

test('deterministic QA reports all blocking failures without short-circuiting', () => {
  const input = validInput();
  input.mediaFacts.decodable = false;
  input.mediaFacts.frameCount = 89;
  input.mediaFacts.hasAudio = false;
  input.mediaFacts.unintendedBlackRuns = [{startFrame: 10, endFrame: 15}];
  input.telemetry.frames.pop();
  const report = evaluateDeterministicQa(input);
  assert.equal(report.status, 'failed');
  assert.deepEqual(
    report.checks.filter(({status}) => status === 'failed').map(({id}) => id),
    ['media-decode', 'frame-count', 'audio-policy', 'black-frame', 'telemetry-coverage'],
  );
});
