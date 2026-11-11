import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:http'
import {setTimeout as delay} from 'node:timers/promises'
import {createHash} from 'node:crypto'
import Database from 'better-sqlite3'
import {Hono} from 'hono'
import {HistorySocialCandidateReader} from './history-social-candidates-client.js'
import {readHistorySocialCandidates} from './history-social-candidates.js'
import {ensureHistoryStatusSchema,ensureHistoryStatusReadIndexes,repairHistoryStatusBatch} from './history-status-storage.js'
import {HistorySocialUploadService} from './history-social-upload.js'
import {createHistorySocialUploadRoute} from '../routes/history-social-upload.js'

function fixture(t:TestContext) {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'history-candidate-reader-')))
  const databasePath=path.join(directory,'fixture.sqlite'),root=path.join(directory,'static')
  const output=path.join(root,'history-deliveries/1/video.mp4')
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,'validated video')
  const database=new Database(databasePath)
  database.pragma('journal_mode=WAL')
  database.exec(`CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,title TEXT,rewritten_script TEXT,deleted_at TEXT);
    CREATE TABLE history_motion_productions(id TEXT PRIMARY KEY,script_id INTEGER,status TEXT,updated_at TEXT,snapshot TEXT);
    CREATE TABLE history_video_deliveries(id INTEGER PRIMARY KEY,script_id INTEGER,script_sha256 TEXT,producer TEXT,producer_job_id TEXT,video_path TEXT,updated_at TEXT);`)
  const manuscript='A historical manuscript.',hash=createHash('sha256').update(manuscript).digest('hex')
  database.prepare('INSERT INTO history_script_sources VALUES(1,?,?,NULL)').run('Historical source',manuscript)
  database.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)').run('motion',1,'completed','before',
    JSON.stringify({id:'motion',script:manuscript,factory:{scriptHash:hash},status:'completed',message:'Complete'}))
  database.prepare('INSERT INTO history_video_deliveries VALUES(1,1,?,?,?,?,?)').run(hash,'motion','motion','/static/history-deliveries/1/video.mp4','before')
  ensureHistoryStatusSchema(database);ensureHistoryStatusReadIndexes(database);repairHistoryStatusBatch(database)
  const readers:HistorySocialCandidateReader[]=[]
  t.after(async()=>{await Promise.all(readers.map(reader=>reader.close()));database.close();fs.rmSync(directory,{recursive:true,force:true})})
  const reader=(options:Partial<ConstructorParameters<typeof HistorySocialCandidateReader>[0]>={})=>{
    const value=new HistorySocialCandidateReader({databasePath,root,...options});readers.push(value);return value
  }
  const worker=(name:string,body:string)=>{
    const filename=path.join(directory,`${name}.mjs`);fs.writeFileSync(filename,body);return pathToFileURL(filename)
  }
  return {directory,databasePath,database,root,output,reader,worker}
}

test('isolated candidates match synchronous full/scoped results and reread database and actual files after completion',async t=>{
  const h=fixture(t),reader=h.reader(),sentinel=path.join(h.directory,'must-not-open.sqlite')
  const previous=process.env.DB_PATH;process.env.DB_PATH=sentinel
  t.after(()=>{if(previous===undefined)delete process.env.DB_PATH;else process.env.DB_PATH=previous})
  const expected=readHistorySocialCandidates(h.database,h.root,undefined,true)
  assert.equal(expected.length,1)
  assert.equal(expected[0]!.versions[0]!.videoAvailable,true)
  const schema=h.database.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()
  assert.deepEqual(await reader.read(),expected)
  assert.deepEqual(await reader.read([1,1]),expected)
  assert.deepEqual(await reader.read([999]),[])
  assert.equal(fs.existsSync(sentinel),false,'pure reader must not initialize the configured global database')
  assert.deepEqual(h.database.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),schema)
  fs.unlinkSync(h.output)
  const missing=await reader.read()
  assert.equal(missing[0]!.versions[0]!.videoAvailable,false)
  assert.deepEqual(missing,readHistorySocialCandidates(h.database,h.root,undefined,true))
  h.database.exec('ALTER TABLE history_source_status RENAME COLUMN script_sha256 TO unavailable_hash')
  await assert.rejects(reader.read(),{code:'QUERY_FAILED'})
  h.database.exec('ALTER TABLE history_source_status RENAME COLUMN unavailable_hash TO script_sha256')
  assert.deepEqual(await reader.read(),missing,'a failed SQL read must not poison the persistent reader')
  h.database.prepare('UPDATE history_script_sources SET title=?,rewritten_script=? WHERE id=1').run('Edited source','A new manuscript.')
  const stale=await reader.read()
  assert.equal(stale[0]!.title,'Edited source')
  assert.equal(stale[0]!.versions[0]!.canPublish,false)
  assert.deepEqual(stale,readHistorySocialCandidates(h.database,h.root,undefined,true))
})

test('service async display reads use the isolated result while synchronous execution API remains available',async t=>{
  const h=fixture(t),service=new HistorySocialUploadService({database:h.database,root:h.root,recoverOnStartup:false})
  t.after(()=>service.close())
  const previous=process.env.HISTORY_STATUS_READS;process.env.HISTORY_STATUS_READS='1'
  t.after(()=>{if(previous===undefined)delete process.env.HISTORY_STATUS_READS;else process.env.HISTORY_STATUS_READS=previous})
  const expected=service.candidates()
  t.mock.method(service,'candidates',()=>{throw Error('HTTP display must not execute synchronously')})
  assert.deepEqual(await service.candidatesAsync(),expected)
  await assert.rejects(service.candidatesAsync([]),{status:400})
})

test('only overlapping identical reads are shared and unrelated scopes remain independent',async t=>{
  const h=fixture(t),reader=h.reader({workerPath:h.worker('counter',`
    let count=0;process.on('message',message=>{
      if(message.type==='initialize')process.send({type:'ready'});
      else if(message.type==='read'){const value=++count;setTimeout(()=>process.send({type:'result',id:message.id,ok:true,items:[{count:value}]}),20)}
    });`),maxPending:2})
  const first=reader.read([2,1]),same=reader.read([1,2,1]),other=reader.read([3])
  assert.equal(first,same)
  await assert.rejects(reader.read([4]),{code:'BUSY'})
  assert.deepEqual(await first,[{count:1}]);assert.deepEqual(await other,[{count:2}])
  assert.deepEqual(await reader.read([1,2]),[{count:3}])
})

test('a synchronous stalled child does not delay concurrent HTTP health and close terminates it',async t=>{
  const h=fixture(t),marker=path.join(h.directory,'started')
  const reader=h.reader({workerPath:h.worker('blocked',`
    import fs from 'node:fs';
    process.on('message',message=>{
      if(message.type==='initialize')process.send({type:'ready'});
      else if(message.type==='read'){fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)}
    });`)})
  const service=new HistorySocialUploadService({database:h.database,root:h.root,recoverOnStartup:false})
  ;(service as unknown as {candidateReader:HistorySocialCandidateReader}).candidateReader=reader
  const previous=process.env.HISTORY_STATUS_READS;process.env.HISTORY_STATUS_READS='1'
  t.after(async()=>{await service.close();if(previous===undefined)delete process.env.HISTORY_STATUS_READS;else process.env.HISTORY_STATUS_READS=previous})
  const app=new Hono();app.get('/health',c=>c.text('ok'));app.route('/uploads',createHistorySocialUploadRoute({service}))
  const server=createServer((request,response)=>{
    void Promise.resolve(app.request(request.url!)).then(async result=>{
      response.writeHead(result.status);response.end(await result.text())
    },()=>response.writeHead(500).end())
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
  const address=server.address();assert.ok(address && typeof address!=='string')
  const origin=`http://127.0.0.1:${address.port}`
  const pending=fetch(`${origin}/uploads/candidates`)
  for(let tries=0;!fs.existsSync(marker) && tries<300;tries++)await delay(10)
  assert.ok(fs.existsSync(marker),'read worker must enter its synchronous stall')
  const start=performance.now(),health=await fetch(`${origin}/health`)
  assert.equal(await health.text(),'ok');assert.ok(performance.now()-start<1000)
  const pid=Number(fs.readFileSync(marker,'utf8')),stop=performance.now()
  await reader.close()
  assert.ok(performance.now()-stop<1000,'close must not wait for stalled synchronous JavaScript')
  assert.equal((await pending).status,503)
  assert.throws(()=>process.kill(pid,0))
  await assert.rejects(reader.read(),{code:'CLOSED'})
})

test('startup, query, process and protocol failures reject without synchronous fallback and permit fresh child startup',async t=>{
  const h=fixture(t)
  const missing=h.reader({databasePath:path.join(h.directory,'absent.sqlite')})
  await assert.rejects(missing.read(),{code:'STARTUP_FAILED'})
  assert.equal(fs.existsSync(path.join(h.directory,'absent.sqlite')),false)
  const silent=h.reader({workerPath:h.worker('silent','process.on("message",()=>{})'),startupTimeoutMs:50})
  await assert.rejects(silent.read(),{code:'STARTUP_TIMEOUT'})
  const crashed=h.reader({workerPath:h.worker('crashed','process.exit(17)')})
  await assert.rejects(crashed.read(),{code:'PROCESS_EXITED'})
  const broken=h.reader({workerPath:h.worker('broken',`
    process.on('message',message=>{if(message.type==='initialize')process.send({type:'ready'});
    else process.send({type:'result',id:message.id,ok:true,items:{invalid:true}})})`)})
  await assert.rejects(broken.read(),{code:'QUERY_FAILED'})
  const retry=path.join(h.directory,'retry')
  const timed=h.reader({queryTimeoutMs:50,workerPath:h.worker('timeout',`
    import fs from 'node:fs';process.on('message',message=>{
      if(message.type==='initialize')process.send({type:'ready'});
      else if(!fs.existsSync(${JSON.stringify(retry)})){fs.writeFileSync(${JSON.stringify(retry)},'retry');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)}
      else process.send({type:'result',id:message.id,ok:true,items:[]})
    })`)})
  await assert.rejects(timed.read(),{code:'QUERY_TIMEOUT'})
  assert.deepEqual(await timed.read(),[])
})
