import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {buildProject8FullNarrativeProps} from './build_project8_full_narrative_props.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('builds a complete single-master project 8 narrative timeline', () => {
  const props = buildProject8FullNarrativeProps({
    fullProps: JSON.parse(readFileSync(path.join(root, 'data/temp/remotion-project-8-single-master-props.json'), 'utf8')),
    pilotProps: JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json'), 'utf8')),
  });
  assert.equal(props.durationMs, 840967);
  assert.equal(props.source.durationInFrames, 25229);
  assert.equal(props.sequences.length, 12);
  assert.equal(props.shots.length, 139);
  assert.equal(props.shots[0].videoSrc.includes('opening-imperial-hunt-grok.mp4'), true);
  assert.equal(props.shots.at(-1).endMs, props.durationMs);
  assert.equal(props.shots.some((shot) => shot.audioUrl || shot.audioSrc), false);
  assert.ok(props.captions.length > 140);
});
