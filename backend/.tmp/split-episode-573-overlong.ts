import { createHash } from 'node:crypto'
import { asc, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { applyPreTTSTimingsToStoryboards } from '../src/services/episode-tts.js'
import { restoreOriginalTextNarrations } from '../src/services/narration-generation.js'

const EPISODE_ID = 573

const splitPlans = [
  {
    id: 4452,
    fragments: [
      '煤、木桶、人工和贷款不会因为油价下跌而停下来，',
      '只有卖出去的煤油越来越不值钱。',
    ],
  },
  {
    id: 4444,
    fragments: [
      '时代给了他石油、铁路和汽车，',
      '贫穷逼着他学会算账，而他自己把这种能力用到了极致。',
    ],
  },
]

function compact(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const replacements = db.transaction((tx) => {
  const current = tx.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, EPISODE_ID))
    .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id))
    .all()
  const byId = new Map(current.map((shot) => [shot.id, shot]))
  const now = new Date().toISOString()
  const childIdsByParent = new Map<number, number[]>()

  for (const plan of splitPlans) {
    const parent = byId.get(plan.id)
    if (!parent) throw new Error(`Missing overlong storyboard ${plan.id}`)
    if (compact(plan.fragments.join('')) !== compact(parent.narration || '')) {
      throw new Error(`Split fragments do not reproduce storyboard ${plan.id}`)
    }

    const characterIds = tx.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, parent.id))
      .all()
      .map((row) => row.characterId)
    const childIds: number[] = []

    for (const fragment of plan.fragments) {
      const result = tx.insert(schema.storyboards).values({
        episodeId: parent.episodeId,
        sceneId: parent.sceneId,
        storyboardNumber: parent.storyboardNumber,
        title: fragment.replace(/^[\s，,；;。！？.!?：:—]+|[\s，,；;。！？.!?：:—]+$/gu, '').slice(0, 18),
        location: parent.location,
        time: parent.time,
        shotType: null,
        angle: null,
        movement: null,
        action: fragment,
        result: null,
        atmosphere: parent.atmosphere,
        imagePrompt: '',
        imagePromptFinal: false,
        videoPrompt: null,
        bgmPrompt: parent.bgmPrompt,
        soundEffect: parent.soundEffect,
        bgmAudioUrl: null,
        sfxAudioUrl: null,
        ambientAudioUrl: null,
        dialogue: null,
        narration: fragment,
        description: fragment,
        duration: 1,
        energyLevel: parent.energyLevel,
        composedImage: null,
        firstFrameImage: null,
        lastFrameImage: null,
        referenceImages: null,
        gridSheetImage: null,
        gridCells: null,
        videoUrl: null,
        ttsAudioUrl: null,
        narrationAudioUrl: null,
        subtitleUrl: null,
        composedVideoUrl: null,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }).run()
      const childId = Number(result.lastInsertRowid)
      childIds.push(childId)
      for (const characterId of characterIds) {
        tx.insert(schema.storyboardCharacters).values({ storyboardId: childId, characterId }).run()
      }
    }
    childIdsByParent.set(parent.id, childIds)
  }

  const parentIds = splitPlans.map((plan) => plan.id)
  tx.delete(schema.storyboardCharacters)
    .where(inArray(schema.storyboardCharacters.storyboardId, parentIds))
    .run()
  tx.delete(schema.storyboards)
    .where(inArray(schema.storyboards.id, parentIds))
    .run()

  const orderedIds: number[] = []
  for (const shot of current) {
    const childIds = childIdsByParent.get(shot.id)
    if (childIds) orderedIds.push(...childIds)
    else orderedIds.push(shot.id)
  }
  for (let i = 0; i < orderedIds.length; i++) {
    tx.update(schema.storyboards)
      .set({ storyboardNumber: 10_000 + i, updatedAt: now })
      .where(eq(schema.storyboards.id, orderedIds[i]))
      .run()
  }
  for (let i = 0; i < orderedIds.length; i++) {
    tx.update(schema.storyboards)
      .set({ storyboardNumber: i + 1, updatedAt: now })
      .where(eq(schema.storyboards.id, orderedIds[i]))
      .run()
  }

  return Object.fromEntries(childIdsByParent)
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
const emptyNarrations = shots.filter((shot) => !(shot.narration || '').trim()).map((shot) => shot.id)
const overEightSeconds = shots
  .filter((shot) => Number(shot.duration || 0) > 8)
  .map((shot) => ({ id: shot.id, number: shot.storyboardNumber, duration: shot.duration }))
const badNumbers = shots
  .filter((shot, index) => shot.storyboardNumber !== index + 1)
  .map((shot, index) => ({ id: shot.id, actual: shot.storyboardNumber, expected: index + 1 }))

let cursor = 0
const orderingErrors: Array<{ id: number; number: number }> = []
for (const shot of shots) {
  const fragment = compact(shot.narration || '')
  const foundAt = source.indexOf(fragment, cursor)
  if (!fragment || foundAt !== cursor) orderingErrors.push({ id: shot.id, number: shot.storyboardNumber })
  if (foundAt >= 0) cursor = foundAt + fragment.length
}

const audit = {
  replacements,
  restored,
  timings,
  shotCount: shots.length,
  durationSum: shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0),
  maxDuration: Math.max(...shots.map((shot) => Number(shot.duration || 0))),
  sourceLength: source.length,
  joinedLength: joined.length,
  sourceSha256: sha256(source),
  joinedSha256: sha256(joined),
  exactMatch: source === joined,
  emptyNarrations,
  overEightSeconds,
  badNumbers,
  orderingErrors,
}

console.log(JSON.stringify(audit, null, 2))
if (!audit.exactMatch || emptyNarrations.length || overEightSeconds.length || badNumbers.length || orderingErrors.length) {
  process.exitCode = 1
}
