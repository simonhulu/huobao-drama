import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { ensurePortraitCover, prepareManifest } from './prepare.mjs'

function fixture(t, { short = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'baijiahao-prepare-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'data/static/merged'), { recursive: true })
  const video = path.join(root, 'data/static/merged/test.mp4')
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=10',
    '-t', short ? '0.4' : '1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
  ])
  const dbPath = path.join(root, 'data/huobao_drama.db')
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE episodes (
    id INTEGER PRIMARY KEY, drama_id INTEGER, episode_number INTEGER, title TEXT,
    video_title TEXT, opening_hook TEXT, cliffhanger TEXT, video_url TEXT,
    cover_image_3x4_url TEXT, cover_image_4x3_url TEXT, metadata TEXT, deleted_at TEXT
  )`)
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, video_title, opening_hook, cliffhanger, video_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(1038, 652, 1, 'Episode title', 'Existing video title', 'Existing opening', 'Existing ending', 'static/merged/test.mp4')
  db.close()
  return { root, video, dbPath }
}

function updateEpisode(dbPath, fields) {
  const db = new Database(dbPath)
  try {
    for (const [field, value] of Object.entries(fields)) {
      db.prepare(`UPDATE episodes SET ${field} = ? WHERE id = 1038`).run(value)
    }
  } finally { db.close() }
}

const digest = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex')

test('history script preparation preserves generated covers and uses a distinct source identity', async (t) => {
  const { root, dbPath } = fixture(t)
  const covers = { '3:4': 'static/portrait.png', '4:3': 'static/share.png', '16:9': 'static/wide.png' }
  for (const [ratio, file] of Object.entries(covers)) {
    const [width, height] = ratio.split(':').map(Number)
    await sharp({ create: { width: width * 100, height: height * 100, channels: 3, background: 'red' } })
      .png().toFile(path.join(root, 'data', file))
  }
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY, rewritten_script TEXT, deleted_at TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY, title TEXT, description TEXT,
      video_path TEXT, script_sha256 TEXT, cover_script_sha256 TEXT, covers_json TEXT, cover_status TEXT);`)
  const hash = createHash('sha256').update('正文').digest('hex')
  db.prepare('INSERT INTO history_script_sources VALUES (10, ?, NULL)').run('正文')
  db.prepare('INSERT INTO history_script_deliveries VALUES (10, ?, ?, ?, ?, ?, ?, ?)')
    .run('历史标题', '简介', 'static/merged/test.mp4', hash, hash, JSON.stringify(covers), 'completed')
  t.after(() => db.close())
  const result = await prepareManifest({ reference: 'http://localhost:3013/history-scripts?script=10', projectRoot: root })
  assert.equal(result.source_type, 'history_script')
  assert.equal(result.history_source_id, 10)
  assert.equal(result.episode_id, undefined)
  assert.equal(result.cover_path, path.join(root, 'data', covers['16:9']))
  assert.equal(result.cover_portrait_path, path.join(root, 'data', covers['3:4']))
  assert.match(result.manifest_path, /baijiahao-history-10.json$/)
  assert.equal(result.title, '历史标题')
  assert.equal(result.work_description, '历史标题')
  assert.equal(result.description, '')

  db.exec("ALTER TABLE history_script_deliveries ADD COLUMN baijiahao_title TEXT NOT NULL DEFAULT ''")
  const dedicatedTitle = '英国圈地运动：农民失去土地之后究竟去了哪里？'
  db.prepare('UPDATE history_script_deliveries SET baijiahao_title = ?, description = ?')
    .run(dedicatedTitle, '视频号专用描述'.repeat(50))
  const dedicated = await prepareManifest({ reference: '/history-scripts?script=10', projectRoot: root })
  assert.equal(dedicated.title, dedicatedTitle)
  assert.equal(dedicated.work_description, dedicatedTitle)
  assert.equal(dedicated.description, '')
  assert.equal(db.prepare('SELECT title FROM history_script_deliveries').get().title, '历史标题')
  db.prepare('UPDATE history_script_deliveries SET baijiahao_title = ?').run('字'.repeat(40))
  const boundary = await prepareManifest({ reference: '/history-scripts?script=10', projectRoot: root })
  assert.equal(boundary.title, '字'.repeat(40))
  assert.equal(boundary.work_description, '字'.repeat(40))
  db.prepare('UPDATE history_script_deliveries SET baijiahao_title = ?').run('字'.repeat(41))
  await assert.rejects(prepareManifest({ reference: '/history-scripts?script=10', projectRoot: root }), /1 至 40 字/)
  assert.equal(JSON.parse(fs.readFileSync(boundary.manifest_path, 'utf8')).title, '字'.repeat(40))
  db.prepare('UPDATE history_script_deliveries SET baijiahao_title = ?').run('圈地运动！')
  await assert.rejects(prepareManifest({ reference: '/history-scripts?script=10', projectRoot: root }), /书名号.*问号/)
})

test('resolves drama URL to actual episode id and preserves existing DB publishing metadata', async (t) => {
  const { root, video, dbPath } = fixture(t)
  updateEpisode(dbPath, { metadata: JSON.stringify({ dharmaPublishing: { package: { title: 'Package title', opening_hook: 'Package hook', cliffhanger: 'Package ending' } } }) })
  const result = await prepareManifest({ reference: 'http://127.0.0.1:3013/drama/652/episode/1', projectRoot: root })
  assert.equal(result.episode_id, 1038)
  assert.equal(result.title, 'Package title')
  assert.equal(result.description, 'Package hook\n\nPackage ending')
  assert.equal(result.work_description, 'Package hook')
  assert.equal(result.platform, 'baijiahao')
  assert.equal(result.version, 1)
  assert.equal(result.video_path, video)
  assert.equal(result.video_fingerprint, digest(video))
  assert.equal(result.cover_fingerprint, digest(result.cover_path))
  assert.equal(result.cover_portrait_fingerprint, digest(result.cover_portrait_path))
  assert.equal(result.manifest_path, path.join(root, 'data/publish-manifests/baijiahao-1038.json'))
  assert.match(result.session, /^[0-9a-f-]{36}$/u)
  assert.ok(Number.isFinite(Date.parse(result.prepared_at)))
  const saved = JSON.parse(fs.readFileSync(result.manifest_path, 'utf8'))
  assert.equal(saved.manifest_path, undefined)
  assert.equal(saved.video_fingerprint, result.video_fingerprint)
  const cover = await sharp(result.cover_path).metadata()
  assert.equal(cover.width, 1280)
  assert.equal(cover.height, 720)
  const portrait = await sharp(result.cover_portrait_path).metadata()
  assert.equal(portrait.width, 900)
  assert.equal(portrait.height, 1200)
  assert.notEqual(result.cover_portrait_path, result.cover_path)
})

test('uses existing title and hook fields for bare ids and never silently truncates titles', async (t) => {
  const { root } = fixture(t)
  const title = 'Long complete publishing title '.repeat(12).trim()
  const result = await prepareManifest({ reference: '1038', projectRoot: root, title })
  assert.equal(result.title, title)
  assert.equal(result.description, 'Existing opening\n\nExisting ending')
  assert.equal(result.work_description, 'Existing opening')
  assert.equal(JSON.parse(fs.readFileSync(result.manifest_path, 'utf8')).title, title)
})

test('supports explicit local video/cover metadata and output without a database', async (t) => {
  const { root, video } = fixture(t)
  const cover = path.join(root, 'provided-cover.png')
  await sharp({ create: { width: 640, height: 360, channels: 3, background: '#b02035' } }).png().toFile(cover)
  const output = path.join(root, 'custom/manifest.json')
  const result = await prepareManifest({ video, title: 'Manual title', description: 'Existing supplied description', cover, output, projectRoot: root })
  assert.equal(result.title, 'Manual title')
  assert.equal(result.description, 'Existing supplied description')
  assert.equal(result.work_description, 'Existing supplied description')
  assert.equal(result.cover_path, cover)
  assert.equal(result.episode_id, undefined)
  assert.equal(result.manifest_path, output)
  const defaultResult = await prepareManifest({ video, title: 'Manual title', cover, projectRoot: root })
  assert.equal(defaultResult.manifest_path, path.join(root, `data/publish-manifests/baijiahao-${digest(video)}.json`))
  assert.equal(defaultResult.description, '')
  assert.equal(defaultResult.work_description, 'Manual title')
  const hookResult = await prepareManifest({ video, title: 'Manual title', description: 'Full description',
    workDescription: 'Explicit opening hook', cover, projectRoot: root })
  assert.equal(hookResult.work_description, 'Explicit opening hook')
  assert.equal(hookResult.title, 'Manual title')
  assert.equal(hookResult.description, 'Full description')
})

test('generates short video covers at frame zero and reuses content-addressed cache', async (t) => {
  const { root, video } = fixture(t, { short: true })
  const first = await prepareManifest({ video, title: 'Short clip', projectRoot: root })
  const modified = fs.statSync(first.cover_path).mtimeMs
  const portraitModified = fs.statSync(first.cover_portrait_path).mtimeMs
  const second = await prepareManifest({ video, title: 'Short clip', projectRoot: root })
  assert.equal(second.cover_path, first.cover_path)
  assert.equal(second.cover_fingerprint, first.cover_fingerprint)
  assert.equal(fs.statSync(second.cover_path).mtimeMs, modified)
  assert.equal(second.cover_portrait_path, first.cover_portrait_path)
  assert.equal(second.cover_portrait_fingerprint, first.cover_portrait_fingerprint)
  assert.equal(fs.statSync(second.cover_portrait_path).mtimeMs, portraitModified)
  assert.notEqual(second.session, first.session)
  const changed = await prepareManifest({ video, title: 'Changed title', projectRoot: root })
  assert.notEqual(changed.cover_path, first.cover_path)
  assert.notEqual(changed.cover_fingerprint, first.cover_fingerprint)
  assert.notEqual(changed.cover_portrait_path, first.cover_portrait_path)
  assert.notEqual(changed.cover_portrait_fingerprint, first.cover_portrait_fingerprint)
})

test('cache identity depends on video bytes, not only filename or timestamps', async (t) => {
  const { root, video } = fixture(t)
  const first = await prepareManifest({ video, title: 'Same title', projectRoot: root })
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
  const second = await prepareManifest({ video, title: 'Same title', projectRoot: root })
  assert.notEqual(second.video_fingerprint, first.video_fingerprint)
  assert.notEqual(second.cover_path, first.cover_path)
  assert.notEqual(second.cover_portrait_path, first.cover_portrait_path)
})

test('returns identical canonical cover paths when the project root is a symlink', async (t) => {
  const { root, video } = fixture(t)
  const alias = path.join(root, 'alias')
  fs.symlinkSync(root, alias)
  const first = await prepareManifest({ video, title: 'Canonical paths', projectRoot: alias })
  const second = await prepareManifest({ video, title: 'Canonical paths', projectRoot: alias })
  assert.equal(first.cover_path, second.cover_path)
  assert.equal(first.cover_path, fs.realpathSync(first.cover_path))
})

test('rejects missing paths, blank titles, conflicting sources and invalid covers', async (t) => {
  const { root, video, dbPath } = fixture(t)
  await assert.rejects(prepareManifest({ projectRoot: root }), /Provide an episode/u)
  await assert.rejects(prepareManifest({ video, title: '', projectRoot: root }), /nonempty title/u)
  await assert.rejects(prepareManifest({ video, reference: '1038', title: 'Title', projectRoot: root }), /not both/u)
  await assert.rejects(prepareManifest({ video: path.join(root, 'missing.mp4'), title: 'Title', projectRoot: root }), /missing or unreadable/u)
  updateEpisode(dbPath, { video_url: null })
  await assert.rejects(prepareManifest({ reference: '1038', projectRoot: root }), /Video path is required/u)
  const cover = path.join(root, 'square.png')
  await sharp({ create: { width: 100, height: 100, channels: 3, background: '#111' } }).png().toFile(cover)
  await assert.rejects(prepareManifest({ video, title: 'Title', cover, projectRoot: root }), /16:9/u)
  await assert.rejects(prepareManifest({ video, title: 'Title', cover: path.join(root, 'missing.png'), projectRoot: root }), /missing or unreadable/u)
})

test('maps only known local frontend static URLs and blocks remote URLs or traversal', async (t) => {
  const { root, video, dbPath } = fixture(t)
  for (const source of ['http://localhost:3013/static/merged/test.mp4', 'http://127.0.0.1:3013/data/static/merged/test.mp4', '/static/merged/test.mp4', 'data/static/merged/test.mp4']) {
    updateEpisode(dbPath, { video_url: source })
    assert.equal((await prepareManifest({ reference: '1038', projectRoot: root })).video_path, video)
  }
  for (const source of ['https://external.example/static/merged/test.mp4', 'http://localhost:9222/static/merged/test.mp4', 'http://localhost:3013/private/test.mp4', '//localhost:3013/static/merged/test.mp4', 'static/../../private.mp4']) {
    updateEpisode(dbPath, { video_url: source })
    await assert.rejects(prepareManifest({ reference: '1038', projectRoot: root }), /known local frontend|Unsupported video URL|escapes/u)
  }
  await assert.rejects(prepareManifest({ video: 'http://localhost:3013/static/merged/test.mp4', title: 'Title', projectRoot: root }), /must be a local file/u)
})

test('rejects data path symlinks escaping the data directory', async (t) => {
  const { root, video, dbPath } = fixture(t)
  const outsideVideo = path.join(root, 'outside.mp4')
  fs.copyFileSync(video, outsideVideo)
  fs.symlinkSync(outsideVideo, path.join(root, 'data/static/merged/escaped.mp4'))
  updateEpisode(dbPath, { video_url: 'static/merged/escaped.mp4' })
  await assert.rejects(prepareManifest({ reference: '1038', projectRoot: root }), /escapes/u)
})

test('rebuilds damaged cached covers and rejects URL cover inputs', async (t) => {
  const { root, video } = fixture(t)
  const first = await prepareManifest({ video, title: 'Repair cache', projectRoot: root })
  fs.writeFileSync(first.cover_path, 'broken cached image')
  const second = await prepareManifest({ video, title: 'Repair cache', projectRoot: root })
  assert.equal(second.cover_path, first.cover_path)
  assert.equal(second.cover_fingerprint, first.cover_fingerprint)
  await assert.rejects(prepareManifest({ video, title: 'Title', cover: 'https://example.com/cover.png', projectRoot: root }), /must be a local file/u)
})

test('refuses to overwrite source video, cover or database with manifest output', async (t) => {
  const { root, video, dbPath } = fixture(t)
  const prepared = await prepareManifest({ video, title: 'Protected inputs', projectRoot: root })
  const originalVideo = digest(video)
  const originalDb = digest(dbPath)
  for (const output of [video, prepared.cover_path, prepared.cover_portrait_path, dbPath]) {
    await assert.rejects(prepareManifest({ video, title: 'Protected inputs', projectRoot: root, output }), /must not overwrite/u)
  }
  assert.equal(digest(video), originalVideo)
  assert.equal(digest(dbPath), originalDb)
  assert.equal(digest(prepared.cover_path), prepared.cover_fingerprint)
  assert.equal(digest(prepared.cover_portrait_path), prepared.cover_portrait_fingerprint)
})

test('accepts a supplied 3:4 portrait cover and validates its ratio and locality', async (t) => {
  const { root, video } = fixture(t)
  const portraitCover = path.join(root, 'provided-portrait.png')
  await sharp({ create: { width: 300, height: 400, channels: 3, background: '#b02035' } }).png().toFile(portraitCover)
  const result = await prepareManifest({ video, title: 'Supplied portrait', portraitCover, projectRoot: root })
  assert.equal(result.cover_portrait_path, portraitCover)
  assert.equal(result.cover_portrait_fingerprint, digest(portraitCover))
  await assert.rejects(prepareManifest({ video, title: 'Invalid portrait', portraitCover: result.cover_path, projectRoot: root }), /3:4/u)
  await assert.rejects(prepareManifest({ video, title: 'Invalid portrait', portraitCover: 'https://example.com/cover.png', projectRoot: root }), /--portrait-cover must be a local file/u)
  await assert.rejects(prepareManifest({ video, title: 'Missing portrait', portraitCover: path.join(root, 'missing.png'), projectRoot: root }), /missing or unreadable/u)
})

test('adds a portrait cover to an old manifest without changing its session or other fields', async (t) => {
  const { root, video } = fixture(t, { short: true })
  const original = await prepareManifest({ video, title: 'Old upload session', projectRoot: root })
  const { cover_portrait_path, cover_portrait_fingerprint, ...oldManifest } = original
  const before = structuredClone(oldManifest)
  const added = await ensurePortraitCover(oldManifest, { projectRoot: root })
  assert.deepEqual(oldManifest, before)
  assert.deepEqual(Object.keys(added).sort(), ['cover_portrait_fingerprint', 'cover_portrait_path'])
  assert.equal(added.cover_portrait_path, cover_portrait_path)
  assert.equal(added.cover_portrait_fingerprint, cover_portrait_fingerprint)
  const combined = { ...oldManifest, ...added }
  assert.equal(combined.session, original.session)
  assert.equal(combined.video_fingerprint, original.video_fingerprint)
  assert.deepEqual(await ensurePortraitCover(combined, { projectRoot: root }), added)
  await assert.rejects(ensurePortraitCover({ ...oldManifest, video_fingerprint: 'invalid' }, { projectRoot: root }), /Video fingerprint changed/u)
  await assert.rejects(ensurePortraitCover({ ...combined, cover_portrait_fingerprint: 'invalid' }, { projectRoot: root }), /Portrait cover fingerprint changed/u)
})

test('CLI accepts --portrait-cover and preserves the supplied portrait bytes', async (t) => {
  const { root, video } = fixture(t)
  const cover = path.join(root, 'landscape.png')
  const portrait = path.join(root, 'portrait.png')
  await sharp({ create: { width: 320, height: 180, channels: 3, background: '#335' } }).png().toFile(cover)
  await sharp({ create: { width: 300, height: 400, channels: 3, background: '#355' } }).png().toFile(portrait)
  const script = fileURLToPath(new URL('./prepare.mjs', import.meta.url))
  const output = path.join(root, 'manifest.json')
  const stdout = execFileSync(process.execPath, [script, '--video', video, '--title', 'CLI title', '--work-description', 'CLI opening hook', '--cover', cover, '--portrait-cover', portrait, '--output', output], { cwd: root, encoding: 'utf8' })
  const result = JSON.parse(stdout)
  assert.equal(result.cover_portrait_path, portrait)
  assert.equal(result.cover_portrait_fingerprint, digest(portrait))
  assert.equal(result.work_description, 'CLI opening hook')
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).cover_portrait_path, portrait)
})

test('CLI rejects invalid options without writing a manifest', (t) => {
  const { root } = fixture(t)
  const script = fileURLToPath(new URL('./prepare.mjs', import.meta.url))
  assert.throws(() => execFileSync(process.execPath, [script, '--video'], { cwd: root, stdio: 'pipe' }), /Command failed/u)
  assert.throws(() => execFileSync(process.execPath, [script, '--unknown', 'test'], { cwd: root, stdio: 'pipe' }), /Command failed/u)
  assert.equal(fs.existsSync(path.join(root, 'data/publish-manifests')), false)
})
