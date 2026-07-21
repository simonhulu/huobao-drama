#!/usr/bin/env node
import { generateAndSaveNarrations } from '../src/services/narration-generation.js'

const episodeId = Number(process.argv[2]) || 38
const dramaId = Number(process.argv[3]) || 14

async function main() {
  console.log(`Re-generating narrations for episode ${episodeId} (drama ${dramaId})`)
  const result = await generateAndSaveNarrations(episodeId, dramaId)
  console.log('Saved narrations:', result.narrations.length)
  console.log(result.narrations.map(n => `#${n.shot_number}: ${n.narration.slice(0, 60)}...`).join('\n'))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
