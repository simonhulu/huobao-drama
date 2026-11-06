import { Hono } from 'hono'
import { z } from 'zod'
import { badRequest, success } from '../utils/response.js'
import { getHistoryProductionContinuation, HistoryProductionContinuationError, startHistoryProductionContinuation } from '../services/history-production-continuation.js'

const requestBody = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()

function sourceId(value: string) {
  if (!/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function localOrigin(value: string) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && ['3013', '9130', '5679'].includes(url.port) && !url.username && !url.password
  } catch { return false }
}

export function createHistoryProductionContinuationRoute() {
  const app = new Hono()
  app.get('/:id/continuation', c => {
    c.header('Cache-Control', 'no-store')
    const id = sourceId(c.req.param('id'))
    if (!id) return badRequest(c, '稿件编号无效')
    try { return success(c, getHistoryProductionContinuation(id)) }
    catch (error) {
      if (error instanceof HistoryProductionContinuationError) return c.json({ code: error.statusCode, message: error.message }, error.statusCode)
      throw error
    }
  })
  app.post('/:id/continue', async c => {
    c.header('Cache-Control', 'no-store')
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) return badRequest(c, '需要 JSON 请求')
    const origin = c.req.header('Origin')
    if (c.req.header('Sec-Fetch-Site') === 'cross-site' || origin && !localOrigin(origin)) {
      return c.json({ code: 403, message: '仅本地历史稿件页面可以继续生产' }, 403)
    }
    const id = sourceId(c.req.param('id'))
    if (!id) return badRequest(c, '稿件编号无效')
    if (Object.keys(c.req.query()).length) return badRequest(c, '继续生产不接受查询参数')
    let body: unknown
    try { body = await c.req.json() } catch { return badRequest(c, 'JSON 格式无效') }
    const parsed = requestBody.safeParse(body)
    if (!parsed.success) return badRequest(c, '请刷新稿件后重试，继续生产参数无效')
    try {
      const result = startHistoryProductionContinuation(id, parsed.data)
      return c.json({ code: result.complete ? 200 : 202, data: result, message: result.message }, result.complete ? 200 : 202)
    } catch (error) {
      if (error instanceof HistoryProductionContinuationError) return c.json({ code: error.statusCode, message: error.message }, error.statusCode)
      throw error
    }
  })
  return app
}
