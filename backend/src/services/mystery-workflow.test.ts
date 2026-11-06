import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { MysteryWorkflowOptions } from './mystery-workflow.js'
import type { CreationTask, CreateTaskInput, TaskContext } from './tasks/types.js'
import type { SocialUploadPayload } from './social-auto-upload.js'
import { hashMysteryText, type MysteryAnalysis, type MysteryReview } from './mystery-script.js'
import { MysteryStore } from './mystery-store.js'
import { MYSTERY_NARRATOR } from './mystery-types.js'

const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystery-workflow-import-'))
process.env.DB_PATH = path.join(moduleRoot, 'imports.db')
process.env.TASK_WORKER_DISABLED = '1'
const { MysteryWorkflowService } = await import('./mystery-workflow.js')
after(() => fs.rmSync(moduleRoot, { recursive: true, force: true }))
const original = '那天门为什么开着？他先看门锁，又走到窗边。他们等了一夜，答案依然未知。'
const sourceUrl = 'https://youtu.be/abcdefghijk'

function analysis(source: string): MysteryAnalysis {
  return { sourceHash: hashMysteryText(source), theme: '没有答案的等待', purpose: '逐步调查，保留未知',
    audienceNeeds: ['好奇心', '悬念'], endingPayoff: '答案依然未知', stance: '保持不确定',
    evidence: [{ id: 'e1', start: 0, end: source.length, quote: source, note: '全篇调查与等待' }],
    beats: [{ id: 'b1', start: 0, end: source.length, purpose: '沿原稿推进', emotion: '等待', method: '疑问与调查', reveal: '未知' }],
    identitySpans: [], dossier: { people: [], timeline: [], claims: [], uncertainties: ['未知'] } }
}
function review(source: string, plan: MysteryAnalysis, narrator = MYSTERY_NARRATOR, text = source): MysteryReview {
  return { passed: true, issues: [], checkedAt: new Date().toISOString(), sourceHash: hashMysteryText(source), textHash: hashMysteryText(text),
    analysisHash: hashMysteryText(JSON.stringify(plan)), narratorHash: hashMysteryText(JSON.stringify(narrator)),
    checks: { meaning: true, completeness: true, flow: true, experience: true, identity: true } }
}
function fixture(t: any, overrides: Partial<MysteryWorkflowOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystery-workflow-')), sqlite = new Database(path.join(root, 'state.db'))
  const store = new MysteryStore(sqlite), tasks = new Map<number, CreationTask>(), events: string[] = []
  const accountNames = ['mystery_huasheng_' + 'a'.repeat(32), 'mystery_huasheng_' + 'b'.repeat(32)]
  let selectedAccount = accountNames[0]!
  const calls = { download: 0, transcribe: 0, analyze: 0, edit: 0, review: 0, produce: 0, export: 0, downloadExport: 0, covers: 0, upload: 0, opened: [] as string[], scripts: [] as string[] }
  const account = (name: string) => ({ accountName: name, label: name, scope: 'mystery' as const, status: 'ready' as const, isDefault: name === selectedAccount, message: '',
    updatedAt: '', identity: { uid: name, displayName: name }, observedIdentity: { uid: name, displayName: name }, identityStatus: 'verified' as const, checkedAt: '' })
  const enqueue = (input: CreateTaskInput): CreationTask => {
    const task = { id: tasks.size + 1, type: input.type, status: 'queued', payload: input.payload, cancelRequested: false, leaseToken: null,
      leaseExpiresAt: null, idempotencyKey: input.idempotencyKey } as CreationTask
    tasks.set(task.id, task); return task
  }
  const options: MysteryWorkflowOptions = { store, root, pollMs: 0, enqueue, task: id => tasks.get(id) || null,
    cancel: id => { const task = tasks.get(id)!; task.cancelRequested = true; task.status = 'canceled'; return { outcome: 'requested', task } },
    huashengAccounts: {
      get: name => { assert.ok(accountNames.includes(name)); return account(name) },
      list: () => ({ scope: 'mystery', accounts: accountNames.map(account), defaultAccountName: selectedAccount }),
      readyBrowserConfig: async name => { calls.opened.push(name); return { endpoint: 'http://127.0.0.1:9250', profile: path.join(root, name), expectedUid: name } },
    },
    baijiahaoAccounts: { get: name => ({ accountName: name, label: name, status: 'ready', isDefault: true, message: '', updatedAt: '' }) },
    download: async (input, opts) => {
      calls.download++; fs.mkdirSync(input.directory, { recursive: true }); const videoPath = path.join(input.directory, 'source.mp4')
      fs.writeFileSync(videoPath, 'source-video')
      const media = { videoPath, videoSha256: hashMysteryText('source-video'), downloadKind: input.mode, downloadState: 'done' }
      opts.onMedia(media); return { title: '门后的谜团', author: '来源频道', media }
    },
    transcribe: async () => { calls.transcribe++; return { text: original, chunks: [{ start: 0, duration: 90, text: original }] } },
    analyze: async input => { calls.analyze++; return analysis(input.source) },
    edit: async input => { calls.edit++; return { text: input.source, patches: [], review: review(input.source, input.analysis, input.narrator as string) } },
    review: async input => { calls.review++; const text = input.patches.reduceRight((text, patch) => text.slice(0, patch.start) + patch.replacement + text.slice(patch.end), input.source)
      return review(input.source, input.analysis, input.narrator as string, text) },
    publishingCopy: async input => ({ titleCandidates: ['门后的谜团', '那扇门为何打开'], title: '门后的谜团', description: '调查与未知', tags: ['故事'],
      scriptHash: hashMysteryText(input.script), evidence: [], checkedAt: new Date().toISOString() }),
    browser: { runHuashengBrowserJob: async input => {
      calls.produce++; calls.scripts.push(input.script)
      await input.onCheckpoint({ checkpoint: 'submitted', projectUrl: 'https://www.huasheng.cn/video/12345', message: '已接受' })
      return { projectUrl: 'https://www.huasheng.cn/video/12345' }
    } },
    exportApi: {
      inspectHuashengProduction: async () => ({ status: 'completed', message: '素材就绪' }),
      createHuashengExport: async input => { calls.export++; await input.onDispatched?.(); return { taskId: 'original-task', projectHash: 'a'.repeat(64) } },
      inspectHuashengExport: async () => ({ progress: 100, url: 'https://fixture.invalid/video.mp4', filename: 'video.mp4' }),
      downloadHuashengExport: async (_input, opts) => { calls.downloadExport++; fs.mkdirSync(opts!.root!, { recursive: true }); const filePath = path.join(opts!.root!, 'video.mp4')
        fs.writeFileSync(filePath, 'finished-video'); return { filePath, filename: 'video.mp4', bytes: 14 } },
    },
    inspectVideo: async file => ({ videoSha256: hashMysteryText(fs.readFileSync(file, 'utf8')), duration: 90, width: 1280, height: 720, bytes: fs.statSync(file).size }),
    prepareAssets: async input => { calls.covers++; fs.mkdirSync(input.directory, { recursive: true })
      const landscapePath = path.join(input.directory, 'landscape.jpg'), portraitPath = path.join(input.directory, 'portrait.jpg')
      fs.writeFileSync(landscapePath, 'landscape'); fs.writeFileSync(portraitPath, 'portrait')
      return { videoSha256: hashMysteryText('finished-video'), landscapePath, portraitPath, landscapeSha256: hashMysteryText('landscape'), portraitSha256: hashMysteryText('portrait') } },
    inspectAssets: async input => ({ videoSha256: hashMysteryText('finished-video'), ...input,
      landscapeSha256: hashMysteryText('landscape'), portraitSha256: hashMysteryText('portrait') }),
    uploadRuntime: {
      inspectSocialUploadCheckpoint: async () => { calls.upload++; throw new Error('This test never authorizes upload') },
      inspectSocialUploadAccountRuntime: async () => { throw new Error('No upload') },
      inspectSocialUploadRuntime: async () => { throw new Error('No upload') },
      runSocialUpload: async () => { throw new Error('No upload') }, resumeSocialUpload: async () => { throw new Error('No upload') },
      confirmSocialUpload: async () => { throw new Error('No upload') }, reconcileSocialUpload: async () => { throw new Error('No upload') },
    },
    ...overrides,
  }
  const service = new MysteryWorkflowService(options)
  function ctx(taskId: number): TaskContext {
    const task = tasks.get(taskId)!
    task.status = 'running'; task.leaseToken = randomUUID(); task.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
    return { taskId, leaseToken: task.leaseToken, payload: task.payload, signal: new AbortController().signal, attempts: 1,
      progress: message => { events.push(message) }, event: () => {}, isCancelRequested: () => task.cancelRequested }
  }
  async function execute(storyId: number, runId: string, instance = service) {
    const run = instance.detail(storyId).runs.find(run => run.id === runId)!, task = tasks.get(run.taskId!)!
    try { const result = await instance.execute(storyId, runId, ctx(task.id)); if (task.status !== 'canceled') task.status = 'succeeded'; return result }
    catch (error) { if (task.status !== 'canceled') task.status = 'failed'; throw error }
  }
  async function run(storyId: number, target: 'draft'|'video' = 'video') {
    const story = service.start(storyId, { requestId: randomUUID(), target })
    await execute(storyId, story.runs.at(-1)!.id)
    return service.detail(storyId)
  }
  t.after(() => { sqlite.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { service, store, sqlite, root, tasks, options, calls, events, accountNames, ctx, execute, run,
    switchDefault: () => { selectedAccount = accountNames[1]! } }
}

test('duplicate URL imports and repeated start intent reuse the source and persistent run', async t => {
  const f = fixture(t), first = f.service.create({ sourceUrl })
  const second = f.service.create({ sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk&list=other' })
  assert.equal(second.id, first.id)
  const input = { requestId: 'same-intent', target: 'draft' as const }
  f.service.start(first.id, input); f.service.start(first.id, input)
  assert.equal(f.tasks.size, 1); assert.equal(f.service.detail(first.id).runs.length, 1)
  await f.execute(first.id, f.service.detail(first.id).runs[0]!.id)
  f.service.start(first.id, input)
  assert.equal(f.tasks.size, 1)
  assert.equal(f.service.list({ pageSize: 1 }).total, 1)
  assert.equal(f.calls.upload, 0)
})
test('a repeated cover command cannot change the input or version of an already queued cover run', async t => {
  const f = fixture(t), story = f.service.create({ sourceUrl }), finished = await f.run(story.id)
  const editionId = finished.editions[0]!.id
  const first = f.service.start(story.id, { requestId: 'cover-attempt-first', target: 'video', action: 'covers', editionId, coverInstruction: '突出旧木门' })
  const second = f.service.start(story.id, { requestId: 'cover-attempt-second', target: 'video', action: 'covers', editionId, coverInstruction: '突出窗户' })
  assert.equal(second.runs.filter(run => run.action === 'covers').length, 1)
  assert.equal(second.editions[0]!.coverRevision, first.editions[0]!.coverRevision)
  assert.equal(second.editions[0]!.coverInstruction, '突出旧木门')
})
test('upstream edits during v1 production keep the current story at analysis after the old v1 video finishes', async t => {
  for (const field of ['correctedTranscript', 'narrator'] as const) {
    const f = fixture(t)
    let release!: () => void, producing!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { producing = resolve })
    const produce = f.options.browser!.runHuashengBrowserJob
    f.options.browser = { runHuashengBrowserJob: async input => {
      const result = await produce(input)
      producing()
      await waiting
      return result
    } }
    const story = f.service.create({ sourceUrl }), started = f.service.start(story.id, { requestId: randomUUID() })
    const running = f.execute(story.id, started.runs[0]!.id)
    await entered
    const before = f.service.detail(story.id)
    const updated = f.service.patch(story.id, { expectedVersion: before.version,
      ...(field === 'correctedTranscript' ? { correctedTranscript: original + '原稿校对补录。' } : { narrator: '新的清楚讲述语气，保留原作目的。' }) })
    release()
    await running
    const completed = f.service.detail(story.id)
    assert.equal(updated.currentRevisionId, null)
    assert.equal(completed.currentRevisionId, null)
    assert.equal(completed.analysis, null)
    assert.equal(completed.status, 'draft')
    assert.equal(completed.stage, 'analyze')
    assert.equal(completed.editions[0]!.revisionId, 1)
    assert.equal(completed.editions[0]!.status, 'package_ready')
    assert.equal(completed.revisions[0]!.text, original)
    assert.equal(completed.runs[0]!.status, 'ready')
    assert.ok(completed.editions[0]!.videoUrl)
  }
})

test('a complete draft preserves the source and review fingerprints while production mode defaults to video only', async t => {
  for (const target of ['draft', 'video'] as const) {
    const f = fixture(t), story = f.service.create({ sourceUrl }), completed = await f.run(story.id, target)
    assert.equal(completed.revisions[0]!.text, original)
    assert.equal(completed.revisions[0]!.review?.passed, true)
    assert.equal(completed.status, 'ready')
    assert.equal(fs.readFileSync(completed.media.videoPath!, 'utf8'), 'source-video')
    assert.equal(f.calls.upload, 0)
    assert.equal(f.calls.produce, target === 'draft' ? 0 : 1)
    if (target === 'video') { assert.ok(completed.editions[0]!.videoUrl); assert.equal(completed.editions[0]!.status, 'package_ready') }
    const tracked = f.sqlite.prepare('SELECT pinned FROM storage_artifacts WHERE path=?').get(completed.media.videoPath!) as {pinned:number}
    assert.equal(tracked.pinned, 1)
  }
})

test('unresolved semantic review prevents any Huasheng submission and retains full original and patches', async t => {
  const f = fixture(t, { edit: async input => ({ text: input.source, patches: [],
    review: { ...review(input.source, input.analysis, input.narrator as string), passed: false, issues: [{ kind: 'identity', message: '作者身份仍未处理' }] } }) })
  const story = f.service.create({ sourceUrl }), started = f.service.start(story.id, { requestId: randomUUID() })
  await assert.rejects(f.execute(story.id, started.runs[0]!.id), /作者身份仍未处理/)
  const failed = f.service.detail(story.id)
  assert.equal(failed.revisions[0]!.text, original)
  assert.equal(failed.status, 'needs_attention')
  assert.equal(f.calls.produce, 0); assert.equal(f.calls.opened.length, 0); assert.equal(f.calls.upload, 0)
})

test('a script over the platform limit stays complete and never reaches browser creation', async t => {
  const long = original.repeat(400)
  const f = fixture(t, { transcribe: async () => ({ text: long, chunks: [{ start: 0, duration: 3600, text: long }] }) })
  const story = f.service.create({ sourceUrl }), started = f.service.start(story.id, { requestId: randomUUID() })
  await assert.rejects(f.execute(story.id, started.runs[0]!.id), /10000字符/)
  assert.equal(f.service.detail(story.id).revisions[0]!.text, long)
  assert.equal(f.calls.produce, 0); assert.equal(f.calls.export, 0)
})

test('cover failure preserves the MP4 and resumes the original edition and bound account after default changes', async t => {
  const f = fixture(t), prepare = f.options.prepareAssets!
  let failures = 0
  f.options.prepareAssets = async (...args) => { if (!failures++) throw new Error('portrait provider unavailable'); return prepare(...args) }
  const story = f.service.create({ sourceUrl }), started = f.service.start(story.id, { requestId: randomUUID() }), runId = started.runs[0]!.id
  await assert.rejects(f.execute(story.id, runId), /portrait provider unavailable/)
  const failed = f.service.detail(story.id), editionId = failed.editions[0]!.id, videoPath = failed.editions[0]!.videoPath
  assert.ok(videoPath && fs.existsSync(videoPath)); assert.equal(failed.editions[0]!.status, 'video_ready')
  f.switchDefault()
  f.service.resume(story.id, runId)
  await f.execute(story.id, runId)
  const completed = f.service.detail(story.id)
  assert.equal(completed.editions[0]!.id, editionId); assert.equal(completed.editions[0]!.videoPath, videoPath)
  assert.equal(completed.editions[0]!.accountName, f.accountNames[0])
  assert.deepEqual(f.calls.opened, [f.accountNames[0]])
  assert.equal(f.calls.produce, 1); assert.equal(f.calls.export, 1); assert.equal(f.calls.downloadExport, 1)
})

test('new local wording saves a separate immutable revision while the original video stays bound to its source revision', async t => {
  const f = fixture(t), story = f.service.create({ sourceUrl }), finished = await f.run(story.id)
  const edition = finished.editions[0]!, originalRevision = structuredClone(finished.revisions[0]!)
  const before = '又走到窗边', start = original.indexOf(before)
  const saved = f.service.saveRevision(story.id, { expectedRevision: 1, patches: [
    { id: 'p1', start, end: start + before.length, original: before, replacement: '又走向窗边', reason: '等义替换', kind: 'wording' },
  ] })
  assert.equal(saved.currentRevisionId, 2)
  assert.deepEqual(saved.revisions[0], originalRevision)
  assert.equal(saved.editions[0]!.revisionId, 1)
  assert.equal(saved.editions[0]!.scriptHash, originalRevision.textHash)
  await f.execute(story.id, saved.runs.at(-1)!.id)
  assert.equal(f.service.detail(story.id).revisions[1]!.review?.passed, true)
  assert.equal(f.calls.produce, 1)
  assert.throws(() => f.service.saveRevision(story.id, { expectedRevision: 1, patches: [] }), /版本已更新/)
  assert.equal(f.service.detail(story.id).editions[0]!.id, edition.id)
})

test('explicit stop survives service recreation and only an explicit resume requeues original run', async t => {
  const f = fixture(t), story = f.service.create({ sourceUrl }), started = f.service.start(story.id, { requestId: randomUUID(), target: 'draft' })
  const runId = started.runs[0]!.id, oldTaskId = started.runs[0]!.taskId!
  f.service.stop(story.id, runId)
  const restored = new MysteryWorkflowService(f.options)
  const stopped = await restored.execute(story.id, runId, { taskId: oldTaskId, payload: f.tasks.get(oldTaskId)!.payload,
    signal: new AbortController().signal, attempts: 1, progress: () => {}, event: () => {}, isCancelRequested: () => true })
  assert.deepEqual(stopped, { stopped: true })
  assert.equal(f.calls.download, 0); assert.equal(restored.detail(story.id).runs[0]!.status, 'paused')
  restored.resume(story.id, runId)
  assert.notEqual(restored.detail(story.id).runs[0]!.taskId, oldTaskId)
  await f.execute(story.id, runId, restored)
  assert.equal(restored.detail(story.id).runs.length, 1)
  assert.equal(restored.detail(story.id).status, 'ready')
})

test('a bad item in a collection does not stop the other accepted stories and counts include all pages', async t => {
  const f = fixture(t)
  f.options.collect = async opts => {
    for (let i = 0; i < 5; i++) {
      const videoId = 'item' + String(i).padStart(7, '0')
      await opts.onCandidate({ videoId, sourceUrl: 'https://www.youtube.com/watch?v=' + videoId, title: '故事 ' + i, authorName: '测试频道',
        durationSeconds: 90, observedAt: '', collectionUrl: opts.url })
    }
  }
  const download = f.options.download!
  f.options.download = async (...args) => { if (args[0].sourceUrl.includes('item0000002')) throw new Error('video unavailable'); return download(...args) }
  const collection = f.service.startCollection({ requestId: 'batch-intent', urls: ['https://www.youtube.com/@stories/videos'], targetCount: 5, target: 'draft' })
  await f.service.executeCollection(collection.id, f.ctx(collection.taskId!))
  f.tasks.get(collection.taskId!)!.status = 'succeeded'
  const accepted = f.store.collection(collection.id)
  assert.equal(accepted.storyIds.length, 5)
  for (const id of accepted.storyIds) {
    const runId = f.service.detail(id).runs[0]!.id
    if (f.service.detail(id).videoId === 'item0000002') await assert.rejects(f.execute(id, runId), /video unavailable/)
    else await f.execute(id, runId)
  }
  const counts = f.service.collections()[0]!.counts
  assert.equal(counts.drafts, 4); assert.equal(counts.failed, 1)
  assert.equal(f.service.list({ pageSize: 1 }).counts.ready, 4)
  assert.equal(f.service.list({ pageSize: 1 }).total, 5)
  assert.equal(f.calls.upload, 0)
})

test('date filters fetch missing channel metadata and a bad metadata item does not stop later candidates', async t => {
  const f=fixture(t)
  const candidates=[0,1,2].map(index=>({videoId:`dates00000${index}`,sourceUrl:`https://www.youtube.com/watch?v=dates00000${index}`,title:`日期故事${index}`,authorName:'来源',observedAt:'',collectionUrl:'https://www.youtube.com/@stories/videos'}))
  f.options.collect=async options=>{
    if(options.url.includes('watch?v=')) {
      const candidate=candidates.find(item=>item.sourceUrl===options.url)!
      if(candidate.videoId.endsWith('1'))throw new Error('metadata unavailable')
      await options.onCandidate({...candidate,publishedAt:candidate.videoId.endsWith('0')?'20000101':'20250101'})
      return
    }
    for(const [index,candidate] of candidates.entries()) {
      options.report({stage:'selecting',message:'扫描来源',scanned:index+1,candidate:{outcome:'selected',videoId:candidate.videoId}})
      await options.onCandidate(candidate)
    }
  }
  const collection=f.service.startCollection({requestId:'date-filter-test',urls:['https://www.youtube.com/@stories/videos'],target:'draft',afterDate:'2024-01-01',targetCount:1})
  await f.service.executeCollection(collection.id,f.ctx(collection.taskId!))
  const result=f.store.collection(collection.id)
  assert.equal(result.scanned,3);assert.equal(result.skipped,2);assert.equal(result.storyIds.length,1)
  assert.equal(f.service.detail(result.storyIds[0]!).videoId,'dates000002')
  assert.match(result.errors[0]!,/metadata unavailable/)
})

test('batch publication uses each story generated copy while preserving selected account, declaration and watermark', async t => {
  const f = fixture(t), uploaded: SocialUploadPayload[] = []
  const accountName = 'mystery_' + 'c'.repeat(32)
  const publicationSettings = { creationDeclaration: '含AI生成内容', watermark: '不添加水印' }
  const input = { requestId: 'batch-publish-specific', urls: ['https://www.youtube.com/@stories/videos'], targetCount: 2,
    target: 'publish' as const, huashengAccountName: f.accountNames[0]!, baijiahaoAccountName: accountName, publicationSettings }
  assert.throws(() => f.service.startCollection({ ...input, baijiahaoAccountName: null }), /百家号账号/)
  assert.equal(f.tasks.size, 0)
  f.options.collect = async opts => {
    for (let index = 0; index < 2; index++) {
      const videoId = 'story' + String(index).padStart(6, '0')
      await opts.onCandidate({ videoId, sourceUrl: 'https://www.youtube.com/watch?v=' + videoId, title: ['旧木门', '窗边的脚印'][index]!,
        authorName: '测试频道', durationSeconds: 90, observedAt: '', collectionUrl: opts.url })
    }
  }
  const download = f.options.download!
  f.options.download = async (...args) => ({ ...await download(...args), title: args[0].sourceUrl.endsWith('0') ? '旧木门' : '窗边的脚印' })
  f.options.publishingCopy = async input => ({ titleCandidates: [input.sourceTitle + '为何留下疑问', input.sourceTitle + '的往事'],
    title: input.sourceTitle + '为何留下疑问', description: '跟随调查寻找' + input.sourceTitle + '的线索', tags: [input.sourceTitle, '未解故事'],
    scriptHash: hashMysteryText(input.script), evidence: [], checkedAt: new Date().toISOString() })
  f.options.uploadRuntime = { ...f.options.uploadRuntime!,
    inspectSocialUploadCheckpoint: async () => ({ action: 'upload', phase: 'new', message: '尚未发送' }),
    inspectSocialUploadAccountRuntime: async name => { assert.equal(name, accountName); return { ready: true, message: 'ready' } },
    runSocialUpload: async payload => {
      uploaded.push(structuredClone(payload))
      return { accountName: payload.accountName, staged: true, saved: false, published: false, submitted: true, publicationStatus: 'submitted',
        articleId: String(12345 + uploaded.length), targetId: 'abc123', engine: 'fixture', editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2' }
    },
  }
  const collection = f.service.startCollection(input)
  assert.deepEqual(f.tasks.get(collection.taskId!)!.payload.publicationSettings, publicationSettings)
  await f.service.executeCollection(collection.id, f.ctx(collection.taskId!))
  f.tasks.get(collection.taskId!)!.status = 'succeeded'
  const accepted = f.store.collection(collection.id)
  assert.equal(accepted.storyIds.length, 2)
  for (const id of accepted.storyIds) {
    const run = f.service.detail(id).runs[0]!, task = f.tasks.get(run.taskId!)!
    assert.equal(task.payload.useGeneratedPublicationCopy, true)
    assert.equal(task.payload.publication.creationDeclaration, publicationSettings.creationDeclaration)
    assert.equal(task.payload.publication.watermark, publicationSettings.watermark)
    await f.execute(id, run.id)
    const edition = f.service.detail(id).editions[0]!
    assert.equal(edition.publication!.title, edition.publishingCopy!.title)
    assert.equal(edition.publication!.description, edition.publishingCopy!.description)
    assert.deepEqual(edition.publication!.tags, edition.publishingCopy!.tags)
    assert.equal(edition.publication!.status, 'submitted')
  }
  assert.deepEqual(uploaded.map(payload => payload.title), ['旧木门为何留下疑问', '窗边的脚印为何留下疑问'])
  assert.notEqual(uploaded[0]!.description, uploaded[1]!.description)
  assert.notDeepEqual(uploaded[0]!.tags, uploaded[1]!.tags)
  for (const payload of uploaded) {
    assert.equal(payload.accountName, accountName)
    assert.equal(payload.creationDeclaration, publicationSettings.creationDeclaration)
    assert.equal(payload.watermark, publicationSettings.watermark)
    assert.equal(payload.publicationMode, 'publish')
  }
})

