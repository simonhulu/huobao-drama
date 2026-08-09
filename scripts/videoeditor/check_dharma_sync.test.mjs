import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import test from 'node:test'

import { buildTimedTextProps } from '../../.codex/skills/remotion-dharma-factory/scripts/dharma_comic_pipeline.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(repoRoot, 'backend/package.json'))
const Database = require('better-sqlite3')
const checkerPath = path.join(repoRoot, 'scripts/videoeditor/check_dharma_sync.mjs')

function makeDb(dir) {
  const dbPath = path.join(dir, 'dharma-sync-test.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      pre_tts_audio_url TEXT,
      pre_tts_titles_json TEXT,
      bgm_audio_url TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY,
      episode_id INTEGER,
      storyboard_number INTEGER,
      narration TEXT,
      description TEXT,
      grid_cells TEXT
    );
  `)
  db.prepare(`
    INSERT INTO episodes (id, pre_tts_audio_url, pre_tts_titles_json, bgm_audio_url)
    VALUES (?, ?, ?, ?)
  `).run(
    900001,
    'static/audio/test-pre-tts.mp3',
    JSON.stringify([
      { text: '第一句', time_begin: 0, time_end: 1000 },
      { text: '第二句', time_begin: 1000, time_end: 2000 },
    ]),
    'static/music/test-bgm.mp3',
  )
  db.close()
  return dbPath
}

function writeTruncatedProgressiveProps(dir) {
  const propsPath = path.join(dir, 'truncated-progressive-five.json')
  fs.writeFileSync(propsPath, JSON.stringify({
    variant: 'progressive_five',
    durationInFrames: 30,
    audio: 'static/audio/test-pre-tts.mp3',
    narrationEndFrame: 30,
    bgm: { src: 'static/music/test-bgm.mp3' },
    segments: [
      { startFrame: 0, durationInFrames: 30 },
    ],
    narrationWindows: [
      { startFrame: 0, endFrame: 30 },
    ],
    subtitles: [
      // 单句无下一句：驻留 +0.35s（ink-read-v2 display 窗口，checker 独立重算）。
      { ttsTitleIndex: 0, text: '第一句', startSec: 0, endSec: 1, displayStartSec: 0, displayEndSec: 1.35 },
    ],
  }))
  return propsPath
}

test('strict full production fails when authoritative TTS titles exceed props duration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-sync-'))
  const dbPath = makeDb(dir)
  const propsPath = writeTruncatedProgressiveProps(dir)

  const result = spawnSync(process.execPath, [
    checkerPath,
    '900001',
    propsPath,
    '--fps=30',
  ], {
    cwd: repoRoot,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /TTS|主时间轴|durationInFrames|旁白/)
  assert.doesNotMatch(result.stderr, /partial props/)
})

test('explicit partial diagnostic mode allows scoped progressive-five props', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-sync-'))
  const dbPath = makeDb(dir)
  const propsPath = writeTruncatedProgressiveProps(dir)

  const result = spawnSync(process.execPath, [
    checkerPath,
    '900001',
    propsPath,
    '--fps=30',
    '--allow-partial',
  ], {
    cwd: repoRoot,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /OK:/)
})

test('strict production can verify against the frozen TTS titles artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-sync-frozen-'))
  const dbPath = makeDb(dir)
  const frozenTitlesPath = path.join(dir, 'frozen-titles.json')
  fs.writeFileSync(frozenTitlesPath, JSON.stringify([
    { text: '第一句', time_begin: 0, time_end: 1000 },
    { text: '第二句', time_begin: 1000, time_end: 2000 },
  ]))
  const db = new Database(dbPath)
  db.prepare('UPDATE episodes SET pre_tts_titles_json = ? WHERE id = ?').run(JSON.stringify([
    { text: '已被修改', time_begin: 0, time_end: 3000 },
  ]), 900001)
  db.close()
  const propsPath = path.join(dir, 'full-progressive-five.json')
  fs.writeFileSync(propsPath, JSON.stringify({
    variant: 'progressive_five',
    durationInFrames: 60,
    audio: 'static/audio/test-pre-tts.mp3',
    narrationEndFrame: 60,
    bgm: { src: 'static/music/test-bgm.mp3' },
    segments: [{ startFrame: 0, durationInFrames: 60 }],
    narrationWindows: [
      { startFrame: 0, endFrame: 30 },
      { startFrame: 30, endFrame: 60 },
    ],
    subtitles: [
      // ink-read-v2 display 窗口：句间间隙 0 < 12 帧驻留减半，退场与下一句入场
      // 重叠封顶 3 帧 → 第一句 min(1+0.175, 1+0.1)=1.1；末句驻留 +0.35s。
      { ttsTitleIndex: 0, text: '第一句', startSec: 0, endSec: 1, displayStartSec: 0, displayEndSec: 1.1 },
      { ttsTitleIndex: 1, text: '第二句', startSec: 1, endSec: 2, displayStartSec: 1, displayEndSec: 2.35 },
    ],
  }))

  const result = spawnSync(process.execPath, [
    checkerPath,
    '900001',
    propsPath,
    '--fps=30',
    `--titles=${frozenTitlesPath}`,
  ], {
    cwd: repoRoot,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /OK:/)
})

test('timed text emitted by the factory passes the independent frozen-TTS checker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-sync-generated-props-'))
  const dbPath = makeDb(dir)
  const titles = [
    { text: '第一句', time_begin: 0, time_end: 1000 },
    { text: '第二句', time_begin: 1000, time_end: 2000 },
  ]
  const timedText = buildTimedTextProps({
    panels: [{
      key: 'p_002',
      ttsTitleStart: 1,
      ttsTitleEnd: 1,
      quote: { text: '第二句' },
    }],
  }, titles, 30)
  const propsPath = path.join(dir, 'generated-timed-text.json')
  fs.writeFileSync(propsPath, JSON.stringify({
    variant: 'progressive_five',
    durationInFrames: 120,
    audio: 'static/audio/test-pre-tts.mp3',
    audioStartFrame: 0,
    bgm: { src: 'static/music/test-bgm.mp3' },
    segments: [{ startFrame: 0, durationInFrames: 120 }],
    ...timedText,
  }))

  const result = spawnSync(process.execPath, [checkerPath, '900001', propsPath, '--fps=30'], {
    cwd: repoRoot,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(timedText.subtitles.every((subtitle) => Number.isInteger(subtitle.ttsTitleIndex)), true)
  assert.deepEqual(timedText.quotes.map((quote) => ({
    panelKey: quote.panelKey,
    ttsTitleStart: quote.ttsTitleStart,
    ttsTitleEnd: quote.ttsTitleEnd,
  })), [{ panelKey: 'p_002', ttsTitleStart: 1, ttsTitleEnd: 1 }])
})

test('strict production rejects subtitles shifted outside their authoritative TTS title', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-sync-shifted-subtitle-'))
  const dbPath = makeDb(dir)
  const propsPath = path.join(dir, 'shifted-subtitle.json')
  fs.writeFileSync(propsPath, JSON.stringify({
    variant: 'progressive_five',
    durationInFrames: 60,
    audio: 'static/audio/test-pre-tts.mp3',
    narrationEndFrame: 60,
    bgm: { src: 'static/music/test-bgm.mp3' },
    segments: [{ startFrame: 0, durationInFrames: 60 }],
    narrationWindows: [
      { startFrame: 0, endFrame: 30 },
      { startFrame: 30, endFrame: 60 },
    ],
    subtitles: [
      { ttsTitleIndex: 0, text: '第一句', startSec: 1, endSec: 2 },
      { ttsTitleIndex: 1, text: '第二句', startSec: 1, endSec: 2 },
    ],
  }))

  const result = spawnSync(process.execPath, [checkerPath, '900001', propsPath, '--fps=30'], {
    cwd: repoRoot,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /字幕.*TTS|TTS.*字幕/u)
})

test('strict production rejects a duplicate quote anchored to an earlier TTS occurrence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dharma-sync-shifted-quote-'))
  const dbPath = makeDb(dir)
  const duplicateTitles = [
    { text: '重复金句', time_begin: 0, time_end: 1000 },
    { text: '重复金句', time_begin: 1000, time_end: 2000 },
  ]
  const db = new Database(dbPath)
  db.prepare('UPDATE episodes SET pre_tts_titles_json = ? WHERE id = ?')
    .run(JSON.stringify(duplicateTitles), 900001)
  db.close()
  const propsPath = path.join(dir, 'shifted-quote.json')
  fs.writeFileSync(propsPath, JSON.stringify({
    variant: 'progressive_five',
    durationInFrames: 60,
    audio: 'static/audio/test-pre-tts.mp3',
    narrationEndFrame: 60,
    bgm: { src: 'static/music/test-bgm.mp3' },
    segments: [{ startFrame: 0, durationInFrames: 60 }],
    narrationWindows: [
      { startFrame: 0, endFrame: 30 },
      { startFrame: 30, endFrame: 60 },
    ],
    subtitles: [
      { ttsTitleIndex: 0, text: '重复金句', startSec: 0, endSec: 1 },
      { ttsTitleIndex: 1, text: '重复金句', startSec: 1, endSec: 2 },
    ],
    quotes: [{
      panelKey: 'p_002',
      ttsTitleStart: 1,
      ttsTitleEnd: 1,
      text: '重复金句',
      startFrame: 0,
      durationInFrames: 90,
    }],
  }))

  const result = spawnSync(process.execPath, [checkerPath, '900001', propsPath, '--fps=30'], {
    cwd: repoRoot,
    env: { ...process.env, DB_PATH: dbPath },
    encoding: 'utf8',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /金句.*TTS|TTS.*金句/u)
})
