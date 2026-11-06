import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HistoryYoutubeCandidate, HistoryYoutubeCollectionOptions, HistoryYoutubeRunner } from './history-source-youtube.js'

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'history-youtube-')), 'test.db')
const { db, schema } = await import('../db/index.js')
const { parseHistoryYoutubeUrl, historyYoutubeCandidate, storeHistoryYoutubeSource, collectHistoryYoutubeVideos, downloadHistoryYoutubeVideo, refreshHistoryYoutubeSession } = await import('./history-source-youtube.js')
const { updateHistorySource, storeHistorySource, getHistorySource } = await import('./history-script-library.js')
const { downloadHistoryVideo } = await import('./history-source-pipeline.js')
const channel = 'https://www.youtube.com/@助眠睡前歷史故事/videos'
const id = 'VprFAzjTTuM'
function candidate(videoId = id): HistoryYoutubeCandidate {
  return { videoId, sourceUrl: `https://www.youtube.com/watch?v=${videoId}`, title: '秦朝亡了沒人救，漢朝亡了憑什麼還能再活兩百年？',
    authorName: '歷史大觀', durationSeconds: 5083, observedAt: new Date().toISOString(), collectionUrl: channel }
}
beforeEach(() => { db.delete(schema.historyScriptSources).run() })

test('YouTube URL validation normalizes channel handles and individual video URLs without tracking parameters', () => {
  assert.equal(decodeURI(parseHistoryYoutubeUrl(channel).url), channel)
  assert.equal(parseHistoryYoutubeUrl('https://www.youtube.com/channel/UCTAxxtcq1RRRjXM5yWsCsYg').kind, 'channel')
  for (const url of [`https://youtu.be/${id}?si=track`, `https://www.youtube.com/watch?v=${id}&list=PL0123`, `https://m.youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}`]) {
    assert.deepEqual(parseHistoryYoutubeUrl(url), { kind: 'video', videoId: id, url: `https://www.youtube.com/watch?v=${id}` })
  }
  for (const url of ['http://www.youtube.com/@history', 'https://youtube.com.evil.test/@history', 'https://evil.test/watch?v=VprFAzjTTuM',
    'https://user:pass@youtube.com/@history', 'https://www.youtube.com:123/@history', 'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/watch?v=not-valid', 'ytsearch20:history', `https://youtu.be/${id}/extra`, `https://youtube.com/shorts/${id}/extra`,
    'https://youtube.com/@foo%2fbar']) assert.throws(() => parseHistoryYoutubeUrl(url), /YouTube/)
})

test('flat YouTube metadata preserves the original title and falls back to the channel author', () => {
  const result = historyYoutubeCandidate({ id, title: candidate().title, duration: 5083, view_count: 123 },
    { channel: '歷史大觀', channel_id: 'UCTAxxtcq1RRRjXM5yWsCsYg' }, channel)!
  assert.equal(result.title, candidate().title)
  assert.equal(result.authorName, '歷史大觀')
  assert.equal(result.channelUrl, 'https://www.youtube.com/channel/UCTAxxtcq1RRRjXM5yWsCsYg')
  assert.equal(result.durationSeconds, 5083)
  assert.equal(result.viewCount, 123)
  for (const patch of [{ live_status: 'is_live' }, { live_status: 'is_upcoming' }, { availability: 'private' }, { title: '[Deleted video]' }, { id: 'invalid' }]) {
    assert.equal(historyYoutubeCandidate({ id, title: '历史', ...patch }, {}, channel), null)
  }
})

test('YouTube identity is platform-qualified and recollection never resets original text or work checkpoints', () => {
  const numericId = '12345678901'
  storeHistorySource({ sourceVideoId: numericId, title: '抖音来源', category: 'unclassified', selection: { reason: 'test', observedAt: new Date().toISOString(), comments: [] } })
  const source = storeHistoryYoutubeSource(candidate(numericId))
  updateHistorySource(source.id, { rawTranscript: '已转录正文', mediaJson: '{"videoSha256":"saved"}', status: 'transcribed' })
  const again = storeHistoryYoutubeSource({ ...candidate(numericId), title: '频道修改后的标题' })
  assert.equal(again.id, source.id)
  assert.equal(again.platform, 'youtube')
  assert.equal(again.title, candidate().title)
  assert.equal(again.rawTranscript, '已转录正文')
  assert.equal(again.mediaJson, '{"videoSha256":"saved"}')
  assert.equal(db.select().from(schema.historyScriptSources).all().length, 2)
})

function collection(overrides: Partial<HistoryYoutubeCollectionOptions> = {}): HistoryYoutubeCollectionOptions {
  return { url: channel, signal: new AbortController().signal, targetCount: 1, isKnownVideo: () => false,
    isTargetReached: () => false, onCandidate: async () => {}, report: () => {}, ...overrides }
}

test('channel and individual collection request Chinese metadata instead of English localized titles', async () => {
  for (const url of [channel, `https://youtu.be/${id}`]) {
    const collected: HistoryYoutubeCandidate[] = []
    await collectHistoryYoutubeVideos(collection({ url, onCandidate: async value => { collected.push(value) } }), async args => {
      const language = args[args.indexOf('--extractor-args') + 1]
      const metadata = { id, title: language === 'youtube:lang=zh-CN' ? candidate().title : 'Why did the Han dynasty last another two hundred years?' }
      return { stdout: JSON.stringify(url === channel ? { entries: [metadata] } : metadata) }
    })
    assert.equal(collected[0]?.title, candidate().title)
  }
})

test('channel collection pages past known sources and stops as soon as the consumer has a successful draft', async () => {
  const firstPage = Array.from({ length: 30 }, (_, index) => ({ id: `video${String(index).padStart(6, '0')}`, title: '旧来源' }))
  const calls: string[][] = [], collected: HistoryYoutubeCandidate[] = []
  const runner: HistoryYoutubeRunner = async args => {
    calls.push(args)
    return { stdout: JSON.stringify({ channel: '歷史大觀', entries: calls.length === 1 ? firstPage : [{ id, title: candidate().title }, { id: 'bwbQOdW5Cv8', title: '不应继续' }] }) }
  }
  await collectHistoryYoutubeVideos(collection({
    isKnownVideo: videoId => firstPage.some(item => item.id === videoId),
    isTargetReached: () => collected.length >= 1,
    onCandidate: async value => { collected.push(value) },
  }), runner)
  assert.equal(calls.length, 2)
  assert.ok(calls[0]!.includes('1:30'))
  assert.ok(calls[1]!.includes('31:60'))
  assert.deepEqual(collected.map(item => item.videoId), [id])
  assert.equal(collected[0]!.authorName, '歷史大觀')
})

test('collection errors cannot turn into successful empty results, and a stopped job never reads another page', async () => {
  await assert.rejects(collectHistoryYoutubeVideos(collection(), async () => ({ stdout: 'not json' })), /元数据无效/)
  await assert.rejects(collectHistoryYoutubeVideos(collection(), async () => ({ stdout: '{}' })), /视频列表/)
  await assert.rejects(collectHistoryYoutubeVideos(collection({ url: `https://youtu.be/${id}` }),
    async () => ({ stdout: JSON.stringify({ id: 'bwbQOdW5Cv8', title: 'Wrong video' }) })), /ID 与输入链接不一致/)
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(collectHistoryYoutubeVideos(collection({ signal: controller.signal, onCandidate: async () => { controller.abort(new Error('stop')) } }), async () => {
    calls++; return { stdout: JSON.stringify({ entries: [{ id, title: '历史' }, { id: 'bwbQOdW5Cv8', title: 'next' }] }) }
  }), /stop/)
  assert.equal(calls, 1)
})

test('individual collection reports exhaustion and avoids a known deleted or failed source', async () => {
  const stages: string[] = []
  await collectHistoryYoutubeVideos(collection({ url: `https://youtu.be/${id}`, isKnownVideo: () => true,
    onCandidate: async () => assert.fail('Known sources must be retried explicitly'), report: event => stages.push(event.stage) }),
  async args => {
    assert.ok(args.includes('--no-playlist'))
    return { stdout: JSON.stringify({ id, title: '原标题', duration: 90 }) }
  })
  assert.ok(stages.includes('skipping'))
  assert.equal(stages.at(-1), 'exhausted')
})

test('the YouTube collector reports the caller-specific production-window reason and has no popularity or duration threshold', async () => {
  const reasons: string[] = [], accepted: string[] = []
  await collectHistoryYoutubeVideos(collection({
    isKnownVideo: videoId => videoId === id,
    knownVideoReason: () => '最近 15 天已有成功交付的成片，跳过重复生产',
    onCandidate: async value => {accepted.push(value.videoId)},
    report: event => {if (event.candidate?.reason) reasons.push(event.candidate.reason)},
  }), async () => ({stdout: JSON.stringify({entries: [{id, title: '已生产'}, {id: 'bwbQOdW5Cv8', title: '普通视频', duration: 5, view_count: 0}]})}))
  assert.deepEqual(accepted, ['bwbQOdW5Cv8'])
  assert.match(reasons[0]!, /最近 15 天/)
})

test('YouTube downloads compressed audio with only a low-resolution fallback and reuses a matching file', async () => {
  const source = storeHistoryYoutubeSource(candidate())
  const directory = mkdtempSync(join(tmpdir(), 'history-youtube-download-'))
  const target = join(directory, 'source.mp4')
  let calls = 0
  const runner: HistoryYoutubeRunner = async args => {
    calls++
    assert.equal(args.at(-1), source.sourceUrl)
    assert.ok(args.includes('--no-playlist'))
    assert.ok(args.includes('--extract-audio'))
    assert.equal(args[args.indexOf('--audio-format') + 1], 'm4a')
    const format = args[args.indexOf('--format') + 1]!
    assert.equal(format, 'bestaudio[ext=m4a]/bestaudio/worst[height<=360][acodec!=none]')
    assert.equal(args.includes('--merge-output-format'), false)
    const template = args[args.indexOf('--output') + 1]!
    await writeFile(template.replace('%(ext)s', 'm4a'), 'downloaded bytes')
    return { stdout: '' }
  }
  const media = await downloadHistoryYoutubeVideo(source, target, {}, () => {}, { runner })
  assert.equal(media.downloadState, 'done')
  assert.equal(media.downloadKind, 'audio')
  assert.equal(media.videoSha256, createHash('sha256').update('downloaded bytes').digest('hex'))
  assert.equal(await readFile(target, 'utf8'), 'downloaded bytes')
  assert.deepEqual(await downloadHistoryYoutubeVideo(source, target, media, () => {}, { runner }), media)
  assert.equal(calls, 1)
  await writeFile(target, 'corrupt')
  await downloadHistoryYoutubeVideo(source, target, media, () => {}, { runner })
  assert.equal(calls, 2)
})

test('disk reserve blocks a new YouTube transfer but still permits a verified local checkpoint', async () => {
  const source = storeHistoryYoutubeSource(candidate())
  const directory = mkdtempSync(join(tmpdir(), 'history-youtube-space-')), target = join(directory, 'source.mp4')
  const previous = process.env.MEDIA_DISK_RESERVE_GIB
  process.env.MEDIA_DISK_RESERVE_GIB = '1000000000'
  const runner: HistoryYoutubeRunner = async () => assert.fail('low disk space must not start a transfer')
  try {
    await assert.rejects(downloadHistoryYoutubeVideo(source, target, {}, () => {}, { runner }), { code: 'MEDIA_DISK_FULL' })
    await writeFile(target, 'verified audio')
    const media = { videoPath: target, videoSha256: createHash('sha256').update('verified audio').digest('hex') }
    assert.deepEqual(await downloadHistoryYoutubeVideo(source, target, media, () => {}, { runner }), media)
  } finally {
    if (previous === undefined) delete process.env.MEDIA_DISK_RESERVE_GIB
    else process.env.MEDIA_DISK_RESERVE_GIB = previous
  }
})

test('failed or canceled downloads keep partial data for retry but cannot checkpoint a complete video', async () => {
  const source = storeHistoryYoutubeSource(candidate())
  const directory = mkdtempSync(join(tmpdir(), 'history-youtube-cancel-'))
  const target = join(directory, 'source.mp4')
  const partial = join(directory, `source.youtube.${id}.mp4.part`)
  const states: string[] = []
  const controller = new AbortController()
  await assert.rejects(downloadHistoryYoutubeVideo(source, target, {}, patch => { states.push(patch.downloadState!) }, { signal: controller.signal, runner: async () => {
    await writeFile(partial, 'resume bytes')
    controller.abort(new Error('stop'))
    controller.signal.throwIfAborted()
    return { stdout: '' }
  } }), /stop/)
  assert.deepEqual(states, ['running', 'cancelled'])
  assert.equal(await readFile(partial, 'utf8'), 'resume bytes')
  await assert.rejects(downloadHistoryYoutubeVideo(source, target, {}, () => {}, { runner: async () => ({ stdout: '' }) }), /未生成完整的音频/)
})

test('the existing download entry point dispatches YouTube without requiring the Douyin downloader', async () => {
  const source = storeHistoryYoutubeSource(candidate())
  const directory = mkdtempSync(join(tmpdir(), 'history-youtube-dispatch-'))
  const binary = join(directory, 'fake-ytdlp')
  writeFileSync(binary, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.writeFileSync(args[args.indexOf('--output') + 1].replace('%(ext)s', 'm4a'), 'youtube bytes');\n`, { mode: 0o700 })
  const previous = process.env.HISTORY_YOUTUBE_YTDLP_BIN
  process.env.HISTORY_YOUTUBE_YTDLP_BIN = binary
  try {
    const media = await downloadHistoryVideo(source, join(directory, 'source.mp4'), {}, () => {}, {
      fetchFn: async () => assert.fail('YouTube must not call the Douyin download API'),
    })
    assert.equal(media.downloadState, 'done')
    assert.equal(await readFile(media.videoPath!, 'utf8'), 'youtube bytes')
    assert.equal(getHistorySource(source.id)!.sourceVideoId, id)
  } finally {
    if (previous === undefined) delete process.env.HISTORY_YOUTUBE_YTDLP_BIN
    else process.env.HISTORY_YOUTUBE_YTDLP_BIN = previous
  }
})

test('missing browser cookies retry anonymously while retaining the proxy for collection and download', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-youtube-proxy-'))
  const binary = join(directory, 'fake-ytdlp')
  const attempts = join(directory, 'attempts.jsonl')
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(args) + '\\n');
if (args.includes('--cookies-from-browser')) {
  process.stderr.write('ERROR: could not find chrome cookies database in "/unavailable/Chrome"');
  process.exit(1);
}
if (args.includes('--output')) fs.writeFileSync(args[args.indexOf('--output') + 1].replace('%(ext)s', 'm4a'), 'youtube bytes');
else process.stdout.write(JSON.stringify({ entries: [{ id: '${id}', title: '历史' }] }));
`, { mode: 0o700 })
  const keys = ['HISTORY_YOUTUBE_YTDLP_BIN', 'HISTORY_YOUTUBE_PROXY', 'HISTORY_YOUTUBE_COOKIES_BROWSER', 'HISTORY_YOUTUBE_COOKIES_FILE'] as const
  const previous = keys.map(key => process.env[key])
  Object.assign(process.env, { HISTORY_YOUTUBE_YTDLP_BIN: binary, HISTORY_YOUTUBE_PROXY: 'http://127.0.0.1:7897', HISTORY_YOUTUBE_COOKIES_BROWSER: 'chrome' })
  delete process.env.HISTORY_YOUTUBE_COOKIES_FILE
  try {
    const collected: HistoryYoutubeCandidate[] = []
    await collectHistoryYoutubeVideos(collection({ onCandidate: async value => { collected.push(value) } }))
    assert.equal(collected[0]?.videoId, id)
    const media = await downloadHistoryYoutubeVideo(storeHistoryYoutubeSource(candidate()), join(directory, 'source.mp4'), {}, () => {})
    assert.equal(media.downloadState, 'done')
    const calls: string[][] = (await readFile(attempts, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.length, 4)
    for (const args of calls) assert.equal(args[args.indexOf('--proxy') + 1], 'http://127.0.0.1:7897')
    assert.deepEqual(calls.map(args => args.includes('--cookies-from-browser')), [true, false, true, false])
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
  }
})

test('YouTube login refresh checks an individual video with the same cookie file and proxy, not just a channel playlist', async () => {
  const keys = ['HISTORY_YOUTUBE_PROXY', 'HISTORY_YOUTUBE_COOKIES_FILE', 'HISTORY_YOUTUBE_COOKIES_BROWSER'] as const
  const previous = keys.map(key => process.env[key])
  Object.assign(process.env, { HISTORY_YOUTUBE_PROXY: 'http://127.0.0.1:7897', HISTORY_YOUTUBE_COOKIES_FILE: '/private/test-youtube-cookies.txt', HISTORY_YOUTUBE_COOKIES_BROWSER: 'chrome:Default' })
  let exported = false, probed = false
  try {
    const result = await refreshHistoryYoutubeSession(candidate().sourceUrl, {
      exportCookies: async (output, browser) => {
        assert.equal(output, '/private/test-youtube-cookies.txt')
        assert.equal(browser, 'chrome:Default')
        exported = true
      },
      runner: async args => {
        assert.equal(exported, true)
        assert.equal(args[args.indexOf('--cookies') + 1], '/private/test-youtube-cookies.txt')
        assert.equal(args[args.indexOf('--proxy') + 1], 'http://127.0.0.1:7897')
        assert.ok(args.includes('--simulate'))
        assert.ok(args.includes('--no-playlist'))
        assert.equal(args.includes('--flat-playlist'), false)
        assert.equal(args.at(-1), candidate().sourceUrl)
        probed = true
        return { stdout: id }
      },
    })
    assert.equal(probed, true)
    assert.match(result.message, /检测通过/)
    await assert.rejects(refreshHistoryYoutubeSession(channel), /一条.*视频/)
    await assert.rejects(refreshHistoryYoutubeSession(candidate().sourceUrl, {
      exportCookies: async () => {}, runner: async () => { throw new Error('Sign in to confirm you’re not a bot') },
    }), /not a bot/)
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
  }
})

test('a real yt-dlp login rejection has a recovery code while unrelated cookie configuration errors remain ordinary errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-youtube-login-'))
  const binary = join(directory, 'fake-ytdlp')
  writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write('ERROR: Sign in to confirm you are not a bot. Use --cookies-from-browser or --cookies'); process.exit(1);\n`, { mode: 0o700 })
  const previous = process.env.HISTORY_YOUTUBE_YTDLP_BIN
  process.env.HISTORY_YOUTUBE_YTDLP_BIN = binary
  try {
    await assert.rejects(collectHistoryYoutubeVideos(collection()), error => {
      assert.equal((error as { code?: string }).code, 'youtube_login_required')
      assert.match((error as Error).message, /采集已暂停/)
      return true
    })
    writeFileSync(binary, `#!${process.execPath}\nprocess.stderr.write('ERROR: invalid --cookies-from-browser configuration'); process.exit(1);\n`, { mode: 0o700 })
    await assert.rejects(collectHistoryYoutubeVideos(collection()), error => {
      assert.notEqual((error as { code?: string }).code, 'youtube_login_required')
      return true
    })
  } finally {
    if (previous === undefined) delete process.env.HISTORY_YOUTUBE_YTDLP_BIN
    else process.env.HISTORY_YOUTUBE_YTDLP_BIN = previous
  }
})

test('background Chrome access denial can reuse a verified exported session, but cannot claim success for a blocked one', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'history-youtube-saved-session-'))
  const output = join(directory, 'cookies.txt')
  writeFileSync(output, '# test session metadata only')
  const previous = process.env.HISTORY_YOUTUBE_COOKIES_FILE
  process.env.HISTORY_YOUTUBE_COOKIES_FILE = output
  const exportCookies = async () => { throw new Error('Chrome access denied') }
  try {
    const result = await refreshHistoryYoutubeSession(candidate().sourceUrl, { exportCookies, runner: async args => {
      assert.equal(args[args.indexOf('--cookies') + 1], output)
      return { stdout: id }
    } })
    assert.match(result.message, /已保存.*检测/)
    assert.doesNotMatch(result.message, /登录已刷新/)
    await assert.rejects(refreshHistoryYoutubeSession(candidate().sourceUrl, { exportCookies,
      runner: async () => { throw new Error('Sign in to confirm you are not a bot') },
    }), /后台无法读取.*通过终端导出/)
  } finally {
    if (previous === undefined) delete process.env.HISTORY_YOUTUBE_COOKIES_FILE
    else process.env.HISTORY_YOUTUBE_COOKIES_FILE = previous
  }
})
