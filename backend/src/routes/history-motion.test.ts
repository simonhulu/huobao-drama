import test, {after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const dbRoot=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-route-db-'))
process.env.DB_PATH=path.join(dbRoot,'sources.db')
process.env.STORAGE_PATH=path.join(dbRoot,'static')
process.env.TASK_WORKER_DISABLED='1'
const {db}=await import('../db/index.js')
const {storeHistorySource,updateHistorySource,deleteHistorySource}=await import('../services/history-script-library.js')
const {getHistoryDelivery,attachHistoryVideoFile}=await import('../services/history-script-delivery.js')
const {createHistoryMotionProduction,sourceRevision,hashText}=await import('../services/history-motion-production.js')
const {createHistoryMotionRoute}=await import('./history-motion.js')
after(()=>{db.$client.close();fs.rmSync(dbRoot,{recursive:true,force:true})})
let sourceIndex=100
function seed() {
  const created=storeHistorySource({sourceVideoId:String(sourceIndex++),title:'红军从瑞金出发',category:'regional_history',metrics:{},
    selection:{reason:'历史视频测试',observedAt:'2026-10-20T00:00:00Z',comments:[]}})
  const raw='红军行进。',corrected='红军行进。'
  return updateHistorySource(created.id,{status:'needs_review',rawTranscript:raw,correctedTranscript:corrected,rewrittenScript:'红军行进。',
    mediaJson:JSON.stringify({videoSha256:'1'.repeat(64),chunks:[{start:0,duration:2,sha256:'2'.repeat(64)}]}),
    asrJson:JSON.stringify({complete:true,text:raw,sourceVideoSha256:'1'.repeat(64),chunks:[{index:0,start:0,duration:2,audioSha256:'2'.repeat(64)}]}),
    reviewJson:JSON.stringify({factCheckStatus:'needs_sources',rawTranscriptSha256:hashText(raw),correctedTranscriptSha256:hashText(corrected),rewriteInputSha256:hashText(corrected)})})!
}
function fixture(t:TestContext,probe:()=>Promise<number>=async()=>2) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-motion-route-')),materialRoot=path.join(directory,'materials')
  fs.mkdirSync(materialRoot)
  const localPath=path.join(materialRoot,'a.mp4');fs.writeFileSync(localPath,'0123456789')
  const row={assetId:'a',rank:1,status:'done',sourceCaption:'红军行进远景',query:'红军',text:'原项目分镜',duration:8,width:1920,height:1080,fps:30,
    localPath,sha256:hashText('0123456789'),projectId:'p',clipId:'c',databaseSecret:'MUST_NOT_EXPOSE'}
  const production=createHistoryMotionProduction({databasePath:path.join(directory,'jobs.db'),root:path.join(directory,'outputs'),materialRoot,library:{search:()=>[row]}})
  const source=seed(),revision=sourceRevision(source)
  let audioCalls=0,renderCalls=0,modelCalls=0
  const route=createHistoryMotionRoute({production,delivery:{probe},pipeline:{
    model:async(_system,value:any)=>{modelCalls++;return value.shots[0].candidates?{selections:value.shots.map((s:any)=>({shotId:s.shotId,selection:null}))}:{shots:value.shots.map((s:any)=>({shotId:s.shotId,search:{query:'红军',limit:20},titles:[]}))}},
    audio:async(_script,directory)=>{audioCalls++;const audioPath=path.join(directory,'voice.m4a');fs.writeFileSync(audioPath,'voice');return {audioPath,duration:2}},
    probeVideo:async()=>({duration:8,width:1920,height:1080}),
    generateImage:async()=>{throw Error('测试没有图片服务')},
    render:async(_plan,directory)=>{renderCalls++;const outputPath=path.join(directory,'movie.mp4');fs.writeFileSync(outputPath,'movie-0123456789');return {outputPath,report:{sha256:hashText('movie-0123456789'),qa:{technical:'passed'}}}},
  }})
  t.after(()=>{production.close();fs.rmSync(directory,{recursive:true,force:true})})
  const post=(url:string,body?:unknown)=>route.request(url,{method:'POST',headers:{'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})})
  const url=(jobId:string,action='')=>`/${source.id}/jobs/${jobId}${action?'/'+action:''}`
  function rendered() {
    const job=production.create(source.id,source.rewrittenScript!,source.title,revision,'16:9')
    const root=path.join(production.root,job.id);fs.mkdirSync(root,{recursive:true})
    job.outputPath=path.join(root,'movie.mp4');fs.writeFileSync(job.outputPath,'movie-0123456789')
    job.stage='rendered';job.status='needs_review';job.plan={shots:[],delivery:{sha256:hashText('movie-0123456789'),qa:{technical:'passed'}}}
    return production.write(job)
  }
  async function settled(jobId:string) {
    for(let i=0;i<100;i++){
      const job=production.find(jobId)!
      if(['needs_review','failed','completed'].includes(job.status)){await new Promise(resolve=>setImmediate(resolve));return job}
      await new Promise(resolve=>setTimeout(resolve,5))
    }
    throw Error('Job did not settle')
  }
  return {directory,source,revision,row,production,route,post,url,rendered,settled,counts:()=>({audioCalls,renderCalls,modelCalls})}
}
async function data(response:Response){assert.equal(response.status,200,await response.clone().text());return (await response.json()).data}

test('search endpoint exposes bounded candidate metadata only and rejects unbounded inputs',async t=>{
  const f=fixture(t)
  const body=await data(await f.post('/materials/search',{query:'红军',shotSize:'wide',limit:20}))
  assert.equal(body.candidates[0].assetId,'a');assert.equal(body.candidates[0].databaseSecret,undefined)
  assert.equal((await f.post('/materials/search',{query:'红军',limit:9999})).status,400)
  assert.equal((await f.post('/materials/search',{query:'红军',sql:'select *'})).status,400)
})

test('produce rejects stale revision or unsupported profile and deduplicates current requests',async t=>{
  const f=fixture(t)
  assert.equal((await f.post(`/${f.source.id}/produce`,{scriptRevision:'a'.repeat(64),profile:'16:9'})).status,409)
  assert.equal((await f.post(`/${f.source.id}/produce`,{scriptRevision:f.revision,profile:'1:1'})).status,400)
  assert.equal(f.production.list().length,0)
  const first=await data(await f.post(`/${f.source.id}/produce`,{scriptRevision:f.revision,profile:'16:9'}))
  const second=await data(await f.post(`/${f.source.id}/produce`,{scriptRevision:f.revision,profile:'16:9'}))
  assert.equal(first.id,second.id)
  const completed=await f.settled(first.id)
  assert.equal(completed.status,'completed');assert.equal(completed.plan?.deliveryAssociation.status,'attached')
  assert.equal(completed.plan?.humanReview,undefined)
  assert.equal(f.counts().renderCalls,1)
})

test('invalid explicit selection creates no orphan task',async t=>{
  const f=fixture(t)
  const response=await f.post(`/${f.source.id}/plan`,{scriptRevision:f.revision,profile:'16:9',shots:[{shotId:'s1',narration:'红军行进。',duration:2,
    search:{query:'红军'},selection:{assetId:'unknown',outPoint:2,reason:'匹配',confidence:1}}]})
  assert.equal(response.status,400);assert.equal(f.production.list().length,0)
})

test('manual selection validates candidate frames and render reuses the original audio',async t=>{
  const f=fixture(t),job=await data(await f.post(`/${f.source.id}/plan`,{scriptRevision:f.revision,profile:'16:9',shots:[{shotId:'shot-1',narration:'红军行进。',duration:2,search:{query:'红军'},titles:[]}]}))
  assert.equal((await f.post(f.url(job.id,'approve'))).status,400)
  const pick={shotId:'shot-1',assetId:'a',inPoint:0,outPoint:2,crop:'contain',reason:'核对了画面'}
  assert.equal((await f.post(f.url(job.id,'select'),{...pick,assetId:'invented'})).status,400)
  assert.equal((await f.post(f.url(job.id,'select'),{...pick,outPoint:1.98})).status,400)
  const selected=await data(await f.post(f.url(job.id,'select'),pick))
  assert.equal(selected.requested.shots[0].selection.confidence,1);assert.equal(selected.plan.shots[0].status,'ready')
  await data(await f.post(f.url(job.id,'render')))
  const rendered=await f.settled(job.id)
  assert.equal(rendered.status,'completed');assert.equal(rendered.stage,'rendered');assert.deepEqual(f.counts(),{audioCalls:1,renderCalls:1,modelCalls:0})
  assert.equal((await f.post(f.url(job.id,'render'))).status,400)
  const confirmed=await data(await f.post(f.url(job.id,'approve')))
  assert.equal(confirmed.status,'completed');assert.equal(confirmed.plan.deliveryAssociation.status,'attached')
  assert.equal(getHistoryDelivery(f.source.id).videoUrl,confirmed.plan.deliveryAssociation.videoUrl)
})

test('approval is idempotent under repeated and concurrent requests and associates exact bytes',async t=>{
  let probes=0;const f=fixture(t,async()=>{probes++;await new Promise(resolve=>setTimeout(resolve,10));return 2}),job=f.rendered()
  const confirmed=await Promise.all([f.post(f.url(job.id,'approve')),f.post(f.url(job.id,'approve'))].map(async p=>data(await p)))
  const again=await data(await f.post(f.url(job.id,'approve')))
  assert.equal(probes,1);assert.equal(confirmed[0].plan.deliveryAssociation.videoUrl,confirmed[1].plan.deliveryAssociation.videoUrl)
  assert.equal(again.plan.humanReview,undefined);assert.equal(confirmed[0].plan.humanReview,undefined)
  assert.equal(fs.readdirSync(path.join(process.env.STORAGE_PATH!,'history-deliveries',String(f.source.id))).length,1)
  const attached=path.join(process.env.STORAGE_PATH!,again.plan.deliveryAssociation.videoUrl.slice('/static/'.length))
  assert.equal(fs.readFileSync(attached,'utf8'),'movie-0123456789')
})

test('association failure preserves the movie for automatic delivery retry without rendering',async t=>{
  let failed=true;const f=fixture(t,async()=>{if(failed)throw Error('temporary probe failure');return 2}),job=f.rendered()
  const first=await data(await f.post(f.url(job.id,'approve')))
  assert.equal(first.status,'failed');assert.equal(first.stage,'rendered');assert.equal(first.plan.deliveryAssociation.status,'failed')
  assert.ok(fs.existsSync(job.outputPath!));assert.equal(first.plan.humanReview,undefined)
  failed=false
  await data(await f.post(f.url(job.id,'deliver')))
  const retry=await f.settled(job.id)
  assert.equal(retry.status,'completed');assert.equal(retry.plan?.deliveryAssociation.status,'attached')
  assert.equal(f.counts().renderCalls,0);assert.equal(retry.plan?.humanReview,undefined)
})

test('approval adds its own version while preserving the other producer delivery',async t=>{
  const f=fixture(t),job=f.rendered(),old=path.join(f.directory,'old.mp4');fs.writeFileSync(old,'previous-channel-movie')
  const previous=await attachHistoryVideoFile(f.source.id,old,'previous.mp4',{expectedScriptSha256:hashText(f.source.rewrittenScript!),onlyIfMissing:true,probe:async()=>2})
  const approved=await data(await f.post(f.url(job.id,'approve')))
  assert.equal(approved.status,'completed');assert.equal(approved.plan.deliveryAssociation.status,'attached')
  assert.notEqual(approved.plan.deliveryAssociation.videoUrl,previous.videoUrl);assert.equal(getHistoryDelivery(f.source.id).videoUrl,previous.videoUrl)
  assert.equal(fs.readFileSync(job.outputPath!,'utf8'),'movie-0123456789')
})

test('a competing channel attachment is preserved when it finishes during motion association',async t=>{
  let f:ReturnType<typeof fixture>
  f=fixture(t,async()=>{
    const other=path.join(f.directory,'concurrent.mp4');fs.writeFileSync(other,'concurrent-video')
    await attachHistoryVideoFile(f.source.id,other,'concurrent.mp4',{expectedScriptSha256:hashText(f.source.rewrittenScript!),onlyIfMissing:true,probe:async()=>2})
    return 2
  })
  const job=f.rendered(),approved=await data(await f.post(f.url(job.id,'approve')))
  assert.equal(approved.plan.deliveryAssociation.status,'attached')
  assert.equal(getHistoryDelivery(f.source.id).videoName,'concurrent.mp4')
  assert.equal(getHistoryDelivery(f.source.id).videos.length,2)
  assert.equal(fs.readdirSync(path.join(process.env.STORAGE_PATH!,'history-deliveries',String(f.source.id))).length,2)
})

test('source revision changes during asynchronous attachment leave no association and preserve output',async t=>{
  let f:ReturnType<typeof fixture>
  f=fixture(t,async()=>{updateHistorySource(f.source.id,{title:'关联过程中修改标题'});return 2})
  const job=f.rendered(),result=await data(await f.post(f.url(job.id,'approve')))
  assert.equal(result.status,'failed');assert.equal(result.plan.deliveryAssociation.status,'failed')
  assert.match(result.error,/已更新/);assert.equal(getHistoryDelivery(f.source.id).videoUrl,null)
  assert.ok(fs.existsSync(job.outputPath!))
})

test('streaming supports ranges and HEAD while rejecting guessed, cross-source or escaped paths',async t=>{
  const f=fixture(t),job=f.rendered();job.candidates.s1=f.production.search({query:'红军',shotSize:'any',limit:20});f.production.write(job)
  const asset=f.url(job.id,'assets/a')
  const range=await f.route.request(asset,{headers:{range:'bytes=2-5'}})
  assert.equal(range.status,206);assert.equal(await range.text(),'2345');assert.equal(range.headers.get('content-range'),'bytes 2-5/10')
  const suffix=await f.route.request(asset,{headers:{range:'bytes=-3'}});assert.equal(await suffix.text(),'789')
  const head=await f.route.request(asset,{method:'HEAD'});assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'')
  assert.equal((await f.route.request(asset,{headers:{range:'bytes=100-200'}})).status,416)
  assert.equal((await f.route.request(asset,{headers:{range:'bytes=-0'}})).status,416)
  assert.equal((await f.route.request(f.url(job.id,'assets/guessed'))).status,404)
  assert.equal((await f.route.request(`/${seed().id}/jobs/${job.id}/video`)).status,404)
  const outside=path.join(f.directory,'outside.mp4');fs.writeFileSync(outside,'outside')
  fs.unlinkSync(f.row.localPath);fs.symlinkSync(outside,f.row.localPath)
  assert.equal((await f.route.request(asset)).status,404)
  fs.unlinkSync(job.outputPath!);fs.symlinkSync(outside,job.outputPath!)
  assert.equal((await f.route.request(f.url(job.id,'video'))).status,404)
  assert.equal((await f.post(f.url(job.id,'approve'))).status,400)
})

test('approval rejects changed output bytes and job-directory symlink escape',async t=>{
  const f=fixture(t),job=f.rendered()
  fs.writeFileSync(job.outputPath!,'altered')
  assert.equal((await f.post(f.url(job.id,'approve'))).status,400);assert.equal(getHistoryDelivery(f.source.id).videoUrl,null)
  const outside=path.join(f.directory,'escaped-job');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'movie.mp4'),'movie-0123456789')
  fs.rmSync(path.dirname(job.outputPath!),{recursive:true});fs.symlinkSync(outside,path.dirname(job.outputPath!))
  assert.equal((await f.route.request(f.url(job.id,'video'))).status,404)
  assert.equal((await f.post(f.url(job.id,'approve'))).status,400)
})

test('source revision edits block approval and editing; deletion hides job and media',async t=>{
  const f=fixture(t),job=f.rendered()
  updateHistorySource(f.source.id,{rewrittenScript:'稿件已更新。'})
  for(const action of ['approve','retry','select'])assert.equal((await f.post(f.url(job.id,action),{})).status,400)
  assert.equal(getHistoryDelivery(f.source.id).videoUrl,null)
  deleteHistorySource(f.source.id)
  assert.equal((await f.route.request(f.url(job.id))).status,404)
  assert.equal((await f.route.request(f.url(job.id,'video'))).status,404)
})

test('interrupted rendering is recovered as retryable failure without automatic model calls',async t=>{
  const f=fixture(t),job=f.rendered();job.status='rendering';job.plan!.audioPath='/cached/voice.m4a';f.production.write(job)
  const result=await data(await f.route.request(f.url(job.id)))
  assert.equal(result.status,'failed');assert.equal(result.plan.audioPath,undefined)
  assert.equal(f.production.find(job.id)?.plan?.audioPath,'/cached/voice.m4a')
  assert.match(result.error,/重启/);assert.deepEqual(f.counts(),{audioCalls:0,renderCalls:0,modelCalls:0})
})
