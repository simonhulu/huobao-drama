import { Hono, type Context } from 'hono'
import { z, ZodError } from 'zod'
import { badRequest, success } from '../utils/response.js'
import { readHistorySourceSettings, writeHistorySourceSettings } from '../services/history-source-settings.js'
import { checkCzgtsConnection, CzgtsSourceError, czgtsCredentials } from '../services/history-source-czgts.js'

export function createHistorySourceSettingsRoute() {
  const app = new Hono()
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
  app.get('/', c => success(c, readHistorySourceSettings()))
  app.put('/', async c => {
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) return badRequest(c, 'A JSON request is required')
    const origin = c.req.header('Origin')
    if (origin) {
      let allowed = false
      try {
        const url = new URL(origin)
        allowed = ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          && ['3013', '9130', '5679'].includes(url.port) && !url.username && !url.password
      } catch { /* Only the local settings page may change collection keywords. */ }
      if (!allowed) return c.json({ code: 403, message: 'Only the local history-script page can change collection settings' }, 403)
    }
    let body: unknown
    try { body = await c.req.json() } catch { return badRequest(c, 'Invalid JSON') }
    try { return success(c, writeHistorySourceSettings(body)) }
    catch (error) {
      if (error instanceof ZodError) return badRequest(c, '请设置 1 至 30 个不重复的关键词或 YouTube 频道；关键词每个 1 至 80 字，频道请使用有效的主页或 videos 链接')
      throw error
    }
  })
  return app
}

interface CzgtsSettingsDependencies {
  credentials: Pick<typeof czgtsCredentials, 'status' | 'save'>
  check: typeof checkCzgtsConnection
}

class SettingsBodyTooLarge extends Error {}

async function readCzgtsJson(c: Context): Promise<unknown> {
  const maximumBytes = 40 * 1024
  const length = c.req.header('Content-Length')
  if (length && /^\d+$/.test(length) && Number(length) > maximumBytes) throw new SettingsBodyTooLarge()
  const reader = c.req.raw.body?.getReader()
  if (!reader) throw new SyntaxError('JSON required')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) throw new SettingsBodyTooLarge()
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function czgtsRouteError(c: Context, error: unknown) {
  if (error instanceof SettingsBodyTooLarge) return c.json({ code: 413, message: '请求内容不能超过 40 KB' }, 413)
  if (error instanceof ZodError || error instanceof SyntaxError) return badRequest(c, '请求 JSON 格式或字段无效')
  if (error instanceof CzgtsSourceError) {
    const codes = { invalid_cookie: 400, login_required: 401, storage: 500, network: 502, upstream: 502, invalid_response: 502, pagination: 502 } as const
    const status = codes[error.code]
    if (status) return c.json({ code: status, message: new CzgtsSourceError(error.code).message }, status)
  }
  return c.json({ code: 500, message: 'CZGTS 配置或连接操作失败，请稍后重试' }, 500)
}

export function createCzgtsSettingsRoute(overrides: Partial<CzgtsSettingsDependencies> = {}) {
  const deps = { credentials: czgtsCredentials, check: checkCzgtsConnection, ...overrides }
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (new URL(c.req.url).search) return badRequest(c, 'CZGTS 接口不接受 URL 查询参数')
    if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(c.req.method)) {
      const origin = c.req.header('Origin')
      const site = c.req.header('Sec-Fetch-Site')
      let allowed = !site || ['same-origin', 'same-site', 'none'].includes(site)
      if (origin) {
        try {
          const url = new URL(origin)
          allowed = allowed && ['http:', 'https:'].includes(url.protocol)
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && ['3013', '9130', '5679'].includes(url.port) && !url.username && !url.password
            && url.pathname === '/' && !url.search && !url.hash
        } catch { allowed = false }
      } else if (site && site !== 'none') allowed = false
      if (!allowed) return c.json({ code: 403, message: '仅允许本地历史脚本页面修改或检测 CZGTS 配置' }, 403)
      if (c.req.header('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return badRequest(c, 'A JSON request is required')
    }
    await next()
  })
  app.onError((error, c) => czgtsRouteError(c, error))
  app.get('/settings', async c => {
    const status = await deps.credentials.status()
    return success(c, { configured: status.configured, updatedAt: status.updatedAt })
  })
  app.put('/settings', async c => {
    const { cookie } = z.object({ cookie: z.string().min(1) }).strict().parse(await readCzgtsJson(c))
    const status = await deps.credentials.save(cookie)
    return success(c, { configured: status.configured, updatedAt: status.updatedAt })
  })
  app.post('/check', async c => {
    z.object({}).strict().parse(await readCzgtsJson(c))
    if (!(await deps.credentials.status()).configured) throw new CzgtsSourceError('login_required')
    const result = await deps.check(c.req.raw.signal)
    const total = z.number().int().nonnegative().safe().parse(result.total)
    return success(c, { configured: true, total, message: `连接成功，最近 24 小时找到 ${total} 篇历史文章` })
  })
  return app
}
