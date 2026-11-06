import '../src/load-env.js'
import Database from 'better-sqlite3'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import { createStorageManager, STORAGE_KINDS, type StorageKind } from '../src/services/storage-management.js'
import { createStorageRoute } from '../src/routes/storage.js'
import { ensurePublishedMediaInputIndexes } from '../src/services/storage-published-media.js'

const projectRoot=path.resolve(process.env.STORAGE_PROJECT_ROOT || fileURLToPath(new URL('../../',import.meta.url)))
const database=new Database(process.env.DB_PATH || path.join(projectRoot,'data/huobao_drama.db'),{fileMustExist:true,timeout:30_000})
const manager=createStorageManager({db:database,projectRoot,prepareInputIndexes:true})
const command=process.argv[2] || 'scan'
if (command==='serve') {
  const {serve}=await import('@hono/node-server')
  const {Hono}=await import('hono')
  const app=new Hono()
  app.route('/api/v1/storage',createStorageRoute(async()=>manager))
  const worker=manager.start()
  const workerStatus=()=>({service:'storage-maintenance',pid:process.pid,uptimeSeconds:Math.floor(process.uptime()),...manager.runtime()})
  app.get('/health',c=>c.json({status:worker.status().state==='retrying' ? 'degraded' : 'ok',...workerStatus()}))
  app.get('/api/v1/storage/worker',c=>c.json(workerStatus()))
  const server=serve({fetch:app.fetch,port:Number(process.env.STORAGE_PORT || 5681),hostname:'127.0.0.1'})
  console.log('Storage maintenance: http://127.0.0.1:'+String(process.env.STORAGE_PORT || 5681))
  let stopping=false
  const stop=async()=>{
    if(stopping)return
    stopping=true
    const closed=new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()))
    await worker.stop();await closed;database.close();process.exit(0)
  }
  process.once('SIGTERM',()=>{void stop().catch(error=>{console.error('[storage] shutdown',error);process.exit(1)})})
  process.once('SIGINT',()=>{void stop().catch(error=>{console.error('[storage] shutdown',error);process.exit(1)})})
} else if(command==='prepare-indexes') {
  console.log(JSON.stringify({indexes:ensurePublishedMediaInputIndexes(database)},null,2))
  database.close()
} else if (command==='scan' || command==='cleanup') {
  const selected=process.argv.find(argument=>argument.startsWith('--kinds='))?.slice('--kinds='.length).split(',')
  if (selected?.some(kind=>!STORAGE_KINDS.includes(kind as StorageKind))) throw Error('Unknown cleanup kind')
  const report=command==='scan' ? await manager.scan() : await manager.cleanup(selected as StorageKind[] | undefined)
  const reportFile=process.argv.find(argument=>argument.startsWith('--report='))?.slice('--report='.length)
  if (reportFile) {
    const fs=await import('node:fs/promises'),path=await import('node:path')
    await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2))
  }
  const output=process.argv.includes('--full') ? report : {...report,items:report.items.slice(0,12),lastRun:report.lastRun && {...report.lastRun,actions:report.lastRun.actions.slice(0,12)}}
  console.log(JSON.stringify(output,null,2))
  database.close()
  process.exit(0)
} else throw Error('Usage: storage-maintenance.ts scan|cleanup|serve|prepare-indexes [--kinds=duplicate-material,render-cache,transcribed-source,published-video] [--full]')
