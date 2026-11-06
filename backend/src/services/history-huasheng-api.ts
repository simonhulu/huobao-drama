import { setTimeout as delay } from 'node:timers/promises'
import { HuashengBrowserError, huashengProjectUrl, runHuashengBrowserJob,
  type HuashengBrowserInput, type HuashengErrorCode, type HuashengProductionObservation } from './history-huasheng-browser.js'
import { inspectHuashengProduction, readHuashengCreationSession, readHuashengExportSession, readHuashengProductionSession,
  type HuashengExportSession } from './history-huasheng-export-api.js'

const ORIGIN = 'https://www.huasheng.cn'
const SCHEME = 'A - 素材剪辑成片'
const CREATE_SIGNING_KEY = '31a11ff6'
const normalized = (value: string) => value.replace(/\r\n/g, '\n').trim()

export class HuashengApiError extends HuashengBrowserError {
  constructor(code: HuashengErrorCode, message: string, readonly fallbackSafe = false,
    readonly remoteCode?: number, readonly requestRejected = false, actionNotStarted = false) {
    super(code, message, actionNotStarted)
  }
}

interface ChatRun {
  run_id: string
  first_run?: boolean
  input?: { content?: Array<{ type?: string; text?: { content?: string } }>; extra?: { script?: string } }
  events?: Array<{ event?: string; questions?: Array<{ options?: Array<{ label?: string }> }> }>
}
interface ChatHistory { runs: ChatRun[]; current_state: { is_working: boolean; run_id?: string } }
interface PlanCost { ready: boolean; point?: number; hash?: string }
export interface HuashengProjectApiClient {
  prepareCreate(script: string): Promise<void>
  create(script: string): Promise<{ pid: string; uid?: string }>
  projectScript(pid: string): Promise<string | null>
  projectVoice?(pid: string): Promise<{ id: number; type: number } | null>
  history(pid: string): Promise<ChatHistory>
  run(pid: string, text: string): Promise<string>
  planCost(pid: string, runId: string): Promise<PlanCost>
  confirm(pid: string, runId: string, planHash: string): Promise<void>
  production(projectUrl: string, checkpoint: string, script: string): Promise<HuashengProductionObservation>
}

export function huashengCreateBody(script: string, voiceId: number, at = Date.now(), voiceType = 0) {
  const stamp = String(at)
  const signature = Buffer.from([...CREATE_SIGNING_KEY].map((char, index) =>
    char.charCodeAt(0) ^ stamp.charCodeAt(index % stamp.length))).toString('base64')
  return { name: '', is_denoise: 0, script, voice_id: voiceId, voice_type: voiceType, audio_url: '',
    speech_rate: 1, speech_rate_change: 1, is_agree: 0, is_multi: 0, is_fast: false,
    aspect_ratio: '16:9', llm_model: 25, audio_duration: 0, s: signature, t: at }
}

function pidOf(projectUrl: string): string {
  const url = huashengProjectUrl(projectUrl)
  const pid = url?.split('/').at(-1)
  if (!pid || !Number.isSafeInteger(Number(pid))) throw new HuashengApiError('manual_review', '花生项目编号无效')
  return pid
}

function messageOf(body: any) {
  return typeof body?.message === 'string' ? body.message.replace(/https?:\/\/\S+/g, '[链接]')
    .replace(/(?:_ra|csrf|token|cookie)\s*[:=]\s*\S+/gi, '[会话参数]').slice(0, 200) : '响应格式无效'
}

export async function createHuashengProjectApiClient(input: HuashengBrowserInput, options: {
  session?: typeof readHuashengCreationSession
  productionSession?: typeof readHuashengProductionSession
} = {}): Promise<HuashengProjectApiClient> {
  if (input.voiceId !== undefined && (!Number.isSafeInteger(input.voiceId) || input.voiceId <= 0)
    || input.voiceType !== undefined && (!Number.isSafeInteger(input.voiceType) || input.voiceType < 0 || input.voiceId === undefined)) {
    throw new HuashengApiError('manual_review', '指定的花生音色编号或类型无效，未提交制作')
  }
  let session: HuashengExportSession
  try { session = await (options.session || readHuashengCreationSession)(input) }
  catch (error) {
    input.signal.throwIfAborted()
    const login = error instanceof Error && /登录|账号/.test(error.message)
    const failure = new HuashengApiError(login ? 'login_required' : 'browser_unavailable',
      login ? '花生账号未登录，无法读取接口会话' : '花生接口会话尚未就绪，已保留任务和配音设置', !login)
    if (!login && error && typeof error === 'object' && (error as { code?: string }).code === 'retryable') failure.retryable = true
    throw failure
  }
  let mutationDispatched = false
  let preparedVoiceId: number | undefined
  let preparedVoiceType = 0
  let projectDetails: { pid: string; project: any } | undefined
  let sessionAt = Date.now()
  const refreshAttestation = async (pid: string) => {
    if (Date.now() - sessionAt < 5 * 60_000) return
    let fresh: HuashengExportSession
    try { fresh = await readHuashengExportSession({ ...input, projectUrl: `${ORIGIN}/video/${pid}` }) }
    catch {
      input.signal.throwIfAborted()
      throw new HuashengApiError('browser_unavailable', '花生接口会话更新失败，请稍后从原项目继续', !mutationDispatched,
        undefined, false, true)
    }
    if (fresh.cookie !== session.cookie || fresh.userAgent !== session.userAgent) {
      throw new HuashengApiError('login_required', '花生账号在执行期间变化，接口请求未发送', false,
        undefined, false, true)
    }
    session = fresh
    sessionAt = Date.now()
  }
  const sameSession = async () => {
    let current
    try { current = await (options.productionSession || readHuashengProductionSession)({ ...input, projectUrl: input.projectUrl || `${ORIGIN}/` }) }
    catch { throw new HuashengApiError('login_required', '花生账号登录态无法核验，接口请求未发送', false,
      undefined, false, true) }
    if (current.cookie !== session.cookie || current.userAgent !== session.userAgent) {
      throw new HuashengApiError('login_required', '花生账号在执行期间变化，接口请求未发送', false,
        undefined, false, true)
    }
  }
  const request = async (endpoint: string, params: Record<string, string> = {}, body?: object,
    attested = false): Promise<any> => {
    const targetPid = String(params.pid ?? (body as { pid?: number } | undefined)?.pid ?? '')
    if (attested && /^\d+$/.test(targetPid) && targetPid !== '0') await refreshAttestation(targetPid)
    const url = new URL(endpoint, ORIGIN)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    if (body) url.searchParams.set('csrf', session.csrf)
    if (attested) {
      url.searchParams.set('_ra', session.ra)
      url.searchParams.set('_bs', session.bs)
      url.searchParams.set('_fv', session.fv)
    }
    if (body) await sameSession()
    for (let attempt = 0; ; attempt++) {
      input.signal.throwIfAborted()
      let response: Response
      try {
        if (body) mutationDispatched = true
        response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error',
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]),
          headers: { Cookie: session.cookie, 'User-Agent': session.userAgent,
            Referer: /^\d+$/.test(targetPid) ? `${ORIGIN}/video/${targetPid}` : input.projectUrl || `${ORIGIN}/`, Origin: ORIGIN,
            ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) })
      } catch {
        input.signal.throwIfAborted()
        if (!body && attempt < 2) { await delay(500 * (attempt + 1), undefined, { signal: input.signal }); continue }
        throw new HuashengApiError('browser_unavailable', body
          ? '花生接口请求已发送但响应不明，已保存检查点，不会重复提交'
          : '花生接口读取失败，保留原项目', !mutationDispatched)
      }
      if (response.status === 401 || response.status === 403) {
        throw new HuashengApiError('login_required', '花生账号登录态已失效，保留原项目')
      }
      const result = await response.json().catch(() => null)
      if (!response.ok || !result || typeof result !== 'object') {
        throw new HuashengApiError(body ? 'manual_review' : 'browser_unavailable',
          body ? '花生接口响应不完整，已保留检查点，请核对原项目'
            : `花生接口读取失败（HTTP ${response.status}）`, !mutationDispatched)
      }
      if ([-101, -111, 401, 403].includes(Number(result.code))) {
        throw new HuashengApiError('login_required', '花生账号登录态已失效，保留原项目')
      }
      return result
    }
  }
  const data = (value: any, label: string) => {
    if (value?.code !== 0 || !value.data || typeof value.data !== 'object') {
      throw new HuashengApiError('manual_review', `花生${label}接口返回 ${value?.code ?? '无状态码'}：${messageOf(value)}`,
        false, typeof value?.code === 'number' ? value.code : undefined, typeof value?.code === 'number' && value.code !== 0)
    }
    return value.data
  }
  return {
    async prepareCreate() {
      if (input.voiceId !== undefined) {
        const result = await request('/api/innovideo/voice/clone/list', {}, undefined, true)
        if (result?.code !== undefined && result.code !== 0) data(result, '克隆音色列表')
        const voice = Array.isArray(result?.voices) ? result.voices.find((item: any) => String(item.id) === String(input.voiceId)) : undefined
        // Catalog type 2 is cloned speech; project type 1 is cloned speech, while project type 2 is uploaded audio.
        if (!voice || Number(voice.voice_type) !== 2 || String(voice.state) !== '0'
          || input.voiceType !== undefined && input.voiceType !== 1) {
          throw new HuashengApiError('manual_review', `绑定账号中未找到可用的指定克隆音色 ${input.voiceId}，未使用默认音色代替`)
        }
        preparedVoiceId = input.voiceId
        preparedVoiceType = 1
        return
      }
      const config = await request('/api/innovideo/config', {}, undefined, true)
      const voices = await request('/api/innovideo/material/tts/list', { pn: '1', ps: '200', category_id: '0' }, undefined, true)
      const lastUsed = Number(voices?.last_used_voice_id)
      const voiceId = Number.isSafeInteger(lastUsed) && lastUsed > 0
        && Array.isArray(voices?.materials) && voices.materials.some((voice: any) => Number(voice.id) === lastUsed)
        ? lastUsed : Number(config?.default_voice_id)
      if (!Number.isSafeInteger(voiceId) || voiceId <= 0) {
        throw new HuashengApiError('browser_unavailable', '接口未能读取可用配音，改用原浏览器流程', !mutationDispatched)
      }
      preparedVoiceId = voiceId
    },
    async create(script) {
      if (!preparedVoiceId) throw new HuashengApiError('browser_unavailable', '接口创建参数尚未准备完成', !mutationDispatched,
        undefined, false, true)
      const result = await request('/api/huasheng/project/create', {}, huashengCreateBody(script, preparedVoiceId, Date.now(), preparedVoiceType), true)
      if (result?.code !== 0) {
        throw new HuashengApiError('manual_review', `花生创建项目接口返回 ${result?.code ?? '无状态码'}：${messageOf(result)}`,
          false, typeof result?.code === 'number' ? result.code : undefined,
          typeof result?.code === 'number' && result.code !== 0)
      }
      const created = result.data && typeof result.data === 'object' ? result.data : result
      const pid = String(created.pid ?? '')
      if (!/^\d+$/.test(pid) || !Number.isSafeInteger(Number(pid))) {
        throw new HuashengApiError('manual_review', '花生已响应创建，但项目编号不完整；请核对我的项目')
      }
      return { pid, ...(created.uid === undefined ? {} : { uid: String(created.uid) }) }
    },
    async projectScript(pid) {
      const result = await request('/api/innovideo/project/info', { pid }, undefined, true)
      if (result?.code !== undefined && result.code !== 0) data(result, '项目详情')
      projectDetails = { pid, project: result?.project }
      return typeof result?.project?.script === 'string' ? result.project.script : null
    },
    async projectVoice(pid) {
      if (projectDetails?.pid !== pid) return null
      const id = Number(projectDetails.project?.voice_id), type = Number(projectDetails.project?.voice_type)
      return Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(type) && type >= 0 ? { id, type } : null
    },
    async history(pid) {
      const history = data(await request('/api/agent/project/chat/history', { pid, limit: '20', csrf: session.csrf }), '对话历史')
      if (!Array.isArray(history.runs) || typeof history.current_state?.is_working !== 'boolean') {
        throw new HuashengApiError('manual_review', '花生对话历史结构变化，已保留原项目')
      }
      return history as ChatHistory
    },
    async run(pid, text) {
      const result = data(await request('/api/agent/project/chat/run', { pid },
        { pid: Number(pid), content: [{ type: 'text', text: { content: text } }] }), '发送对话')
      if (typeof result.run_id !== 'string' || !/^[a-f0-9]{32}$/i.test(result.run_id)) {
        throw new HuashengApiError('manual_review', '花生已接收对话但未返回有效 run_id，保留原项目')
      }
      return result.run_id
    },
    async planCost(pid, runId) {
      const plan = await request('/api/agent/project/storyboard/get', { pid, csrf: session.csrf }, undefined, true)
      if (plan?.code !== 0 || !plan.data?.plan) return { ready: false }
      if (plan.data.run_id !== runId || typeof plan.data.hash !== 'string') return { ready: false }
      const cost = await request('/api/huasheng/project_plan/cost', { pid, run_id: runId }, undefined, true)
      if (cost?.code !== 0 || !cost.data || cost.data.is_latest !== true || cost.data.status !== 1
        || cost.data.plan_hash !== plan.data.hash) return { ready: false }
      if (typeof cost.data.point !== 'number' || !Number.isFinite(cost.data.point) || cost.data.point < 0) {
        throw new HuashengApiError('manual_review', '无法读取创作规划书的总预估消耗，已保留原项目')
      }
      return { ready: true, point: cost.data.point, hash: plan.data.hash }
    },
    async confirm(pid, runId, planHash) {
      const result = await request('/api/huasheng/project_plan/confirm', {},
        { pid: Number(pid), run_id: runId, plan_hash: planHash }, true)
      if (result?.code !== 0) {
        throw new HuashengApiError('manual_review', `花生拒绝确认制作（${result?.code ?? '无状态码'}）：${messageOf(result)}`,
          false, typeof result?.code === 'number' ? result.code : undefined,
          typeof result?.code === 'number' && result.code !== 0)
      }
    },
    production: (projectUrl, checkpoint, script) => inspectHuashengProduction({
      projectUrl, checkpoint, script, browserConfig: input.browserConfig, signal: input.signal,
    }),
  }
}

function answered(run: ChatRun | undefined, labels: string[]) {
  const options = run?.events?.flatMap(event => event.event === 'AskQuestion'
    ? event.questions?.flatMap(question => question.options?.map(option => option.label) || []) || [] : []) || []
  return Boolean(run?.events?.some(event => event.event === 'RunPaused') && labels.every(label => options.includes(label)))
}

function inputText(run: ChatRun) {
  return run.input?.content?.find(item => item.type === 'text')?.text?.content
}

export async function driveHuashengApiJob(input: HuashengBrowserInput, client: HuashengProjectApiClient,
  options: { now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; pollMs?: number; timeoutMs?: number } = {}) {
  if (!input.script.trim() || input.script.length > 10_000) {
    throw new HuashengApiError('manual_review', '花生首页文稿需为 1–10000 字符；请调整已保存的二创稿')
  }
  const now = options.now || Date.now
  const sleep = options.sleep || ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }))
  const deadline = now() + (options.timeoutMs ?? 30 * 60_000)
  let checkpoint = input.checkpoint || 'opening'
  let checkpointAt = now()
  let projectUrl = huashengProjectUrl(input.projectUrl)
  if (input.projectUrl && !projectUrl) throw new HuashengApiError('manual_review', '保存的花生项目链接无效')
  const save = async (next: string, message: string, productionStatus?: 'queued' | 'creating') => {
    input.signal.throwIfAborted()
    await input.onCheckpoint({ checkpoint: next, ...(projectUrl ? { projectUrl } : {}), message,
      ...(productionStatus ? { productionStatus } : {}) })
    checkpoint = next
    checkpointAt = now()
  }
  const answer = async (next: string, text: string, message: string) => {
    const previous = checkpoint
    await save(next, message)
    try { await client.run(pidOf(projectUrl!), text) }
    catch (error) {
      if (error instanceof HuashengApiError && (error.actionNotStarted || error.requestRejected)) {
        await save(previous, '花生未接收本次对话回复，可从原项目继续')
      }
      throw error
    }
  }
  if (!projectUrl) {
    if (checkpoint !== 'opening') throw new HuashengApiError('manual_review', '上次创建结果尚未确认，请先找回原项目；不会重复创建')
    await client.prepareCreate(input.script)
    await save('create_pending', '接口正在创建花生项目')
    let created: { pid: string; uid?: string }
    try { created = await client.create(input.script) }
    catch (error) {
      if (error instanceof HuashengApiError && (error.requestRejected || error.actionNotStarted)) {
        await save('opening', error.requestRejected ? `花生拒绝创建：${error.message}` : '创建请求尚未发送，可继续原任务')
      }
      throw error
    }
    projectUrl = `${ORIGIN}/video/${created.pid}`
    await save('created', '花生已接收完整文稿并返回项目，等待制作方案')
    if (input.browserConfig?.expectedUid && created.uid !== input.browserConfig.expectedUid) {
      throw new HuashengApiError('manual_review', '花生创建响应账号与绑定账号不一致；项目链接已保存，请核对原项目')
    }
  }
  const pid = pidOf(projectUrl)
  let ownershipChecked = false
  while (now() < deadline) {
    input.signal.throwIfAborted()
    if (!ownershipChecked) {
      const original = await client.projectScript(pid)
      if (original === null) { await sleep(options.pollMs ?? 2000, input.signal); continue }
      if (normalized(original) !== normalized(input.script)) {
        throw new HuashengApiError('manual_review', '花生项目原稿与当前任务不一致，已停止接口操作')
      }
      if (input.voiceId !== undefined) {
        const voice = await client.projectVoice?.(pid)
        if (!voice || voice.id !== input.voiceId || voice.type !== (input.voiceType ?? 1)) {
          throw new HuashengApiError('manual_review', `花生原项目的音色与指定音色 ${input.voiceId} 不一致，已保留原项目，未继续错误配音`)
        }
      }
      ownershipChecked = true
    }
    if (checkpoint === 'confirm_pending' || checkpoint === 'submitted') {
      const state = await client.production(projectUrl, checkpoint, input.script)
      if (state.status !== 'not_started') {
        await save('submitted', state.message, state.status === 'queued' ? 'queued' : 'creating')
        return { projectUrl, ...(state.status === 'completed' ? { videoUrl: projectUrl } : {}) }
      }
    } else {
      const history = await client.history(pid)
      const first = history.runs.find(run => run.first_run)
      if (first?.input?.extra?.script && normalized(first.input.extra.script) !== normalized(input.script)) {
        throw new HuashengApiError('manual_review', '花生首轮对话文稿与当前任务不一致，已停止接口操作')
      }
      const scheme = history.runs.find(run => inputText(run) === SCHEME)
      const requirements = history.runs.find(run => inputText(run) === '确认')
      if (answered(requirements, ['确认，开始制作', '需要调整']) && !history.current_state.is_working) {
        const cost = await client.planCost(pid, requirements!.run_id)
        if (cost.ready) {
          if (cost.point !== 0) throw new HuashengApiError('manual_review',
            `本次预计消耗 ${cost.point} 点；已保留规划书，请在原项目核对后手动确认`)
          if (!cost.hash) throw new HuashengApiError('manual_review', '花生规划书哈希缺失，未确认制作')
          const previous = checkpoint
          await save('plan_opened', '接口已核对最新创作规划书和零消耗')
          await save('confirm_pending', '正在确认制作，等待平台返回制作进度')
          try { await client.confirm(pid, requirements!.run_id, cost.hash) }
          catch (error) {
            if (error instanceof HuashengApiError && error.remoteCode === 10008) {
              await save('quota_waiting', '花生返回 10008：标准模式每日额度已用完，保留原项目等待额度恢复')
            } else if (error instanceof HuashengApiError && error.actionNotStarted) {
              await save(previous, '确认请求尚未发送，可从原规划书继续')
            }
            throw error
          }
        }
      } else if (answered(scheme, ['确认', '需要修改']) && !history.current_state.is_working) {
        if (['opening', 'created', 'scheme_pending'].includes(checkpoint)) {
          await answer('requirements_pending', '确认', '接口正在确认成片需求')
        }
      } else if (answered(first, [SCHEME, 'B - 素材混合MG动画']) && !history.current_state.is_working) {
        if (['opening', 'created'].includes(checkpoint)) {
          await answer('scheme_pending', SCHEME, '接口正在选择 A - 素材剪辑成片')
        }
      }
    }
    const limit = checkpoint === 'created' ? 180_000 : 120_000
    if (now() - checkpointAt >= limit) {
      throw new HuashengApiError('manual_review', checkpoint === 'confirm_pending'
        ? '确认请求已发送，但尚未观察到制作进度；请检查原项目，不会重复确认'
        : '花生接口对话尚未推进；已保存原项目与步骤，不会重复发送')
    }
    await sleep(options.pollMs ?? 2000, input.signal)
  }
  throw new HuashengApiError('timeout', '等待花生接口响应超时，已保存项目与步骤')
}

export async function runHuashengApiJob(input: HuashengBrowserInput): Promise<{ projectUrl: string; videoUrl?: string }> {
  input.signal.throwIfAborted()
  const client = await createHuashengProjectApiClient(input)
  return driveHuashengApiJob(input, client)
}

/** Keep the UI driver available for an explicit override and for failures before API mutation. */
export async function runHuashengJob(input: HuashengBrowserInput, options: {
  api?: typeof runHuashengApiJob; browser?: typeof runHuashengBrowserJob
} = {}): Promise<{ projectUrl: string; videoUrl?: string }> {
  const browser = options.browser || runHuashengBrowserJob
  // Explicit clone selection stays on the API path, where its id and project type are verified.
  if (process.env.HUASHENG_CREATION_DRIVER === 'browser' && input.voiceId === undefined) return browser(input)
  try { return await (options.api || runHuashengApiJob)(input) }
  catch (error) {
    input.signal.throwIfAborted()
    if (error instanceof HuashengApiError && error.fallbackSafe && input.voiceId === undefined) return browser(input)
    throw error
  }
}
