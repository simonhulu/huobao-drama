import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareSciencePresenterVideo, type SciencePresenterRuntime } from './science-presenter-video.js'

const exec = promisify(execFile)
const signal = () => new AbortController().signal
const digest = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex')
const probe = async (file: string) => JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).stdout)

async function video(file: string, duration: number, audio = false, color = 'blue', fps = 30) {
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=${color}:s=64x64:r=${fps}:d=${duration}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${duration}`] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', ...(audio ? ['-c:a', 'aac'] : ['-an']), '-pix_fmt', 'yuv420p', file])
}

async function fixture(t: TestContext, duration = 1.2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-presenter-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const videoPath = path.join(root, 'main.mp4'), introPath = path.join(root, 'intro.mp4')
  const remotePath = path.join(root, 'remote.mp4'), directory = path.join(root, 'presenter')
  await video(videoPath, duration, true)
  await video(introPath, .5, false, 'red')
  await video(remotePath, Math.ceil(Math.min(30, duration)) + 1)
  const uploads: Array<{ id: string; file: string; type: 'image' | 'video' | 'audio' }> = []
  const creates: Array<Parameters<SciencePresenterRuntime['create']>[0]> = []
  const gets: string[] = [], downloads: string[] = []
  const runtime: SciencePresenterRuntime = {
    upload: async (file, options) => {
      options.signal.throwIfAborted()
      const item = { id: `upload-${uploads.length + 1}`, file, type: file.endsWith('.wav') ? 'audio' as const : 'video' as const }
      uploads.push(item)
      return item
    },
    create: async input => {
      creates.push(input)
      return { id: `job-${creates.length}`, job_type: 'intone', status: 'queued' }
    },
    get: async id => {
      gets.push(id)
      return { id, job_type: 'intone', status: 'completed', result_url: `https://media.fixture.invalid/${id}.mp4` }
    },
    download: async (url, target) => { downloads.push(url); await fs.copyFile(remotePath, target) },
    sleep: async (_ms, abortSignal) => { abortSignal.throwIfAborted() },
  }
  return { root, videoPath, introPath, remotePath, directory, runtime, uploads, creates, gets, downloads }
}

test('the presenter follows every original audio segment and trims rounded remote clips to the complete main duration', async t => {
  const f = await fixture(t, 61.2)
  const result = await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
  assert.equal(result.sourceSha256, await digest(f.videoPath))
  assert.equal(f.creates.length, 3)
  assert.equal(f.uploads.filter(item => item.type === 'video').length, 1)
  assert.ok(f.creates.every(item => item.videoPath === f.introPath && item.videoId === 'upload-1'))
  const audios = await Promise.all(f.uploads.filter(item => item.type === 'audio').map(async item => probe(item.file)))
  assert.deepEqual(audios.map(item => Number(item.format.duration)), [30, 30, 1.2])
  assert.ok(audios.every(item => item.streams[0].codec_name === 'pcm_s16le' && item.streams[0].sample_rate === '48000'))
  const firstAudio = f.uploads.find(item => item.type === 'audio')!.file
  const { stdout: samples } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', firstAudio, '-t', '0.25',
    '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], { encoding: 'buffer' })
  let crossings = 0
  for (let offset = 4; offset < samples.length; offset += 4) {
    if (samples.readFloatLE(offset - 4) <= 0 && samples.readFloatLE(offset) > 0) crossings++
  }
  assert.ok(Math.abs(crossings / .25 - 880) < 10, 'the supplied driver retains the original narration waveform')
  assert.ok(f.creates.every(item => /lip synchronization|audio-driven/i.test(item.prompt)))
  const output = await probe(result.presenterPath)
  assert.ok(Math.abs(Number(output.format.duration) - 61.2) < 1 / 30 + .005)
  assert.ok(output.streams.every((item: any) => item.codec_type !== 'audio'), 'the overlay cannot replace or double the original main narration')
  assert.deepEqual(await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime }), result)
  assert.equal(f.creates.length, 3, 'a completed content-bound presenter is reused without new paid jobs')
  assert.equal(f.downloads.length, 3)
})

test('a landscape LatentSync result is center-cropped to the square presenter overlay without stretching', async t => {
  const f = await fixture(t)
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=green:s=96x64:r=30:d=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f.remotePath])
  const result = await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
  const output = await probe(result.presenterPath)
  assert.equal(Number(output.streams.find((stream: any) => stream.codec_type === 'video').width),
    Number(output.streams.find((stream: any) => stream.codec_type === 'video').height))
})

test('cancelling a paid queued job preserves its id and resumes it without another create or upload', async t => {
  const f = await fixture(t), controller = new AbortController(), reason = new Error('user cancelled presenter')
  let pendingReads = 0
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: controller.signal, runtime: { ...f.runtime,
    get: async id => { pendingReads++; return { id, job_type: 'intone', status: 'in_progress' } },
    sleep: async () => { controller.abort(reason); controller.signal.throwIfAborted() },
  } }), error => error === reason)
  assert.equal(f.creates.length, 1)
  assert.equal(pendingReads, 1)
  assert.equal(f.downloads.length, 0)
  const result = await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
  assert.ok((await fs.stat(result.presenterPath)).size > 0)
  assert.deepEqual(f.gets, ['job-1'])
  assert.equal(f.creates.length, 1)
  assert.equal(f.uploads.length, 2)
})

test('an unknown create response leaves a durable guard and retries cannot spend again', async t => {
  const f = await fixture(t)
  const runtime = { ...f.runtime, create: async (input: Parameters<SciencePresenterRuntime['create']>[0]) => {
    f.creates.push(input)
    throw new Error('submission connection closed before the response')
  } }
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime }), /submission connection closed/)
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime }), /提交结果待核对|不能自动重复/)
  assert.equal(f.creates.length, 1)
  assert.equal(f.gets.length, 0)
  assert.equal(f.downloads.length, 0)
})

test('a downloaded short presenter cannot be frozen or looped and is never regenerated on retry', async t => {
  const f = await fixture(t)
  await video(f.remotePath, .4)
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime }), /时长不足.*不能冻结或循环/)
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime }), /时长不足/)
  assert.equal(f.creates.length, 1)
  assert.equal(f.downloads.length, 1)
  const [work] = await fs.readdir(f.directory)
  await assert.rejects(fs.stat(path.join(f.directory, work!, 'presenter.mp4')), { code: 'ENOENT' })
})

test('24 and 25 fps mains receive enough real remote frames to cover a non-30-fps ending', async t => {
  for (const [fps, frames] of [[24, 5], [25, 7]]) {
    const f = await fixture(t)
    await video(f.videoPath, frames! / fps!, true, 'blue', fps)
    const mainDuration = Number((await probe(f.videoPath)).streams[0].duration)
    const result = await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
    const output = await probe(result.presenterPath)
    assert.ok(Number(output.streams[0].duration) + .001 >= mainDuration, 'the overlay cannot disappear before the last main frame')
    assert.equal(Number(output.streams[0].nb_frames), Math.ceil(mainDuration * 30 - .00001))
    assert.deepEqual(await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime }), result)
    assert.equal(f.creates.length, 1)
  }
})

test('a cancelled request never dispatches and cancellation immediately after acceptance still saves the paid job id', async t => {
  const f = await fixture(t), controller = new AbortController(), reason = new Error('cancelled after acceptance')
  const cancelled = new AbortController()
  cancelled.abort(reason)
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: cancelled.signal, runtime: f.runtime }), error => error === reason)
  assert.equal(f.uploads.length, 0)
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: controller.signal, runtime: { ...f.runtime,
    create: async input => { const job = await f.runtime.create(input, { signal: controller.signal }); controller.abort(reason); return job },
  } }), error => error === reason)
  assert.equal(f.gets.length, 0)
  await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
  assert.equal(f.creates.length, 1)
  assert.deepEqual(f.gets, ['job-1'])
})

test('a failed download refreshes the original completed job URL and preserves paid work', async t => {
  const f = await fixture(t)
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime: { ...f.runtime,
    download: async (_url, target) => { await fs.writeFile(target, 'partial'); throw new Error('download interrupted') },
  } }), /download interrupted/)
  await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
  assert.equal(f.creates.length, 1)
  assert.equal(f.gets.length, 2)
  assert.equal(f.downloads.length, 1)
})

test('polling has a finite wait and a failed remote job can never cause another paid create', async t => {
  const f = await fixture(t)
  let reads = 0
  const pending: SciencePresenterRuntime['get'] = async id => { reads++; return { id, job_type: 'intone', status: 'queued' } }
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime: { ...f.runtime, get: pending }, maxPolls: 2 }), /仍在生成.*已保存原任务/)
  assert.equal(reads, 2)
  const failed: SciencePresenterRuntime['get'] = async id => ({ id, job_type: 'intone', status: 'failed' })
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime: { ...f.runtime, get: failed } }), /原主播生成任务失败/)
  }
  assert.equal(f.creates.length, 1)
  await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
  assert.equal(f.creates.length, 1)
})

test('changing the main audio or the intro identity invalidates the presenter cache', async t => {
  const f = await fixture(t)
  const first = await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
  await video(f.videoPath, 1.2, true, 'green')
  const second = await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
  assert.notEqual(first.sourceSha256, second.sourceSha256)
  assert.notEqual(first.presenterPath, second.presenterPath)
  await video(f.introPath, .5, false, 'yellow')
  const third = await prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime })
  assert.equal(third.sourceSha256, second.sourceSha256)
  assert.notEqual(third.presenterPath, second.presenterPath)
  assert.equal(f.creates.length, 3)
})

test('a dedicated reference drives the presenter independently of the fixed intro and quality settings invalidate old output', async t => {
  const f = await fixture(t)
  const referencePath = path.join(f.root, 'closeup.mp4')
  await video(referencePath, 2, false, 'yellow')
  const input = { ...f, referencePath }
  const first = await prepareSciencePresenterVideo(input, { signal: signal(), runtime: f.runtime })
  assert.equal(f.creates[0]!.videoPath, referencePath)
  assert.deepEqual(f.creates[0]!.inferenceSettings, { inference_steps: 40, guidance_scale: 1.5, enable_deepcache: false, seed: 1247 })
  await video(f.introPath, .5, false, 'green')
  assert.deepEqual(await prepareSciencePresenterVideo(input, { signal: signal(), runtime: f.runtime }), first)
  assert.equal(f.creates.length, 1, 'changing the separate intro cannot change the presenter reference')
  const second = await prepareSciencePresenterVideo({ ...input, inferenceSettings: { guidance_scale: 2 } }, { signal: signal(), runtime: f.runtime })
  assert.notEqual(first.presenterPath, second.presenterPath)
  assert.equal(f.creates[1]!.inferenceSettings?.guidance_scale, 2)
  assert.equal(f.creates.length, 2)
})

test('invalid quality settings fail before remote submission', async t => {
  const f = await fixture(t)
  for (const inferenceSettings of [{ inference_steps: 19 }, { inference_steps: 50.5 }, { guidance_scale: 4 }, { seed: -1 }]) {
    await assert.rejects(prepareSciencePresenterVideo({ ...f, inferenceSettings }, { signal: signal(), runtime: f.runtime }), /参数无效/)
  }
  assert.equal(f.creates.length, 0)
  assert.equal(f.uploads.length, 0)
})

test('missing or short original audio is rejected before uploading or spending on a presenter', async t => {
  for (const audio of [false, true]) {
    const f = await fixture(t)
    if (!audio) await video(f.videoPath, 1.2)
    else await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:s=64x64:r=30:d=1.2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', f.videoPath])
    await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime }), /音轨/)
    assert.equal(f.uploads.length, 0)
    assert.equal(f.creates.length, 0)
  }
})

test('unsafe result URLs and a mismatched remote job are rejected before any download', async t => {
  const f = await fixture(t)
  for (const job of [
    { id: 'wrong-job', job_type: 'intone', status: 'completed' as const, result_url: 'https://media.fixture.invalid/result.mp4' },
    { id: 'job-1', job_type: 'intone', status: 'completed' as const, result_url: 'file:///etc/hosts' },
    { id: 'job-1', job_type: 'intone', status: 'completed' as const, result_url: 'http://media.fixture.invalid/result.mp4' },
  ]) await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime: { ...f.runtime, get: async () => job } }), /任务.*不一致|HTTPS/)
  assert.equal(f.creates.length, 1)
  assert.equal(f.downloads.length, 0)
})

test('concurrent requests cannot dispatch the same presenter twice', async t => {
  const f = await fixture(t)
  let accepted!: () => void, finish!: () => void
  const entered = new Promise<void>(resolve => { accepted = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  const first = prepareSciencePresenterVideo(f, { signal: signal(), runtime: { ...f.runtime,
    create: async input => { const job = await f.runtime.create(input, { signal: signal() }); accepted(); await pending; return job },
  } })
  await entered
  try { await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal(), runtime: f.runtime }), /正在处理中|请勿重复提交/) }
  finally { finish() }
  await first
  assert.equal(f.creates.length, 1)
})

test('the default LatentSync runtime rejects completed results without verified restored frames', async t => {
  const f = await fixture(t)
  let resultReads = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/v1/lipsync') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ id: 'unverified-job', status: 'queued' })); return
      }
      if (request.url === '/v1/jobs/unverified-job') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ status: 'completed', result: '/tmp/masked-frames.mp4' })); return
      }
      if (request.url === '/v1/jobs/unverified-job/result') {
        resultReads++; response.end(readFileSync(f.remotePath)); return
      }
      response.statusCode = 404; response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const previousUrl = process.env.LATENTSYNC_API_URL
  process.env.LATENTSYNC_API_URL = `http://127.0.0.1:${address.port}`
  t.after(async () => {
    if (previousUrl === undefined) delete process.env.LATENTSYNC_API_URL; else process.env.LATENTSYNC_API_URL = previousUrl
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal() }), /LatentSync.*(?:校验|回贴)/)
  assert.equal(resultReads, 0, 'unverified output is never downloaded or cached as a presenter')
})

test('the default LatentSync runtime posts both media files, polls the job, and downloads its result', async t => {
  const f = await fixture(t)
  let postBody = Buffer.alloc(0), postType = '', statusReads = 0, resultReads = 0, postCount = 0, matchingSettings = false, geometryDtype = 'float16'
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/v1/lipsync') {
        postCount++
        postBody = Buffer.concat(chunks); postType = String(request.headers['content-type'] || '')
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: 'latent-job-1', status: 'queued' })); return
      }
      if (request.method === 'GET' && request.url === '/v1/jobs/latent-job-1') {
        statusReads++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'completed',
          inference_settings: { inference_steps: 40, guidance_scale: matchingSettings ? 1.5 : 2, enable_deepcache: false, seed: 1247 },
          geometry_dtype: geometryDtype,
          output_stage: 'restored_video', vae_sha256: 'a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815' })); return
      }
      if (request.method === 'GET' && request.url === '/v1/jobs/latent-job-1/result') {
        resultReads++; response.setHeader('content-type', 'video/mp4'); response.end(readFileSync(f.remotePath)); return
      }
      response.statusCode = 404; response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const previousUrl = process.env.LATENTSYNC_API_URL
  process.env.LATENTSYNC_API_URL = `http://127.0.0.1:${port}`
  t.after(async () => {
    if (previousUrl === undefined) delete process.env.LATENTSYNC_API_URL; else process.env.LATENTSYNC_API_URL = previousUrl
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal() }), /结果参数.*不一致/)
  assert.equal(resultReads, 0, 'a completed video generated with different settings cannot be downloaded')
  matchingSettings = true
  await assert.rejects(prepareSciencePresenterVideo(f, { signal: signal() }), /FP32/)
  assert.equal(resultReads, 0, 'a result using the old face geometry cannot be downloaded')
  geometryDtype = 'float32'
  const result = await prepareSciencePresenterVideo(f, { signal: signal() })
  assert.match(postType, /multipart\/form-data; boundary=/)
  assert.match(postBody.toString('utf8'), /name="video"/)
  assert.match(postBody.toString('utf8'), /name="audio"/)
  const multipart = new Response(postBody, { headers: { 'content-type': postType } })
  const submitted = await multipart.formData()
  assert.equal(submitted.get('inference_steps'), '40')
  assert.equal(submitted.get('guidance_scale'), '1.5')
  assert.equal(submitted.get('enable_deepcache'), 'false')
  assert.equal(submitted.get('seed'), '1247')
  assert.equal(postCount, 1, 'checking metadata again resumes the original remote job')
  assert.equal(statusReads, 3)
  assert.equal(resultReads, 1)
  assert.ok((await fs.stat(result.presenterPath)).size > 0)
})
