import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildCaptions, validatePlan, renderDirect} from './history_fullframe_direct.mjs';

const camera = {mode: 'hold', amount: 0, focusX: .5, focusY: .5};
const fixture = () => ({width: 1920, height: 1080, fps: 30, duration: 2,
  shots: [{storyboardNumber: 1, startFrame: 0, frames: 30, firstFrameImage: 'one.png', camera, effects: [], narration: '甲乙', caption: {evidence: [{text: '甲乙', start: 0, end: 1}]}},
    {storyboardNumber: 2, startFrame: 30, frames: 30, firstFrameImage: 'two.png', camera, effects: [], narration: '丙丁', caption: {evidence: [{text: '丙丁', start: 0, end: 1}]}}]});

test('shot-local captions preserve global timing and exact word coverage', () => {
  const plan = fixture();
  assert.equal(validatePlan(plan), 60);
  assert.deepEqual(buildCaptions(plan), [{text: '甲乙', startFrame: 0, endFrame: 30}, {text: '丙丁', startFrame: 30, endFrame: 60}]);
  assert.deepEqual(buildCaptions(plan, [{text: '甲乙丙丁', time_begin: 0, time_end: 2000}]), [{text: '甲乙丙丁', startFrame: 0, endFrame: 60}]);
  assert.throws(() => buildCaptions(plan, [{text: '甲乙', time_begin: 0, time_end: 2000}]), /cover frozen narration/);
  assert.throws(() => buildCaptions(plan, [{text: '甲乙', time_begin: 0, time_end: 1200}, {text: '丙丁', time_begin: 1000, time_end: 2000}]), /overlapping/);
});

test('rejects shot gaps, duplicate numbers and unsupported output geometry', () => {
  const gap = fixture(); gap.shots[1].startFrame = 31;
  assert.throws(() => validatePlan(gap), /tile exactly/);
  const duplicate = fixture(); duplicate.shots[1].storyboardNumber = 1;
  assert.throws(() => validatePlan(duplicate), /unique numbers/);
  assert.throws(() => validatePlan({...fixture(), width: 1280}), /1920x1080/);
});

test('long captions split into readable windows without losing words and label estimated timing', () => {
  const plan = fixture(), text = '甲'.repeat(100);
  plan.shots[0].narration = text; plan.shots[1].narration = '';
  const captions = buildCaptions(plan, [{text, time_begin: 0, time_end: 2000}]);
  assert.deepEqual(captions.map(c => [...c.text].length), [28, 28, 28, 16]);
  assert.equal(captions[0].endFrame, captions[1].startFrame);
  assert.equal(captions.at(-1).endFrame, 60);
  assert.match(captions[0].timingEvidence, /estimates/);
});

test('Chinese subtitle breaks keep names and closing punctuation together', () => {
  const plan = fixture(), text = '甲'.repeat(26) + '唐玄宗、肃宗和代宗三位；随后战火延续。';
  plan.shots[0].narration = text; plan.shots[1].narration = '';
  const captions = buildCaptions(plan, [{text, time_begin: 0, time_end: 2000}]);
  assert.equal(captions.map(c => c.text).join(''), text);
  assert.ok(captions.some(c => c.text.includes('唐玄宗')));
  assert.ok(captions.every(c => !/^[，。！？；：、）”」】]/.test(c.text)));
  const punctuation = '甲'.repeat(28) + '。';
  plan.shots[0].narration = punctuation;
  assert.equal(buildCaptions(plan, [{text: punctuation, time_begin: 0, time_end: 2000}]).length, 1);
});

test('real direct render contains captions, motion, narration and 60 complete frames', {skip: process.env.HISTORY_DIRECT_SMOKE !== '1', timeout: 180000}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-direct-smoke-'));
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  const sharp = require('sharp');
  const image = path.join(directory, 'image.png'), audio = path.join(directory, 'voice.m4a');
  await sharp({create: {width: 1920, height: 1080, channels: 3, background: '#435b64'}})
    .composite([{input: Buffer.from('<svg width="1920" height="1080"><rect x="900" y="250" width="400" height="700" fill="#ad5b45"/><circle cx="1100" cy="220" r="120" fill="#dfc1a5"/></svg>')}]).png().toFile(image);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'aac', '-b:a', '128k', audio]);
  const plan = fixture();
  plan.sourcePath = audio;
  for (const shot of plan.shots) shot.firstFrameImage = image;
  plan.shots[0].effects = [{id: 'reveal', kind: 'title-ink', text: '大汉', x: .1, y: .2, width: .3, height: .2,
    startFrame: 0, endFrame: 29, space: 'screen', motion: 'brush'}];
  const planFile = path.join(directory, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const result = await renderDirect({plan: planFile, output: path.join(directory, 'smoke.mp4'), concurrency: 2});
  assert.equal(result.frames, 60);
  assert.equal(result.uploadEncoding.status, 'within-budget');
  assert.equal(result.encoding.hardwareAcceleration, 'disable');
  assert.equal(result.layers.includes('ReferenceEditorialOverlay'), true);
  assert.match(result.narrationPacketHash, /^SHA256=/);
  console.log(`Smoke artifact: ${result.output}`);
});
