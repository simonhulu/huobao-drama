import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createMotionVisualReviewer} from './history-motion-visual-evidence.js'
const observation={summary:'清代服饰的人在炮台前',eraEvidence:'可见清代服饰',burnedCaptions:{present:false,text:''},frameDifference:'人物位置略有变化',subjectMotion:'两帧位置变化'}
function fixture(t:TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-visual-')),filename=path.join(root,'clip.mp4');fs.writeFileSync(filename,'video');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const input={filename,duration:8,inPoint:0,outPoint:5,narration:'1934年项与年穿过哨卡。',purpose:'表现通过哨卡',title:'1934年情报',context:'1934年瑞金情报'};let extractCount=0;const calls:any[]=[];const extractFrames=async(_f:string,times:number[],directory:string)=>{extractCount++;return times.map((_,i)=>{const p=path.join(directory,`${i}.jpg`);fs.writeFileSync(p,`frame${i}`);return p})};const model=async(_s:string,input:any,images:string[])=>{calls.push({input,images});return images.length?{observation,suitability:{decision:'mismatch',reason:'清代服饰与1934年不符'}}:{decision:'mismatch',reason:'已观察到清代服饰'}};return {root,filename,input,extractFrames,model,calls,extractCount:()=>extractCount}}
test('samples two frames and reuses the asset observation cache',async t=>{const f=fixture(t),r=createMotionVisualReviewer({cacheRoot:f.root,extractFrames:f.extractFrames,model:f.model});const first=await r.review(f.input);assert.equal(first.decision,'mismatch');assert.equal(first.status,'sampled');assert.equal(first.sampledAtSeconds?.length,2);assert.equal(f.calls[0].images.length,2);assert.equal((await r.review(f.input)).cacheHit,true);assert.equal(f.calls.length,1);await r.review({...f.input,narration:'1934年士兵搜索'});assert.equal(f.extractCount(),1);assert.equal(f.calls[1].images.length,0);assert.deepEqual(f.calls[1].input.observation,observation)})
test('source bytes invalidate cache and concurrent requests share work',async t=>{const f=fixture(t),r=createMotionVisualReviewer({cacheRoot:f.root,extractFrames:f.extractFrames,model:f.model});const [a,b]=await Promise.all([r.review(f.input),r.review(f.input)]);assert.equal(a.assetSha256,b.assetSha256);assert.equal(f.calls.length,1);fs.writeFileSync(f.filename,'changed');const c=await r.review(f.input);assert.notEqual(a.assetSha256,c.assetSha256);assert.equal(f.calls.length,2)})
test('timeout and incomplete model output remain explicitly unverified',async t=>{const f=fixture(t),r=createMotionVisualReviewer({cacheRoot:f.root,extractFrames:f.extractFrames,timeoutMs:20,model:async(_s,_i,_f,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}))});const result=await r.review(f.input);assert.equal(result.status,'unavailable');assert.equal(result.decision,'uncertain');const bad=createMotionVisualReviewer({cacheRoot:path.join(f.root,'bad'),extractFrames:f.extractFrames,model:async()=>({suitability:{decision:'usable',reason:'ok'}})});assert.equal((await bad.review(f.input)).status,'unavailable')})
test('per-job total budget includes text fitting and stops further model calls',async t=>{
  const f=fixture(t);let clock=1000,calls=0
  const reviewer=createMotionVisualReviewer({cacheRoot:f.root,budgetMs:100,now:()=>clock,extractFrames:f.extractFrames,model:async(_s,_i,images)=>{calls++;clock+=60;return images.length?{observation,suitability:{decision:'uncertain',reason:'时代不明确'}}:{decision:'uncertain',reason:'观察有限'}}})
  const first=await reviewer.review({...f.input,reviewBudgetKey:'job-a'})
  assert.equal(first.budget?.spentMs,60)
  const second=await reviewer.review({...f.input,reviewBudgetKey:'job-a',narration:'另一个镜头'})
  assert.equal(second.budget?.spentMs,120)
  const third=await reviewer.review({...f.input,reviewBudgetKey:'job-a',narration:'第三个镜头'})
  assert.equal(third.status,'unavailable');assert.match(third.reason,/总预算.*耗尽/);assert.equal(calls,2)
  const cached=await reviewer.review({...f.input,reviewBudgetKey:'job-a'})
  assert.equal(cached.cacheHit,true);assert.equal(calls,2)
  const restarted=createMotionVisualReviewer({cacheRoot:f.root,budgetMs:100,now:()=>clock,extractFrames:f.extractFrames,model:async()=>{calls++;throw Error('must not run')}})
  assert.match((await restarted.review({...f.input,reviewBudgetKey:'job-a',narration:'重启后的新镜头'})).reason,/总预算.*耗尽/)
  assert.equal(calls,2)
  await reviewer.review({...f.input,reviewBudgetKey:'job-b',narration:'另一个任务的镜头'})
  assert.equal(calls,3,'separate job has its own budget and still reuses observations')
})
