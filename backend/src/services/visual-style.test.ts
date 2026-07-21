import test from 'node:test'
import assert from 'node:assert/strict'
import { styleToPromptPhrase, applyVisualStyle, recommendedStyleForGenre } from './visual-style.js'

test('styleToPromptPhrase maps known styles', () => {
  assert.match(styleToPromptPhrase('ghibli'), /Studio Ghibli/)
  assert.match(styleToPromptPhrase('anime'), /anime style/)
  assert.match(styleToPromptPhrase('cinematic'), /cinematic film still/)
})

test('styleToPromptPhrase falls back for unknown styles', () => {
  assert.equal(styleToPromptPhrase('vaporwave'), 'vaporwave style')
})

test('styleToPromptPhrase handles empty values', () => {
  assert.equal(styleToPromptPhrase(''), '')
  assert.equal(styleToPromptPhrase(null), '')
  assert.equal(styleToPromptPhrase(undefined), '')
})

test('applyVisualStyle prepends style phrase', () => {
  const result = applyVisualStyle('a cat in a garden', 'watercolor')
  assert.match(result, /^watercolor painting/)
  assert.match(result, /a cat in a garden/)
})

test('applyVisualStyle does not duplicate style phrase', () => {
  const phrase = styleToPromptPhrase('comic')
  const result = applyVisualStyle(`${phrase}, a hero pose`, 'comic')
  assert.equal(result, `${phrase}, a hero pose`)
})

test('applyVisualStyle returns base prompt when style is empty', () => {
  assert.equal(applyVisualStyle('base prompt', ''), 'base prompt')
})

test('styleToPromptPhrase supports generic style', () => {
  assert.match(styleToPromptPhrase('generic'), /cinematic film still/)
})

test('styleToPromptPhrase maps new historical and cinematic styles', () => {
  assert.match(styleToPromptPhrase('historical_epic'), /historical epic/)
  assert.match(styleToPromptPhrase('chinese_ink'), /Chinese ink wash/)
  assert.match(styleToPromptPhrase('wuxia'), /wuxia cinematic/)
  assert.match(styleToPromptPhrase('villeneuve'), /Denis Villeneuve/)
  assert.match(styleToPromptPhrase('documentary'), /documentary photography/)
  assert.match(styleToPromptPhrase('renaissance'), /Renaissance oil painting/)
  assert.match(styleToPromptPhrase('historical_systems'), /现实系统史诗/)
  assert.match(styleToPromptPhrase('period_crime_35mm'), /复古犯罪凝视/)
  assert.match(styleToPromptPhrase('institutional_tableau'), /制度剧场/)
})

test('recommendedStyleForGenre maps themes to recommended visual styles', () => {
  assert.equal(recommendedStyleForGenre('generic'), 'cinematic')
  assert.equal(recommendedStyleForGenre('history'), 'historical_systems')
  assert.equal(recommendedStyleForGenre('scifi'), 'cyberpunk')
  assert.equal(recommendedStyleForGenre('mythology'), 'eastern_fantasy')
  assert.equal(recommendedStyleForGenre('space'), 'cinematic')
  assert.equal(recommendedStyleForGenre('deepsea'), 'documentary')
  assert.equal(recommendedStyleForGenre('ancient'), 'chinese_gongbi')
  assert.equal(recommendedStyleForGenre('wasteland'), 'cinematic')
  assert.equal(recommendedStyleForGenre(''), 'cinematic')
  assert.equal(recommendedStyleForGenre(null), 'cinematic')
})
