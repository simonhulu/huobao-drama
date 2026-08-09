#!/usr/bin/env node

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildProject8FullNarrativeProps} from './build_project8_full_narrative_props.mjs';
import {validatePlan} from './build_project8_full_storyboard_sound_plan.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const DEFAULT_FULL_PROPS = path.join(root, 'data/temp/remotion-project-8-single-master-props.json');
const DEFAULT_PILOT_PROPS = path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json');
const DEFAULT_PLAN = path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json');
const DEFAULT_OUTPUT = path.join(root, 'data/temp/project-8-full-narrative-storyboard-props.json');
const LEGACY_FINAL_ROOT = path.join(root, 'data/static/remotion/project-8/narrative-storyboard/finals');
const FULL_FINAL_ROOT = path.join(root, 'data/static/remotion/project-8/narrative-storyboard/full-v2/finals');
const FPS = 30;
const PILOT_END_FRAME = 2670;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(root, process.argv[index + 1]) : fallback;
}

function frameToMs(frame) {
  return Math.round(frame / FPS * 1000);
}

function normalize(value) {
  return String(value ?? '').replace(/\s+/gu, '');
}

function finalPathForPanel(panelId, pilotPanelCount) {
  const number = Number(panelId.replace('panel-', ''));
  const rootDir = number <= pilotPanelCount ? LEGACY_FINAL_ROOT : FULL_FINAL_ROOT;
  return path.join(rootDir, `${panelId}.png`);
}

function sourceForPanel(panelId, pilotPanelCount) {
  return `http://127.0.0.1:5679/static/remotion/project-8/narrative-storyboard/${Number(panelId.replace('panel-', '')) <= pilotPanelCount ? '' : 'full-v2/'}finals/${panelId}.png`;
}

function captionsFromMiniMax({fullProps, pilotProps}) {
  const pilotEndMs = frameToMs(PILOT_END_FRAME);
  const pilotCaptions = pilotProps.captions
    .filter((caption) => caption.startMs < pilotEndMs)
    .map((caption) => ({...caption, endMs: Math.min(caption.endMs, pilotEndMs)}))
    .filter((caption) => caption.endMs > caption.startMs);
  const minimaxCaptions = (fullProps.captions || [])
    .filter((caption) => Number(caption.startFrame) >= PILOT_END_FRAME)
    .map((caption, index) => ({
      id: `minimax-title-${index + 1}`,
      text: caption.text,
      startMs: frameToMs(Number(caption.startFrame)),
      endMs: frameToMs(Number(caption.endFrame)),
      timingSource: 'tts-time-begin-end',
    }));
  return [...pilotCaptions, ...minimaxCaptions];
}

function validateProps({props, fullProps, plan}) {
  let cursor = 0;
  for (const shot of props.shots) {
    if (shot.startMs !== cursor || shot.endMs <= shot.startMs) throw new Error(`Visual timeline has a gap at ${shot.id}`);
    cursor = shot.endMs;
  }
  if (cursor !== props.durationMs) throw new Error(`Visual timeline ends at ${cursor}, expected ${props.durationMs}`);
  if (!props.audioSrc || props.shots.some((shot) => shot.audioSrc || shot.audioUrl)) throw new Error('Storyboard props must mount exactly one top-level narration master');
  const expectedNarration = normalize(fullProps.shots.map((shot) => shot.narration).join(''));
  const actualNarration = normalize(props.shots.map((shot) => shot.narration || '').join(''));
  if (actualNarration !== expectedNarration) throw new Error('Visual beats do not partition the narration master exactly once');
  const expectedBeatCount = plan.sequences.flatMap((sequence) => sequence.beats).length;
  const visualCount = props.shots.reduce((count, shot) => count + (shot.waypoints?.length || 1), 0);
  if (visualCount !== expectedBeatCount) throw new Error(`Expected ${expectedBeatCount} storyboard visuals, got ${visualCount}`);
  for (const caption of props.captions) {
    if (caption.startMs < 0 || caption.endMs <= caption.startMs || caption.endMs > props.durationMs) {
      throw new Error(`Invalid MiniMax caption range: ${caption.id}`);
    }
  }
}

export function buildProject8FullStoryboardProps({fullProps, pilotProps, plan, requireFinals = false}) {
  if (fullProps.fps !== FPS || fullProps.durationInFrames !== 25229) throw new Error('Unexpected project 8 master timeline');
  validatePlan(plan, fullProps);
  const base = buildProject8FullNarrativeProps({fullProps, pilotProps});
  const postPilotBeats = plan.sequences
    .flatMap((sequence) => sequence.beats.map((beat) => ({beat, sequence})))
    .filter(({beat}) => beat.startMs >= frameToMs(PILOT_END_FRAME));
  const panelsByBeatId = new Map(plan.sequences.flatMap((sequence) => sequence.panels.map((panel) => [panel.beatId, panel])));
  const pilotShots = base.shots.filter((shot) => shot.endMs <= frameToMs(PILOT_END_FRAME));
  const postPilotShots = postPilotBeats.map(({beat, sequence}) => {
    const panel = panelsByBeatId.get(beat.id);
    if (!panel) throw new Error(`Missing panel for ${beat.id}`);
    const finalPath = finalPathForPanel(panel.id, plan.pilotPanelCount);
    if (requireFinals && !existsSync(finalPath)) throw new Error(`Missing final panel image: ${finalPath}`);
    return {
      id: `render-${panel.id}`,
      startMs: beat.startMs,
      endMs: beat.endMs,
      src: sourceForPanel(panel.id, plan.pilotPanelCount),
      narration: beat.sourceText || '',
      timingStrategy: 'narration-anchor',
      sourceShotNumber: panel.sourceShotNumber,
      sequenceId: sequence.id,
      eventId: beat.eventId,
      visualBeatId: beat.id,
      storyboardPanelId: panel.id,
    };
  });
  const props = {
    ...base,
    shots: [...pilotShots, ...postPilotShots],
    captions: captionsFromMiniMax({fullProps, pilotProps}),
    source: {
      ...base.source,
      captionTimingSource: 'minimax tts-time-begin-end',
      remainingVisuals: 'one cold_ink_spatial final per approved storyboard panel',
      storyboardPanels: plan.sequences.flatMap((sequence) => sequence.panels).length,
    },
  };
  validateProps({props, fullProps, plan});
  return props;
}

function main() {
  const fullProps = JSON.parse(readFileSync(argument('--full-props', DEFAULT_FULL_PROPS), 'utf8'));
  const pilotProps = JSON.parse(readFileSync(argument('--pilot-props', DEFAULT_PILOT_PROPS), 'utf8'));
  const plan = JSON.parse(readFileSync(argument('--plan', DEFAULT_PLAN), 'utf8'));
  const output = argument('--output', DEFAULT_OUTPUT);
  const props = buildProject8FullStoryboardProps({fullProps, pilotProps, plan, requireFinals: process.argv.includes('--require-finals')});
  writeFileSync(output, `${JSON.stringify(props, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output,
    durationMs: props.durationMs,
    shots: props.shots.length,
    visualIntervals: props.shots.reduce((count, shot) => count + (shot.waypoints?.length || 1), 0),
    captions: props.captions.length,
    narrationTracks: props.audioSrc ? 1 : 0,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
