import test, { after, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { CoverPromptEnhanceResult } from './cover-prompt-enhance.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-delivery-auto-'))
process.env.DB_PATH = path.join(root, 'test.db')
process.env.STORAGE_PATH = root
process.env.TASK_WORKER_DISABLED = '1'
const { db, schema } = await import('../db/index.js')
const { storeHistorySource, updateHistorySource, getHistorySource } = await import('./history-script-library.js')
const { attachHistoryVideo, getHistoryDelivery, saveHistoryDelivery, startHistoryCoverDesign } = await import('./history-script-delivery.js')
const { ensureHistoryArticleQueueSchema } = await import('./history-script-article-queue.js')
const { ensureHistoryDeliveryAutomation, isHistoryPackagingRejection } = await import('./history-delivery-automation.js')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const text = '明朝冬季的蔬菜供应有限。运输困难，城里的鲜菜价格可能更高。'
const script = '当前二创口播稿。'
const expectedScriptSha256 = hash(script)
const options = { expectedScriptSha256 }
afterEach(async()=>{for(let i=0;i<10;i++)await new Promise<void>(resolve=>setImmediate(resolve))})
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
ensureHistoryArticleQueueSchema(db.$client)

beforeEach(() => {
  db.$client.prepare('DELETE FROM history_script_article_queue').run()
  db.$client.prepare('DELETE FROM history_script_deliveries').run()
  for (const table of ['history_delivery_design_intents', 'history_video_design_intents', 'history_video_packaging', 'history_video_deliveries']) {
    if (db.$client.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table)) {
      db.$client.prepare(`DELETE FROM ${table}`).run()
    }
  }
  db.delete(schema.historyScriptSources).run()
})
after(() => { db.$client.close(); fs.rmSync(root, { recursive: true, force: true }) })

function seed() {
  const source = storeHistorySource({ sourceVideoId: '7395681234567890123', title: '明朝冬季菜价', category: 'regional_history', metrics: {}, selection: { reason: 'test', observedAt: '2026-10-14T08:00:00Z', comments: [] } })
  updateHistorySource(source.id, {
    status: 'needs_review', rawTranscript: text, correctedTranscript: text, rewrittenScript: script,
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 12, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text, sourceVideoSha256: '1'.repeat(64), chunks: [{ index: 0, start: 0, duration: 12, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ correctedTranscript: text, corrections: [], factualConcerns: [], factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(text), correctedTranscriptSha256: hash(text), rewriteInputSha256: hash(text) }),
  })
  return source.id
}
function proposal(): CoverPromptEnhanceResult {
  const design = { main_title: '明朝冬天菜有多贵？', sub_title: '供应与运输', kicker: '历史', image_prompt: 'Ming dynasty winter market, no text',
    accent_color: '#D7A649', enhanced_prompt: '冬季市场', rationale: '正文解释供应与运输。' }
  const copy = { video_title: design.main_title, baijiahao_title: '明朝冬季菜价为何偏高？', video_description: '冬天的蔬菜价格，和供应、运输有什么关系？' }
  return { ...design, ...copy, editorial_plan: {
    version: 'history-cover-plan-v1', selected_id: 'question', selection_reason: '正文可以回答的问题',
    candidates: [{ ...design, ...copy, id: 'question', method: '具体疑问', why_click: '了解冬天菜价', viewer_question: '菜价为什么高？',
      payoff: '了解供应与运输', evidence: [script], visual_concept: '冬季市场卖菜' }],
    reviews: [{ candidate_id: 'question', natural: true, understandable: true, curiosity: true, faithful: true, visual_faithful: true, coherent: true, reason: '原文支持' }],
  } }
}
const generate = async () => proposal()
const generateCovers = async (id: number) => {
  const dir=path.join(root,'history-deliveries',String(id),'covers-test')
  fs.mkdirSync(dir,{recursive:true})
  return Object.fromEntries(['16:9','4:3','3:4'].map(ratio=>{
    const name=ratio.replace(':','x')+'.png';fs.writeFileSync(path.join(dir,name),'cover fixture')
    return [ratio,`static/history-deliveries/${id}/covers-test/${name}`]
  }))
}
const dependencies = { generate, generateCovers, root }
async function video(id: number) {
  return attachHistoryVideo(id, new Blob(['finished video']).stream(), 'finished.mp4', { root, probe: async () => 12 })
}
async function settled(id: number, videoId?: number) {
  for (let i = 0; i < 100; i++) {
    const delivery = getHistoryDelivery(id, videoId)
    if (delivery.designStatus !== 'generating' && delivery.coverStatus !== 'generating') return
    await flush()
  }
  assert.fail('design did not settle')
}
test('concurrent ensure calls admit one design, reuse its saved result and automatically generate missing covers', async () => {
  const id = seed()
  let calls = 0
  const deps = { ...dependencies, generate: async () => { calls++; return proposal() } }
  const results = await Promise.all([ensureHistoryDeliveryAutomation(id, options, deps), ensureHistoryDeliveryAutomation(id, options, deps)])
  assert.ok(results.every(result => result.design.status === 'generating'))
  assert.ok(results.every(result => result.covers.status === 'queued'))
  await settled(id)
  const ready = await ensureHistoryDeliveryAutomation(id, options, deps)
  assert.equal(ready.design.status, 'completed')
  assert.equal(calls, 1)
  assert.equal(ready.covers.status, 'generating')
  await flush();await flush()
  assert.equal(getHistoryDelivery(id).coverStatus, 'completed')
  assert.equal(Object.keys(getHistoryDelivery(id).covers).length, 3)
})

for (const persistedIntent of [false, true]) {
  test(`an explicit video design retry survives waiting for the other producer (${persistedIntent ? 'failed intent' : 'no intent'})`, async () => {
    const id = seed()
    for (const producer of ['huasheng', 'motion'] as const) {
      await attachHistoryVideo(id, new Blob([`${producer} video`]).stream(), `${producer}.mp4`, {
        root, probe: async () => 12, producer, producerJobId: `${producer}-job`,
      })
    }
    const videos = getHistoryDelivery(id).videos
    const huasheng = videos.find(item => item.producer === 'huasheng')!
    const motion = videos.find(item => item.producer === 'motion')!
    const scopedOptions = { ...options, videoId: huasheng.id }
    let calls = 0
    const deps = { ...dependencies, generate: async () => { calls++; throw new Error('provider rejected this attempt') } }
    if (persistedIntent) {
      assert.equal((await ensureHistoryDeliveryAutomation(id, scopedOptions, deps)).design.status, 'generating')
      await settled(id, huasheng.id)
    } else {
      db.$client.prepare("UPDATE history_video_packaging SET design_status='failed',design_error='manual generation failed' WHERE video_id=?")
        .run(huasheng.id)
    }
    db.$client.prepare("UPDATE history_video_packaging SET design_status='generating',design_run_id='other-run',design_lease_until=? WHERE video_id=?")
      .run(new Date(Date.now() + 120000).toISOString(), motion.id)
    const waiting = await ensureHistoryDeliveryAutomation(id, { ...scopedOptions, retryFailed: true }, deps)
    assert.equal(waiting.design.status, 'queued')
    const intent = db.$client.prepare('SELECT phase,attempts FROM history_video_design_intents WHERE video_id=?')
      .get(huasheng.id) as { phase: string; attempts: number } | undefined
    assert.equal(intent?.phase, 'queued', 'accept the retry durably before waiting for another video')
    assert.equal(intent?.attempts, 0)
    db.$client.prepare("UPDATE history_video_packaging SET design_status='idle',design_run_id=NULL,design_lease_until=NULL WHERE video_id=?")
      .run(motion.id)
    assert.equal((await ensureHistoryDeliveryAutomation(id, scopedOptions, deps)).design.status, 'generating')
    await settled(id, huasheng.id)
    assert.equal(calls, persistedIntent ? 2 : 1)
    assert.equal((await ensureHistoryDeliveryAutomation(id, scopedOptions, deps)).design.status, 'failed')
    assert.equal(calls, persistedIntent ? 2 : 1, 'a rejected retry must not authorize further automatic attempts')
    assert.equal(getHistoryDelivery(id, motion.id).designStatus, 'idle')
  })
}

test('wrong source version starts neither branch', async () => {
  const id = seed()
  const result = await ensureHistoryDeliveryAutomation(id, { expectedScriptSha256: '0'.repeat(64) }, {
    ...dependencies, generate: async () => { assert.fail('old export cannot start a design') },
  })
  assert.equal(result.design.status, 'needs_attention')
  assert.equal(result.covers.status, 'needs_attention')
  assert.equal(getHistoryDelivery(id).designStatus, 'idle')
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM history_script_article_queue').get() as { n: number }).n, 0)
})

test('manual incomplete content is preserved without starting covers or articles', async () => {
  const id = seed()
  await video(id)
  db.$client.prepare('DELETE FROM history_script_article_queue WHERE source_id=?').run(id)
  const manual = saveHistoryDelivery(id, { title: '手工写到一半的标题' })
  const result = await ensureHistoryDeliveryAutomation(id, options, dependencies)
  assert.equal(result.design.status, 'needs_attention')
  assert.equal(result.covers.status, 'needs_attention')
  assert.equal(getHistoryDelivery(id).title, manual.title)
  assert.equal(getHistoryDelivery(id).designStatus, 'idle')
})

test('complete manual copy and plan are reused without fabricating an automatic editorial record', async () => {
  const id = seed()
  const manual = saveHistoryDelivery(id, { title: '手工标题', baijiahaoTitle: '手工百家号标题', description: '手工简介',
    coverDesign: { main_title: '手工标题', sub_title: '', kicker: '', ai_prompt: 'Manually prepared historical scene' } })
  const result = await ensureHistoryDeliveryAutomation(id, options, dependencies)
  assert.equal(result.design.status, 'completed')
  assert.equal(getHistoryDelivery(id).title, manual.title)
  assert.deepEqual(getHistoryDelivery(id).coverDesign, { ...manual.coverDesign, main_title: manual.baijiahaoTitle,
    sub_title: '', kicker: '', ai_prompt: '', thumbnail_layout: 'text-left', highlight_text: '' })
  assert.equal(result.covers.status,'generating')
  await flush();await flush()
})

test('video packaging never queues a retired article task', async () => {
  const id=seed();await video(id)
  await ensureHistoryDeliveryAutomation(id,options,dependencies);await settled(id)
  await ensureHistoryDeliveryAutomation(id,options,dependencies);await flush();await flush()
  assert.equal(getHistoryDelivery(id).articleGeneration,null)
  assert.equal((db.$client.prepare('SELECT count(*) AS n FROM history_script_article_queue').get() as {n:number}).n,0)
})

test('hand edits or script edits between admission and dispatch prevent any model call', async () => {
  for (const edit of ['manual', 'script']) {
    const id = seed()
    let calls = 0
    const pending = ensureHistoryDeliveryAutomation(id, options, { ...dependencies, generate: async () => { calls++; return proposal() } })
    if (edit === 'manual') saveHistoryDelivery(id, { title: '此刻用户保存的标题' })
    else updateHistorySource(id, { rewrittenScript: 'A newer script' })
    await pending
    await settled(id)
    assert.equal(calls, 0)
    assert.equal((await ensureHistoryDeliveryAutomation(id, options, dependencies)).design.status, 'needs_attention')
    if (edit === 'manual') assert.equal(getHistoryDelivery(id).title, '此刻用户保存的标题')
    db.$client.prepare('DELETE FROM history_script_deliveries WHERE script_id=?').run(id)
    db.delete(schema.historyScriptSources).run()
  }
})

function interruptedChild(id: number, dispatch: boolean) {
  const code = `import { ensureHistoryDeliveryAutomation } from './src/services/history-delivery-automation.ts';
    void ensureHistoryDeliveryAutomation(${id}, ${JSON.stringify(options)}, { generate: async () => { ${dispatch ? 'process.exit(0)' : "throw new Error('must not dispatch')"} } });
    ${dispatch ? '' : 'process.exit(0)'} `
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], { env: process.env, encoding: 'utf8', timeout: 8000 })
  assert.equal(child.status, 0, child.stderr)
  db.$client.prepare("UPDATE history_script_deliveries SET design_lease_until='2000-01-01T00:00:00Z' WHERE script_id=?").run(id)
}

test('a real process exit before dispatch safely resumes the durable admission exactly once', async () => {
  const id = seed()
  interruptedChild(id, false)
  let calls = 0
  const deps = { ...dependencies, generate: async () => { calls++; return proposal() } }
  assert.equal((await ensureHistoryDeliveryAutomation(id, options, deps)).design.status, 'generating')
  await settled(id)
  assert.equal((await ensureHistoryDeliveryAutomation(id, options, deps)).design.status, 'completed')
  assert.equal(calls, 1)
  assert.equal((db.$client.prepare('SELECT attempts FROM history_delivery_design_intents WHERE script_id=?').get(id) as { attempts: number }).attempts, 2)
})

test('a real process exit after dispatch is observed as ambiguous and never blindly replayed', async () => {
  const id = seed()
  interruptedChild(id, true)
  const deps = { ...dependencies, generate: async () => { assert.fail('ambiguous billable invocation cannot be replayed') } }
  assert.equal((await ensureHistoryDeliveryAutomation(id, options, deps)).design.status, 'needs_attention')
  assert.equal((await ensureHistoryDeliveryAutomation(id, { ...options, retryFailed: true }, deps)).design.status, 'needs_attention')
})

test('saved current design wins over an interrupted completion acknowledgement', async () => {
  const id = seed()
  await ensureHistoryDeliveryAutomation(id, options, dependencies)
  await settled(id)
  sqlIntent(id, 'dispatched')
  const result = await ensureHistoryDeliveryAutomation(id, options, { ...dependencies, generate: async () => { assert.fail('saved result must be reused') } })
  assert.equal(result.design.status, 'completed')
})
function sqlIntent(id: number, phase: string) {
  db.$client.prepare('UPDATE history_delivery_design_intents SET phase=? WHERE script_id=?').run(phase, id)
}

test('known refused connections retry at durable bounded intervals while timeouts do not auto retry', async t => {
  const id = seed()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  let calls = 0
  const deps = { ...dependencies, generate: async () => { calls++; throw Object.assign(new Error('refused connection'), { code: 'ECONNREFUSED' }) } }
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal((await ensureHistoryDeliveryAutomation(id, options, deps)).design.status, 'generating')
    await settled(id)
    assert.equal(calls, attempt)
    const waiting = await ensureHistoryDeliveryAutomation(id, options, deps)
    assert.equal(waiting.design.status, attempt < 3 ? 'queued' : 'failed')
    assert.equal(calls, attempt)
    t.mock.timers.tick(5000 * attempt)
  }
  assert.equal((await ensureHistoryDeliveryAutomation(id, options, deps)).design.status, 'failed')
  assert.equal(calls, 3)
  await ensureHistoryDeliveryAutomation(id, { ...options, retryFailed: true }, { ...dependencies,
    generate: async () => { calls++; throw Object.assign(new Error('response lost'), { code: 'ETIMEDOUT' }) } })
  await settled(id)
  t.mock.timers.tick(60000)
  assert.equal((await ensureHistoryDeliveryAutomation(id, options, deps)).design.status, 'failed')
  assert.equal(calls, 4)
})

test('only explicit temporary refusal, not a generic 503 or accepted task, qualifies for automatic packaging recovery',()=>{
  for(const message of ['API error 429: {"error":{"code":"gateway_concurrency_limit"}}',
    'Text model request failed: 429 Too many requests',
    'API error 503: {"error":{"code":"provider_overloaded"}}']) assert.equal(isHistoryPackagingRejection(message),true,message)
  for(const message of ['API error 503: Service unavailable','API error 503: {"error":{"code":"internal_error"}}',
    'API error 429: {"task_id":"accepted-task"}','API error 429: {"data":{"id":"accepted-task"}}',
    'API error 429: response timeout','[HISTORY_COVER_SUBMISSION_UNCERTAIN] API error 429: rejected',
    'Text model request failed: 504 Gateway timeout']) assert.equal(isHistoryPackagingRejection(message),false,message)
})

test('a rejected-only design retry reuses completed copy and refuses unknown failures',async()=>{
  const id=seed()
  let calls=0
  const deps={...dependencies,generate:async()=>{calls++;throw new Error('API error 429: {"error":{"code":"gateway_concurrency_limit"}}')}}
  await ensureHistoryDeliveryAutomation(id,options,deps);await settled(id)
  const failed=await ensureHistoryDeliveryAutomation(id,options,deps)
  assert.equal(failed.design.retryableRejection,true)
  assert.equal(calls,1)
  db.$client.prepare("UPDATE history_script_deliveries SET design_error='newer response lost' WHERE script_id=?").run(id)
  const stale=await ensureHistoryDeliveryAutomation(id,{...options,retryRejected:true},deps)
  assert.equal(stale.design.retryableRejection,false,'an old refused intent cannot authorize a newer unknown request')
  assert.equal(calls,1)
  db.$client.prepare('UPDATE history_script_deliveries SET design_error=? WHERE script_id=?').run(failed.design.message,id)
  await ensureHistoryDeliveryAutomation(id,{...options,retryRejected:true},{...dependencies,generate:async()=>{calls++;return proposal()}})
  await settled(id)
  await ensureHistoryDeliveryAutomation(id,{...options,retryRejected:true},{...dependencies,generate:async()=>assert.fail('completed copy is reused')})
  await settled(id)
  assert.equal(calls,2)
  db.$client.prepare("UPDATE history_script_deliveries SET title='',baijiahao_title='',description='',cover_design_json='{}',design_status='failed',design_error='response lost' WHERE script_id=?").run(id)
  db.$client.prepare("UPDATE history_delivery_design_intents SET phase='failed',message='response lost',retry_at=NULL WHERE script_id=?").run(id)
  const unknown=await ensureHistoryDeliveryAutomation(id,{...options,retryRejected:true},{...dependencies,generate:async()=>assert.fail('unknown request cannot repeat')})
  assert.equal(unknown.design.status,'failed')
  assert.equal(unknown.design.retryableRejection,false)
})

test('rejected-only cover retry checks every current orientation and preserves completed design',async()=>{
  const id=seed()
  await ensureHistoryDeliveryAutomation(id,options,dependencies);await settled(id)
  const delivery=getHistoryDelivery(id)
  const rejection='API error 429: {"error":{"code":"gateway_concurrency_limit"}}'
  db.$client.prepare("UPDATE history_script_deliveries SET cover_status='failed',error=? WHERE script_id=?").run(rejection,id)
  db.$client.exec(`CREATE TABLE IF NOT EXISTS history_cover_image_checkpoints (
    source_id INTEGER NOT NULL,script_sha256 TEXT NOT NULL,design_sha256 TEXT NOT NULL,frame_type TEXT NOT NULL,
    generation_id INTEGER NOT NULL,config_id INTEGER NOT NULL,config_sha256 TEXT NOT NULL,dispatch_state TEXT NOT NULL DEFAULT 'prepared',
    PRIMARY KEY(source_id,script_sha256,design_sha256,frame_type))`)
  const insert=(ratio:string,status:string,taskId:string|null,error:string|null,code:string|null)=>{
    const generationId=Number(db.$client.prepare(`INSERT INTO image_generations (status,task_id,error_msg,last_error_code,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).run(status,taskId,error,code,'before','before').lastInsertRowid)
    db.$client.prepare(`INSERT INTO history_cover_image_checkpoints
      (source_id,script_sha256,design_sha256,frame_type,generation_id,config_id,config_sha256,dispatch_state) VALUES(?,?,?,?,?,1,'config','submitted')`)
      .run(id,expectedScriptSha256,delivery.coverPlan!.design_sha256,ratio,generationId)
    return generationId
  }
  insert('4:3','completed','completed-remote-task',null,null)
  const failedId=insert('3:4','failed',null,rejection,'rate_limited')
  const deps={...dependencies,generate:async()=>assert.fail('successful design must be preserved'),generateCovers:async()=>assert.fail('no automatic call before explicit retry scheduling')}
  assert.equal((await ensureHistoryDeliveryAutomation(id,options,deps)).covers.retryableRejection,true)
  db.$client.prepare("UPDATE image_generations SET task_id='accepted-remote-task' WHERE id=?").run(failedId)
  const accepted=await ensureHistoryDeliveryAutomation(id,{...options,retryRejected:true},deps)
  assert.equal(accepted.covers.status,'failed')
  assert.equal(accepted.covers.retryableRejection,false)
  db.$client.prepare("UPDATE image_generations SET task_id=NULL,error_msg='API error 503: Service unavailable',last_error_code='provider_overloaded' WHERE id=?").run(failedId)
  assert.equal((await ensureHistoryDeliveryAutomation(id,{...options,retryRejected:true},deps)).covers.retryableRejection,false)
  db.$client.prepare('UPDATE image_generations SET error_msg=?,last_error_code=? WHERE id=?').run(rejection,'rate_limited',failedId)
  let generated=0
  const retried=await ensureHistoryDeliveryAutomation(id,{...options,retryRejected:true},{...deps,generateCovers:async(sourceId)=>{generated++;return generateCovers(sourceId)}})
  assert.equal(retried.covers.status,'generating')
  await settled(id)
  assert.equal(generated,1)
  assert.deepEqual(getHistoryDelivery(id).coverDesign, { main_title: '明朝冬季菜价',
    sub_title: '', kicker: '', ai_prompt: '', accent_color: '#FFFFFF', thumbnail_layout: 'text-left', highlight_text: '' })
  assert.equal(getHistoryDelivery(id).coverStatus,'completed')
})
