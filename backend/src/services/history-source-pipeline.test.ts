import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { access, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import type { HistoryPipelineDependencies } from './history-source-pipeline.js'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-history-pipeline-db-'))
process.env.DB_PATH = join(dbDir, 'test.db')
const { db, schema } = await import('../db/index.js')
const { storeHistorySource, storeHistoryArticleSource, getHistorySource, getHistorySourceArtifactState, requireCurrentHistoryScript, updateHistorySource, deleteHistorySource } = await import('./history-script-library.js')
const { processHistorySource, downloadHistoryVideo, releaseHistoryDownloaderMedia, cleanupHistorySourceMedia, unlockHistorySource, isHistorySourceRateLimitError } = await import('./history-source-pipeline.js')
const { planHistoryAudioChunks } = await import('./history-script-processing.js')
const { storeHistoryYoutubeSource } = await import('./history-source-youtube.js')
const { prepareHistoryYoutubeRecollection } = await import('./history-youtube-recollection.js')
const { recordHistoryVideoDelivery } = await import('./history-video-deliveries.js')

beforeEach(() => { db.delete(schema.historyScriptSources).run() })

function source() {
  return storeHistorySource({
    sourceVideoId: '7395681234567890123', title: 'A historical landmark', category: 'regional_history',
    selection: { reason: 'Viewers request evidence about the landmark', observedAt: '2026-10-14T08:00:00Z', comments: [{ text: 'Where was this recorded?' }] },
  })
}

function fixture(duration = 12) {
  const storageRoot = mkdtempSync(join(tmpdir(), 'huobao-history-pipeline-media-'))
  const counts = { download: 0, probe: 0, extract: 0, asr: 0, correct: 0, recreate: 0, rewrite: 0 }
  // Tripwire for the removed stage: old pipeline code would still call this dependency.
  const dependencies: HistoryPipelineDependencies & { rewriteScript: (text: string) => Promise<string> } = {
    downloadVideo: async (_source, target, _media, checkpoint) => {
      counts.download++
      checkpoint({ downloadId: 'download-1', taskId: 'task-1', downloadState: 'done' })
      await writeFile(target, Buffer.alloc(128, 1))
      return { downloadId: 'download-1', videoPath: target }
    },
    probeVideo: async () => { counts.probe++; return { duration, audioStreamIndex: 1 } },
    planChunks: planHistoryAudioChunks,
    extractAudio: async (_video, chunk, target) => { counts.extract++; await writeFile(target, Buffer.alloc(128, chunk.start ? 2 : 1)) },
    transcribeAudio: async (_file, seconds) => {
      counts.asr++
      return { text: `Narration chunk ${counts.asr}`, duration: seconds, segments: [{ start: 1, end: 2, text: 'Narration' }] }
    },
    correctTranscript: async text => { counts.correct++; return { correctedTranscript: `${text} corrected`, corrections: [], factualConcerns: [{ claim: 'The landmark is ancient', reason: 'A primary source is required', searchQuery: 'landmark local gazetteer' }], factCheckStatus: 'needs_sources' } },
    recreateScript: async (text, review) => {
      counts.recreate++
      assert.equal(review.correctedTranscript, text)
      return { script: `${text} recreated`, title: 'Historical question', coverText: 'Why this landmark?', skillName: 'water-koubo', skillRevision: 'test-revision', skillSha256: 'a'.repeat(64), provider: 'configured-provider', model: 'configured-model' }
    },
    rewriteScript: async text => { counts.rewrite++; return `${text} rewritten` },
  }
  return { storageRoot, counts, dependencies }
}

function youtubeSource() {
  return storeHistoryYoutubeSource({videoId: 'VprFAzjTTuM', sourceUrl: 'https://www.youtube.com/watch?v=VprFAzjTTuM',
    title: '频道原视频', authorName: '指定频道', observedAt: new Date().toISOString(), collectionUrl: 'https://www.youtube.com/@history/videos'})
}

test('expired YouTube production starts a new draft while reusing ASR and preserving the prior draft and delivery', async () => {
  const record = youtubeSource(), f = fixture()
  const original = await processHistorySource(record.id, f)
  const video = recordHistoryVideoDelivery(db.$client, {scriptId: record.id, scriptSha256: createHash('sha256').update(original.rewrittenScript!).digest('hex'),
    producer: 'motion', producerJobId: 'completed-old-job', videoUrl: '/static/released.mp4', videoName: 'released.mp4', duration: 12, sha256: 'a'.repeat(64)})
  db.$client.prepare('UPDATE history_video_deliveries SET created_at=? WHERE id=?').run(new Date(Date.now() - 16 * 86400000).toISOString(), video.id)
  assert.equal(prepareHistoryYoutubeRecollection(db.$client, record.id, 40334).renewed, true)
  const before = {...f.counts}, recreate = f.dependencies.recreateScript
  f.dependencies.recreateScript = async (...args) => ({...await recreate(...args), script: 'A newly written version for this production cycle'})
  let queued = 0
  f.dependencies.enqueueHuasheng = async () => {queued++}
  f.dependencies.huashengEnabled = async () => true
  const next = await processHistorySource(record.id, f)
  assert.equal(next.rewrittenScript, 'A newly written version for this production cycle')
  assert.equal(f.counts.download, before.download)
  assert.equal(f.counts.asr, before.asr)
  assert.equal(f.counts.correct, before.correct)
  assert.equal(queued, 1)
  const cycle = db.$client.prepare('SELECT source_snapshot_json FROM history_youtube_collection_cycles WHERE source_id=?').get(record.id) as {source_snapshot_json: string}
  assert.equal(JSON.parse(cycle.source_snapshot_json).rewritten_script, original.rewrittenScript)
  assert.equal((db.$client.prepare('SELECT id FROM history_video_deliveries WHERE id=?').get(video.id) as {id: number}).id, video.id)
})

for (const repeat of ['previous-draft-after-correction', 'earlier-produced-draft']) {
  test(`a renewed YouTube cycle refuses ${repeat} before any new production submission`, async () => {
    const record = youtubeSource(), f = fixture()
    const original = await processHistorySource(record.id, f)
    const returnedScript = repeat === 'earlier-produced-draft' ? 'An even earlier completed script' : original.rewrittenScript!
    recordHistoryVideoDelivery(db.$client, {scriptId: record.id, scriptSha256: createHash('sha256').update(returnedScript).digest('hex'),
      producer: 'motion', producerJobId: 'completed-earlier-job', videoUrl: '/static/earlier-released.mp4', videoName: 'earlier.mp4', duration: 12, sha256: 'b'.repeat(64)})
    updateHistorySource(record.id, {rewrittenScript: null, correctedTranscript: repeat === 'previous-draft-after-correction' ? null : original.correctedTranscript,
      reviewJson: JSON.stringify({...JSON.parse(original.reviewJson!), youtubeRecollection: {taskId: 40334,
        previousScriptSha256: createHash('sha256').update(original.rewrittenScript!).digest('hex'), startedAt: new Date().toISOString()}})})
    const recreate = f.dependencies.recreateScript
    f.dependencies.recreateScript = async (...args) => ({...await recreate(...args), script: returnedScript})
    let queued = 0
    f.dependencies.enqueueHuasheng = async () => {queued++}
    f.dependencies.huashengEnabled = async () => true
    await assert.rejects(processHistorySource(record.id, f), /未重复提交旧版制作/)
    assert.equal(queued, 0)
    assert.equal(getHistorySource(record.id)!.rewrittenScript, null)
    assert.equal(JSON.parse(getHistorySource(record.id)!.reviewJson!).youtubeRecollection.taskId, 40334)
    assert.equal(f.counts.asr, 1)
  })
}

test('collection recreates a current draft with skill provenance without calling LM Studio', async () => {
  const record = source()
  const f = fixture()
  const recreate = f.dependencies.recreateScript
  f.dependencies.recreateScript = (text, review, signal, sourceTitle) => {
    assert.equal(sourceTitle, record.title)
    return recreate(text, review, signal, sourceTitle)
  }
  f.dependencies.rewriteScript = async () => { throw new Error('LM Studio must not be called') }
  const stages: string[] = []
  const completed = await processHistorySource(record.id, { ...f, onProgress: event => stages.push(event.stage) })
  assert.equal(completed.status, 'needs_review')
  assert.equal(completed.rewrittenScript, `${completed.correctedTranscript} recreated`)
  assert.equal(JSON.parse(completed.reviewJson!).draftOrigin, 'water_koubo')
  assert.equal(JSON.parse(completed.reviewJson!).factCheckStatus, 'needs_sources')
  assert.deepEqual(JSON.parse(completed.reviewJson!).recreation, {
    title: 'Historical question', coverText: 'Why this landmark?', skillName: 'water-koubo', skillRevision: 'test-revision', skillSha256: 'a'.repeat(64), provider: 'configured-provider', model: 'configured-model',
  })
  assert.equal(requireCurrentHistoryScript(completed), completed.rewrittenScript)
  assert.equal(stages.includes('rewriting'), true)
})

test('source paraphrasing saves the remote draft without selecting an angle or creating a writing plan', async () => {
  const record = source(), f = fixture()
  const recreate = f.dependencies.recreateScript
  f.dependencies.recreateScript = async (...args) => ({ ...await recreate(...args),
    skillName: 'history-source-paraphrase', skillRevision: 'history-source-paraphrase-v1', provider: 'remote-writer', model: 'remote-writing-model' })
  const messages: string[] = []
  const completed = await processHistorySource(record.id, { ...f, onProgress: event => messages.push(event.message) })
  const review = JSON.parse(completed.reviewJson!)
  assert.equal(review.draftOrigin, 'source_paraphrase')
  assert.equal(review.recreation.provider, 'remote-writer')
  assert.equal(review.recreation.model, 'remote-writing-model')
  assert.equal(review.recreationPlan, undefined)
  assert.equal(review.recreation.angles, undefined)
  assert.equal(review.factCheckStatus, 'needs_sources')
  assert.ok(messages.some(message => message.includes('保持原意，调整全文表达与句间衔接')))
  assert.equal(requireCurrentHistoryScript(completed), completed.rewrittenScript)
})

test('runs all stages, saves global segment timestamps, and resumes without paid model calls', async () => {
  const record = source()
  const f = fixture(600)
  const completed = await processHistorySource(record.id, f)
  assert.equal(completed.status, 'needs_review')
  assert.equal(completed.rewrittenScript, `${completed.correctedTranscript} recreated`)
  const cache = JSON.parse(completed.asrJson!)
  assert.equal(cache.complete, true)
  assert.equal(cache.chunks.length, 2)
  assert.deepEqual(cache.segments.map((segment: { start: number }) => segment.start), [1, 481])
  assert.equal(JSON.parse(completed.reviewJson!).factCheckStatus, 'needs_sources')
  assert.equal(JSON.parse(completed.reviewJson!).scriptTiming.targetSeconds, 900)
  const media = JSON.parse(completed.mediaJson)
  assert.equal(media.downloadId, 'download-1')
  assert.equal(media.taskId, 'task-1')
  assert.equal(media.chunks.length, 2)
  assert.equal(media.videoPath, undefined)
  assert.ok(media.cleanup.localReleasedAt)
  await assert.rejects(access(join(f.storageRoot, String(record.id), 'source.mp4')))
  await assert.rejects(access(join(f.storageRoot, String(record.id), 'audio-000.wav')))
  assert.deepEqual(f.counts, { download: 1, probe: 1, extract: 2, asr: 2, correct: 1, recreate: 1, rewrite: 0 })
  await processHistorySource(record.id, f)
  assert.deepEqual(f.counts, { download: 1, probe: 1, extract: 2, asr: 2, correct: 1, recreate: 1, rewrite: 0 })
  await assert.rejects(access(join(f.storageRoot, String(record.id), 'process.lock')))
})

test('completed ASR releases only source media before correction and never redownloads on retry', async () => {
  const record = source()
  const f = fixture(600)
  const directory = join(f.storageRoot, String(record.id))
  await mkdir(directory)
  await writeFile(join(directory, 'finished-video.mp4'), 'keep finished video')
  await writeFile(join(directory, 'article-cover.jpg'), 'keep article cover')
  let released = 0
  f.dependencies.releaseDownload = async stored => {
    assert.equal(getHistorySourceArtifactState(stored).transcript, 'current')
    assert.equal(stored.sourceUrl, record.sourceUrl)
    released++
    return { freedBytes: 512 }
  }
  const correct = f.dependencies.correctTranscript
  f.dependencies.correctTranscript = async (...args) => {
    assert.equal(getHistorySourceArtifactState(getHistorySource(record.id)!).transcript, 'current')
    await assert.rejects(access(join(directory, 'source.mp4')))
    await assert.rejects(access(join(directory, 'audio-000.wav')))
    await assert.rejects(access(join(directory, 'audio-001.wav')))
    return correct(...args)
  }
  const completed = await processHistorySource(record.id, f)
  assert.equal(completed.sourceUrl, record.sourceUrl)
  assert.equal(requireCurrentHistoryScript(completed), completed.rewrittenScript)
  assert.equal(JSON.parse(completed.mediaJson).cleanup.releasedBytes, 384)
  assert.equal(JSON.parse(completed.mediaJson).cleanup.downloaderFreedBytes, 512)
  assert.equal(await readFile(join(directory, 'finished-video.mp4'), 'utf8'), 'keep finished video')
  assert.equal(await readFile(join(directory, 'article-cover.jpg'), 'utf8'), 'keep article cover')
  const calls = { ...f.counts }
  await processHistorySource(record.id, f)
  assert.deepEqual(f.counts, calls)
  assert.equal(released, 1)
  const manifest = JSON.parse(await readFile(join(directory, 'storage-release.json'), 'utf8'))
  assert.equal(manifest.ownerType, 'history-source')
  assert.equal(manifest.ownerId, String(record.id))
  assert.equal(manifest.transcriptSha256, createHash('sha256').update(completed.rawTranscript!).digest('hex'))
  assert.equal(manifest.status, 'completed')
  assert.equal(manifest.files.length, 3)
  assert.equal(manifest.files.every((file: { status: string }) => file.status === 'released'), true)
})

test('a downloader cleanup outage preserves the draft and retries cleanup without repeating paid stages', async () => {
  const record = source()
  const f = fixture()
  f.dependencies.releaseDownload = async () => { throw new Error('Downloader unavailable') }
  const completed = await processHistorySource(record.id, f)
  assert.equal(completed.status, 'needs_review')
  assert.equal(completed.lastError, null)
  assert.match(JSON.parse(completed.mediaJson).cleanup.error, /Downloader unavailable/)
  await assert.rejects(access(join(f.storageRoot, String(record.id), 'source.mp4')))
  const calls = { ...f.counts }
  f.dependencies.releaseDownload = async () => ({ freedBytes: 512 })
  const retried = await processHistorySource(record.id, f)
  assert.deepEqual(f.counts, calls)
  assert.equal(JSON.parse(retried.mediaJson).cleanup.error, undefined)
  assert.ok(JSON.parse(retried.mediaJson).cleanup.downloaderReleasedAt)
})

test('a manually preserved source survives complete transcription and later pipeline retries', async () => {
  const record = source(), f = fixture()
  await processHistorySource(record.id, { ...f, through: 'download' })
  const directory = join(f.storageRoot, String(record.id))
  await writeFile(join(directory, 'storage-preserve.json'), JSON.stringify({ version: 1, files: ['source.mp4'] }))
  const completed = await processHistorySource(record.id, f)
  assert.equal(getHistorySourceArtifactState(completed).transcript, 'current')
  assert.match(JSON.parse(completed.mediaJson).cleanup.error, /SOURCE_MEDIA_PINNED/)
  await access(join(directory, 'source.mp4'))
  await access(join(directory, 'audio-000.wav'))
  const calls = { ...f.counts }
  await processHistorySource(record.id, f)
  await access(join(directory, 'source.mp4'))
  assert.deepEqual(f.counts, calls)
  const manifest = JSON.parse(await readFile(join(directory, 'storage-release.json'), 'utf8'))
  assert.equal(manifest.status, 'retained')
  assert.equal(manifest.ownerId, String(record.id))
})

test('YouTube releases source audio and staging leftovers only after complete ASR without calling the Douyin archive', async () => {
  const { storeHistoryYoutubeSource } = await import('./history-source-youtube.js')
  const record = storeHistoryYoutubeSource({ videoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    title: 'YouTube narration', authorName: null, observedAt: new Date().toISOString(), collectionUrl: 'https://www.youtube.com/@history/videos' })
  const f = fixture(600)
  f.dependencies.releaseDownload = async () => assert.fail('YouTube must not call the Douyin archive')
  await processHistorySource(record.id, { ...f, through: 'download' })
  const directory = join(f.storageRoot, String(record.id))
  const leftover = join(directory, 'source.youtube.abcdefghijk.webm.part')
  await writeFile(leftover, 'staging bytes')
  await writeFile(join(directory, 'finished-video.mp4'), 'keep finished video')
  await cleanupHistorySourceMedia(record.id, { storageRoot: f.storageRoot, releaseDownload: f.dependencies.releaseDownload })
  await access(join(directory, 'source.mp4'))
  await access(leftover)
  const complete = await processHistorySource(record.id, { ...f, through: 'asr' })
  assert.equal(getHistorySourceArtifactState(complete).transcript, 'current')
  await assert.rejects(access(join(directory, 'source.mp4')))
  await assert.rejects(access(leftover))
  await assert.rejects(access(join(directory, 'audio-000.wav')))
  assert.equal(await readFile(join(directory, 'finished-video.mp4'), 'utf8'), 'keep finished video')
  assert.ok(JSON.parse(complete.mediaJson).cleanup.localReleasedAt)
  const calls = { ...f.counts }
  await processHistorySource(record.id, { ...f, through: 'asr' })
  assert.deepEqual(f.counts, calls)
})

test('image notes download once, bypass video and ASR, preserve images and recreate with source author', async () => {
  const record = storeHistorySource({ sourceVideoId: '7395681234567890123', sourceType: 'note', sourceText: 'Original caption',
    title: 'History note', authorName: 'Source author', category: 'unclassified', metrics: { likes: 10000, comments: 20 },
    selection: { reason: 'Observed engagement', observedAt: '2026-10-24T08:00:00Z', comments: [] } })
  const f = fixture()
  let noteCalls = 0, releases = 0
  const imagePath = join(f.storageRoot, String(record.id), 'note-000.png')
  f.dependencies.collectNote = async (stored, _directory, media, checkpoint) => {
    noteCalls++
    assert.equal(stored.sourceUrl, record.sourceUrl)
    await writeFile(imagePath, 'source image')
    const images = [{ path: imagePath, sha256: createHash('sha256').update('source image').digest('hex'), bytes: 12 }]
    checkpoint({ images, downloadId: 'note-download' })
    return { media: { ...media, images, downloadId: 'note-download' }, text: 'Original caption\n\nText extracted from image.' }
  }
  f.dependencies.releaseDownload = async () => { releases++; return { freedBytes: 12 } }
  const recreate = f.dependencies.recreateScript
  f.dependencies.recreateScript = async (text, review, signal, title, author) => {
    assert.equal(author, 'Source author')
    return { ...await recreate(text, review, signal, title), skillName: 'history-light-edit', model: 'gpt-6-luna' }
  }
  const completed = await processHistorySource(record.id, f)
  assert.deepEqual(getHistorySourceArtifactState(completed), { transcript: 'current', corrected: 'current', rewritten: 'current' })
  assert.equal(completed.asrJson, null)
  assert.equal(JSON.parse(completed.reviewJson!).draftOrigin, 'light_edit')
  assert.equal(JSON.parse(completed.mediaJson).cleanup.localReleasedAt, undefined)
  assert.equal(await readFile(imagePath, 'utf8'), 'source image')
  assert.equal(f.counts.download + f.counts.probe + f.counts.extract + f.counts.asr, 0)
  await processHistorySource(record.id, f)
  assert.equal(noteCalls, 1)
  assert.equal(releases, 1)
  assert.equal(f.counts.recreate, 1)
})

test('maintenance cleanup refuses an active source lock and leaves incomplete ASR files intact', async () => {
  const record = source()
  const f = fixture()
  await processHistorySource(record.id, { ...f, through: 'download' })
  const directory = join(f.storageRoot, String(record.id))
  await writeFile(join(directory, 'process.lock'), '{}')
  await assert.rejects(cleanupHistorySourceMedia(record.id, { storageRoot: f.storageRoot, releaseDownload: async () => ({ freedBytes: 0 }) }), /locked/)
  await access(join(directory, 'source.mp4'))
  await unlink(join(directory, 'process.lock'))
  const unchanged = await cleanupHistorySourceMedia(record.id, {
    storageRoot: f.storageRoot,
    releaseDownload: async () => { throw new Error('Incomplete ASR must not release downloader media') },
  })
  assert.equal(JSON.parse(unchanged.mediaJson).cleanup, undefined)
  await access(join(directory, 'source.mp4'))
})

test('cleanup ignores metadata paths and unlinks source symlinks without deleting their targets', async () => {
  const record = source()
  const f = fixture()
  const completed = await processHistorySource(record.id, f)
  const directory = join(f.storageRoot, String(record.id))
  const outside = join(f.storageRoot, 'finished-video.mp4')
  await writeFile(outside, 'keep finished video')
  const media = JSON.parse(completed.mediaJson)
  media.videoPath = outside
  media.chunks[0].path = outside
  delete media.cleanup
  updateHistorySource(record.id, { mediaJson: JSON.stringify(media) })
  await symlink(outside, join(directory, 'source.mp4'))
  await symlink(outside, join(directory, 'audio-000.wav'))
  const cleaned = await cleanupHistorySourceMedia(record.id, { storageRoot: f.storageRoot, releaseDownload: async () => ({ freedBytes: 0 }) })
  assert.equal(await readFile(outside, 'utf8'), 'keep finished video')
  await assert.rejects(access(join(directory, 'source.mp4')))
  await assert.rejects(access(join(directory, 'audio-000.wav')))
  assert.equal(JSON.parse(cleaned.mediaJson).cleanup.releasedBytes, 0)
  assert.equal(getHistorySourceArtifactState(cleaned).rewritten, 'current')
})

test('cleanup refuses a source directory redirected to another directory', async () => {
  const record = source()
  const f = fixture()
  const completed = await processHistorySource(record.id, f)
  const directory = join(f.storageRoot, String(record.id))
  const outside = mkdtempSync(join(tmpdir(), 'huobao-history-keep-media-'))
  await writeFile(join(outside, 'source.mp4'), 'keep outside video')
  await rename(directory, `${directory}-original`)
  await symlink(outside, directory)
  const media = JSON.parse(completed.mediaJson)
  delete media.cleanup
  updateHistorySource(record.id, { mediaJson: JSON.stringify(media) })
  const cleaned = await cleanupHistorySourceMedia(record.id, { storageRoot: f.storageRoot, releaseDownload: async () => ({ freedBytes: 0 }) })
  assert.match(JSON.parse(cleaned.mediaJson).cleanup.error, /本地临时素材清理失败/)
  assert.equal(JSON.parse(cleaned.mediaJson).cleanup.localReleasedAt, undefined)
  assert.equal(await readFile(join(outside, 'source.mp4'), 'utf8'), 'keep outside video')
})

test('downloader media release uses the documented content deletion API, not download cancellation', async () => {
  const record = source()
  const f = fixture()
  const completed = await processHistorySource(record.id, f)
  let calls = 0
  const result = await releaseHistoryDownloaderMedia(completed, {
    connection: { baseUrl: 'http://127.0.0.1:9125', apiKey: 'private-test-key' },
    fetchFn: async (input, init) => {
      calls++
      assert.equal(String(input), 'http://127.0.0.1:9125/api/v1/archive/delete')
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), { items: [{ platform: 'douyin', content_id: record.sourceVideoId }], media: true })
      return Response.json({ success: true, data: { deleted: 1, downloads_removed: 1, freed_bytes: 1234 } })
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.freedBytes, 1234)
})

for (const platform of ['douyin', 'baijiahao'] as const) {
for (const variant of ['short', 'long', 'identical'] as const) {
  test(`${platform} ${variant} body is saved unchanged without length QA or title requirements and admitted to Huasheng`, async () => {
    const record = platform === 'douyin' ? source() : storeHistoryArticleSource({
      articleId: '123456789012345', sourceUrl: 'https://baijiahao.baidu.com/s?id=123456789012345',
      title: '历史文章', authorName: '作者', text: '文章原文包含完整历史事件。', fetchedAt: new Date().toISOString(),
      metadata: { gid: '12345', platform: '百家号', category: '历史', publishTime: '', keywords: [] },
    })
    const f = fixture()
    const reference = '原稿中的历史事件经过。'.repeat(20)
    const body = variant === 'short' ? '  短稿内容。\n' : variant === 'long' ? '二创正文。'.repeat(200) : reference
    const correct = f.dependencies.correctTranscript
    f.dependencies.correctTranscript = async text => ({ ...await correct(text), correctedTranscript: reference })
    const recreate = f.dependencies.recreateScript
    f.dependencies.recreateScript = async (text, review) => ({
      ...await recreate(text, review), script: body, title: '', coverText: '',
      // A stale adapter may still return old diagnostics; new draft metadata must not retain them.
      lengthCheck: { referenceLength: reference.length, scriptLength: body.length, ratio: body.length / reference.length, status: 'too_short' },
    })
    const expectedHash = createHash('sha256').update(body).digest('hex')
    let accepted = 0
    f.dependencies.huashengEnabled = () => true
    f.dependencies.enqueueHuasheng = async id => {
      const stored = getHistorySource(id)!
      assert.equal(stored.status, 'needs_review')
      assert.equal(requireCurrentHistoryScript(stored), body)
      const marker = JSON.parse(stored.reviewJson!).huashengQueue
      assert.equal(marker.status, 'pending')
      assert.equal(marker.scriptSha256, expectedHash)
      assert.ok(marker.requestedAt)
      accepted++
    }
    const messages: string[] = []
    const completed = await processHistorySource(record.id, { ...f, onProgress: event => messages.push(event.message) })
    assert.equal(completed.status, 'needs_review')
    assert.equal(completed.lastError, null)
    assert.equal(completed.correctedTranscript, reference)
    assert.equal(completed.rewrittenScript, body)
    assert.equal(requireCurrentHistoryScript(completed), body)
    const review = JSON.parse(completed.reviewJson!)
    assert.equal('lengthCheck' in review.recreation, false)
    assert.equal(review.recreation.title, '')
    assert.equal(review.recreation.coverText, '')
    assert.equal(typeof review.scriptTiming.estimatedSeconds, 'number')
    assert.equal(messages.some(message => /长度|过短|过长|待检查|字数|比例/.test(message)), false)
    assert.equal(accepted, 1)
    const resumed = await processHistorySource(record.id, f)
    assert.equal(resumed.rewrittenScript, body)
    assert.equal('lengthCheck' in JSON.parse(resumed.reviewJson!).recreation, false)
    const mediaCalls = platform === 'douyin' ? 1 : 0
    assert.deepEqual(f.counts, { download: mediaCalls, probe: mediaCalls, extract: mediaCalls, asr: mediaCalls, correct: 1, recreate: 1, rewrite: 0 })
  })
}
}

test('a pre-aborted pipeline creates no lock and makes no provider calls', async () => {
  const record = source()
  const f = fixture()
  const controller = new AbortController()
  controller.abort(new Error('Stopped'))
  await assert.rejects(processHistorySource(record.id, { ...f, signal: controller.signal }), /Stopped/)
  assert.deepEqual(f.counts, { download: 0, probe: 0, extract: 0, asr: 0, correct: 0, recreate: 0, rewrite: 0 })
  assert.equal(getHistorySource(record.id)!.status, 'selected')
})

test('deletion before processing or while acquiring its lock never invokes providers or restores a source', async () => {
  for (const duringLockAcquisition of [false, true]) {
    const record = source()
    const f = fixture()
    if (!duringLockAcquisition) deleteHistorySource(record.id)
    const processing = processHistorySource(record.id, f)
    if (duringLockAcquisition) deleteHistorySource(record.id)
    await assert.rejects(processing, /not found/)
    assert.deepEqual(f.counts, { download: 0, probe: 0, extract: 0, asr: 0, correct: 0, recreate: 0, rewrite: 0 })
    assert.equal(getHistorySource(record.id), null)
    await assert.rejects(access(join(f.storageRoot, String(record.id), 'process.lock')))
    db.delete(schema.historyScriptSources).run()
  }
})

test('stopping after one ASR chunk retains that checkpoint and never starts the next paid stage', async () => {
  const record = source()
  const f = fixture(600)
  const controller = new AbortController()
  const transcribe = f.dependencies.transcribeAudio
  f.dependencies.transcribeAudio = async (file, duration, signal) => {
    assert.equal(signal, controller.signal)
    const result = await transcribe(file, duration)
    controller.abort(new Error('Stopped during transcription'))
    return result
  }
  await assert.rejects(processHistorySource(record.id, { ...f, signal: controller.signal }), /Stopped/)
  const interrupted = getHistorySource(record.id)!
  assert.equal(interrupted.status, 'downloaded')
  assert.equal(JSON.parse(interrupted.asrJson!).chunks.length, 1)
  assert.equal(f.counts.asr, 1)
  assert.equal(f.counts.correct, 0)
  assert.equal(f.counts.rewrite, 0)
  await assert.rejects(access(join(f.storageRoot, String(record.id), 'process.lock')))
  f.dependencies.transcribeAudio = transcribe
  await processHistorySource(record.id, f)
  assert.equal(f.counts.asr, 2, 'Only the unfinished second chunk should need a provider call')
})

test('stopping before recreation retains corrected text and resumes without repeating correction', async () => {
  const record = source()
  const f = fixture()
  const controller = new AbortController()
  await assert.rejects(processHistorySource(record.id, {
    ...f, signal: controller.signal,
    onProgress(event) { if (event.stage === 'rewriting') controller.abort(new Error('Stopped before recreation')) },
  }), /Stopped/)
  assert.equal(f.counts.rewrite, 0)
  assert.equal(f.counts.recreate, 0)
  assert.equal(getHistorySource(record.id)!.status, 'corrected')
  assert.ok(getHistorySource(record.id)!.correctedTranscript)
  await processHistorySource(record.id, f)
  assert.deepEqual(f.counts, { download: 1, probe: 1, extract: 1, asr: 1, correct: 1, recreate: 1, rewrite: 0 })
})

test('canceling downloader polling cancels only the invocation-owned download', async () => {
  const record = source()
  for (const reused of [false, true]) {
    const controller = new AbortController()
    const methods: string[] = []
    const fetchFn: typeof fetch = async (_url, init) => {
      methods.push(init?.method ?? 'GET')
      if (init?.method === 'POST') return Response.json({ success: true, data: { download_id: 'owned-id', state: 'queued', ...(reused ? { reused: 'existing' } : {}) } })
      if (init?.method === 'DELETE') return Response.json({ success: true, data: { state: 'cancelled' } })
      controller.abort(new Error('Stop download'))
      return Response.json({ success: true, data: { state: 'running' } })
    }
    await assert.rejects(downloadHistoryVideo(record, join(dbDir, 'never-created.mp4'), {}, () => {}, {
      connection: { baseUrl: 'http://127.0.0.1:9125', apiKey: 'test-only' }, fetchFn, signal: controller.signal,
    }))
    assert.deepEqual(methods, reused ? ['POST', 'GET'] : ['POST', 'GET', 'DELETE'])
  }
})

test('correct-only processing does not call recreation or create an exportable draft', async () => {
  const record = source()
  const f = fixture()
  const corrected = await processHistorySource(record.id, { ...f, through: 'correct' })
  assert.equal(corrected.status, 'corrected')
  assert.equal(corrected.rewrittenScript, null)
  assert.equal(f.counts.recreate, 0)
  assert.throws(() => requireCurrentHistoryScript(corrected))
  const completed = await processHistorySource(record.id, f)
  assert.equal(completed.status, 'needs_review')
  assert.equal(f.counts.correct, 1)
  assert.equal(f.counts.recreate, 1)
})

test('recreation failure keeps correction checkpoints and retry does not repeat ASR or correction', async () => {
  const record = source()
  const f = fixture()
  const recreate = f.dependencies.recreateScript
  f.dependencies.recreateScript = async () => { throw new Error('Text provider unavailable') }
  await assert.rejects(processHistorySource(record.id, f), /Text provider unavailable/)
  const failed = getHistorySource(record.id)!
  assert.equal(failed.status, 'failed')
  assert.ok(failed.correctedTranscript)
  assert.equal(failed.rewrittenScript, null)
  assert.equal(getHistorySourceArtifactState(failed).corrected, 'current')
  f.dependencies.recreateScript = recreate
  const completed = await processHistorySource(record.id, f)
  assert.equal(completed.status, 'needs_review')
  assert.deepEqual(f.counts, { download: 1, probe: 1, extract: 1, asr: 1, correct: 1, recreate: 1, rewrite: 0 })
})

for (const stage of ['correctTranscript','recreateScript'] as const) test(`HTTP 429 during ${stage} keeps the last complete checkpoint and its retry classification`, async () => {
  const record=source(),f=fixture(),original=f.dependencies[stage]
  f.dependencies[stage]=async()=>{throw Object.assign(new Error('gateway_concurrency_limit https://provider.example/request'),{status:429,retryAfterMs:12000})}
  await assert.rejects(processHistorySource(record.id,f),(error:any)=>{
    assert.equal(error.code,'history_source_rate_limited');assert.equal(error.status,429);assert.equal(error.retryAfterMs,12000)
    assert.doesNotMatch(error.message,/provider\.example/)
    return true
  })
  const retained=getHistorySource(record.id)!
  assert.equal(retained.status,stage==='correctTranscript' ? 'transcribed' : 'corrected')
  assert.equal(getHistorySourceArtifactState(retained).transcript,'current')
  assert.match(retained.lastError!,/gateway_concurrency_limit/)
  assert.ok(JSON.parse(retained.mediaJson).cleanup.localReleasedAt)
  f.dependencies[stage]=original as any
  assert.equal((await processHistorySource(record.id,f)).status,'needs_review')
  assert.equal(f.counts.download,1);assert.equal(f.counts.asr,1);assert.equal(f.counts.correct,1);assert.equal(f.counts.recreate,1)
})

test('only explicit HTTP 429 is a refused request; timeouts and incidental status text are not retry permission',async()=>{
  for(const error of [new Error('HTTP 429: gateway_concurrency_limit'),new Error('Text model request failed: 429 Too Many Requests'),
    Object.assign(new Error('busy'),{httpStatus:429})]) assert.equal(isHistorySourceRateLimitError(error),true)
  for(const error of [new Error('timeout after request submission'),new Error('429 characters in the response'),
    Object.assign(new Error('response body mentions HTTP 429'),{status:500}),new DOMException('provider timeout','TimeoutError')]) {
    assert.equal(isHistorySourceRateLimitError(error),false)
  }
  const record=source(),f=fixture()
  let calls=0
  f.dependencies.correctTranscript=async()=>{calls++;throw new DOMException('provider outcome unknown','TimeoutError')}
  await assert.rejects(processHistorySource(record.id,f),/provider outcome unknown/)
  assert.equal(calls,1,'the collection change adds no retry for an uncertain request')
  assert.equal(getHistorySourceArtifactState(getHistorySource(record.id)!).transcript,'current')
})

test('perspective analysis survives a failed draft and is reused before a complete manuscript is queued', async () => {
  const record = source(), f = fixture()
  let savedPlan: any, calls = 0, queued = 0
  f.dependencies.enqueueHuasheng = async () => { queued++ }
  f.dependencies.recreateScript = async (text, review, _signal, _title, _author, planning) => {
    calls++
    assert.equal(review.correctedTranscript, text)
    if (calls === 1) {
      savedPlan = {
        sourceSha256: createHash('sha256').update(text).digest('hex'),
        skillRevision: 'history-perspective-recreation-v1', skillSha256: 'b'.repeat(64), model: 'gpt-6.1-sol',
        analysis: {coreViewpoint: '原文强调英雄个人', storyStructure: [{stage:'开场',content:'危机出现'}], emotionArc: [{stage:'开场',emotion:'担忧',trigger:'情报尚未送达'}], factsToPreserve:['原文中的行动和时间']},
        angles: ['opposing','counterintuitive','conflict'].map(id=>({id,title:`角度 ${id}`,stance:`立场 ${id}`,contrast:`认知反差 ${id}`,evidence:['原文行动'],outline:['从行动的代价切入']})),
        selectedAngleId: 'conflict', selectionReason: '原文有明确的时间压力',
        writingOutline:{thesis:'情报必须赶在追兵前转化为行动',stance:'用行动与时间解释转移成功',sections:[{id:'s1',purpose:'提出压力',newInformation:'行动有时间限制',backgroundIds:[],evidenceIds:['e1'],emotionIds:['m1']}],endingPayoff:'时间压力得到回应'},
      }
      await planning!.onPlan!(savedPlan)
      assert.deepEqual(JSON.parse(getHistorySource(record.id)!.reviewJson!).recreationPlan, savedPlan)
      assert.equal(getHistorySource(record.id)!.rewrittenScript, null)
      throw new Error('Draft provider unavailable')
    }
    assert.deepEqual(planning!.plan, savedPlan)
    await planning!.onPlan!(planning!.plan!)
    return {title:'新立场',coverText:'',script:'围绕时间压力重新组织的完整新稿。',skillName:'history-perspective-recreation',
      skillRevision:savedPlan.skillRevision,skillSha256:savedPlan.skillSha256,model:'remote-writing-model',provider:'remote-writer',
      analysisModel:savedPlan.model,analysisProvider:'test',plan:savedPlan,
      analysis:savedPlan.analysis,angles:savedPlan.angles,selectedAngleId:savedPlan.selectedAngleId,selectionReason:savedPlan.selectionReason,writingOutline:savedPlan.writingOutline}
  }
  await assert.rejects(processHistorySource(record.id, f), /Draft provider unavailable/)
  assert.equal(queued,0)
  assert.equal(getHistorySource(record.id)!.rewrittenScript,null)
  const completed = await processHistorySource(record.id, f)
  const review = JSON.parse(completed.reviewJson!)
  assert.equal(review.draftOrigin,'perspective_recreation')
  assert.equal(review.recreation.model,'remote-writing-model')
  assert.equal(review.recreation.provider,'remote-writer')
  assert.equal(review.recreation.analysisModel,savedPlan.model)
  assert.equal(review.recreation.analysisProvider,'test')
  assert.deepEqual(review.recreation.analysis,savedPlan.analysis)
  assert.deepEqual(review.recreation.angles,savedPlan.angles)
  assert.equal(review.recreation.selectedAngleId,'conflict')
  assert.equal(review.recreation.selectionReason,savedPlan.selectionReason)
  assert.deepEqual(review.recreation.writingOutline,savedPlan.writingOutline)
  assert.equal(requireCurrentHistoryScript(completed),'围绕时间压力重新组织的完整新稿。')
  assert.equal(queued,1)
  assert.equal(f.counts.correct,1)
  await processHistorySource(record.id, f)
  assert.equal(calls,2,'A completed draft is preserved when the pipeline runs again')
})

test('a cancelled analysis checkpoint cannot be saved or submitted to video production', async () => {
  const record = source(), f = fixture(), controller = new AbortController()
  let queued = 0
  f.dependencies.enqueueHuasheng = async () => { queued++ }
  f.dependencies.recreateScript = async (_text, _review, _signal, _title, _author, planning) => {
    controller.abort(new Error('Stopped while analysing'))
    await planning!.onPlan!({} as any)
    assert.fail('Cancellation must stop before the writing phase')
  }
  await assert.rejects(processHistorySource(record.id, {...f,signal:controller.signal}),/Stopped while analysing/)
  const stopped = getHistorySource(record.id)!
  assert.equal(stopped.rewrittenScript,null)
  assert.equal(JSON.parse(stopped.reviewJson!).recreationPlan,undefined)
  assert.equal(queued,0)
})

test('cancellation during recreation discards late model output and keeps corrected checkpoint', async () => {
  const record = source()
  const f = fixture()
  const controller = new AbortController()
  const recreate = f.dependencies.recreateScript
  f.dependencies.recreateScript = async (text, review, signal) => {
    assert.equal(signal, controller.signal)
    const result = await recreate(text, review, signal)
    controller.abort(new Error('Stopped during recreation'))
    return result
  }
  await assert.rejects(processHistorySource(record.id, { ...f, signal: controller.signal }), /Stopped during recreation/)
  const stopped = getHistorySource(record.id)!
  assert.equal(stopped.status, 'corrected')
  assert.equal(stopped.rewrittenScript, null)
  assert.equal(JSON.parse(stopped.reviewJson!).recreation, undefined)
  f.dependencies.recreateScript = recreate
  const completed = await processHistorySource(record.id, f)
  assert.equal(completed.status, 'needs_review')
  assert.equal(f.counts.asr, 1)
  assert.equal(f.counts.correct, 1)
  assert.equal(f.counts.recreate, 2)
})

test('bounded reruns preserve needs_review when all cached inputs and output provenance remain current', async () => {
  const record = source()
  const f = fixture()
  const completed = await processHistorySource(record.id, f)
  assert.equal(requireCurrentHistoryScript(completed), completed.rewrittenScript)
  const counts = { ...f.counts }
  for (const through of ['download', 'asr', 'correct'] as const) {
    const unchanged = await processHistorySource(record.id, { ...f, through })
    assert.equal(unchanged.status, 'needs_review', through)
    assert.deepEqual(getHistorySourceArtifactState(unchanged), { transcript: 'current', corrected: 'current', rewritten: 'current' })
    assert.deepEqual(f.counts, counts)
  }
})

test('changed source media and ASR retain earlier text but prevent exporting a stale rewrite', async () => {
  const record = source()
  const f = fixture()
  const previous = await processHistorySource(record.id, f)
  const changedMedia = { ...JSON.parse(previous.mediaJson), videoPath: join(f.storageRoot, String(record.id), 'source.mp4'), videoSha256: 'f'.repeat(64), cleanup: undefined }
  updateHistorySource(record.id, { mediaJson: JSON.stringify(changedMedia) })
  const videoPath = changedMedia.videoPath
  await writeFile(videoPath, Buffer.alloc(128, 2))
  f.dependencies.downloadVideo = async (_source, target, _media, checkpoint) => {
    checkpoint({ downloadId: 'download-2', downloadState: 'done' })
    await writeFile(target, Buffer.alloc(128, 3))
    return { downloadId: 'download-2', videoPath: target }
  }
  f.dependencies.extractAudio = async (_video, _chunk, target) => { await writeFile(target, Buffer.alloc(128, 3)) }
  f.dependencies.transcribeAudio = async (_file, duration) => ({ text: 'New narration from changed media', duration })
  const downloaded = await processHistorySource(record.id, { ...f, through: 'download' })
  assert.equal(downloaded.status, 'downloaded')
  assert.equal(downloaded.rewrittenScript, previous.rewrittenScript)
  assert.equal(getHistorySourceArtifactState(downloaded).rewritten, 'stale')
  assert.throws(() => requireCurrentHistoryScript(downloaded), /stale/)
  const transcribed = await processHistorySource(record.id, { ...f, through: 'asr' })
  assert.equal(transcribed.status, 'transcribed')
  assert.equal(transcribed.rawTranscript, 'New narration from changed media')
  assert.equal(transcribed.correctedTranscript, previous.correctedTranscript)
  assert.equal(transcribed.rewrittenScript, previous.rewrittenScript)
  assert.deepEqual(getHistorySourceArtifactState(transcribed), { transcript: 'current', corrected: 'stale', rewritten: 'stale' })
  assert.throws(() => requireCurrentHistoryScript(transcribed), /stale/)
  const rewritten = await processHistorySource(record.id, f)
  assert.equal(rewritten.status, 'needs_review')
  assert.ok(requireCurrentHistoryScript(rewritten).includes('New narration from changed media'))
  assert.equal(f.counts.correct, 2)
  assert.equal(f.counts.rewrite, 0)
})

test('an ASR chunk failure preserves completed chunks and prior text, then retries only the failed chunk', async () => {
  const record = source()
  updateHistorySource(record.id, { rawTranscript: 'Previous complete transcript' })
  const f = fixture(600)
  let calls = 0
  f.dependencies.transcribeAudio = async (_file, duration) => {
    calls++
    if (calls === 2) throw new Error('ASR service temporarily unavailable')
    return { text: `Transcription ${calls}`, duration }
  }
  await assert.rejects(processHistorySource(record.id, { ...f, through: 'asr' }), /temporarily unavailable/)
  const failed = getHistorySource(record.id)!
  assert.equal(failed.status, 'failed')
  assert.equal(failed.rawTranscript, 'Previous complete transcript')
  assert.match(failed.lastError!, /ASR service temporarily unavailable/)
  assert.equal(JSON.parse(failed.asrJson!).complete, false)
  assert.equal(JSON.parse(failed.asrJson!).chunks.length, 1)
  const resumed = await processHistorySource(record.id, { ...f, through: 'asr' })
  assert.equal(calls, 3)
  assert.equal(resumed.status, 'transcribed')
  assert.equal(resumed.rawTranscript, 'Transcription 1\n\nTranscription 3')
  assert.equal(JSON.parse(resumed.asrJson!).complete, true)
  assert.equal(f.counts.correct, 0)
})

test('history ASR resumes paid MiniMax chunks with Qwen and records mixed model provenance', async () => {
  const record = source(), f = fixture(600)
  let calls = 0
  const messages: string[] = []
  f.dependencies.transcribeAudio = async (_file, duration) => {
    calls++
    if (calls === 2) throw new Error('MiniMax quota exhausted')
    return { text: `Transcription ${calls}`, duration, provider: calls === 1 ? 'minimax' : 'qwen',
      model: calls === 1 ? 'asr-1.0' : 'qwen-audio-3.1-asr-flash-filetrans' }
  }
  const options = { ...f, through: 'asr' as const, onProgress: (event: { message: string }) => messages.push(event.message) }
  await assert.rejects(processHistorySource(record.id, options), /quota exhausted/)
  assert.equal(JSON.parse(getHistorySource(record.id)!.asrJson!).model, 'asr-1.0')
  const resumed = await processHistorySource(record.id, options)
  const cache = JSON.parse(resumed.asrJson!)
  assert.equal(calls, 3)
  assert.equal(cache.model, 'mixed')
  assert.equal(cache.chunks[0].result.provider, 'minimax')
  assert.equal(cache.chunks[1].result.provider, 'qwen')
  assert.equal(cache.chunks[1].result.model, 'qwen-audio-3.1-asr-flash-filetrans')
  assert.equal(messages.some(message => message.includes('MiniMax 转写')), false)
})

test('history ASR checkpoints record the Qwen model before and after completion', async () => {
  const record = source(), f = fixture(600), controller = new AbortController()
  const model = 'qwen-audio-3.1-asr-flash-filetrans'
  let calls = 0
  f.dependencies.transcribeAudio = async (_file, duration) => {
    if (++calls === 1) controller.abort(new Error('pause after paid Qwen chunk'))
    return { text: `Qwen ${calls}`, duration, provider: 'qwen', model }
  }
  await assert.rejects(processHistorySource(record.id, { ...f, through: 'asr', signal: controller.signal }), /pause after/)
  assert.equal(JSON.parse(getHistorySource(record.id)!.asrJson!).model, model)
  const completed = await processHistorySource(record.id, { ...f, through: 'asr' })
  assert.equal(JSON.parse(completed.asrJson!).model, model)
  assert.equal(calls, 2)
})

test('resuming a legacy local-rewrite failure recreates text without calling LM Studio', async () => {
  const record = source()
  const f = fixture()
  await processHistorySource(record.id, f)
  updateHistorySource(record.id, { status: 'failed', rewrittenScript: null, lastError: 'LM Studio stopped' })
  const failed = getHistorySource(record.id)!
  assert.equal(failed.status, 'failed')
  assert.ok(failed.correctedTranscript?.endsWith('corrected'))
  assert.equal(JSON.parse(failed.reviewJson!).factCheckStatus, 'needs_sources')
  f.dependencies.rewriteScript = async () => { throw new Error('LM Studio must not be called') }
  const result = await processHistorySource(record.id, f)
  assert.equal(result.status, 'needs_review')
  assert.equal(f.counts.asr, 1)
  assert.equal(f.counts.correct, 1)
  assert.equal(f.counts.rewrite, 0)
  assert.equal(f.counts.recreate, 2)
  assert.equal(result.rewrittenScript, `${result.correctedTranscript} recreated`)
  assert.equal(result.lastError, null)
})

test('reruns preserve legacy rewrites, corrected-only drafts and manually edited current drafts', async () => {
  const record = source()
  const f = fixture()
  const initial = await processHistorySource(record.id, f)
  const counts = { ...f.counts }
  for (const draft of ['Existing local-model rewrite', initial.correctedTranscript!, 'User edited this draft by hand']) {
    const review = JSON.parse(initial.reviewJson!)
    delete review.draftOrigin
    updateHistorySource(record.id, { rewrittenScript: draft, reviewJson: JSON.stringify(review) })
    const result = await processHistorySource(record.id, f)
    assert.equal(requireCurrentHistoryScript(result), draft)
    assert.equal(JSON.parse(result.reviewJson!).draftOrigin, undefined, 'Do not relabel an existing rewrite as corrected-only')
    assert.deepEqual(f.counts, counts)
  }
})

test('empty and incomplete ASR outputs cannot become a complete transcript', async () => {
  for (const result of [{ text: '', duration: 12 }, { text: 'Only the beginning', duration: 1 }]) {
    const record = source()
    const f = fixture()
    f.dependencies.transcribeAudio = async () => result
    await assert.rejects(processHistorySource(record.id, { ...f, through: 'asr' }), /empty or incomplete/)
    assert.equal(getHistorySource(record.id)?.rawTranscript, null)
    assert.equal(getHistorySource(record.id)?.status, 'failed')
    assert.equal(f.counts.correct, 0)
    db.delete(schema.historyScriptSources).run()
  }
})

test('missing audio and incomplete chunk plans fail before ASR while preserving the downloaded video', async () => {
  const record = source()
  const f = fixture(600)
  f.dependencies.probeVideo = async () => { throw new Error('Source video has no audio stream') }
  await assert.rejects(processHistorySource(record.id, f), /no audio stream/)
  assert.equal(f.counts.extract, 0)
  assert.equal(f.counts.asr, 0)
  const failed = getHistorySource(record.id)!
  assert.equal(failed.status, 'failed')
  assert.ok(JSON.parse(failed.mediaJson).videoSha256)
  f.dependencies.probeVideo = async () => ({ duration: 600, audioStreamIndex: 1 })
  f.dependencies.planChunks = () => [{ start: 0, duration: 480 }]
  await assert.rejects(processHistorySource(record.id, f), /does not cover the full source/)
  assert.equal(f.counts.download, 1)
  assert.equal(f.counts.asr, 0)
})

test('exclusive source locks refuse concurrent processing and only explicitly unlock stopped owners', async () => {
  const record = source()
  const f = fixture()
  const directory = join(f.storageRoot, String(record.id))
  await mkdir(directory)
  const lockPath = join(directory, 'process.lock')
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, hostname: hostname() }))
  await assert.rejects(processHistorySource(record.id, f), /is locked/)
  assert.equal(getHistorySource(record.id)?.status, 'selected')
  await assert.rejects(unlockHistorySource(record.id, f.storageRoot), /still owned by running process/)
  await writeFile(lockPath, JSON.stringify({ pid: 2147483647, hostname: hostname() }))
  await unlockHistorySource(record.id, f.storageRoot)
  await assert.rejects(access(lockPath))
})

test('downloader polls a partial result with a completed video, streams it atomically and verifies its digest', async () => {
  const record = source()
  const directory = mkdtempSync(join(tmpdir(), 'huobao-history-download-'))
  const target = join(directory, 'source.mp4')
  const bytes = Buffer.from('A fake completed video')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let polls = 0
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (init?.method === 'POST') return Response.json({ success: true, data: { download_id: 'download-1', task_id: 'task-1', state: 'queued' } }, { status: 202 })
    if (String(url).includes('/files/')) return new Response(bytes)
    polls++
    return Response.json({ success: true, data: polls === 1 ? { state: 'running' } : { state: 'partial', on_disk: true, files: [{ name: '../../untrusted.mp4', kind: 'video', state: 'done', bytes: bytes.length, sha256 }] } })
  }) as typeof fetch
  const checkpoints: unknown[] = []
  const media = await downloadHistoryVideo(record, target, {}, checkpoint => checkpoints.push(checkpoint), { connection: { baseUrl: 'http://127.0.0.1:9125', apiKey: 'private-test-key' }, fetchFn, pollMs: 0 })
  assert.deepEqual(await readFile(target), bytes)
  assert.equal(media.videoSha256, sha256)
  assert.equal(media.videoPath, target)
  assert.equal(media.downloadId, 'download-1')
  assert.deepEqual(JSON.parse(calls[0].init!.body as string), { url: record.sourceUrl, skip_existing: true })
  assert.equal((calls[0].init!.headers as Record<string, string>)['X-API-Key'], 'private-test-key')
  assert.ok(calls.at(-1)!.url.endsWith('/files/..%2F..%2Funtrusted.mp4'))
  assert.equal(checkpoints.length, 3)
  await assert.rejects(access(`${target}.part`))
})

test('disk reserve prevents a new Douyin request while allowing a verified local source', async () => {
  const record = source()
  const directory = mkdtempSync(join(tmpdir(), 'history-douyin-space-')), target = join(directory, 'source.mp4')
  const previous = process.env.MEDIA_DISK_RESERVE_GIB
  process.env.MEDIA_DISK_RESERVE_GIB = '1000000000'
  const options = { fetchFn: async () => assert.fail('low disk space must not submit a downloader job') }
  try {
    await assert.rejects(downloadHistoryVideo(record, target, {}, () => {}, options), { code: 'MEDIA_DISK_FULL' })
    await writeFile(target, 'verified source')
    const media = { videoPath: target, videoSha256: createHash('sha256').update('verified source').digest('hex') }
    assert.deepEqual(await downloadHistoryVideo(record, target, media, () => {}, options), media)
  } finally {
    if (previous === undefined) delete process.env.MEDIA_DISK_RESERVE_GIB
    else process.env.MEDIA_DISK_RESERVE_GIB = previous
  }
})

test('partial results without a video and digest mismatches never produce a local video', async () => {
  const record = source()
  const directory = mkdtempSync(join(tmpdir(), 'huobao-history-download-invalid-'))
  const target = join(directory, 'source.mp4')
  let digestMismatch = false
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ success: true, data: { download_id: 'download-1', state: 'queued' } })
    if (String(url).includes('/files/')) return new Response(Buffer.from('A fake completed video'))
    return Response.json({ success: true, data: { state: 'partial', files: digestMismatch ? [{ name: 'video.mp4', kind: 'video', state: 'done', sha256: '0'.repeat(64) }] : [{ name: 'cover.jpg', kind: 'image', state: 'done' }] } })
  }) as typeof fetch
  const options = { connection: { baseUrl: 'http://127.0.0.1:9125', apiKey: 'private-test-key' }, fetchFn }
  await assert.rejects(downloadHistoryVideo(record, target, {}, () => {}, options), /without a completed video/)
  digestMismatch = true
  await assert.rejects(downloadHistoryVideo(record, target, {}, () => {}, options), /SHA256/)
  await assert.rejects(access(target))
  await assert.rejects(access(`${target}.part`))
})

test('terminal partial downloads without a video clear the old job and retry with a fresh submission', async () => {
  const record = source()
  const directory = mkdtempSync(join(tmpdir(), 'huobao-history-partial-retry-'))
  const target = join(directory, 'source.mp4')
  let media = { downloadId: 'partial-job', downloadState: 'partial' } as { downloadId?: string; downloadState?: string }
  let submissions = 0
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      submissions++
      assert.equal(JSON.parse(init.body as string).skip_existing, false)
      return Response.json({ success: true, data: { download_id: 'fresh-job', state: 'queued' } })
    }
    if (String(url).includes('/files/')) return new Response(Buffer.from('fresh video'))
    return Response.json({ success: true, data: String(url).endsWith('/partial-job') ? {
      state: 'partial', on_disk: true,
      files: [{ name: 'cover.jpg', kind: 'cover', state: 'done' }, { name: 'video.mp4', kind: 'video', state: 'failed', error: 'Temporary upstream timeout' }],
    } : { state: 'done', on_disk: true, files: [{ name: 'video.mp4', kind: 'video', state: 'done' }] } })
  }) as typeof fetch
  const checkpoint = (patch: object) => { media = { ...media, ...patch } }
  const options = { connection: { baseUrl: 'http://127.0.0.1:9125', apiKey: 'test-key' }, fetchFn }
  await assert.rejects(downloadHistoryVideo(record, target, media, checkpoint, options), /Temporary upstream timeout/)
  assert.equal(media.downloadId, undefined)
  assert.equal(media.downloadState, 'expired')
  assert.equal(submissions, 0)
  await downloadHistoryVideo(record, target, media, checkpoint, options)
  assert.equal(submissions, 1)
  assert.equal(media.downloadId, 'fresh-job')
  assert.equal((await readFile(target)).toString(), 'fresh video')
})

test('expired downloader checkpoints force a fresh request instead of reusing Evil stored rows without files', async () => {
  const record = source()
  for (const scenario of ['evicted', 'missing-record', 'missing-file']) {
    const directory = mkdtempSync(join(tmpdir(), 'huobao-history-cache-expired-'))
    const target = join(directory, 'source.mp4')
    let media = { downloadId: 'old-job', downloadState: 'done' } as { downloadId?: string; downloadState?: string }
    let submissions = 0
    let submittedBody: { skip_existing: boolean } | undefined
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        submissions++
        submittedBody = JSON.parse(init.body as string)
        // Evil existing_for returns a done record without checking its files.
        return Response.json({ success: true, data: { download_id: submittedBody?.skip_existing ? 'old-job' : 'new-job', state: 'queued' } })
      }
      const restored = String(url).includes('/new-job')
      if (String(url).includes('/files/')) {
        return !restored && scenario === 'missing-file'
          ? Response.json({ success: false, error: { code: 'NOT_FOUND' } }, { status: 404 })
          : new Response(Buffer.from('restored video'))
      }
      if (!restored && scenario === 'missing-record') {
        return Response.json({ success: false, error: { code: 'NOT_FOUND' } }, { status: 404 })
      }
      return Response.json({ success: true, data: {
        state: 'done', on_disk: restored || scenario !== 'evicted',
        files: [{ name: 'video.mp4', kind: 'video', state: 'done' }],
      } })
    }) as typeof fetch
    const checkpoint = (patch: object) => { media = { ...media, ...patch } }
    const options = { connection: { baseUrl: 'http://127.0.0.1:9125', apiKey: 'test-key' }, fetchFn }
    await assert.rejects(downloadHistoryVideo(record, target, media, checkpoint, options))
    assert.equal(media.downloadId, undefined, scenario)
    await downloadHistoryVideo(record, target, media, checkpoint, options)
    assert.equal(submissions, 1, scenario)
    assert.equal(submittedBody?.skip_existing, false, scenario)
    assert.equal(media.downloadId, 'new-job')
    assert.equal((await readFile(target)).toString(), 'restored video')
  }
})
