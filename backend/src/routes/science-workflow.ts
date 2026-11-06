import fs from 'node:fs'
import { Readable } from 'node:stream'
import { Hono, type Context } from 'hono'
import { z, ZodError } from 'zod'
import { createScienceAccountsRoute } from './science-accounts.js'
import { getScienceWorkflowService, ScienceWorkflowError, SocialUploadAccountError, scienceCreateSchema, sciencePatchSchema, scienceCoversSchema, scienceRecoverySchema, scienceUploadReviewSchema, scienceUploadReviewInputSchema, type ScienceWorkflowService } from '../services/science-workflow.js'
import { getScienceCollectionService, scienceCollectionStartSchema, type ScienceCollectionService } from '../services/science-collection.js'
import { getScienceHuashengAccountsService } from '../services/science-accounts.js'
import { openHuashengProject, type HuashengProjectOpener } from '../services/huasheng-project-open.js'
import { SCIENCE_WRITING_VERSION } from '../services/science-script.js'

const empty = z.object({}).strict()
function body(c: Context) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') || '')) throw new ScienceWorkflowError('请使用 JSON 提交科普操作', 400)
  return c.req.json<unknown>()
}
const response = (c: Context, data: unknown, status: 200 | 202 = 200) => c.json({ code: status, message: 'success', data }, status)
export function createScienceWorkflowRoute(options: { service?: ScienceWorkflowService; accounts?: ReturnType<typeof createScienceAccountsRoute>; collection?: ScienceCollectionService; openProject?: HuashengProjectOpener } = {}) {
  const app = new Hono(), service = () => options.service || getScienceWorkflowService()
  const collection = () => options.collection || getScienceCollectionService()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Science-Writing-Version', SCIENCE_WRITING_VERSION)
    const site = c.req.header('Sec-Fetch-Site'), origin = c.req.header('Origin')
    let allowed = !site || ['same-origin', 'same-site', 'none'].includes(site)
    if (origin) {
      try {
        const url = new URL(origin)
        allowed &&= ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          && ['3013', '5679', '9130', '9131'].includes(url.port) && !url.username && !url.password && !url.search && !url.hash
      } catch { allowed = false }
    }
    if (!allowed) return c.json({ code: 403, message: '仅允许本机科普工作台操作任务' }, 403)
    await next()
  })
  app.onError((error, c) => {
    const known = error instanceof ScienceWorkflowError || error instanceof SocialUploadAccountError
    const status = known ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500
    return c.json({ code: status, message: known ? error.message : status === 400 ? '请求格式不正确，请检查输入内容' : '科普服务暂不可用，请稍后重试' }, status as 400)
  })
  app.route('/accounts', options.accounts || createScienceAccountsRoute())
  app.get('/collection', c => response(c, collection().overview()))
  app.put('/collection/settings', async c => response(c, collection().saveSettings(await body(c))))
  app.post('/collection/runs', async c => response(c, collection().start(scienceCollectionStartSchema.parse(await body(c))), 202))
  app.post('/collection/runs/:id/stop', async c => { empty.parse(await body(c)); return response(c, collection().stopRun(c.req.param('id'))) })
  app.post('/collection/runs/:id/resume', async c => { empty.parse(await body(c)); return response(c, collection().resume(c.req.param('id')), 202) })
  app.post('/collection/runs/:id/collection/stop', async c => { empty.parse(await body(c)); return response(c, collection().stopCollection(c.req.param('id'))) })
  app.post('/collection/runs/:id/collection/resume', async c => { empty.parse(await body(c)); return response(c, collection().resumeCollection(c.req.param('id')), 202) })
  app.post('/collection/runs/:id/processing/stop', async c => { empty.parse(await body(c)); return response(c, collection().stopProcessing(c.req.param('id'))) })
  app.post('/collection/runs/:id/processing/resume', async c => { empty.parse(await body(c)); return response(c, collection().resumeProcessing(c.req.param('id')), 202) })
  app.post('/collection/runs/:id/retry', async c => response(c, collection().retry(c.req.param('id'), await body(c)), 202))
  app.get('/', c => response(c, service().overview()))
  app.post('/sync', async c => { empty.parse(await body(c)); return response(c, service().syncPending(), 202) })
  app.post('/jobs', async c => response(c, service().create(scienceCreateSchema.parse(await body(c))), 202))
  app.get('/jobs/:id', c => response(c, service().detail(c.req.param('id'))))
  app.post('/jobs/:id/open-project', async c => {
    empty.parse(await body(c))
    if (Object.keys(c.req.query()).length) throw new ScienceWorkflowError('打开项目不接受 URL 参数', 400)
    const job = service().detail(c.req.param('id'))
    const binding = { accountName: job.huashengAccountName, projectUrl: job.projectUrl }
    return response(c, await (options.openProject ? options.openProject(binding) : openHuashengProject(getScienceHuashengAccountsService(), binding)))
  })
  app.delete('/jobs/:id', c => response(c, service().remove(c.req.param('id'))))
  app.patch('/jobs/:id', async c => response(c, service().patch(c.req.param('id'), sciencePatchSchema.parse(await body(c)))))
  app.post('/jobs/:id/prepare', async c => { empty.parse(await body(c)); return response(c, service().produce(c.req.param('id')), 202) })
  app.post('/jobs/:id/produce', async c => {
    const input = z.object({ upload: z.boolean().optional() }).strict().parse(await body(c))
    return response(c, service().produce(c.req.param('id'), input.upload), 202)
  })
  app.post('/jobs/:id/upload', async c => { empty.parse(await body(c)); return response(c, service().upload(c.req.param('id')), 202) })
  app.post('/jobs/:id/check-upload', async c => { empty.parse(await body(c)); return response(c, service().checkUpload(c.req.param('id')), 202) })
  app.post('/jobs/:id/upload-review', async c => response(c, await service().reviewUpload(c.req.param('id'), scienceUploadReviewSchema.parse(await body(c)))))
  app.post('/jobs/:id/upload-review/input', async c => response(c, await service().reviewUpload(c.req.param('id'), { input: scienceUploadReviewInputSchema.parse(await body(c)) })))
  app.post('/jobs/:id/covers', async c => response(c, service().covers(c.req.param('id'), scienceCoversSchema.parse(await body(c))), 202))
  app.post('/jobs/:id/cancel', async c => { empty.parse(await body(c)); return response(c, service().cancel(c.req.param('id'))) })
  app.post('/jobs/:id/sync', async c => { empty.parse(await body(c)); return response(c, service().sync(c.req.param('id')), 202) })
  app.post('/jobs/:id/check-huasheng', async c => { empty.parse(await body(c)); return response(c, await service().checkHuasheng(c.req.param('id'))) })
  app.post('/jobs/:id/recover', async c => response(c, await service().recover(c.req.param('id'), scienceRecoverySchema.parse(await body(c)))))
  app.get('/jobs/:id/assets/:kind', c => {
    const kind = z.enum(['source', 'video', 'landscape-cover', 'portrait-cover']).parse(c.req.param('kind'))
    const file = service().asset(c.req.param('id'), kind), size = fs.statSync(file).size
    const value = c.req.header('Range')
    let selected: { start: number; end: number } | undefined
    if (value) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(value)
      const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]))
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start)
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      selected = { start, end }
    }
    const headers = new Headers({ 'Content-Type': kind.endsWith('-cover') ? 'image/jpeg' : 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(selected ? selected.end - selected.start + 1 : size) })
    if (selected) headers.set('Content-Range', `bytes ${selected.start}-${selected.end}/${size}`)
    return new Response(Readable.toWeb(fs.createReadStream(file, selected)) as ReadableStream, { status: selected ? 206 : 200, headers })
  })
  return app
}
