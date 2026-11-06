import { connectHuashengBrowser, HuashengBrowserError, type HuashengBrowserConfig } from './history-huasheng-browser.js'
import { setTimeout as delay } from 'node:timers/promises'

const ORIGIN = 'https://www.huasheng.cn'
const MAX_PROJECTS = 200
const MAX_DETAILS = 10
interface Session { cookie: string; userAgent: string }
export interface HuashengDiscoveryInput {
  jobId: number | string; title: string; script: string; createdAt: string; updatedAt: string
  signal: AbortSignal; browserConfig?: HuashengBrowserConfig; huashengAccountName?: string
}
export interface HuashengDiscoveryResult { projectUrl: string | null; message: string }
type Project = { pid: string | number; script?: string; created_at?: string | number }
const normalized = (text: string) => text.replace(/\r\n/g, '\n').trim()

async function readSession(input: HuashengDiscoveryInput): Promise<Session> {
  const browser = await connectHuashengBrowser(input.browserConfig, input.signal)
  try {
    const cookies = (await browser.defaultBrowserContext().cookies())
      .filter(cookie => ['huasheng.cn', '.huasheng.cn', 'www.huasheng.cn'].includes(cookie.domain))
    if (!cookies.some(cookie => cookie.name === 'SESSDATA' && cookie.value)) {
      throw new HuashengBrowserError('login_required', '花生登录已过期，请在专用窗口重新登录后同步状态')
    }
    input.signal.throwIfAborted()
    return { cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), userAgent: await browser.userAgent() }
  } finally { await browser.disconnect().catch(() => {}) }
}

function plausibleCreation(project: Project, input: HuashengDiscoveryInput) {
  if (project.created_at === undefined || project.created_at === null) return true
  const raw = project.created_at
  const remote = typeof raw === 'number' || /^\d+(?:\.\d+)?$/.test(raw)
    ? Number(raw) * (Number(raw) < 1e12 ? 1000 : 1) : Date.parse(raw)
  // A local task is persisted before its remote create request. Missing/invalid
  // platform timestamps cannot override exact script evidence, but known old projects can.
  return !Number.isFinite(remote) || remote >= Date.parse(input.createdAt) - 5 * 60_000
    && remote <= Date.parse(input.updatedAt) + 10 * 60_000
}

/** Read the existing project list and original metadata. Never creates or confirms a project. */
export async function discoverHuashengProject(input: HuashengDiscoveryInput, options: {
  session?: (input: HuashengDiscoveryInput) => Promise<Session>; fetch?: typeof globalThis.fetch
} = {}): Promise<HuashengDiscoveryResult> {
  input = { ...input, signal: AbortSignal.any([input.signal, AbortSignal.timeout(45_000)]) }
  input.signal.throwIfAborted()
  const auth = await (options.session ?? readSession)(input)
  const request = async (endpoint: string, params: Record<string, string>) => {
    const url = new URL(endpoint, ORIGIN)
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
    let response: Response
    for (let attempt = 0; ; attempt++) {
      try {
        response = await (options.fetch ?? globalThis.fetch)(url, {
          method: 'GET', redirect: 'error', signal: AbortSignal.any([input.signal, AbortSignal.timeout(25_000)]),
          headers: { Cookie: auth.cookie, 'User-Agent': auth.userAgent, Referer: ORIGIN + '/' },
        })
        if (![502, 503, 504].includes(response.status) || attempt >= 2) break
        await response.body?.cancel()
      } catch (error) {
        input.signal.throwIfAborted()
        if (attempt >= 2 || !(error instanceof TypeError || (error as Error)?.name === 'TimeoutError')) throw error
      }
      await delay(250 * (attempt + 1), undefined, { signal: input.signal })
    }
    if (response.status === 401 || response.status === 403) throw new HuashengBrowserError('login_required', '花生会话已过期，请登录后重新同步')
    if (!response.ok) throw new Error(`花生项目同步 HTTP ${response.status}`)
    const envelope = await response.json() as any
    if (envelope?.code !== undefined && ![0, '0'].includes(envelope.code)) {
      if ([-101, -111, 401, 403].includes(Number(envelope.code))) throw new HuashengBrowserError('login_required', '花生会话已过期，请登录后重新同步')
      throw new Error(`花生项目同步返回错误 ${String(envelope.code)}`)
    }
    return envelope?.data ?? envelope
  }
  const projects: Project[] = []
  const seen = new Set<string>()
  let total: number | undefined
  for (let pn = 1; pn <= MAX_PROJECTS / 20; pn++) {
    const page = await request('/api/innovideo/project/list', { pn: String(pn), ps: '20' })
    const pageTotal = Number(page.total)
    if (page.total === null || page.total === undefined || !Number.isSafeInteger(pageTotal) || pageTotal < 0
      || !Array.isArray(page.projects) || page.projects.some((item: Project) => !/^\d+$/.test(String(item?.pid || '')))) throw new Error('花生项目列表不完整，请稍后重新同步')
    if (pageTotal > MAX_PROJECTS) return { projectUrl: null, message: '花生项目超过单次同步的 200 条预算，尚未确认原项目；可绑定已核对的项目链接' }
    if (total !== undefined && total !== pageTotal) throw new Error('同步时花生项目列表发生变化，请重试')
    total = pageTotal
    for (const project of page.projects as Project[]) {
      const pid = String(project.pid)
      if (seen.has(pid)) throw new Error('花生项目列表存在重复记录，请重试')
      seen.add(pid); projects.push(project)
    }
    if (projects.length === total) break
    if (!page.projects.length || projects.length > total || pn === MAX_PROJECTS / 20) throw new Error('花生项目列表提前结束，请稍后重新同步')
  }
  const matching: string[] = []
  const candidates = projects.filter(project => plausibleCreation(project, input)
    && (typeof project.script !== 'string' || normalized(project.script) === normalized(input.script)))
  if (candidates.length > MAX_DETAILS) return { projectUrl: null, message: '待核对花生项目超过单次详情预算，尚未确认唯一原项目；请核对原项目链接' }
  for (const project of candidates) {
    input.signal.throwIfAborted()
    const pid = String(project.pid)
    const info = await request('/api/innovideo/project/info', { pid })
    const original = info?.project as Project | undefined
    if (!original || String(original.pid) !== pid || typeof original.script !== 'string') throw new Error('花生项目原稿信息不完整，尚未确认归属')
    if (normalized(original.script) === normalized(input.script) && plausibleCreation(original, input)) matching.push(`${ORIGIN}/video/${pid}`)
  }
  return matching.length === 1
    ? { projectUrl: matching[0]!, message: '已根据完整原稿核对并找回花生项目，正在同步制作状态' }
    : { projectUrl: null, message: matching.length ? '发现多个完整原稿一致的花生项目，请核对并绑定原项目；未重复创建'
      : '已同步花生项目列表，未找到可确认属于本任务的项目；请核对原项目，未重复创建' }
}
