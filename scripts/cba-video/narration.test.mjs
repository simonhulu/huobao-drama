import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {approveJob, assertApproved, createJob, digest, editorialDigest, fileHash, readJson, writeJson} from './core.mjs';
import {generateNarrations} from './narration.mjs';

const exec = promisify(execFile);
let assets, source, tone, sourceHash;
before(async () => {
  assets = await mkdtemp(path.join(os.tmpdir(), 'cba-narration-assets-'));
  source = path.join(assets, 'replay.mp4');
  tone = path.join(assets, 'voice.m4a');
  await Promise.all([
    exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', source]),
    exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=16000:duration=0.4',
      '-c:a', 'aac', tone]),
  ]);
  sourceHash = await fileHash(source);
});
after(async () => { if (assets) await rm(assets, {recursive: true, force: true}); });

async function fixture(t, {count = 1, original = false, approved = true} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cba-narration-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const jobDir = path.join(directory, 'job');
  const storageRoot = path.join(directory, 'storage');
  await mkdir(path.join(storageRoot, 'audio'), {recursive: true});
  await copyFile(tone, path.join(storageRoot, 'audio', 'voice.m4a'));
  const job = createJob({id: 'test-game', league: 'CBA', date: '2026-10-18', home: '南京', away: '广东', verified: true});
  job.sources = [{id: 's1', title: '合成测试来源', url: 'https://example.com/test'}];
  job.facts = [{id: 'f1', text: '合成测试事实', sourceIds: ['s1'], verified: true}];
  job.media = [{id: 'm1', kind: 'full_replay', path: source, matchId: job.match.id,
    matchConfirmed: true, sha256: sourceHash, probe: {duration: 4, width: 160, height: 90, hasAudio: true}}];
  for (let index = 0; index < count + Number(original); index++) {
    job.clips.push({id: `c${index}`, mediaId: 'm1', start: index, end: index + 1,
      factIds: ['f1'], verified: true, verificationNote: '仅用于测试的合成画面'});
    job.news.segments.push({id: `n${index}`, text: `第${index + 1}段测试旁白。`, factIds: ['f1'], clipIds: [`c${index}`],
      mode: index >= count ? 'original' : 'narration'});
  }
  job.news.title = '测试新闻';
  job.highlights = {title: '测试集锦', clipIds: job.clips.map(clip => clip.id)};
  if (approved) {
    job.review = {complete: true, digest: editorialDigest(job)};
    approveJob(job, {digest: job.review.digest, note: '测试夹具的模拟审批'});
  }
  writeJson(path.join(jobDir, 'job.json'), job);
  return {jobDir, storageRoot, job, jobFile: path.join(jobDir, 'job.json')};
}

test('unapproved jobs make no provider requests or audio writes', async t => {
  const context = await fixture(t, {approved: false});
  let calls = 0;
  await assert.rejects(generateNarrations({...context, generate: async () => { calls++; }}), /User approval/);
  assert.equal(calls, 0);
  assert.equal(readJson(context.jobFile).news.segments[0].audioPath, undefined);
});

test('a generated audio file is probed, copied, fingerprinted and saved with provider titles', async t => {
  const context = await fixture(t);
  const titles = [{text: '第一段测试旁白。', start: 0, end: 0.4}];
  const result = await generateNarrations({...context, generate: async request => {
    assert.deepEqual(request, {text: context.job.news.segments[0].text, ...context.job.tts,
      subtitleEnable: true, subtitleType: 'sentence'});
    return {audioUrl: 'static/audio/voice.m4a', titles};
  }});
  assert.deepEqual(result.generated, ['n0']);
  const saved = readJson(context.jobFile);
  const segment = saved.news.segments[0];
  assert.equal(segment.audioDigest.request, digest({text: segment.text, tts: saved.tts}));
  assert.equal(segment.audioDigest.sha256, await fileHash(segment.audioPath));
  assert.ok(segment.audioDigest.duration > 0);
  assert.equal(path.dirname(segment.audioPath), path.join(context.jobDir, 'audio'));
  assert.deepEqual(JSON.parse(await readFile(segment.audioDigest.titlesPath, 'utf8')), titles);
  await assertApproved(saved);
});

test('rerunning reuses valid audio and never requests original-commentary segments', async t => {
  const context = await fixture(t, {original: true});
  let calls = 0;
  const generate = async () => { calls++; return {audioUrl: 'static/audio/voice.m4a'}; };
  const first = await generateNarrations({...context, generate});
  const second = await generateNarrations({...context, generate});
  assert.equal(calls, 1);
  assert.deepEqual(first.skipped, ['n1']);
  assert.deepEqual(second.reused, ['n0']);
  assert.deepEqual(second.generated, []);
  assert.equal(second.job.news.segments[1].audioPath, undefined);
});

test('an interrupted run saves completed segments and resumes at the unfinished segment', async t => {
  const context = await fixture(t, {count: 2});
  let calls = 0;
  await assert.rejects(generateNarrations({...context, generate: async () => {
    calls++;
    if (calls === 2) throw new Error('simulated provider outage');
    return {audioUrl: 'static/audio/voice.m4a'};
  }}), /Narration n1 failed.*simulated provider outage/);
  const interrupted = readJson(context.jobFile);
  assert.ok(interrupted.news.segments[0].audioDigest.sha256);
  assert.equal(interrupted.news.segments[1].audioPath, undefined);
  const failurePath = path.join(context.jobDir, 'narration-error.json');
  const failure = readJson(failurePath);
  assert.equal(failure.segmentId, 'n1');
  assert.match(failure.message, /simulated provider outage/);
  assert.equal(failure.requestDigest, digest({text: interrupted.news.segments[1].text, tts: interrupted.tts}));
  let resumed = 0;
  const result = await generateNarrations({...context, generate: async request => {
    resumed++;
    assert.equal(request.text, context.job.news.segments[1].text);
    return {audioUrl: 'static/audio/voice.m4a'};
  }});
  assert.equal(resumed, 1);
  assert.deepEqual(result.reused, ['n0']);
  assert.deepEqual(result.generated, ['n1']);
  await assert.rejects(readFile(failurePath), {code: 'ENOENT'});
});

test('provider failure diagnostics retain the cause without credentials or terminal escapes', async t => {
  const context = await fixture(t);
  await assert.rejects(generateNarrations({...context, generate: async () => {
    throw new Error('fetch failed', {cause: new Error('\u001b[31mCERT_HAS_EXPIRED\u001b[0m; "api_key":"private-json"; token=private-token; Bearer private-bearer; Authorization: Bearer private-header-token; Authorization=Basic private-basic-token; https://user:private-pass@provider.test/tts?key=private-query')});
  }}), error => {
    assert.match(error.message, /fetch failed.*CERT_HAS_EXPIRED/);
    assert.doesNotMatch(error.message, /private-|\u001b/);
    return true;
  });
  const failure = readJson(path.join(context.jobDir, 'narration-error.json'));
  assert.match(failure.message, /fetch failed.*CERT_HAS_EXPIRED/);
  assert.doesNotMatch(JSON.stringify(failure), /private-|\\u001b/);
  assert.equal(readJson(context.jobFile).news.segments[0].audioPath, undefined);
});

test('corrupt provider audio is rejected and never recorded as a completed segment', async t => {
  const context = await fixture(t);
  await writeFile(path.join(context.storageRoot, 'audio', 'broken.m4a'), 'not an audio file');
  await assert.rejects(generateNarrations({...context, generate: async () => ({audioUrl: 'static/audio/broken.m4a'})}), /Generated audio is invalid/);
  const segment = readJson(context.jobFile).news.segments[0];
  assert.equal(segment.audioPath, undefined);
  assert.equal(segment.audioDigest, undefined);
});

test('a changed narration file is regenerated even when its request digest still matches', async t => {
  const context = await fixture(t);
  let calls = 0;
  const generate = async () => { calls++; return {audioUrl: 'static/audio/voice.m4a'}; };
  await generateNarrations({...context, generate});
  const previous = readJson(context.jobFile);
  previous.outputs = {news: {path: 'previous-export.mp4'}};
  previous.status = 'rendered';
  writeJson(context.jobFile, previous);
  const segment = previous.news.segments[0];
  await appendFile(segment.audioPath, 'altered');
  const result = await generateNarrations({...context, generate});
  assert.equal(calls, 2);
  assert.deepEqual(result.generated, ['n0']);
  assert.equal(result.job.outputs, null);
  assert.equal(result.job.status, 'approved');
  assert.equal(result.job.news.segments[0].audioDigest.sha256, await fileHash(path.join(context.storageRoot, 'audio', 'voice.m4a')));
});

test('an approved provider switch regenerates every narration and then reuses only the new configuration', async t => {
  const context = await fixture(t, {count: 2});
  await generateNarrations({...context, generate: async () => ({audioUrl: 'static/audio/voice.m4a'})});
  const job = readJson(context.jobFile);
  const previous = job.news.segments.map(segment => ({path: segment.audioPath, request: segment.audioDigest.request}));
  job.tts = {configId: 96, model: 'qwen-audio-3.1-tts-flash', voice: 'qwen-fixture-voice', speed: 1.08};
  job.review = {complete: true, digest: editorialDigest(job)};
  approveJob(job, {digest: job.review.digest, note: '测试夹具：用户授权备用音色并重新批准'});
  writeJson(context.jobFile, job);
  let requests = 0;
  const generate = async request => {
    requests++;
    assert.equal(request.configId, 96);
    assert.equal(request.model, job.tts.model);
    assert.equal(request.voice, job.tts.voice);
    return {audioUrl: 'static/audio/voice.m4a'};
  };
  const result = await generateNarrations({...context, generate});
  assert.deepEqual(result.generated, ['n0', 'n1']);
  assert.equal(requests, 2);
  for (const [index, segment] of result.job.news.segments.entries()) {
    assert.notEqual(segment.audioPath, previous[index].path);
    assert.notEqual(segment.audioDigest.request, previous[index].request);
    assert.equal(segment.audioDigest.request, digest({text: segment.text, tts: job.tts}));
    assert.ok((await readFile(previous[index].path)).length, 'old audio stays available as evidence');
  }
  const resumed = await generateNarrations({...context, generate});
  assert.deepEqual(resumed.reused, ['n0', 'n1']);
  assert.equal(requests, 2);
});
