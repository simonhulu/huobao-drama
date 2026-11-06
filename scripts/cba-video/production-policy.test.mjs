import test from 'node:test';
import assert from 'node:assert/strict';
import {CBA_PRODUCTION_POLICY, productionQuality, assertNarrationCoverage} from './production-policy.mjs';

const text = '南京在主场以九十六比九十五击败广东。球队在最后一节守住了领先优势，赛后主教练表示，全队在防守端执行了赛前部署。报道同时记录了球员的关键得分和赛后回应，这些信息均来自原报道正文。';
function fixture(editions = ['news', 'highlights']) {
  return {profile: {productionPolicy: CBA_PRODUCTION_POLICY, editions},
    media: [{id: 'm', sha256: 'same-source'}],
    clips: [0, 1, 2].map(i => ({id: `c${i}`, mediaId: 'm', start: i * 40, end: (i + 1) * 40, verified: true, completePlay: true})),
    news: {segments: [{id: 'n1', text, clipIds: ['c0']}]}, highlights: {clipIds: ['c0', 'c1', 'c2']}};
}

test('new production blocks seconds-long news and highlights rather than warning', () => {
  const job = fixture();
  const result = productionQuality(job, {durations: {news: 6, highlights: 8}});
  assert.match(result.errors.join('\n'), /新闻.*30/);
  assert.match(result.errors.join('\n'), /集锦.*90/);
  assert.ok(result.metrics.news.narrationCharacters > 60);
});

test('news needs substantive spoken reporting and moving game footage', () => {
  const job = fixture(['news']);
  job.news.segments[0].text = '这场比赛非常精彩。';
  assert.match(productionQuality(job).errors.join('\n'), /口播信息不足/);
  job.news.segments[0].mode = 'original';
  assert.match(productionQuality(job).errors.join('\n'), /口播/);
  job.news.segments[0] = {id: 'n1', text: text.repeat(2), clipIds: ['c0']};
  job.clips[0].end = 3;
  assert.match(productionQuality(job).errors.join('\n'), /比赛画面.*30/);
});

test('Xiaolu narration opens in the selected presenter voice before any news commentary', () => {
  const job = fixture(['news']);
  job.profile.narrationPolicy = 'xiaolu-commentator-v1';
  assert.match(productionQuality(job).errors.join('\n'), /小鹭.*开场/);
  job.news.segments.unshift({id: 'disclosure', mode: 'original', text: '本场比赛资料画面', clipIds: []});
  job.news.segments[1].text = '大家好，我们是你们的评论员小鹭。北京七场全胜，场均净胜对手二十七点一分。';
  assert.doesNotMatch(productionQuality(job).errors.join('\n'), /小鹭.*开场/);
});

test('Xiaolu commentary rejects article narration and media datelines in spoken text', () => {
  const job = fixture(['news']);
  job.profile.narrationPolicy = 'xiaolu-commentator-v1';
  for (const sentence of [
    '据虎扑十一月一日报道，北京男篮取得开局七连胜。',
    '这篇赛后报道同时提到，北京场均净胜对手二十七点一分。',
    '新浪刊载的这篇赛后复盘，用五点观察讨论北京的新赛季争冠前景。',
    '原文先谈桑普森的状态，再谈陈盈骏的组织。',
    '作者认为北京有争冠实力。',
  ]) {
    job.news.segments[0].text = `大家好，我们是你们的评论员小鹭。${sentence}`;
    assert.match(productionQuality(job).errors.join('\n'), /n1.*素材转述/, sentence);
  }
});

test('presenter rules retain backstage evidence and genuine event-subject quotes', () => {
  const job = fixture(['news']);
  job.profile.narrationPolicy = 'xiaolu-commentator-v1';
  job.clips[0].end = 80;
  job.news.segments[0].text = '大家好，我们是你们的评论员小鹭。' + '北京七连胜，场均净胜对手二十七点一分。桑普森赛后说，他和周琦的配合越来越好。看内线配合，我会重点关注两人的传接球时机，以及轮换阶段的攻防衔接。这两点需要结合后面的比赛继续观察。'.repeat(4);
  job.sources = [{id: 'report', text: '据虎扑报道，原文提到北京七连胜。'}];
  assert.deepEqual(productionQuality(job).errors, []);
  const legacy = fixture(['news']);
  assert.deepEqual(productionQuality(legacy).errors, [], 'Existing approvals are not silently migrated to a new presenter');
  const highlights = fixture(['highlights']);
  highlights.profile.narrationPolicy = 'xiaolu-commentator-v1';
  assert.deepEqual(productionQuality(highlights).errors, [], 'Original-sound highlights do not need presenter narration');
});

test('the commentary policy requires a substantive one-minute narration instead of a short news fragment', () => {
  const job = fixture(['news']);
  job.profile.narrationPolicy = 'xiaolu-commentator-v1';
  job.profile.newsSeconds = [1, 2];
  job.clips[0].end = 90;
  job.news.segments[0].text = '大家好，我们是你们的评论员小鹭。北京取得七连胜。';
  const result = productionQuality(job, {durations: {news: 48.5}});
  assert.match(result.errors.join('\n'), /最低要求 60 秒/);
  assert.match(result.errors.join('\n'), /至少 300 个有效文字/);
  assert.deepEqual(result.metrics.news.targetSeconds, [90, 180]);
  assert.throws(() => assertNarrationCoverage(job, [{id: 'n1', footageSeconds: 90, narrationSeconds: 48.5, narrationEnd: 48.5}]), /至少 60 秒/);
  assert.doesNotThrow(() => assertNarrationCoverage(job, [{id: 'n1', footageSeconds: 90, narrationSeconds: 80, narrationEnd: 80}]));
});

test('highlights require at least three verified complete possessions and reject repeated source time', () => {
  const job = fixture(['highlights']);
  assert.deepEqual(productionQuality(job).errors, []);
  job.highlights.clipIds = ['c0'];
  assert.match(productionQuality(job).errors.join('\n'), /3.*完整回合/);
  job.highlights.clipIds = ['c0', 'c1', 'c2'];
  job.clips[1].completePlay = false;
  assert.match(productionQuality(job).errors.join('\n'), /3.*完整回合/);
  job.clips[1].completePlay = true;
  job.media.push({id: 'alias', sha256: 'same-source'});
  job.clips[1] = {...job.clips[0], id: 'c1', mediaId: 'alias'};
  assert.match(productionQuality(job).errors.join('\n'), /重复.*素材时间/);
});

test('legacy outputs retain approvals and receive transparent short-video warnings', () => {
  const job = fixture(); delete job.profile.productionPolicy;
  job.approval = {digest: 'legacy-approval'};
  const before = JSON.stringify(job);
  const result = productionQuality(job, {durations: {news: 8, highlights: 12}});
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 2);
  assert.equal(JSON.stringify(job), before);
});

test('v2 hard minimums cannot be lowered using profile duration preferences', () => {
  const job = fixture(); job.profile.newsSeconds = [1, 2]; job.profile.highlightsSeconds = [1, 2];
  assert.equal(productionQuality(job, {durations: {news: 5, highlights: 5}}).errors.length, 2);
});

test('actual narration may not be extended with long frozen frames or mostly silent footage', () => {
  const job = fixture(['news']);
  assert.throws(() => assertNarrationCoverage(job, [{id: 'n1', footageSeconds: 3, narrationSeconds: 35, narrationEnd: 35}]), /停帧|补足/);
  assert.throws(() => assertNarrationCoverage(job, [{id: 'n1', footageSeconds: 120, narrationSeconds: 5, narrationEnd: 5}]), /口播/);
  assert.doesNotThrow(() => assertNarrationCoverage(job, [{id: 'n1', footageSeconds: 40, narrationSeconds: 32, narrationEnd: 32}]));
  delete job.profile.productionPolicy;
  assert.doesNotThrow(() => assertNarrationCoverage(job, [{id: 'n1', footageSeconds: 3, narrationSeconds: 35, narrationEnd: 35}]));
});

test('new match association evidence changes review identity while legacy deliveries stay compatible', async () => {
  const {editorialDigest} = await import('./core.mjs');
  const job = fixture();
  job.matchEvidence = {sourceExcerpt:'南京主场迎战广东',sourceIds:['report'],reason:'原文日期与双方一致'};
  const initial = editorialDigest(job);
  job.matchEvidence.sourceExcerpt = '不同新闻的比赛线索';
  assert.notEqual(editorialDigest(job),initial);
  delete job.profile.productionPolicy;
  const legacy = editorialDigest(job);
  job.matchEvidence.sourceExcerpt = '仅补充展示信息';
  assert.equal(editorialDigest(job),legacy);
});

test('v2 match association requires real source text and a specific recorded link', async () => {
  const {matchEvidenceErrors} = await import('./production-policy.mjs');
  const job = fixture();
  assert.ok(matchEvidenceErrors(job).length);
  job.matchEvidence = {status:'confirmed',reason:'新闻中的比赛日期与双方一致',sourceExcerpt:'南京主场迎战广东',sourceIds:['source']};
  assert.ok(matchEvidenceErrors(job).length, 'invented IDs cannot count as evidence');
  job.sources = [{id:'source',title:'赛后报道',text:''}];
  assert.ok(matchEvidenceErrors(job).length, 'a title alone is not article evidence');
  job.sources[0].text = '十月十八日，南京主场迎战广东，双方展开激烈争夺。';
  assert.deepEqual(matchEvidenceErrors(job),[]);
  job.matchEvidence.status='candidate';
  assert.ok(matchEvidenceErrors(job).length);
  delete job.profile.productionPolicy;
  assert.deepEqual(matchEvidenceErrors(job),[],'legacy delivery access stays compatible');
});
