import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { getHistoryHuashengExportService, HuashengExportError, type HistoryHuashengExportService } from '../services/history-huasheng-export.js'

export interface HistoryHuashengExportRouteOptions { service?: HistoryHuashengExportService }
const enqueue = z.object({ sourceIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(100) }).strict()
const settings = z.object({ enabled: z.boolean() }).strict()
const empty = z.object({}).strict()
function positiveId(value: string) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HuashengExportError('任务或稿件编号无效', 400)
  return Number(value)
}
export function createHistoryHuashengExportRoute(options: HistoryHuashengExportRouteOptions = {}) {
  const app = new Hono()
  const service = () => options.service ?? getHistoryHuashengExportService()
  const guard: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.method !== 'GET') {
      const site = c.req.header('Sec-Fetch-Site')
      const origin = c.req.header('Origin')
      let allowed = !origin
      if (origin) try {
        const url = new URL(origin)
        allowed = url.origin === origin && ['http:', 'https:'].includes(url.protocol)
          && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['3013', '9130', '9131', '5679'].includes(url.port)
      } catch { allowed = false }
      if (!allowed || (site && !['same-origin', 'none'].includes(site))) return c.json({ code: 403, message: '仅允许本地工作台管理花生导出' }, 403)
      if (Object.keys(c.req.query()).length || c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ code: 400, message: '操作需要无 URL 参数的 JSON 请求' }, 400)
      let body: unknown
      try { body = await c.req.json() } catch { return c.json({ code: 400, message: '无效的 JSON 请求' }, 400) }
      const schema = c.req.method === 'PUT' ? settings : c.req.path.endsWith('/resume') ? empty : enqueue
      if (!schema.safeParse(body).success) return c.json({ code: 400, message: '导出操作参数无效' }, 400)
    }
    await next()
  }
  const respond = async (c: Context, action: () => unknown | Promise<unknown>, status: 200 | 202 = 200) => {
    try { return c.json({ code: status, data: await action(), message: status === 202 ? 'accepted' : 'success' }, status) }
    catch (error) {
      if (error instanceof HuashengExportError) return c.json({ code: error.statusCode, message: error.message }, error.statusCode)
      return c.json({ code: 503, message: '花生导出服务暂不可用，原项目和视频保持不变' }, 503)
    }
  }
  app.get('/huasheng/exports', guard, c => respond(c, () => {
    if (Object.keys(c.req.query()).some(key => key !== 'sourceId')) throw new HuashengExportError('查询仅支持 sourceId', 400)
    const value = c.req.query('sourceId')
    return service().overview(value === undefined ? undefined : positiveId(value))
  }))
  app.put('/huasheng/exports/settings', guard, c => respond(c, async () => service().setEnabled(settings.parse(await c.req.json()).enabled)))
  app.post('/huasheng/exports', guard, c => respond(c, async () => service().enqueue(enqueue.parse(await c.req.json()).sourceIds), 202))
  app.post('/huasheng/exports/:id/resume', guard, c => respond(c, () => service().resume(positiveId(c.req.param('id')!)), 202))
  return app
}
