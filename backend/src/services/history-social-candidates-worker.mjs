import Database from 'better-sqlite3'
import {tsImport} from 'tsx/esm/api'

let database
process.once('disconnect', () => {database?.close(); process.exit()})
process.once('message', async input => {
  try {
    if(input?.type!=='initialize' || typeof input.databasePath!=='string' || typeof input.root!=='string') throw Error('Invalid initialization')
    const {readHistorySocialCandidates}=await tsImport('./history-social-candidates.ts',import.meta.url)
    database=new Database(input.databasePath,{readonly:true,fileMustExist:true,timeout:1000})
    database.pragma('query_only=ON')
    process.on('message', request => {
      if(request?.type!=='read' || !Number.isSafeInteger(request.id)) return
      const ids=request.sourceIds
      if(ids!==undefined && (!Array.isArray(ids) || !ids.length || ids.length>100 || ids.some(id=>!Number.isSafeInteger(id) || id<1))) {
        process.send?.({type:'result',id:request.id,ok:false}); return
      }
      try {process.send?.({type:'result',id:request.id,ok:true,items:readHistorySocialCandidates(database,input.root,ids,true)})}
      catch {process.send?.({type:'result',id:request.id,ok:false})}
    })
    process.send?.({type:'ready'})
  } catch {process.send?.({type:'startup-error'},()=>process.disconnect?.())}
})
