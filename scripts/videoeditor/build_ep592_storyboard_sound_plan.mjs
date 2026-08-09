#!/usr/bin/env node
/**
 * 为 episode 592（霍去病为什么敢切断补给线）生成真实叙事层级计划并写库。
 *
 * 背景：该集走过了 storyboard → TTS → grid 生产图，但从未做过「叙事连续性设计」，
 * narrative plan 只有 ensureNarrativePlanFromStoryboards 的兜底 shim（单个"主序列"）。
 * 本脚本参照 build_project8_full_storyboard_sound_plan.mjs 的产物形状：
 *   Sequence（编辑分组）→ Event（= 分镜，精确 TTS 时间窗）→ Beat（cut）→ Panel（sb-*）
 *   → Shot（每事件一个）+ Sound Beats（按事件文本匹配的音效提示）
 *
 * 时间对齐：分镜旁白（narration || description）归一化后与 MiniMax titles 文本流
 * 顺序匹配，字符位置线性插值到 title 的 time_begin/time_end。不用 storyboard.duration。
 *
 * Panel key 保持 `sb-{storyboardId}`：与 updatePanelStatusFromImageGeneration 的
 * 状态回写链路、gridCells 元数据反查保持一致。finalPath 取自 gridCells.cells[].src。
 *
 * 用法：node scripts/videoeditor/build_ep592_storyboard_sound_plan.mjs [--dry-run]
 * 需要后端在 HUOBAO_API_BASE（默认 http://127.0.0.1:3013）运行。
 */

import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'backend/package.json'));
const Database = require('better-sqlite3');

const EPISODE_ID = 592;
const REMOTION_PROJECT_ID = 9;
const STYLE_PROFILE = 'cold_ink_spatial';
const PILOT_MAX_MS = 60_000;
const OUTPUT = path.join(root, 'data/temp/episode-592-storyboard-sound-plan.json');
const API_BASE = (process.env.HUOBAO_API_BASE || 'http://127.0.0.1:3013').replace(/\/$/u, '');

// 编辑分组：按分镜号划分戏剧单元（连续场景 / 同一论点 / 同一地理与方向）
const sequenceSpecs = [
  ['seq-01-monan-boy-volunteers', '漠南绞杀，少年请战', 1, 9],
  ['seq-02-supply-line-deadlock', '补给线的死局', 10, 20],
  ['seq-03-a-conspiracy', '一场合谋：授权与赌局', 21, 30],
  ['seq-04-live-off-the-enemy', '以战养战', 31, 38],
  ['seq-05-finding-the-enemy', '大漠索敌', 39, 46],
  ['seq-06-no-ancient-art', '顾方略何如耳', 47, 53],
  ['seq-07-institutional-favor', '输得起的偏宠', 54, 59],
  ['seq-08-three-conditions', '三个条件的合流', 60, 65],
  ['seq-09-born-to-be-short', '注定短命的组合', 66, 69],
  ['seq-10-knife-without-supply', '没有补给线的刀', 70, 71],
];

const normalize = (t) => String(t || '').replace(/[\s，。！？；：、""''（）《》〈〉—…·\-,.!?;:()「」]/gu, '');

/* ===== SFX：按事件文本匹配音效层（复用 project8 的分层思路，内容面向本集） ===== */

const BATTLE = /大战|战场|绞杀|对抗|血肉模糊|全军覆没|斩首|铁骑|突袭|凿穿|杀|奔袭|狂飙|连拔|冲锋|赌命/u;
const CAVALRY = /骑兵|八百|800|一万|大军|马|狂奔|狂飙|跨|奔/u;
const STEPPE = /大漠|戈壁|漠南|草原|荒原|祁连|河西|风沙|水源|草场|匈奴/u;
const SUPPLY = /粮|后勤|补给|运|民夫|驮马|辎重|失血/u;

function cue(id, type, startMs, endMs, sourceQuery, volume, tags, layer) {
  return { id, type, startMs, endMs, sourceQuery, volume, tags, layer, reusable: true };
}

function transientWindow(startMs, endMs, ratio, durationMs) {
  const center = Math.round(startMs + (endMs - startMs) * ratio);
  const start = Math.max(startMs, center - Math.round(durationMs * 0.35));
  return [start, Math.min(endMs, start + durationMs)];
}

function soundBeatsForEvent(event) {
  const text = normalize(event.text);
  const { startMs, endMs } = event;
  const cues = [];
  const base = `sound-${event.id}`;
  const battle = BATTLE.test(text);
  if (battle) {
    cues.push(cue(`${base}-battle-bed`, 'battle_ambience', startMs, endMs, 'large battlefield distant combat ambience reusable loop', 0.18, ['battle', 'ambient', 'distant'], 'ambient'));
    cues.push(cue(`${base}-battle-crowd`, 'battle_crowd', startMs, endMs, 'battle charge crowd yells reusable loop', 0.14, ['battle', 'crowd', 'charge'], 'ambient'));
    cues.push(cue(`${base}-battle-melee`, 'battle_melee', startMs, endMs, 'battle melee swords shields yells reusable loop', 0.16, ['battle', 'melee', 'combat'], 'ambient'));
    const [cs, ce] = transientWindow(startMs, endMs, 0.58, 1800);
    cues.push(cue(`${base}-clash`, 'weapon_clash_cluster', cs, ce, 'ancient sword spear shield clash cluster close reusable', 0.29, ['battle', 'weapon', 'impact'], 'action'));
  }
  if (CAVALRY.test(text)) {
    cues.push(cue(`${base}-hoof`, 'horse_hoof', startMs, endMs, 'multiple horses cavalry gallop outdoor dirt reusable loop', battle ? 0.14 : 0.18, ['horse', 'cavalry'], 'movement'));
  }
  if (STEPPE.test(text)) {
    cues.push(cue(`${base}-wind`, 'wind_sand', startMs, endMs, 'cold steppe wind sand gust reusable loop', 0.08, ['wind', 'steppe'], 'ambient'));
  }
  if (!battle && SUPPLY.test(text)) {
    cues.push(cue(`${base}-caravan`, 'supply_caravan', startMs, endMs, 'wooden cart wheels draft animals slow caravan reusable loop', 0.12, ['supply', 'caravan', 'march'], 'movement'));
  }
  return cues;
}

/* ===== 数据装载 ===== */

function loadInputs() {
  const db = new Database(path.join(root, 'data/huobao_drama.db'), { readonly: true });
  const ep = db.prepare('SELECT id, pre_tts_titles_json FROM episodes WHERE id = ?').get(EPISODE_ID);
  if (!ep?.pre_tts_titles_json) throw new Error(`episode ${EPISODE_ID} 缺少 pre_tts_titles_json`);
  const titles = JSON.parse(ep.pre_tts_titles_json);
  const storyboards = db.prepare(
    'SELECT id, storyboard_number, title, description, narration, grid_sheet_image, grid_cells FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number',
  ).all(EPISODE_ID);
  if (!storyboards.length) throw new Error(`episode ${EPISODE_ID} 没有分镜`);
  const generations = db.prepare(
    "SELECT storyboard_id, id, local_path FROM image_generations WHERE storyboard_id IN (SELECT id FROM storyboards WHERE episode_id = ?) AND status = 'completed'",
  ).all(EPISODE_ID);
  db.close();
  return { titles, storyboards, generations };
}

/* ===== 时间轴：字符位置 → MiniMax 时间 ===== */

function buildTimeline(titles) {
  let stream = '';
  const spans = [];
  for (const t of titles) {
    const text = normalize(t.text);
    spans.push({ startChar: stream.length, endChar: stream.length + text.length, startMs: t.time_begin, endMs: t.time_end });
    stream += text;
  }
  const timeAt = (pos) => {
    for (const sp of spans) {
      if (pos <= sp.endChar) {
        const len = Math.max(1, sp.endChar - sp.startChar);
        const ratio = Math.min(1, Math.max(0, (pos - sp.startChar) / len));
        return Math.round(sp.startMs + ratio * (sp.endMs - sp.startMs));
      }
    }
    return spans[spans.length - 1].endMs;
  };
  return { stream, spans, timeAt, durationMs: Math.round(spans[spans.length - 1].endMs) };
}

/* ===== 计划构建 ===== */

export function buildEpisode592SoundPlan({ titles, storyboards, generations }) {
  const { stream, timeAt, durationMs } = buildTimeline(titles);

  // 每个分镜在文本流中的位置 → 精确时间窗
  let cursor = 0;
  const windows = new Map();
  for (const sb of storyboards) {
    const text = normalize(sb.narration || sb.description);
    if (!text) throw new Error(`分镜 #${sb.storyboard_number} 没有可对齐的旁白文本`);
    let idx = stream.indexOf(text, cursor);
    if (idx < 0) idx = stream.indexOf(text);
    if (idx < 0) throw new Error(`分镜 #${sb.storyboard_number} 的旁白不在 TTS 文本流中：${text.slice(0, 30)}`);
    windows.set(sb.storyboard_number, { startMs: timeAt(idx), endMs: timeAt(idx + text.length) });
    cursor = idx;
  }

  const gridCellOf = (sb) => {
    try {
      const gc = sb.grid_cells ? JSON.parse(sb.grid_cells) : null;
      const cell = (gc?.cells ?? []).find((c) => typeof c?.src === 'string' && c.src);
      return { cell, displayTitle: gc?.displayTitle ?? null };
    } catch { return { cell: null, displayTitle: null }; }
  };
  const generationByPath = new Map();
  for (const g of generations) {
    if (g.local_path) generationByPath.set(String(g.local_path).replace(/^\//, ''), g);
  }

  const panelStates = [];
  const sequences = [];
  let eventNumber = 1;
  for (const [seqKey, title, fromNum, toNum] of sequenceSpecs) {
    const members = storyboards.filter((sb) => sb.storyboard_number >= fromNum && sb.storyboard_number <= toNum);
    if (!members.length) throw new Error(`sequence ${seqKey} 没有分镜`);
    const seqStart = windows.get(members[0].storyboard_number).startMs;
    const seqEnd = windows.get(members[members.length - 1].storyboard_number).endMs;
    const events = [];
    const beats = [];
    const panels = [];
    const shots = [];
    const sounds = [];
    for (const sb of members) {
      const w = windows.get(sb.storyboard_number);
      const eventKey = `evt-${String(eventNumber).padStart(3, '0')}`;
      const beatKey = `beat-${String(eventNumber).padStart(3, '0')}`;
      const shotKey = `shot-${String(eventNumber).padStart(3, '0')}`;
      const panelKey = `sb-${sb.id}`;
      const text = String(sb.narration || sb.description || '').trim();
      const { cell, displayTitle } = gridCellOf(sb);
      events.push({ eventKey, eventIndex: eventNumber - 1, startMs: w.startMs, endMs: w.endMs, text });
      beats.push({
        beatKey,
        eventKey,
        kind: 'cut',
        startMs: w.startMs,
        endMs: w.endMs,
        description: `${displayTitle || sb.title || '叙事动作'}：${text}`,
      });
      panels.push({
        panelKey,
        beatKey,
        eventKey,
        description: cell?.description || sb.description || sb.title || '',
      });
      shots.push({
        shotKey,
        eventKey,
        sourceKind: 'cut',
        sourceBeatKey: beatKey,
        description: `${(w.startMs / 1000).toFixed(1)}s–${(w.endMs / 1000).toFixed(1)}s`,
        startMs: w.startMs,
        endMs: w.endMs,
      });
      sounds.push(...soundBeatsForEvent({ id: eventKey, text, startMs: w.startMs, endMs: w.endMs }));
      const src = cell ? String(cell.src).replace(/^\//, '') : (sb.grid_sheet_image || null);
      if (src) {
        panelStates.push({
          panelKey,
          genStatus: 'completed',
          generationId: generationByPath.get(src)?.id ?? null,
          finalPath: src,
        });
      }
      eventNumber += 1;
    }
    const mappedSounds = sounds.map(({ id, ...rest }) => ({ soundKey: id, ...rest }));
    sequences.push({ seqKey, title, startMs: seqStart, endMs: seqEnd, events, beats, panels, shots, sounds: mappedSounds });
  }

  const plan = {
    kind: 'full',
    styleProfile: STYLE_PROFILE,
    durationMs,
    timingSource: 'tts-time-begin-end',
    sourcePath: path.relative(root, OUTPUT),
    sequences,
    panelStates,
  };
  validatePlan(plan, storyboards, stream);
  return plan;
}

export function buildPilotPlan(fullPlan) {
  const clip = (v) => Math.min(v, PILOT_MAX_MS);
  const sequences = [];
  const panelStates = [];
  for (const seq of fullPlan.sequences) {
    if (seq.startMs >= PILOT_MAX_MS) break;
    const events = seq.events.filter((e) => e.startMs < PILOT_MAX_MS)
      .map((e) => ({ ...e, endMs: clip(e.endMs) }));
    if (!events.length) continue;
    const eventKeys = new Set(events.map((e) => e.eventKey));
    sequences.push({
      ...seq,
      endMs: clip(seq.endMs),
      events,
      beats: seq.beats.filter((b) => eventKeys.has(b.eventKey)).map((b) => ({ ...b, endMs: clip(b.endMs) })),
      panels: seq.panels.filter((p) => eventKeys.has(p.eventKey)),
      shots: seq.shots.filter((s) => eventKeys.has(s.eventKey)).map((s) => ({ ...s, endMs: clip(s.endMs) })),
      sounds: seq.sounds.filter((s) => s.startMs < PILOT_MAX_MS).map((s) => ({ ...s, endMs: clip(s.endMs) })),
    });
  }
  const pilotPanelKeys = new Set(sequences.flatMap((s) => s.panels.map((p) => p.panelKey)));
  for (const st of fullPlan.panelStates) {
    if (pilotPanelKeys.has(st.panelKey)) panelStates.push(st);
  }
  return { ...fullPlan, kind: 'pilot', durationMs: PILOT_MAX_MS, sequences, panelStates };
}

/* ===== 校验（对齐 project8 validatePlan 的核心契约） ===== */

function validatePlan(plan, storyboards, titleStream) {
  let cursor = 0;
  const allEvents = [];
  for (const seq of plan.sequences) {
    if (seq.startMs > cursor + 1) throw new Error(`Sequence gap before ${seq.seqKey}`);
    cursor = Math.max(cursor, seq.endMs);
    allEvents.push(...seq.events);
    const panelBeatIds = new Set(seq.panels.map((p) => p.beatKey));
    if (panelBeatIds.size !== seq.beats.length || seq.beats.some((b) => !panelBeatIds.has(b.beatKey))) {
      throw new Error(`Every beat must own one panel in ${seq.seqKey}`);
    }
    for (const evt of seq.events) {
      if (!(evt.startMs < evt.endMs)) throw new Error(`事件时间窗无效 ${evt.eventKey}: ${evt.startMs}-${evt.endMs}`);
    }
  }
  if (cursor < plan.durationMs - 1) throw new Error(`Sequences 未覆盖全片: ${cursor} < ${plan.durationMs}`);
  const narration = normalize(allEvents.map((e) => e.text).join(''));
  if (narration !== titleStream) {
    let i = 0;
    while (i < narration.length && narration[i] === titleStream[i]) i += 1;
    throw new Error(`事件未恰好一次划分旁白，首个偏差 @${i}: ${narration.slice(i, i + 40)} != ${titleStream.slice(i, i + 40)}`);
  }
  const panelsWithImage = plan.panelStates.filter((s) => s.finalPath).length;
  if (panelsWithImage !== storyboards.length) {
    throw new Error(`生产图覆盖不足: ${panelsWithImage}/${storyboards.length}`);
  }
  return { events: allEvents.length, panels: plan.sequences.flatMap((s) => s.panels).length, sounds: plan.sequences.flatMap((s) => s.sounds).length };
}

/* ===== 写库 ===== */

async function importPlan(plan) {
  const url = `${API_BASE}/api/v1/remotion/projects/${REMOTION_PROJECT_ID}/narrative-hierarchy/import`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`import ${plan.kind} -> ${response.status}: ${JSON.stringify(body)}`);
  return body?.data ?? body;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const inputs = loadInputs();
  const fullPlan = buildEpisode592SoundPlan(inputs);
  const pilotPlan = buildPilotPlan(fullPlan);
  writeFileSync(OUTPUT, `${JSON.stringify({ full: fullPlan, pilot: pilotPlan }, null, 2)}\n`);
  const stats = {
    sequences: fullPlan.sequences.length,
    events: fullPlan.sequences.flatMap((s) => s.events).length,
    beats: fullPlan.sequences.flatMap((s) => s.beats).length,
    panels: fullPlan.sequences.flatMap((s) => s.panels).length,
    sounds: fullPlan.sequences.flatMap((s) => s.sounds).length,
    panelStates: fullPlan.panelStates.length,
    durationMs: fullPlan.durationMs,
    pilotEvents: pilotPlan.sequences.flatMap((s) => s.events).length,
  };
  process.stdout.write(`${JSON.stringify({ output: OUTPUT, ...stats }, null, 2)}\n`);
  if (dryRun) return;
  process.stdout.write(`import full: ${JSON.stringify(await importPlan(fullPlan))}\n`);
  process.stdout.write(`import pilot: ${JSON.stringify(await importPlan(pilotPlan))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
