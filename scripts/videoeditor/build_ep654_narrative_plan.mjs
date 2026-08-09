#!/usr/bin/env node

/**
 * 为 episode 654（拉美西斯二世：血统机器）生成叙事层级计划并写库。
 */

import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'backend/package.json'));
const Database = require('better-sqlite3');

const EPISODE_ID = 654;
const REMOTION_PROJECT_ID = 14;
const STYLE_PROFILE = 'republican_shanghai';
const OUTPUT = path.join(root, 'data/temp/episode-654-narrative-plan.json');
const API_BASE = (process.env.HUOBAO_API_BASE || 'http://127.0.0.1:5679').replace(/\/$/u, '');

// 10 段编辑分组对应原始文稿的 10 个段落（精确分镜号分布）
const sequenceSpecs = [
  ['seq-01-eight-queens', '八位王后，血亲婚姻', 1, 8],
  ['seq-02-divine-pharaoh', '法老即神：血统的神学基础', 9, 20],
  ['seq-03-nefertari-propaganda', '奈菲尔塔利：神庙广告牌', 21, 31],
  ['seq-04-blood-closed-loop', '血统闭环：权力即婚姻', 32, 40],
  ['seq-05-daughters-as-cogs', '女儿们：权力机器中的齿轮', 41, 54],
  ['seq-06-backfire-reversal', '反噬：熬死所有王储', 55, 66],
  ['seq-07-genetic-cost', '基因代价：近亲繁殖的遗产', 67, 78],
  ['seq-08-modern-romanticization', '三千年后：浪漫化的消音', 79, 92],
  ['seq-09-not-alone', '不只古埃及：哈布斯堡的镜子', 93, 104],
  ['seq-10-who-was-silenced', '谁被消音了？', 105, 116],
];

function normalize(s) {
  return (s || '').replace(/[\s\n\r​-‍﻿]/g, '').replace(/[，。！？、；：""''（）—…·]/g, '');
}

function loadInputs() {
  const db = new Database(path.join(root, 'data/huobao_drama.db'), { readonly: true });
  const ep = db.prepare('SELECT id, pre_tts_titles_json FROM episodes WHERE id = ?').get(EPISODE_ID);
  if (!ep?.pre_tts_titles_json) throw new Error(`episode ${EPISODE_ID} 缺少 pre_tts_titles_json`);
  const titles = JSON.parse(ep.pre_tts_titles_json);
  const storyboards = db.prepare(
    'SELECT id, storyboard_number, narration, duration FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number',
  ).all(EPISODE_ID);
  if (!storyboards.length) throw new Error(`episode ${EPISODE_ID} 没有分镜`);
  console.log(`Loaded ${titles.length} titles, ${storyboards.length} storyboards`);
  db.close();
  return { titles, storyboards };
}

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

function buildPlan({ titles, storyboards }) {
  const { stream, timeAt, durationMs } = buildTimeline(titles);

  // Map each storyboard to TTS timeline
  let cursor = 0;
  const windows = new Map();
  for (const sb of storyboards) {
    const text = normalize(sb.narration);
    if (!text) throw new Error(`分镜 #${sb.storyboard_number} 没有旁白文本`);
    let idx = stream.indexOf(text, cursor);
    if (idx < 0) idx = stream.indexOf(text);
    if (idx < 0) {
      console.warn(`分镜 #${sb.storyboard_number} 不在 TTS 流中："${(sb.narration || '').slice(0, 30)}"，使用相邻位置`);
      // 用上一个镜头的结束位置作为参考
      const prevWindow = windows.get(sb.storyboard_number - 1);
      if (prevWindow) {
        const estStart = prevWindow.endMs;
        const estEnd = estStart + sb.duration * 1000;
        windows.set(sb.storyboard_number, { startMs: estStart, endMs: estEnd });
      }
      continue;
    }
    windows.set(sb.storyboard_number, { startMs: timeAt(idx), endMs: timeAt(idx + text.length) });
    cursor = idx + text.length;
  }

  const sequences = [];
  let eventNumber = 0;

  for (const [seqKey, title, fromNum, toNum] of sequenceSpecs) {
    const members = storyboards.filter((sb) => sb.storyboard_number >= fromNum && sb.storyboard_number <= toNum);
    if (!members.length) {
      console.warn(`Sequence ${seqKey} 没有分镜，跳过`);
      continue;
    }

    const firstWin = windows.get(members[0].storyboard_number);
    const lastWin = windows.get(members[members.length - 1].storyboard_number);
    const seqStart = firstWin?.startMs ?? members[0].duration * 1000;
    const seqEnd = lastWin?.endMs ?? (members[members.length - 1].duration + (members.filter(sb => windows.has(sb.storyboard_number)).reduce((sum, sb) => sum + (windows.get(sb.storyboard_number)?.startMs ?? 0), 0) / members.filter(sb => windows.has(sb.storyboard_number)).length));

    const events = [];
    const beats = [];
    const panels = [];
    const shots = [];

    for (const sb of members) {
      let w = windows.get(sb.storyboard_number);
      if (!w) {
        // Estimate from duration and neighbors
        const prevWin = windows.get(sb.storyboard_number - 1);
        if (prevWin) {
          w = { startMs: prevWin.endMs, endMs: prevWin.endMs + sb.duration * 1000 };
        } else {
          w = { startMs: 0, endMs: sb.duration * 1000 };
        }
      }

      eventNumber += 1;
      const eventKey = `evt-${String(eventNumber).padStart(3, '0')}`;
      const beatKey = `beat-${String(eventNumber).padStart(3, '0')}`;
      const panelKey = `sb-${sb.id}`;
      const text = String(sb.narration || '').trim();

      events.push({ eventKey, eventIndex: eventNumber - 1, startMs: w.startMs, endMs: w.endMs, text });
      beats.push({
        beatKey,
        eventKey,
        kind: 'cut',
        startMs: w.startMs,
        endMs: w.endMs,
        description: `叙事动作：${text.slice(0, 60)}`,
      });
      panels.push({ panelKey, beatKey, eventKey, description: text.slice(0, 100) });
      shots.push({
        shotKey: `shot-${String(eventNumber).padStart(3, '0')}`,
        eventKey,
        sourceKind: 'cut',
        sourceBeatKey: beatKey,
        description: `${(w.startMs / 1000).toFixed(1)}s–${(w.endMs / 1000).toFixed(1)}s`,
        startMs: w.startMs,
        endMs: w.endMs,
      });
    }

    if (events.length > 0) {
      sequences.push({ seqKey, title, startMs: seqStart, endMs: seqEnd, events, beats, panels, shots });
    }
  }

  return {
    kind: 'full',
    styleProfile: STYLE_PROFILE,
    durationMs,
    timingSource: 'tts-time-begin-end',
    sourcePath: path.relative(root, OUTPUT),
    sequences,
  };
}

async function importPlan(plan) {
  const url = `${API_BASE}/api/v1/remotion/projects/${REMOTION_PROJECT_ID}/narrative-hierarchy/import`;
  console.log(`POST ${url}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(plan),
  });
  const body = await resp.json();
  console.log('Import response:', JSON.stringify(body, null, 2));
  return body;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Building plan for episode ${EPISODE_ID}, project ${REMOTION_PROJECT_ID}`);
  const inputs = loadInputs();
  const plan = buildPlan(inputs);
  writeFileSync(OUTPUT, JSON.stringify(plan, null, 2));
  console.log(`Plan written to ${OUTPUT}`);
  console.log(`Sequences: ${plan.sequences.length}`);
  const totalEvents = plan.sequences.reduce((s, seq) => s + seq.events.length, 0);
  console.log(`Events: ${totalEvents}`);
  console.log(`Duration: ${(plan.durationMs / 1000).toFixed(1)}s`);

  if (!dryRun) {
    const result = await importPlan(plan);
    console.log('Import status:', result.code);
  } else {
    console.log('Dry run — skipping import');
  }
}

main().catch(console.error);
