#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync, spawnSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'frontend/package.json'));
const {chromium} = req('playwright');
const atlas = process.argv.includes('--atlas');
const directory = atlas ? 'changping-demo-v2-20261024' : 'changping-demo-20261024';
const output = path.join(root, 'data/static', directory);
const movie = path.join(output, '长平之战-秦赵势力消长.mp4');
const url = `http://127.0.0.1:${atlas ? 5680 : 5679}/static/${directory}/index.html`;
const decode = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
  '-show_entries', 'stream=nb_read_frames', '-of', 'json', movie], {encoding: 'utf8'}));
if (Number(decode.streams[0].nb_read_frames) !== 1350) throw Error('Incomplete video decode');
const audioProcess = spawnSync('ffmpeg', ['-hide_banner', '-i', movie, '-map', '0:a:0', '-af', 'volumedetect', '-vn', '-f', 'null', '-'], {encoding: 'utf8'});
const meanDb = Number(audioProcess.stderr.match(/mean_volume: ([-\d.]+) dB/)?.[1]);
const peakDb = Number(audioProcess.stderr.match(/max_volume: ([-\d.]+) dB/)?.[1]);
if (audioProcess.status !== 0 || !Number.isFinite(meanDb) || meanDb < -40 || !Number.isFinite(peakDb) || peakDb >= 0) throw Error('Audio signal check failed');
const narration = JSON.parse(fs.readFileSync(path.join(output, 'narration.json'), 'utf8'));
if (narration.cues.some((cue, i) => cue.start + cue.duration / cue.speed > (i + 1) * 9)) throw Error('Narration crosses a stage boundary');

const browser = await chromium.launch({headless: true,
  executablePath: path.join(root, '.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell')});
const results = [];
try {
  for (const [name, viewport] of [['desktop', {width: 1440, height: 1000}], ['mobile', {width: 390, height: 844}]]) {
    const page = await browser.newPage({viewport});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(url);
    if (response.status() !== 200) throw Error('Review page unavailable');
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    const playback = await page.evaluate(async (mapWidth) => {
      const video = document.querySelector('video');
      video.muted = true;
      await video.play();
      await new Promise(resolve => video.addEventListener('timeupdate', resolve, {once: true}));
      const played = video.currentTime;
      video.pause();
      const pixels = [];
      for (const time of [7.5, 16, 24, 34, 44]) {
        const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, {once: true}));
        video.currentTime = time;
        await seeked;
        const presented = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error(`No presented frame at ${time}s; current time ${video.currentTime}`)), 10000);
          const next = (_, metadata) => {
            if (Math.abs(metadata.mediaTime - time) < .5) {clearTimeout(timeout); resolve(metadata.mediaTime);}
            else video.requestVideoFrameCallback(next);
          };
          video.requestVideoFrameCallback(next);
        });
        await video.play();
        const mediaTime = await presented;
        video.pause();
        const canvas = document.createElement('canvas');
        canvas.width = 192; canvas.height = 75;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 130, mapWidth, 752, 0, 0, 192, 75);
        const data = context.getImageData(0, 0, 192, 75).data;
        let sum = 0, squares = 0, red = 0, blue = 0, fingerprint = 2166136261;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > data[i + 2] + 25 && data[i] > data[i + 1] + 15) red++;
          if (data[i + 2] > data[i] + 20 && data[i + 2] > data[i + 1]) blue++;
          for (let channel = 0; channel < 3; channel++) {
            sum += data[i + channel]; squares += data[i + channel] ** 2;
            fingerprint = Math.imul(fingerprint ^ data[i + channel], 16777619) >>> 0;
          }
        }
        const count = data.length * .75;
        pixels.push({time, mediaTime, standardDeviation: Math.sqrt(squares / count - (sum / count) ** 2), redPixels: red, bluePixels: blue, fingerprint});
      }
      return {played, duration: video.duration, width: video.videoWidth, height: video.videoHeight, pixels,
        overflow: document.documentElement.scrollWidth > innerWidth, error: video.error?.message ?? null};
    }, atlas ? 1380 : 1920);
    if (playback.played <= 0 || playback.error || errors.length || playback.overflow || playback.duration !== 45
      || playback.width !== 1920 || playback.height !== 1080 || playback.pixels.some(sample => sample.standardDeviation < 10)
      || new Set(playback.pixels.map(sample => sample.fingerprint)).size !== 5
      || playback.pixels[4].redPixels <= playback.pixels[0].redPixels
      || playback.pixels[4].bluePixels >= playback.pixels[0].bluePixels) throw Error(`Playback validation failed: ${JSON.stringify({playback, errors})}`);
    await page.screenshot({path: path.join(output, `playback-${name}.png`), fullPage: true});
    results.push({viewport: name, ...playback, errors});
    await page.close();
  }
} finally {
  await browser.close();
}

const file = path.join(output, 'delivery.json');
const delivery = JSON.parse(fs.readFileSync(file, 'utf8'));
delivery.status = 'validated';
delivery.review = {
  representativeStills: ['transfer.png', 'front.png', 'sortie.png', 'encirclement.png', 'aftermath.png'],
  visual: atlas ? 'Real DEM relief, rivers/city context and independently credited historic overview inspected; overview boundaries/cities visible, modern labels separated, controls remain schematic.' : 'Encirclement and postwar composition inspected; labels separated, peripheral labels hidden during zoom, overlapping control fills removed.',
  decode: {framesDecoded: 1350},
  audio: {meanDb, peakDb, stageBoundariesChecked: true, listeningReview: 'Not independently listened to; synthesized speech signal, level, duration and cue windows checked.'},
  playback: results,
  browser: 'Separate headless Chromium; native interactive browser connector unavailable.',
};
fs.writeFileSync(file, JSON.stringify(delivery, null, 2) + '\n');
console.log(JSON.stringify({status: delivery.status, url, audio: delivery.review.audio, playback: results}, null, 2));
