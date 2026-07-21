import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoPrompt, fitGrokVideoDurationSec, parseStoryboardGrid } from './grok-video.js'

test('parseStoryboardGrid accepts the v8 one-image storyboard format', () => {
  const grid = parseStoryboardGrid(JSON.stringify({
    theme: 'funeral preparation',
    cells: [{ src: 'static/images/opening.png', description: 'closed casket' }],
  }))

  assert.equal(grid?.theme, 'funeral preparation')
  assert.equal(grid?.cells.length, 1)
})

test('parseStoryboardGrid keeps legacy two-cell compatibility and rejects malformed grids', () => {
  assert.equal(parseStoryboardGrid(JSON.stringify({ cells: [{}, {}] }))?.cells.length, 2)
  assert.equal(parseStoryboardGrid(JSON.stringify({ cells: [] })), null)
  assert.equal(parseStoryboardGrid('{bad json'), null)
})

test('fallback video prompt carries narrative, visible action, and zero-text constraints', () => {
  const prompt = buildVideoPrompt(
    'quiet funeral preparation',
    [{ description: 'two morticians smooth a cloth over a closed casket' }],
    'A ninety-five-year-old man died in Illinois.',
  )

  assert.match(prompt, /quiet funeral preparation/)
  assert.match(prompt, /closed casket/)
  assert.match(prompt, /不要出现任何文字、字幕、水印/)
})

test('Grok duration covers narration without exceeding the ten-second provider bound', () => {
  assert.equal(fitGrokVideoDurationSec(5.2, 6), 6)
  assert.equal(fitGrokVideoDurationSec(7.2, 6), 8)
  assert.throws(() => fitGrokVideoDurationSec(10.1), /split the storyboard first/)
})
