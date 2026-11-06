import { Hono } from 'hono'
import { ZodError } from 'zod'
import { success } from '../utils/response.js'
import { exportHistoryArticle, getHistoryArticle, HistoryArticleError, startHistoryArticle, type HistoryArticleOptions } from '../services/history-script-article.js'

function allowedOrigin(origin: string | undefined, requestUrl: string) {
  if (!origin) return true // Non-browser callers do not send ambient browser credentials.
  try {
    const parsed = new URL(origin)
    const request = new URL(requestUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      && ['localhost', '127.0.0.1', '[::1]'].includes(request.hostname)
      && ['3013', '9130', '5679'].includes(parsed.port)
      && parsed.protocol === request.protocol
  } catch { return false }
}

export function createHistoryArticleRoute(options: HistoryArticleOptions = {}) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const value = c.req.param('id') || ''
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new HistoryArticleError('脚本编号无效')
    if (c.req.method === 'POST' && (!allowedOrigin(c.req.header('Origin'), c.req.url) || c.req.header('Sec-Fetch-Site') === 'cross-site')) throw new HistoryArticleError('不允许跨站生成文章', 403)
    await next()
  })
  app.onError((error, c) => {
    const status = error instanceof HistoryArticleError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500
    const message = error instanceof HistoryArticleError ? error.message : status === 400 ? '文章生成参数格式不正确' : '公众号文章操作失败，请稍后重试'
    return c.json({ code: status, message }, status)
  })
  app.get('/', c => success(c, getHistoryArticle(Number(c.req.param('id')), options)))
  app.post('/', async c => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') || '')) throw new HistoryArticleError('请使用 JSON 提交文章生成参数')
    const body = await c.req.text()
    if (body.length > 2048) throw new HistoryArticleError('文章生成参数过长')
    return success(c, startHistoryArticle(Number(c.req.param('id')), JSON.parse(body), options))
  })
  app.get('/export', c => {
    const format = c.req.query('format') || 'html'
    if (!['html', 'markdown'].includes(format) || Object.keys(c.req.query()).some(key => key !== 'format')) throw new HistoryArticleError('导出格式必须是 html 或 markdown')
    const id = Number(c.req.param('id'))
    const body = exportHistoryArticle(id, format as 'html' | 'markdown', options)
    c.header('Content-Type', `${format === 'html' ? 'text/html' : 'text/markdown'}; charset=utf-8`)
    c.header('Content-Disposition', `attachment; filename="history-article-${id}.${format === 'html' ? 'html' : 'md'}"`)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
    return c.body(body)
  })
  return app
}
