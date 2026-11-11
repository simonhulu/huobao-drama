import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureHistoryStatusSchema, projectHistoryMotionStatus, projectHistorySourceStatus,
  repairHistoryStatusBatch, getHistoryStatusCoverage, ensureHistoryStatusReadIndexes } from './history-status-storage.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture(filename=':memory:', verbose?: (sql:unknown)=>void) {
  const db = new Database(filename,{verbose})
  db.exec(`CREATE TABLE history_motion_productions(id TEXT PRIMARY KEY,script_id INTEGER,status TEXT,updated_at TEXT,snapshot TEXT);
    CREATE TABLE history_script_sources(id INTEGER PRIMARY KEY,platform TEXT,source_video_id TEXT,source_url TEXT,
      raw_transcript TEXT,corrected_transcript TEXT,rewritten_script TEXT,media_json TEXT,asr_json TEXT,review_json TEXT,
      deleted_at TEXT,updated_at TEXT,last_error TEXT);`)
  return db
}
const job = (script: unknown = 'current script') => ({id:'motion-1',scriptId:1,status:'planning',stage:'images',message:'Preparing images',
  script,factory:{scriptHash:null},requested:{shots:[{},{}]},plan:{visuals:{one:{}}},updatedAt:'2026-11-11T00:00:00Z'})

test('schema initialization leaves historical payloads pending until bounded resumable backfill', t => {
  const db = fixture(); t.after(() => db.close())
  for (let id=1;id<=3;id++) db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)')
    .run(String(id),id,'planning','now',JSON.stringify({...job(),id:String(id)}))
  ensureHistoryStatusSchema(db)
  assert.deepEqual(getHistoryStatusCoverage(db).motion,{total:3,current:0,pending:3})
  assert.equal(repairHistoryStatusBatch(db,{limit:1}).motion,1)
  assert.deepEqual(getHistoryStatusCoverage(db).motion,{total:3,current:1,pending:2})
  assert.equal(repairHistoryStatusBatch(db,{limit:2}).motion,2)
  assert.equal(repairHistoryStatusBatch(db,{limit:2}).motion,0)
  assert.deepEqual(getHistoryStatusCoverage(db).motion,{total:3,current:3,pending:0})
})

test('motion summary preserves identity tags and compact counts while original and summary roll back together', t => {
  const db = fixture(); t.after(() => db.close()); ensureHistoryStatusSchema(db)
  const value = job()
  db.transaction(() => {
    db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)').run(value.id,1,'planning','now',JSON.stringify(value))
    assert.equal(projectHistoryMotionStatus(db,value.id,value),true)
  })()
  const summary = db.prepare('SELECT * FROM history_motion_status').get() as any
  assert.equal(summary.script_type,'text'); assert.equal(summary.script_text_sha256,hash('current script'))
  assert.equal(summary.factory_hash_type,'null'); assert.equal(summary.factory_script_hash,null)
  assert.equal(summary.shot_count,2); assert.equal(summary.ready_shot_count,1)
  assert.equal(summary.input_revision,summary.projected_revision)
  assert.throws(() => db.transaction(() => {
    db.prepare("UPDATE history_motion_productions SET snapshot=? WHERE id=?").run(JSON.stringify({...value,message:'rollback'}),value.id)
    projectHistoryMotionStatus(db,value.id,{...value,message:'rollback'})
    throw Error('abort')
  })(),/abort/)
  assert.equal((db.prepare('SELECT message FROM history_motion_status').get() as any).message,'Preparing images')
})

test('legacy writes invalidate summaries and stale repair cannot overwrite newer input or reinserted identity', t => {
  const db = fixture(); t.after(() => db.close()); ensureHistoryStatusSchema(db)
  db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)').run('motion-1',1,'planning','now',JSON.stringify(job()))
  repairHistoryStatusBatch(db)
  const first = db.prepare('SELECT input_revision FROM history_motion_status').get() as any
  db.prepare('UPDATE history_motion_productions SET snapshot=? WHERE id=?').run(JSON.stringify({...job(),message:'new progress'}),'motion-1')
  assert.equal(projectHistoryMotionStatus(db,'motion-1',job(),first.input_revision),false)
  assert.equal(getHistoryStatusCoverage(db).motion.pending,1)
  repairHistoryStatusBatch(db)
  assert.equal((db.prepare('SELECT message FROM history_motion_status').get() as any).message,'new progress')
  const previous = db.prepare('SELECT input_revision FROM history_motion_status').get() as any
  db.prepare('DELETE FROM history_motion_productions WHERE id=?').run('motion-1')
  db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)').run('motion-1',1,'planning','now',JSON.stringify({...job(),script:null,factory:{}}))
  assert.equal(projectHistoryMotionStatus(db,'motion-1',job(),previous.input_revision),false)
  repairHistoryStatusBatch(db)
  const current = db.prepare('SELECT * FROM history_motion_status').get() as any
  assert.ok(current.input_revision>previous.input_revision)
  assert.equal(current.script_type,'null'); assert.equal(current.factory_hash_type,'missing')
})

test('source validity is persisted on input changes while observation-only updates stay current', t => {
  const db = fixture(); t.after(() => db.close()); ensureHistoryStatusSchema(db)
  const raw='source text', corrected='corrected text', rewritten='rewritten text'
  db.prepare('INSERT INTO history_script_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(1,'baijiahao','123',
    'https://baijiahao.baidu.com/s?id=123',raw,corrected,rewritten,
    JSON.stringify({kind:'article',articleId:'123',sourceUrl:'https://baijiahao.baidu.com/s?id=123',textSha256:hash(raw)}),null,
    JSON.stringify({factCheckStatus:'needs_sources',rawTranscriptSha256:hash(raw),correctedTranscriptSha256:hash(corrected),rewriteInputSha256:hash(corrected)}),null,'now',null)
  projectHistorySourceStatus(db,1)
  const current = db.prepare('SELECT * FROM history_source_status').get() as any
  assert.equal(current.rewritten_state,'current'); assert.equal(current.script_sha256,hash(rewritten))
  db.prepare("UPDATE history_script_sources SET updated_at='later',last_error='observation' WHERE id=1").run()
  assert.equal(getHistoryStatusCoverage(db).sources.pending,0)
  db.prepare("UPDATE history_script_sources SET corrected_transcript='changed' WHERE id=1").run()
  assert.equal(getHistoryStatusCoverage(db).sources.pending,1)
  repairHistoryStatusBatch(db)
  assert.equal((db.prepare('SELECT rewritten_state FROM history_source_status').get() as any).rewritten_state,'stale')
})

test('queue-marker changes do not reparse unchanged ASR provenance', t => {
  const db=fixture();t.after(()=>db.close());ensureHistoryStatusSchema(db)
  const review={factCheckStatus:'needs_sources',rawTranscriptSha256:hash('raw'),correctedTranscriptSha256:hash('corrected'),rewriteInputSha256:hash('corrected')}
  db.prepare('INSERT INTO history_script_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(1,'baijiahao','123',
    'https://baijiahao.baidu.com/s?id=123','raw','corrected','rewritten',
    JSON.stringify({kind:'article',articleId:'123',sourceUrl:'https://baijiahao.baidu.com/s?id=123',textSha256:hash('raw')}),
    JSON.stringify({debug:'x'.repeat(1024*1024)}),JSON.stringify(review),null,'now',null)
  projectHistorySourceStatus(db,1)
  db.prepare('UPDATE history_script_sources SET review_json=? WHERE id=1').run(JSON.stringify({...review,huashengQueue:{status:'pending'}}))
  const parse=JSON.parse,sizes:number[]=[]
  t.mock.method(JSON,'parse',(text:string)=>{sizes.push(text.length);return parse(text)})
  projectHistorySourceStatus(db,1)
  assert.ok(sizes.every(size=>size<4096),'Unchanged ASR should not be parsed again for queue notes')
  assert.equal(getHistoryStatusCoverage(db).sources.pending,0)
})

test('legacy nonstring display fields cannot stall status backfill', t => {
  const db=fixture();t.after(()=>db.close());ensureHistoryStatusSchema(db)
  const legacy={...job(),stage:{name:'images'},message:{detail:'legacy message'},error:['legacy error'],
    plan:{deliveryAssociation:{videoUrl:{legacy:'/static/video.mp4'}}}}
  db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)').run('motion-1',1,'planning','now',JSON.stringify(legacy))
  assert.equal(repairHistoryStatusBatch(db).motion,1)
  const summary=db.prepare('SELECT * FROM history_motion_status').get() as any
  assert.equal(summary.message,JSON.stringify(legacy.message))
  assert.equal(getHistoryStatusCoverage(db).motion.pending,0)
})

test('coverage uses one WAL snapshot when another connection commits between its counts', t => {
  const root=mkdtempSync(path.join(tmpdir(),'history-status-coverage-')),filename=path.join(root,'jobs.sqlite')
  const writer=fixture(filename)
  writer.pragma('journal_mode=WAL');ensureHistoryStatusSchema(writer)
  const seed=(id:number)=>writer.transaction(()=>{
    const value={...job(),id:String(id),scriptId:id}
    writer.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)').run(value.id,id,'planning','now',JSON.stringify(value))
    writer.prepare('INSERT INTO history_script_sources(id,rewritten_script) VALUES(?,?)').run(id,'Current script')
    projectHistoryMotionStatus(writer,value.id,value);projectHistorySourceStatus(writer,id)
  })()
  seed(1)
  let armed=true,interleaved=false
  const reader=new Database(filename,{verbose:sql=>{
    if(armed && /FROM history_motion_productions p JOIN history_motion_status/.test(String(sql))) {
      armed=false;seed(2);interleaved=true
    }
  }})
  t.after(()=>{reader.close();writer.close();rmSync(root,{recursive:true,force:true})})
  assert.deepEqual(getHistoryStatusCoverage(reader),{
    motion:{total:1,current:1,pending:0},sources:{total:1,current:1,pending:0},
  })
  assert.equal(interleaved,true,'The writer must commit during coverage collection')
  assert.deepEqual(getHistoryStatusCoverage(reader),{
    motion:{total:2,current:2,pending:0},sources:{total:2,current:2,pending:0},
  })
})

test('maintenance installs covering metadata indexes without changing query values or numeric identities', t => {
  const db=fixture();t.after(()=>db.close())
  db.exec(`ALTER TABLE history_script_sources ADD COLUMN title TEXT;
    CREATE TABLE history_huasheng_jobs(id INTEGER PRIMARY KEY,source_id INTEGER,title TEXT,script TEXT,
      script_sha256 TEXT,status TEXT,production_status TEXT,production_message TEXT,message TEXT,error TEXT,updated_at TEXT);
    CREATE TABLE history_script_deliveries(script_id INTEGER PRIMARY KEY,title TEXT,video_path TEXT,updated_at TEXT);`)
  ensureHistoryStatusSchema(db)
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name LIKE '%_status_cover'").get() as any).count,0,
    'Normal schema initialization must not build indexes over historical data')
  db.prepare('INSERT INTO history_script_sources(id,title,rewritten_script,deleted_at) VALUES(1,?,?,NULL)').run('Title','Draft')
  db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)').run('motion-1',1,'planning','now',JSON.stringify(job()))
  db.prepare('INSERT INTO history_huasheng_jobs VALUES(1,1,?,?,?,?,?,?,?,?,?)').run('Title','Large script',hash('Draft'),'submitted','creating','Creating','Working',null,'now')
  db.prepare('INSERT INTO history_script_deliveries VALUES(1,?,?,?)').run('Title','/static/video.mp4','now')
  const queries=[
    {table:'history_script_sources',index:'history_script_sources_status_cover',sql:'SELECT id,title,deleted_at FROM history_script_sources WHERE deleted_at IS NULL ORDER BY id DESC'},
    {table:'history_script_sources',index:'history_script_sources_list_order',sql:'SELECT id,updated_at,deleted_at FROM history_script_sources WHERE deleted_at IS NULL ORDER BY updated_at DESC,id DESC'},
    {table:'history_motion_productions',index:'history_motion_productions_status_cover',sql:'SELECT id,script_id,status,updated_at FROM history_motion_productions WHERE script_id IN (1,2)'},
    {table:'history_huasheng_jobs',index:'history_huasheng_jobs_status_cover',sql:'SELECT id,source_id,script_sha256,status,production_status,production_message,message,error,updated_at FROM history_huasheng_jobs WHERE source_id IN (1,2)'},
    {table:'history_script_deliveries',index:'history_script_deliveries_status_cover',sql:'SELECT script_id,video_path,updated_at FROM history_script_deliveries WHERE script_id IN (1,2)'},
  ]
  const before=queries.map(query=>db.prepare(query.sql).all())
  const installed=ensureHistoryStatusReadIndexes(db)
  assert.deepEqual(new Set(installed.created),new Set(queries.map(query=>query.index)))
  assert.deepEqual(installed.skipped,[])
  for(const [offset,query] of queries.entries()) {
    const sql=query.sql.replace(`FROM ${query.table}`,`FROM ${query.table} INDEXED BY ${query.index}`)
    assert.deepEqual(db.prepare(sql).all(),before[offset])
    const plan=db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as {detail:string}[]
    assert.ok(plan.some(row=>row.detail.includes(`COVERING INDEX ${query.index}`)),JSON.stringify(plan))
    const indexed=db.pragma(`index_info(${query.index})`) as {name:string}[]
    assert.ok(indexed.every(column=>!['snapshot','script','payload_json','asr_json','review_json'].includes(column.name)))
  }
  assert.equal(typeof (before[3]![0] as any).id,'number')
  assert.deepEqual(new Set(ensureHistoryStatusReadIndexes(db).existing),new Set(queries.map(query=>query.index)))
})

test('maintenance index installation skips absent and partial module schemas', t => {
  const db=fixture();t.after(()=>db.close())
  const result=ensureHistoryStatusReadIndexes(db)
  assert.deepEqual(result.created,['history_script_sources_list_order','history_motion_productions_status_cover'])
  assert.equal(result.skipped.length,3)
})

test('source list ordering uses its index before reading paginated wide records', t => {
  const db=fixture();t.after(()=>db.close())
  const insert=db.prepare('INSERT INTO history_script_sources(id,asr_json,updated_at,deleted_at) VALUES(?,?,?,?)')
  for(let id=1;id<=12;id++) insert.run(id,JSON.stringify({payload:'x'.repeat(128*1024)}),
    `2026-11-11T00:00:${String(Math.floor(id/2)).padStart(2,'0')}Z`,id===12?'deleted':null)
  const query='SELECT * FROM history_script_sources WHERE deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?'
  const first=db.prepare(query).all(1,0),page=db.prepare(query).all(3,3)
  assert.ok((db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(1,0) as {detail:string}[])
    .some(row=>row.detail.includes('TEMP B-TREE')))
  ensureHistoryStatusReadIndexes(db)
  assert.deepEqual(db.prepare(query).all(1,0),first)
  assert.deepEqual(db.prepare(query).all(3,3),page)
  assert.deepEqual(first.map(row=>(row as {id:number}).id),[11])
  const plan=db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(1,0) as {detail:string}[]
  assert.ok(plan.some(row=>row.detail.includes('history_script_sources_list_order')),JSON.stringify(plan))
  assert.ok(!plan.some(row=>row.detail.includes('TEMP B-TREE')),JSON.stringify(plan))
})

test('idle maintenance reads original source identities only through installed metadata indexes', t => {
  const statements:string[]=[],db=fixture(':memory:',sql=>statements.push(String(sql)))
  t.after(()=>db.close())
  db.exec('ALTER TABLE history_script_sources ADD COLUMN title TEXT')
  ensureHistoryStatusSchema(db);ensureHistoryStatusReadIndexes(db)
  db.prepare('INSERT INTO history_script_sources(id,title,rewritten_script,asr_json) VALUES(1,?,?,?)')
    .run('Title','Draft',JSON.stringify({unused:'x'.repeat(128*1024)}))
  db.prepare('INSERT INTO history_motion_productions VALUES(?,?,?,?,?)').run('motion-1',1,'planning','now',JSON.stringify({...job(),plan:{unused:'x'.repeat(128*1024)}}))
  repairHistoryStatusBatch(db)
  statements.length=0
  assert.deepEqual(repairHistoryStatusBatch(db),{motion:0,sources:0,remaining:{motion:0,sources:0}})
  const sourceQueries=statements.filter(sql=>/^(?:SELECT|INSERT)/.test(sql) && /(?:FROM|JOIN) history_script_sources(?: |$)/.test(sql))
  assert.ok(sourceQueries.length>=3)
  for(const sql of sourceQueries) {
    const plan=db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as {detail:string}[]
    assert.ok(plan.some(row=>['history_script_sources_status_cover','history_script_sources_list_order']
      .some(index=>row.detail.includes(`COVERING INDEX ${index}`))),JSON.stringify({sql,plan}))
    assert.ok(!plan.some(row=>/^(?:SCAN|SEARCH) (?:p|history_script_sources)(?: |$)/.test(row.detail)
      && !row.detail.includes('COVERING INDEX')),JSON.stringify({sql,plan}))
  }
  assert.ok(!statements.some(sql=>/^SELECT (?:p\.\*|\*)/.test(sql) && /FROM history_(?:script_sources|motion_productions)/.test(sql)),
    'Current summaries must not execute payload reads')
  db.prepare("UPDATE history_script_sources SET rewritten_script='Updated draft' WHERE id=1").run()
  assert.equal(repairHistoryStatusBatch(db).sources,1)
  assert.equal(getHistoryStatusCoverage(db).sources.pending,0)
})

test('pending batch selection skips deletion tombstones and still repairs soft-deleted existing sources', t => {
  const db=fixture();t.after(()=>db.close());ensureHistoryStatusSchema(db)
  db.prepare('INSERT INTO history_script_sources(id,rewritten_script) VALUES(1,?)').run('Old draft')
  repairHistoryStatusBatch(db)
  db.prepare('DELETE FROM history_script_sources WHERE id=1').run()
  db.prepare('INSERT INTO history_script_sources(id,rewritten_script,deleted_at) VALUES(2,?,?)').run('Saved draft','deleted')
  assert.equal(repairHistoryStatusBatch(db,{limit:1}).sources,1)
  const source=db.prepare('SELECT * FROM history_source_status WHERE source_id=2').get() as any
  assert.equal(source.deleted,1)
  db.prepare('UPDATE history_source_status SET schema_version=0 WHERE source_id=2').run()
  assert.equal(repairHistoryStatusBatch(db,{limit:1}).sources,1)
  assert.equal(getHistoryStatusCoverage(db).sources.pending,0)
})
