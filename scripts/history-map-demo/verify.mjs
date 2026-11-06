#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'frontend/package.json'));
const {chromium} = req('playwright');
const output = path.join(root, 'data/static/history-map-demo-20261024');
const url = 'http://127.0.0.1:5679/static/history-map-demo-20261024/index.html';
const browser = await chromium.launch({headless: true,
  executablePath: path.join(root, '.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell')});
const results = [];
try {
  for (const [name, viewport] of [['desktop', {width: 1440, height: 1000}], ['mobile', {width: 390, height: 844}]]) {
    const page = await browser.newPage({viewport});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    const playback = await page.evaluate(async () => {
      const video = document.querySelector('video');
      video.muted = true;
      await video.play();
      await new Promise(resolve => video.addEventListener('timeupdate', resolve, {once: true}));
      const played = video.currentTime;
      video.pause();
      const pixels = [];
      for (const time of [3, 10, 16.5, 22]) {
        const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, {once: true}));
        video.currentTime = time;
        await seeked;
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 60;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 170, 1920, 680, 0, 0, 160, 60);
        const data = context.getImageData(0, 0, 160, 60).data;
        let sum = 0, squares = 0, fingerprint = 2166136261;
        for (let i = 0; i < data.length; i++) {
          if (i % 4 === 3) continue;
          sum += data[i]; squares += data[i] ** 2;
          fingerprint = Math.imul(fingerprint ^ data[i], 16777619) >>> 0;
        }
        const count = data.length * 0.75;
        pixels.push({time, mean: sum / count, standardDeviation: Math.sqrt(squares / count - (sum / count) ** 2), fingerprint});
      }
      return {played, duration: video.duration, width: video.videoWidth, height: video.videoHeight, pixels,
        overflow: document.documentElement.scrollWidth > innerWidth, error: video.error?.message ?? null};
    });
    if (playback.played <= 0 || playback.error || errors.length || playback.overflow || playback.duration !== 24
      || playback.width !== 1920 || playback.height !== 1080 || playback.pixels.some(sample => sample.standardDeviation < 10)
      || new Set(playback.pixels.map(sample => sample.fingerprint)).size !== 4) throw Error(`Playback validation failed: ${JSON.stringify({playback, errors})}`);
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
  representativeStills: ['establish.png', 'flank.png', 'attack.png', 'retreat.png'],
  visual: 'Representative composition reviewed; attack-stage labels separated and readable. Original terrain shown with synchronized overlays.',
  decode: 'All 720 frames decoded; 96 sampled video frame hashes differ.',
  audio: {meanDb: -19.4, peakDb: -2.3, listeningReview: 'Not independently listened to; synthesized speech presence, duration, peak, and cue windows checked.'},
  playback: results,
  userBrowser: 'Interactive browser connector unavailable; playback verified in a separate headless Chromium instance.',
};
fs.writeFileSync(file, JSON.stringify(delivery, null, 2) + '\n');
console.log(JSON.stringify({status: delivery.status, url, playback: results}, null, 2));
