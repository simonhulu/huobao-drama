import '../src/load-env.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareNbaBodyImage } from '../src/services/nba-cover-body-image.js'

const directory = fileURLToPath(new URL('../../outputs/nba-cover-action-20261105/sources/', import.meta.url))
for (const photo of [
  { file: 'luka-render.png', playerName: 'Luka Doncic', teamName: 'Los Angeles Lakers', teamAbbreviation: 'LAL' },
  { file: 'bam-render.png', playerName: 'Bam Adebayo', teamName: 'Miami Heat', teamAbbreviation: 'MIA' },
]) {
  const result = await prepareNbaBodyImage({ ...photo, filename: path.join(directory, photo.file), signal: AbortSignal.timeout(150000) })
  console.log(JSON.stringify({ source: photo.file, result }))
}
