import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

import { buildHistoryComicManifest } from './build_history_comic_manifest.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(repoRoot, 'backend/package.json'))
const Database = require('better-sqlite3')

const EPISODE_ID = 100
const DRAMA_ID = 7
const REAL_PLAN_ID = 10

// 6 个 1s TTS 标题，与 6 个 beat 对齐；beat #2 跨 3 个标题以验证旁白切片
const CN_NUMERALS = ['一', '二', '三', '四', '五', '六']
const DEFAULT_TITLES = [0, 1, 2, 3, 4, 5].map((i) => ({
  text: `第${CN_NUMERALS[i]}句。`,
  time_begin: i * 1000,
  time_end: (i + 1) * 1000,
}))

const DEFAULT_BEATS = [
  { startMs: 0, endMs: 1000, panelKey: 'sb-201' },
  { startMs: 1000, endMs: 2000, panelKey: 'sb-202' },
  { startMs: 2000, endMs: 4500, panelKey: 'sb-203' },
  { startMs: 4500, endMs: 5000, panelKey: 'sb-204' },
  { startMs: 5000, endMs: 5600, panelKey: 'sb-205' },
  { startMs: 5600, endMs: 6000, panelKey: 'sb-206' },
]

const SCHEMA = `
  CREATE TABLE dramas (
    id INTEGER PRIMARY KEY,
    style TEXT,
    title TEXT
  );
  CREATE TABLE episodes (
    id INTEGER PRIMARY KEY,
    drama_id INTEGER,
    title TEXT,
    pre_tts_audio_url TEXT,
    pre_tts_titles_json TEXT
  );
  CREATE TABLE narrative_plans (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER,
    kind TEXT,
    timing_source TEXT,
    created_at TEXT
  );
  CREATE TABLE narrative_sequences (
    id INTEGER PRIMARY KEY,
    plan_id INTEGER,
    seq_key TEXT,
    seq_index INTEGER,
    start_ms INTEGER,
    end_ms INTEGER,
    design_json TEXT
  );
  CREATE TABLE narration_events (
    id INTEGER PRIMARY KEY,
    sequence_id INTEGER,
    event_key TEXT,
    event_index INTEGER,
    start_ms INTEGER,
    end_ms INTEGER,
    text TEXT
  );
  CREATE TABLE visual_beats (
    id INTEGER PRIMARY KEY,
    event_id INTEGER,
    beat_key TEXT,
    kind TEXT,
    start_ms INTEGER,
    end_ms INTEGER,
    description TEXT
  );
  CREATE TABLE storyboard_panels (
    id INTEGER PRIMARY KEY,
    beat_id INTEGER,
    event_id INTEGER,
    plan_id INTEGER,
    panel_key TEXT,
    gen_status TEXT,
    final_path TEXT,
    description TEXT
  );
  CREATE TABLE storyboards (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER,
    storyboard_number INTEGER,
    narration TEXT,
    duration INTEGER,
    grid_cells TEXT
  );
`

/**
 * 造一个临时 fixture DB。drama/episode 固定；plans / beats / titles 可覆盖。
 * withNarrative=false 时只落 plans，不落 sequence/event/beat/panel（用于 plan gate 用例）。
 */
function createFixtureDb(dir, options = {}) {
  const titles = options.titles ?? DEFAULT_TITLES
  const beats = options.beats ?? DEFAULT_BEATS
  const plans = options.plans ?? [
    // 更新的 pilot fallback plan 必须被忽略（镜像真实 episode 659 的 plan 26/27 布局）
    { id: REAL_PLAN_ID, kind: 'full', timing_source: 'tts-time-begin-end', created_at: '2026-07-27T00:00:00.000Z' },
    { id: 11, kind: 'pilot', timing_source: 'storyboard_grid_fallback', created_at: '2026-07-27T01:00:00.000Z' },
  ]
  const withNarrative = options.withNarrative ?? true

  const dbPath = path.join(dir, 'fixture.db')
  const db = new Database(dbPath)
  db.exec(SCHEMA)
  db.prepare('INSERT INTO dramas (id, style, title) VALUES (?, ?, ?)')
    .run(DRAMA_ID, 'cold-eastern-epic', '测试剧')
  db.prepare('INSERT INTO episodes (id, drama_id, title, pre_tts_audio_url, pre_tts_titles_json) VALUES (?, ?, ?, ?, ?)')
    .run(EPISODE_ID, DRAMA_ID, '测试集标题', 'static/audio/fake-pre-tts.mp3', JSON.stringify(titles))
  for (const plan of plans) {
    db.prepare('INSERT INTO narrative_plans (id, episode_id, kind, timing_source, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(plan.id, EPISODE_ID, plan.kind, plan.timing_source, plan.created_at)
  }
  if (withNarrative) {
    db.prepare('INSERT INTO narrative_sequences (id, plan_id, seq_key, seq_index, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(500, REAL_PLAN_ID, 'seq-1', 0, 0, 6000)
    beats.forEach((beat, index) => {
      const eventId = 800 + index
      const beatId = 900 + index
      db.prepare('INSERT INTO narration_events (id, sequence_id, event_key, event_index, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(eventId, 500, `ev-${index}`, index, beat.startMs, beat.endMs, `事件${index}`)
      db.prepare('INSERT INTO visual_beats (id, event_id, beat_key, kind, start_ms, end_ms, description) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(beatId, eventId, `beat-${index}`, 'cut', beat.startMs, beat.endMs, `beat 描述${index}`)
      db.prepare('INSERT INTO storyboard_panels (id, beat_id, event_id, plan_id, panel_key, gen_status, final_path, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(700 + index, beatId, eventId, REAL_PLAN_ID, beat.panelKey,
          beat.genStatus ?? 'completed', beat.finalPath ?? `static/images/${beat.panelKey}.png`, `panel 描述${index}`)
    })
  }
  db.close()
  return dbPath
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'history-comic-manifest-'))
}

/** ffprobe / 文件存在性全部注入，测试不碰真实 DB 与真实文件。 */
function runBuilder(dbPath, overrides = {}) {
  return buildHistoryComicManifest({
    dbPath,
    episodeId: EPISODE_ID,
    tailSec: 1.5,
    repoRoot,
    mediaDurationSec: () => 6,
    fsExists: () => true,
    ...overrides,
  })
}

test('happy path: manifest matches contract exactly', () => {
  const dir = makeTempDir()
  const dbPath = createFixtureDb(dir)

  const { manifest, planId, narrationEndSec } = runBuilder(dbPath)

  assert.equal(planId, REAL_PLAN_ID)
  assert.equal(narrationEndSec, 6)
  assert.deepEqual(Object.keys(manifest), [
    'contract', 'factory', 'episodeId', 'dramaId', 'title', 'stylePreset',
    'model', 'targetDurationSec', 'narrationEndSec', 'fps', 'panels',
  ])
  assert.equal(manifest.contract, 'history-comic-five-manifest-v1')
  assert.equal(manifest.factory, 'history-comic-five-v1')
  assert.equal(manifest.episodeId, EPISODE_ID)
  assert.equal(manifest.dramaId, DRAMA_ID)
  assert.equal(manifest.title, '测试剧') // dramas.title 优先于 episode.title
  assert.equal(manifest.stylePreset, 'cold-eastern-epic')
  assert.equal(manifest.model, 'grid-narrative-panel')
  assert.equal(manifest.targetDurationSec, 7.5) // 6s 旁白 + 1.5s 尾部
  assert.equal(manifest.narrationEndSec, 6) // runner props 组合依赖该字段
  assert.equal(manifest.fps, 30)

  assert.equal(manifest.panels.length, 6)
  assert.deepEqual(Object.keys(manifest.panels[0]), [
    'key', 'storyboardId', 'beatId', 'startSec', 'endSec', 'narrationText',
    'ttsTitleStart', 'ttsTitleEnd', 'src', 'focusX', 'focusY',
  ])
  assert.deepEqual(manifest.panels, [
    { key: 'sb-201', storyboardId: 201, beatId: 900, startSec: 0, endSec: 1, narrationText: '第一句。', ttsTitleStart: 0, ttsTitleEnd: 0, src: 'static/images/sb-201.png', focusX: 50, focusY: 50 },
    { key: 'sb-202', storyboardId: 202, beatId: 901, startSec: 1, endSec: 2, narrationText: '第二句。', ttsTitleStart: 1, ttsTitleEnd: 1, src: 'static/images/sb-202.png', focusX: 50, focusY: 50 },
    // [2000, 4500) 与标题 2/3/4 相交：验证多标题拼接与 ttsTitle 区间
    { key: 'sb-203', storyboardId: 203, beatId: 902, startSec: 2, endSec: 4.5, narrationText: '第三句。第四句。第五句。', ttsTitleStart: 2, ttsTitleEnd: 4, src: 'static/images/sb-203.png', focusX: 50, focusY: 50 },
    { key: 'sb-204', storyboardId: 204, beatId: 903, startSec: 4.5, endSec: 5, narrationText: '第五句。', ttsTitleStart: 4, ttsTitleEnd: 4, src: 'static/images/sb-204.png', focusX: 50, focusY: 50 },
    { key: 'sb-205', storyboardId: 205, beatId: 904, startSec: 5, endSec: 5.6, narrationText: '第六句。', ttsTitleStart: 5, ttsTitleEnd: 5, src: 'static/images/sb-205.png', focusX: 50, focusY: 50 },
    { key: 'sb-206', storyboardId: 206, beatId: 905, startSec: 5.6, endSec: 6, narrationText: '第六句。', ttsTitleStart: 5, ttsTitleEnd: 5, src: 'static/images/sb-206.png', focusX: 50, focusY: 50 },
  ])
})

test('fallback plan is rejected as UI placeholder', () => {
  const dir = makeTempDir()
  const dbPath = createFixtureDb(dir, {
    plans: [{ id: 12, kind: 'full', timing_source: 'storyboard_grid_fallback', created_at: '2026-07-27T00:00:00.000Z' }],
    withNarrative: false,
  })

  assert.throws(() => runBuilder(dbPath), /re-run narrative-hierarchy\/import/)
})

test('missing narrative plan is rejected', () => {
  const dir = makeTempDir()
  const dbPath = createFixtureDb(dir, { plans: [], withNarrative: false })

  assert.throws(() => runBuilder(dbPath), /re-run narrative-hierarchy\/import/)
})

test('pending panel fails naming its panel_key and storyboard id', () => {
  const dir = makeTempDir()
  const beats = DEFAULT_BEATS.map((beat, index) => index === 3 ? { ...beat, genStatus: 'pending' } : beat)
  const dbPath = createFixtureDb(dir, { beats })

  assert.throws(() => runBuilder(dbPath), /sb-204\(storyboard 204\).*gen_status=pending/)
})

test('beat window outside narration stream fails', () => {
  const dir = makeTempDir()
  const beats = DEFAULT_BEATS.map((beat, index) => index === 5 ? { ...beat, startMs: 7000, endMs: 8000 } : beat)
  const dbPath = createFixtureDb(dir, { beats })

  assert.throws(() => runBuilder(dbPath), /outside narration stream.*sb-206/)
})

test('coverage ratio outside [0.60, 1.05] fails', () => {
  const dir = makeTempDir()
  const dbPath = createFixtureDb(dir)

  // 6s 标题跨度 / 20s 音频 = 0.30 < 0.60
  assert.throws(() => runBuilder(dbPath, { mediaDurationSec: () => 20 }), /coverage=0\.3000/)
  // 6s 标题跨度 / 5s 音频 = 1.20 > 1.05
  assert.throws(() => runBuilder(dbPath, { mediaDurationSec: () => 5 }), /coverage=1\.2000/)
})

test('beat window overlap beyond 500ms tolerance fails', () => {
  const dir = makeTempDir()
  const beats = DEFAULT_BEATS.map((beat, index) => {
    if (index === 0) return { ...beat, endMs: 2000 }
    if (index === 1) return { ...beat, startMs: 1400, endMs: 2400 }
    return beat
  })
  const dbPath = createFixtureDb(dir, { beats })

  // beat1 起始 1400ms < beat0 结束 2000ms - 500ms 容差
  assert.throws(() => runBuilder(dbPath), /重叠\/乱序.*sb-201.*2000ms.*sb-202.*1400ms/)
})

test('unparseable panel_key fails', () => {
  const dir = makeTempDir()
  const beats = DEFAULT_BEATS.map((beat, index) => index === 2 ? { ...beat, panelKey: 'panel-x' } : beat)
  const dbPath = createFixtureDb(dir, { beats })

  assert.throws(() => runBuilder(dbPath), /panel_key 无法解析 storyboard id.*"panel-x"/)
})

test('panel image missing on disk fails naming the panel', () => {
  const dir = makeTempDir()
  const dbPath = createFixtureDb(dir)
  const fsExists = (filePath) => !filePath.includes('sb-203')

  assert.throws(() => runBuilder(dbPath, { fsExists }), /panel 素材未就绪.*sb-203\(storyboard 203\)/)
})

test('tail-sec beyond 2.0 is rejected', () => {
  const dir = makeTempDir()
  const dbPath = createFixtureDb(dir)

  assert.throws(() => runBuilder(dbPath, { tailSec: 2.5 }), /tail-sec 必须在 \[0, 2\]/)
})
