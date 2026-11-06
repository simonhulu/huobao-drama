import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { resolveNbaCoverSubjects, type NbaCoverSubjectInput } from './nba-cover-subject.js'

async function directory(t: { after: (callback: () => Promise<void>) => void }) {
  const name = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-cover-subject-'))
  t.after(() => fs.rm(name, { recursive: true, force: true }))
  return name
}
function input(directory: string, extra: Partial<NbaCoverSubjectInput> = {}): NbaCoverSubjectInput {
  return { directory, signal: new AbortController().signal,
    headline: '库里34分，格林被驱逐后勇士逆转太阳',
    article: { title: '勇士险胜太阳，格林被驱逐成为转折点', body: '勇士的德雷蒙德·格林被驱逐。太阳的杰伦·格林得到11分，库里得到34分。' },
    home: { abbreviation: 'GS', players: [{ id: '3975', name: 'Stephen Curry' }, { id: '6589', name: 'Draymond Green' }] },
    away: { abbreviation: 'PHX', players: [{ id: '3136193', name: 'Devin Booker' }, { id: '4437244', name: 'Jalen Green' }] },
    ...extra }
}
const selected = { homePlayerId: '6589', awayPlayerId: '3136193', reason: '报道侧重勇士格林被驱逐及布克离场，使用事件主角。' }

test('Chinese event-led reporting can select a lower-scoring subject and distinguish both Greens by roster', async t => {
  const value = input(await directory(t))
  const result = await resolveNbaCoverSubjects(value, { model: async (messages, signal) => {
    assert.ok(!signal.aborted)
    const context = JSON.parse(messages[1].content)
    assert.equal(context.headline, value.headline)
    assert.equal(context.article.body, value.article!.body)
    assert.deepEqual(context.home, value.home)
    assert.deepEqual(context.away, value.away)
    return JSON.stringify(selected)
  } })
  assert.deepEqual(result, { ...selected, method: 'news-subject-v1' })
})

test('unknown IDs or an opponent ID assigned to the wrong side never become a subject selection', async t => {
  for (const selection of [
    { ...selected, homePlayerId: '4437244' }, { ...selected, awayPlayerId: '6589' }, { ...selected, homePlayerId: '9999999' },
  ]) {
    const result = await resolveNbaCoverSubjects(input(await directory(t)), { model: async () => JSON.stringify(selection) })
    assert.equal(result, undefined)
  }
})

test('a verified selection is reused without model work and changed reporting or roster invalidates its identity', async t => {
  const dir = await directory(t), value = input(dir)
  let calls = 0
  const model = async () => { calls++; return JSON.stringify(selected) }
  const first = await resolveNbaCoverSubjects(value, { model })
  const cached = await resolveNbaCoverSubjects(value, { model: async () => { throw Error('cache should avoid the model') } })
  assert.deepEqual(cached, first); assert.equal(calls, 1)
  await resolveNbaCoverSubjects({ ...value, article: { ...value.article!, body: value.article!.body + '赛后采访。' } }, { model })
  await resolveNbaCoverSubjects({ ...value, headline: '格林离场后，勇士发生了什么？' }, { model })
  await resolveNbaCoverSubjects({ ...value, home: { ...value.home, players: [...value.home.players, { id: '4709138', name: 'Brandin Podziemski' }] } }, { model })
  assert.equal(calls, 4)
})

test('a tampered cached selection is rejected even when the replacement belongs to the correct team', async t => {
  const dir = await directory(t), value = input(dir)
  await resolveNbaCoverSubjects(value, { model: async () => JSON.stringify(selected) })
  const file = path.join(dir, (await fs.readdir(dir)).find(name => name.startsWith('cover-subject-'))!)
  const cached = JSON.parse(await fs.readFile(file, 'utf8'))
  cached.selection.homePlayerId = '3975'
  await fs.writeFile(file, JSON.stringify(cached))
  let calls = 0
  const result = await resolveNbaCoverSubjects(value, { model: async () => { calls++; return JSON.stringify(selected) } })
  assert.equal(calls, 1); assert.equal(result?.homePlayerId, '6589')
})

test('English reporting and a single relevant side remain supported while an absent side falls back independently', async t => {
  const result = await resolveNbaCoverSubjects(input(await directory(t), {
    headline: 'Draymond Green ejected before Golden State rallies', article: { title: 'Green ejection changes Warriors game', body: 'Draymond Green was ejected.' },
  }), { model: async () => JSON.stringify({ homePlayerId: '6589', awayPlayerId: null, reason: 'The report centers on Draymond Green.' }) })
  assert.equal(result?.homePlayerId, '6589'); assert.equal(result?.awayPlayerId, undefined)
})

test('model errors and malformed or empty responses return the existing selection fallback without caching failures', async t => {
  for (const response of [new Error('temporary failure'), 'not JSON', '[]', '{}', JSON.stringify({ homePlayerId: null, awayPlayerId: null, reason: 'No named subject.' }),
    JSON.stringify({ ...selected, homePlayerId: 6589 }), JSON.stringify({ ...selected, reason: '' })]) {
    const dir = await directory(t)
    const result = await resolveNbaCoverSubjects(input(dir), { model: async () => {
      if (response instanceof Error) throw response
      return response
    } })
    assert.equal(result, undefined)
    assert.deepEqual(await fs.readdir(dir), [])
  }
})

test('pre-cancellation and cancellation during model selection propagate and cannot save a subject', async t => {
  const reason = new Error('stop this cover')
  const before = new AbortController(); before.abort(reason)
  await assert.rejects(resolveNbaCoverSubjects(input(await directory(t), { signal: before.signal }), {
    model: async () => { throw Error('must not call model') },
  }), error => error === reason)
  const during = new AbortController(), dir = await directory(t)
  await assert.rejects(resolveNbaCoverSubjects(input(dir, { signal: during.signal }), { model: async () => {
    during.abort(reason)
    return JSON.stringify(selected)
  } }), error => error === reason)
  assert.deepEqual(await fs.readdir(dir), [])
})
