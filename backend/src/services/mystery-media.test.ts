import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { downloadMysterySource, transcribeMysterySource } from './mystery-media.js'
import type { SourceMedia } from './history-source-pipeline.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'mystery-media-'))
process.env.DB_PATH = path.join(root, 'test.db')
after(() => fs.rm(root, { recursive: true, force: true }))
const { downloadHistoryYoutubeVideo } = await import('./history-source-youtube.js')
const exec = promisify(execFile), hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const signal = () => new AbortController().signal
const source = { platform: 'youtube', sourceVideoId: 'abcdefghijk', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }

test('full video downloads use a distinct checkpoint, validate actual picture and sound and preserve old audio default', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'video-'))
  const fixture = path.join(directory, 'fixture.mp4')
  await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=0.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', fixture], { timeout: 30_000 })
  let calls = 0
  const runner = async (args: string[]) => {
    calls++
    assert.ok(args.includes('--merge-output-format'))
    assert.equal(args[args.indexOf('--max-filesize') + 1], '4G')
    assert.match(args[args.indexOf('--format') + 1]!, /height<=720/)
    assert.equal(args.includes('--extract-audio'), false)
    await fs.copyFile(fixture, args[args.indexOf('--output') + 1]!.replace('%(ext)s', 'mp4'))
    return { stdout: '' }
  }
  const target = path.join(directory, 'source.mp4')
  const media = await downloadHistoryYoutubeVideo(source, target, {}, () => {}, { mode: 'video', runner })
  assert.equal(media.downloadKind, 'video')
  assert.equal(media.downloadId, 'youtube:abcdefghijk:video')
  assert.deepEqual(await downloadHistoryYoutubeVideo(source, target, media, () => {}, { mode: 'video', runner }), media)
  assert.equal(calls, 1)
  await downloadHistoryYoutubeVideo(source, target, media, () => {}, { runner: async args => {
    assert.ok(args.includes('--extract-audio'))
    assert.equal(args[args.indexOf('--max-filesize') + 1], '256M')
    await fs.writeFile(args[args.indexOf('--output') + 1]!.replace('%(ext)s', 'm4a'), 'audio-only')
    return { stdout: '' }
  } })
  assert.equal(await fs.readFile(target, 'utf8'), 'audio-only', 'video-mode checkpoint is never silently reused for audio-mode request')
})

test('an audio file named MP4 cannot satisfy full video mode', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'audio-fake-')), fixture = path.join(directory, 'audio.m4a')
  await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-c:a', 'aac', fixture], { timeout: 30_000 })
  const states: string[] = []
  await assert.rejects(downloadHistoryYoutubeVideo(source, path.join(directory, 'source.mp4'), {}, patch => { states.push(patch.downloadState!) },
    { mode: 'video', runner: async args => {
      await fs.copyFile(fixture, args[args.indexOf('--output') + 1]!.replace('%(ext)s', 'mp4'))
      return { stdout: '' }
    } }), /包含画面和音轨/)
  assert.deepEqual(states, ['running', 'failed'])
  await assert.rejects(fs.access(path.join(directory, 'source.mp4')))
})

test('mystery source metadata and mode persist across download retry, retaining original media after ASR', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'metadata-'))
  let collections = 0, attempts = 0
  const options: Parameters<typeof downloadMysterySource>[1] = { signal: signal(), report: () => {}, onMedia: () => {}, dependencies: {
    collect: async options => {
      collections++
      await options.onCandidate({ videoId: source.sourceVideoId, sourceUrl: source.sourceUrl, title: '失踪的钥匙', authorName: '原频道',
        observedAt: '', collectionUrl: source.sourceUrl })
    },
    download: async (_source, target, _media, checkpoint, request) => {
      attempts++
      assert.equal(request?.mode, 'audio')
      assert.equal(path.extname(target), '.m4a')
      if (attempts === 1) { checkpoint({ downloadState: 'failed' }); throw new Error('network stopped') }
      await fs.writeFile(target, 'source audio')
      return { downloadKind: 'audio', downloadState: 'done', videoPath: target, videoSha256: hash('source audio') }
    },
  } }
  const input = { sourceUrl: source.sourceUrl, directory, media: {}, mode: 'audio' as const }
  await assert.rejects(downloadMysterySource(input, options), /network stopped/)
  const result = await downloadMysterySource(input, options)
  assert.equal(collections, 1)
  assert.equal(result.title, '失踪的钥匙')
  assert.equal(result.media.downloadKind, 'audio')
  const transcript = await transcribeMysterySource({ directory, videoPath: result.media.videoPath!, videoSha256: result.media.videoSha256! },
    { signal: signal(), report: () => {}, dependencies: {
      probe: async () => ({ duration: 50, audioStreamIndex: 0 }),
      extract: async (_video, _chunk, target) => { await fs.writeFile(target, 'chunk') },
      transcribe: async (_audio, duration) => ({ text: '那把钥匙可能留在门口，谁也不能确定。', duration }),
    } })
  assert.deepEqual(transcript.chunks, [{ start: 0, duration: 50, text: transcript.text }])
  assert.equal(await fs.readFile(result.media.videoPath!, 'utf8'), 'source audio')
})

test('long source ASR resumes completed chunks and exposes only honest source block timestamps', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'transcribe-')), videoPath = path.join(directory, 'source.mp4')
  await fs.writeFile(videoPath, 'long video')
  let calls = 0, extracts = 0
  const reports: string[] = []
  const options: Parameters<typeof transcribeMysterySource>[1] = { signal: signal(), report: message => reports.push(message), dependencies: {
    probe: async () => ({ duration: 850, audioStreamIndex: 1 }),
    extract: async (_video, _chunk, target) => { extracts++; await fs.writeFile(target, 'chunk') },
    transcribe: async (_audio, duration) => {
      calls++
      if (calls === 2) throw new Error('temporary network')
      return { text: calls === 1 ? '他在门口等了很久。' : '直到天亮，门依然没开。', duration }
    },
  } }
  const input = { directory, videoPath, videoSha256: hash('long video') }
  await assert.rejects(transcribeMysterySource(input, options), /temporary network/)
  const result = await transcribeMysterySource(input, options)
  assert.equal(calls, 3)
  assert.equal(extracts, 3)
  assert.deepEqual(result.chunks.map(chunk => [chunk.start, chunk.duration]), [[0, 480], [480, 370]])
  assert.equal(result.text, '他在门口等了很久。\n\n直到天亮，门依然没开。')
  assert.ok(reports.some(message => message.includes('已恢复第 1/2')))
  assert.equal(await fs.readFile(videoPath, 'utf8'), 'long video')
})

