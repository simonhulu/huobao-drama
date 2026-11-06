import test from 'node:test';
import assert from 'node:assert/strict';
import {embeddedJson, extractCandidates, extractMatchPage, mergeMiguSearch, searchMiguMatch, MIGU_HOME_URL, MIGU_SEARCH_URL} from './migu-search.mjs';
import {createJob, editorialDigest} from './core.mjs';

const match = {id: 'test-match', league: 'CBA', date: '2026-10-23', home: '北控', away: '江苏'};
const home = `<script>window.__GLOBAL_STATE__ = ${JSON.stringify({body: {SEARCH_PACK_ID: {paramValue: '1005722,1002581'}}})};</script>`;
const payload = (assets = []) => ({code: 200, body: {contentInfoList: assets.map(shortMediaAsset => ({contentType: 1, shortMediaAsset}))}});
const replay = {pID: '968671241', name: '正在直播CBA常规赛：北控vs江苏', publishTime: '2026-10-23', duration: '02:26:52', contentType: '全片'};
const respond = value => new Response(typeof value === 'string' ? value : JSON.stringify(value));

test('home is fetched before dynamic pack configuration is used for aliases, date and both pages', async () => {
  const calls = [];
  const evidence = await searchMiguMatch(match, {fetchImpl: async (url, options) => {
    calls.push(url);
    if (url === MIGU_HOME_URL) return respond(home);
    assert.equal(url, MIGU_SEARCH_URL);
    assert.equal(calls[0], MIGU_HOME_URL);
    const body = JSON.parse(options.body);
    assert.equal(body.packId, '1005722,1002581');
    // Candidate on the second page must be discoverable and deduplicated.
    return respond(payload(body.pageIdx === 2 ? [replay] : []));
  }});
  assert.equal(evidence.status, 'candidates_found');
  assert.equal(evidence.completed, true);
  assert.deepEqual(evidence.queries, ['北控 江苏', '北京控股 江苏肯帝亚', '2026-10-23 北控 江苏']);
  assert.equal(evidence.requests.length, 6);
  assert.equal(evidence.candidates.length, 1);
  assert.equal(evidence.candidates[0].verified, false);
  assert.equal(evidence.candidates[0].replayCandidate, true);
  assert.equal(evidence.candidates[0].matchEvidence.matchDateConfirmed, false);
  assert.equal(evidence.selected, undefined);
});

test('a long halftime replay and a short live teaser are not complete-game candidates', () => {
  const candidates = extractCandidates(payload([
    {...replay, pID: '1', name: '北控vs江苏 上半场回放', duration: '01:02:30'},
    {...replay, pID: '2', name: '正在直播北控vs江苏', duration: '00:10'},
    {...replay, pID: '3', name: '10月23日北控vs江苏 全场回放', publishTime: '2025-10-23'},
    {...replay, pID: '4', name: '山东vs南京全场回放'},
    {...replay, pID: '5', name: '天津津门虎vs广州队中超全场回放'},
  ]), match, '北控 江苏');
  assert.deepEqual(candidates.map(item => item.contentId), ['1', '2', '3']);
  assert.deepEqual(candidates.map(item => item.replayCandidate), [false, false, true]);
  assert.equal(candidates[2].matchEvidence.publicationDateHint, false);
  assert.ok(candidates.every(item => item.verified === false && item.matchEvidence.matchDateConfirmed === false));
});

test('an omitted results list after the last page is a real empty page, not a schema failure', async () => {
  const evidence = await searchMiguMatch(match, {fetchImpl: async (url, options) => {
    if (url === MIGU_HOME_URL) return respond(home);
    return respond(JSON.parse(options.body).pageIdx === 1 ? payload([replay])
      : {code: 200, body: {totalPage: 1, totalCount: 30, bottomTip: {status: '1'}}});
  }});
  assert.equal(evidence.status, 'candidates_found');
  assert.equal(evidence.completed, true);
  assert.equal(evidence.errors.length, 0);
  assert.ok(evidence.requests.filter(item => item.page === 2).every(item => item.resultCount === 0));
});

test('partial failures preserve found candidates without claiming a completed search', async () => {
  const evidence = await searchMiguMatch(match, {fetchImpl: async (url, options) => {
    if (url === MIGU_HOME_URL) return respond(home);
    return JSON.parse(options.body).pageIdx === 1 ? respond(payload([replay])) : new Response('', {status: 403});
  }});
  assert.equal(evidence.status, 'partial');
  assert.equal(evidence.completed, false);
  assert.equal(evidence.errors.length, 3);
  assert.equal(evidence.candidates.length, 1);
});

test('home failure and changed response schema cannot become not_found', async () => {
  const homeFailure = await searchMiguMatch(match, {fetchImpl: async () => new Response('', {status: 403})});
  assert.equal(homeFailure.status, 'access_blocked');
  assert.equal(homeFailure.completed, false);
  assert.equal(homeFailure.requests.length, 0);
  const schemaFailure = await searchMiguMatch(match, {fetchImpl: async url => respond(url === MIGU_HOME_URL ? home : {code: 200, body: {}})});
  assert.equal(schemaFailure.status, 'access_blocked');
  assert.equal(schemaFailure.completed, false);
  const empty = await searchMiguMatch(match, {fetchImpl: async url => respond(url === MIGU_HOME_URL ? home : payload())});
  assert.equal(empty.status, 'not_found');
  assert.equal(empty.completed, true);
});

test('official match date is read in China time independently from publication dates', () => {
  const url = 'https://www.miguvideo.com/p/live/120000594057';
  const state = {'120000594057': {code: 200, body: {matchStartTime: Date.parse('2026-10-23T19:35:00+08:00'),
    confrontTeams: [{name: '北京控股', isHome: '1', score: 93}, {name: '江苏肯帝亚', isHome: '0', score: 82}],
    multiPlayList: {replayList: [{pID: '968668426', name: '半场集锦', duration: '04:41'}]}}}};
  const page = `<script>window.__INITIAL_BASIC_DATA__ = ${JSON.stringify(state)};</script>`;
  const actual = extractMatchPage(page, url, {...match, date: '2026-10-24'});
  assert.equal(actual.teamsMatch, true);
  assert.equal(actual.date, '2026-10-23');
  assert.equal(actual.dateMatches, false);
  assert.equal(actual.replayEntries[0].title, '半场集锦');
});

test('embedded JSON parser handles braces and escaped quotes without evaluating scripts', () => {
  const value = {message: 'a } " quote', list: [{id: 1}]};
  assert.deepEqual(embeddedJson(`window.__TEST__ = ${JSON.stringify(value)}; throw Error('do not execute');`, '__TEST__'), value);
  assert.throws(() => embeddedJson('window.__TEST__ = {broken', '__TEST__'), /不完整/);
});

test('discovery records do not invalidate an unchanged approved edit or old delivery', () => {
  const job = createJob(match);
  const before = editorialDigest(job);
  delete job.mediaSearch;
  assert.equal(editorialDigest(job), before);
  job.mediaSearch = {status: 'candidates_found', candidates: [replay]};
  assert.equal(editorialDigest(job), before);
});

const discoveredReplay = extractCandidates(payload([replay]), match, '北控 江苏')[0];
const successfulSearch = () => ({status: 'candidates_found', completed: true, match, searchedAt: '2026-10-24T09:00:00Z',
  candidates: [discoveredReplay], matchPages: [{url: 'https://www.miguvideo.com/p/live/120000594057', date: match.date, teamsMatch: true, dateMatches: true}]});
const failedSearch = () => ({status: 'access_blocked', completed: false, match, searchedAt: '2026-10-24T10:00:00Z',
  candidates: [], matchPages: [], requests: [], errors: ['咪咕首页：fetch failed']});

test('a transient failed retry preserves prior candidates with explicit cache provenance', () => {
  const previous = successfulSearch(), attempt = failedSearch();
  const merged = mergeMiguSearch(previous, attempt);
  assert.equal(merged.status, 'access_blocked');
  assert.equal(merged.completed, false);
  assert.equal(merged.latestAttempt.status, 'access_blocked');
  assert.equal(merged.cacheOrigin, 'previous-successful-search');
  assert.equal(merged.retainedCandidates, 1);
  assert.equal(merged.candidates[0].searchOrigin, 'retained');
  assert.equal(merged.candidates[0].verified, false);
  assert.equal(merged.candidates[0].matchEvidence.latestSearchConfirmed, false);
  assert.equal(merged.lastSuccessfulSearch.searchedAt, previous.searchedAt);
  assert.deepEqual(merged.lastSuccessfulSearch.matchPages, previous.matchPages);
  assert.deepEqual(merged.matchPages, [], 'a historical match-page check is not a fresh check');
  assert.equal(previous.candidates[0].searchOrigin, undefined, 'merging must not mutate the prior evidence');
});

test('fresh candidates replace duplicate cached rows while unique cached rows remain marked', () => {
  const old = {...discoveredReplay, contentId: '968670747', url: 'https://www.miguvideo.com/p/detail/968670747'};
  const previous = {...successfulSearch(), status: 'partial', completed: false, candidates: [old, discoveredReplay]};
  const attempt = {...failedSearch(), status: 'partial', candidates: [{...discoveredReplay, query: '最新查询'}], errors: ['HTTP 403']};
  const merged = mergeMiguSearch(previous, attempt);
  assert.deepEqual(merged.candidates.map(item => item.contentId), ['968671241', '968670747']);
  assert.equal(merged.candidates[0].searchOrigin, undefined);
  assert.equal(merged.candidates[1].searchOrigin, 'retained');
  assert.equal(merged.retainedCandidates, 1);
});

test('a completed fresh search does not carry stale candidates', () => {
  const previous = successfulSearch();
  const attempt = {...successfulSearch(), searchedAt: '2026-10-24T10:00:00Z', candidates: [{...discoveredReplay, contentId: '968670747'}]};
  assert.deepEqual(mergeMiguSearch(previous, attempt), attempt);
});

test('consecutive failed retries retain the original success and candidate retrieval date', () => {
  const first = mergeMiguSearch(successfulSearch(), failedSearch());
  const next = {...failedSearch(), searchedAt: '2026-10-24T11:00:00Z'};
  const merged = mergeMiguSearch(first, next);
  assert.equal(merged.candidates.length, 1);
  assert.equal(merged.candidates[0].retainedFrom, '2026-10-24T09:00:00Z');
  assert.equal(merged.lastSuccessfulSearch.searchedAt, '2026-10-24T09:00:00Z');
  assert.equal(merged.latestAttempt.searchedAt, next.searchedAt);
  assert.equal(merged.latestAttempt.candidateCount, 0);
});

test('a successful empty search keeps an archive without claiming cached rows were found now', () => {
  const attempt = {...failedSearch(), status: 'not_found', completed: true, errors: []};
  const merged = mergeMiguSearch(successfulSearch(), attempt);
  assert.deepEqual(merged.candidates, []);
  assert.equal(merged.status, 'not_found');
  assert.equal(merged.retainedCandidates, 0);
  assert.equal(merged.lastSuccessfulSearch.candidates.length, 1);
  const retry = mergeMiguSearch(merged, failedSearch());
  assert.equal(retry.candidates[0].retainedFrom, '2026-10-24T09:00:00Z');
});

test('cached discoveries cannot cross a different match date or team identity', () => {
  for (const changed of [{...match, date: '2026-10-24'}, {...match, away: '四川'}, undefined]) {
    const attempt = {...failedSearch(), match: changed};
    assert.deepEqual(mergeMiguSearch(successfulSearch(), attempt), attempt);
  }
});

test('official team verification does not confuse Zhejiang Chouzhou with Guangsha', () => {
  const url = 'https://www.miguvideo.com/p/live/120000594061';
  const html = `window.__INITIAL_BASIC_DATA__ = ${JSON.stringify({'120000594061': {code: 200, body: {
    matchStartTime: Date.parse('2026-10-23T19:35:00+08:00'),
    confrontTeams: [{name: '浙江浙商证券', isHome: '1', score: 88}, {name: '青岛崂山啤酒', isHome: '0', score: 80}],
  }}})};`;
  assert.equal(extractMatchPage(html, url, {date: match.date, home: '浙江', away: '青岛'}).teamsMatch, false);
  assert.equal(extractMatchPage(html, url, {date: match.date, home: '广厦', away: '青岛'}).teamsMatch, true);
});

test('current CBA team aliases keep official Migu results for latest fixtures', () => {
  const cases = [
    [{date: '2026-10-24', home: '广厦', away: '吉林'}, '浙证 vs 长白山恩都里'],
    [{date: '2026-10-24', home: '广东', away: '宁波'}, '广东东阳光 vs 宁波町渥'],
    [{date: '2026-10-24', home: '上海', away: '福建'}, '上海久事 vs 福建晋江文旅'],
    [{date: '2026-10-24', home: '山西', away: '辽宁'}, '山西汾酒 vs 辽宁本钢'],
  ];
  for (const [fixture, title] of cases) {
    const candidate = extractCandidates(payload([{...replay, name: `${title} 全场回放` }]), fixture, `${fixture.home} ${fixture.away}`)[0];
    assert.ok(candidate, `${fixture.home}/${fixture.away} should match ${title}`);
  }
});

test('latest Guangsha-Jilin query keeps the indexed official team names', async () => {
  const evidence = await searchMiguMatch({date: '2026-10-24', home: '浙江广厦', away: '吉林长白山恩都里'}, {
    fetchImpl: async (url, options) => {
      if (url === MIGU_HOME_URL) return respond(home);
      const body = JSON.parse(options.body);
      return respond(body.k === '浙江浙商证券 吉林长白山恩都里'
        ? payload([{...replay, pID: '968717938', name: '26/27赛季CBA常规赛第4轮全场集锦：浙证vs吉林', mpId: '120000594064'}])
        : payload());
    },
  });
  assert.ok(evidence.candidates.some(item => item.contentId === '968717938'));
  assert.ok(evidence.queries.includes('浙江浙商证券 吉林长白山恩都里'));
});
