import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { prepareScienceMusetalkVideo } from './science-musetalk-video.js'

const exec = promisify(execFile)
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const signal = () => new AbortController().signal
const probe = async (filename: string) => JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', filename])).stdout)

async function clip(filename: string, seconds: number, fps: number, audio: boolean) {
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-f', 'lavfi', '-i', `color=blue:s=360x360:r=${fps}:d=${seconds}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${seconds}`] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : ['-an']), filename])
}

async function fixture(t: TestContext, mainDuration = 1.2, remoteDuration = 1.2, remoteFps = 15) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-musetalk-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const videoPath = path.join(root, 'main.mp4'), remote = path.join(root, 'remote.mp4'), directory = path.join(root, 'presenter')
  await clip(videoPath, mainDuration, 30, true)
  await clip(remote, remoteDuration, remoteFps, true)
  const output = await fs.readFile(remote)
  const identity = { model: 'musetalk-v15', source_revision: '0a89dec45a0192b824e3cf4daf96c239440c5ed8',
    avatar_id: 'xiaolu-r3-fixture', reference_sha256: '1'.repeat(64), fps: remoteFps }
  const state = { submissions: 0, retries: 0, deletes: 0, polls: 0, pending: false, wrongAudio: false, dropSubmission: false, dropSubmissions: 0,
    loadingReads: 0, failedPoll: false, onPoll: undefined as (() => void) | undefined, onResult: undefined as (() => void) | undefined,
    jobs: new Map<string, any>(), uploaded: undefined as Buffer | undefined }
  const server = createServer(async (request, response) => {
    try {
      const send = (data: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)) }
      if (request.url === '/health') { const loading = state.loadingReads-- > 0; send({ ...identity, ok: !loading, status: loading ? 'loading' : 'ready' }); return }
      if (request.url === '/v1/lipsync' && request.method === 'POST') {
        const parts: Buffer[] = []; for await (const part of request) parts.push(part)
        const form = await new Response(Buffer.concat(parts), { headers: { 'Content-Type': request.headers['content-type']! } }).formData()
        const id = String(form.get('request_id')), audio = form.get('audio') as File
        assert.match(id, /^[a-f0-9]{64}$/)
        state.uploaded = Buffer.from(await audio.arrayBuffer())
        state.submissions++
        if (!state.jobs.has(id)) state.jobs.set(id, { ...identity, id, job_id: id, request_id: id,
          audio_sha256: sha(state.uploaded), status: state.pending ? 'running' : 'completed', result_sha256: sha(output) })
        if (state.dropSubmission || state.dropSubmissions > 0) { state.dropSubmission = false; state.dropSubmissions = Math.max(0, state.dropSubmissions - 1); response.destroy(); return }
        send(state.jobs.get(id)); return
      }
      const match = /^\/v1\/jobs\/([a-f0-9]{64})(\/result|\/retry)?$/.exec(request.url || '')
      const job = match && state.jobs.get(match[1]!)
      if (match && job) {
        if (request.method === 'DELETE') { state.deletes++; if (job.status !== 'completed') job.status = 'cancelled'; send(job); return }
        if (match[2] === '/retry' && request.method === 'POST') { state.retries++; job.status = 'completed'; send(job); return }
        if (match[2] === '/result') { state.onResult?.(); response.setHeader('Content-Type', 'video/mp4'); response.end(output); return }
        state.polls++; state.onPoll?.()
        if (state.failedPoll) { response.writeHead(500); response.end(); return }
        send(state.wrongAudio ? { ...job, audio_sha256: '0'.repeat(64) } : job); return
      }
      response.writeHead(404); response.end()
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const previous = new Map(['MUSETALK_API_URL', 'MUSETALK_POLL_INTERVAL_MS', 'MUSETALK_TIMEOUT_MS', 'MUSETALK_UPLOAD_TIMEOUT_MS'].map(name => [name, process.env[name]]))
  t.after(() => { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
  process.env.MUSETALK_API_URL = `http://127.0.0.1:${address.port}`
  process.env.MUSETALK_POLL_INTERVAL_MS = '1'
  process.env.MUSETALK_TIMEOUT_MS = '30000'
  process.env.MUSETALK_UPLOAD_TIMEOUT_MS = '180000'
  return { root, videoPath, directory, state, identity }
}

async function gatedNormalization(t: TestContext, root: string) {
  const realFfmpeg = (await exec('which', ['ffmpeg'])).stdout.trim()
  const bin = path.join(root, 'bin'), started = path.join(root, 'normalization.started'), release = path.join(root, 'normalization.release')
  await fs.mkdir(bin)
  const wrapper = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);
const run=()=>{const result=cp.spawnSync(${JSON.stringify(realFfmpeg)},args,{stdio:'inherit'});process.exit(result.status??1)};
if(args.includes('-n')&&args.includes('libx264')){fs.writeFileSync(${JSON.stringify(started)},String(process.pid));
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);run()}},10)}else run();\n`
  await fs.writeFile(path.join(bin, 'ffmpeg'), wrapper, { mode: 0o700 })
  const previousPath = process.env.PATH
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath })
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`
  return { release: () => fs.writeFile(release, ''), started: async () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      try { await fs.access(started); return } catch {}
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail('the real normalization subprocess must start')
  } }
}

function remoteBudget(t: TestContext) {
  const controller = new AbortController(), budgets: number[] = []
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    budgets.push(milliseconds)
    return milliseconds === 30_000 ? controller.signal : timeout(milliseconds)
  })
  return { expire: () => controller.abort(new DOMException('remote budget expired', 'TimeoutError')), budgets }
}

test('a long narration gets a duration-sized default remote budget and preserves its pending job on expiry', async t => {
  const f = await fixture(t), duration = 1045.056
  const realFfprobe = (await exec('which', ['ffprobe'])).stdout.trim(), bin = path.join(f.root, 'bin')
  await fs.mkdir(bin)
  const wrapper = `#!${process.execPath}\nconst cp=require('node:child_process'),args=process.argv.slice(2);
const result=cp.spawnSync(${JSON.stringify(realFfprobe)},args,{encoding:'utf8'});
if(result.status!==0){process.stderr.write(result.stderr||'ffprobe failed');process.exit(result.status??1)}
const info=JSON.parse(result.stdout);if(args.at(-1)===${JSON.stringify(f.videoPath)}){
for(const stream of info.streams??[])if(stream.codec_type==='video')stream.duration=${JSON.stringify(String(duration))};
if(info.format)info.format.duration=${JSON.stringify(String(duration))}}process.stdout.write(JSON.stringify(info));\n`
  await fs.writeFile(path.join(bin, 'ffprobe'), wrapper, { mode: 0o700 })
  const previousPath = process.env.PATH
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath })
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`
  delete process.env.MUSETALK_TIMEOUT_MS
  const controller = new AbortController(), budgets: number[] = []
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    budgets.push(milliseconds)
    return budgets.length === 1 ? controller.signal : timeout(milliseconds)
  })
  f.state.pending = true
  f.state.onPoll = () => controller.abort(new DOMException('long narration remote budget expired', 'TimeoutError'))
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /long narration remote budget expired/)
  assert.equal(budgets[0], Math.ceil(duration * 1000), 'the first remote deadline must be based on the probed full narration')
  assert.equal(f.state.submissions, 1); assert.equal(f.state.deletes, 0)
  assert.equal([...f.state.jobs.values()][0].status, 'running')
})

test('a completed remote result still downloads when its remote service budget expires', async t => {
  const f = await fixture(t), budget = remoteBudget(t)
  f.state.onResult = budget.expire
  const result = await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.ok((await fs.stat(result.presenterPath)).size > 0)
  assert.ok(budget.budgets.includes(5 * 60_000), 'local postprocessing gets its own bounded budget')
  assert.equal(f.state.submissions, 1); assert.equal(f.state.deletes, 0)
})

test('remote service budget expiry during normalization cannot discard a completed presenter', async t => {
  const f = await fixture(t), budget = remoteBudget(t), gate = await gatedNormalization(t, f.root)
  const running = prepareScienceMusetalkVideo(f, { signal: signal() })
  const completed = assert.doesNotReject(running)
  await gate.started()
  budget.expire()
  await gate.release()
  await completed
  const result = await running
  assert.ok((await fs.stat(result.presenterPath)).size > 0)
  assert.equal(f.state.submissions, 1); assert.equal(f.state.deletes, 0)
})

test('parent cancellation still stops normalization and resumes the completed remote job without resubmitting', async t => {
  const f = await fixture(t), controller = new AbortController(), gate = await gatedNormalization(t, f.root)
  const running = prepareScienceMusetalkVideo(f, { signal: controller.signal })
  const stopped = assert.rejects(running, /cancel|abort/i)
  await gate.started()
  controller.abort(new Error('cancel local normalization'))
  await stopped
  assert.equal(f.state.deletes, 1)
  assert.equal([...f.state.jobs.values()][0].status, 'completed')
  await gate.release()
  const result = await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.ok((await fs.stat(result.presenterPath)).size > 0)
  assert.equal(f.state.submissions, 1); assert.equal(f.state.retries, 0)
})

test('one full original narration is submitted, verified, normalized and cached without a local reference file', async t => {
  const f = await fixture(t)
  const result = await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.equal(result.sourceSha256, sha(await fs.readFile(f.videoPath)))
  assert.equal(f.state.submissions, 1)
  assert.ok(f.state.uploaded?.subarray(0, 4).equals(Buffer.from('fLaC')))
  const uploadedFile = path.join(f.root, 'uploaded.flac')
  await fs.writeFile(uploadedFile, f.state.uploaded!)
  const audio = (await probe(uploadedFile)).streams.find((item: any) => item.codec_type === 'audio')
  assert.equal(audio.sample_rate, '16000'); assert.equal(audio.channels, 1)
  const info = await probe(result.presenterPath), video = info.streams.find((item: any) => item.codec_type === 'video')
  assert.equal(video.avg_frame_rate, '30/1')
  assert.equal(video.width, 360); assert.equal(video.height, 360)
  assert.ok(Math.abs(Number(video.duration) - 1.2) < .04)
  assert.ok(info.streams.every((item: any) => item.codec_type !== 'audio'))
  const work = path.dirname(result.presenterPath), audioPath = path.join(work, 'narration.flac')
  await fs.utimes(audioPath, new Date(1000), new Date(1000))
  assert.deepEqual(await prepareScienceMusetalkVideo(f, { signal: signal() }), result)
  assert.equal((await fs.stat(audioPath)).mtimeMs, 1000, 'bound FLAC bytes are reused across deployments instead of re-encoding with a different FFmpeg version')
  assert.equal(f.state.submissions, 1)
})

test('native 25fps and a changed quality profile use separate results without overwriting the prior presenter', async t => {
  const f = await fixture(t, 1.2, 1.2, 25)
  f.identity.avatar_id = 'xiaolu-r4-quality-one'
  const first = await prepareScienceMusetalkVideo(f, { signal: signal() })
  const original = await fs.readFile(first.presenterPath)
  const video = (await probe(first.presenterPath)).streams.find((item: any) => item.codec_type === 'video')
  assert.equal(video.avg_frame_rate, '30/1')
  assert.equal(f.state.submissions, 1)
  f.identity.avatar_id = 'xiaolu-r4-quality-two'
  const second = await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.notEqual(second.presenterPath, first.presenterPath)
  assert.equal(f.state.submissions, 2)
  assert.equal(f.state.jobs.size, 2)
  assert.deepEqual(await fs.readFile(first.presenterPath), original)
  assert.deepEqual(await prepareScienceMusetalkVideo(f, { signal: signal() }), second)
  assert.equal(f.state.submissions, 2)
})

test('an accepted submission with a lost response automatically retries the same deterministic request id', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.state.dropSubmission = true
  await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.equal(f.state.jobs.size, 1, 'resubmission reuses the accepted backend job')
  assert.equal(f.state.submissions, 2)
  assert.equal(f.state.retries, 0)
  assert.equal(f.state.deletes, 0)
})

test('exhausted lost acknowledgements retain the unknown job checkpoint and resume without cancelling GPU work', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.state.dropSubmissions = 3; f.state.pending = true
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /fetch failed|socket|closed/)
  assert.equal(f.state.submissions, 3)
  assert.equal(f.state.jobs.size, 1)
  assert.equal(f.state.deletes, 0)
  const work = (await fs.readdir(f.directory)).find(name => name.startsWith('musetalk-'))!
  const checkpointPath = path.join(f.directory, work, 'musetalk.json')
  const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'))
  assert.equal(checkpoint.submitted, true)
  assert.equal(checkpoint.jobId, undefined)
  assert.equal([...f.state.jobs.keys()][0], checkpoint.requestId)
  for (const job of f.state.jobs.values()) job.status = 'completed'
  await prepareScienceMusetalkVideo(f, { signal: signal() })
  const resumed = JSON.parse(await fs.readFile(checkpointPath, 'utf8'))
  assert.equal(resumed.requestId, checkpoint.requestId)
  assert.equal(resumed.audioSha256, checkpoint.audioSha256)
  assert.equal(resumed.jobId, checkpoint.requestId)
  assert.equal(f.state.jobs.size, 1)
  assert.equal(f.state.retries, 0)
  assert.equal(f.state.deletes, 0)
})

test('audio upload gets a longer deadline and a per-request timeout retries without cancelling its original ID', { timeout: 10000 }, async t => {
  const f = await fixture(t), budgets: number[] = [], requestIds: string[] = []
  const timeout = AbortSignal.timeout.bind(AbortSignal), fetch = globalThis.fetch
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { budgets.push(milliseconds); return timeout(milliseconds) })
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).endsWith('/v1/lipsync')) {
      requestIds.push(String((init?.body as FormData).get('request_id')))
      assert.equal(budgets.at(-1), 180_000)
      if (requestIds.length === 1) throw new DOMException('upload response timed out', 'TimeoutError')
    }
    return fetch(url, init)
  })
  await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.equal(requestIds.length, 2)
  assert.equal(new Set(requestIds).size, 1)
  assert.ok(budgets.includes(60_000), 'health and status keep the shorter request deadline')
  assert.equal(f.state.jobs.size, 1)
  assert.equal(f.state.deletes, 0)
})

test('transient job polling errors retry the existing task without another audio submission', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.state.failedPoll = true
  f.state.onPoll = () => { if (f.state.polls === 2) f.state.failedPoll = false }
  await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.equal(f.state.polls, 2)
  assert.equal(f.state.submissions, 1)
  assert.equal(f.state.deletes, 0)
})

test('an explicit cancellation during network backoff stops retries and cancels the accepted task', { timeout: 10000 }, async t => {
  const f = await fixture(t), controller = new AbortController()
  f.state.pending = true; f.state.failedPoll = true
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: controller.signal,
    report: message => { if (/重试/.test(message)) controller.abort(new Error('cancel network retry')) } }), /cancel network retry|abort/i)
  assert.equal(f.state.polls, 1)
  assert.equal(f.state.submissions, 1)
  assert.equal(f.state.deletes, 1)
  assert.equal([...f.state.jobs.values()][0].status, 'cancelled')
})

test('a conflicting submission is never automatically retried or deleted', { timeout: 10000 }, async t => {
  const f = await fixture(t), fetch = globalThis.fetch
  let submissions = 0
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).endsWith('/v1/lipsync')) { submissions++; return new Response('conflicting audio', { status: 409 }) }
    return fetch(url, init)
  })
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /HTTP 409/)
  assert.equal(submissions, 1)
  assert.equal(f.state.deletes, 0)
})

test('presenter normalization succeeds when the Mac hardware encoder cannot open a compression session', async t => {
  if (os.platform() !== 'darwin') { t.skip('VideoToolbox is macOS-specific'); return }
  const f = await fixture(t)
  const realFfmpeg = (await exec('which', ['ffmpeg'])).stdout.trim()
  const bin = path.join(f.root, 'bin'), wrapper = path.join(bin, 'ffmpeg')
  await fs.mkdir(bin)
  await fs.writeFile(wrapper, '#!/bin/sh\nfor arg; do\n  if [ "$arg" = "h264_videotoolbox" ]; then\n    echo "cannot create compression session: -12903" >&2\n    exit 1\n  fi\ndone\nexec '
    + "'" + realFfmpeg.replace(/'/g, "'\\''") + "'" + ' "$@"\n', { mode: 0o700 })
  const previousPath = process.env.PATH
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath })
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`
  const result = await prepareScienceMusetalkVideo(f, { signal: signal() })
  const video = (await probe(result.presenterPath)).streams.find((item: any) => item.codec_type === 'video')
  assert.equal(video.codec_name, 'h264')
  assert.equal(video.avg_frame_rate, '30/1')
  assert.equal(f.state.submissions, 1)
  assert.equal(f.state.deletes, 0)
})

test('model startup can finish before the first full-narration submission', async t => {
  const f = await fixture(t); f.state.loadingReads = 1
  await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.equal(f.state.submissions, 1)
})

test('a corrupted downloaded result is rejected before it can enter composition', async t => {
  const f = await fixture(t)
  f.state.onPoll = () => { for (const job of f.state.jobs.values()) job.result_sha256 = '0'.repeat(64) }
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /输出视频校验失败/)
})

test('wrong driving audio is rejected even when the output duration matches', async t => {
  const f = await fixture(t); f.state.wrongAudio = true
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /任务与正文音频/)
  assert.equal(f.state.submissions, 1)
})

test('exhausted polling service errors preserve accepted GPU work and its checkpoint', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.state.pending = true; f.state.failedPoll = true
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /HTTP 500/)
  assert.equal(f.state.polls, 3)
  assert.equal(f.state.deletes, 0)
  assert.equal([...f.state.jobs.values()][0].status, 'running')
})

test('a sub-frame tail may be padded, but a short presenter cannot be looped over the full narration', async t => {
  const f = await fixture(t, 1.25, 1.2)
  const result = await prepareScienceMusetalkVideo(f, { signal: signal() })
  const stream = (await probe(result.presenterPath)).streams.find((item: any) => item.codec_type === 'video')
  const original = (await probe(f.videoPath)).streams.find((item: any) => item.codec_type === 'video')
  assert.ok(Math.abs(Number(stream.duration) - Number(original.duration)) < .04, `normalized=${stream.duration}; original=${original.duration}`)
  const short = await fixture(t, 2, 1.2)
  await assert.rejects(prepareScienceMusetalkVideo(short, { signal: signal() }), /不能冻结或循环/)
})

test('cancellation releases the remote GPU job and a subsequent invocation explicitly resumes it once', async t => {
  const f = await fixture(t), controller = new AbortController()
  f.state.pending = true
  f.state.onPoll = () => controller.abort(new Error('cancel fixture'))
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: controller.signal }))
  assert.equal(f.state.deletes, 1)
  assert.equal([...f.state.jobs.values()][0].status, 'cancelled')
  f.state.onPoll = undefined
  await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.equal(f.state.submissions, 1)
  assert.equal(f.state.retries, 1)
})

test('the remote service time budget stops polling while retaining the original remote work for recovery', async t => {
  const f = await fixture(t)
  f.state.pending = true
  process.env.MUSETALK_TIMEOUT_MS = '1000'
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }))
  assert.equal(f.state.deletes, 0)
  assert.ok(f.state.polls > 0)
})

test('remote API configuration cannot accidentally expose an unauthenticated GPU endpoint', async t => {
  const f = await fixture(t)
  process.env.MUSETALK_API_URL = 'http://remote.invalid:8789'
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /本机 HTTP/)
  assert.equal(f.state.submissions, 0)
})
