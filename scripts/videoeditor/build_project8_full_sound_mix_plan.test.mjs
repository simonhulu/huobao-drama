import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {buildProject8FullSoundMixPlan, validateProject8FullSoundMixPlan} from './build_project8_full_sound_mix_plan.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const storyboardPlan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json'), 'utf8'));
const musicLibrary = JSON.parse(readFileSync(path.join(root, 'data/static/music/library.json'), 'utf8'));
const sfxLibrary = JSON.parse(readFileSync(path.join(root, 'data/sfx/sfx-mapping.json'), 'utf8'));

test('uses local BGM and concrete reusable assets for every planned sound beat', () => {
  const mixPlan = buildProject8FullSoundMixPlan({storyboardPlan, musicLibrary});
  const stats = validateProject8FullSoundMixPlan(mixPlan);
  assert.equal(stats.bgmTracks, 12);
  assert.ok(stats.soundCues >= 93);
  assert.ok(mixPlan.bgmTracks.every((track) => track.duckedUnderNarration));
  assert.ok(mixPlan.soundCues.every((cue) => cue.absolutePath.includes('/data/sfx/')));
});

test('keeps battle layers and every archery phase semantically separate', () => {
  const mixPlan = buildProject8FullSoundMixPlan({storyboardPlan, musicLibrary});
  const byEvent = new Map();
  for (const cue of mixPlan.soundCues) {
    if (!byEvent.has(cue.eventId)) byEvent.set(cue.eventId, []);
    byEvent.get(cue.eventId).push(cue);
  }

  for (const cues of byEvent.values()) {
    const byType = new Map(cues.map((cue) => [cue.type, cue]));
    if (byType.has('battle_ambience')) {
      for (const [type, role] of [
        ['battle_ambience', 'battlefield_ambience_bed'],
        ['battle_crowd', 'battle_crowd_charge'],
        ['battle_melee', 'battle_melee_bed'],
        ['weapon_clash_cluster', 'weapon_clash_cluster'],
      ]) {
        assert.equal(byType.get(type)?.role, role, `battle layer ${type} must use ${role}`);
      }
      assert.equal(new Set([
        byType.get('battle_ambience').relativePath,
        byType.get('battle_crowd').relativePath,
        byType.get('battle_melee').relativePath,
        byType.get('weapon_clash_cluster').relativePath,
      ]).size, 4, 'battle layers must not collapse to one source file');
    }
    if (byType.has('bow_draw')) {
      for (const [type, role] of [
        ['bow_draw', 'bow_draw_tension'],
        ['bow_release', 'bow_release'],
        ['arrow_whoosh', 'arrow_flight_whoosh'],
        ['arrow_impact', 'arrow_wood_impact'],
      ]) {
        assert.equal(byType.get(type)?.role, role, `archery phase ${type} must use ${role}`);
      }
      assert.equal(new Set([
        byType.get('bow_draw').relativePath,
        byType.get('bow_release').relativePath,
        byType.get('arrow_whoosh').relativePath,
        byType.get('arrow_impact').relativePath,
      ]).size, 4, 'draw, release, flight, and impact must use different source files');
    }
  }
});

test('rotates battle source material and only assigns a source to its declared role', () => {
  const mixPlan = buildProject8FullSoundMixPlan({storyboardPlan, musicLibrary});
  const sfxByRelativePath = new Map(sfxLibrary.entries.map((entry) => [`sfx/${entry.relativePath}`, entry]));
  const primaryBattleTypes = ['battle_ambience', 'battle_crowd', 'battle_melee'];

  for (const type of primaryBattleTypes) {
    const ordered = mixPlan.soundCues
      .filter((cue) => cue.type === type)
      .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
    assert.ok(new Set(ordered.map((cue) => cue.relativePath)).size >= 2, `${type} needs a reusable source pool`);
    for (let index = 1; index < ordered.length; index += 1) {
      assert.notEqual(
        ordered[index].relativePath,
        ordered[index - 1].relativePath,
        `adjacent battle events must not repeat ${type}`,
      );
    }
  }

  for (const cue of mixPlan.soundCues.filter((cue) => primaryBattleTypes.includes(cue.type))) {
    const source = sfxByRelativePath.get(cue.relativePath);
    assert.ok(source, `missing SFX metadata for ${cue.relativePath}`);
    assert.ok(source.license, `missing license for ${cue.relativePath}`);
    assert.ok(source.roles?.includes(cue.sourceRole), `${cue.relativePath} cannot substitute for ${cue.sourceRole}`);
  }

  const profiles = new Set(
    mixPlan.soundCues
      .filter((cue) => cue.type === 'battle_ambience')
      .map((cue) => cue.battleProfile),
  );
  assert.ok(profiles.size >= 4, 'battle scenes need distinct mix emphases, not one generic battle preset');
});
