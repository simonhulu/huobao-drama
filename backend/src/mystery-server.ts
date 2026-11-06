// Optional local rollout while the main backend is processing other workspaces.
import './load-env.js'
import { installGlobalJsonRepair } from './utils/json-repair.js'
installGlobalJsonRepair()
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import mysteryStories from './routes/mystery-stories.js'
import { registerMysteryStoryHandlers } from './services/tasks/handlers/mystery-stories.js'
import { startTaskWorkerLoop } from './services/tasks/worker.js'
import { listTasks, transitionTaskWithExpiredLease } from './services/tasks/store.js'

registerMysteryStoryHandlers()
const types=['mystery.workflow','mystery.collection']
function recover() {
  const cutoff=Date.now()
  for(const type of types)for(const task of listTasks({type,status:'running'})) {
    if(task.leaseExpiresAt&&Date.parse(task.leaseExpiresAt)>cutoff)continue
    transitionTaskWithExpiredLease(task,task.cancelRequested?'canceled':task.attempts>=3?'stale':'queued',
      {progressMessage:task.cancelRequested?'保留用户停止状态':'继续奇闻故事原任务及检查点'},cutoff)
  }
}
const app=new Hono()
app.get('/health',c=>c.json({status:'ok',workspace:'mystery-stories'}))
app.route('/api/v1/mystery-stories',mysteryStories)
const port=Number(process.env.MYSTERY_PORT||5682)
let worker:ReturnType<typeof startTaskWorkerLoop>|undefined
let recovery:ReturnType<typeof setInterval>|undefined
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port},()=>{
  if(process.env.TASK_WORKER_DISABLED!=='1') {
    recover()
    worker=startTaskWorkerLoop({workerId:`mystery-${process.pid}`,types,concurrency:3,leaseMs:120_000,runMaintenance:false})
    recovery=setInterval(recover,30_000);recovery.unref()
  }
  console.log(`Mystery stories listening on http://127.0.0.1:${port}`)
})
const stop=()=>{if(recovery)clearInterval(recovery);server.close();void(worker?.stop(10_000)||Promise.resolve()).then(()=>process.exit(0))}
process.once('SIGINT',stop);process.once('SIGTERM',stop)
