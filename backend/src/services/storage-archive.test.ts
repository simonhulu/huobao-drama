import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {createStorageRegistry} from './storage-artifacts.js'
import {archiveVerifiedFile,restoreArchivedArtifacts,restoreTaskArchivedMedia} from './storage-archive.js'

const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
async function fixture(t:TestContext) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'storage-archive-'))
  const root=await fs.realpath(directory),dataRoot=path.join(root,'data')
  const filename=path.join(dataRoot,'remotion/project-17/input.mp4'),backup=path.join(root,'external/input.mp4')
  const bytes='verified project media'
  await fs.mkdir(path.dirname(filename),{recursive:true});await fs.mkdir(path.dirname(backup),{recursive:true})
  await fs.writeFile(filename,bytes);await fs.writeFile(backup,bytes)
  const db=new Database(':memory:'),registry=createStorageRegistry(db)
  registry.track([{path:filename,role:'source',bytes:bytes.length,owners:[{ownerType:'remotion',ownerId:'17',state:'completed'}]}])
  const id=registry.byPath(filename)!.id
  t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true})})
  return {root,dataRoot,filename,backup,bytes,db,registry,id,sha:hash(bytes)}
}

test('verified archive records independent backup and ownership before releasing original without a symlink',async t=>{
  const f=await fixture(t)
  const result=await archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot,review:{productionVerified:true}})
  assert.equal(result.status,'archived')
  await assert.rejects(fs.lstat(f.filename),{code:'ENOENT'})
  assert.equal(await fs.readFile(f.backup,'utf8'),f.bytes)
  const record=f.registry.get(f.id)!,review=JSON.parse(record.review_json)
  assert.equal(record.state,'archived')
  assert.equal(review.productionVerified,true)
  assert.equal(review.archive.backupPath,f.backup)
  assert.equal(review.archive.sha256,f.sha)
  assert.equal(f.registry.owners(f.id)[0]!.ownerId,'17')
})

test('restoration recreates regular original inputs for exactly the requested owner and remains idempotent',async t=>{
  const f=await fixture(t)
  await archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot})
  const unrelated=await restoreArchivedArtifacts(f.db,'remotion','other',{dataRoot:f.dataRoot})
  assert.equal(unrelated.restored,0)
  await assert.rejects(fs.lstat(f.filename),{code:'ENOENT'})
  const restored=await restoreArchivedArtifacts(f.db,'remotion','17',{dataRoot:f.dataRoot})
  assert.equal(restored.restored,1)
  assert.deepEqual(restored.errors,[])
  assert.equal((await fs.lstat(f.filename)).isFile(),true)
  assert.equal((await fs.lstat(f.filename)).isSymbolicLink(),false)
  assert.equal(await fs.realpath(f.filename),f.filename)
  assert.equal(await fs.readFile(f.filename,'utf8'),f.bytes)
  assert.equal(f.registry.get(f.id)!.state,'present')
  const again=await restoreArchivedArtifacts(f.db,'remotion','17',{dataRoot:f.dataRoot})
  assert.equal(again.restored,0)
  assert.equal(again.alreadyPresent,1)
})

test('missing, corrupt, internal, symlinked, and hardlinked backups cannot authorize releasing the original',async t=>{
  const f=await fixture(t)
  for (const backup of [path.join(f.root,'missing.mp4'),f.filename]) {
    await assert.rejects(archiveVerifiedFile(f.db,f.id,f.sha,backup,{dataRoot:f.dataRoot}))
    assert.equal(await fs.readFile(f.filename,'utf8'),f.bytes)
  }
  await fs.writeFile(f.backup,'different media')
  await assert.rejects(archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot}))
  await fs.rm(f.backup);await fs.symlink(f.filename,f.backup)
  await assert.rejects(archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot}))
  await fs.rm(f.backup);await fs.link(f.filename,f.backup)
  await assert.rejects(archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot}))
  assert.equal(await fs.readFile(f.filename,'utf8'),f.bytes)
})

test('restore refuses corrupt backup and never overwrites an independently recreated input',async t=>{
  const f=await fixture(t)
  await archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot})
  await fs.writeFile(f.backup,'corrupt archive')
  const corrupt=await restoreArchivedArtifacts(f.db,'remotion','17',{dataRoot:f.dataRoot})
  assert.equal(corrupt.restored,0);assert.equal(corrupt.errors.length,1)
  await assert.rejects(fs.lstat(f.filename),{code:'ENOENT'})
  await fs.writeFile(f.backup,f.bytes);await fs.writeFile(f.filename,'new production input')
  const existing=await restoreArchivedArtifacts(f.db,'remotion','17',{dataRoot:f.dataRoot})
  assert.equal(existing.restored,0);assert.equal(existing.errors.length,1)
  assert.equal(await fs.readFile(f.filename,'utf8'),'new production input')
})

test('a writer or changed original discovered during release cancels the archive',async t=>{
  const f=await fixture(t)
  await assert.rejects(archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot,
    assertCanRelease:()=>{throw Error('production started')}}),/production started/)
  assert.equal(await fs.readFile(f.filename,'utf8'),f.bytes)
  await assert.rejects(archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot,
    assertCanRelease:async()=>{await fs.writeFile(f.filename,'updated by production')}}))
  assert.equal(await fs.readFile(f.filename,'utf8'),'updated by production')
  assert.deepEqual((await restoreArchivedArtifacts(f.db,'remotion','17',{dataRoot:f.dataRoot})).errors,[])
})

test('restoration recovers interruption after unlink and rejects redirected project directories',async t=>{
  const f=await fixture(t)
  await archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot})
  f.db.prepare("UPDATE storage_artifacts SET state='present' WHERE id=?").run(f.id)
  assert.equal((await restoreArchivedArtifacts(f.db,'remotion','17',{dataRoot:f.dataRoot})).restored,1)
  await archiveVerifiedFile(f.db,f.id,f.sha,f.backup,{dataRoot:f.dataRoot})
  const originalParent=path.dirname(f.filename),outside=path.join(f.root,'redirected')
  await fs.rm(originalParent,{recursive:true});await fs.mkdir(outside);await fs.symlink(outside,originalParent)
  const redirected=await restoreArchivedArtifacts(f.db,'remotion','17',{dataRoot:f.dataRoot})
  assert.equal(redirected.errors.length,1)
  assert.deepEqual(await fs.readdir(outside),[])
})

test('producer restoration opens only an existing archive database without application migrations',async t=>{
  const f=await fixture(t),previous=process.env.DB_PATH
  delete process.env.DB_PATH
  t.after(()=>{if (previous===undefined) delete process.env.DB_PATH;else process.env.DB_PATH=previous})
  const filename=path.join(f.dataRoot,'huobao_drama.db')
  assert.equal((await restoreTaskArchivedMedia('remotion','17',f.root)).restored,0)
  await assert.rejects(fs.lstat(filename),{code:'ENOENT'})
  const disk=new Database(filename)
  assert.equal((await restoreTaskArchivedMedia('remotion','17',f.root)).restored,0)
  assert.deepEqual(disk.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),[])
  const registry=createStorageRegistry(disk)
  registry.track([{path:f.filename,role:'source',bytes:f.bytes.length,owners:[{ownerType:'remotion',ownerId:'17',state:'completed'}]}])
  const id=registry.byPath(f.filename)!.id
  try {
    await archiveVerifiedFile(disk,id,f.sha,f.backup,{dataRoot:f.dataRoot})
    assert.equal((await restoreTaskArchivedMedia('remotion','17',f.root)).restored,1)
    assert.equal(await fs.readFile(f.filename,'utf8'),f.bytes)
  } finally {disk.close()}
})
