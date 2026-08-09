import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_HISTORY_VISUAL_STYLE,
  HISTORY_VISUAL_STYLE_PROFILES,
  buildHistoryLookInstruction,
  buildHistoryVisualStyleDirective,
  resolveHistoryVisualStyle,
} from './history-visual-style.js'

test('historical aliases resolve to the grounded systems profile', () => {
  for (const style of [undefined, null, '', 'realistic', 'cinematic', 'documentary', 'historical_epic']) {
    assert.equal(resolveHistoryVisualStyle(style).id, DEFAULT_HISTORY_VISUAL_STYLE)
  }
})

test('specialized styles resolve without leaking to another profile', () => {
  assert.equal(resolveHistoryVisualStyle('film_noir').id, 'period_crime_35mm')
  assert.equal(resolveHistoryVisualStyle('wes_anderson').id, 'institutional_tableau')
  assert.equal(resolveHistoryVisualStyle('wuxia').id, 'old_color_wuxia')
  assert.equal(resolveHistoryVisualStyle('night_flash_snapshot').id, 'night_flash_snapshot')
  assert.equal(resolveHistoryVisualStyle('cold_eastern_epic').id, 'cold_eastern_epic')
  assert.equal(resolveHistoryVisualStyle('cold_ink_spatial').id, 'cold_ink_spatial')
})

test('prompt library styles resolve to executable profiles', () => {
  for (const style of [
    'london_autumn_cinematic_illustration',
    'warm_children_watercolor_storybook',
    'japanese_cel_animation_twilight',
    'stylized_3d_explorer_character',
    'american_comic_graffiti_propaganda',
    'y2k_film_bedroom_snapshot',
  ]) {
    assert.equal(resolveHistoryVisualStyle(style).id, style)
  }
})

test('unknown styles remain explicit custom profiles', () => {
  const profile = resolveHistoryVisualStyle('unregistered-style')
  assert.equal(profile.id, 'custom:unregistered-style')
  assert.match(buildHistoryVisualStyleDirective(profile.id), /unregistered style/)
})

test('every profile is executable and avoids creator-name shortcuts', () => {
  const creatorShortcut = /Roger Deakins|Christopher Nolan|Quentin Tarantino|Wes Anderson|胡金铨|昆汀|诺兰/i
  for (const [id, profile] of Object.entries(HISTORY_VISUAL_STYLE_PROFILES)) {
    assert.equal(profile.id, id)
    assert.ok(profile.label)
    assert.ok(profile.capture)
    assert.ok(profile.composition)
    assert.ok(profile.palette)
    assert.ok(profile.lighting)
    assert.ok(profile.texture)
    assert.ok(profile.avoid.length >= 5)
    assert.doesNotMatch(buildHistoryVisualStyleDirective(id), creatorShortcut)
  }
})

test('style directives include concrete look and negative boundaries', () => {
  const directive = buildHistoryVisualStyleDirective('period_crime_35mm')
  assert.match(directive, /摄影机制/)
  assert.match(directive, /构图机制/)
  assert.match(directive, /色彩策略/)
  assert.match(directive, /硬性排除/)

  const look = buildHistoryLookInstruction('institutional_tableau')
  assert.match(look, /制度剧场/)
  assert.match(look, /look 必须写本镜头实际可见/)
})
