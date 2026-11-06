import test, { after, beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import puppeteer from 'puppeteer-core'
import type { CoverPromptEnhanceResult } from './cover-prompt-enhance.js'

const root = mkdtempSync(join(tmpdir(), 'history-delivery-test-'))
process.env.DB_PATH = join(root, 'test.db')
process.env.STORAGE_PATH = root
process.env.TASK_WORKER_DISABLED = '1'
process.env.IMAGE_PROXY_ENABLED_PROVIDERS = 'none'
process.env.IMAGE_GENERATION_INTERVAL_MS = '1'
const { db, schema } = await import('../db/index.js')
const { getHistoryProductionGate } = await import('./history-production-gate.js')
const productionGate = getHistoryProductionGate(db.$client)
const { storeHistorySource, updateHistorySource, getHistorySource } = await import('./history-script-library.js')
const { attachHistoryVideo, attachHistoryVideoFile, getHistoryDelivery, saveHistoryDelivery, startHistoryCovers, startHistoryCoverDesign, probeFinishedVideo, suggestHistoryCover, reviewHistoryCover } = await import('./history-script-delivery.js')
const { createHistoryDeliveryRoute } = await import('../routes/history-script-delivery.js')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const coverDesign = { main_title: '北京打工人', sub_title: '', kicker: '', ai_prompt: 'A historical Beijing market', accent_color: '#D7A649' }
const screenshotDesign = (title = 'Beijing wages') => ({ ...coverDesign, main_title: title, ai_prompt: '', thumbnail_layout: 'text-left', highlight_text: '' })
const originalScreenshotDesign = (title = 'Beijing wages') => ({ ...screenshotDesign(title), accent_color: '#FFFFFF' })
const covers = { '3:4': 'static/portrait.png', '4:3': 'static/landscape.png', '16:9': 'static/wide.png' }
const bytes = (value = 'finished video') => new Blob([value]).stream()
const options = { root, probe: async () => 12 }

beforeEach(() => {
  db.$client.prepare('DELETE FROM history_script_deliveries').run()
  db.delete(schema.historyScriptSources).run()
})
after(() => { db.$client.close(); rmSync(root, { recursive: true, force: true }) })

function seed(sourceVideoId = '7395681234567890123') {
  const source = storeHistorySource({ sourceVideoId, title: 'Beijing wages', category: 'regional_history', metrics: {}, selection: { reason: 'test', observedAt: '2026-10-14T08:00:00Z', comments: [] } })
  draft(source.id)
  return source.id
}
function draft(id: number, rewrittenScript = 'A complete current historical script') {
  const rawTranscript = 'Raw narration'
  const correctedTranscript = 'Corrected narration'
  updateHistorySource(id, {
    status: 'needs_review', rawTranscript, correctedTranscript, rewrittenScript,
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 12, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text: rawTranscript, sourceVideoSha256: '1'.repeat(64), chunks: [{ index: 0, start: 0, duration: 12, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ correctedTranscript, corrections: [], factualConcerns: [], factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(rawTranscript), correctedTranscriptSha256: hash(correctedTranscript), rewriteInputSha256: hash(correctedTranscript) }),
  })
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
async function waitForCovers(id: number, timeoutMs = 7000, videoId?: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const delivery = getHistoryDelivery(id, videoId)
    if (delivery.coverStatus !== 'generating') return delivery
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('The background cover job did not reach a terminal state')
}
async function waitForDesign(id: number) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const delivery = getHistoryDelivery(id)
    if (delivery.designStatus !== 'generating') return delivery
    await flush()
  }
  assert.fail('The background title job did not reach a terminal state')
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const proposal = {
  main_title: '明朝宫廷冬天的韭菜有多贵？', sub_title: '一斤抵普通工人五天工钱', kicker: '万历年间',
  image_prompt: 'Ming palace winter kitchen, cinematic, no text, no watermark',
  enhanced_prompt: '明朝宫廷冬季菜价', accent_color: '#D7A649', rationale: '用正文能回答的价格问题引发好奇。',
}
const publishingCopy = { video_title: proposal.main_title, baijiahao_title: '明朝宫廷一斤韭菜抵五天工钱：冬季买菜为何这么贵？', video_description: '买一斤宫廷韭菜，竟抵普通工人五天工钱？冬季采购这笔账，究竟贵在哪？ #历史冷知识' }
function reviewedResult(design: typeof proposal = proposal, script = 'A complete current historical script'): CoverPromptEnhanceResult {
  const completeDesign = { ...design, enhanced_prompt: design.enhanced_prompt || '历史市场画面构思', rationale: design.rationale || '由正文支持的问题引发求知欲。' }
  const copy = { ...publishingCopy, video_title: completeDesign.main_title }
  return {
    ...completeDesign, ...copy,
    editorial_plan: {
      version: 'history-cover-plan-v1', selected_id: 'question', selection_reason: '问题具体，正文有价格和范围依据。',
      candidates: [{ ...completeDesign, ...copy, id: 'question', method: '具体疑问', why_click: '日常蔬菜与宫廷采购价格产生落差。',
        viewer_question: '宫廷冬天采购韭菜为什么这么贵？', payoff: '了解宫廷冬季菜价与普通人工资的对比。',
        evidence: [script], visual_concept: '明朝宫廷冬季厨房，采购者查看一篮韭菜，上方留白。' }],
      reviews: [{ candidate_id: 'question', natural: true, understandable: true, curiosity: true,
        faithful: true, visual_faithful: true, coherent: true, reason: '中文自然，问题明确，原文支持承诺。' }],
    },
  }
}
function selectedResult(design: typeof proposal = proposal, script = 'A complete current historical script'): CoverPromptEnhanceResult {
  const result = reviewedResult(design, script)
  result.editorial_plan = { ...result.editorial_plan!, publishing_version: 'platform-v1', selection_mode: 'curiosity', reviews: [],
    title_fallback: 'no_references', title_research: {
      searched_at: '2026-10-21T08:00:00.000Z', keywords: [['宫廷', '韭菜'], ['冬季', '工钱']],
      queries: [
        { platform: 'toutiao', query: 'site:toutiao.com 宫廷 韭菜', status: 'empty' },
        { platform: 'baijiahao', query: 'site:baijiahao.baidu.com 宫廷 韭菜', status: 'empty' },
        { platform: 'toutiao', query: 'site:toutiao.com 冬季 工钱', status: 'empty' },
        { platform: 'baijiahao', query: 'site:baijiahao.baidu.com 冬季 工钱', status: 'empty' },
      ], references: [],
    } }
  return result
}
const suggestedCover = selectedResult()
async function approveDesign(id: number) {
  return reviewHistoryCover(id, { coverDesign }, async (_input, design) => reviewedResult(design, getHistorySource(id)!.rewrittenScript!))
}

for (const entry of ['manual', 'background'] as const) {
  test(`${entry} design waits for the shared project gate and holds its slot through package persistence`, { timeout: 7000 }, async t => {
    const id = seed()
    const otherId = seed('7395681234567890124')
    const blockerId = seed('7395681234567890125')
    assert.equal(productionGate.tryAcquire(otherId, 'test:article'), true)
    assert.equal(productionGate.tryAcquire(blockerId, 'test:export'), true)
    const entered = deferred<void>()
    const pending = deferred<CoverPromptEnhanceResult>()
    let calls = 0
    let dispatched = 0
    let savedBeforeRelease = false
    let ownKey: string | undefined
    const release = productionGate.release.bind(productionGate)
    t.mock.method(productionGate, 'release', (key: string) => {
      if (key === ownKey) {
        savedBeforeRelease = getHistoryDelivery(id).title === publishingCopy.baijiahao_title
          && productionGate.isActive(id)
      }
      release(key)
    })
    if (entry === 'background') t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-10-21T08:00:00Z') })
    const generate = async () => {
      calls++
      assert.equal(productionGate.isActive(id), true)
      entered.resolve()
      return pending.promise
    }
    let work: Promise<unknown>
    if (entry === 'manual') work = suggestHistoryCover(id, generate)
    else {
      const completed = deferred<void>()
      startHistoryCoverDesign(id, generate, { beforeDispatch() {
        assert.equal(productionGate.isActive(id), true)
        dispatched++
      }, completed() { completed.resolve() }, failed(_runId, error) { completed.reject(error as Error) } })
      work = completed.promise
    }
    void work.catch(() => {}) // Cleanup below awaits and reports any rejected work.
    try {
      await flush()
      assert.equal(calls, 0, 'A queued design must not dispatch any part of its generator')
      assert.equal(dispatched, 0)
      assert.deepEqual(productionGate.overview(), { limit: 2, activeProjects: 2, waitingProjects: 1 })
      ownKey = (db.$client.prepare('SELECT key FROM history_production_reservations WHERE source_id=?').get(id) as { key: string }).key
      assert.match(ownKey, /^design:/)
      if (entry === 'background') {
        const runId = getHistoryDelivery(id).designRunId
        assert.equal(ownKey, `design:${runId}`)
        for (let tick = 0; tick < 3; tick++) {
          t.mock.timers.tick(90000)
          assert.equal(getHistoryDelivery(id).designStatus, 'generating')
          assert.equal(getHistoryDelivery(id).designRunId, runId)
        }
        assert.equal(calls, 0, 'Waiting heartbeats must not dispatch the generator')
      }
      productionGate.release('test:export')
      await entered.promise
      assert.equal(dispatched, entry === 'background' ? 1 : 0)
      assert.equal(getHistoryDelivery(id).title, '')
      assert.deepEqual(productionGate.overview(), { limit: 2, activeProjects: 2, waitingProjects: 0 })
      assert.equal(productionGate.tryAcquire(id, 'test:same-source-article'), true, 'Branches of the same project share one slot')
      pending.resolve(suggestedCover)
      await work
      assert.equal(savedBeforeRelease, true, 'The generated package must be saved before releasing the design slot')
      assert.equal(productionGate.isActive(id), true, 'Finishing design must not release its sibling article reservation')
      productionGate.release('test:same-source-article')
      assert.equal(productionGate.isActive(id), false)
    } finally {
      productionGate.release('test:article')
      productionGate.release('test:export')
      productionGate.release('test:same-source-article')
      pending.resolve(suggestedCover)
      await work
    }
    assert.deepEqual(productionGate.overview(), { limit: 2, activeProjects: 0, waitingProjects: 0 })
  })
}

for (const change of ['script', 'provenance', 'title', 'manual-edit', 'expired-run', 'replaced-run'] as const) {
  test(`a queued design rejects ${change} changes before lifecycle dispatch or generation`, { timeout: 7000 }, async () => {
    const id = seed()
    productionGate.tryAcquire(id + 10000, 'test:first')
    productionGate.tryAcquire(id + 10001, 'test:second')
    let calls = 0
    let dispatched = 0
    const finished = deferred<unknown>()
    const started = startHistoryCoverDesign(id, async () => { calls++; return suggestedCover }, {
      beforeDispatch() { dispatched++ }, completed() { finished.resolve(undefined) }, failed(_runId, error) { finished.resolve(error) },
    })
    try {
      await flush()
      if (change === 'script') draft(id, 'Updated while waiting for a production slot')
      if (change === 'provenance') updateHistorySource(id, { rawTranscript: 'Changed source transcript' })
      if (change === 'title') updateHistorySource(id, { title: 'Changed source title' })
      if (change === 'manual-edit') saveHistoryDelivery(id, { description: 'Manual copy edited while queued' })
      if (change === 'expired-run') db.$client.prepare("UPDATE history_script_deliveries SET design_lease_until='2000-01-01T00:00:00Z' WHERE script_id=?").run(id)
      if (change === 'replaced-run') db.$client.prepare("UPDATE history_script_deliveries SET design_run_id='replacement-run' WHERE script_id=?").run(id)
      productionGate.release('test:first')
      // Expired/replaced runs intentionally do not own the failure callback.
      while (db.$client.prepare('SELECT 1 FROM history_production_reservations WHERE key=?').get(`design:${started.designRunId}`)) await flush()
      await flush()
      assert.equal(calls, 0)
      assert.equal(dispatched, 0)
      const result = getHistoryDelivery(id)
      assert.equal(result.title, '')
      if (change === 'replaced-run') assert.equal(result.designRunId, 'replacement-run')
      else {
        assert.equal(result.designStatus, 'failed')
        if (change !== 'expired-run') assert.equal((await finished.promise as { status: number }).status, 409)
      }
    } finally {
      productionGate.release('test:first')
      productionGate.release('test:second')
      await flush()
    }
    assert.deepEqual(productionGate.overview(), { limit: 2, activeProjects: 0, waitingProjects: 0 })
  })
}

test('a failed design releases its shared slot for the next project', async () => {
  const id = seed()
  await assert.rejects(suggestHistoryCover(id, async () => {
    assert.equal(productionGate.isActive(id), true)
    throw new Error('Generator unavailable')
  }), /Generator unavailable/)
  assert.deepEqual(productionGate.overview(), { limit: 2, activeProjects: 0, waitingProjects: 0 })
  assert.equal((await suggestHistoryCover(id, async () => suggestedCover)).title, publishingCopy.baijiahao_title)
})

test('background title generation survives a refreshed delivery read and persists its final package', async () => {
  const id = seed()
  assert.equal(getHistoryDelivery(id).designStatus, 'idle')
  let finish!: (result: CoverPromptEnhanceResult) => void
  const pending = new Promise<CoverPromptEnhanceResult>(resolve => { finish = resolve })
  try {
    const started = startHistoryCoverDesign(id, () => pending)
    assert.equal(started.designStatus, 'generating')
    assert.ok(started.designRunId)
    assert.equal(started.designError, null)
    assert.equal(started.title, '')
    assert.deepEqual(getHistoryDelivery(id), started)
  } finally {
    finish(suggestedCover)
    await waitForDesign(id)
  }
  const completed = getHistoryDelivery(id)
  assert.equal(completed.designStatus, 'completed')
  assert.equal(completed.designRunId, null)
  assert.equal(completed.designError, null)
  assert.equal(completed.title, publishingCopy.baijiahao_title)
  assert.equal(completed.coverDesign.main_title, suggestedCover.main_title)
  assert.equal(completed.description, publishingCopy.video_description)
  assert.equal(completed.baijiahaoTitle, publishingCopy.baijiahao_title)
  assert.equal(completed.coverPlanStatus, 'selected')
  assert.deepEqual(completed.coverPlan?.reviews, [])
})

test('an active title job rejects duplicate generation and conflicting cover operations without a second provider call', async () => {
  const id = seed()
  saveHistoryDelivery(id, { coverDesign })
  const pending = deferred<CoverPromptEnhanceResult>()
  let calls = 0
  const generate = () => { calls++; return pending.promise }
  try {
    const started = startHistoryCoverDesign(id, generate)
    assert.throws(() => startHistoryCoverDesign(id, generate), { status: 409 })
    assert.throws(() => startHistoryCovers(id, {}, async () => {
      assert.fail('An active title job must not start cover-image generation')
    }), { status: 409 })
    await assert.rejects(reviewHistoryCover(id, {}, async () => {
      assert.fail('An active title job must not start a manual plan review')
    }), { status: 409 })
    await flush()
    assert.equal(calls, 1)
    assert.deepEqual(getHistoryDelivery(id), started)
  } finally {
    pending.resolve(suggestedCover)
    await waitForDesign(id)
  }
})

test('background title generation persists its failure without replacing the previous delivery package', async () => {
  const id = seed()
  const previous = await suggestHistoryCover(id, async () => suggestedCover)
  const pending = deferred<CoverPromptEnhanceResult>()
  startHistoryCoverDesign(id, () => pending.promise)
  pending.reject(new Error('标题改写输出被截断，未覆盖原方案'))
  const failed = await waitForDesign(id)
  assert.equal(failed.designStatus, 'failed')
  assert.equal(failed.designRunId, null)
  assert.match(failed.designError!, /标题改写输出被截断/)
  assert.deepEqual({ ...failed, designStatus: previous.designStatus, designError: previous.designError }, previous)
  assert.deepEqual(getHistoryDelivery(id), failed)
})

test('a manual edit made immediately after submission cannot be overwritten by the background title result', async () => {
  const id = seed()
  saveHistoryDelivery(id, { coverDesign })
  const pending = deferred<CoverPromptEnhanceResult>()
  startHistoryCoverDesign(id, () => pending.promise)
  const edited = saveHistoryDelivery(id, { title: '用户刚保存的标题', description: '用户刚保存的简介' })
  assert.equal(edited.designStatus, 'generating')
  pending.resolve(suggestedCover)
  const failed = await waitForDesign(id)
  assert.equal(failed.designStatus, 'failed')
  assert.match(failed.designError!, /已修改/)
  assert.equal(failed.title, '用户刚保存的标题')
  assert.equal(failed.coverDesign.main_title, coverDesign.main_title)
  assert.equal(failed.baijiahaoTitle, failed.title)
  assert.equal(failed.description, '用户刚保存的简介')
  assert.deepEqual(failed.coverPlan, edited.coverPlan)
})

test('a Baijiahao-only edit during background generation preserves the entire manual package', async () => {
  const id = seed()
  await suggestHistoryCover(id, async () => suggestedCover)
  const pending = deferred<CoverPromptEnhanceResult>()
  startHistoryCoverDesign(id, () => pending.promise)
  const edited = saveHistoryDelivery(id, { baijiahaoTitle: '用户单独修改百家号标题：为何一斤韭菜要五天工钱？' })
  pending.resolve(suggestedCover)
  const failed = await waitForDesign(id)
  assert.equal(failed.designStatus, 'failed')
  assert.match(failed.designError!, /已修改/)
  assert.equal(failed.baijiahaoTitle, edited.baijiahaoTitle)
  assert.equal(failed.title, edited.title)
  assert.equal(failed.description, edited.description)
})

test('script mutations made immediately after submission invalidate the frozen background title input', async () => {
  const id = seed()
  const previous = saveHistoryDelivery(id, { coverDesign, description: '保留旧简介' })
  const pending = deferred<CoverPromptEnhanceResult>()
  let generatedScript: string | undefined
  startHistoryCoverDesign(id, input => { generatedScript = input.episodeContent; return pending.promise })
  draft(id, 'A newer historical script saved before the generator begins')
  pending.resolve(suggestedCover)
  const failed = await waitForDesign(id)
  assert.equal(generatedScript, undefined, 'Stale queued input must never reach the generator')
  assert.equal(failed.designStatus, 'failed')
  assert.match(failed.designError!, /脚本已修改/)
  assert.equal(failed.title, previous.title)
  assert.equal(failed.description, previous.description)
  assert.deepEqual(failed.coverDesign, previous.coverDesign)
})

test('heartbeats keep a long title job visible without reviving an already expired lease', async t => {
  const id = seed()
  const pending = deferred<CoverPromptEnhanceResult>()
  const expiredPending = deferred<CoverPromptEnhanceResult>()
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-10-21T08:00:00Z') })
  try {
    const started = startHistoryCoverDesign(id, () => pending.promise)
    await flush()
    for (let elapsed = 0; elapsed < 3; elapsed++) {
      t.mock.timers.tick(90000)
      assert.equal(getHistoryDelivery(id).designStatus, 'generating')
      assert.equal(getHistoryDelivery(id).designRunId, started.designRunId)
    }
    pending.resolve(suggestedCover)
    await flush()
    const completed = getHistoryDelivery(id)
    assert.equal(completed.designStatus, 'completed')
    assert.equal(completed.designRunId, null)
    assert.equal(completed.designError, null)
    t.mock.timers.tick(180000)
    assert.deepEqual(getHistoryDelivery(id), completed)
    startHistoryCoverDesign(id, () => expiredPending.promise)
    await flush()
    db.$client.prepare("UPDATE history_script_deliveries SET design_lease_until='2000-01-01T00:00:00Z' WHERE script_id=?").run(id)
    t.mock.timers.tick(30000)
    const expired = getHistoryDelivery(id)
    assert.equal(expired.designStatus, 'failed')
    assert.equal(expired.designRunId, null)
    expiredPending.resolve(suggestedCover)
    await flush()
    assert.deepEqual(getHistoryDelivery(id), expired)
  } finally {
    pending.resolve(suggestedCover)
    expiredPending.resolve(suggestedCover)
    await flush()
  }
})

for (const lateOutcome of ['success', 'failure']) {
  test(`an expired title job's late ${lateOutcome} cannot overwrite a replacement run or its package`, async () => {
    const id = seed()
    const old = deferred<CoverPromptEnhanceResult>()
    const next = deferred<CoverPromptEnhanceResult>()
    try {
      const initial = startHistoryCoverDesign(id, () => old.promise)
      await flush()
      db.$client.prepare("UPDATE history_script_deliveries SET design_lease_until='2000-01-01T00:00:00Z' WHERE script_id=?").run(id)
      const expired = getHistoryDelivery(id)
      assert.equal(expired.designStatus, 'failed')
      assert.equal(expired.designRunId, null)
      assert.ok(expired.designError)
      const started = startHistoryCoverDesign(id, () => next.promise)
      assert.notEqual(started.designRunId, initial.designRunId)
      assert.equal(started.designError, null)
      if (lateOutcome === 'success') old.resolve(suggestedCover)
      else old.reject(new Error('A superseded writer failed late'))
      await flush()
      assert.deepEqual(getHistoryDelivery(id), started)
      const replacement = selectedResult({ ...proposal, main_title: '一斤韭菜为何抵五天工钱？' })
      next.resolve(replacement)
      const completed = await waitForDesign(id)
      assert.equal(completed.designStatus, 'completed')
      assert.equal(completed.title, replacement.baijiahao_title)
      assert.equal(completed.coverDesign.main_title, replacement.main_title)
      assert.equal(completed.designError, null)
      assert.deepEqual(getHistoryDelivery(id), completed)
    } finally {
      old.resolve(suggestedCover)
      next.resolve(suggestedCover)
      await waitForDesign(id)
      await flush()
    }
  })
}

test('title generation permits independent video upload and keeps the uploaded video when its package completes', async () => {
  const id = seed()
  const pending = deferred<CoverPromptEnhanceResult>()
  try {
    startHistoryCoverDesign(id, () => pending.promise)
    const uploaded = await attachHistoryVideo(id, bytes(), 'while-generating.mp4', options)
    assert.equal(uploaded.designStatus, 'generating')
    assert.ok(uploaded.videoUrl)
    pending.resolve(suggestedCover)
    const completed = await waitForDesign(id)
    assert.equal(completed.designStatus, 'completed')
    assert.equal(completed.videoUrl, uploaded.videoUrl)
    assert.equal(completed.videoName, uploaded.videoName)
    assert.equal(completed.title, publishingCopy.baijiahao_title)
  } finally {
    pending.resolve(suggestedCover)
    await waitForDesign(id)
  }
})

test('title jobs reject missing or stale scripts and active cover-image jobs before generation starts', async () => {
  let called = false
  const generate = async () => { called = true; return suggestedCover }
  assert.throws(() => startHistoryCoverDesign(99999, generate), { status: 404 })
  const id = seed()
  const pending = deferred<typeof covers>()
  try {
    startHistoryCovers(id, { coverDesign }, () => pending.promise)
    assert.throws(() => startHistoryCoverDesign(id, generate), { status: 409 })
  } finally {
    pending.resolve(covers)
    await flush()
  }
  updateHistorySource(id, { rawTranscript: 'New original transcript invalidates rewritten provenance' })
  assert.throws(() => startHistoryCoverDesign(id, generate), { status: 409 })
  assert.equal(called, false)
})

test('manual publishing and cover titles normalize independently while legacy description punctuation stays unchanged', () => {
  const id = seed()
  const design = { ...coverDesign, main_title: '明朝,皇帝，怎么了？' }
  const saved = saveHistoryDelivery(id, { title: '明朝,皇帝，怎么了？', description: '竟然这样，为什么！', coverDesign: design })
  assert.equal(saved.title, '明朝 皇帝 怎么了？')
  assert.equal(saved.description, '竟然这样，为什么！')
  assert.deepEqual(saved.coverDesign, { ...design, main_title: '明朝 皇帝 怎么了？' })
  assert.equal(getHistoryDelivery(id).title, '明朝 皇帝 怎么了？')
})

test('only Baijiahao length limits warn without discarding saved draft text or old descriptions', () => {
  const id = seed()
  const title = '晋'.repeat(15) + '？'
  const baijiahaoTitle = '晋'.repeat(39) + '？'
  const description = '完整视频号描述，保留标点和信息。'.repeat(350)
  assert.ok(description.length > 4000)
  const saved = saveHistoryDelivery(id, { title, baijiahaoTitle, description })
  assert.equal(saved.title, baijiahaoTitle)
  assert.equal(saved.coverDesign.main_title, undefined)
  assert.equal(saved.baijiahaoTitle, baijiahaoTitle)
  assert.equal(saved.description, description)
  assert.deepEqual(saved.publishingWarnings, [])
  assert.deepEqual(getHistoryDelivery(id), saved)
  const overlong = saveHistoryDelivery(id, { title: title + '？', baijiahaoTitle: baijiahaoTitle + '？' })
  assert.equal(overlong.title, baijiahaoTitle + '？')
  assert.equal(overlong.coverDesign.main_title, undefined)
  assert.equal(overlong.baijiahaoTitle, baijiahaoTitle + '？')
  assert.deepEqual(overlong.publishingWarnings, [
    '百家号标题共41字，超过40字上限，请在发布前修改。',
  ])
  assert.deepEqual(getHistoryDelivery(id), overlong)
  const unsupported = saveHistoryDelivery(id, { title, baijiahaoTitle: '百家号！标题' })
  assert.equal(unsupported.baijiahaoTitle, '百家号！标题')
  assert.equal(unsupported.publishingWarnings.length, 1)
  assert.match(unsupported.publishingWarnings[0]!, /不支持/)
  const normalized = saveHistoryDelivery(id, { baijiahaoTitle: '圈地运动，农民失地,为何走向工厂？' })
  assert.equal(normalized.baijiahaoTitle, '圈地运动 农民失地 为何走向工厂？')
  assert.equal(normalized.title, normalized.baijiahaoTitle)
  assert.deepEqual(normalized.publishingWarnings, [])
})

test('Baijiahao title is canonical while cover edits remain independent', () => {
  const id = seed()
  const first = saveHistoryDelivery(id, { title: '明朝皇帝怎么这么离谱' })
  assert.equal(first.baijiahaoTitle, '明朝皇帝怎么这么离谱')
  assert.equal(first.coverDesign.main_title, undefined)
  const second = saveHistoryDelivery(id, { coverDesign: { ...coverDesign, main_title: '修仙的没亡国，勤政的却亡了' } })
  assert.equal(second.title, first.title)
  assert.equal(second.coverDesign.main_title, '修仙的没亡国 勤政的却亡了')
  const third = saveHistoryDelivery(id, { title: '兼容旧字段标题', baijiahaoTitle: '以百家号标题为准', coverDesign })
  assert.equal(third.title, '以百家号标题为准')
  assert.equal(third.baijiahaoTitle, third.title)
  assert.deepEqual(third.coverDesign, coverDesign)
  assert.deepEqual(getHistoryDelivery(id), third)
})

test('saving a legacy description retains its distinct publishing title, cover text and historical review', async () => {
  const id = seed()
  const approved = await approveDesign(id)
  db.$client.prepare('UPDATE history_script_deliveries SET title=? WHERE script_id=?').run('旧视频标题与封面不同', id)
  const legacy = getHistoryDelivery(id)
  assert.notEqual(legacy.title, legacy.coverDesign.main_title)
  const saved = saveHistoryDelivery(id, { description: '更新旧简介不改封面主标题' })
  assert.equal(saved.title, legacy.baijiahaoTitle || legacy.title)
  assert.equal(saved.coverDesign.main_title, '北京打工人')
  assert.deepEqual(saved.coverPlan, approved.coverPlan)
  assert.deepEqual(getHistoryDelivery(id), saved)
})

test('regenerating an unchanged legacy publishing title migrates to the original-title screenshot plan', async () => {
  const id = seed()
  saveHistoryDelivery(id, { coverDesign })
  const input = { title: '独立视频发布标题', coverDesign }
  const reviewed = await reviewHistoryCover(id, input, async (_input, design) => {
    assert.equal(design.main_title, coverDesign.main_title)
    return reviewedResult(design)
  })
  assert.equal(reviewed.title, input.title)
  assert.equal(reviewed.baijiahaoTitle, input.title)
  startHistoryCovers(id, input, async (_id, design) => {
    assert.deepEqual(design, originalScreenshotDesign())
    return covers
  })
  const completed = await waitForCovers(id)
  assert.equal(completed.coverStatus, 'completed')
  assert.equal(completed.title, 'Beijing wages')
  assert.deepEqual(completed.coverDesign, originalScreenshotDesign())
  assert.equal(completed.coverPlanStatus, 'selected')
  assert.equal(completed.coverPlan?.publishing_version, 'source-screenshot-v3')
})

test('screenshot generation synchronizes publication aliases and replaces legacy independent cover wording', async () => {
  const id = seed()
  saveHistoryDelivery(id, { coverDesign })
  const reviewed = await reviewHistoryCover(id, { title: '明朝,房租贵不贵？' }, async (_input, design) => {
    assert.equal(design.main_title, coverDesign.main_title)
    return reviewedResult(design)
  })
  assert.equal(reviewed.title, '明朝 房租贵不贵？')
  assert.equal(reviewed.baijiahaoTitle, reviewed.title)
  assert.equal(reviewed.coverDesign.main_title, coverDesign.main_title)
  const started = startHistoryCovers(id, { title: '修仙的没亡国，勤政的却亡了' }, async (_id, design) => {
    assert.equal(design.main_title, '修仙的没亡国 勤政的却亡了')
    return covers
  })
  assert.equal(started.title, '修仙的没亡国 勤政的却亡了')
  assert.equal(started.baijiahaoTitle, started.title)
  assert.equal(started.coverDesign.main_title, started.title)
  await flush()
  assert.equal(getHistoryDelivery(id).coverStatus, 'completed')
  assert.equal(getHistoryDelivery(id).coverPlanStatus, 'outdated')
})

test('manual title editing retains unsupported symbols and exposes warnings until corrected', () => {
  const id = seed()
  for (const symbol of '《》〈〉“”‘’「」『』"\':：+＋?？%％℃') {
    const title = `明${symbol}朝`
    const saved = saveHistoryDelivery(id, { title })
    assert.equal(saved.title, title)
    assert.deepEqual(saved.publishingWarnings, [])
  }
  for (const title of ['明朝！', '明朝。', '明朝、', '明朝；', '明朝（皇帝）', '【明朝】', '明朝#历史', '明朝/皇帝', '明朝_皇帝', '明朝·皇帝', '明朝—皇帝', '明朝…', '明朝🔥', '明朝\u200b皇帝', '明朝\u202e皇帝', '明朝\n皇帝', '明朝\t皇帝']) {
    const saved = saveHistoryDelivery(id, { title })
    assert.equal(saved.title, title)
    assert.equal(saved.baijiahaoTitle, title)
    assert.equal(saved.coverDesign.main_title, undefined)
    assert.equal(saved.publishingWarnings.length, 1)
    assert.match(saved.publishingWarnings[0]!, /不支持/)
    assert.deepEqual(getHistoryDelivery(id), saved)
  }
  const cleared = saveHistoryDelivery(id, { title: '' })
  assert.equal(cleared.title, '', 'An unfinished draft may still clear its title')
  assert.deepEqual(cleared.publishingWarnings, [])
})

test('the delivery route saves either publication alias with an editable symbol warning and an independent cover', async () => {
  const id = seed()
  saveHistoryDelivery(id, { title: '已保存标题', coverDesign })
  const app = new Hono()
  app.route('/history-scripts/:id/delivery', createHistoryDeliveryRoute())
  for (const body of [{ title: '明朝！' }, { baijiahaoTitle: '明朝！' }]) {
    const response = await app.request(`/history-scripts/${id}/delivery`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    const saved = (await response.json()).data
    assert.equal(saved.title, '明朝！')
    assert.equal(saved.baijiahaoTitle, '明朝！')
    assert.equal(saved.coverDesign.main_title, coverDesign.main_title)
    assert.match(saved.publishingWarnings[0], /不支持/)
    assert.deepEqual(getHistoryDelivery(id), saved)
  }
})

test('platform warnings do not prevent cover generation or an explicitly requested manual review', async () => {
  const id = seed()
  const title = '明朝宫廷冬季一斤韭菜究竟为何抵得上工人五天工钱！'
  const baijiahaoTitle = '宫廷'.repeat(21) + '！'
  const design = { ...coverDesign, main_title: title }
  const reviewed = await reviewHistoryCover(id, { title, baijiahaoTitle, coverDesign: design }, async (_input, fixed) => {
    assert.equal(fixed.main_title, title)
    return reviewedResult(fixed)
  })
  assert.equal(reviewed.title, baijiahaoTitle)
  assert.equal(reviewed.baijiahaoTitle, baijiahaoTitle)
  assert.equal(reviewed.publishingWarnings.length, 2)
  const editedTitle = '宫廷'.repeat(20) + '工钱！'
  const started = startHistoryCovers(id, { title: editedTitle }, async (_id, actual) => {
    assert.equal(actual.main_title, editedTitle)
    return covers
  })
  assert.equal(started.coverStatus, 'generating')
  assert.deepEqual(started.publishingWarnings, reviewed.publishingWarnings)
  await flush()
  const finished = getHistoryDelivery(id)
  assert.equal(finished.coverStatus, 'completed')
  assert.equal(finished.title, editedTitle)
  assert.deepEqual(finished.publishingWarnings, reviewed.publishingWarnings)
})

test('legacy reviewed candidate titles remain readable verbatim after the symbol policy changes', async () => {
  const id = seed()
  const approved = await reviewHistoryCover(id, { coverDesign }, async (_input, design) => {
    const result = reviewedResult(design)
    result.editorial_plan!.candidates[0]!.video_title = '旧标题，带感叹号！'
    return result
  })
  assert.equal(approved.coverPlanStatus, 'approved')
  assert.equal(getHistoryDelivery(id).coverPlan?.candidates[0]!.video_title, '旧标题，带感叹号！')
})

test('automatic cover suggestions persist the selected plan without requesting editorial review', async () => {
  const id = seed()
  const saved = await suggestHistoryCover(id, async input => {
    assert.equal(input.editorialReview, undefined)
    assert.equal(input.publishingCopy, true)
    assert.equal(input.sourceTitle, getHistorySource(id)!.title)
    assert.equal(input.episodeContent, getHistorySource(id)!.rewrittenScript)
    return suggestedCover
  })
  assert.deepEqual(saved.coverDesign, {
    main_title: suggestedCover.main_title, sub_title: suggestedCover.sub_title, kicker: suggestedCover.kicker,
    ai_prompt: suggestedCover.image_prompt, accent_color: suggestedCover.accent_color,
  })
  assert.equal(saved.coverPlanStatus, 'selected')
  assert.equal(saved.coverPlan?.selection_mode, 'curiosity')
  assert.deepEqual(saved.coverPlan?.reviews, [])
  assert.equal(saved.title, publishingCopy.baijiahao_title)
  assert.equal(saved.description, publishingCopy.video_description)
  assert.deepEqual(saved.coverPlan?.candidates[0]?.evidence, ['A complete current historical script'])
  assert.equal(saved.coverPlan?.candidates[0]?.why_click, suggestedCover.editorial_plan!.candidates[0]!.why_click)
  assert.equal(saved.coverPlan?.script_sha256, hash(getHistorySource(id)!.rewrittenScript!))
  assert.ok(saved.coverPlan?.design_sha256)
  assert.deepEqual(getHistoryDelivery(id), saved)
  const stored = db.$client.prepare('SELECT cover_design_json FROM history_script_deliveries WHERE script_id=?').get(id) as { cover_design_json: string }
  assert.deepEqual(JSON.parse(stored.cover_design_json).editorial_plan, saved.coverPlan)
})

test('the source-title workflow persists one canonical publishing title and an independent cover without a WeChat description', async () => {
  const id = seed()
  const title = 'Beijing wages 有何不同？'
  const result = reviewedResult({ ...proposal, main_title: '北京工钱' })
  Object.assign(result, { video_title: title, baijiahao_title: title, video_description: '' })
  Object.assign(result.editorial_plan!.candidates[0]!, { video_title: title, baijiahao_title: title, video_description: '' })
  Object.assign(result.editorial_plan!, { publishing_version: 'source-title-v2', selection_mode: 'source-title', reviews: [],
    source_title_rewrite: { method: 'source-title-rewrite-v2', source_title: 'Beijing wages', cleaned_title: 'Beijing wages', title,
      keywords: [{ text: 'Beijing wages', kind: 'topic' }], removed_promotions: [], protected_numbers: [] } })
  const saved = await suggestHistoryCover(id, async input => {
    assert.equal(input.sourceTitle, 'Beijing wages')
    assert.equal(input.publishingCopy, true)
    return result
  })
  assert.equal(saved.title, title)
  assert.equal(saved.baijiahaoTitle, title)
  assert.equal(saved.coverDesign.main_title, '北京工钱')
  assert.equal(saved.description, '')
  assert.equal(saved.coverPlanStatus, 'selected')
  assert.equal(saved.coverPlan!.source_title_rewrite!.source_title, 'Beijing wages')
  assert.deepEqual(getHistoryDelivery(id), saved)
})

test('failed automatic generation preserves the previous cover proposal and delivery metadata', async () => {
  const id = seed()
  const previous = saveHistoryDelivery(id, { description: '原有介绍', coverDesign })
  await assert.rejects(suggestHistoryCover(id, async () => {
    throw new Error('封面方案生成失败，未覆盖原方案：模型返回格式不完整')
  }), /封面方案生成失败/)
  assert.deepEqual(getHistoryDelivery(id), previous)
})

test('script changes during proposal generation reject with 409 and preserve the previous design', async () => {
  const id = seed()
  const previous = saveHistoryDelivery(id, { coverDesign })
  await assert.rejects(suggestHistoryCover(id, async () => {
    draft(id, 'The current script has changed while the cover was being reviewed')
    return suggestedCover
  }), { status: 409 })
  assert.deepEqual(getHistoryDelivery(id).coverDesign, previous.coverDesign)
})

test('missing plan or incomplete legacy review evidence cannot claim a complete proposal', async () => {
  const id = seed()
  const previous = saveHistoryDelivery(id, { coverDesign })
  for (const result of [proposal, { ...reviewedResult(), editorial_plan: { ...reviewedResult().editorial_plan!, reviews: [] } }]) {
    await assert.rejects(suggestHistoryCover(id, async () => result), /缺少完整|与选中的方案不一致/)
    assert.deepEqual(getHistoryDelivery(id), previous)
  }
  const failedReview = reviewedResult()
  failedReview.editorial_plan!.reviews[0]!.understandable = false
  await assert.rejects(suggestHistoryCover(id, async () => failedReview), /缺少完整/)
  assert.deepEqual(getHistoryDelivery(id), previous)
})

test('missing or substituted publishing copy preserves all existing delivery fields', async () => {
  const id = seed()
  const previous = saveHistoryDelivery(id, { description: '已有简介', coverDesign })
  const missing = reviewedResult()
  delete missing.video_description
  await assert.rejects(suggestHistoryCover(id, async () => missing), /缺少完整/)
  await assert.rejects(suggestHistoryCover(id, async () => ({ ...selectedResult(), video_title: '未经选择的发布标题' })), /与选中的方案不一致/)
  const missingBaijiahao = selectedResult()
  delete missingBaijiahao.baijiahao_title
  await assert.rejects(suggestHistoryCover(id, async () => missingBaijiahao), /缺少完整/)
  await assert.rejects(suggestHistoryCover(id, async () => ({ ...selectedResult(), baijiahao_title: '与选中方案不同的百家号标题' })), /与选中的方案不一致/)
  assert.deepEqual(getHistoryDelivery(id), previous)
})

test('generated legacy copy saves the canonical Baijiahao title and full historical description atomically', async () => {
  const id = seed()
  const result = selectedResult()
  result.baijiahao_title = '宫廷' + '贵'.repeat(37) + '？'
  result.video_description = '历史背景与采购条件，逐项说明。'.repeat(350)
  assert.equal(result.baijiahao_title.length, 40)
  assert.ok(result.video_description.length > 4000)
  Object.assign(result.editorial_plan!.candidates[0]!, {
    baijiahao_title: result.baijiahao_title, video_description: result.video_description,
  })
  const saved = await suggestHistoryCover(id, async () => result)
  assert.equal(saved.title, result.baijiahao_title)
  assert.equal(saved.coverDesign.main_title, result.main_title)
  assert.equal(saved.baijiahaoTitle, result.baijiahao_title)
  assert.equal(saved.description, result.video_description)
  assert.deepEqual(getHistoryDelivery(id), saved)
})

test('a reviewed publishing package can preserve an independent cover headline', async () => {
  const id = seed()
  saveHistoryDelivery(id, { description: '已有简介', coverDesign })
  const mismatched = reviewedResult()
  mismatched.main_title = '与视频标题不同的封面标题'
  mismatched.editorial_plan!.candidates[0]!.main_title = mismatched.main_title
  const saved = await suggestHistoryCover(id, async () => mismatched)
  assert.equal(saved.coverDesign.main_title, mismatched.main_title)
  assert.equal(saved.title, mismatched.baijiahao_title)
  assert.deepEqual(saved.coverPlan!.candidates[0]!.main_title, mismatched.main_title)
})

test('concurrent publishing copy edits cannot be overwritten by a generated package', async () => {
  const id = seed()
  saveHistoryDelivery(id, { coverDesign })
  await assert.rejects(suggestHistoryCover(id, async () => {
    saveHistoryDelivery(id, { title: '刚保存的标题', description: '刚保存的简介' })
    return suggestedCover
  }), { status: 409 })
  const saved = getHistoryDelivery(id)
  assert.equal(saved.title, '刚保存的标题')
  assert.equal(saved.description, '刚保存的简介')
  assert.deepEqual(saved.coverDesign, coverDesign)
})

test('unreviewed and rejected designs can generate without claiming review approval', async () => {
  const id = seed()
  saveHistoryDelivery(id, { coverDesign })
  await assert.rejects(reviewHistoryCover(id, { coverDesign }, async () => {
    throw new Error('审核未通过')
  }), /审核未通过/)
  let generated = false
  const started = startHistoryCovers(id, {}, async (_id, design) => {
    generated = true
    assert.deepEqual(design, screenshotDesign())
    return covers
  })
  assert.equal(started.coverStatus, 'generating')
  assert.equal(started.coverPlanStatus, 'missing')
  await flush()
  assert.equal(generated, true)
  assert.equal(getHistoryDelivery(id).coverStatus, 'completed')
  assert.equal(getHistoryDelivery(id).coverPlan, null)
})

test('proposal evidence must quote the script and the selected candidate must match the saved design', async () => {
  const id = seed()
  const previous = await approveDesign(id)
  const fabricatedEvidence = reviewedResult()
  fabricatedEvidence.editorial_plan!.candidates[0]!.evidence = ['正文中不存在的虚构引用证据']
  await assert.rejects(suggestHistoryCover(id, async () => fabricatedEvidence), /原文证据不一致/)
  const mismatchedSelection = reviewedResult()
  mismatchedSelection.editorial_plan!.candidates[0]!.main_title = '未经审核的替换标题'
  await assert.rejects(suggestHistoryCover(id, async () => mismatchedSelection), /选中结果或原文证据不一致/)
  assert.deepEqual(getHistoryDelivery(id), previous)
})

test('selection-only plans remain selected after reload and become outdated after design or script edits', async () => {
  const id = seed()
  const saved = await suggestHistoryCover(id, async () => selectedResult())
  assert.equal(saved.coverPlanStatus, 'selected')
  assert.deepEqual(saved.coverPlan?.reviews, [])
  assert.equal(getHistoryDelivery(id).coverPlanStatus, 'selected')
  assert.equal(saveHistoryDelivery(id, { description: '修改简介不改变选中的封面方案' }).coverPlanStatus, 'selected')
  const publicationEdited = saveHistoryDelivery(id, { title: '用户新选的发布标题' })
  assert.equal(publicationEdited.coverPlanStatus, 'selected')
  assert.deepEqual(publicationEdited.coverPlan, saved.coverPlan)
  const changed = saveHistoryDelivery(id, { coverDesign: { ...saved.coverDesign, main_title: '用户新选的封面标题' } })
  assert.equal(changed.coverPlanStatus, 'outdated')
  assert.deepEqual(changed.coverPlan, saved.coverPlan)
  await suggestHistoryCover(id, async () => selectedResult())
  draft(id, 'A revised script changes the generation evidence')
  assert.equal(getHistoryDelivery(id).coverPlanStatus, 'outdated')
})

test('legacy selected plans migrate to selected original-title screenshots and refresh when the source title changes', async () => {
  const id = seed()
  await suggestHistoryCover(id, async () => selectedResult())
  const sourceTitle = '第12集：Beijing wages｜欢迎订阅'
  updateHistorySource(id, { title: sourceTitle })
  const started = startHistoryCovers(id, {}, async (_id, design) => {
    assert.deepEqual(design, originalScreenshotDesign())
    return covers
  })
  assert.equal(started.coverPlanStatus, 'selected')
  await flush()
  const completed = getHistoryDelivery(id)
  assert.equal(completed.coverStatus, 'completed')
  assert.equal(completed.coverPlanStatus, 'selected')
  assert.equal(completed.coverPlan?.publishing_version, 'source-screenshot-v3')
  assert.deepEqual(completed.coverPlan?.source_title_cleanup, { source_title: sourceTitle, cleaned_title: 'Beijing wages' })
  assert.deepEqual(completed.coverPlan?.reviews, [])
  const updatedSource = '第13集：南京工钱有何变化？｜欢迎订阅'
  updateHistorySource(id, { title: updatedSource })
  startHistoryCovers(id, { title: completed.title }, async (_id, design) => {
    assert.deepEqual(design, originalScreenshotDesign('南京工钱有何变化？'))
    return covers
  })
  const refreshed = await waitForCovers(id)
  assert.equal(refreshed.coverStatus, 'completed')
  assert.equal(refreshed.title, '南京工钱有何变化？')
  assert.equal(refreshed.coverPlanStatus, 'selected')
  assert.deepEqual(refreshed.coverPlan?.source_title_cleanup, { source_title: updatedSource, cleaned_title: refreshed.title })
})

test('selection-only plan completeness cannot be forged by attaching review verdicts or removing provenance', async () => {
  const id = seed()
  const previous = saveHistoryDelivery(id, { title: '保留已有标题', description: '保留已有简介' })
  for (const mutate of [
    (result: CoverPromptEnhanceResult) => { result.editorial_plan!.reviews = reviewedResult().editorial_plan!.reviews },
    (result: CoverPromptEnhanceResult) => { delete result.editorial_plan!.title_research },
    (result: CoverPromptEnhanceResult) => { result.editorial_plan!.selected_id = 'invented' },
  ]) {
    const result = selectedResult()
    mutate(result)
    await assert.rejects(suggestHistoryCover(id, async () => result), /缺少完整|与选中的方案不一致/)
    assert.deepEqual(getHistoryDelivery(id), previous)
  }
})

test('manual legacy cover-only edits migrate to the original-title screenshot plan', async () => {
  const id = seed()
  const approved = await approveDesign(id)
  const unchanged = saveHistoryDelivery(id, { description: '更新发布简介', coverDesign })
  assert.equal(unchanged.coverPlanStatus, 'approved')
  assert.deepEqual(unchanged.coverPlan, approved.coverPlan)
  const changed = saveHistoryDelivery(id, { coverDesign: { ...coverDesign, main_title: '未经审核的新标题' } })
  assert.equal(changed.coverDesign.main_title, '未经审核的新标题')
  assert.equal(changed.coverPlanStatus, 'outdated')
  assert.deepEqual(changed.coverPlan, approved.coverPlan)
  startHistoryCovers(id, {}, async (_id, design) => {
    assert.deepEqual(design, originalScreenshotDesign())
    return covers
  })
  await flush()
  assert.equal(getHistoryDelivery(id).coverStatus, 'completed')
  assert.equal(getHistoryDelivery(id).coverPlanStatus, 'selected')
  assert.equal(getHistoryDelivery(id).coverPlan?.publishing_version, 'source-screenshot-v3')
  assert.deepEqual(getHistoryDelivery(id).coverDesign, originalScreenshotDesign())
})

test('a valid script edit invalidates legacy review and generates a current original-title screenshot plan', async () => {
  const id = seed()
  await approveDesign(id)
  draft(id, 'A revised historical script requiring different evidence')
  assert.equal(getHistoryDelivery(id).coverPlanStatus, 'outdated')
  let generated = false
  startHistoryCovers(id, {}, async () => { generated = true; return covers })
  await flush()
  assert.equal(generated, true)
  assert.equal(getHistoryDelivery(id).coverStatus, 'completed')
  assert.equal(getHistoryDelivery(id).coverPlanStatus, 'selected')
  assert.equal(getHistoryDelivery(id).coverPlan?.publishing_version, 'source-screenshot-v3')
  assert.equal(getHistoryDelivery(id).coverPlan?.script_sha256, hash(getHistorySource(id)!.rewrittenScript!))
})

test('clients cannot forge approval but may submit changed designs directly for generation', async () => {
  const id = seed()
  const approved = await approveDesign(id)
  let generated = false
  const generate = async () => { generated = true; return covers }
  for (const input of [
    { coverDesign: { ...coverDesign, editorial_plan: approved.coverPlan } },
    { coverDesign, coverPlan: approved.coverPlan, coverPlanStatus: 'approved' },
  ]) {
    assert.throws(() => saveHistoryDelivery(id, input), /Unrecognized key/)
    assert.throws(() => startHistoryCovers(id, input, generate), /Unrecognized key/)
  }
  assert.deepEqual(getHistoryDelivery(id), approved)
  assert.equal(generated, false)
  const edited = { ...coverDesign, main_title: '用户决定的标题', ai_prompt: 'A different unreviewed image' }
  const title = '用户明确设置的发布标题'
  startHistoryCovers(id, { title, coverDesign: edited }, async (_id, design) => {
    assert.deepEqual(design, screenshotDesign(title))
    return covers
  })
  await flush()
  assert.equal(getHistoryDelivery(id).coverStatus, 'completed')
  assert.deepEqual(getHistoryDelivery(id).coverDesign, screenshotDesign(title))
  assert.deepEqual(getHistoryDelivery(id).coverPlan, approved.coverPlan)
  assert.equal(getHistoryDelivery(id).coverPlanStatus, 'outdated')
})

test('reviewing a user design preserves their exact wording and exposes the supporting plan', async () => {
  const id = seed()
  const saved = await reviewHistoryCover(id, { title: coverDesign.main_title, description: '发布介绍', coverDesign }, async (input, design) => {
    assert.equal(input.editorialReview, true)
    assert.equal(input.episodeContent, getHistorySource(id)!.rewrittenScript)
    assert.deepEqual(design, { main_title: coverDesign.main_title, sub_title: '', kicker: '',
      image_prompt: coverDesign.ai_prompt, accent_color: coverDesign.accent_color, enhanced_prompt: '', rationale: '' })
    return reviewedResult(design)
  })
  assert.deepEqual(saved.coverDesign, coverDesign)
  assert.equal(saved.title, coverDesign.main_title)
  assert.equal(saved.description, '发布介绍')
  assert.equal(saved.coverPlanStatus, 'approved')
  assert.ok(saved.coverPlan?.candidates[0]?.viewer_question)
  assert.ok(saved.coverPlan?.candidates[0]?.payoff)
  assert.ok(saved.coverPlan?.candidates[0]?.visual_concept)
  assert.deepEqual(getHistoryDelivery(id), saved)
})

test('failed user review and silent rewrites preserve the previously saved plan and metadata', async () => {
  const id = seed()
  const previous = await approveDesign(id)
  await assert.rejects(reviewHistoryCover(id, { title: '不应保存的新标题' }, async () => {
    throw new Error('主标题未通过通顺性审核')
  }), /未通过通顺性审核/)
  assert.deepEqual(getHistoryDelivery(id), previous)
  await assert.rejects(reviewHistoryCover(id, { coverDesign }, async (_input, design) =>
    reviewedResult({ ...design, main_title: '审核者擅自重写的标题' })), /不得擅自修改/)
  assert.deepEqual(getHistoryDelivery(id), previous)
})

test('concurrent design edits during generation or user review reject the stale result with 409', async () => {
  const id = seed()
  await approveDesign(id)
  const editedDesign = { ...coverDesign, main_title: '用户刚刚保存的标题' }
  await assert.rejects(suggestHistoryCover(id, async () => {
    saveHistoryDelivery(id, { coverDesign: editedDesign })
    return suggestedCover
  }), { status: 409 })
  assert.deepEqual(getHistoryDelivery(id).coverDesign, editedDesign)
  await assert.rejects(reviewHistoryCover(id, { coverDesign }, async (_input, design) => {
    saveHistoryDelivery(id, { coverDesign: { ...editedDesign, sub_title: '用户刚刚补充的副标题' } })
    return reviewedResult(design)
  }), { status: 409 })
  assert.equal(getHistoryDelivery(id).coverDesign.sub_title, '用户刚刚补充的副标题')
})

test('script edits during user review reject approval with 409', async () => {
  const id = seed()
  const previous = await approveDesign(id)
  await assert.rejects(reviewHistoryCover(id, { coverDesign }, async (_input, design) => {
    draft(id, 'A new script saved while review was in progress')
    return reviewedResult(design)
  }), { status: 409 })
  assert.deepEqual(getHistoryDelivery(id).coverPlan, previous.coverPlan)
  assert.equal(getHistoryDelivery(id).coverPlanStatus, 'outdated')
})

test('finished video is independent from collected source and survives failed replacements', async () => {
  const id = seed()
  const source = getHistorySource(id)
  const initial = await attachHistoryVideo(id, bytes(), '../finished.MP4', options)
  assert.equal(initial.videoName, 'finished.MP4')
  assert.equal(initial.duration, 12)
  assert.equal(initial.scriptChanged, false)
  assert.deepEqual(getHistorySource(id), source)
  const stored = join(root, initial.videoUrl!.replace('/static/', ''))
  assert.equal(await readFile(stored, 'utf8'), 'finished video')
  await assert.rejects(attachHistoryVideo(id, bytes(), 'bad.mp4', { ...options, probe: async () => { throw new Error('invalid codec') } }), /invalid codec/)
  await assert.rejects(attachHistoryVideo(id, bytes(), 'bad.exe', options), /MP4/)
  await assert.rejects(attachHistoryVideo(id, bytes(''), 'empty.mp4', options), /为空/)
  assert.equal(getHistoryDelivery(id).videoUrl, initial.videoUrl)
  assert.equal((await readdir(join(root, 'history-deliveries', String(id)))).length, 1)
})

test('size limits and stream failures remove partial files without replacing the previous video', async () => {
  const id = seed()
  const initial = await attachHistoryVideo(id, bytes('old'), 'old.mp4', options)
  await assert.rejects(attachHistoryVideo(id, bytes('too big'), 'large.mp4', { ...options, maxBytes: 3 }), { status: 413 })
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('connection lost')) } })
  await assert.rejects(attachHistoryVideo(id, broken, 'broken.mp4', options), /connection lost/)
  assert.equal(getHistoryDelivery(id).videoUrl, initial.videoUrl)
  assert.equal((await readdir(join(root, 'history-deliveries', String(id)))).length, 1)
})

test('script edits during upload reject attachment and later edits mark a saved video stale', async () => {
  const id = seed()
  const initial = await attachHistoryVideo(id, bytes(), 'old.mp4', options)
  await assert.rejects(attachHistoryVideo(id, bytes(), 'new.mp4', { ...options, probe: async () => { draft(id, 'Changed historical script'); return 10 } }), { status: 409 })
  assert.equal(getHistoryDelivery(id).videoUrl, initial.videoUrl)
  assert.equal(getHistoryDelivery(id).scriptChanged, true)
})

test('concurrent manual uploads cannot overwrite the winning video or create a retired article task', async () => {
  const id = seed()
  let finishProbe!: () => void
  let enteredProbe!: () => void
  const entered = new Promise<void>(resolve => { enteredProbe = resolve })
  const waiting = new Promise<void>(resolve => { finishProbe = resolve })
  const older = attachHistoryVideo(id, bytes('older'), 'older.mp4', { ...options, probe: async () => {
    enteredProbe()
    await waiting
    return 12
  } })
  await entered
  const winner = await attachHistoryVideo(id, bytes('winner'), 'winner.mp4', options)
  finishProbe()
  await assert.rejects(older, { status: 409 })
  const saved = getHistoryDelivery(id)
  assert.equal(saved.videoUrl, winner.videoUrl)
  assert.equal(saved.videoName, 'winner.mp4')
  assert.equal(saved.articleGeneration, null)
  assert.equal(saved.videos.length, 1)
  assert.equal(saved.videos[0]!.videoUrl, winner.videoUrl)
  assert.equal((await readdir(join(root, 'history-deliveries', String(id)))).length, 1)
})

test('an exported file is bound to its original script and cannot be attached to an edited script', async () => {
  const id = seed()
  const expectedScriptSha256 = hash(getHistorySource(id)!.rewrittenScript!)
  draft(id, 'Edited after the remote export was requested')
  await assert.rejects(attachHistoryVideo(id, bytes(), 'old-export.mp4', { ...options, expectedScriptSha256, onlyIfMissing: true }), { status: 409 })
  assert.equal(getHistoryDelivery(id).videoUrl, null)
})

test('local-file attachment streams once and restart reuses current video even if download was removed', async () => {
  const id = seed()
  const expectedScriptSha256 = hash(getHistorySource(id)!.rewrittenScript!)
  const filename = join(root, 'download.mp4')
  await writeFile(filename, 'downloaded video')
  const settings = { ...options, expectedScriptSha256, onlyIfMissing: true as const }
  const first = await attachHistoryVideoFile(id, filename, 'download.mp4', settings)
  assert.equal(await readFile(join(root, first.videoUrl!.replace('/static/', '')), 'utf8'), 'downloaded video')
  const reused = await attachHistoryVideoFile(id, join(root, 'removed-download.mp4'), 'another.mp4', settings)
  assert.equal(reused.videoUrl, first.videoUrl)
  assert.equal(reused.videoName, 'download.mp4')
  assert.equal(reused.articleGeneration, null)
  await attachHistoryVideoFile(id, filename, 'another.mp4', settings)
  assert.equal(getHistoryDelivery(id).videoHistory.length, 1)
  assert.equal((await readdir(join(root, 'history-deliveries', String(id)))).length, 1)
  draft(id, 'A different current script')
  await assert.rejects(attachHistoryVideoFile(id, filename, 'download.mp4', settings), { status: 409 })
  assert.equal(getHistoryDelivery(id).videoUrl, first.videoUrl)
})

test('automatic attachment reuses the concurrently attached current video without duplicating delivery', async () => {
  const id = seed()
  const pending = deferred<number>()
  const entered = deferred<void>()
  const automatic = attachHistoryVideo(id, bytes('automatic'), 'automatic.mp4', {
    ...options, expectedScriptSha256: hash(getHistorySource(id)!.rewrittenScript!), onlyIfMissing: true,
    probe: async () => { entered.resolve(); return pending.promise },
  })
  await entered.promise
  const manual = await attachHistoryVideo(id, bytes('manual'), 'manual.mp4', options)
  pending.resolve(12)
  assert.equal((await automatic).videoUrl, manual.videoUrl)
  assert.equal(getHistoryDelivery(id).videoName, 'manual.mp4')
  assert.equal(getHistoryDelivery(id).videoHistory.length, 1)
  assert.equal(getHistoryDelivery(id).articleGeneration, null)
  assert.equal((await readdir(join(root, 'history-deliveries', String(id)))).length, 1)
})

test('Huasheng and refined outputs attach concurrently, reuse their own files and retain prior manuscript versions', async () => {
  const id = seed()
  const expectedScriptSha256 = hash(getHistorySource(id)!.rewrittenScript!)
  const attach = (producer: 'huasheng' | 'motion') => attachHistoryVideo(id, bytes(`${producer} output`), `${producer}.mp4`, {
    ...options, producer, producerJobId: `${producer}-job`, expectedScriptSha256, onlyIfMissing: true,
  })
  await Promise.all([attach('huasheng'), attach('motion')])
  const both = getHistoryDelivery(id)
  assert.deepEqual(both.videos.map(video => video.producer).sort(), ['huasheng', 'motion'])
  assert.equal(new Set(both.videos.map(video => video.videoUrl)).size, 2)
  assert.equal(both.videoHistory.length, 2)
  for (const video of both.videos) assert.equal(await readFile(join(root, video.videoUrl.replace('/static/', '')), 'utf8'), `${video.producer} output`)
  const paths = both.videos.map(video => video.videoUrl)
  await Promise.all([attach('huasheng'), attach('motion')])
  assert.deepEqual(getHistoryDelivery(id).videos.map(video => video.videoUrl), paths)
  assert.equal((await readdir(join(root, 'history-deliveries', String(id)))).length, 2)
  draft(id, 'A new manuscript requires new producer outputs')
  const changed = getHistoryDelivery(id)
  assert.equal(changed.videos.length, 0)
  assert.equal(changed.videoHistory.length, 2)
  assert.equal(changed.articleGeneration, null)
})

test('onlyIfMissing preserves stale or missing existing media while explicit manual replacement still works', async () => {
  const id = seed()
  const original = await attachHistoryVideo(id, bytes('old'), 'old.mp4', options)
  draft(id, 'New script requiring a new export')
  const expectedScriptSha256 = hash(getHistorySource(id)!.rewrittenScript!)
  const automatic = { ...options, expectedScriptSha256, onlyIfMissing: true }
  await assert.rejects(attachHistoryVideo(id, bytes('new'), 'new.mp4', automatic), { status: 409 })
  assert.equal(getHistoryDelivery(id).videoUrl, original.videoUrl)
  const manual = await attachHistoryVideo(id, bytes('manually confirmed'), 'confirmed.mp4', options)
  assert.notEqual(manual.videoUrl, original.videoUrl)
  rmSync(join(root, manual.videoUrl!.slice('/static/'.length)))
  await assert.rejects(attachHistoryVideo(id, bytes('new'), 'new.mp4', automatic), { status: 409 })
  assert.equal(getHistoryDelivery(id).videoUrl, manual.videoUrl)
  const repaired = await attachHistoryVideo(id, bytes('manually repaired'), 'repaired.mp4', options)
  assert.notEqual(repaired.videoUrl, manual.videoUrl)
  assert.equal(repaired.scriptChanged, false)
})

test('stale source provenance blocks new videos and covers', async () => {
  const id = seed()
  updateHistorySource(id, { rawTranscript: 'New original transcript' })
  await assert.rejects(attachHistoryVideo(id, bytes(), 'new.mp4', options), { status: 409 })
  assert.throws(() => startHistoryCovers(id, { coverDesign }, async () => covers), { status: 409 })
})

test('cover generation returns immediately, rejects duplicates and persists all ratios', async () => {
  const id = seed()
  await approveDesign(id)
  let finish!: (value: typeof covers) => void
  const pending = new Promise<typeof covers>(resolve => { finish = resolve })
  assert.equal(startHistoryCovers(id, { coverDesign }, () => pending).coverStatus, 'generating')
  assert.throws(() => startHistoryCovers(id, { coverDesign }, async () => covers), { status: 409 })
  assert.throws(() => saveHistoryDelivery(id, { title: 'Conflict' }), { status: 409 })
  finish(covers)
  await flush()
  const saved = getHistoryDelivery(id)
  assert.equal(saved.coverStatus, 'completed')
  assert.deepEqual(saved.covers, { '3:4': '/static/portrait.png', '4:3': '/static/landscape.png', '16:9': '/static/wide.png' })
  draft(id, 'Edited script')
  assert.equal(getHistoryDelivery(id).coversChanged, true)
})

test('cover generation rejects missing ratios and preserves the previous complete files', async () => {
  const id = seed()
  startHistoryCovers(id, { coverDesign }, async () => covers)
  await waitForCovers(id)
  startHistoryCovers(id, {}, async () => ({ '3:4': 'static/incomplete.png' }))
  const failed = await waitForCovers(id)
  assert.equal(failed.coverStatus, 'failed')
  assert.match(failed.error!, /16:9.*4:3.*3:4|缺少.*封面/)
  assert.deepEqual(failed.covers, Object.fromEntries(Object.entries(covers).map(([ratio, url]) => [ratio, `/${url}`])))
})

test('manual covers wait for shared project capacity and retain it until results are persisted', { timeout: 10000 }, async () => {
  const id = seed()
  productionGate.tryAcquire(id + 10000, 'cover-test:first')
  productionGate.tryAcquire(id + 10001, 'cover-test:second')
  let calls = 0
  const pending = deferred<typeof covers>()
  startHistoryCovers(id, { coverDesign }, async () => {
    calls++
    assert.equal(productionGate.isActive(id), true)
    return pending.promise
  })
  try {
    await flush()
    assert.equal(calls, 0)
    assert.equal(getHistoryDelivery(id).coverStatus, 'generating')
    assert.equal(productionGate.overview().waitingProjects, 1)
    productionGate.release('cover-test:first')
    const until = Date.now() + 4000
    while (!calls && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(calls, 1)
    assert.equal(productionGate.tryAcquire(id, 'cover-test:sibling'), true)
    pending.resolve(covers)
    assert.equal((await waitForCovers(id)).coverStatus, 'completed')
    assert.equal(productionGate.isActive(id), true)
  } finally {
    productionGate.release('cover-test:first')
    productionGate.release('cover-test:second')
    pending.resolve(covers)
    await waitForCovers(id)
    productionGate.release('cover-test:sibling')
  }
  assert.equal(productionGate.overview().activeProjects, 0)
})

for (const change of ['script', 'design'] as const) {
  test(`queued cover generation rejects changed ${change} before model dispatch`, { timeout: 10000 }, async () => {
    const id = seed()
    productionGate.tryAcquire(id + 10000, 'cover-test:first')
    productionGate.tryAcquire(id + 10001, 'cover-test:second')
    let calls = 0
    startHistoryCovers(id, { coverDesign }, async () => { calls++; return covers })
    try {
      await flush()
      if (change === 'script') draft(id, 'New script while cover waits for capacity')
      else db.$client.prepare('UPDATE history_script_deliveries SET cover_design_json=? WHERE script_id=?')
        .run(JSON.stringify({ ...coverDesign, ai_prompt: 'New design' }), id)
      productionGate.release('cover-test:first')
      const result = await waitForCovers(id)
      assert.equal(result.coverStatus, 'failed')
      assert.equal(calls, 0)
      assert.match(result.error!, /脚本已修改|方案已修改/)
    } finally {
      productionGate.release('cover-test:first')
      productionGate.release('cover-test:second')
      await waitForCovers(id)
    }
  })
}

async function screenshotCoverFixture(t: TestContext, id?: number) {
  const filename = join(root, `cover-source-${id}.mp4`)
  if (id !== undefined) {
    await promisify(execFile)('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
      'testsrc2=size=1280x720:rate=5', '-t', '1', '-c:v', 'libx264', filename], { timeout: 15000 })
    const media = JSON.parse(getHistorySource(id)!.mediaJson)
    updateHistorySource(id, { mediaJson: JSON.stringify({ ...media, videoPath: filename }) })
  }
  const imageCount = () => db.select().from(schema.imageGenerations).all().length
  const initialImageCount = imageCount()
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('Screenshot covers must not call an image service'))
  const rendered: Array<{ width: number; height: number }> = []
  let failRender = false
  t.mock.method(puppeteer, 'launch', async () => {
    let viewport = { width: 1, height: 1 }
    return { newPage: async () => ({
      setViewport: async (value: typeof viewport) => { viewport = value }, setContent: async () => {}, evaluate: async () => {},
      screenshot: async () => {
        if (failRender) { failRender = false; throw new Error('Composition interrupted') }
        rendered.push(viewport)
        return sharp({ create: { ...viewport, channels: 3, background: '#374952' } }).png().toBuffer()
      },
    }), close: async () => {} } as any
  })
  return { filename, rendered, failNextRender() { failRender = true }, assertLocalOnly() {
    assert.equal(fetch.mock.callCount(), 0)
    assert.equal(imageCount(), initialImageCount, 'Screenshot covers must not create image generation records')
  } }
}

test('screenshot composition retries and missing-ratio repairs use local video without image jobs', async t => {
  const id = seed()
  const fixture = await screenshotCoverFixture(t, id)
  fixture.failNextRender()
  startHistoryCovers(id, { coverDesign })
  const failed = await waitForCovers(id)
  assert.equal(failed.coverStatus, 'failed')
  assert.match(failed.error!, /Composition interrupted/)
  fixture.assertLocalOnly()
  startHistoryCovers(id, {})
  const completed = await waitForCovers(id)
  assert.equal(completed.coverStatus, 'completed', completed.error || '')
  assert.equal(fixture.rendered.length, 3)
  assert.deepEqual(Object.keys(completed.covers).sort(), ['16:9', '3:4', '4:3'])
  startHistoryCovers(id, {})
  assert.equal((await waitForCovers(id)).coverStatus, 'completed')
  assert.equal(fixture.rendered.length, 3, 'A completed package must not render again')
  const wide = join(root, completed.covers['16:9']!.replace(/^\/static\//, ''))
  rmSync(wide)
  const renderedBefore = fixture.rendered.length
  startHistoryCovers(id, {})
  const repaired = await waitForCovers(id)
  assert.equal(repaired.coverStatus, 'completed', repaired.error || '')
  assert.equal(fixture.rendered.length, renderedBefore + 1)
  assert.equal((await sharp(wide).metadata()).width, 1280)
  fixture.assertLocalOnly()
})

test('producer screenshot covers stay separate while repairing only the selected video', async t => {
  const id = seed()
  const fixture = await screenshotCoverFixture(t, id)
  await attachHistoryVideo(id, bytes('huasheng video'), 'huasheng.mp4', { ...options, producer: 'huasheng' })
  await attachHistoryVideo(id, bytes('motion video'), 'motion.mp4', { ...options, producer: 'motion' })
  const videos = getHistoryDelivery(id).videos
  const versions = []
  for (const video of videos) {
    saveHistoryDelivery(id, { title: '同一原标题', coverDesign }, video.id)
    startHistoryCovers(id, {}, undefined, video.id)
    const completed = await waitForCovers(id, 7000, video.id)
    assert.equal(completed.coverStatus, 'completed', completed.error || '')
    assert.equal(Object.keys(completed.covers).length, 3)
    for (const [ratio, filename] of Object.entries(completed.covers)) {
      assert.match(filename!, new RegExp(`/video-${video.id}/covers-[a-f0-9]+/`))
      const size = await sharp(join(root, filename!.slice('/static/'.length))).metadata()
      assert.deepEqual([size.width, size.height], ratio === '16:9' ? [1280, 720] : ratio === '4:3' ? [1200, 900] : [900, 1200])
    }
    versions.push(completed)
  }
  assert.notDeepEqual(versions[0]!.covers, versions[1]!.covers)
  assert.equal(fixture.rendered.length, 6)
  const missing = join(root, versions[0]!.covers['16:9']!.slice('/static/'.length))
  rmSync(missing)
  const renders = fixture.rendered.length
  startHistoryCovers(id, {}, undefined, videos[0]!.id)
  assert.equal((await waitForCovers(id, 7000, videos[0]!.id)).coverStatus, 'completed')
  assert.equal(fixture.rendered.length, renders + 1)
  assert.deepEqual(getHistoryDelivery(id, videos[1]!.id).covers, versions[1]!.covers)
  fixture.assertLocalOnly()
})

test('missing local video fails without fetching, rendering or creating image jobs', async t => {
  const id = seed()
  const fixture = await screenshotCoverFixture(t)
  startHistoryCovers(id, { coverDesign })
  const failed = await waitForCovers(id)
  assert.equal(failed.coverStatus, 'failed')
  assert.match(failed.error!, /缺少可用的真实视频素材/)
  assert.equal(fixture.rendered.length, 0)
  assert.deepEqual(failed.covers, {})
  fixture.assertLocalOnly()
})

test('screenshots are isolated by script and publishing title while previous covers remain available', async t => {
  const id = seed()
  const fixture = await screenshotCoverFixture(t, id)
  startHistoryCovers(id, { coverDesign })
  const original = await waitForCovers(id)
  assert.equal(original.coverStatus, 'completed', original.error || '')
  draft(id, 'Another current script, requiring a new version of the cover')
  const media = JSON.parse(getHistorySource(id)!.mediaJson)
  updateHistorySource(id, { mediaJson: JSON.stringify({ ...media, videoPath: fixture.filename }) })
  startHistoryCovers(id, {})
  const scriptVersion = await waitForCovers(id)
  assert.equal(scriptVersion.coverStatus, 'completed', scriptVersion.error || '')
  assert.notDeepEqual(scriptVersion.covers, original.covers)
  startHistoryCovers(id, { title: '原标题中的另一个明确标题' })
  const titleVersion = await waitForCovers(id)
  assert.equal(titleVersion.coverStatus, 'completed', titleVersion.error || '')
  assert.notDeepEqual(titleVersion.covers, scriptVersion.covers)
  assert.equal(fixture.rendered.length, 9)
  for (const version of [original, scriptVersion, titleVersion]) {
    assert.equal((await sharp(join(root, version.covers['4:3']!.slice('/static/'.length))).metadata()).width, 1200)
  }
  fixture.assertLocalOnly()
})

test('editing the design marks completed cover images stale while preserving their files', async () => {
  const id = seed()
  await approveDesign(id)
  startHistoryCovers(id, { coverDesign }, async () => covers)
  await flush()
  const completed = getHistoryDelivery(id)
  assert.equal(completed.coverStatus, 'completed')
  assert.equal(completed.coversChanged, false)
  const updated = saveHistoryDelivery(id, { coverDesign: { ...coverDesign, main_title: '明朝宫廷冬天的韭菜有多贵？' } })
  assert.equal(updated.coverStatus, 'idle')
  assert.equal(updated.coversChanged, true)
  assert.deepEqual(updated.covers, completed.covers)
})

test('provider failure and changes during generation preserve previous cover files', async () => {
  const id = seed()
  await approveDesign(id)
  startHistoryCovers(id, { coverDesign }, async () => covers)
  await flush()
  const initial = getHistoryDelivery(id).covers
  startHistoryCovers(id, {}, async () => { throw new Error('provider unavailable') })
  await flush()
  assert.equal(getHistoryDelivery(id).coverStatus, 'failed')
  assert.equal(getHistoryDelivery(id).error, 'provider unavailable')
  assert.deepEqual(getHistoryDelivery(id).covers, initial)
  startHistoryCovers(id, {}, async () => { draft(id, 'Changed while generating'); return { '3:4': 'static/new.png' } })
  await flush()
  assert.equal(getHistoryDelivery(id).coverStatus, 'failed')
  assert.match(getHistoryDelivery(id).error!, /脚本已修改/)
  assert.deepEqual(getHistoryDelivery(id).covers, initial)
})

test('expired generation leases recover and late results cannot overwrite a newer run', async () => {
  const id = seed()
  await approveDesign(id)
  let finishOld!: (value: typeof covers) => void
  startHistoryCovers(id, { coverDesign }, () => new Promise(resolve => { finishOld = resolve }))
  await flush()
  db.$client.prepare("UPDATE history_script_deliveries SET cover_lease_until='2000-01-01T00:00:00Z' WHERE script_id=?").run(id)
  assert.equal(getHistoryDelivery(id).coverStatus, 'failed')
  const latest = { ...covers, '3:4': 'static/latest.png' }
  startHistoryCovers(id, {}, async () => latest)
  await flush()
  finishOld(covers)
  await flush()
  assert.deepEqual(getHistoryDelivery(id).covers, Object.fromEntries(Object.entries(latest).map(([ratio, url]) => [ratio, `/${url}`])))
  assert.equal(getHistoryDelivery(id).coverStatus, 'completed')
})

test('real ffmpeg video can be probed and attached without a fake media validator', async () => {
  const id = seed()
  const filename = join(root, 'probe-fixture.mp4')
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '0.5', '-c:v', 'mpeg4', filename], { timeout: 15000 })
  const duration = await probeFinishedVideo(filename)
  assert.ok(duration >= 0.4 && duration <= 0.6)
  const data = await readFile(filename)
  const delivery = await attachHistoryVideo(id, new Blob([data]).stream(), 'real.mp4', { root })
  assert.equal(delivery.duration, duration)
  assert.equal(delivery.videoName, 'real.mp4')
})

test('mounted delivery route validates IDs and JSON, persists design and preserves video on bad streamed upload', async () => {
  const id = seed()
  const app = new Hono().route('/:id/delivery', createHistoryDeliveryRoute())
  const endpoint = `/${id}/delivery`
  assert.equal((await app.request(endpoint)).status, 200)
  assert.equal((await app.request('/999999/delivery')).status, 404)
  for (const invalid of ['abc', '0', '-1', '1.5', '99999999999999999']) {
    assert.equal((await app.request(`/${invalid}/delivery`)).status, 400)
  }
  const malformed = await app.request(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' })
  assert.equal(malformed.status, 400)
  const saved = await app.request(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: coverDesign.main_title, coverDesign }) })
  assert.equal(saved.status, 200)
  const loaded = await (await app.request(endpoint)).json()
  assert.equal(loaded.data.title, coverDesign.main_title)
  assert.deepEqual(loaded.data.coverDesign, coverDesign)
  const initial = await attachHistoryVideo(id, bytes(), 'original.mp4', options)
  const response = await app.request(endpoint + '/video', {
    method: 'PUT', headers: { 'X-File-Name': encodeURIComponent('损坏.mp4'), 'Content-Type': 'application/octet-stream' },
    body: bytes('not a playable movie'), duplex: 'half',
  } as RequestInit)
  assert.ok(response.status >= 400)
  assert.equal(getHistoryDelivery(id).videoUrl, initial.videoUrl)
  assert.equal((await readdir(join(root, 'history-deliveries', String(id)))).length, 1)
})

test('mounted covers route rejects forged approval and accepts title-only screenshots without creating image jobs', async () => {
  const id = seed()
  const app = new Hono().route('/:id/delivery', createHistoryDeliveryRoute())
  const endpoint = `/${id}/delivery/covers`
  const jobsBefore = db.select().from(schema.imageGenerations).all().length
  const post = (body: unknown) => app.request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const approved = await approveDesign(id)
  assert.equal((await post({ coverDesign, coverPlan: approved.coverPlan })).status, 400)
  const loaded = await (await app.request(`/${id}/delivery`)).json()
  assert.equal(loaded.data.coverPlanStatus, 'approved')
  assert.deepEqual(loaded.data.coverPlan, approved.coverPlan)
  assert.equal((await post({ coverDesign: { ...coverDesign, main_title: ' ', ai_prompt: ' ' } })).status, 200)
  const failed = await waitForCovers(id)
  assert.equal(failed.coverStatus, 'failed')
  assert.match(failed.error!, /缺少可用的真实视频素材/)
  assert.equal(failed.coverDesign.main_title, 'Beijing wages')
  assert.equal(failed.coverDesign.ai_prompt, '')
  assert.equal(db.select().from(schema.imageGenerations).all().length, jobsBefore)
})
