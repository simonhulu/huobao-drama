import { Hono } from 'hono'
import { z } from 'zod'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { getStorageManager, STORAGE_KINDS, type StorageManager } from '../services/storage-management.js'
import { success } from '../utils/response.js'

const cleanupBody=z.object({kinds:z.array(z.enum(STORAGE_KINDS)).max(STORAGE_KINDS.length).optional()}).strict()
const policyBody=z.object({autoCleanup:z.boolean().optional(),retentionDays:z.number().int().min(0).max(90).optional()}).strict()
const reviewBody=z.object({action:z.enum(['keep','delete','archive']),sha256:z.string().regex(/^[a-f0-9]{64}$/),
  productionVerified:z.boolean().optional(),uploadVerified:z.boolean().optional(),
  receiptUrls:z.array(z.string().max(2048)).max(20).optional(),backupPath:z.string().max(4096).optional()}).strict()
const idSchema=z.coerce.number().int().positive()
const associateBody=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),
  ownerType:z.enum(['history-source','history-motion','cba','science','remotion','episode']),ownerId:z.string().min(1).max(300)}).strict()
const reviewQuery=z.object({ownerId:z.string().max(300).optional(),ownerType:z.string().max(100).optional(),
  role:z.enum(['source','intermediate','final','shared','project']).optional(),
  offset:z.coerce.number().int().min(0).max(1_000_000).default(0),limit:z.coerce.number().int().min(1).max(150).default(150)}).strict()

export function createStorageRoute(getManager:()=>Promise<StorageManager> = getStorageManager) {
  const app=new Hono()
  app.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store')
    if (['POST','PATCH','DELETE'].includes(c.req.method)) {
      if (c.req.header('Content-Type')?.split(';')[0]?.trim()!=='application/json') return c.json({code:400,message:'需要 JSON 请求'},400)
      const origin=c.req.header('Origin'),site=c.req.header('Sec-Fetch-Site')
      if (site==='cross-site') return c.json({code:403,message:'仅允许本地磁盘管理页面执行回收'},403)
      if (origin) {
        try { const url=new URL(origin);if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !['http:','https:'].includes(url.protocol)) throw Error() }
        catch { return c.json({code:403,message:'仅允许本地磁盘管理页面执行回收'},403) }
      }
      if (Number(c.req.header('Content-Length') || 0)>32*1024) return c.json({code:413,message:'请求过大'},413)
    }
    await next()
  })
  app.onError((error,c)=>c.json({code:400,message:error instanceof z.ZodError ? '磁盘管理请求无效' : error.message},400))
  app.get('/',async c=>success(c,await (await getManager()).summary()))
  app.post('/scan',async c=>success(c,await (await getManager()).scan()))
  app.post('/cleanup',async c=>{const body=cleanupBody.parse(await c.req.json());return success(c,await (await getManager()).cleanup(body.kinds))})
  app.patch('/policy',async c=>{const body=policyBody.parse(await c.req.json());const manager=await getManager();manager.updatePolicy(body);return success(c,await manager.summary())})
  app.get('/review',async c=>success(c,(await getManager()).reviewList(reviewQuery.parse(c.req.query()))))
  app.post('/owners/:type/:id/cleanup',async c=>{
    const body=cleanupBody.parse(await c.req.json())
    return success(c,await (await getManager()).cleanup(body.kinds,{ownerType:c.req.param('type'),ownerId:c.req.param('id')}))
  })
  app.post('/owners/cba/:id/delete-task',async c=>{
    const body=z.object({confirm:z.literal(true),expectedTitle:z.string().trim().min(1).max(500)}).strict().parse(await c.req.json())
    const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/).parse(c.req.param('id'))
    return success(c,await (await getManager()).softDeleteCbaTask(id,body))
  })
  app.get('/artifacts/:id',async c=>success(c,await (await getManager()).inspect(idSchema.parse(c.req.param('id')))))
  app.get('/artifacts/:id/content',async c=>{
    const file=await (await getManager()).media(idSchema.parse(c.req.param('id')))
    const range=c.req.header('Range'),match=range?.match(/^bytes=(\d*)-(\d*)$/)
    let start=0,end=file.bytes-1
    if (range) {
      if (!match || !match[1] && !match[2]) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.bytes}`}})
      start=match[1] ? Number(match[1]) : Math.max(0,file.bytes-Number(match[2]))
      end=match[1] && match[2] ? Math.min(Number(match[2]),end) : end
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || start<0) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.bytes}`}})
    }
    const headers:Record<string,string>={'Content-Type':file.mimeType,'Accept-Ranges':'bytes','Content-Length':String(Math.max(0,end-start+1)),
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
    if (range) headers['Content-Range']=`bytes ${start}-${end}/${file.bytes}`
    if (c.req.query('download')==='1') headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.path))}`
    const body=file.bytes ? Readable.toWeb(createReadStream(file.path,{start,end})) as ReadableStream : null
    return new Response(body,{status:range ? 206 : 200,headers})
  })
  app.post('/artifacts/:id/review',async c=>success(c,await (await getManager()).review(idSchema.parse(c.req.param('id')),reviewBody.parse(await c.req.json()))))
  app.post('/artifacts/:id/associate',async c=>success(c,await (await getManager()).associate(idSchema.parse(c.req.param('id')),associateBody.parse(await c.req.json()))))
  app.post('/artifacts/:id/restore',async c=>success(c,await (await getManager()).restore(idSchema.parse(c.req.param('id')))))
  return app
}
