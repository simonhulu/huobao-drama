import { createHash } from 'node:crypto'
import { asc, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { splitLongStoryboardsByPreTTS, applyPreTTSTimingsToStoryboards } from '../src/services/episode-tts.js'
import { restoreOriginalTextNarrations } from '../src/services/narration-generation.js'

const EPISODE_ID = 573
const DUPLICATE_IDS = [4424, 4425]

const insertions = [
  {
    beforeId: 4374,
    title: '钻井赌一口井，炼油承担每一天',
    text: '钻井的人赌一口井，炼油的人却要天天处理别人挖出来的油。',
    location: '标准石油炼油厂',
    time: '1860年代，白天',
  },
  {
    beforeId: 4380,
    title: '成本不停，煤油却越来越便宜',
    text: '煤、木桶、人工和贷款不会因为油价下跌而停下来，只有卖出去的煤油越来越不值钱。',
    location: '标准石油炼油厂',
    time: '1860年代，傍晚',
  },
  {
    beforeId: 4391,
    title: '把不确定变成可以安排的事',
    text: '这样一来，风险在减少，能由自己安排的事情在增加，他心里也就多了一点确定性。',
    location: '标准石油炼油厂',
    time: '1865年，夜晚',
  },
  {
    beforeId: 4401,
    title: '对手每卖一桶都少赚一点',
    text: '对方每卖一桶都在少赚一点，',
    location: '克利夫兰工业区',
    time: '1870年代，白天',
  },
]

function compact(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const insertedIds = db.transaction((tx) => {
  const current = tx.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, EPISODE_ID))
    .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id))
    .all()

  const byId = new Map(current.map((shot) => [shot.id, shot]))
  for (const insertion of insertions) {
    if (!byId.has(insertion.beforeId)) {
      throw new Error(`Missing insertion anchor storyboard ${insertion.beforeId}`)
    }
  }

  tx.delete(schema.storyboardCharacters)
    .where(inArray(schema.storyboardCharacters.storyboardId, DUPLICATE_IDS))
    .run()
  tx.delete(schema.storyboards)
    .where(inArray(schema.storyboards.id, DUPLICATE_IDS))
    .run()

  const newIds: number[] = []
  const now = new Date().toISOString()
  for (const insertion of insertions) {
    const anchor = byId.get(insertion.beforeId)!
    const result = tx.insert(schema.storyboards).values({
      episodeId: EPISODE_ID,
      sceneId: anchor.sceneId,
      storyboardNumber: anchor.storyboardNumber,
      title: insertion.title,
      location: insertion.location,
      time: insertion.time,
      shotType: null,
      angle: null,
      movement: null,
      action: insertion.text,
      result: null,
      atmosphere: anchor.atmosphere,
      imagePrompt: '',
      imagePromptFinal: false,
      videoPrompt: null,
      bgmPrompt: anchor.bgmPrompt,
      soundEffect: anchor.soundEffect,
      dialogue: null,
      narration: insertion.text,
      description: insertion.text,
      duration: 1,
      energyLevel: anchor.energyLevel,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }).run()
    newIds.push(Number(result.lastInsertRowid))
  }

  const insertionByAnchor = new Map(insertions.map((item, index) => [item.beforeId, newIds[index]]))
  const orderedIds: number[] = []
  for (const shot of current) {
    if (DUPLICATE_IDS.includes(shot.id)) continue
    const insertedId = insertionByAnchor.get(shot.id)
    if (insertedId) orderedIds.push(insertedId)
    orderedIds.push(shot.id)
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

  return newIds
})

const restoredBeforeSplit = restoreOriginalTextNarrations(EPISODE_ID)
const timingsBeforeSplit = applyPreTTSTimingsToStoryboards(EPISODE_ID)
const split = await splitLongStoryboardsByPreTTS(EPISODE_ID, 8, {
  onlyStoryboardIds: [4444],
  generateImagePrompts: async () => new Map(),
})
const restoredAfterSplit = restoreOriginalTextNarrations(EPISODE_ID)
const timingsAfterSplit = applyPreTTSTimingsToStoryboards(EPISODE_ID)

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
  .map((shot) => ({ id: shot.id, actual: shot.storyboardNumber, expected: shots.indexOf(shot) + 1 }))

let cursor = 0
const orderingErrors: Array<{ id: number; number: number; narration: string }> = []
for (const shot of shots) {
  const fragment = compact(shot.narration || '')
  const foundAt = source.indexOf(fragment, cursor)
  if (!fragment || foundAt !== cursor) {
    orderingErrors.push({ id: shot.id, number: shot.storyboardNumber, narration: shot.narration || '' })
    if (foundAt >= 0) cursor = foundAt + fragment.length
  } else {
    cursor += fragment.length
  }
}

const audit = {
  insertedIds,
  restoredBeforeSplit,
  timingsBeforeSplit,
  split,
  restoredAfterSplit,
  timingsAfterSplit,
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
