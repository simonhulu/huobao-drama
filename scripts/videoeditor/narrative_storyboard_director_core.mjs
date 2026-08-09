import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const sha256 = (filePath) => crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex');

function sourceName(source) {
  const pathname = new URL(source, 'http://narrative-storyboard.local').pathname;
  return path.basename(pathname, path.extname(pathname));
}

function probe(filePath, kind) {
  const payload = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], {encoding: 'utf8'}));
  const stream = payload.streams?.find((candidate) => candidate.codec_type === 'video');
  if (!stream) throw new Error(`Unable to probe ${filePath}`);
  const metadata = {
    width: Number(stream.width),
    height: Number(stream.height),
    codec: stream.codec_name,
    mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
  };
  if (kind === 'video') {
    const durationSeconds = Number(stream.duration ?? payload.format?.duration);
    if (Number.isFinite(durationSeconds)) metadata.durationSeconds = durationSeconds;
    if (stream.r_frame_rate && stream.r_frame_rate !== '0/0') {
      const [numerator, denominator] = stream.r_frame_rate.split('/').map(Number);
      if (numerator && denominator) metadata.frameRate = numerator / denominator;
    }
  }
  return metadata;
}

export function flattenNarrativeStoryboardVisuals(props, limitMs = props.durationMs) {
  const intervals = [];
  for (const shot of props.shots) {
    if (Array.isArray(shot.waypoints) && shot.waypoints.length > 0) {
      for (const waypoint of shot.waypoints) {
        if (typeof waypoint === 'string') throw new Error(`Timed Narrative Storyboard waypoint ${shot.id} must be an object`);
        intervals.push({
          id: `${shot.id}:${sourceName(waypoint.src ?? waypoint.imageSrc)}`,
          parentShotId: shot.id,
          startMs: waypoint.startMs,
          endMs: waypoint.endMs,
          imageSrc: waypoint.src ?? waypoint.imageSrc,
          anchorText: waypoint.anchorText,
        });
      }
    } else {
      intervals.push({
        id: shot.id,
        parentShotId: shot.id,
        startMs: shot.startMs,
        endMs: shot.endMs,
        imageSrc: shot.src ?? shot.imageSrc,
        videoSrc: shot.videoSrc,
      });
    }
  }
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.startMs !== cursor || interval.endMs <= interval.startMs) {
      throw new Error(`Visual intervals must be positive and contiguous at ${interval.id}: expected ${cursor}, got ${interval.startMs}-${interval.endMs}`);
    }
    cursor = interval.endMs;
  }
  if (cursor !== props.durationMs) throw new Error(`Visual intervals end at ${cursor}, expected ${props.durationMs}`);
  return intervals.filter((interval) => interval.startMs < limitMs).map((interval) => ({...interval, endMs: Math.min(interval.endMs, limitMs)}));
}

export function truncateNarrativeStoryboardProps(baseProps, limitMs) {
  const props = structuredClone(baseProps);
  props.durationMs = limitMs;
  props.captions = props.captions.filter((caption) => caption.startMs < limitMs).map((caption) => ({...caption, endMs: Math.min(caption.endMs, limitMs)}));
  props.sequences = props.sequences.filter((sequence) => sequence.startMs < limitMs).map((sequence) => ({...sequence, endMs: Math.min(sequence.endMs, limitMs)}));
  props.shots = props.shots.filter((shot) => shot.startMs < limitMs).map((shot) => {
    const next = {...shot, endMs: Math.min(shot.endMs, limitMs)};
    if (shot.waypoints?.length) {
      next.waypoints = shot.waypoints
        .filter((waypoint) => typeof waypoint === 'string' || waypoint.startMs < limitMs)
        .map((waypoint) => typeof waypoint === 'string' ? waypoint : {...waypoint, endMs: Math.min(waypoint.endMs, limitMs)});
    }
    return next;
  });
  if (props.bgmTracks) props.bgmTracks = props.bgmTracks.filter((track) => track.startMs < limitMs).map((track) => ({...track, endMs: Math.min(track.endMs, limitMs)}));
  if (props.soundCues) props.soundCues = props.soundCues.filter((cue) => cue.startMs < limitMs).map((cue) => ({...cue, endMs: Math.min(cue.endMs, limitMs)}));
  return props;
}

export function validateNarrativeAudioPlan({durationMs, bgmTracks = [], soundCues = []}) {
  const ids = new Set();
  const validate = (item, kind) => {
    if (!item || typeof item !== 'object') throw new Error(`${kind} must be an object`);
    if (typeof item.id !== 'string' || !item.id) throw new Error(`${kind} requires a stable id`);
    if (ids.has(item.id)) throw new Error(`Duplicate audio id ${item.id}`);
    ids.add(item.id);
    if (typeof item.src !== 'string' || !item.src) throw new Error(`${kind} ${item.id} requires src`);
    if (!Number.isInteger(item.startMs) || !Number.isInteger(item.endMs) || item.startMs < 0 || item.endMs <= item.startMs || item.endMs > durationMs) {
      throw new Error(`${kind} ${item.id} must stay inside 0-${durationMs}ms`);
    }
    if (typeof item.volume !== 'number' || item.volume < 0 || item.volume > 1) throw new Error(`${kind} ${item.id} volume must be 0-1`);
    if (item.role === 'narration') throw new Error(`${kind} ${item.id} must not create a second narration track`);
    if (item.sourceStartMs !== undefined && (!Number.isInteger(item.sourceStartMs) || item.sourceStartMs < 0)) {
      throw new Error(`${kind} ${item.id} sourceStartMs must be a non-negative integer`);
    }
    if (item.gainPoints !== undefined) {
      if (!Array.isArray(item.gainPoints) || item.gainPoints.length === 0) throw new Error(`${kind} ${item.id} gain points must be a non-empty array`);
      let pointCursor = -1;
      const localDuration = item.endMs - item.startMs;
      for (const point of item.gainPoints) {
        if (!Number.isInteger(point.atMs) || point.atMs < 0 || point.atMs > localDuration || point.atMs <= pointCursor) {
          throw new Error(`${kind} ${item.id} gain points must be strictly ordered inside the track`);
        }
        if (typeof point.gain !== 'number' || point.gain < 0 || point.gain > 1.5) throw new Error(`${kind} ${item.id} gain points must use gain 0-1.5`);
        pointCursor = point.atMs;
      }
    }
    return structuredClone(item);
  };
  return {
    bgmTracks: bgmTracks.map((track) => validate(track, 'BGM track')),
    soundCues: soundCues.map((cue) => validate(cue, 'Sound cue')),
  };
}

function visualNodes(props) {
  return props.shots.flatMap((shot) => {
    if (!shot.waypoints?.length) return [{node: shot, startMs: shot.startMs, endMs: shot.endMs}];
    return shot.waypoints.map((node) => {
      if (typeof node === 'string') throw new Error(`Timed Narrative Storyboard waypoint ${shot.id} must be an object`);
      return {node, startMs: node.startMs, endMs: node.endMs};
    });
  });
}

function narrationFor(props, interval, limitMs) {
  if (interval.anchorText) return interval.anchorText;
  const context = [...new Set(props.captions
    .filter((caption) => caption.endMs > interval.startMs && caption.startMs < interval.endMs)
    .map((caption) => caption.text.trim())
    .filter(Boolean))].join(' ');
  const continuation = limitMs < props.durationMs && interval.endMs === limitMs ? ' 叙事未完，继续。' : '';
  return `${context || interval.id}${continuation}`;
}

export function buildNarrativeStoryboardDirectorInputs({
  root,
  propsPath,
  work,
  outputRoot,
  limitMs,
  fps = 30,
  staticPathForSource,
  hintForInterval = () => undefined,
  projectLabel = 'Narrative Storyboard project',
}) {
  const props = JSON.parse(readFileSync(propsPath, 'utf8'));
  const effectiveLimitMs = Math.min(props.durationMs, limitMs ?? props.durationMs);
  const intervals = flattenNarrativeStoryboardVisuals(props, effectiveLimitMs);
  mkdirSync(work, {recursive: true});
  const assets = intervals.map((interval, index) => {
    const kind = interval.videoSrc ? 'video' : 'image';
    const assetPath = staticPathForSource(interval.videoSrc ?? interval.imageSrc);
    const stats = statSync(assetPath);
    const assetId = `narrative-visual-${String(index + 1).padStart(3, '0')}`;
    return {
      assetId,
      kind,
      path: assetPath,
      sha256: sha256(assetPath),
      byteSize: stats.size,
      mediaMetadata: probe(assetPath, kind),
      subjectIds: [assetId],
      entityIds: [`narrative-${interval.parentShotId}`],
      provenance: {source: kind === 'video' ? 'approved opening video' : 'approved Narrative Storyboard final panel', owner: projectLabel, notes: `${interval.id}; locked ${interval.startMs}-${interval.endMs}ms visual interval`},
      licenseStatus: 'project_owned',
    };
  });
  const spans = intervals.map((interval, index) => {
    const editorialHint = hintForInterval(interval, index);
    return {
      spanId: `visual-${String(index + 1).padStart(3, '0')}`,
      startSeconds: interval.startMs / 1000,
      endSeconds: interval.endMs / 1000,
      text: narrationFor(props, interval, effectiveLimitMs),
      ...(editorialHint ? {editorialHint} : {}),
    };
  });
  const durationSeconds = effectiveLimitMs / 1000;
  const inventoryPath = path.join(work, 'asset-inventory.json');
  const timingPath = path.join(work, 'timed-transcript.json');
  const narrationPath = path.join(work, 'narration.txt');
  const manifestPath = path.join(work, 'manifest.json');
  writeFileSync(inventoryPath, `${JSON.stringify({schemaVersion: 'editorial://schema/asset-inventory/v1', inventoryVersion: 1, assets}, null, 2)}\n`);
  writeFileSync(timingPath, `${JSON.stringify({schemaVersion: 'editorial://schema/timed-transcript/v1', durationSeconds, spans}, null, 2)}\n`);
  writeFileSync(narrationPath, `${spans.map(({text}) => text).join('\n')}\n`);
  writeFileSync(manifestPath, `${JSON.stringify({
    runSchemaVersion: 1,
    operation: 'plan-edit',
    narration: {script: narrationPath, timing: timingPath},
    assets: inventoryPath,
    target: {profile: {profileId: 'youtube-720p', width: 1280, height: 720, fps}, outputPolicy: {container: 'mp4', codec: 'h264', pixelFormat: 'yuv420p', audioMode: 'optional', safeArea: {left: 0.05, right: 0.05, top: 0.05, bottom: 0.05}, videoBitrate: '6M'}},
    outputRoot,
    modelPolicy: {authoringMode: 'deterministic', reviewMode: 'deterministic'},
    policy: {analysisTimeoutSeconds: 120, maxRunBytes: 2000000000},
  }, null, 2)}\n`);
  return {manifestPath, inventoryPath, timingPath, intervalCount: intervals.length, durationInFrames: Math.round(durationSeconds * fps), durationSeconds};
}

export function applyNarrativeStoryboardRecipe({baseProps, recipe, limitMs, normalizeTextCue = (cue) => cue}) {
  const props = truncateNarrativeStoryboardProps(baseProps, limitMs);
  const nodes = visualNodes(props);
  if (recipe.schemaVersion !== 'magnates-remotion-recipe-v2') throw new Error(`Unsupported recipe schema: ${recipe.schemaVersion}`);
  if (recipe.durationInFrames !== Math.round(limitMs / 1000 * recipe.fps)) throw new Error(`Recipe duration ${recipe.durationInFrames} does not match ${limitMs}ms at ${recipe.fps}fps`);
  if (recipe.shots.length !== nodes.length) throw new Error(`Recipe visual count ${recipe.shots.length} does not match props visual count ${nodes.length}`);
  for (const [index, {node, startMs, endMs}] of nodes.entries()) {
    const treatment = recipe.shots[index];
    const expectedFrames = Math.round(endMs / 1000 * recipe.fps) - Math.round(startMs / 1000 * recipe.fps);
    if (treatment.durationInFrames !== expectedFrames) throw new Error(`Visual ${index + 1} frame mismatch: recipe=${treatment.durationInFrames}, props=${expectedFrames}`);
    node.editorial = {
      camera: treatment.camera,
      transitionOut: treatment.transitionOut,
      semanticRole: treatment.semanticRole,
      parallax: node.videoSrc ? 0 : Math.min(0.5, 0.18 + (treatment.camera?.intensity ?? 0.5) * 0.24),
      texts: (treatment.texts ?? []).map((cue, cueIndex) => normalizeTextCue(cue, treatment, index + cueIndex)),
    };
  }
  return {props, visualIntervals: nodes.length};
}
