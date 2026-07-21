/**
 * 为已有的 MiniMax / 本地 BGM 补打 tags，提升素材库检索质量。
 *
 * 运行：
 *   npx tsx scripts/backfill-music-tags.ts
 */
import { loadMusicLibrary, saveMusicLibrary, deriveTagsFromPrompt } from '../src/services/music-library.js'

function main() {
  const lib = loadMusicLibrary()
  let updated = 0
  for (const entry of lib.entries) {
    if (entry.tags && entry.tags.length > 0) continue
    if (!entry.prompt || !entry.emotionBucket) continue
    entry.tags = deriveTagsFromPrompt(entry.prompt, entry.emotionBucket, entry.intensity || 'medium')
    updated++
  }
  saveMusicLibrary(lib)
  console.log(`[Backfill] Updated ${updated} entries with derived tags.`)
}

main()
