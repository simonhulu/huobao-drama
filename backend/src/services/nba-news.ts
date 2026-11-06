import { createHash } from 'node:crypto'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { NbaArticle, NbaGame, NbaIntakeInput, NbaIntakeResult, NbaLanguage, NbaSourceReport, NbaTopic } from './nba-types.js'
import { fallbackTopicQuery, matchesNbaTopic, planNbaTopicSearch, searchNbaTopic, topicQueries, topicSearchResults, type NbaTopicSearch, type NbaTopicSearchPlan } from './nba-topic-news.js'
import { cleanNbaArticleBody, extractNbaArticleBody } from './nba-article-body.js'

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
const SINA = 'https://interface.sina.cn/sports/pc_sports_caipiao_common_list_api.d.json?ename=nba&last_ts=&page=1&size=20'
export interface NbaNewsOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => Date
  topicPlan?: (topic: NbaTopic, signal?: AbortSignal) => Promise<NbaTopicSearchPlan>
  searchImpl?: NbaTopicSearch
}
type Row = Record<string, any>
type Candidate = { url: string; title?: string; publisher?: string; raw?: Row; game?: NbaGame; language?: NbaLanguage }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const words = (value: string) => value.match(/[A-Za-z]+(?:['\u2019-][A-Za-z]+)*/g) || []
const han = (value: string) => value.match(/\p{Script=Han}/gu) || []
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const teams: Record<string, [string, string[]]> = {
  ATL: ['America/New_York', ['Atlanta Hawks', 'Hawks', '老鹰']], BOS: ['America/New_York', ['Boston Celtics', 'Celtics', '凯尔特人']],
  BKN: ['America/New_York', ['Brooklyn Nets', 'Nets', '篮网']], CHA: ['America/New_York', ['Charlotte Hornets', 'Hornets', '黄蜂']],
  CHI: ['America/Chicago', ['Chicago Bulls', 'Bulls', '公牛']], CLE: ['America/New_York', ['Cleveland Cavaliers', 'Cavaliers', 'Cavs', '骑士']],
  DAL: ['America/Chicago', ['Dallas Mavericks', 'Mavericks', '独行侠', '小牛']], DEN: ['America/Denver', ['Denver Nuggets', 'Nuggets', '掘金']],
  DET: ['America/Detroit', ['Detroit Pistons', 'Pistons', '活塞']], GS: ['America/Los_Angeles', ['Golden State Warriors', 'Warriors', '勇士']],
  HOU: ['America/Chicago', ['Houston Rockets', 'Rockets', '火箭']], IND: ['America/Indiana/Indianapolis', ['Indiana Pacers', 'Pacers', '步行者']],
  LAC: ['America/Los_Angeles', ['Los Angeles Clippers', 'LA Clippers', 'Clippers', '快船']], LAL: ['America/Los_Angeles', ['Los Angeles Lakers', 'Lakers', '湖人']],
  MEM: ['America/Chicago', ['Memphis Grizzlies', 'Grizzlies', '灰熊']], MIA: ['America/New_York', ['Miami Heat', 'Heat', '热火']],
  MIL: ['America/Chicago', ['Milwaukee Bucks', 'Bucks', '雄鹿']], MIN: ['America/Chicago', ['Minnesota Timberwolves', 'Timberwolves', '森林狼']],
  NO: ['America/Chicago', ['New Orleans Pelicans', 'Pelicans', '鹈鹕']], NY: ['America/New_York', ['New York Knicks', 'Knicks', '尼克斯']],
  OKC: ['America/Chicago', ['Oklahoma City Thunder', 'Thunder', '雷霆']], ORL: ['America/New_York', ['Orlando Magic', 'Magic', '魔术']],
  PHI: ['America/New_York', ['Philadelphia 76ers', '76ers', 'Sixers', '76人', '七六人']], PHX: ['America/Phoenix', ['Phoenix Suns', 'Suns', '太阳']],
  POR: ['America/Los_Angeles', ['Portland Trail Blazers', 'Trail Blazers', 'Blazers', '开拓者']], SAC: ['America/Los_Angeles', ['Sacramento Kings', 'Kings', '国王']],
  SA: ['America/Chicago', ['San Antonio Spurs', 'Spurs', '马刺']], TOR: ['America/Toronto', ['Toronto Raptors', 'Raptors', '猛龙']],
  UTAH: ['America/Denver', ['Utah Jazz', 'Jazz', '爵士']], WSH: ['America/New_York', ['Washington Wizards', 'Wizards', '奇才']],
}
const abbreviation = (value: string) => ({ GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH' }[value.toUpperCase()] || value.toUpperCase())
const aliases = (code: string, name = '') => [code, abbreviation(code), name, ...(teams[abbreviation(code)]?.[1] || [])].filter(Boolean)
export const nbaTeamName = (code: string) => teams[abbreviation(code)]?.[1].find(name => /\p{Script=Han}/u.test(name)) || code
function mentions(value: string, names: string[]) {
  return names.some(name => /\p{Script=Han}/u.test(name) ? value.includes(name)
    : new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value))
}

function publicUrl(value: string) {
  const url = new URL(value)
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))
    || host === 'localhost' || host.endsWith('.local') || !host.includes('.') || host.includes(':')
    || /^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.|$)/.test(host)) throw Error('仅支持公开新闻网页链接')
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|from|spm|share_.+)$/i.test(key)) url.searchParams.delete(key)
  return url.href
}
function decode(value: string) {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] || all
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : all
  })
}
function plain(value: string) {
  return decode(value.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|noscript|figure)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|div|section|h[1-6])\s*>|<br\b[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
function attributes(value: string) {
  return Object.fromEntries([...value.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, key, a, b]) => [key.toLowerCase(), decode(a ?? b)]))
}
function structuredArticles(html: string): Row[] {
  const result: Row[] = []
  function visit(value: any) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (typeof value.articleBody === 'string') result.push(value)
    if (value['@graph']) visit(value['@graph'])
    if (value.mainEntity) visit(value.mainEntity)
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])) } catch { /* A malformed metadata block cannot become article evidence. */ }
  }
  return result
}
function forbidden(title: string, body: string) {
  if (/\b(?:AI[- ]assisted|AI[- ]generated|artificial intelligence|automatically generated)\b|(?:AI|人工智能).{0,16}(?:辅助|生成)/i.test(body)) return 'AI 辅助或自动生成内容，不应自动生产'
  if (/\bpodcast\b|播客/i.test(title) && /\b(?:summary|digest|recap|episode)\b|摘要|总结/i.test(`${title} ${body.slice(0,350)}`)) return '播客摘要不作为独立新闻报道'
  if (/\b(?:preview|predictions?|betting|odds|how to watch|picks)\b|赛前|前瞻|观赛指南|篮球强档/i.test(title)) return '赛前、预测或观赛宣传，不作为赛后新闻'
  if (/\bBOTTOM LINE:|\bData Skrive\b/i.test(body) || /\(\d+-\d+[^)]*\)\s+(?:vs\.?|at)\s+[^\n]+\(\d+-\d+/i.test(body.slice(0,600))) return '自动赛前预告，不作为赛后新闻'
  if (/\b(?:CBA|WNBA|NCAA|EuroLeague)\b|宁波男篮|广东男篮|辽宁男篮|女篮/i.test(title) && !/\bNBA\b/i.test(title)) return '标题指向非 NBA 赛事'
  return undefined
}

function transport(options: NbaNewsOptions, signal?: AbortSignal) {
  const proxy = process.env.NBA_NEWS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.HISTORY_YOUTUBE_PROXY
  const agent = !options.fetchImpl && proxy ? new ProxyAgent(proxy) : undefined
  const cache = new Map<string, Promise<any>>()
  async function text(url: string, headers: Record<string,string> = {}) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      try {
        let current = publicUrl(url)
        for (let redirect = 0; redirect <= 4; redirect++) {
          const init: RequestInit = { signal: combined, redirect: 'manual', headers: { Accept: 'application/json,text/html', 'User-Agent': 'NbaNewsWorkbench/1.0', ...headers } }
          const response = options.fetchImpl ? await options.fetchImpl(current, init)
            : await undiciFetch(current, { ...init, ...(agent ? { dispatcher: agent } : {}) } as Parameters<typeof undiciFetch>[1])
          if ([301,302,303,307,308].includes(response.status)) {
            const location = response.headers.get('location')
            await response.body?.cancel()
            if (!location) throw Error('新闻页面重定向缺少地址')
            current = publicUrl(new URL(location, current).href); continue
          }
          if (!response.ok) { await response.body?.cancel(); throw Error(`HTTP ${response.status}`) }
          const bytes = await response.arrayBuffer()
          if (bytes.byteLength > 8 * 1024 ** 2) throw Error('新闻页面超过8MiB，未读取正文')
          const encoding = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(response.headers.get('content-type') || '')?.[1]
          return new TextDecoder(encoding && /^(?:gbk|gb2312|gb18030)$/i.test(encoding) ? 'gb18030' : 'utf-8').decode(bytes)
        }
        throw Error('新闻页面重定向次数过多')
      } catch (error) {
        signal?.throwIfAborted()
        if (attempt || combined.aborted || /HTTP [34]|HTTP 4/.test(String(error))) throw error
      }
    }
  }
  function json(url: string, headers?: Record<string,string>): Promise<any> {
    if (!cache.has(url)) cache.set(url, text(url,headers).then(value => JSON.parse(value)))
    return cache.get(url)!
  }
  return { text, json, throwIfAborted: () => signal?.throwIfAborted(), close: () => agent?.close() }
}
type Client = ReturnType<typeof transport>
function dateInZone(utc: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(utc))
  return ['year','month','day'].map(key => parts.find(part => part.type === key)!.value).join('-')
}
function verifiedGame(payload: Row, evidenceUrl: string): NbaGame | undefined {
  const event = payload.header || payload, competition = event.competitions?.[0]
  const status = competition?.status?.type || event.status?.type
  if (status?.completed !== true || status.state !== 'post') return undefined
  const home = competition.competitors?.find((row: Row) => row.homeAway === 'home')
  const away = competition.competitors?.find((row: Row) => row.homeAway === 'away')
  if (!home?.team || !away?.team) return undefined
  const homeScore = Number(home.score?.value ?? home.score), awayScore = Number(away.score?.value ?? away.score)
  const utc = competition.date || event.date, eventId = String(event.id || competition.id || '')
  if (!/^\d+$/.test(eventId) || !Number.isFinite(Date.parse(utc)) || !Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore <= 0 || awayScore <= 0 || homeScore === awayScore) return undefined
  const venue = payload.gameInfo?.venue || competition.venue
  const neutralZones: Record<string, string> = { 'Mexico City': 'America/Mexico_City', Paris: 'Europe/Paris', London: 'Europe/London', Tokyo: 'Asia/Tokyo', 'Abu Dhabi': 'Asia/Dubai', Berlin: 'Europe/Berlin', Macau: 'Asia/Macau', Macao: 'Asia/Macau' }
  const localTimezone = venue?.timeZone?.id || venue?.timeZone || venue?.timezone
    || (competition.neutralSite ? neutralZones[venue?.address?.city] : teams[abbreviation(home.team.abbreviation || '')]?.[0])
  if (typeof localTimezone !== 'string') return undefined
  try {
    const tipoffUtc = new Date(utc).toISOString()
    return { id: `espn-${eventId}`, espnEventId: eventId, tipoffUtc, localDate: dateInZone(tipoffUtc, localTimezone), localTimezone,
      home: { name: home.team.displayName || home.team.name, abbreviation: home.team.abbreviation, score: homeScore },
      away: { name: away.team.displayName || away.team.name, abbreviation: away.team.abbreviation, score: awayScore }, verified: true, evidenceUrls: [evidenceUrl] }
  } catch { return undefined }
}
function eventFromUrl(url: string) {
  const parsed = new URL(url)
  return /(^|\.)espn\.com$/.test(parsed.hostname) && /^\/nba\//.test(parsed.pathname)
    ? parsed.searchParams.get('gameId') || /\/gameId\/(\d+)/.exec(parsed.pathname)?.[1] : undefined
}
function storyFromUrl(url: string) {
  const parsed = new URL(url)
  return /(^|\.)espn\.com$/.test(parsed.hostname) && /^\/nba\//.test(parsed.pathname)
    ? /\/(?:id|news)\/(\d+)/.exec(parsed.pathname)?.[1] : undefined
}
function linkedEvent(raw: Row) {
  return raw.gameId ? String(raw.gameId) : raw.categories?.find((row: Row) => row.type === 'event')?.eventId?.toString()
    || raw.categories?.find((row: Row) => row.type === 'event')?.event?.id?.toString()
}
async function summary(client: Client, id: string) {
  if (!/^\d{1,16}$/.test(id)) throw Error('ESPN 比赛编号无效')
  const url = `${ESPN}/summary?event=${id}`, payload = await client.json(url)
  return { payload, game: verifiedGame(payload, url) }
}
function dateHint(article: Pick<NbaArticle, 'body'> & Partial<Pick<NbaArticle, 'title'>>) {
  const lead = `${article.title || ''}\n${article.body}`.slice(0, 1100).replace(/\d{1,2}月\d{1,2}日讯/g,'')
  const numeric = /\b(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})(?:日|\b)/.exec(lead)
  const american = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(lead)
  const english = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i.exec(lead)
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
  const full = numeric ? `${numeric[1]}-${numeric[2].padStart(2,'0')}-${numeric[3].padStart(2,'0')}`
    : english ? `${english[3]}-${String(months.indexOf(english[1].slice(0,3).toLowerCase()) + 1).padStart(2,'0')}-${english[2].padStart(2,'0')}`
    : american ? `${american[3]}-${american[1].padStart(2,'0')}-${american[2].padStart(2,'0')}` : undefined
  const short = /(?:北京时间\s*)?(\d{1,2})月(\d{1,2})日/.exec(lead)
  return { full, short: short ? `${short[1].padStart(2,'0')}-${short[2].padStart(2,'0')}` : undefined, beijing: /北京时间/.test(lead.slice(0, 200)) }
}
function datesConflict(article: Pick<NbaArticle, 'title' | 'body'>, game: NbaGame) {
  const hint = dateHint(article), expected = hint.beijing ? dateInZone(game.tipoffUtc, 'Asia/Shanghai') : game.localDate
  return Boolean(hint.full && hint.full !== expected || !hint.full && hint.short && hint.short !== expected.slice(5))
}
function fitsGame(article: Pick<NbaArticle, 'title' | 'body'> & Partial<Pick<NbaArticle,'publishedAt'>>, game: NbaGame, direct = false) {
  if (datesConflict(article,game)) return false
  if (direct) return true
  if (!dateHint(article).full && article.publishedAt) {
    const distance = Date.parse(article.publishedAt) - Date.parse(game.tipoffUtc)
    if (Number.isFinite(distance) && (distance < -3 * 3600000 || distance > 14 * 86400000)) return false
  }
  return matchesPairAndScore(article,game)
}
function matchesPairAndScore(article: Pick<NbaArticle, 'title' | 'body'>, game: NbaGame) {
  const text = `${article.title}\n${article.body}`
  const score = new RegExp(`\\b(?:${game.home.score}\\s*[-\u2013\u2014:\uFF1A比]\\s*${game.away.score}|${game.away.score}\\s*[-\u2013\u2014:\uFF1A比]\\s*${game.home.score})\\b`)
  return mentions(text, aliases(game.home.abbreviation, game.home.name)) && mentions(text, aliases(game.away.abbreviation, game.away.name)) && score.test(text)
}
async function scoreboardGames(client: Client, date?: string) {
  const url = `${ESPN}/scoreboard${date ? `?dates=${date.replace(/-/g, '')}` : ''}`
  const payload = await client.json(url)
  return (payload.events || []).map((row: Row) => verifiedGame(row, url)).filter(Boolean) as NbaGame[]
}
async function nbaGame(client: Client, id: string) {
  const nbaUrl = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${id}.json`, payload = await client.json(nbaUrl), game = payload.game
  if (game?.gameStatus !== 3 || !Number.isFinite(Date.parse(game.gameTimeUTC))) return undefined
  const utc = new Date(game.gameTimeUTC), previous = new Date(utc.getTime() - 86400000)
  const games = [...await scoreboardGames(client, previous.toISOString().slice(0,10)), ...await scoreboardGames(client, utc.toISOString().slice(0,10))]
  const matched = games.filter(row => abbreviation(row.home.abbreviation) === abbreviation(game.homeTeam?.teamTricode || '')
    && abbreviation(row.away.abbreviation) === abbreviation(game.awayTeam?.teamTricode || '')
    && row.home.score === Number(game.homeTeam.score) && row.away.score === Number(game.awayTeam.score)
    && Math.abs(Date.parse(row.tipoffUtc) - utc.getTime()) < 3600000)
  const unique = [...new Map(matched.map(row => [row.id, row])).values()]
  return unique.length === 1 ? { ...unique[0], nbaGameId: id, evidenceUrls: [...unique[0].evidenceUrls, nbaUrl] } : undefined
}
async function clevelandArticle(client: Client, sourceUrl: string): Promise<Row> {
  const source = new URL(sourceUrl); source.hostname = 'cleveland.com'
  const response = await client.json(`https://r.jina.ai/${source.href}`,{Accept:'application/json'}), data = response.data
  if (response.code !== 200 || !data || typeof data.content !== 'string' || !data.title || !data.url) throw Error('Reader 未提供完整新闻内容')
  const returned = new URL(publicUrl(data.url))
  if (!/^(?:www\.)?cleveland\.com$/.test(returned.hostname) || returned.pathname !== source.pathname || data.httpStatus && data.httpStatus !== 200) throw Error('Reader 返回的原站地址或状态不符')
  const heading = /^#\s+(.+)$/m.exec(data.content)
  if (!heading || normalize(heading[1]) !== normalize(data.title)) throw Error('Reader 未找到与标题相符的文章区域')
  const content = data.content.slice(heading.index + heading[0].length)
  const author = /(?:^|\n)By[ \t]*\n(?:\*[ \t]*)?\[([^\]]+)\]\(https:\/\/(?:www\.)?cleveland\.com\/staff\/[^)\n]+\)/.exec(content)
  if (!author) throw Error('Reader 未找到文章作者与正文边界')
  const afterAuthor = content.slice(author.index + author[0].length)
  const ending = /^\[!\[[^\n]*(?:headshot|author-service-images)[^\n]*$|^#{1,3}\s+(?:Comments|Footer Navigation)\b/m.exec(afterAuthor)
  if (!ending) throw Error('Reader 未找到正文结尾，未将可能截断的内容作为完整文章')
  const paragraphs: string[] = []
  let skipVideoTitle = false, related = false
  for (const value of afterAuthor.slice(0,ending.index).split(/\n\s*\n/)) {
    const paragraph = value.trim()
    if (!paragraph) continue
    if (/^Keep Watching\b/i.test(paragraph)) { skipVideoTitle = true; continue }
    if (skipVideoTitle) { skipVideoTitle = false; continue }
    if (/^#{1,4}\s+More\b.*\bcoverage\b/i.test(paragraph)) { related = true; continue }
    if (related && /^[*-]\s/.test(paragraph)) continue
    related = false
    if (/^#{1,4}\s|^(?:!\[|\[!\[|\[Video\s)|^[*-]\s+\*\*RELATED\*\*/.test(paragraph)
      || /^(?:\d{1,2}:\d{2}(?:\s*\/\s*\d{1,2}:\d{2})?|\/|Watch More)$/i.test(paragraph)) continue
    const cleaned = plain(paragraph.replace(/\[([^\]]+)\]\((?:[^()\n]|\([^)]*\))*\)/g,'$1').replace(/\*\*([^*]+)\*\*/g,'$1'))
    if (cleaned) paragraphs.push(cleaned)
  }
  const articleBody = paragraphs.join('\n\n')
  if (/subscribe to (?:read|continue)|subscriber[- ]only content|purchase a subscription to (?:read|continue)/i.test(articleBody)) throw Error('Reader 正文被订阅提示截断')
  return { headline:data.title,articleBody,publisher:{name:'cleveland.com'},author:{name:author[1].replace(/,\s*cleveland\.com$/i,'').trim()},datePublished:data.publishedTime }
}
async function readCandidate(candidate: Candidate, client: Client, now: () => Date): Promise<{ article: NbaArticle; raw: Row }> {
  let raw = candidate.raw, url = publicUrl(candidate.url), game = candidate.game, body = '', title = candidate.title || '', publisher = candidate.publisher || new URL(url).hostname, byline: string | undefined, publishedAt: string | undefined
  const eventId = eventFromUrl(url), storyId = storyFromUrl(url), nbaId = /(^|\.)nba\.com$/.test(new URL(url).hostname) ? /\/game\/(?:[^/]*-)?(\d{10})(?:\/|$)/.exec(new URL(url).pathname)?.[1] : undefined
  if (eventId || nbaId) {
    if (nbaId) { game = await nbaGame(client, nbaId); if (!game?.espnEventId) throw Error('NBA 比赛链接尚未与 ESPN 已完赛记录核对，未取得可用正文') }
    const result = await summary(client, eventId || game!.espnEventId!)
    game = game || result.game; raw = result.payload.article
    if (!raw?.story) throw Error('比赛 API 未提供完整赛后报道正文')
    // The body is the ESPN-hosted recap, not an invented body for the NBA page.
    if (nbaId) url = `https://www.espn.com/nba/recap?gameId=${game!.espnEventId}`
  } else if (storyId) {
    try {
      const payload = await client.json(`${ESPN}/news/${storyId}`)
      raw = payload.headlines?.[0] || payload.articles?.[0] || payload
    } catch { client.throwIfAborted(); raw = undefined }
  }
  if (raw) {
    body = plain(raw.story || raw.body || '').replace(/\n+(?:[-_]{3,}\s*)?(?:See AP['\u2019]s full NBA coverage here|AP NBA:\s*https?:\/\/\S+)\s*$/i,'').trim()
    title = plain(raw.headline || raw.title || title); publisher = raw.source || publisher
    byline = raw.byline || raw.author?.displayName; publishedAt = raw.published || raw.originallyPosted
    const id = linkedEvent(raw)
    if (!game && id) {
      try { game = (await summary(client, id)).game } catch { client.throwIfAborted() }
    }
  } else {
    let html = ''
    try { html = await client.text(url) } catch (error) { client.throwIfAborted(); if (!/^(?:www\.)?cleveland\.com$/.test(new URL(url).hostname)) throw error }
    const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0]))
    const meta = (key: string) => metas.find(row => (row.property || row.name)?.toLowerCase() === key)?.content
    raw = structuredArticles(html).sort((a,b) => b.articleBody.length - a.articleBody.length)[0] || {}
    const extracted = extractNbaArticleBody(html, raw.articleBody)
    body = extracted.body
    if (!extracted.safe && body) throw Error(extracted.issues.join('；'))
    title = plain(raw.headline || meta('og:title') || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || title)
    publisher = raw.publisher?.name || meta('og:site_name') || publisher
    byline = (Array.isArray(raw.author) ? raw.author[0] : raw.author)?.name || meta('author')
    publishedAt = raw.datePublished || meta('article:published_time') || meta('pubdate')
    if (/(?:this (?:article|summary|story)|本文|本篇|本摘要).{0,100}(?:AI[- ](?:assisted|generated)|(?:AI|人工智能).{0,16}(?:辅助|生成))/i.test(plain(html))) raw.aiDisclosure = true
    if (!body && /^(?:www\.)?cleveland\.com$/.test(new URL(url).hostname)) {
      raw = await clevelandArticle(client,url)
      body = raw.articleBody; title = raw.headline; publisher = raw.publisher.name; byline = raw.author.name; publishedAt = raw.datePublished
    }
  }
  const cleaned = cleanNbaArticleBody(body)
  body = cleaned.body
  if (!body) throw Error('无法读取完整新闻正文；列表描述和搜索摘要不作为正文')
  if (!cleaned.safe) throw Error(cleaned.issues.join('；'))
  if (publishedAt && !Number.isFinite(Date.parse(publishedAt))) publishedAt = undefined
  const characterCount = han(body).length, language: NbaLanguage = characterCount > words(body).length ? 'zh' : 'en'
  const article: NbaArticle = { id: `article-${hash(url).slice(0,24)}`, url, title, publisher, byline, publishedAt, language, body,
    bodyHash: hash(body), wordCount: words(body).length, characterCount, collectedAt: now().toISOString(), ...(game ? { game } : {}) }
  return { article, raw: raw || {} }
}

function duplicate(article: NbaArticle, existing: NbaArticle[]) {
  const tokens = (item: NbaArticle) => item.language === 'zh' ? [...normalize(item.body).replace(/\s/g, '')] : normalize(item.body).split(/\s+/)
  const shingles = (value: string[]) => new Set(value.slice(0, -7).map((_, index) => value.slice(index,index + 8).join(' ')))
  const selected = shingles(tokens(article))
  for (const previous of existing) {
    if (previous.url === article.url || previous.bodyHash === article.bodyHash || normalize(previous.body) === normalize(article.body)) return previous
    if (previous.language !== article.language) continue
    const other = shingles(tokens(previous)), minimum = Math.min(selected.size, other.size)
    const common = [...selected].filter(value => other.has(value)).length
    const wire = /Associated Press|\bAP\b|Reuters|AFP|美联社|路透社/i.test(`${previous.publisher} ${previous.byline || ''} ${article.publisher} ${article.byline || ''} ${article.body.slice(-350)}`)
    if (minimum >= 30 && common >= 30 && common / minimum >= (wire ? .48 : .7)) return previous
  }
  return undefined
}
async function resolve(article: NbaArticle, client: Client, options: NbaNewsOptions, preferred?: NbaGame, gameDate?: string) {
  gameDate ||= article.requestedGameDate
  const requestedId = article.requestedEspnEventId
  const allowed = (game: NbaGame) => (!requestedId || game.espnEventId === requestedId) && (!gameDate || game.localDate === gameDate)
  if (article.game?.verified && !datesConflict(article,article.game)) return allowed(article.game) ? article.game : undefined
  if (!preferred && requestedId) preferred = (await summary(client,requestedId)).game
  if (preferred && allowed(preferred) && fitsGame(article, preferred)) return preferred
  const eventId = eventFromUrl(article.url) || article.game?.espnEventId
  if (eventId) { const game = (await summary(client,eventId)).game; return game && allowed(game) && fitsGame(article,game,true) ? game : undefined }
  const storyId = storyFromUrl(article.url)
  if (storyId) {
    const payload = await client.json(`${ESPN}/news/${storyId}`), raw = payload.headlines?.[0] || payload.articles?.[0] || payload, id = linkedEvent(raw)
    if (id) { const game = (await summary(client,id)).game; return game && allowed(game) && fitsGame(article,game,true) ? game : undefined }
  }
  const hint = dateHint(article), date = gameDate || hint.full
  const prior = new Date(Date.parse(`${date || (options.now?.() || new Date()).toISOString().slice(0,10)}T12:00:00Z`) - 86400000).toISOString().slice(0,10)
  const dates = gameDate ? [date] : [date,prior]
  const games: NbaGame[] = []
  for (const day of dates) {
    try { games.push(...await scoreboardGames(client,day)) } catch { client.throwIfAborted() }
  }
  const matched = [...new Map(games.filter(game => allowed(game) && fitsGame(article,game)).map(game => [game.id,game])).values()]
  return matched.length === 1 ? matched[0] : undefined
}

/** Returns only an identified, final game. Publication time is never a game-date fallback. */
export async function resolveNbaGame(article: NbaArticle, signal?: AbortSignal, options: NbaNewsOptions = {}): Promise<NbaGame | undefined> {
  const client = transport(options,signal)
  try { return await resolve(article,client,options) }
  catch { signal?.throwIfAborted(); return undefined }
  finally { await client.close() }
}

export interface NbaVideoMetadata { title: string; description: string; uploadDate?: string }

/** Match the stated matchup and date; an omitted score comes from the final scoreboard. */
export async function resolveNbaVideoGame(metadata: NbaVideoMetadata, signal?: AbortSignal, options: NbaNewsOptions = {}): Promise<NbaGame | undefined> {
  signal?.throwIfAborted()
  const article = {title:metadata.title,body:metadata.description}, hint = dateHint(article)
  if (!hint.full || !Number.isFinite(Date.parse(`${hint.full}T12:00:00Z`))) return undefined
  const text = `${metadata.title}\n${metadata.description}`.split(/Never miss a moment|Download (?:the app|now)|Subscribe to (?:the )?NBA/i)[0]
  const identified = Object.keys(teams).filter(code => mentions(text,teams[code][1]))
  const explicitOpponent = identified.length === 1 && /\b(?:vs\.?|versus|against)\s|对阵|迎战|对战/i.test(metadata.title)
  if (identified.length < 2 && !explicitOpponent) return undefined
  const scores = [...text.matchAll(/\b(\d{2,3})\s*[-\u2013\u2014:\uFF1A比]\s*(\d{2,3})\b/g)]
    .map(match => [Number(match[1]),Number(match[2])]).filter(pair => pair.every(score => score >= 60 && score <= 200))
  const client = transport(options,signal), games:NbaGame[] = [], errors:unknown[] = []
  const prior = new Date(Date.parse(`${hint.full}T12:00:00Z`) - 86400000).toISOString().slice(0,10)
  try {
    for (const day of [hint.full,prior]) {
      try { games.push(...await scoreboardGames(client,day)) } catch (error) { signal?.throwIfAborted(); errors.push(error) }
    }
    if (errors.length === 2) throw errors[0]
    const matched = [...new Map(games.filter(game => {
      const pair = [abbreviation(game.home.abbreviation),abbreviation(game.away.abbreviation)]
      return (explicitOpponent ? pair.includes(identified[0]) : pair.every(code => identified.includes(code)))
        && !datesConflict(article,game)
        && (!scores.length || scores.some(([first,second]) => first === game.home.score && second === game.away.score
          || first === game.away.score && second === game.home.score))
    }).map(game => [game.id,game])).values()]
    return matched.length === 1 ? matched[0] : undefined
  } finally { await client.close() }
}

async function youtubeConstraint(url: string, client: Client) {
  const parsed = new URL(url), id = parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1) : parsed.searchParams.get('v') || /\/(?:shorts|embed)\/([\w-]+)/.exec(parsed.pathname)?.[1]
  if (!/^(?:www\.|m\.)?youtube\.com$|^youtu\.be$/.test(parsed.hostname) || !/^[\w-]{11}$/.test(id || '')) throw Error('YouTube 比赛链接无效')
  const canonical = `https://www.youtube.com/watch?v=${id}`
  let title = '', description = ''
  try { title = (await client.json(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`)).title || '' } catch { /* The watch-page description can still identify the topic. */ }
  try {
    const html = await client.text(canonical), metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0]))
    description = metas.find(row => row.name === 'description')?.content || ''
    title ||= metas.find(row => row.property === 'og:title')?.content || ''
    const details = /"shortDescription"\s*:\s*("(?:\\.|[^"\\])*")/.exec(html)
    if (details) description = JSON.parse(details[1])
  } catch { /* A missing description is a match blocker, never a fake article. */ }
  const text = `${title}\n${description}`.trim()
  return { url: canonical, id: id!, title, description, text, teams: Object.keys(teams).filter(code => mentions(text, aliases(code))) }
}

export async function collectNbaNews(input: NbaIntakeInput, options: NbaNewsOptions = {}): Promise<NbaIntakeResult> {
  const client = transport(options,input.signal), now = options.now || (() => new Date())
  const result: NbaIntakeResult = { articles: [], excluded: [], sources: [] }
  const pools: Record<NbaLanguage, NbaArticle[]> = { en: [], zh: [] }
  const candidates: Candidate[] = [], seenUrls = new Set<string>(), existing = [...(input.existingArticles || [])]
  let preferred: NbaGame | undefined, video: Awaited<ReturnType<typeof youtubeConstraint>> | undefined
  let topic = input.topic, topicPlan: NbaTopicSearchPlan | undefined
  const report = (id: string, label: string): NbaSourceReport => { const row: NbaSourceReport = { id, label, status: 'ok', count: 0 }; result.sources.push(row); return row }
  const fail = (row: NbaSourceReport, error: unknown) => { input.signal?.throwIfAborted(); row.status = row.count ? 'partial' : 'failed'; row.error = (error instanceof Error ? error.message : String(error)).slice(0,400) }
  try {
    input.signal?.throwIfAborted()
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || !input.languages.length || input.languages.some(value => !['en','zh'].includes(value))) throw Error('NBA 采集语言或数量无效')
    if (input.gameDate && (!/^\d{4}-\d{2}-\d{2}$/.test(input.gameDate) || !Number.isFinite(Date.parse(input.gameDate)))) throw Error('比赛日期必须为 YYYY-MM-DD')
    if (input.espnEventId) {
      const row = report('espn-game','ESPN 指定比赛核验')
      try { preferred = (await summary(client,input.espnEventId)).game; if (!preferred) throw Error('指定 ESPN 比赛尚未完赛或缺少终场数据'); row.count = 1 }
      catch (error) { fail(row,error) }
    }
    if (input.youtubeUrl && !topic) {
      const row = report('youtube-identity','YouTube 视频标题与描述')
      try {
        video = await youtubeConstraint(input.youtubeUrl,client)
        if (!video.text) throw Error('未取得视频标题或描述，请重试读取视频信息')
        if (!input.espnEventId && !input.gameDate) topic = { id:`youtube-${video.id}`, videoId:video.id,
          title:video.title || video.description.slice(0, 120), description:video.description, youtubeUrl:video.url }
        row.count = 1
      }
      catch (error) { fail(row,error) }
    }
    if (topic) {
      const row = report('sports-topic','视频人物与事件搜索词')
      try { topicPlan = await (options.topicPlan || planNbaTopicSearch)(topic,input.signal); row.count = 1 }
      catch (error) { fail(row,error); return result }
    }
    if (input.articleUrls.length) candidates.push(...input.articleUrls.map(url => ({ url })))
    else if (topicPlan) {
      for (const query of topicQueries(topicPlan,input.languages)) {
        const row = report(`topic-search-${query.language}`,`${query.language === 'en' ? '英文' : '中文'}体育主题搜索：${query.query}`)
        input.progress?.(`寻找与视频匹配的${query.language === 'en' ? '英文' : '中文'}新闻：${query.query}`)
        try {
          let items: Candidate[] = []
          if (options.searchImpl) items = topicSearchResults(await options.searchImpl(query.query,input.signal))
          else {
            for (const searchQuery of [...new Set([query.query,fallbackTopicQuery(topicPlan,query.language)])]) {
              try {
                if (query.language === 'en') {
                  const payload = await client.json(`https://site.web.api.espn.com/apis/search/v2?region=us&lang=en&query=${encodeURIComponent(searchQuery)}&limit=15&page=1`)
                  items = (payload.results || []).filter((group:Row) => group.type === 'article')
                    .flatMap((group:Row) => (group.contents || []).filter((item:Row) => !item.isPremium && item.link?.web)
                      .map((item:Row) => ({url:item.link.web,title:item.displayName,publisher:'ESPN'})))
                } else {
                  const payload = await client.json(`https://search.sina.com.cn/api/news?q=${encodeURIComponent(searchQuery)}&page=1&size=20`)
                  if (payload.code !== 0 || !Array.isArray(payload.data?.list)) throw Error('新浪主题搜索未返回链接列表')
                  items = payload.data.list.filter((item:Row) => typeof item.url === 'string')
                    .map((item:Row) => ({url:item.url,title:plain(item.title || ''),publisher:item.media_show || '新浪新闻'}))
                }
              } catch { input.signal?.throwIfAborted() }
              if (items.length) break
            }
            if (!items.length) items = topicSearchResults(await searchNbaTopic(query.query,input.signal))
          }
          candidates.push(...items.map(item => ({...item,language:query.language}))); row.count = items.length
        } catch (error) { fail(row,error) }
      }
    }
    else {
      if (input.languages.includes('en')) {
        const row = report('espn-news','ESPN NBA 结构化新闻')
        try {
          if (input.espnEventId && preferred) candidates.push({ url: `https://www.espn.com/nba/recap?gameId=${input.espnEventId}`, game: preferred })
          const payload = await client.json(`${ESPN}/news?limit=30`)
          const items = payload.articles || payload.headlines || []
          for (const raw of items) if (raw.links?.web?.href && (!preferred || linkedEvent(raw) === preferred.espnEventId
            || mentions(raw.headline || '',aliases(preferred.home.abbreviation,preferred.home.name)) && mentions(raw.headline || '',aliases(preferred.away.abbreviation,preferred.away.name)))) candidates.push({ url: raw.links.web.href, title: raw.headline, publisher: 'ESPN' })
          row.count = items.length
          if (!row.count && !preferred) throw Error('ESPN 新闻列表为空')
        } catch (error) { fail(row,error) }
      }
      if (input.languages.includes('zh')) {
        if (preferred) {
          const row = report('sina-game-search','新浪指定比赛新闻搜索')
          try {
            const chineseName = (code:string) => teams[abbreviation(code)]?.[1].find(name => /\p{Script=Han}/u.test(name)) || code
            const query = `${chineseName(preferred.home.abbreviation)} ${chineseName(preferred.away.abbreviation)} ${preferred.home.score} ${preferred.away.score}`
            const payload = await client.json(`https://search.sina.com.cn/api/news?q=${encodeURIComponent(query)}&page=1&size=20`), items = payload.data?.list
            if (payload.code !== 0 || !Array.isArray(items)) throw Error('新浪比赛搜索未返回有效链接列表')
            const selected = items.filter((item:Row) => {
              try { return /(^|\.)sina\.com\.cn$/.test(new URL(item.url).hostname) && !forbidden(plain(item.title || ''),'') } catch { return false }
            }).sort((a:Row,b:Row) => Number(new URL(a.url).hostname === 'k.sina.com.cn') - Number(new URL(b.url).hostname === 'k.sina.com.cn'))
            candidates.push(...selected.map((raw:Row) => ({url:raw.url,title:plain(raw.title || ''),publisher:raw.media_show || '新浪新闻'})))
            row.count = selected.length
          } catch (error) { fail(row,error) }
        }
        const row = report('sina-nba','新浪 NBA 结构化栏目')
        try {
          const payload = await client.json(SINA), items = payload.result?.data?.items
          if (payload.result?.status?.code !== 0 || !Array.isArray(items)) throw Error('新浪 NBA 栏目未返回有效新闻列表')
          candidates.push(...items.filter((raw:Row) => !preferred || mentions(raw.title || '',aliases(preferred.home.abbreviation,preferred.home.name)) && mentions(raw.title || '',aliases(preferred.away.abbreviation,preferred.away.name))).map((raw: Row) => ({ url: raw.url, title: raw.title, publisher: raw.media || '新浪体育' }))); row.count = items.length
        } catch (error) { fail(row,error) }
      }
    }
    // Interleave candidates before fetching, then interleave eligible bodies again after filtering.
    const isChineseSource = (row: Candidate) => { try { return row.language === 'zh' || /sina\.c(?:om\.cn|n)/.test(new URL(row.url).hostname) } catch { return false } }
    const english = candidates.filter(row => !isChineseSource(row))
    const chinese = candidates.filter(isChineseSource)
    const ordered = input.articleUrls.length ? candidates : Array.from({length: Math.max(english.length,chinese.length)},(_,index) => [english[index],chinese[index]]).flat().filter(Boolean) as Candidate[]
    const candidateLimit = Math.min(Math.max(60,input.limit), Math.max(12,input.limit * 6))
    for (const candidate of ordered.slice(0, candidateLimit)) {
      input.signal?.throwIfAborted()
      if (pools.en.length + pools.zh.length >= input.limit && [...new Set(input.languages)].slice(0,input.limit).every(language => pools[language].length > 0)) break
      let safeUrl: string
      try { safeUrl = publicUrl(candidate.url) } catch (error) { result.excluded.push({url: candidate.url,title: candidate.title || '',reason: String(error)}); continue }
      if (seenUrls.has(safeUrl)) continue
      seenUrls.add(safeUrl)
      const row = report(`article-${hash(safeUrl).slice(0,12)}`, candidate.title || new URL(safeUrl).hostname)
      input.progress?.(`读取 NBA 新闻正文：${candidate.title || new URL(safeUrl).hostname}`)
      try {
        const { article, raw } = await readCandidate(candidate,client,now)
        input.signal?.throwIfAborted()
        article.requestedGameDate = input.gameDate
        article.requestedEspnEventId = input.espnEventId
        const reason = topic ? undefined : raw.aiDisclosure ? '原站披露 AI 辅助，不应自动生产' : forbidden(article.title,article.body)
        if (reason) { result.excluded.push({url:article.url,title:article.title,reason}); continue }
        if (!input.languages.includes(article.language)) { result.excluded.push({url:article.url,title:article.title,reason:'不在本轮语言范围'}); continue }
        if (article.language === 'en' ? article.wordCount < 100 : article.characterCount < 100) { result.excluded.push({url:article.url,title:article.title,reason:article.language === 'en' ? `英文正文仅${article.wordCount}词，少于100词` : `中文正文仅${article.characterCount}个汉字，少于100个汉字`}); continue }
        const previous = duplicate(article,existing)
        if (previous) { result.excluded.push({url:article.url,title:article.title,reason:'正文或通讯社转载内容重复',duplicateOf:previous.url}); continue }
        if (topic && topicPlan) {
          if (!matchesNbaTopic(article,topicPlan,topic)) { result.excluded.push({url:article.url,title:article.title,reason:'新闻正文与视频人物或主题不匹配'}); continue }
          const topicTitle = topic.title
          const topicTeams = Object.keys(teams).filter(code => mentions(topicTitle,teams[code][1]))
          const articleTeams = article.game
            ? [abbreviation(article.game.home.abbreviation),abbreviation(article.game.away.abbreviation)]
            : Object.keys(teams).filter(code => mentions(article.title,aliases(code)))
          if (topicTeams.length === 2 && articleTeams.length >= 2 && articleTeams.some(code => !topicTeams.includes(code))) {
            result.excluded.push({url:article.url,title:article.title,reason:'新闻对阵与视频标题明确给出的双方球队不符'}); continue
          }
          if (article.game && datesConflict({title:topic.title,body:topic.description},article.game)) {
            result.excluded.push({url:article.url,title:article.title,reason:'新闻比赛与 YouTube 视频明确给出的日期不符'}); continue
          }
          article.topic = topic
          article.youtubeUrl = topic.youtubeUrl
          article.sourceVideoId = topic.videoId
          article.sourceChannel = topic.channel
          if (!article.game && preferred && fitsGame(article,preferred)) article.game = preferred
          row.count = 1; row.label = article.title; pools[article.language].push(article); existing.push(article)
          continue
        }
        const identifiedGame = article.game
        try { article.game = await resolve(article,client,options,preferred,input.gameDate) }
        catch (error) { input.signal?.throwIfAborted(); article.heldReason = `比赛尚待核验：${error instanceof Error ? error.message : String(error)}` }
        const headlineTeams = Object.keys(teams).filter(code => mentions(article.title,aliases(code)))
        if (input.espnEventId && (identifiedGame?.espnEventId || linkedEvent(raw)) && (identifiedGame?.espnEventId || linkedEvent(raw)) !== input.espnEventId
          || input.gameDate && identifiedGame && identifiedGame.localDate !== input.gameDate
          || preferred && (datesConflict(article,preferred) && (matchesPairAndScore(article,preferred) || linkedEvent(raw) === preferred.espnEventId || eventFromUrl(article.url) === preferred.espnEventId)
            || headlineTeams.length >= 2 && (!headlineTeams.includes(abbreviation(preferred.home.abbreviation)) || !headlineTeams.includes(abbreviation(preferred.away.abbreviation))))) {
          result.excluded.push({url:article.url,title:article.title,reason:'正文比赛与指定比赛编号或比赛日期不符'}); continue
        }
        if (!article.game) article.heldReason ||= '比赛尚待核验：正文未能唯一对应已完赛的 ESPN 比赛记录'
        if (input.youtubeUrl) {
          article.youtubeUrl = video?.url || input.youtubeUrl
          if (video && video.teams.length >= 2 && article.game && (!video.teams.includes(abbreviation(article.game.home.abbreviation)) || !video.teams.includes(abbreviation(article.game.away.abbreviation)))) {
            result.excluded.push({url:article.url,title:article.title,reason:'文章比赛与指定 YouTube 视频中的球队不符'}); continue
          }
          if (video && article.game && datesConflict({title:'',body:video.text},article.game)) {
            result.excluded.push({url:article.url,title:article.title,reason:'文章比赛与指定 YouTube 视频中的比赛日期不符'}); continue
          }
          if (!video || video.teams.length < 2) article.heldReason ||= '视频比赛尚待核验：已保存指定链接，标题或描述未能确认双方球队'
        }
        row.count = 1; row.label = article.title; pools[article.language].push(article); existing.push(article)
      } catch (error) {
        fail(row,error); result.excluded.push({url:safeUrl,title:candidate.title || '',reason:`正文读取失败：${row.error}`})
      }
    }
    for (let index = 0; result.articles.length < input.limit && index < Math.max(pools.en.length,pools.zh.length); index++) {
      for (const language of [...new Set(input.languages)]) if (pools[language][index] && result.articles.length < input.limit) result.articles.push(pools[language][index])
    }
    return result
  } finally { await client.close() }
}
