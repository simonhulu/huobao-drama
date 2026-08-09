import assert from 'node:assert/strict';
import {readFileSync, rmSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  applyNarrativeStoryboardRecipe,
  buildNarrativeStoryboardDirectorInputs,
  flattenNarrativeStoryboardVisuals,
  truncateNarrativeStoryboardProps,
  validateNarrativeAudioPlan,
} from './narrative_storyboard_director_core.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const propsPath = path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json');
const baseProps = JSON.parse(readFileSync(propsPath, 'utf8'));

function staticPathForSource(source) {
  const url = new URL(source);
  return path.join(root, 'data', url.pathname);
}

test('project 8 expands 14 narrative shots into 19 contiguous visual intervals', () => {
  const intervals = flattenNarrativeStoryboardVisuals(baseProps);
  assert.equal(baseProps.shots.length, 14);
  assert.equal(intervals.length, 19);
  assert.equal(intervals[0].startMs, 0);
  assert.equal(intervals.at(-1).endMs, baseProps.durationMs);
  assert.equal(intervals[7].startMs, 30906);
  assert.equal(intervals[11].endMs, 42717);
  assert.equal(intervals[17].endMs, 88016);
});

test('audio plan keeps one external narration master and validates timed BGM/SFX only', () => {
  const plan = validateNarrativeAudioPlan({
    durationMs: 10000,
    bgmTracks: [{id: 'bgm-1', src: 'music.mp3', startMs: 0, endMs: 10000, sourceStartMs: 1200, volume: 0.12, narrationDuck: 0.55, gainPoints: [{atMs: 0, gain: 0.8}, {atMs: 5000, gain: 1}, {atMs: 10000, gain: 0.7}]}],
    soundCues: [{id: 'horse-1', src: 'horse.mp3', startMs: 0, endMs: 5000, volume: 0.2, role: 'foley'}],
  });
  assert.equal(plan.bgmTracks.length, 1);
  assert.equal(plan.bgmTracks[0].gainPoints.length, 3);
  assert.equal(plan.soundCues.length, 1);
  assert.throws(() => validateNarrativeAudioPlan({
    durationMs: 10000,
    soundCues: [{id: 'duplicate-narration', src: 'voice.mp3', startMs: 0, endMs: 1000, volume: 1, role: 'narration'}],
  }), /second narration track/);
  assert.throws(() => validateNarrativeAudioPlan({
    durationMs: 10000,
    bgmTracks: [{id: 'bad-gain', src: 'music.mp3', startMs: 0, endMs: 10000, volume: 0.12, gainPoints: [{atMs: 5000, gain: 1}, {atMs: 4000, gain: 0.8}]}],
  }), /gain points/i);
});

test('preview truncation preserves captions, sequences, shots, and waypoint end boundary', () => {
  const truncated = truncateNarrativeStoryboardProps(baseProps, 45000);
  const intervals = flattenNarrativeStoryboardVisuals(truncated);
  assert.equal(truncated.durationMs, 45000);
  assert.equal(intervals.length, 14);
  assert.equal(intervals.at(-1).startMs, 44050);
  assert.equal(intervals.at(-1).endMs, 45000);
  assert.equal(truncated.captions.at(-1).endMs, 45000);
  assert.equal(truncated.sequences.at(-1).endMs, 45000);
});

test('recipe application conserves absolute frame windows and retains focus, variants, and parallax', () => {
  const limitMs = baseProps.durationMs;
  const intervals = flattenNarrativeStoryboardVisuals(baseProps);
  const recipe = {
    schemaVersion: 'magnates-remotion-recipe-v2',
    fps: 30,
    durationInFrames: Math.round(limitMs / 1000 * 30),
    shots: intervals.map((interval, index) => ({
      id: `recipe-${index + 1}`,
      durationInFrames: Math.round(interval.endMs / 1000 * 30) - Math.round(interval.startMs / 1000 * 30),
      semanticRole: index === 0 ? 'hook' : 'mechanism',
      camera: {preset: index === 0 ? 'push_in' : 'pan_right', intensity: 0.8, focus: {x: 0.2 + index * 0.01, y: 0.6}},
      transitionOut: {class: index % 2 === 0 ? 'blur_bridge' : 'hard_cut', frames: 12},
      texts: [{subject: `beat-${index + 1}`, text: `beat-${index + 1}`, startFrame: 2, endFrame: 20, entry: 'kinetic', variant: index % 2 === 0 ? 'impact' : 'whisper'}],
    })),
  };
  const result = applyNarrativeStoryboardRecipe({baseProps, recipe, limitMs});
  const applied = flattenNarrativeStoryboardVisuals(result.props);
  const treatments = result.props.shots.flatMap((shot) => shot.waypoints?.length ? shot.waypoints.map((waypoint) => waypoint.editorial) : [shot.editorial]);
  assert.equal(result.visualIntervals, 19);
  assert.deepEqual(applied.map(({startMs, endMs}) => [startMs, endMs]), intervals.map(({startMs, endMs}) => [startMs, endMs]));
  assert.deepEqual(treatments[0].camera.focus, {x: 0.2, y: 0.6});
  assert.equal(treatments[1].texts[0].variant, 'whisper');
  assert.equal(treatments[0].parallax, 0, 'opening video must not receive synthetic parallax');
  assert.ok(treatments[1].parallax > 0);
});

test('director input builder retains one authored hint per visual interval', () => {
  const work = path.join(root, '.tmp/project8-editorial-core-test');
  try {
    const result = buildNarrativeStoryboardDirectorInputs({
      root,
      propsPath,
      work,
      outputRoot: path.join(root, '.remotion-editorial-runs/project8-core-test'),
      limitMs: 34510,
      staticPathForSource,
      hintForInterval: (_interval, index) => ({
        role: index === 0 ? 'hook' : 'mechanism',
        visualIntent: `intent-${index + 1}`,
        emphasis: 0.7,
        focus: {x: 0.4, y: 0.5},
        typographyVariant: index === 0 ? 'impact' : 'whisper',
        transitionEnergy: index === 0 ? 'high' : 'low',
        soundIntent: 'none',
      }),
      projectLabel: 'project 8 core test',
    });
    const timing = JSON.parse(readFileSync(result.timingPath, 'utf8'));
    assert.equal(result.intervalCount, 10);
    assert.equal(timing.spans.length, 10);
    assert.equal(timing.spans[0].editorialHint.role, 'hook');
    assert.equal(timing.spans[9].editorialHint.visualIntent, 'intent-10');
    assert.deepEqual(timing.spans[4].editorialHint.focus, {x: 0.4, y: 0.5});
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
});
