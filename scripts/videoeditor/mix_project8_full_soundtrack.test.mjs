import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {buildProject8FullSoundMixPlan} from './build_project8_full_sound_mix_plan.mjs';
import {buildMixCommand} from './mix_project8_full_soundtrack.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const storyboardPlan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json'), 'utf8'));
const musicLibrary = JSON.parse(readFileSync(path.join(root, 'data/static/music/library.json'), 'utf8'));

test('soundtrack command keeps one narration input and ducks BGM before the final mix', () => {
  const mixPlan = buildProject8FullSoundMixPlan({storyboardPlan, musicLibrary});
  const masterPath = path.join(root, 'data/static/audio/6c4b1c81-8508-42fc-ba42-7bdae682648d_pre_episode591.mp3');
  const args = buildMixCommand({masterPath, mixPlan, outputPath: path.join(root, '.tmp/project8-soundtrack-test.m4a')});
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.equal(args.filter((value) => value === masterPath).length, 1);
  assert.match(graph, /sidechaincompress/u);
  assert.match(graph, /\[narration\]\[ducked_bgm\]\[sfx\]amix/u);
  assert.ok(args.some((value) => String(value).includes('arrow_flight_whoosh_chinaz.mp3')), 'the planned arrow-flight source must be a concrete mix input');
});
