import test, {after, beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {HistoryContinuousOptions, HistoryContinuousScope} from './history-continuous-production.js'
import type {HistoryContinuousRuntimeDependencies} from './history-continuous-runtime.js'
import type {HistoryProductionState, HistoryProductionVersion} from './history-production-state.js'
import type {HuashengJob} from './history-huasheng.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-continuous-runtime-'))
process.env.DB_PATH = path.join(root, 'test.db')
process.env.STORAGE_PATH = root
for (const flag of ['TASK_WORKER_DISABLED', 'HISTORY_HUASHENG_WORKER_DISABLED', 'HISTORY_SOCIAL_UPLOAD_WORKER_DISABLED',
  'HISTORY_HUASHENG_EXPORT_WORKER_DISABLED', 'HISTORY_ARTICLE_WORKER_DISABLED']) process.env[flag] = '1'
const {db, schema} = await import('../db/index.js')
const {updateHistorySource, deleteHistorySource, getHistorySource} = await import('./history-script-library.js')
const {storeHistoryYoutubeSource} = await import('./history-source-youtube.js')
const {historyProductionSourceRevision} = await import('./history-production-continuation.js')
const {ensureHistoryDualProductionSchema, recordHistoryDualProduction, recordHistoryVideoDelivery,
  ensureHistoryVideoPublicationSchema, recordHistoryVideoPublication} = await import('./history-video-deliveries.js')
const {ensureHistorySocialUploadSchema} = await import('./history-social-upload.js')
const {createHistoryContinuousProduction} = await import('./history-continuous-production.js')
const {createHistoryContinuousRuntime} = await import('./history-continuous-runtime.js')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
let serial = 0
ensureHistoryDualProductionSchema(db.$client)
ensureHistoryVideoPublicationSchema(db.$client)
ensureHistorySocialUploadSchema(db.$client)
db.$client.exec(`CREATE TABLE IF NOT EXISTS history_huasheng_export_jobs (
  id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,huasheng_job_id INTEGER,status TEXT)`)

beforeEach(() => {
  for (const table of ['history_continuous_members', 'history_continuous_collections', 'history_continuous_production',
    'history_social_upload_jobs', 'history_video_publication_intents', 'history_video_deliveries', 'history_dual_production',
    'history_huasheng_export_jobs']) {
    if (db.$client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.$client.exec(`DELETE FROM ${table}`)
  }
  db.delete(schema.creationTaskEvents).run()
  db.delete(schema.creationTasks).run()
  db.delete(schema.historyScriptSources).run()
})
after(() => {db.$client.close(); fs.rmSync(root, {recursive: true, force: true})})

function seed(text = '秦朝统一天下后，地方豪强仍然活跃。') {
  const videoId = String(++serial).padStart(11, '0')
  const source = storeHistoryYoutubeSource({videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: '秦朝为何灭亡', authorName: 'history', durationSeconds: 1000, observedAt: new Date().toISOString(), collectionUrl: 'https://www.youtube.com/@history/videos'})
  return draft(source.id, text)
}
function draft(id: number, text: string) {
  return updateHistorySource(id, {status: 'needs_review', rawTranscript: text, correctedTranscript: text, rewrittenScript: text,
    mediaJson: JSON.stringify({videoSha256: '1'.repeat(64), chunks: [{start: 0, duration: 2, sha256: '2'.repeat(64)}]}),
    asrJson: JSON.stringify({complete: true, text, sourceVideoSha256: '1'.repeat(64),
      chunks: [{index: 0, start: 0, duration: 2, audioSha256: '2'.repeat(64)}]}),
    reviewJson: JSON.stringify({factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(text),
      correctedTranscriptSha256: hash(text), rewriteInputSha256: hash(text)})})!
}
function harness(dependencies: HistoryContinuousRuntimeDependencies = {}, signal?: AbortSignal) {
  let options!: HistoryContinuousOptions
  const runtime = createHistoryContinuousRuntime({signal, dependencies: {database: db.$client, staticRoot: root, ...dependencies,
    controller(input) {options = input; return createHistoryContinuousProduction(input)}}})
  return {...runtime, options}
}
function scope(source: ReturnType<typeof seed>, assertCurrent = () => {}) : HistoryContinuousScope {
  const scriptHash = hash(source.rewrittenScript!)
  return {sourceIds: [source.id], scriptHashes: {[source.id]: scriptHash},
    members: [{sourceId: source.id, scriptHash, revision: historyProductionSourceRevision(source), continuationTaskId: 40402}], assertCurrent}
}
function prepared(source: ReturnType<typeof seed>) {return scope(source).members[0]!}
function delivery(source: ReturnType<typeof seed>, producer: 'motion' | 'huasheng' = 'motion') {
  const relative = `history-deliveries/${source.id}/${producer}.mp4`
  fs.mkdirSync(path.dirname(path.join(root, relative)), {recursive: true})
  fs.writeFileSync(path.join(root, relative), `${producer} video`)
  return recordHistoryVideoDelivery(db.$client, {scriptId: source.id, scriptSha256: hash(source.rewrittenScript!), producer,
    producerJobId: '94', videoUrl: `/static/${relative}`, videoName: `${producer}.mp4`, duration: 2, sha256: hash(`${producer} video`)})
}
function projection(source: ReturnType<typeof seed>, videoId: number | null, state: HistoryProductionVersion['state'] = 'submitted'): HistoryProductionState {
  return {scriptId: source.id, scriptSha256: hash(source.rewrittenScript!), productionMode: 'dual', complete: true, productionComplete: true,
    versions: [{key: 'motion', scriptId: source.id, scriptSha256: hash(source.rewrittenScript!), producer: 'motion', producerJobId: '94',
      videoId, state, stage: 'publication', message: 'fixture', error: null, action: 'none', jobId: null, exportJobId: null,
      automatic: true, canPublish: false, videoAvailable: true, materialsReady: true, confirmedAt: null, revisionOfVideoId: null, previousJobId: null}]}
}
function submitted(source: ReturnType<typeof seed>, video: ReturnType<typeof delivery>) {
  const result = {staged: true, saved: false, published: false, submitted: true, publicationStatus: 'submitted',
    articleId: '188000000000001', targetId: 'original-editor', accountName: 'history_baijiahao',
    editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',
    publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=188000000000001', engine: 'fixture'}
  const fingerprint = `${source.id}:${video.id}`
  const id = Number(db.$client.prepare(`INSERT INTO history_social_upload_jobs
    (source_id,source_title,target,mode,publication_mode,status,message,blockers_json,fingerprint,engine,result_json,video_id,video_producer,created_at,updated_at)
    VALUES(?,?,'baijiahao-video','draft','publish','completed','submitted','[]',?,'fixture',?,?,?,'before','before')`)
    .run(source.id, source.title, fingerprint, JSON.stringify(result), video.id, video.producer).lastInsertRowid)
  const payload = {jobId: String(id), scriptId: source.id, target: 'baijiahao-video', publicationMode: 'publish',
    accountName: 'history_baijiahao', fingerprint, videoPath: path.resolve(root, video.videoUrl.replace(/^\/static\//, ''))}
  db.$client.prepare('UPDATE history_social_upload_jobs SET payload_json=? WHERE id=?').run(JSON.stringify(payload), id)
  return {id, result, payload}
}
function cloudJob(source: ReturnType<typeof seed>, overrides: Partial<HuashengJob> = {}): HuashengJob {
  return {id: 94, sourceId: source.id, title: source.title, status: 'queued', stage: 'queued', message: '', projectUrl: null,
    videoUrl: null, error: null, createdAt: 'before', updatedAt: 'before', scriptSha256: hash(source.rewrittenScript!),
    checkpoint: null, cancelRequested: false, attempts: 0, huashengAccountName: 'history_huasheng_legacy',
    productionStatus: 'not_started', productionCheckedAt: null, productionMessage: '', productionCheckError: null, ...overrides}
}
function services(calls: string[], job: HuashengJob) {
  const factory = {production: {} as any, startFromSource: async () => ({} as any), startEpisode: async () => ({} as any),
    recoverPending: (ids?: readonly number[]) => {calls.push('recover'); assert.deepEqual(ids, [job.sourceId])},
    runner: {stop: async () => {calls.push('stop')}} as any}
  const huasheng = {getJob: (id: number) => {assert.equal(id, job.id); return job},
    produce: async (ids: number[]) => {calls.push('produce'); assert.deepEqual(ids, [job.id]); return {results: [], running: false}},
    checkProduction: () => ({checking: true}), close: async () => {calls.push('cloud-close')}}
  const exporter = {enqueue: (() => ({})) as any, runPending: async (ids?: number[]) => {calls.push(`export:${ids!.join(',')}`)},
    close: async () => {calls.push('export-close')}}
  const social = {listJobs: () => [], enqueue: (async () => ({})) as any,
    runPending: async (selected?: any) => {calls.push('upload'); return selected}, close: async () => {calls.push('social-close')}}
  return {factory, huasheng, exporter, social}
}

test('construction only initializes the controller schema; services and business work remain lazy', async () => {
  const unexpected = () => assert.fail('Construction cannot start or inspect business work')
  const runtime = harness({source: unexpected, prepare: unexpected, queueCollection: unexpected, resumeCollection: unexpected, queueContinuation: unexpected,
    productionState: unexpected, productionPass: unexpected, publicationPass: unexpected,
    factory: unexpected, huasheng: unexpected, exporter: unexpected, social: unexpected})
  assert.ok(runtime.controller)
  assert.deepEqual(db.$client.prepare('SELECT COUNT(*) AS count FROM history_continuous_production').get(), {count: 0})
  await runtime.close()
  assert.equal(db.$client.open, true)
})

test('source snapshots include deletion and reject script text with stale provenance', async () => {
  const source = seed(), runtime = harness()
  assert.equal(runtime.options.source(source.id)!.scriptHash, hash(source.rewrittenScript!))
  updateHistorySource(source.id, {correctedTranscript: '上游校对稿被改过但溯源未更新'})
  assert.equal(runtime.options.source(source.id)!.scriptHash, null)
  deleteHistorySource(source.id)
  assert.equal(runtime.options.source(source.id)!.deleted, true)
  assert.equal(runtime.options.source(999999), null)
  await runtime.close()
})

test('preparation fences the original revision and returns the final prepared script hash', async () => {
  const source = seed(), controller = new AbortController()
  let checks = 0, calls = 0
  const runtime = harness({prepare: async (original, options) => {
    calls++; assert.equal(original.id, source.id); assert.equal(options?.signal, controller.signal)
    return draft(source.id, '统一天下后，新的制度又遇到了新的难题。')
  }}, controller.signal)
  await assert.rejects(runtime.options.prepare({sourceId: source.id, expectedRevision: 'old', intentId: 'original', assertCurrent() {checks++}}), /revision changed/)
  assert.equal(calls, 0)
  const result = await runtime.options.prepare({sourceId: source.id, expectedRevision: historyProductionSourceRevision(source),
    intentId: 'original', assertCurrent() {checks++}})
  const current = getHistorySource(source.id)!
  assert.equal(result.revision, historyProductionSourceRevision(current))
  assert.equal(result.scriptHash, hash(current.rewrittenScript!))
  assert.equal(checks, 2)
  assert.equal(calls, 1)
  await runtime.close()
})

test('collection refuses an adopted active task and tasks at or below the baseline', async () => {
  const input = {source: 'youtube' as const, youtube: {urls: ['https://www.youtube.com/@history/videos']}, targetCount: 1 as const, existingSources: 'skip' as const}
  for (const result of [{created: false, job: {id: 40401}}, {created: true, job: {id: 40400}}]) {
    const runtime = harness({queueCollection: (() => result) as any})
    assert.throws(() => runtime.options.queueCollection(input), /adopting|baseline/)
    await runtime.close()
  }
  const runtime = harness({queueCollection: ((value: unknown) => {assert.deepEqual(value, input); return {created: true, job: {id: 40401}}}) as any})
  assert.deepEqual(runtime.options.queueCollection(input), {taskId: 40401})
  await runtime.close()
  assert.throws(() => createHistoryContinuousRuntime({taskBaseline: 40399}), /baseline/)
})

test('continuation validates the original task source, type, script and baseline', async () => {
  const source = seed(), input = prepared(source)
  const task = {id: 40402, type: 'history.production.continue', scopeId: source.id, payload: {sourceId: source.id, scriptSha256: input.scriptHash}}
  for (const changed of [{...task, id: 40400}, {...task, type: 'other'}, {...task, scopeId: source.id + 1},
    {...task, payload: {...task.payload, scriptSha256: '0'.repeat(64)}}, {...task, payload: {...task.payload, sourceId: source.id + 1}}]) {
    const runtime = harness({queueContinuation: (() => ({task: changed})) as any})
    assert.throws(() => runtime.options.queueContinuation(input), /does not match/)
    await runtime.close()
  }
  const runtime = harness({queueContinuation: ((id: number, options: any) => {
    assert.equal(id, source.id); assert.equal(options.expectedRevision, input.revision); return {task}
  }) as any})
  assert.deepEqual(runtime.options.queueContinuation(input), {taskId: 40402})
  updateHistorySource(source.id, {status: 'rewritten'})
  assert.throws(() => runtime.options.queueContinuation(input), /changed before continuation/)
  await runtime.close()
})

test('collection recovery invokes only the original task ID without constructing producer services', async () => {
  const called: number[] = []
  const unexpected = () => assert.fail('Collection recovery cannot construct external services')
  const runtime = harness({resumeCollection: ((id: number) => {called.push(id); return {id, status: 'queued'}}) as any,
    factory: unexpected, huasheng: unexpected, exporter: unexpected, social: unexpected})
  assert.deepEqual(runtime.options.recoverCollection!(40401), {taskId: 40401})
  assert.deepEqual(called, [40401])
  for (const id of [40400, -1, NaN, 40401.5]) assert.throws(() => runtime.options.recoverCollection!(id), /baseline/)
  assert.deepEqual(called, [40401])
  await runtime.close()
  assert.throws(() => runtime.options.recoverCollection!(40401), /closed/)
  assert.deepEqual(called, [40401])
})

test('collection recovery rejects missing, replaced and terminal tasks but accepts the same running task', async () => {
  for (const job of [null, {id: 40402, status: 'queued'}, {id: 40401, status: 'succeeded'}, {id: 40401, status: 'failed'}]) {
    const runtime = harness({resumeCollection: (() => job) as any})
    assert.throws(() => runtime.options.recoverCollection!(40401), /retain the original/)
    await runtime.close()
  }
  const runtime = harness({resumeCollection: (() => ({id: 40401, status: 'running'})) as any})
  assert.deepEqual(runtime.options.recoverCollection!(40401), {taskId: 40401})
  await runtime.close()
})

test('an aborted runtime does not resume a collection', async () => {
  const controller = new AbortController()
  const runtime = harness({resumeCollection: () => assert.fail('Aborted runtime cannot resume tasks')}, controller.signal)
  controller.abort(Error('run stopped'))
  assert.throws(() => runtime.options.recoverCollection!(40401), /run stopped/)
  await runtime.close()
})

test('a submitted projection without an original payload and valid receipt remains attention', async () => {
  const source = seed(), video = delivery(source)
  const runtime = harness({productionState: () => projection(source, video.id)})
  const projected = runtime.options.observe(scope(source))[0]!
  assert.equal(projected.motion.state, 'attention')
  assert.equal(projected.motion.receiptId, undefined)
  const upload = submitted(source, video)
  db.$client.prepare('UPDATE history_social_upload_jobs SET payload_json=NULL WHERE id=?').run(upload.id)
  assert.equal(runtime.options.observe(scope(source))[0]!.motion.receiptId, undefined)
  await runtime.close()
})

test('the real production projection accepts a receipt bound to its original video and job', async () => {
  const source = seed(), video = delivery(source), upload = submitted(source, video), runtime = harness()
  const observed = runtime.options.observe(scope(source))[0]!
  assert.equal(observed.motion.state, 'submitted')
  assert.equal(observed.motion.receiptId, String(upload.id))
  db.$client.prepare('UPDATE history_social_upload_jobs SET result_json=? WHERE id=?').run(JSON.stringify({...upload.result,
    published: true, publicationStatus: 'published'}), upload.id)
  const published = runtime.options.observe(scope(source))[0]!
  assert.equal(published.motion.state, 'published')
  assert.notEqual(published.fingerprint, observed.fingerprint)
  await runtime.close()
})

for (const mismatch of ['source', 'hash', 'video', 'job', 'account', 'result-account', 'fingerprint', 'payload-job', 'payload-mode', 'receipt', 'producer'] as const) {
  test(`a receipt with a mismatched ${mismatch} cannot release Motion inventory`, async () => {
    const source = seed(), video = delivery(source), upload = submitted(source, video)
    const runtime = harness({productionState: () => projection(source, video.id)})
    const payload = {...upload.payload}, result = {...upload.result}
    if (mismatch === 'source') db.$client.prepare('UPDATE history_social_upload_jobs SET source_id=? WHERE id=?').run(source.id + 1, upload.id)
    if (mismatch === 'hash') db.$client.prepare('UPDATE history_video_deliveries SET script_sha256=? WHERE id=?').run('0'.repeat(64), video.id)
    if (mismatch === 'video') payload.videoPath = path.join(root, 'unrelated.mp4')
    if (mismatch === 'job') db.$client.prepare("UPDATE history_video_deliveries SET producer_job_id='foreign' WHERE id=?").run(video.id)
    if (mismatch === 'account') payload.accountName = 'another-account'
    if (mismatch === 'result-account') result.accountName = 'another-account'
    if (mismatch === 'fingerprint') payload.fingerprint = 'foreign'
    if (mismatch === 'payload-job') payload.jobId = String(upload.id + 1)
    if (mismatch === 'payload-mode') payload.publicationMode = 'draft'
    if (mismatch === 'receipt') result.submitted = false
    if (mismatch === 'producer') db.$client.prepare("UPDATE history_social_upload_jobs SET video_producer='huasheng' WHERE id=?").run(upload.id)
    db.$client.prepare('UPDATE history_social_upload_jobs SET payload_json=?,result_json=? WHERE id=?').run(JSON.stringify(payload), JSON.stringify(result), upload.id)
    const observed = runtime.options.observe(scope(source))[0]!
    assert.equal(observed.motion.state, 'attention')
    assert.equal(observed.motion.receiptId, undefined)
    await runtime.close()
  })
}

test('local Motion and recovery run before cloud failure, while scoped export and publication still advance', async () => {
  const source = seed(), other = seed(), calls: string[] = [], job = cloudJob(source)
  recordHistoryDualProduction(db.$client, source.id, job.scriptSha256, job.id)
  recordHistoryDualProduction(db.$client, other.id, hash(other.rewrittenScript!), 95)
  const video = delivery(source), foreignVideo = delivery(other), upload = submitted(source, video)
  submitted(other, foreignVideo)
  recordHistoryVideoPublication(db.$client, source.id, job.scriptSha256, video.id, 'motion')
  recordHistoryVideoPublication(db.$client, other.id, hash(other.rewrittenScript!), foreignVideo.id, 'motion')
  db.$client.prepare("INSERT INTO history_huasheng_export_jobs VALUES(11,?,?,94,'queued'),(12,?,?,95,'queued'),(13,?,?,99,'queued')")
    .run(source.id, job.scriptSha256, other.id, hash(other.rewrittenScript!), source.id, job.scriptSha256)
  const mocks = services(calls, job)
  mocks.huasheng.produce = async () => {calls.push('produce'); throw Error('cloud unavailable')}
  const intent = db.$client.prepare('SELECT id FROM history_video_publication_intents WHERE source_id=?').get(source.id) as {id: number}
  const runtime = harness({factory: () => mocks.factory, huasheng: () => mocks.huasheng, exporter: () => mocks.exporter,
    social: options => {assert.equal(options.database, db.$client); assert.equal(options.recoverOnStartup, false)
      assert.deepEqual(options.scope, {sourceIds: []}); return mocks.social},
    productionPass: async options => {calls.push(options?.motionOnly ? 'motion' : 'dual'); assert.deepEqual(options?.sourceIds, [source.id])},
    publicationPass: async options => {calls.push('publication'); assert.equal(options?.social, mocks.social)
      assert.deepEqual(options?.scope, {sourceIds: [source.id], videoIds: [video.id], jobIds: [intent.id]})},
  })
  mocks.social.runPending = async selected => {calls.push('upload'); assert.deepEqual(selected,
    {sourceIds: [source.id], videoIds: [video.id], jobIds: [upload.id]})}
  await assert.rejects(runtime.options.advance(scope(source)), /cloud unavailable/)
  assert.deepEqual(calls, ['motion', 'recover', 'produce', 'dual', 'export:11', 'publication', 'upload'])
  await runtime.close()
  assert.ok(db.$client.open)
})

for (const projectUrl of [null, 'https://www.huasheng.cn/video/original']) {
  test(`an unknown create checkpoint is ${projectUrl ? 'resumed only for its bound project' : 'blocked without recreating a project'}`, async () => {
    const source = seed(), calls: string[] = [], job = cloudJob(source, {stage: 'create_pending', checkpoint: 'create_pending', projectUrl})
    recordHistoryDualProduction(db.$client, source.id, job.scriptSha256, job.id)
    const mocks = services(calls, job)
    const runtime = harness({factory: () => mocks.factory, huasheng: () => mocks.huasheng, exporter: () => mocks.exporter,
      social: () => mocks.social, publicationPass: async () => {}, productionPass: async options => {
        if (options?.motionOnly) return
        assert.throws(() => options!.queue!.checkProduction(source.id), /Explicit original/)
        assert.throws(() => options!.queue!.checkProduction(source.id, {jobIds: [95]}), /outside/)
        assert.deepEqual(options!.queue!.checkProduction(source.id, {jobIds: [94]}), {checking: true})
        const result = await options!.queue!.produce([94])
        if (!projectUrl) assert.equal(result.results[0]!.status, 'blocked')
      }})
    await runtime.options.advance(scope(source))
    assert.equal(calls.filter(value => value === 'produce').length, projectUrl ? 2 : 0)
    await runtime.close()
  })
}

test('a script change during awaited Motion work fences all later dispatch', async () => {
  const source = seed(), calls: string[] = [], mocks = services(calls, cloudJob(source))
  const runtime = harness({factory: () => mocks.factory, huasheng: () => mocks.huasheng,
    productionPass: async () => {calls.push('motion'); await Promise.resolve(); draft(source.id, '新的正文不能继续旧任务。')},
    publicationPass: async () => assert.fail('Changed source must not reach publication')})
  await assert.rejects(runtime.options.advance(scope(source)), /source or script changed/)
  assert.deepEqual(calls, ['motion'])
  await runtime.close()
})

test('a stop fence after an awaited step prevents subsequent recovery or external dispatch', async () => {
  const source = seed(), calls: string[] = [], mocks = services(calls, cloudJob(source))
  let stopped = false
  const runtime = harness({factory: () => mocks.factory, productionPass: async () => {await Promise.resolve(); stopped = true}})
  await assert.rejects(runtime.options.advance(scope(source, () => {if (stopped) throw Error('original run stopped')})), /original run stopped/)
  assert.deepEqual(calls, [])
  await runtime.close()
})

test('close is idempotent, closes only instantiated services, and keeps the shared database open', async () => {
  const source = seed(), calls: string[] = [], mocks = services(calls, cloudJob(source))
  const runtime = harness({factory: () => mocks.factory, huasheng: () => mocks.huasheng, exporter: () => mocks.exporter,
    social: () => mocks.social, productionPass: async () => {}, publicationPass: async () => {}})
  await runtime.options.advance(scope(source))
  calls.length = 0
  await Promise.all([runtime.close(), runtime.close()])
  assert.deepEqual(calls.sort(), ['export-close', 'social-close', 'stop'])
  assert.ok(db.$client.open)
  assert.throws(() => runtime.options.source(source.id), /closed/)
})
