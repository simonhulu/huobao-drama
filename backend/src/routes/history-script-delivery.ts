import { Hono, type Context } from 'hono'
import { ZodError } from 'zod'
import { success } from '../utils/response.js'
import { attachHistoryVideo, DeliveryError, getHistoryDelivery, saveHistoryDelivery, startHistoryCovers, startHistoryCoverDesign, reviewHistoryCover } from '../services/history-script-delivery.js'

function videoId(c: Context) {
  const value = c.req.query('video_id')
  if (value === undefined) return undefined
  const id = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0) throw new DeliveryError('成片 ID 无效')
  return id
}

export function createHistoryDeliveryRoute(options: {
  generateDesign?: typeof import('../services/cover-prompt-enhance.js').enhanceCoverPrompt
} = {}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ code: 400, message: 'Invalid script id' }, 400)
    await next()
  })
  app.onError((error, c) => {
    const status = error instanceof DeliveryError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500
    const message = error instanceof ZodError
      ? error.issues.find(issue => (issue.code === 'custom' || issue.code === 'too_big') &&
        (issue.path[0] === 'title' || issue.path[0] === 'baijiahaoTitle' || issue.path[1] === 'main_title'))?.message || '封面或发布信息格式不正确'
      : error.message
    return c.json({ code: status, message }, status)
  })
  app.get('/', c => success(c, getHistoryDelivery(Number(c.req.param('id')), videoId(c))))
  app.put('/', async c => success(c, saveHistoryDelivery(Number(c.req.param('id')), await c.req.json(), videoId(c))))
  app.put('/video', async c => {
    let name: string
    try { name = decodeURIComponent(c.req.header('X-File-Name') || '') } catch { throw new DeliveryError('文件名无效') }
    return success(c, await attachHistoryVideo(Number(c.req.param('id')), c.req.raw.body, name))
  })
  app.post('/design', c => c.json({ code: 202, data: startHistoryCoverDesign(Number(c.req.param('id')), options.generateDesign, {}, videoId(c)), message: 'accepted' }, 202))
  app.post('/design/review', async c => success(c, await reviewHistoryCover(Number(c.req.param('id')), await c.req.json(), undefined, videoId(c))))
  app.post('/covers', async c => success(c, startHistoryCovers(Number(c.req.param('id')), await c.req.json(), undefined, videoId(c))))
  return app
}
