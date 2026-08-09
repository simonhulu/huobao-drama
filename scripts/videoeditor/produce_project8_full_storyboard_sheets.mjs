#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const apiBase = (process.env.HUOBAO_API_BASE || 'http://127.0.0.1:5679').replace(/\/$/u, '');
const DEFAULT_PLAN = path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json');
const DEFAULT_OUTPUT_ROOT = path.join(root, 'data/static/remotion/project-8/narrative-storyboard/full-v2');

const panelBeatOverrides = {
  'panel-204': '战斗结束后的非图形化胜利证据：李敢率骑兵夺下左贤王战鼓和军旗，前景只有散落头盔、折断旗杆和正在撤退的远方敌军，不出现尸体、伤口、肢体或处决动作。',
  'panel-213': '军帐外的属官在门帘前突然停步，帐内只见李广背对门口坐在案前，佩刀仍在鞘中放在桌边；建立决定前最后的寂静，不出现任何伤害动作。',
  'panel-214': '决定后的非图形化细节：空军帐、散开的军报、熄灭一半的灯火和落在案边的入鞘佩刀，门外属官低头站立；不出现身体、遗体、伤口或行为过程。',
  'panel-230': '甘泉宫猎队穿过冬季猎场，李敢骑马位于前方队列，霍去病在后方高坡观察并确认目标，弓仍低垂，建立清楚的前后距离和行进方向。',
  'panel-231': '霍去病在马背上搭箭拉弓并释放，箭矢沿固定屏幕方向掠过前景；李敢仍在远处运动，接触尚未发生。',
  'panel-232': '事件之后的无证词现场：验看席空着，随从保持沉默，李敢的空马和落地箭袋停在猎场边缘，表现无人留下口供而不是普通书写画面。',
  'panel-233': '司马迁所能确认的结果证据：空鞍战马、断裂缰绳和从现场收起的一支箭并置，远处霍去病已经放下弓；不得重复上一格放箭姿态。',
  'panel-234': '长焦后果镜头：李敢从马背失去平衡，披风与马身完全遮住接触位置；霍去病只作为远处低弓剪影，画面重点是不可逆结果而非再次放箭。',
  'panel-235': '汉武帝在猎场临时帷帐前抬手宣布鹿撞说法，官员指向鹿蹄印，群臣低头，空鞍马留在背景形成谎言与现场的矛盾。',
  'panel-236': '卫青在府门内按住包扎好的手臂，抬手遣散侍从并亲自关门，把受伤事件压下；不得出现抓人或新的冲突。',
  'panel-237': '霍去病从传令者口中得知舅舅受伤，视线转向墙边弓具，手尚未触弓；表现决定形成的瞬间，不重复射箭结果。',
};

const panelLabelOverrides = {
  'panel-204': 'High rear aftermath WS / captured drum and standard',
  'panel-213': 'Deep profile MS / decision before aftermath',
  'panel-214': 'Detail CU / empty tent aftermath',
};

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function sequencePanelGroups(sequence, capacity) {
  if (sequence.id !== 'seq-09-li-gan-grievance') return chunks(sequence.panels, capacity);
  const sizes = [6, 6, 6, 6, 4, 3];
  const groups = [];
  let cursor = 0;
  for (const size of sizes) {
    if (cursor >= sequence.panels.length) break;
    groups.push(sequence.panels.slice(cursor, cursor + size));
    cursor += size;
  }
  if (cursor !== sequence.panels.length) throw new Error(`Unexpected seq-09 panel count: ${sequence.panels.length}`);
  return groups;
}

export function buildSheetSpecs(plan, capacity = 9) {
  const specs = [];
  for (const sequence of plan.sequences) {
    const beatById = new Map(sequence.beats.map((beat) => [beat.id, beat]));
    const groups = sequencePanelGroups(sequence, capacity);
    groups.forEach((panels, index) => {
      specs.push({
        id: `${sequence.id}-sheet-${String(index + 1).padStart(2, '0')}`,
        sequenceId: sequence.id,
        sequenceTitle: sequence.title,
        continuation: index + 1,
        continuationCount: groups.length,
        panels: panels.map((panel) => ({panel, beat: beatById.get(panel.beatId)})),
      });
    });
  }
  return specs;
}

function identityGuide(sequenceId) {
  const common = [
    'Western Han identity continuity: all architecture, robes, lamellar armor, weapons, saddles, chariots, banners, furniture, and ritual behavior must be period credible.',
    'Wei Qing: broad-shouldered, calm adult Han general, restrained expression, blue-black robes or dark lamellar armor; younger versions keep the same facial structure.',
    'Huo Qubing: lean young Han cavalry commander, dark lamellar armor, muted red cloak, recurved bow, decisive forward posture.',
    'Li Gan: sturdy adult Han officer, worn dark armor, square jaw; Li Guang is older and weathered with a veteran archer silhouette.',
    'Emperor Wu: composed middle-aged Han emperor in black imperial robes with restrained dark-red trim and ceremonial crown.',
  ];
  if (sequenceId.includes('childhood') || sequenceId.includes('servitude')) {
    common.push('Young Wei Qing: thin boy or young man with tied dark hair, rough gray tunic, worn straw shoes, visibly lower social status but no caricature.');
  }
  return common.join('\n');
}

export function sheetPrompt(spec) {
  const count = spec.panels.length;
  const rows = Math.ceil(count / 3);
  const incomplete = count % 3;
  const panelLines = spec.panels.map(({panel, beat}) => {
    const visibleId = panel.id.replace('panel-', 'P');
    const override = panelBeatOverrides[panel.id];
    const isSelfHarm = /拔刀自杀|自杀/u.test(`${panel.description} ${beat.description}`);
    const panelLabel = panelLabelOverrides[panel.id] || (isSelfHarm ? 'Deep profile MS / aftermath decision' : panel.description);
    const description = override || (isSelfHarm
      ? '李广在军帐内作出不可逆决定后的非图形化后果：只显示落在案边的入鞘佩刀、散开的军报和帐外停步的属官；不展示行为过程、伤口、血迹、身体或遗体。'
      : beat.description);
    return `${visibleId} / ${panelLabel} / ${description}`;
  }).join('\n');
  const lastRow = incomplete
    ? `Center the final ${incomplete} panels in the incomplete last row without changing their size.`
    : 'Fill the last row normally.';
  const safety = 'Use strictly non-graphic historical staging for every violent consequence: no blood, wounds, visible impact, gore, exposed remains, corpse detail, self-harm contact, or weapon entering a body. Preserve cause, target, direction, and consequence through distance, covered figures, dropped weapons, damaged armor, witness reactions, sealed doors, or aftermath geometry.';
  return [
    `Create one balanced 16:9 landscape clean monochrome 2D storyboard line-sketch sheet with exactly ${count} panels for a continuous historical narration sequence.`,
    '',
    '[HEADER]',
    'Minimal header with crisp typography and one thin rule; show only:',
    `"${spec.sequenceTitle}"`,
    `"Part ${spec.continuation} of ${spec.continuationCount}"`,
    '',
    '[BOARD]',
    `Use a strict 3-column by ${rows}-row contact-sheet structure with near-equal landscape 16:9 panels, clear gutters, and natural reading order. ${lastRow}`,
    'Preserve the exact panel count, ids, order, camera angle, blocking, action direction, and changed state over decorative packing.',
    'Panel headers use only `P### / compact camera angle + shot size / short beat`.',
    '',
    '[STYLE]',
    'Clean monochrome 2D storyboard line sketch on white paper: sparse single-pass graphite-gray contours, simplified featureless figures, minimal construction marks, and only essential set geometry.',
    'No fills, wash, hatching, shading, shadows, ambient occlusion, color, texture, 3D or clay volume, finished illustration, dense repeated lines, facial detail, anatomy detail, clothing detail, or surface detail.',
    '',
    '[CONTINUITY]',
    identityGuide(spec.sequenceId),
    'Within this sheet keep location geography, left-right axis, participants, costume, weapons, horses, banners, damage, body position, and consequences continuous from panel to panel.',
    'Battle panels must show readable formation scale and attack direction. Confrontations must show approach, contact geometry, and aftermath. Do not replace action with portraits or people merely holding objects.',
    ...(['seq-09-li-gan-grievance', 'seq-11-power-conclusion'].includes(spec.sequenceId) ? [safety] : []),
    '',
    '[RULES]',
    `Exactly ${count} panels. Only the two header lines and panel headers are visible. No narration text, captions, dialogue, arrows, icons, insets, extra panels, duplicate panels, ghost poses, speech balloons, effect words, logos, signatures, or watermarks.`,
    '',
    '[BEATS]',
    'Draw one storyboard panel per ordered visual beat:',
    panelLines,
  ].join('\n');
}

async function request(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = {raw}; }
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`);
  return Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
}

async function submitSheet({spec, configId, runTag}) {
  const prompt = sheetPrompt(spec);
  const created = await request(`${apiBase}/api/v1/images`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      config_id: configId,
      aspect_ratio: '16:9',
      frame_type: `project8-full-storyboard-${spec.id}-${runTag}`,
      prompt,
      reference_images: [],
    }),
  });
  if (!created?.id) throw new Error(`${spec.id} did not return a generation id`);
  return {generationId: created.id, taskId: created.task_id || created.taskId || null, prompt, requestHash: hash(prompt)};
}

async function waitForImage(generationId, label) {
  const deadline = Date.now() + 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const row = await request(`${apiBase}/api/v1/images/${generationId}`);
    if (row?.status === 'completed' && row.localPath) return row;
    if (row?.status === 'failed') throw new Error(`${label} failed: ${row.errorMsg || row.lastErrorDetail || 'unknown provider error'}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`${label} timed out`);
}

function sourcePath(localPath) {
  return path.join(root, 'data', String(localPath).replace(/^\/+/, ''));
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const failures = [];
  const runners = Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        failures.push({item: items[index], error});
      }
    }
  });
  await Promise.all(runners);
  if (failures.length) {
    throw new AggregateError(failures.map(({error}) => error), failures.map(({item}) => item.id).join(', '));
  }
}

export async function produceSheets({planPath, outputRoot, configId = 80, concurrency = 3, runTag = 'v2', force = false, onlySheetIds = new Set()}) {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const allSpecs = buildSheetSpecs(plan);
  const specs = onlySheetIds.size ? allSpecs.filter((spec) => onlySheetIds.has(spec.id)) : allSpecs;
  const sheetDir = path.join(outputRoot, 'sheets');
  const statePath = path.join(outputRoot, 'production-state.json');
  mkdirSync(sheetDir, {recursive: true});
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {schemaVersion: 1, projectId: 8, sheets: {}};
  const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  await runPool(specs, concurrency, async (spec) => {
    const destination = path.join(sheetDir, `${spec.id}.png`);
    const requestHash = hash(sheetPrompt(spec));
    const existing = state.sheets[spec.id];
    if (!force && existsSync(destination)) {
      state.sheets[spec.id] = {
        ...existing,
        requestHash,
        status: 'completed',
        localPath: path.relative(path.join(root, 'data'), destination),
      };
      save();
      process.stdout.write(`${spec.id}: reused-local\n`);
      return;
    }
    if (!force && existing?.status === 'completed' && existing.requestHash === requestHash && existsSync(destination)) {
      process.stdout.write(`${spec.id}: reused\n`);
      return;
    }
    if (!force && existing?.generationId && existing.requestHash === requestHash) {
      const row = await request(`${apiBase}/api/v1/images/${existing.generationId}`);
      if (row?.status === 'completed' && row.localPath) {
        copyFileSync(sourcePath(row.localPath), destination);
        state.sheets[spec.id] = {
          ...existing,
          status: 'completed',
          sourceLocalPath: row.localPath,
          localPath: path.relative(path.join(root, 'data'), destination),
        };
        save();
        process.stdout.write(`${spec.id}: adopted\n`);
        return;
      }
      if (['pending', 'submitted', 'processing', 'running'].includes(row?.status)) {
        const completed = await waitForImage(existing.generationId, spec.id);
        copyFileSync(sourcePath(completed.localPath), destination);
        state.sheets[spec.id] = {
          ...existing,
          status: 'completed',
          sourceLocalPath: completed.localPath,
          localPath: path.relative(path.join(root, 'data'), destination),
        };
        save();
        process.stdout.write(`${spec.id}: resumed\n`);
        return;
      }
    }
    const submitted = await submitSheet({spec, configId, runTag});
    state.sheets[spec.id] = {...submitted, status: 'submitted', panelIds: spec.panels.map(({panel}) => panel.id)};
    save();
    const row = await waitForImage(submitted.generationId, spec.id);
    copyFileSync(sourcePath(row.localPath), destination);
    state.sheets[spec.id] = {
      ...state.sheets[spec.id],
      status: 'completed',
      sourceLocalPath: row.localPath,
      localPath: path.relative(path.join(root, 'data'), destination),
    };
    save();
    process.stdout.write(`${spec.id}: completed\n`);
  });

  const manifest = {
    schemaVersion: 1,
    projectId: plan.projectId,
    styleProfile: plan.styleProfile,
    panelCount: allSpecs.reduce((sum, spec) => sum + spec.panels.length, 0),
    sheetCount: allSpecs.length,
    sheets: allSpecs.map((spec) => ({
      id: spec.id,
      sequenceId: spec.sequenceId,
      sequenceTitle: spec.sequenceTitle,
      panelIds: spec.panels.map(({panel}) => panel.id),
      imageUrl: `/static/remotion/project-8/narrative-storyboard/full-v2/sheets/${spec.id}.png`,
    })),
  };
  writeFileSync(path.join(outputRoot, 'sheet-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // --- DB 同步：sheet manifest 写进 storyboard_sheets（失败不阻塞，可用 backfill 脚本补） ---
  try {
    const response = await fetch(`${apiBase}/api/v1/remotion/projects/8/narrative-hierarchy/import-document`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({kind: 'full', sheetManifest: manifest}),
    });
    if (!response.ok) process.stderr.write(`narrative-hierarchy sheet sync -> ${response.status}\n`);
  } catch (error) {
    process.stderr.write(`narrative-hierarchy sheet sync skipped: ${error?.message || error}\n`);
  }
  return manifest;
}

async function main() {
  const planPath = path.resolve(root, argument('--plan', path.relative(root, DEFAULT_PLAN)));
  const outputRoot = path.resolve(root, argument('--output-root', path.relative(root, DEFAULT_OUTPUT_ROOT)));
  const onlySheetIds = new Set(argument('--only-sheets', '').split(',').map((value) => value.trim()).filter(Boolean));
  const manifest = await produceSheets({
    planPath,
    outputRoot,
    configId: Number(argument('--config-id', '80')),
    concurrency: Number(argument('--concurrency', '3')),
    runTag: argument('--run-tag', 'v2'),
    force: process.argv.includes('--force'),
    onlySheetIds,
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
