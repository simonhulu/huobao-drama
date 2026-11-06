import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createJob, readJson, writeJson, fileHash} from './core.mjs';
import {probeMedia} from './media.mjs';
import {acquireMedia, officialMediaCandidates} from './acquire-media.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const match = {id: '2026-10-23-zhejiang-qingdao', league: 'CBA', date: '2026-10-23', home: '浙江', away: '青岛'};
const live = 'https://www.miguvideo.com/p/live/120000594061';
const detail = id => `https://www.miguvideo.com/p/detail/${id}`;
let fixtureDir, source;

before(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-acquire-fixture-'));
  source = path.join(fixtureDir, 'source.mp4');
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=10:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
});
after(() => fs.rmSync(fixtureDir, {recursive: true, force: true}));

function evidence(count = 1) {
  const entries = Array.from({length: count}, (_, i) => ({url: detail(String(968670470 + i)), title: `全场回放（解说 ${i}）`, duration: '00:02'}));
  return {provider: 'migu', match: {...match}, status: 'candidates_found', completed: true, searchedAt: '2026-10-24T01:00:00Z',
    candidates: entries.map(entry => ({...entry, matchPageUrl: live})), matchPages: [
      {url: live, date: match.date, teamsMatch: true, dateMatches: true, replayEntries: entries},
    ], errors: []};
}

function setup(t, search = evidence()) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-acquire-test-'));
  t.after(() => fs.rmSync(jobDir, {recursive: true, force: true}));
  const job = createJob(match); job.mediaSearch = search;
  writeJson(path.join(jobDir, 'job.json'), job);
  return {jobDir, job};
}

async function localMedia(jobDir, job, confirmed = false) {
  const file = path.join(jobDir, 'source.mp4'); fs.copyFileSync(source, file);
  job.media = [{id: 'local', path: file, kind: 'full_replay', matchId: match.id, matchConfirmed: confirmed,
    sha256: await fileHash(file), probe: await probeMedia(file)}];
  writeJson(path.join(jobDir, 'job.json'), job);
  return file;
}

async function fakeDownload({jobDir, id}) {
  const directory = path.join(jobDir, 'downloads'); fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, `${id}-0123456789ab.mp4`); fs.copyFileSync(source, file);
  return {file};
}

const never = () => { throw Error('unexpected external request'); };

// Reduced from the actual 2026-10-24 Tianjin resume evidence: the task omitted
// sourceScope, while its official match page already identified full highlights.
function tianjinEvidence() {
  const match = {id: '2026-10-24-tianjin-guangzhou', league: 'CBA', date: '2026-10-23', home: '天津', away: '广州'};
  const highlight = {url: detail('968670699'), title: '26/27赛季CBA常规赛第3轮全场集锦：天津vs广州', duration: '04:25'};
  return {provider: 'migu', match, status: 'candidates_found', completed: true, searchedAt: '2026-10-24T12:27:50.200Z', errors: [],
    candidates: [
      {url: detail('968670874'), title: '锐探 CBA：天津先行者vs广州龙狮', duration: '02:41:22', replayCandidate: true, matchPageUrl: null},
      {...highlight, matchPageUrl: 'https://www.miguvideo.com/p/live/120000594060'},
    ], matchPages: [{url: 'https://www.miguvideo.com/p/live/120000594060', date: match.date,
      teams: [{name: '天津先行者', score: 102, isHome: true}, {name: '广州智都集团', score: 86, isHome: false}],
      teamsMatch: true, dateMatches: true, replayEntries: [highlight]}]};
}

test('actual Tianjin evidence reports scope mismatch separately and permits only its official highlights when enabled', async t => {
  for (const enabled of [false, true]) {
    const report = tianjinEvidence(), {jobDir, job} = setup(t, report);
    job.match = {...report.match};
    if (enabled) job.profile.sourceScope = 'highlights';
    writeJson(path.join(jobDir, 'job.json'), job);
    let downloads = 0;
    const result = await acquireMedia({jobDir}, {search: async () => report, download: async request => {
      downloads++;
      assert.equal(request.candidate.contentId, '968670699');
      return fakeDownload(request);
    }});
    if (enabled) {
      assert.equal(result.status, 'downloaded_needs_verification');
      assert.equal(result.media.kind, 'highlights');
      assert.equal(result.media.matchConfirmed, false);
      assert.equal(downloads, 1);
    } else {
      assert.equal(result.status, 'scope_mismatch');
      assert.equal(result.failure.code, 'source_scope_mismatch');
      assert.equal(result.failure.requiredScope, 'full_replay');
      assert.equal(result.failure.availableScope, 'highlights');
      assert.match(result.failure.message, /已核对.*官方集锦或片段.*当前任务要求完整回放/);
      assert.deepEqual(result.availableCandidates.map(item => item.contentId), ['968670699']);
      assert.equal(downloads, 0);
      assert.equal(readJson(result.reportPath).status, 'scope_mismatch');
    }
  }
});

test('scope mismatch cannot substitute for official date, teams or replay-list membership evidence', async t => {
  for (const change of [
    report => { report.matchPages[0].dateMatches = false; },
    report => { report.matchPages[0].teamsMatch = false; },
    report => { report.matchPages[0].replayEntries = []; },
  ]) {
    const report = tianjinEvidence(); change(report);
    const {jobDir, job} = setup(t, report); job.match = {...report.match}; writeJson(path.join(jobDir, 'job.json'), job);
    const result = await acquireMedia({jobDir}, {search: async () => report, download: never});
    assert.equal(result.status, 'identity_unverified');
    assert.equal(result.availableCandidates, undefined);
  }
});

test('real CLI reuses verified bytes with fresh ffprobe and no network despite an old error log', async t => {
  const {jobDir, job} = setup(t);
  const file = await localMedia(jobDir, job, true);
  fs.mkdirSync(path.join(jobDir, 'downloads'));
  fs.writeFileSync(path.join(jobDir, 'downloads/download-error.log'), 'old 403 failure');
  const {stdout} = await exec(process.execPath, [cli, 'acquire-media', '--job', jobDir]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'verified_media_reused');
  assert.equal(result.media.path, fs.realpathSync(file));
  assert.equal(result.media.sha256, await fileHash(file));
  assert.equal(result.media.probe.hasAudio, true);
  assert.deepEqual(result.attempts.map(item => item.operation), ['probe']);
  assert.equal(readJson(result.reportPath).status, result.status);
  assert.equal(fs.readFileSync(path.join(jobDir, 'downloads/download-error.log'), 'utf8'), 'old 403 failure');
});

test('an unconfirmed local file is reusable but remains unconfirmed', async t => {
  const {jobDir, job} = setup(t);
  await localMedia(jobDir, job);
  const result = await acquireMedia({jobDir}, {search: never, download: never});
  assert.equal(result.status, 'downloaded_needs_verification');
  assert.equal(result.reused, true);
  assert.equal(result.media.matchConfirmed, false);
  assert.equal(readJson(path.join(jobDir, 'job.json')).media[0].matchConfirmed, false);
});

test('old failures do not skip a new download; current attempt logs and command are retained', async t => {
  const {jobDir} = setup(t);
  fs.mkdirSync(path.join(jobDir, 'downloads'));
  fs.writeFileSync(path.join(jobDir, 'downloads/download-error.log'), 'old failure: token=old-secret');
  let calls = 0;
  const result = await acquireMedia({jobDir}, {search: never, download: async request => {
    calls++;
    assert.ok(request.command.args.includes('--content-id'));
    assert.ok(request.command.args.includes(live));
    assert.ok(!request.command.args.includes('--match-confirmed'));
    return fakeDownload(request);
  }});
  assert.equal(calls, 1);
  assert.equal(result.status, 'downloaded_needs_verification');
  assert.equal(result.media.matchConfirmed, false);
  assert.equal(result.attempts[0].result, 'succeeded');
  assert.ok(result.attempts[0].startedAt && result.attempts[0].finishedAt);
  assert.ok(!JSON.stringify(result).includes('old-secret'));
  assert.equal(readJson(path.join(jobDir, 'job.json')).mediaSearch.candidates.length, 1);
});

test('three distinct candidates per run are attempted again after failure, without leaking signed URLs', async t => {
  const {jobDir} = setup(t, evidence(4));
  const tried = [];
  const download = async ({candidate}) => {
    tried.push(candidate.url);
    throw Error('HTTP 403 https://cdn.example.test/video.m3u8?token=current-secret cookie=private-cookie');
  };
  const first = await acquireMedia({jobDir}, {search: never, download});
  assert.equal(first.status, 'access_failed');
  assert.equal(first.attempts.length, 3);
  assert.equal(new Set(tried).size, 3);
  assert.ok(first.attempts.every(item => item.errorClass === 'authentication_required' && item.finishedAt));
  assert.doesNotMatch(fs.readFileSync(first.reportPath, 'utf8'), /current-secret|private-cookie/);
  const second = await acquireMedia({jobDir}, {search: never, download});
  assert.equal(tried.length, 6);
  assert.notEqual(first.runId, second.runId);
  assert.equal(readJson(first.reportPath).runId, first.runId);
  assert.equal(readJson(path.join(jobDir, 'job.json')).mediaSearch.candidates.length, 4);
});

test('official identity needs matching search context, page date/teams and replay-list membership', () => {
  const job = createJob(match); job.mediaSearch = evidence();
  job.mediaSearch.candidates.push({url: detail('999999999'), title: '浙江青岛全场回放', durationSeconds: 8000, matchPageUrl: live});
  assert.deepEqual(officialMediaCandidates(job).map(candidate => candidate.url), [detail('968670470')]);
  for (const change of [
    value => { value.match.home = '广厦'; },
    value => { value.matchPages[0].date = '2025-10-23'; },
    value => { value.matchPages[0].dateMatches = false; },
    value => { value.matchPages[0].teamsMatch = false; },
    value => { value.matchPages[0].url = 'https://fake.test/p/live/120000594061'; },
    value => { value.matchPages[0].replayEntries = []; },
  ]) {
    job.mediaSearch = evidence(); change(job.mediaSearch);
    assert.deepEqual(officialMediaCandidates(job), []);
  }
});

test('a preserved successful official search can be used after a transient search outage', async t => {
  const previous = evidence();
  const {jobDir} = setup(t, {...previous, status: 'access_blocked', completed: false, candidates: [], matchPages: [], lastSuccessfulSearch: previous});
  const result = await acquireMedia({jobDir}, {search: never, download: fakeDownload});
  assert.equal(result.status, 'downloaded_needs_verification');
  assert.equal(result.attempts[0].candidate.searchOrigin, 'lastSuccessfulSearch');
});

test('full-replay scope rejects partial footage; highlights scope selects same-match footage by duration', () => {
  const job = createJob(match); job.mediaSearch = evidence();
  job.mediaSearch.matchPages[0].replayEntries = [
    {url: detail('1'), title: '全场集锦'}, {url: detail('2'), title: '半场集锦'},
    {url: detail('3'), title: '第4节全场回放'}, {url: detail('4'), title: '浙江青岛', duration: '02:00:00'},
  ];
  assert.deepEqual(officialMediaCandidates(job), []);
  job.profile.sourceScope = 'highlights';
  assert.deepEqual(officialMediaCandidates(job).map(candidate => [candidate.contentId, candidate.kind]),
    [['4', 'highlights'], ['1', 'highlights'], ['2', 'highlights'], ['3', 'highlights']]);
});

test('a full/half highlight title conflict no longer blocks acquisition of the same official match video', async t => {
  const report = evidence();
  report.candidates[0].title = '全场集锦';
  report.matchPages[0].replayEntries[0].title = '半场集锦';
  report.matchPages.push({url: 'https://www.miguvideo.com/p/live/120000586249', error: '赛事页缺少双方球队信息'});
  const {jobDir, job} = setup(t, report); job.profile.sourceScope = 'highlights'; writeJson(path.join(jobDir, 'job.json'), job);
  const result = await acquireMedia({jobDir}, {search: never, download: fakeDownload});
  assert.equal(result.status, 'downloaded_needs_verification');
  assert.equal(result.media.kind, 'highlights');
  assert.equal(result.media.matchConfirmed, false);
  assert.equal(result.attempts[0].candidate.title, '半场集锦');
  assert.equal(result.attempts[0].candidate.searchTitle, '全场集锦');
  assert.equal(result.attempts[0].candidate.titleConflict, true);
  assert.deepEqual(result.attempts.map(item => item.operation), ['download']);
});

test('duration wins over title type and search position, then a failed longer video falls through to the next', async t => {
  const report = evidence(3);
  report.matchPages[0].replayEntries = [
    {url: detail('968670470'), title: '全场集锦', duration: '05:00'},
    {url: detail('968670471'), title: '全场回放', duration: '01:00:00'},
    {url: detail('968670472'), title: '比赛片段', duration: '10:00'},
  ];
  report.candidates = report.matchPages[0].replayEntries.map(entry => ({...entry, matchPageUrl: live}));
  report.candidates[2].durationSeconds = 800;
  const {jobDir, job} = setup(t, report); job.profile.sourceScope = 'highlights'; writeJson(path.join(jobDir, 'job.json'), job);
  assert.deepEqual(officialMediaCandidates(job).map(item => item.contentId), ['968670471', '968670472', '968670470']);
  const tried = [];
  const result = await acquireMedia({jobDir}, {search: never, download: async request => {
    tried.push(request.candidate.contentId);
    if (tried.length === 1) throw Error('HTTP 404 media not found');
    return fakeDownload(request);
  }});
  assert.deepEqual(tried, ['968670471', '968670472']);
  assert.equal(result.status, 'downloaded_needs_verification');
});

test('missing or equal durations use the first corresponding search result, not URL or replay-list order', () => {
  for (const duration of [undefined, '05:00']) {
    const job = createJob(match); job.profile.sourceScope = 'highlights';
    job.mediaSearch = evidence(2);
    job.mediaSearch.matchPages[0].replayEntries = [
      {url: detail('1'), title: '比赛素材', duration}, {url: detail('9'), title: '比赛素材', duration},
    ];
    job.mediaSearch.candidates = [
      {url: detail('99'), title: '其他比赛全场回放', duration: '09:00:00'},
      {url: detail('9'), title: '比赛素材', duration}, {url: detail('1'), title: '比赛素材', duration},
    ];
    assert.deepEqual(officialMediaCandidates(job).map(item => item.contentId), ['9', '1']);
  }
});

test('missing identity evidence triggers fresh search and is reported separately from no media', async t => {
  const report = evidence(); report.matchPages = [];
  const {jobDir} = setup(t, report);
  let searches = 0;
  const result = await acquireMedia({jobDir}, {search: async () => { searches++; return report; }, download: never});
  assert.equal(searches, 1);
  assert.equal(result.status, 'identity_unverified');
  assert.equal(result.attempts[0].operation, 'search');
  assert.equal(result.attempts[0].observed.candidateCount, 1);
});

test('fresh empty search, failed access and a real 404 are classified separately', async t => {
  for (const [status, completed, expected] of [['not_found', true, 'media_not_found'], ['access_blocked', false, 'access_failed']]) {
    const {jobDir} = setup(t, null);
    const report = {...evidence(), status, completed, candidates: [], matchPages: []};
    const result = await acquireMedia({jobDir}, {search: async () => report, download: never});
    assert.equal(result.status, expected);
  }
  const {jobDir} = setup(t);
  const result = await acquireMedia({jobDir}, {search: never, download: async () => { throw Error('HTTP 404 media not found'); }});
  assert.equal(result.status, 'media_not_found');
  assert.equal(result.attempts[0].errorClass, 'media_not_found');
});

test('a changed stored fingerprint is not reused and the current download still runs', async t => {
  const {jobDir, job} = setup(t);
  const file = await localMedia(jobDir, job, true); fs.appendFileSync(file, 'modified');
  let downloads = 0;
  const result = await acquireMedia({jobDir}, {search: never, download: async request => { downloads++; return fakeDownload(request); }});
  assert.equal(downloads, 1);
  assert.equal(result.status, 'downloaded_needs_verification');
  assert.equal(result.attempts[0].errorClass, 'hash_mismatch');
});

test('interrupted download recovers only a complete final filename bound to a trusted candidate', async t => {
  const {jobDir} = setup(t), candidate = officialMediaCandidates(readJson(path.join(jobDir, 'job.json')))[0];
  const id = `migu-${candidate.contentId}`, {file} = await fakeDownload({jobDir, id});
  writeJson(path.join(jobDir, 'media-acquisition.json'), {match, attempts: [{operation: 'download', mediaId: id, candidate, result: 'running'}]});
  const result = await acquireMedia({jobDir}, {search: never, download: never});
  assert.equal(result.status, 'downloaded_needs_verification');
  assert.equal(result.reused, true);
  assert.equal(result.media.path, fs.realpathSync(file));
  assert.equal(result.media.matchConfirmed, false);
  assert.equal(result.attempts[0].operation, 'recover');
});

test('partial files and old records for another match cannot suppress a fresh download', async t => {
  const {jobDir} = setup(t), candidate = officialMediaCandidates(readJson(path.join(jobDir, 'job.json')))[0];
  const id = `migu-${candidate.contentId}`, {file} = await fakeDownload({jobDir, id});
  fs.renameSync(file, `${file}.part`);
  writeJson(path.join(jobDir, 'media-acquisition.json'), {match: {...match, id: 'another-match'},
    attempts: [{operation: 'download', mediaId: id, candidate, result: 'failed'}]});
  let downloads = 0;
  const result = await acquireMedia({jobDir}, {search: never, download: async request => { downloads++; return fakeDownload(request); }});
  assert.equal(result.status, 'downloaded_needs_verification');
  assert.equal(downloads, 1);
  assert.ok(!result.attempts.some(item => item.operation === 'recover'));
});

test('fresh search is saved before bounded downloads and one failed candidate does not stop the next', async t => {
  const {jobDir} = setup(t, null), calls = [];
  const result = await acquireMedia({jobDir}, {search: async request => {
    calls.push('search'); assert.deepEqual(request.match, createJob(match).match); return evidence(2);
  }, download: async request => {
    calls.push(request.candidate.contentId);
    assert.equal(readJson(path.join(jobDir, 'job.json')).mediaSearch.candidates.length, 2);
    if (calls.length === 2) throw Error('HTTP 503 temporary service failure');
    return fakeDownload(request);
  }, probe: probeMedia});
  assert.deepEqual(calls, ['search', '968670470', '968670471']);
  assert.equal(result.status, 'downloaded_needs_verification');
  assert.deepEqual(result.attempts.map(item => item.result), ['succeeded', 'failed', 'succeeded']);
  assert.equal(result.attempts[1].errorClass, 'network_or_parser');
});

test('default acquire and download subprocesses import real media using offline resolver/downloader shims', async t => {
  const {jobDir} = setup(t), binaries = path.join(jobDir, 'test-bin');
  fs.mkdirSync(binaries);
  const resolver = path.join(binaries, 'resolver');
  fs.writeFileSync(resolver, '#!/usr/bin/env node\n' +
    "const fs = require('node:fs'); const args = process.argv.slice(2);\n" +
    "fs.writeFileSync(args[args.indexOf('--output') + 1], 'https://offline.example.test/replay.m3u8?token=private-fixture');\n" +
    "console.log(JSON.stringify({type:'media',title:'全场回放',selectedTitle:'全场回放'}));\n", {mode: 0o700});
  fs.writeFileSync(path.join(binaries, 'yt-dlp'), '#!/usr/bin/env node\n' +
    "const fs = require('node:fs'); const args = process.argv.slice(2);\n" +
    "const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');\n" +
    `fs.copyFileSync(${JSON.stringify(source)}, output); console.log(output);\n`, {mode: 0o700});
  fs.mkdirSync(path.join(jobDir, 'downloads'));
  fs.writeFileSync(path.join(jobDir, 'downloads/download-error.log'), 'old HTTP 403 error: token=stale-fixture');
  const {stdout} = await exec(process.execPath, [cli, 'acquire-media', '--job', jobDir],
    {env: {...process.env, PATH: `${binaries}${path.delimiter}${process.env.PATH}`, VIDEODL_PYTHON: resolver}});
  const result = JSON.parse(stdout), saved = readJson(path.join(jobDir, 'job.json'));
  assert.equal(result.status, 'downloaded_needs_verification');
  assert.equal(result.attempts[0].execution, 'subprocess');
  assert.equal(result.attempts[0].result, 'succeeded');
  assert.equal(result.media.sha256, await fileHash(source));
  assert.equal(saved.media[0].matchConfirmed, false);
  assert.equal(saved.media[0].probe.hasAudio, true);
  assert.doesNotMatch(stdout, /private-fixture|stale-fixture/);
});

test('a new news job reuses verified same-match footage across team aliases before any network request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-shared-match-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const donor = createJob({...match, verified: true});
  await localMedia(first, donor, true);
  const job = createJob({...match, id: 'same-match-different-news', home: '浙江稠州金租', away: '青岛崂山啤酒', verified: true});
  writeJson(path.join(second, 'job.json'), job);
  const result = await acquireMedia({jobDir: second}, {search: never, download: never});
  assert.equal(result.status, 'verified_media_reused');
  const saved = readJson(path.join(second, 'job.json'));
  assert.equal(saved.media[0].path, fs.realpathSync(donor.media[0].path));
  assert.equal(saved.media[0].sha256, donor.media[0].sha256);
  assert.equal(saved.media[0].matchId, job.match.id);
  assert.equal(saved.media[0].reuse.sourceJobDir, first);
});

test('shared reuse rejects a different match date or changed source fingerprint', async t => {
  for (const changed of ['date','hash']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-shared-reject-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const first = path.join(root, 'first'), second = path.join(root, 'second');
    fs.mkdirSync(first); fs.mkdirSync(second);
    const donor = createJob({...match, verified: true});
    await localMedia(first, donor, true);
    if (changed === 'date') donor.match.date = '2026-10-22';
    else donor.media[0].sha256 = 'wrong-hash';
    writeJson(path.join(first, 'job.json'), donor);
    const job = createJob({...match, verified: true}); job.mediaSearch = evidence();
    writeJson(path.join(second, 'job.json'), job);
    let downloaded = 0;
    const result = await acquireMedia({jobDir: second}, {search: never, download: async args => { downloaded++; return fakeDownload(args); }});
    assert.equal(downloaded, 1);
    assert.equal(result.status, 'downloaded_needs_verification');
  }
});
