import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { ensureHistoryVideoDeliveriesSchema, recordHistoryVideoDelivery } from './history-video-deliveries.js'
import { hasRecentHistoryYoutubeProduction, prepareHistoryYoutubeRecollection, HISTORY_YOUTUBE_PRODUCTION_WINDOW_MS } from './history-youtube-recollection.js'

const now = Date.parse('2026-11-02T10:00:00Z')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture() {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE history_script_sources (
    id INTEGER PRIMARY KEY,platform TEXT,source_video_id TEXT,rewritten_script TEXT,raw_transcript TEXT,
    corrected_transcript TEXT,review_json TEXT,deleted_at TEXT,status TEXT,last_error TEXT,updated_at TEXT
  )`)
  database.prepare(`INSERT INTO history_script_sources VALUES(1,'youtube','VprFAzjTTuM',?,?,?,?,'2026-10-01','failed','old error',?)`)
    .run('Old draft', 'Original transcript', 'Corrected transcript', JSON.stringify({rawTranscriptSha256: hash('Original transcript'),
      correctedTranscriptSha256: hash('Corrected transcript'), rewriteInputSha256: hash('Corrected transcript'),
      recreationPlan: {old: true}, recreation: {old: true}, huashengQueue: {status: 'pending'}}), new Date(now).toISOString())
  ensureHistoryVideoDeliveriesSchema(database)
  const delivery = (age: number, producer: 'motion' | 'huasheng' = 'motion', producerJobId = 'old-job') => {
    const video = recordHistoryVideoDelivery(database, {scriptId: 1, scriptSha256: hash('Old draft'), producer, producerJobId,
      videoUrl: '/static/released.mp4', videoName: 'released.mp4', duration: 60, sha256: hash(producerJobId)})
    database.prepare('UPDATE history_video_deliveries SET created_at=? WHERE id=?').run(new Date(now - age).toISOString(), video.id)
    return video
  }
  return {database, delivery}
}

test('the fifteen-day boundary uses only successful delivery dates and excludes future timestamps', () => {
  const {database, delivery} = fixture()
  try {
    assert.equal(hasRecentHistoryYoutubeProduction(database, 'VprFAzjTTuM', now), false)
    const video = delivery(HISTORY_YOUTUBE_PRODUCTION_WINDOW_MS)
    assert.equal(hasRecentHistoryYoutubeProduction(database, 'VprFAzjTTuM', now), true)
    assert.equal(hasRecentHistoryYoutubeProduction(database, 'VprFAzjTTuM', now + 1), false)
    database.prepare('UPDATE history_script_sources SET updated_at=?').run(new Date(now + 1000).toISOString())
    assert.equal(hasRecentHistoryYoutubeProduction(database, 'VprFAzjTTuM', now + 1), false)
    database.prepare('UPDATE history_video_deliveries SET created_at=? WHERE id=?').run(new Date(now + 1).toISOString(), video.id)
    assert.equal(hasRecentHistoryYoutubeProduction(database, 'VprFAzjTTuM', now), false)
  } finally {database.close()}
})

test('recent delivered media remains deduplicated after deletion and reclamation without restoring the source', () => {
  const {database, delivery} = fixture()
  try {
    delivery(86400000)
    const before = database.prepare('SELECT * FROM history_script_sources').get()
    assert.deepEqual(prepareHistoryYoutubeRecollection(database, 1, 123, now), {recent: true, renewed: false, busy: null})
    assert.deepEqual(database.prepare('SELECT * FROM history_script_sources').get(), before)
  } finally {database.close()}
})

test('expired production creates one writing cycle and retains original text and delivery identities', () => {
  const {database, delivery} = fixture()
  try {
    const video = delivery(16 * 86400000)
    assert.deepEqual(prepareHistoryYoutubeRecollection(database, 1, 123, now), {recent: false, renewed: true, busy: null})
    const source = database.prepare('SELECT * FROM history_script_sources').get() as Record<string, any>
    assert.equal(source.deleted_at, null)
    assert.equal(source.rewritten_script, null)
    assert.equal(source.raw_transcript, 'Original transcript')
    assert.equal(source.corrected_transcript, 'Corrected transcript')
    const review = JSON.parse(source.review_json)
    assert.equal(review.recreationPlan, undefined)
    assert.equal(review.huashengQueue, undefined)
    assert.equal(review.rawTranscriptSha256, hash(source.raw_transcript))
    assert.equal(review.youtubeRecollection.previousScriptSha256, hash('Old draft'))
    const cycle = database.prepare('SELECT * FROM history_youtube_collection_cycles').get() as Record<string, any>
    assert.equal(JSON.parse(cycle.source_snapshot_json).rewritten_script, 'Old draft')
    database.prepare('UPDATE history_script_sources SET rewritten_script=?').run('Old draft')
    assert.equal(prepareHistoryYoutubeRecollection(database, 1, 123, now).renewed, false)
    assert.equal((database.prepare('SELECT count(*) AS n FROM history_youtube_collection_cycles').get() as {n: number}).n, 1)
    assert.equal((database.prepare('SELECT id FROM history_video_deliveries').get() as {id: number}).id, video.id)
  } finally {database.close()}
})

test('a newer unproduced draft is reused even if a prior draft was produced more than fifteen days ago', () => {
  const {database, delivery} = fixture()
  try {
    delivery(16 * 86400000)
    database.prepare('UPDATE history_script_sources SET rewritten_script=?').run('New unfinished draft')
    assert.equal(prepareHistoryYoutubeRecollection(database, 1, 123, now).renewed, false)
    assert.equal((database.prepare('SELECT rewritten_script FROM history_script_sources').get() as {rewritten_script: string}).rewritten_script, 'New unfinished draft')
  } finally {database.close()}
})

for (const activity of ['motion', 'huasheng', 'export', 'unknown-upload', 'legacy-upload', 'packaging', 'continuation']) {
  test(`an expired source joins ${activity} work without changing its draft or paid checkpoints`, () => {
    const {database, delivery} = fixture()
    try {
      delivery(16 * 86400000)
      const definitions: Record<string, string> = {
        motion: `CREATE TABLE history_motion_productions(script_id INTEGER,status TEXT,snapshot TEXT);
          INSERT INTO history_motion_productions VALUES(1,'selecting','{"status":"selecting"}')`,
        huasheng: `CREATE TABLE history_huasheng_jobs(id INTEGER,source_id INTEGER,status TEXT,project_url TEXT,stage TEXT,checkpoint TEXT);
          INSERT INTO history_huasheng_jobs VALUES(1,1,'failed',NULL,'create_pending','create_pending')`,
        export: `CREATE TABLE history_huasheng_export_jobs(source_id INTEGER,status TEXT);
          INSERT INTO history_huasheng_export_jobs VALUES(1,'running')`,
        'unknown-upload': `CREATE TABLE history_social_upload_jobs(source_id INTEGER,status TEXT,upload_dispatched INTEGER,result_json TEXT,operation TEXT);
          INSERT INTO history_social_upload_jobs VALUES(1,'uncertain',1,NULL,NULL)`,
        'legacy-upload': `CREATE TABLE history_social_upload_jobs(source_id INTEGER,status TEXT,upload_dispatched INTEGER,result_json TEXT,operation TEXT);
          INSERT INTO history_social_upload_jobs VALUES(1,'canceled',0,'{"submitted":true}',NULL)`,
        packaging: `CREATE TABLE history_video_packaging(script_id INTEGER,design_status TEXT,cover_status TEXT);
          INSERT INTO history_video_packaging VALUES(1,'generating','not_started')`,
        continuation: `CREATE TABLE creation_tasks(type TEXT,scope_id INTEGER,status TEXT);
          INSERT INTO creation_tasks VALUES('history.production.continue',1,'queued')`,
      }
      database.exec(definitions[activity]!)
      const result = prepareHistoryYoutubeRecollection(database, 1, 123, now)
      assert.equal(result.renewed, false)
      assert.ok(result.busy)
      assert.equal((database.prepare('SELECT rewritten_script FROM history_script_sources').get() as {rewritten_script: string}).rewritten_script, 'Old draft')
    } finally {database.close()}
  })
}
