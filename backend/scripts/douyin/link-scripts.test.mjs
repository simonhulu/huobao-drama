import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeText, scoreEpisodeMatch, textCoverage } from './link-scripts.mjs'

test('normalizes Chinese punctuation and hashtags for matching', () => {
  assert.equal(normalizeText('明朝万历矿税，加速了大明的灭亡？ #历史'), '明朝万历矿税加速了大明的灭亡')
  assert.equal(textCoverage('训练有素的正规军', '当一万多人包围官署时，混在人群中的，是训练有素的正规军。'), 1)
})

test('description evidence wins over a shared series title', () => {
  const work = {
    title: '明朝万历矿税，加速了大明的灭亡？',
    description: '地方武官杀了皇帝派去的太监，万历皇帝气得吃不下饭，可当他要彻查的时候，却发现整个朝廷都在跟他作对。',
  }
  const correct = {
    id: 143,
    title: '万历矿税，加速了大明的灭亡？ 1',
    content: '地方武官杀了皇帝派去的太监，万历皇帝气得吃不下饭，可当他要彻查的时候，却发现整个朝廷都在跟他作对。',
    script_content: '',
  }
  const distractor = {
    id: 144,
    title: '万历矿税，加速了大明的灭亡？ 2',
    content: '万历派到云南的矿税使竟然是宫里管厨房的太监，发明了各种敛财手段。',
    script_content: '',
  }
  assert.ok(scoreEpisodeMatch(work, correct).score > scoreEpisodeMatch(work, distractor).score)
})
