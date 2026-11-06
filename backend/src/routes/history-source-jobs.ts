import { Hono } from 'hono'
import { ZodError } from 'zod'
import { badRequest, notFound, success } from '../utils/response.js'
import { db } from '../db/index.js'
import { createHistoryBatchOutcomesRoute } from './history-batch-outcomes.js'
import { getHistorySourceJob, HistorySourceResumeConflictError, HistorySourceWorkerUnavailableError, listHistorySourceJobEvents, listHistorySourceJobs, refreshHistorySourceYoutubeSession, resumeHistorySourceJob, safeHistoryJobMessage, startHistorySourceJob, stopHistorySourceJob } from '../services/history-source-jobs.js'

function jobId(value: string) {
  if (!/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function pagination(query: Record<string, string>, maxLimit: number) {
  const limit = query.limit === undefined ? undefined : jobId(query.limit)
  const beforeId = query.beforeId === undefined ? undefined : jobId(query.beforeId)
  if (limit === null || (limit !== undefined && limit > maxLimit) || beforeId === null) return null
  return { limit, beforeId }
}

export function createHistorySourceJobsRoute() {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST') {
      if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) return badRequest(c, 'A JSON request is required')
      const origin = c.req.header('Origin')
      if (origin) {
        let allowed = false
        try {
          const url = new URL(origin)
          allowed = ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && ['3013', '9130', '5679'].includes(url.port) && !url.username && !url.password
        } catch { /* Malformed or cross-site origins cannot start paid work. */ }
        if (!allowed) return c.json({ code: 403, message: 'Only the local history-script page can control sourcing jobs' }, 403)
      }
    }
    await next()
  })
  app.get('/', c => {
    const options = pagination(c.req.query(), 50)
    return options ? success(c, listHistorySourceJobs(options)) : badRequest(c, 'Invalid history pagination: limit must be 1–50 and beforeId a positive safe integer')
  })
  app.post('/', async c => {
    let body: unknown
    try { body = await c.req.json() } catch { return badRequest(c, 'Invalid JSON') }
    try { return success(c, startHistorySourceJob(body)) }
    catch (error) {
      if (error instanceof HistorySourceWorkerUnavailableError) return c.json({ code: 503, message: error.message }, 503)
      if (error instanceof ZodError) return badRequest(c, '请选择有效采集源与 1 至 9999 条或持续采集；YouTube 需要 1 至 30 个不重复的有效频道或视频链接；CZGTS 需要有效的起止时间（北京时间，结束晚于开始）；抖音需要至少一种历史类型及 1 至 30 个不重复关键词')
      throw error
    }
  })
  app.route('/',createHistoryBatchOutcomesRoute(db.$client,safeHistoryJobMessage))
  app.get('/:id/events', c => {
    const id = jobId(c.req.param('id'))
    if (!id) return badRequest(c, 'Invalid history job id')
    const options = pagination(c.req.query(), 200)
    if (!options) return badRequest(c, 'Invalid history pagination: limit must be 1–200 and beforeId a positive safe integer')
    const events = listHistorySourceJobEvents(id, options)
    return events ? success(c, events) : notFound(c, 'History sourcing job not found')
  })
  app.get('/:id', c => {
    const id = jobId(c.req.param('id'))
    if (!id) return badRequest(c, 'Invalid history job id')
    const job = getHistorySourceJob(id)
    return job ? success(c, { job }) : notFound(c, 'History sourcing job not found')
  })
  app.post('/:id/stop', c => {
    const id = jobId(c.req.param('id'))
    if (!id) return badRequest(c, 'Invalid history job id')
    const job = stopHistorySourceJob(id)
    return job ? success(c, { job }) : notFound(c, 'History sourcing job not found')
  })
  app.post('/:id/resume', c => {
    const id = jobId(c.req.param('id'))
    if (!id) return badRequest(c, 'Invalid history job id')
    try {
      const job = resumeHistorySourceJob(id)
      return job ? success(c, { job }) : notFound(c, 'History sourcing job not found')
    } catch (error) {
      if (error instanceof HistorySourceResumeConflictError) return c.json({ code: 409, message: error.message }, 409)
      if (error instanceof HistorySourceWorkerUnavailableError) return c.json({ code: 503, message: error.message }, 503)
      throw error
    }
  })
  app.post('/:id/youtube-session', async c => {
    const id = jobId(c.req.param('id'))
    if (!id) return badRequest(c, 'Invalid history job id')
    try {
      const result = await refreshHistorySourceYoutubeSession(id)
      return result ? success(c, result) : notFound(c, 'History sourcing job not found')
    } catch (error) {
      if (error instanceof HistorySourceResumeConflictError) return c.json({ code: 409, message: error.message }, 409)
      return c.json({ code: 503, message: error instanceof Error ? error.message : 'YouTube 登录刷新失败，请在 Chrome 完成验证后重试' }, 503)
    }
  })
  return app
}
