#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'remotion/package.json'));
const {bundle} = await import(req.resolve('@remotion/bundler'));
const {renderMedia, renderStill, selectComposition} = await import(req.resolve('@remotion/renderer'));
const output = path.join(root, 'data/static/history-map-demo-20261024');
const publicDir = path.join(root, 'remotion/public');
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {encoding: 'utf8'}));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(output, {recursive: true});

const scenePath = path.join(publicDir, 'history-map-demo/scene.json');
const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
for (const [name, points] of Object.entries(scene.routes)) {
  if (points.length < 2 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw Error(`Invalid route ${name}`);
}
const inputProps = {scene};
save(path.join(output, 'props.json'), inputProps);
const browserExecutable = path.join(root, '.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const serveUrl = await bundle({entryPoint: path.join(root, 'remotion/src/history-map-demo-entry.tsx'),
  rootDir: path.join(root, 'remotion'), publicDir, outDir: path.join(output, 'bundle')});
const composition = await selectComposition({serveUrl, id: 'HistoryMapDemo', browserExecutable, inputProps});
const mode = process.argv[2] ?? 'all';

if (mode === 'stills' || mode === 'all') {
  for (const [name, frame] of [['establish', 90], ['flank', 300], ['attack', 495], ['retreat', 660]]) {
    await renderStill({serveUrl, composition, browserExecutable, inputProps, frame,
      output: path.join(output, `${name}.png`), imageFormat: 'png'});
    console.log(`still ${name} ${frame}`);
  }
}
if (mode === 'stills') process.exit(0);

const cues = [
  {start: 0.65, text: '两军隔河对峙，中央隘口扼住通道。'},
  {start: 6.2, text: '红军正面牵制，另一支部队沿北侧山路绕行。'},
  {start: 12.6, text: '侧翼抵达。两路同时压上，蓝军腹背受敌。'},
  {start: 18.5, text: '退路受到威胁，蓝军撤离河谷。夹击完成。'},
];
const narration = cues.map((cue, index) => {
  const file = path.join(output, `voice-${index + 1}.aiff`);
  if (!fs.existsSync(file)) execFileSync('say', ['-v', 'Tingting', '-r', '210', '-o', file, cue.text]);
  const duration = Number(probe(file).format.duration);
  const window = (cues[index + 1]?.start ?? 23.8) - cue.start - 0.15;
  const speed = Math.max(1, duration / window);
  return {...cue, file, duration, speed};
});
save(path.join(output, 'narration.json'), {source: 'macOS local Tingting text-to-speech; temporary demonstration narration', cues: narration});
const dry = path.join(output, 'map-demo-dry.mp4');
if (fs.existsSync(dry)) throw Error('Refuse to overwrite existing video. Use a new output version or preserve it before rerendering.');
let lastProgress = -1;
await renderMedia({serveUrl, composition, browserExecutable, inputProps, outputLocation: dry,
  codec: 'h264', crf: 24, x264Preset: 'slow', hardwareAcceleration: 'disable',
  encodingMaxRate: '2000k', encodingBufferSize: '4000k', gopSize: 150, pixelFormat: 'yuv420p',
  muted: true, concurrency: 3, imageFormat: 'jpeg', jpegQuality: 95,
  onProgress: event => {const p = Math.floor(event.progress * 100); if (p >= lastProgress + 10) {console.log(`render ${p}%`); lastProgress = p;}}});

const filters = narration.map((cue, index) => `[${index + 1}:a]atempo=${cue.speed.toFixed(5)},volume=1.1,adelay=${Math.round(cue.start * 1000)}:all=1[a${index}]`);
filters.push(`${narration.map((_, index) => `[a${index}]`).join('')}amix=inputs=4:duration=longest:normalize=0,apad,atrim=duration=24,alimiter=limit=0.9:level=false[mix]`);
const movie = path.join(output, '峡谷夹击-地图推演样片.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-n', '-i', dry,
  ...narration.flatMap(cue => ['-i', cue.file]), '-filter_complex', filters.join(';'),
  '-map', '0:v:0', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', movie]);
const media = probe(movie), video = media.streams.find(stream => stream.codec_type === 'video');
const bytes = fs.statSync(movie).size;
if (video.width !== 1920 || video.height !== 1080 || video.r_frame_rate !== '30/1' || Number(video.nb_frames) !== 720
  || media.streams.filter(stream => stream.codec_type === 'audio').length !== 1 || Math.abs(Number(media.format.duration) - 24) > 0.1) throw Error('Media contract failed');
if (bytes > 17 * 1_000_000 * 24 / 60 + 500_000) throw Error('Delivery exceeds size budget');
save(path.join(output, 'delivery.json'), {status: 'rendered-awaiting-visual-review', movie, sha256: hash(movie),
  duration: Number(media.format.duration), frames: Number(video.nb_frames), width: video.width, height: video.height,
  fps: video.r_frame_rate, bytes, sceneSha256: hash(scenePath), terrainSha256: hash(path.join(publicDir, 'history-map-demo/terrain.png')),
  renderer: `Remotion ${req('@remotion/renderer/package.json').version}`, terrain: 'Original fictional Blender-generated terrain plate; fixed camera, synchronized projected 2D routes and army markers',
  encoding: {codec: 'h264', crf: 24, preset: 'slow', maxRate: '2000k', audio: 'AAC 128k'},
  narration: 'Local synthesized Mandarin demo voice; no music or third-party sound effects',
  reproduction: ['blender --background --factory-startup --python scripts/history-map-demo/build_terrain.py', 'node scripts/history-map-demo/render.mjs all']});
console.log(JSON.stringify({movie, bytes, duration: media.format.duration, frames: video.nb_frames}));
