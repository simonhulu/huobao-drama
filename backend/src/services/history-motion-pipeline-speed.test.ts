import test,{after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createHistoryMotionProduction,hashText,isTransientMotionError,motionPlanSchema} from './history-motion-production.js'
import {createMotionRunner,motionRenderExitError,type MotionPipelineDependencies} from './history-motion-pipeline.js'

const dbRoot=fs.mkdtempSync(path.join(os.tmpdir(),'motion-speed-db-'))
process.env.DB_PATH=path.join(dbRoot,'db.sqlite')
process.env.STORAGE_PATH=path.join(dbRoot,'static')
process.env.TASK_WORKER_DISABLED='1'
after(async()=>{const {db}=await import('../db/index.js');db.$client.close();fs.rmSync(dbRoot,{recursive:true,force:true})})

test('render disk failures retain the actionable reason across the child-process boundary', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'render-failure-')),output=path.join(root,'movie.mp4')
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  fs.mkdirSync(output+'.render')
  assert.match(motionRenderExitError(output,1).message,/退出 1/)
  const filename=path.join(output+'.render','failure.json')
  fs.writeFileSync(filename,JSON.stringify({status:'failed',code:'MEDIA_DISK_FULL',error:'reserve reached'}))
  assert.equal((motionRenderExitError(output,1) as Error & {code:string}).code,'MEDIA_DISK_FULL')
  assert.match(motionRenderExitError(output,1).message,/释放空间后可重试原任务/)
  assert.match(motionRenderExitError(output,1,true).message,/渲染超时/)
  for(const content of ['{broken',JSON.stringify({status:'completed',code:'MEDIA_DISK_FULL'}),JSON.stringify({status:'failed',code:'OTHER_ERROR'})]) {
    fs.writeFileSync(filename,content)
    assert.match(motionRenderExitError(output,1).message,/退出 1/)
  }
})

test('Remotion frame timeouts remain retryable without treating invalid media as transient',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'render-frame-timeout-')),output=path.join(root,'movie.mp4')
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  fs.mkdirSync(output+'.render')
  const filename=path.join(output+'.render','failure.json')
  fs.writeFileSync(filename,JSON.stringify({status:'failed',error:'Timeout (90000ms) exceeded rendering the component at frame 1572.\n    at seek-to-frame.js:86:28'}))
  const timeout=motionRenderExitError(output,1) as Error & {code:string}
  assert.equal(timeout.code,'MOTION_RENDER_TIMEOUT')
  assert.equal(isTransientMotionError(timeout),true)
  assert.match(timeout.message,/frame 1572/)
  fs.writeFileSync(filename,JSON.stringify({status:'failed',error:'Invalid video input\n    at decode.js:1:2'}))
  const invalid=motionRenderExitError(output,1)
  assert.match(invalid.message,/Invalid video input/)
  assert.equal(isTransientMotionError(invalid),false)
})

function signal() {
  let resolve!:()=>void
  const promise=new Promise<void>(done=>{resolve=done})
  return {promise,resolve}
}
async function reached(promise:Promise<void>,message:string) {
  let timer:ReturnType<typeof setTimeout>|undefined
  try {await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),1000)})])}
  finally {clearTimeout(timer)}
}
function fixture(t:TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-speed-')),materials=path.join(root,'materials')
  fs.mkdirSync(materials)
  let rows:any[]=[],renderCalls=0
  const service=createHistoryMotionProduction({databasePath:path.join(root,'jobs.sqlite'),root:path.join(root,'jobs'),materialRoot:materials,library:{search:()=>rows}})
  const create=(scriptId:number,count:number)=>{
    const shots=Array.from({length:count},(_,index)=>({shotId:`s${index+1}`,narration:`第${index+1}支队伍行进。`,duration:2,search:{query:'队伍'},titles:[]}))
    const script=shots.map(s=>s.narration).join('')
    return service.createPlan(scriptId,motionPlanSchema.parse({scriptRevision:hashText(`${scriptId}:${script}`),profile:'16:9',shots}),script,'队伍')
  }
  const image=async(input:{directory:string;shotId:string})=>{
    const filename=path.join(input.directory,`${input.shotId}.png`)
    fs.writeFileSync(filename,`${input.directory}:${input.shotId}`)
    return {path:filename,sha256:hashText(`${input.directory}:${input.shotId}`)}
  }
  const overrides:Partial<MotionPipelineDependencies>={
    audio:async(script,directory)=>{const audioPath=path.join(directory,'audio.m4a');fs.writeFileSync(audioPath,'voice');return {audioPath,duration:script.split('。').length*2-2}},
    generateImage:image,
    probeVideo:async()=>({duration:8,width:1920,height:1080}),
    reviewVideo:async()=>({status:'unavailable',decision:'uncertain',reason:'fixture unavailable',method:'two-frame-model-review',limitations:'fixture'}),
    render:async(_plan,directory)=>{renderCalls++;const outputPath=path.join(directory,'movie.mp4');fs.writeFileSync(outputPath,'movie');return {outputPath,report:{sha256:hashText('movie'),qa:{technical:'passed'}}}},
    deliver:async()=>({status:'attached'}),
  }
  const candidate=(id:string)=>{const localPath=path.join(materials,`${id}.mp4`);fs.writeFileSync(localPath,id);return {assetId:id,rank:1,status:'done',sourceCaption:'队伍行进',query:'队伍',text:'',duration:8,width:1920,height:1080,localPath,sha256:hashText(id),projectId:'p',clipId:'c'}}
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true})})
  return {service,create,image,overrides,candidate,setRows:(value:any[])=>{rows=value},renderCalls:()=>renderCalls}
}

test('a frame timeout releases the render lane and reuses the same narration and images on retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const f=fixture(t),first=f.create(1,1),second=f.create(2,1),audioCalls:string[]=[],imageCalls:string[]=[]
  let failed=false
  const runner=createMotionRunner(f.service,{...f.overrides,
    audio:async(script,directory)=>{audioCalls.push(directory);return f.overrides.audio!(script,directory)},
    generateImage:async input=>{imageCalls.push(input.directory);return f.image(input)},
    render:async(plan,directory)=>{
      if(directory===path.join(f.service.root,first.id) && !failed) {
        failed=true
        const output=path.join(directory,'failed.mp4')
        fs.mkdirSync(output+'.render')
        fs.writeFileSync(path.join(output+'.render','failure.json'),JSON.stringify({status:'failed',error:'Timeout (90000ms) exceeded rendering the component at frame 1572.'}))
        throw motionRenderExitError(output,1)
      }
      return f.overrides.render!(plan,directory)
    },
  })
  runner.schedule(first.id);runner.schedule(second.id);await runner.idle()
  const waiting=f.service.find(first.id)!
  assert.equal(waiting.status,'queued');assert.match(waiting.retry!.lastError,/frame 1572/)
  assert.equal(f.service.find(second.id)?.status,'completed')
  const retainedImage=waiting.plan!.visuals.s1.imagePath
  t.mock.timers.tick(30000);await runner.idle()
  assert.equal(f.service.find(first.id)?.status,'completed')
  assert.equal(f.service.find(first.id)?.plan!.visuals.s1.imagePath,retainedImage)
  assert.equal(audioCalls.length,2,'one narration per task, retained on retry')
  assert.equal(imageCalls.length,2,'one image per task, retained on retry')
  assert.equal(f.service.list(1).length,1,'the timed-out task is not cloned')
})

test('one job prepares two independent images before either result arrives',async t=>{
  const f=fixture(t),job=f.create(1,3),entered=signal(),gate=signal(),calls:string[]=[]
  let active=0,peak=0
  const runner=createMotionRunner(f.service,{...f.overrides,generateImage:async input=>{
    calls.push(input.shotId);active++;peak=Math.max(peak,active)
    if(calls.length===2)entered.resolve()
    await gate.promise
    try {return await f.image(input)}finally {active--}
  }})
  runner.schedule(job.id)
  try {await reached(entered.promise,'second image waited for the first image result');assert.deepEqual(calls,['s1','s2'])}
  finally {gate.resolve();await runner.idle()}
  assert.equal(peak,2);assert.equal(f.service.find(job.id)?.status,'completed')
  assert.equal(f.renderCalls(),1)
})

test('image slots are shared by both jobs and preserve a single render lane',async t=>{
  const f=fixture(t),first=f.create(1,4),second=f.create(2,3),entered=signal(),gate=signal()
  let active=0,peak=0,renders=0,renderPeak=0
  const calls:string[]=[]
  const runner=createMotionRunner(f.service,{...f.overrides,generateImage:async input=>{
    calls.push(`${path.basename(input.directory)}:${input.shotId}`);active++;peak=Math.max(peak,active)
    if(calls.length===2)entered.resolve()
    await gate.promise
    try {return await f.image(input)}finally {active--}
  },render:async(...args)=>{
    renders++;renderPeak=Math.max(renderPeak,renders)
    await new Promise<void>(resolve=>setImmediate(resolve))
    try {return await f.overrides.render!(...args)}finally {renders--}
  }})
  runner.schedule(first.id);runner.schedule(second.id)
  try {await reached(entered.promise,'two jobs did not start image preparation');await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(calls.length,2)}
  finally {gate.resolve();await runner.idle()}
  assert.equal(peak,2);assert.equal(renderPeak,1);assert.equal(calls.length,7)
  assert.equal(f.service.find(first.id)?.status,'completed');assert.equal(f.service.find(second.id)?.status,'completed')
})

test('a failed image stops unstarted siblings, drains submitted work and resumes only missing shots',async t=>{
  const f=fixture(t),job=f.create(1,4),entered=signal(),fail=signal(),finish=signal(),failed=signal()
  const calls:string[]=[];let retry=false
  const runner=createMotionRunner(f.service,{...f.overrides,generateImage:async input=>{
    calls.push(input.shotId)
    if(!retry) {
      if(input.shotId==='s1'){await fail.promise;failed.resolve();throw Error('image output is invalid')}
      if(input.shotId==='s2'){entered.resolve();await finish.promise}
    }
    return f.image(input)
  }})
  runner.schedule(job.id)
  try {
    await reached(entered.promise,'second image was never submitted')
    fail.resolve();await failed.promise;await new Promise<void>(resolve=>setImmediate(resolve))
    assert.deepEqual(calls,['s1','s2'],'a known failure must stop unstarted image requests')
    assert.equal(f.service.find(job.id)?.status,'selecting','do not fail the job while a submitted sibling can still complete')
  } finally {fail.resolve();finish.resolve();await runner.idle()}
  const paused=f.service.find(job.id)!
  assert.equal(paused.status,'failed');assert.ok(paused.plan?.visuals.s2.imagePath);assert.equal(f.renderCalls(),0)
  retry=true;runner.schedule(job.id);await runner.idle()
  assert.equal(f.service.find(job.id)?.status,'completed')
  assert.deepEqual(calls,['s1','s2','s1','s3','s4'])
  assert.equal(f.renderCalls(),1)
})

test('usable reviewed footage wins over an uncertain candidate without altering evidence or manual selections',async t=>{
  const f=fixture(t);f.setRows([f.candidate('uncertain'),f.candidate('usable')])
  const job=f.create(1,1)
  const runner=createMotionRunner(f.service,{...f.overrides,reviewVideo:async input=>({
    status:input.filename.endsWith('usable.mp4')?'sampled':'unavailable',
    decision:input.filename.endsWith('usable.mp4')?'usable':'uncertain',reason:'actual evidence',method:'two-frame-model-review',limitations:'fixture',
  })})
  runner.schedule(job.id);await runner.idle()
  const selected=f.service.find(job.id)!.plan!.shots[0]
  assert.equal(selected.assetId,'usable');assert.equal(selected.sourceEvidence.visualEvidence.status,'sampled')
  const manual=f.create(2,1)
  manual.requested.shots[0].selection={assetId:'uncertain',inPoint:1,outPoint:3,crop:'left',confidence:.8,reason:'manual choice',shortfallPolicy:'reject'}
  f.service.write(manual);runner.schedule(manual.id);await runner.idle()
  const retained=f.service.find(manual.id)!.plan!.shots[0]
  assert.equal(retained.assetId,'uncertain');assert.equal(retained.inPoint,1);assert.equal(retained.crop,'left')
  assert.equal(retained.sourceEvidence.visualEvidence.status,'unavailable');assert.equal(retained.sourceEvidence.visualEvidence.decision,'uncertain')
})
