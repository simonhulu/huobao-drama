import { Hono, type Context } from 'hono'
import { z, ZodError } from 'zod'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { CbaVideoError, CbaVideoService, cbaDeleteSchema, cbaResumeSchema, cbaResumeQueueSchema, cbaStartSchema, cbaUploadSchema, type CbaAssetKind } from '../services/cba-video.js'
import { cbaAccountsRoutes } from './cba-accounts.js'

function allowLocalWrite(c: Context) {
  if (c.req.method === 'GET') return true
  const site = c.req.header('Sec-Fetch-Site')
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) return false
  const origin = c.req.header('Origin')
  if (!origin) return true
  try {
    const value = new URL(origin)
    return ['http:', 'https:'].includes(value.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname) && ['3013', '5679', '9130', '9131'].includes(value.port)
      && !value.username && !value.password && !value.search && !value.hash
  } catch { return false }
}
function body(c: Context) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') || '')) throw new CbaVideoError('请使用 JSON 提交 CBA 操作', 400)
  return c.req.json<unknown>()
}
function id(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value)) throw new CbaVideoError('CBA 任务编号无效', 400)
  return value
}
function response(c: Context, data: unknown, status = 200) { return c.json({ code: status, data, message: status === 202 ? 'accepted' : 'success' }, status as 200 | 202) }
function queryBoolean(value: string | undefined) { if (value !== undefined && value !== 'true' && value !== 'false') throw new CbaVideoError('refresh 必须为 true 或 false', 400); return value === 'true' }
function range(value: string | undefined, size: number) {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) throw new CbaVideoError('Range 请求无效', 416)
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw new CbaVideoError('Range 超出文件范围', 416)
  return { start, end: Math.min(end, size - 1) }
}
export function createCbaVideoRoute(options: { service?: CbaVideoService } = {}) {
  const app = new Hono(); const instance = options.service || new CbaVideoService(); const service = () => instance
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (!allowLocalWrite(c)) return c.json({ code: 403, message: '仅允许本机 CBA 工作台控制生产和上传' }, 403)
    await next()
  })
  app.onError((error, c) => {
    const status = error instanceof CbaVideoError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500
    return c.json({ code: status, message: error instanceof CbaVideoError ? error.message : status === 400 ? '请求格式不正确' : 'CBA 任务服务暂不可用' }, status as any)
  })
  app.route('/accounts', cbaAccountsRoutes)
  app.get('/', c => response(c, service().overview()))
  app.get('/resume-queue', c => response(c, service().resumeQueuePreview()))
  app.post('/resume-queue', async c => response(c, await service().startResumeQueue(cbaResumeQueueSchema.parse(await body(c))), 202))
  app.post('/resume-queue/:queueId/stop', async c => { await body(c); return response(c, service().stopResumeQueue(id(c.req.param('queueId')))) })
  app.get('/runtime', async c => response(c, await service().runtime(queryBoolean(c.req.query('refresh')))))
  app.post('/runtime/login', async c => {
    const value = z.object({ platform: z.enum(['baijiahao', 'tencent']) }).strict().parse(await body(c))
    return response(c, await service().login(value.platform))
  })
  app.post('/runs', async c => response(c, await service().start(cbaStartSchema.parse(await body(c))), 202))
  app.post('/runs/:runId/stop', async c => { await body(c); return response(c, service().stop(id(c.req.param('runId')))) })
  app.get('/jobs/:jobId', c => response(c, service().detail(id(c.req.param('jobId')))))
  app.get('/jobs/:jobId/source-media/:mediaId', c => {
    const file = service().sourceMedia(id(c.req.param('jobId')), id(c.req.param('mediaId')))
    const info = fs.statSync(file.path), selected = range(c.req.header('Range'), info.size)
    const headers = new Headers({ 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Type': file.type,
      'Content-Length': String(selected ? selected.end - selected.start + 1 : info.size) })
    if (selected) headers.set('Content-Range', `bytes ${selected.start}-${selected.end}/${info.size}`)
    return new Response(Readable.toWeb(fs.createReadStream(file.path, selected || undefined)) as ReadableStream,
      { status: selected ? 206 : 200, headers })
  })
  app.post('/jobs/:jobId/resume', async c => response(c, await service().resume(id(c.req.param('jobId')), cbaResumeSchema.parse(await body(c))), 202))
  app.post('/jobs/:jobId/upload', async c => response(c, await service().upload(id(c.req.param('jobId')), cbaUploadSchema.parse(await body(c))), 202))
  app.delete('/jobs/:jobId', async c => response(c, service().deleteTask(id(c.req.param('jobId')), cbaDeleteSchema.parse(await body(c)))))
  app.get('/jobs/:jobId/assets/:kind', c => {
    const kind = c.req.param('kind') as CbaAssetKind
    if (!['news', 'highlights', 'news-cover', 'highlights-cover', 'subtitles'].includes(kind)) throw new CbaVideoError('素材类型无效', 400)
    const file = service().asset(id(c.req.param('jobId')), kind); const info = fs.statSync(file.path); const selected = range(c.req.header('Range'), info.size)
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'Content-Type': file.type,
      'Content-Length': String(selected ? selected.end - selected.start + 1 : info.size),
    })
    if (selected) headers.set('Content-Range', `bytes ${selected.start}-${selected.end}/${info.size}`)
    const stream = fs.createReadStream(file.path, selected || undefined)
    // Explicit adaptation propagates browser cancellation to the file stream;
    // Undici's async-iterator adapter can close an already-cancelled response.
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: selected ? 206 : 200, headers })
  })
  app.get('/jobs/:jobId/manual-template', async c => {
    const template = await service().manualTemplate(id(c.req.param('jobId')))
    const info = fs.statSync(template.path)
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/zip',
      'Content-Length': String(info.size),
      'Content-Disposition': `attachment; filename="${template.filename}"`,
    })
    return new Response(Readable.toWeb(fs.createReadStream(template.path)) as ReadableStream, { headers })
  })
  return app
}
export default createCbaVideoRoute
