#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, copyFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSheetSpecs} from './produce_project8_full_storyboard_sheets.mjs';
import {buildNonGraphicConstraint, classifyStoryboardImageFailure, selectImageRecoveryAction} from './narrative_storyboard_runtime.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const apiBase = (process.env.HUOBAO_API_BASE || 'http://127.0.0.1:5679').replace(/\/$/u, '');
const DEFAULT_PLAN = path.join(root, 'data/temp/project-8-full-storyboard-sound-plan.json');
const DEFAULT_OUTPUT_ROOT = path.join(root, 'data/static/remotion/project-8/narrative-storyboard/full-v2');
const LEGACY_FINAL_ROOT = path.join(root, 'data/static/remotion/project-8/narrative-storyboard/finals');
const DEFAULT_MAX_PANEL_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_500;

const style = [
  'Visual profile cold_ink_spatial: use 3D rendering for spatial depth, architectural volume, physically credible cold directional light, depth of field, and material response.',
  'Treat characters as refined 2D historical animation: rough black ink contours, cel-shaded shadow masses, flat color blocks, dry-brush grain, paper texture, and slight print misregistration. Never use photoreal people or glossy raw game CG.',
  'Palette: cold blue-gray, ink green, and deep indigo environments with restrained dark red and tiny fire-gold accents only where the narrative motivates them.',
].join('\n');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sourcePath(localPath) {
  return path.join(root, 'data', String(localPath).replace(/^\/+/, ''));
}

function staticUrl(localPath) {
  return `${apiBase}/${String(localPath).replace(/^\/+/, '')}`;
}

function panelNumber(panelId) {
  return Number(String(panelId).replace('panel-', ''));
}

function panelRiskTags(beat) {
  const text = `${beat.sourceText || ''} ${beat.description || ''}`;
  const tags = [];
  if (/射杀|射死|中箭|放箭|箭矢|打伤|动了手|斩杀|杀掉|杀人|全军覆没|自杀|死亡/u.test(text)) tags.push('covered_aftermath');
  if (/射杀|射死|中箭|放箭|箭矢|打伤|动了手|斩杀|杀掉|杀人/u.test(text)) tags.push('weapon_contact');
  if (/打伤|受伤|受创/u.test(text)) tags.push('covered_injury');
  return [...new Set(tags)];
}

function relevantIdentities(text, sequenceId) {
  const lines = [];
  if (/卫青/u.test(text) || sequenceId.includes('wei-qing') || sequenceId.includes('servitude')) {
    lines.push('Wei Qing: broad-shouldered and calm adult Han general in blue-black robes or dark lamellar armor; younger versions retain the same facial structure and use a rough gray tunic with tied dark hair.');
  }
  if (/霍去病/u.test(text) || sequenceId.includes('huo-qubing') || sequenceId.includes('killing')) {
    lines.push('Huo Qubing: lean young Han cavalry commander in dark lamellar armor, muted red cloak, recurved bow, decisive forward posture.');
  }
  if (/李敢/u.test(text) || sequenceId.includes('li-gan') || sequenceId.includes('killing')) {
    lines.push('Li Gan: sturdy adult Han officer, worn dark armor, square jaw; Li Guang is older and weathered with a veteran archer silhouette.');
  }
  if (/汉武帝|皇帝/u.test(text) || sequenceId.includes('hunting') || sequenceId.includes('court')) {
    lines.push('Emperor Wu: composed middle-aged Han emperor in black imperial robes with restrained dark-red trim and a ceremonial crown.');
  }
  return lines.length ? lines : ['Western Han figures have period-credible Han robes, lamellar armor, saddles, weapons, hair, architecture, and social behavior.'];
}

function visibleActionRequirement(beat) {
  const text = `${beat.sourceText || ''} ${beat.description || ''}`;
  if (/射杀|射死|放箭|中箭|箭矢|弓箭/u.test(text)) {
    return 'For archery, keep the bow, arrow trajectory, target direction, and result legible in one coherent frame; conceal the exact contact when needed.';
  }
  if (/大战|战场|交战|迎战|包围|全军覆没|冲进|杀出来|斩杀|俘获|奔袭|骑兵/u.test(text)) {
    return 'For battle, show a readable formation scale, cavalry or infantry movement, attack direction, and the changed tactical result. Do not replace the action with a static commander portrait.';
  }
  if (/打伤|动了手|拔刀|冲突/u.test(text)) {
    return 'For confrontation, show the approach, contact geometry, body balance, and the changed result without graphic injury.';
  }
  return '';
}

function safeStoryboardDescription(value) {
  return String(value || '')
    .replace(/射杀|射死|中箭|放箭|箭矢|打伤|动了手|斩杀|杀掉|杀人|死亡|大战|交战|包围|全军覆没|冲进|拔刀|冲突/gu, 'historical turning point')
    .replace(/shoot|arrow|weapon|kill|death|battle|attack|injury|fight|strike|blood/giu, 'historical turning point');
}

export function buildFinalPrompt({panel, beat, sequence, referenceMode = 'image', safetyRecovery = false}) {
  const action = safetyRecovery
    ? 'Show a nonviolent historical turning point through distance, uninjured witnesses, changing formations, architecture, weather, documents, and symbolic environmental evidence. Preserve the story consequence without depicting confrontation, weapons, injury, death, restraint, or threat.'
    : beat.sourceText || beat.description;
  const cameraAndBeat = safetyRecovery
    ? `${safeStoryboardDescription(panel.description)}; a calm, general-audience historical aftermath composition with the same camera geometry and screen direction.`
    : `${panel.description}; ${beat.description}`;
  const storyboardInstruction = referenceMode === 'image'
    ? `Use the supplied storyboard panel crop only for ${panel.id}'s staging, camera angle, framing, subject positions, action direction, and major geometry. Ignore all sketch lines, borders, labels, and paper artifacts.`
    : `Reconstruct ${panel.id}'s approved storyboard staging from the written camera, beat, sequence, character, and action fields below. Preserve the declared camera angle, framing, subject positions, action direction, and major geometry exactly; do not invent a different interpretation.`;
  const continuityInstruction = referenceMode === 'image'
    ? 'Any additional supplied final panels control only recurring character identity, wardrobe, architecture, palette, and screen direction. Do not copy their pose, gaze, action, emotion, injury, or location into this image.'
    : 'Use only the written continuity rules below for recurring identity, wardrobe, architecture, palette, and screen direction. Do not copy a prior beat\'s pose, gaze, action, emotion, injury, or location.';
  return [
    storyboardInstruction,
    continuityInstruction,
    `Narrative action: ${action}`,
    `Storyboard camera and beat: ${cameraAndBeat}`,
    `Sequence context: ${safetyRecovery ? 'Western Han historical narrative with a nonviolent general-audience presentation' : sequence.title}.`,
    `Relevant character continuity only:\n${relevantIdentities(`${action} ${beat.description}`, sequence.id).join('\n')}`,
    safetyRecovery
      ? 'Safety recovery rules: no weapons, combat, injury, dead or unconscious people, physical restraint, threatening gestures, blood, or violent contact. Keep every person visibly safe and uninjured.'
      : visibleActionRequirement(beat),
    safetyRecovery ? '' : buildNonGraphicConstraint(panelRiskTags(beat)),
    style,
    'Historical world: Western Han dynasty. The action must be physically credible and immediately legible without narration.',
    'Composition: one coherent cinematic 16:9 frame, one decisive focus, strong foreground-midground-background depth, readable silhouettes, no split screen, collage, inset, duplicate person, decorative frame, or storyboard layout.',
    'Strict clean image: absolutely no visible text, Chinese characters, Latin letters, numbers, captions, handwriting, signs, logos, signatures, UI, panel headers, borders, or watermark.',
  ].filter(Boolean).join('\n');
}

/**
 * Contact sheets are planning references. Their generated gutters are not
 * pixel-stable, so this crop keeps one complete panel cell (including any
 * harmless header) and asks the final model to ignore the sketch artifacts.
 */
export function normalizedPanelCrop(index, count) {
  const rows = Math.ceil(count / 3);
  const row = Math.floor(index / 3);
  const inLastRow = row === rows - 1;
  const cellsInRow = inLastRow && count % 3 ? count % 3 : 3;
  const columnOffset = inLastRow && cellsInRow < 3 ? (3 - cellsInRow) / 2 : 0;
  const column = index % 3 + columnOffset;
  const x = 0.012 + column * 0.329;
  if (rows === 1) return {x, y: 0.18, width: 0.316, height: 0.62};
  if (rows === 2) return {x, y: 0.135 + row * 0.425, width: 0.316, height: 0.36};
  return {x, y: 0.105 + row * 0.308, width: 0.316, height: 0.278};
}

function cropPanel({input, output, crop}) {
  const dimension = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', input,
  ], {encoding: 'utf8'})).streams?.[0];
  if (!dimension?.width || !dimension?.height) throw new Error(`Unable to read storyboard sheet dimensions: ${input}`);
  const x = Math.max(0, Math.round(dimension.width * crop.x));
  const y = Math.max(0, Math.round(dimension.height * crop.y));
  const width = Math.min(dimension.width - x, Math.max(2, Math.round(dimension.width * crop.width / 2) * 2));
  const height = Math.min(dimension.height - y, Math.max(2, Math.round(dimension.height * crop.height / 2) * 2));
  mkdirSync(path.dirname(output), {recursive: true});
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', `crop=${width}:${height}:${x}:${y}`, '-frames:v', '1', output]);
  return {x, y, width, height};
}

async function request(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = {raw}; }
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`);
  return Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
}

async function submitImage({configId, frameType, prompt, referenceImages}) {
  const created = await request(`${apiBase}/api/v1/images`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({config_id: configId, aspect_ratio: '16:9', frame_type: frameType, prompt, reference_images: referenceImages}),
  });
  if (!created?.id) throw new Error(`${frameType} did not return an image generation id`);
  return {generationId: created.id, taskId: created.task_id || created.taskId || null};
}

async function waitForImage(generationId, label) {
  const deadline = Date.now() + 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const row = await request(`${apiBase}/api/v1/images/${generationId}`);
    if (row?.status === 'completed' && row.localPath) return row;
    if (row?.status === 'failed') {
      const error = new Error(`${label} failed: ${row.errorMsg || row.lastErrorDetail || 'unknown provider error'}`);
      error.providerTerminal = true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const error = new Error(`${label} timed out while the provider is still pending`);
  error.providerPending = true;
  throw error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attemptsFor(final) {
  const attempts = Number(final?.attempts);
  return Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
}

function failureDetails(error) {
  const classification = classifyStoryboardImageFailure(error);
  return {
    error: error instanceof Error ? error.message : String(error),
    errorClass: classification.code,
    retryable: classification.retryable,
    safeToResubmit: classification.safeToResubmit,
  };
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const failures = [];
  const runners = Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await worker(item); } catch (error) { failures.push({item, error}); }
    }
  });
  await Promise.all(runners);
  if (failures.length) throw new AggregateError(failures.map(({error}) => error), failures.map(({item, error}) => `${item.panel.id}: ${error.message}`).join('\n'));
}

function flattenPanels(plan) {
  const beatById = new Map(plan.sequences.flatMap((sequence) => sequence.beats.map((beat) => [beat.id, beat])));
  return buildSheetSpecs(plan).flatMap((sheet) => sheet.panels.map(({panel}) => ({
    panel,
    beat: beatById.get(panel.beatId),
    sequence: plan.sequences.find((sequence) => sequence.id === sheet.sequenceId),
    sheet,
  })));
}

function previousFinalReference(entry, orderedEntries, state, finalsDir) {
  const index = orderedEntries.findIndex(({panel}) => panel.id === entry.panel.id);
  if (index <= 0) return [];
  const previous = orderedEntries[index - 1];
  if (previous.sequence.id !== entry.sequence.id) return [];
  const previousPath = state.finals?.[previous.panel.id]?.localPath;
  const fallback = path.join(finalsDir, `${previous.panel.id}.png`);
  const candidate = previousPath ? sourcePath(previousPath) : fallback;
  return existsSync(candidate) ? [previousPath || path.relative(path.join(root, 'data'), candidate)] : [];
}

export async function produceProject8FullStoryboardFinals({
  planPath = DEFAULT_PLAN,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  configId = 80,
  concurrency = 3,
  runTag = 'v2',
  force = false,
  referenceMode = 'image',
  onlyPanels = new Set(),
  safetyRecoveryPanels = new Set(),
  maxPanelAttempts = DEFAULT_MAX_PANEL_ATTEMPTS,
}) {
  if (!['image', 'prompt-only'].includes(referenceMode)) {
    throw new Error(`Unsupported reference mode: ${referenceMode}`);
  }
  if (!Number.isInteger(maxPanelAttempts) || maxPanelAttempts < 1) {
    throw new Error('maxPanelAttempts must be a positive integer');
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const entries = flattenPanels(plan);
  const known = new Set(entries.map(({panel}) => panel.id));
  const unknown = [...onlyPanels].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown --only-panels values: ${unknown.join(', ')}`);

  const panelDir = path.join(outputRoot, 'panels');
  const finalsDir = path.join(outputRoot, 'finals');
  const statePath = path.join(outputRoot, 'production-state.json');
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : {schemaVersion: 1, projectId: 8, sheets: {}, panels: {}, finals: {}};
  state.panels ??= {};
  state.finals ??= {};
  const activePanels = new Set();
  const runId = `storyboard-${Date.now().toString(36)}-${process.pid}`;
  const startedAt = new Date().toISOString();
  let producerStatus = 'running';
  let candidates = [];
  const save = () => {
    state.producer = {
      runId,
      status: producerStatus,
      startedAt,
      heartbeatAt: new Date().toISOString(),
      activePanels: [...activePanels].sort(),
      completedPanels: candidates.filter(({panel}) => state.finals[panel.id]?.status === 'completed').length,
      totalPanels: candidates.length,
      maxPanelAttempts,
    };
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tempPath, statePath);
    scheduleDbSync();
  };

  // --- DB 同步：panel 状态差异上报到 narrative-panels（磁盘仍是真相，失败不阻塞生产） ---
  const lastSyncedSig = new Map();
  let syncTimer = null;
  const panelSig = (st) => `${st.status}|${st.generationId ?? ''}|${st.taskId ?? ''}|${st.localPath ?? ''}|${st.error ?? ''}`;
  function scheduleDbSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      const dirty = [];
      for (const [panelId, st] of Object.entries(state.finals)) {
        const sig = panelSig(st);
        if (lastSyncedSig.get(panelId) === sig) continue;
        dirty.push([panelId, st, sig]);
      }
      for (const [panelId, st, sig] of dirty) {
        try {
          await request(`${apiBase}/api/v1/remotion/projects/8/narrative-panels/${panelId}`, {
            method: 'PUT',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
              genStatus: st.status,
              generationId: st.generationId ?? null,
              taskId: st.taskId ?? null,
              prompt: st.prompt ?? null,
              finalPath: st.localPath ?? null,
              referenceMode: st.referenceMode ?? null,
              error: st.error ?? null,
            }),
          });
          lastSyncedSig.set(panelId, sig);
        } catch { /* 磁盘为真相，DB 同步失败下个心跳重试 */ }
      }
    }, 500);
  }

  for (const entry of entries) {
    const sheetPath = path.join(outputRoot, 'sheets', `${entry.sheet.id}.png`);
    const panelPath = path.join(panelDir, `${entry.panel.id}.png`);
    if (!existsSync(sheetPath)) throw new Error(`Missing approved storyboard sheet: ${sheetPath}`);
    if (!existsSync(panelPath) || force) {
      const crop = cropPanel({input: sheetPath, output: panelPath, crop: normalizedPanelCrop(entry.sheet.panels.findIndex(({panel}) => panel.id === entry.panel.id), entry.sheet.panels.length)});
      state.panels[entry.panel.id] = {sheetId: entry.sheet.id, crop, localPath: path.relative(path.join(root, 'data'), panelPath)};
    }
  }
  save();

  candidates = entries.filter((entry) => panelNumber(entry.panel.id) > plan.pilotPanelCount && (!onlyPanels.size || onlyPanels.has(entry.panel.id)));
  mkdirSync(finalsDir, {recursive: true});
  try {
    await runPool(candidates, concurrency, async (entry) => {
    const {panel, beat, sequence} = entry;
    activePanels.add(panel.id);
    save();
    try {
      const destination = path.join(finalsDir, `${panel.id}.png`);
      let existing = state.finals[panel.id];
      let recovery = selectImageRecoveryAction({
        force,
        localExists: existsSync(destination),
        stateStatus: existing?.status,
        errorClass: existing?.errorClass,
        attempts: attemptsFor(existing),
        maxAttempts: maxPanelAttempts,
      });
      if (recovery === 'reuse') {
        process.stdout.write(`${panel.id}: reused\n`);
        return;
      }
      if (!force && existing?.generationId && existing.status === 'submitted') {
        let row;
        try {
          row = await request(`${apiBase}/api/v1/images/${existing.generationId}`);
        } catch (error) {
          state.finals[panel.id] = {...existing, lastCheckError: failureDetails(error), lastCheckAt: new Date().toISOString()};
          save();
          throw error;
        }
        const providerError = row?.status === 'failed'
          ? new Error(`${panel.id} failed: ${row.errorMsg || row.lastErrorDetail || 'unknown provider error'}`)
          : null;
        const providerFailure = providerError ? failureDetails(providerError) : null;
        const action = selectImageRecoveryAction({
          force,
          localExists: existsSync(destination),
          stateStatus: existing.status,
          providerStatus: row?.status,
          errorClass: providerFailure?.errorClass ?? existing.errorClass,
          attempts: attemptsFor(existing),
          maxAttempts: maxPanelAttempts,
        });
        if (action === 'adopt' && row.localPath) {
          copyFileSync(sourcePath(row.localPath), destination);
          state.finals[panel.id] = {...existing, status: 'completed', sourceLocalPath: row.localPath, localPath: path.relative(path.join(root, 'data'), destination)};
          save();
          process.stdout.write(`${panel.id}: adopted\n`);
          return;
        }
        if (action === 'adopt') {
          const error = new Error(`${panel.id} completed without a local provider file`);
          state.finals[panel.id] = {...existing, status: 'failed', ...failureDetails(error)};
          save();
          throw error;
        }
        if (action === 'wait') {
          try {
            const completed = await waitForImage(existing.generationId, panel.id);
            copyFileSync(sourcePath(completed.localPath), destination);
            state.finals[panel.id] = {...existing, status: 'completed', sourceLocalPath: completed.localPath, localPath: path.relative(path.join(root, 'data'), destination)};
            save();
            process.stdout.write(`${panel.id}: resumed\n`);
            return;
          } catch (error) {
            const details = failureDetails(error);
            if (details.errorClass === 'provider_pending') {
              state.finals[panel.id] = {...existing, status: 'submitted', lastCheckError: details, lastCheckAt: new Date().toISOString()};
              save();
              throw error;
            }
            state.finals[panel.id] = {...existing, status: 'failed', ...details, attempts: attemptsFor(existing)};
            save();
            recovery = selectImageRecoveryAction({force, localExists: false, stateStatus: 'failed', errorClass: details.errorClass, attempts: attemptsFor(existing), maxAttempts: maxPanelAttempts});
            if (recovery !== 'resubmit') throw error;
            existing = state.finals[panel.id];
          }
        } else if (action === 'blocked') {
          state.finals[panel.id] = {...existing, status: 'failed', ...(providerFailure || {error: 'Provider failed without a safe retry classification', errorClass: 'unknown', retryable: false, safeToResubmit: false})};
          save();
          throw providerError || new Error(`${panel.id} cannot safely be resubmitted`);
        } else if (action === 'resubmit') {
          existing = {...existing, status: 'failed', ...(providerFailure || {})};
          state.finals[panel.id] = existing;
          save();
        }
      }
      if (recovery === 'blocked') throw new Error(`${panel.id} cannot safely be resubmitted`);
      const storyboardCrop = state.panels[panel.id]?.localPath;
      if (!storyboardCrop) throw new Error(`Missing storyboard crop for ${panel.id}`);
      const references = referenceMode === 'image'
        ? [storyboardCrop, ...previousFinalReference(entry, entries, state, finalsDir)].slice(0, 2)
        : [];
      const safetyRecovery = safetyRecoveryPanels.has(panel.id);
      const prompt = buildFinalPrompt({panel, beat, sequence, referenceMode, safetyRecovery});
      let attempts = attemptsFor(existing);
      while (attempts < maxPanelAttempts) {
        let submitted;
        try {
          submitted = await submitImage({configId, frameType: `project8-full-final-${panel.id}-${runTag}`, prompt, referenceImages: references});
        } catch (error) {
          state.finals[panel.id] = {...existing, status: 'failed', ...failureDetails(error), prompt, referenceImages: references, referenceMode, safetyRecovery, attempts};
          save();
          throw error;
        }
        attempts += 1;
        state.finals[panel.id] = {...existing, ...submitted, status: 'submitted', prompt, referenceImages: references, referenceMode, safetyRecovery, attempts, lastCheckError: null};
        save();
        try {
          const row = await waitForImage(submitted.generationId, panel.id);
          copyFileSync(sourcePath(row.localPath), destination);
          state.finals[panel.id] = {...state.finals[panel.id], status: 'completed', sourceLocalPath: row.localPath, localPath: path.relative(path.join(root, 'data'), destination), error: null, errorClass: null};
          save();
          process.stdout.write(`${panel.id}: completed\n`);
          return;
        } catch (error) {
          const details = failureDetails(error);
          if (details.errorClass === 'provider_pending') {
            state.finals[panel.id] = {...state.finals[panel.id], status: 'submitted', lastCheckError: details, lastCheckAt: new Date().toISOString()};
            save();
            throw error;
          }
          state.finals[panel.id] = {...state.finals[panel.id], status: 'failed', ...details, attempts};
          save();
          if (!details.retryable || !details.safeToResubmit || attempts >= maxPanelAttempts) throw error;
          const delay = DEFAULT_RETRY_BASE_MS * 2 ** (attempts - 1);
          process.stdout.write(`${panel.id}: provider overload, retrying ${attempts + 1}/${maxPanelAttempts} after ${delay}ms\n`);
          await sleep(delay);
          existing = state.finals[panel.id];
        }
      }
      throw new Error(`${panel.id} exhausted ${maxPanelAttempts} safe generation attempts`);
    } catch (error) {
      const details = failureDetails(error);
      if (!(state.finals[panel.id]?.status === 'submitted' && details.errorClass === 'provider_pending')) {
        state.finals[panel.id] = {...state.finals[panel.id], status: 'failed', ...details};
      }
      save();
      throw error;
    } finally {
      activePanels.delete(panel.id);
      save();
    }
    });
  } catch (error) {
    producerStatus = 'blocked';
    save();
    throw error;
  }
  producerStatus = 'complete';
  save();

  const manifest = {
    schemaVersion: 1,
    projectId: plan.projectId,
    styleProfile: plan.styleProfile,
    pilotPanelCount: plan.pilotPanelCount,
    totalPanels: entries.length,
    generatedPanels: entries.filter(({panel}) => panelNumber(panel.id) > plan.pilotPanelCount).length,
    completedPanels: entries.filter(({panel}) => panelNumber(panel.id) <= plan.pilotPanelCount || state.finals[panel.id]?.status === 'completed').length,
    panels: entries.map(({panel, beat, sequence}) => ({
      id: panel.id,
      beatId: beat.id,
      eventId: beat.eventId,
      sequenceId: sequence.id,
      storyboardCrop: state.panels[panel.id]?.localPath || null,
      finalImage: panelNumber(panel.id) <= plan.pilotPanelCount
        ? path.relative(path.join(root, 'data'), path.join(LEGACY_FINAL_ROOT, `${panel.id}.png`))
        : state.finals[panel.id]?.localPath || null,
    })),
  };
  writeFileSync(path.join(outputRoot, 'final-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main() {
  const onlyPanels = new Set(argument('--only-panels', '').split(',').map((value) => value.trim()).filter(Boolean));
  const safetyRecoveryPanels = new Set(argument('--safety-recovery-panels', '').split(',').map((value) => value.trim()).filter(Boolean));
  const manifest = await produceProject8FullStoryboardFinals({
    planPath: path.resolve(root, argument('--plan', path.relative(root, DEFAULT_PLAN))),
    outputRoot: path.resolve(root, argument('--output-root', path.relative(root, DEFAULT_OUTPUT_ROOT))),
    configId: Number(argument('--config-id', '80')),
    concurrency: Number(argument('--concurrency', '3')),
    runTag: argument('--run-tag', 'v2'),
    force: process.argv.includes('--force'),
    referenceMode: argument('--reference-mode', 'image'),
    onlyPanels,
    safetyRecoveryPanels,
    maxPanelAttempts: Number(argument('--max-panel-attempts', String(DEFAULT_MAX_PANEL_ATTEMPTS))),
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
