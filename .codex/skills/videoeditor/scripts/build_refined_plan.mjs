#!/usr/bin/env node
/** Compile inspected, manually directed shots against frozen narration/title timing. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {schedule} from '../../../../scripts/videoeditor/editorial_sfx.mjs';
import {resolveUploadEncoding} from '../../../../scripts/videoeditor/upload_encoding.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const FPS = 30;
const kinds = new Set(['title-scroll', 'title-ink', 'reaction-thought', 'reaction-confused', 'reaction-sweat', 'reaction-alert', 'reaction-anger', 'reaction-shock', 'reaction-gloom', 'reaction-idea', 'prop-ring', 'underline', 'connector', 'map-route']);
const clean = text => String(text).normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
const chars = text => [...clean(text)];
const nonempty = text => typeof text === 'string' && text.trim().length > 0;
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const fingerprint = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const fail = message => { throw new Error(message); };
const evidence = value => nonempty(value) || (value && typeof value === 'object' && !Array.isArray(value) && nonempty(value.method));

export function probeAudio(file) {
  const meta = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration:format=duration', '-of', 'json', file], {encoding: 'utf8'}));
  const streams = meta.streams.filter(s => s.codec_type === 'audio');
  if (streams.length !== 1) fail(`Expected exactly one audio stream: ${file}`);
  const duration = Number(streams[0].duration ?? meta.format.duration);
  if (!finite(duration, .001, Infinity)) fail(`Invalid audio duration: ${file}`);
  return {codec: streams[0].codec_name, duration};
}

function imagePath(value) {
  if (!nonempty(value) || /^https?:/i.test(value)) fail('firstFrameImage must reference an inspected local image; download remote images first');
  const file = value.startsWith('/static/') ? path.join(root, 'data', value.slice(1)) : path.isAbsolute(value) ? value : path.join(root, 'data', value);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`Missing image: ${file}`);
  return path.resolve(file);
}

/** Normalized characters must tile exactly; punctuation/spacing may differ, words may not. */
export function alignTimeline(storyboards, titles, duration) {
  if (!Array.isArray(storyboards) || !storyboards.length || !Array.isArray(titles) || !titles.length) fail('Nonempty storyboards and frozen titles are required');
  if (!finite(duration, .001, Infinity)) fail('Invalid narration duration');
  let titleCursor = 0, previousEnd = 0;
  const indexedTitles = titles.map((title, index) => {
    // MP4 stream duration is reported at millisecond precision; tolerate only
    // that rounding at the final boundary (not an extra frame or missing audio).
    if (!nonempty(title.text) || !chars(title.text).length || !finite(title.time_begin, 0, duration * 1000) || !finite(title.time_end, 0, duration * 1000 + 1) || title.time_end <= title.time_begin || title.time_begin < previousEnd) fail(`Invalid/overlapping title ${index + 1}; time_begin/time_end are milliseconds`);
    const startChar = titleCursor;
    titleCursor += chars(title.text).length;
    previousEnd = title.time_end;
    return {...title, titleIndex: index, startChar, endChar: titleCursor};
  });
  const titleText = indexedTitles.map(t => clean(t.text)).join('');
  const storyboardText = storyboards.map(s => clean(s.narration ?? '')).join('');
  if (titleText !== storyboardText) fail('Frozen title words do not exactly match storyboard narration in order; do not rewrite, drop, or approximate words');
  const boundaryAt = index => {
    const title = indexedTitles.find(t => index >= t.startChar && index < t.endChar);
    if (!title) fail(`No title covers character ${index}`);
    const offset = index - title.startChar;
    return {seconds: (title.time_begin + (title.time_end - title.time_begin) * offset / (title.endChar - title.startChar)) / 1000,
      titleIndex: title.titleIndex, offsetChars: offset,
      method: offset === 0 ? 'frozen title start; frame rounded' : 'within-title character proportion estimate; NOT exact word timing'};
  };
  let cursor = 0;
  const ranges = storyboards.map((s, index) => {
    if (!nonempty(s.narration) || !chars(s.narration).length) fail(`Empty narration for storyboard ${s.storyboardNumber}`);
    const startChar = cursor;
    cursor += chars(s.narration).length;
    return {startChar, endChar: cursor, startEvidence: index ? boundaryAt(startChar) : {seconds: 0, method: 'audio start; includes leading silence'}};
  });
  const totalFrames = Math.round(duration * FPS);
  const result = ranges.map((r, index) => {
    const startFrame = Math.round(r.startEvidence.seconds * FPS);
    const endEvidence = ranges[index + 1]?.startEvidence ?? {seconds: duration, method: 'audio end; includes trailing silence'};
    const endFrame = index === ranges.length - 1 ? totalFrames : Math.round(endEvidence.seconds * FPS);
    if (endFrame <= startFrame) fail(`Storyboard ${storyboards[index].storyboardNumber} has no frames; refine real title timing or shot boundaries`);
    return {...r, startFrame, frames: endFrame - startFrame, duration: (endFrame - startFrame) / FPS, endEvidence};
  });
  return {shots: result, titles: indexedTitles, totalFrames, duration, frameDuration: totalFrames / FPS};
}

// Keep the title's original glyphs and punctuation. Refuse to split one Unicode
// grapheme when normalization expands it into several matching characters.
function titleSlice(text, from, to) {
  const raw = [...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)].map(s => s.segment);
  const positions = raw.flatMap((c, i) => chars(c).map(() => i));
  if ((from > 0 && positions[from] === positions[from - 1]) || (to < positions.length && positions[to] === positions[to - 1])) fail('Shot boundary splits a normalized Unicode grapheme; choose an unambiguous word boundary');
  const start = from === 0 ? 0 : positions[from];
  const end = to >= positions.length ? raw.length : positions[to];
  return raw.slice(start, end).join('').trim();
}

export function captionsForShot(shot, titles) {
  const captions = [];
  for (const title of titles) {
    const from = Math.max(shot.startChar, title.startChar), to = Math.min(shot.endChar, title.endChar);
    if (to <= from) continue;
    const count = title.endChar - title.startChar;
    const a = from - title.startChar, b = to - title.startChar;
    const begin = title.time_begin + (title.time_end - title.time_begin) * a / count;
    const end = title.time_begin + (title.time_end - title.time_begin) * b / count;
    const startSeconds = Math.max(0, begin / 1000 - shot.startFrame / FPS);
    const endSeconds = Math.min(shot.duration, end / 1000 - shot.startFrame / FPS);
    if (Math.round(endSeconds * 100) <= Math.round(startSeconds * 100)) fail('Caption would disappear at ASS centisecond precision; inspect/refine frozen title boundaries');
    captions.push({text: titleSlice(title.text, a, b), start: startSeconds, end: endSeconds, titleIndex: title.titleIndex,
      method: a === 0 && b === count ? 'frozen title window clipped to rounded shot' : 'within-title character proportion estimate; NOT exact word timing'});
  }
  if (captions.map(c => clean(c.text)).join('') !== clean(shot.narration)) fail('Caption word coverage changed');
  return captions;
}

function assTime(seconds) {
  const cs = Math.round(seconds * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
function assText(text) {
  const safe = text.replace(/[\r\n]/g, ' ').replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝');
  const lines = []; let line = '';
  for (const c of safe) {
    if ([...line].length >= 23 && !/[，。！？；：、）”」】]/.test(c)) { lines.push(line); line = ''; }
    line += c;
  }
  if (line) lines.push(line);
  return lines.join('\\N');
}
export function buildAss(captions) {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,PingFang SC,48,&H00FFFFFF,&H00FFFFFF,&H00141414,&H80000000,0,0,0,0,100,100,0,0,1,2.5,0,2,140,140,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + captions.map(c => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${assText(c.text)}`).join('\n') + '\n';
}

function validateEvent(event, shot, label) {
  if (!Number.isInteger(event.startFrame) || !Number.isInteger(event.endFrame) || event.startFrame < 0 || event.endFrame <= event.startFrame || event.endFrame > shot.frames) fail(`${label}: invalid local frame window`);
  if (!nonempty(event.trigger) || !clean(shot.narration).includes(clean(event.trigger)) || !clean(event.trigger) || /待核/.test(event.trigger)) fail(`${label}: trigger must belong to frozen narration`);
  if (!evidence(event.timingEvidence)) fail(`${label}: timingEvidence is required (estimates must be labeled)`);
}

function validateMapRoute(e, camera) {
  const route=e.route, duration=e.endFrame-e.startFrame;
  if(e.space!=='screen' || e.x!==0 || e.y!==0 || e.width!==1 || e.height!==1
    || camera.mode!=='hold' || camera.amount!==0) fail('map-route requires full-frame screen space and a hold camera');
  if(!route || !Array.isArray(route.points) || route.points.length<2 || route.points.length>256
    || route.points.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!finite(v,0,1)))
    || route.points.every(p=>p[0]===route.points[0][0]&&p[1]===route.points[0][1])) fail('map-route requires distinct normalized points');
  if(![route.revealStartOffset,route.revealEndOffset,route.pulseFrames].every(Number.isInteger)
    || route.revealStartOffset<0 || route.revealEndOffset<=route.revealStartOffset || route.pulseFrames<1
    || route.revealEndOffset+Math.max(route.pulseFrames,Math.ceil(FPS*.7))>duration) fail('map-route needs valid reveal offsets, arrival pulse and readable hold');
  if((route.marker!==undefined && !['dot','ship'].includes(route.marker))
    || !['illustrative','sourced'].includes(route.historyStatus) || !nonempty(route.coordinateSource)) fail('map-route needs a valid marker and coordinate provenance');
}

function validateDecision(decision, shot) {
  for (const key of ['intent', 'visualEvidence', 'rationale']) if (!nonempty(decision[key])) fail(`Shot ${shot.storyboardNumber}: ${key} must describe the inspected image and editorial choice`);
  const camera = decision.camera;
  if (!camera || !['hold', 'push', 'pull', 'pan-left', 'pan-right'].includes(camera.mode) || !finite(camera.amount, 0, .045) || !finite(camera.focusX, 0, 1) || !finite(camera.focusY, 0, 1) || (camera.mode === 'hold' && camera.amount !== 0)) fail(`Shot ${shot.storyboardNumber}: invalid restrained camera`);
  if (decision.effects !== undefined && !Array.isArray(decision.effects)) fail('effects must be an array, including [] for intentional quiet shots');
  const ids = new Set();
  const effects = (decision.effects ?? []).map((item, index) => {
    const e = {...item, id: item.id ?? `refined-${shot.id}-${index + 1}`};
    validateEvent(e, shot, `Shot ${shot.storyboardNumber} effect ${index + 1}`);
    if (!nonempty(e.id) || ids.has(e.id) || !kinds.has(e.kind) || !['screen', 'image'].includes(e.space)) fail('Invalid effect id/kind/space');
    ids.add(e.id);
    if (![e.x, e.y, e.width, e.height].every(v => finite(v, 0, 1)) || !e.width || !e.height || e.x + e.width > 1.000001 || e.y + e.height > 1.000001) fail('Effect placement exceeds image');
    if (e.kind.startsWith('title-') && !nonempty(e.text)) fail('Title effect text is required');
    if (e.fontSize !== undefined && !finite(e.fontSize, 1, 1000)) fail('Invalid effect fontSize');
    if (e.font !== undefined && !['mashan', 'wenkai'].includes(e.font)) fail('Invalid title font');
    if (e.motion !== undefined && !['brush', 'stamp'].includes(e.motion)) fail('Invalid title motion');
    if (e.emphasisText !== undefined && (!nonempty(e.emphasisText) || !e.text?.replace(/\n/g, '').includes(e.emphasisText.replace(/\n/g, '')))) fail('emphasisText must belong to title');
    if (e.kind === 'map-route') validateMapRoute(e,camera);
    return e;
  });
  const page = decision.page;
  if (page) {
    validateEvent(page, shot, `Shot ${shot.storyboardNumber} page`);
    if (!nonempty(page.title) || (page.fontSize !== undefined && !finite(page.fontSize, 1, 1000))) fail('Invalid page title/fontSize');
  }
  if (decision.audioCues !== undefined && !Array.isArray(decision.audioCues)) fail('audioCues must be an array');
  for (const cue of decision.audioCues ?? []) {
    if (!nonempty(cue.reason) || !evidence(cue.timingEvidence)) fail('Every sound cue needs reason and timingEvidence after audition');
    if (cue.effectId) {
      if (!effects.some(e => e.id === cue.effectId) && cue.effectId !== 'page') fail(`Sound cue references missing effect ${cue.effectId}`);
      if (cue.effectId === 'page' && !page) fail('Sound cue references missing page');
    } else if (!nonempty(cue.trigger) || !clean(cue.trigger) || !clean(shot.narration).includes(clean(cue.trigger))) fail('Sound cue needs a valid effectId or narration trigger');
  }
  return {effects, ...(page ? {page} : {}), audioCues: decision.audioCues ?? []};
}

export function compilePlan({snapshot, titles, decisions, duration, audio, outputDir, stem, soundAssets = {}, sourceInputs = {}, uploadEncoding}) {
  const encoding=resolveUploadEncoding(uploadEncoding);
  if (!Number.isInteger(snapshot?.episode?.id) || snapshot.episode.id <= 0) fail('snapshot.episode.id must be a positive integer');
  if (!nonempty(stem) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(stem)) fail('An explicit unique --stem with only letters, numbers, _ and - is required');
  const sourceShots = snapshot.storyboards;
  const timeline = alignTimeline(sourceShots, titles, duration);
  if (!Array.isArray(decisions) || decisions.length !== sourceShots.length) fail('Need exactly one manual decision for every storyboard');
  const numbers = new Set(), ids = new Set();
  for (const shot of sourceShots) {
    if (!Number.isInteger(shot.id) || !Number.isInteger(shot.storyboardNumber) || shot.storyboardNumber < 1 || numbers.has(shot.storyboardNumber) || ids.has(shot.id)) fail('Storyboards need unique integer IDs and storyboard numbers');
    if (shot.storyboardNumber <= (numbers.size ? Math.max(...numbers) : 0)) fail('Storyboards must already be in narrative order');
    numbers.add(shot.storyboardNumber); ids.add(shot.id);
  }
  if (new Set(decisions.map(d => d.storyboardNumber)).size !== decisions.length || decisions.some(d => !numbers.has(d.storyboardNumber))) fail('Decisions must match unique storyboard numbers');
  const assets = {};
  if (!soundAssets || Array.isArray(soundAssets) || typeof soundAssets !== 'object') fail('soundAssets must be a keyed catalog of selected local assets');
  for (const [key, asset] of Object.entries(soundAssets)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key) || !nonempty(asset.file) || !path.isAbsolute(asset.file) || !fs.existsSync(asset.file) || !finite(asset.duration, .001, 10) || !finite(asset.gainDb, -60, -6) || !finite(asset.trimStart ?? 0, 0, Infinity) || !finite(asset.targetRmsDb ?? -18, -60, -3)) fail(`Invalid selected sound asset ${key}`);
    const media = probeAudio(asset.file);
    if ((asset.trimStart ?? 0) + asset.duration > media.duration + .01) fail(`Sound trim exceeds actual audio: ${key}`);
    assets[key] = {...asset, sourceFingerprint: fingerprint(asset.file)};
  }
  const files = new Map();
  const shots = sourceShots.map((source, index) => {
    const d = decisions.find(item => item.storyboardNumber === source.storyboardNumber);
    const shot = {...source, ...timeline.shots[index], firstFrameImage: imagePath(source.firstFrameImage)};
    const chosen = validateDecision(d, shot);
    const captions = captionsForShot(shot, timeline.titles);
    const captionFile = path.join(outputDir, 'captions', `${shot.storyboardNumber}.ass`);
    files.set(captionFile, buildAss(captions));
    const warnings = [...(d.warnings ?? []), ...['dialogue', 'videoPrompt', 'movement'].filter(k => !nonempty(source[k])).map(k => `missing ${k}; decision uses inspected image and frozen narration`)];
    const beat = {id: `refined-${source.id}`, start: 0, end: shot.duration, text: source.narration, role: d.intent, framing: 'single full-frame image; safe crop', focus: {x: d.camera.focusX, y: d.camera.focusY, zoom: 1 + d.camera.amount}, motion: d.camera.mode, easing: 'ease-in-out', transition: 'cut', rationale: d.rationale, layerMode: 'crop', layers: [], fallback: null, warnings: []};
    return {...shot, shotId: source.id, camera: d.camera, intent: d.intent, visualEvidence: d.visualEvidence, editDecision: d.rationale, sourceDuration: source.duration,
      imageFingerprint: fingerprint(shot.firstFrameImage), caption: {file: captionFile, parts: captions.map(c => c.text), evidence: captions}, beats: [beat], warnings,
      sourceEvidence: {narration: source.narration, dialogue: source.dialogue ?? '', videoPrompt: source.videoPrompt ?? '', movement: source.movement ?? '', asset: shot.firstFrameImage}, ...chosen};
  });
  const usedAssets = new Set(shots.flatMap(s => s.audioCues.map(c => c.kind)));
  for (const key of Object.keys(assets)) if (!usedAssets.has(key)) fail(`Unused sound asset ${key}; catalog should contain only auditioned, selected assets`);
  const plan = {schemaVersion: 1, episodeId: snapshot.episode.id, sourcePath: audio, sourceFingerprint: fingerprint(audio), duration, fps: FPS, width: 1920, height: 1080,
    baseDir: path.join(outputDir, 'base'), deliveryStem: stem, deliveryLabel: '逐镜头精细剪辑', layout: 'single-full-frame', soundAssets: assets, uploadEncoding: encoding,
    audioPolicy: 'Frozen narration words and timing; selected local short sound effects only; no BGM; sound cues require listening review.',
    inputs: sourceInputs, timelineEvidence: {normalizedWordsMatch: true, totalFrames: timeline.totalFrames, frameDuration: timeline.frameDuration, sourceDuration: duration, frameRoundingErrorSeconds: timeline.frameDuration - duration, withinTitleTimesAreEstimates: true}, shots};
  const events = schedule(plan); // Validates catalog keys, local frames, gains, and simultaneous cues.
  for (const event of events) {
    const spec = assets[event.kind];
    if (event.endSample - event.startSample < Math.round(spec.duration * 48000)) fail(`Sound ${event.kind} in shot ${event.shot} would lose its tail; select a shorter asset or earlier cue`);
  }
  const alignedSnapshot = {...snapshot, episode: {...snapshot.episode, duration}, storyboards: sourceShots.map((s, i) => ({...s, sourceDuration: s.duration, duration: shots[i].duration})), timingSource: sourceInputs};
  files.set(path.join(outputDir, 'edit-plan.json'), json(plan));
  files.set(path.join(outputDir, 'base', 'edit-plan.json'), json(plan));
  files.set(path.join(outputDir, 'snapshot.json'), json(alignedSnapshot));
  files.set(path.join(outputDir, 'source-snapshot.json'), json(snapshot));
  return {plan, files};
}

export function writeNewOrIdentical(files) {
  // Validate every destination first, so a conflict cannot leave half a new plan.
  for (const [file, body] of files) if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== body) fail(`Refusing to overwrite changed artifact: ${file}; use a new revision output directory`);
  for (const [file, body] of files) {
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, body, {flag: 'wx'});
  }
}

export function main(argv = process.argv.slice(2)) {
  const allowed = new Set(['snapshot', 'audio', 'titles', 'decisions', 'output-dir', 'stem', 'sound-assets', 'upload-encoding']);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || options[key] || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('Usage: build_refined_plan.mjs --snapshot snapshot.json --audio /absolute/narration.m4a --titles titles.json --decisions decisions.json --output-dir new-directory --stem unique-revision [--sound-assets selected-assets.json] [--upload-encoding reviewed-encoding.json]');
    options[key] = argv[i + 1];
  }
  for (const key of ['snapshot', 'audio', 'titles', 'decisions', 'output-dir', 'stem']) if (!nonempty(options[key])) fail(`Missing --${key}`);
  if (!path.isAbsolute(options.audio)) fail('--audio must be an absolute path to frozen narration');
  const audio = path.resolve(options.audio), media = probeAudio(audio);
  if (media.codec !== 'aac') fail('Frozen delivery audio must be AAC (.m4a or .mp4) for lossless packet-copy assembly. Convert the existing narration with ffmpeg -c:a aac without retiming; keep the original file and record its hash. Do not regenerate narration.');
  const sourceInputs = Object.fromEntries(['snapshot', 'audio', 'titles', 'decisions', ...(options['sound-assets'] ? ['sound-assets'] : []), ...(options['upload-encoding'] ? ['upload-encoding'] : [])].map(key => [key, {path: path.resolve(options[key]), sha256: fingerprint(options[key])}]));
  sourceInputs.audio.codec = media.codec;
  const result = compilePlan({snapshot: read(options.snapshot), titles: read(options.titles), decisions: read(options.decisions), soundAssets: options['sound-assets'] ? read(options['sound-assets']) : {}, uploadEncoding: options['upload-encoding'] ? read(options['upload-encoding']) : undefined, duration: media.duration, audio, outputDir: path.resolve(options['output-dir']), stem: options.stem, sourceInputs});
  writeNewOrIdentical(result.files);
  console.log(json({status: 'compiled-awaiting-visual-and-listening-review', plan: path.join(path.resolve(options['output-dir']), 'edit-plan.json'), shots: result.plan.shots.length, frames: result.plan.timelineEvidence.totalFrames, effects: result.plan.shots.reduce((sum, s) => sum + s.effects.length, 0), audioCues: result.plan.shots.reduce((sum, s) => sum + s.audioCues.length, 0), layout: result.plan.layout}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`[videoeditor] ${error.message}`); process.exitCode = 1; }
}
