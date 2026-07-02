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

test('recommendedStyleForGenre maps themes to recommended visual styles', () => {
  assert.equal(recommendedStyleForGenre('generic'), 'generic')
  assert.equal(recommendedStyleForGenre('history'), 'realistic')
  assert.equal(recommendedStyleForGenre('scifi'), 'cinematic')
  assert.equal(recommendedStyleForGenre('mythology'), 'cinematic')
  assert.equal(recommendedStyleForGenre('space'), 'cinematic')
  assert.equal(recommendedStyleForGenre('deepsea'), 'cinematic')
  assert.equal(recommendedStyleForGenre('ancient'), 'realistic')
  assert.equal(recommendedStyleForGenre('wasteland'), 'cinematic')
  assert.equal(recommendedStyleForGenre(''), 'generic')
  assert.equal(recommendedStyleForGenre(null), 'generic')
})
