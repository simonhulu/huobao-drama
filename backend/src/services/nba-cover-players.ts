import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { nbaTeamName } from './nba-news.js'
import { nbaBodyRequestUrl, resolveNbaBodyPhoto, type NbaBodyCrop, type NbaBodyPrepare } from './nba-cover-body.js'
import { resolveNbaCoverSubjects } from './nba-cover-subject.js'
import { discoverNbaHiresPhotos } from './nba-cover-hires.js'
import type { NbaArticle, NbaGame } from './nba-types.js'

export interface NbaCoverPlayer {
  id: string
  name: string
  teamAbbreviation: string
  photoPath?: string
  photoSha256?: string
  photoWidth?: number
  photoHeight?: number
  photoKind?: 'headshot' | 'body'
  photoCrop?: NbaBodyCrop
  photoVerification?: Record<string, unknown>
  sourceUrl?: string
  selectionReason?: string
}
export interface NbaCoverTeam {
  abbreviation: string
  name: string
  color: string
  player?: NbaCoverPlayer
}
interface CoverInput {
  game: NbaGame
  article?: Pick<NbaArticle, 'title' | 'body'>
  headline: string
  directory: string
  signal: AbortSignal
  recentPhotoSha256s?: string[]
}
interface Candidate extends NbaCoverPlayer { points: number; minutes: number; headshot?: string }
interface PhotoEvidence { version: 1; requestedUrl: string; sourceUrl: string; sha256: string; width: number; height: number; format: 'png' }
type Row = Record<string, any>
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary'
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const code = (value: string) => ({ GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH' }[value.toUpperCase()] || value.toUpperCase())
const words = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const normalizeColor = (value: unknown, fallback: string) => typeof value === 'string' && /^#?[a-f\d]{6}$/i.test(value) ? `#${value.replace(/^#/, '')}` : fallback

function officialPhotoUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !(url.hostname === 'a.espncdn.com' && /^\/i\/headshots\/nba\/players\/full\/\d+\.(?:png|jpe?g|webp)$/i.test(url.pathname)
      || url.hostname === 'cdn.nba.com' && /^\/headshots\/nba\/(?:latest|\d{4})\/\d+x\d+\/\d+\.(?:png|jpe?g|webp)$/i.test(url.pathname))) {
    throw new Error('球员头像必须来自 NBA 或 ESPN 官方头像路径')
  }
  url.hash = ''
  return url.href
}
function samePhoto(value: string, expected: string) {
  const source = new URL(officialPhotoUrl(value)), original = new URL(expected)
  return source.hostname === original.hostname && source.pathname === original.pathname
}

function playingMinutes(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0
  const text = String(value).trim()
  if (/^\d+(?::\d{2})?$/.test(text)) {
    const [minutes, seconds = '0'] = text.split(':')
    return Number(minutes) + Number(seconds) / 60
  }
  return /^<\s*1$/.test(text) ? .5 : 0
}

function participants(payload: Row, team: NbaCoverTeam): { players: Candidate[]; color: string } {
  const box = Array.isArray(payload.boxscore?.players) ? payload.boxscore.players.find((row: Row) => code(String(row.team?.abbreviation || '')) === code(team.abbreviation)) : undefined
  const players = new Map<string, Candidate>()
  for (const stats of Array.isArray(box?.statistics) ? box.statistics : []) {
    const labels = Array.isArray(stats.labels) ? stats.labels : [], names = Array.isArray(stats.names) ? stats.names : []
    const index = (terms: string[]) => Array.from({ length: Math.max(labels.length, names.length) }, (_, i) => i)
      .find(i => [labels[i], names[i]].some(value => typeof value === 'string' && terms.includes(value.toUpperCase()))) ?? -1
    const minuteIndex = index(['MIN', 'MINUTES', 'MINUTESPLAYED']), pointIndex = index(['PTS', 'POINTS'])
    for (const row of Array.isArray(stats.athletes) ? stats.athletes : []) {
      const athlete = row.athlete, minutes = playingMinutes(row.stats?.[minuteIndex]), points = Number(row.stats?.[pointIndex])
      if (row.didNotPlay === true || minutes <= 0 || !Number.isFinite(points) || points < 0 || !/^\d{1,12}$/.test(String(athlete?.id || ''))
        || typeof athlete.displayName !== 'string' || !athlete.displayName.trim()) continue
      const id = String(athlete.id), candidate: Candidate = { id, name: athlete.displayName.trim(), teamAbbreviation: team.abbreviation,
        minutes, points, ...(typeof athlete.headshot?.href === 'string' ? { headshot: athlete.headshot.href } : {}) }
      const previous = players.get(id)
      if (!previous || candidate.minutes > previous.minutes || candidate.points > previous.points) players.set(id, candidate)
    }
  }
  return { players: [...players.values()], color: normalizeColor(box?.team?.color, team.color) }
}

function mentioned(title: string, player: Candidate, all: Candidate[]) {
  const text = ` ${words(title)} `, full = words(player.name)
  if (text.includes(` ${full} `)) return true
  const surname = (name: string) => words(name.replace(/\s+(?:jr\.?|sr\.?|ii|iii|iv|v)$/i, '').split(/\s+/).at(-1) || '')
  const last = surname(player.name)
  return last.length >= 3 && all.filter(row => surname(row.name) === last).length === 1 && text.includes(` ${last} `)
}

function select(players: Candidate[], all: Candidate[], input: CoverInput) {
  const rank = (row: Candidate) => input.article?.title && mentioned(input.article.title, row, all) ? 2 : mentioned(input.headline, row, all) ? 1 : 0
  return [...players].sort((a, b) => rank(b) - rank(a) || b.points - a.points || b.minutes - a.minutes || a.id.localeCompare(b.id))
}

async function writeAtomic(filename: string, value: Buffer | string) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, value); await fs.rename(temporary, filename) }
  finally { await fs.unlink(temporary).catch(() => {}) }
}
async function readCached(filename: string, limit: number) {
  if ((await fs.stat(filename)).size > limit) throw new Error('头像缓存大小异常')
  return fs.readFile(filename)
}
async function limitedBody(response: Response, limit: number) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw new Error('官方头像或比赛数据超过大小上限')
  }
  if (!response.body) throw new Error('官方头像或比赛数据为空')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) { await reader.cancel(); throw new Error('官方头像或比赛数据超过大小上限') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, length)
}

async function decodePhoto(bytes: Buffer) {
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: 16 * 1024 ** 2 }), metadata = await image.metadata()
  if (!['png', 'jpeg', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) !== 1
    || !metadata.width || !metadata.height || metadata.width < 240 || metadata.height < 180 || metadata.width > 4096 || metadata.height > 4096) {
    throw new Error('球员头像格式或原生像素不足')
  }
  const stats = await image.stats()
  if (!stats.channels.slice(0, 3).some(channel => channel.stdev > 2)
    || metadata.hasAlpha && stats.channels.at(-1)!.mean < 5) throw new Error('球员头像为空白或不可见')
  // Keep native pixels. The poster renderer decides how much of the portrait to show.
  return image.rotate().png().toBuffer({ resolveWithObject: true })
}

export async function resolveNbaCoverTeams(input: CoverInput, options: { fetchImpl?: typeof fetch; photoMode?: 'headshot' | 'body'; prepareBody?: NbaBodyPrepare;
  selectSubjects?: typeof resolveNbaCoverSubjects | null; discoverPhotos?: typeof discoverNbaHiresPhotos | null } = {}): Promise<{ home: NbaCoverTeam; away: NbaCoverTeam }> {
  const team = (value: NbaGame['home'], color: string): NbaCoverTeam => ({ abbreviation: value.abbreviation,
    name: nbaTeamName(value.abbreviation) === value.abbreviation ? value.name : nbaTeamName(value.abbreviation), color })
  const result = { home: team(input.game.home, '#9a3444'), away: team(input.game.away, '#247d8b') }
  input.signal.throwIfAborted()
  if (!/^\d{1,16}$/.test(input.game.espnEventId || '')) return result
  const proxy = process.env.NBA_NEWS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.HISTORY_YOUTUBE_PROXY
  let agent: ProxyAgent | undefined
  try { if (!options.fetchImpl && proxy) agent = new ProxyAgent(proxy) }
  catch { input.signal.throwIfAborted(); return result }
  async function request(url: string, kind: 'summary' | 'headshot' | 'body-api' | 'body-photo' = 'summary') {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(12000)])
    const photo = kind === 'headshot' || kind === 'body-photo'
    let current = url
    for (let redirect = 0; redirect <= 3; redirect++) {
      input.signal.throwIfAborted()
      if (kind === 'headshot') {
        current = officialPhotoUrl(current)
        if (!samePhoto(current, url)) throw new Error('头像重定向改变了球员身份')
      }
      else if (kind === 'body-api' || kind === 'body-photo') {
        current = nbaBodyRequestUrl(current, kind)
        if (current !== url) throw new Error('身体素材发生非预期重定向')
      } else if (current !== url) throw new Error('比赛数据发生非预期重定向')
      const init: RequestInit = { signal, redirect: 'manual', headers: { Accept: photo ? 'image/png,image/jpeg,image/webp'
        : new URL(current).hostname === 'www.pngarts.com' ? 'text/html' : 'application/json', 'User-Agent': 'NbaNewsWorkbench/1.0' } }
      const response = options.fetchImpl ? await options.fetchImpl(current, init)
        : await undiciFetch(current, { ...init, ...(agent ? { dispatcher: agent } : {}) } as Parameters<typeof undiciFetch>[1]) as unknown as Response
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new Error('官方头像重定向缺少地址')
        current = new URL(location, current).href; continue
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`官方头像或比赛数据 HTTP ${response.status}`) }
      return { bytes: await limitedBody(response, (photo ? 8 : 2) * 1024 ** 2), sourceUrl: current }
    }
    throw new Error('官方头像重定向次数过多')
  }
  function parseSummary(bytes: Buffer) {
    const payload = JSON.parse(bytes.toString('utf8')) as Row
    if (!payload || String(payload.header?.id) !== input.game.espnEventId) throw new Error('比赛数据编号不匹配')
    const home = participants(payload, result.home), away = participants(payload, result.away)
    if (!home.players.length || !away.players.length) throw new Error('同场出场球员数据尚未完整')
    return { home, away }
  }
  async function summary() {
    const filename = path.join(input.directory, `espn-boxscore-${input.game.espnEventId}.json`)
    try { return parseSummary(await readCached(filename, 2 * 1024 ** 2)) }
    catch { input.signal.throwIfAborted() }
    const { bytes } = await request(`${ESPN}?event=${input.game.espnEventId}`), parsed = parseSummary(bytes)
    input.signal.throwIfAborted()
    await fs.mkdir(input.directory, { recursive: true })
    await writeAtomic(filename, bytes).catch(() => {})
    return parsed
  }
  async function portrait(candidate: Candidate): Promise<NbaCoverPlayer> {
    const player: NbaCoverPlayer = { id: candidate.id, name: candidate.name, teamAbbreviation: candidate.teamAbbreviation }
    try {
      if (!candidate.headshot) return player
      const url = officialPhotoUrl(candidate.headshot)
      const source = new URL(url)
      if (source.hostname === 'a.espncdn.com' && !source.pathname.endsWith(`/${candidate.id}${path.extname(source.pathname)}`)) return player
      const filename = path.join(input.directory, `espn-player-${candidate.id}-${sha256(url).slice(0, 16)}.png`)
      let evidence: PhotoEvidence
      try {
        evidence = JSON.parse((await readCached(`${filename}.json`, 8192)).toString('utf8')) as PhotoEvidence
        const bytes = await readCached(filename, 8 * 1024 ** 2), photo = await decodePhoto(bytes)
        if (evidence.version !== 1 || evidence.requestedUrl !== url || !samePhoto(evidence.sourceUrl, url)
          || evidence.sha256 !== sha256(bytes) || evidence.width !== photo.info.width || evidence.height !== photo.info.height || evidence.format !== 'png') {
          throw new Error('官方头像缓存校验失败')
        }
      } catch {
        input.signal.throwIfAborted()
        const downloaded = await request(url, 'headshot'), photo = await decodePhoto(downloaded.bytes)
        input.signal.throwIfAborted()
        evidence = { version: 1, requestedUrl: url, sourceUrl: downloaded.sourceUrl, sha256: sha256(photo.data), width: photo.info.width, height: photo.info.height, format: 'png' }
        await fs.mkdir(input.directory, { recursive: true })
        await writeAtomic(filename, photo.data)
        await writeAtomic(`${filename}.json`, JSON.stringify(evidence, null, 2) + '\n')
      }
      input.signal.throwIfAborted()
      return { ...player, photoKind: 'headshot', photoPath: filename, photoSha256: evidence.sha256, photoWidth: evidence.width, photoHeight: evidence.height, sourceUrl: evidence.sourceUrl }
    } catch { input.signal.throwIfAborted(); return player }
  }
  try {
    const boxscore = await summary(), all = [...boxscore.home.players, ...boxscore.away.players]
    result.home.color = boxscore.home.color; result.away.color = boxscore.away.color
    const subjects = options.selectSubjects === null ? undefined : await (options.selectSubjects || resolveNbaCoverSubjects)({
      headline: input.headline, article: input.article, directory: input.directory, signal: input.signal,
      home: { abbreviation: result.home.abbreviation, players: boxscore.home.players },
      away: { abbreviation: result.away.abbreviation, players: boxscore.away.players },
    })
    async function representative(players: Candidate[], team: NbaCoverTeam, preferredId?: string) {
      const ranked = select(players, all, input)
      if (preferredId && players.some(player => player.id === preferredId)) ranked.sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId))
      const explain = (player: NbaCoverPlayer) => ({ ...player, ...(player.id === preferredId && subjects ? { selectionReason: subjects.reason } : {}) })
      if (options.photoMode !== 'body') return explain(await portrait(ranked[0]))
      for (const candidate of ranked.slice(0, 3)) {
        const player = { id: candidate.id, name: candidate.name, teamAbbreviation: candidate.teamAbbreviation }
        const body = await resolveNbaBodyPhoto({ player, teamName: team.name, directory: input.directory, signal: input.signal,
          recentPhotoSha256s: input.recentPhotoSha256s }, { request, prepareBody: options.prepareBody,
          ...(options.discoverPhotos === null ? {} : { additionalPhotos: () => (options.discoverPhotos || discoverNbaHiresPhotos)({
            playerName: player.name, directory: input.directory, signal: input.signal }, request) }) })
        if (body) return explain(body)
      }
      return undefined
    }
    const [home, away] = await Promise.all([representative(boxscore.home.players, result.home, subjects?.homePlayerId), representative(boxscore.away.players, result.away, subjects?.awayPlayerId)])
    result.home.player = home; result.away.player = away
    input.signal.throwIfAborted()
    return result
  } catch { input.signal.throwIfAborted(); return result }
  finally { await agent?.close().catch(() => {}) }
}
