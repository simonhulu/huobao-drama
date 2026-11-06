import test from 'node:test';
import assert from 'node:assert/strict';
import {TITLE_POLICY, primaryNewsTitle, validateTitlePolicy, publishingTitle} from './title-policy.mjs';

const prefix = '2026-10-23 CBA｜';
function fixture() {
  return {
    id: '2026-10-24-tianjin-guangzhou',
    profile: {titlePolicy: TITLE_POLICY},
    match: {date: '2026-10-23', verified: true, home: '天津', away: '广州', seedUrls: ['https://bbs.hupu.com/643198039.html']},
    sources: [
      {url: 'https://example.com/secondary', title: '次要报道，不能替代主报道'},
      {url: 'https://bbs.hupu.com/643198039.html', title: '[流言板]天津主帅：随着尼克斯梳理我们团队，我们会打得越来越好'},
    ],
    news: {title: `${prefix}天津主帅：尼克斯梳理团队，球队会越来越好`, shortTitle: 'CBA天津主帅谈尼克斯'},
    highlights: {title: `${prefix}天津102–86广州：关键回合`, shortTitle: 'CBA天津广州关键回合'},
  };
}

test('primary report is selected by the first seed, independently of source order', () => {
  const job = fixture();
  assert.equal(primaryNewsTitle(job), '天津主帅：随着尼克斯梳理我们团队，我们会打得越来越好');
  job.sources.reverse();
  assert.equal(primaryNewsTitle(job), '天津主帅：随着尼克斯梳理我们团队，我们会打得越来越好');
  job.sources[0].title = '  【流言板】 天津主帅谈球队  ';
  assert.equal(primaryNewsTitle(job), '天津主帅谈球队');
  job.sources[0].title = '天津主帅谈球队';
  assert.equal(primaryNewsTitle(job), '天津主帅谈球队');
});

test('missing primary title never falls back to another seed or source', () => {
  const job = fixture();
  job.match.seedUrls.unshift('https://example.com/missing');
  assert.equal(primaryNewsTitle(job), '');
  assert.match(validateTitlePolicy(job).join('\n'), /primary source title/);
  job.match.seedUrls.shift();
  job.sources[1].title = '[流言板]  ';
  assert.equal(primaryNewsTitle(job), '');
  job.sources[1].title = null;
  assert.equal(primaryNewsTitle(job), '');
  job.sources[1].title = '主报道';
  job.sources[1].url += '?tracking=1';
  assert.equal(primaryNewsTitle(job), '', 'source URL matching remains exact');
  delete job.match.seedUrls;
  assert.equal(primaryNewsTitle(job), '');
  assert.equal(primaryNewsTitle({}), '');
});

test('valid titles use the verified match date rather than the task directory date', () => {
  const job = fixture();
  assert.deepEqual(validateTitlePolicy(job), []);
  assert.equal(publishingTitle(job, 'news', 'baijiahao'), job.news.title);
  assert.equal(publishingTitle(job, 'highlights', 'baijiahao'), job.highlights.title);
  assert.equal(publishingTitle(job, 'news', 'tencent-video'), job.news.shortTitle);
  assert.equal(publishingTitle(job, 'highlights', 'tencent-video'), job.highlights.shortTitle);
  job.news.title = job.news.title.replace('2026-10-23', '2026-10-24');
  assert.match(validateTitlePolicy(job).join('\n'), /news.title must start with 2026-10-23 CBA｜/);
});

test('date validation rejects impossible dates and requires explicit verification', () => {
  for (const date of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-00', '2026-1-01', '2026-10-23T00:00:00Z', '', undefined, 20261023]) {
    const job = fixture();
    job.match.date = date;
    assert.match(validateTitlePolicy(job).join('\n'), /valid match.date/, String(date));
  }
  const job = fixture();
  job.match.date = '2024-02-29';
  for (const kind of ['news', 'highlights']) job[kind].title = job[kind].title.replace('2026-10-23', job.match.date);
  assert.deepEqual(validateTitlePolicy(job), []);
  for (const verified of [false, undefined, 'true', 1]) {
    job.match.verified = verified;
    assert.match(validateTitlePolicy(job).join('\n'), /verified match/);
  }
});

test('both full titles require an exact prefix, content, and no repeated prefix or source label', () => {
  for (const kind of ['news', 'highlights']) {
    for (const title of [undefined, null, '', '天津主帅谈球队', '2026-10-23 CBA|天津主帅谈球队', `${prefix}   `, `${prefix}${prefix}天津主帅谈球队`, `${prefix}新闻：2026-10-24 CBA｜球队消息`, `${prefix}[流言板]球队消息`, `${prefix}【流言板】球队消息`]) {
      const job = fixture();
      job[kind].title = title;
      assert.ok(validateTitlePolicy(job).some(error => error.startsWith(`${kind}.title`)), `${kind}: ${title}`);
      assert.throws(() => publishingTitle(job, kind, 'baijiahao'), /Invalid CBA title policy/);
    }
  }
});

test('full title limits count Unicode code points and never silently truncate', () => {
  for (const kind of ['news', 'highlights']) {
    const job = fixture();
    job[kind].title = prefix + '🏀'.repeat(50 - Array.from(prefix).length);
    assert.deepEqual(validateTitlePolicy(job), []);
    assert.equal(Array.from(publishingTitle(job, kind, 'baijiahao')).length, 50);
    job[kind].title += '球';
    assert.match(validateTitlePolicy(job).join('\n'), new RegExp(`${kind}.title must not exceed 50`));
    assert.throws(() => publishingTitle(job, kind, 'baijiahao'), /must not exceed 50/);
  }
});

test('both short titles are required, contain CBA, and fit 16 Unicode code points', () => {
  for (const kind of ['news', 'highlights']) {
    for (const shortTitle of [undefined, null, '', '   ', '天津广州关键回合', 'cba天津广州']) {
      const job = fixture();
      job[kind].shortTitle = shortTitle;
      assert.match(validateTitlePolicy(job).join('\n'), new RegExp(`${kind}.shortTitle must be nonempty and contain CBA`));
    }
    const job = fixture();
    job[kind].shortTitle = 'CBA' + '🏀'.repeat(13);
    assert.deepEqual(validateTitlePolicy(job), []);
    assert.equal(publishingTitle(job, kind, 'tencent-video'), job[kind].shortTitle);
    job[kind].shortTitle += '球';
    assert.match(validateTitlePolicy(job).join('\n'), new RegExp(`${kind}.shortTitle must not exceed 16`));
    assert.throws(() => publishingTitle(job, kind, 'tencent-video'), /must not exceed 16/);
  }
});

test('news-only titles do not require or publish an unselected highlights title', () => {
  const job = fixture(); job.profile.editions = ['news']; delete job.highlights;
  assert.deepEqual(validateTitlePolicy(job), []);
  assert.equal(publishingTitle(job, 'news', 'baijiahao'), job.news.title);
  assert.throws(() => publishingTitle(job, 'highlights', 'baijiahao'), /not selected/);
  job.profile.editions = ['highlights'];
  assert.match(validateTitlePolicy(job).join('\n'), /highlights.title/);
});

test('unknown and explicitly empty policy versions cannot silently use legacy behavior', () => {
  for (const policy of ['source-date-cba-v2', '', null, false]) {
    const job = fixture();
    job.profile.titlePolicy = policy;
    assert.match(validateTitlePolicy(job).join('\n'), /Unsupported profile.titlePolicy/);
    assert.throws(() => publishingTitle(job, 'news', 'baijiahao'), /Unsupported profile.titlePolicy/);
  }
});

test('unmarked legacy jobs keep the exact previous publishing title behavior', () => {
  const job = fixture();
  delete job.profile.titlePolicy;
  delete job.news.shortTitle;
  delete job.highlights.shortTitle;
  delete job.sources;
  job.match.date = 'invalid';
  job.match.verified = false;
  job.news.title = '旧新闻' + '🏀'.repeat(60);
  job.highlights.title = '旧集锦' + '🏆'.repeat(60);
  assert.deepEqual(validateTitlePolicy(job), []);
  assert.equal(publishingTitle(job, 'news', 'baijiahao'), '旧新闻' + '🏀'.repeat(47));
  assert.equal(publishingTitle(job, 'highlights', 'baijiahao'), '旧集锦' + '🏆'.repeat(47));
  assert.equal(publishingTitle(job, 'news', 'tencent-video'), '天津对广州赛后复盘');
  assert.equal(publishingTitle(job, 'highlights', 'tencent-video'), '天津对广州关键回合');
  job.match.home = '🏀'.repeat(20);
  assert.equal(publishingTitle(job, 'news', 'tencent-video'), '🏀'.repeat(16));
  job.highlights.title = '';
  assert.equal(publishingTitle(job, 'highlights', 'baijiahao'), publishingTitle(job, 'news', 'baijiahao'));
  delete job.profile;
  assert.deepEqual(validateTitlePolicy(job), []);
  assert.equal(publishingTitle(job, 'news', 'baijiahao'), '旧新闻' + '🏀'.repeat(47));
  assert.deepEqual(validateTitlePolicy({}), []);
});

test('title inspection and publication do not mutate jobs or accumulate prefixes', () => {
  const job = fixture();
  job.approval = {digest: 'existing-approval'};
  job.outputs = {inputDigest: 'existing-delivery'};
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  freeze(job);
  const before = JSON.stringify(job);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(validateTitlePolicy(job), []);
    primaryNewsTitle(job);
    for (const kind of ['news', 'highlights']) {
      assert.equal(publishingTitle(job, kind, 'baijiahao'), job[kind].title);
      assert.equal(publishingTitle(job, kind, 'tencent-video'), job[kind].shortTitle);
    }
  }
  assert.equal(JSON.stringify(job), before);
});

test('highlights-only titles require match and edition title without inventing a primary news story', () => {
  const job = fixture(); job.profile.editions = ['highlights']; delete job.news;
  job.match.seedUrls = []; job.sources = [];
  assert.deepEqual(validateTitlePolicy(job), []);
  assert.equal(publishingTitle(job, 'highlights', 'baijiahao'), job.highlights.title);
  assert.throws(() => publishingTitle(job, 'news', 'baijiahao'), /not selected/);
  job.match.verified = false;
  assert.match(validateTitlePolicy(job).join('\n'), /verified match/);
});
