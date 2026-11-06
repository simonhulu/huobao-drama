import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readlink, rename, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import puppeteer, { type Browser, type ConnectOptions, type CookieData, type LaunchOptions, type Page } from 'puppeteer-core'
import { z } from 'zod'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ERROR_MESSAGES = {
  storage: '登录会话文件不可用，请检查专用会话目录',
  endpoint: '专用登录浏览器仅允许使用不含凭据的本机地址',
  browser: '专用登录浏览器连接失败，请重新打开登录窗口',
  profile: '该浏览器不是专用抖音登录窗口，未读取登录信息',
  missing_auth: '尚未检测到有效抖音登录，请在专用窗口完成登录后再次检测',
  busy: '采集或登录检测正在使用专用浏览器，请等待当前操作结束后再打开登录窗口',
} as const

export class HistoryBrowserAuthError extends Error {
  constructor(readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code])
    this.name = 'HistoryBrowserAuthError'
  }
}

export type HistoryBrowserSessionStatus = {
  status: 'login_required' | 'waiting_login' | 'session_saved' | 'checking' | 'ready' | 'blocked' | 'error'
  message: string
  updatedAt: string | null
  checkedAt: string | null
  canCollect: boolean
  checks: HistoryBrowserReadinessCheck[]
  engine?: 'chromium' | 'lightpanda'
}

export interface HistoryBrowserReadinessCheck {
  at: string
  stage: string
  message: string
  outcome?: 'pending' | 'passed' | 'failed'
}

export interface HistoryBrowserReadinessRecord {
  engine?: 'chromium' | 'lightpanda'
  status: HistoryBrowserSessionStatus['status']
  message: string
  updatedAt: string
  checkedAt: string | null
  revision: string | null
  checks: HistoryBrowserReadinessCheck[]
}

export interface PreparedHistoryBrowserSession {
  source: 'browser' | 'saved'
  cookies: CookieData[]
}

export interface HistoryBrowserReadinessEvidence {
  message: string
  checks: HistoryBrowserReadinessCheck[]
}

export interface HistoryBrowserAuthOptions {
  storageDirectory?: string
  profileDirectory?: string
  endpoint?: string
  connect?: (options: ConnectOptions) => Promise<Browser>
  launch?: (options: LaunchOptions) => Promise<Browser>
  now?: () => number
  pollMs?: number
  shutdownTimeoutMs?: number
}

export interface HistoryBrowserLoginWaitOptions {
  afterRevision: string | null
  signal: AbortSignal
  reason?: string
}

interface SessionRecord {
  engine?: 'chromium' | 'lightpanda'
  version: 1
  status: 'login_required' | 'waiting_login' | 'session_saved' | 'ready'
  updatedAt: string | null
  revision: string | null
  cookies: CookieData[]
}

const recordSchema = z.object({
  engine: z.enum(['chromium', 'lightpanda']).optional(),
  version: z.literal(1), status: z.enum(['login_required', 'waiting_login', 'session_saved', 'ready']),
  updatedAt: z.string().nullable(), revision: z.string().min(1).nullable(), cookies: z.array(z.unknown()).max(2000),
})
const readinessSchema = z.object({
  engine: z.enum(['chromium', 'lightpanda']).default('lightpanda'),
  status: z.enum(['login_required', 'waiting_login', 'session_saved', 'checking', 'ready', 'blocked', 'error']),
  message: z.string().max(500), updatedAt: z.string().datetime(), checkedAt: z.string().datetime().nullable(),
  revision: z.string().nullable(), checks: z.array(z.object({
    at: z.string().datetime(), stage: z.string().max(80), message: z.string().max(500),
    outcome: z.enum(['pending', 'passed', 'failed']).optional(),
  })).max(20),
})
const cookieSchema = z.object({
  name: z.string().min(1).max(1024), value: z.string().max(32_768), domain: z.string().min(1).max(255),
  path: z.string().max(4096).optional(), secure: z.boolean().optional(), httpOnly: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(), expires: z.number().finite().optional(),
})

export function filterHistoryBrowserSessionCookies(cookies: readonly unknown[], now = Date.now()): CookieData[] {
  return cookies.flatMap(value => {
    if (value && typeof value === 'object' && (('partitionKey' in value && value.partitionKey !== undefined)
      || ('partitionKeyOpaque' in value && value.partitionKeyOpaque === true))) return []
    const parsed = cookieSchema.safeParse(value)
    if (!parsed.success) return []
    const cookie = parsed.data
    const domain = cookie.domain.toLowerCase().replace(/^\./, '')
    if (domain !== 'douyin.com' && !domain.endsWith('.douyin.com')) return []
    if (cookie.expires !== undefined && cookie.expires !== -1 && cookie.expires <= now / 1000) return []
    return [{ ...cookie, ...(cookie.expires === -1 ? { expires: undefined } : {}) }]
  })
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  if (!await safeDirectoryExists(directory)) {
    const parent = path.dirname(directory)
    if (parent !== directory && !await safeDirectoryExists(parent)) await ensurePrivateDirectory(parent)
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new HistoryBrowserAuthError('storage') }
  }
  if (!await safeDirectoryExists(directory)) throw new HistoryBrowserAuthError('storage')
  await chmod(directory, 0o700)
}

async function assertSafeFileTarget(filename: string) {
  try {
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink()) throw new HistoryBrowserAuthError('storage')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HistoryBrowserAuthError('storage')
  }
}

function hasAuthentication(cookies: CookieData[]) {
  return cookies.some(cookie => /^(sessionid|sessionid_ss)$/.test(cookie.name) && cookie.value.trim().length > 0)
}

async function safeDirectoryExists(directory: string): Promise<boolean> {
  const absolute = path.resolve(directory)
  let current = path.parse(absolute).root
  for (const segment of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new HistoryBrowserAuthError('storage')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new HistoryBrowserAuthError('storage')
    }
  }
  return true
}

function publicStatus(record: SessionRecord): HistoryBrowserSessionStatus {
  const status = record.status !== 'waiting_login' && record.engine !== 'chromium' && !hasAuthentication(record.cookies) ? 'login_required' : record.status
  const messages = {
    login_required: '专用 Chromium 登录状态尚未检测', waiting_login: '请在专用 Chromium 窗口完成抖音登录或验证，然后检测登录',
    session_saved: '登录会话已保存，等待采集浏览器验证', ready: '登录会话已通过采集浏览器验证',
  }
  return { engine: 'chromium', status, message: messages[status], updatedAt: record.updatedAt, checkedAt: null, canCollect: false, checks: [] }
}

export function createHistoryBrowserAuth(options: HistoryBrowserAuthOptions = {}) {
  const storageDirectory = path.resolve(options.storageDirectory || process.env.HISTORY_SOURCE_AUTH_DIR || path.join(PROJECT_ROOT, 'data/history-source-auth'))
  const profileDirectory = path.resolve(options.profileDirectory || path.join(PROJECT_ROOT, 'data/history-source-login-profile'))
  const statePath = path.join(storageDirectory, 'session.json')
  const readinessPath = path.join(storageDirectory, 'readiness.json')
  let endpoint: URL
  try {
    endpoint = new URL(options.endpoint || process.env.HISTORY_LOGIN_CDP_URL || 'http://127.0.0.1:9241')
    if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !endpoint.port) throw new Error()
  } catch { throw new HistoryBrowserAuthError('endpoint') }
  const now = options.now || Date.now
  const connect = options.connect || (connectionOptions => puppeteer.connect(connectionOptions))
  const launch = options.launch || (launchOptions => puppeteer.launch(launchOptions))
  let loginBrowser: Browser | undefined
  let loginPage: Page | undefined
  let loginPageBrowser: Browser | undefined
  let browserQueue: Promise<unknown> = Promise.resolve()
  const leasedClients = new Set<Browser>()
  let writeQueue: Promise<unknown> = Promise.resolve()
  const emptyRecord = (): SessionRecord => ({ version: 1, status: 'login_required', updatedAt: null, revision: null, cookies: [] })
  const read = async (): Promise<SessionRecord> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      if (!await safeDirectoryExists(storageDirectory)) return emptyRecord()
      handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || (info.mode & 0o077) || info.size > 2 * 1024 * 1024) throw new HistoryBrowserAuthError('storage')
      const record = recordSchema.parse(JSON.parse(await handle.readFile('utf8')))
      return { ...record, cookies: filterHistoryBrowserSessionCookies(record.cookies, now()) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRecord()
      throw new HistoryBrowserAuthError('storage')
    } finally { await handle?.close() }
  }
  const save = async (record: SessionRecord | HistoryBrowserReadinessRecord, filename = statePath): Promise<void> => {
    const temporaryPath = `${filename}.${randomUUID()}.tmp`
    let created = false
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      await ensurePrivateDirectory(storageDirectory)
      await assertSafeFileTarget(filename)
      handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      await handle.chmod(0o600)
      await handle.writeFile(JSON.stringify(record), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await assertSafeFileTarget(filename)
      await rename(temporaryPath, filename)
    } catch { throw new HistoryBrowserAuthError('storage') }
    finally {
      await handle?.close().catch(() => {})
      if (created) await unlink(temporaryPath).catch(() => {})
    }
  }
  const mutate = <T>(change: (record: SessionRecord) => Promise<{ record: SessionRecord; result: T }>) => {
    const operation = writeQueue.then(async () => {
      const result = await change(await read())
      await save(result.record)
      return result.result
    })
    writeQueue = operation.catch(() => {})
    return operation
  }
  const readReadiness = async (): Promise<HistoryBrowserReadinessRecord | null> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      if (!await safeDirectoryExists(storageDirectory)) return null
      handle = await open(readinessPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      const info = await handle.stat()
      if (!info.isFile() || (info.mode & 0o077) || info.size > 64 * 1024) throw new HistoryBrowserAuthError('storage')
      return readinessSchema.parse(JSON.parse(await handle.readFile('utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new HistoryBrowserAuthError('storage')
    } finally { await handle?.close() }
  }
  const updateHistoryBrowserReadiness = (state: HistoryBrowserReadinessRecord): Promise<HistoryBrowserSessionStatus> => {
    const operation = writeQueue.then(async () => {
      const parsed = readinessSchema.parse({ ...state, checks: state.checks.slice(-20) })
      await save(parsed, readinessPath)
      return getHistoryBrowserSessionStatus()
    })
    writeQueue = operation.catch(() => {})
    return operation
  }
  const verifyDedicatedProfile = async (browser: Browser) => {
    let client: Awaited<ReturnType<ReturnType<Browser['target']>['createCDPSession']>> | undefined
    try {
      client = await browser.target().createCDPSession()
      const result = await client.send('Browser.getBrowserCommandLine')
      const args = result.arguments
      const matching = args.some((argument, index) => argument === `--user-data-dir=${profileDirectory}`
        || (argument === '--user-data-dir' && args[index + 1] === profileDirectory))
      if (!matching) throw new HistoryBrowserAuthError('profile')
      return args.some(argument => argument === '--headless' || argument.startsWith('--headless=')) ? 'headless' as const : 'visible' as const
    } catch { throw new HistoryBrowserAuthError('profile') }
    finally { await client?.detach().catch(() => {}) }
  }
  const serializeBrowser = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = browserQueue.then(operation)
    browserQueue = result.catch(() => {})
    return result
  }
  const bounded = async <T>(operation: Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HistoryBrowserAuthError('browser')), Math.max(1, timeoutMs))
      })])
    } finally { clearTimeout(timer) }
  }
  const connectClient = async (protocolTimeout: number, timeoutMs = protocolTimeout) => {
    let expired = false
    const connecting = connect({ browserURL: endpoint.origin, defaultViewport: null, protocolTimeout })
    void connecting.then(client => { if (expired) void client.disconnect().catch(() => {}) }, () => {})
    try { return await bounded(connecting, timeoutMs) }
    catch (error) { expired = true; throw error }
  }
  const invalidateReadiness = (mode: 'visible' | 'headless') => mutate(async previous => {
    const at = new Date(now()).toISOString()
    const status = mode === 'visible' ? 'waiting_login' as const : 'session_saved' as const
    const record: SessionRecord = { ...previous, engine: 'chromium', status, updatedAt: at, revision: null, cookies: [] }
    await save({ engine: 'chromium', status, message: mode === 'visible'
      ? '请在专用 Chromium 窗口完成登录或验证，再检测后台采集'
      : '后台 Chromium 已切换，需要重新检测实际搜索能力',
    updatedAt: at, checkedAt: null, revision: null, checks: [] }, readinessPath)
    return { record, result: undefined }
  })
  const profileLocked = async () => {
    try {
      const lock = path.join(profileDirectory, 'SingletonLock')
      const info = await lstat(lock)
      if (info.isSymbolicLink()) {
        const owner = await readlink(lock)
        const prefix = `${hostname()}-`
        const pid = owner.startsWith(prefix) ? Number(owner.slice(prefix.length)) : NaN
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) }
          catch (error) {
            // Chromium recovers its own stale lock on launch. Do not remove it
            // ourselves, or assume a foreign host/live process is stopped.
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
          }
        }
      }
      return true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new HistoryBrowserAuthError('storage')
    }
  }
  const waitForStopped = async (deadline: number) => {
    while (Date.now() < deadline) {
      let probe: Browser | undefined
      try { probe = await connectClient(Math.min(1000, deadline - Date.now()), deadline - Date.now()) }
      catch (error) {
        // A timed-out probe cannot prove that the endpoint has stopped.
        if (error instanceof HistoryBrowserAuthError) throw error
      }
      const endpointDown = !probe
      await probe?.disconnect().catch(() => {})
      if (Date.now() >= deadline) throw new HistoryBrowserAuthError('browser')
      if (endpointDown && !await profileLocked()) return
      await delay(Math.min(options.pollMs || 100, Math.max(1, deadline - Date.now())))
    }
    throw new HistoryBrowserAuthError('browser')
  }
  // Only callers holding browserQueue may launch, replace, or attach a leased client.
  const acquireBrowser = async (allowLaunch: boolean, requestedMode?: 'visible' | 'headless'): Promise<Browser> => {
    try {
      if (await safeDirectoryExists(profileDirectory)) await chmod(profileDirectory, 0o700)
      let browser = loginBrowser?.connected ? loginBrowser : undefined
      if (!browser) {
        try { browser = await connectClient(8_000) }
        catch { if (!allowLaunch) throw new HistoryBrowserAuthError('browser') }
      }
      if (browser) {
        let actualMode: 'visible' | 'headless'
        try { actualMode = await verifyDedicatedProfile(browser) }
        catch (error) { await browser.disconnect().catch(() => {}); throw error }
        if (requestedMode && actualMode !== requestedMode) {
          if (leasedClients.size) throw new HistoryBrowserAuthError('busy')
          await invalidateReadiness(requestedMode)
          // Recheck immediately before Browser.close; the configured port may never authorize a different profile.
          await verifyDedicatedProfile(browser)
          const deadline = Date.now() + (options.shutdownTimeoutMs || 10_000)
          try {
            await bounded(browser.close(), deadline - Date.now())
            await waitForStopped(deadline)
          } finally {
            loginBrowser = undefined; loginPage = undefined; loginPageBrowser = undefined
            await browser.disconnect().catch(() => {})
          }
          browser = undefined
        }
      }
      if (!browser) {
        if (!allowLaunch || !requestedMode) throw new HistoryBrowserAuthError('browser')
        if (leasedClients.size) throw new HistoryBrowserAuthError('busy')
        await invalidateReadiness(requestedMode)
        await ensurePrivateDirectory(profileDirectory)
        await waitForStopped(Date.now() + (options.shutdownTimeoutMs || 10_000))
        browser = await launch({
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
          userDataDir: profileDirectory, headless: requestedMode === 'headless', defaultViewport: null,
          debuggingPort: Number(endpoint.port), timeout: 15_000, protocolTimeout: 8_000,
          // Any remote-debugging-* flag suppresses Puppeteer's automatic port flag.
          args: [`--remote-debugging-port=${endpoint.port}`, '--remote-debugging-address=127.0.0.1',
            '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', '--mute-audio'],
        })
        try {
          if (await verifyDedicatedProfile(browser) !== requestedMode) throw new HistoryBrowserAuthError('browser')
        } catch (error) { await browser.disconnect().catch(() => {}); throw error }
      }
      loginBrowser = browser
      return browser
    } catch (error) {
      if (error instanceof HistoryBrowserAuthError) throw error
      throw new HistoryBrowserAuthError('browser')
    }
  }
  const connectHistoryChromiumBrowser = (): Promise<Browser> => serializeBrowser(async () => {
    let client: Browser | undefined
    try {
      await acquireBrowser(true, 'headless')
      client = await connectClient(20_000)
      if (await verifyDedicatedProfile(client) !== 'headless') throw new HistoryBrowserAuthError('browser')
      const leased = client
      leasedClients.add(leased)
      const release = () => { leasedClients.delete(leased) }
      const disconnect = leased.disconnect.bind(leased)
      leased.disconnect = async () => { try { await disconnect() } finally { release() } }
      leased.once?.('disconnected', release)
      if (!leased.connected) { release(); throw new HistoryBrowserAuthError('browser') }
      return leased
    } catch (error) {
      await client?.disconnect().catch(() => {})
      if (error instanceof HistoryBrowserAuthError) throw error
      throw new HistoryBrowserAuthError('browser')
    }
  })
  const getHistoryBrowserSessionStatus = async (): Promise<HistoryBrowserSessionStatus> => {
    const record = await read()
    const base = publicStatus(record)
    const readiness = await readReadiness()
    if (!readiness) return base.status === 'ready' ? { ...base, status: 'session_saved', message: '登录会话需要重新检测' } : base
    if (readiness.engine !== 'chromium') return { ...base, status: base.status === 'waiting_login' ? 'waiting_login'
      : record.revision ? 'session_saved' : 'login_required', message: '采集引擎已切换为持久化 Chromium，请重新检测' }
    if (readiness.status === 'checking' && now() - Date.parse(readiness.updatedAt) > 125_000) {
      return { ...base, status: 'error', message: '上次浏览器检测已中断，请重新检测',
        updatedAt: readiness.updatedAt, checkedAt: readiness.checkedAt, checks: readiness.checks }
    }
    if (readiness.status === 'ready' && base.status === 'waiting_login') {
      return { ...base, checkedAt: readiness.checkedAt, checks: readiness.checks }
    }
    const fresh = readiness.checkedAt !== null && now() - Date.parse(readiness.checkedAt) <= 5 * 60_000
      && now() >= Date.parse(readiness.checkedAt)
    const ready = readiness.status === 'ready' && fresh && readiness.revision === record.revision && record.engine === 'chromium'
      && record.status === 'ready' && record.updatedAt !== null
      && Date.parse(record.updatedAt) <= Date.parse(readiness.checkedAt!)
    return {
      status: readiness.status === 'ready' && !ready ? 'session_saved' : readiness.status,
      message: readiness.status === 'ready' && !ready ? '登录会话需要重新检测' : readiness.message,
      updatedAt: readiness.updatedAt, checkedAt: readiness.checkedAt, canCollect: ready, checks: readiness.checks,
      engine: 'chromium',
    }
  }
  const loadHistoryBrowserSession = async () => {
    const record = await read()
    return hasAuthentication(record.cookies) ? { revision: record.revision, cookies: record.cookies } : { revision: null, cookies: [] }
  }
  const loadHistoryChromiumSession = async (): Promise<{ revision: string | null }> => {
    const record = await read()
    const readiness = await readReadiness()
    return { revision: record.engine === 'chromium' && record.status === 'ready' && readiness?.engine === 'chromium'
      && readiness.status === 'ready' && readiness.revision === record.revision ? record.revision : null }
  }
  return {
    getHistoryBrowserSessionStatus,
    loadHistoryBrowserSession,
    updateHistoryBrowserReadiness,
    connectHistoryChromiumBrowser,
    loadHistoryChromiumSession,
    publishHistoryChromiumSession: async (evidence: HistoryBrowserReadinessEvidence): Promise<{ revision: string; session: HistoryBrowserSessionStatus }> => {
      return mutate(async previous => {
        const at = new Date(now()).toISOString()
        const record: SessionRecord = { ...previous, engine: 'chromium', status: 'ready', updatedAt: at, revision: randomUUID(), cookies: [] }
        const readiness = readinessSchema.parse({ engine: 'chromium', status: 'ready', message: evidence.message, updatedAt: at,
          checkedAt: at, revision: record.revision, checks: evidence.checks.slice(-20) })
        await save(readiness, readinessPath)
        return { record, result: { revision: record.revision!, session: {
          engine: 'chromium', status: 'ready', message: readiness.message, updatedAt: at, checkedAt: at,
          canCollect: true, checks: readiness.checks,
        } } }
      })
    },
    prepareHistoryBrowserSession: (): Promise<PreparedHistoryBrowserSession> => serializeBrowser(async () => {
      let browser: Browser
      try { browser = await acquireBrowser(false) }
      catch (error) {
        if (error instanceof HistoryBrowserAuthError && error.code === 'browser') {
          const saved = await loadHistoryBrowserSession()
          if (saved.revision) return { source: 'saved', cookies: saved.cookies }
        }
        throw error
      }
      try {
        const cookies = filterHistoryBrowserSessionCookies(await browser.defaultBrowserContext().cookies(), now())
        if (!hasAuthentication(cookies)) throw new HistoryBrowserAuthError('missing_auth')
        return { source: 'browser', cookies }
      } catch (error) {
        if (error instanceof HistoryBrowserAuthError) throw error
        throw new HistoryBrowserAuthError('browser')
      }
    }),
    publishHistoryBrowserSession: async (cookies: CookieData[], evidence: HistoryBrowserReadinessEvidence): Promise<{ revision: string; session: HistoryBrowserSessionStatus }> => {
      const filtered = filterHistoryBrowserSessionCookies(cookies, now())
      if (!hasAuthentication(filtered)) throw new HistoryBrowserAuthError('missing_auth')
      return mutate(async () => {
        const at = new Date(now()).toISOString()
        const record: SessionRecord = { version: 1, status: 'ready', updatedAt: at, revision: randomUUID(), cookies: filtered }
        const readiness = readinessSchema.parse({ status: 'ready', message: evidence.message, updatedAt: at,
          checkedAt: at, revision: record.revision, checks: evidence.checks.slice(-20) })
        // session.json is the commit point: pending workers cannot see this revision before metadata is durable.
        await save(readiness, readinessPath)
        return { record, result: { revision: record.revision!, session: {
          status: 'ready' as const, message: readiness.message, updatedAt: at, checkedAt: at,
          canCollect: true, checks: readiness.checks,
        } } }
      })
    },
    openHistoryLoginBrowser: (): Promise<HistoryBrowserSessionStatus> => serializeBrowser(async () => {
      try {
        if (leasedClients.size) throw new HistoryBrowserAuthError('busy')
        const browser = await acquireBrowser(true, 'visible')
        await invalidateReadiness('visible')
        if (!loginPage || loginPageBrowser !== browser || loginPage.isClosed()) {
          loginPage = await browser.defaultBrowserContext().newPage()
          loginPageBrowser = browser
          await loginPage.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {})
        }
        await loginPage.bringToFront()
        return await getHistoryBrowserSessionStatus()
      } catch (error) {
        if (error instanceof HistoryBrowserAuthError) throw error
        throw new HistoryBrowserAuthError('browser')
      }
    }),
    confirmHistoryBrowserLogin: (): Promise<HistoryBrowserSessionStatus> => serializeBrowser(async () => {
      try {
        const browser = await acquireBrowser(false)
        const cookies = filterHistoryBrowserSessionCookies(await browser.defaultBrowserContext().cookies(), now())
        if (!hasAuthentication(cookies)) throw new HistoryBrowserAuthError('missing_auth')
        return await mutate(async () => {
          const record: SessionRecord = { version: 1, status: 'session_saved', updatedAt: new Date(now()).toISOString(), revision: randomUUID(), cookies }
          return { record, result: publicStatus(record) }
        })
      } catch (error) {
        if (error instanceof HistoryBrowserAuthError) throw error
        throw new HistoryBrowserAuthError('browser')
      }
    }),
    waitForHistoryBrowserLogin: async ({ afterRevision, signal }: HistoryBrowserLoginWaitOptions): Promise<{ revision: string }> => {
      signal.throwIfAborted()
      await mutate(async record => {
        signal.throwIfAborted()
        const fresh = record.revision !== null && record.revision !== afterRevision
          && record.engine === 'chromium' && record.status === 'ready'
        return { record: fresh ? record : { ...record, status: 'waiting_login', updatedAt: new Date(now()).toISOString() }, result: undefined }
      })
      while (true) {
        signal.throwIfAborted()
        const saved = await loadHistoryChromiumSession()
        signal.throwIfAborted()
        if (saved.revision && saved.revision !== afterRevision) return { revision: saved.revision }
        await delay(options.pollMs || 500, undefined, { signal })
      }
    },
    markHistoryBrowserSessionReady: async (revision: string): Promise<void> => {
      await mutate(async record => ({
        record: record.revision === revision && record.status !== 'ready' && (record.engine === 'chromium' || hasAuthentication(record.cookies))
          ? { ...record, status: 'ready', updatedAt: new Date(now()).toISOString() } : record,
        result: undefined,
      }))
    },
  }
}

let defaultAuth: ReturnType<typeof createHistoryBrowserAuth> | undefined
const auth = () => defaultAuth ??= createHistoryBrowserAuth()

export const getHistoryBrowserSessionStatus = (): Promise<HistoryBrowserSessionStatus> => auth().getHistoryBrowserSessionStatus()
export const openHistoryLoginBrowser = (): Promise<HistoryBrowserSessionStatus> => auth().openHistoryLoginBrowser()
export const confirmHistoryBrowserLogin = (): Promise<HistoryBrowserSessionStatus> => auth().confirmHistoryBrowserLogin()
export const loadHistoryBrowserSession = (): Promise<{ revision: string | null; cookies: CookieData[] }> => auth().loadHistoryBrowserSession()
export const waitForHistoryBrowserLogin = (options: HistoryBrowserLoginWaitOptions): Promise<{ revision: string }> => auth().waitForHistoryBrowserLogin(options)
export const markHistoryBrowserSessionReady = (revision: string): Promise<void> => auth().markHistoryBrowserSessionReady(revision)
export const prepareHistoryBrowserSession = (): Promise<PreparedHistoryBrowserSession> => auth().prepareHistoryBrowserSession()
export const publishHistoryBrowserSession = (cookies: CookieData[], evidence: HistoryBrowserReadinessEvidence): Promise<{ revision: string; session: HistoryBrowserSessionStatus }> => auth().publishHistoryBrowserSession(cookies, evidence)
export const updateHistoryBrowserReadiness = (state: HistoryBrowserReadinessRecord): Promise<HistoryBrowserSessionStatus> => auth().updateHistoryBrowserReadiness(state)
export const connectHistoryChromiumBrowser = (): Promise<Browser> => auth().connectHistoryChromiumBrowser()
export const loadHistoryChromiumSession = (): Promise<{ revision: string | null }> => auth().loadHistoryChromiumSession()
export const publishHistoryChromiumSession = (evidence: HistoryBrowserReadinessEvidence): Promise<{ revision: string; session: HistoryBrowserSessionStatus }> => auth().publishHistoryChromiumSession(evidence)
