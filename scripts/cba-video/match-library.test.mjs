import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildMatchLibrary, linkNewsToMatch} from './match-library.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cba-match-library-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const make = (id, extra = {}) => ({id, job: {match: {id: 'match-1', date: '2026-10-24', home: '浙江广厦', away: '吉林', score: '81–82', verified: true}, sources: [{id: 'news', url: 'https://bbs.hupu.com/123.html', title: '赛后报道', text: '10月24日，广厦对吉林，81比82。'}], media: [], news: {title: '报道', segments: []}, ...extra}});
  const source = path.join(root, 'source.mp4'); fs.writeFileSync(source, 'recorded-video-fixture');
  const media = {id: 'migu-1234', path: source, sha256: 'a'.repeat(64), kind: 'highlights', matchId: 'match-1', matchConfirmed: true, probe: {duration: 230, width: 1280, height: 720, hasAudio: true}};
  return {root,make,media};
}

test('same match aliases share one downloaded file, while a different date stays separate', t => {
  const {root,make,media} = fixture(t);
  const a = make('news-a', {media: [media]});
  const b = make('news-b', {match: {...a.job.match, id: 'another-id', home: '浙江浙商证券', away: '吉林长白山恩都里'}});
  const c = make('news-c', {match: {...a.job.match, id: 'later-match', date: '2026-11-01'}});
  const matches = buildMatchLibrary([a,b,c], {root});
  assert.equal(matches.length, 2);
  const match = matches.find(item => item.date === '2026-10-24');
  assert.equal(match.newsCount, 2);
  assert.equal(match.footage.status, 'ready');
  assert.equal(match.footage.files.length, 1);
  const link = linkNewsToMatch(b.job, matches);
  assert.equal(link.status, 'confirmed');
  assert.equal(link.matchId, match.id);
  assert.match(match.footage.files[0].previewUrl, /news-a\/source-media\/migu-1234$/);
});

test('a download record cannot claim a deleted, empty or external file is available', t => {
  const {root,make,media} = fixture(t);
  const a = make('news-a', {media: [media]});
  fs.unlinkSync(media.path);
  let match = buildMatchLibrary([a], {root})[0];
  assert.equal(match.footage.status, 'missing');
  assert.equal(match.footage.files[0].available, false);
  assert.equal(match.footage.files[0].previewUrl, undefined);
  fs.writeFileSync(media.path, '');
  assert.equal(buildMatchLibrary([a], {root})[0].footage.status, 'missing');
  a.job.media[0].path = '/etc/hosts';
  assert.equal(buildMatchLibrary([a], {root})[0].footage.status, 'missing');
});

test('downloaded but unconfirmed video stays separate from verified match media', t => {
  const {root,make,media} = fixture(t);
  const a = make('news-a', {media: [{...media, matchConfirmed: false}]});
  assert.equal(buildMatchLibrary([a], {root})[0].footage.status, 'downloaded_unverified');
  a.job.media[0].matchConfirmed = true; a.job.media[0].matchId = 'wrong-match';
  assert.equal(buildMatchLibrary([a], {root})[0].footage.status, 'downloaded_unverified');
});

test('publication date and player name alone never assign a match; team clues remain candidates', t => {
  const {root,make,media} = fixture(t);
  const a = make('news-a', {media: [media]});
  const b = make('news-b', {match: {...a.job.match, id: 'later-match', date: '2026-11-01'}});
  const matches = buildMatchLibrary([a,b], {root});
  assert.equal(linkNewsToMatch({title: '胡金秋谈比赛', publishedAt: '2026-10-24'}, matches).status, 'unmatched');
  const clues = linkNewsToMatch({title: '广厦对吉林赛后声音', publishedAt: '2026-10-24'}, matches);
  assert.equal(clues.status, 'ambiguous');
  assert.equal(clues.candidates.length, 2);
  const precise = linkNewsToMatch({title: '2026-10-24 广厦对吉林赛后报道'}, matches);
  assert.equal(precise.status, 'candidate');
  assert.equal(precise.candidates.length, 1);
});

test('matching evidence preserves sources and conflicting verified scores block confirmation', t => {
  const {root,make} = fixture(t);
  const a = make('news-a');
  let matches = buildMatchLibrary([a], {root});
  assert.equal(linkNewsToMatch(a.job, matches).evidence[0].url, a.job.sources[0].url);
  const b = make('news-b', {match: {...a.job.match, score: '90–82'}});
  matches = buildMatchLibrary([a,b], {root});
  assert.equal(matches[0].verified, false);
  assert.equal(linkNewsToMatch(a.job, matches).status, 'ambiguous');
});

test('search failure, no results and not downloaded remain distinct', t => {
  const {root,make} = fixture(t);
  for (const [mediaSearch,status] of [[{status:'access_blocked'},'search_failed'], [{status:'not_found',completed:true},'not_found'], [{status:'candidates_found',candidates:[{url:'https://www.miguvideo.com/p/detail/1'}]},'not_downloaded']]) {
    assert.equal(buildMatchLibrary([make('news-a',{mediaSearch})],{root})[0].footage.status,status);
  }
});

test('v2 candidate evidence cannot be presented as a confirmed match or ready footage', t => {
  const {root,make,media} = fixture(t);
  const row = make('news-v2', {profile: {productionPolicy:'cba-value-v2'}, matchEvidence:{status:'candidate'}, media:[media]});
  const matches = buildMatchLibrary([row],{root});
  assert.equal(linkNewsToMatch(row.job,matches).status,'candidate');
  assert.equal(matches[0].footage.status,'downloaded_unverified');
});

test('registry ids stay distinct even if historical jobs reused a match id on another date', t => {
  const {root,make} = fixture(t);
  const first=make('news-a'), second=make('news-b');second.job.match.date='2026-11-01';
  const matches=buildMatchLibrary([first,second],{root});
  assert.equal(new Set(matches.map(match=>match.id)).size,2);
  assert.notEqual(linkNewsToMatch(first.job,matches).matchId,linkNewsToMatch(second.job,matches).matchId);
});

test('confirmed replay membership filters other-season search hits from the material list', t => {
  const {root,make} = fixture(t), real='https://www.miguvideo.com/p/detail/1234', old='https://www.miguvideo.com/p/detail/5678';
  const row=make('news-a',{mediaSearch:{status:'candidates_found',candidates:[{url:real,title:'本场集锦',durationSeconds:230},{url:old,title:'上赛季同队集锦'}],
    matchPages:[{date:'2026-10-24',dateMatches:true,teamsMatch:true,replayEntries:[{url:real,title:'本场集锦'}]}]}});
  const footage=buildMatchLibrary([row],{root})[0].footage;
  assert.equal(footage.candidateCount,1);assert.equal(footage.candidates[0].url,real);assert.equal(footage.candidates[0].duration,230);
});
