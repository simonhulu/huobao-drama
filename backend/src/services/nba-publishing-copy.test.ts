import test from 'node:test'
import assert from 'node:assert/strict'
import { nbaPublishingDescription } from './nba-publishing-copy.js'
import type { NbaGame, NbaJob } from './nba-types.js'

const game: NbaGame = {
  id: 'lakers-heat', tipoffUtc: '2026-11-03T03:00:00Z', localDate: '2026-11-02', localTimezone: 'America/Los_Angeles',
  home: { name: 'Los Angeles Lakers', abbreviation: 'LAL', score: 138 },
  away: { name: 'Miami Heat', abbreviation: 'MIA', score: 117 }, verified: true, evidenceUrls: [],
}
function job(title: string, match: NbaGame | undefined = game): NbaJob {
  return { id: 'nba-copy-test', title, status: 'completed', stage: 'completed', message: '', attempts: 1, canResume: false, logs: [],
    createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z', script: { title, text: '原有中文译稿。', facts: [] }, game: match,
    article: { id: 'article', url: 'https://example.test/article', title: 'Original article', language: 'en', publisher: 'News',
      body: 'Original article.', bodyHash: 'a'.repeat(64), wordCount: 2, characterCount: 0,
      collectedAt: '2026-11-05T00:00:00Z', publishedAt: '2026-11-04T00:00:00Z' } }
}

test('publication copy retains the star performance and adds the local game date and score', () => {
  const input = job('东契奇砍下42分13助攻，湖人击败热火'), original = structuredClone(input)
  assert.equal(nbaPublishingDescription(input), '2026-11-02 NBA｜东契奇42分13助攻，湖人138-117热火 #NBA#')
  assert.deepEqual(input, original)
})

test('event-led headlines retain the player and event while adding a match where it fits', () => {
  const description = nbaPublishingDescription(job('首次首发17分，托马斯接住机会'))
  assert.equal(description, '2026-11-02 NBA｜首次首发17分，托马斯接住机会，湖人138-117热火 #NBA#')
  assert.ok(description.length <= 50)
})

test('unknown or invalid game dates never use article dates or unverified scores', () => {
  for (const match of [undefined, { ...game, verified: false }, { ...game, localDate: '2026-02-30' }, { ...game, localDate: '' }]) {
    const input = job('东契奇砍下42分13助攻', match)
    if (!match) delete input.game
    assert.equal(nbaPublishingDescription(input), '东契奇42分13助攻 #NBA#')
  }
  const input = job('东契奇42分13助攻'); delete input.game; input.article.game = game
  assert.match(nbaPublishingDescription(input), /^2026-11-02 NBA｜/)
})

test('existing date prefixes and NBA topics occur only once', () => {
  const title = '2026-11-02 NBA｜东契奇42分13助攻，湖人击败热火 #NBA#'
  const description = nbaPublishingDescription(job(title))
  assert.equal(description, '2026-11-02 NBA｜东契奇42分13助攻，湖人138-117热火 #NBA#')
  const undated = job(title); delete undated.game
  assert.equal(nbaPublishingDescription(undated), '东契奇42分13助攻，湖人击败热火 #NBA#')
})

test('long copy keeps complete clauses or the complete match instead of cutting names and statistics', () => {
  const description = nbaPublishingDescription(job('东契奇在比赛最后时刻依然保持高效发挥并不断为队友创造得分机会，湖人击败热火'))
  assert.equal(description, '2026-11-02 NBA｜湖人138-117热火 #NBA#')
  const event = nbaPublishingDescription(job('文班亚马迎来生涯里程碑，马刺收获赛季最长连胜纪录'))
  assert.match(event, /文班亚马迎来生涯里程碑/)
  assert.ok(event.length <= 50)
})

test('quoted commas are preserved and never splice scores into direct speech', () => {
  assert.equal(nbaPublishingDescription(job('斯波：“湖人的进攻很难防”，热火输球')),
    '2026-11-02 NBA｜斯波：“湖人的进攻很难防”，热火输球 #NBA#')
  assert.equal(nbaPublishingDescription(job('斯波：“我们还有提升空间，湖人的进攻很难防”，热火输球')),
    '2026-11-02 NBA｜斯波：“我们还有提升空间，湖人的进攻很难防”，热火输球 #NBA#')
  assert.equal(nbaPublishingDescription(job('斯波：“我们还有很大的提升空间，湖人的进攻让我们整场比赛都很难防守”，热火输球')),
    '2026-11-02 NBA｜湖人138-117热火 #NBA#')
})

test('a missing date still reserves the topic budget in UTF-16 without splitting a surrogate pair', () => {
  for (const title of ['球'.repeat(43) + '🔥', '球'.repeat(42) + '𠮷野家', '球'.repeat(50)]) {
    const input = job(title); delete input.game
    const description = nbaPublishingDescription(input)
    assert.ok(description.length <= 50, description)
    assert.equal(Buffer.from(description).toString(), description)
    assert.equal(description.match(/#NBA#/g)?.length, 1)
  }
})

test('away winners and standard NBA abbreviation aliases use the correct teams and scores', () => {
  const match = { ...game, home: { name: 'Phoenix Suns', abbreviation: 'PHX', score: 101 }, away: { name: 'Golden State Warriors', abbreviation: 'GSW', score: 113 } }
  assert.equal(nbaPublishingDescription(job('库里复出首发', match)), '2026-11-02 NBA｜库里复出首发，勇士113-101太阳 #NBA#')
  for (const score of [0, -1, 101, Number.NaN]) {
    const description = nbaPublishingDescription(job('库里复出首发', { ...match, away: { ...match.away, score } }))
    assert.doesNotMatch(description, /NaN|--/)
  }
})
