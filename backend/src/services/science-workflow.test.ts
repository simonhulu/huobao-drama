import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { ScienceWorkflowService, type ScienceWorkflowOptions } from './science-workflow.js'
import { SocialUploadAccountsService } from './social-upload-accounts.js'
import { ScienceHuashengAccountsService } from './science-accounts.js'
import { HuashengExportApiError } from './history-huasheng-export-api.js'
import { HuashengBrowserError, type HuashengBrowserInput } from './history-huasheng-browser.js'
import type { SocialUploadPayload, SocialUploadResult } from './social-auto-upload.js'
import { createScienceWorkflowRoute } from '../routes/science-workflow.js'
import { createScienceAccountsRoute } from '../routes/science-accounts.js'
import { ScienceCollectionService } from './science-collection.js'
import { SCIENCE_WRITING_VERSION, type ScienceWritingCheckpoint } from './science-script.js'

const sourceVideoHash = createHash('sha256').update('source-video').digest('hex')

function fixture(t: any, overrides: Partial<ScienceWorkflowOptions> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'science-workflow-')))
  const hs = new ScienceHuashengAccountsService({ stateRoot: path.join(root, 'huasheng'), driver: async () => ({ status: 'ready', message: 'ready', identity: { uid: '2002', displayName: '科普用户' } }) })
  const bjh = new SocialUploadAccountsService({ stateRoot: path.join(root, 'baijiahao'), accountPrefix: 'science', driver: async () => ({ ready: true }) })
  const h = hs.create({ label: '科普华生' }), b = bjh.create({ label: '科普百家号' })
  const calls = { download: 0, transcribe: 0, rewrite: 0, produce: 0, productionInspect: 0, browserInspect: 0, export: 0, downloadExport: 0, upload: 0, save: 0, checkpoint: 0 }
  const uploads = new Map<string, SocialUploadResult>()
  const payloads: SocialUploadPayload[] = []
  const config = { ...hs.browserConfig(h.accountName), expectedUid: '2002' }
  const browser = {
    runHuashengBrowserJob: async (input: HuashengBrowserInput) => { calls.produce++; assert.equal(input.checkpoint, 'opening'); assert.deepEqual(input.browserConfig, config)
      assert.equal(input.voiceId, 1595608); assert.equal(input.voiceType, 1)
      await input.onCheckpoint({ checkpoint: 'create_pending', message: '创建中' })
      await input.onCheckpoint({ checkpoint: 'submitted', projectUrl: 'https://www.huasheng.cn/video/12345', message: '已开始制作' })
      return { projectUrl: 'https://www.huasheng.cn/video/12345' }
    },
    inspectHuashengProject: async () => { calls.browserInspect++; throw new Error('导出窗口未响应，保留上次创作状态') },
  }
  const options: ScienceWorkflowOptions = { root: path.join(root, 'jobs'), huashengAccounts: hs, baijiahaoAccounts: bjh, pollMs: 0, retryDelayMs: 0, presenterMode: 'none',
    prepareVideo: async input => ({ videoPath: input.videoPath, introSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64) }),
    prepareIntroVideo: async input => ({ videoPath: input.videoPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(input.videoPath)).digest('hex') }),
    prepareIntroPreview: async input => ({ videoPath: input.videoPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(input.videoPath)).digest('hex') }),
    preparePresenter: async input => ({ presenterPath: input.videoPath, sourceSha256: createHash('sha256').update(fs.readFileSync(input.videoPath)).digest('hex') }),
    download: async (input, opts) => {
      calls.download++; const videoPath = path.join(input.directory, 'source.mp4'); fs.writeFileSync(videoPath, 'source-video')
      const media = { videoPath, videoSha256: sourceVideoHash, downloadState: 'done' }; opts.onMedia(media)
      return { title: 'Why ice floats', author: 'source-channel', media }
    },
    transcribe: async () => { calls.transcribe++; return 'Water expands as it freezes, lowering its density.' },
    rewrite: async (input, opts) => {
      calls.rewrite++
      const plan = { sourceHash: 'hash', sourceSummary: '水冻结后密度降低', angle: '冰为什么浮起来', outline: ['提出问题', '解释结构'], facts: ['结冰时体积膨胀'], factChecks: [{ claim: '具体膨胀比例', note: '核对温度和压力条件' }] }
      opts.onPlan?.(plan)
      return { title: '冰为什么能浮在水上', script: '冰浮在水上，关键是密度。结冰时，水分子排列形成较疏松的结构。', plan }
    },
    browser,
    exportApi: {
      inspectHuashengProduction: async input => { calls.productionInspect++; assert.deepEqual(input.browserConfig, config); return { status: 'completed', message: '完成' } },
      createHuashengExport: async input => { calls.export++; assert.deepEqual(input.browserConfig, config); await input.onDispatched?.(); return { taskId: 'task1', projectHash: 'a'.repeat(64) } },
      inspectHuashengExport: async input => { assert.deepEqual(input.browserConfig, config); return { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: '成片.mp4' } },
      downloadHuashengExport: async (input, opt) => { calls.downloadExport++; assert.deepEqual(input.browserConfig, config); const filePath = path.join(opt!.root!, 'video.mp4'); fs.mkdirSync(opt!.root!, { recursive: true }); fs.writeFileSync(filePath, 'finished-video'); return { filePath, filename: '成片.mp4', bytes: 14 } },
    },
    prepareAssets: async input => {
      const landscapePath = path.join(input.directory, 'landscape.jpg'), portraitPath = path.join(input.directory, 'portrait.jpg')
      if (!fs.existsSync(landscapePath)) await sharp({ create: { width: 1280, height: 720, channels: 3, background: input.revision > 1 ? '#123456' : '#345678' } }).jpeg().toFile(landscapePath)
      if (!fs.existsSync(portraitPath)) await sharp({ create: { width: 810, height: 1080, channels: 3, background: input.revision > 1 ? '#123456' : '#345678' } }).jpeg().toFile(portraitPath)
      const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      return { videoSha256: hash(input.videoPath), landscapePath, portraitPath, landscapeSha256: hash(landscapePath), portraitSha256: hash(portraitPath) }
    },
    uploadRuntime: {
      inspectSocialUploadCheckpoint: async payload => { calls.checkpoint++; const result = uploads.get(payload.jobId)
        return result ? { action: result.submitted ? 'complete' : 'save', phase: result.submitted ? 'submitted' : 'staged', message: 'checkpoint', result } : { action: 'upload', phase: 'new', message: 'new' } },
      inspectSocialUploadAccountRuntime: async name => { assert.equal(name, b.accountName); return { ready: true, message: 'ready' } },
      inspectSocialUploadRuntime: async () => { throw new Error('不得回退到历史或CBA默认账号') },
      runSocialUpload: async payload => {
        calls.upload++; payloads.push(payload); assert.equal(payload.accountName, b.accountName); assert.equal(payload.publicationMode, 'publish')
        const result: SocialUploadResult = { accountName: payload.accountName, staged: true, saved: false, published: false, editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', targetId: 'abc123', engine: 'fixture' }
        uploads.set(payload.jobId, result); return result
      },
      confirmSocialUpload: async (payload, previous) => { calls.save++; const result = { ...previous, saved: false, submitted: true, published: false, publicationStatus: 'submitted' as const, articleId: '12345', publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=12345' }; uploads.set(payload.jobId, result); return result },
      resumeSocialUpload: async () => { throw new Error('unexpected resume') }, reconcileSocialUpload: async () => { throw new Error('unexpected reconcile') },
      resetSocialUploadAttempt: async (_payload, options) => { assert.equal(options?.allowDuplicateSubmission, true); return {} },
    }, ...overrides,
  }
  const service = new ScienceWorkflowService(options)
  const route = createScienceWorkflowRoute({ service, accounts: createScienceAccountsRoute({ huasheng: hs, baijiahao: bjh }) })
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  return { service, route, hs, bjh, h, b, calls, root, payloads, options }
}
const sourceUrl = 'https://youtu.be/abcdefghijk'
async function prepared(h: ReturnType<typeof fixture>, url = sourceUrl) {
  const job = h.service.create({ sourceUrl: url }, { defer: true })
  h.service.prepare(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'draft')
  return h.service.detail(job.id)
}

function legacyFinishedVideo(h: ReturnType<typeof fixture>, id: string) {
  const directory = path.join(h.root, 'jobs', id), file = path.join(directory, 'job.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  const videoPath = path.join(directory, 'finished.mp4')
  fs.writeFileSync(videoPath, 'finished-video')
  fs.writeFileSync(file, JSON.stringify({ ...stored, videoPath, status: 'ready', stage: 'export' }))
  return { file, videoPath }
}

function pendingHuasheng(h: ReturnType<typeof fixture>, id: string, patch: Record<string, unknown> = {}) {
  const file = path.join(h.root, 'jobs', id, 'job.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...stored, projectUrl: 'https://www.huasheng.cn/video/12345',
    productionScriptHash: createHash('sha256').update(stored.script).digest('hex'), productionAccountName: stored.huashengAccountName,
    checkpoint: 'submitted', stage: 'produce', status: 'needs_attention', message: '旧的状态查询失败', ...patch }))
  return file
}

test('intro-only science productions submit only the main narration and prepend the intro without any presenter or lip sync', async t => {
  const h = fixture(t), job = await prepared(h), order: string[] = []
  const greeting = '大家好，我是小鹭，你们的冷知识讲解员。'
  const mainScript = job.script
  h.service.patch(job.id, { script: greeting + mainScript })
  const browser = h.options.browser!.runHuashengBrowserJob
  h.options.browser!.runHuashengBrowserJob = async input => {
    assert.equal(input.script, mainScript)
    order.push('produce')
    return browser(input)
  }
  let finalPath = ''
  h.options.prepareIntroPreview = async () => assert.fail('production must not render an intermediate preview')
  h.options.preparePresenter = async () => assert.fail('default production must not submit lip-sync inference')
  h.options.prepareVideo = async () => assert.fail('default production must not require a synced presenter')
  h.options.prepareIntroVideo = async input => {
    order.push('intro-only')
    assert.equal(fs.readFileSync(input.videoPath, 'utf8'), 'finished-video')
    fs.mkdirSync(input.directory, { recursive: true })
    finalPath = path.join(input.directory, 'with-intro.mp4')
    fs.writeFileSync(finalPath, 'intro+finished-video')
    return { videoPath: finalPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(input.videoPath)).digest('hex') }
  }
  const assets = h.options.prepareAssets!
  h.options.prepareAssets = async (input, options) => {
    order.push('covers')
    assert.equal(input.videoPath, finalPath)
    return assets(input, options)
  }
  h.service.produce(job.id, true); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'completed')
  assert.equal(h.service.detail(job.id).script, mainScript)
  assert.deepEqual(order, ['produce', 'intro-only', 'covers'])
  assert.equal(h.payloads[0]?.videoPath, finalPath)
  assert.equal(h.service.asset(job.id, 'video'), finalPath)
  const publicJob = h.service.detail(job.id) as unknown as Record<string, unknown>
  assert.equal(publicJob.mainVideoPath, undefined); assert.equal(publicJob.presenterPath, undefined)
})

test('new default science production uses remote MuseTalk once and composes the original main with a closeup circle', async t => {
  const previous = process.env.SCIENCE_PRESENTER_MODE
  delete process.env.SCIENCE_PRESENTER_MODE
  t.after(() => { if (previous === undefined) delete process.env.SCIENCE_PRESENTER_MODE; else process.env.SCIENCE_PRESENTER_MODE = previous })
  const h = fixture(t, { presenterMode: undefined }), job = await prepared(h)
  const order: string[] = []
  h.options.prepareIntroPreview = async () => assert.fail('MuseTalk must not render a full intermediate intro preview')
  h.options.preparePresenter = async () => assert.fail('MuseTalk must not call the LatentSync runtime')
  h.options.prepareIntroVideo = async () => assert.fail('a successful MuseTalk result must retain the circle')
  h.options.prepareMusetalkPresenter = async input => {
    assert.equal(h.service.detail(job.id).exportStep, 'presenter')
    order.push('musetalk')
    assert.equal(fs.readFileSync(input.videoPath, 'utf8'), 'finished-video')
    assert.equal(path.basename(input.directory), 'presenter-musetalk')
    return { presenterPath: input.videoPath, sourceSha256: createHash('sha256').update(fs.readFileSync(input.videoPath)).digest('hex') }
  }
  h.options.prepareVideo = async (input, options) => {
    assert.equal(h.service.detail(job.id).exportStep, 'compose')
    order.push('compose')
    assert.equal(options.presenterFraming, 'closeup')
    assert.equal(options.presenterPath, input.videoPath)
    assert.equal(fs.readFileSync(input.videoPath, 'utf8'), 'finished-video')
    return { videoPath: input.videoPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(input.videoPath)).digest('hex') }
  }
  h.service.produce(job.id, true); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'completed')
  assert.equal(h.service.detail(job.id).exportStep, undefined)
  assert.deepEqual(order, ['musetalk', 'compose'])
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.upload, 1)
})

test('export substeps distinguish platform rendering, download and local composition until covers begin', async t => {
  const h = fixture(t), job = await prepared(h), steps: string[] = []
  const api = h.options.exportApi!
  h.options.exportApi = { ...api,
    createHuashengExport: async input => {
      assert.equal(h.service.detail(job.id).exportStep, 'platform')
      steps.push('platform')
      return api.createHuashengExport(input)
    },
    inspectHuashengExport: async input => {
      assert.equal(h.service.detail(job.id).exportStep, 'platform')
      return api.inspectHuashengExport(input)
    },
    downloadHuashengExport: async (input, options) => {
      assert.equal(h.service.detail(job.id).exportStep, 'download')
      steps.push('download')
      return api.downloadHuashengExport(input, options)
    },
  }
  const intro = h.options.prepareIntroVideo!, covers = h.options.prepareAssets!
  h.options.prepareIntroVideo = async (input, options) => {
    assert.equal(h.service.detail(job.id).exportStep, 'compose')
    steps.push('compose')
    return intro(input, options)
  }
  h.options.prepareAssets = async (input, options) => {
    assert.equal(h.service.detail(job.id).exportStep, undefined)
    assert.equal(h.service.detail(job.id).stage, 'covers')
    steps.push('covers')
    return covers(input, options)
  }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.service.detail(job.id).exportStep, undefined)
  assert.deepEqual(steps, ['platform', 'download', 'compose', 'covers'])
})

test('a MuseTalk timeout falls back to intro-only delivery without blocking automatic production', async t => {
  const h = fixture(t, { presenterMode: 'musetalk' }), job = await prepared(h)
  let fallback = 0
  h.options.prepareMusetalkPresenter = async () => { throw new Error('MuseTalk 已达到处理时限') }
  h.options.prepareVideo = async () => assert.fail('failed lip-sync must not compose an unverified presenter')
  const prepare = h.options.prepareIntroVideo!
  h.options.prepareIntroVideo = async (input, options) => { fallback++; return prepare(input, options) }
  h.service.produce(job.id, true); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'completed')
  assert.equal(fallback, 1); assert.equal(h.calls.upload, 1)
  assert.ok(result.logs.some(log => /MuseTalk.*自动保留固定片头/.test(log.message)))
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, 'jobs', job.id, 'job.json'), 'utf8')).presenterPath, undefined)
})

test('cancelling MuseTalk production never falls back to rendering or uploading', async t => {
  const h = fixture(t, { presenterMode: 'musetalk' }), job = await prepared(h)
  let started!: () => void
  const generating = new Promise<void>(resolve => { started = resolve })
  h.options.prepareMusetalkPresenter = async (_input, options) => {
    started()
    await new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    throw new Error('unreachable')
  }
  h.options.prepareVideo = async () => assert.fail('cancelled work must not compose a circle')
  h.options.prepareIntroVideo = async () => assert.fail('cancelled work must not fall back')
  h.service.produce(job.id, true)
  await generating
  h.service.cancel(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'paused')
  assert.equal(h.calls.upload, 0)
})

test('a pending legacy lip-sync task resumes locally from its original main without inference or re-export', async t => {
  const h = fixture(t), job = await prepared(h)
  const { file, videoPath: mainPath } = legacyFinishedVideo(h, job.id)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  const previewPath = path.join(h.root, 'jobs', job.id, 'old-preview.mp4')
  fs.writeFileSync(previewPath, 'preview')
  fs.writeFileSync(file, JSON.stringify({ ...stored, separateIntro: true, productionCompleted: true,
    projectUrl: 'https://www.huasheng.cn/video/12345', mainVideoPath: mainPath, videoPath: previewPath,
    videoCompositionPending: true, presenterPath: 'old-sync.mp4', status: 'paused' }))
  h.options.preparePresenter = async () => assert.fail('cancelled inference must not resume')
  h.options.prepareIntroPreview = async () => assert.fail('existing preview must not be rendered again')
  h.options.prepareIntroVideo = async input => {
    assert.equal(input.videoPath, mainPath)
    const videoPath = path.join(input.directory, 'intro-final.mp4')
    fs.mkdirSync(input.directory, { recursive: true }); fs.writeFileSync(videoPath, 'intro+main')
    return { videoPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(mainPath)).digest('hex') }
  }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.service.detail(job.id).videoCompositionPending, false)
  assert.notEqual(h.service.asset(job.id, 'video'), previewPath)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).presenterPath, undefined)
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 0); assert.equal(h.calls.downloadExport, 0)
  const final = h.service.asset(job.id, 'video')
  h.service.previewIntro(job.id); await h.service.waitForIdle()
  assert.equal(h.service.asset(job.id, 'video'), final)
})

test('existing submitted, completed and locally downloaded projects verify their voice before resuming delivery', async t => {
  for (const state of ['submitted', 'completed', 'preview'] as const) {
    const h = fixture(t), job = await prepared(h)
    const videoPath = path.join(h.root, 'jobs', job.id, 'wrong-voice-preview.mp4')
    if (state === 'preview') fs.writeFileSync(videoPath, 'wrong-voice-preview')
    pendingHuasheng(h, job.id, {
      productionCompleted: state !== 'submitted',
      ...(state === 'preview' ? { videoPath, videoCompositionPending: true } : {}),
    })
    let inspected = 0
    h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
      inspected++
      assert.deepEqual(input.expectedVoice, { id: 1595608, type: 1, name: '音色小鹭' })
      throw new HuashengExportApiError('invalid_response', '花生原项目音色与指定音色 1595608 不一致')
    } }
    h.options.preparePresenter = async () => assert.fail('wrong audio must not drive another presenter generation')
    h.service.produce(job.id, true); await h.service.waitForIdle()
    assert.equal(inspected, 1)
    assert.equal(h.service.detail(job.id).status, 'needs_attention')
    assert.match(h.service.detail(job.id).message, /音色.*不一致/)
    assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 0)
    assert.equal(h.calls.downloadExport, 0); assert.equal(h.calls.upload, 0)
  }
})

test('a failed presenter generation resumes against the original main after restart and cannot deliver a mismatched narration', async t => {
  const h = fixture(t, { presenterMode: 'sync' }), job = await prepared(h)
  let attempts = 0, composites = 0
  const generate = h.options.preparePresenter!
  h.options.preparePresenter = async (input, options) => {
    assert.equal(fs.readFileSync(input.videoPath, 'utf8'), 'finished-video')
    if (++attempts === 1) throw new Error('主播口型生成暂时中断')
    return generate(input, options)
  }
  h.options.prepareVideo = async input => { composites++; return { videoPath: input.videoPath, introSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64) } }
  h.service.produce(job.id, true); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention')
  assert.equal(h.service.detail(job.id).stage, 'export')
  assert.equal(composites, 0); assert.equal(h.calls.upload, 0)
  await h.service.stop()
  const restarted = new ScienceWorkflowService(h.options)
  t.after(() => restarted.stop())
  restarted.produce(job.id, true); await restarted.waitForIdle()
  assert.equal(restarted.detail(job.id).status, 'completed')
  assert.equal(attempts, 2); assert.equal(composites, 1)
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)

  const second = await prepared(h, 'https://youtu.be/lmnopqrstuv')
  h.options.preparePresenter = async input => ({ presenterPath: input.videoPath, sourceSha256: 'c'.repeat(64) })
  h.service.produce(second.id, true); await h.service.waitForIdle()
  assert.equal(h.service.detail(second.id).status, 'needs_attention')
  assert.match(h.service.detail(second.id).message, /主播口播与正片版本不一致/)
  assert.equal(composites, 1); assert.equal(h.calls.upload, 1)
})

test('a presenter failure retains the actual intro preview and resumes from the original narration without publishing the preview', async t => {
  const h = fixture(t, { presenterMode: 'sync' }), job = await prepared(h)
  const generate = h.options.preparePresenter!
  let previewPath = '', mainPath = ''
  h.options.prepareIntroPreview = async input => {
    mainPath = input.videoPath
    assert.equal(fs.readFileSync(mainPath, 'utf8'), 'finished-video')
    fs.mkdirSync(input.directory, { recursive: true })
    previewPath = path.join(input.directory, 'intro-preview.mp4')
    fs.writeFileSync(previewPath, 'intro+finished-video')
    return { videoPath: previewPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(mainPath)).digest('hex') }
  }
  h.options.preparePresenter = async () => { throw new Error('Intone 额度不足') }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  const pending = h.service.detail(job.id)
  assert.equal(pending.status, 'needs_attention')
  assert.equal(pending.videoCompositionPending, true)
  assert.equal(h.service.asset(job.id, 'video'), previewPath)
  assert.equal(fs.readFileSync(previewPath, 'utf8'), 'intro+finished-video')
  assert.equal(pending.uploadStatus, 'not_ready')
  assert.throws(() => h.service.upload(job.id), /预览.*合成/)
  assert.throws(() => h.service.covers(job.id), /合成.*封面/)
  assert.equal(h.calls.upload, 0)
  h.options.preparePresenter = generate
  h.options.prepareVideo = async input => {
    assert.equal(input.videoPath, mainPath)
    const videoPath = path.join(h.root, 'jobs', job.id, 'full-with-presenter.mp4')
    fs.writeFileSync(videoPath, 'intro+main+presenter')
    return { videoPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(mainPath)).digest('hex') }
  }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.service.detail(job.id).videoCompositionPending, false)
  assert.notEqual(h.service.detail(job.id).videoUrl, pending.videoUrl, 'the player reloads when the preview is replaced by the completed composition')
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)
  assert.equal(h.calls.upload, 0)
})

test('repairing an intro preview reuses the local main without dispatching any presenter, export or publication', async t => {
  const h = fixture(t), job = await prepared(h)
  const { file } = legacyFinishedVideo(h, job.id)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...saved, separateIntro: true, status: 'needs_attention', autoUpload: true }))
  h.options.preparePresenter = async () => { throw new Error('preview repair must not spend credits') }
  h.service.previewIntro(job.id); await h.service.waitForIdle()
  const repaired = h.service.detail(job.id)
  assert.equal(repaired.videoCompositionPending, true)
  assert.equal(repaired.status, 'needs_attention')
  assert.equal(repaired.autoUpload, true)
  assert.match(repaired.message, /片头已拼接/)
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 0); assert.equal(h.calls.upload, 0)
})

test('intro composition resumes the downloaded main video after a service restart without exporting or submitting again', async t => {
  const h = fixture(t), job = await prepared(h)
  let attempts = 0
  h.options.prepareIntroVideo = async input => {
    if (++attempts === 1) throw new Error('片头拼接中断')
    assert.equal(fs.readFileSync(input.videoPath, 'utf8'), 'finished-video')
    return { videoPath: input.videoPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(input.videoPath)).digest('hex') }
  }
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention')
  assert.equal(h.service.detail(job.id).stage, 'export')
  await h.service.stop()
  const restarted = new ScienceWorkflowService(h.options)
  t.after(() => restarted.stop())
  restarted.produce(job.id); await restarted.waitForIdle()
  assert.equal(restarted.detail(job.id).status, 'ready')
  assert.equal(attempts, 2)
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)
})

test('batch continuation after restart finishes a pending presenter before covers and never publishes the intro preview', async t => {
  const h = fixture(t, { presenterMode: 'sync' }), job = await prepared(h)
  const generate = h.options.preparePresenter!
  let presenterAttempts = 0, mainPath = '', previewPath = '', finalPath = ''
  h.options.prepareIntroPreview = async input => {
    mainPath = input.videoPath
    fs.mkdirSync(input.directory, { recursive: true })
    previewPath = path.join(input.directory, 'intro-preview.mp4')
    fs.writeFileSync(previewPath, 'intro+main-preview')
    return { videoPath: previewPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(mainPath)).digest('hex') }
  }
  h.options.preparePresenter = async (input, options) => {
    assert.equal(fs.readFileSync(input.videoPath, 'utf8'), 'finished-video')
    if (++presenterAttempts === 1) throw new Error('口型生成中断')
    return generate(input, options)
  }
  h.options.prepareVideo = async input => {
    assert.equal(input.videoPath, mainPath)
    finalPath = path.join(input.directory, 'complete-with-presenter.mp4')
    fs.writeFileSync(finalPath, 'intro+main+presenter')
    return { videoPath: finalPath, introSha256: 'a'.repeat(64), sourceSha256: createHash('sha256').update(fs.readFileSync(mainPath)).digest('hex') }
  }
  h.service.produce(job.id, true); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).videoCompositionPending, true)
  assert.ok(h.service.detail(job.id).videoUrl, 'a playable preview is still an incomplete composition')
  assert.equal(h.calls.upload, 0)
  await h.service.stop()
  const restarted = new ScienceWorkflowService(h.options)
  t.after(() => restarted.stop())
  const completed = await restarted.runBatchJob(job.id, 'upload', new AbortController().signal)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.videoCompositionPending, false)
  assert.equal(presenterAttempts, 2)
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)
  assert.equal(h.calls.upload, 1); assert.equal(h.payloads[0]?.videoPath, finalPath)
  assert.notEqual(finalPath, previewPath)
})

test('unsubmitted legacy narration is cleaned with its local hash while submitted projects retain their original binding', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  const script = '大家好，我是小鹭，你们的冷知识讲解员。' + saved.script
  const oldHash = createHash('sha256').update(script).digest('hex')
  fs.writeFileSync(file, JSON.stringify({ ...saved, script, productionScriptHash: oldHash, productionAccountName: saved.huashengAccountName, checkpoint: 'opening' }))
  assert.equal(h.service.detail(job.id).script, saved.script)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).productionScriptHash, createHash('sha256').update(saved.script).digest('hex'))
  fs.writeFileSync(file, JSON.stringify({ ...saved, script, productionScriptHash: oldHash, productionAccountName: saved.huashengAccountName,
    projectUrl: 'https://www.huasheng.cn/video/12345', checkpoint: 'submitted' }))
  let intros = 0
  h.options.prepareVideo = async () => { intros++; throw new Error('must retain original project') }
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.service.detail(job.id).script, script)
  assert.equal(intros, 0)
})

test('ambiguous publications automatically retry with fresh persisted identities until a trusted submission', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const checkpoint = h.options.uploadRuntime!.inspectSocialUploadCheckpoint
  const confirm = h.options.uploadRuntime!.confirmSocialUpload
  let confirmations = 0, resets = 0
  const uncertain = new Set<string>()
  h.options.uploadRuntime!.confirmSocialUpload = async (payload, result, options) => {
    if (++confirmations < 6) { uncertain.add(payload.jobId); throw new Error('发表响应已丢失') }
    return confirm(payload, result, options)
  }
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async payload => uncertain.has(payload.jobId)
    ? { action: 'manual', phase: 'publish_requested', message: '发表结果不明确' } : checkpoint(payload)
  h.options.uploadRuntime!.resetSocialUploadAttempt = async (payload, options) => {
    assert.equal(options?.allowDuplicateSubmission, true)
    assert.ok(uncertain.has(payload.jobId)); resets++; return {}
  }
  h.service.upload(job.id); await h.service.waitForIdle()
  const accounts = new Set<string>(), identities = new Set<string>()
  for (let attempt = 1; attempt <= 5; attempt++) {
    const current = h.service.detail(job.id)
    assert.equal(current.status, 'retry_wait'); assert.equal(current.uploadStatus, 'queued')
    assert.equal(current.uploadRetry?.attempt, attempt); assert.equal(current.executionActive, false)
    assert.match(current.message, /自动.*重传/)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    identities.add(stored.uploadAttempt.id); accounts.add(stored.uploadAttempt.accountName)
    const before = h.calls.upload
    assert.deepEqual(h.service.runAutomaticExports(), [])
    assert.equal(h.calls.upload, before, 'backoff does not dispatch early')
    stored.uploadRetry.nextRetryAt = new Date(0).toISOString()
    fs.writeFileSync(file, JSON.stringify(stored))
    assert.deepEqual(h.service.runAutomaticExports(), [job.id]); await h.service.waitForIdle()
  }
  const completed = h.service.detail(job.id), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  identities.add(stored.uploadAttempt.id)
  assert.equal(completed.status, 'completed'); assert.equal(completed.uploadStatus, 'submitted')
  assert.equal(completed.uploadRetry, undefined); assert.equal(h.calls.upload, 6); assert.equal(resets, 5)
  assert.equal(identities.size, 6); assert.deepEqual([...accounts], [h.b.accountName])
  assert.equal(stored.uploadHistory.length, 5)
  assert.ok(stored.uploadHistory.every((item: any) => item.attempt.payload.videoPath === stored.uploadAttempt.payload.videoPath))
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1)
})

test('stopping an automatic reupload cancels its schedule and manual continuation can still retry', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const checkpoint = h.options.uploadRuntime!.inspectSocialUploadCheckpoint
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'unknown', message: '上传结果不明' })
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'retry_wait')
  h.service.cancel(job.id)
  assert.equal(h.service.detail(job.id).status, 'paused'); assert.equal(h.service.detail(job.id).uploadRetry, undefined)
  assert.deepEqual(h.service.runAutomaticExports(), [])
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = checkpoint
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'completed'); assert.equal(h.calls.upload, 1)
})

test('automatic upload retry resumes after a service restart and migrates old uncertain jobs', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const checkpoint = h.options.uploadRuntime!.inspectSocialUploadCheckpoint
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'publish_requested', message: '上传结果待核对' })
  h.service.upload(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  stored.status = 'needs_attention'; stored.autoUpload = false
  delete stored.uploadRetry
  fs.writeFileSync(file, JSON.stringify(stored))
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = checkpoint
  const restarted = new ScienceWorkflowService(h.options)
  t.after(() => restarted.stop())
  assert.equal(restarted.detail(job.id).uploadStatus, 'queued')
  assert.deepEqual(restarted.runAutomaticExports(), [job.id]); await restarted.waitForIdle()
  assert.equal(restarted.detail(job.id).status, 'completed'); assert.equal(h.calls.upload, 1)
})

test('upload reattempts stop for actual platform blockers and mismatched receipt accounts', async t => {
  for (const message of ['需要登录并完成安全验证', '今日发布次数已达上限', '账号无发表权限']) {
    const h = fixture(t), job = await prepared(h)
    h.service.produce(job.id); await h.service.waitForIdle()
    h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'blocked', message })
    h.service.upload(job.id); await h.service.waitForIdle()
    const current = h.service.detail(job.id)
    assert.equal(current.status, 'needs_attention', message); assert.equal(current.uploadStatus, 'blocked')
    assert.equal(current.uploadRetry, undefined); assert.deepEqual(h.service.runAutomaticExports(), [])
  }
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const upload = h.options.uploadRuntime!.runSocialUpload
  h.options.uploadRuntime!.runSocialUpload = async (...args) => ({ ...await upload(...args), accountName: 'other-account' })
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention')
  assert.equal(h.service.detail(job.id).uploadRetry, undefined); assert.equal(h.calls.save, 0)
  assert.deepEqual(h.service.runAutomaticExports(), [])
})

test('a delayed trusted submission is adopted before a replacement upload and cancelled reset never dispatches', async t => {
  for (const cancel of [false, true]) {
    const h = fixture(t), job = await prepared(h)
    h.service.produce(job.id); await h.service.waitForIdle()
    h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'publish_requested', message: '发表结果不明确' })
    h.service.upload(job.id); await h.service.waitForIdle()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), hold = new Promise<void>(resolve => { release = resolve })
    h.options.uploadRuntime!.resetSocialUploadAttempt = async () => {
      entered(); await hold
      return cancel ? {} : { result: { accountName: h.b.accountName, staged: true, saved: false, submitted: true, published: false,
        publicationStatus: 'submitted', articleId: '12345', targetId: 'abc123', engine: 'fixture',
        editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2' } }
    }
    h.service.upload(job.id); await started
    if (cancel) h.service.cancel(job.id)
    release(); await h.service.waitForIdle()
    const current = h.service.detail(job.id)
    assert.equal(current.status, cancel ? 'paused' : 'completed')
    assert.equal(current.uploadRetry, undefined); assert.equal(h.calls.upload, 0)
    assert.deepEqual(h.service.runAutomaticExports(), [])
  }
})

test('a replacement upload retains its own account verification window and rejects a foreign attempt identity', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'unknown', message: '上传结果不明' })
  h.service.upload(job.id); await h.service.waitForIdle()
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'blocked', message: '需要安全验证' })
  h.service.upload(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.match(stored.uploadAttempt.id, /-retry-/)
  h.options.reviewUpload = async payload => {
    assert.equal(payload.jobId, stored.uploadAttempt.id); assert.equal(payload.accountName, h.b.accountName)
    return { jobId: payload.jobId, targetId: 'abc123', url: 'https://baijiahao.baidu.com/builder/rc/content',
      imageDataUrl: 'data:image/jpeg;base64,AAAA', width: 1440, height: 1000, originalEditor: false, message: '账号安全验证' }
  }
  assert.equal((await h.service.reviewUpload(job.id)).jobId, job.id)
  h.service.checkUpload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).uploadCheck?.status, 'needs_attention')
  stored.uploadAttempt.id = `science-${randomUUID()}-baijiahao-retry-${randomUUID()}`
  stored.uploadAttempt.payload.jobId = stored.uploadAttempt.id
  fs.writeFileSync(file, JSON.stringify(stored))
  assert.throws(() => h.service.checkUpload(job.id), /上传记录与原账号或任务不一致/)
  await assert.rejects(h.service.reviewUpload(job.id), /上传记录与原账号或任务不一致/)
})

test('a temporary reset failure preserves automatic retry intent until the next successful upload', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const checkpoint = h.options.uploadRuntime!.inspectSocialUploadCheckpoint
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'publish_requested', message: '发表结果不明' })
  h.service.upload(job.id); await h.service.waitForIdle()
  let resets = 0
  h.options.uploadRuntime!.resetSocialUploadAttempt = async () => {
    if (++resets === 1) throw new Error('ETIMEDOUT：原编辑页连接超时')
    return {}
  }
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'retry_wait'); assert.equal(h.calls.upload, 0)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(stored.uploadRestartPending, true)
  stored.uploadRetry.nextRetryAt = new Date(0).toISOString()
  fs.writeFileSync(file, JSON.stringify(stored))
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = checkpoint
  assert.deepEqual(h.service.runAutomaticExports(), [job.id]); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'completed'); assert.equal(resets, 2); assert.equal(h.calls.upload, 1)
})

test('a failed receipt recovery cannot mark a stale unverified submission as completed', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  h.options.uploadRuntime!.inspectSocialUploadAccountRuntime = async () => ({ ready: false, message: '请登录' })
  h.service.upload(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  const receipt = { accountName: 'other-account', staged: true as const, saved: false, submitted: true, published: false,
    publicationStatus: 'submitted' as const, articleId: '12345', targetId: 'abc123', engine: 'fixture',
    editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2' }
  stored.uploadAttempt.result = receipt; stored.upload = null
  fs.writeFileSync(file, JSON.stringify(stored))
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'complete', phase: 'submitted', message: 'submitted', result: receipt })
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention'); assert.equal(h.service.detail(job.id).upload, null)
  assert.equal(h.service.detail(job.id).uploadRetry, undefined); assert.deepEqual(h.service.runAutomaticExports(), [])
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention'); assert.equal(h.service.detail(job.id).upload, null)
  const invalid = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...invalid, status: 'completed', stage: 'completed', upload: receipt }))
  assert.equal(h.service.detail(job.id).upload, null); assert.equal(h.service.detail(job.id).uploadStatus, 'blocked')
  assert.throws(() => h.service.upload(job.id), /不能认定已提交/)
})

test('a legacy saved draft automatically resumes publication after a temporary connection failure', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  h.options.uploadRuntime!.inspectSocialUploadAccountRuntime = async () => ({ ready: false, message: '请登录' })
  h.service.upload(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  stored.uploadAttempt.payload.publicationMode = 'draft'
  const receipt: SocialUploadResult = { accountName: h.b.accountName, staged: true, saved: true, published: false,
    editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=12345',
    draftUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=12345', targetId: 'abc123', engine: 'fixture' }
  stored.uploadAttempt.result = receipt; stored.uploadAttempt.status = 'saved'; stored.upload = receipt
  fs.writeFileSync(file, JSON.stringify(stored))
  let calls = 0
  h.options.uploadRuntime!.publishSavedSocialUpload = async (payload, legacy, result) => {
    assert.equal(payload.jobId, stored.uploadAttempt.id); assert.equal(legacy.publicationMode, 'draft')
    if (++calls === 1) throw new Error('ECONNRESET：发表响应连接中断')
    return { ...result, saved: false, submitted: true, publicationStatus: 'submitted', articleId: '12345' }
  }
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'retry_wait'); assert.equal(h.service.detail(job.id).uploadStatus, 'queued')
  const waiting = JSON.parse(fs.readFileSync(file, 'utf8'))
  waiting.uploadRetry.nextRetryAt = new Date(0).toISOString()
  fs.writeFileSync(file, JSON.stringify(waiting))
  assert.deepEqual(h.service.runAutomaticExports(), [job.id]); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).uploadStatus, 'submitted'); assert.equal(calls, 2)
  assert.equal(h.calls.upload, 0); assert.equal(h.calls.produce, 1)
})

test('a fresh cover version abandons only the failed request while ordinary retries reuse it', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const originalPath = h.service.asset(job.id, 'landscape-cover'), prepare = h.options.prepareAssets!, revisions: number[] = []
  let fail = true
  h.options.prepareAssets = async (input, options) => {
    revisions.push(input.revision)
    if (fail) throw new Error('原底图请求缺少任务编号')
    return prepare(input, options)
  }
  h.service.covers(job.id, { regenerate: true }); await h.service.waitForIdle()
  h.service.covers(job.id, { regenerate: true }); await h.service.waitForIdle()
  assert.deepEqual(revisions, [2, 2]); assert.equal(h.service.asset(job.id, 'landscape-cover'), originalPath)
  fail = false
  const response = await h.route.request(`/jobs/${job.id}/covers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newVersion: true }) })
  assert.equal(response.status, 202); await h.service.waitForIdle()
  assert.deepEqual(revisions, [2, 2, 3])
  assert.equal(h.service.detail(job.id).coverRevision, 3); assert.equal(h.service.detail(job.id).coverGenerationPending, false)
  assert.ok(fs.existsSync(originalPath)); assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.upload, 0)
})

test('read-only upload checks preserve unresolved task state and never dispatch uploader actions', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'uploading', message: '原编辑页文案已变化，请核对' })
  h.service.upload(job.id); await h.service.waitForIdle()
  const before = h.service.detail(job.id), file = path.join(h.root, 'jobs', job.id, 'job.json')
  const originalAttempt = JSON.parse(fs.readFileSync(file, 'utf8')).uploadAttempt
  const response = await h.route.request(`/jobs/${job.id}/check-upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 202); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, before.status); assert.equal(result.stage, before.stage); assert.equal(result.message, before.message)
  assert.equal(result.uploadCheck?.status, 'needs_attention'); assert.match(result.uploadCheck!.message, /文案已变化/)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).uploadAttempt, originalAttempt)
  assert.equal(h.calls.upload, 0); assert.equal(h.calls.save, 0); assert.equal(result.executionActive, false)
})

test('read-only upload checks accept only verified submission receipts and reject other accounts', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'uploading', message: '结果待核对' })
  h.service.upload(job.id); await h.service.waitForIdle()
  const receipt: SocialUploadResult = { accountName: 'other', staged: true, saved: false, submitted: true, published: false,
    publicationStatus: 'submitted', articleId: '12345', publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=12345',
    editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', targetId: 'abc123', engine: 'fixture' }
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'complete', phase: 'submitted', message: 'submitted', result: receipt })
  h.service.checkUpload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).uploadCheck?.status, 'error'); assert.equal(h.service.detail(job.id).upload, null)
  receipt.accountName = h.b.accountName
  h.service.checkUpload(job.id); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.uploadCheck?.status, 'complete'); assert.equal(result.status, 'completed'); assert.equal(result.uploadStatus, 'submitted')
  assert.equal(h.calls.upload, 0); assert.equal(h.calls.save, 0)
})

test('review endpoints require a bound inactive attempt and validate every input before the account session', async t => {
  const h = fixture(t), job = await prepared(h)
  let reviews = 0
  h.options.reviewUpload = async (payload, options) => {
    reviews++; assert.equal(payload.accountName, h.b.accountName)
    assert.equal(payload.jobId, `${job.id}-baijiahao`)
    return { jobId: payload.jobId, targetId: 'abc123', url: 'https://baijiahao.baidu.com/builder/rc/content', imageDataUrl: 'data:image/jpeg;base64,AAAA', width: 1440, height: 1000, originalEditor: false, message: options?.input ? '已刷新' : '原账号内容管理' }
  }
  const post = (action: string, body: unknown = {}) => h.route.request(`/jobs/${job.id}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal((await post('upload-review')).status, 409)
  h.service.produce(job.id); await h.service.waitForIdle()
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'manual', phase: 'uploading', message: '结果待核对' })
  h.service.upload(job.id); await h.service.waitForIdle()
  const opened = await post('upload-review', { view: 'content' })
  assert.equal(opened.status, 200); assert.equal((await opened.json()).data.jobId, job.id)
  assert.equal((await post('upload-review/input', { targetId: 'abc123', action: 'click', x: 50, y: 100 })).status, 200)
  for (const input of [{ targetId: '../wrong', action: 'refresh' }, { targetId: 'abc123', action: 'evaluate', script: 'alert(1)' },
    { targetId: 'abc123', action: 'key', key: 'Meta+W' }, { targetId: 'abc123', action: 'click', x: -1, y: 4 }])
    assert.equal((await post('upload-review/input', input)).status, 400)
  assert.equal(reviews, 2)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...stored, status: 'running', ownerPid: process.ppid }))
  assert.equal((await post('upload-review')).status, 409)
  assert.equal((await post('check-upload')).status, 409)
  assert.equal(reviews, 2)
})

test('queued tasks expose whether an executor actually owns the task', async t => {
  const h = fixture(t), job = await prepared(h), file = path.join(h.root, 'jobs', job.id, 'job.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...stored, status: 'queued' }))
  assert.equal(h.service.detail(job.id).executionActive, false)
  fs.writeFileSync(file, JSON.stringify({ ...stored, status: 'queued', ownerPid: process.ppid }))
  assert.equal(h.service.detail(job.id).executionActive, true)
})

test('read-only Huasheng status queries preserve failure context and allow another same-account production', async t => {
  const h = fixture(t), job = await prepared(h), other = h.service.create({ sourceUrl: 'https://youtu.be/12345678901' }, { defer: true })
  pendingHuasheng(h, job.id, { message: '原身份检查失败' })
  pendingHuasheng(h, other.id, { status: 'running', ownerPid: process.ppid, title: '另一条花生制作' })
  const response = await h.route.request(`/jobs/${job.id}/check-huasheng`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 200)
  const result = (await response.json()).data
  assert.equal(result.status, 'needs_attention'); assert.equal(result.message, '原身份检查失败')
  assert.equal(result.huashengCheck.status, 'completed')
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 0); assert.equal(h.calls.upload, 0)
  assert.equal(h.service.sync(job.id).executionActive, true)
  await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.service.detail(other.id).status, 'running')
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 1)
})

test('completed projects can export while another account-bound project is making or exporting', async t => {
  for (const stage of ['produce', 'export']) {
    const h = fixture(t), job = await prepared(h), other = h.service.create({ sourceUrl: 'https://youtu.be/12345678901' }, { defer: true })
    pendingHuasheng(h, job.id, { message: '暂时无法核验花生账号身份，请稍后检查' })
    const file = pendingHuasheng(h, other.id, { status: 'running', stage, ownerPid: process.ppid })
    const before = fs.readFileSync(file, 'utf8')
    const response = await h.route.request(`/jobs/${job.id}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 202, 'a different project must not block continuation of this project')
    await h.service.waitForIdle()
    assert.equal(h.service.detail(job.id).status, 'ready')
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 1); assert.equal(h.calls.upload, 0)
  }
})

test('browser submissions serialize but remote production waits do not hold the account', async t => {
  const h = fixture(t), first = await prepared(h), second = await prepared(h, 'https://youtu.be/secondvideo')
  let release!: () => void, waiting!: () => void, secondSubmitted!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { waiting = resolve })
  const submitted = new Promise<void>(resolve => { secondSubmitted = resolve })
  let active = 0, maxActive = 0
  h.options.browser = { runHuashengBrowserJob: async input => {
    h.calls.produce++; active++; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setImmediate(resolve))
    const projectUrl = `https://www.huasheng.cn/video/${input.jobId === first.id ? '10001' : '10002'}`
    await input.onCheckpoint({ checkpoint: 'submitted', projectUrl, message: '花生已接受制作' })
    active--
    if (input.jobId === second.id) secondSubmitted()
    return { projectUrl }
  } }
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
    if (input.projectUrl.endsWith('/10001')) { waiting(); await hold }
    return { status: 'completed', message: '分镜素材已就绪' }
  } }
  h.service.produce(first.id); await entered
  h.service.produce(second.id)
  let concurrent = false
  try {
    concurrent = await Promise.race([submitted.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250))])
    if (concurrent) {
      const current = h.service.detail(first.id)
      assert.equal(current.executionActive, true)
      assert.throws(() => h.service.sync(first.id), /执行|处理/)
      assert.deepEqual(h.service.runAutomaticExports(), [])
    }
  } finally { release(); await h.service.waitForIdle() }
  assert.equal(concurrent, true, 'the second browser submission must run before the first remote production completes')
  assert.equal(maxActive, 1)
  assert.equal(h.calls.produce, 2); assert.equal(h.calls.export, 2)
  assert.equal(h.service.detail(first.id).status, 'ready'); assert.equal(h.service.detail(second.id).status, 'ready')
})

test('a remote export wait cannot hold a following project sync for the whole render', async t => {
  const h = fixture(t), first = await prepared(h), second = await prepared(h, 'https://youtu.be/secondvideo')
  pendingHuasheng(h, first.id, { projectUrl: 'https://www.huasheng.cn/video/10001' })
  pendingHuasheng(h, second.id, { projectUrl: 'https://www.huasheng.cn/video/10002' })
  let release!: () => void, waiting!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { waiting = resolve })
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async input => {
    if (input.projectUrl.endsWith('/10001')) { waiting(); await hold }
    return { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: 'video.mp4' }
  } }
  h.service.sync(first.id); await entered
  h.service.sync(second.id)
  let ready = false
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (h.service.detail(second.id).status === 'ready') { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  } finally { release(); await h.service.waitForIdle() }
  assert.equal(ready, true, 'the next project must complete while the earlier remote export is still waiting')
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 2)
})

test('temporary identity failures schedule bounded original-project recovery and respect an explicit stop', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = pendingHuasheng(h, job.id)
  const readyConfig = h.hs.readyBrowserConfig.bind(h.hs)
  h.hs.readyBrowserConfig = async () => { throw Object.assign(new Error('暂时无法核验花生账号身份，请稍后检查'), { retryable: true }) }
  h.service.produce(job.id); await h.service.waitForIdle()
  const deferred = h.service.detail(job.id)
  assert.equal(deferred.status, 'retry_wait')
  assert.equal(deferred.failureKind, 'temporary')
  assert.equal(deferred.automaticRetry?.attempt, 1)
  assert.equal(deferred.automaticRetry?.maxAttempts, 3)
  assert.deepEqual(h.service.runAutomaticExports(), [], 'scheduled retries wait until the recorded next attempt')
  const waiting = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...waiting, automaticRetry: { ...waiting.automaticRetry, nextRetryAt: '2020-01-01T00:00:00Z' } }))
  h.hs.readyBrowserConfig = readyConfig
  assert.deepEqual(h.service.runAutomaticExports(), [job.id]); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.service.detail(job.id).automaticRetry, undefined)
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 1)
  const resumed = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...waiting, automaticRetry: { ...waiting.automaticRetry, nextRetryAt: '2020-01-01T00:00:00Z' } }))
  h.service.cancel(job.id)
  assert.equal(h.service.detail(job.id).status, 'paused')
  assert.equal(h.service.detail(job.id).automaticRetry, undefined)
  assert.deepEqual(h.service.runAutomaticExports(), [])
  fs.writeFileSync(file, JSON.stringify(resumed))
})

test('automatic original-project recovery stops after its budget and never repeats an uncertain export', async t => {
  const h = fixture(t), job = await prepared(h), file = pendingHuasheng(h, job.id)
  let checks = 0
  h.hs.readyBrowserConfig = async () => { checks++; throw Object.assign(new Error('身份接口暂不可用'), { retryable: true }) }
  h.service.produce(job.id); await h.service.waitForIdle()
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = h.service.detail(job.id)
    assert.equal(current.status, 'retry_wait'); assert.equal(current.automaticRetry?.attempt, attempt)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...stored, automaticRetry: { ...stored.automaticRetry, nextRetryAt: '2020-01-01T00:00:00Z' } }))
    assert.deepEqual(h.service.runAutomaticExports(), [job.id]); await h.service.waitForIdle()
  }
  assert.equal(h.service.detail(job.id).status, 'needs_attention')
  assert.equal(h.service.detail(job.id).automaticRetry, undefined)
  assert.deepEqual(h.service.runAutomaticExports(), [])
  assert.equal(checks, 16); assert.equal(h.calls.produce + h.calls.export + h.calls.upload, 0)
  const other = fixture(t), uncertain = await prepared(other)
  pendingHuasheng(other, uncertain.id, { exportDispatched: true, productionCompleted: true })
  other.options.exportApi = { ...other.options.exportApi!, createHuashengExport: async () => { throw new Error('must not recreate export') } }
  other.service.produce(uncertain.id); await other.service.waitForIdle()
  assert.equal(other.service.detail(uncertain.id).status, 'needs_attention')
  assert.equal(other.service.detail(uncertain.id).automaticRetry, undefined)
  assert.deepEqual(other.service.runAutomaticExports(), [])
  assert.equal(other.calls.export + other.calls.produce + other.calls.upload, 0)
})

test('stopping an immediate retry during its initial query leaves a paused task, never an orphaned retry wait', async t => {
  const h = fixture(t), job = await prepared(h)
  pendingHuasheng(h, job.id, { status: 'retry_wait', automaticDelivery: true,
    automaticRetry: { attempt: 1, maxAttempts: 3, nextRetryAt: '2020-01-01T00:00:00Z' } })
  let entered!: () => void
  const queried = new Promise<void>(resolve => { entered = resolve })
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
    entered()
    await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
    throw new Error('unreachable')
  } }
  h.service.sync(job.id); await queried
  h.service.cancel(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'paused')
  assert.equal(h.service.detail(job.id).automaticRetry, undefined)
  assert.deepEqual(h.service.runAutomaticExports(), [])
  assert.equal(h.calls.export + h.calls.produce + h.calls.upload, 0)
})

test('an authorized single task from an old collection resumes before project creation but explicit stop still wins', async t => {
  const h = fixture(t), job = h.service.create({ sourceUrl }, { defer: true, collectionId: `science-batch-${randomUUID()}` })
  let entered!: () => void
  const downloading = new Promise<void>(resolve => { entered = resolve }), download = h.options.download!
  h.options.download = async (_input, options) => {
    entered()
    await new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }))
    throw new Error('unreachable')
  }
  h.service.produce(job.id); await downloading; await h.service.stop()
  assert.equal(h.service.detail(job.id).status, 'paused'); assert.equal(h.service.detail(job.id).projectUrl, null)
  h.options.download = download
  const restored = new ScienceWorkflowService(h.options); t.after(() => restored.stop())
  assert.deepEqual(restored.runAutomaticExports(), [job.id]); await restored.waitForIdle()
  assert.equal(restored.detail(job.id).status, 'ready')
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.upload, 0)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...stored, status: 'paused', projectUrl: null, videoPath: null, automaticDelivery: true }))
  restored.cancel(job.id)
  assert.deepEqual(restored.runAutomaticExports(), [])
})

test('two processes reclaiming one stale execution lease cannot both acquire it', async t => {
  const h = fixture(t), job = await prepared(h), key = `job:${job.id}`
  const release = (h.service as any).tryExecutionLock(key, job.id)
  assert.equal(typeof release, 'function'); release()
  const db = new Database(path.join(h.root, 'jobs', '.locks', 'execution.sqlite'))
  db.prepare('INSERT INTO execution_locks (key, pid, token, job_id) VALUES (?, ?, ?, ?)').run(key, 99999999, 'dead-owner', job.id)
  db.close()
  const script = `
    import { ScienceWorkflowService } from ${JSON.stringify(new URL('./science-workflow.ts', import.meta.url).href)};
    const service = new ScienceWorkflowService({root: ${JSON.stringify(path.join(h.root, 'jobs'))}});
    process.stdout.write('ready\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    const release = service.tryExecutionLock(${JSON.stringify(key)}, ${JSON.stringify(job.id)});
    process.stdout.write(JSON.stringify({acquired: Boolean(release)})+'\\n');
    if(release) { await new Promise(resolve => process.stdin.once('data', resolve)); release(); }
    await service.stop();
    process.stdin.destroy();
  `
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
    let error = ''; child.stderr.on('data', data => { error += String(data) })
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`lock child exited ${code}: ${error}`)))
    })
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM') })
    return { child, lines, exited }
  })
  for (const { lines } of children) assert.equal((await lines.next()).value, 'ready')
  for (const { child } of children) child.stdin.write('acquire\n')
  const results = await Promise.all(children.map(async ({ lines }) => JSON.parse((await lines.next()).value!)))
  assert.equal(results.filter(value => value.acquired).length, 1)
  for (let i = 0; i < children.length; i++) if (results[i].acquired) children[i].child.stdin.write('release\n')
  await Promise.all(children.map(value => value.exited))
  const final = (h.service as any).tryExecutionLock(key, job.id)
  assert.equal(typeof final, 'function'); final()
})

test('Huasheng continuation ignores unrelated cover and upload work using the same production account', async t => {
  for (const stage of ['covers', 'upload']) {
    const h = fixture(t), job = await prepared(h), other = h.service.create({ sourceUrl: 'https://youtu.be/12345678901' }, { defer: true })
    pendingHuasheng(h, job.id)
    pendingHuasheng(h, other.id, { status: 'running', stage, ownerPid: process.ppid })
    h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => ({ status: 'not_started', message: '等待平台处理' }) }
    h.service.sync(job.id); await h.service.waitForIdle()
    assert.equal(h.service.detail(job.id).status, 'waiting_remote')
    assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 0)
  }
})

test('single-video HTTP creation automatically reaches video or publication without a manuscript approval request', async t => {
  for (const mode of ['videos', 'upload'] as const) {
    const h = fixture(t)
    const response = await h.route.request('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl, ...(mode === 'upload' ? { mode } : {}) }) })
    assert.equal(response.status, 202)
    const id = (await response.json()).data.id
    await h.service.waitForIdle()
    const job = h.service.detail(id)
    assert.equal(job.status, mode === 'videos' ? 'ready' : 'completed')
    assert.ok(job.videoUrl); assert.ok(job.landscapeCoverUrl); assert.ok(job.portraitCoverUrl)
    assert.equal(h.calls.rewrite, 1); assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1)
    assert.equal(h.calls.upload, mode === 'upload' ? 1 : 0)
    assert.ok(job.logs.some(log => log.message === '二创完成，继续自动制作'))
    assert.ok(!job.logs.some(log => /待审阅|文稿已就绪/.test(log.message)))
    assert.equal(h.service.create({ sourceUrl }).id, id)
    await h.service.waitForIdle()
    assert.equal(h.calls.produce, 1)
  }
})

test('automatic creation validates its production account before starting source preparation', async t => {
  const h = fixture(t)
  assert.throws(() => h.service.create({ sourceUrl, huashengAccountName: null }), /选择华生账号/)
  assert.throws(() => h.service.create({ sourceUrl, mode: 'upload', baijiahaoAccountName: null }), /选择百家号账号/)
  assert.equal(h.calls.download, 0); assert.equal(h.service.overview().jobs.length, 0)
})

test('deferred collection stores source metadata without requiring a usable production account', async t => {
  const h = fixture(t)
  const collectionId = `science-batch-${randomUUID()}`
  const missingAccount = `science_huasheng_${randomUUID().replaceAll('-', '')}`
  assert.throws(() => h.service.create({ sourceUrl, huashengAccountName: missingAccount }, { defer: true }), /不存在|未找到/)
  const job = h.service.create({ sourceUrl, huashengAccountName: missingAccount, baijiahaoAccountName: null },
    { defer: true, collectionOnly: true, collectionId, sourceChannel: 'https://www.youtube.com/@Science/videos' })
  assert.equal(job.collectionId, collectionId)
  assert.equal(job.huashengAccountName, missingAccount)
  assert.equal(job.baijiahaoAccountName, null)
  assert.equal(job.stage, 'download')
  assert.equal(h.calls.download, 0)
  assert.equal(h.calls.produce, 0)
  assert.throws(() => h.service.create({ sourceUrl: 'https://youtu.be/secondvideo', huashengAccountName: missingAccount },
    { defer: true, collectionOnly: true }), /不存在|未找到/)
})

test('two single-video automatic jobs serialize the same account and both finish without another client action', async t => {
  const h = fixture(t)
  let release!: () => void, entered!: () => void, rewritten!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const secondWritten = new Promise<void>(resolve => { rewritten = resolve })
  const browser = h.options.browser!, rewrite = h.options.rewrite!
  let browserCalls = 0
  h.options.browser = { runHuashengBrowserJob: async input => {
    if (++browserCalls === 1) { entered(); await hold }
    return browser.runHuashengBrowserJob(input)
  } }
  h.options.rewrite = async (...args) => {
    const result = await rewrite(...args)
    if (h.calls.rewrite === 2) rewritten()
    return result
  }
  const first = h.service.create({ sourceUrl })
  await started
  const second = h.service.create({ sourceUrl: 'https://youtu.be/secondvideo' })
  try {
    await secondWritten; await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(h.service.detail(second.id).status, 'queued')
    assert.equal(browserCalls, 1)
  } finally { release() }
  await h.service.waitForIdle()
  assert.equal(h.service.detail(first.id).status, 'ready')
  assert.equal(h.service.detail(second.id).status, 'ready')
  assert.equal(h.calls.produce, 2); assert.equal(h.calls.export, 2)
  assert.equal(h.calls.rewrite, 2); assert.equal(h.calls.upload, 0)
})

test('legacy manuscript status migrates to production queue without rewriting or starting remote work on read', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...stored, status: 'review', stage: 'review', message: '文稿已就绪' }))
  const migrated = h.service.detail(job.id)
  assert.equal(migrated.status, 'queued'); assert.equal(migrated.stage, 'produce')
  assert.equal(migrated.script, stored.script); assert.equal(migrated.huashengAccountName, stored.huashengAccountName)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'queued')
  assert.equal(h.calls.produce, 0)
  await h.service.runBatchJob(job.id, 'videos', new AbortController().signal)
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.calls.rewrite, 1); assert.equal(h.calls.produce, 1)
})

test('an authorized automatic production resumes after shutdown and an explicit stop disables that recovery', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...stored, status: 'paused', automaticProduction: true, autoUpload: false }))
  assert.deepEqual(h.service.runAutomaticExports(), [job.id])
  await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready'); assert.equal(h.calls.produce, 1)
  assert.deepEqual(h.service.runAutomaticExports(), [])
  const other = await prepared(h, 'https://youtu.be/other_video')
  const otherFile = path.join(h.root, 'jobs', other.id, 'job.json')
  for (const status of ['queued', 'paused']) {
    fs.writeFileSync(otherFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(otherFile, 'utf8')), status, automaticProduction: true }))
    h.service.cancel(other.id)
    assert.equal(h.service.detail(other.id).status, 'paused')
    assert.deepEqual(h.service.runAutomaticExports(), [])
  }
  assert.equal(h.calls.produce, 1)
})

test('a queued task owned by another live process cannot be adopted by production or a batch', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const stored = { ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'queued', ownerPid: process.ppid }
  fs.writeFileSync(file, JSON.stringify(stored))
  assert.equal(h.service.produce(job.id).status, 'queued')
  await assert.rejects(h.service.runBatchJob(job.id, 'videos', new AbortController().signal), /执行进程/)
  assert.throws(() => h.service.cancel(job.id), /另一进程/)
  assert.equal(h.calls.produce, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), stored)
})

test('automatic publication recovers an interruption after the finished video without creating it again', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), automaticProduction: true, autoUpload: true }))
  assert.deepEqual(h.service.runAutomaticExports(), [job.id])
  await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'completed')
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.upload, 1)
  assert.deepEqual(h.service.runAutomaticExports(), [])
})

test('finished videos expose upload progress and receipts independently of production completion', async t => {
  const h = fixture(t), job = await prepared(h)
  assert.equal(h.service.detail(job.id).uploadStatus, 'not_ready')
  h.service.produce(job.id); await h.service.waitForIdle()
  h.service.upload(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const original = JSON.parse(fs.readFileSync(file, 'utf8')), submitted = original.upload
  const stored = { ...original, upload: null, status: 'ready', stage: 'export' }
  const receipt = { accountName: h.b.accountName, staged: true, saved: false, published: false }
  const cases = [
    [{ status: 'ready', autoUpload: true }, 'pending'],
    [{ status: 'running', stage: 'covers', ownerPid: process.ppid, coverRequest: { revision: 2 } }, 'not_ready'],
    [{ status: 'needs_attention', stage: 'covers', coverStyle: undefined }, 'not_ready'],
    [{ status: 'queued', stage: 'upload' }, 'queued'],
    [{ status: 'running', stage: 'upload', ownerPid: process.ppid }, 'uploading'],
    [{ status: 'running', stage: 'upload', ownerPid: process.ppid, upload: { ...receipt, saved: true } }, 'uploading'],
    [{ status: 'needs_attention', stage: 'upload' }, 'blocked'],
    [{ status: 'needs_attention', stage: 'upload', uploadAttempt: { status: 'uncertain' } }, 'queued'],
    [{ status: 'retry_wait', stage: 'upload', uploadRetry: { attempt: 1, nextRetryAt: new Date().toISOString() } }, 'queued'],
    [{ status: 'paused', stage: 'upload' }, 'paused'],
    [{ status: 'completed', upload: { ...receipt, saved: true } }, 'uploaded'],
    [{ status: 'completed', upload: submitted }, 'submitted'],
    [{ status: 'completed', upload: { ...submitted, published: true, publicationStatus: 'published' } }, 'published'],
  ] as const
  for (const [patch, expected] of cases) {
    fs.writeFileSync(file, JSON.stringify({ ...stored, ...patch }))
    assert.equal(h.service.detail(job.id).uploadStatus, expected)
    assert.equal(h.service.overview().jobs[0].uploadStatus, expected)
  }
  fs.writeFileSync(file, JSON.stringify({ ...stored, autoUpload: true }))
  assert.equal(h.service.detail(job.id).autoUpload, true)
})

test('upload progress retains the bridge substep and its observed time before a receipt exists', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const run = h.options.uploadRuntime!.runSocialUpload
  h.options.uploadRuntime!.runSocialUpload = async (payload, options) => {
    for (const [step, message] of [['browser_connect', '正在连接后台浏览器'], ['covers', '正在确认封面'], ['media', '正在等待转码']]) {
      options?.onProgress?.(message!, { step: step!, message: message! })
      const progress = (h.service.detail(job.id) as any).uploadProgress
      assert.equal(progress?.step, step)
      assert.equal(progress.message, message)
      assert.ok(Number.isFinite(Date.parse(progress.updatedAt)))
      assert.equal(h.service.detail(job.id).upload?.submitted, undefined)
    }
    const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    stored.uploadProgress.updatedAt = '2020-01-01T00:00:00.000Z'
    fs.writeFileSync(file, JSON.stringify(stored))
    options?.onProgress?.('正在等待转码', { step: 'media', message: '正在等待转码' })
    assert.equal((h.service.detail(job.id) as any).uploadProgress.updatedAt, stored.uploadProgress.updatedAt,
      'a repeated status is not new upload progress')
    return run(payload, options)
  }
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'completed')
  assert.equal(h.calls.upload, 1); assert.equal(h.calls.save, 1)
})

test('an optional topic skip remains visible as a warning after a successful submission', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const run = h.options.uploadRuntime!.runSocialUpload
  const message = '未添加可选话题：候选列表为空；继续发表'
  h.options.uploadRuntime!.runSocialUpload = async (payload, options) => {
    options?.onProgress?.(message, { step: 'topic_skipped', message })
    return run(payload, options)
  }
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).uploadStatus, 'submitted')
  assert.deepEqual((h.service.detail(job.id) as any).uploadWarnings, [message])
})

test('composition exposes real encoded duration and progress while the task is active', async t => {
  const h = fixture(t), job = await prepared(h)
  let observed = false
  const prepare = h.options.prepareIntroVideo!
  h.options.prepareIntroVideo = async (input, options) => {
    ;(options as any).onProgress?.({ percent: 37, processedSeconds: 74, totalSeconds: 200, speed: .8 })
    const progress = (h.service.detail(job.id) as any).compositionProgress
    assert.equal(progress?.percent, 37)
    assert.equal(progress.processedSeconds, 74)
    assert.equal(progress.totalSeconds, 200)
    assert.equal(progress.speed, .8)
    assert.ok(Number.isFinite(Date.parse(progress.updatedAt)))
    assert.equal(h.service.detail(job.id).exportStep, 'compose')
    observed = true
    return prepare(input, options)
  }
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(observed, true)
})

test('authorized batch uploads resume a ready video after interruption but preserve an explicit stop', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')),
    collectionId: `science-batch-${randomUUID()}`, automaticProduction: false, autoUpload: true }))
  h.service.cancel(job.id)
  assert.deepEqual(h.service.runAutomaticExports(), [])
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...stored, automaticDelivery: true }))
  assert.deepEqual(h.service.runAutomaticExports(), [job.id])
  await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).uploadStatus, 'submitted')
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.upload, 1)
  assert.deepEqual(h.service.runAutomaticExports(), [])
})

test('batch upload interrupted in its upload stage resumes without export intent and respects an explicit stop', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const stored = { ...JSON.parse(fs.readFileSync(file, 'utf8')), collectionId: `science-batch-${randomUUID()}`,
    status: 'paused', stage: 'upload', autoUpload: true, automaticProduction: false }
  delete stored.automaticDelivery
  fs.writeFileSync(file, JSON.stringify(stored))
  h.service.cancel(job.id)
  assert.deepEqual(h.service.runAutomaticExports(), [])
  fs.writeFileSync(file, JSON.stringify(stored))
  assert.deepEqual(h.service.runAutomaticExports(), [job.id])
  await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).uploadStatus, 'submitted')
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.upload, 1)
})

test('temporary browser connection failures retry the original upload without another client action', async t => {
  const h = fixture(t, { retryDelayMs: 0 }), job = await prepared(h)
  const runtime = h.options.uploadRuntime!, ready = runtime.inspectSocialUploadAccountRuntime!
  let checks = 0
  runtime.inspectSocialUploadAccountRuntime = async name => ++checks <= 2
    ? { ready: false, message: '后台浏览器连接失败或响应超时，尚未检查登录状态；已保留原登录，请重试连接' }
    : ready(name)
  h.service.produce(job.id, true); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).uploadStatus, 'submitted')
  assert.equal(checks, 3); assert.equal(h.calls.upload, 1); assert.equal(h.calls.save, 1)
  assert.ok(h.service.detail(job.id).logs.some(log => /百家号连接暂时失败/.test(log.message)))
})

test('temporary connections and uncertain editors schedule further uploads while security challenges stop', async t => {
  for (const scenario of ['connection', 'verification', 'uncertain']) {
    const h = fixture(t, { retryDelayMs: 0 }), job = await prepared(h)
    let checks = 0
    if (scenario === 'uncertain') h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => {
      checks++; return { action: 'manual', phase: 'uncertain', message: '原编辑页文案已变化，不能继续' }
    }
    else h.options.uploadRuntime!.inspectSocialUploadAccountRuntime = async () => {
      checks++; return { ready: false, message: scenario === 'connection'
        ? '后台浏览器连接失败或响应超时，尚未检查登录状态；已保留原登录，请重试连接'
        : '平台要求人工安全验证，完成后重新检查' }
    }
    h.service.produce(job.id, true); await h.service.waitForIdle()
    assert.equal(h.service.detail(job.id).status, scenario === 'verification' ? 'needs_attention' : 'retry_wait')
    assert.equal(Boolean(h.service.detail(job.id).uploadRetry), scenario !== 'verification')
    assert.equal(checks, scenario === 'connection' ? 4 : 1)
    assert.equal(h.calls.upload, 0); assert.equal(h.calls.save, 0)
    assert.deepEqual(h.service.runAutomaticExports(), [])
  }
})

test('uploads on the same account queue before accessing the platform editor', async t => {
  const h = fixture(t), first = await prepared(h), second = await prepared(h, 'https://youtu.be/other_video')
  h.service.produce(first.id); await h.service.waitForIdle()
  h.service.produce(second.id); await h.service.waitForIdle()
  const runtime = h.options.uploadRuntime!, upload = runtime.runSocialUpload
  let release!: () => void, entered!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), start = new Promise<void>(resolve => { entered = resolve })
  runtime.runSocialUpload = async (...args) => { entered(); await hold; return upload(...args) }
  try {
    h.service.upload(first.id); await start
    const checkpoints = h.calls.checkpoint
    h.service.upload(second.id)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(h.service.detail(second.id).uploadStatus, 'queued')
    assert.equal(h.calls.checkpoint, checkpoints)
  } finally { release(); await h.service.waitForIdle() }
  assert.equal(h.service.detail(first.id).uploadStatus, 'submitted')
  assert.equal(h.service.detail(second.id).uploadStatus, 'submitted')
  assert.equal(h.calls.upload, 2)
})

test('deleting a finished task hides it, preserves artifacts and receipts, and keeps source deduplication', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id, true); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const before = JSON.parse(fs.readFileSync(file, 'utf8'))
  const calls = { ...h.calls }
  const response = await h.route.request(`/jobs/${job.id}`, { method: 'DELETE' })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, { id: job.id, deleted: true })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(saved.deletedAt)
  assert.equal(saved.automaticDelivery, false)
  assert.deepEqual(saved.upload, before.upload)
  assert.deepEqual(saved.uploadAttempt, before.uploadAttempt)
  assert.equal(fs.existsSync(saved.media.videoPath), false, 'the source was already reclaimed after transcription')
  for (const asset of [saved.videoPath, saved.coverAssets.landscapePath, saved.coverAssets.portraitPath]) assert.ok(fs.existsSync(asset))
  assert.equal(h.service.overview().jobs.length, 0)
  assert.equal((await h.route.request(`/jobs/${job.id}`)).status, 404)
  assert.equal((await h.route.request(`/jobs/${job.id}/assets/video`)).status, 404)
  assert.ok(h.service.knownYoutubeIds().has('abcdefghijk'))
  assert.throws(() => h.service.create({ sourceUrl }), /已删除/)
  assert.equal((await h.route.request(`/jobs/${job.id}`, { method: 'DELETE' })).status, 200)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).deletedAt, saved.deletedAt)
  assert.deepEqual(h.calls, calls)
})

test('deletion requires running and automatically pending tasks to stop first', async t => {
  let entered!: () => void
  const pending = new Promise<void>(resolve => { entered = resolve })
  const h = fixture(t, { transcribe: async (_input, options) => {
    entered(); await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); return ''
  } })
  const job = h.service.create({ sourceUrl })
  await pending
  assert.equal((await h.route.request(`/jobs/${job.id}`, { method: 'DELETE' })).status, 409)
  h.service.cancel(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  for (const status of ['waiting_remote', 'awaiting_export']) {
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status, automaticDelivery: true }))
    assert.equal((await h.route.request(`/jobs/${job.id}`, { method: 'DELETE' })).status, 409)
  }
  h.service.cancel(job.id)
  assert.equal((await h.route.request(`/jobs/${job.id}`, { method: 'DELETE' })).status, 200)
})

test('deletion validates the task identity and rejects cross-site requests', async t => {
  const h = fixture(t), job = await prepared(h)
  assert.equal((await h.route.request(`/jobs/${job.id}`, { method: 'DELETE', headers: { Origin: 'https://example.com' } })).status, 403)
  assert.equal(h.service.overview().jobs.length, 1)
  assert.equal((await h.route.request(`/jobs/science-${randomUUID()}`, { method: 'DELETE' })).status, 404)
  assert.equal((await h.route.request('/jobs/not-an-id', { method: 'DELETE' })).status, 400)
})

test('a queued automatic task can be stopped without affecting the account owner or creating a project', async t => {
  const h = fixture(t), busy = await prepared(h)
  const waiting = await prepared(h, 'https://youtu.be/video000001')
  let entered!: () => void
  const pending = new Promise<void>(resolve => { entered = resolve })
  h.options.browser = { runHuashengBrowserJob: async input => {
    entered()
    await new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
    throw new Error('unreachable')
  } }
  h.service.produce(busy.id); await pending
  const run = h.service.runBatchJob(waiting.id, 'videos', new AbortController().signal)
  const rejected = assert.rejects(run, /已停止/)
  await Promise.resolve()
  assert.equal(h.service.detail(waiting.id).status, 'queued')
  assert.throws(() => h.service.remove(waiting.id), /先停止/)
  assert.throws(() => h.service.patch(waiting.id, { script: '不能修改排队中的文稿' }), /排队/)
  h.service.cancel(waiting.id)
  await rejected
  h.service.remove(waiting.id)
  assert.equal(h.service.detail(busy.id).status, 'running')
  assert.equal(h.calls.export, 0)
  h.service.cancel(busy.id); await h.service.waitForIdle()
})

test('manual Huasheng sync automatically exports, downloads and prepares covers without recreating the project', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = pendingHuasheng(h, job.id)
  const response = await h.route.request(`/jobs/${job.id}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 202)
  await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'ready'); assert.equal(result.stage, 'covers')
  assert.equal(result.huashengSync?.status, 'completed'); assert.ok(result.huashengSync?.checkedAt)
  assert.ok(result.videoUrl); assert.ok(result.landscapeCoverUrl); assert.ok(result.portraitCoverUrl)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).productionCompleted, true)
  assert.equal(h.calls.productionInspect, 1)
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1); assert.equal(h.calls.upload, 0)
  const restored = new ScienceWorkflowService(h.options)
  assert.deepEqual(restored.detail(job.id).huashengSync, result.huashengSync)
})

test('manual Huasheng sync rejects a different voice before inspecting exports or generating a presenter', async t => {
  const h = fixture(t), job = await prepared(h)
  pendingHuasheng(h, job.id, { productionCompleted: true, exportTask: { taskId: 'original-export', projectHash: 'a'.repeat(64) } })
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
    assert.deepEqual(input.expectedVoice, { id: 1595608, type: 1, name: '音色小鹭' })
    throw new HuashengExportApiError('invalid_response', '花生原项目音色与指定音色 1595608 不一致')
  }, inspectHuashengExport: async () => assert.fail('wrong-voice exports must not be inspected') }
  h.options.preparePresenter = async () => assert.fail('wrong audio must not drive another presenter generation')
  h.service.sync(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention')
  assert.match(h.service.detail(job.id).message, /音色.*不一致/)
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 0)
  assert.equal(h.calls.downloadExport, 0); assert.equal(h.calls.upload, 0)
})

test('manual Huasheng sync distinguishes pending confirmation, accepted work and remote export progress', async t => {
  const h = fixture(t), job = await prepared(h)
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => ({ status: 'not_started', message: '尚未进入制作' }) }
  pendingHuasheng(h, job.id, { checkpoint: 'requirements_pending' })
  h.service.sync(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention')
  assert.match(h.service.detail(job.id).message, /原项目.*确认/)
  pendingHuasheng(h, job.id)
  h.service.sync(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'waiting_remote')
  assert.match(h.service.detail(job.id).message, /已提交/)
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => ({ status: 'creating', message: '正在制作' }) }
  h.service.sync(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'waiting_remote')
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => ({ status: 'completed', message: '制作完成' }) }
  const file = pendingHuasheng(h, job.id, { stage: 'export', productionCompleted: true, exportDispatched: true, exportTask: { taskId: 'original-export', projectHash: 'a'.repeat(64) } })
  let progress = 42, release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let inspected!: () => void
  const entered = new Promise<void>(resolve => { inspected = resolve })
  let inspections = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async input => {
    assert.equal(input.taskId, 'original-export'); assert.equal(input.projectHash, 'a'.repeat(64))
    if (++inspections > 1) { inspected(); await blocked }
    return { progress, url: progress === 100 ? 'https://fixture.invalid/private-download-url' : null, filename: 'video.mp4' }
  } }
  h.service.sync(job.id); await entered
  assert.equal(h.service.detail(job.id).status, 'running'); assert.equal(h.service.detail(job.id).stage, 'export')
  assert.equal(h.service.detail(job.id).huashengSync?.exportProgress, 42)
  progress = 100; release(); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).productionCompleted, true)
  assert.equal(JSON.stringify(h.service.detail(job.id)).includes('private-download-url'), false)
  assert.equal(h.calls.produce + h.calls.export + h.calls.upload, 0); assert.equal(h.calls.downloadExport, 1)
})

test('manual Huasheng sync preserves completed videos and unresolved upload checkpoints on success and failure', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  for (const status of ['ready', 'completed', 'needs_attention'] as const) {
    const stage = status === 'needs_attention' ? 'upload' : status === 'completed' ? 'completed' : 'covers'
    const message = `保留原${stage}状态`
    const file = pendingHuasheng(h, job.id, { status, stage, message })
    const before = JSON.parse(fs.readFileSync(file, 'utf8'))
    h.service.sync(job.id); await h.service.waitForIdle()
    assert.equal(h.service.detail(job.id).status, status); assert.equal(h.service.detail(job.id).stage, stage)
    assert.equal(h.service.detail(job.id).message, message)
    const inspect = h.options.exportApi!.inspectHuashengProduction
    h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => { throw new HuashengExportApiError('login_required', '账号登录失效') } }
    h.service.sync(job.id); await h.service.waitForIdle()
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after.status, status); assert.equal(after.stage, stage); assert.equal(after.message, message)
    assert.equal(after.videoPath, before.videoPath); assert.deepEqual(after.exportTask, before.exportTask)
    assert.equal(after.huashengSync.status, 'error'); assert.match(after.huashengSync.message, /登录失效/)
    h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: inspect }
  }
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.upload, 0)
})

test('manual Huasheng sync rejects missing projects, duplicate work and invalid requests', async t => {
  const h = fixture(t), job = await prepared(h)
  const post = (body: unknown, origin?: string) => h.route.request(`/jobs/${job.id}/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  })
  assert.equal((await post({})).status, 409)
  pendingHuasheng(h, job.id)
  assert.equal((await post({ upload: true })).status, 400)
  assert.equal((await post({}, 'https://evil.example')).status, 403)
  let finish!: () => void, inspected!: () => void
  const entered = new Promise<void>(resolve => { inspected = resolve })
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => {
    await new Promise<void>(resolve => { finish = resolve; inspected() })
    return { status: 'completed', message: '完成' }
  } }
  assert.equal((await post({})).status, 202)
  await entered
  assert.equal((await post({})).status, 409)
  finish(); await h.service.waitForIdle()
})

test('batch Huasheng sync serializes each account, skips downstream work and cancels queued queries', async t => {
  const h = fixture(t), first = await prepared(h)
  pendingHuasheng(h, first.id)
  const second = h.service.create({ sourceUrl: 'https://youtu.be/secondvideo' }, { defer: true })
  pendingHuasheng(h, second.id, { script: first.script, productionScriptHash: createHash('sha256').update(first.script).digest('hex') })
  const ready = h.service.create({ sourceUrl: 'https://youtu.be/ready_video' }, { defer: true })
  pendingHuasheng(h, ready.id, { status: 'ready', stage: 'covers' })
  let release!: () => void, count = 0, active = 0, maxActive = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => {
    count++; active++; maxActive = Math.max(active, maxActive)
    if (count === 1) await new Promise<void>(resolve => { release = resolve })
    active--; return { status: 'completed', message: '制作完成' }
  } }
  const response = await h.route.request('/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 202)
  const data = (await response.json()).data
  assert.equal(data.started.length, 2); assert.ok(data.skipped.includes(ready.id))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(count, 1)
  const queuedId = data.started[1]
  h.service.cancel(queuedId)
  release(); await h.service.waitForIdle()
  assert.equal(count, 1); assert.equal(maxActive, 1)
  assert.equal(h.service.detail(queuedId).status, 'needs_attention', 'canceling a read-only sync preserves the original workflow state')
  assert.equal(h.service.detail(ready.id).status, 'ready')
  h.service.sync(queuedId); await h.service.waitForIdle()
  assert.equal(count, 2); assert.equal(h.service.detail(queuedId).status, 'ready')
  assert.equal(h.calls.produce + h.calls.upload, 0); assert.equal(h.calls.export, 2); assert.equal(h.calls.downloadExport, 2)
})

test('automatic export recovery drains old queued exports and preserves the original publish choice', async t => {
  const h = fixture(t), job = await prepared(h)
  pendingHuasheng(h, job.id, { status: 'awaiting_export', stage: 'export', productionCompleted: true, autoUpload: true })
  const restored = new ScienceWorkflowService(h.options)
  t.after(() => restored.stop())
  restored.startAutomaticExports(); await restored.waitForIdle()
  assert.equal(restored.detail(job.id).status, 'completed')
  assert.equal(restored.detail(job.id).upload?.submitted, true)
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1); assert.equal(h.calls.upload, 1)
  restored.runAutomaticExports(); await restored.waitForIdle()
  assert.equal(h.calls.export, 1); assert.equal(h.calls.upload, 1)
})

test('automatic export recovery keeps original identities and can run alongside unrelated source preparation', async t => {
  const h = fixture(t), job = await prepared(h)
  for (const patch of [{ exportDispatched: true }, { productionScriptHash: 'f'.repeat(64) }]) {
    pendingHuasheng(h, job.id, { status: 'awaiting_export', productionCompleted: true, exportDispatched: false, ...patch })
    h.service.runAutomaticExports(); await h.service.waitForIdle()
    assert.equal(h.service.detail(job.id).status, 'needs_attention')
    assert.equal(h.calls.produce + h.calls.export + h.calls.upload, 0)
  }
  pendingHuasheng(h, job.id, { status: 'awaiting_export', productionCompleted: true, exportDispatched: false })
  let release!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  h.options.transcribe = async () => { started(); return new Promise<string>(resolve => { release = () => resolve('原稿') }) }
  const other = h.service.create({ sourceUrl: 'https://youtu.be/other_video' }, { defer: true })
  h.service.prepare(other.id)
  await entered
  assert.deepEqual(h.service.runAutomaticExports(), [job.id])
  assert.equal(h.service.detail(other.id).status, 'running')
  release(); await h.service.waitForIdle()
  assert.equal(h.service.detail(other.id).status, 'draft')
  assert.equal(h.service.detail(job.id).status, 'ready')
})

test('service shutdown retains automatic export intent while explicit cancel leaves the saved export paused', async t => {
  const h = fixture(t), job = await prepared(h)
  const originalDownload = h.options.exportApi!.downloadHuashengExport
  let started!: () => void
  let entered = new Promise<void>(resolve => { started = resolve })
  h.options.exportApi = { ...h.options.exportApi!, downloadHuashengExport: async input => {
    started(); await new Promise<void>((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
    throw new Error('unreachable')
  } }
  pendingHuasheng(h, job.id, { status: 'awaiting_export', productionCompleted: true })
  h.service.runAutomaticExports(); await entered
  await h.service.stop()
  assert.equal(h.service.detail(job.id).status, 'paused')
  const restored = new ScienceWorkflowService(h.options); t.after(() => restored.stop())
  entered = new Promise<void>(resolve => { started = resolve })
  restored.runAutomaticExports(); await entered
  assert.equal(h.calls.export, 1, 'restart reuses the original export task')
  restored.cancel(job.id); await restored.waitForIdle()
  assert.equal(restored.detail(job.id).status, 'paused')
  assert.deepEqual(restored.runAutomaticExports(), [])
  h.options.exportApi = { ...h.options.exportApi!, downloadHuashengExport: originalDownload }
  restored.sync(job.id); await restored.waitForIdle()
  assert.equal(restored.detail(job.id).status, 'ready'); assert.equal(h.calls.export, 1)
})

test('video production creates durable landscape and portrait cover URLs before any upload', async t => {
  const h = fixture(t), job = await prepared(h)
  assert.equal(job.landscapeCoverUrl, null); assert.equal(job.portraitCoverUrl, null)
  h.service.produce(job.id); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'ready')
  assert.match(result.landscapeCoverUrl!, /assets\/landscape-cover$/)
  assert.match(result.portraitCoverUrl!, /assets\/portrait-cover$/)
  assert.equal(h.calls.upload, 0)
  const landscape = h.service.asset(job.id, 'landscape-cover'), portrait = h.service.asset(job.id, 'portrait-cover')
  const original = [landscape, portrait].map(file => ({ file, bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }))
  const restored = new ScienceWorkflowService(h.options)
  assert.equal(restored.detail(job.id).landscapeCoverUrl, result.landscapeCoverUrl)
  restored.covers(job.id); await restored.waitForIdle()
  restored.upload(job.id); await restored.waitForIdle()
  assert.equal(restored.detail(job.id).status, 'completed')
  restored.covers(job.id); await restored.waitForIdle()
  assert.equal(restored.detail(job.id).status, 'completed'); assert.equal(restored.detail(job.id).stage, 'completed')
  assert.equal(h.payloads[0]!.landscapePath, landscape); assert.equal(h.payloads[0]!.portraitPath, portrait)
  for (const asset of original) { assert.deepEqual(fs.readFileSync(asset.file), asset.bytes); assert.equal(fs.statSync(asset.file).mtimeMs, asset.mtime) }
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)
  assert.equal(JSON.stringify(restored.detail(job.id)).includes(h.root), false)
})

test('covers endpoint repairs an existing completed video locally and serves JPEG with safe paths', async t => {
  const h = fixture(t), job = await prepared(h)
  const post = (data: unknown) => h.route.request(`/jobs/${job.id}/covers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  assert.equal((await post({})).status, 409)
  const { file } = legacyFinishedVideo(h, job.id)
  assert.equal((await post({ unexpected: true })).status, 400)
  const started = await post({})
  assert.equal(started.status, 202); assert.equal((await started.json()).data.id, job.id)
  await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  for (const kind of ['landscape-cover', 'portrait-cover']) {
    const response = await h.route.request(`/jobs/${job.id}/assets/${kind}`)
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'image/jpeg')
    const info = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
    assert.equal(info.format, 'jpeg')
  }
  assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 0); assert.equal(h.calls.downloadExport, 0); assert.equal(h.calls.upload, 0)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  const outside = path.join(h.root, 'private.jpg')
  fs.writeFileSync(outside, 'private content')
  fs.unlinkSync(stored.coverAssets.landscapePath); fs.symlinkSync(outside, stored.coverAssets.landscapePath)
  assert.equal((await h.route.request(`/jobs/${job.id}/assets/landscape-cover`)).status, 400)
})

test('a cover failure preserves the downloaded video and local retry needs no production account', async t => {
  const h = fixture(t), job = await prepared(h), prepare = h.options.prepareAssets!
  h.options.prepareAssets = async () => { throw new Error('封面生成失败') }
  h.service.produce(job.id); await h.service.waitForIdle()
  const failed = h.service.detail(job.id)
  assert.equal(failed.status, 'needs_attention'); assert.equal(failed.stage, 'covers'); assert.ok(failed.videoUrl)
  assert.equal(failed.landscapeCoverUrl, null)
  h.options.prepareAssets = prepare
  h.options.huashengAccounts = { ...h.options.huashengAccounts!, get: () => { throw new Error('must not inspect a production account') } }
  h.service.covers(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready'); assert.ok(h.service.detail(job.id).portraitCoverUrl)
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1); assert.equal(h.calls.upload, 0)
})

test('upload never generates posters on demand and refuses legacy frame covers', async t => {
  const h = fixture(t), job = await prepared(h)
  const { file } = legacyFinishedVideo(h, job.id)
  let generated = 0
  const prepare = h.options.prepareAssets!
  h.options.prepareAssets = async (...args) => { generated++; return prepare(...args) }
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.match(h.service.detail(job.id).message, /先.*封面/)
  assert.equal(generated, 0); assert.equal(h.calls.upload, 0)
  h.service.covers(job.id); await h.service.waitForIdle()
  assert.equal(generated, 1)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')); delete stored.coverStyle
  fs.writeFileSync(file, JSON.stringify(stored))
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.match(h.service.detail(job.id).message, /先.*封面/)
  assert.equal(generated, 1); assert.equal(h.calls.upload, 0)
})

test('unsubmitted legacy posters receive a new presenter revision without overwriting the original cover', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  const originalPath = stored.coverAssets.landscapePath
  stored.coverSourceDigest = createHash('sha256').update(JSON.stringify([stored.title, stored.script, stored.sourceTitle, stored.coverInstruction || ''])).digest('hex')
  fs.writeFileSync(file, JSON.stringify(stored))
  h.service.covers(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).coverRevision, 2)
  assert.notEqual(h.service.asset(job.id, 'landscape-cover'), originalPath)
  assert.equal(fs.existsSync(originalPath), true)
  assert.equal(h.calls.upload, 0)
})

test('poster regeneration saves custom instructions and resumes a failed revision without losing the previous poster', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  const original = h.service.detail(job.id), oldPath = h.service.asset(job.id, 'landscape-cover')
  assert.equal(original.coverStyle, 'science-title-poster-v1')
  assert.equal(original.coverRevision, 1)
  const prepare = h.options.prepareAssets!, inputs: any[] = []
  let fail = true
  h.options.prepareAssets = async (input, options) => {
    inputs.push(input)
    if (fail) throw new Error('生图连接中断')
    return prepare(input, options)
  }
  h.service.covers(job.id, { regenerate: true, instruction: '黑色背景，突出冰块，字再大一些' }); await h.service.waitForIdle()
  const failed = h.service.detail(job.id)
  assert.equal(failed.coverGenerationPending, true)
  assert.equal(failed.coverInstruction, '黑色背景，突出冰块，字再大一些')
  assert.equal(h.service.asset(job.id, 'landscape-cover'), oldPath)
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.calls.upload, 0); assert.equal(inputs.length, 1)
  fail = false
  h.service.covers(job.id, { regenerate: true, instruction: failed.coverInstruction }); await h.service.waitForIdle()
  assert.equal(inputs[0].directory, inputs[1].directory)
  assert.equal(inputs[1].revision, 2)
  assert.equal(inputs[1].instruction, failed.coverInstruction)
  assert.equal(inputs[1].title, original.title)
  assert.equal(h.service.detail(job.id).coverRevision, 2)
  assert.equal(h.service.detail(job.id).coverGenerationPending, false)
  assert.notEqual(h.service.asset(job.id, 'landscape-cover'), oldPath)
  assert.equal(fs.existsSync(oldPath), true)
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)
})

test('published posters cannot be regenerated and malformed instructions cannot start generation', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id, true); await h.service.waitForIdle()
  assert.throws(() => h.service.covers(job.id, { regenerate: true, instruction: '新图' }), /已提交|已发表/)
  const response = await h.route.request(`/jobs/${job.id}/covers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regenerate: true, instruction: '字'.repeat(1001) }) })
  assert.equal(response.status, 400)
})

test('replacing posters in an existing editor preserves the original upload and resumes after a lost revision response', async t => {
  const h = fixture(t), job = await prepared(h), confirm = h.options.uploadRuntime!.confirmSocialUpload
  h.options.uploadRuntime!.confirmSocialUpload = async () => { throw new Error('找不到水印') }
  h.service.produce(job.id, true); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const original = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(h.calls.upload, 1); assert.equal(original.uploadAttempt.dispatched, true)
  let revisions = 0
  h.options.reviseUploadCovers = async (payload, previous) => {
    revisions++
    assert.deepEqual(previous, original.uploadAttempt.payload)
    assert.equal(payload.jobId, previous.jobId); assert.equal(payload.videoPath, previous.videoPath)
    assert.notEqual(payload.landscapePath, previous.landscapePath)
    if (revisions === 1) throw new Error('封面修订响应中断')
    const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    return { result: original.uploadAttempt.result, previousPayloadDigest: 'a'.repeat(64), payloadDigest: 'b'.repeat(64),
      videoSha256: hash(payload.videoPath!), landscapeSha256: hash(payload.landscapePath!), portraitSha256: hash(payload.portraitPath!),
      revisionId: 'b'.repeat(64), targetId: original.uploadAttempt.result.targetId, verification: 'original_video_and_revised_covers' }
  }
  h.service.covers(job.id, { regenerate: true, instruction: '换成黑底黄字' }); await h.service.waitForIdle()
  const generated = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(revisions, 0, 'poster generation is entirely independent of platform upload')
  assert.equal(generated.coverRevision, 2); assert.equal(generated.coverRequest, undefined)
  assert.deepEqual(generated.uploadAttempt, original.uploadAttempt)
  assert.notDeepEqual(generated.coverAssets, original.coverAssets)
  h.service.upload(job.id); await h.service.waitForIdle()
  const failed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(failed.uploadAttempt, original.uploadAttempt)
  assert.deepEqual(failed.coverAssets, generated.coverAssets)
  assert.equal(failed.coverUploadRevision.revision, 2)
  assert.throws(() => h.service.covers(job.id, { regenerate: true }), /先继续原上传/)
  h.options.uploadRuntime!.confirmSocialUpload = confirm
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => ({ action: 'save', phase: 'staged', message: '已更换封面', result: original.uploadAttempt.result })
  h.service.upload(job.id); await h.service.waitForIdle()
  const revised = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(revised.coverUploadRevision, undefined)
  assert.equal(revised.uploadAttempt.id, original.uploadAttempt.id)
  assert.equal(revised.uploadAttempt.payload.videoPath, original.uploadAttempt.payload.videoPath)
  assert.equal(revised.uploadAttempt.result.targetId, original.uploadAttempt.result.targetId)
  assert.notEqual(revised.uploadAttempt.fingerprint, original.uploadAttempt.fingerprint)
  assert.equal(h.service.detail(job.id).status, 'completed')
  assert.equal(h.calls.upload, 1, 'a cover revision must not upload the video again')
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1)
})

test('cancelled cover preparation preserves the video and never advertises partial covers', async t => {
  const h = fixture(t), job = await prepared(h)
  legacyFinishedVideo(h, job.id)
  let entered!: () => void, release!: () => void
  const start = new Promise<void>(resolve => { entered = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  const prepare = h.options.prepareAssets!
  h.options.prepareAssets = async (input, options) => { entered(); await hold; return prepare(input, options) }
  h.service.covers(job.id); await start
  assert.equal(h.service.detail(job.id).status, 'running'); assert.equal(h.service.detail(job.id).stage, 'covers')
  h.service.cancel(job.id); release(); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'paused'); assert.ok(result.videoUrl)
  assert.equal(result.landscapeCoverUrl, null); assert.equal(result.portraitCoverUrl, null)
  h.options.prepareAssets = prepare
  h.service.covers(job.id); await h.service.waitForIdle()
  assert.ok(h.service.detail(job.id).landscapeCoverUrl)
})

test('existing upload covers are adopted read-only while uncertain payloads, fingerprints and receipts remain unchanged', async t => {
  const h = fixture(t), job = await prepared(h)
  h.options.uploadRuntime!.inspectSocialUploadAccountRuntime = async () => ({ ready: false, message: '请登录' })
  h.service.produce(job.id, true); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  stored.uploadAttempt.status = 'uncertain'; stored.uploadAttempt.dispatched = true
  stored.uploadAttempt.payload.description = '历史文稿'.repeat(100)
  stored.uploadAttempt.result = { accountName: h.b.accountName, staged: true, saved: false, published: false,
    editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', targetId: 'abc123', engine: 'fixture' }
  stored.upload = stored.uploadAttempt.result; stored.message = '原上传结果待核对'
  delete stored.coverAssets
  fs.writeFileSync(file, JSON.stringify(stored))
  const attempt = structuredClone(stored.uploadAttempt), files = [attempt.payload.landscapePath, attempt.payload.portraitPath]
  const before = files.map((file: string) => ({ bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }))
  h.options.prepareAssets = async () => { throw new Error('an existing upload must not regenerate assets') }
  h.service.covers(job.id); await h.service.waitForIdle()
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(after.uploadAttempt, attempt); assert.deepEqual(after.upload, stored.upload)
  assert.equal(after.status, stored.status); assert.equal(after.stage, stored.stage); assert.equal(after.message, stored.message)
  assert.ok(h.service.detail(job.id).landscapeCoverUrl)
  files.forEach((file: string, index: number) => { assert.deepEqual(fs.readFileSync(file), before[index]!.bytes); assert.equal(fs.statSync(file).mtimeMs, before[index]!.mtime) })
  await sharp({ create: { width: 810, height: 1080, channels: 3, background: '#876543' } }).jpeg().toFile(attempt.payload.portraitPath)
  const changedCover = fs.readFileSync(attempt.payload.portraitPath)
  h.service.covers(job.id); await h.service.waitForIdle()
  assert.match(h.service.detail(job.id).message, /原上传素材已变化/)
  assert.deepEqual(fs.readFileSync(attempt.payload.portraitPath), changedCover)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).uploadAttempt, attempt)
  fs.unlinkSync(attempt.payload.portraitPath)
  h.service.covers(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention')
  assert.equal(fs.existsSync(attempt.payload.portraitPath), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).uploadAttempt, attempt)
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async payload => {
    assert.deepEqual(payload, attempt.payload)
    return { action: 'manual', phase: 'unknown', message: '原结果待核对' }
  }
  h.service.upload(job.id); await h.service.waitForIdle()
  const retried = JSON.parse(fs.readFileSync(file, 'utf8')).uploadAttempt
  assert.deepEqual(retried.payload, attempt.payload); assert.equal(retried.fingerprint, attempt.fingerprint); assert.equal(retried.inputDigest, attempt.inputDigest)
  assert.equal(h.calls.upload, 0); assert.equal(h.calls.save, 0)
})

test('new Baijiahao publications use the saved title plus contest tag as description', async t => {
  const h = fixture(t), job = await prepared(h), title = '冰为什么能浮在水上', script = '完整的科学解释。'.repeat(100)
  h.service.patch(job.id, { title, script })
  h.service.produce(job.id, true); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'completed')
  assert.equal(h.payloads[0]!.description, `${title} #热爆趣创赛#`); assert.equal(h.payloads[0]!.title, title)
  assert.deepEqual(h.payloads[0]!.tags, ['#热爆趣创赛#'])
  assert.equal(h.payloads[0]!.creationDeclaration, '个人观点，仅供参考')
  assert.equal(h.payloads[0]!.watermark, '添加水印')
  assert.equal(h.service.detail(job.id).script, script)
})

test('a title over 50 characters prevents creating any new upload attempt', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.patch(job.id, { title: '知'.repeat(51) })
  h.service.produce(job.id, true); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'needs_attention'); assert.match(result.message, /50/)
  assert.equal(result.hasUploadAttempt, false); assert.equal(h.calls.upload, 0); assert.equal(h.calls.checkpoint, 0)
  assert.ok(result.videoUrl); assert.ok(result.landscapeCoverUrl)
})

test('YouTube → complete transcript → recreation → selected Huasheng → export → selected Baijiahao publication, retry never duplicates', async t => {
  const h = fixture(t), job = await prepared(h)
  assert.equal(h.calls.download, 1); assert.equal(h.calls.transcribe, 1); assert.equal(h.calls.rewrite, 1)
  assert.ok(job.transcript.includes('Water')); assert.ok(job.script.includes('密度')); assert.equal(job.factChecks.length, 1)
  assert.equal(job.huashengAccountName, h.h.accountName); assert.equal(job.baijiahaoAccountName, h.b.accountName)
  assert.equal(h.service.create({ sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }).id, job.id)
  h.service.produce(job.id, true); h.service.produce(job.id, true)
  await h.service.waitForIdle()
  const completed = h.service.detail(job.id)
  assert.equal(completed.status, 'completed'); assert.equal(completed.upload?.submitted, true); assert.equal(completed.upload?.saved, false); assert.equal(completed.upload?.published, false)
  assert.equal(completed.upload?.accountName, h.b.accountName); assert.match(completed.videoUrl!, /assets\/video\?v=[a-f0-9]{16}$/)
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.upload, 1); assert.equal(h.calls.save, 1)
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.calls.upload, 1); assert.equal(h.calls.save, 1)
  assert.equal(h.service.detail(job.id).status, 'completed')
  assert.throws(() => h.service.patch(job.id, { script: '换稿' }), /绑定/)
  assert.throws(() => h.service.patch(job.id, { baijiahaoAccountName: null }), /绑定/)
  assert.equal(JSON.stringify(completed).includes(h.root), false)
})

test('new defaults never change existing job bindings and a missing account never falls back', async t => {
  const h = fixture(t), job = await prepared(h)
  const otherH = h.hs.create({ label: '第二个华生' }), otherB = h.bjh.create({ label: '第二个百家号' })
  h.hs.setDefault(otherH.accountName); h.bjh.setDefault(otherB.accountName)
  assert.equal(h.service.detail(job.id).huashengAccountName, h.h.accountName)
  assert.equal(h.service.detail(job.id).baijiahaoAccountName, h.b.accountName)
  h.service.patch(job.id, { huashengAccountName: null })
  assert.throws(() => h.service.produce(job.id), /选择.*华生/)
  h.service.patch(job.id, { huashengAccountName: otherH.accountName, baijiahaoAccountName: null })
  assert.throws(() => h.service.produce(job.id, true), /选择.*百家号/)
  assert.equal(h.calls.produce, 0)
})

test('long scripts are rejected before locking; editing the transcript invalidates its generated draft', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.patch(job.id, { script: '知'.repeat(10001) })
  assert.throws(() => h.service.produce(job.id), /10000/)
  assert.equal(h.service.detail(job.id).checkpoint, null)
  h.service.patch(job.id, { script: '已缩短文稿' })
  h.service.patch(job.id, { transcript: 'new complete source' })
  assert.equal(h.service.detail(job.id).script, '')
  assert.equal(h.service.detail(job.id).stage, 'rewrite')
})

test('export network uncertainty persists dispatch and resumes without a second creation', async t => {
  const h = fixture(t)
  h.options.exportApi = { ...h.options.exportApi!, createHuashengExport: async input => { h.calls.export++; await input.onDispatched?.(); throw new HuashengExportApiError('result_uncertain', 'response lost') } }
  const job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention')
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.calls.export, 1); assert.equal(h.calls.produce, 1)
  assert.match(h.service.detail(job.id).message, /上次导出已发送/)
  const inspect = h.options.exportApi!.inspectHuashengExport
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async input => {
    if (input.taskId === 'wrong-task') throw new Error('原导出记录不匹配')
    return inspect(input)
  } }
  await assert.rejects(h.service.recover(job.id, { exportTask: { taskId: 'wrong-task', projectHash: 'b'.repeat(64) } }), /不匹配/)
  await h.service.recover(job.id, { exportTask: { taskId: 'original-task', projectHash: 'a'.repeat(64) } })
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready'); assert.equal(h.calls.export, 1)
})

test('lost project URL can bind only the original create request and is verified with the saved script', async t => {
  const h = fixture(t), job = await prepared(h)
  await assert.rejects(h.service.recover(job.id, { projectUrl: 'https://www.huasheng.cn/video/12345' }), /待恢复/)
  h.options.browser!.runHuashengBrowserJob = async input => {
    h.calls.produce++; await input.onCheckpoint({ checkpoint: 'create_pending', message: '创建请求已发送' }); throw new Error('tab lost')
  }
  h.service.produce(job.id); await h.service.waitForIdle()
  await assert.rejects(h.service.recover(job.id, { projectUrl: 'https://evil.example/video/12345' }), /有效链接/)
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
    assert.equal(input.script, job.script)
    assert.deepEqual(input.browserConfig, { ...h.hs.browserConfig(h.h.accountName), expectedUid: '2002' })
    if (input.projectUrl.endsWith('/99999')) throw new Error('文稿不符')
    return { status: 'completed', message: 'ready' }
  } }
  await assert.rejects(h.service.recover(job.id, { projectUrl: 'https://www.huasheng.cn/video/99999' }), /文稿不符/)
  assert.equal(h.service.detail(job.id).projectUrl, null)
  await h.service.recover(job.id, { projectUrl: 'https://www.huasheng.cn/video/12345' })
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => { assert.equal(input.script, job.script); return { status: 'completed', message: 'ready' } } }
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.calls.produce, 1); assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.calls.browserInspect, 0)
  await assert.rejects(h.service.recover(job.id, { projectUrl: 'https://www.huasheng.cn/video/99999' }), /不能替换/)
})

test('upload retry after login failure refuses changed files before any dispatch', async t => {
  const h = fixture(t), job = await prepared(h)
  h.options.uploadRuntime!.inspectSocialUploadAccountRuntime = async () => ({ ready: false, message: '请登录' })
  h.service.produce(job.id, true); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'needs_attention'); assert.equal(h.calls.upload, 0)
  fs.writeFileSync(h.service.asset(job.id, 'video'), 'changed-video')
  h.options.uploadRuntime!.inspectSocialUploadAccountRuntime = async () => ({ ready: true, message: 'ready' })
  h.service.upload(job.id); await h.service.waitForIdle()
  assert.equal(h.calls.upload, 0); assert.equal(h.calls.save, 0)
  assert.match(h.service.detail(job.id).message, /制作版本已变化/)
})

test('a persisted submitted project resumes by inspection without sending the script again', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(stored, { status: 'running', stage: 'produce', ownerPid: 99999999, checkpoint: 'submitted', projectUrl: 'https://www.huasheng.cn/video/12345' })
  fs.writeFileSync(file, JSON.stringify(stored))
  const restarted = new ScienceWorkflowService(h.options)
  assert.equal(restarted.detail(job.id).status, 'paused')
  restarted.produce(job.id); await restarted.waitForIdle()
  assert.equal(restarted.detail(job.id).status, 'ready'); assert.equal(h.calls.produce, 0); assert.equal(h.calls.export, 1)
  assert.equal(h.calls.productionInspect, 1, 'An already completed project is not inspected twice before export')
  assert.equal(h.calls.browserInspect, 0)
})

test('submitted production reaches completion through the API despite an unavailable export dialog and exports only once', async t => {
  const h = fixture(t), job = await prepared(h)
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
    h.calls.productionInspect++
    assert.equal(input.projectUrl, 'https://www.huasheng.cn/video/12345')
    assert.equal(input.checkpoint, 'submitted'); assert.equal(input.script, job.script)
    assert.deepEqual(input.browserConfig, { ...h.hs.browserConfig(h.h.accountName), expectedUid: '2002' })
    assert.deepEqual(input.expectedVoice, { id: 1595608, type: 1, name: '音色小鹭' })
    return h.calls.productionInspect === 1 ? { status: 'creating', message: '素材制作中' } : { status: 'completed', message: '制作完成' }
  } }
  h.service.produce(job.id); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'ready'); assert.ok(result.videoUrl)
  assert.ok(result.logs.some(entry => entry.message === '素材制作中'))
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.productionInspect, 2); assert.equal(h.calls.browserInspect, 0)
  assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)
  const before = { ...h.calls }
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.deepEqual(h.calls, { ...before, productionInspect: before.productionInspect + 1 })
})

test('an original project not yet started resumes its browser confirmation before polling queued production through the API', async t => {
  const h = fixture(t), job = await prepared(h)
  const projectUrl = 'https://www.huasheng.cn/video/12345'
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(stored, { status: 'needs_attention', stage: 'produce', checkpoint: 'requirements_pending', projectUrl })
  fs.writeFileSync(file, JSON.stringify(stored))
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
    h.calls.productionInspect++
    assert.equal(input.projectUrl, projectUrl); assert.equal(input.script, job.script)
    assert.deepEqual(input.browserConfig, { ...h.hs.browserConfig(h.h.accountName), expectedUid: '2002' })
    if (h.calls.productionInspect === 1) {
      assert.equal(h.calls.produce, 0); assert.equal(input.checkpoint, 'requirements_pending')
      return { status: 'not_started', message: '需求等待确认' }
    }
    assert.equal(h.calls.produce, 1); assert.equal(input.checkpoint, 'submitted')
    return h.calls.productionInspect === 2 ? { status: 'queued', message: '制作排队中' } : { status: 'completed', message: '制作完成' }
  } }
  h.options.browser!.runHuashengBrowserJob = async input => {
    h.calls.produce++
    assert.equal(input.projectUrl, projectUrl); assert.equal(input.checkpoint, 'requirements_pending')
    assert.equal(h.calls.export, 0)
    await input.onCheckpoint({ checkpoint: 'submitted', projectUrl, message: '已确认原项目制作' })
    return { projectUrl }
  }
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.ok(h.service.detail(job.id).logs.some(entry => entry.message === '制作排队中'))
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.productionInspect, 3); assert.equal(h.calls.browserInspect, 0)
  assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)
})

test('accepted production waits through a temporarily unstarted API stage without replaying the browser, including after restart', async t => {
  for (const resumed of [false, true]) {
    await t.test(resumed ? 'persisted submission' : 'new submission', async t => {
      const h = fixture(t), job = await prepared(h)
      if (resumed) {
        const file = path.join(h.service.root, job.id, 'job.json')
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
        Object.assign(stored, { checkpoint: 'submitted', projectUrl: 'https://www.huasheng.cn/video/12345', status: 'needs_attention' })
        fs.writeFileSync(file, JSON.stringify(stored))
      }
      h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
        h.calls.productionInspect++
        assert.equal(input.checkpoint, 'submitted'); assert.equal(input.script, job.script)
        assert.equal(h.calls.export, 0)
        return h.calls.productionInspect < 3 ? { status: 'not_started', message: '阶段尚未同步' }
          : h.calls.productionInspect === 3 ? { status: 'queued', message: '正在排队' } : { status: 'completed', message: '完成' }
      } }
      h.service.produce(job.id); await h.service.waitForIdle()
      const result = h.service.detail(job.id)
      assert.equal(result.status, 'ready'); assert.equal(result.checkpoint, 'submitted')
      assert.equal(h.calls.produce, resumed ? 0 : 1); assert.equal(h.calls.productionInspect, 4); assert.equal(h.calls.export, 1)
      assert.ok(result.logs.some(log => /已提交.*等待/.test(log.message)))
    })
  }
})

test('a browser disconnect after confirmation reconciles the saved project through the API without replaying confirmation', async t => {
  const h = fixture(t), job = await prepared(h)
  const projectUrl = 'https://www.huasheng.cn/video/12345'
  h.options.browser!.runHuashengBrowserJob = async input => {
    h.calls.produce++
    await input.onCheckpoint({ checkpoint: 'confirm_pending', projectUrl, message: '正在确认制作' })
    throw new HuashengBrowserError('browser_unavailable', '确认后页面连接中断')
  }
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
    h.calls.productionInspect++
    assert.equal(input.projectUrl, projectUrl); assert.equal(input.script, job.script)
    assert.deepEqual(input.browserConfig, { ...h.hs.browserConfig(h.h.accountName), expectedUid: '2002' })
    assert.equal(input.checkpoint, h.calls.productionInspect === 1 ? 'confirm_pending' : 'submitted')
    return h.calls.productionInspect === 1 ? { status: 'queued', message: '原项目已排队' } : { status: 'completed', message: '完成' }
  } }
  h.service.produce(job.id); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'ready'); assert.equal(result.checkpoint, 'submitted')
  assert.equal(result.projectUrl, projectUrl)
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.productionInspect, 2); assert.equal(h.calls.export, 1)
  assert.ok(result.logs.some(log => /接口.*确认/.test(log.message)))
})

test('uncertain browser confirmation never exports an unstarted or mismatched project and never replays the action', async t => {
  for (const scenario of ['not_started', 'mismatched', 'before_confirmation', 'login_required'] as const) {
    await t.test(scenario, async t => {
      const h = fixture(t), job = await prepared(h)
      const checkpoint = scenario === 'before_confirmation' ? 'requirements_pending' : 'confirm_pending'
      h.options.browser!.runHuashengBrowserJob = async input => {
        h.calls.produce++
        await input.onCheckpoint({ checkpoint, projectUrl: 'https://www.huasheng.cn/video/12345', message: '待确认' })
        throw new HuashengBrowserError(scenario === 'login_required' ? 'login_required' : 'browser_unavailable', '保留原确认检查点')
      }
      h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => {
        h.calls.productionInspect++
        if (scenario === 'mismatched') throw new HuashengExportApiError('invalid_response', '项目文稿不符')
        return { status: 'not_started', message: '未开始制作' }
      } }
      h.service.produce(job.id); await h.service.waitForIdle()
      const result = h.service.detail(job.id)
      assert.equal(result.status, 'needs_attention'); assert.equal(result.checkpoint, checkpoint)
      assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 0)
      assert.equal(h.calls.productionInspect, ['not_started', 'mismatched'].includes(scenario) ? 1 : 0)
      assert.match(result.message, scenario === 'mismatched' ? /文稿不符/ : /保留原确认检查点/)
    })
  }
})

test('API script mismatch or status failure keeps the submitted project and never exports or falls back to the browser', async t => {
  for (const message of ['项目原文与保存文稿不符', '制作状态接口暂不可用']) {
    const h = fixture(t), job = await prepared(h)
    h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
      h.calls.productionInspect++
      assert.equal(input.script, job.script)
      assert.deepEqual(input.browserConfig, { ...h.hs.browserConfig(h.h.accountName), expectedUid: '2002' })
      throw new HuashengExportApiError('invalid_response', message)
    } }
    h.service.produce(job.id); await h.service.waitForIdle()
    assert.equal(h.service.detail(job.id).status, 'needs_attention')
    assert.equal(h.service.detail(job.id).message, message)
    assert.equal(h.service.detail(job.id).checkpoint, 'submitted')
    assert.equal(h.service.detail(job.id).projectUrl, 'https://www.huasheng.cn/video/12345')
    h.service.produce(job.id); await h.service.waitForIdle()
    assert.equal(h.calls.productionInspect, 2); assert.equal(h.calls.produce, 1)
    assert.equal(h.calls.export, 0); assert.equal(h.calls.downloadExport, 0); assert.equal(h.calls.browserInspect, 0)
  }
})

test('production API and export retain the original account after a different account becomes the default', async t => {
  const h = fixture(t), job = await prepared(h)
  const other = h.hs.create({ label: '另一个华生账号' })
  h.hs.setDefault(other.accountName)
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.service.detail(job.id).huashengAccountName, h.h.accountName)
  assert.equal(h.calls.productionInspect, 1); assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)
  assert.equal(h.calls.browserInspect, 0)
})

test('HTTP routes validate source and cross-site writes, expose range source before transcription without local paths', async t => {
  const h = fixture(t, { transcribe: async () => { throw new Error('ASR unavailable') } })
  const post = (url: string, data: unknown, headers = {}) => h.route.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) })
  for (const sourceUrl of ['https://example.com/video', 'file:///etc/passwd', 'https://www.youtube.com/@science/videos'])
    assert.equal((await post('/jobs', { sourceUrl })).status, 400)
  assert.equal((await post('/jobs', { sourceUrl }, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await post('/jobs', { sourceUrl, unexpected: true })).status, 400)
  const response = await post('/jobs', { sourceUrl }); assert.equal(response.status, 202)
  const job = (await response.json()).data; await h.service.waitForIdle()
  const range = await h.route.request(`/jobs/${job.id}/assets/source`, { headers: { Range: 'bytes=2-5' } })
  assert.equal(range.status, 206); assert.equal(await range.text(), 'urce')
  assert.equal((await h.route.request(`/jobs/${job.id}/assets/source`, { headers: { Range: 'bytes=100-' } })).status, 416)
  assert.equal((await h.route.request(`/jobs/${job.id}/assets/secret`)).status, 400)
  const detail = await h.route.request(`/jobs/${job.id}`); assert.equal(detail.status, 200); assert.equal((await detail.text()).includes(h.root), false)
})

test('a failed transcription can use an edited complete source without downloading or transcribing twice', async t => {
  const h = fixture(t, { transcribe: async () => { throw new Error('ASR unavailable') } })
  const job = h.service.create({ sourceUrl }); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).stage, 'transcribe')
  h.service.patch(job.id, { transcript: 'The complete source supplied by the editor.' })
  h.service.prepare(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'draft'); assert.equal(h.calls.download, 1)
})

test('stopping a live preparation keeps downloaded material and waits for the running handle', async t => {
  let started!: () => void
  const start = new Promise<void>(resolve => { started = resolve })
  const h = fixture(t, { transcribe: async (_input, opts) => { started(); await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true })); return '' } })
  const job = h.service.create({ sourceUrl }); await start
  const stopping = h.service.cancel(job.id); assert.equal(stopping.status, 'running')
  await h.service.waitForIdle(); assert.equal(h.service.detail(job.id).status, 'paused')
  assert.ok(h.service.detail(job.id).sourceVideoUrl); assert.equal(h.calls.rewrite, 0)
  h.options.transcribe = async () => { h.calls.transcribe++; return 'The original downloaded source.' }
  h.service.prepare(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'draft')
  assert.equal(h.service.detail(job.id).sourceVideoUrl, null, 'a complete saved transcript releases the source')
})

test('channel-created jobs remain durable and idle until the batch starts them, then automatically reach each selected endpoint', async t => {
  for (const mode of ['drafts', 'videos', 'upload'] as const) {
    const h = fixture(t), collectionId = `science-batch-${randomUUID()}`
    const job = h.service.create({ sourceUrl }, { defer: true, collectionId, sourceChannel: 'https://www.youtube.com/@Science/videos' })
    assert.equal(job.status, 'draft'); assert.equal(job.collectionId, collectionId)
    assert.equal(h.service.knownYoutubeIds().has('abcdefghijk'), true)
    assert.equal(h.service.jobsForCollection(collectionId)[0]!.id, job.id)
    assert.equal(h.calls.download, 0)
    const result = await h.service.runBatchJob(job.id, mode, new AbortController().signal)
    assert.equal(result.status, mode === 'drafts' ? 'draft' : mode === 'videos' ? 'ready' : 'completed')
    assert.equal(h.calls.rewrite, 1); assert.equal(h.calls.produce, mode === 'drafts' ? 0 : 1); assert.equal(h.calls.upload, mode === 'upload' ? 1 : 0)
    const before = { ...h.calls }
    await h.service.runBatchJob(job.id, mode, new AbortController().signal)
    assert.deepEqual(h.calls, before, 'Completed batch work is not recreated or uploaded again')
  }
})

test('batch cancellation awaits its own task and preserves source artifacts', async t => {
  let entered!: () => void
  const pending = new Promise<void>(resolve => { entered = resolve })
  const h = fixture(t, { transcribe: async (_input, options) => {
    entered(); await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); return ''
  } })
  const job = h.service.create({ sourceUrl }, { defer: true })
  const controller = new AbortController(), running = h.service.runBatchJob(job.id, 'upload', controller.signal)
  const rejected = assert.rejects(running, /abort/i)
  await pending; controller.abort(); await rejected
  assert.equal(h.service.detail(job.id).status, 'paused')
  assert.ok(h.service.detail(job.id).sourceVideoUrl); assert.equal(h.calls.produce, 0)
})

test('transient production reads wait and retry the original project without creating another one', async t => {
  const h = fixture(t), job = await prepared(h)
  let reads = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async input => {
    assert.equal(input.projectUrl, 'https://www.huasheng.cn/video/12345')
    if (++reads < 3) throw new HuashengExportApiError('retryable', '花生接口连接中断')
    return { status: 'completed', message: '制作完成' }
  } }
  h.service.produce(job.id); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'ready'); assert.equal(reads, 3)
  assert.equal(h.calls.produce, 1); assert.equal(h.calls.export, 1)
  assert.ok(result.logs.some(log => /自动重试/.test(log.message)))
  assert.equal(result.retry, undefined)
})

test('interrupted downloads requery the saved export and continue the partial file without a second POST', async t => {
  const h = fixture(t), job = await prepared(h)
  let reads = 0, downloads = 0
  const download = h.options.exportApi!.downloadHuashengExport
  h.options.exportApi = { ...h.options.exportApi!,
    inspectHuashengExport: async input => {
      assert.equal(input.taskId, 'task1')
      return { progress: 100, url: `https://fixture.invalid/version-${++reads}.mp4`, filename: 'video.mp4' }
    },
    downloadHuashengExport: async (input, options) => {
      const part = path.join(options!.root!, 'saved.part')
      if (++downloads === 1) {
        fs.mkdirSync(options!.root!, { recursive: true }); fs.writeFileSync(part, 'downloaded-prefix')
        throw new HuashengExportApiError('retryable', '视频下载中断，已保留下载进度')
      }
      assert.equal(fs.readFileSync(part, 'utf8'), 'downloaded-prefix')
      assert.equal(input.url, 'https://fixture.invalid/version-2.mp4')
      return download(input, options)
    },
  }
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.calls.export, 1); assert.equal(reads, 2); assert.equal(downloads, 2)
})

test('exhausted temporary failures retain the project and expose a batch blocker instead of silently moving on', async t => {
  const h = fixture(t), job = await prepared(h)
  let reads = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => {
    reads++; throw new HuashengExportApiError('retryable', '花生接口连接中断')
  } }
  await assert.rejects(h.service.runBatchJob(job.id, 'videos', new AbortController().signal),
    (error: any) => error.retryable === true && /重试/.test(error.message))
  assert.equal(reads, 4); assert.equal(h.calls.export, 0); assert.equal(h.calls.produce, 1)
  assert.equal(h.service.detail(job.id).failureKind, 'temporary')
  assert.equal(h.service.detail(job.id).checkpoint, 'submitted')
})

test('export setup may retry before dispatch but never replays an uncertain dispatched POST', async t => {
  const h = fixture(t), job = await prepared(h)
  let attempts = 0, dispatches = 0
  h.options.exportApi = { ...h.options.exportApi!, createHuashengExport: async input => {
    if (++attempts === 1) throw new HuashengExportApiError('retryable', '项目元数据查询连接中断')
    await input.onDispatched?.(); dispatches++
    throw new HuashengExportApiError('result_uncertain', '创建请求响应未知')
  } }
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(attempts, 2); assert.equal(dispatches, 1)
  assert.equal(h.service.detail(job.id).failureKind, 'action_required')
  h.service.produce(job.id); await h.service.waitForIdle()
  assert.equal(attempts, 2, 'a later resume still must not resend the uncertain POST')
})

test('an expired export polling deadline survives a service restart without creating another export', async t => {
  const h = fixture(t), job = await prepared(h)
  const exportTask = { taskId: 'task1', projectHash: 'a'.repeat(64) }
  const deadlineAt = new Date(Date.now() - 60_000).toISOString()
  const file = pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true, exportTask,
    exportRecovery: { ...exportTask, deadlineAt } })
  let checks = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async () => {
    if (++checks > 1) throw new Error('expired export deadline was reset')
    return { progress: 97, url: null, filename: null }
  } }
  const resumed = new ScienceWorkflowService(h.options)
  t.after(() => resumed.stop())
  resumed.produce(job.id, false); await resumed.waitForIdle()
  assert.match(resumed.detail(job.id).message, /90 分钟/)
  assert.equal(checks, 1); assert.equal(h.calls.export, 0); assert.equal(h.calls.downloadExport, 0)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).exportRecovery.deadlineAt, deadlineAt)
})

test('a completed export still downloads after its persisted polling deadline', async t => {
  const h = fixture(t), job = await prepared(h)
  const exportTask = { taskId: 'task1', projectHash: 'a'.repeat(64) }
  pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true, exportTask,
    exportRecovery: { ...exportTask, deadlineAt: new Date(0).toISOString() } })
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.calls.export, 0); assert.equal(h.calls.downloadExport, 1)
})

test('initializing an export polling deadline preserves zero-progress and recovery dispatch checkpoints', async t => {
  const h = fixture(t), job = await prepared(h)
  const exportTask = { taskId: 'task1', projectHash: 'a'.repeat(64) }
  const zeroSince = new Date(Date.now() - 6 * 60_000).toISOString(), retryDispatchedAt = new Date().toISOString()
  const file = pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true, exportTask,
    exportRecovery: { ...exportTask, zeroSince, retryDispatchedAt } })
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async () => {
    const recovery = JSON.parse(fs.readFileSync(file, 'utf8')).exportRecovery
    assert.equal(recovery.zeroSince, zeroSince); assert.equal(recovery.retryDispatchedAt, retryDispatchedAt)
    assert.ok(Date.parse(recovery.deadlineAt) > Date.now())
    return { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: null }
  } }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.calls.export, 0); assert.equal(h.calls.downloadExport, 1)
})

test('a stalled zero-percent export retries the verified original version once and downloads it', async t => {
  const h = fixture(t), job = await prepared(h)
  const exportTask = { taskId: 'task1', projectHash: 'a'.repeat(64) }
  const file = pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true, exportTask,
    exportRecovery: { ...exportTask, zeroSince: new Date(Date.now() - 6 * 60_000).toISOString() } })
  let checks = 0, verifications = 0
  const create = h.options.exportApi!.createHuashengExport
  const inspectProduction = h.options.exportApi!.inspectHuashengProduction
  h.options.exportApi = { ...h.options.exportApi!,
    inspectHuashengProduction: async input => {
      verifications++
      assert.equal(input.script, job.script)
      assert.deepEqual(input.expectedVoice, { id: 1595608, type: 1, name: '音色小鹭' })
      return inspectProduction(input)
    },
    createHuashengExport: async input => {
      assert.equal(input.projectUrl, 'https://www.huasheng.cn/video/12345')
      const result = await create(input)
      assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).exportRecovery.retryDispatchedAt)
      return result
    },
    inspectHuashengExport: async () => {
      if (++checks > 3) throw new Error('stalled export was never recovered')
      return h.calls.export ? { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: null }
        : { progress: 0, url: null, filename: null }
    },
  }
  const resumed = new ScienceWorkflowService(h.options)
  t.after(() => resumed.stop())
  resumed.produce(job.id, false); await resumed.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(verifications, 2)
  assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1); assert.equal(h.calls.produce, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).exportTask, exportTask)
  assert.equal((h.service.detail(job.id) as any).exportRecovery, undefined)
})

for (const progress of [42, 100]) test(`an export stalled at ${progress}% recovers its original version without replacing the task`, async t => {
  const h = fixture(t), job = await prepared(h)
  const exportTask = { taskId: 'task1', projectHash: 'a'.repeat(64) }
  const file = pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true, exportTask,
    exportRecovery: { ...exportTask, lastProgress: progress, lastProgressAt: new Date(Date.now() - 6 * 60_000).toISOString() } })
  let checks = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async () => {
    if (++checks > 3) throw new Error('nonzero export stall was not recovered')
    return h.calls.export ? { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: null }
      : { progress, url: null, filename: null }
  } }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.calls.export, 1); assert.equal(h.calls.downloadExport, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).exportTask, exportTask)
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).exportRecovery.retryDispatchedAt)
})

test('a nonzero export progress advance resets the stall clock without requesting another export', async t => {
  const h = fixture(t), job = await prepared(h)
  const exportTask = { taskId: 'task1', projectHash: 'a'.repeat(64) }
  const file = pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true, exportTask,
    exportRecovery: { ...exportTask, lastProgress: 37, lastProgressAt: new Date(0).toISOString() } })
  let checks = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async () => {
    if (++checks === 1) return { progress: 42, url: null, filename: null }
    const recovery = JSON.parse(fs.readFileSync(file, 'utf8')).exportRecovery
    assert.equal(recovery.lastProgress, 42)
    assert.ok(Date.parse(recovery.lastProgressAt) > Date.now() - 60_000)
    return { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: null }
  } }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.calls.export, 0)
})

test('a nonzero stalled recovery remains single-dispatch after an uncertain response and resume', async t => {
  const h = fixture(t), job = await prepared(h)
  const exportTask = { taskId: 'task1', projectHash: 'a'.repeat(64) }
  pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true, exportTask,
    exportRecovery: { ...exportTask, lastProgress: 42, lastProgressAt: new Date(0).toISOString() } })
  let posts = 0, checks = 0
  h.options.exportApi = { ...h.options.exportApi!,
    createHuashengExport: async input => { posts++; await input.onDispatched?.(); throw new HuashengExportApiError('result_uncertain', '原恢复响应未知') },
    inspectHuashengExport: async () => {
      if (++checks > 4) throw new Error('nonzero export recovery was not stopped')
      return { progress: 42, url: null, filename: null }
    },
  }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(posts, 1)
  h.options.exportStallMs = 0
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(posts, 1)
  assert.match(h.service.detail(job.id).message, /重试.*42%/)
  assert.equal(h.calls.downloadExport, 0)
})

test('stalled export recovery dispatch is persisted and never replayed after an uncertain response or resume', async t => {
  const h = fixture(t, { exportStallMs: 0 }), job = await prepared(h)
  const file = pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true,
    exportTask: { taskId: 'task1', projectHash: 'a'.repeat(64) } })
  let posts = 0, checks = 0
  h.options.exportApi = { ...h.options.exportApi!,
    createHuashengExport: async input => {
      posts++; await input.onDispatched?.()
      assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).exportRecovery.retryDispatchedAt)
      throw new HuashengExportApiError('result_uncertain', '重试响应未知')
    },
    inspectHuashengExport: async () => {
      if (++checks > 4) throw new Error('stalled export was never stopped')
      return { progress: 0, url: null, filename: null }
    },
  }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(posts, 1)
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(posts, 1)
  assert.match(h.service.detail(job.id).message, /重试.*0%/)
  assert.equal(h.calls.downloadExport, 0)
})

test('stalled export recovery never replaces a different returned task or project version', async t => {
  const h = fixture(t, { exportStallMs: 0 }), job = await prepared(h)
  const exportTask = { taskId: 'task1', projectHash: 'a'.repeat(64) }
  const file = pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true, exportTask })
  let checks = 0
  h.options.exportApi = { ...h.options.exportApi!,
    createHuashengExport: async input => {
      await input.onDispatched?.()
      return { taskId: 'other-task', projectHash: 'b'.repeat(64) }
    },
    inspectHuashengExport: async () => {
      if (++checks > 3) throw new Error('stalled export was never recovered')
      return { progress: 0, url: null, filename: null }
    },
  }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.match(h.service.detail(job.id).message, /导出.*不一致/)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).exportTask, exportTask)
  assert.equal(h.calls.downloadExport, 0)
})

test('an export already making progress is polled without another create request', async t => {
  const h = fixture(t, { exportStallMs: 0 }), job = await prepared(h)
  pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true,
    exportTask: { taskId: 'task1', projectHash: 'a'.repeat(64) } })
  let checks = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async () => ++checks === 1
    ? { progress: 97, url: 'https://fixture.invalid/partial.mp4', filename: null }
    : { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: null } }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.calls.export, 0); assert.equal(h.calls.downloadExport, 1)
})

test('a proven rejected recovery request does not consume the original export retry', async t => {
  const h = fixture(t, { exportStallMs: 0 }), job = await prepared(h)
  const file = pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true,
    exportTask: { taskId: 'task1', projectHash: 'a'.repeat(64) } })
  let attempts = 0, checks = 0
  h.options.exportApi = { ...h.options.exportApi!,
    createHuashengExport: async input => {
      await input.onDispatched?.()
      if (++attempts === 1) throw new HuashengExportApiError('login_required', '平台拒绝了请求', true)
      return { taskId: 'task1', projectHash: 'a'.repeat(64) }
    },
    inspectHuashengExport: async () => {
      if (++checks > 5) throw new Error('stalled export was never recovered')
      return attempts === 2 ? { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: null }
        : { progress: 0, url: null, filename: null }
    },
  }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).exportRecovery.retryDispatchedAt, undefined)
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(attempts, 2); assert.equal(h.calls.downloadExport, 1)
})

test('progress followed by zero never clears a previous export recovery dispatch', async t => {
  const h = fixture(t, { exportStallMs: 0 }), job = await prepared(h)
  const exportTask = { taskId: 'task1', projectHash: 'a'.repeat(64) }
  pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true, exportTask,
    exportRecovery: { ...exportTask, zeroSince: new Date(0).toISOString(), retryDispatchedAt: new Date(0).toISOString() } })
  let checks = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async () => {
    if (++checks > 2) throw new Error('stalled export was never stopped')
    return { progress: checks === 1 ? 97 : 0, url: null, filename: null }
  } }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.match(h.service.detail(job.id).message, /重试.*0%/)
  assert.equal(h.calls.export, 0)
})

test('a recovered export is not retried if it progresses during the original-project verification', async t => {
  const h = fixture(t, { exportStallMs: 0 }), job = await prepared(h)
  pendingHuasheng(h, job.id, { productionCompleted: true, exportDispatched: true,
    exportTask: { taskId: 'task1', projectHash: 'a'.repeat(64) } })
  let checks = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengExport: async () => ++checks === 1
    ? { progress: 0, url: null, filename: null }
    : { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: null } }
  h.service.produce(job.id, false); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(h.calls.export, 0); assert.equal(h.calls.downloadExport, 1)
})

test('legacy intentional-stop records display paused while genuine failures remain actionable', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(saved, { status: 'needs_attention', message: '已停止本机执行，素材和平台检查点已保留，可继续原任务' })
  fs.writeFileSync(file, JSON.stringify(saved))
  assert.equal(h.service.detail(job.id).status, 'paused')
  saved.message = '花生登录已失效'
  fs.writeFileSync(file, JSON.stringify(saved))
  assert.equal(h.service.detail(job.id).status, 'needs_attention')
})

test('resuming an unfinished transcription reaches the existing download validator even when a file exists', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  Object.assign(saved, { transcript: '', script: '', status: 'paused', stage: 'transcribe' })
  delete saved.media.videoSha256
  fs.writeFileSync(file, JSON.stringify(saved))
  h.options.transcribe = async input => {
    assert.equal(input.videoSha256, sourceVideoHash, 'the existing download adapter must repair missing validation metadata')
    return 'Reused and verified source.'
  }
  h.service.prepare(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'draft')
  assert.equal(h.calls.download, 2)
})

test('a missing source hash invalidates the old transcript and redownloads before rewriting', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete saved.media.videoSha256
  fs.writeFileSync(file, JSON.stringify(saved))

  h.service.prepare(job.id); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'draft')
  assert.equal(h.calls.download, 2)
  assert.equal(h.calls.transcribe, 2)
  assert.equal(h.calls.rewrite, 2)
  assert.ok(result.logs.some(log => /清除旧转写和二创稿/.test(log.message)))
})

test('a changed source file invalidates the recorded hash and restores the downloaded source', async t => {
  const h = fixture(t), job = await prepared(h)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(saved.media.videoPath, 'changed-source-video')

  h.service.prepare(job.id); await h.service.waitForIdle()
  const result = h.service.detail(job.id)
  assert.equal(result.status, 'draft')
  assert.equal(h.calls.download, 2)
  assert.equal(result.transcript, 'Water expands as it freezes, lowering its density.')
  assert.equal(fs.existsSync(saved.media.videoPath), false, 'the verified replacement is reclaimed after its transcript is saved')
})

test('a saved transcript survives source reclamation and regenerates only the requested preparation stage', async t => {
  const h = fixture(t), job = await prepared(h)
  assert.equal(h.service.detail(job.id).sourceVideoUrl, null)
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.transcriptCheckpoint.transcriptSha256, createHash('sha256').update(saved.transcript).digest('hex'))
  assert.equal(saved.transcriptCheckpoint.sourceVideoSha256, sourceVideoHash)
  assert.ok(saved.media.cleanup.localReleasedAt)
  h.service.prepare(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'draft')
  assert.equal(h.calls.download, 1)
  assert.equal(h.calls.transcribe, 1)
  assert.equal(h.calls.rewrite, 2)
})

test('a recreation outage preserves the saved transcript after media cleanup and retry never repeats ASR', async t => {
  const h = fixture(t)
  const rewrite = h.options.rewrite!
  h.options.rewrite = async () => { throw new Error('writer unavailable') }
  const created = h.service.create({ sourceUrl }, { defer: true })
  h.service.prepare(created.id); await h.service.waitForIdle()
  const failed = h.service.detail(created.id)
  assert.equal(failed.status, 'needs_attention')
  assert.ok(failed.transcript.trim())
  assert.equal(failed.sourceVideoUrl, null)
  h.options.rewrite = rewrite
  h.service.prepare(created.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(created.id).status, 'draft')
  assert.equal(h.calls.download, 1)
  assert.equal(h.calls.transcribe, 1)
})

function pendingWritingCheckpoint(transcript: string): ScienceWritingCheckpoint {
  return { version: 1, sourceHash: createHash('sha256').update(transcript).digest('hex'),
    writingVersion: SCIENCE_WRITING_VERSION, writingModel: 'fixture-qwen',
    draft: { title: '尚待修订的稿件', script: '冰会沉下去，这是尚未通过核验的正文。' },
    issues: [{ quote: '冰会沉下去', instruction: '原文说明密度降低，需修正为浮起来。' }],
    feedback: '原文说明密度降低，需修正为浮起来。', round: 8, reviewed: true }
}

test('a failed source review retains its draft and exact corrections without exposing it as accepted narration', async t => {
  const h = fixture(t), rewrite = h.options.rewrite!
  let pending: ScienceWritingCheckpoint | undefined
  h.options.rewrite = async (input, opts) => {
    pending = pendingWritingCheckpoint(input.transcript)
    opts.onCheckpoint?.(pending)
    throw new Error('核验服务暂不可用')
  }
  const job = h.service.create({ sourceUrl }, { defer: true })
  h.service.prepare(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(stored.writingCheckpoint, pending)
  assert.equal(h.service.detail(job.id).script, '', 'a rejected draft cannot become production input')
  assert.equal('writingCheckpoint' in h.service.detail(job.id), false, 'internal repair material is not exposed through the public job')
  h.options.rewrite = async (input, opts) => {
    assert.deepEqual(opts.checkpoint, pending)
    return rewrite(input, opts)
  }
  h.service.prepare(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'draft')
  assert.match(h.service.detail(job.id).script, /冰浮在水上/)
  assert.equal(h.calls.download, 1); assert.equal(h.calls.transcribe, 1)
})

test('editing the original transcript invalidates a saved pending writing repair', async t => {
  const h = fixture(t)
  h.options.rewrite = async (input, opts) => {
    opts.onCheckpoint?.(pendingWritingCheckpoint(input.transcript))
    throw new Error('核验尚未完成')
  }
  const job = h.service.create({ sourceUrl }, { defer: true })
  h.service.prepare(job.id); await h.service.waitForIdle()
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).writingCheckpoint)
  h.service.patch(job.id, { transcript: 'The corrected original says water expands when it freezes.' })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).writingCheckpoint, undefined)
})

test('automatic delivery resumes rejected writing from its checkpoint and reaches production without another collection', async t => {
  const h = fixture(t), rewrite = h.options.rewrite!
  let writes = 0, pending: ScienceWritingCheckpoint | undefined
  h.options.rewrite = async (input, opts) => {
    if (++writes === 1) {
      pending = pendingWritingCheckpoint(input.transcript)
      opts.onCheckpoint?.(pending)
      throw Object.assign(new Error('已保留稿件与意见，等待自动续修'), { code: 'science_script_revision_pending', retryable: true })
    }
    assert.deepEqual(opts.checkpoint, pending)
    return rewrite(input, opts)
  }
  const job = h.service.create({ sourceUrl, huashengAccountName: h.h.accountName })
  await h.service.waitForIdle()
  const waiting = h.service.detail(job.id)
  assert.equal(waiting.status, 'retry_wait')
  assert.equal(waiting.stage, 'rewrite')
  assert.equal(waiting.script, '')
  assert.equal(waiting.automaticRetry?.attempt, 1)
  assert.equal(h.calls.produce, 0)
  const file = path.join(h.root, 'jobs', job.id, 'job.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  stored.automaticRetry.nextRetryAt = new Date(Date.now() - 1000).toISOString()
  fs.writeFileSync(file, JSON.stringify(stored))
  assert.deepEqual(h.service.runAutomaticExports(), [job.id])
  await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.equal(writes, 2)
  assert.equal(h.calls.download, 1); assert.equal(h.calls.transcribe, 1); assert.equal(h.calls.produce, 1)
})

test('exhausted transient writing or review requests automatically resume their saved draft before production', async t => {
  for (const phase of ['writing', 'review'] as const) {
    const h = fixture(t), rewrite = h.options.rewrite!
    let writes = 0, pending: ScienceWritingCheckpoint | undefined
    h.options.rewrite = async (input, opts) => {
      if (++writes === 1) {
        pending = pendingWritingCheckpoint(input.transcript)
        if (phase === 'review') Object.assign(pending, { reviewed: false, issues: [], feedback: '' })
        opts.onCheckpoint?.(pending)
        throw Object.assign(new Error('模型服务暂时不可用，已保存当前稿件'), {
          name: 'ScienceModelRetryExhaustedError', code: 'science_model_retry_exhausted',
          retryable: true, phase, attempts: 4, status: 503,
        })
      }
      assert.deepEqual(opts.checkpoint, pending)
      return rewrite(input, opts)
    }
    const job = h.service.create({ sourceUrl, huashengAccountName: h.h.accountName })
    await h.service.waitForIdle()
    const waiting = h.service.detail(job.id)
    assert.equal(waiting.status, 'retry_wait', phase)
    assert.equal(waiting.stage, 'rewrite')
    assert.equal(waiting.script, '')
    assert.equal(waiting.automaticRetry?.attempt, 1)
    assert.equal(h.calls.produce, 0)
    const file = path.join(h.root, 'jobs', job.id, 'job.json')
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(stored.writingCheckpoint, pending)
    stored.automaticRetry.nextRetryAt = new Date(Date.now() - 1000).toISOString()
    fs.writeFileSync(file, JSON.stringify(stored))
    assert.deepEqual(h.service.runAutomaticExports(), [job.id])
    await h.service.waitForIdle()
    assert.equal(h.service.detail(job.id).status, 'ready')
    assert.equal(writes, 2)
    assert.equal(h.calls.download, 1); assert.equal(h.calls.transcribe, 1); assert.equal(h.calls.produce, 1)
  }
})

test('user cancellation revokes automatic writing repair while retaining the rejected draft', async t => {
  const h = fixture(t)
  let writes = 0
  h.options.rewrite = async (input, opts) => {
    writes++
    opts.onCheckpoint?.(pendingWritingCheckpoint(input.transcript))
    throw Object.assign(new Error('文稿等待续修'), { code: 'science_script_revision_pending', retryable: true })
  }
  const job = h.service.create({ sourceUrl, huashengAccountName: h.h.accountName })
  await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'retry_wait')
  h.service.cancel(job.id)
  assert.equal(h.service.detail(job.id).status, 'paused')
  assert.equal(h.service.detail(job.id).automaticRetry, undefined)
  assert.deepEqual(h.service.runAutomaticExports(), [])
  assert.equal(writes, 1)
  assert.ok(JSON.parse(fs.readFileSync(path.join(h.root, 'jobs', job.id, 'job.json'), 'utf8')).writingCheckpoint)
})

test('editing a saved transcript after media cleanup preserves its durable source identity', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.patch(job.id, { transcript: 'A corrected complete narration supplied by the editor.' })
  h.service.prepare(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).transcript, 'A corrected complete narration supplied by the editor.')
  assert.equal(h.calls.download, 1)
  assert.equal(h.calls.transcribe, 1)
})

test('maintenance upgrades a verified legacy transcript before reclaiming source files and refuses unfinished jobs', async t => {
  const h = fixture(t), job = h.service.create({ sourceUrl }, { defer: true })
  const file = path.join(h.root, 'jobs', job.id, 'job.json'), saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  const videoPath = path.join(path.dirname(file), 'source.mp4')
  fs.writeFileSync(videoPath, 'source-video')
  saved.media = { videoPath, videoSha256: sourceVideoHash }
  fs.writeFileSync(file, JSON.stringify(saved))
  await assert.rejects(h.service.cleanupSourceMedia(job.id), /完整转录/)
  assert.ok(fs.existsSync(videoPath))
  Object.assign(saved, { transcript: 'A complete transcript saved by an older workflow.', script: 'Keep the generated script.' })
  fs.writeFileSync(file, JSON.stringify(saved))
  const cleaned = await h.service.cleanupSourceMedia(job.id)
  assert.ok(cleaned.localReleasedAt)
  assert.equal(fs.existsSync(videoPath), false)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(after.script, saved.script)
  assert.equal(after.transcriptCheckpoint.transcriptSha256, createHash('sha256').update(saved.transcript).digest('hex'))
  assert.equal(h.calls.download + h.calls.transcribe + h.calls.rewrite, 0)
  Object.assign(after, { status: 'queued', ownerPid: process.ppid })
  fs.writeFileSync(file, JSON.stringify(after))
  await assert.rejects(h.service.cleanupSourceMedia(job.id), /任务执行中/)
})

test('stopping during retry backoff immediately pauses and never starts the next query', async t => {
  let entered!: () => void
  const start = new Promise<void>(resolve => { entered = resolve })
  const h = fixture(t, { retryDelayMs: 60_000 }), job = await prepared(h)
  let reads = 0
  h.options.exportApi = { ...h.options.exportApi!, inspectHuashengProduction: async () => {
    reads++; entered(); throw new HuashengExportApiError('retryable', '接口暂时失败')
  } }
  h.service.produce(job.id); await start
  h.service.cancel(job.id); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'paused')
  assert.equal(reads, 1); assert.equal(h.calls.export, 0); assert.equal(h.service.detail(job.id).retry, undefined)
})

test('stopping upload checkpoint inspection pauses even when the upload recovery returns cancellation', async t => {
  const h = fixture(t), job = await prepared(h)
  h.service.produce(job.id); await h.service.waitForIdle()
  let entered!: () => void, release!: () => void
  const start = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  h.options.uploadRuntime!.inspectSocialUploadCheckpoint = async () => {
    entered(); await hold; return { action: 'upload', phase: 'new', message: 'new' }
  }
  h.service.upload(job.id); await start
  h.service.cancel(job.id); release(); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'paused')
  assert.ok(h.service.detail(job.id).videoUrl)
  assert.equal(h.calls.upload, 0)
})

test('batch cannot cancel or adopt a live manual task and account validation does not fall back from explicit null', async t => {
  let release!: (text: string) => void
  let entered!: () => void
  const pending = new Promise<void>(resolve => { entered = resolve })
  const h = fixture(t, { transcribe: async () => { entered(); return new Promise<string>(resolve => { release = resolve }) } })
  const job = h.service.create({ sourceUrl }); await pending
  await assert.rejects(h.service.runBatchJob(job.id, 'drafts', new AbortController().signal), /执行进程/)
  assert.equal(h.service.detail(job.id).status, 'running')
  release('original source'); await h.service.waitForIdle()
  assert.equal(h.service.detail(job.id).status, 'ready')
  assert.deepEqual(h.service.validateBatchAccounts('upload'), { huashengAccountName: h.h.accountName, baijiahaoAccountName: h.b.accountName })
  assert.throws(() => h.service.validateBatchAccounts('videos', null, null), /选择华生账号/)
  assert.throws(() => h.service.validateBatchAccounts('upload', h.h.accountName, null), /选择百家号账号/)
  assert.deepEqual(h.service.validateBatchAccounts('drafts', null, null), { huashengAccountName: null, baijiahaoAccountName: null })
})

test('channel collection HTTP API drives multiple real workflow jobs through export and verified draft receipts automatically', async t => {
  const h = fixture(t), videos = ['abcdefghijk', 'bcdefghijkl', 'cdefghijklm']
  const existing = h.service.create({ sourceUrl }, { defer: true })
  const channels: string[] = []
  const collection = new ScienceCollectionService({ stateRoot: path.join(h.root, 'collection'), workflow: h.service,
    collect: async options => {
      channels.push(options.url)
      const candidates = options.url.includes('@first') ? videos.slice(0, 2) : videos.slice(1)
      for (const [index, id] of candidates.entries()) {
        options.signal.throwIfAborted(); if (options.isTargetReached()) return
        const known = options.isKnownVideo(id)
        options.report({ stage: known ? 'skipping' : 'selecting', message: known ? '跳过已有视频' : '发现新视频', scanned: index + 1,
          candidate: { outcome: known ? 'skipped' : 'selected', videoId: id, title: `科普 ${id}` } })
        if (!known) await options.onCandidate({ videoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}`, title: `科普 ${id}`,
          authorName: 'science', observedAt: new Date().toISOString(), collectionUrl: options.url })
      }
      options.report({ stage: 'exhausted', message: '频道已到底' })
    },
  })
  t.after(() => collection.stop())
  const route = createScienceWorkflowRoute({ service: h.service, collection, accounts: createScienceAccountsRoute({ huasheng: h.hs, baijiahao: h.bjh }) })
  const request = (method: string, url: string, payload: unknown, origin?: string) => route.request(url, {
    method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(payload),
  })
  assert.equal((await request('POST', '/collection/runs', { requestId: 'empty', mode: 'upload' })).status, 400)
  assert.equal((await request('PUT', '/collection/settings', { youtubeChannels: ['https://www.youtube.com/@first'] }, 'https://evil.example')).status, 403)
  assert.equal((await request('PUT', '/collection/settings', { youtubeChannels: [sourceUrl] })).status, 400)
  const settings = await request('PUT', '/collection/settings', { youtubeChannels: ['https://www.youtube.com/@first', 'https://www.youtube.com/@second'], targetCount: 2, mode: 'upload' })
  assert.equal(settings.status, 200)
  const input = { requestId: 'batch-end-to-end', mode: 'upload', targetCount: 2, huashengAccountName: h.h.accountName, baijiahaoAccountName: h.b.accountName }
  const start = await request('POST', '/collection/runs', input)
  assert.equal(start.status, 202); const batchId = (await start.json()).data.id
  const repeated = await request('POST', '/collection/runs', input); assert.equal((await repeated.json()).data.id, batchId)
  await collection.waitForIdle()
  const overview = (await (await route.request('/collection')).json()).data
  assert.equal(overview.activeRun, null)
  const batch = overview.runs[0]
  assert.equal(batch.status, 'completed'); assert.equal(batch.counts.completed, 2); assert.equal(batch.counts.selected, 2); assert.equal(batch.counts.skipped, 2)
  assert.deepEqual(channels, ['https://www.youtube.com/@first/videos', 'https://www.youtube.com/@second/videos'])
  const jobs = h.service.jobsForCollection(batchId)
  assert.equal(jobs.length, 2)
  for (const job of jobs) {
    assert.equal(job.status, 'completed'); assert.equal(job.upload?.accountName, h.b.accountName); assert.equal(job.upload?.submitted, true); assert.equal(job.upload?.saved, false)
    assert.equal(job.huashengAccountName, h.h.accountName); assert.ok(job.videoUrl)
  }
  assert.equal(h.calls.download, 2); assert.equal(h.calls.transcribe, 2); assert.equal(h.calls.rewrite, 2); assert.equal(h.calls.produce, 2); assert.equal(h.calls.export, 2)
  assert.equal(h.calls.upload, 2); assert.equal(h.calls.save, 2)
  assert.equal(h.service.detail(existing.id).status, 'draft', 'A video already in the library is not adopted or processed by the new batch')
  const restored = new ScienceCollectionService({ stateRoot: path.join(h.root, 'collection'), workflow: h.service })
  assert.deepEqual(restored.overview().settings.youtubeChannels, overview.settings.youtubeChannels)
  assert.equal(restored.overview().runs[0]!.counts.completed, 2)
  assert.equal((await request('POST', `/collection/runs/${batchId}/resume`, {})).status, 202)
  for (const action of ['collection/stop', 'collection/resume', 'processing/stop', 'processing/resume']) {
    assert.equal((await request('POST', `/collection/runs/${batchId}/${action}`, { unexpected: true })).status, 400)
    assert.equal((await request('POST', `/collection/runs/${batchId}/${action}`, {}, 'https://evil.example')).status, 403)
    const controlled = await request('POST', `/collection/runs/${batchId}/${action}`, {})
    assert.equal(controlled.status, action.endsWith('/resume') ? 202 : 200)
    const saved = (await controlled.json()).data
    assert.equal(saved.collection.status, 'completed')
    assert.equal(saved.processing.status, 'completed')
  }
  await collection.waitForIdle(); assert.equal(h.calls.upload, 2)
})
