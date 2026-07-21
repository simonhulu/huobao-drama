#!/usr/bin/env node
import { db, schema } from '../src/db/index.js'
import { eq, asc } from 'drizzle-orm'
import { composeStoryboard } from '../src/services/ffmpeg-compose.js'
import { enqueueEpisodeMerge, executeEpisodeMerge } from '../src/services/ffmpeg-merge.js'

const episodeId = Number(process.argv[2]) || 38
const dramaId = Number(process.argv[3]) || 14

async function main() {
  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()

  console.log(`Recomposing ${sbs.length} storyboards for episode ${episodeId}`)
  for (const sb of sbs) {
    console.log(`  Composing #${sb.storyboardNumber} (${sb.id})`)
    await composeStoryboard(sb.id, { force: true })
  }

  console.log('Merging episode...')
  const mergeId = enqueueEpisodeMerge(episodeId, dramaId)
  const result = await executeEpisodeMerge(mergeId)
  console.log('Done:', result)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
