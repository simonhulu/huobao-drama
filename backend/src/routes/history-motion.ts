import {Hono,type Context} from 'hono'
import {ZodError,z} from 'zod'
import fs from 'node:fs'
import {Readable} from 'node:stream'
import {getHistorySource,requireCurrentHistoryScript} from '../services/history-script-library.js'
import {createHistoryMotionProduction,materialSearchSchema,motionPlanSchema,motionProfileSchema,motionSelectionSchema,sourceRevision,type HistoryMotionProduction,type MotionJob} from '../services/history-motion-production.js'
import {createMotionRunner,type MotionPipelineDependencies} from '../services/history-motion-pipeline.js'
import {getHistoryFactory} from '../services/history-factory.js'
import {getMotionMapPack} from '../services/history-motion-maps.js'
import {associateMotionDelivery,motionOutputFile,verifiedMotionOutput,type MotionDeliveryOptions} from '../services/history-motion-delivery.js'
import {badRequest,notFound,success} from '../utils/response.js'
export interface HistoryMotionRouteOptions {production?:HistoryMotionProduction;productionOptions?:Parameters<typeof createHistoryMotionProduction>[0];pipeline?:Partial<MotionPipelineDependencies>;delivery?:MotionDeliveryOptions}
const produceSchema=z.object({scriptRevision:z.string().regex(/^[a-f0-9]{64}$/),profile:motionProfileSchema.default('16:9')}).strict()
function numberId(value:string){const id=Number(value);return /^\d+$/.test(value)&&Number.isSafeInteger(id)&&id>0?id:null}
function serveFile(c:Context,filename:string){
  const size=fs.statSync(filename).size
  let start=0,end=size-1,partial=false
  const range=c.req.header('range')
  if(range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range)
    if(!match||(!match[1]&&!match[2]))return c.body(null,416,{'Content-Range':`bytes */${size}`})
    start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]))
    end=match[1]&&match[2]?Math.min(Number(match[2]),size-1):size-1
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return c.body(null,416,{'Content-Range':`bytes */${size}`})
    partial=true
  }
  const headers:Record<string,string>={'Content-Type':'video/mp4','Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff'}
  if(partial)headers['Content-Range']=`bytes ${start}-${end}/${size}`
  return c.newResponse(c.req.method==='HEAD'?null:Readable.toWeb(fs.createReadStream(filename,{start,end})) as ReadableStream,partial?206:200,headers)
}
export function createHistoryMotionRoute(options:HistoryMotionRouteOptions={}){
  const app=new Hono()
  let service=options.production
  let runner:ReturnType<typeof createMotionRunner>|undefined
  const approvals=new Map<string,Promise<MotionJob>>()
  function production(){
    if(!options.production && !options.productionOptions && !options.pipeline && !options.delivery){
      const factory=getHistoryFactory();service=factory.production;runner=factory.runner;return service
    }
    if(!service)service=createHistoryMotionProduction(options.productionOptions)
    if(!runner){
      runner=createMotionRunner(service,{...options.pipeline,deliver:async(job,output)=>associateMotionDelivery(job,output,options.delivery,()=>current(job))})
      for(const job of service.list()){
        if(['planning','selecting','rendering','validating'].includes(job.status)){job.status='failed';job.error='服务曾在制作中重启；已有素材和配音已保留，请重试';service.write(job)}
        else if(job.status==='queued')runner.schedule(job.id)
      }
    }
    return service
  }
  const visibleShot=(shot:any)=>({...shot,hasImage:!!shot.imagePath,hasVideo:!!shot.sourcePath,imagePath:undefined,sourcePath:undefined,
    map:shot.map?{...shot.map,backgroundSrc:undefined,provenance:{...shot.map.provenance,manifestPath:undefined}}:undefined})
  const present=(job:MotionJob)=>({...job,outputPath:undefined,
    factory:job.factory?{episodeId:job.factory.episodeId,projectId:job.factory.projectId,sourceId:job.factory.sourceId,scriptHash:job.factory.scriptHash}:undefined,
    candidates:Object.fromEntries(Object.entries(job.candidates).map(([id,items])=>[id,items.map(item=>({...item,localPath:undefined}))])),
    plan:{...job.plan,audioPath:undefined,visuals:undefined,
      soundEffects:job.plan?.soundEffects?.map((item:any)=>({...item,sourcePath:undefined})),
      shots:job.plan?.shots?.length ? job.plan.shots.map(visibleShot) : job.requested.shots.map(shot=>{
      try {
        if(shot.mapPackId)return visibleShot({...shot,map:getMotionMapPack(shot.mapPackId,job.script),status:'ready'})
        if(!shot.selection)throw Error('请选择适合的已下载素材')
        production().validateSelection(shot,job.candidates[shot.shotId]||[],shot.selection)
        return {...shot,status:'ready'}
      } catch(error){return {...shot,status:'needs_review',reviewReason:(error as Error).message}}
    })},videoUrl:job.outputPath?`/api/v1/history-scripts/motion/${job.scriptId}/jobs/${job.id}/video`:null})
  function errorResponse(c:Context,error:unknown){return badRequest(c,error instanceof ZodError?'请求参数无效':error instanceof SyntaxError?'JSON格式无效':(error as Error).message)}
  function source(c:Context){const id=numberId(c.req.param('id')||'');if(!id)throw Error('Invalid history source id');return getHistorySource(id)}
  function current(job:MotionJob){const value=getHistorySource(job.scriptId);if(!value)throw Error('稿件已删除');requireCurrentHistoryScript(value);if(sourceRevision(value)!==job.scriptRevision)throw Error('稿件已更新，请为新版本创建制作任务')}
  function getJob(c:Context){if(!source(c))return null;const job=production().find(c.req.param('jobId')||'');return job&&job.scriptId===Number(c.req.param('id'))?job:null}
  function editable(job:MotionJob){if(runner!.isRunning(job.id)||approvals.has(job.id)||job.status==='completed')throw Error('此任务正在运行或已交付，不能修改');current(job)}
  app.get('/jobs',c=>success(c,{jobs:production().list().filter(j=>getHistorySource(j.scriptId)).map(present)}))
  app.post('/materials/search',async c=>{try{return success(c,{candidates:production().search(materialSearchSchema.parse(await c.req.json()))})}catch(error){return errorResponse(c,error)}})
  app.get('/:id',c=>{try{const value=source(c);return value?success(c,{jobs:production().list(value.id).map(present)}):notFound(c,'History script not found')}catch(error){return errorResponse(c,error)}})
  app.post('/:id/produce',async c=>{
    try{
      const value=source(c);if(!value)return notFound(c,'History script not found')
      const body=produceSchema.parse(await c.req.json()),script=requireCurrentHistoryScript(value)
      if(body.scriptRevision!==sourceRevision(value))return c.json({code:409,message:'稿件已更新，请刷新后创建制作任务'},409)
      if(!options.production && !options.productionOptions && !options.pipeline && !options.delivery){
        const detail=await getHistoryFactory().startFromSource(value,{profile:body.profile,revision:body.scriptRevision})
        await (await import('../services/history-video-workflow.js')).startHistoryDualProduction(value.id)
        const job=production().find(detail.job!.id)
        if(!job)throw Error('制作任务未保存，请刷新后重试')
        return success(c,{job:present(job),url:detail.url})
      }
      const job=production().create(value.id,script,value.title,body.scriptRevision,body.profile)
      if(job.status==='queued')runner!.schedule(job.id)
      return success(c,present(job))
    }catch(error){return errorResponse(c,error)}
  })
  app.post('/:id/plan',async c=>{
    try{
      const value=source(c);if(!value)return notFound(c,'History script not found')
      const body=motionPlanSchema.parse(await c.req.json()),script=requireCurrentHistoryScript(value)
      if(body.scriptRevision!==sourceRevision(value))return c.json({code:409,message:'稿件版本不匹配'},409)
      return success(c,present(production().createPlan(value.id,body,script,value.title)))
    }catch(error){return errorResponse(c,error)}
  })
  app.get('/:id/jobs/:jobId',c=>{try{const job=getJob(c);return job?success(c,present(job)):notFound(c,'Motion job not found')}catch(error){return errorResponse(c,error)}})
  app.post('/:id/jobs/:jobId/search',async c=>{
    try{
      const job=getJob(c);if(!job)return notFound(c,'Motion job not found');editable(job)
      const body=z.object({shotId:z.string(),query:z.string().trim().min(1).max(500)}).strict().parse(await c.req.json())
      const shot=job.requested.shots.find(s=>s.shotId===body.shotId);if(!shot)return notFound(c,'镜头不存在')
      shot.search={...shot.search,query:body.query,shotSize:'any'};job.candidates[shot.shotId]=production().search(shot.search);delete shot.selection
      if(job.plan){job.plan.shots=[];if(job.plan.visuals)delete job.plan.visuals[shot.shotId];job.plan.fallbacks=job.plan.fallbacks?.filter((item:any)=>item.shotId!==shot.shotId);delete job.plan.humanReview;delete job.plan.deliveryAssociation;delete job.plan.delivery}
      job.outputPath=null;job.status='needs_review';job.stage='selection';job.message='检索已更新，请选择素材'
      return success(c,present(production().write(job)))
    }catch(error){return errorResponse(c,error)}
  })
  app.post('/:id/jobs/:jobId/select',async c=>{
    try{
      const job=getJob(c);if(!job)return notFound(c,'Motion job not found');editable(job)
      const body=motionSelectionSchema.extend({shotId:z.string()}).parse(await c.req.json())
      const shot=job.requested.shots.find(s=>s.shotId===body.shotId);if(!shot)return notFound(c,'镜头不存在')
      const {shotId,...selection}=body;production().validateSelection(shot,job.candidates[shotId]||[],selection,true)
      shot.selection={...selection,confidence:1};delete shot.mapPackId;delete shot.mapPlan;shot.visualType='video'
      if(job.plan){job.plan.shots=[];if(job.plan.visuals)delete job.plan.visuals[shot.shotId];job.plan.fallbacks=job.plan.fallbacks?.filter((item:any)=>item.shotId!==shot.shotId);delete job.plan.humanReview;delete job.plan.deliveryAssociation;delete job.plan.delivery}
      job.outputPath=null;job.status='needs_review';job.stage='selection';job.message='选片已保存，可以继续渲染'
      return success(c,present(production().write(job)))
    }catch(error){return errorResponse(c,error)}
  })
  for(const action of ['retry','render'] as const)app.post(`/:id/jobs/:jobId/${action}`,async c=>{
    try{
      const job=getJob(c);if(!job)return notFound(c,'Motion job not found');editable(job)
      if(job.stage==='rendered') {
        job.status='queued';job.error=null;job.message='等待关联已有成片';production().write(job);runner!.schedule(job.id,'deliver')
        return success(c,present(job))
      }
      if(action==='render'&&!job.requested.shots.length)throw Error('请先完成分镜设计')
      job.status='queued';job.error=null;job.message='等待继续制作';production().write(job);runner!.schedule(job.id,action==='render')
      return success(c,present(job))
    }catch(error){return errorResponse(c,error)}
  })
  app.post('/:id/jobs/:jobId/deliver',async c=>{
    try {
      const job=getJob(c);if(!job)return notFound(c,'Motion job not found')
      if(runner!.isRunning(job.id))throw Error('此任务正在运行，请稍后重试')
      current(job)
      if(job.stage!=='rendered'||!job.outputPath)throw Error('当前没有可关联的已验收成片')
      job.status='queued';job.error=null;job.message='等待关联已有成片';production().write(job);runner!.schedule(job.id,'deliver')
      return success(c,present(job))
    }catch(error){return errorResponse(c,error)}
  })
  app.post('/:id/jobs/:jobId/approve',async c=>{
    try{
      const job=getJob(c);if(!job)return notFound(c,'Motion job not found')
      if(job.factory){
        if(runner!.isRunning(job.id))return success(c,present(job))
        current(job)
        if(!job.outputPath||job.stage!=='rendered')throw Error('当前没有可登记的成片，请在 Remotion 继续制作')
        job.status='queued';job.error=null;job.message='等待统一登记成片';production().write(job);runner!.schedule(job.id,'deliver')
        return success(c,present(job))
      }
      let pending=approvals.get(job.id)
      if(!pending){
        if(runner!.isRunning(job.id))throw Error('此任务正在运行，不能确认')
        current(job)
        pending=(async()=>{
          const output=await verifiedMotionOutput(job,production().root)
          current(job)
          try {
            job.plan!.deliveryAssociation=await associateMotionDelivery(job,output,options.delivery,()=>current(job))
            job.status='completed';job.error=null;job.message=job.plan!.deliveryAssociation.message
          } catch(error) {
            const message=(error as Error).message
            job.plan!.deliveryAssociation={status:'failed',message,checkedAt:new Date().toISOString()}
            job.status='failed';job.error=message;job.message='成片已生成，关联失败；可重试关联，无需重新渲染'
          }
          return production().write(job)
        })().finally(()=>approvals.delete(job.id))
        approvals.set(job.id,pending)
      }
      return success(c,present(await pending))
    }catch(error){return errorResponse(c,error)}
  })
  app.on(['GET','HEAD'],'/:id/jobs/:jobId/assets/:assetId',c=>{
    try{const job=getJob(c);if(!job)return notFound(c,'Motion job not found');const asset=Object.values(job.candidates).flat().find(a=>a.assetId===c.req.param('assetId'));if(!asset)return notFound(c,'候选素材不存在');return serveFile(c,production().safeMaterial(asset.localPath))}catch{return notFound(c,'素材文件不可用')}
  })
  app.on(['GET','HEAD'],'/:id/jobs/:jobId/video',c=>{
    try{const job=getJob(c);if(!job?.outputPath)return notFound(c,'成片尚不可用');return serveFile(c,motionOutputFile(job,production().root))}catch{return notFound(c,'成片文件不可用')}
  })
  return app
}
