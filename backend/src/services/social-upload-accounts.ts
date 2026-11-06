import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { socialUploadConfiguration } from './social-auto-upload.js'

export type AccountStatus = 'login_required' | 'logging_in' | 'ready' | 'expired' | 'error'
export interface SocialUploadAccount {
  accountName: string; label: string; status: AccountStatus; message: string; isDefault: boolean; updatedAt: string
}
export interface AccountLogin {
  id: string; accountName: string; status: 'starting' | 'waiting_scan' | 'ready' | 'failed'
  message: string; qrDataUrl?: string; expiresAt: string
}
type AccountRecord = Omit<SocialUploadAccount, 'isDefault'>
interface AccountState { version: 1; accounts: AccountRecord[]; defaultAccountName: string | null }
interface DriverResult { ready: boolean; message?: string }
export type AccountDriver = (action: 'login' | 'check', accountName: string, onQr?: (dataUrl: string) => void) => Promise<DriverResult>
export interface AccountsOptions { stateRoot?: string; driver?: AccountDriver; now?: () => number; accountPrefix?: 'cba' | 'science' | 'mystery' }
export class SocialUploadAccountError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503 = 409) { super(message) }
}
const script = fileURLToPath(new URL('../../scripts/social-auto-upload/accounts.py', import.meta.url))
const validName = (name: string, prefix: NonNullable<AccountsOptions['accountPrefix']>) => new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(name)
const validQr = (value: unknown): value is string => typeof value === 'string' && value.length < 1_500_000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)

const nativeDriver: AccountDriver = (action, accountName, onQr) => {
  const config = socialUploadConfiguration()
  if (!fs.existsSync(config.python) || !fs.existsSync(path.join(config.root, 'uploader'))) return Promise.reject(new Error('未找到 SAU 登录环境'))
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, [script, action], {
      cwd: config.root, env: { ...process.env, PYTHONPATH: config.root, PYTHONUNBUFFERED: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
    })
    let buffer = '', result: DriverResult | undefined, settled = false, killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(killTimer)
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('账号登录服务未返回结果'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); killTimer.unref()
    }, action === 'login' ? 7 * 60_000 : 90_000)
    timer.unref()
    child.on('error', () => finish(new Error('无法启动 SAU 登录服务')))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n'); buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('SAU_ACCOUNT ')) continue
        try {
          const event = JSON.parse(line.slice(12))
          if (event.type === 'qr' && validQr(event.qrDataUrl)) onQr?.(event.qrDataUrl)
          if (event.type === 'result' && typeof event.ready === 'boolean') result = { ready: event.ready, message: event.ready ? '账号已登录' : '登录未完成或已失效，请重新扫码' }
        } catch { /* Ignore non-protocol output; never expose upstream logs or cookies. */ }
      }
      if (buffer.length > 2_000_000) { buffer = ''; child.kill('SIGTERM') }
    })
    child.on('close', code => finish(code === 0 ? undefined : new Error('登录服务暂不可用，请重新扫码')))
    child.stdin.end(JSON.stringify({ accountName, root: config.root }))
  })
}

export class SocialUploadAccountsService {
  private readonly file: string
  private readonly driver: AccountDriver
  private readonly sessions = new Map<string, AccountLogin>()
  private readonly checking = new Map<string, Promise<SocialUploadAccount>>()
  constructor(private readonly options: AccountsOptions = {}) {
    this.file = path.join(options.stateRoot || socialUploadConfiguration().stateRoot, 'accounts.json')
    this.driver = options.driver || nativeDriver
    const state = this.read()
    let changed = false
    for (const account of state.accounts) if (account.status === 'logging_in') {
      account.status = 'login_required'; account.message = '登录过程已中断，请重新扫码'; account.updatedAt = this.now(); changed = true
    }
    if (changed) this.write(state)
  }
  private now() { return new Date((this.options.now || Date.now)()).toISOString() }
  private read(): AccountState {
    if (!fs.existsSync(this.file)) return { version: 1, accounts: [], defaultAccountName: null }
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as AccountState
    if (state.version !== 1 || !Array.isArray(state.accounts) || state.accounts.some(item => !validName(item.accountName, this.options.accountPrefix ?? 'cba'))) throw new SocialUploadAccountError('账号配置无法读取，请检查本机账号配置', 503)
    return state
  }
  private write(state: AccountState) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(temporary, this.file)
  }
  list() {
    const state = this.read()
    return { accounts: state.accounts.map(item => ({ ...item, isDefault: item.accountName === state.defaultAccountName })), defaultAccountName: state.defaultAccountName }
  }
  get(accountName: string): SocialUploadAccount {
    if (!validName(accountName, this.options.accountPrefix ?? 'cba')) throw new SocialUploadAccountError('账号编号无效', 400)
    const item = this.list().accounts.find(account => account.accountName === accountName)
    if (!item) throw new SocialUploadAccountError('百家号账号不存在，请先添加账号', 404)
    return item
  }
  create(input: { label: string }): SocialUploadAccount {
    const label = typeof input.label === 'string' ? input.label.trim() : ''
    if (!label || Array.from(label).length > 40 || /[\x00-\x1f\x7f]/.test(label)) throw new SocialUploadAccountError('请填写 1–40 字的账号备注', 400)
    const state = this.read()
    if (state.accounts.some(item => item.label === label)) throw new SocialUploadAccountError('已有同名账号，请使用不同备注')
    const accountName = `${this.options.accountPrefix ?? 'cba'}_${randomUUID().replaceAll('-', '')}`
    state.accounts.push({ accountName, label, status: 'login_required', message: '等待扫码登录', updatedAt: this.now() })
    state.defaultAccountName ||= accountName
    this.write(state)
    return this.get(accountName)
  }
  setDefault(accountName: string) {
    this.get(accountName)
    const state = this.read(); state.defaultAccountName = accountName; this.write(state)
    return this.list()
  }
  private update(accountName: string, status: AccountStatus, message: string) {
    const state = this.read(); const account = state.accounts.find(item => item.accountName === accountName)
    if (!account) throw new SocialUploadAccountError('账号不存在', 404)
    Object.assign(account, { status, message, updatedAt: this.now() }); this.write(state)
    return this.get(accountName)
  }
  async check(accountName: string): Promise<SocialUploadAccount> {
    const account = this.get(accountName)
    if (account.status === 'logging_in') return account
    const existing = this.checking.get(accountName)
    if (existing) return existing
    const work = this.driver('check', accountName)
      .then(result => this.update(accountName, result.ready ? 'ready' : 'expired', result.ready ? '账号已登录' : '登录已失效，请重新扫码'))
      .catch(() => this.update(accountName, 'error', '暂时无法检查账号，请稍后重试'))
      .finally(() => this.checking.delete(accountName))
    this.checking.set(accountName, work)
    return work
  }
  startLogin(accountName: string): AccountLogin {
    this.get(accountName)
    if (this.checking.has(accountName)) throw new SocialUploadAccountError('账号正在检查中，请稍后再扫码')
    const previous = [...this.sessions.values()].find(item => item.accountName === accountName && ['starting', 'waiting_scan'].includes(item.status))
    if (previous) return { ...previous }
    for (const [id, session] of this.sessions) {
      if (['ready', 'failed'].includes(session.status) && Date.parse(session.expiresAt) < (this.options.now || Date.now)()) this.sessions.delete(id)
    }
    const session: AccountLogin = {
      id: randomUUID(), accountName, status: 'starting', message: '正在获取登录二维码',
      expiresAt: new Date((this.options.now || Date.now)() + 7 * 60_000).toISOString(),
    }
    this.sessions.set(session.id, session); this.update(accountName, 'logging_in', '正在等待扫码登录')
    void this.driver('login', accountName, qrDataUrl => {
      if (!validQr(qrDataUrl) || session.status === 'ready' || session.status === 'failed') return
      Object.assign(session, { status: 'waiting_scan', message: '请使用百度 App 扫码，并在手机上确认登录', qrDataUrl })
    }).then(result => {
      session.status = result.ready ? 'ready' : 'failed'; session.message = result.ready ? '账号已登录' : '登录未完成，请重新获取二维码'
      this.update(accountName, result.ready ? 'ready' : 'login_required', session.message)
    }).catch(() => {
      session.status = 'failed'; session.message = '登录失败或超时，请重新获取二维码'
      this.update(accountName, 'error', session.message)
    }).finally(() => { delete session.qrDataUrl })
    return { ...session }
  }
  login(id: string): AccountLogin {
    const session = this.sessions.get(id)
    if (!session) throw new SocialUploadAccountError('登录会话已结束，请重新扫码', 404)
    return { ...session }
  }
}

let instance: SocialUploadAccountsService | undefined
export function getSocialUploadAccountsService() { return instance ??= new SocialUploadAccountsService() }
