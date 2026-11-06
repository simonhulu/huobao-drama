import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { getHistoryHuashengService, HuashengQueueError, type HistoryHuashengService } from '../services/history-huasheng.js'
import { badRequest, success } from '../utils/response.js'
import { getHistoryHuashengAccountsService, type HuashengAccountsService } from '../services/huasheng-accounts.js'
import { SocialUploadAccountError } from '../services/social-upload-accounts.js'
import { huashengProjectUrl } from '../services/history-huasheng-browser.js'
import { openHuashengProject, type HuashengProjectOpener } from '../services/huasheng-project-open.js'

export interface HistoryHuashengRouteOptions {
  service?: HistoryHuashengService
  accounts?: HuashengAccountsService
  refineCompleted?: (sourceIds:number[])=>unknown|Promise<unknown>
  openProject?: HuashengProjectOpener
}
const emptyCommand = z.object({}).strict()
const resumeCommand = z.object({ projectUrl: z.string().min(1).max(2048).optional() }).strict()
const productionCommand = z.object({ jobIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(100).optional() }).strict()
const produceCommand = productionCommand.required()
const refineCompletedCommand = z.object({ sourceIds:z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(100) }).strict()

function positiveId(value: string) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HuashengQueueError('任务或文稿编号无效', 400)
  return Number(value)
}

function pagination(c: Context) {
  const limit = c.req.query('limit') === undefined ? 50 : positiveId(c.req.query('limit')!)
  const beforeId = c.req.query('beforeId') === undefined ? undefined : positiveId(c.req.query('beforeId')!)
  if (limit > 100) throw new HuashengQueueError('每页最多 100 条任务', 400)
  return { limit, beforeId }
}

export function createHistoryHuashengRoute(options: HistoryHuashengRouteOptions = {}) {
  const app = new Hono()
  // Resolve lazily: importing the main history routes must not initialize a queue or browser.
  const queue = () => options.service ?? getHistoryHuashengService()
  const guard: MiddlewareHandler = async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.method !== 'GET') {
      const origin = c.req.header('Origin')
      const site = c.req.header('Sec-Fetch-Site')
      if (site && !['same-origin', 'none'].includes(site)) return c.json({ code: 403, message: '仅允许本地历史脚本页面管理花生任务' }, 403)
      if (origin) {
        let allowed = false
        try {
          const url = new URL(origin)
          allowed = url.origin === origin && ['http:', 'https:'].includes(url.protocol)
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && ['3013', '9130', '9131', '5679'].includes(url.port)
        } catch { /* Reject invalid origins before any external action. */ }
        if (!allowed) return c.json({ code: 403, message: '仅允许本地历史脚本页面管理花生任务' }, 403)
      }
      if (Object.keys(c.req.query()).length) return badRequest(c, '操作不接受 URL 参数')
      if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return badRequest(c, '操作需要 JSON 请求')
      let body: unknown
      try { body = await c.req.json() } catch { return badRequest(c, '无效的 JSON 请求') }
      if (c.req.method === 'PUT') {
        if (!z.object({ enabled: z.boolean() }).strict().safeParse(body).success) return badRequest(c, '设置仅接受 enabled 布尔值')
      } else if (c.req.path.endsWith('/resume')) {
        if (!resumeCommand.safeParse(body).success) return badRequest(c, '恢复仅接受可选的项目链接 projectUrl')
      } else if (c.req.path.endsWith('/huasheng/check-production') && c.req.param('id') === undefined) {
        if (!productionCommand.safeParse(body).success) return badRequest(c, '检查仅接受空对象（全部）或 1 至 100 个有效任务编号 jobIds')
      } else if (c.req.path.endsWith('/huasheng/produce')) {
        if (!produceCommand.safeParse(body).success) return badRequest(c, '生产需要明确选择 1 至 100 个有效任务编号 jobIds')
      } else if (c.req.path.endsWith('/huasheng/refine-completed')) {
        if (!refineCompletedCommand.safeParse(body).success) return badRequest(c, '精细化补做需要明确选择 1 至 100 个有效文稿编号 sourceIds')
      } else if (!emptyCommand.safeParse(body).success) return badRequest(c, '操作仅接受空 JSON 对象')
    }
    await next()
  }
  const respond = async (c: Context, action: () => unknown | Promise<unknown>, status: 200 | 202 = 200) => {
    try {
      const data = await action()
      return status === 202 ? c.json({ code: 202, data, message: 'accepted' }, 202) : success(c, data)
    }
    catch (error) {
      if (error instanceof HuashengQueueError) return c.json({ code: error.statusCode, message: error.message }, error.statusCode)
      if (error instanceof SocialUploadAccountError) return c.json({ code: error.status, message: error.message }, error.status)
      console.error('[history-huasheng] API failed:', error instanceof Error ? error.name : 'Unknown error')
      return c.json({ code: 503, message: '花生任务服务暂不可用，已保存的文稿不受影响' }, 503)
    }
  }

  const accounts = () => options.accounts ?? getHistoryHuashengAccountsService()
  app.get('/huasheng/accounts', guard, c => respond(c, () => accounts().list()))
  app.post('/huasheng/accounts/:accountName/login', guard, c => respond(c, () => accounts().openLogin(c.req.param('accountName'))))
  app.post('/huasheng/accounts/:accountName/check', guard, c => respond(c, async () => {
    const account = await accounts().check(c.req.param('accountName'))
    if (account.status === 'ready' && !options.accounts) await queue().browserStatus(true)
    return accounts().get(account.accountName)
  }))
  app.get('/huasheng', guard, c => respond(c, () => queue().overview(pagination(c))))
  app.put('/huasheng/settings', guard, c => respond(c, async () => queue().setEnabled((await c.req.json()).enabled)))
  app.put('/huasheng/monitoring', guard, c => respond(c, async () => queue().setMonitoring((await c.req.json()).enabled)))
  app.post('/huasheng/browser/open', guard, c => respond(c, async () => ({ browser: await queue().openBrowser() })))
  app.post('/huasheng/browser/check', guard, c => respond(c, async () => ({ browser: await queue().browserStatus(true) })))
  app.post('/huasheng/check-production', guard, c => respond(c, async () => queue().checkProduction(undefined, productionCommand.parse(await c.req.json())), 202))
  app.post('/huasheng/produce', guard, c => respond(c, async () => {
    const ids = produceCommand.parse(await c.req.json()).jobIds
    const result = await queue().produce(ids, { dual: !options.service })
    if (!options.service) {
      void (await import('../services/history-video-workflow.js')).runHistoryDualProductionPass()
        .catch(error => console.error('[history-huasheng] Dual production pass failed:', error instanceof Error ? error.message : error))
    }
    return result
  }, 202))
  app.post('/huasheng/refine-completed', guard, c => respond(c, async () => {
    const {sourceIds}=refineCompletedCommand.parse(await c.req.json())
    if(options.refineCompleted)return options.refineCompleted(sourceIds)
    const workflow=await import('../services/history-video-workflow.js')
    const result=workflow.queueHistoryRefinedBackfill(sourceIds)
    void workflow.runHistoryDualProductionPass()
      .catch(error=>console.error('[history-huasheng] Refined backfill pass failed:',error instanceof Error ? error.message : error))
    return result
  },202))
  app.post('/:id/huasheng/check-production', guard, c => respond(c, () => queue().checkProduction(positiveId(c.req.param('id')!)), 202))
  app.get('/:id/huasheng', guard, c => respond(c, () => ({ jobs: queue().listJobs(positiveId(c.req.param('id')!), pagination(c)), productionChecking: queue().productionChecking })))
  app.post('/:id/huasheng', guard, c => respond(c, async () => options.service
    ? ({ job: await queue().enqueue(positiveId(c.req.param('id')!)) })
    : (await import('../services/history-video-workflow.js')).startHistoryDualProduction(positiveId(c.req.param('id')!),{retry:true})))
  app.get('/:id/production', guard, c => respond(c, async () => ({productions:(await import('../services/history-video-workflow.js')).historyDualProduction(positiveId(c.req.param('id')!))})))
  app.post('/:id/production', guard, c => respond(c, async () => (await import('../services/history-video-workflow.js')).startHistoryDualProduction(positiveId(c.req.param('id')!),{retry:true}),202))
  app.post('/huasheng/jobs/:jobId/resume', guard, c => respond(c, async () => ({ job: await queue().resume(positiveId(c.req.param('jobId')!), await c.req.json()) })))
  app.post('/huasheng/jobs/:jobId/open-project', guard, c => respond(c, async () => {
    const job = queue().getJob(positiveId(c.req.param('jobId')!))
    const projectUrl = huashengProjectUrl(job.projectUrl) || huashengProjectUrl(job.videoUrl)
    const binding = { accountName: job.huashengAccountName, projectUrl, ...(!projectUrl ? { home: true } : {}) }
    return options.openProject ? options.openProject(binding) : openHuashengProject(accounts(), binding)
  }))
  app.post('/huasheng/jobs/:jobId/cancel', guard, c => respond(c, () => ({ job: queue().cancel(positiveId(c.req.param('jobId')!)) })))
  return app
}
