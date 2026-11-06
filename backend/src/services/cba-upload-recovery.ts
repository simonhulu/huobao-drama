import { createHash } from 'node:crypto'
import type { SocialUploadPayload, SocialUploadResult, SocialUploadProgressOptions, SocialUploadSavedDraftPublication } from './social-auto-upload.js'

type UploadStatus = 'queued' | 'running' | 'saved' | 'blocked' | 'uncertain' | 'failed'
type Action = 'checkpoint' | 'runtime' | 'upload' | 'resume' | 'save' | 'reconcile'
export interface CbaUploadRecoveryAttempt {
  action: Action
  at: string
  outcome: 'started' | 'succeeded' | 'failed'
  message?: string
}
export interface CbaUploadRecoveryCurrent {
  id: string
  target: SocialUploadPayload['target']
  accountName?: string
  fingerprint: string
  inputDigest: string
  status: UploadStatus
  dispatched: boolean
  payload?: SocialUploadPayload
  result?: SocialUploadResult
  attempts?: CbaUploadRecoveryAttempt[]
}
export interface CbaUploadRecoveryPatch {
  status?: UploadStatus
  message?: string
  dispatched?: boolean
  result?: SocialUploadResult
  attempts?: CbaUploadRecoveryAttempt[]
}
type Runtime = Pick<typeof import('./social-auto-upload.js'), 'inspectSocialUploadCheckpoint' | 'inspectSocialUploadRuntime' | 'inspectSocialUploadAccountRuntime' | 'runSocialUpload' | 'resumeSocialUpload' | 'confirmSocialUpload' | 'reconcileSocialUpload'> & {
  publishSavedSocialUpload?: SocialUploadSavedDraftPublication
  resetSocialUploadAttempt?: typeof import('./social-auto-upload.js').resetSocialUploadAttempt
}
export interface CbaUploadRecoveryOptions extends SocialUploadProgressOptions {
  runtime: Runtime
  /** Must durably commit before resolving; failures prevent any following write. */
  persist: (patch: CbaUploadRecoveryPatch) => void | Promise<void>
  currentInputDigest?: string
  isCancelled?: () => boolean
  maxReadOnlyAttempts?: number
  readOnlyDelayMs?: number
  now?: () => number
}
export interface CbaUploadRecoveryResult {
  decision: 'saved' | 'blocked' | 'uncertain' | 'cancelled' | 'busy' | 'failed'
  status: UploadStatus
  message: string
  dispatched: boolean
  result?: SocialUploadResult
  attempts: CbaUploadRecoveryAttempt[]
  matchesCurrentVersion: boolean
  /** A caller that accepts duplicates may start another attempt, retaining the original evidence. */
  restartable: boolean
}

// The bridge also locks each job across processes. These guards close the gap
// between a stale in-process snapshot and the first durable bridge checkpoint.
const running = new Set<string>()
const dispatchedJobs = new Map<string, string>()
class Cancelled extends Error {}
class BindingError extends Error {}
class ReceiptError extends Error {}
class ReceiptBindingError extends ReceiptError {}
class ReadinessError extends Error {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

/** Called only after a verified cover revision on the original unsaved editor. */
export function rebindCbaUploadCovers(previous: SocialUploadPayload, revised: SocialUploadPayload, result: SocialUploadResult) {
  const identity = (payload: SocialUploadPayload) => {
    const { landscapePath, portraitPath, fingerprint, ...unchanged } = payload
    return canonical(unchanged)
  }
  if (running.has(previous.jobId) || previous.target !== 'baijiahao-video' || identity(previous) !== identity(revised)
    || !revised.landscapePath || !revised.portraitPath || !revised.fingerprint
    || previous.landscapePath === revised.landscapePath || previous.portraitPath === revised.portraitPath
    || !result.staged || result.saved || result.submitted || result.published || result.accountName !== previous.accountName)
    throw new BindingError('封面修订必须保留原视频、账号和未发表编辑页')
  const hash = (payload: SocialUploadPayload) => createHash('sha256').update(canonical(payload)).digest('hex')
  const existing = dispatchedJobs.get(previous.jobId), revisedDigest = hash(revised)
  if (existing && existing !== hash(previous) && existing !== revisedDigest)
    throw new BindingError('原上传素材指纹与封面修订不一致')
  if (existing) dispatchedJobs.set(previous.jobId, revisedDigest)
}
function detail(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, '[已隐藏]')
    .replace(/(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/g, raw => { try { const url = new URL(raw); return `${url.origin}${url.pathname}` } catch { return '[链接]' } }).slice(0, 1000)
}
const needsLogin = (message: string) => /登录|登陆|验证码|验证身份|人机验证|captcha|authentication|unauthorized|login.required|verification.required/i.test(message)
const transient = (message: string) => /timeout|timed.out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|network|socket|connection|连接|超时|网络|暂时不可用/i.test(message)

function platformUrl(raw: string | undefined, host: string): URL {
  let url: URL
  try { url = new URL(raw || '') } catch { throw new ReceiptError('上传回执链接无效，不能认定草稿已保存') }
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.hash) throw new ReceiptBindingError('上传回执平台或链接身份不一致')
  return url
}

function publicationReceipt(result: SocialUploadResult): boolean {
  if (result.submitted !== true || result.saved !== false || !/^\d+$/.test(result.articleId || '')
    || !['submitted', 'published'].includes(result.publicationStatus || '')
    || result.published !== (result.publicationStatus === 'published')) return false
  if (!result.publishedUrl) return !result.published
  try {
    const url = new URL(result.publishedUrl)
    return url.protocol === 'https:' && url.hostname === 'baijiahao.baidu.com' && !url.username && !url.password
      && !url.port && !url.hash && ['/s', '/builder/preview/s'].includes(url.pathname)
      && url.searchParams.getAll('id').length === 1 && url.searchParams.get('id') === result.articleId
  } catch { return false }
}

function validateReceipt(payload: SocialUploadPayload, result: SocialUploadResult | undefined, saved: boolean, previous?: SocialUploadResult): SocialUploadResult {
  if (result && result.accountName !== payload.accountName) throw new ReceiptBindingError('上传回执账号与任务绑定账号不一致，未取得可信草稿回执')
  const publishing = payload.publicationMode === 'publish'
  const validPublication = publishing
    ? result?.submitted === true ? publicationReceipt(result) : result?.published === false && result?.saved === false && !result?.publicationStatus && !result?.articleId
    : result?.published === false && !result?.submitted && (!saved || result?.saved === true)
  if (!result || result.staged !== true || typeof result.saved !== 'boolean' || !validPublication
    || (!publishing && saved && !result.saved) || result.accountName !== payload.accountName
    || !/^[A-Fa-f0-9]+$/.test(result.targetId || '') || !result.engine?.trim()) throw new ReceiptError('未取得与原账号绑定且未发布的可信草稿回执')
  if (previous && previous.targetId !== result.targetId) throw new ReceiptBindingError('上传回执对应的原编辑页身份已变化')
  const host = payload.target === 'tencent-video' ? 'channels.weixin.qq.com' : 'baijiahao.baidu.com'
  const editor = platformUrl(result.editorUrl, host)
  if (payload.target === 'baijiahao-video') {
    if (editor.pathname !== '/builder/rc/edit' || editor.searchParams.get('type') !== 'videoV2') throw new ReceiptError('百家号回执不是原视频编辑页')
    if (!publishing && (saved || result.draftUrl)) {
      const draft = platformUrl(result.draftUrl, host)
      const ids = draft.searchParams.getAll('article_id')
      if (draft.pathname !== '/builder/rc/edit' || draft.searchParams.get('type') !== 'videoV2' || ids.length !== 1 || !/^\d+$/.test(ids[0]!)) throw new ReceiptError('百家号回执缺少唯一视频草稿编号')
      if (previous?.draftUrl && platformUrl(previous.draftUrl, host).searchParams.get('article_id') !== ids[0]) throw new ReceiptBindingError('百家号草稿编号与原保存记录不一致')
      const editorIds = editor.searchParams.getAll('article_id')
      if (editorIds.length && (editorIds.length !== 1 || editorIds[0] !== ids[0])) throw new ReceiptBindingError('百家号编辑页与草稿编号不一致')
    }
  } else {
    if (editor.pathname !== '/platform/post/create') throw new ReceiptError('视频号回执不是原视频编辑页')
    if (saved || result.draftUrl) {
      const draft = platformUrl(result.draftUrl, host)
      if (draft.pathname !== '/platform/post/draftListManager' || draft.search) throw new ReceiptError('视频号回执缺少可信草稿列表链接')
    }
  }
  return result
}
export { validateReceipt as validateCbaUploadReceipt }

/** Check the original receipt without granting permission to upload, save or publish. */
export async function checkCbaUploadResult(payload: SocialUploadPayload, current: CbaUploadRecoveryCurrent,
  runtime: Pick<Runtime, 'inspectSocialUploadCheckpoint' | 'reconcileSocialUpload'>,
  options: SocialUploadProgressOptions = {}): Promise<{ status: 'complete' | 'pending' | 'needs_attention'; message: string; result?: SocialUploadResult }> {
  if (!current.payload || payload.jobId !== current.id || payload.target !== current.target || payload.accountName !== current.accountName
    || !payload.fingerprint || payload.fingerprint !== current.fingerprint || canonical(payload) !== canonical(current.payload))
    throw new BindingError('原上传任务、账号或素材指纹不一致，不能核对其他任务')
  const checkpoint = await runtime.inspectSocialUploadCheckpoint(payload)
  if (checkpoint.action === 'complete') {
    const result = validateReceipt(payload, checkpoint.result, payload.publicationMode !== 'publish', current.result)
    if (payload.publicationMode === 'publish' && result.submitted !== true) throw new ReceiptError('尚未取得可信的发表提交回执，请检查原编辑页')
    return { status: 'complete', message: result.submitted ? result.published ? '已核验发表结果' : '已核验提交结果，等待平台审核' : '已核验原草稿', result }
  }
  if (checkpoint.action === 'reconcile' || checkpoint.phase === 'save_requested') {
    const previous = validateReceipt(payload, checkpoint.result || current.result, false, current.result)
    const result = validateReceipt(payload, await runtime.reconcileSocialUpload(payload, previous, options), payload.publicationMode !== 'publish', previous)
    if (payload.publicationMode === 'publish' && result.submitted !== true) throw new ReceiptError('尚未取得可信的发表提交回执，请检查原编辑页')
    return { status: 'complete', message: result.submitted ? result.published ? '已只读核验发表结果' : '已只读核验提交结果，等待平台审核' : '已只读核验原草稿', result }
  }
  return { status: checkpoint.action === 'manual' ? 'needs_attention' : 'pending',
    message: checkpoint.action === 'save' ? '原编辑页已准备，尚未提交；可检查后继续发表'
      : checkpoint.action === 'resume' ? '原任务尚未完成，可检查后继续原任务'
      : checkpoint.action === 'upload' ? current.dispatched ? '缺少原上传检查点，请在原账号内容管理中核对结果' : '尚未开始上传'
      : checkpoint.message }
}

/** Recover only this persisted upload identity; never create a replacement job. */
export async function recoverCbaUpload(payload: SocialUploadPayload, current: CbaUploadRecoveryCurrent, options: CbaUploadRecoveryOptions): Promise<CbaUploadRecoveryResult> {
  const attempts = (current.attempts || []).slice(-80).map(item => ({ ...item }))
  let dispatched = current.dispatched || dispatchedJobs.has(current.id)
  let result = current.result
  const matchesCurrentVersion = options.currentInputDigest === undefined || options.currentInputDigest === current.inputDigest
  const response = (decision: CbaUploadRecoveryResult['decision'], status: UploadStatus, message: string, restartable = false): CbaUploadRecoveryResult => ({ decision, status, message, dispatched, result, attempts: attempts.map(item => ({ ...item })), matchesCurrentVersion, restartable })
  if (running.has(current.id)) return response('busy', current.status, '原上传任务正在核对中，不重复执行')
  running.add(current.id)
  const finish = async (decision: CbaUploadRecoveryResult['decision'], status: UploadStatus, message: string, restartable = false) => {
    const value = response(decision, status, message, restartable && matchesCurrentVersion)
    await options.persist({ status, message, dispatched, ...(result ? { result } : {}), attempts: value.attempts })
    return value
  }
  const checkCancelled = () => { if (options.isCancelled?.()) throw new Cancelled('任务已停止，保留原上传检查点') }
  const snapshot = structuredClone(payload)
  const digest = createHash('sha256').update(canonical(snapshot)).digest('hex')
  const saveAttempts = () => options.persist({ attempts: attempts.map(item => ({ ...item })) })
  async function invoke<T>(action: Action, execute: () => Promise<T>, write = false): Promise<T> {
    checkCancelled()
    const attempt: CbaUploadRecoveryAttempt = { action, at: new Date(options.now?.() ?? Date.now()).toISOString(), outcome: 'started' }
    attempts.push(attempt)
    if (write) {
      // A lost response after this point must be treated as potentially sent.
      await options.persist({ dispatched: true, status: 'running', attempts: attempts.map(item => ({ ...item })) })
      dispatched = true
      dispatchedJobs.set(current.id, digest)
    } else await saveAttempts()
    checkCancelled()
    try {
      const value = await execute()
      attempt.outcome = 'succeeded'
      await saveAttempts()
      return value
    } catch (error) {
      attempt.outcome = 'failed'; attempt.message = detail(error)
      await saveAttempts()
      throw error
    }
  }
  async function readOnly<T>(action: Action, execute: () => Promise<T>) {
    const limit = Math.max(1, Math.min(5, options.maxReadOnlyAttempts ?? 2))
    for (let attempt = 1; ; attempt++) {
      try { return await invoke(action, execute) } catch (error) {
        const message = detail(error)
        if (error instanceof Cancelled || needsLogin(message) || !transient(message) || attempt >= limit) throw error
        checkCancelled()
        const delay = Math.max(0, Math.min(1000, options.readOnlyDelayMs ?? 0))
        if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  let ready = false
  async function ensureReady() {
    if (ready) return
    const state = await readOnly('runtime', async () => {
      const value = snapshot.target === 'baijiahao-video' && snapshot.accountName
        ? await options.runtime.inspectSocialUploadAccountRuntime(snapshot.accountName)
        : await options.runtime.inspectSocialUploadRuntime(true).then(runtime => {
          const platform = runtime.platforms[snapshot.target === 'tencent-video' ? 'tencent' : 'baijiahao']
          return { ready: runtime.installed && platform.ready, message: platform.message || runtime.message }
        })
      if (!value.ready) throw new ReadinessError(value.message || '上传账号暂不可用')
      return value
    })
    ready = state.ready
  }
  try {
    if (!current.payload || snapshot.jobId !== current.id || snapshot.target !== current.target || snapshot.accountName !== current.accountName
      || !snapshot.fingerprint || snapshot.fingerprint !== current.fingerprint || canonical(snapshot) !== canonical(current.payload)
      || !['baijiahao-video', 'tencent-video'].includes(snapshot.target)
      || (dispatchedJobs.has(current.id) && dispatchedJobs.get(current.id) !== digest)) throw new BindingError('原上传任务、账号或素材指纹不一致，不能自动继续')
    checkCancelled()
    const performed = new Set<Action>()
    let writeFailure: string | undefined
    // At most one upload, resume and save; each subsequent operation needs a
    // new bridge checkpoint. No error response grants permission to write.
    for (let transition = 0; transition < 7; transition++) {
      const checkpoint = await readOnly('checkpoint', () => options.runtime.inspectSocialUploadCheckpoint(snapshot))
      checkCancelled()
      if (checkpoint.result) validateReceipt(snapshot, checkpoint.result, checkpoint.action === 'complete', result)
      if (checkpoint.action === 'complete') {
        result = validateReceipt(snapshot, checkpoint.result, snapshot.publicationMode !== 'publish', result)
        return await finish('saved', 'saved', snapshot.publicationMode === 'publish'
          ? (result.published ? '已核验原账号的百家号作品' : '已核验百家号提交结果，等待平台审核')
          : matchesCurrentVersion ? '已核验原账号的平台草稿' : '已核验旧制作版本的草稿，当前制作版本尚未上传')
      }
      if (checkpoint.action === 'busy') return await finish('busy', dispatched ? 'uncertain' : 'queued', checkpoint.message || '原上传任务正在执行，稍后核对')
      if (checkpoint.action === 'manual') return await finish(needsLogin(checkpoint.message) ? 'blocked' : 'uncertain', needsLogin(checkpoint.message) ? 'blocked' : 'uncertain', checkpoint.message, !needsLogin(checkpoint.message))
      if (checkpoint.action === 'reconcile' || checkpoint.phase === 'save_requested') {
        const bound = validateReceipt(snapshot, checkpoint.result || result, false, result)
        result = bound
        await ensureReady()
        result = validateReceipt(snapshot, await readOnly('reconcile', () => options.runtime.reconcileSocialUpload(snapshot, bound, { onProgress: options.onProgress })), snapshot.publicationMode !== 'publish', bound)
        return await finish('saved', 'saved', snapshot.publicationMode === 'publish'
          ? (result.published ? '已只读核验原账号的百家号作品' : '已只读核验百家号提交结果，等待平台审核')
          : matchesCurrentVersion ? '已只读核验原账号的平台草稿' : '已核验旧制作版本的草稿，当前制作版本尚未上传')
      }
      if (writeFailure) {
        // Only these bridge checkpoints prove initialization stopped before any
        // file selection. Keep dispatch history; a later explicit resume still
        // needs the original checkpoint rather than a replacement upload.
        if (checkpoint.action === 'resume' && ['opening', 'initializing'].includes(checkpoint.phase) && !checkpoint.result)
          return await finish('failed', 'failed', `上传初始化失败，尚未传入素材：${writeFailure}`)
        return await finish('uncertain', 'uncertain', `上传结果尚未确认：${writeFailure}；已保留原检查点，不重复上传或保存`, true)
      }
      if (!matchesCurrentVersion) return await finish('blocked', 'blocked', '制作版本已变化，只核对原草稿，不继续旧版本上传')
      const action = checkpoint.action
      if (!['upload', 'save', 'resume'].includes(action) || performed.has(action as Action)) return await finish('uncertain', 'uncertain', '原检查点未给出新的安全操作，保留任务等待核对', true)
      if (action === 'upload' && (dispatched || result || current.status === 'uncertain' || current.status === 'saved')) return await finish('uncertain', 'uncertain', '原任务可能已发送，但缺少可续接检查点，不重复上传', true)
      const staged = action === 'save' ? validateReceipt(snapshot, checkpoint.result, false, result) : undefined
      await ensureReady()
      checkCancelled()
      performed.add(action as Action)
      try {
        const progress = { onProgress: options.onProgress }
        const next = action === 'upload'
          ? await invoke('upload', () => options.runtime.runSocialUpload(snapshot, { ...progress, saveDraft: false }), true)
          : action === 'resume'
            ? await invoke('resume', () => options.runtime.resumeSocialUpload(snapshot, progress), true)
            : await invoke('save', () => options.runtime.confirmSocialUpload(snapshot, staged!, progress), true)
        result = validateReceipt(snapshot, next, action === 'save' && snapshot.publicationMode !== 'publish', staged || result)
        await options.persist({ result })
        if (snapshot.publicationMode === 'publish' && result.submitted) return await finish('saved', 'saved', result.published ? '已发表并核验原账号的百家号作品' : '已提交百家号，等待平台审核')
        if (result.saved) return await finish('saved', 'saved', '已核验原账号的平台草稿')
      } catch (error) {
        if (error instanceof Cancelled || error instanceof ReceiptError || needsLogin(detail(error))) throw error
        writeFailure = detail(error)
        options.onProgress?.('上传响应未确认，正在只读核对原任务检查点')
      }
    }
    return await finish('uncertain', 'uncertain', '已达到本次恢复次数上限，保留原任务等待核对', true)
  } catch (error) {
    if (error instanceof Cancelled) return await finish('cancelled', dispatched ? 'uncertain' : 'queued', error.message)
    const message = detail(error)
    if (error instanceof BindingError || error instanceof ReadinessError || needsLogin(message)) return await finish('blocked', 'blocked', message)
    return await finish(error instanceof ReceiptError || dispatched ? 'uncertain' : 'failed', error instanceof ReceiptError || dispatched ? 'uncertain' : 'failed', message, !(error instanceof ReceiptBindingError))
  } finally { running.delete(current.id) }
}
