import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export function generateRandomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647) + 1
}

export function ensureCharacterSeed(id: number): number {
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) throw new Error('Character not found')
  if (char.seed != null) return char.seed

  const seed = generateRandomSeed()
  db.update(schema.characters)
    .set({ seed, updatedAt: now() })
    .where(eq(schema.characters.id, id))
    .run()
  return seed
}

export function ensureSceneSeed(id: number): number {
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  if (!scene) throw new Error('Scene not found')
  if (scene.seed != null) return scene.seed

  const seed = generateRandomSeed()
  db.update(schema.scenes)
    .set({ seed, updatedAt: now() })
    .where(eq(schema.scenes.id, id))
    .run()
  return seed
}

type ConsistencyCharacter = {
  readonly name: string | null
  readonly appearance: string | null
  readonly seed: number | null
}

type ConsistencyScene = {
  readonly location: string | null
  readonly time: string | null
  readonly seed: number | null
}

export type ConsistencyInput = {
  readonly characters: readonly ConsistencyCharacter[]
  readonly scenes: readonly ConsistencyScene[]
  readonly style: string | null
}

function hashStyle(style: string | null | undefined): number | null {
  if (!style) return null
  const trimmed = style.trim()
  if (!trimmed) return null
  let hash = 0
  for (let i = 0; i < trimmed.length; i++) {
    hash = ((hash << 5) - hash) + trimmed.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) || 1
}

export function buildConsistencySeed(input: ConsistencyInput): number | undefined {
  const characterSeeds = input.characters
    .map((char) => char.seed)
    .filter((seed): seed is number => seed != null)
  const sceneSeeds = input.scenes
    .map((scene) => scene.seed)
    .filter((seed): seed is number => seed != null)

  const styleSeed = hashStyle(input.style)
  const allSeeds = [...characterSeeds, ...sceneSeeds, ...(styleSeed != null ? [styleSeed] : [])]
  if (allSeeds.length === 0) return undefined

  return allSeeds.reduce((combined, seed) => combined ^ seed, 0) || undefined
}

function inferEthnicity(name: string): string {
  // 通过角色名判断族群：中文名（无空格且为常见中文字符）视为中国人
  if (!name || /\s/.test(name)) return ''
  const chineseNamePattern = /[一-龥]{1,6}/
  return chineseNamePattern.test(name) ? '中国人，东亚人面孔，' : ''
}

export function buildConsistencySuffix(input: ConsistencyInput): string {
  const parts: string[] = []

  for (const char of input.characters) {
    if (!char.name) continue
    const ethnicity = inferEthnicity(char.name)
    parts.push(`保持角色${char.name}形象一致：${ethnicity}参考角色图`)
  }

  if (!parts.length) return ''
  return ` ${parts.join('。')}。`
}

export function buildStoryboardConsistencyInput(storyboardId: number): ConsistencyInput {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  const links = db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
  const characterIds = links.map((l) => l.characterId)

  const characters = characterIds.length
    ? db.select().from(schema.characters).all().filter((c) => characterIds.includes(c.id))
    : []

  const scenes = sb?.sceneId
    ? db.select().from(schema.scenes).where(eq(schema.scenes.id, sb.sceneId)).all()
    : []

  const drama = sb?.episodeId
    ? db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()[0]
    : undefined
  const dramaRow = drama?.dramaId
    ? db.select().from(schema.dramas).where(eq(schema.dramas.id, drama.dramaId)).all()[0]
    : undefined

  return {
    characters: characters.map((c) => ({
      name: c.name,
      appearance: c.appearance,
      seed: c.seed,
    })),
    scenes: scenes.map((s) => ({
      location: s.location,
      time: s.time,
      seed: s.seed,
    })),
    style: dramaRow?.style || null,
  }
}

export function buildGridConsistencyInput(storyboardIds: number[]): ConsistencyInput {
  if (!storyboardIds.length) return { characters: [], scenes: [], style: null }

  const storyboards = db.select().from(schema.storyboards).all().filter((sb) => storyboardIds.includes(sb.id))
  const allCharacterIds = [...new Set(
    db.select().from(schema.storyboardCharacters).all()
      .filter((l) => storyboardIds.includes(l.storyboardId))
      .map((l) => l.characterId),
  )]

  const characters = allCharacterIds.length
    ? db.select().from(schema.characters).all().filter((c) => allCharacterIds.includes(c.id))
    : []

  const sceneIds = [...new Set(storyboards.map((sb) => sb.sceneId).filter(Boolean))]
  const scenes = sceneIds.length
    ? db.select().from(schema.scenes).all().filter((s) => sceneIds.includes(s.id))
    : []

  const episodeId = storyboards[0]?.episodeId
  const drama = episodeId
    ? db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()[0]
    : undefined
  const dramaRow = drama?.dramaId
    ? db.select().from(schema.dramas).where(eq(schema.dramas.id, drama.dramaId)).all()[0]
    : undefined

  return {
    characters: characters.map((c) => ({
      name: c.name,
      appearance: c.appearance,
      seed: c.seed,
    })),
    scenes: scenes.map((s) => ({
      location: s.location,
      time: s.time,
      seed: s.seed,
    })),
    style: dramaRow?.style || null,
  }
}
