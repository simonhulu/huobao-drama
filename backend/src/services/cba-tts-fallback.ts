import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, stripVTControlCharacters } from 'node:util'
import type { AIConfig, AIConfigWithId } from './ai.js'
import type { QwenVoiceDetails } from './qwen-tts-voices.js'
import { QWEN_TTS_MODEL, QWEN_TTS_DEFAULT_VOICE, isQwenTTSProvider } from './adapters/qwen-tts.js'

export interface CbaTtsFallbackDependencies {
  getSourceConfig?: (id?: number | null) => AIConfig | null | Promise<AIConfig | null>
  getNarrationConfig?: () => AIConfigWithId | null | Promise<AIConfigWithId | null>
  queryVoice?: (config: AIConfig, voiceId: string) => Promise<QwenVoiceDetails>
  stopped?: () => boolean
  now?: () => string
}
export interface CbaTtsFallbackOptions {
  runId: string
  reason?: string
  /** Only an explicitly authorized operator recovery may override missing historic evidence. */
  authorizedRecovery?: boolean
}
export interface CbaTtsFallbackResult {
  switched: boolean
  eligible: boolean
  reason: string
  failureReason?: string
}
export function paidTtsFailureKind(message: string): 'quota' | 'auth' | undefined {
  if (/\bMiniMax\s*[:：]?\s*(?:1008|2053|2056|2067)\b|已达到\s*Token\s*Plan\s*用量上限|(?:余额|积分|配音额度)不足|insufficient[_ -](?:quota|balance)|quota[_ -]exceeded/i.test(message)) return 'quota'
  if (/\bMiniMax\s*[:：]?\s*(?:1004|2049)\b|\b(?:HTTP|TTS API error|Qwen TTS)\s*(?:401|403)\b|\bunauthorized\b|authentication[_ -]failed|invalid[_ -](?:api[_ -])?key|鉴权失败|认证失败|(?:API\s*Key|API密钥)(?:无效|已失效)/i.test(message)) return 'auth'
  return undefined
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
const exec = promisify(execFile)
function safeReason(value: unknown) {
  return stripVTControlCharacters(String(value)).replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+|\bsk-[A-Za-z0-9._-]+/gi, '[已隐藏]')
    .replace(/(["']?(?:api[_ -]?key|authorization|(?:access[_-]?|refresh[_-]?)?token|secret|password|cookie)["']?\s*[:=]\s*)(?:\[已隐藏\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1[已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/g, '[链接已隐藏]').slice(0, 1800)
}
function currentNarrationFailure(directory: string, job: any): string | undefined {
  try {
    const failure = read(path.join(directory, 'narration-error.json')), journal = read(path.join(directory, 'production.json'))
    const last = journal.attempts?.at(-1)
    if (journal.status !== 'attention' || last?.step !== 'tts' || last.status !== 'failed') return
    const failedAt = Date.parse(failure.failedAt), startedAt = Date.parse(last.startedAt), finishedAt = Date.parse(last.finishedAt)
    if (![failedAt, startedAt, finishedAt].every(Number.isFinite) || failedAt < startedAt || failedAt > finishedAt) return
    const kind = typeof failure.message === 'string' ? paidTtsFailureKind(failure.message) : undefined
    const lastMessage = typeof last.message === 'string' ? last.message : ''
    // Older coordinators discarded the CLI reason. Only a diagnosis written
    // inside that exact failed attempt can supplement the old generic exit.
    const genericExit = /^当前生产步骤退出（\d+），已保留结果和尝试记录$/.test(lastMessage)
    if (!kind || !genericExit && paidTtsFailureKind(lastMessage) !== kind) return
    const segment = job.news?.segments?.find((item: any) => item.id === failure.segmentId && item.mode !== 'original')
    if (!segment || (failure.configId ?? null) !== (job.tts?.configId ?? null)
      || failure.requestDigest !== digest({ text: segment.text, tts: job.tts })) return
    return failure.message
  } catch { return undefined }
}

/** Resume only this persisted migration; verify actual current audio before releasing its block. */
export async function inspectCbaTtsFallback(jobDir: string, stopped: () => boolean = () => false): Promise<{ pending: boolean; reason: string } | null> {
  const file = path.join(jobDir, 'job.json'), original = fs.readFileSync(file, 'utf8'), job = JSON.parse(original)
  const migration = job.automation?.ttsFallback
  if (migration?.version !== 1 || !isQwenTTSProvider(migration.to?.provider) || !migration.to?.tts
    || digest(migration.to.tts) !== digest(job.tts) || !(job.profile?.editions || ['news', 'highlights']).includes('news')) return null
  const state = { pending: true, reason: safeReason(migration.reason || '原始故障原因未记录') }
  for (const segment of (job.news?.segments || []).filter((item: any) => item.mode !== 'original')) {
    if (stopped() || typeof segment.audioPath !== 'string'
      || segment.audioDigest?.request !== digest({ text: segment.text, tts: job.tts })) return state
    try {
      const info = fs.statSync(segment.audioPath)
      if (!info.isFile() || info.size === 0) return state
      const fingerprint = createHash('sha256')
      for await (const chunk of fs.createReadStream(segment.audioPath)) fingerprint.update(chunk)
      if (fingerprint.digest('hex') !== segment.audioDigest?.sha256) return state
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration,sample_rate,channels', '-of', 'json', segment.audioPath],
        { timeout: 30_000, maxBuffer: 1024 * 1024 })
      const probe = JSON.parse(stdout), audio = probe.streams?.find((stream: any) => stream.codec_type === 'audio')
      const duration = Number(audio?.duration ?? probe.format?.duration)
      if (!audio || !Number.isFinite(duration) || duration <= 0 || !(Number(audio.sample_rate) > 0) || !(Number(audio.channels) > 0)) return state
    } catch { return state }
  }
  const current = fs.readFileSync(file, 'utf8')
  if (digest(JSON.parse(current).tts) !== digest(job.tts)) return null
  return { ...state, pending: stopped() || current !== original }
}

/** Change the persisted request, never the provider behind an unchanged audio-cache digest. */
export async function prepareCbaTtsFallback(jobDir: string, options: CbaTtsFallbackOptions,
  deps: CbaTtsFallbackDependencies = {}): Promise<CbaTtsFallbackResult> {
  const directory = path.resolve(jobDir), file = path.join(directory, 'job.json')
  const original = fs.readFileSync(file, 'utf8'), job = JSON.parse(original)
  const skip = (reason: string): CbaTtsFallbackResult => ({ switched: false, eligible: false, reason })
  if (deps.stopped?.()) return skip('生产已停止，未切换配音配置')
  if (job.automation?.ttsFallback || job.tts?.model === QWEN_TTS_MODEL) return skip('当前任务已使用或尝试过备用配音')
  if (!(job.profile?.editions || ['news', 'highlights']).includes('news')
    || !job.news?.segments?.some((segment: any) => segment.mode !== 'original' && segment.text?.trim())) return skip('当前任务无需新闻旁白')
  const evidence = options.reason || currentNarrationFailure(directory, job)
  if (!options.authorizedRecovery && (!evidence || !paidTtsFailureKind(evidence))) return skip('没有当前 MiniMax 账户故障的明确证据')
  const failureReason = safeReason(evidence || '用户授权使用备用恢复；原始失败原因未知')
  const unavailable = (reason: string): CbaTtsFallbackResult => ({ switched: false, eligible: true, reason, failureReason })
  const lockFile = path.join(directory, '.production.lock')
  if (fs.existsSync(lockFile)) {
    const owner = Number(fs.readFileSync(lockFile, 'utf8'))
    let alive = false
    try { if (Number.isSafeInteger(owner) && owner > 0) { process.kill(owner, 0); alive = true } }
    catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH' }
    if (alive) return unavailable('任务生产仍在运行，未切换备用配音')
    fs.unlinkSync(lockFile)
  }
  let lock: number
  try { lock = fs.openSync(lockFile, 'wx'); fs.writeFileSync(lock, String(process.pid)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return unavailable('任务生产仍在运行，未切换备用配音'); throw error }
  try {
    const source = await (deps.getSourceConfig || (async id => {
      const configs = await import('./ai.js')
      return id == null ? configs.getAudioConfig() : configs.getConfigById(id)
    }))(job.tts?.configId)
    if (!source) return unavailable('原配音配置已失效，无法核实 MiniMax 服务身份')
    if (source?.provider?.trim().toLowerCase() !== 'minimax') return skip('当前实际配音服务不是 MiniMax')
    const config = await (deps.getNarrationConfig || (async () => (await import('./ai.js')).getNarrationAudioConfig()))()
    if (!config || !isQwenTTSProvider(config.provider) || !config.settings?.useForNarration
      || !Number.isSafeInteger(config.id) || config.id <= 0 || !config.apiKey?.trim()) return unavailable('未找到已启用且配置完整的 Qwen 旁白服务')
    if (config.model !== QWEN_TTS_MODEL) return unavailable('Qwen 旁白模型与当前适配器不兼容')
    const voice = typeof config.settings.narrationVoiceId === 'string' ? config.settings.narrationVoiceId.trim() : ''
    if (!voice) return unavailable('Qwen 旁白服务尚未选择音色')
    const speed = job.tts?.speed
    if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.5 || speed > 2)) return unavailable('当前配音语速不在 Qwen 支持范围内')
    if (deps.stopped?.()) return unavailable('生产已停止，未切换配音配置')
    if (voice !== QWEN_TTS_DEFAULT_VOICE) {
      const details = await (deps.queryVoice || (async (selected, id) => (await import('./qwen-tts-voices.js')).queryQwenVoice(selected, id)))(config, voice)
      if (details.status !== 'OK' || details.target_model !== config.model) return unavailable('Qwen 复刻音色尚未就绪或与当前模型不兼容')
    }
    if (deps.stopped?.()) return unavailable('生产已停止，未切换配音配置')
    if (fs.readFileSync(file, 'utf8') !== original) return unavailable('检查备用音色期间任务已更新，请从当前稿件继续')
    const previous = job.tts, tts = { configId: config.id, model: config.model, voice, ...(speed === undefined ? {} : { speed }),
      instruction: '以自然、清晰的体育新闻口吻播报，球队、人名和比分读清楚，适度强调关键数据，避免夸张喊叫；只朗读正文，不朗读指令。' }
    const migration = { version: 1, runId: options.runId, appliedAt: deps.now?.() || new Date().toISOString(),
      trigger: options.authorizedRecovery ? 'authorized-recovery' : options.reason ? 'current-failure' : 'persisted-failure', reason: failureReason,
      from: { provider: source.provider, tts: previous }, to: { provider: config.provider, tts },
      previousAudit: job.automation?.audit ?? null, previousReview: job.review ?? null,
      previousApproval: job.approval ?? null, previousOutputs: job.outputs ?? null }
    job.tts = tts
    job.automation = { ...job.automation, requireAudit: true, ttsFallback: migration }
    delete job.automation.audit
    job.review = null; job.approval = null; job.outputs = null; job.status = 'awaiting_review'
    // Old audio stays on disk. Its request digest includes the old TTS config,
    // so every narrated segment is regenerated consistently after reapproval.
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file)
    return { switched: true, eligible: true, reason: '已切换到已核验的 Qwen 旁白配置，将重新独立审核并生成全稿同声配音', failureReason }
  } catch (error) {
    return unavailable(`Qwen 备用配置检查失败：${safeReason(error instanceof Error ? error.message : error)}`)
  } finally {
    fs.closeSync(lock)
    if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile)
  }
}
