import {Hono} from 'hono'
import {z} from 'zod'
import {getHistoryFactory} from '../services/history-factory.js'
import {getHistorySource} from '../services/history-script-library.js'
import {motionProfileSchema} from '../services/history-motion-production.js'
import {badRequest,notFound,success} from '../utils/response.js'

const requestSchema=z.object({profile:motionProfileSchema.optional()}).strict()
const episodeRequestSchema=requestSchema.extend({voiceId:z.string().trim().min(1).max(200).optional()})
const sourceSchema=requestSchema.extend({sourceId:z.number().int().positive(),scriptRevision:z.string().regex(/^[a-f0-9]{64}$/).optional()})
export function createHistoryFactoryRoute(factory=getHistoryFactory) {
  const app=new Hono()
  app.get('/history-productions',c=>success(c,factory().list()))
  app.post('/history-productions',async c=>{
    try {
      const body=sourceSchema.parse(await c.req.json()),source=getHistorySource(body.sourceId)
      if(!source)return notFound(c,'稿件不存在')
      return success(c,await factory().startFromSource(source,{profile:body.profile || '16:9',revision:body.scriptRevision,restoreDeleted:true}))
    } catch(error){return badRequest(c,(error as Error).message)}
  })
  app.get('/episodes/:id/history-production',c=>{
    try {return success(c,factory().detail(Number(c.req.param('id'))))}
    catch(error){return notFound(c,(error as Error).message)}
  })
  app.delete('/episodes/:id/history-production',c=>{
    const id=Number(c.req.param('id'))
    if(!Number.isSafeInteger(id)||id<=0)return badRequest(c,'工作 ID 无效')
    try {return success(c,factory().remove(id))}
    catch(error) {
      const message=(error as Error).message
      return (error as {status?:number}).status===409?c.json({code:409,message},409):notFound(c,message)
    }
  })
  for(const action of ['start','retry','rebuild'] as const)app.post(`/episodes/:id/history-production/${action}`,async c=>{
    try {
      const id=Number(c.req.param('id'))
      if(!Number.isSafeInteger(id)||id<=0)return badRequest(c,'工作 ID 无效')
      const body=episodeRequestSchema.parse(await c.req.json().catch(()=>({})))
      return success(c,await factory().startEpisode(id,{...body,retry:action==='retry',rebuild:action==='rebuild'}))
    } catch(error){return badRequest(c,(error as Error).message)}
  })
  app.get('/episodes/:id/history-production/evidence',c=>{
    try {
      const detail=factory().detail(Number(c.req.param('id')))
      c.header('Content-Disposition',`attachment; filename="history-episode-${detail.episode.id}-decisions.json"`)
      return c.json(detail)
    } catch(error){return notFound(c,(error as Error).message)}
  })
  return app
}
