#!/usr/bin/env node

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {buildNarrativeStoryboardDirectorInputs} from './narrative_storyboard_director_core.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const propsPath = path.join(root, 'data/temp/project-8-full-narrative-storyboard-props.json');
const props = JSON.parse(readFileSync(propsPath, 'utf8'));
const storyboardSoundPlan = JSON.parse(readFileSync(path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json'), 'utf8'));
const work = path.join(root, '.tmp/project8-full-editorial-director');
const outputRoot = path.join(root, '.remotion-editorial-runs/project8-full');

function localStaticPath(src) {
  const url = new URL(src);
  if (!url.pathname.startsWith('/static/')) throw new Error(`Project 8 full Director asset must resolve below /static/: ${src}`);
  return path.join(root, 'data', url.pathname);
}

function roleFor(text, index, total) {
  if (index === 0) return 'hook';
  if (index === total - 1) return 'resolution';
  if (/打伤|动了手|射死|杀掉|杀人|全军覆没|活捉|抓住|准备把他杀掉|拔刀自杀|士兵挨饿/u.test(text)) return 'crisis';
  if (/另一种说法|被鹿撞死|没有声张|压了下来|遮了过去|没有公开追究|匿讳|却|反而|可至少|争议/u.test(text)) return 'reversal';
  if (/同时|相同|差别|相反|两种|不如|只有|其他几路|地位逐渐下降/u.test(text)) return 'comparison';
  if (/公元前|小时候|长大以后|第一次|两年以后|漠北大战以后|一年多以后|后来/u.test(text)) return 'establishing';
  return 'mechanism';
}

function focusFor(text, role) {
  if (/骑兵|战场|匈奴|弓|箭|猎场|打猎|打伤|动了手/u.test(text)) return {x: 0.58, y: 0.48};
  if (/皇帝|汉武帝|朝廷|封为|大将军|大司马|权力|决定权/u.test(text)) return {x: 0.46, y: 0.42};
  if (/小时候|奴仆|放羊|父亲家|士兵挨饿/u.test(text)) return {x: 0.38, y: 0.58};
  if (role === 'comparison') return {x: 0.5, y: 0.5};
  return {x: 0.5, y: 0.48};
}

function soundIntentForInterval(interval) {
  const planned = storyboardSoundPlan.soundBeats.filter((sound) => sound.endMs > interval.startMs && sound.startMs < interval.endMs);
  if (planned.some((sound) => sound.type === 'battle_ambience')) return 'low_boom';
  if (planned.some((sound) => ['weapon_clash_cluster', 'arrow_impact', 'armor_hit'].includes(sound.type))) return 'impact';
  if (planned.some((sound) => ['arrow_whoosh', 'weapon_draw', 'bow_release'].includes(sound.type))) return 'whoosh';
  return 'none';
}

function hintForInterval(interval, index) {
  const shot = props.shots.find((candidate) => candidate.id === interval.parentShotId);
  const text = shot?.narration || props.captions
    .filter((caption) => caption.endMs > interval.startMs && caption.startMs < interval.endMs)
    .map((caption) => caption.text)
    .join('');
  const role = interval.endMs === props.durationMs ? 'resolution' : roleFor(text, index, props.shots.length);
  const high = role === 'hook' || role === 'crisis' || role === 'reversal';
  return {
    role,
    visualIntent: text.slice(0, 48),
    emphasis: role === 'hook' ? 0.96 : role === 'crisis' ? 0.9 : role === 'reversal' ? 0.84 : role === 'comparison' ? 0.76 : 0.62,
    focus: focusFor(text, role),
    typographyVariant: role === 'mechanism' || role === 'establishing' ? 'whisper' : role === 'comparison' ? 'stamp' : 'impact',
    transitionEnergy: high ? 'high' : role === 'establishing' || role === 'resolution' ? 'low' : 'medium',
    soundIntent: soundIntentForInterval(interval),
  };
}

const result = buildNarrativeStoryboardDirectorInputs({
  root,
  propsPath,
  work,
  outputRoot,
  limitMs: props.durationMs,
  fps: 30,
  staticPathForSource: localStaticPath,
  hintForInterval,
  projectLabel: 'huobao-drama project 8 full feature',
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
