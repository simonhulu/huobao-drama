import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const MODEL = 'musetalk-v15'
const REVISION = '0a89dec45a0192b824e3cf4daf96c239440c5ed8'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
interface Identity { model: string; source_revision: string; avatar_id: string; reference_sha256: string; fps: number }
interface RemoteJob extends Identity {
  id?: string; job_id?: string; request_id: string; audio_sha256: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  result_sha256?: string; error?: string
}
interface Checkpoint {
  version: 1; requestId: string; sourceSha256: string; audioSha256: string; identity: Identity
  submitted?: boolean; jobId?: string; presenterSha256?: string
}
interface Api { apiUrl: string; close(): Promise<void> }
export interface ScienceMusetalkVideoOptions {
  signal: AbortSignal
  report?: (message: string) => void
}

function positive(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const number = Number(raw)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`${name} 必须是有效正整数`)
  return number
}

function origin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('MUSETALK_API_URL 不是有效地址') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('MUSETALK_API_URL 仅允许不含凭据的本机 HTTP(S) 服务地址，请通过 SSH 隧道连接远端')
  }
  return url.origin
}

async function localPort(): Promise<number> {
  const server = net.createServer()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法为 MuseTalk 分配本地端口')
    return address.port
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) }
}

async function connects(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (result: boolean) => { socket.destroy(); resolve(result) }
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(300, () => finish(false))
  })
}

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1500)
    child.once('exit', () => { clearTimeout(timer); resolve() }); child.kill('SIGTERM')
  })
}

function sshStartupError(stderr: string, launchCode?: string, timedOut = false): Error {
  let message = 'MuseTalk SSH 隧道启动失败，请检查 SSH 配置'
  if (launchCode === 'ENOENT') message = '未找到 SSH 客户端，请检查运行环境和 PATH'
  else if (launchCode) message = 'MuseTalk SSH 客户端无法启动，请检查运行环境和执行权限'
  else if (/host key verification failed|remote host identification has changed|offending .* key/i.test(stderr)) {
    message = 'MuseTalk SSH 主机密钥校验失败，请核对远端主机密钥配置'
  } else if (/permission denied|authentication failed|too many authentication failures|no more authentication methods|no supported authentication methods|sign_and_send_pubkey|no such identity|load key|unprotected private key|bad permissions|bad owner or permissions/i.test(stderr)) {
    message = 'MuseTalk SSH 认证失败，请检查凭据或密钥配置'
  } else if (/bad configuration|bad .*specification|bad port|unsupported option|could not open user config|address already in use|cannot assign requested address/i.test(stderr)) {
    message = 'MuseTalk SSH 选项或端口配置无效，请检查 SSH 配置'
  } else if (timedOut || /connection timed out|operation timed out|connection refused|no route to host|network is unreachable|connection reset|connection closed|connection aborted|could not resolve hostname/i.test(stderr)) {
    return Object.assign(new Error(timedOut ? 'MuseTalk SSH 隧道连接超时' : 'MuseTalk SSH 连接失败，远端暂不可达'),
      { code: timedOut ? 'ETIMEDOUT' : 'MUSETALK_SSH_UNAVAILABLE' })
  }
  return Object.assign(new Error(message), { code: 'MUSETALK_SSH_CONFIG' })
}

async function openApi(signal: AbortSignal): Promise<Api> {
  signal.throwIfAborted()
  if (process.env.MUSETALK_API_URL?.trim()) return { apiUrl: origin(process.env.MUSETALK_API_URL.trim()), async close() {} }
  const setting = (name: string, fallback: string) => process.env[`MUSETALK_${name}`]?.trim() || process.env[`LATENTSYNC_${name}`]?.trim() || fallback
  const host = setting('SSH_HOST', 'hz01-ssh.gpuhome.cc'), user = setting('SSH_USER', 'root')
  const remoteHost = process.env.MUSETALK_REMOTE_HOST?.trim() || '127.0.0.1'
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)
    || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(remoteHost)) throw new Error('MuseTalk SSH 主机、用户或远端回环地址无效')
  const sshPort = Number(setting('SSH_PORT', '30163'))
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('MUSETALK_SSH_PORT 无效')
  const remotePort = positive('MUSETALK_REMOTE_PORT', 8789, 65535), port = await localPort()
  const password = process.env.MUSETALK_SSH_PASSWORD || process.env.LATENTSYNC_SSH_PASSWORD
  const key = setting('SSH_KEY', path.join(os.homedir(), '.ssh', 'id_ed25519'))
  const args = ['-N', '-T', '-o', `BatchMode=${password ? 'no' : 'yes'}`, '-o', 'ConnectTimeout=15',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${port}:${remoteHost === '::1' ? '[::1]' : remoteHost}:${remotePort}`, '-p', String(sshPort)]
  if (key) args.push('-i', key)
  args.push(`${user}@${host}`)
  const env = { ...process.env }
  let askpass: string | undefined
  if (password) {
    if (os.platform() === 'win32') throw new Error('Windows 请使用 SSH 密钥，或先建立 SSH 隧道并设置 MUSETALK_API_URL')
    askpass = path.join(os.tmpdir(), `musetalk-askpass-${process.pid}-${randomUUID()}.sh`)
    await fs.writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$MUSETALK_ASKPASS_PASSWORD"\n', { mode: 0o700, flag: 'wx' })
    env.SSH_ASKPASS = askpass; env.SSH_ASKPASS_REQUIRE = 'force'; env.MUSETALK_ASKPASS_PASSWORD = password; env.DISPLAY = 'musetalk:0'
  } else env.SSH_ASKPASS_REQUIRE = 'never'
  let child: ChildProcess
  try { signal.throwIfAborted(); child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], env }) }
  catch (error) { if (askpass) await fs.rm(askpass, { force: true }); throw error }
  let failed = false, closed = false, launchCode: string | undefined, stderr = '', closing: Promise<void> | undefined
  // Keep diagnostics bounded and private; expose only the classified safe error.
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, Math.max(0, 8192 - stderr.length)) })
  child.on('error', error => { failed = true; launchCode = (error as NodeJS.ErrnoException).code })
  child.once('close', () => { closed = true })
  const close = () => closing ??= (async () => {
    await stop(child)
    if (askpass) await fs.rm(askpass, { force: true })
  })()
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (failed || closed) throw sshStartupError(stderr, launchCode)
      if (await connects(port)) return { apiUrl: `http://127.0.0.1:${port}`, close }
      await delay(150, undefined, { signal })
    }
    throw sshStartupError(stderr, launchCode, true)
  } catch (error) { await close(); signal.throwIfAborted(); throw error }
}

async function fileHash(filename: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const sha = createHash('sha256')
  for await (const data of createReadStream(filename, { signal })) sha.update(data)
  return sha.digest('hex')
}

async function save(filename: string, value: unknown) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename) }
  finally { await fs.rm(temporary, { force: true }) }
}

async function media(filename: string, signal: AbortSignal) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], { signal, timeout: 60_000 })
  const data = JSON.parse(stdout), video = data.streams?.find((item: any) => item.codec_type === 'video')
  const duration = Number(video?.duration ?? data.format?.duration)
  const fps = String(video?.avg_frame_rate || '')
  const [numerator, denominator = 1] = fps.split('/').map(Number), rate = numerator! / denominator!
  if (!video || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(rate) || rate < 1 || rate > 120) throw new Error('MuseTalk 视频时长或帧率无效')
  return { duration, fps, rate, video, audio: data.streams.some((item: any) => item.codec_type === 'audio') }
}

function identity(value: any): Identity {
  if (value?.model !== MODEL || value?.source_revision !== REVISION || !/^[A-Za-z0-9_-]{1,160}$/.test(value?.avatar_id || '')
    || !validHash(value?.reference_sha256) || ![15, 20, 25].includes(value?.fps)) throw new Error('MuseTalk 服务的模型、头像或帧率校验失败')
  return { model: value.model, source_revision: value.source_revision, avatar_id: value.avatar_id, reference_sha256: value.reference_sha256, fps: value.fps }
}

export async function checkScienceMusetalkAvailability(options: { signal: AbortSignal }): Promise<{ ready: boolean; message: string }> {
  options.signal.throwIfAborted()
  const deadline = AbortSignal.timeout(22_000), signal = AbortSignal.any([options.signal, deadline])
  let api: Api | undefined
  try {
    api = await openApi(signal)
    const response = await fetch(`${api.apiUrl}/health`, { signal })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if ([408, 429].includes(response.status) || response.status >= 500 && response.status <= 599) {
        return { ready: false, message: 'MuseTalk 服务暂不可用，等待 GPU 服务恢复' }
      }
      throw new Error(`MuseTalk 健康检查失败（HTTP ${response.status}）`)
    }
    const health = await response.json() as any
    signal.throwIfAborted()
    if (health?.status === 'loading') return { ready: false, message: 'MuseTalk 正在加载主播缓存，等待服务就绪' }
    identity(health)
    if (health.ok === true && health.status === 'ready') return { ready: true, message: 'MuseTalk 服务已就绪' }
    throw new Error('MuseTalk 健康检查返回异常服务状态，请检查服务配置及运行情况')
  } catch (error) {
    options.signal.throwIfAborted()
    const failure = error as { code?: string; cause?: { code?: string } }
    const code = failure?.cause?.code || failure?.code || ''
    if (deadline.aborted || error instanceof DOMException && error.name === 'TimeoutError'
      || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|UND_ERR_/i.test(code)
      || error instanceof TypeError && /fetch failed|terminated|network|socket/i.test(error.message)
      || code === 'MUSETALK_SSH_UNAVAILABLE') {
      return { ready: false, message: 'MuseTalk 服务暂不可达，等待 GPU 服务恢复' }
    }
    throw error
  } finally {
    try { await api?.close() } finally { options.signal.throwIfAborted() }
  }
}

function validateJob(value: any, checkpoint: Checkpoint): RemoteJob {
  const id = value?.job_id ?? value?.id
  if (id !== checkpoint.requestId || value?.request_id !== checkpoint.requestId || value?.audio_sha256 !== checkpoint.audioSha256
    || JSON.stringify(identity(value)) !== JSON.stringify(checkpoint.identity)
    || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(value?.status)) throw new Error('MuseTalk 任务与正文音频、头像或模型版本不一致')
  return value
}

/** Generate one full-narration presenter using a cached avatar on the remote GPU. */
export async function prepareScienceMusetalkVideo(input: { videoPath: string; directory: string }, options: ScienceMusetalkVideoOptions): Promise<{ presenterPath: string; sourceSha256: string }> {
  options.signal.throwIfAborted()
  let signal = options.signal
  const directory = path.resolve(input.directory), source = path.resolve(input.videoPath)
  await fs.mkdir(directory, { recursive: true })
  const lockPath = path.join(directory, '.musetalk.lock')
  let lock
  try { lock = await fs.open(lockPath, 'wx', 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let pid = 0
    try { pid = Number(await fs.readFile(lockPath, 'utf8')) } catch {}
    let running = true
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0) } catch (failure) { running = (failure as NodeJS.ErrnoException).code !== 'ESRCH' } }
    if (running) throw new Error('MuseTalk 主播正在处理中，请勿重复提交')
    await fs.rm(lockPath, { force: true }); lock = await fs.open(lockPath, 'wx', 0o600)
  }
  let api: Api | undefined
  let remoteJobId: string | undefined
  let succeeded = false
  try {
    await lock.writeFile(String(process.pid))
    const main = await media(source, signal)
    if (!main.audio) throw new Error('MuseTalk 正片缺少正文音轨')
    // Half-body blending needs a full-narration budget, bounded to 10-60 minutes.
    const remoteTimeoutMs = positive('MUSETALK_TIMEOUT_MS', Math.min(60 * 60_000, Math.max(10 * 60_000, Math.ceil(main.duration * 1000))))
    signal = AbortSignal.any([options.signal, AbortSignal.timeout(remoteTimeoutMs)])
    const sourceSha256 = await fileHash(source, signal)
    api = await openApi(signal)
    const request = async (url: string, init: RequestInit = {}, timeout = 60_000) => {
      const response = await fetch(`${api!.apiUrl}${url}`, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw Object.assign(new Error(`MuseTalk 请求失败（HTTP ${response.status}），已保留原任务检查点`), { status: response.status })
      }
      return response
    }
    const requestJson = async (url: string, init: RequestInit = {}, timeout = 60_000) => {
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted()
        try { return await (await request(url, init, timeout)).json() }
        catch (error) {
          signal.throwIfAborted()
          const status = (error as { status?: number })?.status
          const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code || (error as { code?: string })?.code || ''
          const temporary = status === 408 || status === 429 || status && status >= 500 && status <= 599
            || error instanceof DOMException && error.name === 'TimeoutError'
            || /fetch failed|terminated|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|UND_ERR_/i.test(`${error} ${code}`)
          if (attempt >= 3 || !temporary) throw error
          options.report?.(`MuseTalk 连接暂时中断，保持原任务编号重试（${attempt + 1}/3）`)
          await delay(250 * 2 ** (attempt - 1), undefined, { signal })
        }
      }
    }
    let health: any
    const readinessDeadline = Date.now() + 60_000
    while (true) {
      health = await requestJson('/health')
      if (health?.ok && health.status === 'ready') break
      if (health?.status !== 'loading' || Date.now() >= readinessDeadline) throw new Error('MuseTalk 远程服务尚未就绪，请稍后继续原任务')
      options.report?.('远程 MuseTalk 正在加载主播缓存')
      await delay(1000, undefined, { signal })
    }
    const model = identity(health)
    const contentHash = hash(JSON.stringify([1, sourceSha256, model]))
    const work = path.join(directory, `musetalk-${contentHash}`)
    await fs.mkdir(work, { recursive: true })
    const audioPath = path.join(work, 'narration.flac'), presenterPath = path.join(work, 'presenter.mp4')
    const checkpointPath = path.join(work, 'musetalk.json')
    let checkpoint: Checkpoint | undefined
    try {
      const prior = JSON.parse(await fs.readFile(checkpointPath, 'utf8')) as Checkpoint
      if (prior.version !== 1 || !validHash(prior.audioSha256) || prior.requestId !== hash(JSON.stringify([contentHash, prior.audioSha256])) || prior.sourceSha256 !== sourceSha256
        || JSON.stringify(prior.identity) !== JSON.stringify(model)) throw new Error('MuseTalk 检查点与当前正文不一致')
      checkpoint = prior
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (checkpoint?.presenterSha256) {
      try {
        if (await fileHash(presenterPath, signal) === checkpoint.presenterSha256) { succeeded = true; return { presenterPath, sourceSha256 } }
      }
      catch { signal.throwIfAborted() }
    }
    if (checkpoint) {
      try {
        if (await fileHash(audioPath, signal) !== checkpoint.audioSha256) throw new Error('hash mismatch')
      } catch { signal.throwIfAborted(); throw new Error('MuseTalk 已绑定的正文驱动音频缺失或改变，已保留原任务检查点，请恢复该音频文件') }
    } else {
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-c:a', 'flac', audioPath], { signal, timeout: 120_000 })
      const audioSha256 = await fileHash(audioPath, signal)
      checkpoint = { version: 1, requestId: hash(JSON.stringify([contentHash, audioSha256])), sourceSha256, audioSha256, identity: model }
    }
    const requestId = checkpoint.requestId
    const resumed = Boolean(checkpoint.submitted || checkpoint.jobId)
    remoteJobId = requestId
    if (!checkpoint.jobId) {
      options.report?.('正在提交整段正文到远程 MuseTalk，复用主播缓存')
      checkpoint.submitted = true
      await save(checkpointPath, checkpoint)
      const form = new FormData()
      form.set('request_id', requestId)
      form.set('audio', new Blob([await fs.readFile(audioPath)], { type: 'audio/flac' }), 'narration.flac')
      const job = validateJob(await requestJson('/v1/lipsync', { method: 'POST', body: form },
        positive('MUSETALK_UPLOAD_TIMEOUT_MS', 180_000, 600_000)), checkpoint)
      checkpoint.jobId = job.job_id ?? job.id
      await save(checkpointPath, checkpoint)
    }
    const jobUrl = `/v1/jobs/${checkpoint.jobId}`
    let completed: RemoteJob
    let retried = false, lastReport = 0
    while (true) {
      const job = validateJob(await requestJson(jobUrl), checkpoint)
      if (job.status === 'completed') { completed = job; break }
      if (resumed && !retried && ['failed', 'cancelled'].includes(job.status)) {
        validateJob(await requestJson(`${jobUrl}/retry`, { method: 'POST' }), checkpoint)
        retried = true
        options.report?.('正在恢复已保存的 MuseTalk 原任务')
        continue
      }
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(`MuseTalk 原任务${job.status === 'failed' ? '失败' : '已取消'}，已保留检查点，请核对远端任务后重试`)
      if (Date.now() - lastReport >= 30_000) {
        options.report?.(job.status === 'queued' ? '远程 MuseTalk 正在排队' : '远程 MuseTalk 正在生成整段同步口型')
        lastReport = Date.now()
      }
      await delay(positive('MUSETALK_POLL_INTERVAL_MS', 3000), undefined, { signal })
    }
    // Completed GPU work must not lose its local download/normalization budget.
    // Download, full decoding and CPU normalization share this budget on older Intel hosts.
    const postprocessTimeoutMs = Math.min(60 * 60_000, Math.max(15 * 60_000, Math.ceil(main.duration * 3000)))
    const postprocessDeadline = AbortSignal.timeout(postprocessTimeoutMs)
    signal = AbortSignal.any([options.signal, postprocessDeadline])
    options.report?.('MuseTalk 口型已完成，正在下载并校验主播视频')
    const raw = path.join(work, 'remote.mp4'), temporary = path.join(work, `.${randomUUID()}.mp4`)
    try {
      if (!validHash(completed.result_sha256)) throw new Error('MuseTalk 输出视频校验失败')
      let reusable = false
      try { reusable = await fileHash(raw, signal) === completed.result_sha256 }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (!reusable) {
        const response = await request(`${jobUrl}/result`, {}, postprocessTimeoutMs)
        if (!response.body) throw new Error('MuseTalk 没有返回口型视频')
        await pipeline(Readable.fromWeb(response.body as any), createWriteStream(raw), { signal })
        if (await fileHash(raw, signal) !== completed.result_sha256) throw new Error('MuseTalk 输出视频校验失败')
      }
      const remote = await media(raw, signal)
      if (Math.abs(remote.duration - main.duration) > .15 || Number(remote.video.width) !== 360 || Number(remote.video.height) !== 360) {
        throw new Error('MuseTalk 输出时长或尺寸不符合要求，不能冻结或循环补齐正文')
      }
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', raw, '-f', 'null', '-'], { signal, timeout: postprocessTimeoutMs })
      options.report?.('正在规范主播视频帧率，保留正文原声')
      const targetFrames = Math.max(1, Math.round(main.duration * main.rate))
      // Older Intel VideoToolbox can reject 360px sessions even when 1080p encoding works.
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-i', raw, '-an', '-vf',
        `setpts=PTS-STARTPTS,fps=${main.fps},tpad=stop_mode=clone:stop_duration=0.15,trim=end_frame=${targetFrames},setsar=1`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', temporary], { signal, timeout: postprocessTimeoutMs })
      const normalized = await media(temporary, signal)
      if (normalized.audio || normalized.duration + .001 < main.duration || Math.abs(normalized.duration - main.duration) > .08) throw new Error('MuseTalk 主播规范化时长校验失败')
      if (await fileHash(source, signal) !== sourceSha256) throw new Error('MuseTalk 生成期间正文文件发生变化，请继续原任务核对')
      await fs.rename(temporary, presenterPath)
      checkpoint.presenterSha256 = await fileHash(presenterPath, signal)
      await save(checkpointPath, checkpoint)
      succeeded = true
      return { presenterPath, sourceSha256 }
    } catch (error) {
      options.signal.throwIfAborted()
      if (postprocessDeadline.aborted) {
        throw Object.assign(new Error('MuseTalk 本地主播后处理超过处理时限，已保留远程成品和原任务检查点，请继续原任务重试', { cause: error }),
          { code: 'ETIMEDOUT', retryable: true })
      }
      throw error
    } finally { await fs.rm(temporary, { force: true }) }
  } finally {
    if (!succeeded && options.signal.aborted && api && remoteJobId) {
      try { await fetch(`${api.apiUrl}/v1/jobs/${remoteJobId}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }) } catch {}
    }
    try { await api?.close() } finally { await lock.close(); await fs.rm(lockPath, { force: true }) }
  }
}
