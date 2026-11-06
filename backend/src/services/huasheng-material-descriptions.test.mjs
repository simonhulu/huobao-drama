import assert from 'node:assert/strict'
import test from 'node:test'
import { HuashengMaterialLibrary } from './huasheng-material-library.mjs'
import { repairHuashengMaterialDescriptions } from './huasheng-material-descriptions.mjs'

function fixture(t) {
  const library = new HuashengMaterialLibrary({ databasePath: ':memory:' })
  t.after(() => library.close())
  const db = library.db
  const add = (projectId = 'p', clipId = 'first', video = { id: 'source', caption: '原素材是古代城墙上的男子' }) => {
    library.saveProject({ projectId, title: 'fixture', projectUrl: 'https://www.huasheng.cn/video/1', totalClips: 1, top: 3 })
    const metadata = { video, composite_video: { id: '' }, _recommendationCheckpoint: { version: 1, sourceSha256: 'legacy', snapshotSha256: 'keep' } }
    library.saveClip(projectId, { projectId, clipId, order: 1, query: '黄昏下古代城墙上兄弟二人并肩远眺的背影',
      selectedAssetId: '', selectedCaption: video?.caption || '', metadata,
      candidates: ['source', 'second', 'third'].map((id, index) => ({ id, rank: index + 1, duration: 5, width: 1920, height: 1080 })) }, '/tmp/descriptions-test')
    return metadata
  }
  const unchanged = () => ({ files: db.prepare('SELECT * FROM huasheng_material_files').all(),
    recommendations: db.prepare('SELECT * FROM huasheng_material_recommendations').all(),
    metadata: db.prepare('SELECT project_id,clip_id,metadata_json FROM huasheng_material_clips').all() })
  return { db, library, add, unchanged }
}

test('dry run detects the real missing identity without changing any saved data', t => {
  const { db, add, unchanged } = fixture(t)
  add()
  const before = db.serialize()
  const checkpoints = unchanged()
  const report = repairHuashengMaterialDescriptions(db)
  assert.equal(report.identitiesToRepair, 1)
  assert.equal(report.assetCaptionsToFill, 1)
  assert.equal(report.identitiesRepaired, 0)
  assert.deepEqual(db.serialize(), before)
  assert.deepEqual(unchanged(), checkpoints)
})

test('repairs only the selected source caption, preserves query, downloads and checkpoints, and is idempotent', t => {
  const { db, library, add, unchanged } = fixture(t)
  add()
  const before = unchanged()
  const report = repairHuashengMaterialDescriptions(db, { apply: true })
  assert.equal(report.identitiesRepaired, 1)
  assert.equal(report.assetCaptionsFilled, 1)
  assert.deepEqual(db.prepare('SELECT selected_asset_id,selected_caption,query FROM huasheng_material_clips').get(), {
    selected_asset_id: 'source', selected_caption: '原素材是古代城墙上的男子', query: '黄昏下古代城墙上兄弟二人并肩远眺的背影',
  })
  assert.deepEqual(library.search({ downloadedOnly: false }).map(row => [row.assetId, row.sourceCaption]), [
    ['source', '原素材是古代城墙上的男子'], ['second', ''], ['third', ''],
  ])
  assert.deepEqual(unchanged(), before)
  const second = repairHuashengMaterialDescriptions(db, { apply: true })
  assert.equal(second.identitiesRepaired, 0)
  assert.equal(second.assetCaptionsFilled, 0)
})

test('replaces a composite identity with the source identity without assigning its caption to another candidate', t => {
  const { db, add } = fixture(t)
  add()
  db.prepare("UPDATE huasheng_material_clips SET selected_asset_id='composite'").run()
  const report = repairHuashengMaterialDescriptions(db, { apply: true })
  assert.equal(report.identitiesRepaired, 1)
  assert.equal(db.prepare('SELECT selected_asset_id FROM huasheng_material_clips').get().selected_asset_id, 'source')
  assert.equal(db.prepare("SELECT caption FROM huasheng_material_assets WHERE asset_id='second'").get().caption, '')
})

test('missing identities and unverified legacy captions stay untouched instead of borrowing the search description', t => {
  const { db, add } = fixture(t)
  add('p', 'missing', { caption: '没有素材身份的说明' })
  add('p', 'unverified', { id: 'source' })
  db.prepare("UPDATE huasheng_material_clips SET selected_caption='来源无法证明的旧说明' WHERE clip_id='unverified'").run()
  const before = db.serialize()
  const report = repairHuashengMaterialDescriptions(db, { apply: true })
  assert.equal(report.missingOriginalIdentity, 1)
  assert.equal(report.unverifiedCaption, 1)
  assert.equal(report.assetCaptionsFilled, 0)
  assert.deepEqual(db.serialize(), before)
})

test('preserves known asset captions and leaves conflicting global captions to their per-clip identities', t => {
  const { db, add } = fixture(t)
  add('p1', 'one', { id: 'source', caption: '第一份原说明' })
  add('p2', 'two', { id: 'source', caption: '第二份原说明' })
  const report = repairHuashengMaterialDescriptions(db, { apply: true })
  assert.equal(report.identitiesRepaired, 2)
  assert.equal(report.conflictingAssetCaptions, 1)
  assert.equal(db.prepare("SELECT caption FROM huasheng_material_assets WHERE asset_id='source'").get().caption, '')
  db.prepare("UPDATE huasheng_material_assets SET caption='已确认的素材说明' WHERE asset_id='source'").run()
  const next = repairHuashengMaterialDescriptions(db, { apply: true })
  assert.equal(next.knownAssetCaptionsPreserved, 1)
  assert.equal(db.prepare("SELECT caption FROM huasheng_material_assets WHERE asset_id='source'").get().caption, '已确认的素材说明')
})

test('project-scoped repair is bounded and failed writes roll back every identity and caption update', t => {
  const { db, add } = fixture(t)
  add('p1', 'one')
  add('p2', 'two')
  db.exec("CREATE TRIGGER reject_caption BEFORE UPDATE OF caption ON huasheng_material_assets BEGIN SELECT RAISE(ABORT,'fixture write failure'); END")
  assert.throws(() => repairHuashengMaterialDescriptions(db, { apply: true, projectId: 'p1' }), /fixture write failure/)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM huasheng_material_clips WHERE selected_asset_id<>''").get().n, 0)
  db.exec('DROP TRIGGER reject_caption')
  const report = repairHuashengMaterialDescriptions(db, { apply: true, projectId: 'p1' })
  assert.equal(report.clipsScanned, 1)
  assert.equal(report.identitiesRepaired, 1)
  assert.equal(db.prepare("SELECT selected_asset_id FROM huasheng_material_clips WHERE project_id='p2'").get().selected_asset_id, '')
})
