#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {resolveUploadEncoding, uploadEncodingReport} from './upload_encoding.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'remotion/package.json'));
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const save = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const probe = p => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', p], {encoding: 'utf8'}));
const clean = text => String(text).normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
const audioHash = p => execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], {encoding: 'utf8'}).trim();

function captionChunks(text) {
  const chars = [...text], boundaries = [];
  let cursor = 0;
  for (const token of new Intl.Segmenter('zh', {granularity: 'word'}).segment(text)) {
    cursor += [...token.segment].length;
    boundaries.push(cursor);
  }
  const chunks = [];
  for (let start = 0; start < chars.length;) {
    let end = Math.min(chars.length, start + 28);
    if (end < chars.length) {
      const punctuation = boundaries.filter(b => b > start + 8 && b <= end && /[，。！？；：、]/.test(chars[b - 1]));
      end = punctuation.at(-1) ?? boundaries.filter(b => b > start && b <= end).at(-1) ?? end;
      while (end < chars.length && /[，。！？；：、）”」】]/.test(chars[end])) end++;
    }
    chunks.push({text: chars.slice(start, end).join(''), start, end});
    start = end;
  }
  return chunks;
}

export function buildCaptions(plan, titles) {
  const frames = plan.shots.reduce((sum, s) => sum + s.frames, 0);
  const sourceCues = titles ? titles.map(t => ({text: t.text, startFrame: Math.round(t.time_begin / 1000 * plan.fps),
    endFrame: Math.min(frames, Math.round(t.time_end / 1000 * plan.fps))}))
    : plan.shots.flatMap(s => (s.caption?.evidence ?? []).map(c => ({text: c.text,
      startFrame: s.startFrame + Math.round(c.start * plan.fps),
      endFrame: Math.min(s.startFrame + s.frames, s.startFrame + Math.round(c.end * plan.fps))})));
  const cues = sourceCues.flatMap(c => {
    const chunks = captionChunks(c.text), length = [...c.text].length;
    return chunks.map(chunk => ({text: chunk.text,
      startFrame: c.startFrame + Math.round((c.endFrame - c.startFrame) * chunk.start / length),
      endFrame: c.startFrame + Math.round((c.endFrame - c.startFrame) * chunk.end / length),
      ...(chunks.length > 1 ? {timingEvidence: 'Punctuation/word-boundary caption split by character proportion; internal boundaries are estimates, not exact word timing'} : {})}));
  });
  let end = 0;
  for (const c of cues) {
    if (!c.text?.trim() || !Number.isInteger(c.startFrame) || !Number.isInteger(c.endFrame)
      || c.startFrame < end || c.endFrame <= c.startFrame || c.endFrame > frames) throw Error('Invalid or overlapping caption window');
    end = c.endFrame;
  }
  if (!cues.length || clean(cues.map(c => c.text).join('')) !== clean(plan.shots.map(s => s.narration ?? s.sourceEvidence?.narration ?? '').join('')))
    throw Error('Captions must cover frozen narration exactly');
  return cues;
}

export function validatePlan(plan) {
  if (plan.width !== 1920 || plan.height !== 1080 || plan.fps !== 30 || !plan.shots?.length) throw Error('Expected full-frame 1920x1080 at 30 fps');
  let cursor = 0;
  const ids = new Set();
  for (const shot of plan.shots) {
    if (shot.startFrame !== cursor || !Number.isInteger(shot.frames) || shot.frames < 1 || ids.has(shot.storyboardNumber)) throw Error('Shot timeline must tile exactly with unique numbers');
    if (!shot.firstFrameImage || !shot.camera || !Array.isArray(shot.effects)) throw Error('Missing frozen shot image/camera/effects');
    cursor += shot.frames; ids.add(shot.storyboardNumber);
  }
  if (cursor !== Math.round(plan.duration * plan.fps)) throw Error('Shot frames do not match frozen duration');
  return cursor;
}

async function post(api, endpoint, body) {
  const response = await fetch(`${api.replace(/\/$/, '')}/api/v1/remotion/${endpoint}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!response.ok) throw Error(`Persistence failed ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function renderDirect(options) {
  const planFile = path.resolve(options.plan), output = path.resolve(options.output);
  if (fs.existsSync(output)) throw Error('Refuse overwrite existing output');
  const plan = read(planFile), totalFrames = validatePlan(plan), encoding = resolveUploadEncoding(plan.uploadEncoding);
  const captions = buildCaptions(plan, options.titles ? read(path.resolve(options.titles)) : undefined);
  const work = output + '.render', publicDir = path.join(work, 'public');
  fs.mkdirSync(path.join(publicDir, 'assets'), {recursive: true});
  fs.mkdirSync(path.join(publicDir, 'fonts'), {recursive: true});
  const assets = [];
  const freeze = async (source, name) => {
    let file = source;
    if (/^https?:/.test(source)) {
      const response = await fetch(source);
      if (!response.ok) throw Error(`Asset download failed: ${response.status}`);
      file = path.join(publicDir, 'assets', name);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    } else {
      file = source.startsWith('/static/') ? path.join(root, 'data', source.slice(1))
        : path.isAbsolute(source) ? source : path.join(root, 'data', source);
      fs.copyFileSync(file, path.join(publicDir, 'assets', name));
    }
    assets.push({source, path: `assets/${name}`, sha256: sha(path.join(publicDir, 'assets', name))});
    return `assets/${name}`;
  };
  const audioSrc = await freeze(plan.sourcePath, 'narration' + (path.extname(new URL(plan.sourcePath, 'file:///').pathname) || '.m4a'));
  if (plan.sourceFingerprint && assets.at(-1).sha256 !== plan.sourceFingerprint) throw Error('Frozen narration fingerprint changed');
  const audio = probe(path.join(publicDir, audioSrc));
  if (audio.streams.filter(s => s.codec_type === 'audio').length !== 1 || Math.abs(Number(audio.format.duration) - plan.duration) > .05) throw Error('Frozen narration duration/audio mismatch');
  if (audio.streams.find(s => s.codec_type === 'audio').codec_name !== 'aac') throw Error('Freeze narration as AAC once before direct rendering; full output copies original packets');
  const shots = [];
  for (const shot of plan.shots) {
    const imageSrc = await freeze(shot.firstFrameImage, `shot-${shot.storyboardNumber}` + (path.extname(new URL(shot.firstFrameImage, 'file:///').pathname) || '.png'));
    if (shot.imageFingerprint && assets.at(-1).sha256 !== shot.imageFingerprint) throw Error(`Shot ${shot.storyboardNumber} image changed`);
    shots.push({...shot, imageSrc, ...(shot.page ? {page: {...shot.page, imageSrc}} : {})});
  }
  for (const name of ['MaShanZheng-Regular.ttf', 'LXGWWenKaiScreen.ttf']) fs.copyFileSync(path.join(root, 'remotion/public/fonts', name), path.join(publicDir, 'fonts', name));
  const props = {width: plan.width, height: plan.height, fps: plan.fps, durationInFrames: totalFrames, shots, audioSrc, captions};
  save(path.join(work, 'props.json'), props); save(path.join(work, 'assets.json'), assets);
  const {bundle} = await import(req.resolve('@remotion/bundler'));
  const {selectComposition, renderMedia} = await import(req.resolve('@remotion/renderer'));
  const browserExecutable = path.join(root, '.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell');
  const serveUrl = await bundle({entryPoint: path.join(root, 'remotion/src/history-fullframe-entry.tsx'), rootDir: path.join(root, 'remotion'), publicDir, outDir: path.join(work, 'bundle')});
  const composition = await selectComposition({serveUrl, id: 'HistoryFullFrameDirect', inputProps: props, browserExecutable});
  const frameRange = options.frames?.split('-').map(Number);
  if (frameRange && (frameRange.length !== 2 || frameRange.some(n => !Number.isInteger(n) || n < 0) || frameRange[0] > frameRange[1] || frameRange[1] >= totalFrames)) throw Error('Invalid sample frame range');
  const renderRecord = {render_kind: 'episode', input_hash: sha(planFile), width: plan.width, height: plan.height, fps: plan.fps, props: {composition: 'HistoryFullFrameDirect', planFile, assets, uploadEncoding: encoding}};
  const persist = body => options.project && !frameRange ? post(options.api ?? 'http://127.0.0.1:5679', `projects/${options.project}/renders`, {...renderRecord, ...body}) : Promise.resolve();
  await persist({status: 'running'});
  try {
    let lastProgress = -1;
    const videoOutput = frameRange ? output + '.partial.mp4' : output + '.video.partial.mp4';
    await renderMedia({composition, serveUrl, inputProps: props, browserExecutable, outputLocation: videoOutput,
      codec: 'h264', crf: encoding.crf, x264Preset: encoding.preset, hardwareAcceleration: 'disable',
      encodingMaxRate: `${encoding.maxRateKbps}k`, encodingBufferSize: `${encoding.maxRateKbps * 2}k`,
      gopSize: 150, pixelFormat: 'yuv420p', audioCodec: 'aac', audioBitrate: encoding.audioBitrate,
      muted: !frameRange, enforceAudioTrack: Boolean(frameRange), imageFormat: 'png',
      concurrency: Number(options.concurrency ?? 3), ...(frameRange ? {frameRange} : {}),
      onProgress: p => {const percent = Math.floor(p.progress * 100); if (percent >= lastProgress + 5) {console.log(`render ${percent}%`); lastProgress = percent;}}});
    let narrationPacketHash = null;
    if (!frameRange) {
      execFileSync('ffmpeg', ['-v', 'error', '-n', '-i', videoOutput, '-i', path.join(publicDir, audioSrc),
        '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', output + '.partial.mp4']);
      narrationPacketHash = audioHash(output + '.partial.mp4');
      if (narrationPacketHash !== audioHash(path.join(publicDir, audioSrc))) throw Error('Narration packet hash changed during mux');
    }
    const metadata = probe(output + '.partial.mp4'), video = metadata.streams.find(s => s.codec_type === 'video');
    const expectedFrames = frameRange ? frameRange[1] - frameRange[0] + 1 : totalFrames;
    if (Number(video?.nb_frames) !== expectedFrames || video.width !== 1920 || video.height !== 1080 || video.r_frame_rate !== '30/1'
      || metadata.streams.filter(s => s.codec_type === 'audio').length !== 1 || Math.abs(Number(metadata.format.duration) - expectedFrames / 30) > .08) throw Error('Rendered media frame/audio/duration contract failed');
    const budget = uploadEncodingReport(metadata, fs.statSync(output + '.partial.mp4').size, encoding);
    if (budget.status !== 'within-budget') throw Error('Rendered media exceeds filesize budget');
    fs.renameSync(output + '.partial.mp4', output);
    const sidecar = {status: 'validated-awaiting-visual-and-listening-review', output, sha256: sha(output), planSha256: sha(planFile),
      propsSha256: sha(path.join(work, 'props.json')), frames: expectedFrames, duration: Number(metadata.format.duration), assets,
      composition: 'HistoryFullFrameDirect', rendererVersion: req('@remotion/renderer/package.json').version,
      narrationPacketHash, audioPolicy: frameRange ? 'Sample audio AAC encoded by Remotion for frame-accurate range' : 'Frozen AAC packet copy; no narration re-encode',
      encoding: {...encoding, hardwareAcceleration: 'disable', gopSize: 150}, uploadEncoding: budget, frameRange: frameRange ?? null,
      layers: ['full-frame-images', 'camera', 'ReferenceEditorialOverlay', 'global-captions', 'frozen-narration'], sfx: 'not mixed; use editorial_sfx next'};
    save(output + '.json', sidecar);
    await persist({status: 'succeeded', output_path: output, output_url: options.url ?? null, duration_ms: Math.round(sidecar.duration * 1000), qa: sidecar});
    console.log(JSON.stringify(sidecar, null, 2));
    return sidecar;
  } catch (error) {
    await persist({status: 'failed', error_message: error.message});
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw Error('Expected --key value');
    options[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  if (!options.plan || !options.output) throw Error('Required: --plan edit-plan.json --output movie.mp4');
  renderDirect(options).catch(error => {console.error(error); process.exitCode = 1;});
}
