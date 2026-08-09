#!/usr/bin/env node

import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {applyNarrativeStoryboardRecipe, validateNarrativeAudioPlan} from './narrative_storyboard_director_core.mjs';
import {planNarrativeAudioDesign} from './narrative_audio_planner.mjs';
import {writeAudioPlanReport} from './render_audio_plan_report.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const recipeIndex = process.argv.indexOf('--recipe');
if (recipeIndex < 0 || !process.argv[recipeIndex + 1]) {
  throw new Error('--recipe <recipe.payload.json> is required');
}
const recipePath = path.resolve(root, process.argv[recipeIndex + 1]);
const secondsIndex = process.argv.indexOf('--seconds');
const requestedSeconds = secondsIndex >= 0 ? Number(process.argv[secondsIndex + 1]) : null;
const previewSeconds = Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? requestedSeconds : null;
const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 && process.argv[outputIndex + 1]
  ? path.resolve(root, process.argv[outputIndex + 1])
  : path.join(root, `data/temp/project-8-narrative-storyboard-director${previewSeconds ? `-${previewSeconds}s` : ''}-props.json`);
const basePropsIndex = process.argv.indexOf('--base-props');
const basePropsPath = basePropsIndex >= 0 && process.argv[basePropsIndex + 1]
  ? path.resolve(root, process.argv[basePropsIndex + 1])
  : path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json');
const baseProps = JSON.parse(readFileSync(basePropsPath, 'utf8'));
const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
const limitMs = Math.min(baseProps.durationMs, previewSeconds ? Math.round(previewSeconds * 1000) : baseProps.durationMs);

function normalizeTextCue(cue, role, index) {
  const kinetic = cue.entry === 'kinetic';
  return {
    ...cue,
    label: undefined,
    x: 0.075,
    y: kinetic ? (index % 2 === 0 ? 0.18 : 0.48) : 0.15,
    width: kinetic ? 0.82 : 0.68,
    fontSize: kinetic ? Math.max(46, cue.fontSize ?? 42) : Math.min(38, cue.fontSize ?? 36),
    weight: kinetic ? 900 : 700,
    color: role === 'reversal' ? '#F2B84B' : cue.color,
  };
}

const {props, visualIntervals} = applyNarrativeStoryboardRecipe({
  baseProps,
  recipe,
  limitMs,
  normalizeTextCue: (cue, treatment, index) => normalizeTextCue(cue, treatment.semanticRole, index),
});

const audioDesign = planNarrativeAudioDesign({
  props,
  musicLibrary: JSON.parse(readFileSync(path.join(root, 'data/static/music/library.json'), 'utf8')),
  sfxMapping: JSON.parse(readFileSync(path.join(root, 'data/sfx/sfx-mapping.json'), 'utf8')),
  baseUrl: 'http://127.0.0.1:5679',
  strict: true,
});
const audioPlan = validateNarrativeAudioPlan({
  durationMs: props.durationMs,
  bgmTracks: audioDesign.bgmTracks,
  soundCues: audioDesign.soundCues,
});
props.bgmTracks = audioPlan.bgmTracks;
props.soundCues = audioPlan.soundCues;

const reportBase = outputPath.replace(/\.json$/i, '-audio-plan');
const audioReport = writeAudioPlanReport({
  props,
  audioDesign,
  jsonPath: `${reportBase}.json`,
  htmlPath: `${reportBase}.html`,
  title: previewSeconds ? `Project 8 Narrative Audio Plan (${previewSeconds}s)` : 'Project 8 Full Narrative Audio Plan',
});

props.director = {
  skill: 'remotion-editorial-director',
  recipeSchemaVersion: recipe.schemaVersion,
  recipePath,
  basePropsPath,
  visualIntervals,
  audio: {
    bgmTracks: props.bgmTracks.length,
    soundCues: props.soundCues.length,
    narrationTracks: props.audioSrc ? 1 : 0,
    metrics: audioDesign.metrics,
    unresolvedEvents: audioDesign.unresolvedEvents.length,
    report: audioReport,
  },
};
writeFileSync(outputPath, `${JSON.stringify(props, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({outputPath, durationMs: props.durationMs, visualIntervals, audioReport, audioMetrics: audioDesign.metrics}, null, 2)}\n`);
