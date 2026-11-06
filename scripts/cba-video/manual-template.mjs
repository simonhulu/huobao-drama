import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({stdout, stderr}) : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)));
  });
}

async function probe(file) {
  const {stdout} = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], path.dirname(file));
  const data = JSON.parse(stdout);
  const video = data.streams.find(stream => stream.codec_type === 'video');
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  return {duration: Number(data.format.duration), width: video?.width, height: video?.height, fps: video?.r_frame_rate,
    hasAudio: Boolean(audio), hasVideo: Boolean(video), audioCodec: audio?.codec_name, videoCodec: video?.codec_name};
}

function safeName(value, fallback) {
  const name = String(value || fallback).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return name || fallback;
}

function uniqueMap(values, name) {
  const map = new Map();
  for (const item of values || []) {
    if (!item?.id || map.has(item.id)) throw new Error(`${name} requires unique IDs`);
    map.set(item.id, item);
  }
  return map;
}

function config(job) {
  const width = Number(job.profile?.width || 1920), height = Number(job.profile?.height || 1080), fps = Number(job.profile?.fps || 30);
  if (![width, height, fps].every(Number.isFinite) || width <= 0 || height <= 0 || fps <= 0) throw new Error('Invalid CBA output profile');
  return {width, height, fps};
}

async function renderClip({clip, media, output, config: settings}) {
  const duration = Math.max(1 / settings.fps, Math.ceil((clip.end - clip.start) * settings.fps - 1e-6) / settings.fps);
  const video = `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${settings.fps},tpad=stop_mode=clone:stop_duration=${1 / settings.fps},trim=duration=${duration},setpts=PTS-STARTPTS`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y', '-ss', String(clip.start), '-i', media.path,
    '-map', '0:v:0', '-vf', video, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '0',
    '-movflags', '+faststart', '-t', String(duration), output], path.dirname(output));
  return duration;
}

async function copyAudio(source, destination) {
  await fs.mkdir(path.dirname(destination), {recursive: true});
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y', '-i', source, '-map', '0:a:0', '-vn', '-c:a', 'copy', destination], path.dirname(destination));
}

async function extractVideoTrack(source, destination) {
  await fs.mkdir(path.dirname(destination), {recursive: true});
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y', '-i', source, '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart', destination], path.dirname(destination));
}

async function copyFile(source, destination) {
  await fs.mkdir(path.dirname(destination), {recursive: true});
  await fs.copyFile(source, destination);
}

function outputClipIds(job, kind) {
  if (kind === 'highlights') return job.outputs?.highlights?.clipIds || job.highlights?.clipIds || [];
  return (job.outputs?.news?.segments || []).flatMap(segment => segment.clipIds || []);
}

async function buildEdition({kind, job, output, packageRoot, clipFiles}) {
  const editionRoot = path.join(packageRoot, kind), segments = [];
  if (kind === 'news') {
    for (let index = 0; index < output.segments.length; index++) {
      const timing = output.segments[index], sourceSegment = (job.news.segments || []).find(item => item.id === timing.id) || {};
      const duration = Number(timing.end) - Number(timing.start);
      const parts = (timing.clipIds || sourceSegment.clipIds || []).map(id => clipFiles.get(id)).filter(Boolean);
      if (!(duration > 0) || !parts.length) throw new Error(`Rendered news segment ${timing.id} has no editable clips or duration`);
      segments.push({index: index + 1, id: timing.id, mode: sourceSegment.mode || 'narration', text: sourceSegment.text || '', start: timing.start, end: timing.end,
        duration, clipIds: timing.clipIds || sourceSegment.clipIds || []});
    }
  } else {
    let cursor = 0;
    for (let index = 0; index < outputClipIds(job, kind).length; index++) {
      const id = outputClipIds(job, kind)[index], part = clipFiles.get(id);
      if (!part) throw new Error(`Rendered highlights clip ${id} is unavailable`);
      segments.push({index: index + 1, id, mode: 'original', text: '', start: cursor, end: cursor + part.duration, duration: part.duration, clipIds: [id]});
      cursor += part.duration;
    }
  }
  const trackPath = path.join(editionRoot, 'video-track.mp4');
  await extractVideoTrack(output.path, trackPath);
  const audioPath = path.join(editionRoot, 'audio.m4a');
  await copyAudio(output.path, audioPath);
  const audioProbe = await probe(audioPath), videoProbe = await probe(trackPath);
  const edition = {video: 'video-track.mp4', audio: 'audio.m4a', reference: 'video-track.mp4', duration: Number(output.duration), segments,
    verified: {videoTrack: {duration: videoProbe.duration, width: videoProbe.width, height: videoProbe.height, hasAudio: videoProbe.hasAudio}, audioTrack: {duration: audioProbe.duration, codec: audioProbe.audioCodec}}};
  if (kind === 'news') {
    await copyFile(output.subtitlePath, path.join(editionRoot, 'subtitles.srt'));
    edition.subtitles = 'subtitles.srt';
  }
  return edition;
}

/** Build the two editable CBA editions from the persisted delivery inputs. */
export async function buildManualTemplate({job, jobDir, outputDir, zipPath}) {
  const settings = config(job), editions = ['news', 'highlights'].filter(kind => job.outputs?.[kind]?.path);
  if (!editions.length || !job.outputs?.news?.subtitlePath) throw new Error('新闻成片缺少可导出的时间轴、音频或字幕');
  const media = uniqueMap(job.media, 'media'), clips = uniqueMap(job.clips, 'clips'), packageRoot = path.resolve(outputDir);
  await fs.rm(packageRoot, {recursive: true, force: true});
  await fs.mkdir(path.join(packageRoot, 'clips'), {recursive: true});
  const usedIds = [...new Set(editions.flatMap(kind => outputClipIds(job, kind)))], clipFiles = new Map(), clipManifest = [];
  for (const id of usedIds) {
    const clip = clips.get(id), source = clip && media.get(clip.mediaId);
    if (!clip || !source?.path) throw new Error(`Rendered clip ${id} is unavailable`);
    const filename = `${safeName(id, 'clip')}.mp4`, destination = path.join(packageRoot, 'clips', filename);
    const duration = await renderClip({clip, media: {...source, path: path.resolve(jobDir, source.path)}, output: destination, config: settings});
    clipFiles.set(id, {path: destination, duration});
    clipManifest.push({id, mediaId: clip.mediaId, sourceStart: clip.start, sourceEnd: clip.end, duration, path: `clips/${filename}`});
  }
  const delivery = {};
  for (const kind of editions) {
    if (!job.outputs[kind].segments && kind === 'news') throw new Error('新闻成片缺少时间轴');
    delivery[kind] = await buildEdition({kind, job, output: job.outputs[kind], packageRoot, clipFiles});
  }
  const manifest = {version: 1, kind: 'cba-manual-edit-template', match: job.match, sourceDigest: job.outputs.inputDigest, profile: settings, clips: clipManifest, editions: delivery,
    instruction: '要复现自动成片：导入对应版本的 video-track.mp4 和 audio.m4a，保持音频从 00:00:00 开始并静音视频轨，不要再次叠加 subtitles.srt。要做手动实验：按时间轴清单使用 clips/ 中的片段，再导入新闻版 subtitles.srt。'};
  await fs.writeFile(path.join(packageRoot, 'timeline.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(packageRoot, 'README.txt'), [
    'CBA manual edit template', '',
    'The package contains only clips used by the two delivered editions: news and highlights.',
    'For an exact reproduction, import the edition video-track.mp4 and audio.m4a, mute the video track, and keep audio at the start. Do not add subtitles.srt because the exact picture track already contains the automatic captions.',
    'For a manual experiment, assemble clips/ according to timeline.json and use news/subtitles.srt as the editable caption source. The manual caption renderer may look different from the automatic render.',
    'timeline.json records exact segment boundaries and source ranges.', '',
    'Tracks are copied or rendered from the same persisted delivery inputs as the automatic output.',
  ].join('\n') + '\n', 'utf8');
  await fs.mkdir(path.dirname(zipPath), {recursive: true});
  await fs.rm(zipPath, {force: true});
  await run('zip', ['-q', '-r', zipPath, '.'], packageRoot);
  return {path: zipPath, filename: path.basename(zipPath), manifest};
}
