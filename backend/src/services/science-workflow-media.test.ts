import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { downloadScienceSource, transcribeScienceSource, prepareScienceUploadAssets, inspectScienceUploadAssets, releaseScienceSourceMedia } from './science-workflow-media.js'
import { EmptyAsrTranscriptionError, transcribeHistoryAudio } from './history-script-processing.js'
import type { SourceMedia } from './history-source-pipeline.js'

const exec = promisify(execFile)
const signal = () => new AbortController().signal
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function directory(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-media-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('source reclamation requires a durable matching transcript and retains output assets and outside symlink targets', async t => {
  const root = await fs.realpath(await directory(t)), outside = await directory(t)
  const videoPath = path.join(root, 'source.mp4'), original = path.join(outside, 'original.mp4')
  await fs.writeFile(videoPath, 'source bytes')
  await fs.writeFile(original, 'outside file')
  await fs.writeFile(path.join(root, 'video.mp4'), 'finished video')
  await fs.symlink(original, path.join(root, 'asr-1234567890abcdef-0.wav'))
  const input = { directory: root, ownerId: 'science-test', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    transcript: 'complete narration', media: { videoPath, videoSha256: hash('source bytes') },
    checkpoint: { version: 1 as const, sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      sourceVideoSha256: hash('source bytes'), transcriptSha256: hash('complete narration') } }
  await assert.rejects(releaseScienceSourceMedia({ ...input, transcript: 'changed narration' }), /完整转录/)
  assert.equal(await fs.readFile(videoPath, 'utf8'), 'source bytes')
  const cleaned = await releaseScienceSourceMedia(input)
  assert.ok(cleaned.cleanup?.localReleasedAt)
  assert.equal(cleaned.cleanup?.releasedBytes, 'source bytes'.length)
  await assert.rejects(fs.access(videoPath))
  await assert.rejects(fs.access(path.join(root, 'asr-1234567890abcdef-0.wav')))
  assert.equal(await fs.readFile(original, 'utf8'), 'outside file')
  assert.equal(await fs.readFile(path.join(root, 'video.mp4'), 'utf8'), 'finished video')
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'storage-release.json'), 'utf8'))
  assert.equal(manifest.ownerType, 'science-job')
  assert.equal(manifest.ownerId, input.ownerId)
  assert.equal(manifest.sourceSha256, input.media.videoSha256)
  assert.equal(manifest.transcriptSha256, input.checkpoint.transcriptSha256)
  assert.equal(manifest.status, 'completed')
})

test('source metadata is persisted before download so retry skips collection and completes the original source', async t => {
  const root = await directory(t), patches: Partial<SourceMedia>[] = []
  let collections = 0, downloads = 0
  const sourceUrl = 'https://www.youtube.com/watch?v=abcdefghijk'
  const options: Parameters<typeof downloadScienceSource>[1] = {
    signal: signal(), report: () => {}, onMedia: patch => { patches.push(patch) },
    dependencies: {
      collect: async options => {
        collections++
        assert.equal(options.targetCount, 1)
        await options.onCandidate({ videoId: 'abcdefghijk', sourceUrl, title: '为什么天空是蓝色', authorName: 'Science Channel', observedAt: new Date().toISOString(), collectionUrl: sourceUrl })
      },
      download: async (source, target, _media, checkpoint) => {
        downloads++
        assert.equal(source.sourceUrl, sourceUrl)
        if (downloads === 1) { checkpoint({ downloadState: 'failed' }); throw new Error('interrupted') }
        await fs.writeFile(target, 'source video')
        return { videoPath: target, videoSha256: hash('source video'), videoBytes: 12, downloadState: 'done' }
      },
    },
  }
  await assert.rejects(downloadScienceSource({ sourceUrl, directory: root, media: {} }, options), /interrupted/)
  assert.equal(patches.some(item => item.downloadState === 'done'), false)
  const result = await downloadScienceSource({ sourceUrl, directory: root, media: {} }, options)
  assert.equal(collections, 1); assert.equal(downloads, 2)
  assert.equal(result.title, '为什么天空是蓝色')
  assert.equal(result.author, 'Science Channel')
  assert.equal(result.media.sourceUrl, sourceUrl)
  assert.equal(await fs.readFile(result.media.videoPath!, 'utf8'), 'source video')
  assert.equal(patches.at(-1)?.videoSha256, result.media.videoSha256)
})

test('source download rejects a channel and mismatched metadata before media dispatch', async t => {
  const root = await directory(t)
  let downloads = 0
  const options: Parameters<typeof downloadScienceSource>[1] = {
    signal: signal(), report: () => {}, onMedia: () => {}, dependencies: {
      collect: async options => { await options.onCandidate({ videoId: 'other_id123', sourceUrl: 'https://www.youtube.com/watch?v=other_id123', title: 'Other', authorName: null, observedAt: '', collectionUrl: '' }) },
      download: async () => { downloads++; throw new Error('must not download') },
    },
  }
  await assert.rejects(downloadScienceSource({ sourceUrl: 'https://www.youtube.com/@Science/videos', directory: root, media: {} }, options), /单条/)
  await assert.rejects(downloadScienceSource({ sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', directory: root, media: {} }, options), /不一致/)
  assert.equal(downloads, 0)
})

test('ASR resumes cached chunks, uses automatic language detection and returns only the complete transcript', async t => {
  const root = await directory(t), videoPath = path.join(root, 'source.mp4')
  await fs.writeFile(videoPath, 'source video')
  const extracted: number[] = [], durations: number[] = []
  let fail = true
  const options: Parameters<typeof transcribeScienceSource>[1] = {
    signal: signal(), report: () => {}, dependencies: {
      probe: async () => ({ duration: 990, audioStreamIndex: 1 }),
      extract: async (_video, chunk, audio) => { extracted.push(chunk.start); await fs.writeFile(audio, `chunk-${chunk.start}`) },
      transcribe: async (audio, duration, options) => {
        assert.equal(options?.language, '')
        const chunk = await fs.readFile(audio, 'utf8')
        durations.push(duration)
        if (chunk === 'chunk-480' && fail) { fail = false; throw new Error('transient ASR failure') }
        return { duration, text: chunk }
      },
    },
  }
  const input = { videoPath, videoSha256: hash('source video'), directory: root }
  await assert.rejects(transcribeScienceSource(input, options), /transient ASR/)
  const partial = JSON.parse(await fs.readFile(path.join(root, 'transcription.json'), 'utf8'))
  assert.equal(partial.chunks.length, 1)
  assert.equal(await transcribeScienceSource(input, options), 'chunk-0\n\nchunk-480\n\nchunk-960')
  assert.deepEqual(extracted, [0, 480, 480, 960])
  assert.deepEqual(durations, [480, 480, 480, 30])
  assert.equal(await transcribeScienceSource(input, options), 'chunk-0\n\nchunk-480\n\nchunk-960')
  assert.equal(durations.length, 4)
  await fs.writeFile(videoPath, 'changed video')
  await assert.rejects(transcribeScienceSource(input, options), /源视频已改变/)
  assert.equal(durations.length, 4)
})

test('science ASR preserves paid MiniMax chunks when continuing with Qwen and reuses the mixed cache', async t => {
  const root = await directory(t), videoPath = path.join(root, 'source.mp4')
  await fs.writeFile(videoPath, 'source video')
  const videoSha256 = hash('source video')
  await fs.writeFile(path.join(root, 'transcription.json'), JSON.stringify({
    version: 1, model: 'minimax-asr-1.0', language: '', videoSha256,
    chunks: [{ start: 0, duration: 480, text: 'already paid MiniMax transcript' }],
  }))
  let calls = 0
  const options: Parameters<typeof transcribeScienceSource>[1] = {
    signal: signal(), report: () => {}, dependencies: {
      probe: async () => ({ duration: 510, audioStreamIndex: 1 }),
      extract: async (_video, chunk, audio) => { assert.equal(chunk.start, 480); await fs.writeFile(audio, 'wav') },
      transcribe: async (_audio, duration) => {
        calls++
        return { duration, text: 'Qwen continuation', provider: 'qwen', model: 'qwen-audio-3.1-asr-flash-filetrans' }
      },
    },
  }
  const input = { videoPath, videoSha256, directory: root }
  assert.equal(await transcribeScienceSource(input, options), 'already paid MiniMax transcript\n\nQwen continuation')
  const cache = JSON.parse(await fs.readFile(path.join(root, 'transcription.json'), 'utf8'))
  assert.equal(cache.model, 'mixed')
  assert.equal(cache.chunks[1].provider, 'qwen')
  assert.equal(cache.chunks[1].model, 'qwen-audio-3.1-asr-flash-filetrans')
  assert.equal(await transcribeScienceSource(input, options), 'already paid MiniMax transcript\n\nQwen continuation')
  assert.equal(calls, 1)
})

test('science ASR reuses a complete Qwen cache without extracting or requesting audio again', async t => {
  const root = await directory(t), videoPath = path.join(root, 'source.mp4')
  await fs.writeFile(videoPath, 'source video')
  const videoSha256 = hash('source video'), model = 'qwen-audio-3.1-asr-flash-filetrans'
  await fs.writeFile(path.join(root, 'transcription.json'), JSON.stringify({
    version: 1, model, language: '', videoSha256,
    chunks: [{ start: 0, duration: 90, text: 'paid Qwen transcript', provider: 'qwen', model }],
  }))
  assert.equal(await transcribeScienceSource({ videoPath, videoSha256, directory: root }, {
    signal: signal(), report: () => {}, dependencies: {
      probe: async () => ({ duration: 90, audioStreamIndex: 1 }),
      extract: async () => { throw new Error('cached Qwen audio must not be extracted') },
      transcribe: async () => { throw new Error('cached Qwen audio must not be billed again') },
    },
  }), 'paid Qwen transcript')
})

test('a short outro is included in the preceding ASR chunk, retaining the first cached chunk and replacing the old second range', async t => {
  const root = await directory(t), videoPath = path.join(root, 'source.mp4')
  await fs.writeFile(videoPath, 'source video')
  const videoSha256 = hash('source video'), duration = 968.736508
  const firstChunk = { start: 0, duration: 480, text: '已完成首段' }
  const oldSecond = { start: 480, duration: 480, text: '旧第二段未覆盖片尾' }
  await fs.writeFile(path.join(root, 'transcription.json'), JSON.stringify({ version: 1, model: 'minimax-asr-1.0', language: '', videoSha256, chunks: [firstChunk, oldSecond] }))
  const extracted: Array<{ start: number; duration: number }> = [], requests: number[] = []
  const options: Parameters<typeof transcribeScienceSource>[1] = {
    signal: signal(), report: () => {}, dependencies: {
      probe: async () => ({ duration, audioStreamIndex: 1 }),
      extract: async (_video, chunk, audio) => { extracted.push({ ...chunk }); await fs.writeFile(audio, 'wav') },
      transcribe: async (_audio, seconds) => { requests.push(seconds); return { duration: seconds, text: '包含完整片尾的第二段' } },
    },
  }
  const input = { videoPath, videoSha256, directory: root }
  assert.equal(await transcribeScienceSource(input, options), '已完成首段\n\n包含完整片尾的第二段')
  assert.deepEqual(extracted, [{ start: 480, duration: duration - 480 }])
  assert.deepEqual(requests, [duration - 480])
  assert.equal(firstChunk.start + firstChunk.duration, extracted[0]!.start)
  assert.equal(extracted[0]!.start + extracted[0]!.duration, duration)
  const cache = JSON.parse(await fs.readFile(path.join(root, 'transcription.json'), 'utf8'))
  assert.ok(cache.chunks.some((chunk: any) => chunk.start === 480 && chunk.duration === duration - 480 && chunk.text === '包含完整片尾的第二段'))
  assert.equal(await transcribeScienceSource(input, options), '已完成首段\n\n包含完整片尾的第二段')
  assert.equal(requests.length, 1); assert.equal(extracted.length, 1)
})

test('science ASR covers the full recording around the short-outro boundary without exceeding provider duration limits', async t => {
  for (const duration of [10, 480, 500, 500.001, 980, 980.001]) {
    const root = await directory(t), videoPath = path.join(root, 'source.mp4')
    await fs.writeFile(videoPath, 'source video')
    const extracted: Array<{ start: number; duration: number }> = []
    await transcribeScienceSource({ videoPath, videoSha256: hash('source video'), directory: root }, {
      signal: signal(), report: () => {}, dependencies: {
        probe: async () => ({ duration, audioStreamIndex: 1 }),
        extract: async (_video, chunk, audio) => { extracted.push({ ...chunk }); await fs.writeFile(audio, 'wav') },
        transcribe: async (_audio, seconds) => ({ duration: seconds, text: '连续语音' }),
      },
    })
    let end = 0
    for (const chunk of extracted) {
      assert.equal(chunk.start, end)
      assert.ok(chunk.duration > 0 && chunk.duration <= 500)
      end += chunk.duration
    }
    assert.equal(end, duration)
    assert.equal(extracted.length, duration <= 500 ? 1 : duration <= 980 ? 2 : 3)
  }
})

test('science ASR retries an empty provider result before caching the chunk', async t => {
  const root = await directory(t), videoPath = path.join(root, 'source.mp4')
  await fs.writeFile(videoPath, 'source video')
  let attempts = 0, extracts = 0
  const waits: number[] = [], reports: string[] = []
  const result = await transcribeScienceSource({ videoPath, videoSha256: hash('source video'), directory: root }, {
    signal: signal(), report: message => reports.push(message), sleep: async ms => { waits.push(ms) }, dependencies: {
      probe: async () => ({ duration: 90, audioStreamIndex: 1 }),
      extract: async (_video, _chunk, audio) => { extracts++; await fs.writeFile(audio, 'wav') },
      transcribe: async (_audio, duration) => ({ duration, text: ++attempts === 1 ? '' : '恢复后的转写' }),
    },
  })
  assert.equal(result, '恢复后的转写')
  assert.equal(attempts, 2)
  assert.equal(extracts, 1)
  assert.deepEqual(waits, [1500])
  assert.ok(reports.some(message => /自动重试/.test(message)))
})

test('empty ASR responses from the shared provider exhaust a bounded retry without losing previous chunks or failed audio', async t => {
  const root = await directory(t), videoPath = path.join(root, 'source.mp4')
  await fs.writeFile(videoPath, 'source video')
  const videoSha256 = hash('source video'), audioPath = path.join(root, `asr-${videoSha256.slice(0, 16)}-1.wav`)
  const calls: number[] = [], extracted: number[] = [], waits: number[] = []
  let fail = true
  const options: Parameters<typeof transcribeScienceSource>[1] = {
    signal: signal(), report: () => {}, sleep: async ms => { waits.push(ms) }, dependencies: {
      probe: async () => ({ duration: 510, audioStreamIndex: 1 }),
      extract: async (_video, chunk, audio) => { extracted.push(chunk.start); await fs.writeFile(audio, 'wav') },
      transcribe: async (audio, duration, input) => {
        calls.push(duration)
        return transcribeHistoryAudio(audio, duration, { ...input, config: { baseUrl: 'https://asr.example', apiKey: 'fixture' },
          fetchFn: async () => Response.json({ duration, text: duration === 30 && fail ? '  ' : `chunk-${duration}` }),
        })
      },
    },
  }
  const input = { videoPath, videoSha256, directory: root }
  await assert.rejects(transcribeScienceSource(input, options), /第 2\/2 段转写连续 3 次返回空文本/)
  assert.deepEqual(calls, [480, 30, 30, 30]); assert.deepEqual(extracted, [0, 480]); assert.deepEqual(waits, [1500, 3000])
  const cache = JSON.parse(await fs.readFile(path.join(root, 'transcription.json'), 'utf8'))
  assert.deepEqual(cache.chunks, [{ start: 0, duration: 480, text: 'chunk-480', provider: 'minimax', model: 'asr-1.0' }])
  assert.equal(await fs.readFile(audioPath, 'utf8'), 'wav')
  fail = false
  assert.equal(await transcribeScienceSource(input, options), 'chunk-480\n\nchunk-30')
  assert.deepEqual(calls, [480, 30, 30, 30, 30]); assert.deepEqual(extracted, [0, 480, 480])
  await assert.rejects(fs.stat(audioPath), { code: 'ENOENT' })
})

test('cancelling an empty ASR retry preserves its audio and never dispatches another request', async t => {
  const root = await directory(t), videoPath = path.join(root, 'source.mp4')
  await fs.writeFile(videoPath, 'source video')
  const videoSha256 = hash('source video'), controller = new AbortController(), reason = new Error('stop ASR retry')
  let calls = 0, extracts = 0
  await assert.rejects(transcribeScienceSource({ videoPath, videoSha256, directory: root }, {
    signal: controller.signal, report: () => {}, sleep: async (_ms, retrySignal) => { controller.abort(reason); retrySignal.throwIfAborted() }, dependencies: {
      probe: async () => ({ duration: 10, audioStreamIndex: 1 }),
      extract: async (_video, _chunk, audio) => { extracts++; await fs.writeFile(audio, 'wav') },
      transcribe: async () => { calls++; throw new EmptyAsrTranscriptionError() },
    },
  }), candidate => candidate === reason)
  assert.equal(calls, 1); assert.equal(extracts, 1)
  assert.equal(await fs.readFile(path.join(root, `asr-${videoSha256.slice(0, 16)}-0.wav`), 'utf8'), 'wav')
  await assert.rejects(fs.stat(path.join(root, 'transcription.json')), { code: 'ENOENT' })
})

test('ASR never caches truncated results or reuses results from a different video hash', async t => {
  const root = await directory(t), videoPath = path.join(root, 'source.mp4')
  await fs.writeFile(videoPath, 'new video')
  await fs.writeFile(path.join(root, 'transcription.json'), JSON.stringify({ version: 1, model: 'minimax-asr-1.0', language: '', videoSha256: hash('old video'), chunks: [{ start: 0, duration: 90, text: 'wrong cached text' }] }))
  let calls = 0
  const options: Parameters<typeof transcribeScienceSource>[1] = {
    signal: signal(), report: () => {}, dependencies: {
      probe: async () => ({ duration: 90, audioStreamIndex: 1 }),
      extract: async (_video, _chunk, audio) => { await fs.writeFile(audio, 'wav') },
      transcribe: async () => { calls++; return { duration: calls === 1 ? 10 : 90, text: 'complete new text' } },
    },
  }
  const input = { videoPath, videoSha256: hash('new video'), directory: root }
  await assert.rejects(transcribeScienceSource(input, options), /转写不完整/)
  assert.equal(await transcribeScienceSource(input, options), 'complete new text')
  assert.equal(calls, 2)
})

async function sampleVideo(file: string, audio = true) {
  await exec('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'] : []), '-t', '0.5', '-c:v', 'mpeg4',
    ...(audio ? ['-c:a', 'aac', '-shortest'] : ['-an']), file], { timeout: 30_000 })
}

test('real video assets have valid dimensions, verified content hashes and recover a corrupted cached cover', async t => {
  const root = await directory(t), videoPath = path.join(root, 'final.mp4')
  await sampleVideo(videoPath)
  const input = { videoPath, directory: path.join(root, 'upload'), title: '冰为什么浮起来', script: '冰的密度比水低。', revision: 1 }
  let generations = 0
  const options = { signal: signal(), generatePosters: async () => {
    generations++
    const landscapePath = path.join(input.directory, 'poster-landscape.jpg'), portraitPath = path.join(input.directory, 'poster-portrait.jpg')
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#101010' } }).jpeg().toFile(landscapePath)
    await sharp({ create: { width: 810, height: 1080, channels: 3, background: '#201010' } }).jpeg().toFile(portraitPath)
    return { landscapePath, portraitPath }
  } }
  const first = await prepareScienceUploadAssets(input, options)
  assert.equal(generations, 1)
  const landscape = await sharp(first.landscapePath).metadata(), portrait = await sharp(first.portraitPath).metadata()
  assert.deepEqual([landscape.format, landscape.width, landscape.height], ['jpeg', 1280, 720])
  assert.deepEqual([portrait.format, portrait.width, portrait.height], ['jpeg', 810, 1080])
  assert.match(first.videoSha256, /^[a-f0-9]{64}$/)
  const before = (await fs.stat(first.landscapePath)).mtimeMs
  const second = await prepareScienceUploadAssets(input, options)
  assert.deepEqual(second, first)
  assert.equal(generations, 1, 'a completed poster is reused, never extracted from video')
  assert.equal((await fs.stat(first.landscapePath)).mtimeMs, before)
  assert.deepEqual(await inspectScienceUploadAssets({ videoPath, landscapePath: first.landscapePath, portraitPath: first.portraitPath }, { signal: signal() }), first)
  assert.equal((await fs.stat(first.landscapePath)).mtimeMs, before)
  await fs.writeFile(first.portraitPath, 'corrupt')
  await assert.rejects(inspectScienceUploadAssets({ videoPath, landscapePath: first.landscapePath, portraitPath: first.portraitPath }, { signal: signal() }), /原上传封面无效/)
  assert.equal(await fs.readFile(first.portraitPath, 'utf8'), 'corrupt', 'Read-only inspection never repairs files already bound to an upload')
  const repaired = await prepareScienceUploadAssets(input, options)
  assert.equal((await sharp(repaired.portraitPath).metadata()).height, 1080)
  assert.equal(repaired.portraitSha256, first.portraitSha256)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(prepareScienceUploadAssets(input, { signal: controller.signal }), /abort/i)
})

test('upload preparation rejects silent video before any cover can be attached', async t => {
  const root = await directory(t), videoPath = path.join(root, 'silent.mp4')
  await sampleVideo(videoPath, false)
  await assert.rejects(prepareScienceUploadAssets({ videoPath, directory: path.join(root, 'upload'), title: '冰', script: '冰的密度低。', revision: 1 }, { signal: signal() }), /视频画面和音轨/)
  await assert.rejects(fs.stat(path.join(root, 'upload', 'upload-assets.json')))
})

test('presenter covers upgrade a legacy manifest and bind reuse to the actual presenter identity', async t => {
  const root = await directory(t), videoPath = path.join(root, 'final.mp4'), presenterPath = path.join(root, 'presenter.png')
  await sampleVideo(videoPath)
  await sharp({ create: { width: 320, height: 480, channels: 3, background: '#ffccaa' } }).png().toFile(presenterPath)
  const input = { videoPath, presenterPath, directory: path.join(root, 'upload'), title: '冰为什么浮起来', script: '冰的密度比水低。', revision: 1 }
  let generations = 0
  const options = { signal: signal(), generatePosters: async (request: { presenterPath?: string }) => {
    generations++
    assert.equal(request.presenterPath, presenterPath)
    const landscapePath = path.join(input.directory, 'landscape.jpg'), portraitPath = path.join(input.directory, 'portrait.jpg')
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#101010' } }).jpeg().toFile(landscapePath)
    await sharp({ create: { width: 810, height: 1080, channels: 3, background: '#201010' } }).jpeg().toFile(portraitPath)
    return { landscapePath, portraitPath }
  } }
  const first = await prepareScienceUploadAssets(input, options)
  const manifest = path.join(input.directory, 'upload-assets.json')
  const legacy = JSON.parse(await fs.readFile(manifest, 'utf8'))
  legacy.inputDigest = hash(JSON.stringify([first.videoSha256, input.title, input.script, '', '', input.revision]))
  delete legacy.compositionVersion
  delete legacy.presenterSha256
  await fs.writeFile(manifest, JSON.stringify(legacy))
  await prepareScienceUploadAssets(input, options)
  assert.equal(generations, 2, 'a legacy manifest must not hide the new presenter composition')
  const upgraded = JSON.parse(await fs.readFile(manifest, 'utf8'))
  assert.equal(upgraded.compositionVersion, 2)
  assert.equal(upgraded.presenterSha256, createHash('sha256').update(await fs.readFile(presenterPath)).digest('hex'))
  await prepareScienceUploadAssets(input, options)
  assert.equal(generations, 2)
  await sharp({ create: { width: 320, height: 480, channels: 3, background: '#112233' } }).png().toFile(presenterPath)
  await assert.rejects(prepareScienceUploadAssets(input, options), /新版本/)
  assert.equal(generations, 2, 'a changed identity cannot overwrite a bound cover revision')
})
