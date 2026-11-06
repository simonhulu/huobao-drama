import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { connectHuashengBrowser, openHuashengBrowser, resolveHuashengBrowserConfig, HuashengBrowserError, type HuashengBrowserConfig, type HuashengBrowserStatus } from './history-huasheng-browser.js'
import { readHuashengIdentity, validHuashengIdentity, HuashengIdentityError, type HuashengIdentity } from './huasheng-identity.js'
import { SocialUploadAccountError, type SocialUploadAccount } from './social-upload-accounts.js'

export const HISTORY_HUASHENG_ACCOUNT = 'history_huasheng_legacy'
export type HuashengAccountScope = 'history' | 'science' | 'mystery'
export interface HuashengAccount extends SocialUploadAccount {
  scope: HuashengAccountScope
  identity: HuashengIdentity | null
  observedIdentity: HuashengIdentity | null
  identityStatus: 'unverified' | 'verified' | 'mismatch' | 'conflict' | 'unavailable'
  checkedAt: string | null
}
interface AccountRecord extends Omit<HuashengAccount, 'isDefault' | 'scope'> { port: number; profile?: string; endpoint?: string }
interface State { version: 1; accounts: AccountRecord[]; defaultAccountName: string | null }
type CheckedHuashengAccount = HuashengAccount & { retryable?: true }
export type HuashengAccountDriver = (action: 'login' | 'check', config: HuashengBrowserConfig, signal?: AbortSignal) => Promise<HuashengBrowserStatus & { identity?: HuashengIdentity }>
export interface HuashengAccountsOptions {
  scope: HuashengAccountScope; stateRoot?: string; peerStateRoot?: string; peerStateRoots?: string[]; legacyConfig?: HuashengBrowserConfig; driver?: HuashengAccountDriver
}
const roots = {
  history: fileURLToPath(new URL('../../../data/history-huasheng/accounts/', import.meta.url)),
  science: fileURLToPath(new URL('../../../data/science-pop/accounts/huasheng/', import.meta.url)),
  mystery: fileURLToPath(new URL('../../../data/mystery-stories/accounts/huasheng/', import.meta.url)),
}
const scopeLabels: Record<HuashengAccountScope, string> = { history: '历史', science: '科普', mystery: '奇闻故事' }
const nativeDriver: HuashengAccountDriver = async (action, config, signal) => {
  if (action === 'login') {
    const result = await openHuashengBrowser(config, signal)
    if (result.status !== 'ready') return result
  }
  const browser = await connectHuashengBrowser(config, signal)
  try { return { status: 'ready', message: '账号身份已核验', identity: await readHuashengIdentity(browser, signal) } }
  finally { await browser.disconnect().catch(() => {}) }
}

/** Workspace ownership and the first verified official user are durable, not process-global switches. */
export class HuashengAccountsService {
  private readonly root: string
  private readonly file: string
  private readonly peerRoots: string[]
  private readonly driver: HuashengAccountDriver
  private readonly pending = new Map<string, { action: 'login' | 'check'; work: Promise<CheckedHuashengAccount> }>()
  private readonly scope: HuashengAccountScope
  constructor(options: HuashengAccountsOptions) {
    this.scope = options.scope
    this.root = path.resolve(options.stateRoot || roots[this.scope])
    this.file = path.join(this.root, 'accounts.json')
    this.peerRoots = [...new Set((options.peerStateRoots || (options.peerStateRoot ? [options.peerStateRoot]
      : !options.stateRoot ? Object.entries(roots).filter(([scope]) => scope !== this.scope).map(([, root]) => root) : [])).map(root => path.resolve(root)))]
    this.driver = options.driver || nativeDriver
    if (this.scope === 'history' && !fs.existsSync(this.file)) {
      const config = resolveHuashengBrowserConfig(options.legacyConfig)
      this.write({ version: 1, defaultAccountName: HISTORY_HUASHENG_ACCOUNT, accounts: [{
        accountName: HISTORY_HUASHENG_ACCOUNT, label: '历史专用账号', port: Number(config.port), endpoint: config.endpoint, profile: config.profile,
        status: 'login_required', message: '请检查历史专用账号的登录与身份', updatedAt: new Date().toISOString(),
        identity: null, observedIdentity: null, identityStatus: 'unverified', checkedAt: null,
      }] })
    }
    const state = this.read()
    let changed = false
    for (const account of state.accounts) if (account.status === 'logging_in') {
      account.status = 'login_required'; account.message = '请打开此账号的专用窗口继续登录并检查账号'; changed = true
    }
    if (changed) this.write(state)
  }
  private validName(name: string) { return this.scope === 'history' ? name === HISTORY_HUASHENG_ACCOUNT : new RegExp(`^${this.scope}_huasheng_[a-f0-9]{32}$`).test(name) }
  private read(): State {
    try {
      if (!fs.existsSync(this.file)) return { version: 1, accounts: [], defaultAccountName: null }
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as State
      if (state.version !== 1 || !Array.isArray(state.accounts)
        || state.accounts.some(item => !this.validName(item.accountName) || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535
          || this.scope !== 'history' && item.port < 9250 || item.identity && !validHuashengIdentity(item.identity)
          || item.observedIdentity && !validHuashengIdentity(item.observedIdentity))
        || new Set(state.accounts.map(item => item.port)).size !== state.accounts.length
        || new Set(state.accounts.map(item => item.accountName)).size !== state.accounts.length
        || state.defaultAccountName !== null && !state.accounts.some(item => item.accountName === state.defaultAccountName)
        || this.scope === 'history' && (state.accounts.length !== 1 || state.defaultAccountName !== HISTORY_HUASHENG_ACCOUNT)) throw new Error('invalid state')
      return state
    } catch { throw new SocialUploadAccountError('花生账号配置无法读取，请检查本机账号设置', 503) }
  }
  private peers(): AccountRecord[] {
    return this.peerRoots.flatMap(root => {
      if (!fs.existsSync(path.join(root, 'accounts.json'))) return []
      try {
        const state = JSON.parse(fs.readFileSync(path.join(root, 'accounts.json'), 'utf8')) as State
        if (state.version !== 1 || !Array.isArray(state.accounts)
          || state.accounts.some(item => !item || typeof item.accountName !== 'string' || !Number.isInteger(item.port)
            || item.identity && !validHuashengIdentity(item.identity) || item.observedIdentity && !validHuashengIdentity(item.observedIdentity))) throw new Error('invalid peer')
        return state.accounts.map(item => ({ ...item, profile: item.profile || path.join(root, 'profiles', item.accountName) }))
      } catch { throw new SocialUploadAccountError('另一工作区的花生账号配置无法读取，暂不执行账号操作', 503) }
    })
  }
  private write(state: State) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }
  list() {
    const state = this.read()
    return { scope: this.scope, accounts: state.accounts.map(({ port: _port, profile: _profile, endpoint: _endpoint, ...account }): HuashengAccount => ({
      ...account, scope: this.scope, isDefault: account.accountName === state.defaultAccountName,
      identity: account.identity || null, observedIdentity: account.observedIdentity || null,
      identityStatus: account.identityStatus || 'unverified', checkedAt: account.checkedAt || null,
      status: account.status === 'ready' && !account.identity ? 'login_required' : account.status,
      message: account.status === 'ready' && !account.identity ? '尚未核验官网用户身份，请检查账号' : account.message,
    })), defaultAccountName: state.defaultAccountName }
  }
  get(accountName: string): HuashengAccount {
    if (!this.validName(accountName)) throw new SocialUploadAccountError('此工作区的花生账号编号无效', 400)
    const account = this.list().accounts.find(item => item.accountName === accountName)
    if (!account) throw new SocialUploadAccountError('此工作区的花生账号不存在，请先添加账号', 404)
    return account
  }
  browserConfig(accountName: string): HuashengBrowserConfig {
    this.get(accountName)
    const account = this.read().accounts.find(item => item.accountName === accountName)!
    const config = { endpoint: account.endpoint || `http://127.0.0.1:${account.port}`, profile: account.profile || path.join(this.root, 'profiles', accountName) }
    const resolved = resolveHuashengBrowserConfig(config)
    if (this.peers().some(peer => peer.port === Number(resolved.port) || peer.profile && path.resolve(peer.profile) === resolved.profile)) {
      throw new SocialUploadAccountError('历史、科普与奇闻故事的花生浏览器配置冲突，请检查专用账号设置')
    }
    return config
  }
  async readyBrowserConfig(accountName: string, options: { open?: boolean; signal?: AbortSignal } = {}): Promise<HuashengBrowserConfig> {
    options.signal?.throwIfAborted()
    const account = await this.run(options.open ? 'login' : 'check', accountName, options.signal)
    options.signal?.throwIfAborted()
    if (account.status !== 'ready' || account.identityStatus !== 'verified' || !account.identity) throw Object.assign(new SocialUploadAccountError(account.message), {
      code: ['login_required', 'expired'].includes(account.status) ? 'login_required'
        : account.identityStatus === 'unavailable' ? 'browser_unavailable' : 'manual_review',
      ...(account.retryable ? { retryable: true } : {}),
    })
    return { ...this.browserConfig(accountName), expectedUid: account.identity.uid }
  }
  create(input: { label: string }): HuashengAccount {
    if (this.scope === 'history') throw new SocialUploadAccountError('历史工作区使用固定的专用花生账号')
    const label = typeof input.label === 'string' ? input.label.trim() : ''
    if (!label || Array.from(label).length > 40 || /[\x00-\x1f\x7f]/.test(label)) throw new SocialUploadAccountError('请填写 1–40 字的账号备注', 400)
    const state = this.read()
    if (state.accounts.some(item => item.label === label)) throw new SocialUploadAccountError('已有同名账号，请使用不同备注')
    const occupied = new Set([...state.accounts, ...this.peers()].map(item => item.port))
    let port = Math.max(9249, ...state.accounts.map(item => item.port)) + 1
    while (occupied.has(port)) port++
    if (port > 65535) throw new SocialUploadAccountError('账号数量已达到本机端口上限')
    const accountName = `${this.scope}_huasheng_${randomUUID().replaceAll('-', '')}`
    state.accounts.push({ accountName, label, port, status: 'login_required', message: `请打开此${scopeLabels[this.scope]}账号的专用窗口登录花生`,
      updatedAt: new Date().toISOString(), identity: null, observedIdentity: null, identityStatus: 'unverified', checkedAt: null })
    state.defaultAccountName ||= accountName
    this.write(state)
    return this.get(accountName)
  }
  setDefault(accountName: string) {
    this.get(accountName)
    const state = this.read(); state.defaultAccountName = accountName; this.write(state)
    return this.list()
  }
  private update(accountName: string, patch: Partial<AccountRecord>) {
    const state = this.read(), account = state.accounts.find(item => item.accountName === accountName)!
    Object.assign(account, patch, { updatedAt: new Date().toISOString() })
    this.write(state)
    return this.get(accountName)
  }
  private waitFor(work: Promise<CheckedHuashengAccount>, signal?: AbortSignal): Promise<CheckedHuashengAccount> {
    if (!signal) return work
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      work.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    })
  }
  private run(action: 'login' | 'check', accountName: string, signal?: AbortSignal): Promise<CheckedHuashengAccount> {
    signal?.throwIfAborted()
    this.get(accountName)
    const existing = this.pending.get(accountName)
    if (existing) return this.waitFor(existing.action === action ? existing.work
      : existing.work.catch(() => {}).then(() => this.run(action, accountName, signal)), signal)
    const config = this.browserConfig(accountName)
    if (action === 'login' && !signal) this.update(accountName, { status: 'logging_in', message: '正在打开此账号的花生专用窗口' })
    const work = Promise.resolve().then(() => this.driver(action, config, signal)).then(result => {
      signal?.throwIfAborted()
      const checkedAt = new Date().toISOString()
      if (result.status !== 'ready') return this.update(accountName, { status: result.status === 'unavailable' ? 'error' : 'login_required',
        identityStatus: 'unavailable', observedIdentity: null, checkedAt,
        message: result.status === 'login_required' ? '请在此账号的专用窗口完成登录，再检查账号' : '专用浏览器未连接，请打开登录窗口' })
      if (!validHuashengIdentity(result.identity)) return this.update(accountName, { status: 'error', identityStatus: 'unavailable',
        observedIdentity: null, checkedAt, message: '尚未取得官网用户身份，无法确认账号有效，请重新检查' })
      const identity = result.identity, account = this.get(accountName)
      if (account.identity && account.identity.uid !== identity.uid) return this.update(accountName, { status: 'error', identityStatus: 'mismatch',
        observedIdentity: identity, checkedAt, message: '当前登录用户与绑定的花生账号不一致，请登录原账号；原任务和检查点已保留' })
      if ([...this.peers(), ...this.read().accounts.filter(item => item.accountName !== accountName)]
        .some(peer => peer.identity?.uid === identity.uid || peer.observedIdentity?.uid === identity.uid)) return this.update(accountName, {
        status: 'error', identityStatus: 'conflict', observedIdentity: identity, checkedAt,
        message: '此花生用户已绑定其他专用账号（历史、科普或奇闻故事），请在专用窗口登录另一个账号',
      })
      return this.update(accountName, { status: 'ready', identityStatus: 'verified', identity, observedIdentity: identity, checkedAt,
        message: `${scopeLabels[this.scope]}专用账号有效，官网用户身份一致` })
    }).catch(error => {
      signal?.throwIfAborted()
      const account = this.update(accountName, { status: error instanceof HuashengIdentityError && error.code === 'login_required' ? 'expired' : 'error',
      identityStatus: 'unavailable', observedIdentity: null, checkedAt: new Date().toISOString(),
      message: error instanceof HuashengIdentityError ? error.message : '无法连接此账号的专用浏览器，请打开登录窗口后检查账号' })
      const retryable = error instanceof HuashengIdentityError && error.code === 'unavailable' && error.retryable
        || error instanceof HuashengBrowserError && error.code === 'browser_unavailable' && error.retryable
      return retryable ? { ...account, retryable: true as const } : account
    })
      .finally(() => { if (this.pending.get(accountName)?.work === work) this.pending.delete(accountName) })
    this.pending.set(accountName, { action, work })
    return this.waitFor(work, signal)
  }
  openLogin(accountName: string) { return this.run('login', accountName) }
  check(accountName: string) { return this.run('check', accountName) }
}

let history: HuashengAccountsService | undefined
export function getHistoryHuashengAccountsService() { return history ??= new HuashengAccountsService({ scope: 'history' }) }
