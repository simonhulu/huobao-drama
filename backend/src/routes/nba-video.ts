import fs from 'node:fs'
import { Readable } from 'node:stream'
import { Hono, type Context } from 'hono'
import { z, ZodError } from 'zod'
import { NbaVideoError, NbaVideoService, nbaDeleteSchema, nbaResumeSchema, nbaStartSchema, nbaUploadSchema } from '../services/nba-video.js'
import { cbaAccountsRoutes } from './cba-accounts.js'

function allowedWrite(c: Context) {
  if (['GET', 'HEAD'].includes(c.req.method)) return true
  const site = c.req.header('Sec-Fetch-Site')
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) return false
  const origin = c.req.header('Origin')
  if (!origin) return true
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  } catch { return false }
}
async function body(c: Context) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') || '')) throw new NbaVideoError('请使用 JSON 提交 NBA 操作')
  return c.req.json<unknown>()
}
function id(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value)) throw new NbaVideoError('NBA 任务编号无效')
  return value
}
function result(c: Context, data: unknown, status: 200 | 202 = 200) { return c.json({ code: status, data, message: status === 202 ? 'accepted' : 'success' }, status) }

export function createNbaVideoRoute(options: { service?: NbaVideoService } = {}) {
  const app = new Hono()
  const service = options.service || new NbaVideoService()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (!allowedWrite(c)) return c.json({ code: 403, message: '仅允许本机工作台操作 NBA 任务' }, 403)
    await next()
  })
  app.onError((error, c) => {
    const status = error instanceof NbaVideoError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500
    return c.json({ code: status, message: error instanceof NbaVideoError ? error.message : status === 400 ? '请求参数不正确' : 'NBA 服务暂不可用，请查看服务日志' }, status as any)
  })
  app.get('/', c => result(c, service.overview()))
  app.route('/accounts', cbaAccountsRoutes)
  app.post('/runs', async c => result(c, service.start(nbaStartSchema.parse(await body(c))), 202))
  app.post('/resume', async c => result(c, service.resume(nbaResumeSchema.parse(await body(c))), 202))
  app.post('/uploads', async c => result(c, service.startUpload(nbaUploadSchema.parse(await body(c))), 202))
  app.post('/runs/:id/stop', async c => { await body(c); return result(c, service.stop(id(c.req.param('id')))) })
  app.post('/runs/:id/resume', async c => { z.object({}).strict().parse(await body(c)); return result(c, service.resumeRun(id(c.req.param('id'))), 202) })
  app.put('/settings', async c => result(c, service.settings(await body(c))))
  app.put('/channels', async c => result(c, service.channels(await body(c))))
  app.get('/jobs/:id', c => result(c, service.detail(id(c.req.param('id')))))
  app.patch('/jobs/:id', async c => result(c, service.updateSource(id(c.req.param('id')), await body(c))))
  app.delete('/jobs/:id', async c => {
    const input = nbaDeleteSchema.parse(await body(c))
    return result(c, service.deleteTask(id(c.req.param('id')), input.expectedTitle))
  })
  app.get('/jobs/:id/assets/:kind', c => {
    const file = service.asset(id(c.req.param('id')), c.req.param('kind'))
    const size = fs.statSync(file.path).size
    let selected: { start: number; end: number } | undefined
    const header = c.req.header('Range')
    if (header) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(header)
      const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]))
      const end = match?.[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) === 0)) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } })
      }
      selected = { start, end: Math.min(end, size - 1) }
    }
    const headers = new Headers({ 'Content-Type': file.type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
      'Content-Length': String(selected ? selected.end - selected.start + 1 : size), 'X-Content-Type-Options': 'nosniff' })
    if (selected) headers.set('Content-Range', `bytes ${selected.start}-${selected.end}/${size}`)
    if (c.req.query('download') === '1') headers.set('Content-Disposition', `attachment; filename="${c.req.param('id')}-${c.req.param('kind')}${file.path.slice(file.path.lastIndexOf('.'))}"`)
    return new Response(c.req.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file.path, selected)) as ReadableStream,
      { status: selected ? 206 : 200, headers })
  })
  return app
}
