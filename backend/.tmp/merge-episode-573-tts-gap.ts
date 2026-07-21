import { createHash } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { applyPreTTSTimingsToStoryboards } from '../src/services/episode-tts.js'
import { restoreOriginalTextNarrations } from '../src/services/narration-generation.js'

const EPISODE_ID = 573
const PREVIOUS_ID = 4400
const GAP_SHOT_ID = 4454

function compact(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

db.transaction((tx) => {
  const [previous] = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, PREVIOUS_ID)).all()
  const [gapShot] = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, GAP_SHOT_ID)).all()
  if (!previous || !gapShot) throw new Error('Missing storyboard at the pre-TTS title boundary')
  if (gapShot.storyboardNumber !== previous.storyboardNumber + 1) {
    throw new Error('The pre-TTS gap shot is not adjacent to its semantic predecessor')
  }

  const narration = `${previous.narration || ''}${gapShot.narration || ''}`
  const now = new Date().toISOString()
  tx.update(schema.storyboards).set({
    title: '低价逼迫对手每桶都少赚',
    action: narration,
    description: narration,
    narration,
    imagePrompt: '',
    imagePromptFinal: false,
    videoPrompt: null,
    gridSheetImage: null,
    gridCells: null,
    narrationAudioUrl: null,
    composedVideoUrl: null,
    status: 'pending',
    updatedAt: now,
  }).where(eq(schema.storyboards.id, PREVIOUS_ID)).run()

  const characterRows = tx.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, GAP_SHOT_ID))
    .all()
  for (const row of characterRows) {
    tx.insert(schema.storyboardCharacters)
      .values({ storyboardId: PREVIOUS_ID, characterId: row.characterId })
      .onConflictDoNothing()
      .run()
  }
  tx.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, GAP_SHOT_ID))
    .run()
  tx.delete(schema.storyboards).where(eq(schema.storyboards.id, GAP_SHOT_ID)).run()

  const shots = tx.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, EPISODE_ID))
    .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id))
    .all()
  for (let index = 0; index < shots.length; index++) {
    tx.update(schema.storyboards)
      .set({ storyboardNumber: index + 1, updatedAt: now })
      .where(eq(schema.storyboards.id, shots[index].id))
      .run()
  }
})

const restored = restoreOriginalTextNarrations(EPISODE_ID)
const timings = applyPreTTSTimingsToStoryboards(EPISODE_ID)
const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, EPISODE_ID)).all()
const shots = db.select().from(schema.storyboards)
  .where(eq(schema.storyboards.episodeId, EPISODE_ID))
  .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id))
  .all()
const source = compact(episode.scriptContent || episode.content || '')
const joined = compact(shots.map((shot) => shot.narration || '').join(''))

const audit = {
  restored,
  timings,
  shotCount: shots.length,
  durationSum: shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0),
  maxDuration: Math.max(...shots.map((shot) => Number(shot.duration || 0))),
  sourceSha256: sha256(source),
  joinedSha256: sha256(joined),
  exactMatch: source === joined,
  emptyNarrations: shots.filter((shot) => !(shot.narration || '').trim()).map((shot) => shot.id),
  overEightSeconds: shots.filter((shot) => Number(shot.duration || 0) > 8)
    .map((shot) => ({ id: shot.id, number: shot.storyboardNumber, duration: shot.duration })),
  badNumbers: shots.filter((shot, index) => shot.storyboardNumber !== index + 1)
    .map((shot, index) => ({ id: shot.id, actual: shot.storyboardNumber, expected: index + 1 })),
}

console.log(JSON.stringify(audit, null, 2))
if (!audit.exactMatch || audit.timings.fallback || audit.emptyNarrations.length || audit.overEightSeconds.length || audit.badNumbers.length) {
  process.exitCode = 1
}
