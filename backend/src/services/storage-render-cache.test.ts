import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHistoryMotionRenderCacheGuard} from './storage-render-cache.js'

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'render-cache-refs-')))
  const id = '11111111-1111-1111-1111-111111111111'
  const output = path.join(root,'data/storage/history-motion',id,'render-one/movie.mp4')
  const filename = output+'.render/public/assets/0001.mp4'
  const bundleIndex = output+'.render/bundle/index.html'
  fs.mkdirSync(path.join(root,'data'),{recursive:true})
  const database = new Database(path.join(root,'data/huobao_drama.db'))
  database.exec(`CREATE TABLE storage_artifacts(id INTEGER PRIMARY KEY,path TEXT,pinned INTEGER);
    CREATE TABLE storage_artifact_refs(artifact_id INTEGER,owner_type TEXT,owner_id TEXT,purpose TEXT,state TEXT);
    CREATE TABLE history_motion_productions(id TEXT,script_id INTEGER,snapshot TEXT);
    CREATE TABLE remotion_assets(project_id INTEGER,local_path TEXT);`)
  database.prepare('INSERT INTO storage_artifacts VALUES(1,?,0)').run(filename)
  database.prepare('INSERT INTO storage_artifacts VALUES(2,?,0)').run(bundleIndex)
  database.prepare('INSERT INTO history_motion_productions VALUES(?,17,?)').run(id,JSON.stringify({outputPath:output,
    plan:{delivery:{assets:[{source:filename}]},deliveryAssociation:{videoPath:filename},shots:[{sourcePath:'/original/movie.mp4'}]}}))
  database.prepare("INSERT INTO storage_artifact_refs VALUES(1,'history-motion',?,'intermediate','rendering')").run(id)
  database.exec("INSERT INTO storage_artifact_refs VALUES(1,'history-source','17','intermediate','ready')")
  database.prepare("INSERT INTO storage_artifact_refs VALUES(2,'history-motion',?,'project','rendering')").run(id)
  database.exec("INSERT INTO storage_artifact_refs VALUES(2,'history-source','17','project','ready')")
  const guard = createHistoryMotionRenderCacheGuard(output,[filename,bundleIndex],{projectRoot:root})
  t.after(()=>{guard.close();database.close();fs.rmSync(root,{recursive:true,force:true})})
  return {root,id,output,filename,database,guard}
}

test('own intermediate bookkeeping and delivery reports do not block cleanup; input dependencies do',t=>{
  const f=fixture(t)
  assert.doesNotThrow(()=>f.guard.assertUnreferenced())
  f.database.exec("UPDATE storage_artifact_refs SET purpose='source' WHERE owner_type='history-motion'")
  assert.throws(()=>f.guard.assertUnreferenced(),/shared input reference/)
  f.database.exec("UPDATE storage_artifact_refs SET purpose='intermediate'")
  f.database.prepare('UPDATE history_motion_productions SET snapshot=?').run(JSON.stringify({plan:{shots:[{sourcePath:f.filename}]}}))
  assert.throws(()=>f.guard.assertUnreferenced(),/shared input reference/)
})

test('changes after the first group check are re-read before deletion',t=>{
  const f=fixture(t)
  assert.doesNotThrow(()=>f.guard.assertUnreferenced())
  assert.doesNotThrow(()=>f.guard.assertUnreferenced())
  f.database.exec('UPDATE storage_artifacts SET pinned=1')
  assert.throws(()=>f.guard.assertUnreferenced(),/pinned/)
  f.database.exec('UPDATE storage_artifacts SET pinned=0')
  f.database.prepare('INSERT INTO remotion_assets VALUES(29,?)').run(f.filename)
  assert.throws(()=>f.guard.assertUnreferenced(),/shared input reference/)
})

test('a cache from another producer task remains protected even if it shares the same source',t=>{
  const f=fixture(t)
  f.database.prepare('INSERT INTO history_motion_productions VALUES(?,17,?)').run('another-motion',JSON.stringify({plan:{shots:[{sourcePath:f.filename}]}}))
  assert.throws(()=>f.guard.assertUnreferenced(),/shared input reference/)
})

test('malformed fresh workflow references and incomplete purpose records fail closed',t=>{
  const f=fixture(t)
  f.database.prepare('UPDATE history_motion_productions SET snapshot=?').run('{')
  assert.throws(()=>f.guard.assertUnreferenced(),SyntaxError)
  f.database.prepare('UPDATE history_motion_productions SET snapshot=?').run('{}')
  f.database.exec('ALTER TABLE storage_artifact_refs DROP COLUMN purpose')
  assert.throws(()=>f.guard.assertUnreferenced(),/schema is incomplete/)
})

function afterMotionRead(t: TestContext, write: () => void) {
  const prepare=Database.prototype.prepare
  t.mock.method(Database.prototype,'prepare',function(this: Database.Database, sql: string) {
    const statement=prepare.call(this,sql)
    if (/snapshot.*FROM history_motion_productions/.test(sql)) {
      const all=statement.all
      t.mock.method(statement,'all',function(this: typeof statement,...parameters: unknown[]) {
        const result=Reflect.apply(all,this,parameters)
        write()
        return result
      })
    }
    return statement
  })
}

test('an unrelated commit during the initial scan is rechecked without permanently blocking cleanup',t=>{
  const f=fixture(t)
  f.database.exec('CREATE TABLE unrelated_progress(value INTEGER);INSERT INTO unrelated_progress VALUES(0)')
  let reads=0
  afterMotionRead(t,()=>{if(++reads===1)f.database.exec('UPDATE unrelated_progress SET value=value+1')})
  assert.doesNotThrow(()=>f.guard.assertUnreferenced())
  assert.equal(reads,2,'the changed database must be rechecked before authorizing cleanup')
})

test('a new real reference arriving during the initial scan blocks the bounded recheck',t=>{
  const f=fixture(t)
  let reads=0
  afterMotionRead(t,()=>{if(++reads===1)f.database.prepare('INSERT INTO remotion_assets VALUES(42,?)').run(f.filename)})
  assert.throws(()=>f.guard.assertUnreferenced(),/shared input reference/)
  assert.equal(reads,2)
})

test('continually changing ownership checks stop after a bounded number of scans',t=>{
  const f=fixture(t)
  f.database.exec('CREATE TABLE unrelated_progress(value INTEGER);INSERT INTO unrelated_progress VALUES(0)')
  let reads=0
  afterMotionRead(t,()=>{reads++;f.database.exec('UPDATE unrelated_progress SET value=value+1')})
  assert.throws(()=>f.guard.assertUnreferenced(),/ownership changed/)
  assert.equal(reads,3)
})

test('cleanup rechecks an unrelated warmup commit under a write reservation',t=>{
  const f=fixture(t)
  f.database.exec('CREATE TABLE unrelated_progress(value INTEGER);INSERT INTO unrelated_progress VALUES(0)')
  let reads=0,cleaned=false
  afterMotionRead(t,()=>{if(++reads===1)f.database.exec('UPDATE unrelated_progress SET value=value+1')})
  f.guard.withCleanupLock(()=>{cleaned=true})
  assert.equal(cleaned,true)
  assert.equal(reads,2,'the unlocked warmup cannot authorize deletion after a concurrent commit')
})

for (const protection of ['pin','reference'] as const) test(`a ${protection} added during warmup prevents cleanup`,t=>{
  const f=fixture(t)
  let reads=0,cleaned=false
  afterMotionRead(t,()=>{
    if(++reads!==1)return
    if(protection==='pin')f.database.exec('UPDATE storage_artifacts SET pinned=1')
    else f.database.prepare('INSERT INTO remotion_assets VALUES(42,?)').run(f.filename)
  })
  assert.throws(()=>f.guard.withCleanupLock(()=>{cleaned=true}),protection==='pin' ? /pinned/ : /shared input reference/)
  assert.equal(cleaned,false)
  assert.equal(reads,2)
  assert.doesNotThrow(()=>f.database.exec('UPDATE storage_artifacts SET pinned=0'),'a failed validation releases its reservation')
})

test('other connections cannot add a pin or reference during cleanup but can write after it',t=>{
  const f=fixture(t)
  f.database.pragma('busy_timeout=0')
  let cleaned=false
  f.guard.withCleanupLock(()=>{
    assert.throws(()=>f.database.exec('UPDATE storage_artifacts SET pinned=1'),{code:'SQLITE_BUSY'})
    assert.throws(()=>f.database.prepare('INSERT INTO remotion_assets VALUES(42,?)').run(f.filename),{code:'SQLITE_BUSY'})
    cleaned=true
  })
  assert.equal(cleaned,true)
  assert.doesNotThrow(()=>f.database.exec('UPDATE storage_artifacts SET pinned=1'))
  assert.throws(()=>f.guard.withCleanupLock(()=>assert.fail('pinned media must be retained')),/pinned/)
})

test('a failed cleanup releases the write reservation without hiding the error',t=>{
  const f=fixture(t),failure=new Error('filesystem removal failed')
  f.database.pragma('busy_timeout=0')
  assert.throws(()=>f.guard.withCleanupLock(()=>{throw failure}),error=>error===failure)
  assert.doesNotThrow(()=>f.database.exec('UPDATE storage_artifacts SET pinned=1'))
})

test('an existing writer causes bounded lock acquisition to retain the cache',t=>{
  const f=fixture(t)
  f.database.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(()=>f.guard.withCleanupLock(()=>assert.fail('cleanup cannot run without its reservation')),{code:'SQLITE_BUSY'})
  } finally {f.database.exec('ROLLBACK')}
  assert.doesNotThrow(()=>f.guard.withCleanupLock(()=>{}))
})
