import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fetchCbaNewsIntake, HUPU_HOT_URL, SINA_HOME_URL, SINA_CBA_FEED_URL} from './news-intake.mjs';

const official = (id, title, extra = {}) => ({tid: String(id), title, url: `/${id}.html`, createdAt: 1793452787000,
  topicId: '173', author: {puid: '56098302', puname: '虎扑篮球资讯'}, ...extra});
const hupu = rows => `<html><title>CBA专区 - 虎扑社区</title><script>window.$$data=${JSON.stringify({topic: {topic: {topicId: '173'}, threads: {list: rows}}})};</script></html>`;
const sina = rows => JSON.stringify({result: {status: {code: 0}, data: {items: rows, total: 100}}});
const articleUrl = 'https://sports.sina.com.cn/basketball/nba/2026-11-01/doc-test.shtml';
const article = '<html><head><meta property="article:published_time" content="2026-11-01T19:24:16+08:00"/><meta property="og:title" content="江苏伤情公告"/></head><body><div id="artibody"><p>庞峥麟因伤缺席江苏肯帝亚对阵浙江稠州的比赛。</p></div><p>NBA湖人队推荐新闻</p></body></html>';
const home = '<html><title>新浪体育</title><div class="feed-tab" data-type="cba">CBA</div></html>';
const response = body => new Response(body, {headers: {'content-type': 'text/html; charset=utf-8', date: 'Sun, 01 Nov 2026 11:20:00 GMT'}});
function fetcher(overrides = {}, calls = []) {
  const data = {
    [HUPU_HOT_URL]: hupu([official(100, '[流言板]CBA：山东85-76广东'), official(101, '[流言板]王岚嵚砍下24分')]),
    [SINA_HOME_URL]: home,
    [SINA_CBA_FEED_URL]: sina([{dataid: 'sina-1', url: articleUrl, title: '【伤情公告】庞峥麟缺席', ctime: 1793532256, media: 'NBA综合', labels_show: []}]),
    [articleUrl]: article,
    ...overrides,
  };
  return async (url, options) => {
    calls.push(url); assert.ok(options.signal instanceof AbortSignal); assert.equal(options.cache, 'no-store');
    if (!Object.hasOwn(data, url)) throw Error(`Unexpected URL ${url}`);
    const body = data[url]; if (body instanceof Error) throw body;
    return body instanceof Response ? body : response(body);
  };
}

test('reads the requested Hupu hot board and actual Sina home CBA feed, interleaving both sources', async () => {
  const calls = [];
  const result = await fetchCbaNewsIntake({fetchImpl: fetcher({}, calls)});
  assert.deepEqual(result.entryUrls, [HUPU_HOT_URL, SINA_HOME_URL]);
  assert.equal(result.total, 3); assert.equal(result.complete, true);
  assert.deepEqual(result.items.map(item => item.provider), ['hupu', 'sina', 'hupu']);
  assert.deepEqual(result.sourceReports.map(source => source.status), ['ok', 'ok']);
  assert.equal(result.items[0].publishedAt, null, 'list timestamps need article confirmation');
  assert.equal(result.items[0].listingPublishedAt, '2026-10-31T13:19:47.000Z');
  const story = result.items[1];
  assert.equal(story.url, articleUrl, '/nba/ path is not proof the story is about NBA');
  assert.equal(story.publishedAt, '2026-11-01T11:24:16.000Z');
  assert.match(story.sourceText, /江苏肯帝亚/);
  assert.doesNotMatch(story.sourceText, /湖人/);
  assert.equal(story.matchDate, undefined);
  assert.deepEqual(new Set(calls), new Set([HUPU_HOT_URL, SINA_HOME_URL, SINA_CBA_FEED_URL, articleUrl]));
});

test('records forum opinions and non-CBA stories as excluded rather than treating them as sourced facts', async () => {
  const result = await fetchCbaNewsIntake({articleMetadataLimit: 0, fetchImpl: fetcher({
    [HUPU_HOT_URL]: hupu([official(100, '[流言板]CBA：山东85-76广东'), official(102, '广东到底怎么了', {author: {puid: '1', puname: '球迷'}}),
      official(103, '[流言板]球队确认签约', {author: {puid: '1', puname: '球迷'}})]),
    [SINA_CBA_FEED_URL]: sina([
      {url: articleUrl, title: 'CBA广东队战胜山东队', labels_show: ['CBA']},
      {url: articleUrl.replace('test', 'nba'), title: 'NBA湖人击败勇士', labels_show: ['NBA']},
      {url: articleUrl.replace('test', 'u17'), title: 'U17篮球比赛男子组区域赛', labels_show: ['U17']},
      {url: 'https://evil.test/steal', title: 'CBA广东队战胜山东队'},
    ]),
  })});
  assert.equal(result.total, 2);
  assert.equal(result.excludedItems.length, 5);
  assert.ok(result.excludedItems.some(item => item.classification === 'forum_discussion'));
  assert.ok(result.excludedItems.some(item => /非CBA/.test(item.reason)));
  assert.ok(result.excludedItems.every(item => item.reason));
});

test('canonical duplicate links merge but different news about the same game remain separate', async () => {
  const result = await fetchCbaNewsIntake({articleMetadataLimit: 0, fetchImpl: fetcher({
    [HUPU_HOT_URL]: hupu([official(100, '[流言板]CBA：山东85-76广东'), official(100, '[流言板]CBA：山东85-76广东', {url: 'http://bbs.hupu.com/100.html?from=share#x'}), official(101, '[流言板]王岚嵚砍下24分')]),
    [SINA_CBA_FEED_URL]: sina([{url: articleUrl, title: 'CBA广东队战胜山东队'}, {url: articleUrl + '?from=share', title: 'CBA广东队战胜山东队'}]),
  })});
  assert.equal(result.total, 3); assert.equal(result.duplicateCount, 2);
  assert.equal(new Set(result.items.map(item => item.newsId)).size, 3);
});

test('one unavailable source preserves the other with a truthful partial report and raw evidence', async () => {
  const html = hupu([official(100, '[流言板]CBA：山东85-76广东')]);
  const result = await fetchCbaNewsIntake({fetchImpl: fetcher({[HUPU_HOT_URL]: html, [SINA_HOME_URL]: new Response('busy', {status: 503})})});
  assert.equal(result.total, 1); assert.equal(result.complete, false);
  const failed = result.sourceReports.find(item => item.provider === 'sina');
  assert.equal(failed.status, 'failed'); assert.match(failed.message, /HTTP 503/);
  const ok = result.sourceReports.find(item => item.provider === 'hupu');
  assert.equal(ok.evidence[0].rawBody, html);
  assert.equal(ok.evidence[0].sha256, createHash('sha256').update(html).digest('hex'));
});

test('missing/broken lists and both-source failures never masquerade as a successful empty scan', async () => {
  await assert.rejects(fetchCbaNewsIntake({fetchImpl: fetcher({[HUPU_HOT_URL]: '<html>Login</html>', [SINA_HOME_URL]: '<html>Login</html>'})}), /虎扑.*新浪/);
  const result = await fetchCbaNewsIntake({fetchImpl: fetcher({[HUPU_HOT_URL]: '<html>Login</html>'})});
  assert.equal(result.complete, false); assert.equal(result.items[0].provider, 'sina');
  await assert.rejects(fetchCbaNewsIntake({fetchImpl: fetcher({[HUPU_HOT_URL]: new DOMException('timeout', 'TimeoutError'), [SINA_CBA_FEED_URL]: JSON.stringify({result: {status: {code: 3}}})})}), /超时/);
});

test('conflicting article publication metadata is preserved for research, never resolved from the URL or fetch time', async () => {
  const conflicting = article.replace('</head>', '<meta property="article:published_time" content="2026-11-01 18:49:22"/></head>');
  const result = await fetchCbaNewsIntake({fetchImpl: fetcher({[articleUrl]: conflicting})});
  const item = result.items.find(item => item.provider === 'sina');
  assert.equal(item.publishedAt, null);
  assert.equal(item.publicationEvidence.conflict, true);
  assert.equal(item.publicationEvidence.values.length, 2);
});

test('article access failure preserves CBA candidates and records the missing正文 without inventing publication dates', async () => {
  const result = await fetchCbaNewsIntake({fetchImpl: fetcher({
    [SINA_CBA_FEED_URL]: sina([{url: articleUrl, title: 'CBA广东对山东', ctime: 1793532256}]),
    [articleUrl]: new Response('busy', {status: 403}),
  })});
  const item = result.items.find(item => item.provider === 'sina');
  assert.equal(item.publishedAt, null); assert.equal(item.articleStatus, 'unavailable');
  assert.match(item.articleError, /HTTP 403/); assert.equal(item.sourceText, undefined);
});

test('Sina candidates beyond the article prefetch budget remain available for relevance research', async () => {
  const calls = [], earlier = Array.from({length: 8}, (_, i) => ({
    url: articleUrl.replace('test', `earlier-${i}`), title: `CBA赛后报道${i}`, labels_show: ['CBA'],
  }));
  const result = await fetchCbaNewsIntake({fetchImpl: fetcher({
    [SINA_CBA_FEED_URL]: sina([...earlier, {url: articleUrl, title: '【伤情公告】庞峥麟缺席', labels_show: []}]),
    ...Object.fromEntries(earlier.map(row => [row.url, article])),
  }, calls)});
  assert.equal(calls.includes(articleUrl), false, 'keep the bounded article prefetch budget');
  const candidate = result.items.find(item => item.url === articleUrl);
  assert.ok(candidate, 'unread CBA-tab stories need to reach downstream research');
  assert.equal(candidate.articleStatus, 'pending');
  assert.equal(candidate.requiresRelevanceCheck, true);
  assert.equal(candidate.publishedAt, null);
  assert.equal(result.sourceReports.find(source => source.provider === 'sina').total, 9);
  assert.equal(result.excludedItems.some(item => item.url === articleUrl), false);
});

test('an ambiguous Sina headline survives a blocked or inconclusive article read for later research', async () => {
  for (const body of [new Response('busy', {status: 403}), '<html><meta name="description" content="伤情公告"/></html>']) {
    const result = await fetchCbaNewsIntake({fetchImpl: fetcher({[articleUrl]: body})});
    const candidate = result.items.find(item => item.url === articleUrl);
    assert.ok(candidate, 'lack of evidence must not silently discard a CBA-tab story');
    assert.equal(candidate.requiresRelevanceCheck, true);
    assert.equal(candidate.requiresCrossCheck, true);
    assert.equal(candidate.publishedAt, null);
    assert.match(candidate.selectionReason, /待核实/);
  }
});
