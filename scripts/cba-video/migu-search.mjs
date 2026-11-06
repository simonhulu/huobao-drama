import {randomUUID} from 'node:crypto';

export const MIGU_HOME_URL = 'https://www.miguvideo.com/p/home';
// Public endpoint used by /p/search, verified against its search.js on 2026-10-24.
export const MIGU_SEARCH_URL = 'https://jadeite.migu.cn/search/v3/open-search';
const aliases = [
  ['北控', '北京控股'], ['江苏', '江苏肯帝亚'], ['山东', '山东高速'],
  ['南京', '南京同曦', '南京同曦宙光'], ['辽宁', '辽宁本钢'],
  ['四川', '四川锦城', '四川丰谷酒业'], ['天津', '天津先行者'],
  ['广州', '广州龙狮', '广州智都集团'], ['广东', '广东东阳光'],
  ['深圳', '深圳马可波罗'], ['北京', '北京首钢', '北京北汽'],
  ['浙江', '浙江稠州金租'], ['广厦', '浙江广厦', '浙江浙商证券', '浙证'],
  ['青岛', '青岛崂山啤酒'], ['吉林', '吉林长白山恩都里', '长白山恩都里'],
  ['宁波', '宁波町渥'], ['上海', '上海久事'], ['福建', '福建浔兴', '福建晋江文旅'],
  ['山西', '山西汾酒'], ['新疆', '新疆伊力特', '新疆广汇'],
];
export const teamTerms = team => aliases.find(group => group.includes(team)) || [team];
const text = value => typeof value === 'string' ? value.trim() : '';
export const canonicalTeam = team => teamTerms(text(team))[0];
const sameTeams = (names, match) => names.length === 2 && (
  canonicalTeam(names[0]) === canonicalTeam(match.home) && canonicalTeam(names[1]) === canonicalTeam(match.away)
  || canonicalTeam(names[1]) === canonicalTeam(match.home) && canonicalTeam(names[0]) === canonicalTeam(match.away)
);

export function durationSeconds(value) {
  if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text(value))) return 0;
  return value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function queryTerms(match) {
  const home = teamTerms(match.home), away = teamTerms(match.away);
  // Search with the commonly indexed official names. Some current-season
  // assets use short labels such as “浙证”, so the final alias is reserved
  // for title matching rather than becoming the only discovery query.
  const preferred = group => group.length > 2 ? group.at(-2) : group.at(-1);
  const queries = [`${home[0]} ${away[0]}`, `${preferred(home)} ${preferred(away)}`];
  // The official 26/27 Guangsha assets are indexed as “浙证vs吉林”. Keep a
  // short-home/short-away pass for teams whose content uses a different
  // editorial abbreviation than the live match page.
  if (home.length > 2) queries.push(`${home.at(-1)} ${away[0]}`);
  queries.push(`${match.date} ${home[0]} ${away[0]}`);
  return [...new Set(queries)];
}

// Read JSON only. Never evaluate third-party scripts.
export function embeddedJson(html, name) {
  const marker = new RegExp(`window\\.${name}\\s*=\\s*`);
  const found = marker.exec(html);
  if (!found) throw Error(`咪咕页面未提供 ${name}，需要更新页面解析`);
  const start = found.index + found[0].length;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') { if (--depth === 0) return JSON.parse(html.slice(start, i + 1)); }
  }
  throw Error(`咪咕页面的 ${name} 不完整`);
}

export function extractCandidates(payload, match, query, page = 1) {
  let list = payload?.body?.contentInfoList;
  // The real API omits contentInfoList after the final page (including zero results).
  const totalPages = Number(payload?.body?.totalPage), totalCount = Number(payload?.body?.totalCount);
  if (list == null && Number.isFinite(totalPages) && Number.isFinite(totalCount) && (page > totalPages || totalCount === 0)) list = [];
  if (!Array.isArray(list)) throw Error('咪咕搜索结果结构变化，未取得可用的结果列表');
  return list.flatMap(item => {
    const asset = item.shortMediaAsset;
    if (!asset) return [];
    const title = text(asset.name || asset.title);
    if (/中超|中甲|英超|欧冠|足球|津门虎/.test(`${title} ${text(asset.wcKeyword)}`)) return [];
    if (!teamTerms(match.home).some(term => title.includes(term)) || !teamTerms(match.away).some(term => title.includes(term))) return [];
    const contentId = String(asset.action?.params?.contentID || asset.pID || '');
    if (!/^\d+$/.test(contentId)) return [];
    const duration = durationSeconds(asset.duration);
    const partial = /集锦|精华|半场|单节|第[一二三四1234]节|混剪|盘点/.test(title);
    const replayCandidate = duration >= 2700 && !partial;
    const publicationDateHint = text(asset.publishTime || asset.publishTimestamp).startsWith(match.date);
    const publishedDate = text(asset.publishTime || asset.publishTimestamp).slice(0, 10);
    const daysFromMatch = Math.abs(Date.parse(publishedDate) - Date.parse(match.date)) / 86400000;
    const dateRank = !Number.isFinite(daysFromMatch) ? 0 : daysFromMatch <= 1 ? 4 : daysFromMatch <= 3 ? 2 : -10;
    const matchPageId = /^120\d{9}$/.test(String(asset.mpId)) ? String(asset.mpId) : null;
    return [{url: `https://www.miguvideo.com/p/detail/${contentId}`, contentId, title, query,
      publishedAt: text(asset.publishTimestamp || asset.publishTime) || null,
      duration: text(asset.duration) || null, durationSeconds: duration, contentType: text(asset.contentType) || null,
      matchPageUrl: matchPageId ? `https://www.miguvideo.com/p/live/${matchPageId}` : null,
      replayCandidate, verified: false,
      score: dateRank + (replayCandidate ? 5 : 0),
      matchEvidence: {teamNamesInTitle: true, publicationDateHint, matchDateConfirmed: false},
    }];
  });
}

export function extractMatchPage(html, url, match) {
  const data = embeddedJson(html, '__INITIAL_BASIC_DATA__');
  const id = new URL(url).pathname.split('/').at(-1), result = data[id];
  if (result?.code !== 200 || !result.body?.confrontTeams) throw Error('赛事页缺少双方球队信息');
  const body = result.body;
  const teams = body.confrontTeams.map(team => ({name: text(team.name), score: team.score, isHome: team.isHome === '1'}));
  const timestamp = Number(body.matchStartTime);
  const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10) : null;
  const teamsMatch = sameTeams(teams.map(team => team.name), match);
  return {url, title: text(body.detailPageTitle || body.title), date, teams,
    teamsMatch, dateMatches: date === match.date,
    replayEntries: (body.multiPlayList?.replayList || []).map(item => ({title: text(item.name), duration: text(item.duration),
      url: /^\d+$/.test(String(item.pID)) ? `https://www.miguvideo.com/p/detail/${item.pID}` : null})).filter(item => item.url)};
}

// A transient homepage/search outage must not erase the last usable candidate
// set. Retained rows are explicitly marked as cached and never upgrade the
// latest attempt's status, completed flag, or verification claims.
export function mergeMiguSearch(previous, attempt) {
  const sameMatch = (left, right) => left?.home && left?.away && right?.home && right?.away
    && /^\d{4}-\d{2}-\d{2}$/.test(left.date) && left.date === right.date
    && sameTeams([left.home, left.away], right);
  if (!sameMatch(previous?.match, attempt?.match)) return attempt;
  if (attempt.status === 'candidates_found' && attempt.completed === true) return attempt;

  let lastSuccessfulSearch = previous.lastSuccessfulSearch;
  if (!sameMatch(lastSuccessfulSearch?.match, attempt.match)) lastSuccessfulSearch = undefined;
  if (previous.status === 'candidates_found' && previous.completed === true && previous.candidates?.length) {
    const {lastSuccessfulSearch: _old, latestAttempt: _latest, cacheOrigin: _origin, retainedCandidates: _count, ...snapshot} = previous;
    lastSuccessfulSearch = structuredClone(snapshot);
  }
  const latestAttempt = {status: attempt.status, completed: attempt.completed, searchedAt: attempt.searchedAt,
    candidateCount: attempt.candidates?.length || 0, errors: attempt.errors || []};
  const archive = lastSuccessfulSearch ? {lastSuccessfulSearch} : {};
  if (attempt.completed === true) return {...attempt, ...archive, latestAttempt, retainedCandidates: 0};

  const freshIds = new Set((attempt.candidates || []).map(candidate => String(candidate.contentId || candidate.url)));
  const cached = previous.candidates?.length ? previous.candidates : lastSuccessfulSearch?.candidates || [];
  const cachedAt = previous.candidates?.length ? previous.searchedAt : lastSuccessfulSearch?.searchedAt;
  const retained = cached
    .filter(candidate => !freshIds.has(String(candidate.contentId || candidate.url)))
    .map(candidate => ({...candidate, searchOrigin: 'retained', retainedFrom: candidate.retainedFrom || cachedAt || null,
      verified: false, matchEvidence: {...(candidate.matchEvidence || {}), matchDateConfirmed: false, latestSearchConfirmed: false}}));
  return {...attempt, ...archive, latestAttempt, candidates: [...(attempt.candidates || []), ...retained],
    ...(retained.length ? {cacheOrigin: lastSuccessfulSearch ? 'previous-successful-search' : 'previous-partial-search'} : {}),
    retainedCandidates: retained.length};
}

async function getPage(url, fetchImpl) {
  const response = await fetchImpl(url, {headers: {'User-Agent': 'Mozilla/5.0', Referer: MIGU_HOME_URL}, signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  return response.text();
}

export async function searchMiguMatch(match, {fetchImpl = globalThis.fetch, now = () => new Date().toISOString()} = {}) {
  if (!match?.home || !match?.away || !/^\d{4}-\d{2}-\d{2}$/.test(match.date)) throw Error('比赛日期和双方球队不能为空');
  const evidence = {provider: 'migu', entryUrl: MIGU_HOME_URL, searchedAt: now(), match: {date: match.date, home: match.home, away: match.away},
    queries: queryTerms(match), scope: '咪咕站内搜索，每组关键词前两页，每页50条',
    requests: [], candidates: [], matchPages: [], status: 'access_blocked', completed: false, errors: []};
  let packId;
  try {
    const html = await getPage(MIGU_HOME_URL, fetchImpl);
    packId = embeddedJson(html, '__GLOBAL_STATE__')?.body?.SEARCH_PACK_ID?.paramValue;
    if (!/^[\d,]+$/.test(packId || '')) throw Error('首页缺少有效的搜索配置');
    evidence.homeRetrieved = true;
  } catch (error) { evidence.errors.push(`咪咕首页：${error.message}`); return evidence; }
  for (const query of evidence.queries) {
    // This follows the public website's two-page search, not an exhaustive archive crawl.
    for (const page of [1, 2]) {
      const request = {query, page, url: `https://www.miguvideo.com/p/search?keywords=${encodeURIComponent(query)}`, status: 'failed'};
      evidence.requests.push(request);
      try {
        const response = await fetchImpl(MIGU_SEARCH_URL, {method: 'POST', headers: {'Content-Type': 'application/json',
          Origin: 'https://www.miguvideo.com', Referer: request.url}, signal: AbortSignal.timeout(30000),
          body: JSON.stringify({appVersion: '6.1.1.00', ct: 101, isCorrectWord: 1, k: query, mediaSource: 9000000, packId,
            pageIdx: page, pageSize: 50, sid: randomUUID(), copyrightTerminal: 3, searchScene: 2, uiVersion: 'A3.26.0'})});
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.code !== 200) throw Error(`搜索返回错误 ${payload.code}`);
        const candidates = extractCandidates(payload, match, query, page);
        evidence.candidates.push(...candidates);
        request.status = 'ok'; request.resultCount = payload.body.contentInfoList?.length || 0;
      } catch (error) { request.error = error.message; evidence.errors.push(`${query} 第${page}页：${error.message}`); }
    }
  }
  const unique = new Map();
  for (const candidate of evidence.candidates) {
    const previous = unique.get(candidate.contentId);
    if (!previous || previous.score < candidate.score) unique.set(candidate.contentId, candidate);
  }
  evidence.candidates = [...unique.values()].sort((a, b) => b.score - a.score || b.durationSeconds - a.durationSeconds);
  const matchPageUrls = [...new Set(evidence.candidates.map(candidate => candidate.matchPageUrl).filter(Boolean))].slice(0, 5);
  for (const url of matchPageUrls) {
    try { evidence.matchPages.push(extractMatchPage(await getPage(url, fetchImpl), url, match)); }
    catch (error) { evidence.matchPages.push({url, error: error.message}); }
  }
  evidence.completed = evidence.requests.length > 0 && evidence.requests.every(request => request.status === 'ok');
  evidence.status = !evidence.completed ? evidence.requests.some(request => request.status === 'ok') ? 'partial' : 'access_blocked'
    : evidence.candidates.length ? 'candidates_found' : 'not_found';
  return evidence;
}
