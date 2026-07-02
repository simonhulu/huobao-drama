import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'

const libDir = mkdtempSync(path.join(tmpdir(), 'huobao-sfx-'))
process.env.SFX_LIBRARY_PATH = libDir

const { buildMapping, findSfxFile, findAmbientFile, getSfxLibraryStats } = await import('./sfx-library.js')

function createFakeAudio(relativePath: string) {
  const fullPath = path.join(libDir, 'library', relativePath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, Buffer.from('fake audio'))
}

test('buildMapping indexes audio files and findSfxFile matches scene categories', () => {
  createFakeAudio('digital-sfx/laser_shoot.wav')
  createFakeAudio('digital-sfx/space_engine.ogg')
  createFakeAudio('water-bubbles/bubbles.mp3')
  createFakeAudio('steps/footstep_stone.wav')
  createFakeAudio('steps/wood_step.ogg')
  createFakeAudio('ui-sfx/click.wav')
  createFakeAudio('rpg-sounds/sword_hit.wav')

  const mapping = buildMapping()
  assert.equal(mapping.entries.length, 7)

  const stats = getSfxLibraryStats()
  assert.equal(stats.totalFiles, 7)
  assert.equal(stats.mappingExists, true)

  const palace = findSfxFile('历史宫殿大厅，脚步石板，木门吱呀')
  assert.ok(palace)
  assert.ok(
    palace!.includes('footstep') ||
    palace!.includes('wood_step') ||
    palace!.includes('sword_hit'),
  )

  const space = findSfxFile('太空飞船，激光充能，引擎轰鸣')
  assert.ok(space)
  assert.ok(space!.includes('laser') || space!.includes('space_engine'))

  const sea = findSfxFile('深海，水下气泡，声呐脉冲')
  assert.ok(sea)
  assert.ok(sea!.includes('bubble') || sea!.includes('underwater'))
})

test('findSfxFile returns null for empty description when library exists', () => {
  assert.equal(findSfxFile(''), null)
  assert.equal(findSfxFile('   '), null)
  assert.equal(findSfxFile(null as any), null)
})

test('findAmbientFile matches scene categories', () => {
  buildMapping()

  const palace = findAmbientFile('古代宫殿大厅')
  assert.ok(palace)
  assert.ok(palace!.includes('step') || palace!.includes('wood') || palace!.includes('sword'))

  const space = findAmbientFile('太空飞船激光')
  assert.ok(space)
  assert.ok(space!.includes('laser') || space!.includes('space') || space!.includes('digital'))

  const sea = findAmbientFile('深海水下气泡')
  assert.ok(sea)
  assert.ok(sea!.includes('bubble') || sea!.includes('water'))
})

test('findAmbientFile returns null for unrecognized scene', () => {
  buildMapping()
  assert.equal(findAmbientFile(''), null)
  assert.equal(findAmbientFile('random unrelated text'), null)
})
