#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn, execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {readJson, writeJson, createJob, refreshStatus, validateJob, approveJob, assertApproved,
  editorialDigest, fileHash, digest} from './core.mjs';
import {probeMedia, runHighlighter} from './media.mjs';
import {buildReview} from './review.mjs';
import {renderVideos, renderNews, renderHighlights, narrationOffsetSeconds, narrationParts} from './render.mjs';
import {selectedEditions} from './editions.mjs';
import {CBA_PRODUCTION_POLICY, CBA_NARRATION_POLICY, productionQuality, assertNarrationCoverage} from './production-policy.mjs';
import {searchMiguMatch, mergeMiguSearch} from './migu-search.mjs';
import {assertMediaDiskSpace, watchMediaDiskSpace} from '../../backend/src/services/storage-space.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
export async function renderInputDigest(job, rendererFile = fileURLToPath(new URL('./render.mjs', import.meta.url))) {
  return digest({edit: editorialDigest(job), audio: (job.news?.segments ?? []).map(s => ({id: s.id, sha256: s.audioDigest?.sha256,
    offsetSeconds: narrationOffsetSeconds(s), parts: narrationParts(s)})),
    renderer: await fileHash(rendererFile),
    ...(job.profile?.productionPolicy === CBA_PRODUCTION_POLICY ? {productionPolicy: await fileHash(fileURLToPath(new URL('./production-policy.mjs', import.meta.url))),
      producer: await fileHash(fileURLToPath(import.meta.url))} : {})});
}
/** Measure the actual speech before any encoding; v2 never pads a short clip with a frozen frame. */
export async function validateRenderProduction(job) {
  if (job.profile?.productionPolicy !== CBA_PRODUCTION_POLICY) return;
  const quality = productionQuality(job);
  if (quality.errors.length) throw Error(quality.errors.join('\n'));
  if (!selectedEditions(job).includes('news')) return;
  const segments = [];
  for (const segment of job.news.segments) {
    const footageSeconds = (segment.clipIds || []).reduce((sum, id) => {
      const clip = job.clips.find(item => item.id === id);
      return sum + (clip ? clip.end - clip.start : 0);
    }, 0);
    let narrationSeconds = 0, narrationEnd = 0;
    if (segment.mode !== 'original') {
      if (!segment.audioPath) throw Error(`Narration ${segment.id} missing; run tts for the approved script.`);
      const {stdout} = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', segment.audioPath], {timeout: 30000, maxBuffer: 1024 * 1024});
      const data = JSON.parse(stdout), audio = data.streams?.find(stream => stream.codec_type === 'audio');
      narrationSeconds = Number(audio?.duration || data.format?.duration);
      if (!audio || !Number.isFinite(narrationSeconds) || narrationSeconds <= 0) throw Error(`Narration ${segment.id} has no measurable audio stream.`);
      const parts = narrationParts(segment, narrationSeconds);
      narrationEnd = Math.max(...parts.map(part => part.offset + part.end - part.start));
    }
    segments.push({id: segment.id, footageSeconds, narrationSeconds, narrationEnd});
  }
  assertNarrationCoverage(job, segments);
}
function highlighterRuntime(args) {
  const condaPython = path.join(os.homedir(), 'miniconda3/bin/python');
  return {repoPath: args.repo || process.env.VIDEOHIGHLIGHTER_REPO || path.join(os.homedir(),'Library/Caches/cba-video/VideoHighlighter'),
    pythonPath: args.python || process.env.VIDEOHIGHLIGHTER_PYTHON || (fs.existsSync(condaPython) ? condaPython : 'python3')};
}
const help = `CBA video factory
  doctor
  recommend --input candidates.json
  init --match match.json [--job directory]
  research --job directory --input bundle.json
  import-media --job directory --file replay.mp4 --id replay --kind full_replay --match-confirmed
  download --job directory --url URL [--id replay] [--kind full_replay|highlights] [--content-id MIGU_VIDEO_ID]
  migu-search --job directory
  acquire-media --job directory
  analyze --job directory [--id replay] [--repo path] [--python path] [--config config.json]
  edit --job directory --input edit.json
  block --job directory --message reason
  review --job directory
  approve --job directory --digest REVIEW_DIGEST --note 'actual user approval'
  tts --job directory
  render --job directory
  status --job directory

research imports sources/facts/news. edit replaces clips/news/highlights/tts/match.
Review approval is bound to the exact script, source footage and cut list.
TTS and render require approval; no publish operation is included.`;

export async function withJobLock(directory, operation) {
  fs.mkdirSync(directory, {recursive: true});
  const lock = path.join(directory, '.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error(`Task is locked: ${lock}. Check its PID before recovering an interrupted task.`);
    throw error;
  }
  fs.writeFileSync(fd, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
  try { return await operation(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function inherited(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: 'inherit'});
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error(`${command} exited ${code}`)));
  });
}

async function recordingDownload(args, {signal, spawnDownload = spawn}) {
  signal.throwIfAborted();
  const child = spawnDownload('yt-dlp', args, {
    signal,detached:process.platform !== 'win32',stdio:['ignore','pipe','pipe'],
  });
  let forceTimer, failure, stopping = false;
  const killGroup = killSignal => {
    if (!child?.pid) return;
    try { process.platform === 'win32' ? child.kill(killSignal) : process.kill(-child.pid,killSignal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stopGroup = () => {
    if (stopping) return;
    stopping = true;
    killGroup('SIGTERM');
    if (child?.pid && !forceTimer) forceTimer = setTimeout(() => killGroup('SIGKILL'),2000);
  };
  const groupAlive = () => {
    if (!child?.pid || process.platform === 'win32') return false;
    try { process.kill(-child.pid,0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      // macOS can briefly deny a probe as the final group member exits.
      // Keep polling until absence is established; retain the cancellation cause.
      if (error.code === 'EPERM') return true;
      throw error;
    }
  };
  const output = {stdout:'',stderr:''}, byteCounts = {stdout:0,stderr:0};
  const done = new Promise((resolve,reject) => {
    for (const name of ['stdout','stderr']) child[name].on('data',chunk => {
      byteCounts[name] += chunk.length;
      if (byteCounts[name] > 2**20) {
        failure ||= Object.assign(Error(`yt-dlp ${name} exceeded its output limit`),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
        stopGroup();
      } else output[name] += chunk.toString();
    });
    child.once('error',error => { failure ||= error; });
    child.once('close',(code,exitSignal) => {
      if (failure || code !== 0) reject(Object.assign(failure || Error(`yt-dlp exited ${code ?? exitSignal}: ${args.at(-1)}`),output));
      else resolve(output);
    });
  });
  const timeout = setTimeout(() => {
    failure ||= Object.assign(Error('录像下载超时，已有下载断点保留'),{code:'ETIMEDOUT'});
    stopGroup();
  },2*60*60*1000);
  signal.addEventListener('abort',stopGroup,{once:true});
  if (signal.aborted) stopGroup();
  try {
    const result = await done;
    signal.throwIfAborted();
    return result;
  } catch (error) {
    // yt-dlp may exit before its ffmpeg merger, so stopping only its PID is insufficient.
    stopGroup();
    const deadline = Date.now() + 2000;
    while (groupAlive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,25));
    if (groupAlive()) killGroup('SIGKILL');
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(forceTimer);
    clearTimeout(timeout);
    signal.removeEventListener('abort',stopGroup);
  }
}

export async function importMedia(job, {file, id = 'replay', kind = 'full_replay', matchConfirmed = false}) {
  if (!/^[\w-]+$/.test(id) || !['full_replay', 'highlights'].includes(kind)) throw Error('Invalid media id or kind');
  if (job.media.some(m => m.id === id) && job.clips.some(c => c.mediaId === id)) throw Error('Media id is referenced by clips. Use a new id and remap the edit explicitly.');
  const filename = fs.realpathSync(path.resolve(file));
  const entry = {id, path: filename, kind, matchId: job.match.id, matchConfirmed,
    probe: await probeMedia(filename), sha256: await fileHash(filename)};
  job.media = [...job.media.filter(m => m.id !== id), entry];
  if (matchConfirmed && (kind === 'full_replay' || (job.profile.sourceScope === 'highlights' && kind === 'highlights'))) job.mediaBlocker = null;
  job.approval = null;
  return entry;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const command = argv[0];
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  const names = ['job','input','match','file','id','kind','url','url-file','content-id','repo','python','config','digest','note','message'];
  const {values: args} = parseArgs({args: argv.slice(1), options: Object.fromEntries([
    ...names.map(name => [name, {type: 'string'}]), ['match-confirmed', {type: 'boolean', default: false}],
  ])});
  const required = key => { if (!args[key]) throw Error(`--${key} is required`); return args[key]; };
  if (command === 'doctor') {
    const checks = await Promise.all(['ffmpeg','ffprobe','yt-dlp'].map(async name => {
      try { const result = await exec(name, [name === 'yt-dlp' ? '--version' : '-version']); return {name, available: true, version: result.stdout.split('\n')[0]}; }
      catch { return {name, available: false}; }
    }));
    const {repoPath: repo, pythonPath} = highlighterRuntime(args);
    console.log(JSON.stringify({checks, highlighter: {repo, sourceAvailable: fs.existsSync(path.join(repo, 'pipeline.py')),
      python: pythonPath},
      tts: {runnerAvailable: fs.existsSync(path.join(root,'backend/node_modules/.bin/tsx')), paidRequestsMade: false}}, null, 2));
    return;
  }
  if (command === 'recommend') {
    const input = readJson(required('input'));
    if (!Array.isArray(input)) throw Error('Candidates must be an array');
    const groups = new Map();
    for (const candidate of input) {
      createJob(candidate.match);
      if (!candidate.reason || !candidate.sourceUrls?.length || candidate.sourceUrls.some(url => !/^https?:\/\//.test(url))) throw Error('Each candidate needs its recommendation reason and real source URLs');
      const m = candidate.match;
      const key = [m.date,m.league,...[m.home,m.away].sort()].join('|');
      if (groups.has(key)) groups.get(key).sourceUrls = [...new Set([...groups.get(key).sourceUrls, ...candidate.sourceUrls])];
      else groups.set(key, {...candidate, sourceUrls: [...new Set(candidate.sourceUrls)]});
    }
    console.log(JSON.stringify([...groups.values()], null, 2));
    return;
  }
  if (command === 'init') {
    const job = createJob(readJson(required('match')));
    job.profile = {...job.profile, productionPolicy: CBA_PRODUCTION_POLICY, narrationPolicy: CBA_NARRATION_POLICY, newsSeconds: [90, 180]};
    const directory = path.resolve(args.job || path.join(root, 'data/cba-video', job.match.id));
    await withJobLock(directory, async () => {
      const filename = path.join(directory, 'job.json');
      if (fs.existsSync(filename)) throw Error('Job already exists; resume it with status/research/import-media.');
      writeJson(filename, job);
    });
    console.log(JSON.stringify({jobDir: directory, status: job.status}));
    return;
  }
  const directory = path.resolve(required('job')), jobFile = path.join(directory, 'job.json');
  if (!fs.existsSync(jobFile)) throw Error(`Job missing: ${jobFile}`);
  if (command === 'acquire-media') {
    const {restoreTaskArchivedMedia} = await import('../../backend/src/services/storage-archive.ts');
    await restoreTaskArchivedMedia('cba', path.basename(directory), root);
    const {acquireMedia} = await import('./acquire-media.mjs');
    const result = await acquireMedia({jobDir: directory});
    console.log(JSON.stringify(result, null, 2));
    if (!['verified_media_reused', 'downloaded_needs_verification'].includes(result.status)) process.exitCode = 1;
    return;
  }
  await withJobLock(directory, async () => {
    let job = readJson(jobFile);
    const save = () => writeJson(jobFile, refreshStatus(job));
    if (command === 'research' || command === 'edit') {
      const input = required('input');
      const payload = command === 'research' && fs.statSync(input).isDirectory()
        ? {sources:readJson(path.join(input,'sources.json')),facts:readJson(path.join(input,'facts.json')),news:readJson(path.join(input,'news-draft.json'))}
        : readJson(input);
      const allowed = command === 'research' ? ['sources','facts','news','mediaSearch','matchEvidence'] : ['clips','news','highlights','tts','match','profile','matchEvidence'];
      for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw Error(`Unexpected ${command} field ${key}`);
      if (payload.match && payload.match.id !== job.match.id) throw Error('Cannot change task identity; create a separate match task.');
      if (job.profile?.productionPolicy === CBA_PRODUCTION_POLICY && payload.profile && Object.hasOwn(payload.profile, 'productionPolicy')
        && payload.profile.productionPolicy !== CBA_PRODUCTION_POLICY) throw Error('Cannot downgrade the active CBA production quality policy.');
      if (job.profile?.narrationPolicy === CBA_NARRATION_POLICY && payload.profile && Object.hasOwn(payload.profile, 'narrationPolicy')
        && payload.profile.narrationPolicy !== CBA_NARRATION_POLICY) throw Error('Cannot downgrade the active Xiaolu commentary policy.');
      job = {...job, ...payload, profile: payload.profile ? {...job.profile, ...payload.profile} : job.profile};
      const {errors} = validateJob(job);
      if (errors.length) throw Error(errors.join('\n'));
      save();
    } else if (command === 'migu-search') {
      job.mediaSearch = mergeMiguSearch(job.mediaSearch, await searchMiguMatch(job.match));
      if (!job.media.some(media => media.matchConfirmed && (media.kind === 'full_replay' ||
          (job.profile.sourceScope === 'highlights' && media.kind === 'highlights')))) {
        if (job.mediaSearch.status === 'candidates_found') job.mediaBlocker = `已在咪咕首页站内搜索找到 ${job.mediaSearch.candidates.length} 个视频候选，继续核对比赛身份并下载录像。`;
        else if (job.mediaSearch.status === 'partial') job.mediaBlocker = `咪咕检索尚未完成，已保留 ${job.mediaSearch.candidates.length} 个候选；部分查询失败，需要重试。`;
        else if (job.mediaSearch.status === 'access_blocked') job.mediaBlocker = job.mediaSearch.candidates.length
          ? `本次咪咕检索暂时不可访问；已保留此前 ${job.mediaSearch.candidates.length} 个候选，可继续核对和下载。`
          : '咪咕首页或站内搜索暂时不可访问，需要重试，尚不能判断是否有对应录像。';
        else job.mediaBlocker = '本次咪咕站内检索范围内未找到包含双方球队的视频候选，需要扩大检索或检查比赛信息。';
      }
      save(); console.log(JSON.stringify(job.mediaSearch, null, 2));
    } else if (command === 'import-media') {
      const media = await importMedia(job, {file: required('file'), id: args.id, kind: args.kind, matchConfirmed: args['match-confirmed']});
      save(); console.log(JSON.stringify(media, null, 2));
    } else if (command === 'download') {
      let url = args['url-file'] ? fs.readFileSync(args['url-file'],'utf8').trim() : required('url');
      if (!/^https?:\/\//.test(url)) throw Error('Only an HTTP(S) source URL is accepted');
      const mediaId = args.id || 'replay';
      if (!/^[\w-]+$/.test(mediaId)) throw Error('Invalid media id');
      const downloadDir = path.join(directory, 'downloads'); fs.mkdirSync(downloadDir, {recursive:true});
      const stopped = new AbortController();
      const downloadSignal = dependencies.signal ? AbortSignal.any([dependencies.signal,stopped.signal]) : stopped.signal;
      const stopDownload = () => stopped.abort(Object.assign(Error('录像下载已暂停，原任务和下载断点已保留'),{code:'ABORT_ERR'}));
      process.on('SIGTERM',stopDownload);process.on('SIGINT',stopDownload);
      let resolutionDirectory, resolvedTitle = '';
      try {
        const source = new URL(url);
        if (source.hostname === 'www.miguvideo.com' && /^\/p\/(live|detail)\/\d+\/?$/.test(source.pathname)) {
          resolutionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-migu-resolve-'));
          const urlFile = path.join(resolutionDirectory,'media-url.txt');
          const condaPython = path.join(os.homedir(),'miniconda3/bin/python');
          const python = args.python || process.env.VIDEODL_PYTHON || (fs.existsSync(condaPython) ? condaPython : 'python3');
          const pageUrl = `https://www.miguvideo.com${source.pathname.replace(/\/$/,'')}`;
          const resolverArgs = [path.join(root,'scripts/cba-video/migu_resolve.py'),'--url',pageUrl,'--output',urlFile];
          if (args['content-id']) resolverArgs.push('--content-id',args['content-id']);
          const resolved = JSON.parse((await exec(python,resolverArgs,{timeout:180000,maxBuffer:2**20,signal:downloadSignal})).stdout);
          if (resolved.type === 'playlist') {
            const error = Error(`咪咕赛事页包含多个视频，请指定 --content-id 或使用具体详情页：\n${JSON.stringify(resolved.entries,null,2)}`);
            error.code = 'MIGU_PLAYLIST';
            throw error;
          }
          if (resolved.type !== 'media') throw Error('咪咕解析器未返回可下载的视频');
          url = fs.readFileSync(urlFile,'utf8').trim();
          if (!/^https?:\/\//.test(url)) throw Error('咪咕解析器未返回有效媒体地址');
          resolvedTitle = [resolved.title,resolved.selectedTitle].filter(Boolean).join(' ');
        }
        const highlights = /集锦|精华|半场|第[一二三四1234]节|单节|片段|混剪/.test(resolvedTitle);
        if (highlights && args.kind === 'full_replay') throw Error('解析结果是集锦或片段，不能按完整回放导入');
        const checkDiskSpace = dependencies.checkDiskSpace || assertMediaDiskSpace;
        downloadSignal.throwIfAborted();
        await checkDiskSpace(downloadDir);
        const diskWatcher = watchMediaDiskSpace(downloadDir, {check:checkDiskSpace, intervalMs:dependencies.diskCheckIntervalMs});
        let result;
        try {
          result = await recordingDownload(['--ignore-config','--no-cache-dir','--no-playlist','--no-progress','--socket-timeout','20','--retries','2','--concurrent-fragments','4',
            '--no-write-info-json','--restrict-filenames','--merge-output-format','mp4','-f','bv*[height<=1080]+ba/b[height<=1080]/b','--print','after_move:filepath',
            '-o',path.join(downloadDir,`${mediaId}-${digest(new URL(url).pathname).slice(0,12)}.%(ext)s`),'--',url], {
            spawnDownload:dependencies.spawnDownload,signal:AbortSignal.any([downloadSignal,diskWatcher.signal]),
          });
        } finally { diskWatcher.stop(); }
        const file = result.stdout.trim().split('\n').at(-1);
        if (!file || !path.resolve(file).startsWith(downloadDir + path.sep)) throw Error('Downloader did not return a recording path');
        await importMedia(job, {file,id:args.id,kind:args.kind || (highlights ? 'highlights' : 'full_replay'),matchConfirmed:false});
        job.mediaBlocker = '录像已取得；请核对比赛身份、完整性和解说音轨，再以确认参数导入。';
        save();
      } catch (error) {
        const detail = String(error.stderr || error.message).replace(/https?:\/\/[^\s"']+/g, raw => {
          try { const parsed = new URL(raw); return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}`; }
          catch { return '[media URL redacted]'; }
        });
        fs.writeFileSync(path.join(downloadDir,'download-error.log'), detail, {mode:0o600});
        const interrupted = downloadSignal.aborted || error.code === 'ABORT_ERR' || error.name === 'AbortError';
        job.mediaBlocker = error.code === 'MEDIA_DISK_FULL' ? error.message : interrupted
          ? '录像下载已暂停，原任务和下载断点已保留，可稍后继续。' : error.code === 'MIGU_PLAYLIST'
          ? '咪咕赛事页包含多个视频，请选择具体回放或集锦的详情页，或指定 --content-id；候选见 downloads/download-error.log。'
          : '素材下载未成功，保留该场任务以便重试；详见 downloads/download-error.log。';
        save(); throw Object.assign(Error(job.mediaBlocker), {code:error.code || (interrupted ? 'ABORT_ERR' : undefined)});
      } finally {
        process.removeListener('SIGTERM',stopDownload);process.removeListener('SIGINT',stopDownload);
        if (resolutionDirectory) fs.rmSync(resolutionDirectory,{recursive:true,force:true});
      }
    } else if (command === 'analyze') {
      const media = job.media.find(m => m.id === (args.id || 'replay'));
      if (!media) throw Error('Import the recording before analysis.');
      if (!media.matchConfirmed) throw Error('Confirm match identity and completeness before analyzing.');
      if (await fileHash(media.path) !== media.sha256) throw Error('Recording changed since import; re-import and verify it before analysis.');
      const config = args.config ? readJson(args.config) : {};
      const runtime = highlighterRuntime(args);
      const commit = await exec('git',['-C',runtime.repoPath,'rev-parse','HEAD']).then(r=>r.stdout.trim()).catch(()=>null);
      const signature = digest({sha256:media.sha256,config,repo:runtime.repoPath,commit,
        bridge:await fileHash(path.join(root,'scripts/cba-video/highlighter_bridge.py'))});
      const cacheFile = path.join(directory,`analysis-${media.id}.json`);
      let analysis = fs.existsSync(cacheFile) ? readJson(cacheFile) : null;
      if (analysis?.inputDigest !== signature) {
        const result = await runHighlighter({input:media.path,outputDir:path.join(directory,'analysis',media.id),...runtime,config});
        analysis = {inputDigest:signature,...result}; writeJson(cacheFile,analysis);
      }
      const candidates = analysis.clips.map((clip,i)=>({id:`${media.id}-${i+1}`,mediaId:media.id,start:clip.start,end:clip.end,
        label:clip.label || '待核对的候选回合',verified:false,verificationNote:'',factIds:[]}));
      writeJson(path.join(directory,`candidates-${media.id}.json`),candidates);
      console.log(JSON.stringify({candidateCount:candidates.length,path:cacheFile,semanticVerified:false}));
    } else if (command === 'block') {
      if (args.kind === 'media') job.mediaBlocker = required('message');
      else job.blockers = [required('message')];
      save();
    } else if (command === 'review') {
      const review = await buildReview(job,directory); save(); console.log(JSON.stringify(review,null,2));
    } else if (command === 'approve') {
      approveJob(job,{digest:required('digest'),note:required('note')}); await assertApproved(job); save();
    } else if (command === 'tts') {
      await assertApproved(job);
      if (!selectedEditions(job).includes('news')) { console.log(JSON.stringify({skipped:true,reason:'原声集锦无需口播配音'})); return; }
      await inherited(process.execPath,[path.join(root,'backend/run-tsx.mjs'),path.join(root,'scripts/cba-video/tts-project.mts'),'--job',directory]);
      job = readJson(jobFile);
    } else if (command === 'render') {
      const {restoreTaskArchivedMedia} = await import('../../backend/src/services/storage-archive.ts');
      await restoreTaskArchivedMedia('cba', path.basename(directory), root);
      await assertApproved(job);
      for (const segment of selectedEditions(job).includes('news') ? (job.news?.segments || []).filter(s => s.mode !== 'original') : []) {
        const expected = digest({text:segment.text,tts:job.tts});
        if (!segment.audioPath || segment.audioDigest?.request !== expected || await fileHash(segment.audioPath) !== segment.audioDigest?.sha256) throw Error(`Narration ${segment.id} missing or changed; run tts for the approved script.`);
      }
      await validateRenderProduction(job);
      const renderDigest = await renderInputDigest(job);
      const outputDir = path.join(directory,'renders',renderDigest.slice(0,16));
      const editions = selectedEditions(job), deliveryPath = path.join(outputDir,'delivery.json');
      const requiredArtifacts = [deliveryPath, ...editions.flatMap(kind => [job.outputs?.[kind]?.path,
        job.outputs?.[kind]?.coverPath, ...(kind === 'news' ? [job.outputs?.news?.subtitlePath] : [])])];
      const reusable = job.outputs?.inputDigest === renderDigest
        && requiredArtifacts.every(filename => filename && job.outputs?.artifacts?.some(artifact => artifact.path === filename))
        && (await Promise.all(job.outputs.artifacts.map(async artifact => fs.existsSync(artifact.path)
          && await fileHash(artifact.path) === artifact.sha256))).every(Boolean);
      if (reusable) {
        console.log(JSON.stringify({reused:true,outputs:job.outputs},null,2)); return;
      }
      await assertMediaDiskSpace(directory);
      const renderArgs = {job,jobDir:directory,outputDir,options:job.profile};
      if (editions.length === 2) job.outputs = await renderVideos(renderArgs);
      else {
        const kind = editions[0];
        const output = await (kind === 'news' ? renderNews : renderHighlights)(renderArgs);
        job.outputs = {[kind]: output, warnings: [...output.warnings]};
      }
      const quality = productionQuality(job, {durations: Object.fromEntries(editions.map(kind => [kind, job.outputs[kind].duration]))});
      if (quality.errors.length) throw Error(quality.errors.join('\n'));
      job.outputs.warnings.push(...quality.warnings);
      job.outputs.inputDigest = renderDigest;
      for (const kind of editions) {
        const range = job.profile[`${kind}Seconds`] || (kind === 'news' ? [60, 180] : [180, 300]);
        const output = job.outputs[kind];
        output.sha256 = await fileHash(output.path);
        if (output.duration < range[0] || output.duration > range[1]) job.outputs.warnings.push(`${kind} duration ${output.duration.toFixed(1)}s is outside ${range.join('–')}s; review editorial pacing.`);
      }
      writeJson(deliveryPath, {match:job.match,approval:job.approval,outputs:job.outputs,
        publishing:{platforms:job.profile.platforms,...Object.fromEntries(editions.map(kind => [kind,
          {title:job[kind].title,description:kind === 'news' ? job.news.summary : `${job.match.date} ${job.match.home} 对阵 ${job.match.away}，关键回合集锦。`}]))},sources:job.sources.map(({id,title,url})=>({id,title,url}))});
      job.outputs.artifacts = await Promise.all([...editions.flatMap(kind => [job.outputs[kind].path,
        job.outputs[kind].coverPath, ...(kind === 'news' ? [job.outputs.news.subtitlePath] : [])]),deliveryPath]
        .map(async filename=>({path:filename,sha256:await fileHash(filename)})));
      save(); console.log(JSON.stringify(job.outputs,null,2));
    } else if (command === 'status') {
      refreshStatus(job); console.log(JSON.stringify({match:job.match,status:job.status,digest:editorialDigest(job),
        review:job.review,blockers:[...job.blockers,...(job.mediaBlocker?[job.mediaBlocker]:[])],validation:validateJob(job,{ready:true}),outputs:job.outputs},null,2));
    } else throw Error(`Unknown command ${command}\n${help}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {console.error(error.message);process.exitCode=1;});
}
