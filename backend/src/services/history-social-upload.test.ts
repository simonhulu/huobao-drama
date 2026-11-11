import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import Database from 'better-sqlite3'
import { recordHistoryVideoDelivery } from './history-video-deliveries.js'
import { ensureHistoryVideoPackagingSchema } from './history-video-packaging.js'
import type { HistoryArticleResult } from './history-script-article.js'
import {
  HistorySocialUploadService,
  historySocialUploadInputSchema,
  type HistorySocialSource,
  type HistorySocialRuntime,
  type HistorySocialUploadOptions,
  type SocialUploadPayload,
  type SocialUploadResult,
  type SocialTarget,
} from './history-social-upload.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

async function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-social-upload-')))
  const root = path.join(directory, 'static')
  fs.mkdirSync(path.join(root, 'history-deliveries', '71'), { recursive: true })
  fs.writeFileSync(path.join(root, 'history-deliveries', '71', 'finished.mp4'), 'already validated finished video')
  for (const [ratio, width, height] of [['16x9', 32, 18], ['3x4', 24, 32], ['4x3', 32, 24]] as const) {
    await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png()
      .toFile(path.join(root, 'history-deliveries', '71', `${ratio}.png`))
  }
  const source: HistorySocialSource = {
    id: 71, title: '历史项目，不是 episode', rewrittenScript: '已经保存的当前稿件。', artifactState: 'current',
    delivery: {
      title: '明朝冬季的蔬菜供应', baijiahaoTitle: '明朝冬季的蔬菜供应与菜价', description: '供给与运输影响菜价。',
      videoUrl: '/static/history-deliveries/71/finished.mp4', scriptSha256: hash('已经保存的当前稿件。'),
      coverScriptSha256: hash('已经保存的当前稿件。'), coverStatus: 'completed',
      covers: { '16:9': '/static/history-deliveries/71/16x9.png', '3:4': '/static/history-deliveries/71/3x4.png', '4:3': '/static/history-deliveries/71/4x3.png' },
    },
  }
  const calls: SocialUploadPayload[] = []
  const result = (payload: SocialUploadPayload, saved = false): SocialUploadResult => ({
    staged: true, saved, published: false, targetId: `draft-${payload.jobId}`,
    editorUrl: payload.target === 'tencent-video' ? 'https://channels.weixin.qq.com/platform/post/create'
      : `https://baijiahao.baidu.com/builder/rc/edit?id=draft-${payload.jobId}`,
    evidencePath: '/private/evidence.png', engine: payload.target === 'baijiahao-article' ? 'project-extension' : 'social-auto-upload',
  })
  const runtime: HistorySocialRuntime = {
    inspectSocialUploadRuntime: async () => ({ installed: true, version: 'test', message: 'ready',
      platforms: { baijiahao: { ready: true, message: 'ready' }, tencent: { ready: true, message: 'ready' } } }),
    runSocialUpload: async (payload, options) => { calls.push(payload); return result(payload, options.saveDraft) },
    confirmSocialUpload: async (payload, previous) => ({ ...previous, saved: true }),
  }
  const articleState: Pick<HistoryArticleResult, 'status' | 'stale' | 'article'> = { status: 'idle', stale: false, article: null }
  const options = {
    databasePath: path.join(directory, 'queue.db'), root, runtime,
    loadSource: async (id: number) => id === source.id && !source.deletedAt ? structuredClone(source) : null,
    getArticle: async () => structuredClone(articleState),
  }
  const service = new HistorySocialUploadService(options)
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { service, source, runtime, calls, options, root, directory, result, articleState }
}

async function failedDraft(h: Awaited<ReturnType<typeof fixture>>, target: SocialTarget = 'baijiahao-video') {
  const receipt = await h.service.enqueue({ sourceIds: [71], targets: [target], mode: 'stage' })
  const id = receipt.jobs[0]!.id
  await h.service.runPending()
  h.runtime.confirmSocialUpload = async () => { throw new Error('save result not observed') }
  const job = await h.service.confirm(id)
  assert.equal(job.status, 'failed')
  assert.ok(job.result)
  return job
}

test('a scoped drain claims only the selected original job and does not recover unrelated interrupted work', async t => {
  const h=await fixture(t)
  const receipt=await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video','tencent-video'],mode:'draft'})
  const selected=receipt.jobs.find(job=>job.target==='tencent-video')!
  const sql=new Database(h.options.databasePath)
  t.after(()=>sql.close())
  sql.prepare(`INSERT INTO history_social_upload_jobs
    (source_id,source_title,target,mode,status,message,blockers_json,fingerprint,engine,created_at,updated_at,host,pid,lease_until)
    VALUES(999,'outside','baijiahao-video','draft','running','untouched','[]','outside','test','before','before','dead-host',1,1)`).run()
  const outside=sql.prepare('SELECT * FROM history_social_upload_jobs WHERE source_id=999').get()
  const restarted=new HistorySocialUploadService({...h.options,scope:{sourceIds:[71],jobIds:[selected.id]}})
  try {assert.deepEqual(sql.prepare('SELECT * FROM history_social_upload_jobs WHERE source_id=999').get(),outside)}
  finally {await restarted.close()}
  // A running task outside the scope still owns the global upload mutex.
  await h.service.runPending({sourceIds:[71],jobIds:[selected.id]})
  assert.equal(h.calls.length,0)
  assert.deepEqual(sql.prepare('SELECT * FROM history_social_upload_jobs WHERE source_id=999').get(),outside)
  sql.prepare("UPDATE history_social_upload_jobs SET status='uncertain' WHERE source_id=999").run()
  const uncertain=sql.prepare('SELECT * FROM history_social_upload_jobs WHERE source_id=999').get()
  await h.service.runPending({sourceIds:[71],jobIds:[selected.id]})
  assert.equal(h.service.getJob(selected.id).status,'completed')
  assert.equal(h.service.getJob(receipt.jobs.find(job=>job.id!==selected.id)!.id).status,'queued')
  assert.deepEqual(sql.prepare('SELECT * FROM history_social_upload_jobs WHERE source_id=999').get(),uncertain)
  assert.deepEqual(h.calls.map(call=>call.jobId),[selected.id])
  await h.service.runPending({sourceIds:[]})
  assert.equal(h.calls.length,1)
})

test('explicit runtime refresh reaches the bridge instead of reusing its failed check', async t => {
  const h = await fixture(t)
  const inspect = h.runtime.inspectSocialUploadRuntime
  const calls: Array<boolean | undefined> = []
  h.runtime.inspectSocialUploadRuntime = async (refresh) => { calls.push(refresh); return inspect() }
  await h.service.inspectRuntime()
  await h.service.inspectRuntime()
  await h.service.inspectRuntime(true)
  assert.deepEqual(calls, [false, true])
})

function automaticPreflightClock(h: Awaited<ReturnType<typeof fixture>>) {
  let now = Date.parse('2026-11-12T00:00:00Z')
  Object.assign(h.options, {automaticPreflightRetry: true, now: () => now})
  return {advance: (ms: number) => { now += ms }, now: () => now}
}

test('automatic preflight retry preserves the original request, payload and deadline through restart and submits once', async t => {
  const h = await fixture(t), clock = automaticPreflightClock(h), video = addVideo(h, 'motion')
  const receipt = await h.service.enqueue({sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id], requestId: 'same-preflight-request'})
  const id = receipt.jobs[0]!.id, sql = new Database(h.options.databasePath)
  t.after(() => sql.close())
  const originalPayload = (sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(id) as any).payload_json
  h.runtime.inspectHistorySocialUploadRuntime = async () => { throw Error('browserType.connectOverCDP: Timeout 30000ms exceeded') }
  await h.service.runPending()
  const pending = h.service.getJob(id)
  assert.equal(pending.status, 'queued')
  assert.deepEqual(pending.recovery, {attempts: 1, maxAttempts: 3, nextAttemptAt: new Date(clock.now() + 30_000).toISOString(), action: 'preflight-runtime'})
  assert.equal(pending.publicationAttempted, false)
  assert.equal((sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(id) as any).payload_json, originalPayload)
  const ready = h.runtime.inspectSocialUploadRuntime
  h.runtime.inspectHistorySocialUploadRuntime = ready
  let submissions = 0
  h.runtime.confirmSocialUpload = async (_payload, previous) => { submissions++; return publishedResult(previous) }
  const restarted = new HistorySocialUploadService(h.options)
  try {
    assert.deepEqual(restarted.getJob(id).recovery, pending.recovery)
    assert.equal(restarted.receipt('same-preflight-request').jobs[0]!.id, id)
    clock.advance(29_999)
    await restarted.runPending({jobIds: [id]})
    assert.equal(h.calls.length, 0)
    clock.advance(1)
    await restarted.runPending({jobIds: [id]})
    await restarted.runPending({jobIds: [id]})
    assert.equal(restarted.getJob(id).status, 'completed')
    assert.equal(h.calls.length, 1)
    assert.equal(submissions, 1)
    assert.equal(h.calls[0]!.jobId, id)
    assert.equal(JSON.stringify(h.calls[0]), originalPayload)
    assert.equal((sql.prepare('SELECT count(*) AS n FROM history_social_upload_jobs').get() as any).n, 1)
    assert.equal((sql.prepare('SELECT count(*) AS n FROM history_social_upload_requests').get() as any).n, 1)
  } finally { await restarted.close() }
})

test('automatic preflight retry uses persisted 30, 60 and 120 second delays then stops after three retries', async t => {
  const h = await fixture(t), clock = automaticPreflightClock(h)
  const id = (await h.service.enqueue({sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft'})).jobs[0]!.id
  let checks = 0
  h.runtime.inspectHistorySocialUploadRuntime = async () => { checks++; throw Error('connect ECONNREFUSED 127.0.0.1:9243') }
  for (const [index, delay] of [30_000, 60_000, 120_000].entries()) {
    await h.service.runPending()
    assert.equal(h.service.getJob(id).status, 'queued')
    assert.equal(h.service.getJob(id).recovery.attempts, index + 1)
    assert.equal(h.service.getJob(id).recovery.nextAttemptAt, new Date(clock.now() + delay).toISOString())
    await h.service.runPending()
    assert.equal(checks, index + 1, 'polling must not claim work before its persisted deadline')
    clock.advance(delay)
  }
  await h.service.runPending()
  assert.equal(checks, 4)
  const failed = h.service.getJob(id)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.recovery, {attempts: 3, maxAttempts: 3, nextAttemptAt: null, action: 'preflight-runtime'})
  const restarted = new HistorySocialUploadService(h.options)
  try {
    assert.deepEqual(restarted.getJob(id).recovery, failed.recovery)
    clock.advance(1_000_000)
    await restarted.runPending()
    assert.equal(checks, 4)
    assert.equal(h.calls.length, 0)
  } finally { await restarted.close() }
})

test('automatic preflight retry also schedules a runtime-only timeout in the initial preflight', async t => {
  const h = await fixture(t), clock = automaticPreflightClock(h)
  const inspect = h.runtime.inspectSocialUploadRuntime
  h.runtime.inspectHistorySocialUploadRuntime = async () => { throw Error('百家号上传前账号检查超时，尚未开始上传；原登录和上传检查点已保留，请重试连接') }
  const receipt = await h.service.enqueue({sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft', requestId: 'initial-timeout'})
  assert.equal(receipt.jobs[0]!.status, 'queued')
  assert.equal(receipt.jobs[0]!.recovery.attempts, 1)
  await h.service.runPending()
  assert.equal(h.calls.length, 0)
  h.runtime.inspectHistorySocialUploadRuntime = inspect
  clock.advance(30_000)
  await h.service.runPending()
  assert.equal(h.service.receipt('initial-timeout').jobs[0]!.status, 'completed')
  assert.equal(h.calls.length, 1)
})

test('automatic preflight backoff does not block another ready job in the same drain', async t => {
  const h = await fixture(t)
  automaticPreflightClock(h)
  await enableBackground(h)
  const receipt = await h.service.enqueue({sourceIds: [71], targets: ['baijiahao-video', 'tencent-video'], mode: 'draft'})
  const inspect = h.runtime.inspectHistorySocialUploadRuntime!
  h.runtime.inspectHistorySocialUploadRuntime = async refresh => {
    const runtime = await inspect(refresh)
    runtime.platforms.baijiahao = {...runtime.platforms.baijiahao, ready: false, issue: 'connection_failed', message: 'connect ECONNREFUSED 127.0.0.1:9243'}
    return runtime
  }
  await h.service.runPending()
  assert.equal(h.service.getJob(receipt.jobs[0]!.id).status, 'queued')
  assert.equal(h.service.getJob(receipt.jobs[1]!.id).status, 'completed')
  assert.deepEqual(h.calls.map(call => call.target), ['tencent-video'])
})

test('automatic preflight retry requires opt-in and never retries login, verification, material or snapshot failures', async t => {
  for (const scenario of ['disabled', 'login', 'verification', 'material', 'snapshot'] as const) await t.test(scenario, async child => {
    const h = await fixture(child)
    if (scenario !== 'disabled') automaticPreflightClock(h)
    await enableBackground(h)
    const id = (await h.service.enqueue({sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft'})).jobs[0]!.id
    const inspect = h.runtime.inspectHistorySocialUploadRuntime!
    if (scenario === 'snapshot') h.source.delivery!.baijiahaoTitle = 'Changed title must not replace original metadata'
    else {
      if (scenario === 'material') fs.rmSync(path.join(h.root, 'history-deliveries/71/finished.mp4'))
      h.runtime.inspectHistorySocialUploadRuntime = async refresh => {
        const value = await inspect(refresh)
        value.platforms.baijiahao = {...value.platforms.baijiahao, ready: false,
          issue: scenario === 'login' ? 'login_required' : scenario === 'verification' ? 'verification_required' : 'connection_failed',
          message: 'Timeout 30000ms exceeded'}
        return value
      }
    }
    await h.service.runPending()
    assert.equal(h.service.getJob(id).status, 'failed')
    assert.equal(h.service.getJob(id).recovery.nextAttemptAt, null)
    assert.equal(h.service.getJob(id).recovery.attempts, 0)
    assert.equal(h.calls.length, 0)
  })
})

test('automatic preflight retry never resets or retries a dispatched or uncertain publication', async t => {
  for (const failureAt of ['upload', 'publish'] as const) await t.test(failureAt, async child => {
    const h = await fixture(child), clock = automaticPreflightClock(h), video = addVideo(h, 'motion')
    let submissions = 0
    if (failureAt === 'upload') h.runtime.runSocialUpload = async payload => { h.calls.push(payload); throw Error('connect ETIMEDOUT during upload') }
    h.runtime.confirmSocialUpload = async () => { submissions++; throw Error('publication response timeout') }
    h.runtime.resetSocialUploadAttempt = async () => assert.fail('must preserve dispatched attempt')
    const id = (await h.service.enqueue({sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id]})).jobs[0]!.id
    await h.service.runPending()
    const uncertain = h.service.getJob(id)
    assert.equal(uncertain.status, 'uncertain')
    assert.equal(uncertain.publicationAttempted, true)
    assert.equal(uncertain.recovery.nextAttemptAt, null)
    const restarted = new HistorySocialUploadService(h.options)
    try {
      clock.advance(1_000_000)
      await restarted.runPending()
      assert.equal(h.calls.length, 1)
      assert.equal(submissions, failureAt === 'publish' ? 1 : 0)
      assert.equal(restarted.getJob(id).status, 'uncertain')
    } finally { await restarted.close() }
  })
})

test('automatic preflight retry budget cannot be reset by another automatic enqueue request', async t => {
  const h = await fixture(t), clock = automaticPreflightClock(h)
  const input = {sourceIds: [71], targets: ['baijiahao-video'] as SocialTarget[], mode: 'draft' as const}
  const id = (await h.service.enqueue({...input, requestId: 'original-budget'})).jobs[0]!.id
  const ready = h.runtime.inspectSocialUploadRuntime
  h.runtime.inspectHistorySocialUploadRuntime = async () => { throw Error('connect ECONNREFUSED 127.0.0.1:9243') }
  for (const delay of [30_000, 60_000, 120_000, 0]) {
    await h.service.runPending()
    clock.advance(delay)
  }
  h.runtime.inspectHistorySocialUploadRuntime = ready
  const again = await h.service.enqueue({...input, requestId: 'later-automatic-request'}, {automatic: true})
  assert.equal(again.jobs[0]!.id, id)
  assert.equal(again.jobs[0]!.status, 'failed')
  assert.equal(again.jobs[0]!.recovery.attempts, 3)
  await h.service.runPending()
  assert.equal(h.calls.length, 0)
  h.service.retry(id)
  await h.service.runPending()
  assert.equal(h.calls.length, 1, 'an explicit user retry can start a new budget')
})

test('automatic preflight retry clears its marker once writing starts and a draft write failure stays terminal', async t => {
  const h = await fixture(t), clock = automaticPreflightClock(h)
  const id = (await h.service.enqueue({sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft'})).jobs[0]!.id
  const ready = h.runtime.inspectSocialUploadRuntime
  h.runtime.inspectHistorySocialUploadRuntime = async () => { throw Error('connect ETIMEDOUT') }
  await h.service.runPending()
  h.runtime.inspectHistorySocialUploadRuntime = ready
  h.runtime.runSocialUpload = async payload => { h.calls.push(payload); throw Error('upload timeout') }
  clock.advance(30_000)
  await h.service.runPending()
  assert.equal(h.service.getJob(id).status, 'failed')
  assert.deepEqual(h.service.getJob(id).recovery, {attempts: 0, maxAttempts: 0, nextAttemptAt: null, action: null})
  clock.advance(1_000_000)
  await h.service.runPending()
  assert.equal(h.calls.length, 1)
})

test('automatic preflight retry recovers a dead checking worker within the existing persisted budget', async t => {
  for (const attempts of [1, 3]) await t.test(`attempt ${attempts}`, async child => {
    const h = await fixture(child), clock = automaticPreflightClock(h)
    const id = (await h.service.enqueue({sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft'})).jobs[0]!.id
    h.runtime.inspectHistorySocialUploadRuntime = async () => { throw Error('connect ECONNREFUSED 127.0.0.1:9243') }
    await h.service.runPending()
    const sql = new Database(h.options.databasePath)
    child.after(() => sql.close())
    sql.prepare(`UPDATE history_social_upload_jobs SET status='running',owner='dead-worker',host='dead-host',pid=1,
      lease_until=0,recovery_attempts=?,next_attempt_at=NULL WHERE id=?`).run(attempts, id)
    const restarted = new HistorySocialUploadService(h.options)
    try {
      const recovered = restarted.getJob(id)
      assert.equal(recovered.status, attempts === 3 ? 'failed' : 'queued')
      assert.equal(recovered.recovery.attempts, attempts === 3 ? 3 : 2)
      assert.equal(recovered.recovery.nextAttemptAt, attempts === 3 ? null : new Date(clock.now() + 60_000).toISOString())
      await restarted.runPending()
      assert.equal(h.calls.length, 0)
    } finally { await restarted.close() }
  })
})

test('automatic preflight retry rejects changed materials while waiting and does not replace the original payload', async t => {
  const h = await fixture(t), clock = automaticPreflightClock(h)
  const id = (await h.service.enqueue({sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft'})).jobs[0]!.id
  const sql = new Database(h.options.databasePath)
  t.after(() => sql.close())
  const original = sql.prepare('SELECT payload_json,fingerprint FROM history_social_upload_jobs WHERE id=?').get(id)
  const ready = h.runtime.inspectSocialUploadRuntime
  h.runtime.inspectHistorySocialUploadRuntime = async () => { throw Error('connect ETIMEDOUT') }
  await h.service.runPending()
  h.source.delivery!.baijiahaoTitle = 'New title cannot replace the original snapshot'
  h.runtime.inspectHistorySocialUploadRuntime = ready
  clock.advance(30_000)
  await h.service.runPending()
  assert.equal(h.service.getJob(id).status, 'failed')
  assert.equal(h.service.getJob(id).blockers[0]!.code, 'snapshot_changed')
  assert.deepEqual(sql.prepare('SELECT payload_json,fingerprint FROM history_social_upload_jobs WHERE id=?').get(id), original)
  assert.equal(h.calls.length, 0)
})

function saveArticleCoverSelection(h: Awaited<ReturnType<typeof fixture>>) {
  const images = h.articleState.article!.screenshots.slice(0, 2).map(image => ({
    url: image.url,
    sha256: createHash('sha256').update(fs.readFileSync(path.join(h.root, image.url.replace('/static/', '')))).digest('hex'),
  }))
  const filename = path.join(h.root, path.dirname(images[0]!.url.replace('/static/', '')), 'body-cover-selection.json')
  fs.writeFileSync(filename, JSON.stringify({ version: 1, images }))
  return filename
}

async function articleFixture(t: TestContext) {
  const h = await fixture(t)
  const directory = path.join(h.root, 'history-articles', '71')
  fs.mkdirSync(directory, { recursive: true })
  for (const [filename, background] of [['frame.png', '#ff0000'], ['frame-1.png', '#00ff00']] as const) {
    await sharp({ create: { width: 32, height: 24, channels: 3, background } }).png().toFile(path.join(directory, filename))
  }
  h.articleState.status = 'completed'
  h.articleState.article = {
    title: '当前文章标题', html: '<p>当前文章正文</p><img src="/static/history-articles/71/frame.png"><img src="/static/history-articles/71/frame-1.png">', markdown: '当前文章正文',
    sections: [{ heading: '正文', paragraphs: [{ text: '当前文章正文', highlights: [], sourceEvidence: [] }] }],
    screenshots: [{ url: '/static/history-articles/71/frame.png', timestamp: 0, sectionIndex: 0 },
      { url: '/static/history-articles/71/frame-1.png', timestamp: 1, sectionIndex: 0 }],
    sourceLength: 6, articleLength: 6, generatedAt: new Date().toISOString(), notices: [], selectionMethod: 'model-adapted',
    provenance: { correctedSha256: 'current', sourceMetadataSha256: 'current', rewrittenSha256: hash(h.source.rewrittenScript!),
      videoUrl: h.source.delivery!.videoUrl!, videoFingerprint: 'current' },
  }
  saveArticleCoverSelection(h)
  return h
}

test('explicit legacy draft mode keeps saved drafts without publishing', async t => {
  const h = await fixture(t)
  const input = { mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video', 'tencent-video'] as SocialTarget[] }
  assert.equal(historySocialUploadInputSchema.parse(input).mode, 'draft')
  assert.equal(historySocialUploadInputSchema.parse({ ...input, mode: 'stage' }).mode, 'stage')
  assert.equal((await h.service.preflight(input)).mode, 'draft')
  const saves: boolean[] = []
  h.runtime.runSocialUpload = async (payload, options) => {
    saves.push(options.saveDraft)
    h.calls.push(payload)
    return h.result(payload, options.saveDraft)
  }
  const receipt = await h.service.enqueue({ ...input, requestId: 'default-draft' })
  assert.equal(receipt.mode, 'draft')
  assert.ok(receipt.items.every(item => item.mode === 'draft'))
  assert.ok(receipt.jobs.every(job => job.mode === 'draft'))
  await h.service.runPending()
  assert.deepEqual(saves, [true, true])
  assert.deepEqual(h.calls[0]!.tags, ['#热爆趣创赛'])
  assert.equal(h.calls[0]!.description, h.calls[0]!.title, 'topic input must not replace the main description')
  assert.equal(h.calls[1]!.tags, undefined, 'Baijiahao topic selection must not change Tencent uploads')
  assert.ok(h.service.listJobs().every(job => job.status === 'completed' && job.result?.saved === true && job.result.published === false))
  assert.equal(h.service.receipt('default-draft').mode, 'draft')
})

test('preflight reports exact per-target missing material without uploading or generating anything', async t => {
  const h = await fixture(t)
  delete h.source.delivery!.covers['4:3']
  const result = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video', 'baijiahao-article', 'tencent-video'] })
  assert.equal(result.items.length, 3)
  assert.equal(result.items[0]!.ready, true)
  assert.equal(result.items[1]!.ready, false)
  assert.equal(result.items[1]!.engine, 'project-extension')
  assert.ok(result.items[1]!.blockers.some(issue => issue.field === 'article'))
  assert.equal(result.items[2]!.ready, false)
  assert.ok(result.items[2]!.blockers.some(issue => issue.field === 'covers.4:3'))
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.service.listJobs(), [])
})

test('confirm saves the existing target once and accepts a platform URL change after save', async t => {
  const h = await fixture(t)
  const receipt = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'stage', requestId: 'stage-save' })
  await h.service.runPending()
  const id = receipt.jobs[0]!.id
  const staged = h.service.getJob(id)
  assert.equal(staged.status, 'awaiting_confirmation')
  let saves = 0
  h.runtime.confirmSocialUpload = async (payload, previous) => {
    saves++
    assert.equal(payload.scriptId, 71)
    assert.equal(previous.targetId, staged.result!.targetId)
    return { ...previous, saved: true, editorUrl: 'https://baijiahao.baidu.com/builder/rc/content?type=draft' }
  }
  assert.equal((await h.service.confirm(id)).status, 'completed')
  assert.equal((await h.service.confirm(id)).status, 'completed')
  assert.equal(saves, 1)
  assert.equal(h.calls.length, 1)
  assert.equal(h.service.queueState().paused, false)
})

test('preflight rejects another project material even inside static, including symlink aliases', async t => {
  const h = await fixture(t)
  fs.mkdirSync(path.join(h.root, 'history-deliveries', '72'))
  fs.writeFileSync(path.join(h.root, 'history-deliveries', '72', 'finished.mp4'), 'another project')
  h.source.delivery!.videoUrl = '/static/history-deliveries/72/finished.mp4'
  let report = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })
  assert.ok(report.items[0]!.blockers.some(issue => issue.field === 'video' && issue.code === 'asset_ownership'))
  fs.symlinkSync(path.join(h.root, 'history-deliveries', '72', 'finished.mp4'), path.join(h.root, 'history-deliveries', '71', 'alias.mp4'))
  h.source.delivery!.videoUrl = '/static/history-deliveries/71/alias.mp4'
  report = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })
  assert.ok(report.items[0]!.blockers.some(issue => issue.field === 'video' && issue.code === 'asset_unsafe'))
  assert.deepEqual(h.calls, [])
})

test('preflight respects current delivery scriptChanged and coversChanged provenance flags', async t => {
  const h = await fixture(t)
  Object.assign(h.source.delivery!, { scriptChanged: true, coversChanged: true })
  const report = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })
  assert.ok(report.items[0]!.blockers.some(issue => issue.code === 'video_stale'))
  assert.ok(report.items[0]!.blockers.some(issue => issue.code === 'covers_stale'))
})

test('shortening a platform title keeps complete covers from the same script usable and warns about the changed plan', async t => {
  const h = await fixture(t)
  Object.assign(h.source.delivery!, { title: '明朝冬季菜价如何', coverStatus: 'idle', coversChanged: true })
  const input = { sourceIds: [71], targets: ['tencent-video'] as const, mode: 'draft' as const }
  const report = await h.service.preflight({ ...input, targets: [...input.targets] })
  assert.equal(report.items[0]!.ready, true)
  assert.match(report.items[0]!.warnings?.join('；') || '', /沿用已有封面/)
  const receipt = await h.service.enqueue({ ...input, targets: [...input.targets] })
  await h.service.runPending()
  assert.equal(h.service.getJob(receipt.jobs[0]!.id).status, 'completed')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0]!.title, '明朝冬季菜价如何')
  h.source.delivery!.coverScriptSha256 = hash('另一个稿件')
  const saved = await h.service.preflight({ ...input, targets: [...input.targets] })
  assert.equal(saved.items[0]!.uploaded?.confirmation, 'platform')
  assert.deepEqual(saved.items[0]!.blockers, [])
  const stale = await h.service.preflight({ ...input, targets: ['baijiahao-video'] })
  assert.equal(stale.items[0]!.ready, false)
  assert.ok(stale.items[0]!.blockers.some(issue => issue.code === 'covers_stale'))
})

test('lost-reply receipts and fingerprints deduplicate jobs without a mode or active snapshot bypass', async t => {
  const h = await fixture(t)
  const input = { sourceIds: [71], targets: ['baijiahao-video', 'baijiahao-article', 'tencent-video'] as const, mode: 'stage' as const, requestId: 'durable-receipt' }
  const first = await h.service.enqueue({ ...input, targets: [...input.targets] })
  assert.deepEqual(first.jobs.map(job => job.status), ['queued', 'failed', 'queued'])
  assert.deepEqual(h.service.receipt(input.requestId).jobs.map(job => job.id), first.jobs.map(job => job.id))
  assert.deepEqual((await h.service.enqueue({ ...input, targets: [...input.targets] })).jobs.map(job => job.id), first.jobs.map(job => job.id))
  await assert.rejects(h.service.enqueue({ ...input, targets: ['tencent-video'] }), /requestId/)
  const newMode = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft', requestId: 'other-mode' })
  assert.equal(newMode.jobs[0]!.id, first.jobs[0]!.id)
  assert.equal(newMode.jobs[0]!.mode, 'stage')
  h.source.delivery!.baijiahaoTitle = '修改后的百家号标题不能绕过排队锁'
  const newSnapshot = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft' })
  assert.equal(newSnapshot.jobs[0]!.id, first.jobs[0]!.id)
  assert.equal(h.calls.length, 0)
  const reopened = new HistorySocialUploadService(h.options)
  try {
    assert.equal(reopened.receipt(input.requestId).requestId, input.requestId)
    assert.deepEqual(reopened.receipt(input.requestId).jobs.map(job => job.id), first.jobs.map(job => job.id))
  } finally { await reopened.close() }
})

test('two service instances claim globally one upload while separate preview jobs do not block the queue', async t => {
  const h = await fixture(t)
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let active = 0
  let maximum = 0
  h.runtime.runSocialUpload = async (payload, options) => {
    active++; maximum = Math.max(maximum, active); h.calls.push(payload)
    if (h.calls.length === 1) { enter(); await gate }
    active--
    return h.result(payload, options.saveDraft)
  }
  const receipt = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video', 'tencent-video'], mode: 'stage' })
  const other = new HistorySocialUploadService(h.options)
  const running = h.service.runPending()
  try {
    await entered
    await other.runPending()
    assert.equal(h.calls.length, 1)
    assert.equal(other.queueState().runningJobId, receipt.jobs[0]!.id)
    release(); await running
    assert.equal(other.queueState().paused, false)
    await other.runPending()
    assert.equal(other.getJob(receipt.jobs[1]!.id).status, 'awaiting_confirmation')
    await other.confirm(receipt.jobs[0]!.id)
    await other.runPending()
    assert.equal(h.calls.length, 2)
    assert.equal(maximum, 1)
    assert.equal(other.getJob(receipt.jobs[1]!.id).status, 'awaiting_confirmation')
  } finally { release(); await running; await other.close() }
})

test('unstarted draft jobs load from disk and run serially without publishing', async t => {
  const h = await fixture(t)
  const receipt = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video', 'tencent-video'], mode: 'draft' })
  const other = new HistorySocialUploadService(h.options)
  try {
    await other.runPending()
    assert.equal(h.calls.length, 2)
    assert.deepEqual(receipt.jobs.map(job => other.getJob(job.id).status), ['completed', 'completed'])
    assert.ok(receipt.jobs.every(job => other.getJob(job.id).result?.saved && other.getJob(job.id).result?.published === false))
  } finally { await other.close() }
})

test('an expired lease alone cannot take execution away from a live local worker', async t => {
  const h = await fixture(t)
  let now = Date.now()
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  h.runtime.runSocialUpload = async payload => { h.calls.push(payload); enter(); await gate; return h.result(payload) }
  const owner = new HistorySocialUploadService({ ...h.options, now: () => now, leaseMs: 1000 })
  const receipt = await owner.enqueue({ sourceIds: [71], targets: ['baijiahao-video', 'tencent-video'], mode: 'stage' })
  const running = owner.runPending()
  await entered
  now += 1001
  const replacement = new HistorySocialUploadService({ ...h.options, now: () => now })
  try {
    assert.equal(replacement.getJob(receipt.jobs[0]!.id).status, 'running')
    await replacement.runPending()
    assert.equal(h.calls.length, 1)
    release(); await running
    assert.equal(replacement.getJob(receipt.jobs[0]!.id).status, 'awaiting_confirmation')
    assert.ok(replacement.getJob(receipt.jobs[0]!.id).result?.targetId)
    assert.equal(replacement.queueState().paused, false)
    const duplicate = await replacement.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft' })
    assert.equal(duplicate.jobs[0]!.id, receipt.jobs[0]!.id)
    await replacement.runPending()
    assert.equal(h.calls.length, 2)
    assert.throws(() => replacement.cancel(receipt.jobs[0]!.id), /只能取消/)
  } finally { release(); await running; await owner.close(); await replacement.close() }
})

test('an external write error remains failed across repeated requests and worker polls', async t => {
  const h = await fixture(t)
  h.runtime.runSocialUpload = async payload => { h.calls.push(payload); throw new Error('connection lost after platform upload') }
  const receipt = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })
  await h.service.runPending()
  assert.equal(h.service.getJob(receipt.jobs[0]!.id).status, 'failed')
  await h.service.runPending()
  const again = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft' })
  assert.equal(again.jobs[0]!.id, receipt.jobs[0]!.id)
  assert.equal(h.calls.length, 1)
})

test('source deletion, changed text, stale covers and changed files block before dispatch', async t => {
  const scenarios: Array<[string, (h: Awaited<ReturnType<typeof fixture>>) => void]> = [
    ['deleted project', h => { h.source.deletedAt = new Date().toISOString() }],
    ['changed saved title', h => { h.source.delivery!.baijiahaoTitle += '新标题' }],
    ['changed current script', h => { h.source.rewrittenScript += '新段落' }],
    ['changed cover layout', h => { h.source.delivery!.coverStatus = 'idle' }],
    ['replaced video file', h => { fs.writeFileSync(path.join(h.root, 'history-deliveries', '71', 'finished.mp4'), 'a replacement finished video with different content') }],
    ['replaced required cover', h => { fs.writeFileSync(path.join(h.root, 'history-deliveries', '71', '16x9.png'), 'no longer an image') }],
  ]
  for (const [name, change] of scenarios) await t.test(name, async child => {
    const h = await fixture(child)
    const receipt = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })
    change(h)
    await h.service.runPending()
    assert.equal(h.service.getJob(receipt.jobs[0]!.id).status, 'failed')
    assert.equal(h.calls.length, 0)
  })
})

test('cancel is queued-only and open focuses the bound result without another upload', async t => {
  const h = await fixture(t)
  const first = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'stage' })
  const id = first.jobs[0]!.id
  await assert.rejects(h.service.open(id), /尚无/)
  assert.equal(h.service.cancel(id).status, 'canceled')
  const second = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'stage' })
  assert.notEqual(second.jobs[0]!.id, id)
  await h.service.runPending()
  const staged = second.jobs[0]!.id
  assert.throws(() => h.service.cancel(staged), /只能取消/)
  h.runtime.focusSocialUpload = async (payload, result) => {
    assert.equal(payload.jobId, staged)
    assert.equal(result.targetId, h.service.getJob(staged).result!.targetId)
    return { opened: true }
  }
  assert.deepEqual(await h.service.open(staged), { opened: true })
  assert.equal(h.calls.length, 1)
})

test('article three-image cover preflight requires two distinct body images excluding the main cover by SHA256', async t => {
  const cases = [
    { name: 'no body images', filenames: [], available: 0 },
    { name: 'only the main cover copy', filenames: ['cover-copy.png'], available: 0 },
    { name: 'one body image', filenames: ['frame.png'], available: 1 },
    { name: 'same path repeated', filenames: ['frame.png', 'frame.png'], available: 1 },
    { name: 'different paths with identical contents', filenames: ['frame.png', 'frame-copy.png'], available: 1 },
    { name: 'one body image and main cover copy', filenames: ['frame.png', 'cover-copy.png'], available: 1 },
    { name: 'two distinct body images', filenames: ['frame.png', 'frame-1.png'], available: 2 },
    { name: 'valid body images plus excluded duplicates', filenames: ['cover-copy.png', 'frame.png', 'frame-copy.png', 'frame-1.png'], available: 2 },
  ]
  for (const scenario of cases) await t.test(scenario.name, async child => {
    const h = await articleFixture(child)
    const directory = path.join(h.root, 'history-articles', '71')
    fs.copyFileSync(path.join(directory, 'frame.png'), path.join(directory, 'frame-copy.png'))
    fs.copyFileSync(path.join(h.root, 'history-deliveries', '71', '4x3.png'), path.join(directory, 'cover-copy.png'))
    const article = h.articleState.article!
    article.screenshots = scenario.filenames.map((filename, index) => ({ url: `/static/history-articles/71/${filename}`, timestamp: index, sectionIndex: 0 }))
    article.html = `<p>当前文章正文</p>${article.screenshots.map(image => `<img src="${image.url}">`).join('')}`
    const report = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article', 'baijiahao-video', 'tencent-video'] })
    const item = report.items[0]!
    assert.equal(item.ready, scenario.available >= 2)
    const shortage = item.blockers.filter(issue => issue.code === 'article_cover_images_missing')
    if (scenario.available < 2) {
      assert.equal(shortage.length, 1)
      assert.equal(shortage[0]!.field, 'article.screenshots')
      assert.ok(shortage[0]!.message.includes(`当前可用 ${scenario.available} 张`))
      assert.ok(shortage[0]!.message.includes(`还缺 ${2 - scenario.available} 张`))
    } else assert.deepEqual(shortage, [])
    assert.ok(report.items.slice(1).every(video => video.ready && video.blockers.length === 0))
    assert.deepEqual(h.calls, [])
    assert.deepEqual(h.service.listJobs(), [])
  })
})

test('article cover shortage blocks only the article job while video targets still save drafts', async t => {
  const h = await articleFixture(t)
  h.articleState.article!.screenshots = h.articleState.article!.screenshots.slice(0, 1)
  h.articleState.article!.html = '<p>当前文章正文</p><img src="/static/history-articles/71/frame.png">'
  const receipt = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article', 'baijiahao-video', 'tencent-video'] })
  assert.deepEqual(receipt.jobs.map(job => job.status), ['failed', 'queued', 'queued'])
  assert.ok(receipt.jobs[0]!.blockers.some(issue => issue.code === 'article_cover_images_missing' && issue.message.includes('还缺 1 张')))
  await h.service.runPending()
  assert.deepEqual(receipt.jobs.map(job => h.service.getJob(job.id).status), ['failed', 'completed', 'completed'])
  assert.deepEqual(h.calls.map(payload => payload.target), ['baijiahao-video', 'tencent-video'])
})

test('missing article image manifest blocks preflight without pausing later video jobs', async t => {
  const h = await articleFixture(t)
  fs.unlinkSync(path.join(h.root, 'history-articles/71/body-cover-selection.json'))
  const input = { mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article', 'baijiahao-video', 'tencent-video'] as SocialTarget[] }
  const report = await h.service.preflight(input)
  assert.equal(report.items[0]!.ready, false)
  assert.deepEqual(report.items[0]!.blockers, [{ code: 'article_images_not_prepared', field: 'article.screenshots',
    message: '文章配图尚未准备完成，请先在文章生成阶段补齐；尚未开始上传' }])
  assert.ok(report.items.slice(1).every(item => item.ready))
  assert.equal(h.calls.length, 0)
  assert.deepEqual(h.service.listJobs(), [])

  const receipt = await h.service.enqueue(input)
  assert.deepEqual(receipt.jobs.map(job => job.status), ['failed', 'queued', 'queued'])
  assert.equal(h.service.queueState().paused, false)
  await h.service.runPending()
  assert.deepEqual(receipt.jobs.map(job => h.service.getJob(job.id).status), ['failed', 'completed', 'completed'])
  assert.deepEqual(h.calls.map(payload => payload.target), ['baijiahao-video', 'tencent-video'])
  assert.equal(h.service.getJob(receipt.jobs[0]!.id).result, null)
  assert.equal(h.service.queueState().paused, false)
})

test('article image manifest recheck blocks a queued article and lets the next draft proceed', async t => {
  const h = await articleFixture(t)
  const receipt = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article', 'tencent-video'] })
  assert.deepEqual(receipt.jobs.map(job => job.status), ['queued', 'queued'])
  fs.unlinkSync(path.join(h.root, 'history-articles/71/body-cover-selection.json'))
  await h.service.runPending()
  const blocked = h.service.getJob(receipt.jobs[0]!.id)
  assert.equal(blocked.status, 'failed')
  assert.equal(blocked.blockers[0]!.code, 'article_images_not_prepared')
  assert.equal(blocked.fingerprint, receipt.jobs[0]!.fingerprint)
  assert.equal(blocked.result, null)
  assert.equal(h.service.getJob(receipt.jobs[1]!.id).status, 'completed')
  assert.deepEqual(h.calls.map(payload => payload.target), ['tencent-video'])
  assert.equal(h.service.queueState().paused, false)
})

test('article image manifest requires two distinct current body images excluding the main cover', async t => {
  type Manifest = { version: number; images: Array<{ url: string; sha256: string }> }
  const scenarios: Array<[string, (manifest: Manifest, h: Awaited<ReturnType<typeof articleFixture>>) => void]> = [
    ['wrong version', manifest => { manifest.version = 2 }],
    ['one image', manifest => { manifest.images.pop() }],
    ['three images', manifest => { manifest.images.push({ ...manifest.images[0]! }) }],
    ['duplicate URL', manifest => { manifest.images[1]!.url = manifest.images[0]!.url }],
    ['wrong SHA', manifest => { manifest.images[1]!.sha256 = '0'.repeat(64) }],
    ['unavailable image', manifest => { manifest.images[1]!.url = '/static/history-articles/71/absent.png' }],
    ['mixed screenshot directories', (manifest, h) => {
      const previous = manifest.images[1]!.url
      const url = '/static/history-articles/71/other/frame-1.png'
      const filename = path.join(h.root, url.replace('/static/', ''))
      fs.mkdirSync(path.dirname(filename))
      fs.renameSync(path.join(h.root, previous.replace('/static/', '')), filename)
      manifest.images[1]!.url = url
      h.articleState.article!.screenshots[1]!.url = url
      h.articleState.article!.html = h.articleState.article!.html.replace(previous, url)
    }],
    ['not embedded in body', (manifest, h) => { h.articleState.article!.html = `<p>正文</p><img src="${manifest.images[0]!.url}">` }],
    ['data-src is not an image ref', (manifest, h) => { h.articleState.article!.html = `<p>正文</p><img src="${manifest.images[0]!.url}"><img data-src="${manifest.images[1]!.url}">` }],
    ['comment is not an image ref', (manifest, h) => { h.articleState.article!.html = `<p>正文</p><img src="${manifest.images[0]!.url}"><!-- <img src="${manifest.images[1]!.url}"> -->` }],
    ['same bytes as main cover', (manifest, h) => {
      const filename = path.join(h.root, manifest.images[0]!.url.replace('/static/', ''))
      fs.copyFileSync(path.join(h.root, 'history-deliveries/71/4x3.png'), filename)
      manifest.images[0]!.sha256 = createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
    }],
  ]
  for (const [name, change] of scenarios) await t.test(name, async child => {
    const h = await articleFixture(child)
    const filename = saveArticleCoverSelection(h)
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8')) as Manifest
    change(manifest, h)
    fs.writeFileSync(filename, JSON.stringify(manifest))
    const report = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article'] })
    assert.equal(report.items[0]!.ready, false)
    assert.ok(report.items[0]!.blockers.some(issue => issue.code === 'article_images_not_prepared' && issue.field === 'article.screenshots'))
    assert.deepEqual(h.calls, [])
  })
})

test('article image manifest cannot be a symlink even when its contents are valid', async t => {
  const h = await articleFixture(t)
  const filename = path.join(h.root, 'history-articles/71/body-cover-selection.json')
  const target = path.join(h.root, 'history-articles/71/selection-copy.json')
  fs.renameSync(filename, target)
  fs.symlinkSync(target, filename)
  const report = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article'] })
  assert.equal(report.items[0]!.ready, false)
  assert.deepEqual(report.items[0]!.blockers.map(issue => issue.code), ['article_images_not_prepared'])
  assert.deepEqual(h.calls, [])
})

test('article image manifest detects a replaced file by SHA before uploading', async t => {
  const h = await articleFixture(t)
  await sharp({ create: { width: 32, height: 24, channels: 3, background: '#0000ff' } }).png()
    .toFile(path.join(h.root, 'history-articles/71/frame.png'))
  const report = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article'] })
  assert.deepEqual(report.items[0]!.blockers.map(issue => issue.code), ['article_images_not_prepared'])
  assert.deepEqual(h.calls, [])
})

test('valid article manifest uses generation selection without invoking quality scoring', async t => {
  const h = await articleFixture(t)
  Object.defineProperty(h.runtime, 'validateSocialUploadMaterials', { get() { throw new Error('upload must not invoke quality scoring') } })
  const receipt = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article'] })
  assert.equal(receipt.jobs[0]!.status, 'queued')
  await h.service.runPending()
  assert.equal(h.service.getJob(receipt.jobs[0]!.id).status, 'completed')
  assert.equal(h.calls.length, 1)
})

test('article cover validation preserves payload and reuses completed snapshots across service restarts and modes', async t => {
  const h = await articleFixture(t)
  const input = { mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article'] as SocialTarget[] }
  const fingerprint = (await h.service.preflight(input)).items[0]!.fingerprint
  fs.unlinkSync(path.join(h.root, 'history-articles/71/body-cover-selection.json'))
  const missing = (await h.service.preflight(input)).items[0]!
  assert.equal(missing.ready, false)
  assert.equal(missing.fingerprint, fingerprint)
  saveArticleCoverSelection(h)
  const repaired = (await h.service.preflight(input)).items[0]!
  assert.equal(repaired.ready, true)
  assert.equal(repaired.fingerprint, fingerprint)
  const receipt = await h.service.enqueue(input)
  const id = receipt.jobs[0]!.id
  await h.service.runPending()
  assert.equal(h.service.getJob(id).status, 'completed')
  assert.equal(h.service.getJob(id).fingerprint, fingerprint)
  assert.deepEqual(Object.keys(h.calls[0]!).sort(),
    ['articleHtml', 'description', 'fingerprint', 'images', 'jobId', 'landscapePath', 'scriptId', 'target', 'title'])
  assert.deepEqual(h.calls[0]!.images, h.articleState.article!.screenshots.map(image => ({
    url: image.url, path: path.join(h.root, image.url.replace('/static/', '')),
  })))
  const reopened = new HistorySocialUploadService(h.options)
  try {
    const repeated = await reopened.enqueue({ ...input, mode: 'stage' })
    assert.equal(repeated.jobs[0]!.id, id)
    assert.equal(repeated.jobs[0]!.status, 'completed')
    assert.equal(repeated.jobs[0]!.reused, true)
    assert.equal(repeated.jobs[0]!.fingerprint, fingerprint)
    await reopened.runPending()
    assert.equal(reopened.listJobs().length, 1)
    assert.equal(h.calls.length, 1)
  } finally { await reopened.close() }
})

test('article uses the saved current article and real project images with a 4:3 cover', async t => {
  const h = await fixture(t)
  const directory = path.join(h.root, 'history-articles', '71', 'abc123')
  fs.mkdirSync(directory, { recursive: true })
  await sharp({ create: { width: 32, height: 18, channels: 3, background: '#ffffff' } }).jpeg().toFile(path.join(directory, 'frame-0.jpg'))
  await sharp({ create: { width: 32, height: 18, channels: 3, background: '#ff0000' } }).jpeg().toFile(path.join(directory, 'frame-1.jpg'))
  const imageUrl = '/static/history-articles/71/abc123/frame-0.jpg'
  const secondImageUrl = '/static/history-articles/71/abc123/frame-1.jpg'
  h.articleState.status = 'completed'
  h.articleState.article = {
    title: '文章当前的保存标题', html: `<section><p>已保存的文章内容</p><img src="${imageUrl}"><img src="${secondImageUrl}"></section>`, markdown: '已保存的文章内容',
    sections: [{ heading: '第一节', paragraphs: [{ text: '已保存的文章内容', highlights: [], sourceEvidence: [] }] }],
    screenshots: [{ url: imageUrl, timestamp: 0, sectionIndex: 0 }, { url: secondImageUrl, timestamp: 1, sectionIndex: 0 }], sourceLength: 8, articleLength: 8,
    generatedAt: new Date().toISOString(), selectionMethod: 'model-adapted', notices: [],
    provenance: { correctedSha256: 'current', sourceMetadataSha256: 'current', rewrittenSha256: hash(h.source.rewrittenScript!),
      videoUrl: h.source.delivery!.videoUrl!, videoFingerprint: 'current' },
  }
  delete h.source.delivery!.covers['16:9']
  delete h.source.delivery!.covers['3:4']
  saveArticleCoverSelection(h)
  const report = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article'] })
  assert.equal(report.items[0]!.ready, true)
  assert.equal(report.items[0]!.engine, 'project-extension')
  assert.equal(h.calls.length, 0)
  const receipt = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-article'], mode: 'stage' })
  await h.service.runPending()
  assert.equal(h.service.getJob(receipt.jobs[0]!.id).status, 'awaiting_confirmation')
  assert.equal(h.calls[0]!.title, h.articleState.article.title)
  assert.equal(h.calls[0]!.landscapePath, path.join(h.root, 'history-deliveries', '71', '4x3.png'))
  assert.equal(h.calls[0]!.portraitPath, undefined)
  assert.equal(h.calls[0]!.images![0]!.path, path.join(directory, 'frame-0.jpg'))
  h.articleState.stale = true
  assert.equal((await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article'] })).items[0]!.ready, false)
  h.articleState.stale = false
  h.articleState.article.screenshots[0]!.url = imageUrl.replace('/71/', '/72/')
  assert.ok((await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-article'] })).items[0]!.blockers.some(issue => issue.code === 'asset_ownership'))
})

test('Baijiahao video preflight reports its 50-character limit on the saved title without truncating it', async t => {
  const h = await fixture(t)
  const input = { sourceIds: [71], targets: ['baijiahao-video'] as SocialTarget[], mode: 'stage' as const }
  const title = '朱棣'.repeat(25)
  h.source.delivery!.baijiahaoTitle = title
  assert.equal((await h.service.preflight(input)).items[0]!.ready, true)
  const blockedTitle = title + '？'
  h.source.delivery!.baijiahaoTitle = blockedTitle
  const item = (await h.service.preflight(input)).items[0]!
  assert.equal(item.ready, false)
  assert.deepEqual(item.blockers, [{ code: 'title_length', field: 'title',
    message: '百家号视频发布标题共51字，需为2至50字；完整原标题已保留，请在成片与封面中精简发布标题后继续' }])
  const receipt = await h.service.enqueue(input)
  assert.equal(receipt.jobs[0]!.status, 'failed')
  assert.deepEqual(receipt.jobs[0]!.blockers, item.blockers)
  await h.service.runPending()
  assert.deepEqual(h.calls, [])
  assert.equal(h.source.delivery!.baijiahaoTitle, blockedTitle)
  assert.equal(h.source.title, '历史项目，不是 episode')
})

test('the Baijiahao video title limit leaves article titles up to 64 characters usable', async t => {
  const h = await articleFixture(t)
  h.articleState.article!.title = '朱棣'.repeat(32)
  const report = await h.service.preflight({ sourceIds: [71], targets: ['baijiahao-article'], mode: 'stage' })
  assert.equal(report.items[0]!.ready, true)
  assert.deepEqual(h.calls, [])
})

test('Tencent preflight requires a nonempty description and names missing covers clearly', async t => {
  const h = await fixture(t)
  h.source.delivery!.description = '   '
  delete h.source.delivery!.covers['4:3']
  const report = await h.service.preflight({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video', 'tencent-video'] })
  assert.equal(report.items[0]!.ready, true)
  const blockers = report.items[1]!.blockers
  assert.ok(blockers.some(issue => issue.code === 'description_missing' && issue.field === 'description'))
  assert.ok(blockers.some(issue => issue.field === 'covers.4:3' && issue.message.includes('4:3 横版封面')))
  assert.ok(blockers.every(issue => !issue.message.startsWith('covers.')))
  assert.equal(h.calls.length, 0)
})

test('confirm rejects a different CDP target while retaining original stage evidence', async t => {
  const h = await fixture(t)
  const receipt = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'stage' })
  const id = receipt.jobs[0]!.id
  await h.service.runPending()
  const original = h.service.getJob(id).result!
  h.runtime.confirmSocialUpload = async (_payload, previous) => ({ ...previous, saved: true, targetId: 'another-editor' })
  const confirmed = await h.service.confirm(id)
  assert.equal(confirmed.status, 'failed')
  assert.equal(confirmed.result?.targetId, original.targetId)
  await assert.rejects(h.service.confirm(id), /awaiting_confirmation/)
  assert.equal(h.calls.length, 1)
})

test('structured progress is visible while running and completed proof replaces stale error progress', async t => {
  const h = await fixture(t)
  h.runtime.runSocialUpload = async (payload, options) => {
    options.onProgress?.('视频已上传，正在处理横版封面', { step: 'landscape_cover', message: '视频已上传，正在处理横版封面' })
    const job = h.service.getJob(payload.jobId)
    assert.equal(job.status, 'running')
    assert.equal(job.progress?.step, 'landscape_cover')
    assert.match(job.message, /横版封面/)
    return h.result(payload, options.saveDraft)
  }
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
  await h.service.runPending()
  assert.equal(h.service.getJob(jobs[0]!.id).progress?.step, 'saved')
  assert.equal(h.service.getJob(jobs[0]!.id).error, null)
})

test('a startup failure before dispatch can be requeued under the same job without changing its snapshot', async t => {
  const h = await fixture(t)
  const input = { mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] as SocialTarget[] }
  const { jobs } = await h.service.enqueue(input)
  const database = new Database(h.options.databasePath)
  database.prepare("UPDATE history_social_upload_jobs SET status='failed',operation='upload',message='startup failed',upload_dispatched=0 WHERE id=?").run(jobs[0]!.id)
  database.close()
  const again = await h.service.enqueue(input)
  assert.equal(again.jobs[0]!.id, jobs[0]!.id)
  assert.equal(again.jobs[0]!.status, 'queued')
  await h.service.runPending()
  assert.equal(h.service.getJob(jobs[0]!.id).status, 'completed')
  assert.equal(h.calls.length, 1)
})

test('manual retry queues the same failed job immediately and uses materials repaired since submission', async t => {
  const h = await fixture(t)
  const cover = h.source.delivery!.covers['4:3']!
  delete h.source.delivery!.covers['4:3']
  const original = (await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })).jobs[0]!
  assert.equal(original.status, 'failed')
  h.source.delivery!.covers['4:3'] = cover
  let checks = 0
  const inspect = h.runtime.inspectSocialUploadRuntime
  h.runtime.inspectSocialUploadRuntime = async () => { checks++; return inspect() }
  const queued = h.service.retry(original.id)
  assert.equal(queued.id, original.id)
  assert.equal(queued.status, 'queued')
  assert.equal(checks, 0, 'queue acceptance must not wait for browser initialization')
  assert.equal(h.service.retry(original.id).status, 'queued', 'a repeated click must not create a second job')
  await h.service.runPending()
  const saved = h.service.getJob(original.id)
  assert.equal(saved.status, 'completed')
  assert.notEqual(saved.fingerprint, original.fingerprint)
  assert.equal(saved.createdAt, original.createdAt)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0]!.landscapePath, path.join(h.root, 'history-deliveries/71/4x3.png'))
  assert.equal(h.service.listJobs().length, 1)
  assert.equal(h.service.retry(original.id).status, 'completed')
  await h.service.runPending()
  assert.equal(h.calls.length, 1)
})

test('batch retry reports skipped jobs and keeps missing materials actionable while healthy targets finish', async t => {
  const h = await fixture(t)
  delete h.source.delivery!.covers['4:3']
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video', 'baijiahao-video'] })
  const queued = h.service.retryMany([jobs[0]!.id, jobs[0]!.id, jobs[1]!.id, '999'])
  assert.deepEqual(queued.jobs.map(job => job.id), [jobs[0]!.id])
  assert.deepEqual(queued.skipped.map(item => item.id), [jobs[1]!.id, '999'])
  await h.service.runPending()
  assert.equal(h.service.getJob(jobs[0]!.id).status, 'failed')
  assert.match(h.service.getJob(jobs[0]!.id).message, /4:3/)
  assert.equal(h.service.getJob(jobs[1]!.id).status, 'completed')
  assert.equal(h.calls.length, 1)
})

test('retry of an old blocked snapshot does not upload over an already completed current snapshot', async t => {
  const h = await fixture(t)
  const cover = h.source.delivery!.covers['4:3']!
  delete h.source.delivery!.covers['4:3']
  const original = (await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })).jobs[0]!
  h.source.delivery!.covers['4:3'] = cover
  const current = (await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })).jobs[0]!
  await h.service.runPending()
  assert.equal(h.service.getJob(current.id).status, 'completed')
  h.service.retry(original.id)
  await h.service.runPending()
  assert.equal(h.service.getJob(original.id).status, 'canceled')
  assert.match(h.service.getJob(original.id).message, new RegExp(`#${current.id}`))
  assert.equal(h.calls.length, 1)
})

test('retry can join an active queue and waits for the current platform write to finish', async t => {
  const h = await fixture(t)
  const cover = h.source.delivery!.covers['4:3']!
  delete h.source.delivery!.covers['4:3']
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video', 'baijiahao-video'] })
  h.source.delivery!.covers['4:3'] = cover
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  h.runtime.runSocialUpload = async (payload, options) => {
    h.calls.push(payload)
    if (payload.target === 'baijiahao-video') { entered(); await hold }
    return h.result(payload, options.saveDraft)
  }
  const running = h.service.runPending()
  await started
  try {
    assert.equal(h.service.getJob(jobs[1]!.id).status, 'running')
    assert.equal(h.service.retry(jobs[0]!.id).status, 'queued')
    assert.equal(h.calls.length, 1)
  } finally { release() }
  await running
  assert.deepEqual(h.calls.map(call => call.target), ['baijiahao-video', 'tencent-video'])
  assert.ok(h.service.listJobs().every(job => job.status === 'completed'))
})

test('retry reports missing local materials without opening or checking a platform browser', async t => {
  const h = await fixture(t)
  delete h.source.delivery!.covers['4:3']
  const job = (await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })).jobs[0]!
  let checks = 0
  h.runtime.inspectSocialUploadRuntime = async () => { checks++; throw new Error('must not inspect before local material is ready') }
  h.service.retry(job.id)
  await h.service.runPending()
  assert.equal(h.service.getJob(job.id).status, 'failed')
  assert.match(h.service.getJob(job.id).message, /4:3/)
  assert.equal(checks, 0)
  assert.equal(h.calls.length, 0)
})

async function enableBackground(h: Awaited<ReturnType<typeof fixture>>) {
  const inspect = h.runtime.inspectSocialUploadRuntime
  h.runtime.inspectHistorySocialUploadRuntime = async () => {
    const value = await inspect()
    return { ...value, execution: 'background', platforms: {
      baijiahao: { ...value.platforms.baijiahao, sessionMode: 'background', accountName: 'history_baijiahao' },
      tencent: { ...value.platforms.tencent, sessionMode: 'background', accountName: 'history_tencent' },
    } }
  }
  const run = h.runtime.runSocialUpload
  h.runtime.runSocialUpload = async (payload, options) => ({ ...await run(payload, options), accountName: payload.accountName })
  await h.service.inspectRuntime(true)
}

test('background login and verification failures stay failed and transient checks require the expected account binding', async t => {
  const h = await fixture(t)
  await enableBackground(h)
  const inspect = h.runtime.inspectHistorySocialUploadRuntime!
  for (const issue of ['login_required', 'verification_required', 'browser_unavailable', 'connection_failed', 'check_failed'] as const) {
    h.runtime.inspectHistorySocialUploadRuntime = async refresh => {
      const value = await inspect(refresh)
      value.platforms.tencent = { ...value.platforms.tencent, ready: false, issue, message: issue,
        ...(['connection_failed', 'check_failed'].includes(issue) ? { accountName: 'unrelated' } : {}) }
      return value
    }
    const receipt = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
    assert.equal(receipt.items[0]!.ready, false)
    assert.equal(receipt.jobs[0]!.status, 'failed')
  }
  await h.service.runPending()
  assert.equal(h.calls.length, 0)
  h.runtime.inspectSocialUploadRuntime = async () => ({ installed: true, version: 'test', message: 'preview', platforms: {
    baijiahao: { ready: false, issue: 'check_failed', message: 'visible check failed' }, tencent: { ready: true, message: 'ready' },
  } })
  assert.equal((await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'stage' })).jobs[0]!.status, 'failed')
})

test('a blocked background snapshot requeues under a new request once its runtime recovers', async t => {
  const h = await fixture(t)
  await enableBackground(h)
  const inspect = h.runtime.inspectHistorySocialUploadRuntime!
  let expired = true
  h.runtime.inspectHistorySocialUploadRuntime = async refresh => {
    const value = await inspect(refresh)
    if (expired) value.platforms.tencent = { ...value.platforms.tencent, ready: false, issue: 'login_required', message: '请登录' }
    return value
  }
  const input = { mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] as SocialTarget[], requestId: 'old-blocked' }
  const original = (await h.service.enqueue(input)).jobs[0]!
  assert.equal(original.status, 'failed')
  expired = false
  assert.equal((await h.service.preflight(input, true)).items[0]!.ready, true)
  assert.equal((await h.service.enqueue(input)).jobs[0]!.status, 'failed', 'replaying a receipt must not dispatch')
  const repeated = (await h.service.enqueue({ ...input, requestId: 'recovered' })).jobs[0]!
  assert.equal(repeated.id, original.id)
  assert.equal(repeated.status, 'queued')
  await h.service.runPending()
  assert.equal(h.calls.length, 1)
})

test('all history targets bind their own background sessions and keep completed-request deduplication', async t => {
  const h = await articleFixture(t)
  await enableBackground(h)
  const targets = ['baijiahao-video', 'baijiahao-article', 'tencent-video'] as const
  const first = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: [...targets], requestId: 'background-three' })
  assert.deepEqual(first.items.map(item => item.ready), [true, true, true])
  assert.equal(first.runtime.execution, 'background')
  await h.service.runPending()
  assert.deepEqual(h.calls.map(payload => payload.accountName), ['history_baijiahao', 'history_baijiahao', 'history_tencent'])
  assert.ok(h.service.listJobs().every(job => job.status === 'completed' && job.result?.saved && !job.result?.published))
  const again = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: [...targets], requestId: 'background-again' })
  assert.deepEqual(again.jobs.map(job => job.id), first.jobs.map(job => job.id))
  await h.service.runPending()
  assert.equal(h.calls.length, 3, 'Background migration must not create duplicate saved drafts')
})

test('an undispatched legacy queue entry adopts background execution without changing task or material identity', async t => {
  const h = await fixture(t)
  const original = (await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })).jobs[0]!
  await enableBackground(h)
  await h.service.runPending()
  const updated = h.service.getJob(original.id)
  assert.equal(updated.fingerprint, original.fingerprint)
  assert.equal(updated.status, 'completed')
  assert.equal(h.calls[0]!.accountName, 'history_baijiahao')
  assert.equal(h.service.listJobs().length, 1)
})

test('staged legacy editors retain their original visible session when the background runtime becomes available', async t => {
  const h = await fixture(t)
  const original = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'stage' })).jobs[0]!
  await h.service.runPending()
  await enableBackground(h)
  let legacyReads = 0, backgroundReads = 0
  const oldInspect = h.runtime.inspectSocialUploadRuntime
  h.runtime.inspectSocialUploadRuntime = async () => { legacyReads++; return oldInspect() }
  h.runtime.inspectHistorySocialUploadRuntime = async () => { backgroundReads++; throw new Error('Must retain the original editor session') }
  const saved = await h.service.confirm(original.id)
  assert.equal(saved.status, 'completed')
  assert.equal(saved.result!.accountName, undefined)
  assert.equal(legacyReads, 1)
  assert.equal(backgroundReads, 0)
  assert.equal(h.calls.length, 1)
})

test('login synchronization pauses dispatch and failed synchronization releases the queue and retry control', async t => {
  const h = await fixture(t)
  await enableBackground(h)
  await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
  let release!: () => void
  h.runtime.syncHistorySocialUploadLogin = async platform => {
    await new Promise<void>(resolve => { release = resolve })
    return { synced: true, platform, message: '后台登录已同步' }
  }
  const syncing = h.service.syncLogin('tencent')
  while (!release) await new Promise(resolve => setImmediate(resolve))
  assert.throws(() => h.service.syncLogin('baijiahao'), /正在同步登录/)
  await h.service.runPending()
  assert.equal(h.calls.length, 0)
  release()
  await syncing
  h.runtime.syncHistorySocialUploadLogin = async () => { throw new Error('请先完成登录') }
  await assert.rejects(h.service.syncLogin('tencent'), /请先完成登录/)
  await h.service.runPending()
  assert.equal(h.calls.length, 1)
  assert.equal(h.service.listJobs()[0]!.status, 'completed')
})

test('an unrelated account receipt fails while the next target can still finish', async t => {
  const h = await fixture(t)
  await enableBackground(h)
  const run = h.runtime.runSocialUpload
  h.runtime.runSocialUpload = async (payload, options) => ({ ...await run(payload, options),
    accountName: payload.target === 'baijiahao-video' ? 'cba_unrelated' : payload.accountName })
  await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video', 'tencent-video'] })
  await h.service.runPending()
  assert.equal(h.service.listJobs().find(job => job.target === 'baijiahao-video')!.status, 'failed')
  assert.match(h.service.listJobs().find(job => job.target === 'baijiahao-video')!.error!, /账号与原任务不一致/)
  assert.equal(h.service.listJobs().find(job => job.target === 'tencent-video')!.status, 'completed')
  assert.equal(h.calls.length, 2)
})

test('an explicit preview keeps its visible editor while normal draft uploads use background sessions', async t => {
  const h = await fixture(t)
  await enableBackground(h)
  h.runtime.inspectHistorySocialUploadRuntime = async () => { throw new Error('A visual preview must use its visible editor session') }
  const preview = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'stage' })
  assert.equal(preview.items[0]!.ready, true)
  await h.service.runPending()
  assert.equal(h.calls[0]!.accountName, undefined)
  assert.equal(h.service.getJob(preview.jobs[0]!.id).status, 'awaiting_confirmation')
})

test('manual uploaded markers persist per target and skip runtime, material checks and duplicate jobs', async t => {
  const h = await fixture(t)
  const marked = await h.service.markUploaded({ sourceIds: [71, 71], targets: ['baijiahao-video', 'baijiahao-article', 'tencent-video'] })
  assert.equal(marked.marked, 3)
  assert.ok(Object.values(marked.items[0]!.uploads).every(value => value.confirmation === 'manual'))
  h.source.delivery = null
  h.runtime.inspectSocialUploadRuntime = async () => { throw new Error('must not inspect already uploaded projects') }
  const input = { mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video', 'baijiahao-article', 'tencent-video'] as SocialTarget[] }
  const preflight = await h.service.preflight(input)
  assert.equal(preflight.runtime, undefined)
  assert.ok(preflight.items.every(item => item.uploaded?.confirmation === 'manual' && !item.ready && !item.blockers.length))
  const receipt = await h.service.enqueue(input)
  assert.deepEqual(receipt.jobs, [])
  await h.service.runPending()
  assert.equal(h.calls.length, 0)
  assert.equal((await h.service.markUploaded({sourceIds:input.sourceIds,targets:input.targets})).marked, 0)
  const reopened = new HistorySocialUploadService(h.options)
  try { assert.deepEqual(reopened.uploads(71), h.service.uploads(71)) } finally { await reopened.close() }
})

test('saved platform proof marks only that target and survives later metadata changes', async t => {
  const h = await fixture(t)
  const first = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })
  await h.service.runPending()
  assert.equal(h.service.uploads(71)['baijiahao-video']?.confirmation, 'platform')
  assert.equal(h.service.uploads(71)['tencent-video'], undefined)
  h.source.delivery!.baijiahaoTitle = '已经上传后的新标题'
  const second = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video', 'tencent-video'] })
  assert.equal(second.items[0]!.uploaded?.confirmation, 'platform')
  assert.equal(second.jobs[0]!.id, first.jobs[0]!.id)
  assert.equal(second.jobs[0]!.reused, true)
  await h.service.runPending()
  assert.deepEqual(h.calls.map(call => call.target), ['baijiahao-video', 'tencent-video'])
  assert.equal((await h.service.markUploaded({ sourceIds: [71], targets: ['baijiahao-video'] })).marked, 0)
  assert.equal(h.service.uploads(71)['baijiahao-video']?.confirmation, 'platform')
})

test('manual confirmation cancels obsolete pending and blocked tasks without inventing a platform receipt', async t => {
  const h = await fixture(t)
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video', 'baijiahao-article'] })
  await h.service.markUploaded({ sourceIds: [71], targets: ['baijiahao-video', 'baijiahao-article'] })
  await h.service.runPending()
  assert.equal(h.calls.length, 0)
  assert.equal(h.service.queueState().attentionCount, 0)
  for (const job of jobs) {
    const current = h.service.getJob(job.id)
    assert.equal(current.status, 'canceled')
    assert.equal(current.result, null)
    assert.match(current.message, /用户已确认/)
    assert.throws(() => h.service.retry(job.id), /只有失败/)
  }
})

test('manual confirmation refuses an in-flight save atomically', async t => {
  const h = await fixture(t)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  h.runtime.runSocialUpload = async (payload, options) => { entered(); await hold; return h.result(payload, options.saveDraft) }
  await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })
  const running = h.service.runPending()
  await started
  try {
    await assert.rejects(h.service.markUploaded({ sourceIds: [71], targets: ['tencent-video', 'baijiahao-video'] }), /正在上传/)
    assert.deepEqual(h.service.uploads(71), {})
  } finally { release(); await running }
})

test('a manual mark during async enqueue preparation wins and prevents dispatch', async t => {
  const h = await fixture(t)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  const inspect = h.runtime.inspectSocialUploadRuntime
  h.runtime.inspectSocialUploadRuntime = async () => { entered(); await hold; return inspect() }
  const enqueue = h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })
  await started
  await h.service.markUploaded({ sourceIds: [71], targets: ['baijiahao-video'] })
  release()
  const receipt = await enqueue
  assert.deepEqual(receipt.jobs, [])
  assert.equal(receipt.items[0]!.uploaded?.confirmation, 'manual')
  await h.service.runPending()
  assert.equal(h.calls.length, 0)
})

test('draft policy: an upload failure closes its page once and never resumes on subsequent polls', async t => {
  const h = await fixture(t)
  let closed = 0
  const run = h.runtime.runSocialUpload
  h.runtime.runSocialUpload = async (payload, options) => {
    if (payload.target === 'tencent-video') { h.calls.push(payload); throw new Error('cover failed') }
    return run(payload, options)
  }
  Object.assign(h.runtime, {
    closeFailedSocialUpload: async () => { closed++; return {} },
    inspectSocialUploadCheckpoint: async () => { assert.fail('no checkpoint recovery') },
    resumeSocialUpload: async () => { assert.fail('no resume') },
    reconcileSocialUpload: async () => { assert.fail('no reconciliation') },
  })
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video', 'baijiahao-video'] })
  await h.service.runPending()
  const failed = h.service.getJob(jobs[0]!.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /cover failed/)
  assert.equal(failed.recovery.action, null)
  assert.equal(failed.recovery.nextAttemptAt, null)
  assert.equal(h.service.getJob(jobs[1]!.id).status, 'completed')
  for (let i = 0; i < 3; i++) await h.service.runPending()
  assert.equal(closed, 1)
  assert.equal(h.calls.length, 2)
})

test('draft policy: retry resets the OLD attempt before reading current materials and uploads afresh with the same ID', async t => {
  const h = await fixture(t)
  h.runtime.runSocialUpload = async payload => { h.calls.push(payload); throw new Error('save failed') }
  Object.assign(h.runtime, { closeFailedSocialUpload: async () => ({}) })
  const original = (await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })).jobs[0]!
  await h.service.runPending()
  const oldPayload = structuredClone(h.calls[0]!)
  h.source.delivery!.title = '运输方式与明朝菜价'
  const events: string[] = []
  const source = h.options.loadSource
  h.options.loadSource = async id => { events.push('materials'); return source(id) }
  Object.assign(h.runtime, { resetSocialUploadAttempt: async (payload: SocialUploadPayload) => {
    events.push('reset')
    assert.deepEqual(payload, oldPayload)
    return {}
  } })
  h.runtime.runSocialUpload = async (payload, options) => {
    events.push('upload'); h.calls.push(payload)
    assert.equal(options.saveDraft, true)
    assert.equal(payload.jobId, original.id)
    assert.equal(payload.title, h.source.delivery!.title)
    assert.notEqual(payload.fingerprint, oldPayload.fingerprint)
    return { ...h.result(payload, true), targetId: 'fresh-editor' }
  }
  assert.equal(h.service.retry(original.id).status, 'queued')
  assert.equal(h.service.retry(original.id).status, 'queued')
  await h.service.runPending()
  assert.equal(events[0], 'reset')
  assert.equal(events.at(-1), 'upload')
  assert.equal(events.filter(event => event === 'reset').length, 1)
  assert.equal(h.service.getJob(original.id).status, 'completed')
  assert.equal(h.service.getJob(original.id).createdAt, original.createdAt)
  assert.equal(h.service.listJobs().length, 1)
  assert.equal(h.calls.length, 2)
})

test('draft policy: a lost reply uses only a confirmed local saved receipt and never retries saving', async t => {
  const h = await fixture(t)
  h.runtime.runSocialUpload = async payload => { h.calls.push(payload); throw new Error('reply lost') }
  Object.assign(h.runtime, { closeFailedSocialUpload: async (payload: SocialUploadPayload) => ({ result: h.result(payload, true) }) })
  h.runtime.confirmSocialUpload = async () => { assert.fail('must not save twice') }
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
  await h.service.runPending()
  assert.equal(h.service.getJob(jobs[0]!.id).status, 'completed')
  assert.equal(h.service.retry(jobs[0]!.id).status, 'completed')
  await h.service.runPending()
  assert.equal(h.calls.length, 1)
})

test('draft policy: busy or unavailable reset cannot dispatch, clear the old snapshot or auto-retry', async t => {
  for (const kind of ['missing', 'busy', 'unsaved-result'] as const) await t.test(kind, async t => {
    const h = await fixture(t)
    const run = h.runtime.runSocialUpload
    h.runtime.runSocialUpload = async payload => { h.calls.push(payload); throw new Error('failed attempt') }
    h.runtime.closeFailedSocialUpload = async () => ({})
    const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
    await h.service.runPending()
    const oldPayload = h.calls[0]!
    h.source.delivery!.title = '修改后的蔬菜供应标题'
    let resets = 0
    if (kind !== 'missing') h.runtime.resetSocialUploadAttempt = async payload => {
      resets++
      assert.deepEqual(payload, oldPayload)
      if (kind === 'busy') throw new Error('original account/job lock busy')
      return { result: h.result(payload, false) }
    }
    h.runtime.runSocialUpload = run
    h.service.retry(jobs[0]!.id)
    await h.service.runPending()
    const failed = h.service.getJob(jobs[0]!.id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.fingerprint, oldPayload.fingerprint)
    assert.equal(h.calls.length, 1)
    for (let i = 0; i < 3; i++) await h.service.runPending()
    assert.equal(resets, kind === 'missing' ? 0 : 1)
    assert.equal(h.calls.length, 1)
  })
})

test('draft policy: reset finding a confirmed saved receipt skips fresh materials and deduplicates the target', async t => {
  const h = await fixture(t)
  h.runtime.runSocialUpload = async payload => { h.calls.push(payload); throw new Error('response lost') }
  h.runtime.closeFailedSocialUpload = async () => ({})
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
  await h.service.runPending()
  const oldPayload = structuredClone(h.calls[0]!)
  h.source.deletedAt = new Date().toISOString()
  h.options.loadSource = async () => { assert.fail('saved receipt does not need current materials') }
  h.runtime.resetSocialUploadAttempt = async payload => {
    assert.deepEqual(payload, oldPayload)
    return { result: h.result(payload, true) }
  }
  h.service.retry(jobs[0]!.id)
  await h.service.runPending()
  assert.equal(h.service.getJob(jobs[0]!.id).status, 'completed')
  assert.equal(h.service.uploads(71)['tencent-video']?.confirmation, 'platform')
  h.service.retry(jobs[0]!.id)
  await h.service.runPending()
  assert.equal(h.calls.length, 1)
})

test('draft policy: a fresh retry clears old editor identity before accepting a new saved editor', async t => {
  const h = await fixture(t)
  const old = await failedDraft(h, 'tencent-video')
  let resetPayload: SocialUploadPayload | undefined
  h.runtime.resetSocialUploadAttempt = async payload => { resetPayload = payload; return {} }
  h.runtime.runSocialUpload = async payload => {
    h.calls.push(payload)
    return { ...h.result(payload, true), targetId: 'new-editor' }
  }
  // This test starts from an explicitly staged attempt, then requests production.
  const database = new Database(h.options.databasePath)
  database.prepare("UPDATE history_social_upload_jobs SET mode='draft' WHERE id=?").run(old.id)
  database.close()
  h.service.retry(old.id)
  await h.service.runPending()
  assert.equal(resetPayload?.jobId, old.id)
  assert.equal(h.service.getJob(old.id).status, 'completed')
  assert.equal(h.service.getJob(old.id).result!.targetId, 'new-editor')
  assert.equal(h.calls.length, 2)
})

test('draft policy: invalid cleanup receipts and cleanup errors fail without preserving an automatic retry', async t => {
  for (const kind of ['unsaved', 'wrong-account', 'wrong-host', 'published', 'busy'] as const) await t.test(kind, async t => {
    const h = await fixture(t)
    h.runtime.runSocialUpload = async payload => { h.calls.push(payload); throw new Error('save failed') }
    let closes = 0
    h.runtime.closeFailedSocialUpload = async payload => {
      closes++
      if (kind === 'busy') throw new Error('account lock busy')
      const result = h.result(payload, kind !== 'unsaved')
      if (kind === 'wrong-account') result.accountName = 'unrelated'
      if (kind === 'wrong-host') result.editorUrl = 'https://example.com/editor'
      if (kind === 'published') Object.assign(result, { published: true })
      return { result }
    }
    const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
    await h.service.runPending()
    assert.equal(h.service.getJob(jobs[0]!.id).status, 'failed')
    assert.deepEqual(h.service.uploads(71), {})
    await h.service.runPending()
    assert.equal(closes, 1)
    assert.equal(h.calls.length, 1)
  })
})

test('draft policy: unfinished legacy jobs become terminal failures and only close their original pages once', async t => {
  const scenarios = [
    { status: 'running', operation: 'confirm', recovery: null, dispatched: 1 },
    { status: 'running', operation: 'retry', recovery: null, dispatched: 0 },
    { status: 'uncertain', operation: 'upload', recovery: null, dispatched: 0 },
    { status: 'blocked', operation: null, recovery: null, dispatched: 0 },
    { status: 'blocked', operation: 'resume', recovery: 'resume', dispatched: 1 },
    { status: 'queued', operation: 'recover', recovery: 'save', dispatched: 1 },
    { status: 'queued', operation: 'retry', recovery: 'retry', dispatched: 1 },
    { status: 'queued', operation: 'recover', recovery: 'prepare', dispatched: 1 },
    { status: 'queued', operation: 'recover', recovery: 'runtime-check', dispatched: 0 },
    { status: 'awaiting_confirmation', operation: 'upload', recovery: null, dispatched: 1 },
    { status: 'failed', operation: 'upload', recovery: null, dispatched: 1 },
  ]
  for (const scenario of scenarios) await t.test(JSON.stringify(scenario), async t => {
    const h = await fixture(t)
    const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
    const database = new Database(h.options.databasePath)
    database.prepare(`UPDATE history_social_upload_jobs SET status=?,operation=?,recovery_action=?,upload_dispatched=?,
      owner='dead-worker',host=NULL,pid=NULL,lease_until=1,message='old attempt',error='original failure',recovery_attempts=2,next_attempt_at=9999999999999 WHERE id=?`)
      .run(scenario.status, scenario.operation, scenario.recovery, scenario.dispatched, jobs[0]!.id)
    database.close()
    const closed: string[] = []
    h.runtime.closeFailedSocialUpload = async payload => { closed.push(payload.jobId); return {} }
    const restarted = new HistorySocialUploadService(h.options)
    try {
      assert.equal(restarted.getJob(jobs[0]!.id).status, 'failed')
      await restarted.runPending()
      assert.equal(restarted.getJob(jobs[0]!.id).status, 'failed')
      assert.match(restarted.getJob(jobs[0]!.id).message, /重新上传/)
      assert.equal(restarted.getJob(jobs[0]!.id).recovery.action, null)
      await restarted.runPending()
      assert.equal(h.calls.length, 0)
      assert.equal(closed.length, scenario.dispatched || ['running', 'uncertain', 'awaiting_confirmation'].includes(scenario.status) ? 1 : 0)
    } finally { await restarted.close() }
  })
})

test('draft policy: old prepare queues that never dispatched remain fresh work after restart', async t => {
  const h = await fixture(t)
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
  const database = new Database(h.options.databasePath)
  database.prepare(`UPDATE history_social_upload_jobs SET recovery_action='prepare',operation='recover',
    recovery_attempts=2,next_attempt_at=9999999999999 WHERE id=?`).run(jobs[0]!.id)
  database.close()
  h.source.delivery!.title = '更新后的蔬菜供应标题'
  h.runtime.resetSocialUploadAttempt = async () => { assert.fail('never dispatched') }
  const restarted = new HistorySocialUploadService(h.options)
  try {
    const queued = restarted.getJob(jobs[0]!.id)
    assert.equal(queued.status, 'queued')
    assert.equal(queued.operation, 'retry')
    assert.equal(queued.recovery.action, null)
    await restarted.runPending()
    assert.equal(restarted.getJob(jobs[0]!.id).status, 'completed')
    assert.equal(h.calls[0]!.title, h.source.delivery!.title)
    assert.equal(h.calls.length, 1)
  } finally { await restarted.close() }
})

test('draft policy: restart accepts only local confirmed saved evidence without reuploading or inspecting the platform', async t => {
  for (const proof of ['database', 'bridge', 'invalid-database'] as const) await t.test(proof, async t => {
    const h = await fixture(t)
    const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
    const database = new Database(h.options.databasePath)
    const row = database.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(jobs[0]!.id) as { payload_json: string }
    const payload = JSON.parse(row.payload_json) as SocialUploadPayload
    const result = h.result(payload, true)
    if (proof === 'invalid-database') result.accountName = 'unrelated'
    database.prepare(`UPDATE history_social_upload_jobs SET status='running',operation='confirm',upload_dispatched=1,
      owner='dead-worker',host=NULL,pid=NULL,lease_until=1,result_json=? WHERE id=?`)
      .run(proof === 'bridge' ? null : JSON.stringify(result), jobs[0]!.id)
    database.close()
    h.options.loadSource = async () => { assert.fail('no source lookup during failure cleanup') }
    h.runtime.inspectSocialUploadRuntime = async () => { assert.fail('no platform inspection during failure cleanup') }
    h.runtime.closeFailedSocialUpload = async old => {
      assert.deepEqual(old, payload)
      return proof === 'bridge' ? { result: h.result(old, true) } : {}
    }
    const restarted = new HistorySocialUploadService(h.options)
    try {
      await restarted.runPending()
      assert.equal(restarted.getJob(jobs[0]!.id).status, proof === 'invalid-database' ? 'failed' : 'completed')
      assert.equal(h.calls.length, 0)
    } finally { await restarted.close() }
  })
})

test('draft policy: transient login checks fail once, and manual reupload requires a fresh successful check', async t => {
  const h = await fixture(t)
  await enableBackground(h)
  const inspect = h.runtime.inspectHistorySocialUploadRuntime!
  let unavailable = true
  h.runtime.inspectHistorySocialUploadRuntime = async refresh => {
    assert.equal(refresh, true)
    const value = await inspect(refresh)
    if (unavailable) value.platforms.tencent = { ...value.platforms.tencent, ready: false, issue: 'connection_failed', message: 'CDP unavailable' }
    return value
  }
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video', 'baijiahao-video'] })
  assert.ok(jobs.every(job => job.status === 'queued'))
  await h.service.runPending()
  assert.equal(h.service.getJob(jobs[0]!.id).status, 'failed')
  assert.equal(h.service.getJob(jobs[1]!.id).status, 'completed')
  unavailable = false
  await h.service.runPending()
  assert.equal(h.calls.length, 1, 'no automatic retry')
  h.service.retry(jobs[0]!.id)
  await h.service.runPending()
  assert.equal(h.service.getJob(jobs[0]!.id).status, 'completed')
  assert.equal(h.calls.length, 2)
})

test('draft policy: two workers cannot reset the same retry concurrently or claim another upload while resetting', async t => {
  const h = await fixture(t)
  h.runtime.runSocialUpload = async payload => { h.calls.push(payload); throw new Error('first attempt failed') }
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
  await h.service.runPending()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let resets = 0
  h.runtime.resetSocialUploadAttempt = async () => { resets++; entered(); await gate; return {} }
  h.runtime.runSocialUpload = async (payload, options) => { h.calls.push(payload); return h.result(payload, options.saveDraft) }
  h.service.retry(jobs[0]!.id)
  const running = h.service.runPending()
  await started
  const other = new HistorySocialUploadService(h.options)
  try {
    await other.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['baijiahao-video'] })
    assert.equal(other.retry(jobs[0]!.id).status, 'running')
    await other.runPending()
    assert.equal(resets, 1)
    assert.equal(h.calls.length, 1)
    release(); await running
    assert.ok(other.listJobs().every(job => job.status === 'completed'))
    assert.equal(h.calls.length, 3)
  } finally { release(); await running; await other.close() }
})

test('draft policy: an interrupted pre-upload check cannot dispatch after the replacement marks it failed', async t => {
  const h = await fixture(t)
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
  const inspect = h.runtime.inspectSocialUploadRuntime
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  h.runtime.inspectSocialUploadRuntime = async () => { entered(); await gate; return inspect() }
  const running = h.service.runPending()
  await started
  const database = new Database(h.options.databasePath)
  database.prepare("UPDATE history_social_upload_jobs SET host=NULL,pid=NULL,lease_until=1 WHERE id=?").run(jobs[0]!.id)
  database.close()
  h.runtime.closeFailedSocialUpload = async () => ({})
  const other = new HistorySocialUploadService(h.options)
  try {
    assert.equal(other.getJob(jobs[0]!.id).status, 'failed')
    release(); await running
    await other.runPending()
    assert.equal(other.getJob(jobs[0]!.id).status, 'failed')
    assert.equal(h.calls.length, 0)
  } finally { release(); await running; await other.close() }
})

test('draft policy: migration preserves missing-payload attempt evidence so retry cannot bypass reset', async t => {
  const h = await fixture(t)
  const { jobs } = await h.service.enqueue({ mode: 'draft' as const, sourceIds: [71], targets: ['tencent-video'] })
  const database = new Database(h.options.databasePath)
  database.prepare("UPDATE history_social_upload_jobs SET status='uncertain',upload_dispatched=0,payload_json=NULL WHERE id=?").run(jobs[0]!.id)
  database.close()
  const restarted = new HistorySocialUploadService(h.options)
  try {
    await restarted.runPending()
    assert.equal(restarted.getJob(jobs[0]!.id).status, 'failed')
    assert.throws(() => restarted.retry(jobs[0]!.id), /原上传记录缺失/)
    assert.equal(h.calls.length, 0)
  } finally { await restarted.close() }
})

function publishedResult(previous: SocialUploadResult, articleId = '1880027026933416669', published = false): SocialUploadResult {
  return {...previous,saved:false,submitted:true,published,publicationStatus:published?'published':'submitted',articleId,
    publishedUrl:`https://baijiahao.baidu.com/builder/preview/s?id=${articleId}`}
}

async function submittedFixture(t: TestContext) {
  const h = await fixture(t)
  await enableBackground(h)
  h.runtime.confirmSocialUpload = async (_payload, previous) => publishedResult(previous)
  const job = (await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],mode:'publish'})).jobs[0]!
  await h.service.runPending()
  const submitted = h.service.getJob(job.id)
  assert.equal(submitted.result?.publicationStatus, 'submitted')
  h.runtime.runSocialUpload = async () => assert.fail('status refresh must never upload')
  h.runtime.confirmSocialUpload = async () => assert.fail('status refresh must never publish')
  h.runtime.inspectSocialUploadCheckpoint = async () => assert.fail('submitted refresh must not recover an upload')
  return {...h, submitted}
}

test('submitted receipt refresh reads the original article after local media is released', async t => {
  const h = await submittedFixture(t)
  const before = h.service.getJob(h.submitted.id)
  fs.rmSync(path.join(h.root, 'history-deliveries', '71'), {recursive:true})
  let reads = 0
  h.runtime.refreshSocialPublication = async (payload, previous) => {
    reads++
    assert.equal(payload.jobId, before.id)
    assert.equal(payload.fingerprint, before.fingerprint)
    assert.deepEqual(previous, before.result)
    return publishedResult(previous, previous.articleId, true)
  }
  const after = await h.service.reconcile(before.id)
  assert.equal(reads, 1)
  assert.equal(after.result?.published, true)
  assert.equal(after.status, 'completed')
  assert.equal(after.videoId, before.videoId)
  assert.equal(after.fingerprint, before.fingerprint)
  await h.service.reconcile(before.id)
  assert.equal(reads, 1, 'already public receipts are terminal')
})

test('failed or mismatched status refresh preserves the valid submitted receipt and payload', async t => {
  const h = await submittedFixture(t), before = h.service.getJob(h.submitted.id)
  let reads = 0
  for (const change of ['timeout', 'article', 'account', 'target', 'unsubmitted']) {
    h.runtime.refreshSocialPublication = async (_payload, previous) => {
      reads++
      if (change === 'timeout') throw Error('platform timeout')
      const result = publishedResult(previous, previous.articleId, true)
      if (change === 'article') return publishedResult(previous, '1880027026933416670', true)
      if (change === 'account') return {...result, accountName:'other_account'}
      if (change === 'target') return {...result, targetId:'OTHER'}
      return {...result, submitted:false}
    }
    const after = await h.service.reconcile(before.id)
    assert.equal(after.status, 'completed')
    assert.deepEqual(after.result, before.result)
    assert.equal(after.fingerprint, before.fingerprint)
    assert.equal(after.updatedAt, before.updatedAt, 'failed observations do not rewrite receipt time')
  }
  assert.equal(reads, 5)
})

test('two workers serialize moderation reads with uploads while preserving completed status', async t => {
  const h = await submittedFixture(t)
  let started!: () => void, release!: () => void
  const hasStarted = new Promise<void>(resolve => { started = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  h.runtime.refreshSocialPublication = async (_payload, previous) => {
    reads++; started(); await released
    return publishedResult(previous, previous.articleId, true)
  }
  const other = new HistorySocialUploadService(h.options)
  const first = h.service.reconcile(h.submitted.id)
  await hasStarted
  try {
    assert.equal((await other.reconcile(h.submitted.id)).result?.publicationStatus, 'submitted')
    assert.equal(reads, 1)
    const sql = new Database(h.options.databasePath)
    const row = sql.prepare('SELECT * FROM history_social_upload_jobs WHERE id=?').get(h.submitted.id) as Record<string, any>
    const copy = {...row,id:Number(row.id)+1,fingerprint:'queued-next',status:'queued',result_json:null,upload_dispatched:0}
    const fields = Object.keys(copy)
    sql.prepare(`INSERT INTO history_social_upload_jobs (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...Object.values(copy))
    sql.close()
    await other.runPending()
    assert.equal(other.getJob(copy.id).status, 'queued', 'upload dispatch waits for the account read lock')
    assert.equal(h.service.getJob(h.submitted.id).status, 'completed')
  } finally { release(); await first; await other.close() }
})

test('single-task moderation construction can opt out of unrelated startup recovery', async t => {
  const h = await submittedFixture(t)
  const sql = new Database(h.options.databasePath)
  sql.prepare("UPDATE history_social_upload_jobs SET status='failed',operation='publish',error='interrupted' WHERE id=?").run(h.submitted.id)
  const before = sql.prepare('SELECT * FROM history_social_upload_jobs WHERE id=?').get(h.submitted.id)
  const isolated = new HistorySocialUploadService({...h.options,recoverOnStartup:false})
  try {
    assert.deepEqual(sql.prepare('SELECT * FROM history_social_upload_jobs WHERE id=?').get(h.submitted.id),before)
  } finally { await isolated.close() }
  const ordinary = new HistorySocialUploadService(h.options)
  try { assert.equal(ordinary.getJob(h.submitted.id).status,'completed', 'ordinary startup recovery is unchanged') }
  finally { await ordinary.close(); sql.close() }
})

test('automatic publication checks are bounded, persist backoff, and never consume uncertain jobs', async t => {
  const h = await submittedFixture(t)
  let now = Date.now() + 10 * 60_000, reads = 0
  ;(h.options as HistorySocialUploadOptions).now = () => now
  h.runtime.refreshSocialPublication = async () => { reads++; throw Error('read timeout') }
  const sql = new Database(h.options.databasePath)
  t.after(() => sql.close())
  const row = sql.prepare('SELECT * FROM history_social_upload_jobs WHERE id=?').get(h.submitted.id) as Record<string, any>
  for (let i = 0; i < 4; i++) {
    const copy: Record<string, any> = {...row, id:Number(row.id)+i+1, fingerprint:`copy-${i}`}
    copy.payload_json = JSON.stringify({...JSON.parse(row.payload_json),jobId:String(copy.id),fingerprint:copy.fingerprint})
    const fields = Object.keys(copy)
    sql.prepare(`INSERT INTO history_social_upload_jobs (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...Object.values(copy))
  }
  sql.prepare("UPDATE history_social_upload_jobs SET status='uncertain' WHERE id=?").run(Number(row.id)+4)
  await h.service.runPublicationChecks()
  assert.equal(reads, 2)
  await h.service.runPublicationChecks()
  assert.equal(reads, 2, 'one bounded batch per minute')
  now += 60_001
  await h.service.runPublicationChecks()
  assert.equal(reads, 4)
  const restarted = new HistorySocialUploadService(h.options)
  try {
    await restarted.runPublicationChecks()
    assert.equal(reads, 4, 'restart respects durable per-job backoff')
    now += 10 * 60_000
    await restarted.runPublicationChecks()
    assert.equal(reads, 6)
  } finally { await restarted.close() }
  assert.equal(h.service.getJob(h.submitted.id).result?.publicationStatus, 'submitted')
})

test('publication checks reserve one fresh submission and one oldest due slot', async t => {
  const h = await submittedFixture(t)
  let now = Date.now() + 10 * 60_000
  ;(h.options as HistorySocialUploadOptions).now = () => now
  const reads: number[] = []
  h.runtime.refreshSocialPublication = async (payload, previous) => { reads.push(Number(payload.jobId)); return previous }
  const sql = new Database(h.options.databasePath)
  t.after(() => sql.close())
  const row = sql.prepare('SELECT * FROM history_social_upload_jobs WHERE id=?').get(h.submitted.id) as Record<string, any>
  const base = Number(row.id)
  for (let index=0;index<4;index++) {
    const id=base+index
    if (index) {
      const copy: Record<string, any> = {...row,id,fingerprint:`priority-${index}`}
      copy.payload_json=JSON.stringify({...JSON.parse(row.payload_json),jobId:String(id),fingerprint:copy.fingerprint})
      const fields=Object.keys(copy)
      sql.prepare(`INSERT INTO history_social_upload_jobs (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...Object.values(copy))
    }
    sql.prepare('UPDATE history_social_upload_jobs SET updated_at=? WHERE id=?').run(new Date(now-(4-index)*3600000).toISOString(),id)
    sql.prepare('INSERT OR REPLACE INTO history_social_publication_checks(job_id,next_check_at) VALUES(?,?)').run(id,now-(4-index)*60000)
  }
  await h.service.runPublicationChecks()
  assert.deepEqual(reads,[base+3,base], 'fresh work advances while the oldest backlog also advances')
  now+=60001
  await h.service.runPublicationChecks()
  assert.deepEqual(reads,[base+3,base,base+2,base+1])
  assert.equal(h.calls.length,1,'only the original fixture upload ran')
})
function addVideo(h: Awaited<ReturnType<typeof fixture>>, producer: 'huasheng' | 'motion') {
  const filename = path.join(h.root,'history-deliveries','71',`${producer}.mp4`)
  fs.writeFileSync(filename,`finished ${producer} content`)
  const sql=new Database(h.options.databasePath)
  try {
    const video = recordHistoryVideoDelivery(sql,{scriptId:71,scriptSha256:hash(h.source.rewrittenScript!),producer,
    producerJobId:`${producer}-1`,videoUrl:`/static/history-deliveries/71/${producer}.mp4`,videoName:`${producer}.mp4`,
    duration:42,sha256:hash(`finished ${producer} content`)})
    ensureHistoryVideoPackagingSchema(sql)
    const delivery = h.source.delivery!
    sql.prepare(`INSERT INTO history_video_packaging
      (video_id,script_id,title,baijiahao_title,description,video_path,video_name,duration,script_sha256,
      cover_script_sha256,covers_json,cover_status,design_status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(video.id,71,delivery.title,delivery.baijiahaoTitle,delivery.description,video.videoUrl,video.videoName,video.duration,
        video.scriptSha256,delivery.coverScriptSha256,JSON.stringify(delivery.covers),'completed','completed',new Date().toISOString())
    return video
  } finally {sql.close()}
}

function rebuildVideo(h: Awaited<ReturnType<typeof fixture>>, original: ReturnType<typeof addVideo>) {
  const sql = new Database(h.options.databasePath)
  try {
    const videoUrl = `/static/history-deliveries/71/${original.producer}-rebuilt.mp4`
    fs.writeFileSync(path.join(h.root, videoUrl.replace('/static/', '')), 'rebuilt video content')
    const video = recordHistoryVideoDelivery(sql, { ...original, videoUrl, producerJobId: 'rebuilt-job', sha256: hash('rebuilt video content') })
    const saved = sql.prepare('SELECT * FROM history_video_packaging WHERE video_id=?').get(original.id) as Record<string, any>
    const row = { ...saved, video_id: video.id, video_path: videoUrl }
    const fields = Object.keys(row)
    sql.prepare(`INSERT INTO history_video_packaging (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(row))
    return video
  } finally { sql.close() }
}

test('a ready revision requires an explicit submission after its original receipt and automatic requests cannot enqueue it', async t => {
  const h = await fixture(t), original = addVideo(h, 'motion')
  h.runtime.confirmSocialUpload = async (_payload, previous) => publishedResult(previous)
  const originalJob = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [original.id] })).jobs[0]!
  await h.service.runPending()
  const revision = rebuildVideo(h, original)
  await assert.rejects(h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [revision.id] }, { automatic: true }), /修订|再次发表/)
  assert.equal(h.service.listJobs().length, 1)
  const preview = await h.service.preflight({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [revision.id] })
  assert.equal(preview.items[0]!.ready, true)
  assert.ok(preview.items[0]!.warnings?.some(warning => /再次发表/.test(warning)))
  const submitted = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [revision.id] })
  assert.notEqual(submitted.jobs[0]!.id, originalJob.id)
  await h.service.runPending()
  assert.equal(h.calls.length, 2)
  assert.equal(h.service.getJob(originalJob.id).result?.submitted, true)
})

test('an unresolved original edition blocks explicit and automatic submission of a different render', async t => {
  const h = await fixture(t), original = addVideo(h, 'motion')
  h.runtime.confirmSocialUpload = async () => { throw Error('原发表回执未确认') }
  const originalJob = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [original.id] })).jobs[0]!
  await h.service.runPending()
  assert.equal(h.service.getJob(originalJob.id).status, 'uncertain')
  const revision = rebuildVideo(h, original)
  const preview = await h.service.preflight({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [revision.id] })
  assert.equal(preview.items[0]!.ready, false)
  assert.ok(preview.items[0]!.blockers.some(blocker => blocker.code === 'original_publication_unresolved'))
  await assert.rejects(h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [revision.id] }), /原成片|原任务/)
  assert.equal(h.service.listJobs().length, 1)
  assert.equal(h.calls.length, 1)
})

test('automatic enqueue rechecks the original receipt after asynchronous preflight', async t => {
  const h = await fixture(t), original = addVideo(h, 'motion')
  const originalJob = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [original.id] })).jobs[0]!
  h.service.cancel(originalJob.id)
  const revision = rebuildVideo(h, original), sql = new Database(h.options.databasePath)
  const service = h.service as any
  const prepare = service.prepareInput.bind(service)
  t.mock.method(service, 'prepareInput', async (...args: unknown[]) => {
    const result = await prepare(...args)
    sql.prepare("UPDATE history_social_upload_jobs SET status='completed',result_json=? WHERE id=?")
      .run(JSON.stringify(publishedResult(h.result({ jobId: originalJob.id } as SocialUploadPayload))), originalJob.id)
    return result
  })
  try {
    await assert.rejects(h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [revision.id] }, { automatic: true }), /修订|再次发表/)
    assert.equal(h.service.listJobs().length, 1)
    assert.equal(h.calls.length, 0)
  } finally { sql.close() }
})

test('automatic enqueue cannot reactivate a failed revision after its original edition was submitted', async t => {
  const h = await fixture(t), original = addVideo(h, 'motion')
  h.runtime.confirmSocialUpload = async (_payload, previous) => publishedResult(previous)
  await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [original.id] })
  await h.service.runPending()
  const revision = rebuildVideo(h, original)
  h.source.artifactState = 'stale'
  const failed = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [revision.id] })).jobs[0]!
  assert.equal(failed.status, 'failed')
  h.source.artifactState = 'current'
  await assert.rejects(h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [revision.id] }, { automatic: true }), /修订|再次发表/)
  assert.equal(h.service.getJob(failed.id).status, 'failed')
  const explicit = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [revision.id] })
  assert.equal(explicit.jobs[0]!.id, failed.id)
  assert.equal(explicit.jobs[0]!.status, 'queued')
})

for (const status of ['completed', 'uncertain']) {
  test(`a same-file legacy ${status} publication is reused by exact-video submissions even with an old fingerprint`, async t => {
    const h = await fixture(t), video = addVideo(h, 'motion')
    h.runtime.confirmSocialUpload = async (_payload, previous) => publishedResult(previous)
    const input = { sourceIds: [71], targets: ['baijiahao-video'] as SocialTarget[], videoIds: [video.id] }
    const original = (await h.service.enqueue(input)).jobs[0]!
    await h.service.runPending()
    const sql = new Database(h.options.databasePath)
    try {
      sql.prepare("UPDATE history_social_upload_jobs SET status=?,video_id=NULL,video_producer='legacy',fingerprint='pre-video-id-fingerprint' WHERE id=?")
        .run(status, original.id)
      const preview = await h.service.preflight(input)
      assert.equal(preview.items[0]!.ready, false)
      if (status === 'completed') assert.equal(preview.items[0]!.uploaded?.status, 'submitted')
      const receipt = await h.service.enqueue(input)
      assert.equal(receipt.jobs[0]!.id, original.id)
      assert.equal(receipt.jobs[0]!.reused, true)
      await h.service.runPending()
      assert.equal(h.calls.length, 1)
      assert.equal(h.service.listJobs().length, 1)
      assert.equal(h.service.getJob(original.id).videoId, null)
    } finally { sql.close() }
  })
}

test('each selected video uploads its own title and covers rather than the shared source package', async t => {
  const h = await fixture(t), huasheng = addVideo(h, 'huasheng'), motion = addVideo(h, 'motion')
  const directory = path.join(h.root, 'history-deliveries', '71')
  const sql = new Database(h.options.databasePath)
  try {
    for (const [video, title, color] of [[huasheng, '花生版独立发布标题', '#dd3344'], [motion, '精细化版独立发布标题', '#4477cc']] as const) {
      const covers: Record<string, string> = {}
      for (const [ratio, width, height] of [['16:9', 32, 18], ['3:4', 24, 32]] as const) {
        const name = `${video.producer}-${ratio.replace(':', 'x')}.png`
        await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(path.join(directory, name))
        covers[ratio] = `/static/history-deliveries/71/${name}`
      }
      sql.prepare('UPDATE history_video_packaging SET title=?,baijiahao_title=?,covers_json=? WHERE video_id=?')
        .run(title, title, JSON.stringify(covers), video.id)
    }
  } finally { sql.close() }
  const receipt = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'draft', videoIds: [huasheng.id, motion.id] })
  assert.ok(receipt.items.every(item => item.ready))
  await h.service.runPending()
  const uploads = new Map(h.calls.map(payload => [path.basename(payload.videoPath!), payload]))
  assert.equal(uploads.get('huasheng.mp4')!.title, '花生版独立发布标题')
  assert.equal(uploads.get('motion.mp4')!.title, '精细化版独立发布标题')
  assert.equal(path.basename(uploads.get('huasheng.mp4')!.landscapePath!), 'huasheng-16x9.png')
  assert.equal(path.basename(uploads.get('motion.mp4')!.landscapePath!), 'motion-16x9.png')
})

test('a selected video stage confirms against its own package and preserves its original target', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  const queued = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], mode: 'stage', videoIds: [video.id] })).jobs[0]!
  await h.service.runPending()
  const staged = h.service.getJob(queued.id)
  assert.equal(staged.status, 'awaiting_confirmation')
  let saves = 0
  h.runtime.confirmSocialUpload = async (payload, previous) => {
    saves++
    assert.equal(path.basename(payload.videoPath!), 'motion.mp4')
    assert.equal(previous.targetId, staged.result!.targetId)
    return { ...previous, saved: true }
  }
  h.source.delivery!.baijiahaoTitle = '共享包装的变更不应影响本版草稿'
  assert.equal((await h.service.confirm(queued.id)).status, 'completed')
  assert.equal((await h.service.confirm(queued.id)).status, 'completed')
  assert.equal(h.calls.length, 1)
  assert.equal(saves, 1)
})

test('a selected video cannot borrow shared packaging when its own package is missing or unfinished', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  const sql = new Database(h.options.databasePath)
  try { sql.prepare('DELETE FROM history_video_packaging WHERE video_id=?').run(video.id) } finally { sql.close() }
  const missing = await h.service.preflight({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })
  assert.equal(missing.items[0]!.ready, false)
  assert.ok(missing.items[0]!.blockers.some(issue => issue.code === 'video_packaging_missing'))
  assert.equal(h.calls.length, 0)
  const restore = new Database(h.options.databasePath)
  try {
    restore.prepare(`INSERT INTO history_video_packaging
      (video_id,script_id,title,baijiahao_title,script_sha256,cover_script_sha256,covers_json,cover_status,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(video.id,71,'精细化发布标题','精细化发布标题',video.scriptSha256,video.scriptSha256,
        JSON.stringify(h.source.delivery!.covers),'idle',new Date().toISOString())
  } finally { restore.close() }
  const unfinished = await h.service.preflight({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })
  assert.equal(unfinished.items[0]!.ready, false)
  assert.ok(unfinished.items[0]!.blockers.some(issue => issue.code === 'covers_stale'))
})

test('a selected video rejects packaging stored for a different manuscript', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  const sql = new Database(h.options.databasePath)
  try { sql.prepare('UPDATE history_video_packaging SET script_sha256=? WHERE video_id=?').run(hash('旧版本正文'), video.id) }
  finally { sql.close() }
  const report = await h.service.preflight({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })
  assert.equal(report.items[0]!.ready, false)
  assert.ok(report.items[0]!.blockers.some(issue => issue.code === 'video_packaging_stale'))
  assert.equal(h.calls.length, 0)
})

test('an undispatched legacy publication waits for its own new package and refreshes its snapshot before uploading once', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  h.runtime.confirmSocialUpload = async (_payload, previous) => publishedResult(previous)
  const queued = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })).jobs[0]!
  const sql = new Database(h.options.databasePath)
  try {
    const original = sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(queued.id) as { payload_json: string }
    const packaging = sql.prepare('SELECT * FROM history_video_packaging WHERE video_id=?').get(video.id) as Record<string, unknown>
    sql.prepare('DELETE FROM history_video_packaging WHERE video_id=?').run(video.id)
    const requests: Array<{ sourceId: number; videoId?: number; expectedScriptSha256: string }> = []
    ;(h.options as HistorySocialUploadOptions).ensurePackaging = async (sourceId, options) => {
      requests.push({ sourceId, videoId: options.videoId, expectedScriptSha256: options.expectedScriptSha256 })
      return { design: { status: 'generating', message: '正在生成本版标题' }, covers: { status: 'queued', message: '等待方案' } }
    }
    await h.service.runPending()
    assert.equal(h.service.getJob(queued.id).status, 'queued')
    assert.equal(h.service.getJob(queued.id).operation, 'packaging')
    assert.deepEqual(requests, [{ sourceId: 71, videoId: video.id, expectedScriptSha256: video.scriptSha256 }])
    assert.equal((sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(queued.id) as { payload_json: string }).payload_json,
      original.payload_json, 'waiting must retain the original undispatched payload')
    assert.equal(h.calls.length, 0)
    await h.service.runPending()
    assert.equal(requests.length, 1, 'waiting work must respect its persisted polling delay')
    const fields = Object.keys(packaging)
    sql.prepare(`INSERT INTO history_video_packaging (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
      .run(...fields.map(field => field === 'title' || field === 'baijiahao_title' ? '精细化版新标题与独立封面' : packaging[field]))
    sql.prepare('UPDATE history_social_upload_jobs SET next_attempt_at=0 WHERE id=?').run(queued.id)
    await h.service.runPending()
    assert.equal(h.service.getJob(queued.id).status, 'completed')
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0]!.title, '精细化版新标题与独立封面')
    assert.notEqual(h.calls[0]!.fingerprint, JSON.parse(original.payload_json).fingerprint)
    await h.service.runPending()
    assert.equal(h.calls.length, 1)
  } finally { sql.close() }
})

test('a publication waiting for packaging does not block another ready video', async t => {
  const h = await fixture(t), waiting = addVideo(h, 'motion'), ready = addVideo(h, 'huasheng')
  h.runtime.confirmSocialUpload = async (_payload, previous) => publishedResult(previous)
  const receipt = await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [waiting.id, ready.id] })
  const sql = new Database(h.options.databasePath)
  try { sql.prepare('DELETE FROM history_video_packaging WHERE video_id=?').run(waiting.id) } finally { sql.close() }
  ;(h.options as HistorySocialUploadOptions).ensurePackaging = async () => ({
    design: { status: 'queued', message: '等待本版方案' }, covers: { status: 'queued', message: '等待本版封面' },
  })
  await h.service.runPending()
  assert.equal(h.service.getJob(receipt.jobs.find(job => job.videoId === waiting.id)!.id).status, 'queued')
  assert.equal(h.service.getJob(receipt.jobs.find(job => job.videoId === ready.id)!.id).status, 'completed')
  assert.deepEqual(h.calls.map(payload => path.basename(payload.videoPath!)), ['huasheng.mp4'])
})

test('an interrupted packaging wait resumes locally before uploading its completed package once', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  h.runtime.confirmSocialUpload = async (_payload, previous) => publishedResult(previous)
  h.runtime.inspectSocialUploadCheckpoint = async () => assert.fail('an undispatched packaging wait has no platform checkpoint')
  const queued = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })).jobs[0]!
  const sql = new Database(h.options.databasePath)
  try {
    const original = sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(queued.id) as { payload_json: string }
    const packaging = sql.prepare('SELECT * FROM history_video_packaging WHERE video_id=?').get(video.id) as Record<string, unknown>
    sql.prepare('DELETE FROM history_video_packaging WHERE video_id=?').run(video.id)
    ;(h.options as HistorySocialUploadOptions).ensurePackaging = async () => ({
      design: { status: 'generating', message: '本版标题生成中' }, covers: { status: 'queued', message: '等待本版标题' },
    })
    await h.service.runPending()
    assert.equal(h.service.getJob(queued.id).operation, 'packaging')
    sql.prepare(`UPDATE history_social_upload_jobs SET status='running',host='dead-host',pid=1,lease_until=1
      WHERE id=?`).run(queued.id)
    const restarted = new HistorySocialUploadService(h.options)
    try {
      assert.equal(restarted.getJob(queued.id).status, 'queued')
      assert.equal(restarted.getJob(queued.id).operation, 'packaging')
      assert.equal((sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(queued.id) as { payload_json: string }).payload_json,
        original.payload_json)
      sql.prepare('UPDATE history_social_upload_jobs SET next_attempt_at=0 WHERE id=?').run(queued.id)
      await restarted.runPending()
      assert.equal(restarted.getJob(queued.id).status, 'queued')
      assert.equal(restarted.getJob(queued.id).operation, 'packaging')
      assert.equal(h.calls.length, 0)
      const fields = Object.keys(packaging)
      sql.prepare(`INSERT INTO history_video_packaging (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
        .run(...fields.map(field => field === 'title' || field === 'baijiahao_title' ? '重启后本版独立发布标题' : packaging[field]))
      sql.prepare('UPDATE history_social_upload_jobs SET next_attempt_at=0 WHERE id=?').run(queued.id)
      await restarted.runPending()
      assert.equal(restarted.getJob(queued.id).status, 'completed')
      assert.equal(h.calls.length, 1)
      assert.equal(h.calls[0]!.title, '重启后本版独立发布标题')
      await restarted.runPending()
      assert.equal(h.calls.length, 1)
    } finally { await restarted.close() }
  } finally { sql.close() }
})

test('new omitted mode publishes each ready video independently and ignores legacy saved/manual markers', async t => {
  const h=await fixture(t)
  await h.service.markUploaded({sourceIds:[71],targets:['baijiahao-video']})
  const published: string[]=[]
  h.runtime.confirmSocialUpload=async(payload,previous)=>{
    assert.equal(payload.publicationMode,'publish')
    assert.deepEqual(payload.tags,['#热爆趣创赛'])
    assert.equal(payload.description,payload.title)
    published.push(payload.videoPath!)
    return publishedResult(previous,`18800270269334166${published.length}9`)
  }
  h.runtime.runSocialUpload=async(payload,options)=>{
    assert.equal(options.saveDraft,false,'publication never saves drafts')
    h.calls.push(payload);return h.result(payload)
  }
  const first=addVideo(h,'huasheng')
  assert.equal(historySocialUploadInputSchema.parse({sourceIds:[71],targets:['baijiahao-video']}).mode,'publish')
  const receipt=await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[first.id],requestId:'first-ready'})
  assert.equal(receipt.jobs[0]!.videoId,first.id)
  await h.service.runPending()
  assert.equal(h.service.getJob(receipt.jobs[0]!.id).status,'completed','first video does not wait for the second')
  assert.equal(h.service.getJob(receipt.jobs[0]!.id).result?.publicationStatus,'submitted')
  const second=addVideo(h,'motion')
  h.source.delivery!.videoUrl=second.videoUrl
  const both=await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video']})
  assert.equal(both.jobs.length,2)
  assert.ok(both.jobs.some(job=>job.id===receipt.jobs[0]!.id&&job.reused))
  await h.service.runPending()
  assert.deepEqual(published.map(file=>path.basename(file)),['huasheng.mp4','motion.mp4'])
  assert.equal(new Set(h.calls.map(call=>call.fingerprint)).size,2)
  h.source.delivery!.baijiahaoTitle='修改包装后仍不能重复发表同一成片'
  const repeated=await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[first.id]})
  assert.equal(repeated.jobs[0]!.id,receipt.jobs[0]!.id)
  await h.service.runPending()
  assert.equal(published.length,2)
  assert.equal(h.service.uploads(71)['baijiahao-video']?.status,'submitted')
})

test('publication timeout retains original payload and retries only read-only reconciliation', async t => {
  const h=await fixture(t);const version=addVideo(h,'motion')
  let confirms=0,reconciles=0
  h.runtime.confirmSocialUpload=async()=>{confirms++;throw new Error('publication response lost')}
  h.runtime.closeFailedSocialUpload=async()=>{assert.fail('must preserve uncertain publication');return {}}
  h.runtime.resetSocialUploadAttempt=async()=>{assert.fail('must never reset publication');return {}}
  const receipt=await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[version.id]})
  await h.service.runPending()
  const id=receipt.jobs[0]!.id,uncertain=h.service.getJob(id)
  assert.equal(uncertain.status,'uncertain')
  const original=h.calls[0]!
  h.runtime.inspectSocialUploadCheckpoint=async payload=>{
    assert.deepEqual(payload,original)
    return {action:'reconcile',phase:'publish_requested',message:'check original',result:uncertain.result!}
  }
  h.runtime.reconcileSocialUpload=async(payload,result)=>{
    reconciles++;assert.deepEqual(payload,original);return publishedResult(result)
  }
  h.source.delivery!.baijiahaoTitle='new metadata must not replace uncertain task'
  ;(h.options as HistorySocialUploadOptions).ensurePackaging = async () => assert.fail('an uncertain publication must not create new packaging')
  const sql = new Database(h.options.databasePath)
  try { sql.prepare('DELETE FROM history_video_packaging WHERE video_id=?').run(version.id) } finally { sql.close() }
  h.service.retry(id)
  await h.service.runPending({sourceIds:[71],videoIds:[version.id],jobIds:[id]})
  assert.equal(h.service.getJob(id).status,'completed')
  assert.equal(reconciles,1)
  assert.equal(confirms,1)
  assert.equal(h.calls.length,1)
  assert.equal((await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[version.id]})).jobs[0]!.id,id)
})

test('queued publication recovery cannot be canceled to bypass the original submission', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  const input = { sourceIds: [71], targets: ['baijiahao-video'] as SocialTarget[], videoIds: [video.id] }
  let confirms = 0
  h.runtime.confirmSocialUpload = async () => { confirms++; throw Error('发表结果未知') }
  const original = (await h.service.enqueue(input)).jobs[0]!
  await h.service.runPending()
  const staged = h.service.getJob(original.id).result!, payload = h.calls[0]!
  assert.equal(h.service.retry(original.id).operation, 'recover')
  assert.throws(() => h.service.cancel(original.id), /只能取消/)
  assert.equal(h.service.getJob(original.id).status, 'queued')
  assert.equal((await h.service.enqueue(input)).jobs[0]!.id, original.id)
  h.runtime.inspectSocialUploadCheckpoint = async old => {
    assert.deepEqual(old, payload)
    return { action: 'reconcile', phase: 'publish_requested', message: '只读核对原发表', result: staged }
  }
  h.runtime.reconcileSocialUpload = async () => publishedResult(staged)
  await h.service.runPending()
  assert.equal(h.service.getJob(original.id).status, 'completed')
  assert.equal(h.calls.length, 1)
  assert.equal(confirms, 1)
  assert.equal(h.service.listJobs().length, 1)
})

test('legacy canceled publication attempts remain deduplicated even when current packaging changes', async t => {
  for (const evidence of ['dispatched', 'result', 'recover'] as const) await t.test(evidence, async t => {
    const h = await fixture(t), video = addVideo(h, 'motion')
    const input = { sourceIds: [71], targets: ['baijiahao-video'] as SocialTarget[], videoIds: [video.id] }
    const original = (await h.service.enqueue(input)).jobs[0]!
    const sql = new Database(h.options.databasePath)
    const payload = (sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(original.id) as { payload_json: string }).payload_json
    const result = evidence === 'result' ? JSON.stringify(h.result(JSON.parse(payload))) : null
    sql.prepare("UPDATE history_social_upload_jobs SET status='canceled',upload_dispatched=?,result_json=?,operation=? WHERE id=?")
      .run(evidence === 'dispatched' ? 1 : 0, result, evidence === 'recover' ? 'recover' : null, original.id)
    h.source.delivery!.baijiahaoTitle = '新标题不能抹去已经派发的原发表尝试'
    try {
      const retryInput = { ...input, requestId: `canceled-${evidence}` }
      const retried = (await h.service.enqueue(retryInput)).jobs[0]!
      assert.equal(retried.id, original.id)
      assert.equal(retried.reused, true)
      assert.equal((await h.service.enqueue(retryInput)).jobs[0]!.id, original.id)
      await h.service.runPending()
      assert.equal(h.calls.length, 0)
      assert.equal(h.service.listJobs().length, 1)
      assert.deepEqual(sql.prepare('SELECT payload_json,result_json FROM history_social_upload_jobs WHERE id=?').get(original.id),
        { payload_json: payload, result_json: result })
    } finally { sql.close() }
  })
})

test('a publication canceled before any attempt can still be queued again and submitted once', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  const input = { sourceIds: [71], targets: ['baijiahao-video'] as SocialTarget[], videoIds: [video.id] }
  const original = (await h.service.enqueue(input)).jobs[0]!
  assert.equal(h.service.cancel(original.id).status, 'canceled')
  assert.throws(()=>h.service.retry(original.id),/只有失败/)
  const replacement = (await h.service.enqueue(input)).jobs[0]!
  assert.notEqual(replacement.id, original.id)
  h.runtime.confirmSocialUpload = async (_payload, result) => publishedResult(result)
  await h.service.runPending()
  assert.equal(h.service.getJob(replacement.id).status, 'completed')
  assert.equal(h.service.getJob(original.id).status, 'canceled')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0]!.jobId, replacement.id)
})

test('legacy canceled publication attempts recover only their original checkpoint',async t=>{
  for(const evidence of ['dispatched','result','recover'] as const)await t.test(evidence,async t=>{
    const h=await fixture(t),video=addVideo(h,'motion')
    const original=(await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[video.id]})).jobs[0]!
    const sql=new Database(h.options.databasePath)
    try {
      const payloadJson=(sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(original.id) as {payload_json:string}).payload_json
      const payload=JSON.parse(payloadJson),staged=h.result(payload)
      sql.prepare("UPDATE history_social_upload_jobs SET status='canceled',upload_dispatched=?,result_json=?,operation=? WHERE id=?")
        .run(evidence==='dispatched'?1:0,evidence==='result'?JSON.stringify(staged):null,evidence==='recover'?'recover':null,original.id)
      h.runtime.runSocialUpload=async()=>assert.fail('a canceled original attempt cannot upload again')
      h.runtime.confirmSocialUpload=async()=>assert.fail('the original publication cannot be posted again')
      h.runtime.resetSocialUploadAttempt=async()=>assert.fail('the original checkpoint must be retained')
      let reconciles=0
      h.runtime.inspectSocialUploadCheckpoint=async old=>{assert.deepEqual(old,payload);return {action:'reconcile',phase:'publish_requested',message:'核对原提交',result:staged}}
      h.runtime.reconcileSocialUpload=async old=>{assert.deepEqual(old,payload);reconciles++;return publishedResult(staged)}
      h.source.delivery!.baijiahaoTitle='修改标题不能替换原提交'
      assert.equal(h.service.getJob(original.id).publicationAttempted,true)
      assert.equal(h.service.retry(original.id).operation,'recover')
      assert.equal(h.service.retry(original.id).id,original.id)
      await h.service.runPending()
      assert.equal(h.service.getJob(original.id).status,'completed')
      assert.equal(reconciles,1)
      assert.equal(h.service.listJobs().length,1)
      assert.equal((sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(original.id) as {payload_json:string}).payload_json,payloadJson)
    }finally{sql.close()}
  })
})

for(const status of ['canceled','completed'])test(`${status} legacy publication with no valid receipt supports explicit read-only reconciliation`,async t=>{
  const h=await fixture(t),video=addVideo(h,'motion')
  const original=(await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[video.id]})).jobs[0]!
  const sql=new Database(h.options.databasePath)
  try {
    const payload=JSON.parse((sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(original.id) as {payload_json:string}).payload_json)
    const staged=h.result(payload)
    sql.prepare('UPDATE history_social_upload_jobs SET status=?,upload_dispatched=1,result_json=? WHERE id=?').run(status,JSON.stringify(staged),original.id)
    h.runtime.runSocialUpload=async()=>assert.fail('read-only reconciliation cannot upload')
    h.runtime.confirmSocialUpload=async()=>assert.fail('read-only reconciliation cannot publish')
    let reconciles=0
    h.runtime.inspectSocialUploadCheckpoint=async old=>{assert.deepEqual(old,payload);return {action:'reconcile',phase:'publish_requested',message:'原提交待核对',result:staged}}
    h.runtime.reconcileSocialUpload=async()=>{reconciles++;return publishedResult(staged)}
    const done=await h.service.reconcile(original.id)
    assert.equal(done.status,'completed')
    assert.equal(done.result!.submitted,true)
    assert.equal(reconciles,1)
    assert.equal(h.service.retry(original.id).status,'completed')
    assert.equal(reconciles,1,'valid receipts remain idempotent')
  }finally{sql.close()}
})

test('completed legacy publication without a valid receipt retries only the original checkpoint',async t=>{
  const h=await fixture(t),video=addVideo(h,'motion')
  const original=(await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[video.id]})).jobs[0]!
  const sql=new Database(h.options.databasePath)
  try {
    const payload=JSON.parse((sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(original.id) as {payload_json:string}).payload_json)
    const staged=h.result(payload)
    sql.prepare("UPDATE history_social_upload_jobs SET status='completed',upload_dispatched=0,result_json=? WHERE id=?")
      .run(JSON.stringify({submitted:true,saved:false}),original.id)
    h.runtime.runSocialUpload=async()=>assert.fail('invalid receipts cannot authorize another upload')
    h.runtime.confirmSocialUpload=async()=>assert.fail('invalid receipts cannot authorize another submission')
    h.runtime.inspectSocialUploadCheckpoint=async()=>({action:'complete',phase:'submitted',message:'已核对原回执',result:publishedResult(staged)})
    assert.equal(h.service.retry(original.id).operation,'recover')
    await h.service.runPending()
    assert.equal(h.service.getJob(original.id).result!.submitted,true)
    sql.prepare("UPDATE history_social_upload_jobs SET status='completed',payload_json=NULL,result_json=NULL WHERE id=?").run(original.id)
    assert.throws(()=>h.service.retry(original.id),/原上传记录缺失/)
    assert.equal(h.service.listJobs().length,1)
  }finally{sql.close()}
})

test('publication restart keeps unknown submissions and recovers an interrupted original upload once', async t => {
  const h=await fixture(t);const video=addVideo(h,'huasheng')
  const receipt=await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[video.id]})
  const id=receipt.jobs[0]!.id,sql=new Database(h.options.databasePath)
  const row=sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(id) as {payload_json:string}
  const original=JSON.parse(row.payload_json) as SocialUploadPayload
  delete original.tags // Simulate a dispatched checkpoint from before topic support.
  const staged=h.result(original)
  sql.prepare("UPDATE history_social_upload_jobs SET status='running',operation='publish',upload_dispatched=1,payload_json=?,result_json=?,host='dead-host',pid=1,lease_until=1 WHERE id=?").run(JSON.stringify(original),JSON.stringify(staged),id)
  sql.close()
  h.runtime.inspectSocialUploadCheckpoint=async payload=>{assert.deepEqual(payload,original);return {action:'reconcile',phase:'publish_requested',message:'read only',result:staged}}
  h.runtime.reconcileSocialUpload=async payload=>{assert.deepEqual(payload,original);return publishedResult(staged)}
  h.runtime.runSocialUpload=async()=>{assert.fail('no new upload')}
  h.runtime.confirmSocialUpload=async()=>{assert.fail('no second publish')}
  const restarted=new HistorySocialUploadService(h.options)
  try {await restarted.runPending();assert.equal(restarted.getJob(id).status,'completed')}
  finally {await restarted.close()}
})

test('a publication blocked before any POST continues its original editor without reuploading', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  let confirms = 0
  h.runtime.confirmSocialUpload = async () => { confirms++; throw Error('请选择创作声明类型') }
  const input = { sourceIds: [71], targets: ['baijiahao-video'] as SocialTarget[], videoIds: [video.id] }
  const original = (await h.service.enqueue(input)).jobs[0]!
  await h.service.runPending()
  const staged = h.service.getJob(original.id).result!, payload = h.calls[0]!
  h.runtime.inspectSocialUploadCheckpoint = async old => {
    assert.deepEqual(old, payload)
    // The bridge alone proves the required-field rejection and zero POSTs.
    return { action: 'save', phase: 'publish_requested', message: '原页补齐声明，尚无发表 POST', result: staged }
  }
  h.runtime.runSocialUpload = async () => assert.fail('the staged video must not be uploaded again')
  h.runtime.resetSocialUploadAttempt = async () => assert.fail('the original editor must not be reset')
  h.runtime.confirmSocialUpload = async (old, result) => {
    confirms++
    assert.deepEqual(old, payload)
    assert.equal(result.targetId, staged.targetId)
    return publishedResult(result)
  }
  h.source.delivery!.baijiahaoTitle = '包装变动不能替换原编辑页'
  assert.equal((await h.service.enqueue(input)).jobs[0]!.id, original.id)
  assert.equal(h.service.retry(original.id).operation, 'recover')
  assert.equal(h.service.retry(original.id).operation, 'recover')
  await h.service.runPending()
  const done = h.service.getJob(original.id)
  assert.equal(done.status, 'completed')
  assert.equal(done.result?.submitted, true)
  assert.equal(done.createdAt, original.createdAt)
  assert.equal(confirms, 2, 'one rejected click and one first actual submission on the same editor')
  assert.equal(h.calls.length, 1)
  assert.equal(h.service.listJobs().length, 1)
})

test('legacy uncertain publication remains recovery-only even when dispatch and result flags are missing', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  const job = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })).jobs[0]!
  const sql = new Database(h.options.databasePath)
  sql.prepare("UPDATE history_social_upload_jobs SET status='uncertain',upload_dispatched=0,result_json=NULL WHERE id=?").run(job.id)
  h.runtime.resetSocialUploadAttempt = async () => assert.fail('unknown publication cannot be reset')
  h.runtime.runSocialUpload = async () => assert.fail('unknown publication cannot be uploaded again')
  h.runtime.confirmSocialUpload = async () => assert.fail('unknown publication cannot be submitted again')
  h.runtime.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'unknown', message: '缺少原提交结果' })
  try {
    assert.equal(h.service.retry(job.id).operation, 'recover')
    await h.service.runPending()
    assert.equal(h.service.getJob(job.id).status, 'uncertain')
    sql.prepare("UPDATE history_social_upload_jobs SET payload_json=NULL,upload_dispatched=0 WHERE id=?").run(job.id)
    assert.throws(() => h.service.retry(job.id), /原上传记录缺失/)
    assert.equal(h.service.listJobs().length, 1)
  } finally { sql.close() }
})

test('a persisted publication retry with an earlier attempt never enters draft reset logic', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  const job = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })).jobs[0]!
  const sql = new Database(h.options.databasePath)
  const payload = JSON.parse((sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(job.id) as { payload_json: string }).payload_json)
  const staged = h.result(payload)
  sql.prepare("UPDATE history_social_upload_jobs SET status='queued',operation='retry',upload_dispatched=1,result_json=? WHERE id=?")
    .run(JSON.stringify(staged), job.id)
  sql.close()
  let reconciles = 0
  h.runtime.resetSocialUploadAttempt = async () => assert.fail('legacy retry must not reset publication')
  h.runtime.runSocialUpload = async () => assert.fail('legacy retry must not reupload')
  h.runtime.confirmSocialUpload = async () => assert.fail('legacy retry must not republish')
  h.runtime.inspectSocialUploadCheckpoint = async () => ({ action: 'reconcile', phase: 'publish_requested', message: '核对原提交', result: staged })
  h.runtime.reconcileSocialUpload = async old => { reconciles++; assert.deepEqual(old, payload); return publishedResult(staged) }
  await h.service.runPending()
  assert.equal(reconciles, 1)
  assert.equal(h.service.getJob(job.id).status, 'completed')
  assert.equal(h.service.listJobs().length, 1)
})

test('a missing bridge checkpoint cannot turn an uncertain publication into a fresh upload', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  h.runtime.confirmSocialUpload = async () => { throw Error('结果未知') }
  const job = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })).jobs[0]!
  await h.service.runPending()
  const staged = h.service.getJob(job.id).result
  h.runtime.inspectSocialUploadCheckpoint = async () => ({ action: 'upload', phase: 'new', message: '检查点文件不存在' })
  h.runtime.runSocialUpload = async () => assert.fail('missing evidence must not authorize another upload')
  h.runtime.resetSocialUploadAttempt = async () => assert.fail('must retain original submission')
  h.service.retry(job.id)
  await h.service.runPending()
  assert.equal(h.service.getJob(job.id).status, 'uncertain')
  assert.match(h.service.getJob(job.id).error!, /检查点缺失/)
  assert.deepEqual(h.service.getJob(job.id).result, staged)
  assert.equal(h.calls.length, 1)
})

test('legacy queued publication recovery without dispatch flags cannot upload when its bridge checkpoint is missing', async t => {
  const h = await fixture(t), video = addVideo(h, 'motion')
  const original = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })).jobs[0]!
  const sql = new Database(h.options.databasePath)
  sql.prepare("UPDATE history_social_upload_jobs SET status='queued',operation='recover',upload_dispatched=0,result_json=NULL WHERE id=?").run(original.id)
  sql.close()
  let confirms = 0
  h.runtime.inspectSocialUploadCheckpoint = async () => ({ action: 'upload', phase: 'new', message: '检查点文件不存在' })
  h.runtime.confirmSocialUpload = async (_payload, result) => { confirms++; return publishedResult(result) }
  await h.service.runPending()
  const job = h.service.getJob(original.id)
  assert.equal(job.status, 'uncertain')
  assert.match(job.error!, /检查点缺失/)
  assert.equal(h.calls.length, 0)
  assert.equal(confirms, 0)
  assert.equal(job.result, null)
  assert.equal(h.service.listJobs().length, 1)
})

test('startup completes failed publication jobs only from valid stored submission receipts without platform writes', async t => {
  for (const status of ['failed', 'uncertain'] as const) await t.test(status, async t => {
    const h = await fixture(t), video = addVideo(h, 'motion')
    const job = (await h.service.enqueue({ sourceIds: [71], targets: ['baijiahao-video'], videoIds: [video.id] })).jobs[0]!
    const sql = new Database(h.options.databasePath)
    const payload = JSON.parse((sql.prepare('SELECT payload_json FROM history_social_upload_jobs WHERE id=?').get(job.id) as { payload_json: string }).payload_json)
    const result = publishedResult(h.result(payload))
    sql.prepare('UPDATE history_social_upload_jobs SET status=?,operation=NULL,upload_dispatched=1,result_json=?,error=? WHERE id=?')
      .run(status, JSON.stringify(result), '旧错误', job.id)
    sql.close()
    h.runtime.inspectSocialUploadCheckpoint = async () => assert.fail('stored confirmed receipt is sufficient')
    h.runtime.runSocialUpload = async () => assert.fail('must not reupload')
    h.runtime.confirmSocialUpload = async () => assert.fail('must not republish')
    const restarted = new HistorySocialUploadService(h.options)
    try {
      await restarted.runPending()
      assert.equal(restarted.getJob(job.id).status, 'completed')
      assert.equal(restarted.getJob(job.id).error, null)
      assert.deepEqual(restarted.getJob(job.id).result, result)
      assert.equal(restarted.listJobs().length, 1)
    } finally { await restarted.close() }
  })
})

test('publication refuses fake saved receipts and foreign video IDs before any new upload', async t => {
  const h=await fixture(t);const video=addVideo(h,'motion')
  await assert.rejects(h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[video.id+9]}),/不属于/)
  assert.throws(()=>historySocialUploadInputSchema.parse({sourceIds:[71],targets:['tencent-video']}),/百家号视频/)
  const receipt=await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[video.id]})
  await h.service.runPending()
  assert.equal(h.service.getJob(receipt.jobs[0]!.id).status,'uncertain')
  assert.match(h.service.getJob(receipt.jobs[0]!.id).error!,/发表任务不能以保存草稿完成/)
  assert.equal(h.service.listJobs().length,1)
})

test('publication candidate stays pending until both registered productions have submission receipts',async t=>{
  const h=await fixture(t),sql=new Database(h.options.databasePath)
  sql.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,rewritten_script TEXT,deleted_at TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY,video_path TEXT);
    CREATE TABLE history_dual_production(source_id INTEGER,script_sha256 TEXT);`)
  sql.prepare('INSERT INTO history_script_sources VALUES(?,?,?,NULL)').run(71,h.source.title,h.source.rewrittenScript)
  sql.prepare('INSERT INTO history_script_deliveries VALUES(?,?)').run(71,h.source.delivery!.videoUrl)
  sql.prepare('INSERT INTO history_dual_production VALUES(?,?)').run(71,hash(h.source.rewrittenScript!));sql.close()
  h.runtime.confirmSocialUpload=async(_payload,result)=>publishedResult(result)
  const first=addVideo(h,'huasheng')
  await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[first.id]});await h.service.runPending()
  assert.equal(h.service.candidates()[0]!.uploads['baijiahao-video'],undefined,'second production is still outstanding')
  const second=addVideo(h,'motion')
  assert.equal(h.service.candidates()[0]!.uploads['baijiahao-video'],undefined,'second output has no publication receipt yet')
  await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[second.id]});await h.service.runPending()
  assert.equal(h.service.candidates()[0]!.uploads['baijiahao-video']?.status,'submitted')
})

test('publication candidates limit manuscript loading to requested source IDs', async t => {
  const h = await fixture(t)
  const database = new Database(h.options.databasePath)
  t.after(() => database.close())
  database.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,rewritten_script TEXT,deleted_at TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY,video_path TEXT);
    INSERT INTO history_script_sources VALUES(71,'历史项目','正文',NULL),(72,'另一稿件','正文',NULL),(73,'已删除','正文','deleted');
    INSERT INTO history_script_deliveries VALUES(71,'static/71.mp4'),(72,'static/72.mp4'),(73,'static/73.mp4');`)
  assert.deepEqual(h.service.candidates().map(item => item.scriptId), [72, 71])
  assert.deepEqual(h.service.candidates([71]).map(item => item.scriptId), [71])
  assert.deepEqual(h.service.candidates([72, 71, 71, 73]).map(item => item.scriptId), [72, 71])
  assert.deepEqual(h.service.candidates([73, 999]), [])
  for (const ids of [[], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], Array.from({length: 101}, (_, index) => index + 1)]) {
    assert.throws(() => h.service.candidates(ids), {status: 400})
  }
  assert.deepEqual(h.service.candidates().map(item => item.scriptId), [72, 71])
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.service.listJobs(), [])
})

test('summary candidates keep full results without reading manuscript checkpoints or snapshot JSON', async t => {
  const {ensureHistoryStatusSchema,ensureHistoryStatusReadIndexes,projectHistoryMotionStatus,projectHistorySourceStatus} = await import('./history-status-storage.js')
  const h = await fixture(t), sql = new Database(h.options.databasePath)
  t.after(() => sql.close())
  sql.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,rewritten_script TEXT,deleted_at TEXT,
    platform TEXT,source_video_id TEXT,source_url TEXT,raw_transcript TEXT,corrected_transcript TEXT,media_json TEXT,asr_json TEXT,review_json TEXT);
    CREATE TABLE history_motion_productions(id TEXT PRIMARY KEY,script_id INTEGER,status TEXT,updated_at TEXT,snapshot TEXT);`)
  const sourceUrl = 'https://baijiahao.baidu.com/s?id=12345', padding = 'x'.repeat(1024*1024)
  sql.prepare('INSERT INTO history_script_sources VALUES(?,?,?,NULL,?,?,?,?,?,?,?,?)').run(71,h.source.title,h.source.rewrittenScript,
    'baijiahao','12345',sourceUrl,'原文','校对稿',
    JSON.stringify({kind:'article',articleId:'12345',sourceUrl,textSha256:hash('原文')}),JSON.stringify({padding}),
    JSON.stringify({factCheckStatus:'needs_sources',rawTranscriptSha256:hash('原文'),correctedTranscriptSha256:hash('校对稿'),
      rewriteInputSha256:hash('校对稿'),padding}))
  sql.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)').run('motion',71,'selecting','after',
    JSON.stringify({script:h.source.rewrittenScript,message:'正在制作',plan:{padding}}))
  addVideo(h,'motion')
  const originalFlag = process.env.HISTORY_STATUS_READS
  delete process.env.HISTORY_STATUS_READS
  const expected = h.service.candidates()
  assert.equal(expected.length, 1)
  ensureHistoryStatusSchema(sql)
  projectHistoryMotionStatus(sql, 'motion')
  projectHistorySourceStatus(sql, 71)
  ensureHistoryStatusReadIndexes(sql)
  const reader = (h.service as unknown as {database:Database.Database}).database
  const prepare = reader.prepare, statements: string[] = []
  t.mock.method(reader,'prepare',(statement: string) => {
    statements.push(statement)
    return prepare.call(reader,statement)
  })
  const stat = fs.statSync
  t.mock.method(fs,'statSync',((...args: Parameters<typeof fs.statSync>) => {
    assert.equal(reader.inTransaction, false, 'file inspection must follow the short database read transaction')
    return stat(...args)
  }) as typeof fs.statSync)
  process.env.HISTORY_STATUS_READS = '1'
  t.after(() => {if (originalFlag === undefined) delete process.env.HISTORY_STATUS_READS; else process.env.HISTORY_STATUS_READS = originalFlag})
  reader.pragma('query_only=ON')
  assert.deepEqual(h.service.candidates(), expected)
  assert.deepEqual(h.service.candidates([71]), expected)
  assert.ok(statements.length > 0)
  assert.ok(statements.every(statement => !/\b(snapshot|rewritten_script|raw_transcript|corrected_transcript|media_json|asr_json|review_json)\b/i.test(statement)),
    'summary list SQL must not depend on original large fields')
  const sourceQueries = statements.filter(statement => /FROM history_script_sources s INDEXED BY/.test(statement))
  assert.equal(sourceQueries.length, 2)
  assert.ok(sourceQueries.some(statement => /s\.id IN \(\?\)/.test(statement)), 'the scoped source query must use its covering index')
  assert.ok(sourceQueries.some(statement => !/s\.id IN/.test(statement)), 'the full source query must use its covering index')
  const indexedQueries = statements.filter(statement => /INDEXED BY/.test(statement))
  assert.ok(indexedQueries.some(statement => /FROM history_motion_productions INDEXED BY/.test(statement)))
  for (const statement of indexedQueries) {
    const parameters = Array.from({length: (statement.match(/\?/g) || []).length}, () => 71)
    const plan = reader.prepare<number[], {detail:string}>(`EXPLAIN QUERY PLAN ${statement}`).all(...parameters)
    for (const [, index] of statement.matchAll(/INDEXED BY (\w+)/g)) {
      assert.ok(plan.some(row => row.detail.includes(`COVERING INDEX ${index}`)), JSON.stringify({statement, plan}))
    }
  }
  sql.prepare('UPDATE history_script_sources SET rewritten_script=? WHERE id=71').run('外部进程修改了当前稿件。')
  const pending = h.service.candidates()[0]!.versions[0]!
  assert.equal(pending.canPublish,false)
  assert.equal(pending.action,'none')
  assert.match(pending.message,/同步/)
  sql.prepare('DELETE FROM history_source_status WHERE source_id=71').run()
  const missing = h.service.candidates()[0]!.versions[0]!
  assert.equal(missing.canPublish,false)
  assert.match(missing.message,/同步/)
  assert.deepEqual(h.calls, [])
})

test('publication inventory includes both accepted editions before a legacy delivery exists', async t => {
  const h = await fixture(t), sql = new Database(h.options.databasePath)
  sql.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,rewritten_script TEXT,deleted_at TEXT);
    CREATE TABLE history_dual_production(source_id INTEGER,script_sha256 TEXT,production_mode TEXT);`)
  sql.prepare('INSERT INTO history_script_sources VALUES(?,?,?,NULL)').run(71,h.source.title,h.source.rewrittenScript)
  sql.prepare("INSERT INTO history_dual_production VALUES(?,?,'dual')").run(71,hash(h.source.rewrittenScript!))
  sql.close()
  const items = h.service.candidates()
  assert.equal(items.length, 1, 'accepted work cannot disappear until its first video is delivered')
  assert.deepEqual(items[0]!.versions.map(version => version.producer), ['huasheng', 'motion'])
  assert.ok(items[0]!.versions.every(version => !version.canPublish && version.videoId === null))
  assert.deepEqual(h.calls, [])
})

test('a legacy video path and manual upload marker remain reviewable without becoming publishable', async t => {
  const h = await fixture(t), sql = new Database(h.options.databasePath)
  sql.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,rewritten_script TEXT,deleted_at TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY,video_path TEXT);`)
  sql.prepare('INSERT INTO history_script_sources VALUES(?,?,?,NULL)').run(71,h.source.title,h.source.rewrittenScript)
  sql.prepare('INSERT INTO history_script_deliveries VALUES(?,?)').run(71,h.source.delivery!.videoUrl)
  sql.close()
  await h.service.markUploaded({sourceIds:[71],targets:['baijiahao-video']})
  const item = h.service.candidates()[0]!
  assert.equal(item.uploads['baijiahao-video'], undefined, 'manual draft markers are not publication receipts')
  assert.equal(item.versions[0]!.state, 'stale')
  assert.equal(item.versions[0]!.action, 'review_legacy')
  assert.equal(item.versions[0]!.canPublish, false)
})

test('motion backfill candidate completes with a refined receipt without requiring the old Huasheng edition', async t => {
  const h = await fixture(t), sql = new Database(h.options.databasePath)
  sql.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,rewritten_script TEXT,deleted_at TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY,video_path TEXT);
    CREATE TABLE history_dual_production(source_id INTEGER,script_sha256 TEXT,production_mode TEXT);`)
  sql.prepare('INSERT INTO history_script_sources VALUES(?,?,?,NULL)').run(71,h.source.title,h.source.rewrittenScript)
  sql.prepare('INSERT INTO history_script_deliveries VALUES(?,?)').run(71,h.source.delivery!.videoUrl)
  sql.prepare("INSERT INTO history_dual_production VALUES(?,?,'motion_backfill')").run(71,hash(h.source.rewrittenScript!))
  sql.close()
  addVideo(h,'huasheng')
  assert.equal(h.service.candidates()[0]!.uploads['baijiahao-video'],undefined)
  const motion = addVideo(h,'motion')
  h.runtime.confirmSocialUpload = async (_payload, result) => publishedResult(result)
  await h.service.enqueue({sourceIds:[71],targets:['baijiahao-video'],videoIds:[motion.id]})
  await h.service.runPending()
  assert.equal(h.service.candidates()[0]!.uploads['baijiahao-video']?.status,'submitted')
  assert.equal(h.calls.length,1)
  assert.equal(path.basename(h.calls[0]!.videoPath!), 'motion.mp4')
})
