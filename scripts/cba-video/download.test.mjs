import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createJob, readJson, writeJson} from './core.mjs';
import {main} from './cli.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
let directory, bin, recording;
const secretToken = 'test-only-private-token-381d92';
const signature = 'test-only-signature%2Fwith%2Bencoding%3D';
const signedUrl = `https://video.example.invalid/${'long-match-stream-'.repeat(120)}.m3u8?token=${secretToken}&signature=${signature}&expires=1999999999`;
const mergerSource = `
const fs = require('node:fs');
const [output, marker] = process.argv.slice(1);
fs.writeFileSync(output, 'saved merger bytes');
process.on('SIGTERM', () => { fs.writeFileSync(marker + '.merger-stopped', String(process.pid)); process.exit(0); });
fs.writeFileSync(marker + '.merger-started', JSON.stringify({pid: process.pid, output}));
setInterval(() => fs.appendFileSync(output, '.'), 10);
`;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cba-download-test-'));
  bin = path.join(directory, 'bin');
  recording = path.join(directory, 'local-source.mp4');
  await fs.mkdir(bin);
  await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=10:d=0.3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', recording]);

  // This executable never makes a request: it copies a local fixture or emits
  // a controlled error, while exercising the production CLI process boundary.
  await fs.writeFile(path.join(bin, 'yt-dlp'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const url = args.at(-1);
fs.writeFileSync(process.env.CBA_TEST_DOWNLOAD_ARGS, JSON.stringify(args));
if (process.env.CBA_TEST_DOWNLOAD_MODE === 'stderr-failure') {
  process.stderr.write('ERROR: cannot fetch "' + url + '"\\nHTTP 403 from ' + url + '\\n');
  process.exit(1);
}
if (process.env.CBA_TEST_DOWNLOAD_MODE === 'empty-stderr-failure') process.exit(1);
const template = args[args.indexOf('-o') + 1];
if (!template) throw Error('No explicit download output template');
// A generic extractor can derive its id from the entire signed stream URL.
const output = template.replaceAll('%(id)s', encodeURIComponent(url)).replaceAll('%(ext)s', 'mp4');
fs.mkdirSync(path.dirname(output), {recursive: true});
if (['slow-download','slow-download-tree'].includes(process.env.CBA_TEST_DOWNLOAD_MODE)) {
  const marker = process.env.CBA_TEST_DOWNLOAD_LIFECYCLE;
  fs.writeFileSync(output + '.part', 'saved download bytes');
  fs.writeFileSync(output + '.ytdl', JSON.stringify({version: 1, fragment_index: 3}));
  process.on('SIGTERM', () => {
    fs.writeFileSync(marker + '.stopped', String(process.pid));
    process.exit(0);
  });
  if (process.env.CBA_TEST_DOWNLOAD_MODE === 'slow-download-tree') {
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(mergerSource)}, output + '.merge.part', marker], {stdio:'ignore'});
  }
  fs.writeFileSync(marker + '.started', JSON.stringify({pid: process.pid, output}));
  setInterval(() => fs.appendFileSync(output + '.part', '.'), 20);
} else {
fs.copyFileSync(process.env.CBA_TEST_DOWNLOAD_SOURCE, output);
if (args.includes('--write-info-json')) fs.writeFileSync(output + '.info.json', JSON.stringify({url, formats:[{url}]}));
process.stdout.write(output + '\\n');
}
`, {mode: 0o755});
  await fs.writeFile(path.join(bin, 'migu-python'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args[args.indexOf('--url') + 1];
if (url.includes('/live/') && !args.includes('--content-id')) {
  console.log(JSON.stringify({type:'playlist',entries:[{title:'全场集锦',url:'https://www.miguvideo.com/p/detail/968668508'}]}));
} else {
  const file = args[args.indexOf('--output') + 1];
  fs.writeFileSync(file, process.env.CBA_TEST_RESOLVED_URL, {mode:0o600});
  fs.writeFileSync(process.env.CBA_TEST_RESOLVER_OUTPUT, file);
  const title = url.includes('/live/') ? 'KedouVideoClient_20261024' : url.endsWith('/968668508') ? '浙江vs青岛 全场集锦' : '浙江vs青岛 第一节';
  console.log(JSON.stringify({type:'media',pageUrl:url,title,selectedTitle:url.includes('/live/')?'全场集锦':undefined,urlFile:file}));
}
`, {mode: 0o755});
});

after(async () => {
  if (directory) await fs.rm(directory, {recursive: true, force: true});
});

async function fixture(name) {
  const jobDir = path.join(directory, name);
  const job = createJob({id: name, league: 'CBA', date: '2026-10-18', home: '南京', away: '广东', verified: true});
  job.sources = [{id: 'report', url: 'https://example.invalid/report', title: '已保存报道'}];
  job.facts = [{id: 'result', text: '测试赛果', sourceIds: ['report'], verified: true}];
  writeJson(path.join(jobDir, 'job.json'), job);
  return {jobDir, job, argsFile: path.join(jobDir, 'fake-downloader-args.json')};
}

function download(state, args, mode = 'success', env = {}) {
  const child = spawn(process.execPath, [cli, 'download', '--job', state.jobDir, ...args], {
    timeout: 15000,detached:process.platform !== 'win32',
    env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      CBA_TEST_DOWNLOAD_ARGS: state.argsFile, CBA_TEST_DOWNLOAD_SOURCE: recording, CBA_TEST_DOWNLOAD_MODE: mode, ...env},
  });
  const result = new Promise((resolve,reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data',chunk => { stdout += chunk.toString(); });
    child.stderr.on('data',chunk => { stderr += chunk.toString(); });
    child.once('error',reject);
    child.once('close',code => code === 0 ? resolve({stdout,stderr}) : reject(Object.assign(Error(`CLI exited ${code}`),{stdout,stderr})));
  });
  result.child = child;
  return result;
}

test('disk reserve stops a new CBA download before the downloader and preserves the task', async () => {
  const state = await fixture('disk-reserve')
  await assert.rejects(download(state, ['--url', signedUrl], 'success', { MEDIA_DISK_RESERVE_GIB: '1000000000' }), error => {
    assert.match(error.stderr, /磁盘空间不足/)
    return true
  })
  assert.equal(await fs.stat(state.argsFile).then(() => true).catch(() => false), false)
  const saved = readJson(path.join(state.jobDir, 'job.json'))
  assert.deepEqual(saved.media, [])
  assert.deepEqual(saved.sources, state.job.sources)
  assert.deepEqual(saved.facts, state.job.facts)
  assert.match(saved.mediaBlocker, /磁盘空间不足/)
})

function slowDownloader(state, t, mode = 'slow-download') {
  const marker = path.join(state.jobDir, 'downloader-lifecycle');
  return {marker, spawnDownload:(command, args, options) => {
    assert.equal(command, 'yt-dlp');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.detached, process.platform !== 'win32');
    const child = spawn(process.execPath, [path.join(bin, 'yt-dlp'), ...args], {...options,
      env:{...process.env,CBA_TEST_DOWNLOAD_ARGS:state.argsFile,CBA_TEST_DOWNLOAD_MODE:mode,CBA_TEST_DOWNLOAD_LIFECYCLE:marker}});
    t.after(() => {
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid,'SIGKILL'); } catch {}
    });
    return child;
  }};
}

test('falling disk reserve stops an active downloader and keeps partial media, checkpoints and the task', async t => {
  const state = await fixture('disk-reserve-during-download'), runtime = slowDownloader(state, t);
  const original = path.join(state.jobDir, 'existing-recording.mp4');
  await fs.copyFile(recording, original);
  const originalBytes = await fs.readFile(original);
  let checks = 0;
  await assert.rejects(main(['download','--job',state.jobDir,'--url',signedUrl], {
    spawnDownload:runtime.spawnDownload,diskCheckIntervalMs:5,
    checkDiskSpace:async () => {
      checks++;
      if (await fs.stat(runtime.marker + '.started').then(() => true, () => false)) {
        throw Object.assign(Error('磁盘空间不足，需保留 10 GiB；下载断点已保留'), {code:'MEDIA_DISK_FULL'});
      }
    },
  }), {code:'MEDIA_DISK_FULL'});
  const started = readJson(runtime.marker + '.started');
  assert.equal(await fs.readFile(runtime.marker + '.stopped','utf8'), String(started.pid));
  assert.throws(() => process.kill(started.pid, 0), {code:'ESRCH'});
  const partial = await fs.readFile(started.output + '.part','utf8');
  assert.match(partial, /^saved download bytes/);
  assert.equal(readJson(started.output + '.ytdl').fragment_index, 3);
  assert.deepEqual(await fs.readFile(original), originalBytes);
  const saved = readJson(path.join(state.jobDir,'job.json'));
  assert.deepEqual(saved.sources, state.job.sources);
  assert.deepEqual(saved.facts, state.job.facts);
  assert.deepEqual(saved.media, []);
  assert.match(saved.mediaBlocker, /磁盘空间不足/);
  assert.ok(!await fs.stat(path.join(state.jobDir,'.lock')).then(() => true, () => false));
  const finishedChecks = checks;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(checks, finishedChecks);
  assert.equal(await fs.readFile(started.output + '.part','utf8'), partial);
});

test('ordinary download cancellation retains the task and is reported as a pause', async t => {
  const state = await fixture('paused-download'), runtime = slowDownloader(state, t), controller = new AbortController();
  await assert.rejects(main(['download','--job',state.jobDir,'--url',signedUrl], {
    spawnDownload:runtime.spawnDownload,diskCheckIntervalMs:5,signal:controller.signal,
    checkDiskSpace:async () => {
      if (await fs.stat(runtime.marker + '.started').then(() => true, () => false)) controller.abort(Error('requested pause'));
    },
  }), {code:'ABORT_ERR'});
  const started = readJson(runtime.marker + '.started');
  assert.equal(await fs.readFile(runtime.marker + '.stopped','utf8'), String(started.pid));
  assert.match(await fs.readFile(started.output + '.part','utf8'), /^saved download bytes/);
  assert.equal(readJson(started.output + '.ytdl').fragment_index, 3);
  const saved = readJson(path.join(state.jobDir,'job.json'));
  assert.match(saved.mediaBlocker, /已暂停/);
  assert.doesNotMatch(saved.mediaBlocker, /素材下载未成功/);
  assert.deepEqual(saved.facts, state.job.facts);
  assert.deepEqual(saved.sources, state.job.sources);
});

test('disk cancellation also stops the merger process and its writes', {skip:process.platform === 'win32'}, async t => {
  const state = await fixture('disk-reserve-merger'), runtime = slowDownloader(state, t, 'slow-download-tree');
  await assert.rejects(main(['download','--job',state.jobDir,'--url',signedUrl], {
    spawnDownload:runtime.spawnDownload,diskCheckIntervalMs:5,
    checkDiskSpace:async () => {
      if (await fs.stat(runtime.marker + '.merger-started').then(() => true, () => false)) {
        throw Object.assign(Error('磁盘空间不足，已保留下载和合并断点'), {code:'MEDIA_DISK_FULL'});
      }
    },
  }), {code:'MEDIA_DISK_FULL'});
  const downloader = readJson(runtime.marker + '.started'), merger = readJson(runtime.marker + '.merger-started');
  assert.equal(await fs.readFile(runtime.marker + '.stopped','utf8'), String(downloader.pid));
  assert.equal(await fs.readFile(runtime.marker + '.merger-stopped','utf8'), String(merger.pid));
  for (const pid of [downloader.pid,merger.pid]) assert.throws(() => process.kill(pid,0), {code:'ESRCH'});
  const bytes = await fs.readFile(merger.output,'utf8');
  await new Promise(resolve => setTimeout(resolve,30));
  assert.equal(await fs.readFile(merger.output,'utf8'), bytes);
  assert.match(await fs.readFile(downloader.output + '.part','utf8'), /^saved download bytes/);
  assert.equal(readJson(downloader.output + '.ytdl').fragment_index, 3);
  assert.deepEqual(readJson(path.join(state.jobDir,'job.json')).facts, state.job.facts);
  assert.ok(!await fs.stat(path.join(state.jobDir,'.lock')).then(() => true, () => false));
});

async function waitForMarker(filename) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(filename,'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve,10));
  }
  throw Error(`Fake download process did not start: ${filename}`);
}

test('service group SIGTERM and SIGINT reach downloader descendants and release the task lock', {skip:process.platform === 'win32'}, async t => {
  for (const signal of ['SIGTERM','SIGINT']) {
    const state = await fixture(`stopped-tree-${signal.toLowerCase()}`), marker = path.join(state.jobDir,'downloader-lifecycle');
    const running = download(state, ['--url',signedUrl], 'slow-download-tree', {CBA_TEST_DOWNLOAD_LIFECYCLE:marker});
    const stopped = assert.rejects(running, error => { assert.match(error.stderr,/录像下载已暂停/); return true; });
    let downloader;
    t.after(() => {
      for (const pid of [running.child.pid,downloader?.pid].filter(Boolean)) try { process.kill(-pid,'SIGKILL'); } catch {}
    });
    downloader = await waitForMarker(marker + '.started');
    const merger = await waitForMarker(marker + '.merger-started');
    process.kill(-running.child.pid,signal);
    await stopped;
    for (const pid of [downloader.pid,merger.pid]) assert.throws(() => process.kill(pid,0), {code:'ESRCH'});
    assert.equal(await fs.readFile(marker + '.stopped','utf8'), String(downloader.pid));
    assert.equal(await fs.readFile(marker + '.merger-stopped','utf8'), String(merger.pid));
    assert.match(await fs.readFile(downloader.output + '.part','utf8'), /^saved download bytes/);
    assert.equal(readJson(downloader.output + '.ytdl').fragment_index, 3);
    const saved = readJson(path.join(state.jobDir,'job.json'));
    assert.match(saved.mediaBlocker,/已暂停/);
    assert.deepEqual(saved.sources,state.job.sources);
    assert.deepEqual(saved.facts,state.job.facts);
    assert.ok(!await fs.stat(path.join(state.jobDir,'.lock')).then(() => true, () => false));
  }
});

function miguDownload(state, args) {
  return exec(process.execPath, [cli, 'download', '--job', state.jobDir, '--python', path.join(bin, 'migu-python'), ...args], {
    timeout: 15000,
    env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      CBA_TEST_DOWNLOAD_ARGS:state.argsFile, CBA_TEST_DOWNLOAD_SOURCE:recording,
      CBA_TEST_RESOLVED_URL:signedUrl, CBA_TEST_RESOLVER_OUTPUT:path.join(state.jobDir,'resolver-output.json')},
  });
}

test('Migu detail pages resolve before download and highlights are not labeled as a full replay', async () => {
  const state = await fixture('migu-detail');
  await miguDownload(state, ['--url','https://www.miguvideo.com/p/detail/968668508']);
  assert.equal(readJson(state.argsFile).at(-1), signedUrl);
  const media = readJson(path.join(state.jobDir,'job.json')).media[0];
  assert.equal(media.kind, 'highlights');
  assert.equal(media.matchConfirmed, false);
  const privateFile = await fs.readFile(path.join(state.jobDir,'resolver-output.json'),'utf8');
  assert.equal(await fs.stat(privateFile).then(()=>true).catch(()=>false), false, 'ephemeral signed URL is removed');
});

test('Migu match pages require an explicit child selection before downloading', async () => {
  const state = await fixture('migu-playlist');
  await assert.rejects(miguDownload(state, ['--url','https://www.miguvideo.com/p/live/120000594061']));
  assert.equal(await fs.stat(state.argsFile).then(()=>true).catch(()=>false), false);
  const log = await fs.readFile(path.join(state.jobDir,'downloads/download-error.log'),'utf8');
  assert.match(log, /968668508/);
  await miguDownload(state, ['--url','https://www.miguvideo.com/p/live/120000594061','--content-id','968668508']);
  assert.equal(readJson(state.argsFile).at(-1), signedUrl);
  assert.equal(readJson(path.join(state.jobDir,'job.json')).media[0].kind, 'highlights');
});

test('a resolved Migu highlight cannot be explicitly imported as a full replay', async () => {
  const state = await fixture('migu-highlight-kind');
  await assert.rejects(miguDownload(state, ['--url','https://www.miguvideo.com/p/detail/968668508/','--kind','full_replay']));
  assert.equal(await fs.stat(state.argsFile).then(()=>true).catch(()=>false), false);
  assert.deepEqual(readJson(path.join(state.jobDir,'job.json')).media, []);
  const log = await fs.readFile(path.join(state.jobDir,'downloads/download-error.log'),'utf8');
  assert.match(log, /不能按完整回放导入/);
  const privateFile = await fs.readFile(path.join(state.jobDir,'resolver-output.json'),'utf8');
  assert.equal(await fs.stat(privateFile).then(()=>true).catch(()=>false), false);
});

test('a single quarter is not imported as a full replay', async () => {
  const state = await fixture('migu-quarter');
  await miguDownload(state, ['--url','https://www.miguvideo.com/p/detail/999000001']);
  assert.equal(readJson(path.join(state.jobDir,'job.json')).media[0].kind, 'highlights');
  await assert.rejects(miguDownload(state, ['--url','https://www.miguvideo.com/p/detail/999000001','--kind','full_replay']));
});

test('long signed stream URLs download to bounded filenames through URL and URL-file inputs', async () => {
  for (const viaFile of [false, true]) {
    const state = await fixture(viaFile ? 'long-url-file' : 'long-url');
    const urlFile = path.join(state.jobDir, 'source-url.txt');
    if (viaFile) await fs.writeFile(urlFile, signedUrl + '\n', {mode: 0o600});
    const args = viaFile ? ['--url-file', urlFile] : ['--url', signedUrl];
    // Download must never imply identity confirmation, even if the general
    // parser accepts this flag for import-media elsewhere.
    await download(state, [...args, '--match-confirmed']);
    const called = readJson(state.argsFile);
    assert.equal(called.at(-1), signedUrl, 'the original signed URL must reach the downloader unchanged');
    assert.equal(called.at(-2), '--', 'a URL must be a positional argument, never an option');
    assert.ok(called.includes('--ignore-config'));
    assert.ok(called.includes('--no-playlist'));
    assert.ok(called.includes('--no-write-info-json'));
    assert.ok(!(await fs.readdir(path.join(state.jobDir, 'downloads'))).some(name => name.endsWith('.info.json')), 'signed URL metadata must not persist beside the downloaded video');
    const saved = readJson(path.join(state.jobDir, 'job.json'));
    assert.equal(saved.media.length, 1);
    const media = saved.media[0], filename = path.basename(media.path);
    assert.ok(Buffer.byteLength(filename) < 120, 'stream URL or extractor id must not become an oversized filename');
    assert.ok(!filename.includes('long-match-stream'));
    assert.ok(!filename.includes(secretToken));
    assert.equal(path.dirname(media.path), await fs.realpath(path.join(state.jobDir, 'downloads')));
    assert.equal(media.matchConfirmed, false, 'obtaining a file is not verification of its match');
    assert.equal(media.matchId, saved.match.id);
    assert.equal(media.kind, 'full_replay');
    assert.equal(media.probe.hasAudio, true);
    assert.ok(media.sha256.length === 64);
    assert.equal(saved.approval, null);
    assert.match(saved.mediaBlocker, /核对比赛身份/);
    assert.deepEqual(saved.sources, state.job.sources);
    assert.equal(saved.status, 'needs_edit');
  }
});

test('download failure redacts signed query parameters from stderr and command-error fallback logs', async () => {
  for (const mode of ['stderr-failure', 'empty-stderr-failure']) {
    const state = await fixture(mode);
    await assert.rejects(download(state, ['--url', signedUrl], mode), error => {
      assert.match(error.stderr, /素材下载未成功/);
      assert.ok(!error.stderr.includes(secretToken), 'CLI diagnostics must not expose the token');
      assert.ok(!error.stderr.includes(signature), 'CLI diagnostics must not expose the signature');
      return true;
    });
    const logPath = path.join(state.jobDir, 'downloads', 'download-error.log');
    const log = await fs.readFile(logPath, 'utf8');
    assert.ok(!log.includes(secretToken));
    assert.ok(!log.includes(signature));
    assert.ok(!log.includes(decodeURIComponent(signature)));
    assert.ok(!log.includes('expires=1999999999'));
    assert.match(log, /\?\[redacted\]/);
    assert.match(log, /video\.example\.invalid/);
    if (process.platform !== 'win32') assert.equal((await fs.stat(logPath)).mode & 0o777, 0o600);
    const saved = readJson(path.join(state.jobDir, 'job.json'));
    assert.equal(saved.status, 'waiting_for_media');
    assert.deepEqual(saved.media, []);
    assert.deepEqual(saved.facts, state.job.facts);
    assert.deepEqual(saved.sources, state.job.sources);
    assert.equal(saved.approval, null);
    assert.match(saved.mediaBlocker, /保留该场任务以便重试/);
    assert.ok(!await fs.stat(path.join(state.jobDir, '.lock')).then(() => true).catch(() => false));
  }
});

test('a transient permission error while probing an exiting process group preserves disk cancellation and stops writes', {skip:process.platform === 'win32'}, async t => {
  const state = await fixture('disk-reserve-probe-race'), runtime = slowDownloader(state,t,'slow-download-tree');
  const originalKill = process.kill;
  let injected = false;
  process.kill = function(pid, signal) {
    if (pid < 0 && signal === 0 && !injected) {
      injected = true;
      throw Object.assign(Error('macOS process group exit race'), {code:'EPERM'});
    }
    return originalKill.call(process,pid,signal);
  };
  try {
    await assert.rejects(main(['download','--job',state.jobDir,'--url',signedUrl], {
      spawnDownload:runtime.spawnDownload,diskCheckIntervalMs:5,
      checkDiskSpace:async () => {
        if (await fs.stat(runtime.marker+'.merger-started').then(()=>true,()=>false))
          throw Object.assign(Error('磁盘空间不足，保留原错误和断点'),{code:'MEDIA_DISK_FULL'});
      },
    }),{code:'MEDIA_DISK_FULL'});
  } finally { process.kill = originalKill; }
  assert.equal(injected,true);
  const downloader = readJson(runtime.marker+'.started'), merger = readJson(runtime.marker+'.merger-started');
  for (const pid of [downloader.pid,merger.pid]) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  assert.equal(await fs.readFile(runtime.marker+'.merger-stopped','utf8'),String(merger.pid));
  const bytes = await fs.readFile(merger.output,'utf8');
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await fs.readFile(merger.output,'utf8'),bytes);
  assert.match(readJson(path.join(state.jobDir,'job.json')).mediaBlocker,/磁盘空间不足/);
});
