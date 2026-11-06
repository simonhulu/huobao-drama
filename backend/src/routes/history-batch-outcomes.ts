import {Hono} from 'hono'
import type Database from 'better-sqlite3'
import {getHistoryBatchOutcomes} from '../services/history-batch-outcomes.js'
import {badRequest,notFound,success} from '../utils/response.js'

export function createHistoryBatchOutcomesRoute(database:Database.Database,sanitize:(value:unknown)=>string) {
  const app=new Hono()
  app.get('/:id/outcomes',c=>{
    c.header('Cache-Control','no-store')
    const rawId=c.req.param('id'),rawOffset=c.req.query('offset'),rawLimit=c.req.query('limit')
    const id=/^\d+$/.test(rawId) ? Number(rawId) : NaN
    const offset=rawOffset===undefined ? 0 : /^\d+$/.test(rawOffset) ? Number(rawOffset) : NaN
    const limit=rawLimit===undefined ? 50 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN
    if(!Number.isSafeInteger(id) || id<1 || !Number.isSafeInteger(offset) || offset<0
      || !Number.isSafeInteger(limit) || limit<1 || limit>100)return badRequest(c,'Invalid batch outcome pagination')
    const outcomes=getHistoryBatchOutcomes(database,id,{offset,limit})
    if(!outcomes)return notFound(c,'History sourcing job not found')
    return success(c,{...outcomes,items:outcomes.items.map(item=>({...item,
      lastError:item.lastError ? sanitize(item.lastError) : null,
      historicalFailure:item.historicalFailure ? {...item.historicalFailure,message:sanitize(item.historicalFailure.message)} : null,
      versions:item.versions.map(version=>({...version,message:sanitize(version.message),error:version.error ? sanitize(version.error) : null})),
      health:item.health.map(activity=>({...activity,message:sanitize(activity.message)})),
    }))})
  })
  return app
}
