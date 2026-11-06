import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { serve } from '@hono/node-server'
import { createCbaVideoRoute } from './cba-video.js'
import { CbaVideoService } from '../services/cba-video.js'

function fixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cba-video-route-')))
  const jobDir = path.join(root, '2026-10-18-nanjing-guangdong'); fs.mkdirSync(path.join(jobDir, 'renders', 'v'), { recursive: true })
  const news = path.join(jobDir, 'renders', 'v', 'news.mp4'); const highlights = path.join(jobDir, 'renders', 'v', 'highlights.mp4'); const cover = path.join(jobDir, 'renders', 'v', 'news.cover.jpg'); const hcover = path.join(jobDir, 'renders', 'v', 'highlights.cover.jpg'); const srt = path.join(jobDir, 'renders', 'v', 'news.srt')
  for (const file of [news, highlights, cover, hcover, srt]) fs.writeFileSync(file, 'fixture')
  fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify({ status: 'rendered', match: { id: '2026-10-18-nanjing-guangdong', date: '2026-10-18', home: '南京', away: '广东', score: '96–95', seedUrls: ['https://example.com/news'] }, news: { title: '南京险胜广东', summary: '第三节反超。', segments: [{ id: 'n1', text: '正文', mode: 'narration' }] }, highlights: { title: '关键回合', clipIds: [] }, sources: [{ title: '虎扑', url: 'https://example.com/news' }], review: { digest: 'x' }, approval: { digest: 'x' }, outputs: { inputDigest: 'digest', news: { path: news, coverPath: cover, subtitlePath: srt, duration: 176 }, highlights: { path: highlights, coverPath: hcover, duration: 267 }, artifacts: [] } }))
  const service = new CbaVideoService({ root, autoRecover: false, captureHomepage: async () => null,
    pipeline: async () => ({ ready: false, stage: 'writing', message: '离线路由测试' }), accounts: {
    list: () => ({ defaultAccountName: 'cba_fixture' }),
    get: accountName => ({ accountName, label: '测试账号', status: 'ready', message: 'ready' }),
  }, productionCheck: async () => ({ ready: true, message: 'ready' }), launch: () => ({ done: Promise.resolve(0), stop() {} }), uploadStateRoot: path.join(root, 'social-upload') })
  t.after(async () => { await service.waitForIdle(); fs.rmSync(root, { recursive: true, force: true }) })
  return { route: createCbaVideoRoute({ service }), root, service }
}

test('overview exposes job and rejects cross site writes', async t => {
  const { route } = fixture(t)
  const response = await route.request('/')
  assert.equal(response.status, 200); const data = (await response.json()).data
  assert.equal(data.jobs[0].id, '2026-10-18-nanjing-guangdong'); assert.equal(data.jobs[0].news.duration, 176)
  const blocked = await route.request('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ requestId: 'x' }) })
  assert.equal(blocked.status, 403)
})

test('detail and range assets are readable without exposing local paths', async t => {
  const { route } = fixture(t)
  const detail = await route.request('/jobs/2026-10-18-nanjing-guangdong'); const data = (await detail.json()).data
  assert.deepEqual(data.timeline.map((step: any) => step.stage), ['collecting', 'finding_media', 'writing', 'auditing', 'rendering', 'uploading']); assert.equal(data.sources[0].url, 'https://example.com/news'); assert.equal(JSON.stringify(data).includes('/Users/'), false)
  const asset = await route.request('/jobs/2026-10-18-nanjing-guangdong/assets/news', { headers: { Range: 'bytes=1-3' } })
  assert.equal(asset.status, 206); assert.equal((await asset.arrayBuffer()).byteLength, 3); assert.match(asset.headers.get('content-range') || '', /^bytes 1-3\//)
  assert.equal((await route.request('/jobs/2026-10-18-nanjing-guangdong/assets/news', { headers: { Range: 'bytes=99-100' } })).status, 416)
})

test('manual template is downloaded as an attachment', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cba-template-route-')))
  const zip = path.join(root, 'cba-manual-template-fixture.zip')
  fs.writeFileSync(zip, 'zip-fixture')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const service = { manualTemplate: async () => ({ path: zip, filename: path.basename(zip) }) } as any
  const route = createCbaVideoRoute({ service })
  const response = await route.request('/jobs/fixture/manual-template')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/zip')
  assert.match(response.headers.get('content-disposition') || '', /attachment; filename="cba-manual-template-fixture\.zip"/)
  assert.equal(await response.text(), 'zip-fixture')
})

test('DELETE hides a finished task and removes queue scheduling while preserving files and upload evidence', async t => {
  const { route, root, service } = fixture(t)
  const id = '2026-10-18-nanjing-guangdong', jobDir = path.join(root, id), uploadId = 'cba-fixture-upload'
  const intakeDir = path.join(root, 'batches', 'batch-one'); fs.mkdirSync(intakeDir, { recursive: true })
  fs.writeFileSync(path.join(intakeDir, 'intake.json'), JSON.stringify({ items: [{ url: 'https://example.com/news', title: '南京险胜广东', status: 'rendered', jobDir }] }))
  const sauDir = path.join(root, 'social-upload', 'jobs', uploadId); fs.mkdirSync(sauDir, { recursive: true }); fs.writeFileSync(path.join(sauDir, 'state.json'), '{}')
  const timestamp = new Date().toISOString()
  fs.writeFileSync(path.join(root, '.console.json'), JSON.stringify({ version: 1, settings: { autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_fixture' }, validationFailures: { [id]: { stage: 'rendering', message: 'old', detectedAt: timestamp } }, uploads: [{ id: uploadId, jobId: id, kind: 'news', target: 'baijiahao-video', status: 'saved', message: 'saved', fingerprint: 'fingerprint', inputDigest: 'digest', createdAt: timestamp, updatedAt: timestamp, dispatched: true, result: { saved: true, published: false } }], runs: [{ id: 'upload-run', kind: 'upload', status: 'completed', requestId: 'upload-run', inputHash: 'hash', message: 'done', createdAt: timestamp, updatedAt: timestamp, jobId: id, jobIds: [id], logs: [], autoUpload: true, targets: ['baijiahao-video'], baijiahaoAccountName: 'cba_fixture', ownerPid: process.pid, baseline: {} }], resumeQueues: [{ id: 'queue-one', requestId: 'queue-one', inputHash: 'hash', createdAt: timestamp, items: [{ runId: 'upload-run', jobId: id, title: '南京险胜广东' }] }] }))
  const deleteTask = (body: unknown, taskId = id) => route.request(`/jobs/${taskId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await deleteTask({ confirm: true, expectedTitle: '旧标题' })).status, 409)
  const response = await deleteTask({ confirm: true, expectedTitle: '南京险胜广东' }); assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, { id, deleted: true, alreadyDeleted: false, platformDraftsRemain: true })
  assert.equal(fs.existsSync(jobDir), true); assert.equal(fs.existsSync(sauDir), true)
  assert.equal(fs.readFileSync(path.join(jobDir, 'renders/v/news.mp4'), 'utf8'), 'fixture')
  assert.equal(fs.readFileSync(path.join(sauDir, 'state.json'), 'utf8'), '{}')
  const state = JSON.parse(fs.readFileSync(path.join(root, '.console.json'), 'utf8'))
  assert.equal(state.uploads.length, 1); assert.equal(state.uploads[0].result.saved, true)
  assert.equal(state.validationFailures?.[id].message, 'old')
  assert.deepEqual(state.runs.find((run: any) => run.id === 'upload-run').jobIds, [id])
  assert.equal(state.resumeQueues?.length || 0, 0)
  assert.equal(service.overview().jobs.some((job: any) => job.id === id), false); assert.equal((await route.request(`/jobs/${id}`)).status, 404)
  const repeated = await deleteTask({ confirm: true, expectedTitle: '南京险胜广东' }); assert.equal(repeated.status, 200); assert.equal((await repeated.json()).data.alreadyDeleted, true)
})

test('DELETE retains failed and unuploaded media plus publication receipts and never resumes hidden uploads', async t => {
  for (const status of ['queued','failed','uncertain','saved']) {
    const {route,root} = fixture(t)
    const id = '2026-10-18-nanjing-guangdong', jobDir = path.join(root,id), timestamp = new Date().toISOString()
    const source = path.join(jobDir,'source.mp4'); fs.writeFileSync(source,'original footage')
    const checkpoint = path.join(root,'social-upload/jobs/preserved-upload'); fs.mkdirSync(checkpoint,{recursive:true})
    fs.writeFileSync(path.join(checkpoint,'receipt.json'),'platform evidence')
    const upload = {id:'preserved-upload',jobId:id,kind:'news',target:'baijiahao-video',status,message:'网络超时',
      inputDigest:'digest',fingerprint:'fingerprint',createdAt:timestamp,updatedAt:timestamp,dispatched:status!=='queued',
      payload:{jobId:'preserved-upload',scriptId:17,target:'baijiahao-video',fingerprint:'fingerprint',title:'title',description:'description',videoPath:path.join(jobDir,'renders/v/news.mp4')},
      result:status==='saved'?{staged:true,saved:false,published:true,articleId:'12345',publishedUrl:'https://baijiahao.baidu.com/s?id=12345'}:null}
    fs.writeFileSync(path.join(root,'.console.json'),JSON.stringify({version:1,settings:{autoUpload:true,targets:['baijiahao-video']},runs:[],uploads:[upload]}))
    const response = await route.request(`/jobs/${id}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true,expectedTitle:'南京险胜广东'})})
    assert.equal(response.status,200)
    assert.equal(fs.readFileSync(source,'utf8'),'original footage')
    assert.equal(fs.readFileSync(path.join(checkpoint,'receipt.json'),'utf8'),'platform evidence')
    const state = () => JSON.parse(fs.readFileSync(path.join(root,'.console.json'),'utf8'))
    assert.deepEqual(state().uploads,[upload])
    let recoveries = 0
    const recoveryOptions = {root,autoRecover:true,runtime:{inspectSocialUploadCheckpoint:async()=>{recoveries++;throw Error('Hidden uploads must not run')}} as any}
    const restored = new CbaVideoService(recoveryOptions)
    t.after(async()=>{recoveryOptions.autoRecover=false;await restored.waitForIdle()})
    await new Promise<void>(resolve=>queueMicrotask(resolve)); await restored.waitForIdle()
    assert.equal(recoveries,0)
    assert.deepEqual(state().uploads,[upload])
    assert.equal(restored.overview().jobs.length,0)
  }
})

test('DELETE rejects an active task and malformed confirmation without changing files', async t => {
  const { route, root } = fixture(t)
  const id = '2026-10-18-nanjing-guangdong', jobFile = path.join(root, id, 'job.json')
  const before = fs.readFileSync(jobFile), timestamp = new Date().toISOString()
  fs.writeFileSync(path.join(root, '.console.json'), JSON.stringify({ version: 1, settings: { autoUpload: false, targets: ['tencent-video'] }, uploads: [], runs: [{ id: 'active-run', kind: 'resume', status: 'running', requestId: 'active', inputHash: 'hash', message: 'busy', createdAt: timestamp, updatedAt: timestamp, jobId: id, jobIds: [id], logs: [], autoUpload: false, targets: ['tencent-video'], ownerPid: process.pid, baseline: {} }] }))
  const body = (value: unknown) => route.request(`/jobs/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  assert.equal((await body({ confirm: true, expectedTitle: '南京险胜广东' })).status, 409)
  assert.equal((await body({ confirm: false, expectedTitle: '南京险胜广东' })).status, 400)
  assert.deepEqual(fs.readFileSync(jobFile), before)
})

test('cancelling a video while its file read is pending does not close the response twice', async t => {
  const { route } = fixture(t)
  const response = await route.request('/jobs/2026-10-18-nanjing-guangdong/assets/news', { headers: { Range: 'bytes=0-' } })
  const reader = response.body!.getReader()
  assert.ok((await reader.read()).value?.byteLength)
  const pending = reader.read()
  await reader.cancel()
  assert.equal((await pending).done, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await route.request('/')).status, 200)
})

test('closing large video previews during an HTTP range read leaves the service available', async t => {
  const { route, root } = fixture(t)
  const video = path.join(root, '2026-10-18-nanjing-guangdong/renders/v/news.mp4')
  fs.truncateSync(video, 64 * 1024 * 1024)
  const server = serve({ fetch: route.fetch, hostname: '127.0.0.1', port: 0 })
  assert.ok(server instanceof http.Server)
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const asset = `${base}/jobs/2026-10-18-nanjing-guangdong/assets/news`
  for (let round = 0; round < 6; round++) {
    await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<void>((resolve, reject) => {
      const headers = index === 3 ? {} : { Range: `bytes=${index * 65536}-` }
      const request = http.get(asset, { headers, agent: false }, response => {
        assert.equal(response.statusCode, index === 3 ? 200 : 206)
        response.once('error', reject)
        response.once('data', chunk => {
          assert.ok(chunk.byteLength > 0)
          response.once('close', resolve)
          response.destroy()
        })
      })
      request.once('error', reject)
    })))
    // The server must finish cancellation before serving its next overview.
    const overview = await fetch(`${base}/`)
    assert.equal(overview.status, 200)
    assert.equal((await overview.json()).data.jobs[0].id, '2026-10-18-nanjing-guangdong')
  }
})

test('start is idempotent by requestId and validates payload', async t => {
  const { route } = fixture(t)
  const first = await route.request('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'run-one', limit: 1 }) })
  assert.equal(first.status, 202); const firstData = (await first.json()).data
  const second = await route.request('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'run-one', limit: 1 }) })
  assert.equal(second.status, 202); assert.equal((await second.json()).data.run.id, firstData.run.id)
  assert.equal((await route.request('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'run-one', limit: 2 }) })).status, 409)
  assert.equal((await route.request('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'bad!', targets: ['unknown'] }) })).status, 400)
})

test('existing task resume queue has a separate scoped endpoint and validates selection before starting work', async t => {
  const { route, root, service } = fixture(t)
  const id = '2026-10-18-nanjing-guangdong', filename = path.join(root, id, 'job.json')
  const job = JSON.parse(fs.readFileSync(filename, 'utf8')); job.status = 'needs_edit'; job.outputs = null
  fs.writeFileSync(filename, JSON.stringify(job))
  const preview = await route.request('/resume-queue')
  assert.equal(preview.status, 200)
  assert.deepEqual((await preview.json()).data.items.map((item: any) => item.id), [id])
  const post = (body: any, origin?: string) => route.request('/resume-queue', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) })
  for (const jobIds of [[], [id, id], ['../escape']]) assert.equal((await post({ requestId: 'invalid', jobIds })).status, 400)
  assert.equal((await post({ requestId: 'cross-site', jobIds: [id] }, 'https://evil.example')).status, 403)
  assert.equal((await post({ requestId: 'unknown-task', jobIds: ['unknown'] })).status, 409)
  const first = await post({ requestId: 'resume-selected', jobIds: [id] })
  assert.equal(first.status, 202); const queueId = (await first.json()).data.queue.id
  await service.waitForIdle()
  const repeated = await post({ requestId: 'resume-selected', jobIds: [id] })
  assert.equal(repeated.status, 202); assert.equal((await repeated.json()).data.queue.id, queueId)
})

test('source footage is range playable only for a registered local file', async t => {
  const {route,root} = fixture(t)
  const jobId='2026-10-18-nanjing-guangdong', filename=path.join(root,jobId,'job.json')
  const job=JSON.parse(fs.readFileSync(filename,'utf8'))
  const source=path.join(root,jobId,'source.mp4');fs.writeFileSync(source,'0123456789')
  job.media=[{id:'replay',path:source}];fs.writeFileSync(filename,JSON.stringify(job))
  const response=await route.request(`/jobs/${jobId}/source-media/replay`,{headers:{Range:'bytes=3-5'}})
  assert.equal(response.status,206);assert.equal(await response.text(),'345')
  assert.equal(response.headers.get('content-range'),'bytes 3-5/10')
  assert.equal((await route.request(`/jobs/${jobId}/source-media/unknown`)).status,404)
  job.media[0].path='/etc/hosts';fs.writeFileSync(filename,JSON.stringify(job))
  assert.equal((await route.request(`/jobs/${jobId}/source-media/replay`)).status,404)
  fs.unlinkSync(source);job.media[0].path=source;fs.writeFileSync(filename,JSON.stringify(job))
  assert.equal((await route.request(`/jobs/${jobId}/source-media/replay`)).status,404)
})
