import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import Database from 'better-sqlite3'
import sharp from 'sharp'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

test('WeChat CLI prepares saved history assets without legacy package fields and rejects invalid metadata', async (t) => {
  // The CLI resolves stored static paths against the real project root. Only this
  // uniquely named fixture directory is touched; DB_PATH points at its own DB.
  const directory = fs.mkdtempSync(path.join(projectRoot, 'data/static/wechat-history-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const localPath = name => path.relative(path.join(projectRoot, 'data'), path.join(directory, name))
  const video = path.join(directory, 'video.mp4')
  fs.writeFileSync(video, 'local media fixture')
  const covers = { '3:4': localPath('portrait.png'), '4:3': localPath('share.png'), '16:9': localPath('wide.png') }
  for (const [ratio, file] of Object.entries(covers)) {
    const [width, height] = ratio.split(':').map(Number)
    await sharp({ create: { width: width * 30, height: height * 30, channels: 3, background: 'blue' } })
      .png().toFile(path.join(projectRoot, 'data', file))
  }
  const dbPath = path.join(directory, 'fixture.db')
  const db = new Database(dbPath)
  t.after(() => db.close())
  db.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY, rewritten_script TEXT, deleted_at TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY, title TEXT, description TEXT,
      video_path TEXT, script_sha256 TEXT, cover_script_sha256 TEXT, covers_json TEXT, cover_status TEXT);`)
  const hash = createHash('sha256').update('历史稿正文').digest('hex')
  db.prepare('INSERT INTO history_script_sources VALUES (10, ?, NULL)').run('历史稿正文')
  db.prepare('INSERT INTO history_script_deliveries VALUES (10, ?, ?, ?, ?, ?, ?, ?)')
    .run('北京打工人', '已有简介', localPath('video.mp4'), hash, hash, JSON.stringify(covers), 'completed')
  const out = path.join(directory, 'manifest.json')
  const run = () => spawnSync(process.execPath, ['scripts/wechat/prepare.mjs',
    'http://localhost:3013/history-scripts?script=10', '--out', out],
  { cwd: path.join(projectRoot, 'backend'), env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' })
  let result = run()
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(manifest.source_type, 'history_delivery')
  assert.equal(manifest.history_source_id, 10)
  assert.equal(manifest.episode_id, undefined)
  assert.equal(manifest.publish_package_id, undefined)
  assert.equal(manifest.session, 'wechat-history-10')
  assert.equal(manifest.description, '已有简介')
  assert.equal(manifest.video_path, video)
  assert.equal(manifest.cover_3x4_path, path.join(projectRoot, 'data', covers['3:4']))
  assert.equal(manifest.cover_4x3_path, path.join(projectRoot, 'data', covers['4:3']))
  fs.unlinkSync(out)
  for (const [title, expected] of [
    ['明朝，竟然这样,难怪？', '明朝 竟然这样 难怪？'],
    ['，明朝,竟然这样？，', '明朝 竟然这样？'],
    ['《明史》：“帝”+10%？', '《明史》：“帝”+10%？'],
    ['冬菜：5℃？', '冬菜：5℃？'],
  ]) {
    db.prepare('UPDATE history_script_deliveries SET title = ?').run(title)
    result = run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).title, expected)
    fs.unlinkSync(out)
  }
  for (const title of ['明朝！', '明朝。', '明朝；真相', '明朝\n真相', '明朝/真相', '明朝🙂']) {
    db.prepare('UPDATE history_script_deliveries SET title = ?').run(title)
    result = run()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /书名号.*问号/)
    assert.equal(fs.existsSync(out), false)
  }
  for (const title of ['', '，，', '长'.repeat(17)]) {
    db.prepare('UPDATE history_script_deliveries SET title = ?').run(title)
    result = run()
    assert.equal(result.status, 2)
    assert.match(result.stderr, /1 至 16 字/)
    assert.equal(fs.existsSync(out), false)
  }
  db.prepare('UPDATE history_script_deliveries SET title = ?, description = ?').run('北京打工人', '长'.repeat(201))
  result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).description, '长'.repeat(201))
  fs.unlinkSync(out)
  db.exec("ALTER TABLE history_script_deliveries ADD COLUMN baijiahao_title TEXT NOT NULL DEFAULT ''")
  db.prepare('UPDATE history_script_deliveries SET baijiahao_title = ?').run('北京打工人：一天忙到晚为何还是攒不下钱？')
  result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).title, '北京打工人')
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).description, '长'.repeat(201))
  fs.unlinkSync(out)
  db.prepare('UPDATE history_script_deliveries SET description = ?').run('已有简介')
  await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).png().toFile(path.join(directory, 'share.png'))
  result = run()
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /不会自动裁切/)
  assert.equal(fs.existsSync(out), false)
})
