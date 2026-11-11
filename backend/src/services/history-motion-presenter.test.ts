import test,{after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-presenter-db-'))
process.env.DB_PATH=path.join(root,'db.sqlite')
process.env.STORAGE_PATH=path.join(root,'static')
process.env.TASK_WORKER_DISABLED='1'
const {createHistoryMotionProduction,hashText,motionPlanSchema}=await import('./history-motion-production.js')
const {createMotionRunner}=await import('./history-motion-pipeline.js')
const {db,schema}=await import('../db/index.js')
const {eq}=await import('drizzle-orm')
const {createHistoryFactory}=await import('./history-factory.js')
const {createHistoryFactoryRoute}=await import('../routes/history-factory.js')
import type {MotionPipelineDependencies} from './history-motion-pipeline.js'
after(()=>{db.$client.close();fs.rmSync(root,{recursive:true,force:true})})

function environment(t:TestContext,enabled:boolean) {
  const names=['HISTORY_PRESENTER_ENABLED','HISTORY_PRESENTER_LIBRARY_PATH'],previous=names.map(name=>process.env[name])
  process.env.HISTORY_PRESENTER_ENABLED=enabled?'1':'0';process.env.HISTORY_PRESENTER_LIBRARY_PATH='/tmp/history-ready.json'
  t.after(()=>names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index]}))
}
function fixture(t:TestContext) {
  const directory=fs.mkdtempSync(path.join(root,'job-')),materials=path.join(directory,'materials')
  fs.mkdirSync(materials)
  const service=createHistoryMotionProduction({databasePath:path.join(directory,'jobs.sqlite'),root:path.join(directory,'jobs'),materialRoot:materials,library:{search:()=>[]}})
  const script='队伍从瑞金出发。',job=service.createPlan(1,motionPlanSchema.parse({scriptRevision:hashText(script),profile:'16:9',
    shots:[{shotId:'s1',narration:script,duration:2,visualType:'graphic',graphic:{kind:'quote',title:'瑞金',items:[{label:'瑞金'}]},search:{query:'瑞金'},titles:[]}]}),script,'瑞金')
  let renders=0,audios=0,prepares=0
  const delivered:any[]=[],preparations:any[]=[]
  const overrides:Partial<MotionPipelineDependencies>={
    audio:async(_script,dir)=>{audios++;const audioPath=path.join(dir,'audio.m4a');fs.writeFileSync(audioPath,'voice');return {audioPath,duration:2}},
    generateImage:async input=>{const filename=path.join(input.directory,`${input.shotId}.png`);fs.writeFileSync(filename,'image');return {path:filename,sha256:hashText('image')}},
    render:async(_plan,dir)=>{renders++;const outputPath=path.join(dir,'body.mp4');fs.writeFileSync(outputPath,'body');return {outputPath,report:{sha256:hashText('body'),duration:2,qa:{technical:'passed'}}}},
    preparePresenter:async input=>{
      prepares++;preparations.push(input);fs.mkdirSync(input.directory,{recursive:true})
      const outputPath=path.join(input.directory,'final.mp4');fs.writeFileSync(outputPath,'final')
      return {outputPath,report:{sha256:hashText('final'),duration:12,width:1920,height:1080,fps:30,qa:{technical:'passed'},
        presenterIntro:{fingerprint:hashText('intro'),avatarId:'xiaoba-history-01',referenceSha256:hashText('reference')}}}
    },
    deliver:async(saved,output)=>{delivered.push({job:saved,output});return {status:'attached'}},
  }
  t.after(()=>service.close())
  return {service,job,overrides,delivered,preparations,counts:()=>({renders,audios,prepares})}
}

test('disabled history presenter preserves the existing render and delivery behavior',async t=>{
  environment(t,false);const f=fixture(t),runner=createMotionRunner(f.service,f.overrides)
  runner.schedule(f.job.id);await runner.idle()
  assert.deepEqual(f.counts(),{renders:1,audios:1,prepares:0})
  assert.equal(f.delivered[0].output.sha256,hashText('body'))
  assert.equal(f.service.find(f.job.id)!.status,'completed')
})

test('factory detail reports the main backend presenter policy without changing an existing job policy',async t=>{
  environment(t,true);const f=fixture(t),ts=new Date().toISOString()
  const drama=db.insert(schema.dramas).values({title:'只读策略',createdAt:ts,updatedAt:ts}).returning().get()
  const ep=db.insert(schema.episodes).values({dramaId:drama.id,episodeNumber:1,title:'策略检查',scriptContent:f.job.script,
    metadata:JSON.stringify({historyFactory:{jobId:f.job.id}}),createdAt:ts,updatedAt:ts}).returning().get()
  const factory=createHistoryFactory({production:f.service,storageRoot:path.join(root,'policy-static')})
  const before=f.service.find(f.job.id)
  const enabled=factory.detail(ep.id) as any
  assert.deepEqual(enabled.presenterRuntimePolicy,{enabled:true,version:1,character:'history',presenter:'xiaoba',libraryPath:'/tmp/history-ready.json'})
  process.env.HISTORY_PRESENTER_ENABLED='0'
  assert.deepEqual((factory.detail(ep.id) as any).presenterRuntimePolicy,{enabled:false})
  assert.deepEqual(f.service.find(f.job.id),before)
})

test('new history production snapshots its policy and delivers only the final presenter bytes and report',async t=>{
  environment(t,true);const f=fixture(t),runner=createMotionRunner(f.service,f.overrides)
  runner.schedule(f.job.id);await runner.idle()
  const saved=f.service.find(f.job.id)!
  assert.equal(saved.status,'completed');assert.deepEqual(f.counts(),{renders:1,audios:1,prepares:1})
  assert.equal(f.preparations[0].libraryPath,'/tmp/history-ready.json')
  assert.equal(fs.readFileSync(f.preparations[0].videoPath,'utf8'),'body')
  assert.equal(saved.plan!.historyPresenterSource.report.sha256,hashText('body'))
  assert.equal(saved.plan!.delivery.sha256,hashText('final'));assert.equal(saved.plan!.delivery.duration,12)
  assert.equal(saved.plan!.durationInFrames,60,'body shot timing is retained separately from final video duration')
  assert.equal(f.delivered[0].output.sha256,hashText('final'));assert.equal(f.delivered[0].output.filename,fs.realpathSync(saved.outputPath!))
})

test('a restarted composition retry reuses its persisted body and policy and never delivers the incomplete edition',async t=>{
  environment(t,true);const f=fixture(t)
  const first=createMotionRunner(f.service,{...f.overrides,preparePresenter:async()=>{throw Error('waiting for approved Xiaoba avatar')}})
  first.schedule(f.job.id);await first.idle()
  const failed=f.service.find(f.job.id)!
  assert.equal(failed.status,'failed');assert.equal(failed.stage,'rendered');assert.equal(f.delivered.length,0)
  assert.equal(fs.readFileSync(failed.plan!.historyPresenterSource.outputPath,'utf8'),'body')
  process.env.HISTORY_PRESENTER_ENABLED='0';process.env.HISTORY_PRESENTER_LIBRARY_PATH='/tmp/another-library.json'
  const resumed=createMotionRunner(f.service,f.overrides)
  resumed.schedule(f.job.id);await resumed.idle()
  assert.equal(f.service.find(f.job.id)!.status,'completed')
  assert.deepEqual(f.counts(),{renders:1,audios:1,prepares:1})
  assert.equal(f.preparations[0].libraryPath,'/tmp/history-ready.json','the interrupted task cannot silently switch libraries')
  assert.equal(f.delivered.length,1)
})

test('an already rendered edition without presenter policy is not changed by enabling new productions',async t=>{
  environment(t,true);const f=fixture(t),directory=path.join(f.service.root,f.job.id)
  fs.mkdirSync(directory,{recursive:true});const outputPath=path.join(directory,'old.mp4');fs.writeFileSync(outputPath,'old')
  f.job.outputPath=outputPath;f.job.stage='rendered';f.job.status='failed';f.job.plan={delivery:{sha256:hashText('old'),qa:{technical:'passed'}}}
  f.service.write(f.job)
  const runner=createMotionRunner(f.service,f.overrides);runner.schedule(f.job.id);await runner.idle()
  assert.deepEqual(f.counts(),{renders:0,audios:0,prepares:0});assert.equal(f.delivered[0].output.sha256,hashText('old'))
})

test('a restart immediately after saving the body report resumes postprocessing from validating without rerendering',async t=>{
  environment(t,true);const f=fixture(t),directory=path.join(f.service.root,f.job.id)
  fs.mkdirSync(directory,{recursive:true});const outputPath=path.join(directory,'body.mp4');fs.writeFileSync(outputPath,'body')
  const report={sha256:hashText('body'),duration:2,qa:{technical:'passed'}}
  f.job.outputPath=outputPath;f.job.stage='validating';f.job.status='queued';f.job.plan={delivery:report,
    historyPresenterPolicy:{version:1,character:'history',presenter:'xiaoba',libraryPath:'/tmp/history-ready.json'},
    historyPresenterSource:{outputPath,report}}
  f.service.write(f.job)
  const runner=createMotionRunner(f.service,f.overrides);runner.schedule(f.job.id);await runner.idle()
  assert.equal(f.service.find(f.job.id)!.status,'completed');assert.deepEqual(f.counts(),{renders:0,audios:0,prepares:1})
})

test('incorrect final bytes cannot reach delivery even when a presenter adapter claims success',async t=>{
  environment(t,true);const f=fixture(t)
  const runner=createMotionRunner(f.service,{...f.overrides,preparePresenter:async input=>{
    const result=await f.overrides.preparePresenter!(input,{signal:new AbortController().signal})
    fs.writeFileSync(result.outputPath,'tampered');return result
  }})
  runner.schedule(f.job.id);await runner.idle()
  assert.equal(f.service.find(f.job.id)!.status,'failed');assert.equal(f.delivered.length,0)
  assert.match(f.service.find(f.job.id)!.error!,/成片已变化/)
})

test('factory registration records final duration and Xiaoba metadata while retaining the original body timeline',async t=>{
  environment(t,true);const f=fixture(t),ts=new Date().toISOString()
  const drama=db.insert(schema.dramas).values({title:'历史小疤测试',createdAt:ts,updatedAt:ts}).returning().get()
  const ep=db.insert(schema.episodes).values({dramaId:drama.id,episodeNumber:1,title:'历史小疤',scriptContent:f.job.script,createdAt:ts,updatedAt:ts}).returning().get()
  const {deliver,...pipeline}=f.overrides
  const storageRoot=path.join(root,'factory-static'),savedMasterTime=new Date('2000-01-01T00:00:00Z')
  let savedMasterPath=''
  const factory=createHistoryFactory({production:f.service,storageRoot,pipeline:{...pipeline,
    audio:async(script,directory)=>{
      const audioPath=path.join(directory,'audio.m4a');fs.writeFileSync(audioPath,'voice')
      const narration={script,audioPath,duration:2,audioSettings:{voiceId:'history-voice'}}
      fs.writeFileSync(path.join(directory,'narration.json'),JSON.stringify(narration));return narration
    },
    preparePresenter:async(input,options)=>{
      const pending=db.select().from(schema.episodes).where(eq(schema.episodes.id,ep.id)).get()!
      assert.equal(pending.duration,2);assert.ok(pending.preTtsAudioUrl)
      savedMasterPath=path.join(storageRoot,pending.preTtsAudioUrl!.replace('/static/',''))
      fs.utimesSync(savedMasterPath,savedMasterTime,savedMasterTime)
      return pipeline.preparePresenter!(input,options)
    },
    model:async(_system,input:any)=>({shots:input.shots.map((shot:any)=>({shotId:shot.shotId,visualType:'graphic',graphic:{kind:'quote',title:'瑞金',items:[{label:'瑞金'}]},search:{query:'瑞金'},titles:[]}))}),
  }})
  const started=await factory.startEpisode(ep.id,{voiceId:'history-voice'})
  await factory.runner.idle()
  const saved=f.service.find(started.job!.id)!
  assert.equal(saved.status,'completed',saved.error || '')
  const registered=db.select().from(schema.remotionRenders).where(eq(schema.remotionRenders.projectId,saved.factory!.projectId)).get()!
  assert.equal(registered.durationMs,12000);assert.equal(JSON.parse(registered.propsJson!).presenter.avatarId,'xiaoba-history-01')
  assert.equal(saved.plan!.durationInFrames,60);assert.equal(JSON.parse(registered.qaJson!).sha256,hashText('final'))
  const completed=db.select().from(schema.episodes).where(eq(schema.episodes.id,ep.id)).get()!
  assert.equal(completed.duration,12,'the Episode uses the actual completed video duration after its narration was saved')
  assert.equal(fs.statSync(savedMasterPath).mtimeMs,savedMasterTime.getTime(),'final synchronization must not recopy the existing narration master')
  assert.equal(fs.readFileSync(savedMasterPath,'utf8'),'voice')
})

test('factory detail exposes the current runner state separately from persisted queued status without changing the job',async t=>{
  const f=fixture(t),ts=new Date().toISOString(),active=new Set<string>()
  const drama=db.insert(schema.dramas).values({title:'历史运行状态',createdAt:ts,updatedAt:ts}).returning().get()
  const ep=db.insert(schema.episodes).values({dramaId:drama.id,episodeNumber:1,title:'历史运行状态',scriptContent:f.job.script,createdAt:ts,updatedAt:ts}).returning().get()
  const factory=createHistoryFactory({production:f.service,storageRoot:path.join(root,'runner-status-static'),
    runnerFactory:()=>({schedule:()=>{},isRunning:id=>active.has(id),idle:async()=>{},stop:async()=>{}}),
  })
  const app=createHistoryFactoryRoute(()=>factory),url=`/episodes/${ep.id}/history-production`
  assert.equal(factory.detail(ep.id).jobRunning,false)
  assert.equal((await (await app.request(url)).json()).data.jobRunning,false)
  const started=await factory.startEpisode(ep.id),jobId=started.job!.id
  const original=f.service.find(jobId)
  assert.equal(started.jobRunning,false);assert.equal(started.job!.status,'queued')
  active.add(jobId)
  const running=(await (await app.request(url)).json()).data
  assert.equal(running.jobRunning,true);assert.equal(running.job.status,'queued')
  active.delete(jobId)
  const stale=(await (await app.request(url)).json()).data
  assert.equal(stale.jobRunning,false);assert.equal(stale.job.status,'queued')
  assert.deepEqual(f.service.find(jobId),original,'reading the runner projection must not update the persisted task')
})
