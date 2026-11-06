import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { NBA_DEFAULT_SETTINGS, type NbaArticle, type NbaChannelVideo, type NbaDelivery, type NbaIntakeInput, type NbaIntakeResult, type NbaJob, type NbaProductionInput, type NbaRun, type NbaSettings, type NbaUpload } from './nba-types.js'
import { parseHistoryYoutubeUrl } from './history-source-youtube-url.js'
import { getSocialUploadAccountsService } from './social-upload-accounts.js'
import { validateCbaUploadReceipt } from './cba-upload-recovery.js'
import { nbaPublishingDescription } from './nba-publishing-copy.js'
import { nbaSourceVideoId, sameNbaFootage } from './nba-content-identity.js'
import { acquireNbaJobLock, nbaJobLockAlive, NbaJobLockBusyError } from './nba-job-lock.js'
import type { NbaChannelCollectionResult } from './nba-channel-collection.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const requestId = z.string().min(8).max(160).regex(/^[a-zA-Z0-9_-]+$/)
const languages = z.array(z.enum(['en', 'zh'])).min(1).max(2).refine(value => new Set(value).size === value.length)
const publicUrl = z.url().max(2048).refine(value => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
}, '请使用不含凭据的 HTTP 新闻链接')
const youtubeUrl = publicUrl.refine(value => /^(www\.|m\.)?(youtube\.com|youtu\.be)$/.test(new URL(value).hostname), '请使用 YouTube 视频链接')
const channelUrl = z.string().trim().max(2048).transform((value, context) => {
  try { const parsed = parseHistoryYoutubeUrl(value); if (parsed.kind !== 'channel') throw new Error(); return parsed.url }
  catch { context.addIssue({ code: 'custom', message: '请填写 YouTube 频道主页或 videos 链接' }); return z.NEVER }
})
export const nbaChannelsSchema = z.object({ youtubeChannels: z.array(channelUrl).max(30).refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length, '频道不能重复') }).strict()
export const nbaStartSchema = z.object({
  requestId, languages: languages.default(['en', 'zh']), limit: z.number().int().min(1).max(100).default(6),
  collectionMode: z.enum(['channels', 'manual']).default('channels'), videosPerChannel: z.number().int().min(1).max(1000).optional(),
  articleUrls: z.array(publicUrl).max(100).default([]),
  youtubeUrl: youtubeUrl.optional(),
  gameDate: z.iso.date().optional(), espnEventId: z.string().regex(/^\d{6,14}$/).optional(),
  autoProduce: z.boolean().default(true),
  autoUpload: z.boolean().optional(),
}).strict()
export const nbaResumeSchema = z.object({ requestId, jobIds: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/)).min(1).max(100), autoUpload: z.boolean().optional() }).strict()
export const nbaSettingsSchema = z.object({
  youtubeChannels: nbaChannelsSchema.shape.youtubeChannels.default(NBA_DEFAULT_SETTINGS.youtubeChannels),
  videosPerChannel: z.number().int().min(1).max(1000).default(NBA_DEFAULT_SETTINGS.videosPerChannel),
  languages, limit: z.number().int().min(1).max(100), autoProduce: z.boolean(),
  scheduleEnabled: z.boolean(), intervalMinutes: z.number().int().min(5).max(1440),
  voice: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.:-]+$/), speed: z.number().min(0.5).max(2),
  originalGain: z.number().min(0).max(1), arenaGain: z.number().min(0).max(2),
  autoUpload: z.boolean().default(false), baijiahaoAccountName: z.string().regex(/^cba_[a-f0-9]{32}$/).optional(),
}).strict()
export const nbaUploadSchema = nbaResumeSchema.omit({ autoUpload: true })
export const nbaDeleteSchema = z.object({ expectedTitle: z.string().min(1).max(500) }).strict()
export const nbaSourceSchema = z.object({ youtubeUrl }).strict()

export class NbaVideoError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

interface ConsoleState {
  version: 1
  settings: NbaSettings
  runs: NbaRun[]
  requests: Record<string, { hash: string; runId: string }>
  nextCollectionAt?: string
}
interface ServiceOptions {
  root?: string
  collect?: (input: NbaIntakeInput) => Promise<NbaIntakeResult>
  produce?: (input: NbaProductionInput) => Promise<Partial<NbaJob>>
  collectChannels?: (input: NbaIntakeInput & { youtubeChannels: string[]; videosPerChannel: number; existingVideos: NbaChannelVideo[]; snapshotDir: string; signal: AbortSignal;
    scanStatePath?: string; includeHistory?: boolean; reservedVideoIds?: string[] }) => Promise<NbaChannelCollectionResult>
  uploadAccount?: () => { accountName: string; label: string; status: string; message: string } | null
  upload?: (input: { job: NbaJob; jobDir: string; accountName: string; accountLabel: string; signal: AbortSignal;
    persist: (upload: NbaUpload) => void; persistDelivery: (delivery: NbaDelivery) => void; onProgress: (message: string) => void }) => Promise<{ saved: boolean; message: string }>
  now?: () => Date
  scheduling?: boolean
  waitForMediaRetry?: (ms: number, signal: AbortSignal) => Promise<void>
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fileHash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const active = (run: NbaRun) => ['queued', 'running', 'stopping'].includes(run.status)
const mediaRetryDelays = [5_000, 15_000]
const recoveryDelays = [60_000, 300_000, 900_000]
const transientFailure = (message: string) => /timeout|timed out|fetch failed|ECONN|ENET|socket|\b(?:429|502|503|504)\b|超时|网络.*中断|网络.*不可达|暂时不可用/i.test(message)
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file) }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}
function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
  catch (error: any) { if (error.code === 'ENOENT') return undefined; throw new NbaVideoError(`NBA 状态文件无法读取：${path.basename(file)}`, 500) }
}
function safeMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error)
    .replace(/(?:Bearer\s+|sk-)[\w.-]+/gi, '[已隐藏凭据]')
    .replace(/https?:\/\/[^\s)]+/g, value => { try { const u = new URL(value); return `${u.origin}${u.pathname}` } catch { return '[链接]' } })
    .replace(/\/Users\/[^\s:]+/g, '[本地文件]').slice(0, 900)
}

export class NbaVideoService {
  readonly root: string
  private state: ConsoleState
  private jobs = new Map<string, NbaJob>()
  private controller?: AbortController
  private execution?: Promise<void>
  private collectionController?: AbortController
  private collectionExecution?: Promise<void>
  private collectionRun?: NbaRun
  private processingRun?: NbaRun
  private closing = false
  private timer?: ReturnType<typeof setInterval>
  private deliveryChecks = new Map<string, { stat: string; valid: boolean }>()
  private readonly now: () => Date
  private readonly collect: NonNullable<ServiceOptions['collect']>
  private readonly produce: NonNullable<ServiceOptions['produce']>
  private readonly collectChannels: NonNullable<ServiceOptions['collectChannels']>
  private readonly upload: NonNullable<ServiceOptions['upload']>
  private readonly uploadAccount: NonNullable<ServiceOptions['uploadAccount']>
  private readonly scheduling: boolean
  private readonly waitForMediaRetry: NonNullable<ServiceOptions['waitForMediaRetry']>

  constructor(options: ServiceOptions = {}) {
    this.root = path.resolve(options.root || path.join(projectRoot, 'data/nba-video'))
    this.now = options.now || (() => new Date())
    this.scheduling = options.scheduling ?? process.env.TASK_WORKER_DISABLED !== '1'
    this.waitForMediaRetry = options.waitForMediaRetry || ((ms, signal) => delay(ms, undefined, { signal }))
    this.collect = options.collect || (async input => (await import('./nba-news.js')).collectNbaNews(input))
    this.produce = options.produce || (async input => (await import('./nba-production.js')).produceNbaVideo(input))
    this.collectChannels = options.collectChannels || (async input => (await import('./nba-channel-collection.js')).collectNbaChannelNews(input))
    this.uploadAccount = options.uploadAccount || (() => {
      const cba = readJson<{ settings?: { baijiahaoAccountName?: string } }>(path.join(projectRoot, 'data/cba-video/.console.json'))
      const accounts = getSocialUploadAccountsService()
      const name = cba?.settings?.baijiahaoAccountName || accounts.list().defaultAccountName
      return name ? accounts.get(name) : null
    })
    this.upload = options.upload || (async input => {
      const { ensureNbaDeliveryCover } = await import('./nba-production.js')
      input.onProgress('正在准备新闻标题与对应素材的横竖封面')
      input.job.delivery = await ensureNbaDeliveryCover({ ...input, recentCoverPhotoSha256s: this.recentCoverPhotos(input.job.id) })
      input.persistDelivery(input.job.delivery)
      const { prepareNbaUpload, uploadNbaVideo } = await import('./nba-upload.js')
      const upload = await prepareNbaUpload(input)
      input.persist(upload)
      return uploadNbaVideo({ upload, inputDigest: input.job.delivery!.sha256, signal: input.signal,
        persist: patch => { Object.assign(upload, patch); input.persist(upload) }, onProgress: input.onProgress })
    })
    fs.mkdirSync(path.join(this.root, 'jobs'), { recursive: true })
    fs.mkdirSync(path.join(this.root, 'shared'), { recursive: true })
    this.state = readJson<ConsoleState>(path.join(this.root, '.console.json')) || {
      version: 1, settings: structuredClone(NBA_DEFAULT_SETTINGS), runs: [], requests: {},
    }
    this.state.settings = nbaSettingsSchema.parse({ ...NBA_DEFAULT_SETTINGS, ...this.state.settings })
    for (const entry of fs.readdirSync(path.join(this.root, 'jobs'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(entry.name)) continue
      const job = readJson<NbaJob>(path.join(this.root, 'jobs', entry.name, 'job.json'))
      if (job && job.id === entry.name) this.jobs.set(job.id, job)
    }
    this.recover()
    if (this.scheduling) {
      this.timer = setInterval(() => void this.tick().catch(error => console.error('[nba-schedule]', safeMessage(error))), 30_000)
      this.timer.unref()
      this.drainProcessingQueue()
    }
  }

  private stamp() { return this.now().toISOString() }
  private currentSettings() {
    const channels = readJson<{ youtubeChannels: string[] }>(path.join(this.root, '.channels.json'))
    return nbaSettingsSchema.parse({ ...NBA_DEFAULT_SETTINGS, ...this.state.settings, ...(channels || {}) })
  }
  private consoleMutation<T>(change: (state: ConsoleState) => T): T {
    const lease = `state-${randomUUID()}`, file = path.join(this.root, '.console.lock')
    for (let attempt = 0; ; attempt++) {
      try { this.acquireRunLock(lease, file); break }
      catch (error) {
        if (!(error instanceof NbaVideoError) || error.status !== 409 || attempt >= 100) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    try {
      const state = readJson<ConsoleState>(path.join(this.root, '.console.json')) || structuredClone(this.state)
      const result = change(state)
      writeJson(path.join(this.root, '.console.json'), state)
      this.acceptState(state)
      return result
    } finally { this.releaseRunLock(lease, file) }
  }
  private acceptState(state: ConsoleState) {
    const owned = [this.collectionRun, this.processingRun].filter((run): run is NbaRun => !!run)
    state.runs = state.runs.map(run => owned.find(local => local.id === run.id) || run)
    this.state = state
  }
  private save(run?: NbaRun, added?: NbaRun) {
    this.consoleMutation(state => {
      if (!run) {
        state.settings = this.state.settings
        state.nextCollectionAt = this.state.nextCollectionAt
        return
      }
      for (const current of [run, added].filter((value): value is NbaRun => !!value)) {
        const index = state.runs.findIndex(saved => saved.id === current.id)
        if (index < 0) state.runs.unshift(structuredClone(current))
        else state.runs[index] = structuredClone(current)
      }
      if (run.kind === 'collect' && !active(run)) state.nextCollectionAt = new Date(this.now().getTime() + state.settings.intervalMinutes * 60_000).toISOString()
    })
  }
  private saveJob(job: NbaJob) { writeJson(path.join(this.root, 'jobs', job.id, 'job.json'), job); this.jobs.set(job.id, job) }
  private sync() {
    this.reload()
    this.recover()
  }
  private reload() {
    const state = readJson<ConsoleState>(path.join(this.root, '.console.json'))
    if (state) this.acceptState(state)
    this.state.settings = this.currentSettings()
    const jobs = new Map<string, NbaJob>()
    for (const entry of fs.readdirSync(path.join(this.root, 'jobs'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(entry.name)) continue
      const job = readJson<NbaJob>(path.join(this.root, 'jobs', entry.name, 'job.json'))
      if (job && job.id === entry.name) jobs.set(job.id, job)
    }
    this.jobs = jobs
  }
  private lockFile() { return path.join(this.root, '.production.lock') }
  private collectionLockFile() { return path.join(this.root, '.collection.lock') }
  private runLockFile(run: NbaRun) { return run.kind === 'collect' && run.queueVersion === 2 ? this.collectionLockFile() : this.lockFile() }
  private lockAlive(file = this.lockFile()) {
    const lock = readJson<{ pid: number; runId: string }>(file)
    if (!lock) return false
    try { process.kill(lock.pid, 0); return true } catch (error: any) { return error.code !== 'ESRCH' }
  }
  private recover() {
    const orphaned = (run: NbaRun) => active(run) && !(run.queueVersion === 2 && run.kind !== 'collect' && run.status === 'queued')
      && !this.lockAlive(this.runLockFile(run))
    const restartable = (run: NbaRun) => this.state.settings.scheduleEnabled && run.kind !== 'collect'
      && !this.lockAlive(this.runLockFile(run)) && (run.resumeOnRestart || orphaned(run) && run.status === 'running')
    if (!this.state.runs.some(run => orphaned(run) || restartable(run)) && (this.lockAlive() || ![...this.jobs.values()].some(job => job.status === 'running' || job.uploads?.some(upload => upload.status === 'running')))) return
    this.consoleMutation(state => {
      for (const run of state.runs.filter(run => orphaned(run) || restartable(run))) {
        const resume = restartable(run) && !this.lockAlive(this.runLockFile(run))
        run.status = resume ? 'queued' : 'stopped'
        delete run.resumeOnRestart
        run.message = resume ? '全天流程自动恢复中断队列，沿用原检查点和发表账号' : '服务重启，已保留检查点，可继续未完成任务'; run.updatedAt = this.stamp()
      }
      if (this.lockAlive()) return
      for (const saved of this.jobs.values()) {
        if (nbaJobLockAlive(this.jobLockFile(saved.id))) continue
        const job = readJson<NbaJob>(path.join(this.root, 'jobs', saved.id, 'job.json'))
        if (!job) continue
        let jobChanged = false
        if (job.status === 'running') {
          job.status = 'stopped'; job.canResume = true; job.message = '制作中断，可从已完成阶段继续'; jobChanged = true
        }
        for (const upload of job.uploads || []) if (upload.status === 'running') {
          upload.status = upload.dispatched ? 'uncertain' : 'queued'
          upload.message = '上传中断，继续上传时将先核对原检查点'; upload.updatedAt = this.stamp(); jobChanged = true
        }
        if (jobChanged) { job.updatedAt = this.stamp(); this.saveJob(job) }
      }
    })
  }
  private assertIdle() {
    this.sync()
    if (this.execution || this.collectionExecution || this.state.runs.some(active) || this.lockAlive() || this.lockAlive(this.collectionLockFile())) throw new NbaVideoError('已有 NBA 任务运行，请等待完成或先停止', 409)
  }
  private acquireRunLock(runId: string, file = this.lockFile()) {
    const ownerFile = path.join(this.root, `.production-${randomUUID()}.owner`)
    try {
      if (fs.existsSync(file) && !this.lockAlive(file)) fs.unlinkSync(file)
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, runId }), { mode: 0o600, flag: 'wx' })
      // Linking a complete record avoids an empty-lock window visible to recovery.
      fs.linkSync(ownerFile, file)
    } catch (error: any) {
      if (error.code === 'EEXIST') throw new NbaVideoError('已有 NBA 任务运行，请等待完成或先停止', 409)
      throw error
    } finally { if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile) }
  }
  private releaseRunLock(runId: string, file = this.lockFile()) {
    const owner = readJson<{ pid: number; runId: string }>(file)
    if (owner?.pid === process.pid && owner.runId === runId) fs.unlinkSync(file)
  }
  private jobLockFile(id: string) { return path.join(this.root, `.job-${id}.lock`) }
  private acquireJobLock(id: string) {
    try { return acquireNbaJobLock(this.jobLockFile(id)) }
    catch (error) {
      if (error instanceof NbaJobLockBusyError) throw new NbaVideoError('该任务正在制作或上传，请先停止当前批次再删除', 409)
      throw error
    }
  }
  private async acquireExecutionJobLock(id: string, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted()
      try { return this.acquireJobLock(id) }
      catch (error) {
        if (!(error instanceof NbaVideoError) || error.status !== 409) throw error
        // A concurrent deletion must finish before the executor reads the job.
        await delay(25, undefined, { signal })
      }
    }
  }
  private forgetDeletedJob(id: string) {
    const job = this.jobs.get(id)
    this.jobs.delete(id)
    if (!this.execution && !this.collectionExecution) return
    for (const run of this.state.runs.filter(active)) if (run.jobIds.includes(id)) {
      run.jobIds = run.jobIds.filter(value => value !== id)
      if (job) run.excluded.push({ url: job.article.url, title: job.title, reason: '用户已从队列删除，跳过制作和发表' })
      this.save(run)
    }
  }
  private executionJob(id: string) {
    const job = readJson<NbaJob>(path.join(this.root, 'jobs', id, 'job.json'))
    if (!job) { this.forgetDeletedJob(id); return undefined }
    this.jobs.set(id, job)
    return job
  }
  private deleteBlockedReason(job: NbaJob, ownsLease = false) {
    if (job.status === 'running') return '该任务正在制作，请先停止当前批次再删除'
    if ((!ownsLease && nbaJobLockAlive(this.jobLockFile(job.id))) || job.uploads?.some(upload => upload.status === 'running')) return '该任务正在制作或上传，请先停止当前批次再删除'
    if (job.uploads?.some(upload => upload.dispatched && upload.status !== 'saved')) return '该任务的发表结果尚待核对，请先核对原上传回执再删除'
    return undefined
  }
  private idleMutation<T>(action: () => T): T {
    this.assertIdle()
    const mutationId = `change-${randomUUID()}`
    this.acquireRunLock(mutationId)
    try { this.reload(); return action() }
    finally { this.releaseRunLock(mutationId) }
  }
  private register(input: { requestId: string; autoUpload?: boolean }, kind: NbaRun['kind'], jobIds: string[] = []) {
    this.sync()
    const hash = digest({ kind, ...input })
    const previous = this.state.requests[input.requestId]
    if (previous) {
      if (previous.hash !== hash) throw new NbaVideoError('同一请求编号不能提交不同内容', 409)
      const run = this.state.runs.find(item => item.id === previous.runId)
      if (!run) throw new NbaVideoError('该请求已归档，请使用新的请求编号', 409)
      return { run, existing: true }
    }
    const run: NbaRun = { id: `nba-run-${randomUUID()}`, requestId: input.requestId, kind, status: 'queued', jobIds,
      queueVersion: 2,
      createdAt: this.stamp(), updatedAt: this.stamp(), message: kind === 'collect' ? '等待采集新闻' : kind === 'upload' ? '等待上传百家号' : '等待继续制作', excluded: [], sources: [] }
    if (kind !== 'collect') {
      run.productionSettings = structuredClone(this.currentSettings())
      this.configureUpload(run, kind === 'upload' || (input.autoUpload ?? run.productionSettings.autoUpload))
    }
    if (kind === 'collect') {
      if (this.collectionExecution || this.state.runs.some(row => row.kind === 'collect' && active(row) && (row.queueVersion !== 2 || this.lockAlive(this.collectionLockFile()))))
        throw new NbaVideoError('已有 NBA 采集任务运行，请等待采集完成或先停止采集', 409)
      this.acquireRunLock(run.id, this.collectionLockFile())
    }
    try {
      return this.consoleMutation(state => {
        const latest = state.requests[input.requestId]
        if (latest) {
          if (latest.hash !== hash) throw new NbaVideoError('同一请求编号不能提交不同内容', 409)
          const existingRun = state.runs.find(item => item.id === latest.runId)
          if (!existingRun) throw new NbaVideoError('该请求已归档，请使用新的请求编号', 409)
          if (kind === 'collect') this.releaseRunLock(run.id, this.collectionLockFile())
          return { run: existingRun, existing: true }
        }
        if (kind !== 'collect' && state.runs.some(row => active(row) && (row.kind !== 'collect' || row.queueVersion !== 2) && row.jobIds.some(id => jobIds.includes(id))))
          throw new NbaVideoError('所选任务已在制作队列中，请等待原任务完成或停止原任务', 409)
        state.requests[input.requestId] = { hash, runId: run.id }
        state.runs.unshift(run)
        const kept = new Set(state.runs.filter(active).map(row => row.id))
        state.runs = state.runs.filter((row, index) => index < 200 || kept.has(row.id))
        const keptRuns = new Set(state.runs.map(item => item.id))
        state.requests = Object.fromEntries(Object.entries(state.requests).filter(([, item]) => keptRuns.has(item.runId)))
        return { run, existing: false }
      })
    } catch (error) { if (kind === 'collect') this.releaseRunLock(run.id, this.collectionLockFile()); throw error }
  }

  private prepareRun(run: NbaRun, launch: () => void) {
    try { launch() }
    catch (error) {
      run.status = 'failed'; run.message = safeMessage(error); run.updatedAt = this.stamp()
      try { this.save(run) } catch (saveError) { console.error('[nba-run-prepare]', safeMessage(saveError)) }
      finally { this.releaseRunLock(run.id, this.runLockFile(run)) }
      throw error
    }
  }

  start(input: z.infer<typeof nbaStartSchema>) {
    const parsed = nbaStartSchema.parse(input)
    this.sync()
    if (!this.state.requests[parsed.requestId] && parsed.collectionMode === 'channels' && !this.currentSettings().youtubeChannels.length) {
      throw new NbaVideoError('请先配置至少一个 YouTube 频道')
    }
    const registered = this.register(parsed, 'collect')
    if (!registered.existing) this.prepareRun(registered.run, () => {
      const settings = this.currentSettings()
      const run = registered.run
      run.collectionMode = parsed.collectionMode
      if (parsed.collectionMode === 'channels') run.youtubeChannels = [...settings.youtubeChannels]
      this.configureUpload(run, parsed.autoUpload ?? settings.autoUpload)
      const videosPerChannel = parsed.videosPerChannel ?? settings.videosPerChannel
      run.videosPerChannel = videosPerChannel
      run.productionSettings = structuredClone(settings)
      this.save(run)
      this.launch(run, async signal => {
        const intake: NbaIntakeInput = { ...parsed, signal, existingArticles: [...this.jobs.values()].map(job => job.article),
          progress: message => this.runMessage(run, message) }
        const result = parsed.collectionMode === 'channels'
          ? await this.collectChannels({ ...intake, signal, youtubeChannels: run.youtubeChannels!, videosPerChannel,
            existingVideos: readJson<NbaChannelVideo[]>(path.join(this.root, '.channel-history.json')) || [],
            reservedVideoIds: [...new Set([...this.jobs.values()].map(nbaSourceVideoId).filter((id): id is string => Boolean(id)))],
            scanStatePath: path.join(this.root, '.channel-scan.json'),
            includeHistory: !this.state.runs.some(row => row.kind !== 'collect' && active(row))
              && ![...this.jobs.values()].some(job => job.status === 'queued'),
            snapshotDir: path.join(this.root, 'collections', run.id) })
          : await this.collect(intake)
        signal.throwIfAborted()
        if ('videos' in result) run.videos = result.videos as NbaChannelVideo[]
        run.excluded = result.excluded
        run.sources = result.sources
        for (const article of result.articles) {
          const same = [...this.jobs.values()].find(job => job.article.id === article.id || job.article.bodyHash === article.bodyHash)
          if (same) {
            run.excluded.push({ url: article.url, title: article.title, reason: '该完整报道已建档', duplicateOf: same.id }); continue
          }
          const sameFootage = [...this.jobs.values()].find(job => sameNbaFootage(job, { article, game: article.game }))
          if (sameFootage) {
            run.excluded.push({ url: article.url, title: article.title, reason: '同一源视频已有新闻任务，跳过重复制作，保留原任务续做', duplicateOf: sameFootage.id }); continue
          }
          if (article.topic) delete article.heldReason
          const id = `nba-${createHash('sha256').update(article.bodyHash + article.url).digest('hex').slice(0, 20)}`
          const job: NbaJob = { id, title: article.title, article, game: article.game, status: article.heldReason ? 'attention' : 'queued', stage: 'match',
            message: article.heldReason || '完整报道已保存，等待翻译', createdAt: this.stamp(), updatedAt: this.stamp(), attempts: 0, canResume: true, logs: [] }
          this.saveJob(job); run.jobIds.push(id)
        }
        this.save(run)
        if (run.videos) {
          const history = new Map((readJson<NbaChannelVideo[]>(path.join(this.root, '.channel-history.json')) || []).map(video => [video.videoId, video]))
          for (const video of run.videos) history.set(video.videoId, video)
          writeJson(path.join(this.root, '.channel-history.json'), [...history.values()])
          if ('scanState' in result && result.scanState) writeJson(path.join(this.root, '.channel-scan.json'), result.scanState)
        }
        if (parsed.autoProduce) {
          this.enqueueCollectedJobs(run)
        }
        if (!run.jobIds.length && result.sources.length && result.sources.every(source => source.status === 'failed')) {
          throw new NbaVideoError('所有新闻来源读取失败，请查看运行记录后重试', 502)
        }
      })
    })
    return structuredClone(registered.run)
  }

  resume(input: z.infer<typeof nbaResumeSchema>) {
    this.sync()
    const parsed = nbaResumeSchema.parse(input)
    const prior = this.state.requests[parsed.requestId]
    if (!prior) {
      for (const id of parsed.jobIds) {
        const job = this.jobs.get(id)
        if (!job) throw new NbaVideoError('选择的 NBA 任务不存在', 404)
        if (job.status === 'running') throw new NbaVideoError('该任务正在制作', 409)
      }
    }
    const registered = this.register(parsed, 'resume', [...new Set(parsed.jobIds)])
    if (!registered.existing) this.drainProcessingQueue()
    return structuredClone(registered.run)
  }

  private currentAccount() {
    try { return this.uploadAccount() } catch { return null }
  }
  private recentCoverPhotos(excludedJobId: string) {
    const recent = [...this.jobs.values()].filter(job => job.id !== excludedJobId && job.uploads?.some(upload => upload.dispatched))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12)
    return [...new Set(recent.flatMap(job => {
      const cover = job.delivery?.verification.cover as { teams?: Array<{ player?: { photoSha256?: string } }> } | undefined
      return (cover?.teams || []).flatMap(team => /^[a-f0-9]{64}$/.test(team.player?.photoSha256 || '') ? [team.player!.photoSha256!] : [])
    }))]
  }
  private configureUpload(run: NbaRun, enabled: boolean) {
    run.autoUpload = enabled
    if (!enabled) return
    const account = this.currentAccount()
    if (account) { run.baijiahaoAccountName = account.accountName; run.baijiahaoAccountLabel = account.label }
  }
  private submittedUpload(job: NbaJob, accountName?: string) {
    return !!accountName && !!job.delivery && [...this.jobs.values()].some(other => other.uploads?.some(upload => {
      if (upload.accountName !== accountName || upload.inputDigest !== job.delivery!.sha256 || upload.status !== 'saved'
        || upload.payload?.publicationMode !== 'publish' || upload.result?.submitted !== true || upload.result.saved !== false) return false
      try { validateCbaUploadReceipt(upload.payload, upload.result, true); return true } catch { return false }
    }))
  }
  private footageOwner(job: NbaJob) {
    const priority = (candidate: NbaJob) => candidate.uploads?.some(upload => upload.dispatched && upload.payload?.publicationMode === 'publish') ? 0
      : candidate.status === 'completed' && this.validDelivery(candidate) ? 1 : 2
    const ordered = [...this.jobs.values()].filter(other => other.id === job.id || sameNbaFootage(job, other))
      .sort((first, second) => priority(first) - priority(second) || first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id))
    return ordered[0]?.id !== job.id ? ordered[0] : undefined
  }
  private publicationFootageOwner(job: NbaJob, accountName?: string) {
    if (!accountName) return undefined
    // An already-dispatched legacy job must reconcile its own receipt, never start a replacement upload.
    if (job.uploads?.some(upload => upload.accountName === accountName && upload.dispatched && upload.payload?.publicationMode === 'publish')) return undefined
    const dispatched = [...this.jobs.values()].find(other => other.id !== job.id && sameNbaFootage(job, other)
      && other.uploads?.some(upload => upload.accountName === accountName && upload.dispatched && upload.payload?.publicationMode === 'publish'))
    return dispatched || this.footageOwner(job)
  }
  private excludeFootage(run: NbaRun, job: NbaJob, owner: NbaJob) {
    if (!run.excluded.some(row => row.url === job.article.url && row.duplicateOf === owner.id)) run.excluded.push({
      url: job.article.url, title: job.title, duplicateOf: owner.id, reason: '同一源视频已由原任务保留，跳过重复制作或发表',
    })
    if (job.status !== 'completed') {
      job.status = 'attention'; job.canResume = false; job.message = `同一源视频已有任务：${owner.title}；已跳过重复制作，请续做原任务`
      job.updatedAt = this.stamp(); this.saveJob(job)
    }
    this.save(run)
  }
  startUpload(input: z.infer<typeof nbaUploadSchema>) {
    this.sync()
    const parsed = nbaUploadSchema.parse(input)
    if (!this.state.requests[parsed.requestId]) {
      const account = this.currentAccount()
      if (!account || account.status !== 'ready') throw new NbaVideoError('CBA 百家号账号尚未登录，请先在 CBA 工作台检查账号', 409)
      for (const id of parsed.jobIds) {
        const job = this.jobs.get(id)
        if (!job) throw new NbaVideoError('选择的 NBA 任务不存在', 404)
        if (job.status !== 'completed' || !this.validDelivery(job, true)) throw new NbaVideoError('请先完成并核验所选 NBA 成片', 422)
      }
    }
    const registered = this.register(parsed, 'upload', [...new Set(parsed.jobIds)])
    if (!registered.existing) this.drainProcessingQueue()
    return structuredClone(registered.run)
  }

  private async uploadJobs(run: NbaRun, signal: AbortSignal, jobIds = run.jobIds) {
    if (!run.baijiahaoAccountName) throw new NbaVideoError('未找到 CBA 百家号账号，成片已保留，请登录后继续上传', 409)
    for (const id of [...jobIds]) {
      signal.throwIfAborted()
      const release = await this.acquireExecutionJobLock(id, signal)
      try {
        const job = this.executionJob(id)
        if (!job) continue
        if (job.qualityHold) continue
        if (job.status !== 'completed' || !this.validDelivery(job, true) || this.submittedUpload(job, run.baijiahaoAccountName)) continue
        const footageOwner = this.publicationFootageOwner(job, run.baijiahaoAccountName)
        if (footageOwner) { this.excludeFootage(run, job, footageOwner); continue }
        const unresolved = [...this.jobs.values()].find(other => other.id !== job.id && other.uploads?.some(upload =>
          upload.accountName === run.baijiahaoAccountName && upload.inputDigest === job.delivery!.sha256 && upload.dispatched && upload.status !== 'saved'))
        if (unresolved) throw new NbaVideoError(`相同视频的原上传结果等待核对，请先继续上传原任务：${unresolved.title}`, 409)
        const message = (text: string) => this.runMessage(run, `${run.jobIds.indexOf(id) + 1}/${run.jobIds.length} · ${text}`)
        try {
          await this.upload({ job: structuredClone(job), jobDir: path.join(this.root, 'jobs', id), accountName: run.baijiahaoAccountName,
            accountLabel: run.baijiahaoAccountLabel || run.baijiahaoAccountName, signal,
            persist: upload => {
              job.uploads ||= []
              const index = job.uploads.findIndex(item => item.id === upload.id)
              if (index < 0) job.uploads.push(structuredClone(upload)); else job.uploads[index] = structuredClone(upload)
              job.updatedAt = this.stamp(); this.saveJob(job)
            }, persistDelivery: delivery => { job.delivery = structuredClone(delivery); job.updatedAt = this.stamp(); this.saveJob(job) }, onProgress: message })
        } catch (error) {
          message(safeMessage(error))
          // Keep the original upload checkpoint available to the recovery executor.
          throw error
        }
        signal.throwIfAborted()
        if (job.uploads?.some(upload => upload.accountName === run.baijiahaoAccountName && upload.dispatched && upload.status !== 'saved')) break
      } finally { release() }
    }
  }

  private enqueueCollectedJobs(collection: NbaRun) {
    if (!collection.jobIds.length || collection.productionRunId) return
    const run: NbaRun = {
      id: `nba-run-${randomUUID()}`, requestId: `${collection.requestId}-production`, kind: 'produce', queueVersion: 2,
      status: 'queued', jobIds: [...collection.jobIds], collectionRunId: collection.id,
      createdAt: this.stamp(), updatedAt: this.stamp(), message: '采集已入库，等待制作队列', excluded: [], sources: [],
      autoUpload: collection.autoUpload, baijiahaoAccountName: collection.baijiahaoAccountName,
      baijiahaoAccountLabel: collection.baijiahaoAccountLabel, productionSettings: collection.productionSettings,
    }
    collection.productionRunId = run.id
    this.save(collection, run)
  }

  private drainProcessingQueue() {
    if (this.closing || this.execution || this.lockAlive()) return
    this.reload()
    const run = [...this.state.runs].reverse().find(row => {
      const parent = this.state.runs.find(parent => parent.id === row.collectionRunId)
      return row.queueVersion === 2 && row.kind !== 'collect' && row.status === 'queued' && (!parent || !active(parent))
    })
    if (!run) return
    try { this.acquireRunLock(run.id) }
    catch (error) { if (error instanceof NbaVideoError && error.status === 409) return; throw error }
    try {
      this.reload()
      const saved = this.state.runs.find(row => row.id === run.id)
      if (!saved || saved.status !== 'queued') { this.releaseRunLock(run.id); return }
      this.launch(saved, async signal => {
        if (saved.kind !== 'upload' && saved.productionSettings?.scheduleEnabled && saved.autoUpload) {
          try { await this.uploadJobs(saved, signal) }
          catch (error) { signal.throwIfAborted(); this.runMessage(saved, `已保留原发表检查点，继续制作：${safeMessage(error)}`) }
        }
        if (saved.kind !== 'upload') await this.produceJobs(saved, signal)
        if (saved.autoUpload) await this.uploadJobs(saved, signal)
      })
    } catch (error) { this.releaseRunLock(run.id); throw error }
  }

  private launch(run: NbaRun, work: (signal: AbortSignal) => Promise<void>) {
    const collection = run.kind === 'collect'
    const lockFile = this.runLockFile(run)
    const owner = readJson<{ pid: number; runId: string }>(lockFile)
    if (owner?.pid !== process.pid || owner.runId !== run.id) throw new NbaVideoError('NBA 运行锁已变化，请刷新后重试', 409)
    const controller = new AbortController()
    if (collection) { this.collectionController = controller; this.collectionRun = run }
    else { this.controller = controller; this.processingRun = run }
    const stopFile = path.join(this.root, collection ? '.collection-stop-request.json' : '.stop-request.json')
    const remoteStop = setInterval(() => {
      try {
        if (readJson<{ runId: string }>(stopFile)?.runId !== run.id || controller.signal.aborted) return
        run.status = 'stopping'; this.runMessage(run, '正在停止，保留已完成产物')
        controller.abort(new DOMException('NBA 制作已停止', 'AbortError'))
      } catch (error) { console.error('[nba-stop]', safeMessage(error)) }
    }, 500)
    const execution = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      run.status = 'running'; this.runMessage(run, run.kind === 'collect' ? '正在读取体育视频并匹配完整新闻' : run.kind === 'upload' ? '正在直接发表百家号' : '正在恢复所选任务')
      await work(controller.signal)
      controller.signal.throwIfAborted()
      if (collection) {
        const failedVideos = run.videos?.filter(video => video.status === 'failed').length || 0
        run.status = failedVideos ? 'attention' : 'completed'
        run.message = `采集完成：${run.jobIds.length} 条新新闻已入库，排除 ${run.excluded.length} 条`
          + (run.productionRunId ? '；已发送到制作队列' : '') + (failedVideos ? `；${failedVideos} 个视频采集待重试` : '')
        return
      }
      const unfinished = run.jobIds.filter(id => {
        const job = this.jobs.get(id)
        if (job && !job.qualityHold && run.excluded.some(row => row.url === job.article.url && row.duplicateOf)) return false
        return !job || job.status !== 'completed' || (run.autoUpload && !this.submittedUpload(job, run.baijiahaoAccountName))
      })
      const failedVideos = run.videos?.filter(video => video.status === 'failed').length || 0
      run.status = unfinished.length || failedVideos ? 'attention' : 'completed'
      run.message = run.jobIds.length ? `本轮 ${run.jobIds.length} 条，${run.jobIds.length - unfinished.length} 条${run.autoUpload ? '已提交百家号发表' : '完成'}${unfinished.length ? `，${unfinished.length} 条待处理` : ''}`
        : `没有新增独立报道，排除 ${run.excluded.length} 条`
      if (failedVideos) run.message += `，${failedVideos} 个视频采集待重试`
    }).catch(error => {
      run.status = controller.signal.aborted ? 'stopped' : 'failed'
      run.message = controller.signal.aborted ? '本轮已停止，已有产物和待制作任务已保留' : safeMessage(error)
    }).finally(() => {
      clearInterval(remoteStop)
      try {
        run.updatedAt = this.stamp()
        if (!collection && !controller.signal.aborted && run.productionSettings?.scheduleEnabled && ['attention', 'failed'].includes(run.status)
          && (run.jobIds.some(id => this.jobs.get(id)?.automaticRetryable) || run.status === 'failed' && transientFailure(run.message))) {
          const attempts = run.automaticRecovery?.attempts || 0, delay = recoveryDelays[attempts]
          run.automaticRecovery = { attempts, ...(delay ? { nextAttemptAt: new Date(this.now().getTime() + delay).toISOString() } : {}) }
        } else if (run.status === 'completed' && run.automaticRecovery) delete run.automaticRecovery.nextAttemptAt
        this.save(run)
      } finally {
        try { this.releaseRunLock(run.id, lockFile) }
        finally {
          if (collection) { this.collectionExecution = undefined; this.collectionController = undefined; this.collectionRun = undefined }
          else { this.execution = undefined; this.controller = undefined; this.processingRun = undefined }
          try { if (readJson<{ runId: string }>(stopFile)?.runId === run.id) fs.unlinkSync(stopFile) }
          catch (error) { console.error('[nba-stop-cleanup]', safeMessage(error)) }
          this.drainProcessingQueue()
        }
      }
    }).catch(error => { console.error('[nba-run-save]', safeMessage(error)) })
    if (collection) this.collectionExecution = execution
    else this.execution = execution
  }
  private runMessage(run: NbaRun, message: string) { run.message = safeMessage(message); run.updatedAt = this.stamp(); this.save(run) }
  private validDelivery(job: NbaJob, hash = false) {
    try {
      const d = job.delivery
      if (!d || !this.contained(d.videoPath) || !(d.duration > 0)) return false
      const info = fs.statSync(d.videoPath)
      if (!info.isFile() || info.size !== d.bytes) return false
      const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${d.sha256}`
      let check = this.deliveryChecks.get(d.videoPath)
      if (hash || check?.stat !== stamp) {
        check = { stat: stamp, valid: fileHash(d.videoPath) === d.sha256 }
        this.deliveryChecks.set(d.videoPath, check)
      }
      return check!.valid
    } catch { return false }
  }
  private async produceJobs(run: NbaRun, signal: AbortSignal) {
    const settings = structuredClone(run.productionSettings || this.state.settings)
    for (const id of [...run.jobIds]) {
      signal.throwIfAborted()
      const release = await this.acquireExecutionJobLock(id, signal)
      try {
        const job = this.executionJob(id)
        if (!job) continue
        if (job.qualityHold) {
          job.status = 'attention'; job.canResume = false; job.message = job.qualityHold.reason; job.updatedAt = this.stamp(); this.saveJob(job); continue
        }
        if (job.status === 'completed' && this.validDelivery(job, true)) continue
        const footageOwner = this.footageOwner(job)
        if (footageOwner) { this.excludeFootage(run, job, footageOwner); continue }
        if (!job.article.topic && job.article.heldReason && /AI|辅助|播客|赛前|不应自动生产/.test(job.article.heldReason)) {
          job.status = 'attention'; job.message = job.article.heldReason; job.updatedAt = this.stamp(); this.saveJob(job); continue
        }
        job.status = 'running'; job.canResume = false; job.attempts++; job.updatedAt = this.stamp(); this.saveJob(job)
        const progress: NbaProductionInput['onProgress'] = (stage, message) => {
          signal.throwIfAborted()
          job.stage = stage; job.message = safeMessage(message); job.updatedAt = this.stamp()
          job.logs.push({ at: this.stamp(), stage, message: job.message }); job.logs = job.logs.slice(-200)
          this.saveJob(job); this.runMessage(run, `${run.jobIds.indexOf(id) + 1}/${run.jobIds.length} · ${job.message}`)
        }
        try {
          let patch: Partial<NbaJob>
          for (let mediaRetry = 0; ; ) {
            signal.throwIfAborted()
            try {
              patch = await this.produce({ job: structuredClone(job), jobDir: path.join(this.root, 'jobs', id), sharedDir: path.join(this.root, 'shared'), settings,
                recentCoverPhotoSha256s: this.recentCoverPhotos(id),
                signal, onProgress: progress, checkpoint: patch => {
                  signal.throwIfAborted()
                  const { id: ignoredId, article: ignoredArticle, status: ignoredStatus, ...fields } = patch
                  Object.assign(job, fields, { updatedAt: this.stamp() }); this.saveJob(job)
                } })
              break
            } catch (error: any) {
              signal.throwIfAborted()
              if (error?.stage !== 'media' || error?.retryable !== true || mediaRetry >= mediaRetryDelays.length) throw error
              const waitMs = mediaRetryDelays[mediaRetry++]!
              progress('media', `素材准备暂时中断，第 ${mediaRetry}/${mediaRetryDelays.length} 次自动恢复，等待 ${waitMs / 1000} 秒后重试：${safeMessage(error)}`)
              await this.waitForMediaRetry(waitMs, signal)
              signal.throwIfAborted()
              job.attempts++
              progress('media', `正在第 ${mediaRetry}/${mediaRetryDelays.length} 次自动恢复，复用已保存的译稿与素材检查点`)
            }
          }
          signal.throwIfAborted()
          const { id: ignoredId, article: ignoredArticle, status: ignoredStatus, ...fields } = patch
          Object.assign(job, fields)
          if (!this.validDelivery(job, true)) throw new NbaVideoError('交付文件不完整，已保留检查点', 422)
          if (job.script?.title) job.title = job.script.title
          job.status = 'completed'; job.stage = 'completed'; job.canResume = false; job.automaticRetryable = false; job.message = '中文新闻视频已完成，成片与来源已归档'
        } catch (error: any) {
          job.status = signal.aborted ? 'stopped' : error?.code === 'NBA_ATTENTION' || error?.status === 422 ? 'attention' : 'failed'
          job.canResume = true; job.message = signal.aborted ? '制作已停止，可从检查点继续' : safeMessage(error)
          job.automaticRetryable = !signal.aborted && (error?.retryable === true || error?.retryable !== false && transientFailure(job.message))
          if (error?.stage) job.stage = error.stage
        } finally { job.updatedAt = this.stamp(); this.saveJob(job) }
        signal.throwIfAborted()
      } finally { release() }
      if (run.productionSettings?.scheduleEnabled && run.autoUpload) {
        try { await this.uploadJobs(run, signal, run.jobIds.slice(0, run.jobIds.indexOf(id) + 1)) }
        catch (error) { signal.throwIfAborted(); this.runMessage(run, `已保留发表检查点，继续后续任务：${safeMessage(error)}`) }
      }
    }
  }

  stop(id: string) {
    this.sync()
    const run = this.state.runs.find(item => item.id === id)
    if (!run) throw new NbaVideoError('运行记录不存在', 404)
    if (!active(run)) return structuredClone(run)
    const collection = run.kind === 'collect' && run.queueVersion === 2
    const controller = collection ? this.collectionRun?.id === id ? this.collectionController : undefined
      : this.processingRun?.id === id ? this.controller : undefined
    const owner = readJson<{ runId: string }>(this.runLockFile(run))
    const running = owner?.runId === id && this.lockAlive(this.runLockFile(run))
    run.status = running ? 'stopping' : 'stopped'
    delete run.resumeOnRestart
    if (run.automaticRecovery) delete run.automaticRecovery.nextAttemptAt
    this.runMessage(run, collection ? '采集已停止，已入库来源保留' : '制作已停止，采集与已入库任务保留')
    if (controller) controller.abort(new DOMException('NBA 任务已停止', 'AbortError'))
    else if (running) writeJson(path.join(this.root, collection ? '.collection-stop-request.json' : '.stop-request.json'), { runId: id, requestedAt: this.stamp() })
    return structuredClone(run)
  }

  resumeRun(id: string) {
    this.sync()
    const run = this.state.runs.find(item => item.id === id)
    if (!run) throw new NbaVideoError('运行记录不存在', 404)
    if (run.kind === 'collect') throw new NbaVideoError('请重新发起采集；此操作只恢复已入库任务的制作队列', 409)
    if (active(run) || run.status === 'completed') return structuredClone(run)
    if (this.state.runs.some(other => other.id !== id && other.kind !== 'collect' && active(other) && other.jobIds.some(jobId => run.jobIds.includes(jobId))))
      throw new NbaVideoError('原任务已在其他制作队列中，请继续该队列', 409)
    run.queueVersion = 2; run.status = 'queued'; run.updatedAt = this.stamp()
    run.message = '已恢复原制作队列，沿用原任务、制作配置和发表账号'
    this.save(run); this.drainProcessingQueue()
    return structuredClone(this.state.runs.find(item => item.id === id)!)
  }

  settings(input: unknown) {
    const settings = nbaSettingsSchema.parse(input)
    this.sync()
    return this.consoleMutation(state => {
      const changedSchedule = state.settings.scheduleEnabled !== settings.scheduleEnabled || state.settings.intervalMinutes !== settings.intervalMinutes
      state.settings = settings
      writeJson(path.join(this.root, '.channels.json'), { youtubeChannels: settings.youtubeChannels })
      if (changedSchedule || !state.nextCollectionAt) state.nextCollectionAt = new Date(this.now().getTime() + settings.intervalMinutes * 60_000).toISOString()
      return structuredClone(settings)
    })
  }
  channels(input: unknown) {
    this.sync()
    const value = nbaChannelsSchema.parse(input)
    writeJson(path.join(this.root, '.channels.json'), value)
    return this.currentSettings()
  }
  async tick() {
    this.sync()
    if (this.state.settings.scheduleEnabled) {
      for (const run of this.state.runs) {
        const recovery = run.automaticRecovery
        if (run.kind === 'collect' || !['attention', 'failed'].includes(run.status) || !recovery?.nextAttemptAt || Date.parse(recovery.nextAttemptAt) > this.now().getTime()) continue
        if (this.state.runs.some(other => other.id !== run.id && other.kind !== 'collect' && active(other) && other.jobIds.some(id => run.jobIds.includes(id)))) continue
        run.status = 'queued'; run.queueVersion = 2
        run.automaticRecovery = { attempts: recovery.attempts + 1 }
        run.message = `全天流程第 ${run.automaticRecovery.attempts}/${recoveryDelays.length} 次恢复临时故障，复用原检查点`
        run.updatedAt = this.stamp(); this.save(run)
      }
    }
    this.drainProcessingQueue()
    if (!this.state.settings.scheduleEnabled || this.collectionExecution || this.lockAlive(this.collectionLockFile())
      || this.state.runs.some(run => run.kind === 'collect' && active(run))) return
    if (!this.state.nextCollectionAt) { this.state.nextCollectionAt = new Date(this.now().getTime() + this.state.settings.intervalMinutes * 60_000).toISOString(); this.save(); return }
    if (this.now().getTime() < new Date(this.state.nextCollectionAt).getTime()) return
    const { languages, limit, autoProduce, autoUpload, videosPerChannel } = this.currentSettings()
    this.start({ requestId: `schedule-${randomUUID()}`, collectionMode: 'channels', languages, limit, autoProduce, autoUpload, videosPerChannel, articleUrls: [] })
  }
  deleteTask(id: string, expectedTitle: string) {
    this.sync()
    const remove = () => {
      const release = this.acquireJobLock(id)
      try {
        const job = readJson<NbaJob>(path.join(this.root, 'jobs', id, 'job.json'))
        if (!job) throw new NbaVideoError('任务不存在', 404)
        if (job.title !== expectedTitle) throw new NbaVideoError('标题已变化，请重新确认要删除的任务', 409)
        const blocked = this.deleteBlockedReason(job, true)
        if (blocked) throw new NbaVideoError(blocked, 409)
        fs.rmSync(path.join(this.root, 'jobs', id), { recursive: true })
        this.forgetDeletedJob(id)
        return { deleted: true, id }
      } finally { release() }
    }
    // The run keeps its global lease; a queued deletion only locks the selected job.
    return this.state.runs.some(active) ? remove() : this.idleMutation(remove)
  }
  updateSource(id: string, input: unknown) {
    return this.idleMutation(() => {
      const value = nbaSourceSchema.parse(input)
      const video = parseHistoryYoutubeUrl(value.youtubeUrl)
      if (video.kind !== 'video') throw new NbaVideoError('请填写单条 YouTube 视频链接')
      const job = this.jobs.get(id)
      if (!job) throw new NbaVideoError('任务不存在', 404)
      if (job.article.youtubeUrl === value.youtubeUrl) return this.publicJob(job, true)
      job.article.youtubeUrl = value.youtubeUrl
      if (job.article.topic || !job.game?.verified && !job.article.game?.verified) {
        job.article.topic = { ...job.article.topic, id: `youtube-${video.videoId}`, videoId: video.videoId!,
          title: job.article.topic?.title || job.article.title, description: job.article.topic?.description || '', youtubeUrl: video.url }
        job.article.sourceVideoId = video.videoId
        delete job.article.heldReason
      }
      if (job.game?.verified && job.article.heldReason && !/AI|辅助|播客|赛前/.test(job.article.heldReason)) delete job.article.heldReason
      delete job.media; delete job.delivery
      job.stage = 'media'; job.status = 'attention'; job.canResume = true
      job.message = '视频链接已保存，继续制作时将读取对应素材'; job.updatedAt = this.stamp()
      job.logs.push({ at: this.stamp(), stage: 'media', message: job.message })
      this.saveJob(job)
      return this.publicJob(job, true)
    })
  }
  private contained(file: string) {
    try { const real = fs.realpathSync(file), base = fs.realpathSync(this.root); return real.startsWith(base + path.sep) } catch { return false }
  }
  asset(id: string, kind: string, refresh = true) {
    if (refresh) this.sync()
    const job = this.jobs.get(id)
    if (!job) throw new NbaVideoError('任务不存在', 404)
    if (kind === 'video' && !this.validDelivery(job)) throw new NbaVideoError('成片文件校验失败，请继续制作以修复', 404)
    const registered: Record<string, { path?: string; type: string }> = {
      video: { path: job.delivery?.videoPath, type: 'video/mp4' }, cover: { path: job.delivery?.coverPath, type: job.delivery?.coverPath?.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' },
      portraitCover: { path: job.delivery?.portraitCoverPath, type: 'image/png' },
      voice: { path: job.delivery?.voicePath, type: 'audio/wav' }, subtitles: { path: job.delivery?.subtitlesPath, type: 'text/plain; charset=utf-8' },
      source: { path: job.media?.path, type: 'video/mp4' },
    }
    const file = registered[kind]
    if (!file?.path || !this.contained(file.path) || !fs.statSync(file.path).isFile()) throw new NbaVideoError('该素材尚未就绪或不在 NBA 资产目录内', 404)
    return { path: file.path, type: file.type }
  }
  private publicJob(job: NbaJob, detail = false) {
    const result: any = structuredClone(job)
    result.deleteBlockedReason = this.deleteBlockedReason(job)
    result.canDelete = !result.deleteBlockedReason
    const valid = job.delivery ? this.validDelivery(job) : false
    const account = this.currentAccount()
    result.uploaded = valid && this.submittedUpload(job, account?.accountName)
    result.canUpload = job.status === 'completed' && valid && !result.uploaded
    result.publishingDescription = job.script?.title ? nbaPublishingDescription(job) : undefined
    result.uploads = (job.uploads || []).map(upload => ({
      id: upload.id, accountName: upload.accountName, accountLabel: upload.accountLabel,
      status: upload.status === 'saved' && upload.payload?.publicationMode === 'publish' && upload.result?.submitted ? (upload.result.published ? 'published' : 'submitted') : upload.status,
      message: safeMessage(upload.message), createdAt: upload.createdAt, updatedAt: upload.updatedAt, dispatched: upload.dispatched,
      description: upload.result?.published && upload.publishedDescriptionRevision?.verification === 'original_article_server_description'
        && upload.publishedDescriptionRevision.articleId === upload.result.articleId
        ? upload.publishedDescriptionRevision.description : upload.payload?.description,
      currentVersion: upload.inputDigest === job.delivery?.sha256,
      result: upload.result ? { saved: upload.result.saved, submitted: upload.result.submitted, published: upload.result.published,
        publicationStatus: upload.result.publicationStatus, articleId: upload.result.articleId, publishedUrl: upload.result.publishedUrl,
        editorUrl: upload.result.editorUrl, draftUrl: upload.result.draftUrl, targetId: upload.result.targetId } : undefined,
    }))
    result.canResume = job.status !== 'running' && (job.status !== 'completed' || !valid)
    const footageOwner = this.footageOwner(job)
    const publicationOwner = this.publicationFootageOwner(job, account?.accountName)
    if (footageOwner) {
      result.duplicateFootageOf = footageOwner.id
      result.canResume = false
      if (job.status !== 'completed') result.message = `同一源视频已有任务：${footageOwner.title}；已跳过重复制作，请续做原任务`
    }
    if (publicationOwner) {
      result.canUpload = false
      if (!job.uploads?.some(upload => upload.dispatched)) result.message = `同一源视频已有任务：${publicationOwner.title}；已跳过重复发表`
    }
    if (job.status === 'completed' && !valid) {
      result.status = 'attention'; result.stage = 'verify'
      result.message = '成片文件已缺失或发生变化，请继续制作以核验和修复'
    }
    if (job.qualityHold) {
      result.status = 'attention'; result.message = job.qualityHold.reason
      result.canUpload = false; result.canResume = false; result.uploaded = false
    }
    result.assets = {}
    for (const kind of ['video', 'cover', 'portraitCover', 'voice', 'subtitles', 'source']) {
      if (kind === 'video' && job.delivery && !valid) continue
      try { this.asset(job.id, kind, false); result.assets[kind] = `/api/v1/nba-video/jobs/${job.id}/assets/${kind}` } catch { /* Not produced yet. */ }
    }
    if (!detail) delete result.article.body
    if (result.delivery) for (const key of ['videoPath', 'coverPath', 'portraitCoverPath', 'voicePath', 'subtitlesPath', 'assPath']) delete result.delivery[key]
    if (result.media) { delete result.media.path; delete result.media.reducedAudioPath }
    return result
  }
  detail(id: string) { this.sync(); const job = this.jobs.get(id); if (!job) throw new NbaVideoError('NBA 任务不存在', 404); return this.publicJob(job, true) }
  overview() {
    this.sync()
    const jobs = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => this.publicJob(job))
    const matches = [...new Map(jobs.filter(job => job.game).map(job => [job.game.id, { ...job.game,
      jobCount: jobs.filter(other => other.game?.id === job.game.id).length, mediaReady: jobs.some(other => other.game?.id === job.game.id && other.assets.source) }])).values()]
    const activeCollection = this.state.runs.find(run => run.kind === 'collect' && active(run)) || null
    const activeProcessing = this.state.runs.find(run => run.kind !== 'collect' && ['running', 'stopping'].includes(run.status)) || null
    const queuedProcessing = [...this.state.runs].reverse().filter(run => run.kind !== 'collect' && run.status === 'queued')
    return { settings: structuredClone(this.currentSettings()), uploadAccount: this.currentAccount(), jobs, matches, runs: structuredClone(this.state.runs),
      activeRun: structuredClone(activeCollection || activeProcessing || queuedProcessing[0] || null),
      activeCollection: structuredClone(activeCollection), activeProcessing: structuredClone(activeProcessing), queuedProcessing: structuredClone(queuedProcessing),
      nextCollectionAt: this.state.settings.scheduleEnabled ? this.state.nextCollectionAt : null,
      stats: { total: jobs.length, completed: jobs.filter(job => job.status === 'completed' && !job.canResume).length,
        resumable: jobs.filter(job => job.canResume).length, running: jobs.filter(job => job.status === 'running').length,
        waitingUpload: jobs.filter(job => job.canUpload && !job.uploaded).length, uploaded: jobs.filter(job => job.uploaded).length } }
  }
  importJobs(jobs: NbaJob[]) {
    return this.idleMutation(() => {
      let imported = 0
      for (const job of jobs) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(job.id)) throw new NbaVideoError('导入任务编号无效')
        if (this.jobs.has(job.id) || [...this.jobs.values()].some(other => other.article.bodyHash === job.article.bodyHash)) continue
        if (!this.validDelivery(job, true)) throw new NbaVideoError('导入成片校验失败', 422)
        this.saveJob(job); imported++
      }
      return { imported }
    })
  }
  async waitForIdle() {
    this.drainProcessingQueue()
    while (this.execution || this.collectionExecution) await Promise.all([this.execution, this.collectionExecution])
  }
  async close() {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    if (this.state.settings.scheduleEnabled && this.processingRun?.status === 'running') {
      this.processingRun.resumeOnRestart = true
      this.save(this.processingRun)
    }
    this.controller?.abort(); this.collectionController?.abort()
    await this.waitForIdle()
  }
}
