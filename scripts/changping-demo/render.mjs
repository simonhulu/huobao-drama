#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {changpingMap} from '../../remotion/src/changping-data.ts';
import {createAtlasMap} from '../../remotion/src/changping-atlas-data.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'remotion/package.json'));
const {bundle} = await import(req.resolve('@remotion/bundler'));
const {renderMedia, renderStill, selectComposition} = await import(req.resolve('@remotion/renderer'));
const atlas = process.argv.includes('--atlas');
const map = atlas ? createAtlasMap(changpingMap) : changpingMap;
const output = path.join(root, 'data/static', atlas ? 'changping-demo-v2-20261024' : 'changping-demo-20261024');
const mode = process.argv[2] ?? 'all';
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {encoding: 'utf8'}));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(output, {recursive: true});
save(path.join(output, 'history-and-map-data.json'), map);

const browserExecutable = path.join(root, '.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const serveUrl = await bundle({entryPoint: path.join(root, atlas ? 'remotion/src/changping-atlas-entry.tsx' : 'remotion/src/changping-demo-entry.tsx'), rootDir: path.join(root, 'remotion'),
  publicDir: path.join(root, 'remotion/public'), outDir: path.join(output, 'bundle')});
const composition = await selectComposition({serveUrl, id: atlas ? 'ChangpingAtlasDemo' : 'ChangpingControlDemo', browserExecutable});
if (mode === 'stills' || mode === 'all') {
  for (const [name, second] of [['transfer', 7.5], ['front', 16], ['sortie', 24], ['encirclement', 34], ['aftermath', 44]]) {
    await renderStill({serveUrl, composition, browserExecutable, frame: Math.round(second * 30), imageFormat: 'png', output: path.join(output, `${name}.png`)});
    console.log(`still ${name} ${second}s`);
  }
}
if (mode === 'stills') process.exit(0);

const narration = map.stages.map((stage, index) => {
  const file = path.join(output, `narration-${index + 1}.aiff`);
  const previous = path.join(root, 'data/static/changping-demo-20261024', `narration-${index + 1}.aiff`);
  if (atlas && !fs.existsSync(file) && fs.existsSync(previous)) fs.copyFileSync(previous, file);
  if (!fs.existsSync(file)) execFileSync('say', ['-v', 'Tingting', '-r', '205', '-o', file, stage.narration]);
  const duration = Number(probe(file).format.duration);
  return {file, text: stage.narration, start: stage.start + .65, duration, speed: Math.max(1, duration / 7.9)};
});
save(path.join(output, 'narration.json'), {source: 'Local macOS Tingting temporary Mandarin narration', cues: narration});
const dry = path.join(output, 'changping-dry.mp4');
if (fs.existsSync(dry)) throw Error('Refuse to overwrite existing MP4; use a new output directory for another version.');
let last = -1;
await renderMedia({serveUrl, composition, browserExecutable, outputLocation: dry,
  codec: 'h264', crf: 24, x264Preset: 'slow', hardwareAcceleration: 'disable', pixelFormat: 'yuv420p',
  encodingMaxRate: '2000k', encodingBufferSize: '4000k', gopSize: 150, muted: true,
  imageFormat: 'jpeg', jpegQuality: 95, concurrency: 3,
  onProgress: event => {const p = Math.floor(event.progress * 100); if (p >= last + 10) {console.log(`render ${p}%`); last = p;}}});
const filters = narration.map((cue, i) => `[${i + 1}:a]atempo=${cue.speed.toFixed(5)},volume=1.1,adelay=${Math.round(cue.start * 1000)}:all=1[a${i}]`);
filters.push(`${narration.map((_, i) => `[a${i}]`).join('')}amix=inputs=5:duration=longest:normalize=0,apad,atrim=duration=45,alimiter=limit=0.9:level=false[mix]`);
const movie = path.join(output, '长平之战-秦赵势力消长.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-n', '-i', dry, ...narration.flatMap(cue => ['-i', cue.file]),
  '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', movie]);
const media = probe(movie), video = media.streams.find(stream => stream.codec_type === 'video'), bytes = fs.statSync(movie).size;
if (video.width !== 1920 || video.height !== 1080 || video.r_frame_rate !== '30/1' || Number(video.nb_frames) !== 1350
  || media.streams.filter(stream => stream.codec_type === 'audio').length !== 1 || Math.abs(Number(media.format.duration) - 45) > .1) throw Error('Media verification failed');
if (bytes > 17e6 * 45 / 60 + 500000) throw Error('Output exceeds upload size budget');
save(path.join(output, 'delivery.json'), {status: 'rendered-awaiting-visual-review', movie, sha256: hash(movie), bytes,
  duration: Number(media.format.duration), width: 1920, height: 1080, fps: 30, frames: 1350,
  renderer: `Remotion ${req('@remotion/renderer/package.json').version}`, terrainSha256: hash(path.join(root, atlas ? 'remotion/public/changping-demo-v2/terrain.png' : 'remotion/public/changping-demo/relief.png')),
  map: {historyStatus: map.historyStatus, geometryNote: map.geometryNote, anchorNote: map.anchorNote},
  ...(atlas ? {geographySha256: hash(path.join(root, 'remotion/public/changping-demo-v2/geographic-data.json')),
    atlasSha256: hash(path.join(root, 'remotion/public/changping-demo-v2/warring-states-260bce.jpg')),
    atlasLicense: {creator: 'Philg88', license: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/',
      modification: 'Reduced overview displayed alongside a newly rendered geographic animation.',
      original: 'https://commons.wikimedia.org/wiki/File:EN-WarringStatesAll260BCE.jpg',
      downloadedFrom: 'https://textimgs.s3.amazonaws.com/boundless-world-history/7mx6nxtws92ubzub3pwz.jpe'}} : {}),
  sources: map.sources, narration: 'Temporary synthesized Mandarin; no external voice API',
  historicalLimits: ['Schematic local control, not exact Qin/Zhao national borders or measured area shares.',
    'Zhao sortie is striped transient battlefield control, not annexation.', 'Postwar Shangdang consolidation is explicitly separated from the September battle defeat.',
    'Zhao homeland and Handan retain blue in the final stage; the state was not destroyed at Changping.'],
  encoding: {codec: 'h264', crf: 24, preset: 'slow', maxRate: '2000k', audioTarget: 'AAC 128k'}});
console.log(JSON.stringify({movie, bytes, duration: 45, frames: 1350}));
