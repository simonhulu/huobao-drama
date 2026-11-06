import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import type { StoreHistorySourceInput } from './history-script-library.js'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-history-library-'))
process.env.DB_PATH = join(dbDir, 'test.db')
process.env.STORAGE_PATH = join(dbDir, 'static')

const { db, schema } = await import('../db/index.js')
const { storeHistorySource, storeHistoryArticleSource, getHistorySourceArtifactState, getHistorySourceWorkflowState, deleteHistorySource, getHistorySource, listHistorySources, updateHistorySource } = await import('./history-script-library.js')

function material(sourceId: number, filename: string) {
  const directory = join(process.env.STORAGE_PATH!, 'history-deliveries', String(sourceId))
  mkdirSync(directory,{recursive:true})
  writeFileSync(join(directory,filename),`validated ${filename}`)
  return `/static/history-deliveries/${sourceId}/${filename}`
}
function completedCovers(sourceId: number) {
  return JSON.stringify({'16:9':material(sourceId,'landscape.png'),'4:3':material(sourceId,'wide.png'),'3:4':material(sourceId,'portrait.png')})
}

beforeEach(() => {
  db.$client.exec(`DELETE FROM history_script_deliveries; DROP TABLE IF EXISTS history_huasheng_jobs;
    DROP TABLE IF EXISTS history_motion_productions; DROP TABLE IF EXISTS history_social_upload_jobs;
    DROP TABLE IF EXISTS history_social_upload_confirmations; DROP TABLE IF EXISTS history_video_deliveries;
    DROP TABLE IF EXISTS history_dual_production; DROP TABLE IF EXISTS history_video_packaging;`)
  db.delete(schema.historyScriptSources).run()
})

function input(overrides: Partial<StoreHistorySourceInput> = {}): StoreHistorySourceInput {
  return {
    sourceVideoId: '7395681234567890123',
    title: 'Local history',
    category: 'regional_history',
    selection: {
      reason: 'Viewers ask about the origin of a local landmark',
      observedAt: '2026-10-14T08:00:00Z',
      comments: [{ text: 'Where is the historical source?', likes: 12 }],
    },
    ...overrides,
  }
}

test('stores exact large video IDs, canonical URLs, browser evidence and unknown metric defaults', () => {
  const source = storeHistorySource(input({ title: '  Local history  ' }))
  assert.equal(source.sourceVideoId, '7395681234567890123')
  assert.equal(source.sourceUrl, 'https://www.douyin.com/video/7395681234567890123')
  assert.equal(source.platform, 'douyin')
  assert.equal(source.title, 'Local history')
  assert.equal(source.status, 'selected')
  assert.deepEqual(JSON.parse(source.metricsJson), {})
  assert.deepEqual(JSON.parse(source.selectionJson), input().selection)
  assert.equal(source.mediaJson, '{}')
  assert.equal(source.rawTranscript, null)
  assert.equal(getHistorySource(source.id)?.id, source.id)
})

test('database uniqueness enforces one source per platform and video', () => {
  const source = storeHistorySource(input())
  const { id: _id, ...values } = source
  assert.throws(() => db.insert(schema.historyScriptSources).values(values).run(), /UNIQUE constraint/)
  assert.equal(listHistorySources().total, 1)
})

test('rejects unsafe identity, empty title/category and missing or malformed browser evidence', () => {
  const invalidInputs = [
    input({ sourceVideoId: '7395e12' }),
    input({ sourceVideoId: '' }),
    { ...input(), sourceVideoId: 7395681234567890123 },
    input({ title: ' ' }),
    { ...input(), category: 'unknown' },
    input({ selection: undefined }),
    { ...input(), selection: { ...input().selection, reason: '' } },
    { ...input(), selection: { ...input().selection, observedAt: '2026-02-30T08:00:00Z' } },
    { ...input(), selection: { ...input().selection, comments: 'no comments' } },
    { ...input(), selection: { ...input().selection, comments: [{ text: 'A question', likes: -1 }] } },
  ]
  for (const invalid of invalidInputs) {
    assert.throws(() => storeHistorySource(invalid as StoreHistorySourceInput))
  }
  assert.equal(listHistorySources().total, 0)
})

test('rejects negative, nonfinite and nonnumeric engagement instead of fabricating counts', () => {
  for (const key of ['likes', 'comments', 'shares', 'collects']) {
    for (const value of [-1, NaN, Infinity, '12']) {
      assert.throws(() => storeHistorySource(input({ metrics: { [key]: value } } as Partial<StoreHistorySourceInput>)))
    }
  }
  const source = storeHistorySource(input({ metrics: { comments: 37 } }))
  assert.deepEqual(JSON.parse(source.metricsJson), { comments: 37 })
})

test('image notes retain canonical identity and require complete saved text and image provenance', () => {
  const source = storeHistorySource(input({ sourceType: 'note', sourceText: 'Full note caption', category: 'unclassified' }))
  assert.equal(source.sourceUrl, `https://www.douyin.com/note/${source.sourceVideoId}`)
  assert.equal(JSON.parse(source.mediaJson).caption, 'Full note caption')
  assert.equal(getHistorySourceArtifactState(source).transcript, 'missing')
  const media = { ...JSON.parse(source.mediaJson), images: [{ sha256: 'a'.repeat(64) }],
    textSha256: createHash('sha256').update('Caption and image text').digest('hex') }
  const completed = updateHistorySource(source.id, { rawTranscript: 'Caption and image text', mediaJson: JSON.stringify(media) })!
  assert.equal(getHistorySourceArtifactState(completed).transcript, 'current')
  assert.equal(completed.asrJson, null)
  for (const patch of [{ rawTranscript: 'Changed text' }, { sourceUrl: `https://www.douyin.com/video/${source.sourceVideoId}` },
    { mediaJson: JSON.stringify({ ...media, images: [] }) }, { mediaJson: JSON.stringify({ ...media, noteId: '1' }) }]) {
    assert.equal(getHistorySourceArtifactState({ ...completed, ...patch }).transcript, 'stale')
  }
  const duplicate = storeHistorySource(input({ sourceType: 'note', category: 'unclassified', sourceText: 'Changed caption' }))
  assert.equal(duplicate.id, source.id)
  assert.equal(duplicate.rawTranscript, completed.rawTranscript)
  assert.equal(duplicate.mediaJson, completed.mediaJson)
})

test('reselecting a video preserves generated artifacts, status, source identity and creation time', () => {
  const source = storeHistorySource(input({ authorName: 'History author', metrics: { comments: 37 } }))
  const generated = {
    status: 'needs_review',
    rawTranscript: 'raw script',
    correctedTranscript: 'corrected script',
    rewrittenScript: 'rewritten script',
    mediaJson: JSON.stringify({ videoPath: '/tmp/history.mp4' }),
    asrJson: JSON.stringify({ provider: 'minimax' }),
    reviewJson: JSON.stringify({ findings: ['verify the date'] }),
    lastError: 'Historical claim requires verification',
  }
  updateHistorySource(source.id, generated)
  const updated = storeHistorySource(input({
    title: 'New observed title',
    category: 'history_trivia',
    selection: { reason: 'More questions appeared', observedAt: '2026-10-14T09:00:00Z', comments: [] },
  }))
  assert.equal(updated.id, source.id)
  assert.equal(updated.sourceVideoId, source.sourceVideoId)
  assert.equal(updated.sourceUrl, source.sourceUrl)
  assert.equal(updated.createdAt, source.createdAt)
  assert.equal(updated.title, 'New observed title')
  assert.equal(updated.category, 'history_trivia')
  assert.equal(updated.authorName, 'History author')
  assert.deepEqual(JSON.parse(updated.metricsJson), { comments: 37 })
  assert.equal(JSON.parse(updated.selectionJson).reason, 'More questions appeared')
  for (const [key, value] of Object.entries(generated)) {
    assert.equal(updated[key as keyof typeof generated], value)
  }
  assert.equal(listHistorySources().total, 1)
})

test('updates protect identity and creation time at runtime and control their own updatedAt', () => {
  const source = storeHistorySource(input())
  for (const field of ['id', 'platform', 'sourceVideoId', 'sourceUrl', 'createdAt']) {
    assert.throws(() => updateHistorySource(source.id, { [field]: 'changed' }))
  }
  assert.throws(() => updateHistorySource(source.id, { metricsJson: '{"likes":-1}' }))
  assert.throws(() => updateHistorySource(source.id, { selectionJson: '{}' }))
  assert.throws(() => updateHistorySource(source.id, { asrJson: '{broken' }))
  const updated = updateHistorySource(source.id, { status: 'transcribed', updatedAt: '1900-01-01T00:00:00Z' })
  assert.equal(updated?.status, 'transcribed')
  assert.notEqual(updated?.updatedAt, '1900-01-01T00:00:00Z')
  assert.equal(updated?.createdAt, source.createdAt)
  assert.equal(updated?.sourceVideoId, source.sourceVideoId)
  assert.equal(updateHistorySource(999999, { status: 'failed' }), null)
  assert.equal(getHistorySource(999999), null)
  assert.equal(getHistorySource(NaN), null)
})

test('lists paginated sources and combines category, status, text and literal wildcard filters', () => {
  const first = storeHistorySource(input({ sourceVideoId: '1', title: 'Regional question' }))
  const second = storeHistorySource(input({ sourceVideoId: '2', title: 'Imperial anecdote', category: 'historical_anecdote' }))
  const third = storeHistorySource(input({ sourceVideoId: '3', title: '50% accurate', authorName: 'Field researcher' }))
  updateHistorySource(first.id, { status: 'needs_review', rewrittenScript: 'A landmark was repaired during the Ming dynasty.' })
  updateHistorySource(second.id, { status: 'needs_review' })
  assert.equal(listHistorySources().total, 3)
  const page = listHistorySources({ limit: 1, offset: 1 })
  assert.equal(page.items.length, 1)
  assert.equal(page.total, 3)
  assert.deepEqual(listHistorySources({ category: 'regional_history', status: 'needs_review', q: 'ming' }).items.map(row => row.id), [first.id])
  assert.deepEqual(listHistorySources({ q: 'researcher' }).items.map(row => row.id), [third.id])
  assert.deepEqual(listHistorySources({ q: '%' }).items.map(row => row.id), [third.id])
  assert.throws(() => listHistorySources({ limit: -1 }))
  assert.throws(() => listHistorySources({ offset: 0.5 }))
  db.update(schema.historyScriptSources).set({ category: 'history_trivia' }).where(eq(schema.historyScriptSources.id, third.id)).run()
  assert.equal(listHistorySources({ category: 'regional_history' }).total, 1)
})

test('caps result pages at 100 while retaining the matching total', () => {
  for (let id = 1; id <= 105; id++) storeHistorySource(input({ sourceVideoId: String(id) }))
  const page = listHistorySources({ limit: 1000 })
  assert.equal(page.items.length, 100)
  assert.equal(page.total, 105)
})

test('workflow filters combine before pagination and reflect actual outputs independently', () => {
  db.$client.exec(`CREATE TABLE history_huasheng_jobs(id INTEGER PRIMARY KEY, source_id INTEGER, production_status TEXT);
    CREATE TABLE history_motion_productions(id TEXT PRIMARY KEY, script_id INTEGER, status TEXT, updated_at TEXT, snapshot TEXT);`)
  const sources = Array.from({ length: 7 }, (_, index) => storeHistorySource(input({ sourceVideoId: String(index + 1) })))
  const [ready, noCover, noTitle, creating, motion, queuedMotion, emptyOutputs] = sources
  const delivery = db.$client.prepare(`INSERT INTO history_script_deliveries
    (script_id, title, design_status, cover_status, covers_json, updated_at) VALUES (?, ?, ?, ?, ?, '2026-10-25')`)
  delivery.run(ready.id, '标题方案', 'completed', 'completed', completedCovers(ready.id))
  delivery.run(noCover.id, '标题方案', 'completed', 'idle', '{}')
  delivery.run(noTitle.id, '', 'idle', 'completed', completedCovers(noTitle.id))
  delivery.run(emptyOutputs.id, '', 'completed', 'completed', '{}')
  for (const source of [ready,noCover,noTitle]) db.$client.prepare('UPDATE history_script_deliveries SET video_path=? WHERE script_id=?')
    .run(material(source.id,'finished.mp4'),source.id)
  const job = db.$client.prepare('INSERT INTO history_huasheng_jobs(source_id,production_status) VALUES (?,?)')
  for (const source of [ready, noCover, noTitle, creating]) job.run(source.id, 'completed')
  job.run(creating.id, 'creating') // A completed older task must not supersede the latest task.
  const motionJob = db.$client.prepare("INSERT INTO history_motion_productions VALUES(?,?,?,'2026-10-25',?)")
  motionJob.run('rendered', motion.id, 'needs_review', JSON.stringify({ stage: 'rendered', outputPath: '/movie.mp4' }))
  motionJob.run('queued', queuedMotion.id, 'queued', '{}')
  motionJob.run('failed', queuedMotion.id, 'failed', '{}')
  motionJob.run('empty', emptyOutputs.id, 'completed', '{}')

  const ids = (options: Parameters<typeof listHistorySources>[0]) => listHistorySources(options).items.map(item => item.id).sort((a, b) => a - b)
  assert.deepEqual(ids({ video: 'completed' }), [ready.id, noCover.id, noTitle.id])
  assert.deepEqual(ids({ video: 'not_completed' }), [creating.id, motion.id, queuedMotion.id, emptyOutputs.id])
  assert.deepEqual(ids({ titlePlan: 'generated' }), [ready.id, noCover.id])
  assert.deepEqual(ids({ cover: 'generated' }), [ready.id, noTitle.id])
  assert.deepEqual(ids({ motion: 'generated' }), [], 'a render without a delivered current edition remains unfinished')
  assert.deepEqual(ids({ video: 'completed', titlePlan: 'generated', cover: 'not_generated', motion: 'not_generated' }), [noCover.id])
  const page = listHistorySources({ video: 'completed', cover: 'generated', limit: 1, offset: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 1)
  assert.deepEqual(listHistorySources({ titlePlan: 'generated', cover: 'generated' }).items[0].workflowState, {
    videoCompleted: true, videoLinked: true, titlePlanGenerated: true, coverGenerated: true, motionGenerated: false,
    uploadState: 'not_uploaded', uploads: { 'baijiahao-video': 'not_uploaded' }, publicationCounts: { expected: 1, submitted: 0, published: 0 },
  })

  // A corrupt or partially saved cover record must not hide the item from the missing-cover filter.
  for (const value of ['not-json', JSON.stringify({ '16:9': 'one.png' }), JSON.stringify({ '16:9': 1, '4:3': 'b', '3:4': 'c' })]) {
    db.$client.prepare('UPDATE history_script_deliveries SET covers_json=? WHERE script_id=?').run(value, ready.id)
    assert.deepEqual(ids({ cover: 'generated' }), [noTitle.id])
  }
})

test('platform storyboard completion alone is not completed local video production', () => {
  db.$client.exec('CREATE TABLE history_huasheng_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,production_status TEXT)')
  const source = storeHistorySource(input())
  db.$client.prepare("INSERT INTO history_huasheng_jobs VALUES(1,?,'completed')").run(source.id)
  assert.equal(getHistorySourceWorkflowState(source.id).videoCompleted,false)
  assert.equal(listHistorySources({video:'completed'}).total,0)
})

test('missing local files and old shared packages cannot satisfy current output filters', () => {
  publicationTables();packagingTable()
  const source = updateHistorySource(storeHistorySource(input()).id,{rewrittenScript:'当前待交付正文'})!
  db.$client.prepare('INSERT INTO history_video_deliveries(script_id,script_sha256,producer,video_path) VALUES(?,?,?,?)')
    .run(source.id,scriptHash(source.rewrittenScript!),'motion',`/static/history-deliveries/${source.id}/missing.mp4`)
  assert.equal(getHistorySourceWorkflowState(source.id).videoCompleted,false)
  db.$client.prepare(`INSERT INTO history_script_deliveries(script_id,title,design_status,cover_status,covers_json,script_sha256,cover_script_sha256,updated_at)
    VALUES(?,'旧标题','completed','completed',?,?,?,'before')`).run(source.id,completedCovers(source.id),scriptHash('旧稿'),scriptHash('旧稿'))
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated,false)
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated,false)
})

test('workflow filters handle unused modules and recognize a manually linked finished video', () => {
  const source = storeHistorySource(input())
  assert.equal(listHistorySources({ video: 'completed' }).total, 0)
  assert.equal(listHistorySources({ video: 'not_completed', titlePlan: 'not_generated', cover: 'not_generated', motion: 'not_generated' }).total, 1)
  db.$client.prepare("INSERT INTO history_script_deliveries(script_id,video_path,updated_at) VALUES(?,?,'2026-10-25')").run(source.id,material(source.id,'movie.mp4'))
  assert.equal(listHistorySources({ video: 'completed' }).total, 1)
  assert.equal(listHistorySources({ motion: 'generated' }).total, 0)
  for (const key of ['video', 'titlePlan', 'cover', 'motion']) assert.throws(() => listHistorySources({ [key]: 'invalid' }))
})

test('old draft receipts and manual markers do not count as direct publication even before schema migration', () => {
  db.$client.exec(`CREATE TABLE history_huasheng_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,production_status TEXT);
    CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,target TEXT,status TEXT,result_json TEXT);
    CREATE TABLE history_social_upload_confirmations(source_id INTEGER,target TEXT,confirmed_at TEXT,PRIMARY KEY(source_id,target));`)
  const [none, partial, saved, manual, unfinished] = Array.from({ length: 5 }, (_, index) =>
    storeHistorySource(input({ sourceVideoId: String(index + 1) })))
  const produce = db.$client.prepare("INSERT INTO history_huasheng_jobs(source_id,production_status) VALUES(?,'completed')")
  for (const source of [none, partial, saved, manual]) produce.run(source.id)
  const job = db.$client.prepare('INSERT INTO history_social_upload_jobs(source_id,target,status,result_json) VALUES(?,?,?,?)')
  job.run(none.id, 'baijiahao-video', 'failed', '{"saved":false}')
  job.run(none.id, 'tencent-video', 'completed', '{"saved":false}')
  job.run(none.id, 'baijiahao-article', 'failed', 'invalid-json')
  job.run(partial.id, 'baijiahao-video', 'completed', '{"saved":true}')
  db.$client.prepare('INSERT INTO history_social_upload_confirmations VALUES(?,?,?)')
    .run(partial.id, 'baijiahao-video', '2026-10-25')
  for (const target of ['baijiahao-video', 'baijiahao-article', 'tencent-video']) {
    job.run(saved.id, target, 'completed', '{"saved":true}')
    job.run(saved.id, target, 'failed', '{"saved":false}')
    db.$client.prepare('INSERT INTO history_social_upload_confirmations VALUES(?,?,?)').run(manual.id, target, '2026-10-25')
  }
  const ids = (upload: 'not_uploaded' | 'partially_uploaded' | 'uploaded') =>
    listHistorySources({ upload }).items.map(row => row.id)
  assert.deepEqual(ids('not_uploaded').sort((a, b) => a - b), [none.id, partial.id, saved.id, manual.id, unfinished.id])
  assert.deepEqual(ids('partially_uploaded'), [])
  assert.deepEqual(ids('uploaded'), [])
  const page = listHistorySources({ video: 'completed', upload: 'uploaded', limit: 1, offset: 1 })
  assert.equal(page.total, 0)
  assert.equal(page.items.length, 0)
  const state = getHistorySourceWorkflowState(partial.id)
  assert.equal(state.uploads['baijiahao-video'], 'not_uploaded')
  assert.equal(state.uploads['tencent-video'], undefined)
  assert.equal(state.videoLinked, false)
  assert.equal(listHistorySources({ upload: 'not_uploaded' }).items.some(row => row.id === unfinished.id), true)
  assert.equal(getHistorySourceWorkflowState(manual.id).uploads['baijiahao-video'], 'not_uploaded')
  assert.throws(() => listHistorySources({ upload: 'invalid' } as never))
})

function publicationTables() {
  db.$client.exec(`CREATE TABLE history_video_deliveries(id INTEGER PRIMARY KEY,script_id INTEGER,script_sha256 TEXT,producer TEXT,video_path TEXT);
    CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,target TEXT,status TEXT,result_json TEXT,publication_mode TEXT,video_id INTEGER);
    CREATE TABLE history_dual_production(source_id INTEGER,script_sha256 TEXT);`)
}
const scriptHash = (text: string) => createHash('sha256').update(text).digest('hex')
function videoEdition(sourceId: number, body: string, producer = 'huasheng') {
  return Number(db.$client.prepare('INSERT INTO history_video_deliveries(script_id,script_sha256,producer,video_path) VALUES(?,?,?,?)')
    .run(sourceId, scriptHash(body), producer, material(sourceId,`${producer}.mp4`)).lastInsertRowid)
}
function packagingTable() {
  db.$client.exec(`CREATE TABLE history_video_packaging (
    video_id INTEGER PRIMARY KEY, script_id INTEGER NOT NULL, script_sha256 TEXT, cover_script_sha256 TEXT,
    title TEXT NOT NULL DEFAULT '', design_status TEXT NOT NULL DEFAULT 'idle', cover_status TEXT NOT NULL DEFAULT 'idle',
    covers_json TEXT NOT NULL DEFAULT '{}'
  )`)
}
function packageEdition(sourceId: number, videoId: number, body: string, covers = true) {
  db.$client.prepare(`INSERT INTO history_video_packaging
    (video_id,script_id,script_sha256,cover_script_sha256,title,design_status,cover_status,covers_json)
    VALUES(?,?,?,?,?,'completed',?,?)`).run(videoId,sourceId,scriptHash(body),scriptHash(body),`成片${videoId}独立标题`,
      covers ? 'completed' : 'idle', covers ? completedCovers(sourceId) : '{}')
}
function publicationReceipt(sourceId: number, videoId: number, published = false, overrides: Record<string, unknown> = {}) {
  return Number(db.$client.prepare(`INSERT INTO history_social_upload_jobs(source_id,target,status,result_json,publication_mode,video_id)
    VALUES(?,'baijiahao-video','completed',?,'publish',?)`).run(sourceId, JSON.stringify({ staged: true, saved: false, submitted: true,
      targetId:'original-editor',editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',
      published, publicationStatus: published ? 'published' : 'submitted', articleId: '1879511407398993709',
      publishedUrl: 'https://baijiahao.baidu.com/s?id=1879511407398993709', ...overrides }), videoId).lastInsertRowid)
}

test('edition packaging waits for both expected productions and never substitutes a shared title or cover', () => {
  publicationTables()
  packagingTable()
  const source = updateHistorySource(storeHistorySource(input()).id, { rewrittenScript: '两版都需要独立包装的当前正文' })!
  const body = source.rewrittenScript!
  db.$client.prepare('INSERT INTO history_dual_production VALUES(?,?)').run(source.id, scriptHash(body))
  db.$client.prepare(`INSERT INTO history_script_deliveries
    (script_id,title,design_status,cover_status,covers_json,updated_at) VALUES(?,'旧共享标题','completed','completed',?,'2026-10-31')`)
    .run(source.id, completedCovers(source.id))
  const huasheng = videoEdition(source.id, body)
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated, false, 'Shared metadata is not a video package')
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, false)
  packageEdition(source.id, huasheng, body)
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated, false, 'The pending second render still requires its own title')
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, false)
  const motion = videoEdition(source.id, body, 'motion')
  packageEdition(source.id, motion, body, false)
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated, true)
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, false, 'One edition without cover files keeps the aggregate incomplete')
  db.$client.prepare("UPDATE history_video_packaging SET cover_status='completed',covers_json=? WHERE video_id=?")
    .run(completedCovers(source.id), motion)
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, true)
})

test('packaging state and SQL filters count only current edition packages before pagination', () => {
  publicationTables()
  packagingTable()
  const sources = ['完整甲', '完整乙', '仅一版完整', '只完成标题'].map((title, index) =>
    updateHistorySource(storeHistorySource(input({ sourceVideoId: String(index + 1), title })).id,
      { rewrittenScript: `当前正文${index}` })!)
  for (const [index, source] of sources.entries()) {
    const flower = videoEdition(source.id, source.rewrittenScript!)
    const motion = videoEdition(source.id, source.rewrittenScript!, 'motion')
    packageEdition(source.id, flower, source.rewrittenScript!, index !== 3)
    if (index !== 2) packageEdition(source.id, motion, source.rewrittenScript!, index !== 3)
  }
  const generated = listHistorySources({ titlePlan: 'generated', cover: 'generated', limit: 1, offset: 1 })
  assert.equal(generated.total, 2)
  assert.equal(generated.items.length, 1)
  assert.ok(generated.items[0]!.workflowState.titlePlanGenerated)
  assert.ok(generated.items[0]!.workflowState.coverGenerated)
  const ids = (options: Parameters<typeof listHistorySources>[0]) => listHistorySources(options).items.map(row => row.id).sort((a,b) => a-b)
  assert.deepEqual(ids({ titlePlan: 'generated' }), [sources[0]!.id, sources[1]!.id, sources[3]!.id])
  assert.deepEqual(ids({ cover: 'generated' }), [sources[0]!.id, sources[1]!.id])
  assert.deepEqual(ids({ titlePlan: 'not_generated', cover: 'not_generated' }), [sources[2]!.id])
})

test('superseded and old-manuscript video packages cannot satisfy title or cover completion', () => {
  publicationTables()
  packagingTable()
  const source = updateHistorySource(storeHistorySource(input()).id, { rewrittenScript: '当前正文' })!
  const old = videoEdition(source.id, '当前正文', 'motion')
  packageEdition(source.id, old, '当前正文')
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated, true)
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, true)
  const latest = videoEdition(source.id, '当前正文', 'motion')
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated, false)
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, false)
  packageEdition(source.id, latest, '错误正文')
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated, false)
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, false)
  db.$client.prepare('UPDATE history_video_packaging SET script_sha256=?,cover_script_sha256=? WHERE video_id=?')
    .run(scriptHash('当前正文'), scriptHash('当前正文'), latest)
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated, true)
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, true)
  for (const value of ['invalid-json', '{"16:9":"one.png"}', '{"16:9":1,"4:3":"wide.png","3:4":"portrait.png"}']) {
    db.$client.prepare('UPDATE history_video_packaging SET covers_json=? WHERE video_id=?').run(value, latest)
    assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, false)
    assert.equal(listHistorySources({ cover: 'generated' }).total, 0)
  }
  db.$client.prepare(`INSERT INTO history_script_deliveries
    (script_id,title,design_status,cover_status,covers_json,updated_at) VALUES(?,'旧共享标题','completed','completed',?,'2026-10-31')`)
    .run(source.id, completedCovers(source.id))
  updateHistorySource(source.id, { rewrittenScript: '更新后的正文' })
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated, false)
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, false)
})

test('packaging aggregation honors motion backfill and retains legacy rows without concrete videos', () => {
  publicationTables()
  packagingTable()
  db.$client.exec("ALTER TABLE history_dual_production ADD COLUMN production_mode TEXT NOT NULL DEFAULT 'dual'")
  const legacy = storeHistorySource(input({ sourceVideoId: '1' }))
  db.$client.prepare(`INSERT INTO history_script_deliveries
    (script_id,title,design_status,cover_status,covers_json,updated_at) VALUES(?,'历史标题','completed','completed',?,'2026-10-31')`)
    .run(legacy.id, completedCovers(legacy.id))
  const source = updateHistorySource(storeHistorySource(input({ sourceVideoId: '2' })).id, { rewrittenScript: '历史补做正文' })!
  db.$client.prepare("INSERT INTO history_dual_production VALUES(?,?,'motion_backfill')").run(source.id, scriptHash(source.rewrittenScript!))
  videoEdition(source.id, source.rewrittenScript!)
  const motion = videoEdition(source.id, source.rewrittenScript!, 'motion')
  packageEdition(source.id, motion, source.rewrittenScript!)
  assert.equal(getHistorySourceWorkflowState(source.id).titlePlanGenerated, true, 'Backfill does not require a new Huasheng title')
  assert.equal(getHistorySourceWorkflowState(source.id).coverGenerated, true)
  assert.equal(getHistorySourceWorkflowState(legacy.id).titlePlanGenerated, true)
  assert.equal(getHistorySourceWorkflowState(legacy.id).coverGenerated, true)
  assert.equal(listHistorySources({ titlePlan: 'generated', cover: 'generated' }).total, 2)
})

test('current producer editions aggregate independently and distinguish submitted from published before pagination', () => {
  publicationTables()
  const [none, partial, submitted, published] = ['none', 'partial', 'submitted', 'published'].map((title, index) => {
    const source = storeHistorySource(input({ sourceVideoId: String(index + 1), title }))
    return updateHistorySource(source.id, { rewrittenScript: `当前正文${index}` })!
  })
  for (const source of [none, partial, submitted, published]) {
    const flower = videoEdition(source.id, source.rewrittenScript!, 'huasheng')
    const motion = videoEdition(source.id, source.rewrittenScript!, 'motion')
    if (source !== none) publicationReceipt(source.id, flower, source === published || source === partial)
    if (source === submitted || source === published) publicationReceipt(source.id, motion, source === published)
  }
  assert.deepEqual(getHistorySourceWorkflowState(partial.id).publicationCounts, { expected: 2, submitted: 1, published: 1 })
  assert.equal(getHistorySourceWorkflowState(partial.id).uploadState, 'partially_uploaded')
  assert.equal(getHistorySourceWorkflowState(partial.id).uploads['baijiahao-video'], 'submitted')
  assert.deepEqual(getHistorySourceWorkflowState(submitted.id).publicationCounts, { expected: 2, submitted: 2, published: 0 })
  assert.equal(getHistorySourceWorkflowState(submitted.id).uploads['baijiahao-video'], 'submitted')
  assert.equal(getHistorySourceWorkflowState(published.id).uploads['baijiahao-video'], 'published')
  assert.deepEqual(getHistorySourceWorkflowState(published.id).publicationCounts, { expected: 2, submitted: 2, published: 2 })
  assert.deepEqual(listHistorySources({ upload: 'not_uploaded' }).items.map(source => source.id), [none.id])
  assert.deepEqual(listHistorySources({ upload: 'partially_uploaded' }).items.map(source => source.id), [partial.id])
  const page = listHistorySources({ upload: 'uploaded', limit: 1, offset: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 1)
  assert.equal(getHistorySourceWorkflowState(partial.id).videoLinked, true)
  assert.equal(getHistorySourceWorkflowState(partial.id).motionGenerated, true)
})

test('a dual production remains partial after its first edition publishes and awaiting the other render', () => {
  publicationTables()
  const source = updateHistorySource(storeHistorySource(input()).id, { rewrittenScript: '两版共用正文' })!
  db.$client.prepare('INSERT INTO history_dual_production VALUES(?,?)').run(source.id, scriptHash(source.rewrittenScript!))
  assert.deepEqual(getHistorySourceWorkflowState(source.id).publicationCounts, { expected: 2, submitted: 0, published: 0 })
  const first = videoEdition(source.id, source.rewrittenScript!)
  publicationReceipt(source.id, first, true)
  assert.equal(getHistorySourceWorkflowState(source.id).uploadState, 'partially_uploaded')
  assert.deepEqual(getHistorySourceWorkflowState(source.id).publicationCounts, { expected: 2, submitted: 1, published: 1 })
  const second = videoEdition(source.id, source.rewrittenScript!, 'motion')
  publicationReceipt(source.id, second)
  assert.equal(getHistorySourceWorkflowState(source.id).uploadState, 'uploaded')
  assert.equal(getHistorySourceWorkflowState(source.id).uploads['baijiahao-video'], 'submitted')
})

test('motion backfill counts only its refined publication while retaining the old Huasheng output', () => {
  publicationTables()
  db.$client.exec("ALTER TABLE history_dual_production ADD COLUMN production_mode TEXT NOT NULL DEFAULT 'dual'")
  const source = updateHistorySource(storeHistorySource(input()).id, { rewrittenScript: '已完成花生的原稿' })!
  db.$client.prepare("INSERT INTO history_dual_production VALUES(?,?,'motion_backfill')").run(source.id, scriptHash(source.rewrittenScript!))
  const flower = videoEdition(source.id, source.rewrittenScript!)
  publicationReceipt(source.id, flower, true)
  assert.deepEqual(getHistorySourceWorkflowState(source.id).publicationCounts, { expected: 1, submitted: 0, published: 0 })
  assert.equal(getHistorySourceWorkflowState(source.id).uploadState, 'not_uploaded')
  const motion = videoEdition(source.id, source.rewrittenScript!, 'motion')
  publicationReceipt(source.id, motion)
  assert.deepEqual(getHistorySourceWorkflowState(source.id).publicationCounts, { expected: 1, submitted: 1, published: 0 })
  assert.equal(getHistorySourceWorkflowState(source.id).uploadState, 'uploaded')
  publicationReceipt(source.id, motion, true)
  assert.equal(getHistorySourceWorkflowState(source.id).uploads['baijiahao-video'], 'published')
  assert.equal(listHistorySources({ upload: 'uploaded' }).total, 1)
  videoEdition(source.id, source.rewrittenScript!, 'motion')
  assert.deepEqual(getHistorySourceWorkflowState(source.id).publicationCounts, { expected: 1, submitted: 0, published: 0 })
})

test('dual production requires only its two producers while standalone work counts actual editions', () => {
  publicationTables()
  packagingTable()
  const dual = updateHistorySource(storeHistorySource(input({ sourceVideoId: '1' })).id,{rewrittenScript:'双版正文'})!
  const standalone = updateHistorySource(storeHistorySource(input({ sourceVideoId: '2' })).id,{rewrittenScript:'独立正文'})!
  db.$client.prepare('INSERT INTO history_dual_production VALUES(?,?)').run(dual.id,scriptHash(dual.rewrittenScript!))
  for (const source of [dual,standalone]) {
    for (const producer of ['huasheng','motion','manual']) {
      const video = videoEdition(source.id,source.rewrittenScript!,producer)
      if (producer !== 'manual') {
        packageEdition(source.id,video,source.rewrittenScript!)
        publicationReceipt(source.id,video)
      }
    }
  }
  assert.deepEqual(getHistorySourceWorkflowState(dual.id).publicationCounts,{expected:2,submitted:2,published:0})
  assert.equal(getHistorySourceWorkflowState(dual.id).uploadState,'uploaded')
  assert.equal(getHistorySourceWorkflowState(dual.id).titlePlanGenerated,true)
  assert.equal(getHistorySourceWorkflowState(dual.id).coverGenerated,true)
  assert.deepEqual(getHistorySourceWorkflowState(standalone.id).publicationCounts,{expected:3,submitted:2,published:0})
  assert.equal(getHistorySourceWorkflowState(standalone.id).uploadState,'partially_uploaded')
  assert.deepEqual(listHistorySources({upload:'uploaded'}).items.map(item=>item.id),[dual.id])
})

test('same-file legacy publish receipts count while foreign paths, drafts and invalid receipts cannot qualify', () => {
  publicationTables()
  db.$client.exec('ALTER TABLE history_social_upload_jobs ADD COLUMN payload_json TEXT')
  const source = updateHistorySource(storeHistorySource(input()).id,{rewrittenScript:'当前成片正文'})!
  const video = videoEdition(source.id,source.rewrittenScript!,'motion')
  const result = db.$client.prepare('SELECT video_path FROM history_video_deliveries WHERE id=?').get(video) as {video_path:string}
  const filename = resolve(process.env.STORAGE_PATH!,result.video_path.replace('/static/',''))
  const legacy = publicationReceipt(source.id,video,true)
  db.$client.prepare('UPDATE history_social_upload_jobs SET video_id=NULL,payload_json=? WHERE id=?')
    .run(JSON.stringify({videoPath:filename}),legacy)
  assert.deepEqual(getHistorySourceWorkflowState(source.id).publicationCounts,{expected:1,submitted:1,published:1})
  assert.equal(getHistorySourceWorkflowState(source.id).uploadState,'uploaded')
  assert.equal(listHistorySources({upload:'uploaded'}).total,1)
  for (const value of ['invalid-json', '{}', JSON.stringify({videoPath:filename+'.other'}),JSON.stringify({videoPath:1})]) {
    db.$client.prepare('UPDATE history_social_upload_jobs SET payload_json=? WHERE id=?').run(value,legacy)
    assert.equal(getHistorySourceWorkflowState(source.id).uploadState,'not_uploaded')
  }
  db.$client.prepare("UPDATE history_social_upload_jobs SET payload_json=?,publication_mode='draft' WHERE id=?")
    .run(JSON.stringify({videoPath:filename}),legacy)
  assert.equal(getHistorySourceWorkflowState(source.id).uploadState,'not_uploaded')
  db.$client.prepare("UPDATE history_social_upload_jobs SET publication_mode='publish',result_json=? WHERE id=?")
    .run(JSON.stringify({submitted:true,saved:false,published:true,publicationStatus:'published'}),legacy)
  assert.equal(getHistorySourceWorkflowState(source.id).uploadState,'not_uploaded')
})

test('new manuscripts and rerendered editions cannot inherit old video or publication completion', () => {
  publicationTables()
  db.$client.exec(`CREATE TABLE history_huasheng_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,production_status TEXT,script_sha256 TEXT);
    CREATE TABLE history_motion_productions(id TEXT PRIMARY KEY,script_id INTEGER,status TEXT,updated_at TEXT,snapshot TEXT);`)
  const source = updateHistorySource(storeHistorySource(input()).id, { rewrittenScript: '旧正文' })!
  const old = videoEdition(source.id, '旧正文')
  publicationReceipt(source.id, old, true)
  db.$client.prepare('INSERT INTO history_dual_production VALUES(?,?)').run(source.id, scriptHash('旧正文'))
  db.$client.prepare("INSERT INTO history_huasheng_jobs(source_id,production_status,script_sha256) VALUES(?,'completed',?)").run(source.id, scriptHash('旧正文'))
  db.$client.prepare("INSERT INTO history_motion_productions VALUES('old',?,'completed','2026-10-28',?)")
    .run(source.id, JSON.stringify({ stage: 'rendered', outputPath: '/old.mp4', script: '旧正文', factory: { scriptHash: scriptHash('旧正文') } }))
  db.$client.prepare("INSERT INTO history_script_deliveries(script_id,video_path,script_sha256,updated_at) VALUES(?,'/old.mp4',?,'2026-10-28')")
    .run(source.id, scriptHash('旧正文'))
  updateHistorySource(source.id, { rewrittenScript: '新正文' })
  const stale = getHistorySourceWorkflowState(source.id)
  assert.equal(stale.videoCompleted, false)
  assert.equal(stale.videoLinked, false)
  assert.equal(stale.motionGenerated, false)
  assert.equal(stale.uploadState, 'not_uploaded')
  assert.deepEqual(stale.publicationCounts, { expected: 0, submitted: 0, published: 0 })
  const first = videoEdition(source.id, '新正文')
  publicationReceipt(source.id, first, true)
  assert.equal(getHistorySourceWorkflowState(source.id).uploads['baijiahao-video'], 'published')
  const second = videoEdition(source.id, '新正文')
  assert.equal(getHistorySourceWorkflowState(source.id).uploadState, 'not_uploaded', 'the latest render needs its own receipt')
  publicationReceipt(source.id, second)
  publicationReceipt(source.id, second)
  assert.deepEqual(getHistorySourceWorkflowState(source.id).publicationCounts, { expected: 1, submitted: 1, published: 0 }, 'retries cannot double-count one edition')
})

test('only a completed publish-mode receipt bound to the same source and video counts', () => {
  publicationTables()
  const source = updateHistorySource(storeHistorySource(input()).id, { rewrittenScript: '当前正文' })!
  const video = videoEdition(source.id, source.rewrittenScript!)
  for (const patch of [{ saved: true }, { submitted: false }, { publicationStatus: 'published', published: false },
    { articleId: '' }, { articleId: 'abc' }, { published: true }, { submitted: 1 }]) publicationReceipt(source.id, video, false, patch)
  const draft = publicationReceipt(source.id, video)
  db.$client.prepare("UPDATE history_social_upload_jobs SET publication_mode='draft' WHERE id=?").run(draft)
  const failed = publicationReceipt(source.id, video)
  db.$client.prepare("UPDATE history_social_upload_jobs SET status='failed' WHERE id=?").run(failed)
  publicationReceipt(source.id + 1, video)
  db.$client.prepare("INSERT INTO history_social_upload_jobs(source_id,target,status,result_json,publication_mode,video_id) VALUES(?,'baijiahao-video','completed','invalid-json','publish',?)")
    .run(source.id, video)
  assert.deepEqual(getHistorySourceWorkflowState(source.id).publicationCounts, { expected: 1, submitted: 0, published: 0 })
  publicationReceipt(source.id, video)
  assert.equal(getHistorySourceWorkflowState(source.id).uploadState, 'uploaded')
})

test('edition-aware reads tolerate legacy upload tables without publication_mode or video_id', () => {
  publicationTables()
  db.$client.exec(`DROP TABLE history_social_upload_jobs;
    CREATE TABLE history_social_upload_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,target TEXT,status TEXT,result_json TEXT);`)
  const source = updateHistorySource(storeHistorySource(input()).id, { rewrittenScript: '当前正文' })!
  videoEdition(source.id, source.rewrittenScript!)
  db.$client.prepare("INSERT INTO history_social_upload_jobs(source_id,target,status,result_json) VALUES(?,'baijiahao-video','completed',?)")
    .run(source.id, JSON.stringify({ saved: true }))
  assert.deepEqual(getHistorySourceWorkflowState(source.id).publicationCounts, { expected: 1, submitted: 0, published: 0 })
  assert.equal(listHistorySources({ upload: 'uploaded' }).total, 0)
})

function article() {
  return {
    articleId: '1879511407398993709', sourceUrl: 'https://baijiahao.baidu.com/s?id=1879511407398993709',
    title: '历史文章', authorName: '作者', text: '第一段保留完整原文。\n\n第二段保留原有论述。', fetchedAt: '2026-10-21T08:00:00Z',
    metadata: { gid: '15971646304123075887', platform: '百家号', category: '历史', publishTime: '2026-10-20 15:53', keywords: ['明朝'], reads: 3793, likes: 18, comments: 6, fans: 8 },
  }
}

test('stores article originals with provenance and no invented ASR, correction or rewrite', () => {
  const value = article()
  const source = storeHistoryArticleSource(value)
  assert.equal(source.platform, 'baijiahao')
  assert.equal(source.category, 'unclassified')
  assert.equal(source.sourceVideoId, value.articleId)
  assert.equal(source.rawTranscript, value.text)
  assert.equal(source.status, 'article_saved')
  assert.equal(source.asrJson, null)
  assert.equal(source.correctedTranscript, null)
  assert.equal(source.rewrittenScript, null)
  assert.deepEqual(getHistorySourceArtifactState(source), { transcript: 'current', corrected: 'missing', rewritten: 'missing' })
  assert.equal(JSON.parse(source.mediaJson).kind, 'article')
  assert.equal(JSON.parse(source.selectionJson).gid, value.metadata.gid)
  assert.equal(listHistorySources({ category: 'unclassified' }).total, 1)
  // Equal numeric IDs on different platforms are distinct identities.
  storeHistorySource(input({ sourceVideoId: value.articleId }))
  assert.equal(listHistorySources().total, 2)
})

test('article provenance rejects changed text, URL, ID and missing hashes', () => {
  const source = storeHistoryArticleSource(article())
  for (const changed of [
    { ...source, rawTranscript: `${source.rawTranscript}改动` },
    { ...source, sourceUrl: 'https://baijiahao.baidu.com/s?id=999' },
    { ...source, sourceVideoId: '999' },
    { ...source, platform: 'douyin' },
    { ...source, mediaJson: JSON.stringify({ ...JSON.parse(source.mediaJson), textSha256: undefined }) },
  ]) assert.equal(getHistorySourceArtifactState(changed).transcript, 'stale')
  assert.throws(() => storeHistoryArticleSource({ ...article(), sourceUrl: 'http://127.0.0.1/' }))
  assert.throws(() => storeHistoryArticleSource({ ...article(), text: ' ' }))
  assert.throws(() => storeHistoryArticleSource({ ...article(), metadata: { ...article().metadata, likes: -1 } }))
})

test('duplicate article imports preserve processed and deleted originals exactly', () => {
  const source = storeHistoryArticleSource(article())
  const reviewed = updateHistorySource(source.id, { status: 'needs_review', correctedTranscript: '人工校对稿' })!
  assert.deepEqual(storeHistoryArticleSource({ ...article(), text: '新版原文', title: '新版标题' }), reviewed)
  const deleted = deleteHistorySource(source.id)!
  assert.deepEqual(storeHistoryArticleSource(article()), deleted)
  assert.equal(getHistorySource(source.id), null)
})
