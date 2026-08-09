import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {buildFinalPrompt, normalizedPanelCrop} from './produce_project8_full_storyboard_finals.mjs';
import {buildSheetSpecs} from './produce_project8_full_storyboard_sheets.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const plan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json'), 'utf8'));

test('full finals preserve the approved pilot and generate every later storyboard panel once', () => {
  const panels = buildSheetSpecs(plan).flatMap((sheet) => sheet.panels.map(({panel}) => panel));
  const numbers = panels.map(({id}) => Number(id.replace('panel-', '')));
  assert.equal(panels.length, 284);
  assert.equal(plan.pilotPanelCount, 19);
  assert.equal(numbers.filter((number) => number > plan.pilotPanelCount).length, 265);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('storyboard crop geometry remains inside a sheet for all supported layouts', () => {
  for (const count of [1, 2, 3, 4, 6, 7, 8, 9]) {
    for (let index = 0; index < count; index += 1) {
      const crop = normalizedPanelCrop(index, count);
      assert.ok(crop.x >= 0 && crop.y >= 0, `${count}:${index}`);
      assert.ok(crop.width > 0 && crop.height > 0, `${count}:${index}`);
      assert.ok(crop.x + crop.width <= 1, `${count}:${index}`);
      assert.ok(crop.y + crop.height <= 1, `${count}:${index}`);
    }
  }
});

test('final prompt keeps storyboard control separate from identity continuity and prohibits panel artifacts', () => {
  const sequence = plan.sequences.find(({id}) => id === 'seq-10-killing-and-coverup');
  const panel = sequence.panels.find(({id}) => id === 'panel-231');
  const beat = sequence.beats.find(({id}) => id === panel.beatId);
  const prompt = buildFinalPrompt({panel, beat, sequence});
  assert.match(prompt, /only for panel-231's staging/u);
  assert.match(prompt, /Do not copy their pose/u);
  assert.match(prompt, /cold_ink_spatial/u);
  assert.match(prompt, /no visible text/u);
  assert.match(prompt, /arrow/u);
});

test('prompt-only fallback keeps every approved storyboard instruction when a provider cannot accept image references', () => {
  const sequence = plan.sequences.find(({id}) => id === 'seq-07-two-ways-of-war');
  const panel = sequence.panels.find(({id}) => id === 'panel-135');
  const beat = sequence.beats.find(({id}) => id === panel.beatId);
  const prompt = buildFinalPrompt({panel, beat, sequence, referenceMode: 'prompt-only'});
  assert.match(prompt, /Reconstruct panel-135's approved storyboard staging/u);
  assert.match(prompt, /Elevated battlefield EWS/u);
  assert.match(prompt, /Do not copy a prior beat's pose/u);
  assert.doesNotMatch(prompt, /supplied storyboard panel crop/u);
});

test('safety recovery keeps the planned camera while removing unsafe action language', () => {
  const sequence = plan.sequences.find(({id}) => id === 'seq-10-killing-and-coverup');
  const panel = sequence.panels.find(({id}) => id === 'panel-241');
  const beat = sequence.beats.find(({id}) => id === panel.beatId);
  const prompt = buildFinalPrompt({panel, beat, sequence, referenceMode: 'prompt-only', safetyRecovery: true});
  assert.match(prompt, /same camera geometry and screen direction/u);
  assert.match(prompt, /no weapons, combat, injury/u);
  assert.doesNotMatch(prompt, /射杀|斩杀|杀掉|杀人|weapon trajectory/u);
  assert.doesNotMatch(prompt, /猎杀与遮掩/u);
});
