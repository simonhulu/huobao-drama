import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { parseHistoryYoutubeUrl } from './history-source-youtube-url.js'
import type { collectHistoryYoutubeVideos, HistoryYoutubeCandidate } from './history-source-youtube.js'
import { getScienceWorkflowService, ScienceWorkflowError, type ScienceJob, type ScienceWorkflowService } from './science-workflow.js'

const defaultRoot = fileURLToPath(new URL('../../../data/science-pop/collection/', import.meta.url))
const modeSchema = z.enum(['drafts', 'videos', 'upload'])
const targetSchema = z.number().int().min(1).max(9999).nullable()
const accountSchema = z.string().trim().min(1).max(100).nullable()
const channelSchema = z.string().trim().min(1).max(2048).transform((value, context) => {
  try {
    const source = parseHistoryYoutubeUrl(value)
    if (source.kind !== 'channel') throw new Error('频道列表只接受 YouTube 频道主页或 videos 链接')
    return source.url
  } catch (error) { context.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER }
})
function channelIdentity(value: string) {
  const pathname = decodeURIComponent(new URL(value).pathname).normalize('NFC')
  return pathname.startsWith('/@') ? pathname.toLowerCase() : pathname
}
export const scienceCollectionSettingsSchema = z.object({
  youtubeChannels: z.array(channelSchema).max(30).refine(values => new Set(values.map(channelIdentity)).size === values.length, 'YouTube 频道不能重复'),
  targetCount: targetSchema, mode: modeSchema, huashengAccountName: accountSchema, baijiahaoAccountName: accountSchema,
}).strict()
export const scienceCollectionStartSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), targetCount: targetSchema.optional(), mode: modeSchema.optional(),
  huashengAccountName: accountSchema.optional(), baijiahaoAccountName: accountSchema.optional(),
}).strict()
export const scienceCollectionRetrySchema = z.object({
  jobIds: z.array(z.string().regex(/^science-[a-f0-9-]{36}$/)).min(1).max(9999)
    .refine(values => new Set(values).size === values.length, '任务编号不能重复').optional(),
}).strict()
const settingsPatchSchema = scienceCollectionSettingsSchema.partial().refine(value => Object.keys(value).length > 0, '请提交采集设置')
export type ScienceCollectionMode = z.infer<typeof modeSchema>
export type ScienceCollectionSettings = z.infer<typeof scienceCollectionSettingsSchema>
export interface ScienceCollectionItem {
  jobId: string; sourceUrl: string; videoId: string; title: string
  status: 'queued' | 'paused' | 'running' | 'completed' | 'failed' | 'deleted'; message: string
  completedBeforeDeletion?: boolean
}
export interface ScienceCollectionRun extends ScienceCollectionSettings {
  id: string; status: 'running' | 'stopping' | 'stopped' | 'interrupted' | 'completed' | 'needs_attention'
  message: string; currentChannel: string | null; currentJobId: string | null
  counts: { scanned: number; selected: number; skipped: number; completed: number; failed: number }
  items: ScienceCollectionItem[]; channelErrors: Array<{ url: string; message: string }>
  collection?: { status: ScienceCollectionRun['status']; message: string }
  processing?: { status: ScienceCollectionRun['status'] | 'queued'; message: string }
  retry?: { jobIds: string[]; startedAt: string; finishedAt: string | null; completed: number; failed: number }
  logs: Array<{ at: string; message: string }>; createdAt: string; updatedAt: string
}
interface StoredRun extends ScienceCollectionRun {
  version: 1; requestId: string; inputHash: string; ownerPid?: number; stopRequested?: boolean
  pendingRetryJobIds?: string[]
  collectionOwnerPid?: number; collectionStopRequested?: boolean
}
type Workflow = Pick<ScienceWorkflowService, 'create' | 'knownYoutubeIds' | 'jobsForCollection' | 'runBatchJob' | 'validateBatchAccounts' | 'cancel'>
export interface ScienceCollectionOptions { stateRoot?: string; workflow?: Workflow; collect?: typeof collectHistoryYoutubeVideos }
interface LiveRun { id: string; token: string; controller: AbortController; done: Promise<void> }
// Shared by service instances, including test/route instances, so reads cannot orphan a live worker.
const live = new Map<string, LiveRun>()
const collecting = new Map<string, LiveRun>()
const isActive = (status: string) => status === 'running' || status === 'stopping'
const safeMessage = (value: unknown) => String(value instanceof Error ? value.message : value)
  .replace(/\bBearer\s+\S+|\bsk-[\w.-]+/gi, '[已隐藏]')
  .replace(/(?:api[_-]?key|authorization|token|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, '[会话信息已隐藏]')
  .replace(/https?:\/\/[^\s"'<>]+/g, '[链接]').replace(/\/(?:Users|home|private|tmp|var)\/[^\s"']+/g, '[本地路径]').slice(0, 1200)
function alive(pid: number | undefined) {
  if (!Number.isInteger(pid) || !pid || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
function atomicWrite(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file) }
  finally { fs.rmSync(temporary, { force: true }) }
}
const defaults = (): ScienceCollectionSettings => ({ youtubeChannels: [], targetCount: 5, mode: 'upload', huashengAccountName: null, baijiahaoAccountName: null })
function reached(run: ScienceCollectionRun) { return run.targetCount !== null && run.counts.selected >= run.targetCount }
function awaitingWorkflow(job: ScienceJob) {
  return job.executionActive === true || job.status === 'retry_wait' && Boolean(job.automaticRetry || job.uploadRetry)
}
function achieved(job: ScienceJob, run: ScienceCollectionRun) {
  if (job.deletedAt || job.status === 'running' || awaitingWorkflow(job)) return false
  if (run.mode === 'drafts') return Boolean(job.script.trim())
  if (run.mode === 'videos') return Boolean(job.videoUrl) && job.huashengAccountName === run.huashengAccountName
  return Boolean(job.status === 'completed' && job.upload?.submitted === true && job.upload.saved === false
    && job.upload.accountName === run.baijiahaoAccountName && job.videoUrl)
}
export class ScienceBatchBlockedError extends ScienceWorkflowError {}
function batchBlocker(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { retryable?: boolean }).retryable === true) return true
  const message = String(error instanceof Error ? error.message : error)
  return /登录|登陆|会话|验证码|验证身份|人机验证|未授权|配额|额度|余额|限流|访问频率|请求频率|频率受限|quota|rate.?limit|too many requests|insufficient.*(?:credit|balance|quota)|\b(?:401|402|403|429)\b|No active (?:text|audio).*config|active MiniMax audio configuration is required|未找到可用的指定克隆音色|指定的花生音色编号或类型无效|未找到\s*(?:yt-dlp|Chrome|social-auto-upload)|(?:ffmpeg|ffprobe).*ENOENT|ENOENT.*(?:ffmpeg|ffprobe)|HISTORY_YOUTUBE_PROXY\s*代理地址无效|YouTube 代理需要 HTTP|HISTORY_YOUTUBE_COOKIES_BROWSER\s*需要受支持|HUASHENG_(?:CDP|PROFILE|CHROME)|花生.*浏览器.*(?:未连接|启动失败|启动超时|连接中断)|\b(?:ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND)\b/i.test(message)
}

export class ScienceCollectionService {
  readonly stateRoot: string
  private automaticTimer?: ReturnType<typeof setInterval>
  private stopping = false
  constructor(private readonly options: ScienceCollectionOptions = {}) {
    const directory = path.resolve(options.stateRoot || defaultRoot)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); this.stateRoot = fs.realpathSync(directory)
  }
  private get workflow() { return this.options.workflow || getScienceWorkflowService() }
  private get lockFile() { return path.join(this.stateRoot, 'worker.lock') }
  private get collectionLockFile() { return path.join(this.stateRoot, 'collector.lock') }
  private filename(id: string) {
    if (!/^science-batch-[a-f0-9-]{36}$/.test(id)) throw new ScienceWorkflowError('科普批次编号无效', 400)
    return path.join(this.stateRoot, 'runs', `${id}.json`)
  }
  private write(run: StoredRun) {
    run.updatedAt = new Date().toISOString()
    this.updateCounts(run)
    atomicWrite(this.filename(run.id), run)
  }
  private updateCounts(run: StoredRun) {
    run.counts.selected = run.items.length
    run.counts.completed = run.items.filter(item => item.status === 'completed' || item.status === 'deleted' && item.completedBeforeDeletion).length
    run.counts.failed = run.items.filter(item => item.status === 'failed').length
    if (run.retry) {
      const selected = new Set(run.retry.jobIds)
      run.retry.completed = run.items.filter(item => selected.has(item.jobId) && (item.status === 'completed' || item.status === 'deleted' && item.completedBeforeDeletion)).length
      run.retry.failed = run.items.filter(item => selected.has(item.jobId) && item.status === 'failed').length
    }
  }
  private read(id: string): StoredRun {
    const filename = this.filename(id)
    if (!fs.existsSync(filename)) throw new ScienceWorkflowError('科普采集批次不存在', 404)
    const run: StoredRun = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (run.version !== 1 || run.id !== id || !Array.isArray(run.items)) throw new ScienceWorkflowError('科普采集批次记录无法读取', 503)
    const handle = live.get(this.stateRoot)
    if ((run.processing ? isActive(run.processing.status) : isActive(run.status))
      && handle?.id !== id && (run.ownerPid === process.pid || !alive(run.ownerPid))) {
      run.status = 'interrupted'; run.message = '采集批次已中断，已有任务和平台检查点保留，可继续本批次'
      if (run.processing) run.processing = { status: 'interrupted', message: '制作执行已中断，保留原任务等待恢复' }
      run.currentJobId = null; delete run.ownerPid
      for (const item of run.items) if (item.status === 'running') { item.status = 'queued'; item.message = '执行中断，等待继续' }
      this.write(run)
    }
    if (run.collection && isActive(run.collection.status) && collecting.get(this.stateRoot)?.id !== id
      && (run.collectionOwnerPid === process.pid || !alive(run.collectionOwnerPid))) {
      run.collection = { status: run.collectionStopRequested ? 'stopped' : 'interrupted', message: '采集已中断，已入库来源保留' }
      run.status = run.collectionStopRequested ? 'stopped' : 'interrupted'
      delete run.collectionOwnerPid; run.currentChannel = null
      this.write(run)
    }
    return run
  }
  private all() {
    const directory = path.join(this.stateRoot, 'runs')
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory).filter(name => /^science-batch-[a-f0-9-]{36}\.json$/.test(name))
      .map(name => this.read(name.slice(0, -5))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  private publicRun(run: StoredRun): ScienceCollectionRun {
    const { version: _version, requestId: _request, inputHash: _hash, ownerPid: _pid, stopRequested: _stop,
      collectionOwnerPid: _collectionPid, collectionStopRequested: _collectionStop,
      pendingRetryJobIds: _pendingRetry, ...result } = this.synchronize(structuredClone(run))
    return result
  }
  private update(id: string, change: (run: StoredRun) => void) { const run = this.read(id); change(run); this.write(run); return run }
  private report(id: string, message: string) {
    return this.update(id, run => { run.message = message; if (run.logs.at(-1)?.message !== message) run.logs = [...run.logs, { at: new Date().toISOString(), message }].slice(-200) })
  }
  settings(): ScienceCollectionSettings {
    const file = path.join(this.stateRoot, 'settings.json')
    if (!fs.existsSync(file)) return defaults()
    try { return scienceCollectionSettingsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) }
    catch { throw new ScienceWorkflowError('科普频道设置无法读取，请检查本机采集配置', 503) }
  }
  saveSettings(input: unknown) {
    const settings = scienceCollectionSettingsSchema.parse({ ...this.settings(), ...settingsPatchSchema.parse(input) })
    atomicWrite(path.join(this.stateRoot, 'settings.json'), settings)
    return settings
  }
  overview() {
    const runs = this.all().map(run => this.publicRun(run))
    return { settings: this.settings(), runs, activeRun: runs.find(run => isActive(run.status)) || null,
      activeCollection: runs.find(run => run.collection && isActive(run.collection.status)) || null }
  }
  start(input: unknown) {
    const request = scienceCollectionStartSchema.parse(input)
    const inputHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const existing = this.all().find(run => run.requestId === request.requestId)
    if (existing) {
      if (existing.inputHash !== inputHash) throw new ScienceWorkflowError('该启动请求已使用不同设置，请刷新后重新开始')
      return this.publicRun(existing)
    }
    const settings = this.settings()
    if (!settings.youtubeChannels.length) throw new ScienceWorkflowError('请先维护至少一个 YouTube 频道', 400)
    const mode = request.mode ?? settings.mode
    const hs = request.huashengAccountName === undefined ? settings.huashengAccountName ?? undefined : request.huashengAccountName
    const bj = request.baijiahaoAccountName === undefined ? settings.baijiahaoAccountName ?? undefined : request.baijiahaoAccountName
    let accounts: { huashengAccountName: string | null; baijiahaoAccountName: string | null }
    try { accounts = this.workflow.validateBatchAccounts('drafts', hs, bj) }
    catch { accounts = { huashengAccountName: hs ?? null, baijiahaoAccountName: bj ?? null } }
    const timestamp = new Date().toISOString()
    const run: StoredRun = { version: 1, id: `science-batch-${randomUUID()}`, requestId: request.requestId, inputHash,
      youtubeChannels: [...settings.youtubeChannels], targetCount: request.targetCount === undefined ? settings.targetCount : request.targetCount, mode, ...accounts,
      status: 'running', message: '正在开始频道采集', currentChannel: null, currentJobId: null,
      collection: { status: 'running', message: '正在开始频道采集' },
      processing: { status: 'queued', message: '等待来源入库' },
      counts: { scanned: 0, selected: 0, skipped: 0, completed: 0, failed: 0 }, items: [], channelErrors: [], logs: [], createdAt: timestamp, updatedAt: timestamp }
    return this.launchCollection(run)
  }
  private acquire(id: string) {
    if (live.has(this.stateRoot)) throw new ScienceWorkflowError('已有科普批次正在执行，请等待或停止后再开始')
    if (this.all().some(run => isActive(run.status) && (!run.processing || isActive(run.processing.status)))) throw new ScienceWorkflowError('已有科普制作队列正在执行，请等待后继续')
    const token = randomUUID()
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = path.join(this.stateRoot, `worker-${token}.tmp`)
      try {
        // Link a fully written record atomically, so a crash cannot leave an
        // empty lock that looks like another process still initializing.
        fs.writeFileSync(prepared, JSON.stringify({ pid: process.pid, id, token }), { flag: 'wx', mode: 0o600 })
        fs.linkSync(prepared, this.lockFile)
        return token
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let raw: string, lock: { pid?: number; token?: string }
        try { raw = fs.readFileSync(this.lockFile, 'utf8'); lock = JSON.parse(raw) }
        catch { throw new ScienceWorkflowError('另一个采集进程正在初始化，请稍后重试') }
        if (alive(lock.pid) && lock.pid !== process.pid || lock.pid === process.pid && live.has(this.stateRoot)) throw new ScienceWorkflowError('另一个进程正在执行科普采集')
        if (fs.readFileSync(this.lockFile, 'utf8') === raw) fs.rmSync(this.lockFile)
      } finally { fs.rmSync(prepared, { force: true }) }
    }
    throw new ScienceWorkflowError('采集执行权暂不可用，请稍后重试')
  }
  private release(token: string) {
    try { if (JSON.parse(fs.readFileSync(this.lockFile, 'utf8')).token === token) fs.rmSync(this.lockFile) } catch { /* A missing/replaced lock is never removed. */ }
  }
  private launch(run: StoredRun, automaticRecovery = false) {
    const token = this.acquire(run.id), controller = new AbortController()
    const handle: LiveRun = { id: run.id, token, controller, done: Promise.resolve() }
    live.set(this.stateRoot, handle)
    try {
      run.status = 'running'; run.ownerPid = process.pid; run.stopRequested = false
      run.processing = { status: 'running', message: '正在处理已入库任务' }; this.write(run)
    }
    catch (error) { live.delete(this.stateRoot); this.release(token); throw error }
    // A stop requested through another process is observed even while a video is rendering.
    const stopPoll = setInterval(() => {
      try { if (this.read(run.id).stopRequested) controller.abort() } catch { controller.abort() }
    }, 1000)
    stopPoll.unref()
    handle.done = Promise.resolve().then(() => this.execute(run.id, controller.signal, automaticRecovery)).catch(error => {
      const explicitlyStopped = this.read(run.id).stopRequested === true
      this.update(run.id, current => {
        current.status = controller.signal.aborted ? explicitlyStopped ? 'stopped' : 'interrupted' : 'needs_attention'; current.currentJobId = null
        current.processing = { status: current.status, message: controller.signal.aborted ? '制作已暂停，已入库任务与检查点保留' : safeMessage(error) }
        if (current.collection && isActive(current.collection.status)) current.status = current.collection.status
        for (const item of current.items) if (item.status === 'running') { item.status = 'queued'; item.message = '执行已停止，素材和检查点保留' }
      })
      this.report(run.id, controller.signal.aborted
        ? explicitlyStopped ? '批次已停止，已完成结果保留，可继续本批次' : '服务已中断，已保留原批次，启动后自动继续'
        : safeMessage(error))
    }).finally(() => {
      clearInterval(stopPoll)
      try { this.update(run.id, current => {
        if (current.collection && isActive(current.collection.status)) current.ownerPid = current.collectionOwnerPid
        else delete current.ownerPid
        current.currentJobId = null
      }) }
      finally { live.delete(this.stateRoot); this.release(token); this.runProcessingQueue() }
    })
    return this.publicRun(this.read(run.id))
  }
  private verifyOwner(id: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const handle = live.get(this.stateRoot)
    let lock: { token?: string } | undefined
    try { lock = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) } catch { /* Fail closed before work. */ }
    if (handle?.id !== id || lock?.token !== handle.token) throw new ScienceWorkflowError('采集执行权已变化，已停止启动新任务')
    if (this.read(id).stopRequested) { handle.controller.abort(); signal.throwIfAborted() }
  }
  private processingReport(id: string, message: string) {
    this.update(id, run => { if (run.processing) run.processing.message = message })
    return this.report(id, message)
  }
  private collectionReport(id: string, message: string) {
    this.update(id, run => { run.collection!.message = message })
    return this.report(id, message)
  }
  private acquireCollection(id: string) {
    if (collecting.has(this.stateRoot) || this.all().some(run =>
      run.collection ? isActive(run.collection.status) : !run.processing && !run.retry && isActive(run.status)))
      throw new ScienceWorkflowError('已有采集任务正在执行，请等待或停止采集后再开始')
    const token = randomUUID()
    const prepared = path.join(this.stateRoot, `collector-${token}.tmp`)
    try {
      fs.writeFileSync(prepared, JSON.stringify({ pid: process.pid, id, token }), { flag: 'wx', mode: 0o600 })
      for (let attempt = 0; attempt < 2; attempt++) {
        try { fs.linkSync(prepared, this.collectionLockFile); return token }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const raw = fs.readFileSync(this.collectionLockFile, 'utf8')
          let lock: { pid?: number }
          try { lock = JSON.parse(raw) } catch { throw new ScienceWorkflowError('另一个采集进程正在初始化，请稍后重试') }
          if (alive(lock.pid)) throw new ScienceWorkflowError('另一个进程正在执行科普采集')
          if (fs.readFileSync(this.collectionLockFile, 'utf8') === raw) fs.rmSync(this.collectionLockFile)
        }
      }
      throw new ScienceWorkflowError('采集执行权暂不可用')
    } finally { fs.rmSync(prepared, { force: true }) }
  }
  private verifyCollectionOwner(id: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const handle = collecting.get(this.stateRoot)
    let lock: { token?: string } | undefined
    try { lock = JSON.parse(fs.readFileSync(this.collectionLockFile, 'utf8')) } catch { /* Check before creating a source. */ }
    if (handle?.id !== id || lock?.token !== handle.token) throw new ScienceWorkflowError('采集执行权已变化，已停止入库')
    if (this.read(id).collectionStopRequested) { handle.controller.abort(); signal.throwIfAborted() }
  }
  private launchCollection(run: StoredRun) {
    const token = this.acquireCollection(run.id), controller = new AbortController()
    const handle: LiveRun = { id: run.id, token, controller, done: Promise.resolve() }
    collecting.set(this.stateRoot, handle)
    try {
      run.collection = { status: 'running', message: '正在采集频道来源' }
      run.collectionOwnerPid = process.pid; run.collectionStopRequested = false; run.status = 'running'
      run.ownerPid ??= process.pid
      run.processing ??= { status: 'queued', message: '等待来源入库' }
      this.write(run)
    } catch (error) { collecting.delete(this.stateRoot); this.releaseCollection(token); throw error }
    const stopPoll = setInterval(() => {
      try { if (this.read(run.id).collectionStopRequested) controller.abort() } catch { controller.abort() }
    }, 1000)
    stopPoll.unref()
    handle.done = Promise.resolve().then(() => this.executeCollection(run.id, controller.signal)).catch(error => {
      this.update(run.id, current => {
        const status = controller.signal.aborted ? current.collectionStopRequested ? 'stopped' : 'interrupted' : 'needs_attention'
        const message = controller.signal.aborted ? '采集已暂停，已入库来源保留' : `采集需要处理：${safeMessage(error)}`
        current.collection = { status, message }; current.status = status; current.message = message
      })
    }).finally(() => {
      clearInterval(stopPoll)
      try { this.update(run.id, current => {
        delete current.collectionOwnerPid; current.currentChannel = null
        if (!current.processing || !isActive(current.processing.status)) delete current.ownerPid
      }) }
      finally { collecting.delete(this.stateRoot); this.releaseCollection(token); this.runProcessingQueue() }
    })
    return this.publicRun(this.read(run.id))
  }
  private releaseCollection(token: string) {
    try { if (JSON.parse(fs.readFileSync(this.collectionLockFile, 'utf8')).token === token) fs.rmSync(this.collectionLockFile) } catch { /* Do not remove another worker's lock. */ }
  }
  private runProcessingQueue() {
    if (this.stopping || live.has(this.stateRoot)) return []
    const run = this.all().reverse().find(run => run.processing?.status === 'queued'
      && run.collection && !isActive(run.collection.status) && run.collection.status !== 'interrupted' && run.items.length)
    if (!run) return []
    try { this.launch(run); return [run.id] }
    catch (error) {
      if (!(error instanceof ScienceWorkflowError)) throw error
      return []
    }
  }
  private synchronize(run: StoredRun) {
    for (const job of this.workflow.jobsForCollection(run.id)) {
      let item = run.items.find(item => item.jobId === job.id)
      if (!item) {
        const source = parseHistoryYoutubeUrl(job.sourceUrl)
        if (source.kind !== 'video' || !source.videoId) continue
        item = { jobId: job.id, sourceUrl: source.url, videoId: source.videoId, title: job.title, status: 'queued', message: '已恢复原批次创建的任务' }
        run.items.push(item)
      }
      const matches = job.huashengAccountName === run.huashengAccountName && job.baijiahaoAccountName === run.baijiahaoAccountName
      const status: string = job.status
      item.title = job.title
      if (job.deletedAt) {
        item.completedBeforeDeletion ||= item.status === 'completed' || matches && achieved({ ...job, deletedAt: undefined }, run)
        item.status = 'deleted'; item.message = '任务已删除，后续制作已跳过'
      }
      else if (matches && achieved(job, run)) { item.status = 'completed'; item.message = job.message }
      else if (awaitingWorkflow(job) || status === 'running') { item.status = 'running'; item.message = job.message }
      else if (matches && status === 'queued' && job.stage === 'produce' && job.transcript.trim() && job.script.trim()) {
        item.status = 'queued'; item.message = job.message
      }
      else if (['paused', 'waiting_remote', 'awaiting_export'].includes(status) || status === 'needs_attention' && job.failureKind === 'temporary') { item.status = 'paused'; item.message = job.message }
      else if (status === 'needs_attention') { item.status = 'failed'; item.message = job.message }
      else if (item.status === 'completed') { item.status = 'queued'; item.message = '当前任务尚未达到本批次产出目标' }
    }
    this.updateCounts(run)
    return run
  }
  private restoreItems(id: string) {
    return this.update(id, run => { this.synchronize(run) })
  }
  private async processItem(id: string, jobId: string, signal: AbortSignal) {
    this.verifyOwner(id, signal)
    const run = this.update(id, current => {
      const item = current.items.find(value => value.jobId === jobId)!
      item.status = 'running'; item.message = '正在自动处理'; current.currentJobId = jobId
    })
    const item = run.items.find(value => value.jobId === jobId)!
    this.processingReport(id, `正在处理：${item.title}`)
    const skipDeleted = () => this.update(id, current => {
      const saved = current.items.find(value => value.jobId === jobId)!
      saved.status = 'deleted'; saved.message = '任务已删除，后续制作已跳过'; current.currentJobId = null
    })
    let startedHere = false
    try {
      let job = this.workflow.jobsForCollection(id).find(value => value.id === jobId)
      let observedExecution = false
      let result: ScienceJob
      for (;;) {
        while (job && awaitingWorkflow(job)) {
          if (!observedExecution) this.report(id, job.status === 'retry_wait'
            ? `正在等待原任务自动重试：${item.title}` : `正在等待原任务执行完成：${item.title}`)
          observedExecution = true
          await delay(250, undefined, { signal })
          this.verifyOwner(id, signal)
          job = this.workflow.jobsForCollection(id).find(value => value.id === jobId)
        }
        if (!job) throw new ScienceWorkflowError('原批次任务不存在或归属已变化')
        if (job.deletedAt) { skipDeleted(); return }
        if (observedExecution && ['needs_attention', 'paused'].includes(job.status))
          throw new ScienceBatchBlockedError(job.message, 409, job.failureKind === 'temporary')
        if (job.huashengAccountName !== run.huashengAccountName || job.baijiahaoAccountName !== run.baijiahaoAccountName)
          throw new ScienceWorkflowError('任务账号与本批次原账号不一致，请在单条任务中核对，不自动切换账号')
        if (achieved(job, run)) { result = job; break }
        try { startedHere = true; result = await this.workflow.runBatchJob(jobId, run.mode, signal); break }
        catch (error) {
          signal.throwIfAborted()
          job = this.workflow.jobsForCollection(id).find(value => value.id === jobId)
          if (!(job?.status === 'retry_wait' && (job.automaticRetry || job.uploadRetry))) throw error
        }
      }
      this.verifyOwner(id, signal)
      if (result.id !== jobId || result.huashengAccountName !== run.huashengAccountName || result.baijiahaoAccountName !== run.baijiahaoAccountName || !achieved(result, run))
        throw new ScienceWorkflowError('任务尚未达到本批次的产出目标或账号已变化，保留原任务')
      this.update(id, current => { const saved = current.items.find(value => value.jobId === jobId)!; saved.status = 'completed'; saved.title = result.title; saved.message = result.message; current.currentJobId = null })
      const current = this.read(id)
      this.processingReport(id, current.retry ? `重试进度：已恢复 ${current.retry.completed}/${current.retry.jobIds.length} 条任务`
        : `已完成 ${current.counts.completed}${run.targetCount === null ? '' : `/${run.targetCount}`} 条${run.mode === 'drafts' ? '二创稿' : run.mode === 'videos' ? '成片' : '百家号作品'}`)
    } catch (error) {
      signal.throwIfAborted()
      if (this.workflow.jobsForCollection(id).some(job => job.id === jobId && job.deletedAt)) { skipDeleted(); return }
      this.update(id, current => {
        const saved = current.items.find(value => value.jobId === jobId)!
        saved.status = error && typeof error === 'object' && (error as { retryable?: boolean }).retryable === true ? 'paused' : 'failed'
        saved.message = safeMessage(error); current.currentJobId = null
      })
      if (error instanceof ScienceBatchBlockedError || batchBlocker(error))
        throw new ScienceBatchBlockedError(`制作队列需要处理：${safeMessage(error)}；已暂停后续制作，采集与已入库来源不受影响`)
      this.processingReport(id, `本条需要处理：${safeMessage(error)}；继续后续已入库任务`)
    } finally {
      // User stops revoke this batch's retry chain; service shutdown remains recoverable.
      if (signal.aborted && startedHere && this.read(id).stopRequested === true) {
        const job = this.workflow.jobsForCollection(id).find(value => value.id === jobId)
        if (job && awaitingWorkflow(job)) this.workflow.cancel(jobId)
      }
      if (!signal.aborted) this.update(id, current => {
        if (current.pendingRetryJobIds) current.pendingRetryJobIds = current.pendingRetryJobIds.filter(value => value !== jobId)
      })
    }
  }
  private async execute(id: string, signal: AbortSignal, automaticRecovery = false) {
    this.verifyOwner(id, signal)
    let run = this.restoreItems(id)
    this.workflow.validateBatchAccounts(run.mode, run.huashengAccountName, run.baijiahaoAccountName)
    if (run.retry) {
      // Retry is a persisted scope of existing tasks, independent of the collection target.
      const jobIds = run.pendingRetryJobIds ?? (automaticRecovery ? run.retry.jobIds.filter(jobId =>
        ['queued', 'paused', 'running'].includes(run.items.find(item => item.jobId === jobId)?.status || '')) : run.retry.jobIds)
      for (const jobId of jobIds) {
        this.verifyOwner(id, signal)
        if (!['completed', 'deleted'].includes(this.read(id).items.find(item => item.jobId === jobId)?.status || '')) await this.processItem(id, jobId, signal)
      }
      this.verifyOwner(id, signal)
      run = this.restoreItems(id)
      const selected = run.items.filter(item => run.retry!.jobIds.includes(item.jobId))
      const remaining = selected.filter(item => !['completed', 'deleted'].includes(item.status)).length
      const deleted = selected.filter(item => item.status === 'deleted').length
      this.update(id, current => {
        current.status = remaining ? 'needs_attention' : 'completed'
        current.processing = { status: current.status, message: remaining ? '原任务仍需处理' : '所选任务已全部完成' }
        current.retry!.finishedAt = new Date().toISOString(); current.currentChannel = null; current.currentJobId = null
      })
      this.processingReport(id, `重试进度：已恢复 ${run.retry!.completed}/${run.retry!.jobIds.length} 条任务${remaining ? `；${remaining} 条仍待处理，可继续同一范围` : deleted ? '，所选任务已全部处理' : '，所选任务已全部完成'}${deleted ? `；${deleted} 条已删除并跳过` : ''}`)
      return
    }
    // A resume belongs to its original snapshot, even after channel/default-account settings change.
    const visited = new Set<string>()
    for (;;) {
      run = this.restoreItems(id)
      const item = run.items.find(item => !visited.has(item.jobId) && !['completed', 'deleted'].includes(item.status))
      if (!item) break
      visited.add(item.jobId)
      const job = automaticRecovery ? this.workflow.jobsForCollection(id).find(job => job.id === item.jobId) : undefined
      if (automaticRecovery && (!job || !awaitingWorkflow(job)) && (item.status === 'failed' || job?.status === 'needs_attention')) continue
      await this.processItem(id, item.jobId, signal)
    }
    this.verifyOwner(id, signal)
    run = this.restoreItems(id)
    const message = `制作队列已处理：完成 ${run.counts.completed}/${run.counts.selected} 条，${run.counts.failed} 条需要处理`
    this.update(id, current => {
      current.processing = { status: current.counts.failed ? 'needs_attention' : 'completed', message }
      current.status = current.collection && current.collection.status !== 'completed' ? current.collection.status
        : current.channelErrors.length || current.counts.failed ? 'needs_attention' : 'completed'
      current.currentJobId = null
    })
    this.processingReport(id, message)
  }
  private async executeCollection(id: string, signal: AbortSignal) {
    this.verifyCollectionOwner(id, signal)
    let run = this.restoreItems(id)
    const collect = this.options.collect || (await import('./history-source-youtube.js')).collectHistoryYoutubeVideos
    for (const url of run.youtubeChannels) {
      this.verifyCollectionOwner(id, signal)
      run = this.read(id)
      if (reached(run)) break
      const known = this.workflow.knownYoutubeIds()
      for (const item of run.items) known.add(item.videoId)
      this.update(id, current => { current.currentChannel = url; current.channelErrors = current.channelErrors.filter(error => error.url !== url) })
      this.collectionReport(id, `正在读取频道：${decodeURIComponent(new URL(url).pathname.replace(/\/videos$/, ''))}`)
      const scannedBefore = run.counts.scanned
      let exhausted = false
      try {
        await collect({ url, signal, targetCount: run.targetCount,
          isKnownVideo: videoId => known.has(videoId),
          isTargetReached: () => reached(this.read(id)),
          onCandidate: candidate => this.consume(id, url, candidate, signal, known),
          report: event => {
            this.verifyCollectionOwner(id, signal)
            if (event.stage === 'exhausted') exhausted = true
            this.update(id, current => {
              if (event.scanned !== undefined) current.counts.scanned = Math.max(current.counts.scanned, scannedBefore + event.scanned)
              if (event.candidate?.outcome === 'skipped') current.counts.skipped++
            })
            this.collectionReport(id, safeMessage(event.message))
          },
        })
        this.verifyCollectionOwner(id, signal)
        if (!reached(this.read(id)) && !exhausted) throw new ScienceWorkflowError('频道读取提前结束，尚未确认视频列表末尾')
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof ScienceBatchBlockedError) throw error
        if (batchBlocker(error)) {
          this.update(id, current => { current.channelErrors.push({ url, message: safeMessage(error) }) })
          throw new ScienceBatchBlockedError(`采集需要处理：${safeMessage(error)}；已停止后续频道，已入库任务保留`)
        }
        this.update(id, current => { current.channelErrors.push({ url, message: safeMessage(error) }) })
        this.collectionReport(id, `此频道采集失败：${safeMessage(error)}；继续后续频道`)
      }
    }
    this.verifyCollectionOwner(id, signal)
    run = this.read(id)
    const message = `${reached(run) ? '已达到采集目标' : '本轮频道已遍历'}：已入库 ${run.counts.selected}${run.targetCount === null ? '' : `/${run.targetCount}`} 条新视频`
      + (run.channelErrors.length ? `；${run.channelErrors.length} 个频道需要处理` : '')
    this.update(id, current => {
      current.collection = { status: current.channelErrors.length ? 'needs_attention' : 'completed', message }
      current.currentChannel = null
      if (!current.items.length) {
        current.processing = { status: 'completed', message: '没有新入库任务' }
        current.status = current.collection.status
      } else current.status = current.processing?.status === 'queued' ? 'running' : current.processing?.status === 'stopped' ? 'stopped' : current.status
    })
    this.collectionReport(id, message)
  }
  private async consume(id: string, channel: string, candidate: HistoryYoutubeCandidate, signal: AbortSignal, known: Set<string>) {
    this.verifyCollectionOwner(id, signal)
    const run = this.read(id)
    if (reached(run)) return
    if (known.has(candidate.videoId)) {
      this.update(id, current => { current.counts.skipped++ }); return
    }
    const parsed = parseHistoryYoutubeUrl(candidate.sourceUrl)
    if (parsed.kind !== 'video' || parsed.videoId !== candidate.videoId) throw new ScienceWorkflowError('频道返回的视频身份不一致')
    const job = this.workflow.create({ sourceUrl: parsed.url, title: candidate.title.slice(0, 60), huashengAccountName: run.huashengAccountName,
      baijiahaoAccountName: run.baijiahaoAccountName }, { defer: true, collectionId: id, sourceChannel: channel, collectionOnly: true })
    known.add(candidate.videoId)
    if (job.collectionId !== id) { this.update(id, current => { current.counts.skipped++ }); return }
    this.update(id, current => {
      if (!current.items.some(item => item.jobId === job.id)) {
        current.items.push({ jobId: job.id, sourceUrl: job.sourceUrl, videoId: candidate.videoId, title: job.title, status: 'queued', message: '已加入本批次' })
        if (current.processing?.status === 'completed') current.processing = { status: 'queued', message: '新增来源已入库，等待继续制作' }
      }
    })
  }
  stopRun(id: string) {
    let run = this.read(id)
    if (run.collection && isActive(run.collection.status)) this.stopCollection(id)
    if (run.processing) {
      this.stopProcessing(id)
      return this.publicRun(this.read(id))
    }
    if (!isActive(run.status)) return this.publicRun(run)
    this.update(id, current => { current.status = 'stopping'; current.stopRequested = true })
    this.report(id, '正在停止采集与当前任务，等待本机执行结束后保留检查点')
    const handle = live.get(this.stateRoot)
    if (handle?.id === id) handle.controller.abort()
    return this.publicRun(this.read(id))
  }
  resume(id: string) {
    const run = this.synchronize(this.read(id))
    if (isActive(run.status) || run.status === 'completed') return this.publicRun(run)
    if (!run.retry && run.collection?.status !== 'completed' && !reached(run)) {
      run.processing = { status: 'queued', message: '已恢复制作队列，等待采集入库' }
      this.write(run)
      return this.resumeCollection(id)
    }
    if (run.retry) {
      run.retry.finishedAt = null; run.pendingRetryJobIds = run.retry.jobIds.filter(jobId =>
        !['completed', 'deleted'].includes(run.items.find(item => item.jobId === jobId)?.status || ''))
    }
    this.write(run)
    return this.resumeProcessing(id)
  }
  stopCollection(id: string) {
    const run = this.read(id)
    if (!run.collection || !isActive(run.collection.status)) return this.publicRun(run)
    this.update(id, current => {
      current.collectionStopRequested = true
      current.collection = { status: 'stopping', message: '正在停止采集，已入库任务保留' }
      current.status = 'stopping'
    })
    const handle = collecting.get(this.stateRoot)
    if (handle?.id === id) handle.controller.abort()
    return this.publicRun(this.read(id))
  }
  resumeCollection(id: string) {
    const run = this.synchronize(this.read(id))
    if (run.collection?.status === 'completed' || run.collection && isActive(run.collection.status)) return this.publicRun(run)
    if (run.retry) throw new ScienceWorkflowError('本次仅重试原任务，不能额外采集')
    run.processing ??= { status: 'queued', message: '等待制作已入库任务' }
    return this.launchCollection(run)
  }
  stopProcessing(id: string) {
    const run = this.read(id)
    if (run.processing?.status === 'completed') return this.publicRun(run)
    const handle = live.get(this.stateRoot)
    this.update(id, current => {
      current.stopRequested = true
      current.processing = { status: handle?.id === id ? 'stopping' : 'stopped', message: '制作已暂停，采集与已入库来源保留' }
      if (!current.collection || !isActive(current.collection.status)) current.status = handle?.id === id ? 'stopping' : 'stopped'
    })
    if (handle?.id === id) handle.controller.abort()
    return this.publicRun(this.read(id))
  }
  resumeProcessing(id: string) {
    const run = this.synchronize(this.read(id))
    if (run.processing && isActive(run.processing.status)) return this.publicRun(run)
    if (run.retry) {
      run.retry.finishedAt = null
      run.pendingRetryJobIds = run.retry.jobIds.filter(jobId => !['completed', 'deleted'].includes(run.items.find(item => item.jobId === jobId)?.status || ''))
    }
    if (!run.items.some(item => !['completed', 'deleted'].includes(item.status))) return this.publicRun(run)
    run.collection ??= { status: 'completed', message: '使用已有入库任务，不重新采集' }
    run.processing = { status: 'queued', message: '已恢复制作队列' }; run.stopRequested = false
    this.write(run); this.runProcessingQueue()
    return this.publicRun(this.read(id))
  }
  retry(id: string, input: unknown) {
    const request = scienceCollectionRetrySchema.parse(input)
    const run = this.synchronize(this.read(id))
    if (request.jobIds?.some(jobId => !run.items.some(item => item.jobId === jobId)))
      throw new ScienceWorkflowError('重试范围只能包含原批次已有的任务', 400)
    const requested = request.jobIds ? run.items.filter(item => request.jobIds!.includes(item.jobId)).map(item => item.jobId) : null
    if (isActive(run.status)) {
      if (run.retry && (!requested || JSON.stringify(requested) === JSON.stringify(run.retry.jobIds))) return this.publicRun(run)
      throw new ScienceWorkflowError('批次正在执行，不能更改重试范围，请等待或停止后再重试')
    }
    const jobIds = run.items.filter(item => !['completed', 'deleted'].includes(item.status) && (!requested || requested.includes(item.jobId))).map(item => item.jobId)
    if (!jobIds.length) return this.publicRun(run)
    run.retry = { jobIds, startedAt: new Date().toISOString(), finishedAt: null, completed: 0, failed: 0 }
    run.pendingRetryJobIds = [...jobIds]
    run.currentChannel = null; run.currentJobId = null
    run.message = `正在重试 ${jobIds.length} 条原批次任务，不采集新视频`
    run.collection ??= { status: 'completed', message: '原来源已入库，本次不重新采集' }
    run.processing = { status: 'queued', message: run.message }; run.stopRequested = false; this.write(run)
    this.runProcessingQueue()
    return this.publicRun(this.read(id))
  }
  runAutomaticRecovery() {
    if (this.stopping) return []
    const started: string[] = []
    for (const run of this.all()) {
      if (run.collection || run.processing || run.status !== 'interrupted' || run.stopRequested || alive(run.ownerPid)) continue
      run.collection = { status: run.retry || reached(run) ? 'completed' : 'interrupted', message: '已恢复原批次采集范围' }
      run.processing = { status: run.collection.status === 'interrupted' ? 'queued' : 'interrupted', message: '已恢复原批次制作队列' }
      this.write(run)
    }
    if (!collecting.has(this.stateRoot)) {
      const collector = this.all().find(run => run.collection?.status === 'interrupted' && !run.collectionStopRequested)
      if (collector) {
        try { this.launchCollection(collector); started.push(collector.id) }
        catch (error) { if (!(error instanceof ScienceWorkflowError)) throw error }
      }
    }
    if (live.has(this.stateRoot)) return started
    const queued = this.runProcessingQueue()
    if (queued.length) return [...started, ...queued]
    const runs = this.all()
    if (runs.some(run => isActive(run.status) && (!run.processing || isActive(run.processing.status)))) return started
    const run = runs.find(run => (run.processing?.status === 'interrupted' || !run.processing && run.status === 'interrupted')
      && run.stopRequested !== true && !alive(run.ownerPid) && (!run.collection || !isActive(run.collection.status)))
    if (!run) return started
    try {
      this.workflow.validateBatchAccounts(run.mode, run.huashengAccountName, run.baijiahaoAccountName)
    } catch (error) {
      this.update(run.id, current => { current.status = 'needs_attention' })
      this.update(run.id, current => { current.processing = { status: 'needs_attention', message: safeMessage(error) } })
      this.report(run.id, `原批次自动恢复需要处理：${safeMessage(error)}`)
      return started
    }
    try {
      this.launch(run, true)
      return [...started, run.id]
    } catch (error) {
      if (!(error instanceof ScienceWorkflowError)) throw error
      return started
    }
  }
  startAutomaticRecovery() {
    if (this.automaticTimer) return
    const tick = () => { try { this.runAutomaticRecovery() } catch (error) { console.error('[science-collection]', safeMessage(error)) } }
    this.automaticTimer = setInterval(tick, 15_000)
    this.automaticTimer.unref()
    tick()
  }
  async waitForIdle() {
    while (collecting.has(this.stateRoot) || live.has(this.stateRoot)) {
      await Promise.all([collecting.get(this.stateRoot)?.done, live.get(this.stateRoot)?.done])
    }
  }
  async stop() {
    this.stopping = true
    if (this.automaticTimer) clearInterval(this.automaticTimer)
    this.automaticTimer = undefined
    live.get(this.stateRoot)?.controller.abort()
    collecting.get(this.stateRoot)?.controller.abort()
    await this.waitForIdle()
  }
}

let instance: ScienceCollectionService | undefined
export function getScienceCollectionService() { return instance ??= new ScienceCollectionService() }
