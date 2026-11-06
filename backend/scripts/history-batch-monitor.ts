import '../src/load-env.js'
import Database from 'better-sqlite3'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {serve} from '@hono/node-server'
import {Hono} from 'hono'
import {createHistoryBatchOutcomesRoute} from '../src/routes/history-batch-outcomes.js'
import {redactHistoryJobMessage} from '../src/services/history-job-message.js'
import {bindSecretKeyToDatabase,decryptSecret} from '../src/services/secret-crypto.js'

const root=fileURLToPath(new URL('../../',import.meta.url))
const filename=process.env.DB_PATH || path.join(root,'data/huobao_drama.db')
const database=new Database(filename,{readonly:true,fileMustExist:true,timeout:3000})
bindSecretKeyToDatabase(filename)
const sanitize=(value:unknown)=>{
  const keys=database.prepare('SELECT api_key FROM ai_service_configs WHERE is_active=1').all() as Array<{api_key:string}>
  return redactHistoryJobMessage(value,keys.map(row=>decryptSecret(row.api_key)))
}
const app=new Hono()
app.route('/api/v1/history-scripts/jobs',createHistoryBatchOutcomesRoute(database,sanitize))
app.get('/health',c=>c.json({status:'ok',service:'history-batch-monitor',readonly:true,pid:process.pid}))
app.onError((_error,c)=>c.json({code:503,message:'批次结果暂不可用，请刷新重试'},503))
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:Number(process.env.HISTORY_BATCH_MONITOR_PORT || 5682)})
const stop=()=>server.close(()=>{database.close();process.exit(0)})
process.once('SIGTERM',stop)
process.once('SIGINT',stop)
