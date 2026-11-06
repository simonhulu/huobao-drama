import '../src/load-env.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareNbaPoster } from '../src/services/nba-cover-poster.js'
import { nbaTeamName } from '../src/services/nba-news.js'
import type { NbaJob } from '../src/services/nba-types.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const teamNames = process.argv.includes('--team-names')
const ids = process.argv.slice(2).filter(value => value !== '--team-names')
if (!ids.length) ids.push('nba-b58390cfe063609a0a5b')
for (const id of ids) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid NBA job ID')
  const job = JSON.parse(await fs.readFile(path.join(root, 'data/nba-video/jobs', id, 'job.json'), 'utf8')) as NbaJob
  const game = job.game || job.article.game
  if (!game || !job.script?.title) throw new Error('Sample needs an existing game and Chinese title')
  const directory = path.join(root, 'outputs/nba-cover-posters-20261105', `${id}${teamNames ? '-team-names' : ''}`)
  const result = await prepareNbaPoster({ game, article: job.article, headline: job.script.title, directory, signal: AbortSignal.timeout(90000) }, teamNames ? {
    resolveTeams: async () => ({
      home: { abbreviation: game.home.abbreviation, name: nbaTeamName(game.home.abbreviation), color: '#9a3444' },
      away: { abbreviation: game.away.abbreviation, name: nbaTeamName(game.away.abbreviation), color: '#247d8b' },
    }),
  } : {})
  await fs.writeFile(path.join(directory, 'sample.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ jobId: id, ...result }))
}
