import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { HuashengMaterialLibrary } from './huasheng-material-library.mjs'

const projectId = '260077122691088'
const manifest = (pid = projectId) => ({ projectId: pid, title: `Project ${pid}`, projectUrl: `https://www.huasheng.cn/video/${pid}`, totalClips: 37, top: 3 })
const candidate = (id, rank) => ({ id, rank, url: `https://media.example/${id}.mp4`, cover: `https://media.example/${id}.jpg`, duration: 10, width: 1920, height: 1080, fps: 25, material_type: 1, custom: { providerField: id } })
const completed = (id, localPath = `clips/001/01_${id}.mp4`) => ({
  status: 'done', localPath, bytes: 8, sha256: createHash('sha256').update(`bytes-${id}`).digest('hex'),
  media: { duration: 9.5, width: 1534, height: 862, codec: 'h264' }, reused: false,
})
const clip = (pid = projectId, clipId = '100001', label = '红军在瑞金行进') => ({
  projectId: pid, clipId, order: 1, text: '叙述中的红军提前转移。', query: label, querySource: 'recommendations.query',
  selectedAssetId: 'a', selectedCaption: '黑白士兵走过草房旁边的田野。', total: 4, capturedAt: '2026-10-24T00:00:00Z', status: 'incomplete',
  metadata: { id: clipId, idx: 1, content: 'original narration', video: { id: 'a', nested: { important: true } }, extra: [1, 2] },
  candidates: [
    { ...candidate('a', 1), download: completed('a') },
    { ...candidate('b', 2), caption: '庐山会议场景', download: { status: 'pending', localPath: 'clips/001/02_b.mp4' } },
    { ...candidate('c', 3), download: { status: 'failed', localPath: 'clips/001/03_c.mp4', error: 'CDN unavailable' } },
    candidate('d', 4),
  ],
})

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huasheng-material-library-'))
  const filename = path.join(root, 'materials.db')
  const library = new HuashengMaterialLibrary({ databasePath: filename })
  t.after(() => { library.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, filename, library }
}

test('SQLite upserts deduplicate assets and preserve labels, unknown metadata and every download state', t => {
  const { library, root } = setup(t)
  const record = clip()
  library.saveProject(manifest())
  library.saveClip(projectId, record, root)
  library.saveProject(manifest())
  library.saveClip(projectId, record, root)
  assert.deepEqual(library.stats(), { projects: 1, clips: 1, recommendations: 4, assets: 4, downloadedAssets: 1, files: 1, downloadedRecommendations: 1 })
  assert.deepEqual(library.getClip(projectId, record.clipId, root), record)
  assert.deepEqual(library.stats(projectId), library.stats())
  assert.equal(library.db.pragma('foreign_keys', { simple: true }), 1)
  assert.equal(library.db.pragma('journal_mode', { simple: true }), 'wal')
  assert.deepEqual(library.db.pragma('foreign_key_check'), [])
})

test('projects with the same clip ID retain independent labels and share unique assets', t => {
  const { library, root } = setup(t)
  const otherPid = '260004813045809'
  library.saveProject(manifest())
  library.saveProject(manifest(otherPid))
  const first = clip()
  const second = clip(otherPid, first.clipId, '草房旁列队行进')
  second.order = 2
  second.candidates[0].download = completed('a', 'second-project/01_a.mp4')
  library.saveClip(projectId, first, root)
  library.saveClip(otherPid, second, root)
  assert.deepEqual(library.stats(), { projects: 2, clips: 2, recommendations: 8, assets: 4, downloadedAssets: 1, files: 2, downloadedRecommendations: 2 })
  assert.equal(library.stats(projectId).files, 1)
  assert.equal(library.stats(otherPid).files, 1)
  assert.equal(library.stats(projectId).downloadedAssets, 1)
  assert.equal(library.stats(otherPid).downloadedAssets, 1)
  assert.equal(library.getClip(projectId, first.clipId, root).query, first.query)
  assert.equal(library.getClip(otherPid, first.clipId, root).query, second.query)
  const shared = library.search({ query: '列队' })
  assert.equal(shared.length, 1)
  assert.equal(shared[0].projectId, otherPid)
  assert.equal(shared[0].assetId, 'a')
  assert.equal(shared[0].localPath, path.join(root, 'second-project/01_a.mp4'))
})

test('distinct material search deduplicates recommendation rows before limiting results', t => {
  const { library, root } = setup(t)
  library.saveProject(manifest())
  for (let index = 0; index < 85; index++) {
    const record = clip(projectId, String(100001 + index), '城墙守军')
    record.order = index + 1
    record.candidates = [{ ...candidate('a', 1), download: completed('a') }]
    record.total = 1
    library.saveClip(projectId, record, root)
  }
  const last = clip(projectId, '200001', '城墙守军')
  last.order = 100
  last.candidates = [{ ...candidate('b', 1), caption: '城墙守军站在城楼上', download: completed('b') }]
  last.total = 1
  library.saveClip(projectId, last, root)
  const results = library.search({ query: '城墙', distinctAssets: true, limit: 2 })
  assert.equal(results.length, 2)
  assert.deepEqual(new Set(results.map(item => item.assetId)), new Set(['a', 'b']))
  assert.equal(results[0].assetId, 'b', 'a source caption match ranks above an old query-context match')
})

test('material search excludes used identities and file hashes before applying its result limit', t => {
  const { library, root } = setup(t)
  library.saveProject(manifest())
  const record = clip()
  record.candidates = ['a', 'b', 'c'].map((id, index) => ({ ...candidate(id, index + 1), download: completed(id) }))
  record.total = record.candidates.length
  library.saveClip(projectId, record, root)
  const results = library.search({ query: '红军', distinctAssets: true, excludeAssetIds: ['a'],
    excludeSha256: [record.candidates[1].download.sha256], limit: 1 })
  assert.deepEqual(results.map(item => item.assetId), ['c'])
  assert.equal(results[0].sourceCaption, '', 'the source clip query is never promoted to an asset description')
})

test('search uses a clip-specific caption only for its matching original selected asset', t => {
  const { library, root } = setup(t)
  library.saveProject(manifest())
  const record = clip()
  record.query = '古代人物远眺'
  record.text = '人物介绍'
  record.selectedCaption = '司马懿由吴秀波饰演，在城墙上远眺。'
  record.candidates = ['a', 'b'].map((id, index) => ({ ...candidate(id, index + 1), download: completed(id) }))
  record.total = record.candidates.length
  library.saveClip(projectId, record, root)
  library.db.prepare("UPDATE huasheng_material_assets SET caption='' WHERE asset_id='a'").run()
  const results = library.search({ query: '吴秀波', distinctAssets: true })
  assert.deepEqual(results.map(item => item.assetId), ['a'])
  assert.equal(results[0].sourceCaption, record.selectedCaption)
  assert.equal(library.search({ query: '古代人物', distinctAssets: true }).find(item => item.assetId === 'b').sourceCaption, '')
})

test('refreshing recommendation ranks replaces the snapshot while preserving local file records and known captions', t => {
  const { library, root } = setup(t)
  library.saveProject(manifest())
  const original = clip()
  library.saveClip(projectId, original, root)
  const refreshed = structuredClone(original)
  refreshed.selectedAssetId = 'b'
  refreshed.selectedCaption = ''
  refreshed.query = 'revised query'
  refreshed.total = 2
  refreshed.candidates = [{ ...candidate('b', 1), caption: '' }, candidate('a', 2)]
  library.saveClip(projectId, refreshed, root)
  assert.equal(library.stats().files, 1)
  assert.equal(library.stats(projectId).files, 1, 'the source project retains its file when recommendations change')
  assert.equal(library.stats(projectId).downloadedAssets, 1)
  assert.equal(library.stats().recommendations, 2)
  assert.deepEqual(library.getClip(projectId, refreshed.clipId, root).candidates.map(value => [value.id, value.rank]), [['b', 1], ['a', 2]])
  assert.equal(library.db.prepare("SELECT caption FROM huasheng_material_assets WHERE asset_id='b'").get().caption, '庐山会议场景')
  assert.equal(library.db.prepare("SELECT caption FROM huasheng_material_assets WHERE asset_id='a'").get().caption, original.selectedCaption)
  assert.equal(library.search().length, 0, 'current snapshot no longer claims a completed download')
  assert.equal(library.search({ downloadedOnly: false, query: '庐山' }).length, 1, 'known source captions remain searchable')
  refreshed.candidates = [refreshed.candidates[0]]
  refreshed.total = 1
  library.saveClip(projectId, refreshed, root)
  assert.equal(library.stats(projectId).files, 1, 'removing the downloaded asset from all recommendations keeps its source file')
  assert.equal(library.stats(projectId).downloadedAssets, 1)
  assert.equal(library.stats(projectId).recommendations, 1)
})

test('a failed snapshot transaction retains its previous ranks, labels, files and assets', t => {
  const { library, root } = setup(t)
  library.saveProject(manifest())
  const original = clip()
  library.saveClip(projectId, original, root)
  const before = library.stats()
  const invalid = structuredClone(original)
  invalid.query = 'must roll back'
  invalid.candidates = [candidate('new', 1), candidate('duplicate-rank', 1)]
  assert.throws(() => library.saveClip(projectId, invalid, root), /UNIQUE/)
  assert.deepEqual(library.getClip(projectId, original.clipId, root), original)
  assert.deepEqual(library.stats(), before)
  const mismatched = { ...original, projectId: 'other' }
  assert.throws(() => library.saveClip(projectId, mismatched, root), /does not match/)
})

test('a local file path cannot be reassigned to another asset', t => {
  const { library, root } = setup(t)
  library.saveProject(manifest())
  const original = clip()
  library.saveClip(projectId, original, root)
  const conflicting = structuredClone(original)
  conflicting.candidates = [{ ...candidate('different-asset', 1), download: completed('different-asset', original.candidates[0].download.localPath) }]
  assert.throws(() => library.saveClip(projectId, conflicting, root), /another asset/)
  assert.deepEqual(library.getClip(projectId, original.clipId, root), original)
  assert.equal(library.stats().assets, 4)
})

test('sharing an existing file preserves its original project and clip ownership', t => {
  const { library, root } = setup(t)
  const first = clip()
  library.saveProject(manifest())
  library.saveClip(projectId, first, root)
  const otherPid = '260004813045809'
  library.saveProject(manifest(otherPid))
  const shared = clip(otherPid, '100002')
  library.saveClip(otherPid, shared, root)
  assert.equal(library.stats().files, 1)
  assert.equal(library.stats(projectId).files, 1)
  assert.equal(library.stats(otherPid).files, 0)
  assert.deepEqual(library.db.prepare('SELECT project_id,clip_id FROM huasheng_material_files').get(), { project_id: projectId, clip_id: '100001' })
  assert.equal(library.search({ projectId: otherPid }).length, 1, 'both projects may reference the one local file')
})

test('findFiles returns stable global asset files even after their recommendations disappear', t => {
  const { library, root } = setup(t)
  assert.deepEqual(library.findFiles('missing'), [])
  const otherPid = '260004813045809'
  library.saveProject(manifest())
  library.saveProject(manifest(otherPid))
  const first = clip()
  const second = clip(otherPid)
  second.candidates[0].download = completed('a', 'another-project/01_a.mp4')
  library.saveClip(otherPid, second, root)
  library.saveClip(projectId, first, root)
  const differentAsset = clip(projectId, '100002')
  differentAsset.order = 2
  differentAsset.candidates = [{ ...candidate('b', 1), download: completed('b', 'clips/002/01_b.mp4') }]
  differentAsset.total = 1
  library.saveClip(projectId, differentAsset, root)
  const expected = [second, first].map(record => {
    const { bytes, sha256, media, localPath } = record.candidates[0].download
    return { filePath: path.join(root, localPath), bytes, sha256, media }
  }).sort((a, b) => a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0)
  assert.deepEqual(library.findFiles('a'), expected)
  assert.equal(library.findFiles('b').length, 1)
  assert.equal(library.findFiles('b')[0].filePath, path.join(root, 'clips/002/01_b.mp4'))
  assert.ok(expected.every(file => !fs.existsSync(file.filePath)), 'lookup uses registered metadata without reading files')
  for (const record of [first, second]) {
    record.candidates = []
    record.total = 0
    library.saveClip(record.projectId, record, root)
  }
  assert.equal(library.search().filter(row => row.assetId === 'a').length, 0)
  assert.deepEqual(library.findFiles('a'), expected)
  assert.deepEqual(library.findFiles('missing'), [])
})

test('relocateRoot atomically rebases cross-project file references and pending targets within the directory boundary', t => {
  const { library, root } = setup(t)
  const source = path.join(root, 'source')
  const target = path.join(root, 'external-target')
  const otherPid = '260004813045809'
  library.saveProject(manifest())
  library.saveProject(manifest(otherPid))
  const first = clip()
  const second = clip(otherPid)
  library.saveClip(projectId, first, path.join(source, projectId))
  library.saveClip(otherPid, second, path.join(source, otherPid))
  const sibling = clip(projectId, '100002')
  sibling.order = 2
  const siblingRoot = path.join(root, 'source-archive')
  library.saveClip(projectId, sibling, siblingRoot)
  const before = library.stats()
  const outside = library.getClip(projectId, sibling.clipId, siblingRoot)
  assert.equal(library.relocateRoot(source, target), 2)
  assert.deepEqual(library.getClip(projectId, first.clipId, path.join(target, projectId)), first)
  assert.deepEqual(library.getClip(otherPid, second.clipId, path.join(target, otherPid)), second)
  assert.deepEqual(library.getClip(projectId, sibling.clipId, siblingRoot), outside)
  assert.deepEqual(library.stats(), before)
  const filePaths = library.findFiles('a').map(file => file.filePath)
  assert.deepEqual(filePaths, [
    path.join(target, otherPid, first.candidates[0].download.localPath),
    path.join(target, projectId, first.candidates[0].download.localPath),
    path.join(siblingRoot, sibling.candidates[0].download.localPath),
  ].sort())
  assert.ok(filePaths.every(filename => !fs.existsSync(filename)), 'relocation only changes registered paths')
  assert.equal(library.search({ projectId: otherPid })[0].localPath, path.join(target, otherPid, second.candidates[0].download.localPath))
  const pending = library.search({ projectId: otherPid, downloadedOnly: false }).find(row => row.status === 'pending')
  assert.equal(pending.localPath, path.join(target, otherPid, second.candidates[1].download.localPath))
  assert.deepEqual(library.db.pragma('foreign_key_check'), [])
  assert.equal(library.db.pragma('defer_foreign_keys', { simple: true }), 0)
  assert.equal(library.relocateRoot(source, target), 0)
  assert.equal(library.relocateRoot(target, path.join(target, '.')), 0)
})

test('relocateRoot preserves file registrations that are no longer in a recommendation snapshot', t => {
  const { library, root } = setup(t)
  library.saveProject(manifest())
  const record = clip()
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  library.saveClip(projectId, record, source)
  record.candidates = []
  record.total = 0
  library.saveClip(projectId, record, source)
  assert.equal(library.relocateRoot(source, target), 1)
  assert.equal(library.findFiles('a')[0].filePath, path.join(target, 'clips/001/01_a.mp4'))
  assert.equal(library.stats().files, 1)
  assert.deepEqual(library.db.pragma('foreign_key_check'), [])
})

test('relocateRoot rejects a registered destination and rolls back all file and recommendation paths', t => {
  const { library, root } = setup(t)
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  library.saveProject(manifest())
  const original = clip()
  library.saveClip(projectId, original, source)
  const collision = clip(projectId, '100002')
  collision.order = 2
  collision.candidates = [{ ...candidate('different', 1), download: completed('different', original.candidates[0].download.localPath) }]
  collision.total = 1
  library.saveClip(projectId, collision, target)
  const before = {
    files: library.db.prepare('SELECT * FROM huasheng_material_files ORDER BY file_path').all(),
    recommendations: library.db.prepare('SELECT * FROM huasheng_material_recommendations ORDER BY clip_id,rank').all(),
  }
  assert.throws(() => library.relocateRoot(source, target), /target already belongs/)
  assert.deepEqual(library.db.prepare('SELECT * FROM huasheng_material_files ORDER BY file_path').all(), before.files)
  assert.deepEqual(library.db.prepare('SELECT * FROM huasheng_material_recommendations ORDER BY clip_id,rank').all(), before.recommendations)
  assert.deepEqual(library.getClip(projectId, original.clipId, source), original)
  assert.deepEqual(library.db.pragma('foreign_key_check'), [])
  assert.equal(library.db.pragma('defer_foreign_keys', { simple: true }), 0)
})

test('search uses literal keyword matching, stable pagination and successful-download filtering', t => {
  const { library, root } = setup(t)
  library.saveProject(manifest())
  const first = clip()
  library.saveClip(projectId, first, root)
  const second = clip(projectId, '100002', 'filename 100%_ literal')
  second.order = 2
  second.candidates[0].download = completed('a', 'clips/002/01_a.mp4')
  library.saveClip(projectId, second, root)
  const downloaded = library.search()
  assert.equal(downloaded.length, 2)
  assert.ok(downloaded.every(value => value.status === 'done' && path.isAbsolute(value.localPath)))
  assert.deepEqual(downloaded.map(value => value.clipId), ['100001', '100002'])
  assert.deepEqual(library.search({ limit: 1, offset: 1 }), [downloaded[1]])
  assert.equal(library.search({ query: '黑白士兵' }).length, 2)
  assert.equal(library.search({ query: '提前转移' }).length, 2)
  assert.equal(library.search({ query: "' OR 1=1 --" }).length, 0)
  assert.equal(library.search({ query: '100%_' }).length, 1)
  assert.equal(library.search({ downloadedOnly: false }).length, 8)
  assert.equal(library.search({ downloadedOnly: false, topOnly: true }).length, 6)
  assert.equal(library.search({ downloadedOnly: false, clipId: '100001' }).length, 4)
  assert.equal(library.search({ projectId: 'missing' }).length, 0)
  assert.throws(() => library.search({ limit: 0 }), /pagination/)
  assert.throws(() => library.search({ offset: -1 }), /pagination/)
})

test('closing and reopening reconstructs a checkpoint from tables with correctly rebased local paths', t => {
  const { library, root, filename } = setup(t)
  library.saveProject(manifest())
  const record = clip()
  record.error = 'retryable API failure'
  library.saveClip(projectId, record, root)
  library.close()
  const reopened = new HuashengMaterialLibrary({ databasePath: filename })
  t.after(() => reopened.close())
  assert.deepEqual(reopened.getClip(projectId, record.clipId, root), record)
  const elsewhere = path.join(root, 'elsewhere')
  const rebound = reopened.getClip(projectId, record.clipId, elsewhere)
  assert.equal(rebound.candidates[0].download.localPath, '../clips/001/01_a.mp4')
  assert.equal(reopened.getClip(projectId, 'missing', root), null)
  assert.equal(reopened.search()[0].sha256, record.candidates[0].download.sha256)
})

test('foreign keys and completed-file validation prevent incomplete or orphaned records', t => {
  const { library, root } = setup(t)
  assert.throws(() => library.saveClip(projectId, clip(), root), /FOREIGN KEY/)
  library.saveProject(manifest())
  const record = clip()
  delete record.candidates[0].download.sha256
  assert.throws(() => library.saveClip(projectId, record, root), /SHA-256/)
  assert.deepEqual(library.stats(), { projects: 1, clips: 0, recommendations: 0, assets: 0, downloadedAssets: 0, files: 0, downloadedRecommendations: 0 })
})

test('an injected SQLite connection remains open after closing the library', () => {
  const database = new Database(':memory:')
  const library = new HuashengMaterialLibrary({ database })
  library.saveProject(manifest())
  library.close()
  assert.equal(database.open, true)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM huasheng_material_projects').get().count, 1)
  database.close()
})
