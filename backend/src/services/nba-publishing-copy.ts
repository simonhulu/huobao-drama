import type { NbaJob } from './nba-types.js'
import { nbaTeamName } from './nba-news.js'

export const NBA_BAIJIAHAO_TOPIC = '#NBA#'
export const NBA_COPY_POLICY = 'nba-match-event-v1'
const suffix = ` ${NBA_BAIJIAHAO_TOPIC}`

export function legacyNbaDescription(title: string, mode: 'draft' | 'publish') {
  return mode === 'draft' ? title : `${[...title].slice(0, 50 - suffix.length).join('').trimEnd()}${suffix}`
}

export function nbaPublishingDescription(job: NbaJob): string {
  const title = (job.script?.title || job.title).trim()
  const game = job.game || job.article.game
  const date = game?.localDate
  const dated = game?.verified && date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  const prefix = dated ? `${date} NBA｜` : '', budget = 50 - prefix.length - suffix.length
  const headline = title.replace(/^\d{4}-\d{2}-\d{2}\s*NBA[｜|]\s*/i, '')
    .replace(/(?:\s*#NBA#)+\s*$/i, '').replace(/(?:砍下|拿下|得到|贡献)(?=\d)/g, '').trim()
  const quoted = /["“”‘’「」『』]/u.test(headline)
  const clauses = quoted ? [headline] : headline.split(/[，,；;。！？!?]/u).map(clause => clause.trim()).filter(Boolean)
  const candidates: string[] = []
  let match = ''
  if (dated && game) {
    const home = nbaTeamName(game.home.abbreviation), away = nbaTeamName(game.away.abbreviation)
    const winner = game.home.score > game.away.score ? { ...game.home, name: home } : { ...game.away, name: away }
    const loser = game.home.score > game.away.score ? { ...game.away, name: away } : { ...game.home, name: home }
    const scoresValid = [game.home.score, game.away.score].every(score => Number.isInteger(score) && score >= 0) && winner.score !== loser.score
    match = scoresValid ? `${winner.name}${winner.score}-${loser.score}${loser.name}` : `${home}对${away}`
    const hasTeams = headline.includes(home) && headline.includes(away)
    // Keep quotations intact; only replace a separate result clause.
    if (!quoted && hasTeams && clauses.length > 1 && !clauses[0].includes(home) && !clauses[0].includes(away)) {
      candidates.push(`${clauses[0]}，${match}`)
    }
    if (!quoted && !hasTeams) candidates.push(`${headline}，${match}`)
  }
  candidates.push(headline)
  for (let count = clauses.length - 1; count > 0; count--) candidates.push(clauses.slice(0, count).join('，'))
  candidates.push(match)
  let body = candidates.find(value => value && value.length <= budget)
  if (!body && !quoted) {
    body = ''
    for (const { segment } of new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(headline)) {
      if (body.length + segment.length > budget) break
      body += segment
    }
    body = body.replace(/[，,；;。！？!?、：:\s]+$/u, '')
  }
  body ||= 'NBA赛场动态'
  return `${prefix}${body}${suffix}`
}
