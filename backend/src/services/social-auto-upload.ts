import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { ensureSocialUploadBrowser } from './social-upload-browser.js'

export type SocialTarget = 'baijiahao-video' | 'baijiahao-article' | 'tencent-video'
export interface SocialUploadPayload {
  jobId: string
  scriptId: number
  target: SocialTarget
  /** Named SAU account or managed history session; omitted by legacy editor checkpoints. */
  accountName?: string
  /** Legacy jobs omit this and retain draft-only behavior. */
  publicationMode?: 'draft' | 'publish'
  title: string
  description: string
  /** Optional platform metadata. The bridge only writes these when present. */
  tags?: string[]
  topicPolicy?: 'required-exact'
  creationDeclaration?: string
  watermark?: string
  videoPath?: string
  landscapePath?: string
  portraitPath?: string
  articleHtml?: string
  images?: Array<{ url: string; path: string }>
  fingerprint: string
}
export interface SocialUploadResult {
  accountName?: string
  staged: true
  saved: boolean
  published: boolean
  submitted?: boolean
  publicationStatus?: 'submitted' | 'published'
  articleId?: string
  publishedUrl?: string
  editorUrl: string
  draftUrl?: string
  targetId: string
  evidencePath?: string
  engine: string
}
export interface SocialUploadVideoCoverRevision {
  verification: 'original_video_and_revised_covers'
  revisionId: string
  previousPayloadDigest: string
  payloadDigest: string
  videoSha256: string
  landscapeSha256: string
  portraitSha256: string
  targetId: string
  result: SocialUploadResult
}
export interface SocialUploadRuntime {
  execution?: 'background'
  installed: boolean
  message: string
  version: string | null
  platforms: Record<'baijiahao' | 'tencent', { ready: boolean; message: string; sessionMode?: 'background'; accountName?: string;
    issue?: 'login_required' | 'verification_required' | 'browser_unavailable' | 'connection_failed' | 'check_failed' }>
}
export interface SocialUploadProgress { step: string; message: string }
export interface SocialUploadCheckpoint {
  action: 'upload' | 'resume' | 'save' | 'reconcile' | 'complete' | 'manual' | 'busy'
  phase: string
  message: string
  result?: SocialUploadResult
  progress?: SocialUploadProgress
}
export interface SocialUploadProgressOptions {
  onProgress?: (message: string, progress?: SocialUploadProgress) => void
}

export type SocialUploadReviewInput = { targetId: string } & (
  { action: 'click'; x: number; y: number }
  | { action: 'drag'; x: number; y: number; toX: number; toY: number }
  | { action: 'type'; text: string }
  | { action: 'key'; key: string }
  | { action: 'scroll'; deltaY: number }
  | { action: 'refresh' }
)
export interface SocialUploadReview {
  jobId: string; targetId: string; url: string; imageDataUrl: string
  width: number; height: number; originalEditor: boolean; message: string
}

export type SocialUploadSavedDraftPublication = (payload: SocialUploadPayload, legacyPayload: SocialUploadPayload,
  result: SocialUploadResult, options?: SocialUploadProgressOptions) => Promise<SocialUploadResult>

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const bridge = fileURLToPath(new URL('../../scripts/social-auto-upload/bridge.py', import.meta.url))

export function socialUploadConfiguration() {
  const root = process.env.SOCIAL_AUTO_UPLOAD_ROOT || path.join(os.homedir(), '.local/share/social-auto-upload')
  return {
    root,
    python: process.env.SOCIAL_AUTO_UPLOAD_PYTHON || path.join(root, '.venv/bin/python'),
    stateRoot: process.env.SOCIAL_AUTO_UPLOAD_STATE_ROOT || path.join(projectRoot, 'data/social-auto-upload'),
    baijiahao: process.env.SOCIAL_AUTO_UPLOAD_BAIJIAHAO_CDP || 'http://127.0.0.1:9225',
    tencent: process.env.SOCIAL_AUTO_UPLOAD_TENCENT_CDP || 'http://127.0.0.1:9222',
  }
}

function missingRuntime(message: string): SocialUploadRuntime {
  return { installed: false, message, version: null, platforms: {
    baijiahao: { ready: false, message }, tencent: { ready: false, message },
  } }
}

export async function runSocialUploadBridge<T>(action: string, input: Record<string, unknown>, options: SocialUploadProgressOptions & {
  timeoutMs?: number
} = {}): Promise<T> {
  const config = socialUploadConfiguration()
  if (!fs.existsSync(config.python) || !fs.existsSync(path.join(config.root, 'uploader'))) {
    throw new Error('未找到 social-auto-upload 安装，请配置 SOCIAL_AUTO_UPLOAD_ROOT 和 Python 环境')
  }
  return new Promise<T>((resolve, reject) => {
    const child = spawn(config.python, [bridge, action], {
      cwd: config.root,
      env: { ...process.env, PYTHONPATH: config.root, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let settled = false
    let partial = ''
    let result: T | undefined
    let failure = ''
    let stderr = ''
    let timeoutError: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error) } }
    const timeout = setTimeout(() => {
      timeoutError = new Error(action === 'inspect'
        ? '上传前环境检查超时，尚未开始上传，请重新检查平台状态'
        : '上传步骤超时，本次操作未完成')
      child.kill('SIGTERM')
      // Do not release the queue while this process may still operate Chrome.
      // The bridge lock also protects recovery from an orphan after a restart.
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
      killTimer.unref()
    }, options.timeoutMs ?? 25 * 60_000)
    timeout.unref()
    child.on('error', fail)
    child.stdin.on('error', () => { /* An early interpreter failure is reported by close. */ })
    child.stdout.on('data', (chunk: Buffer) => {
      partial += chunk.toString('utf8')
      const lines = partial.split('\n')
      partial = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('SAU_RESULT ')) {
          try { result = JSON.parse(line.slice(11)) } catch { failure = '上传程序返回了无法读取的结果' }
        } else if (line.startsWith('SAU_ERROR ')) {
          try { failure = JSON.parse(line.slice(10)).message || '上传失败' } catch { failure = '上传失败，结果待核对' }
        } else if (line.startsWith('SAU_PROGRESS ')) {
          try {
            const progress = JSON.parse(line.slice(13))
            options.onProgress?.(progress.message, typeof progress.step === 'string' ? progress : undefined)
          } catch { /* Progress is not completion evidence. */ }
        }
      }
      if (partial.length > (action === 'review-session' ? 8_000_000 : 65536)) partial = ''
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000) })
    child.on('close', code => {
      clearTimeout(killTimer)
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0 && result !== undefined) resolve(result)
      else reject(timeoutError || new Error(failure || (stderr.includes('ModuleNotFoundError')
        ? 'social-auto-upload 依赖或安全上传扩展不完整，请检查现有安装' : '上传程序异常退出，请重新上传')))
    })
    child.stdin.end(JSON.stringify({ ...input, config }))
  })
}

const runBridge = runSocialUploadBridge

export const HISTORY_UPLOAD_ACCOUNTS = { baijiahao: 'history_baijiahao', tencent: 'history_tencent' } as const
let historyRuntimeCache: { at: number; value: SocialUploadRuntime } | null = null
let historyInspecting: Promise<SocialUploadRuntime> | null = null

export async function inspectHistorySocialUploadRuntime(refresh = false): Promise<SocialUploadRuntime> {
  if (!refresh && historyRuntimeCache && Date.now() - historyRuntimeCache.at < 15_000) return historyRuntimeCache.value
  if (historyInspecting) return historyInspecting
  historyInspecting = runBridge<SocialUploadRuntime>('inspect-history', {}, { timeoutMs: 75_000 })
    .then(value => {
      if (value?.execution !== 'background' || typeof value.installed !== 'boolean'
        || !value.platforms?.baijiahao || !value.platforms?.tencent) throw new Error('后台上传会话响应不完整，请重新检查')
      for (const platform of ['baijiahao', 'tencent'] as const) {
        const state = value.platforms[platform]
        if (typeof state.ready !== 'boolean' || typeof state.message !== 'string'
          || state.ready && (state.sessionMode !== 'background' || state.accountName !== HISTORY_UPLOAD_ACCOUNTS[platform])) {
          throw new Error('后台上传账号绑定无法确认，请重新同步登录')
        }
      }
      return value
    })
    .catch(error => ({ ...missingRuntime(error.message), execution: 'background' as const }))
    .then(value => { historyRuntimeCache = { at: Date.now(), value }; return value })
    .finally(() => { historyInspecting = null })
  return historyInspecting
}

export async function syncHistorySocialUploadLogin(platform: 'baijiahao' | 'tencent') {
  if (!Object.hasOwn(HISTORY_UPLOAD_ACCOUNTS, platform)) throw new Error('上传平台无效')
  // Finish an earlier inspection before replacing credentials, so it cannot
  // repopulate the cache with a result from the old session after synchronization.
  await historyInspecting
  try {
    const result = await runBridge<{ synced: true; platform: 'baijiahao' | 'tencent'; message: string }>('sync-history', { platform }, { timeoutMs: 75_000 })
    if (result?.synced !== true || result.platform !== platform || typeof result.message !== 'string') throw new Error('后台登录同步结果未确认，请重新检查')
    return result
  } finally { historyRuntimeCache = null }
}

export async function inspectSocialUploadAccountRuntime(accountName: string): Promise<{ ready: boolean; message: string }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(accountName)) throw new Error('百家号账号编号无效')
  const result = await runBridge<{ ready: boolean; message: string }>('inspect-account', { accountName }, { timeoutMs: 75_000 })
  if (typeof result?.ready !== 'boolean' || typeof result?.message !== 'string') throw new Error('百家号账号检查结果无法识别')
  return result
}

export async function inspectSocialUploadCheckpoint(payload: SocialUploadPayload): Promise<SocialUploadCheckpoint> {
  const checkpoint = await runBridge<SocialUploadCheckpoint>('checkpoint', { payload }, { timeoutMs: 30_000 })
  if (!checkpoint || !['upload', 'resume', 'save', 'reconcile', 'complete', 'manual', 'busy'].includes(checkpoint.action)
    || typeof checkpoint.phase !== 'string' || typeof checkpoint.message !== 'string') throw new Error('上传检查点响应无法识别，需要核对原任务')
  if (checkpoint.result) validateResult(checkpoint.result, checkpoint.action === 'complete', payload)
  if (['save', 'reconcile', 'complete'].includes(checkpoint.action) && !checkpoint.result) throw new Error('检查点缺少绑定结果，不能继续保存或核对')
  return checkpoint
}

let runtimeCache: { at: number; value: SocialUploadRuntime } | null = null
let inspecting: Promise<SocialUploadRuntime> | null = null
export async function inspectSocialUploadRuntime(refresh = false): Promise<SocialUploadRuntime> {
  if (!refresh && runtimeCache && Date.now() - runtimeCache.at < 10_000) return runtimeCache.value
  if (inspecting) return inspecting
  // Each platform has its own 45s deadline. Allow driver startup and cleanup
  // without turning a finished healthy-platform check into a global failure.
  inspecting = runBridge<SocialUploadRuntime>('inspect', {}, { timeoutMs: 75_000 })
    .catch(error => missingRuntime(error.message))
    .then(value => { runtimeCache = { at: Date.now(), value }; return value })
    .finally(() => { inspecting = null })
  return inspecting
}

export async function openSocialUploadLogin(platform: 'baijiahao' | 'tencent') {
  const config = socialUploadConfiguration()
  const endpoint = new URL(config[platform])
  await ensureSocialUploadBrowser({ endpoint, projectRoot,
    profileDir: path.join(projectRoot, 'data', platform === 'baijiahao' ? 'baijiahao-profile' : 'wechat-channels-profile'),
    starter: platform === 'baijiahao' ? 'start-baijiahao-cdp-chrome.mjs' : 'start-wechat-channels-cdp-chrome.mjs',
    portVar: platform === 'baijiahao' ? 'BAIJIAHAO_CDP_PORT' : 'WECHAT_CHANNELS_CDP_PORT',
  })
  runtimeCache = null
  return runBridge<{ opened: true; message: string }>('open', { platform }, { timeoutMs: 75_000 })
}

function validatePayloadMode(payload: SocialUploadPayload) {
  if (payload.publicationMode !== undefined && !['draft', 'publish'].includes(payload.publicationMode)
    || payload.publicationMode === 'publish' && payload.target !== 'baijiahao-video') {
    throw new Error('直接发表仅支持百家号视频')
  }
}

function publicationReceipt(result: SocialUploadResult) {
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

function validateResult(result: SocialUploadResult, completed: boolean, payload: SocialUploadPayload) {
  validatePayloadMode(payload)
  const publish = payload.publicationMode === 'publish'
  const validState = publish
    ? (result?.submitted === true ? publicationReceipt(result) : !completed && result?.saved === false && result?.published === false && !result.publicationStatus && !result.articleId)
    : result?.published === false && !result?.submitted && (!completed || result.saved)
  if (result?.staged !== true || !validState || typeof result.saved !== 'boolean'
    || !/^[A-Fa-f0-9]+$/.test(result.targetId || '')
    || !/^https:\/\/(baijiahao\.baidu\.com|channels\.weixin\.qq\.com)\//.test(result.editorUrl || '')
    || (payload.accountName !== undefined && result.accountName !== payload.accountName)) {
    throw new Error('未获得与任务账号绑定的可信上传结果')
  }
  return result
}

export async function runSocialUpload(payload: SocialUploadPayload, options: SocialUploadProgressOptions & {
  saveDraft: boolean
}): Promise<SocialUploadResult> {
  validatePayloadMode(payload)
  if (payload.publicationMode === 'publish' && options.saveDraft) throw new Error('直接发表任务不能同时保存草稿；请先准备内容再确认发表')
  const result = await runBridge<SocialUploadResult>('stage', { payload, saveDraft: options.saveDraft }, options).finally(() => { runtimeCache = null })
  return validateResult(result, options.saveDraft, payload)
}

export async function confirmSocialUpload(payload: SocialUploadPayload, result: SocialUploadResult, options: SocialUploadProgressOptions = {}): Promise<SocialUploadResult> {
  validatePayloadMode(payload)
  const publish = payload.publicationMode === 'publish'
  const saved = await runBridge<SocialUploadResult>(publish ? 'publish' : 'save', { payload, result, ...(publish ? { confirmPublish: true } : { confirmSave: true }) }, { ...options, timeoutMs: 5 * 60_000 }).finally(() => { runtimeCache = null })
  return validateResult(saved, true, payload)
}

/** Publish an already verified Baijiahao draft in place without selecting the video again. */
export async function publishSavedSocialUpload(payload: SocialUploadPayload, legacyPayload: SocialUploadPayload,
  result: SocialUploadResult, options: SocialUploadProgressOptions = {}): Promise<SocialUploadResult> {
  validatePayloadMode(payload)
  if (payload.publicationMode !== 'publish' || legacyPayload.publicationMode === 'publish') {
    throw new Error('旧草稿转发表需要新的 publish 任务和原 draft 任务')
  }
  const published = await runBridge<SocialUploadResult>('publish-saved', { payload, legacyPayload, result },
    { ...options, timeoutMs: 5 * 60_000 }).finally(() => { runtimeCache = null })
  return validateResult(published, true, payload)
}

/** Read-only verification of the staged original editor; never clicks publish. */
export async function inspectSocialPublication(payload: SocialUploadPayload) {
  validatePayloadMode(payload)
  if (payload.publicationMode !== 'publish') throw new Error('该任务未选择直接发表')
  const result = await runBridge<{ ready: true; writes: false; targetId: string }>('publish-preflight', { payload }, { timeoutMs: 75_000 })
  if (result?.ready !== true || result.writes !== false || !/^[A-Fa-f0-9]+$/.test(result.targetId || '')) throw new Error('发表预检未通过')
  return result
}

export async function resumeSocialUpload(payload: SocialUploadPayload, options: SocialUploadProgressOptions = {}): Promise<SocialUploadResult> {
  const result = await runBridge<SocialUploadResult>('resume', { payload }, { ...options, timeoutMs: 25 * 60_000 }).finally(() => { runtimeCache = null })
  return validateResult(result, false, payload)
}

/** Replace versioned cover files in the bound unsubmitted editor without selecting its video again. */
export async function updateSocialUploadVideoCovers(payload: SocialUploadPayload, previousPayload: SocialUploadPayload,
  options: SocialUploadProgressOptions = {}): Promise<SocialUploadVideoCoverRevision> {
  validatePayloadMode(payload)
  const mutable = new Set(['landscapePath', 'portraitPath', 'fingerprint'])
  const before = previousPayload as unknown as Record<string, unknown>, after = payload as unknown as Record<string, unknown>
  if (payload.target !== 'baijiahao-video' || !payload.accountName || !payload.fingerprint
    || [...new Set([...Object.keys(before), ...Object.keys(after)])].some(key => !mutable.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key]))) {
    throw new Error('更换封面必须保留原任务、账号、视频、文案和发表设置')
  }
  const oldPaths = [previousPayload.videoPath, previousPayload.landscapePath, previousPayload.portraitPath]
  const newPaths = [payload.landscapePath, payload.portraitPath]
  if ([...oldPaths, ...newPaths].some(value => !value) || new Set(newPaths.map(value => path.resolve(value!))).size !== 2
    || newPaths.some(value => oldPaths.some(old => path.resolve(old!) === path.resolve(value!)))) {
    throw new Error('新封面必须使用独立版本文件，不能覆盖原视频或封面')
  }
  const receipt = await runBridge<SocialUploadVideoCoverRevision>('update-video-covers',
    { payload: previousPayload, revisedPayload: payload, updateVideoCovers: true },
    { ...options, timeoutMs: 10 * 60_000 }).finally(() => { runtimeCache = null })
  if (!receipt || receipt.verification !== 'original_video_and_revised_covers'
    || [receipt.revisionId, receipt.previousPayloadDigest, receipt.payloadDigest, receipt.videoSha256,
      receipt.landscapeSha256, receipt.portraitSha256].some(value => !/^[a-f0-9]{64}$/.test(value || ''))
    || receipt.revisionId !== receipt.payloadDigest || receipt.previousPayloadDigest === receipt.payloadDigest
    || receipt.result?.targetId !== receipt.targetId || receipt.result?.saved !== false
    || receipt.result?.published !== false || receipt.result?.submitted === true) {
    throw new Error('新版封面缺少可信的原视频绑定和更新回执，禁止重新上传')
  }
  validateResult(receipt.result, false, payload)
  return receipt
}

export async function reconcileSocialUpload(payload: SocialUploadPayload, result: SocialUploadResult, options: SocialUploadProgressOptions & { repairRejectedSave?: boolean } = {}): Promise<SocialUploadResult> {
  const saved = await runBridge<SocialUploadResult>('reconcile', { payload, result, ...(options.repairRejectedSave ? { repairRejectedSave: true } : {}) }, { ...options, timeoutMs: 4 * 60_000 }).finally(() => { runtimeCache = null })
  return validateResult(saved, true, payload)
}

/** Refresh only the already verified article's moderation status, including released local media. */
export async function refreshSocialPublication(payload: SocialUploadPayload, result: SocialUploadResult): Promise<SocialUploadResult> {
  validateResult(result, true, payload)
  if (payload.publicationMode !== 'publish' || !payload.accountName || !result.submitted) throw Error('只允许刷新已提交作品的审核状态')
  const refreshed = validateResult(await runBridge<SocialUploadResult>('refresh-publication', {payload,result}, {timeoutMs: 4 * 60_000}), true, payload)
  if (refreshed.articleId !== result.articleId || refreshed.targetId !== result.targetId || refreshed.accountName !== result.accountName
    || result.published && !refreshed.published) throw Error('审核状态回执与原作品身份不一致')
  return refreshed
}

async function finishUploadAttempt(action: 'close-failed' | 'reset-attempt', payload: SocialUploadPayload,
  allowDuplicateSubmission = false): Promise<{ result?: SocialUploadResult }> {
  const response = await runBridge<{ result?: SocialUploadResult }>(action,
    { payload, ...(action === 'reset-attempt' && allowDuplicateSubmission === true ? { allowDuplicateSubmission: true } : {}) }, { timeoutMs: 75_000 })
    .finally(() => { runtimeCache = null; historyRuntimeCache = null })
  if (!response || typeof response !== 'object') throw new Error('上传尝试处理结果无效')
  return response.result ? { result: validateResult(response.result, true, payload) } : {}
}

export function closeFailedSocialUpload(payload: SocialUploadPayload) {
  return finishUploadAttempt('close-failed', payload)
}

export function resetSocialUploadAttempt(payload: SocialUploadPayload, options: { allowDuplicateSubmission?: boolean } = {}) {
  return finishUploadAttempt('reset-attempt', payload, options.allowDuplicateSubmission === true)
}

export async function focusSocialUpload(payload: SocialUploadPayload, result: SocialUploadResult) {
  return runBridge<{ opened: true }>('focus', { payload, result }, { timeoutMs: 75_000 })
}

export async function reviewSocialUpload(payload: SocialUploadPayload, options: { view?: 'original' | 'content'; input?: SocialUploadReviewInput } = {}): Promise<SocialUploadReview> {
  if (payload.target !== 'baijiahao-video' || !payload.accountName) throw new Error('核对窗口需要任务绑定的百家号账号')
  const result = await runBridge<SocialUploadReview>('review-session', { payload, ...options }, { timeoutMs: 75_000 })
  let validUrl = false
  try {
    const url = new URL(result.url)
    validUrl = url.protocol === 'https:' && ['baijiahao.baidu.com', 'passport.baidu.com', 'wappass.baidu.com', 'verify.baidu.com', 'mbd.baidu.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port
  } catch { /* Reject an unbound or navigated review target. */ }
  if (result.jobId !== payload.jobId || !/^[a-fA-F0-9]{1,128}$/.test(result.targetId || '')
    || options.input && result.targetId !== options.input.targetId || !validUrl
    || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(result.imageDataUrl || '') || result.imageDataUrl.length > 8_000_000
    || !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1
    || result.width > 10000 || result.height > 10000 || typeof result.originalEditor !== 'boolean' || typeof result.message !== 'string')
    throw new Error('核对窗口响应与原任务不一致，请重新打开')
  return result
}
