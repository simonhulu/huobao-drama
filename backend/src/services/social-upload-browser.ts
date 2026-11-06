import { execFile, spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

export interface SocialUploadBrowserOptions {
  endpoint: string | URL
  profileDir: string
  starter: string
  portVar: string
  projectRoot: string
}

export interface SocialUploadBrowserDependencies {
  readJson(url: string, timeoutMs: number): Promise<unknown>
  exec(file: string, args: string[], timeoutMs: number): Promise<string>
  start(script: string, options: { cwd: string; env: NodeJS.ProcessEnv }): { error?: Error }
  signal(pid: number, signal: 'SIGTERM' | 0): void
  realpath(file: string): Promise<string>
  now(): number
  sleep(ms: number): Promise<void>
}

const native: SocialUploadBrowserDependencies = {
  async readJson(url, timeoutMs) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`CDP 响应 HTTP ${response.status}`)
    return response.json()
  },
  exec(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
        if (error && !(file === '/usr/sbin/lsof' && error.code === 1 && !stdout.trim() && !stderr.trim())) {
          reject(new Error(`${path.basename(file)} 检查失败：${error.message}`))
        } else resolve(stdout)
      })
    })
  },
  start(script, options) {
    const state: { error?: Error } = {}
    const child = spawn(process.execPath, [script], { ...options, detached: true, stdio: 'ignore' })
    child.on('error', error => { state.error = new Error(`无法启动专用 Chrome：${error.message}`) })
    child.on('exit', (code, signal) => {
      // The Baijiahao starter exits successfully after detaching Chrome.
      if (code !== 0) state.error = new Error(`Chrome 启动脚本退出（${code ?? signal}）`)
    })
    child.unref()
    return state
  },
  signal: (pid, signal) => { process.kill(pid, signal) },
  realpath,
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const configurations: Record<string, { profile: string; portVar: string }> = {
  'start-wechat-channels-cdp-chrome.mjs': { profile: 'wechat-channels-profile', portVar: 'WECHAT_CHANNELS_CDP_PORT' },
  'start-baijiahao-cdp-chrome.mjs': { profile: 'baijiahao-profile', portVar: 'BAIJIAHAO_CDP_PORT' },
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Call only from an explicit login action. Never invoke from runtime inspection or queue polling. */
export async function ensureSocialUploadBrowser(options: SocialUploadBrowserOptions, deps: SocialUploadBrowserDependencies = native): Promise<void> {
  const endpoint = new URL(options.endpoint)
  const port = endpoint.port
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\d+$/.test(port) || Number(port) < 1024) {
    throw new Error('平台浏览器必须使用本机 127.0.0.1 的有效 CDP 端口')
  }
  const root = path.resolve(options.projectRoot)
  const profile = path.resolve(options.profileDir)
  const name = path.basename(options.starter)
  const config = configurations[name]
  const script = path.resolve(root, 'backend/scripts', options.starter)
  if (!config || script !== path.join(root, 'backend/scripts', name)
    || profile !== path.join(root, 'data', config.profile) || options.portVar !== config.portVar) {
    throw new Error('starter、profile 或端口变量不属于本项目专用 Chrome 配置')
  }
  const url = `${endpoint.origin}/json/list`
  const targets = async (timeoutMs = 1500): Promise<Array<{ type?: string }>> => {
    const value = await deps.readJson(url, timeoutMs)
    if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object')) throw new Error('CDP /json/list 响应不是有效目标列表')
    return value
  }
  const hasPage = (items: Array<{ type?: string }>) => items.some(item => item.type === 'page')
  const requireEmpty = (items: unknown[]) => {
    if (items.length) throw new Error('浏览器已有非页面 target，保留现有进程，请人工检查')
  }
  const listeners = async () => {
    const output = await deps.exec('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 2000)
    const lines = output.trim() ? output.trim().split(/\s+/) : []
    if (lines.some(value => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 1)) throw new Error('监听进程 PID 响应无效，未操作浏览器')
    return [...new Set(lines.map(Number))]
  }
  const owner = async () => {
    const pids = await listeners()
    if (pids.length !== 1) throw new Error('无法确认唯一监听 PID，未操作浏览器')
    const pid = pids[0]!
    const command = (await deps.exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], 2000)).trim()
    // ps does not quote paths with spaces. Split at flag boundaries and compare
    // whole values; ambiguous commands and duplicate flags fail closed.
    const [executable, ...args] = command.split(/\s+(?=--)/)
    const profiles = args.filter(arg => /^--user-data-dir(?:=|\s|$)/.test(arg))
    const ports = args.filter(arg => /^--remote-debugging-port(?:=|\s|$)/.test(arg))
    if (/[\r\n]/.test(command) || executable !== chrome || args.some(arg => /^--type(?:=|\s|$)/.test(arg))
      || profiles.length !== 1 || profiles[0] !== `--user-data-dir=${profile}`
      || ports.length !== 1 || ports[0] !== `--remote-debugging-port=${port}`) {
      throw new Error(`监听 PID ${pid} 不精确匹配本项目专用 Chrome、profile 和端口，未操作浏览器`)
    }
    return pid
  }

  let current: Array<{ type?: string }> | undefined
  try { current = await targets() }
  catch (error) {
    if ((await listeners()).length) throw new Error(`CDP 目标检查失败，保留现有浏览器：${message(error)}`)
  }
  if (current) {
    if (hasPage(current)) return
    requireEmpty(current)
    const actualRoot = await deps.realpath(root)
    if (await deps.realpath(profile) !== path.join(actualRoot, 'data', config.profile)) throw new Error('profile 实际目录不属于本项目，未操作浏览器')
    const pid = await owner()
    if (await owner() !== pid) throw new Error('监听 PID 已变化，未操作浏览器')
    const latest = await targets()
    if (hasPage(latest)) return
    requireEmpty(latest)
    deps.signal(pid, 'SIGTERM')
    const deadline = deps.now() + 5000
    for (;;) {
      try { deps.signal(pid, 0) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
        throw new Error(`无法确认专用 Chrome PID ${pid} 已退出：${message(error)}`)
      }
      if (deps.now() >= deadline) throw new Error(`专用 Chrome 退出超时（5000ms），PID ${pid} 仍存在，未重新启动`)
      await deps.sleep(Math.min(250, deadline - deps.now()))
    }
    if ((await listeners()).length) throw new Error(`CDP 端口 ${port} 已被占用，未重新启动`)
  }

  const starter = deps.start(script, { cwd: path.join(root, 'backend'), env: { ...process.env, [options.portVar]: port } })
  const deadline = deps.now() + 10_000
  let last = '尚无 page target'
  while (deps.now() < deadline) {
    if (starter.error) throw starter.error
    try {
      if (hasPage(await targets(Math.min(1500, deadline - deps.now())))) return
      last = '尚无 page target'
    } catch (error) { last = message(error) }
    if (starter.error) throw starter.error
    const remaining = deadline - deps.now()
    if (remaining > 0) await deps.sleep(Math.min(250, remaining))
  }
  throw new Error(`专用 Chrome 启动超时（10000ms）：${last}；未自动重启，请检查浏览器后重试登录`)
}
