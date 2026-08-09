#!/usr/bin/env node

import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const FPS = 30;
const PILOT_END_FRAME = 2670;
const MAX_BEAT_FRAMES = 180;
const DEFAULT_FULL_PROPS = path.join(root, 'data/temp/remotion-project-8-single-master-props.json');
const DEFAULT_PILOT_PLAN = path.join(root, 'data/temp/project-8-narrative-storyboard-plan.json');
const DEFAULT_PILOT_PROPS = path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json');
const DEFAULT_OUTPUT = path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json');

const BATTLE_PATTERN = /大战|战场|交战|迎战|包围|全军覆没|冲进|杀出来|斩杀|俘获|奔袭|出兵|主力|在战场上/u;
const ARCHERY_PATTERN = /射杀|射死|放箭|中箭|把他射|弓箭|骑马射箭/u;

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

function textParts(text) {
  const normalized = normalizeText(text);
  const clauses = normalized.match(/[^。！？；，：]+[。！？；，：]?/gu) ?? [normalized];
  return clauses.filter(Boolean);
}

function partitionParts(parts, count) {
  if (count <= 1 || parts.length <= 1) return [parts.join('')];
  const total = parts.reduce((sum, part) => sum + [...part].length, 0);
  const groups = [];
  let cursor = 0;
  for (let groupIndex = 0; groupIndex < count; groupIndex += 1) {
    const remainingGroups = count - groupIndex - 1;
    const target = total * (groupIndex + 1) / count;
    let end = cursor + 1;
    let consumed = parts.slice(0, end).reduce((sum, part) => sum + [...part].length, 0);
    while (end < parts.length - remainingGroups && consumed < target) {
      end += 1;
      consumed += [...parts[end - 1]].length;
    }
    groups.push(parts.slice(cursor, end).join(''));
    cursor = end;
  }
  if (cursor < parts.length) groups[groups.length - 1] += parts.slice(cursor).join('');
  return groups.filter(Boolean);
}

function eventClass(text) {
  if (/射杀|射死|放箭|中箭|弓箭|骑马射箭/u.test(text)) return 'archery';
  if (/大战|战场|交战|迎战|包围|全军覆没|冲进|杀出来|斩杀|俘获|奔袭|出兵|主力|大军|骑兵/u.test(text)) return 'battle';
  if (/打伤|动了手|挥击|抓住|杀掉|拔刀|自杀|谋杀/u.test(text)) return 'confrontation';
  if (/小时候|奴仆|放羊|打骂|私生子|父亲家/u.test(text)) return 'childhood';
  if (/汉武帝|皇帝|朝廷|封为|封侯|大司马|皇后|宫廷/u.test(text)) return 'court';
  if (/史记|司马迁|争议|评价|解释|说明|为什么|差别|选择/u.test(text)) return 'analysis';
  return 'historical';
}

function desiredBeatCount(shot) {
  const durationFrames = shot.endFrame - shot.startFrame;
  const text = normalizeText(shot.narration);
  const parts = textParts(text);
  let count = Math.max(1, Math.ceil(durationFrames / MAX_BEAT_FRAMES));
  if (['battle', 'archery', 'confrontation'].includes(eventClass(text)) && durationFrames >= 120) count = Math.max(count, 2);
  if (parts.length >= 3 && durationFrames >= 150) count = Math.max(count, Math.min(3, parts.length));
  return Math.min(4, count);
}

function allocateFrames(startFrame, endFrame, texts) {
  const totalFrames = endFrame - startFrame;
  const weights = texts.map((text) => Math.max(1, [...text].length));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const ranges = [];
  let cursor = startFrame;
  let cumulativeWeight = 0;
  for (let index = 0; index < texts.length; index += 1) {
    cumulativeWeight += weights[index];
    const remaining = texts.length - index - 1;
    const proposed = index === texts.length - 1
      ? endFrame
      : startFrame + Math.round(totalFrames * cumulativeWeight / totalWeight);
    const next = Math.max(cursor + 1, Math.min(endFrame - remaining, proposed));
    ranges.push([cursor, next]);
    cursor = next;
  }
  return ranges;
}

function cameraFor(kind, phase) {
  const cameras = {
    archery: ['Long-lens rear 3/4 MLS', 'Low side WS', 'High aftermath WS'],
    battle: ['Elevated battlefield EWS', 'Ground-level cavalry FS', 'High rear aftermath WS'],
    confrontation: ['Deep corridor WS', 'Tight profile MS', 'High aftermath MS'],
    childhood: ['Layered courtyard WS', 'Threshold eye-level MS', 'Low rear pastoral EWS'],
    court: ['Frontal court WS', 'Three-quarter council MS', 'Low ceremonial MLS'],
    analysis: ['Evidence-led deep-focus WS', 'Controlled two-plane MS', 'Restrained detail CU'],
    historical: ['Layered establishing WS', 'Human-scale three-quarter MS', 'Material detail CU'],
  };
  return cameras[kind]?.[Math.min(phase, 2)] ?? cameras.historical[Math.min(phase, 2)];
}

function phaseLabel(index, total) {
  if (total === 1) return 'decisive visible moment';
  if (index === 0) return 'setup and approach';
  if (index === total - 1) return 'result and changed state';
  return 'action and escalation';
}

function beatDescription({fragment, fullText, kind, index, total}) {
  const phase = phaseLabel(index, total);
  const continuity = total > 1
    ? '保持同一地点、人物身份、服装、武器、屏幕方向和上一格造成的状态变化。'
    : '';
  const staging = kind === 'battle'
    ? '画面必须出现可读的军阵、骑兵运动、攻守方向与战斗结果，不得只画静止将领肖像。'
    : kind === 'archery'
      ? '明确展示弓手、目标、箭矢方向与结果，接触位置可遮挡但因果必须清楚。'
      : kind === 'confrontation'
        ? '明确展示接近、冲突动作、身体重心与结果，不得用持书、站立或泛化议事代替。'
        : kind === 'analysis'
          ? '用旁白涉及的真实人物、地点、证据或后果构成可观察场景，禁止空泛象征画面。'
          : '把旁白转化为当时真实可观察的动作、关系或结果。';
  return `${phase}：${fragment} ${staging}${continuity} 完整上下文：${fullText}`;
}

function shortBeat(fragment) {
  const clean = normalizeText(fragment).replace(/[。！？；，：]/gu, '');
  return [...clean].slice(0, 12).join('') || '叙事动作';
}

function cue(id, type, startMs, endMs, sourceQuery, volume, tags, layer) {
  return {id, type, startMs, endMs, sourceQuery, volume, tags, layer, reusable: true};
}

function transientWindow(startMs, endMs, ratio, durationMs) {
  const center = Math.round(startMs + (endMs - startMs) * ratio);
  const start = Math.max(startMs, center - Math.round(durationMs * 0.35));
  return [start, Math.min(endMs, start + durationMs)];
}

function soundBeatsForEvent(event) {
  const text = normalizeText(event.text);
  const startMs = event.startMs;
  const endMs = event.endMs;
  const cues = [];
  const base = `sound-${event.id}`;
  const missedBattle = /没有赶上主战场|未到战场|迷路/u.test(text);
  const directBattle = !missedBattle && BATTLE_PATTERN.test(text);
  const cavalry = /骑兵|八百骑|一万骑|几十骑|大军|奔袭|出兵|打猎|猎场/u.test(text);
  const wind = /风沙|塞外|漠北|河西|祁连山|草原/u.test(text);

  if (directBattle) {
    // A battle reads as scale, human pressure, and close combat together. Each
    // layer has a distinct source role so it cannot silently collapse into a
    // looping sword impact when the library is incomplete.
    cues.push(cue(`${base}-battle-bed`, 'battle_ambience', startMs, endMs, 'large battlefield distant combat ambience reusable loop', 0.18, ['battle', 'ambient', 'distant'], 'ambient'));
    cues.push(cue(`${base}-battle-crowd`, 'battle_crowd', startMs, endMs, 'battle charge crowd yells reusable loop', 0.14, ['battle', 'crowd', 'charge'], 'ambient'));
    cues.push(cue(`${base}-battle-melee`, 'battle_melee', startMs, endMs, 'battle melee swords shields yells reusable loop', 0.16, ['battle', 'melee', 'combat'], 'ambient'));
    const [clashStart, clashEnd] = transientWindow(startMs, endMs, 0.58, 1800);
    cues.push(cue(`${base}-clash`, 'weapon_clash_cluster', clashStart, clashEnd, 'ancient sword spear shield clash cluster close reusable', 0.29, ['battle', 'weapon', 'impact'], 'action'));
  }
  if (cavalry) {
    cues.push(cue(`${base}-hoof`, 'horse_hoof', startMs, endMs, 'multiple horses cavalry gallop outdoor dirt reusable loop', directBattle ? 0.14 : 0.18, ['horse', 'cavalry'], 'movement'));
  }
  if (wind) {
    cues.push(cue(`${base}-wind`, 'wind_sand', startMs, endMs, 'cold steppe wind sand gust reusable loop', 0.08, ['wind', 'steppe'], 'ambient'));
  }
  if (missedBattle) {
    cues.push(cue(`${base}-lost-march-wind`, 'wind_sand', startMs, endMs, 'lonely dry steppe wind sparse grass reusable loop', 0.09, ['wind', 'lost-march'], 'ambient'));
    cues.push(cue(`${base}-lost-march-tack`, 'horse_tack', startMs, endMs, 'slow tired horse tack leather harness sparse hoof reusable loop', 0.11, ['horse', 'march', 'lost'], 'movement'));
  }
  if (ARCHERY_PATTERN.test(text)) {
    const stages = [
      ['bow-draw', 'bow_draw', 0.22, 900, 'wood bow draw tension leather creak reusable', 0.16, ['bow', 'draw']],
      ['bow-release', 'bow_release', 0.38, 800, 'deep bow string release twang reusable', 0.27, ['bow', 'release']],
      ['arrow-whoosh', 'arrow_whoosh', 0.48, 950, 'single arrow fast whoosh pass reusable', 0.2, ['arrow', 'flight']],
      ['arrow-impact', 'arrow_impact', 0.62, 850, 'arrow impact armor cloth muted reusable', 0.23, ['arrow', 'impact']],
    ];
    for (const [suffix, type, ratio, duration, query, volume, tags] of stages) {
      const [cueStart, cueEnd] = transientWindow(startMs, endMs, ratio, duration);
      cues.push(cue(`${base}-${suffix}`, type, cueStart, cueEnd, query, volume, tags, 'action'));
    }
  }
  if (/打伤|动了手|挥击/u.test(text)) {
    const [hitStart, hitEnd] = transientWindow(startMs, endMs, 0.58, 1000);
    cues.push(cue(`${base}-body-armor-hit`, 'armor_hit', hitStart, hitEnd, 'weapon strike lamellar armor body impact reusable', 0.24, ['weapon', 'armor', 'hit'], 'action'));
  }
  if (/拔刀/u.test(text)) {
    const [drawStart, drawEnd] = transientWindow(startMs, endMs, 0.52, 1000);
    cues.push(cue(`${base}-blade-draw`, 'weapon_draw', drawStart, drawEnd, 'sword blade draw from scabbard reusable', 0.2, ['sword', 'draw'], 'action'));
  }
  return cues.map((sound) => ({...sound, eventId: event.id}));
}

function clonePilotSequence(sequence, isLast, captions) {
  const cloned = structuredClone(sequence);
  if (isLast) {
    cloned.endMs = frameToMs(PILOT_END_FRAME);
    for (const event of cloned.events) event.endMs = Math.min(event.endMs, cloned.endMs);
    for (const beat of cloned.beats) {
      if (Number.isFinite(beat.endMs)) beat.endMs = Math.min(beat.endMs, cloned.endMs);
    }
  }
  for (const event of cloned.events) {
    event.text = captions
      .filter((caption) => caption.startMs >= event.startMs && caption.startMs < event.endMs)
      .map((caption) => caption.text)
      .join('');
  }
  cloned.soundBeats = cloned.events.flatMap(soundBeatsForEvent);
  return cloned;
}

export function buildProject8FullStoryboardSoundPlan({fullProps, pilotPlan, pilotProps}) {
  if (fullProps.fps !== FPS || fullProps.durationInFrames !== 25229) {
    throw new Error(`Unexpected project 8 timeline: ${fullProps.durationInFrames} frames at ${fullProps.fps}fps`);
  }
  const shots = [];
  let frameCursor = 0;
  for (const [index, shot] of fullProps.shots.entries()) {
    const startFrame = frameCursor;
    const endFrame = startFrame + shot.durationInFrames;
    shots.push({...shot, index, startFrame, endFrame});
    frameCursor = endFrame;
  }
  if (frameCursor !== fullProps.durationInFrames) throw new Error('Full props shots do not cover the master duration');

  const shotBoundaries = Array.from(new Set([0, ...shots.map((shot) => shot.endFrame)])).sort((a, b) => a - b);
  const snapBoundary = (frame) => shotBoundaries.reduce((best, candidate) => (
    Math.abs(candidate - frame) < Math.abs(best - frame) ? candidate : best
  ), shotBoundaries[0]);
  const resolvedSequenceSpecs = sequenceSpecs.map(([id, title, startFrame, endFrame], index) => [
    id,
    title,
    index < 3 ? startFrame : snapBoundary(startFrame),
    index < 2 || index === sequenceSpecs.length - 1 ? endFrame : snapBoundary(endFrame),
  ]);

  const sequences = pilotPlan.sequences.map((sequence, index) => clonePilotSequence(
    sequence,
    index === pilotPlan.sequences.length - 1,
    pilotProps.captions,
  ));
  let eventNumber = sequences.flatMap((sequence) => sequence.events).length + 1;
  let beatNumber = sequences.flatMap((sequence) => sequence.beats).length + 1;
  let panelNumber = sequences.flatMap((sequence) => sequence.panels).length + 1;

  for (const [sequenceId, title, startFrame, endFrame] of resolvedSequenceSpecs.slice(3)) {
    const sequence = {
      id: sequenceId,
      title,
      startMs: frameToMs(startFrame),
      endMs: frameToMs(endFrame),
      events: [],
      beats: [],
      panels: [],
      soundBeats: [],
    };
    const sequenceShots = shots.filter((shot) => shot.startFrame >= startFrame && shot.endFrame <= endFrame);
    for (const shot of sequenceShots) {
      const eventId = `evt-${String(eventNumber).padStart(3, '0')}`;
      const event = {
        id: eventId,
        index: eventNumber - 1,
        sourceShotNumber: shot.storyboardNumber,
        startMs: frameToMs(shot.startFrame),
        endMs: frameToMs(shot.endFrame),
        text: shot.narration,
      };
      const count = desiredBeatCount(shot);
      const fragments = partitionParts(textParts(shot.narration), count);
      const ranges = allocateFrames(shot.startFrame, shot.endFrame, fragments);
      const kind = eventClass(shot.narration);
      fragments.forEach((fragment, index) => {
        const beatId = `beat-${String(beatNumber).padStart(3, '0')}`;
        const panelId = `panel-${String(panelNumber).padStart(3, '0')}`;
        const [beatStartFrame, beatEndFrame] = ranges[index];
        sequence.beats.push({
          id: beatId,
          eventId,
          kind: 'cut',
          startMs: frameToMs(beatStartFrame),
          endMs: frameToMs(beatEndFrame),
          sourceText: fragment,
          narrativeClass: kind,
          description: beatDescription({fragment, fullText: shot.narration, kind, index, total: fragments.length}),
        });
        sequence.panels.push({
          id: panelId,
          beatId,
          eventId,
          sourceShotNumber: shot.storyboardNumber,
          description: `${cameraFor(kind, index)} / ${shortBeat(fragment)}`,
        });
        beatNumber += 1;
        panelNumber += 1;
      });
      sequence.events.push(event);
      sequence.soundBeats.push(...soundBeatsForEvent(event));
      eventNumber += 1;
    }
    sequences.push(sequence);
  }

  const soundBeats = sequences.flatMap((sequence) => sequence.soundBeats ?? []);
  const plan = {
    schemaVersion: 'project8-full-narrative-storyboard-v2',
    projectId: 8,
    episodeId: fullProps.episodeId,
    fps: FPS,
    durationInFrames: fullProps.durationInFrames,
    durationMs: frameToMs(fullProps.durationInFrames),
    timingSource: fullProps.captionTrack?.timingSource,
    styleProfile: 'cold_ink_spatial',
    pilotPanelCount: 19,
    sequences,
    soundBeats,
  };
  validatePlan(plan, fullProps);
  return plan;
}

export function validatePlan(plan, fullProps) {
  let sequenceCursor = 0;
  const allEvents = [];
  const allBeats = [];
  const allPanels = [];
  for (const sequence of plan.sequences) {
    if (sequence.startMs !== sequenceCursor || sequence.endMs <= sequence.startMs) throw new Error(`Sequence gap at ${sequence.id}`);
    sequenceCursor = sequence.endMs;
    allEvents.push(...sequence.events);
    allBeats.push(...sequence.beats);
    allPanels.push(...sequence.panels);
    const panelBeatIds = new Set(sequence.panels.map((panel) => panel.beatId));
    if (panelBeatIds.size !== sequence.beats.length || sequence.beats.some((beat) => !panelBeatIds.has(beat.id))) {
      throw new Error(`Every beat must own one panel in ${sequence.id}`);
    }
  }
  if (sequenceCursor !== plan.durationMs) throw new Error('Sequences do not cover the full narration');
  const postPilotBeats = allBeats.filter((beat) => beat.startMs >= frameToMs(PILOT_END_FRAME));
  if (postPilotBeats.some((beat) => beat.endMs - beat.startMs > frameToMs(MAX_BEAT_FRAMES) + 1)) {
    throw new Error('A post-pilot visual beat exceeds the six-second pacing limit');
  }
  const expectedNarration = normalizeText(fullProps.shots.map((shot) => shot.narration).join(''));
  const actualNarration = normalizeText(allEvents.map((event) => event.text).join(''));
  if (expectedNarration !== actualNarration) {
    let mismatch = 0;
    while (mismatch < expectedNarration.length && expectedNarration[mismatch] === actualNarration[mismatch]) mismatch += 1;
    throw new Error(`Events do not partition the narration exactly once at ${mismatch}: expected ${expectedNarration.slice(mismatch, mismatch + 80)}, got ${actualNarration.slice(mismatch, mismatch + 80)}`);
  }
  const soundableEvents = allEvents.filter((event) => /大战|战场|交战|迎战|包围|全军覆没|冲进|杀出来|斩杀|俘获|奔袭|出兵|骑兵|射杀|射死|放箭|骑马射箭|弓箭|打伤|动了手|拔刀/u.test(event.text));
  const soundEventIds = new Set(plan.soundBeats.map((sound) => sound.eventId).filter(Boolean));
  const uncovered = soundableEvents.filter((event) => !soundEventIds.has(event.id));
  if (uncovered.length) throw new Error(`Soundable events have no Sound Beat: ${uncovered.map((event) => `${event.id}:${event.text}`).join(' | ')}`);
  const stagedEvents = new Map(allEvents.map((event) => [event.id, new Set(plan.soundBeats.filter((sound) => sound.eventId === event.id).map((sound) => sound.type))]));
  for (const event of allEvents.filter((candidate) => !/没有赶上主战场|未到战场|迷路/u.test(candidate.text) && BATTLE_PATTERN.test(candidate.text))) {
    const types = stagedEvents.get(event.id) || new Set();
    for (const type of ['battle_ambience', 'battle_crowd', 'battle_melee', 'weapon_clash_cluster']) {
      if (!types.has(type)) throw new Error(`Battle event ${event.id} is missing ${type}`);
    }
  }
  for (const arrowEvent of allEvents.filter((candidate) => ARCHERY_PATTERN.test(candidate.text))) {
    const types = stagedEvents.get(arrowEvent.id) || new Set();
    for (const type of ['bow_draw', 'bow_release', 'arrow_whoosh', 'arrow_impact']) {
      if (!types.has(type)) throw new Error(`Arrow event ${arrowEvent.id} is missing ${type}`);
    }
  }
  return {events: allEvents.length, beats: allBeats.length, panels: allPanels.length, soundBeats: plan.soundBeats.length};
}

async function main(argv = process.argv.slice(2)) {
  const fullPropsPath = valueAfter('--full-props', argv, DEFAULT_FULL_PROPS);
  const pilotPlanPath = valueAfter('--pilot-plan', argv, DEFAULT_PILOT_PLAN);
  const pilotPropsPath = valueAfter('--pilot-props', argv, DEFAULT_PILOT_PROPS);
  const outputPath = valueAfter('--output', argv, DEFAULT_OUTPUT);
  const fullProps = JSON.parse(readFileSync(fullPropsPath, 'utf8'));
  const plan = buildProject8FullStoryboardSoundPlan({
    fullProps,
    pilotPlan: JSON.parse(readFileSync(pilotPlanPath, 'utf8')),
    pilotProps: JSON.parse(readFileSync(pilotPropsPath, 'utf8')),
  });
  writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  const stats = validatePlan(plan, fullProps);
  process.stdout.write(`${JSON.stringify({outputPath, ...stats, sequences: plan.sequences.length}, null, 2)}\n`);

  // --- DB 同步：把层级计划写进 narrative_plans（失败不阻塞，可用 backfill 脚本补） ---
  const apiBase = (process.env.HUOBAO_API_BASE || 'http://127.0.0.1:5679').replace(/\/$/u, '');
  try {
    const response = await fetch(`${apiBase}/api/v1/remotion/projects/8/narrative-hierarchy/import-document`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({kind: 'full', plan}),
    });
    if (!response.ok) {
      process.stderr.write(`narrative-hierarchy import-document -> ${response.status}\n`);
    } else {
      const body = await response.json().catch(() => null);
      process.stdout.write(`narrative-hierarchy imported: ${JSON.stringify(body?.data ?? {})}\n`);
    }
  } catch (error) {
    process.stderr.write(`narrative-hierarchy import skipped: ${error?.message || error}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
