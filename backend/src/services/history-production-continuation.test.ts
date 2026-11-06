import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-continue-'))
process.env.DB_PATH = path.join(root, 'test.db')
process.env.STORAGE_PATH = root
process.env.TASK_WORKER_DISABLED = '1'
const { db, schema } = await import('../db/index.js')
const { storeHistorySource, updateHistorySource, getHistorySource, deleteHistorySource } = await import('./history-script-library.js')
const { getTask, requestCancel } = await import('./tasks/store.js')
const { clearTaskHandlers, registerTaskHandler } = await import('./tasks/registry.js')
const { runWorkerOnce } = await import('./tasks/worker.js')
const { ensureHistoryDualProductionSchema, recordHistoryDualProduction, recordHistoryVideoDelivery } = await import('./history-video-deliveries.js')
const { ensureHistorySocialUploadSchema } = await import('./history-social-upload.js')
const { ensureHistoryVideoPackagingSchema } = await import('./history-video-packaging.js')
const { startHistoryProductionContinuation, getHistoryProductionContinuation, createHistoryProductionContinuationHandler, HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, historyProductionSourceRevision } = await import('./history-production-continuation.js')
const { acquireHistorySourceLock } = await import('./history-source-pipeline.js')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
let serial = 0
ensureHistoryDualProductionSchema(db.$client)
beforeEach(() => {
  db.delete(schema.creationTaskEvents).run()
  db.delete(schema.creationTasks).run()
  db.$client.exec('DELETE FROM history_dual_production')
  db.delete(schema.historyScriptSources).run()
  clearTaskHandlers()
})
after(() => { db.$client.close(); fs.rmSync(root, { recursive: true, force: true }) })
function seed() {
  return storeHistorySource({ sourceVideoId: String(++serial), title: '秦朝为何灭亡', category: 'historical_commentary',
    selection: { reason: 'test', observedAt: new Date().toISOString(), comments: [] } })
}
function draft(id: number) {
  const text = '秦朝统一天下后，地方豪强仍然活跃。'
  return updateHistorySource(id, { status: 'needs_review', rawTranscript: text, correctedTranscript: text, rewrittenScript: text,
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 2, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text, sourceVideoSha256: '1'.repeat(64), chunks: [{ index: 0, start: 0, duration: 2, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(text), correctedTranscriptSha256: hash(text), rewriteInputSha256: hash(text) }) })!
}
function delivered(source:ReturnType<typeof draft>,producer:'huasheng'|'motion') {
  const directory=path.join(root,'history-deliveries',String(source.id))
  fs.mkdirSync(directory,{recursive:true})
  fs.writeFileSync(path.join(directory,`${producer}.mp4`),`${producer} video`)
  return recordHistoryVideoDelivery(db.$client,{scriptId:source.id,scriptSha256:hash(source.rewrittenScript!),producer,producerJobId:'94',
    videoUrl:`/static/history-deliveries/${source.id}/${producer}.mp4`,videoName:`${producer}.mp4`,duration:2,sha256:hash(`${producer} video`)})
}
function submitted(source:ReturnType<typeof draft>,video:ReturnType<typeof delivered>) {
  ensureHistorySocialUploadSchema(db.$client)
  const articleId=`18800000000000${source.id}${video.id}`
  const result={staged:true,targetId:'original-editor',editorUrl:'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',
    submitted:true,saved:false,published:false,publicationStatus:'submitted',articleId,
    publishedUrl:`https://baijiahao.baidu.com/builder/preview/s?id=${articleId}`}
  db.$client.prepare(`INSERT INTO history_social_upload_jobs
    (source_id,source_title,target,mode,publication_mode,status,message,blockers_json,fingerprint,engine,result_json,video_id,video_producer,created_at,updated_at)
    VALUES(?,?,'baijiahao-video','draft','publish','completed','已提交','[]',?,'fixture',?,?,?,'before','before')`)
    .run(source.id,source.title,`${source.id}:${video.id}`,JSON.stringify(result),video.id,video.producer)
}
const worker = () => runWorkerOnce({ workerId: 'continue-test', types: [HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE], cancelPollMs: 5 })
const handler = (options: Parameters<typeof createHistoryProductionContinuationHandler>[0]) => createHistoryProductionContinuationHandler({ storageRoot: root, ...options })
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for continuation checkpoint')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

test('duplicate continue clicks durably reuse one queued task without starting production in HTTP', () => {
  const source = seed()
  const first = startHistoryProductionContinuation(source.id, { expectedRevision: historyProductionSourceRevision(source) })
  const second = startHistoryProductionContinuation(source.id, { expectedRevision: historyProductionSourceRevision(source) })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(first.task!.id, second.task!.id)
  assert.equal(getHistoryProductionContinuation(source.id).task!.status, 'queued')
  assert.equal(getHistorySource(source.id)!.status, source.status)
})

test('downloaded source continues only through missing manuscript stages before two-version admission', async () => {
  const source = updateHistorySource(seed().id, { status: 'downloaded', mediaJson: '{"videoSha256":"saved"}' })!
  const calls: string[] = []
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async (id, options) => { calls.push('manuscript'); assert.equal(id, source.id); assert.equal(options?.through, 'recreate'); return draft(id) },
    queue: async () => ({ syncProduction: async () => { calls.push('sync'); return { jobs: [] } }, resume: async () => assert.fail('No old job to resume') }),
    startProduction: async id => { calls.push('production'); assert.equal(id, source.id); return { production: { motion_state: 'pending' } } },
  }))
  const result = startHistoryProductionContinuation(source.id)
  await worker()
  assert.equal(getTask(result.task!.id)!.status, 'succeeded')
  assert.deepEqual(calls, ['manuscript', 'sync', 'production'])
})

test('a saved current draft is never rewritten and a matched original Huasheng task is resumed', async () => {
  const source = draft(seed().id)
  const calls: string[] = []
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async () => assert.fail('Current saved manuscript must not be rewritten'),
    queue: async () => ({ syncProduction: async id => { calls.push('sync'); assert.equal(id, source.id); return { jobs: [{ id: 94, scriptSha256: hash(source.rewrittenScript!), status: 'needs_attention', productionStatus: 'not_started', checkpoint: 'create_pending', projectUrl: 'https://www.huasheng.cn/video/123' }] } },
      resume: async id => { assert.equal(id, 94); calls.push('resume'); return {} } }),
    startProduction: async () => { calls.push('production'); return {} },
  }))
  const result = startHistoryProductionContinuation(source.id)
  await worker()
  assert.equal(getTask(result.task!.id)!.status, 'succeeded')
  assert.deepEqual(calls, ['sync', 'resume', 'production'])
  assert.equal(getHistorySource(source.id)!.rewrittenScript, source.rewrittenScript)
})

test('an unbound create_pending task stays blocked while refined production can advance', async () => {
  const source = draft(seed().id)
  let admitted = false
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async () => assert.fail('No rewrite'),
    queue: async () => ({ syncProduction: async () => ({ jobs: [{ id: 94, scriptSha256: hash(source.rewrittenScript!), status: 'needs_attention', productionStatus: 'not_started', checkpoint: 'create_pending', projectUrl: null, error: '尚未找到唯一匹配项目' }] }),
      resume: async () => assert.fail('An uncertain create must not be blindly resumed') }),
    startProduction: async (_id, options) => { admitted = true; assert.match(options.huashengBlockedReason!, /唯一匹配/); return {} },
  }))
  const result = startHistoryProductionContinuation(source.id)
  await worker()
  assert.equal(admitted, true)
  assert.equal(getTask(result.task!.id)!.result.stage, 'needs_attention')
})

test('sync failure is recorded without blocking independent refined production', async () => {
  const source = draft(seed().id)
  let admitted = false
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async () => assert.fail('No rewrite'),
    queue: async () => ({ syncProduction: async () => { throw Error('花生暂时不可达') }, resume: async () => assert.fail('Failed sync must not resume') }),
    startProduction: async (_id, options) => { admitted = true; assert.match(options.huashengBlockedReason!, /暂时不可达/); return {} },
  }))
  const result = startHistoryProductionContinuation(source.id)
  await worker()
  assert.equal(admitted, true)
  assert.equal(getTask(result.task!.id)!.status, 'succeeded')
  assert.match(getTask(result.task!.id)!.result.message, /花生/)
})

test('source revision conflicts and deletions cannot start continuation work', async () => {
  const source = draft(seed().id)
  assert.throws(() => startHistoryProductionContinuation(source.id, { expectedRevision: '0'.repeat(64) }), /已更新/)
  let called = false
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async () => { called = true; throw Error('unexpected') }, queue: async () => { called = true; throw Error('unexpected') }, startProduction: async () => { called = true; throw Error('unexpected') },
  }))
  const result = startHistoryProductionContinuation(source.id, { expectedRevision: historyProductionSourceRevision(source) })
  updateHistorySource(source.id, { rewrittenScript: '用户在排队期间改了正文' })
  await worker()
  assert.equal(getTask(result.task!.id)!.status, 'failed')
  assert.equal(called, false)
  const deleted = seed()
  deleteHistorySource(deleted.id)
  assert.throws(() => startHistoryProductionContinuation(deleted.id), /不存在/)
})

test('old completed branch flags cannot close production without current edition submission receipts', () => {
  const source = draft(seed().id)
  recordHistoryDualProduction(db.$client, source.id, hash(source.rewrittenScript!), 94)
  db.$client.prepare("UPDATE history_dual_production SET huasheng_state='completed',motion_state='completed' WHERE source_id=?").run(source.id)
  const result = startHistoryProductionContinuation(source.id)
  assert.equal(result.complete, false)
  assert.equal(result.created, true)
  assert.ok(result.task)
  assert.equal(getHistoryProductionContinuation(source.id).complete, false)
})

test('all required current submission receipts complete the workflow without creating another task',()=>{
  const source=draft(seed().id)
  recordHistoryDualProduction(db.$client,source.id,hash(source.rewrittenScript!),94)
  for(const producer of ['huasheng','motion'] as const)submitted(source,delivered(source,producer))
  const result=startHistoryProductionContinuation(source.id)
  assert.equal(result.complete,true)
  assert.equal(result.created,false)
  assert.equal(result.task,null)
})

test('continuation recovers delivered edition materials without entering either producer again',async()=>{
  const source=draft(seed().id)
  recordHistoryDualProduction(db.$client,source.id,hash(source.rewrittenScript!),94)
  const huasheng=delivered(source,'huasheng'),motion=delivered(source,'motion')
  submitted(source,huasheng)
  ensureHistoryVideoPackagingSchema(db.$client)
  db.$client.prepare(`INSERT INTO history_video_packaging
    (video_id,script_id,script_sha256,design_status,cover_status,design_error,updated_at)
    VALUES(?,?,?,'failed','failed','标题失败','before')`).run(motion.id,source.id,motion.scriptSha256)
  const continued:number[]=[]
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE,handler({
    process:async()=>assert.fail('saved manuscript cannot be rewritten'),
    queue:async()=>assert.fail('delivered Huasheng output must not return to platform production'),
    startProduction:async()=>assert.fail('existing local videos must not be rendered again'),
    continueVideo:async(id,videoId,expected)=>{
      assert.equal(id,source.id);assert.equal(expected,motion.scriptSha256);continued.push(videoId)
      return {reused:true,message:'已恢复发布准备',status:'pending'}
    },
  }))
  const result=startHistoryProductionContinuation(source.id)
  await worker()
  assert.deepEqual(continued,[motion.id])
  assert.equal(getTask(result.task!.id)!.status,'succeeded')
  assert.equal(getTask(result.task!.id)!.result.stage,'publication')
  assert.equal(getHistorySource(source.id)!.rewrittenScript,source.rewrittenScript)
})

function exportRecord(source:ReturnType<typeof draft>,status:string) {
  db.$client.exec(`CREATE TABLE IF NOT EXISTS history_huasheng_export_jobs(
    id INTEGER PRIMARY KEY,source_id INTEGER,script_sha256 TEXT,huasheng_job_id INTEGER,status TEXT,message TEXT,error TEXT)`)
  return Number(db.$client.prepare(`INSERT INTO history_huasheng_export_jobs(source_id,script_sha256,huasheng_job_id,status,message)
    VALUES(?,?,94,?,'请核对原导出任务')`).run(source.id,hash(source.rewrittenScript!),status).lastInsertRowid)
}

test('continuation resumes the failed original export while independently continuing refined work',async()=>{
  const source=draft(seed().id)
  recordHistoryDualProduction(db.$client,source.id,hash(source.rewrittenScript!),94)
  const exportId=exportRecord(source,'failed'),resumed:number[]=[]
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE,handler({
    queue:async()=>assert.fail('the accepted export already identifies the original production'),
    continueExport:async id=>{resumed.push(id)},
    startProduction:async(_id,options)=>{assert.equal(options.huashengBlockedReason,undefined);return {}},
  }))
  const result=startHistoryProductionContinuation(source.id)
  await worker()
  assert.deepEqual(resumed,[exportId])
  assert.equal(getTask(result.task!.id)!.result.stage,'production')
})

for(const status of ['completed','waiting_login'])test(`continuation exposes ${status} export attention without retrying or replacing it`,async()=>{
  const source=draft(seed().id)
  recordHistoryDualProduction(db.$client,source.id,hash(source.rewrittenScript!),94)
  exportRecord(source,status)
  let continued=false
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE,handler({
    queue:async()=>assert.fail('export attention must not recreate or resynchronize platform production'),
    continueExport:async()=>assert.fail('this export cannot be resumed blindly'),
    startProduction:async(_id,options)=>{continued=true;assert.ok(options.huashengBlockedReason);return {}},
  }))
  const result=startHistoryProductionContinuation(source.id)
  await worker()
  assert.equal(continued,true,'the refined sibling can still advance')
  assert.equal(getTask(result.task!.id)!.result.stage,'needs_attention')
  assert.match(getTask(result.task!.id)!.result.message,status==='completed'?/独立交付|原导出/:/原导出|登录/)
  assert.equal(getHistoryProductionContinuation(source.id).complete,false)
})

test('continuation reports a terminal material recovery response as needs-attention',async()=>{
  const source=draft(seed().id)
  recordHistoryDualProduction(db.$client,source.id,hash(source.rewrittenScript!),94)
  submitted(source,delivered(source,'huasheng'))
  const motion=delivered(source,'motion')
  ensureHistoryVideoPackagingSchema(db.$client)
  db.$client.prepare(`INSERT INTO history_video_packaging(video_id,script_id,script_sha256,design_status,cover_status,design_error,updated_at)
    VALUES(?,?,?,'failed','failed','标题失败','before')`).run(motion.id,source.id,motion.scriptSha256)
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE,handler({
    startProduction:async()=>assert.fail('delivered videos must be preserved'),
    continueVideo:async()=>({reused:true,status:'needs_attention',message:'标题校验仍未通过'}),
  }))
  const result=startHistoryProductionContinuation(source.id)
  await worker()
  assert.equal(getTask(result.task!.id)!.result.stage,'needs_attention')
  assert.match(getTask(result.task!.id)!.result.message,/标题校验仍未通过/)
})

test('a live collector is awaited and its completed draft is reused without duplicate transcription', async () => {
  const source = updateHistorySource(seed().id, { status: 'transcribing' })!
  const release = await acquireHistorySourceLock(source.id, root)
  let queued = false
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async () => assert.fail('The collector already completed the manuscript'),
    queue: async () => { queued = true; return { syncProduction: async () => ({ jobs: [] }), resume: async () => {} } },
    startProduction: async () => ({}),
  }))
  const result = startHistoryProductionContinuation(source.id)
  const running = worker()
  try {
    await waitUntil(() => getTask(result.task!.id)?.progressMessage?.includes('原采集任务仍在处理') === true)
    assert.equal(queued, false)
    draft(source.id)
  } finally { await release() }
  await running
  assert.equal(getTask(result.task!.id)!.status, 'succeeded')
  assert.equal(queued, true)
})

test('canceling a wait preserves the live collector lock and performs no paid work', async () => {
  const source = updateHistorySource(seed().id, { status: 'transcribing' })!
  const release = await acquireHistorySourceLock(source.id, root)
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async () => assert.fail('No duplicate processing'), queue: async () => assert.fail('No sync before collector completion'),
    startProduction: async () => assert.fail('No production before collector completion'),
  }))
  const result = startHistoryProductionContinuation(source.id)
  const running = worker()
  try {
    await waitUntil(() => getTask(result.task!.id)?.progressMessage?.includes('原采集任务仍在处理') === true)
    requestCancel(result.task!.id)
    await running
    assert.equal(getTask(result.task!.id)!.status, 'canceled')
    assert.equal(fs.existsSync(path.join(root, String(source.id), 'process.lock')), true)
  } finally { await release() }
})

test('a recovered attempt still refuses a changed originally saved manuscript', async () => {
  const source = draft(seed().id)
  const result = startHistoryProductionContinuation(source.id)
  db.$client.prepare('UPDATE creation_tasks SET attempts=1 WHERE id=?').run(result.task!.id)
  draft(source.id)
  updateHistorySource(source.id, { rewrittenScript: '已由用户修改的新正文' })
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async () => assert.fail('No rewrite'), queue: async () => assert.fail('No sync'), startProduction: async () => assert.fail('No production'),
  }))
  await worker()
  assert.equal(getTask(result.task!.id)!.status, 'failed')
  assert.equal(getTask(result.task!.id)!.attempts, 2)
  assert.match(getTask(result.task!.id)!.errorMessage!, /稿件已更新/)
})

test('a source left transcribing by an exited owner is safely unlocked and continued', async () => {
  const source = updateHistorySource(seed().id, { status: 'transcribing' })!
  const owner = spawn(process.execPath, ['-e', ''])
  await once(owner, 'exit')
  assert.ok(owner.pid)
  const directory = path.join(root, String(source.id))
  fs.mkdirSync(directory, { recursive: true })
  const lockPath = path.join(directory, 'process.lock')
  fs.writeFileSync(lockPath, JSON.stringify({ pid: owner.pid, hostname: os.hostname() }))
  let processed = false
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async id => { processed = true; assert.equal(fs.existsSync(lockPath), false); return draft(id) },
    queue: async () => ({ syncProduction: async () => ({ jobs: [] }), resume: async () => {} }),
    startProduction: async () => ({}),
  }))
  const result = startHistoryProductionContinuation(source.id)
  await worker()
  assert.equal(processed, true)
  assert.equal(getTask(result.task!.id)!.status, 'succeeded')
})

test('a manuscript completed by collection after admission is reused without rewriting', async () => {
  const source = seed()
  const result = startHistoryProductionContinuation(source.id)
  const completed = draft(source.id)
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async () => assert.fail('Use the draft the collector already completed'),
    queue: async () => ({ syncProduction: async () => ({ jobs: [] }), resume: async () => {} }),
    startProduction: async () => ({}),
  }))
  await worker()
  const task = getTask(result.task!.id)!
  assert.equal(task.status, 'succeeded')
  assert.equal(task.payload.scriptSha256, hash(completed.rewrittenScript!))
  assert.equal(getHistorySource(source.id)!.rewrittenScript, completed.rewrittenScript)
})

test('a draft generated during continuation is locked before retrying failed downstream admission', async () => {
  const source = seed()
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async id => draft(id),
    queue: async () => ({ syncProduction: async () => ({ jobs: [] }), resume: async () => {} }),
    startProduction: async () => { throw Error('temporary downstream failure') },
  }))
  const result = startHistoryProductionContinuation(source.id)
  await worker()
  const task = getTask(result.task!.id)!
  assert.equal(task.status, 'queued')
  assert.equal(task.payload.scriptSha256, hash(getHistorySource(source.id)!.rewrittenScript!))
  const edited = '用户在下游失败期间保存的新正文'
  updateHistorySource(source.id, { rewrittenScript: edited })
  db.$client.prepare('UPDATE creation_tasks SET scheduled_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), task.id)
  registerTaskHandler(HISTORY_PRODUCTION_CONTINUATION_TASK_TYPE, handler({
    process: async () => assert.fail('No rewrite'), queue: async () => assert.fail('No sync after changed draft'), startProduction: async () => assert.fail('No production'),
  }))
  await worker()
  assert.equal(getTask(task.id)!.status, 'failed')
  assert.equal(getHistorySource(source.id)!.rewrittenScript, edited)
})
