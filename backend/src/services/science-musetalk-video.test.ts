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

async function fixture(t: TestContext, mainDuration = 1.2, remoteDuration = 1.2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-musetalk-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const videoPath = path.join(root, 'main.mp4'), remote = path.join(root, 'remote.mp4'), directory = path.join(root, 'presenter')
  await clip(videoPath, mainDuration, 30, true)
  await clip(remote, remoteDuration, 15, true)
  const output = await fs.readFile(remote)
  const identity = { model: 'musetalk-v15', source_revision: '0a89dec45a0192b824e3cf4daf96c239440c5ed8',
    avatar_id: 'xiaolu-r3-fixture', reference_sha256: '1'.repeat(64), fps: 15 }
  const state = { submissions: 0, retries: 0, deletes: 0, polls: 0, pending: false, wrongAudio: false, dropSubmission: false,
    loadingReads: 0, failedPoll: false, onPoll: undefined as (() => void) | undefined, jobs: new Map<string, any>(), uploaded: undefined as Buffer | undefined }
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
        if (state.dropSubmission) { state.dropSubmission = false; response.destroy(); return }
        send(state.jobs.get(id)); return
      }
      const match = /^\/v1\/jobs\/([a-f0-9]{64})(\/result|\/retry)?$/.exec(request.url || '')
      const job = match && state.jobs.get(match[1]!)
      if (match && job) {
        if (request.method === 'DELETE') { state.deletes++; if (job.status !== 'completed') job.status = 'cancelled'; send(job); return }
        if (match[2] === '/retry' && request.method === 'POST') { state.retries++; job.status = 'completed'; send(job); return }
        if (match[2] === '/result') { response.setHeader('Content-Type', 'video/mp4'); response.end(output); return }
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
  const previous = new Map(['MUSETALK_API_URL', 'MUSETALK_POLL_INTERVAL_MS', 'MUSETALK_TIMEOUT_MS'].map(name => [name, process.env[name]]))
  t.after(() => { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
  process.env.MUSETALK_API_URL = `http://127.0.0.1:${address.port}`
  process.env.MUSETALK_POLL_INTERVAL_MS = '1'
  process.env.MUSETALK_TIMEOUT_MS = '30000'
  return { root, videoPath, directory, state }
}

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

test('an accepted submission with a lost response resumes by the same deterministic request id', async t => {
  const f = await fixture(t); f.state.dropSubmission = true; f.state.pending = true
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /fetch failed|socket|closed/)
  assert.equal(f.state.jobs.size, 1)
  await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.equal(f.state.jobs.size, 1, 'resubmission reuses the accepted backend job')
  assert.equal(f.state.submissions, 2)
  assert.equal(f.state.retries, 1)
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

test('a polling service error cancels outstanding work before the workflow falls back to intro-only', async t => {
  const f = await fixture(t); f.state.pending = true; f.state.failedPoll = true
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /HTTP 500/)
  assert.equal(f.state.deletes, 1)
  assert.equal([...f.state.jobs.values()][0].status, 'cancelled')
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

test('a total time budget stops polling and sends cancellation instead of leaving expensive work running', async t => {
  const f = await fixture(t)
  f.state.pending = true
  process.env.MUSETALK_TIMEOUT_MS = '1000'
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }))
  assert.equal(f.state.deletes, 1)
  assert.ok(f.state.polls > 0)
})

test('remote API configuration cannot accidentally expose an unauthenticated GPU endpoint', async t => {
  const f = await fixture(t)
  process.env.MUSETALK_API_URL = 'http://remote.invalid:8789'
  await assert.rejects(prepareScienceMusetalkVideo(f, { signal: signal() }), /本机 HTTP/)
  assert.equal(f.state.submissions, 0)
})
