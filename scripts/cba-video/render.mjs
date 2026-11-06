import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileHash} from './core.mjs';

// This module renders an already reviewed edit. Selection, factual checks, TTS,
// and approval belong to the workflow that calls it.
async function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-24000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({stdout, stderr}) :
      reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)));
  });
}

async function probe(file) {
  const {stdout} = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const data = JSON.parse(stdout);
  const video = data.streams.find(stream => stream.codec_type === 'video');
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  return {duration: Number(data.format.duration), width: video?.width, height: video?.height,
    hasAudio: Boolean(audio), hasVideo: Boolean(video), audioDuration: Number(audio?.duration) || Number(data.format.duration),
    videoCodec: video?.codec_name, audioCodec: audio?.codec_name};
}

function uniqueMap(values, name) {
  const map = new Map();
  for (const item of values ?? []) {
    if (!item.id || map.has(item.id)) throw new Error(`${name} requires unique nonempty IDs: ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

export function narrationOffsetSeconds(segment) {
  const value = segment.audioDigest?.offsetSeconds;
  const offset = value === undefined ? 0 : value;
  if (!Number.isFinite(offset) || offset < 0)
    throw new Error(`News segment ${segment.id}: offsetSeconds must be a finite non-negative number`);
  return offset;
}

// Source cuts cover the original recording once, in order. Small probe/rounding
// differences are snapped to adjoining boundaries, never used to omit audio.
export function narrationParts(segment, duration = segment.audioDigest?.duration) {
  const offset = narrationOffsetSeconds(segment), parts = segment.audioDigest?.parts;
  const fail = message => { throw new Error(`News segment ${segment.id}: narration parts ${message}`); };
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) fail('require a positive audio duration');
  if (parts === undefined) return duration === undefined ? undefined : [{start: 0, end: duration, offset, text: segment.text}];
  if (!Array.isArray(parts) || !parts.length) fail('must be a nonempty array');
  let sourceEnd = 0, destinationEnd = 0;
  const normalized = parts.map((part, index) => {
    if (!part || ![part.start, part.end, part.offset].every(Number.isFinite) || part.start < 0 || part.end <= part.start || part.offset < 0)
      fail('require finite non-negative start/offset and end greater than start');
    if (typeof part.text !== 'string') fail('require text for every part');
    if (Math.abs(part.start - sourceEnd) > .05) fail('must continuously cover the source audio from zero');
    const start = sourceEnd;
    let end = part.end;
    if (index === parts.length - 1 && duration !== undefined) {
      if (Math.abs(end - duration) > .05) fail('must cover the complete audio duration');
      end = duration;
    }
    if (end <= start) fail('must have positive source durations');
    if (part.offset + 1e-9 < destinationEnd) fail('must have increasing, non-overlapping playback windows');
    sourceEnd = end;
    destinationEnd = part.offset + end - start;
    return {start, end, offset: part.offset, text: part.text};
  });
  if (normalized.map(part => part.text).join('') !== segment.text) fail('text must concatenate to the approved segment text');
  return normalized;
}

function settings(options = {}) {
  const width = options.width ?? 1920, height = options.height ?? 1080, fps = options.fps ?? 30;
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value % 2 === 0) || width * 9 !== height * 16)
    throw new Error('Output width and height must be positive even integers in 16:9 ratio');
  if (!Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error('Output fps must be between 0 and 120');
  return {width, height, fps, preset: options.preset ?? 'medium', crf: options.crf ?? 20, fontPath: options.fontPath};
}

async function context({job, jobDir, outputDir, preview = false, options = {}}) {
  if (!job || !jobDir || !outputDir) throw new Error('job, jobDir, and outputDir are required');
  const config = settings(options);
  const destination = path.resolve(outputDir);
  await fs.mkdir(destination, {recursive: true});
  const temp = await fs.mkdtemp(path.join(destination, '.render-'));
  try {
    return {job, jobDir: path.resolve(jobDir), outputDir: destination, temp, config, preview,
      media: uniqueMap(job.media, 'media'), clips: uniqueMap(job.clips, 'clips'), probes: new Map(), warnings: []};
  } catch (error) {
    await fs.rm(temp, {recursive: true, force: true});
    throw error;
  }
}

async function mediaFor(ctx, id) {
  const media = ctx.media.get(id);
  if (!media?.path) throw new Error(`Missing media or local media path: ${id}`);
  const file = path.resolve(ctx.jobDir, media.path);
  if (!ctx.probes.has(file)) ctx.probes.set(file, await probe(file));
  return {file, ...ctx.probes.get(file)};
}

async function clipsFor(ctx, ids, {requireAudio = false} = {}) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('Every segment or highlights edit needs at least one clip');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate clip IDs would replay the same action');
  const result = [];
  for (const id of ids) {
    const clip = ctx.clips.get(id);
    if (!clip || clip.verified !== true) throw new Error(`Clip ${id} is missing or has not been verified`);
    const media = await mediaFor(ctx, clip.mediaId);
    if (!media.hasVideo) throw new Error(`Clip ${id} has no video stream`);
    if (![clip.start, clip.end].every(Number.isFinite) || clip.start < 0 || clip.end <= clip.start || clip.end > media.duration + .05)
      throw new Error(`Invalid time range for clip ${id}: ${clip.start}–${clip.end} (media ${media.duration}s)`);
    if (requireAudio && !media.hasAudio) throw new Error(`Clip ${id} requires original commentary but its source has no audio`);
    const frames = Math.max(1, Math.ceil((clip.end - clip.start) * ctx.config.fps - 1e-6));
    result.push({...clip, media, frames, duration: frames / ctx.config.fps});
  }
  return result;
}

function encoding(ctx) {
  return ['-c:v', 'libx264', '-preset', ctx.config.preset, '-crf', String(ctx.config.crf), '-pix_fmt', 'yuv420p'];
}

async function ffmpeg(ctx, args) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y', ...args], ctx.temp);
}

const loudnessTarget = {integratedLufs: -16, truePeakDbtp: -2, loudnessRangeLu: 11};
const loudnessFilter = `loudnorm=I=${loudnessTarget.integratedLufs}:TP=${loudnessTarget.truePeakDbtp}:LRA=${loudnessTarget.loudnessRangeLu}`;

function loudnessJson(stderr) {
  const block = stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
  if (!block) throw new Error('FFmpeg did not return a loudness measurement');
  return JSON.parse(block);
}

async function measureLoudness(ctx, file) {
  const {stderr} = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-vn',
    '-af', `${loudnessFilter}:print_format=json`, '-f', 'null', '-'], ctx.temp);
  const data = loudnessJson(stderr);
  const input = Object.fromEntries(['input_i', 'input_tp', 'input_lra', 'input_thresh'].map(key => [key, Number(data[key])]));
  const offset = Number(data.target_offset);
  if (![...Object.values(input), offset].every(Number.isFinite))
    throw new Error('Audio loudness is not measurable; check for silence or an incomplete audio track');
  // Only input_* measures the file being read. output_* describes a hypothetical
  // filtered stream and must never be used to certify the delivered AAC file.
  return {input, offset};
}

async function masterFinalAudio(ctx, input, output, duration) {
  const measured = await measureLoudness(ctx, input), before = measured.input;
  const filter = `${loudnessFilter}:measured_I=${before.input_i}:measured_TP=${before.input_tp}` +
    `:measured_LRA=${before.input_lra}:measured_thresh=${before.input_thresh}:offset=${measured.offset}:linear=true:print_format=json`;
  const {stderr} = await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', filter, '-c:a', 'aac', '-b:a', '192k',
    '-ar', '48000', '-movflags', '+faststart', '-t', String(duration), output], ctx.temp);
  const after = (await measureLoudness(ctx, output)).input;
  const tolerance = {integratedLu: 1, maximumTruePeakDbtp: -1};
  let correction;
  if (Math.abs(after.input_i - loudnessTarget.integratedLufs) > tolerance.integratedLu
      || after.input_tp > tolerance.maximumTruePeakDbtp) {
    const desiredGainDb = loudnessTarget.integratedLufs - after.input_i;
    const maximumGainDb = tolerance.maximumTruePeakDbtp - after.input_tp;
    // A negative gain always improves the peak constraint. For a positive gain,
    // cap it by measured true-peak headroom and let the final verification fail
    // truthfully if the two constraints cannot be met together.
    const gainDb = desiredGainDb > 0 ? Math.min(desiredGainDb, maximumGainDb) : desiredGainDb;
    if (!Number.isFinite(gainDb) || Math.abs(gainDb) < 1e-4)
      throw new Error(`Encoded audio failed mastering verification: ${after.input_i} LUFS, ${after.input_tp} dBTP`);
    const corrected = `${output}.correction.mp4`, outputPath = path.join(ctx.temp, output), correctedPath = path.join(ctx.temp, corrected);
    await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-i', output,
      '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', `volume=${gainDb.toFixed(4)}dB`,
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-t', String(duration), corrected], ctx.temp);
    await fs.rm(outputPath, {force: true});
    await fs.rename(correctedPath, outputPath);
    const correctedAfter = (await measureLoudness(ctx, output)).input;
    correction = {method: 'measured-volume-gain', gainDb, maximumGainDb, before: after, after: correctedAfter,
      video: 'stream-copy', audio: {codec: 'aac', bitrate: '192k', sampleRate: 48000}};
    if (Math.abs(correctedAfter.input_i - loudnessTarget.integratedLufs) > tolerance.integratedLu
        || correctedAfter.input_tp > tolerance.maximumTruePeakDbtp)
      throw new Error(`Encoded audio failed mastering verification: ${correctedAfter.input_i} LUFS, ${correctedAfter.input_tp} dBTP`);
    return {method: 'two-pass-loudnorm', target: {...loudnessTarget}, tolerance, before, after: correctedAfter, correction,
      measuredFields: 'input_* from a fresh analysis of the encoded AAC output',
      normalizationType: loudnessJson(stderr).normalization_type, measuredOffset: measured.offset,
      video: 'stream-copy', audio: {codec: 'aac', bitrate: '192k', sampleRate: 48000},
      outputSha256: await fileHash(path.join(ctx.temp, output)), verified: true};
  }
  return {method: 'two-pass-loudnorm', target: {...loudnessTarget}, tolerance, before, after,
    measuredFields: 'input_* from a fresh analysis of the encoded AAC output',
    normalizationType: loudnessJson(stderr).normalization_type, measuredOffset: measured.offset,
    video: 'stream-copy', audio: {codec: 'aac', bitrate: '192k', sampleRate: 48000},
    outputSha256: await fileHash(path.join(ctx.temp, output)), verified: true};
}

// All normalized intermediate audio is PCM. This avoids accumulating AAC encoder
// padding at every clip boundary when a long collection of plays is concatenated.
async function cutClip(ctx, clip, filename) {
  const {width, height, fps} = ctx.config;
  const args = ['-ss', String(clip.start), '-i', clip.media.file];
  if (!clip.media.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  const video = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=${1 / fps},trim=duration=${clip.duration},setpts=PTS-STARTPTS`;
  const audio = `${clip.media.hasAudio ? '[0:a:0]' : '[1:a:0]'}aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${clip.duration},asetpts=PTS-STARTPTS[a]`;
  args.push('-filter_complex', `[0:v:0]${video}[v];${audio}`, '-map', '[v]', '-map', '[a]',
    ...encoding(ctx), '-c:a', 'pcm_s16le', '-t', String(clip.duration), filename);
  await ffmpeg(ctx, args);
  return filename;
}

async function joinClips(ctx, clips, prefix) {
  const names = [];
  for (let i = 0; i < clips.length; i++) names.push(await cutClip(ctx, clips[i], `${prefix}-${i}.mkv`));
  // Generated filenames contain no user-controlled syntax or paths.
  const list = `${prefix}.concat`;
  await fs.writeFile(path.join(ctx.temp, list), names.map(name => `file '${name}'`).join('\n') + '\n');
  const joined = `${prefix}-joined.mkv`;
  await ffmpeg(ctx, ['-f', 'concat', '-safe', '1', '-i', list, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', joined]);
  return {file: joined, duration: clips.reduce((total, clip) => total + clip.duration, 0)};
}

function timestamp(seconds, ass = false) {
  const unit = ass ? 100 : 1000, total = Math.round(seconds * unit);
  const hours = Math.floor(total / (3600 * unit));
  const minutes = Math.floor(total / (60 * unit)) % 60;
  const secs = Math.floor(total / unit) % 60;
  return `${String(hours).padStart(ass ? 1 : 2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${ass ? '.' : ','}${String(total % unit).padStart(ass ? 2 : 3, '0')}`;
}

function cleanText(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/[\u0000-\u001f]/g, '').trim();
}

function wrapped(value, length) {
  const chars = Array.from(cleanText(value)), lines = [];
  for (let i = 0; i < chars.length; i += length) lines.push(chars.slice(i, i + length).join(''));
  return lines.join('\n');
}

/**
 * The audio file fixes the outer bounds; internal caption boundaries are a
 * text-length estimate, not forced alignment or word timestamps.
 */
export function buildCaptionCues(text, start, duration) {
  const chars = Array.from(cleanText(text));
  if (!chars.length) return [];
  if (![start, duration].every(Number.isFinite) || start < 0 || duration <= 0)
    throw new Error('Captions require a positive measured audio duration');
  const parts = [];
  while (chars.length) {
    let count = Math.min(30, chars.length);
    if (chars.length > count) {
      for (let i = count - 1; i >= 10; i--) {
        if (/[，。！？；、,.!?;\s]/u.test(chars[i])) { count = i + 1; break; }
      }
    }
    const part = chars.splice(0, count).join('').trim();
    if (part) parts.push(part);
  }
  const weights = parts.map(part => Math.max(1, Array.from(part.replace(/[\s，。！？；、,.!?;]/gu, '')).length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let consumed = 0;
  return parts.map((part, index) => {
    const from = start + duration * consumed / total;
    consumed += weights[index];
    return {text: part, start: from, end: index === parts.length - 1 ? start + duration : start + duration * consumed / total,
      timing: 'estimated-within-measured-segment-audio'};
  });
}

async function installFont(ctx) {
  const candidates = ctx.config.fontPath ? [ctx.config.fontPath] : [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  ];
  for (const candidate of candidates) {
    try {
      await fs.copyFile(candidate, path.join(ctx.temp, 'font.ttc'));
      return candidate.includes('Heiti') ? 'Heiti SC' : candidate.includes('PingFang') ? 'PingFang SC' : 'Noto Sans CJK SC';
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('A Chinese font is required; set options.fontPath to a CJK font file');
}

async function subtitles(ctx, cues, font) {
  const srt = cues.map((cue, i) => `${i + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${wrapped(cue.text, 16)}\n`).join('\n');
  await fs.writeFile(path.join(ctx.temp, 'news.srt'), srt, 'utf8');
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},48,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,110,110,150,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + cues.map(cue => {
    const text = wrapped(cue.text, 16).replace(/[{}\\]/g, '').replace(/\n/g, '\\N');
    return `Dialogue: 0,${timestamp(cue.start, true)},${timestamp(cue.end, true)},Default,,0,0,0,,${text}`;
  }).join('\n') + '\n';
  await fs.writeFile(path.join(ctx.temp, 'news.ass'), ass, 'utf8');
}

async function cover(ctx, videoFile, title, filename) {
  const {width, height} = ctx.config;
  const match = ctx.job.match ?? {};
  const score = typeof match.score === 'object' ? `${match.score?.home ?? ''}–${match.score?.away ?? ''}` : match.score ?? '';
  const matchLine = [match.home, score || 'vs', match.away].filter(Boolean).join(' ');
  await fs.writeFile(path.join(ctx.temp, 'cover-title.txt'), wrapped(title || matchLine, 26));
  await fs.writeFile(path.join(ctx.temp, 'cover-match.txt'), cleanText(matchLine));
  const filters = `drawbox=x=0:y=ih*0.60:w=iw:h=ih*0.40:color=black@0.70:t=fill,drawtext=fontfile=font.ttc:textfile=cover-title.txt:expansion=none:fontcolor=white:fontsize=${Math.max(12, Math.round(height * .055))}:line_spacing=8:x=w*0.05:y=h*0.65,drawtext=fontfile=font.ttc:textfile=cover-match.txt:expansion=none:fontcolor=white:fontsize=${Math.max(10, Math.round(height * .036))}:x=w*0.05:y=h*0.9`;
  await ffmpeg(ctx, ['-i', videoFile, '-vf', filters, '-frames:v', '1', '-update', '1', filename]);
  return {width, height};
}

async function commit(ctx, tempName, finalName) {
  const destination = path.join(ctx.outputDir, finalName);
  await fs.rename(path.join(ctx.temp, tempName), destination);
  return destination;
}

async function finish(ctx, kind, localVideo, duration, extras = {}) {
  const measured = await probe(path.join(ctx.temp, localVideo));
  if (!measured.hasAudio || measured.videoCodec !== 'h264' || measured.audioCodec !== 'aac')
    throw new Error(`Invalid ${kind} output: H.264 video and AAC audio are required`);
  if (measured.width !== ctx.config.width || measured.height !== ctx.config.height || Math.abs(measured.duration - duration) > Math.max(.15, 2 / ctx.config.fps))
    throw new Error(`Unexpected ${kind} output dimensions or duration`);
  const suffix = ctx.preview ? '.preview' : '';
  if (extras.audioMastering) {
    const report = {...extras.audioMastering, outputFile: `${kind}${suffix}.mp4`};
    await fs.writeFile(path.join(ctx.temp, `${kind}.loudness.json`), JSON.stringify(report, null, 2) + '\n');
    const reportPath = await commit(ctx, `${kind}.loudness.json`, `${kind}${suffix}.loudness.json`);
    extras = {...extras, audioMastering: {...report, reportPath}};
  }
  const title = ctx.job[kind]?.title;
  await cover(ctx, localVideo, title, `${kind}-cover.jpg`);
  const coverPath = await commit(ctx, `${kind}-cover.jpg`, `${kind}${suffix}.cover.jpg`);
  const videoPath = await commit(ctx, localVideo, `${kind}${suffix}.mp4`);
  return {path: videoPath, duration: measured.duration, width: measured.width, height: measured.height,
    hasAudio: true, coverPath, warnings: [...ctx.warnings], ...extras};
}

async function newsPlan(ctx) {
  const segments = ctx.job.news?.segments;
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('news.segments must not be empty');
  uniqueMap(segments, 'news.segments');
  const result = [], used = new Set();
  for (const segment of segments) {
    if (segment.mode && !['original', 'narration'].includes(segment.mode)) throw new Error(`Unsupported news segment mode: ${segment.mode}`);
    narrationOffsetSeconds(segment);
    const original = segment.mode === 'original';
    const clips = await clipsFor(ctx, segment.clipIds, {requireAudio: original});
    for (const clip of clips) {
      if (used.has(clip.id)) throw new Error(`News clip ${clip.id} is repeated; choose distinct plays instead of silently replaying an action`);
      used.add(clip.id);
    }
    let narration;
    if (!original) {
      if (!cleanText(segment.text)) throw new Error(`News segment ${segment.id} requires narration text`);
      if (!segment.audioPath) throw new Error(`News segment ${segment.id} is missing audioPath: generate real narration before rendering`);
      const file = path.resolve(ctx.jobDir, segment.audioPath), audio = await probe(file);
      if (!audio.hasAudio || !Number.isFinite(audio.audioDuration) || audio.audioDuration <= 0) throw new Error(`Invalid narration audio for ${segment.id}`);
      const parts = narrationParts(segment, audio.audioDuration);
      narration = {file, duration: audio.audioDuration, offset: parts[0].offset, parts};
    }
    result.push({segment, clips, narration});
  }
  return result;
}

async function renderNewsIn(ctx, plan) {
  const font = await installFont(ctx), files = [], cues = [], timings = [];
  let cursor = 0;
  for (let i = 0; i < plan.length; i++) {
    const {segment, clips, narration} = plan[i];
    const visual = await joinClips(ctx, clips, `news-${i}`);
    let duration = visual.duration, file = visual.file;
    if (narration) {
      const narrationEnd = Math.max(...narration.parts.map(part => part.offset + part.end - part.start));
      duration = Math.ceil(Math.max(visual.duration, narrationEnd) * ctx.config.fps - 1e-6) / ctx.config.fps;
      const freeze = Math.max(0, duration - visual.duration);
      if (freeze > .05) ctx.warnings.push(`News segment ${segment.id}: footage is ${freeze.toFixed(2)}s shorter than narration; the final frame is held, with no replay.`);
      if (visual.duration - narrationEnd > .1) ctx.warnings.push(`News segment ${segment.id}: complete plays continue for ${(visual.duration - narrationEnd).toFixed(2)}s after narration, with original audio restored.`);
      file = `news-${i}-mixed.mkv`;
      const windows = narration.parts.map(part => `gte(t,${part.offset})*lt(t,${part.offset + part.end - part.start})`).join('+');
      const voices = narration.parts.map((part, index) => `[1:a:0]atrim=start=${part.start}:end=${part.end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=${Math.round(part.offset * 48000)}S:all=1[voice${index}]`);
      const filters = `[0:v:0]tpad=stop_mode=clone:stop_duration=${freeze + 1 / ctx.config.fps},trim=duration=${duration},setpts=PTS-STARTPTS[v];` +
        `[0:a:0]volume='if(${windows},0.12,1)':eval=frame,apad,atrim=duration=${duration}[original];` +
        voices.join(';') + ';' +
        `[original]${narration.parts.map((_, index) => `[voice${index}]`).join('')}amix=inputs=${narration.parts.length + 1}:duration=longest:normalize=0,alimiter=limit=0.95:level=false:latency=true,atrim=duration=${duration}[a]`;
      await ffmpeg(ctx, ['-i', visual.file, '-i', narration.file, '-filter_complex', filters, '-map', '[v]', '-map', '[a]',
        ...encoding(ctx), '-c:a', 'pcm_s16le', '-t', String(duration), file]);
    }
    files.push(file);
    const segmentCues = narration ? narration.parts.flatMap(part => buildCaptionCues(part.text, cursor + part.offset, part.end - part.start)) :
      buildCaptionCues(segment.text, cursor, duration);
    if (segmentCues.some(cue => cue.end - cue.start < .65)) ctx.warnings.push(`News segment ${segment.id}: some estimated subtitle pages last under 0.65s; check narration density and subtitle timing.`);
    cues.push(...segmentCues);
    timings.push({id: segment.id, start: cursor, end: cursor + duration, narrationDuration: narration?.duration ?? null,
      narrationOffset: narration?.offset ?? 0, parts: narration?.parts ?? [], clipIds: segment.clipIds});
    cursor += duration;
  }
  await subtitles(ctx, cues, font);
  await fs.writeFile(path.join(ctx.temp, 'news.concat'), files.map(file => `file '${file}'`).join('\n') + '\n');
  await ffmpeg(ctx, ['-f', 'concat', '-safe', '1', '-i', 'news.concat', '-vf', 'ass=news.ass:fontsdir=.',
    '-map', '0:v:0', '-map', '0:a:0', ...encoding(ctx), '-c:a', 'pcm_s16le', '-t', String(cursor), 'news-unmastered.mkv']);
  const audioMastering = await masterFinalAudio(ctx, 'news-unmastered.mkv', 'news.mp4', cursor);
  const subtitlePath = await commit(ctx, 'news.srt', `news${ctx.preview ? '.preview' : ''}.srt`);
  return finish(ctx, 'news', 'news.mp4', cursor, {subtitlePath, segments: timings, audioMastering,
    captionTiming: 'estimated-within-measured-segment-audio', captions: cues});
}

async function renderHighlightsIn(ctx, clips) {
  await installFont(ctx);
  const visual = await joinClips(ctx, clips, 'highlights');
  const audioMastering = await masterFinalAudio(ctx, visual.file, 'highlights.mp4', visual.duration);
  return finish(ctx, 'highlights', 'highlights.mp4', visual.duration, {clipIds: clips.map(clip => clip.id), audioMastering});
}

/** Render full, verified plays in the supplied order, retaining original audio. */
export async function renderHighlights(args) {
  const ctx = await context(args);
  try { return await renderHighlightsIn(ctx, await clipsFor(ctx, ctx.job.highlights?.clipIds, {requireAudio: true})); }
  finally { await fs.rm(ctx.temp, {recursive: true, force: true}); }
}

/** Render narration from real audio files, and optional mode=original segments. */
export async function renderNews(args) {
  const ctx = await context(args);
  try { return await renderNewsIn(ctx, await newsPlan(ctx)); }
  finally { await fs.rm(ctx.temp, {recursive: true, force: true}); }
}

/** Render both editions. This function does not grant or infer review approval. */
export async function renderVideos(args) {
  const ctx = await context(args);
  try {
    const plan = await newsPlan(ctx);
    const clips = await clipsFor(ctx, ctx.job.highlights?.clipIds, {requireAudio: true});
    const news = await renderNewsIn(ctx, plan);
    const highlights = await renderHighlightsIn(ctx, clips);
    return {news, highlights, warnings: [...ctx.warnings]};
  } finally { await fs.rm(ctx.temp, {recursive: true, force: true}); }
}
