import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { NbaVideoService, nbaStartSchema } from './nba-video.js'
import { type NbaArticle, type NbaChannelVideo, type NbaJob, type NbaProductionInput, type NbaUpload } from './nba-types.js'

const stamp = '2026-11-04T00:00:00.000Z'
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const account = () => ({ accountName: 'cba_0123456789abcdef0123456789abcdef', label: 'Sports', status: 'ready', message: 'Ready' })
const article = (id: string): NbaArticle => ({
  id, url: `https://example.test/news/${id}`, title: `Original article ${id}`, language: 'en', publisher: 'Example',
  body: `Full report ${id}. `.repeat(110), bodyHash: sha256(id), wordCount: 330, characterCount: 0, collectedAt: stamp,
})
const manual = (requestId: string, autoProduce = false) => nbaStartSchema.parse({ requestId, collectionMode: 'manual', autoProduce })
function setup(t: TestContext, options: Omit<NonNullable<ConstructorParameters<typeof NbaVideoService>[0]>, 'root' | 'scheduling'>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nba-orchestration-')))
  const service = new NbaVideoService({ ...options, root, scheduling: false, uploadAccount: options.uploadAccount || account })
  t.after(async () => {
    try { await service.close() }
    finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  return { root, service }
}
async function production(input: NbaProductionInput): Promise<Partial<NbaJob>> {
  const videoPath = path.join(input.jobDir, 'video.mp4')
  const bytes = Buffer.from('same-final-video-bytes')
  fs.writeFileSync(videoPath, bytes)
  return {
    script: { title: input.job.article.title, text: 'Independent commentary.', facts: [] },
    review: { passed: true, issues: [], checkedAt: stamp },
    delivery: { videoPath, duration: 1, bytes: bytes.length, sha256: sha256(bytes), verification: { fixture: true } },
  }
}

test('a final state save failure releases the execution and run lock after storage is repaired', async t => {
  const errors: string[] = []
  t.mock.method(console, 'error', (...values: unknown[]) => { errors.push(values.join(' ')) })
  let retainedState = ''
  const { root, service } = setup(t, {
    collect: async () => ({ articles: [article('one')], sources: [], excluded: [] }),
    produce: production,
    upload: async () => {
      const stateFile = path.join(root, '.console.json')
      retainedState = fs.readFileSync(stateFile, 'utf8')
      fs.unlinkSync(stateFile)
      fs.mkdirSync(stateFile)
      throw new Error('simulated state-save outage')
    },
  })
  service.start(manual('storage-produce-one', true))
  await service.waitForIdle()
  const job = service.overview().jobs[0]!
  service.startUpload({ requestId: 'storage-upload-one', jobIds: [job.id] })
  await assert.doesNotReject(service.waitForIdle())
  assert.ok(errors.some(message => /EISDIR|NBA 状态文件无法读取：\.console\.json/.test(message)), errors.join('\n'))
  assert.equal(fs.existsSync(path.join(root, '.production.lock')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'jobs', job.id, 'job.json'), 'utf8')).status, 'completed')

  const stateFile = path.join(root, '.console.json')
  fs.rmdirSync(stateFile)
  fs.writeFileSync(stateFile, retainedState)
  service.start(manual('storage-recovered-one'))
  await service.waitForIdle()
  assert.equal(service.overview().activeRun, null)
  assert.equal(service.overview().runs[0]!.status, 'completed')
  assert.equal(fs.existsSync(path.join(root, '.production.lock')), false)
})

test('an upload queue commit failure dispatches nothing and permits retrying the same request after repair', async t => {
  let outageArmed = false, outages = 0, uploads = 0
  const { root, service } = setup(t, {
    collect: async () => ({ articles: [article('prepare-one')], sources: [], excluded: [] }),
    produce: production,
    upload: async input => {
      uploads++
      const id = `upload-${input.job.id}`, fingerprint = sha256(id)
      input.persist({
        id, target: 'baijiahao-video', accountName: input.accountName, accountLabel: input.accountLabel,
        fingerprint, inputDigest: input.job.delivery!.sha256, status: 'saved', dispatched: true,
        message: 'Saved', createdAt: stamp, updatedAt: stamp,
        payload: { jobId: id, scriptId: 1, target: 'baijiahao-video', publicationMode: 'publish', accountName: input.accountName,
          title: input.job.title, description: input.job.title, fingerprint, videoPath: input.job.delivery!.videoPath },
        result: { staged: true, saved: false, submitted: true, published: false, publicationStatus: 'submitted', articleId: '123456', accountName: input.accountName, targetId: 'abc123', engine: 'fixture',
          editorUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2',
          draftUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=videoV2&article_id=123456' },
      })
      return { saved: true, message: 'Saved' }
    },
  })
  service.start(manual('prepare-produce-one', true))
  await service.waitForIdle()
  const job = service.overview().jobs[0]!
  const stateFile = path.join(root, '.console.json')
  const previousState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const renameSync = fs.renameSync
  t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (outageArmed && String(destination) === stateFile) {
      outageArmed = false; outages++
      throw Object.assign(new Error('simulated NBA console commit failure'), { code: 'EIO' })
    }
    return renameSync(source, destination)
  })
  outageArmed = true
  const request = { requestId: 'prepare-upload-failure', jobIds: [job.id] }
  assert.throws(() => service.startUpload(request), (error: NodeJS.ErrnoException) => error.code === 'EIO')
  await service.waitForIdle()
  assert.equal(outages, 1)
  assert.equal(uploads, 0)
  assert.equal(fs.existsSync(path.join(root, '.production.lock')), false)
  assert.equal(fs.existsSync(path.join(root, '.console.lock')), false)
  const failedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.deepEqual(failedState.requests, previousState.requests)
  assert.deepEqual(failedState.runs, previousState.runs)
  assert.equal(service.overview().runs.some(run => run.requestId === request.requestId), false)
  service.startUpload(request)
  await service.waitForIdle()
  assert.equal(uploads, 1)
  assert.equal(service.overview().runs[0]!.status, 'completed')
  assert.equal(service.detail(job.id).status, 'completed')
  assert.equal(service.overview().stats.uploaded, 1)
  assert.equal(fs.existsSync(path.join(root, '.production.lock')), false)
})

test('a failed article save leaves channel history uncommitted so the video can be collected again', async t => {
  const source = article('channel-one')
  const jobId = `nba-${sha256(source.bodyHash + source.url).slice(0, 20)}`
  const channel = 'https://www.youtube.com/@NBA/videos'
  const video: NbaChannelVideo = {
    videoId: 'video000001', url: 'https://www.youtube.com/watch?v=video000001', channel,
    title: 'Verified game', status: 'collected', message: 'Saved', articleIds: [source.id],
  }
  let collections = 0
  const { root, service } = setup(t, {
    collectChannels: async input => {
      collections++
      assert.deepEqual(input.existingVideos, [])
      if (collections === 1) fs.mkdirSync(path.join(root, 'jobs', jobId, 'job.json'), { recursive: true })
      return { articles: [source], videos: [video], sources: [], excluded: [] }
    },
  })
  service.channels({ youtubeChannels: [channel] })
  const first = service.start(nbaStartSchema.parse({ requestId: 'channel-save-failure', autoProduce: false }))
  await service.waitForIdle()
  assert.equal(fs.existsSync(path.join(root, '.channel-history.json')), false)
  const state = JSON.parse(fs.readFileSync(path.join(root, '.console.json'), 'utf8'))
  assert.equal(state.runs.find((run: { id: string }) => run.id === first.id).status, 'failed')
  assert.equal(fs.existsSync(path.join(root, '.production.lock')), false)

  fs.rmdirSync(path.join(root, 'jobs', jobId, 'job.json'))
  service.start(nbaStartSchema.parse({ requestId: 'channel-save-retry', autoProduce: false }))
  await service.waitForIdle()
  assert.equal(collections, 2)
  assert.equal(service.overview().stats.total, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.channel-history.json'), 'utf8')), [video])
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'jobs', jobId, 'job.json'), 'utf8')).article.id, source.id)
})

test('another job with an uncertain dispatched upload blocks the same video in the same account', async t => {
  const uploaded: string[] = []
  const { service } = setup(t, {
    collect: async () => ({ articles: [article('one'), article('two')], sources: [], excluded: [] }),
    produce: production,
    upload: async input => {
      uploaded.push(input.job.id)
      const id = `upload-${input.job.id}`
      const fingerprint = sha256(id)
      const upload: NbaUpload = {
        id, target: 'baijiahao-video', accountName: input.accountName, accountLabel: input.accountLabel,
        fingerprint, inputDigest: input.job.delivery!.sha256, status: 'uncertain', dispatched: true,
        message: 'Response lost', createdAt: stamp, updatedAt: stamp,
        payload: { jobId: id, scriptId: 1, target: 'baijiahao-video', publicationMode: 'draft', accountName: input.accountName,
          title: input.job.title, description: input.job.title, fingerprint, videoPath: input.job.delivery!.videoPath },
      }
      input.persist(upload)
      return { saved: false, message: 'Response lost' }
    },
  })
  service.start(manual('uncertain-produce', true))
  await service.waitForIdle()
  const jobs = service.overview().jobs
  const one = jobs.find(job => job.article.id === 'one')!
  const two = jobs.find(job => job.article.id === 'two')!
  assert.equal(one.delivery.sha256, two.delivery.sha256)
  service.startUpload({ requestId: 'uncertain-original', jobIds: [one.id] })
  await service.waitForIdle()
  service.startUpload({ requestId: 'uncertain-duplicate', jobIds: [two.id] })
  await service.waitForIdle()

  assert.deepEqual(uploaded, [one.id])
  const run = service.overview().runs[0]!
  assert.equal(run.status, 'failed')
  assert.ok(run.message.includes(one.title))
  assert.equal(service.detail(one.id).uploads[0].status, 'uncertain')
  assert.equal(service.detail(one.id).status, 'completed')
  assert.equal(service.detail(two.id).status, 'completed')
  assert.deepEqual(service.detail(two.id).uploads, [])
})
