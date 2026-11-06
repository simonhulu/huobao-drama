import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildCaptionCues, narrationParts, renderVideos, renderNews, renderHighlights} from './render.mjs';
import {renderInputDigest} from './cli.mjs';
import {fileHash} from './core.mjs';

const exec = promisify(execFile);
const options = {width: 320, height: 180, fps: 10, preset: 'ultrafast', crf: 18};
let directory, job;

async function command(name, args, binary = false) {
  const result = await exec(name, args, {encoding: binary ? 'buffer' : 'utf8', maxBuffer: 8 * 1024 * 1024});
  return result.stdout;
}

async function ffmpeg(args, binary = false) {
  return command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], binary);
}

async function probe(file) {
  return JSON.parse(await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}

async function measuredLoudness(file) {
  const {stderr} = await exec('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-vn',
    '-af', 'loudnorm=I=-16:TP=-2:LRA=11:print_format=json', '-f', 'null', '-'], {maxBuffer: 8 * 1024 * 1024});
  const raw = JSON.parse(stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0] || '{}');
  // output_i is the analysis filter's hypothetical normalization, not the file.
  return {input_i: Number(raw.input_i), input_tp: Number(raw.input_tp)};
}

async function rgb(file, time = .2) {
  const seek = /\.(jpg|png)$/i.test(file) ? [] : ['-ss', String(time)];
  return ffmpeg([...seek, '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], true);
}

function pixel(bytes, x, y, width = 320) {
  const offset = (y * width + x) * 3;
  return [...bytes.subarray(offset, offset + 3)];
}

async function tone(file, time, frequency) {
  const data = await ffmpeg(['-ss', String(time), '-i', file, '-t', '0.2', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], true);
  let real = 0, imaginary = 0;
  for (let i = 0; i < data.length / 2; i++) {
    const value = data.readInt16LE(i * 2) / 32768;
    real += value * Math.cos(2 * Math.PI * frequency * i / 8000);
    imaginary += value * Math.sin(2 * Math.PI * frequency * i / 8000);
  }
  return Math.hypot(real, imaginary) / (data.length / 2);
}

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cba-render-test-'));
  const red = path.join(directory, "red ' 中文 $(not-a-command).mp4");
  const blue = path.join(directory, 'blue.mp4');
  for (const [file, color, frequency] of [[red, 'red', 440], [blue, 'blue', 880]]) {
    await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=10:d=1.2`,
      '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=1.2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  }
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1100:sample_rate=48000:duration=1.2', path.join(directory, 'voice.wav')]);
  await ffmpeg(['-i', blue, '-an', '-c:v', 'copy', path.join(directory, 'silent.mp4')]);
  job = {
    match: {id: 'fixture', date: '2026-01-01', league: 'CBA', home: '广东', away: '南京', score: '95–96'},
    media: [{id: 'red', path: red}, {id: 'blue', path: blue}],
    clips: [
      {id: 'play-a', mediaId: 'red', start: .1, end: .7, label: '第一回合', verified: true},
      {id: 'play-b', mediaId: 'blue', start: .2, end: .8, label: '第二回合', verified: true},
    ],
    news: {title: '广东惜败南京 %{localtime}', summary: '', segments: [
      {id: 'intro', text: '广东最后一攻未能命中。', factIds: [], clipIds: ['play-a'], audioPath: 'voice.wav'},
      {id: 'original', mode: 'original', text: '', clipIds: ['play-b']},
    ]},
    highlights: {title: '全场精彩回合', clipIds: ['play-a', 'play-b']},
    sources: [],
  };
});

after(async () => { if (directory) await fs.rm(directory, {recursive: true, force: true}); });

test('renders H.264/AAC 16:9 editions with real audio, Chinese subtitles, still-frame warning, and original play order', async () => {
  const outputDir = path.join(directory, "output ' 中文");
  const result = await renderVideos({job, jobDir: directory, outputDir, options});
  for (const video of [result.news, result.highlights]) {
    const data = await probe(video.path);
    assert.equal(data.streams.find(stream => stream.codec_type === 'video').codec_name, 'h264');
    assert.equal(data.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
    assert.equal(video.width / video.height, 16 / 9);
    assert.equal(video.width, 320);
    assert.ok((await fs.stat(video.coverPath)).size > 100);
  }
  assert.ok(Math.abs(result.news.duration - 1.8) < .1, result.news.duration);
  assert.ok(Math.abs(result.highlights.duration - 1.2) < .1, result.highlights.duration);
  assert.ok(result.warnings.some(warning => warning.includes('final frame is held')));
  assert.deepEqual(result.highlights.clipIds, ['play-a', 'play-b']);
  const srt = await fs.readFile(result.news.subtitlePath, 'utf8');
  assert.match(srt, /00:00:00,000 --> 00:00:01,200/);
  assert.match(srt, /广东最后一攻未能命中/);
  assert.equal(result.news.captionTiming, 'estimated-within-measured-segment-audio');

  const first = await rgb(result.highlights.path, .2), second = await rgb(result.highlights.path, .8);
  assert.ok(pixel(first, 160, 20)[0] > 200, 'first play must retain red source');
  assert.ok(pixel(second, 160, 20)[2] > 200, 'second play must retain blue source');
  const freeze = await rgb(result.news.path, .9);
  assert.ok(pixel(freeze, 160, 20)[0] > 200, 'narration tail must hold the final red frame');
  const captioned = await rgb(result.news.path, .2);
  let whitePixels = 0;
  for (let y = 130; y < 180; y++) for (let x = 20; x < 300; x++) {
    if (pixel(captioned, x, y).every(channel => channel > 170)) whitePixels++;
  }
  assert.ok(whitePixels > 25, 'Chinese subtitles must be burned into the news image');
  const cover = await rgb(result.news.coverPath, 0);
  assert.ok(pixel(cover, 160, 20)[0] > 200, `cover must use an actual source frame: ${pixel(cover, 160, 20)} (${cover.length} bytes)`);

  assert.ok(await tone(result.highlights.path, .1, 440) > .02, 'first original commentary must remain audible');
  assert.ok(await tone(result.highlights.path, .8, 880) > .02, 'second original commentary must remain audible');
  const voice = await tone(result.news.path, .1, 1100), background = await tone(result.news.path, .1, 440);
  assert.ok(voice > background * 4, 'original audio must duck during narration');
  assert.ok(await tone(result.news.path, .9, 1100) > .02, 'narration must continue through the held frame');
  assert.ok(await tone(result.news.path, 1.4, 880) > .02, 'original-mode segment must preserve commentary');
  assert.ok(!(await fs.readdir(outputDir)).some(name => name.startsWith('.render-')), 'temporary files must be cleaned');
});

test('keeps a complete play when narration ends earlier and restores original audio', async () => {
  const shortAudio = path.join(directory, 'short.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1100:sample_rate=48000:duration=0.3', shortAudio]);
  const shortJob = structuredClone(job);
  shortJob.news.segments = [{...shortJob.news.segments[0], audioPath: shortAudio}];
  const result = await renderNews({job: shortJob, jobDir: directory, outputDir: path.join(directory, 'short-voice'), preview: true, options});
  assert.ok(result.path.endsWith('news.preview.mp4'));
  assert.ok(Math.abs(result.duration - .6) < .1);
  assert.ok(result.warnings.some(warning => warning.includes('original audio restored')));
  assert.match(await fs.readFile(result.subtitlePath, 'utf8'), /00:00:00,300/);
  assert.ok(await tone(result.path, .35, 440) > .02, 'commentary must return after narration');
});

test('both final editions master loud source audio and measure the encoded AAC file', async () => {
  const loudSource = path.join(directory, 'loud-source.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=10:d=8',
    '-f', 'lavfi', '-i', 'aevalsrc=0.8*sin(2*PI*997*t)+0.15*sin(2*PI*7013*t):s=48000:d=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', loudSource]);
  const original = await measuredLoudness(loudSource);
  assert.ok(original.input_i > -12, `fixture must reproduce an excessively loud source: ${original.input_i}`);
  const loudJob = structuredClone(job);
  loudJob.media = [{id: 'loud', path: loudSource}];
  loudJob.clips = [
    {id: 'play-a', mediaId: 'loud', start: 0, end: 4, verified: true},
    {id: 'play-b', mediaId: 'loud', start: 4, end: 8, verified: true},
  ];
  const result = await renderVideos({job: loudJob, jobDir: directory, outputDir: path.join(directory, 'mastered'), options});
  for (const video of [result.news, result.highlights]) {
    const actual = await measuredLoudness(video.path);
    assert.ok(Math.abs(actual.input_i - (-16)) <= 1, `actual encoded-file loudness must be -16±1 LUFS, got ${actual.input_i}`);
    assert.ok(actual.input_tp <= -1, `actual encoded-file true peak must be <= -1 dBTP, got ${actual.input_tp}`);
    assert.ok(Math.abs(video.duration - 8) < .1, 'mastering must retain the complete edit duration');
    assert.equal(video.audioMastering.method, 'two-pass-loudnorm');
    assert.equal(video.audioMastering.after.input_i, actual.input_i);
    assert.equal(video.audioMastering.after.input_tp, actual.input_tp);
    const saved = JSON.parse(await fs.readFile(video.audioMastering.reportPath, 'utf8'));
    assert.deepEqual(saved.after, video.audioMastering.after);
    assert.equal(saved.outputSha256.length, 64);
    assert.equal(saved.verified, true);
  }
});

test('a short dynamic track corrects measured AAC loudness once without re-editing video', async () => {
  const source=path.join(directory,'short-dynamic-source.mkv');
  await ffmpeg(['-f','lavfi','-i','color=c=blue:s=320x180:r=10:d=4',
    '-f','lavfi','-i',"aevalsrc='0.7*sin(2*PI*997*t)*if(gt(t,3),1,0.1)':s=48000:d=4",
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','pcm_s16le','-shortest',source]);
  const dynamic=structuredClone(job);
  dynamic.media=[{id:'dynamic',path:source}];
  dynamic.clips=[{id:'dynamic-play',mediaId:'dynamic',start:0,end:4,verified:true}];
  dynamic.highlights.clipIds=['dynamic-play'];
  const result=await renderHighlights({job:dynamic,jobDir:directory,outputDir:path.join(directory,'dynamic-correction'),options});
  const actual=await measuredLoudness(result.path), report=result.audioMastering;
  assert.ok(Math.abs(report.correction.before.input_i+16)>1,'fixture must require encoded-AAC correction');
  assert.equal(report.correction.method,'measured-volume-gain');
  assert.ok(report.correction.gainDb>0,'the short tail fixture must need a measured volume increase');
  assert.ok(report.correction.gainDb<=report.correction.maximumGainDb,'gain cannot exceed measured peak headroom');
  assert.ok(Math.abs(actual.input_i+16)<=1,`final AAC must meet unchanged -16±1 LUFS: ${actual.input_i}`);
  assert.ok(actual.input_tp<=-1,`final AAC must meet unchanged peak limit: ${actual.input_tp}`);
  assert.equal(report.after.input_i,actual.input_i);assert.equal(report.after.input_tp,actual.input_tp);
  assert.equal(report.outputSha256,await fileHash(result.path));
  assert.equal(report.video,'stream-copy');assert.equal(report.method,'two-pass-loudnorm');
  assert.ok(Math.abs(result.duration-4)<.1,'gain correction must preserve the reviewed cut length');
  assert.ok(pixel(await rgb(result.path,3.7),160,20)[2]>200,'gain correction must preserve the final video frames');
  const saved=JSON.parse(await fs.readFile(report.reportPath,'utf8'));
  assert.deepEqual(saved.correction,report.correction);assert.equal(saved.verified,true);
});

test('long narration becomes readable caption pages with explicit estimated timing and measured bounds', () => {
  const text = '广东在末节连续追分，南京则依靠关键篮板稳住局面。最后一攻未能命中，比赛就此结束。双方球员都贡献了精彩表现，胜负并不只由最后一个回合决定。';
  const cues = buildCaptionCues(text, 2, 40);
  assert.ok(cues.length >= 3);
  assert.equal(cues[0].start, 2);
  assert.equal(cues.at(-1).end, 42);
  assert.equal(cues.map(cue => cue.text).join(''), text);
  for (let i = 0; i < cues.length; i++) {
    assert.ok(Array.from(cues[i].text).length <= 30);
    assert.equal(cues[i].timing, 'estimated-within-measured-segment-audio');
    assert.ok(cues[i].end > cues[i].start);
    if (i) assert.equal(cues[i].start, cues[i - 1].end);
  }
});

test('delayed narration preserves original lead-in, ducks only during speech, moves captions and retains the audio tail', async () => {
  const delayed = structuredClone(job);
  delayed.news.segments = [{...delayed.news.segments[0], audioDigest: {offsetSeconds: .4}}];
  const result = await renderNews({job: delayed, jobDir: directory, outputDir: path.join(directory, 'delayed-voice'), options});
  assert.ok(Math.abs(result.duration - 1.6) < .1, 'duration must include the offset plus the full 1.2s voice');
  assert.equal(result.segments[0].narrationOffset, .4);
  assert.equal(result.captions[0].start, .4);
  assert.equal(result.captions.at(-1).end, 1.6);
  assert.match(await fs.readFile(result.subtitlePath, 'utf8'), /00:00:00,400 --> 00:00:01,600/);
  const leadOriginal = await tone(result.path, .05, 440);
  assert.ok(leadOriginal > .02, 'original audio must remain at full volume before the delayed voice');
  assert.ok(await tone(result.path, .05, 1100) < .001, 'voice must not leak into its delayed lead-in');
  const duringOriginal = await tone(result.path, .42, 440), duringVoice = await tone(result.path, .42, 1100);
  assert.ok(duringOriginal < leadOriginal * .25, 'original audio must duck only after narration starts');
  assert.ok(duringVoice > .02 && duringVoice > duringOriginal * 4, 'delayed voice must be audible over the ducked original');
  assert.ok(await tone(result.path, 1.35, 1100) > .02, 'delayed narration must not be cut at its unshifted end');

  const shortAudio = path.join(directory, 'delayed-short.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1100:sample_rate=48000:duration=0.3', shortAudio]);
  delayed.clips[0].end = 1.2;
  delayed.news.segments[0].audioPath = shortAudio;
  delayed.news.segments[0].audioDigest.offsetSeconds = .3;
  const restored = await renderNews({job: delayed, jobDir: directory, outputDir: path.join(directory, 'delayed-restored'), options});
  assert.ok(await tone(restored.path, .75, 440) > .02, 'original audio must return to full volume after the shifted narration ends');
  assert.ok(await tone(restored.path, .75, 1100) < .001, 'no narration may remain after its shifted end');
});

test('narration offsets invalidate the render cache and reject invalid values before rendering', async () => {
  const delayed = structuredClone(job), original = await renderInputDigest(delayed);
  delayed.news.segments[0].audioDigest = {offsetSeconds: 0};
  assert.equal(await renderInputDigest(delayed), original, 'omitted offset and zero have identical timing');
  delayed.news.segments[0].audioDigest.offsetSeconds = 6.5;
  assert.notEqual(await renderInputDigest(delayed), original, 'the same audio bytes at a new offset need a new render');
  for (const offsetSeconds of [-1, NaN, Infinity, '0.4', null]) {
    delayed.news.segments[0].audioDigest.offsetSeconds = offsetSeconds;
    await assert.rejects(renderInputDigest(delayed), /offsetSeconds must be a finite non-negative number/);
    await assert.rejects(renderNews({job: delayed, jobDir: directory, outputDir: path.join(directory, 'invalid-offset'), options}), /offsetSeconds must be a finite non-negative number/);
  }
});

test('split narration preserves each source part, restores original audio in the gap, and interrupts captions', async () => {
  const voice = path.join(directory, 'split-voice.wav');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1100:sample_rate=48000:duration=0.3',
    '-f', 'lavfi', '-i', 'sine=frequency=1500:sample_rate=48000:duration=0.3',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', voice]);
  const split = structuredClone(job);
  split.clips[0].end = 1.2;
  const parts = [{start: 0, end: .3, offset: 0, text: '广东最后一攻'},
    {start: .3, end: .6, offset: .7, text: '未能命中。'}];
  split.news.segments = [{...split.news.segments[0], audioPath: voice, audioDigest: {duration: .6, parts}}];
  const result = await renderNews({job: split, jobDir: directory, outputDir: path.join(directory, 'split-voice'), options});
  assert.ok(Math.abs(result.duration - 1.1) < .1, 'the complete visual play must survive the inserted pause');
  assert.deepEqual(result.segments[0].parts, parts);
  assert.equal(result.segments[0].narrationDuration, .6, 'pauses must not change the recording duration');
  assert.deepEqual(result.captions.map(({start, end}) => [start, end]), [[0, .3], [.7, 1]]);
  assert.match(await fs.readFile(result.subtitlePath, 'utf8'), /00:00:00,000 --> 00:00:00,300/);
  assert.match(await fs.readFile(result.subtitlePath, 'utf8'), /00:00:00,700 --> 00:00:01,000/);
  assert.ok(await tone(result.path, .04, 1100) > .02, 'the first source part must play at its own offset');
  assert.ok(await tone(result.path, .75, 1500) > .02, 'the second source part must retain its own audio after the gap');
  assert.ok(await tone(result.path, .75, 1100) < .001, 'the first source part must not be repeated');
  const originalInGap = await tone(result.path, .4, 440);
  assert.ok(originalInGap > .02, 'original commentary must return at full volume inside the pause');
  assert.ok(await tone(result.path, .4, 1100) < .001 && await tone(result.path, .4, 1500) < .001,
    'neither narration part may leak into the pause');
  assert.ok(await tone(result.path, .04, 440) < originalInGap * .25);
  assert.ok(await tone(result.path, .75, 440) < originalInGap * .25);
  const captionPixels = bytes => {
    let count = 0;
    for (let y = 130; y < 180; y++) for (let x = 20; x < 300; x++)
      if (pixel(bytes, x, y).every(channel => channel > 170)) count++;
    return count;
  };
  assert.ok(captionPixels(await rgb(result.path, .1)) > 25, 'first caption must be visibly burned in');
  assert.equal(captionPixels(await rgb(result.path, .5)), 0, 'captions must disappear during the inserted pause');
  assert.ok(captionPixels(await rgb(result.path, .8)) > 25, 'second caption must resume with the second voice part');
});

test('split narration validates complete source coverage, unchanged text, and disjoint placement and invalidates cache', async () => {
  const split = structuredClone(job), segment = split.news.segments[0];
  segment.audioDigest = {duration: 1.2, parts: [{start: 0, end: .6, offset: 0, text: '广东最后一攻'},
    {start: .6, end: 1.2, offset: 1, text: '未能命中。'}]};
  const original = await renderInputDigest(split);
  segment.audioDigest.parts[1].offset = 1.4;
  assert.notEqual(await renderInputDigest(split), original, 'changing only an internal pause needs a new render');
  const valid = structuredClone(segment.audioDigest.parts);
  const invalid = [[], null, {},
    [{...valid[0], start: NaN}, valid[1]],
    [{...valid[0], end: Infinity}, valid[1]],
    [{...valid[0], offset: -1}, valid[1]],
    [{...valid[0], offset: '0'}, valid[1]],
    [{...valid[0], start: .2}, valid[1]],
    [valid[0], {...valid[1], start: .8}],
    [valid[0], {...valid[1], start: .4}],
    [valid[0], {...valid[1], end: 1.1}],
    [valid[0], {...valid[1], offset: .5}],
    [valid[0], {...valid[1], text: '命中了。'}],
  ];
  for (const parts of invalid) {
    segment.audioDigest.parts = parts;
    await assert.rejects(renderInputDigest(split), /narration parts/);
    await assert.rejects(renderNews({job: split, jobDir: directory, outputDir: path.join(directory, 'invalid-parts'), options}), /narration parts/);
  }
  segment.audioDigest.parts = [{...valid[0], start: .01}, {...valid[1], start: .61, end: 1.19}];
  assert.deepEqual(narrationParts(segment, 1.2), valid, 'tolerated rounding differences must snap to full contiguous coverage');
  segment.audioDigest.parts = [valid[0], {...valid[1], end: 1.1}];
  segment.audioDigest.duration = 1.1;
  await assert.rejects(renderNews({job: split, jobDir: directory, outputDir: path.join(directory, 'incorrect-audio-duration'), options}),
    /cover the complete audio duration/, 'source coverage must use the measured recording duration');
});

test('rejects missing narration, unverified clips, duplicates, silent original sources, and non-16:9 outputs', async () => {
  const args = {jobDir: directory, outputDir: path.join(directory, 'invalid'), options};
  let invalid = structuredClone(job);
  delete invalid.news.segments[0].audioPath;
  await assert.rejects(renderVideos({...args, job: invalid}), /missing audioPath/);
  invalid = structuredClone(job);
  invalid.clips[0].verified = false;
  await assert.rejects(renderHighlights({...args, job: invalid}), /not been verified/);
  invalid = structuredClone(job);
  invalid.highlights.clipIds = ['play-a', 'play-a'];
  await assert.rejects(renderHighlights({...args, job: invalid}), /Duplicate clip/);
  invalid = structuredClone(job);
  invalid.media[0].path = path.join(directory, 'silent.mp4');
  await assert.rejects(renderHighlights({...args, job: invalid}), /no audio/);
  await assert.rejects(renderHighlights({...args, job, options: {...options, width: 300}}), /16:9/);
  assert.deepEqual(await fs.readdir(args.outputDir), []);
});
