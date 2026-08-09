import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {buildProject8FullStoryboardProps} from './build_project8_full_storyboard_props.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fullProps = JSON.parse(readFileSync(path.join(root, 'data/temp/remotion-project-8-single-master-props.json'), 'utf8'));
const pilotProps = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json'), 'utf8'));
const plan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json'), 'utf8'));

test('maps each visual beat to a unique render interval while preserving the approved pilot', () => {
  const props = buildProject8FullStoryboardProps({fullProps, pilotProps, plan});
  assert.equal(props.durationMs, 840967);
  assert.equal(props.shots[0].videoSrc.includes('opening-imperial-hunt-grok.mp4'), true);
  assert.equal(props.shots.reduce((count, shot) => count + (shot.waypoints?.length || 1), 0), 284);
  assert.equal(props.shots.filter((shot) => shot.startMs >= 89000).length, 265);
  assert.equal(new Set(props.shots.filter((shot) => shot.storyboardPanelId).map((shot) => shot.storyboardPanelId)).size, 265);
  assert.equal(props.shots.some((shot) => shot.audioSrc || shot.audioUrl), false);
  assert.ok(props.audioSrc);
});

test('uses the source MiniMax title timing after the approved pilot instead of character-weighted estimates', () => {
  const props = buildProject8FullStoryboardProps({fullProps, pilotProps, plan});
  const expected = fullProps.captions.find((caption) => caption.startFrame >= 2670);
  const actual = props.captions.find((caption) => caption.id === 'minimax-title-1');
  assert.equal(actual.startMs, Math.round(expected.startFrame / 30 * 1000));
  assert.equal(actual.endMs, Math.round(expected.endFrame / 30 * 1000));
  assert.equal(actual.timingSource, 'tts-time-begin-end');
});

test('beat narration remains a verbatim one-time partition of the single master', () => {
  const props = buildProject8FullStoryboardProps({fullProps, pilotProps, plan});
  const normalize = (value) => String(value).replace(/\s+/gu, '');
  assert.equal(normalize(props.shots.map((shot) => shot.narration || '').join('')), normalize(fullProps.shots.map((shot) => shot.narration).join('')));
});
