import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { checkScienceMusetalkAvailability, prepareScienceMusetalkVideo } from './science-musetalk-video.js'

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
  const state = { submissions: 0, retries: 0, deletes: 0, polls: 0, downloads: 0, pending: false, wrongAudio: false, dropSubmission: false, dropSubmissions: 0,
    loadingReads: 0, failedPoll: false, onPoll: undefined as (() => void) | undefined, onResult: undefined as (() => void) | undefined,
    jobs: new Map<string, any>(), requests: [] as string[], uploaded: undefined as Buffer | undefined }
  const server = createServer(async (request, response) => {
    try {
      state.requests.push(`${request.method} ${request.url}`)
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
        if (match[2] === '/result') { state.downloads++; state.onResult?.(); response.setHeader('Content-Type', 'video/mp4'); response.end(output); return }
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

test('the availability probe only reads health and creates no task files when the model is ready', async t => {
  const f = await fixture(t), before = await fs.readdir(f.root, { recursive: true })
  const result = await checkScienceMusetalkAvailability({ signal: signal() })
  assert.equal(result.ready, true)
  assert.ok(result.message)
  assert.deepEqual(f.state.requests, ['GET /health'])
  assert.deepEqual(await fs.readdir(f.root, { recursive: true }), before)
  assert.equal(f.state.submissions, 0); assert.equal(f.state.retries, 0); assert.equal(f.state.deletes, 0)
})

test('the availability probe reports loading without polling or creating a GPU task', async t => {
  const f = await fixture(t); f.state.loadingReads = 1
  const result = await checkScienceMusetalkAvailability({ signal: signal() })
  assert.equal(result.ready, false)
  assert.match(result.message, /加载/)
  assert.deepEqual(f.state.requests, ['GET /health'])
  assert.equal(f.state.jobs.size, 0)
})

test('the availability probe waits for a loading service before its identity is available', async t => {
  await fixture(t)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, status: 'loading' }))
  assert.equal((await checkScienceMusetalkAvailability({ signal: signal() })).ready, false)
})

test('the availability probe returns a safe waiting result for an offline service', async t => {
  const f = await fixture(t), calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    calls.push(`${options.method || 'GET'} ${new URL(String(url)).pathname}`)
    throw new TypeError('fetch failed: private-credential', { cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) })
  })
  const result = await checkScienceMusetalkAvailability({ signal: signal() })
  assert.equal(result.ready, false)
  assert.ok(result.message)
  assert.doesNotMatch(result.message, /private-credential|127\.0\.0\.1/)
  assert.deepEqual(calls, ['GET /health'])
  assert.equal(f.state.jobs.size, 0)
})

test('the availability probe has a bounded deadline for a stalled health response', async t => {
  await fixture(t)
  const deadline = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.ok(milliseconds >= 20_000 && milliseconds <= 25_000)
    return deadline.signal
  })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    deadline.abort(new DOMException('health deadline expired', 'TimeoutError'))
    options.signal!.throwIfAborted()
    throw new Error('unreachable')
  })
  assert.equal((await checkScienceMusetalkAvailability({ signal: signal() })).ready, false)
})

test('the availability probe blocks changed models, revisions, avatars and frame rates instead of waiting', async t => {
  const f = await fixture(t), original = { ...f.identity }
  for (const changed of [{ model: 'wrong-model' }, { source_revision: 'wrong-revision' }, { avatar_id: '../wrong-avatar' },
    { reference_sha256: 'not-a-hash' }, { fps: 30 }]) {
    Object.assign(f.identity, original, changed)
    await assert.rejects(checkScienceMusetalkAvailability({ signal: signal() }), /模型、头像或帧率校验失败/)
  }
  assert.ok(f.state.requests.every(request => request === 'GET /health'))
  assert.equal(f.state.jobs.size, 0)
})

test('the availability probe throws invalid configuration without making a network request', async t => {
  await fixture(t)
  process.env.MUSETALK_API_URL = 'http://remote.invalid:8789'
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('invalid configuration must never reach the network') })
  await assert.rejects(checkScienceMusetalkAvailability({ signal: signal() }), /本机 HTTP/)
})

test('the availability probe preserves explicit parent cancellation before and during the health request', async t => {
  await fixture(t)
  const before = new AbortController(), beforeReason = new Error('cancel before health probe')
  before.abort(beforeReason)
  await assert.rejects(checkScienceMusetalkAvailability({ signal: before.signal }), (error: unknown) => error === beforeReason)
  const during = new AbortController(), duringReason = new Error('cancel during health probe')
  t.mock.method(globalThis, 'fetch', async () => {
    during.abort(duringReason)
    throw new DOMException('The operation was aborted', 'AbortError')
  })
  await assert.rejects(checkScienceMusetalkAvailability({ signal: during.signal }), (error: unknown) => error === duringReason)
})

test('the availability probe waits only for temporary HTTP failures and blocks unexpected health responses', async t => {
  const f = await fixture(t)
  let status = 503, body: unknown = {}
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status }))
  for (status of [408, 429, 500, 503]) assert.equal((await checkScienceMusetalkAvailability({ signal: signal() })).ready, false)
  for (status of [401, 403, 404]) await assert.rejects(checkScienceMusetalkAvailability({ signal: signal() }), /HTTP/)
  status = 200; body = { ...f.identity, ok: false, status: 'failed' }
  await assert.rejects(checkScienceMusetalkAvailability({ signal: signal() }), /异常服务状态/)
})

test('the availability probe closes its SSH tunnel and removes temporary authentication files on every outcome', async t => {
  const configurationFailures = ['auth', 'host-key', 'bad-key', 'bad-option', 'unknown-exit', 'missing-client']
  for (const mode of ['ready', 'loading', 'invalid', 'offline', 'timeout', ...configurationFailures, 'cancel-connect', 'cancel-health']) await t.test(mode, async t => {
    const f = await fixture(t), controller = new AbortController(), cancelled = new Error('cancel probe SSH fixture')
    const bin = path.join(f.root, 'bin'), statePath = path.join(f.root, 'ssh-state.json')
    await fs.mkdir(bin)
    const wrapper = `#!${process.execPath}
const fs=require('node:fs'),http=require('node:http'),mode=${JSON.stringify(mode)},filename=${JSON.stringify(statePath)};
const state={pid:process.pid,askpass:process.env.SSH_ASKPASS,requests:[]};const save=()=>{fs.writeFileSync(filename+'.tmp',JSON.stringify(state));fs.renameSync(filename+'.tmp',filename)};save();
const failures={offline:'ssh: connect to host probe.invalid port 22: Connection refused',timeout:'ssh: connect to host probe.invalid port 22: Operation timed out',
auth:'probe@private-host: Permission denied (publickey,password). private-output-canary',
'host-key':'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! private-output-canary',
'bad-key':'Load key "/private-output-canary": invalid format','bad-option':'Bad configuration option: private-output-canary',
'unknown-exit':'private-output-canary'};
if(failures[mode]){process.stderr.write(failures[mode],()=>process.exit(255));return;}
process.on('SIGTERM',()=>process.exit(0));
if(mode==='cancel-connect'){setInterval(()=>{},1000)}else{
const args=process.argv.slice(2),forward=args[args.indexOf('-L')+1],port=Number(forward.split(':')[1]);
http.createServer((request,response)=>{state.requests.push(request.method+' '+request.url);save();if(mode==='cancel-health')return;
response.setHeader('Content-Type','application/json');response.end(JSON.stringify({...${JSON.stringify(f.identity)},
model:mode==='invalid'?'wrong-model':${JSON.stringify(f.identity.model)},ok:mode!=='loading',status:mode==='loading'?'loading':'ready'}));}).listen(port,'127.0.0.1');}
`
    await fs.writeFile(path.join(bin, 'ssh'), wrapper, { mode: 0o700 })
    const replacements = { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, MUSETALK_SSH_HOST: 'probe.invalid',
      MUSETALK_SSH_USER: 'probe', MUSETALK_SSH_PORT: '22', MUSETALK_REMOTE_HOST: '127.0.0.1', MUSETALK_REMOTE_PORT: '8789',
      MUSETALK_SSH_PASSWORD: 'fixture-password' }
    const previous = new Map(Object.keys(replacements).map(name => [name, process.env[name]]))
    t.after(() => { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
    Object.assign(process.env, replacements)
    delete process.env.MUSETALK_API_URL
    if (mode === 'missing-client') { await fs.rm(path.join(bin, 'ssh')); process.env.PATH = bin }
    const writes = t.mock.method(fs, 'writeFile')
    const running = checkScienceMusetalkAvailability({ signal: controller.signal })
    const finished = mode === 'invalid' ? assert.rejects(running, /模型、头像或帧率校验失败/)
      : configurationFailures.includes(mode) ? assert.rejects(running, (error: any) => {
        assert.equal(error.code, 'MUSETALK_SSH_CONFIG')
        assert.doesNotMatch(error.message, /private-output-canary|private-host|fixture-password/)
        assert.equal(error.cause, undefined, 'SSH diagnostic output must stay private')
        return true
      })
      : mode.startsWith('cancel') ? assert.rejects(running, (error: unknown) => error === cancelled)
        : assert.doesNotReject(running.then(result => { assert.equal(result.ready, mode === 'ready') }))
    if (mode.startsWith('cancel')) {
      let started = false
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
          if (mode === 'cancel-connect' || state.requests.length > 0) { started = true; break }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      controller.abort(cancelled)
      assert.equal(started, true, 'cancellation must reach the actual tunnel or health request')
    }
    await finished
    const authenticationFiles = writes.mock.calls.map(call => String(call.arguments[0])).filter(filename => path.basename(filename).startsWith('musetalk-askpass-'))
    assert.equal(authenticationFiles.length, 1)
    await assert.rejects(fs.access(authenticationFiles[0]!), { code: 'ENOENT' })
    if (mode !== 'missing-client') {
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
      assert.throws(() => process.kill(state.pid, 0), { code: 'ESRCH' }, 'the probe must not leave SSH running')
      assert.ok(state.requests.every((request: string) => request === 'GET /health'))
    }
    await assert.rejects(fs.access(f.directory), { code: 'ENOENT' }, 'the probe must not create a task directory')
  })
})

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
  assert.ok(budget.budgets.includes(15 * 60_000), 'local download, decoding and CPU normalization get a separate budget')
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

test('a local postprocessing timeout is retryable and resumes verified GPU output without resubmitting or downloading again', async t => {
  const f = await fixture(t), gate = await gatedNormalization(t, f.root), controller = new AbortController()
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  let captured = false
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    if (!captured && milliseconds >= 5 * 60_000) { captured = true; return controller.signal }
    return timeout(milliseconds)
  })
  const running = prepareScienceMusetalkVideo(f, { signal: signal() })
  const stopped = assert.rejects(running, (error: any) => {
    assert.match(error.message, /处理时限/)
    assert.equal(error.code, 'ETIMEDOUT')
    assert.equal(error.retryable, true)
    assert.equal(error.cause?.name, 'AbortError', 'retain the underlying child-process failure for diagnosis')
    return true
  })
  await gate.started()
  controller.abort(new DOMException('local postprocessing budget expired', 'TimeoutError'))
  await stopped
  assert.equal(f.state.deletes, 0)
  assert.equal([...f.state.jobs.values()][0].status, 'completed')
  await gate.release()
  const result = await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.ok((await fs.stat(result.presenterPath)).size > 0)
  assert.equal(f.state.submissions, 1); assert.equal(f.state.retries, 0)
  assert.equal(f.state.downloads, 1, 'the completed GPU output stays reusable across local timeouts')
})

test('parent cancellation still stops normalization and resumes the completed remote job without resubmitting', async t => {
  const f = await fixture(t), controller = new AbortController(), gate = await gatedNormalization(t, f.root)
  const cancelled = new Error('cancel local normalization')
  const running = prepareScienceMusetalkVideo(f, { signal: controller.signal })
  const stopped = assert.rejects(running, (error: unknown) => { assert.equal(error, cancelled); return true })
  await gate.started()
  controller.abort(cancelled)
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

test('a corrupted retained result is downloaded again before normalization without resubmitting GPU work', async t => {
  const f = await fixture(t)
  const original = await prepareScienceMusetalkVideo(f, { signal: signal() })
  await fs.writeFile(original.presenterPath, 'invalid normalized cache')
  await fs.writeFile(path.join(path.dirname(original.presenterPath), 'remote.mp4'), 'partial download')
  const result = await prepareScienceMusetalkVideo(f, { signal: signal() })
  assert.deepEqual(result, original)
  assert.equal(f.state.downloads, 2)
  assert.equal(f.state.submissions, 1); assert.equal(f.state.retries, 0)
  assert.ok((await probe(result.presenterPath)).streams.some((item: any) => item.codec_type === 'video'))
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
