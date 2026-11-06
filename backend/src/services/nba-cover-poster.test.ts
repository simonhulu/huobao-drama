import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { buildNbaPosterHtml, prepareNbaPoster, renderNbaPoster, type NbaPosterDesign, type NbaPosterInput } from './nba-cover-poster.js'
import type { NbaCoverTeam } from './nba-cover-players.js'

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const image = (width: number, height: number, background = '#162b37') => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()

async function bodyPhoto(scale = 1) {
  return sharp({ create: { width: 640 * scale, height: 800 * scale, channels: 4, background: '#00000000' } })
    .composite([
      { input: await image(300 * scale, 740 * scale, '#d3a185'), left: 170 * scale, top: 30 * scale },
      { input: await image(300 * scale, 80 * scale, '#ef3141'), left: 170 * scale, top: 30 * scale },
      { input: await image(300 * scale, 120 * scale, '#4dcb8f'), left: 170 * scale, top: 620 * scale },
    ]).png().toBuffer()
}

async function pixelsOfColor(dataUrl: string, color: [number, number, number]) {
  const { data, info } = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let count = 0
  for (let i = 0; i < data.length; i += info.channels) if (data[i] === color[0] && data[i + 1] === color[1] && data[i + 2] === color[2] && data[i + 3] === 255) count++
  return count
}

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-poster-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const input: NbaPosterInput = { directory, signal: new AbortController().signal, headline: '东契奇42分13助攻，湖人击败热火',
    article: { title: 'Doncic scores 42 as Lakers beat Heat', body: 'A game report.' },
    game: { id: 'espn-401909921', espnEventId: '401909921', localDate: '2026-11-02', localTimezone: 'America/Los_Angeles',
      tipoffUtc: '2026-11-03T03:00:00Z', home: { abbreviation: 'LAL', name: 'Los Angeles Lakers', score: 138 },
      away: { abbreviation: 'MIA', name: 'Miami Heat', score: 117 }, verified: true, evidenceUrls: [] } }
  const teams: { home: NbaCoverTeam; away: NbaCoverTeam } = {
    home: { abbreviation: 'LAL', name: '湖人', color: '#f1c929' },
    away: { abbreviation: 'MIA', name: '热火', color: '#de313c' },
  }
  const images = { landscape: await image(1920, 1080), portrait: await image(1080, 1440) }
  const designs: NbaPosterDesign[] = []
  const options = { resolveTeams: async () => structuredClone(teams), render: async (design: NbaPosterDesign) => { designs.push(structuredClone(design)); return images } }
  return { input, teams, options, images, designs }
}

test('poster identity follows each article headline and the actual final score', async t => {
  const f = await fixture(t), original = await prepareNbaPoster(f.input, f.options)
  const otherArticle = await prepareNbaPoster({ ...f.input, headline: '热火防线失守，客场不敌湖人' }, f.options)
  const correctedGame = structuredClone(f.input.game); correctedGame.home.score = 139
  const otherScore = await prepareNbaPoster({ ...f.input, game: correctedGame }, f.options)
  assert.notEqual(original.path, otherArticle.path)
  assert.notEqual(original.portraitPath, otherArticle.portraitPath)
  assert.notEqual(original.evidence.inputHash, otherScore.evidence.inputHash)
  assert.equal(otherArticle.evidence.headline, '热火防线失守，客场不敌湖人')
  assert.equal(otherScore.evidence.teams[0].score, 139)
  assert.equal(f.designs.length, 3)
  assert.equal(original.evidence.composition, 'team-names')
})

test('both poster formats are reused from verified cache and rebuilt after pixel tampering', async t => {
  const f = await fixture(t), first = await prepareNbaPoster(f.input, f.options)
  assert.deepEqual(await prepareNbaPoster(f.input, f.options), first)
  assert.equal(f.designs.length, 1)
  await fs.writeFile(first.portraitPath, await image(1080, 1440, '#d62f43'))
  const repaired = await prepareNbaPoster(f.input, f.options)
  assert.equal(f.designs.length, 2)
  assert.deepEqual(repaired, first)
  assert.deepEqual(await fs.readFile(repaired.portraitPath), f.images.portrait)
  await fs.writeFile(first.path, 'damaged png')
  assert.deepEqual(await prepareNbaPoster(f.input, f.options), first)
  assert.equal(f.designs.length, 3)
  assert.deepEqual(await fs.readFile(first.path), f.images.landscape)
})

test('missing, undecodable and changed portraits all produce team-name covers', async t => {
  const f = await fixture(t), photoPath = path.join(f.input.directory, 'player.png')
  f.teams.home.player = { id: '3945274', name: 'Luka Doncic', teamAbbreviation: 'LAL', photoPath, photoKind: 'body' }
  for (const failure of ['missing', 'undecodable', 'changed'] as const) {
    if (failure === 'undecodable') await fs.writeFile(photoPath, 'broken image')
    if (failure === 'changed') { await fs.writeFile(photoPath, await image(640, 480)); f.teams.home.player.photoSha256 = '0'.repeat(64) }
    const result = await prepareNbaPoster({ ...f.input, headline: `${f.input.headline}（${failure}）` }, f.options)
    assert.equal(result.evidence.composition, 'team-names', failure)
    assert.equal(result.evidence.teams[0].player, undefined, failure)
    assert.equal(f.designs.at(-1)!.home.photoDataUrl, undefined, failure)
    assert.equal(f.designs.at(-1)!.home.name, '湖人', failure)
  }
})

test('real body photographs retain lower arms and jersey pixels and evidence omits local cache paths', async t => {
  const f = await fixture(t), photoPath = path.join(f.input.directory, 'official-player.png')
  const photograph = await bodyPhoto()
  await fs.writeFile(photoPath, photograph)
  for (const [side, id, name] of [['home', '3945274', 'Luka Doncic'], ['away', '4066261', 'Bam Adebayo']] as const) {
    f.teams[side].player = { id, name, teamAbbreviation: f.teams[side].abbreviation, photoPath,
      photoSha256: hash(photograph), photoKind: 'body', photoVerification: { framing: 'upper-body', cleanedRegions: 2 },
      sourceUrl: `https://cdn.nba.com/photomanager/player-${id}.png` }
  }
  const result = await prepareNbaPoster(f.input, f.options), evidence = JSON.stringify(result.evidence)
  assert.equal(result.evidence.composition, 'players')
  assert.equal(result.evidence.method, 'nba-action-poster-v2')
  assert.equal(result.evidence.portraitTreatment, 'real-body-crop')
  assert.equal(result.evidence.teams[0].player!.photoSha256, hash(photograph))
  assert.deepEqual([result.evidence.teams[0].player!.width, result.evidence.teams[0].player!.height], [640, 800])
  assert.equal(result.evidence.teams[0].player!.photoKind, 'body')
  assert.equal(result.evidence.teams[0].player!.framing, 'upper-body')
  assert.equal(result.evidence.teams[0].player!.cleanedRegions, 2)
  assert.equal(evidence.includes(f.input.directory), false)
  assert.equal(evidence.includes('photoPath'), false)
  assert.match(f.designs[0].home.photoDataUrl!, /^data:image\/png;base64,/)
  assert.equal(await pixelsOfColor(f.designs[0].home.photoDataUrl!, [239, 49, 65]), 300 * 80, 'the complete head-top marker must remain')
  assert.equal(await pixelsOfColor(f.designs[0].home.photoDataUrl!, [77, 203, 143]), 300 * 120, 'lower arms and jersey pixels must survive instead of a head-and-neck crop')
  const cached = await prepareNbaPoster(f.input, f.options)
  assert.deepEqual(cached, result)
  assert.equal(f.designs.length, 1)
})

test('headshots and unclassified photographs cannot impersonate body photographs', async t => {
  const f = await fixture(t), photoPath = path.join(f.input.directory, 'player.png'), photograph = await bodyPhoto()
  await fs.writeFile(photoPath, photograph)
  for (const photoKind of ['headshot', undefined] as const) {
    f.teams.home.player = { id: '3945274', name: 'Luka Doncic', teamAbbreviation: 'LAL', photoPath, photoSha256: hash(photograph), photoKind }
    const result = await prepareNbaPoster({ ...f.input, headline: `${f.input.headline}（${photoKind || 'unclassified'}）` }, f.options)
    assert.equal(result.evidence.composition, 'team-names')
    assert.equal(result.evidence.teams[0].player, undefined)
    assert.equal(f.designs.at(-1)!.home.photoDataUrl, undefined)
  }
})

test('body crops keep the head top even when y is positive and changed crops get new identities', async t => {
  const f = await fixture(t), photoPath = path.join(f.input.directory, 'action.png'), photograph = await bodyPhoto(2)
  await fs.writeFile(photoPath, photograph)
  f.teams.home.player = { id: '3945274', name: 'Luka Doncic', teamAbbreviation: 'LAL', photoPath, photoKind: 'body',
    photoSha256: hash(photograph), photoCrop: { x: .25, y: .2, width: .5, height: .65 } }
  const first = await prepareNbaPoster(f.input, f.options), embedded = f.designs[0].home.photoDataUrl!
  assert.equal(first.evidence.composition, 'mixed')
  assert.deepEqual(first.evidence.teams[0].player!.crop, f.teams.home.player.photoCrop)
  assert.equal(await pixelsOfColor(embedded, [239, 49, 65]), 600 * 160, 'positive crop.y must not discard the real head top')
  assert.equal(await pixelsOfColor(embedded, [77, 203, 143]), 600 * 120, 'the crop ends at y + height in original coordinates')
  f.teams.home.player.photoCrop = { x: .25, y: .15, width: .5, height: .75 }
  const changed = await prepareNbaPoster(f.input, f.options)
  assert.notEqual(changed.evidence.inputHash, first.evidence.inputHash)
  assert.notEqual(changed.path, first.path)
  assert.notEqual(changed.portraitPath, first.portraitPath)
  assert.equal(await pixelsOfColor(f.designs[1].home.photoDataUrl!, [239, 49, 65]), 600 * 160)
  assert.equal(await pixelsOfColor(f.designs[1].home.photoDataUrl!, [77, 203, 143]), 600 * 200)
})

test('small body photographs keep their full pose and native detail instead of filling the player slot', async t => {
  const f = await fixture(t), photoPath = path.join(f.input.directory, 'small-action.png'), photograph = await bodyPhoto()
  await fs.writeFile(photoPath, photograph)
  f.teams.home.player = { id: '3945274', name: 'Luka Doncic', teamAbbreviation: 'LAL', photoPath, photoKind: 'body',
    photoSha256: hash(photograph), photoCrop: { x: .25, y: 0, width: .5, height: .6 } }
  const result = await prepareNbaPoster(f.input, f.options), player = result.evidence.teams[0].player!
  assert.equal(player.crop, undefined)
  assert.equal(player.quality!.cropOmittedForResolution, true)
  assert.deepEqual([player.quality!.effectiveWidth, player.quality!.effectiveHeight], [300, 740])
  for (const portrait of [false, true]) {
    const format = portrait ? { key: 'portrait', width: 1080, height: 1440 } as const : { key: 'landscape', width: 1920, height: 1080 } as const
    const html = buildNbaPosterHtml(f.designs[0], format), size = player.quality!.display[format.key]
    assert.ok(size.scale <= 1.15)
    assert.match(html, new RegExp(`style="width:${size.width}px;height:${size.height}px"`))
  }
})

test('poster HTML escapes user text and rejects image and color injection', () => {
  const design: NbaPosterDesign = { headline: '<script>alert("标题")</script>，胜出 & "追分"', date: '2026-11-02<evil>',
    home: { abbreviation: 'LAL', name: '<img onerror="bad">', color: '#fff; background:url(https://evil.test)', score: 138,
      photoDataUrl: 'https://evil.test/portrait.png', player: { id: '1', name: '" onerror="bad', teamAbbreviation: 'LAL' } },
    away: { abbreviation: 'MIA', name: '热火 & "球队"', color: '#de313c', score: 117 } }
  const html = buildNbaPosterHtml(design, { key: 'landscape', width: 1920, height: 1080 })
  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('<img onerror='), false)
  assert.equal(html.includes('https://evil.test'), false)
  assert.match(html, /&lt;script&gt;alert\(&quot;标题&quot;\)&lt;\/script&gt;/)
  assert.match(html, /热火 &amp; &quot;球队&quot;/)
  assert.match(html, /2026\.11\.02&lt;evil&gt;/)
  assert.match(html, /--team-color:#f0f064/)
  design.home.photoDataUrl = 'data:image/png;base64,aGVsbG8='
  const withPhoto = buildNbaPosterHtml(design, { key: 'portrait', width: 1080, height: 1440 })
  assert.match(withPhoto, /alt="&quot; onerror=&quot;bad"/)
})

test('real Chrome renders ordinary and long Chinese titles in both native formats within safe bounds', { timeout: 60000 }, async () => {
  const design: NbaPosterDesign = { date: '2026-11-02', headline: `${'东契奇率领球队在末节连续得分并送出关键助攻'.repeat(3)}，${'湖人主场击败热火取得比赛胜利'.repeat(2)}`,
    home: { abbreviation: 'LAL', name: '洛杉矶湖人', color: '#f1c929', score: 138 },
    away: { abbreviation: 'MIA', name: '迈阿密热火', color: '#de313c', score: 117 } }
  assert.ok(design.headline.length <= 120)
  for (const headline of ['东契奇砍下42分13助攻，湖人击败热火', design.headline]) {
    const images = await renderNbaPoster({ ...design, headline }, new AbortController().signal)
    for (const [key, width, height] of [['landscape', 1920, 1080], ['portrait', 1080, 1440]] as const) {
      const metadata = await sharp(images[key]).metadata(), stats = await sharp(images[key]).stats()
      assert.deepEqual([metadata.width, metadata.height, metadata.format], [width, height, 'png'])
      assert.ok(stats.channels.some(channel => channel.stdev > 20), 'rendered text and team graphics must be visible')
    }
  }
})
