import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { resolveNbaCoverTeams as resolveTeams } from './nba-cover-players.js'
import type { NbaGame } from './nba-types.js'
import type { NbaBodyPrepare } from './nba-cover-body.js'

const resolveNbaCoverTeams: typeof resolveTeams = (input, options = {}) => resolveTeams(input, { selectSubjects: null, discoverPhotos: null, ...options })

const summaryUrl = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401909921'
const photoUrl = (id: string) => `https://a.espncdn.com/i/headshots/nba/players/full/${id}.png`
const game: NbaGame = { id: 'espn-401909921', espnEventId: '401909921', tipoffUtc: '2026-11-03T03:30:00.000Z', localDate: '2026-11-02', localTimezone: 'America/Los_Angeles',
  home: { name: 'Los Angeles Lakers', abbreviation: 'LAL', score: 138 }, away: { name: 'Miami Heat', abbreviation: 'MIA', score: 117 }, verified: true, evidenceUrls: [summaryUrl] }
function athlete(id: string, name: string, minutes: string, points: number, extra: Record<string, unknown> = {}) {
  return { active: false, athlete: { id, displayName: name, headshot: { href: photoUrl(id) } }, starter: true, didNotPlay: false,
    reason: "COACH'S DECISION", stats: [minutes, String(points)], ...extra }
}
function boxscore(home = [athlete('3945274', 'Luka Doncic', '36', 42), athlete('4066457', 'Austin Reaves', '34', 27)],
  away = [athlete('3032977', 'Giannis Antetokounmpo', '34', 30), athlete('4066261', 'Bam Adebayo', '31', 16)]) {
  return { header: { id: '401909921', competitions: [{ competitors: [
    { homeAway: 'home', team: { abbreviation: 'LAL' } }, { homeAway: 'away', team: { abbreviation: 'MIA' } },
  ] }] }, boxscore: { players: [
    { team: { abbreviation: 'MIA', color: '98002e' }, statistics: [{ names: ['MIN', 'PTS'], labels: ['MIN', 'PTS'], athletes: away }] },
    { team: { abbreviation: 'LAL', color: '552583' }, statistics: [{ names: ['MIN', 'PTS'], labels: ['MIN', 'PTS'], athletes: home }] },
  ] } }
}
async function portrait(width = 350, height = 254, format: 'png' | 'jpeg' = 'png') {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3
    pixels[index] = (x * 3 + y) % 256; pixels[index + 1] = (x + y * 2) % 256; pixels[index + 2] = (x * 2 + y * 3) % 256
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).toFormat(format).toBuffer()
}
const image = await portrait()
type FixtureValue = unknown | Error | Response
function fixture(rows: Record<string, FixtureValue>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const url = String(input); calls.push(url)
    assert.ok(url in rows, `Unexpected fixture URL ${url}`)
    const value = rows[url]
    if (value instanceof Error) throw value
    if (value instanceof Response) return new Response(await value.clone().arrayBuffer(), { status: value.status, headers: value.headers })
    if (Buffer.isBuffer(value)) return new Response(new Uint8Array(value), { headers: { 'content-type': 'image/png' } })
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
const photos = () => Object.fromEntries(['3945274', '4066457', '3032977', '4066261'].map(id => [photoUrl(id), image]))
async function directory(t: { after: (callback: () => Promise<void>) => void }) {
  const filename = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-cover-players-'))
  t.after(() => fs.rm(filename, { recursive: true, force: true }))
  return filename
}
const input = (directory: string, extra: Partial<Parameters<typeof resolveNbaCoverTeams>[0]> = {}) => ({ game, headline: '湖人击败热火', directory, signal: new AbortController().signal, ...extra })

test('actual ESPN boxscore structure selects a title subject and opposing top scorer, preserving native pixels and provenance', async t => {
  const dir = await directory(t), calls: string[] = [], payload = boxscore()
  const result = await resolveNbaCoverTeams(input(dir, { article: { title: 'Reaves helps Lakers defeat Heat', body: 'Doncic scored 42.' } }),
    { fetchImpl: fixture({ [summaryUrl]: payload, ...photos() }, calls) })
  assert.equal(result.home.name, '湖人'); assert.equal(result.away.name, '热火')
  assert.equal(result.home.color, '#552583'); assert.equal(result.away.color, '#98002e')
  assert.equal(result.home.player?.name, 'Austin Reaves'); assert.equal(result.away.player?.name, 'Giannis Antetokounmpo')
  assert.deepEqual(calls.sort(), [summaryUrl, photoUrl('4066457'), photoUrl('3032977')].sort())
  const player = result.home.player!, bytes = await fs.readFile(player.photoPath!), metadata = await sharp(bytes).metadata()
  assert.equal(metadata.width, 350); assert.equal(metadata.height, 254)
  assert.equal(player.photoWidth, 350); assert.equal(player.photoHeight, 254)
  assert.equal(player.photoSha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(player.sourceUrl, photoUrl('4066457'))
  const evidence = JSON.parse(await fs.readFile(`${player.photoPath}.json`, 'utf8'))
  assert.equal(evidence.requestedUrl, player.sourceUrl); assert.equal(evidence.sha256, player.photoSha256)
  assert.equal(evidence.width, 350); assert.equal(evidence.height, 254)
})

test('an original English title matches diacritics and overrides higher scoring players without using article body as a title', async t => {
  const dir = await directory(t)
  const result = await resolveNbaCoverTeams(input(dir, { headline: 'Austin Reaves leads Lakers', article: { title: 'Dončić leads Los Angeles', body: 'Giannis and Reaves also played.' } }),
    { fetchImpl: fixture({ [summaryUrl]: boxscore([athlete('3945274', 'Luka Doncic', '36:24', 30), athlete('4066457', 'Austin Reaves', '34', 42)]), ...photos() }) })
  assert.equal(result.home.player?.name, 'Luka Doncic')
  const fallback = await resolveNbaCoverTeams(input(dir, { article: { title: 'Los Angeles wins', body: 'Luka Doncic contributed to the victory.' } }), { fetchImpl: fixture(photos()) })
  assert.equal(fallback.home.player?.name, 'Austin Reaves')
})

test('a Chinese story subject can select lower-scoring participants from both teams', async t => {
  const dir = await directory(t)
  const result = await resolveNbaCoverTeams(input(dir, { headline: '里夫斯爆发，阿德巴约苦撑热火',
    article: { title: '里夫斯爆发，阿德巴约苦撑热火', body: '里夫斯和阿德巴约是这篇报道的重点。' } }), {
    fetchImpl: fixture({ [summaryUrl]: boxscore(), ...photos() }),
    selectSubjects: async selection => {
      assert.equal(selection.article?.title, '里夫斯爆发，阿德巴约苦撑热火')
      assert.ok(selection.home.players.some(player => player.id === '4066457'))
      return { homePlayerId: '4066457', awayPlayerId: '4066261', reason: '标题重点人物', method: 'news-subject-v1' }
    },
  })
  assert.equal(result.home.player?.name, 'Austin Reaves')
  assert.equal(result.away.player?.name, 'Bam Adebayo')
  assert.equal(result.home.player?.selectionReason, '标题重点人物')
})

test('DNP, zero-minute and nonstatistical rows cannot become a representative even when named in the title', async t => {
  const dir = await directory(t), calls: string[] = []
  const payload = boxscore([
    athlete('3945274', 'Luka Doncic', '36', 42), athlete('4066457', 'Austin Reaves', '34', 90, { didNotPlay: true }),
    athlete('1966', 'LeBron James', '0:00', 100), athlete('4683774', 'Bronny James', 'DNP', 110),
  ])
  const result = await resolveNbaCoverTeams(input(dir, { article: { title: 'Reaves, LeBron James and Bronny James watch Lakers win', body: '' } }), { fetchImpl: fixture({ [summaryUrl]: payload, ...photos() }, calls) })
  assert.equal(result.home.player?.name, 'Luka Doncic')
  assert.ok(!calls.includes(photoUrl('4066457'))); assert.ok(!calls.includes(photoUrl('1966')))
})

test('uses the named points column in different stat layouts, and handles team abbreviation aliases', async t => {
  const dir = await directory(t), payload = boxscore()
  payload.boxscore.players[1].team.abbreviation = 'GS'
  payload.boxscore.players[1].statistics[0] = { names: ['minutes', 'rebounds', 'points'], labels: ['MIN', 'REB', 'PTS'], athletes: [
    { ...athlete('3945274', 'Luka Doncic', '36', 42), stats: ['36', '7', '42'] },
    { ...athlete('4066457', 'Austin Reaves', '34', 27), stats: ['34', '15', '27'] },
  ] }
  const result = await resolveNbaCoverTeams(input(dir, { game: { ...game, home: { ...game.home, abbreviation: 'GSW' } } }), { fetchImpl: fixture({ [summaryUrl]: payload, ...photos() }) })
  assert.equal(result.home.name, '勇士'); assert.equal(result.home.player?.teamAbbreviation, 'GSW')
  assert.equal(result.home.player?.name, 'Luka Doncic')
})

test('ambiguous surnames do not choose a lower scorer on another team', async t => {
  const dir = await directory(t)
  const payload = boxscore([athlete('3945274', 'Luka Doncic', '36', 42), athlete('1966', 'LeBron James', '34', 10)], [athlete('4683774', 'Bronny James', '1', 2), athlete('3032977', 'Giannis Antetokounmpo', '34', 30)])
  const result = await resolveNbaCoverTeams(input(dir, { article: { title: 'James watches Lakers defeat Heat', body: '' } }), { fetchImpl: fixture({ [summaryUrl]: payload, ...photos() }) })
  assert.equal(result.home.player?.name, 'Luka Doncic'); assert.equal(result.away.player?.name, 'Giannis Antetokounmpo')
})

test('verified portraits and boxscore cache work offline, and corrupt photos are downloaded again', async t => {
  const dir = await directory(t), first = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture({ [summaryUrl]: boxscore(), ...photos() }) })
  const calls: string[] = []
  const cached = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture({}, calls) })
  assert.deepEqual(cached, first); assert.equal(calls.length, 0)
  await fs.writeFile(first.home.player!.photoPath!, 'broken png')
  const repaired = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture(photos(), calls) })
  assert.equal(repaired.home.player?.photoSha256, first.home.player?.photoSha256)
  assert.deepEqual(calls, [photoUrl('3945274')])
})

test('a transient portrait failure is retried on the next call rather than cached as missing', async t => {
  const dir = await directory(t)
  const first = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture({ [summaryUrl]: boxscore(), ...photos(), [photoUrl('3945274')]: new Error('network unavailable') }) })
  assert.equal(first.home.player?.name, 'Luka Doncic'); assert.equal(first.home.player?.photoPath, undefined)
  assert.ok(first.away.player?.photoPath)
  const calls: string[] = [], next = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture(photos(), calls) })
  assert.ok(next.home.player?.photoPath); assert.deepEqual(calls, [photoUrl('3945274')])
})

test('network errors and wrong or incomplete match data fall back to team names without permanently caching failure', async t => {
  for (const failure of [new Error('offline'), new Response('bad gateway', { status: 502 }), new Response('not json'), { ...boxscore(), header: { id: '401909922' } }, boxscore([])]) {
    const dir = await directory(t)
    const failed = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture({ [summaryUrl]: failure }) })
    assert.equal(failed.home.name, '湖人'); assert.equal(failed.away.name, '热火')
    assert.equal(failed.home.player, undefined); assert.equal(failed.away.player, undefined)
    const next = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture({ [summaryUrl]: boxscore(), ...photos() }) })
    assert.ok(next.home.player?.photoPath)
  }
})

test('missing or unsafe event IDs return a team-name cover without a network request', async t => {
  const calls: string[] = [], dir = await directory(t)
  for (const espnEventId of [undefined, '../wrong', '401909921&anything=1']) {
    const result = await resolveNbaCoverTeams(input(dir, { game: { ...game, espnEventId } }), { fetchImpl: fixture({}, calls) })
    assert.equal(result.home.name, '湖人'); assert.equal(result.home.player, undefined)
  }
  assert.equal(calls.length, 0)
})

test('refuses off-domain image URLs, a mismatched ESPN player ID, and redirects that change identity', async t => {
  const unsafe = ['http://a.espncdn.com/i/headshots/nba/players/full/3945274.png', 'https://a.espncdn.com.evil.example/i/headshots/nba/players/full/3945274.png',
    'https://127.0.0.1/player.png', photoUrl('4066457')]
  for (const href of unsafe) {
    const dir = await directory(t), payload = boxscore(), calls: string[] = []
    payload.boxscore.players[1].statistics[0].athletes[0].athlete.headshot.href = href
    const result = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture({ [summaryUrl]: payload, [photoUrl('3032977')]: image }, calls) })
    assert.equal(result.home.player?.photoPath, undefined); assert.ok(result.away.player?.photoPath)
    assert.deepEqual(calls.sort(), [summaryUrl, photoUrl('3032977')].sort())
  }
  for (const location of ['http://127.0.0.1/secret', photoUrl('4066457')]) {
    const dir = await directory(t), calls: string[] = []
    const result = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture({ [summaryUrl]: boxscore(), ...photos(), [photoUrl('3945274')]: new Response(null, { status: 302, headers: { location } }) }, calls) })
    assert.equal(result.home.player?.photoPath, undefined); assert.ok(!calls.includes(location))
  }
})

test('image bytes must decode to a visible single image with sufficient native pixels', async t => {
  const blank = await sharp({ create: { width: 350, height: 254, channels: 4, background: '#00000000' } }).png().toBuffer()
  for (const bytes of [Buffer.from('<html>captcha</html>'), await portrait(100, 73), blank]) {
    const dir = await directory(t)
    const result = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture({ [summaryUrl]: boxscore(), ...photos(), [photoUrl('3945274')]: bytes }) })
    assert.equal(result.home.player?.photoPath, undefined); assert.ok(result.away.player?.photoPath)
  }
  const dir = await directory(t), native = await portrait(600, 436, 'jpeg')
  const result = await resolveNbaCoverTeams(input(dir), { fetchImpl: fixture({ [summaryUrl]: boxscore(), ...photos(), [photoUrl('3945274')]: native }) })
  assert.equal(result.home.player?.photoWidth, 600); assert.equal(result.home.player?.photoHeight, 436)
  assert.equal((await sharp(result.home.player!.photoPath!).metadata()).format, 'png')
})

test('oversized images are stopped while streaming instead of being decoded or saved', async t => {
  const dir = await directory(t)
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } })
  const oversized = new Response(stream)
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => String(url) === photoUrl('3945274') ? oversized : fixture({ [summaryUrl]: boxscore(), ...photos() })(url, init)) as typeof fetch
  const result = await resolveNbaCoverTeams(input(dir), { fetchImpl })
  assert.equal(result.home.player?.photoPath, undefined); assert.equal(cancelled, true)
  assert.ok(result.away.player?.photoPath)
})

test('cancellation propagates before networking and while fetching summary or portraits', async t => {
  const dir = await directory(t), before = new AbortController(), reason = new Error('user cancelled')
  before.abort(reason)
  await assert.rejects(resolveNbaCoverTeams(input(dir, { signal: before.signal }), { fetchImpl: fixture({}) }), error => error === reason)
  for (const during of ['summary', 'portrait']) {
    const controller = new AbortController(), dir = await directory(t)
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (during === 'summary' || String(url) !== summaryUrl) { controller.abort(reason); init?.signal?.throwIfAborted() }
      return fixture({ [summaryUrl]: boxscore(), ...photos() })(url, init)
    }) as typeof fetch
    await assert.rejects(resolveNbaCoverTeams(input(dir, { signal: controller.signal }), { fetchImpl }), error => error === reason)
  }
})

test('body mode skips old jerseys and headshots, selects same-game Bam after Giannis and Klay, and excludes DNP players', async t => {
  const dir = await directory(t), calls: string[] = [], checked: string[] = []
  const body = await sharp({ create: { width: 500, height: 500, channels: 4, background: '#00000000' } })
    .composite([{ input: await sharp(image).resize(300, 450).png().toBuffer(), left: 100, top: 25 }]).png().toBuffer()
  const search = (name: string) => `https://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=${encodeURIComponent(name)}`
  const render = (id: string) => `https://r2.thesportsdb.com/images/media/player/render/player${id}.png`
  const cutout = (id: string) => `https://r2.thesportsdb.com/images/media/player/cutout/player${id}.png`
  const people = [['3945274', 'Luka Doncic'], ['3032977', 'Giannis Antetokounmpo'], ['6475', 'Klay Thompson'], ['4066261', 'Bam Adebayo']]
  const rows: Record<string, unknown> = { [summaryUrl]: boxscore([
    athlete('3945274', 'Luka Doncic', '36', 42), athlete('1966', 'LeBron James', '34', 50, { didNotPlay: true }),
  ], [athlete('3032977', 'Giannis Antetokounmpo', '34', 30), athlete('6475', 'Klay Thompson', '27', 19), athlete('4066261', 'Bam Adebayo', '31', 16)]) }
  for (const [id, name] of people) {
    rows[search(name)] = { player: [{ idPlayer: id, strPlayer: name, strSport: 'Basketball', strTeam: name === 'Luka Doncic' ? 'Los Angeles Lakers' : 'Miami Heat', strRender: render(id), strCutout: cutout(id) }] }
    rows[render(id)] = body; rows[cutout(id)] = body
  }
  const prepareBody: NbaBodyPrepare = async value => {
    checked.push(value.playerName)
    if (['Giannis Antetokounmpo', 'Klay Thompson'].includes(value.playerName)) return null
    const bytes = await fs.readFile(value.filename), metadata = await sharp(bytes).metadata()
    return { path: value.filename, sha256: createHash('sha256').update(bytes).digest('hex'), width: metadata.width!, height: metadata.height!, verification: { body: true, jerseyTeamMatches: true } }
  }
  const result = await resolveNbaCoverTeams(input(dir, { article: { title: 'LeBron James watches Doncic defeat Heat', body: '' } }), { photoMode: 'body', fetchImpl: fixture(rows, calls), prepareBody })
  assert.equal(result.home.player?.name, 'Luka Doncic'); assert.equal(result.away.player?.name, 'Bam Adebayo')
  assert.equal(result.home.player?.photoKind, 'body'); assert.equal(result.away.player?.photoKind, 'body')
  assert.equal(result.away.player?.sourceUrl, render('4066261'))
  assert.equal(result.away.player?.photoWidth, 500); assert.equal(result.away.player?.photoHeight, 500)
  assert.ok(!calls.some(url => url.includes('headshots'))); assert.ok(!calls.includes(search('LeBron James')))
  assert.equal(checked.filter(name => name === 'Giannis Antetokounmpo').length, 2)
  assert.equal(checked.filter(name => name === 'Klay Thompson').length, 2)
  const offline: string[] = []
  const cached = await resolveNbaCoverTeams(input(dir, { article: { title: 'LeBron James watches Doncic defeat Heat', body: '' } }), { photoMode: 'body', fetchImpl: fixture({}, offline), prepareBody })
  assert.deepEqual(cached, result); assert.deepEqual(offline, [])
})

test('body mode tries at most three participating players per team and falls back to team names', async t => {
  const dir = await directory(t), calls: string[] = []
  const people = [athlete('1', 'First Player', '36', 42), athlete('2', 'Second Player', '34', 27), athlete('3', 'Third Player', '20', 20), athlete('4', 'Fourth Player', '15', 10)]
  const payload = boxscore(people, [athlete('5', 'Away Player', '34', 30)])
  const rows: Record<string, unknown> = { [summaryUrl]: payload }
  for (const name of ['First Player', 'Second Player', 'Third Player', 'Away Player']) rows[`https://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=${encodeURIComponent(name)}`] = { player: null }
  const result = await resolveNbaCoverTeams(input(dir), { photoMode: 'body', fetchImpl: fixture(rows, calls), prepareBody: async () => null })
  assert.equal(result.home.player, undefined); assert.equal(result.away.player, undefined)
  assert.equal(result.home.name, '湖人'); assert.equal(result.away.name, '热火')
  assert.ok(!calls.some(url => url.includes('Fourth'))); assert.equal(calls.length, 5)
})

test('body mode rejects untrusted image redirects before requesting their target', async t => {
  const dir = await directory(t), calls: string[] = []
  const render = 'https://r2.thesportsdb.com/images/media/player/render/luka.png', target = 'http://127.0.0.1/secret'
  const rows = { [summaryUrl]: boxscore([athlete('3945274', 'Luka Doncic', '36', 42)], [athlete('3032977', 'Giannis Antetokounmpo', '34', 30)]),
    'https://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=Luka%20Doncic': { player: [{ strPlayer: 'Luka Doncic', strSport: 'Basketball', strRender: render }] },
    'https://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=Giannis%20Antetokounmpo': { player: null },
    [render]: new Response(null, { status: 302, headers: { location: target } }),
  }
  const result = await resolveNbaCoverTeams(input(dir), { photoMode: 'body', fetchImpl: fixture(rows, calls), prepareBody: async () => null })
  assert.equal(result.home.player, undefined); assert.ok(!calls.includes(target))
})
