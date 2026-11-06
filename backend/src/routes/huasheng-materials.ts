import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { getHuashengMaterialOverview, HuashengMaterialUpdateError, startHuashengMaterialUpdate, stopHuashengMaterialUpdate } from '../services/huasheng-material-updates.js'

const emptyCommand = z.object({}).strict()

export function createHuashengMaterialsRoute() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (Object.keys(c.req.query()).length) return c.json({ code: 400, message: '素材库更新不接受 URL 参数' }, 400)
    if (c.req.method !== 'GET') {
      const site = c.req.header('Sec-Fetch-Site')
      const origin = c.req.header('Origin')
      let allowed = !origin
      if (origin) {
        try {
          const url = new URL(origin)
          allowed = url.origin === origin && ['http:', 'https:'].includes(url.protocol)
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        } catch { /* Invalid origins are rejected. */ }
      }
      if (!allowed || site && !['same-origin', 'none'].includes(site)) return c.json({ code: 403, message: '仅允许本地素材库页面管理更新' }, 403)
      if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ code: 400, message: '操作需要空 JSON 对象' }, 400)
      let body: unknown
      try { body = await c.req.json() } catch { return c.json({ code: 400, message: '无效的 JSON 请求' }, 400) }
      if (!emptyCommand.safeParse(body).success) return c.json({ code: 400, message: '操作仅接受空 JSON 对象，统一更新全部项目' }, 400)
    }
    await next()
  })
  function respond(c: Context, action: () => unknown, status: 200 | 202 = 200) {
    try { return c.json({ code: status, data: action(), message: status === 202 ? 'accepted' : 'success' }, status) }
    catch (error) {
      if (error instanceof HuashengMaterialUpdateError) return c.json({ code: error.statusCode, message: error.message }, error.statusCode)
      console.error('[huasheng-materials] API failed:', error instanceof Error ? error.name : 'Unknown error')
      return c.json({ code: 503, message: '素材库状态暂不可用，请稍后刷新；已保存内容保留' }, 503)
    }
  }
  app.get('/', c => respond(c, getHuashengMaterialOverview))
  app.post('/updates', c => respond(c, () => startHuashengMaterialUpdate({}), 202))
  app.post('/updates/:id/stop', c => {
    const value = c.req.param('id')
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return c.json({ code: 400, message: '无效的素材更新任务编号' }, 400)
    return respond(c, () => stopHuashengMaterialUpdate(Number(value)))
  })
  return app
}
