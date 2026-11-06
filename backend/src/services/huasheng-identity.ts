import type { Browser } from 'puppeteer-core'
import { setTimeout as delay } from 'node:timers/promises'

export interface HuashengIdentity { uid: string; displayName: string }
export class HuashengIdentityError extends Error {
  constructor(readonly code: 'login_required' | 'unavailable' | 'mismatch', message: string, readonly retryable = false) { super(message) }
}

export function validHuashengIdentity(value: unknown): value is HuashengIdentity {
  const identity = value as HuashengIdentity | null
  return Boolean(identity && typeof identity.uid === 'string' && /^[1-9]\d{0,19}$/.test(identity.uid)
    && typeof identity.displayName === 'string' && identity.displayName.trim() && identity.displayName.length <= 100)
}

const unavailable = (message: string, retryable = false) => new HuashengIdentityError('unavailable', message, retryable)
const transientRequest = (error: unknown) => error instanceof TypeError
  || error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)
  || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket|connection closed|timed?\s*out|timeout/i.test(String(error))

async function identityResponse(headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    let response: Response
    try {
      response = await fetch('https://api.huasheng.cn/x/web-interface/nav', {
        method: 'GET', redirect: 'error', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), headers,
      })
    } catch (error) {
      signal?.throwIfAborted()
      if (!transientRequest(error)) throw error
      if (attempt >= 2) throw unavailable('花生身份核验接口连接失败，已尝试 3 次；登录状态尚未确认，请稍后检查账号', true)
      await delay(attempt ? 750 : 250, undefined, { signal })
      continue
    }
    if (![408, 429].includes(response.status) && response.status < 500) return response
    await response.body?.cancel().catch(() => {})
    if (attempt >= 2) throw unavailable(`花生身份核验接口暂不可用（HTTP ${response.status}），已尝试 3 次；请稍后检查账号`, true)
    const retryAfter = response.headers.get('Retry-After')
    const retryMs = retryAfter && /^\d+$/.test(retryAfter) ? Math.min(Number(retryAfter) * 1000, 5000) : 0
    await delay(Math.max(attempt ? 750 : 250, retryMs), undefined, { signal })
  }
}

/** The official nav response identifies the authenticated user, independently of page hydration. */
export async function readHuashengIdentity(browser: Browser, signal?: AbortSignal): Promise<HuashengIdentity> {
  signal?.throwIfAborted()
  try {
    const cookies = (await browser.defaultBrowserContext().cookies())
      .filter(cookie => ['huasheng.cn', '.huasheng.cn', 'api.huasheng.cn', 'www.huasheng.cn'].includes(cookie.domain))
    if (!cookies.some(cookie => cookie.name === 'SESSDATA' && cookie.value)) throw new HuashengIdentityError('login_required', '花生登录已失效，请在此账号的专用窗口重新登录')
    const response = await identityResponse({ Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
      'User-Agent': await browser.userAgent(), Referer: 'https://www.huasheng.cn/', Origin: 'https://www.huasheng.cn' }, signal)
    if (response.status === 401) throw new HuashengIdentityError('login_required', '花生登录已失效，请重新登录')
    if (response.status === 403) throw unavailable('花生拒绝身份核验，请在此账号的专用窗口检查登录或安全验证后重试')
    if (!response.ok) throw unavailable(`花生身份核验接口返回异常（HTTP ${response.status}），请稍后检查账号`)
    const body = await response.json() as { code?: number; data?: { isLogin?: boolean; mid?: number; uname?: string } }
    if (body.code === -101 || body.data?.isLogin === false) throw new HuashengIdentityError('login_required', '花生登录已失效，请重新登录')
    const user = body.data
    if (body.code !== 0 || user?.isLogin !== true || !Number.isSafeInteger(user.mid) || user.mid! <= 0
      || typeof user.uname !== 'string' || !user.uname.trim()) throw new HuashengIdentityError('unavailable', '官网未返回可核验的花生用户身份，请稍后检查')
    const identity = { uid: String(user.mid), displayName: user.uname.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100)
      .replace(/1[3-9]\d{9}/g, phone => `${phone.slice(0, 3)}****${phone.slice(-4)}`) }
    if (!validHuashengIdentity(identity)) throw new HuashengIdentityError('unavailable', '官网花生用户身份格式无效，请稍后检查')
    return identity
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof HuashengIdentityError) throw error
    throw unavailable('暂时无法核验花生账号身份，请稍后检查', transientRequest(error))
  }
}
