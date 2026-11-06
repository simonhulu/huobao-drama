import { Hono, type Context } from 'hono'
import { z, ZodError } from 'zod'
import { getSocialUploadAccountsService, SocialUploadAccountError, type SocialUploadAccountsService } from '../services/social-upload-accounts.js'

const empty = z.object({}).strict()
async function body(c: Context) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') || '')) throw new SocialUploadAccountError('请使用 JSON 提交账号操作', 400)
  return c.req.json<unknown>()
}
function response(c: Context, data: unknown, status: 200 | 202 = 200) { return c.json({ code: status, data, message: status === 202 ? 'accepted' : 'success' }, status) }
export function createCbaAccountsRoute(options: { service?: SocialUploadAccountsService } = {}) {
  const app = new Hono()
  const service = () => options.service || getSocialUploadAccountsService()
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const site = c.req.header('Sec-Fetch-Site'), origin = c.req.header('Origin')
    let local = !site || ['same-origin', 'same-site', 'none'].includes(site)
    if (origin) {
      try {
        const url = new URL(origin)
        local &&= ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          && ['3013', '5679', '9130', '9131'].includes(url.port) && !url.username && !url.password && !url.search && !url.hash
      } catch { local = false }
    }
    if (!local) return c.json({ code: 403, message: '仅允许本机工作台管理百家号账号' }, 403)
    await next()
  })
  app.onError((error, c) => {
    const status = error instanceof SocialUploadAccountError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500
    return c.json({ code: status, message: error instanceof SocialUploadAccountError ? error.message : status === 400 ? '账号请求格式不正确' : '账号服务暂不可用' }, status as any)
  })
  app.get('/', c => response(c, service().list()))
  app.post('/', async c => response(c, service().create(z.object({ label: z.string() }).strict().parse(await body(c)))))
  app.get('/logins/:id', c => response(c, service().login(c.req.param('id'))))
  app.post('/:accountName/default', async c => { empty.parse(await body(c)); return response(c, service().setDefault(c.req.param('accountName'))) })
  app.post('/:accountName/check', async c => { empty.parse(await body(c)); return response(c, await service().check(c.req.param('accountName'))) })
  app.post('/:accountName/login', async c => { empty.parse(await body(c)); return response(c, service().startLogin(c.req.param('accountName')), 202) })
  return app
}
export const cbaAccountsRoutes = createCbaAccountsRoute()
export default cbaAccountsRoutes
