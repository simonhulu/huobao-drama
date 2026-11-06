import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {clearCbaMaterials} from './cba-clear-materials.js'
import {createStorageRegistry} from '../src/services/storage-artifacts.js'
import {restoreArchivedArtifacts} from '../src/services/storage-archive.js'

async function fixture(t:any) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'cba-clear-'))),db=new Database(':memory:')
  t.after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true})})
  const put=async(relative:string,text='retained bytes')=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);return file}
  const consoleFile=await put('data/cba-video/.console.json',JSON.stringify({runs:[],uploads:[{jobId:'uncertain',status:'uncertain'}]}))
  for(const id of ['uncertain','old']) {
    await put(`data/cba-video/${id}/job.json`,JSON.stringify({status:'rendered',outputs:{path:path.join(root,`data/cba-video/${id}/renders/news.mp4`)}}))
    await put(`data/cba-video/${id}/downloads/source.mp4`)
    await put(`data/cba-video/${id}/renders/news.mp4`)
    await put(`data/cba-video/${id}/uploads/receipt.json`,'{"status":"uncertain"}')
  }
  return {root,db,put,consoleFile}
}

test('explicit CBA reset preserves every final and receipt and keeps unresolved inputs restorable',async t=>{
  const f=await fixture(t),plan=await clearCbaMaterials(f.root,f.db)
  assert.equal(plan.plannedFiles,2);assert.equal(plan.backupLogicalBytes,14)
  const result=await clearCbaMaterials(f.root,f.db,true)
  assert.equal(result.removedFiles,1);assert.equal(result.archivedFiles,1);assert.equal(result.preservedFilesVerified,true)
  for(const id of ['uncertain','old']) {
    await assert.rejects(fs.readFile(path.join(f.root,`data/cba-video/${id}/downloads/source.mp4`)))
    assert.equal(await fs.readFile(path.join(f.root,`data/cba-video/${id}/renders/news.mp4`),'utf8'),'retained bytes')
    assert.equal(await fs.readFile(path.join(f.root,`data/cba-video/${id}/uploads/receipt.json`),'utf8'),'{"status":"uncertain"}')
  }
  const restored=await restoreArchivedArtifacts(f.db,'cba','uncertain',{dataRoot:path.join(f.root,'data')})
  assert.equal(restored.restored,1);assert.deepEqual(restored.errors,[])
  assert.equal(await fs.readFile(path.join(f.root,'data/cba-video/uncertain/downloads/source.mp4'),'utf8'),'retained bytes')
})

test('reset retains foreign project inputs and refuses active CBA production',async t=>{
  const f=await fixture(t),registry=createStorageRegistry(f.db)
  const shared=path.join(f.root,'data/cba-video/old/downloads/source.mp4')
  registry.track([{path:shared,role:'source',bytes:14,owners:[{ownerType:'remotion',ownerId:'other',state:'ready'}]}])
  assert.equal((await clearCbaMaterials(f.root,f.db)).retained.length,1)
  await fs.writeFile(f.consoleFile,JSON.stringify({runs:[{status:'running'}],uploads:[]}))
  await assert.rejects(clearCbaMaterials(f.root,f.db,true),/active/)
  assert.equal(await fs.readFile(shared,'utf8'),'retained bytes')
  await assert.rejects(fs.stat(path.join(f.root,'data/cba-video/.console.json.lock')))
})
