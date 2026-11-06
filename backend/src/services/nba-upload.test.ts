import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { NbaJob, NbaUpload } from './nba-types.js'
import type { SocialUploadCheckpoint, SocialUploadResult } from './social-auto-upload.js'
import { prepareNbaUpload, uploadNbaDraft, uploadNbaVideo, type NbaUploadRuntime } from './nba-upload.js'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-upload-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const videoPath = path.join(root, 'delivery.mp4'), coverPath = path.join(root, 'cover.jpg')
  const video = Buffer.from('verified local video fixture')
  await fs.writeFile(videoPath, video)
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#269a71' } }).jpeg().toFile(coverPath)
  const now = new Date().toISOString()
  const job: NbaJob = { id: `nba-${path.basename(root)}`, title: '原报道标题', status: 'completed', stage: 'completed', message: 'completed',
    createdAt: now, updatedAt: now, attempts: 1, canResume: false, logs: [],
    article: { id: 'article', url: 'https://example.test/article', title: 'Original title', language: 'en', publisher: 'Example News', body: 'original article',
      bodyHash: hash('original article'), wordCount: 2, characterCount: 16, collectedAt: now },
    script: { title: '雷霆末节守住客场胜利', text: '比赛正文。', facts: [{ claim: '比赛正文。', paragraph: 1 }] },
    delivery: { videoPath, coverPath, duration: 30, bytes: video.length, sha256: hash(video), verification: { fullDecode: 'passed', productionInputHash: hash('production') } } }
  const input = { job, jobDir: root, accountName: 'sports-account', accountLabel: '体育', publicationMode: 'draft' as const }
  return { root, job, input, videoPath, coverPath }
}

function withGame(job: NbaJob) {
  job.script!.title = '东契奇砍下42分13助攻，湖人击败热火'
  job.game = { id: 'lakers-heat', localDate: '2026-11-02', tipoffUtc: '2026-11-03T03:00:00Z', localTimezone: 'America/Los_Angeles',
    home: { name: 'Los Angeles Lakers', abbreviation: 'LAL', score: 138 }, away: { name: 'Miami Heat', abbreviation: 'MIA', score: 117 },
    verified: true, evidenceUrls: [] }
}

async function legacyPublication(upload: NbaUpload) {
  const legacy = structuredClone(upload), filename = path.join(path.dirname(legacy.payload!.landscapePath!), 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(filename, 'utf8'))
  delete legacy.publicationCopy; delete manifest.identity.publicationCopy
  legacy.payload!.description = `${legacy.payload!.title} #NBA#`
  manifest.identity.description = legacy.payload!.description
  legacy.fingerprint = hash(JSON.stringify(manifest.identity))
  legacy.payload!.fingerprint = legacy.fingerprint
  manifest.fingerprint = legacy.fingerprint; manifest.payload = legacy.payload
  await fs.writeFile(filename, JSON.stringify(manifest))
  return legacy
}

function uploader(upload: NbaUpload, signal = new AbortController().signal) {
  const current = structuredClone(upload), calls: string[] = [], patches: Partial<NbaUpload>[] = []
  const receipt: SocialUploadResult = { accountName: upload.accountName, staged: true, saved: true, published: false,
    editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2', draftUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123456', targetId: 'ABC123', engine: 'test' }
  const staged = { ...receipt, saved: false, draftUrl: undefined }
  let checkpoint: SocialUploadCheckpoint = { action: 'upload', phase: 'new', message: 'not started' }
  const runtime: NbaUploadRuntime = {
    inspectSocialUploadCheckpoint: async payload => { calls.push('checkpoint'); assert.equal(payload.jobId, upload.id); assert.equal(payload.publicationMode, upload.payload!.publicationMode); return checkpoint },
    inspectSocialUploadAccountRuntime: async account => { calls.push('account'); assert.equal(account, upload.accountName); return { ready: true, message: 'ready' } },
    inspectSocialUploadRuntime: async () => { throw Error('Named account must not use global runtime') },
    runSocialUpload: async (payload, options) => { calls.push('upload'); assert.equal(payload.publicationMode, 'draft'); assert.equal(options.saveDraft, false); checkpoint = { action: 'save', phase: 'staged', message: 'staged', result: staged }; return staged },
    resumeSocialUpload: async () => { calls.push('resume'); checkpoint = { action: 'save', phase: 'staged', message: 'staged', result: staged }; return staged },
    confirmSocialUpload: async payload => { calls.push('save'); assert.equal(payload.publicationMode, 'draft'); checkpoint = { action: 'complete', phase: 'saved', message: 'saved', result: receipt }; return receipt },
    reconcileSocialUpload: async () => { calls.push('reconcile'); checkpoint = { action: 'complete', phase: 'saved', message: 'saved', result: receipt }; return receipt },
  }
  const input = { upload: current, inputDigest: upload.inputDigest, signal,
    persist: async (patch: Partial<NbaUpload>) => { patches.push(structuredClone(patch)); Object.assign(current, patch); if (patch.dispatched) calls.push('persist-dispatched') },
    onProgress: () => {} }
  return { input, current, calls, patches, receipt, staged, runtime, setCheckpoint: (value: SocialUploadCheckpoint) => { checkpoint = value } }
}

test('preparation binds real artifacts, creates correctly sized covers and stable draft identity', async t => {
  const f = await fixture(t), originalCover = await fs.readFile(f.coverPath), originalVideo = await fs.readFile(f.videoPath)
  const linked = path.join(f.root, 'original-cover.jpg'); await fs.link(f.coverPath, linked)
  const first = await prepareNbaUpload(f.input), second = await prepareNbaUpload(f.input)
  assert.equal(first.id, second.id); assert.equal(first.fingerprint, second.fingerprint)
  assert.equal(first.inputDigest, f.job.delivery!.sha256)
  assert.equal(first.payload!.publicationMode, 'draft'); assert.equal(first.payload!.target, 'baijiahao-video')
  assert.equal(first.payload!.description, f.job.script!.title)
  assert.equal(first.payload!.title, f.job.script!.title)
  assert.equal(first.payload!.accountName, 'sports-account')
  assert.deepEqual(await fs.readFile(f.coverPath), originalCover)
  assert.deepEqual(await fs.readFile(linked), originalCover)
  assert.deepEqual(await fs.readFile(f.videoPath), originalVideo)
  assert.deepEqual(await fs.readFile(first.payload!.videoPath!), originalVideo)
  const landscape = await sharp(first.payload!.landscapePath!).metadata(), portrait = await sharp(first.payload!.portraitPath!).metadata()
  assert.deepEqual([landscape.width, landscape.height], [1920, 1080])
  assert.deepEqual([portrait.width, portrait.height], [810, 1080])
  assert.equal(landscape.format, 'png'); assert.equal(portrait.format, 'png')
  assert.notEqual((await fs.stat(first.payload!.videoPath!)).ino, (await fs.stat(f.videoPath)).ino)
})

test('a contaminated article, contaminated narration or quality hold cannot prepare an upload', async t => {
  const f = await fixture(t), tail = '\n\n特别声明：以上文章内容仅代表作者本人观点，不代表新浪网观点或立场。\n\n相关新闻\n\nCopyright © 1996-2026 SINA Corporation'
  const body = f.job.article.body
  f.job.article.body += tail
  await assert.rejects(prepareNbaUpload(f.input), /正文.*网页|网页.*杂项/)
  f.job.article.body = body
  f.job.script!.text += tail
  await assert.rejects(prepareNbaUpload(f.input), /正文.*网页|网页.*杂项/)
  f.job.script!.text = '比赛正文。'
  f.job.qualityHold = { source: 'user-report', detectedAt: f.job.updatedAt, reason: '用户报告平台不合格，已暂停该作品发表' }
  await assert.rejects(prepareNbaUpload(f.input), /暂停/)
})

test('independent portrait covers retain their complete composition and bind their own source', async t => {
  const f = await fixture(t), portraitPath = path.join(f.root, 'portrait.png')
  const band = (background: string) => sharp({ create: { width: 900, height: 120, channels: 3, background } }).png().toBuffer()
  await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#18304f' } })
    .composite([{ input: await band('#ef3141'), left: 0, top: 0 }, { input: await band('#fecb32'), left: 0, top: 1080 }])
    .png().toFile(portraitPath)
  f.job.delivery!.portraitCoverPath = portraitPath
  const original = await fs.readFile(portraitPath), upload = await prepareNbaUpload(f.input)
  const portrait = sharp(upload.payload!.portraitPath!), metadata = await portrait.metadata()
  assert.deepEqual([metadata.width, metadata.height, metadata.format], [900, 1200, 'png'])
  assert.deepEqual(await portrait.raw().toBuffer(), await sharp(original).raw().toBuffer(), 'top and bottom artwork must survive without cropping')
  assert.deepEqual(await fs.readFile(portraitPath), original)
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(upload.payload!.portraitPath!), 'manifest.json'), 'utf8'))
  assert.equal(manifest.identity.covers.portraitSourceSha256, hash(original))
  assert.equal((await prepareNbaUpload(f.input)).fingerprint, upload.fingerprint)
  await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#e32039' } }).png().toFile(portraitPath)
  const updated = await prepareNbaUpload(f.input)
  assert.notEqual(updated.fingerprint, upload.fingerprint)
  assert.deepEqual(await fs.readFile(upload.payload!.portraitPath!), await sharp(original).rotate().png({ compressionLevel: 9 }).toBuffer())
})

test('an invalid independent portrait cannot silently fall back to a landscape crop', async t => {
  const f = await fixture(t), portraitPath = path.join(f.root, 'portrait.png')
  f.job.delivery!.portraitCoverPath = portraitPath
  await sharp({ create: { width: 900, height: 900, channels: 3, background: '#813832' } }).png().toFile(portraitPath)
  await assert.rejects(prepareNbaUpload(f.input), /竖版.*3:4 PNG/)
  await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#813832' } }).jpeg().toFile(portraitPath)
  await assert.rejects(prepareNbaUpload(f.input), /竖版.*3:4 PNG/)
  await fs.writeFile(portraitPath, 'not an image')
  await assert.rejects(prepareNbaUpload(f.input), /有效图片/)
})

test('legacy preparation retains its cover identity when no independent portrait is supplied', async t => {
  const f = await fixture(t), upload = await prepareNbaUpload(f.input)
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(upload.payload!.portraitPath!), 'manifest.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.identity.covers), ['sourceSha256', 'landscapeSha256', 'portraitSha256'])
  assert.equal(upload.fingerprint, hash(JSON.stringify(manifest.identity)))
  assert.deepEqual(await sharp(upload.payload!.portraitPath!).metadata().then(({ width, height }) => [width, height]), [810, 1080])
})

test('an identical prepared version reuses its saved record and original timestamps', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input)
  f.job.uploads = [{ ...prepared, status: 'uncertain', dispatched: true, createdAt: '2026-01-01T00:00:00Z' }]
  assert.deepEqual(await prepareNbaUpload(f.input), f.job.uploads[0])
})

test('changing actual cover, title or account creates different deterministic versions', async t => {
  const f = await fixture(t), original = await prepareNbaUpload(f.input)
  const otherAccount = await prepareNbaUpload({ ...f.input, accountName: 'another-account' })
  assert.notEqual(otherAccount.id, original.id)
  f.job.script!.title = '雷霆客场拿下胜利'
  const otherTitle = await prepareNbaUpload(f.input); assert.notEqual(otherTitle.id, original.id)
  await sharp({ create: { width: 640, height: 360, channels: 3, background: '#c24765' } }).jpeg().toFile(f.coverPath)
  const otherCover = await prepareNbaUpload(f.input); assert.notEqual(otherCover.id, otherTitle.id)
})

test('tampered video, missing cover and invalid title stop local preparation', async t => {
  const f = await fixture(t)
  await fs.appendFile(f.videoPath, 'changed')
  await assert.rejects(prepareNbaUpload(f.input), /摘要或大小/)
  const content = await fs.readFile(f.videoPath); f.job.delivery!.bytes = content.length; f.job.delivery!.sha256 = hash(content)
  f.job.script!.title = 'ESPN报道雷霆获胜'
  await assert.rejects(prepareNbaUpload(f.input), /媒体来源/)
  f.job.script!.title = '比'.repeat(51)
  await assert.rejects(prepareNbaUpload(f.input), /50字/)
  f.job.script!.title = '比赛新闻'
  await fs.writeFile(f.coverPath, 'not an image')
  await assert.rejects(prepareNbaUpload(f.input), /有效图片/)
})

test('an unresolved dispatched version blocks a replacement even if the new version was already prepared', async t => {
  const f = await fixture(t), old = await prepareNbaUpload(f.input)
  f.job.script!.title = '雷霆客场守住比赛'
  const newer = await prepareNbaUpload(f.input)
  f.job.uploads = [{ ...old, status: 'uncertain', dispatched: true }, newer]
  await assert.rejects(prepareNbaUpload(f.input), /原上传.*尚未核实/)
  f.job.uploads = [{ ...old, status: 'saved', dispatched: true }]
  await assert.rejects(prepareNbaUpload(f.input), /原上传.*尚未核实/, 'a saved label without a bound receipt cannot clear the guard')
  const oldUploader = uploader(old)
  f.job.uploads[0].result = oldUploader.receipt
  assert.equal((await prepareNbaUpload(f.input)).fingerprint, newer.fingerprint)
})

test('draft upload durably records dispatch before writes and saves only after its own checkpoint', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input), u = uploader(prepared)
  const result = await uploadNbaDraft(u.input, u.runtime)
  assert.equal(result.saved, true)
  assert.equal(u.current.status, 'saved')
  assert.ok(u.calls.indexOf('persist-dispatched') < u.calls.indexOf('upload'))
  assert.equal(u.calls.filter(call => call === 'upload').length, 1)
  assert.equal(u.calls.filter(call => call === 'save').length, 1)
  assert.ok(u.calls.indexOf('checkpoint', u.calls.indexOf('upload') + 1) < u.calls.indexOf('save'))
  assert.ok(u.patches.every(patch => typeof patch.updatedAt === 'string'))
  assert.ok(u.patches.every(patch => !('payload' in patch) && !('id' in patch) && !('fingerprint' in patch)))
})

test('an already saved draft is read-only verified without live account or local artifacts', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input), u = uploader({ ...prepared, status: 'saved', dispatched: true })
  u.current.result = u.receipt
  u.setCheckpoint({ action: 'complete', phase: 'saved', message: 'saved', result: u.receipt })
  await fs.unlink(prepared.payload!.videoPath!)
  assert.equal((await uploadNbaDraft(u.input, u.runtime)).saved, true)
  assert.deepEqual(u.calls, ['checkpoint', 'persist-dispatched'])
})

test('uncertain dispatched work with a lost checkpoint cannot create a second upload', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input), u = uploader({ ...prepared, status: 'uncertain', dispatched: true })
  const before = structuredClone(u.current)
  assert.equal((await uploadNbaDraft(u.input, u.runtime)).saved, false)
  assert.equal(u.current.status, 'uncertain')
  assert.deepEqual(u.calls.filter(call => call === 'upload' || call === 'save'), [])
  assert.deepEqual(u.current.payload, before.payload); assert.equal(u.current.id, before.id)
})

test('save_requested recovers read-only and never clicks save again', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input), u = uploader({ ...prepared, status: 'uncertain', dispatched: true })
  u.current.result = u.staged
  u.setCheckpoint({ action: 'save', phase: 'save_requested', message: 'unknown save', result: u.staged })
  assert.equal((await uploadNbaDraft(u.input, u.runtime)).saved, true)
  assert.ok(u.calls.includes('reconcile'))
  assert.equal(u.calls.includes('save'), false); assert.equal(u.calls.includes('upload'), false)
})

test('a lost save response reconciles the original identity without repeating the save', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input), u = uploader(prepared)
  u.runtime.confirmSocialUpload = async () => {
    u.calls.push('save')
    u.setCheckpoint({ action: 'reconcile', phase: 'save_requested', message: 'save response lost', result: u.staged })
    throw Error('ECONNRESET')
  }
  const outcome = await uploadNbaDraft(u.input, u.runtime)
  assert.equal(outcome.saved, true)
  assert.equal(u.calls.filter(call => call === 'upload').length, 1)
  assert.equal(u.calls.filter(call => call === 'save').length, 1)
  assert.equal(u.calls.filter(call => call === 'reconcile').length, 1)
  assert.equal(u.current.id, prepared.id); assert.deepEqual(u.current.payload, prepared.payload)
  assert.ok(u.current.attempts?.some(attempt => attempt.action === 'save' && attempt.outcome === 'failed'))
})

test('a failed durable dispatch commit prevents the platform operation', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input), u = uploader(prepared)
  const persist = u.input.persist
  u.input.persist = async patch => { if (patch.dispatched) throw Error('state disk is unavailable'); await persist(patch) }
  assert.equal((await uploadNbaDraft(u.input, u.runtime)).saved, false)
  assert.equal(u.calls.includes('upload'), false); assert.equal(u.calls.includes('save'), false)
  assert.equal(u.current.id, prepared.id); assert.deepEqual(u.current.payload, prepared.payload)
})

test('wrong-account and public-publication receipts never count as saved drafts', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input)
  for (const patch of [{ accountName: 'other-account' }, { published: true }, { submitted: true }]) {
    const u = uploader({ ...prepared, status: 'uncertain', dispatched: true })
    u.setCheckpoint({ action: 'complete', phase: 'saved', message: 'untrusted', result: { ...u.receipt, ...patch } })
    assert.equal((await uploadNbaDraft(u.input, u.runtime)).saved, false)
    assert.equal(u.current.status, 'uncertain')
    assert.equal(u.calls.includes('save'), false); assert.equal(u.calls.includes('upload'), false)
  }
})

test('stop before dispatch and stop after durable dispatch both prevent platform writes', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input), stopped = new AbortController(); stopped.abort()
  const u = uploader(prepared, stopped.signal)
  assert.equal((await uploadNbaDraft(u.input, u.runtime)).saved, false)
  assert.deepEqual(u.calls, [])
  const controller = new AbortController(), v = uploader(prepared, controller.signal), persist = v.input.persist
  v.input.persist = async patch => { await persist(patch); if (patch.dispatched) controller.abort() }
  assert.equal((await uploadNbaDraft(v.input, v.runtime)).saved, false)
  assert.equal(v.current.dispatched, true)
  assert.equal(v.calls.includes('upload'), false); assert.equal(v.calls.includes('save'), false)
})

test('tampered local version or publish mode blocks before any platform operation', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input), u = uploader(prepared)
  await fs.appendFile(prepared.payload!.landscapePath!, 'changed')
  assert.equal((await uploadNbaDraft(u.input, u.runtime)).saved, false)
  assert.equal(u.current.status, 'blocked'); assert.deepEqual(u.calls, [])
  const v = uploader({ ...prepared, payload: { ...prepared.payload!, publicationMode: 'publish' } })
  assert.equal((await uploadNbaDraft(v.input, v.runtime)).saved, false)
  assert.equal(v.current.status, 'blocked'); assert.deepEqual(v.calls, [])
})

test('a changed render only checks an old receipt and cannot write the old version', async t => {
  const f = await fixture(t), prepared = await prepareNbaUpload(f.input), u = uploader(prepared)
  u.input.inputDigest = hash('a newer render')
  assert.equal((await uploadNbaDraft(u.input, u.runtime)).saved, false)
  assert.equal(u.current.status, 'blocked')
  assert.equal(u.calls.includes('upload'), false); assert.equal(u.calls.includes('save'), false)
})

test('NBA uploads default to direct publication with the exact required NBA topic', async t => {
  const f = await fixture(t)
  const upload = await prepareNbaUpload({ ...f.input, publicationMode: undefined })
  assert.equal(upload.payload!.publicationMode, 'publish')
  assert.deepEqual(upload.payload!.tags, ['#NBA#'])
  assert.equal(upload.payload!.topicPolicy, 'required-exact')
  assert.equal(upload.payload!.creationDeclaration, '含AI生成内容')
  assert.equal(upload.payload!.description, `${f.job.script!.title} #NBA#`)
  assert.match(upload.message, /发表/)
})

test('publication requires the bound creation declaration before platform operations', async t => {
  const f = await fixture(t), upload = await prepareNbaUpload({ ...f.input, publicationMode: undefined })
  for (const creationDeclaration of [undefined, '其他声明']) {
    const u = uploader({ ...upload, payload: { ...upload.payload!, creationDeclaration } })
    assert.equal((await uploadNbaVideo(u.input, u.runtime)).submitted, false)
    assert.equal(u.current.status, 'blocked')
    assert.deepEqual(u.calls, [])
  }
})

test('publication descriptions reserve topic space without changing the article title or script', async t => {
  const f = await fixture(t), originalText = f.job.script!.text
  for (const count of [44, 45, 50]) {
    f.job.script!.title = '球'.repeat(count)
    const upload = await prepareNbaUpload({ ...f.input, publicationMode: undefined })
    assert.equal(upload.payload!.title, f.job.script!.title)
    assert.equal([...upload.payload!.description].length, 50)
    assert.equal(upload.payload!.description, `${'球'.repeat(44)} #NBA#`)
    assert.equal(f.job.script!.text, originalText)
  }
})

test('new publish manifests bind the match description independently from the original translated title', async t => {
  const f = await fixture(t); withGame(f.job)
  const upload = await prepareNbaUpload({ ...f.input, publicationMode: 'publish' })
  const description = '2026-11-02 NBA｜东契奇42分13助攻，湖人138-117热火 #NBA#'
  assert.equal(upload.payload!.title, f.job.script!.title)
  assert.equal(upload.payload!.description, description)
  assert.deepEqual(upload.publicationCopy, { policy: 'nba-match-event-v1', description })
  const u = uploader(upload)
  u.current.payload!.description = '比赛文案被替换 #NBA#'; u.current.publicationCopy!.description = u.current.payload!.description
  assert.equal((await uploadNbaVideo(u.input, u.runtime)).submitted, false)
  assert.match(u.current.message, /清单与任务身份/)
  assert.deepEqual(u.calls, [])
})

test('legacy dispatched publication keeps its original description and recovers without a replacement upload', async t => {
  const f = await fixture(t); withGame(f.job)
  const legacy = await legacyPublication(await prepareNbaUpload({ ...f.input, publicationMode: 'publish' }))
  legacy.dispatched = true; legacy.status = 'uncertain'; f.job.uploads = [legacy]
  const prepared = await prepareNbaUpload({ ...f.input, publicationMode: 'publish' })
  assert.deepEqual(prepared, legacy)
  const u = uploader(prepared)
  const receipt: SocialUploadResult = { ...u.receipt, saved: false, submitted: true, published: true, publicationStatus: 'published', articleId: '123456',
    publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=123456', draftUrl: undefined }
  u.setCheckpoint({ action: 'complete', phase: 'published', message: 'published', result: receipt })
  assert.equal((await uploadNbaVideo(u.input, u.runtime)).submitted, true)
  assert.equal(u.current.id, legacy.id)
  assert.equal(u.current.payload!.description, `${f.job.script!.title} #NBA#`)
  assert.equal(u.calls.includes('upload'), false); assert.equal(u.calls.includes('save'), false)
})

test('already published video reuses its receipt after changing description inputs and cover', async t => {
  const f = await fixture(t); withGame(f.job)
  const upload = await prepareNbaUpload({ ...f.input, publicationMode: 'publish' }), u = uploader(upload)
  upload.dispatched = true; upload.status = 'saved'
  upload.result = { ...u.receipt, saved: false, submitted: true, published: true, publicationStatus: 'published', articleId: '123456',
    publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=123456', draftUrl: undefined }
  f.job.uploads = [upload]
  f.job.script!.title = '东契奇再现高效表现'
  await fs.unlink(f.job.delivery!.coverPath!)
  f.job.delivery!.portraitCoverPath = path.join(f.root, 'missing-new-portrait.png')
  assert.deepEqual(await prepareNbaUpload({ ...f.input, publicationMode: 'publish' }), upload)
})

test('a new publication submits once and reports the actual platform review status', async t => {
  const f = await fixture(t), upload = await prepareNbaUpload({ ...f.input, publicationMode: undefined }), u = uploader(upload)
  const submitted: SocialUploadResult = { ...u.receipt, saved: false, submitted: true, articleId: '123456', publicationStatus: 'submitted', draftUrl: undefined }
  u.runtime.inspectSocialUploadCheckpoint = async () => {
    u.calls.push('checkpoint')
    if (u.calls.includes('publish')) return { action: 'complete', phase: 'submitted', message: 'submitted', result: submitted }
    return u.calls.includes('upload') ? { action: 'save', phase: 'staged', message: 'staged', result: u.staged } : { action: 'upload', phase: 'new', message: 'new' }
  }
  u.runtime.runSocialUpload = async (payload, options) => {
    u.calls.push('upload'); assert.equal(payload.publicationMode, 'publish'); assert.equal(options.saveDraft, false); return u.staged
  }
  u.runtime.confirmSocialUpload = async payload => {
    u.calls.push('publish'); assert.equal(payload.publicationMode, 'publish'); assert.deepEqual(payload.tags, ['#NBA#']); return submitted
  }
  const result = await uploadNbaVideo(u.input, u.runtime)
  assert.equal(result.submitted, true); assert.equal(result.saved, false)
  assert.equal(u.current.result?.publicationStatus, 'submitted')
  assert.equal(u.calls.filter(call => call === 'upload').length, 1)
  assert.equal(u.calls.filter(call => call === 'publish').length, 1)
  assert.equal(u.calls.includes('save'), false)
})

test('a saved NBA draft keeps its upload identity and video when upgrading covers and publishing in place', async t => {
  const f = await fixture(t), draft = await prepareNbaUpload(f.input), old = uploader(draft)
  f.job.uploads = [{ ...draft, status: 'saved', dispatched: true, result: old.receipt }]
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#c24765' } }).png().toFile(path.join(f.root, 'new-cover.png'))
  f.job.delivery!.coverPath = path.join(f.root, 'new-cover.png')
  f.job.game = { id: 'thunder-cavaliers', localDate: '2026-11-02', tipoffUtc: '2026-11-03T00:00:00Z', localTimezone: 'America/New_York',
    home: { name: 'Cleveland Cavaliers', abbreviation: 'CLE', score: 112 }, away: { name: 'Oklahoma City Thunder', abbreviation: 'OKC', score: 117 },
    verified: true, evidenceUrls: [] }
  const publish = await prepareNbaUpload({ ...f.input, publicationMode: undefined })
  assert.equal(publish.id, draft.id)
  assert.notEqual(publish.fingerprint, draft.fingerprint)
  assert.equal(publish.payload!.videoPath, draft.payload!.videoPath)
  assert.notEqual(publish.payload!.landscapePath, draft.payload!.landscapePath)
  assert.deepEqual(publish.previousDraft?.payload, draft.payload)
  assert.equal(publish.payload!.description, '2026-11-02 NBA｜雷霆末节守住客场胜利，雷霆117-112骑士 #NBA#')
  const u = uploader(publish)
  u.runtime.publishSavedSocialUpload = async (payload, legacy, receipt) => {
    u.calls.push('publish-existing')
    assert.equal(u.current.dispatched, true, 'publication intent must be durable before platform writes')
    assert.deepEqual(legacy, draft.payload); assert.deepEqual(receipt, old.receipt)
    assert.equal(payload.jobId, legacy.jobId); assert.equal(payload.videoPath, legacy.videoPath)
    return { ...old.receipt, saved: false, submitted: true, publicationStatus: 'submitted', articleId: '123456', draftUrl: undefined }
  }
  assert.equal((await uploadNbaVideo(u.input, u.runtime)).submitted, true)
  assert.equal(u.calls.includes('upload'), false); assert.equal(u.calls.includes('save'), false)
  assert.equal(u.calls.filter(call => call === 'publish-existing').length, 1)
})

test('a saved label without a submission receipt never completes a publish task', async t => {
  const f = await fixture(t), upload = await prepareNbaUpload({ ...f.input, publicationMode: undefined }), u = uploader(upload)
  u.runtime.inspectSocialUploadCheckpoint = async () => ({ action: 'complete', phase: 'saved', message: 'legacy draft', result: u.receipt })
  const result = await uploadNbaVideo(u.input, u.runtime)
  assert.equal(result.submitted, false)
  assert.notEqual(u.current.status, 'saved')
})

test('in-place publication recovers a lost submission read-only after local covers disappear', async t => {
  const f = await fixture(t), draft = await prepareNbaUpload(f.input), old = uploader(draft)
  f.job.uploads = [{ ...draft, status: 'saved', dispatched: true, result: old.receipt }]
  const publish = await prepareNbaUpload({ ...f.input, publicationMode: undefined })
  await fs.unlink(publish.payload!.landscapePath!)
  for (const action of ['complete', 'reconcile'] as const) {
    const u = uploader({ ...publish, status: 'uncertain', dispatched: true })
    const receipt: SocialUploadResult = { ...old.receipt, saved: false, submitted: true, publicationStatus: 'submitted', articleId: '123456', draftUrl: undefined }
    u.setCheckpoint({ action, phase: action === 'complete' ? 'submitted' : 'publish_requested', message: 'existing submission',
      result: action === 'complete' ? receipt : u.staged })
    u.runtime.reconcileSocialUpload = async () => { u.calls.push('reconcile'); return receipt }
    u.runtime.publishSavedSocialUpload = async () => { throw Error('A prior submission must not be submitted again') }
    const result = await uploadNbaVideo(u.input, u.runtime)
    assert.equal(result.submitted, true, action)
    assert.equal(u.current.result?.articleId, '123456')
    assert.equal(u.calls.includes('upload'), false); assert.equal(u.calls.includes('save'), false)
    assert.equal(u.calls.includes('reconcile'), action === 'reconcile')
  }
})
