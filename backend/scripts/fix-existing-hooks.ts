import { eq, and, isNull, asc } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'

async function main() {
  const dramaId = 26
  const eps = db.select()
    .from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))
    .orderBy(asc(schema.episodes.episodeNumber))
    .all()
    .filter(ep => ep.episodeNumber >= 3 && ep.episodeNumber <= 7)

  for (const ep of eps) {
    const sbs = db.select()
      .from(schema.storyboards)
      .where(and(eq(schema.storyboards.episodeId, ep.id), isNull(schema.storyboards.deletedAt)))
      .orderBy(asc(schema.storyboards.storyboardNumber))
      .all()
    if (sbs.length === 0) {
      console.log(`Episode ${ep.episodeNumber}: no storyboards`)
      continue
    }

    const first = sbs[0]
    const last = sbs[sbs.length - 1]
    const openingHook = (ep.openingHook || '').trim()
    const cliffhanger = (ep.cliffhanger || '').trim()

    let firstNarration = (first.narration || '').trim()
    if (openingHook && !firstNarration.startsWith(openingHook)) {
      firstNarration = `${openingHook}\n\n${firstNarration}`
    }

    let lastNarration = (last.narration || '').trim()
    if (cliffhanger && !lastNarration.endsWith(cliffhanger)) {
      lastNarration = `${lastNarration}\n\n${cliffhanger}`
    }

    const now = new Date().toISOString()

    db.update(schema.storyboards)
      .set({ narration: firstNarration, updatedAt: now })
      .where(eq(schema.storyboards.id, first.id))
      .run()

    db.update(schema.storyboards)
      .set({ narration: lastNarration, updatedAt: now })
      .where(eq(schema.storyboards.id, last.id))
      .run()

    // 清除本集所有镜头的音频/字幕/合成视频，确保后续重新生成
    db.update(schema.storyboards)
      .set({
        ttsAudioUrl: null,
        narrationAudioUrl: null,
        subtitleUrl: null,
        composedVideoUrl: null,
        updatedAt: now,
      })
      .where(eq(schema.storyboards.episodeId, ep.id))
      .run()

    console.log(`Episode ${ep.episodeNumber} (#${ep.id}): updated first=${first.id}, last=${last.id}, cleared ${sbs.length} storyboards media`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
