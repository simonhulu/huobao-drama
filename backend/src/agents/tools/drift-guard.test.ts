import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-tools-drift-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../../db/index.js')
const { createVoiceTools } = await import('./voice-tools.js')
const { createExtractTools } = await import('./extract-tools.js')

function seedDramaAndEpisode() {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Drift Test',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode 1',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  return { dramaId, episodeId, ts }
}

test('assignVoice skips update when character already has voiceStyle', async () => {
  const { dramaId, episodeId, ts } = seedDramaAndEpisode()
  const charId = Number(db.insert(schema.characters).values({
    dramaId,
    name: 'Alice',
    voiceStyle: 'existing-voice',
    voiceProvider: 'minimax',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const tools = createVoiceTools(episodeId, dramaId)
  const result = await (tools.assignVoice.execute as any)({ character_id: charId, voice_id: 'new-voice', reason: 'test' }, {} as any) as any

  assert.equal(result.skipped, true)
  assert.match(result.message, /already has voice/)

  const [row] = db.select().from(schema.characters).where(eq(schema.characters.id, charId)).all()
  assert.equal(row.voiceStyle, 'existing-voice')
  assert.equal(row.voiceProvider, 'minimax')
})

test('assignVoice updates when character has no voiceStyle', async () => {
  const { dramaId, episodeId, ts } = seedDramaAndEpisode()
  const charId = Number(db.insert(schema.characters).values({
    dramaId,
    name: 'Bob',
    voiceStyle: '',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const tools = createVoiceTools(episodeId, dramaId)
  const result = await (tools.assignVoice.execute as any)({ character_id: charId, voice_id: 'new-voice', reason: 'test' }, {} as any) as any

  assert.equal(result.skipped, undefined)
  assert.match(result.message, /Assigned voice/)

  const [row] = db.select().from(schema.characters).where(eq(schema.characters.id, charId)).all()
  assert.equal(row.voiceStyle, 'new-voice')
})

test('saveDedupCharacters does not overwrite existing non-empty fields', async () => {
  const { dramaId, episodeId, ts } = seedDramaAndEpisode()
  const charId = Number(db.insert(schema.characters).values({
    dramaId,
    name: 'Charlie',
    role: 'Protagonist',
    description: 'Brave knight',
    appearance: 'Tall, armored',
    personality: 'Stoic',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId, characterId: charId, createdAt: ts }).run()

  const tools = createExtractTools(episodeId, dramaId)
  const result = await (tools.saveDedupCharacters.execute as any)({
    characters: [{
      name: 'Charlie',
      role: 'Sidekick',
      description: 'Cowardly squire',
      appearance: 'Short, scrawny',
      personality: 'Jovial',
    }],
  }, {} as any) as any

  assert.equal(result.merged, 1)

  const [row] = db.select().from(schema.characters).where(eq(schema.characters.id, charId)).all()
  assert.equal(row.role, 'Protagonist')
  assert.equal(row.description, 'Brave knight')
  assert.equal(row.appearance, 'Tall, armored')
  assert.equal(row.personality, 'Stoic')
})

test('saveDedupCharacters fills empty fields on existing characters', async () => {
  const { dramaId, episodeId, ts } = seedDramaAndEpisode()
  const charId = Number(db.insert(schema.characters).values({
    dramaId,
    name: 'Diana',
    role: '',
    description: '',
    appearance: 'Red hair',
    personality: '',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId, characterId: charId, createdAt: ts }).run()

  const tools = createExtractTools(episodeId, dramaId)
  const result = await (tools.saveDedupCharacters.execute as any)({
    characters: [{
      name: 'Diana',
      role: 'Mage',
      description: 'Wise sorcerer',
      appearance: 'Silver hair',
      personality: 'Calm',
    }],
  }, {} as any) as any

  assert.equal(result.merged, 1)

  const [row] = db.select().from(schema.characters).where(eq(schema.characters.id, charId)).all()
  assert.equal(row.role, 'Mage')
  assert.equal(row.description, 'Wise sorcerer')
  // appearance was already non-empty, so it should stay
  assert.equal(row.appearance, 'Red hair')
  assert.equal(row.personality, 'Calm')
})
