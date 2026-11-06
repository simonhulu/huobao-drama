import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  loadEpisodeFromDb,
  loadMaoxuanVideoFromDb,
  parseEpisodeReference,
  parseMaoxuanVideoReference,
  resolveEpisodeId,
} from './publish-episode-reference.mjs'

const requireFromBackend = createRequire(new URL('../package.json', import.meta.url))
const Database = requireFromBackend('better-sqlite3')

test('history script delivery resolves saved media without inventing an episode and rejects stale or missing assets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'history-delivery-publisher-'))
  const dbPath = path.join(dir, 'delivery.db')
  const db = new Database(dbPath)
  try {
    db.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY, rewritten_script TEXT, deleted_at TEXT);
      CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY, title TEXT, description TEXT,
        video_path TEXT, script_sha256 TEXT, cover_script_sha256 TEXT, covers_json TEXT, cover_status TEXT);`)
    const script = ' 北京打工人的一天\n'
    const hash = createHash('sha256').update(script).digest('hex')
    const covers = { '3:4': 'static/portrait.png', '4:3': 'static/share.png', '16:9': 'static/wide.png' }
    mkdirSync(path.join(dir, 'data/static'), { recursive: true })
    for (const file of ['static/video.mp4', ...Object.values(covers)]) writeFileSync(path.join(dir, 'data', file), 'fixture')
    db.prepare('INSERT INTO history_script_sources VALUES (10, ?, NULL)').run(script)
    db.prepare('INSERT INTO history_script_deliveries VALUES (10, ?, ?, ?, ?, ?, ?, ?)')
      .run('北京打工人', '既有简介', 'static/video.mp4', hash, hash, JSON.stringify(covers), 'completed')
    const reference = 'http://localhost:3013/history-scripts?script=10'
    const options = { dbPath, projectRoot: dir }
    assert.deepEqual(parseEpisodeReference(reference), { kind: 'history_script', scriptId: 10 })
    assert.throws(() => resolveEpisodeId(reference, options), /not episode ids/)
    const result = loadEpisodeFromDb(reference, options)
    assert.equal(result.history_source_id, 10)
    assert.equal(result.episode_id, undefined)
    assert.equal(result.description, '既有简介')
    assert.equal(result.baijiahao_title, '北京打工人')
    assert.equal(result.cover_16x9_src, covers['16:9'])
    db.exec("ALTER TABLE history_script_deliveries ADD COLUMN baijiahao_title TEXT NOT NULL DEFAULT ''")
    assert.equal(loadEpisodeFromDb(reference, options).baijiahao_title, '北京打工人')
    db.prepare('UPDATE history_script_deliveries SET baijiahao_title = ?').run('北京打工人：一天忙到晚为何还是攒不下钱？')
    const platformCopy = loadEpisodeFromDb(reference, options)
    assert.equal(platformCopy.title, '北京打工人')
    assert.equal(platformCopy.baijiahao_title, '北京打工人：一天忙到晚为何还是攒不下钱？')
    assert.equal(platformCopy.description, '既有简介')
    db.prepare('UPDATE history_script_sources SET rewritten_script = ?').run('改写稿已修改')
    assert.throws(() => loadEpisodeFromDb(reference, options), /脚本已变更/)
    db.prepare('UPDATE history_script_sources SET rewritten_script = ?').run(script)
    db.prepare("UPDATE history_script_deliveries SET cover_script_sha256 = 'old'").run()
    assert.throws(() => loadEpisodeFromDb(reference, options), /脚本已变更/)
    db.prepare('UPDATE history_script_deliveries SET cover_script_sha256 = ?').run(hash)
    rmSync(path.join(dir, 'data/static/share.png'))
    assert.throws(() => loadEpisodeFromDb(reference, options), /素材文件不存在/)
    assert.throws(() => parseEpisodeReference('/history-scripts?script=0'), /positive integer/)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('parses direct episode ids and supported frontend URLs', () => {
  assert.deepEqual(parseEpisodeReference('833'), { kind: 'episode_id', episodeId: 833 })
  assert.deepEqual(parseEpisodeReference('/dharma/episode/833'), { kind: 'episode_id', episodeId: 833 })
  assert.deepEqual(parseEpisodeReference('http://localhost:3013/episode/833?tab=script'), { kind: 'episode_id', episodeId: 833 })
  assert.deepEqual(parseEpisodeReference('http://localhost:3013/drama/93/episode/3'), {
    kind: 'drama_episode_number',
    dramaId: 93,
    episodeNumber: 3,
  })
  assert.throws(() => parseEpisodeReference('http://localhost:3013/drama/93/part/999'), /unsupported episode URL/u)
})

test('resolves drama episode URLs to the database episode id and reads package hooks', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'publish-episode-reference-'))
  const dbPath = path.join(dir, 'episodes.db')
  const db = new Database(dbPath)
  db.exec(`
    create table episodes (
      id integer primary key,
      drama_id integer not null,
      episode_number integer not null,
      title text not null,
      video_title text,
      episode_number_alias integer,
      opening_hook text,
      cliffhanger text,
      video_url text,
      cover_image_3x4_url text,
      cover_image_4x3_url text,
      metadata text,
      deleted_at text
    );
    insert into episodes (id, drama_id, episode_number, title, opening_hook, cliffhanger, metadata)
    values (436, 93, 3, '测试标题', '开头钩子', '结尾悬念', '{"dharmaPublishing":{"package":{"title":"测试标题","opening_hook":"包钩子","cliffhanger":"包悬念"}}}');
  `)
  db.close()

  try {
    assert.equal(resolveEpisodeId('http://localhost:3013/drama/93/episode/3', { dbPath }), 436)
    const episode = loadEpisodeFromDb('436', { dbPath })
    assert.equal(episode.episode_id, 436)
    assert.equal(episode.title, '测试标题')
    assert.equal(episode.opening_hook, '包钩子')
    assert.equal(episode.cliffhanger, '包悬念')
    assert.equal(episode.description, '包钩子\n\n包悬念')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loads a rendered Maoxuan project video and reuses its title panel as both covers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'publish-maoxuan-video-'))
  const dbPath = path.join(dir, 'projects.db')
  const videoPath = path.join(dir, 'latest.mp4')
  const coverPath = path.join(dir, 'panel-01.png')
  const db = new Database(dbPath)
  db.exec(`
    create table dramas (
      id integer primary key,
      title text not null,
      video_title text,
      workflow_type text not null,
      metadata text,
      deleted_at text
    );
    create table assets (
      id integer primary key,
      drama_id integer not null,
      category text not null,
      type text not null,
      local_path text,
      url text,
      deleted_at text
    );
    create table image_generations (
      id integer primary key,
      drama_id integer not null,
      image_type text not null,
      frame_type text not null,
      status text not null,
      local_path text
    );
  `)
  db.prepare('insert into dramas values (?, ?, ?, ?, ?, ?)').run(
    650,
    '项目标题',
    null,
    'maoxuan',
    JSON.stringify({
      question: '原始问题',
      analysis: '完整分析',
      panels: [{ n: 1, text: '题眼标题' }],
    }),
    null,
  )
  db.prepare('insert into assets values (?, ?, ?, ?, ?, ?, ?)').run(
    1,
    650,
    'maoxuan_episode_video',
    'video',
    videoPath,
    '/static/videos/maoxuan/650/latest.mp4',
    null,
  )
  db.prepare('insert into image_generations values (?, ?, ?, ?, ?, ?)').run(
    1,
    650,
    'maoxuan_panel',
    'panel_01',
    'completed',
    coverPath,
  )
  db.close()

  try {
    assert.equal(parseMaoxuanVideoReference('http://localhost:3013/maoxuan/project/650'), 650)
    assert.throws(() => parseMaoxuanVideoReference('650'), /unsupported maoxuan project URL/u)
    const result = loadMaoxuanVideoFromDb('http://localhost:3013/maoxuan/project/650', { dbPath })
    assert.equal(result.source_type, 'maoxuan_video')
    assert.equal(result.project_id, 650)
    assert.equal(result.video_path, videoPath)
    assert.equal(result.cover_3x4_src, coverPath)
    assert.equal(result.cover_4x3_src, coverPath)
    assert.equal(result.description, '原始问题\n完整分析\n#毛选 #顶级思维')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
