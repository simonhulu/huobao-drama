import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import type { CoverPromptEnhanceInput, CoverPromptEnhanceResult } from './cover-prompt-enhance.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-video-packaging-'))
process.env.DB_PATH = path.join(root, 'test.db')
process.env.STORAGE_PATH = root
process.env.TASK_WORKER_DISABLED = '1'
const { db } = await import('../db/index.js')
const { storeHistorySource, updateHistorySource } = await import('./history-script-library.js')
const { recordHistoryVideoDelivery } = await import('./history-video-deliveries.js')
const { getHistoryDelivery, saveHistoryDelivery, startHistoryCovers, startHistoryCoverDesign } = await import('./history-script-delivery.js')
const { ensureHistoryDeliveryAutomation } = await import('./history-delivery-automation.js')
const { createHistoryDeliveryRoute } = await import('../routes/history-script-delivery.js')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const script = '统万城的城墙十分坚固，建造者为此付出了沉重的代价。'
after(() => { db.$client.close(); fs.rmSync(root, { recursive: true, force: true }) })

let sourceSequence = 0
function seed() {
  const source = storeHistorySource({ sourceVideoId: `739568123456789${++sourceSequence}`, title: '统万城为何坚固', category: 'regional_history',
    metrics: {}, selection: { reason: 'fixture', observedAt: new Date().toISOString(), comments: [] } })
  updateHistorySource(source.id, { rawTranscript: script, correctedTranscript: script, rewrittenScript: script,
    mediaJson: JSON.stringify({ videoSha256: '1'.repeat(64), chunks: [{ start: 0, duration: 10, sha256: '2'.repeat(64) }] }),
    asrJson: JSON.stringify({ complete: true, text: script, sourceVideoSha256: '1'.repeat(64),
      chunks: [{ index: 0, start: 0, duration: 10, audioSha256: '2'.repeat(64) }] }),
    reviewJson: JSON.stringify({ factCheckStatus: 'needs_sources', rawTranscriptSha256: hash(script),
      correctedTranscriptSha256: hash(script), rewriteInputSha256: hash(script) }) })
  const directory = path.join(root, 'history-deliveries', String(source.id))
  fs.mkdirSync(directory, { recursive: true })
  const videos = (['huasheng', 'motion'] as const).map(producer => {
    fs.writeFileSync(path.join(directory, `${producer}.mp4`), producer)
    return recordHistoryVideoDelivery(db.$client, { scriptId: source.id, scriptSha256: hash(script), producer,
      producerJobId: `${producer}-job`, videoUrl: `/static/history-deliveries/${source.id}/${producer}.mp4`,
      videoName: `${producer}.mp4`, duration: 10, sha256: hash(producer) })
  })
  return { id: source.id, huasheng: videos[0]!, motion: videos[1]! }
}
const design = (main: string) => ({ main_title: main, sub_title: '', kicker: '', ai_prompt: `${main} historical scene`, accent_color: '#447766' })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
async function settle(id: number, videoId: number) {
  for (let i = 0; i < 100; i++) {
    const delivery = getHistoryDelivery(id, videoId)
    if (delivery.designStatus !== 'generating' && delivery.coverStatus !== 'generating') return delivery
    await flush()
  }
  assert.fail('video packaging did not settle')
}
function proposal(producer: 'huasheng' | 'motion'): CoverPromptEnhanceResult {
  const main = producer === 'huasheng' ? '统万城为何如此坚固？' : '建造统万城代价有多大？'
  const candidate = { main_title: main, sub_title: '', kicker: '', image_prompt: `${producer} ${main} historical scene`,
    accent_color: '#447766', enhanced_prompt: '统万城的历史场景', rationale: '使用正文支持的观看角度。',
    video_title: main, baijiahao_title: main, video_description: '城墙的坚固与建造者的代价。',
    id: 'question', method: '具体疑问', why_click: '了解城墙背后的历史', viewer_question: main,
    payoff: '了解统万城的建造', evidence: [script], visual_concept: `${producer} 城墙与建造者` }
  return { ...candidate, editorial_plan: { version: 'history-cover-plan-v1', selected_id: 'question', selection_reason: '原文可以回答的问题',
    candidates: [candidate], reviews: [{ candidate_id: 'question', natural: true, understandable: true, curiosity: true,
      faithful: true, visual_faithful: true, coherent: true, reason: '正文支持' }] } }
}

test('original title and real source screenshots complete for both producers without an image service', { timeout: 30000 }, async () => {
  const { id, huasheng, motion } = seed()
  const media = JSON.parse((await import('./history-script-library.js')).getHistorySource(id)!.mediaJson)
  const sourceVideo = path.join(root, 'source.mp4')
  await promisify(execFile)('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-t', '2', '-c:v', 'libx264', sourceVideo])
  updateHistorySource(id, { title: '第12集：统万城为何坚固｜欢迎订阅', mediaJson: JSON.stringify({ ...media, videoPath: sourceVideo }) })
  const imageCount = () => (db.$client.prepare('SELECT COUNT(*) AS n FROM image_generations').get() as { n: number }).n
  const count = imageCount()
  for (const video of [huasheng, motion]) {
    startHistoryCoverDesign(id, undefined, {}, video.id)
    const designed = await settle(id, video.id)
    assert.equal(designed.designStatus, 'completed')
    assert.equal(designed.baijiahaoTitle, '统万城为何坚固')
    assert.equal(designed.coverDesign.main_title, designed.baijiahaoTitle)
    assert.equal(designed.coverDesign.ai_prompt, '')
    const result = await ensureHistoryDeliveryAutomation(id, { expectedScriptSha256: hash(script), videoId: video.id }, { root })
    assert.equal(result.design.status, 'completed')
    const deadline = Date.now() + 15000
    while (getHistoryDelivery(id, video.id).coverStatus === 'generating' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const completed = getHistoryDelivery(id, video.id)
    assert.equal(completed.coverStatus, 'completed', completed.error || '')
    for (const [ratio, url] of Object.entries(completed.covers)) {
      const meta = await sharp(path.join(root, String(url).replace(/^\/static\//, ''))).metadata()
      assert.deepEqual([meta.width, meta.height], { '16:9': [1280, 720], '4:3': [1200, 900], '3:4': [900, 1200] }[ratio])
    }
    const originalCovers = completed.covers
    await ensureHistoryDeliveryAutomation(id, { expectedScriptSha256: hash(script), videoId: video.id }, { root })
    assert.deepEqual(getHistoryDelivery(id, video.id).covers, originalCovers)
  }
  assert.equal(imageCount(), count, 'screenshots must never create image generation records')
})

test('producer title, design and cover writes belong only to the selected video', async () => {
  const { id, huasheng, motion } = seed()
  saveHistoryDelivery(id, { title: '历史共用标题' })
  saveHistoryDelivery(id, { title: '统万城为何如此坚固', coverDesign: design('城墙有多坚固') }, huasheng.id)
  saveHistoryDelivery(id, { title: '统万城建造者付出什么代价', coverDesign: design('城墙背后的代价') }, motion.id)
  assert.equal(getHistoryDelivery(id, huasheng.id).baijiahaoTitle, '统万城为何如此坚固')
  assert.equal(getHistoryDelivery(id, motion.id).baijiahaoTitle, '统万城建造者付出什么代价')
  assert.equal(getHistoryDelivery(id).title, '历史共用标题')
  const generate = async (_id: number, _design: unknown, _run: string, videoId?: number) => {
    assert.equal(videoId, huasheng.id)
    return Object.fromEntries(['16:9', '4:3', '3:4'].map(ratio => [ratio, `static/history-deliveries/${id}/video-${videoId}/${ratio.replace(':', 'x')}.png`]))
  }
  startHistoryCovers(id, {}, generate, huasheng.id)
  for (let i = 0; i < 100 && getHistoryDelivery(id, huasheng.id).coverStatus === 'generating'; i++) await flush()
  assert.equal(getHistoryDelivery(id, huasheng.id).coverStatus, 'completed')
  assert.equal(getHistoryDelivery(id, motion.id).coverStatus, 'idle')
  assert.deepEqual(getHistoryDelivery(id, motion.id).covers, {})
  assert.equal(getHistoryDelivery(id).videoPackagings.length, 2)
  assert.doesNotThrow(() => saveHistoryDelivery(id, { title: '统万城为何如此坚固？' }, motion.id), 'versions may share the original title')
  const foreign = seed()
  assert.throws(() => getHistoryDelivery(id, foreign.motion.id), /成片|归属/)
})

test('audio-only collected sources use the selected finished video for screenshots', { timeout: 20000 }, async () => {
  const { id, motion } = seed()
  const execute = promisify(execFile)
  const sourceAudio = path.join(root, 'audio-only.mp4')
  await execute('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-vn', sourceAudio])
  const videoPath = path.join(root, motion.videoUrl.replace(/^\/static\//, ''))
  await execute('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-t', '2', '-c:v', 'libx264', videoPath])
  const media = JSON.parse((await import('./history-script-library.js')).getHistorySource(id)!.mediaJson)
  updateHistorySource(id, { mediaJson: JSON.stringify({ ...media, videoPath: sourceAudio }) })
  startHistoryCoverDesign(id, undefined, {}, motion.id)
  await settle(id, motion.id)
  startHistoryCovers(id, {}, undefined, motion.id)
  const deadline = Date.now() + 12000
  while (getHistoryDelivery(id, motion.id).coverStatus === 'generating' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  const completed = getHistoryDelivery(id, motion.id)
  assert.equal(completed.coverStatus, 'completed', completed.error || '')
  assert.equal(Object.keys(completed.covers).length, 3)
})

test('regenerating a legacy AI cover replaces its invented title with the cleaned original', async () => {
  const { id, motion } = seed()
  startHistoryCoverDesign(id, async () => proposal('motion'), {}, motion.id)
  await settle(id, motion.id)
  assert.notEqual(getHistoryDelivery(id, motion.id).baijiahaoTitle, '统万城为何坚固')
  const started = startHistoryCovers(id, {}, async (_id, design) => {
    assert.equal(design.main_title, '统万城为何坚固')
    return { '16:9': 'static/wide.png', '4:3': 'static/landscape.png', '3:4': 'static/portrait.png' }
  }, motion.id)
  assert.equal(started.baijiahaoTitle, '统万城为何坚固')
  assert.equal(started.coverPlan?.publishing_version, 'source-screenshot-v3')
  assert.equal(started.coverPlanStatus, 'selected')
  assert.equal((await settle(id, motion.id)).coverStatus, 'completed')
})

test('unclear original footage falls back to clear pixels in the selected finished video', { timeout: 20000 }, async () => {
  const { id, motion } = seed(), execute = promisify(execFile)
  const sourceVideo = path.join(root, 'low-quality-source.mp4')
  await execute('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=1', '-t', '1', '-c:v', 'libx264', sourceVideo])
  const videoPath = path.join(root, motion.videoUrl.replace(/^\/static\//, ''))
  await execute('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-t', '2', '-c:v', 'libx264', videoPath])
  const media = JSON.parse((await import('./history-script-library.js')).getHistorySource(id)!.mediaJson)
  updateHistorySource(id, { mediaJson: JSON.stringify({ ...media, videoPath: sourceVideo }) })
  startHistoryCoverDesign(id, undefined, {}, motion.id)
  await settle(id, motion.id)
  startHistoryCovers(id, {}, undefined, motion.id)
  const deadline = Date.now() + 12000
  while (getHistoryDelivery(id, motion.id).coverStatus === 'generating' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  const completed = getHistoryDelivery(id, motion.id)
  assert.equal(completed.coverStatus, 'completed', completed.error || '')
})

test('packaging cannot start before its accepted current video exists and cannot reuse a shared design', async () => {
  const { id, motion } = seed()
  saveHistoryDelivery(id, { title: '已完成共用方案', coverDesign: design('旧的共用封面') })
  let calls = 0
  const pending = ensureHistoryDeliveryAutomation(id, { expectedScriptSha256: hash(script), videoId: motion.id }, {
    root, generate: async () => { calls++; throw new Error('isolated generator fixture') },
  })
  await pending
  for (let i = 0; i < 100 && getHistoryDelivery(id, motion.id).designStatus === 'generating'; i++) await flush()
  assert.equal(calls, 1, 'the shared source design must not satisfy this video')
  assert.equal(getHistoryDelivery(id, motion.id).designStatus, 'failed')
  assert.equal(getHistoryDelivery(id).title, '已完成共用方案')
  const result = await ensureHistoryDeliveryAutomation(id, { expectedScriptSha256: hash(script), videoId: 999999 }, {
    generate: async () => { assert.fail('unknown video cannot dispatch') },
  })
  assert.equal(result.design.status, 'needs_attention')
  assert.equal(result.covers.status, 'needs_attention')
})

test('delivery API binds reads and writes to a validated video_id', async () => {
  const { id, huasheng, motion } = seed()
  const app = new Hono().route('/scripts/:id/delivery', createHistoryDeliveryRoute())
  const put = await app.request(`/scripts/${id}/delivery?video_id=${motion.id}`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '精细化独立标题', coverDesign: design('建城者的代价') }) })
  assert.equal(put.status, 200)
  const saved = (await put.json()).data
  assert.equal(saved.videoId, motion.id)
  assert.equal(saved.producer, 'motion')
  assert.equal(saved.title, '精细化独立标题')
  const other = (await (await app.request(`/scripts/${id}/delivery?video_id=${huasheng.id}`)).json()).data
  assert.equal(other.title, '')
  assert.equal((await app.request(`/scripts/${id}/delivery?video_id=abc`)).status, 400)
  assert.equal((await app.request(`/scripts/${id}/delivery?video_id=999999`)).status, 404)
})

test('each finished producer generates once, waiting for the other title and reusing only its own package', async () => {
  const { id, huasheng, motion } = seed()
  const calls: CoverPromptEnhanceInput[] = []
  let release!: (value: CoverPromptEnhanceResult) => void
  const pending = new Promise<CoverPromptEnhanceResult>(resolve => { release = resolve })
  const dependencies = {
    root,
    generate: async (input: CoverPromptEnhanceInput) => {
      calls.push(input)
      return input.publishingVariant!.producer === 'huasheng' ? pending : proposal('motion')
    },
    generateCovers: async (sourceId: number, _design: unknown, _runId: string, videoId?: number) => {
      const directory = `history-deliveries/${sourceId}/video-${videoId}/covers-fixture`
      fs.mkdirSync(path.join(root, directory), { recursive: true })
      return Object.fromEntries(['16:9', '4:3', '3:4'].map(ratio => {
        const filename = `${directory}/${ratio.replace(':', 'x')}.png`
        fs.writeFileSync(path.join(root, filename), 'cover fixture')
        return [ratio, `static/${filename}`]
      }))
    },
  }
  const ownOptions = (videoId: number) => ({ expectedScriptSha256: hash(script), videoId })
  const first = await ensureHistoryDeliveryAutomation(id, ownOptions(huasheng.id), dependencies)
  assert.equal(first.design.status, 'generating')
  try {
    await flush()
    const waiting = await ensureHistoryDeliveryAutomation(id, ownOptions(motion.id), dependencies)
    assert.equal(waiting.design.status, 'queued')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.publishingVariant!.videoId, huasheng.id)
    assert.deepEqual(calls[0]!.publishingVariant!.otherPackages, [])
  } finally { release(proposal('huasheng')) }
  await settle(id, huasheng.id)
  assert.equal((await ensureHistoryDeliveryAutomation(id, ownOptions(huasheng.id), dependencies)).covers.status, 'generating')
  await settle(id, huasheng.id)
  assert.equal((await ensureHistoryDeliveryAutomation(id, ownOptions(motion.id), dependencies)).design.status, 'generating')
  await settle(id, motion.id)
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.publishingVariant!.videoId, motion.id)
  assert.deepEqual(calls[1]!.publishingVariant!.otherPackages, [{ producer: 'huasheng', title: '统万城为何坚固',
    mainTitle: '统万城为何坚固', imagePrompt: '' }])
  await ensureHistoryDeliveryAutomation(id, ownOptions(motion.id), dependencies)
  await settle(id, motion.id)
  for (const video of [huasheng, motion]) {
    const repeated = await ensureHistoryDeliveryAutomation(id, { ...ownOptions(video.id), retryFailed: true }, dependencies)
    assert.equal(repeated.design.status, 'completed')
    assert.equal(repeated.covers.status, 'completed')
    assert.ok(Object.values(getHistoryDelivery(id, video.id).covers).every(value => value?.includes(`/video-${video.id}/`)))
  }
  assert.equal(calls.length, 2, 'retry must not repeat either completed model invocation')
  assert.equal((db.$client.prepare('SELECT COUNT(*) AS n FROM history_video_design_intents WHERE script_id=?').get(id) as { n: number }).n, 2)
})

test('missing media cannot dispatch a model and a superseded video cannot accept a late design', async () => {
  const { id, huasheng, motion } = seed()
  fs.rmSync(path.join(root, motion.videoUrl.replace(/^\/static\//, '')))
  const missing = await ensureHistoryDeliveryAutomation(id, { expectedScriptSha256: hash(script), videoId: motion.id }, {
    root, generate: async () => { assert.fail('missing media cannot dispatch') },
  })
  assert.equal(missing.design.status, 'needs_attention')
  assert.match(missing.design.message, /文件缺失|尚未落盘/)
  let release!: (value: CoverPromptEnhanceResult) => void
  const pending = new Promise<CoverPromptEnhanceResult>(resolve => { release = resolve })
  const completion = new Promise<void>(resolve => {
    startHistoryCoverDesign(id, () => pending, { failed() { resolve() }, completed() { assert.fail('obsolete output cannot complete') } }, huasheng.id)
  })
  await flush()
  const newer = recordHistoryVideoDelivery(db.$client, { ...huasheng, sha256: hash('newer huasheng video'), videoName: 'newer.mp4' })
  release(proposal('huasheng'))
  await completion
  assert.equal(getHistoryDelivery(id, newer.id).title, '')
  const obsolete = db.$client.prepare('SELECT title,design_status FROM history_video_packaging WHERE video_id=?').get(huasheng.id) as { title: string; design_status: string }
  assert.equal(obsolete.title, '')
  assert.equal(obsolete.design_status, 'failed')
  assert.equal(getHistoryDelivery(id, motion.id).title, '')
})
