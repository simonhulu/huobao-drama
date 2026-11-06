import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { getVideoEncoderOptions } from './composition/video-encoder.js'

const exec = promisify(execFile)
const MODEL = 'latentsync'
const VERSION = 6
const VAE_SHA256 = 'a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815'
const CHUNK_SECONDS = 30
const FPS = 30
const defaultIntroPath = fileURLToPath(new URL('../../../data/science-pop/assets/xiaolu-intro.mp4', import.meta.url))
const PROMPT = 'LatentSync audio-driven lip synchronization using the supplied presenter video and the original narration audio.'

export interface SciencePresenterJob {
  id: string
  job_type?: string
  status?: 'queued' | 'in_progress' | 'completed' | 'failed'
  result_url?: string | null
}
export interface SciencePresenterInferenceSettings {
  inference_steps: number
  guidance_scale: number
  enable_deepcache: boolean
  seed: number
}
export interface SciencePresenterRuntime {
  upload(file: string, options: { signal: AbortSignal }): Promise<{ id: string; type: 'image' | 'video' | 'audio' }>
  create(input: { imageId?: string; videoId?: string; audioId: string; videoPath?: string; audioPath?: string; prompt: string; inferenceSettings?: SciencePresenterInferenceSettings }, options: { signal: AbortSignal }): Promise<SciencePresenterJob>
  get(id: string, options: { signal: AbortSignal }): Promise<SciencePresenterJob>
  download(url: string, target: string, options: { signal: AbortSignal }): Promise<void>
  sleep(ms: number, signal: AbortSignal): Promise<void>
  validateResultUrl?(url: string): string
  close?(): Promise<void> | void
}
export interface SciencePresenterVideoInput {
  videoPath: string; directory: string; introPath?: string; referencePath?: string
  inferenceSettings?: Partial<SciencePresenterInferenceSettings>
}
export interface SciencePresenterVideoOptions {
  signal: AbortSignal
  report?: (message: string) => void
  runtime?: Partial<SciencePresenterRuntime>
  maxPolls?: number
  pollIntervalMs?: number
}
export interface SciencePresenterVideoResult { presenterPath: string; sourceSha256: string }

interface Chunk {
  index: number; start: number; duration: number
  audioSha256?: string; audioUploadId?: string
  dispatched?: boolean; jobId?: string; status?: string; resultUrl?: string
  rawSha256?: string; rawDuration?: number; videoSha256?: string
}
interface Checkpoint {
  version: typeof VERSION; model: typeof MODEL; contentHash: string
  sourcePath: string; sourceSha256: string; introPath: string; introSha256: string
  prompt: string; promptSha256: string; duration: number
  inferenceSettings: SciencePresenterInferenceSettings
  videoSha256?: string; videoUploadId?: string; width?: number
  chunks: Chunk[]
  presenterSha256?: string
}
interface MediaInfo { duration: number; width: number; height: number; frameDuration: number; audio: boolean }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)

async function fileHash(filename: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const stat = await fs.stat(filename)
  if (!stat.isFile() || !stat.size) throw new Error('主播输入或检查点媒体为空，请检查本地文件')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk)
  signal.throwIfAborted()
  return hash.digest('hex')
}

async function matchesHash(filename: string, expected: string | undefined, signal: AbortSignal) {
  if (!expected) return false
  try { return await fileHash(filename, signal) === expected } catch { signal.throwIfAborted(); return false }
}

async function saveJson(filename: string, value: unknown) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2))
    await handle.sync()
  } finally { await handle.close() }
  try { await fs.rename(temporary, filename) }
  finally { await fs.rm(temporary, { force: true }) }
}

async function probe(filename: string, signal: AbortSignal): Promise<MediaInfo> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename],
    { signal, timeout: 60_000, maxBuffer: 1024 * 1024 })
  const data = JSON.parse(stdout)
  const video = data.streams?.find((stream: any) => stream.codec_type === 'video')
  const audio = data.streams?.some((stream: any) => stream.codec_type === 'audio') || false
  const duration = Number(video?.duration || data.format?.duration)
  const [numerator, denominator] = String(video?.avg_frame_rate || '30/1').split('/').map(Number)
  const fps = numerator! / (denominator || 1)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('主播媒体没有有效时长')
  return { duration, width: Number(video?.width || 0), height: Number(video?.height || 0), audio,
    frameDuration: Number.isFinite(fps) && fps >= 1 && fps <= 120 ? 1 / fps : 1 / FPS }
}

function httpsUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('主播视频下载地址无效') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('主播视频只允许使用 HTTPS 下载地址')
  return url.toString()
}

interface LatentSyncTunnel {
  apiUrl: string
  child?: ChildProcess
  askpassPath?: string
  close(): Promise<void>
}

function envPositiveInt(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

async function freeLocalPort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (!port) throw new Error('无法为 LatentSync 分配本地端口')
  return port
}

async function waitForForward(port: number, child: ChildProcess, signal: AbortSignal) {
  const deadline = Date.now() + 15_000
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', value => { stderr += String(value).slice(-2000) })
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    if (child.exitCode !== null) throw new Error(`LatentSync SSH 隧道启动失败${stderr ? `：${stderr.trim()}` : ''}`)
    const connected = await new Promise<boolean>(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      const finish = (value: boolean) => { socket.destroy(); resolve(value) }
      socket.once('connect', () => finish(true)); socket.once('error', () => finish(false))
      socket.setTimeout(500, () => finish(false))
    })
    if (connected) return
    await delay(200, undefined, { signal })
  }
  child.kill('SIGTERM')
  throw new Error(`LatentSync SSH 隧道启动超时${stderr ? `：${stderr.trim()}` : ''}`)
}

async function openLatentSyncTunnel(signal: AbortSignal): Promise<LatentSyncTunnel> {
  const configuredUrl = process.env.LATENTSYNC_API_URL?.trim()
  if (configuredUrl) {
    let parsed: URL
    try { parsed = new URL(configuredUrl) } catch { throw new Error('LATENTSYNC_API_URL 不是有效地址') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('LATENTSYNC_API_URL 只允许 HTTP(S) 地址')
    return { apiUrl: configuredUrl.replace(/\/$/, ''), async close() {} }
  }
  const host = process.env.LATENTSYNC_SSH_HOST || 'hz01-ssh.gpuhome.cc'
  const port = envPositiveInt('LATENTSYNC_SSH_PORT', 30163)
  const user = process.env.LATENTSYNC_SSH_USER || 'root'
  const remoteHost = process.env.LATENTSYNC_REMOTE_HOST || '127.0.0.1'
  const remotePort = envPositiveInt('LATENTSYNC_REMOTE_PORT', 8787)
  const localPort = await freeLocalPort()
  const key = process.env.LATENTSYNC_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519')
  const hasPassword = Boolean(process.env.LATENTSYNC_SSH_PASSWORD)
  const args = ['-N', '-T', '-o', `BatchMode=${hasPassword ? 'no' : 'yes'}`, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new', '-L', `${localPort}:${remoteHost}:${remotePort}`,
    '-p', String(port)]
  if (key) args.push('-i', key)
  args.push(`${user}@${host}`)
  let askpassPath: string | undefined
  const env = { ...process.env }
  if (process.env.LATENTSYNC_SSH_PASSWORD) {
    askpassPath = path.join(os.tmpdir(), `latentsync-askpass-${process.pid}-${randomUUID()}.sh`)
    await fs.writeFile(askpassPath, '#!/bin/sh\nprintf \'%s\\n\' "$LATENTSYNC_SSH_PASSWORD"\n', { mode: 0o700 })
    env.SSH_ASKPASS = askpassPath; env.SSH_ASKPASS_REQUIRE = 'force'; env.DISPLAY = 'latentsync:0'
  } else {
    env.SSH_ASKPASS_REQUIRE = 'never'
  }
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], env })
  try {
    await waitForForward(localPort, child, signal)
  } catch (error) {
    child.kill('SIGTERM'); if (askpassPath) await fs.rm(askpassPath, { force: true }); throw error
  }
  return {
    apiUrl: `http://127.0.0.1:${localPort}`, child, askpassPath,
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1500); child.once('exit', () => { clearTimeout(timer); resolve() }) })
      }
      if (askpassPath) await fs.rm(askpassPath, { force: true })
    },
  }
}

function latentJobId(value: unknown): string {
  const id = typeof value === 'object' && value !== null
    ? (value as any).job_id ?? (value as any).id ?? (value as any).data?.job_id ?? (value as any).data?.id
    : undefined
  if (!validId(id)) throw new Error('LatentSync 响应没有有效任务编号，提交结果待核对，不能自动重试')
  return id
}

function latentStatus(value: unknown): SciencePresenterJob['status'] {
  const status = String((value as any)?.status || '').toLowerCase()
  if (['queued', 'pending', 'created'].includes(status)) return 'queued'
  if (['running', 'processing', 'in_progress'].includes(status)) return 'in_progress'
  if (['completed', 'complete', 'succeeded', 'success'].includes(status)) return 'completed'
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'failed'
  throw new Error('LatentSync 返回了无法识别的任务状态')
}

function inferenceSettings(input: SciencePresenterVideoInput): SciencePresenterInferenceSettings {
  const supplied = input.inferenceSettings
  const cache = process.env.LATENTSYNC_ENABLE_DEEPCACHE ?? 'false'
  if (supplied?.enable_deepcache === undefined && !['true', 'false', '1', '0'].includes(cache)) {
    throw new Error('LATENTSYNC_ENABLE_DEEPCACHE 必须为 true、false、1 或 0')
  }
  const settings = {
    inference_steps: supplied?.inference_steps ?? Number(process.env.LATENTSYNC_INFERENCE_STEPS ?? 40),
    guidance_scale: supplied?.guidance_scale ?? Number(process.env.LATENTSYNC_GUIDANCE_SCALE ?? 1.5),
    enable_deepcache: supplied?.enable_deepcache ?? ['true', '1'].includes(cache),
    seed: supplied?.seed ?? Number(process.env.LATENTSYNC_SEED ?? 1247),
  }
  if (!Number.isSafeInteger(settings.inference_steps) || settings.inference_steps < 20 || settings.inference_steps > 50
    || !Number.isFinite(settings.guidance_scale) || settings.guidance_scale < 1 || settings.guidance_scale > 3
    || typeof settings.enable_deepcache !== 'boolean' || !Number.isSafeInteger(settings.seed) || settings.seed < 0 || settings.seed > 4294967295) {
    throw new Error('LatentSync 参数无效：采样步数须为 20–50，引导系数须为 1–3，seed 须为 32 位非负整数')
  }
  return settings
}

function createLatentSyncRuntime(settings: SciencePresenterInferenceSettings): SciencePresenterRuntime {
  let tunnel: LatentSyncTunnel | undefined
  const ensureTunnel = async (signal: AbortSignal) => tunnel || (tunnel = await openLatentSyncTunnel(signal))
  const request = async (pathname: string, init: RequestInit, signal: AbortSignal) => {
    const active = await ensureTunnel(signal)
    const response = await fetch(`${active.apiUrl}${pathname}`, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]) })
    if (!response.ok) throw new Error(`LatentSync 请求失败（HTTP ${response.status}）`)
    return response
  }
  return {
    async upload(file, { signal }) {
      signal.throwIfAborted(); await ensureTunnel(signal)
      const sha = await fileHash(file, signal)
      return { id: `local-${sha}`, type: file.toLowerCase().endsWith('.wav') ? 'audio' as const : 'video' as const }
    },
    async create(input, { signal }) {
      if (!input.videoPath || !input.audioPath) throw new Error('LatentSync 任务缺少主播视频或正文音频文件')
      const form = new FormData()
      const [video, audio] = await Promise.all([fs.readFile(input.videoPath), fs.readFile(input.audioPath)])
      form.append('video', new Blob([new Uint8Array(video)], { type: 'video/mp4' }), path.basename(input.videoPath))
      form.append('audio', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), path.basename(input.audioPath))
      for (const [name, value] of Object.entries(settings)) form.append(name, String(value))
      const response = await request('/v1/lipsync', { method: 'POST', body: form }, signal)
      return { id: latentJobId(await response.json()), job_type: MODEL, status: 'queued' }
    },
    async get(id, { signal }) {
      const response = await request(`/v1/jobs/${encodeURIComponent(id)}`, {}, signal)
      const body = await response.json(), status = latentStatus(body)
      if (status === 'completed' && (body.output_stage !== 'restored_video' || body.vae_sha256 !== VAE_SHA256)) {
        throw new Error('LatentSync 结果缺少完整模型校验和最终人脸回贴记录，请修复远端服务后继续原任务')
      }
      if (status === 'completed' && Object.entries(settings).some(([name, value]) => body.inference_settings?.[name] !== value)) {
        throw new Error('LatentSync 结果参数与当前质量设置不一致，不能复用旧口型视频')
      }
      if (status === 'completed' && body.geometry_dtype !== 'float32') {
        throw new Error('LatentSync 结果未使用已验收的 FP32 人脸对齐和回贴，请更新远端服务后继续原任务')
      }
      return { id, job_type: MODEL, status, result_url: status === 'completed' ? `latentsync://job/${id}` : undefined }
    },
    validateResultUrl(value) {
      if (!/^latentsync:\/\/job\/[A-Za-z0-9_-]{1,256}$/.test(value)) throw new Error('LatentSync 结果地址无效')
      return value
    },
    async download(value, target, { signal }) {
      const match = /^latentsync:\/\/job\/([A-Za-z0-9_-]{1,256})$/.exec(value)
      if (!match) throw new Error('LatentSync 结果地址无效')
      const response = await request(`/v1/jobs/${encodeURIComponent(match[1]! as string)}/result`, {}, signal)
      if (!response.body) throw new Error('LatentSync 结果没有视频内容')
      await pipeline(Readable.fromWeb(response.body as any), createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal })
    },
    async sleep(ms, signal) { await delay(ms, undefined, { signal }) },
    async close() { await tunnel?.close(); tunnel = undefined },
  }
}

async function acquireLock(directory: string) {
  const filename = path.join(directory, '.science-presenter.lock')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(filename, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync() }
      finally { await handle.close() }
      return () => fs.rm(filename, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let pid: number
      try { pid = JSON.parse(await fs.readFile(filename, 'utf8')).pid }
      catch { throw new Error('主播生成锁尚未确认，请稍后继续原任务') }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('主播生成锁无效，请核对原任务')
      try { process.kill(pid, 0); throw new Error('主播视频正在处理中，请勿重复提交') }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause }
      await fs.rm(filename, { force: true })
    }
  }
  throw new Error('主播视频正在处理中，请勿重复提交')
}

async function encode(input: string[], output: string, width: number, signal: AbortSignal) {
  const encoder = getVideoEncoderOptions({ width, height: width })
  const finish = ['-pix_fmt', 'yuv420p', '-movflags', '+faststart', output]
  try { await exec('ffmpeg', [...input, ...encoder, ...finish], { signal, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 }) }
  catch (error) {
    signal.throwIfAborted()
    if (!encoder.includes('h264_videotoolbox')) throw error
    await exec('ffmpeg', [...input, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', ...finish],
      { signal, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 })
  }
}

/** Paid creates have an exclusive durable guard; uncertain submissions are never replayed. */
export async function prepareSciencePresenterVideo(input: SciencePresenterVideoInput, options: SciencePresenterVideoOptions): Promise<SciencePresenterVideoResult> {
  const { signal } = options
  signal.throwIfAborted()
  const directory = path.resolve(input.directory)
  await fs.mkdir(directory, { recursive: true })
  const release = await acquireLock(directory)
  let runtime: SciencePresenterRuntime | undefined
  try {
    const sourcePath = path.resolve(input.videoPath)
    const introPath = path.resolve(input.referencePath || input.introPath || process.env.SCIENCE_PRESENTER_REFERENCE_PATH
      || process.env.SCIENCE_INTRO_VIDEO_PATH || defaultIntroPath)
    const settings = inferenceSettings(input)
    const [sourceSha256, introSha256, main, intro] = await Promise.all([
      fileHash(sourcePath, signal), fileHash(introPath, signal), probe(sourcePath, signal), probe(introPath, signal),
    ])
    if (!main.width || !main.height || !main.audio) throw new Error('原正片必须包含完整视频和正文音轨，不能生成替代配音')
    if (!intro.width || !intro.height) throw new Error('片头缺少可用的小鹭主播画面')
    const injectedRuntime = options.runtime !== undefined
    runtime = { ...createLatentSyncRuntime(settings), ...options.runtime }
    const promptSha256 = digest(PROMPT)
    const contentHash = digest(JSON.stringify([VERSION, MODEL, sourceSha256, introSha256, promptSha256, CHUNK_SECONDS, FPS, settings]))
    const work = path.join(directory, contentHash)
    await fs.mkdir(work, { recursive: true })
    const checkpointFile = path.join(work, 'science-presenter-video.json')
    const chunks: Chunk[] = []
    for (let start = 0; start < main.duration - .00001; start += CHUNK_SECONDS) {
      chunks.push({ index: chunks.length, start, duration: Math.min(CHUNK_SECONDS, main.duration - start) })
    }
    let checkpoint: Checkpoint = { version: VERSION, model: MODEL, contentHash, sourcePath, sourceSha256, introPath, introSha256,
      prompt: PROMPT, promptSha256, duration: main.duration, inferenceSettings: settings, chunks }
    try {
      const saved = JSON.parse(await fs.readFile(checkpointFile, 'utf8')) as Checkpoint
      if (saved.version !== VERSION || saved.model !== MODEL || saved.contentHash !== contentHash
        || saved.sourceSha256 !== sourceSha256 || saved.introSha256 !== introSha256 || saved.promptSha256 !== promptSha256
        || JSON.stringify(saved.inferenceSettings) !== JSON.stringify(settings)
        || !Array.isArray(saved.chunks) || saved.chunks.length !== chunks.length
        || saved.chunks.some((chunk, index) => chunk.index !== index || chunk.start !== chunks[index]!.start
          || Math.abs(chunk.duration - chunks[index]!.duration) > .000001 || chunk.jobId !== undefined && !validId(chunk.jobId))) {
        throw new Error('主播检查点与当前输入不一致，不能自动新建付费任务')
      }
      checkpoint = saved
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await saveJson(checkpointFile, checkpoint)
    }
    const save = () => saveJson(checkpointFile, checkpoint)
    const assertSources = async () => {
      if (!await matchesHash(sourcePath, sourceSha256, signal) || !await matchesHash(introPath, introSha256, signal)) {
      throw new Error('生成期间原正片或主播参考视频已改变，请基于当前素材重新生成')
      }
    }
    const presenterPath = path.join(work, 'presenter.mp4')
    if (checkpoint.chunks.every(chunk => chunk.videoSha256) && await matchesHash(presenterPath, checkpoint.presenterSha256, signal)) {
      const cached = await probe(presenterPath, signal)
      if (cached.width && !cached.audio && cached.duration + .001 >= main.duration && cached.duration - main.duration <= 1 / FPS + .001) {
        await assertSources()
        options.report?.('已复用与正文音轨同步的主播视频')
        return { presenterPath, sourceSha256 }
      }
    }
    if (!await matchesHash(introPath, checkpoint.videoSha256, signal)) {
      const videoSha256 = introSha256
      if (checkpoint.videoSha256 && videoSha256 !== checkpoint.videoSha256) throw new Error('主播片头视频已改变，请核对原任务')
      checkpoint.videoSha256 = videoSha256
      await save()
    }
    const fullAudioPath = path.join(work, 'main-audio.wav')
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', sourcePath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000',
      '-c:a', 'pcm_s16le', '-t', String(main.duration), fullAudioPath], { signal, timeout: 300_000, maxBuffer: 1024 * 1024 })
    if ((await probe(fullAudioPath, signal)).duration + 1 / FPS < main.duration) {
      throw new Error('正文音轨时长不足以覆盖原正片，不能补静音或循环生成主播')
    }
    if (!checkpoint.videoUploadId) {
      await assertSources()
      const uploaded = await runtime.upload(introPath, { signal })
      const validReferenceType = uploaded.type === 'video' || (injectedRuntime && uploaded.type === 'image')
      if (!validId(uploaded.id) || !validReferenceType) throw new Error('主播片头视频上传结果无效')
      checkpoint.videoUploadId = uploaded.id
      await save()
      signal.throwIfAborted()
    }
    for (const chunk of checkpoint.chunks) {
      signal.throwIfAborted()
      await assertSources()
      const stem = `segment-${String(chunk.index).padStart(4, '0')}`
      const audioPath = path.join(work, `${stem}.wav`)
      const rawPath = path.join(work, `${stem}.remote.mp4`)
      const videoPath = path.join(work, `${stem}.mp4`)
      const requiredFrames = Math.ceil(chunk.duration * FPS - .000001)
      if (await matchesHash(videoPath, chunk.videoSha256, signal)
        && (await probe(videoPath, signal)).duration + .001 >= requiredFrames / FPS) continue
      if (!await matchesHash(audioPath, chunk.audioSha256, signal)) {
        await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', fullAudioPath, '-ss', String(chunk.start), '-t', String(chunk.duration),
          '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', audioPath], { signal, timeout: 120_000, maxBuffer: 1024 * 1024 })
        if ((await probe(audioPath, signal)).duration + 1 / FPS < chunk.duration) throw new Error('正文分段音频不完整，未创建主播任务')
        const audioSha256 = await fileHash(audioPath, signal)
        if (chunk.audioSha256 && audioSha256 !== chunk.audioSha256) throw new Error('正文分段音频已改变，请核对原任务')
        chunk.audioSha256 = audioSha256
        await save()
      }
      if (!chunk.audioUploadId) {
        const uploaded = await runtime.upload(audioPath, { signal })
        if (!validId(uploaded.id) || uploaded.type !== 'audio') throw new Error('正文音频上传结果无效')
        chunk.audioUploadId = uploaded.id
        await save()
        signal.throwIfAborted()
      }
      if (!chunk.jobId) {
        await assertSources()
        if (chunk.dispatched) throw new Error('上一段主播任务提交结果待核对，不能自动重复生成')
        const guardPath = path.join(work, `${stem}.dispatched.json`)
        let guard
        try { guard = await fs.open(guardPath, 'wx', 0o600) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('上一段主播任务提交结果待核对，不能自动重复生成')
          throw error
        }
        try {
          await guard.writeFile(JSON.stringify({ sourceSha256, introSha256, audioSha256: chunk.audioSha256, inferenceSettings: settings,
            model: MODEL, promptSha256, dispatchedAt: new Date().toISOString() }))
          await guard.sync()
        } finally { await guard.close() }
        chunk.dispatched = true
        await save()
        const created = await runtime.create({ videoId: checkpoint.videoUploadId!, audioId: chunk.audioUploadId,
          videoPath: introPath, audioPath, prompt: PROMPT, inferenceSettings: settings }, { signal })
        if (!validId(created.id) || !injectedRuntime && created.job_type && created.job_type !== MODEL) throw new Error('主播提交结果待核对，不能自动重复生成')
        chunk.jobId = created.id
        chunk.status = created.status || 'queued'
        await save()
        signal.throwIfAborted()
      }
      const maxPolls = Math.max(1, Math.min(720, Math.floor(options.maxPolls || 360)))
      const haveRaw = await matchesHash(rawPath, chunk.rawSha256, signal)
      if (!haveRaw) chunk.resultUrl = undefined
      if (!haveRaw) for (let poll = 0; poll < maxPolls; poll++) {
        signal.throwIfAborted()
        const job = await runtime.get(chunk.jobId, { signal })
        if (job.id !== chunk.jobId || !injectedRuntime && job.job_type !== MODEL || !['queued', 'in_progress', 'completed', 'failed'].includes(job.status || '')) {
          throw new Error('主播远端任务与检查点不一致，已停止并保留原任务')
        }
        chunk.status = job.status
        if (job.status === 'completed') {
          if (!job.result_url) throw new Error('主播任务完成但尚无视频地址，请继续查询原任务')
          chunk.resultUrl = injectedRuntime && !options.runtime?.validateResultUrl
            ? httpsUrl(job.result_url)
            : runtime.validateResultUrl!(job.result_url)
        }
        await save()
        signal.throwIfAborted()
        if (job.status === 'failed') throw new Error('原主播生成任务失败，已保留任务编号，未自动重复付费')
        if (chunk.resultUrl) break
        options.report?.(`正在生成正文口型主播：第 ${chunk.index + 1}/${checkpoint.chunks.length} 段`)
        if (poll + 1 < maxPolls) await runtime.sleep(Math.max(0, options.pollIntervalMs ?? 10_000), signal)
      }
      if (!chunk.resultUrl) throw new Error('正文口型主播仍在生成，已保存原任务，请稍后继续')
      if (!haveRaw) {
        const temporary = path.join(work, `.${stem}-${randomUUID()}.partial.mp4`)
        try {
          const resultUrl = injectedRuntime && !options.runtime?.validateResultUrl
            ? httpsUrl(chunk.resultUrl)
            : runtime.validateResultUrl!(chunk.resultUrl)
          await runtime.download(resultUrl, temporary, { signal })
          const downloaded = await probe(temporary, signal)
          if (!downloaded.width || !downloaded.height) throw new Error('主播生成视频画幅无效，必须包含有效画面')
          const rawSha256 = await fileHash(temporary, signal)
          await fs.rename(temporary, rawPath)
          chunk.rawSha256 = rawSha256
          chunk.rawDuration = downloaded.duration
          await save()
        } finally { await fs.rm(temporary, { force: true }) }
      }
      const raw = await probe(rawPath, signal)
      if (raw.duration + raw.frameDuration + .001 < chunk.duration) throw new Error('主播视频时长不足以覆盖正文音频，不能冻结或循环补长')
      checkpoint.width ||= Math.min(raw.width, raw.height)
      const cropSide = Math.min(raw.width, raw.height)
      const cropX = Math.floor((raw.width - cropSide) / 2)
      const cropY = Math.floor((raw.height - cropSide) / 2)
      const temporary = path.join(work, `.${stem}-${randomUUID()}.partial.mp4`)
      try {
        await encode(['-nostdin', '-v', 'error', '-y', '-i', rawPath, '-map', '0:v:0', '-an', '-vf',
          `setpts=PTS-STARTPTS,fps=${FPS}:round=up,trim=end_frame=${requiredFrames},crop=${cropSide}:${cropSide}:${cropX}:${cropY},scale=${checkpoint.width}:${checkpoint.width}:flags=lanczos,setsar=1`,
          '-frames:v', String(requiredFrames)], temporary, checkpoint.width, signal)
        const trimmed = await probe(temporary, signal)
        if (trimmed.duration + .001 < requiredFrames / FPS) throw new Error('主播分段裁剪后时长不足，不能交付')
        const videoSha256 = await fileHash(temporary, signal)
        await fs.rename(temporary, videoPath)
        chunk.videoSha256 = videoSha256
        await save()
      } finally { await fs.rm(temporary, { force: true }) }
    }
    await assertSources()
    const listPath = path.join(work, 'presenter-segments.ffconcat')
    await fs.writeFile(listPath, checkpoint.chunks.map(chunk => `file segment-${String(chunk.index).padStart(4, '0')}.mp4`).join('\n') + '\n')
    const temporary = path.join(work, `.presenter-${randomUUID()}.partial.mp4`)
    try {
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', listPath,
        '-map', '0:v:0', '-an', '-c:v', 'copy', '-t', String(main.duration), '-movflags', '+faststart', temporary],
      { signal, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 })
      const output = await probe(temporary, signal)
      if (!output.width || output.audio || output.duration + .001 < main.duration || output.duration - main.duration > 1 / FPS + .001) {
        throw new Error('完整主播视频没有精确覆盖正片时长，未交付')
      }
      await assertSources()
      const presenterSha256 = await fileHash(temporary, signal)
      await fs.rename(temporary, presenterPath)
      checkpoint.presenterSha256 = presenterSha256
      await save()
      options.report?.('已生成与完整正文音轨同步的主播视频')
      return { presenterPath, sourceSha256 }
    } finally { await fs.rm(temporary, { force: true }) }
  } finally {
    try { await runtime?.close?.() } finally { await release() }
  }
}
