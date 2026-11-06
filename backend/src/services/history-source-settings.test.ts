import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHistorySourceSettings, writeHistorySourceSettings } from './history-source-settings.js'
import { createHistorySourceSettingsRoute } from '../routes/history-source-settings.js'
import { DEFAULT_HISTORY_YOUTUBE_URL, parseHistoryYoutubeUrl } from './history-source-youtube-url.js'
const youtubeChannels = [parseHistoryYoutubeUrl(DEFAULT_HISTORY_YOUTUBE_URL).url]

test('saved keywords persist additions, edits and deletions in order without combining terms', () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-keywords-'))
  const file = join(directory, 'settings.json')
  assert.deepEqual(readHistorySourceSettings(file), { keywords: ['历史'], youtubeChannels })
  writeHistorySourceSettings({ keywords: [' 历史 ', ' 明朝 '] }, file)
  assert.deepEqual(readHistorySourceSettings(file), { keywords: ['历史', '明朝'], youtubeChannels })
  writeHistorySourceSettings({ keywords: ['历史', '清朝'] }, file)
  writeHistorySourceSettings({ keywords: ['清朝'] }, file)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { keywords: ['清朝'], youtubeChannels })
  assert.deepEqual(readdirSync(directory), ['settings.json'], 'atomic replacement leaves no temporary files')
})

test('invalid keyword updates preserve the saved configuration', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'history-keyword-invalid-')), 'settings.json')
  writeHistorySourceSettings({ keywords: ['历史', '明朝'] }, file)
  for (const keywords of [[], [' '], ['历史', ' 历史 '], ['明\n朝'], ['x'.repeat(81)], Array.from({ length: 31 }, (_, i) => String(i))]) {
    assert.throws(() => writeHistorySourceSettings({ keywords }, file))
    assert.deepEqual(readHistorySourceSettings(file).keywords, ['历史', '明朝'])
  }
  writeFileSync(file, '{broken')
  assert.throws(() => readHistorySourceSettings(file), /读取失败/, 'corrupt settings must not silently start the default search')
})

test('settings API persists changes and rejects foreign origins and malformed input', async () => {
  const previous = process.env.HISTORY_SOURCE_SETTINGS_FILE
  process.env.HISTORY_SOURCE_SETTINGS_FILE = join(mkdtempSync(join(tmpdir(), 'history-keyword-api-')), 'settings.json')
  try {
    const route = createHistorySourceSettingsRoute()
    const put = (body: unknown, origin = 'http://localhost:3013') => route.request('/', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
    })
    assert.deepEqual((await (await route.request('/')).json()).data, { keywords: ['历史'], youtubeChannels })
    assert.equal((await put({ keywords: ['历史', '明朝'] })).status, 200)
    assert.deepEqual((await (await route.request('/')).json()).data, { keywords: ['历史', '明朝'], youtubeChannels })
    const channels = ['https://www.youtube.com/@history/videos', 'https://www.youtube.com/user/HistoryChannel/videos']
    assert.equal((await put({ youtubeChannels: channels })).status, 200)
    assert.deepEqual((await (await route.request('/')).json()).data, { keywords: ['历史', '明朝'], youtubeChannels: channels })
    assert.equal((await put({ youtubeChannels })).status, 200)
    assert.equal((await put({ keywords: ['清朝'] }, 'https://example.com')).status, 403)
    assert.equal((await put({ keywords: [] })).status, 400)
    assert.equal((await route.request('/', { method: 'PUT', body: '{}' })).status, 400)
    assert.equal((await route.request('/', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
    assert.deepEqual((await (await route.request('/')).json()).data, { keywords: ['历史', '明朝'], youtubeChannels })
  } finally {
    if (previous === undefined) delete process.env.HISTORY_SOURCE_SETTINGS_FILE
    else process.env.HISTORY_SOURCE_SETTINGS_FILE = previous
  }
})

test('legacy keyword-only files gain a default channel without being rewritten on read', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'history-settings-legacy-')), 'settings.json')
  const original = '{"keywords":["明朝","清朝"]}'
  writeFileSync(file, original)
  assert.deepEqual(readHistorySourceSettings(file), { keywords: ['明朝', '清朝'], youtubeChannels })
  assert.equal(readFileSync(file, 'utf8'), original)
})

test('channel additions and deletions persist in order while independent keyword updates preserve them', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'history-channel-settings-')), 'settings.json')
  writeHistorySourceSettings({ keywords: ['明朝', '清朝'] }, file)
  const channels = ['https://www.youtube.com/@history/videos', 'https://www.youtube.com/channel/UCTAxxtcq1RRRjXM5yWsCsYg/videos']
  const result = writeHistorySourceSettings({ youtubeChannels: ['https://youtube.com/@history?si=track', channels[1]] }, file)
  assert.deepEqual(result, { keywords: ['明朝', '清朝'], youtubeChannels: channels })
  writeHistorySourceSettings({ keywords: ['秦汉'] }, file)
  assert.deepEqual(readHistorySourceSettings(file), { keywords: ['秦汉'], youtubeChannels: channels })
  writeHistorySourceSettings({ youtubeChannels: [channels[1]] }, file)
  assert.deepEqual(readHistorySourceSettings(file), { keywords: ['秦汉'], youtubeChannels: [channels[1]] })
})

test('channel validation rejects video links, duplicate channel aliases and malformed changes without losing settings', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'history-channel-validation-')), 'settings.json')
  const saved = writeHistorySourceSettings({ youtubeChannels: ['https://www.youtube.com/@history'] }, file)
  for (const channels of [[], [' '], ['https://www.youtube.com/watch?v=VprFAzjTTuM'],
    ['https://youtu.be/VprFAzjTTuM'], ['https://example.com/@history'], ['https://youtube.com/@history\n/videos'],
    ['https://youtube.com/@history', 'https://m.youtube.com/@HISTORY/videos?si=track'],
    [DEFAULT_HISTORY_YOUTUBE_URL, encodeURI(DEFAULT_HISTORY_YOUTUBE_URL)],
    Array.from({ length: 31 }, (_, i) => `https://youtube.com/@history${i}`)]) {
    assert.throws(() => writeHistorySourceSettings({ youtubeChannels: channels }, file))
    assert.deepEqual(readHistorySourceSettings(file), saved)
  }
  assert.throws(() => writeHistorySourceSettings({}, file))
  assert.throws(() => writeHistorySourceSettings({ unexpected: true }, file))
})
