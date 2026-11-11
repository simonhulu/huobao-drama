import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import type { StoreHistorySourceInput } from './history-script-library.js'

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'history-source-jobs-')), 'test.db')
const { db, schema } = await import('../db/index.js')
const { storeHistorySource, storeHistoryArticleSource, updateHistorySource, getHistorySource, getHistorySourceArtifactState, deleteHistorySource } = await import('./history-script-library.js')
const { historySourceJobConfigSchema, checkHistorySourceReadiness, checkHistoryTextReadiness, createHistorySourceJobHandler: createHistorySourceJobHandlerBase, HISTORY_SOURCING_TASK_TYPE, getHistorySourceJob, listHistorySourceJobs, listHistorySourceJobEvents, startHistorySourceJob, stopHistorySourceJob, resumeHistorySourceJob, recoverHistorySourceJobs, safeHistoryJobMessage } = await import('./history-source-jobs.js')
const { collectCzgtsArticles } = await import('./history-source-czgts.js')
const { storeHistoryYoutubeSource } = await import('./history-source-youtube.js')
const { ensureHistoryVideoDeliveriesSchema, recordHistoryVideoDelivery } = await import('./history-video-deliveries.js')
const { clearTaskHandlers, registerTaskHandler } = await import('./tasks/registry.js')
const { runWorkerOnce } = await import('./tasks/worker.js')
const { recoverExpiredRunningTasks } = await import('./tasks/recovery.js')
const { getTask, createTask, claimQueuedTask, extendTaskLease, appendTaskEvent } = await import('./tasks/store.js')
const { createHistorySourceJobsRoute } = await import('../routes/history-source-jobs.js')
const { recordWorkerHeartbeat } = await import('./tasks/heartbeat.js')
const { writeHistorySourceSettings } = await import('./history-source-settings.js')
const collectionStorageRoot = mkdtempSync(join(tmpdir(), 'history-source-job-media-'))
const createHistorySourceJobHandler = (overrides: Parameters<typeof createHistorySourceJobHandlerBase>[0] = {}) =>
  createHistorySourceJobHandlerBase({storageRoot: collectionStorageRoot, ...overrides})

ensureHistoryVideoDeliveriesSchema(db.$client)
beforeEach(() => {
  db.$client.exec('DELETE FROM history_video_deliveries')
  db.delete(schema.creationTaskEvents).run()
  db.delete(schema.creationTasks).run()
  db.delete(schema.historyScriptSources).run()
  db.delete(schema.workerHeartbeats).run()
  recordWorkerHeartbeat('history-sourcing-test')
  clearTaskHandlers()
})

function candidate(id = '7395681234567890123'): StoreHistorySourceInput {
  return { sourceVideoId: id, title: 'A local history question', category: 'regional_history', metrics: { comments: 123 }, selection: { reason: 'Viewers ask for sources', observedAt: new Date().toISOString(), comments: [{ text: 'Which local gazetteer records this?' }] } }
}

function completeDraft(id: number) {
  const rawTranscript = 'Raw narration', correctedTranscript = 'Corrected narration', rewrittenScript = 'Rewritten narration'
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  return updateHistorySource(id, {
    status: 'needs_review', rawTranscript, correctedTranscript, rewrittenScript,
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 12, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text: rawTranscript, sourceVideoSha256: '1'.repeat(64), chunks: [{ index: 0, start: 0, duration: 12, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ factCheckStatus: 'needs_sources', corrections: [], factualConcerns: [], rawTranscriptSha256: hash(rawTranscript), correctedTranscriptSha256: hash(correctedTranscript), rewriteInputSha256: hash(correctedTranscript) }),
  })!
}

function worker() { return runWorkerOnce({ workerId: 'history-test', types: [HISTORY_SOURCING_TASK_TYPE], cancelPollMs: 10 }) }

const articleDates = { startTime: '2026-10-20 15:44:23', endTime: '2026-10-21 15:44:23' }

function youtubeCandidate(videoId = 'VprFAzjTTuM') {
  return { videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, title: '秦朝亡了沒人救，漢朝亡了憑什麼還能再活兩百年？', authorName: '歷史大觀',
    observedAt: new Date().toISOString(), collectionUrl: 'https://www.youtube.com/@助眠睡前歷史故事/videos', durationSeconds: 5083 }
}

test('YouTube configuration requires an explicit channel or video and does not alter old task defaults', () => {
  assert.equal(historySourceJobConfigSchema.parse({}).source, 'douyin')
  assert.equal(historySourceJobConfigSchema.parse({}).existingSources, undefined)
  assert.equal(historySourceJobConfigSchema.parse({ source: 'youtube', youtube: { url: youtubeCandidate().collectionUrl } }).source, 'youtube')
  assert.equal(historySourceJobConfigSchema.parse({ source: 'youtube', youtube: { url: youtubeCandidate().collectionUrl }, existingSources: 'skip' }).existingSources, 'skip')
  for (const input of [{ source: 'youtube' }, { youtube: { url: youtubeCandidate().sourceUrl } },
    { source: 'youtube', youtube: { url: 'https://example.org/video' } },
    { source: 'youtube', youtube: { url: youtubeCandidate().sourceUrl }, czgts: articleDates }]) {
    assert.throws(() => historySourceJobConfigSchema.parse(input))
  }
})

test('YouTube readiness checks local tools and models without consulting the Douyin download service', async () => {
  const checked: string[] = []
  await checkHistorySourceReadiness(new AbortController().signal, {
    getConfig: type => ({ provider: type === 'audio' ? 'minimax' : 'openai', apiKey: 'configured' }),
    checkTool: async tool => { checked.push(tool) },
    readDownloaderConnection: async () => assert.fail('YouTube does not use the Douyin downloader'),
    fetch: async () => assert.fail('YouTube preflight does not call the Douyin API'),
  }, 'youtube')
  assert.deepEqual(checked.slice(0, 2), ['ffmpeg', 'ffprobe'])
  assert.match(checked[2]!, /yt-dlp$/)
})

test('YouTube job stores originals, uses the shared recreate pipeline and ignores same IDs on other platforms', async () => {
  const input = youtubeCandidate('12345678901')
  storeHistorySource(candidate(input.videoId))
  let processed = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => assert.fail('No Douyin preflight'),
    checkYoutubeReadiness: async () => {},
    browse: async () => assert.fail('No browser collection'),
    collectYoutube: async options => {
      assert.equal(decodeURI(options.url), input.collectionUrl)
      assert.equal(options.isKnownVideo(input.videoId), false)
      options.report({ stage: 'selecting', message: '读取 YouTube 来源', browserUrl: input.sourceUrl, scanned: 1,
        candidate: { outcome: 'selected', videoId: input.videoId, title: input.title } })
      await options.onCandidate(input)
      assert.equal(options.isTargetReached(), true)
    },
    process: async (id, options) => {
      processed++
      assert.equal(options?.through, 'recreate')
      assert.equal(getHistorySource(id)!.platform, 'youtube')
      assert.equal(getHistorySource(id)!.title, input.title)
      assert.equal(getHistorySource(id)!.authorName, input.authorName)
      return completeDraft(id)
    },
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: input.collectionUrl }, targetCount: 1 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.equal(processed, 1)
  assert.equal(result.counts.completed, 1)
  assert.equal(result.browserUrl, input.sourceUrl)
  assert.ok(result.events.some(event => event.candidate?.videoId === input.videoId))
})

test('a YouTube processing failure preserves its source and continues to another candidate', async () => {
  const first = youtubeCandidate(), second = youtubeCandidate('bwbQOdW5Cv8')
  storeHistoryYoutubeSource(youtubeCandidate('12345678901'))
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      assert.equal(options.isKnownVideo('12345678901'), false, 'collection alone is not successful production')
      await options.onCandidate(first)
      assert.equal(options.isTargetReached(), false)
      await options.onCandidate(second)
    },
    process: async id => {
      if (getHistorySource(id)!.sourceVideoId === first.videoId) throw new Error('YouTube 下载失败')
      return completeDraft(id)
    },
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: first.collectionUrl }, targetCount: 1 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.failed, 1)
  assert.equal(result.counts.completed, 1)
  assert.equal(result.sourceIds.length, 2)
  assert.equal(getHistorySource(result.sourceIds[0]!)!.title, first.title)
})

test('YouTube historical deduplication uses delivered videos from the last fifteen days, including released media', async () => {
  const recent = storeHistoryYoutubeSource(youtubeCandidate('recent00001'))
  const expired = storeHistoryYoutubeSource(youtubeCandidate('expired0001'))
  const collected = storeHistoryYoutubeSource(youtubeCandidate('collect0001'))
  completeDraft(recent.id); completeDraft(expired.id); completeDraft(collected.id)
  for (const [source, age] of [[recent, 14], [expired, 16]] as const) {
    const video = recordHistoryVideoDelivery(db.$client, {
      scriptId: source.id, scriptSha256: '1'.repeat(64), producer: 'motion', producerJobId: `production-${source.id}`,
      videoUrl: `/static/already-released-${source.id}.mp4`, videoName: 'accepted.mp4', duration: 60, sha256: '2'.repeat(64),
    })
    db.$client.prepare('UPDATE history_video_deliveries SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - age * 86400000).toISOString(), video.id)
  }
  updateHistorySource(expired.id, { status: 'needs_review' })
  let checked = false
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      assert.equal(options.isKnownVideo(recent.sourceVideoId), true, 'accepted output counts after local media reclamation')
      assert.equal(options.isKnownVideo(expired.sourceVideoId), false, 'later source updates cannot extend the production window')
      assert.equal(options.isKnownVideo(collected.sourceVideoId), false, 'a completed draft is not a completed video')
      checked = true
      options.report({ stage: 'exhausted', message: 'YouTube 来源已检索完毕', scanned: 3 })
    },
    process: async () => assert.fail('This read-only fixture does not process sources'),
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: recent.sourceUrl }, targetCount: null })
  await worker()
  assert.equal(checked, true)
  assert.equal(getHistorySourceJob(job.id)!.status, 'completed')
})

test('YouTube recollection restores a deleted failed identity and resumes its saved transcript without adding another source', async () => {
  const input = youtubeCandidate()
  const stored = storeHistoryYoutubeSource(input)
  completeDraft(stored.id)
  updateHistorySource(stored.id, { status: 'failed', rewrittenScript: null, lastError: 'previous text request failed' })
  deleteHistorySource(stored.id)
  let processed = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      assert.equal(options.isKnownVideo(input.videoId), false)
      await options.onCandidate(input)
    },
    process: async id => {
      processed++
      assert.equal(id, stored.id)
      assert.equal(getHistorySource(id)!.rawTranscript, 'Raw narration')
      assert.equal(getHistorySource(id)!.deletedAt, null)
      return completeDraft(id)
    },
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: input.collectionUrl }, targetCount: 1 })
  await worker()
  assert.equal(getHistorySourceJob(job.id)!.status, 'completed')
  assert.equal(processed, 1)
  assert.equal(db.select().from(schema.historyScriptSources).all().length, 1)
})

test('YouTube recollection continues the original production once and de-duplicates repeated candidates within the batch', async () => {
  const input = youtubeCandidate(), stored = storeHistoryYoutubeSource(input)
  completeDraft(stored.id)
  let processed = 0, continued = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      assert.equal(options.isKnownVideo(input.videoId), false)
      await options.onCandidate(input)
      assert.equal(options.isKnownVideo(input.videoId), true)
      assert.match(options.knownVideoReason!(input.videoId), /本轮已处理/)
      await options.onCandidate(input)
      options.report({stage: 'exhausted', message: 'YouTube 来源已检索完毕', scanned: 2})
    },
    process: async id => {processed++; return completeDraft(id)},
    continueProduction: async id => {assert.equal(id, stored.id); continued++},
  }))
  const {job} = startHistorySourceJob({source: 'youtube', youtube: {url: input.collectionUrl}, targetCount: null})
  await worker()
  assert.equal(getHistorySourceJob(job.id)!.status, 'completed')
  assert.equal(getHistorySourceJob(job.id)!.counts.selected, 1)
  assert.equal(processed, 1)
  assert.equal(continued, 1)
})

for (const state of ['draft', 'failed', 'expired-delivery', 'deleted'] as const) test(`YouTube fresh-only collection leaves an existing ${state} source untouched`, async () => {
  const input = youtubeCandidate(), stored = storeHistoryYoutubeSource(input)
  completeDraft(stored.id)
  if (state === 'failed') updateHistorySource(stored.id, { status: 'failed', rewrittenScript: null, lastError: 'Preserve the failed checkpoint' })
  if (state === 'deleted') deleteHistorySource(stored.id)
  if (state === 'expired-delivery') {
    const video = recordHistoryVideoDelivery(db.$client, { scriptId: stored.id, scriptSha256: '1'.repeat(64), producer: 'motion',
      producerJobId: 'previous-production', videoUrl: '/static/released.mp4', videoName: 'accepted.mp4', duration: 60, sha256: '2'.repeat(64) })
    db.$client.prepare('UPDATE history_video_deliveries SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - 16 * 86400000).toISOString(), video.id)
  }
  const before = getHistorySource(stored.id, { includeDeleted: true })
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      assert.equal(options.isKnownVideo(input.videoId), true)
      assert.match(options.knownVideoReason!(input.videoId), /只采集新来源/)
      await options.onCandidate(input)
      await options.onCandidate(input)
      options.report({ stage: 'exhausted', message: '频道到底', scanned: 2 })
    },
    process: async () => assert.fail('Existing sources must not enter paid processing'),
    continueProduction: async () => assert.fail('Existing sources must not continue production'),
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: input.collectionUrl }, targetCount: 1, existingSources: 'skip' })
  assert.equal(getTask(job.id)!.payload.existingSources, 'skip')
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.selected, 0)
  assert.equal(result.counts.completed, 0)
  assert.deepEqual(result.sourceIds, [])
  assert.deepEqual(getHistorySource(stored.id, { includeDeleted: true }), before)
})

test('YouTube fresh-only collection saves a new identity and durable progress without continuing another platform', async () => {
  const input = youtubeCandidate('12345678901'), other = storeHistorySource(candidate(input.videoId))
  let processed = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      assert.equal(options.isKnownVideo(input.videoId), false)
      await options.onCandidate(input)
      assert.equal(options.isKnownVideo(input.videoId), true)
      await options.onCandidate(input)
    },
    process: async id => { processed++; assert.notEqual(id, other.id); return completeDraft(id) },
    continueProduction: async () => assert.fail('A new source has no original production to continue'),
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: input.collectionUrl }, targetCount: 1, existingSources: 'skip' })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.equal(processed, 1)
  assert.equal(result.counts.selected, 1)
  assert.equal(result.counts.completed, 1)
  assert.equal(result.sourceIds.length, 1)
  const source = getHistorySource(result.sourceIds[0]!)!
  assert.equal(source.platform, 'youtube')
  assert.equal(source.sourceVideoId, input.videoId)
  assert.equal(getHistorySourceArtifactState(source).rewritten, 'current')
  assert.ok(result.events.some(event => event.currentSourceId === source.id))
  assert.equal(db.select().from(schema.historyScriptSources).all().length, 2)
})

test('YouTube fresh-only collection rechecks concurrent insertion inside its write transaction', async t => {
  const input = youtubeCandidate(), competing = new Database(process.env.DB_PATH!)
  t.after(() => competing.close())
  const transaction = db.$client.transaction.bind(db.$client)
  let insertBeforeReservation = false, insertedId = 0, before: unknown
  t.mock.method(db.$client, 'transaction', ((fn: (...args: any[]) => any) => {
    if (insertBeforeReservation) {
      insertBeforeReservation = false
      assert.equal(db.$client.inTransaction, false)
      const timestamp = new Date().toISOString()
      insertedId = Number(competing.prepare(`INSERT INTO history_script_sources
        (platform,source_video_id,source_url,title,category,created_at,updated_at,deleted_at)
        VALUES('youtube',?,?,?,'unclassified',?,?,?)`).run(input.videoId, input.sourceUrl, 'Concurrent original', timestamp, timestamp, timestamp).lastInsertRowid)
      before = getHistorySource(insertedId, { includeDeleted: true })
    }
    return transaction(fn)
  }) as typeof db.$client.transaction)
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      assert.equal(options.isKnownVideo(input.videoId), false)
      insertBeforeReservation = true
      await options.onCandidate(input)
      assert.ok(insertedId > 0, 'another connection inserted after the optimistic checks')
      assert.equal(options.isKnownVideo(input.videoId), true)
      options.report({ stage: 'exhausted', message: '频道到底', scanned: 1 })
    },
    process: async () => assert.fail('The concurrent original must not be processed'),
    continueProduction: async () => assert.fail('The concurrent original must not continue production'),
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: input.collectionUrl }, targetCount: 1, existingSources: 'skip' })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.sourceIds, [])
  assert.equal(result.counts.selected, 0)
  assert.deepEqual(getHistorySource(insertedId, { includeDeleted: true }), before)
  assert.equal(db.select().from(schema.historyScriptSources).all().length, 1)
})

test('YouTube fresh-only collection resumes its own admitted source after a definite rate limit', async () => {
  let blocked = true, collections = 0
  const processed: number[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    continueProduction: async () => assert.fail('Fresh-only recovery must leave final script admission to its controller'),
    collectYoutube: async options => { collections++; await options.onCandidate(youtubeCandidate()) },
    process: async id => {
      processed.push(id)
      const source = completeDraft(id)
      if (!blocked) return source
      updateHistorySource(id, { status: 'corrected', rewrittenScript: null })
      throw Object.assign(new Error('gateway_concurrency_limit'), { status: 429 })
    },
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: youtubeCandidate().collectionUrl }, targetCount: 1, existingSources: 'skip' })
  await worker()
  const paused = getHistorySourceJob(job.id)!
  assert.equal(paused.errorCode, 'history_source_rate_limited')
  blocked = false
  resumeHistorySourceJob(job.id)
  await worker()
  assert.equal(getHistorySourceJob(job.id)!.status, 'completed')
  assert.deepEqual(processed, [paused.sourceIds[0], paused.sourceIds[0]])
  assert.equal(collections, 1)
  assert.equal(db.select().from(schema.historyScriptSources).all().length, 1)
})

test('YouTube login verification stops the shared collector after its first blocked download', async () => {
  const processed: number[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      await options.onCandidate(youtubeCandidate())
      await options.onCandidate(youtubeCandidate('bwbQOdW5Cv8'))
    },
    process: async id => {
      processed.push(id)
      throw new Error('YouTube 要求登录验证，请配置已登录浏览器后重试；已保存来源保留')
    },
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: youtubeCandidate().collectionUrl }, targetCount: null })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(processed.length, 1)
  assert.equal(result.status, 'failed')
  assert.equal(result.stage, 'waiting_login')
  assert.equal(result.errorCode, 'youtube_login_required')
  assert.equal(result.counts.failed, 0)
  assert.equal(result.sourceIds.length, 1)
})

test('a definite provider 429 pauses the original YouTube collection and resumes its saved source before scanning',async()=>{
  let blocked=true,collections=0
  const processed:number[]=[]
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE,createHistorySourceJobHandler({
    checkYoutubeReadiness:async()=>{},
    collectYoutube:async options=>{
      collections++
      await options.onCandidate(youtubeCandidate())
      await options.onCandidate(youtubeCandidate('bwbQOdW5Cv8'))
    },
    process:async id=>{
      processed.push(id)
      if(blocked){
        completeDraft(id)
        updateHistorySource(id,{status:'corrected',rewrittenScript:null})
        throw Object.assign(new Error('gateway_concurrency_limit'),{status:429,retryAfterMs:1000})
      }
      assert.equal(getHistorySourceArtifactState(getHistorySource(id)!).corrected,'current')
      return completeDraft(id)
    },
  }))
  const {job}=startHistorySourceJob({source:'youtube',youtube:{url:youtubeCandidate().collectionUrl},targetCount:1})
  await worker()
  const paused=getHistorySourceJob(job.id)!
  assert.equal(paused.status,'failed');assert.equal(paused.stage,'waiting_rate_limit');assert.equal(paused.errorCode,'history_source_rate_limited')
  assert.equal(paused.counts.failed,0);assert.equal(paused.counts.selected,1)
  assert.equal(paused.currentSourceId,paused.sourceIds[0]);assert.equal(processed.length,1)
  assert.match(paused.progressMessage!,/已暂停.*检查点保留/)
  assert.equal(paused.events.some(event=>event.stage==='source_failed'),false)
  const rateLimit=db.$client.prepare('SELECT data_json FROM creation_task_events WHERE task_id=? AND event_type=?').get(job.id,'history.rate_limit') as {data_json:string}
  assert.equal(JSON.parse(rateLimit.data_json).retryAfterMs,1000)
  assert.equal(await worker(),false,'rate limiting does not automatically resubmit paid work')
  blocked=false
  assert.equal(resumeHistorySourceJob(job.id)!.id,job.id)
  await worker()
  assert.equal(getHistorySourceJob(job.id)!.status,'completed')
  assert.deepEqual(processed,[paused.currentSourceId,paused.currentSourceId])
  assert.equal(collections,1,'the saved source completes the target before another channel scan')
  assert.equal(db.select().from(schema.creationTasks).all().length,1)
  assert.equal(db.select().from(schema.historyScriptSources).all().length,1)
})

test('resuming an old collection recovers a source previously skipped by HTTP 429 from its saved ASR',async()=>{
  const {job}=startHistorySourceJob({source:'youtube',youtube:{url:youtubeCandidate().collectionUrl},targetCount:null})
  const completed=storeHistoryYoutubeSource(youtubeCandidate()),skipped=storeHistoryYoutubeSource(youtubeCandidate('bwbQOdW5Cv8'))
  completeDraft(completed.id);completeDraft(skipped.id)
  updateHistorySource(skipped.id,{status:'failed',correctedTranscript:null,rewrittenScript:null,reviewJson:null,lastError:'Text model request failed: 429 gateway_concurrency_limit'})
  for(const source of [completed,skipped]) appendTaskEvent(job.id,'history.progress',{
    stage:'source_failed',message:'旧执行器跳过该条，继续下一条',counts:{scanned:2,selected:2,completed:1,failed:1},
    currentSourceId:source.id,currentTitle:source.title,sourceIds:[completed.id,skipped.id],browserUrl:source.sourceUrl,level:'warning',
  })
  stopHistorySourceJob(job.id)
  const processed:number[]=[]
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE,createHistorySourceJobHandler({
    checkYoutubeReadiness:async()=>{},
    collectYoutube:async options=>{
      assert.deepEqual(processed,[skipped.id],'old saved failures are resumed before another channel request')
      options.report({stage:'exhausted',message:'频道到底',scanned:0})
    },
    process:async id=>{
      processed.push(id)
      const source=getHistorySource(id)!
      assert.equal(source.rawTranscript,'Raw narration');assert.equal(getHistorySourceArtifactState(source).transcript,'current')
      assert.equal(source.correctedTranscript,null)
      return completeDraft(id)
    },
  }))
  assert.equal(resumeHistorySourceJob(job.id)!.id,job.id)
  await worker()
  assert.deepEqual(processed,[skipped.id]);assert.equal(getHistorySourceJob(job.id)!.counts.completed,2)
  assert.equal(getHistorySourceJob(job.id)!.counts.failed,0)
})

test('continuing YouTube keeps the original task and resumes saved failures before reading the channel', async () => {
  let blocked = true
  const processed: number[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      await options.onCandidate(youtubeCandidate())
      await options.onCandidate(youtubeCandidate('bwbQOdW5Cv8'))
    },
    process: async id => {
      processed.push(id)
      if (blocked && getHistorySource(id)!.sourceVideoId === 'bwbQOdW5Cv8') {
        throw new Error('YouTube 要求登录验证，请配置已登录浏览器后重试；已保存来源保留')
      }
      return completeDraft(id)
    },
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: youtubeCandidate().collectionUrl }, targetCount: 2 })
  await worker()
  const old = getHistorySourceJob(job.id)!
  assert.equal(old.counts.completed, 1)
  blocked = false
  const resumed = resumeHistorySourceJob(job.id)!
  assert.equal(resumed.id, job.id)
  assert.equal(resumeHistorySourceJob(job.id)!.id, job.id, 'double clicks cannot create another task')
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.completed, 2)
  assert.equal(result.counts.selected, 2)
  assert.deepEqual(processed, [old.sourceIds[0], old.sourceIds[1], old.sourceIds[1]])
  assert.equal(db.select().from(schema.creationTasks).all().length, 1)
})

test('continuing stopped YouTube recovers sources older than the 100-item UI snapshot', async () => {
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { url: youtubeCandidate().collectionUrl }, targetCount: null })
  const sourceIds: number[] = []
  for (let index = 0; index < 102; index++) {
    const source = storeHistoryYoutubeSource(youtubeCandidate(`video${String(index).padStart(6, '0')}`))
    sourceIds.push(source.id)
    appendTaskEvent(job.id, 'history.progress', { stage: 'downloading', message: '下载',
      counts: { scanned: index + 1, selected: index + 1, completed: 0, failed: index },
      currentSourceId: source.id, currentTitle: source.title, sourceIds: sourceIds.slice(-100), browserUrl: source.sourceUrl, level: 'info' })
  }
  completeDraft(sourceIds[1]!)
  stopHistorySourceJob(job.id)
  const processed: number[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => { options.report({ stage: 'exhausted', message: '频道到底', scanned: 0 }) },
    process: async id => { processed.push(id); return completeDraft(id) },
  }))
  const route = createHistorySourceJobsRoute()
  const response = await route.request(`/${job.id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 200)
  assert.equal(getTask(job.id)!.cancelRequested, false)
  await worker()
  assert.deepEqual(processed, sourceIds.filter(id => id !== sourceIds[1]))
  assert.equal(getHistorySourceJob(job.id)!.counts.completed, 102)
  assert.equal(getHistorySourceJob(job.id)!.counts.failed, 0)
})

test('YouTube recovery rejects another active collection, completed jobs, other platforms and cross-site writes', async () => {
  const old = startHistorySourceJob({ source: 'youtube', youtube: { url: youtubeCandidate().sourceUrl } }).job
  stopHistorySourceJob(old.id)
  const current = startHistorySourceJob({}).job
  const route = createHistorySourceJobsRoute()
  const post = (id: number, action: string, origin?: string) => route.request(`/${id}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: '{}',
  })
  assert.equal((await post(old.id, 'resume')).status, 409)
  assert.equal(getHistorySourceJob(old.id)!.status, 'stopped')
  assert.equal((await post(current.id, 'resume')).status, 409)
  assert.equal((await post(old.id, 'youtube-session', 'https://example.org')).status, 403)
  assert.equal((await post(current.id, 'youtube-session')).status, 409)
  assert.equal((await post(999999, 'resume')).status, 404)
  stopHistorySourceJob(current.id)
  db.update(schema.creationTasks).set({ status: 'succeeded' }).where(eq(schema.creationTasks.id, old.id)).run()
  assert.equal((await post(old.id, 'resume')).status, 409)
})

test('YouTube configuration normalizes old single URLs and rejects duplicate aliases in a list', () => {
  assert.deepEqual(historySourceJobConfigSchema.parse({ source: 'youtube', youtube: { url: 'https://youtube.com/@history?si=track' } }).youtube,
    { urls: ['https://www.youtube.com/@history/videos'] })
  assert.deepEqual(historySourceJobConfigSchema.parse({ source: 'youtube', youtube: { urls: ['https://youtu.be/VprFAzjTTuM', 'https://youtu.be/bwbQOdW5Cv8'] } }).youtube,
    { urls: ['https://www.youtube.com/watch?v=VprFAzjTTuM', 'https://www.youtube.com/watch?v=bwbQOdW5Cv8'] })
  for (const youtube of [{ urls: [] }, { urls: ['https://youtube.com/@history', 'https://m.youtube.com/@HISTORY/videos'] },
    { urls: ['https://example.org'] }, { urls: ['https://youtube.com/@history'], url: 'https://youtube.com/@history' }]) {
    assert.throws(() => historySourceJobConfigSchema.parse({ source: 'youtube', youtube }))
  }
})

test('YouTube jobs snapshot the saved channel order and retry old single-channel tasks with their original source', async () => {
  const channels = ['https://www.youtube.com/@first/videos', 'https://www.youtube.com/@second/videos']
  writeHistorySourceSettings({ youtubeChannels: channels })
  const { job } = startHistorySourceJob({ source: 'youtube', targetCount: null })
  writeHistorySourceSettings({ youtubeChannels: ['https://www.youtube.com/@replacement/videos'] })
  assert.deepEqual(getHistorySourceJob(job.id)!.config.youtube, { urls: channels })
  const visited: string[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => { visited.push(options.url); options.report({ stage: 'exhausted', message: '频道读完', scanned: 0 }) },
  }))
  await worker()
  assert.deepEqual(visited, channels)
  const retry = startHistorySourceJob({ source: 'youtube', youtube: { url: 'https://youtube.com/@original' }, targetCount: null }).job
  await worker()
  assert.deepEqual(getHistorySourceJob(retry.id)!.config.youtube, { urls: ['https://www.youtube.com/@original/videos'] })
  assert.equal(visited.at(-1), 'https://www.youtube.com/@original/videos')
})

test('YouTube advances through channels with shared deduplication, cumulative scanned counts and one total target', async () => {
  const urls = ['https://www.youtube.com/@first/videos', 'https://www.youtube.com/@second/videos', 'https://www.youtube.com/@third/videos']
  const first = youtubeCandidate(), second = youtubeCandidate('bwbQOdW5Cv8')
  const visited: string[] = [], processed: string[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => {
      visited.push(options.url)
      if (options.url === urls[0]) {
        await options.onCandidate(first)
        options.report({ stage: 'exhausted', message: '第一频道到底', scanned: 1 })
      } else {
        assert.equal(options.isKnownVideo(first.videoId), true)
        await options.onCandidate(first)
        assert.equal(options.isTargetReached(), false)
        options.report({ stage: 'skipping', message: '重复来源', scanned: 1 })
        await options.onCandidate(second)
        options.report({ stage: 'selecting', message: '第二频道完成目标', scanned: 2 })
        assert.equal(options.isTargetReached(), true)
      }
    },
    process: async id => { processed.push(getHistorySource(id)!.sourceVideoId); return completeDraft(id) },
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { urls }, targetCount: 2 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.deepEqual(visited, urls.slice(0, 2))
  assert.deepEqual(processed, [first.videoId, second.videoId])
  assert.deepEqual(result.counts, { scanned: 3, selected: 2, completed: 2, failed: 0 })
  assert.ok(result.events.some(event => event.stage === 'channel_exhausted' && /1\/3/.test(event.message)))
  assert.doesNotMatch(result.progressMessage!, /到底/)
})

test('YouTube cannot treat an unfinished later channel as whole-list exhaustion', async () => {
  let calls = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async options => { if (++calls === 1) options.report({ stage: 'exhausted', message: '第一频道到底', scanned: 4 }) },
  }))
  const { job } = startHistorySourceJob({ source: 'youtube', youtube: { urls: ['https://youtube.com/@first', 'https://youtube.com/@second'] }, targetCount: null })
  await worker()
  assert.equal(getHistorySourceJob(job.id)!.status, 'failed')
  assert.match(getHistorySourceJob(job.id)!.errorMessage!, /2\/2.*提前结束/)
})

test('stopping a YouTube task after one channel never opens another channel', async () => {
  let jobId: number, calls = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkYoutubeReadiness: async () => {},
    collectYoutube: async () => { calls++; stopHistorySourceJob(jobId) },
  }))
  jobId = startHistorySourceJob({ source: 'youtube', youtube: { urls: ['https://youtube.com/@first', 'https://youtube.com/@second'] }, targetCount: null }).job.id
  await worker()
  assert.equal(calls, 1)
  assert.equal(getHistorySourceJob(jobId)!.status, 'stopped')
})

test('starting collection without a live sourcing worker returns an actionable 503 and never leaves a queued task', async () => {
  db.delete(schema.workerHeartbeats).run()
  recordWorkerHeartbeat('worker-image-unrelated')
  assert.throws(() => startHistorySourceJob({ source: 'czgts', czgts: articleDates }), /采集执行器未运行/)
  const route = createHistorySourceJobsRoute()
  const response = await route.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'czgts', czgts: articleDates }) })
  assert.equal(response.status, 503)
  assert.match((await response.json()).message, /采集执行器未运行/)
  assert.equal(db.select().from(schema.creationTasks).all().length, 0)
  recordWorkerHeartbeat('history-sourcing-test')
  assert.equal(startHistorySourceJob({ source: 'czgts', czgts: articleDates }).job.status, 'queued')
})

test('old worker heartbeats cannot admit collection even when unrelated workers are healthy', () => {
  db.update(schema.workerHeartbeats).set({ lastSeenAt: '2020-01-01T00:00:00.000Z' }).run()
  recordWorkerHeartbeat('worker-image-healthy')
  assert.throws(() => startHistorySourceJob({}), /采集执行器未运行/)
  recordWorkerHeartbeat('worker-general-test')
  assert.equal(startHistorySourceJob({}).job.status, 'queued')
})

test('an unserved queued collection fails after the startup grace period, retains its record and can be started again', () => {
  const old = startHistorySourceJob({}).job
  const other = createTask({ type: 'unrelated.test', payload: {} })
  db.update(schema.creationTasks).set({ createdAt: '2020-01-01T00:00:00.000Z' }).where(eq(schema.creationTasks.id, old.id)).run()
  assert.equal(getHistorySourceJob(old.id)?.status, 'queued', 'a healthy busy worker can retain a queue')
  db.delete(schema.workerHeartbeats).run()
  const fresh = createTask({ type: HISTORY_SOURCING_TASK_TYPE, payload: {} })
  assert.equal(getHistorySourceJob(fresh.id)?.status, 'queued', 'allow worker restart time')
  const failed = getHistorySourceJob(old.id)!
  assert.equal(failed.status, 'failed')
  assert.match(failed.progressMessage!, /采集执行器未运行/)
  assert.match(failed.errorMessage!, /重新启动采集/)
  assert.equal(getTask(old.id)?.attempts, 0)
  assert.equal(getTask(other.id)?.status, 'queued')
  stopHistorySourceJob(fresh.id)
  recordWorkerHeartbeat('history-sourcing-test')
  const retry = startHistorySourceJob({})
  assert.equal(retry.created, true)
  assert.notEqual(retry.job.id, old.id)
  assert.equal(getHistorySourceJob(old.id)?.status, 'failed')
})

function article(id = '1879511407398993709') {
  return {
    articleId: id, sourceUrl: `https://baijiahao.baidu.com/s?id=${id}`, title: '历史原文', authorName: '作者',
    text: '第一段完整原文。\n第二段完整原文。', fetchedAt: '2026-10-21T08:00:00Z',
    metadata: { gid: '15971646304123075887', platform: '百家号', category: '历史', publishTime: '2026-10-20 15:53', keywords: ['明朝'] },
  }
}

function completeArticleDraft(id: number) {
  const source = getHistorySource(id)!
  assert.equal(source.platform, 'baijiahao')
  const correctedTranscript = `${source.rawTranscript}校对`
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  return updateHistorySource(id, {
    status: 'needs_review', correctedTranscript, rewrittenScript: `${correctedTranscript}二创`,
    reviewJson: JSON.stringify({ factCheckStatus: 'needs_sources', corrections: [], factualConcerns: [],
      rawTranscriptSha256: hash(source.rawTranscript!), correctedTranscriptSha256: hash(correctedTranscript), rewriteInputSha256: hash(correctedTranscript) }),
  })!
}

test('article configuration validates real calendar dates and leaves old Douyin jobs compatible', () => {
  assert.equal(historySourceJobConfigSchema.parse({}).source, 'douyin')
  assert.deepEqual(historySourceJobConfigSchema.parse({ source: 'czgts', czgts: articleDates }).czgts, articleDates)
  for (const input of [
    { source: 'czgts' }, { source: 'unknown' }, { czgts: articleDates },
    { source: 'czgts', czgts: { ...articleDates, startTime: '2026-02-30 00:00:00' } },
    { source: 'czgts', czgts: { ...articleDates, startTime: '2026-10-21 24:00:00' } },
    { source: 'czgts', czgts: { startTime: articleDates.endTime, endTime: articleDates.startTime } },
    { source: 'czgts', czgts: { ...articleDates, endTime: articleDates.startTime } },
  ]) assert.throws(() => historySourceJobConfigSchema.parse(input))
})

test('article jobs do not depend on the Douyin keyword settings file', () => {
  const previous = process.env.HISTORY_SOURCE_SETTINGS_FILE
  const file = join(mkdtempSync(join(tmpdir(), 'czgts-unrelated-keywords-')), 'settings.json')
  writeFileSync(file, '{invalid')
  process.env.HISTORY_SOURCE_SETTINGS_FILE = file
  try {
    assert.doesNotThrow(() => startHistorySourceJob({ source: 'czgts', czgts: articleDates }))
    assert.throws(() => startHistorySourceJob({ source: 'douyin' }), /读取失败/)
  } finally {
    if (previous === undefined) delete process.env.HISTORY_SOURCE_SETTINGS_FILE
    else process.env.HISTORY_SOURCE_SETTINGS_FILE = previous
  }
})

test('article jobs preserve full originals and recreate current drafts without invoking video readiness or browsing', async () => {
  storeHistorySource(candidate(article().articleId))
  const order: string[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: async () => { order.push('text readiness') },
    checkReadiness: async () => assert.fail('No video preflight'),
    browse: async () => assert.fail('No browser'),
    process: async (id, options) => {
      order.push('recreate')
      assert.equal(options?.through, 'recreate')
      assert.ok(options?.signal)
      assert.equal(getHistorySource(id)!.rawTranscript, article().text)
      assert.equal(getHistorySourceJob(job.id)!.counts.completed, 0)
      options?.onProgress?.({ stage: 'correcting', message: '正在校对文章' })
      options?.onProgress?.({ stage: 'rewriting', message: '正在二创文章' })
      return completeArticleDraft(id)
    },
    collectArticles: async options => {
      order.push('collect')
      assert.equal(options.isKnownArticle(article().articleId), false, 'Dedup is platform-qualified')
      assert.equal(options.startTime, articleDates.startTime)
      options.report({ stage: 'searching', message: '读取文章列表', scanned: 2 })
      assert.equal(await options.onArticle(article()), true)
      assert.equal(await options.onArticle(article('222')), false) // The job enforces its own target as well.
    },
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates, targetCount: 1 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.counts, { scanned: 2, selected: 1, completed: 1, failed: 0 })
  const source = getHistorySource(result.sourceIds[0])!
  assert.equal(source.rawTranscript, article().text)
  assert.equal(source.status, 'needs_review')
  assert.equal(getHistorySourceArtifactState(source).rewritten, 'current')
  assert.match(source.correctedTranscript!, /校对$/)
  assert.match(result.progressMessage!, /完成 1 篇二创待审稿/)
  assert.deepEqual(order, ['text readiness', 'collect', 'recreate'])
  assert.ok(result.events.some(event => event.stage === 'correcting'))
  assert.ok(result.events.some(event => event.stage === 'rewriting'))
  assert.equal(result.browserUrl, null)
})

test('article jobs preserve deleted identities and report exhaustion below target honestly', async () => {
  const deleted = storeHistoryArticleSource(article())
  deleteHistorySource(deleted.id)
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: async () => {},
    process: async id => completeArticleDraft(id),
    collectArticles: async options => {
      assert.equal(options.isKnownArticle(article().articleId), true)
      await options.onArticle(article())
      await options.onArticle(article('222'))
      options.report({ stage: 'exhausted', message: '范围已到底', scanned: 2 })
    },
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates, targetCount: 3 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.completed, 1)
  assert.match(result.progressMessage!, /少于目标 3 篇/)
  assert.equal(getHistorySource(deleted.id), null)
})

test('article authentication failure never becomes empty successful collection', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: async () => {},
    process: async () => assert.fail('No processing before collection succeeds'),
    collectArticles: async () => { throw new Error('CZGTS Cookie 已过期，请更新') },
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates, targetCount: null })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'failed')
  assert.match(result.errorMessage!, /Cookie 已过期/)
  assert.equal(result.counts.completed, 0)
})

test('article body failures are counted separately from skipped records and preserved in completion warnings', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: async () => {},
    process: async id => completeArticleDraft(id),
    collectArticles: async options => {
      options.report({ stage: 'article_skipped', message: '已入库，跳过', scanned: 1 })
      options.report({ stage: 'article_failed', message: '原文读取失败', scanned: 2 })
      await options.onArticle(article())
      options.report({ stage: 'exhausted', message: '范围已到底', scanned: 3 })
    },
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates, targetCount: null })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.counts, { scanned: 3, selected: 1, completed: 1, failed: 1 })
  assert.equal(result.events.find(event => event.stage === 'article_failed')?.level, 'warning')
  assert.equal(result.events.at(-1)?.level, 'warning')
  assert.match(result.progressMessage!, /1 篇文章正文读取失败，未入库/)
})

test('article cancellation preserves saved originals and aborts the pending API call', async () => {
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: async () => {},
    process: async id => completeArticleDraft(id),
    collectArticles: async options => {
      await options.onArticle(article())
      ready()
      await delay(10_000, undefined, { signal: options.signal })
      assert.fail('The API request should have been aborted')
    },
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates, targetCount: null })
  const running = worker()
  await started
  stopHistorySourceJob(job.id)
  await running
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'stopped')
  assert.equal(result.counts.completed, 1)
  assert.equal(getHistorySource(result.sourceIds[0])!.rawTranscript, article().text)
  assert.doesNotMatch(result.progressMessage!, /计费/)
})

test('article preflight only reads text configuration and fails before collection when text is unavailable', async () => {
  const requested: string[] = []
  await checkHistoryTextReadiness(new AbortController().signal, {
    getConfig: type => { requested.push(type); return { provider: 'text-provider', apiKey: 'mock-text-key' } },
  })
  assert.deepEqual(requested, ['text'])
  for (const config of [null, { provider: 'text-provider', apiKey: '' }]) {
    await assert.rejects(checkHistoryTextReadiness(new AbortController().signal, { getConfig: () => config }), /文本模型/)
  }
  const canceled = new AbortController()
  canceled.abort(new Error('stop before preflight'))
  await assert.rejects(checkHistoryTextReadiness(canceled.signal, { getConfig: () => assert.fail('No config read after cancellation') }), /stop before preflight/)
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: signal => checkHistoryTextReadiness(signal, { getConfig: () => null }),
    checkReadiness: async () => assert.fail('No video preflight'),
    collectArticles: async () => assert.fail('No collection without text configuration'),
    process: async () => assert.fail('No model call'),
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates })
  await worker()
  assert.equal(getHistorySourceJob(job.id)!.status, 'failed')
  assert.match(getHistorySourceJob(job.id)!.errorMessage!, /文本模型/)
  assert.equal(getHistorySourceJob(job.id)!.counts.selected, 0)
})

test('article production continues after read and recreation failures across pages, stopping at successful draft target', async () => {
  const ids = ['1879511407398993711', '1879511407398993712', '1879511407398993713', '1879511407398993714', '1879511407398993715']
  const rows = ids.map(id => ({ ...article(id).metadata, url: article(id).sourceUrl, title: '文章', authorName: '作者' }))
  const searches: number[] = [], fetched: string[] = [], processed: string[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: async () => {},
    checkReadiness: async () => assert.fail('No video preflight'),
    browse: async () => assert.fail('No browser'),
    collectArticles: options => {
      assert.equal(options.targetCount, 2)
      return collectCzgtsArticles(options, {
        pauseMs: 0,
        search: async input => {
          searches.push(input.offset!)
          assert.ok(searches.length <= 2, 'Target completion must stop before the next page')
          return { code: 0, total: 100, searchId: 'mock-search', list: input.offset === 0 ? rows.slice(0, 2) : rows.slice(2) }
        },
        fetchArticle: async url => {
          const id = new URL(url).searchParams.get('id')!
          fetched.push(id)
          if (id === ids[0]) throw new Error('body retrieval failed')
          return { text: article(id).text }
        },
      })
    },
    process: async (id, options) => {
      assert.equal(options?.through, 'recreate')
      const source = getHistorySource(id)!
      processed.push(source.sourceVideoId)
      if (source.sourceVideoId === ids[1]) {
        updateHistorySource(id, { status: 'failed', correctedTranscript: '已保存的校对检查点', lastError: '模拟二创失败' })
        throw new Error('模拟二创失败')
      }
      return completeArticleDraft(id)
    },
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates, targetCount: 2 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.counts, { scanned: 4, selected: 3, completed: 2, failed: 2 })
  assert.deepEqual(searches, [0, 2])
  assert.deepEqual(fetched, ids.slice(0, 4))
  assert.deepEqual(processed, ids.slice(1, 4))
  const retained = getHistorySource(result.sourceIds[0])!
  assert.equal(retained.rawTranscript, article().text)
  assert.equal(retained.correctedTranscript, '已保存的校对检查点')
  assert.equal(retained.status, 'failed')
  assert.match(result.progressMessage!, /1 篇文章正文读取失败，未入库/)
  assert.match(result.progressMessage!, /1 篇文章校对或二创失败，原文和已完成检查点保留/)
  const processingFailure = result.events.find(event => event.stage === 'source_failed')!
  assert.equal(processingFailure.level, 'warning')
  assert.doesNotMatch(processingFailure.message, /未入库/)
  assert.equal(result.events.at(-1)!.level, 'warning')
})

test('raw-only or stale processing results do not count as completed article drafts', async () => {
  let attempts = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: async () => {},
    collectArticles: async options => {
      assert.equal(await options.onArticle(article('111')), false)
      assert.equal(await options.onArticle(article('222')), false)
      assert.equal(await options.onArticle(article('333')), true)
      assert.equal(await options.onArticle(article('444')), false)
    },
    process: async id => {
      attempts++
      if (attempts === 1) return getHistorySource(id)!
      if (attempts === 2) return updateHistorySource(id, { status: 'needs_review', rewrittenScript: '缺少来源检查点的旧稿' })!
      return completeArticleDraft(id)
    },
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates, targetCount: 1 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.counts, { scanned: 0, selected: 3, completed: 1, failed: 2 })
  assert.equal(attempts, 3)
  assert.doesNotMatch(result.progressMessage!, /未入库/)
})

test('article jobs never process preexisting raw or completed drafts', async () => {
  const raw = storeHistoryArticleSource(article('111'))
  const prior = storeHistoryArticleSource(article('222'))
  completeArticleDraft(prior.id)
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: async () => {},
    process: async () => assert.fail('Existing sources must not be backfilled'),
    collectArticles: async options => {
      for (const id of ['111', '222']) {
        assert.equal(options.isKnownArticle(id), true)
        assert.equal(await options.onArticle(article(id)), false)
      }
      options.report({ stage: 'exhausted', message: '范围内全部已入库', scanned: 2 })
    },
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates, targetCount: 1 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.completed, 0)
  assert.equal(result.counts.selected, 0)
  assert.match(result.progressMessage!, /少于目标 1 篇/)
  assert.equal(getHistorySource(raw.id)!.status, 'article_saved')
  assert.equal(getHistorySource(prior.id)!.status, 'needs_review')
})

test('canceling during article recreation retains original and correction checkpoints without counting a failure', async () => {
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  let calls = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkTextReadiness: async () => {},
    collectArticles: async options => {
      await options.onArticle(article())
      assert.fail('Cancellation must stop collection before another article')
    },
    process: async (id, options) => {
      calls++
      assert.equal(options?.through, 'recreate')
      updateHistorySource(id, { status: 'corrected', correctedTranscript: '原文校对检查点', reviewJson: JSON.stringify({ checkpoint: 'corrected' }) })
      options?.onProgress?.({ stage: 'rewriting', message: '正在二创文章' })
      ready()
      await delay(10_000, undefined, { signal: options?.signal })
      assert.fail('Model fixture should have been aborted')
      return completeArticleDraft(id)
    },
  }))
  const { job } = startHistorySourceJob({ source: 'czgts', czgts: articleDates, targetCount: 2 })
  const running = worker()
  await started
  assert.equal(stopHistorySourceJob(job.id)!.status, 'stopping')
  await running
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'stopped')
  assert.deepEqual(result.counts, { scanned: 0, selected: 1, completed: 0, failed: 0 })
  assert.equal(calls, 1)
  const retained = getHistorySource(result.sourceIds[0])!
  assert.equal(retained.rawTranscript, article().text)
  assert.equal(retained.correctedTranscript, '原文校对检查点')
  assert.equal(retained.reviewJson, JSON.stringify({ checkpoint: 'corrected' }))
  assert.match(result.progressMessage!, /校对稿和二创检查点保留/)
})

test('Douyin dedup excludes only Douyin sources when an article shares a numeric ID', async () => {
  storeHistoryArticleSource(article('111'))
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      assert.equal(options.excludeVideoIds?.includes('111'), false)
      assert.equal(options.isKnownVideo?.('111'), false)
      return [candidate('111')]
    },
    process: async id => completeDraft(id),
  }))
  const { job } = startHistorySourceJob({})
  await worker()
  assert.equal(getHistorySourceJob(job.id)!.status, 'completed')
})

test('database provider filtering keeps Qwen narration selected while MiniMax transcription stays available',async t=>{
  const {getActiveConfig}=await import('./ai.js')
  const {resolveHistoryASRConfig}=await import('./history-asr-config.js')
  const ids:number[]=[]
  for(const [provider,priority,key] of [['minimax',1000,'mini-key'],['qwen-tts',1001,'qwen-key'],['minimax',1002,'']] as const) {
    ids.push(db.insert(schema.aiServiceConfigs).values({serviceType:'audio',provider,name:'ASR readiness regression',
      baseUrl:provider==='minimax'?'https://api.minimaxi.com':'https://dashscope.aliyuncs.com/api/v1',apiKey:key,
      model:'[]',priority,isActive:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    }).returning({id:schema.aiServiceConfigs.id}).get().id)
  }
  t.after(()=>{for(const id of ids)db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id,id)).run()})
  assert.equal(getActiveConfig('audio','minimax')?.apiKey,'mini-key','empty keys must not mask a usable same-provider config')
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id,ids.pop()!)).run()
  assert.equal(getActiveConfig('audio')?.provider,'qwen-tts','the existing narration preference must not change')
  const selected=await resolveHistoryASRConfig({env:{}})
  assert.equal(selected.provider,'minimax');assert.equal(selected.apiKey,'mini-key')
  const backup=await resolveHistoryASRConfig({env:{},provider:'qwen'})
  assert.equal(backup.provider,'qwen');assert.equal(backup.apiKey,'qwen-key')
})

test('collection preflight accepts configured Qwen ASR when Qwen TTS has higher audio priority', async t => {
  for (const [name,value] of Object.entries({ASR_PROVIDER:'qwen',QWEN_API_KEY:'test-qwen-asr-key'})) {
    const prior=process.env[name];process.env[name]=value
    t.after(()=>{if(prior===undefined)delete process.env[name];else process.env[name]=prior})
  }
  const requests:string[]=[]
  await checkHistorySourceReadiness(new AbortController().signal, {
    getConfig: type=>({provider:type==='audio'?'qwen-tts':'text-provider',apiKey:'configured'}),
    checkTool: async()=>{},
    readDownloaderConnection:async()=>({baseUrl:'http://127.0.0.1:9125',apiKey:'downloader-key'}),
    fetch:async input=>{requests.push(String(input));return new Response('{}')},
  })
  assert.deepEqual(requests,['http://127.0.0.1:9125/api/v1/auth/me'],'readiness must not spend provider quota')
})

test('real collection preflight succeeds when only the downloader HTTP service is available', async () => {
  const checkedTools: string[] = []
  const requests: string[] = []
  await checkHistorySourceReadiness(new AbortController().signal, {
    getConfig: type => ({ provider: type === 'audio' ? 'minimax' : 'text-provider', apiKey: 'test-key' }),
    checkTool: async tool => { checkedTools.push(tool) },
    readDownloaderConnection: async () => ({ baseUrl: 'http://127.0.0.1:9125', apiKey: 'downloader-key' }),
    fetch: async (input, init) => {
      const url = String(input)
      requests.push(url)
      // Every service other than the downloader, including LM Studio, is offline.
      if (url !== 'http://127.0.0.1:9125/api/v1/auth/me') throw new Error('ECONNREFUSED')
      assert.equal(new Headers(init?.headers).get('X-API-Key'), 'downloader-key')
      return new Response('{}')
    },
  })
  assert.deepEqual(checkedTools, ['ffmpeg', 'ffprobe'])
  assert.deepEqual(requests, ['http://127.0.0.1:9125/api/v1/auth/me'])
})

test('collection preflight still rejects missing transcription, correction, tools, and downloader authentication', async () => {
  const ready = {
    getConfig: (type: 'audio' | 'text') => ({ provider: type === 'audio' ? 'minimax' : 'text-provider', apiKey: 'test-key' }),
    checkTool: async () => {},
    readDownloaderConnection: async () => ({ baseUrl: 'http://127.0.0.1:9125', apiKey: 'downloader-key' }),
    fetch: async () => new Response('{}'),
  }
  const check = (overrides: Parameters<typeof checkHistorySourceReadiness>[1]) => checkHistorySourceReadiness(new AbortController().signal, { ...ready, ...overrides })
  await assert.rejects(check({ getConfig: type => type === 'audio' ? null : ready.getConfig(type) }), /MiniMax/)
  await assert.rejects(check({ getConfig: type => type === 'text' ? null : ready.getConfig(type) }), /文本模型/)
  await assert.rejects(check({ checkTool: async () => { throw new Error('ffmpeg not installed') } }), /ffmpeg/)
  await assert.rejects(check({ fetch: async () => new Response('{}', { status: 401 }) }), /下载器不可用或认证失败/)
})

test('collection keeps deleted source IDs excluded instead of downloading them again', async () => {
  const deleted = storeHistorySource(candidate('111'))
  deleteHistorySource(deleted.id)
  const processed: number[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      assert.ok(options.excludeVideoIds?.includes(deleted.sourceVideoId))
      assert.equal(options.isKnownVideo?.(deleted.sourceVideoId), true)
      return [candidate('111'), candidate('222')]
    },
    process: async id => { processed.push(id); return completeDraft(id) },
  }))
  const { job } = startHistorySourceJob({ categories: ['regional_history'] })
  await worker()
  assert.equal(getHistorySourceJob(job.id)?.status, 'completed')
  assert.equal(processed.length, 1)
  assert.equal(getHistorySource(processed[0])?.sourceVideoId, '222')
  assert.equal(getHistorySource(deleted.id), null)
  assert.ok(db.select().from(schema.historyScriptSources).where(eq(schema.historyScriptSources.id, deleted.id)).get()?.deletedAt)
})

test('queued collection stops immediately without an execution worker and repeated stops stay idempotent', () => {
  const first = startHistorySourceJob({})
  db.delete(schema.workerHeartbeats).run()
  const stopped = stopHistorySourceJob(first.job.id)!
  assert.equal(stopped.status, 'stopped')
  assert.equal(getTask(first.job.id)?.status, 'canceled')
  assert.equal(getTask(first.job.id)?.attempts, 0)
  assert.match(stopped.progressMessage!, /已停止.*保留/)
  assert.equal(stopHistorySourceJob(first.job.id)?.status, 'stopped')
  recordWorkerHeartbeat('history-sourcing-test')
  assert.notEqual(startHistorySourceJob({}).job.id, first.job.id)
})

test('only one active job can be queued until it is stopped', async () => {
  const first = startHistorySourceJob({})
  assert.equal(first.created, true)
  assert.equal(startHistorySourceJob({ targetCount: 3 }).job.id, first.job.id)
  assert.equal(startHistorySourceJob({}).created, false)
  assert.equal(stopHistorySourceJob(first.job.id)?.status, 'stopped')
  assert.equal(getHistorySourceJob(first.job.id)?.status, 'stopped')
  assert.notEqual(startHistorySourceJob({}).job.id, first.job.id)
})

test('job configuration accepts up to four digits and an explicit continuous target', () => {
  assert.equal(startHistorySourceJob({ targetCount: 1234 }).job.targetCount, 1234)
  assert.doesNotThrow(() => startHistorySourceJob({ targetCount: 9999 }))
  assert.throws(() => startHistorySourceJob({ targetCount: 10_000 }))
  assert.throws(() => startHistorySourceJob({ targetCount: 0 }))
  assert.throws(() => startHistorySourceJob({ targetCount: 1.5 }))
  db.delete(schema.creationTasks).run()
  const continuous = startHistorySourceJob({ targetCount: null }).job
  assert.equal(continuous.targetCount, null)
  assert.equal(continuous.config.targetCount, null)
})

test('a job snapshots the saved keywords and preserves their order through execution', async () => {
  writeHistorySourceSettings({ keywords: ['历史', '明朝'] })
  try {
    const { job } = startHistorySourceJob({})
    writeHistorySourceSettings({ keywords: ['清朝'] })
    assert.deepEqual(getHistorySourceJob(job.id)?.config.keywords, ['历史', '明朝'])
    registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
      checkReadiness: async () => {},
      browse: async options => {
        assert.deepEqual(options.keywords, ['历史', '明朝'])
        options.report({ stage: 'exhausted', message: '所有关键词已搜索完毕', scanned: 0 })
        return []
      },
    }))
    await worker()
    assert.equal(getHistorySourceJob(job.id)?.status, 'completed')
    assert.deepEqual(startHistorySourceJob({ keywords: [' 唐朝 '] }).job.config.keywords, ['唐朝'])
    for (const keywords of [[], ['历史', ' 历史 '], [' '.repeat(2)]]) assert.throws(() => startHistorySourceJob({ keywords }))
  } finally { writeHistorySourceSettings({ keywords: ['历史'] }) }
})

test('finishing one keyword does not report the entire job exhausted', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => { options.report({ stage: 'keyword_exhausted', message: '历史已经到底' }); return [] },
  }))
  const { job } = startHistorySourceJob({ keywords: ['历史', '明朝'] })
  await worker()
  assert.equal(getHistorySourceJob(job.id)?.status, 'failed')
})

test('monitoring distinguishes the worker lease heartbeat from business progress and never exposes ownership secrets', () => {
  const { job } = startHistorySourceJob({})
  assert.equal(getHistorySourceJob(job.id)!.workerHealth, 'inactive')
  assert.equal(getHistorySourceJob(job.id)!.heartbeatAt, null)
  const task = claimQueuedTask(job.id, { workerId: 'monitor-worker', leaseMs: 60_000 })!
  assert.equal(getHistorySourceJob(job.id)!.workerHealth, 'stale', 'a valid lease without a live worker does not prove the process is alive')
  recordWorkerHeartbeat('monitor-worker')
  assert.equal(getHistorySourceJob(job.id)!.workerHealth, 'alive')
  assert.equal(getHistorySourceJob(job.id)!.heartbeatAt, null)
  assert.ok(extendTaskLease(task.id, task.leaseOwner!, task.leaseToken!, 60_000))
  const heartbeat = db.select().from(schema.creationTaskEvents).where(eq(schema.creationTaskEvents.taskId, task.id)).all().find(row => row.eventType === 'heartbeat')!
  const status = getHistorySourceJob(task.id)!
  assert.equal(status.heartbeatAt, heartbeat.createdAt)
  assert.equal(status.leaseExpiresAt, getTask(task.id)!.leaseExpiresAt)
  assert.equal(status.progressAt, null)
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${task.leaseToken}|monitor-worker`))
  db.update(schema.workerHeartbeats).set({ lastSeenAt: '2000-01-01T00:00:00.000Z' }).run()
  assert.equal(getHistorySourceJob(task.id)!.workerHealth, 'stale', 'a valid lease cannot hide a missing process heartbeat')
  recordWorkerHeartbeat('monitor-worker')
  db.update(schema.creationTasks).set({ leaseExpiresAt: '2000-01-01T00:00:00.000Z', updatedAt: new Date().toISOString() }).where(eq(schema.creationTasks.id, task.id)).run()
  assert.equal(getHistorySourceJob(task.id)!.workerHealth, 'stale', 'a recent API/progress update must not hide an expired lease')
})

test('long login waits retain the last business stage and logs even after hundreds of heartbeat events', () => {
  const { job } = startHistorySourceJob({})
  const task = claimQueuedTask(job.id, { workerId: 'monitor-worker', leaseMs: 60_000 })!
  recordWorkerHeartbeat('monitor-worker')
  const progress = appendTaskEvent(task.id, 'history.progress', {
    stage: 'waiting_login', message: '等待程序检测登录，当前不采集', level: 'info',
    counts: { scanned: 7, selected: 0, completed: 0, failed: 0 }, currentSourceId: null,
    currentTitle: null, sourceIds: [], browserUrl: 'https://www.douyin.com/',
  })
  for (let index = 0; index < 130; index++) assert.ok(extendTaskLease(task.id, task.leaseOwner!, task.leaseToken!, 60_000))
  const status = getHistorySourceJob(task.id)!
  assert.equal(status.stage, 'waiting_login')
  assert.equal(status.progressAt, progress.createdAt)
  assert.equal(status.counts.scanned, 7)
  assert.equal(status.events.length, 1)
  assert.equal(status.events[0]!.message, '等待程序检测登录，当前不采集')
  assert.equal(status.workerHealth, 'alive')
})

test('monitoring translates the former manual-confirmation button in existing login-wait logs', () => {
  const { job } = startHistorySourceJob({})
  appendTaskEvent(job.id, 'history.progress', {
    stage: 'waiting_login', message: '完成登录后点击“已登录，继续采集”', level: 'info',
    counts: { scanned: 0, selected: 0, completed: 0, failed: 0 }, currentSourceId: null,
    currentTitle: null, sourceIds: [], browserUrl: null,
  })
  const status = getHistorySourceJob(job.id)!
  assert.equal(status.progressMessage, '完成登录后点击“检测登录状态”')
  assert.equal(status.events[0]!.message, '完成登录后点击“检测登录状态”')
})

test('worker performs real stages through injectable boundaries and retains drafts and progress after reload', async () => {
  const existing = storeHistorySource(candidate('111'))
  const order: string[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => { order.push('preflight') },
    browse: async options => {
      order.push('browser')
      assert.deepEqual(options.excludeVideoIds, [existing.sourceVideoId])
      options.report({ stage: 'browsing', message: 'Observe actual page', scanned: 4 })
      return [candidate(), candidate()]
    },
    process: async (id, options) => {
      assert.equal(options?.through, 'recreate')
      order.push('process')
      options?.onProgress?.({ stage: 'correcting', message: '校对转写' })
      options?.onProgress?.({ stage: 'rewriting', message: '按 water-koubo 技能二创' })
      const draft = completeDraft(id)
      return updateHistorySource(id, {
        rewrittenScript: 'Recreated narration',
        reviewJson: JSON.stringify({ ...JSON.parse(draft.reviewJson!), draftOrigin: 'water_koubo' }),
      })!
    },
  }))
  const { job } = startHistorySourceJob({ categories: ['regional_history'] })
  await worker()
  const completed = getHistorySourceJob(job.id)!
  assert.deepEqual(order, ['preflight', 'browser', 'process'])
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.counts, { scanned: 4, selected: 1, completed: 1, failed: 0 })
  assert.ok(completed.events.some(event => event.stage === 'correcting'))
  assert.ok(completed.events.some(event => event.stage === 'rewriting'))
  assert.equal(getHistorySource(completed.sourceIds[0])?.status, 'needs_review')
  assert.equal(getHistorySource(completed.sourceIds[0])?.rewrittenScript, 'Recreated narration')
  const response = await createHistorySourceJobsRoute().request(`/${job.id}`)
  assert.equal((await response.json()).data.job.status, 'completed')
})

test('each streamed candidate is processed before browsing resumes without duplicating returned candidates', async () => {
  const order: string[] = []
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      assert.ok(options.onCandidate, 'A source must be processed at selection time')
      const first = candidate('111'), second = candidate('222')
      options.report({ stage: 'selecting', message: 'First selection', selected: 1, scanned: 3 })
      await options.onCandidate(first)
      order.push('browse-after-first')
      assert.equal(getHistorySourceJob(job.id)?.counts.completed, 1)
      options.report({ stage: 'browsing', message: 'Continue scrolling', selected: 1, scanned: 7 })
      options.report({ stage: 'selecting', message: 'Second selection', selected: 2 })
      await options.onCandidate(second)
      return [first, second]
    },
    process: async id => { order.push('process'); return completeDraft(id) },
  }))
  const { job } = startHistorySourceJob({ targetCount: 2 })
  await worker()
  assert.deepEqual(order, ['process', 'browse-after-first', 'process'])
  assert.equal(getHistorySourceJob(job.id)?.status, 'completed')
  assert.deepEqual(getHistorySourceJob(job.id)?.counts, { scanned: 7, selected: 2, completed: 2, failed: 0 })
})

test('legacy category settings cannot reject a metric-selected unclassified image note', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async () => [{
      ...candidate('555'), sourceType: 'note', sourceText: '图文完整正文', category: 'unclassified',
      metrics: { likes: 10_000, comments: 20 },
    }],
    process: async id => completeDraft(id),
  }))
  const { job } = startHistorySourceJob({ categories: ['regional_history'], targetCount: 1 })
  await worker()
  const completed = getHistorySourceJob(job.id)!
  assert.equal(completed.status, 'completed')
  assert.equal(completed.counts.completed, 1)
  const source = getHistorySource(completed.sourceIds[0])!
  assert.equal(source.category, 'unclassified')
  assert.equal(source.sourceUrl, 'https://www.douyin.com/note/555')
})

test('preflight failure cannot browse, download, or call models', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => { throw new Error('下载器不可用或认证失败') },
    browse: async () => { assert.fail('Must not browse'); return [] },
    process: async () => { throw new Error('Must not process') },
  }))
  const { job } = startHistorySourceJob({})
  await worker()
  assert.equal(getHistorySourceJob(job.id)?.status, 'failed')
  assert.match(getHistorySourceJob(job.id)!.errorMessage!, /下载器不可用/)
  assert.equal(db.select().from(schema.historyScriptSources).all().length, 0)
})

test('collection cannot count a corrected transcript as complete without the draft provenance checkpoints', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async () => [candidate()],
    process: async id => updateHistorySource(id, {
      status: 'needs_review', rawTranscript: 'Raw narration', correctedTranscript: 'Corrected narration', rewrittenScript: 'Corrected narration',
      reviewJson: JSON.stringify({ draftOrigin: 'corrected_transcript' }),
    })!,
  }))
  const { job } = startHistorySourceJob({})
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'failed')
  assert.equal(result.counts.completed, 0)
  assert.equal(result.counts.failed, 1)
  assert.ok(result.events.some(event => event.stage === 'source_failed' && /完整检查点/.test(event.message)))
})

test('waiting-login jobs remain observable and stopping aborts browser execution before processing', async () => {
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      options.report({ stage: 'waiting_login', message: 'Login is needed', browserUrl: 'https://www.douyin.com/' })
      ready()
      await delay(10_000, undefined, { signal: options.signal })
      assert.fail('Browse should be aborted')
      return []
    },
    process: async () => { throw new Error('Must not spend on ASR') },
  }))
  const { job } = startHistorySourceJob({})
  const running = worker()
  await started
  assert.equal(getHistorySourceJob(job.id)?.stage, 'waiting_login')
  assert.equal(stopHistorySourceJob(job.id)?.status, 'stopping')
  await running
  assert.equal(getHistorySourceJob(job.id)?.status, 'stopped')
  assert.equal(getHistorySourceJob(job.id)?.sourceIds.length, 0)
})

test('array candidates continue after a failed source, preserve checkpoints and stop at the completed target', async () => {
  let calls = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {}, browse: async () => [candidate('111'), candidate('222'), candidate('333'), candidate('444')],
    process: async id => {
      if (++calls !== 2) return completeDraft(id)
      updateHistorySource(id, { correctedTranscript: 'Preserved correction' })
      throw new Error('ASR unavailable')
    },
  }))
  const { job } = startHistorySourceJob({ targetCount: 2 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.counts, { scanned: 0, selected: 3, completed: 2, failed: 1 })
  assert.equal(getHistorySource(result.sourceIds[0])?.status, 'needs_review')
  assert.equal(getHistorySource(result.sourceIds[1])?.correctedTranscript, 'Preserved correction')
  const failure = result.events.find(event => event.stage === 'source_failed')!
  assert.equal(failure.level, 'warning')
  assert.equal(failure.currentSourceId, result.sourceIds[1])
  assert.match(failure.message, new RegExp(`#${result.sourceIds[1]}.*ASR unavailable.*继续`))
  assert.match(result.progressMessage!, /失败 1 条/)
  assert.equal(await worker(), false)
  assert.equal(calls, 3)
  assert.equal(db.select().from(schema.historyScriptSources).all().length, 3)
})

test('streaming failure continues to the next source until the number of completed drafts reaches target', async () => {
  let calls = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      assert.equal(options.isTargetReached?.(), false)
      await options.onCandidate!(candidate('111'))
      assert.equal(options.isTargetReached?.(), false, 'failed selection does not meet the completed target')
      await options.onCandidate!(candidate('222'))
      assert.equal(options.isTargetReached?.(), true)
      return [candidate('111'), candidate('222')]
    },
    process: async id => { if (++calls === 1) throw new Error('ASR unavailable'); return completeDraft(id) },
  }))
  const { job } = startHistorySourceJob({ targetCount: 1 })
  await worker()
  assert.equal(calls, 2)
  assert.equal(getHistorySourceJob(job.id)?.status, 'completed')
  assert.deepEqual(getHistorySourceJob(job.id)?.counts, { scanned: 0, selected: 2, completed: 1, failed: 1 })
})

test('browser return without an explicit exhaustion signal fails unfinished and continuous jobs while preserving drafts', async () => {
  for (const targetCount of [2, null]) {
    registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
      checkReadiness: async () => {},
      browse: async options => {
        assert.equal(options.targetCount, targetCount)
        await options.onCandidate!(candidate(String(targetCount ?? 333)))
        return []
      },
      process: async id => completeDraft(id),
    }))
    const { job } = startHistorySourceJob({ targetCount })
    await worker()
    const result = getHistorySourceJob(job.id)!
    assert.equal(result.status, 'failed')
    assert.equal(result.counts.completed, 1)
    assert.match(result.errorMessage!, /没有更多.*新视频/)
    assert.equal(getHistorySource(result.sourceIds[0])?.status, 'needs_review')
  }
})

test('a fatal browser failure after a recoverable source failure still terminates with both reasons retained', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      await options.onCandidate!(candidate('111'))
      throw new Error('Browser disconnected')
    },
    process: async () => { throw new Error('Source audio invalid') },
  }))
  const { job } = startHistorySourceJob({ targetCount: 1 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'failed')
  assert.equal(result.counts.failed, 1)
  assert.match(result.errorMessage!, /Browser disconnected.*失败 1 条/)
  assert.ok(result.events.some(event => event.stage === 'source_failed' && /Source audio invalid/.test(event.message)))
})

for (const targetCount of [2, null]) {
  for (const completed of [0, 1]) {
    test(`confirmed search exhaustion completes target ${targetCount} with ${completed} drafts and an honest final message`, async () => {
      registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
        checkReadiness: async () => {},
        browse: async options => {
          if (completed) await options.onCandidate!(candidate('111'))
          options.report({ stage: 'exhausted', message: '搜索结果显示“暂时没有更多了”', scanned: 28 })
          return []
        },
        process: async id => completeDraft(id),
      }))
      const { job } = startHistorySourceJob({ targetCount })
      await worker()
      const result = getHistorySourceJob(job.id)!
      assert.equal(result.status, 'completed')
      assert.equal(result.stage, 'completed')
      assert.equal(result.errorMessage, null)
      assert.deepEqual(result.counts, { scanned: 28, selected: completed, completed, failed: 0 })
      assert.match(result.progressMessage!, /搜索结果已到底/)
      assert.match(result.progressMessage!, new RegExp(`已保存 ${completed} 条待审稿`))
      if (targetCount !== null) assert.match(result.progressMessage!, /尚未达到目标 2 条/)
      else assert.doesNotMatch(result.progressMessage!, /尚未达到|达标/)
      assert.equal(result.events.at(-1)?.stage, 'completed')
      if (completed) assert.equal(getHistorySource(result.sourceIds[0])?.status, 'needs_review')
    })
  }
}

test('confirmed exhaustion reports every failed source and zero saved drafts without calling the collection successful', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      await options.onCandidate!(candidate('111'))
      await options.onCandidate!(candidate('222'))
      options.report({ stage: 'exhausted', message: '搜索结果显示“暂时没有更多了”' })
      return []
    },
    process: async () => { throw new Error('ASR unavailable') },
  }))
  const { job } = startHistorySourceJob({ targetCount: null })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'completed')
  assert.equal(result.counts.failed, 2)
  assert.equal(result.counts.completed, 0)
  assert.equal(result.errorMessage, null)
  assert.equal(result.events.filter(event => event.stage === 'source_failed').length, 2)
  assert.equal(result.events.at(-1)?.level, 'warning')
  assert.match(result.progressMessage!, /搜索结果已到底.*已保存 0 条待审稿.*失败 2 条/)
  assert.doesNotMatch(result.progressMessage!, /采集成功/)
})

test('confirmed exhaustion cannot hide a later browser failure or user stop', async () => {
  for (const stop of [false, true]) {
    registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
      checkReadiness: async () => {},
      browse: async options => {
        options.report({ stage: 'exhausted', message: '搜索结果显示“暂时没有更多了”' })
        if (!stop) throw new Error('Browser disconnected after exhaustion')
        stopHistorySourceJob(job.id)
        return []
      },
      process: async () => { throw new Error('Must not process any source') },
    }))
    const { job } = startHistorySourceJob({ targetCount: null })
    await worker()
    const result = getHistorySourceJob(job.id)!
    assert.equal(result.status, stop ? 'stopped' : 'failed')
    assert.equal(result.events.some(event => event.stage === 'completed'), false)
    if (!stop) assert.match(result.errorMessage!, /Browser disconnected after exhaustion/)
  }
})

test('continuous collection keeps cumulative counts and only the latest 100 source references until manual stop', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      assert.equal(options.targetCount, null)
      for (let index = 1; index <= 101; index++) {
        options.report({ stage: 'browsing', message: 'Scroll to new results', scanned: index * 3, selected: index - 1 })
        await options.onCandidate!(candidate(String(index)))
      }
      stopHistorySourceJob(job.id)
      options.signal.throwIfAborted()
      return []
    },
    process: async id => completeDraft(id),
  }))
  const { job } = startHistorySourceJob({ targetCount: null })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'stopped')
  assert.deepEqual(result.counts, { scanned: 303, selected: 101, completed: 101, failed: 0 })
  assert.equal(result.sourceIds.length, 100)
  assert.equal(getHistorySource(result.sourceIds[0])?.sourceVideoId, '2')
  assert.equal(getHistorySource(result.sourceIds.at(-1)!)?.sourceVideoId, '101')
})

test('stopping during source processing preserves its transcript checkpoint and does not select another source', async () => {
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => { await options.onCandidate!(candidate()); assert.fail('Processing must be canceled before browsing resumes'); return [] },
    process: async (id, options) => {
      updateHistorySource(id, { rawTranscript: 'Durable ASR checkpoint' })
      ready()
      await delay(10_000, undefined, { signal: options?.signal })
      assert.fail('Processing should be aborted')
      return completeDraft(id)
    },
  }))
  const { job } = startHistorySourceJob({ targetCount: null })
  const running = worker()
  await started
  assert.equal(stopHistorySourceJob(job.id)?.status, 'stopping')
  assert.equal(startHistorySourceJob({}).job.id, job.id, 'a running task remains the control target until cancellation is acknowledged')
  await running
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'stopped')
  assert.equal(result.counts.failed, 0)
  assert.equal(result.counts.completed, 0)
  assert.equal(getHistorySource(result.sourceIds[0])?.rawTranscript, 'Durable ASR checkpoint')
})

test('stopping after a recoverable failure prevents the next array candidate from processing', async () => {
  let calls = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async () => [candidate('111'), candidate('222'), candidate('333')],
    process: async id => {
      calls++
      updateHistorySource(id, { correctedTranscript: 'Preserved correction' })
      if (calls === 1) throw new Error('Invalid source audio')
      stopHistorySourceJob(job.id)
      throw new Error('Source operation canceled')
    },
  }))
  const { job } = startHistorySourceJob({ targetCount: 2 })
  await worker()
  const result = getHistorySourceJob(job.id)!
  assert.equal(result.status, 'stopped')
  assert.equal(calls, 2)
  assert.deepEqual(result.counts, { scanned: 0, selected: 2, completed: 0, failed: 1 })
  assert.equal(result.events.filter(event => event.stage === 'source_failed').length, 1)
  assert.match(result.progressMessage!, /任务已停止.*失败 1 条/)
  assert.equal(getHistorySource(result.sourceIds[1])?.correctedTranscript, 'Preserved correction')
})

test('existing sources returned by a browser adapter are never reimported or reprocessed', async () => {
  const existing = storeHistorySource(candidate())
  completeDraft(existing.id)
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {}, browse: async () => [candidate()],
    process: async () => { throw new Error('Do not rewrite old drafts') },
  }))
  const { job } = startHistorySourceJob({})
  await worker()
  assert.equal(getHistorySourceJob(job.id)?.status, 'failed')
  assert.equal(getHistorySource(existing.id)?.rewrittenScript, 'Rewritten narration')
})

test('browser deduplication observes database additions made after a job starts', async () => {
  let calls = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      assert.ok(options.isKnownVideo)
      assert.equal(options.isKnownVideo('222'), false)
      storeHistorySource(candidate('222'))
      assert.equal(options.isKnownVideo('222'), true)
      await options.onCandidate!(candidate('222'))
      await options.onCandidate!(candidate('111'))
      assert.equal(options.isKnownVideo('111'), true)
      return [candidate('111'), candidate('222')]
    },
    process: async id => { calls++; return completeDraft(id) },
  }))
  const { job } = startHistorySourceJob({})
  await worker()
  assert.equal(getHistorySourceJob(job.id)?.status, 'completed')
  assert.equal(getHistorySourceJob(job.id)?.counts.selected, 1)
  assert.equal(calls, 1)
})

test('recovery marks only expired history jobs interrupted without restarting paid operations', () => {
  const { job } = startHistorySourceJob({})
  const other = createTask({ type: 'unrelated.test', payload: {} })
  for (const id of [job.id, other.id]) db.update(schema.creationTasks).set({ status: 'running', leaseExpiresAt: '2020-01-01T00:00:00.000Z' }).where(eq(schema.creationTasks.id, id)).run()
  assert.equal(recoverHistorySourceJobs(), 1)
  assert.equal(getHistorySourceJob(job.id)?.status, 'interrupted')
  assert.equal(getTask(other.id)?.status, 'running')
  assert.equal(recoverHistorySourceJobs(), 0)
})

test('the shared backend worker executes history jobs without duplicating concurrent start requests', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async () => { calls++; entered(); await blocked; return [candidate()] },
    process: async id => completeDraft(id),
  }))
  const { job } = startHistorySourceJob({})
  const first = runWorkerOnce({ workerId: 'shared-backend-1' })
  try {
    await started
    const duplicate = startHistorySourceJob({ targetCount: 1 })
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.job.id, job.id)
    assert.equal(await runWorkerOnce({ workerId: 'shared-backend-2' }), false)
    assert.equal(calls, 1)
  } finally {
    release()
    await first
  }
  assert.equal(getHistorySourceJob(job.id)?.status, 'completed')
})

test('shared backend recovery interrupts expired history jobs without rerunning paid operations', async () => {
  let calls = 0
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => { calls++ },
  }))
  const { job } = startHistorySourceJob({})
  claimQueuedTask(job.id, { workerId: 'old-history-worker', leaseMs: 60_000 })
  assert.equal(recoverExpiredRunningTasks().markedStale, 0)
  db.update(schema.creationTasks).set({ leaseExpiresAt: '2020-01-01T00:00:00.000Z' })
    .where(eq(schema.creationTasks.id, job.id)).run()
  assert.equal(recoverExpiredRunningTasks().markedStale, 1)
  assert.equal(getHistorySourceJob(job.id)?.status, 'interrupted')
  assert.equal(await runWorkerOnce({ workerId: 'shared-backend' }), false)
  assert.equal(calls, 0)
})

test('routes enforce bounded input, local origins, JSON writes, and history task ownership', async () => {
  const route = createHistorySourceJobsRoute()
  const request = (url: string, body: unknown, origin = 'http://localhost:3013') => route.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
  assert.equal((await request('/', { targetCount: 10_000 })).status, 400)
  assert.equal((await request('/', { categories: [] })).status, 400)
  assert.equal((await request('/', { categories: ['regional_history', 'regional_history'] })).status, 400)
  assert.equal((await request('/', {}, 'https://example.com')).status, 403)
  assert.equal((await route.request('/', { method: 'POST', body: '{}' })).status, 400)
  const other = createTask({ type: 'unrelated.test', payload: {} })
  assert.equal((await request(`/${other.id}/stop`, {})).status, 404)
  assert.equal(getTask(other.id)?.cancelRequested, false)
  const created = await request('/', {})
  assert.equal(created.status, 200)
  const id = (await created.json()).data.job.id
  const stopped = await request(`/${id}/stop`, {})
  assert.equal(stopped.status, 200)
  assert.equal((await stopped.json()).data.job.status, 'stopped')
  assert.equal((await (await request(`/${id}/stop`, {})).json()).data.job.status, 'stopped')
  assert.equal((await route.request('/abc')).status, 400)
  assert.equal((await route.request('/999999')).status, 404)
})

test('task error messages redact credentials, signed URLs and local paths', () => {
  const message = safeHistoryJobMessage(new Error('Bearer secret-token https://example.com/path?token=secret /Users/local/private/file.wav'))
  assert.ok(!message.includes('secret-token'))
  assert.ok(!message.includes('token=secret'))
  assert.ok(!message.includes('/Users/'))
})

function progressSnapshot(index = 0) {
  return {
    stage: 'browsing', message: `Observed video ${index}`, level: 'info',
    counts: { scanned: index, selected: 0, completed: 0, failed: 0 },
    currentSourceId: null, currentTitle: null, sourceIds: [], browserUrl: 'https://www.douyin.com/',
  }
}

test('monitoring loads redaction keys once per response and observes key rotation on the next request', t => {
  const firstKey = 'monitoring-private-model-key', nextKey = 'rotated-private-model-key'
  const timestamp = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'text', provider: 'openai',
    name: 'Monitoring redaction', baseUrl: 'https://example.test', apiKey: firstKey,
    isActive: true, createdAt: timestamp, updatedAt: timestamp }).returning({ id: schema.aiServiceConfigs.id }).get()
  t.after(() => db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, config.id)).run())
  const jobs = [startHistorySourceJob({}).job, createTask({ type: HISTORY_SOURCING_TASK_TYPE, payload: {} })]
  const snapshot = (key: string) => ({ ...progressSnapshot(), stage: `browsing ${key}`, message: `Progress ${key}`,
    currentTitle: `Title ${key}`, candidate: { outcome: 'selected', videoId: '123', title: `Candidate ${key}`,
      reason: `Reason ${key}`, titleEvidence: `Evidence ${key}`, curiosityAngle: `Angle ${key}`,
      comments: [{ text: `Comment ${key}`, likes: 1 }] } })
  for (const job of jobs) {
    for (let index = 0; index < 3; index++) appendTaskEvent(job.id, 'history.progress', snapshot(firstKey))
  }
  db.update(schema.creationTasks).set({ status: 'failed', errorMessage: `Failure ${firstKey}` })
    .where(eq(schema.creationTasks.id, jobs[1]!.id)).run()
  const prepare = db.$client.prepare.bind(db.$client)
  let keyQueries = 0
  t.mock.method(db.$client, 'prepare', (query: string) => {
    if (/^select "api_key" from "ai_service_configs"/i.test(query)) keyQueries++
    return prepare(query)
  })
  for (const read of [() => listHistorySourceJobs(), () => getHistorySourceJob(jobs[0]!.id),
    () => listHistorySourceJobEvents(jobs[0]!.id)]) {
    keyQueries = 0
    const response = JSON.stringify(read())
    assert.equal(response.includes(firstKey), false)
    assert.ok(response.includes('[redacted]'))
    assert.equal(keyQueries, 1)
  }
  db.update(schema.aiServiceConfigs).set({ apiKey: nextKey }).where(eq(schema.aiServiceConfigs.id, config.id)).run()
  appendTaskEvent(jobs[0]!.id, 'history.progress', snapshot(nextKey))
  keyQueries = 0
  const rotated = getHistorySourceJob(jobs[0]!.id)!
  assert.equal(JSON.stringify(rotated).includes(nextKey), false)
  assert.equal(rotated.events.at(-1)!.candidate!.comments![0]!.text, 'Comment [redacted]')
  assert.equal(keyQueries, 1)
})

test('job history paginates past five jobs without changing the active control job', async () => {
  const route = createHistorySourceJobsRoute()
  const active = startHistorySourceJob({}).job
  const ids: number[] = []
  for (let index = 0; index < 24; index++) {
    const task = createTask({ type: HISTORY_SOURCING_TASK_TYPE, payload: {} })
    db.update(schema.creationTasks).set({ status: 'succeeded' }).where(eq(schema.creationTasks.id, task.id)).run()
    ids.push(task.id)
  }
  createTask({ type: 'unrelated.test', payload: {} })
  const first = (await (await route.request('/')).json()).data
  assert.equal(first.job.id, active.id)
  assert.equal(first.total, 25)
  assert.equal(first.recent.length, 20)
  assert.equal(first.hasMore, true)
  assert.deepEqual(first.recent.map((job: { id: number }) => job.id), ids.slice(4).reverse())
  assert.equal(first.nextCursor, first.recent.at(-1).id)
  const second = (await (await route.request(`/?beforeId=${first.nextCursor}`)).json()).data
  assert.equal(second.job.id, active.id)
  assert.equal(second.total, 25)
  assert.equal(second.hasMore, false)
  assert.equal(second.nextCursor, null)
  assert.deepEqual(second.recent.map((job: { id: number }) => job.id), [...ids.slice(0, 4).reverse(), active.id])
})

test('batch outcome routes are read-only and reject invalid pagination',async()=>{
  const route=createHistorySourceJobsRoute()
  const job=startHistorySourceJob({}).job
  const source=storeHistorySource(candidate())
  completeDraft(source.id)
  appendTaskEvent(job.id,'history.progress',{currentSourceId:source.id,currentTitle:source.title,stage:'storing',counts:{completed:1}})
  db.delete(schema.workerHeartbeats).run()
  db.update(schema.creationTasks).set({createdAt:'2020-01-01T00:00:00Z'}).where(eq(schema.creationTasks.id,job.id)).run()
  const before=getTask(job.id)
  const changes=db.$client.prepare('SELECT total_changes() AS value').get()
  const response=await route.request(`/${job.id}/outcomes`)
  assert.equal(response.status,200)
  assert.equal(response.headers.get('Cache-Control'),'no-store')
  const data=(await response.json()).data
  assert.equal(data.items[0].sourceId,source.id)
  assert.equal(data.items[0].collectedInBatch,true)
  assert.equal(data.items[0].draftState,'current')
  assert.deepEqual(db.$client.prepare('SELECT total_changes() AS value').get(),changes)
  assert.deepEqual(getTask(job.id),before,'reading outcomes does not settle an unserved queue')
  for(const query of ['offset=-1','offset=1.5','offset=9007199254740992','limit=0','limit=101','limit=abc']) {
    assert.equal((await route.request(`/${job.id}/outcomes?${query}`)).status,400)
  }
  assert.equal((await route.request('/999999/outcomes')).status,404)
})

test('progress history retrieves more than one hundred events with counts and no heartbeat or other task leakage', async () => {
  const route = createHistorySourceJobsRoute()
  const job = startHistorySourceJob({}).job
  const other = createTask({ type: 'unrelated.test', payload: {} })
  const eventIds: number[] = []
  for (let index = 0; index < 135; index++) {
    eventIds.push(appendTaskEvent(job.id, 'history.progress', progressSnapshot(index)).id)
    appendTaskEvent(job.id, 'heartbeat', { private: 'worker-secret' })
    appendTaskEvent(other.id, 'history.progress', progressSnapshot(9999))
  }
  const firstResponse = await route.request(`/${job.id}/events`)
  assert.equal(firstResponse.status, 200)
  const first = (await firstResponse.json()).data
  assert.equal(first.total, 135)
  assert.equal(first.items.length, 100)
  assert.equal(first.hasMore, true)
  assert.deepEqual(first.items.map((event: { id: number }) => event.id), eventIds.slice(35))
  assert.equal(first.nextCursor, first.items[0].id)
  assert.equal(first.items.at(-1).counts.scanned, 134)
  assert.equal(first.items[0].browserUrl, 'https://www.douyin.com/')
  assert.equal(first.items[0].currentSourceId, null)
  assert.equal(first.items[0].currentTitle, null)
  assert.equal(first.items[0].candidate, undefined)
  const second = (await (await route.request(`/${job.id}/events?beforeId=${first.nextCursor}`)).json()).data
  assert.equal(second.total, 135)
  assert.equal(second.hasMore, false)
  assert.equal(second.nextCursor, null)
  assert.deepEqual(second.items.map((event: { id: number }) => event.id), eventIds.slice(0, 35))
  assert.doesNotMatch(JSON.stringify([first, second]), /worker-secret|9999/)
  assert.equal((await route.request(`/${other.id}/events`)).status, 404)
  assert.equal((await route.request('/999999/events')).status, 404)
})

test('history routes reject malformed pagination without accepting unsafe integer cursors', async () => {
  const route = createHistorySourceJobsRoute()
  const job = startHistorySourceJob({}).job
  for (const path of ['/', `/${job.id}/events`]) {
    for (const value of ['0', '-1', '1.5', 'abc', '9007199254740992', '']) {
      assert.equal((await route.request(`${path}?beforeId=${value}`)).status, 400, `${path} cursor ${value}`)
      assert.equal((await route.request(`${path}?limit=${value}`)).status, 400, `${path} limit ${value}`)
    }
  }
  assert.equal((await route.request('/?limit=51')).status, 400)
  assert.equal((await route.request(`/${job.id}/events?limit=201`)).status, 400)
  assert.equal((await route.request('/abc/events')).status, 400)
})

test('candidate evidence is readable but cannot expose credentials, external URLs or local paths', async () => {
  const route = createHistorySourceJobsRoute()
  const job = startHistorySourceJob({}).job
  const unsafeText = 'Bearer secret-token https://example.com/?token=private /Users/local/private/file.wav'
  appendTaskEvent(job.id, 'history.progress', {
    ...progressSnapshot(7), currentSourceId: 12, currentTitle: `A title ${unsafeText}`,
    browserUrl: 'https://www.douyin.com/video/123?token=private#secret-fragment',
    candidate: {
      outcome: 'skipped', videoId: '123', title: `Video title ${unsafeText}`, reason: `No story ${unsafeText}`,
      screeningStage: 'detail', durationSeconds: 600, likeCount: 28000, commentCount: 42, titleEvidence: `Evidence ${unsafeText}`,
      curiosityAngle: `Angle ${unsafeText}`, comments: [{ text: `Comment ${unsafeText}`, likes: 3 }],
    },
  })
  const data = (await (await route.request(`/${job.id}/events`)).json()).data
  assert.equal(data.items.length, 1)
  const event = data.items[0]
  assert.equal(event.browserUrl, 'https://www.douyin.com/video/123')
  assert.equal(event.currentSourceId, 12)
  assert.equal(event.counts.scanned, 7)
  assert.equal(event.candidate.outcome, 'skipped')
  assert.equal(event.candidate.videoId, '123')
  assert.equal(event.candidate.durationSeconds, 600)
  assert.equal(event.candidate.screeningStage, 'detail')
  assert.equal(event.candidate.likeCount, 28000)
  assert.equal(event.candidate.commentCount, 42)
  assert.equal(event.candidate.comments[0].likes, 3)
  assert.doesNotMatch(JSON.stringify(data), /secret-token|token=private|\/Users\/|example\.com|secret-fragment/)
  assert.deepEqual(getHistorySourceJob(job.id)?.events[0], event)
})

test('search screening evidence survives persisted reads while older candidate logs remain compatible', async () => {
  const route = createHistorySourceJobsRoute()
  const job = startHistorySourceJob({}).job
  const candidates = [
    { outcome: 'skipped', videoId: '123', screeningStage: 'search', likeCount: 0, reason: '标题不符合历史题材' },
    { outcome: 'selected', videoId: '456', commentCount: 42, reason: '旧版评论证据' },
  ]
  candidates.forEach((candidate, index) => appendTaskEvent(job.id, 'history.progress', { ...progressSnapshot(index), candidate }))
  const data = (await (await route.request(`/${job.id}/events`)).json()).data
  assert.equal(data.items.length, 2)
  assert.equal(data.items[0].candidate.screeningStage, 'search')
  assert.equal(data.items[0].candidate.likeCount, 0)
  assert.equal(data.items[0].candidate.commentCount, undefined)
  assert.equal(data.items[1].candidate.screeningStage, undefined)
  assert.equal(data.items[1].candidate.likeCount, undefined)
  assert.equal(data.items[1].candidate.commentCount, 42)
  assert.deepEqual(JSON.parse(JSON.stringify(getHistorySourceJob(job.id)?.events)), data.items)
})

test('candidate evidence only attaches to its browser decision and never leaks into later model stages', async () => {
  registerTaskHandler(HISTORY_SOURCING_TASK_TYPE, createHistorySourceJobHandler({
    checkReadiness: async () => {},
    browse: async options => {
      options.report({
        stage: 'selecting', message: 'Selected by observed comment evidence', scanned: 3,
        candidate: { outcome: 'selected', videoId: '123', title: 'Why this capital moved', reason: 'Viewers ask why', comments: [{ text: 'Why move the capital?', likes: 2 }] },
      })
      await options.onCandidate!(candidate('123'))
      return []
    },
    process: async (id, options) => {
      options?.onProgress?.({ stage: 'correcting', message: 'Transcript is being corrected' })
      return completeDraft(id)
    },
  }))
  const { job } = startHistorySourceJob({})
  await worker()
  const current = getHistorySourceJob(job.id)!
  assert.equal(current.status, 'completed')
  assert.equal(current.candidate, undefined)
  const decisions = current.events.filter(event => event.candidate)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]!.candidate!.videoId, '123')
  assert.equal(current.events.find(event => event.stage === 'correcting')?.candidate, undefined)
  const rows = db.select().from(schema.creationTaskEvents).where(eq(schema.creationTaskEvents.taskId, job.id)).all()
  assert.equal(rows.filter(row => row.eventType === 'history.progress' && JSON.parse(row.dataJson!).candidate).length, 1)
})
