import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readJson, writeJson, fileHash, refreshStatus} from './core.mjs';
import {probeMedia} from './media.mjs';
import {mergeMiguSearch, durationSeconds} from './migu-search.mjs';
import {withJobLock} from './cli.mjs';
import {matchKey, localMediaPath, normalizedScore} from './match-library.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const pagePattern = /^https:\/\/www\.miguvideo\.com\/p\/(live|detail)\/([0-9]+)$/;
const sameMatch = (left, right) => left?.date === right?.date && left?.home && left?.away
  && [left.home, left.away].sort().join('|') === [right.home, right.away].sort().join('|');
const allows = (scope, kind) => kind === 'full_replay' || scope === 'highlights' && kind === 'highlights';
const readOptional = filename => { try { return readJson(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export function redactAcquisitionError(value) {
  return String(value || '').replace(/https?:\/\/[^\s"'<>]+/g, url => pagePattern.test(url) ? url : '[URL 已脱敏]')
    .replace(/\b(token|sign|signature|authorization|cookie|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[已脱敏]').slice(-1800);
}

function errorClass(error, fallback) {
  const text = `${error.code || ''} ${error.message || ''} ${error.stderr || ''} ${error.detail || ''}`;
  if (/EACCES|EPERM|permission|权限/i.test(text)) return 'permission_denied';
  if (/ETIMEDOUT|timeout|timed out|超时/i.test(text) || error.killed) return 'timeout';
  if (/hash|fingerprint|指纹/i.test(text)) return 'hash_mismatch';
  if (/ffprobe|usable video|audio|无音轨|incomplete recording/i.test(text)) return 'invalid_media';
  if (/\b(?:401|403)\b|登录|鉴权|会员|付费|unauthorized|forbidden/i.test(text)) return 'authentication_required';
  if (/\b(?:404|410)\b|已下架|不存在|not found/i.test(text)) return 'media_not_found';
  if (/ENOTFOUND|ECONN|fetch failed|HTTP [45]|解析服务|网络/i.test(text)) return 'network_or_parser';
  return fallback;
}

function kindFromTitle(title) {
  if (/半场|单节|第[一二三四1234]节|片段|混剪|盘点|个人/.test(title)) return null;
  if (/全场集锦|完整集锦/.test(title)) return 'highlights';
  if (/全场(?:回放|录像)|完整(?:回放|录像)|比赛回放/.test(title) && !/集锦|精华/.test(title)) return 'full_replay';
  return null;
}

/** Match-page membership establishes identity; duration then search order selects footage. */
export function officialMediaCandidates(job) {
  const scope = job.profile?.sourceScope ?? 'full_replay';
  const candidates = new Map();
  for (const [origin, snapshot] of [['latest', job.mediaSearch], ['lastSuccessfulSearch', job.mediaSearch?.lastSuccessfulSearch]]) {
    if (snapshot?.provider !== 'migu' || !sameMatch(snapshot.match, job.match)) continue;
    const searchResults = snapshot.candidates || [];
    for (const page of snapshot.matchPages || []) {
      if (pagePattern.exec(page.url)?.[1] !== 'live' || page.dateMatches !== true || page.teamsMatch !== true || page.date !== job.match.date) continue;
      for (const entry of page.replayEntries || []) {
        const match = pagePattern.exec(entry.url);
        const searchIndex = searchResults.findIndex(item => item.url === entry.url);
        const searched = searchResults[searchIndex], searchTitle = String(searched?.title || '');
        let kind = kindFromTitle(String(entry.title || ''));
        // The workbench permits same-match highlights, including partial or
        // inconsistently titled clips. They remain unconfirmed after download.
        if (scope === 'highlights' && (kind !== 'full_replay' || searchTitle && kindFromTitle(searchTitle) !== 'full_replay')) kind = 'highlights';
        if (scope === 'full_replay' && /集锦|精华|半场|单节|第[一二三四1234]节|片段|混剪/.test(searchTitle)) kind = null;
        if (match?.[1] !== 'detail' || !allows(scope, kind) || candidates.has(entry.url)) continue;
        const seconds = Math.max(durationSeconds(entry.duration), durationSeconds(searched?.duration),
          ...[entry.durationSeconds, searched?.durationSeconds].map(value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0));
        candidates.set(entry.url, {url: entry.url, contentId: match[2], kind, title: redactAcquisitionError(entry.title),
          searchTitle: redactAcquisitionError(searchTitle), titleConflict: !!searchTitle && !!entry.title && searchTitle !== entry.title,
          duration: entry.duration || searched?.duration || null, durationSeconds: seconds,
          searchIndex: searchIndex < 0 ? Number.MAX_SAFE_INTEGER : searchIndex,
          matchPageUrl: page.url, searchOrigin: origin, searchedAt: snapshot.searchedAt || null,
          identity: {date: page.date, home: snapshot.match.home, away: snapshot.match.away, dateMatches: true, teamsMatch: true}});
      }
    }
  }
  return [...candidates.values()].sort((a, b) => b.durationSeconds - a.durationSeconds || a.searchIndex - b.searchIndex);
}

function clearDeadLock(filename) {
  const lock = readOptional(filename);
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return;
  try { process.kill(lock.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') fs.unlinkSync(filename); }
}

function command(operation, jobDir, candidate, id) {
  return {file: process.execPath, args: [cli, operation, '--job', jobDir,
    ...(candidate ? ['--url', candidate.matchPageUrl, '--content-id', candidate.contentId, '--id', id, '--kind', candidate.kind] : [])]};
}

async function runSearch({command: invocation}) {
  const result = await exec(invocation.file, invocation.args, {timeout: 360000, maxBuffer: 4 * 1024 * 1024});
  return JSON.parse(result.stdout);
}

function logStamp(filename) {
  try { const stat = fs.statSync(filename); return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function runDownload({jobDir, command: invocation}) {
  const errorLog = path.join(jobDir, 'downloads/download-error.log'), previousStamp = logStamp(errorLog);
  try { await exec(invocation.file, invocation.args, {timeout: 2 * 60 * 60 * 1000 + 200000, maxBuffer: 2 * 1024 * 1024}); }
  catch (error) {
    // Only details written by this invocation can explain this invocation.
    if (logStamp(errorLog) !== previousStamp) error.detail = fs.readFileSync(errorLog, 'utf8');
    throw error;
  }
}

/**
 * Acquire one local source, never confirm its match or completeness.
 * Adapters receive {jobDir, command, candidate?, id?}; search returns a Migu
 * search report, download may return {file}, probe returns probeMedia metadata.
 */
export async function acquireMedia({jobDir}, adapters = {}) {
  const directory = path.resolve(jobDir), jobFile = path.join(directory, 'job.json');
  const initialJob = readJson(jobFile), scope = initialJob.profile?.sourceScope ?? 'full_replay';
  if (!['full_replay', 'highlights'].includes(scope)) throw Error('Invalid sourceScope');
  const now = adapters.now || (() => new Date().toISOString());
  const probe = adapters.probe || probeMedia;
  const archiveDir = path.join(directory, 'media-acquisition'), latestPath = path.join(directory, 'media-acquisition.json');
  const previousRun = readOptional(latestPath);
  const lockPath = path.join(directory, '.acquire-media.lock');
  clearDeadLock(lockPath);
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lock, JSON.stringify({pid: process.pid, startedAt: now()}));
  const runId = randomUUID(), reportPath = path.join(archiveDir, `${runId}.json`);
  const report = {version: 1, runId, status: 'running', match: initialJob.match, sourceScope: scope,
    startedAt: now(), finishedAt: null, reportPath, attempts: []};
  fs.mkdirSync(archiveDir, {recursive: true, mode: 0o700});
  const saveReport = () => { writeJson(reportPath, report); writeJson(latestPath, report); };
  const updateJob = async mutate => {
    clearDeadLock(path.join(directory, '.lock'));
    return withJobLock(directory, async () => {
      const current = readJson(jobFile);
      if (current.match.id !== initialJob.match.id || !sameMatch(current.match, initialJob.match)) throw Error('Task identity changed during media acquisition');
      mutate(current); writeJson(jobFile, refreshStatus(current));
    });
  };
  const attempt = async (operation, details, work) => {
    const item = {id: `${runId}-${report.attempts.length + 1}`, operation, startedAt: now(), finishedAt: null,
      command: null, ...details, result: 'running'};
    report.attempts.push(item); saveReport();
    try {
      const value = await work(); item.result = 'succeeded';
      if (operation === 'search') item.observed = {status: value.status, completed: value.completed, candidateCount: value.candidates?.length || 0};
      else if (value?.sha256) item.observed = {path: value.path, sha256: value.sha256, probe: value.probe};
      return {ok: true, value};
    }
    catch (error) {
      item.result = 'failed'; item.errorClass = errorClass(error, `${operation}_failed`);
      item.message = redactAcquisitionError([error.message, error.stderr, error.detail].filter(Boolean).join('\n'));
      return {ok: false, errorClass: item.errorClass};
    } finally { item.finishedAt = now(); saveReport(); }
  };
  const inspect = async (file, expectedHash) => {
    const filename = fs.realpathSync(path.resolve(directory, file)), stat = fs.statSync(filename);
    if (!stat.isFile() || !stat.size) throw Error('Video file does not exist or is empty');
    const sha256 = await fileHash(filename);
    if (expectedHash && expectedHash !== sha256) throw Error('Media fingerprint/hash changed since import');
    const metadata = await probe(filename);
    if (!(metadata.duration > 0 && metadata.width > 0 && metadata.height > 0 && metadata.hasAudio === true))
      throw Error('Recording has no usable video/audio stream');
    return {path: filename, sha256, probe: metadata};
  };
  const finish = async (status, details) => {
    report.status = status; Object.assign(report, details); report.finishedAt = now();
    await updateJob(job => {
      job.mediaBlocker = status === 'verified_media_reused' ? null : status === 'downloaded_needs_verification'
        ? '录像已取得；请核对比赛身份、完整性和解说音轨，再以确认参数导入。' : details.failure.message;
    });
    saveReport(); return report;
  };
  const adopt = async (file, candidate, id) => {
    const checked = await inspect(file);
    const media = {id, ...checked, kind: candidate.kind, matchId: initialJob.match.id, matchConfirmed: false,
      acquisition: {runId, candidate}};
    await updateJob(job => {
      const existing = job.media.find(item => item.id === id);
      if (existing && job.clips.some(clip => clip.mediaId === id)) throw Error('Media id is referenced by an edit; cannot replace it');
      job.media = [...job.media.filter(item => item.id !== id), media]; job.approval = null;
    });
    return media;
  };
  try {
    saveReport();
    for (const media of [...initialJob.media].sort((a, b) => Number(b.matchConfirmed === true) - Number(a.matchConfirmed === true))) {
      if (media.matchId !== initialJob.match.id || !allows(scope, media.kind) || !media.sha256) continue;
      const checked = await attempt('probe', {mediaId: media.id, file: media.path, execution: adapters.probe ? 'injected' : 'ffprobe'},
        () => inspect(media.path, media.sha256));
      if (checked.ok) return await finish(media.matchConfirmed === true ? 'verified_media_reused' : 'downloaded_needs_verification',
        {reused: true, media: {...media, ...checked.value}});
    }
    // Same-match news shares one physical recording. Recheck bytes and streams
    // before adopting it; a historical download flag or a title is insufficient.
    const libraryRoot = path.dirname(directory);
    if (initialJob.match.verified === true) for (const entry of fs.readdirSync(libraryRoot, {withFileTypes: true})) {
      if (!entry.isDirectory() || !/^[\w-]+$/.test(entry.name)) continue;
      const sourceJobDir = path.join(libraryRoot, entry.name);
      if (sourceJobDir === directory) continue;
      let sourceJob;
      try { sourceJob = readOptional(path.join(sourceJobDir, 'job.json')); } catch { continue; }
      if (!sourceJob?.match?.verified || matchKey(sourceJob.match) !== matchKey(initialJob.match)) continue;
      // A different score for the same pairing is unresolved evidence, not reuse.
      if (normalizedScore(sourceJob.match) && normalizedScore(initialJob.match)
        && normalizedScore(sourceJob.match) !== normalizedScore(initialJob.match)) continue;
      for (const media of sourceJob.media || []) {
        if (!media.matchConfirmed || media.matchId !== sourceJob.match.id || !media.sha256 || !allows(scope, media.kind)
          || !localMediaPath(media.path, libraryRoot)) continue;
        const checked = await attempt('reuse', {mediaId: media.id, sourceJobDir, execution: adapters.probe ? 'injected' : 'ffprobe'},
          () => inspect(media.path, media.sha256));
        if (!checked.ok) continue;
        let adopted;
        await updateJob(job => {
          const sameSource = job.media.find(item => item.sha256 === media.sha256);
          const id = sameSource?.id || (job.media.some(item => item.id === media.id) ? `shared-${media.sha256.slice(0,16)}` : media.id);
          adopted = {...media, ...checked.value, id, matchId: job.match.id,
            reuse: {sourceJobDir, reason: '比赛日期与双方一致，复用已核验录像；本轮已重验文件指纹和音视频流'}};
          job.media = [...job.media.filter(item => item.id !== id), adopted]; job.approval = null;
        });
        return await finish('verified_media_reused', {reused: true, media: adopted});
      }
    }
    let job = readJson(jobFile), candidates = officialMediaCandidates(job);
    if (!candidates.length) {
      const searched = await attempt('search', {command: command('migu-search', directory), execution: adapters.search ? 'injected' : 'subprocess'}, async () => {
        const result = await (adapters.search || runSearch)({jobDir: directory, match: initialJob.match, command: command('migu-search', directory)});
        if (!result || result.provider !== 'migu' || !sameMatch(result.match, initialJob.match)) throw Error('Search returned evidence for another match');
        await updateJob(current => { current.mediaSearch = mergeMiguSearch(current.mediaSearch, result); });
        return result;
      });
      if (!searched.ok) return await finish('access_failed', {failure: {code: searched.errorClass, message: '本轮咪咕检索执行失败，候选已保留；尚不能判断是否存在录像。'}});
      job = readJson(jobFile); candidates = officialMediaCandidates(job);
      if (!candidates.length) {
        const inaccessible = searched.value.completed !== true || (searched.value.matchPages || []).some(page => page.error);
        const availableHighlights = scope === 'full_replay'
          ? officialMediaCandidates({...job, profile: {...job.profile, sourceScope: 'highlights'}}).filter(candidate => candidate.kind === 'highlights') : [];
        if (!inaccessible && availableHighlights.length) return await finish('scope_mismatch', {
          availableCandidates: availableHighlights,
          failure: {code: 'source_scope_mismatch', requiredScope: scope, availableScope: 'highlights',
            message: `已核对 ${availableHighlights.length} 个本场官方集锦或片段的比赛日期、球队和赛事页归属，但当前任务要求完整回放（full_replay），因此尚未下载这些素材。`},
        });
        const hasLeads = Boolean(searched.value.candidates?.length || searched.value.matchPages?.some(page => page.replayEntries?.length));
        return await finish(inaccessible ? 'access_failed' : hasLeads ? 'identity_unverified' : 'media_not_found', {failure: {
          code: inaccessible ? 'search_incomplete' : hasLeads ? 'official_identity_or_scope_unverified' : 'no_candidates_in_search',
          message: inaccessible ? '本轮咪咕检索或赛事页访问未完成；尚不能判断是否存在录像。'
            : hasLeads ? '已有视频线索，但官方比赛身份或完整素材范围证据不足，需要继续核验；不能据此认定无录像。'
              : '本轮完整咪咕检索未找到视频候选；结果仅代表本次检索范围。'}});
      }
    }
    report.candidates = candidates; saveReport();
    for (const candidate of candidates.slice(0, 3)) {
      let id = `migu-${candidate.contentId}`;
      // A prior attempt proves why this deterministic filename belongs here.
      const interrupted = previousRun?.match?.id === initialJob.match.id && sameMatch(previousRun.match, initialJob.match)
        ? previousRun.attempts?.find(item => item.operation === 'download' && item.candidate?.url === candidate.url
          && item.candidate?.matchPageUrl === candidate.matchPageUrl && item.candidate?.kind === candidate.kind && /^[\w-]+$/.test(item.mediaId || '')) : null;
      if (interrupted) {
        id = interrupted.mediaId;
        const downloads = path.join(directory, 'downloads');
        const files = fs.existsSync(downloads) ? fs.readdirSync(downloads).filter(file =>
          file.startsWith(`${id}-`) && /^[a-f0-9]{12}\.(mp4|mkv|webm|mov)$/.test(file.slice(id.length + 1))) : [];
        for (const file of files.sort()) {
          const recovered = await attempt('recover', {candidate, mediaId: id, file: path.join(downloads, file), execution: 'local'}, () => adopt(path.join(downloads, file), candidate, id));
          if (recovered.ok) return await finish('downloaded_needs_verification', {reused: true, media: recovered.value});
        }
      }
      if (readJson(jobFile).clips.some(clip => clip.mediaId === id)) id += `-${runId.slice(0, 8)}`;
      const invocation = command('download', directory, candidate, id);
      const downloaded = await attempt('download', {candidate, mediaId: id, command: invocation, execution: adapters.download ? 'injected' : 'subprocess'}, async () => {
        clearDeadLock(path.join(directory, '.lock'));
        const result = await (adapters.download || runDownload)({jobDir: directory, candidate, id, command: invocation});
        const file = result?.file || readJson(jobFile).media.find(media => media.id === id)?.path;
        if (!file) throw Error('Downloader did not provide a local recording');
        return adopt(file, candidate, id);
      });
      if (downloaded.ok) return await finish('downloaded_needs_verification', {reused: false, media: downloaded.value});
    }
    const failures = report.attempts.filter(item => item.operation === 'download');
    const missing = failures.length && failures.every(item => item.errorClass === 'media_not_found');
    return await finish(missing ? 'media_not_found' : 'access_failed', {failure: {code: missing ? 'candidate_media_missing' : 'candidate_attempts_failed',
      message: missing ? '本轮尝试的官方视频均返回不存在或已下架；候选证据已保留。' : '本轮最多尝试 3 个官方视频候选仍未取得可用素材；已保留候选和本轮错误，可再次重试。'}});
  } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
