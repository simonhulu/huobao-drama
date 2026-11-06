import test from 'node:test'
import assert from 'node:assert/strict'
import { nbaSourceVideoId, sameNbaFootage } from './nba-content-identity.js'
import type { NbaArticle, NbaGame } from './nba-types.js'

const article = (youtubeUrl?: string) => ({ youtubeUrl } as NbaArticle)
const game = { id: 'game-one', verified: true } as NbaGame

test('source identity ignores article language, URL spelling, and narration', () => {
  assert.equal(sameNbaFootage({ article: article('https://youtu.be/vDdPLHaKK4k?t=20') },
    { article: { ...article('https://www.youtube.com/watch?v=vDdPLHaKK4k&list=test'), language: 'zh' } }), true)
  assert.equal(nbaSourceVideoId({ article: article('https://www.youtube.com/watch?v=rhZ6oVlNZHs'),
    media: { sourceUrl: 'https://www.youtube.com/watch?v=vDdPLHaKK4k' } as any }), 'rhZ6oVlNZHs')
})

test('separate same-game interviews remain distinct while legacy shared-game reports deduplicate', () => {
  assert.equal(sameNbaFootage({ game, article: article('https://www.youtube.com/watch?v=vDdPLHaKK4k') },
    { game, article: article('https://www.youtube.com/watch?v=rhZ6oVlNZHs') }), false)
  assert.equal(sameNbaFootage({ game, article: article() }, { game, article: article() }), true)
  assert.equal(sameNbaFootage({ article: article() }, { article: article() }), false)
})
