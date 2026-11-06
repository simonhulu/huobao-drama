import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalTeam, teamTerms} from './migu-search.mjs';
import {matchEvidenceErrors} from './production-policy.mjs';
const confirmedMatch = job => job.match?.verified === true && !matchEvidenceErrors(job).length;

export function matchKey(match) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(match?.date || '') || !match.home || !match.away) return null;
  const teams = [canonicalTeam(match.home), canonicalTeam(match.away)].sort();
  return teams[0] !== teams[1] ? `${match.date}:${teams.join(':')}` : null;
}

export function localMediaPath(file, root) {
  if (typeof file !== 'string' || !file) return null;
  try {
    const base = fs.realpathSync(root), resolved = fs.realpathSync(path.resolve(base, file));
    const relative = path.relative(base, resolved), stat = fs.statSync(resolved);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      && stat.isFile() && stat.size > 0 ? resolved : null;
  } catch { return null; }
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.hash = ''; return url.href;
  } catch { return undefined; }
}
function miguUrl(value) {
  const url = publicUrl(value);
  return /^https:\/\/www\.miguvideo\.com\/p\/(?:live|detail)\/\d+\/?$/.test(url || '') ? url : undefined;
}
export function normalizedScore(match) {
  const parts = String(match.score || '').match(/^(\d+)\s*[-–—:：比]\s*(\d+)$/);
  if (!parts) return null;
  return [[canonicalTeam(match.home), parts[1]], [canonicalTeam(match.away), parts[2]]].sort((a,b) => a[0].localeCompare(b[0])).map(pair => pair.join(':')).join('|');
}
function evidenceFor(job) {
  const evidence = [];
  const sourceIds = job.matchEvidence?.sourceIds;
  for (const source of job.sources || []) {
    if (sourceIds?.length && !sourceIds.includes(source.id)) continue;
    const url = publicUrl(source.url);
    if (url) evidence.push({label: source.title || '新闻原文', url,
      detail: job.matchEvidence?.sourceExcerpt || (source.url === job.match?.seedUrls?.[0] ? '主报道；比赛日期与新闻发布日期分别记录' : '已保存的事实来源')});
  }
  for (const snapshot of [job.mediaSearch, job.mediaSearch?.lastSuccessfulSearch]) {
    for (const page of snapshot?.matchPages || []) {
      if (page.date !== job.match?.date || page.dateMatches !== true || page.teamsMatch !== true || !miguUrl(page.url)) continue;
      evidence.push({label: '咪咕赛事页', url: miguUrl(page.url), detail: `${page.date} · ${(page.teams || []).map(team => `${team.name} ${team.score ?? ''}`).join(' / ')}`});
    }
  }
  return [...new Map(evidence.map(item => [item.url, item])).values()];
}

/** A read-only inventory. Historical download flags cannot stand in for a local file. */
export function buildMatchLibrary(records, {root}) {
  const grouped = new Map();
  for (const record of records) {
    const key = matchKey(record.job?.match);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  return [...grouped.entries()].map(([key, rows]) => {
    const first = rows.find(row => row.job.match.verified) || rows[0], match = first.job.match;
    const scores = new Set(rows.filter(row => row.job.match.verified).map(row => normalizedScore(row.job.match)).filter(Boolean));
    const conflict = scores.size > 1;
    const files = new Map(), candidates = new Map();
    for (const {id: jobId, job} of rows) {
      const snapshots = [job.mediaSearch, job.mediaSearch?.lastSuccessfulSearch].filter(Boolean);
      const official = new Map(snapshots.flatMap(snapshot => (snapshot.matchPages || [])
        .filter(page => page.date === match.date && page.dateMatches === true && page.teamsMatch === true)
        .flatMap(page => page.replayEntries || [])).map(entry => [entry.url, entry]));
      for (const candidate of [...snapshots.flatMap(snapshot => snapshot.candidates || []), ...official.values()]) {
        const url = miguUrl(candidate.url);
        if (url) candidates.set(url, {title: candidate.title || '咪咕视频候选', url, duration: Number(candidate.durationSeconds) || candidates.get(url)?.duration || 0,
          identityConfirmed: official.has(url) || candidates.get(url)?.identityConfirmed === true});
      }
      for (const media of job.media || []) {
        const file = localMediaPath(media.path, root), available = !!file;
        const verified = !conflict && confirmedMatch(job) && media.matchConfirmed === true && media.matchId === job.match.id
          && !!media.sha256 && Number(media.probe?.duration) > 0 && media.probe?.hasAudio === true;
        const contentId = /^migu-(\d+)$/.exec(media.id || '')?.[1];
        const sourceUrl = miguUrl(media.acquisition?.candidate?.url) || miguUrl(media.sourceUrl)
          || [...candidates.keys()].find(url => contentId && url.endsWith(`/${contentId}`));
        const safeIds = /^[\w-]+$/.test(jobId) && /^[\w-]+$/.test(media.id || '');
        const value = {id: media.id, jobId, fileName: path.basename(media.path || '未知文件'), kind: media.kind,
          duration: Number(media.probe?.duration) || 0, available, verified, sourceUrl,
          previewUrl: available && safeIds ? `/api/v1/cba-video/jobs/${jobId}/source-media/${media.id}` : undefined};
        const fileKey = media.sha256 || file || `${jobId}:${media.id}`;
        const previous = files.get(fileKey);
        if (!previous || Number(available) * 2 + Number(verified) > Number(previous.available) * 2 + Number(previous.verified)) files.set(fileKey, value);
      }
    }
    // Search results can contain other seasons of the same pairing. Once an
    // official match page supplies its replay list, show that game's candidates.
    if ([...candidates.values()].some(candidate => candidate.identityConfirmed)) {
      for (const [url, candidate] of candidates) if (!candidate.identityConfirmed) candidates.delete(url);
    }
    const fileList = [...files.values()];
    let status = 'not_downloaded', label = candidates.size ? '已找到候选 · 尚未下载' : '尚未下载 · 待检索咪咕';
    if (fileList.some(file => file.available && file.verified)) { status = 'ready'; label = '已下载 · 比赛已核验'; }
    else if (fileList.some(file => file.available)) { status = 'downloaded_unverified'; label = '已下载 · 待核验比赛'; }
    else if (fileList.length) { status = 'missing'; label = '原素材已不在本地 · 需重新下载'; }
    else if (rows.some(row => ['access_blocked','partial'].includes(row.job.mediaSearch?.status))) { status = 'search_failed'; label = '检索未完成 · 尚未下载'; }
    else if (!candidates.size && rows.some(row => row.job.mediaSearch?.status === 'not_found' && row.job.mediaSearch.completed)) { status = 'not_found'; label = '本次检索未找到录像'; }
    const id = `match-${createHash('sha256').update(key).digest('hex').slice(0,20)}`;
    return {id, key, date: match.date, home: match.home, away: match.away, score: conflict ? undefined : match.score,
      verified: !conflict && rows.some(row => confirmedMatch(row.job)), conflict,
      jobIds: rows.map(row => row.id), matchIds: [...new Set(rows.map(row => row.job.match.id))], newsCount: rows.length,
      evidence: [...new Map(rows.flatMap(row => evidenceFor(row.job)).map(item => [item.url, item])).values()],
      footage: {status, label, matchId: id, files: fileList, candidateCount: candidates.size, candidates: [...candidates.values()]}};
  }).sort((a,b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/** A title can suggest candidates, but cannot prove which recording belongs to the report. */
export function linkNewsToMatch(news, matches) {
  const key = matchKey(news.match);
  const direct = key ? matches.find(match => match.key === key) : undefined;
  if (direct) {
    const confirmed = confirmedMatch(news) && direct.verified;
    return {status: direct.conflict ? 'ambiguous' : confirmed ? 'confirmed' : 'candidate', matchId: direct.id,
      date: direct.date, home: direct.home, away: direct.away, score: direct.score,
      reason: direct.conflict ? '同场记录的比分冲突，需核对原文与咪咕赛事页' : confirmed
        ? news.matchEvidence?.reason || '已核对比赛日期、双方球队和任务中的比赛身份；可查看新闻来源与咪咕赛事证据'
        : '已保存比赛线索，尚未确认新闻与该场比赛的关系',
      evidence: evidenceFor(news), candidates: []};
  }
  if (news.status === 'needs_editorial_route' || news.noCorrespondingVideo)
    return {status: 'not_applicable', reason: news.reason || '这条新闻不对应一场明确比赛，需另选相关资料画面', evidence: [], candidates: []};
  const text = [news.title, news.text, news.sourceExcerpt, news.matchEvidence?.sourceExcerpt].filter(Boolean).join(' ');
  const dates = [...text.matchAll(/\b(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})日?/g)].map(m => `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
  const candidates = matches.filter(match => {
    if (news.matchId && match.matchIds.includes(news.matchId)) return true;
    return teamTerms(match.home).some(team => text.includes(team)) && teamTerms(match.away).some(team => text.includes(team))
      && (!dates.length || dates.includes(match.date));
  }).map(match => ({matchId: match.id, date: match.date, home: match.home, away: match.away, score: match.score,
    reason: dates.includes(match.date) ? '正文线索包含双方和该比赛日期，待核验来源' : '出现双方球队，仍需核对比赛日期与比分'}));
  return {status: candidates.length > 1 ? 'ambiguous' : candidates.length ? 'candidate' : 'unmatched',
    reason: candidates.length > 1 ? '有多场候选，不能仅凭球队或新闻发布日期确定比赛' : candidates.length
      ? '找到比赛候选，核对原文日期、双方和比分后才能用于生产' : '尚未确认对应比赛；先读取正文中的日期、双方、比分和事件',
    evidence: [], candidates};
}
