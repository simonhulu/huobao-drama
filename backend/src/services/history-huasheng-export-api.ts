import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { assertMediaDiskSpace, watchMediaDiskSpace, type MediaDiskSpaceCheck } from './storage-space.js'
import type { HTTPRequest, Page } from 'puppeteer-core'
import { closeHuashengTemporaryPage, connectHuashengBrowser, createHuashengTemporaryPage, huashengProjectUrl, HuashengBrowserError, resolveHuashengBrowserConfig, type HuashengBrowserConfig, type HuashengProductionObservation } from './history-huasheng-browser.js'

const ORIGIN = 'https://www.huasheng.cn'
const API = '/api/v2/innovideo'
const PROJECT_API = '/api/innovideo'
const EXPORT_ROOT = fileURLToPath(new URL('../../../data/huasheng-exports', import.meta.url))
const MAX_BYTES = 4 * 1024 ** 3
export type HuashengExportErrorCode = 'login_required' | 'browser_unavailable' | 'retryable' | 'invalid_response' | 'result_uncertain'
export class HuashengExportApiError extends Error {
  constructor(readonly code: HuashengExportErrorCode, message: string, readonly requestRejected = false) { super(message); this.name = 'HuashengExportApiError' }
}
export interface HuashengReadSession { cookie: string; userAgent: string }
export interface HuashengExportSession extends HuashengReadSession { ra: string; bs: string; fv: string; csrf: string }
interface ProjectInput { projectUrl: string; signal: AbortSignal; browserConfig?: HuashengBrowserConfig }
interface ProductionInput extends ProjectInput { script?: string; checkpoint?: string | null; expectedVoice?: { id: number; type: number } }
interface CreateInput extends ProjectInput { onDispatched?: () => void | Promise<void> }
interface InspectInput extends ProjectInput { taskId: string; projectHash: string }
export interface HuashengDownloadInput extends ProjectInput {
  projectHash: string; url: string; filename?: string | null
  onProgress?: (progress: { bytes: number; totalBytes: number | null }) => void
}

function pidOf(projectUrl: string) {
  const valid = huashengProjectUrl(projectUrl)
  const pid = valid?.split('/').at(-1)
  if (!pid || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) throw new HuashengExportApiError('invalid_response', '花生项目链接或编号无效')
  return pid
}
function validTask(taskId: string, projectHash: string) {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(taskId) || !/^[a-f0-9]{64}$/i.test(projectHash)) {
    throw new HuashengExportApiError('invalid_response', '花生导出任务编号或版本无效')
  }
}
function productionNumber(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
  if (!Number.isFinite(number) || number < 0 || number > max) throw new HuashengExportApiError('invalid_response', `花生项目${field}无效，未确认制作完成`)
  return number
}
function productionFlag(value: unknown, field: string): boolean {
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  throw new HuashengExportApiError('invalid_response', `花生项目${field}无效，未确认制作完成`)
}
function verifyProductionProject(project: any, pid: string, allowLegacyPending = false) {
  if (!project || String(project.pid) !== pid) throw new HuashengExportApiError('invalid_response', '花生返回的制作项目编号不匹配')
  // Observed legacy sandbox metadata uses -1 with this message while its v2
  // stage is still zero. Inspect that stage, but never treat -1 as completed.
  if (allowLegacyPending && (project.state === -1 || project.state === '-1')
    && typeof project.state_message === 'string' && /^视频制作中[，。,.\s]*$/.test(project.state_message)
    && productionFlag(project.is_agent_sandbox, '制作类型')) return -1
  if (productionNumber(project.state, '状态') !== 0) throw new HuashengExportApiError('invalid_response', '花生项目处理状态异常，请检查原项目')
  return 0
}
function mediaUrl(value: string, pid: string, projectHash: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new HuashengExportApiError('invalid_response', '花生返回的下载地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
    || !url.hostname.endsWith('.bilivideo.com') || !url.pathname.includes(`/${pid}/`)
    || !url.pathname.endsWith(`/video_${projectHash}.mp4`)) {
    throw new HuashengExportApiError('invalid_response', '视频下载地址与花生项目或导出版本不符')
  }
  return url
}

function browserSessionError(error: unknown): HuashengExportApiError {
  if (!(error instanceof HuashengBrowserError)) return new HuashengExportApiError('browser_unavailable', '花生专用浏览器未连接，请打开登录窗口')
  const code = error.code === 'login_required' ? 'login_required' : error.code === 'manual_review' ? 'invalid_response'
    : error.retryable ? 'retryable' : 'browser_unavailable'
  return new HuashengExportApiError(code, error.message)
}

/** Project status GETs only need the existing login cookies, without opening a page. */
export async function readHuashengProductionSession(input: ProjectInput): Promise<HuashengReadSession> {
  input.signal.throwIfAborted()
  const browser = await connectHuashengBrowser(input.browserConfig, input.signal).catch(error => {
    input.signal.throwIfAborted()
    throw browserSessionError(error)
  })
  try {
    const cookies = (await browser.defaultBrowserContext().cookies())
      .filter(cookie => ['huasheng.cn', '.huasheng.cn', 'www.huasheng.cn'].includes(cookie.domain))
    input.signal.throwIfAborted()
    if (!cookies.some(cookie => cookie.name === 'SESSDATA' && cookie.value)) {
      throw new HuashengExportApiError('login_required', '花生登录已过期，请在专用窗口重新登录，任务会保留')
    }
    return { cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), userAgent: await browser.userAgent() }
  } catch (error) {
    input.signal.throwIfAborted()
    if (error instanceof HuashengExportApiError) throw error
    throw new HuashengExportApiError('retryable', '读取花生登录会话失败，稍后自动重试')
  } finally { await browser.disconnect().catch(() => {}) }
}

/** Obtain official session fields from a normal, read-only request. No token is fabricated or persisted. */
export async function readHuashengExportSession(input: ProjectInput): Promise<HuashengExportSession> {
  return readHuashengAttestedSession(input, pidOf(input.projectUrl))
}

/** A new project has no pid yet; a harmless info lookup still initializes the site's request attestation. */
export async function readHuashengCreationSession(input: Omit<ProjectInput, 'projectUrl'>): Promise<HuashengExportSession> {
  return readHuashengAttestedSession(input, '0')
}

async function readHuashengAttestedSession(input: Omit<ProjectInput, 'projectUrl'>, pid: string): Promise<HuashengExportSession> {
  input.signal.throwIfAborted()
  const browser = await connectHuashengBrowser(input.browserConfig, input.signal).catch(error => {
    input.signal.throwIfAborted()
    throw browserSessionError(error)
  })
  let page: Page | undefined
  const abort = () => { if (page) void closeHuashengTemporaryPage(browser, page) }
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    input.signal.throwIfAborted()
    page = await createHuashengTemporaryPage(browser, input.signal)
    input.signal.throwIfAborted()
    let fields: { ra: string; bs: string; fv: string } | undefined
    page.on('request', (request: HTTPRequest) => {
      const url = new URL(request.url())
      if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/')) return
      const ra = url.searchParams.get('_ra'), bs = url.searchParams.get('_bs'), fv = url.searchParams.get('_fv')
      if (ra && bs && fv) fields = { ra, bs, fv }
    })
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    // The site's interceptor attaches csrf and attestation asynchronously after hydration.
    const until = Date.now() + 20_000
    while (!fields && Date.now() < until) {
      input.signal.throwIfAborted()
      await page.evaluate(async (projectId: string) => {
        await fetch(`/api/v2/innovideo/project/info?pid=${projectId}`, { credentials: 'include', signal: AbortSignal.timeout(5000) }).catch(() => {})
      }, pid)
      if (!fields) await delay(400, undefined, { signal: input.signal })
    }
    const cookies = (await browser.defaultBrowserContext().cookies()).filter(c => ['huasheng.cn', '.huasheng.cn', 'www.huasheng.cn'].includes(c.domain))
    const csrf = cookies.find(c => c.name === 'bili_jct')?.value
    if (!csrf || !cookies.some(c => c.name === 'SESSDATA' && c.value)) throw new HuashengExportApiError('login_required', '花生登录已过期，请在专用窗口重新登录，任务会保留')
    if (!fields) throw new HuashengExportApiError('retryable', '花生会话校验尚未就绪，稍后自动重试')
    return { ...fields, csrf, cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), userAgent: await browser.userAgent() }
  } catch (error) {
    input.signal.throwIfAborted()
    if (error instanceof HuashengExportApiError) throw error
    const failure = new HuashengExportApiError('retryable', '读取花生登录会话失败，稍后自动重试')
    failure.cause = error
    throw failure
  } finally {
    input.signal.removeEventListener('abort', abort)
    if (page) await closeHuashengTemporaryPage(browser, page)
    await browser.disconnect().catch(() => {})
  }
}

export function createHuashengExportClient(options: {
  session?: (input: ProjectInput) => Promise<HuashengExportSession>
  productionSession?: (input: ProjectInput) => Promise<HuashengReadSession>
  fetch?: typeof globalThis.fetch
} = {}) {
  const requestFetch = options.fetch ?? globalThis.fetch
  const sessions = new Map<string, { value: HuashengExportSession; at: number }>()
  const productionSessions = new Map<string, { value: HuashengReadSession; at: number }>()
  function sessionKey(input: ProjectInput) {
    const config = resolveHuashengBrowserConfig(input.browserConfig)
    return JSON.stringify([config.endpoint, config.profile, input.browserConfig?.expectedUid ?? null])
  }
  function invalidateSessions(input: ProjectInput) {
    const key = sessionKey(input)
    sessions.delete(key)
    productionSessions.delete(key)
  }
  function sameSession(first: HuashengReadSession, second: HuashengReadSession) {
    return first.cookie === second.cookie && first.userAgent === second.userAgent
  }
  async function session(input: ProjectInput) {
    input.signal.throwIfAborted()
    const key = sessionKey(input)
    try {
      const current = input.browserConfig?.expectedUid ? await productionSession(input) : null
      let cached = sessions.get(key)
      if (!cached || Date.now() - cached.at > 10 * 60_000 || current && !sameSession(current, cached.value)) {
        sessions.delete(key)
        cached = { value: await (options.session ?? readHuashengExportSession)(input), at: Date.now() }
        if (current && !sameSession(await productionSession(input), cached.value)) {
          throw new HuashengExportApiError('retryable', '花生登录会话在校验期间发生变化，请稍后继续原任务')
        }
        sessions.set(key, cached)
      }
      return cached.value
    } catch (error) {
      invalidateSessions(input)
      throw error
    }
  }
  async function productionSession(input: ProjectInput) {
    input.signal.throwIfAborted()
    const key = sessionKey(input)
    let cached = productionSessions.get(key)
    if (input.browserConfig?.expectedUid || !cached || Date.now() - cached.at > 10 * 60_000) {
      try {
        cached = { value: await (options.productionSession ?? readHuashengProductionSession)(input), at: Date.now() }
        productionSessions.set(key, cached)
      } catch (error) {
        invalidateSessions(input)
        throw error
      }
    }
    return cached.value
  }
  async function request(input: ProjectInput, endpoint: string, params: Record<string, string>, body?: Record<string, unknown>, beforePost?: CreateInput['onDispatched'], api = API, production = false) {
    const sessionCache = production ? productionSessions : sessions
    const exportAuth = production ? null : await session(input)
    const auth = exportAuth ?? await productionSession(input)
    const url = new URL(`${api}${endpoint}`, ORIGIN)
    const query = exportAuth ? { ...params, _ra: exportAuth.ra, _bs: exportAuth.bs, _fv: exportAuth.fv } : params
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    if (body) {
      if (!exportAuth) throw new HuashengExportApiError('invalid_response', '制作状态检查不允许发送变更请求')
      url.searchParams.set('csrf', exportAuth.csrf)
    }
    input.signal.throwIfAborted()
    if (body) await beforePost?.()
    if (body && input.browserConfig?.expectedUid) {
      // Checkpoint persistence can yield long enough for the browser login to change.
      try {
        if (!sameSession(await productionSession(input), auth)) {
          throw new HuashengExportApiError('retryable', '花生登录会话在导出发送前发生变化，请继续原任务')
        }
        input.signal.throwIfAborted()
      } catch (error) {
        invalidateSessions(input)
        throw new HuashengExportApiError(error instanceof HuashengExportApiError ? error.code : 'retryable',
          error instanceof HuashengExportApiError ? error.message : '花生账号核验尚未完成，导出请求未发送，请继续原任务', true)
      }
    }
    let response!: Response
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0 && input.browserConfig?.expectedUid && !sameSession(await productionSession(input), auth)) {
        invalidateSessions(input)
        throw new HuashengExportApiError('retryable', '花生登录会话在查询重试前发生变化，请继续原任务')
      }
      try {
        response = await requestFetch(url, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]),
          headers: { Cookie: auth.cookie, 'User-Agent': auth.userAgent, Referer: input.projectUrl, Origin: ORIGIN,
            ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        break
      } catch {
        if (!body) {
          input.signal.throwIfAborted()
          // A failed read is safe to repeat with the same project/task identity.
          // An uncertain export POST must never be replayed here.
          if (attempt < 2) { await delay((attempt + 1) * 1000, undefined, { signal: input.signal }); continue }
        }
        throw new HuashengExportApiError(body ? 'result_uncertain' : 'retryable', body
          ? '导出创建请求已发出但响应未确认，保留现场，请核对原项目后继续'
          : '花生接口连接中断，稍后继续查询原导出任务')
      }
    }
    if (response.status === 401 || response.status === 403) {
      sessionCache.delete(sessionKey(input))
      throw new HuashengExportApiError('login_required', '花生会话未通过校验，请检测登录后继续', Boolean(body))
    }
    let envelope: any
    try { envelope = await response.json() } catch {
      throw new HuashengExportApiError(body ? 'result_uncertain' : 'retryable', '花生接口响应不完整，尚未确认操作结果')
    }
    if (envelope?.code === -101 || envelope?.code === -111 || /未登录|登录过期|请.*登录|csrf/i.test(String(envelope?.message ?? ''))) {
      sessionCache.delete(sessionKey(input))
      throw new HuashengExportApiError('login_required', '花生登录或校验已过期，重新检测登录后自动继续', Boolean(body) && envelope?.code !== 0)
    }
    // This read-only legacy endpoint returns the project directly. Export
    // mutations and v2 responses still require an explicit successful code.
    if (response.ok && api === PROJECT_API && endpoint === '/project/info' && !body
      && envelope && typeof envelope === 'object' && !('code' in envelope)
      && envelope.project && typeof envelope.project === 'object') return envelope
    if (!response.ok || envelope?.code !== 0 || !envelope.data || typeof envelope.data !== 'object') {
      const message = typeof envelope?.message === 'string'
        ? envelope.message.replace(/https?:\/\/\S+/g, '[链接]').replace(/(?:_ra|csrf|token|cookie)\s*[:=]\s*\S+/gi, '[会话参数]').slice(0, 200) : '响应格式无效'
      const uncertain = Boolean(body) && (envelope?.code === 0 || response.status >= 500 || typeof envelope?.code !== 'number')
      throw new HuashengExportApiError(uncertain ? 'result_uncertain' : 'retryable', `花生导出接口未成功（${envelope?.code ?? response.status}）：${message}`,
        Boolean(body) && !uncertain && typeof envelope?.code === 'number' && envelope.code !== 0)
    }
    return envelope.data
  }
  return {
    async production(input: ProductionInput): Promise<HuashengProductionObservation> {
      const pid = pidOf(input.projectUrl)
      const legacy = await request(input, '/project/info', { pid }, undefined, undefined, PROJECT_API, true)
      const original = legacy.project
      const legacyState = verifyProductionProject(original, pid, true)
      // The sandbox script is rewritten by the platform; only legacy metadata
      // retains the exact original narration and can verify task ownership.
      if (input.script !== undefined && (typeof original.script !== 'string'
        || original.script.replace(/\r\n/g, '\n').trim() !== input.script.replace(/\r\n/g, '\n').trim())) {
        throw new HuashengExportApiError('invalid_response', '花生项目文稿与当前任务不一致，未导出')
      }
      if (input.expectedVoice && (productionNumber(original.voice_id, '配音音色') !== input.expectedVoice.id
        || productionNumber(original.voice_type, '配音类型') !== input.expectedVoice.type)) {
        throw new HuashengExportApiError('invalid_response', `花生原项目音色与指定音色 ${input.expectedVoice.id} 不一致，未继续导出或口型生成`)
      }
      const legacyProgress = productionNumber(original.progress, '制作进度', 100)
      const loading = productionNumber(original.loading_status, '加载状态', 1)
      const runningSteps = ([['tts_running', '生成配音'], ['voice_running', '处理声音'], ['composite_running', '合成视频'], ['motion_running', '制作动态画面']] as const)
        .filter(([field]) => productionFlag(original[field], field)).map(([, label]) => label)
      const running = runningSteps.length > 0
      const waitTime = productionNumber(original.wait_time, '排队时间')
      const sandbox = productionFlag(original.is_agent_sandbox, '制作类型')
      const data = sandbox ? await request(input, '/project/info', { pid }, undefined, undefined, API, true) : legacy
      const project = data.project
      verifyProductionProject(project, pid)
      const progress = productionNumber(project.progress, '制作进度', 100)
      const stage = productionNumber(sandbox ? project.project_stage : project.stage, '制作阶段', sandbox ? 3 : Number.MAX_SAFE_INTEGER)
      const compositing = productionFlag(project.composite_running, '合成状态')
      if (waitTime > 0) return { status: 'queued', message: '花生接口显示制作排队，等待处理' }
      // A sandbox project can briefly keep project_stage at zero after the
      // confirmation is accepted. An active compositor is authoritative in
      // that window; only an idle stage-zero project is truly not started.
      if (running || compositing) return { status: 'creating', message: `花生正在${[...new Set([...runningSteps, ...(compositing ? ['合成视频'] : [])])].join('、')}，完成后继续核对素材` }
      if (stage === 0) return { status: 'not_started', message: '花生接口显示项目尚未进入视频制作阶段' }
      const clips = data.clips
      if (clips !== null && !Array.isArray(clips)) throw new HuashengExportApiError('invalid_response', '花生项目分镜状态无效，未确认制作完成')
      const clipStates = Array.isArray(clips) ? clips.map(clip => productionNumber(clip?.state, '分镜状态', 1)) : []
      const clipsReady = clipStates.length > 0 && clipStates.every(state => state === 1)
      // Legacy progress can already be 100 for an unanswered sandbox plan.
      // Require its actual generation stage and completed clips as well.
      if (legacyState === 0 && (!sandbox || stage === 3) && legacyProgress === 100 && progress === 100 && loading === 1
        && !running && !compositing && clipsReady) {
        return { status: 'completed', message: '花生接口已确认制作完成，分镜素材已就绪' }
      }
      const waiting = []
      if (legacyState !== 0) waiting.push('平台尚未确认制作完成')
      if (sandbox && stage !== 3) waiting.push('制作阶段尚未完成')
      if (Math.min(legacyProgress, progress) < 100) waiting.push(`制作进度 ${Math.round(Math.min(legacyProgress, progress))}%`)
      if (loading !== 1) waiting.push('素材仍在加载')
      if (!clipsReady) waiting.push(clipStates.length ? `分镜素材已就绪 ${clipStates.filter(state => state === 1).length}/${clipStates.length}` : '分镜素材尚未返回')
      return { status: 'creating', message: `花生制作尚未完成：${waiting.join('；')}` }
    },
    async create(input: CreateInput) {
      const pid = pidOf(input.projectUrl)
      const data = await request(input, '/project/info', { pid })
      const project = data.project
      if (!project || String(project.pid) !== pid) throw new HuashengExportApiError('invalid_response', '花生返回的项目与当前稿件不一致，未创建导出')
      const aspect = project.aspect_ratio
      if (typeof aspect !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(aspect)) throw new HuashengExportApiError('invalid_response', '未读取到花生项目的有效画幅，未创建导出')
      const result = await request(input, '/project/export/video/task', {}, { pid: Number(pid), watermark: 0, ai_watermark: 0, aspect_ratio: aspect }, input.onDispatched)
      try { validTask(result.task_id, result.project_hash) } catch {
        throw new HuashengExportApiError('result_uncertain', '花生已响应导出创建，但缺少有效任务编号，未重复创建')
      }
      return { taskId: result.task_id as string, projectHash: result.project_hash as string }
    },
    async inspect(input: InspectInput) {
      const pid = pidOf(input.projectUrl)
      validTask(input.taskId, input.projectHash)
      const result = await request(input, '/project/export/video/info', { pid, task_id: input.taskId, project_hash: input.projectHash })
      if (typeof result.progress !== 'number' || !Number.isFinite(result.progress) || result.progress < 0 || result.progress > 100) {
        throw new HuashengExportApiError('invalid_response', '花生导出进度无效，未标记完成')
      }
      const url = typeof result.url === 'string' && result.url ? mediaUrl(result.url, pid, input.projectHash).toString() : null
      return { progress: result.progress, url, filename: typeof result.filename === 'string' && result.filename ? result.filename : null }
    },
  }
}

const client = createHuashengExportClient()
export const inspectHuashengProduction = client.production
export const createHuashengExport = client.create
export const inspectHuashengExport = client.inspect

/** A stable project/version filename makes restart recovery independent of an expiring CDN URL. */
export async function downloadHuashengExport(input: HuashengDownloadInput, options: {
  root?: string; fetch?: typeof globalThis.fetch; probe?: (filename: string) => Promise<number>
  checkDiskSpace?: MediaDiskSpaceCheck; diskCheckIntervalMs?: number
} = {}): Promise<{ filePath: string; filename: string; bytes: number }> {
  const pid = pidOf(input.projectUrl)
  validTask(`p${input.projectHash}`, input.projectHash)
  let url = mediaUrl(input.url, pid, input.projectHash)
  input.signal.throwIfAborted()
  const root = options.root ?? EXPORT_ROOT
  const directory = path.join(root, pid)
  await fs.promises.mkdir(directory, { recursive: true })
  const filePath = path.join(directory, `video_${input.projectHash}.mp4`)
  const partial = `${filePath}.part`
  const givenName = url.searchParams.get('attname') || input.filename || `花生成片-${pid}.mp4`
  const cleanName = path.basename(givenName).replace(/[\x00-\x1f]/g, '').slice(0, 200)
  const filename = /\.mp4$/i.test(cleanName) ? cleanName : `${cleanName || pid}.mp4`
  const probe = options.probe ?? (async file => (await import('./history-script-delivery.js')).probeFinishedVideo(file))
  const validate = async (file: string) => {
    try {
      const info = await fs.promises.lstat(file)
      if (!info.isFile() || !info.size || info.size > MAX_BYTES || (await probe(file)) <= 0) throw new Error('invalid video')
      return info.size
    } catch { throw new HuashengExportApiError('invalid_response', '下载文件不是完整可播放的视频，未关联项目') }
  }
  if (fs.existsSync(filePath)) {
    const bytes = await validate(filePath)
    input.signal.throwIfAborted()
    input.onProgress?.({ bytes, totalBytes: bytes })
    return { filePath, filename, bytes }
  }
  const existing = await fs.promises.lstat(partial).catch(() => null)
  if (existing && !existing.isFile()) throw new HuashengExportApiError('invalid_response', '下载临时文件无效')
  const checkDiskSpace = options.checkDiskSpace ?? assertMediaDiskSpace
  const diskError = (error: unknown) => new HuashengExportApiError('retryable',
    (error as NodeJS.ErrnoException)?.code === 'MEDIA_DISK_FULL'
      ? `${(error as Error).message}；下载断点已保留`
      : '暂时无法确认下载目录的剩余空间，已保留下载断点，可稍后重试')
  try { await checkDiskSpace(directory) } catch (error) { throw diskError(error) }
  let offset = existing?.size ?? 0
  const headers = { Referer: `${ORIGIN}/`, ...(offset ? { Range: `bytes=${offset}-` } : {}) }
  const requestFetch = options.fetch ?? globalThis.fetch
  let response: Response | undefined
  for (let redirects = 0; redirects < 4; redirects++) {
    input.signal.throwIfAborted()
    try { response = await requestFetch(url, { headers, redirect: 'manual', signal: AbortSignal.any([input.signal, AbortSignal.timeout(15 * 60_000)]) }) }
    catch { input.signal.throwIfAborted(); throw new HuashengExportApiError('retryable', '视频下载连接中断，已保留下载进度') }
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const redirect = response.headers.get('location')
    await response.body?.cancel()
    if (!redirect) throw new HuashengExportApiError('invalid_response', '视频下载重定向地址缺失')
    url = mediaUrl(new URL(redirect, url).toString(), pid, input.projectHash)
    response = undefined
  }
  // A process can exit after the last byte and before the atomic rename.
  if (response?.status === 416 && offset > 0) {
    const range = /^bytes \*\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
    await response.body?.cancel()
    if (range && Number(range[1]) === offset) {
      try {
        const bytes = await validate(partial)
        input.signal.throwIfAborted()
        await fs.promises.rename(partial, filePath)
        input.onProgress?.({ bytes, totalBytes: bytes })
        return { filePath, filename, bytes }
      } catch (error) {
        input.signal.throwIfAborted()
        // Only our uncommitted download is discarded. An attached file is never changed.
        await fs.promises.rm(partial, { force: true })
        throw error
      }
    }
    await fs.promises.rm(partial, { force: true })
    throw new HuashengExportApiError('retryable', '原下载范围已失效，下次重新下载当前导出文件')
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel()
    throw new HuashengExportApiError('retryable', `视频下载地址暂不可用（${response?.status ?? '重定向过多'}），将重新查询原导出任务`)
  }
  let totalBytes: number | null = null
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
    if (!range || Number(range[1]) !== offset || Number(range[2]) + 1 !== Number(range[3]) || Number(range[3]) <= offset) {
      await response.body.cancel()
      throw new HuashengExportApiError('retryable', '服务器返回的续传范围不匹配，已保留原文件')
    }
    totalBytes = Number(range[3])
  } else {
    offset = 0
    const length = Number(response.headers.get('content-length'))
    if (length > 0) totalBytes = length
  }
  if (totalBytes !== null && totalBytes > MAX_BYTES) {
    await response.body.cancel()
    throw new HuashengExportApiError('invalid_response', '花生成片超过 4 GB，未关联项目')
  }
  try { await checkDiskSpace(directory, totalBytes === null ? 0 : totalBytes - offset) }
  catch (error) { await response.body.cancel(); throw diskError(error) }
  let bytes = offset, lastUpdate = 0
  input.onProgress?.({ bytes, totalBytes })
  const diskWatcher = watchMediaDiskSpace(directory, { check: checkDiskSpace, intervalMs: options.diskCheckIntervalMs })
  let checkedBytes = bytes
  try {
    await pipeline(Readable.fromWeb(response.body as any), new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length
      if (Date.now() - lastUpdate > 1000) { lastUpdate = Date.now(); input.onProgress?.({ bytes, totalBytes }) }
      if (bytes > MAX_BYTES) { done(new HuashengExportApiError('invalid_response', '花生成片超过 4 GB，未关联项目')); return }
      if (bytes - checkedBytes < 32 * 1024 ** 2) { done(null, chunk); return }
      checkedBytes = bytes
      diskWatcher.check().then(() => { diskWatcher.signal.throwIfAborted() }).then(() => done(null, chunk), done)
    } }), fs.createWriteStream(partial, { flags: offset ? 'a' : 'w' }), { signal: AbortSignal.any([input.signal, diskWatcher.signal]) })
    diskWatcher.signal.throwIfAborted()
  } catch (error) {
    input.signal.throwIfAborted()
    if (diskWatcher.signal.aborted) throw diskError(diskWatcher.signal.reason)
    if (error instanceof HuashengExportApiError) throw error
    throw new HuashengExportApiError('retryable', '视频下载中断，已保留下载进度，将继续查询原导出任务')
  } finally { diskWatcher.stop() }
  if (totalBytes !== null && bytes !== totalBytes) throw new HuashengExportApiError('retryable', '视频下载不完整，已保留下载进度')
  try { await validate(partial) } catch (error) {
    await fs.promises.rm(partial, { force: true })
    throw error
  }
  input.signal.throwIfAborted()
  await fs.promises.rename(partial, filePath)
  input.onProgress?.({ bytes, totalBytes: bytes })
  return { filePath, filename, bytes }
}
