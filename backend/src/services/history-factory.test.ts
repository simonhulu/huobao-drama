import test,{after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-factory-'))
process.env.DB_PATH=path.join(root,'test.sqlite')
process.env.STORAGE_PATH=path.join(root,'static')
process.env.TASK_WORKER_DISABLED='1'
const {db,schema}=await import('../db/index.js')
const {eq}=await import('drizzle-orm')
const {createHistoryFactory}=await import('./history-factory.js')
const {createHistoryMotionProduction,hashText,sourceRevision}=await import('./history-motion-production.js')
const {generateMotionAudio,canReuseMotionAudio}=await import('./history-motion-pipeline.js')
const {storeHistorySource,updateHistorySource,getHistorySource}=await import('./history-script-library.js')
const {createHistoryFactoryRoute}=await import('../routes/history-factory.js')
after(()=>{db.$client.close();fs.rmSync(root,{recursive:true,force:true})})
let index=0
function setup(t:TestContext) {
  const directory=path.join(root,String(++index)),storageRoot=path.join(directory,'static'),materialRoot=path.join(directory,'materials')
  fs.mkdirSync(materialRoot,{recursive:true});fs.mkdirSync(path.join(storageRoot,'audio'),{recursive:true})
  const production=createHistoryMotionProduction({databasePath:path.join(directory,'jobs.db'),root:path.join(directory,'jobs'),materialRoot,library:{search:()=>[]}})
  const ts=new Date().toISOString(),script='红军从瑞金出发。'
  const drama=db.insert(schema.dramas).values({title:'历史测试',createdAt:ts,updatedAt:ts}).returning().get()
  const audioPath=path.join(storageRoot,'audio','master.m4a');fs.writeFileSync(audioPath,'original-narration')
  const ep=db.insert(schema.episodes).values({dramaId:drama.id,episodeNumber:1,title:'固定原稿',scriptContent:script,preTtsAudioUrl:'/static/audio/master.m4a',preTtsTitlesJson:JSON.stringify([{text:script,time_begin:0,time_end:2000}]),createdAt:ts,updatedAt:ts}).returning().get()
  const storyboard=db.insert(schema.storyboards).values({episodeId:ep.id,storyboardNumber:1,narration:script,duration:2,createdAt:ts,updatedAt:ts}).returning().get()
  let modelCalls=0,renderCalls=0,audioCalls=0,failRender=false
  const factory=createHistoryFactory({production,storageRoot,probeAudio:async()=>2,delivery:{root:storageRoot,probe:async()=>2},pipeline:{
    model:async(_system,input:any)=>{modelCalls++;return {shots:input.shots.map((s:any)=>({shotId:s.shotId,visualType:'graphic',search:{query:'红军'},purpose:'交代出发地',titles:[{text:'瑞金',start:0,duration:2}],graphic:{kind:'quote',title:'红军出发',items:[{label:'瑞金'}]}}))}},
    audio:async(script,dir,request)=>{
      audioCalls++;const cache=path.join(dir,'narration.json')
      if(request?.voiceId && (!fs.existsSync(cache) || !canReuseMotionAudio(JSON.parse(fs.readFileSync(cache,'utf8')),script,request.voiceId))) {
        const replacement=path.join(dir,`narration-${request.voiceId}.m4a`);fs.writeFileSync(replacement,'new-voice-audio')
        const voice={script,audioPath:replacement,duration:2,titles:[{text:script,time_begin:0,time_end:2000}],audioSettings:{voiceId:request.voiceId}}
        fs.writeFileSync(cache,JSON.stringify(voice));return voice
      }
      if(fs.existsSync(cache))return generateMotionAudio(script,dir,request)
      const voice={script,audioPath,duration:2,titles:[{text:script,time_begin:0,time_end:2000}]};fs.writeFileSync(cache,JSON.stringify(voice));return voice
    },
    generateImage:async input=>{const filename=path.join(input.directory,`${input.shotId}.png`);fs.writeFileSync(filename,`image-${input.shotId}`);return {path:filename,sha256:hashText(`image-${input.shotId}`)}},
    render:async(_plan,dir)=>{renderCalls++;if(failRender)throw Error('render interrupted');const outputPath=path.join(dir,'movie.mp4'),preview=path.join(dir,'movie-preview.mp4');fs.writeFileSync(outputPath,'verified-movie');fs.writeFileSync(preview,'sound-preview');return {outputPath,report:{preview,previewRange:{start:0,end:2},sha256:hashText('verified-movie'),qa:{technical:'passed'}}}},
  }})
  t.after(()=>production.close())
  return {factory,production,ep,storyboard,script,storageRoot,counts:()=>({modelCalls,renderCalls,audioCalls}),failRender:(value:boolean)=>{failRender=value}}
}
function source(script:string) {
  const value=storeHistorySource({sourceVideoId:String(1000+index),title:'来源标题',category:'regional_history',metrics:{},selection:{reason:'测试',observedAt:'2026-10-26T00:00:00Z',comments:[]}})
  return updateHistorySource(value.id,{rawTranscript:script,correctedTranscript:script,rewrittenScript:script,
    mediaJson:JSON.stringify({videoSha256:'1'.repeat(64),chunks:[{start:0,duration:2,sha256:'2'.repeat(64)}]}),
    asrJson:JSON.stringify({complete:true,text:script,sourceVideoSha256:'1'.repeat(64),chunks:[{index:0,start:0,duration:2,audioSha256:'2'.repeat(64)}]}),
    reviewJson:JSON.stringify({factCheckStatus:'needs_sources',rawTranscriptSha256:hashText(script),correctedTranscriptSha256:hashText(script),rewriteInputSha256:hashText(script)})})!
}

async function waitFor(predicate:()=>boolean, timeoutMs=2000) {
  const deadline=Date.now()+timeoutMs
  while(!predicate() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(predicate(),true,'异步制作任务未在预期时间内进入目标阶段')
}

test('an oversized native Episode is condensed before snapshotting and old narration is preserved without reuse',async t=>{
  const f=setup(t),original='完整历史叙述。'.repeat(800),condensed='精简后仍保留主线与结论。'
  db.update(schema.episodes).set({scriptContent:original,content:original}).where(eq(schema.episodes.id,f.ep.id)).run()
  let calls=0
  const scheduled:string[]=[]
  const factory=createHistoryFactory({production:f.production,storageRoot:f.storageRoot,
    condenseScript:async script=>{calls++;assert.equal(script,original);return {title:f.ep.title,coverText:'',script:condensed,
      skillName:'history-source-paraphrase',skillRevision:'history-source-condensed-v1',skillSha256:hashText('condensation'),provider:'remote-writer',model:'test-writer'}},
    runnerFactory:()=>({schedule:id=>{scheduled.push(id)},isRunning:()=>false,idle:async()=>{},stop:async()=>{}}),
  })
  const result=await factory.startEpisode(f.ep.id)
  assert.equal(result.episode.script,condensed)
  assert.equal(result.job?.script,condensed)
  assert.equal(result.episode.audioUrl,null)
  assert.equal(result.shots.length,0)
  const saved=db.select().from(schema.episodes).where(eq(schema.episodes.id,f.ep.id)).get()!
  const preparation=JSON.parse(saved.metadata!).scriptCondensation
  assert.equal(preparation.previousScript,original)
  assert.equal(preparation.previousAudioUrl,'/static/audio/master.m4a')
  assert.equal(saved.preTtsTitlesJson,null)
  assert.equal(fs.readFileSync(path.join(f.storageRoot,'audio/master.m4a'),'utf8'),'original-narration')
  assert.equal(fs.existsSync(path.join(f.production.root,result.job!.id,'narration.json')),false)
  await factory.startEpisode(f.ep.id,{retry:true})
  assert.equal(calls,1)
  assert.deepEqual(scheduled,[result.job!.id,result.job!.id])
})

test('retrying an oversized source Episode gives both producers one shortened manuscript and keeps the failed snapshot',async t=>{
  const f=setup(t),original='过长历史原稿。'.repeat(900),condensed='保留关键史实与因果，删去重复讲解。',value=source(original)
  const old=f.production.create(value.id,original,value.title,sourceRevision(value),'16:9')
  old.factory={episodeId:f.ep.id,projectId:999,sourceId:value.id,scriptHash:hashText(original)}
  old.status='failed';old.error='稿件超过单次500镜限制，请拆为多集';f.production.write(old)
  db.update(schema.episodes).set({scriptContent:original,content:original,preTtsAudioUrl:null,preTtsTitlesJson:null,
    metadata:JSON.stringify({historyFactory:{...old.factory,jobId:old.id}})}).where(eq(schema.episodes.id,f.ep.id)).run()
  let calls=0
  const factory=createHistoryFactory({production:f.production,storageRoot:f.storageRoot,sourceStorageRoot:path.join(root,'source-locks'),
    condenseScript:async text=>{calls++;assert.equal(text,original);return {title:value.title,coverText:'',script:condensed,
      skillName:'history-source-paraphrase',skillRevision:'history-source-condensed-v1',skillSha256:hashText('condensation'),provider:'remote-writer',model:'test-writer'}},
    runnerFactory:()=>({schedule:()=>{},isRunning:()=>false,idle:async()=>{},stop:async()=>{}}),
  })
  const result=await factory.startEpisode(f.ep.id,{retry:true})
  assert.equal(result.episode.id,f.ep.id)
  assert.notEqual(result.job!.id,old.id)
  assert.equal(result.episode.script,condensed)
  assert.equal(result.job!.script,condensed)
  assert.equal(getHistorySource(value.id)!.rewrittenScript,condensed)
  assert.equal(f.production.find(old.id)!.script,original)
  assert.equal(f.production.find(old.id)!.status,'failed')
  assert.equal(calls,1)
})

test('an Episode edit arriving during condensation is never overwritten or scheduled',async t=>{
  const f=setup(t),original='完整历史叙述。'.repeat(800)
  db.update(schema.episodes).set({scriptContent:original}).where(eq(schema.episodes.id,f.ep.id)).run()
  const factory=createHistoryFactory({production:f.production,storageRoot:f.storageRoot,
    condenseScript:async()=>{
      db.update(schema.episodes).set({scriptContent:'用户刚保存的新稿'}).where(eq(schema.episodes.id,f.ep.id)).run()
      return {title:'',coverText:'',script:'缩写稿',skillName:'history-source-paraphrase',skillRevision:'history-source-condensed-v1',skillSha256:hashText('condensation')}
    },runnerFactory:()=>({schedule:()=>assert.fail('Changed manuscripts must not be scheduled'),isRunning:()=>false,idle:async()=>{},stop:async()=>{}}),
  })
  await assert.rejects(factory.startEpisode(f.ep.id),/缩写期间正文已更新/)
  assert.equal(factory.detail(f.ep.id).episode.script,'用户刚保存的新稿')
  assert.equal(f.production.list().length,0)
})

test('factory polling reads current job summaries without loading complete production snapshots',t=>{
  const f=setup(t)
  const factory=createHistoryFactory({production:{...f.production,find:()=>assert.fail('List polling must not load complete job snapshots')},storageRoot:f.storageRoot})
  const job=f.production.create(-f.ep.id,f.script,'摘要测试',hashText('first version'),'16:9')
  job.status='rendering';job.stage='render';job.message='正在渲染'
  job.requested.shots=[{shotId:'one',narration:f.script,duration:2,search:{query:'红军',shotSize:'any',limit:20},titles:[]}]
  job.plan={visuals:{one:{imagePath:'/private/image.png'}},deliveryAssociation:{videoUrl:'/static/current.mp4'},historyPresenterPolicy:{character:'history',presenter:'xiaoba'},unrelated:'x'.repeat(1024*1024)}
  f.production.write(job)
  db.update(schema.episodes).set({videoUrl:'/static/old.mp4',metadata:JSON.stringify({historyFactory:{jobId:job.id,sourceId:373}})}).where(eq(schema.episodes.id,f.ep.id)).run()
  const first=factory.list().items.find(item=>item.episodeId===f.ep.id)!
  assert.deepEqual({jobId:first.jobId,status:first.status,stage:first.stage,message:first.message,updatedAt:first.updatedAt,sourceId:first.sourceId,videoUrl:first.videoUrl,shotCount:first.shotCount,readyShotCount:first.readyShotCount},
    {jobId:job.id,status:'rendering',stage:'render',message:'正在渲染',updatedAt:job.updatedAt,sourceId:373,videoUrl:'/static/current.mp4',shotCount:1,readyShotCount:1})
  assert.deepEqual(factory.list().items.find(item=>item.episodeId===f.ep.id),first)
  job.status='failed';job.stage='validation';job.message='等待处理';job.plan=null;job.requested.shots=[];f.production.write(job)
  const failed=factory.list().items.find(item=>item.episodeId===f.ep.id)!
  assert.equal(failed.status,'failed');assert.equal(failed.stage,'validation');assert.equal(failed.message,'等待处理')
  assert.equal(failed.videoUrl,'/static/old.mp4');assert.equal(failed.shotCount,1);assert.equal(failed.readyShotCount,0)
  const replacement=f.production.create(-f.ep.id,f.script,'新版',hashText('replacement version'),'16:9')
  db.update(schema.episodes).set({metadata:JSON.stringify({historyFactory:{jobId:replacement.id}})}).where(eq(schema.episodes.id,f.ep.id)).run()
  assert.equal(factory.list().items.find(item=>item.episodeId===f.ep.id)?.jobId,replacement.id,'Episode metadata selects the current job, not the most recently updated old job')
  db.update(schema.episodes).set({metadata:JSON.stringify({historyFactory:{jobId:'missing-job'}})}).where(eq(schema.episodes.id,f.ep.id)).run()
  const missing=factory.list().items.find(item=>item.episodeId===f.ep.id)!
  assert.equal(missing.jobId,null);assert.equal(missing.status,'completed');assert.equal(missing.shotCount,1)
})

test('native Episode is executable, reuses narration and fixed shots, and registers an accessible render',async t=>{
  const f=setup(t),started=await f.factory.startEpisode(f.ep.id)
  assert.equal(started.url,`/remotion/episode/${f.ep.id}`)
  await f.factory.runner.idle()
  const detail=f.factory.detail(f.ep.id)
  assert.equal(detail.job?.status,'completed',detail.job?.error || '')
  assert.equal(detail.job?.factory?.episodeId,f.ep.id)
  assert.equal(detail.shots[0].shotId,`storyboard-${f.storyboard.id}`)
  assert.equal(detail.shots[0].narration,f.script)
  assert.match(detail.job?.plan?.timingEvidence,/厂商句级/)
  assert.equal(detail.outputs.length,2)
  assert.ok(detail.outputs.some(o=>o.kind==='preview'))
  assert.ok(detail.job?.plan?.deliveryAssociation.evidenceUrl)
  assert.equal(detail.job?.plan?.captions[0].text,f.script)
  assert.ok(fs.existsSync(path.join(f.storageRoot,detail.outputs[0].url.slice('/static/'.length))))
  assert.equal(db.select().from(schema.episodes).where(eq(schema.episodes.id,f.ep.id)).get()!.preTtsAudioUrl,'/static/audio/master.m4a')
  await f.factory.startEpisode(f.ep.id)
  assert.deepEqual(f.counts(),{modelCalls:1,renderCalls:1,audioCalls:1})
  assert.equal(f.factory.list().items.find(item=>item.episodeId===f.ep.id)?.status,'completed')
})

test('an injected runner retains factory manuscript and delivery guards',async t=>{
  const f=setup(t)
  let bound:any
  const scheduled:string[]=[]
  const factory=createHistoryFactory({production:f.production,storageRoot:f.storageRoot,probeAudio:async()=>2,
    runnerFactory:(production,dependencies)=>{
      bound={production,dependencies}
      return {schedule:id=>{scheduled.push(id)},isRunning:()=>false,idle:async()=>{},stop:async()=>{}}
    },
  })
  const detail=await factory.startEpisode(f.ep.id)
  const job=f.production.find(detail.job!.id)!
  assert.deepEqual(scheduled,[job.id])
  assert.equal(bound.production.root,f.production.root)
  assert.equal(typeof bound.dependencies.deliver,'function')
  assert.doesNotThrow(()=>bound.dependencies.assertCurrent(job))
  db.update(schema.episodes).set({scriptContent:'正文已更改。'}).where(eq(schema.episodes.id,f.ep.id)).run()
  assert.throws(()=>bound.dependencies.assertCurrent(job),/正文已更新/)
  await assert.rejects(()=>bound.dependencies.deliver(job,{filename:'unused.mp4',sha256:hashText('unused')}),/正文已更新/)
})

test('failed render retries reuse design, voice and visuals while keeping old Episode output',async t=>{
  const f=setup(t)
  db.update(schema.episodes).set({videoUrl:'/static/old-verified.mp4'}).where(eq(schema.episodes.id,f.ep.id)).run()
  f.failRender(true)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  assert.equal(f.factory.detail(f.ep.id).job?.status,'failed')
  f.failRender(false)
  await f.factory.startEpisode(f.ep.id,{retry:true,profile:'9:16'});await f.factory.runner.idle()
  const detail=f.factory.detail(f.ep.id)
  assert.equal(detail.job?.status,'completed',detail.job?.error || '')
  assert.equal(detail.episode.videoUrl,'/static/old-verified.mp4')
  assert.equal(detail.job?.profile,'16:9','Retry cannot silently create a different-format job')
  assert.equal(detail.outputs.length,3)
  assert.deepEqual(f.counts(),{modelCalls:1,renderCalls:2,audioCalls:1})
})

test('recovery resumes an interrupted durable job without remaking narration or completed visuals',async t=>{
  const f=setup(t)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const job=f.production.list()[0]!,before=f.counts(),visuals=job.plan!.visuals
  job.status='failed';job.error='服务重启中断制作，配音和已完成画面已保留'
  job.outputPath=null;job.stage='rendering';f.production.write(job)
  f.factory.recoverPending()
  f.factory.recoverPending()
  await f.factory.runner.idle()
  assert.equal(f.production.find(job.id)?.status,'completed')
  assert.equal(f.factory.detail(f.ep.id).job?.id,job.id)
  assert.deepEqual(f.production.find(job.id)?.plan?.visuals,visuals)
  assert.deepEqual(f.counts(),{...before,renderCalls:before.renderCalls+1})
})

test('scoped recovery preserves excluded jobs byte for byte and resumes only the original selected task',async t=>{
  const f=setup(t),original=source(f.script)
  const result=await f.factory.startFromSource(original,{profile:'16:9'})
  await f.factory.runner.idle()
  const job=f.production.find(result.job!.id)!,before=f.counts()
  job.status='failed';job.error='服务重启中断制作，配音和已完成画面已保留'
  job.outputPath=null;job.stage='rendering';f.production.write(job)
  const snapshot=JSON.stringify(f.production.find(job.id))
  f.factory.recoverPending([])
  f.factory.recoverPending([original.id+1])
  await f.factory.runner.idle()
  assert.equal(JSON.stringify(f.production.find(job.id)),snapshot)
  assert.deepEqual(f.counts(),before)
  f.factory.recoverPending([original.id])
  await f.factory.runner.idle()
  assert.equal(f.production.find(job.id)?.status,'completed')
  assert.equal(f.production.list(original.id).length,1)
  assert.deepEqual(f.counts(),{...before,renderCalls:before.renderCalls+1})
})

test('recovery isolates obsolete manuscripts and leaves completed and deleted work untouched',async t=>{
  const f=setup(t)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const job=f.production.list()[0]!,before=f.counts()
  f.factory.recoverPending();await f.factory.runner.idle()
  assert.deepEqual(f.counts(),before)
  job.status='queued';f.production.write(job)
  db.update(schema.episodes).set({scriptContent:'用户已经保存了另一篇正文。'}).where(eq(schema.episodes.id,f.ep.id)).run()
  f.factory.recoverPending();await f.factory.runner.idle()
  assert.equal(f.production.find(job.id)?.status,'failed')
  assert.match(f.production.find(job.id)?.error || '',/正文已更新/)
  assert.deepEqual(f.counts(),before)
  db.update(schema.episodes).set({scriptContent:f.script}).where(eq(schema.episodes.id,f.ep.id)).run()
  job.status='completed';f.production.write(job);f.factory.remove(f.ep.id)
  job.status='queued';f.production.write(job)
  f.factory.recoverPending();await f.factory.runner.idle()
  assert.deepEqual(f.counts(),before,'hidden production must not be automatically restored')
})

test('recovery honors persisted backoff and an obsolete retry timer cannot execute a replacement version',async t=>{
  const f=setup(t)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const job=f.production.list()[0]!,before=f.counts()
  job.status='queued';job.retry={attempts:2,nextAttemptAt:new Date(Date.now()+600000).toISOString(),lastError:'API error 502'}
  f.production.write(job)
  f.factory.recoverPending();await f.factory.runner.idle()
  assert.deepEqual(f.counts(),before,'future retry must survive process restart without immediate resubmission')
  const ep=db.select().from(schema.episodes).where(eq(schema.episodes.id,f.ep.id)).get()!,meta=JSON.parse(ep.metadata!)
  meta.historyFactory.jobId='replacement-job'
  db.update(schema.episodes).set({metadata:JSON.stringify(meta)}).where(eq(schema.episodes.id,f.ep.id)).run()
  f.factory.runner.schedule(job.id);await f.factory.runner.idle()
  assert.match(f.production.find(job.id)?.error || '',/当前制作版本已变化/)
  assert.deepEqual(f.counts(),before,'old retry must fail before model, audio, render or delivery')
})

test('source intake deduplicates concurrent requests and writes back original history delivery',async t=>{
  const f=setup(t),original=source(f.script)
  const [one,two]=await Promise.all([f.factory.startFromSource(original,{profile:'16:9',revision:sourceRevision(original)}),f.factory.startFromSource(original,{profile:'16:9',revision:sourceRevision(original)})])
  assert.equal(one.episode.id,two.episode.id)
  await f.factory.runner.idle()
  const detail=f.factory.detail(one.episode.id)
  assert.equal(detail.job?.status,'completed',detail.job?.error || '')
  assert.equal(detail.sourceId,original.id)
  assert.equal(detail.job?.plan?.deliveryAssociation.sourceDelivery.status,'attached')
  assert.equal(f.counts().renderCalls,1)
})

test('factory intake registers visible queued work without model or voice calls while both runner slots are occupied',async t=>{
  const f=setup(t),calls={model:0,audio:0,render:0}
  let release!:()=>void
  const blocked=new Promise<void>(resolve=>{release=resolve})
  const factory=createHistoryFactory({production:f.production,storageRoot:f.storageRoot,pipeline:{
    model:async(_system,input:any)=>{
      calls.model++;await blocked
      return {shots:input.shots.map((shot:any)=>({shotId:shot.shotId,visualType:'image',search:{query:'红军'},purpose:'出发'}))}
    },
    audio:async()=>{calls.audio++;throw Error('隔离测试到此停止')},
    render:async()=>{calls.render++;throw Error('隔离测试禁止渲染')},
  }})
  t.after(async()=>{release();await factory.runner.idle()})
  const ts=new Date().toISOString()
  const episodes=Array.from({length:3},(_,i)=>db.insert(schema.episodes).values({dramaId:f.ep.dramaId,episodeNumber:i+2,
    title:`排队测试${i}`,scriptContent:f.script,createdAt:ts,updatedAt:ts}).returning().get())
  const first=await factory.startEpisode(episodes[0]!.id)
  const second=await factory.startEpisode(episodes[1]!.id)
  const third=await factory.startEpisode(episodes[2]!.id)
  assert.ok(first.job && second.job && third.job)
  await waitFor(()=>calls.model===2)
  assert.equal(calls.model,2,'only two admitted tasks may begin model work')
  assert.equal(calls.audio,0)
  assert.equal(calls.render,0)
  assert.equal(third.job!.status,'queued')
  assert.equal(factory.list().items.find(item=>item.episodeId===third.episode.id)?.status,'queued')
  const repeat=await factory.startEpisode(third.episode.id)
  assert.equal(repeat.job!.id,third.job!.id,'repeated intake must reuse the visible queued task')
  assert.equal(calls.model,2,'queued intake must not start an extra model request')
  release();await factory.runner.idle()
  assert.deepEqual(calls,{model:3,audio:3,render:0})
})

test('completed standalone output survives metadata revision changes and attaches without rerendering',async t=>{
  const f=setup(t),original=source(f.script)
  const job=f.production.create(original.id,f.script,original.title,hashText('older source metadata'),'16:9')
  const directory=path.join(f.production.root,job.id)
  fs.mkdirSync(directory,{recursive:true})
  const outputPath=path.join(directory,'movie.mp4')
  fs.writeFileSync(outputPath,'verified-movie')
  job.status='completed';job.stage='rendered';job.outputPath=outputPath
  job.plan={width:1920,height:1080,fps:30,durationInFrames:60,
    delivery:{sha256:hashText('verified-movie'),qa:{technical:'passed'}}}
  f.production.write(job)
  const started=await f.factory.startFromSource(original,{profile:'16:9'})
  await f.factory.runner.idle()
  const detail=f.factory.detail(started.episode.id)
  assert.equal(detail.job?.id,job.id)
  assert.equal(detail.job?.status,'completed',detail.job?.error || '')
  assert.equal(detail.sourceId,original.id)
  assert.equal(detail.job?.plan?.deliveryAssociation.sourceDelivery.status,'attached')
  assert.deepEqual(f.counts(),{modelCalls:0,renderCalls:0,audioCalls:0})
  assert.equal(f.production.list(original.id).length,1)
})

for(const status of ['completed','failed'] as const) {
  test(`a ${status} standalone long-manuscript output keeps its original source version during delivery recovery`,async t=>{
    const f=setup(t),script='已完成旧版历史稿。'.repeat(700),original=source(script)
    const job=f.production.create(original.id,script,original.title,sourceRevision(original),'16:9')
    const directory=path.join(f.production.root,job.id)
    fs.mkdirSync(directory,{recursive:true})
    job.status=status;job.stage='rendered';job.outputPath=path.join(directory,'movie.mp4')
    fs.writeFileSync(job.outputPath,'verified-movie')
    job.plan={delivery:{sha256:hashText('verified-movie'),qa:{technical:'passed'}}}
    f.production.write(job)
    const factory=createHistoryFactory({production:f.production,storageRoot:f.storageRoot,
      sourceStorageRoot:path.join(f.storageRoot,'source-locks'),
      condenseScript:async()=>assert.fail('An existing output must retain its locked manuscript'),
      runnerFactory:()=>({schedule:()=>{},isRunning:()=>false,idle:async()=>{},stop:async()=>{}})})
    const result=await factory.startFromSource(original,{profile:'16:9'})
    assert.equal(result.job?.id,job.id)
    assert.equal(result.episode.script,script)
    assert.equal(getHistorySource(original.id)?.rewrittenScript,script)
    assert.equal(f.production.list(original.id).length,1)
  })
}

test('web route starts actual production and exports evidence without local media paths',async t=>{
  const f=setup(t),app=createHistoryFactoryRoute(()=>f.factory)
  const response=await app.request(`/episodes/${f.ep.id}/history-production/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
  assert.equal(response.status,200)
  await f.factory.runner.idle()
  const evidence=await app.request(`/episodes/${f.ep.id}/history-production/evidence`)
  assert.match(evidence.headers.get('Content-Disposition') || '',/attachment/)
  const detail=await evidence.json()
  assert.equal(detail.job.status,'completed')
  assert.equal(detail.job.plan.audioPath,undefined)
  assert.equal(detail.job.factory.fallbackImages,undefined)
})

test('deletion hides only the exact Episode production and preserves source, shots, jobs and saved media',async t=>{
  const f=setup(t),original=source(f.script),started=await f.factory.startFromSource(original,{profile:'16:9'})
  await f.factory.runner.idle()
  const before=f.factory.detail(started.episode.id),app=createHistoryFactoryRoute(()=>f.factory)
  const savedEpisode=db.select().from(schema.episodes).where(eq(schema.episodes.id,before.episode.id)).get()!
  const savedJob=f.production.find(before.job!.id)!,savedSource=getHistorySource(original.id)
  const savedProjects=db.select().from(schema.remotionProjects).all()
  const savedRenders=db.select().from(schema.remotionRenders).all()
  const savedBoards=db.select().from(schema.storyboards).all()
  const response=await app.request(`/episodes/${before.episode.id}/history-production`,{method:'DELETE'})
  assert.equal(response.status,200)
  assert.deepEqual((await response.json()).data,{episodeId:before.episode.id,deleted:true})
  assert.equal(f.factory.list().items.some(item=>item.episodeId===before.episode.id),false)
  assert.equal(f.factory.list().items.some(item=>item.episodeId===f.ep.id),true,'unrelated Episode stays visible')
  assert.throws(()=>f.factory.detail(before.episode.id),/已删除/)
  assert.equal((await app.request(`/episodes/${before.episode.id}/history-production`)).status,404)
  const after=db.select().from(schema.episodes).where(eq(schema.episodes.id,before.episode.id)).get()!
  assert.equal(after.deletedAt,null,'deleting a production must not delete its Episode')
  assert.equal(after.scriptContent,savedEpisode.scriptContent)
  assert.equal(after.videoUrl,savedEpisode.videoUrl)
  assert.ok(JSON.parse(after.metadata!).historyFactory.deletedAt)
  assert.deepEqual(f.production.find(savedJob.id),savedJob)
  assert.deepEqual(getHistorySource(original.id),savedSource)
  assert.deepEqual(db.select().from(schema.remotionProjects).all(),savedProjects)
  assert.deepEqual(db.select().from(schema.remotionRenders).all(),savedRenders)
  assert.deepEqual(db.select().from(schema.storyboards).all(),savedBoards)
  assert.ok(savedRenders.filter(render=>render.projectId===savedJob.factory!.projectId).every(render=>render.outputPath && fs.existsSync(render.outputPath)))
  assert.equal((await app.request(`/episodes/${before.episode.id}/history-production`,{method:'DELETE'})).status,200)
  assert.equal(db.select().from(schema.episodes).where(eq(schema.episodes.id,before.episode.id)).get()!.metadata,after.metadata,'repeat deletion is idempotent')
})

test('deleted source production only restores after an explicit request and reuses its original completed output',async t=>{
  const f=setup(t),original=source(f.script),started=await f.factory.startFromSource(original,{profile:'16:9'})
  await f.factory.runner.idle()
  const before=f.factory.detail(started.episode.id),app=createHistoryFactoryRoute(()=>f.factory),counts=f.counts()
  assert.equal((await app.request(`/episodes/${started.episode.id}/history-production`,{method:'DELETE'})).status,200)
  await assert.rejects(f.factory.startFromSource(original,{profile:'16:9'}),/已删除/)
  await assert.rejects(f.factory.startEpisode(started.episode.id,{retry:true}),/已删除/)
  assert.equal(f.factory.list().items.some(item=>item.episodeId===started.episode.id),false)
  const response=await app.request('/history-productions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId:original.id,profile:'16:9'})})
  assert.equal(response.status,200)
  const restored=(await response.json()).data
  assert.equal(restored.episode.id,started.episode.id)
  assert.equal(restored.job.id,before.job!.id)
  assert.equal(restored.episode.videoUrl,before.episode.videoUrl)
  assert.equal(f.factory.list().items.some(item=>item.episodeId===started.episode.id),true)
  assert.deepEqual(f.counts(),counts,'restoring a completed task must not render or generate media again')
  assert.equal(f.production.list(original.id).length,1)
})

test('deletion rejects queued and active productions and validates Episode IDs without project fallback',async t=>{
  const f=setup(t),app=createHistoryFactoryRoute(()=>f.factory)
  for(const id of ['0','-1','1.1','nope','9007199254740992']) {
    assert.equal((await app.request(`/episodes/${id}/history-production`,{method:'DELETE'})).status,400)
  }
  assert.equal((await app.request('/episodes/999999/history-production',{method:'DELETE'})).status,404)
  const started=await f.factory.startEpisode(f.ep.id)
  const blocked=await app.request(`/episodes/${f.ep.id}/history-production`,{method:'DELETE'})
  assert.equal(blocked.status,409)
  assert.match((await blocked.json()).message,/制作中|正在|排队/)
  assert.equal(f.factory.list().items.some(item=>item.episodeId===f.ep.id),true)
  await f.factory.runner.idle()
  const saved=f.production.find(started.job!.id)!
  for(const status of ['queued','planning','selecting','rendering','validating'] as const) {
    saved.status=status;f.production.write(saved)
    assert.equal((await app.request(`/episodes/${f.ep.id}/history-production`,{method:'DELETE'})).status,409,status)
  }
  saved.status='completed';f.production.write(saved)
  assert.equal((await app.request(`/episodes/${f.ep.id}/history-production`,{method:'DELETE'})).status,200)
})

test('source-linked format changes keep delivery identity and stale source retries fail before rendering',async t=>{
  const f=setup(t),original=source(f.script)
  const first=await f.factory.startFromSource(original,{profile:'16:9'});await f.factory.runner.idle()
  const alternate=await f.factory.startEpisode(first.episode.id,{profile:'9:16'});await f.factory.runner.idle()
  assert.equal(alternate.job?.scriptId,original.id)
  assert.equal(alternate.sourceId,original.id)
  const current=f.production.find(alternate.job!.id)!
  current.status='failed';f.production.write(current)
  updateHistorySource(original.id,{rewrittenScript:'原稿已修改。'})
  const before=f.counts().renderCalls
  await assert.rejects(f.factory.startEpisode(first.episode.id,{retry:true}),/来源稿件已更新/)
  assert.equal(f.counts().renderCalls,before)
})

test('mismatched existing narration blocks paid work and leaves recoverable task',async t=>{
  const f=setup(t)
  db.update(schema.episodes).set({preTtsTitlesJson:JSON.stringify([{text:'另一版正文',time_begin:0,time_end:2000}])}).where(eq(schema.episodes.id,f.ep.id)).run()
  await assert.rejects(f.factory.startEpisode(f.ep.id),/配音时间码与正文不一致/)
  assert.equal(f.factory.detail(f.ep.id).job?.status,'failed')
  assert.deepEqual(f.counts(),{modelCalls:0,renderCalls:0,audioCalls:0})
})

test('Episode shot projection preserves actual sampled observations separately from source annotations',async t=>{
  const f=setup(t)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const saved=f.production.find(f.factory.detail(f.ep.id).job!.id)!
  const evidence={annotation:{description:'素材原标注'},visualEvidence:{status:'sampled',decision:'uncertain',observation:{summary:'抽帧可见内容'},limitations:'仅两帧抽检'},sceneCuts:'not_reviewed'}
  saved.plan!.shots[0].sourceEvidence=evidence
  f.factory.production.write(saved)
  const projected=db.select().from(schema.remotionShots).where(eq(schema.remotionShots.projectId,saved.factory!.projectId)).get()!
  const actual=JSON.parse(projected.sourceEvidenceJson!)
  assert.equal(actual.visualReview,'sampled')
  assert.deepEqual(actual.annotation,evidence.annotation)
  assert.deepEqual(actual.visualEvidence,evidence.visualEvidence)
  assert.equal(actual.sceneCuts,'not_reviewed')
})

test('shot projection archives a merged 53rd row and restores it on growth without changing saved renders',async t=>{
  const f=setup(t)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const saved=f.production.find(f.factory.detail(f.ep.id).job!.id)!,projectId=saved.factory!.projectId
  const priorRenders=db.select().from(schema.remotionRenders).where(eq(schema.remotionRenders.projectId,projectId)).all()
  const original=Array.from({length:53},(_,index)=>({...saved.plan!.shots[0],shotId:`projection-${index+1}`,
    startFrame:index*60,frames:60,duration:2,narration:`第${index+1}镜。`}))
  const rows=()=>db.select().from(schema.remotionShots).where(eq(schema.remotionShots.projectId,projectId)).all().sort((a,b)=>a.shotNumber-b.shotNumber)
  saved.plan!.shots=original
  f.factory.production.write(saved)
  const before=rows(),tailId=before[52].id
  assert.equal(before.filter(row=>!row.deletedAt).length,53)

  saved.plan!.shots=[...original.slice(0,16),{...original[16],narration:original[16].narration+original[17].narration,frames:120,duration:4},...original.slice(18)]
  f.factory.production.write(saved)
  const merged=rows(),active=merged.filter(row=>!row.deletedAt)
  assert.equal(active.length,52,'the last old shot must not survive as a duplicate final shot')
  assert.equal(merged.length,53,'archive instead of physically deleting projected history')
  assert.equal(merged[52].id,tailId)
  assert.ok(merged[52].deletedAt)
  assert.deepEqual(active.map(row=>row.shotNumber),Array.from({length:52},(_,i)=>i+1))
  assert.equal(active.map(row=>row.narration).join(''),original.map(shot=>shot.narration).join(''))
  assert.equal(active[16].durationMs,4000)
  assert.equal(f.factory.detail(f.ep.id).shots.length,52)

  saved.plan!.shots=original
  f.factory.production.write(saved)
  const restored=rows()
  assert.equal(restored.filter(row=>!row.deletedAt).length,53)
  assert.equal(restored[52].id,tailId,'a restored shot keeps its existing row identity')
  assert.equal(restored[52].deletedAt,null)
  assert.deepEqual(db.select().from(schema.remotionRenders).where(eq(schema.remotionRenders.projectId,projectId)).all(),priorRenders)
  assert.ok(priorRenders.every(render=>render.outputPath && fs.existsSync(render.outputPath)))
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId,f.ep.id)).all().length,1)
})

test('rebuild starts a new render from a completed Episode without changing the script or deleting the prior output',async t=>{
  const f=setup(t)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const before=f.factory.detail(f.ep.id),oldOutput=f.production.find(before.job!.id)?.outputPath,oldVideo=before.episode.videoUrl,oldScript=before.episode.script
  const rebuilt=await f.factory.startEpisode(f.ep.id,{rebuild:true,profile:'9:16'});assert.equal(rebuilt.job?.profile,'16:9');assert.equal(rebuilt.episode.script,oldScript)
  assert.equal(rebuilt.job?.status,'queued');assert.match(rebuilt.job?.message || '',/旧成片已保留/)
  await f.factory.runner.idle()
  const after=f.factory.detail(f.ep.id)
  assert.equal(after.job?.status,'completed',after.job?.error || '')
  assert.equal(after.episode.script,oldScript)
  assert.equal(after.episode.videoUrl,oldVideo)
  assert.equal(after.job?.plan?.revisions.length,1)
  assert.equal(f.production.find(after.job!.id)?.plan?.revisions[0].outputPath,oldOutput)
  assert.equal(after.job?.plan?.revisions[0].outputPath,undefined)
  assert.deepEqual(f.counts(),{modelCalls:1,renderCalls:2,audioCalls:1},'rebuild reuses manuscript design and audio')
  assert.equal(f.counts().renderCalls,2)
})

test('rebuild route rejects an unfinished Episode and runs a completed one without changing profile',async t=>{
  const f=setup(t),app=createHistoryFactoryRoute(()=>f.factory)
  const response=await app.request(`/episodes/${f.ep.id}/history-production/rebuild`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
  assert.equal(response.status,400)
  assert.equal(f.production.list().length,0,'invalid rebuild must not create an orphan job')
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const done=await app.request(`/episodes/${f.ep.id}/history-production/rebuild`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:'9:16'})})
  assert.equal(done.status,200)
  await f.factory.runner.idle()
  assert.equal(f.factory.detail(f.ep.id).job?.status,'completed')
  assert.equal(f.factory.detail(f.ep.id).job?.profile,'16:9')
})

test('rebuild with an explicit voice replaces the seeded master and reuses completed visuals',async t=>{
  const f=setup(t),app=createHistoryFactoryRoute(()=>f.factory)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const before=f.production.find(f.factory.detail(f.ep.id).job!.id)!,oldAudio=before.plan!.audioPath,oldImage=before.plan!.shots[0].imagePath
  const response=await app.request(`/episodes/${f.ep.id}/history-production/rebuild`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voiceId:'requested-history-voice'}),
  })
  assert.equal(response.status,200)
  await f.factory.runner.idle()
  const after=f.production.find(before.id)!
  assert.equal(after.status,'completed',after.error || '')
  assert.equal(after.plan!.audioSettings.voiceId,'requested-history-voice')
  assert.notEqual(after.plan!.audioPath,oldAudio)
  assert.equal(after.plan!.shots[0].imagePath,oldImage)
  assert.equal(after.plan!.revisions[0].audioPath,oldAudio)
  assert.equal(after.script,before.script)
  assert.ok(fs.existsSync(oldAudio))
  const ep=db.select().from(schema.episodes).where(eq(schema.episodes.id,f.ep.id)).get()!
  assert.equal(ep.narrationVoiceId,'requested-history-voice')
  assert.notEqual(ep.preTtsAudioUrl,'/static/audio/master.m4a')
  assert.deepEqual(f.counts(),{modelCalls:1,renderCalls:2,audioCalls:2})
})

test('a delivery retry requesting a different voice renders again rather than delivering the old voice',async t=>{
  const f=setup(t)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const before=f.production.find(f.factory.detail(f.ep.id).job!.id)!
  before.status='failed';before.stage='rendered';before.error='association failed'
  f.factory.production.write(before)
  await f.factory.startEpisode(f.ep.id,{retry:true,voiceId:'new-voice-on-delivery-retry'})
  await f.factory.runner.idle()
  const after=f.production.find(before.id)!
  assert.equal(after.status,'completed',after.error || '')
  assert.equal(after.plan!.audioSettings.voiceId,'new-voice-on-delivery-retry')
  assert.equal(after.plan!.revisions[0].outputPath,before.outputPath)
  assert.deepEqual(f.counts(),{modelCalls:1,renderCalls:2,audioCalls:2})
})

test('rebuild rejects simultaneous requests and changed manuscript before clearing completed output',async t=>{
  const f=setup(t)
  await f.factory.startEpisode(f.ep.id);await f.factory.runner.idle()
  const first=f.factory.startEpisode(f.ep.id,{rebuild:true})
  await assert.rejects(f.factory.startEpisode(f.ep.id,{rebuild:true}),/正在/)
  await first;await f.factory.runner.idle()
  const before=f.factory.detail(f.ep.id),saved=f.production.find(before.job!.id)!
  db.update(schema.episodes).set({scriptContent:'正文变动。'}).where(eq(schema.episodes.id,f.ep.id)).run()
  await assert.rejects(f.factory.startEpisode(f.ep.id,{rebuild:true}),/正文已更新/)
  const after=f.production.find(saved.id)!
  assert.equal(after.status,'completed');assert.equal(after.outputPath,saved.outputPath)
  assert.equal(f.production.list().length,1)
  assert.equal(f.counts().renderCalls,2)
})
