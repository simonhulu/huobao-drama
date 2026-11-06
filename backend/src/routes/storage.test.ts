import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {mkdtemp,rm,realpath,mkdir,writeFile,readFile,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createStorageManager} from '../services/storage-management.js'
import {createStorageRoute} from './storage.js'

test('storage endpoints validate origin, policy, artifact identity and server-owned cleanup scope',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'storage-route-'))),db=new Database(':memory:')
  t.after(async()=>{db.close();await rm(root,{recursive:true,force:true})})
  const manager=createStorageManager({db,projectRoot:root}),app=createStorageRoute(async()=>manager)
  const request=(route:string,body:unknown,method='POST',origin='http://localhost:3013')=>app.request(route,{method,headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)})
  const initial=await app.request('/')
  assert.equal(initial.status,200);assert.equal((await initial.json()).data.policy.retentionDays,0)
  assert.equal((await request('/policy',{autoCleanup:false},'PATCH','https://untrusted.test')).status,403)
  for(const retentionDays of [-1,0.5,91]) assert.equal((await request('/policy',{retentionDays},'PATCH')).status,400)
  const immediate=await request('/policy',{retentionDays:0},'PATCH')
  assert.equal(immediate.status,200);assert.equal((await immediate.json()).data.policy.retentionDays,0)
  const update=await request('/policy',{autoCleanup:false,retentionDays:14},'PATCH')
  assert.equal(update.status,200);assert.equal((await update.json()).data.policy.retentionDays,14)
  assert.equal((await request('/cleanup',{paths:['/outside/private.mp4']})).status,400)
  assert.equal((await request('/artifacts/1/review',{action:'delete',sha256:'not-a-hash'})).status,400)
  assert.equal((await request('/scan',{})).status,200)
  assert.equal((await app.request('/review?ownerId=missing&role=final')).status,200)
  assert.equal((await request('/cleanup',{kinds:[]})).status,200)
})

test('review pagination validates bounds and reports the filtered total',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'storage-review-pages-'))),db=new Database(':memory:')
  t.after(async()=>{db.close();await rm(root,{recursive:true,force:true})})
  const manager=createStorageManager({db,projectRoot:root}),app=createStorageRoute(async()=>manager)
  manager.registry.track([1,2,3].map(id=>({path:path.join(root,`data/static/${id}.mp4`),role:'final',bytes:10,
    owners:[{ownerType:id===3 ? 'cba' : 'unassigned',ownerId:'task',state:'needs_review'}]})))
  const response=await app.request('/review?ownerType=unassigned&offset=1&limit=1')
  const result=(await response.json()).data
  assert.equal(response.status,200);assert.equal(result.total,2);assert.equal(result.offset,1);assert.equal(result.limit,1)
  assert.equal(result.items.length,1);assert.equal(result.items[0].id,2)
  for (const query of ['offset=-1','offset=1.5','offset=no','limit=0','limit=151','role=invalid']) {
    assert.equal((await app.request('/review?'+query)).status,400,query)
  }
})

test('artifact preview streams exact ranges, downloads unchanged bytes and rejects unavailable paths',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'storage-preview-'))),db=new Database(':memory:')
  t.after(async()=>{db.close();await rm(root,{recursive:true,force:true})})
  const manager=createStorageManager({db,projectRoot:root}),app=createStorageRoute(async()=>manager)
  const file=path.join(root,'data/cba-video/test/movie.mp4')
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'0123456789')
  manager.registry.track([{path:file,role:'final',bytes:10,owners:[{ownerType:'cba',ownerId:'test',state:'completed'}]}])
  const id=manager.registry.byPath(file)!.id
  const inspection=await (await app.request(`/artifacts/${id}`)).json()
  assert.equal(inspection.data.mimeType,'video/mp4');assert.match(inspection.data.previewUrl,/\/content$/)
  const ranged=await app.request(`/artifacts/${id}/content`,{headers:{Range:'bytes=2-5'}})
  assert.equal(ranged.status,206);assert.equal(ranged.headers.get('Content-Range'),'bytes 2-5/10')
  assert.equal(await ranged.text(),'2345')
  const suffix=await app.request(`/artifacts/${id}/content`,{headers:{Range:'bytes=-3'}})
  assert.equal(await suffix.text(),'789')
  const download=await app.request(`/artifacts/${id}/content?download=1`)
  assert.match(download.headers.get('Content-Disposition')!,/^attachment;/)
  assert.equal(await download.text(),'0123456789')
  assert.equal((await app.request(`/artifacts/${id}/content`,{headers:{Range:'bytes=20-25'}})).status,416)
  manager.registry.release(file,{},'archived')
  assert.equal((await app.request(`/artifacts/${id}/content`)).status,400)
  const unsafe=path.join(root,'data/cba-video/test/unsafe.mp4')
  await symlink(file,unsafe)
  manager.registry.track([{path:unsafe,role:'final',bytes:10,owners:[{ownerType:'cba',ownerId:'test',state:'completed'}]}])
  assert.equal((await app.request(`/artifacts/${manager.registry.byPath(unsafe)!.id}/content`)).status,400)
})

test('the live storage endpoint hides CBA tasks while preserving uncertain uploads and every artifact',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'storage-cba-delete-'))),db=new Database(':memory:')
  t.after(async()=>{db.close();await rm(root,{recursive:true,force:true})})
  const manager=createStorageManager({db,projectRoot:root}),app=createStorageRoute(async()=>manager)
  const id='cba-existing',directory=path.join(root,'data/cba-video',id),movie=path.join(directory,'final.mp4')
  await mkdir(directory,{recursive:true});await writeFile(movie,'unuploaded movie')
  await writeFile(path.join(directory,'job.json'),JSON.stringify({status:'rendered',match:{id,seedUrls:['https://example.com/story']},news:{title:'Existing task'},outputs:{news:{path:movie}}}))
  const upload={id:'upload-existing',jobId:id,status:'uncertain',fingerprint:'same-video',inputDigest:'same-version'}
  const stateFile=path.join(root,'data/cba-video/.console.json')
  await writeFile(stateFile,JSON.stringify({version:1,settings:{autoUpload:true,targets:['baijiahao-video']},runs:[],uploads:[upload]}))
  const request=(expectedTitle:string)=>app.request(`/owners/cba/${id}/delete-task`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true,expectedTitle})})
  assert.equal((await request('Changed title')).status,400)
  assert.equal((await request('Existing task')).status,200)
  assert.equal(await readFile(movie,'utf8'),'unuploaded movie')
  assert.ok(JSON.parse(await readFile(path.join(directory,'job.json'),'utf8')).outputs.news.path)
  const state=JSON.parse(await readFile(stateFile,'utf8'))
  assert.deepEqual(state.uploads,[upload]);assert.ok(state.deletedTasks[id])
  assert.equal((await (await request('Existing task')).json()).data.alreadyDeleted,true)
})
