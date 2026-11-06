import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { NbaVideoService, nbaStartSchema } from './nba-video.js'
import { createNbaVideoRoute } from '../routes/nba-video.js'
import type { NbaArticle, NbaProductionInput } from './nba-types.js'
import { acquireNbaJobLock } from './nba-job-lock.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nba-deletion-')))
  const services: NbaVideoService[] = []
  const release = gate(), started = gate()
  const releases = [release]
  t.after(async () => {
    for (const item of releases) item.resolve()
    for (const service of services) await service.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const articles: NbaArticle[] = ['first', 'unwanted', 'last'].map(id => ({ id, title: `News ${id}`,
    url: `https://example.test/${id}`, publisher: 'Local sports fixture', language: 'en', body: 'Basketball report. '.repeat(110),
    bodyHash: createHash('sha256').update(id).digest('hex'), wordCount: 220, characterCount: 0, collectedAt: new Date().toISOString() }))
  const produced: string[] = [], uploaded: string[] = []
  const produce = async (input: NbaProductionInput) => {
    produced.push(input.job.article.id)
    if (input.job.article.id === 'first') { started.resolve(); await release.promise }
    input.onProgress('render', 'Local deletion test')
    const videoPath = path.join(input.jobDir, 'news.mp4'), bytes = Buffer.from(input.job.id)
    fs.writeFileSync(videoPath, bytes)
    return { delivery: { videoPath, bytes: bytes.length, duration: 1, sha256: createHash('sha256').update(bytes).digest('hex'), verification: {} } }
  }
  const service = new NbaVideoService({ root, scheduling: false, produce,
    collect: async () => ({ articles, sources: [], excluded: [] }),
    uploadAccount: () => ({ accountName: 'cba_0123456789abcdef0123456789abcdef', label: '体育', status: 'ready', message: 'Local test' }),
    upload: async ({ job }) => { uploaded.push(job.article.id); return { saved: false, message: 'Local test only' } },
  })
  services.push(service)
  return { root, service, produced, uploaded, started, release,
    track(service: NbaVideoService, release: ReturnType<typeof gate>) { services.push(service); releases.push(release) },
    reader() { const reader = new NbaVideoService({ root, scheduling: false }); services.push(reader); return reader } }
}

for (const remote of [false, true]) test(`a queued deletion ${remote ? 'from another instance' : 'in the owner'} skips only that job and its automatic upload`, async t => {
  const h = fixture(t)
  h.service.start(nbaStartSchema.parse({ requestId: `delete-queued-${remote}`, collectionMode: 'manual', autoProduce: true, autoUpload: true }))
  await h.started.promise
  const reader = remote ? h.reader() : h.service
  const unwanted = reader.overview().jobs.find(job => job.article.id === 'unwanted')!
  const shared = path.join(h.root, 'shared', 'original.mp4')
  fs.writeFileSync(shared, 'shared footage')
  const app = createNbaVideoRoute({ service: reader })
  const response = await app.request(`/jobs/${unwanted.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedTitle: unwanted.title }) })
  assert.equal(response.status, 200, await response.text())
  if (!remote) assert.equal(h.service.overview().jobs.some(job => job.id === unwanted.id), false)
  assert.equal(reader.overview().jobs.some(job => job.id === unwanted.id), false)
  h.release.resolve()
  await h.service.waitForIdle()
  assert.deepEqual(h.produced, ['first', 'last'])
  assert.deepEqual(h.uploaded, ['first', 'last'])
  assert.equal(fs.existsSync(path.join(h.root, 'jobs', unwanted.id)), false)
  assert.equal(fs.readFileSync(shared, 'utf8'), 'shared footage')
  assert.equal(h.service.overview().runs[0].jobIds.includes(unwanted.id), false)
  assert.throws(() => h.reader().detail(unwanted.id), /不存在/)
})

test('the executor waits for a concurrent deletion and then continues with the next job', async t => {
  const h = fixture(t)
  h.service.start(nbaStartSchema.parse({ requestId: 'delete-claim-race', collectionMode: 'manual', autoProduce: true }))
  await h.started.promise
  const unwanted = h.service.overview().jobs.find(job => job.article.id === 'unwanted')!
  const lock = path.join(h.root, `.job-${unwanted.id}.lock`)
  const release = acquireNbaJobLock(lock)
  const deletion = new Promise<void>(resolve => setTimeout(() => {
    fs.rmSync(path.join(h.root, 'jobs', unwanted.id), { recursive: true })
    release()
    resolve()
  }, 50))
  h.release.resolve()
  await h.service.waitForIdle()
  await deletion
  assert.deepEqual(h.produced, ['first', 'last'])
  assert.equal(h.service.overview().runs[0].status, 'completed')
})

test('running production is protected with a specific deletion reason while queued tasks remain deletable', async t => {
  const h = fixture(t)
  h.service.start(nbaStartSchema.parse({ requestId: 'delete-protect-running', collectionMode: 'manual', autoProduce: true }))
  await h.started.promise
  const reader = h.reader()
  const first = reader.overview().jobs.find(job => job.article.id === 'first')!
  const unwanted = reader.overview().jobs.find(job => job.article.id === 'unwanted')!
  assert.equal(first.canDelete, false)
  assert.match(first.deleteBlockedReason, /停止/)
  assert.equal(unwanted.canDelete, true)
  assert.throws(() => reader.deleteTask(first.id, first.title), /正在制作|停止/)
  assert.throws(() => reader.deleteTask(unwanted.id, 'wrong title'), /标题/)
  assert.equal(fs.existsSync(path.join(h.root, 'jobs', first.id, 'job.json')), true)
  assert.equal(fs.existsSync(path.join(h.root, 'jobs', unwanted.id, 'job.json')), true)
})

test('an upload is protected before it persists a platform checkpoint, while later uploads can be removed', async t => {
  const h = fixture(t)
  h.release.resolve()
  h.service.start(nbaStartSchema.parse({ requestId: 'delete-upload-setup', collectionMode: 'manual', autoProduce: true }))
  await h.service.waitForIdle()
  await h.service.close()
  const started = gate(), release = gate(), uploaded: string[] = []
  const service = new NbaVideoService({ root: h.root, scheduling: false,
    uploadAccount: () => ({ accountName: 'cba_0123456789abcdef0123456789abcdef', label: '体育', status: 'ready', message: 'Local test' }),
    upload: async ({ job }) => {
      uploaded.push(job.article.id)
      if (job.article.id === 'first') { started.resolve(); await release.promise }
      return { saved: false, message: 'Local test only' }
    },
  })
  h.track(service, release)
  const jobs = service.overview().jobs
  const ids = ['first', 'unwanted', 'last'].map(id => jobs.find(job => job.article.id === id)!.id)
  service.startUpload({ requestId: 'delete-upload-running', jobIds: ids })
  await started.promise
  const reader = h.reader()
  const first = reader.detail(ids[0]!)
  const unwanted = reader.detail(ids[1]!)
  assert.equal(first.status, 'completed')
  assert.equal(first.uploads.length, 0)
  assert.equal(first.canDelete, false)
  assert.match(first.deleteBlockedReason, /上传|发表/)
  assert.throws(() => reader.deleteTask(first.id, first.title), /上传|发表/)
  assert.equal(unwanted.canDelete, true)
  reader.deleteTask(unwanted.id, unwanted.title)
  release.resolve()
  await service.waitForIdle()
  assert.deepEqual(uploaded, ['first', 'last'])
})

test('resuming after deleting a task can retain the original batch upload mode without changing global settings', async t => {
  const h = fixture(t)
  h.release.resolve()
  h.service.start(nbaStartSchema.parse({ requestId: 'delete-resume-setup', collectionMode: 'manual', autoProduce: false }))
  await h.service.waitForIdle()
  const jobs = h.service.overview().jobs
  const unwanted = jobs.find(job => job.article.id === 'unwanted')!
  h.service.deleteTask(unwanted.id, unwanted.title)
  const run = h.service.resume({ requestId: 'delete-resume-original-mode',
    jobIds: ['first', 'last'].map(id => jobs.find(job => job.article.id === id)!.id), autoUpload: true })
  assert.equal(run.autoUpload, true)
  assert.equal(h.service.overview().settings.autoUpload, false)
  await h.service.waitForIdle()
  assert.deepEqual(h.produced, ['first', 'last'])
  assert.deepEqual(h.uploaded, ['first', 'last'])
})
