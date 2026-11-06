import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { MysteryStore } from './mystery-store.js'
import { hashMysteryText, type MysteryAnalysis } from './mystery-script.js'
import type { MysteryEdition, MysteryRevision } from './mystery-types.js'
import type { MysteryDeliveryOptions, MysteryDeliveryContext } from './mystery-delivery.js'
import type { SocialUploadResult, SocialUploadPayload } from './social-auto-upload.js'

const moduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mystery-delivery-import-'))
process.env.DB_PATH = path.join(moduleRoot, 'imports.db')
process.env.TASK_WORKER_DISABLED = '1'
const { produceMysteryEdition, prepareMysteryCovers, publishMysteryEdition } = await import('./mystery-delivery.js')
const { HuashengExportApiError } = await import('./history-huasheng-export-api.js')
after(() => fs.rmSync(moduleRoot, { recursive: true, force: true }))
const original = '门为什么开着？他先看门锁，又走到窗边。直到今天答案仍未知。'
const projectUrl = 'https://www.huasheng.cn/video/12345'

function fixture(t: any, text = original) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mystery-delivery-')), sqlite = new Database(path.join(root, 'state.db')), store = new MysteryStore(sqlite)
  const analysis: MysteryAnalysis = { sourceHash: hashMysteryText(text), theme: '疑问', purpose: '沿调查满足好奇心', audienceNeeds: ['好奇心'], endingPayoff: '保留未知', stance: '不妄下结论',
    evidence: [{ id: 'e1', start: 0, end: text.length, quote: text, note: '来源' }],
    beats: [{ id: 'b1', start: 0, end: text.length, purpose: '调查推进', emotion: '疑惑', method: '设问', reveal: '仍未知' }],
    identitySpans: [], dossier: { people: [], timeline: [], claims: [], uncertainties: ['结局未知'] } }
  const revision: MysteryRevision = { id: 1, createdAt: '', source: text, sourceHash: hashMysteryText(text), narrator: '叙述者',
    analysis, patches: [], text, textHash: hashMysteryText(text), review: null }
  const edition: MysteryEdition = { id: randomUUID(), revisionId: 1, scriptHash: revision.textHash, accountName: 'mystery_huasheng_' + 'a'.repeat(32), createdAt: '', status: 'queued',
    projectUrl: null, checkpoint: null, exportDispatched: false, exportTask: null, requestedSettings: { aspect: '16:9', voice: '', subtitle: '', visual: '' },
    confirmedSettings: { scheme: 'A - 素材剪辑成片' }, message: '', coverRevision: 0, coverInstruction: '', title: '门后的谜团', description: '调查与未知', tags: [] }
  const story = store.create({ title: edition.title, category: 'case', sourceUrl: 'https://youtu.be/abcdefghijk', videoId: 'abcdefghijk', sourceChannel: '来源频道',
    sourceTitle: edition.title, downloadMode: 'video', media: {}, transcript: text, correctedTranscript: text, chunks: [], transcriptVersion: 1, narrator: revision.narrator,
    analysis, revisions: [revision], currentRevisionId: 1, editions: [edition], runs: [], status: 'draft', stage: 'produce', message: '', version: 1, notes: '', relatedStoryIds: [],
    createdAt: '', updatedAt: '', archivedAt: null, logs: [] })
  const config = { endpoint: 'http://127.0.0.1:9250', profile: path.join(root, 'profile-original'), expectedUid: 'bound-user' }
  const calls = { browser: 0, inspectProduction: 0, export: 0, inspectExport: 0, download: 0, covers: 0, upload: 0, confirm: 0 }
  const logs: string[] = [], uploads: SocialUploadPayload[] = [], uploadResults = new Map<string, SocialUploadResult>()
  const context: MysteryDeliveryContext = { read: () => store.get(story.id), update: fn => store.update(story.id, fn), editionId: edition.id, directory: path.join(root, 'edition'),
    signal: new AbortController().signal, report: message => logs.push(message), browserConfig: config, track: () => {} }
  const options: MysteryDeliveryOptions = { pollMs: 0, browser: { runHuashengBrowserJob: async input => {
    calls.browser++; assert.deepEqual(input.browserConfig, config); assert.equal(input.script, text)
    await input.onCheckpoint({ checkpoint: 'submitted', projectUrl, message: '已接受' }); return { projectUrl }
  } }, exportApi: {
    inspectHuashengProduction: async input => { calls.inspectProduction++; assert.equal(input.projectUrl, projectUrl); assert.deepEqual(input.browserConfig, config); return { status: 'completed', message: '素材就绪' } },
    createHuashengExport: async input => { calls.export++; assert.deepEqual(input.browserConfig, config); await input.onDispatched?.(); return { taskId: 'original-export', projectHash: 'a'.repeat(64) } },
    inspectHuashengExport: async input => { calls.inspectExport++; assert.equal(input.taskId, 'original-export'); assert.deepEqual(input.browserConfig, config); return { progress: 100, url: 'https://fixture.invalid/video.mp4', filename: 'video.mp4' } },
    downloadHuashengExport: async (_input, opts) => { calls.download++; fs.mkdirSync(opts!.root!, { recursive: true }); const filePath = path.join(opts!.root!, 'video.mp4')
      fs.writeFileSync(filePath, 'finished-video'); return { filePath, filename: 'video.mp4', bytes: 14 } },
  },
    inspectVideo: async file => ({ videoSha256: hashMysteryText(fs.readFileSync(file, 'utf8')), duration: 90, width: 1280, height: 720, bytes: fs.statSync(file).size }),
    prepareAssets: async input => { calls.covers++; fs.mkdirSync(input.directory, { recursive: true }); const landscapePath = path.join(input.directory, 'landscape.jpg'), portraitPath = path.join(input.directory, 'portrait.jpg')
      fs.writeFileSync(landscapePath, 'landscape'); fs.writeFileSync(portraitPath, 'portrait')
      return { videoSha256: hashMysteryText('finished-video'), landscapePath, portraitPath, landscapeSha256: hashMysteryText('landscape'), portraitSha256: hashMysteryText('portrait') } },
    inspectAssets: async input => ({ ...input, videoSha256: hashMysteryText('finished-video'), landscapeSha256: hashMysteryText('landscape'), portraitSha256: hashMysteryText('portrait') }),
    uploadRuntime: {
      inspectSocialUploadCheckpoint: async payload => { const result = uploadResults.get(payload.jobId)
        return result ? { action: result.submitted ? 'complete' : 'save', phase: result.submitted ? 'submitted' : 'staged', message: 'original checkpoint', result }
          : { action: 'upload', phase: 'new', message: 'new' } },
      inspectSocialUploadAccountRuntime: async name => { assert.equal(name, 'mystery_' + 'b'.repeat(32)); return { ready: true, message: 'ready' } },
      inspectSocialUploadRuntime: async () => { throw new Error('Do not use a default workspace account') },
      runSocialUpload: async payload => { calls.upload++; uploads.push(structuredClone(payload))
        const result: SocialUploadResult = { accountName: payload.accountName, staged: true, saved: false, published: false,
          editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', targetId: 'abc123', engine: 'fixture' }
        uploadResults.set(payload.jobId, result); return result },
      confirmSocialUpload: async (payload, previous) => { calls.confirm++; const result: SocialUploadResult = { ...previous, submitted: true, saved: false, published: false,
        publicationStatus: 'submitted', articleId: '12345', publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=12345' }
        uploadResults.set(payload.jobId, result); return result },
      resumeSocialUpload: async () => { throw new Error('unexpected resume') }, reconcileSocialUpload: async () => { throw new Error('unexpected reconcile') },
    },
  }
  const read = () => context.read().editions[0]!
  const update = (patch: Partial<MysteryEdition>) => context.update(s => Object.assign(s.editions[0]!, patch))
  const publication = () => update({ publication: { accountName: 'mystery_' + 'b'.repeat(32), status: 'pending', title: '门后的谜团', description: '调查与未知',
    tags: ['故事'], creationDeclaration: '含AI生成内容', watermark: '不添加水印', attempt: null, result: null, message: '' } })
  t.after(() => { sqlite.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { store, context, options, revision, read, update, publication, calls, logs, uploads, uploadResults }
}

test('a lost export acknowledgement retains dispatch intent and cannot create a second export', async t => {
  const f = fixture(t)
  f.options.exportApi = { ...f.options.exportApi!, createHuashengExport: async input => {
    f.calls.export++; await input.onDispatched?.(); throw new HuashengExportApiError('result_uncertain', 'lost export reply')
  } }
  await assert.rejects(produceMysteryEdition(f.context, f.revision, f.options), /lost export reply/)
  assert.equal(f.read().projectUrl, projectUrl); assert.equal(f.read().exportDispatched, true); assert.equal(f.read().exportTask, null)
  await assert.rejects(produceMysteryEdition(f.context, f.revision, f.options), /不会重复发起导出/)
  assert.equal(f.calls.export, 1); assert.equal(f.calls.browser, 1); assert.equal(f.calls.download, 0)
  f.update({ exportTask: { taskId: 'original-export', projectHash: 'a'.repeat(64) } })
  await produceMysteryEdition(f.context, f.revision, f.options)
  assert.equal(f.calls.export, 1); assert.equal(f.calls.download, 1); assert.equal(f.read().status, 'video_ready')
})

test('a definite pre-submission export rejection permits retry while retaining the original project', async t => {
  const f = fixture(t), create = f.options.exportApi!.createHuashengExport
  f.options.exportApi = { ...f.options.exportApi!, createHuashengExport: async input => { await input.onDispatched?.(); throw new HuashengExportApiError('retryable', 'rejected', true) } }
  await assert.rejects(produceMysteryEdition(f.context, f.revision, f.options), /rejected/)
  assert.equal(f.read().exportDispatched, false)
  f.options.exportApi = { ...f.options.exportApi!, createHuashengExport: create }
  await produceMysteryEdition(f.context, f.revision, f.options)
  assert.equal(f.calls.browser, 1); assert.equal(f.calls.export, 1)
})

test('production rejects changed revision binding and oversized text without rewriting or submitting it', async t => {
  const f = fixture(t)
  await assert.rejects(produceMysteryEdition(f.context, { ...f.revision, text: original + '新增结论' }, f.options), /版本不匹配/)
  assert.equal(f.calls.browser, 0)
  const long = fixture(t, original.repeat(500))
  await assert.rejects(produceMysteryEdition(long.context, long.revision, long.options), /10000字符/)
  assert.equal(long.read().scriptHash, long.revision.textHash)
  assert.equal(long.calls.browser, 0); assert.equal(long.calls.export, 0)
})

test('completed export is inspected before video readiness, and failed covers reuse the same video and cover revision', async t => {
  const f = fixture(t)
  await produceMysteryEdition(f.context, f.revision, f.options)
  assert.equal(f.read().status, 'video_ready')
  const originalPath = f.read().videoPath, prepare = f.options.prepareAssets!
  f.options.prepareAssets = async () => { throw new Error('portrait failed') }
  await assert.rejects(prepareMysteryCovers(f.context, f.revision, f.options), /portrait failed/)
  assert.equal(f.read().videoPath, originalPath)
  assert.equal(f.read().status, 'video_ready'); assert.equal(f.read().coverRevision, 1); assert.equal(f.read().coverPending, true)
  f.options.prepareAssets = prepare
  await produceMysteryEdition(f.context, f.revision, f.options)
  await prepareMysteryCovers(f.context, f.revision, f.options)
  assert.equal(f.calls.browser, 1); assert.equal(f.calls.export, 1); assert.equal(f.calls.download, 1)
  assert.equal(f.read().coverRevision, 1); assert.equal(f.read().status, 'package_ready')
  assert.equal(f.calls.upload, 0)
})

test('a downloaded but invalid media file cannot be marked as a ready video', async t => {
  const f = fixture(t)
  f.options.inspectVideo = async () => { throw new Error('missing audio stream') }
  await assert.rejects(produceMysteryEdition(f.context, f.revision, f.options), /missing audio stream/)
  assert.equal(f.read().videoPath, undefined)
  assert.notEqual(f.read().status, 'video_ready')
  assert.ok(f.read().exportTask)
})

test('explicit publishing binds original account, title and assets and preserves submitted versus published state', async t => {
  const f = fixture(t)
  await produceMysteryEdition(f.context, f.revision, f.options)
  await prepareMysteryCovers(f.context, f.revision, f.options)
  f.publication()
  await publishMysteryEdition(f.context, f.options)
  assert.equal(f.read().publication!.status, 'submitted')
  assert.equal(f.read().publication!.result!.published, false)
  assert.equal(f.read().publication!.result!.articleId, '12345')
  assert.equal(f.uploads[0]!.accountName, 'mystery_' + 'b'.repeat(32))
  assert.equal(f.uploads[0]!.publicationMode, 'publish')
  assert.deepEqual(f.uploads[0]!.tags, ['故事'])
  assert.doesNotMatch(JSON.stringify(f.uploads[0]), /热爆趣创赛/)
  const payload = structuredClone(f.read().publication!.attempt!.payload)
  await publishMysteryEdition(f.context, f.options)
  assert.equal(f.calls.upload, 1); assert.equal(f.calls.confirm, 1)
  assert.deepEqual(f.read().publication!.attempt!.payload, payload)
})

test('uncertain upload is retained and a repeated attempt cannot select a new upload', async t => {
  const f = fixture(t)
  await produceMysteryEdition(f.context, f.revision, f.options)
  await prepareMysteryCovers(f.context, f.revision, f.options)
  f.publication()
  f.options.uploadRuntime!.runSocialUpload = async () => { f.calls.upload++; throw new Error('network disconnected after upload') }
  await assert.rejects(publishMysteryEdition(f.context, f.options), /未确认|尚未确认/)
  assert.equal(f.read().publication!.status, 'uncertain')
  assert.equal(f.read().publication!.attempt!.dispatched, true)
  await assert.rejects(publishMysteryEdition(f.context, f.options), /不重复上传/)
  assert.equal(f.calls.upload, 1)
  f.update({ coverPending: true })
  await assert.rejects(prepareMysteryCovers(f.context, f.revision, f.options), /不能替换/)
})

