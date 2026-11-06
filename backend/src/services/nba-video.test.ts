import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { NbaVideoService, nbaStartSchema } from './nba-video.js'
import { NBA_DEFAULT_SETTINGS, type NbaArticle, type NbaJob, type NbaProductionInput, type NbaUpload } from './nba-types.js'

const article = (id = 'one'): NbaArticle => ({ id, url: `https://www.espn.com/nba/story/_/id/${id}`, title: `完整报道 ${id}`, language: 'en', publisher: 'ESPN',
  body: 'Basketball report. '.repeat(110), bodyHash: createHash('sha256').update(id).digest('hex'), wordCount: 220, characterCount: 0, collectedAt: new Date().toISOString() })
function temporary(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nba-workflow-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function production(input: NbaProductionInput) {
  input.onProgress('render', '正在验证服务交付契约')
  const file = path.join(input.jobDir, 'test-output.mp4')
  const bytes = Buffer.from(`service-contract-fixture-${input.job.id}`)
  fs.writeFileSync(file, bytes)
  return Promise.resolve({ delivery: {
    videoPath: file, duration: 1, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), verification: { fixture: true },
  } })
}
const startInput = (requestId = 'start-news-001', autoProduce = false) => nbaStartSchema.parse({ requestId, autoProduce, collectionMode: 'manual' })

test('collection is durable and idempotent, and excludes an existing complete article', async t => {
  const root = temporary(t); let collects = 0
  const service = new NbaVideoService({ root, scheduling: false, collect: async input => {
    collects++; assert.ok(input.signal); return { articles: [article()], sources: [{ id: 'en', label: 'English', status: 'ok', count: 1 }], excluded: [] }
  } })
  t.after(() => service.close())
  const first = service.start(startInput())
  assert.equal(service.start(startInput()).id, first.id)
  assert.throws(() => service.start({ ...startInput(), limit: 9 }), /不同内容/)
  await service.waitForIdle()
  assert.equal(collects, 1)
  assert.equal(service.overview().stats.total, 1)
  service.start(startInput('start-news-002')); await service.waitForIdle()
  assert.equal(service.overview().stats.total, 1)
  assert.equal(service.overview().runs[0].excluded[0]?.reason, '该完整报道已建档')
  const reloaded = new NbaVideoService({ root, scheduling: false }); t.after(() => reloaded.close())
  assert.equal(reloaded.overview().stats.total, 1)
  assert.ok(reloaded.detail(service.overview().jobs[0].id).article.body)
  assert.equal('body' in reloaded.overview().jobs[0].article, false)
})

test('one source video creates one job across different stories, languages, and collection rounds', async t => {
  const root = temporary(t), produced: string[] = []
  let round = 0
  const source = (id: string, language: 'en' | 'zh') => ({ ...article(id), language,
    youtubeUrl: language === 'en' ? 'https://youtu.be/vDdPLHaKK4k?t=10' : 'https://www.youtube.com/watch?v=vDdPLHaKK4k' })
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({
    articles: round++ ? [source('third', 'zh')] : [source('first', 'en'), source('second', 'zh')], sources: [], excluded: [],
  }), produce: input => { produced.push(input.job.article.id); return production(input) } })
  t.after(() => service.close())
  const collected = service.start(startInput('same-source-first', true)); await service.waitForIdle()
  assert.deepEqual(produced, ['first'])
  assert.equal(service.overview().stats.total, 1)
  assert.match(service.overview().runs.find(run => run.id === collected.id)!.excluded[0]!.reason, /同一源视频/)
  service.start(startInput('same-source-next', true)); await service.waitForIdle()
  assert.deepEqual(produced, ['first'])
  assert.equal(service.overview().stats.total, 1)
})

test('legacy same-source jobs do not render twice and a distinct interview remains eligible', async t => {
  const root = temporary(t), produced: string[] = []
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article('first'), article('second'), article('interview')], sources: [], excluded: [] }),
    produce: input => { produced.push(input.job.article.id); return production(input) } })
  t.after(() => service.close())
  service.start(startInput('legacy-sources-collected')); await service.waitForIdle()
  const jobs = service.overview().jobs
  for (const job of jobs) {
    const filename = path.join(root, 'jobs', job.id, 'job.json'), stored: NbaJob = JSON.parse(fs.readFileSync(filename, 'utf8'))
    stored.article.youtubeUrl = `https://www.youtube.com/watch?v=${stored.article.id === 'interview' ? 'rhZ6oVlNZHs' : 'vDdPLHaKK4k'}`
    stored.createdAt = stored.article.id === 'first' ? '2026-11-01T00:00:00.000Z' : '2026-11-02T00:00:00.000Z'
    fs.writeFileSync(filename, JSON.stringify(stored))
  }
  service.resume({ requestId: 'legacy-sources-resumed', jobIds: jobs.map(job => job.id) }); await service.waitForIdle()
  assert.deepEqual(produced.sort(), ['first', 'interview'])
  const duplicate = service.overview().jobs.find(job => job.article.id === 'second')!
  assert.equal(duplicate.canResume, false)
  assert.match(duplicate.message, /同一源视频/)
  assert.equal(service.overview().runs[0].status, 'completed')
})

test('resume processes only selected jobs and verifies real file bytes before completion', async t => {
  const root = temporary(t); const produced: string[] = []
  const service = new NbaVideoService({ root, scheduling: false,
    collect: async () => ({ articles: [article('one'), article('two')], sources: [], excluded: [] }),
    produce: input => { produced.push(input.job.article.id); return production(input) },
  }); t.after(() => service.close())
  service.start(startInput()); await service.waitForIdle()
  const one = service.overview().jobs.find(job => job.article.id === 'one')!
  const run = service.resume({ requestId: 'resume-one-only', jobIds: [one.id] })
  assert.equal(service.resume({ requestId: 'resume-one-only', jobIds: [one.id] }).id, run.id)
  await service.waitForIdle()
  assert.deepEqual(produced, ['one'])
  assert.equal(service.detail(one.id).status, 'completed')
  assert.ok(service.detail(one.id).assets.video)
  assert.equal(JSON.stringify(service.detail(one.id)).includes(root), false)
  const two = service.overview().jobs.find(job => job.article.id === 'two')!
  assert.equal(two.status, 'queued')
  fs.unlinkSync(service.asset(one.id, 'video').path)
  assert.equal(service.overview().jobs.find(job => job.id === one.id)!.canResume, true)
  service.resume({ requestId: 'resume-repair-missing', jobIds: [one.id] }); await service.waitForIdle()
  assert.equal(produced.length, 2)
})

test('production receives recent submitted cover photographs while excluding its own previous cover', async t => {
  const root = temporary(t), previousHash = 'a'.repeat(64), ownHash = 'b'.repeat(64)
  const service = new NbaVideoService({ root, scheduling: false,
    collect: async () => ({ articles: [article('first-photo'), article('next-photo')], sources: [], excluded: [] }),
    produce: async input => {
      if (input.job.article.id === 'next-photo') assert.deepEqual(input.recentCoverPhotoSha256s, [previousHash])
      return production(input)
    },
  })
  t.after(() => service.close())
  service.start(startInput('cover-history-collect')); await service.waitForIdle()
  const first = service.overview().jobs.find(job => job.article.id === 'first-photo')!
  const next = service.overview().jobs.find(job => job.article.id === 'next-photo')!
  for (const [job, photoSha256] of [[first, previousHash], [next, ownHash]] as const) {
    const filename = path.join(root, 'jobs', job.id, 'job.json')
    const stored = JSON.parse(fs.readFileSync(filename, 'utf8'))
    stored.delivery = { verification: { cover: { teams: [{ player: { photoSha256 } }] } } }
    stored.uploads = [{ dispatched: true }]
    fs.writeFileSync(filename, JSON.stringify(stored))
  }
  service.resume({ requestId: 'cover-history-produce', jobIds: [next.id] }); await service.waitForIdle()
  assert.equal(service.detail(next.id).status, 'completed')
})

test('a missing delivery cannot become completed', async t => {
  const root = temporary(t)
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article()], sources: [], excluded: [] }),
    produce: async () => ({ review: { passed: true, issues: [], checkedAt: new Date().toISOString() } }) })
  t.after(() => service.close())
  service.start(startInput('missing-output-001', true)); await service.waitForIdle()
  assert.equal(service.overview().jobs[0].status, 'attention')
  assert.equal(service.overview().stats.completed, 0)
})

test('a video topic without a game proceeds through production and automatic upload', async t => {
  const root = temporary(t); let produced = false, uploads = 0
  const source = article('media-day')
  source.topic = { id: 'youtube-rhZ6oVlNZHs', videoId: 'rhZ6oVlNZHs', title: 'Player media day interview',
    description: 'Sports interview about the new season', youtubeUrl: 'https://www.youtube.com/watch?v=rhZ6oVlNZHs' }
  source.heldReason = '采访或赛前内容，不应自动生产'
  const service = new NbaVideoService({ root, scheduling: false,
    collectChannels: async () => ({ articles: [source], videos: [], sources: [], excluded: [] }),
    produce: async input => {
      produced = true
      assert.equal(input.job.game, undefined)
      assert.equal(input.job.article.heldReason, undefined)
      assert.equal(input.job.article.topic?.videoId, 'rhZ6oVlNZHs')
      return production(input)
    },
    uploadAccount: () => ({ accountName: 'cba_775d8aec569e4c888105e9790c463a8c', label: '体育', status: 'ready', message: '已登录' }),
    upload: async () => { uploads++; return { saved: true, message: '已提交发表' } },
  })
  t.after(() => service.close())
  service.start(nbaStartSchema.parse({ requestId: 'sports-topic-auto-001', autoProduce: true, autoUpload: true }))
  await service.waitForIdle()
  assert.equal(produced, true)
  assert.equal(service.overview().jobs[0].status, 'completed')
  assert.equal(uploads, 1)
})

test('adding a video to a standalone sports article supplies topic media context', async t => {
  const root = temporary(t)
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article()], sources: [], excluded: [] }) })
  t.after(() => service.close())
  service.start(startInput('sports-source-001')); await service.waitForIdle()
  const id = service.overview().jobs[0].id
  const updated = service.updateSource(id, { youtubeUrl: 'https://www.youtube.com/watch?v=rhZ6oVlNZHs' })
  assert.equal(updated.game, undefined)
  assert.equal(updated.article.topic.id, 'youtube-rhZ6oVlNZHs')
  assert.equal(updated.article.sourceVideoId, 'rhZ6oVlNZHs')
  const replacement = service.updateSource(id, { youtubeUrl: 'https://www.youtube.com/watch?v=sdV-PacdYdY' })
  assert.equal(replacement.article.topic.id, 'youtube-sdV-PacdYdY')
  assert.equal(replacement.article.topic.youtubeUrl, replacement.article.youtubeUrl)
  assert.throws(() => service.updateSource(id, { youtubeUrl: 'https://www.youtube.com/@NBA/videos' }), /单条/)
})

test('a legacy factual rejection does not block a valid delivery or draft upload', async t => {
  const root = temporary(t); let uploads = 0
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article()], sources: [], excluded: [] }),
    produce: async input => ({ ...await production(input), review: { passed: false, issues: ['旧规则拒绝正常译述'], checkedAt: new Date().toISOString() } }),
    uploadAccount: () => ({ accountName: 'cba_775d8aec569e4c888105e9790c463a8c', label: '体育', status: 'ready', message: '已登录' }),
    upload: async () => { uploads++; return { saved: true, message: '已保存草稿' } } })
  t.after(() => service.close())
  service.start(startInput('translation-no-review-001', true)); await service.waitForIdle()
  const job = service.overview().jobs[0]
  assert.equal(job.status, 'completed')
  assert.equal(job.canUpload, true)
  service.startUpload({ requestId: 'translation-no-review-upload-001', jobIds: [job.id] }); await service.waitForIdle()
  assert.equal(uploads, 1)
})

test('stop cancels work, preserves its checkpoint, and leaves later jobs untouched', async t => {
  const root = temporary(t)
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article('one'), article('two')], sources: [], excluded: [] }),
    produce: async input => {
      input.checkpoint({ script: { title: '保存稿件', text: '中文译述', facts: [] } }); entered()
      await new Promise<void>((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
      return {}
    } })
  t.after(() => service.close())
  const run = service.start(startInput('stop-production-001', true)); await started
  const processing = service.overview().activeProcessing!
  const nextCollection = service.start(startInput('can-collect-during-production'))
  service.stop(processing.id); await service.waitForIdle()
  const jobs = service.overview().jobs
  assert.equal(jobs.find(job => job.article.id === 'one')!.status, 'stopped')
  assert.equal(service.detail(jobs.find(job => job.article.id === 'one')!.id).script.text, '中文译述')
  assert.equal(jobs.find(job => job.article.id === 'two')!.attempts, 0)
  assert.equal(service.overview().runs.find(item => item.id === processing.id)!.status, 'stopped')
  assert.equal(service.overview().runs.find(item => item.id === run.id)!.status, 'completed')
  assert.equal(service.overview().runs.find(item => item.id === nextCollection.id)!.status, 'completed')
  assert.equal(fs.existsSync(path.join(root, '.production.lock')), false)
})

test('restart makes an interrupted run resumable without starting production', async t => {
  const root = temporary(t)
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article()], sources: [], excluded: [] }) })
  service.start(startInput()); await service.waitForIdle(); await service.close()
  const id = service.overview().jobs[0].id
  const stateFile = path.join(root, '.console.json'), state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.runs[0].status = 'running'; fs.writeFileSync(stateFile, JSON.stringify(state))
  const jobFile = path.join(root, 'jobs', id, 'job.json'), job = JSON.parse(fs.readFileSync(jobFile, 'utf8'))
  job.status = 'running'; fs.writeFileSync(jobFile, JSON.stringify(job))
  const restarted = new NbaVideoService({ root, scheduling: false, produce: async () => { throw new Error('must not run on restart') } })
  t.after(() => restarted.close())
  assert.equal(restarted.overview().runs[0].status, 'stopped')
  assert.equal(restarted.overview().jobs[0].status, 'stopped')
  assert.equal(restarted.overview().jobs[0].canResume, true)
})

test('a second service sees the active owner and cannot mark it interrupted or start overlapping work', async t => {
  const root = temporary(t); let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const first = new NbaVideoService({ root, scheduling: false, collect: async () => { await pending; return { articles: [], sources: [], excluded: [] } } })
  t.after(() => first.close())
  first.start(startInput()); await Promise.resolve()
  const second = new NbaVideoService({ root, scheduling: false }); t.after(() => second.close())
  assert.equal(second.overview().activeRun?.status, 'running')
  assert.throws(() => second.start(startInput('second-service-start')), /已有 NBA/)
  finish(); await first.waitForIdle()
  assert.equal(second.overview().activeRun, null)
})

test('scheduled collection is opt-in, respects its interval, and preserves selected languages', async t => {
  const root = temporary(t); let now = new Date('2026-11-04T00:00:00Z'), calls = 0
  const service = new NbaVideoService({ root, scheduling: false, now: () => now,
    collectChannels: async input => { calls++; assert.deepEqual(input.languages, ['en']); assert.deepEqual(input.youtubeChannels, NBA_DEFAULT_SETTINGS.youtubeChannels); return { articles: [], videos: [], sources: [], excluded: [] } } })
  t.after(() => service.close())
  await service.tick(); assert.equal(calls, 0)
  service.settings({ ...NBA_DEFAULT_SETTINGS, languages: ['en'], scheduleEnabled: true, intervalMinutes: 5 })
  await service.tick(); assert.equal(calls, 0)
  now = new Date(now.getTime() + 5 * 60_000)
  await service.tick(); await service.waitForIdle(); assert.equal(calls, 1)
  await service.tick(); assert.equal(calls, 1)
})

test('the workbench can stop a run owned by another backend instance', async t => {
  const root = temporary(t)
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const first = new NbaVideoService({ root, scheduling: false, collect: async input => {
    entered()
    await new Promise<void>((resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }))
    return { articles: [], sources: [], excluded: [] }
  } })
  t.after(() => first.close())
  const run = first.start(startInput('remote-stop-run-001')); await started
  const second = new NbaVideoService({ root, scheduling: false }); t.after(() => second.close())
  assert.equal(second.stop(run.id).status, 'stopping')
  await first.waitForIdle()
  assert.equal(second.overview().runs[0].status, 'stopped')
  assert.equal(fs.existsSync(path.join(root, '.collection-stop-request.json')), false)
})

test('supplementing a source retains editorial work and invalidates only the old media and delivery', async t => {
  const root = temporary(t)
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article()], sources: [], excluded: [] }), produce: async input => {
    input.checkpoint({ script: { title: '独立稿件', text: '原有中文稿', facts: [] } }); return production(input)
  } })
  t.after(() => service.close())
  service.start(startInput('replace-source-001', true)); await service.waitForIdle()
  const before = service.overview().jobs[0]
  const updated = service.updateSource(before.id, { youtubeUrl: 'https://www.youtube.com/watch?v=vDdPLHaKK4k' })
  assert.equal(updated.script.text, '原有中文稿')
  assert.equal(updated.article.body, article().body)
  assert.equal(updated.delivery, undefined)
  assert.equal(updated.media, undefined)
  assert.equal(updated.canResume, true)
  assert.equal(updated.stage, 'media')
})

test('delete requires the expected title and never removes shared match footage', async t => {
  const root = temporary(t)
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article()], sources: [], excluded: [] }) })
  t.after(() => service.close())
  service.start(startInput()); await service.waitForIdle()
  const job = service.overview().jobs[0], shared = path.join(root, 'shared', 'original.mp4')
  fs.writeFileSync(shared, 'shared-source')
  assert.throws(() => service.deleteTask(job.id, 'different title'), /标题/)
  service.deleteTask(job.id, job.title)
  assert.equal(fs.readFileSync(shared, 'utf8'), 'shared-source')
  assert.equal(service.overview().stats.total, 0)
})

test('independent portrait covers are registered assets and local paths stay private', async t => {
  const root = temporary(t)
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article()], sources: [], excluded: [] }),
    produce: async input => {
      const result = await production(input)
      const coverPath = path.join(input.jobDir, 'landscape.png'), portraitCoverPath = path.join(input.jobDir, 'portrait.png')
      fs.writeFileSync(coverPath, 'landscape'); fs.writeFileSync(portraitCoverPath, 'portrait')
      return { ...result, delivery: { ...result.delivery, coverPath, portraitCoverPath } }
    } })
  t.after(() => service.close())
  service.start(startInput('portrait-cover-assets-001', true)); await service.waitForIdle()
  const id = service.overview().jobs[0].id, detail = service.detail(id)
  assert.equal(detail.assets.portraitCover, `/api/v1/nba-video/jobs/${id}/assets/portraitCover`)
  assert.equal(detail.assets.cover, `/api/v1/nba-video/jobs/${id}/assets/cover`)
  assert.equal(service.asset(id, 'portraitCover').type, 'image/png')
  assert.equal(fs.readFileSync(service.asset(id, 'portraitCover').path, 'utf8'), 'portrait')
  assert.equal('portraitCoverPath' in detail.delivery, false)
  assert.equal('coverPath' in detail.delivery, false)
  assert.equal('videoPath' in detail.delivery, false)
})

test('registered media cannot escape the asset root through symlinks', async t => {
  const root = temporary(t)
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article()], sources: [], excluded: [] }), produce: production })
  t.after(() => service.close())
  service.start(startInput('asset-boundary-001', true)); await service.waitForIdle()
  const job = service.overview().jobs[0], file = service.asset(job.id, 'video').path
  const outside = path.join(os.tmpdir(), `nba-outside-${Date.now()}`)
  fs.writeFileSync(outside, 'outside'); t.after(() => fs.rmSync(outside, { force: true }))
  fs.unlinkSync(file); fs.symlinkSync(outside, file)
  assert.throws(() => service.asset(job.id, 'video'), (error: any) => error.status === 404)
})

test('same-size video corruption becomes repairable without hashing unchanged files every poll', async t => {
  const root = temporary(t)
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => ({ articles: [article()], sources: [], excluded: [] }), produce: production })
  t.after(() => service.close())
  service.start(startInput('corruption-check-001', true)); await service.waitForIdle()
  const job = service.overview().jobs[0], file = service.asset(job.id, 'video').path
  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 120))
  const changed = service.detail(job.id)
  assert.equal(changed.status, 'attention'); assert.equal(changed.canResume, true); assert.equal(changed.assets.video, undefined)
  assert.equal(service.overview().stats.completed, 0)
  service.resume({ requestId: 'repair-corruption-001', jobIds: [job.id] }); await service.waitForIdle()
  assert.equal(service.overview().stats.completed, 1)
})

test('channel collection snapshots the configured channels and retains changes made by a second service for the next run', async t => {
  const root = temporary(t), firstChannel = 'https://www.youtube.com/@NBA/videos', secondChannel = 'https://www.youtube.com/@ESPN/videos'
  let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), pending = new Promise<void>(resolve => { finish = resolve })
  let count = 0
  const service = new NbaVideoService({ root, scheduling: false, collect: async () => { throw new Error('Channel mode must not use manual collection') },
    collectChannels: async input => {
      count++
      assert.deepEqual(input.youtubeChannels, count === 1 ? [firstChannel] : [secondChannel])
      assert.equal(input.videosPerChannel, 2)
      if (count === 1) { entered(); await pending }
      else assert.equal(input.existingVideos[0]?.videoId, 'video000001')
      return { articles: count === 1 ? [article()] : [], sources: [], excluded: [], videos: [{ videoId: 'video000001', url: 'https://www.youtube.com/watch?v=video000001', channel: firstChannel,
        title: 'A verified game', status: 'collected', message: 'Saved', articleIds: ['one'] }] }
    } })
  t.after(() => service.close())
  service.channels({ youtubeChannels: [firstChannel] })
  const input = nbaStartSchema.parse({ requestId: 'channel-run-first', autoProduce: false, videosPerChannel: 2 })
  assert.equal(input.collectionMode, 'channels')
  const run = service.start(input); await started
  const editor = new NbaVideoService({ root, scheduling: false }); t.after(() => editor.close())
  editor.channels({ youtubeChannels: [secondChannel] })
  assert.deepEqual(editor.overview().activeRun?.youtubeChannels, [firstChannel])
  finish(); await service.waitForIdle()
  assert.equal(service.overview().runs[0].id, run.id)
  assert.deepEqual(service.overview().settings.youtubeChannels, [secondChannel])
  assert.equal(service.overview().stats.total, 1)
  service.start({ ...input, requestId: 'channel-run-second' }); await service.waitForIdle()
  assert.equal(count, 2)
  assert.throws(() => service.channels({ youtubeChannels: ['https://www.youtube.com/watch?v=vDdPLHaKK4k'] }))
  service.channels({ youtubeChannels: [] })
  assert.throws(() => service.start({ ...input, requestId: 'channel-run-empty' }), /配置至少一个/)
})

test('a channel video awaiting game or news verification remains visible as an attention run', async t => {
  const root = temporary(t)
  const service = new NbaVideoService({ root, scheduling: false, collectChannels: async () => ({ articles: [], excluded: [],
    sources: [{ id: 'channel', label: 'NBA', status: 'partial', count: 1 }], videos: [{ videoId: 'video000001',
      url: 'https://www.youtube.com/watch?v=video000001', channel: NBA_DEFAULT_SETTINGS.youtubeChannels[0]!, title: 'Game pending verification',
      status: 'failed', message: '比赛日期或终场比分不足，可重试', articleIds: [] }] }) })
  t.after(() => service.close())
  service.start(nbaStartSchema.parse({ requestId: 'channel-attention', autoProduce: false })); await service.waitForIdle()
  const run = service.overview().runs[0]
  assert.equal(run.status, 'attention')
  assert.match(run.message, /1 个视频采集待重试/)
  assert.equal(run.videos?.[0]?.status, 'failed')
})

const uploadAccount = () => ({ accountName: 'cba_0123456789abcdef0123456789abcdef', label: '体育', status: 'ready', message: '账号已登录' })
function savedUpload(job: NbaJob, accountName: string): NbaUpload {
  const id = `upload-${job.id}`
  return { id, target: 'baijiahao-video', accountName, accountLabel: '体育', fingerprint: 'a'.repeat(64), inputDigest: job.delivery!.sha256,
    status: 'saved', dispatched: true, message: '已提交百家号', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    payload: { jobId: id, scriptId: 1, target: 'baijiahao-video', publicationMode: 'publish', accountName, fingerprint: 'a'.repeat(64),
      title: '测试新闻', description: '测试新闻 #NBA#', tags: ['#NBA#'], topicPolicy: 'required-exact', videoPath: job.delivery!.videoPath },
    result: { staged: true, saved: false, submitted: true, published: false, publicationStatus: 'submitted', articleId: '123456', accountName, targetId: 'a123', engine: 'fixture',
      editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',
    } }
}

test('direct publications are serial, share the CBA account, and skip an unchanged submitted video', async t => {
  const root = temporary(t), uploads: string[] = []
  const service = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article('one'), article('two')], sources: [], excluded: [] }), produce: production,
    upload: async input => {
      assert.equal(input.accountName, uploadAccount().accountName); assert.equal(input.accountLabel, '体育')
      uploads.push(input.job.id); input.persist(savedUpload(input.job, input.accountName))
      return { saved: true, message: 'Saved' }
    } })
  t.after(() => service.close())
  service.start(startInput('upload-produce-001', true)); await service.waitForIdle()
  const jobIds = service.overview().jobs.map(job => job.id)
  assert.equal(service.overview().stats.waitingUpload, 2)
  const input = { requestId: 'upload-draft-001', jobIds }
  const first = service.startUpload(input)
  assert.equal(service.startUpload(input).id, first.id)
  await service.waitForIdle()
  assert.equal(uploads.length, 2); assert.equal(service.overview().stats.uploaded, 2)
  assert.equal(service.overview().runs[0].status, 'completed')
  const detail = service.detail(jobIds[0]!)
  assert.equal(detail.uploaded, true); assert.equal(detail.canUpload, false)
  assert.equal(detail.uploads[0].status, 'submitted')
  assert.equal(detail.uploads[0].result.articleId, '123456')
  assert.equal(detail.uploads[0].description, '测试新闻 #NBA#')
  assert.equal(JSON.stringify(detail).includes(root), false)
  assert.equal('payload' in detail.uploads[0], false)
  service.settings({ ...NBA_DEFAULT_SETTINGS, speed: 1.2 })
  service.startUpload({ requestId: 'upload-repeat-002', jobIds }); await service.waitForIdle()
  assert.equal(uploads.length, 2)
})

test('published description revisions display only for the bound original article and preserve upload identity', async t => {
  const root = temporary(t), service = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article()], sources: [], excluded: [] }), produce: production })
  t.after(() => service.close())
  service.start(startInput('published-description-view', true)); await service.waitForIdle()
  const id = service.overview().jobs[0]!.id, filename = path.join(root, 'jobs', id, 'job.json')
  const stored: NbaJob = JSON.parse(fs.readFileSync(filename, 'utf8'))
  stored.script = { title: '东契奇42分带队取胜', text: '原有译稿', facts: [] }
  const upload = savedUpload(stored, uploadAccount().accountName)
  upload.result = { ...upload.result!, published: true, publicationStatus: 'published', publishedUrl: 'https://baijiahao.baidu.com/builder/preview/s?id=123456' }
  upload.publishedDescriptionRevision = { verification: 'original_article_server_description', articleId: '123456',
    description: '2026-11-02 NBA｜东契奇42分带队取胜 #NBA#', verifiedAt: new Date().toISOString() }
  stored.uploads = [upload]; fs.writeFileSync(filename, JSON.stringify(stored))
  const detail = service.detail(id)
  assert.equal(detail.uploads[0].description, upload.publishedDescriptionRevision.description)
  assert.equal(detail.canUpload, false)
  assert.equal(detail.publishingDescription, '东契奇42分带队取胜 #NBA#')
  upload.publishedDescriptionRevision.articleId = '999999'; fs.writeFileSync(filename, JSON.stringify(stored))
  assert.equal(service.detail(id).uploads[0].description, upload.payload!.description)
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).uploads[0].payload, upload.payload)
})

test('automatic uploads preserve completed production when saving is uncertain and resume only the original upload', async t => {
  const root = temporary(t); let productions = 0, uploads = 0
  const service = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article('one')], sources: [], excluded: [] }),
    produce: async input => { productions++; return production(input) },
    upload: async input => {
      uploads++
      const receipt = savedUpload(input.job, input.accountName)
      if (uploads === 1) {
        input.persist({ ...receipt, status: 'uncertain', result: undefined, message: '保存结果等待核对' })
        return { saved: false, message: '等待核对原草稿' }
      }
      assert.equal(input.job.uploads?.[0]?.id, receipt.id)
      input.persist(receipt); return { saved: true, message: '已核对原草稿' }
    } })
  t.after(() => service.close())
  service.settings({ ...NBA_DEFAULT_SETTINGS, autoUpload: true })
  service.start(startInput('auto-upload-001', true)); await service.waitForIdle()
  const job = service.overview().jobs[0]
  assert.equal(job.status, 'completed'); assert.equal(job.canResume, false); assert.equal(job.canUpload, true)
  assert.equal(service.overview().runs[0].status, 'attention')
  service.startUpload({ requestId: 'recover-upload-001', jobIds: [job.id] }); await service.waitForIdle()
  assert.equal(productions, 1); assert.equal(uploads, 2)
  assert.equal(service.overview().stats.uploaded, 1)
})

test('the same video bytes in two article jobs create only one publication in the same account', async t => {
  const root = temporary(t); let uploads = 0
  const service = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article('one'), article('two')], sources: [], excluded: [] }),
    produce: async input => {
      const result = await production(input), bytes = Buffer.from('same-actual-video')
      fs.writeFileSync(result.delivery!.videoPath, bytes)
      result.delivery!.bytes = bytes.length; result.delivery!.sha256 = createHash('sha256').update(bytes).digest('hex')
      return result
    },
    upload: async input => { uploads++; input.persist(savedUpload(input.job, input.accountName)); return { saved: true, message: 'Saved' } } })
  t.after(() => service.close())
  service.start(startInput('same-file-produce', true)); await service.waitForIdle()
  service.startUpload({ requestId: 'same-file-upload', jobIds: service.overview().jobs.map(job => job.id) }); await service.waitForIdle()
  assert.equal(uploads, 1)
  assert.equal(service.overview().stats.waitingUpload, 0)
  assert.equal(service.overview().runs[0].status, 'completed')
})

test('different narrations of the same source cannot create a second publication and preserve the first receipt', async t => {
  const root = temporary(t), uploads: string[] = []
  const service = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article('first'), article('second')], sources: [], excluded: [] }), produce: production,
    upload: async input => { uploads.push(input.job.id); input.persist(savedUpload(input.job, input.accountName)); return { saved: true, message: 'Submitted' } } })
  t.after(() => service.close())
  service.start(startInput('different-narration-setup', true)); await service.waitForIdle()
  const jobs = service.overview().jobs
  for (const job of jobs) {
    const filename = path.join(root, 'jobs', job.id, 'job.json'), stored: NbaJob = JSON.parse(fs.readFileSync(filename, 'utf8'))
    stored.article.youtubeUrl = 'https://www.youtube.com/watch?v=vDdPLHaKK4k'
    stored.createdAt = stored.article.id === 'first' ? '2026-11-01T00:00:00.000Z' : '2026-11-02T00:00:00.000Z'
    fs.writeFileSync(filename, JSON.stringify(stored))
  }
  service.startUpload({ requestId: 'different-narration-upload', jobIds: jobs.map(job => job.id) }); await service.waitForIdle()
  assert.equal(uploads.length, 1)
  const first = service.overview().jobs.find(job => job.article.id === 'first')!, second = service.overview().jobs.find(job => job.article.id === 'second')!
  assert.equal(uploads[0], first.id)
  assert.equal(second.canUpload, false)
  assert.equal(second.uploaded, false, 'a sibling submission is not this narration being submitted')
  assert.equal(second.duplicateFootageOf, first.id)
  assert.equal(service.overview().runs[0].status, 'completed')
  service.startUpload({ requestId: 'different-narration-repeat', jobIds: [second.id, first.id] }); await service.waitForIdle()
  assert.equal(uploads.length, 1)
  assert.equal(service.detail(first.id).uploads[0].status, 'submitted')
})

test('an uncertain source upload blocks siblings but permits recovery of the original job', async t => {
  const root = temporary(t), uploads: string[] = []
  const service = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article('first'), article('second')], sources: [], excluded: [] }), produce: production,
    upload: async input => { uploads.push(input.job.id); input.persist(savedUpload(input.job, input.accountName)); return { saved: true, message: 'Recovered' } } })
  t.after(() => service.close())
  service.start(startInput('uncertain-source-setup', true)); await service.waitForIdle()
  const jobs = service.overview().jobs
  let originalId = ''
  for (const job of jobs) {
    const filename = path.join(root, 'jobs', job.id, 'job.json'), stored: NbaJob = JSON.parse(fs.readFileSync(filename, 'utf8'))
    stored.article.youtubeUrl = 'https://www.youtube.com/watch?v=vDdPLHaKK4k'
    if (stored.article.id === 'second') {
      originalId = stored.id
      stored.uploads = [{ ...savedUpload(stored, uploadAccount().accountName), status: 'uncertain', result: undefined }]
    }
    fs.writeFileSync(filename, JSON.stringify(stored))
  }
  service.startUpload({ requestId: 'uncertain-source-recover', jobIds: jobs.map(job => job.id) }); await service.waitForIdle()
  assert.deepEqual(uploads, [originalId])
  assert.equal(service.detail(originalId).uploads[0].status, 'submitted')
})

test('a quality hold retains historical assets and receipts while blocking resume and upload', async t => {
  const root = temporary(t); let productions = 0, uploads = 0
  const service = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article()], sources: [], excluded: [] }),
    produce: input => { productions++; return production(input) }, upload: async () => { uploads++; return { saved: true, message: 'Must not upload' } } })
  t.after(() => service.close())
  service.start(startInput('quality-hold-setup', true)); await service.waitForIdle()
  const id = service.overview().jobs[0].id, filename = path.join(root, 'jobs', id, 'job.json')
  const stored: NbaJob = JSON.parse(fs.readFileSync(filename, 'utf8'))
  stored.uploads = [savedUpload(stored, uploadAccount().accountName)]
  ;(stored as any).qualityHold = { reason: '用户报告：网页杂项进入配音，禁止继续发表', detectedAt: new Date().toISOString(), source: 'user-report' }
  fs.writeFileSync(filename, JSON.stringify(stored))
  const held = service.detail(id)
  assert.equal(held.status, 'attention'); assert.equal(held.canUpload, false); assert.equal(held.uploaded, false); assert.equal(held.canResume, false)
  assert.ok(held.assets.video); assert.equal(held.uploads[0].result.submitted, true)
  service.resume({ requestId: 'quality-hold-resume', jobIds: [id] }); await service.waitForIdle()
  assert.equal(productions, 1); assert.equal(uploads, 0)
  assert.equal(service.detail(id).uploads[0].result.submitted, true)
})

test('a legacy saved draft remains eligible for in-place direct publication', async t => {
  const root = temporary(t); let calls = 0
  const service = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article('legacy-draft')], sources: [], excluded: [] }), produce: production,
    upload: async input => { calls++; input.persist(savedUpload(input.job, input.accountName)); return { saved: false, message: '已提交发表' } } })
  t.after(() => service.close())
  service.start(startInput('legacy-draft-intake', true)); await service.waitForIdle()
  const job = service.overview().jobs[0], filename = path.join(root, 'jobs', job.id, 'job.json')
  const stored: NbaJob = JSON.parse(fs.readFileSync(filename, 'utf8')), old = savedUpload(stored, uploadAccount().accountName)
  old.payload = { ...old.payload!, publicationMode: 'draft', description: old.payload!.title, tags: undefined, topicPolicy: undefined }
  old.result = { ...old.result!, saved: true, submitted: undefined, publicationStatus: undefined, articleId: undefined,
    draftUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123456' }
  stored.uploads = [old]; fs.writeFileSync(filename, JSON.stringify(stored))
  assert.equal(service.detail(job.id).uploaded, false)
  assert.equal(service.detail(job.id).canUpload, true)
  service.startUpload({ requestId: 'legacy-draft-publish', jobIds: [job.id] }); await service.waitForIdle()
  assert.equal(calls, 1); assert.equal(service.detail(job.id).uploaded, true)
  service.startUpload({ requestId: 'legacy-draft-no-duplicate', jobIds: [job.id] }); await service.waitForIdle()
  assert.equal(calls, 1)
})

function retryableMediaFailure() {
  return Object.assign(new Error('Media connection reset'), { code: 'NBA_ATTENTION', stage: 'media', retryable: true, recoveryCode: 'youtube_network' })
}

test('a transient media failure retries from persisted checkpoints and uploads the completed video only once', async t => {
  const root = temporary(t), waits: number[] = []
  let calls = 0, scripts = 0, reviews = 0, uploads = 0
  const checkpoint: Partial<NbaJob> = {
    script: { title: 'Saved commentary', text: 'Previously paid commentary.', facts: [] },
    review: { passed: true, issues: [], checkedAt: new Date().toISOString() },
    media: { id: 'same-game', gameId: 'game-one', sourceUrl: 'https://www.youtube.com/watch?v=vDdPLHaKK4k',
      path: path.join(root, 'shared', 'media.mp4'), duration: 60, fps: 30, width: 1920, height: 1080,
      sha256: 'a'.repeat(64), verified: false, verificationNotes: [] },
  }
  const service: NbaVideoService = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article('one')], sources: [], excluded: [] }),
    waitForMediaRetry: async (ms, signal) => {
      waits.push(ms); assert.equal(signal.aborted, false)
      assert.match(service.overview().activeRun!.message, /1\/2.*5/)
      assert.equal(service.overview().jobs[0].status, 'running')
    },
    produce: async input => {
      calls++
      if (!input.job.script) scripts++
      if (!input.job.review) reviews++
      if (calls === 1) { input.checkpoint(checkpoint); throw retryableMediaFailure() }
      const persisted = JSON.parse(fs.readFileSync(path.join(input.jobDir, 'job.json'), 'utf8'))
      for (const field of ['script', 'review', 'media'] as const) {
        assert.deepEqual(input.job[field], checkpoint[field])
        assert.deepEqual(input.job[field], persisted[field])
      }
      return production(input)
    },
    upload: async input => { uploads++; input.persist(savedUpload(input.job, input.accountName)); return { saved: true, message: 'Saved' } },
  })
  t.after(() => service.close())
  service.settings({ ...NBA_DEFAULT_SETTINGS, autoUpload: true })
  service.start(startInput('media-network-recovers', true)); await service.waitForIdle()
  assert.equal(calls, 2); assert.equal(scripts, 1); assert.equal(reviews, 1); assert.equal(uploads, 1)
  assert.deepEqual(waits, [5_000])
  const job = service.overview().jobs[0]
  assert.equal(job.status, 'completed'); assert.equal(job.attempts, 2)
  assert.equal(service.overview().runs[0].status, 'completed')
  assert.ok(job.logs.some((entry: { message: string }) => /1\/2/.test(entry.message)))
  service.resume({ requestId: 'media-reuse-delivery', jobIds: [job.id] }); await service.waitForIdle()
  assert.equal(calls, 2); assert.equal(uploads, 1)
})

test('media network recovery stops after two extra attempts and leaves the failed checkpoint resumable', async t => {
  const root = temporary(t), waits: number[] = [], produced: string[] = []
  const service = new NbaVideoService({ root, scheduling: false,
    collect: async () => ({ articles: [article('one'), article('two')], sources: [], excluded: [] }),
    waitForMediaRetry: async ms => { waits.push(ms) },
    produce: async input => {
      produced.push(input.job.article.id)
      if (input.job.article.id === 'two') return production(input)
      input.checkpoint({ script: { title: 'Preserved script', text: 'Original commentary.', facts: [] } })
      throw retryableMediaFailure()
    },
  })
  t.after(() => service.close())
  service.start(startInput('media-network-exhausted', true)); await service.waitForIdle()
  assert.deepEqual(waits, [5_000, 15_000])
  assert.deepEqual(produced, ['one', 'one', 'one', 'two'])
  const jobs = service.overview().jobs, one = jobs.find(job => job.article.id === 'one')!, two = jobs.find(job => job.article.id === 'two')!
  assert.equal(one.status, 'attention'); assert.equal(one.stage, 'media'); assert.equal(one.canResume, true); assert.equal(one.attempts, 3)
  assert.equal(service.detail(one.id).script.text, 'Original commentary.')
  assert.ok(one.logs.some((entry: { message: string }) => /2\/2/.test(entry.message)))
  assert.equal(two.status, 'completed')
  assert.equal(service.overview().runs[0].status, 'attention')
})

for (const scenario of [
  { name: 'a media login challenge', fields: { stage: 'media', retryable: false, recoveryCode: 'youtube_login_required' } },
  { name: 'an unclassified media failure', fields: { stage: 'media' } },
  { name: 'a factual review failure', fields: { stage: 'review', retryable: true } },
  { name: 'a voice service failure', fields: { stage: 'voice', retryable: true } },
]) {
  test(`${scenario.name} does not automatically retry production`, async t => {
    const root = temporary(t), waits: number[] = []
    let calls = 0
    const service = new NbaVideoService({ root, scheduling: false,
      collect: async () => ({ articles: [article('one')], sources: [], excluded: [] }),
      waitForMediaRetry: async ms => { waits.push(ms) },
      produce: async () => { calls++; throw Object.assign(new Error(scenario.name), { code: 'NBA_ATTENTION', ...scenario.fields }) },
    })
    t.after(() => service.close())
    service.start(startInput(`no-retry-${scenario.fields.stage}-${scenario.name.length}`, true)); await service.waitForIdle()
    assert.equal(calls, 1); assert.deepEqual(waits, [])
    assert.equal(service.overview().jobs[0].status, 'attention')
    assert.equal(service.overview().jobs[0].canResume, true)
  })
}

test('stopping during media backoff cancels the wait and never retries or starts later jobs', async t => {
  const root = temporary(t), waits: number[] = [], produced: string[] = []
  let entered!: () => void, uploads = 0
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const service = new NbaVideoService({ root, scheduling: false, uploadAccount,
    collect: async () => ({ articles: [article('one'), article('two')], sources: [], excluded: [] }),
    waitForMediaRetry: async (ms, signal) => {
      waits.push(ms); entered()
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    produce: async input => {
      produced.push(input.job.article.id)
      input.checkpoint({ script: { title: 'Saved script', text: 'Retained while waiting.', facts: [] } })
      throw retryableMediaFailure()
    },
    upload: async () => { uploads++; return { saved: false, message: 'Must not dispatch' } },
  })
  t.after(() => service.close())
  service.settings({ ...NBA_DEFAULT_SETTINGS, autoUpload: true })
  const collection = service.start(startInput('stop-media-backoff', true))
  await Promise.race([waiting, service.waitForIdle()])
  const waitingRun = service.overview().activeProcessing!
  service.stop(waitingRun.id); await service.waitForIdle()
  assert.deepEqual(waits, [5_000]); assert.deepEqual(produced, ['one']); assert.equal(uploads, 0)
  assert.equal(waitingRun.status, 'running'); assert.match(waitingRun.message, /1\/2/)
  const jobs = service.overview().jobs, one = jobs.find(job => job.article.id === 'one')!, two = jobs.find(job => job.article.id === 'two')!
  assert.equal(one.status, 'stopped'); assert.equal(one.attempts, 1); assert.equal(one.canResume, true)
  assert.equal(service.detail(one.id).script.text, 'Retained while waiting.')
  assert.equal(two.status, 'queued'); assert.equal(two.attempts, 0)
  assert.equal(service.overview().runs[0].status, 'stopped')
  assert.equal(service.overview().runs.find(run => run.id === collection.id)!.status, 'completed')
  assert.equal(fs.existsSync(path.join(root, '.production.lock')), false)
  await service.close()
  const restarted = new NbaVideoService({ root, scheduling: false, produce: async () => { throw new Error('Restart must stay idle') } })
  t.after(() => restarted.close())
  assert.equal(restarted.detail(one.id).status, 'stopped')
  assert.equal(restarted.detail(one.id).script.text, 'Retained while waiting.')
  assert.equal(restarted.overview().activeRun, null)
})
