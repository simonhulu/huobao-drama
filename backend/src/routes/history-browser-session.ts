import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { badRequest, success } from '../utils/response.js'
import {
  getHistoryBrowserSessionStatus,
  HistoryBrowserAuthError,
  openHistoryLoginBrowser,
} from '../services/history-source-auth.js'
import { checkHistoryBrowserSession } from '../services/history-source-readiness.js'

export interface HistoryBrowserSessionRouteDependencies {
  getStatus: typeof getHistoryBrowserSessionStatus
  openLogin: typeof openHistoryLoginBrowser
  checkLogin: typeof checkHistoryBrowserSession
}

const emptyCommand = z.object({}).strict()

export function createHistoryBrowserSessionRoute(overrides: Partial<HistoryBrowserSessionRouteDependencies> = {}) {
  const dependencies: HistoryBrowserSessionRouteDependencies = {
    getStatus: getHistoryBrowserSessionStatus,
    openLogin: openHistoryLoginBrowser,
    checkLogin: checkHistoryBrowserSession,
    ...overrides,
  }
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.method === 'POST') {
      if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return badRequest(c, '登录操作需要 JSON 请求')
      }
      const origin = c.req.header('Origin')
      if (origin) {
        let allowed = false
        try {
          const url = new URL(origin)
          allowed = url.origin === origin && ['http:', 'https:'].includes(url.protocol)
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && ['3013', '9130', '9131', '5679'].includes(url.port) && !url.username && !url.password
        } catch { /* Login state must not be controlled by cross-site requests. */ }
        if (!allowed) return c.json({ code: 403, message: '仅允许本地历史脚本页面管理抖音登录' }, 403)
      }
      if (Object.keys(c.req.query()).length) return badRequest(c, '登录操作不接受 URL 参数')
      let body: unknown
      try { body = await c.req.json() } catch { return badRequest(c, '登录操作需要空 JSON 对象') }
      if (!emptyCommand.safeParse(body).success) return badRequest(c, '登录操作仅接受空 JSON 对象')
    }
    await next()
  })
  const respond = async (c: Context, action: HistoryBrowserSessionRouteDependencies['getStatus']) => {
    try { return success(c, { session: await action() }) }
    catch (error) {
      const message = error instanceof HistoryBrowserAuthError ? error.message : '抖音登录服务暂不可用，请稍后重试'
      if (error instanceof HistoryBrowserAuthError && error.code === 'busy') return c.json({ code: 409, message }, 409)
      return c.json({ code: 503, message }, 503)
    }
  }
  app.get('/', c => respond(c, dependencies.getStatus))
  app.post('/open', c => respond(c, dependencies.openLogin))
  app.post('/confirm', c => respond(c, dependencies.checkLogin))
  app.post('/check', c => respond(c, dependencies.checkLogin))
  return app
}
