import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { MysteryStore } from '../services/mystery-store.js'

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'mystery-route-import-'))
process.env.DB_PATH=path.join(isolated,'bootstrap.db')
process.env.TASK_WORKER_DISABLED='1'
const {MysteryWorkflowService}=await import('../services/mystery-workflow.js')
const {createMysteryStoriesRoute}=await import('./mystery-stories.js')
const json=(value:unknown,method='POST')=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})
const video=(index=1)=>`https://www.youtube.com/watch?v=story${String(index).padStart(6,'0')}`

function fixture(t:any) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mystery-route-')),connection=new Database(path.join(root,'domain.db'))
  t.after(()=>{connection.close();fs.rmSync(root,{recursive:true,force:true})})
  const tasks:any[]=[]
  const service=new MysteryWorkflowService({store:new MysteryStore(connection),root,enqueue:input=>{const task={...input,id:tasks.length+1,status:'queued',cancelRequested:false};tasks.push(task);return task as any},task:id=>tasks.find(t=>t.id===id)||null})
  return {root,service,tasks,app:createMysteryStoriesRoute({service,accounts:new Hono()})}
}

test('workspace imports are deduplicated across YouTube URL forms and never start production implicitly',async t=>{
  const {app,tasks}=fixture(t)
  const first=await app.request('/stories',json({sourceUrl:video(),category:'event'}))
  assert.equal(first.status,200)
  const story=(await first.json()).data
  const second=await app.request('/stories',json({sourceUrl:'https://youtu.be/story000001',category:'person'}))
  assert.equal((await second.json()).data.id,story.id)
  assert.equal(tasks.length,0)
  const result=await(await app.request('/stories')).json()
  assert.equal(result.data.total,1);assert.equal(result.data.counts.total,1)
  assert.equal((await app.request('/stories',json({sourceUrl:'https://youtube.com/@stories'}))).status,400)
})

test('mutations reject cross-origin requests, unknown settings, stale edits and preserve the current value',async t=>{
  const {app,service}=fixture(t),story=service.create({sourceUrl:video()})
  assert.equal((await app.request('/stories',{headers:{Origin:'https://example.org'}})).status,403)
  assert.equal((await app.request('/stories',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403)
  assert.equal((await app.request('/stories',json({sourceUrl:video(2),profile:'/tmp/arbitrary'}))).status,400)
  const updated=await app.request(`/stories/${story.id}`,json({expectedVersion:story.version,title:'门口的灯'},'PATCH'))
  assert.equal(updated.status,200)
  const conflict=await app.request(`/stories/${story.id}`,json({expectedVersion:story.version,title:'过时编辑'},'PATCH'))
  assert.equal(conflict.status,409);assert.equal(service.detail(story.id).title,'门口的灯')
})

test('accepted draft runs persist and repeated requests reuse one task; disabled channels remain disabled',async t=>{
  const {app,service,tasks}=fixture(t),story=service.create({sourceUrl:video()})
  const request={requestId:'request-unique-001',target:'draft'}
  assert.equal((await app.request(`/stories/${story.id}/runs`,json(request))).status,200)
  assert.equal((await app.request(`/stories/${story.id}/runs`,json(request))).status,200)
  assert.equal(tasks.length,1)
  const channel=await(await app.request('/channels',json({url:'https://youtube.com/@stories',name:'故事来源',category:'person',enabled:true}))).json()
  assert.equal((await app.request(`/channels/${channel.data.id}`,json({enabled:false},'PATCH'))).status,200)
  assert.equal(service.channels()[0]!.enabled,false)
  const batch=await app.request('/collection-runs',json({requestId:'request-batch-001',channelIds:[channel.data.id],target:'draft'}))
  assert.equal(batch.status,400)
})

test('edition filtering and counts use the complete database before pagination',async t=>{
  const {app,service}=fixture(t)
  for(let i=1;i<=5;i++) {const s=service.create({sourceUrl:video(i)});if(i%2===0)service.store.update(s.id,value=>{value.editions.push({id:`edition-${i}`} as any)})}
  const result=await(await app.request('/stories?hasEdition=true&page=2&pageSize=1')).json()
  assert.equal(result.data.total,2);assert.equal(result.data.items.length,1);assert.equal(result.data.items[0].videoId,'story000002')
  assert.equal(result.data.counts.total,5)
})

test('source assets support range requests, preserve audio type and reject files outside the story',async t=>{
  const {root,app,service}=fixture(t),story=service.create({sourceUrl:video(),downloadMode:'audio'})
  const directory=service.directory(story.id);fs.mkdirSync(directory,{recursive:true})
  const file=path.join(directory,'source.m4a');fs.writeFileSync(file,'0123456789')
  service.store.update(story.id,s=>{s.media.videoPath=file})
  const response=await app.request(`/stories/${story.id}/download?kind=source`,{headers:{Range:'bytes=2-5'}})
  assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'audio/mp4');assert.equal(await response.text(),'2345')
  assert.equal((await app.request(`/stories/${story.id}/download?kind=source`,{headers:{Range:'bytes=99-100'}})).status,416)
  const outside=path.join(root,'unrelated.txt');fs.writeFileSync(outside,'private')
  const link=path.join(directory,'link.mp4');fs.symlinkSync(outside,link)
  service.store.update(story.id,s=>{s.media.videoPath=link})
  assert.equal((await app.request(`/stories/${story.id}/download?kind=source`)).status,403)
})

test.after(()=>fs.rmSync(isolated,{recursive:true,force:true}))
