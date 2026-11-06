import test, {after, type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHistoryMotionProduction, hashText, type MotionCandidate} from './history-motion-production.js'
import {createMotionRunner, type MotionPipelineDependencies} from './history-motion-pipeline.js'

const databaseRoot=fs.mkdtempSync(path.join(os.tmpdir(),'motion-planning-global-'))
process.env.DB_PATH=path.join(databaseRoot,'database.sqlite')
process.env.STORAGE_PATH=path.join(databaseRoot,'static')
process.env.TASK_WORKER_DISABLED='1'
after(async()=>{const {db}=await import('../db/index.js');db.$client.close();fs.rmSync(databaseRoot,{recursive:true,force:true})})

function fixture(t:TestContext,lines=['司马懿在朝堂议事。','骑兵在城外列阵。']) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-planning-')),materials=path.join(root,'materials')
  fs.mkdirSync(materials)
  const service=createHistoryMotionProduction({databasePath:path.join(root,'jobs.sqlite'),root:path.join(root,'jobs'),materialRoot:materials,library:{search:()=>[]}})
  const runners:ReturnType<typeof createMotionRunner>[]=[]
  let audio=0,images=0,renders=0
  const script=lines.join(''),job=service.create(1,script,'全片统一的标题不得代替逐镜检索',hashText(script),'16:9')
  job.factory={episodeId:1,projectId:1,scriptHash:hashText(script),seedShots:lines.map((narration,index)=>({shotId:`s${index+1}`,narration,duration:2,storyboardId:index+1}))}
  service.write(job)
  const model:MotionPipelineDependencies['model']=async(_system,input:any)=>({shots:input.shots.map((shot:any)=>({shotId:shot.shotId,search:{query:`镜头 ${shot.shotId}`,shotSize:'any'},titles:[]}))})
  const defaults:Partial<MotionPipelineDependencies>={
    model,
    audio:async(_script,directory)=>{audio++;const audioPath=path.join(directory,'voice.m4a');fs.writeFileSync(audioPath,'voice');return {audioPath,duration:lines.length*2,titles:lines.map((text,index)=>({text,time_begin:index*2000,time_end:(index+1)*2000}))}},
    generateImage:async input=>{images++;const filename=path.join(input.directory,`${input.shotId}.png`);fs.writeFileSync(filename,input.shotId);return {path:filename,sha256:hashText(input.shotId)}},
    probeVideo:async()=>({duration:8,width:1920,height:1080}),
    reviewVideo:async()=>({status:'unavailable',decision:'uncertain',method:'two-frame-model-review',reason:'fixture',limitations:'fixture'}),
    render:async(_plan,directory)=>{renders++;const outputPath=path.join(directory,'movie.mp4');fs.writeFileSync(outputPath,'movie');return {outputPath,report:{sha256:hashText('movie'),qa:{technical:'passed'}}}},
    deliver:async()=>({status:'attached'}),
  }
  const runner=(overrides:Partial<MotionPipelineDependencies>={})=>{const result=createMotionRunner(service,{...defaults,...overrides});runners.push(result);return result}
  const candidate=(id:string):MotionCandidate=>{const filename=path.join(materials,`${id}.mp4`);fs.writeFileSync(filename,id);return {assetId:id,rank:1,description:'古代军队列阵',shotText:'军队列阵',query:'军队',duration:8,width:1920,height:1080,fps:30,localPath:filename,sha256:hashText(id),projectId:'p',clipId:'c',shotSize:'unknown'}}
  t.after(async()=>{await Promise.all(runners.map(value=>value.stop()));service.close();fs.rmSync(root,{recursive:true,force:true})})
  return {root,service,job,lines,model,runner,candidate,counts:()=>({audio,images,renders}),directory:path.join(service.root,job.id)}
}

for(const status of [429,503])test(`a planning HTTP ${status} waits in the original job before audio, images or rendering`,async t=>{
  const f=fixture(t),runner=f.runner({model:async()=>{throw Error(`Text model request failed: ${status} gateway unavailable`)}})
  runner.schedule(f.job.id);await runner.idle()
  const pending=f.service.find(f.job.id)!
  assert.equal(pending.status,'queued')
  assert.equal(pending.requested.shots.length,0)
  assert.equal(pending.script,f.job.script)
  assert.equal(pending.retry?.attempts,1)
  assert.deepEqual(f.counts(),{audio:0,images:0,renders:0})
  assert.equal(fs.existsSync(path.join(f.directory,'design-0.json')),false,'an unavailable provider cannot become a successful empty design cache')
})

test('planning resumes only a failed batch while retaining earlier successful designs',async t=>{
  const f=fixture(t,Array.from({length:31},(_,index)=>`第${index+1}队骑兵出城。`)),calls:string[][]=[]
  let available=false
  const runner=f.runner({model:async(system,input:any)=>{
    calls.push(input.shots.map((shot:any)=>shot.shotId))
    if(input.shots[0].shotId==='s31'&&!available)throw Error('Text model request failed: 503 Service temporarily unavailable')
    return f.model(system,input)
  }})
  runner.schedule(f.job.id);await runner.idle()
  assert.equal(f.service.find(f.job.id)?.status,'queued')
  const firstBatch=fs.readFileSync(path.join(f.directory,'design-0.json'),'utf8')
  assert.equal(JSON.parse(firstBatch).shots.length,30)
  assert.equal(fs.existsSync(path.join(f.directory,'design-30.json')),false)
  assert.deepEqual(f.counts(),{audio:0,images:0,renders:0})
  available=true;runner.schedule(f.job.id);await runner.idle()
  const completed=f.service.find(f.job.id)!
  assert.equal(completed.status,'completed',completed.error||'')
  assert.deepEqual(calls.map(batch=>batch[0]),['s1','s31','s31'])
  assert.equal(fs.readFileSync(path.join(f.directory,'design-0.json'),'utf8'),firstBatch)
  assert.equal(completed.plan!.shots.map((shot:any)=>shot.narration).join(''),f.job.script)
  assert.deepEqual(f.counts(),{audio:1,images:31,renders:1})
})

test('legacy empty planning caches are replaced with a real design instead of freezing the old fallback',async t=>{
  const f=fixture(t);fs.mkdirSync(f.directory,{recursive:true});fs.writeFileSync(path.join(f.directory,'design-0.json'),JSON.stringify({shots:[]}))
  let modelCalls=0
  const runner=f.runner({model:async(...args)=>{modelCalls++;return f.model(...args)}})
  runner.schedule(f.job.id);await runner.idle()
  assert.equal(f.service.find(f.job.id)?.status,'completed')
  assert.equal(modelCalls,1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'design-0.json'),'utf8')).shots.length,2)
  assert.deepEqual(f.service.find(f.job.id)!.requested.shots.map(shot=>shot.search.query),['镜头 s1','镜头 s2'])
})

test('a missing design derives bounded search words from each original narration instead of the shared title',async t=>{
  const f=fixture(t),runner=f.runner({model:async()=>({shots:[]})})
  runner.schedule(f.job.id);await runner.idle()
  const completed=f.service.find(f.job.id)!
  assert.equal(completed.status,'completed',completed.error||'')
  const queries=completed.requested.shots.map(shot=>shot.search.query)
  assert.equal(new Set(queries).size,2)
  assert.match(queries[0],/司马懿|朝堂|议事/)
  assert.match(queries[1],/骑兵|城外|列阵/)
  assert.ok(queries.every(query=>!query.includes('全片统一')))
  assert.equal(completed.plan!.shots.map((shot:any)=>shot.narration).join(''),f.job.script)
})

test('timeline search passes already-used media so the twenty-first shot can find a later unique candidate',async t=>{
  const f=fixture(t,Array.from({length:21},(_,index)=>`第${index+1}队骑兵出城。`)),candidates=Array.from({length:21},(_,index)=>f.candidate(`asset-${index+1}`))
  const calls:Array<Set<string>>=[]
  f.service.search=(_input,options={})=>{
    const used=new Set(options.usedAssets);calls.push(used)
    return candidates.filter(candidate=>!used.has(`video-id:${candidate.assetId}`)&&!used.has(`media:${candidate.sha256}`)).slice(0,20)
  }
  const runner=f.runner();runner.schedule(f.job.id);await runner.idle()
  const completed=f.service.find(f.job.id)!
  assert.equal(completed.status,'completed',completed.error||'')
  assert.equal(completed.plan!.shots.filter((shot:any)=>shot.visualType==='video').length,21)
  assert.equal(f.counts().images,0)
  assert.ok(calls[20].has('video-id:asset-20'))
  assert.equal(new Set(completed.plan!.shots.map((shot:any)=>shot.assetSha256)).size,21)
})

test('unknown shot-size fallback remains explicit in the saved candidate and editing record',async t=>{
  const f=fixture(t,['骑兵在城外列阵。']),candidate={...f.candidate('unknown-size'),searchFallback:'shot-size-unknown' as const}
  f.service.search=()=>[candidate]
  const runner=f.runner();runner.schedule(f.job.id);await runner.idle()
  const completed=f.service.find(f.job.id)!
  assert.equal(completed.status,'completed',completed.error||'')
  assert.equal(completed.candidates.s1[0].description,'古代军队列阵')
  assert.ok(completed.plan!.fallbacks.some((entry:any)=>entry.shotId==='s1'&&entry.stage==='search-fallback'&&/景别/.test(entry.reason)))
})
