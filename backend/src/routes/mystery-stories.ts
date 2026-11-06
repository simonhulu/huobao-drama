import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Hono, type Context } from 'hono'
import { z, ZodError } from 'zod'
import { getMysteryWorkflowService, mysteryRevisionSchema, type MysteryWorkflowService } from '../services/mystery-workflow.js'
import { MysteryError, mysteryCreateSchema, mysteryPatchSchema, mysteryRunSchema, mysteryChannelSchema, mysteryCollectionSchema } from '../services/mystery-store.js'
import { createMysteryAccountsRoute } from './mystery-accounts.js'
import { mysteryAsset, buildMysteryPackage } from '../services/mystery-package.js'
import { SocialUploadAccountError } from '../services/social-upload-accounts.js'
import { getMysteryHuashengAccountsService } from '../services/mystery-accounts.js'
import { openHuashengProject, type HuashengProjectOpener } from '../services/huasheng-project-open.js'

const empty=z.object({}).strict(),idSchema=z.coerce.number().int().positive()
const body=(c:Context)=>{if(!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type')||''))throw new MysteryError('请使用JSON提交操作',400);return c.req.json<unknown>()}
const ok=(c:Context,data:unknown)=>c.json({code:200,data,message:'success'})
export function createMysteryStoriesRoute(options:{service?:MysteryWorkflowService;accounts?:Hono;openProject?:HuashengProjectOpener}={}) {
  const app=new Hono(),service=()=>options.service||getMysteryWorkflowService()
  app.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store')
    const origin=c.req.header('Origin'),site=c.req.header('Sec-Fetch-Site')
    let allowed=!site||['same-origin','same-site','none'].includes(site)
    if(origin)try{const url=new URL(origin);allowed&&=['http:','https:'].includes(url.protocol)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&['3013','5679','9130','9131'].includes(url.port)&&!url.username&&!url.password&&!url.search&&!url.hash}catch{allowed=false}
    if(!allowed)return c.json({code:403,message:'仅允许本机工作台操作奇闻故事任务'},403)
    await next()
  })
  app.onError((error,c)=>{
    const known=error instanceof MysteryError||error instanceof SocialUploadAccountError
    const status=known?error.status:error instanceof ZodError||error instanceof SyntaxError?400:500
    if(status===500)console.error('[mystery-stories]',error)
    return c.json({code:status,message:known?error.message:status===400?'输入格式不正确，请检查字段':'奇闻故事服务暂不可用，已保留原任务'},status as 400)
  })
  app.route('/accounts',options.accounts||createMysteryAccountsRoute())
  app.get('/stories',c=>{
    const query=z.object({search:z.string().max(300).optional(),category:z.enum(['case','event','person']).optional(),status:z.enum(['draft','queued','running','paused','needs_attention','ready','completed']).optional(),hasEdition:z.enum(['true','false']).transform(v=>v==='true').optional(),page:z.coerce.number().int().positive().optional(),pageSize:z.coerce.number().int().min(1).max(100).optional()}).parse(Object.fromEntries(Object.entries(c.req.query()).filter(([,v])=>v!=='')))
    return ok(c,service().list(query))
  })
  app.post('/stories',async c=>ok(c,service().create(mysteryCreateSchema.parse(await body(c)))))
  app.get('/stories/:id',c=>ok(c,service().detail(idSchema.parse(c.req.param('id')))))
  app.patch('/stories/:id',async c=>ok(c,service().patch(idSchema.parse(c.req.param('id')),mysteryPatchSchema.parse(await body(c)))))
  app.post('/stories/:id/revisions',async c=>ok(c,service().saveRevision(idSchema.parse(c.req.param('id')),mysteryRevisionSchema.parse(await body(c)))))
  app.post('/stories/:id/runs',async c=>ok(c,service().start(idSchema.parse(c.req.param('id')),mysteryRunSchema.parse(await body(c)))))
  app.post('/stories/:id/runs/:runId/stop',async c=>{empty.parse(await body(c));return ok(c,service().stop(idSchema.parse(c.req.param('id')),c.req.param('runId')))})
  app.post('/stories/:id/runs/:runId/resume',async c=>{empty.parse(await body(c));return ok(c,service().resume(idSchema.parse(c.req.param('id')),c.req.param('runId')))})
  app.post('/stories/:id/archive',async c=>{empty.parse(await body(c));return ok(c,service().archive(idSchema.parse(c.req.param('id'))))})
  app.patch('/stories/:id/editions/:editionId/copy',async c=>{
    const input=z.object({title:z.string().trim().min(1).max(50),description:z.string().trim().min(1).max(2000),tags:z.array(z.string().trim().min(1).max(80)).max(20)}).strict().parse(await body(c))
    return ok(c,service().saveCopy(idSchema.parse(c.req.param('id')),c.req.param('editionId'),input))
  })
  app.post('/stories/:id/editions/:editionId/recover',async c=>{
    const input=z.object({projectUrl:z.string().max(2048).optional(),exportTask:z.object({taskId:z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),projectHash:z.string().regex(/^[a-f0-9]{64}$/i)}).strict().optional()}).strict().refine(v=>v.projectUrl||v.exportTask).parse(await body(c))
    return ok(c,service().recoverEdition(idSchema.parse(c.req.param('id')),c.req.param('editionId'),input))
  })
  app.post('/stories/:id/editions/:editionId/open-project',async c=>{
    empty.parse(await body(c))
    if(Object.keys(c.req.query()).length)throw new MysteryError('打开项目不接受URL参数',400)
    const story=service().store.get(idSchema.parse(c.req.param('id')))
    const edition=story.editions.find(item=>item.id===c.req.param('editionId'))
    if(!edition)throw new MysteryError('成片版本不存在',404)
    const binding={accountName:edition.accountName,projectUrl:edition.projectUrl}
    return ok(c,await(options.openProject?options.openProject(binding):openHuashengProject(getMysteryHuashengAccountsService(),binding)))
  })
  app.get('/channels',c=>ok(c,service().channels()))
  app.post('/channels',async c=>ok(c,service().saveChannel(mysteryChannelSchema.parse(await body(c)))))
  app.patch('/channels/:id',async c=>{const current=service().channels().find(item=>item.id===c.req.param('id'));if(!current)throw new MysteryError('频道不存在',404);const patch=mysteryChannelSchema.partial().parse(await body(c));const {id,createdAt,...values}=current;return ok(c,service().saveChannel({...values,...patch},id))})
  app.get('/collection-runs',c=>ok(c,service().collections()))
  app.post('/collection-runs',async c=>ok(c,service().startCollection(mysteryCollectionSchema.parse(await body(c)))))
  app.post('/collection-runs/:id/stop',async c=>{empty.parse(await body(c));return ok(c,service().stopCollection(c.req.param('id')))})
  app.post('/collection-runs/:id/resume',async c=>{empty.parse(await body(c));return ok(c,service().resumeCollection(c.req.param('id')))})
  app.post('/collection-runs/:id/retry',async c=>{empty.parse(await body(c));return ok(c,service().resumeCollection(c.req.param('id'),true))})
  app.get('/stories/:id/download',async c=>{
    const id=idSchema.parse(c.req.param('id')),kind=z.enum(['source','video','landscape','portrait','script','analysis','package']).parse(c.req.query('kind'))
    const editionId=c.req.query('editionId'),story=service().store.get(id)
    if(kind==='script'||kind==='analysis') {
      const requested=c.req.query('revisionId'),revisionId=requested?idSchema.parse(requested):editionId?story.editions.find(e=>e.id===editionId)?.revisionId:story.currentRevisionId
      const revision=story.revisions.find(r=>r.id===revisionId);if(!revision)throw new MysteryError('文稿版本不存在',404)
      const content=kind==='script'?revision.text:JSON.stringify({source:revision.source,analysis:revision.analysis,patches:revision.patches,review:revision.review},null,2)
      return new Response(content,{headers:{'Content-Type':kind==='script'?'text/plain; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="mystery-${id}-v${revision.id}.${kind==='script'?'txt':'json'}"`}})
    }
    const file=kind==='package'?await buildMysteryPackage(service(),id,z.string().min(1).parse(editionId),c.req.raw.signal):mysteryAsset(service(),id,kind,editionId)
    return fileResponse(c,file,kind==='package')
  })
  return app
}
function fileResponse(c:Context,file:string,attachment=false) {
  const size=fs.statSync(file).size,value=c.req.header('Range');let selected:{start:number;end:number}|undefined
  if(value) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(value),start=match?.[1]?Number(match[1]):Math.max(0,size-Number(match?.[2])),end=match?.[1]&&match[2]?Math.min(Number(match[2]),size-1):size-1
    if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}})
    selected={start,end}
  }
  const ext=path.extname(file).toLowerCase(),type=ext==='.zip'?'application/zip':ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.png'?'image/png':ext==='.m4a'?'audio/mp4':'video/mp4'
  const headers=new Headers({'Content-Type':type,'Cache-Control':'no-store','Accept-Ranges':'bytes','Content-Length':String(selected?selected.end-selected.start+1:size),'X-Content-Type-Options':'nosniff'})
  if(selected)headers.set('Content-Range',`bytes ${selected.start}-${selected.end}/${size}`)
  if(attachment)headers.set('Content-Disposition',`attachment; filename="${path.basename(file)}"`)
  return new Response(Readable.toWeb(fs.createReadStream(file,selected)) as ReadableStream,{status:selected?206:200,headers})
}
export default createMysteryStoriesRoute()
