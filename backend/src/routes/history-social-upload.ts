import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z, ZodError } from 'zod'
import {
  getHistorySocialUploadService, historySocialUploadInputSchema, historySocialMarkUploadedSchema, HistorySocialUploadError,
  type HistorySocialUploadService,
} from '../services/history-social-upload.js'
import { isHistorySubmissionReceipt } from '../services/history-production-state.js'

const requestIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const commandSchema = z.union([z.object({}).strict(), z.object({ confirmSave: z.literal(true) }).strict()])
function positiveId(value: string | undefined) {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new HistorySocialUploadError('项目或任务编号无效', 400)
  return Number(value)
}
function allowedOrigin(origin: string | undefined, requestUrl: string) {
  if (!origin) return true
  try {
    const value = new URL(origin)
    const request = new URL(requestUrl)
    return ['http:', 'https:'].includes(value.protocol) && value.protocol === request.protocol
      && !value.username && !value.password && value.pathname === '/' && !value.search && !value.hash
      && ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)
      && ['localhost', '127.0.0.1', '[::1]'].includes(request.hostname)
      && ['3013', '5679', '9130', '9131'].includes(value.port)
  } catch { return false }
}
async function json(c: Context) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') || '')) throw new HistorySocialUploadError('请使用 JSON 提交上传参数', 400)
  return c.req.json<unknown>()
}
function queries(c: Context, allowed: string[]) {
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (!allowed.includes(key) || values.length !== 1) throw new HistorySocialUploadError('上传查询参数无效', 400)
  }
  return c.req.query()
}
function booleanQuery(value: string | undefined) {
  if (value !== undefined && value !== 'true' && value !== 'false') throw new HistorySocialUploadError('刷新参数必须为 true 或 false', 400)
  return value === 'true'
}
function httpItem(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const item = value as Record<string, unknown>
  const unresolvedPublication = item.mode === 'publish' && (
    item.status === 'completed' && !isHistorySubmissionReceipt(item.result)
    || item.status === 'canceled' && item.publicationAttempted === true)
  return { ...item,
    ...(typeof item.sourceId === 'number' ? { scriptId: item.sourceId } : {}),
    ...(typeof item.sourceTitle === 'string' ? { title: item.sourceTitle } : {}),
    ...(unresolvedPublication ? { status: 'uncertain', message: '原发表结果缺少有效提交回执，请核对原任务' }
      : item.status === 'completed' ? { status: item.mode === 'publish'
      ? (item.result as { published?: boolean } | null)?.published ? 'published' : 'submitted' : 'saved' }
      : item.status === 'canceled' ? { status: 'cancelled' } : {}),
  }
}
function httpData(value: unknown) {
  const data = value as Record<string, unknown>
  return { ...data,
    ...(Array.isArray(data.items) ? { items: data.items.map(httpItem) } : {}),
    ...(Array.isArray(data.jobs) ? { jobs: data.jobs.map(httpItem) } : {}),
    ...(data.job ? { job: httpItem(data.job) } : {}),
  }
}

export function createHistorySocialUploadRoute(options: {
  service?: HistorySocialUploadService
  continueVideo?: (sourceId: number, videoId: number, expectedScriptSha256: string) => Promise<unknown>
} = {}) {
  const app = new Hono()
  const service = () => options.service ?? getHistorySocialUploadService()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.method === 'POST' && (!allowedOrigin(c.req.header('Origin'), c.req.url)
      || c.req.header('Sec-Fetch-Site') === 'cross-site'
      || (!c.req.header('Origin') && c.req.header('Sec-Fetch-Site') === 'same-site'))) throw new HistorySocialUploadError('不允许跨站操作上传队列', 403)
    await next()
  })
  app.use('*', bodyLimit({ maxSize: 32_768, onError: c => c.json({ code: 400, message: '上传参数过长' }, 400) }))
  app.onError((error, c) => {
    const status = error instanceof HistorySocialUploadError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500
    return c.json({ code: status, message: error instanceof HistorySocialUploadError ? error.message
      : status === 400 ? '上传参数格式不正确' : '上传队列操作失败，请稍后重试' }, status)
  })
  const ok = (c: Context, data: unknown) => c.json({ code: 200, data: httpData(data), message: 'success' })
  app.get('/candidates', c => {
    const query = queries(c, ['sourceIds'])
    const ids = query.sourceIds?.split(',')
    if (ids && ids.length > 100) throw new HistorySocialUploadError('每次最多读取100个稿件的状态', 400)
    return ok(c, { items: service().candidates(ids?.map(positiveId)) })
  })
  app.get('/sources/:sourceId/state', async c => {
    queries(c, [])
    const sourceId = positiveId(c.req.param('sourceId'))
    const production = await service().productionState(sourceId)
    return ok(c, { production, jobs: service().listJobs(sourceId), queue: service().queueState() })
  })
  app.post('/versions/:videoId/continue', async c => {
    queries(c, [])
    const videoId = positiveId(c.req.param('videoId'))
    const body = z.object({ sourceId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      expectedScriptSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await json(c))
    try {
      const resume = options.continueVideo ?? (await import('../services/history-video-publication.js')).continueHistoryVideoPublication
      const result = await resume(body.sourceId, videoId, body.expectedScriptSha256)
      return c.json({ code: 202, data: httpData(result), message: 'accepted' }, 202)
    } catch (error) {
      const status = (error as { status?: unknown })?.status
      if (error instanceof Error && (status === 400 || status === 404 || status === 409)) {
        throw new HistorySocialUploadError(error.message, status)
      }
      throw error
    }
  })
  app.post('/mark-uploaded', async c => ok(c, await service().markUploaded(historySocialMarkUploadedSchema.parse(await json(c)))))
  app.get('/preflight', async c => {
    const query = queries(c, ['sourceIds', 'targets', 'mode', 'videoIds', 'refreshRuntime'])
    const ids = (query.sourceIds || '').split(',')
    if (ids.length > 100) throw new HistorySocialUploadError('每次最多选择 100 个项目', 400)
    const input = historySocialUploadInputSchema.parse({ sourceIds: ids.map(positiveId), targets: (query.targets || '').split(','), mode: query.mode,
      ...(query.videoIds !== undefined ? { videoIds: query.videoIds.split(',').map(positiveId) } : {}) })
    return ok(c, await service().preflight(input, booleanQuery(query.refreshRuntime)))
  })
  app.post('/preflight', async c => ok(c, await service().preflight(historySocialUploadInputSchema.parse(await json(c)))))
  app.get('/runtime', async c => {
    const query = queries(c, ['refresh'])
    return ok(c, await service().inspectRuntime(booleanQuery(query.refresh)))
  })
  app.post('/runtime/login', async c => {
    const body = z.object({ platform: z.enum(['baijiahao', 'tencent']) }).strict().parse(await json(c))
    return ok(c, await service().openLogin(body.platform))
  })
  app.post('/runtime/sync', async c => {
    const body = z.object({ platform: z.enum(['baijiahao', 'tencent']) }).strict().parse(await json(c))
    return ok(c, await service().syncLogin(body.platform))
  })
  const list = (c: Context) => {
    const query = queries(c, ['sourceId', 'scriptId', 'requestId', 'limit'])
    if (query.requestId !== undefined) {
      if (Object.keys(query).some(key => key !== 'requestId')) throw new HistorySocialUploadError('回执查询不能混用项目或分页条件', 400)
      return ok(c, service().receipt(requestIdSchema.parse(query.requestId)))
    }
    if (query.sourceId && query.scriptId && query.sourceId !== query.scriptId) throw new HistorySocialUploadError('项目编号不一致', 400)
    const sourceId = query.sourceId ?? query.scriptId
    const limit = query.limit === undefined ? 100 : positiveId(query.limit)
    if (limit > 100) throw new HistorySocialUploadError('每次最多读取 100 项', 400)
    return ok(c, { jobs: service().listJobs(sourceId === undefined ? undefined : positiveId(sourceId), limit), queue: service().queueState() })
  }
  const enqueue = async (c: Context) => c.json({ code: 202,
    data: httpData(await service().enqueue(historySocialUploadInputSchema.parse(await json(c)))), message: 'accepted' }, 202)
  app.get('/jobs', list)
  app.get('/', list)
  app.post('/jobs', enqueue)
  app.post('/', enqueue)
  const retryMany = async (c: Context) => {
    const body = z.object({ jobIds: z.array(z.union([z.string().regex(/^\d+$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)]))
      .min(1).max(100) }).strict().parse(await json(c))
    const ids = body.jobIds.map(id => positiveId(String(id)))
    return c.json({ code: 202, data: httpData(service().retryMany(ids)), message: 'accepted' }, 202)
  }
  app.post('/jobs/retry', retryMany)
  app.post('/jobs/reupload', retryMany)
  const detail = (c: Context) => ok(c, { job: service().getJob(positiveId(c.req.param('jobId'))), queue: service().queueState() })
  const confirm = async (c: Context) => {
    const id = positiveId(c.req.param('jobId'))
    commandSchema.parse(await json(c))
    return ok(c, { job: await service().confirm(id), queue: service().queueState() })
  }
  const cancel = async (c: Context) => {
    const id = positiveId(c.req.param('jobId'))
    z.object({}).strict().parse(await json(c))
    return ok(c, { job: service().cancel(id), queue: service().queueState() })
  }
  const open = async (c: Context) => {
    const id = positiveId(c.req.param('jobId'))
    z.object({}).strict().parse(await json(c))
    const opened = await service().open(id)
    return ok(c, { ...opened, job: service().getJob(id), queue: service().queueState() })
  }
  const resume = async (c: Context) => {
    const id = positiveId(c.req.param('jobId'))
    z.object({}).strict().parse(await json(c))
    return ok(c, { job: await service().resume(id), queue: service().queueState() })
  }
  const reconcile = async (c: Context) => {
    const id = positiveId(c.req.param('jobId'))
    z.object({}).strict().parse(await json(c))
    return ok(c, { job: await service().reconcile(id), queue: service().queueState() })
  }
  for (const prefix of ['/jobs/:jobId', '/:jobId']) {
    app.get(prefix, detail)
    app.post(`${prefix}/confirm`, confirm)
    app.post(`${prefix}/cancel`, cancel)
    app.post(`${prefix}/open`, open)
    app.post(`${prefix}/resume`, resume)
    app.post(`${prefix}/reconcile`, reconcile)
    const retry = async (c: Context) => {
      const id = positiveId(c.req.param('jobId'))
      z.object({}).strict().parse(await json(c))
      return c.json({ code: 202, data: httpData({ job: service().retry(id), queue: service().queueState() }), message: 'accepted' }, 202)
    }
    app.post(`${prefix}/retry`, retry)
    app.post(`${prefix}/reupload`, retry)
  }
  return app
}
