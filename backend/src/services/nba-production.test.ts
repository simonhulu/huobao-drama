import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { prepareNbaPoster } from './nba-cover-poster.js'
import { NBA_DEFAULT_SETTINGS, type NbaArticle, type NbaGame, type NbaMedia, type NbaProductionInput, type NbaScript, type NbaTopic } from './nba-types.js'
import { buildNbaInterviewTiming, buildNbaTiming, buildNbaTopicTiming, createNbaProducer, ensureNbaDeliveryCover, isNbaInterviewSource, loadNbaSharedMedia, matchNbaYoutubeMetadata, nbaContentFingerprint, nbaGameFingerprint, nbaProductionFingerprint,
  nbaSpokenText, nbaYoutubeVideoId, normalizeNbaAsr, parseNbaSilences, runNbaCommand, selectedNbaYoutubeAudio, validateNbaScript } from './nba-production.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function mockAudioPcm(args: string[]) {
  if (!args.includes('-t')) return Buffer.alloc(4800)
  const rate = Number(args[args.indexOf('-ar') + 1]), channels = Number(args[args.indexOf('-ac') + 1])
  const duration = Number(args[args.indexOf('-t') + 1]), start = Number(args[args.indexOf('-ss') + 1])
  const filename = args[args.indexOf('-i') + 1], isVoice = path.basename(filename).startsWith('voice-')
  const pcm = Buffer.alloc(Math.round(duration * rate * channels) * 4)
  for (let frame = 0; frame < pcm.length / channels / 4; frame++) {
    const time = start + frame / rate - (isVoice ? 0 : .12)
    const seed = Math.imul(Math.floor(time * 8000 + .0001) + 1, 1640531527)
    const value = time < 0 ? 0 : ((seed >>> 0) / 0xffffffff - .5) * .16
    for (let channel = 0; channel < channels; channel++) pcm.writeFloatLE(value, (frame * channels + channel) * 4)
  }
  return pcm
}
const game: NbaGame = { id: 'espn-401909907', tipoffUtc: '2026-11-03T00:00:00.000Z', localDate: '2026-11-02', localTimezone: 'America/New_York',
  home: { name: 'Cleveland Cavaliers', abbreviation: 'CLE', score: 112 }, away: { name: 'Oklahoma City Thunder', abbreviation: 'OKC', score: 117 }, verified: true, evidenceUrls: ['https://www.espn.com/nba/game/_/gameId/401909907'] }
const metadata = { id: 'vDdPLHaKK4k', title: 'Shai Gilgeous-Alexander TAKES OVER | November 2, 2026',
  description: 'Oklahoma City Thunder defeated the Cleveland Cavaliers 117-112.', channel_id: 'UCWJ2lWNubArHWmf3FIHbfcQ', upload_date: '20261103' }
const body = ['Shai Gilgeous-Alexander scored 43 points as Oklahoma City defeated Cleveland 117-112. The Thunder recovered in the final quarter and scored enough to win the game.',
  'The Cavaliers had an opportunity to take the lead late, but missed their attempt. The Thunder stayed in front and completed the road victory.'].join('\n\n')
const article: NbaArticle = { id: 'article-test', url: 'https://example.test/article', title: 'Thunder win in Cleveland', language: 'en', publisher: 'Example News',
  body, bodyHash: digest(body), wordCount: body.split(/\s/).length, characterCount: body.length, collectedAt: '2026-11-04T01:00:00.000Z', game }
const sentences = ['亚历山大拿下四十三分，带领雷霆在客场以一百一十七比一百一十二击败骑士，球队在最后一节重新掌握比赛主动。',
  '骑士在比赛末段曾经得到反超机会，但关键一投没有命中，雷霆守住了领先优势，最终完成了这场客场胜利。',
  '两队直到最后时刻仍在争夺比赛胜负，雷霆凭借末段的得分和防守保持优势，让骑士最后阶段的追赶没有改变最终结果。']
const script: NbaScript = { title: '雷霆末节守住胜利', text: sentences.join(''), facts: sentences.map((claim, index) => ({ claim, paragraph: index ? 2 : 1 })) }
const makeMedia = (filename: string): NbaMedia => ({ id: metadata.id, gameId: game.id, sourceUrl: `https://www.youtube.com/watch?v=${metadata.id}`, path: filename,
  duration: 258.341417, fps: 60000 / 1001, width: 1920, height: 1080, sha256: digest('video-fixture'), liveEndSeconds: 190, closingStartSeconds: 254.33,
  verified: true, verificationNotes: ['Manually checked complete possession and natural ending'] })

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-production-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const patches: Array<Record<string, unknown>> = []
  const input: NbaProductionInput = { job: { id: 'job-test', title: article.title, article: { ...article }, game,
    status: 'running', stage: 'intake', message: '', createdAt: article.collectedAt, updatedAt: article.collectedAt, attempts: 1, canResume: true, logs: [] },
  jobDir: path.join(root, 'jobs/job-test'), sharedDir: path.join(root, 'shared'), signal: new AbortController().signal, settings: { ...NBA_DEFAULT_SETTINGS },
  onProgress: () => {}, checkpoint: patch => { patches.push(patch) } }
  return { root, input, patches }
}

test('official metadata must prove both teams and an explicit game date, not its upload date', () => {
  assert.equal(matchNbaYoutubeMetadata(metadata, game).matched, true)
  assert.equal(matchNbaYoutubeMetadata({ ...metadata, title: 'THUNDER at CAVALIERS | FULL GAME HIGHLIGHTS | November 2, 2026', description: 'Never miss a moment with the NBA.' }, game).matched, true)
  assert.equal(matchNbaYoutubeMetadata({ ...metadata, title: 'Shai highlights' }, game).matched, false)
  assert.equal(matchNbaYoutubeMetadata({ ...metadata, channel_id: 'fan-channel' }, game).matched, false)
  assert.equal(matchNbaYoutubeMetadata({ ...metadata, description: 'Thunder win 120-110' }, game).matched, false)
  assert.equal(matchNbaYoutubeMetadata({ ...metadata, description: 'Thunder play 117-112' }, game).matched, false)
  assert.equal(matchNbaYoutubeMetadata({ ...metadata, title: 'Thunder vs Cavaliers 2026-11-03', description: 'Final 117-112' }, game).matched, true)
  assert.equal(matchNbaYoutubeMetadata({ ...metadata, title: 'Thunder vs Cavaliers November 4, 2026' }, game).matched, false)
})

test('the downloaded info JSON verifies the selected English audio even when yt-dlp removes requested_formats', () => {
  const formats = [{ format_id: '299', vcodec: 'avc1', acodec: 'none' }, { format_id: '251-20', vcodec: 'none', acodec: 'opus', language: 'en-US' },
    { format_id: '251-1', vcodec: 'none', acodec: 'opus', language: 'zh-CN' }]
  assert.equal(selectedNbaYoutubeAudio({ format_id: '299+251-20', formats })?.language, 'en-US')
  assert.equal(selectedNbaYoutubeAudio({ format_id: '299+251-1', formats })?.language, 'zh-CN')
  assert.equal(selectedNbaYoutubeAudio({ format_id: '299', formats }), undefined)
  assert.equal(selectedNbaYoutubeAudio({ format_id: '299+unknown', formats }), undefined)
  assert.equal(selectedNbaYoutubeAudio({ requested_downloads: [{ requested_formats: [formats[0], formats[1]] }] })?.language, 'en-US')
  assert.equal(selectedNbaYoutubeAudio({ format_id: '301-21', formats: [{ format_id: '301-21', vcodec: 'avc1', acodec: 'mp4a.40.2', language: 'en-US' }] })?.language, 'en-US')
})

test('equivalent YouTube URLs and equivalent UTC timestamps share identities', () => {
  assert.equal(nbaYoutubeVideoId('https://youtu.be/vDdPLHaKK4k?t=20'), metadata.id)
  assert.equal(nbaYoutubeVideoId('https://www.youtube.com/watch?v=vDdPLHaKK4k&list=other'), metadata.id)
  assert.equal(nbaYoutubeVideoId('https://example.test/watch?v=vDdPLHaKK4k'), undefined)
  assert.equal(nbaYoutubeVideoId('http://youtube.com/watch?v=vDdPLHaKK4k'), undefined)
  assert.equal(nbaGameFingerprint(game), nbaGameFingerprint({ ...game, tipoffUtc: '2026-11-03T00:00Z' }))
  assert.notEqual(nbaGameFingerprint(game), nbaGameFingerprint({ ...game, home: { ...game.home, score: 113 } }))
})

test('translation accepts Chinese text without requiring factual paragraph mapping', () => {
  assert.deepEqual(validateNbaScript(script, article), script)
  assert.deepEqual(validateNbaScript({ title: script.title, text: script.text }, article), { title: script.title, text: script.text, facts: [] })
  assert.doesNotThrow(() => validateNbaScript({ ...script, facts: [{ claim: script.text, paragraph: 99 }] }, article))
  assert.throws(() => validateNbaScript({ title: 'Empty', text: '' }, article))
})

test('timing uses each source fps and approved cuts and leaves four seconds after speech', () => {
  for (const fps of [25, 30, 60000 / 1001]) {
    const media = { ...makeMedia('/unused.mp4'), fps, duration: 250, liveEndSeconds: 200, closingStartSeconds: 246 }
    const timing = buildNbaTiming(media, 73.25)
    assert.ok(timing.sourceStart >= 0)
    assert.ok(Math.abs(timing.sourceEnd - 200) < 1 / fps)
    assert.ok(timing.transitionStart >= timing.speechEnd + .3)
    assert.ok(timing.afterNarrationSeconds > 4 && timing.afterNarrationSeconds < 4.6)
    assert.equal(timing.frameCount, timing.bodyFrames + timing.closingFrames - timing.overlapFrames)
  }
  assert.throws(() => buildNbaTiming({ ...makeMedia('/unused.mp4'), verified: false }, 20), /尚未核验/)
  assert.throws(() => buildNbaTiming({ ...makeMedia('/unused.mp4'), liveEndSeconds: 10 }, 30), /可用长度不足/)
})

test('spoken numbers and Whisper split digits normalize together, with bounded timestamps', () => {
  assert.equal(nbaSpokenText('比分117-112，命中率42.5%。'), '比分一百一十七比一百一十二，命中率百分之四十二点五。')
  const normalized = normalizeNbaAsr({ transcription: [{ text: '117比112。', offsets: { from: 0, to: 9999 }, tokens: [
    { text: '11', offsets: { from: 0, to: 100 } }, { text: '7', offsets: { from: 100, to: 200 } },
    { text: '比', offsets: { from: 200, to: 300 } }, { text: '112', offsets: { from: 300, to: 9999 } },
  ] }] }, 1)
  assert.equal(normalized.transcription[0].tokens[0].text, '一百一十七')
  assert.equal(normalized.transcription[0].tokens.at(-1).offsets.to, 1000)
  assert.deepEqual(parseNbaSilences('silence_start: 1\nsilence_end: 1.5\nsilence_start: 2', 3), [
    { start: 1, end: 1.5, duration: .5 }, { start: 2, end: 3, duration: 1 },
  ])
})

test('narration omits publisher datelines and trailing campaign tags while preserving reporting', () => {
  const original = '直播吧11月3日讯 NBA常规赛，勇士116-113太阳。#勇士五连胜#里的这场逆转很精彩。#观点创作激励赛# #NBA#'
  assert.equal(nbaSpokenText(original), '十一月三日，NBA常规赛，勇士一百一十六比一百一十三太阳。勇士五连胜里的这场逆转很精彩。')
  assert.equal(nbaSpokenText('球迷喊出“NBA”！'), '球迷喊出“NBA”！')
  assert.equal(nbaSpokenText('东契奇突破得分。\n\n图片来源于网络\n\n热火请求暂停。\n图源：网络，侵删'), '东契奇突破得分。 热火请求暂停。')
  assert.equal(nbaSpokenText('球迷说图片来源于网络很常见。'), '球迷说图片来源于网络很常见。')
})

test('delivery fingerprints include the article, script, media and every user audio setting', () => {
  const job = { article, game, script, media: makeMedia('/unused.mp4') }, settings = { ...NBA_DEFAULT_SETTINGS }
  const base = nbaProductionFingerprint(job, settings)
  for (const patch of [{ speed: 1.2 }, { voice: 'other' }, { originalGain: .2 }, { arenaGain: .7 }]) assert.notEqual(nbaProductionFingerprint(job, { ...settings, ...patch }), base)
  assert.notEqual(nbaProductionFingerprint({ ...job, article: { ...article, body: body + ' changed' } }, settings), base)
  assert.notEqual(nbaProductionFingerprint(job, settings, digest('new arena')), nbaProductionFingerprint(job, settings, digest('old arena')))
  assert.notEqual(nbaProductionFingerprint({ ...job, media: { ...job.media, sourceUrl: 'https://youtube.com/watch?v=abcdefghijk' } }, settings), base)
})

const topic: NbaTopic = { id: 'youtube-vDdPLHaKK4k', videoId: metadata.id, youtubeUrl: `https://www.youtube.com/watch?v=${metadata.id}`,
  title: 'A player talks about training at media day', description: 'The player discusses training and the upcoming season.' }

test('source titles identify player interviews without applying interview endings to highlights', () => {
  for (const title of ['Tyler Herro Talks Milwaukee Homecoming, Building a New Culture & More at Bucks Media Day',
    'Luka Dončić On His HISTORIC Scoring Run After Another 40-Point Night | November 2, 2026',
    'LeBron James on Why He Chose Philly, His New Teammates & Life Lessons at 76ers Media Day',
    'Postgame Press Conference', '东契奇赛后采访']) assert.equal(isNbaInterviewSource({ title }), true, title)
  for (const title of ['SUNS at WARRIORS | FULL GAME HIGHLIGHTS | November 2, 2026',
    'Luka Dončić Joins History with 4th 40-PT Game of the Season vs Heat',
    'Luka Dončić On His Game | SCORING HIGHLIGHTS', 'Top 10 Plays', 'Inside the Game with JJ Redick']) assert.equal(isNbaInterviewSource({ title }), false, title)
  assert.equal(isNbaInterviewSource(), false)
})

test('interview timing fades after the complete sentence and ends on the source tail across frame rates', () => {
  for (const fps of [25, 30, 60000 / 1001]) {
    const media = { ...makeMedia('/unused.mp4'), fps, duration: 24 }
    for (const voiceDuration of [8, 38]) {
      const timing = buildNbaInterviewTiming(media, voiceDuration)
      assert.equal(timing.loopSource, voiceDuration === 38)
      assert.ok(timing.sourceStart >= 0 && timing.sourceStart < media.duration)
      assert.ok(timing.afterNarrationSeconds >= 1.1 && timing.afterNarrationSeconds < 1.1 + 1 / fps)
      assert.ok(timing.videoFadeStart > timing.speechEnd && timing.audioFadeStart > timing.speechEnd)
      if (!timing.loopSource) assert.ok(Math.abs(timing.sourceEnd - media.duration) < 1 / fps)
    }
  }
})

test('topic timing keeps the source ending and supports narration longer than the available clip', () => {
  const media = { ...makeMedia('/unused.mp4'), duration: 24, verified: false, liveEndSeconds: undefined, closingStartSeconds: undefined }
  const timing = buildNbaTopicTiming(media, 38)
  assert.equal(timing.loopSource, true)
  assert.equal(timing.sourceStart, 0)
  assert.ok(timing.closingStart + timing.closingDuration <= media.duration)
  assert.ok(timing.afterNarrationSeconds > 4)
  assert.equal(buildNbaTopicTiming(media, 8).loopSource, false)
  const first = nbaProductionFingerprint({ article: { ...article, game: undefined, topic }, script }, NBA_DEFAULT_SETTINGS)
  assert.notEqual(first, nbaProductionFingerprint({ article: { ...article, game: undefined, topic: { ...topic, description: 'A different event' } }, script }, NBA_DEFAULT_SETTINGS))
})

test('a non-game interview resumes through delivery without requiring teams, scores, dates, or an NBA channel', async t => {
  const f = await fixture(t), directory = path.join(f.input.sharedDir, topic.id)
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(f.input.jobDir, { recursive: true })
  const source = path.join(directory, 'source.mp4'), audio = path.join(directory, 'reduced.wav'), videoPath = path.join(f.input.jobDir, 'completed.mp4')
  await fs.writeFile(source, 'video-fixture'); await fs.writeFile(audio, 'audio-fixture'); await fs.writeFile(videoPath, 'output-fixture')
  const media = { ...makeMedia(source), gameId: topic.id, width: 1280, height: 720, reducedAudioPath: audio, verified: false, verificationNotes: [] }
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ media, gameFingerprint: nbaContentFingerprint(topic), reducedAudioSha256: digest('audio-fixture'),
    sourceMetadata: { id: topic.videoId, title: topic.title, channel_id: 'sports-news-channel' } }))
  f.input.job.game = undefined; f.input.job.article = { ...article, game: undefined, topic }; f.input.job.script = script
  const productionInputHash = nbaProductionFingerprint({ article: f.input.job.article, script, media }, f.input.settings, digest('audio-fixture'))
  f.input.job.delivery = { videoPath, sha256: digest('output-fixture'), bytes: 14, duration: 258.341417, verification: { productionInputHash } }
  let covers = 0
  const run = async (command: string, args: string[]) => {
    if (command === 'ffprobe') {
      const isAudio = args.at(-1) === audio, isSource = args.at(-1) === source
      return { stdout: Buffer.from(JSON.stringify({ format: { duration: '258.341417' }, streams: isAudio ? [{ codec_type: 'audio', channels: 2, duration: '258.341417' }]
        : [{ codec_type: 'video', width: isSource ? 1280 : 1920, height: isSource ? 720 : 1080, avg_frame_rate: '60000/1001', duration: '258.341417' }, { codec_type: 'audio', channels: 2, duration: '258.341417' }] })), stderr: '' }
    }
    assert.equal(command, 'ffmpeg'); assert.equal(args.includes('-filter_complex'), false)
    if (args.includes('rawvideo')) return { stdout: Buffer.alloc(5184), stderr: '' }
    if (args.includes('f32le')) return { stdout: mockAudioPcm(args), stderr: '' }
    return { stdout: Buffer.alloc(0), stderr: args.includes('-af') ? '{"input_i":"-16","input_tp":"-2"}' : '' }
  }
  const result = await createNbaProducer({ run, resolveGame: async () => { throw Error('Interview must not require a game') },
    model: async () => { throw Error('Saved translation must not be reviewed') }, poster: async () => { throw Error('Interview must not invent a matchup') },
    topicCover: async coverInput => { covers++; assert.equal(coverInput.sourceVideoId, topic.videoId); return { path: 'topic-cover.png', portraitPath: 'topic-portrait.png',
      evidence: { method: 'sports-topic-frame-title-v1', inputHash: 'cover', sourceVideoId: topic.videoId, sourceSha256: digest('output-fixture'), headline: script.title,
        sourceWidth: 1920, sourceHeight: 1080, frameTimeSeconds: 20, outputs: { landscape: { width: 1920, height: 1080, sha256: 'cover' }, portrait: { width: 1080, height: 1440, sha256: 'portrait' } } } } } })(f.input)
  assert.equal(result.status, 'completed'); assert.equal(result.game, undefined); assert.equal(covers, 1)
  assert.equal(result.media?.gameId, topic.id); assert.equal(result.delivery?.coverPath, 'topic-cover.png')
  f.input.job.article.topic = { ...topic, description: 'Changed topic metadata' }
  assert.equal(await loadNbaSharedMedia(f.input, f.input.job.article.topic, { run }), undefined)
})

test('topic cover recovery ignores unverified game hints just as production does', async t => {
  const f = await fixture(t)
  f.input.job.game = { ...game, verified: false }
  f.input.job.article = { ...article, game: { ...game, verified: false }, topic }
  f.input.job.script = script
  f.input.job.delivery = { videoPath: '/completed.mp4', sha256: digest('output-fixture'), bytes: 14, duration: 50, verification: {} }
  let topicCoverCalls = 0
  const result = await ensureNbaDeliveryCover({ job: f.input.job, jobDir: f.input.jobDir, signal: f.input.signal,
    poster: async () => { throw Error('An unverified game hint must not select a matchup cover') },
    topicCover: async input => { topicCoverCalls++; assert.equal(input.sourceVideoId, topic.videoId)
      return { path: 'topic-cover.png', portraitPath: 'topic-portrait.png', evidence: { method: 'sports-topic-frame-title-v1', inputHash: 'cover',
        sourceVideoId: topic.videoId, sourceSha256: input.sourceSha256, headline: input.headline, sourceWidth: 1920, sourceHeight: 1080, frameTimeSeconds: 20,
        outputs: { landscape: { width: 1920, height: 1080, sha256: 'cover' }, portrait: { width: 1080, height: 1440, sha256: 'portrait' } } } } } })
  assert.equal(topicCoverCalls, 1)
  assert.equal(result.coverPath, 'topic-cover.png')
  assert.equal(result.sha256, f.input.job.delivery.sha256)
})

test('an interview cover uses its own source even when the related news has a verified game', async t => {
  const f = await fixture(t)
  f.input.job.article = { ...article, topic }
  f.input.job.script = script
  f.input.job.delivery = { videoPath: '/completed.mp4', sha256: digest('output-fixture'), bytes: 14, duration: 50, verification: {} }
  let calls = 0
  const result = await ensureNbaDeliveryCover({ job: f.input.job, jobDir: f.input.jobDir, signal: f.input.signal,
    poster: async () => { throw Error('Interview must use its own source, not a game poster') },
    topicCover: async input => { calls++; assert.equal(input.sourceVideoId, topic.videoId)
      return { path: 'interview-cover.png', portraitPath: 'interview-portrait.png', evidence: {} } as any } })
  assert.equal(calls, 1)
  assert.equal(result.coverPath, 'interview-cover.png')
})

async function sharedFixture(t: TestContext) {
  const f = await fixture(t), directory = path.join(f.input.sharedDir, game.id)
  await fs.mkdir(directory, { recursive: true })
  const filename = path.join(directory, 'source.mp4'), audioPath = path.join(directory, 'reduced.wav')
  await fs.writeFile(filename, 'video-fixture'); await fs.writeFile(audioPath, 'audio-fixture')
  const media = { ...makeMedia(filename), reducedAudioPath: audioPath }
  const manifest = { version: 1, media, gameFingerprint: nbaGameFingerprint(game), sourceMetadata: metadata, reducedAudioSha256: digest('audio-fixture') }
  const manifestPath = path.join(directory, 'manifest.json')
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  const run = async (_command: string, args: string[]) => ({ stdout: Buffer.from(JSON.stringify(args.at(-1) === audioPath
    ? { format: { duration: '258.391655' }, streams: [{ codec_type: 'audio', channels: 2, duration: '258.391655' }] }
    : { format: { duration: '258.391655' }, streams: [{ codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '60000/1001', duration: '258.341417' },
      { codec_type: 'audio', channels: 2, duration: '258.391655' }] })), stderr: '' })
  return { ...f, directory, filename, audioPath, media, manifest, manifestPath, run }
}

test('audio separation timeouts retain automatic recovery and report progress without blaming dependencies', async t => {
  const f = await sharedFixture(t)
  f.input.job.script = script
  const { reducedAudioPath: _, ...media } = f.media
  await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, media, reducedAudioSha256: undefined }))
  const progress: string[] = []
  f.input.onProgress = (_stage, message) => { progress.push(message) }
  let budget = 0
  const producer = createNbaProducer({ run: async (command, args, options) => {
    if (command === 'ffprobe') {
      const info = JSON.parse((await f.run(command, args)).stdout.toString())
      info.format.duration = '3600'
      info.streams.forEach((stream: any) => { stream.duration = '3600' })
      return { stdout: Buffer.from(JSON.stringify(info)), stderr: '' }
    }
    assert.ok(args.some(arg => arg.endsWith('separate-audio.py')))
    budget = options.timeout || 0
    options.onStdout?.('HDemucs separated 31.0/3600.0 seconds\n')
    throw Object.assign(new Error('python 超时'), { code: 'NBA_COMMAND_TIMEOUT', timeoutMs: budget })
  } })
  await assert.rejects(producer(f.input), (error: any) => {
    assert.equal(error.retryable, true)
    assert.match(error.message, /超时/)
    assert.doesNotMatch(error.message, /NBA_AUDIO_PYTHON|Torch\/Torchaudio/)
    return true
  })
  assert.ok(budget > 1800000, 'Long sources need a duration-based CPU inference budget')
  assert.ok(budget <= 3 * 3600000, 'A single attempt must have a bounded total runtime')
  assert.ok(progress.some(message => /31.*3600/.test(message)), 'Model progress must reach the workbench')
  assert.ok(f.patches.some(patch => /31.*3600/.test(String(patch.message))), 'Separation progress must survive a workbench reload')
})

test('the command runner identifies deadline expiry and streams progress before exit', async () => {
  let progress = ''
  await assert.rejects(runNbaCommand(process.execPath, ['-e', "process.stdout.write('model-progress\\n');setInterval(()=>{},1000)"], {
    signal: new AbortController().signal, timeout: 500,
    onStdout: (text: string) => { progress += text },
  }), (error: any) => {
    assert.equal(error.code, 'NBA_COMMAND_TIMEOUT')
    assert.equal(error.timeoutMs, 500)
    return true
  })
  assert.match(progress, /model-progress/)
})

test('a completed video gets independent matchup posters without rendering, narration, or source-frame extraction', async t => {
  const f = await sharedFixture(t)
  await fs.mkdir(f.input.jobDir, { recursive: true })
  const videoPath = path.join(f.input.jobDir, 'video-existing.mp4'), original = 'completed-output-fixture'
  await fs.writeFile(videoPath, original)
  const landscape = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#323232' } }).png().toBuffer()
  const portrait = await sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#323232' } }).png().toBuffer()
  const oldCover = path.join(f.input.jobDir, 'cover-old.jpg')
  await sharp(landscape).resize(1280, 720).jpeg().toFile(oldCover)
  f.input.job.script = script
  const productionInputHash = nbaProductionFingerprint({ article, game, script, media: f.media }, f.input.settings, digest('audio-fixture'))
  f.input.job.delivery = { videoPath, coverPath: oldCover, sha256: digest(original), bytes: Buffer.byteLength(original), duration: 258.341417,
    verification: { productionInputHash, timing: { sourceStart: 20, sourceEnd: 190 } } }
  let posterRenders = 0
  const poster: typeof prepareNbaPoster = input => prepareNbaPoster(input, {
    resolveTeams: async () => ({ home: { abbreviation: 'CLE', name: '骑士', color: '#860038' }, away: { abbreviation: 'OKC', name: '雷霆', color: '#007ac1' } }),
    render: async design => { posterRenders++; assert.equal(design.headline, script.title); return { landscape, portrait } },
  })
  const run = async (command: string, args: string[]) => {
    if (command === 'ffprobe') return f.run(command, args)
    assert.equal(command, 'ffmpeg')
    assert.equal(args.includes('-filter_complex'), false, 'a valid existing video must not render again')
    assert.equal(args.includes('image2pipe'), false, 'independent posters do not extract a broadcast frame')
    if (args.includes('rawvideo')) return { stdout: Buffer.alloc(5184), stderr: '' }
    if (args.includes('f32le')) return { stdout: mockAudioPcm(args), stderr: '' }
    return { stdout: Buffer.alloc(0), stderr: args.includes('-af') ? '{"input_i":"-16","input_tp":"-2"}' : '' }
  }
  const result = await createNbaProducer({ run, poster, model: async () => { throw Error('Saved translation must not use a model') },
    tts: async () => { throw Error('A valid video must not repeat narration') } })(f.input)
  assert.equal(result.delivery!.videoPath, videoPath)
  assert.equal(result.delivery!.sha256, digest(original))
  assert.notEqual(result.delivery!.coverPath, oldCover)
  assert.equal(posterRenders, 1)
  const image = await sharp(result.delivery!.coverPath!).metadata()
  assert.equal(image.width, 1920); assert.equal(image.height, 1080); assert.equal(image.format, 'png')
  const portraitImage = await sharp(result.delivery!.portraitCoverPath!).metadata()
  assert.equal(portraitImage.width, 1080); assert.equal(portraitImage.height, 1440)
  assert.equal((result.delivery!.verification.cover as any).method, 'nba-action-poster-v2')
  assert.equal((result.delivery!.verification.cover as any).gameId, game.id)
  const stored = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'delivery.json'), 'utf8'))
  assert.equal(stored.delivery.coverPath, result.delivery!.coverPath)
  assert.equal(await fs.readFile(videoPath, 'utf8'), original)
  await fs.unlink(f.filename)
  const uploadCover = await ensureNbaDeliveryCover({ job: { ...f.input.job, delivery: result.delivery }, jobDir: f.input.jobDir, signal: f.input.signal, poster })
  assert.equal(uploadCover.coverPath, result.delivery!.coverPath)
  assert.equal(uploadCover.portraitCoverPath, result.delivery!.portraitCoverPath)
  assert.equal(uploadCover.sha256, digest(original))
  assert.equal(posterRenders, 1)
})

test('shared recovery checks real file hashes and an explicit replacement URL', async t => {
  const f = await sharedFixture(t)
  assert.equal((await loadNbaSharedMedia(f.input, game, { run: f.run }))?.media.sha256, f.media.sha256)
  f.input.job.article.youtubeUrl = 'https://youtu.be/vDdPLHaKK4k?t=10'
  assert.ok(await loadNbaSharedMedia(f.input, game, { run: f.run }))
  f.input.job.article.youtubeUrl = 'https://youtube.com/watch?v=abcdefghijk'
  assert.equal(await loadNbaSharedMedia(f.input, game, { run: f.run }), undefined)
  f.input.job.article.youtubeUrl = undefined
  await fs.writeFile(f.filename, 'changed bytes')
  assert.equal(await loadNbaSharedMedia(f.input, game, { run: f.run }), undefined)
})

test('an interrupted shot review keeps downloaded video, and a broken arena bed only regenerates audio', async t => {
  const f = await sharedFixture(t)
  await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, media: { ...f.media, verified: false, verificationNotes: [] } }))
  assert.equal((await loadNbaSharedMedia(f.input, game, { run: f.run }))?.media.verified, false)
  await fs.writeFile(f.audioPath, 'changed audio')
  const recovered = await loadNbaSharedMedia(f.input, game, { run: f.run })
  assert.equal(recovered?.media.path, await fs.realpath(f.filename))
  assert.equal(recovered?.media.reducedAudioPath, undefined)
})

test('source paths cannot escape the shared root through a manifest or symlink', async t => {
  const f = await sharedFixture(t), outside = path.join(f.root, 'outside.mp4'), link = path.join(f.directory, 'linked.mp4')
  await fs.writeFile(outside, 'video-fixture'); await fs.symlink(outside, link)
  await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, media: { ...f.media, path: link } }))
  await assert.rejects(loadNbaSharedMedia(f.input, game, { run: f.run }), /路径越界/)
})

test('replacing a video isolates source files and a pending visual review resumes without downloading again', async t => {
  const f = await sharedFixture(t), newId = 'abcdefghijk', newMetadata = { ...metadata, id: newId,
    requested_formats: [{ acodec: 'mp4a.40.2', language: 'en-US', format_note: 'English original' }] }
  f.input.job.article.youtubeUrl = `https://youtu.be/${newId}`
  f.input.job.script = script; f.input.job.review = { passed: true, issues: [], checkedAt: article.collectedAt }
  let downloads = 0
  const run = async (command: string, args: string[]) => {
    if (command.includes('yt-dlp')) {
      if (args.includes('--dump-single-json')) return { stdout: Buffer.from(JSON.stringify(newMetadata)), stderr: '' }
      downloads++
      assert.ok(args.includes('--abort-on-unavailable-fragments'), 'a missing fragment must not create a completed source')
      assert.equal(args[args.indexOf('--fragment-retries') + 1], '5')
      const pattern = args[args.indexOf('-o') + 1], filename = pattern.replace('%(ext)s', 'mp4')
      await fs.mkdir(path.dirname(filename), { recursive: true })
      // Mirror yt-dlp's existing-file behavior, which must never point at an old source.
      try { await fs.access(filename) } catch { await fs.writeFile(filename, `video:${newId}`) }
      await fs.writeFile(pattern.replace('%(ext)s', 'info.json'), JSON.stringify(newMetadata))
      return { stdout: Buffer.alloc(0), stderr: '' }
    }
    if (command === 'ffprobe') return f.run(command, args)
    if (command === 'ffmpeg' && args.includes('-frames:v')) { await fs.writeFile(args.at(-1)!, 'sample-frame'); return { stdout: Buffer.alloc(0), stderr: '' } }
    throw Error(`Unexpected command ${command}`)
  }
  const produce = createNbaProducer({ run, model: async () => ({ safe: false, reason: 'Insufficient ending evidence', confidence: 'low' }) })
  await assert.rejects(produce(f.input), (error: any) => error.code === 'NBA_ATTENTION' && error.stage === 'media')
  const saved = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'))
  assert.equal(saved.media.sourceUrl, `https://www.youtube.com/watch?v=${newId}`)
  assert.ok(saved.media.path.includes(path.join('sources', newId, 'source.mp4')))
  assert.equal(await fs.readFile(saved.media.path, 'utf8'), `video:${newId}`)
  assert.equal(await fs.readFile(f.filename, 'utf8'), 'video-fixture')
  await assert.rejects(produce(f.input), (error: any) => error.stage === 'media')
  assert.equal(downloads, 1)
})

test('a complete download interrupted before its manifest resumes locally and still requires a real ending review', async t => {
  const f = await sharedFixture(t), newId = 'abcdefghijk', directory = path.join(f.directory, 'sources', newId)
  f.input.job.article.youtubeUrl = `https://www.youtube.com/watch?v=${newId}`
  f.input.job.script = script; f.input.job.review = { passed: true, issues: [], checkedAt: article.collectedAt }
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'source.mp4'), 'completed-download')
  const sourceMetadata = { ...metadata, id: newId, duration: 258, format_id: '301-21',
    formats: [{ format_id: '301-21', acodec: 'mp4a.40.2', vcodec: 'avc1', language: 'en-US' }] }
  await fs.writeFile(path.join(directory, 'source.info.json'), JSON.stringify(sourceMetadata))
  let youtubeCommands = 0, reviews = 0
  const run = async (command: string, args: string[]) => {
    if (command.includes('yt-dlp')) { youtubeCommands++; throw Error('A completed download must not access YouTube') }
    if (command === 'ffprobe') return f.run(command, args)
    if (command === 'ffmpeg' && args.includes('-frames:v')) { await fs.writeFile(args.at(-1)!, 'frame'); return { stdout: Buffer.alloc(0), stderr: '' } }
    throw Error(`Unexpected command ${command}`)
  }
  const produce = createNbaProducer({ run, model: async () => { reviews++; return { safe: false, reason: 'Ending still requires verification', confidence: 'low' } } })
  await assert.rejects(produce(f.input), /Ending still requires verification/)
  assert.equal(youtubeCommands, 0); assert.equal(reviews, 1)
  const saved = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'))
  assert.equal(saved.media.sha256, digest('completed-download'))
  assert.equal(saved.media.verified, false)
  assert.equal(saved.sourceMetadata.format_id, '301-21')

  await fs.rm(f.manifestPath)
  await fs.writeFile(path.join(directory, 'source.info.json'), JSON.stringify({ ...sourceMetadata, id: metadata.id }))
  await assert.rejects(produce(f.input), /视频编号不一致/)
  await fs.writeFile(path.join(directory, 'source.info.json'), JSON.stringify({ ...sourceMetadata, duration: 100 }))
  await assert.rejects(produce(f.input), /时长不符/)
  await fs.writeFile(path.join(directory, 'source.info.json'), JSON.stringify({ ...sourceMetadata, formats: [{ ...sourceMetadata.formats[0], language: 'zh-CN' }] }))
  await assert.rejects(produce(f.input), /原英文音轨/)
  const outsideMetadata = path.join(f.root, 'outside-info.json')
  await fs.writeFile(outsideMetadata, JSON.stringify(sourceMetadata))
  await fs.rm(path.join(directory, 'source.info.json'))
  await fs.symlink(outsideMetadata, path.join(directory, 'source.info.json'))
  await assert.rejects(produce(f.input), /路径越界/)

  const outside = path.join(f.root, 'outside-directory'), insideVideo = path.join(f.directory, 'completed.mp4')
  await fs.mkdir(outside)
  await fs.rename(path.join(directory, 'source.mp4'), insideVideo)
  await fs.rm(directory, { recursive: true })
  await fs.symlink(outside, directory)
  await fs.symlink(insideVideo, path.join(outside, 'source.mp4'))
  await fs.writeFile(path.join(outside, 'source.info.json'), JSON.stringify(sourceMetadata))
  await assert.rejects(produce(f.input), /路径越界/)
  assert.equal(reviews, 1)
})

test('a rejected YouTube session refreshes and retries the same source without repeating accepted editorial work', async t => {
  const f = await sharedFixture(t), newId = 'abcdefghijk'
  const newMetadata = { ...metadata, id: newId, requested_formats: [{ acodec: 'mp4a.40.2', language: 'en-US', format_note: 'English original' }] }
  f.input.job.article.youtubeUrl = `https://www.youtube.com/watch?v=${newId}`
  f.input.job.script = script; f.input.job.review = { passed: true, issues: [], checkedAt: article.collectedAt }
  let refreshed = 0, downloads = 0, editorialCalls = 0
  const run = async (command: string, args: string[]) => {
    if (command.includes('yt-dlp')) {
      if (!refreshed) throw Object.assign(new Error("Sign in to confirm you're not a bot"), { stderr: "ERROR: [youtube] abcdefghijk: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies" })
      assert.equal(args.at(-1), `https://www.youtube.com/watch?v=${newId}`)
      if (args.includes('--dump-single-json')) return { stdout: Buffer.from(JSON.stringify(newMetadata)), stderr: '' }
      downloads++
      const pattern = args[args.indexOf('-o') + 1]
      await fs.mkdir(path.dirname(pattern), { recursive: true })
      await fs.writeFile(pattern.replace('%(ext)s', 'mp4'), 'refreshed-video')
      await fs.writeFile(pattern.replace('%(ext)s', 'info.json'), JSON.stringify(newMetadata))
      return { stdout: Buffer.alloc(0), stderr: '' }
    }
    if (command === 'ffprobe') return f.run(command, args)
    if (command === 'ffmpeg' && args.includes('-frames:v')) { await fs.writeFile(args.at(-1)!, 'sample'); return { stdout: Buffer.alloc(0), stderr: '' } }
    throw Error(`Unexpected command ${command}`)
  }
  const produce = createNbaProducer({ run,
    refreshYoutubeSession: async (url: string, signal: AbortSignal) => { signal.throwIfAborted(); assert.equal(url, `https://www.youtube.com/watch?v=${newId}`); refreshed++ },
    model: async system => { if (!system.includes('剪辑审核员')) editorialCalls++; return { safe: false, reason: 'Insufficient ending evidence', confidence: 'low' } },
  } as Parameters<typeof createNbaProducer>[0])
  await assert.rejects(produce(f.input), /Insufficient ending evidence/)
  assert.equal(refreshed, 1); assert.equal(downloads, 1); assert.equal(editorialCalls, 0)
})

test('rewriting imported hard-linked subtitles preserves the original output files', async t => {
  const f = await sharedFixture(t)
  await fs.mkdir(f.input.jobDir, { recursive: true })
  const originalAss = path.join(f.root, 'original.ass'), originalSrt = path.join(f.root, 'original.srt')
  await fs.writeFile(originalAss, 'original ASS'); await fs.writeFile(originalSrt, 'original SRT')
  await fs.link(originalAss, path.join(f.input.jobDir, 'subtitles.ass'))
  await fs.link(originalSrt, path.join(f.input.jobDir, 'subtitles.srt'))
  f.input.job.script = script; f.input.job.review = { passed: true, issues: [], checkedAt: article.collectedAt }
  const processed = 'processed-voice', text = nbaSpokenText(script.text), chars = [...text]
  await fs.writeFile(path.join(f.input.jobDir, `asr-${digest(processed).slice(0, 16)}.json`), JSON.stringify({ transcription: [
    { text, offsets: { from: 0, to: 20000 }, tokens: chars.map((char, index) => ({ text: char, offsets: { from: index * 20000 / chars.length, to: (index + 1) * 20000 / chars.length } })) },
  ] }))
  const raw = path.join(f.root, 'raw.m4a'); await fs.writeFile(raw, 'raw-voice')
  const run = async (command: string, args: string[]) => {
    if (command === 'ffprobe' && path.basename(args.at(-1)!).startsWith('voice-')) return { stdout: Buffer.from(JSON.stringify({ format: { duration: '20' }, streams: [{ codec_type: 'audio', duration: '20' }] })), stderr: '' }
    if (command === 'ffprobe') return f.run(command, args)
    if (command === 'ffmpeg' && args.includes('-filter_complex')) throw Error('render stop after caption verification')
    if (command === 'ffmpeg' && args.includes('f32le')) return { stdout: mockAudioPcm(args), stderr: '' }
    if (command === 'ffmpeg' && args.includes('pcm_s16le')) await fs.writeFile(args.at(-1)!, processed)
    return { stdout: Buffer.alloc(0), stderr: '' }
  }
  const produce = createNbaProducer({ run, tts: async () => ({ path: raw, requestIdentity: 'fixture' }), ttsIdentity: async () => 'fixture' })
  await assert.rejects(produce(f.input), /render stop/)
  assert.equal(await fs.readFile(originalAss, 'utf8'), 'original ASS')
  assert.equal(await fs.readFile(originalSrt, 'utf8'), 'original SRT')
  assert.match(await fs.readFile(path.join(f.input.jobDir, 'subtitles.ass'), 'utf8'), /ScriptType: v4.00/)
  assert.match(await fs.readFile(path.join(f.input.jobDir, 'subtitles.srt'), 'utf8'), /00:00:/)
})

async function captionRecoveryFixture(t: TestContext, recovered: boolean) {
  const f = await sharedFixture(t), processed = 'recovery-voice', text = nbaSpokenText(script.text)
  await fs.mkdir(f.input.jobDir, { recursive: true })
  const base = path.join(f.input.jobDir, `asr-${digest(processed).slice(0, 16)}`)
  const recognition = (value: string) => ({ transcription: [{ text: value, offsets: { from: 0, to: 20000 },
    tokens: [...value].map((char, index) => ({ text: char, offsets: { from: index * 20000 / [...value].length, to: (index + 1) * 20000 / [...value].length } })) }] })
  const rejected = recognition(text.slice(12))
  await fs.writeFile(`${base}.json`, JSON.stringify(rejected))
  const raw = path.join(f.root, 'raw.m4a'), model = path.join(f.root, 'whisper-model.bin')
  await fs.writeFile(raw, 'raw-voice'); await fs.writeFile(model, 'model-fixture')
  const originalModel = process.env.WHISPER_MODEL
  process.env.WHISPER_MODEL = model
  t.after(() => { if (originalModel === undefined) delete process.env.WHISPER_MODEL; else process.env.WHISPER_MODEL = originalModel })
  f.input.job.script = script
  let recognitions = 0
  const run = async (command: string, args: string[]) => {
    if (args.includes('-ojf')) {
      recognitions++
      assert.equal(args[args.indexOf('--prompt') + 1], '简体中文体育新闻。')
      await fs.writeFile(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify(recovered ? recognition(text) : rejected))
      return { stdout: Buffer.alloc(0), stderr: '' }
    }
    if (command === 'ffprobe' && path.basename(args.at(-1)!).startsWith('voice-')) return { stdout: Buffer.from(JSON.stringify({ format: { duration: '20' }, streams: [{ codec_type: 'audio', duration: '20' }] })), stderr: '' }
    if (command === 'ffprobe') return f.run(command, args)
    if (command === 'ffmpeg' && args.includes('-filter_complex')) throw Error('render stop after recovered captions')
    if (command === 'ffmpeg' && args.includes('f32le')) return { stdout: mockAudioPcm(args), stderr: '' }
    if (command === 'ffmpeg' && args.includes('pcm_s16le')) await fs.writeFile(args.at(-1)!, processed)
    if (command === 'ffmpeg' && args[args.indexOf('-ar') + 1] === '16000') await fs.writeFile(args.at(-1)!, 'asr-wave')
    return { stdout: Buffer.alloc(0), stderr: '' }
  }
  const produce = createNbaProducer({ run, tts: async () => ({ path: raw, requestIdentity: 'recovery' }), ttsIdentity: async () => 'recovery' })
  return { ...f, base, produce, recognitions: () => recognitions }
}

test('a rejected ASR cache is re-recognized once with a neutral prompt and the successful result is reused', async t => {
  const f = await captionRecoveryFixture(t, true)
  await assert.rejects(f.produce(f.input), /render stop after recovered captions/)
  assert.equal(f.recognitions(), 1)
  assert.equal(JSON.parse(await fs.readFile(`${f.base}.alignment-recovery.json`, 'utf8')).status, 'recovered')
  assert.ok(await fs.readFile(`${f.base}.alignment-rejected.json`, 'utf8'))
  const captions = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'captions.json'), 'utf8'))
  assert.equal(captions.cues.map((cue: any) => cue.text).join(''), nbaSpokenText(script.text))
  await assert.rejects(f.produce(f.input), /render stop after recovered captions/)
  assert.equal(f.recognitions(), 1, 'valid recovered timestamps are reused on resume')
})

test('a second alignment failure retains evidence and does not retry the same rejected ASR indefinitely', async t => {
  const f = await captionRecoveryFixture(t, false)
  await assert.rejects(f.produce(f.input), /字幕重新识别后仍无法对齐/)
  assert.equal(f.recognitions(), 1)
  assert.equal(JSON.parse(await fs.readFile(`${f.base}.alignment-recovery.json`, 'utf8')).status, 'failed')
  await assert.rejects(f.produce(f.input), /字幕重新识别后仍无法对齐/)
  assert.equal(f.recognitions(), 1)
})

test('English news is translated once without a factual review or rewrite call', async t => {
  const f = await fixture(t), calls: Array<{ system: string; input: unknown }> = []
  const produce = createNbaProducer({ model: async (system, input) => { calls.push({ system, input }); return { title: script.title, text: script.text } }, run: async () => { throw new Error('No fixture source') } })
  await assert.rejects(produce(f.input), (error: any) => error.code === 'NBA_ATTENTION' && error.stage === 'media')
  assert.equal(calls.length, 1)
  assert.match(calls[0].system, /翻译/)
  assert.doesNotMatch(calls[0].system, /事实审核员|复核员|facts/)
  assert.equal((calls[0].input as any).article.body, article.body)
  assert.equal(f.patches.some(patch => patch.stage === 'review'), false)
  assert.equal(f.patches.some(patch => (patch.review as any)?.passed === true), false)
  const saved = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'editorial.json'), 'utf8'))
  assert.equal(saved.mode, 'translation-only')
  assert.equal(saved.review, undefined)
  await assert.rejects(produce(f.input), (error: any) => error.stage === 'media')
  assert.equal(calls.length, 1, 'resuming a saved translation must not call the model again')
})

test('a legacy fact-review rejection resumes its saved translation without any review or repair', async t => {
  const f = await fixture(t)
  const source = [
    'Luka Doncic had 42 points, 13 assists and seven rebounds, leading the Los Angeles Lakers to a 138-117 victory over the Miami Heat.',
    'Doncic scored at least 37 points in his fifth consecutive game, hitting six 3-pointers just one night after he had 45 points and 15 assists in a win over Toronto.',
    'Austin Reaves scored 27 points and Walker Kessler added 15 points and 15 rebounds for the Lakers. Los Angeles is 6-2 after the fourth 40-point performance in his last five games from Doncic, who is averaging 43.4 points per game in that stretch.',
    'The Lakers also played Friday and then had to hold off the Raptors on Sunday night.',
    'He had 24 points by halftime, and Doncic got nine more in the first 4 1/2 minutes after the break to balloon the Lakers lead to 93-74. Miami never seriously threatened to close the gap down the stretch, with Reaves stepping up while Doncic rested to start the fourth quarter.',
  ].join('\n\n')
  const claims = ['卢卡·东契奇拿下42分、13次助攻和7个篮板，率领湖人以138比117战胜热火。',
    '东契奇连续第五场至少得到37分，命中6记三分；前一晚他刚在战胜猛龙的比赛中交出45分和15次助攻。',
    '奥斯汀·里夫斯得到27分，沃克·凯斯勒贡献15分和15个篮板，湖人战绩来到6胜2负。',
    '东契奇最近五场有四场得分至少达到40分，这段时间场均得到43.4分。',
    '半场结束时，东契奇已经得到24分；下半场开打后，他在前四分半钟再得9分，帮助湖人将领先优势扩大到93比74。',
    '末节东契奇开局休息时，里夫斯挺身而出，热火此后始终未能真正缩小分差。']
  const candidate = { title: '东契奇42分率湖人战胜热火', text: claims.join(''), facts: claims.map((claim, index) => ({ claim, paragraph: [1, 2, 3, 3, 5, 5][index] })) }
  const oldReview = { passed: false, issues: ['原文仅称他在对阵多伦多的胜利中取得该数据；未明确这场胜利由谁赢得。',
    '稿件遗漏了其他球员数据；但译述允许省略，因此不构成事实错误。'], checkedAt: article.collectedAt }
  f.input.job.article = { ...article, body: source, bodyHash: digest(source) }
  f.input.job.script = candidate; f.input.job.review = oldReview
  await fs.mkdir(f.input.jobDir, { recursive: true })
  const key = digest(JSON.stringify([1, digest(source), nbaGameFingerprint(game)])), scriptHash = digest(JSON.stringify(candidate))
  await fs.writeFile(path.join(f.input.jobDir, 'editorial.json'), JSON.stringify({ key, draft: candidate, scriptHash, review: oldReview, repairCount: 1, repairs: [{ beforeHash: 'original', afterHash: scriptHash }] }))
  let calls = 0
  const produce = createNbaProducer({ model: async () => { calls++; throw Error('A saved translation does not need any model call') }, run: async () => { throw Error('No fixture source') } })
  await assert.rejects(produce(f.input), (error: any) => error.stage === 'media')
  assert.equal(calls, 0)
  const saved = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'editorial.json'), 'utf8'))
  assert.deepEqual(saved.script, candidate)
  assert.equal(saved.mode, 'translation-only')
  assert.equal(saved.review, undefined)
  assert.equal(saved.repairCount, 1)
  assert.equal(saved.repairs.length, 1)
  assert.deepEqual(saved.previousReview, oldReview)
  await assert.rejects(produce(f.input), (error: any) => error.stage === 'media')
  assert.equal(calls, 0)
})

test('Chinese news uses its original body without translation or a factual review', async t => {
  const f = await fixture(t); let calls = 0
  f.input.job.article = { ...article, language: 'zh', title: script.title, body: script.text, bodyHash: digest(script.text) }
  const produce = createNbaProducer({ model: async () => { calls++; throw Error('Chinese copy must not call a text model') },
    run: async () => { throw Error('No fixture source') } })
  await assert.rejects(produce(f.input), (error: any) => error.stage === 'media')
  assert.equal(calls, 0)
  const saved = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'editorial.json'), 'utf8'))
  assert.equal(saved.script.text, script.text)
  assert.equal(saved.review, undefined)
})

test('website boilerplate cannot reach translation, media or a cached finished video', async t => {
  const f = await fixture(t)
  const contaminated = script.text + '\n\n特别声明：以上文章内容仅代表作者本人观点，不代表新浪网观点或立场。\n\n相关新闻\n\n阅读排行榜\n\nCopyright © 1996-2026 SINA Corporation'
  f.input.job.article = { ...article, language: 'zh', body: contaminated, bodyHash: digest(contaminated) }
  let work = 0
  const producer = createNbaProducer({ model: async () => { work++; throw Error('must not translate dirty copy') },
    run: async () => { work++; throw Error('must not touch media') } })
  await assert.rejects(producer(f.input), /网页.*杂项|正文.*清理/)
  assert.equal(work, 0)
})

test('an invalid translation response cannot enter an editorial review loop', async t => {
  const f = await fixture(t); let calls = 0
  const produce = createNbaProducer({ model: async () => { calls++; return { title: 'Empty translation', text: '' } }, run: async () => { throw Error('Should not reach media') } })
  await assert.rejects(produce(f.input), (error: any) => error.code === 'NBA_ATTENTION' && error.stage === 'script')
  assert.equal(calls, 1)
})

test('a cancelled job never starts model or media work and command cancellation ends its process', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort()
  await assert.rejects(createNbaProducer({ model: async () => { throw Error('Unexpected model work') } })({ ...f.input, signal: controller.signal }), { name: 'AbortError' })
  const commandController = new AbortController()
  const pending = runNbaCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: commandController.signal, timeout: 5000 })
  setTimeout(() => commandController.abort(), 40)
  await assert.rejects(pending, { name: 'AbortError' })
})

test('a peak failure is repaired automatically and a later cover failure resumes without rendering or TTS', async t => {
  const f = await sharedFixture(t), processed = 'cached-voice-for-render', text = nbaSpokenText(script.text)
  await fs.mkdir(f.input.jobDir, { recursive: true })
  f.input.job.script = script
  const raw = path.join(f.root, 'raw.m4a')
  await fs.writeFile(raw, 'raw')
  await fs.writeFile(path.join(f.input.jobDir, `asr-${digest(processed).slice(0, 16)}.json`), JSON.stringify({ transcription: [{ text, offsets: { from: 0, to: 20000 },
    tokens: [...text].map((char, index) => ({ text: char, offsets: { from: index * 20000 / [...text].length, to: (index + 1) * 20000 / [...text].length } })) }] }))
  const timing = buildNbaTiming(f.media, 20)
  let renders = 0, encodes = 0, voices = 0, covers = 0
  const run = async (command: string, args: string[]) => {
    const filename = args.at(-1)!
    if (command === 'ffprobe') {
      if (path.basename(filename).startsWith('voice-')) return { stdout: Buffer.from(JSON.stringify({ format: { duration: '20' }, streams: [{ codec_type: 'audio' }] })), stderr: '' }
      if (path.basename(filename) === 'source.mp4' || path.basename(filename) === 'reduced.wav') return f.run(command, [...args.slice(0, -1), path.basename(filename) === 'reduced.wav' ? f.audioPath : f.filename])
      return { stdout: Buffer.from(JSON.stringify({ format: { duration: timing.duration }, streams: [
        { codec_type: 'video', width: 1920, height: 1080, duration: timing.duration, nb_frames: timing.frameCount, avg_frame_rate: '60000/1001' }, { codec_type: 'audio' }] })), stderr: '' }
    }
    assert.equal(command, 'ffmpeg')
    if (args.includes('streamhash')) return { stdout: Buffer.from('0,v,SHA256=unchanged\n'), stderr: '' }
    if (args.includes('-filter_complex')) {
      renders++
      assert.ok(Math.abs(Number(args[args.lastIndexOf('-ss') + 1]) - (f.media.liveEndSeconds! - timing.closingDuration)) < .001)
      await fs.writeFile(filename, 'rendered-video')
    }
    else if (args.includes('copy')) { encodes++; await fs.writeFile(filename, 'repaired-video') }
    else if (args.includes('pcm_s16le')) await fs.writeFile(filename, processed)
    else if (args.includes('rawvideo')) return { stdout: Buffer.alloc(5184), stderr: '' }
    else if (args.includes('f32le')) {
      const pcm = mockAudioPcm(args)
      if (path.basename(args[args.indexOf('-i') + 1]) === 'reduced.wav' && Math.abs(Number(args[args.indexOf('-ss') + 1]) - timing.closingStart) < .001) pcm.fill(0)
      return { stdout: pcm, stderr: '' }
    }
    else if (args.some(arg => arg.startsWith('loudnorm='))) return { stdout: Buffer.alloc(0), stderr: JSON.stringify({ input_i: '-16', input_tp: args[args.indexOf('-i') + 1].endsWith('video.pending.mp4') ? '0.08' : '-2.1' }) }
    return { stdout: Buffer.alloc(0), stderr: '' }
  }
  const producer = createNbaProducer({ run, ttsIdentity: async () => 'fixture', tts: async () => { voices++; return { path: raw, requestIdentity: 'fixture' } },
    poster: async () => { if (!covers++) throw Error('transient cover failure'); return { path: 'cover.png', portraitPath: 'portrait.png', evidence: {} } as any } })
  await assert.rejects(producer(f.input), /transient cover failure/)
  assert.equal(renders, 1); assert.equal(encodes, 1)
  const selectedClosing = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'closing-audio.json'), 'utf8'))
  assert.equal(selectedClosing.usedFallback, true)
  assert.equal(selectedClosing.candidates[0].metrics.audibleFraction, 0)
  const savedRecovery = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'audio-recovery.json'), 'utf8'))
  assert.equal(await fs.readFile(savedRecovery.outputPath, 'utf8'), 'repaired-video', 'promotion keeps a recoverable candidate')
  const savedCachePath = path.join(f.input.jobDir, 'render-cache.json')
  const savedCache = JSON.parse(await fs.readFile(savedCachePath, 'utf8'))
  await fs.writeFile(savedCachePath, JSON.stringify({ ...savedCache, path: path.join(f.input.jobDir, 'video.pending.mp4'), sha256: digest('rendered-video') }))
  const result = await producer(f.input)
  assert.equal(result.status, 'completed')
  assert.equal(renders, 1); assert.equal(encodes, 1); assert.equal(voices, 1)
  assert.equal(result.delivery!.verification.truePeakDbTP, -2.1)
  const recovery = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'audio-recovery.json'), 'utf8'))
  assert.equal(recovery.status, 'recovered', 'promotion retains the original repair evidence')
  const cache = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'render-cache.json'), 'utf8'))
  assert.equal(cache.path, result.delivery!.videoPath)
  assert.equal(cache.sha256, result.delivery!.sha256)
})

test('an interview with silent separated ambience completes with a short continuous ending after the full narration', async t => {
  const f = await sharedFixture(t), processed = 'interview-voice', text = nbaSpokenText(script.text)
  const interview = { ...topic, id: game.id, title: 'Luka Dončić On His HISTORIC Scoring Run After Another 40-Point Night' }
  f.input.job.article = { ...article, topic: interview }
  f.input.job.script = script
  await fs.writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, gameFingerprint: nbaContentFingerprint(interview),
    sourceMetadata: { ...metadata, title: interview.title } }))
  await fs.mkdir(f.input.jobDir, { recursive: true })
  const raw = path.join(f.root, 'raw.m4a')
  await fs.writeFile(raw, 'raw')
  await fs.writeFile(path.join(f.input.jobDir, `asr-${digest(processed).slice(0, 16)}.json`), JSON.stringify({ transcription: [{ text, offsets: { from: 0, to: 20000 },
    tokens: [...text].map((char, index) => ({ text: char, offsets: { from: index * 20000 / [...text].length, to: (index + 1) * 20000 / [...text].length } })) }] }))
  let renders = 0
  const run = async (command: string, args: string[]) => {
    const filename = args.at(-1)!
    if (command === 'ffprobe') {
      if (path.basename(filename).startsWith('voice-')) return { stdout: Buffer.from(JSON.stringify({ format: { duration: '20' }, streams: [{ codec_type: 'audio' }] })), stderr: '' }
      if (['source.mp4', 'reduced.wav'].includes(path.basename(filename))) return f.run(command,
        [...args.slice(0, -1), path.basename(filename) === 'reduced.wav' ? f.audioPath : f.filename])
      const timing = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'ending-plan.json'), 'utf8'))
      return { stdout: Buffer.from(JSON.stringify({ format: { duration: timing.duration }, streams: [
        { codec_type: 'video', width: 1920, height: 1080, duration: timing.duration, nb_frames: timing.frameCount, avg_frame_rate: '60000/1001' }, { codec_type: 'audio' }] })), stderr: '' }
    }
    assert.equal(command, 'ffmpeg')
    if (args.includes('-filter_complex')) {
      renders++
      assert.equal(args.filter(arg => arg === '-i').length, 3, 'interview uses continuous source picture and audio with narration')
      assert.equal(args[args.indexOf('-filter_complex') + 1].includes('acrossfade'), false)
      await fs.writeFile(filename, 'interview-output')
    } else if (args.includes('pcm_s16le')) await fs.writeFile(filename, processed)
    else if (args.includes('rawvideo')) return { stdout: Buffer.alloc(5184), stderr: '' }
    else if (args.includes('f32le')) {
      const pcm = mockAudioPcm(args)
      if (path.basename(args[args.indexOf('-i') + 1]) === 'reduced.wav') pcm.fill(0)
      return { stdout: pcm, stderr: '' }
    } else if (args.some(arg => arg.startsWith('loudnorm='))) return { stdout: Buffer.alloc(0), stderr: '{"input_i":"-16","input_tp":"-2.1"}' }
    return { stdout: Buffer.alloc(0), stderr: '' }
  }
  const result = await createNbaProducer({ run, ttsIdentity: async () => 'fixture', tts: async () => ({ path: raw, requestIdentity: 'fixture' }),
    poster: async () => { throw Error('Interview must use its own source, not a game poster') },
    topicCover: async () => ({ path: 'cover.png', portraitPath: 'portrait.png', evidence: {} }) as any })(f.input)
  assert.equal(result.status, 'completed'); assert.equal(renders, 1)
  const timing = result.delivery!.verification.timing as any
  assert.equal(timing.endingMode, 'interview-sentence-fade-v1')
  assert.ok(timing.afterNarrationSeconds >= 1.1 && timing.afterNarrationSeconds < 1.2)
  assert.ok(timing.videoFadeStart >= timing.speechEnd)
  assert.ok(timing.audioFadeStart >= timing.speechEnd)
  assert.equal(timing.bodyFrames, timing.frameCount)
  assert.equal(timing.closingFrames, 0)
  assert.ok(Math.abs(timing.sourceEnd - f.media.duration) < 1 / f.media.fps)
  const evidence = JSON.parse(await fs.readFile(path.join(f.input.jobDir, 'closing-audio.json'), 'utf8'))
  assert.equal(evidence.method, 'interview-sentence-fade-v1')
  assert.equal(result.delivery!.verification.audioPreflight && (result.delivery!.verification.audioPreflight as any).status, 'passed')
})
