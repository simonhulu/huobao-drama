import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createNbaVideoRoute } from './nba-video.js'
import { NbaVideoService, nbaStartSchema } from '../services/nba-video.js'

async function fixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nba-route-')))
  const service = new NbaVideoService({ root, scheduling: false,
    uploadAccount: () => ({ accountName: 'cba_0123456789abcdef0123456789abcdef', label: '体育', status: 'ready', message: '已登录' }),
    upload: async () => ({ saved: false, message: 'Offline test: no platform write' }),
    collect: async () => ({ articles: [{ id: 'report', title: '完整英文报道', url: 'https://www.espn.com/nba/report', publisher: 'ESPN', language: 'en',
      body: 'report '.repeat(120), bodyHash: 'abc123', wordCount: 120, characterCount: 0, collectedAt: new Date().toISOString() }], sources: [], excluded: [] }),
    produce: async ({ jobDir }) => {
      const file = path.join(jobDir, 'news.mp4'), bytes = Buffer.from('0123456789')
      fs.writeFileSync(file, bytes)
      return { review: { passed: true, issues: [], checkedAt: new Date().toISOString() }, delivery: { videoPath: file, duration: 1, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), verification: {} } }
    } })
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { app: createNbaVideoRoute({ service }), service }
}
const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })

test('routes validate local writes, strict parameters and idempotent request ids', async t => {
  const { app, service } = await fixture(t)
  assert.equal((await app.request('/runs', json({ requestId: 'valid-request' }, { Origin: 'https://external.example' }))).status, 403)
  assert.equal((await app.request('/runs', { method: 'POST', body: '{}' })).status, 400)
  assert.equal((await app.request('/runs', json({ requestId: 'valid-request', extra: true }))).status, 400)
  const input = nbaStartSchema.parse({ requestId: 'route-request-001', autoProduce: false, collectionMode: 'manual' })
  const first = await app.request('/runs', json(input)); assert.equal(first.status, 202)
  const id = (await first.json()).data.id
  assert.equal((await (await app.request('/runs', json(input))).json()).data.id, id)
  assert.equal((await app.request('/runs', json({ ...input, limit: 20 }))).status, 409)
  await service.waitForIdle()
  const overview = (await (await app.request('/')).json()).data
  assert.equal(overview.jobs.length, 1)
  assert.equal('body' in overview.jobs[0].article, false)
  assert.equal((await app.request('/jobs/unknown')).status, 404)
})

test('collection and saved settings accept up to 100 articles and reject out-of-range quantities', async t => {
  const { app, service } = await fixture(t)
  for (const limit of [21, 100]) {
    const response = await app.request('/runs', json({ requestId: `route-batch-${limit}`, collectionMode: 'manual', limit,
      articleUrls: Array.from({ length: limit }, (_, index) => `https://example.test/news/${index}`), autoProduce: false }))
    assert.equal(response.status, 202, await response.text())
    await service.waitForIdle()
  }
  for (const limit of [0, 100.5, 101]) {
    assert.equal((await app.request('/runs', json({ requestId: 'route-invalid-quantity', limit }))).status, 400)
  }
  assert.equal((await app.request('/runs', json({ requestId: 'route-too-many-links', limit: 100,
    articleUrls: Array.from({ length: 101 }, (_, index) => `https://example.test/news/${index}`) }))).status, 400)
  const defaults = service.overview().settings
  assert.equal(defaults.limit, 6)
  const put = (limit: number) => app.request('/settings', { ...json({ ...defaults, limit }), method: 'PUT' })
  for (const limit of [21, 100]) {
    const response = await put(limit)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).data.limit, limit)
  }
  for (const limit of [0, 100.5, 101]) assert.equal((await put(limit)).status, 400)
  assert.equal(service.overview().settings.limit, 100)
})

test('media supports exact/suffix/open ranges, HEAD, and rejects invalid ranges', async t => {
  const { app, service } = await fixture(t)
  service.start(nbaStartSchema.parse({ requestId: 'range-request-001', autoProduce: true, collectionMode: 'manual' })); await service.waitForIdle()
  const id = service.overview().jobs[0].id, url = `/jobs/${id}/assets/video`
  const collection = service.overview().runs.find(run => run.kind === 'collect')!
  const producerId = collection.productionRunId!
  assert.equal((await app.request(`/runs/${producerId}/resume`, json({}, { Origin: 'https://external.example' }))).status, 403)
  assert.equal((await app.request(`/runs/${producerId}/resume`, json({ unexpected: true }))).status, 400)
  assert.equal((await app.request(`/runs/${collection.id}/resume`, json({}))).status, 409)
  const resumed = await app.request(`/runs/${producerId}/resume`, json({}))
  assert.equal(resumed.status, 202)
  assert.equal((await resumed.json()).data.id, producerId)
  const part = await app.request(url, { headers: { Range: 'bytes=2-5' } })
  assert.equal(part.status, 206); assert.equal(part.headers.get('Content-Range'), 'bytes 2-5/10'); assert.equal(await part.text(), '2345')
  assert.equal(await (await app.request(url, { headers: { Range: 'bytes=-3' } })).text(), '789')
  assert.equal(await (await app.request(url, { headers: { Range: 'bytes=8-' } })).text(), '89')
  assert.equal(await (await app.request(url, { headers: { Range: 'bytes=8-90' } })).text(), '89')
  for (const range of ['bytes=30-', 'bytes=-0', 'bytes=5-2', 'bytes=0-1,4-5', 'bytes=-', 'items=0-2']) {
    const response = await app.request(url, { headers: { Range: range } })
    assert.equal(response.status, 416, range); assert.equal(response.headers.get('Content-Range'), 'bytes */10')
  }
  const head = await app.request(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '')
  assert.equal((await app.request(`/jobs/${id}/assets/secret`)).status, 404)
})

test('channel settings and draft upload endpoints validate local writes and preserve production state', async t => {
  const { app, service } = await fixture(t)
  const put = (body: unknown) => ({ ...json(body), method: 'PUT' })
  assert.equal((await app.request('/channels', put({ youtubeChannels: ['https://example.com/channel'] }))).status, 400)
  const channels = await app.request('/channels', put({ youtubeChannels: ['https://www.youtube.com/@NBA'] }))
  assert.equal(channels.status, 200)
  assert.deepEqual((await channels.json()).data.youtubeChannels, ['https://www.youtube.com/@NBA/videos'])
  assert.equal((await app.request('/uploads', json({ requestId: 'upload-invalid-001', jobIds: ['missing'] }))).status, 404)
  service.start(nbaStartSchema.parse({ requestId: 'upload-route-produce', collectionMode: 'manual', autoProduce: true }))
  await service.waitForIdle()
  const job = service.overview().jobs[0], payload = { requestId: 'route-upload-001', jobIds: [job.id] }
  const first = await app.request('/uploads', json(payload)); assert.equal(first.status, 202)
  const runId = (await first.json()).data.id
  assert.equal((await (await app.request('/uploads', json(payload))).json()).data.id, runId)
  await service.waitForIdle()
  assert.equal(service.detail(job.id).status, 'completed')
  assert.equal(service.overview().runs[0].kind, 'upload')
})
