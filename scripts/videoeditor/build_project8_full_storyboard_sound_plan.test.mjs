import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {buildProject8FullStoryboardSoundPlan, validatePlan} from './build_project8_full_storyboard_sound_plan.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function fixture() {
  const fullProps = JSON.parse(readFileSync(path.join(root, 'data/temp/remotion-project-8-single-master-props.json'), 'utf8'));
  const pilotPlan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-narrative-storyboard-plan.json'), 'utf8'));
  const pilotProps = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json'), 'utf8'));
  return {fullProps, pilotPlan, pilotProps};
}

test('builds a dense full storyboard with one panel per visual beat', () => {
  const {fullProps, pilotPlan, pilotProps} = fixture();
  const plan = buildProject8FullStoryboardSoundPlan({fullProps, pilotPlan, pilotProps});
  const stats = validatePlan(plan, fullProps);
  assert.equal(plan.sequences.length, 12);
  assert.ok(stats.panels >= 150, `expected at least 150 panels, got ${stats.panels}`);
  assert.equal(stats.panels, stats.beats);
  assert.ok(plan.sequences.slice(3).flatMap((sequence) => sequence.beats).every((beat) => beat.endMs - beat.startMs <= 6001));
});

test('plans a complete layered battle soundscape and complete archery transients', () => {
  const {fullProps, pilotPlan, pilotProps} = fixture();
  const plan = buildProject8FullStoryboardSoundPlan({fullProps, pilotPlan, pilotProps});
  const types = new Set(plan.soundBeats.map((sound) => sound.type));
  assert.ok(types.has('battle_ambience'));
  assert.ok(types.has('battle_crowd'));
  assert.ok(types.has('battle_melee'));
  assert.ok(types.has('weapon_clash_cluster'));
  assert.ok(types.has('bow_draw'));
  assert.ok(types.has('bow_release'));
  assert.ok(types.has('arrow_whoosh'));
  assert.ok(types.has('arrow_impact'));

  const byEvent = new Map();
  for (const sound of plan.soundBeats) {
    if (!byEvent.has(sound.eventId)) byEvent.set(sound.eventId, []);
    byEvent.get(sound.eventId).push(sound);
  }
  for (const sounds of byEvent.values()) {
    if (!sounds.some((sound) => sound.type === 'battle_ambience')) continue;
    const eventTypes = new Set(sounds.map((sound) => sound.type));
    for (const type of ['battle_ambience', 'battle_crowd', 'battle_melee', 'weapon_clash_cluster']) {
      assert.ok(eventTypes.has(type), `battle event is missing ${type}`);
    }
  }
});

test('does not reuse one storyboard panel across post-pilot beats', () => {
  const {fullProps, pilotPlan, pilotProps} = fixture();
  const plan = buildProject8FullStoryboardSoundPlan({fullProps, pilotPlan, pilotProps});
  const panels = plan.sequences.slice(3).flatMap((sequence) => sequence.panels);
  assert.equal(new Set(panels.map((panel) => panel.id)).size, panels.length);
  assert.equal(new Set(panels.map((panel) => panel.beatId)).size, panels.length);
});
