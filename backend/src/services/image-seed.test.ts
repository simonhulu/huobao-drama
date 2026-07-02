import test from 'node:test'
import assert from 'node:assert/strict'
import { buildConsistencySuffix, buildConsistencySeed, generateRandomSeed, ensureCharacterSeed, ensureSceneSeed } from './image-seed.js'
import { db, schema } from '../db/index.js'

test('buildConsistencySuffix injects Chinese ethnicity for Chinese names', () => {
  const input = {
    characters: [{ name: '猴子', appearance: '精瘦身材，板寸头', seed: null }],
    scenes: [],
    style: 'realistic',
  }
  const result = buildConsistencySuffix(input)
  assert.ok(result.includes('保持角色猴子形象一致：中国人，东亚人面孔，参考角色图'))
  assert.ok(!result.includes('精瘦身材'))
})

test('buildConsistencySuffix skips ethnicity for non-Chinese names', () => {
  const input = {
    characters: [{ name: 'John', appearance: 'tall, blond', seed: null }],
    scenes: [],
    style: null,
  }
  const result = buildConsistencySuffix(input)
  assert.ok(result.includes('保持角色John形象一致：参考角色图'))
  assert.ok(!result.includes('tall, blond'))
  assert.ok(!result.includes('中国人'))
})

test('buildConsistencySeed XORs seeds', () => {
  const input = {
    characters: [{ name: 'A', appearance: '', seed: 42 }],
    scenes: [{ location: 'office', time: 'day', seed: 7 }],
    style: null,
  }
  assert.equal(buildConsistencySeed(input), 42 ^ 7)
})

test('buildConsistencySeed includes style in seed', () => {
  const base = {
    characters: [{ name: 'A', appearance: '', seed: 42 }],
    scenes: [{ location: 'office', time: 'day', seed: 7 }],
  }
  const seedWithoutStyle = buildConsistencySeed({ ...base, style: null })
  const seedWithRealistic = buildConsistencySeed({ ...base, style: 'realistic' })
  const seedWithAnime = buildConsistencySeed({ ...base, style: 'anime' })

  assert.notEqual(seedWithRealistic, seedWithoutStyle)
  assert.notEqual(seedWithAnime, seedWithoutStyle)
  assert.notEqual(seedWithAnime, seedWithRealistic)
})

test('generateRandomSeed returns positive integer', () => {
  const seed = generateRandomSeed()
  assert.ok(Number.isInteger(seed))
  assert.ok(seed > 0)
})

test('ensureCharacterSeed returns existing seed', () => {
  const id = db.insert(schema.characters).values({
    dramaId: 1,
    name: 'TempCharacter',
    seed: 123,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run().lastInsertRowid as number

  try {
    assert.equal(ensureCharacterSeed(id), 123)
  } finally {
    db.delete(schema.characters).where(eq(schema.characters.id, id)).run()
  }
})

import { eq } from 'drizzle-orm'

test('ensureSceneSeed returns existing seed', () => {
  const id = db.insert(schema.scenes).values({
    dramaId: 1,
    episodeId: 1,
    location: 'TempLocation',
    time: 'day',
    prompt: 'temp',
    seed: 456,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run().lastInsertRowid as number

  try {
    assert.equal(ensureSceneSeed(id), 456)
  } finally {
    db.delete(schema.scenes).where(eq(schema.scenes.id, id)).run()
  }
})
