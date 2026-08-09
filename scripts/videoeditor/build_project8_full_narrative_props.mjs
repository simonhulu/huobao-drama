#!/usr/bin/env node

import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const DEFAULT_FULL_PROPS = path.join(root, 'data/temp/remotion-project-8-single-master-props.json');
const DEFAULT_PILOT_PROPS = path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json');
const DEFAULT_OUTPUT = path.join(root, 'data/temp/project-8-full-narrative-storyboard-props.json');
const FPS = 30;
const PILOT_END_FRAME = 2670;

const sequenceSpecs = [
  ['seq-01-hunting-death', '甘泉猎场的死亡谜案', 0, 858],
  ['seq-02-assault-and-response', '袭击与两种权力回应', 858, 1846],
  ['seq-03-wei-qing-childhood', '回到卫青的童年', 1846, PILOT_END_FRAME],
  ['seq-04-rise-from-servitude', '从骑奴到宫廷', PILOT_END_FRAME, 4791],
  ['seq-05-power-with-restraint', '军功与权力边界', 4791, 8001],
  ['seq-06-huo-qubing-rises', '冒险不断得到奖赏', 8001, 11801],
  ['seq-07-two-ways-of-war', '两种统帅方式', 11801, 15035],
  ['seq-08-favor-and-character', '战功、偏爱与性格', 15035, 17865],
  ['seq-09-li-gan-grievance', '李敢的怨恨', 17865, 20447],
  ['seq-10-killing-and-coverup', '猎杀与遮掩', 20447, 22542],
  ['seq-11-power-conclusion', '权力为何失去克制', 22542, 23785],
  ['seq-12-epilogue', '史书没有等到答案', 23785, 25229],
];

const punctuation = /(?<=[。！？；])/u;

function valueAfter(flag, argv, fallback) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? path.resolve(root, argv[index + 1]) : fallback;
}

function frameToMs(frame) {
  return Math.round(frame / FPS * 1000);
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/gu, '').trim();
}

function splitLongClause(text, limit = 24) {
  const result = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const candidates = ['，', '、', '：', '；'].map((mark) => window.lastIndexOf(mark));
    const boundary = Math.max(...candidates);
    const cut = boundary >= Math.floor(limit * 0.55) ? boundary + 1 : limit;
    result.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) result.push(remaining);
  return result;
}

function captionParts(text) {
  return normalizeText(text)
    .split(punctuation)
    .filter(Boolean)
    .flatMap((clause) => splitLongClause(clause));
}

function captionsForFrameRange({idPrefix, text, startFrame, endFrame}) {
  const parts = captionParts(text);
  if (!parts.length || endFrame <= startFrame) return [];
  const weights = parts.map((part) => Math.max(1, [...part].length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const totalFrames = endFrame - startFrame;
  let cursor = startFrame;
  return parts.map((part, index) => {
    const remainingParts = parts.length - index - 1;
    const proportionalEnd = index === parts.length - 1
      ? endFrame
      : startFrame + Math.round(totalFrames * (weights.slice(0, index + 1).reduce((sum, value) => sum + value, 0) / totalWeight));
    const next = Math.max(cursor + 1, Math.min(endFrame - remainingParts, proportionalEnd));
    const caption = {
      id: `${idPrefix}-${index + 1}`,
      text: part,
      startMs: frameToMs(cursor),
      endMs: frameToMs(next),
    };
    cursor = next;
    return caption;
  });
}

function sourceForShot(shot) {
  const source = shot.imageUrl || shot.fallbackImageUrl;
  if (!source) throw new Error(`Project 8 shot ${shot.storyboardNumber} has no renderable image`);
  return source.replace('http://localhost:', 'http://127.0.0.1:');
}

function buildSequences(durationInFrames) {
  if (sequenceSpecs.at(-1)[3] !== durationInFrames) {
    throw new Error(`Sequence plan ends at ${sequenceSpecs.at(-1)[3]}, expected ${durationInFrames}`);
  }
  return sequenceSpecs.map(([id, title, startFrame, endFrame]) => ({
    id,
    title,
    startMs: frameToMs(startFrame),
    endMs: frameToMs(endFrame),
  }));
}

function trimPilot(pilot) {
  const endMs = frameToMs(PILOT_END_FRAME);
  const shots = structuredClone(pilot.shots)
    .filter((shot) => shot.startMs < endMs)
    .map((shot) => {
      shot.endMs = Math.min(shot.endMs, endMs);
      if (shot.waypoints?.length) {
        shot.waypoints = shot.waypoints
          .filter((waypoint) => typeof waypoint === 'string' || waypoint.startMs < endMs)
          .map((waypoint) => typeof waypoint === 'string' ? waypoint : {...waypoint, endMs: Math.min(waypoint.endMs, endMs)});
      }
      return shot;
    });
  const captions = structuredClone(pilot.captions)
    .filter((caption) => caption.startMs < endMs)
    .map((caption) => ({...caption, endMs: Math.min(caption.endMs, endMs)}))
    .filter((caption) => caption.endMs > caption.startMs);
  return {shots, captions};
}

function validateTimeline(props, expectedNarration) {
  let cursor = 0;
  for (const shot of props.shots) {
    if (shot.startMs !== cursor || shot.endMs <= shot.startMs) {
      throw new Error(`Full narrative visual timeline is not contiguous at ${shot.id}: ${shot.startMs}-${shot.endMs}, expected ${cursor}`);
    }
    cursor = shot.endMs;
  }
  if (cursor !== props.durationMs) throw new Error(`Full narrative visuals end at ${cursor}, expected ${props.durationMs}`);

  let sequenceCursor = 0;
  for (const sequence of props.sequences) {
    if (sequence.startMs !== sequenceCursor || sequence.endMs <= sequence.startMs) {
      throw new Error(`Full narrative sequences are not contiguous at ${sequence.id}`);
    }
    sequenceCursor = sequence.endMs;
  }
  if (sequenceCursor !== props.durationMs) throw new Error(`Full narrative sequences end at ${sequenceCursor}, expected ${props.durationMs}`);

  const actualNarration = props.shots.map((shot) => normalizeText(shot.narration)).join('');
  if (actualNarration !== normalizeText(expectedNarration)) {
    throw new Error('Full narrative shots do not partition the master narration exactly once');
  }
  if (!props.audioSrc || props.shots.some((shot) => shot.audioSrc || shot.audioUrl)) {
    throw new Error('Full narrative render must use exactly one top-level narration master');
  }
  if (props.captions.some((caption) => caption.startMs < 0 || caption.endMs <= caption.startMs || caption.endMs > props.durationMs)) {
    throw new Error('Full narrative captions contain an invalid range');
  }
}

export function buildProject8FullNarrativeProps({fullProps, pilotProps}) {
  if (fullProps.fps !== FPS || fullProps.durationInFrames !== 25229) {
    throw new Error(`Unexpected project 8 master timeline: ${fullProps.durationInFrames} frames at ${fullProps.fps}fps`);
  }
  const durationMs = frameToMs(fullProps.durationInFrames);
  const {shots: pilotShots, captions: pilotCaptions} = trimPilot(pilotProps);
  const shots = pilotShots.map((shot) => ({
    ...shot,
    narration: pilotCaptions
      .filter((caption) => caption.startMs >= shot.startMs && caption.startMs < shot.endMs)
      .map((caption) => caption.text)
      .join(''),
  }));
  const captions = [...pilotCaptions];
  let startFrame = 0;
  for (const [index, shot] of fullProps.shots.entries()) {
    const endFrame = startFrame + shot.durationInFrames;
    if (startFrame >= PILOT_END_FRAME) {
      shots.push({
        id: `shot-${String(index + 1).padStart(3, '0')}`,
        startMs: frameToMs(startFrame),
        endMs: frameToMs(endFrame),
        src: sourceForShot(shot),
        narration: shot.narration,
        sourceShotId: shot.storyboardId,
        sourceShotNumber: shot.storyboardNumber,
      });
      captions.push(...captionsForFrameRange({
        idPrefix: `caption-shot-${index + 1}`,
        text: shot.narration,
        startFrame,
        endFrame,
      }));
    }
    startFrame = endFrame;
  }
  const props = {
    durationMs,
    audioSrc: fullProps.audioUrl.replace('http://localhost:', 'http://127.0.0.1:'),
    sequences: buildSequences(fullProps.durationInFrames),
    shots,
    captions,
    bgmTracks: [],
    soundCues: [],
    source: {
      projectId: fullProps.projectId,
      episodeId: fullProps.episodeId,
      fps: fullProps.fps,
      durationInFrames: fullProps.durationInFrames,
      masterAudio: fullProps.audioAssetKey,
      timingSource: fullProps.captionTrack?.timingSource,
      first89Seconds: 'approved narrative storyboard panels and Grok opening video',
      remainingVisuals: 'existing cold_ink_spatial project 8 image assets',
    },
  };
  validateTimeline(props, fullProps.shots.map((shot) => shot.narration).join(''));
  return props;
}

function main(argv = process.argv.slice(2)) {
  const fullPropsPath = valueAfter('--full-props', argv, DEFAULT_FULL_PROPS);
  const pilotPropsPath = valueAfter('--pilot-props', argv, DEFAULT_PILOT_PROPS);
  const outputPath = valueAfter('--output', argv, DEFAULT_OUTPUT);
  const props = buildProject8FullNarrativeProps({
    fullProps: JSON.parse(readFileSync(fullPropsPath, 'utf8')),
    pilotProps: JSON.parse(readFileSync(pilotPropsPath, 'utf8')),
  });
  writeFileSync(outputPath, `${JSON.stringify(props, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    outputPath,
    durationMs: props.durationMs,
    durationInFrames: props.source.durationInFrames,
    sequences: props.sequences.length,
    shots: props.shots.length,
    captions: props.captions.length,
    narrationTracks: props.audioSrc ? 1 : 0,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
