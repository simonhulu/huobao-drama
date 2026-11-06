import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { collectHistoryNote, HISTORY_NOTE_LIMITS, type HistoryNoteMedia } from './history-source-note.js'
import type { HistorySource } from './history-script-library.js'

const source = {
  platform: 'douyin', sourceVideoId: '7395681234567890123',
  sourceUrl: 'https://www.douyin.com/note/7395681234567890123',
  get title(): string { throw new Error('A title must never be used as the note body') },
} as HistorySource
const connection = { baseUrl: 'http://127.0.0.1:9125', apiKey: 'note-test-private-key' }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function fixture(t: { after: (fn: () => Promise<void>) => void }, count = 2) {
  const directory = await mkdtemp(path.join(tmpdir(), 'history-note-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const png = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#567812' } }).png().toBuffer()
  const jpeg = await sharp({ create: { width: 100, height: 90, channels: 3, background: '#345678' } }).jpeg().toBuffer()
  const images = Array.from({ length: count }, (_, index) => ({
    name: `image-${String(index + 1).padStart(2, '0')}.${index % 2 ? 'jpg' : 'png'}`,
    kind: 'image', state: 'done', bytes: (index % 2 ? jpeg : png).length,
    sha256: digest(index % 2 ? jpeg : png), content_type: index % 2 ? 'image/jpeg' : 'image/png',
  }))
  const mock = {
    record: { state: 'done', platform: 'douyin', content_id: source.sourceVideoId, on_disk: true, files: images } as Record<string, unknown>,
    archive: { platform: 'douyin', content_id: source.sourceVideoId, kind: 'image_album', description: '完整的原帖说明', media: { images: Array.from({ length: count }, () => ({ url: 'https://images.example.invalid/unused' })) } },
    transferred: [] as string[], submitted: [] as Array<{ url: string; skip_existing: boolean }>, deleted: [] as string[],
    requests: [] as string[], parseSubmitted: [] as Array<{ url: string; include_raw: boolean }>,
    archiveAvailable: true, archiveOnParseDone: true, parsePolls: 0,
    parseTask: { state: 'done', endpoint: 'parse' } as Record<string, unknown>,
    polls: 0, reused: false,
    beforeFile: undefined as ((name: string, init: RequestInit) => void | Promise<void>) | undefined,
    fileResponse: undefined as ((name: string, bytes: Buffer) => Response) | undefined,
    async fetch(input: string | URL | Request, init: RequestInit = {}) {
      const url = new URL(String(input))
      assert.equal(url.origin, connection.baseUrl)
      assert.equal((init.headers as Record<string, string>)['X-API-Key'], connection.apiKey)
      assert.equal(init.redirect, 'error')
      mock.requests.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`)
      if (init.method === 'DELETE') { mock.deleted.push(url.pathname); return Response.json({ success: true, data: {} }) }
      if (url.pathname === '/api/v1/parse' && init.method === 'POST') {
        assert.equal(url.searchParams.get('refresh'), 'true')
        assert.equal(url.searchParams.get('wait'), '0')
        mock.parseSubmitted.push(JSON.parse(init.body as string))
        return Response.json({ success: true, data: { task_id: `parse-${mock.parseSubmitted.length}`, state: 'queued' } }, { status: 202 })
      }
      if (url.pathname.startsWith('/api/v1/tasks/')) {
        mock.parsePolls++
        if (mock.parseTask.state === 'done' && mock.archiveOnParseDone) mock.archiveAvailable = true
        return Response.json({ success: true, data: mock.parseTask })
      }
      if (url.pathname === '/api/v1/downloads' && init.method === 'POST') {
        mock.submitted.push(JSON.parse(init.body as string))
        return Response.json({ success: true, data: { download_id: `download-${mock.submitted.length}`, task_id: 'task-1', state: 'queued', reused: mock.reused } })
      }
      if (url.pathname.startsWith('/api/v1/archive/')) return mock.archiveAvailable
        ? Response.json({ success: true, data: mock.archive })
        : Response.json({ success: false, error: { code: 'NOT_FOUND', message: 'this instance has not archived that post' } }, { status: 404 })
      if (url.pathname.includes('/files/')) {
        const name = decodeURIComponent(url.pathname.split('/files/')[1]!)
        await mock.beforeFile?.(name, init)
        mock.transferred.push(name)
        const index = Number(/image-(\d+)/.exec(name)![1]) - 1
        const bytes = index % 2 ? jpeg : png
        return mock.fileResponse?.(name, bytes) ?? new Response(new Uint8Array(bytes), { headers: { 'content-type': index % 2 ? 'image/jpeg' : 'image/png', 'content-length': String(bytes.length) } })
      }
      mock.polls++
      return Response.json({ success: true, data: mock.record })
    },
  }
  let media: HistoryNoteMedia = { kind: 'note', noteId: source.sourceVideoId, sourceUrl: source.sourceUrl, caption: '网页正文' }
  const checkpoint = (patch: Partial<HistoryNoteMedia>) => { media = { ...media, ...patch } }
  const ocrCalls: string[] = []
  const options = {
    connection, fetchFn: mock.fetch as typeof fetch, pollMs: 0, timeoutMs: 5000,
    readImageText: async (imagePath: string) => { ocrCalls.push(path.basename(imagePath)); return `图片正文 ${path.basename(imagePath)}` },
  }
  return { directory, png, jpeg, images, mock, checkpoint, get media() { return media }, ocrCalls, options }
}

test('downloads the complete album in numeric order, extracts caption plus OCR, and resumes entirely locally', async t => {
  const f = await fixture(t, 12)
  f.mock.record.state = 'partial'
  f.mock.record.files = [...f.images].reverse().concat([{ name: 'cover.jpg', kind: 'cover', state: 'failed', bytes: 0, sha256: '', content_type: 'image/jpeg' }])
  const result = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  assert.equal(result.media.sourceUrl, source.sourceUrl)
  assert.equal(result.media.noteId, source.sourceVideoId)
  assert.equal(result.media.textSha256, undefined, 'the parent assigns durable text provenance')
  assert.equal(result.media.imageCount, 12)
  assert.deepEqual(f.mock.submitted, [{ url: source.sourceUrl, skip_existing: true }])
  assert.equal(f.mock.requests[0], `GET /api/v1/archive/douyin/${source.sourceVideoId}`)
  assert.deepEqual(f.mock.parseSubmitted, [], 'already archived notes do not spend another parse request')
  assert.deepEqual(f.mock.transferred, f.images.map(image => image.name))
  assert.equal(result.text.split('\n\n').length, 13)
  assert.ok(result.text.startsWith('完整的原帖说明\n\n图片正文 note-000.png'))
  for (const image of result.media.images!) {
    assert.match(path.basename(image.path), /^note-\d{3}\.(png|jpg)$/)
    assert.equal(digest(await readFile(image.path)), image.sha256)
    assert.equal((await readFile(image.path)).length, image.bytes)
    assert.equal(image.ocrSha256, image.sha256)
  }
  const resumed = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, {
    readImageText: async () => { throw new Error('OCR must not repeat') },
    fetchFn: async () => { throw new Error('Downloader must not be contacted after complete local collection') },
  })
  assert.equal(resumed.text, result.text)
  assert.deepEqual(f.mock.deleted, [], 'the parent releases the remote cache after saving text')
})

test('partial albums never become complete; retry requests fresh media and preserves unrelated local files', async t => {
  const f = await fixture(t)
  const untouched = path.join(f.directory, 'finished-video.mp4')
  await writeFile(untouched, 'finished deliverable')
  f.mock.record.state = 'partial'
  f.mock.record.files = [f.images[0], { ...f.images[1], state: 'failed' }]
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options), /图片不完整.*2 张.*1 张未完成/)
  assert.equal(f.media.downloadState, 'failed')
  assert.deepEqual(f.ocrCalls, [])
  f.mock.record.state = 'done'
  f.mock.record.files = f.images
  const result = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  assert.equal(f.mock.submitted[1]?.skip_existing, false)
  assert.equal(result.media.images!.length, 2)
  assert.equal(await readFile(untouched, 'utf8'), 'finished deliverable')
})

test('a missing trailing slide, duplicate slide, or invalid order is rejected against the archived manifest', async t => {
  for (const scenario of ['missing', 'duplicate', 'gap']) {
    const f = await fixture(t, 3)
    f.mock.record.files = scenario === 'missing' ? f.images.slice(0, 2)
      : scenario === 'duplicate' ? [f.images[0], f.images[1], f.images[1]]
      : [f.images[0], f.images[1], { ...f.images[2], name: 'image-04.png' }]
    await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options), /图片不完整|序号缺失或重复/)
    assert.deepEqual(f.mock.transferred, [], scenario)
  }
})

test('a transfer interruption preserves earlier images and the download_id so retry only fetches missing slides', async t => {
  const f = await fixture(t)
  f.mock.beforeFile = name => { if (name.includes('02')) throw new Error(`temporary failure ${connection.apiKey} https://secret.invalid/signed?token=private`) }
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options), error => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /note-test-private-key|secret.invalid|token=private/)
    return true
  })
  assert.equal(f.media.downloadId, 'download-1')
  assert.equal(f.media.images!.length, 1)
  assert.equal(digest(await readFile(f.media.images![0]!.path)), f.media.images![0]!.sha256)
  f.mock.beforeFile = undefined
  await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  assert.equal(f.mock.submitted.length, 1)
  assert.deepEqual(f.mock.transferred, [f.images[0]!.name, f.images[1]!.name])
  assert.equal((await readdir(f.directory)).some(name => name.endsWith('.part')), false)
})

test('OCR failure is actionable and never falls back silently to the caption; retry reuses images and successful OCR', async t => {
  const f = await fixture(t)
  const calls: string[] = []
  let failing = true
  const readImageText = async (imagePath: string) => {
    const name = path.basename(imagePath)
    calls.push(name)
    if (failing && name.includes('001')) throw new Error('Vision request failed')
    return `提取 ${name}`
  }
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, readImageText }), /第 2 张图文字识别失败.*重试.*Vision request failed/)
  assert.equal(f.media.images!.length, 2)
  assert.equal(f.media.images![0]!.text, '提取 note-000.png')
  assert.equal(f.media.images![1]!.text, undefined)
  failing = false
  const result = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, readImageText })
  assert.ok(result.text.includes('提取 note-001.jpg'))
  assert.deepEqual(calls, ['note-000.png', 'note-001.jpg', 'note-001.jpg'])
  assert.equal(f.mock.submitted.length, 1)
  assert.equal(f.mock.transferred.length, 2)
})

test('expired cache clears its checkpoint and a retry bypasses skip_existing', async t => {
  const f = await fixture(t)
  f.mock.record.on_disk = false
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options), /缓存已过期.*重试/)
  assert.equal(f.media.downloadId, undefined)
  assert.equal(f.media.downloadState, 'expired')
  f.mock.record.on_disk = true
  await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  assert.deepEqual(f.mock.submitted.map(body => body.skip_existing), [true, false])
})

test('missing remote checkpoint or expired file transfer can be resubmitted without losing completed local images', async t => {
  for (const scenario of ['record', 'file']) {
    const f = await fixture(t)
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input)
      if (scenario === 'record' && /\/downloads\/download-1$/.test(url)
        || scenario === 'file' && url.includes('/files/image-02')) return Response.json({ success: false, error: 'not found' }, { status: 404 })
      return f.mock.fetch(input, init)
    }
    await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, fetchFn }), /HTTP 404/)
    assert.equal(f.media.downloadState, 'expired')
    assert.equal(f.media.downloadId, undefined)
    await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
    assert.equal(f.mock.submitted[1]!.skip_existing, false)
    if (scenario === 'file') assert.equal(f.mock.transferred.filter(name => name === 'image-01.png').length, 1)
  }
})

test('cancellation cancels only newly owned downloads, retains checkpoints, and leaves no partial file', async t => {
  for (const reused of [false, true]) {
    const f = await fixture(t)
    const controller = new AbortController()
    f.mock.reused = reused
    f.mock.beforeFile = () => { controller.abort() }
    await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, signal: controller.signal }), /已取消/)
    assert.equal(f.mock.deleted.length, reused ? 0 : 1)
    assert.equal(f.media.downloadId, 'download-1')
    assert.equal((await readdir(f.directory)).some(name => name.endsWith('.part')), false)
  }
})

test('a resumed shared job is never cancelled and poll timeout keeps the original download_id for retry', async t => {
  const f = await fixture(t)
  f.checkpoint({ downloadId: 'already-running', downloadState: 'running' })
  f.mock.record.state = 'running'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25)
  try {
    await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, signal: controller.signal, pollMs: 10 }), /已取消/)
  } finally { clearTimeout(timer) }
  assert.deepEqual(f.mock.deleted, [])
  assert.equal(f.media.downloadId, 'already-running')
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, timeoutMs: 25, pollMs: 10 }), /超时.*复用原 download_id/)
  assert.deepEqual(f.mock.submitted, [])
  f.mock.record.state = 'done'
  const result = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  assert.equal(result.media.images!.length, 2)
})

test('integrity mismatches, HTML responses, and over-limit manifests cannot produce a completed image', async t => {
  for (const scenario of ['sha', 'size', 'html', 'file-limit', 'count-limit', 'total-limit']) {
    const f = await fixture(t, scenario === 'count-limit' ? HISTORY_NOTE_LIMITS.images + 1 : scenario === 'total-limit' ? 9 : 2)
    if (scenario === 'sha') f.images[0]!.sha256 = '0'.repeat(64)
    if (scenario === 'size') f.mock.fileResponse = (_name, bytes) => new Response(new Uint8Array(bytes.subarray(1)))
    if (scenario === 'html') f.mock.fileResponse = () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })
    if (scenario === 'file-limit') f.images[0]!.bytes = HISTORY_NOTE_LIMITS.imageBytes + 1
    if (scenario === 'total-limit') f.images.forEach(image => { image.bytes = HISTORY_NOTE_LIMITS.imageBytes })
    await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options), /校验失败|非图片|清单无效|安全上限/)
    assert.equal((await readdir(f.directory)).some(name => name.startsWith('note-')), false, scenario)
    assert.deepEqual(f.ocrCalls, [], scenario)
  }
})

test('unknown-length transfer is bounded by expected bytes and invalid images cannot masquerade as PNG', async t => {
  for (const scenario of ['overrun', 'invalid-image']) {
    const f = await fixture(t)
    const bytes = scenario === 'overrun' ? Buffer.alloc(f.png.length + 1) : Buffer.alloc(f.png.length, 65)
    if (scenario === 'invalid-image') f.images[0]!.sha256 = digest(bytes)
    f.mock.fileResponse = () => new Response(new Uint8Array(bytes))
    await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options), /大小上限|不是支持的图片/)
    assert.deepEqual(await readdir(f.directory), [])
  }
})

test('retries repair tampered files and do not follow checkpoint paths or symlinks outside the note directory', async t => {
  const f = await fixture(t)
  await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  const images = f.media.images!
  const outside = `${f.directory}-outside.png`
  t.after(() => rm(outside, { force: true }))
  await writeFile(outside, f.png)
  await writeFile(images[0]!.path, 'corrupted')
  await rm(images[1]!.path)
  await symlink(outside, images[1]!.path)
  f.checkpoint({ images: [{ ...images[0]!, path: outside }, images[1]!] })
  const result = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  assert.deepEqual(await readFile(outside), f.png)
  assert.equal(result.media.images![0]!.path, path.join(f.directory, 'note-000.png'))
  assert.equal(f.mock.transferred.length, 4)
  assert.equal(f.ocrCalls.length, 4, 'replaced images need fresh OCR')
})

test('GIF images become displayable JPEGs while retaining source integrity metadata', async t => {
  const f = await fixture(t, 1)
  const gif = await sharp(f.png).gif().toBuffer()
  f.images[0] = { ...f.images[0]!, name: 'image-01.gif', bytes: gif.length, sha256: digest(gif), content_type: 'image/gif' }
  f.mock.record.files = f.images
  f.mock.fileResponse = () => new Response(new Uint8Array(gif), { headers: { 'content-type': 'image/gif' } })
  const result = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  const image = result.media.images![0]!
  assert.equal(path.basename(image.path), 'note-000.jpg')
  assert.equal(image.mimeType, 'image/jpeg')
  assert.equal(image.sourceSha256, digest(gif))
  assert.equal(image.sourceBytes, gif.length)
  assert.equal((await sharp(image.path).metadata()).format, 'jpeg')
  assert.equal(digest(await readFile(image.path)), image.sha256)
})

test('empty OCR is valid for a photo with caption, but an entirely empty note never fabricates text from its title', async t => {
  const f = await fixture(t)
  const readImageText = async () => ''
  const result = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, readImageText })
  assert.equal(result.text, '完整的原帖说明')
  f.checkpoint({ caption: '' })
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, readImageText }), /没有可用正文.*检查原图或补充原文/)
})

test('mismatched note identity and nonlocal downloader connection are refused before any HTTP request', async t => {
  const f = await fixture(t)
  const fetchFn: typeof fetch = async () => { throw new Error('HTTP must not run') }
  const videoSource = { platform: source.platform, sourceVideoId: source.sourceVideoId, sourceUrl: 'https://www.douyin.com/video/7395681234567890123' } as HistorySource
  await assert.rejects(collectHistoryNote(videoSource, f.directory, f.media, f.checkpoint, { ...f.options, fetchFn }), /来源与原帖地址不匹配/)
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, fetchFn, connection: { ...connection, baseUrl: 'https://remote.invalid' } }), /本地专用连接/)
})

test('unarchived notes are parsed asynchronously and archived before any download is submitted', async t => {
  const f = await fixture(t)
  f.mock.archiveAvailable = false
  const result = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  assert.deepEqual(f.mock.parseSubmitted, [{ url: source.sourceUrl, include_raw: false }])
  assert.equal(result.media.parseTaskId, 'parse-1')
  assert.equal(result.media.parseState, 'done')
  assert.equal(result.media.parseError, undefined)
  const archiveRoute = `GET /api/v1/archive/douyin/${source.sourceVideoId}`
  assert.deepEqual(f.mock.requests.slice(0, 5), [
    archiveRoute, 'POST /api/v1/parse?refresh=true&wait=0', 'GET /api/v1/tasks/parse-1', archiveRoute, 'POST /api/v1/downloads',
  ])
  assert.equal(result.media.images!.length, 2)
})

test('a failed async parse exposes the transport cause, saves a redacted checkpoint and never starts a download', async t => {
  const f = await fixture(t)
  f.mock.archiveAvailable = false
  f.mock.parseTask = { state: 'failed', error: {
    code: 'INTERNAL', retryable: true,
    details: { endpoint: 'douyin.content_detail', last_error: 'transport_failure' },
    message: `upstream connection failed ${connection.apiKey} https://private.invalid/?token=secret`,
  } }
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /解析.*transport_failure/)
    assert.match(error.message, /网络.*代理.*重试/)
    assert.doesNotMatch(error.message, /note-test-private-key|private.invalid|token=secret/)
    return true
  })
  assert.equal(f.media.parseTaskId, 'parse-1')
  assert.equal(f.media.parseState, 'failed')
  assert.match(f.media.parseError!, /transport_failure/)
  assert.deepEqual(f.mock.submitted, [])
  assert.deepEqual(f.mock.transferred, [])
  f.mock.parseTask = { state: 'done' }
  const result = await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  assert.equal(result.media.parseTaskId, 'parse-2', 'an explicit retry replaces a terminal failed parse')
  assert.equal(result.media.parseError, undefined)
  assert.equal(f.mock.submitted.length, 1)
})

test('parse timeout and cancellation retain the original task and resume polling instead of submitting duplicate parses', async t => {
  for (const stop of ['timeout', 'cancel']) {
    const f = await fixture(t)
    f.mock.archiveAvailable = false
    f.mock.parseTask = { state: 'running' }
    const controller = new AbortController()
    const timer = stop === 'cancel' ? setTimeout(() => controller.abort(), 40) : undefined
    try {
      await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, {
        ...f.options, pollMs: 10, timeoutMs: stop === 'timeout' ? 40 : 5000, signal: controller.signal,
      }), stop === 'timeout' ? /解析.*超时.*parse-1.*重试/ : /解析.*已取消.*parse-1.*重试/)
    } finally { if (timer) clearTimeout(timer) }
    assert.equal(f.media.parseTaskId, 'parse-1')
    assert.equal(f.media.parseState, 'running')
    assert.ok(f.media.parseError)
    assert.deepEqual(f.mock.submitted, [])
    assert.deepEqual(f.mock.deleted, [])
    f.mock.parseTask = { state: 'done' }
    await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
    assert.equal(f.mock.parseSubmitted.length, 1)
    assert.equal(f.media.parseError, undefined)
    assert.equal(f.mock.submitted.length, 1)
  }
})

test('expired parse tasks are marked retryable and the next call submits a fresh parse', async t => {
  const f = await fixture(t)
  f.mock.archiveAvailable = false
  f.checkpoint({ parseTaskId: 'expired-parse', parseState: 'running' })
  const fetchFn: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/tasks/expired-parse')) return Response.json({ success: false, error: { code: 'TASK_NOT_FOUND' } }, { status: 404 })
    return f.mock.fetch(input, init)
  }
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, fetchFn }), /解析任务.*过期.*重试/)
  assert.equal(f.media.parseState, 'expired')
  assert.equal(f.media.parseTaskId, 'expired-parse')
  assert.deepEqual(f.mock.submitted, [])
  await collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options)
  assert.equal(f.media.parseTaskId, 'parse-1')
  assert.equal(f.mock.submitted.length, 1)
})

test('parse success without a persisted archive fails clearly instead of repeating the original download error', async t => {
  const f = await fixture(t)
  f.mock.archiveAvailable = false
  f.mock.archiveOnParseDone = false
  await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, f.options), /解析.*完成.*归档.*archive.enabled.*重试/)
  assert.equal(f.media.parseState, 'done')
  assert.match(f.media.parseError!, /archive.enabled/)
  assert.deepEqual(f.mock.submitted, [])
})

test('archive errors other than 404 and parse submission failures never create download jobs', async t => {
  for (const step of ['archive', 'parse']) {
    const f = await fixture(t)
    f.mock.archiveAvailable = false
    const fetchFn: typeof fetch = async (input, init) => {
      const pathname = new URL(String(input)).pathname
      if (step === 'archive' && pathname.startsWith('/api/v1/archive/')
        || step === 'parse' && pathname === '/api/v1/parse') {
        return Response.json({ success: false, error: { code: 'INTERNAL', details: { last_error: 'transport_failure' } } }, { status: 500 })
      }
      return f.mock.fetch(input, init)
    }
    await assert.rejects(collectHistoryNote(source, f.directory, f.media, f.checkpoint, { ...f.options, fetchFn }), step === 'archive' ? /HTTP 500/ : /解析.*transport_failure/)
    assert.deepEqual(f.mock.submitted, [])
    assert.deepEqual(f.mock.parseSubmitted, [])
    if (step === 'parse') assert.match(f.media.parseError!, /transport_failure/)
  }
})
