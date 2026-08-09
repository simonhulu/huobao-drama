import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {buildSheetSpecs, sheetPrompt} from './produce_project8_full_storyboard_sheets.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('storyboard sheets cover every panel exactly once and stay sequence-scoped', () => {
  const plan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json'), 'utf8'));
  const specs = buildSheetSpecs(plan);
  const panelIds = specs.flatMap((spec) => spec.panels.map(({panel}) => panel.id));
  const expected = plan.sequences.flatMap((sequence) => sequence.panels.map((panel) => panel.id));
  assert.deepEqual(panelIds, expected);
  assert.equal(new Set(panelIds).size, panelIds.length);
  assert.ok(specs.every((spec) => spec.panels.length >= 1 && spec.panels.length <= 9));
  assert.ok(specs.every((spec) => spec.panels.every(({panel}) => plan.sequences.find((sequence) => sequence.id === spec.sequenceId).panels.some((candidate) => candidate.id === panel.id))));
});

test('sheet prompt freezes panel count, order, action continuity, and no-text rules', () => {
  const plan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json'), 'utf8'));
  const spec = buildSheetSpecs(plan).find((candidate) => candidate.sequenceId === 'seq-07-two-ways-of-war');
  const prompt = sheetPrompt(spec);
  assert.match(prompt, /exactly 9 panels/iu);
  assert.match(prompt, /formation scale and attack direction/iu);
  assert.match(prompt, /No narration text/iu);
  assert.match(prompt, /P\d{3}/u);
});

test('self-harm narration compiles to a non-graphic aftermath panel', () => {
  const plan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json'), 'utf8'));
  const spec = buildSheetSpecs(plan).find((candidate) => candidate.sequenceId === 'seq-09-li-gan-grievance' && candidate.panels.some(({beat}) => /拔刀自杀/u.test(beat.description)));
  const prompt = sheetPrompt(spec);
  assert.doesNotMatch(prompt, /拔刀自杀/u);
  assert.match(prompt, /非图形化/u);
  assert.match(prompt, /不出现.*行为过程/u);
  assert.match(prompt, /空军帐/u);
});

test('repeated archery narration compiles to distinct setup, release, evidence, and aftermath panels', () => {
  const plan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json'), 'utf8'));
  const spec = buildSheetSpecs(plan).find((candidate) => candidate.id === 'seq-10-killing-and-coverup-sheet-01');
  const prompt = sheetPrompt(spec);
  assert.match(prompt, /确认目标/u);
  assert.match(prompt, /搭箭拉弓并释放/u);
  assert.match(prompt, /空鞍战马/u);
  assert.match(prompt, /不得重复上一格放箭姿态/u);
});
